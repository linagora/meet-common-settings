# Architecture

## What this service is for

Twake Workplace has a central **common-settings** service where users edit their language, timezone, display name, avatar, and other profile fields. When a user saves a change there, common-settings publishes a RabbitMQ message so every other application in the suite can react.

Meet (the LiveKit-based video conferencing app) is one of those applications. It stores its own copy of a user's language and timezone in PostgreSQL. Until now, those values only got refreshed when the user logged into Meet again, because Meet pulls them from OIDC userinfo claims at sign-in time. That meant a user could change their language in common-settings and still see the old language in Meet until the next login.

`meet-side-service` closes that gap. It is a small sidecar that listens to the common-settings exchange and writes the changed fields into Meet's database in near real time. Meet itself is untouched.

## How it fits together

```
┌────────────────────┐    AMQP (topic)    ┌────────────────────────┐    SQL    ┌────────────┐
│  common-settings   │ ─────────────────► │  meet-side-service     │ ────────► │  Meet PG   │
│   (publisher)      │  settings          │   (this service)       │  UPDATE   │  meet_user │
│                    │  user.settings     │   1 replica            │  by email │            │
│                    │  .updated          │                        │           │            │
└────────────────────┘                    └────────────────────────┘           └────────────┘
```

The service has exactly two outbound connections: RabbitMQ and PostgreSQL. It exposes an HTTP port on `/healthz`, `/readyz`, and `/metrics` for probes and metrics scrapers.

## Why direct database UPDATEs

We considered three approaches:

1. **Direct PostgreSQL UPDATE.** This is what we ship.
2. **A new service-to-service admin API on Meet** that the sidecar calls over HTTP.
3. **Embedding the consumer inside Meet's Django backend** as a management command or Celery worker.

Option 2 would have meant changing both repos: adding an authenticated admin endpoint to Meet (today the user-update endpoint is gated by `IsSelf`, so it can only be called by the user themselves), then having the sidecar call it. That's a much bigger surface area for a write that only ever touches two columns.

Option 3 would have coupled Meet's deployment to RabbitMQ, when today its Celery broker is Redis. Adding a new messaging dependency to the main backend felt heavier than necessary.

Option 1 keeps Meet completely untouched. The cost is that the sidecar has to know the table name and column names of Meet's user table. We mitigate that by:

- Granting the sidecar's PostgreSQL role only `SELECT (email, updated_at), UPDATE (language, timezone, updated_at)` on `meet_user`. The blast radius of a schema mistake is bounded.
- Making the table name configurable via `MEET_USER_TABLE` so a Django rename can be absorbed without a code change.
- Validating the identifier against an allowlist regex before interpolating it into SQL.

## How users are matched

Common-settings identifies users by `nickname` (a username string). Meet identifies users by `sub` (their OIDC subject claim). There is no direct mapping between the two: `nickname` is not Meet's `sub`.

The one identifier shared by both systems is **email**. Meet's prod deployment already has `OIDC_FALLBACK_TO_EMAIL_FOR_IDENTIFICATION=True`, meaning Meet itself uses email as a fallback when sub doesn't resolve. We follow the same convention and match the email case-insensitively.

If a settings message arrives for a user who has never logged into Meet (and therefore has no row in `meet_user`), the UPDATE returns zero rows. We log an info-level event and ack the message. The user's settings will be applied automatically on their first OIDC sign-in, because Meet pulls language and timezone from OIDC userinfo claims at that point.

## Which fields we sync

| Common-settings payload                  | Meet column          | Notes                                                                                                                                             |
| ---------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `language` (ISO 639-1, e.g. `"en"`)      | `meet_user.language` | Mapped to Django's `LANGUAGES` codes (`en-us`, `fr-fr`, `nl-nl`, `de-de`, `ru-ru`, `vi-vn`). Unsupported codes are dropped, not raised.           |
| `timezone` (IANA, e.g. `"Europe/Paris"`) | `meet_user.timezone` | Passed through unchanged.                                                                                                                         |
| `avatar`                                 | —                    | Ignored. Meet has no avatar field; adding one is a separate, larger project.                                                                      |
| `display_name`                           | —                    | Ignored. Meet's `full_name` and `short_name` are populated from OIDC userinfo on every login; writing them here would race with the OIDC backend. |
| Everything else                          | —                    | Ignored.                                                                                                                                          |

## Idempotency and ordering

We do not track per-user state. Meet's own `updated_at` is the guard: the handler runs

```sql
UPDATE meet_user SET language = $1, timezone = $2, updated_at = $event_time
WHERE lower(email) = lower($3) AND updated_at < $event_time
```

The event time is the envelope's `timestamp`, which common-settings sets when it publishes. A redelivered or older event matches no row and is counted `stale`, and so is an event older than a change made in Meet itself, since Meet bumps `updated_at` on every save. A login does not bump it: Meet saves only the changed OIDC claims on login, without `updated_at`. A message without `timestamp` is malformed and dropped.

Events can therefore be handled in any order and by several consumers at once.

## Failure modes and what they mean

The handler classifies every outcome into one of eight labels, all reported as `mss_messages_processed_total{outcome=...}`:

| Outcome              | What it means                                                               | Ack?                                             |
| -------------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| `updated`            | Found the user, applied the change.                                         | Yes                                              |
| `stale`              | The user's row changed after the event, which changes nothing.              | Yes                                              |
| `unknown_user`       | No row matched the email. User probably hasn't logged into Meet yet.        | Yes                                              |
| `no_email`           | Message had no email field. Can't match anyone.                             | Yes                                              |
| `no_syncable_fields` | Message had no language or timezone (or only an unsupported language code). | Yes                                              |
| `invalid_payload`    | JSON parsed but failed schema validation (`MalformedEventError`).           | Yes, dropped                                     |
| `db_error`           | Postgres was unreachable, timed out, or answered a transient error.         | Throw → library retries with backoff, then DLQs  |
| `rejected`           | Postgres answered a permanent error, a missing column for instance.         | No, dead lettered at once (`RejectedEventError`) |

The "throw → retry → DLQ" path is provided by `@linagora/rabbitmq-client`: it catches the thrown error and retries up to `RABBITMQ_MAX_RETRIES` attempts, waiting `RABBITMQ_RETRY_DELAY` ms and doubling the wait up to `RABBITMQ_MAX_RETRY_DELAY` ms, then nacks to the dead-letter queue. A `RejectedEventError` skips the retries. The library also has reconnection logic for total broker outages.

## One queue

Every event reaches the service through one quorum queue, `meet-side-service`, bound to each routing key it handles. The handler is picked by the exchange and routing key the event was published with. A dead letter moved back into the queue arrives on the default exchange and keeps that origin in its `x-death` header, which the router reads. An event with no handler is logged, counted in `mss_unrouted_total` and dead lettered.

The queue dead letters to its own exchange, `meet-side-service.dlx`, into `meet-side-service.dlq`, and caps broker redeliveries at 10. The exchanges it binds to belong to their publishers and are only checked, never declared.

Events are handled one at a time while entitlements are on, so an outage of Postgres or LinTO holds back the events for the other one too, for as long as the retries last.

Earlier releases used one queue per event (`meet.user_settings` and `meet.<routingKey>`). On startup the service unbinds each one it finds, hands what it holds to the same handlers, and deletes it once empty. See [operations](operations.md#upgrading-from-one-queue-per-event).

## Entitlements

The same process keeps LinTO Studio's entitlements in step with Twake plans, so Meet can gate transcription and recording. Each event maps to exactly one Studio call. [ADR 061](https://github.com/linagora/twake-workplace-private/pull/1745) has the reasoning. It is off by default and switched on with `ENTITLEMENTS_ENABLED`; see [operations](operations.md#turning-entitlements-on-or-off).

- `billing` / `subscription.changed`: `PUT /users/{internalEmail}` with the plan's `meet` block.
- `billing` / `domain.subscription.changed`: `PUT /domains/{domain}` with the plan's `meet` block.
- `b2b` / `domain.user.deleted`: `DELETE /users/{internalEmail}`.
- `auth` / `user.deleted`: `DELETE /users/{internalEmail}`.
- `b2b` / `domain.organization.deleted`: `PUT /domains/{domain}` with no rights.

`updatedAt` is the publish timestamp. A message published without one falls back to its first death time when replayed from its DLQ, and to the receipt time otherwise. A message that fails its schema is logged and dropped. A `4xx` from Studio other than `408` or `429` dead letters the message at once, and any other failure is retried, then dead lettered. A `404` on a `DELETE` counts as done, the user being already gone.

## Why a sidecar instead of merging into common-settings

Each downstream app has its own data model and its own way of representing users. If common-settings carried the fan-out responsibility, it would need to know how to talk to every other app's database, OIDC mapping, validation rules, and schema. Keeping the consumer adjacent to the app it writes to keeps that knowledge in one place. The pattern is repeatable: future apps can copy this service's shape and adapt the handler.
