import assert from 'node:assert/strict';
import test from 'node:test';

import { FlameConnectCloudError, isCloudError } from '../src/flameconnect/errors.js';
import { FlameConnectAccessory } from '../src/accessory.js';
import { FlameConnectClient } from '../src/flameconnect/client.js';
import { FlameConnectAuth } from '../src/flameconnect/auth.js';
import { decodeParameter } from '../src/flameconnect/protocol.js';

// Fixture mirrors test/accessory.test.js so handler behavior is comparable.
function fixture(config = {}, accessory) {
  const characteristic = (name, values = {}) => ({ ...values, toString: () => name });
  const Characteristic = {
    Name: characteristic('Name'), ConfiguredName: characteristic('ConfiguredName'),
    On: characteristic('On'), Brightness: characteristic('Brightness'),
    Hue: characteristic('Hue'), Saturation: characteristic('Saturation'),
    Active: characteristic('Active', { INACTIVE: 0, ACTIVE: 1 }),
    RotationSpeed: characteristic('RotationSpeed'),
    TargetHeatingCoolingState: characteristic('TargetHeatingCoolingState', { OFF: 0, HEAT: 1 }),
    CurrentHeatingCoolingState: characteristic('CurrentHeatingCoolingState', { OFF: 0, HEAT: 1 }),
    TargetTemperature: characteristic('TargetTemperature'),
    CurrentTemperature: characteristic('CurrentTemperature'),
    TemperatureDisplayUnits: characteristic('TemperatureDisplayUnits', { CELSIUS: 0, FAHRENHEIT: 1 }),
  };
  const Service = {
    Switch: {UUID:'switch'}, Lightbulb:{UUID:'light'}, Thermostat:{UUID:'thermostat'},
    Fanv2:{UUID:'fan'}, AccessoryInformation:{UUID:'info'},
  };
  accessory ||= {
    context: {}, services: [], getService() {},
    addService(type, name, subtype) {
      const values = {};
      const service = {
        UUID: type.UUID, subtype, displayName:name, isPrimaryService: false, linkedServices: [],
        getCharacteristic(k) { return values[k] ||= {
          value: '', props: {}, onGet(fn) {this.getter=fn; return this;},
          onSet(fn) {this.setter=fn; return this;}, setProps(props) {this.props=props; return this;},
        }; },
        setCharacteristic(k,v) {this.getCharacteristic(k).value=v; return this;},
        updateCharacteristic(k,v) {return this.setCharacteristic(k,v);},
        addOptionalCharacteristic() {},
        addLinkedService(s) { this.linkedServices.push(s); },
      };
      this.services.push(service); return service;
    },
    removeService(s) {this.services=this.services.filter(x=>x!==s);},
  };
  const client = new FlameConnectClient({}, {});
  let remote = {
    flame:{flameEffect:1, flameSpeed:1, brightness:0, mediaLight:0, overheadLight:0,
      mediaColor:{red:0,green:0,blue:0,white:0}, overheadColor:{red:0,green:0,blue:0,white:0}},
    heat:{heatStatus:0,heatMode:0,setpointTemperature:22,boostDuration:1},
    log:{logEffect:0,color:{red:0,green:0,blue:0,white:0},pattern:0},
  };
  client.getFireOverview = async () => ({parameters:structuredClone(remote)});
  client.writeParameters = async (_id, entries) => {
    await Promise.resolve();
    for (const e of entries) {const p=decodeParameter(e.parameterId,e.value); remote[p.type]=p;}
  };
  const platform = {config, Service, Characteristic, client, api:{updatePlatformAccessories(){}}};
  const handler = new FlameConnectAccessory(platform, accessory, {fireId:'test', friendlyName:'Living Room Fire', withHeat:true,
    features:{advancedHeat:true,fanOnly:true,powerBoost:true,rgbLogEffect:true}});
  return {handler, accessory, client, remote:()=>remote};
}

test('a delayed overview started before a write never overwrites newer command state', async () => {
  const f = fixture();
  await f.handler.refresh();
  assert.equal(f.remote().flame.flameEffect, 1);

  let releaseGet;
  const gate = new Promise((resolve) => { releaseGet = resolve; });
  const origOverview = f.client.getFireOverview;
  f.client.getFireOverview = async () => { await gate; return origOverview(); };

  const refreshPromise = f.handler.refresh();
  await f.handler.setFlames(false);
  assert.equal(f.handler.state.flame.flameEffect, 0);
  assert.equal(f.remote().flame.flameEffect, 0);

  releaseGet();
  await refreshPromise;
  // The stale overview still reports flameEffect 1; it must be discarded.
  assert.equal(f.handler.state.flame.flameEffect, 0);
  assert.equal(f.remote().flame.flameEffect, 0);
});

test('a burst of cloud failures shares one cooldown window', async () => {
  const f = fixture();
  await f.handler.refresh();
  const failure = new FlameConnectCloudError('Cloud is down.');
  f.client.writeParameters = async () => { throw failure; };

  await assert.rejects(f.handler.setPower(true), /Cloud is down/);
  const cooldownEnd = f.handler.cloudFailureUntil;
  assert.ok(cooldownEnd > Date.now());

  // Queued commands rethrow the identical error object; the window must not extend.
  await assert.rejects(f.handler.setPower(true), /Cloud is down/);
  await assert.rejects(f.handler.setPower(true), /Cloud is down/);
  assert.equal(f.handler.cloudFailureUntil, cooldownEnd);
});

test('a command queued after a staged color runs after the color write', async () => {
  const f = fixture();
  await f.handler.refresh();
  const starts = [];
  const origWrite = f.client.writeParameters.bind(f.client);
  f.client.writeParameters = async (id, entries) => {
    starts.push(entries.map((e) => decodeParameter(e.parameterId, e.value).type).join('+'));
    return origWrite(id, entries);
  };

  const colorPromise = f.handler.setLightColor('mediaColor', 'hue', 120);
  const powerPromise = f.handler.setPower(true);
  await Promise.all([colorPromise, powerPromise]);

  assert.deepEqual(starts, ['flame', 'mode+flame+heat']);
});

test('separate hue/saturation/brightness writes coalesce into a single cloud write', async () => {
  const f = fixture();
  await f.handler.refresh();
  let writes = 0;
  const origWrite = f.client.writeParameters.bind(f.client);
  f.client.writeParameters = async (id, entries) => { writes += 1; return origWrite(id, entries); };

  await Promise.all([
    f.handler.setLightColor('mediaColor', 'hue', 240),
    f.handler.setLightColor('mediaColor', 'saturation', 100),
    f.handler.setLightColor('mediaColor', 'brightness', 50),
  ]);

  assert.equal(writes, 1);
  assert.deepEqual(f.remote().flame.mediaColor, { red: 0, green: 0, blue: 128, white: 0 });
});

test('the color coalescing timer is ref\'d so it always fires (Node 22)', async () => {
  const f = fixture();
  const promise = f.handler.setLightColor('mediaColor', 'hue', 120);
  const pending = f.handler.pendingColors.get('mediaColor');
  assert.ok(pending, 'color should be staged');
  assert.equal(pending.timer.hasRef(), true);
  await promise;
});

test('a hung cloud write settles the HomeKit call inside the response window without replaying', async () => {
  const f = fixture();
  await f.handler.refresh();
  let writes = 0;
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  f.client.writeParameters = async () => { writes += 1; await writeGate; };

  const call = f.handler.setPower(true);
  const error = await call.catch((e) => e);
  assert.ok(isCloudError(error), 'expected a classified cloud error');
  assert.equal(error.kind, 'timeout');
  assert.equal(writes, 1);
  releaseWrite();
  // The write is never replayed after the uncertain timeout.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(writes, 1);
}, { timeout: 30_000 });

test('with commandStateMaxAgeSeconds 0 a heat-mode command makes exactly one pre-write GET', async () => {
  const f = fixture({ commandStateMaxAgeSeconds: 0 });
  await f.handler.refresh();
  let gets = 0;
  let writes = 0;
  const origOverview = f.client.getFireOverview;
  const origWrite = f.client.writeParameters.bind(f.client);
  f.client.getFireOverview = async (...args) => { gets += 1; return origOverview(...args); };
  f.client.writeParameters = async (id, entries) => { writes += 1; return origWrite(id, entries); };

  await f.handler.setEcoMode(true);

  assert.equal(gets, 1);
  assert.equal(writes, 1);
  assert.equal(f.remote().heat.heatMode, 2); // ECO
});

test('a 401-rejected write retries once in the same queue slot, then surfaces', async () => {
  const f = fixture();
  await f.handler.refresh();
  let attempts = 0;
  const origWrite = f.client.writeParameters.bind(f.client);
  f.client.writeParameters = async (id, entries) => {
    attempts += 1;
    if (attempts === 1) {
      throw new FlameConnectCloudError('Write needs fresh auth.', { code: 'FLAMECONNECT_WRITE_AUTH_REFRESHED' });
    }
    return origWrite(id, entries);
  };

  await f.handler.setPower(true);
  assert.equal(attempts, 2);
  assert.equal(f.remote().mode.mode, 1); // MANUAL

  // A second 401 on the retry is not retried again.
  attempts = 0;
  f.client.writeParameters = async () => {
    attempts += 1;
    throw new FlameConnectCloudError('Write needs fresh auth.', { code: 'FLAMECONNECT_WRITE_AUTH_REFRESHED' });
  };
  await assert.rejects(f.handler.setPower(false), /fresh auth/);
  assert.equal(attempts, 2);
});

test('fan-only never reports as heating; enabling heat from fan-only selects a heating mode', async () => {
  const f = fixture();
  // Keep the injected state: no refresh may overwrite it mid-test.
  f.handler.lastRefresh = Date.now();
  f.handler.state.heat = { heatStatus: 1, heatMode: 3, setpointTemperature: 22 }; // FAN_ONLY
  assert.equal(await f.handler.getHeatTargetState(), 0);
  assert.equal(await f.handler.getHeatCurrentState(), 0);
  assert.equal(f.handler.isHeating(), false);

  let modeChanges;
  f.client.setHeatMode = async (_id, _state, changes) => {
    modeChanges = changes;
    return { heatStatus: 1, heatMode: 0, setpointTemperature: 22 };
  };
  await f.handler.setHeat(true);
  assert.deepEqual(modeChanges, { heatMode: 0, heatStatus: 1 }); // NORMAL + on
  assert.equal(f.handler.isHeating(), true);
});

test('services reconcile when capabilities change', async () => {
  const f = fixture();
  assert.ok(f.handler.boostService);
  f.handler.updateFire({ features: { advancedHeat: true, fanOnly: true, powerBoost: false, rgbLogEffect: true } });
  assert.equal(f.handler.boostService, undefined);
  assert.ok(!f.accessory.services.some((s) => s.subtype === 'turbo-boost'));
  // Unrelated services survive.
  assert.ok(f.handler.ecoService);
});

test('flame-parameter controls are removed once a refresh proves the parameter absent', async () => {
  const f = fixture();
  assert.ok(f.handler.speedService);
  assert.ok(f.handler.mediaService);
  f.client.getFireOverview = async () => ({ parameters: { heat: { heatStatus: 0, heatMode: 0, setpointTemperature: 22 } } });
  await f.handler.refresh();
  assert.equal(f.handler.speedService, undefined);
  assert.equal(f.handler.mediaService, undefined);
  assert.equal(f.handler.overheadService, undefined);
  // Core services remain.
  assert.ok(f.handler.powerService);
  assert.ok(f.handler.flameService);
});

test('an off light keeps showing its last selected Home color', async () => {
  const f = fixture();
  await f.handler.setLightColor('mediaColor', 'hue', 200);
  await f.handler.setLightColor('mediaColor', 'saturation', 80);
  await f.handler.setFlameFlag('mediaLight', false);
  const hsv = f.handler.reportedHsv('mediaColor', f.handler.state.flame.mediaColor);
  assert.equal(hsv.hue, 200);
  assert.equal(hsv.saturation, 80);
  assert.equal(hsv.brightness, 0);
});

test('only one accessory is marked primary', () => {
  const f = fixture();
  const primaries = f.accessory.services.filter((s) => s.isPrimaryService);
  assert.equal(primaries.length, 1);
  assert.equal(primaries[0].subtype, 'power');
});
