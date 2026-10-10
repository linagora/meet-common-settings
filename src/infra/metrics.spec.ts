import { describe, expect, it } from 'vitest';
import { createMetrics } from './metrics.js';

const values = async (metrics: ReturnType<typeof createMetrics>, name: string) =>
  (await metrics.registry.getSingleMetric(name)!.get()).values;

describe('createMetrics', () => {
  it('counts events by origin and outcome', async () => {
    const metrics = createMetrics();
    metrics.event({ exchange: 'auth', routingKey: 'user.deleted' }, 'handled');

    expect(await values(metrics, 'mss_events_total')).toEqual([
      { value: 1, labels: { exchange: 'auth', routing_key: 'user.deleted', outcome: 'handled' } },
    ]);
  });

  it('times product calls by result', async () => {
    const metrics = createMetrics();
    const ok = metrics.timed('linto.put_user', async (n: number) => n + 1);
    const failing = metrics.timed('linto.put_user', async () => {
      throw new Error('down');
    });

    expect(await ok(1)).toBe(2);
    await expect(failing()).rejects.toThrow('down');

    const text = await metrics.registry.metrics();
    expect(text).toContain(
      'mss_product_call_duration_seconds_count{call="linto.put_user",result="ok"} 1',
    );
    expect(text).toContain(
      'mss_product_call_duration_seconds_count{call="linto.put_user",result="error"} 1',
    );
  });
});
