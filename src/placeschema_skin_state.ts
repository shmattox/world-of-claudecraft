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

/** PLACE-412: other players' carried skins, by entity id (the server sends them with a pid). Never
 *  remembered: the server resets them on every connection and sends those of everyone still here.
 *  ponytail: grows with arrivals during one connection, no eviction (evicting would undress a visible player). */
const peers = new Map<number, CarriedSkin>();
export const carriedSkinFor = (pid: number): CarriedSkin | null => peers.get(pid) ?? null;
export function setPeerSkin(pid: number, next: CarriedSkin): void {
  peers.set(pid, next);
}
export function clearPeerSkins(): void {
  peers.clear();
}

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

/** PLACE-1018: how much PlaceSchema menu this realm shows, from the server's PLACESCHEMA_MENU (sent
 *  with the status): full = mark + menu button + Esc row, partial = Esc row only, off = nothing. */
export type MenuTier = 'full' | 'partial' | 'off';
export function menuTier(raw: unknown): MenuTier {
  return raw === 'partial' || raw === 'off' ? raw : 'full';
}
let tier: MenuTier = 'full';
export const placeSchemaMenuTier = (): MenuTier => tier;
export function setPlaceSchemaMenuTier(next: MenuTier): void {
  if (tier === next) return;
  tier = next;
  for (const f of linkListeners) f();
}

/** PLACE-1018: the linked holder's key (hex), for the PlaceSchema menu's account line. */
let holder: string | null = null;
export const placeSchemaHolder = (): string | null => holder;
export function setPlaceSchemaHolder(next: string | null): void {
  holder = next;
}

/** PLACE-1018: which body the local player wears: WoC's own (`native`), the carried Minecraft skin,
 *  or PlaceSchema's generic black-and-white body. Kept per WoC account in this browser. */
export type AvatarChoice = 'native' | 'minecraft' | 'generic';
const CHOICES: readonly AvatarChoice[] = ['native', 'minecraft', 'generic'];
let choice: AvatarChoice | null = null; // read once, then cached (wearCarriedSkin asks every frame)
const choiceListeners = new Set<() => void>();
export function avatarChoice(): AvatarChoice {
  if (choice) return choice;
  let saved: unknown = null;
  try {
    const key = rememberedKey();
    saved = key && localStorage.getItem(`${key.replace('.skin.', '.avatar.')}`);
  } catch {
    /* storage blocked: the default */
  }
  choice = CHOICES.includes(saved as AvatarChoice) ? (saved as AvatarChoice) : 'minecraft';
  return choice;
}
export function setAvatarChoice(next: AvatarChoice): void {
  choice = next;
  try {
    const key = rememberedKey();
    if (key) localStorage.setItem(key.replace('.skin.', '.avatar.'), next);
  } catch {
    /* storage blocked: kept for this page only */
  }
  for (const f of choiceListeners) f();
}
export function onAvatarChoiceChange(f: () => void): () => void {
  choiceListeners.add(f);
  return () => choiceListeners.delete(f);
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
  choice = null; // PLACE-1018: this account's own avatar choice
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
      JSON.parse(localStorage.getItem('woc_session') ?? 'null') as {
        username?: unknown;
      }
    )?.username;
    return typeof user === 'string' && user ? `placeschema.skin.v1.${user}` : null;
  } catch {
    return null;
  }
}
