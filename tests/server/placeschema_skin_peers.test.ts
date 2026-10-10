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

const cfg = {
  url: 'http://sidecar.test',
  token: 't'.repeat(32),
  realmHost: 'woc.test',
  home: '',
};
const SKIN_A = 'data:image/png;base64,QUFB';
const flush = () => new Promise((r) => setTimeout(r, 20));

function realm() {
  const clients = new Map<number, CarrySession>();
  const got = new Map<number, unknown[]>(); // frames each player's client received
  const deps = {
    sim: { meta: () => ({ inventory: [], placeschemaAccepted: new Set() }), addItemInstance: () => {} },
    clients,
    send: (s: CarrySession, f: { kind: string }) => {
      if (f.kind === 'skin') got.get(s.pid)?.push(f);
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
  const carry = new PlaceSchemaCarry<CarrySession>(cfg, deps as never);
  return {
    got,
    async enter(pid: number) {
      const s = { accountId: pid, characterId: pid * 10, pid, selfHeavyDirty: false };
      clients.set(pid, s);
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
    expect(r.got.get(1)).toEqual([{ t: 'placeschema', kind: 'skin', url: SKIN_A, model: 'slim' }]);
    expect(r.got.get(2)).toEqual([
      { t: 'placeschema', kind: 'skin', url: SKIN_A, model: 'slim', pid: 1 },
    ]);
    await r.enter(3); // C joins later
    expect(r.got.get(3)).toEqual([
      { t: 'placeschema', kind: 'skin', url: SKIN_A, model: 'slim', pid: 1 },
    ]);
    r.leave(1);
    await r.enter(4); // D joins after A left
    expect(r.got.get(4)).toEqual([]);
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

  it('keeps at most 64 peers, oldest out', () => {
    for (let pid = 1000; pid < 1065; pid++) setPeerSkin(pid, { url: SKIN_A, model: 'classic' });
    expect(carriedSkinFor(1000)).toBeNull();
    expect(carriedSkinFor(1064)).not.toBeNull();
  });
});
