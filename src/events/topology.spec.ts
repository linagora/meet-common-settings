import type { RabbitMQMessageProperties } from '@linagora/rabbitmq-client';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildLanguageMapper } from '../modules/settings/language.js';
import { createFakeDb, createFakeLinto } from '../product/fake.js';
import { RejectedEventError } from './errors.js';
import { bindingsFor, routesFor } from './topology.js';

const deps = {
  db: createFakeDb({}),
  mapLanguage: buildLanguageMapper(),
  logger: pino({ level: 'silent' }),
};
const deleted: RabbitMQMessageProperties = {
  exchange: 'auth',
  routingKey: 'user.deleted',
  headers: {},
};

describe('topology', () => {
  it('binds the entitlement events only with LinTO', () => {
    expect(bindingsFor(undefined)).toEqual([
      { exchange: 'settings', routingKey: 'user.settings.updated' },
    ]);
    expect(bindingsFor(createFakeLinto())).toHaveLength(6);
  });

  it('dead letters an entitlement event that arrives while entitlements are off', async () => {
    const route = routesFor(deps, undefined).find((r) => r.routingKey === 'user.deleted')!;
    await expect(route.handle({ internalEmail: 'a@b.c' }, deleted)).rejects.toBeInstanceOf(
      RejectedEventError,
    );
  });
});
