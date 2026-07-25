/**
 * Shared error types for LLM clients.
 *
 * Structured error hierarchy so callers can distinguish auth failures
 * from rate limits from generic API errors.
 */

/** Credential format is invalid (e.g. placeholder key, wrong prefix). */
export class InvalidCredentialError extends Error {
  constructor(source: string) {
    super(`Credential from "${source}" has invalid format`);
    this.name = "InvalidCredentialError";
  }
}

/** No valid credentials were found across all resolution sources. */
export class CredentialNotFoundError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "No valid credentials found. Set ANTHROPIC_API_KEY or log in with Claude Code CLI."
    );
    this.name = "CredentialNotFoundError";
  }
}

/** 401/403 — credentials were rejected by the API. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** 429 — too many requests; caller should retry after delay. */
export class RateLimitError extends Error {
  readonly retryAfter?: number;

  constructor(message: string, retryAfter?: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

/** OAuth token expired — SDK returned "Invalid API key" in a result error. */
export class OAuthExpiredError extends Error {
  readonly oauthExpired = true;

  constructor(message: string) {
    super(message);
    this.name = "OAuthExpiredError";
  }
}

/** Any non-auth, non-rate-limit HTTP error from the API. */
export class APIError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "APIError";
    this.statusCode = statusCode;
  }
}

/**
 * Inspect an SDK/fetch error and re-throw as a structured error type.
 * Falls through to re-throwing the original error if it can't be classified.
 */
export function wrapSDKError(err: unknown): never {
  if (err instanceof AuthError || err instanceof RateLimitError || err instanceof APIError || err instanceof OAuthExpiredError) {
    throw err; // already wrapped
  }

  if (err instanceof Error) {
    const status = (err as any).status ?? (err as any).statusCode;
    if (status === 401 || status === 403) throw new AuthError(err.message);
    if (status === 429) {
      const retryAfter = (err as any).headers?.["retry-after"]
        ? Number((err as any).headers["retry-after"])
        : undefined;
      throw new RateLimitError(err.message, retryAfter);
    }
    if (typeof status === "number" && status >= 400) {
      throw new APIError(err.message, status);
    }
  }

  throw err;
}
