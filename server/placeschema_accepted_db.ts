// PlaceSchema carry: the ACCOUNT's claims on offered grants, and its unconfirmed cancels (PLACE-276).
//
// The sidecar offers and acks per game account (platform id `<account id>@<realm host>`), so the
// exactly-once rule is per account: one row per (account, grant) is the account's CLAIM on it.
//
// Claim first (round 7). Join inserts the claim in its own statement BEFORE it adds the item, as
// `pending`; the character save that then holds the item clears `pending` in its own transaction
// (syncPlaceschemaAccepted, beside journalCharacterSaveSources in every save path). Crash cases:
//  - after the claim, before the item save: the claim stays pending and nobody holds the item. The
//    sidecar still offers the grant (it was never acked), and the next join re-claims that pending
//    claim (its character is offline after a restart) and adds the item once.
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
-- Characters saved before the account set existed: their accepted ids move up to their account.
INSERT INTO placeschema_accepted (account_id, grant_id, character_id)
SELECT c.account_id, g.id, c.id
FROM characters c
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(c.state->'placeschemaAccepted') = 'array' THEN c.state->'placeschemaAccepted' ELSE '[]'::jsonb END
) AS g(id)
WHERE g.id ~ '^[0-9a-f]{64}$'
ON CONFLICT (account_id, grant_id) DO NOTHING;
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
  if (ids.length)
    await tx.query(
      `UPDATE placeschema_accepted SET pending = false
       WHERE character_id = $1 AND grant_id = ANY($2::text[]) AND pending`,
      [characterId, ids],
    );
}

export type ClaimOutcome = 'claimed' | 'held' | 'busy';

/**
 * Claim one offered grant for this account, before the item is added (its own statements, committed
 * at once). `claimed`: add the item now. `held`: the account already holds it (ack, never add).
 * `busy`: another ONLINE character of the account has a pending claim still being saved (skip; the
 * next join settles it). A pending claim whose character is not online is a crash leftover: taken
 * over, so the item is added exactly once.
 */
export async function claimGrant(
  q: SqlRunner,
  accountId: number,
  grantId: string,
  characterId: number,
  onlineCharacterIds: readonly number[],
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
  if (row.character_id === characterId) return 'claimed';
  if (onlineCharacterIds.includes(row.character_id)) return 'busy';
  const taken = rowsOf(
    await q.query(
      `UPDATE placeschema_accepted SET character_id = $1
       WHERE claim_id = $2 AND pending AND character_id = $3 RETURNING claim_id`,
      [characterId, row.claim_id, row.character_id],
    ),
  );
  return taken.length ? 'claimed' : 'busy';
}

/** The account-level store the carry module reads (and a test replaces). */
export interface AcceptedStore {
  /** the account's claims: grant id -> claim id */
  claims(accountId: number): Promise<Map<string, number>>;
  claim(
    accountId: number,
    grantId: string,
    characterId: number,
    onlineCharacterIds: readonly number[],
  ): Promise<ClaimOutcome>;
  cancels(accountId: number): Promise<{ grant: string; attempt: string }[]>;
  putCancel(accountId: number, grant: string, attempt: string): Promise<void>;
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
    claim: async (accountId, grantId, characterId, online) =>
      claimGrant(await pool(), accountId, grantId, characterId, online),
    cancels: async (accountId) =>
      (
        await q<{ grant_id: string; attempt: string }>(
          `SELECT grant_id, attempt FROM placeschema_cancels WHERE account_id = $1`,
          [accountId],
        )
      ).map((r) => ({ grant: r.grant_id, attempt: r.attempt })),
    putCancel: async (accountId, grant, attempt) => {
      await q(
        `INSERT INTO placeschema_cancels (account_id, grant_id, attempt) VALUES ($1, $2, $3)
         ON CONFLICT (account_id, grant_id) DO UPDATE SET attempt = excluded.attempt`,
        [accountId, grant, attempt],
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
