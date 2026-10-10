import { z } from 'zod';

const MAX_CLOCK_SKEW_MS = 60 * 60 * 1000;

export const messagePayloadSchema = z
  .object({
    language: z.string().min(1).max(20).optional(),
    timezone: z.string().min(1).max(64).optional(),
    avatar: z.string().optional(),
    last_name: z.string().optional(),
    first_name: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    matrix_id: z.string().nullable().optional(),
    display_name: z.string().optional(),
  })
  .passthrough();

export const messageEnvelopeSchema = z.object({
  source: z.string().optional(),
  nickname: z.string().optional(),
  request_id: z.string().optional(),
  // Publish time in ms, the event time the write to Meet is guarded by. One far
  // in the future would be stamped on the row and make every later event stale.
  timestamp: z
    .number()
    .int()
    .positive()
    .refine((t) => t <= Date.now() + MAX_CLOCK_SKEW_MS, 'timestamp is in the future'),
  version: z.number().optional(),
  payload: messagePayloadSchema,
});

export type MessageEnvelope = z.infer<typeof messageEnvelopeSchema>;
export type MessagePayload = z.infer<typeof messagePayloadSchema>;
