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

describe('createDbClient (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let sql: ReturnType<typeof postgres>;
  let client: DbClient;

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

  it('updates a matching user (case-insensitive email)', async () => {
    await sql`INSERT INTO meet_user (email, language, timezone) VALUES (${'Alice@Example.com'}, ${'en-us'}, ${'UTC'})`;
    const rows = await client.updateUserSettings('alice@example.com', {
      language: 'fr-fr',
      timezone: 'Europe/Paris',
    });
    expect(rows).toBe(1);
    const after = await sql<
      { language: string; timezone: string }[]
    >`SELECT language, timezone FROM meet_user`;
    expect(after[0]).toEqual({ language: 'fr-fr', timezone: 'Europe/Paris' });
  });

  it('times out an update stuck behind a lock', async () => {
    await sql`INSERT INTO meet_user (email) VALUES (${'erin@example.com'})`;
    const lock = sql.reserve();
    const holder = await lock;
    await holder`BEGIN`;
    await holder`SELECT 1 FROM meet_user FOR UPDATE`;
    try {
      await expect(
        client.updateUserSettings('erin@example.com', { language: 'fr-fr' }),
      ).rejects.toMatchObject({ name: 'PostgresError', code: '57014' });
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
  }, 15_000);

  it('returns 0 when no user matches', async () => {
    const rows = await client.updateUserSettings('nobody@example.com', { language: 'fr-fr' });
    expect(rows).toBe(0);
  });

  it('only updates fields that are provided', async () => {
    await sql`INSERT INTO meet_user (email, language, timezone) VALUES (${'bob@example.com'}, ${'en-us'}, ${'UTC'})`;
    await client.updateUserSettings('bob@example.com', { timezone: 'Europe/Berlin' });
    const after = await sql<
      { language: string; timezone: string }[]
    >`SELECT language, timezone FROM meet_user`;
    expect(after[0]).toEqual({ language: 'en-us', timezone: 'Europe/Berlin' });
  });

  it('returns 0 when no updates are supplied', async () => {
    await sql`INSERT INTO meet_user (email) VALUES (${'carol@example.com'})`;
    const rows = await client.updateUserSettings('carol@example.com', {});
    expect(rows).toBe(0);
  });

  it('bumps updated_at when something changes', async () => {
    await sql`INSERT INTO meet_user (email, updated_at) VALUES (${'dave@example.com'}, NOW() - INTERVAL '1 hour')`;
    const before = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM meet_user`;
    await client.updateUserSettings('dave@example.com', { language: 'fr-fr' });
    const after = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM meet_user`;
    expect(new Date(after[0]!.updated_at).getTime()).toBeGreaterThan(
      new Date(before[0]!.updated_at).getTime(),
    );
  });

  it('rejects unsafe table identifiers at construction', () => {
    expect(() =>
      createDbClient({ databaseUrl: 'postgres://x', userTable: 'meet_user; DROP TABLE foo --' }),
    ).toThrow(/unsafe table identifier/);
  });
});
