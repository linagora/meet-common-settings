import type { RabbitMQMessageProperties } from '@linagora/rabbitmq-client';
import { describe, expect, it, vi } from 'vitest';
import { RejectedEventError } from './errors.js';
import { routeEvents } from './router.js';

const delivery = (
  exchange: string,
  routingKey: string,
  headers: Record<string, unknown> = {},
): RabbitMQMessageProperties => ({ exchange, routingKey, headers });

const setup = () => {
  const settings = vi.fn().mockResolvedValue(undefined);
  const deleted = vi.fn().mockResolvedValue(undefined);
  const unrouted = vi.fn();
  const route = routeEvents(
    [
      { exchange: 'settings', routingKey: 'user.settings.updated', handle: settings },
      { exchange: 'auth', routingKey: 'user.deleted', handle: deleted },
    ],
    unrouted,
  );
  return { settings, deleted, unrouted, route };
};

describe('routeEvents', () => {
  it('hands an event to the route of its exchange and routing key', async () => {
    const { settings, deleted, route } = setup();
    const props = delivery('auth', 'user.deleted');
    await route({ id: 1 }, props);
    expect(deleted).toHaveBeenCalledWith({ id: 1 }, props);
    expect(settings).not.toHaveBeenCalled();
  });

  it('routes a dead letter moved back to the queue by where it was first published', async () => {
    const { deleted, route } = setup();
    const replayed = delivery('', 'meet-side-service', {
      'x-death': [
        { exchange: 'meet-side-service.dlx', 'routing-keys': ['user.settings.updated.dead'] },
        { exchange: 'auth', 'routing-keys': ['user.deleted'] },
      ],
    });
    await route({}, replayed);
    expect(deleted).toHaveBeenCalledOnce();
  });

  it('reads x-death only for a message on the default exchange', async () => {
    const { settings, route } = setup();
    await route(
      {},
      delivery('settings', 'user.settings.updated', {
        'x-death': [{ exchange: 'retry', 'routing-keys': ['delayed'] }],
      }),
    );
    expect(settings).toHaveBeenCalledOnce();
  });

  it('reports and dead letters an event no route handles', async () => {
    const { unrouted, route } = setup();
    await expect(route({}, delivery('billing', 'invoice.paid'))).rejects.toBeInstanceOf(
      RejectedEventError,
    );
    expect(unrouted).toHaveBeenCalledWith({ exchange: 'billing', routingKey: 'invoice.paid' });
  });
});
