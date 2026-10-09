import { describe, expect, it } from 'vitest';
import { GoogleGeoProvider } from './google-geo-provider';

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
