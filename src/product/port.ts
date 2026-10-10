export interface UserSettingsUpdate {
  language?: string;
  timezone?: string;
}

// `stale` when Meet's row changed after `at`, which then wins.
export type SettingsWrite = 'updated' | 'stale' | 'unknown_user';

export interface DbClient {
  updateUserSettings(email: string, updates: UserSettingsUpdate, at: Date): Promise<SettingsWrite>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface EntitlementBody {
  features: Record<string, unknown>;
  updatedAt: string;
  subject?: string;
}

export interface LintoClient {
  putUser(email: string, body: EntitlementBody): Promise<{ ignored: boolean }>;
  deleteUser(email: string): Promise<void>;
  putDomain(domain: string, body: EntitlementBody): Promise<{ ignored: boolean }>;
}
