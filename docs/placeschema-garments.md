# WoC armor in other PlaceSchema worlds

A WoC armor item carried to another PlaceSchema world (the Hub, for example) brings its look as a garment GLB (PLACE-490).

## Which garment

WoC armor is the KayKit class kits (KayKit Character Pack Adventures 1.0, Kay Lousberg, CC0 1.0). An armor item has no look of its own in WoC, because every character wears its class kit. So the item's armor type picks the kit, and its slot picks the piece (`server/placeschema_garments.ts`):

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

`npx tsx scripts/assets/placeschema_garments.ts [--origin https://woc.placeschema.com]` keeps only the `Armor_<kit>_<part>` nodes, with their skeleton. The modular body that holds them is never served whole: it also holds body, hair and face art that has no licence row. The script writes `public/models/placeschema/garments/`:
- `<kit>_<piece>.glb`: 19 garments, about 45 KB each.
- `provenance.json`: each file's source nodes, author, source and licence.
- `sidecar-looks.json`: the WoC sidecar's `SIDECAR_LOOKS`, one `armor.woc.<id>` per item that has a garment.
- `sidecar-open-looks.txt`: its `SIDECAR_OPEN_LOOKS`, every garment URL. They are CC0, so the sidecar may stamp them into grants as `render-asset:`.

Re-run the script when the armor catalog or the modular body changes. Set the two sidecar variables from the last two files, with `--origin` matching where the WoC client serves `public/`.
