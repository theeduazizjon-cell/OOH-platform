import type { GeocodeStatus, LocationItem } from '@ooh/contracts';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

export const GEOCODE_LABELS: Record<GeocodeStatus, string> = {
  PENDING: 'Locating…',
  RESOLVED: 'Pin found, to confirm',
  AMBIGUOUS: 'Several matches',
  FAILED: 'Not found',
  CONFIRMED: 'Pin confirmed',
};
const TONES: Record<GeocodeStatus, string> = {
  PENDING: 'text-slate-500',
  RESOLVED: 'text-brand-700',
  AMBIGUOUS: 'text-amber-800',
  FAILED: 'text-red-700',
  CONFIRMED: 'text-emerald-700',
};

export function PinStatus({ location }: { location: Pick<LocationItem, 'geocodeStatus'> }) {
  return (
    <span className={cn('block text-xs', TONES[location.geocodeStatus])}>
      {GEOCODE_LABELS[location.geocodeStatus]}
    </span>
  );
}

/**
 * Coordinates from what people paste: "45.3486, 25.5517", "45.3486 25.5517", or a Google Maps link
 * (".../@45.3486,25.5517,17z" or "...?q=45.3486,25.5517" / "query=…"). Null when it isn't a point.
 */
export function parseCoordinates(text: string): { lat: number; lng: number } | null {
  const input = text.trim();
  const fromUrl =
    /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/.exec(input) ??
    /[?&](?:q|query|ll)=(-?\d{1,3}(?:\.\d+)?)(?:,|%2C)(-?\d{1,3}(?:\.\d+)?)/i.exec(input);
  const plain = /^(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(input);
  const match = fromUrl ?? plain;
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/** Google Maps at the pin, or a search for the address (to check or find the store). */
export function googleMapsLink(
  location: Pick<LocationItem, 'storePoint' | 'address' | 'city' | 'county' | 'name'>,
): string {
  const query = location.storePoint
    ? `${location.storePoint.lat},${location.storePoint.lng}`
    : [location.name, location.address, location.city, location.county, 'Romania'].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/**
 * Place or accept a store pin (04-user-flows.md A7). The map picker arrives with the Map module (M5);
 * until then the pin is typed, pasted from Google Maps, or the geocoder's suggestion is accepted.
 */
export function PinEditor({
  location,
  onSave,
  onCancel,
}: {
  location: LocationItem;
  onSave: (pin: { lat: number; lng: number }) => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const current = location.storePoint;

  async function save(pin: { lat: number; lng: number }) {
    setSaving(true);
    setError(null);
    try {
      await onSave(pin);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.');
    } finally {
      setSaving(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('coordinates');
    const pin = parseCoordinates(typeof value === 'string' ? value : '');
    if (!pin) return setError('Paste coordinates like "45.3486, 25.5517" or a Google Maps link to the spot.');
    void save(pin);
  }

  return (
    <form aria-label={`Store pin: ${location.name}`} className="space-y-3" onSubmit={submit} noValidate>
      <div className="text-sm">
        <p className="font-medium">Store pin · {location.name}</p>
        <p className="text-slate-600">
          {[location.address, location.city, location.county].filter(Boolean).join(', ') ||
            'No address given.'}
        </p>
        <PinStatus location={location} />
        {location.geocodedAddress && (
          <p className="text-xs text-slate-600">Geocoder: {location.geocodedAddress}</p>
        )}
        {location.geocodeError && <p className="text-xs text-slate-600">{location.geocodeError}</p>}
      </div>
      {error && <Alert>{error}</Alert>}
      {current && location.geocodeStatus === 'RESOLVED' && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-brand-100 bg-brand-50 p-2 text-sm">
          <span>
            Suggested pin {current.lat.toFixed(5)}, {current.lng.toFixed(5)}
          </span>
          <Button className="h-8" disabled={saving} onClick={() => void save(current)}>
            Use this pin
          </Button>
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor={`pin-${location.id}`}>Coordinates or Google Maps link</Label>
        <Input
          id={`pin-${location.id}`}
          name="coordinates"
          placeholder="45.3486, 25.5517"
          defaultValue={current ? `${current.lat}, ${current.lng}` : ''}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a
          href={googleMapsLink(location)}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-brand-700 hover:underline"
        >
          Open in Google Maps ↗
        </a>
        <span className="flex gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Confirm pin'}
          </Button>
        </span>
      </div>
    </form>
  );
}
