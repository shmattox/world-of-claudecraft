// PLACE-490: which garment GLB a WoC armor item wears in other PlaceSchema worlds.
//
// WoC's armor is the KayKit class kits (Kay Lousberg, KayKit Character Pack: Adventurers 2.0, CC0 1.0;
// CREDITS.md), carved into slots inside the modular body. An armor item has no look of its own here
// (every character wears its class kit), so its armor type picks the kit: cloth wears the mage kit,
// leather the ranger's, mail the knight's (approved 2026-10-10). The garments are extracted by
// scripts/assets/placeschema_garments.ts into public/placeschema/garments/, and the WoC
// sidecar stamps them as `render-asset:` through SIDECAR_LOOKS / SIDECAR_OPEN_LOOKS.

import type { ArmorType, EquipSlot } from '../src/sim/types';

export const ARMOR_TYPE_KIT: Record<ArmorType, 'mage' | 'ranger' | 'knight'> = {
  cloth: 'mage',
  leather: 'ranger',
  mail: 'knight',
};

/** The modular piece each WoC item slot is drawn with; waist, neck, rings and trinkets have none. */
export const ITEM_SLOT_PIECE: Partial<Record<EquipSlot | 'back', string>> = {
  helmet: 'head',
  chest: 'chest',
  shoulder: 'arms',
  gloves: 'hands',
  legs: 'legs',
  feet: 'feet',
  back: 'back',
};

/** The modular nodes of each piece (src/render/characters/modular.ts ARMOR_BY_SET). */
export const PIECE_PARTS: Record<string, string[]> = {
  head: ['Head', 'Head1'],
  chest: ['Chest'],
  arms: ['ArmL', 'ArmR'],
  hands: ['HandL', 'HandR'],
  legs: ['LegL', 'LegR'],
  feet: ['FootL', 'FootR'],
  back: ['Back', 'Back1'],
};

/** Outside public/models on purpose: these are for other worlds, so WoC's own model gates (KTX2-only
 *  textures, the generated media manifest) do not apply, and they ship PNG (deployed PlaceSchema worlds
 *  cannot run the KTX2 transcoder). */
export const GARMENT_DIR = 'placeschema/garments';

/** The garment file for an armor item (e.g. `knight_legs.glb`), or undefined when it has none. Whether
 *  that kit has the piece is decided by the files the extraction wrote (`exists`). */
export function garmentFile(
  def: { kind: string; slot?: string; armorType?: string },
  exists: (file: string) => boolean,
): string | undefined {
  if (def.kind !== 'armor' || !def.slot || !def.armorType) return undefined;
  const kit = ARMOR_TYPE_KIT[def.armorType as ArmorType];
  const piece = ITEM_SLOT_PIECE[def.slot as EquipSlot];
  if (!kit || !piece) return undefined;
  const file = `${kit}_${piece}.glb`;
  return exists(file) ? file : undefined;
}
