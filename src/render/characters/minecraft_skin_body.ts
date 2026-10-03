// A Minecraft skin worn on a WoC rig (PLACE-410, rigged properly in PLACE-480). Six boxes,
// UV-mapped to the standard skin layout, each parented to its WoC bone (head, chest, upper arms,
// upper legs) so every WoC animation drives them, and placed from the rig's BIND pose so each box
// pivots at its joint: an arm hangs from its shoulder to its hand, a leg from its hip to the feet,
// the head sits on the neck, the torso spans hips to neck. Widths keep Minecraft proportions on a
// unit fitted to the WoC body (the torso spans its hips to its neck; the head grows up to 1.5x
// toward the room above the neck, since WoC's rigs are big-headed). The hand
// slots WoC attaches weapons to (handslot.r/l) move onto each arm box's hand, so the existing
// attachment system holds the sword and shield there. The rig's own body meshes are hidden while
// it is worn (held props stay). A legacy 64x32 skin has no left-limb rows: its left arm and leg
// reuse the right ones.
// ponytail: limbs are one rigid box per bone (no elbow/knee bend) and the outer overlay layer is
// not drawn; add them if a skin reads wrong in the walk.

import * as THREE from 'three';
import { carriedSkin } from '../../placeschema_skin_state';

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

/** Hide the rig's own body: every mesh that is not a held prop or one of our boxes. Re-run each
 *  frame the skin is worn (other systems may reset visibility). */
export function hideRigBody(root: THREE.Object3D): void {
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !o.userData.weaponMesh && !o.userData[MC_SKIN_TAG])
      o.visible = false;
  });
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
  const top = bones.findIndex((b) => !(b.parent as THREE.Bone | null)?.isBone);
  const base =
    skeleton && top >= 0
      ? bones[top].matrixWorld.clone().multiply(skeleton.boneInverses[top])
      : new THREE.Matrix4();
  const at = (o: THREE.Object3D): THREE.Matrix4 => {
    const i = bones.indexOf(o as THREE.Bone);
    if (skeleton && top >= 0 && i >= 0)
      return base.clone().multiply(skeleton.boneInverses[i].clone().invert());
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
  // parent `child` (posed in bind-pose world space) to `bone`, keeping that pose relative to it
  const ride = (bone: THREE.Object3D, child: THREE.Object3D) => {
    child.updateMatrix();
    bind(bone)
      .invert()
      .multiply(child.matrix)
      .decompose(child.position, child.quaternion, child.scale);
    bone.add(child);
  };
  {
    const head = find(root, ['head']);
    const chest = find(root, ['chest', 'spine']);
    const feet = pos(root);
    const up = new THREE.Vector3(0, 1, 0).transformDirection(root.matrixWorld);
    const lenOf = (v: THREE.Vector3) => v.clone().sub(feet).dot(up);
    const neck = head ? pos(head) : feet.clone().addScaledVector(up, height * 0.75);
    const neckY = lenOf(neck);
    const hips = limbs(false)
      .filter((l) => !l.arm)
      .map((l) => find(root, [l.bone]))
      .filter((b): b is THREE.Object3D => !!b);
    const hipY = hips.length
      ? hips.reduce((a, b) => a + lenOf(pos(b)), 0) / hips.length
      : neckY / 2;
    // the rig's own facing: its left hip minus its right, crossed with up
    const [hipR, hipL] = ['upperlegr', 'upperlegl'].map((n) => find(root, [n]));
    const fwd =
      hipR && hipL
        ? pos(hipL).sub(pos(hipR)).cross(up).normalize()
        : new THREE.Vector3(0, 0, 1).transformDirection(root.matrixWorld);
    // one skin pixel: the torso's 12 pixels span the rig's hips to its neck. The head may grow up
    // to 1.5x toward filling the room above the neck (WoC's rigs are big-headed).
    const unit = (neckY - hipY) / 12;
    const headUnit = Math.min(Math.max((height - neckY) / 8, unit), unit * 1.5);
    const centre = chest ? pos(chest) : neck.clone();
    centre.addScaledVector(up, (neckY + hipY) / 2 - lenOf(centre));
    if (head) {
      const m = box([8, 8, 8], [0, 0]);
      poseBox(
        m,
        neck.clone().addScaledVector(up, 4 * headUnit),
        up,
        fwd,
        headUnit,
        8,
        8 * headUnit,
      );
      ride(head, m);
    }
    if (chest) {
      const m = box([8, 12, 4], [16, 16]);
      poseBox(m, centre, up, fwd, unit, 12, neckY - hipY);
      ride(chest, m);
    }
    for (const l of limbs(textureHeight === 32)) {
      const bone = find(root, [l.bone]);
      if (!bone) continue;
      const joint = pos(bone);
      const endBone = l.end ? find(root, l.end) : undefined;
      // the far end: the hand for an arm, the ground under the hip for a leg
      const far = endBone ? pos(endBone) : joint.clone().addScaledVector(up, -lenOf(joint));
      const along = far.clone().sub(joint);
      const length = along.length();
      if (length < 1e-6) continue;
      const w = l.arm && slim ? 3 : 4;
      const m = box([w, 12, 4], l.uv);
      poseBox(
        m,
        joint.clone().addScaledVector(along, 0.5),
        along.clone().negate(),
        fwd,
        unit,
        12,
        length,
      );
      ride(bone, m);
      // the hand: the slot keeps its grip relative to the hand, which now sits at the box's end
      const slot = l.slot ? find(root, [l.slot]) : undefined;
      const holder = slot?.parent;
      if (slot && holder && !holder.userData[MC_HAND_TAG]) {
        // kept across skin changes (not tagged as a skin box), so the slot never leaves the rig
        const hand = new THREE.Object3D();
        hand.name = MC_HAND_TAG;
        hand.userData[MC_HAND_TAG] = true;
        bind(holder).decompose(hand.position, hand.quaternion, hand.scale);
        ride(bone, hand);
        const local = [slot.position.clone(), slot.quaternion.clone(), slot.scale.clone()] as const;
        hand.add(slot);
        slot.position.copy(local[0]);
        slot.quaternion.copy(local[1]);
        slot.scale.copy(local[2]);
      }
    }
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
  if (import.meta.env.DEV) (globalThis as { __mcSkinRoot?: unknown }).__mcSkinRoot = root; // probes
}

/** A PNG data URL's pixel height, read from its IHDR (64, or 32 for a legacy skin). */
export function pngHeight(dataUrl: string): number {
  const bytes = atob(dataUrl.slice(dataUrl.indexOf(',') + 1, dataUrl.indexOf(',') + 33));
  const h = (bytes.charCodeAt(22) << 8) | bytes.charCodeAt(23);
  return h === 32 ? 32 : 64;
}
