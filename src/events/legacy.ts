import type { RabbitMQMessageProperties } from '@linagora/rabbitmq-client';
import amqp from 'amqplib';
import type { Logger } from '../infra/logger.js';
import { MalformedEventError, RejectedEventError } from './errors.js';

interface LegacyQueue {
  queue: string;
  exchange: string;
  routingKey: string;
}

type Handler = (message: unknown, properties: RabbitMQMessageProperties) => Promise<unknown>;

// Unbinds each legacy queue so it gets nothing new, hands what it holds to the
// handler, and deletes it once empty. A message that fails is put back and the
// queue kept. Resolves to whether every queue is gone.
export const drainLegacyQueues = async (
  url: string,
  queues: LegacyQueue[],
  handle: Handler,
  logger: Logger,
  signal?: AbortSignal,
): Promise<boolean> => {
  const connection = await amqp.connect(url);
  connection.on('error', (err: unknown) => logger.warn({ err }, 'legacy drain connection error'));
  // A failed operation closes its channel, so it gets a fresh one. Each is
  // closed before the connection, which would otherwise drop pending acks.
  const channels: amqp.Channel[] = [];
  const channel = async () => {
    const ch = await connection.createChannel();
    ch.on('error', () => {});
    channels.push(ch);
    return ch;
  };
  try {
    let done = true;
    for (const legacy of queues) {
      if (signal?.aborted) return false;
      if (!(await drainOne(legacy, channel, handle, logger, signal))) done = false;
    }
    return done;
  } finally {
    await Promise.allSettled(channels.map((ch) => ch.close()));
    await connection.close().catch(() => {});
  }
};

const drainOne = async (
  legacy: LegacyQueue,
  channel: () => Promise<amqp.Channel>,
  handle: Handler,
  logger: Logger,
  signal: AbortSignal | undefined,
): Promise<boolean> => {
  let ch = await channel();
  try {
    await ch.checkQueue(legacy.queue);
  } catch {
    return true;
  }
  try {
    await ch.unbindQueue(legacy.queue, legacy.exchange, legacy.routingKey);
  } catch {
    // The exchange is gone, and the binding with it.
    ch = await channel();
  }
  if (!(await drain(ch, legacy, handle, logger, signal))) return false;
  // Messages another process holds unacked are not counted, and would be lost.
  const { consumerCount } = await ch.checkQueue(legacy.queue);
  if (consumerCount > 0) return false;
  // Quorum queues refuse ifEmpty. Unbound, unconsumed and just found empty, it is.
  await ch.deleteQueue(legacy.queue);
  logger.info({ queue: legacy.queue }, 'legacy queue drained and deleted');
  return true;
};

const drain = async (
  channel: amqp.Channel,
  { queue }: LegacyQueue,
  handle: Handler,
  logger: Logger,
  signal: AbortSignal | undefined,
): Promise<boolean> => {
  while (!signal?.aborted) {
    const message = await channel.get(queue, { noAck: false });
    if (!message) return true;
    let content: unknown;
    try {
      content = JSON.parse(message.content.toString());
    } catch {
      logger.warn({ queue }, 'legacy message is not JSON; dead lettering');
      channel.nack(message, false, false);
      continue;
    }
    try {
      await handle(content, {
        exchange: message.fields.exchange,
        routingKey: message.fields.routingKey,
        headers: message.properties.headers ?? {},
        timestamp: message.properties.timestamp,
        messageId: message.properties.messageId,
        correlationId: message.properties.correlationId,
      });
      channel.ack(message);
    } catch (err) {
      if (err instanceof MalformedEventError) {
        channel.ack(message);
      } else if (err instanceof RejectedEventError) {
        channel.nack(message, false, false);
      } else {
        logger.warn({ queue, err }, 'legacy message failed; draining again later');
        channel.nack(message, false, true);
        return false;
      }
    }
  }
  return false;
};
