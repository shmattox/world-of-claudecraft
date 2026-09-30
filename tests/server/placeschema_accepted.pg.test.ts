// Executed PostgreSQL proof for the account-level PlaceSchema claims (PLACE-276):
// server/placeschema_accepted_db.ts's boot migration, claimGrant (join claims before it adds) and
// syncPlaceschemaAccepted (the statement every character save runs in its own transaction). Only
// real PostgreSQL can prove the unique-key race between two characters claiming one grant, so this
// drives the exported SQL in a private schema. The PG16 CI shard supplies TEST_DATABASE_URL; local
// runs without it skip. Teardown drops only the private schema.

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  claimGrant,
  PLACESCHEMA_ACCEPTED_SCHEMA,
  syncPlaceschemaAccepted,
} from '../../server/placeschema_accepted_db';

const url = process.env.TEST_DATABASE_URL ?? '';
const d = url === '' ? describe.skip : describe;
const SCHEMA = 'placeschema_accepted_pg_test';
const G = (c: string) => c.repeat(64);

d('the account-level claims against real PostgreSQL', () => {
  let pool: Pool;

  beforeAll(async () => {
    const pg = await import('pg');
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${SCHEMA}` });
    const current = await pool.query('SELECT current_schema() AS name');
    if (current.rows[0]?.name !== SCHEMA) throw new Error('did not enter the private schema');
    // Minimal stand-ins: the statements touch only these columns.
    await pool.query('CREATE TABLE accounts (id INT PRIMARY KEY)');
    await pool.query(
      'CREATE TABLE characters (id INT PRIMARY KEY, account_id INT NOT NULL REFERENCES accounts(id), state JSONB)',
    );
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DROP TABLE IF EXISTS placeschema_accepted, placeschema_cancels');
    await pool.query('DELETE FROM characters');
    await pool.query('DELETE FROM accounts');
    await pool.query('INSERT INTO accounts (id) VALUES (1), (2)');
    await pool.query(
      "INSERT INTO characters (id, account_id, state) VALUES (10, 1, '{}'), (11, 1, '{}'), (20, 2, '{}')",
    );
  });

  const rows = async () =>
    (
      await pool.query(
        'SELECT account_id, left(grant_id, 1) AS g, character_id, pending FROM placeschema_accepted ORDER BY 1, 2',
      )
    ).rows;
  const claimOf = async (g: string) =>
    Number(
      (await pool.query('SELECT claim_id FROM placeschema_accepted WHERE grant_id = $1', [g]))
        .rows[0].claim_id,
    );

  it('the boot migration moves per-character ids up to their account, once, ignoring junk', async () => {
    await pool.query('DELETE FROM characters');
    await pool.query(
      `INSERT INTO characters (id, account_id, state) VALUES
        (10, 1, jsonb_build_object('placeschemaAccepted', jsonb_build_array($1::text, 'not-a-grant'))),
        (11, 1, '{"placeschemaAccepted": "oops"}'),
        (20, 2, jsonb_build_object('placeschemaAccepted', jsonb_build_array($2::text))),
        (21, 2, '{}')`,
      [G('a'), G('b')],
    );
    await pool.query(PLACESCHEMA_ACCEPTED_SCHEMA);
    await pool.query(PLACESCHEMA_ACCEPTED_SCHEMA); // idempotent: a second boot adds nothing
    expect(await rows()).toEqual([
      { account_id: 1, g: 'a', character_id: 10, pending: false },
      { account_id: 2, g: 'b', character_id: 20, pending: false },
    ]);
  });

  it('claim first: claimed (pending), confirmed by the save, then held for every character', async () => {
    await pool.query(PLACESCHEMA_ACCEPTED_SCHEMA);
    expect(await claimGrant(pool, 1, G('c'), 10, [10])).toBe('claimed');
    expect(await rows()).toEqual([{ account_id: 1, g: 'c', character_id: 10, pending: true }]);
    expect(await claimGrant(pool, 1, G('c'), 11, [10, 11])).toBe('busy'); // 10 is online, saving
    expect(await claimGrant(pool, 1, G('c'), 10, [10])).toBe('claimed'); // its own pending claim
    await syncPlaceschemaAccepted(pool, 10, { placeschemaAccepted: [G('c')] });
    expect(await rows()).toEqual([{ account_id: 1, g: 'c', character_id: 10, pending: false }]);
    expect(await claimGrant(pool, 1, G('c'), 11, [11])).toBe('held');
    expect(await claimGrant(pool, 1, G('c'), 10, [10])).toBe('held');
  });

  it('a crash leftover (pending, its character offline) is taken over exactly once', async () => {
    await pool.query(PLACESCHEMA_ACCEPTED_SCHEMA);
    expect(await claimGrant(pool, 1, G('d'), 10, [10])).toBe('claimed'); // then the process dies
    expect(await claimGrant(pool, 1, G('d'), 11, [11])).toBe('claimed'); // 10 is offline now
    expect(await rows()).toEqual([{ account_id: 1, g: 'd', character_id: 11, pending: true }]);
    // 10's save cannot confirm a claim that is no longer its own
    await syncPlaceschemaAccepted(pool, 10, { placeschemaAccepted: [G('d')] });
    expect((await rows())[0].pending).toBe(true);
    await syncPlaceschemaAccepted(pool, 11, { placeschemaAccepted: [G('d')] });
    expect((await rows())[0].pending).toBe(false);
  });

  it('B2: a release deletes the claim by id whichever character claimed it, and never a later one', async () => {
    await pool.query(PLACESCHEMA_ACCEPTED_SCHEMA);
    await claimGrant(pool, 1, G('e'), 10, [10]); // A claims it
    await syncPlaceschemaAccepted(pool, 10, { placeschemaAccepted: [G('e')] });
    const first = await claimOf(G('e'));
    // B (11) received it by mail and carries it out: B's save releases A's claim
    await syncPlaceschemaAccepted(pool, 11, {
      placeschemaAccepted: [],
      placeschemaReleased: [first],
    });
    expect(await rows()).toEqual([]);
    // re-offered and claimed again: a replay of the old release deletes nothing
    expect(await claimGrant(pool, 1, G('e'), 11, [11])).toBe('claimed');
    await syncPlaceschemaAccepted(pool, 11, {
      placeschemaAccepted: [G('e')],
      placeschemaReleased: [first],
    });
    expect(await rows()).toEqual([{ account_id: 1, g: 'e', character_id: 11, pending: false }]);
    // a release names a claim of THIS account only
    await syncPlaceschemaAccepted(pool, 20, {
      placeschemaAccepted: [],
      placeschemaReleased: [await claimOf(G('e'))],
    });
    expect(await rows()).toHaveLength(1);
  });

  it('two characters claiming one grant at once: exactly one claims it', async () => {
    await pool.query(PLACESCHEMA_ACCEPTED_SCHEMA);
    const results = await Promise.all([
      claimGrant(pool, 1, G('f'), 10, [10, 11]),
      claimGrant(pool, 1, G('f'), 11, [10, 11]),
    ]);
    expect(results.filter((r) => r === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r === 'busy')).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it('a character that never used PlaceSchema runs no statement', async () => {
    await pool.query(PLACESCHEMA_ACCEPTED_SCHEMA);
    const seen: string[] = [];
    await syncPlaceschemaAccepted({ query: async (s: string) => seen.push(s) }, 10, {});
    expect(seen).toEqual([]);
  });
});
