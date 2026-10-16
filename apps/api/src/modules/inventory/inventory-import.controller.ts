import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import {
  type ImportPreview,
  importPreviewRequestSchema,
  importRequestSchema,
  type ImportResult,
} from '@ooh/contracts';
import type { FastifyRequest } from 'fastify';
import { CurrentPrincipal, type Principal, RequirePermission } from '../../core/auth/principal';
import { clientInfo } from '../../core/http/client-info';
import { parseWith } from '../../core/http/validation';
import { InventoryImportService } from './inventory-import.service';

/** Inventory CSV import (docs/architecture/10-api.md "Inventory"): check every row, then create all or nothing. */
@Controller('assets/import')
export class InventoryImportController {
  constructor(private readonly imports: InventoryImportService) {}

  @Post('preview')
  @HttpCode(200)
  @RequirePermission('asset.create')
  preview(@CurrentPrincipal() principal: Principal, @Body() body: unknown): Promise<ImportPreview> {
    return this.imports.preview(principal, parseWith(importPreviewRequestSchema, body).csv);
  }

  @Post()
  @RequirePermission('asset.create')
  import(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<ImportResult> {
    return this.imports.import(principal, parseWith(importRequestSchema, body), clientInfo(request));
  }
}
