# Changelog

## Unreleased

- Individual account deletions come from `auth` / `user.deleted` (queue `meet.user.deleted`), keyed by `internalEmail`, instead of `auth` / `user.deletion.requested`
- `@linagora/rabbitmq-client` 0.7.1
- A malformed message is dropped, a permanent error dead letters at once, and other failures are retried with a backoff doubling from `RABBITMQ_RETRY_DELAY` to `RABBITMQ_MAX_RETRY_DELAY` (60 s) over `RABBITMQ_MAX_RETRIES` (now 20) attempts
- A settings change applies only when Meet's `updated_at` is older than the message `timestamp`. The database role needs `SELECT (email, updated_at)`: run `GRANT SELECT (updated_at) ON meet_user TO <role>` before upgrading

## 0.2.0

- Renamed to meet-side-service: image `ghcr.io/linagora/meet-side-service`, metrics prefixed `mss_`
- LinTO Studio entitlement consumers, behind `ENTITLEMENTS_ENABLED` (needs `LINTO_STUDIO_API_URL`, `LINTO_ENTITLEMENTS_TOKEN`, `LINTO_TWAKE_ORG_ID`)
- Russian and Vietnamese language mapping

## 0.1.0 — initial

- RabbitMQ consumer for the `settings.user.settings.updated` contract
- PostgreSQL UPDATE of `meet_user.language` and `meet_user.timezone` by email match
- Health and readiness probes, Prometheus metrics
- Distroless container image
