import type { RabbitMQMessageProperties } from '@linagora/rabbitmq-client';
import { z } from 'zod';
import type { EventOrigin, EventOutcome } from '../infra/metrics.js';
import { MalformedEventError, RejectedEventError } from './errors.js';

export interface Route {
  exchange: string;
  routingKey: string;
  handle(message: unknown, properties: RabbitMQMessageProperties): Promise<unknown>;
}

// A dead letter moved back into the queue arrives on the default exchange. The
// broker puts the newest death first, so the last entry holds where the
// message was first published.
const xDeath = z.array(z.object({ exchange: z.string(), 'routing-keys': z.array(z.string()) }));

const originOf = ({ exchange, routingKey, headers }: RabbitMQMessageProperties) => {
  const deaths = exchange === '' ? xDeath.safeParse(headers['x-death']) : undefined;
  const first = deaths?.success ? deaths.data.at(-1) : undefined;
  return first
    ? { exchange: first.exchange, routingKey: first['routing-keys'][0] }
    : { exchange, routingKey };
};

// A handler resolves `stale` when the product already holds newer state. A
// failure the client retries has no outcome yet.
export const routeEvents =
  (routes: Route[], onOutcome: (origin: EventOrigin, outcome: EventOutcome) => void) =>
  async (message: unknown, properties: RabbitMQMessageProperties) => {
    const origin = originOf(properties);
    const route = routes.find(
      (r) => r.exchange === origin.exchange && r.routingKey === origin.routingKey,
    );
    if (!route) {
      onOutcome(origin, 'unrouted');
      throw new RejectedEventError(`no route for ${origin.exchange}/${origin.routingKey}`);
    }
    let result: unknown;
    try {
      result = await route.handle(message, properties);
    } catch (err) {
      if (err instanceof MalformedEventError) onOutcome(origin, 'dropped');
      if (err instanceof RejectedEventError) onOutcome(origin, 'dead_lettered');
      throw err;
    }
    // Outside the try, so a failure here never makes the client run the handler again.
    onOutcome(origin, result === 'stale' ? 'stale' : 'handled');
    return result;
  };
