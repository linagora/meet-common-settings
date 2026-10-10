# Operations

This document covers what an operator needs to know: how to provision the service's dependencies, what to watch, and what to do when something looks wrong. Deployment topology (containers, Kubernetes, Helm) is out of scope — that lives with the chart.

## Database role

The PostgreSQL role embedded in `DATABASE_URL` should be granted only what the consumer needs and nothing more:

```sql
CREATE ROLE meet_common_settings WITH LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE meet TO meet_common_settings;
GRANT USAGE ON SCHEMA public TO meet_common_settings;
GRANT SELECT (email, updated_at), UPDATE (language, timezone, updated_at) ON meet_user TO meet_common_settings;
```

`INSERT`, `DELETE`, and writes to any other table or column are not granted. If a future change to the service tries to write something else, Postgres will reject it rather than silently corrupting data.

## RabbitMQ permissions

The user in `RABBITMQ_URL` needs:

- `read` on the `settings` exchange, and on `billing`, `b2b` and `auth` when `ENTITLEMENTS_ENABLED=true`. The service checks they exist and binds its queue to them, but never declares them: a missing exchange fails the startup.
- `configure`, `write` and `read` on the `meet-side-service` queue, its `meet-side-service.dlq` twin and the `meet-side-service.dlx` exchange, which the service declares on startup.
- `configure` and `read` on the legacy queues (`meet.user_settings`, `meet.subscription.changed`, `meet.domain.subscription.changed`, `meet.domain.user.deleted`, `meet.user.deleted`, `meet.domain.organization.deleted`), and `write` on the `settings.dlx`, `billing.dlx`, `b2b.dlx` and `auth.dlx` exchanges they dead letter to, until the service has drained and deleted them. See [upgrading from one queue per event](#upgrading-from-one-queue-per-event).

## What to monitor

### Liveness and readiness

- `GET /healthz` — process is alive. Suitable for a basic restart probe.
- `GET /readyz` — the consumer is subscribed AND the broker connection is up AND PostgreSQL responds to `SELECT 1`. Returns 503 with a reason during reconnects, schema problems, or database outages.

If `/readyz` flips to 503 for more than a minute or two, the service is not consuming messages and the queue is filling up. The reason field in the response points at the broken dependency.

### Prometheus metrics

The service exposes these on `/metrics`:

- `mss_messages_processed_total{outcome}` — counter, one increment per processed message.
- `mss_message_latency_seconds{outcome}` — histogram of per-message wall time including the database call.
- `mss_db_errors_total` — counter, increments on any database exception (transient or permanent).
- `mss_entitlement_calls_total{event,outcome}`: counter, one increment per handler attempt. `outcome` is `applied`, `ignored` (LinTO already holds newer state), `invalid` (dropped), `rejected` (LinTO answered a `4xx` other than `408` or `429`, dead lettered at once) or `failed`. A failed call is retried up to `RABBITMQ_MAX_RETRIES` times, each attempt counted, then dead lettered, so one message can add that many.
- `mss_unrouted_total`: counter, messages with no handler for their exchange and routing key, dead lettered.
- Plus the default Node.js process metrics (heap, event loop lag, GC).

Suggested alerts:

| Alert                   | Condition                                                                               | What it tells you                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Service unreachable     | `up{job="meet-side-service"} == 0 for 5m`                                               | The process is down or Prometheus can't scrape.                                                 |
| Permanent errors rising | `rate(mss_messages_processed_total{outcome="rejected"}[5m]) > 0`                        | Likely a schema drift (a column was renamed or dropped). Investigate immediately.               |
| Queue is backing up     | A `rabbitmq_queue_messages{queue="meet-side-service"}` alert > N for X minutes          | Either the consumer is slow or `/readyz` is down. Check the readiness probe reason.             |
| DLQ growing             | `rate(rabbitmq_queue_messages_published_total{queue="meet-side-service.dlq"}[15m]) > 0` | Messages are exhausting their retries. Means a sustained DB outage or a poison-message pattern. |

### Logs

Every message produces exactly one structured log line in pino's JSON format. Fields you can index on:

- `requestId` — the upstream common-settings request_id, useful for cross-service tracing.
- `version` — the payload version field.
- `emailHash` — the first 16 hex chars of `sha256(lowercase(email))`. Lets you correlate without storing PII in your log aggregator.
- `outcome` — same labels as the metric.
- `latencyMs` — wall time end-to-end.

The library also emits its own logs through the same pino instance: connection events, retries, DLQ routings.

## Common failure modes

### "I changed my language in common-settings but Meet still shows the old one"

In order of likelihood:

1. **Browser cache.** Meet's frontend caches language. Reload.
2. **The user has not logged into Meet yet.** Without a `meet_user` row, the UPDATE matches zero rows. Log line: `"no Meet user matched; skipping"`. The user's settings will apply on first login.
3. **The language code in common-settings is one we don't map.** Look for `"language code has no Django mapping; skipping language update"`. Meet currently only supports `en-us`, `fr-fr`, `nl-nl`, `de-de`, `ru-ru`, `vi-vn`. To add another, override `LANGUAGE_MAP_OVERRIDES` (see [configuration](#configuration)) or add it to `src/modules/settings/language.ts`.
4. **The service is not consuming.** Check `/readyz` and the broker UI's consumer count for `meet-side-service`.

### Postgres is down

Each message in flight is retried up to `RABBITMQ_MAX_RETRIES` (default 20) times. The wait starts at `RABBITMQ_RETRY_DELAY` ms (default 1000) and doubles up to `RABBITMQ_MAX_RETRY_DELAY` ms (default 60000), so a message rides out about 14 minutes of outage. After that it goes to the DLQ. Queries time out after 5 seconds and connections after 10, and both count as transient.

Outages shorter than that cost a delay, not data. For longer outages, you have two options:

- **Let it DLQ.** Once Postgres is back up, replay the DLQ. The `@linagora/rabbitmq-client` docs cover how the DLQ is named and how to drain it.
- **Stop the consumer process** before retries exhaust. The queue will fill but no messages will be lost. Restart when Postgres is healthy.

### A column was renamed in Meet

You will see `mss_messages_processed_total{outcome="rejected"}` climb sharply, and every message logs `"permanent database error; dead lettering"` with Postgres error code `42703`. Each message goes to the DLQ without retries, so nothing is lost. Replay the DLQ once the fix is deployed: a replayed message older than a user's current settings is counted `stale` and changes nothing.

Fix path:

- Roll back to the previous image while you update `src/product/db.ts` to match the new column name (or update the SQL).
- Release a new image, redeploy.
- Replay the DLQ.

### Broker outage

`@linagora/rabbitmq-client` reconnects automatically and restores subscriptions. During the outage, `/readyz` returns 503 with reason `consumer_not_connected`. After reconnect, it returns to 200 within a few seconds. No special intervention needed.

If the outage is permanent (broker decommissioned, URL changed), update `RABBITMQ_URL` and restart the process.

## Configuration

All configuration is via environment variables. Defaults are listed in [`.env.example`](../.env.example).

| Variable                   | Required | Default     | What it does                                                                                                                                                               |
| -------------------------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RABBITMQ_URL`             | yes      | —           | AMQP DSN.                                                                                                                                                                  |
| `RABBITMQ_PREFETCH`        | no       | `1`         | QoS prefetch of the queue. With entitlements on, messages are still handled one at a time whatever it is.                                                                  |
| `RABBITMQ_MAX_RETRIES`     | no       | `20`        | Handler attempts before the message is sent to the DLQ.                                                                                                                    |
| `RABBITMQ_RETRY_DELAY`     | no       | `1000`      | First delay between handler attempts, in ms. It doubles on each attempt.                                                                                                   |
| `RABBITMQ_MAX_RETRY_DELAY` | no       | `60000`     | Cap on the delay between handler attempts, in ms.                                                                                                                          |
| `DATABASE_URL`             | yes      | —           | PostgreSQL DSN for the Meet database.                                                                                                                                      |
| `MEET_USER_TABLE`          | no       | `meet_user` | User table override, in case Django renames it.                                                                                                                            |
| `LANGUAGE_MAP_OVERRIDES`   | no       | `{}`        | JSON map of additional ISO-639-1 → Django language codes. Example: `{"es":"fr-fr"}`.                                                                                       |
| `LOG_LEVEL`                | no       | `info`      | pino level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`.                                                                                                            |
| `HEALTH_PORT`              | no       | `8080`      | Port for `/healthz`, `/readyz`, `/metrics`.                                                                                                                                |
| `SHUTDOWN_TIMEOUT_MS`      | no       | `10000`     | Grace period on SIGTERM. The broker client uses the same value as its `closeTimeout`, so this is how long we'll wait for in-flight handlers to finish before forcing exit. |

The entitlement consumers are off unless `ENTITLEMENTS_ENABLED=true` (only `true` and `false` are accepted). When on, three more are required, and the service refuses to start without them:

- `LINTO_STUDIO_API_URL`: base URL of LinTO studio-api.
- `LINTO_ENTITLEMENTS_TOKEN`: bearer key, admin of the root organization and carrying ORGANIZATION_INITIATOR, which the domains route requires.
- `LINTO_TWAKE_ORG_ID`: Twake's root organization in LinTO Studio.

## Turning entitlements on or off

- While off, the entitlement events are not bound to the queue, so plan changes and deletions in that window never reach LinTO. Turning it on does not catch up: nothing re-emits current plans, so existing subscribers only get an entitlement on their next plan change.
- Turning it off again leaves the five entitlement bindings in place, since the service never removes a binding. Events that arrive through them are dead lettered to `meet-side-service.dlq`, to replay once it is back on. To retire the feature, remove the five bindings from the `meet-side-service` queue.

## Restarts and single-consumer invariant

Settings messages are guarded by their event time and can be handled in any order. Entitlements still rely on at most one consumer, since a LinTO `DELETE` carries no `updatedAt`: do not scale to multiple replicas while entitlements are on, and stop the old process before starting a new one during upgrades. Brief downtime is harmless, as messages accumulate in the queue and drain when the new process is up.

## Upgrading from one queue per event

Releases before this one consumed from one queue per event. On its first start, this one creates `meet-side-service` with its bindings, then for each legacy queue it finds:

- unbinds it, so new events only reach `meet-side-service`,
- hands what it holds to the same handlers,
- deletes it once empty.

A message that fails there is put back and the queue kept, and the drain runs again every `RABBITMQ_MAX_RETRY_DELAY` ms. A queue another process still consumes, an old release during a rolling update for instance, is kept the same way. A message that is not JSON goes to the queue's `.dlq`. Nothing is lost while old and new run side by side, and an event that sits in both queues for a moment is applied twice, which is harmless. The drain runs alongside the new queue, so for the few seconds it takes, an entitlement event from before the upgrade can be applied after a newer one for the same user. The legacy `.dlq` queues are left alone: replay or delete them by hand.
