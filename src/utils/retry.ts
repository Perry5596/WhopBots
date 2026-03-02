import { logger } from "./logger.js";
import { sleep } from "./delay.js";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  label?: string;
}

const defaults: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  label: "operation",
};

/**
 * Retry an async function with exponential backoff + jitter.
 * Returns the result on success or throws the last error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, label } = { ...defaults, ...opts };

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;

      const expDelay = baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.random() * baseDelayMs;
      const delayMs = Math.min(expDelay + jitter, maxDelayMs);

      logger.warn(
        `${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${Math.round(delayMs)}ms`,
        { error: String(err) },
      );
      await sleep(delayMs);
    }
  }
  throw lastError;
}
