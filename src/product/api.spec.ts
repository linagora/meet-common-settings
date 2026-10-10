import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLintoClient, LintoError } from './api.js';

const linto = createLintoClient({
  baseUrl: 'https://studio.example.com/',
  token: 'secret',
  organizationId: 'root-org',
});

const root = 'https://studio.example.com/api/v1/organizations/root-org/entitlements';

const stubFetch = (response: Response) => {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const body = { features: { transcription: { live: true } }, updatedAt: '2026-09-21T10:00:00.000Z' };

describe('createLintoClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PUTs a user by lowercased, percent-encoded email with the bearer token', async () => {
    const fetchMock = stubFetch(Response.json({ kind: 'user' }));

    await expect(linto.putUser('John.Doe+meet@Twake.app', body)).resolves.toEqual({
      ignored: false,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${root}/users/john.doe%2Bmeet%40twake.app`);
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({
      authorization: 'Bearer secret',
      'content-type': 'application/json',
    });
    expect(JSON.parse(init.body)).toEqual(body);
  });

  it('reports the order guard firing', async () => {
    stubFetch(Response.json({ kind: 'domain', ignored: true }));
    await expect(linto.putDomain('Acme.com', body)).resolves.toEqual({ ignored: true });
  });

  it('PUTs a domain lowercased', async () => {
    const fetchMock = stubFetch(Response.json({ kind: 'domain' }));
    await linto.putDomain('Acme.COM', body);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${root}/domains/acme.com`);
  });

  it('DELETEs a user without a body and accepts 204', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    await linto.deleteUser('a@b.com');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${root}/users/a%40b.com`);
    expect(init).toMatchObject({ method: 'DELETE', body: undefined });
  });

  it.each([400, 401, 403, 500, 503])(
    'throws %i after a single call, with the response body',
    async (status) => {
      const fetchMock = stubFetch(new Response('{"code":"invalid_body"}', { status }));
      await expect(linto.putUser('a@b.com', body)).rejects.toEqual(
        new LintoError(status, '{"code":"invalid_body"}'),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('lets a network error through for the broker to retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(linto.deleteUser('a@b.com')).rejects.toThrow('fetch failed');
  });

  it('truncates a long error body', async () => {
    stubFetch(new Response('x'.repeat(2_000), { status: 400 }));
    const err = await linto.putUser('a@b.com', body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LintoError);
    expect((err as LintoError).body).toHaveLength(500);
  });
});
