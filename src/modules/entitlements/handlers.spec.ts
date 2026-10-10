import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { RabbitMQMessageProperties } from '@linagora/rabbitmq-client';
import { createMetrics } from '../../infra/metrics.js';
import { LintoError, type LintoClient } from '../../product/api.js';
import { entitlementBindings, handleEntitlement, updatedAtOf } from './handlers.js';

const published = 1_758_448_800; // 2025-09-21T10:00:00Z
const publishedIso = '2025-09-21T10:00:00.000Z';
const properties: RabbitMQMessageProperties = { headers: {}, timestamp: published };

const makeLinto = (ignored = false) => ({
  putUser: vi.fn().mockResolvedValue({ ignored }),
  deleteUser: vi.fn().mockResolvedValue(undefined),
  putDomain: vi.fn().mockResolvedValue({ ignored }),
});

const bindingFor = (routingKey: string) => {
  const binding = entitlementBindings.find((b) => b.routingKey === routingKey);
  if (!binding) throw new Error(`no binding for ${routingKey}`);
  return binding;
};

const run = async (
  routingKey: string,
  message: unknown,
  linto: LintoClient = makeLinto(),
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
    const linto = makeLinto();
    const { result, outcome } = await run(
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
    expect(linto.putUser).toHaveBeenCalledWith('jdoe@twake.app', {
      subject: 'jdoe',
      features: meet,
      updatedAt: publishedIso,
    });
    expect(await outcome()).toBe('applied');
  });

  it('sends empty features when the plan carries no meet block', async () => {
    const linto = makeLinto();
    const { result } = await run(
      'subscription.changed',
      { twakeId: 'jdoe', internalEmail: 'jdoe@twake.app', features: { mail: {} } },
      linto,
    );
    await result;
    expect(linto.putUser.mock.calls[0]![1].features).toEqual({});
  });

  it('domain.subscription.changed PUTs the domain', async () => {
    const linto = makeLinto();
    const { result } = await run(
      'domain.subscription.changed',
      { domain: 'acme.com', features: { stack: { featureSets: ['p1'] }, meet } },
      linto,
    );
    await result;
    expect(linto.putDomain).toHaveBeenCalledWith('acme.com', {
      features: meet,
      updatedAt: publishedIso,
    });
  });

  it('domain.user.deleted DELETEs the internal email', async () => {
    const linto = makeLinto();
    const { result } = await run(
      'domain.user.deleted',
      { internalEmail: 'jdoe@acme.com', domain: 'acme.com', organizationId: 'o1' },
      linto,
    );
    await result;
    expect(linto.deleteUser).toHaveBeenCalledWith('jdoe@acme.com');
  });

  it('user.deleted DELETEs the internal email', async () => {
    const linto = makeLinto();
    const { result } = await run(
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
    expect(linto.deleteUser).toHaveBeenCalledWith('jdoe@twake.app');
  });

  it('user.deleted without a mail address is dead-lettered', async () => {
    const linto = makeLinto();
    const { result } = await run('user.deleted', { userId: 'jdoe' }, linto);
    await expect(result).rejects.toThrow(/invalid user.deleted/);
    expect(linto.deleteUser).not.toHaveBeenCalled();
  });

  it('domain.organization.deleted clears the domain rights', async () => {
    const linto = makeLinto();
    const { result } = await run(
      'domain.organization.deleted',
      { domain: 'acme.com', organizationId: 'o1' },
      linto,
    );
    await result;
    expect(linto.putDomain).toHaveBeenCalledWith('acme.com', {
      features: {},
      updatedAt: publishedIso,
    });
  });
});

describe('handleEntitlement', () => {
  it('counts an order-guard hit as ignored, not applied', async () => {
    const { result, outcome } = await run(
      'domain.organization.deleted',
      { domain: 'acme.com' },
      makeLinto(true),
    );
    await result;
    expect(await outcome()).toBe('ignored');
  });

  it('throws on an invalid message so it is dead-lettered, never acked', async () => {
    const linto = makeLinto();
    const { result, outcome } = await run(
      'subscription.changed',
      { internalEmail: 'not-an-email' },
      linto,
    );
    await expect(result).rejects.toThrow(/invalid subscription.changed/);
    expect(linto.putUser).not.toHaveBeenCalled();
    expect(await outcome()).toBe('invalid');
  });

  it('rethrows a LinTO failure', async () => {
    const linto = makeLinto();
    linto.deleteUser.mockRejectedValue(new LintoError(503));
    const { result, outcome } = await run('user.deleted', { internalEmail: 'a@b.com' }, linto);
    await expect(result).rejects.toEqual(new LintoError(503));
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
