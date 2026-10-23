import { APIProvider } from '@vis.gl/react-google-maps';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { mapsConfig } from '@/lib/map';

/**
 * Google Maps for the components inside (ADR-0007: Maps JavaScript API, referrer-restricted key).
 * Without VITE_GOOGLE_MAPS_BROWSER_KEY the children render without it: use `useMapsEnabled` to
 * show `MapUnavailable` instead of a map.
 */
export function MapsProvider({ children }: { children: ReactNode }) {
  const { apiKey } = mapsConfig();
  if (!apiKey) return <>{children}</>;
  return (
    <APIProvider apiKey={apiKey} language="en" region="RO">
      {children}
    </APIProvider>
  );
}

export function useMapsEnabled(): boolean {
  return mapsConfig().apiKey !== null;
}

/** Shown where a map would be when no browser key is configured. */
export function MapUnavailable({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <div
      role="note"
      className={cn(
        'flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-sm text-slate-600',
        className,
      )}
    >
      <p className="font-medium text-slate-700">Map not configured</p>
      <p>
        Add <code className="rounded bg-white px-1">VITE_GOOGLE_MAPS_BROWSER_KEY</code> to <code>.env</code>{' '}
        to see the map.
      </p>
      {children}
    </div>
  );
}
