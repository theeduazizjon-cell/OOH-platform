/**
 * API error contract: RFC 9457 problem details with a stable machine-readable `code`.
 * See docs/architecture/10-api.md.
 */

export const ERROR_CODES = {
  VALIDATION_FAILED: 422,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  /** Access token expired or permissions changed: the client should refresh and retry. */
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  NO_ACTIVE_MEMBERSHIP: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  BOOKING_CONFLICT: 409,
  TARIFF_DUPLICATE: 409,
  TARIFF_AMBIGUOUS: 409,
  DUPLICATE_SUSPECTED: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ProblemFieldError {
  /** Dotted path to the offending field, e.g. `lines.0.city`. */
  readonly path: string;
  readonly message: string;
}

export interface ProblemDetails {
  /** URI reference identifying the problem type. */
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: ErrorCode;
  readonly detail?: string;
  readonly instance?: string;
  readonly errors?: readonly ProblemFieldError[];
  /** Correlates with server logs and the `x-request-id` response header. */
  readonly requestId?: string;
  /** Extra machine-readable context (e.g. allowed actions, conflicting record ids). */
  readonly meta?: Readonly<Record<string, unknown>>;
}

export const PROBLEM_TYPE_BASE = 'https://errors.ooh-platform.dev/';

export function problemType(code: ErrorCode): string {
  return PROBLEM_TYPE_BASE + code.toLowerCase().replace(/_/g, '-');
}
