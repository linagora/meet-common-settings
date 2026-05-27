import { createServer, type Server } from 'node:http';
import type { Consumer } from './consumer.js';
import type { DbClient } from './db.js';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';

export interface HealthServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface HealthDeps {
  port: number;
  consumer: Consumer;
  db: DbClient;
  metrics: Metrics;
  logger: Logger;
}

export const createHealthServer = ({
  port,
  consumer,
  db,
  metrics,
  logger,
}: HealthDeps): HealthServer => {
  let server: Server | null = null;

  return {
    async start() {
      server = createServer(async (req, res) => {
        try {
          if (req.url === '/healthz') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
          }
          if (req.url === '/readyz') {
            if (!consumer.isReady()) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'not_ready', reason: 'consumer_not_connected' }));
              return;
            }
            try {
              await db.ping();
            } catch (err) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  status: 'not_ready',
                  reason: 'db_unreachable',
                  error: err instanceof Error ? err.message : String(err),
                }),
              );
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ready' }));
            return;
          }
          if (req.url === '/metrics') {
            const body = await metrics.registry.metrics();
            res.writeHead(200, { 'Content-Type': metrics.registry.contentType });
            res.end(body);
            return;
          }
          res.writeHead(404).end();
        } catch (err) {
          logger.error({ err }, 'health endpoint error');
          res.writeHead(500).end();
        }
      });

      await new Promise<void>((resolve) => {
        server!.listen(port, () => resolve());
      });
      logger.info({ port }, 'health server listening');
    },
    async stop() {
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
};
