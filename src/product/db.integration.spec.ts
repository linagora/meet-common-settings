import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { createDbClient } from './db.js';
import type { DbClient } from './port.js';

const SCHEMA_SQL = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE TABLE meet_user (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT,
    sub TEXT,
    language VARCHAR(10) NOT NULL DEFAULT 'en-us',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    full_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

const changedAt = new Date('2026-10-01T00:00:00Z');
const eventAt = new Date('2026-10-10T10:00:00Z');

describe('createDbClient (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let sql: ReturnType<typeof postgres>;
  let client: DbClient;

  const insert = (email: string, updatedAt = changedAt) =>
    sql`INSERT INTO meet_user (email, language, timezone, updated_at)
        VALUES (${email}, ${'en-us'}, ${'UTC'}, ${updatedAt})`;
  const rows = () =>
    sql<{ email: string; language: string; timezone: string; updated_at: Date }[]>`
      SELECT email, language, timezone, updated_at FROM meet_user ORDER BY email`;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const url = container.getConnectionUri();
    sql = postgres(url);
    await sql.unsafe(SCHEMA_SQL);
    client = createDbClient({ databaseUrl: url, userTable: 'meet_user' });
  }, 120_000);

  afterAll(async () => {
    await client.close();
    await sql.end();
    await container.stop();
  });

  beforeEach(async () => {
    await sql`TRUNCATE meet_user`;
  });

  it('updates a matching user (case-insensitive email) and stamps the event time', async () => {
    await insert('Alice@Example.com');
    const write = await client.updateUserSettings(
      'alice@example.com',
      { language: 'fr-fr', timezone: 'Europe/Paris' },
      eventAt,
    );
    expect(write).toBe('updated');
    expect(await rows()).toMatchObject([
      { language: 'fr-fr', timezone: 'Europe/Paris', updated_at: eventAt },
    ]);
  });

  it('leaves a row changed after the event', async () => {
    await insert('alice@example.com', new Date(eventAt.getTime() + 1));
    const write = await client.updateUserSettings(
      'alice@example.com',
      { language: 'fr-fr' },
      eventAt,
    );
    expect(write).toBe('stale');
    expect(await rows()).toMatchObject([{ language: 'en-us' }]);
  });

  it('applies an event only once', async () => {
    await insert('alice@example.com');
    await client.updateUserSettings('alice@example.com', { language: 'fr-fr' }, eventAt);
    const write = await client.updateUserSettings(
      'alice@example.com',
      { language: 'fr-fr' },
      eventAt,
    );
    expect(write).toBe('stale');
  });

  it('matches LIKE wildcards in the email literally', async () => {
    await insert('j_doe@example.com');
    await insert('jxdoe@example.com');
    await client.updateUserSettings('j_doe@example.com', { language: 'fr-fr' }, eventAt);
    expect((await rows()).map((r) => [r.email, r.language])).toEqual([
      ['j_doe@example.com', 'fr-fr'],
      ['jxdoe@example.com', 'en-us'],
    ]);
  });

  it('times out an update stuck behind a lock', async () => {
    await insert('erin@example.com');
    const holder = await sql.reserve();
    await holder`BEGIN`;
    await holder`SELECT 1 FROM meet_user FOR UPDATE`;
    try {
      await expect(
        client.updateUserSettings('erin@example.com', { language: 'fr-fr' }, eventAt),
      ).rejects.toMatchObject({ name: 'PostgresError', code: '57014' });
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
  }, 15_000);

  it('reports an unknown user', async () => {
    const write = await client.updateUserSettings(
      'nobody@example.com',
      { language: 'fr-fr' },
      eventAt,
    );
    expect(write).toBe('unknown_user');
  });

  it('only updates fields that are provided', async () => {
    await insert('bob@example.com');
    await client.updateUserSettings('bob@example.com', { timezone: 'Europe/Berlin' }, eventAt);
    expect(await rows()).toMatchObject([{ language: 'en-us', timezone: 'Europe/Berlin' }]);
  });

  it('rejects unsafe table identifiers at construction', () => {
    expect(() =>
      createDbClient({ databaseUrl: 'postgres://x', userTable: 'meet_user; DROP TABLE foo --' }),
    ).toThrow(/unsafe table identifier/);
  });
});
