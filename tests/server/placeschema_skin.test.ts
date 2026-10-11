// PLACE-410: the arriving player's carried skin, read from the sidecar (PLACE-1085: GET
// /v1/players/:id/skin, section 11 attested links only) and sent to the client as a PNG data URL.

import { describe, expect, it } from 'vitest';
import { sidecarSkin } from '../../server/placeschema_skin';
import { applyPlaceSchemaFrame } from '../../src/net/placeschema_frame';
import { carriedSkin, setCarriedSkin } from '../../src/placeschema_skin_state';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SIDE = { url: 'http://sidecar.test', token: 'tok' };
const PID = '7@woc.test';
const TEXTURE = 'https://textures.minecraft.net/texture/abc';
/** The sidecar answers the skin it read (or none); the texture host serves the PNG. Records each call. */
function world(skin: object | null, calls: { url: string; auth?: string }[] = []) {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
    if (url === `${SIDE.url}/v1/players/${encodeURIComponent(PID)}/skin`)
      return Response.json({ holder: 'h', platform: 'woc', platformId: PID, skin });
    if (url === TEXTURE) return new Response(PNG);
    return new Response('', { status: 404 });
  }) as typeof fetch;
}

describe('sidecarSkin (PLACE-1085)', () => {
  it("asks the sidecar with the game's bearer and wears the attested skin as a data URL", async () => {
    const calls: { url: string; auth?: string }[] = [];
    const skin = await sidecarSkin(SIDE, PID, world({ url: TEXTURE, model: 'slim' }, calls));
    expect(skin).toEqual({ url: `data:image/png;base64,${PNG.toString('base64')}`, model: 'slim' });
    expect(calls[0]).toEqual({
      url: `${SIDE.url}/v1/players/7%40woc.test/skin`,
      auth: 'Bearer tok',
    });
  });

  it('no attested skin (unattested or withdrawn link, default skin): nothing, WoC keeps its own body', async () => {
    expect(await sidecarSkin(SIDE, PID, world(null))).toBeUndefined();
  });

  it('refuses a texture that is not https or not a PNG, and a sidecar that errors', async () => {
    expect(
      await sidecarSkin(SIDE, PID, world({ url: 'http://textures.minecraft.net/texture/abc' })),
    ).toBeUndefined();
    expect(await sidecarSkin(SIDE, PID, world({ url: 'https://evil.test/x.png' }))).toBeUndefined();
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    expect(await sidecarSkin(SIDE, PID, down)).toBeUndefined();
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
