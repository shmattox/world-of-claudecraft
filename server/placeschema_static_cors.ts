// PlaceSchema fork (PLACE-776): other worlds draw a carried WoC weapon from WoC's own mesh, so the
// static weapon models are readable cross-origin, and (PLACE-490) the armor garments extracted for
// other worlds. Only those folders: the rest of the static site keeps its same-origin default.
// `urlPath` is the already-normalized path serveStatic resolves.
const OPEN = ['/models/weapons/', '/placeschema/garments/'];
export function placeschemaStaticCors(urlPath: string): Record<string, string> {
  return OPEN.some((dir) => urlPath.startsWith(dir)) ? { 'Access-Control-Allow-Origin': '*' } : {};
}
