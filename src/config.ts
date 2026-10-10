import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();

// A chart that templates an unset value renders it as "", which must not fail
// validation while the feature that needs it is off.
const unsetWhenEmpty = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

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
  RABBITMQ_PREFETCH: positiveInt.default(1),
  RABBITMQ_MAX_RETRIES: positiveInt.default(20),
  RABBITMQ_RETRY_DELAY: positiveInt.default(1000),
  RABBITMQ_MAX_RETRY_DELAY: positiveInt.default(60_000),

  DATABASE_URL: z.string().min(1),
  MEET_USER_TABLE: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'MEET_USER_TABLE must be a valid SQL identifier')
    .default('meet_user'),

  LANGUAGE_MAP_OVERRIDES: languageOverridesSchema,

  // Not z.coerce.boolean(): it reads the string "false" as true.
  ENTITLEMENTS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  LINTO_STUDIO_API_URL: unsetWhenEmpty(z.string().url()),
  LINTO_ENTITLEMENTS_TOKEN: unsetWhenEmpty(z.string().min(1)),
  LINTO_TWAKE_ORG_ID: unsetWhenEmpty(z.string().min(1)),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  HEALTH_PORT: positiveInt.default(8080),
  SHUTDOWN_TIMEOUT_MS: positiveInt.default(10_000),
});

const lintoKeys = [
  'LINTO_STUDIO_API_URL',
  'LINTO_ENTITLEMENTS_TOKEN',
  'LINTO_TWAKE_ORG_ID',
] as const;

const configSchema = envSchema.superRefine((env, ctx) => {
  if (!env.ENTITLEMENTS_ENABLED) return;
  for (const key of lintoKeys) {
    if (env[key] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: 'required when ENTITLEMENTS_ENABLED=true',
      });
    }
  }
});

export type Config = z.infer<typeof envSchema>;

export const loadConfig = (env: Record<string, string | undefined> = process.env): Config => {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return result.data;
};
