// PLACE-1129: the "PlaceSchema" body choice is PlaceSchema's own Avatar, the same file the Hub
// registers as Avatar (open-place assets/shared/models/avatar.vrm: the Quaternius Universal
// Animation Library mannequin, CC0, recoloured; served here as public/placeschema/bodies/avatar.glb).
// It is worn over a WoC rig the way the Minecraft body is: the rig keeps animating, hidden, and the
// Avatar follows it bone by bone. Each followed Avatar bone takes its WoC bone's rotation change since
// the BIND pose, applied to its own bind orientation, so the two rigs' different bone axes and mesh
// frames don't matter (both are bound in a T-pose). Bones with no WoC partner (clavicles, spine_02,
// neck, fingers) keep their rest pose under their parent. The hand slots WoC hangs weapons on move onto
// the Avatar's hands, carrying the same bind correction, so a sword sits in the Avatar's fist.
// ponytail: rotations only; the pelvis keeps its rest height (crouch and bob are not mirrored).

import * as THREE from 'three';
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

export const AVATAR_URL = '/placeschema/bodies/avatar.glb';
export const AVATAR_TAG = 'placeschemaAvatarBody';
const HIDDEN = 'placeschemaAvatarHidden';
const HAND = 'placeschemaAvatarHand';

/** Avatar (Quaternius UAL) bone -> the WoC (KayKit Rig_Medium) bone it follows, as three loads both. */
export const FOLLOWS: Readonly<Record<string, string>> = {
  pelvis: 'hips',
  spine_01: 'spine',
  spine_03: 'chest',
  Head: 'head',
  upperarm_l: 'upperarml',
  lowerarm_l: 'lowerarml',
  hand_l: 'handl',
  upperarm_r: 'upperarmr',
  lowerarm_r: 'lowerarmr',
  hand_r: 'handr',
  thigh_l: 'upperlegl',
  calf_l: 'lowerlegl',
  foot_l: 'footl',
  ball_l: 'toesl',
  thigh_r: 'upperlegr',
  calf_r: 'lowerlegr',
  foot_r: 'footr',
  ball_r: 'toesr',
};
const SLOTS: Readonly<Record<string, string>> = { handslotr: 'hand_r', handslotl: 'hand_l' };

type Pair = {
  src: THREE.Bone;
  dst: THREE.Bone;
  srcBind: THREE.Quaternion;
  dstBind: THREE.Quaternion;
};
type Worn = { body: THREE.Object3D; pairs: Pair[] };
type Restore = { slot: THREE.Object3D; parent: THREE.Object3D; local: THREE.Matrix4 };

let source: GLTF | null | undefined; // undefined: not asked yet; null: loading or failed
function avatar(): GLTF | null {
  if (source === undefined) {
    source = null;
    new GLTFLoader().load(
      AVATAR_URL,
      (g) => {
        source = g;
      },
      undefined,
      () => {
        source = null; // ponytail: no retry; the rig's own body stays
      },
    );
  }
  return source;
}

/** Whether the Avatar file is loaded, so the body can be worn this frame. */
export const placeSchemaAvatarReady = (): boolean => !!avatar();

function rigMesh(root: THREE.Object3D): THREE.SkinnedMesh | undefined {
  let found: THREE.SkinnedMesh | undefined;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!found && m.isSkinnedMesh && !o.userData[AVATAR_TAG] && m.skeleton.getBoneByName('hips'))
      found = m;
  });
  return found;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _r = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** A bone's bind-pose rotation in `root`'s frame, from its mesh's inverse bind matrix. */
function bindRotation(mesh: THREE.SkinnedMesh, bone: THREE.Bone, root: THREE.Object3D) {
  const i = mesh.skeleton.bones.indexOf(bone);
  _m.copy(root.matrixWorld)
    .invert()
    .multiply(mesh.matrixWorld)
    .multiply(mesh.bindMatrix)
    .multiply(_m.clone().copy(mesh.skeleton.boneInverses[i]).invert());
  _m.decompose(_p, _q, _s);
  return _q.clone();
}

/** A node's current rotation in `root`'s frame. */
function rotationIn(o: THREE.Object3D, root: THREE.Object3D, out: THREE.Quaternion) {
  root.getWorldQuaternion(_r).invert();
  return o.getWorldQuaternion(out).premultiply(_r);
}

/** Put the Avatar on `root` (a WoC character visual), scaled to `height`. False until it has loaded. */
export function wearPlaceSchemaAvatar(root: THREE.Object3D, height: number): boolean {
  if (root.userData[AVATAR_TAG]) return true;
  const g = avatar();
  const rig = g && rigMesh(root);
  if (!g || !rig) return false;
  const body = cloneSkinned(g.scene);
  body.userData[AVATAR_TAG] = true;
  body.traverse((o) => {
    o.userData[AVATAR_TAG] = true;
    o.frustumCulled = false;
  });
  root.add(body);
  root.updateMatrixWorld(true);
  const own = new THREE.Box3().setFromObject(body).getSize(_s).y;
  body.scale.setScalar(own > 0 ? height / (own / body.scale.y) : 1);
  root.updateMatrixWorld(true);
  let mesh: THREE.SkinnedMesh | undefined;
  body.traverse((o) => {
    if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
  });
  if (!mesh) {
    body.removeFromParent();
    return false;
  }
  const avatarMesh = mesh;
  const depth = (b: THREE.Object3D) => {
    let d = 0;
    for (let p = b.parent; p; p = p.parent) d++;
    return d;
  };
  const pairs: Pair[] = [];
  for (const [to, from] of Object.entries(FOLLOWS)) {
    const dst = avatarMesh.skeleton.getBoneByName(to);
    const src = rig.skeleton.getBoneByName(from);
    if (dst && src)
      pairs.push({
        src,
        dst,
        srcBind: bindRotation(rig, src, root),
        dstBind: bindRotation(avatarMesh, dst, root),
      });
  }
  pairs.sort((a, b) => depth(a.dst) - depth(b.dst)); // parents first
  // the hand slots ride the Avatar's hands, with the same bind correction as the hand bones
  for (const [slotName, handName] of Object.entries(SLOTS)) {
    const slot = rig.skeleton.getBoneByName(slotName) ?? root.getObjectByName(slotName);
    const pair = pairs.find((p) => p.dst.name === handName);
    if (!slot?.parent || !pair) continue;
    const anchor = new THREE.Object3D();
    anchor.name = HAND;
    anchor.userData[HAND] = { slot, parent: slot.parent, local: slot.matrix.clone() } as Restore;
    // the WoC hand's frame expressed in the Avatar hand's frame, at bind: slot grips keep their meaning
    anchor.quaternion.copy(pair.dstBind).invert().multiply(pair.srcBind);
    const srcScale = pair.src.getWorldScale(new THREE.Vector3());
    const dstScale = pair.dst.getWorldScale(new THREE.Vector3());
    anchor.scale.set(srcScale.x / dstScale.x, srcScale.y / dstScale.y, srcScale.z / dstScale.z);
    pair.dst.add(anchor);
    anchor.add(slot);
    slot.matrix.decompose(slot.position, slot.quaternion, slot.scale);
  }
  // the rig's own body hides (held props stay); the Avatar is drawn instead
  const hidden = new Set<THREE.Object3D>();
  root.traverse((o) => {
    if (
      (o as THREE.Mesh).isMesh &&
      !o.userData.weaponMesh &&
      !o.userData[AVATAR_TAG] &&
      o.visible
    ) {
      o.visible = false;
      hidden.add(o);
    }
  });
  root.userData[HIDDEN] = hidden;
  root.userData[AVATAR_TAG] = { body, pairs } satisfies Worn;
  followRig(root);
  return true;
}

/** Each frame, after WoC's animation: the Avatar's bones take their WoC bones' motion. */
export function followRig(root: THREE.Object3D): void {
  const worn = root.userData[AVATAR_TAG] as Worn | undefined;
  if (!worn || worn === (true as never)) return;
  root.updateMatrixWorld(true);
  const cur = new THREE.Quaternion();
  const parent = new THREE.Quaternion();
  for (const { src, dst, srcBind, dstBind } of worn.pairs) {
    // the WoC bone's change since bind, applied to the Avatar bone's bind orientation
    rotationIn(src, root, cur).multiply(_q.copy(srcBind).invert()).multiply(dstBind);
    if (dst.parent) rotationIn(dst.parent, root, parent);
    else parent.identity();
    dst.quaternion.copy(parent.invert().multiply(cur));
    dst.updateMatrixWorld(true);
  }
}

/** Take the Avatar off: its hands give the slots back, it goes, the rig's body shows again. */
export function removePlaceSchemaAvatar(root: THREE.Object3D): void {
  const worn = root.userData[AVATAR_TAG] as Worn | undefined;
  if (!worn) return;
  const anchors: THREE.Object3D[] = [];
  worn.body.traverse((o) => {
    if (o.userData[HAND]) anchors.push(o);
  });
  for (const a of anchors) {
    const { slot, parent, local } = a.userData[HAND] as Restore;
    parent.add(slot);
    local.decompose(slot.position, slot.quaternion, slot.scale);
  }
  worn.body.removeFromParent();
  for (const o of (root.userData[HIDDEN] as Set<THREE.Object3D> | undefined) ?? [])
    o.visible = true;
  delete root.userData[HIDDEN];
  delete root.userData[AVATAR_TAG];
}
