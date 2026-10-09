// PlaceSchema carry through the shared sidecar (open-place adapters/sidecar, PLACE-276).
//
// The sidecar holds every key, signs every grant and owns the escrow; this module is the thin
// game side of its HTTP contract (open-place docs/superpowers/specs/2026-09-29-game-adapter-
// contract-design.md): poll /mod/join for each online player and add what arrives, mint a quest
// reward as a signed grant, and carry one item out (remove it first, then /mod/carry-out).
//
// Off unless PLACESCHEMA_SIDECAR_URL and PLACESCHEMA_MOD_TOKEN are set. A player's platform id is
// `<account id>@<realm host>` (spec/nostr.md section 11, platform `woc`), never the username.

import { randomBytes } from 'node:crypto';
import { ITEMS, QUESTS, questRewardItemId } from '../src/sim/data';
import { canEquipItem } from '../src/sim/equipment_rules';
import {
  MAX_RELEASED,
  releasePlaceschemaClaim,
  touchPlaceschemaAccepted,
  unreleasePlaceschemaClaim,
} from '../src/sim/placeschema_accepted';
import { PlaceSchemaPortalGate } from '../src/sim/placeschema_portal';
import type { Sim } from '../src/sim/sim';
import type { InvSlot, ItemInstancePayload } from '../src/sim/types';
import { type AcceptedStore, pgAcceptedStore } from './placeschema_accepted_db';
import { type Skin, skinForHolder } from './placeschema_skin';

/** The carried grant's id rides on the item copy; the copy's `name` is the grant's minted label. */
export const GRANT_KEY = 'psGrant';
const HEX64 = /^[0-9a-f]{64}$/;
/** A cancel answer that settles it for good: nothing of this holder's is there to return. */
const SETTLED = /^(landed|unknown-grant|not-yours)/;
/** A foreign blade or weapon (not minted here) is held as this WoC weapon, named by its grant; its
 *  own mesh rides on the copy when the sidecar's look says `as-is` (MESH_KEY, PLACE-410). */
export const FOREIGN_WEAPON_ID = 'worn_sword';
/** Any other foreign kind (armor, misc, unknown) is held as this bag item, named by its grant. */
export const FOREIGN_KEEPSAKE_ID = 'ps_keepsake';
const WOC_TYPE = /^(?:weapon|armor|misc)\.woc\.([a-z0-9_]{1,48})$/;

/** A WoC item as a template (protocol/src/vocabulary.ts categories: weapon, armor, misc). */
export function templateFor(itemId: string) {
  const def = ITEMS[itemId];
  const shape =
    def.kind === 'weapon'
      ? { category: 'weapon', anchors: ['grip'], affordances: ['hold', 'display'] }
      : def.kind === 'armor'
        ? { category: 'armor', anchors: [] as string[], affordances: ['wear', 'display'] }
        : { category: 'misc', anchors: [] as string[], affordances: ['display'] };
  return {
    type: `${shape.category}.woc.${itemId}`,
    label: def.name,
    features: [`woc:${itemId}`],
    palette: ['#8a6d3b'],
    style_hint: 'woc',
    dimensions: { l: 0.9, w: 0.2, h: 0.1 },
    anchors: shape.anchors,
    affordances: shape.affordances,
  };
}

export interface SidecarConfig {
  url: string;
  token: string;
  realmHost: string;
  /** where Carry sends the player (a canonical origin): their home world */
  home: string;
  /** relays holding the holders' linked accounts (kind 30082), for the arriving skin */
  relays?: string[];
}

export function sidecarConfig(env: NodeJS.ProcessEnv): SidecarConfig | null {
  const url = env.PLACESCHEMA_SIDECAR_URL?.replace(/\/$/, '');
  const token = env.PLACESCHEMA_MOD_TOKEN;
  if (!url || !token) return null;
  return {
    url,
    token,
    realmHost: realmHostOf(env),
    home: env.PLACESCHEMA_HOME ?? '',
    relays: (env.PLACESCHEMA_RELAYS ?? '').split(',').filter((r) => /^wss?:\/\//.test(r)),
  };
}

/**
 * The realm host is the id suffix every platform id carries, so it must be THIS realm's own host:
 * two realms sharing one (the loopback default) would honour each other's account numbers. It comes
 * from PLACESCHEMA_REALM_HOST, else PUBLIC_ORIGIN's host; with neither set, or a loopback host
 * without PLACESCHEMA_ALLOW_LOOPBACK=1 (local development), PlaceSchema refuses to start.
 */
export function realmHostOf(env: NodeJS.ProcessEnv): string {
  const host =
    env.PLACESCHEMA_REALM_HOST ?? (env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).host : undefined);
  if (!host)
    throw new Error(
      "placeschema: set PLACESCHEMA_REALM_HOST (or PUBLIC_ORIGIN) to this realm's own host",
    );
  if (/^(127\.|localhost\b|\[::1\])/.test(host) && env.PLACESCHEMA_ALLOW_LOOPBACK !== '1')
    throw new Error(
      `placeschema: realm host ${host} is loopback; set PLACESCHEMA_ALLOW_LOOPBACK=1 for local development only`,
    );
  return host;
}

/** A quest-reward copy waiting for its mint: the value is the item id. Converted, never duplicated. */
export const PENDING_KEY = 'psPending';
const pendingOf = (slot: InvSlot): string | undefined => {
  const v = (slot.instance as Record<string, unknown> | undefined)?.[PENDING_KEY];
  return typeof v === 'string' ? v : undefined;
};
/** A foreign copy's own mesh: the sidecar media name (content-addressed) the client loads through
 *  the game server's `/api/placeschema/media/<name>` (server/placeschema_media.ts). */
export const MESH_KEY = 'psMesh';
export const MEDIA_NAME = /^ps_[0-9a-f]{32}\.glb$/; // open-place tools/look-plan plan.ts names
const signedInstance = (a: Added, foreign = false): ItemInstancePayload => {
  const inst = { [GRANT_KEY]: a.grant.id } as ItemInstancePayload;
  if (a.label) inst.name = a.label.slice(0, 64);
  // `generic` (or a look we cannot serve) keeps the stand-in's own WoC model.
  const mesh = foreign && a.look?.rung === 'as-is' ? a.look.mesh?.name : undefined;
  if (typeof mesh === 'string' && MEDIA_NAME.test(mesh))
    (inst as Record<string, unknown>)[MESH_KEY] = mesh;
  return inst;
};

export interface CarrySession {
  accountId: number;
  characterId: number;
  pid: number;
  linkdead?: boolean;
  /** set after an inventory change so the next snapshot resends the bags */
  selfHeavyDirty: boolean;
}

type Grant = { id: string; tags: string[][]; content: string };
type Look = { rung: 'as-is' | 'generic'; mesh?: { name?: unknown } };
/** `equipped`: the slot it was held in where it came from (PLACE-413), on its first offer only. */
type Added = { grant: Grant; label?: string; look?: Look; equipped?: string };

export interface CarryDeps<S extends CarrySession> {
  sim: Pick<Sim, 'meta' | 'addItemInstance'> &
    Partial<Pick<Sim, 'equipItem' | 'unequipItem' | 'entities'>>;
  clients: ReadonlyMap<number, S>;
  /** a `{t:'placeschema', ...}` frame to one player */
  send(
    session: S,
    frame:
      | { t: 'placeschema'; kind: 'ticket' | 'link' | 'skin'; url: string; model?: string }
      | { t: 'placeschema'; kind: 'status'; linked: boolean },
  ): void;
  notice(session: S, text: string): void;
  /** persist this live session's character now; false if the save was refused */
  save(session: S): Promise<boolean>;
  /** PLACE-940: end this session cleanly (a deliberate logout, no linkdead grace). A carry-out sends the page to the
   *  Hub, so without this the character stays in the world for the linkdead grace and the player cannot re-enter
   *  before the arrival's join window closes. */
  leave?(session: S): void;
  /** the ACCOUNT's accepted grants and unconfirmed cancels (placeschema_accepted_db.ts) */
  store: AcceptedStore;
  fetch?: typeof fetch;
  /** holder -> Minecraft skin (placeschema_skin.ts); injectable for tests */
  skin?: (holder: string) => Promise<Skin | undefined>;
}

export const platformId = (cfg: SidecarConfig, accountId: number) =>
  `${accountId}@${cfg.realmHost}`;

/** The WoC item a grant is held as: our own mint maps back to its item, a foreign blade or weapon
 *  to the stand-in, and anything else (an item this realm lacks too) to a keepsake, so every arrival
 *  gets a body and its ack and none strands in escrow (PLACE-293). */
export function itemIdForGrant(grant: Grant): string {
  let type: unknown;
  try {
    type = (JSON.parse(grant.content) as { type?: unknown }).type;
  } catch {
    type = undefined;
  }
  if (typeof type !== 'string') return FOREIGN_KEEPSAKE_ID;
  const m = WOC_TYPE.exec(type);
  if (m) return ITEMS[m[1]] ? m[1] : FOREIGN_KEEPSAKE_ID;
  return /^(blade|weapon)\./.test(type) ? FOREIGN_WEAPON_ID : FOREIGN_KEEPSAKE_ID;
}

/** The inventory slot holding the copy of `grantId`, if any. */
export function slotOfGrant(inventory: readonly InvSlot[], grantId: string): number {
  return inventory.findIndex(
    (s) => (s.instance as Record<string, unknown> | undefined)?.[GRANT_KEY] === grantId,
  );
}

export function grantOfSlot(slot: InvSlot | undefined): string | undefined {
  const g = (slot?.instance as Record<string, unknown> | undefined)?.[GRANT_KEY];
  return typeof g === 'string' && HEX64.test(g) ? g : undefined;
}

export class PlaceSchemaCarry<S extends CarrySession> {
  private readonly linked = new Map<number, string | null>(); // accountId -> holder
  /** One serialisation point per ACCOUNT (the unit the sidecar offers and acks to): every join, carry
   *  and quest conversion for any character or session on the account runs one at a time. */
  private readonly chains = new Map<number, Promise<unknown>>();
  /** accounts with a poll join already queued: the 5 s poll never stacks behind itself */
  private readonly polling = new Set<number>();
  /** accounts with a link-button request in flight (PLACE-479): extra clicks are dropped */
  private readonly linking = new Set<number>();
  /** the session each skin was sent to, so a holder's skin is looked up once per session */
  private readonly skinned = new WeakMap<S, string>();
  /** accounts with a portal carry in flight (PLACE-954) */
  private readonly carrying = new Set<number>();
  /** the grants each session's bag marked to carry through the portal (PLACE-954) */
  private readonly marks = new WeakMap<S, Set<string>>();
  /** each session's walk-in gate for the portals (PLACE-954) */
  private readonly gates = new WeakMap<S, PlaceSchemaPortalGate>();
  /** the link status last sent to each session */
  private readonly told = new WeakMap<S, string | null>();

  private locked<T>(accountId: number, job: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(accountId) ?? Promise.resolve()).then(job, job);
    const tail = run.catch(() => undefined);
    this.chains.set(accountId, tail);
    void tail.then(() => {
      if (this.chains.get(accountId) === tail) this.chains.delete(accountId);
    });
    return run;
  }

  constructor(
    private readonly cfg: SidecarConfig,
    private readonly d: CarryDeps<S>,
  ) {}

  private async call(
    path: string,
    body: unknown,
  ): Promise<{ ok: boolean; status: number; body: any }> {
    const r = await (this.d.fetch ?? fetch)(`${this.cfg.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  }

  /** Deliver pending arrivals to every online player (and learn who is linked). */
  async pollAll(): Promise<void> {
    for (const s of this.d.clients.values()) {
      if (s.linkdead || this.polling.has(s.accountId)) continue;
      this.polling.add(s.accountId);
      await this.join(s)
        .catch(() => undefined)
        .finally(() => this.polling.delete(s.accountId));
    }
  }

  join(s: S): Promise<void> {
    return this.locked(s.accountId, () => this.joinLocked(s));
  }

  private async joinLocked(s: S): Promise<void> {
    {
      // The account's unconfirmed cancels (persisted, so they survive a restart) go first, so the
      // item a cancel re-offers arrives in this join. While any is unconfirmed, add nothing.
      for (const c of await this.d.store.cancels(s.accountId))
        await this.cancel(s, c.grant, c.attempt);
      if ((await this.d.store.cancels(s.accountId)).length) return;
      const r = await this.call('/mod/join', {
        platformId: platformId(this.cfg, s.accountId),
        caps: { mesh: true, sprite: true, cuboid: false },
      });
      if (!r.ok) return;
      this.setLinked(s, r.body.holder ?? null);
      const meta = this.d.sim.meta(s.pid);
      if (!meta || this.d.clients.get(s.pid) !== s) return;
      // Exactly once PER ACCOUNT, claim first: each offered grant is claimed for the account in its own
      // committed statement BEFORE its item is added (placeschema_accepted_db.ts has the crash cases).
      const toAck: string[] = [];
      const notices: string[] = [];
      for (const a of (r.body.add ?? []) as Added[]) {
        if (!a?.grant || !HEX64.test(a.grant.id)) continue;
        const itemId = itemIdForGrant(a.grant);
        const g = a.grant.id;
        const outcome = await this.d.store.claim(s.accountId, g, s.characterId);
        if (outcome === 'busy') continue; // another character's claim is still being saved
        toAck.push(g);
        // held: the account already has it, on some character, wherever it went: never added again.
        // claimed but already in this character's unsaved adds: the save below confirms it.
        if (outcome === 'held' || meta.placeschemaAccepted.has(g)) continue;
        meta.placeschemaAccepted.add(g); // the save confirms (un-pends) the claim in its transaction
        touchPlaceschemaAccepted(meta.placeschemaAccepted);
        const pending = meta.inventory.find((x) => pendingOf(x) === itemId);
        if (pending) {
          // Our own quest reward, tagged before the mint: that exact copy becomes the signed one.
          pending.instance = signedInstance(a);
          notices.push(`${a.label ?? 'Your item'} is now yours to carry to other worlds.`);
        } else {
          const inst = signedInstance(a, itemId === FOREIGN_WEAPON_ID);
          this.d.sim.addItemInstance(itemId, inst, s.pid);
          // Decision 2 + PLACE-413: a weapon that arrived HELD goes to the main hand when this class
          // can use it; one carried in a bag, or one this class can't use, stays in the bag (name and
          // mesh kept). WoC's class rules are untouched.
          if (
            a.equipped &&
            ITEMS[itemId]?.slot === 'mainhand' &&
            canEquipItem(meta.cls, ITEMS[itemId])
          ) {
            const at = slotOfGrant(meta.inventory, g);
            if (at >= 0) this.d.sim.equipItem?.(itemId, s.pid, 'mainhand', at);
          }
          notices.push(
            itemId !== FOREIGN_WEAPON_ID && itemId !== FOREIGN_KEEPSAKE_ID
              ? `${a.label ?? 'Your item'} is now yours to carry to other worlds.`
              : `${a.label ?? 'An item'} arrived from another world.`,
          );
        }
      }
      if (!toAck.length) return;
      s.selfHeavyDirty = true;
      // Save, then tell the player and ack. A save that fails leaves the item and its pending claim
      // in memory for the next save to land; nothing is acked or announced until one does.
      const saved = await this.d.save(s).catch((e) => {
        console.error('placeschema: arrival save failed', e);
        return false;
      });
      if (!saved) return;
      // Confirmed in that save: the character no longer needs to confirm these ids.
      for (const g of toAck) meta.placeschemaAccepted.delete(g);
      for (const n of notices) this.d.notice(s, n);
      await this.call('/mod/ack', { platformId: platformId(this.cfg, s.accountId), grants: toAck });
    }
  }

  /** Record who holds the account, and tell the client when that changes (PLACE-479: the bag's
   *  "Link PlaceSchema account" button shows only once the sidecar has answered). */
  private setLinked(s: S, holder: string | null): void {
    this.linked.set(s.accountId, holder);
    if (this.told.get(s) !== holder) {
      this.told.set(s, holder);
      this.d.send(s, { t: 'placeschema', kind: 'status', linked: !!holder });
    }
    if (holder) this.wearSkin(s, holder);
  }

  /** The bag's link button (PLACE-479): the one-time link page, with no item needed. Linked already:
   *  the status again. The 5 s join poll then sees the link, delivers arrivals and wears the skin. */
  link(s: S): Promise<void> {
    // One in flight per account: a spammed button never queues jobs ahead of the join poll.
    if (this.linking.has(s.accountId)) return Promise.resolve();
    this.linking.add(s.accountId);
    return this.locked(s.accountId, async () => {
      const holder = this.linked.get(s.accountId);
      if (holder) return this.d.send(s, { t: 'placeschema', kind: 'status', linked: true });
      await this.openLink(s);
    }).finally(() => this.linking.delete(s.accountId));
  }

  private async openLink(s: S): Promise<void> {
    const r = await this.call('/mod/link', { platformId: platformId(this.cfg, s.accountId) });
    if (r.ok && typeof r.body.url === 'string')
      this.d.send(s, { t: 'placeschema', kind: 'link', url: r.body.url });
    else this.refused(s, r.body?.error ?? 'link-failed');
  }

  /** The holder's Minecraft skin to this player's client, once per session; looked up live, never
   *  stored. No skin (no relay, no link, default skin, lookup failed): WoC's own body stays. */
  private wearSkin(s: S, holder: string): void {
    if (this.skinned.get(s) === holder) return;
    this.skinned.set(s, holder);
    const look = this.d.skin ?? ((h: string) => skinForHolder(h, this.cfg.relays ?? []));
    void look(holder)
      .then((skin) => {
        if (skin && this.d.clients.get(s.pid) === s)
          this.d.send(s, { t: 'placeschema', kind: 'skin', url: skin.url, model: skin.model });
      })
      .catch(() => undefined);
  }

  /** A quest turn-in: the reward becomes a signed grant held by the player's did (if linked). */
  questDone(s: S, questId: string): Promise<void> {
    return this.locked(s.accountId, () => this.questDoneLocked(s, questId));
  }

  private async questDoneLocked(s: S, questId: string): Promise<void> {
    const quest = QUESTS[questId];
    const meta = this.d.sim.meta(s.pid);
    if (!quest || !meta) return;
    const itemId = questRewardItemId(quest, meta.cls);
    if (!itemId || !ITEMS[itemId]) return;
    if (!this.linked.get(s.accountId)) return; // unlinked: an ordinary WoC item, nothing to carry
    // Tag the exact plain copy the quest gave, and save that, BEFORE minting: whenever the grant
    // later arrives (now, or on a join after a crash) it converts this copy instead of adding one.
    // No plain copy in the bag (it went elsewhere): no mint, never two copies.
    const at = meta.inventory.findIndex((x) => x.itemId === itemId && !x.instance);
    if (at < 0) return;
    const slot = meta.inventory[at];
    if (slot.count > 1) {
      slot.count--;
      meta.inventory.push({ itemId, count: 1, instance: { [PENDING_KEY]: itemId } as never });
    } else slot.instance = { [PENDING_KEY]: itemId } as never;
    s.selfHeavyDirty = true;
    if (!(await this.d.save(s))) return this.untag(s, itemId);
    let r: { ok: boolean; status: number; body: any } | undefined;
    try {
      r = await this.call('/mod/mint', {
        platformId: platformId(this.cfg, s.accountId),
        template: templateFor(itemId),
      });
    } catch {
      r = undefined;
    }
    const grant = r?.body?.grant as Grant | undefined;
    // No answer: the mint may have landed, so the tag stays and a later join settles it.
    if (!r || r.status >= 500) return;
    if (!r.ok || !grant || !HEX64.test(grant.id)) return this.untag(s, itemId);
    await this.joinLocked(s); // the sidecar queued the grant: this converts the tagged copy and saves
  }

  /** The mint did not happen: the tagged copy goes back to plain. */
  private untag(s: S, itemId: string): void {
    const tagged = this.d.sim.meta(s.pid)?.inventory.find((x) => pendingOf(x) === itemId);
    if (!tagged) return;
    delete tagged.instance;
    s.selfHeavyDirty = true;
  }

  /** Carry out through the sidecar, as the portal does (PLACE-954): these grants (the ones the bag
   *  marked), or every signed copy this account may carry. None to carry is still a hop, as the
   *  player. */
  carry(s: S, only?: readonly string[]): Promise<void> {
    return this.locked(s.accountId, () => this.carryLocked(s, only));
  }

  private async carryLocked(s: S, only?: readonly string[]): Promise<void> {
    const pid = platformId(this.cfg, s.accountId);
    if (!this.linked.get(s.accountId)) return this.openLink(s);
    if (!this.cfg.home) return this.refused(s, 'no-home-world');
    // Only a grant this account accepted is its own to carry: a copy traded in from someone else is
    // refused here, BEFORE anything is removed (N-b). Read before the character, so nothing below
    // awaits until the removal is saved: what is worn and bagged can't change under it.
    const claims = await this.d.store.claims(s.accountId);
    const meta = this.d.sim.meta(s.pid);
    if (!meta) return;
    // Every signed copy on this character: worn (by slot) and in the bags.
    const worn = Object.entries(meta.equipmentInstance ?? {}).flatMap(([slot, inst]) => {
      const g = grantOfSlot({ instance: inst } as InvSlot);
      return g ? [[slot, g] as const] : [];
    });
    const here = [
      ...new Set([
        ...worn.map(([, g]) => g),
        ...meta.inventory.flatMap((x) => grantOfSlot(x) ?? []),
      ]),
    ].filter((g) => !only || only.includes(g));
    const mine = here.filter((g) => claims.has(g));
    if (mine.length < here.length) {
      if (!mine.length && only) return this.refused(s, 'not-yours');
      this.d.notice(
        s,
        "Some items here aren't yours to carry through this portal; they stay with you.",
      );
    }
    // A save releases at most MAX_RELEASED claims (placeschema_accepted.ts): the rest wait for the
    // next walk through.
    let grants = mine.slice(0, MAX_RELEASED);
    if (grants.length < mine.length)
      this.d.notice(s, 'More items than one crossing carries: walk through again for the rest.');
    // Remove before release (contract section 3), and SAVE the removal before the escrow is asked: a
    // crash after carry-out must not reload a bag that still holds a copy. Each item leaves and the
    // ACCOUNT's claim is released (by claim id, whichever character claimed it) in the SAME save, so a
    // later re-offer is claimed and added once (B2).
    const removed: { slot: InvSlot; g: string; wasAccepted: boolean; worn?: string }[] = [];
    const take = (g: string, wornIn?: string) => {
      const at = slotOfGrant(meta.inventory, g);
      if (at < 0) return;
      const [slot] = meta.inventory.splice(at, 1);
      removed.push({ slot, g, wasAccepted: meta.placeschemaAccepted.delete(g), worn: wornIn });
      releasePlaceschemaClaim(meta.placeschemaAccepted, claims.get(g)!);
    };
    const undo = () => {
      for (const r of removed.reverse()) {
        meta.inventory.push(r.slot);
        if (r.wasAccepted) meta.placeschemaAccepted.add(r.g);
        unreleasePlaceschemaClaim(meta.placeschemaAccepted, claims.get(r.g)!);
        if (r.worn) {
          const at = slotOfGrant(meta.inventory, r.g);
          this.d.sim.equipItem?.(r.slot.itemId, s.pid, r.worn as never, at);
        }
      }
    };
    // Bag copies leave first, so their room takes the worn ones. What is worn travels as its slot
    // (PLACE-329, main hand = grip) so it arrives held; it comes off into the bag and leaves from there.
    const wornGrants = new Set(worn.map(([, g]) => g));
    for (const g of grants) if (!wornGrants.has(g)) take(g);
    const equipped: Record<string, string> = {};
    for (const [slot, g] of worn) {
      if (!grants.includes(g)) continue;
      if (!this.d.sim.unequipItem?.(slot as never, s.pid)) {
        undo();
        return this.d.notice(
          s,
          'Make room for one item in your bags, then walk through again: what you hold travels through them.',
        );
      }
      equipped[slot === 'mainhand' ? 'grip' : slot] = g;
      take(g, slot);
    }
    grants = removed.map((r) => r.g);
    s.selfHeavyDirty = true;
    const attempt = randomBytes(16).toString('hex');
    if (grants.length && !(await this.d.save(s).catch(() => false))) {
      undo(); // nothing was saved and the sidecar was never asked
      return this.refused(s, 'save-failed');
    }
    let r: { ok: boolean; status: number; body: any } | undefined;
    try {
      r = await this.call('/mod/carry-out', {
        platformId: pid,
        grants,
        destination: this.cfg.home,
        attempt,
        ...(Object.keys(equipped).length ? { equipped } : {}),
      });
    } catch {
      r = undefined;
    }
    if (r?.ok && typeof r.body.url === 'string') {
      this.marks.delete(s);
      this.d.send(s, { t: 'placeschema', kind: 'ticket', url: r.body.url });
      // The page navigates away now; let the frame flush, then free the character (PLACE-940).
      if (this.d.leave) setTimeout(() => this.d.leave?.(s), 1500);
      return;
    }
    // Refused, timed out, or the answer was lost (a slow relay may still commit it later): the game
    // never adds it back itself. Cancel it at the sidecar, which refuses any late commit and
    // re-offers the item, and the next join is the one way it comes back.
    await this.giveUp(s, grants, attempt, r?.body?.error ?? 'sidecar-unreachable');
  }

  /** Cancel a carry-out and let join bring the items back; an unreachable sidecar is retried. */
  private async giveUp(s: S, grants: string[], attempt: string, reason: string): Promise<void> {
    // every cancel is journalled in one statement before any is sent: a crash returns them all
    await this.d.store.putCancels(s.accountId, grants, attempt);
    for (const g of grants) await this.cancel(s, g, attempt);
    if (this.d.clients.get(s.pid) !== s) return; // offline: their next login's join delivers it
    this.refused(s, reason);
    await this.joinLocked(s).catch(() => undefined); // unreachable: the 5 s poll tries again
  }

  private async cancel(s: S, grantId: string, attempt: string): Promise<void> {
    try {
      const r = await this.call('/mod/cancel', {
        platformId: platformId(this.cfg, s.accountId),
        grant: grantId,
        attempt,
      });
      // Settled when confirmed, or when the sidecar says definitely there is nothing of this holder's
      // to return (landed, unknown, not this holder's): a traded copy must not wedge arrivals (N-b).
      const settled =
        r.ok || (r.status >= 400 && r.status < 500 && SETTLED.test(String(r.body?.error ?? '')));
      if (settled) await this.d.store.dropCancel(s.accountId, grantId);
    } catch {
      /* unreachable: stays pending, retried before the next join */
    }
  }

  private refused(s: S, reason: string): void {
    this.d.notice(s, `The item could not be carried (${String(reason).slice(0, 60)}).`);
  }

  // ---- the three game.ts seams (kept here so the monolith only calls in) ----

  /** The sim event drain: a quest turn-in by an online player. */
  onEvent(ev: { type: string; pid?: number; questId?: string }): void {
    if (ev.type !== 'questDone' || ev.pid === undefined || !ev.questId) return;
    const s = this.d.clients.get(ev.pid);
    if (s)
      void this.questDone(s, ev.questId).catch((e) => console.error('placeschema mint failed:', e));
  }

  /** The `ps_carry` command (the bag's "Carry to another world"): the named bag slot's (or worn
   *  slot's) signed copy is marked to carry, and the player is pointed to the portal, which carries
   *  the marked items (PLACE-954), or all of them when none is marked. */
  onCarryCommand(s: S, slot: unknown): void {
    const meta = this.d.sim.meta(s.pid);
    const inst =
      typeof slot === 'string'
        ? meta?.equipmentInstance?.[slot as never]
        : meta?.inventory[Number.isInteger(slot) ? Number(slot) : -1]?.instance;
    const grant = grantOfSlot({ instance: inst } as InvSlot);
    if (!grant) return;
    let marked = this.marks.get(s);
    if (!marked) this.marks.set(s, (marked = new Set()));
    marked.add(grant);
    const name = (inst as { name?: unknown } | undefined)?.name;
    this.d.notice(
      s,
      `${typeof name === 'string' ? name : 'Your item'} is ready to carry: walk through the PlaceSchema portal, by the pier on the Proving Shore or south of the Eastbrook square.`,
    );
  }

  /** Every online player who walked into or through a PlaceSchema portal's opening since the last
   *  look carries out (PLACE-954). The server's own positions decide; called five times a second. */
  checkPortals(): void {
    for (const s of this.d.clients.values()) {
      const p = this.d.sim.entities?.get(s.pid);
      let gate = this.gates.get(s);
      if (!gate) this.gates.set(s, (gate = new PlaceSchemaPortalGate()));
      // one carry per walk-in: stepping back in while one is in flight queues nothing
      if (!s.linkdead && gate.tick(p?.pos, p?.dead) && !this.carrying.has(s.accountId)) {
        const marked = this.marks.get(s);
        this.carrying.add(s.accountId);
        void this.carry(s, marked?.size ? [...marked] : undefined)
          .catch((e) => console.error('placeschema portal carry failed:', e))
          .finally(() => this.carrying.delete(s.accountId));
      }
    }
  }
}

/** Build the carry from the environment and start polling arrivals; null when not configured. */
export function startPlaceSchemaCarry<S extends CarrySession>(
  env: NodeJS.ProcessEnv,
  deps: Omit<CarryDeps<S>, 'store'>,
): PlaceSchemaCarry<S> | null {
  const cfg = sidecarConfig(env);
  if (!cfg) return null;
  const carry = new PlaceSchemaCarry(cfg, { ...deps, store: pgAcceptedStore() });
  setInterval(() => void carry.pollAll(), 5_000).unref();
  setInterval(() => carry.checkPortals(), 200).unref();
  return carry;
}
