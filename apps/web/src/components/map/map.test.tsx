import { DEFAULT_ASSET_TYPES, type MapAssetsResponse, type MapPoint } from '@ooh/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetForm } from '@/pages/asset-form';
import { layerStatusText, MapPage } from '@/pages/map-page';
import { AssetLayer, mapAssetsPath } from './asset-layer';
import { MapPicker } from './map-picker';

// ── a stand-in for Google Maps ────────────────────────────────────────────────
const request = vi.fn();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  api: { request: (...args: unknown[]) => request(...args) as unknown },
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ session: { tenantId: 't1' } }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));

const idle: (() => void)[] = [];
const fakeMap = {
  getBounds: () => ({
    toJSON: () => ({ west: 25.5, south: 45.3, east: 25.6, north: 45.4 }),
    contains: () => false,
  }),
  getZoom: vi.fn(() => 7),
  getCenter: () => ({ toJSON: () => ({ lat: 45.35, lng: 25.55 }) }),
  addListener: (_: string, fn: () => void) => {
    idle.push(fn);
    return { remove: vi.fn() };
  },
  panTo: vi.fn(),
  setZoom: vi.fn(),
};
class FakeMarker {
  listeners: Record<string, () => void> = {};
  constructor(readonly options: { title: string }) {}
  addListener(event: string, fn: () => void) {
    this.listeners[event] = fn;
  }
}
const clusterer = {
  addMarkers: vi.fn(),
  removeMarkers: vi.fn(),
  render: vi.fn(),
  clearMarkers: vi.fn(),
  setMap: vi.fn(),
};
vi.mock('@googlemaps/markerclusterer', () => ({ MarkerClusterer: vi.fn(() => clusterer) }));
vi.mock('@vis.gl/react-google-maps', () => ({
  APIProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Map: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: (e: { detail: { latLng: { lat: number; lng: number } } }) => void;
  }) => (
    <div data-testid="map">
      <button
        type="button"
        onClick={() => onClick?.({ detail: { latLng: { lat: 45.123456789, lng: 25.987654321 } } })}
      >
        click map
      </button>
      {children}
    </div>
  ),
  AdvancedMarker: ({
    children,
    position,
    title,
    onClick,
  }: {
    children?: ReactNode;
    position: { lat: number; lng: number };
    title?: string;
    onClick?: () => void;
  }) => (
    <div
      data-testid="marker"
      data-position={`${position.lat},${position.lng}`}
      title={title}
      onClick={onClick}
    >
      {children}
    </div>
  ),
  Pin: () => <span>pin</span>,
  InfoWindow: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  useMap: () => fakeMap,
  useMapsLibrary: () => ({ AdvancedMarkerElement: FakeMarker }),
}));

const types = DEFAULT_ASSET_TYPES.slice(0, 2).map((t, i) => ({
  ...t,
  id: `00000000-0000-4000-8000-00000000000${i}`,
  active: true,
  version: 1,
}));
vi.mock('@/pages/asset-status', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useAssetTypes: () => ({ data: types }),
}));

const withQuery = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {ui}
    </QueryClientProvider>,
  );
const point = (id: string, extra: Partial<MapPoint> = {}): MapPoint => ({
  id,
  code: `POLE-${id}`,
  lat: 45.35,
  lng: 25.55,
  kind: 'POLE',
  assetTypeId: types[0]!.id,
  lifecycle: 'ACTIVE',
  ...extra,
});

beforeEach(() => {
  request.mockReset();
  idle.length = 0;
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());

describe('without a browser key', () => {
  it('the map page and pickers say the map is not configured', () => {
    withQuery(<MapPage initial={null} onViewportChange={vi.fn()} />);
    expect(screen.getByText('Map not configured')).toBeInTheDocument();
    expect(screen.queryByTestId('map')).not.toBeInTheDocument();
    render(<MapPicker label="Pick" value={null} onChange={vi.fn()} />);
    expect(screen.getByText(/Type or paste the coordinates instead/)).toBeInTheDocument();
  });
});

describe('with a browser key', () => {
  beforeEach(() => vi.stubEnv('VITE_GOOGLE_MAPS_BROWSER_KEY', 'test-key'));

  it('asks for the viewport with filters and draws server clusters that zoom in on click', async () => {
    expect(mapAssetsPath({ bbox: '1,2,3,4', zoom: 9 }, { lifecycle: 'ACTIVE' })).toBe(
      '/map/assets?bbox=1%2C2%2C3%2C4&zoom=9&lifecycle=ACTIVE',
    );
    const clusters: MapAssetsResponse = {
      kind: 'clusters',
      clusters: [
        { lat: 45.3, lng: 25.5, count: 1250 },
        { lat: 45.4, lng: 25.6, count: 3 },
      ],
      total: 1253,
    };
    request.mockResolvedValue(clusters);
    const onStatus = vi.fn();
    withQuery(<AssetLayer assetTypeId={types[0]!.id} onStatus={onStatus} />);
    await waitFor(() => expect(screen.getAllByTestId('marker')).toHaveLength(2));
    expect(request).toHaveBeenCalledWith(
      `/map/assets?bbox=25.5%2C45.3%2C25.6%2C45.4&zoom=7&assetTypeId=${types[0]!.id}`,
    );
    expect(screen.getByText('1.3k')).toBeInTheDocument();
    await waitFor(() =>
      expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ count: 1253, truncated: false })),
    );
    await userEvent.click(screen.getByTitle('1250 assets: zoom in'));
    expect(fakeMap.panTo).toHaveBeenCalledWith({ lat: 45.3, lng: 25.5 });
    expect(fakeMap.setZoom).toHaveBeenCalledWith(9);
  });

  it('adds point markers to the clusterer and, after a pan, only the difference', async () => {
    fakeMap.getZoom.mockReturnValue(14);
    request.mockResolvedValueOnce({ kind: 'points', points: [point('1'), point('2')], truncated: false });
    const onSelect = vi.fn();
    withQuery(<AssetLayer onSelect={onSelect} excludeId="9" />);
    await waitFor(() => expect(clusterer.addMarkers).toHaveBeenCalledTimes(1));
    const first = clusterer.addMarkers.mock.calls[0]![0] as FakeMarker[];
    expect(first.map((m) => m.options.title)).toEqual(['POLE-1', 'POLE-2']);
    first[1]!.listeners.click!();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }));

    // Pan: 2 stays, 1 leaves, 3 arrives; 9 (the excluded one) is never drawn.
    request.mockResolvedValueOnce({
      kind: 'points',
      points: [point('2'), point('3'), point('9')],
      truncated: false,
    });
    fakeMap.getZoom.mockReturnValue(15);
    act(() => idle.forEach((fn) => fn()));
    await waitFor(() => expect(clusterer.addMarkers).toHaveBeenCalledTimes(2));
    expect((clusterer.addMarkers.mock.calls[1]![0] as FakeMarker[]).map((m) => m.options.title)).toEqual([
      'POLE-3',
    ]);
    expect((clusterer.removeMarkers.mock.calls[0]![0] as FakeMarker[]).map((m) => m.options.title)).toEqual([
      'POLE-1',
    ]);

    // Suspended since: the same asset is redrawn in its new colour.
    request.mockResolvedValueOnce({
      kind: 'points',
      points: [point('2', { lifecycle: 'SUSPENDED' }), point('3')],
      truncated: false,
    });
    fakeMap.getZoom.mockReturnValue(16);
    act(() => idle.forEach((fn) => fn()));
    await waitFor(() => expect(clusterer.addMarkers).toHaveBeenCalledTimes(3));
    expect((clusterer.addMarkers.mock.calls[2]![0] as FakeMarker[]).map((m) => m.options.title)).toEqual([
      'POLE-2',
    ]);
    expect((clusterer.removeMarkers.mock.calls[1]![0] as FakeMarker[]).map((m) => m.options.title)).toEqual([
      'POLE-2',
    ]);
    fakeMap.getZoom.mockReturnValue(7);
  });

  it('the picker sets the point from a map click and shows the pin where the value is', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<MapPicker label="Pick" value={null} onChange={onChange} />);
    expect(screen.queryByTestId('marker')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'click map' }));
    expect(onChange).toHaveBeenCalledWith({ lat: 45.123456789, lng: 25.987654321 });
    rerender(<MapPicker label="Pick" value={{ lat: 45.1, lng: 25.9 }} onChange={onChange} />);
    expect(screen.getByTestId('marker')).toHaveAttribute('data-position', '45.1,25.9');
    expect(fakeMap.panTo).toHaveBeenCalledWith({ lat: 45.1, lng: 25.9 }); // outside the view: follow it
  });

  it('in the asset form, a map click fills the coordinates and the pin fills the address', async () => {
    request.mockResolvedValue({ kind: 'clusters', clusters: [], total: 0 });
    withQuery(<AssetForm types={types} submitLabel="Create asset" onSubmit={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'click map' }));
    expect(screen.getByLabelText('Coordinates or Google Maps link')).toHaveValue('45.123457, 25.987654');

    request.mockResolvedValueOnce({
      configured: true,
      result: {
        formattedAddress: 'Str. Lungă 5, Brașov',
        address: 'Str. Lungă 5',
        city: 'Brașov',
        county: 'Brașov',
        placeId: 'x',
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Fill address from the pin' }));
    expect(request).toHaveBeenLastCalledWith('/geo/reverse', {
      method: 'POST',
      json: { lat: 45.123457, lng: 25.987654 },
    });
    expect(await screen.findByText('Filled from: Str. Lungă 5, Brașov')).toBeInTheDocument();
    expect(screen.getByLabelText('Address')).toHaveValue('Str. Lungă 5');
    expect(screen.getByLabelText('City')).toHaveValue('Brașov');

    request.mockResolvedValueOnce({ configured: false, result: null });
    await userEvent.click(screen.getByRole('button', { name: 'Fill address from the pin' }));
    expect(await screen.findByText('Address lookup is not configured on the server.')).toBeInTheDocument();
  });
});

describe('layerStatusText', () => {
  it('says what is drawn and how to see more', () => {
    expect(layerStatusText(null, 7)).toBe('Loading assets…');
    expect(layerStatusText({ loading: false, error: null, count: 1253, truncated: false }, 7)).toMatch(
      /^1253 assets in view · grouped/,
    );
    expect(layerStatusText({ loading: false, error: null, count: 1, truncated: false }, 15)).toBe(
      '1 asset in view',
    );
    expect(layerStatusText({ loading: false, error: null, count: 5000, truncated: true }, 13)).toMatch(
      /first 5000/,
    );
    expect(layerStatusText({ loading: false, error: 'Boom', count: null, truncated: false }, 13)).toBe(
      'Boom',
    );
  });
});
