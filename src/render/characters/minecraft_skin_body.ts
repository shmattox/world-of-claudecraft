// A Minecraft skin worn on a WoC rig (PLACE-410, rigged in PLACE-480), on a true Minecraft body
// (PLACE-946): six boxes UV-mapped to the standard skin layout, sized and placed as Minecraft's
// player model is (32 skin pixels tall: legs 12, torso 12, head 8; arms 12 from the shoulder),
// scaled to the character's height. WoC's rigs are chibi (big head, short legs), so a box can't
// pivot on its WoC bone's joint: each rides a "shadow" of its bone, a node at the Minecraft joint
// (hip, shoulder, neck, waist) that copies the bone's live rotation every frame, so every WoC
// animation still drives it. Each limb keeps the direction its bone had in the rig's BIND pose, so
// the boxes stay posed however the rig was authored. The hand slots WoC attaches weapons to
// (handslot.r/l) move onto each arm box's hand, so the existing attachment system holds the sword
// and shield there. The rig's own body meshes are hidden while it is worn (held props stay). A
// legacy 64x32 skin has no left-limb rows: its left arm and leg reuse the right ones.
// ponytail: limbs are one rigid box per bone (no elbow/knee bend) and the outer overlay layer is
// not drawn; add them if a skin reads wrong in the walk.

import * as THREE from 'three';
import {
  avatarChoice,
  type CarriedSkin,
  carriedSkin,
  carriedSkinFor,
  placeSchemaLinked,
} from '../../placeschema_skin_state';

type Limb = {
  bone: string;
  /** the joint the box ends at (a hand bone, or the feet when null) */
  end: string[] | null;
  /** hand slot to move onto the box's far end */
  slot?: string;
  arm: boolean;
  uv: [number, number];
};

const limbs = (legacy: boolean): Limb[] => [
  { bone: 'upperarmr', end: ['handr', 'wristr'], slot: 'handslotr', arm: true, uv: [40, 16] },
  {
    bone: 'upperarml',
    end: ['handl', 'wristl'],
    slot: 'handslotl',
    arm: true,
    uv: legacy ? [40, 16] : [32, 48],
  },
  { bone: 'upperlegr', end: null, arm: false, uv: [0, 16] },
  { bone: 'upperlegl', end: null, arm: false, uv: legacy ? [0, 16] : [16, 48] },
];

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
export const MC_HAND_TAG = 'placeschemaMinecraftHand';
export const MC_SHADOW_TAG = 'placeschemaMinecraftShadow';
const MC_HIDDEN = 'placeschemaMinecraftHidden';

/** What a hand anchor needs to put its slot back where it was. */
type HandRestore = {
  slot: THREE.Object3D;
  parent: THREE.Object3D;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
};

/** Hide the rig's own body: every mesh that is not a held prop or one of our boxes. Re-run each
 *  frame the skin is worn (other systems may reset visibility). */
export function hideRigBody(root: THREE.Object3D): void {
  if (!root.userData[MC_HIDDEN]) root.userData[MC_HIDDEN] = new Set<THREE.Object3D>();
  const hidden = root.userData[MC_HIDDEN] as Set<THREE.Object3D>;
  root.traverse((o) => {
    if (
      (o as THREE.Mesh).isMesh &&
      !o.userData.weaponMesh &&
      !o.userData[MC_SKIN_TAG] &&
      o.visible
    ) {
      o.visible = false;
      hidden.add(o);
    }
  });
}

/** Take the skin off: dispose and remove its boxes, put each hand slot back on its own parent with
 *  its own grip, and show the rig's body again. */
export function removeMinecraftSkin(root: THREE.Object3D): void {
  const boxes: THREE.Mesh[] = [];
  const hands: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.userData[MC_SKIN_TAG] && (o as THREE.Mesh).isMesh) boxes.push(o as THREE.Mesh);
    if (o.userData[MC_HAND_TAG]) hands.push(o);
  });
  const materials = new Set<THREE.Material>();
  for (const b of boxes) {
    b.geometry.dispose();
    materials.add(b.material as THREE.Material);
    b.removeFromParent();
  }
  for (const m of materials) m.dispose();
  for (const h of hands) {
    const { slot, parent, position, quaternion, scale } = h.userData[MC_HAND_TAG] as HandRestore;
    parent.add(slot);
    slot.position.copy(position);
    slot.quaternion.copy(quaternion);
    slot.scale.copy(scale);
    h.removeFromParent();
  }
  const shadows: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.userData[MC_SHADOW_TAG]) shadows.push(o);
  });
  for (const o of shadows) o.removeFromParent();
  for (const o of (root.userData[MC_HIDDEN] as Set<THREE.Object3D> | undefined) ?? [])
    o.visible = true;
  delete root.userData[MC_HIDDEN];
  delete root.userData[MC_SKIN_TAG];
}

const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();

/**
 * Pose `mesh` (a box `px` skin pixels tall along its Y) in world space: centre `centre`, its +Y
 * along `up`, its front (+Z) as close to `forward` as `up` allows; `unit` world units per pixel
 * across, stretched to `length` world units along Y. Exported for the tests.
 */
export function poseBox(
  mesh: THREE.Object3D,
  centre: THREE.Vector3,
  up: THREE.Vector3,
  forward: THREE.Vector3,
  unit: number,
  px: number,
  length: number,
): void {
  _y.copy(up).normalize();
  _z.copy(forward).addScaledVector(_y, -forward.dot(_y)).normalize();
  _x.crossVectors(_y, _z);
  mesh.quaternion.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
  mesh.position.copy(centre);
  mesh.scale.set(unit, length / px, unit);
}

/** A node's world matrix in the rig's bind pose (its rest), placed where the skeleton's top bone
 *  is now. Bind transforms are taken relative to that bone (boneInverses), so a rig whose mesh
 *  bind matrix lives in another frame still lines up. Nodes outside the skeleton (hand slots)
 *  follow their parent. */
function bindPose(root: THREE.Object3D): (o: THREE.Object3D) => THREE.Matrix4 {
  let skeleton: THREE.Skeleton | undefined;
  root.traverse((o) => {
    if (!skeleton && (o as THREE.SkinnedMesh).isSkinnedMesh)
      skeleton = (o as THREE.SkinnedMesh).skeleton;
  });
  root.updateMatrixWorld(true);
  const bones = skeleton?.bones ?? [];
  // each bone's bind pose is placed by the top bone of its own chain
  const baseOf = (b: THREE.Object3D): THREE.Matrix4 | null => {
    let top = b;
    while ((top.parent as THREE.Bone | null)?.isBone) top = top.parent as THREE.Object3D;
    const t = bones.indexOf(top as THREE.Bone);
    return skeleton && t >= 0 ? top.matrixWorld.clone().multiply(skeleton.boneInverses[t]) : null;
  };
  const at = (o: THREE.Object3D): THREE.Matrix4 => {
    const i = bones.indexOf(o as THREE.Bone);
    const base = i >= 0 ? baseOf(o) : null;
    if (skeleton && base) return base.multiply(skeleton.boneInverses[i].clone().invert());
    return o.parent && o.parent !== root ? at(o.parent).multiply(o.matrix) : o.matrixWorld.clone();
  };
  return at;
}

/**
 * Wear a skin texture on the rig under `root` (character height `height` world units, pivot at the
 * feet). Returns the boxes added, or [] if the rig has none of the expected bones.
 */
export function wearMinecraftSkin(
  root: THREE.Object3D,
  height: number,
  texture: THREE.Texture,
  slim: boolean,
  textureHeight = 64,
): THREE.Mesh[] {
  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 1, alphaTest: 0.5 });
  const added: THREE.Mesh[] = [];
  const box = (size: [number, number, number], uv: [number, number]) => {
    const mesh = new THREE.Mesh(skinBoxGeometry(size, uv, textureHeight), material);
    mesh.userData[MC_SKIN_TAG] = true;
    added.push(mesh);
    return mesh;
  };
  const bind = bindPose(root);
  const pos = (o: THREE.Object3D) => new THREE.Vector3().setFromMatrixPosition(bind(o));
  const feet = pos(root);
  const up = new THREE.Vector3(0, 1, 0).transformDirection(root.matrixWorld);
  // the rig's own facing: its left hip minus its right, crossed with up; and its left
  const [hipR, hipL] = ['upperlegr', 'upperlegl'].map((n) => find(root, [n]));
  const fwd =
    hipR && hipL
      ? pos(hipL).sub(pos(hipR)).cross(up).normalize()
      : new THREE.Vector3(0, 0, 1).transformDirection(root.matrixWorld);
  const left = new THREE.Vector3().crossVectors(up, fwd);
  // one skin pixel: Minecraft's player is 32 pixels tall
  const u = height / 32;
  /** a point on the Minecraft body, `h` pixels up and `side` pixels to the wearer's left */
  const at = (h: number, side = 0) =>
    feet
      .clone()
      .addScaledVector(up, h * u)
      .addScaledVector(left, side * u);
  /** A node at `joint` that turns as `bone` does. It hangs from the shadow of the nearest ancestor
   *  that has one (head and arms ride the torso's, so a turning chest carries them together) and
   *  copies, every frame, the rotation of each bone from there down to `bone`; with no shadowed
   *  ancestor it sits beside the bone. Returns it with its bind-pose world matrix. */
  const shadows = new Map<THREE.Object3D, { s: THREE.Object3D; world: THREE.Matrix4 }>();
  const shadow = (bone: THREE.Object3D, joint: THREE.Vector3) => {
    const world = bind(bone).clone().setPosition(joint);
    const chain = [bone];
    let above = bone.parent;
    while (above && above !== root && !shadows.has(above)) {
      chain.unshift(above);
      above = above.parent;
    }
    const host = above ? shadows.get(above) : undefined;
    if (!host) chain.splice(0, chain.length - 1); // beside the bone: copy only its own turn
    const s = new THREE.Object3D();
    s.name = MC_SHADOW_TAG;
    s.userData[MC_SHADOW_TAG] = bone; // the bone it copies
    const parent = host?.s ?? bone.parent ?? root;
    (host ? host.world.clone() : bind(parent))
      .invert()
      .multiply(world)
      .decompose(s.position, s.quaternion, s.scale);
    s.updateMatrix = () => {
      s.quaternion.identity();
      for (const b of chain) s.quaternion.multiply(b.quaternion);
      THREE.Object3D.prototype.updateMatrix.call(s);
    };
    parent.add(s);
    const made = { s, world };
    shadows.set(bone, made);
    return made;
  };
  // parent `child` (posed in bind-pose world space) to the shadow, keeping that pose relative to it
  const ride = (on: { s: THREE.Object3D; world: THREE.Matrix4 }, child: THREE.Object3D) => {
    child.updateMatrix();
    on.world
      .clone()
      .invert()
      .multiply(child.matrix)
      .decompose(child.position, child.quaternion, child.scale);
    on.s.add(child);
  };
  // the torso first: the head and arms ride its shadow
  const chest = find(root, ['chest', 'spine']);
  if (chest) {
    const m = box([8, 12, 4], [16, 16]);
    poseBox(m, at(18), up, fwd, u, 12, 12 * u);
    ride(shadow(chest, at(12)), m);
  }
  const head = find(root, ['head']);
  if (head) {
    const m = box([8, 8, 8], [0, 0]);
    poseBox(m, at(28), up, fwd, u, 8, 8 * u);
    ride(shadow(head, at(24)), m);
  }
  for (const l of limbs(textureHeight === 32)) {
    const bone = find(root, [l.bone]);
    if (!bone) continue;
    const endBone = l.end ? find(root, l.end) : undefined;
    // the limb's bind-pose direction: toward the hand for an arm, straight down for a leg
    const along = endBone ? pos(endBone).sub(pos(bone)) : up.clone().negate();
    if (along.lengthSq() < 1e-12) continue;
    along.normalize();
    // an arm's centre line sits beside the torso (5.5 px for a slim 3-px arm), a leg's under the hip
    const side = (l.bone.endsWith('l') ? 1 : -1) * (l.arm ? (slim ? 5.5 : 6) : 2);
    // Minecraft's arm pivots 2 pixels below its shoulder top; a leg hangs from the hip
    const joint = l.arm ? at(22, side) : at(12, side);
    const reach = l.arm ? 10 : 12; // pivot to the box's far end
    const m = box([l.arm && slim ? 3 : 4, 12, 4], l.uv);
    poseBox(
      m,
      joint.clone().addScaledVector(along, (reach - 6) * u),
      along.clone().negate(),
      fwd,
      u,
      12,
      12 * u,
    );
    const on = shadow(bone, joint);
    ride(on, m);
    // the hand: the slot keeps its grip relative to the hand, which now sits at the box's end
    const slot = l.slot ? find(root, [l.slot]) : undefined;
    const holder = slot?.parent;
    if (slot && holder) {
      const restore = holder.userData[MC_HAND_TAG] as HandRestore | undefined;
      const hand = new THREE.Object3D();
      hand.name = MC_HAND_TAG;
      hand.userData[MC_HAND_TAG] = restore ?? {
        slot,
        parent: holder,
        position: slot.position.clone(),
        quaternion: slot.quaternion.clone(),
        scale: slot.scale.clone(),
      };
      const own = restore?.parent ?? holder;
      bind(own)
        .setPosition(joint.clone().addScaledVector(along, reach * u))
        .decompose(hand.position, hand.quaternion, hand.scale);
      ride(on, hand);
      const local = [slot.position.clone(), slot.quaternion.clone(), slot.scale.clone()] as const;
      hand.add(slot);
      slot.position.copy(local[0]);
      slot.quaternion.copy(local[1]);
      slot.scale.copy(local[2]);
      if (restore) holder.removeFromParent(); // a skin change: the old hand goes with its shadow
    }
  }
  return added;
}

const textures = new Map<string, THREE.Texture>();
/** PLACE-412: every player in view may wear a skin, so textures are kept per URL, oldest-out. */
export const SKIN_TEXTURE_CAP = 16;

/** One nearest-filtered texture per skin URL (the most recent SKIN_TEXTURE_CAP stay live). */
export function skinTexture(url: string): THREE.Texture {
  let t = textures.get(url);
  if (t) {
    textures.delete(url); // most recently used goes last
  } else {
    t = new THREE.TextureLoader().load(url);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.colorSpace = THREE.SRGBColorSpace;
    // ponytail: an evicted texture still on a rig re-uploads on its next use (three re-creates it)
    if (textures.size >= SKIN_TEXTURE_CAP) {
      const [oldest, old] = textures.entries().next().value as [string, THREE.Texture];
      textures.delete(oldest);
      old.dispose();
    }
  }
  textures.set(url, t);
  return t;
}

/** Per frame, for the local player's visual: wear the carried skin if one arrived (once per rig and
 *  skin; a rebuilt rig gets it again) and keep the rig's own body hidden under it; take it off again when the skin goes. */
export function wearCarriedSkin(
  root: THREE.Object3D,
  height: number,
  pid?: number,
  selfPid?: number,
): void {
  // PLACE-412: another player wears the skin the server sent for them; no pid (or ours) = our own
  const skin = pid === undefined || pid === selfPid ? ownSkin() : carriedSkinFor(pid);
  if (!skin) {
    if (root.userData[MC_SKIN_TAG]) removeMinecraftSkin(root);
    return;
  }
  if (root.userData[MC_SKIN_TAG] !== skin.url) {
    removeMinecraftSkin(root);
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
  if (import.meta.env.DEV) (globalThis as { __mcSkinRoot?: unknown }).__mcSkinRoot = root; // probes
}

/** PLACE-1018: the local player's body by their avatar choice: WoC's own (no skin), the carried
 *  Minecraft skin, or the generic black-and-white body (linked accounts only). */
export function ownSkin(): CarriedSkin | null {
  const choice = avatarChoice();
  if (choice === 'native') return null;
  if (choice === 'generic' && placeSchemaLinked() !== false) return genericSkin();
  return carriedSkin();
}

let generic: CarriedSkin | null | undefined;
/** PlaceSchema's generic body as a 64x64 Minecraft skin: a pale figure with a dark hairline on
 *  every face (the Forge mannequin's black-and-white look). Base layer only; the overlay stays
 *  transparent. Drawn once; null without a DOM (tests). */
export function genericSkin(): CarriedSkin | null {
  if (generic !== undefined) return generic;
  generic = null;
  if (typeof document === 'undefined') return generic;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  if (!g) return generic;
  // [x, y, w, h] of each base-layer face (classic layout): head, body, arms, legs
  const faces: [number, number, number, number][] = [];
  const box = (u: number, v: number, w: number, h: number, d: number) =>
    faces.push(
      [u + d, v, w, d],
      [u + d + w, v, w, d], // top, bottom
      [u, v + d, d, h],
      [u + d, v + d, w, h],
      [u + d + w, v + d, d, h],
      [u + 2 * d + w, v + d, w, h],
    );
  box(0, 0, 8, 8, 8); // head
  box(16, 16, 8, 12, 4); // body
  box(40, 16, 4, 12, 4); // right arm
  box(32, 48, 4, 12, 4); // left arm
  box(0, 16, 4, 12, 4); // right leg
  box(16, 48, 4, 12, 4); // left leg
  for (const [x, y, w, h] of faces) {
    g.fillStyle = '#1a1a1a';
    g.fillRect(x, y, w, h);
    g.fillStyle = '#ececec';
    g.fillRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));
  }
  generic = { url: c.toDataURL('image/png'), model: 'classic' };
  return generic;
}

/** A PNG data URL's pixel height, read from its IHDR (64, or 32 for a legacy skin). */
export function pngHeight(dataUrl: string): number {
  const bytes = atob(dataUrl.slice(dataUrl.indexOf(',') + 1, dataUrl.indexOf(',') + 33));
  const h = (bytes.charCodeAt(22) << 8) | bytes.charCodeAt(23);
  return h === 32 ? 32 : 64;
}
