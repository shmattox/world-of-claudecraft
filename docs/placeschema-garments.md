# WoC armor in other PlaceSchema worlds

A WoC armor item carried to another PlaceSchema world (the Hub, for example) brings its look as a garment GLB (PLACE-490).

## Which garment

WoC armor is the KayKit class kits (KayKit Character Pack: Adventurers 2.0, Kay Lousberg, CC0 1.0, the source of the knight, mage and ranger kits per `scripts/assets/specs/characters_v2.json`). An armor item has no look of its own in WoC, because every character wears its class kit. So the item's armor type picks the kit, and its slot picks the piece (`server/placeschema_garments.ts`):

| Armor type | Kit |
|---|---|
| cloth | mage |
| leather | ranger |
| mail | knight |

| Slot | Piece |
|---|---|
| helmet | head |
| chest | chest |
| shoulder | arms |
| gloves | hands |
| legs | legs |
| feet | feet |

A waist, neck, ring or trinket item has no garment, and neither does a piece its kit doesn't have (ranger helmets, mage gloves). Those items fall back to the other world's from-meaning look.

Each armor item's template also carries its worn anchor, so the other world knows where it goes: helmet→head, chest→torso, legs, gloves→hands, feet, shoulder, waist, back.

## The files

`npx tsx scripts/assets/placeschema_garments.ts [--origin https://woc.placeschema.com]` keeps only the `Armor_<kit>_<part>` nodes, with their skeleton. The modular body that holds them is never served whole: it also holds body, hair and face art that has no licence row. The script writes `public/placeschema/garments/`:
- `<kit>_<piece>.glb`: 19 garments, about 45 KB each.
  Each one's scene carries `placeschema_garment` extras, so PlaceSchema worlds bind it to the KayKit knight body they give WoC arrivals (PLACE-1071). The extras hold the knight file's SHA-256 (`KNIGHT_BODY_HASH`), the wardrobe slot and covered bones (`PIECE_SLOT`), and the `Rig_Medium` joints as three loads them, punctuation stripped (`RIG_MEDIUM_BONES`), all in `server/placeschema_garments.ts`. The knight shares the garments' skeleton, so nothing is refitted. open-place's `scripts/assets/kaykit-body-check.mjs` checks that the rest poses match. An armor item with a garment also carries `fits:knight` in its carried template (`garmentFits`, PLACE-1091). So a player who switches to another body sees the item hidden with a "can't be displayed on this model" note instead of losing it silently. `GARMENT_FILES` lists the 19 files for the server, and the script fails if what it writes differs.
- `provenance.json`: each file's source nodes, author, source and licence.
- `sidecar-looks.json`: the WoC sidecar's `SIDECAR_LOOKS`, one `armor.woc.<id>` per item that has a garment.
- `sidecar-open-looks.txt`: its `SIDECAR_OPEN_LOOKS`, every garment URL. They are CC0, so the sidecar may stamp them into grants as `render-asset:`.

The folder sits outside `public/models` on purpose. These files are for other worlds, so WoC's own model gates don't apply to them: the KTX2-only texture rule (`public/models/CLAUDE.md`) and the generated media manifest. They ship PNG because deployed PlaceSchema worlds can't run the KTX2 transcoder.

Re-run the script when the armor catalog or the modular body changes. Set the two sidecar variables from the last two files, with `--origin` matching where the WoC client serves `public/`.
