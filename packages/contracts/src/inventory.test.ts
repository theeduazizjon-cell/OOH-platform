import { describe, expect, it } from 'vitest';
import { attributeProblems, DEFAULT_ASSET_TYPES } from './inventory';

const pole = DEFAULT_ASSET_TYPES.find((t) => t.key === 'pole')!.attributeSchema;

describe('attributeProblems', () => {
  it('accepts values that match the type schema', () => {
    expect(attributeProblems(pole, { material: 'metal', poleHeightM: 6.5 })).toEqual([]);
    expect(attributeProblems(pole, {})).toEqual([]);
  });

  it('reports unknown keys, wrong types, values outside the list and missing required ones', () => {
    expect(attributeProblems(pole, { colour: 'red' })).toEqual([
      { path: 'attributes.colour', message: 'Not an attribute of this type' },
    ]);
    expect(attributeProblems(pole, { poleHeightM: '6' })[0]?.message).toBe(
      'Pole height (m) must be a number',
    );
    expect(attributeProblems(pole, { material: 'plastic' })[0]?.message).toBe(
      'Material is one of metal, concrete, wood',
    );
    expect(attributeProblems({ n: { type: 'integer', label: 'Count' } }, { n: 1.5 })[0]?.message).toBe(
      'Count must be a whole number',
    );
    expect(attributeProblems({ p: { type: 'string', label: 'Permit', required: true } }, {})).toEqual([
      { path: 'attributes.p', message: 'Permit is required' },
    ]);
  });

  it('default templates are consistent', () => {
    for (const t of DEFAULT_ASSET_TYPES) {
      expect(t.codePrefix).toMatch(/^[A-Z][A-Z0-9]{1,9}$/);
      expect(t.facesPerMount).toBeGreaterThanOrEqual(1);
      if (t.maxMountPositions !== null)
        expect(t.maxMountPositions).toBeGreaterThanOrEqual(t.defaultMountPositions);
    }
  });
});
