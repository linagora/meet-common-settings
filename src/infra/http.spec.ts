import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildHealthApp, buildMetricsApp } from './http.js';
import { createMetrics } from './metrics.js';

const logger = pino({ level: 'silent' });
const consumer = (ready: boolean, live: boolean) => ({
  isReady: () => ready,
  isLive: () => live,
});

describe('buildHealthApp', () => {
  it('answers live and ready', async () => {
    const app = buildHealthApp(consumer(true, true), createMetrics(), logger);
    for (const url of ['/health/live', '/health/ready', '/healthz', '/readyz']) {
      expect((await app.inject({ url })).statusCode).toBe(200);
    }
  });

  it('turns ready false while the consumer is not subscribed', async () => {
    const app = buildHealthApp(consumer(false, true), createMetrics(), logger);
    expect((await app.inject({ url: '/health/ready' })).statusCode).toBe(503);
    expect((await app.inject({ url: '/health/live' })).statusCode).toBe(200);
  });

  it('turns live false while the consumer is stuck or disconnected', async () => {
    const app = buildHealthApp(consumer(true, false), createMetrics(), logger);
    expect((await app.inject({ url: '/health/live' })).statusCode).toBe(503);
  });
});

describe('buildMetricsApp', () => {
  it('serves the Prometheus text', async () => {
    const res = await buildMetricsApp(createMetrics(), logger).inject({ url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toContain('mss_events_total');
  });
});
