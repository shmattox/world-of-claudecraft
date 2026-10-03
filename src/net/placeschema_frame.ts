// The server's answer to a Carry click (server/placeschema_sidecar.ts, PLACE-276). `ticket`: the item
// is in escrow and the player walks through to the destination world's arrival page. `link`: this
// account has no PlaceSchema key yet, so the one-time link page opens beside the game. Refusals
// arrive as ordinary system notices. `skin` (PLACE-410): the arriving player's Minecraft skin, as a
// PNG data URL, for the renderer to wear. `status` (PLACE-479): whether the account is linked, for
// the bag's "Link PlaceSchema account" button.

import { setCarriedSkin, setPlaceSchemaLinked } from '../placeschema_skin_state';

const SAFE = /^https?:\/\//;
const SKIN = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

export interface PlaceSchemaFrame {
  kind?: unknown;
  url?: unknown;
  model?: unknown;
  linked?: unknown;
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
): 'ticket' | 'link' | 'skin' | 'status' | null {
  if (msg.kind === 'status') {
    if (typeof msg.linked !== 'boolean') return null;
    setPlaceSchemaLinked(msg.linked);
    return 'status';
  }
  if (msg.kind === 'skin') {
    if (typeof msg.url !== 'string' || msg.url.length > 200_000 || !SKIN.test(msg.url)) return null;
    setCarriedSkin({ url: msg.url, model: msg.model === 'slim' ? 'slim' : 'classic' });
    return 'skin';
  }
  const url = typeof msg.url === 'string' && SAFE.test(msg.url) ? msg.url : null;
  if (!url) return null;
  if (msg.kind === 'ticket') nav.assign(url);
  else if (msg.kind === 'link') nav.open(url);
  else return null;
  return msg.kind;
}
