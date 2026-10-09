// The PlaceSchema portal (PLACE-954): the walk-through way out of WoC with whatever you carry, the
// same nether-style gate the Minecraft plugin builds. Pure data, shared by the renderer (draws it,
// render/placeschema_portal.ts) and the server (notices the walk-in from its own positions and
// carries everything out, server/placeschema_sidecar.ts). Online only: offline there is no sidecar,
// so nothing is drawn.

export interface PlaceSchemaPortalSpot {
  x: number;
  z: number;
  /** yaw of the opening's normal (forward = (-sin f, cos f), as NPC facings) */
  facing: number;
}

/** One on the Proving Shore beside the arrival and Odo's pier, one in Eastbrook by the square. */
export const PLACESCHEMA_PORTALS: readonly PlaceSchemaPortalSpot[] = [
  { x: -292, z: -6, facing: Math.PI },
  { x: 0, z: -20, facing: 0 },
];

/** The mouth: as a dungeon door (DOOR_TRIGGER_RADIUS). */
export const PLACESCHEMA_PORTAL_RADIUS = 2;

/** True when (x, z) is within `radius` of a portal's centre. */
export function inPlaceSchemaPortal(
  x: number,
  z: number,
  radius = PLACESCHEMA_PORTAL_RADIUS,
): boolean {
  return PLACESCHEMA_PORTALS.some((p) => (x - p.x) ** 2 + (z - p.z) ** 2 < radius * radius);
}

/**
 * Walk-THROUGH arm/latch: fires once the player is seen outside every mouth and then steps into one,
 * so logging in or arriving inside a mouth never fires. After firing it waits for the player to step
 * out again (a refused carry leaves them standing in it) before it can fire once more.
 */
export class PlaceSchemaPortalGate {
  private armed = false;

  tick(pos: { x: number; z: number } | undefined, dead = false): boolean {
    if (!pos || dead) return false;
    const inside = inPlaceSchemaPortal(pos.x, pos.z);
    if (!inside) {
      this.armed = true;
      return false;
    }
    if (!this.armed) return false;
    this.armed = false;
    return true;
  }
}
