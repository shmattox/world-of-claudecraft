// A carried item's own mesh, served to WoC clients from the PlaceSchema sidecar (PLACE-410).
// The sidecar's GET /media/<name> is content-addressed and sends no CORS header, so the game server
// passes those bytes through on its own origin. Off (404) unless the sidecar is configured.

import type { Ctx, RouteDef } from './http/types';

const NAME = /^ps_[0-9a-f]{32}\.(glb|png|jpg|jpeg|webp|ktx2)$/; // open-place tools/look-plan names
const MAX_BYTES = 16 * 1024 * 1024;

async function mediaHandler(ctx: Ctx): Promise<void> {
  const name = String(ctx.params.name ?? '');
  const base = process.env.PLACESCHEMA_SIDECAR_URL?.replace(/\/$/, '');
  const r =
    base && NAME.test(name)
      ? await fetch(`${base}/media/${name}`, { signal: AbortSignal.timeout(10_000) }).catch(
          () => undefined,
        )
      : undefined;
  const bytes = r?.ok ? Buffer.from(await r.arrayBuffer()) : undefined;
  if (!bytes || bytes.length > MAX_BYTES) {
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
