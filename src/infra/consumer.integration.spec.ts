import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import amqp from 'amqplib';
import { Buffer } from 'node:buffer';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { buildLanguageMapper } from '../modules/settings/language.js';
import { createFakeDb, createFakeLinto } from '../product/fake.js';
import { createConsumer } from './consumer.js';
import { createMetrics } from './metrics.js';

const publishedAt = Date.now() - 1000;

describe('createConsumer (integration)', () => {
  let container: StartedRabbitMQContainer;
  let connection: amqp.ChannelModel;
  let channel: amqp.ConfirmChannel;

  const publish = async (exchange: string, routingKey: string, body: unknown) => {
    channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(body)), {
      timestamp: Math.floor(publishedAt / 1000),
    });
    await channel.waitForConfirms();
  };

  beforeAll(async () => {
    container = await new RabbitMQContainer('rabbitmq:4-management-alpine').start();
    connection = await amqp.connect(container.getAmqpUrl());
    channel = await connection.createConfirmChannel();
    for (const exchange of ['settings', 'billing', 'b2b', 'auth']) {
      await channel.assertExchange(exchange, 'topic', { durable: true });
    }
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await container.stop();
  });

  it('consumes every event from one queue and drains a legacy queue', async () => {
    await channel.assertQueue('meet.subscription.changed', {
      durable: true,
      arguments: { 'x-queue-type': 'quorum' },
    });
    await channel.bindQueue('meet.subscription.changed', 'billing', 'subscription.changed');
    await publish('billing', 'subscription.changed', {
      twakeId: 'jdoe',
      internalEmail: 'jdoe@twake.app',
      features: { meet: { recording: true } },
    });

    const db = createFakeDb({ 'alice@example.com': { language: 'fr-fr', timezone: 'UTC' } });
    const linto = createFakeLinto();
    const config = loadConfig({
      RABBITMQ_URL: container.getAmqpUrl(),
      DATABASE_URL: 'postgres://unused',
    });
    const consumer = createConsumer({
      config,
      db,
      linto,
      mapLanguage: buildLanguageMapper(),
      logger: pino({ level: 'silent' }),
      metrics: createMetrics(),
    });
    await consumer.start();
    try {
      await publish('settings', 'user.settings.updated', {
        timestamp: publishedAt,
        payload: { email: 'alice@example.com', language: 'en' },
      });
      await publish('auth', 'user.deleted', { internalEmail: 'gone@twake.app' });

      await vi.waitFor(() => {
        expect(db.users.get('alice@example.com')?.language).toBe('en-us');
        expect(linto.users.get('jdoe@twake.app')?.features).toEqual({ recording: true });
      });
      await vi.waitFor(async () => {
        const probe = await connection.createChannel();
        probe.on('error', () => {});
        await expect(probe.checkQueue('meet.subscription.changed')).rejects.toThrow(/NOT_FOUND/);
      });
      expect((await channel.checkQueue('meet-side-service')).consumerCount).toBe(1);
    } finally {
      await consumer.stop();
    }
  }, 60_000);
});
