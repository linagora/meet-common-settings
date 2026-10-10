import { RabbitMQClient } from '@linagora/rabbitmq-client';
import { setTimeout } from 'node:timers/promises';
import type { Config } from '../config.js';
import { dropMalformed } from '../events/errors.js';
import { drainLegacyQueues } from '../events/legacy.js';
import { routeEvents, type Route } from '../events/router.js';
import {
  bindingsFor,
  DEAD_LETTER_EXCHANGE,
  DELIVERY_LIMIT,
  LEGACY_QUEUES,
  QUEUE,
  routesFor,
} from '../events/topology.js';
import type { HandlerDeps } from '../modules/settings/handlers.js';
import type { LintoClient } from '../product/port.js';
import { createLiveness } from './liveness.js';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';

export interface Consumer {
  start(): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
  isLive(): boolean;
}

// Far above one handler attempt, which the product timeouts bound to seconds.
const STUCK_AFTER_MS = 120_000;
// The client reconnects on its own every few seconds, so a restart only helps
// when that has gone wrong.
const DISCONNECTED_AFTER_MS = 600_000;

export interface ConsumerDeps extends HandlerDeps {
  config: Config;
  logger: Logger;
  metrics: Metrics;
  // Absent when ENTITLEMENTS_ENABLED is off: the entitlement events are then
  // neither bound nor handled.
  linto?: LintoClient;
}

export const createConsumer = (deps: ConsumerDeps): Consumer => {
  const { config, logger } = deps;
  let subscribed = false;
  const liveness = createLiveness({
    isConnected: () => client.isConnected(),
    stuckAfterMs: STUCK_AFTER_MS,
    disconnectedAfterMs: DISCONNECTED_AFTER_MS,
  });
  const client = new RabbitMQClient({
    url: config.RABBITMQ_URL,
    maxRetries: config.RABBITMQ_MAX_RETRIES,
    retryDelay: config.RABBITMQ_RETRY_DELAY,
    prefetch: config.RABBITMQ_PREFETCH,
    closeTimeout: config.SHUTDOWN_TIMEOUT_MS,
    // Waiting for the broker, rather than exiting, keeps a pod restarted during
    // an outage from crash looping.
    initMaxAttempts: Infinity,
    hooks: {
      onReconnect: (info) => liveness.reconnected(info),
      // The router reports the dead letters it causes; these are the client's.
      // The hook has no headers, so a replayed dead letter is labelled with the
      // default exchange rather than where it was first published.
      onMessageDlq: ({ exchange, routingKey, reason }) => {
        if (reason !== 'dead_letter_error') {
          deps.metrics.event({ exchange, routingKey }, 'dead_lettered');
        }
      },
    },
    logger,
  });
  const abort = new AbortController();
  let draining: Promise<void> | undefined;

  const drainUntilDone = async (route: Route['handle']) => {
    while (!abort.signal.aborted) {
      const done = await drainLegacyQueues(
        config.RABBITMQ_URL,
        LEGACY_QUEUES,
        route,
        logger,
        abort.signal,
      ).catch((err: unknown) => {
        logger.warn({ err }, 'draining the legacy queues failed');
        return false;
      });
      if (done) return;
      await setTimeout(config.RABBITMQ_MAX_RETRY_DELAY, undefined, { signal: abort.signal }).catch(
        () => {},
      );
    }
  };

  return {
    async start() {
      const routes = routesFor(deps, deps.linto);
      const [first, ...more] = bindingsFor(deps.linto);
      logger.info(
        { queue: QUEUE, bindings: more.length + 1, prefetch: config.RABBITMQ_PREFETCH },
        'connecting to RabbitMQ',
      );
      await client.init();
      const route = liveness.track(
        routeEvents(routes, (origin, outcome) => {
          deps.metrics.event(origin, outcome);
          if (outcome === 'unrouted')
            logger.warn(origin, 'no handler for this event; dead lettering');
        }),
      );
      await client.subscribe(first!.exchange, first!.routingKey, QUEUE, dropMalformed(route), {
        bindings: more,
        // The exchanges belong to their publishers.
        passiveExchanges: true,
        deadLetterExchange: DEAD_LETTER_EXCHANGE,
        maxRetryDelay: config.RABBITMQ_MAX_RETRY_DELAY,
        // A LinTO DELETE carries no time, so entitlements rely on arrival order,
        // whatever RABBITMQ_PREFETCH is.
        ...(deps.linto && { concurrency: 1 }),
        queueArguments: { 'x-delivery-limit': DELIVERY_LIMIT },
      });
      subscribed = true;
      logger.info('consumer subscribed and processing messages');
      // After the subscribe, so the new queue already gets what the legacy ones stop getting.
      draining = drainUntilDone(route);
    },
    async stop() {
      subscribed = false;
      abort.abort();
      await draining;
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
    // Restarting is the fix for a handler that hangs or a connection that does
    // not come back.
    isLive() {
      return liveness.isLive();
    },
  };
};
