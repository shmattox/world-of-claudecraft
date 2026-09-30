// The WoC IdentityResolver for the shared PlaceSchema sidecar (PLACE-276). The sidecar loads it:
//   node <open-place>/adapters/sidecar/dist/main.mjs --resolver server/placeschema_resolver.mjs
// It confirms that `<account id>@<realm host>` is a real account on THIS realm and returns its
// public name. Attested: the WoC server authenticated every login (spec/nostr.md section 11, `woc`).
// Reads DATABASE_URL and PLACESCHEMA_REALM_HOST; reads only accounts.id and accounts.username.

import pg from 'pg';

const REALM = process.env.PLACESCHEMA_REALM_HOST ?? '127.0.0.1:5173';
const ID = /^([1-9][0-9]{0,15})@(.+)$/;
let pool;

export const resolver = {
  platform: 'woc',
  attested: true,
  async profile(id) {
    const m = ID.exec(id);
    if (!m || m[2] !== REALM) throw new Error('not an account on this realm');
    pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    const r = await pool.query('SELECT username FROM accounts WHERE id = $1', [Number(m[1])]);
    if (!r.rows.length) throw new Error('no such account');
    return { id, name: r.rows[0].username };
  },
};
export default resolver;
