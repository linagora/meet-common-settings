import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { createMetrics } from '../../infra/metrics.js';
import { createFakeDb } from '../../product/fake.js';
import { handleMessage } from './handlers.js';
import { buildLanguageMapper } from './language.js';

const alice = { language: 'fr-fr', timezone: 'UTC' };

const setup = (users = { 'alice@example.com': alice }) => {
  const db = createFakeDb(users);
  const deps = {
    db,
    mapLanguage: buildLanguageMapper(),
    logger: pino({ level: 'silent' }),
    metrics: createMetrics(),
  };
  return { db, handle: (message: unknown) => handleMessage(message, deps) };
};

describe('handleMessage', () => {
  it('updates language and timezone when both are present', async () => {
    const { db, handle } = setup();
    const result = await handle({
      source: 'common-settings',
      request_id: 'r1',
      version: 1,
      payload: { email: 'Alice@example.com', language: 'en', timezone: 'Europe/Paris' },
    });
    expect(result).toEqual({ status: 'ok', outcome: 'updated' });
    expect(db.users.get('alice@example.com')).toEqual({
      language: 'en-us',
      timezone: 'Europe/Paris',
    });
  });

  it('returns no_email when payload has no email', async () => {
    const { db, handle } = setup();
    const result = await handle({ payload: { language: 'en' } });
    expect(result).toEqual({ status: 'ok', outcome: 'no_email' });
    expect(db.users.get('alice@example.com')).toEqual(alice);
  });

  it('returns no_syncable_fields when neither language nor timezone is present', async () => {
    const { db, handle } = setup();
    const result = await handle({
      payload: { email: 'alice@example.com', display_name: 'Alice' },
    });
    expect(result).toEqual({ status: 'ok', outcome: 'no_syncable_fields' });
    expect(db.users.get('alice@example.com')).toEqual(alice);
  });

  it('drops unmappable language but keeps timezone update', async () => {
    const { db, handle } = setup();
    const result = await handle({
      payload: { email: 'alice@example.com', language: 'es', timezone: 'Europe/Berlin' },
    });
    expect(result).toEqual({ status: 'ok', outcome: 'updated' });
    expect(db.users.get('alice@example.com')).toEqual({
      language: 'fr-fr',
      timezone: 'Europe/Berlin',
    });
  });

  it('returns no_syncable_fields when only an unmappable language is provided', async () => {
    const { db, handle } = setup();
    const result = await handle({
      payload: { email: 'alice@example.com', language: 'es' },
    });
    expect(result).toEqual({ status: 'ok', outcome: 'no_syncable_fields' });
    expect(db.users.get('alice@example.com')).toEqual(alice);
  });

  it('returns unknown_user when no Meet user matches', async () => {
    const { handle } = setup();
    const result = await handle({ payload: { email: 'ghost@example.com', language: 'en' } });
    expect(result).toEqual({ status: 'ok', outcome: 'unknown_user' });
  });

  it('returns invalid_payload for non-object input', async () => {
    const { handle } = setup();
    expect(await handle('not an object')).toEqual({ status: 'ok', outcome: 'invalid_payload' });
  });

  it('returns invalid_payload when envelope is missing payload', async () => {
    const { handle } = setup();
    expect(await handle({ nickname: 'alice' })).toEqual({
      status: 'ok',
      outcome: 'invalid_payload',
    });
  });

  it('returns invalid_payload when email is not a valid email', async () => {
    const { db, handle } = setup();
    const result = await handle({ payload: { email: 'not-an-email', language: 'en' } });
    expect(result).toEqual({ status: 'ok', outcome: 'invalid_payload' });
    expect(db.users.get('alice@example.com')).toEqual(alice);
  });

  it('returns transient_error for connection refused', async () => {
    const { db, handle } = setup();
    db.failWith(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
    );
    const result = await handle({
      payload: { email: 'alice@example.com', language: 'en' },
    });
    expect(result.status).toBe('transient_error');
  });

  it('returns transient_error for Postgres class 08 errors', async () => {
    const { db, handle } = setup();
    db.failWith(Object.assign(new Error('connection lost'), { code: '08006' }));
    const result = await handle({
      payload: { email: 'alice@example.com', language: 'en' },
    });
    expect(result.status).toBe('transient_error');
  });

  it("returns ok with unexpected_error outcome for permanent DB errors so the queue isn't poisoned", async () => {
    const { db, handle } = setup();
    db.failWith(Object.assign(new Error('column does not exist'), { code: '42703' }));
    const result = await handle({
      payload: { email: 'alice@example.com', language: 'en' },
    });
    expect(result).toEqual({ status: 'ok', outcome: 'unexpected_error' });
  });
});
