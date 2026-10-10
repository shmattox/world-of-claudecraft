// PLACE-490: WoC's armor as standalone garment GLBs, for other PlaceSchema worlds to wear, plus the
// WoC sidecar's look config for them.
//
// The armor pieces live inside the project-built modular body
// (public/models/chars/modular/warrior_modular.glb). That file also holds the body, hair and faces and
// has no CREDITS.md row, so it is never served whole: this keeps only the `Armor_<kit>_<part>` nodes
// of one kit's one piece, with the skeleton they are skinned to (KayKit Character Pack Adventures 1.0,
// CC0 1.0), and writes into public/placeschema/garments/:
//   <kit>_<piece>.glb        one garment per kit and piece the kit has
//   provenance.json          each file's source nodes, author, source url and licence
//   sidecar-looks.json       SIDECAR_LOOKS: {"armor.woc.<id>": "<origin>/models/.../<file>"}
//   sidecar-open-looks.txt   SIDECAR_OPEN_LOOKS: every garment url (CC0, open to every world)
// Textures are written as PNG: the source's KTX2 needs a transcoder that deployed PlaceSchema worlds'
// CSP blocks (world-kit enables it in dev only), so a KTX2 garment would show its stand-in there.
// The mapping (armor type -> kit, slot -> piece) is server/placeschema_garments.ts.
// Run: npx tsx scripts/assets/placeschema_garments.ts [--origin https://woc.placeschema.com]

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import {
  ARMOR_TYPE_KIT,
  GARMENT_DIR,
  garmentFile,
  ITEM_SLOT_PIECE,
  PIECE_PARTS,
} from '../../server/placeschema_garments';
import { ITEMS } from '../../src/sim/data';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'public/models/chars/modular/warrior_modular.glb');
const OUT = path.join(ROOT, 'public', GARMENT_DIR);
const at = process.argv.indexOf('--origin');
const ORIGIN = (at > 0 ? process.argv[at + 1] : 'https://woc.placeschema.com').replace(/\/$/, '');

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

// three's Basis transcoder (an Emscripten script that expects CommonJS), to decode KTX2 to RGBA
const require = createRequire(import.meta.url);
const basisDir = path.dirname(require.resolve('three/examples/jsm/libs/basis/basis_transcoder.js'));
const loadBasis = new Function(
  'require',
  '__dirname',
  `${fs.readFileSync(path.join(basisDir, 'basis_transcoder.js'), 'utf8')}; return BASIS;`,
)(require, basisDir);
const basis = await loadBasis({
  wasmBinary: fs.readFileSync(path.join(basisDir, 'basis_transcoder.wasm')),
});
basis.initializeBasis();
const RGBA32 = 13; // basis TranscoderTextureFormat.cTFRGBA32
async function ktx2ToPng(bytes: Uint8Array): Promise<Uint8Array> {
  const k = new basis.KTX2File(bytes);
  try {
    const [width, height] = [k.getWidth(), k.getHeight()];
    if (!k.startTranscoding()) throw new Error('KTX2 transcode refused');
    const rgba = new Uint8Array(k.getImageTranscodedSizeInBytes(0, 0, 0, RGBA32));
    if (!k.transcodeImage(rgba, 0, 0, 0, RGBA32, 0, -1, -1))
      throw new Error('KTX2 transcode failed');
    return new Uint8Array(
      await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer(),
    );
  } finally {
    k.close();
    k.delete();
  }
}

fs.mkdirSync(OUT, { recursive: true });
const provenance: Record<string, unknown> = {};
for (const kit of new Set(Object.values(ARMOR_TYPE_KIT))) {
  for (const piece of new Set(Object.values(ITEM_SLOT_PIECE))) {
    if (!piece) continue;
    const keep = new Set(PIECE_PARTS[piece].map((p) => `Armor_${kit}_${p}`));
    const doc = await io.read(SRC); // a fresh copy per garment: prune works in place
    const root = doc.getRoot();
    let kept = 0;
    for (const node of root.listNodes()) {
      if (!node.getMesh()) continue;
      if (keep.has(node.getName())) kept++;
      else node.setMesh(null).setSkin(null);
    }
    if (!kept) continue; // this kit has no piece here
    for (const a of root.listAnimations()) a.dispose(); // the wearer's rig animates it
    // prune drops the body, hair and other kits. ~1200 accessors of the dropped face morph targets
    // survive it in memory and only show as orphans once written and read back, so the garment is
    // round-tripped once and pruned again before it is packed.
    await doc.transform(prune());
    const again = await io.readBinary(await io.writeBinary(doc));
    await again.transform(prune(), dedup(), meshopt({ encoder: MeshoptEncoder }));
    for (const tex of again.getRoot().listTextures()) {
      if (tex.getMimeType() !== 'image/ktx2') continue;
      tex.setImage(await ktx2ToPng(tex.getImage()!)).setMimeType('image/png');
      tex.setURI(tex.getURI().replace(/\.ktx2$/, '.png'));
    }
    for (const e of again.getRoot().listExtensionsUsed())
      if (e.extensionName === 'KHR_texture_basisu') e.dispose();
    const file = `${kit}_${piece}.glb`;
    await io.write(path.join(OUT, file), again);
    provenance[file] = {
      kit,
      piece,
      nodes: [...keep].filter((n) =>
        doc
          .getRoot()
          .listNodes()
          .some((x) => x.getName() === n),
      ),
      author: 'Kay Lousberg (KayKit)',
      source: 'KayKit Character Pack Adventures 1.0',
      sourceUrl: 'https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0',
      licence: 'CC0-1.0',
      extractedFrom: 'public/models/chars/modular/warrior_modular.glb (armor nodes only)',
      kitFor: Object.entries(ARMOR_TYPE_KIT)
        .filter(([, k]) => k === kit)
        .map(([type]) => type),
    };
  }
}

const written = new Set(Object.keys(provenance));
const looks: Record<string, string> = {};
for (const [id, def] of Object.entries(ITEMS)) {
  const file = garmentFile(def as never, (f) => written.has(f));
  if (file) looks[`armor.woc.${id}`] = `${ORIGIN}/${GARMENT_DIR}/${file}`;
}
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
fs.writeFileSync(path.join(OUT, 'provenance.json'), json(provenance));
fs.writeFileSync(path.join(OUT, 'sidecar-looks.json'), `${JSON.stringify(looks)}\n`);
fs.writeFileSync(
  path.join(OUT, 'sidecar-open-looks.txt'),
  `${[...written].map((f) => `${ORIGIN}/${GARMENT_DIR}/${f}`).join(',')}\n`,
);
console.log(`${written.size} garments, ${Object.keys(looks).length} armor looks`);
