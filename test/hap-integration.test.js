import assert from 'node:assert/strict';
import test from 'node:test';

import hap from '@homebridge/hap-nodejs';

const { Accessory, Service, Characteristic, uuid, HapStatusError, HAPStatus } = hap;

import { FlameConnectAccessory } from '../src/accessory.js';
import { FlameConnectClient } from '../src/flameconnect/client.js';
import { FlameConnectCloudError } from '../src/flameconnect/errors.js';
import { decodeParameter } from '../src/flameconnect/protocol.js';

function realFixture(config = {}) {
  const accessory = new Accessory('Test Fire', uuid.generate('hap-integration-test'));
  accessory.context = {};
  const client = new FlameConnectClient({}, {});
  const remote = {
    flame: {
      flameEffect: 1, flameSpeed: 1, brightness: 0, mediaLight: 0, overheadLight: 0,
      mediaColor: { red: 0, green: 0, blue: 0, white: 0 },
      overheadColor: { red: 0, green: 0, blue: 0, white: 0 },
    },
    heat: { heatStatus: 0, heatMode: 0, setpointTemperature: 22, boostDuration: 1 },
    log: { logEffect: 0, color: { red: 0, green: 0, blue: 0, white: 0 }, pattern: 0 },
  };
  client.getFireOverview = async () => ({ parameters: structuredClone(remote) });
  client.writeParameters = async (_id, entries) => {
    for (const e of entries) {
      const p = decodeParameter(e.parameterId, e.value);
      remote[p.type] = p;
    }
  };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const platform = {
    config, Service, Characteristic, client, log,
    api: { updatePlatformAccessories() {}, hap: { HapStatusError, HAPStatus } },
  };
  const handler = new FlameConnectAccessory(platform, accessory, {
    fireId: 'test', friendlyName: 'Test Fire', withHeat: true,
    features: { advancedHeat: true, fanOnly: true, powerBoost: true, rgbLogEffect: true },
  });
  return { handler, accessory, client, platform, remote: () => remote };
}

test('real HAP: the handler builds its full service set without warnings-worthy misuse', async () => {
  const f = realFixture();
  const subtypes = f.accessory.services.map((s) => s.subtype).filter(Boolean);
  for (const expected of ['power', 'flames', 'heater', 'eco-mode', 'fan-only', 'turbo-boost', 'flame-speed', 'media-light']) {
    assert.ok(subtypes.includes(expected), `expected a ${expected} service`);
  }
  // Exactly one primary service, and it is the power switch.
  const primaries = f.accessory.services.filter((s) => s.isPrimaryService);
  assert.equal(primaries.length, 1);
  assert.equal(primaries[0].subtype, 'power');
});

test('real HAP: a Home rename survives refresh and service reconciliation', async () => {
  const f = realFixture();
  await f.handler.refresh();
  const flames = f.handler.flameService;
  flames.getCharacteristic(Characteristic.ConfiguredName).setValue('Evening Glow');
  await f.handler.refresh();
  assert.equal(flames.getCharacteristic(Characteristic.ConfiguredName).value, 'Evening Glow');
  // Capability reconciliation must not reset the user's label either.
  f.handler.updateFire({ features: { advancedHeat: true, fanOnly: true, powerBoost: false, rgbLogEffect: true } });
  assert.equal(flames.getCharacteristic(Characteristic.ConfiguredName).value, 'Evening Glow');
});

test('real HAP: cloud failures surface as HapStatusError, not raw errors', async () => {
  const f = realFixture();
  await f.handler.refresh();
  f.client.writeParameters = async () => { throw new FlameConnectCloudError('Cloud is down.'); };
  const error = await f.handler.setPower(true).catch((e) => e);
  assert.ok(error instanceof HapStatusError, `expected HapStatusError, got ${error?.constructor?.name}`);
  assert.equal(error.hapStatus, HAPStatus.SERVICE_COMMUNICATION_FAILURE);
});

test('real HAP: no StatusFault is exposed on AccessoryInformation', async () => {
  const f = realFixture();
  await f.handler.refresh();
  const info = f.accessory.getService(Service.AccessoryInformation);
  assert.ok(info);
  const uuids = info.characteristics.map((c) => c.UUID);
  assert.ok(!uuids.includes(Characteristic.StatusFault.UUID));
});

test('real HAP: capability loss removes the service from the accessory', async () => {
  const f = realFixture();
  assert.ok(f.handler.boostService);
  f.handler.updateFire({ features: { advancedHeat: true, fanOnly: true, powerBoost: false, rgbLogEffect: true } });
  assert.equal(f.handler.boostService, undefined);
  assert.ok(!f.accessory.services.some((s) => s.subtype === 'turbo-boost'));
});

test('real HAP: the primary service is assigned through setPrimaryService', async () => {
  const calls = [];
  const original = Service.prototype.setPrimaryService;
  Service.prototype.setPrimaryService = function (isPrimary) {
    calls.push([this.subtype, isPrimary]);
    return original.call(this, isPrimary);
  };
  try {
    const f = realFixture();
    await f.handler.refresh();
    const trueCalls = calls.filter(([, value]) => value === true);
    assert.equal(trueCalls.length, 1, 'exactly one service is marked primary through the HAP API');
    assert.equal(trueCalls[0][0], 'power');
    const primaries = f.accessory.services.filter((s) => s.isPrimaryService);
    assert.equal(primaries.length, 1);
    assert.equal(primaries[0].subtype, 'power');
    // Moving the primary emits a configuration-change event so a published
    // accessory picks up the change; direct assignment would not.
    const events = [];
    f.handler.flameService.on('service-configurationChange', () => events.push('flames'));
    f.platform.config = { ...f.platform.config, exposePower: false };
    f.handler.syncServices();
    assert.equal(f.handler.powerService, undefined);
    assert.equal(f.handler.flameService.isPrimaryService, true);
    // (A second configuration-change event comes from HAP unlinking the
    // removed power service; what matters is the primary change emits.)
    assert.ok(events.length >= 1, 'the primary-service change must emit a configuration-change event');
    f.handler.dispose();
  } finally {
    Service.prototype.setPrimaryService = original;
  }
});

test('real HAP: a cold-start read timeout surfaces as a HomeKit communication error', { timeout: 30000 }, async () => {
  const f = realFixture();
  f.client.getFireOverview = () => new Promise(() => {}); // hangs forever
  const error = await f.handler.getPower().catch((e) => e);
  assert.ok(error instanceof HapStatusError, `expected HapStatusError, got ${error?.constructor?.name}`);
  assert.equal(error.hapStatus, HAPStatus.OPERATION_TIMED_OUT);
  f.handler.dispose();
});
