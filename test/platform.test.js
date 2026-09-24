import assert from 'node:assert/strict';
import test from 'node:test';
import { FlameConnectPlatform, mapWithConcurrency } from '../src/platform.js';

test('restored accessories get handlers immediately from cached context', () => {
  const characteristic = (name, values = {}) => ({ ...values, toString: () => name });
  const Service = {
    Switch: { UUID: 'switch' }, Lightbulb: { UUID: 'light' }, Thermostat: { UUID: 'thermostat' },
    Fanv2: { UUID: 'fan' }, AccessoryInformation: { UUID: 'info' },
  };
  const Characteristic = {
    Name: characteristic('Name'), ConfiguredName: characteristic('ConfiguredName'),
    Manufacturer: characteristic('Manufacturer'), Model: characteristic('Model'),
    SerialNumber: characteristic('SerialNumber'),
    On: characteristic('On'), Brightness: characteristic('Brightness'),
    Hue: characteristic('Hue'), Saturation: characteristic('Saturation'),
    Active: characteristic('Active', { INACTIVE: 0, ACTIVE: 1 }),
    RotationSpeed: characteristic('RotationSpeed'),
    TargetHeatingCoolingState: characteristic('TargetHeatingCoolingState', { OFF: 0, HEAT: 1 }),
    CurrentHeatingCoolingState: characteristic('CurrentHeatingCoolingState', { OFF: 0, HEAT: 1 }),
    TargetTemperature: characteristic('TargetTemperature'),
    CurrentTemperature: characteristic('CurrentTemperature'),
    TemperatureDisplayUnits: characteristic('TemperatureDisplayUnits', { CELSIUS: 0 }),
  };
  const callbacks = {};
  const api = {
    hap: { Service, Characteristic },
    user: { storagePath: () => '/tmp' },
    on: (event, callback) => { callbacks[event] = callback; },
    updatePlatformAccessories() {},
  };
  const platform = new FlameConnectPlatform({ debug() {}, info() {}, warn() {}, error() {} }, {}, api);
  const accessory = {
    UUID: 'cached',
    context: { fire: { fireId: 'fire', friendlyName: 'Fire', features: {} } },
    services: [],
    addService(type, name, subtype) {
      const values = {};
      const service = {
        UUID: type.UUID, subtype, displayName: name, linkedServices: [],
        getCharacteristic(k) {
          return values[k] ||= {
            value: '', props: {},
            onGet(fn) { this.getter = fn; return this; },
            onSet(fn) { this.setter = fn; return this; },
            setProps(props) { this.props = props; return this; },
          };
        },
        setCharacteristic(k, v) { this.getCharacteristic(k).value = v; return this; },
        updateCharacteristic(k, v) { return this.setCharacteristic(k, v); },
        addOptionalCharacteristic() {},
        addLinkedService(s) { this.linkedServices.push(s); },
      };
      this.services.push(service);
      return service;
    },
    getService(type, name, subtype) {
      return this.services.find((s) => s.UUID === type.UUID && s.subtype === subtype)
        || this.addService(type, name, subtype);
    },
    removeService(type, subtype) {
      const service = this.services.find((s) => s.UUID === type.UUID && s.subtype === subtype);
      this.services = this.services.filter((s) => s !== service);
    },
  };

  platform.configureAccessory(accessory);

  // The handler attaches at startup from cached context, so existing controls
  // keep working through a cloud outage; capabilities reconcile on discovery.
  assert.equal(platform.accessories.get('cached'), accessory);
  assert.equal(platform.handlers.size, 1);
  const handler = platform.handlers.get('cached');
  assert.ok(handler.powerService);
  assert.ok(handler.flameService);
  assert.equal(typeof callbacks.didFinishLaunching, 'function');
  handler.dispose();
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

test('config sanitization clamps out-of-range values to safe bounds', () => {
  const api = {
    hap: { Service: {}, Characteristic: {} },
    user: { storagePath: () => '/tmp' },
    on() {},
    updatePlatformAccessories() {},
  };
  const platform = new FlameConnectPlatform(
    { debug() {}, info() {}, warn() {}, error() {} },
    {
      name: '   ',
      pollIntervalMinutes: 0.5,
      cacheSeconds: 99999,
      commandStateMaxAgeSeconds: -5,
      turboBoostMinutes: 60,
      tokenFile: '   ',
      exposePower: false,
    },
    api,
  );
  assert.ok(!('name' in platform.config));
  assert.equal(platform.config.pollIntervalMinutes, 5);
  assert.equal(platform.config.cacheSeconds, 3600);
  assert.equal(platform.config.commandStateMaxAgeSeconds, 0);
  assert.equal(platform.config.turboBoostMinutes, 20);
  assert.ok(!('tokenFile' in platform.config));
});

test('non-numeric config values fall back to safe defaults', () => {
  const api = {
    hap: { Service: {}, Characteristic: {} },
    user: { storagePath: () => '/tmp' },
    on() {},
    updatePlatformAccessories() {},
  };
  const platform = new FlameConnectPlatform(
    { debug() {}, info() {}, warn() {}, error() {} },
    { pollIntervalMinutes: 'often', cacheSeconds: NaN },
    api,
  );
  assert.equal(platform.config.pollIntervalMinutes, 15);
  assert.equal(platform.config.cacheSeconds, 30);
});

test('allControlsDisabled requires every control explicitly off', () => {
  const api = {
    hap: { Service: {}, Characteristic: {} },
    user: { storagePath: () => '/tmp' },
    on() {},
    updatePlatformAccessories() {},
  };
  const make = (config) => new FlameConnectPlatform(
    { debug() {}, info() {}, warn() {}, error() {} }, config, api,
  );
  const allOff = {
    exposePower: false, exposeFlames: false, exposeHeater: false, exposeEcoMode: false,
    exposeFanOnly: false, exposeTurboBoost: false, exposeFlameSpeed: false,
    exposeMediaLight: false, exposeOverheadLight: false, exposeLogs: false,
  };
  assert.equal(make(allOff).allControlsDisabled(), true);
  assert.equal(make({ ...allOff, advancedControls: true }).allControlsDisabled(), false);
  // One control left at its default (undefined) is not "explicitly disabled".
  const { exposeLogs, ...rest } = allOff;
  assert.equal(make(rest).allControlsDisabled(), false);
  assert.equal(make({}).allControlsDisabled(), false);
});
