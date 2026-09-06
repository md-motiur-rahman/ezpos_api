import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedPreviewOrigin } from '../../src/app.js';

/**
 * CORS_ALLOWED_PREVIEW_SUFFIX widens which browser origins may call this API,
 * so the matching has to be strict about HOW it matches, not just what. These
 * cover the ways a suffix check is normally got wrong.
 */

const SUFFIX = '.vercel.app';

test('a real preview subdomain over https is allowed', () => {
  assert.equal(isAllowedPreviewOrigin('https://ezpos-git-main-nabil.vercel.app', SUFFIX), true);
  assert.equal(isAllowedPreviewOrigin('https://a.b.vercel.app', SUFFIX), true);
});

test('the suffix may be configured with or without a leading dot', () => {
  assert.equal(isAllowedPreviewOrigin('https://app.vercel.app', 'vercel.app'), true);
  assert.equal(isAllowedPreviewOrigin('https://app.vercel.app', '.vercel.app'), true);
});

test('http is rejected - only https previews are allowed', () => {
  // Without the scheme check, an attacker on plain http could be trusted.
  assert.equal(isAllowedPreviewOrigin('http://ezpos-preview.vercel.app', SUFFIX), false);
});

test('a lookalike domain that merely ENDS WITH the suffix text is rejected', () => {
  // The critical case: 'evil-vercel.app' ends with 'vercel.app' as a STRING,
  // but is a completely different registrable domain someone could buy.
  assert.equal(isAllowedPreviewOrigin('https://evil-vercel.app', 'vercel.app'), false);
  assert.equal(isAllowedPreviewOrigin('https://notvercel.app', 'vercel.app'), false);
});

test('the bare suffix domain itself is rejected - a subdomain is required', () => {
  assert.equal(isAllowedPreviewOrigin('https://vercel.app', SUFFIX), false);
});

test('an unrelated origin is rejected', () => {
  assert.equal(isAllowedPreviewOrigin('https://evil.com', SUFFIX), false);
  assert.equal(isAllowedPreviewOrigin('https://vercel.app.evil.com', SUFFIX), false);
});

test('matching is case-insensitive on the host', () => {
  assert.equal(isAllowedPreviewOrigin('https://App-Preview.Vercel.App', SUFFIX), true);
});

test('no suffix configured means nothing extra is ever allowed', () => {
  // The default. Opting in must be a deliberate act.
  assert.equal(isAllowedPreviewOrigin('https://anything.vercel.app', ''), false);
  assert.equal(isAllowedPreviewOrigin('https://anything.vercel.app', undefined), false);
});

test('a malformed origin is rejected rather than throwing', () => {
  assert.equal(isAllowedPreviewOrigin('not-a-url', SUFFIX), false);
  assert.equal(isAllowedPreviewOrigin('', SUFFIX), false);
});
