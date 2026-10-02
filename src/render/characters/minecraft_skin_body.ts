// A Minecraft skin worn on a WoC rig (PLACE-410). Six boxes in Minecraft proportions, UV-mapped to
// the standard skin layout, stand on the rig's feet (a Minecraft player is 32 skin pixels tall) and
// each rides the rig bone of its body part, so every WoC animation still drives them. The rig's own
// body meshes are hidden while it is worn (held props stay). A legacy 64x32 skin has no left-limb
// rows: its left arm and leg reuse the right ones.
// ponytail: limbs are one rigid box per bone (no elbow/knee bend), pivoting at the rig's joints, and
// the outer overlay layer is not drawn; add them if a skin reads wrong in the walk.

import * as THREE from 'three';
import { carriedSkin } from '../../placeschema_skin_state';

type Part = {
  /** the bone the box rides (first name the rig has) */
  bone: string[];
  size: [number, number, number]; // Minecraft pixels: width (x), height (y), depth (z)
  /** box centre in skin pixels from the feet; +x is the wearer's left */
  at: [number, number, number];
  uv: [number, number];
};

const parts = (slim: boolean, legacy: boolean): Part[] => {
  const arm = slim ? 3 : 4;
  const side = 4 + arm / 2;
  return [
    { bone: ['head'], size: [8, 8, 8], at: [0, 28, 0], uv: [0, 0] },
    { bone: ['chest', 'spine'], size: [8, 12, 4], at: [0, 18, 0], uv: [16, 16] },
    { bone: ['upperarmr'], size: [arm, 12, 4], at: [-side, 18, 0], uv: [40, 16] },
    {
      bone: ['upperarml'],
      size: [arm, 12, 4],
      at: [side, 18, 0],
      uv: legacy ? [40, 16] : [32, 48],
    },
    { bone: ['upperlegr'], size: [4, 12, 4], at: [-2, 6, 0], uv: [0, 16] },
    { bone: ['upperlegl'], size: [4, 12, 4], at: [2, 6, 0], uv: legacy ? [0, 16] : [16, 48] },
  ];
};

/** A box whose six faces sample the Minecraft layout at (u, v): +X is the wearer's left side. */
export function skinBoxGeometry(
  size: [number, number, number],
  uv: [number, number],
  textureHeight = 64,
) {
  const [w, h, d] = size;
  const [u, v] = uv;
  const g = new THREE.BoxGeometry(w, h, d);
  // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z; rects as [x0, y0, x1, y1] in skin pixels.
  const rects: [number, number, number, number][] = [
    [u + d + w, v + d, u + 2 * d + w, v + d + h], // left (+X)
    [u, v + d, u + d, v + d + h], // right (-X)
    [u + d, v, u + d + w, v + d], // top
    [u + d + w, v, u + d + 2 * w, v + d], // bottom
    [u + d, v + d, u + d + w, v + d + h], // front (+Z)
    [u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h], // back (-Z)
  ];
  const at = g.getAttribute('uv') as THREE.BufferAttribute;
  rects.forEach(([x0, y0, x1, y1], face) => {
    const corners = [
      [x0, y0],
      [x1, y0],
      [x0, y1],
      [x1, y1],
    ];
    corners.forEach(([x, y], i) => {
      at.setXY(face * 4 + i, x / 64, 1 - y / textureHeight);
    });
  });
  at.needsUpdate = true;
  return g;
}

const find = (root: THREE.Object3D, names: string[] | undefined) => {
  for (const n of names ?? []) {
    let hit: THREE.Object3D | undefined;
    root.traverse((o) => {
      if (!hit && o.name.replace(/[[\].:/_]/g, '').toLowerCase() === n) hit = o;
    });
    if (hit) return hit;
  }
  return undefined;
};

export const MC_SKIN_TAG = 'placeschemaMinecraftSkin';

/** Hide the rig's own body: every mesh that is not a held prop or one of our boxes. Re-run each
 *  frame the skin is worn (other systems may reset visibility). */
export function hideRigBody(root: THREE.Object3D): void {
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !o.userData.weaponMesh && !o.userData[MC_SKIN_TAG])
      o.visible = false;
  });
}

/**
 * Wear `skinUrl` on the rig under `root` (character height `height` world units, pivot at the
 * feet). Returns the boxes added, or [] if the rig has none of the expected bones.
 */
export function wearMinecraftSkin(
  root: THREE.Object3D,
  height: number,
  texture: THREE.Texture,
  slim: boolean,
  textureHeight = 64,
): THREE.Mesh[] {
  const unit = height / 32; // a Minecraft player is 32 skin pixels tall
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 1,
    alphaTest: 0.5,
  });
  root.updateMatrixWorld(true);
  const added: THREE.Mesh[] = [];
  for (const p of parts(slim, textureHeight === 32)) {
    const bone = find(root, p.bone);
    if (!bone) continue;
    const mesh = new THREE.Mesh(skinBoxGeometry(p.size, p.uv, textureHeight), material);
    mesh.userData[MC_SKIN_TAG] = true;
    mesh.scale.setScalar(unit);
    mesh.position.set(p.at[0] * unit, p.at[1] * unit, p.at[2] * unit);
    root.add(mesh);
    bone.attach(mesh); // keep this pose on the rig's feet, then ride the bone
    added.push(mesh);
  }
  return added;
}

const textures = new Map<string, THREE.Texture>();

/** One nearest-filtered texture per skin URL. */
export function skinTexture(url: string): THREE.Texture {
  let t = textures.get(url);
  if (!t) {
    t = new THREE.TextureLoader().load(url);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.colorSpace = THREE.SRGBColorSpace;
    textures.clear(); // ponytail: one skin per client (the local player's own)
    textures.set(url, t);
  }
  return t;
}

/** Per frame, for the local player's visual: wear the carried skin if one arrived (once per rig and
 *  skin; a rebuilt rig gets it again) and keep the rig's own body hidden under it. */
export function wearCarriedSkin(root: THREE.Object3D, height: number): void {
  const skin = carriedSkin();
  if (!skin) return;
  if (root.userData[MC_SKIN_TAG] !== skin.url) {
    const old: THREE.Object3D[] = [];
    root.traverse((o) => {
      if (o.userData[MC_SKIN_TAG]) old.push(o);
    });
    for (const o of old) o.removeFromParent();
    wearMinecraftSkin(
      root,
      height,
      skinTexture(skin.url),
      skin.model === 'slim',
      pngHeight(skin.url),
    );
    root.userData[MC_SKIN_TAG] = skin.url;
  }
  hideRigBody(root);
}

/** A PNG data URL's pixel height, read from its IHDR (64, or 32 for a legacy skin). */
export function pngHeight(dataUrl: string): number {
  const bytes = atob(dataUrl.slice(dataUrl.indexOf(',') + 1, dataUrl.indexOf(',') + 33));
  const h = (bytes.charCodeAt(22) << 8) | bytes.charCodeAt(23);
  return h === 32 ? 32 : 64;
}
