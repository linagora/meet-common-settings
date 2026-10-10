# Development

## Prerequisites

- Node.js 24 or newer.
- Docker (only for the integration tests, which spin up real Postgres and RabbitMQ containers).

## Setup

```sh
npm install
cp .env.example .env  # then edit DATABASE_URL and RABBITMQ_URL
npm run dev           # tsx watch
```

For a development RabbitMQ + Postgres, the easiest option is the docker-compose file from the [common-settings](https://github.com/linagora/twake-workplace-common-settings) repo. It already exposes the broker on `amqp://guest:guest@localhost:5672` and provisions the `settings` exchange. Point your local `DATABASE_URL` at a throwaway Postgres with a fixture `meet_user` table — the integration tests show the minimal schema.

## Project layout

```
src/
  main.ts         Process entrypoint: load config, wire deps, run consumer + ops servers, handle SIGTERM
  config.ts       Env-var parsing with Zod
  infra/
    consumer.ts   RabbitMQ subscription, legacy queue drain, readiness and liveness
    liveness.ts   Stuck handler and lost connection detection
    http.ts       Fastify servers for the probes and for /metrics
    metrics.ts    prom-client registry and counters
    logger.ts     pino instance plus email hashing helper
  product/
    port.ts       The interfaces the handlers depend on
    fake.ts       In-memory Meet database and LinTO for unit tests
    api.ts        LinTO Studio entitlements API client
    db.ts         Drizzle ORM (postgres-js) settings write, guarded by updated_at
    meet-user.ts  Drizzle table definition, the subset of Meet's meet_user we touch
  events/
    errors.ts     Malformed and rejected event errors
    router.ts     Picks the handler by the exchange and routing key published to
    topology.ts   The queue, its dead letter exchange, its bindings and routes
    legacy.ts     Drains the per-event queues of earlier releases
  modules/
    settings/
      handlers.ts Per-message settings logic
      schema.ts   Zod schema for the settings message envelope and payload
      language.ts ISO 639-1 → Django LANGUAGES mapping
    entitlements/
      handlers.ts Entitlement bindings and handler
      schema.ts   Zod schemas for the entitlement events
```

Tests sit next to the code they cover. `*.integration.spec.ts` files spin up Postgres with testcontainers to check the SQL; every other `*.spec.ts` file is a fast unit test with no docker, and the handler tests run against the fakes in `product/fake.ts`.

Every file has one job and the call graph is shallow. If you find yourself adding a sixth or seventh kind of dependency, the abstraction is probably wrong.

## Testing

```sh
npm run test:unit         # fast, no docker
npm run test:integration  # requires docker (testcontainers)
npm test                  # both
```

The unit tests cover every branch of the handlers, including the error classification. Integration tests verify the actual SQL runs against a real Postgres image.

When changing behavior:

- Add a unit test for the new branch.
- If the change touches the SQL, add an integration test that exercises it.
- Run `npm run check` locally before pushing.

## Checks

```sh
npm run check       # lint, format:check, typecheck, test, build
npm run format      # prettier --write
```

CI runs `npm audit`, then `npm run check`, and builds the image and probes it. A push to `main` publishes the image only when both pass.

## Building the image

```sh
docker build -t meet-side-service:dev .
```

The Dockerfile is a two-stage build on `node:24-slim`. The runtime stage holds only the production dependencies and the build, and runs as the image's `node` user (uid 1000).

## Releasing

1. Bump the version in `package.json` and add a line to `CHANGELOG.md`.
2. Commit and tag: `git tag vX.Y.Z && git push origin vX.Y.Z`. CI refuses a tag that does not match `package.json`.
3. CI publishes `ghcr.io/linagora/meet-side-service:vX.Y.Z` and a GitHub release.

Updating the deployment to pick up the new image is handled separately by whichever tool owns the deployment.

## Adding a new synced field

The shortest path:

1. Add the field to the Zod schema in `src/modules/settings/schema.ts`.
2. Add the column to the drizzle table in `src/product/meet-user.ts` (type and constraints).
3. Add the field to `UserSettingsUpdate` and to the dynamic SET builder in `src/product/db.ts`.
4. Extend `src/modules/settings/handlers.ts` to copy the field from `payload` into `updates`, with any validation or mapping you need.
5. Add tests in `src/modules/settings/handlers.spec.ts` and `src/product/db.integration.spec.ts`.
6. Update the architecture doc's "Which fields we sync" table.
7. Add the column to the PostgreSQL grant in the [operations](operations.md#database-role) doc, in the role of `src/product/db.integration.spec.ts`, and in production.

Don't ship a new field without granting it. The role is least-privilege by design, so the UPDATE will fail loudly rather than silently drop the column from the write.

## Following a Meet upgrade

`src/product/db.integration.spec.ts` runs against `src/product/meet_user.sql`, the table as the deployed Meet backend migrates it. When the deployed version changes, run that image's `python manage.py migrate` against an empty Postgres, then replace the file with `pg_dump --schema-only --no-owner --no-privileges -t meet_user`.
