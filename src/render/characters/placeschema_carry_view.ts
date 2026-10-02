// What the renderer shows for PlaceSchema carry (PLACE-410): the held weapon id (a carried copy's
// own mesh once resident, else the equipped item) and the local player's arriving Minecraft skin.

import type { Entity } from '../../sim/types';
import { carriedWeaponVisualId } from './assets';

export { wearCarriedSkin } from './minecraft_skin_body';

export const heldWeaponId = (e: Entity): string | null =>
  carriedWeaponVisualId(e.mainhandItemId, e.equippedInstances?.mainhand);
