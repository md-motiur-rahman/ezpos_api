import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/utils/AppError.js';

test('AppError sets message, statusCode, and isOperational', () => {
  const err = new AppError('Menu item not found', 404);

  assert.equal(err.message, 'Menu item not found');
  assert.equal(err.statusCode, 404);
  assert.equal(err.isOperational, true);
  assert.ok(err instanceof Error);
});

test('AppError defaults to statusCode 500 when none is given', () => {
  const err = new AppError('Something went wrong');

  assert.equal(err.statusCode, 500);
});