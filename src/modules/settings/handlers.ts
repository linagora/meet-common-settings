import { MalformedEventError, RejectedEventError } from '../../events/errors.js';
import type { Logger } from '../../infra/logger.js';
import { hashEmail } from '../../infra/logger.js';
import type { Metrics, Outcome } from '../../infra/metrics.js';
import type { DbClient, UserSettingsUpdate } from '../../product/port.js';
import type { LanguageMapper } from './language.js';
import { messageEnvelopeSchema } from './schema.js';

type Applied = Exclude<Outcome, 'invalid_payload' | 'db_error' | 'rejected'>;

export interface HandlerDeps {
  db: DbClient;
  mapLanguage: LanguageMapper;
  logger: Logger;
  metrics: Metrics;
}

// Only an error Postgres answered can be permanent. Network errors and timeouts
// are retried. SQLSTATE class 08 = connection exceptions, 53 = insufficient
// resources, 57 = operator intervention (statement timeout included),
// 40001/40P01 = serialization failure and deadlock.
const isPermanentError = (err: Error): boolean => {
  const { code } = err as { code?: unknown };
  if (err.name !== 'PostgresError' || typeof code !== 'string') return false;
  return !(/^(08|53|57)/.test(code) || code === '40001' || code === '40P01');
};

export const handleMessage = async (
  rawMessage: unknown,
  { db, mapLanguage, logger, metrics }: HandlerDeps,
): Promise<Applied> => {
  const startedAt = Date.now();
  const finish = <O extends Outcome>(outcome: O): O => {
    metrics.observe(outcome, Date.now() - startedAt);
    return outcome;
  };

  const parsed = messageEnvelopeSchema.safeParse(rawMessage);
  if (!parsed.success) {
    logger.error({ issues: parsed.error.issues }, 'invalid message envelope');
    finish('invalid_payload');
    throw new MalformedEventError('invalid settings message');
  }

  const envelope = parsed.data;
  const { payload } = envelope;
  const requestId = envelope.request_id;
  const version = envelope.version;

  if (!payload.email) {
    logger.warn({ requestId, version }, 'message missing email; cannot match user');
    return finish('no_email');
  }

  const updates: UserSettingsUpdate = {};
  if (payload.language) {
    const mapped = mapLanguage(payload.language);
    if (mapped) {
      updates.language = mapped;
    } else {
      logger.info(
        { requestId, version, input: payload.language },
        'language code has no Meet backend mapping; skipping language update',
      );
    }
  }
  if (payload.timezone) {
    updates.timezone = payload.timezone;
  }

  if (updates.language === undefined && updates.timezone === undefined) {
    logger.info({ requestId, version }, 'no syncable fields in payload');
    return finish('no_syncable_fields');
  }

  const emailHash = hashEmail(payload.email);

  try {
    const rowCount = await db.updateUserSettings(payload.email, updates);
    const latencyMs = Date.now() - startedAt;
    if (rowCount === 0) {
      logger.info({ requestId, version, emailHash, latencyMs }, 'no Meet user matched; skipping');
      return finish('unknown_user');
    }
    logger.info(
      {
        requestId,
        version,
        emailHash,
        latencyMs,
        rowCount,
        languageUpdated: updates.language !== undefined,
        timezoneUpdated: updates.timezone !== undefined,
      },
      'user settings updated',
    );
    return finish('updated');
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    metrics.dbErrors.inc();
    const errCode = (error as { code?: string }).code;
    if (isPermanentError(error)) {
      logger.error(
        { requestId, version, emailHash, err: { message: error.message, code: errCode } },
        'permanent database error; dead lettering',
      );
      finish('rejected');
      throw new RejectedEventError(error.message, { cause: error });
    }
    logger.warn(
      { requestId, version, emailHash, err: { message: error.message, code: errCode } },
      'transient database error; retrying',
    );
    finish('db_error');
    throw error;
  }
};
