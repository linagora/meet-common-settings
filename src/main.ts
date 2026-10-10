import * as Sentry from '@sentry/node';
import { loadConfig } from './config.js';
import { createConsumer } from './infra/consumer.js';
import { createOpsServers } from './infra/http.js';
import { logger } from './infra/logger.js';
import { createMetrics } from './infra/metrics.js';
import { buildLanguageMapper } from './modules/settings/language.js';
import { createLintoClient } from './product/api.js';
import { createDbClient } from './product/db.js';
import type { LintoClient } from './product/port.js';

// process.exit drops what Sentry has not sent yet.
const exit = async (code: number): Promise<never> => {
  await Sentry.close(2000);
  process.exit(code);
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  logger.level = config.LOG_LEVEL;

  const metrics = createMetrics();
  const db = createDbClient({
    databaseUrl: config.DATABASE_URL,
    userTable: config.MEET_USER_TABLE,
  });
  const meet = {
    ...db,
    updateUserSettings: metrics.timed('meet.update_user_settings', db.updateUserSettings),
  };
  const mapLanguage = buildLanguageMapper(config.LANGUAGE_MAP_OVERRIDES);
  const timedLinto = (client: LintoClient): LintoClient => ({
    putUser: metrics.timed('linto.put_user', client.putUser),
    deleteUser: metrics.timed('linto.delete_user', client.deleteUser),
    putDomain: metrics.timed('linto.put_domain', client.putDomain),
  });
  // loadConfig guarantees the LINTO_* values are set when entitlements are enabled.
  const linto = config.ENTITLEMENTS_ENABLED
    ? timedLinto(
        createLintoClient({
          baseUrl: config.LINTO_STUDIO_API_URL!,
          token: config.LINTO_ENTITLEMENTS_TOKEN!,
          organizationId: config.LINTO_TWAKE_ORG_ID!,
        }),
      )
    : undefined;
  const consumer = createConsumer({ config, db: meet, mapLanguage, logger, metrics, linto });
  const health = createOpsServers({
    healthPort: config.HEALTH_PORT,
    metricsPort: config.METRICS_PORT,
    consumer,
    metrics,
    logger,
  });

  await health.start();

  try {
    await consumer.start();
  } catch (err) {
    logger.fatal({ err }, 'consumer failed to start');
    await health.stop();
    await exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown signal received');

    const timer = setTimeout(() => {
      logger.error({ timeoutMs: config.SHUTDOWN_TIMEOUT_MS }, 'shutdown timeout; forcing exit');
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    try {
      await consumer.stop();
      await db.close();
      await health.stop();
      logger.info('shutdown complete');
      await exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      await exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandled rejection');
    void shutdown('unhandledRejection');
  });
};

main().catch(async (err) => {
  logger.fatal({ err }, 'fatal error during startup');
  await exit(1);
});
