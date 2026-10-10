// PLACE-410: the arriving player's Minecraft skin, from the holder's signed 30082 links record and
// Mojang's live profile, to the client as a PNG data URL (never stored).

import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';
import { describe, expect, it } from 'vitest';
import { minecraftUuidOf, mojangSkin, skinForHolder } from '../../server/placeschema_skin';
import { applyPlaceSchemaFrame } from '../../src/net/placeschema_frame';
import { carriedSkin, setCarriedSkin } from '../../src/placeschema_skin_state';

const sk = new Uint8Array(32).fill(7);
const holder = Buffer.from(schnorr.getPublicKey(sk)).toString('hex');
const UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5';

function links(tags: string[][], created_at = 100, key = sk) {
  const pubkey = Buffer.from(schnorr.getPublicKey(key)).toString('hex');
  const ev = { pubkey, created_at, kind: 30082, tags, content: '' };
  const id = createHash('sha256')
    .update(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))
    .digest('hex');
  return { ...ev, id, sig: Buffer.from(schnorr.sign(id, key)).toString('hex') };
}
const D = ['d', 'placeschema.links'];

describe('minecraftUuidOf', () => {
  it("reads the minecraft link from the holder's newest signed record", () => {
    const old = links([D, ['link', 'minecraft', '00000000-0000-0000-0000-000000000000']], 50);
    const now = links([D, ['link', 'woc', '7@woc.test'], ['link', 'minecraft', UUID]]);
    expect(minecraftUuidOf([old, now], holder)).toBe(UUID);
  });

  it('ignores a forged signature, another author, and a malformed id', () => {
    const forged = { ...links([D, ['link', 'minecraft', UUID]]), sig: 'a'.repeat(128) };
    expect(minecraftUuidOf([forged], holder)).toBeUndefined();
    const other = links([D, ['link', 'minecraft', UUID]], 100, new Uint8Array(32).fill(9));
    expect(minecraftUuidOf([other], holder)).toBeUndefined();
    expect(minecraftUuidOf([links([D, ['link', 'minecraft', 'Notch']])], holder)).toBeUndefined();
  });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const mojang = (skin: object | null) =>
  (async (url: string) => {
    if (url.startsWith('https://sessionserver.mojang.com/'))
      return Response.json({
        properties: [
          {
            name: 'textures',
            value: Buffer.from(JSON.stringify({ textures: skin ? { SKIN: skin } : {} })).toString(
              'base64',
            ),
          },
        ],
      });
    if (url === 'https://textures.minecraft.net/texture/abc') return new Response(PNG);
    return new Response('', { status: 404 });
  }) as typeof fetch;

describe('mojangSkin', () => {
  it('fetches the skin PNG live as a data URL', async () => {
    const skin = await mojangSkin(
      UUID,
      mojang({ url: 'http://textures.minecraft.net/texture/abc', metadata: { model: 'slim' } }),
    );
    expect(skin).toEqual({ url: `data:image/png;base64,${PNG.toString('base64')}`, model: 'slim' });
  });

  it('gives nothing for the default skin or a texture off Mojang', async () => {
    expect(await mojangSkin(UUID, mojang(null))).toBeUndefined();
    expect(
      await mojangSkin(UUID, mojang({ url: 'https://evil.test/texture/abc' })),
    ).toBeUndefined();
  });

  it('skinForHolder: relay record -> uuid -> skin', async () => {
    const query = async () => [links([D, ['link', 'minecraft', UUID]])];
    const skin = await skinForHolder(holder, ['ws://relay.test'], {
      query,
      fetch: mojang({ url: 'https://textures.minecraft.net/texture/abc' }),
    });
    expect(skin?.model).toBe('classic');
  });
});

describe('the skin frame', () => {
  it('keeps a PNG data URL and refuses anything else', () => {
    setCarriedSkin(null);
    expect(applyPlaceSchemaFrame({ kind: 'skin', url: 'https://evil.test/a.png' })).toBeNull();
    expect(carriedSkin()).toBeNull();
    expect(
      applyPlaceSchemaFrame({ kind: 'skin', url: 'data:image/png;base64,iVBORw==', model: 'slim' }),
    ).toBe('skin');
    expect(carriedSkin()).toEqual({ url: 'data:image/png;base64,iVBORw==', model: 'slim' });
    setCarriedSkin(null);
  });
});

describe('the link status frame (PLACE-479)', () => {
  it('sets the link state the bag chip reads, and refuses a non-boolean', async () => {
    const { placeSchemaLinked, setPlaceSchemaLinked } = await import(
      '../../src/placeschema_skin_state'
    );
    const { placeSchemaLinkChipHtml } = await import('../../src/ui/woc_balance_chip');
    setPlaceSchemaLinked(null);
    expect(placeSchemaLinkChipHtml()).toBe(''); // no sidecar answer yet: no button
    expect(applyPlaceSchemaFrame({ kind: 'status', linked: 'yes' })).toBeNull();
    expect(placeSchemaLinked()).toBeNull();
    expect(applyPlaceSchemaFrame({ kind: 'status', linked: false })).toBe('status');
    expect(placeSchemaLinkChipHtml()).toContain('data-ps-link');
    expect(placeSchemaLinkChipHtml()).toContain('Link to carry items');
    expect(applyPlaceSchemaFrame({ kind: 'status', linked: true })).toBe('status');
    expect(placeSchemaLinkChipHtml()).toContain('Carrying items: linked');
    expect(placeSchemaLinkChipHtml()).not.toContain('data-ps-link');
    setPlaceSchemaLinked(null);
  });
});
