# Changelog

## Unreleased

- Individual account deletions come from `auth` / `user.deleted` (queue `meet.user.deleted`), keyed by `internalEmail`, instead of `auth` / `user.deletion.requested`
- `@linagora/rabbitmq-client` 0.7.1
- A malformed message is dropped, a permanent error dead letters at once, and other failures are retried with a backoff doubling from `RABBITMQ_RETRY_DELAY` to `RABBITMQ_MAX_RETRY_DELAY` (60 s) over `RABBITMQ_MAX_RETRIES` (now 20) attempts
- A settings change applies only when Meet's `updated_at` is older than the message `timestamp`. The database role needs `SELECT (email, updated_at)`: run `GRANT SELECT (updated_at) ON meet_user TO <role>` before upgrading
- Every event comes through one `meet-side-service` queue, dead lettering to `meet-side-service.dlq`. The legacy `meet.*` queues are drained into it and deleted on startup, their `.dlq` twins left in place. `RABBITMQ_EXCHANGE`, `RABBITMQ_ROUTING_KEY` and `RABBITMQ_QUEUE` are gone, and the publishers' exchanges must exist before the service starts
- Node 24, and the image runs on `node:24-slim` as the `node` user (uid 1000) instead of distroless `nonroot` (uid 65532)
- Probes at `/health/live` and `/health/ready`, and metrics on their own `METRICS_PORT` (9464). Ready no longer depends on the Meet database. Live fails when a handler hangs for 2 minutes, the broker stays unreachable for 10, or a reconnect loses the subscription. The service now waits for the broker at startup instead of exiting after 5 attempts. `/healthz`, `/readyz` and `/metrics` on `HEALTH_PORT` still answer until the chart moves
- Metrics: `mss_events_total{exchange,routing_key,outcome}` and `mss_product_call_duration_seconds{call,result}` replace `mss_messages_processed_total`, `mss_message_latency_seconds`, `mss_db_errors_total`, `mss_entitlement_calls_total` and `mss_unrouted_total`. Dashboards and alerts on the old names need updating. A settings change without email now counts as `dropped`

## 0.2.0

- Renamed to meet-side-service: image `ghcr.io/linagora/meet-side-service`, metrics prefixed `mss_`
- LinTO Studio entitlement consumers, behind `ENTITLEMENTS_ENABLED` (needs `LINTO_STUDIO_API_URL`, `LINTO_ENTITLEMENTS_TOKEN`, `LINTO_TWAKE_ORG_ID`)
- Russian and Vietnamese language mapping

## 0.1.0 — initial

- RabbitMQ consumer for the `settings.user.settings.updated` contract
- PostgreSQL UPDATE of `meet_user.language` and `meet_user.timezone` by email match
- Health and readiness probes, Prometheus metrics
- Distroless container image
