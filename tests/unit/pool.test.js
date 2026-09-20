import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, withTransaction } from '../../src/db/pool.js';

/**
 * withTransaction is exercised end-to-end by the real DB in
 * tests/integration/orderPayments.test.js (happy paths, the 402 decline
 * path, real concurrency) - this file covers the one path that can't be
 * forced against a real connection without deliberately breaking it: a
 * ROLLBACK that itself fails. No mocking library exists anywhere in this
 * project, so `pool.connect` is monkey-patched for the duration of one test
 * and restored immediately after - the same "temporarily replace, verify,
 * revert" shape used elsewhere in this project to prove a guard is actually
 * load-bearing, just applied at the JS level instead of editing source.
 */
test('withTransaction: a failing ROLLBACK never replaces the original error, and the connection is destroyed not pooled', async () => {
  const queries = [];
  let releasedWith = 'not-called';
  const fakeClient = {
    query: async (text) => {
      queries.push(text);
      if (text === 'BEGIN') return;
      if (text === 'ROLLBACK') {
        // Simulates a broken connection / a backend that already aborted
        // the statement (statement_timeout) - ROLLBACK rejecting is the
        // exact scenario CodeRabbit flagged.
        throw new Error('Connection terminated unexpectedly');
      }
      throw new Error(`unexpected query on fake client: ${text}`);
    },
    release: (destroy) => {
      releasedWith = destroy;
    },
  };

  const originalConnect = pool.connect;
  pool.connect = async () => fakeClient;
  const originalError = new Error('business logic failure inside the callback');

  try {
    await assert.rejects(
      () => withTransaction(async () => {
        throw originalError;
      }),
      (err) => err === originalError,
      'the SAME error instance thrown by the callback must propagate, not the ROLLBACK failure'
    );
  } finally {
    pool.connect = originalConnect;
  }

  assert.deepEqual(queries, ['BEGIN', 'ROLLBACK'], 'ROLLBACK must still be attempted even though it fails');
  assert.equal(
    releasedWith,
    true,
    'release() must be called with a truthy destroy flag when ROLLBACK itself failed - the connection state is genuinely uncertain'
  );
});

test('withTransaction: a clean ROLLBACK reuses the connection - an ordinary callback error (e.g. a card decline) must not churn the pool', async () => {
  const queries = [];
  let releasedWith = 'not-called';
  const fakeClient = {
    query: async (text) => {
      queries.push(text);
    },
    release: (destroy) => {
      releasedWith = destroy;
    },
  };

  const originalConnect = pool.connect;
  pool.connect = async () => fakeClient;
  const originalError = new Error('a plain AppError-style failure, e.g. a 402 card decline');

  try {
    await assert.rejects(
      () => withTransaction(async () => {
        throw originalError;
      }),
      (err) => err === originalError
    );
  } finally {
    pool.connect = originalConnect;
  }

  assert.deepEqual(queries, ['BEGIN', 'ROLLBACK']);
  // A ROLLBACK that succeeds restores a clean, idle connection regardless
  // of WHY the callback threw - a 402 decline is an ordinary, frequent
  // business outcome (recordPayment's own docs: "a declined card is an
  // ordinary business outcome... not an exception"), so destroying the
  // connection here would turn a routine event into needless pool churn.
  assert.equal(releasedWith, false, 'a successfully rolled-back connection must be returned to the pool, not destroyed');
});

test('withTransaction: the happy path commits, releases cleanly, and returns the callback result', async () => {
  const queries = [];
  let releasedWith = 'not-called';
  const fakeClient = {
    query: async (text) => {
      queries.push(text);
    },
    release: (err) => {
      releasedWith = err;
    },
  };

  const originalConnect = pool.connect;
  pool.connect = async () => fakeClient;

  let result;
  try {
    result = await withTransaction(async () => 'callback result');
  } finally {
    pool.connect = originalConnect;
  }

  assert.equal(result, 'callback result');
  assert.deepEqual(queries, ['BEGIN', 'COMMIT']);
  assert.equal(releasedWith, undefined, 'a successful transaction releases with no error - safe to pool');
});
