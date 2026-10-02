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

export function setCarriedSkin(next: CarriedSkin | null): void {
  skin = next;
}
