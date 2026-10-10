import Fastify, { LogController, type FastifyReply } from 'fastify';
import type { Consumer } from './consumer.js';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';

type Probed = Pick<Consumer, 'isReady' | 'isLive'>;

const app = (logger: Logger) =>
  Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
  });
type App = ReturnType<typeof app>;

const serveMetrics = (server: App, metrics: Metrics) =>
  server.get('/metrics', async (_request, reply) =>
    reply.type(metrics.registry.contentType).send(await metrics.registry.metrics()),
  );

const probe = (ok: () => boolean) => async (_request: unknown, reply: FastifyReply) =>
  ok() ? { status: 'ok' } : reply.code(503).send({ status: 'failing' });

export const buildHealthApp = (consumer: Probed, metrics: Metrics, logger: Logger) => {
  const server = app(logger);
  const live = probe(() => consumer.isLive());
  const ready = probe(() => consumer.isReady());
  server.get('/health/live', live);
  server.get('/health/ready', ready);
  // The paths chart 0.2.0 probes and scrapes, until it moves to the ones above.
  server.get('/healthz', live);
  server.get('/readyz', ready);
  serveMetrics(server, metrics);
  return server;
};

export const buildMetricsApp = (metrics: Metrics, logger: Logger) => {
  const server = app(logger);
  serveMetrics(server, metrics);
  return server;
};

export interface OpsServers {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const createOpsServers = (deps: {
  healthPort: number;
  metricsPort: number;
  consumer: Probed;
  metrics: Metrics;
  logger: Logger;
}): OpsServers => {
  const servers: [App, number][] = [
    [buildHealthApp(deps.consumer, deps.metrics, deps.logger), deps.healthPort],
    [buildMetricsApp(deps.metrics, deps.logger), deps.metricsPort],
  ];
  return {
    async start() {
      for (const [server, port] of servers) await server.listen({ port, host: '::' });
      deps.logger.info(
        { healthPort: deps.healthPort, metricsPort: deps.metricsPort },
        'ops servers listening',
      );
    },
    async stop() {
      await Promise.all(servers.map(([server]) => server.close()));
    },
  };
};
