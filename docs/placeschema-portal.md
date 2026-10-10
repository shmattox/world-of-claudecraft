# The PlaceSchema portal in WoC

The PlaceSchema portal is the way out of WoC with whatever a player carries (PLACE-954). Two stand in the world:
- on the Proving Shore beach, just south of the arrival;
- south of the Eastbrook square.

Walking through one carries the player's signed copies out to the realm's home world (`PLACESCHEMA_HOME`). The server notices the walk-in from its own positions (`src/sim/placeschema_portal.ts`), and the client only draws the gate (`src/render/placeschema_portal.ts`). The gates show only while the realm has a PlaceSchema sidecar.

## Its look: `PLACESCHEMA_PORTAL_ART`

A server setting picks how the gates are drawn (PLACE-1026):

| Value | The gate |
|---|---|
| `default` (or unset) | PlaceSchema's standard portal, the Hub's. A round window on the destination, edged by a flat glowing amber band with the destination's name carved across its top. Around it are a halo and a pool of light at its foot. It is ported from open-place `world-kit/src/portal-ring.ts` and sized to the walk-in gate. |
| `custom` | WoC's own rift gate (`buildRiftGateBody` in `src/render/door_portal.ts`), scaled to the same gate. The default ring stands in until its model has loaded. |

An unknown value counts as `default`: the portal still stands, in PlaceSchema's look. Nothing is generated. `custom` uses art WoC already ships.

The window shows the destination's own picture, its manifest's `preview`, accepted only from the destination's own origin. Until that arrives, the window shows the PlaceSchema mark on black. The name comes from the same manifest's `name`, up to 32 characters. Both reach the client in the sidecar's `portal` frame. The art setting rides the `status` frame.

## Related settings

- `PLACESCHEMA_MENU=full|partial|off`: the in-game PlaceSchema menu (PLACE-1018). See the header of `src/ui/placeschema_menu.ts`.
