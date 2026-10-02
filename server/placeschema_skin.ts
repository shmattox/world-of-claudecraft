// The arriving player's Minecraft skin (PLACE-410, open-place spec 2026-10-02-woc-leg.md section 2).
//
// The sidecar's /mod/join names the holder did. Their linked accounts are one kind 30082 event on the
// relay (spec/nostr.md section 11); its `minecraft` entry is a Mojang UUID, whose skin comes live from
// Mojang's session server, as the open-place Minecraft resolver does. Never stored: the PNG travels
// to the player's own client as a data URL and is forgotten with the session.

import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';
import { WebSocket } from 'ws';

type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export interface Skin {
  /** data:image/png;base64,... */
  url: string;
  model: 'classic' | 'slim';
}

const HEX64 = /^[0-9a-f]{64}$/;
const MC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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

/** A well-formed event the holder really signed (NIP-01 id + BIP-340 signature). */
export function signedBy(ev: NostrEvent, holder: string): boolean {
  try {
    if (ev.pubkey !== holder || !HEX64.test(ev.id)) return false;
    const id = createHash('sha256')
      .update(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))
      .digest('hex');
    return id === ev.id && schnorr.verify(ev.sig, id, ev.pubkey);
  } catch {
    return false;
  }
}

/** The holder's Minecraft UUID from their newest signed 30082 links record. Cosmetic use only:
 *  ponytail: the entry's world attestation is not checked (a skin is public anyway); check it with
 *  the sidecar's readLinks if a link here ever gates more than a look. */
export function minecraftUuidOf(events: NostrEvent[], holder: string): string | undefined {
  const newest = events
    .filter(
      (e) =>
        e.kind === 30082 &&
        e.tags.some((t) => t[0] === 'd' && t[1] === 'placeschema.links') &&
        signedBy(e, holder),
    )
    .sort((a, b) => b.created_at - a.created_at)[0];
  const id = newest?.tags.find((t) => t[0] === 'link' && t[1] === 'minecraft')?.[2];
  return id && MC_UUID.test(id) ? id : undefined;
}

/** One REQ to one relay, collected until EOSE or the timeout. */
export function queryRelay(url: string, holder: string, timeoutMs = 5_000): Promise<NostrEvent[]> {
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
    ws.on('open', () =>
      ws.send(
        JSON.stringify([
          'REQ',
          'skin',
          { kinds: [30082], authors: [holder], '#d': ['placeschema.links'], limit: 4 },
        ]),
      ),
    );
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

/** holder did -> their Minecraft skin, or undefined (no relay, no link, default skin, Mojang down). */
export async function skinForHolder(
  holder: string,
  relays: string[],
  deps: { query?: typeof queryRelay; fetch?: typeof fetch } = {},
): Promise<Skin | undefined> {
  if (!HEX64.test(holder)) return undefined;
  const query = deps.query ?? queryRelay;
  const events = (await Promise.all(relays.map((u) => query(u, holder)))).flat();
  const uuid = minecraftUuidOf(events, holder);
  return uuid ? mojangSkin(uuid, deps.fetch).catch(() => undefined) : undefined;
}
