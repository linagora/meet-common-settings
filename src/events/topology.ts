import { entitlementBindings, handleEntitlement } from '../modules/entitlements/handlers.js';
import { handleMessage, type HandlerDeps } from '../modules/settings/handlers.js';
import type { LintoClient } from '../product/port.js';
import { RejectedEventError } from './errors.js';
import type { Route } from './router.js';

export const QUEUE = 'meet-side-service';
export const DEAD_LETTER_EXCHANGE = `${QUEUE}.dlx`;
// Counts broker redeliveries, not the client's in-process attempts.
export const DELIVERY_LIMIT = 10;

const settings = { exchange: 'settings', routingKey: 'user.settings.updated' };

export const routesFor = (deps: HandlerDeps, linto: LintoClient | undefined): Route[] => [
  { ...settings, handle: (message) => handleMessage(message, deps) },
  ...entitlementBindings.map(
    (binding): Route => ({
      exchange: binding.exchange,
      routingKey: binding.routingKey,
      // A binding left from a run with entitlements on still brings events in.
      // Dead lettered, they can be replayed once LinTO is configured again.
      handle: linto
        ? (message, properties) =>
            handleEntitlement(binding, message, properties, { ...deps, linto })
        : async () => {
            throw new RejectedEventError('entitlements are disabled');
          },
    }),
  ),
];

export const bindingsFor = (linto: LintoClient | undefined) =>
  [settings, ...(linto ? entitlementBindings : [])].map(({ exchange, routingKey }) => ({
    exchange,
    routingKey,
  }));

// One queue per event before the service had its own, drained then deleted.
export const LEGACY_QUEUES = [
  { queue: 'meet.user_settings', ...settings },
  ...entitlementBindings.map(({ exchange, routingKey }) => ({
    queue: `meet.${routingKey}`,
    exchange,
    routingKey,
  })),
];
