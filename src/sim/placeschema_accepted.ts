// The PlaceSchema grants a character has accepted (server/placeschema_sidecar.ts, PLACE-276). A
// grant id joins the set in the same save that adds its item and leaves it in the same save that
// carries the item out, so a grant the sidecar offers again is acked, never added twice, wherever the
// copy has gone since. Persisted as CharacterState.placeschemaAccepted, absent when empty.

const GRANT_ID = /^[0-9a-f]{64}$/;

export function loadPlaceschemaAccepted(saved: unknown): Set<string> {
  return new Set(
    (Array.isArray(saved) ? saved : []).filter(
      (g): g is string => typeof g === 'string' && GRANT_ID.test(g),
    ),
  );
}

export function savedPlaceschemaAccepted(accepted: ReadonlySet<string>): {
  placeschemaAccepted?: string[];
} {
  return accepted.size ? { placeschemaAccepted: [...accepted] } : {};
}
