// The arriving player's Minecraft skin (PLACE-410, open-place spec 2026-10-02-woc-leg.md section 2).
//
// The sidecar's /mod/join names the holder did. Their linked accounts are one kind 30082 event on the
// relay (spec/nostr.md section 11); its world-attested `minecraft` entry (placeschema_links.ts, PLACE-412)
// is a Mojang UUID, whose skin comes live from
// Mojang's session server, as the open-place Minecraft resolver does. Never stored: the PNG travels
// to the player's own client as a data URL and is forgotten with the session.

import { WebSocket } from 'ws';
import {
  attestedMinecraftUuid,
  type LinkDeps,
  type LinkFilter,
  manifestFacts,
  type NostrEvent,
} from './placeschema_links';

export interface Skin {
  /** data:image/png;base64,... */
  url: string;
  model: 'classic' | 'slim';
}

const HEX64 = /^[0-9a-f]{64}$/;
const TEXTURE_URL = /^https?:\/\/textures\.minecraft\.net\/texture\/[0-9a-f]+$/;
const MAX_PNG = 64 * 1024;
const MAX_PROFILE = 64 * 1024;
const MAX_EVENTS = 16;

/** A response body read up to `max` bytes: undefined (and the stream cancelled) once it passes. */
export async function readCapped(r: Response, max: number): Promise<Buffer | undefined> {
  if (Number(r.headers.get('content-length') ?? 0) > max) {
    await r.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = r.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
}

/** One REQ to one relay, collected until EOSE or the timeout. */
export function queryRelay(
  url: string,
  filter: LinkFilter,
  timeoutMs = 5_000,
): Promise<NostrEvent[]> {
  return new Promise((resolve) => {
    const out: NostrEvent[] = [];
    let ws: WebSocket;
    const done = () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(out);
    };
    const timer = setTimeout(done, timeoutMs);
    try {
      ws = new WebSocket(url);
    } catch {
      return done();
    }
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'skin', { ...filter, limit: MAX_EVENTS }])));
    ws.on('message', (data) => {
      try {
        const m = JSON.parse(String(data));
        if (m[0] === 'EVENT' && m[1] === 'skin' && m[2] && typeof m[2] === 'object') {
          out.push(m[2]);
          if (out.length >= MAX_EVENTS) done(); // a relay that floods gets no more of our time
        } else if (m[0] === 'EOSE') done();
      } catch {}
    });
    ws.on('error', done);
    ws.on('close', done);
  });
}

/** The live Mojang skin for a UUID, or undefined for the default skin or any failure. */
export async function mojangSkin(uuid: string, f: typeof fetch = fetch): Promise<Skin | undefined> {
  const r = await f(
    `https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replace(/-/g, '')}`,
    { signal: AbortSignal.timeout(5_000) },
  );
  if (!r.ok) return undefined;
  const body = await readCapped(r, MAX_PROFILE);
  if (!body) return undefined;
  const profile = JSON.parse(body.toString('utf8')) as {
    properties?: { name: string; value: string }[];
  };
  const raw = profile.properties?.find((p) => p.name === 'textures')?.value;
  if (!raw) return undefined;
  const skin = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')).textures?.SKIN;
  if (!skin || typeof skin.url !== 'string' || !TEXTURE_URL.test(skin.url)) return undefined;
  const png = await f(skin.url.replace(/^http:/, 'https:'), { signal: AbortSignal.timeout(5_000) });
  const bytes = png.ok ? await readCapped(png, MAX_PNG) : undefined;
  if (!bytes || bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) return undefined;
  return {
    url: `data:image/png;base64,${bytes.toString('base64')}`,
    model: skin.metadata?.model === 'slim' ? 'slim' : 'classic',
  };
}

/** holder did -> their Minecraft skin, or undefined (no relay, no attested link, default skin, Mojang
 *  down). The link is read as spec/nostr.md section 11 requires (placeschema_links.ts): an unattested or
 *  withdrawn Minecraft link shows nothing. */
export async function skinForHolder(
  holder: string,
  relays: string[],
  deps: {
    query?: (url: string, filter: LinkFilter) => Promise<NostrEvent[]>;
    fetch?: typeof fetch;
    originFacts?: LinkDeps['originFacts'];
    allowLoopback?: boolean;
    now?: number;
  } = {},
): Promise<Skin | undefined> {
  if (!HEX64.test(holder) || !relays.length) return undefined;
  const query = deps.query ?? queryRelay;
  const uuid = await attestedMinecraftUuid(holder, {
    query: async (filter) => (await Promise.all(relays.map((u) => query(u, filter)))).flat(),
    originFacts: deps.originFacts ?? manifestFacts(deps.allowLoopback ?? false, deps.fetch),
    now: deps.now ?? Math.floor(Date.now() / 1000),
  });
  return uuid ? mojangSkin(uuid, deps.fetch).catch(() => undefined) : undefined;
}
