import { RabbitMQClient } from '@linagora/rabbitmq-client';
import type { Config } from './config.js';
import { handleMessage, type HandlerDeps } from './handler.js';
import type { Logger } from './logger.js';

export interface Consumer {
  start(): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
}

export interface ConsumerDeps extends HandlerDeps {
  config: Config;
  logger: Logger;
}

export const createConsumer = (deps: ConsumerDeps): Consumer => {
  const { config, logger } = deps;
  let subscribed = false;
  const client = new RabbitMQClient({
    url: config.RABBITMQ_URL,
    maxRetries: config.RABBITMQ_MAX_RETRIES,
    retryDelay: config.RABBITMQ_RETRY_DELAY,
    prefetch: config.RABBITMQ_PREFETCH,
    closeTimeout: config.SHUTDOWN_TIMEOUT_MS,
    logger,
  });

  return {
    async start() {
      logger.info(
        {
          exchange: config.RABBITMQ_EXCHANGE,
          routingKey: config.RABBITMQ_ROUTING_KEY,
          queue: config.RABBITMQ_QUEUE,
          prefetch: config.RABBITMQ_PREFETCH,
        },
        'connecting to RabbitMQ',
      );
      await client.init();
      await client.subscribe(
        config.RABBITMQ_EXCHANGE,
        config.RABBITMQ_ROUTING_KEY,
        config.RABBITMQ_QUEUE,
        async (message: Record<string, unknown>) => {
          const result = await handleMessage(message, deps);
          if (result.status === 'transient_error') {
            throw result.error;
          }
        },
      );
      subscribed = true;
      logger.info('consumer subscribed and processing messages');
    },
    async stop() {
      subscribed = false;
      logger.info('closing RabbitMQ connection');
      await client.close();
    },
    // Ready when the initial subscribe completed AND the library still holds
    // an active connection+channel. isConnected() flips false during reconnect,
    // which is what we want — Kubernetes stops routing readiness traffic to
    // this pod until the channel is back up.
    isReady() {
      return subscribed && client.isConnected();
    },
  };
};
