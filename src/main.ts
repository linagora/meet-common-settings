import { loadConfig } from './config.js';
import { createConsumer } from './infra/consumer.js';
import { createHealthServer } from './infra/health.js';
import { logger } from './infra/logger.js';
import { createMetrics } from './infra/metrics.js';
import { buildLanguageMapper } from './modules/settings/language.js';
import { createLintoClient } from './product/api.js';
import { createDbClient } from './product/db.js';

const main = async (): Promise<void> => {
  const config = loadConfig();
  logger.level = config.LOG_LEVEL;

  const db = createDbClient({
    databaseUrl: config.DATABASE_URL,
    userTable: config.MEET_USER_TABLE,
  });
  const metrics = createMetrics();
  const mapLanguage = buildLanguageMapper(config.LANGUAGE_MAP_OVERRIDES);
  // loadConfig guarantees the LINTO_* values are set when entitlements are enabled.
  const linto = config.ENTITLEMENTS_ENABLED
    ? createLintoClient({
        baseUrl: config.LINTO_STUDIO_API_URL!,
        token: config.LINTO_ENTITLEMENTS_TOKEN!,
        organizationId: config.LINTO_TWAKE_ORG_ID!,
      })
    : undefined;
  const consumer = createConsumer({ config, db, mapLanguage, logger, metrics, linto });
  const health = createHealthServer({
    port: config.HEALTH_PORT,
    consumer,
    db,
    metrics,
    logger,
  });

  await health.start();

  try {
    await consumer.start();
  } catch (err) {
    logger.fatal({ err }, 'consumer failed to start');
    await health.stop();
    process.exit(1);
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
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
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

main().catch((err) => {
  logger.fatal({ err }, 'fatal error during startup');
  process.exit(1);
});
