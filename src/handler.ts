import type { DbClient, UserSettingsUpdate } from './db.js';
import type { LanguageMapper } from './language.js';
import type { Logger } from './logger.js';
import { hashEmail } from './logger.js';
import type { Metrics, Outcome } from './metrics.js';
import { messageEnvelopeSchema } from './schema.js';

export type HandlerResult =
  | { status: 'ok'; outcome: Exclude<Outcome, 'db_error'> }
  | { status: 'transient_error'; error: Error };

export interface HandlerDeps {
  db: DbClient;
  mapLanguage: LanguageMapper;
  logger: Logger;
  metrics: Metrics;
}

const isTransientError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  // Postgres class 08 = connection exceptions, 53 = insufficient resources,
  // 57 = operator intervention, 40 = transaction rollback/serialization
  if (typeof code === 'string') {
    if (code.startsWith('08') || code.startsWith('53') || code.startsWith('57')) return true;
    if (code === '40001' || code === '40P01') return true;
  }
  if (
    err.message.includes('ECONNREFUSED') ||
    err.message.includes('ETIMEDOUT') ||
    err.message.includes('ECONNRESET')
  ) {
    return true;
  }
  return false;
};

export const handleMessage = async (
  rawMessage: unknown,
  { db, mapLanguage, logger, metrics }: HandlerDeps,
): Promise<HandlerResult> => {
  const startedAt = Date.now();
  const finish = (
    outcome: Exclude<Outcome, 'db_error' | 'unexpected_error'>,
  ): HandlerResult => {
    metrics.observe(outcome, Date.now() - startedAt);
    return { status: 'ok', outcome };
  };

  const parsed = messageEnvelopeSchema.safeParse(rawMessage);
  if (!parsed.success) {
    logger.error({ issues: parsed.error.issues }, 'invalid message envelope');
    metrics.observe('invalid_payload', Date.now() - startedAt);
    return { status: 'ok', outcome: 'invalid_payload' };
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
        'language code has no Django mapping; skipping language update',
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
      logger.info(
        { requestId, version, emailHash, latencyMs },
        'no Meet user matched; skipping',
      );
      metrics.observe('unknown_user', latencyMs);
      return { status: 'ok', outcome: 'unknown_user' };
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
    metrics.observe('updated', latencyMs);
    return { status: 'ok', outcome: 'updated' };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    metrics.dbErrors.inc();
    const errCode = (error as { code?: string }).code;
    if (isTransientError(error)) {
      logger.warn(
        { requestId, version, emailHash, err: { message: error.message, code: errCode } },
        'transient database error; throwing so the broker client retries with backoff (DLQ after max retries)',
      );
      metrics.observe('db_error', Date.now() - startedAt);
      return { status: 'transient_error', error };
    }
    logger.error(
      { requestId, version, emailHash, err: { message: error.message, code: errCode } },
      'permanent database error; acking to avoid poison-message loop',
    );
    metrics.observe('unexpected_error', Date.now() - startedAt);
    return { status: 'ok', outcome: 'unexpected_error' };
  }
};
