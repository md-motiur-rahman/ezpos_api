import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../../src/app.js';

test('GET /health returns 200 with db connected', async () => {
  const res = await request(app).get('/health');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.db, 'connected');
});

test('GET /unknown-route returns a 404 in the standard error shape', async () => {
  const res = await request(app).get('/unknown-route');

  assert.equal(res.status, 404);
  assert.match(res.body.error.message, /Route not found/);
});