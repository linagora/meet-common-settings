# Deploy

The image is `ghcr.io/linagora/meet-side-service:v<version>`, built on `node:24-slim` and run as the `node` user (uid 1000). It starts with `node --import ./dist/instrument.js dist/main.js`. A command override must keep the `--import`, or Sentry gets nothing.

## Settings

All settings are environment variables. [`.env.example`](../.env.example) has a working set.

RabbitMQ:

- `RABBITMQ_URL`: required, secret. AMQP URL of the broker.
- `RABBITMQ_PREFETCH` (`1`): prefetch of the queue. While entitlements are on, events are still handled one at a time.
- `RABBITMQ_MAX_RETRIES` (`20`): attempts before an event is dead lettered.
- `RABBITMQ_RETRY_DELAY` (`1000`): wait before the second attempt, in ms. It doubles on each attempt.
- `RABBITMQ_MAX_RETRY_DELAY` (`60000`): cap on that wait, in ms. Also how often the [legacy queues](#upgrading-from-020) are drained again.

Meet database:

- `DATABASE_URL`: required, secret. PostgreSQL URL of Meet's database, with the [role below](#meet-database-role).
- `MEET_USER_TABLE` (`meet_user`): Meet's user table.
- `LANGUAGE_MAP_OVERRIDES` (`{}`): JSON object of extra language mappings, for instance `{"es":"fr-fr"}`. See [languages](product.md#languages).

LinTO Studio:

- `ENTITLEMENTS_ENABLED` (`false`): `true` binds and handles the [entitlement events](events.md#entitlement-events). Only `true` and `false` are accepted.
- `LINTO_STUDIO_API_URL`: base URL of LinTO's studio-api. Required when entitlements are on.
- `LINTO_ENTITLEMENTS_TOKEN`: secret, required when entitlements are on. A key that is admin of the root organization and carries `ORGANIZATION_INITIATOR`, which the domains route requires.
- `LINTO_TWAKE_ORG_ID`: Twake's root organization in LinTO Studio. Required when entitlements are on.

Operations:

- `HEALTH_PORT` (`8080`): port of the probes.
- `METRICS_PORT` (`9464`): port of `/metrics`.
- `LOG_LEVEL` (`info`): `trace`, `debug`, `info`, `warn`, `error` or `fatal`.
- `SENTRY_DSN` (unset): secret. Sentry project DSN. Unset, nothing is sent.
- `SENTRY_ENVIRONMENT` (unset): Sentry environment, for instance `dev` or `prod`.
- `SHUTDOWN_TIMEOUT_MS` (`10000`): on `SIGTERM`, how long running handlers get before the process exits anyway.

An empty `LINTO_*` or `SENTRY_*` value counts as unset. The service refuses to start on a missing or invalid setting, naming it.

## Meet database role

The role in `DATABASE_URL` needs exactly this, and gets nothing more:

```sql
GRANT CONNECT ON DATABASE <database> TO <role>;
GRANT USAGE ON SCHEMA public TO <role>;
GRANT SELECT (email, updated_at), UPDATE (language, timezone, updated_at) ON meet_user TO <role>;
```

## RabbitMQ permissions

The user in `RABBITMQ_URL` needs:

- `read` on the `settings` exchange, and on `billing`, `b2b` and `auth` while entitlements are on. They must exist before the service starts, which fails without them.
- `configure`, `write` and `read` on the `meet-side-service` queue, the `meet-side-service.dlq` queue and the `meet-side-service.dlx` exchange, which the service declares.
- Until the [legacy queues](#upgrading-from-020) are gone: `configure` and `read` on them, and `write` on the `settings.dlx`, `billing.dlx`, `b2b.dlx` and `auth.dlx` exchanges they dead letter to.

As regular expressions, legacy queues included:

```
configure  ^(meet-side-service(\.dlq|\.dlx)?|meet\.(user_settings|subscription\.changed|domain\.subscription\.changed|domain\.user\.deleted|user\.deleted|domain\.organization\.deleted))$
write      ^(meet-side-service(\.dlq|\.dlx)?|meet\..*|(settings|billing|b2b|auth)\.dlx)$
read       ^(meet-side-service(\.dlq|\.dlx)?|meet\..*|settings|billing|b2b|auth)$
```

## Probes

Both answer 200, or 503 when failing, on `HEALTH_PORT`.

- `/health/ready`: the consumer is subscribed and the broker connection is up. It does not check the Meet database, whose outages are covered by the retries.
- `/health/live`: fails when a handler has run for more than 2 minutes, when the broker has been unreachable for more than 10, or when a reconnect lost the subscription. A restart then recovers the process.

`/healthz`, `/readyz` and `/metrics` also answer on `HEALTH_PORT`, for charts that still use them.

## Metrics

On `/metrics` on `METRICS_PORT`:

- `mss_events_total{exchange,routing_key,outcome}`: one per event outcome, see [outcomes](architecture.md#outcomes-and-retries). An event redelivered after a lost ack counts again. A replayed dead letter that runs out of retries again is labelled with the default exchange (`""`) and the queue name. Invalid JSON drained from a legacy queue is not counted.
- `mss_product_call_duration_seconds{call,result}`: duration of each call to Meet or LinTO, see [product](product.md) for the `call` names. `result` is `ok` or `error`, and a retried event adds one call per attempt.
- The default Node.js process metrics.

Suggested alerts:

- Service down: `up{job="meet-side-service"} == 0` for 5 minutes.
- Dead letters rising: `rate(mss_events_total{outcome="dead_lettered"}[5m]) > 0`. A schema change in Meet, a LinTO refusal, an outage longer than the retries, or entitlements off. The logs say which.
- Queue backing up: `rabbitmq_queue_messages{queue="meet-side-service"}` above your usual depth for several minutes. The consumer is slow, or `/health/ready` is failing.

## Logs and errors

Logs are JSON lines on stdout. Each event logs one line from its handler, with:

- `requestId` and `version` for settings events, from the event.
- `emailHash` or `subjectHash`: the first 16 hex characters of the SHA-256 of the lowercased email or domain, to follow a user without logging the address.
- `latencyMs` for settings events.

`@linagora/rabbitmq-client` logs its connections, retries and dead letters through the same logger.

With `SENTRY_DSN` set, every `error` and `fatal` line becomes a Sentry event, tagged `service:meet-side-service`, with the release `meet-side-service@<version>`. This includes the client's "Handler failed" line, so an outage of Postgres or LinTO sends one event per failed attempt, grouped into one issue.

## Replicas

Run one replica while entitlements are on, and stop the old process before starting the new one on an upgrade. A LinTO `DELETE` carries no `updatedAt`, so two consumers could apply a delete and a plan change for the same user in the wrong order. Settings alone can run on several replicas. A short downtime loses nothing: events wait in the queue.

## Turning entitlements on or off

- While they are off, the entitlement events are not bound, so plan changes and deletions in that window never reach LinTO. Turning them on does not catch up: an existing subscriber only gets entitlements on their next plan change.
- Turning them off leaves the five bindings in place, as the service never removes one. Events arriving through them are dead lettered, to replay once entitlements are back on. To retire the feature, remove the five bindings from the `meet-side-service` queue.

## Upgrading from 0.2.0

Before the upgrade:

- Grant `SELECT (updated_at)` on `meet_user` to the role, see [the database role](#meet-database-role).
- Give the RabbitMQ user the [permissions](#rabbitmq-permissions) on the new queue and exchanges.
- Make sure the publishers' exchanges exist.

On its first start, the service creates `meet-side-service` with its bindings, then for each legacy queue it finds:

- unbinds it, so new events only reach `meet-side-service`;
- hands what it holds to the same handlers;
- deletes it once empty.

A message that fails there is put back and the queue kept, to drain again every `RABBITMQ_MAX_RETRY_DELAY`. So is a queue another process still consumes, such as the old release during a rolling update. A message that is not JSON goes to that queue's `.dlq`. The legacy `.dlq` queues are left alone: replay or delete them by hand.

An event in both queues for a moment is applied twice, which is harmless. For the few seconds the drain takes, an entitlement event from before the upgrade can be applied after a newer one for the same user.

## When something goes wrong

### A language change does not show in Meet

In order of likelihood:

1. Meet's frontend caches the language. Reload.
2. The user has never signed in to Meet. The log says `no Meet user matched; skipping`, and the change is not kept, see [events](events.md#settings--usersettingsupdated).
3. Meet has no such language. The log says `language code has no Meet backend mapping; skipping language update`. See [languages](product.md#languages).
4. The service is not consuming. Check `/health/ready` and the consumer count of `meet-side-service` in RabbitMQ.

### Postgres is down

Events are retried for about 14 minutes with the defaults, then dead lettered. A shorter outage costs a delay, nothing more. For a longer one, either replay `meet-side-service.dlq` once Postgres is back, or stop the service before the retries run out and let the queue fill.

### Meet renamed a column

Every settings event logs `permanent database error; dead lettering` with SQLSTATE `42703`, and `dead_lettered` climbs. Nothing is lost:

1. Roll back to the previous image, or keep it running, while `src/product/meet-user.ts` follows the new schema.
2. Release and deploy the fix.
3. Replay `meet-side-service.dlq`. A replayed event older than the user's current settings counts as `stale` and changes nothing.

### The broker is down

The client reconnects every 5 seconds, at startup too, and restores the subscription. `/health/ready` fails meanwhile, and `/health/live` after 10 minutes, which restarts the pod. If the broker moved, update `RABBITMQ_URL` and restart.

## Running locally

[`docker-compose.yml`](../docker-compose.yml) starts:

- Postgres on port 5433, with `meet_user` as Meet v1.19 creates it, three users (`Alice@example.com`, `bob@example.com`, `carol@example.com`) and a `meet_side_service` role with the production grants;
- RabbitMQ on port 5673 (management UI on 15673), with the `settings`, `billing`, `b2b` and `auth` exchanges and a `dev` user.

It does not run Meet itself: the service only needs its table.

```sh
docker compose up -d --wait
cp .env.example .env  # already points at this stack
npm run dev           # reads .env
```

Publish an event from the management UI (exchange `settings`, routing key `user.settings.updated`), for instance:

```json
{
  "timestamp": 1760000000000,
  "payload": { "email": "alice@example.com", "language": "fr", "timezone": "Europe/Berlin" }
}
```

Use the current time in milliseconds as `timestamp`. Alice's row then shows `fr-fr` and `Europe/Berlin`, and `curl -s localhost:9464/metrics | grep mss_events_total` counts it `handled`. Send it again for `stale`, or without `email` for `dropped`.

`docker compose down -v` removes everything, and the next `up` seeds the database again.
