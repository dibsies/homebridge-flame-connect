import assert from 'node:assert/strict';
import test from 'node:test';
import { FlameConnectPlatform, mapWithConcurrency } from '../src/platform.js';

test('cached accessories wait for current capabilities before services are constructed', () => {
  const callbacks = {};
  const api = {
    hap: { Service: {}, Characteristic: {} },
    user: { storagePath: () => '/tmp' },
    on: (event, callback) => { callbacks[event] = callback; },
  };
  const platform = new FlameConnectPlatform({}, {}, api);
  const accessory = {
    UUID: 'cached',
    context: { fire: { fireId: 'fire', features: { powerBoost: false } } },
  };

  platform.configureAccessory(accessory);

  assert.equal(platform.accessories.get('cached'), accessory);
  assert.equal(platform.handlers.size, 0);
  assert.equal(typeof callbacks.didFinishLaunching, 'function');
});

function mockPlatform(config = {}) {
  const messages = [];
  const log = {
    info: (m) => messages.push(['info', m]),
    warn: (m) => messages.push(['warn', m]),
    error: (m) => messages.push(['error', m]),
    debug: (m) => messages.push(['debug', m]),
  };
  const api = {
    hap: { Service: {}, Characteristic: {} },
    user: { storagePath: () => '/tmp' },
    on: () => {},
  };
  const platform = new FlameConnectPlatform(log, config, api);
  return { platform, log, messages };
}

test('failed startup discovery schedules a retry instead of staying dead', async () => {
  const { platform } = mockPlatform({ refreshToken: 'rt' });
  platform.client.getFires = async () => {
    throw Object.assign(new Error('cloud exploded'), { code: 'FLAMECONNECT_CLOUD_ERROR' });
  };
  try {
    await platform.discoverDevices();
    assert.equal(platform.discoveryAttempts, 1);
    assert.ok(platform.discoveryTimer !== null);
    assert.equal(platform.pollTimer, null);
    assert.equal(platform.handlers.size, 0);
  } finally {
    platform.clearDiscoveryRetry();
  }
});

test('discovery retry backoff grows exponentially and is bounded', () => {
  const { platform } = mockPlatform();
  assert.equal(platform.discoveryRetryDelay(0), 10_000);
  assert.equal(platform.discoveryRetryDelay(1), 20_000);
  assert.equal(platform.discoveryRetryDelay(2), 40_000);
  assert.equal(platform.discoveryRetryDelay(10), 300_000);
  assert.equal(platform.discoveryRetryDelay(100), 300_000);
  platform.clearDiscoveryRetry();
});

test('successful discovery clears retry state and starts polling', async () => {
  const { platform } = mockPlatform({ refreshToken: 'rt' });
  platform.client.getFires = async () => [];
  platform.discoveryAttempts = 3;
  try {
    await platform.discoverDevices();
    assert.equal(platform.discoveryAttempts, 0);
    assert.equal(platform.discoveryTimer, null);
    assert.ok(platform.pollTimer !== null);
  } finally {
    platform.clearDiscoveryRetry();
    if (platform.pollTimer) clearInterval(platform.pollTimer);
    platform.pollTimer = null;
  }
});

test('revoked sign-in does not schedule discovery retries', async () => {
  const { platform, messages } = mockPlatform({ refreshToken: 'rt' });
  platform.client.getFires = async () => {
    throw Object.assign(new Error('revoked'), { code: 'FLAMECONNECT_REAUTH_REQUIRED' });
  };
  try {
    await platform.discoverDevices();
    assert.equal(platform.discoveryAttempts, 0);
    assert.equal(platform.discoveryTimer, null);
    assert.equal(platform.pollTimer, null);
    assert.ok(messages.some(([level, m]) => level === 'error' && /sign in again/.test(m)));
  } finally {
    platform.clearDiscoveryRetry();
  }
});

test('missing refresh token does not schedule discovery retries', async () => {
  const { platform, messages } = mockPlatform({});
  platform.client.getFires = async () => {
    const error = new Error('No Flame Connect refresh token is configured.');
    error.code = 'FLAMECONNECT_NO_TOKEN';
    throw error;
  };
  try {
    await platform.discoverDevices();
    assert.equal(platform.discoveryAttempts, 0);
    assert.equal(platform.discoveryTimer, null);
    assert.ok(messages.some(([level, m]) => level === 'error' && /guided sign-in/.test(m)));
  } finally {
    platform.clearDiscoveryRetry();
  }
});

test('bounded concurrency never exceeds its limit', async () => {
  let active = 0;
  let maximum = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.equal(maximum, 3);
  assert.deepEqual(results.map((result) => result.value), [2, 4, 6, 8, 10, 12]);
});

test('background polling defaults to fifteen minutes and does not overlap', async () => {
  const { platform } = mockPlatform();
  platform.startPolling();
  try {
    assert.equal(platform.pollTimer._idleTimeout, 15 * 60_000);
    let release;
    let calls = 0;
    platform.handlers.set('one', {
      refresh: () => {
        calls += 1;
        return new Promise((resolve) => { release = resolve; });
      },
    });
    const first = platform.refreshAll();
    const second = platform.refreshAll();
    assert.equal(calls, 1);
    release();
    await Promise.all([first, second]);
  } finally {
    clearInterval(platform.pollTimer);
  }
});
