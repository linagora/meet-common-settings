import { describe, expect, it } from 'vitest';
import pino from 'pino';
import type { RabbitMQMessageProperties } from '@linagora/rabbitmq-client';
import { createMetrics } from '../../infra/metrics.js';
import { LintoError } from '../../product/api.js';
import { createFakeLinto } from '../../product/fake.js';
import { entitlementBindings, handleEntitlement, updatedAtOf } from './handlers.js';

const published = 1_758_448_800; // 2025-09-21T10:00:00Z
const publishedIso = '2025-09-21T10:00:00.000Z';
const properties: RabbitMQMessageProperties = { headers: {}, timestamp: published };

const bindingFor = (routingKey: string) => {
  const binding = entitlementBindings.find((b) => b.routingKey === routingKey);
  if (!binding) throw new Error(`no binding for ${routingKey}`);
  return binding;
};

const run = (
  routingKey: string,
  message: unknown,
  linto = createFakeLinto(),
  props = properties,
) => {
  const metrics = createMetrics();
  const deps = { linto, metrics, logger: pino({ level: 'silent' }) };
  const result = handleEntitlement(bindingFor(routingKey), message, props, deps);
  const outcome = async () =>
    (await metrics.entitlementCalls.get()).values.find((v) => v.value === 1)?.labels.outcome;
  return { result, outcome };
};

const meet = { transcription: { live: true, async: true }, recording: true };

describe('entitlement bindings', () => {
  it('binds the five events on their exchanges', () => {
    expect(entitlementBindings.map((b) => `${b.exchange}/${b.routingKey}`)).toEqual([
      'billing/subscription.changed',
      'billing/domain.subscription.changed',
      'b2b/domain.user.deleted',
      'auth/user.deleted',
      'b2b/domain.organization.deleted',
    ]);
  });

  it('subscription.changed PUTs the user with only the meet block', async () => {
    const linto = createFakeLinto();
    const { result, outcome } = run(
      'subscription.changed',
      {
        twakeId: 'jdoe',
        internalEmail: 'jdoe@twake.app',
        isPaying: true,
        features: { mail: { storageQuota: 1 }, meet },
      },
      linto,
    );
    await result;
    expect(linto.users.get('jdoe@twake.app')).toEqual({
      subject: 'jdoe',
      features: meet,
      updatedAt: publishedIso,
    });
    expect(await outcome()).toBe('applied');
  });

  it('sends empty features when the plan carries no meet block', async () => {
    const linto = createFakeLinto();
    const { result } = run(
      'subscription.changed',
      { twakeId: 'jdoe', internalEmail: 'jdoe@twake.app', features: { mail: {} } },
      linto,
    );
    await result;
    expect(linto.users.get('jdoe@twake.app')?.features).toEqual({});
  });

  it('domain.subscription.changed PUTs the domain', async () => {
    const linto = createFakeLinto();
    const { result } = run(
      'domain.subscription.changed',
      { domain: 'acme.com', features: { stack: { featureSets: ['p1'] }, meet } },
      linto,
    );
    await result;
    expect(linto.domains.get('acme.com')).toEqual({ features: meet, updatedAt: publishedIso });
  });

  it('domain.user.deleted DELETEs the internal email', async () => {
    const linto = createFakeLinto();
    await linto.putUser('jdoe@acme.com', { features: meet, updatedAt: publishedIso });
    const { result } = run(
      'domain.user.deleted',
      { internalEmail: 'jdoe@acme.com', domain: 'acme.com', organizationId: 'o1' },
      linto,
    );
    await result;
    expect(linto.users.has('jdoe@acme.com')).toBe(false);
  });

  it('user.deleted DELETEs the internal email', async () => {
    const linto = createFakeLinto();
    await linto.putUser('jdoe@twake.app', { features: meet, updatedAt: publishedIso });
    const { result } = run(
      'user.deleted',
      {
        emitter: 'ldap-rest',
        type: 'user.deleted',
        userId: 'jdoe',
        internalEmail: 'jdoe@twake.app',
        workplaceFqdn: 'jdoe.twake.app',
        reason: 'user deleted',
        reasonCode: 'user_request',
        mobile: '+33600000000',
        deletedAt: '2026-09-14T10:30:00.000Z',
      },
      linto,
    );
    await result;
    expect(linto.users.has('jdoe@twake.app')).toBe(false);
  });

  it('user.deleted without a mail address is dead-lettered', async () => {
    const linto = createFakeLinto();
    await linto.putUser('jdoe@twake.app', { features: meet, updatedAt: publishedIso });
    const { result } = run('user.deleted', { userId: 'jdoe' }, linto);
    await expect(result).rejects.toThrow(/invalid user.deleted/);
    expect(linto.users.has('jdoe@twake.app')).toBe(true);
  });

  it('domain.organization.deleted clears the domain rights', async () => {
    const linto = createFakeLinto();
    const { result } = run(
      'domain.organization.deleted',
      { domain: 'acme.com', organizationId: 'o1' },
      linto,
    );
    await result;
    expect(linto.domains.get('acme.com')).toEqual({ features: {}, updatedAt: publishedIso });
  });
});

describe('handleEntitlement', () => {
  it('counts an order-guard hit as ignored, not applied', async () => {
    const linto = createFakeLinto();
    await linto.putDomain('acme.com', { features: meet, updatedAt: '2026-01-01T00:00:00.000Z' });
    const { result, outcome } = run('domain.organization.deleted', { domain: 'acme.com' }, linto);
    await result;
    expect(await outcome()).toBe('ignored');
    expect(linto.domains.get('acme.com')?.features).toEqual(meet);
  });

  it('throws on an invalid message so it is dead-lettered, never acked', async () => {
    const linto = createFakeLinto();
    const { result, outcome } = run(
      'subscription.changed',
      { internalEmail: 'not-an-email' },
      linto,
    );
    await expect(result).rejects.toThrow(/invalid subscription.changed/);
    expect(linto.users.size).toBe(0);
    expect(await outcome()).toBe('invalid');
  });

  it('rethrows a LinTO failure', async () => {
    const linto = createFakeLinto();
    linto.failWith(new LintoError(503, ''));
    const { result, outcome } = run('user.deleted', { internalEmail: 'jdoe@twake.app' }, linto);
    await expect(result).rejects.toEqual(new LintoError(503, ''));
    expect(await outcome()).toBe('failed');
  });
});

describe('updatedAtOf', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const death = (seconds: number) => ({ time: { '!': 'timestamp', value: seconds } });

  it('uses the publish timestamp', () => {
    expect(updatedAtOf({ headers: {}, timestamp: published }, now)).toBe(publishedIso);
  });

  it('keeps the publish timestamp on a DLQ replay', () => {
    const headers = { 'x-death': [death(published + 60)] };
    expect(updatedAtOf({ headers, timestamp: published }, now)).toBe(publishedIso);
  });

  it('falls back to the first death of an unstamped replay', () => {
    const headers = { 'x-death': [death(published + 60), death(published)] };
    expect(updatedAtOf({ headers }, now)).toBe(publishedIso);
  });

  it('falls back to now for a live unstamped message', () => {
    expect(updatedAtOf({ headers: {} }, now)).toBe('2026-01-01T00:00:00.000Z');
  });
});
