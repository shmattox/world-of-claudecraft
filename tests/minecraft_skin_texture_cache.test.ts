// @vitest-environment happy-dom
// PLACE-412: every player in view may wear a Minecraft skin, so textures are cached per URL and
// bounded (oldest out), never one global texture that a second player's skin would dispose.

import { describe, expect, it } from 'vitest';
import { SKIN_TEXTURE_CAP, skinTexture } from '../src/render/characters/minecraft_skin_body';

const url = (n: number) => `data:image/png;base64,${btoa(`skin-${n}`)}`;

describe('skinTexture (PLACE-412)', () => {
  it('A3: two players with two skins keep two live textures', () => {
    let disposed = 0;
    const a = skinTexture(url(1));
    const b = skinTexture(url(2));
    a.addEventListener('dispose', () => disposed++);
    b.addEventListener('dispose', () => disposed++);
    expect(a).not.toBe(b);
    expect(skinTexture(url(1))).toBe(a); // the same skin reuses its texture
    expect(disposed).toBe(0);
  });

  it(`keeps at most ${SKIN_TEXTURE_CAP}, disposing the least recently used`, () => {
    const first = skinTexture(url(100));
    let gone = false;
    first.addEventListener('dispose', () => {
      gone = true;
    });
    for (let n = 101; n < 101 + SKIN_TEXTURE_CAP; n++) skinTexture(url(n));
    expect(gone).toBe(true);
    expect(skinTexture(url(100 + SKIN_TEXTURE_CAP))).toBeDefined();
  });
});
