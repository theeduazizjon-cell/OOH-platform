import { Injectable } from '@nestjs/common';
import {
  allowedActions,
  ASSET_TRANSITIONS,
  type AssetDetail,
  type AssetLifecycleAction,
  type AssetListItem,
  type AssetListQuery,
  type AssetTypeItem,
  attributeProblems,
  type BlockItem,
  type CreateAssetRequest,
  type CreateBlockRequest,
  type CreateTermsRequest,
  type DimensionPresetItem,
  DUPLICATE_RADIUS_M,
  FACE_CODES,
  type MountItem,
  type MountRequest,
  type NearbyAsset,
  type Page,
  type TermsItem,
  type UpdateAssetRequest,
  type UpdateFaceRequest,
} from '@ooh/contracts';
import {
  advertisingFace,
  assetBlock,
  assetTerms,
  assetType,
  dimensionPreset,
  mountPosition,
  oohAsset,
  organisation,
  type Transaction,
} from '@ooh/db';
import { and, asc, eq, inArray, isNull, lt, ne, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type Actor, userActor } from '../../core/audit/actor';
import { AuditService } from '../../core/audit/audit.service';
import { type Principal } from '../../core/auth/principal';
import { DatabaseService } from '../../core/database/database.service';
import { isPgError } from '../../core/database/pg-errors';
import { AppError } from '../../core/http/app-error';
import { type ClientInfo } from '../../core/http/client-info';
import { assertIfMatch, type IfMatch } from '../../core/http/concurrency';
import { decodeIdCursor, encodeIdCursor } from '../../core/http/cursor';
import { TransitionsService } from '../../core/state/transitions.service';

type AssetRow = typeof oohAsset.$inferSelect;
type TypeRow = typeof assetType.$inferSelect;
type Changes = Record<string, { from: unknown; to: unknown }>;

const notFound = () => new AppError('NOT_FOUND', 'Asset not found.');
const LAT = sql<number>`ST_Y(${oohAsset.location}::geometry)`;
const LNG = sql<number>`ST_X(${oohAsset.location}::geometry)`;
const point = (lat: number, lng: number) => sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`;

/** `[from, to]` inclusive dates → PostgreSQL `[from, to+1)` (open-ended when `to` is null). */
export function dateRangeOf(from: string, to: string | null | undefined): string {
  if (!to) return `[${from},)`;
  const next = new Date(`${to}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return `[${from},${next.toISOString().slice(0, 10)})`;
}
/** PostgreSQL `[a,b)` → { from: a, to: b−1 day (inclusive) | null }. */
export function rangeDates(range: string): { from: string; to: string | null } {
  const match = /^[[(]([^,]*),([^)\]]*)[)\]]$/.exec(range);
  if (!match) throw new Error(`Unexpected daterange ${range}`);
  const [, lower, upper] = match;
  if (!upper) return { from: lower!, to: null };
  const last = new Date(`${upper}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() - 1);
  return { from: lower!, to: last.toISOString().slice(0, 10) };
}

/**
 * OOH inventory (05-domain-model.md §1.3, 06-state-machines.md §6). Read scope ORGANISATION (an OOH
 * supplier's users): assets their company supplies under any terms. ASSIGNED (decorators): assets of
 * their field jobs, which arrive in M9 (until then: none).
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly transitions: TransitionsService,
  ) {}

  // ── configuration (read) ───────────────────────────────────────────────────

  assetTypes(principal: Principal): Promise<AssetTypeItem[]> {
    return this.inTenant(principal, async (tx) =>
      (await tx.select().from(assetType).orderBy(asc(assetType.sortOrder), asc(assetType.name))).map(
        typeItem,
      ),
    );
  }

  dimensionPresets(principal: Principal): Promise<DimensionPresetItem[]> {
    return this.inTenant(principal, (tx) =>
      tx
        .select({
          id: dimensionPreset.id,
          name: dimensionPreset.name,
          widthM: dimensionPreset.widthM,
          heightM: dimensionPreset.heightM,
          active: dimensionPreset.active,
        })
        .from(dimensionPreset)
        .orderBy(asc(dimensionPreset.sortOrder), asc(dimensionPreset.name)),
    );
  }

  // ── assets ─────────────────────────────────────────────────────────────────

  /**
   * Inventory list. With `nearLat/nearLng` (research around a store pin): assets within `radiusM`,
   * nearest first, one page of up to `limit` (no cursor). Otherwise newest first, keyset-paged.
   */
  list(principal: Principal, query: AssetListQuery): Promise<Page<AssetListItem>> {
    const near =
      query.nearLat !== undefined && query.nearLng !== undefined
        ? point(query.nearLat, query.nearLng)
        : undefined;
    const after = !near && query.cursor ? decodeIdCursor(query.cursor) : undefined;
    return this.inTenant(principal, async (tx) => {
      const rows = await this.loadItems(
        tx,
        and(
          this.readScope(principal),
          query.assetTypeId ? eq(oohAsset.assetTypeId, query.assetTypeId) : undefined,
          query.lifecycle ? eq(oohAsset.lifecycle, query.lifecycle) : undefined,
          query.q
            ? sql`(${oohAsset.code} ILIKE ${`${query.q}%`} OR lower(immutable_unaccent(coalesce(${oohAsset.address}, '') || ' ' || coalesce(${oohAsset.city}, ''))) LIKE '%' || lower(immutable_unaccent(${query.q}::text)) || '%')`
            : undefined,
          near ? sql`ST_DWithin(${oohAsset.location}, ${near}, ${query.radiusM})` : undefined,
          after ? lt(oohAsset.id, after) : undefined,
        ),
        near ? query.limit : query.limit + 1,
        near,
      );
      if (near) return { data: rows, page: { nextCursor: null, hasMore: false } };
      const hasMore = rows.length > query.limit;
      const data = rows.slice(0, query.limit);
      return { data, page: { nextCursor: hasMore ? encodeIdCursor(data.at(-1)!.id) : null, hasMore } };
    });
  }

  get(principal: Principal, id: string): Promise<AssetDetail> {
    return this.inTenant(principal, (tx) => this.loadDetail(tx, principal, id));
  }

  /**
   * A new asset (PROSPECTIVE) with the type's default mounts and faces. A same-kind asset within
   * DUPLICATE_RADIUS_M blocks creation (409, "reuse POLE-001245?") unless overridden with a reason.
   */
  create(principal: Principal, input: CreateAssetRequest, client: ClientInfo): Promise<AssetDetail> {
    return this.inTenant(principal, async (tx) => {
      const type = await this.activeType(tx, input.assetTypeId);
      assertAttributes(type, input.attributes);
      const nearby = await this.nearbySameKind(tx, type.kind, input.lat, input.lng);
      if (nearby.length > 0 && !input.duplicateOverride) throw duplicate(nearby);

      const code = await nextCode(tx, principal.tenantId, type.codePrefix);
      const [created] = await tx
        .insert(oohAsset)
        .values({
          tenantId: principal.tenantId,
          code,
          assetTypeId: type.id,
          location: point(input.lat, input.lng),
          address: input.address ?? null,
          city: input.city ?? null,
          county: input.county ?? null,
          attributes: input.attributes,
          notes: input.notes ?? null,
          streetViewRef: input.streetViewRef ?? null,
          createdByMembershipId: principal.membershipId,
        })
        .returning({ id: oohAsset.id });
      for (let no = 1; no <= type.defaultMountPositions; no++) {
        await this.insertMount(tx, principal.tenantId, created!.id, no, type.facesPerMount, {});
      }
      await this.transitions.record(tx, principal, client, {
        subjectType: 'asset',
        subjectId: created!.id,
        from: null,
        to: 'PROSPECTIVE',
        action: 'create',
        event: 'asset.created',
        payload: { code, assetTypeId: type.id },
      });
      if (input.duplicateOverride) {
        await this.audit.record(tx, {
          ...userActor(principal, client),
          action: 'asset.duplicate_overridden',
          subjectType: 'asset',
          subjectId: created!.id,
          metadata: { reason: input.duplicateOverride.reason, nearby },
        });
      }
      return this.loadDetail(tx, principal, created!.id);
    });
  }

  update(
    principal: Principal,
    id: string,
    input: UpdateAssetRequest,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<AssetDetail> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lock(tx, principal, id);
      requireNotDecommissioned(current);
      const [type] = await tx.select().from(assetType).where(eq(assetType.id, current.assetTypeId));
      if (input.attributes) assertAttributes(type!, input.attributes);
      const moving = input.lat !== undefined && input.lng !== undefined;
      if (moving) {
        const nearby = await this.nearbySameKind(tx, type!.kind, input.lat!, input.lng!, id);
        if (nearby.length > 0 && !input.duplicateOverride) throw duplicate(nearby);
      }
      assertIfMatch(ifMatch, current.version);

      const [before] = await tx.select({ lat: LAT, lng: LNG }).from(oohAsset).where(eq(oohAsset.id, id));
      const changes: Changes = {};
      for (const field of ['address', 'city', 'county', 'notes'] as const) {
        if (input[field] !== undefined && input[field] !== current[field])
          changes[field] = { from: current[field], to: input[field] };
      }
      if (input.attributes && JSON.stringify(input.attributes) !== JSON.stringify(current.attributes))
        changes.attributes = { from: current.attributes, to: input.attributes };
      if (
        input.streetViewRef !== undefined &&
        JSON.stringify(input.streetViewRef) !== JSON.stringify(current.streetViewRef)
      )
        changes.streetViewRef = { from: current.streetViewRef, to: input.streetViewRef };
      if (moving && (before!.lat !== input.lat || before!.lng !== input.lng))
        changes.location = {
          from: { lat: before!.lat, lng: before!.lng },
          to: { lat: input.lat, lng: input.lng },
        };
      if (Object.keys(changes).length === 0) return this.loadDetail(tx, principal, id);

      await tx
        .update(oohAsset)
        .set({
          ...(changes.address ? { address: input.address } : {}),
          ...(changes.city ? { city: input.city } : {}),
          ...(changes.county ? { county: input.county } : {}),
          ...(changes.notes ? { notes: input.notes } : {}),
          ...(changes.attributes ? { attributes: input.attributes } : {}),
          ...(changes.streetViewRef ? { streetViewRef: input.streetViewRef } : {}),
          ...(changes.location ? { location: point(input.lat!, input.lng!) } : {}),
          version: sql`${oohAsset.version} + 1`,
        })
        .where(eq(oohAsset.id, id));
      await this.audit.record(tx, {
        ...userActor(principal, client),
        action: 'asset.updated',
        subjectType: 'asset',
        subjectId: id,
        changes,
        ...(input.duplicateOverride && changes.location
          ? { metadata: { duplicateOverride: input.duplicateOverride.reason } }
          : {}),
      });
      return this.loadDetail(tx, principal, id);
    });
  }

  /** activate (terms covering today) / suspend (reason) / reinstate / decommission. */
  transition(
    principal: Principal,
    id: string,
    action: AssetLifecycleAction,
    input: { reason?: string },
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<AssetDetail> {
    const rule = ASSET_TRANSITIONS[action];
    return this.inTenant(principal, async (tx) => {
      const current = await this.lock(tx, principal, id);
      if (!rule.from.includes(current.lifecycle)) {
        throw new AppError(
          'INVALID_TRANSITION',
          `A ${current.lifecycle.toLowerCase()} asset can't ${action}.`,
          {
            meta: { allowedActions: allowedActions(ASSET_TRANSITIONS, current.lifecycle) },
          },
        );
      }
      if (action === 'activate') {
        const [terms] = await tx
          .select({ id: assetTerms.id })
          .from(assetTerms)
          .where(and(eq(assetTerms.assetId, id), sql`${assetTerms.validPeriod} @> current_date`));
        if (!terms) {
          throw new AppError(
            'VALIDATION_FAILED',
            'An asset joins the inventory once its current terms are recorded.',
            {
              errors: [{ path: 'terms', message: 'Record who owns or supplies it (terms covering today)' }],
            },
          );
        }
      }
      assertIfMatch(ifMatch, current.version);
      const to = rule.to === 'PREVIOUS' ? current.lifecycle : rule.to;
      await tx
        .update(oohAsset)
        .set({
          lifecycle: to,
          suspendReason: action === 'suspend' ? input.reason : null,
          version: sql`${oohAsset.version} + 1`,
        })
        .where(eq(oohAsset.id, id));
      await this.transitions.record(tx, principal, client, {
        subjectType: 'asset',
        subjectId: id,
        from: current.lifecycle,
        to,
        action,
        event: `asset.${{ activate: 'activated', suspend: 'suspended', reinstate: 'reinstated', decommission: 'decommissioned' }[action]}`,
        ...(input.reason ? { reason: input.reason } : {}),
      });
      return this.loadDetail(tx, principal, id);
    });
  }

  // ── mounts and faces ───────────────────────────────────────────────────────

  addMount(
    principal: Principal,
    assetId: string,
    input: MountRequest,
    client: ClientInfo,
  ): Promise<AssetDetail> {
    return this.inTenant(principal, async (tx) => {
      const current = await this.lock(tx, principal, assetId);
      requireNotDecommissioned(current);
      const [type] = await tx.select().from(assetType).where(eq(assetType.id, current.assetTypeId));
      const [last] = await tx
        .select({ no: sql<number | null>`max(${mountPosition.positionNo})` })
        .from(mountPosition)
        .where(eq(mountPosition.assetId, assetId));
      const positionNo = (last?.no ?? 0) + 1;
      try {
        await this.insertMount(tx, principal.tenantId, assetId, positionNo, type!.facesPerMount, input);
      } catch (error) {
        if (isPgError(error, '23514', 'mount_position_type_limit_ck')) {
          throw new AppError(
            'CONFLICT',
            `A ${type!.name.toLowerCase()} has at most ${type!.maxMountPositions} mount positions.`,
          );
        }
        throw error;
      }
      await this.bumpAndAudit(tx, userActor(principal, client), assetId, 'asset.mount_added', { positionNo });
      return this.loadDetail(tx, principal, assetId);
    });
  }

  updateMount(
    principal: Principal,
    mountId: string,
    input: MountRequest,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<AssetDetail> {
    return this.inTenant(principal, async (tx) => {
      const [mount] = await tx
        .select()
        .from(mountPosition)
        .where(eq(mountPosition.id, mountId))
        .for('update');
      if (!mount) throw new AppError('NOT_FOUND', 'Mount position not found.');
      const asset = await this.lock(tx, principal, mount.assetId);
      requireNotDecommissioned(asset);
      assertIfMatch(ifMatch, mount.version);
      const changes = diff(mount, input, ['orientationBearing', 'heightM', 'notes']);
      if (changes) {
        await tx
          .update(mountPosition)
          .set({ ...pick(input, Object.keys(changes)), version: sql`${mountPosition.version} + 1` })
          .where(eq(mountPosition.id, mountId));
        await this.bumpAndAudit(tx, userActor(principal, client), mount.assetId, 'asset.mount_updated', {
          positionNo: mount.positionNo,
          changes,
        });
      }
      return this.loadDetail(tx, principal, mount.assetId);
    });
  }

  updateFace(
    principal: Principal,
    faceId: string,
    input: UpdateFaceRequest,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<AssetDetail> {
    return this.inTenant(principal, async (tx) => {
      const [row] = await tx
        .select({ face: advertisingFace, assetId: mountPosition.assetId })
        .from(advertisingFace)
        .innerJoin(mountPosition, eq(mountPosition.id, advertisingFace.mountPositionId))
        .where(eq(advertisingFace.id, faceId))
        .for('update', { of: advertisingFace });
      if (!row) throw new AppError('NOT_FOUND', 'Face not found.');
      const asset = await this.lock(tx, principal, row.assetId);
      requireNotDecommissioned(asset);
      // A preset copies its size as values (editing the preset later never rewrites this face).
      let next: UpdateFaceRequest = input;
      if (input.dimensionPresetId) {
        const [preset] = await tx
          .select()
          .from(dimensionPreset)
          .where(and(eq(dimensionPreset.id, input.dimensionPresetId), eq(dimensionPreset.active, true)));
        if (!preset) throw invalid('dimensionPresetId', 'Unknown or inactive size');
        next = { ...input, widthM: preset.widthM, heightM: preset.heightM };
      }
      assertIfMatch(ifMatch, row.face.version);
      const changes = diff(row.face, next, [
        'facingBearing',
        'visibleTrafficDirection',
        'widthM',
        'heightM',
        'dimensionPresetId',
        'illuminated',
      ]);
      if (changes) {
        await tx
          .update(advertisingFace)
          .set({ ...pick(next, Object.keys(changes)), version: sql`${advertisingFace.version} + 1` })
          .where(eq(advertisingFace.id, faceId));
        await this.bumpAndAudit(tx, userActor(principal, client), row.assetId, 'asset.face_updated', {
          faceCode: row.face.faceCode,
          changes,
        });
      }
      return this.loadDetail(tx, principal, row.assetId);
    });
  }

  // ── terms and blocks ───────────────────────────────────────────────────────

  addTerms(
    principal: Principal,
    assetId: string,
    input: CreateTermsRequest,
    client: ClientInfo,
  ): Promise<AssetDetail> {
    return this.inTenant(principal, async (tx) => {
      const asset = await this.lock(tx, principal, assetId);
      requireNotDecommissioned(asset);
      for (const path of ['ownerOrganisationId', 'supplierOrganisationId'] as const) {
        const orgId = input[path];
        if (orgId && !(await companyExists(tx, orgId))) throw invalid(path, 'Unknown or archived company');
      }
      try {
        await tx.insert(assetTerms).values({
          tenantId: principal.tenantId,
          assetId,
          acquisition: input.acquisition,
          ownerOrganisationId: input.ownerOrganisationId ?? null,
          supplierOrganisationId: input.supplierOrganisationId ?? null,
          costAmount: input.costAmount ?? null,
          costUnit: input.costUnit ?? null,
          currency: input.currency,
          validPeriod: dateRangeOf(input.validFrom, input.validTo),
          contractRef: input.contractRef ?? null,
          createdByMembershipId: principal.membershipId,
        });
      } catch (error) {
        if (isPgError(error, '23P01', 'asset_terms_no_overlap_ex')) {
          throw new AppError(
            'CONFLICT',
            'These dates overlap the asset’s other terms. Close the current terms first.',
          );
        }
        throw error;
      }
      await this.bumpAndAudit(tx, userActor(principal, client), assetId, 'asset.terms_added', {
        acquisition: input.acquisition,
        validFrom: input.validFrom,
        validTo: input.validTo ?? null,
      });
      return this.loadDetail(tx, principal, assetId);
    });
  }

  /** Ends a terms period on `validTo` (included). */
  closeTerms(
    principal: Principal,
    termsId: string,
    validTo: string,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<AssetDetail> {
    return this.inTenant(principal, async (tx) => {
      const [terms] = await tx.select().from(assetTerms).where(eq(assetTerms.id, termsId)).for('update');
      if (!terms) throw new AppError('NOT_FOUND', 'Terms not found.');
      await this.lock(tx, principal, terms.assetId);
      const { from, to } = rangeDates(terms.validPeriod);
      if (validTo < from) throw invalid('validTo', 'The end is before the start');
      if (to !== null && validTo > to) throw invalid('validTo', 'Terms can only be shortened here');
      assertIfMatch(ifMatch, terms.version);
      await tx
        .update(assetTerms)
        .set({ validPeriod: dateRangeOf(from, validTo), version: sql`${assetTerms.version} + 1` })
        .where(eq(assetTerms.id, termsId));
      await this.bumpAndAudit(tx, userActor(principal, client), terms.assetId, 'asset.terms_closed', {
        termsId,
        changes: { validTo: { from: to, to: validTo } },
      });
      return this.loadDetail(tx, principal, terms.assetId);
    });
  }

  addBlock(
    principal: Principal,
    assetId: string,
    input: CreateBlockRequest,
    client: ClientInfo,
  ): Promise<AssetDetail> {
    return this.inTenant(principal, async (tx) => {
      const asset = await this.lock(tx, principal, assetId);
      requireNotDecommissioned(asset);
      if (input.faceId) {
        const [face] = await tx
          .select({ id: advertisingFace.id })
          .from(advertisingFace)
          .innerJoin(mountPosition, eq(mountPosition.id, advertisingFace.mountPositionId))
          .where(and(eq(advertisingFace.id, input.faceId), eq(mountPosition.assetId, assetId)));
        if (!face) throw invalid('faceId', 'Not a face of this asset');
      }
      await tx.insert(assetBlock).values({
        tenantId: principal.tenantId,
        assetId,
        faceId: input.faceId ?? null,
        period: dateRangeOf(input.from, input.to),
        reason: input.reason,
        createdByMembershipId: principal.membershipId,
      });
      await this.bumpAndAudit(tx, userActor(principal, client), assetId, 'asset.blocked', {
        faceId: input.faceId ?? null,
        from: input.from,
        to: input.to,
        reason: input.reason,
      });
      return this.loadDetail(tx, principal, assetId);
    });
  }

  releaseBlock(principal: Principal, blockId: string, client: ClientInfo): Promise<AssetDetail> {
    return this.inTenant(principal, async (tx) => {
      const [block] = await tx.select().from(assetBlock).where(eq(assetBlock.id, blockId)).for('update');
      if (!block) throw new AppError('NOT_FOUND', 'Block not found.');
      await this.lock(tx, principal, block.assetId);
      if (block.releasedAt) throw new AppError('INVALID_TRANSITION', 'This block is already released.');
      await tx.update(assetBlock).set({ releasedAt: new Date() }).where(eq(assetBlock.id, blockId));
      await this.bumpAndAudit(tx, userActor(principal, client), block.assetId, 'asset.unblocked', {
        blockId,
      });
      return this.loadDetail(tx, principal, block.assetId);
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private inTenant<T>(principal: Principal, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.database.withTenant({ tenantId: principal.tenantId, actorUserId: principal.userId }, fn);
  }

  private readScope(principal: Principal): SQL | undefined {
    const scope = principal.permissions.get('asset.read');
    if (scope === 'ASSIGNED') return sql`false`; // field jobs (M9) will list a decorator's assets
    if (scope !== 'ORGANISATION') return undefined;
    // Raw SQL: correlated references to "ooh_asset" must be qualified (drizzle renders them bare).
    return sql`EXISTS (
      SELECT 1 FROM asset_terms t JOIN membership m ON m.id = ${principal.membershipId}
      WHERE t.asset_id = "ooh_asset"."id" AND m.organisation_id IS NOT NULL
        AND t.supplier_organisation_id = m.organisation_id
    )`;
  }

  /** Readable assets only (404 otherwise); the caller then checks its own permission. */
  private async lock(tx: Transaction, principal: Principal, id: string): Promise<AssetRow> {
    const [row] = await tx
      .select()
      .from(oohAsset)
      .where(and(eq(oohAsset.id, id), this.readScope(principal)))
      .for('update');
    if (!row) throw notFound();
    return row;
  }

  private async activeType(tx: Transaction, id: string): Promise<TypeRow> {
    const [type] = await tx
      .select()
      .from(assetType)
      .where(and(eq(assetType.id, id), eq(assetType.active, true)));
    if (!type) throw invalid('assetTypeId', 'Unknown or inactive asset type');
    return type;
  }

  /** Same-kind, not decommissioned assets within DUPLICATE_RADIUS_M, nearest first. */
  private async nearbySameKind(
    tx: Transaction,
    kind: TypeRow['kind'],
    lat: number,
    lng: number,
    excludeId?: string,
  ): Promise<NearbyAsset[]> {
    const here = point(lat, lng);
    const distance = sql<number>`ST_Distance(${oohAsset.location}, ${here})`;
    const rows = await tx
      .select({ id: oohAsset.id, code: oohAsset.code, lifecycle: oohAsset.lifecycle, distanceM: distance })
      .from(oohAsset)
      .innerJoin(assetType, eq(assetType.id, oohAsset.assetTypeId))
      .where(
        and(
          eq(assetType.kind, kind),
          ne(oohAsset.lifecycle, 'DECOMMISSIONED'),
          sql`ST_DWithin(${oohAsset.location}, ${here}, ${DUPLICATE_RADIUS_M})`,
          excludeId ? ne(oohAsset.id, excludeId) : undefined,
        ),
      )
      .orderBy(distance)
      .limit(5);
    return rows.map((r) => ({ ...r, distanceM: Math.round(Number(r.distanceM) * 10) / 10 }));
  }

  private async insertMount(
    tx: Transaction,
    tenantId: string,
    assetId: string,
    positionNo: number,
    facesPerMount: number,
    input: MountRequest,
  ): Promise<void> {
    const [mount] = await tx
      .insert(mountPosition)
      .values({
        tenantId,
        assetId,
        positionNo,
        orientationBearing: input.orientationBearing ?? null,
        heightM: input.heightM ?? null,
        notes: input.notes ?? null,
      })
      .returning({ id: mountPosition.id });
    await tx.insert(advertisingFace).values(
      FACE_CODES.slice(0, facesPerMount).map((faceCode) => ({
        tenantId,
        mountPositionId: mount!.id,
        faceCode,
      })),
    );
  }

  /** Changes to mounts, faces, terms and blocks move the asset's version (its ETag) too. */
  private async bumpAndAudit(
    tx: Transaction,
    by: Actor,
    assetId: string,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await tx
      .update(oohAsset)
      .set({ version: sql`${oohAsset.version} + 1` })
      .where(eq(oohAsset.id, assetId));
    await this.audit.record(tx, { ...by, action, subjectType: 'asset', subjectId: assetId, metadata });
  }

  private async loadDetail(tx: Transaction, principal: Principal, id: string): Promise<AssetDetail> {
    const [item] = await this.loadItems(tx, and(eq(oohAsset.id, id), this.readScope(principal)), 1);
    if (!item) throw notFound();
    const [row] = await tx.select().from(oohAsset).where(eq(oohAsset.id, id));
    const mounts = await tx
      .select()
      .from(mountPosition)
      .where(eq(mountPosition.assetId, id))
      .orderBy(asc(mountPosition.positionNo));
    const faces =
      mounts.length === 0
        ? []
        : await tx
            .select()
            .from(advertisingFace)
            .where(
              inArray(
                advertisingFace.mountPositionId,
                mounts.map((m) => m.id),
              ),
            )
            .orderBy(asc(advertisingFace.faceCode));
    const blocks = await tx
      .select()
      .from(assetBlock)
      .where(and(eq(assetBlock.assetId, id), isNull(assetBlock.releasedAt)))
      .orderBy(asc(assetBlock.period));
    return {
      ...item,
      attributes: row!.attributes,
      notes: row!.notes,
      suspendReason: row!.suspendReason,
      lastVerifiedAt: row!.lastVerifiedAt?.toISOString() ?? null,
      streetViewRef: row!.streetViewRef ?? null,
      mounts: mounts.map((m): MountItem => ({
        id: m.id,
        positionNo: m.positionNo,
        orientationBearing: m.orientationBearing,
        heightM: m.heightM,
        notes: m.notes,
        version: m.version,
        faces: faces
          .filter((f) => f.mountPositionId === m.id)
          .map((f) => ({
            id: f.id,
            faceCode: f.faceCode as MountItem['faces'][number]['faceCode'],
            facingBearing: f.facingBearing,
            visibleTrafficDirection: f.visibleTrafficDirection,
            widthM: f.widthM,
            heightM: f.heightM,
            dimensionPresetId: f.dimensionPresetId,
            illuminated: f.illuminated,
            version: f.version,
          })),
      })),
      terms: principal.permissions.has('asset.terms.read') ? await this.loadTerms(tx, id) : null,
      blocks: blocks.map((b): BlockItem => ({
        id: b.id,
        faceId: b.faceId,
        ...(() => {
          const { from, to } = rangeDates(b.period);
          return { from, to: to! };
        })(),
        reason: b.reason,
        releasedAt: b.releasedAt?.toISOString() ?? null,
      })),
      actions: allowedActions(ASSET_TRANSITIONS, item.lifecycle),
    };
  }

  private async loadTerms(tx: Transaction, assetId: string): Promise<TermsItem[]> {
    const ownerOrg = alias(organisation, 'owner_org');
    const supplierOrg = alias(organisation, 'supplier_org');
    const rows = await tx
      .select({ terms: assetTerms, ownerName: ownerOrg.displayName, supplierName: supplierOrg.displayName })
      .from(assetTerms)
      .leftJoin(ownerOrg, eq(ownerOrg.id, assetTerms.ownerOrganisationId))
      .leftJoin(supplierOrg, eq(supplierOrg.id, assetTerms.supplierOrganisationId))
      .where(eq(assetTerms.assetId, assetId))
      .orderBy(sql`lower(${assetTerms.validPeriod}) DESC`);
    return rows.map(({ terms: t, ownerName, supplierName }) => {
      const { from, to } = rangeDates(t.validPeriod);
      return {
        id: t.id,
        acquisition: t.acquisition,
        owner:
          t.ownerOrganisationId && ownerName ? { id: t.ownerOrganisationId, displayName: ownerName } : null,
        supplier:
          t.supplierOrganisationId && supplierName
            ? { id: t.supplierOrganisationId, displayName: supplierName }
            : null,
        costAmount: t.costAmount,
        costUnit: t.costUnit,
        currency: t.currency as TermsItem['currency'],
        validFrom: from,
        validTo: to,
        contractRef: t.contractRef,
        version: t.version,
      };
    });
  }

  private async loadItems(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
    near?: SQL,
  ): Promise<AssetListItem[]> {
    const distance = near ? sql<number>`ST_Distance(${oohAsset.location}, ${near})` : sql<null>`NULL`;
    const rows = await tx
      .select({
        asset: oohAsset,
        typeName: assetType.name,
        kind: assetType.kind,
        lat: LAT,
        lng: LNG,
        distanceM: distance,
        // Correlated subqueries: name the outer table explicitly.
        mountCount: sql<number>`(SELECT count(*)::int FROM mount_position mp WHERE mp.asset_id = "ooh_asset"."id")`,
        faceCount: sql<number>`(SELECT count(*)::int FROM advertising_face f JOIN mount_position mp ON mp.id = f.mount_position_id WHERE mp.asset_id = "ooh_asset"."id")`,
      })
      .from(oohAsset)
      .innerJoin(assetType, eq(assetType.id, oohAsset.assetTypeId))
      .where(where)
      .orderBy(near ? distance : sql`${oohAsset.id} DESC`)
      .limit(limit);
    return rows.map((r) => ({
      id: r.asset.id,
      code: r.asset.code,
      type: { id: r.asset.assetTypeId, name: r.typeName, kind: r.kind },
      location: { lat: Number(r.lat), lng: Number(r.lng) },
      address: r.asset.address,
      city: r.asset.city,
      county: r.asset.county,
      lifecycle: r.asset.lifecycle,
      verificationStatus: r.asset.verificationStatus,
      mountCount: r.mountCount,
      faceCount: r.faceCount,
      distanceM: r.distanceM === null ? null : Math.round(Number(r.distanceM)),
      version: r.asset.version,
    }));
  }
}

function typeItem(t: TypeRow): AssetTypeItem {
  return {
    id: t.id,
    key: t.key,
    name: t.name,
    kind: t.kind,
    codePrefix: t.codePrefix,
    defaultMountPositions: t.defaultMountPositions,
    maxMountPositions: t.maxMountPositions,
    facesPerMount: t.facesPerMount,
    facesBookedTogether: t.facesBookedTogether,
    attributeSchema: t.attributeSchema,
    active: t.active,
    version: t.version,
  };
}

/** `{prefix}-{000001}`, the next number of that prefix in the tenant (per-tenant advisory lock). */
async function nextCode(tx: Transaction, tenantId: string, prefix: string): Promise<string> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:asset_code:${prefix}`}, 0))`,
  );
  const [row] = await tx
    .select({ last: sql<string | null>`max(${oohAsset.code})` })
    .from(oohAsset)
    .where(sql`${oohAsset.code} ~ ${`^${prefix}-[0-9]{6}$`}`);
  const next = row?.last ? Number(row.last.slice(prefix.length + 1)) + 1 : 1;
  return `${prefix}-${String(next).padStart(6, '0')}`;
}

function duplicate(nearby: NearbyAsset[]): AppError {
  const [first] = nearby;
  return new AppError(
    'DUPLICATE_SUSPECTED',
    `${first!.code} is ${first!.distanceM} m away. Reuse it, or give a reason to add another.`,
    { meta: { nearby } },
  );
}

function assertAttributes(type: TypeRow, values: Record<string, unknown>): void {
  const problems = attributeProblems(type.attributeSchema, values);
  if (problems.length > 0)
    throw new AppError('VALIDATION_FAILED', 'Some attributes are not valid.', { errors: problems });
}

function requireNotDecommissioned(asset: AssetRow): void {
  if (asset.lifecycle === 'DECOMMISSIONED')
    throw new AppError('INVALID_TRANSITION', 'This asset is decommissioned.');
}

async function companyExists(tx: Transaction, id: string): Promise<boolean> {
  const [company] = await tx
    .select({ id: organisation.id })
    .from(organisation)
    .where(and(eq(organisation.id, id), isNull(organisation.archivedAt)));
  return Boolean(company);
}

function diff<T extends object, K extends keyof T & string>(
  current: T,
  input: Partial<Record<K, unknown>>,
  fields: readonly K[],
): Changes | null {
  const changes: Changes = {};
  for (const field of fields) {
    if (input[field] !== undefined && input[field] !== current[field])
      changes[field] = { from: current[field], to: input[field] };
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

function pick(input: object, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, (input as Record<string, unknown>)[k]]));
}

function invalid(path: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', `${message}.`, { errors: [{ path, message }] });
}
