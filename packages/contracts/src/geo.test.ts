import { describe, expect, it } from 'vitest';
import {
  clusterCellDegrees,
  decodePolyline,
  haversineM,
  initialBearing,
  mapAssetsQuerySchema,
  parseBbox,
  pathStartBearing,
} from './geo';

describe('geo math', () => {
  it('measures great-circle distances', () => {
    // One degree of latitude ≈ 111.2 km anywhere.
    expect(haversineM({ lat: 45, lng: 25 }, { lat: 46, lng: 25 })).toBeCloseTo(111_195, -1);
    expect(haversineM({ lat: 45, lng: 25 }, { lat: 45, lng: 25 })).toBe(0);
    // Bucharest (Piața Unirii) → Brașov (Piața Sfatului): about 136 km as the crow flies.
    const km = haversineM({ lat: 44.4268, lng: 26.1025 }, { lat: 45.6427, lng: 25.5887 }) / 1000;
    expect(km).toBeGreaterThan(135);
    expect(km).toBeLessThan(142);
  });

  it('gives compass bearings 0–359', () => {
    const at = { lat: 45, lng: 25 };
    expect(initialBearing(at, { lat: 46, lng: 25 })).toBe(0);
    expect(initialBearing(at, { lat: 45, lng: 26 })).toBe(90);
    expect(initialBearing(at, { lat: 44, lng: 25 })).toBe(180);
    expect(initialBearing(at, { lat: 45, lng: 24 })).toBe(270);
    expect(initialBearing(at, { lat: 46, lng: 24.97 })).toBe(359);
    expect(initialBearing(at, { lat: 46, lng: 24.99 })).toBe(0); // 359.6° rounds to north, never 360
  });

  it('sizes cluster cells by zoom', () => {
    expect(clusterCellDegrees(0)).toBe(90);
    expect(clusterCellDegrees(7)).toBeCloseTo(0.703, 3);
    expect(clusterCellDegrees(12)).toBeCloseTo(clusterCellDegrees(11) / 2, 10);
  });
});

describe('bbox', () => {
  it('parses west,south,east,north and rejects the rest', () => {
    expect(parseBbox('25.54, 45.34,25.56,45.36')).toEqual({
      west: 25.54,
      south: 45.34,
      east: 25.56,
      north: 45.36,
    });
    expect(parseBbox('25.56,45.34,25.54,45.36')).toBeNull();
    expect(parseBbox('25,45,26')).toBeNull();
    expect(parseBbox('25,45,26,x')).toBeNull();
    expect(parseBbox('-181,45,26,46')).toBeNull();
  });

  it('is part of the map query', () => {
    expect(mapAssetsQuerySchema.safeParse({ bbox: '25,45,26,46', zoom: '9' }).data).toEqual({
      bbox: { west: 25, south: 45, east: 26, north: 46 },
      zoom: 9,
    });
    expect(mapAssetsQuerySchema.safeParse({ bbox: 'nope', zoom: '9' }).success).toBe(false);
  });
});

describe('polylines', () => {
  it("decodes Google's reference polyline", () => {
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ]);
    expect(decodePolyline('')).toEqual([]);
  });

  it('takes the starting bearing past GPS jitter', () => {
    const start = { lat: 45, lng: 25 };
    const jitter = { lat: 45.00001, lng: 25.00001 }; // ~1.4 m north-east
    const east = { lat: 45, lng: 25.001 }; // ~79 m east
    expect(pathStartBearing([start, jitter, east])).toBe(90);
    expect(pathStartBearing([start, jitter])).toBeNull();
    expect(pathStartBearing([])).toBeNull();
  });
});
