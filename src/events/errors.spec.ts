import { DeadLetterError } from '@linagora/rabbitmq-client';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { dropMalformed, MalformedEventError, RejectedEventError } from './errors.js';

const logger = pino({ level: 'silent' });

describe('dropMalformed', () => {
  it('acks a malformed event', async () => {
    const handler = dropMalformed(async () => {
      throw new MalformedEventError('no payload');
    }, logger);
    await expect(handler()).resolves.toBeUndefined();
  });

  it('lets a rejected event through for the client to dead letter', async () => {
    const handler = dropMalformed(async () => {
      throw new RejectedEventError('refused');
    }, logger);
    await expect(handler()).rejects.toBeInstanceOf(RejectedEventError);
  });

  it('lets any other error through for the client to retry', async () => {
    const handler = dropMalformed(async () => {
      throw new Error('down');
    }, logger);
    await expect(handler()).rejects.toThrow('down');
  });
});

describe('RejectedEventError', () => {
  // The client recognises a dead letter by name, not by class.
  it('is named as the client expects', () => {
    const err = new RejectedEventError('refused');
    expect(err).toBeInstanceOf(DeadLetterError);
    expect(err.name).toBe('DeadLetterError');
  });
});
