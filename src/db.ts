import { Pool } from 'pg';

export interface UserSettingsUpdate {
  language?: string;
  timezone?: string;
}

export interface DbClient {
  updateUserSettings(email: string, updates: UserSettingsUpdate): Promise<number>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface DbOptions {
  databaseUrl: string;
  userTable: string;
  poolSize?: number;
}

const isSafeIdentifier = (value: string): boolean => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);

export const createDbClient = ({ databaseUrl, userTable, poolSize = 2 }: DbOptions): DbClient => {
  if (!isSafeIdentifier(userTable)) {
    throw new Error(`Refusing to use unsafe table identifier: ${userTable}`);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: poolSize });

  const updateSql = `
    UPDATE ${userTable}
       SET language = COALESCE($1, language),
           timezone = COALESCE($2, timezone),
           updated_at = NOW()
     WHERE email ILIKE $3
  `;

  return {
    async updateUserSettings(email, updates) {
      if (updates.language === undefined && updates.timezone === undefined) {
        return 0;
      }
      const result = await pool.query(updateSql, [
        updates.language ?? null,
        updates.timezone ?? null,
        email,
      ]);
      return result.rowCount ?? 0;
    },
    async ping() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
};
