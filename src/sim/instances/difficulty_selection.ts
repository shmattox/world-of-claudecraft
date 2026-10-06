// The dungeon-difficulty selection command (the `set_dungeon_difficulty` wire
// command, the portrait-menu toggle, and `/dungeon normal|heroic`), extracted from
// the Sim coordinator behind the SimContext seam. Party/meta state stays on Sim;
// this module only reads and stamps it through ctx.
//
// A CHANGE of the caller's effective difficulty also runs the classic implicit
// reset over the caller's (or the leader's party's) claims, through the exact
// Reset All Instances gates (instances/dungeons.ts resetDungeonInstances). Without
// it a group's live claim kept winning at the door, so a leader who switched
// difficulty walked straight back into the old-difficulty run, and leaving and
// reforming the party under a fresh key was the only practical way out.
import type { SimContext } from '../sim_context';
import { type DungeonDifficulty, isDungeonDifficulty } from '../types';
import { resetDungeonInstances } from './dungeons';

export function setDungeonDifficulty(
  ctx: SimContext,
  difficulty: DungeonDifficulty,
  pid?: number,
): void {
  if (!isDungeonDifficulty(difficulty)) return;
  const r = ctx.resolve(pid);
  if (!r) return;
  const party = ctx.partyOf(r.meta.entityId);
  if (party && party.leader !== r.meta.entityId) {
    ctx.error(r.meta.entityId, 'You are not the party leader.');
    return;
  }
  const previous = ctx.dungeonDifficulty(r.meta.entityId);
  // Only the SETTER's own preference is stamped: members mirror the party via
  // Sim.dungeonDifficulty while grouped and keep their own prior preference
  // after leaving, so a stale stamp can never leak into another group.
  if (difficulty === 'normal') delete r.meta.dungeonDifficulty;
  else r.meta.dungeonDifficulty = difficulty;
  if (party) {
    if (difficulty === 'normal') delete party.dungeonDifficulty;
    else party.dungeonDifficulty = difficulty;
  }
  ctx.error(
    r.meta.entityId,
    difficulty === 'heroic'
      ? 'Dungeon difficulty set to Heroic.'
      : 'Dungeon difficulty set to Normal.',
  );
  // Re-selecting the current difficulty is a no-op, never a reset: the
  // same-difficulty guard exists so Normal bosses cannot be farmed by toggling.
  if (previous !== difficulty) {
    resetDungeonInstances(ctx, r.meta.entityId, { onDifficultyChange: true });
  }
}
