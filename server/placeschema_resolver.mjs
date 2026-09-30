// The WoC IdentityResolver for the shared PlaceSchema sidecar (PLACE-276). The sidecar loads it:
//   node <open-place>/adapters/sidecar/dist/main.mjs --resolver server/placeschema_resolver.mjs
// It confirms that `<account id>@<realm host>` is a real account on THIS realm and returns its
// public name. Attested: the WoC server authenticated every login (spec/nostr.md section 11, `woc`).
// Reads DATABASE_URL and the realm host (the same rule as server/placeschema_sidecar.ts realmHostOf:
// one realm host per realm, never the loopback default outside development); reads only accounts.id
// and accounts.username.

import pg from 'pg';

/** This realm's host: the id suffix the server sends. Pinned equal to realmHostOf by test. */
export function realmHost(env) {
  const host =
    env.PLACESCHEMA_REALM_HOST ?? (env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).host : undefined);
  if (!host)
    throw new Error(
      "placeschema: set PLACESCHEMA_REALM_HOST (or PUBLIC_ORIGIN) to this realm's own host",
    );
  if (/^(127\.|localhost\b|\[::1\])/.test(host) && env.PLACESCHEMA_ALLOW_LOOPBACK !== '1')
    throw new Error(
      `placeschema: realm host ${host} is loopback; set PLACESCHEMA_ALLOW_LOOPBACK=1 for local development only`,
    );
  return host;
}
let REALM;
const ID = /^([1-9][0-9]{0,15})@(.+)$/;
let pool;

export const resolver = {
  platform: 'woc',
  attested: true,
  async profile(id) {
    REALM ??= realmHost(process.env);
    const m = ID.exec(id);
    if (!m || m[2] !== REALM) throw new Error('not an account on this realm');
    pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    const r = await pool.query('SELECT username FROM accounts WHERE id = $1', [Number(m[1])]);
    if (!r.rows.length) throw new Error('no such account');
    return { id, name: r.rows[0].username };
  },
};
export default resolver;
