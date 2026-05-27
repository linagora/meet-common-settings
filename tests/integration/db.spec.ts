import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { createDbClient, type DbClient } from '../../src/db.js';

const SCHEMA_SQL = `
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
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
`;

describe('createDbClient (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let client: DbClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const url = container.getConnectionUri();
    pool = new Pool({ connectionString: url });
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await pool.query(SCHEMA_SQL);
    client = createDbClient({ databaseUrl: url, userTable: 'meet_user' });
  }, 120_000);

  afterAll(async () => {
    await client.close();
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE meet_user');
  });

  it('updates a matching user (case-insensitive email)', async () => {
    await pool.query(
      `INSERT INTO meet_user (email, language, timezone) VALUES ($1, $2, $3)`,
      ['Alice@Example.com', 'en-us', 'UTC'],
    );
    const rows = await client.updateUserSettings('alice@example.com', {
      language: 'fr-fr',
      timezone: 'Europe/Paris',
    });
    expect(rows).toBe(1);
    const after = await pool.query(`SELECT language, timezone FROM meet_user`);
    expect(after.rows[0]).toEqual({ language: 'fr-fr', timezone: 'Europe/Paris' });
  });

  it('returns 0 when no user matches', async () => {
    const rows = await client.updateUserSettings('nobody@example.com', { language: 'fr-fr' });
    expect(rows).toBe(0);
  });

  it('only updates fields that are provided', async () => {
    await pool.query(
      `INSERT INTO meet_user (email, language, timezone) VALUES ($1, $2, $3)`,
      ['bob@example.com', 'en-us', 'UTC'],
    );
    await client.updateUserSettings('bob@example.com', { timezone: 'Europe/Berlin' });
    const after = await pool.query(`SELECT language, timezone FROM meet_user`);
    expect(after.rows[0]).toEqual({ language: 'en-us', timezone: 'Europe/Berlin' });
  });

  it('returns 0 when no updates are supplied', async () => {
    await pool.query(
      `INSERT INTO meet_user (email) VALUES ($1)`,
      ['carol@example.com'],
    );
    const rows = await client.updateUserSettings('carol@example.com', {});
    expect(rows).toBe(0);
  });

  it('bumps updated_at when something changes', async () => {
    await pool.query(
      `INSERT INTO meet_user (email, updated_at) VALUES ($1, NOW() - INTERVAL '1 hour')`,
      ['dave@example.com'],
    );
    const before = await pool.query(`SELECT updated_at FROM meet_user`);
    await client.updateUserSettings('dave@example.com', { language: 'fr-fr' });
    const after = await pool.query(`SELECT updated_at FROM meet_user`);
    expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThan(
      new Date(before.rows[0].updated_at).getTime(),
    );
  });

  it('rejects unsafe table identifiers at construction', () => {
    expect(() =>
      createDbClient({ databaseUrl: 'postgres://x', userTable: "meet_user; DROP TABLE foo --" }),
    ).toThrow(/unsafe table identifier/);
  });
});
