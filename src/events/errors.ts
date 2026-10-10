import { DeadLetterError } from '@linagora/rabbitmq-client';

// An event that can never be processed: logged by the handler, then dropped.
export class MalformedEventError extends Error {
  override name = 'MalformedEventError';
}

// A well-formed event the product refuses for good: dead lettered at once.
// It keeps DeadLetterError's name, which is what the client matches on.
export class RejectedEventError extends DeadLetterError {}

export const dropMalformed =
  <A extends unknown[]>(handler: (...args: A) => Promise<unknown>) =>
  async (...args: A): Promise<void> => {
    try {
      await handler(...args);
    } catch (err) {
      if (!(err instanceof MalformedEventError)) throw err;
    }
  };
