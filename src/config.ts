import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();

const languageOverridesSchema = z
  .string()
  .default('{}')
  .transform((raw, ctx) => {
    try {
      const parsed = JSON.parse(raw);
      const result = z.record(z.string()).safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'LANGUAGE_MAP_OVERRIDES must be a JSON object of string→string',
        });
        return z.NEVER;
      }
      return result.data;
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'LANGUAGE_MAP_OVERRIDES must be valid JSON',
      });
      return z.NEVER;
    }
  });

const envSchema = z.object({
  RABBITMQ_URL: z.string().min(1),
  RABBITMQ_EXCHANGE: z.string().default('settings'),
  RABBITMQ_ROUTING_KEY: z.string().default('user.settings.updated'),
  RABBITMQ_QUEUE: z.string().default('meet.user_settings'),
  RABBITMQ_PREFETCH: positiveInt.default(1),
  RABBITMQ_MAX_RETRIES: positiveInt.default(5),
  RABBITMQ_RETRY_DELAY: positiveInt.default(1000),

  DATABASE_URL: z.string().min(1),
  MEET_USER_TABLE: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'MEET_USER_TABLE must be a valid SQL identifier')
    .default('meet_user'),

  LANGUAGE_MAP_OVERRIDES: languageOverridesSchema,

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  HEALTH_PORT: positiveInt.default(8080),
  SHUTDOWN_TIMEOUT_MS: positiveInt.default(10_000),
});

export type Config = z.infer<typeof envSchema>;

export const loadConfig = (env: Record<string, string | undefined> = process.env): Config => {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return result.data;
};
