import type {
  DbClient,
  EntitlementBody,
  LintoClient,
  SettingsWrite,
  UserSettingsUpdate,
} from './port.js';

interface UserSettings {
  language: string;
  timezone: string;
}

const failer = () => {
  let failure: Error | undefined;
  return {
    failWith(error: Error) {
      failure = error;
    },
    fail() {
      if (failure) throw failure;
    },
  };
};

// Meet keeps one updated_at per row, and the guard compares the event time with it.
export const createFakeDb = (users: Record<string, UserSettings> = {}) => {
  const rows = new Map(Object.entries(users).map(([email, s]) => [email.toLowerCase(), { ...s }]));
  const updatedAt = new Map<string, Date>();
  const { failWith, fail } = failer();

  return {
    users: rows,
    updatedAt,
    failWith,
    async updateUserSettings(
      email: string,
      updates: UserSettingsUpdate,
      at: Date,
    ): Promise<SettingsWrite> {
      fail();
      const key = email.toLowerCase();
      const row = rows.get(key);
      if (!row) return 'unknown_user';
      if (at <= (updatedAt.get(key) ?? new Date(0))) return 'stale';
      Object.assign(row, updates);
      updatedAt.set(key, at);
      return 'updated';
    },
    async close() {},
  } satisfies DbClient & Record<string, unknown>;
};

// LinTO drops a PUT older than the state it holds and answers `ignored`.
export const createFakeLinto = () => {
  const users = new Map<string, EntitlementBody>();
  const domains = new Map<string, EntitlementBody>();
  const { failWith, fail } = failer();
  const put = (records: Map<string, EntitlementBody>, key: string, body: EntitlementBody) => {
    fail();
    const current = records.get(key.toLowerCase());
    if (current && current.updatedAt > body.updatedAt) return { ignored: true };
    records.set(key.toLowerCase(), { ...body });
    return { ignored: false };
  };

  return {
    users,
    domains,
    failWith,
    async putUser(email: string, body: EntitlementBody) {
      return put(users, email, body);
    },
    async deleteUser(email: string) {
      fail();
      users.delete(email.toLowerCase());
    },
    async putDomain(domain: string, body: EntitlementBody) {
      return put(domains, domain, body);
    },
  } satisfies LintoClient & Record<string, unknown>;
};
