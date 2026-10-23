import { describe, expect, it } from 'vitest';
import { bboxParam, clusterClickZoom, compactCount, mapsConfig, parseViewport } from './map';

describe('map helpers', () => {
  it('reads the browser key and map ID, treating blanks as unset', () => {
    expect(mapsConfig({ VITE_GOOGLE_MAPS_BROWSER_KEY: ' k ' } as unknown as ImportMetaEnv)).toEqual({
      apiKey: 'k',
      mapId: 'DEMO_MAP_ID',
    });
    expect(
      mapsConfig({
        VITE_GOOGLE_MAPS_BROWSER_KEY: '',
        VITE_GOOGLE_MAPS_MAP_ID: 'abc',
      } as unknown as ImportMetaEnv),
    ).toEqual({ apiKey: null, mapId: 'abc' });
  });

  it('turns a viewport into a rounded bbox, clamped to the Web Mercator band', () => {
    expect(bboxParam({ west: 25.512345, south: 45.311111, east: 25.6, north: 45.4 })).toBe(
      '25.5123,45.3111,25.6,45.4',
    );
    expect(bboxParam({ west: -10, south: -89, east: 10, north: 89 })).toBe('-10,-85,10,85');
    // Across the antimeridian: the whole width.
    expect(bboxParam({ west: 170, south: 0, east: -170, north: 10 })).toBe('-180,0,180,10');
  });

  it('zooms into a server cluster, at most to where points start', () => {
    expect(clusterClickZoom(7)).toBe(9);
    expect(clusterClickZoom(12)).toBe(13);
  });

  it('accepts a viewport from the URL only when it is complete and sensible', () => {
    expect(parseViewport({ lat: '45.35', lng: '25.55', z: '14' })).toEqual({
      center: { lat: 45.35, lng: 25.55 },
      zoom: 14,
    });
    expect(parseViewport({ lat: 45.35, lng: 25.55 })).toBeNull();
    expect(parseViewport({ lat: 95, lng: 25, z: 10 })).toBeNull();
    expect(parseViewport({ lat: 45, lng: 25, z: 30 })).toBeNull();
    expect(parseViewport({ lat: 45, lng: 25, z: 7.5 })).toBeNull();
  });

  it('shortens cluster counts', () => {
    expect([950, 1000, 1250, 12_400].map(compactCount)).toEqual(['950', '1k', '1.3k', '12k']);
  });
});
