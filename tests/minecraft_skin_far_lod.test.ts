// PLACE-412: other players wear a carried Minecraft skin on their articulated rig, and the far LOD is
// WoC's baked body, so a skinned player stays articulated at a distance instead of turning back
// into a WoC character (the local player never took the far path).

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MC_SKIN_TAG } from '../src/render/characters/minecraft_skin_body';
import { CharacterVisual } from '../src/render/characters/visual';

// biome-ignore lint/suspicious/noExplicitAny: private-member access on the prototype fake
type AnyVisual = any;

function farVisual(skinned: boolean): AnyVisual {
  const fake: AnyVisual = Object.create(CharacterVisual.prototype);
  const root = new THREE.Group();
  if (skinned) root.userData[MC_SKIN_TAG] = 'data:image/png;base64,QUFB';
  Object.assign(fake, {
    root,
    far: true,
    farMesh: new THREE.Mesh(),
    farCompilePending: false,
    modelWrap: new THREE.Group(),
    shadowProxy: null,
    proxyShadowWanted: false,
  });
  return fake;
}

describe('far LOD and a carried Minecraft skin (PLACE-412)', () => {
  it('a skinned player stays articulated when far', () => {
    const v = farVisual(true);
    v.syncFarVisibility();
    expect(v.modelWrap.visible).toBe(true);
    expect(v.farMesh.visible).toBe(false);
  });

  it('an unskinned player still swaps to the far mesh', () => {
    const v = farVisual(false);
    v.syncFarVisibility();
    expect(v.modelWrap.visible).toBe(false);
    expect(v.farMesh.visible).toBe(true);
  });
});
