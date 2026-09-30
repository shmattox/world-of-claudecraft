// The server's answer to a Carry click (server/placeschema_sidecar.ts, PLACE-276). `ticket`: the item
// is in escrow and the player walks through to the destination world's arrival page. `link`: this
// account has no PlaceSchema key yet, so the one-time link page opens beside the game. Refusals
// arrive as ordinary system notices.

const SAFE = /^https?:\/\//;

export interface PlaceSchemaFrame {
  kind?: unknown;
  url?: unknown;
}

export interface Nav {
  assign(url: string): void;
  open(url: string): void;
}

const browserNav: Nav = {
  assign: (url) => window.location.assign(url),
  open: (url) => void window.open(url, '_blank', 'noopener'),
};

export function applyPlaceSchemaFrame(
  msg: PlaceSchemaFrame,
  nav: Nav = browserNav,
): 'ticket' | 'link' | null {
  const url = typeof msg.url === 'string' && SAFE.test(msg.url) ? msg.url : null;
  if (!url) return null;
  if (msg.kind === 'ticket') nav.assign(url);
  else if (msg.kind === 'link') nav.open(url);
  else return null;
  return msg.kind;
}
