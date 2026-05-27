import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const baseEnv = {
  RABBITMQ_URL: 'amqp://localhost',
  DATABASE_URL: 'postgres://localhost/meet',
};

describe('loadConfig', () => {
  it('returns defaults for optional fields', () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.RABBITMQ_EXCHANGE).toBe('settings');
    expect(cfg.RABBITMQ_ROUTING_KEY).toBe('user.settings.updated');
    expect(cfg.RABBITMQ_QUEUE).toBe('meet.user_settings');
    expect(cfg.RABBITMQ_PREFETCH).toBe(1);
    expect(cfg.MEET_USER_TABLE).toBe('meet_user');
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.HEALTH_PORT).toBe(8080);
    expect(cfg.LANGUAGE_MAP_OVERRIDES).toEqual({});
  });

  it('throws when RABBITMQ_URL is missing', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x' })).toThrow(/RABBITMQ_URL/);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadConfig({ RABBITMQ_URL: 'amqp://x' })).toThrow(/DATABASE_URL/);
  });

  it('rejects unsafe MEET_USER_TABLE identifiers', () => {
    expect(() => loadConfig({ ...baseEnv, MEET_USER_TABLE: 'meet_user; DROP TABLE' })).toThrow(
      /MEET_USER_TABLE/,
    );
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
