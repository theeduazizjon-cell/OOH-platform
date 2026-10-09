/**
 * Files (docs/architecture/08-system-architecture.md §4, 05-domain-model.md §cross-cutting). A file is
 * stored once (object storage) and linked to the records it belongs to; it is served only once
 * processing (size, checksum, real type, virus scan) has marked it READY.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId, tenantIdColumn, timestamps, versionColumn } from './columns';
import { membership, tenant } from './identity';

export const fileStatus = pgEnum('file_status', ['PENDING', 'READY', 'QUARANTINED', 'REJECTED']);
export const filePurpose = pgEnum('file_purpose', [
  'ASSET_PHOTO',
  'ATTACHMENT',
  'ARTWORK',
  'SIMULATION',
  'STUDY_EXPORT',
]);
export const fileVisibility = pgEnum('file_visibility', ['INTERNAL', 'EXTERNAL']);

export const fileObject = pgTable(
  'file_object',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    /** Object key in storage: `{tenant}/{yyyy}/{mm}/{id}` (never derived from the user's file name). */
    storageKey: text('storage_key').notNull(),
    originalName: text('original_name').notNull(),
    /** What the uploader declared… */
    mime: text('mime').notNull(),
    /** …and what the bytes turned out to be (magic bytes), once processed. */
    detectedMime: text('detected_mime'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** Hex SHA-256 the uploader computed; processing verifies it. */
    sha256: text('sha256').notNull(),
    status: fileStatus('status').notNull().default('PENDING'),
    /** Why a file was rejected or quarantined. */
    statusReason: text('status_reason'),
    width: integer('width'),
    height: integer('height'),
    /** Derived objects (e.g. `{ "thumb": "<key>" }`), regenerable from the original. */
    derivatives: jsonb('derivatives')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Scan outcome: engine and signature, or `{ "engine": "none" }` where scanning is off (development). */
    scan: jsonb('scan').$type<{ engine: string; signature?: string }>(),
    uploadedByMembershipId: uuid('uploaded_by_membership_id'),
    /** The client said the upload finished (POST /files/{id}/complete). */
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    ...timestamps(),
    version: versionColumn(),
  },
  (t) => [
    unique('file_object_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('file_object_storage_key_uq').on(t.storageKey),
    foreignKey({
      name: 'file_object_uploaded_by_fk',
      columns: [t.tenantId, t.uploadedByMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    index('file_object_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'PENDING'`),
    check('file_object_sha256_ck', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('file_object_size_ck', sql`${t.sizeBytes} > 0`),
    check('file_object_name_ck', sql`length(btrim(${t.originalName})) > 0`),
    check('file_object_processed_ck', sql`${t.status} = 'PENDING' OR ${t.processedAt} IS NOT NULL`),
    check(
      'file_object_reason_ck',
      sql`${t.status} NOT IN ('QUARANTINED', 'REJECTED') OR ${t.statusReason} IS NOT NULL`,
    ),
  ],
);

/** A file attached to a record (polymorphic subject, 05-domain-model §3); access follows the record. */
export const fileLink = pgTable(
  'file_link',
  {
    id: primaryId(),
    tenantId: tenantIdColumn().references(() => tenant.id),
    fileId: uuid('file_id').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    purpose: filePurpose('purpose').notNull(),
    /** EXTERNAL files may be shown to portal users of the record; INTERNAL never. */
    visibility: fileVisibility('visibility').notNull().default('INTERNAL'),
    createdByMembershipId: uuid('created_by_membership_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('file_link_tenant_id_id_uq').on(t.tenantId, t.id),
    unique('file_link_uq').on(t.fileId, t.subjectType, t.subjectId, t.purpose),
    foreignKey({
      name: 'file_link_file_fk',
      columns: [t.tenantId, t.fileId],
      foreignColumns: [fileObject.tenantId, fileObject.id],
    }),
    foreignKey({
      name: 'file_link_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    index('file_link_subject_idx').on(t.tenantId, t.subjectType, t.subjectId),
    check('file_link_subject_type_ck', sql`${t.subjectType} IN ('asset')`),
  ],
);
