import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asyncHandler } from '../../src/utils/asyncHandler.js';

test('asyncHandler forwards a thrown error to next()', async () => {
  const boom = new Error('boom');
  const handler = asyncHandler(async () => {
    throw boom;
  });

  let received;
  await handler({}, {}, (err) => {
    received = err;
  });

  assert.equal(received, boom);
});

test('asyncHandler does not call next() when the handler succeeds', async () => {
  const handler = asyncHandler(async (req, res) => {
    res.done = true;
  });

  let nextCalled = false;
  const res = {};
  await handler({}, res, () => {
    nextCalled = true;
  });

  assert.equal(res.done, true);
  assert.equal(nextCalled, false);
});