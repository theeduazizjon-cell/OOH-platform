import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  type AssetDetail,
  type AssetLifecycleAction,
  type AssetListItem,
  assetListQuerySchema,
  assetReasonSchema,
  type AssetTypeItem,
  closeTermsRequestSchema,
  createAssetRequestSchema,
  createBlockRequestSchema,
  createTermsRequestSchema,
  type DimensionPresetItem,
  mountRequestSchema,
  type Page,
  updateAssetRequestSchema,
  updateFaceRequestSchema,
} from '@ooh/contracts';
import type { FastifyRequest } from 'fastify';
import { CurrentPrincipal, type Principal, RequirePermission } from '../../core/auth/principal';
import { clientInfo } from '../../core/http/client-info';
import { type IfMatch, IfMatchHeader, VersionEtagInterceptor } from '../../core/http/concurrency';
import { parseWith } from '../../core/http/validation';
import { InventoryService } from './inventory.service';

/** Inventory configuration (read): asset types (templates) and face sizes. */
@Controller('config')
export class InventoryConfigController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('asset-types')
  @RequirePermission('asset.read')
  assetTypes(@CurrentPrincipal() principal: Principal): Promise<AssetTypeItem[]> {
    return this.inventory.assetTypes(principal);
  }

  @Get('dimension-presets')
  @RequirePermission('asset.read')
  dimensionPresets(@CurrentPrincipal() principal: Principal): Promise<DimensionPresetItem[]> {
    return this.inventory.dimensionPresets(principal);
  }
}

/**
 * Assets (docs/architecture/10-api.md "Inventory"): CRUD, lifecycle actions, mounts, faces, terms and
 * blocks. Changes to an asset or its parts send If-Match with the version of what they change.
 */
@Controller()
@UseInterceptors(VersionEtagInterceptor)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('assets')
  @RequirePermission('asset.read')
  list(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<AssetListItem>> {
    return this.inventory.list(principal, parseWith(assetListQuerySchema, query));
  }

  @Get('assets/:id')
  @RequirePermission('asset.read')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AssetDetail> {
    return this.inventory.get(principal, id);
  }

  @Post('assets')
  @RequirePermission('asset.create')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AssetDetail> {
    return this.inventory.create(principal, parseWith(createAssetRequestSchema, body), clientInfo(request));
  }

  @Patch('assets/:id')
  @RequirePermission('asset.update')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<AssetDetail> {
    return this.inventory.update(
      principal,
      id,
      parseWith(updateAssetRequestSchema, body),
      ifMatch,
      clientInfo(request),
    );
  }

  @Post('assets/:id/actions/activate')
  @HttpCode(200)
  @RequirePermission('asset.availability.manage')
  activate(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @IfMatchHeader() m: IfMatch,
    @Req() r: FastifyRequest,
  ): Promise<AssetDetail> {
    return this.act(p, id, 'activate', {}, m, r);
  }

  @Post('assets/:id/actions/suspend')
  @HttpCode(200)
  @RequirePermission('asset.availability.manage')
  suspend(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() m: IfMatch,
    @Req() r: FastifyRequest,
  ): Promise<AssetDetail> {
    return this.act(p, id, 'suspend', parseWith(assetReasonSchema, body), m, r);
  }

  @Post('assets/:id/actions/reinstate')
  @HttpCode(200)
  @RequirePermission('asset.availability.manage')
  reinstate(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @IfMatchHeader() m: IfMatch,
    @Req() r: FastifyRequest,
  ): Promise<AssetDetail> {
    return this.act(p, id, 'reinstate', {}, m, r);
  }

  @Post('assets/:id/actions/decommission')
  @HttpCode(200)
  @RequirePermission('asset.archive')
  decommission(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @IfMatchHeader() m: IfMatch,
    @Req() r: FastifyRequest,
  ): Promise<AssetDetail> {
    return this.act(p, id, 'decommission', {}, m, r);
  }

  @Post('assets/:id/mounts')
  @RequirePermission('asset.update')
  addMount(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() r: FastifyRequest,
  ): Promise<AssetDetail> {
    return this.inventory.addMount(p, id, parseWith(mountRequestSchema, body ?? {}), clientInfo(r));
  }

  @Patch('mounts/:id')
  @RequirePermission('asset.update')
  updateMount(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() m: IfMatch,
    @Req() r: FastifyRequest,
  ): Promise<AssetDetail> {
    return this.inventory.updateMount(p, id, parseWith(mountRequestSchema, body), m, clientInfo(r));
  }

  @Patch('faces/:id')
  @RequirePermission('asset.update')
  updateFace(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() m: IfMatch,
    @Req() r: FastifyRequest,
  ): Promise<AssetDetail> {
    return this.inventory.updateFace(p, id, parseWith(updateFaceRequestSchema, body), m, clientInfo(r));
  }

  @Post('assets/:id/terms')
  @RequirePermission('asset.terms.manage')
  addTerms(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() r: FastifyRequest,
  ): Promise<AssetDetail> {
    return this.inventory.addTerms(p, id, parseWith(createTermsRequestSchema, body), clientInfo(r));
  }

  @Post('terms/:id/actions/close')
  @HttpCode(200)
  @RequirePermission('asset.terms.manage')
  closeTerms(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() m: IfMatch,
    @Req() r: FastifyRequest,
  ): Promise<AssetDetail> {
    const { validTo } = parseWith(closeTermsRequestSchema, body);
    return this.inventory.closeTerms(p, id, validTo, m, clientInfo(r));
  }

  @Post('assets/:id/blocks')
  @RequirePermission('asset.availability.manage')
  addBlock(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() r: FastifyRequest,
  ): Promise<AssetDetail> {
    return this.inventory.addBlock(p, id, parseWith(createBlockRequestSchema, body), clientInfo(r));
  }

  @Post('blocks/:id/actions/release')
  @HttpCode(200)
  @RequirePermission('asset.availability.manage')
  releaseBlock(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() r: FastifyRequest,
  ): Promise<AssetDetail> {
    return this.inventory.releaseBlock(p, id, clientInfo(r));
  }

  private act(
    principal: Principal,
    id: string,
    action: AssetLifecycleAction,
    input: { reason?: string },
    ifMatch: IfMatch,
    request: FastifyRequest,
  ): Promise<AssetDetail> {
    return this.inventory.transition(principal, id, action, input, ifMatch, clientInfo(request));
  }
}
