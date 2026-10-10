// PLACE-410 (open-place spec 2026-10-02-woc-leg.md section 7, WoC unit tests): a signed copy is
// never sold, disenchanted or salvaged; two quest mints of one item are two grants and two bag
// copies; a carried weapon's `as-is` look puts its own mesh on the copy, `generic` keeps the
// stand-in; a class that can't use the stand-in keeps the carried weapon in the bag.

import { describe, expect, it } from 'vitest';
import {
  FOREIGN_WEAPON_ID,
  GRANT_KEY,
  MESH_KEY,
  PlaceSchemaCarry,
} from '../../server/placeschema_sidecar';
import { CLASSES } from '../../src/sim/content/classes';
import { ITEMS, QUESTS, questRewardItemId } from '../../src/sim/data';
import { canEquipItem } from '../../src/sim/equipment_rules';
import { isItemLocked, isSignedCopy } from '../../src/sim/item_lock_flag';
import * as items from '../../src/sim/items';
import { Sim } from '../../src/sim/sim';
import type { SimContext } from '../../src/sim/sim_context';
import type { Entity, InvSlot, PlayerClass, SimEvent } from '../../src/sim/types';
import { bagItemNewActions } from '../../src/ui/bag_item_context_menu';
import { completeEnchantFamilyCast } from '../helpers/enchant_family_cast';

const G = (n: number) => n.toString(16).padStart(64, '0');
const signed = (n: number) => ({ [GRANT_KEY]: G(n), name: 'Diamond Sword' }) as never;

function vendorPlayer() {
  const sim = new Sim({ seed: 11, playerClass: 'warrior', autoEquip: false });
  const pid = sim.addPlayer('warrior', 'Carrier');
  const anySim = sim as unknown as { entities: Map<number, Entity>; rebucket(e: Entity): void };
  const wilkes = [...anySim.entities.values()].find(
    (e) => (e as unknown as { templateId?: string }).templateId === 'trader_wilkes',
  ) as Entity;
  const p = anySim.entities.get(pid) as Entity;
  p.pos.x = wilkes.pos.x + 2;
  p.pos.z = wilkes.pos.z;
  anySim.rebucket(p);
  const meta = sim.players.get(pid)!;
  meta.inventory.length = 0;
  return { sim, pid, meta, ctx: (sim as unknown as { ctx: SimContext }).ctx };
}

const errors = (events: SimEvent[]) => events.flatMap((e) => (e.type === 'error' ? [e.text] : []));

describe('a signed copy cannot be sold, disenchanted or salvaged', () => {
  const WEAPON = 'eastbrook_arming_sword';

  it('is locked for good, with no lock toggle offered', () => {
    expect(isSignedCopy({ [GRANT_KEY]: G(1) } as never)).toBe(true);
    expect(isSignedCopy({ psPending: WEAPON } as never)).toBe(true);
    expect(isItemLocked({ [GRANT_KEY]: G(1) } as never)).toBe(true);
    expect(isSignedCopy(undefined)).toBe(false);
    const actions = bagItemNewActions(ITEMS[WEAPON], WEAPON, signed(1));
    expect(actions).toContain('carry');
    expect(actions).not.toContain('unlock');
    expect(actions).not.toContain('lock');
    expect(actions).not.toContain('salvage');
  });

  it('vendor sale is refused with a notice and the copy stays', () => {
    const { sim, pid, meta, ctx } = vendorPlayer();
    meta.inventory.push({ itemId: WEAPON, count: 1, instance: signed(1) });
    sim.drainEvents();
    items.sellItem(ctx, WEAPON, 1, pid, 0);
    expect(errors(sim.drainEvents())).toContain('That item is locked and cannot be sold.');
    items.sellItem(ctx, WEAPON, 1, pid); // the bulk arm too
    expect(errors(sim.drainEvents())).toContain('That item is locked and cannot be sold.');
    expect(meta.inventory).toEqual([{ itemId: WEAPON, count: 1, instance: signed(1) }]);
  });

  it('disenchant is refused (named copy and unnamed), and spares it beside a plain copy', () => {
    const { sim, pid, meta } = vendorPlayer();
    meta.inventory.push({ itemId: WEAPON, count: 1, instance: signed(1) });
    sim.drainEvents();
    for (const slot of [0, undefined]) {
      sim.disenchantItem(WEAPON, pid, slot);
      completeEnchantFamilyCast(sim, pid);
      const r = sim.drainEvents().find((e) => e.type === 'disenchantResult') as
        | { ok: boolean; reason?: string }
        | undefined;
      expect(r).toMatchObject({ ok: false, reason: 'not_disenchantable' });
    }
    expect(meta.inventory).toEqual([{ itemId: WEAPON, count: 1, instance: signed(1) }]);
    // With a plain copy beside it, the unnamed disenchant takes the plain one.
    meta.inventory.unshift({ itemId: WEAPON, count: 1 });
    sim.disenchantItem(WEAPON, pid);
    completeEnchantFamilyCast(sim, pid);
    expect(meta.inventory.filter((s) => s.itemId === WEAPON)).toEqual([
      { itemId: WEAPON, count: 1, instance: signed(1) },
    ]);
  });

  it('salvage is refused and the copy stays', () => {
    const { sim, pid, meta } = vendorPlayer();
    meta.inventory.push({ itemId: WEAPON, count: 1, instance: signed(1) });
    sim.drainEvents();
    sim.salvageItem(WEAPON, pid, 0);
    completeEnchantFamilyCast(sim, pid);
    const r = sim.drainEvents().find((e) => e.type === 'salvageResult') as
      | { ok: boolean; reason?: string }
      | undefined;
    expect(r).toMatchObject({ ok: false, reason: 'locked' });
    expect(meta.inventory).toEqual([{ itemId: WEAPON, count: 1, instance: signed(1) }]);
  });
});

// ---- the carry against a small model of the sidecar's /mod HTTP contract ----

type Sent = { path: string; body: any };
function carryWorld(cls: PlayerClass, opts: { look?: unknown; bag?: boolean } = {}) {
  const inventory: InvSlot[] = [];
  const equipment: Record<string, InvSlot | undefined> = {};
  const accepted = new Set<string>();
  const queue: {
    grant: { id: string; tags: string[][]; content: string };
    label: string;
    look?: unknown;
    equipped?: string;
  }[] = [];
  const sent: Sent[] = [];
  let n = 0;
  const reply = (path: string, body: any) => {
    sent.push({ path, body });
    if (path === '/mod/join') return { holder: 'f'.repeat(64), add: queue.slice() };
    if (path === '/mod/ack') {
      for (const g of body.grants)
        queue.splice(
          queue.findIndex((q) => q.grant.id === g),
          1,
        );
      return { ok: true };
    }
    if (path === '/mod/carry-out') return { url: `${body.destination}/arrive#ps-ticket=x` };
    if (path === '/mod/mint') {
      // PLACE-386: every mint is distinct (the sidecar stamps a serial), so every mint is a new id
      const grant = { id: G(++n), tags: [], content: JSON.stringify(body.template) };
      queue.push({ grant, label: body.template.label });
      return { grant };
    }
    return {};
  };
  const claims = new Map<string, number>();
  const session = { accountId: 7, characterId: 70, pid: 1, selfHeavyDirty: false };
  const frames: unknown[] = [];
  const carry = new PlaceSchemaCarry(
    { url: 'http://sidecar.test', token: 't', realmHost: 'woc.test', home: 'http://hub.test' },
    {
      sim: {
        meta: () =>
          ({
            inventory,
            placeschemaAccepted: accepted,
            cls,
            equipmentInstance: Object.fromEntries(
              Object.entries(equipment).flatMap(([k, v]) => (v ? [[k, v.instance]] : [])),
            ),
          }) as never,
        unequipItem: (slot: string) => {
          const worn = equipment[slot];
          if (!worn) return false;
          equipment[slot] = undefined;
          inventory.push(worn);
          return true;
        },
        addItemInstance: (itemId: string, instance: never) => {
          inventory.push({ itemId, count: 1, instance });
        },
        equipItem: (itemId: string, _pid?: unknown, slot?: unknown, at?: number) => {
          const [moved] = inventory.splice(at!, 1);
          expect(moved.itemId).toBe(itemId);
          const was = equipment[String(slot)];
          if (was) inventory.push(was); // the worn piece goes back to the bag, as the sim does
          equipment[String(slot)] = moved;
        },
      },
      clients: new Map([[1, session]]),
      send: (_s, f) => frames.push(f),
      notice: () => undefined,
      save: async () => true,
      skin: async () => ({ url: 'data:image/png;base64,AAAA', model: 'classic' }),
      store: {
        claims: async () => claims,
        claim: async (_a, g) => {
          if (claims.has(g)) return 'held';
          claims.set(g, claims.size + 1);
          return 'claimed';
        },
        cancels: async () => [],
        putCancels: async () => undefined,
        dropCancel: async () => undefined,
      },
      fetch: (async (url: string, init: { body: string }) => {
        const body = reply(new URL(url).pathname, JSON.parse(init.body));
        return new Response(JSON.stringify(body), { status: 200 });
      }) as never,
    },
  );
  const arrive = (look: unknown) =>
    queue.push({
      grant: {
        id: G(900),
        tags: [],
        content: JSON.stringify({ type: 'blade.minecraft.diamond_sword' }),
      },
      label: 'Diamond Sword',
      look,
      // PLACE-413: held in the hand where it came from, unless the test carries it in a bag
      ...(opts.bag ? {} : { equipped: 'grip' }),
    });
  if (opts.look) arrive(opts.look);
  return { carry, session, inventory, equipment, sent, frames, arrive };
}

/** An existing early-zone quest whose reward is a weapon (Decision 1). */
function weaponQuest(cls: PlayerClass): { id: string; itemId: string } {
  for (const [id, q] of Object.entries(QUESTS)) {
    const itemId = questRewardItemId(q, cls);
    if (itemId && ITEMS[itemId]?.kind === 'weapon') return { id, itemId };
  }
  throw new Error('no weapon quest');
}

describe('earning: a quest turn-in mints through /mod/mint', () => {
  it('two turn-ins of one item are two grants and two bag copies', async () => {
    const w = carryWorld('warrior');
    const { id, itemId } = weaponQuest('warrior');
    await w.carry.join(w.session); // learns the account is linked
    for (let i = 0; i < 2; i++) {
      w.inventory.push({ itemId, count: 1 }); // the quest's own plain reward copy
      await w.carry.questDone(w.session, id);
    }
    const mints = w.sent.filter((s) => s.path === '/mod/mint');
    expect(mints).toHaveLength(2);
    for (const m of mints) {
      expect(m.body.distinct).toBeUndefined(); // the default: distinct (PLACE-386)
      expect(m.body.template.type).toBe(`weapon.woc.${itemId}`);
      // render-asset is the sidecar's to stamp from SIDECAR_LOOKS, never the game's (Decision 3)
      expect(m.body.template.features.some((f: string) => f.startsWith('render-asset:'))).toBe(
        false,
      );
    }
    // PLACE-955: each earned copy is held at once; the one it replaces goes back to the bag
    expect(w.equipment.mainhand?.instance).toMatchObject({ [GRANT_KEY]: G(2) });
    const copies = [...w.inventory, w.equipment.mainhand!].filter((s) => s.itemId === itemId);
    expect(copies).toHaveLength(2);
    expect(new Set(copies.map((s) => (s.instance as any)?.[GRANT_KEY])).size).toBe(2);
  });
});

describe('the blade earned to carry is held at once (PLACE-955)', () => {
  it('A Blade That Travels: the warrior turns it in and holds the Redbrook Militia Blade', async () => {
    const w = carryWorld('warrior');
    await w.carry.join(w.session);
    w.inventory.push({ itemId: 'redbrook_blade', count: 1 }); // Rook's reward, plain
    await w.carry.questDone(w.session, 'q_ps_a_blade_that_travels');
    expect(w.equipment.mainhand).toMatchObject({ itemId: 'redbrook_blade' });
    expect((w.equipment.mainhand?.instance as any)?.[GRANT_KEY]).toBeTruthy();
    expect(w.inventory.some((s) => s.itemId === 'redbrook_blade')).toBe(false);
  });

  it('a class that cannot use the reward keeps it in the bag', async () => {
    const w = carryWorld('mage');
    const { id, itemId } = weaponQuest('warrior'); // a warrior's sword
    await w.carry.join(w.session);
    w.inventory.push({ itemId, count: 1 });
    await w.carry.questDone(w.session, id);
    expect(w.equipment.mainhand).toBeUndefined();
  });
});

describe('arriving: a carried sword by name and mesh', () => {
  const asIs = {
    rung: 'as-is',
    mesh: { name: `ps_${'b'.repeat(32)}.glb`, sha256: 'b'.repeat(64) },
  };

  it('`as-is` puts its own mesh on the copy and the class that can use it holds it', async () => {
    const w = carryWorld('warrior', { look: asIs });
    await w.carry.join(w.session);
    const held = w.equipment.mainhand;
    expect(held?.itemId).toBe(FOREIGN_WEAPON_ID);
    expect(held?.instance).toMatchObject({
      [GRANT_KEY]: G(900),
      name: 'Diamond Sword',
      [MESH_KEY]: asIs.mesh.name,
    });
    expect(w.sent.find((s) => s.path === '/mod/join')?.body.caps.mesh).toBe(true);
  });

  it('`generic` keeps the stand-in model (no mesh), name intact', async () => {
    const w = carryWorld('warrior', { look: { rung: 'generic', reason: 'client-no-mesh' } });
    await w.carry.join(w.session);
    const inst = w.equipment.mainhand?.instance as Record<string, unknown>;
    expect(inst.name).toBe('Diamond Sword');
    expect(inst[MESH_KEY]).toBeUndefined();
  });

  it('a class that cannot use swords keeps it in the bag, name and mesh kept', async () => {
    // WoC's own rule decides (Decision 2). Today the stand-in has no class list, so every class
    // can hold it; give it a warrior-only list for this case, as a class-restricted sword would.
    const def = ITEMS[FOREIGN_WEAPON_ID] as { requiredClass?: PlayerClass[] };
    expect(
      (Object.keys(CLASSES) as PlayerClass[]).every((c) =>
        canEquipItem(c, ITEMS[FOREIGN_WEAPON_ID]),
      ),
    ).toBe(true);
    def.requiredClass = ['warrior'];
    const w = carryWorld('mage', { look: asIs });
    try {
      expect(canEquipItem('mage', ITEMS[FOREIGN_WEAPON_ID])).toBe(false);
      await w.carry.join(w.session);
    } finally {
      delete def.requiredClass;
    }
    expect(w.equipment.mainhand).toBeUndefined();
    expect(w.inventory).toEqual([
      {
        itemId: FOREIGN_WEAPON_ID,
        count: 1,
        instance: { [GRANT_KEY]: G(900), name: 'Diamond Sword', [MESH_KEY]: asIs.mesh.name },
      },
    ]);
  });

  it('a sword carried in a bag (no equipped hint) arrives in the bag (PLACE-413)', async () => {
    const w = carryWorld('warrior', { look: asIs, bag: true });
    await w.carry.join(w.session);
    expect(w.equipment.mainhand).toBeUndefined();
    expect(w.inventory).toEqual([
      {
        itemId: FOREIGN_WEAPON_ID,
        count: 1,
        instance: { [GRANT_KEY]: G(900), name: 'Diamond Sword', [MESH_KEY]: asIs.mesh.name },
      },
    ]);
  });

  it('a mesh name outside the sidecar media pattern is never put on the copy', async () => {
    const w = carryWorld('warrior', { look: { rung: 'as-is', mesh: { name: '../../admin' } } });
    await w.carry.join(w.session);
    expect(
      (w.equipment.mainhand?.instance as Record<string, unknown> | undefined)?.[MESH_KEY],
    ).toBeUndefined();
    expect(w.equipment.mainhand?.itemId).toBe(FOREIGN_WEAPON_ID);
  });

  it('the holder skin goes to the player once per session', async () => {
    const w = carryWorld('warrior');
    await w.carry.join(w.session);
    await w.carry.join(w.session);
    await new Promise((r) => setTimeout(r, 0));
    // PLACE-479 also sends a link-status frame on join; this test is about the skin frame only
    expect(w.frames.filter((f) => (f as { kind?: string }).kind === 'skin')).toEqual([
      { t: 'placeschema', kind: 'skin', url: 'data:image/png;base64,AAAA', model: 'classic' },
    ]);
  });
});

describe('discard: a signed copy is never destroyed', () => {
  const WEAPON = 'eastbrook_arming_sword';
  it('the named copy is refused with a notice; bulk discard spares it', () => {
    const { sim, pid, meta, ctx } = vendorPlayer();
    meta.inventory.push({ itemId: WEAPON, count: 1, instance: signed(1) });
    sim.drainEvents();
    items.discardItem(ctx, WEAPON, 1, pid, 0);
    expect(errors(sim.drainEvents())).toContain(
      'That item is bound to another world and cannot be destroyed.',
    );
    meta.inventory.unshift({ itemId: WEAPON, count: 1 });
    items.discardItem(ctx, WEAPON, 2, pid);
    expect(meta.inventory).toEqual([{ itemId: WEAPON, count: 1, instance: signed(1) }]);
  });
});

describe('carry: a worn signed copy is carried too', () => {
  it('unequips into the bag, then the one removal + save + carry-out path runs', async () => {
    const asIs = { rung: 'as-is', mesh: { name: `ps_${'b'.repeat(32)}.glb` } };
    const w = carryWorld('warrior', { look: asIs });
    await w.carry.join(w.session);
    expect(w.equipment.mainhand?.instance).toMatchObject({ [GRANT_KEY]: G(900) });
    await w.carry.carry(w.session, [G(900)]);
    const out = w.sent.filter((s) => s.path === '/mod/carry-out');
    expect(out).toHaveLength(1);
    expect(out[0].body.grants).toEqual([G(900)]);
    // gone from both the hand and the bag: exactly one copy, now in escrow
    expect(w.equipment.mainhand).toBeUndefined();
    expect(w.inventory.filter((s) => (s.instance as any)?.[GRANT_KEY] === G(900))).toHaveLength(0);
    expect(w.frames).toContainEqual(expect.objectContaining({ kind: 'ticket' }));
  });
});
