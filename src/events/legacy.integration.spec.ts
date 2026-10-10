import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import amqp from 'amqplib';
import { Buffer } from 'node:buffer';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MalformedEventError, RejectedEventError } from './errors.js';
import { drainLegacyQueues } from './legacy.js';

const logger = pino({ level: 'silent' });
const legacy = {
  queue: 'meet.user_settings',
  exchange: 'settings',
  routingKey: 'user.settings.updated',
};

describe('drainLegacyQueues (integration)', () => {
  let container: StartedRabbitMQContainer;
  let url: string;
  let connection: amqp.ChannelModel;
  let channel: amqp.Channel;

  // As the 0.4.1 client declared it.
  const declareLegacy = async () => {
    await channel.assertExchange(legacy.exchange, 'topic', { durable: true });
    await channel.assertExchange(`${legacy.exchange}.dlx`, 'topic', { durable: true });
    await channel.assertQueue(`${legacy.queue}.dlq`, { durable: true });
    await channel.bindQueue(
      `${legacy.queue}.dlq`,
      `${legacy.exchange}.dlx`,
      `${legacy.routingKey}.dead`,
    );
    await channel.assertQueue(legacy.queue, {
      durable: true,
      deadLetterExchange: `${legacy.exchange}.dlx`,
      deadLetterRoutingKey: `${legacy.routingKey}.dead`,
      arguments: { 'x-queue-type': 'quorum', 'x-overflow': 'reject-publish' },
    });
    await channel.bindQueue(legacy.queue, legacy.exchange, legacy.routingKey);
  };
  const publish = (body: unknown) =>
    channel.publish(legacy.exchange, legacy.routingKey, Buffer.from(JSON.stringify(body)), {
      timestamp: 1_760_000_000,
    });
  const exists = async (queue: string) => {
    const probe = await connection.createChannel();
    probe.on('error', () => {});
    try {
      return (await probe.checkQueue(queue)).messageCount;
    } catch {
      return undefined;
    }
  };

  beforeAll(async () => {
    container = await new RabbitMQContainer('rabbitmq:4-management-alpine').start();
    url = container.getAmqpUrl();
    connection = await amqp.connect(url);
    channel = await connection.createConfirmChannel();
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await container.stop();
  });

  it('skips a queue that does not exist', async () => {
    const handler = vi.fn();
    await drainLegacyQueues(url, [legacy], handler, logger);
    expect(handler).not.toHaveBeenCalled();
  });

  it('hands every message over with where it came from, then deletes the queue', async () => {
    await declareLegacy();
    publish({ n: 1 });
    publish({ n: 2 });
    await (channel as amqp.ConfirmChannel).waitForConfirms();
    const handler = vi.fn().mockResolvedValue(undefined);

    expect(await drainLegacyQueues(url, [legacy], handler, logger)).toBe(true);

    expect(handler.mock.calls.map(([m]) => m)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(handler.mock.calls[0]![1]).toMatchObject({
      exchange: 'settings',
      routingKey: 'user.settings.updated',
      timestamp: 1_760_000_000,
    });
    expect(await exists(legacy.queue)).toBeUndefined();
  });

  it('drops a malformed message, dead letters a rejected one, and keeps the queue on a failure', async () => {
    await declareLegacy();
    publish({ kind: 'malformed' });
    publish({ kind: 'rejected' });
    publish({ kind: 'down' });
    await (channel as amqp.ConfirmChannel).waitForConfirms();
    const handler = vi.fn(async (body: unknown) => {
      const message = body as { kind: string };
      if (message.kind === 'malformed') throw new MalformedEventError('bad');
      if (message.kind === 'rejected') throw new RejectedEventError('refused');
      throw new Error('down');
    });

    expect(await drainLegacyQueues(url, [legacy], handler, logger)).toBe(false);

    expect(await exists(legacy.queue)).toBe(1);
    expect(await exists(`${legacy.queue}.dlq`)).toBe(1);
    await channel.purgeQueue(legacy.queue);
    await channel.purgeQueue(`${legacy.queue}.dlq`);
  });

  it('dead letters a message that is not JSON', async () => {
    await declareLegacy();
    channel.publish(legacy.exchange, legacy.routingKey, Buffer.from('not json'));
    await (channel as amqp.ConfirmChannel).waitForConfirms();

    expect(await drainLegacyQueues(url, [legacy], vi.fn(), logger)).toBe(true);

    expect(await exists(`${legacy.queue}.dlq`)).toBe(1);
    await channel.purgeQueue(`${legacy.queue}.dlq`);
  });

  it('keeps a queue another process still consumes', async () => {
    await declareLegacy();
    const other = await connection.createChannel();
    await other.consume(legacy.queue, () => {});

    expect(await drainLegacyQueues(url, [legacy], vi.fn(), logger)).toBe(false);

    expect(await exists(legacy.queue)).toBe(0);
    await other.close();
  });

  it('stops between messages once aborted', async () => {
    await declareLegacy();
    publish({ n: 1 });
    publish({ n: 2 });
    await (channel as amqp.ConfirmChannel).waitForConfirms();
    const abort = new AbortController();
    const handler = vi.fn(async () => abort.abort());

    expect(await drainLegacyQueues(url, [legacy], handler, logger, abort.signal)).toBe(false);

    expect(handler).toHaveBeenCalledOnce();
    expect(await exists(legacy.queue)).toBe(1);
    await channel.purgeQueue(legacy.queue);
  });

  it('stops new messages reaching the queue', async () => {
    await declareLegacy();
    publish({ n: 1 });
    await (channel as amqp.ConfirmChannel).waitForConfirms();
    await drainLegacyQueues(url, [legacy], vi.fn().mockRejectedValue(new Error('down')), logger);
    publish({ n: 2 });
    await (channel as amqp.ConfirmChannel).waitForConfirms();
    expect(await exists(legacy.queue)).toBe(1);
  });
});
