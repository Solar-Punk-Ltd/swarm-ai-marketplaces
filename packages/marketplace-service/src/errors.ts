import type { Response } from 'express';
import type { ApiError } from '@solarpunk/swarm-catalog';

// Error codes of the review endpoints (CLAUDE.md "Marketplace service endpoints"). Each maps to a
// fixed HTTP status and retryable flag.
export type ErrorCode =
  | 'bad_request'
  | 'bad_request_signature'
  | 'request_expired'
  | 'too_many_chunks'
  | 'pop_invalid'
  | 'pop_already_claimed'
  | 'envelope_quota_exceeded'
  | 'batch_unavailable'
  | 'internal_error';

interface CodeSpec {
  status: number;
  retryable: boolean;
}

const CODES: Record<ErrorCode, CodeSpec> = {
  bad_request: { status: 400, retryable: false },
  bad_request_signature: { status: 401, retryable: false },
  // Retryable: sign a fresh request.
  request_expired: { status: 400, retryable: true },
  too_many_chunks: { status: 413, retryable: false },
  pop_invalid: { status: 403, retryable: false },
  pop_already_claimed: { status: 409, retryable: false },
  // Not retryable here; the buyer can still self-fund storage with its own batch.
  envelope_quota_exceeded: { status: 429, retryable: false },
  // The seller's batch is being bought; retry after details.retryAfter seconds.
  batch_unavailable: { status: 503, retryable: true },
  internal_error: { status: 500, retryable: true },
};

export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.status = CODES[code].status;
    this.retryable = CODES[code].retryable;
    this.details = details;
  }

  toApiError(): ApiError {
    return {
      error: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      retryable: this.retryable,
    };
  }
}

export function sendError(res: Response, err: unknown): void {
  if (err instanceof ServiceError) {
    if (err.code === 'batch_unavailable' && typeof err.details?.retryAfter === 'number') {
      res.setHeader('Retry-After', String(err.details.retryAfter));
    }
    res.status(err.status).json(err.toApiError());
    return;
  }
  const internal = new ServiceError(
    'internal_error',
    err instanceof Error ? err.message : 'Unspecified server failure',
  );
  res.status(internal.status).json(internal.toApiError());
}
