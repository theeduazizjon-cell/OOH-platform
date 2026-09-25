import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { toProblemDetails } from './problem-details';

/** Global filter: every error response is `application/problem+json` with a request id. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const problem = { ...toProblemDetails(exception), instance: request.url, requestId: request.id };

    if (problem.status >= 500) {
      this.logger.error(
        { err: exception, requestId: request.id },
        `Unhandled error on ${request.method} ${request.url}`,
      );
    }
    void reply.status(problem.status).header('content-type', 'application/problem+json').send(problem);
  }
}
