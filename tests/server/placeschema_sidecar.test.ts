import { describe, expect, it } from 'vitest';
import {
  FOREIGN_WEAPON_ID,
  GRANT_KEY,
  itemIdForGrant,
  PlaceSchemaCarry,
  platformId,
  slotOfGrant,
} from '../../server/placeschema_sidecar';
import type { InvSlot, ItemInstancePayload } from '../../src/sim/types';

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

function harness(answers: Record<string, (body: any) => { status?: number; body: unknown }>) {
  const inventory: InvSlot[] = [];
  const calls: { path: string; body: any }[] = [];
  const frames: unknown[] = [];
  const session = { accountId: 7, pid: 1, selfHeavyDirty: false };
  const carry = new PlaceSchemaCarry(cfg, {
    sim: {
      meta: () => ({ inventory, cls: 'warrior' }) as never,
      addItemInstance: (itemId: string, instance: ItemInstancePayload) => {
        inventory.push({ itemId, count: 1, instance });
      },
    },
    clients: new Map([[1, session]]),
    send: (_s, f) => frames.push(f),
    notice: (_s, text) => frames.push(text),
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init.body));
      calls.push({ path, body });
      const a = answers[path]?.(body) ?? { body: {} };
      return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
    }) as typeof fetch,
  });
  return { carry, inventory, calls, frames, session };
}

describe('placeschema sidecar game side (PLACE-276)', () => {
  it('names the player by account id at the realm host, never the username', () => {
    expect(platformId(cfg, 7)).toBe('7@woc.test');
  });

  it('maps our own mint back to its item and anything else to the carried item', () => {
    expect(itemIdForGrant(grant(G1, 'misc.woc.wolf_fang'))).toBe('wolf_fang');
    expect(itemIdForGrant(grant(G1, 'armor.woc.not_an_item'))).toBeUndefined();
    expect(itemIdForGrant(grant(G1, 'potion.heal'))).toBeUndefined();
    expect(itemIdForGrant(grant(G1))).toBe(FOREIGN_WEAPON_ID);
  });

  it('adds an arrival once, by grant id, names it by its label, and acks it', async () => {
    const h = harness({
      '/mod/join': () => ({
        body: { holder: 'h', add: [{ grant: grant(G1), label: 'Ember Blade' }] },
      }),
    });
    await h.carry.join(h.session);
    await h.carry.join(h.session);
    expect(h.inventory).toHaveLength(1);
    expect(h.inventory[0].instance).toMatchObject({ [GRANT_KEY]: G1, name: 'Ember Blade' });
    expect(h.calls.filter((c) => c.path === '/mod/ack')).toHaveLength(2);
    expect(h.calls[0].body.platformId).toBe('7@woc.test');
  });

  it('removes the copy before carry-out and walks the player to the ticket', async () => {
    const h = harness({
      '/mod/join': () => ({
        body: { holder: 'h', add: [{ grant: grant(G1), label: 'Ember Blade' }] },
      }),
      '/mod/carry-out': (b) => ({ body: { url: `${b.destination}/arrive#ps-ticket=x` } }),
    });
    await h.carry.join(h.session);
    await h.carry.carry(h.session, G1);
    expect(slotOfGrant(h.inventory, G1)).toBe(-1);
    expect(h.calls.find((c) => c.path === '/mod/carry-out')?.body).toMatchObject({
      grants: [G1],
      destination: 'http://hub.test',
    });
    expect(h.frames.slice(-1)).toEqual([
      { t: 'placeschema', kind: 'ticket', url: 'http://hub.test/arrive#ps-ticket=x' },
    ]);
  });

  it('puts the copy back when the sidecar refuses the carry', async () => {
    const h = harness({
      '/mod/join': () => ({
        body: { holder: 'h', add: [{ grant: grant(G1), label: 'Ember Blade' }] },
      }),
      '/mod/carry-out': () => ({ status: 409, body: { error: 'link-not-honoured' } }),
    });
    await h.carry.join(h.session);
    await h.carry.carry(h.session, G1);
    expect(slotOfGrant(h.inventory, G1)).toBe(0);
    expect(h.frames.at(-1)).toBe('The item could not be carried (link-not-honoured).');
  });

  it('offers the link page instead when the account is not linked', async () => {
    const h = harness({
      '/mod/join': () => ({ body: { holder: null, add: [] } }),
      '/mod/link': () => ({ body: { url: 'http://sidecar.test/link#s=1' } }),
    });
    await h.carry.join(h.session);
    await h.carry.carry(h.session, G1);
    expect(h.frames).toEqual([
      { t: 'placeschema', kind: 'link', url: 'http://sidecar.test/link#s=1' },
    ]);
  });

  it('turns a quest reward into a signed grant and keeps exactly one copy', async () => {
    let minted = false;
    const h = harness({
      '/mod/join': () => ({
        body: {
          holder: 'h',
          add: minted
            ? [{ grant: grant(G1, 'armor.woc.greyjaw_pelt_cloak'), label: 'Greyjaw Pelt Cloak' }]
            : [],
        },
      }),
      '/mod/mint': (b) => {
        minted = true;
        expect(b.template.type).toBe('armor.woc.greyjaw_pelt_cloak');
        return { body: { grant: grant(G1, 'armor.woc.greyjaw_pelt_cloak') } };
      },
    });
    await h.carry.join(h.session);
    h.inventory.push({ itemId: 'greyjaw_pelt_cloak', count: 1 }); // the plain reward the turn-in gave
    await h.carry.questDone(h.session, 'q_greyjaw');
    expect(h.inventory).toHaveLength(1);
    expect(h.inventory[0]).toMatchObject({
      itemId: 'greyjaw_pelt_cloak',
      instance: { [GRANT_KEY]: G1 },
    });
  });
});
