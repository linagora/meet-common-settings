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

export interface LintoOptions {
  baseUrl: string;
  token: string;
  organizationId: string;
}

// One attempt per call: the broker client retries the handler, then dead-letters.
const TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY = 500;

export class LintoError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`LinTO Studio answered ${status}: ${body}`);
  }
}

export const createLintoClient = ({
  baseUrl,
  token,
  organizationId,
}: LintoOptions): LintoClient => {
  const root = `${baseUrl.replace(/\/+$/, '')}/api/v1/organizations/${encodeURIComponent(organizationId)}/entitlements`;

  const call = async (method: 'PUT' | 'DELETE', path: string, body?: EntitlementBody) => {
    const res = await fetch(root + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body && { 'content-type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new LintoError(res.status, (await res.text()).slice(0, MAX_ERROR_BODY));
    return res;
  };

  const put = async (path: string, body: EntitlementBody) => {
    const res = await call('PUT', path, body);
    const json = (await res.json()) as { ignored?: boolean };
    return { ignored: json.ignored === true };
  };

  const user = (email: string) => `/users/${encodeURIComponent(email.toLowerCase())}`;

  return {
    putUser: (email, body) => put(user(email), body),
    async deleteUser(email) {
      await call('DELETE', user(email));
    },
    putDomain: (domain, body) => put(`/domains/${encodeURIComponent(domain.toLowerCase())}`, body),
  };
};
