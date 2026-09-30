// PlaceSchema carry through the shared sidecar (open-place adapters/sidecar, PLACE-276).
//
// The sidecar holds every key, signs every grant and owns the escrow; this module is the thin
// game side of its HTTP contract (open-place docs/superpowers/specs/2026-09-29-game-adapter-
// contract-design.md): poll /mod/join for each online player and add what arrives, mint a quest
// reward as a signed grant, and carry one item out (remove it first, then /mod/carry-out).
//
// Off unless PLACESCHEMA_SIDECAR_URL and PLACESCHEMA_MOD_TOKEN are set. A player's platform id is
// `<account id>@<realm host>` (spec/nostr.md section 11, platform `woc`), never the username.

import { ITEMS, QUESTS, questRewardItemId } from '../src/sim/data';
import type { Sim } from '../src/sim/sim';
import type { InvSlot, ItemInstancePayload } from '../src/sim/types';

/** The carried grant's id rides on the item copy; the copy's `name` is the grant's minted label. */
export const GRANT_KEY = 'psGrant';
const HEX64 = /^[0-9a-f]{64}$/;
/** A foreign blade or weapon (not minted here) is held as this WoC weapon, named by its grant.
 *  ponytail: one stand-in body per category; the item's own mesh (its grant look) is follow-up work. */
export const FOREIGN_WEAPON_ID = 'worn_sword';
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
}

export function sidecarConfig(env: NodeJS.ProcessEnv): SidecarConfig | null {
  const url = env.PLACESCHEMA_SIDECAR_URL?.replace(/\/$/, '');
  const token = env.PLACESCHEMA_MOD_TOKEN;
  if (!url || !token) return null;
  const realmHost =
    env.PLACESCHEMA_REALM_HOST ?? new URL(env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:5173').host;
  return { url, token, realmHost, home: env.PLACESCHEMA_HOME ?? '' };
}

/** A quest-reward copy waiting for its mint: the value is the item id. Converted, never duplicated. */
export const PENDING_KEY = 'psPending';
const pendingOf = (slot: InvSlot): string | undefined => {
  const v = (slot.instance as Record<string, unknown> | undefined)?.[PENDING_KEY];
  return typeof v === 'string' ? v : undefined;
};
const signedInstance = (a: Added): ItemInstancePayload => {
  const inst = { [GRANT_KEY]: a.grant.id } as ItemInstancePayload;
  if (a.label) inst.name = a.label.slice(0, 64);
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
type Added = { grant: Grant; label?: string };

export interface CarryDeps<S extends CarrySession> {
  sim: Pick<Sim, 'meta' | 'addItemInstance'> & {
    postOffice?: { mail: readonly { items: readonly InvSlot[] }[] };
  };
  clients: ReadonlyMap<number, S>;
  /** a `{t:'placeschema', ...}` frame to one player */
  send(session: S, frame: { t: 'placeschema'; kind: 'ticket' | 'link'; url: string }): void;
  notice(session: S, text: string): void;
  /** persist this live session's character now; false if the save was refused */
  save(session: S): Promise<boolean>;
  /** run a job on the character's own save FIFO (game.ts enqueueCharacterWrite) */
  enqueueWrite<T>(characterId: number, job: () => Promise<T>): Promise<T>;
  /** add a copy to a logged-off character's saved row (load, add, save); runs inside enqueueWrite */
  writeSavedRow(characterId: number, slot: InvSlot, grantId: string): Promise<void>;
  fetch?: typeof fetch;
}

const holdsIn = (slots: readonly InvSlot[] | undefined, grantId: string) =>
  !!slots && slotOfGrant(slots, grantId) >= 0;

/** The default saved-row write: the row gains the copy unless its bag or bank already holds it. */
export async function writeSavedCharacterRow(
  characterId: number,
  slot: InvSlot,
  grantId: string,
): Promise<void> {
  const db = await import('./db');
  const row = await db.getCharacterById(characterId);
  if (!row?.state)
    throw new Error(`placeschema: no saved character ${characterId} to restore into`);
  const bank = (row.state as { bank?: { inventory?: InvSlot[] } }).bank?.inventory;
  if (holdsIn(row.state.inventory, grantId) || holdsIn(bank, grantId)) return;
  row.state.inventory.push(slot);
  await db.saveCharacterState(characterId, row.level, row.state);
}

export const platformId = (cfg: SidecarConfig, accountId: number) =>
  `${accountId}@${cfg.realmHost}`;

/** The WoC item a grant is held as: our own mint maps back to its item, a foreign blade or weapon
 *  to the stand-in; anything else has no body here yet (undefined: it stays pending, never acked). */
export function itemIdForGrant(grant: Grant): string | undefined {
  try {
    const t = JSON.parse(grant.content) as { type?: string };
    if (typeof t.type !== 'string') return undefined;
    const m = WOC_TYPE.exec(t.type);
    if (m) return ITEMS[m[1]] ? m[1] : undefined;
    return /^(blade|weapon)\./.test(t.type) ? FOREIGN_WEAPON_ID : undefined;
  } catch {
    return undefined;
  }
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
  private readonly busy = new Set<number>();
  /** carry-outs whose answer was lost: grant -> the removed copy, settled by status on join */
  private readonly unsettled = new Map<string, { characterId: number; slot: InvSlot }>();

  /** Whether this player holds the grant anywhere the game keeps items: bag, bank or mail. */
  private holds(s: S, grantId: string): boolean {
    const meta = this.d.sim.meta(s.pid) as
      | (ReturnType<Sim['meta']> & { bank?: { inventory?: InvSlot[] } })
      | null;
    if (!meta) return false;
    if (holdsIn(meta.inventory, grantId) || holdsIn(meta.bank?.inventory, grantId)) return true;
    return (this.d.sim.postOffice?.mail ?? []).some((m) => holdsIn(m.items, grantId));
  }

  /** The escrow's own answer for one grant: held, in-transit, gone (landed), or undefined. */
  private async stateOf(s: S, grantId: string): Promise<string | undefined> {
    try {
      const r = await this.call('/mod/status', { platformId: platformId(this.cfg, s.accountId) });
      if (!r.ok) return undefined;
      const row = (r.body.items ?? []).find(
        (v: { grant?: { id?: string } }) => v.grant?.id === grantId,
      );
      return row ? String(row.state) : 'gone';
    } catch {
      return undefined;
    }
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
    for (const s of this.d.clients.values())
      if (!s.linkdead) await this.join(s).catch(() => undefined);
  }

  async join(s: S): Promise<void> {
    if (this.busy.has(s.pid)) return;
    this.busy.add(s.pid);
    try {
      const r = await this.call('/mod/join', {
        platformId: platformId(this.cfg, s.accountId),
        caps: { mesh: false, sprite: true, cuboid: false },
      });
      if (!r.ok) return;
      this.linked.set(s.accountId, r.body.holder ?? null);
      const meta = this.d.sim.meta(s.pid);
      if (!meta || this.d.clients.get(s.pid) !== s) return;
      const added: string[] = [];
      for (const a of (r.body.add ?? []) as Added[]) {
        if (!a?.grant || !HEX64.test(a.grant.id)) continue;
        const itemId = itemIdForGrant(a.grant);
        if (!itemId) continue; // no body for this kind here yet: left pending, not acked
        // Adding one we already hold (bag, bank or mail) is a no-op: the grant id is the key.
        this.unsettled.delete(a.grant.id); // the escrow's own return settles a lost carry-out
        if (!this.holds(s, a.grant.id)) {
          const pending = meta.inventory.find((x) => pendingOf(x) === itemId);
          if (pending) {
            // Our own quest reward, tagged before the mint: that exact copy becomes the signed one.
            pending.instance = signedInstance(a);
            this.d.notice(s, `${a.label ?? 'Your item'} is now yours to carry to other worlds.`);
          } else {
            this.d.sim.addItemInstance(itemId, signedInstance(a), s.pid);
            this.d.notice(
              s,
              itemId !== FOREIGN_WEAPON_ID
                ? `${a.label ?? 'Your item'} is now yours to carry to other worlds.`
                : `${a.label ?? 'An item'} arrived from another world.`,
            );
          }
        }
        added.push(a.grant.id);
      }
      // Lost carry-outs for this character: ask the escrow now (after adds, so a returned grant
      // just delivered above is already settled and never given back twice).
      for (const [g, u] of [...this.unsettled])
        if (u.characterId === s.characterId) await this.settle(s, g);
      if (!added.length) return;
      s.selfHeavyDirty = true;
      // Add, SAVE, then ack: a crash before the ack re-delivers, and the grant id dedupes it.
      if (!(await this.d.save(s))) return;
      await this.call('/mod/ack', { platformId: platformId(this.cfg, s.accountId), grants: added });
    } finally {
      this.busy.delete(s.pid);
    }
  }

  /** A quest turn-in: the reward becomes a signed grant held by the player's did (if linked). */
  async questDone(s: S, questId: string): Promise<void> {
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
    await this.join(s); // the sidecar queued the grant: this converts the tagged copy and saves
  }

  /** The mint did not happen: the tagged copy goes back to plain. */
  private untag(s: S, itemId: string): void {
    const tagged = this.d.sim.meta(s.pid)?.inventory.find((x) => pendingOf(x) === itemId);
    if (!tagged) return;
    delete tagged.instance;
    s.selfHeavyDirty = true;
  }

  /** One Carry click: remove the copy, then escrow it out and send the player home with a ticket. */
  async carry(s: S, grantId: string): Promise<void> {
    const pid = platformId(this.cfg, s.accountId);
    if (!this.linked.get(s.accountId)) {
      const r = await this.call('/mod/link', { platformId: pid });
      if (r.ok && typeof r.body.url === 'string')
        this.d.send(s, { t: 'placeschema', kind: 'link', url: r.body.url });
      else this.refused(s, r.body?.error ?? 'link-failed');
      return;
    }
    if (!this.cfg.home) return this.refused(s, 'no-home-world');
    const meta = this.d.sim.meta(s.pid);
    if (!meta) return;
    const at = slotOfGrant(meta.inventory, grantId);
    if (at < 0) return;
    // Remove before release (contract section 3): the copy leaves the bag first.
    // And the removal is SAVED before the escrow is asked: a crash after carry-out must not reload
    // a bag that still holds the copy.
    const [removed] = meta.inventory.splice(at, 1);
    s.selfHeavyDirty = true;
    if (!(await this.d.save(s))) {
      this.putBack(s, removed, grantId);
      return this.refused(s, 'save-failed');
    }
    let r: { ok: boolean; status: number; body: any } | undefined;
    try {
      r = await this.call('/mod/carry-out', {
        platformId: pid,
        grants: [grantId],
        destination: this.cfg.home,
      });
    } catch {
      r = undefined;
    }
    if (r?.ok && typeof r.body.url === 'string') {
      this.d.send(s, { t: 'placeschema', kind: 'ticket', url: r.body.url });
      return;
    }
    if (r && r.status >= 400 && r.status < 500) {
      // A definite refusal: the escrow never moved it, so the copy comes back.
      await this.giveBack(s, removed, grantId);
      return this.refused(s, r.body?.error ?? 'refused');
    }
    // The answer was lost: the escrow may have moved it. Never guess; ask it.
    this.unsettled.set(grantId, { characterId: s.characterId, slot: removed });
    await this.settle(s, grantId);
    if (this.unsettled.has(grantId) && this.d.clients.get(s.pid) === s)
      this.d.notice(s, 'The carry did not confirm; the item will come back if it did not leave.');
  }

  /**
   * Settle one lost carry-out by the escrow's own state: `held` means it never left, so the copy
   * comes back; `in-transit` means it left, and the escrow's timed-out return comes back through
   * join; `gone` means it landed elsewhere. Unreachable: stays unsettled for the next join.
   */
  private async settle(s: S, grantId: string): Promise<void> {
    const pending = this.unsettled.get(grantId);
    if (!pending) return;
    const state = await this.stateOf(s, grantId);
    if (state === undefined) return;
    this.unsettled.delete(grantId);
    if (state === 'held') await this.giveBack(s, pending.slot, grantId);
  }

  /** Put a removed copy back, durably: into the live bag and saved, or into the saved row. */
  private async giveBack(s: S, slot: InvSlot, grantId: string): Promise<void> {
    await this.restore(s.characterId, slot, grantId);
  }

  /**
   * Restore one copy on the character's own save FIFO, so no pending final save or re-login can
   * overwrite it: in memory if the character is online by the time the job runs, else in the row.
   */
  async restore(characterId: number, slot: InvSlot, grantId: string): Promise<void> {
    let live: S | undefined;
    await this.d.enqueueWrite(characterId, async () => {
      live = [...this.d.clients.values()].find((c) => c.characterId === characterId);
      if (live) {
        if (!this.holds(live, grantId)) this.putBack(live, slot, grantId);
        return;
      }
      await this.d.writeSavedRow(characterId, slot, grantId);
    });
    // Outside the job: a live save enqueues on the same FIFO (awaiting it inside would deadlock).
    if (live) await this.d.save(live);
  }

  private putBack(s: S, slot: InvSlot, grantId: string): void {
    const back = this.d.sim.meta(s.pid);
    if (back && slotOfGrant(back.inventory, grantId) < 0) back.inventory.push(slot);
    s.selfHeavyDirty = true;
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

  /** The `ps_carry` command: the named bag slot's signed copy leaves through the sidecar. */
  onCarryCommand(s: S, slot: unknown): void {
    const at = Number.isInteger(slot) ? Number(slot) : -1;
    const grant = grantOfSlot(this.d.sim.meta(s.pid)?.inventory[at]);
    if (grant)
      void this.carry(s, grant).catch((e) => console.error('placeschema carry failed:', e));
  }
}

/** Build the carry from the environment and start polling arrivals; null when not configured. */
export function startPlaceSchemaCarry<S extends CarrySession>(
  env: NodeJS.ProcessEnv,
  deps: Omit<CarryDeps<S>, 'writeSavedRow'>,
): PlaceSchemaCarry<S> | null {
  const cfg = sidecarConfig(env);
  if (!cfg) return null;
  const carry = new PlaceSchemaCarry(cfg, { ...deps, writeSavedRow: writeSavedCharacterRow });
  setInterval(() => void carry.pollAll(), 5_000).unref();
  return carry;
}
