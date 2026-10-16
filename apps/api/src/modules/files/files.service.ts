import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type CreateUploadRequest,
  DOWNLOAD_URL_SECONDS,
  type FileItem,
  type FileLinkItem,
  type FilePurpose,
  type FileSubjectType,
  sniffMime,
  UPLOAD_URL_SECONDS,
  type UploadTicket,
} from '@ooh/contracts';
import { fileLink, fileObject, type Transaction } from '@ooh/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { systemActor, userActor } from '../../core/audit/actor';
import { AuditService } from '../../core/audit/audit.service';
import { type Principal } from '../../core/auth/principal';
import { DatabaseService } from '../../core/database/database.service';
import { FileSubjects } from '../../core/files/file-subjects';
import { FILE_SCANNER, type FileScanner } from '../../core/files/scanner';
import { FILE_STORAGE, type FileStorage } from '../../core/files/storage';
import { AppError } from '../../core/http/app-error';
import { type ClientInfo } from '../../core/http/client-info';
import { type OutboxMessage, OutboxHandlers } from '../../core/outbox/outbox-handlers';
import { OutboxService } from '../../core/state/outbox.service';

type FileRow = typeof fileObject.$inferSelect;

/** Largest side of the thumbnail derivative (pixels). */
export const THUMBNAIL_PX = 480;

/** What processing concluded about an uploaded file (computed outside any transaction). */
export interface ProcessingResult {
  status: 'READY' | 'QUARANTINED' | 'REJECTED';
  reason: string | null;
  detectedMime: string | null;
  width: number | null;
  height: number | null;
  derivatives: Record<string, string>;
  scan: { engine: string; signature?: string } | null;
}

const notFound = () => new AppError('NOT_FOUND', 'File not found.');

/**
 * Files (08-system-architecture.md §4): every file belongs to a record and access follows the record.
 * Upload: ticket (PENDING + short-lived PUT URL) → client uploads → complete → the worker verifies size,
 * SHA-256 and real type, scans, makes a thumbnail (metadata stripped; the original keeps its EXIF) and
 * marks it READY, QUARANTINED or REJECTED. Only READY files are ever served.
 */
@Injectable()
export class FilesService implements OnModuleInit {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly subjects: FileSubjects,
    private readonly handlers: OutboxHandlers,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(FILE_SCANNER) private readonly scanner: FileScanner,
  ) {}

  onModuleInit(): void {
    this.handlers.on<ProcessingResult>(
      'file.uploaded',
      'files.process',
      (tx, event, result) => this.store(tx, event, result),
      (event) => this.inspect(event),
    );
  }

  async createUpload(
    principal: Principal,
    input: CreateUploadRequest,
    client: ClientInfo,
  ): Promise<UploadTicket> {
    const now = new Date();
    const storageKey = `${principal.tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
    const link = await this.inTenant(principal, async (tx) => {
      await this.assertCanWrite(tx, principal, input.subjectType, input.subjectId);
      const [file] = await tx
        .insert(fileObject)
        .values({
          tenantId: principal.tenantId,
          storageKey,
          originalName: input.originalName,
          mime: input.mime,
          sizeBytes: input.sizeBytes,
          sha256: input.sha256,
          uploadedByMembershipId: principal.membershipId,
        })
        .returning({ id: fileObject.id });
      await tx.insert(fileLink).values({
        tenantId: principal.tenantId,
        fileId: file!.id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        purpose: input.purpose,
        visibility: input.visibility,
        createdByMembershipId: principal.membershipId,
      });
      await this.audit.record(tx, {
        ...userActor(principal, client),
        action: 'file.upload_started',
        subjectType: 'file',
        subjectId: file!.id,
        metadata: {
          name: input.originalName,
          mime: input.mime,
          sizeBytes: input.sizeBytes,
          subject: { type: input.subjectType, id: input.subjectId },
        },
      });
      const [item] = await this.loadLinks(tx, eq(fileLink.fileId, file!.id));
      return item!;
    });
    const upload = await this.storage.presignPut({
      key: storageKey,
      contentType: input.mime,
      sizeBytes: input.sizeBytes,
      expiresIn: UPLOAD_URL_SECONDS,
    });
    return {
      link,
      upload: {
        ...upload,
        method: 'PUT',
        expiresAt: new Date(now.getTime() + UPLOAD_URL_SECONDS * 1000).toISOString(),
      },
    };
  }

  /** The client finished uploading: processing is queued (the file stays PENDING until it ends). */
  complete(principal: Principal, fileId: string, client: ClientInfo): Promise<FileItem> {
    return this.inTenant(principal, async (tx) => {
      const [file] = await tx.select().from(fileObject).where(eq(fileObject.id, fileId)).for('update');
      if (!file || !(await this.writableThroughLinks(tx, principal, fileId))) throw notFound();
      if (file.status !== 'PENDING' || file.uploadedAt) {
        throw new AppError('INVALID_TRANSITION', 'This upload is already complete.');
      }
      const stored = await this.storage.head(file.storageKey);
      if (!stored)
        throw new AppError('CONFLICT', 'Nothing was uploaded yet. Send the file to the upload URL first.');
      await tx.update(fileObject).set({ uploadedAt: new Date() }).where(eq(fileObject.id, fileId));
      await this.outbox.publish(tx, principal.tenantId, 'file.uploaded', {
        fileId,
        storageKey: file.storageKey,
        mime: file.mime,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
      });
      await this.audit.record(tx, {
        ...userActor(principal, client),
        action: 'file.uploaded',
        subjectType: 'file',
        subjectId: fileId,
      });
      return fileItem({ ...file, uploadedAt: new Date() });
    });
  }

  list(
    principal: Principal,
    subjectType: FileSubjectType,
    subjectId: string,
    purpose?: FilePurpose,
  ): Promise<FileLinkItem[]> {
    return this.inTenant(principal, async (tx) => {
      if (!(await this.subjects.policy(subjectType).canRead(tx, principal, subjectId))) {
        throw new AppError('NOT_FOUND', 'Record not found.');
      }
      return this.loadLinks(
        tx,
        and(
          eq(fileLink.subjectType, subjectType),
          eq(fileLink.subjectId, subjectId),
          purpose ? eq(fileLink.purpose, purpose) : undefined,
          // Portal users only ever see files shared with them.
          principal.kind === 'EXTERNAL' ? eq(fileLink.visibility, 'EXTERNAL') : undefined,
        ),
      );
    });
  }

  /** A short-lived download URL for a READY file the principal can see through one of its records. */
  url(
    principal: Principal,
    fileId: string,
    variant: 'original' | 'thumb',
  ): Promise<{ url: string; expiresAt: string }> {
    return this.inTenant(principal, async (tx) => {
      const [file] = await tx.select().from(fileObject).where(eq(fileObject.id, fileId));
      if (!file || !(await this.readableThroughLinks(tx, principal, fileId))) throw notFound();
      if (file.status !== 'READY') {
        throw new AppError(
          'INVALID_TRANSITION',
          file.status === 'PENDING' ? 'The file is still being checked.' : 'This file is not available.',
        );
      }
      const key = variant === 'thumb' ? file.derivatives.thumb : file.storageKey;
      if (!key) throw new AppError('NOT_FOUND', 'This file has no thumbnail.');
      const url = await this.storage.presignGet({
        key,
        fileName:
          variant === 'thumb' ? `${file.originalName.replace(/\.[^.]+$/, '')}-thumb.webp` : file.originalName,
        contentType: variant === 'thumb' ? 'image/webp' : (file.detectedMime ?? file.mime),
        expiresIn: DOWNLOAD_URL_SECONDS,
      });
      return { url, expiresAt: new Date(Date.now() + DOWNLOAD_URL_SECONDS * 1000).toISOString() };
    });
  }

  /** Detaches a file from a record (the file and its history stay). */
  unlink(principal: Principal, linkId: string, client: ClientInfo): Promise<void> {
    return this.inTenant(principal, async (tx) => {
      const [link] = await tx.select().from(fileLink).where(eq(fileLink.id, linkId));
      if (!link) throw new AppError('NOT_FOUND', 'Link not found.');
      await this.assertCanWrite(tx, principal, link.subjectType as FileSubjectType, link.subjectId);
      await tx.delete(fileLink).where(eq(fileLink.id, linkId));
      await this.audit.record(tx, {
        ...userActor(principal, client),
        action: 'file.unlinked',
        subjectType: 'file',
        subjectId: link.fileId,
        metadata: { subject: { type: link.subjectType, id: link.subjectId }, purpose: link.purpose },
      });
    });
  }

  /** Processing, outside any transaction: size, checksum, real type, scan, thumbnail. */
  async inspect(event: OutboxMessage): Promise<ProcessingResult> {
    const { storageKey, mime, sizeBytes, sha256 } = event.payload as {
      storageKey: string;
      mime: string;
      sizeBytes: number;
      sha256: string;
    };
    const body = await this.storage.read(storageKey);
    const base = { detectedMime: null, width: null, height: null, derivatives: {}, scan: null };
    if (body.length !== sizeBytes) {
      return {
        ...base,
        status: 'REJECTED',
        reason: `Size is ${body.length} bytes, ${sizeBytes} were announced.`,
      };
    }
    if (createHash('sha256').update(body).digest('hex') !== sha256) {
      return {
        ...base,
        status: 'REJECTED',
        reason: 'The checksum does not match: the upload is incomplete or altered.',
      };
    }
    const detectedMime = sniffMime(body.subarray(0, 32));
    if (detectedMime !== mime) {
      return {
        ...base,
        detectedMime,
        status: 'REJECTED',
        reason: `The content is ${detectedMime ?? 'not an allowed type'}, not ${mime}.`,
      };
    }
    const scan = await this.scanner.scan(body); // throws when unreachable: the outbox retries
    if (!scan.clean) {
      return { ...base, detectedMime, scan, status: 'QUARANTINED', reason: `Virus found: ${scan.signature}` };
    }
    let width: number | null = null;
    let height: number | null = null;
    const derivatives: Record<string, string> = {};
    if (detectedMime.startsWith('image/') && detectedMime !== 'image/heic') {
      const { default: sharp } = await import('sharp');
      const image = sharp(body, { failOn: 'error' });
      const meta = await image.metadata();
      // EXIF orientation applied; sharp drops metadata (incl. GPS) from derivatives by default.
      const rotated = meta.orientation && meta.orientation >= 5;
      width = (rotated ? meta.height : meta.width) ?? null;
      height = (rotated ? meta.width : meta.height) ?? null;
      const thumb = await sharp(body)
        .rotate()
        .resize(THUMBNAIL_PX, THUMBNAIL_PX, { fit: 'inside' })
        .webp()
        .toBuffer();
      derivatives.thumb = `${storageKey}.thumb.webp`;
      await this.storage.write(derivatives.thumb, thumb, 'image/webp');
    }
    return {
      status: 'READY',
      reason: null,
      detectedMime,
      width,
      height,
      derivatives,
      scan: { engine: scan.engine },
    };
  }

  async store(tx: Transaction, event: OutboxMessage, result: ProcessingResult): Promise<void> {
    const fileId = event.payload.fileId as string;
    const [file] = await tx
      .select({ status: fileObject.status })
      .from(fileObject)
      .where(eq(fileObject.id, fileId))
      .for('update');
    if (file?.status !== 'PENDING') return;
    await tx
      .update(fileObject)
      .set({
        status: result.status,
        statusReason: result.reason,
        detectedMime: result.detectedMime,
        width: result.width,
        height: result.height,
        derivatives: result.derivatives,
        scan: result.scan,
        processedAt: new Date(),
        version: sql`${fileObject.version} + 1`,
      })
      .where(eq(fileObject.id, fileId));
    await this.audit.record(tx, {
      ...systemActor(event.tenantId),
      action: `file.${result.status.toLowerCase()}`,
      subjectType: 'file',
      subjectId: fileId,
      ...(result.reason ? { metadata: { reason: result.reason } } : {}),
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private inTenant<T>(principal: Principal, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.database.withTenant({ tenantId: principal.tenantId, actorUserId: principal.userId }, fn);
  }

  private async assertCanWrite(
    tx: Transaction,
    principal: Principal,
    type: FileSubjectType,
    id: string,
  ): Promise<void> {
    const policy = this.subjects.policy(type);
    if (!(await policy.canRead(tx, principal, id))) throw new AppError('NOT_FOUND', 'Record not found.');
    if (!(await policy.canWrite(tx, principal, id))) {
      throw new AppError('FORBIDDEN', 'You cannot attach files to this record.');
    }
  }

  private async linksOf(tx: Transaction, fileId: string) {
    return tx.select().from(fileLink).where(eq(fileLink.fileId, fileId));
  }

  private async readableThroughLinks(
    tx: Transaction,
    principal: Principal,
    fileId: string,
  ): Promise<boolean> {
    for (const link of await this.linksOf(tx, fileId)) {
      if (principal.kind === 'EXTERNAL' && link.visibility !== 'EXTERNAL') continue;
      if (
        await this.subjects.policy(link.subjectType as FileSubjectType).canRead(tx, principal, link.subjectId)
      )
        return true;
    }
    return false;
  }

  private async writableThroughLinks(
    tx: Transaction,
    principal: Principal,
    fileId: string,
  ): Promise<boolean> {
    for (const link of await this.linksOf(tx, fileId)) {
      if (
        await this.subjects
          .policy(link.subjectType as FileSubjectType)
          .canWrite(tx, principal, link.subjectId)
      )
        return true;
    }
    return false;
  }

  private async loadLinks(tx: Transaction, where: ReturnType<typeof and>): Promise<FileLinkItem[]> {
    const rows = await tx
      .select({ link: fileLink, file: fileObject })
      .from(fileLink)
      .innerJoin(fileObject, eq(fileObject.id, fileLink.fileId))
      .where(where)
      .orderBy(asc(fileLink.createdAt), asc(fileLink.id));
    return rows.map(({ link, file }) => ({
      linkId: link.id,
      subjectType: link.subjectType as FileSubjectType,
      subjectId: link.subjectId,
      purpose: link.purpose,
      visibility: link.visibility,
      file: fileItem(file),
    }));
  }
}

function fileItem(f: FileRow): FileItem {
  return {
    id: f.id,
    originalName: f.originalName,
    mime: f.mime,
    sizeBytes: f.sizeBytes,
    status: f.status,
    statusReason: f.statusReason,
    width: f.width,
    height: f.height,
    hasThumbnail: Boolean(f.derivatives.thumb),
    uploadedAt: f.uploadedAt?.toISOString() ?? null,
    processedAt: f.processedAt?.toISOString() ?? null,
    createdAt: f.createdAt.toISOString(),
  };
}
