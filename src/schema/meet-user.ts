import { pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';

// Subset of Meet's `meet_user` table — only the columns this service reads or
// writes. The Django side owns the full schema; mirroring more here would
// just create drift.
export const buildMeetUserTable = (tableName: string) =>
  pgTable(tableName, {
    email: text('email'),
    language: varchar('language', { length: 10 }).notNull(),
    timezone: text('timezone').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  });

export type MeetUserTable = ReturnType<typeof buildMeetUserTable>;
