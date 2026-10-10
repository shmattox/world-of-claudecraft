// PLACE-412: a holder's Minecraft link, read as open-place spec/nostr.md section 11 requires before it
// is shown: the holder's newest signed kind-30082 links record, its `minecraft` entry's kind-22251
// world attestation, checked against the attesting origin's live manifest owner and platform
// declaration, and neither the record deleted by the holder nor the attestation withdrawn by the world.
// A port of open-place pack/carry/src/linked-account.ts (readLinks / readHolderLinks), cut to the one
// entry the skin needs. The `minecraft` declaration's idPattern is the Mojang UUID, which MC_UUID
// enforces here (open-place mods/minecraft/platform.md).

import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';

export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};
export type LinkFilter = {
  kinds: number[];
  authors: string[];
  '#d'?: string[];
  '#a'?: string[];
  '#e'?: string[];
};
/** What an attesting origin's live manifest says: its owner key and its platform declaration. */
export type OriginFacts = { owner?: string; platform?: { platform?: unknown; attested?: unknown } };
export interface LinkDeps {
  /** one relay read (all relays merged); throws or returns [] when nobody answered */
  query(filter: LinkFilter): Promise<NostrEvent[]>;
  /** the origin's manifest facts, or undefined when unreachable */
  originFacts(origin: string): Promise<OriginFacts | undefined>;
  now: number;
}

const D = 'placeschema.links';
const HEX64 = /^[0-9a-f]{64}$/;
const MC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/;
const MAX_LINKS = 16;
const FUTURE_SKEW_SECONDS = 600;
const FACTS_TIMEOUT_MS = 5_000;

export const canonicalOrigin = (u: string | undefined): u is string =>
  !!u && ORIGIN.test(u) && !/^https:.*:443$|^http:.*:80$/.test(u);

/** NIP-01 id and BIP-340 signature of a well-formed event, by its own pubkey. */
export function verifies(e: NostrEvent): boolean {
  try {
    if (!HEX64.test(e.id) || !HEX64.test(e.pubkey) || !/^[0-9a-f]{128}$/.test(e.sig)) return false;
    const id = createHash('sha256')
      .update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))
      .digest('hex');
    return id === e.id && schnorr.verify(e.sig, id, e.pubkey);
  } catch {
    return false;
  }
}

const isEvent = (e: unknown): e is NostrEvent => {
  const v = e as NostrEvent;
  return (
    !!v &&
    typeof v === 'object' &&
    Number.isSafeInteger(v.created_at) &&
    typeof v.content === 'string' &&
    Array.isArray(v.tags) &&
    v.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))
  );
};
const one = (e: NostrEvent, name: string): string | undefined => {
  const t = e.tags.filter((x) => x[0] === name);
  return t.length === 1 && t[0].length === 2 ? t[0][1] : undefined;
};

/** The holder's attested Minecraft UUID, or undefined with nothing shown (section 11: a refused
 *  entry is never shown). Any read that goes unanswered shows nothing. */
export async function attestedMinecraftUuid(
  holder: string,
  d: LinkDeps,
): Promise<string | undefined> {
  if (!HEX64.test(holder)) return undefined;
  try {
    const records = (await d.query({ kinds: [30082], authors: [holder], '#d': [D] })).filter(
      (e) =>
        isEvent(e) &&
        e.kind === 30082 &&
        e.pubkey === holder &&
        one(e, 'd') === D &&
        e.content === '' &&
        verifies(e),
    );
    if (!records.length) return undefined;
    const record = records.reduce((a, b) => (b.created_at > a.created_at ? b : a));
    if (record.created_at > d.now + FUTURE_SKEW_SECONDS) return undefined;
    const address = `30082:${holder}:${D}`;
    const deletions = await d.query({ kinds: [5], authors: [holder], '#a': [address] });
    const deleted = deletions.some(
      (w) =>
        isEvent(w) &&
        w.kind === 5 &&
        w.pubkey === holder &&
        verifies(w) &&
        w.created_at >= record.created_at &&
        w.tags.some((t) => t[0] === 'a' && t[1] === address),
    );
    if (deleted) return undefined;
    const links = record.tags.filter((t) => t[0] === 'link');
    if (links.length > MAX_LINKS) return undefined;
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const [, p, id] of links) {
      const k = `${p}\n${id}`;
      if (seen.has(k)) dup.add(k);
      seen.add(k);
    }
    for (const [, platform, id, attJson, ...extra] of links) {
      if (platform !== 'minecraft' || typeof id !== 'string' || extra.length) continue;
      if (dup.has(`${platform}\n${id}`) || !MC_UUID.test(id)) continue; // duplicate / id-not-stable
      if (typeof attJson !== 'string') continue; // attestation-required: Minecraft is attested
      let att: unknown;
      try {
        att = JSON.parse(attJson);
      } catch {
        continue; // attestation-malformed
      }
      if (!isEvent(att) || att.kind !== 22251 || !verifies(att)) continue; // attestation-signature
      const u = one(att, 'u');
      if (
        one(att, 'platform') !== 'minecraft' ||
        one(att, 'id') !== id ||
        one(att, 'p') !== holder ||
        att.content !== '' ||
        !canonicalOrigin(u)
      )
        continue; // attestation-mismatch
      if (att.created_at > record.created_at) continue; // attestation-stale
      const facts = await withTimeout(d.originFacts(u));
      if (!facts?.owner) continue; // attestation-unverifiable
      if (facts.owner !== att.pubkey) continue; // attestation-signer
      if (facts.platform?.platform !== 'minecraft') continue; // platform-not-declared
      if (facts.platform.attested !== true) continue; // attestation-unexpected
      const withdrawn = (
        await d.query({ kinds: [5], authors: [facts.owner], '#e': [att.id] })
      ).some(
        (w) =>
          isEvent(w) &&
          w.kind === 5 &&
          w.pubkey === facts.owner &&
          verifies(w) &&
          w.created_at >= (att as NostrEvent).created_at &&
          w.tags.some((t) => t[0] === 'e' && t[1] === (att as NostrEvent).id),
      );
      if (withdrawn) continue; // revoked
      return id;
    }
    return undefined;
  } catch {
    return undefined; // an unanswered read shows nothing
  }
}

function withTimeout<T>(p: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.catch(() => undefined),
    new Promise<undefined>((res) => {
      timer = setTimeout(() => res(undefined), FACTS_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** An attesting origin's manifest, fetched as the sidecar does: no redirects, capped, timed out. The
 *  origin comes from a holder's own record, so only a named https host is fetched; loopback http only
 *  when the realm runs on loopback (PLACESCHEMA_ALLOW_LOOPBACK, local development). */
export function manifestFacts(allowLoopback: boolean, f: typeof fetch = fetch) {
  return async (origin: string): Promise<OriginFacts | undefined> => {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return undefined;
    }
    const loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
    const ipLiteral = /^[\d.]+$|^\[/.test(url.hostname);
    const ok = loopback
      ? allowLoopback
      : url.protocol === 'https:' && !ipLiteral && url.hostname.includes('.');
    // ponytail: a public name resolving to a private address is still fetched (fixed path, never
    // echoed; the sidecar accepts the same: a trusted origin's DNS is its owner's)
    if (!ok) return undefined;
    const r = await f(`${origin}/.well-known/placeschema.json`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FACTS_TIMEOUT_MS),
    });
    if (!r.ok) return undefined;
    const body = await readCapped(r, 256 * 1024); // never buffered past the cap
    if (!body) return undefined;
    const m = JSON.parse(body.toString('utf8')) as {
      owner?: unknown;
      platform?: OriginFacts['platform'];
    };
    return {
      owner: typeof m.owner === 'string' && HEX64.test(m.owner) ? m.owner : undefined,
      platform: m.platform && typeof m.platform === 'object' ? m.platform : undefined,
    };
  };
}

/** A response body read up to `max` bytes: undefined (and the stream cancelled) once it passes. */
export async function readCapped(r: Response, max: number): Promise<Buffer | undefined> {
  if (Number(r.headers.get('content-length') ?? 0) > max) {
    await r.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = r.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
}
