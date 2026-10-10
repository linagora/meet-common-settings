import { MalformedEventError, RejectedEventError } from '../../events/errors.js';
import type { Logger } from '../../infra/logger.js';
import { hashEmail } from '../../infra/logger.js';
import type { DbClient, SettingsWrite, UserSettingsUpdate } from '../../product/port.js';
import type { LanguageMapper } from './language.js';
import { messageEnvelopeSchema } from './schema.js';

export interface HandlerDeps {
  db: DbClient;
  mapLanguage: LanguageMapper;
  logger: Logger;
}

// Permanent: SQLSTATE class 22 (data exception), 23 (integrity constraint) and
// 42 (undefined column, missing grant). Anything else, a failover or a timeout
// included, is retried. A driver error may come wrapped in its cause.
const isPermanentError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  const { code } = err as { code?: unknown };
  if (err.name === 'PostgresError' && typeof code === 'string') return /^(22|23|42)/.test(code);
  return isPermanentError(err.cause);
};

export const handleMessage = async (
  rawMessage: unknown,
  { db, mapLanguage, logger }: HandlerDeps,
): Promise<SettingsWrite | 'no_syncable_fields'> => {
  const startedAt = Date.now();

  const parsed = messageEnvelopeSchema.safeParse(rawMessage);
  if (!parsed.success) {
    logger.error({ issues: parsed.error.issues }, 'invalid message envelope');
    throw new MalformedEventError('invalid settings message');
  }

  const envelope = parsed.data;
  const { payload } = envelope;
  const requestId = envelope.request_id;
  const version = envelope.version;

  if (!payload.email) {
    logger.warn({ requestId, version }, 'message missing email; cannot match user');
    throw new MalformedEventError('settings message without email');
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
    return 'no_syncable_fields';
  }

  const emailHash = hashEmail(payload.email);

  try {
    const write = await db.updateUserSettings(payload.email, updates, new Date(envelope.timestamp));
    const latencyMs = Date.now() - startedAt;
    if (write === 'unknown_user') {
      logger.info({ requestId, version, emailHash, latencyMs }, 'no Meet user matched; skipping');
    } else if (write === 'stale') {
      logger.info(
        { requestId, version, emailHash, latencyMs },
        'Meet user changed since; skipping',
      );
    } else {
      logger.info(
        {
          requestId,
          version,
          emailHash,
          latencyMs,
          languageUpdated: updates.language !== undefined,
          timezoneUpdated: updates.timezone !== undefined,
        },
        'user settings updated',
      );
    }
    return write;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const errCode = (error as { code?: string }).code;
    if (isPermanentError(error)) {
      logger.error(
        { requestId, version, emailHash, err: { message: error.message, code: errCode } },
        'permanent database error; dead lettering',
      );
      throw new RejectedEventError(error.message, { cause: error });
    }
    logger.warn(
      { requestId, version, emailHash, err: { message: error.message, code: errCode } },
      'transient database error; retrying',
    );
    throw error;
  }
};
