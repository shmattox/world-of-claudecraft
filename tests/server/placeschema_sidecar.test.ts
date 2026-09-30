import { describe, expect, it } from 'vitest';
import {
  FOREIGN_WEAPON_ID,
  GRANT_KEY,
  itemIdForGrant,
  PENDING_KEY,
  PlaceSchemaCarry,
  platformId,
  sidecarConfig,
  slotOfGrant,
} from '../../server/placeschema_sidecar';
import type { InvSlot } from '../../src/sim/types';

const G1 = 'a'.repeat(64);
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
  savedAccepted: Set<string>;
};
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
  let savedAccepted = new Set<string>();
  const equipment: InvSlot[] = [];
  const other: InvSlot[] = [];
  const escrow = new Map<string, Item>();
  // the account-level store (placeschema_accepted / placeschema_cancels): grant -> owning character
  const accountSet = new Map<string, number>();
  const cancelRows = new Map<string, string>();
  const parked = new Map<number, Char>(); // the account's other characters, as saved
  const attempts = new Map<string, { seq: number; state: string }>();
  const calls: string[] = [];
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
    if (path === '/mod/ack') {
      for (const g of b.grants) {
        const e = escrow.get(g)!;
        if (e.state === 'held' && e.readd) Object.assign(e, { readd: false, ackedSeq: ++seq });
      }
      return { status: 200, body: { ok: true } };
    }
    if (path === '/mod/mint') {
      const g = grant(G1, b.template.type);
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
      meta: () => ({ inventory, placeschemaAccepted: accepted, cls: 'warrior' }) as never,
      addItemInstance: (itemId: string, instance: never) => {
        inventory.push({ itemId, count: 1, instance });
      },
    },
    clients,
    send: (_s: Session, f: unknown) => frames.push(f),
    notice: (_s: Session, text: string) => frames.push(text),
    save: async () => {
      calls.push('save');
      saved = clone(inventory);
      savedAccepted = new Set(accepted);
      // the same transaction mirrors this character's accepted ids into the account set
      for (const [g, c] of [...accountSet])
        if (c === session.characterId && !accepted.has(g)) accountSet.delete(g);
      for (const g of accepted) accountSet.set(g, session.characterId);
      return true;
    },
    store: {
      accepted: async () => new Set(accountSet.keys()),
      cancels: async () => [...cancelRows].map(([grant, attempt]) => ({ grant, attempt })),
      putCancel: async (_a: number, g: string, attempt: string) => void cancelRows.set(g, attempt),
      dropCancel: async (_a: number, g: string) => void cancelRows.delete(g),
    },
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(path);
      // Unreachable: the request never reaches the sidecar, so nothing commits.
      if (faults[path] === 'down') throw new Error('sidecar unreachable');
      const a = answer(path, JSON.parse(String(init.body)));
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
    accountSet,
    /** log out, and log in on another character of the SAME account */
    switchCharacter(characterId: number) {
      parked.set(session.characterId, {
        inventory: clone(saved),
        accepted: new Set(savedAccepted),
        saved,
        savedAccepted,
      });
      const next = parked.get(characterId) ?? {
        inventory: [],
        accepted: new Set<string>(),
        saved: [],
        savedAccepted: new Set<string>(),
      };
      parked.delete(characterId);
      inventory = next.inventory;
      accepted = next.accepted;
      saved = next.saved;
      savedAccepted = next.savedAccepted;
      session = { ...session, characterId };
      clients.set(1, session);
    },
    /** log out and back in: the bag and accepted set load from the last save */
    relogin() {
      inventory = clone(saved);
      accepted = new Set(savedAccepted);
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
      accepted = new Set(savedAccepted);
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
        e && e.state === 'held' && e.readd && !accepted.has(g) && !accountSet.has(g) && inGame === 0
          ? 1
          : 0;
      return inGame + away + due;
    },
    timeout(g = G1) {
      const e = escrow.get(g);
      if (e?.state === 'in-transit') Object.assign(e, { state: 'held', readd: true });
    },
    arrive(g = G1, label = 'Ember Blade') {
      escrow.set(g, { grant: grant(g), label, state: 'held', readd: true, ackedSeq: 0 });
    },
  };
}

/** A world where the player already holds G1 (arrived, added, accepted, saved, acked). */
async function holding() {
  const w = world();
  w.arrive();
  await w.carry.join(w.session());
  expect(slotOfGrant(w.inventory, G1)).toBe(0);
  expect(w.accepted.has(G1)).toBe(true);
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
    for (const env of [
      { PUBLIC_ORIGIN: 'https://worldofclaudecraft.com' },
      { PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PLACESCHEMA_REALM_HOST: 'realm.example' },
      {},
    ]) {
      const server = sidecarConfig({
        ...env,
        PLACESCHEMA_SIDECAR_URL: 'http://s',
        PLACESCHEMA_MOD_TOKEN: 'x',
      } as never);
      expect(realmHost(env)).toBe(server?.realmHost);
    }
  });

  it('maps our own mint back to its item, a foreign blade to the stand-in, and nothing else', () => {
    expect(itemIdForGrant(grant(G1, 'misc.woc.wolf_fang'))).toBe('wolf_fang');
    expect(itemIdForGrant(grant(G1, 'armor.woc.not_an_item'))).toBeUndefined();
    expect(itemIdForGrant(grant(G1))).toBe(FOREIGN_WEAPON_ID);
    expect(itemIdForGrant(grant(G1, 'potion.heal'))).toBeUndefined();
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
    void w.carry.carry(w.session(), G1);
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
    await w.carry.carry(w.session(), G1);
    expect(w.frames.at(-1)).toEqual({
      t: 'placeschema',
      kind: 'ticket',
      url: 'http://hub.test/arrive#ps-ticket=x',
    });
    expect(w.copies(G1)).toBe(1);
  });

  it('a refused carry comes back only through the sidecar: cancel, then join', async () => {
    const w = await holding();
    w.faults['/mod/carry-out'] = 'refuse';
    await w.carry.carry(w.session(), G1);
    expect(w.calls.slice(-4)).toEqual(['/mod/cancel', '/mod/join', 'save', '/mod/ack']);
    expect(slotOfGrant(w.saved, G1)).toBe(0);
    expect(w.frames).toContain('The item could not be carried (link-not-honoured).');
    expect(w.copies(G1)).toBe(1);
  });

  it('finding 3: a player who logs off during a refused carry gets it on the next login join', async () => {
    const w = await holding();
    w.faults['/mod/carry-out'] = 'disconnect';
    await w.carry.carry(w.session(), G1);
    expect(w.calls).toContain('/mod/cancel');
    w.relogin(); // the saved bag has no copy; the sidecar re-offers it
    expect(slotOfGrant(w.inventory, G1)).toBe(-1);
    await w.carry.join(w.session());
    expect(slotOfGrant(w.inventory, G1)).toBe(0);
    expect(w.copies(G1)).toBe(1);
  });

  it('offers the link page instead when the account is not linked', async () => {
    const w = world();
    await w.carry.carry(w.session(), G1); // never joined: not known to be linked
    expect(w.calls).toContain('/mod/link');
  });

  it('N2: slow relay, the game aborts, the item is traded away, then the late commit: one copy', async () => {
    const w = await holding();
    w.faults['/mod/carry-out'] = 'slow';
    await w.carry.carry(w.session(), G1); // aborted: cancel names the attempt, join brings it back
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
    await w.carry.carry(w.session(), G1);
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
    await w.carry.carry(w.session(), G1);
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
    await w.carry.carry(w.session(), G1);
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
    expect(w.accountSet.get(G1)).toBe(70); // the save put it in the ACCOUNT set
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
    await w.carry.carry(w.session(), G1);
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
    await w.carry.carry(w.session(), G1);
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
    expect(w.accepted.has(G1)).toBe(true);
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

describe("B1': one serialisation point per account (round 6)", () => {
  /** Two characters of one account online at once (a GM session, a linkdead overlap), one sidecar. */
  function twoOnline(opts: { conflictOn?: number; noDbGuard?: boolean } = {}) {
    const bags = new Map<number, InvSlot[]>([
      [1, []],
      [2, []],
    ]);
    const sets = new Map<number, Set<string>>([
      [1, new Set()],
      [2, new Set()],
    ]);
    const accountSet = new Map<string, number>();
    const offered = new Map([[G1, { grant: grant(G1), label: 'Ember Blade', acked: false }]]);
    const calls: string[] = [];
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
      notice: () => {},
      save: async (s: { characterId: number; pid: number }) => {
        calls.push(`save:${s.characterId}`);
        await flush(); // a real save takes time: the other character could interleave here
        for (const g of sets.get(s.pid)!) {
          const owner = accountSet.get(g);
          // the database refuses a claim another character holds (placeschema_accepted_db.ts)
          const refused = !opts.noDbGuard && owner !== undefined && owner !== s.characterId;
          if (refused || opts.conflictOn === s.characterId)
            throw new Error('PlaceschemaClaimConflict');
          accountSet.set(g, s.characterId);
        }
        return true;
      },
      store: {
        accepted: async () => new Set(accountSet.keys()),
        cancels: async () => [],
        putCancel: async () => {},
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
    const copies = () => [...bags.values()].reduce((n, bag) => n + has(bag, G1), 0);
    return { carry, clients, bags, sets, accountSet, calls, copies };
  }

  it('two characters of one account joining at once add the grant exactly once', async () => {
    const w = twoOnline();
    await Promise.all([
      w.carry.join(w.clients.get(1)! as never),
      w.carry.join(w.clients.get(2)! as never),
    ]);
    expect(w.copies()).toBe(1);
    expect(w.accountSet.size).toBe(1);
  });

  it('the account lock alone (no database guard) keeps it to one copy', async () => {
    const w = twoOnline({ noDbGuard: true });
    await Promise.all([
      w.carry.join(w.clients.get(1)! as never),
      w.carry.join(w.clients.get(2)! as never),
    ]);
    expect(w.copies()).toBe(1);
  });

  it('a save the database refuses (claim conflict) is undone in memory and nothing is acked', async () => {
    const w = twoOnline({ conflictOn: 70 });
    await w.carry.join(w.clients.get(1)! as never);
    expect(w.bags.get(1)).toHaveLength(0); // the add was undone with the rolled-back save
    expect(w.sets.get(1)?.size).toBe(0);
    expect(w.calls).not.toContain('/mod/ack');
  });
});
