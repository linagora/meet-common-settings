# Events

The service consumes the events below from its `meet-side-service` queue and publishes none. [Product](product.md) describes the writes they lead to, and [architecture](architecture.md#outcomes-and-retries) the outcomes.

## settings / user.settings.updated

Published by common-settings when a user saves their settings. Always bound.

Fields read:

- `timestamp`: publish time in milliseconds. Required. It becomes the row's `updated_at`, which makes a redelivery or an older event stale. One more than an hour in the future is refused, since it would make every later event stale.
- `payload.email`: required. It finds the Meet user, ignoring case.
- `payload.language`: an ISO 639-1 code such as `fr`, mapped to Meet's language code, see [languages](product.md#languages).
- `payload.timezone`: an IANA zone such as `Europe/Paris`, written as is.
- `request_id` and `version` are only logged.

Every other field is ignored. Meet has no avatar, and it sets `full_name` and `short_name` from the OIDC claims at each login ([`update_user_if_needed`](https://github.com/suitenumerique/django-lasuite/blob/72da3b9307ee3d15c07ea1b5fd897bdc485253a3/src/lasuite/oidc_login/backends.py#L310)), so writing a display name would be overwritten.

Outcomes:

- `handled`: the row is updated. Also when no Meet user has this email, or when nothing is left to write (a language Meet does not have and no timezone).
- `stale`: the row changed after `timestamp`.
- `dropped`: the event fails its schema, has no email, or has no or a future `timestamp`.
- `dead_lettered`: Postgres refuses the write for good, with an SQLSTATE of class 22 (bad data), 23 (constraint) or 42 (missing column or grant).
- Any other database error is retried.

A user who has never signed in to Meet has no row, so the change is not kept. Meet then creates the row with its default language and timezone, as it takes only `sub`, `email`, `full_name` and `short_name` from the OIDC claims ([`get_extra_claims`](https://github.com/linto-ai/meet/blob/c1c3bd0eed7ec422417cd667a910046a6a9b507f/src/backend/core/authentication/backends.py#L33)). The user's next change in common-settings applies.

## Entitlement events

Bound only while `ENTITLEMENTS_ENABLED=true`. Each one leads to one LinTO Studio call, see [product](product.md#linto-studio).

- `billing` / `subscription.changed`: reads `twakeId`, `internalEmail` and `features.meet`. Sets the user's entitlements to `features.meet`, or to none when it is absent.
- `billing` / `domain.subscription.changed`: reads `domain` and `features.meet`. Sets the domain's entitlements the same way.
- `b2b` / `domain.user.deleted`: reads `internalEmail`. Deletes the user's entitlements.
- `auth` / `user.deleted`: reads `internalEmail`. Deletes the user's entitlements.
- `b2b` / `domain.organization.deleted`: reads `domain`. Sets the domain's entitlements to none.

Every other field is ignored. Each call carries an `updatedAt`, which LinTO compares with what it holds to ignore older state. It is the AMQP `timestamp` property set by the publisher. A dead letter replayed without one falls back to its first death time in `x-death`, so a replay never passes for a new event. Otherwise it is the time of receipt.

Outcomes:

- `handled`: LinTO applied it, or answered `404` to a delete, the user being already gone.
- `stale`: LinTO answered `ignored: true`, as it holds newer state.
- `dropped`: the event fails its schema.
- `dead_lettered`: LinTO answered a `4xx` other than `408` or `429`.
- Any other failure, a `5xx`, a `408`, a `429`, a timeout or a network error, is retried.

While entitlements are off, an entitlement event still arriving through a binding left from an earlier run is dead lettered, to replay once they are on again.
