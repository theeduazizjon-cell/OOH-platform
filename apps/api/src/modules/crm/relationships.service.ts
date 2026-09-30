import { Injectable } from '@nestjs/common';
import type { CreateRelationshipRequest, OrganisationRelationshipItem } from '@ooh/contracts';
import { organisation, organisationRelationship, type Transaction } from '@ooh/db';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AuditService } from '../../core/audit/audit.service';
import { type Principal } from '../../core/auth/principal';
import { DatabaseService } from '../../core/database/database.service';
import { isUniqueViolation } from '../../core/database/pg-errors';
import { AppError } from '../../core/http/app-error';
import { type ClientInfo } from '../../core/http/client-info';
import { OrganisationsService } from './organisations.service';

const other = alias(organisation, 'other_organisation');

/**
 * Agency ↔ client (and supplier, parent) links between companies. Adding or removing one changes
 * the company it starts from, so it needs organisation.update on that company (OWN: its owner).
 */
@Injectable()
export class RelationshipsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly organisations: OrganisationsService,
    private readonly audit: AuditService,
  ) {}

  /** Both directions, from the point of view of `organisationId`. */
  list(principal: Principal, organisationId: string): Promise<OrganisationRelationshipItem[]> {
    return this.inTenant(principal, async (tx) => {
      await this.assertReadable(tx, principal, organisationId);
      return this.load(tx, organisationId);
    });
  }

  create(
    principal: Principal,
    fromOrganisationId: string,
    input: CreateRelationshipRequest,
    client: ClientInfo,
  ): Promise<OrganisationRelationshipItem[]> {
    return this.inTenant(principal, async (tx) => {
      await this.organisations.lockEditable(tx, principal, fromOrganisationId, 'organisation.update');
      if (input.toOrganisationId === fromOrganisationId) {
        throw new AppError('VALIDATION_FAILED', 'A company can’t be related to itself.', {
          errors: [{ path: 'toOrganisationId', message: 'Same company' }],
        });
      }
      const [target] = await tx
        .select({ archivedAt: organisation.archivedAt })
        .from(organisation)
        .where(
          and(
            eq(organisation.id, input.toOrganisationId),
            this.organisations.scopeFilter(principal, 'organisation.read'),
          ),
        );
      if (!target || target.archivedAt) {
        throw new AppError('VALIDATION_FAILED', 'Unknown or archived company.', {
          errors: [{ path: 'toOrganisationId', message: 'Unknown or archived company' }],
        });
      }
      try {
        await tx.insert(organisationRelationship).values({
          tenantId: principal.tenantId,
          fromOrganisationId,
          toOrganisationId: input.toOrganisationId,
          kind: input.kind,
          createdByMembershipId: principal.membershipId,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'organisation_relationship_uq'))
          throw new AppError('CONFLICT', 'These companies are already linked this way.');
        throw error;
      }
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'organisation.relationship_added',
        subjectType: 'organisation',
        subjectId: fromOrganisationId,
        metadata: { kind: input.kind, toOrganisationId: input.toOrganisationId },
      });
      return this.load(tx, fromOrganisationId);
    });
  }

  /** Removes a link; allowed from its "from" company (the one it describes). */
  remove(
    principal: Principal,
    fromOrganisationId: string,
    relationshipId: string,
    client: ClientInfo,
  ): Promise<void> {
    return this.inTenant(principal, async (tx) => {
      await this.organisations.lockEditable(tx, principal, fromOrganisationId, 'organisation.update');
      const [removed] = await tx
        .delete(organisationRelationship)
        .where(
          and(
            eq(organisationRelationship.id, relationshipId),
            eq(organisationRelationship.fromOrganisationId, fromOrganisationId),
          ),
        )
        .returning({ kind: organisationRelationship.kind, toId: organisationRelationship.toOrganisationId });
      if (!removed) throw new AppError('NOT_FOUND', 'Relationship not found.');
      await this.audit.record(tx, {
        ...actor(principal, client),
        action: 'organisation.relationship_removed',
        subjectType: 'organisation',
        subjectId: fromOrganisationId,
        metadata: { kind: removed.kind, toOrganisationId: removed.toId },
      });
    });
  }

  private inTenant<T>(principal: Principal, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.database.withTenant({ tenantId: principal.tenantId, actorUserId: principal.userId }, fn);
  }

  private async assertReadable(tx: Transaction, principal: Principal, id: string): Promise<void> {
    const [row] = await tx
      .select({ id: organisation.id })
      .from(organisation)
      .where(and(eq(organisation.id, id), this.organisations.scopeFilter(principal, 'organisation.read')));
    if (!row) throw new AppError('NOT_FOUND', 'Company not found.');
  }

  private async load(tx: Transaction, organisationId: string): Promise<OrganisationRelationshipItem[]> {
    const outgoing = eq(organisationRelationship.fromOrganisationId, organisationId);
    const rows = await tx
      .select({
        id: organisationRelationship.id,
        kind: organisationRelationship.kind,
        outgoing: sql<boolean>`${outgoing}`,
        otherId: other.id,
        otherName: other.displayName,
        otherArchivedAt: other.archivedAt,
        createdAt: organisationRelationship.createdAt,
      })
      .from(organisationRelationship)
      .innerJoin(
        other,
        sql`${other.id} = CASE WHEN ${outgoing} THEN ${organisationRelationship.toOrganisationId} ELSE ${organisationRelationship.fromOrganisationId} END`,
      )
      .where(or(outgoing, eq(organisationRelationship.toOrganisationId, organisationId)))
      .orderBy(asc(organisationRelationship.kind), asc(other.nameKey));
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      direction: r.outgoing ? 'OUTGOING' : 'INCOMING',
      other: { id: r.otherId, displayName: r.otherName, archived: r.otherArchivedAt !== null },
      createdAt: r.createdAt.toISOString(),
    }));
  }
}

function actor(principal: Principal, client: ClientInfo) {
  return {
    tenantId: principal.tenantId,
    actorType: 'USER' as const,
    actorUserId: principal.userId,
    actorMembershipId: principal.membershipId,
    client,
  };
}
