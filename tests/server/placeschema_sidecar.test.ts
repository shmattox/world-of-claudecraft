import { describe, expect, it } from 'vitest';
import {
  FOREIGN_KEEPSAKE_ID,
  FOREIGN_WEAPON_ID,
  GRANT_KEY,
  itemIdForGrant,
  nativeFeatures,
  nativeOf,
  PENDING_KEY,
  PlaceSchemaCarry,
  platformId,
  sidecarConfig,
  slotOfGrant,
  templateFor,
} from '../../server/placeschema_sidecar';
import { ITEMS } from '../../src/sim/data';
import {
  loadPlaceschemaAccepted,
  savedPlaceschemaAccepted,
} from '../../src/sim/placeschema_accepted';
import { PLACESCHEMA_PORTALS, PlaceSchemaPortalGate } from '../../src/sim/placeschema_portal';
import { grantInventoryInstances } from '../../src/sim/inventory_grant';
import type { InvSlot } from '../../src/sim/types';

const G1 = 'a'.repeat(64);
/** the sidecar's own key: its manifest's `owner`, and the `minter` of every grant it mints */
const OWNER = 'f'.repeat(64);
const cfg = {
  url: 'http://sidecar.test',
  token: 't'.repeat(32),
  realmHost: 'woc.test',
  home: 'http://hub.test',
};
const grant = (id: string, type = 'blade.sword') => ({
  id,
  tags: [],
  content: JSON.stringify({ type }),
});
type Grant = ReturnType<typeof grant>;
type Session = { accountId: number; characterId: number; pid: number; selfHeavyDirty: boolean };
type Fault = 'refuse' | 'crash-after' | 'disconnect' | 'lost' | 'down' | 'slow';
type Item = {
  grant: Grant;
  label: string;
  state: string;
  readd: boolean;
  ackedSeq: number;
  holder?: string;
};
type Char = {
  inventory: InvSlot[];
  accepted: Set<string>;
  saved: InvSlot[];
  savedState: Saved;
};
type Saved = ReturnType<typeof savedPlaceschemaAccepted>;
type Claim = { claim: number; character: number; pending: boolean };
const clone = <T>(v: T): T => structuredClone(v);
const flush = () => new Promise((r) => setTimeout(r, 20));
const has = (slots: InvSlot[], g: string) =>
  slots.filter((x) => (x.instance as Record<string, unknown> | undefined)?.[GRANT_KEY] === g)
    .length;

/**
 * One player (a live bag and accepted set, both as last SAVED, plus equipment), another player's bag
 * (a trade or sale), and a model of the sidecar escrow that follows adapters/sidecar/src/store.ts:
 * carry-out records its attempt before the relay read and refuses a cancelled attempt at commit; a
 * cancel names an attempt, re-offers once, and is a no-op when repeated or older than the game's
 * ack. `copies(g)` counts one grant everywhere a copy can be.
 */
function world() {
  let seq = 0;
  let inventory: InvSlot[] = [];
  let accepted = new Set<string>();
  let saved: InvSlot[] = [];
  let savedState: Saved = {};
  const equipment: InvSlot[] = [];
  const other: InvSlot[] = [];
  const escrow = new Map<string, Item>();
  // the account-level store (placeschema_accepted / placeschema_cancels): grant -> the account's claim
  const claims = new Map<string, Claim>();
  let nextClaim = 1;
  const cancelRows = new Map<string, string>();
  const parked = new Map<number, Char>(); // the account's other characters, as saved
  const attempts = new Map<string, { seq: number; state: string }>();
  const calls: string[] = [];
  const bodies: Record<string, any> = {}; // the last request body per path
  const worn: Record<string, unknown> = {}; // equipment slot -> its copy's instance
  let pos = { x: 1000, z: 1000 }; // the server's own position for the player
  let bagCap = Number.POSITIVE_INFINITY; // how many slots the bags hold
  let manifest: unknown = {}; // the destination's /.well-known/placeschema.json
  const frames: unknown[] = [];
  const faults: Record<string, Fault> = {};
  const clients = new Map<number, Session>();
  let session: Session = { accountId: 7, characterId: 70, pid: 1, selfHeavyDirty: false };
  clients.set(1, session);
  const late: (() => void)[] = [];
  let lateResult: { status: number; body: unknown } | undefined;
  const commit = (b: any): { status: number; body: unknown } => {
    for (const g of b.grants) {
      const e = escrow.get(g);
      if (attempts.get(`${b.attempt}:${g}`)?.state === 'cancelled')
        return { status: 409, body: { error: `cancelled:${g}` } };
      if (e?.state !== 'held' || e.readd) return { status: 409, body: { error: `not-held:${g}` } };
    }
    for (const g of b.grants) {
      escrow.get(g)!.state = 'in-transit';
      attempts.get(`${b.attempt}:${g}`)!.state = 'committed';
    }
    return {
      status: 200,
      body: { url: `${b.destination}/arrive#ps-ticket=x`, attempt: b.attempt },
    };
  };
  const answer = (path: string, b: any): { status: number; body: unknown } => {
    if (path === '/.well-known/placeschema.json') return { status: 200, body: manifest };
    if (path === '/mod/join')
      return {
        status: 200,
        body: {
          holder: 'h',
          add: [...escrow.values()]
            .filter((e) => e.state === 'held' && e.readd)
            .map((e) => ({ grant: e.grant, label: e.label })),
        },
      };
    if (path === '/mod/link') return { status: 200, body: { url: 'https://sidecar.test/link#x' } };
    if (path === '/mod/ack') {
      for (const g of b.grants) {
        const e = escrow.get(g)!;
        if (e.state === 'held' && e.readd) Object.assign(e, { readd: false, ackedSeq: ++seq });
      }
      return { status: 200, body: { ok: true } };
    }
    if (path === '/mod/mint') {
      // the sidecar signs the template it was given, as its own minter (PLACE-990 reads it back)
      const g = { id: G1, tags: [], content: JSON.stringify({ ...b.template, minter: OWNER }) };
      escrow.set(G1, {
        grant: g,
        label: b.template.label,
        state: 'held',
        readd: true,
        ackedSeq: 0,
      });
      return { status: 200, body: { grant: g } };
    }
    if (path === '/mod/cancel') {
      const e = escrow.get(b.grant);
      if (!e) return { status: 409, body: { error: 'unknown-grant' } };
      if (e.holder && e.holder !== 'h') return { status: 409, body: { error: 'not-yours' } };
      const key = `${b.attempt}:${b.grant}`;
      const a = attempts.get(key);
      if (a?.state === 'cancelled') return { status: 200, body: { reoffered: false } };
      if (e.state === 'landed') return { status: 409, body: { error: 'landed' } };
      const at = a?.seq ?? ++seq;
      const moved = e.state === 'in-transit' ? a?.state === 'committed' : !e.readd;
      attempts.set(key, { seq: at, state: 'cancelled' });
      if (e.ackedSeq > at || !moved) return { status: 200, body: { reoffered: false } };
      Object.assign(e, { state: 'held', readd: true });
      return { status: 200, body: { reoffered: true } };
    }
    if (path === '/mod/carry-out') {
      if (faults[path] === 'refuse' || faults[path] === 'disconnect')
        return { status: 409, body: { error: 'link-not-honoured' } };
      for (const g of b.grants) {
        const key = `${b.attempt}:${g}`;
        if (attempts.get(key)?.state === 'cancelled')
          return { status: 409, body: { error: `cancelled:${g}` } };
        if (!attempts.has(key)) attempts.set(key, { seq: ++seq, state: 'started' });
      }
      if (faults[path] === 'slow') {
        // A slow relay holds this request inside the sidecar; it commits when the test says.
        late.push(() => {
          lateResult = commit(b);
        });
        return { status: 0, body: {} };
      }
      return commit(b);
    }
    return { status: 404, body: {} };
  };
  const deps = {
    sim: {
      meta: () =>
        ({
          inventory,
          placeschemaAccepted: accepted,
          cls: 'warrior',
          equipmentInstance: worn,
        }) as never,
      unequipItem: (slot: string) => {
        if (inventory.length >= bagCap) return false;
        inventory.push({ itemId: FOREIGN_WEAPON_ID, count: 1, instance: worn[slot] as never });
        delete worn[slot];
        return true;
      },
      entities: { get: () => ({ pos }) },
      // the sim's own grant (stacking, count, crafting mark), so a returning copy lands as it really would
      addItemInstance: (
        itemId: string,
        instance: never,
        _pid: number,
        count = 1,
        opts?: { craftedRecipeId?: string },
      ) => grantInventoryInstances(inventory, itemId, count, instance, opts?.craftedRecipeId),
    },
    clients,
    send: (_s: Session, f: unknown) => frames.push(f),
    notice: (_s: Session, text: string) => frames.push(text),
    leave: () => {
      calls.push('leave');
    },
    save: async () => {
      // the process dies before this save's transaction commits: nothing after runs
      if (faults.save === 'crash-after') return new Promise<boolean>(() => {});
      calls.push('save');
      saved = clone(inventory);
      savedState = savedPlaceschemaAccepted(accepted);
      // the same transaction (syncPlaceschemaAccepted): released claims go, whoever claimed them;
      // this character's added grants are confirmed
      for (const [g, c] of [...claims])
        if (savedState.placeschemaReleased?.includes(c.claim)) claims.delete(g);
      for (const g of savedState.placeschemaAccepted ?? []) {
        const c = claims.get(g);
        // only this character's own pending claims are completed; the landed blob keeps no ids
        if (c?.character === session.characterId) c.pending = false;
      }
      savedState = { ...savedState, placeschemaAccepted: [] };
      return true;
    },
    store: {
      claims: async () => new Map([...claims].map(([g, c]) => [g, c.claim])),
      // claimGrant, statement for statement
      claim: async (_a: number, g: string, character: number) => {
        const c = claims.get(g);
        if (!c) {
          claims.set(g, { claim: nextClaim++, character, pending: true });
          return 'claimed';
        }
        if (!c.pending) return 'held';
        return c.character === character ? 'claimed' : 'busy'; // never taken over
      },
      cancels: async () => [...cancelRows].map(([grant, attempt]) => ({ grant, attempt })),
      putCancels: async (_a: number, gs: readonly string[], attempt: string) => {
        for (const g of gs) cancelRows.set(g, attempt);
      },
      dropCancel: async (_a: number, g: string) => void cancelRows.delete(g),
    },
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(path);
      bodies[path] = init?.body ? JSON.parse(String(init.body)) : undefined;
      // Unreachable: the request never reaches the sidecar, so nothing commits.
      if (faults[path] === 'down') throw new Error('sidecar unreachable');
      const a =
        new URL(url).host === 'sidecar.test' && path === '/.well-known/placeschema.json'
          ? { status: 200, body: { owner: OWNER } }
          : answer(path, bodies[path]);
      if (faults[path] === 'disconnect') clients.delete(1);
      // The sidecar committed, then the game server died before reading the answer.
      if (faults[path] === 'crash-after') return new Promise<Response>(() => {});
      // The sidecar committed, but the answer never arrived: the game server lives on.
      if (faults[path] === 'lost') throw new Error(`lost answer from ${path}`);
      // The game's 10 s abort fires while the sidecar is still waiting on the relay.
      if (faults[path] === 'slow') throw new Error(`aborted ${path}`);
      return new Response(JSON.stringify(a.body), { status: a.status });
    }) as typeof fetch,
  };
  const make = () => new PlaceSchemaCarry<Session>(cfg, deps as never);
  return {
    carry: make(),
    calls,
    bodies,
    worn,
    standAt(x: number, z: number) {
      pos = { x, z };
    },
    bagsHold(n: number) {
      bagCap = n;
    },
    destinationDeclares(m: unknown) {
      manifest = m;
    },
    frames,
    faults,
    escrow,
    equipment,
    other,
    get inventory() {
      return inventory;
    },
    get saved() {
      return saved;
    },
    get accepted() {
      return accepted;
    },
    session: () => session,
    cancelRows,
    claims,
    save: () => deps.save(),
    /** log out, and log in on another character of the SAME account */
    switchCharacter(characterId: number) {
      parked.set(session.characterId, {
        inventory: clone(saved),
        accepted: loadPlaceschemaAccepted(savedState),
        saved,
        savedState,
      });
      const next = parked.get(characterId) ?? {
        inventory: [],
        accepted: new Set<string>(),
        saved: [],
        savedState: {},
      };
      parked.delete(characterId);
      inventory = next.inventory;
      accepted = next.accepted;
      saved = next.saved;
      savedState = next.savedState;
      session = { ...session, characterId };
      clients.set(1, session);
    },
    /** log out and back in: the bag and accepted set load from the last save */
    relogin() {
      inventory = clone(saved);
      accepted = loadPlaceschemaAccepted(savedState);
      clients.set(1, session);
    },
    /** the slow relay finally answers: the delayed carry-out reaches its commit */
    lateCommit() {
      for (const f of late.splice(0)) f();
      return lateResult;
    },
    /** the process dies: memory is gone, the bag and accepted set reload from the last save */
    crash() {
      inventory = clone(saved);
      accepted = loadPlaceschemaAccepted(savedState);
      for (const k of Object.keys(faults)) delete faults[k];
      session = { ...session };
      clients.set(1, session);
      return make();
    },
    /** copies of a grant: bag (or a given bag), equipment, another player, and the escrow */
    copies(g: string, bag: InvSlot[] = inventory) {
      const inGame = [bag, equipment, other, ...[...parked.values()].map((c) => c.saved)].reduce(
        (n, slots) => n + has(slots, g),
        0,
      );
      const e = escrow.get(g);
      const away = e && (e.state === 'in-transit' || e.state === 'landed') ? 1 : 0;
      // an offered grant the game has not accepted yet: the next join adds it
      const due =
        e && e.state === 'held' && e.readd && !(claims.get(g)?.pending === false) && inGame === 0
          ? 1
          : 0;
      return inGame + away + due;
    },
    timeout(g = G1) {
      const e = escrow.get(g);
      if (e?.state === 'in-transit') Object.assign(e, { state: 'held', readd: true });
    },
    arrive(g = G1, label = 'Ember Blade', type?: string) {
      escrow.set(g, { grant: grant(g, type), label, state: 'held', readd: true, ackedSeq: 0 });
    },
  };
}

/** A world where the player already holds G1 (arrived, added, accepted, saved, acked). */
async function holding() {
  const w = world();
  w.arrive();
  await w.carry.join(w.session());
  expect(slotOfGrant(w.inventory, G1)).toBe(0);
  expect(w.claims.get(G1)).toMatchObject({ character: 70, pending: false });
  return w;
}

describe('placeschema sidecar game side (PLACE-276)', () => {
  it('names the player by account id at the realm host, never the username', () => {
    expect(platformId(cfg, 7)).toBe('7@woc.test');
  });

  it('finding 5: the server and the resolver derive the same realm host', async () => {
    const { realmHost } = (await import('../../server/placeschema_resolver.mjs' as string)) as {
      realmHost: (env: Record<string, string | undefined>) => string;
    };
    const serverHost = (env: Record<string, string | undefined>) =>
      sidecarConfig({
        ...env,
        PLACESCHEMA_SIDECAR_URL: 'http://s',
        PLACESCHEMA_MOD_TOKEN: 'x',
      } as never)?.realmHost;
    for (const env of [
      { PUBLIC_ORIGIN: 'https://worldofclaudecraft.com' },
      { PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PLACESCHEMA_REALM_HOST: 'realm.example' },
      { PLACESCHEMA_REALM_HOST: '127.0.0.1:5173', PLACESCHEMA_ALLOW_LOOPBACK: '1' },
    ])
      expect(realmHost(env)).toBe(serverHost(env));
    // round 8: no default host, and loopback only with the explicit development flag
    for (const env of [
      {},
      { PUBLIC_ORIGIN: 'http://127.0.0.1:5173' },
      { PLACESCHEMA_REALM_HOST: 'localhost:5173' },
    ]) {
      expect(() => realmHost(env)).toThrow(/placeschema/);
      expect(() => serverHost(env)).toThrow(/placeschema/);
    }
  });

  it('maps our own mint back to its item, a foreign blade to the stand-in, and anything else to a keepsake', () => {
    expect(itemIdForGrant(grant(G1, 'misc.woc.wolf_fang'))).toBe('wolf_fang');
    expect(itemIdForGrant(grant(G1))).toBe(FOREIGN_WEAPON_ID);
    // PLACE-293: nothing is left without a body, so nothing strands pending in escrow
    for (const type of ['armor.woc.not_an_item', 'potion.heal', 'armor.helmet', 'misc.gem'])
      expect(itemIdForGrant(grant(G1, type))).toBe(FOREIGN_KEEPSAKE_ID);
    expect(itemIdForGrant({ id: G1, tags: [], content: 'not json' })).toBe(FOREIGN_KEEPSAKE_ID);
    expect(ITEMS[FOREIGN_KEEPSAKE_ID]).toMatchObject({ kind: 'junk', noVendorSell: true });
  });

  it('PLACE-293: a foreign helmet arrives as a keepsake named by its grant, and is acked', async () => {
    const w = world();
    w.arrive(G1, 'Diamond Helmet', 'armor.helmet');
    await w.carry.join(w.session());
    expect(w.inventory).toHaveLength(1);
    expect(w.inventory[0]).toMatchObject({
      itemId: FOREIGN_KEEPSAKE_ID,
      instance: { [GRANT_KEY]: G1, name: 'Diamond Helmet' },
    });
    expect(w.escrow.get(G1)?.readd).toBe(false); // acked: nothing waits in escrow
  });

  it('adds an arrival once, accepts it in the same save, then acks', async () => {
    const w = await holding();
    await w.carry.join(w.session());
    expect(w.inventory).toHaveLength(1);
    expect(w.inventory[0].instance).toMatchObject({ [GRANT_KEY]: G1, name: 'Ember Blade' });
    expect(w.calls.indexOf('save')).toBeLessThan(w.calls.indexOf('/mod/ack'));
    expect(slotOfGrant(w.saved, G1)).toBe(0);
  });

  it('finding 2: a crash after the arrival but before the ack keeps exactly one copy', async () => {
    const w = world();
    w.arrive();
    w.faults['/mod/ack'] = 'crash-after';
    void w.carry.join(w.session());
    await flush();
    const again = w.crash();
    expect(slotOfGrant(w.inventory, G1)).toBe(0);
    await again.join(w.session()); // re-offered; the accepted set acks it without adding
    expect(w.inventory).toHaveLength(1);
    expect(w.copies(G1)).toBe(1);
  });

  it('N4 (reviewer): a lost ack, then the item is equipped: the re-offer is acked, not added', async () => {
    const w = world();
    w.arrive();
    w.faults['/mod/ack'] = 'down'; // the ack never reaches the sidecar
    await w.carry.join(w.session()).catch(() => undefined);
    delete w.faults['/mod/ack'];
    w.equipment.push(...w.inventory.splice(0)); // equipped: no longer in the bag
    await w.carry.join(w.session());
    expect(w.inventory).toHaveLength(0);
    expect(w.escrow.get(G1)?.readd).toBe(false); // acked this time
    expect(w.copies(G1)).toBe(1);
  });

  it('N4 (reviewer): a lost ack, then the item is traded away: the re-offer is acked, not added', async () => {
    const w = world();
    w.arrive();
    w.faults['/mod/ack'] = 'down';
    await w.carry.join(w.session()).catch(() => undefined);
    delete w.faults['/mod/ack'];
    w.other.push(...w.inventory.splice(0)); // traded to another player
    await w.carry.join(w.session());
    expect(w.inventory).toHaveLength(0);
    expect(w.copies(G1)).toBe(1);
  });

  it('finding 1: the removal is saved before carry-out, so a crash after it cannot duplicate', async () => {
    const w = await holding();
    w.faults['/mod/carry-out'] = 'crash-after';
    void w.carry.carry(w.session(), [G1]);
    await flush();
    expect(w.calls.lastIndexOf('save')).toBeLessThan(w.calls.lastIndexOf('/mod/carry-out'));
    w.crash();
    expect(slotOfGrant(w.inventory, G1)).toBe(-1);
    expect(w.accepted.has(G1)).toBe(false); // left in the same save as the item
    expect(w.escrow.get(G1)?.state).toBe('in-transit');
    expect(w.copies(G1)).toBe(1);
  });

  it('walks the player to the ticket after a successful carry', async () => {
    const w = await holding();
    await w.carry.carry(w.session(), [G1]);
    expect(w.frames.at(-1)).toEqual({
      t: 'placeschema',
      kind: 'ticket',
      url: 'http://hub.test/arrive#ps-ticket=x',
    });
    expect(w.copies(G1)).toBe(1);
  });

  it('frees the character after a successful carry, once the ticket frame has flushed (PLACE-940)', async () => {
    const w = await holding();
    await w.carry.carry(w.session(), [G1]);
    expect(w.calls).not.toContain('leave');
    await new Promise((r) => setTimeout(r, 1700));
    expect(w.calls.filter((c: string) => c === 'leave')).toHaveLength(1);
    expect(w.calls.lastIndexOf('leave')).toBeGreaterThan(w.calls.lastIndexOf('/mod/carry-out'));
  });

  it('a refused carry comes back only through the sidecar: cancel, then join', async () => {
    const w = await holding();
    w.faults['/mod/carry-out'] = 'refuse';
    await w.carry.carry(w.session(), [G1]);
    expect(w.calls.slice(-4)).toEqual(['/mod/cancel', '/mod/join', 'save', '/mod/ack']);
    expect(slotOfGrant(w.saved, G1)).toBe(0);
    expect(w.frames).toContain('The item could not be carried (link-not-honoured).');
    expect(w.copies(G1)).toBe(1);
  });

  it('finding 3: a player who logs off during a refused carry gets it on the next login join', async () => {
    const w = await holding();
    w.faults['/mod/carry-out'] = 'disconnect';
    await w.carry.carry(w.session(), [G1]);
    expect(w.calls).toContain('/mod/cancel');
    w.relogin(); // the saved bag has no copy; the sidecar re-offers it
    expect(slotOfGrant(w.inventory, G1)).toBe(-1);
    await w.carry.join(w.session());
    expect(slotOfGrant(w.inventory, G1)).toBe(0);
    expect(w.copies(G1)).toBe(1);
  });

  it('offers the link page instead when the account is not linked', async () => {
    const w = world();
    await w.carry.carry(w.session(), [G1]); // never joined: not known to be linked
    expect(w.calls).toContain('/mod/link');
  });

  it('PLACE-479: the link button opens the link page with no item, then reports linked', async () => {
    const w = world();
    await w.carry.link(w.session()); // a fresh account: no item, never joined
    expect(w.calls).toEqual(['/mod/link']);
    expect(w.frames).toEqual([
      { t: 'placeschema', kind: 'link', url: 'https://sidecar.test/link#x' },
    ]);
    w.frames.length = 0;
    w.arrive(); // a Hub item waiting for the link
    await w.carry.join(w.session()); // the 5 s poll, after the player linked
    expect(w.frames[0]).toEqual({ t: 'placeschema', kind: 'status', linked: true });
    expect(slotOfGrant(w.inventory, G1)).toBe(0); // the arrival is delivered
    await w.carry.join(w.session());
    expect(w.frames.filter((f: any) => f?.kind === 'status')).toHaveLength(1); // told once
    w.calls.length = 0;
    w.frames.length = 0;
    await w.carry.link(w.session()); // linked: no new link page, just the status
    expect(w.calls).toEqual([]);
    expect(w.frames).toEqual([{ t: 'placeschema', kind: 'status', linked: true }]);
  });

  it('PLACE-479: a spammed link button makes exactly one /mod/link call', async () => {
    const w = world();
    await Promise.all(Array.from({ length: 5 }, () => w.carry.link(w.session())));
    expect(w.calls.filter((c) => c === '/mod/link')).toHaveLength(1);
    await w.carry.link(w.session()); // once it settles, a later click works again
    expect(w.calls.filter((c) => c === '/mod/link')).toHaveLength(2);
  });

  it('N2: slow relay, the game aborts, the item is traded away, then the late commit: one copy', async () => {
    const w = await holding();
    w.faults['/mod/carry-out'] = 'slow';
    await w.carry.carry(w.session(), [G1]); // aborted: cancel names the attempt, join brings it back
    expect(slotOfGrant(w.inventory, G1)).toBe(0);
    w.other.push(...w.inventory.splice(0)); // traded to another player
    const late = w.lateCommit(); // the delayed carry-out finally reaches its commit
    expect(late?.status).toBe(409);
    expect(late?.body).toEqual({ error: `cancelled:${G1}` });
    expect(w.escrow.get(G1)?.state).toBe('held');
    expect(w.copies(G1)).toBe(1);
  });

  it('N3 (reviewer): a cancel whose answer is lost is retried after join acked: no second copy', async () => {
    const w = await holding();
    w.faults['/mod/carry-out'] = 'lost'; // committed; the answer never came back
    w.faults['/mod/cancel'] = 'lost'; // the cancel committed too; its answer is lost
    await w.carry.carry(w.session(), [G1]);
    expect(slotOfGrant(w.inventory, G1)).toBe(-1); // no adds while a cancel is unconfirmed
    delete w.faults['/mod/cancel'];
    delete w.faults['/mod/carry-out'];
    await w.carry.join(w.session()); // retried cancel (a no-op now), then the one re-offer
    expect(slotOfGrant(w.inventory, G1)).toBe(0);
    w.equipment.push(...w.inventory.splice(0));
    await w.carry.join(w.session());
    await w.carry.join(w.session());
    expect(w.inventory).toHaveLength(0);
    expect(w.copies(G1)).toBe(1);
  });

  it('N1: lost carry-out answer, copy moved away, escrow timeout, join: one copy', async () => {
    const w = await holding();
    w.faults['/mod/carry-out'] = 'lost';
    await w.carry.carry(w.session(), [G1]);
    expect(slotOfGrant(w.inventory, G1)).toBe(0); // back through cancel + join only
    w.equipment.push(...w.inventory.splice(0));
    w.timeout();
    await w.carry.join(w.session());
    expect(w.inventory).toHaveLength(0);
    expect(w.copies(G1)).toBe(1);
  });

  it('an unreachable sidecar keeps the copy out; the cancel is retried before the next join', async () => {
    const w = await holding();
    w.faults['/mod/carry-out'] = 'down';
    w.faults['/mod/cancel'] = 'down';
    w.faults['/mod/join'] = 'down';
    await w.carry.carry(w.session(), [G1]);
    expect(slotOfGrant(w.inventory, G1)).toBe(-1); // never added back by the game
    expect(w.copies(G1)).toBe(0); // out of the game, held by the sidecar: recoverable, never two
    for (const k of ['/mod/cancel', '/mod/join']) delete w.faults[k];
    await w.carry.join(w.session());
    expect(slotOfGrant(w.inventory, G1)).toBe(0);
    await w.carry.join(w.session());
    expect(w.copies(G1)).toBe(1);
  });

  it('B1 (reviewer): character A adds it, the ack is lost, character B on the same account joins: one copy', async () => {
    const w = world();
    w.arrive();
    w.faults['/mod/ack'] = 'down'; // A added and saved it; the ack never arrived
    await w.carry.join(w.session()).catch(() => undefined);
    delete w.faults['/mod/ack'];
    expect(w.claims.get(G1)).toMatchObject({ character: 70, pending: false }); // the ACCOUNT's claim
    w.switchCharacter(71); // character B, same account
    await w.carry.join(w.session());
    expect(w.inventory).toHaveLength(0); // acked, not added again
    expect(w.escrow.get(G1)?.readd).toBe(false);
    expect(w.copies(G1)).toBe(1);
  });

  it('N-a: an unconfirmed cancel is persisted and retried after a restart', async () => {
    const w = await holding();
    w.faults['/mod/carry-out'] = 'down';
    w.faults['/mod/cancel'] = 'down';
    w.faults['/mod/join'] = 'down';
    await w.carry.carry(w.session(), [G1]);
    expect([...w.cancelRows.keys()]).toEqual([G1]);
    const again = w.crash(); // the process restarts: memory is gone, the cancel row is not
    await again.join(w.session());
    expect(w.cancelRows.size).toBe(0);
    expect(slotOfGrant(w.inventory, G1)).toBe(0);
    expect(w.copies(G1)).toBe(1);
  });

  it('N-b: a copy traded in from another account is refused before anything is removed', async () => {
    const w = world();
    w.inventory.push({
      itemId: FOREIGN_WEAPON_ID,
      count: 1,
      instance: { [GRANT_KEY]: G1 } as never,
    });
    await w.carry.join(w.session()); // linked; nothing accepted by this account
    await w.carry.carry(w.session(), [G1]);
    expect(slotOfGrant(w.inventory, G1)).toBe(0); // still there
    expect(w.calls).not.toContain('/mod/carry-out');
    expect(w.frames.at(-1)).toBe('The item could not be carried (not-yours).');
  });

  it('N-b: a cancel the sidecar answers not-yours is settled and does not wedge arrivals', async () => {
    const w = world();
    const G2 = 'b'.repeat(64);
    w.arrive(G2, 'Traded Blade');
    w.escrow.get(G2)!.holder = 'someone-else';
    w.cancelRows.set(G2, 'c'.repeat(32));
    w.arrive(G1);
    w.escrow.get(G2)!.readd = false;
    await w.carry.join(w.session());
    expect(w.cancelRows.size).toBe(0);
    expect(slotOfGrant(w.inventory, G1)).toBe(0);
  });

  it('B2 (reviewer): accepted on A, mailed to B, B carries, refused, join: exactly one copy', async () => {
    const w = await holding(); // character A (70) claimed and holds G1
    const [copy] = w.inventory.splice(0); // A mails it to B
    await w.save(); // A's save (the claim is still A's)
    w.switchCharacter(71); // B, same account, opens the mail
    w.inventory.push(copy);
    w.faults['/mod/carry-out'] = 'refuse'; // the carry fails; the sidecar re-offers it
    await w.carry.carry(w.session(), [G1]);
    expect(slotOfGrant(w.inventory, G1)).toBe(0); // B's release deleted A's claim, so B re-claimed it
    expect(w.copies(G1)).toBe(1);
  });

  it('N1 claim first: a crash after the claim but before the item save re-adds it exactly once', async () => {
    const w = world();
    w.arrive();
    w.faults.save = 'crash-after';
    void w.carry.join(w.session());
    await flush();
    expect(w.claims.get(G1)).toMatchObject({ character: 70, pending: true }); // claimed, never saved
    expect(w.frames.filter((f: any) => f?.kind !== 'status' && f?.kind !== 'skins')).toEqual([]); // nothing announced before the save landed
    const again = w.crash();
    expect(slotOfGrant(w.inventory, G1)).toBe(-1);
    await again.join(w.session()); // re-offered; the pending claim is ours: added once
    expect(slotOfGrant(w.inventory, G1)).toBe(0);
    expect(w.claims.get(G1)?.pending).toBe(false);
    await again.join(w.session());
    expect(w.copies(G1)).toBe(1);
  });
  it('finding 4: a quest reward stays one copy when the mint answer is lost to a crash', async () => {
    const w = world();
    await w.carry.join(w.session()); // learns the player is linked
    w.inventory.push({ itemId: 'greyjaw_pelt_cloak', count: 1 });
    w.faults['/mod/mint'] = 'crash-after';
    void w.carry.questDone(w.session(), 'q_greyjaw');
    await flush();
    const again = w.crash(); // the saved bag holds the TAGGED plain copy
    expect(w.inventory).toEqual([
      { itemId: 'greyjaw_pelt_cloak', count: 1, instance: { [PENDING_KEY]: 'greyjaw_pelt_cloak' } },
    ]);
    await again.join(w.session()); // the minted grant arrives and converts exactly that copy
    expect(w.inventory).toHaveLength(1);
    expect(w.inventory[0]).toMatchObject({
      itemId: 'greyjaw_pelt_cloak',
      instance: { [GRANT_KEY]: G1 },
    });
    expect(w.claims.get(G1)?.pending).toBe(false);
    expect(w.copies(G1)).toBe(1);
  });

  it('finding 4: the normal quest path ends with exactly one signed copy', async () => {
    const w = world();
    await w.carry.join(w.session());
    w.inventory.push({ itemId: 'greyjaw_pelt_cloak', count: 1 });
    await w.carry.questDone(w.session(), 'q_greyjaw');
    expect(w.inventory).toHaveLength(1);
    expect(w.inventory[0].instance).toMatchObject({ [GRANT_KEY]: G1 });
    expect(w.calls.filter((c) => c === '/mod/mint')).toHaveLength(1);
  });

  it('finding 4: no plain reward in the bag (it went elsewhere) means no mint at all', async () => {
    const w = world();
    await w.carry.join(w.session());
    await w.carry.questDone(w.session(), 'q_greyjaw');
    expect(w.calls).not.toContain('/mod/mint');
    expect(w.inventory).toHaveLength(0);
  });
});

describe('PLACE-954: carrying out is a walk through the portal', () => {
  const G2 = 'b'.repeat(64);
  const G3 = 'c'.repeat(64);
  const shore = PLACESCHEMA_PORTALS[0];
  // a step south of the shore gate, then into its opening (either side goes through)
  const before = { x: shore.x, z: shore.z - 3 };
  const walkThrough = (w: ReturnType<typeof world>) => {
    w.standAt(before.x, before.z);
    w.carry.checkPortals();
    w.standAt(shore.x, shore.z);
    w.carry.checkPortals();
  };
  /** G1 in the bag, G2 accepted and held in the main hand */
  async function holdingTwo() {
    const w = await holding();
    w.arrive(G2, 'Z-blade');
    await w.carry.join(w.session());
    w.worn.mainhand = w.inventory.splice(slotOfGrant(w.inventory, G2), 1)[0].instance;
    return w;
  }

  it('carries every own copy in one carry-out, the worn one as its slot; a traded copy stays', async () => {
    const w = await holdingTwo();
    w.inventory.push({
      itemId: FOREIGN_WEAPON_ID,
      count: 1,
      instance: { [GRANT_KEY]: G3 } as never,
    });
    walkThrough(w);
    await flush();
    expect([...w.bodies['/mod/carry-out'].grants].sort()).toEqual([G1, G2]);
    expect(w.bodies['/mod/carry-out'].equipped).toEqual({ grip: G2 });
    expect(w.frames).toContain(
      "Some items here aren't yours to carry through this portal; they stay with you.",
    );
    expect(w.frames.at(-1)).toMatchObject({ kind: 'ticket' });
    expect(w.calls.lastIndexOf('save')).toBeLessThan(w.calls.lastIndexOf('/mod/carry-out'));
    expect(slotOfGrant(w.saved, G1)).toBe(-1);
    expect(slotOfGrant(w.saved, G2)).toBe(-1);
    expect(slotOfGrant(w.saved, G3)).toBe(0); // not this account's: it stays
    expect(w.worn.mainhand).toBeUndefined();
    expect(w.copies(G1)).toBe(1);
    expect(w.copies(G2)).toBe(1);
  });

  it('full bags: the bag copy leaves first, making room for the worn one', async () => {
    const w = await holdingTwo();
    w.bagsHold(1); // G1 fills them
    walkThrough(w);
    await flush();
    expect([...w.bodies['/mod/carry-out'].grants].sort()).toEqual([G1, G2]);
    expect(w.bodies['/mod/carry-out'].equipped).toEqual({ grip: G2 });
  });

  it('full of ordinary items, a held copy asks for room and nothing leaves', async () => {
    const w = await holdingTwo();
    w.carry.onCarryCommand(w.session(), 'mainhand'); // only the Z-blade
    w.bagsHold(1); // G1 fills the bags and is not leaving
    walkThrough(w);
    await flush();
    expect(w.calls).not.toContain('/mod/carry-out');
    expect(String(w.frames.at(-1))).toMatch(/Make room for one item in your bags/);
    expect(w.worn.mainhand).toBeTruthy();
    expect(slotOfGrant(w.inventory, G1)).toBe(0);
  });

  it('every cancel is persisted before any is sent', async () => {
    const w = await holdingTwo();
    w.faults['/mod/carry-out'] = 'down';
    w.faults['/mod/cancel'] = 'down';
    w.faults['/mod/join'] = 'down';
    walkThrough(w);
    await flush();
    expect([...w.cancelRows.keys()].sort()).toEqual([G1, G2]);
  });

  it('the bag action marks the item and points to the portal, which then carries just that', async () => {
    const w = await holdingTwo();
    w.carry.onCarryCommand(w.session(), slotOfGrant(w.inventory, G1));
    await flush();
    expect(w.calls).not.toContain('/mod/carry-out');
    expect(String(w.frames.at(-1))).toMatch(/ready to carry: walk through the PlaceSchema portal/);
    walkThrough(w);
    await flush();
    expect(w.bodies['/mod/carry-out'].grants).toEqual([G1]);
    expect(w.worn.mainhand).toBeTruthy(); // the unmarked Z-blade stays in hand
  });

  it("the portal shows the destination's own picture, once per session, never a foreign one", async () => {
    const w = world();
    w.destinationDeclares({ preview: '/assets/preview-1.jpg' });
    await w.carry.join(w.session());
    await w.carry.join(w.session());
    await flush();
    const shown = w.frames.filter((f) => (f as { kind?: string }).kind === 'portal');
    expect(shown).toEqual([
      { t: 'placeschema', kind: 'portal', url: 'http://hub.test/assets/preview-1.jpg' },
    ]);
    const down = world(); // the destination is briefly down: a later session tries again
    down.faults['/.well-known/placeschema.json'] = 'down';
    await down.carry.join(down.session());
    await flush();
    delete down.faults['/.well-known/placeschema.json'];
    down.destinationDeclares({ preview: '/assets/preview-2.jpg' });
    down.relogin();
    (down.carry as unknown as { told: WeakMap<object, unknown> }).told = new WeakMap(); // a new session
    await down.carry.join(down.session());
    await flush();
    expect(down.frames.filter((f) => (f as { kind?: string }).kind === 'portal')).toHaveLength(1);
    const other = world();
    other.destinationDeclares({ preview: 'https://evil.test/beacon.jpg' });
    await other.carry.join(other.session());
    await flush();
    expect(other.frames.some((f) => (f as { kind?: string }).kind === 'portal')).toBe(false);
  });

  it('with nothing to carry the portal still opens, as the player', async () => {
    const w = world();
    await w.carry.join(w.session()); // linked, empty-handed
    walkThrough(w);
    await flush();
    expect(w.bodies['/mod/carry-out'].grants).toEqual([]);
    expect(w.frames.at(-1)).toMatchObject({ kind: 'ticket' });
  });

  it('logging in inside the portal carries nothing until the player steps out and back in', async () => {
    const w = await holding();
    w.standAt(shore.x, shore.z);
    w.carry.checkPortals();
    w.carry.checkPortals();
    await flush();
    expect(w.calls).not.toContain('/mod/carry-out');
    expect(slotOfGrant(w.inventory, G1)).toBe(0);
  });

  it('stepping through a frame block counts: the frame has no collider, so it is the gate too', () => {
    const g = new PlaceSchemaPortalGate();
    expect(g.tick({ x: shore.x + 1.4, z: shore.z - 3 })).toBe(false);
    expect(g.tick({ x: shore.x + 1.4, z: shore.z + 3 })).toBe(true);
  });

  it('only the gate counts: beside its frame never fires, a run straight through always does', () => {
    const g = new PlaceSchemaPortalGate();
    expect(g.tick({ x: shore.x + 1.9, z: shore.z - 3 })).toBe(false);
    expect(g.tick({ x: shore.x + 1.9, z: shore.z })).toBe(false); // alongside the frame
    expect(g.tick({ x: shore.x + 1.9, z: shore.z + 3 })).toBe(false); // past it
    expect(g.tick({ x: shore.x, z: shore.z + 3 })).toBe(false);
    expect(g.tick({ x: shore.x + 0.3, z: shore.z - 2 })).toBe(true); // through the sheet between looks
  });

  it('the walk-in gate never fires on arriving inside, fires once on entering, then re-arms outside', () => {
    const g = new PlaceSchemaPortalGate();
    const inside = { x: shore.x, z: shore.z };
    const outside = { x: shore.x, z: shore.z - 3 }; // a step in front of the sheet
    expect(g.tick(inside)).toBe(false); // logged in standing in it
    expect(g.tick(outside)).toBe(false);
    expect(g.tick(inside)).toBe(true);
    expect(g.tick(inside)).toBe(false); // still standing in it (a refused carry)
    expect(g.tick(outside)).toBe(false);
    expect(g.tick(inside, true)).toBe(false); // the dead don't travel
    expect(g.tick(inside)).toBe(false); // revived inside: not a walk-in
    expect(g.tick(outside)).toBe(false);
    expect(g.tick(inside)).toBe(true);
  });

  it('stepping out of the sheet re-arms; stepping back in fires', () => {
    const g = new PlaceSchemaPortalGate();
    expect(g.tick({ x: shore.x, z: shore.z })).toBe(false); // logged in inside
    expect(g.tick({ x: shore.x, z: shore.z - 3 })).toBe(false); // out through the front
    expect(g.tick({ x: shore.x, z: shore.z })).toBe(true);
  });

  it('one crossing carries at most the claims one save can release; the rest stay', async () => {
    const w = world();
    const ids = Array.from({ length: 66 }, (_, i) => i.toString(16).padStart(64, '0'));
    for (const g of ids) w.arrive(g, `Blade ${g.slice(-2)}`);
    await w.carry.join(w.session());
    walkThrough(w);
    await flush();
    expect(w.bodies['/mod/carry-out'].grants).toHaveLength(64);
    expect(w.inventory).toHaveLength(2);
    expect(w.frames).toContain(
      'More items than one crossing carries: walk through again for the rest.',
    );
  });

  it('arriving from far away into the opening (a ferry, a respawn) is not a walk-in', () => {
    const g = new PlaceSchemaPortalGate();
    expect(g.tick({ x: 0, z: -100 })).toBe(false);
    expect(g.tick({ x: 0, z: -101 })).toBe(false); // armed, walking about town
    expect(g.tick({ x: 0, z: -20 })).toBe(false); // set down in Eastbrook's opening
  });

  it('stepping back in while a carry is in flight queues nothing', async () => {
    const w = await holding();
    w.faults['/mod/carry-out'] = 'slow';
    walkThrough(w);
    w.standAt(before.x, before.z);
    w.carry.checkPortals();
    w.standAt(shore.x, shore.z);
    w.carry.checkPortals();
    await flush();
    expect(w.calls.filter((c: string) => c === '/mod/carry-out')).toHaveLength(1);
  });
});

describe("B1': one serialisation point per account, claim first (rounds 6 and 7)", () => {
  /** Two characters of one account online at once (a GM session, a linkdead overlap), one sidecar. */
  function twoOnline(opts: { failSaveOf?: number; noLock?: boolean } = {}) {
    const bags = new Map<number, InvSlot[]>([
      [1, []],
      [2, []],
    ]);
    const sets = new Map<number, Set<string>>([
      [1, new Set()],
      [2, new Set()],
    ]);
    const claims = new Map<string, Claim>();
    const offered = new Map([[G1, { grant: grant(G1), label: 'Ember Blade', acked: false }]]);
    const calls: string[] = [];
    const notices: string[] = [];
    const clients = new Map([
      [1, { accountId: 7, characterId: 70, pid: 1, selfHeavyDirty: false }],
      [2, { accountId: 7, characterId: 71, pid: 2, selfHeavyDirty: false }],
    ]);
    const carry = new PlaceSchemaCarry(cfg, {
      sim: {
        meta: (pid: number) => ({
          inventory: bags.get(pid),
          placeschemaAccepted: sets.get(pid),
          cls: 'warrior',
        }),
        addItemInstance: (itemId: string, instance: never, pid: number) => {
          bags.get(pid)?.push({ itemId, count: 1, instance });
        },
      },
      clients,
      send: () => {},
      notice: (_s: unknown, n: string) => notices.push(n),
      save: async (s: { characterId: number; pid: number }) => {
        calls.push(`save:${s.characterId}`);
        await flush(); // a real save takes time: another character could interleave here
        if (opts.failSaveOf === s.characterId) return false;
        for (const g of sets.get(s.pid)!) {
          const c = claims.get(g);
          if (c?.character === s.characterId) c.pending = false;
        }
        return true;
      },
      store: {
        claims: async () => new Map([...claims].map(([g, c]) => [g, c.claim])),
        claim: async (_a: number, g: string, character: number) => {
          await flush();
          const c = claims.get(g);
          if (!c) {
            claims.set(g, { claim: 1, character, pending: true });
            return 'claimed';
          }
          if (!c.pending) return 'held';
          return c.character === character ? 'claimed' : 'busy';
        },
        cancels: async () => [],
        putCancels: async () => {},
        dropCancel: async () => {},
      },
      fetch: (async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push(path);
        const b = JSON.parse(String(init.body));
        if (path === '/mod/join')
          return new Response(
            JSON.stringify({ holder: 'h', add: [...offered.values()].filter((o) => !o.acked) }),
          );
        if (path === '/mod/ack') for (const g of b.grants) offered.get(g)!.acked = true;
        return new Response('{}');
      }) as typeof fetch,
    } as never);
    if (opts.noLock)
      (carry as unknown as { locked: (a: number, j: () => unknown) => unknown }).locked = (_a, j) =>
        j();
    const copies = () => [...bags.values()].reduce((n, bag) => n + has(bag, G1), 0);
    return { carry, clients, bags, sets, claims, calls, copies, notices };
  }

  it('two characters of one account joining at once add the grant exactly once', async () => {
    const w = twoOnline();
    await Promise.all([
      w.carry.join(w.clients.get(1)! as never),
      w.carry.join(w.clients.get(2)! as never),
    ]);
    expect(w.copies()).toBe(1);
  });

  it('the claim alone (without the account lock) still keeps it to one copy', async () => {
    const w = twoOnline({ noLock: true });
    await Promise.all([
      w.carry.join(w.clients.get(1)! as never),
      w.carry.join(w.clients.get(2)! as never),
    ]);
    expect(w.copies()).toBe(1);
  });

  it('claim first: a failed item save announces and acks nothing; another online character waits', async () => {
    const w = twoOnline({ failSaveOf: 70 });
    await w.carry.join(w.clients.get(1)! as never);
    expect(w.claims.get(G1)).toMatchObject({ character: 70, pending: true });
    expect(w.notices).toEqual([]);
    expect(w.calls).not.toContain('/mod/ack');
    await w.carry.join(w.clients.get(2)! as never); // 70 is online with it pending: busy
    expect(w.copies()).toBe(1);
  });
});

describe('PLACE-990: a copy carries its own WoC data and comes home whole', () => {
  const enchanted: InvSlot = {
    itemId: 'redbrook_blade',
    count: 1,
    craftedRecipeId: 'r_example',
    materialSources: { iron_ore: 2 } as never,
    materialSeparated: true,
    instance: {
      enchant: 'ench_example',
      rolled: { stats: { str: 2 } },
      signer: 'Smith',
      boundTo: 7,
      [GRANT_KEY]: G1,
      [PENDING_KEY]: 'redbrook_blade',
    } as never,
  };
  const minted = (slot: InvSlot, minter = OWNER) => ({
    id: G1,
    tags: [],
    content: JSON.stringify({ ...templateFor(slot.itemId, slot), minter }),
  });

  it('round-trips the slot and the catalog def through the grant, never our own bookkeeping', () => {
    const n = nativeOf(minted(enchanted), OWNER);
    expect(n).toEqual({
      v: 1,
      itemId: 'redbrook_blade',
      count: 1,
      craftedRecipeId: 'r_example',
      materialSources: { iron_ore: 2 },
      materialSeparated: true,
      instance: {
        enchant: 'ench_example',
        rolled: { stats: { str: 2 } },
        signer: 'Smith',
        boundTo: 7,
      },
      def: JSON.parse(JSON.stringify(ITEMS.redbrook_blade)),
    });
  });

  it('fits the template limits: every feature at most 525 chars, the content under 4096 bytes', () => {
    const t = templateFor('redbrook_blade', enchanted);
    expect(t.features.every((f) => f.length <= 525)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ ...t, minter: OWNER }))).toBeLessThan(4096);
  });

  it('trusts native data only from our own minter: anyone else could write any stats there', () => {
    expect(nativeOf(minted(enchanted, 'e'.repeat(64)), OWNER)).toBeUndefined();
    expect(nativeOf(minted(enchanted), undefined)).toBeUndefined();
  });

  it('too big to fit: mints by id only, with no partial native data', () => {
    const huge = { ...enchanted, instance: { signer: 'x'.repeat(4000) } as never };
    expect(nativeFeatures(huge)).toEqual([]);
  });

  it('WoC -> away -> WoC: the copy that left is the copy that comes back, field for field', async () => {
    const w = world();
    await w.carry.join(w.session());
    w.inventory.push({ itemId: 'greyjaw_pelt_cloak', count: 1 });
    await w.carry.questDone(w.session(), 'q_greyjaw');
    const before = clone(w.inventory[0]);
    // the label no longer overwrites the copy's own (player-chosen) name field
    expect(before.instance).toEqual({ [GRANT_KEY]: G1 });
    await w.carry.carry(w.session());
    expect(slotOfGrant(w.inventory, G1)).toBe(-1);
    w.timeout(); // it comes home
    await w.carry.join(w.session());
    expect(w.inventory).toEqual([before]);
  });

  it('an enchanted Redbrook Militia Blade we minted comes home with its enchant, rolls, signer and binding', async () => {
    const w = world();
    await w.carry.join(w.session());
    w.escrow.set(G1, {
      grant: minted(enchanted),
      label: 'Redbrook Militia Blade',
      state: 'held',
      readd: true,
      ackedSeq: 0,
    });
    await w.carry.join(w.session());
    expect(w.inventory).toEqual([
      {
        itemId: 'redbrook_blade',
        count: 1,
        craftedRecipeId: 'r_example',
        materialSources: { iron_ore: 2 },
        materialSeparated: true,
        instance: {
          enchant: 'ench_example',
          rolled: { stats: { str: 2 } },
          signer: 'Smith',
          boundTo: 7,
          [GRANT_KEY]: G1,
        },
      },
    ]);
  });

  it('the same data under another minter is not trusted: the copy comes from the catalog', async () => {
    const w = world();
    await w.carry.join(w.session());
    const forged = minted(enchanted, 'e'.repeat(64));
    w.escrow.set(G1, {
      grant: forged,
      label: 'Redbrook Militia Blade',
      state: 'held',
      readd: true,
      ackedSeq: 0,
    });
    await w.carry.join(w.session());
    expect(w.inventory[0].instance).toEqual({ [GRANT_KEY]: G1, name: 'Redbrook Militia Blade' });
  });

  it('our minter unknown (manifest down): the native copy waits unclaimed, then comes home whole', async () => {
    const w = world();
    await w.carry.join(w.session());
    w.inventory.push({ itemId: 'greyjaw_pelt_cloak', count: 1 });
    await w.carry.questDone(w.session(), 'q_greyjaw');
    const before = clone(w.inventory[0]);
    await w.carry.carry(w.session());
    w.timeout();
    const fresh = w.crash(); // a new process: the minter is not known yet
    w.faults['/.well-known/placeschema.json'] = 'down';
    await fresh.join(w.session());
    expect(slotOfGrant(w.inventory, G1)).toBe(-1); // not added, not acked, not claimed
    expect(w.claims.has(G1)).toBe(false);
    delete w.faults['/.well-known/placeschema.json'];
    await fresh.join(w.session());
    expect(w.inventory).toEqual([before]);
  });
});
