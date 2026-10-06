// Wire decode for the `social` frame's mirror shape, extracted from online.ts
// so the version-skew normalization is a pure, unit-testable table and the
// coordinator stays a one-line consumer.
//
// The pledge-board fields are normalized with defaults so an older server's
// frame (no pledge board) still yields a fully-shaped mirror: settings read as
// accepting (the feature's default), no open pledges, tier 0, no standing
// pledge. The friend/block/ignore lists default to empty for the same reason.
import type { SocialInfo } from '../world_api';
import { PRESENCE_MODES } from '../world_api/social_graph';
import { decodeGuildPledgeSettings } from './guild_board_wire';

/** The `social` frame as it arrives (loosely typed at the trust boundary). */
export interface SocialFrameLike {
  friends?: SocialInfo['friends'];
  blocks?: SocialInfo['blocks'];
  ignores?: SocialInfo['ignores'];
  guild?:
    | (Omit<NonNullable<SocialInfo['guild']>, 'pledgeSettings' | 'pledges' | 'tier'> &
        Partial<Pick<NonNullable<SocialInfo['guild']>, 'pledgeSettings' | 'pledges' | 'tier'>>)
    | null;
  myPledge?: SocialInfo['myPledge'];
  presenceMode?: unknown;
}

export function socialInfoFromFrame(msg: SocialFrameLike): SocialInfo {
  const guild = msg.guild
    ? {
        ...msg.guild,
        pledgeSettings: decodeGuildPledgeSettings(msg.guild.pledgeSettings),
        pledges: msg.guild.pledges ?? [],
        tier: msg.guild.tier ?? 0,
      }
    : null;
  return {
    friends: msg.friends ?? [],
    blocks: msg.blocks ?? [],
    ignores: msg.ignores ?? [],
    guild,
    myPledge: msg.myPledge ?? null,
    // The viewer's presence setting, only when it is one of the three known values.
    ...(PRESENCE_MODES.find((m) => m === msg.presenceMode)
      ? { presenceMode: msg.presenceMode as NonNullable<SocialInfo['presenceMode']> }
      : {}),
  };
}
