/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Google Maps JavaScript API key, restricted to the app's origins (ADR-0007). Unset: no maps. */
  readonly VITE_GOOGLE_MAPS_BROWSER_KEY?: string;
  /** Map ID for vector maps and advanced markers; Google's DEMO_MAP_ID when unset. */
  readonly VITE_GOOGLE_MAPS_MAP_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
