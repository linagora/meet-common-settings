import { ilike, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { buildMeetUserTable, type MeetUserTable } from './schema/meet-user.js';

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

// Defense-in-depth: drizzle quotes identifiers, but rejecting unsafe names at
// construction time guarantees we never even reach the SQL builder with one.
const isSafeIdentifier = (value: string): boolean => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);

export const createDbClient = ({ databaseUrl, userTable, poolSize = 2 }: DbOptions): DbClient => {
  if (!isSafeIdentifier(userTable)) {
    throw new Error(`Refusing to use unsafe table identifier: ${userTable}`);
  }

  const client = postgres(databaseUrl, { max: poolSize });
  const db: PostgresJsDatabase = drizzle(client);
  const meetUser: MeetUserTable = buildMeetUserTable(userTable);

  return {
    async updateUserSettings(email, updates) {
      if (updates.language === undefined && updates.timezone === undefined) {
        return 0;
      }
      const set: UserSettingsUpdate = {};
      if (updates.language !== undefined) set.language = updates.language;
      if (updates.timezone !== undefined) set.timezone = updates.timezone;

      const result = await db
        .update(meetUser)
        .set({ ...set, updatedAt: sql`NOW()` })
        .where(ilike(meetUser.email, email));
      return result.count ?? 0;
    },
    async ping() {
      await db.execute(sql`SELECT 1`);
    },
    async close() {
      await client.end();
    },
  };
};
