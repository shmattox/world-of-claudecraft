// PLACE-412: the Minecraft link behind a shown skin is read as open-place spec/nostr.md section 11
// requires: world-attested, signed by the attesting origin's live owner, declared, not withdrawn.

import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';
import { describe, expect, it } from 'vitest';
import {
  attestedMinecraftUuid,
  type LinkFilter,
  manifestFacts,
  type NostrEvent,
  type OriginFacts,
} from '../../server/placeschema_links';

const key = (n: number) => new Uint8Array(32).fill(n);
const pub = (k: Uint8Array) => Buffer.from(schnorr.getPublicKey(k)).toString('hex');
function sign(kind: number, tags: string[][], created_at: number, k: Uint8Array): NostrEvent {
  const ev = { pubkey: pub(k), created_at, kind, tags, content: '' };
  const id = createHash('sha256')
    .update(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))
    .digest('hex');
  return { ...ev, id, sig: Buffer.from(schnorr.sign(id, k)).toString('hex') };
}

const HOLDER = key(7);
const WORLD = key(3);
const holder = pub(HOLDER);
const owner = pub(WORLD);
const UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
const MC = 'https://mc.test';
const D = ['d', 'placeschema.links'];
const declared: OriginFacts = { owner, platform: { platform: 'minecraft', attested: true } };

function attest(o: { id?: string; p?: string; u?: string; at?: number; by?: Uint8Array } = {}) {
  const tags = [
    ['platform', 'minecraft'],
    ['id', o.id ?? UUID],
    ['p', o.p ?? holder],
    ['u', o.u ?? MC],
  ];
  return sign(22251, tags, o.at ?? 90, o.by ?? WORLD);
}
function record(att?: NostrEvent | string, at = 100, extra: string[][] = []) {
  const json = att === undefined ? [] : [typeof att === 'string' ? att : JSON.stringify(att)];
  return sign(30082, [D, ['link', 'minecraft', UUID, ...json], ...extra], at, HOLDER);
}

function read(
  rec: NostrEvent,
  o: { facts?: OriginFacts; deletions?: NostrEvent[]; withdrawals?: NostrEvent[] } = {},
) {
  const facts = 'facts' in o ? o.facts : declared;
  return attestedMinecraftUuid(holder, {
    now: 200,
    query: async (f: LinkFilter) => {
      if (f.kinds[0] === 30082) return [rec];
      return f['#a'] ? (o.deletions ?? []) : (o.withdrawals ?? []);
    },
    originFacts: async (u) => (u === MC ? facts : undefined),
  });
}

describe('attestedMinecraftUuid (spec/nostr.md section 11)', () => {
  it('shows a link the attesting origin owner signed and declared', async () => {
    expect(await read(record(attest()))).toBe(UUID);
  });

  it('refuses an entry with no attestation, a malformed one, or a broken signature', async () => {
    expect(await read(record())).toBeUndefined(); // attestation-required
    expect(await read(record('{not json'))).toBeUndefined(); // attestation-malformed
    const forged = { ...attest(), sig: 'a'.repeat(128) };
    expect(await read(record(forged))).toBeUndefined(); // attestation-signature
  });

  it('refuses a mismatched, stale, or self-made attestation', async () => {
    expect(await read(record(attest({ p: pub(key(9)) })))).toBeUndefined(); // another holder
    expect(await read(record(attest({ u: 'https://mc.test/' })))).toBeUndefined(); // not canonical
    expect(await read(record(attest({ at: 150 })))).toBeUndefined(); // attestation-stale
    expect(await read(record(attest({ by: key(9) })))).toBeUndefined(); // attestation-signer
  });

  it('refuses when the origin is unreachable, declares no minecraft, or does not attest it', async () => {
    expect(await read(record(attest()), { facts: undefined })).toBeUndefined();
    expect(await read(record(attest()), { facts: { owner } })).toBeUndefined();
    const unattested = { owner, platform: { platform: 'minecraft', attested: false } };
    expect(await read(record(attest()), { facts: unattested })).toBeUndefined();
  });

  it('refuses a link the world withdrew, or a record the holder deleted', async () => {
    const att = attest();
    const withdrawal = sign(5, [['e', att.id]], 120, WORLD);
    expect(await read(record(att), { withdrawals: [withdrawal] })).toBeUndefined();
    const deletion = sign(5, [['a', `30082:${holder}:placeschema.links`]], 120, HOLDER);
    expect(await read(record(att), { deletions: [deletion] })).toBeUndefined();
  });

  it('refuses a duplicated entry and a non-UUID id', async () => {
    const att = JSON.stringify(attest());
    expect(await read(record(att, 100, [['link', 'minecraft', UUID, att]]))).toBeUndefined();
    const notch = JSON.stringify(attest({ id: 'Notch' }));
    expect(
      await read(sign(30082, [D, ['link', 'minecraft', 'Notch', notch]], 100, HOLDER)),
    ).toBeUndefined();
  });
});

describe('manifestFacts', () => {
  it('fetches only a named https origin, and loopback only when allowed', async () => {
    const fetched: string[] = [];
    const f = (async (u: string) => {
      fetched.push(u);
      return Response.json({ owner, platform: { platform: 'minecraft', attested: true } });
    }) as typeof fetch;
    expect(await manifestFacts(false, f)('https://mc.test')).toEqual(declared);
    expect(await manifestFacts(false, f)('http://mc.test')).toBeUndefined();
    expect(await manifestFacts(false, f)('https://10.0.0.1')).toBeUndefined();
    expect(await manifestFacts(false, f)('http://127.0.0.1:8790')).toBeUndefined();
    expect(await manifestFacts(true, f)('http://127.0.0.1:8790')).toEqual(declared);
    expect(fetched).toEqual([
      'https://mc.test/.well-known/placeschema.json',
      'http://127.0.0.1:8790/.well-known/placeschema.json',
    ]);
  });
});
