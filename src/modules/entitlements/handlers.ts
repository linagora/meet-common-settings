import type { RabbitMQMessageProperties } from '@linagora/rabbitmq-client';
import { z } from 'zod';
import { MalformedEventError, RejectedEventError } from '../../events/errors.js';
import { hashEmail, type Logger } from '../../infra/logger.js';
import type { LintoClient } from '../../product/port.js';
import {
  domainOrganizationDeletedSchema,
  domainSubscriptionChangedSchema,
  domainUserDeletedSchema,
  subscriptionChangedSchema,
  userDeletedSchema,
} from './schema.js';

export interface EntitlementBinding<T = unknown> {
  exchange: string;
  routingKey: string;
  schema: z.ZodType<T>;
  // `ignored` is LinTO's order guard firing.
  apply(message: T, linto: LintoClient, updatedAt: string): Promise<{ ignored: boolean } | void>;
  subjectOf(message: T): string;
}

const binding = <T>(b: EntitlementBinding<T>): EntitlementBinding =>
  b as unknown as EntitlementBinding;

export const entitlementBindings: EntitlementBinding[] = [
  binding({
    exchange: 'billing',
    routingKey: 'subscription.changed',
    schema: subscriptionChangedSchema,
    apply: (m, linto, updatedAt) =>
      linto.putUser(m.internalEmail, {
        subject: m.twakeId,
        features: m.features.meet ?? {},
        updatedAt,
      }),
    subjectOf: (m) => m.internalEmail,
  }),
  binding({
    exchange: 'billing',
    routingKey: 'domain.subscription.changed',
    schema: domainSubscriptionChangedSchema,
    apply: (m, linto, updatedAt) =>
      linto.putDomain(m.domain, { features: m.features.meet ?? {}, updatedAt }),
    subjectOf: (m) => m.domain,
  }),
  binding({
    exchange: 'b2b',
    routingKey: 'domain.user.deleted',
    schema: domainUserDeletedSchema,
    apply: (m, linto) => linto.deleteUser(m.internalEmail),
    subjectOf: (m) => m.internalEmail,
  }),
  binding({
    exchange: 'auth',
    routingKey: 'user.deleted',
    schema: userDeletedSchema,
    apply: (m, linto) => linto.deleteUser(m.internalEmail),
    subjectOf: (m) => m.internalEmail,
  }),
  binding({
    exchange: 'b2b',
    routingKey: 'domain.organization.deleted',
    schema: domainOrganizationDeletedSchema,
    apply: (m, linto, updatedAt) => linto.putDomain(m.domain, { features: {}, updatedAt }),
    subjectOf: (m) => m.domain,
  }),
];

// amqplib decodes AMQP timestamp fields as { '!': 'timestamp', value: seconds }.
const xDeath = z.array(z.object({ time: z.object({ value: z.number() }) }).passthrough());

// Publish time when the publisher stamped one (dead-lettering keeps it), else
// the first death on a DLQ replay, else now. A replay must never send its own
// time, or LinTO's order guard would let an old message overwrite a newer one.
export const updatedAtOf = (
  { timestamp, headers }: Pick<RabbitMQMessageProperties, 'timestamp' | 'headers'>,
  now = Date.now(),
): string => {
  const deaths = xDeath.safeParse(headers['x-death']);
  const firstDeath =
    deaths.success && deaths.data.length > 0
      ? Math.min(...deaths.data.map((d) => d.time.value))
      : undefined;
  const seconds = timestamp ?? firstDeath;
  return new Date(seconds === undefined ? now : seconds * 1000).toISOString();
};

export interface EntitlementDeps {
  linto: LintoClient;
  logger: Logger;
}

export const handleEntitlement = async (
  { routingKey, schema, apply, subjectOf }: EntitlementBinding,
  message: unknown,
  properties: RabbitMQMessageProperties,
  { linto, logger }: EntitlementDeps,
): Promise<'applied' | 'stale'> => {
  const parsed = schema.safeParse(message);
  if (!parsed.success) {
    logger.error({ routingKey, issues: parsed.error.issues }, 'invalid entitlement message');
    throw new MalformedEventError(`invalid ${routingKey} message`);
  }

  const subjectHash = hashEmail(subjectOf(parsed.data));
  const updatedAt = updatedAtOf(properties);
  try {
    const result = await apply(parsed.data, linto, updatedAt);
    const ignored = result?.ignored === true;
    logger.info(
      { routingKey, subjectHash, updatedAt, ignored },
      ignored ? 'entitlement older than LinTO state; ignored' : 'entitlement applied',
    );
    return ignored ? 'stale' : 'applied';
  } catch (err) {
    const rejected = err instanceof RejectedEventError;
    logger.warn(
      { routingKey, subjectHash, err },
      rejected ? 'entitlement refused by LinTO; dead lettering' : 'entitlement call failed',
    );
    throw err;
  }
};
