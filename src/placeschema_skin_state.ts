// The local player's Minecraft skin, when they arrived through PlaceSchema (PLACE-410). The server
// sends it once per session as a `{t:'placeschema', kind:'skin'}` frame (net/placeschema_frame.ts);
// the renderer wraps it on a Minecraft-shaped body (render/characters/minecraft_skin_body.ts). The
// server never stores it; this browser remembers the last one per WoC account (PLACE-955) so
// character-select shows it before the world sends it again.

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

/** PLACE-954: the destination's own picture (its manifest preview), shown in the portal; null until
 *  the server sends it, and then the PlaceSchema mark stands in. */
let destination: string | null = null;
export const portalDestinationPicture = (): string | null => destination;
export function setPortalDestinationPicture(url: string | null): void {
  destination = url;
}

export function setCarriedSkin(next: CarriedSkin | null): void {
  skin = next;
  const key = rememberedKey();
  try {
    if (key && next) localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* storage full or blocked: char-select just shows WoC's own body */
  }
}

/** Char-select: the skin this browser last saw for the signed-in WoC account, or none (so one
 *  account's skin never shows on another's characters). The world sends the live one again. */
export function restoreCarriedSkin(): void {
  skin = null;
  const key = rememberedKey();
  try {
    const saved = JSON.parse(
      (key && localStorage.getItem(key)) || 'null',
    ) as Partial<CarriedSkin> | null;
    if (typeof saved?.url === 'string' && /^data:image\/png;base64,/.test(saved.url))
      skin = { url: saved.url, model: saved.model === 'slim' ? 'slim' : 'classic' };
  } catch {
    /* nothing remembered */
  }
}

/** `placeschema.skin.v1.<username>` for the signed-in account (net/online.ts SESSION_KEY). */
function rememberedKey(): string | null {
  try {
    const user = (
      JSON.parse(localStorage.getItem('woc_session') ?? 'null') as { username?: unknown }
    )?.username;
    return typeof user === 'string' && user ? `placeschema.skin.v1.${user}` : null;
  } catch {
    return null;
  }
}
