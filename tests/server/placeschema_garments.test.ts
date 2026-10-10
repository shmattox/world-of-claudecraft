// PLACE-490: WoC armor's garment looks for other PlaceSchema worlds: the armor-type kit mapping, the
// extracted files (scripts/assets/placeschema_garments.ts) and the sidecar config built from them.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GARMENT_DIR, garmentFile } from '../../server/placeschema_garments';
import { ITEMS } from '../../src/sim/data';

const DIR = path.resolve(__dirname, '../../public', GARMENT_DIR);
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8');

describe('WoC garment looks (PLACE-490)', () => {
  it('an armor type picks its kit, a slot its piece; waist and missing pieces have none', () => {
    const all = () => true;
    expect(garmentFile({ kind: 'armor', slot: 'legs', armorType: 'mail' }, all)).toBe(
      'knight_legs.glb',
    );
    expect(garmentFile({ kind: 'armor', slot: 'helmet', armorType: 'cloth' }, all)).toBe(
      'mage_head.glb',
    );
    expect(garmentFile({ kind: 'armor', slot: 'shoulder', armorType: 'leather' }, all)).toBe(
      'ranger_arms.glb',
    );
    expect(garmentFile({ kind: 'armor', slot: 'waist', armorType: 'mail' }, all)).toBeUndefined();
    expect(garmentFile({ kind: 'weapon', slot: 'mainhand' }, all)).toBeUndefined();
    expect(
      garmentFile(
        { kind: 'armor', slot: 'helmet', armorType: 'leather' },
        (f) => f !== 'ranger_head.glb',
      ),
    ).toBeUndefined();
  });

  it('every look points at an extracted CC0 garment, open to other worlds, never the modular body', () => {
    const provenance = JSON.parse(read('provenance.json')) as Record<string, { licence: string }>;
    const looks = JSON.parse(read('sidecar-looks.json')) as Record<string, string>;
    const open = read('sidecar-open-looks.txt').trim().split(',');
    expect(Object.keys(looks).length).toBeGreaterThan(0);
    for (const [type, url] of Object.entries(looks)) {
      const file = url.slice(url.lastIndexOf('/') + 1);
      expect(fs.existsSync(path.join(DIR, file)), file).toBe(true);
      expect(provenance[file]?.licence).toBe('CC0-1.0');
      expect(open).toContain(url);
      expect(url).not.toMatch(/warrior_modular/);
      const def = ITEMS[type.replace('armor.woc.', '')];
      expect(def?.kind).toBe('armor');
    }
  });

  it('garments need no KTX2 transcoder (deployed worlds block it) and keep their skins', () => {
    for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.glb'))) {
      const glb = fs.readFileSync(path.join(DIR, file));
      const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
      expect(gltf.extensionsUsed ?? [], file).not.toContain('KHR_texture_basisu');
      expect(gltf.skins?.length ?? 0, file).toBeGreaterThan(0);
      expect(gltf.animations ?? [], file).toEqual([]);
    }
  });
});
