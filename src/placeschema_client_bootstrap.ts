import type { CharacterSummary } from './net/online';
import { restoreCarriedSkin } from './placeschema_skin_state';
import type { CharacterPreview } from './render/characters';
import { carriedWeaponVisualId } from './render/characters/assets';
import { ITEMS } from './sim/data';
import { itemDisplayName } from './ui/entity_i18n';
import { mountPlaceSchemaMenu } from './ui/placeschema_menu';
import type { IWorld } from './world_api';

/** Compose the linked account menu using the client's localized item names. */
export function mountPlaceSchemaClientMenu(world: () => IWorld): void {
  mountPlaceSchemaMenu({
    world,
    itemName: (id) => (ITEMS[id] ? itemDisplayName(ITEMS[id]) : id),
  });
}

/** Restore the account's carried body and resolve its roster weapon as it loads. */
export function prepareCarriedCharselect(
  preview: CharacterPreview,
  character: CharacterSummary,
  refresh: () => void,
): string | null {
  restoreCarriedSkin();
  preview.wearCarried(true);
  return carriedWeaponVisualId(
    character.mainhandItemId ?? null,
    { psMesh: (character as { mainhandMesh?: unknown }).mainhandMesh },
    refresh,
  );
}
