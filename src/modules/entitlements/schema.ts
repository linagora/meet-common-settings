import { z } from 'zod';

// The Cloudery publishes every app it enables under `features`; only `meet` is ours.
const planFeatures = z.object({ meet: z.record(z.unknown()).optional() }).passthrough();

export const subscriptionChangedSchema = z.object({
  twakeId: z.string().min(1),
  internalEmail: z.string().email(),
  features: planFeatures,
});

export const domainSubscriptionChangedSchema = z.object({
  domain: z.string().min(1),
  features: planFeatures,
});

export const domainUserDeletedSchema = z.object({ internalEmail: z.string().email() });

export const userDeletedSchema = z.object({ internalEmail: z.string().email() });

export const domainOrganizationDeletedSchema = z.object({ domain: z.string().min(1) });
