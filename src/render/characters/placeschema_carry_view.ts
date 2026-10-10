// What the renderer shows for PlaceSchema carry (PLACE-410): the held weapon id (a carried copy's
// own mesh once resident, else the equipped item), the local player's arriving Minecraft skin, and the
// PlaceSchema portal (PLACE-954).

import type { Entity } from '../../sim/types';
import { carriedWeaponVisualId } from './assets';

export { wearCarriedSkin } from './minecraft_skin_body';
export { PlaceSchemaPortals } from '../placeschema_portal';

export const heldWeaponId = (e: Entity): string | null =>
  carriedWeaponVisualId(e.mainhandItemId, e.equippedInstances?.mainhand);
