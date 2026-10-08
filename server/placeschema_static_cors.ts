// PlaceSchema fork (PLACE-776): other worlds draw a carried WoC weapon from WoC's own mesh, so the
// static weapon models are readable cross-origin. Only that folder: the rest of the static site keeps
// its same-origin default. `urlPath` is the already-normalized path serveStatic resolves.
export function placeschemaStaticCors(urlPath: string): Record<string, string> {
  return urlPath.startsWith('/models/weapons/') ? { 'Access-Control-Allow-Origin': '*' } : {};
}
