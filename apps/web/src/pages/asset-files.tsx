import type { FileItem, FileLinkItem, FilePurpose, FileStatus } from '@ooh/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, ImageIcon } from 'lucide-react';
import { type ChangeEvent, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { UploadError, uploadFile } from '@/lib/upload';

const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic';
const DOCUMENT_ACCEPT =
  'application/pdf,image/jpeg,image/png,image/webp,image/heic,video/mp4,video/quicktime';

export const FILE_STATUS_LABELS: Record<FileStatus, string> = {
  PENDING: 'Checking…',
  READY: 'Ready',
  QUARANTINED: 'Blocked: possible virus',
  REJECTED: 'Rejected',
};

/** Uploaded and queued for checks (an upload that was never finished stays PENDING for good). */
export function isProcessing(file: Pick<FileItem, 'status' | 'uploadedAt'>): boolean {
  return file.status === 'PENDING' && file.uploadedAt !== null;
}

export function fileStatusLabel(file: Pick<FileItem, 'status' | 'uploadedAt'>): string {
  return file.status === 'PENDING' && file.uploadedAt === null
    ? 'Upload not finished'
    : FILE_STATUS_LABELS[file.status];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Download links are short-lived (5 min): fetch one when needed, never store it. */
async function openFile(fileId: string) {
  const { url } = await api.request<{ url: string }>(`/files/${fileId}/url`);
  window.open(url, '_blank', 'noopener');
}

/**
 * Photos and documents of an asset (passport). Photos are the evidence that lets an asset be
 * activated (at least one READY photo). Files are checked after upload; the list polls while any
 * is still being checked.
 */
export function AssetFiles({
  assetId,
  canUpload,
  onChanged,
}: {
  assetId: string;
  canUpload: boolean;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<FilePurpose | null>(null);
  const files = useQuery({
    queryKey: ['files', 'asset', assetId],
    queryFn: () => api.request<FileLinkItem[]>(`/files?subjectType=asset&subjectId=${assetId}`),
    refetchInterval: (query) => (query.state.data?.some((l) => isProcessing(l.file)) ? 2_000 : false),
  });
  const links = files.data ?? [];
  const photos = links.filter((l) => l.purpose === 'ASSET_PHOTO');
  const documents = links.filter((l) => l.purpose !== 'ASSET_PHOTO');

  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: ['files', 'asset', assetId] });
    onChanged();
  };

  async function upload(purpose: FilePurpose, selected: FileList | null) {
    if (!selected?.length) return;
    setError(null);
    setBusy(purpose);
    const failures: string[] = [];
    for (const file of selected) {
      try {
        await uploadFile(file, { subjectType: 'asset', subjectId: assetId, purpose });
      } catch (caught) {
        const reason =
          caught instanceof UploadError || caught instanceof ApiError ? caught.message : 'Could not upload.';
        failures.push(`${file.name}: ${reason}`);
      }
    }
    setBusy(null);
    if (failures.length > 0) setError(failures.join(' '));
    await reload();
  }

  async function remove(link: FileLinkItem) {
    setError(null);
    try {
      await api.request(`/file-links/${link.linkId}`, { method: 'DELETE' });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
    }
    await reload();
  }

  async function open(link: FileLinkItem) {
    try {
      await openFile(link.file.id);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      {files.error && <Alert>{files.error.message}</Alert>}
      <section aria-label="Photos" className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Photos ({photos.length})</h3>
          {canUpload && (
            <UploadButton
              label="Add photos"
              accept={PHOTO_ACCEPT}
              busy={busy === 'ASSET_PHOTO'}
              onFiles={(f) => void upload('ASSET_PHOTO', f)}
            />
          )}
        </div>
        {photos.length === 0 ? (
          <p className="text-sm text-slate-500">
            No photos yet. An asset is activated once it has at least one checked photo.
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {photos.map((l) => (
              <li key={l.linkId} className="space-y-1">
                <button
                  type="button"
                  className="block aspect-[4/3] w-full overflow-hidden rounded-md border border-slate-200 bg-slate-50"
                  aria-label={`Open ${l.file.originalName}`}
                  disabled={l.file.status !== 'READY'}
                  onClick={() => void open(l)}
                >
                  <Thumbnail link={l} />
                </button>
                <FileMeta link={l} canRemove={canUpload} onRemove={() => void remove(l)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Documents" className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Documents ({documents.length})</h3>
          {canUpload && (
            <UploadButton
              label="Add documents"
              accept={DOCUMENT_ACCEPT}
              busy={busy === 'ATTACHMENT'}
              onFiles={(f) => void upload('ATTACHMENT', f)}
            />
          )}
        </div>
        {documents.length === 0 ? (
          <p className="text-sm text-slate-500">No documents (permits, contracts, plans).</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
            {documents.map((l) => (
              <li key={l.linkId} className="flex items-center gap-3 px-3 py-2">
                <FileText aria-hidden className="h-4 w-4 shrink-0 text-slate-400" />
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-sm text-brand-700 hover:underline disabled:text-slate-500 disabled:no-underline"
                  disabled={l.file.status !== 'READY'}
                  onClick={() => void open(l)}
                >
                  {l.file.originalName}
                </button>
                <FileMeta link={l} canRemove={canUpload} onRemove={() => void remove(l)} inline />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function UploadButton({
  label,
  accept,
  busy,
  onFiles,
}: {
  label: string;
  accept: string;
  busy: boolean;
  onFiles: (files: FileList | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={accept}
        className="sr-only"
        aria-label={label}
        tabIndex={-1}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          onFiles(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
      <Button variant="secondary" className="h-8" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? 'Uploading…' : label}
      </Button>
    </>
  );
}

function Thumbnail({ link }: { link: FileLinkItem }) {
  const ready = link.file.status === 'READY' && link.file.hasThumbnail;
  const thumb = useQuery({
    queryKey: ['file-url', link.file.id, 'thumb'],
    queryFn: () => api.request<{ url: string }>(`/files/${link.file.id}/url?variant=thumb`),
    enabled: ready,
    staleTime: 4 * 60_000, // links live 5 minutes
  });
  if (ready && thumb.data) {
    return <img src={thumb.data.url} alt={link.file.originalName} className="h-full w-full object-cover" />;
  }
  return (
    <span className="flex h-full w-full items-center justify-center text-slate-400">
      <ImageIcon aria-hidden className="h-6 w-6" />
    </span>
  );
}

function FileMeta({
  link,
  canRemove,
  onRemove,
  inline = false,
}: {
  link: FileLinkItem;
  canRemove: boolean;
  onRemove: () => void;
  inline?: boolean;
}) {
  const { file } = link;
  const problem = file.status === 'QUARANTINED' || file.status === 'REJECTED';
  return (
    <div className={inline ? 'flex shrink-0 items-center gap-2' : 'flex items-start justify-between gap-1'}>
      <span className="min-w-0 text-xs text-slate-500">
        {!inline && <span className="block truncate text-slate-700">{file.originalName}</span>}
        {file.status === 'READY' ? (
          formatBytes(file.sizeBytes)
        ) : (
          <span className={problem ? 'text-red-700' : ''}>
            {fileStatusLabel(file)}
            {file.statusReason && `: ${file.statusReason}`}
          </span>
        )}
      </span>
      {canRemove && (
        <Button
          variant="ghost"
          className="h-6 shrink-0 px-1.5 text-xs text-red-700"
          aria-label={`Remove ${file.originalName}`}
          onClick={onRemove}
        >
          Remove
        </Button>
      )}
    </div>
  );
}
