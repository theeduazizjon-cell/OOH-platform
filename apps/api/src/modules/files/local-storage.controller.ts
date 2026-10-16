import { Controller, Get, Inject, Put, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../core/auth/principal';
import { LOCAL_STORAGE_PATH, LocalFileStorage } from '../../core/files/local-storage';
import { FILE_STORAGE, type FileStorage } from '../../core/files/storage';
import { AppError } from '../../core/http/app-error';

/**
 * Development stand-in for presigned S3 URLs (FILE_STORAGE=local): the signed token is the only
 * authorisation, exactly like a presigned URL. Not routed when files live in S3.
 */
@Controller(LOCAL_STORAGE_PATH)
export class LocalStorageController {
  constructor(@Inject(FILE_STORAGE) private readonly storage: FileStorage) {}

  @Public()
  @Put()
  async put(
    @Query('token') token: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const local = this.local();
    const grant = token ? local.verify(token, 'PUT') : null;
    if (!grant) throw new AppError('FORBIDDEN', 'The upload link is invalid or has expired.');
    if (request.headers['content-type'] !== grant.t) {
      throw new AppError('BAD_REQUEST', `Send the file with content-type ${grant.t}.`);
    }
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length !== grant.s) {
      throw new AppError('BAD_REQUEST', `Send exactly ${grant.s} bytes.`);
    }
    await local.write(grant.k, body);
    await reply.status(200).send();
  }

  @Public()
  @Get()
  async get(@Query('token') token: string | undefined, @Res() reply: FastifyReply): Promise<void> {
    const local = this.local();
    const grant = token ? local.verify(token, 'GET') : null;
    if (!grant) throw new AppError('FORBIDDEN', 'The download link is invalid or has expired.');
    const body = await local.read(grant.k);
    await reply
      .header('content-type', grant.t)
      .header('content-disposition', local.disposition(grant))
      .header('cache-control', 'private, max-age=300')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(body);
  }

  private local(): LocalFileStorage {
    if (!(this.storage instanceof LocalFileStorage)) throw new AppError('NOT_FOUND', 'Not found.');
    return this.storage;
  }
}
