// A carried item's own mesh, served to WoC clients from the PlaceSchema sidecar (PLACE-410).
// The sidecar's GET /media/<name> is content-addressed and sends no CORS header, so the game server
// passes those bytes through on its own origin. Off (404) unless the sidecar is configured.

import type { Ctx, RouteDef } from './http/types';
import { readCapped } from './placeschema_links';

const NAME = /^ps_[0-9a-f]{32}\.(glb|png|jpg|jpeg|webp|ktx2)$/; // open-place tools/look-plan names
const MAX_BYTES = 16 * 1024 * 1024;
/** Content-addressed, so a hit never goes stale. ponytail: wholesale reset past 64 MB; an LRU if
 *  hot meshes get refetched too often. */
const cache = new Map<string, Buffer>();
let cached = 0;

async function mediaHandler(ctx: Ctx): Promise<void> {
  const name = String(ctx.params.name ?? '');
  const base = process.env.PLACESCHEMA_SIDECAR_URL?.replace(/\/$/, '');
  let bytes = cache.get(name);
  if (!bytes && base && NAME.test(name)) {
    const r = await fetch(`${base}/media/${name}`, { signal: AbortSignal.timeout(10_000) }).catch(
      () => undefined,
    );
    // over the cap: refused from the header, or cut off while reading, never buffered whole
    bytes = r?.ok ? await readCapped(r, MAX_BYTES).catch(() => undefined) : undefined;
    if (bytes) {
      if (cached + bytes.length > 4 * MAX_BYTES) {
        cache.clear();
        cached = 0;
      }
      cache.set(name, bytes);
      cached += bytes.length;
    }
  }
  if (!bytes) {
    ctx.res.writeHead(404, { 'content-type': 'text/plain' }).end('no-such-media');
    return;
  }
  ctx.res
    .writeHead(200, {
      'content-type': name.endsWith('.glb') ? 'model/gltf-binary' : 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
    })
    .end(bytes);
}

export const routes: readonly RouteDef[] = [
  { method: 'GET', path: '/api/placeschema/media/:name', surface: 'api', handler: mediaHandler },
];
