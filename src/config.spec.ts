import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const baseEnv = {
  RABBITMQ_URL: 'amqp://localhost',
  DATABASE_URL: 'postgres://localhost/meet',
};

const entitlementsEnv = {
  ...baseEnv,
  ENTITLEMENTS_ENABLED: 'true',
  LINTO_STUDIO_API_URL: 'https://studio.example.com',
  LINTO_ENTITLEMENTS_TOKEN: 'token',
  LINTO_TWAKE_ORG_ID: 'org',
};

describe('loadConfig', () => {
  it('returns defaults for optional fields', () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.RABBITMQ_PREFETCH).toBe(1);
    expect(cfg.RABBITMQ_MAX_RETRIES).toBe(20);
    expect(cfg.RABBITMQ_MAX_RETRY_DELAY).toBe(60_000);
    expect(cfg.MEET_USER_TABLE).toBe('meet_user');
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.HEALTH_PORT).toBe(8080);
    expect(cfg.METRICS_PORT).toBe(9464);
    expect(cfg.LANGUAGE_MAP_OVERRIDES).toEqual({});
  });

  it('throws when RABBITMQ_URL is missing', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x' })).toThrow(/RABBITMQ_URL/);
  });

  it('leaves entitlements off without any LinTO setting', () => {
    expect(loadConfig(baseEnv).ENTITLEMENTS_ENABLED).toBe(false);
    expect(loadConfig({ ...baseEnv, ENTITLEMENTS_ENABLED: 'false' }).ENTITLEMENTS_ENABLED).toBe(
      false,
    );
  });

  it('treats empty LinTO settings as unset while entitlements are off', () => {
    const env = { ...baseEnv, LINTO_STUDIO_API_URL: '', LINTO_ENTITLEMENTS_TOKEN: '' };
    expect(loadConfig(env).LINTO_STUDIO_API_URL).toBeUndefined();
    expect(() => loadConfig({ ...entitlementsEnv, LINTO_STUDIO_API_URL: '' })).toThrow(
      /LINTO_STUDIO_API_URL: required when ENTITLEMENTS_ENABLED=true/,
    );
  });

  it('enables entitlements with the LinTO settings', () => {
    expect(loadConfig(entitlementsEnv).ENTITLEMENTS_ENABLED).toBe(true);
  });

  it('requires every LinTO setting when entitlements are enabled', () => {
    expect(() => loadConfig({ ...entitlementsEnv, LINTO_ENTITLEMENTS_TOKEN: undefined })).toThrow(
      /LINTO_ENTITLEMENTS_TOKEN: required when ENTITLEMENTS_ENABLED=true/,
    );
  });

  it('rejects a toggle that is not true or false', () => {
    expect(() => loadConfig({ ...entitlementsEnv, ENTITLEMENTS_ENABLED: 'yes' })).toThrow(
      /ENTITLEMENTS_ENABLED/,
    );
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadConfig({ RABBITMQ_URL: 'amqp://x' })).toThrow(/DATABASE_URL/);
  });

  it('rejects unsafe MEET_USER_TABLE identifiers', () => {
    expect(() => loadConfig({ ...baseEnv, MEET_USER_TABLE: 'meet_user; DROP TABLE' })).toThrow(
      /MEET_USER_TABLE/,
    );
  });

  it('rejects a SENTRY_DSN that is not a URL, and treats an empty one as unset', () => {
    expect(() => loadConfig({ ...baseEnv, SENTRY_DSN: 'nope' })).toThrow(/SENTRY_DSN/);
    expect(loadConfig({ ...baseEnv, SENTRY_DSN: '' }).SENTRY_DSN).toBeUndefined();
  });

  it('rejects malformed LANGUAGE_MAP_OVERRIDES', () => {
    expect(() => loadConfig({ ...baseEnv, LANGUAGE_MAP_OVERRIDES: 'not-json' })).toThrow(
      /LANGUAGE_MAP_OVERRIDES/,
    );
  });

  it('parses LANGUAGE_MAP_OVERRIDES JSON', () => {
    const cfg = loadConfig({ ...baseEnv, LANGUAGE_MAP_OVERRIDES: '{"es":"fr-fr"}' });
    expect(cfg.LANGUAGE_MAP_OVERRIDES).toEqual({ es: 'fr-fr' });
  });

  it('coerces numeric env vars', () => {
    const cfg = loadConfig({ ...baseEnv, RABBITMQ_PREFETCH: '10', HEALTH_PORT: '9090' });
    expect(cfg.RABBITMQ_PREFETCH).toBe(10);
    expect(cfg.HEALTH_PORT).toBe(9090);
  });
});
