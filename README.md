# meet-side-service

Side service of Meet in Twake Workplace. It consumes Twake events from RabbitMQ and applies them where Meet reads them:

- User settings (language, timezone) from common-settings go to Meet's PostgreSQL database.
- Plan entitlements (transcription, recording) go to LinTO Studio. This part is off unless `ENTITLEMENTS_ENABLED=true`.

## Quick start

```sh
npm install
docker compose up -d --wait
cp .env.example .env
npm run dev
npm run check  # lint, format, types, tests (the integration tests need Docker), build
```

## Documentation

- [Architecture](docs/architecture.md): what the service does, its queue, outcomes and retries, and why.
- [Events](docs/events.md): every event consumed and what it does.
- [Product](docs/product.md): what it reads and writes in Meet's database, and every LinTO Studio call.
- [Deploy](docs/deploy.md): settings, permissions, probes, metrics, upgrades, troubleshooting, and running it locally.
- [Development](docs/development.md): tests, checks, releasing, following a Meet upgrade.
