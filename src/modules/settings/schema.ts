import { z } from 'zod';

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
  timestamp: z.number().optional(),
  version: z.number().optional(),
  payload: messagePayloadSchema,
});

export type MessageEnvelope = z.infer<typeof messageEnvelopeSchema>;
export type MessagePayload = z.infer<typeof messagePayloadSchema>;
