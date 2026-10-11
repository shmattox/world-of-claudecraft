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

/** PLACE-1071: the body the garments bind to in PlaceSchema worlds, the KayKit knight (Adventurers 1.0,
 *  CC0) its roster serves, named by the SHA-256 of that file (open-place assets/shared/models/knight.glb,
 *  checked by its scripts/assets/kaykit-body-check.mjs). Same Rig_Medium skeleton, so no fitting. */
export const KNIGHT_BODY_HASH = 'ce0d0a5ec1d67594629ecac20a7576fde22a44456e7628e8eb100891bc6dda97';

/** Each piece's PlaceSchema wardrobe slot (world-kit WARDROBE_REGIONS) and the humanoid bones it covers. */
export const PIECE_SLOT: Record<string, { slot: string; covers: string[] }> = {
  head: { slot: 'head', covers: ['head'] },
  chest: { slot: 'torso', covers: ['spine', 'chest', 'upperChest'] },
  arms: {
    slot: 'shoulder',
    covers: ['leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm'],
  },
  hands: { slot: 'hands', covers: ['leftHand', 'rightHand'] },
  legs: {
    slot: 'legs',
    covers: ['hips', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'],
  },
  feet: { slot: 'feet', covers: ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'] },
  back: { slot: 'back', covers: ['spine', 'chest', 'upperChest'] },
};

/** Rig_Medium joints, keyed as three loads them (punctuation stripped), to the knight body's humanoid
 *  names (open-place world-kit RIG_HUMANOIDS.knight). A key with its `.` left in refuses the garment. */
export const RIG_MEDIUM_BONES: Record<string, string> = {
  root: 'root',
  hips: 'hips',
  spine: 'spine',
  chest: 'chest',
  head: 'head',
  upperarml: 'leftUpperArm',
  lowerarml: 'leftLowerArm',
  wristl: 'wrist.l',
  handl: 'leftHand',
  handslotl: 'handslot.l',
  upperarmr: 'rightUpperArm',
  lowerarmr: 'rightLowerArm',
  wristr: 'wrist.r',
  handr: 'rightHand',
  handslotr: 'handslot.r',
  upperlegl: 'leftUpperLeg',
  lowerlegl: 'leftLowerLeg',
  footl: 'leftFoot',
  toesl: 'leftToes',
  upperlegr: 'rightUpperLeg',
  lowerlegr: 'rightLowerLeg',
  footr: 'rightFoot',
  toesr: 'rightToes',
};

/** Outside public/models on purpose: these are for other worlds, so WoC's own model gates (KTX2-only
 *  textures, the generated media manifest) do not apply, and they ship PNG (deployed PlaceSchema worlds
 *  cannot run the KTX2 transcoder). */
export const GARMENT_DIR = 'placeschema/garments';

/** The garments the extraction writes (scripts/assets/placeschema_garments.ts checks it wrote exactly
 *  these), for the server, which does not read the folder. */
export const GARMENT_FILES: ReadonlySet<string> = new Set([
  'knight_arms.glb',
  'knight_back.glb',
  'knight_chest.glb',
  'knight_feet.glb',
  'knight_hands.glb',
  'knight_head.glb',
  'knight_legs.glb',
  'mage_arms.glb',
  'mage_back.glb',
  'mage_chest.glb',
  'mage_feet.glb',
  'mage_head.glb',
  'mage_legs.glb',
  'ranger_arms.glb',
  'ranger_back.glb',
  'ranger_chest.glb',
  'ranger_feet.glb',
  'ranger_hands.glb',
  'ranger_legs.glb',
]);

/** PLACE-1091: an item's garment binds only to the knight body, so a carried item that has one says
 *  so (`fits:knight`); another body hides it with a reason instead of dropping it silently. */
export function garmentFits(def: { kind: string; slot?: string; armorType?: string }): string[] {
  return garmentFile(def, (f) => GARMENT_FILES.has(f)) ? ['fits:knight'] : [];
}

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
