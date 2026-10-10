// PLACE-776: other worlds fetch a carried WoC weapon's mesh straight from WoC's static models.
import { describe, expect, it } from 'vitest';
import { placeschemaStaticCors } from '../../server/placeschema_static_cors';

describe('placeschemaStaticCors', () => {
  it('opens the weapon models to any origin', () => {
    expect(placeschemaStaticCors('/models/weapons/sword_d.glb')).toEqual({
      'Access-Control-Allow-Origin': '*',
    });
  });
  it('opens the PlaceSchema garments to any origin (PLACE-490)', () => {
    expect(placeschemaStaticCors('/placeschema/garments/ranger_legs.glb')).toEqual({
      'Access-Control-Allow-Origin': '*',
    });
  });
  it('leaves every other static path same-origin', () => {
    for (const p of [
      '/index.html',
      '/models/characters/knight.glb',
      '/models/weapons',
      '/placeschema/logo-white.png',
      '/assets/x.js',
    ])
      expect(placeschemaStaticCors(p)).toEqual({});
  });
});
