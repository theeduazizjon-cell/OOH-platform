import type { LocationItem } from '@ooh/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { googleMapsLink, parseCoordinates, PinEditor } from './location-pin';

const location = (over: Partial<LocationItem> = {}): LocationItem => ({
  id: 'l1',
  campaignId: 'c1',
  name: 'Carrefour Sinaia',
  address: 'Bd. Carol I 25',
  city: 'Sinaia',
  county: 'Prahova',
  startDate: null,
  endDate: null,
  requestedUnits: 7,
  buyer: null,
  status: 'DRAFT',
  previousStatus: null,
  holdReason: null,
  cancelReason: null,
  researchRadiusM: null,
  briefLineId: null,
  storePoint: null,
  geocodeStatus: 'FAILED',
  geocodedAddress: null,
  geocodeError: 'The address was not found.',
  pinConfirmedAt: null,
  version: 3,
  actions: ['hold', 'cancel'],
  ...over,
});

describe('parseCoordinates', () => {
  it('reads plain pairs and Google Maps links', () => {
    expect(parseCoordinates('45.3486, 25.5517')).toEqual({ lat: 45.3486, lng: 25.5517 });
    expect(parseCoordinates(' 45.3486 25.5517 ')).toEqual({ lat: 45.3486, lng: 25.5517 });
    expect(parseCoordinates('https://www.google.com/maps/place/X/@45.3486,25.5517,17z/data=!3m1')).toEqual({
      lat: 45.3486,
      lng: 25.5517,
    });
    expect(parseCoordinates('https://www.google.com/maps/search/?api=1&query=45.3486%2C25.5517')).toEqual({
      lat: 45.3486,
      lng: 25.5517,
    });
    expect(parseCoordinates('https://maps.google.com/?q=-33.8,151.2')).toEqual({ lat: -33.8, lng: 151.2 });
  });

  it('refuses anything that is not a point', () => {
    expect(parseCoordinates('Bd. Carol I 25, Sinaia')).toBeNull();
    expect(parseCoordinates('95, 25')).toBeNull();
    expect(parseCoordinates('')).toBeNull();
  });
});

describe('googleMapsLink', () => {
  it('opens the pin, or searches the address when there is none', () => {
    expect(googleMapsLink(location({ storePoint: { lat: 45.3486, lng: 25.5517 } }))).toBe(
      'https://www.google.com/maps/search/?api=1&query=45.3486%2C25.5517',
    );
    expect(googleMapsLink(location())).toContain(
      encodeURIComponent('Carrefour Sinaia, Bd. Carol I 25, Sinaia, Prahova, Romania'),
    );
  });
});

describe('PinEditor', () => {
  it('accepts the geocoder suggestion as is', async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render(
      <PinEditor
        location={location({
          geocodeStatus: 'RESOLVED',
          storePoint: { lat: 45.3486, lng: 25.5517 },
          geocodeError: null,
        })}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Use this pin' }));
    expect(onSave).toHaveBeenCalledWith({ lat: 45.3486, lng: 25.5517 });
  });

  it('takes a pasted Google Maps link, and explains what it needs otherwise', async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render(<PinEditor location={location()} onSave={onSave} onCancel={vi.fn()} />);
    expect(screen.getByText('The address was not found.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use this pin' })).not.toBeInTheDocument();
    const input = screen.getByLabelText('Coordinates or Google Maps link');
    await userEvent.type(input, 'Sinaia');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm pin' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/Paste coordinates/)).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, 'https://www.google.com/maps/@45.35,25.55,18z');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm pin' }));
    expect(onSave).toHaveBeenCalledWith({ lat: 45.35, lng: 25.55 });
  });
});
