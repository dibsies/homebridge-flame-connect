import assert from 'node:assert/strict';
import test from 'node:test';

import { FlameConnectClient, isCloudError } from '../src/flameconnect/client.js';
import { FlameConnectCloudError, asCloudError } from '../src/flameconnect/errors.js';

test('isCloudError distinguishes cloud failures from local validation', () => {
  assert.equal(isCloudError(Object.assign(new Error('x'), { code: 'FLAMECONNECT_CLOUD_ERROR' })), true);
  assert.equal(isCloudError(Object.assign(new Error('x'), { code: 'FLAMECONNECT_REAUTH_REQUIRED' })), true);
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const wrappedTimeout = asCloudError(timeout);
  assert.equal(isCloudError(wrappedTimeout), true);
  assert.equal(wrappedTimeout.kind, 'timeout');
  assert.equal(wrappedTimeout.cause, timeout);
  const networkFailure = new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  });
  assert.equal(isCloudError(asCloudError(networkFailure)), true);
  assert.equal(isCloudError(networkFailure), false);
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
  const abortError = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
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
        assert.equal(error.name, 'FlameConnectCloudError');
        assert.equal(error.code, 'FLAMECONNECT_CLOUD_ERROR');
        assert.equal(error.kind, 'timeout');
        assert.equal(error.cause?.name, 'TimeoutError');
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

test('Retry-After is honored for safe reads but never replays writes', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    if (options.method === 'GET' && calls === 1) {
      return {
        ok: false, status: 429, headers: { get: () => '0' }, text: async () => 'limited',
      };
    }
    if (options.method === 'GET') return { ok: true, status: 200, text: async () => '[]' };
    return {
      ok: false, status: 429, headers: { get: () => '0' }, text: async () => 'limited',
    };
  };
  try {
    const client = new FlameConnectClient({ getAccessToken: async () => 'token' }, null);
    await client.getFires();
    assert.equal(calls, 2);
    await assert.rejects(client.writeParameters('id', []), (error) => error.retryAfterMs === 0);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test('overview result code 1 retries once, hides the device id, and becomes a cloud error', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ResultCode: 1 }),
    };
  };
  try {
    const client = new FlameConnectClient({ getAccessToken: async () => 'token' }, null);
    await assert.rejects(
      client.getFireOverview('PRIVATE-DEVICE-ID'),
      (error) => error instanceof FlameConnectCloudError
        && error.resultCode === 1
        && !error.message.includes('PRIVATE-DEVICE-ID'),
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('overview transient result code recovers on its single safe read retry', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const data = calls === 1
      ? { ResultCode: 1 }
      : { ResultCode: 0, WifiFireOverview: { FireId: 'id', FriendlyName: 'Fire', Parameters: [] } };
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  try {
    const client = new FlameConnectClient({ getAccessToken: async () => 'token' }, null);
    const overview = await client.getFireOverview('id');
    assert.equal(overview.fire.friendlyName, 'Fire');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});
