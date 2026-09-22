import assert from 'node:assert/strict';
import test from 'node:test';

import { FlameConnectClient, isCloudError } from '../src/flameconnect/client.js';

test('isCloudError distinguishes cloud failures from local validation', () => {
  assert.equal(isCloudError(Object.assign(new Error('x'), { code: 'FLAMECONNECT_CLOUD_ERROR' })), true);
  assert.equal(isCloudError(Object.assign(new Error('x'), { code: 'FLAMECONNECT_REAUTH_REQUIRED' })), true);
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(isCloudError(abort), true);
  // fetch() reports network failures as a TypeError carrying the system
  // error as its cause; a bare TypeError is a programming defect, not a
  // cloud failure, and must not be masked as one.
  const networkFailure = new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  });
  assert.equal(isCloudError(networkFailure), true);
  assert.equal(isCloudError(new TypeError('fetch failed')), false);
  assert.equal(isCloudError(new TypeError('Cannot read properties of undefined')), false);
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

test('an aborted API request terminates and is classified as a cloud error', async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  // Take control of the timeout signal so the test does not wait 15 seconds.
  AbortSignal.timeout = () => controller.signal;
  // A hanging cloud call: only settles when the abort signal fires, at which
  // point fetch rejects the way the real one does on timeout.
  const abortError = () => {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
  };
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(abortError());
      return;
    }
    options.signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
  try {
    const auth = { getAccessToken: async () => 'token' };
    const client = new FlameConnectClient(auth, null);
    const pending = client.getFires();
    controller.abort();
    await assert.rejects(
      pending,
      (error) => {
        assert.equal(error.name, 'AbortError');
        assert.equal(error.code, 'FLAMECONNECT_CLOUD_ERROR');
        assert.equal(isCloudError(error), true);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});

test('malformed API responses are classified as cloud errors', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'not json{{' });
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

test('token acquisition failures inside requests are classified as cloud errors', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('unreachable'); };
  try {
    const auth = {
      getAccessToken: async () => {
        const error = new Error('Could not reach Flame Connect authentication: unreachable');
        error.code = 'FLAMECONNECT_CLOUD_ERROR';
        throw error;
      },
    };
    const client = new FlameConnectClient(auth, null);
    await assert.rejects(
      client.getFires(),
      (error) => error.code === 'FLAMECONNECT_CLOUD_ERROR' && isCloudError(error),
    );
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
