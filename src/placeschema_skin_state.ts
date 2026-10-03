// The local player's Minecraft skin, when they arrived through PlaceSchema (PLACE-410). The server
// sends it once per session as a `{t:'placeschema', kind:'skin'}` frame (net/placeschema_frame.ts);
// the renderer wraps it on a Minecraft-shaped body (render/characters/minecraft_skin_body.ts).
// Kept in memory only, like the server side: never stored.

export interface CarriedSkin {
  /** data:image/png;base64,... (a 64x64 Minecraft skin) */
  url: string;
  model: 'classic' | 'slim';
}

let skin: CarriedSkin | null = null;

export const carriedSkin = (): CarriedSkin | null => skin;

/** PLACE-479: is this account linked to PlaceSchema? null until the sidecar has answered (no
 *  sidecar, offline: the bag shows no link button at all). */
let linked: boolean | null = null;
const linkListeners = new Set<() => void>();

export const placeSchemaLinked = (): boolean | null => linked;

export function setPlaceSchemaLinked(next: boolean | null): void {
  if (linked === next) return;
  linked = next;
  for (const f of linkListeners) f();
}

export function onPlaceSchemaLinkedChange(f: () => void): void {
  linkListeners.add(f);
}

export function setCarriedSkin(next: CarriedSkin | null): void {
  skin = next;
}
