import assert from 'node:assert/strict';
import test from 'node:test';
import { FlameConnectPlatform } from '../src/platform.js';

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
