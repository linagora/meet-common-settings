import * as Sentry from '@sentry/node';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const { name, version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

// Loaded with `node --import` ahead of main.js. Sends nothing without SENTRY_DSN.
Sentry.init({
  dsn: process.env.SENTRY_DSN || undefined,
  environment: process.env.SENTRY_ENVIRONMENT || undefined,
  release: `${name}@${version}`,
  initialScope: { tags: { service: name } },
  integrations: [Sentry.pinoIntegration({ error: { levels: ['error', 'fatal'] } })],
});
