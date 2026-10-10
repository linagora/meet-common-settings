import { describe, expect, it } from 'vitest';
import { createLiveness } from './liveness.js';

const setup = () => {
  const clock = { now: 0, connected: true };
  const liveness = createLiveness({
    isConnected: () => clock.connected,
    stuckAfterMs: 1000,
    disconnectedAfterMs: 5000,
    now: () => clock.now,
  });
  return { clock, liveness };
};

describe('createLiveness', () => {
  it('is live while connected and nothing runs too long', async () => {
    const { clock, liveness } = setup();
    await liveness.track(async () => {
      clock.now = 1000;
    })();
    clock.now = 50_000;
    expect(liveness.isLive()).toBe(true);
  });

  it('is not live while a handler runs longer than allowed', async () => {
    const { clock, liveness } = setup();
    let finish!: () => void;
    const running = liveness.track(() => new Promise<void>((resolve) => (finish = resolve)))();
    clock.now = 1001;
    expect(liveness.isLive()).toBe(false);
    finish();
    await running;
    expect(liveness.isLive()).toBe(true);
  });

  it('forgets a handler that failed', async () => {
    const { clock, liveness } = setup();
    await expect(
      liveness.track(async () => {
        throw new Error('down');
      })(),
    ).rejects.toThrow('down');
    clock.now = 50_000;
    expect(liveness.isLive()).toBe(true);
  });

  it('is not live once disconnected longer than allowed', () => {
    const { clock, liveness } = setup();
    clock.connected = false;
    expect(liveness.isLive()).toBe(true);
    clock.now = 5000;
    expect(liveness.isLive()).toBe(true);
    clock.now = 5001;
    expect(liveness.isLive()).toBe(false);
    clock.connected = true;
    expect(liveness.isLive()).toBe(true);
  });

  it('is not live while a reconnect left a subscription lost', () => {
    const { liveness } = setup();
    liveness.reconnected({ subscriptionsFailed: 1 });
    expect(liveness.isLive()).toBe(false);
    liveness.reconnected({ subscriptionsFailed: 0 });
    expect(liveness.isLive()).toBe(true);
  });
});
