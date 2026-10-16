import { describe, expect, it } from 'vitest';
import { DEFAULT_ASSET_TYPES } from './inventory';
import {
  attributeOfHeader,
  fieldOfHeader,
  importRequestSchema,
  parseCoordinatePair,
  parseCsv,
  parseDecimal,
} from './inventory-import';

describe('parseCsv', () => {
  it('reads quoted fields, doubled quotes, line breaks in quotes, CRLF, and skips blank lines', () => {
    const { delimiter, rows } = parseCsv(
      'type,address,notes\r\npole,"Bd. Carol I, 25","He said ""ok""\nsecond line"\r\n\r\nbillboard,,\n',
    );
    expect(delimiter).toBe(',');
    expect(rows).toEqual([
      ['type', 'address', 'notes'],
      ['pole', 'Bd. Carol I, 25', 'He said "ok"\nsecond line'],
      ['billboard', '', ''],
    ]);
  });

  it('detects semicolons (Excel in Romanian) and tabs, and drops the BOM', () => {
    expect(parseCsv('﻿Tip;Latitudine;Longitudine\nStâlp;45,3486;25,5517')).toEqual({
      delimiter: ';',
      rows: [
        ['Tip', 'Latitudine', 'Longitudine'],
        ['Stâlp', '45,3486', '25,5517'],
      ],
    });
    expect(parseCsv('type\tlat\nx\t1').delimiter).toBe('\t');
    // A delimiter inside a quoted header doesn't count.
    expect(parseCsv('"a;b",c\n1,2').delimiter).toBe(',');
  });
});

describe('headers', () => {
  it('maps English and Romanian headers, with or without diacritics and punctuation', () => {
    expect(fieldOfHeader('Latitude')).toBe('lat');
    expect(fieldOfHeader('LONGITUDINE')).toBe('lng');
    expect(fieldOfHeader('Județ:')).toBe('county');
    expect(fieldOfHeader('Oraș')).toBe('city');
    expect(fieldOfHeader('cod_vechi')).toBe('externalRef');
    expect(fieldOfHeader('Observații')).toBe('notes');
    expect(fieldOfHeader('Google Maps')).toBe('coordinates');
  });

  it('never takes a row-number column as the reference', () => {
    expect(fieldOfHeader('Nr. crt.')).toBeNull();
    expect(fieldOfHeader('Nr')).toBeNull();
    expect(fieldOfHeader('ID')).toBeNull();
  });

  it('finds attributes by key or label', () => {
    const pole = DEFAULT_ASSET_TYPES.find((t) => t.key === 'pole')!.attributeSchema;
    expect(attributeOfHeader('material', pole)).toBe('material');
    expect(attributeOfHeader('Pole height (m)', pole)).toBe('poleHeightM');
    expect(attributeOfHeader('attr:poleHeightM', pole)).toBe('poleHeightM');
    expect(attributeOfHeader('colour', pole)).toBeNull();
  });
});

describe('numbers and coordinates', () => {
  it('reads decimal points and decimal commas, nothing else', () => {
    expect(parseDecimal('45.3486')).toBe(45.3486);
    expect(parseDecimal(' 45,3486 ')).toBe(45.3486);
    expect(parseDecimal('-7')).toBe(-7);
    expect(parseDecimal('1.234,5')).toBeNull();
    expect(parseDecimal('45°20′')).toBeNull();
    expect(parseDecimal('')).toBeNull();
  });

  it('reads a "lat, lng" pair or a Google Maps link', () => {
    expect(parseCoordinatePair('45.3486, 25.5517')).toEqual({ lat: 45.3486, lng: 25.5517 });
    expect(parseCoordinatePair('45.3486 25.5517')).toEqual({ lat: 45.3486, lng: 25.5517 });
    expect(parseCoordinatePair('https://www.google.com/maps/place/X/@45.3486,25.5517,17z')).toEqual({
      lat: 45.3486,
      lng: 25.5517,
    });
    expect(parseCoordinatePair('https://maps.google.com/?q=45.3486,25.5517')).toEqual({
      lat: 45.3486,
      lng: 25.5517,
    });
    expect(parseCoordinatePair('95.1, 25.5')).toBeNull();
    expect(parseCoordinatePair('Sinaia')).toBeNull();
  });
});

describe('importRequestSchema', () => {
  it('defaults to skipping nothing and wants a real reason for duplicates', () => {
    expect(importRequestSchema.parse({ csv: 'a' })).toEqual({ csv: 'a', skipRows: [] });
    expect(importRequestSchema.safeParse({ csv: 'a', duplicateReason: 'x' }).success).toBe(false);
    expect(importRequestSchema.safeParse({ csv: '' }).success).toBe(false);
  });
});
