// PlaceSchema carry: the ACCOUNT's accepted grants and its unconfirmed cancels (PLACE-276 round 5).
//
// The sidecar offers and acks per game account (platform id `<account id>@<realm host>`), so the
// exactly-once rule is per account too: a grant any character on the account has accepted is never
// added again by another. The character's own saved state keeps its ids (`placeschemaAccepted`), and
// every character save mirrors them into `placeschema_accepted` INSIDE the same transaction
// (syncPlaceschemaAccepted, called beside journalCharacterSaveSources in each db.ts save path), so
// the item and its account-level id always commit together.

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

/** Mirror one saved character's accepted ids into its account's set, inside that save's transaction. */
export async function syncPlaceschemaAccepted(
  tx: SqlRunner,
  characterId: number,
  state: { placeschemaAccepted?: unknown },
): Promise<void> {
  const ids = (Array.isArray(state.placeschemaAccepted) ? state.placeschemaAccepted : []).filter(
    (g): g is string => typeof g === 'string' && GRANT_ID.test(g),
  );
  await tx.query(
    `DELETE FROM placeschema_accepted WHERE character_id = $1 AND NOT (grant_id = ANY($2::text[]))`,
    [characterId, ids],
  );
  if (!ids.length) return;
  await tx.query(
    `INSERT INTO placeschema_accepted (account_id, grant_id, character_id)
     SELECT c.account_id, g, c.id FROM characters c, unnest($2::text[]) AS g WHERE c.id = $1
     ON CONFLICT (account_id, grant_id) DO UPDATE SET character_id = excluded.character_id`,
    [characterId, ids],
  );
}

/** The account-level store the carry module reads (and a test replaces). */
export interface AcceptedStore {
  accepted(accountId: number): Promise<Set<string>>;
  cancels(accountId: number): Promise<{ grant: string; attempt: string }[]>;
  putCancel(accountId: number, grant: string, attempt: string): Promise<void>;
  dropCancel(accountId: number, grant: string): Promise<void>;
}

export function pgAcceptedStore(): AcceptedStore {
  const q = async <T>(text: string, values: unknown[]): Promise<T[]> =>
    ((await (await import('./db')).pool.query(text, values)) as unknown as { rows: T[] }).rows;
  return {
    accepted: async (accountId) =>
      new Set(
        (
          await q<{ grant_id: string }>(
            `SELECT grant_id FROM placeschema_accepted WHERE account_id = $1`,
            [accountId],
          )
        ).map((r) => r.grant_id),
      ),
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
