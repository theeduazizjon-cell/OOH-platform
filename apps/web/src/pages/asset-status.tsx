import type {
  AssetDetail,
  AssetLifecycle,
  AssetListItem,
  AssetTypeItem,
  AssetVerification,
  FaceItem,
} from '@ooh/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge, type BadgeTone } from './campaign-status';

export const LIFECYCLE_LABELS: Record<AssetLifecycle, string> = {
  PROSPECTIVE: 'Prospective',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  DECOMMISSIONED: 'Decommissioned',
};
const LIFECYCLE_TONE: Record<AssetLifecycle, BadgeTone> = {
  PROSPECTIVE: 'neutral',
  ACTIVE: 'live',
  SUSPENDED: 'warn',
  DECOMMISSIONED: 'done',
};
export const VERIFICATION_LABELS: Record<AssetVerification, string> = {
  NOT_VERIFIED: 'Not verified',
  TO_BE_VERIFIED: 'To be verified',
  FIELD_VERIFIED: 'Field verified',
};

export function LifecycleBadge({ lifecycle }: { lifecycle: AssetLifecycle }) {
  return <Badge tone={LIFECYCLE_TONE[lifecycle]}>{LIFECYCLE_LABELS[lifecycle]}</Badge>;
}

/** Asset types of the current company (tabs, the create form, attribute labels). */
export function useAssetTypes() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['asset-types', session?.tenantId],
    queryFn: () => api.request<AssetTypeItem[]>('/config/asset-types'),
    staleTime: 5 * 60_000,
  });
}

export function addressLine(asset: Pick<AssetListItem, 'address' | 'city' | 'county'>): string {
  return [asset.address, asset.city, asset.county].filter(Boolean).join(', ');
}

/** "2 mounts × 2 faces" style summary of the structure. */
export function structureSummary(asset: Pick<AssetListItem, 'mountCount' | 'faceCount'>): string {
  const mounts = `${asset.mountCount} mount${asset.mountCount === 1 ? '' : 's'}`;
  return `${mounts} · ${asset.faceCount} face${asset.faceCount === 1 ? '' : 's'}`;
}

/** "0.8 × 2 m", or null when the face has no size yet. */
export function faceSize(face: Pick<FaceItem, 'widthM' | 'heightM'>): string | null {
  if (!face.widthM || !face.heightM) return null;
  const trim = (m: string) => String(Number(m));
  return `${trim(face.widthM)} × ${trim(face.heightM)} m`;
}

export function mapsLink(location: { lat: number; lng: number }): string {
  return `https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lng}`;
}

/** Street View at the saved panorama when there is one, else at the asset's point. */
export function streetViewLink(asset: Pick<AssetDetail, 'location' | 'streetViewRef'>): string {
  const { lat, lng } = asset.location;
  const params = new URLSearchParams({ api: '1', map_action: 'pano', viewpoint: `${lat},${lng}` });
  const ref = asset.streetViewRef;
  if (ref) {
    params.set('pano', ref.panoId);
    params.set('heading', String(ref.heading));
    params.set('pitch', String(ref.pitch));
    params.set('fov', String(ref.fov));
  }
  return `https://www.google.com/maps/@?${params.toString()}`;
}
