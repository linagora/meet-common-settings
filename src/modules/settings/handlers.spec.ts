import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { MalformedEventError, RejectedEventError } from '../../events/errors.js';
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

const update = { payload: { email: 'alice@example.com', language: 'en' } };
const postgresError = (code: string) => ({ name: 'PostgresError', code });

describe('handleMessage', () => {
  it('updates language and timezone when both are present', async () => {
    const { db, handle } = setup();
    const result = await handle({
      source: 'common-settings',
      request_id: 'r1',
      version: 1,
      payload: { email: 'Alice@example.com', language: 'en', timezone: 'Europe/Paris' },
    });
    expect(result).toBe('updated');
    expect(db.users.get('alice@example.com')).toEqual({
      language: 'en-us',
      timezone: 'Europe/Paris',
    });
  });

  it('returns no_email when payload has no email', async () => {
    const { db, handle } = setup();
    expect(await handle({ payload: { language: 'en' } })).toBe('no_email');
    expect(db.users.get('alice@example.com')).toEqual(alice);
  });

  it('returns no_syncable_fields when neither language nor timezone is present', async () => {
    const { db, handle } = setup();
    const result = await handle({
      payload: { email: 'alice@example.com', display_name: 'Alice' },
    });
    expect(result).toBe('no_syncable_fields');
    expect(db.users.get('alice@example.com')).toEqual(alice);
  });

  it('drops unmappable language but keeps timezone update', async () => {
    const { db, handle } = setup();
    const result = await handle({
      payload: { email: 'alice@example.com', language: 'es', timezone: 'Europe/Berlin' },
    });
    expect(result).toBe('updated');
    expect(db.users.get('alice@example.com')).toEqual({
      language: 'fr-fr',
      timezone: 'Europe/Berlin',
    });
  });

  it('returns no_syncable_fields when only an unmappable language is provided', async () => {
    const { db, handle } = setup();
    const result = await handle({ payload: { email: 'alice@example.com', language: 'es' } });
    expect(result).toBe('no_syncable_fields');
    expect(db.users.get('alice@example.com')).toEqual(alice);
  });

  it('returns unknown_user when no Meet user matches', async () => {
    const { handle } = setup();
    const result = await handle({ payload: { email: 'ghost@example.com', language: 'en' } });
    expect(result).toBe('unknown_user');
  });

  it.each([
    ['non-object input', 'not an object'],
    ['an envelope without payload', { nickname: 'alice' }],
    ['an invalid email', { payload: { email: 'not-an-email', language: 'en' } }],
  ])('throws a malformed event error on %s', async (_, message) => {
    const { db, handle } = setup();
    await expect(handle(message)).rejects.toBeInstanceOf(MalformedEventError);
    expect(db.users.get('alice@example.com')).toEqual(alice);
  });

  it.each([
    ['connection refused', { code: 'ECONNREFUSED' }],
    ['a Postgres class 08 error', postgresError('08006')],
    ['a statement timeout', postgresError('57014')],
    ['a deadlock', postgresError('40P01')],
    ['a read-only replica during failover', postgresError('25006')],
  ])('rethrows %s for the client to retry', async (_, props) => {
    const { db, handle } = setup();
    const error = Object.assign(new Error('connection lost'), props);
    db.failWith(error);
    await expect(handle(update)).rejects.toBe(error);
  });

  it('dead letters a permanent database error', async () => {
    const { db, handle } = setup();
    const error = Object.assign(new Error('column does not exist'), postgresError('42703'));
    db.failWith(error);
    const err = await handle(update).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RejectedEventError);
    expect((err as RejectedEventError).cause).toBe(error);
  });

  it('sees a permanent database error through a wrapping error', async () => {
    const { db, handle } = setup();
    const cause = Object.assign(new Error('permission denied'), postgresError('42501'));
    db.failWith(new Error('Failed query', { cause }));
    await expect(handle(update)).rejects.toBeInstanceOf(RejectedEventError);
  });
});
