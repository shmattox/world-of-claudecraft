// The PlaceSchema portal (PLACE-954): the walk-through way out of WoC with whatever you carry, drawn
// in the realm's portal art (PLACE-1026: PlaceSchema's standard ring, or WoC's rift gate). Pure data, shared by the renderer (draws it,
// render/placeschema_portal.ts) and the server (notices the walk-in from its own positions and
// carries everything out, server/placeschema_sidecar.ts). Online only: offline there is no sidecar,
// so nothing is drawn.

export interface PlaceSchemaPortalSpot {
  x: number;
  z: number;
  /** yaw of the opening's normal: it faces (sin f, cos f), as a three.js rotation.y */
  facing: number;
}

/** One on the Proving Shore on the beach just south of the arrival, facing it (off the shore's routes:
 *  at (-292, -6) it stood on the path from Odo's pier to the practice yard, and players doing the
 *  errand walked through it), one in Eastbrook by the square. */
export const PLACESCHEMA_PORTALS: readonly PlaceSchemaPortalSpot[] = [
  { x: -284, z: -28, facing: 0 },
  { x: 0, z: -20, facing: 0 },
];

/** The gate's unit in yards (once a Minecraft block, when the gate was drawn as one): the walk-in
 *  is four of them wide, and the drawn portal is sized to that width. */
export const PLACESCHEMA_PORTAL_BLOCK = 0.9;
/** The gate: two units either side of the centre line (the drawn portal's whole width; it has no
 *  collider, so stepping through its rim is stepping through the gate), and this deep. */
const HALF_WIDTH = 2 * PLACESCHEMA_PORTAL_BLOCK;
const DEPTH = 0.6;

/** (x, z) in a portal's frame: `depth` through the sheet along its normal, `side` across it. */
function frameOf(p: PlaceSchemaPortalSpot, x: number, z: number) {
  const dx = x - p.x;
  const dz = z - p.z;
  const nx = Math.sin(p.facing);
  const nz = Math.cos(p.facing);
  return { depth: dx * nx + dz * nz, side: dx * nz - dz * nx };
}

/** True when (x, z) stands in a portal (within its frame's width, not beside it). */
export function inPlaceSchemaPortal(x: number, z: number): boolean {
  return PLACESCHEMA_PORTALS.some((p) => {
    const f = frameOf(p, x, z);
    return Math.abs(f.side) < HALF_WIDTH && Math.abs(f.depth) < DEPTH;
  });
}

/** True when a step from `a` to `b` passed through a portal, however fast: the server sees
 *  positions a few times a second, and a running player can cross the sheet between two looks. */
export function crossedPlaceSchemaPortal(
  a: { x: number; z: number },
  b: { x: number; z: number },
): boolean {
  return PLACESCHEMA_PORTALS.some((p) => {
    const fa = frameOf(p, a.x, a.z);
    const fb = frameOf(p, b.x, b.z);
    // still on one side (standing in the sheet is inPlaceSchemaPortal's), or a teleport
    if (fa.depth < 0 === fb.depth < 0 || Math.abs(fa.depth - fb.depth) > 6) return false;
    const t = fa.depth / (fa.depth - fb.depth);
    return Math.abs(fa.side + (fb.side - fa.side) * t) < HALF_WIDTH;
  });
}

/**
 * Walk-THROUGH arm/latch: fires once the player is seen outside every gate and then steps into
 * or through one, so logging in or arriving inside a gate never fires. After firing it waits for
 * the player to step out again (a refused carry leaves them standing in it) before it can fire once
 * more.
 */
export class PlaceSchemaPortalGate {
  private armed = false;
  private last: { x: number; z: number } | undefined;

  tick(pos: { x: number; z: number } | undefined, dead = false): boolean {
    if (!pos || dead) {
      // the dead and the absent re-arm only by being seen outside again
      this.last = undefined;
      this.armed = false;
      return false;
    }
    const last = this.last;
    this.last = { x: pos.x, z: pos.z };
    // arriving from far away (a ferry, a hearthstone, a respawn) is not walking in
    if (!last || Math.hypot(pos.x - last.x, pos.z - last.z) > 6) {
      this.armed = !inPlaceSchemaPortal(pos.x, pos.z);
      return false;
    }
    // stepping out of the sheet is not a crossing; stepping through it from outside is
    const entered =
      inPlaceSchemaPortal(pos.x, pos.z) ||
      (!inPlaceSchemaPortal(last.x, last.z) && crossedPlaceSchemaPortal(last, pos));
    if (!entered) {
      this.armed = true;
      return false;
    }
    if (!this.armed) return false;
    this.armed = false;
    return true;
  }
}
