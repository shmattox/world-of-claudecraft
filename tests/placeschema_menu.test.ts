// @vitest-environment happy-dom
// PLACE-1018: the PlaceSchema menu a linked account gets in game: hidden until linked, the full and
// partial tiers, the Esc-menu row, and the avatar choice (persisted per WoC account; Native skips
// the carried skin).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPlaceSchemaFrame } from '../src/net/placeschema_frame';
import {
  avatarChoice,
  effectiveAvatarChoice,
  menuTier,
  placeSchemaPortalArt,
  restoreCarriedSkin,
  setAvatarChoice,
  setCarriedSkin,
  setPlaceSchemaAvatarUnavailable,
  setPlaceSchemaHolder,
  setPlaceSchemaLinked,
  setPlaceSchemaMenuTier,
} from '../src/placeschema_skin_state';
import { ownSkin } from '../src/render/characters/minecraft_skin_body';
import { buildOptionsMenu } from '../src/ui/options_view';
import { carriedNames, mountPlaceSchemaMenu, npubOf } from '../src/ui/placeschema_menu';

const SKIN = { url: 'data:image/png;base64,QUFB', model: 'slim' as const };
const world = () => ({
  inventory: [
    { itemId: 'worn_sword', instance: { psGrant: 'g'.repeat(64), name: 'Z-blade' } },
    { itemId: 'bread', instance: undefined },
  ],
  equipmentInstances: { mainhand: { psGrant: 'h'.repeat(64) } },
});
let unmount: (() => void) | undefined;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('woc_session', JSON.stringify({ username: 'alex' }));
  restoreCarriedSkin();
  setPlaceSchemaLinked(null);
  setPlaceSchemaHolder(null);
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
});

const mount = (tier: 'full' | 'partial' | 'off') => {
  setPlaceSchemaMenuTier(tier);
  unmount = mountPlaceSchemaMenu({ world, itemName: (id) => `item:${id}` });
};
const shown = (sel: string) => {
  const el = document.querySelector<HTMLElement>(sel);
  return !!el && !el.hidden;
};

describe('the PlaceSchema menu (PLACE-1018)', () => {
  it('is hidden until the account is linked, then the full tier shows the mark and button', () => {
    mount('full');
    expect(shown('.ps-menu-mark') || shown('.ps-menu-button')).toBe(false);
    setPlaceSchemaLinked(true);
    expect(shown('.ps-menu-mark')).toBe(true);
    expect(shown('.ps-menu-button')).toBe(true);
    document.querySelector<HTMLButtonElement>('.ps-menu-button')!.click();
    expect(shown('.ps-menu-panel')).toBe(true);
  });

  it('the partial tier hides the mark and button, and the Esc row still opens the menu', () => {
    mount('partial');
    setPlaceSchemaLinked(true);
    expect(shown('.ps-menu-mark') || shown('.ps-menu-button')).toBe(false);
    document.dispatchEvent(new Event('placeschema:open-menu'));
    expect(shown('.ps-menu-panel')).toBe(true);
  });

  it('the off tier shows nothing, even on the Esc event; the tier rides the server status', () => {
    mount('off');
    setPlaceSchemaLinked(true);
    document.dispatchEvent(new Event('placeschema:open-menu'));
    expect(shown('.ps-menu-mark') || shown('.ps-menu-button') || shown('.ps-menu-panel')).toBe(
      false,
    );
    applyPlaceSchemaFrame({ kind: 'status', linked: true, menu: 'full' });
    expect(shown('.ps-menu-button')).toBe(true);
    // PLACE-1026: the portal art rides the same status; anything but custom is default
    applyPlaceSchemaFrame({ kind: 'status', linked: true, art: 'custom' });
    expect(placeSchemaPortalArt()).toBe('custom');
    applyPlaceSchemaFrame({ kind: 'status', linked: true, art: 'x' });
    expect(placeSchemaPortalArt()).toBe('default');
    expect([menuTier(undefined), menuTier('partial'), menuTier('off'), menuTier('x')]).toEqual([
      'full',
      'partial',
      'off',
      'full',
    ]);
  });

  it('the Esc menu has a PlaceSchema row only for a linked account', () => {
    const base = {
      bugReportAvailable: false,
      interfaceUnlockAvailable: false,
      interfaceUnlocked: false,
    };
    const rows = (on: boolean) =>
      buildOptionsMenu({ ...base, placeSchemaAvailable: on }).map((e) => e.action.kind);
    expect(rows(true)).toContain('placeschema');
    expect(rows(false)).not.toContain('placeschema');
  });

  it('the avatar choice switches from the panel and persists per WoC account', () => {
    mount('full');
    setPlaceSchemaLinked(true);
    document.dispatchEvent(new Event('placeschema:open-menu'));
    document.querySelector<HTMLButtonElement>('[data-ps-avatar="native"]')!.click();
    expect(avatarChoice()).toBe('native');
    restoreCarriedSkin(); // a fresh page (or char-select) reads it back
    expect(avatarChoice()).toBe('native');
    localStorage.setItem('woc_session', JSON.stringify({ username: 'sam' }));
    restoreCarriedSkin(); // another account keeps its own (the default)
    expect(avatarChoice()).toBe('carried');
  });

  it('PLACE-1157: a choice saved under its old name, minecraft, reads as carried', () => {
    localStorage.setItem('woc_session', JSON.stringify({ username: 'old' }));
    restoreCarriedSkin();
    setAvatarChoice('native'); // find this account's key, then write the legacy word under it
    const key = Object.keys(localStorage).find((k) => k.includes('.avatar.'))!;
    localStorage.setItem(key, 'minecraft');
    restoreCarriedSkin();
    expect(avatarChoice()).toBe('carried');
  });

  it('PLACE-1157: an arrival frame wears its avatar choice once per landing; a choice made here stands', () => {
    setPlaceSchemaHolder('ab'.repeat(32));
    setAvatarChoice('carried');
    const landing = 'cd'.repeat(16);
    expect(applyPlaceSchemaFrame({ kind: 'avatar', choice: 'generic', landing })).toBe('avatar');
    expect(avatarChoice()).toBe('generic');
    setAvatarChoice('native'); // the player changes it here
    expect(applyPlaceSchemaFrame({ kind: 'avatar', choice: 'generic', landing })).toBeNull(); // the same landing again
    expect(avatarChoice()).toBe('native');
    expect(applyPlaceSchemaFrame({ kind: 'avatar', choice: 'dragon', landing: 'ef'.repeat(16) })).toBeNull();
    expect(applyPlaceSchemaFrame({ kind: 'avatar', choice: 'carried', landing: 'nope' })).toBeNull();
    expect(applyPlaceSchemaFrame({ kind: 'avatar', choice: 'carried', landing: 'ef'.repeat(16) })).toBe('avatar');
    expect(avatarChoice()).toBe('carried');
    setPlaceSchemaHolder(null);
  });

  it('Native skips the carried skin; Minecraft wears it', () => {
    setCarriedSkin(SKIN);
    setAvatarChoice('carried');
    expect(ownSkin()).toEqual(SKIN);
    setAvatarChoice('native');
    expect(ownSkin()).toBeNull();
    setCarriedSkin(null);
  });

  it('PLACE-1129: no carried skin: Minecraft is disabled with a reason and WoC is what shows', () => {
    setCarriedSkin(null);
    setAvatarChoice('carried');
    mount('full');
    setPlaceSchemaLinked(true);
    document.dispatchEvent(new Event('placeschema:open-menu'));
    const mc = document.querySelector<HTMLButtonElement>('[data-ps-avatar="carried"]')!;
    expect(mc.disabled).toBe(true);
    expect(mc.title).toMatch(/No Minecraft skin/);
    expect(document.querySelector('[data-ps-avatar="native"]')!.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(effectiveAvatarChoice()).toBe('native');
    expect(ownSkin()).toBeNull();
    setCarriedSkin(SKIN); // a skin arrives: the choice stands and is worn
    expect(effectiveAvatarChoice()).toBe('carried');
    expect(ownSkin()).toEqual(SKIN);
    setCarriedSkin(null);
  });

  it('PLACE-1129: an Avatar that cannot load disables PlaceSchema with a reason; WoC shows', () => {
    setAvatarChoice('generic');
    setPlaceSchemaAvatarUnavailable(true);
    mount('full');
    setPlaceSchemaLinked(true);
    document.dispatchEvent(new Event('placeschema:open-menu'));
    const ps = document.querySelector<HTMLButtonElement>('[data-ps-avatar="generic"]')!;
    expect(ps.disabled).toBe(true);
    expect(ps.title).toMatch(/couldn't be loaded/);
    expect(effectiveAvatarChoice()).toBe('native');
    expect(document.querySelector('[data-ps-avatar="native"]')!.getAttribute('aria-pressed')).toBe(
      'true',
    );
    setPlaceSchemaAvatarUnavailable(false);
  });

  it('PLACE-1129: PlaceSchema wears no Minecraft skin (it is the Avatar body, not a skin)', () => {
    setCarriedSkin(SKIN);
    setAvatarChoice('generic');
    expect(ownSkin()).toBeNull();
    setCarriedSkin(null);
  });

  it('lists the copies carried from other worlds, worn and in the bags', () => {
    const w = { ...world(), equipment: { mainhand: 'worn_sword' } };
    expect(carriedNames(w, (id) => `item:${id}`)).toEqual(['item:worn_sword', 'Z-blade']);
  });

  it('writes the key as a NIP-19 npub', () => {
    expect(npubOf('3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d')).toBe(
      'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6',
    );
  });
});
