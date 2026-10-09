// PLACE-480 / PLACE-946: the Minecraft skin is a true Minecraft body (32 pixels tall: legs 12, torso
// 12, head 8) at the character's height, whose boxes pivot at Minecraft's joints on shadows of the
// WoC bones; the hand slots (where WoC attaches weapons) move to the arm boxes' hands.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  hideRigBody,
  MC_HAND_TAG,
  MC_SHADOW_TAG,
  MC_SKIN_TAG,
  removeMinecraftSkin,
  wearMinecraftSkin,
} from '../src/render/characters/minecraft_skin_body';

// A T-posed rig facing +Z, feet at y=0: hips 0.5, neck 1.2, shoulders at x=+-0.3, hands at x=+-0.8.
function rig(facing = 0) {
  const root = new THREE.Group();
  const bone = (name: string, parent: THREE.Object3D, x: number, y: number) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, 0);
    parent.add(b);
    return b;
  };
  const hips = bone('hips', root, 0, 0.5);
  hips.rotation.y = facing; // the rig's own facing, independent of the root
  const chest = bone('chest', hips, 0, 0.3);
  const head = bone('head', chest, 0, 0.4);
  const bones = [hips, chest, head];
  for (const [s, x] of [
    ['l', 1],
    ['r', -1],
  ] as const) {
    const arm = bone(`upperarm.${s}`, chest, 0.3 * x, 0.3);
    const hand = bone(`hand.${s}`, arm, 0.5 * x, 0);
    bone(`handslot.${s}`, hand, 0.05 * x, 0);
    bones.push(arm, hand, bone(`upperleg.${s}`, hips, 0.15 * x, 0));
  }
  const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  return root;
}

// the box riding `bone`'s shadow (the node that turns as the bone does, at the Minecraft joint)
const box = (root: THREE.Object3D, bone: string) => {
  const b = root.getObjectByName(bone);
  let shadow: THREE.Object3D | undefined;
  root.traverse((c) => {
    if (b && c.userData[MC_SHADOW_TAG] === b) shadow = c;
  });
  return shadow?.children.find((c) => c.userData[MC_SKIN_TAG]) as THREE.Mesh;
};
const U = 2 / 32; // one skin pixel on a 2-unit-tall character

function ends(m: THREE.Mesh) {
  m.updateWorldMatrix(true, false); // through its shadow, whose matrix is not computed yet
  const g = m.geometry as THREE.BoxGeometry;
  const h = g.parameters.height / 2;
  return [0, h, -h].map((y) => new THREE.Vector3(0, y, 0).applyMatrix4(m.matrixWorld));
}

describe('wearMinecraftSkin', () => {
  it('builds a Minecraft-proportioned body at the character height, not the rig proportions', () => {
    const root = rig();
    const added = wearMinecraftSkin(root, 2, new THREE.Texture(), false);
    expect(added).toHaveLength(6);
    for (const b of ['head', 'chest', 'upperarm.l', 'upperarm.r', 'upperleg.l', 'upperleg.r'])
      expect(box(root, b)).toBeTruthy();
    const [, headTop, neck] = ends(box(root, 'head'));
    expect(headTop.y).toBeCloseTo(32 * U);
    expect(neck.y).toBeCloseTo(24 * U);
    const [, waistTop, waist] = ends(box(root, 'chest'));
    expect(waistTop.y).toBeCloseTo(24 * U);
    expect(waist.y).toBeCloseTo(12 * U);
    const [, hip, foot] = ends(box(root, 'upperleg.r'));
    expect(hip.distanceTo(new THREE.Vector3(-2 * U, 12 * U, 0))).toBeLessThan(1e-6);
    expect(foot.y).toBeCloseTo(0);
  });

  it('keeps each arm in its bind direction, hanging from the Minecraft shoulder', () => {
    const root = rig(); // T-posed: the left arm points along +X
    wearMinecraftSkin(root, 2, new THREE.Texture(), false);
    const [, top, bottom] = ends(box(root, 'upperarm.l'));
    expect(top.distanceTo(new THREE.Vector3(4 * U, 22 * U, 0))).toBeLessThan(1e-6);
    expect(bottom.distanceTo(new THREE.Vector3(16 * U, 22 * U, 0))).toBeLessThan(1e-6);
  });

  it('moves the hand slots onto the arm boxes, keeping their grip, so a raised arm carries them', () => {
    const root = rig();
    wearMinecraftSkin(root, 2, new THREE.Texture(), false);
    const slot = root.getObjectByName('handslot.l') as THREE.Object3D;
    expect(slot.parent?.userData[MC_HAND_TAG]).toBeTruthy();
    expect(slot.parent?.parent?.userData[MC_SHADOW_TAG]).toBeTruthy();
    expect(
      slot
        .getWorldPosition(new THREE.Vector3())
        .distanceTo(new THREE.Vector3(16 * U + 0.05, 22 * U, 0)),
    ).toBeLessThan(1e-6);
    // the animation turns the WoC bone: its shadow turns with it, about the Minecraft shoulder
    const arm = root.getObjectByName('upperarm.l') as THREE.Object3D;
    arm.rotation.z = -Math.PI / 2;
    root.updateMatrixWorld(true);
    const [, top, hand] = ends(box(root, 'upperarm.l'));
    expect(top.distanceTo(new THREE.Vector3(6 * U, 24 * U, 0))).toBeLessThan(1e-6);
    expect(hand.distanceTo(new THREE.Vector3(6 * U, 12 * U, 0))).toBeLessThan(1e-6);
    expect(slot.getWorldPosition(new THREE.Vector3()).distanceTo(hand)).toBeCloseTo(0.05);
    // a skin change keeps the slot on the rig
    wearMinecraftSkin(root, 2, new THREE.Texture(), true);
    expect(root.getObjectByName('handslot.l')?.parent?.userData[MC_HAND_TAG]).toBeTruthy();
  });

  it('a turning chest carries the head and arms with the torso, joined at the neck and shoulders', () => {
    const root = rig();
    wearMinecraftSkin(root, 2, new THREE.Texture(), false);
    const chest = root.getObjectByName('chest') as THREE.Object3D;
    chest.rotation.z = 0.6; // a lean
    root.updateMatrixWorld(true);
    const [, torsoTop] = ends(box(root, 'chest'));
    const [, , neck] = ends(box(root, 'head'));
    expect(neck.distanceTo(torsoTop)).toBeLessThan(1e-6);
    // the arm's pivot keeps its place on the torso: 2 px below the shoulder line, 6 px out
    const arm = box(root, 'upperarm.l');
    const torso = box(root, 'chest');
    const local = arm.parent!.getWorldPosition(new THREE.Vector3());
    torso.worldToLocal(local);
    expect(local.x).toBeCloseTo(6); // in the torso's own skin pixels
    expect(local.y).toBeCloseTo(4);
  });

  it('slim arms sit against the torso', () => {
    const root = rig();
    wearMinecraftSkin(root, 2, new THREE.Texture(), true);
    const arm = box(root, 'upperarm.r');
    const [mid] = ends(arm); // T-posed: the arm's centre is 4 px out from its pivot
    expect(Math.abs(mid.x)).toBeCloseTo(5.5 * U + 4 * U);
  });

  it('faces the boxes the way the rig faces, not the root', () => {
    const root = rig(Math.PI / 2); // an X-facing rig
    wearMinecraftSkin(root, 2, new THREE.Texture(), false);
    root.updateMatrixWorld(true);
    const head = box(root, 'head');
    const front = new THREE.Vector3(0, 0, 1).transformDirection(head.matrixWorld);
    expect(front.x).toBeCloseTo(1);
    const [, top] = ends(box(root, 'upperarm.l'));
    expect(top.distanceTo(new THREE.Vector3(0, 22 * U, -4 * U))).toBeLessThan(1e-6);
  });

  it('comes off cleanly: boxes disposed, slots back on their hands, the body shown again', () => {
    const root = rig();
    const body = root.children.find((c) => (c as THREE.SkinnedMesh).isSkinnedMesh) as THREE.Mesh;
    const slot = root.getObjectByName('handslot.r') as THREE.Object3D;
    const grip = slot.position.clone();
    const boxes = wearMinecraftSkin(root, 2, new THREE.Texture(), false);
    root.userData[MC_SKIN_TAG] = 'skin';
    hideRigBody(root);
    expect(body.visible).toBe(false);
    const disposed: string[] = [];
    boxes[0].geometry.addEventListener('dispose', () => disposed.push('geometry'));
    (boxes[0].material as THREE.Material).addEventListener('dispose', () =>
      disposed.push('material'),
    );
    removeMinecraftSkin(root);
    expect(disposed).toEqual(['geometry', 'material']);
    let left = 0;
    root.traverse((o) => {
      if (o.userData[MC_SKIN_TAG] || o.userData[MC_HAND_TAG] || o.userData[MC_SHADOW_TAG]) left++;
    });
    expect(left).toBe(0);
    expect(root.userData[MC_SKIN_TAG]).toBeUndefined();
    expect(body.visible).toBe(true);
    expect(slot.parent?.name).toBe('hand.r');
    expect(slot.position.equals(grip)).toBe(true);
  });
});
