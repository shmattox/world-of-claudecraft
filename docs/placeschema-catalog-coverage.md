# PlaceSchema catalog coverage

Regenerate with `node scripts/placeschema-coverage.mjs`. The script reads every `*items.ts` file under `src/sim/content/`, checks each exported `*_ITEMS` table against the live `ITEMS` catalog, and uses the game server's `typeFor` mapping.

A mapped item has a WoC catalog definition and a nonempty PlaceSchema type from `server/placeschema_sidecar.ts`. That server maps every catalog kind, using `misc.<kind>` for kinds without a specialized type. The renderer display fallback in `src/render/characters/woc_item_display.ts` and the offline GUID mint in `src/game/item_guid_mint.ts` do not refuse catalog classes.

| Item class | Total | Mapped | Refused |
| --- | ---: | ---: | ---: |
| `armor` | 222 | 222 | 0 |
| `bag` | 14 | 14 | 0 |
| `drink` | 5 | 5 | 0 |
| `elixir` | 4 | 4 | 0 |
| `flask` | 3 | 3 | 0 |
| `food` | 34 | 34 | 0 |
| `held_offhand` | 10 | 10 | 0 |
| `junk` | 129 | 129 | 0 |
| `mount` | 6 | 6 | 0 |
| `potion` | 13 | 13 | 0 |
| `quest` | 20 | 20 | 0 |
| `scroll` | 3 | 3 | 0 |
| `tool` | 43 | 43 | 0 |
| `weapon` | 66 | 66 | 0 |

## Refused classes

None. The game has no catalog-class refusal rule. Per-copy and transport refusals in `PlaceSchemaCarry` are outside these class counts.
