// PLACE-1018: the PlaceSchema menu a linked account gets in game. Once the sidecar says the account
// is linked: the PlaceSchema mark (top left) and a double-hamburger (top right) open one panel with
// the linked key, the copies carried from other worlds, and the avatar choice (WoC's own body, the
// carried Minecraft skin, or PlaceSchema's generic black-and-white body), which switches live and is
// kept per WoC account. WoC's Esc menu also gets a PlaceSchema row (options_view.ts), so the menu is
// reachable in the full and partial tiers. The integrator picks the tier with the game server's
// PLACESCHEMA_MENU, which reaches the client with the sidecar status (placeschema_skin_state.ts):
//   full (default)  mark + menu button + Esc row
//   partial         Esc row only (the mark and button would clash with the game's own UI)
//   off             nothing
// Looks: PlaceSchema's black-and-white hairline tokens (src/styles/components.css, --ps-*).

import {
  type AvatarChoice,
  avatarChoice,
  onAvatarChoiceChange,
  onPlaceSchemaLinkedChange,
  placeSchemaHolder,
  placeSchemaLinked,
  placeSchemaMenuTier,
  setAvatarChoice,
} from '../placeschema_skin_state';
import { esc } from './esc';
import { t } from './i18n';

/** What the panel lists as carried: copies in the bags or worn that came from another world. */
export interface CarriedSource {
  inventory: readonly { itemId: string; instance?: unknown }[];
  equipmentInstances?: Partial<Record<string, unknown>>;
  /** worn item ids by slot, to name a worn copy that carries no name of its own */
  equipment?: Partial<Record<string, string | null | undefined>>;
}

/** A copy carried from another world: its PlaceSchema grant rides on the instance (psGrant). */
export function carriedNames(world: CarriedSource, nameOf: (itemId: string) => string): string[] {
  const named = (instance: unknown, itemId?: string): string | undefined => {
    const i = instance as { psGrant?: unknown; name?: unknown } | undefined;
    if (typeof i?.psGrant !== 'string') return undefined;
    return typeof i.name === 'string' && i.name ? i.name : itemId ? nameOf(itemId) : undefined;
  };
  const out: string[] = [];
  for (const [slot, inst] of Object.entries(world.equipmentInstances ?? {})) {
    const n = named(inst, world.equipment?.[slot] ?? undefined);
    if (n) out.push(n);
  }
  for (const slot of world.inventory) {
    const n = named(slot.instance, slot.itemId);
    if (n) out.push(n);
  }
  return out;
}

// NIP-19 npub: bech32 of the 32-byte key (BIP-173), as the holder knows it.
const BECH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
  }
  return chk;
}
export function npubOf(hex: string): string {
  const bytes = hex.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? [];
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >>> bits) & 31);
    }
  }
  if (bits) words.push((acc << (5 - bits)) & 31);
  const hrp = 'npub';
  const expand = [...hrp].map((c) => c.charCodeAt(0) >> 5);
  const values = [...expand, 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31), ...words];
  const mod = polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  const check = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...check].map((w) => BECH[w]).join('')}`;
}
export const shortNpub = (hex: string): string => {
  const n = npubOf(hex);
  return `${n.slice(0, 12)}…${n.slice(-6)}`;
};

const CHOICES: readonly AvatarChoice[] = ['native', 'minecraft', 'generic'];
const MARK = '/placeschema/logo-white.png';

/** Mount the mark, the menu button and the panel. Returns an unmount (tests). */
export function mountPlaceSchemaMenu(deps: {
  world: () => CarriedSource | null;
  itemName: (itemId: string) => string;
  root?: HTMLElement;
}): () => void {
  const root = deps.root ?? document.body;
  const mark = document.createElement('img');
  mark.className = 'ps-menu-mark';
  mark.src = MARK;
  mark.alt = 'PlaceSchema';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ps-menu-button';
  button.setAttribute('aria-label', t('hudChrome.placeschemaMenu.open'));
  button.innerHTML = '<span></span><span></span>'; // the double-hamburger
  const panel = document.createElement('div');
  panel.className = 'ps-menu-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('hudChrome.placeschemaMenu.title'));
  panel.hidden = true;
  root.append(mark, button, panel);

  // Top right, just left of WoC's minimap and zone label (which own the corner); the corner itself
  // when there is none. ponytail: re-placed on paint and resize; a moved minimap frame follows on
  // the next paint.
  const place = (): void => {
    const wrap = document.getElementById('minimap-wrap')?.getBoundingClientRect();
    button.style.right =
      wrap && wrap.width ? `${Math.round(window.innerWidth - wrap.left + 8)}px` : '';
  };
  const paint = (): void => {
    const linked = placeSchemaLinked() === true && placeSchemaMenuTier() !== 'off';
    mark.hidden = button.hidden = !linked || placeSchemaMenuTier() !== 'full';
    if (!button.hidden) place();
    if (!linked) panel.hidden = true;
    if (panel.hidden) return;
    const holder = placeSchemaHolder();
    const world = deps.world();
    const carried = world ? carriedNames(world, deps.itemName) : [];
    const current = avatarChoice();
    panel.innerHTML = `<div class="ps-menu-head"><img src="${MARK}" alt=""><span>${esc(t('hudChrome.placeschemaMenu.title'))}</span><button type="button" class="ps-menu-close" data-ps-close aria-label="${esc(t('hudChrome.placeschemaMenu.close'))}">×</button></div>
<div class="ps-menu-row"><div class="ps-menu-label">${esc(t('hudChrome.placeschemaMenu.account'))}</div><div class="ps-menu-mono">${holder ? esc(shortNpub(holder)) : '—'}</div></div>
<div class="ps-menu-row"><div class="ps-menu-label">${esc(t('hudChrome.placeschemaMenu.avatar'))}</div><div class="ps-menu-choices">${CHOICES.map((c) => `<button type="button" class="ps-menu-choice${c === current ? ' is-on' : ''}" data-ps-avatar="${c}" aria-pressed="${c === current}">${esc(t(`hudChrome.placeschemaMenu.${c}` as const))}</button>`).join('')}</div></div>
<div class="ps-menu-row"><div class="ps-menu-label">${esc(t('hudChrome.placeschemaMenu.carried'))}</div>${carried.length ? `<ul class="ps-menu-list">${carried.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : `<div class="ps-menu-dim">${esc(t('hudChrome.placeschemaMenu.carriedNone'))}</div>`}</div>`;
  };
  const open = (): void => {
    if (placeSchemaLinked() !== true || placeSchemaMenuTier() === 'off') return;
    panel.hidden = false;
    paint();
  };
  const close = (): void => {
    panel.hidden = true;
  };

  button.addEventListener('click', () => (panel.hidden ? open() : close()));
  panel.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const choice = el.closest<HTMLElement>('[data-ps-avatar]')?.dataset.psAvatar as
      | AvatarChoice
      | undefined;
    if (choice && CHOICES.includes(choice)) setAvatarChoice(choice);
    else if (el.closest('[data-ps-close]')) close();
  });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !panel.hidden) {
      e.stopImmediatePropagation(); // our panel closes first; WoC's Esc menu stays shut
      close();
    }
  };
  const onOpen = (): void => open();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  document.addEventListener('placeschema:open-menu', onOpen);
  onPlaceSchemaLinkedChange(paint);
  const offChoice = onAvatarChoiceChange(paint);
  paint();
  return () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    document.removeEventListener('placeschema:open-menu', onOpen);
    offChoice();
    mark.remove();
    button.remove();
    panel.remove();
  };
}
