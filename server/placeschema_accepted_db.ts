// PlaceSchema carry: the ACCOUNT's claims on offered grants, and its unconfirmed cancels (PLACE-276).
//
// The sidecar offers and acks per game account (platform id `<account id>@<realm host>`), so the
// exactly-once rule is per account: one row per (account, grant) is the account's CLAIM on it.
//
// Claim first (round 7). Join inserts the claim in its own statement BEFORE it adds the item, as
// `pending`; the character save that then holds the item clears `pending` in its own transaction
// (syncPlaceschemaAccepted, beside journalCharacterSaveSources in every save path). Crash cases:
//  - after the claim, before the item save: the claim stays pending and nobody holds the item. The
//    sidecar still offers the grant (it was never acked), and that character's next join re-claims
//    its own pending claim and adds the item once. No other character ever takes it over.
//  - after the item save, before the ack: the claim is no longer pending; the re-offer is acked and
//    never added again, on any character.
// Release (round 7, B2). A carry-out removes the item and records the CLAIM ID it releases in the
// character state; that save deletes the claim by id, whichever character claimed it (the item may
// have been mailed from another character). Claim ids are never reused, so an old release can never
// delete a later claim of the same grant. `character_id` is provenance, never an ownership check.

/** Anything that runs one SQL statement: a save transaction or a pooled client. */
export interface SqlRunner {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

const GRANT_ID = /^[0-9a-f]{64}$/;

export const PLACESCHEMA_ACCEPTED_SCHEMA = `
CREATE TABLE IF NOT EXISTS placeschema_accepted (
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL,
  character_id INT NOT NULL,
  PRIMARY KEY (account_id, grant_id)
);
ALTER TABLE placeschema_accepted ADD COLUMN IF NOT EXISTS claim_id BIGSERIAL;
ALTER TABLE placeschema_accepted ADD COLUMN IF NOT EXISTS pending BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS placeschema_accepted_claim ON placeschema_accepted (claim_id);
CREATE INDEX IF NOT EXISTS placeschema_accepted_by_character ON placeschema_accepted (character_id);
CREATE TABLE IF NOT EXISTS placeschema_cancels (
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL,
  attempt TEXT NOT NULL,
  PRIMARY KEY (account_id, grant_id)
);
`;

const rowsOf = <T>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? []) as T[];

/**
 * Inside a character save's transaction: delete the claims this character released (by claim id,
 * whoever claimed them), and confirm (un-pend) the claims whose items this save now holds.
 */
export async function syncPlaceschemaAccepted(
  tx: SqlRunner,
  characterId: number,
  state: { placeschemaAccepted?: unknown; placeschemaReleased?: unknown },
): Promise<void> {
  // A character that never used PlaceSchema carries no key: its saves run no extra statement.
  if (!Array.isArray(state.placeschemaAccepted)) return;
  const released = (
    Array.isArray(state.placeschemaReleased) ? state.placeschemaReleased : []
  ).filter((c): c is number => Number.isSafeInteger(c) && c > 0);
  if (released.length)
    await tx.query(
      `DELETE FROM placeschema_accepted a USING characters c
       WHERE c.id = $1 AND a.account_id = c.account_id AND a.claim_id = ANY($2::bigint[])`,
      [characterId, released],
    );
  const ids = state.placeschemaAccepted.filter(
    (g): g is string => typeof g === 'string' && GRANT_ID.test(g),
  );
  if (!ids.length) return;
  // Round 9 (B4): only this character's own PENDING claims are completed here. A claim that is already
  // confirmed, or gone (its item moved away and was released), needs nothing, so a stale id can never
  // wedge a save. No other character can hold a claim this one added: claimGrant never takes over.
  await tx.query(
    `UPDATE placeschema_accepted SET pending = false
     WHERE character_id = $1 AND grant_id = ANY($2::text[]) AND pending`,
    [characterId, ids],
  );
  // Every id is now recorded in the account table (or its item left), so the landed blob keeps none:
  // a relog or a crash after the ack can never re-arm a stale id. ponytail: an id still in memory
  // re-runs this per save until the next join or relog drops it; cheap and inert.
  await tx.query(
    `UPDATE characters SET state = jsonb_set(state, '{placeschemaAccepted}', '[]'::jsonb) WHERE id = $1`,
    [characterId],
  );
}

/** Inside a character's DELETE transaction: its pending claims (items it never saved) are released
 *  so the grants can be claimed again; its confirmed claims stay, the account accepted them. */
export async function releasePendingClaimsOf(tx: SqlRunner, characterId: number): Promise<void> {
  await tx.query(`DELETE FROM placeschema_accepted WHERE character_id = $1 AND pending`, [
    characterId,
  ]);
}

export type ClaimOutcome = 'claimed' | 'held' | 'busy';

/**
 * Claim one offered grant for this account, before the item is added (its own statements, committed
 * at once). `claimed`: add the item now (a new claim, or this character's own pending one left by a
 * crash). `held`: the account already holds it (ack, never add). `busy`: another character's pending
 * claim (skip, never take it over: that character may still be saving, here or in another realm
 * process; its delete releases it).
 */
export async function claimGrant(
  q: SqlRunner,
  accountId: number,
  grantId: string,
  characterId: number,
): Promise<ClaimOutcome> {
  const inserted = rowsOf(
    await q.query(
      `INSERT INTO placeschema_accepted (account_id, grant_id, character_id, pending)
       VALUES ($1, $2, $3, true) ON CONFLICT (account_id, grant_id) DO NOTHING RETURNING claim_id`,
      [accountId, grantId, characterId],
    ),
  );
  if (inserted.length) return 'claimed';
  const [row] = rowsOf<{ claim_id: string; character_id: number; pending: boolean }>(
    await q.query(
      `SELECT claim_id, character_id, pending FROM placeschema_accepted WHERE account_id = $1 AND grant_id = $2`,
      [accountId, grantId],
    ),
  );
  if (!row) return 'busy'; // released between the two statements: the next join claims it
  if (!row.pending) return 'held';
  return row.character_id === characterId ? 'claimed' : 'busy';
}

/** The account-level store the carry module reads (and a test replaces). */
export interface AcceptedStore {
  /** the account's claims: grant id -> claim id */
  claims(accountId: number): Promise<Map<string, number>>;
  claim(accountId: number, grantId: string, characterId: number): Promise<ClaimOutcome>;
  cancels(accountId: number): Promise<{ grant: string; attempt: string }[]>;
  /** one statement for every grant of an attempt: all of them are journalled, or none */
  putCancels(accountId: number, grants: readonly string[], attempt: string): Promise<void>;
  dropCancel(accountId: number, grant: string): Promise<void>;
}

export function pgAcceptedStore(): AcceptedStore {
  const pool = async () => (await import('./db')).pool;
  const q = async <T>(text: string, values: unknown[]): Promise<T[]> =>
    rowsOf<T>(await (await pool()).query(text, values));
  return {
    claims: async (accountId) =>
      new Map(
        (
          await q<{ grant_id: string; claim_id: string }>(
            `SELECT grant_id, claim_id FROM placeschema_accepted WHERE account_id = $1`,
            [accountId],
          )
        ).map((r) => [r.grant_id, Number(r.claim_id)]),
      ),
    claim: async (accountId, grantId, characterId) =>
      claimGrant(await pool(), accountId, grantId, characterId),
    cancels: async (accountId) =>
      (
        await q<{ grant_id: string; attempt: string }>(
          `SELECT grant_id, attempt FROM placeschema_cancels WHERE account_id = $1`,
          [accountId],
        )
      ).map((r) => ({ grant: r.grant_id, attempt: r.attempt })),
    putCancels: async (accountId, grants, attempt) => {
      await q(
        `INSERT INTO placeschema_cancels (account_id, grant_id, attempt)
         SELECT $1, g, $3 FROM unnest($2::text[]) AS g
         ON CONFLICT (account_id, grant_id) DO UPDATE SET attempt = excluded.attempt`,
        [accountId, [...grants], attempt],
      );
    },
    dropCancel: async (accountId, grant) => {
      await q(`DELETE FROM placeschema_cancels WHERE account_id = $1 AND grant_id = $2`, [
        accountId,
        grant,
      ]);
    },
  };
}
