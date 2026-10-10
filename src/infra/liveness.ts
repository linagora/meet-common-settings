// Disconnection is noticed when a probe asks, so it can be seen up to one probe
// period late.
export const createLiveness = ({
  isConnected,
  stuckAfterMs,
  disconnectedAfterMs,
  now = Date.now,
}: {
  isConnected: () => boolean;
  stuckAfterMs: number;
  disconnectedAfterMs: number;
  now?: () => number;
}) => {
  const running = new Map<object, number>();
  let disconnectedSince: number | undefined;
  let subscriptionsLost = false;

  return {
    track:
      <A extends unknown[], R>(handle: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        const attempt = {};
        running.set(attempt, now());
        try {
          return await handle(...args);
        } finally {
          running.delete(attempt);
        }
      },

    reconnected({ subscriptionsFailed }: { subscriptionsFailed: number }) {
      subscriptionsLost = subscriptionsFailed > 0;
    },

    isLive(): boolean {
      const at = now();
      disconnectedSince = isConnected() ? undefined : (disconnectedSince ?? at);
      if (subscriptionsLost) return false;
      if (disconnectedSince !== undefined && at - disconnectedSince > disconnectedAfterMs) {
        return false;
      }
      return [...running.values()].every((startedAt) => at - startedAt <= stuckAfterMs);
    },
  };
};
