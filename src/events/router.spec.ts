import type { RabbitMQMessageProperties } from '@linagora/rabbitmq-client';
import { describe, expect, it, vi } from 'vitest';
import { MalformedEventError, RejectedEventError } from './errors.js';
import { routeEvents } from './router.js';

const delivery = (
  exchange: string,
  routingKey: string,
  headers: Record<string, unknown> = {},
): RabbitMQMessageProperties => ({ exchange, routingKey, headers });

const setup = () => {
  const settings = vi.fn().mockResolvedValue('updated');
  const deleted = vi.fn().mockResolvedValue(undefined);
  const outcome = vi.fn();
  const route = routeEvents(
    [
      { exchange: 'settings', routingKey: 'user.settings.updated', handle: settings },
      { exchange: 'auth', routingKey: 'user.deleted', handle: deleted },
    ],
    outcome,
  );
  return { settings, deleted, outcome, route };
};

const deletion = { exchange: 'auth', routingKey: 'user.deleted' };

describe('routeEvents', () => {
  it('hands an event to the route of its exchange and routing key', async () => {
    const { settings, deleted, route } = setup();
    const props = delivery('auth', 'user.deleted');
    await route({ id: 1 }, props);
    expect(deleted).toHaveBeenCalledWith({ id: 1 }, props);
    expect(settings).not.toHaveBeenCalled();
  });

  it('routes a dead letter moved back to the queue by where it was first published', async () => {
    const { deleted, outcome, route } = setup();
    const replayed = delivery('', 'meet-side-service', {
      'x-death': [
        { exchange: 'meet-side-service.dlx', 'routing-keys': ['user.settings.updated.dead'] },
        { exchange: 'auth', 'routing-keys': ['user.deleted'] },
      ],
    });
    await route({}, replayed);
    expect(deleted).toHaveBeenCalledOnce();
    expect(outcome).toHaveBeenCalledWith(deletion, 'handled');
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
    const { outcome, route } = setup();
    await expect(route({}, delivery('billing', 'invoice.paid'))).rejects.toBeInstanceOf(
      RejectedEventError,
    );
    expect(outcome).toHaveBeenCalledWith(
      { exchange: 'billing', routingKey: 'invoice.paid' },
      'unrouted',
    );
  });

  it('reports an event the handler found stale', async () => {
    const { deleted, outcome, route } = setup();
    deleted.mockResolvedValue('stale');
    await route({}, delivery('auth', 'user.deleted'));
    expect(outcome).toHaveBeenCalledWith(deletion, 'stale');
  });

  it.each([
    [new MalformedEventError('bad'), 'dropped'],
    [new RejectedEventError('refused'), 'dead_lettered'],
  ])('reports and rethrows %s', async (error, expected) => {
    const { deleted, outcome, route } = setup();
    deleted.mockRejectedValue(error);
    await expect(route({}, delivery('auth', 'user.deleted'))).rejects.toBe(error);
    expect(outcome).toHaveBeenCalledWith(deletion, expected);
  });

  it('reports nothing for a failure the client retries', async () => {
    const { deleted, outcome, route } = setup();
    const error = new Error('down');
    deleted.mockRejectedValue(error);
    await expect(route({}, delivery('auth', 'user.deleted'))).rejects.toBe(error);
    expect(outcome).not.toHaveBeenCalled();
  });
});
