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
const clone = <T>(v: T): T => structuredClone(v);
const flush = () => new Promise((r) => setTimeout(r, 20));

/**
 * One player, a live bag, the bag as last SAVED (what a crash reloads), and a sidecar with the
 * escrow's view of each grant. `copies(g)` counts a grant across the bag and the escrow: the design
 * promises it is always exactly one.
 */
function world() {
  let inventory: InvSlot[] = [];
  let saved: InvSlot[] = [];
  const escrow = new Map<string, { grant: Grant; label: string; state: string; acked: boolean }>();
  const calls: string[] = [];
  const frames: unknown[] = [];
  const faults: Record<string, 'refuse' | 'crash-after' | 'disconnect'> = {};
  const clients = new Map<number, Session>();
  let session: Session = { accountId: 7, characterId: 70, pid: 1, selfHeavyDirty: false };
  clients.set(1, session);
  const offline: { characterId: number; slot: InvSlot }[] = [];
  const answer = (path: string, b: any): { status: number; body: unknown } => {
    if (path === '/mod/join')
      return {
        status: 200,
        body: {
          holder: 'h',
          add: [...escrow.values()]
            .filter((e) => e.state === 'held' && !e.acked)
            .map((e) => ({ grant: e.grant, label: e.label })),
        },
      };
    if (path === '/mod/ack') {
      for (const g of b.grants) escrow.get(g)!.acked = true;
      return { status: 200, body: { ok: true } };
    }
    if (path === '/mod/mint') {
      const g = grant(G1, b.template.type);
      escrow.set(G1, { grant: g, label: b.template.label, state: 'held', acked: false });
      return { status: 200, body: { grant: g } };
    }
    if (path === '/mod/carry-out') {
      if (faults[path] === 'refuse' || faults[path] === 'disconnect')
        return { status: 409, body: { error: 'link-not-honoured' } };
      for (const g of b.grants) escrow.get(g)!.state = 'in-transit';
      return { status: 200, body: { url: `${b.destination}/arrive#ps-ticket=x` } };
    }
    return { status: 404, body: {} };
  };
  const deps = {
    sim: {
      meta: () => ({ inventory, cls: 'warrior' }) as never,
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
      return true;
    },
    restoreOffline: async (characterId: number, slot: InvSlot) => {
      offline.push({ characterId, slot });
      saved.push(clone(slot));
    },
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(path);
      const a = answer(path, JSON.parse(String(init.body)));
      if (faults[path] === 'disconnect') clients.delete(1);
      // The sidecar committed, then the game server died before it read the answer: nothing after
      // this point ever runs.
      if (faults[path] === 'crash-after') return new Promise<Response>(() => {});
      return new Response(JSON.stringify(a.body), { status: a.status });
    }) as typeof fetch,
  };
  const make = () => new PlaceSchemaCarry<Session>(cfg, deps as never);
  return {
    carry: make(),
    calls,
    frames,
    faults,
    offline,
    escrow,
    get inventory() {
      return inventory;
    },
    get saved() {
      return saved;
    },
    session: () => session,
    /** the process dies: memory is gone, the bag reloads from the last save */
    crash() {
      inventory = clone(saved);
      for (const k of Object.keys(faults)) delete faults[k];
      session = { ...session };
      clients.set(1, session);
      return make();
    },
    copies(g: string, bag: InvSlot[] = inventory) {
      const inBag = bag.filter(
        (x) => (x.instance as Record<string, unknown> | undefined)?.[GRANT_KEY] === g,
      ).length;
      const e = escrow.get(g);
      const away = e && (e.state === 'in-transit' || e.state === 'landed') ? 1 : 0;
      const due = e && e.state === 'held' && !e.acked && inBag === 0 ? 1 : 0; // next join adds it
      return inBag + away + due;
    },
    arrive(g = G1, label = 'Ember Blade') {
      escrow.set(g, { grant: grant(g), label, state: 'held', acked: false });
    },
  };
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
    expect(realmHost({ PUBLIC_ORIGIN: 'https://worldofclaudecraft.com' })).toBe(
      'worldofclaudecraft.com',
    );
  });

  it('maps our own mint back to its item, a foreign blade to the stand-in, and nothing else', () => {
    expect(itemIdForGrant(grant(G1, 'misc.woc.wolf_fang'))).toBe('wolf_fang');
    expect(itemIdForGrant(grant(G1, 'armor.woc.not_an_item'))).toBeUndefined();
    expect(itemIdForGrant(grant(G1))).toBe(FOREIGN_WEAPON_ID);
    expect(itemIdForGrant(grant(G1, 'potion.heal'))).toBeUndefined();
  });

  it('adds an arrival once by grant id, names it by its label, saves, then acks', async () => {
    const w = world();
    w.arrive();
    await w.carry.join(w.session());
    await w.carry.join(w.session());
    expect(w.inventory).toHaveLength(1);
    expect(w.inventory[0].instance).toMatchObject({ [GRANT_KEY]: G1, name: 'Ember Blade' });
    expect(w.calls.indexOf('save')).toBeLessThan(w.calls.indexOf('/mod/ack'));
  });

  it('finding 2: a crash after the arrival but before the ack keeps exactly one copy', async () => {
    const w = world();
    w.arrive();
    w.faults['/mod/ack'] = 'crash-after';
    void w.carry.join(w.session());
    await flush();
    const again = w.crash(); // the bag reloads from the save made before the ack
    expect(slotOfGrant(w.inventory, G1)).toBe(0);
    expect(w.copies(G1)).toBe(1);
    await again.join(w.session()); // the sidecar re-delivers; the grant id dedupes it
    expect(w.inventory).toHaveLength(1);
    expect(w.copies(G1)).toBe(1);
  });

  it('finding 1: the removal is saved before carry-out, so a crash after it cannot duplicate', async () => {
    const w = world();
    w.arrive();
    await w.carry.join(w.session());
    w.faults['/mod/carry-out'] = 'crash-after';
    void w.carry.carry(w.session(), G1);
    await flush();
    expect(w.calls.lastIndexOf('save')).toBeLessThan(w.calls.lastIndexOf('/mod/carry-out'));
    w.crash();
    expect(slotOfGrant(w.inventory, G1)).toBe(-1);
    expect(w.escrow.get(G1)?.state).toBe('in-transit');
    expect(w.copies(G1)).toBe(1);
  });

  it('walks the player to the ticket after a successful carry', async () => {
    const w = world();
    w.arrive();
    await w.carry.join(w.session());
    await w.carry.carry(w.session(), G1);
    expect(w.frames.at(-1)).toEqual({
      t: 'placeschema',
      kind: 'ticket',
      url: 'http://hub.test/arrive#ps-ticket=x',
    });
    expect(w.copies(G1)).toBe(1);
  });

  it('a refused carry puts the copy back and saves it', async () => {
    const w = world();
    w.arrive();
    await w.carry.join(w.session());
    w.faults['/mod/carry-out'] = 'refuse';
    await w.carry.carry(w.session(), G1);
    expect(slotOfGrant(w.saved, G1)).toBe(0);
    expect(w.frames.at(-1)).toBe('The item could not be carried (link-not-honoured).');
    expect(w.copies(G1)).toBe(1);
  });

  it('finding 3: a player who logs off during a refused carry gets the copy back in the saved row', async () => {
    const w = world();
    w.arrive();
    await w.carry.join(w.session());
    w.faults['/mod/carry-out'] = 'disconnect';
    await w.carry.carry(w.session(), G1);
    expect(w.offline).toHaveLength(1);
    expect(w.offline[0].characterId).toBe(70);
    expect(w.copies(G1, w.saved)).toBe(1); // the next login loads exactly one copy
  });

  it('offers the link page instead when the account is not linked', async () => {
    const w = world();
    await w.carry.carry(w.session(), G1); // never joined: not known to be linked
    expect(w.calls).toContain('/mod/link');
  });

  it('finding 4: a quest reward stays one copy when the mint answer is lost to a crash', async () => {
    const w = world();
    await w.carry.join(w.session()); // learns the player is linked
    w.inventory.push({ itemId: 'greyjaw_pelt_cloak', count: 1 }); // the plain reward the turn-in gave
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
