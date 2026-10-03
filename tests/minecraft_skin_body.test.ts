// PLACE-480: the Minecraft skin's boxes ride the WoC bones and pivot at the joints; the hand slots
// (where WoC attaches weapons) move to the arm boxes' hands.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  MC_HAND_TAG,
  MC_SKIN_TAG,
  wearMinecraftSkin,
} from '../src/render/characters/minecraft_skin_body';

// A T-posed rig facing +Z, feet at y=0: hips 0.5, neck 1.2, shoulders at x=+-0.3, hands at x=+-0.8.
function rig() {
  const root = new THREE.Group();
  const bone = (name: string, parent: THREE.Object3D, x: number, y: number) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, 0);
    parent.add(b);
    return b;
  };
  const hips = bone('hips', root, 0, 0.5);
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

const box = (root: THREE.Object3D, bone: string) =>
  root.getObjectByName(bone)?.children.find((c) => c.userData[MC_SKIN_TAG]) as THREE.Mesh;

function ends(m: THREE.Mesh) {
  m.updateMatrixWorld(true);
  const g = m.geometry as THREE.BoxGeometry;
  const h = g.parameters.height / 2;
  return [0, h, -h].map((y) => new THREE.Vector3(0, y, 0).applyMatrix4(m.matrixWorld));
}

describe('wearMinecraftSkin', () => {
  it('parents each box to its bone with the arm hanging from the shoulder to the hand', () => {
    const root = rig();
    const added = wearMinecraftSkin(root, 2, new THREE.Texture(), false);
    expect(added).toHaveLength(6);
    for (const b of ['head', 'chest', 'upperarml', 'upperarmr', 'upperlegl', 'upperlegr'])
      expect(box(root, b.replace(/(arm|leg)([lr])$/, '$1.$2'))).toBeTruthy();
    const [, top, bottom] = ends(box(root, 'upperarm.l'));
    expect(top.distanceTo(new THREE.Vector3(0.3, 1.1, 0))).toBeLessThan(1e-6); // the shoulder
    expect(bottom.distanceTo(new THREE.Vector3(0.8, 1.1, 0))).toBeLessThan(1e-6); // the hand
  });

  it('hangs the legs from the hips to the feet and seats the head on the neck', () => {
    const root = rig();
    wearMinecraftSkin(root, 2, new THREE.Texture(), false);
    const [, top, bottom] = ends(box(root, 'upperleg.r'));
    expect(top.distanceTo(new THREE.Vector3(-0.15, 0.5, 0))).toBeLessThan(1e-6);
    expect(bottom.y).toBeCloseTo(0);
    const [, , neck] = ends(box(root, 'head'));
    expect(neck.y).toBeCloseTo(1.2);
  });

  it('moves the hand slots onto the arm boxes, keeping their grip, so a raised arm carries them', () => {
    const root = rig();
    wearMinecraftSkin(root, 2, new THREE.Texture(), false);
    const slot = root.getObjectByName('handslot.l') as THREE.Object3D;
    expect(slot.parent?.userData[MC_HAND_TAG]).toBe(true);
    expect(slot.parent?.parent?.name).toBe('upperarm.l');
    expect(
      slot.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(0.85, 1.1, 0)),
    ).toBeLessThan(1e-6);
    // swing the shoulder: the slot stays at the box's hand end
    const arm = root.getObjectByName('upperarm.l') as THREE.Object3D;
    arm.rotation.z = -Math.PI / 2;
    root.updateMatrixWorld(true);
    const [, , hand] = ends(box(root, 'upperarm.l'));
    expect(slot.getWorldPosition(new THREE.Vector3()).distanceTo(hand)).toBeCloseTo(0.05);
    // a skin change keeps the slot on the rig
    wearMinecraftSkin(root, 2, new THREE.Texture(), true);
    expect(root.getObjectByName('handslot.l')?.parent?.userData[MC_HAND_TAG]).toBe(true);
  });
});
