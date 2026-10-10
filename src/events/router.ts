import type { RabbitMQMessageProperties } from '@linagora/rabbitmq-client';
import { z } from 'zod';
import { RejectedEventError } from './errors.js';

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

export const routeEvents =
  (routes: Route[], onUnrouted: (origin: { exchange: string; routingKey?: string }) => void) =>
  async (message: unknown, properties: RabbitMQMessageProperties) => {
    const origin = originOf(properties);
    const route = routes.find(
      (r) => r.exchange === origin.exchange && r.routingKey === origin.routingKey,
    );
    if (!route) {
      onUnrouted(origin);
      throw new RejectedEventError(`no route for ${origin.exchange}/${origin.routingKey}`);
    }
    return route.handle(message, properties);
  };
