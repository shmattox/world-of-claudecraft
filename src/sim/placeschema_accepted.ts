// The PlaceSchema grants a character has accepted (server/placeschema_sidecar.ts, PLACE-276). A
// grant id joins the set in the same save that adds its item and leaves it in the same save that
// carries the item out; each save mirrors the set into the ACCOUNT's set in its own transaction
// (server/placeschema_accepted_db.ts). Persisted as CharacterState.placeschemaAccepted: absent for a
// character that never used PlaceSchema (so its saves run no extra statement), and kept, even empty,
// once it has, so the save that removes the last id still clears the account row.

const GRANT_ID = /^[0-9a-f]{64}$/;
/** Sets of characters that have used PlaceSchema (loaded with the key, or given an id since). */
const touched = new WeakSet<ReadonlySet<string>>();

export function loadPlaceschemaAccepted(saved: unknown): Set<string> {
  const set = new Set(
    (Array.isArray(saved) ? saved : []).filter(
      (g): g is string => typeof g === 'string' && GRANT_ID.test(g),
    ),
  );
  if (Array.isArray(saved)) touched.add(set);
  return set;
}

/** Mark a character as using PlaceSchema: its saves now always carry the key. */
export function touchPlaceschemaAccepted(accepted: ReadonlySet<string>): void {
  touched.add(accepted);
}

export function savedPlaceschemaAccepted(accepted: ReadonlySet<string>): {
  placeschemaAccepted?: string[];
} {
  return accepted.size || touched.has(accepted) ? { placeschemaAccepted: [...accepted] } : {};
}
