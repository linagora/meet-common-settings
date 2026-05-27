import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export type Outcome =
  | 'updated'
  | 'unknown_user'
  | 'no_email'
  | 'no_syncable_fields'
  | 'invalid_payload'
  | 'db_error'
  | 'unexpected_error';

export interface Metrics {
  registry: Registry;
  messagesProcessed: Counter<'outcome'>;
  messageLatency: Histogram<'outcome'>;
  dbErrors: Counter<string>;
  observe(outcome: Outcome, latencyMs: number): void;
}

export const createMetrics = (): Metrics => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const messagesProcessed = new Counter({
    name: 'mcs_messages_processed_total',
    help: 'Total messages processed by outcome',
    labelNames: ['outcome'] as const,
    registers: [registry],
  });

  const messageLatency = new Histogram({
    name: 'mcs_message_latency_seconds',
    help: 'Message processing latency in seconds',
    labelNames: ['outcome'] as const,
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  });

  const dbErrors = new Counter({
    name: 'mcs_db_errors_total',
    help: 'Total database errors',
    registers: [registry],
  });

  return {
    registry,
    messagesProcessed,
    messageLatency,
    dbErrors,
    observe(outcome, latencyMs) {
      messagesProcessed.labels(outcome).inc();
      messageLatency.labels(outcome).observe(latencyMs / 1000);
    },
  };
};
