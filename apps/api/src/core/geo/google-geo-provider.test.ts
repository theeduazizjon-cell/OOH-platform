import { describe, expect, it } from 'vitest';
import { countyName, GoogleGeoProvider } from './google-geo-provider';

const result = (location_type: string, extra: object = {}) => ({
  place_id: `p-${location_type}`,
  formatted_address: `Address ${location_type}`,
  geometry: { location: { lat: 45.35, lng: 25.55 }, location_type },
  ...extra,
});
const provider = (body: object, status = 200) => {
  const calls: URL[] = [];
  const fetchImpl = ((url: URL) => {
    calls.push(url);
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof fetch;
  return { geo: new GoogleGeoProvider('test-key-test-key-test-key', fetchImpl), calls };
};

describe('GoogleGeoProvider', () => {
  it('asks for Romania only and resolves a single precise match', async () => {
    const { geo, calls } = provider({ status: 'OK', results: [result('ROOFTOP')] });
    expect(await geo.geocode('Bd. Carol I 25, Sinaia, Romania')).toEqual({
      kind: 'resolved',
      candidate: {
        lat: 45.35,
        lng: 25.55,
        placeId: 'p-ROOFTOP',
        formattedAddress: 'Address ROOFTOP',
        precise: true,
      },
    });
    expect(calls[0]!.searchParams.get('components')).toBe('country:RO');
    expect(calls[0]!.searchParams.get('address')).toBe('Bd. Carol I 25, Sinaia, Romania');
  });

  it('is ambiguous for several, partial or only approximate matches', async () => {
    expect(
      (
        await provider({
          status: 'OK',
          results: [result('ROOFTOP'), result('RANGE_INTERPOLATED')],
        }).geo.geocode('x')
      ).kind,
    ).toBe('ambiguous');
    expect((await provider({ status: 'OK', results: [result('APPROXIMATE')] }).geo.geocode('x')).kind).toBe(
      'ambiguous',
    );
    expect(
      (
        await provider({ status: 'OK', results: [result('ROOFTOP', { partial_match: true })] }).geo.geocode(
          'x',
        )
      ).kind,
    ).toBe('ambiguous');
  });

  it('fails definitively for no results or refusals, and throws for transient errors', async () => {
    expect(await provider({ status: 'ZERO_RESULTS', results: [] }).geo.geocode('x')).toEqual({
      kind: 'failed',
      reason: 'The address was not found.',
    });
    expect((await provider({ status: 'REQUEST_DENIED', results: [] }).geo.geocode('x')).kind).toBe('failed');
    await expect(provider({ status: 'OVER_QUERY_LIMIT', results: [] }).geo.geocode('x')).rejects.toThrow(
      'OVER_QUERY_LIMIT',
    );
    await expect(provider({}, 503).geo.geocode('x')).rejects.toThrow('HTTP 503');
  });
});

/** A fetch that records each call and answers with `body`/`status`. */
const recording = (body: object, status = 200) => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = ((url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof fetch;
  return { geo: new GoogleGeoProvider('test-key-test-key-test-key', fetchImpl), calls };
};

const component = (long_name: string, ...types: string[]) => ({ long_name, types });

describe('GoogleGeoProvider.reverseGeocode', () => {
  it('reads street, city and county from the most specific result', async () => {
    const { geo, calls } = recording({
      status: 'OK',
      results: [
        { ...result('GEOMETRIC_CENTER'), types: ['plus_code'], formatted_address: '9GV2+XX Sinaia' },
        {
          ...result('ROOFTOP'),
          types: ['street_address'],
          formatted_address: 'Bulevardul Carol I 25, Sinaia 106100, România',
          address_components: [
            component('25', 'street_number'),
            component('Bulevardul Carol I', 'route'),
            component('Sinaia', 'locality', 'political'),
            component('Județul Prahova', 'administrative_area_level_1', 'political'),
            component('România', 'country', 'political'),
          ],
        },
      ],
    });
    expect(await geo.reverseGeocode({ lat: 45.3486, lng: 25.5517 })).toEqual({
      formattedAddress: 'Bulevardul Carol I 25, Sinaia 106100, România',
      address: 'Bulevardul Carol I 25',
      city: 'Sinaia',
      county: 'Prahova',
      placeId: 'p-ROOFTOP',
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('latlng')).toBe('45.3486,25.5517');
    expect(url.searchParams.get('language')).toBe('ro');
  });

  it('is null for nothing there, and throws for refusals and outages', async () => {
    expect(
      await recording({ status: 'ZERO_RESULTS', results: [] }).geo.reverseGeocode({ lat: 44, lng: 29 }),
    ).toBeNull();
    await expect(
      recording({ status: 'REQUEST_DENIED', results: [] }).geo.reverseGeocode({ lat: 44, lng: 29 }),
    ).rejects.toThrow('REQUEST_DENIED');
    await expect(recording({}, 500).geo.reverseGeocode({ lat: 44, lng: 29 })).rejects.toThrow('HTTP 500');
  });

  it('drops the "Județul" prefix from county names', () => {
    expect(countyName('Județul Prahova')).toBe('Prahova');
    expect(countyName('Judetul Brasov')).toBe('Brasov');
    expect(countyName('București')).toBe('București');
  });
});

describe('GoogleGeoProvider.route', () => {
  it('asks the Routes API for a driving route with only the fields it uses', async () => {
    const { geo, calls } = recording({
      routes: [
        { distanceMeters: 9800, duration: '754s', polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' } },
      ],
    });
    expect(await geo.route({ lat: 45.3486, lng: 25.5517 }, { lat: 45.4153, lng: 25.5375 })).toEqual({
      distanceM: 9800,
      durationS: 754,
      polyline: '_p~iF~ps|U_ulLnnqC',
    });
    const { url, init } = calls[0]!;
    expect(url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
    const headers = init!.headers as Record<string, string>;
    expect(headers['X-Goog-FieldMask']).toBe(
      'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
    );
    expect(JSON.parse(init!.body as string)).toMatchObject({
      origin: { location: { latLng: { latitude: 45.3486, longitude: 25.5517 } } },
      travelMode: 'DRIVE',
      regionCode: 'RO',
    });
  });

  it('is null without a route, and throws for errors', async () => {
    expect(await recording({}).geo.route({ lat: 45, lng: 25 }, { lat: 45, lng: 15 })).toBeNull();
    await expect(
      recording({ error: { status: 'PERMISSION_DENIED' } }, 403).geo.route(
        { lat: 45, lng: 25 },
        { lat: 46, lng: 25 },
      ),
    ).rejects.toThrow('HTTP 403');
  });
});
