// PlaceSchema fork (PLACE-741): a brand-new character of ANY class earns a
// carryable weapon on the Proving Shore by ordinary play: take the errand from
// the ferryman at the landing, fell one practice-yard effigy, hand it in to the
// drillmaster. No level, no prior quest, no dev command.

import { describe, expect, it } from 'vitest';
import { templateFor } from '../server/placeschema_sidecar';
import { CLASSES } from '../src/sim/content/classes';
import { PROVING_SHORE_QUEST_ORDER } from '../src/sim/content/proving_shore';
import { ITEMS, NPCS, QUESTS } from '../src/sim/data';
import { onMobKilledForQuests } from '../src/sim/quests/quest_credit';
import { Sim } from '../src/sim/sim';
import type { PlayerClass } from '../src/sim/types';

const QUEST = 'q_ps_a_blade_that_travels';

function standAt(sim: Sim, npcId: string): void {
  const npc = [...sim.entities.values()].find((e) => e.kind === 'npc' && e.templateId === npcId);
  if (!npc) throw new Error(`missing ${npcId}`);
  sim.player.pos = { ...npc.pos };
  sim.player.prevPos = { ...sim.player.pos };
}

describe('A Blade That Travels', () => {
  it('stays off the rail, so the island XP and copper pins are untouched', () => {
    expect(PROVING_SHORE_QUEST_ORDER).not.toContain(QUEST);
    expect(QUESTS[QUEST].requiresQuest).toBeUndefined();
    expect(QUESTS[QUEST].minLevel).toBeUndefined();
  });

  it('the ferryman offers it and the drillmaster takes it in (the gossip both NPCs show)', () => {
    expect(NPCS.ferryman_odo.questIds).toContain(QUEST);
    expect(NPCS.drillmaster_rook.questIds).toContain(QUEST);
  });

  for (const cls of Object.keys(CLASSES) as PlayerClass[]) {
    it(`a new ${cls} earns a carryable weapon in one effigy`, () => {
      const sim = new Sim({ seed: 7, playerClass: cls });
      expect(sim.player.level).toBe(1);
      standAt(sim, 'ferryman_odo');
      expect(sim.questState(QUEST)).toBe('available');
      sim.acceptQuest(QUEST);
      expect(sim.questLog.get(QUEST)?.state).toBe('active');

      const effigy = [...sim.entities.values()].find(
        (e) => e.kind === 'mob' && e.templateId === 'training_effigy',
      );
      onMobKilledForQuests(sim.ctx, effigy!, sim.players.get(sim.playerId)!);
      expect(sim.questLog.get(QUEST)?.state).toBe('ready');

      standAt(sim, 'drillmaster_rook');
      const before = sim.players.get(sim.playerId)!.inventory.map((s) => s.itemId);
      sim.turnInQuest(QUEST);
      expect(sim.questsDone.has(QUEST)).toBe(true);

      const got = sim
        .players.get(sim.playerId)!
        .inventory.map((s) => s.itemId)
        .filter((id) => !before.includes(id));
      expect(got).toHaveLength(1);
      expect(ITEMS[got[0]].kind).toBe('weapon');
      // the demo carry policy lists weapon.woc.* (open-place e2e/woc-loop.walk.ts)
      expect(templateFor(got[0]).type).toMatch(/^weapon\.woc\./);
    });
  }
});
