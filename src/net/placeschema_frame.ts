// The server's answer to a carry (server/placeschema_sidecar.ts, PLACE-276). `ticket`: the items are
// in escrow and the player has walked through the portal (PLACE-954): the game hands off, opening the
// destination's arrival page and closing this tab. `link`: this
// account has no PlaceSchema key yet, so the one-time link page opens beside the game. Refusals
// arrive as ordinary system notices. `skin` (PLACE-410): the arriving player's Minecraft skin, as a
// PNG data URL, for the renderer to wear. `status` (PLACE-479): whether the account is linked, for
// the bag's "Link PlaceSchema account" button.

import {
  clearPeerSkins,
  menuTier,
  setCarriedSkin,
  setPeerSkin,
  setPlaceSchemaHolder,
  setPlaceSchemaLinked,
  setPlaceSchemaMenuTier,
  setPortalDestinationPicture,
} from '../placeschema_skin_state';

const SAFE = /^https?:\/\//;
const SKIN = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

export interface PlaceSchemaFrame {
  kind?: unknown;
  url?: unknown;
  model?: unknown;
  linked?: unknown;
  /** PLACE-1018: the linked holder's key (hex), and the realm's menu tier */
  holder?: unknown;
  menu?: unknown;
  /** PLACE-412: another player's skin, by entity id */
  pid?: unknown;
}

export interface Nav {
  /** leave the game for `url` */
  leave(url: string): void;
  open(url: string): void;
}

const browserNav: Nav = {
  // Opened from a world's door (PLACE-941): the destination opens in that world's tab and this one
  // closes. Opened any other way, a script can't close the tab, so it becomes the destination.
  leave: (url) => {
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.location.href = url;
        window.opener.focus?.();
        window.close();
        return;
      }
    } catch {
      /* an opener we may not navigate: leave from this tab */
    }
    window.location.assign(url);
  },
  open: (url) => void window.open(url, '_blank', 'noopener'),
};

export function applyPlaceSchemaFrame(
  msg: PlaceSchemaFrame,
  nav: Nav = browserNav,
  ownPid?: number,
): 'ticket' | 'link' | 'skin' | 'skins' | 'status' | 'portal' | null {
  if (msg.kind === 'skins') {
    clearPeerSkins(); // PLACE-412: a new connection; the server sends the current ones next
    return 'skins';
  }
  if (msg.kind === 'status') {
    if (typeof msg.linked !== 'boolean') return null;
    if (msg.menu !== undefined) setPlaceSchemaMenuTier(menuTier(msg.menu));
    setPlaceSchemaLinked(msg.linked);
    // an unlinked status forgets the holder; a linked one without it (the link button) keeps it
    if (!msg.linked) setPlaceSchemaHolder(null);
    else if (typeof msg.holder === 'string' && /^[0-9a-f]{64}$/.test(msg.holder))
      setPlaceSchemaHolder(msg.holder);
    return 'status';
  }
  if (msg.kind === 'skin') {
    if (typeof msg.url !== 'string' || msg.url.length > 200_000 || !SKIN.test(msg.url)) return null;
    const worn = {
      url: msg.url,
      model: msg.model === 'slim' ? ('slim' as const) : ('classic' as const),
    };
    // PLACE-412: another player's skin goes to them; no pid (or our own) is ours, as before
    if (Number.isSafeInteger(msg.pid) && msg.pid !== ownPid) setPeerSkin(msg.pid as number, worn);
    else setCarriedSkin(worn);
    return 'skin';
  }
  const url = typeof msg.url === 'string' && SAFE.test(msg.url) ? msg.url : null;
  if (!url) return null;
  if (msg.kind === 'portal') {
    // PLACE-954: the destination's picture for the portal; the server checked it is the
    // destination's own
    if (url.length > 2048) return null;
    setPortalDestinationPicture(url);
    return 'portal';
  }
  if (msg.kind === 'ticket') nav.leave(url);
  else if (msg.kind === 'link') nav.open(url);
  else return null;
  return msg.kind;
}
