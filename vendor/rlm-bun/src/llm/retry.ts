/**
 * Reusable retry utility with exponential backoff.
 */

export interface RetryOptions {
  /** Maximum number of attempts (default: 3). */
  maxAttempts?: number;
  /** Base delay in ms before first retry (default: 500). */
  baseDelayMs?: number;
  /** HTTP status codes that trigger a retry (default: [429, 529]). */
  retryOn?: number[];
  /** Custom predicate — if provided, errors matching this are also retried. */
  shouldRetry?: (err: unknown) => boolean | Promise<boolean>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute `fn` with automatic retry on transient failures.
 *
 * Uses exponential backoff: delay = baseDelayMs × 2^(attempt-1).
 * Only retries when the error has a `.status` or `.statusCode` matching `retryOn`.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 500, retryOn = [429, 529], shouldRetry } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (attempt === maxAttempts) throw err;

      const status: number | undefined = err?.status ?? err?.statusCode;
      const statusRetryable = status != null && retryOn.includes(status);
      const predicateRetryable = shouldRetry ? await shouldRetry(err) : false;

      if (!statusRetryable && !predicateRetryable) throw err;

      const delay = baseDelayMs * 2 ** (attempt - 1);
      await sleep(delay);
    }
  }

  // Unreachable — the loop either returns or throws.
  throw new Error("withRetry: unreachable");
}
