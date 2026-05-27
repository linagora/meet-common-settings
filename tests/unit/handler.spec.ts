import { beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { DbClient, UserSettingsUpdate } from '../../src/db.js';
import { handleMessage } from '../../src/handler.js';
import { buildLanguageMapper } from '../../src/language.js';
import { createMetrics } from '../../src/metrics.js';

const silentLogger = pino({ level: 'silent' });

interface MockDb extends DbClient {
  calls: Array<{ email: string; updates: UserSettingsUpdate }>;
}

const makeDb = (rowCount = 1, throws?: Error): MockDb => {
  const calls: MockDb['calls'] = [];
  return {
    calls,
    async updateUserSettings(email, updates) {
      calls.push({ email, updates });
      if (throws) throw throws;
      return rowCount;
    },
    async ping() {},
    async close() {},
  };
};

const baseDeps = () => ({
  mapLanguage: buildLanguageMapper(),
  logger: silentLogger,
  metrics: createMetrics(),
});

describe('handleMessage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('updates language and timezone when both are present', async () => {
    const db = makeDb(1);
    const result = await handleMessage(
      {
        source: 'common-settings',
        request_id: 'r1',
        version: 1,
        payload: { email: 'Alice@example.com', language: 'en', timezone: 'Europe/Paris' },
      },
      { db, ...baseDeps() },
    );
    expect(result).toEqual({ status: 'ok', outcome: 'updated' });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]).toEqual({
      email: 'Alice@example.com',
      updates: { language: 'en-us', timezone: 'Europe/Paris' },
    });
  });

  it('returns no_email when payload has no email', async () => {
    const db = makeDb();
    const result = await handleMessage(
      { payload: { language: 'fr' } },
      { db, ...baseDeps() },
    );
    expect(result).toEqual({ status: 'ok', outcome: 'no_email' });
    expect(db.calls).toHaveLength(0);
  });

  it('returns no_syncable_fields when neither language nor timezone is present', async () => {
    const db = makeDb();
    const result = await handleMessage(
      { payload: { email: 'alice@example.com', display_name: 'Alice' } },
      { db, ...baseDeps() },
    );
    expect(result).toEqual({ status: 'ok', outcome: 'no_syncable_fields' });
    expect(db.calls).toHaveLength(0);
  });

  it('drops unmappable language but keeps timezone update', async () => {
    const db = makeDb(1);
    const result = await handleMessage(
      { payload: { email: 'a@b.com', language: 'es', timezone: 'UTC' } },
      { db, ...baseDeps() },
    );
    expect(result).toEqual({ status: 'ok', outcome: 'updated' });
    expect(db.calls[0]?.updates).toEqual({ timezone: 'UTC' });
  });

  it('returns no_syncable_fields when only an unmappable language is provided', async () => {
    const db = makeDb();
    const result = await handleMessage(
      { payload: { email: 'a@b.com', language: 'es' } },
      { db, ...baseDeps() },
    );
    expect(result).toEqual({ status: 'ok', outcome: 'no_syncable_fields' });
    expect(db.calls).toHaveLength(0);
  });

  it('returns unknown_user when 0 rows are updated', async () => {
    const db = makeDb(0);
    const result = await handleMessage(
      { payload: { email: 'ghost@example.com', language: 'en' } },
      { db, ...baseDeps() },
    );
    expect(result).toEqual({ status: 'ok', outcome: 'unknown_user' });
  });

  it('returns invalid_payload for non-object input', async () => {
    const db = makeDb();
    const result = await handleMessage('not an object', { db, ...baseDeps() });
    expect(result).toEqual({ status: 'ok', outcome: 'invalid_payload' });
    expect(db.calls).toHaveLength(0);
  });

  it('returns invalid_payload when envelope is missing payload', async () => {
    const db = makeDb();
    const result = await handleMessage({ nickname: 'alice' }, { db, ...baseDeps() });
    expect(result).toEqual({ status: 'ok', outcome: 'invalid_payload' });
  });

  it('returns invalid_payload when email is not a valid email', async () => {
    const db = makeDb();
    const result = await handleMessage(
      { payload: { email: 'not-an-email', language: 'en' } },
      { db, ...baseDeps() },
    );
    expect(result).toEqual({ status: 'ok', outcome: 'invalid_payload' });
  });

  it('returns transient_error for connection refused', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const db = makeDb(0, err);
    const result = await handleMessage(
      { payload: { email: 'a@b.com', language: 'en' } },
      { db, ...baseDeps() },
    );
    expect(result.status).toBe('transient_error');
  });

  it('returns transient_error for Postgres class 08 errors', async () => {
    const err = Object.assign(new Error('connection lost'), { code: '08006' });
    const db = makeDb(0, err);
    const result = await handleMessage(
      { payload: { email: 'a@b.com', language: 'en' } },
      { db, ...baseDeps() },
    );
    expect(result.status).toBe('transient_error');
  });

  it('returns ok with unexpected_error outcome for permanent DB errors so the queue isn\'t poisoned', async () => {
    const err = Object.assign(new Error('column does not exist'), { code: '42703' });
    const db = makeDb(0, err);
    const result = await handleMessage(
      { payload: { email: 'a@b.com', language: 'en' } },
      { db, ...baseDeps() },
    );
    expect(result).toEqual({ status: 'ok', outcome: 'unexpected_error' });
  });
});
