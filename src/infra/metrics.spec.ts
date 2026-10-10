import { describe, expect, it } from 'vitest';
import { createMetrics } from './metrics.js';

describe('createMetrics', () => {
  it('exposes the service metrics under the mss_ prefix', async () => {
    const metrics = createMetrics();
    metrics.observe('updated', 12);

    const names = (await metrics.registry.getMetricsAsJSON()).map((m) => m.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'mss_messages_processed_total',
        'mss_message_latency_seconds',
        'mss_db_errors_total',
        'mss_entitlement_calls_total',
      ]),
    );
    expect(names.some((n) => n.startsWith('mcs_'))).toBe(false);
  });
});
