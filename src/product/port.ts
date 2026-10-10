export interface UserSettingsUpdate {
  language?: string;
  timezone?: string;
}

export interface DbClient {
  updateUserSettings(email: string, updates: UserSettingsUpdate): Promise<number>;
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
