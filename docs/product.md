# Product

The service drives two systems: Meet's PostgreSQL database for settings, and LinTO Studio's entitlements API for plans. Each call is timed in `mss_product_call_duration_seconds` under the `call` name given below.

## Meet database

The service touches one table, `meet_user` (`MEET_USER_TABLE`), as [Meet v1.19](https://github.com/linto-ai/meet/blob/c1c3bd0eed7ec422417cd667a910046a6a9b507f/src/backend/core/models.py#L147) creates it. It reads `email` and `updated_at`, and writes `language`, `timezone` and `updated_at`. Its role is granted nothing else, see [the database role](deploy.md#meet-database-role).

A settings event is one transaction, `meet.update_user_settings`:

```sql
SET LOCAL statement_timeout = 5000;
UPDATE meet_user SET language = $language, timezone = $timezone, updated_at = $timestamp
  WHERE lower(email) = lower($email) AND updated_at < $timestamp;
-- only when no row was updated, to tell stale from unknown:
SELECT email FROM meet_user WHERE lower(email) = lower($email) LIMIT 1;
```

- Only the fields the event carries are set.
- Meet bumps `updated_at` on every save of its own ([`auto_now`](https://github.com/linto-ai/meet/blob/c1c3bd0eed7ec422417cd667a910046a6a9b507f/src/backend/core/models.py#L131)), so a change made in Meet wins over an older event.
- A login does not bump it, as it saves only the changed OIDC claims ([`update_fields`](https://github.com/suitenumerique/django-lasuite/blob/72da3b9307ee3d15c07ea1b5fd897bdc485253a3/src/lasuite/oidc_login/backends.py#L340)).
- The timeout is set per transaction rather than at connect time, which PgBouncer refuses. Connections time out after 10 seconds, and the pool holds 2.

Users are matched by email, ignoring case: Meet keys them by their OIDC `sub`, which the event does not carry.

### Languages

Meet accepts `en-us`, `fr-fr`, `nl-nl`, `de-de`, `ru-ru` and `vi-vn` ([`LANGUAGES`](https://github.com/linto-ai/meet/blob/c1c3bd0eed7ec422417cd667a910046a6a9b507f/src/backend/meet/settings.py#L227)). An event's language is mapped to one of them:

- A Meet code is kept as is.
- `en`, `fr`, `nl`, `de`, `ru` and `vi` map to their Meet code, and so does a regional variant such as `fr-CA`.
- `LANGUAGE_MAP_OVERRIDES` adds or replaces entries. Its values are written as given, so each must be one of Meet's codes.
- Any other language is skipped, and the rest of the event still applies.

## LinTO Studio

Every call goes to `LINTO_STUDIO_API_URL` under `/api/v1/organizations/{LINTO_TWAKE_ORG_ID}/entitlements`, with `LINTO_ENTITLEMENTS_TOKEN` as a bearer token. Emails and domains are lowercased.

- `PUT /users/{email}` (`linto.put_user`), with `{ subject, features, updatedAt }`. `subject` is the user's `twakeId`.
- `DELETE /users/{email}` (`linto.delete_user`). A `404` counts as done.
- `PUT /domains/{domain}` (`linto.put_domain`), with `{ features, updatedAt }`.

`features` is the plan's `meet` block, passed through as is. A `PUT` answers `{ "ignored": true }` when LinTO holds state newer than `updatedAt`.

Each call is one attempt with a 10 second timeout: the retries are the consumer's, see [events](events.md#entitlement-events) for which answers are retried.
