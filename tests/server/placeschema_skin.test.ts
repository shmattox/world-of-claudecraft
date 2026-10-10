// PLACE-410: the arriving player's Minecraft skin, from the holder's signed 30082 links record and
// Mojang's live profile, to the client as a PNG data URL (never stored).

import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';
import { describe, expect, it } from 'vitest';
import { mojangSkin, skinForHolder } from '../../server/placeschema_skin';
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
function sign(kind: number, tags: string[][], created_at: number, key: Uint8Array) {
  const pubkey = Buffer.from(schnorr.getPublicKey(key)).toString('hex');
  const ev = { pubkey, created_at, kind, tags, content: '' };
  const id = createHash('sha256')
    .update(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))
    .digest('hex');
  return { ...ev, id, sig: Buffer.from(schnorr.sign(id, key)).toString('hex') };
}

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

  it('skinForHolder: an attested link -> uuid -> skin; an unattested one -> nothing (PLACE-412)', async () => {
    const world = new Uint8Array(32).fill(3);
    const owner = Buffer.from(schnorr.getPublicKey(world)).toString('hex');
    const tags = [
      ['platform', 'minecraft'],
      ['id', UUID],
      ['p', holder],
      ['u', 'https://mc.test'],
    ];
    const att = sign(22251, tags, 90, world);
    const originFacts = async () => ({
      owner,
      platform: { platform: 'minecraft', attested: true },
    });
    const fetchSkin = mojang({ url: 'https://textures.minecraft.net/texture/abc' });
    const attested = links([D, ['link', 'minecraft', UUID, JSON.stringify(att)]]);
    const deps = (rec: object) => ({
      query: async (_u: string, f: { kinds: number[] }) => (f.kinds[0] === 30082 ? [rec] : []),
      fetch: fetchSkin,
      originFacts,
      now: 200,
    });
    const skin = await skinForHolder(holder, ['ws://relay.test'], deps(attested) as never);
    expect(skin?.model).toBe('classic');
    const bare = links([D, ['link', 'minecraft', UUID]]);
    expect(await skinForHolder(holder, ['ws://relay.test'], deps(bare) as never)).toBeUndefined();
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

describe('the carried skin, remembered per WoC account for char-select (PLACE-955)', () => {
  it('char-select restores this account skin, and never another account skin', async () => {
    const { restoreCarriedSkin } = await import('../../src/placeschema_skin_state');
    const store = new Map<string, string>();
    const ls = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    try {
      const as = (username: string) => ls.setItem('woc_session', JSON.stringify({ username }));
      as('alex');
      setCarriedSkin({ url: 'data:image/png;base64,AAAA', model: 'slim' });
      setCarriedSkin(null); // a fresh page: nothing in memory
      restoreCarriedSkin();
      expect(carriedSkin()).toEqual({ url: 'data:image/png;base64,AAAA', model: 'slim' });
      as('sam'); // another account in the same browser
      restoreCarriedSkin();
      expect(carriedSkin()).toBeNull();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
      setCarriedSkin(null);
    }
  });
});

describe('the ticket frame (PLACE-954)', () => {
  it('leaves the game for the destination, and refuses a non-http url', () => {
    const left: string[] = [];
    const nav = { leave: (u: string) => left.push(u), open: () => undefined };
    expect(applyPlaceSchemaFrame({ kind: 'ticket', url: 'javascript:alert(1)' }, nav)).toBeNull();
    expect(
      applyPlaceSchemaFrame({ kind: 'ticket', url: 'http://hub.test/arrive#ps-ticket=x' }, nav),
    ).toBe('ticket');
    expect(left).toEqual(['http://hub.test/arrive#ps-ticket=x']);
  });
});

describe('the portal frame (PLACE-954)', () => {
  it("keeps the destination's picture for the portal, and refuses a non-http url", async () => {
    const { portalDestinationPicture } = await import('../../src/placeschema_skin_state');
    expect(applyPlaceSchemaFrame({ kind: 'portal', url: 'javascript:alert(1)' })).toBeNull();
    expect(applyPlaceSchemaFrame({ kind: 'portal', url: 'https://hub.test/assets/p.jpg' })).toBe(
      'portal',
    );
    expect(portalDestinationPicture()).toBe('https://hub.test/assets/p.jpg');
  });

  it('PLACE-1026: keeps the destination name for the rim, alone or with the picture', async () => {
    const { portalDestinationName } = await import('../../src/placeschema_skin_state');
    expect(applyPlaceSchemaFrame({ kind: 'portal', name: '  The Forge ' })).toBe('portal');
    expect(portalDestinationName()).toBe('The Forge');
    expect(applyPlaceSchemaFrame({ kind: 'portal' })).toBeNull();
    expect(applyPlaceSchemaFrame({ kind: 'portal', url: 'javascript:x', name: 'Hub' })).toBeNull();
  });
});
