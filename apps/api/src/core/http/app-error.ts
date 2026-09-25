import { ERROR_CODES, type ErrorCode, type ProblemFieldError } from '@ooh/contracts';

export interface AppErrorOptions {
  /** Overrides the default HTTP status of the code. */
  readonly status?: number;
  readonly errors?: readonly ProblemFieldError[];
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * Domain/application error with a stable code from the contract. Throw it anywhere; the
 * ProblemDetailsFilter turns it into an RFC 9457 response.
 *
 *   throw new AppError('INVALID_TRANSITION', 'Study is not READY', { meta: { allowedActions } });
 */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly options: AppErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.status = options.status ?? ERROR_CODES[code];
  }
}
