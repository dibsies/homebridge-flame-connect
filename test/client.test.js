import assert from 'node:assert/strict';
import test from 'node:test';

import { FlameConnectClient, isCloudError } from '../src/flameconnect/client.js';

test('isCloudError distinguishes cloud failures from local validation', () => {
  assert.equal(isCloudError(Object.assign(new Error('x'), { code: 'FLAMECONNECT_CLOUD_ERROR' })), true);
  assert.equal(isCloudError(Object.assign(new Error('x'), { code: 'FLAMECONNECT_REAUTH_REQUIRED' })), true);
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(isCloudError(abort), true);
  assert.equal(isCloudError(new TypeError('fetch failed')), true);
  assert.equal(isCloudError(new Error('Invalid heater target temperature.')), false);
  assert.equal(isCloudError(null), false);
  assert.equal(isCloudError('boom'), false);
});

test('API requests carry an abort timeout signal', async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = options;
    return { ok: true, status: 200, text: async () => '[]' };
  };
  try {
    const auth = { getAccessToken: async () => 'token' };
    const client = new FlameConnectClient(auth, null);
    await client.getFires();
    assert.ok(seen.signal instanceof AbortSignal);
  } finally {
    globalThis.fetch = original;
  }
});

test('HTTP error responses are marked as cloud errors', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => 'down' });
  try {
    const auth = { getAccessToken: async () => 'token' };
    const client = new FlameConnectClient(auth, null);
    await assert.rejects(
      client.getFires(),
      (error) => error.code === 'FLAMECONNECT_CLOUD_ERROR',
    );
  } finally {
    globalThis.fetch = original;
  }
});
