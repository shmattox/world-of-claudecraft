// Executed PostgreSQL proof for the account-level PlaceSchema accepted set (PLACE-276):
// server/placeschema_accepted_db.ts's boot migration and syncPlaceschemaAccepted, the statement every
// character save runs in its own transaction. Only real PostgreSQL can prove the claim refusal under
// concurrency (the unique key makes the second insert WAIT for the first transaction, then see its
// row), so this drives the exported SQL in a private schema. The PG16 CI shard supplies
// TEST_DATABASE_URL; local runs without it skip. Teardown drops only the private schema.

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PLACESCHEMA_ACCEPTED_SCHEMA,
  PlaceschemaClaimConflict,
  syncPlaceschemaAccepted,
} from '../../server/placeschema_accepted_db';

const url = process.env.TEST_DATABASE_URL ?? '';
const d = url === '' ? describe.skip : describe;
const SCHEMA = 'placeschema_accepted_pg_test';
const G = (c: string) => c.repeat(64);

d('the account-level accepted set against real PostgreSQL', () => {
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
  });

  const rows = async () =>
    (
      await pool.query(
        'SELECT account_id, left(grant_id, 1) AS g, character_id FROM placeschema_accepted ORDER BY 1, 2',
      )
    ).rows;

  it('the boot migration moves per-character ids up to their account, once, ignoring junk', async () => {
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
      { account_id: 1, g: 'a', character_id: 10 },
      { account_id: 2, g: 'b', character_id: 20 },
    ]);
  });

  it('a save adds and removes its own ids and never moves another character claim', async () => {
    await pool.query(
      "INSERT INTO characters (id, account_id, state) VALUES (10, 1, '{}'), (11, 1, '{}')",
    );
    await pool.query(PLACESCHEMA_ACCEPTED_SCHEMA);
    await syncPlaceschemaAccepted(pool, 10, { placeschemaAccepted: [G('a'), G('c')] });
    expect(await rows()).toEqual([
      { account_id: 1, g: 'a', character_id: 10 },
      { account_id: 1, g: 'c', character_id: 10 },
    ]);
    await syncPlaceschemaAccepted(pool, 10, { placeschemaAccepted: [G('c')] }); // carried a out
    expect(await rows()).toEqual([{ account_id: 1, g: 'c', character_id: 10 }]);
    await expect(
      syncPlaceschemaAccepted(pool, 11, { placeschemaAccepted: [G('c')] }),
    ).rejects.toBeInstanceOf(PlaceschemaClaimConflict);
    expect(await rows()).toEqual([{ account_id: 1, g: 'c', character_id: 10 }]); // still 10's
    // a real move: 10 carries it out (its save deletes the row), then 11 receives it back
    await syncPlaceschemaAccepted(pool, 10, { placeschemaAccepted: [] });
    await syncPlaceschemaAccepted(pool, 11, { placeschemaAccepted: [G('c')] });
    expect(await rows()).toEqual([{ account_id: 1, g: 'c', character_id: 11 }]);
  });

  it('two characters saving the same grant at once: exactly one commits, the other rolls back', async () => {
    await pool.query(
      "INSERT INTO characters (id, account_id, state) VALUES (10, 1, '{}'), (11, 1, '{}')",
    );
    await pool.query(PLACESCHEMA_ACCEPTED_SCHEMA);
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await syncPlaceschemaAccepted(a, 10, { placeschemaAccepted: [G('d')] });
      // b's insert waits on a's uncommitted unique key; commit a while b waits
      const bSave = syncPlaceschemaAccepted(b, 11, { placeschemaAccepted: [G('d')] }).then(
        () => b.query('COMMIT').then(() => 'committed'),
        async (e) => {
          await b.query('ROLLBACK');
          return e instanceof PlaceschemaClaimConflict ? 'rolled back' : `error ${e}`;
        },
      );
      await new Promise((r) => setTimeout(r, 100));
      await a.query('COMMIT');
      expect(await bSave).toBe('rolled back');
    } finally {
      a.release();
      b.release();
    }
    expect(await rows()).toEqual([{ account_id: 1, g: 'd', character_id: 10 }]);
  });
});
