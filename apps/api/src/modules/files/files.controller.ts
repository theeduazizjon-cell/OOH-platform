import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  createUploadRequestSchema,
  type FileItem,
  type FileLinkItem,
  fileListQuerySchema,
  fileUrlQuerySchema,
  type UploadTicket,
} from '@ooh/contracts';
import type { FastifyRequest } from 'fastify';
import { CurrentPrincipal, type Principal } from '../../core/auth/principal';
import { clientInfo } from '../../core/http/client-info';
import { parseWith } from '../../core/http/validation';
import { FilesService } from './files.service';

/**
 * Files (docs/architecture/10-api.md "Files"). No permission of their own: every route checks the
 * record the file is (or will be) attached to, through the policy its module registered.
 */
@Controller()
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post('files/uploads')
  createUpload(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<UploadTicket> {
    return this.files.createUpload(
      principal,
      parseWith(createUploadRequestSchema, body),
      clientInfo(request),
    );
  }

  @Post('files/:id/complete')
  @HttpCode(202)
  complete(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: FastifyRequest,
  ): Promise<FileItem> {
    return this.files.complete(principal, id, clientInfo(request));
  }

  @Get('files')
  list(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<FileLinkItem[]> {
    const { subjectType, subjectId, purpose } = parseWith(fileListQuerySchema, query);
    return this.files.list(principal, subjectType, subjectId, purpose);
  }

  @Get('files/:id/url')
  url(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ): Promise<{ url: string; expiresAt: string }> {
    return this.files.url(principal, id, parseWith(fileUrlQuerySchema, query).variant);
  }

  @Delete('file-links/:id')
  @HttpCode(204)
  unlink(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    return this.files.unlink(principal, id, clientInfo(request));
  }
}
