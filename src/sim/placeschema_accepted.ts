// The PlaceSchema claims a character has touched (server/placeschema_sidecar.ts, PLACE-276). The
// account's claims live in the database (server/placeschema_accepted_db.ts); the character state
// carries only what its own saves must apply in their transaction:
//  - placeschemaAccepted: grant ids whose items this character added (the save confirms the claim);
//  - placeschemaReleased: claim ids this character carried out (the save deletes those claims,
//    whichever character claimed them). Claim ids are never reused, so the list is replay-safe.
// Both are absent for a character that never used PlaceSchema (its saves run no extra statement) and
// kept, even empty, once it has.

const GRANT_ID = /^[0-9a-f]{64}$/;
/** Released claim ids kept per character (replay-safe; the newest are the ones that matter). */
export const MAX_RELEASED = 64;
const touched = new WeakSet<ReadonlySet<string>>();
const released = new WeakMap<ReadonlySet<string>, number[]>();

export function loadPlaceschemaAccepted(s: {
  placeschemaAccepted?: unknown;
  placeschemaReleased?: unknown;
}): Set<string> {
  const set = new Set(
    (Array.isArray(s.placeschemaAccepted) ? s.placeschemaAccepted : []).filter(
      (g): g is string => typeof g === 'string' && GRANT_ID.test(g),
    ),
  );
  if (Array.isArray(s.placeschemaAccepted)) touched.add(set);
  if (Array.isArray(s.placeschemaReleased))
    released.set(
      set,
      s.placeschemaReleased.filter((c): c is number => Number.isSafeInteger(c) && c > 0),
    );
  return set;
}

/** Mark a character as using PlaceSchema: its saves now always carry the keys. */
export function touchPlaceschemaAccepted(accepted: ReadonlySet<string>): void {
  touched.add(accepted);
}

/** Record a claim this character's next save must delete (a carry-out). */
export function releasePlaceschemaClaim(accepted: ReadonlySet<string>, claimId: number): void {
  touched.add(accepted);
  released.set(accepted, [...(released.get(accepted) ?? []), claimId].slice(-MAX_RELEASED));
}

/** Undo a release whose save did not land. */
export function unreleasePlaceschemaClaim(accepted: ReadonlySet<string>, claimId: number): void {
  released.set(
    accepted,
    (released.get(accepted) ?? []).filter((c) => c !== claimId),
  );
}

export function savedPlaceschemaAccepted(accepted: ReadonlySet<string>): {
  placeschemaAccepted?: string[];
  placeschemaReleased?: number[];
} {
  return accepted.size || touched.has(accepted)
    ? {
        placeschemaAccepted: [...accepted],
        placeschemaReleased: [...(released.get(accepted) ?? [])],
      }
    : {};
}
