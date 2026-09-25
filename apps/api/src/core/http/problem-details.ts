import { HttpException, HttpStatus } from '@nestjs/common';
import { type ErrorCode, type ProblemDetails, type ProblemFieldError, problemType } from '@ooh/contracts';
import { ZodError } from 'zod';
import { AppError } from './app-error';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 412:
      return 'PRECONDITION_FAILED';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 422:
      return 'VALIDATION_FAILED';
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= 400 && status < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR';
  }
}

function build(
  status: number,
  code: ErrorCode,
  detail: string | undefined,
  extra: Partial<ProblemDetails> = {},
): ProblemDetails {
  return {
    type: problemType(code),
    title: TITLES[status] ?? (status >= 500 ? 'Server Error' : 'Client Error'),
    status,
    code,
    ...(detail ? { detail } : {}),
    ...extra,
  };
}

function zodFieldErrors(error: ZodError): ProblemFieldError[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
}

/** Fastify's own errors (malformed JSON, body too large, …) carry a 4xx `statusCode`. */
function isFrameworkClientError(error: unknown): error is { statusCode: number; message: string } {
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
}

/**
 * Maps any thrown value to RFC 9457 problem details. Unknown errors become a generic 500 and
 * never expose internal messages to the client (they are logged instead).
 */
export function toProblemDetails(error: unknown): ProblemDetails {
  if (error instanceof AppError) {
    return build(error.status, error.code, error.message, {
      ...(error.options.errors ? { errors: error.options.errors } : {}),
      ...(error.options.meta ? { meta: error.options.meta } : {}),
    });
  }
  if (error instanceof ZodError) {
    return build(422, 'VALIDATION_FAILED', 'The request is invalid.', { errors: zodFieldErrors(error) });
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return build(status, codeForStatus(status), status >= 500 ? undefined : error.message);
  }
  if (isFrameworkClientError(error)) {
    return build(error.statusCode, codeForStatus(error.statusCode), error.message);
  }
  return build(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'An unexpected error occurred.');
}
