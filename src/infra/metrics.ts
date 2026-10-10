import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

// No own database, so this service never parks an event, and the updated_at
// guard cannot tell a duplicate from a stale event.
export type EventOutcome = 'handled' | 'stale' | 'unrouted' | 'dead_lettered' | 'dropped';

export interface EventOrigin {
  exchange: string;
  routingKey?: string;
}

export interface Metrics {
  registry: Registry;
  event(origin: EventOrigin, outcome: EventOutcome): void;
  timed<A extends unknown[], R>(
    call: string,
    fn: (...args: A) => Promise<R>,
  ): (...args: A) => Promise<R>;
}

export const createMetrics = (): Metrics => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const events = new Counter({
    name: 'mss_events_total',
    help: 'Events by the exchange and routing key they were published with, and outcome',
    labelNames: ['exchange', 'routing_key', 'outcome'] as const,
    registers: [registry],
  });

  const productCalls = new Histogram({
    name: 'mss_product_call_duration_seconds',
    help: 'Calls to Meet and LinTO Studio by call and result (ok, error)',
    labelNames: ['call', 'result'] as const,
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [registry],
  });

  return {
    registry,
    event({ exchange, routingKey = '' }, outcome) {
      events.labels(exchange, routingKey, outcome).inc();
    },
    timed:
      (call, fn) =>
      async (...args) => {
        const stop = productCalls.startTimer({ call });
        try {
          const result = await fn(...args);
          stop({ result: 'ok' });
          return result;
        } catch (err) {
          stop({ result: 'error' });
          throw err;
        }
      },
  };
};
