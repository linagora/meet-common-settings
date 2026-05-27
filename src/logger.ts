import pino from 'pino';
import { createHash } from 'node:crypto';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'meet-common-settings' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export type Logger = typeof logger;

export const hashEmail = (email: string): string =>
  createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16);
