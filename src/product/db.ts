import { and, lt, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { buildMeetUserTable, type MeetUserTable } from './meet-user.js';
import type { DbClient } from './port.js';

export interface DbOptions {
  databaseUrl: string;
  userTable: string;
  poolSize?: number;
}

const STATEMENT_TIMEOUT_MS = 5_000;

// Defense-in-depth: drizzle quotes identifiers, but rejecting unsafe names at
// construction time guarantees we never even reach the SQL builder with one.
const isSafeIdentifier = (value: string): boolean => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);

export const createDbClient = ({ databaseUrl, userTable, poolSize = 2 }: DbOptions): DbClient => {
  if (!isSafeIdentifier(userTable)) {
    throw new Error(`Refusing to use unsafe table identifier: ${userTable}`);
  }

  const client = postgres(databaseUrl, { max: poolSize, connect_timeout: 10 });
  const db: PostgresJsDatabase = drizzle(client);
  const meetUser: MeetUserTable = buildMeetUserTable(userTable);

  return {
    async updateUserSettings(email, updates, at) {
      const matches = sql`lower(${meetUser.email}) = lower(${email})`;
      // SET LOCAL rather than a startup parameter, which PgBouncer refuses.
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`SET LOCAL statement_timeout = ${sql.raw(String(STATEMENT_TIMEOUT_MS))}`,
        );
        // Stamping the event time makes a redelivery, or any older event, stale.
        const result = await tx
          .update(meetUser)
          .set({ ...updates, updatedAt: at })
          .where(and(matches, lt(meetUser.updatedAt, at)));
        if (result.count > 0) return 'updated';
        const known = await tx
          .select({ email: meetUser.email })
          .from(meetUser)
          .where(matches)
          .limit(1);
        return known.length > 0 ? 'stale' : 'unknown_user';
      });
    },
    async ping() {
      await db.execute(sql`SELECT 1`);
    },
    async close() {
      await client.end();
    },
  };
};
