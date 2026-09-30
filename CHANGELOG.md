# Changelog

## Unreleased

- Individual account deletions come from `auth` / `user.deleted` (queue `meet.user.deleted`), keyed by `internalEmail`, instead of `auth` / `user.deletion.requested`

## 0.2.0

- Renamed to meet-side-service: image `ghcr.io/linagora/meet-side-service`, metrics prefixed `mss_`
- LinTO Studio entitlement consumers, behind `ENTITLEMENTS_ENABLED` (needs `LINTO_STUDIO_API_URL`, `LINTO_ENTITLEMENTS_TOKEN`, `LINTO_TWAKE_ORG_ID`)
- Russian and Vietnamese language mapping

## 0.1.0 — initial

- RabbitMQ consumer for the `settings.user.settings.updated` contract
- PostgreSQL UPDATE of `meet_user.language` and `meet_user.timezone` by email match
- Health and readiness probes, Prometheus metrics
- Distroless container image
