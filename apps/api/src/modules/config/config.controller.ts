import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  type ClassificationItem,
  createClassificationRequestSchema,
  type Page,
  updateClassificationRequestSchema,
} from '@ooh/contracts';
import type { FastifyRequest } from 'fastify';
import { CurrentPrincipal, type Principal, RequirePermission } from '../../core/auth/principal';
import { clientInfo } from '../../core/http/client-info';
import { type IfMatch, IfMatchHeader, VersionEtagInterceptor } from '../../core/http/concurrency';
import { parseWith } from '../../core/http/validation';
import { ClassificationsService } from './classifications.service';

/** Nomenclatures (docs/architecture/10-api.md: GET/POST/PATCH /config/{…}). */
@Controller('config')
@UseInterceptors(VersionEtagInterceptor)
export class ConfigController {
  constructor(private readonly classifications: ClassificationsService) {}

  @Get('classifications')
  @RequirePermission('config.read')
  listClassifications(@CurrentPrincipal() principal: Principal): Promise<Page<ClassificationItem>> {
    return this.classifications.list(principal);
  }

  @Post('classifications')
  @RequirePermission('config.manage')
  createClassification(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<ClassificationItem> {
    return this.classifications.create(
      principal,
      parseWith(createClassificationRequestSchema, body),
      clientInfo(request),
    );
  }

  @Patch('classifications/:id')
  @RequirePermission('config.manage')
  updateClassification(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<ClassificationItem> {
    return this.classifications.update(
      principal,
      id,
      parseWith(updateClassificationRequestSchema, body),
      ifMatch,
      clientInfo(request),
    );
  }
}
