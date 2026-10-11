// PLACE-412: other players see an arriving player's Minecraft skin. The server keeps each live
// player's skin and sends it to everyone else, with that player's entity id; the client keeps them
// apart from its own; every player in view gets a live texture.

import { describe, expect, it } from 'vitest';
import { type CarrySession, PlaceSchemaCarry } from '../../server/placeschema_sidecar';
import { applyPlaceSchemaFrame } from '../../src/net/placeschema_frame';
import {
  carriedSkin,
  carriedSkinFor,
  setCarriedSkin,
  setPeerSkin,
} from '../../src/placeschema_skin_state';

type Session = CarrySession & { ws?: object };

const cfg = {
  url: 'http://sidecar.test',
  token: 't'.repeat(32),
  realmHost: 'woc.test',
  home: '',
};
const SKIN_A = 'data:image/png;base64,QUFB';
const flush = () => new Promise((r) => setTimeout(r, 20));

function realm() {
  const clients = new Map<number, Session>();
  const sessions = new Map<number, Session>();
  const got = new Map<number, unknown[]>(); // frames each player's client received
  const deps = {
    sim: {
      meta: () => ({ inventory: [], placeschemaAccepted: new Set() }),
      addItemInstance: () => {},
    },
    clients,
    send: (s: Session, f: { kind: string }) => {
      if (f.kind === 'skin' || f.kind === 'skins') got.get(s.pid)?.push(f);
    },
    notice: () => {},
    save: async () => true,
    store: {
      claims: async () => new Map(),
      claim: async () => 'claimed',
      cancels: async () => [],
      putCancels: async () => {},
      dropCancel: async () => {},
    },
    // A (account 1) carried a Minecraft skin; B and C did not
    skin: async (holder: string) => (holder === 'h1' ? { url: SKIN_A, model: 'slim' } : undefined),
    fetch: (async (_url: string, init: RequestInit) => {
      const { platformId } = JSON.parse(String(init.body));
      const account = String(platformId).split('@')[0];
      return Response.json({ holder: `h${account}`, add: [] });
    }) as typeof fetch,
  };
  const carry = new PlaceSchemaCarry<Session>(cfg, deps as never);
  return {
    got,
    async enter(pid: number) {
      const s: Session = {
        accountId: pid,
        characterId: pid * 10,
        pid,
        selfHeavyDirty: false,
        ws: {},
      };
      clients.set(pid, s);
      sessions.set(pid, s);
      got.set(pid, []);
      await carry.join(s);
      await flush();
    },
    /** the join poll again (every 5 s) */
    async poll(pid: number) {
      await carry.join(sessions.get(pid)!);
      await flush();
    },
    /** the same session on a new socket (GameServer.resumeSession) */
    async resume(pid: number) {
      const s = sessions.get(pid)!;
      s.ws = {};
      got.set(pid, []);
      await carry.join(s);
      await flush();
    },
    leave(pid: number) {
      clients.delete(pid);
    },
  };
}

describe('the carried skin, seen by every player (PLACE-412)', () => {
  it('A1: both players get A’s skin, a late joiner too, and nobody new after A leaves', async () => {
    const r = realm();
    await r.enter(2); // B is already here
    await r.enter(1); // A arrives with a skin
    expect(r.got.get(1)).toEqual([
      { t: 'placeschema', kind: 'skins' },
      { t: 'placeschema', kind: 'skin', url: SKIN_A, model: 'slim' },
    ]);
    expect(r.got.get(2)).toEqual([
      { t: 'placeschema', kind: 'skins' },
      { t: 'placeschema', kind: 'skin', url: SKIN_A, model: 'slim', pid: 1 },
    ]);
    await r.enter(3); // C joins later
    expect(r.got.get(3)).toEqual([
      { t: 'placeschema', kind: 'skins' },
      { t: 'placeschema', kind: 'skin', url: SKIN_A, model: 'slim', pid: 1 },
    ]);
    await r.poll(3); // later polls send nothing again
    expect(r.got.get(3)).toHaveLength(2);
    r.leave(1);
    await r.enter(4); // D joins after A left
    expect(r.got.get(4)).toEqual([{ t: 'placeschema', kind: 'skins' }]);
  });

  it('PLACE-1049: a slower read for an earlier holder never lands over the newest', async () => {
    let holder = 'old';
    const reads = new Map<string, (v: { url: string; model: 'classic' }) => void>();
    const frames: unknown[] = [];
    const s: Session = { accountId: 1, characterId: 10, pid: 1, selfHeavyDirty: false, ws: {} };
    const carry = new PlaceSchemaCarry<Session>(cfg, {
      sim: {
        meta: () => ({ inventory: [], placeschemaAccepted: new Set() }),
        addItemInstance: () => {},
      },
      clients: new Map([[1, s]]),
      send: (_s: Session, f: { kind: string }) => f.kind === 'skin' && frames.push(f),
      notice: () => {},
      save: async () => true,
      store: {
        claims: async () => new Map(),
        claim: async () => 'claimed',
        cancels: async () => [],
        putCancels: async () => {},
        dropCancel: async () => {},
      },
      skin: (h: string) => new Promise((res) => reads.set(h, res)),
      fetch: (async () => Response.json({ holder, add: [] })) as unknown as typeof fetch,
    } as never);
    await carry.join(s);
    await flush();
    holder = 'new'; // relinked before the first read came back
    await carry.join(s);
    await flush();
    reads.get('new')!({ url: 'data:image/png;base64,TkVX', model: 'classic' });
    await flush();
    reads.get('old')!({ url: 'data:image/png;base64,T0xE', model: 'classic' });
    await flush();
    expect(frames).toEqual([
      { t: 'placeschema', kind: 'skin', url: 'data:image/png;base64,TkVX', model: 'classic' },
    ]);
  });

  it("A2: another player's skin never touches the local player's own", () => {
    setCarriedSkin(null);
    expect(applyPlaceSchemaFrame({ kind: 'skin', url: SKIN_A, model: 'slim', pid: 41 })).toBe(
      'skin',
    );
    expect(carriedSkin()).toBeNull();
    expect(carriedSkinFor(41)).toEqual({ url: SKIN_A, model: 'slim' });
    // a frame naming our own pid is ours, as is one with no pid
    applyPlaceSchemaFrame({ kind: 'skin', url: SKIN_A, pid: 7 }, undefined, 7);
    expect(carriedSkin()).toEqual({ url: SKIN_A, model: 'classic' });
    setCarriedSkin(null);
    // a malformed pid is refused as a peer and falls back to the local path only for a valid frame
    expect(applyPlaceSchemaFrame({ kind: 'skin', url: 'javascript:x', pid: 42 })).toBeNull();
    expect(carriedSkinFor(42)).toBeNull();
  });

  it('a resumed session (new socket) is reset and gets the skins again', async () => {
    const r = realm();
    await r.enter(1);
    await r.enter(2);
    await r.resume(2);
    expect(r.got.get(2)).toEqual([
      { t: 'placeschema', kind: 'skins' },
      { t: 'placeschema', kind: 'skin', url: SKIN_A, model: 'slim', pid: 1 },
    ]);
  });

  it('the reset frame forgets every peer (a restarted server reuses entity ids)', () => {
    for (let pid = 1000; pid < 1100; pid++) setPeerSkin(pid, { url: SKIN_A, model: 'classic' });
    expect(carriedSkinFor(1000)).not.toBeNull(); // no eviction: a visible player keeps their skin
    expect(applyPlaceSchemaFrame({ kind: 'skins' })).toBe('skins');
    expect(carriedSkinFor(1000)).toBeNull();
    expect(carriedSkinFor(1099)).toBeNull();
  });
});
