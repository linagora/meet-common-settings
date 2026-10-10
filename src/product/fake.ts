import type { DbClient, EntitlementBody, LintoClient, UserSettingsUpdate } from './port.js';

interface UserSettings {
  language: string;
  timezone: string;
}

export const createFakeDb = (users: Record<string, UserSettings> = {}) => {
  const rows = new Map(Object.entries(users).map(([email, s]) => [email.toLowerCase(), { ...s }]));
  let failure: Error | undefined;
  const fail = () => {
    if (failure) throw failure;
  };

  return {
    users: rows,
    failWith(error: Error) {
      failure = error;
    },
    async updateUserSettings(email: string, updates: UserSettingsUpdate) {
      fail();
      const row = rows.get(email.toLowerCase());
      if (!row || (updates.language === undefined && updates.timezone === undefined)) return 0;
      Object.assign(row, updates);
      return 1;
    },
    async ping() {
      fail();
    },
    async close() {},
  } satisfies DbClient & Record<string, unknown>;
};

// LinTO drops a PUT older than the state it holds and answers `ignored`.
export const createFakeLinto = () => {
  const users = new Map<string, EntitlementBody>();
  const domains = new Map<string, EntitlementBody>();
  let failure: Error | undefined;
  const fail = () => {
    if (failure) throw failure;
  };
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
    failWith(error: Error) {
      failure = error;
    },
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
