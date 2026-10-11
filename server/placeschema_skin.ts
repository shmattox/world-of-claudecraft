// The arriving player's carried skin (PLACE-410), read from the sidecar (PLACE-1085).
//
// The sidecar answers `GET /v1/players/:platformId/skin` (open-place PLACE-1042) with the linked
// holder's carried skin: section 11 attested links only, withdrawals honoured, the skin re-checked. WoC
// no longer reads the links itself. The texture travels to the player's own client as a PNG data URL and
// is forgotten with the session; nothing is stored.

import { readCapped } from './placeschema_media';

export interface Skin {
  /** data:image/png;base64,... */
  url: string;
  model: 'classic' | 'slim';
}

const MAX_PNG = 64 * 1024;
const MAX_ANSWER = 16 * 1024;

/** A skin texture URL to the PNG data URL the client wears, or undefined (not https, not a PNG, too big,
 *  unreachable). */
export async function skinPng(
  url: string,
  model: 'classic' | 'slim',
  f: typeof fetch = fetch,
): Promise<Skin | undefined> {
  if (!/^https:\/\//.test(url)) return undefined;
  const png = await f(url, { signal: AbortSignal.timeout(5_000) });
  const bytes = png.ok ? await readCapped(png, MAX_PNG) : undefined;
  if (!bytes || bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) return undefined;
  return { url: `data:image/png;base64,${bytes.toString('base64')}`, model };
}

/** A game account's carried skin, as its sidecar reads it, or undefined (unlinked, no attested skin,
 *  default skin, sidecar or texture unreachable). */
export async function sidecarSkin(
  sidecar: { url: string; token: string },
  platformId: string,
  f: typeof fetch = fetch,
): Promise<Skin | undefined> {
  const r = await f(`${sidecar.url}/v1/players/${encodeURIComponent(platformId)}/skin`, {
    headers: { authorization: `Bearer ${sidecar.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const body = r.ok ? await readCapped(r, MAX_ANSWER) : undefined;
  if (!body) return undefined;
  const skin = (JSON.parse(body.toString('utf8')) as { skin?: { url?: unknown; model?: unknown } })
    .skin;
  if (!skin || typeof skin.url !== 'string') return undefined;
  return skinPng(skin.url, skin.model === 'slim' ? 'slim' : 'classic', f);
}
