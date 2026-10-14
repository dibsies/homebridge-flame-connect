import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import hap from '@homebridge/hap-nodejs';
import { FlameConnectAccessory } from '../src/accessory.js';
import { FlameConnectClient } from '../src/flameconnect/client.js';
import { FlameConnectAuth } from '../src/flameconnect/auth.js';
import { FlameConnectCloudError } from '../src/flameconnect/errors.js';
import { decodeParameter, encodeFlame } from '../src/flameconnect/protocol.js';
import { runCommand, markCommandDispatched } from '../src/flameconnect/command.js';
import { replaceSignIn } from '../src/flameconnect/sign-in.js';
import { readTokenState, withTokenLock, writeTokenState } from '../src/flameconnect/token-store.js';
import { createLightingTrace, lightingState, lightingPackets } from '../src/flameconnect/lighting-trace.js';
import { currentCommandTrace } from '../src/flameconnect/command.js';
import { currentReadTrace } from '../src/flameconnect/lighting-trace.js';
import { performance } from 'node:perf_hooks';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(config = {}) {
  const accessory = new hap.Accessory('Test Fireplace', hap.uuid.generate(`refined-${Math.random()}`));
  accessory.context = {};
  const messages = [];
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [level, (message) => messages.push([level, message])]));
  const client = new FlameConnectClient({}, log);
  const remote = {
    mode: { mode: 1, targetTemperature: 22 },
    flame: { flameEffect: 1, flameSpeed: 4, brightness: 1, mediaTheme: 0, mediaLight: 1, overheadLight: 1,
      mediaColor: { red: 255, green: 0, blue: 0, white: 0 },
      overheadColor: { red: 0, green: 255, blue: 0, white: 0 } },
    heat: { heatStatus: 0, heatMode: 0, setpointTemperature: 22, boostDuration: 1 },
    log: { logEffect: 1, color: { red: 255, green: 0, blue: 0, white: 0 }, pattern: 0 },
  };
  const writes = [];
  let reads = 0;
  client.getFireOverview = async () => { reads += 1; return { parameters: structuredClone(remote) }; };
  client.writeParameters = async (_id, entries) => {
    markCommandDispatched();
    writes.push(entries.map((entry) => decodeParameter(entry.parameterId, entry.value)));
    for (const parameter of writes.at(-1)) remote[parameter.type] = structuredClone(parameter);
  };
  const platform = { config, Service: hap.Service, Characteristic: hap.Characteristic, client, log,
    api: { hap, updatePlatformAccessories() {} } };
  const handler = new FlameConnectAccessory(platform, accessory, { fireId: 'PRIVATE-ID', friendlyName: 'Test Fireplace',
    withHeat: true, features: { advancedHeat: true, fanOnly: true, powerBoost: true, rgbLogEffect: true } });
  return { handler, remote, client, writes, messages, accessory, reads: () => reads };
}

test('normal operation creates no diagnostic command/read context or timing measurements', async (t) => {
  const originalNow = performance.now;
  let timerCalls = 0;
  performance.now = () => { timerCalls += 1; return originalNow.call(performance); };
  const f = fixture({ debugLighting: false }); t.after(() => f.handler.dispose());
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const reader = f.client.getFireOverview;
  f.client.getFireOverview = async (...args) => { assert.equal(currentReadTrace(), undefined); return reader(...args); };
  f.client.auth = { getAccessToken: async () => 'synthetic' };
  f.client.writeParameters = FlameConnectClient.prototype.writeParameters.bind(f.client);
  globalThis.fetch = async (_url, options) => {
    assert.equal(currentCommandTrace(), undefined);
    const body = JSON.parse(options.body);
    for (const entry of body.Parameters) {
      const decoded = decodeParameter(entry.ParameterId, entry.Value);
      f.remote[decoded.type] = decoded;
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  try {
    await f.handler.refresh();
    await f.handler.setLightColor('mediaColor', 'hue', 240);
    assert.equal(f.remote.flame.mediaColor.blue, 255);
    assert.equal(timerCalls, 0);
    assert.ok(!f.messages.some(([, line]) => line.startsWith('Lighting')));
  } finally { performance.now = originalNow; }
});

test('diagnostic inputs, Off, and actual HTTP packets are correlated without private data', async (t) => {
  const f = fixture({ debugLighting: true }); t.after(() => f.handler.dispose());
  useHttpWriter(f, t);
  const captured = [];
  const writer = globalThis.fetch;
  globalThis.fetch = async (url, options) => { captured.push(JSON.parse(options.body)); return writer(url, options); };
  f.client.auth.getAccessToken = async () => 'SYNTHETIC-SECRET-TOKEN';
  f.remote.flame.privateName = 'SYNTHETIC-PRIVATE-NAME';
  f.remote.flame.mediaColor.privateId = 'SYNTHETIC-PRIVATE-ID';
  await f.handler.refresh();
  const light = f.handler.mediaService;
  await Promise.all([
    light.getCharacteristic(hap.Characteristic.Hue).handleSetRequest(240),
    light.getCharacteristic(hap.Characteristic.Saturation).handleSetRequest(100),
    light.getCharacteristic(hap.Characteristic.Brightness).handleSetRequest(75),
  ]);
  await light.getCharacteristic(hap.Characteristic.On).handleSetRequest(false);
  await light.getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
  await f.handler.powerService.getCharacteristic(hap.Characteristic.On).handleSetRequest(false);
  const lines = f.messages.map(([, message]) => message).filter((message) => message.startsWith('LightingTrace '));
  const events = lines.map((line) => JSON.parse(line.slice('LightingTrace '.length)));
  assert.ok(events.some((event) => event.event === 'input.color' && event.field === 'hue' && event.value === 240));
  assert.ok(events.some((event) => event.event === 'input.color' && event.field === 'saturation'));
  assert.ok(events.some((event) => event.event === 'input.color' && event.field === 'brightness'));
  assert.ok(events.some((event) => event.event === 'input.control' && event.control === 'setFlameFlag' && event.values[1] === false));
  assert.ok(events.some((event) => event.event === 'input.control' && event.control === 'setPower'));
  const sends = events.filter((event) => event.event === 'http.send' && event.operation === 'write');
  assert.equal(sends.length, captured.length);
  for (let index = 0; index < sends.length; index += 1) {
    assert.match(sends[index].command, /^c\d+$/);
    for (const packet of sends[index].packets) {
      assert.equal(packet.hex, Buffer.from(captured[index].Parameters.find((p) => p.ParameterId === packet.parameter).Value, 'base64').toString('hex'));
    }
    assert.ok(events.some((event) => event.event === 'http.response' && event.request === sends[index].request && event.command === sends[index].command));
  }
  assert.ok(events.some((event) => event.event === 'overview.received'));
  assert.ok(events.some((event) => event.event === 'home.publish'));
  assert.ok(events.some((event) => event.event === 'home.characteristics' && event.lights.Bed.Hue === 240));
  assert.ok(events.some((event) => event.event === 'auth.ready' && event.durationMs >= 0));
  assert.ok(events.some((event) => event.event === 'http.body.ready' && event.responseBytes >= 0));
  assert.ok(events.some((event) => event.event === 'queue.completed' && event.totalMs >= 0));
  assert.ok(events.some((event) => event.event === 'batch.ready' && event.componentWrites >= 3 && event.stagedMs >= 0));
  for (let index = 1; index < events.length; index += 1) {
    assert.equal(events[index].eventNumber, events[index - 1].eventNumber + 1);
    assert.ok(events[index].elapsedMs >= events[index - 1].elapsedMs);
  }
  assert.doesNotMatch(lines.join('\n'), /PRIVATE-ID|PRIVATE-NAME|SECRET-TOKEN|Test Fireplace|Authorization|Bearer/);
});

test('diagnostics enabled and disabled produce identical HTTP commands and final state', async (t) => {
  async function scenario(enabled) {
    const f = fixture({ debugLighting: enabled });
    useHttpWriter(f, t);
    const packets = [];
    const writer = globalThis.fetch;
    globalThis.fetch = async (url, options) => { packets.push(JSON.parse(options.body).Parameters); return writer(url, options); };
    try {
      await f.handler.refresh();
      await Promise.all([f.handler.setLightColor('mediaColor', 'hue', 240), f.handler.setLightColor('mediaColor', 'saturation', 100)]);
      await f.handler.setFlameFlag('mediaLight', false);
      await f.handler.setFlameFlag('mediaLight', true);
      await f.handler.setLightColor('overheadColor', 'hue', 0);
      await f.handler.setPower(false);
      if (!enabled) assert.ok(!f.messages.some(([, message]) => message.startsWith('LightingTrace ')));
      return { packets, remote: structuredClone(f.remote) };
    } finally { f.handler.dispose(); }
  }
  // Each scenario gets a fresh real client; restore fetch between scenarios
  // so wrappers cannot accidentally capture each other's requests.
  const originalFetch = globalThis.fetch;
  const off = await scenario(false);
  globalThis.fetch = originalFetch;
  const on = await scenario(true);
  globalThis.fetch = originalFetch;
  assert.deepEqual(on, off);
});

test('diagnostic projection omits metadata, unknown packets and extra packet bytes; broken logger is harmless', () => {
  assert.deepEqual(lightingState({ flame: { flameEffect: 1, FireId: 'PRIVATE-ID', mediaColor: { red: 255, green: 0, blue: 0, white: 0, token: 'SECRET' } } }),
    { flame: { flameEffect: 1, mediaColor: { red: 255, green: 0, blue: 0, white: 0 } } });
  const value = encodeFlame({ flameEffect: 1 });
  const extended = Buffer.concat([Buffer.from(value, 'base64'), Buffer.from('PRIVATE-ID')]).toString('base64');
  assert.deepEqual(lightingPackets([{ ParameterId: 999, Value: 'PRIVATE-ID' }, { ParameterId: 322, Value: extended }]), [{ parameter: 322, omitted: true }]);
  const trace = createLightingTrace(() => true, () => 'PRIVATE-ID', { info() { throw new Error('broken logger'); } });
  assert.doesNotThrow(() => trace.emit('test'));
});

test('experiment B lets sequential acknowledged hue/saturation samples form one final HTTP packet', async (t) => {
  const f = fixture({ debugLighting: true });
  t.after(() => f.handler.dispose()); useHttpWriter(f, t); await f.handler.refresh();
  const light = f.handler.mediaService;
  // Model a Home client waiting for each characteristic response before
  // supplying the next sample. Earlier builds could not combine these.
  await light.getCharacteristic(hap.Characteristic.Hue).handleSetRequest(359);
  await light.getCharacteristic(hap.Characteristic.Saturation).handleSetRequest(65);
  await light.getCharacteristic(hap.Characteristic.Hue).handleSetRequest(240);
  await light.getCharacteristic(hap.Characteristic.Saturation).handleSetRequest(100);
  assert.equal(f.writes.length, 0);
  await f.handler.commandQueue;
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.remote.flame.mediaColor, { red: 0, green: 0, blue: 255, white: 0 });
  assert.equal(f.remote.flame.overheadColor.green, 255);
});

test('experiment B settles an accepted input failure and subsequent writes can recover', async (t) => {
  const f = fixture({ debugLighting: true });
  t.after(() => f.handler.dispose()); await f.handler.refresh();
  const original = f.client.writeParameters;
  f.client.writeParameters = async () => { markCommandDispatched(); throw new FlameConnectCloudError('Synthetic failure'); };
  await f.handler.setLightColor('mediaColor', 'hue', 240, true);
  await f.handler.commandQueue;
  await sleep(0);
  assert.equal(f.handler.pendingColors.size, 0);
  assert.equal(f.remote.flame.mediaColor.red, 255);
  assert.ok(f.messages.some(([, line]) => line.includes('input.backgroundFailed')));
  await assert.rejects(f.handler.setLightColor('mediaColor', 'hue', 120, true));
  f.handler.cloudFailureUntil = 0;
  f.client.writeParameters = original;
  await f.handler.setLightColor('mediaColor', 'hue', 240, true);
  await f.handler.commandQueue;
  assert.equal(f.remote.flame.mediaColor.blue, 255);
});

test('experiment B keeps Off ordering and brightness acknowledgement unchanged', async (t) => {
  const f = fixture({  }); t.after(() => f.handler.dispose());
  await f.handler.refresh();
  await f.handler.setLightColor('mediaColor', 'hue', 240, true);
  await f.handler.setFlameFlag('mediaLight', false);
  assert.equal(f.writes.length, 1);
  assert.equal(f.remote.flame.mediaLight, 0);
  assert.equal(f.remote.flame.mediaColor.red, 255);
  await f.handler.setFlameFlag('mediaLight', true);
  assert.equal(f.remote.flame.mediaColor.blue, 255);
  await f.handler.setLightColor('mediaColor', 'brightness', 50, true);
  assert.equal(f.remote.flame.mediaColor.blue, 128);
});

test('C coalesces captured 220/280 ms drag samples into final blue with no near-white packet', async (t) => {
  const f = fixture({ debugLighting: true });
  t.after(() => f.handler.dispose()); useHttpWriter(f, t); await f.handler.refresh();
  const light = f.handler.overheadService;
  const sample = async (hue, saturation) => {
    await light.getCharacteristic(hap.Characteristic.Hue).handleSetRequest(hue);
    await light.getCharacteristic(hap.Characteristic.Saturation).handleSetRequest(saturation);
  };
  await sample(8, 100);
  await sleep(220);
  await sample(262, 22);
  await sleep(280);
  await sample(240, 100);
  await f.handler.commandQueue;
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.remote.flame.overheadColor, { red: 0, green: 0, blue: 255, white: 0 });
});

test('C replaces a ready near-white sample during a blocked overview before preparing its HTTP packet', async (t) => {
  const f = fixture({ commandStateMaxAgeSeconds: 0, debugLighting: true });
  t.after(() => f.handler.dispose()); useHttpWriter(f, t); await f.handler.refresh();
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  f.client.getFireOverview = async () => { entered(); await gate; return { parameters: structuredClone(f.remote) }; };
  await f.handler.setLightColor('mediaColor', 'hue', 262, true);
  await f.handler.setLightColor('mediaColor', 'saturation', 22, true);
  await started;
  await f.handler.setLightColor('mediaColor', 'hue', 240, true);
  await f.handler.setLightColor('mediaColor', 'saturation', 100, true);
  assert.equal(f.handler.queueDepth, 1);
  release(); await f.handler.commandQueue;
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.remote.flame.mediaColor, { red: 0, green: 0, blue: 255, white: 0 });
  assert.ok(f.messages.some(([, line]) => line.includes('batch.superseded')));
});

test('C Off cancels an unsent color even after its batch timer released during a slow read', async (t) => {
  const f = fixture({ commandStateMaxAgeSeconds: 0 });
  t.after(() => f.handler.dispose()); await f.handler.refresh();
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  f.client.getFireOverview = async () => { entered(); await gate; return { parameters: structuredClone(f.remote) }; };
  await f.handler.setLightColor('mediaColor', 'hue', 262, true);
  await started;
  const off = f.handler.setFlameFlag('mediaLight', false);
  release(); await off;
  assert.equal(f.writes.length, 1);
  assert.equal(f.remote.flame.mediaLight, 0);
  assert.equal(f.remote.flame.mediaColor.red, 255);
});

test('C whole-fireplace Off cancels ready unsent colors during a slow read', async (t) => {
  const f = fixture({ commandStateMaxAgeSeconds: 0 });
  t.after(() => f.handler.dispose()); await f.handler.refresh();
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  f.client.getFireOverview = async () => { entered(); await gate; return { parameters: structuredClone(f.remote) }; };
  await f.handler.setLightColor('mediaColor', 'hue', 262, true);
  await started;
  const off = f.handler.setPower(false);
  release(); await off;
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0][0].type, 'mode');
  assert.equal(f.remote.mode.mode, 0);
});

test('C shutdown cancels ready unsent color and settles detached input failures', async (t) => {
  const f = fixture({ commandStateMaxAgeSeconds: 0 });
  t.after(() => f.handler.dispose()); await f.handler.refresh();
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  f.client.getFireOverview = async () => { entered(); await gate; return { parameters: structuredClone(f.remote) }; };
  await f.handler.setLightColor('mediaColor', 'hue', 262, true);
  await started;
  f.handler.dispose(); release();
  await f.handler.commandQueue; await sleep(0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.handler.colorOperations.size, 0);
});

test('C cannot merge a new color across a heater ordering boundary', async (t) => {
  const f = fixture({ commandStateMaxAgeSeconds: 0 });
  t.after(() => f.handler.dispose()); await f.handler.refresh();
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  f.client.getFireOverview = async () => { entered(); await gate; return { parameters: structuredClone(f.remote) }; };
  await f.handler.setLightColor('mediaColor', 'hue', 262, true);
  await f.handler.setLightColor('mediaColor', 'saturation', 22, true);
  await started;
  const heat = f.handler.setHeat(true);
  await f.handler.setLightColor('mediaColor', 'hue', 240, true);
  await f.handler.setLightColor('mediaColor', 'saturation', 100, true);
  release(); await heat; await f.handler.commandQueue;
  assert.deepEqual(f.writes.map((packet) => packet[0].type), ['flame', 'heat', 'flame']);
  assert.equal(f.writes[0][0].mediaColor.white, 199);
  assert.equal(f.remote.flame.mediaColor.blue, 255);
  assert.equal(f.remote.heat.heatStatus, 1);
});

test('C freezes already transmitted color packets instead of modifying or replaying them', async (t) => {
  const f = fixture({  });
  t.after(() => f.handler.dispose()); useHttpWriter(f, t); await f.handler.refresh();
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const writer = globalThis.fetch;
  let firstBody;
  globalThis.fetch = async (url, options) => {
    const response = await writer(url, options);
    if (!firstBody) { firstBody = options.body; entered(); await gate; }
    return response;
  };
  await f.handler.setLightColor('mediaColor', 'hue', 262, true);
  await f.handler.setLightColor('mediaColor', 'saturation', 22, true);
  await started;
  await f.handler.setLightColor('mediaColor', 'hue', 240, true);
  await f.handler.setLightColor('mediaColor', 'saturation', 100, true);
  release(); await f.handler.commandQueue;
  assert.equal(f.writes.length, 2);
  const sent = JSON.parse(firstBody).Parameters[0];
  assert.equal(decodeParameter(sent.ParameterId, sent.Value).mediaColor.white, 199);
  assert.equal(f.remote.flame.mediaColor.blue, 255);
});

test('an expired pre-read never submits the power command', async (t) => {
  const f = fixture({ commandStateMaxAgeSeconds: 0 });
  t.after(() => f.handler.dispose());
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    f.client.getFireOverview = async () => { now += 9000; return { parameters: structuredClone(f.remote) }; };
    await assert.rejects(f.handler.setPower(true), (error) => error.hapStatus === hap.HAPStatus.OPERATION_TIMED_OUT);
    assert.equal(f.writes.length, 0);
  } finally { Date.now = originalNow; }
});

test('transport checks expiry again after authentication and after a rejected write', async () => {
  const originalFetch = globalThis.fetch;
  let submitted = 0;
  globalThis.fetch = async () => { submitted += 1; return { ok: false, status: 401, text: async () => '' }; };
  const entry = { deadlineAt: Date.now() + 8000, isDisposed: () => false };
  const client = new FlameConnectClient({ getAccessToken: async () => { entry.cancelled = true; return 'synthetic'; } });
  try {
    await assert.rejects(runCommand(entry, () => client.writeParameters('test', [])), (error) => error.kind === 'timeout');
    assert.equal(submitted, 0);
    entry.cancelled = false;
    client.auth.getAccessToken = async (force) => { if (force) entry.cancelled = true; return 'synthetic'; };
    await assert.rejects(runCommand(entry, () => client.writeParameters('test', [])), (error) => error.code === 'FLAMECONNECT_WRITE_AUTH_REFRESHED');
    assert.equal(entry.dispatched, false);
    await assert.rejects(runCommand(entry, () => client.writeParameters('test', [])), (error) => error.kind === 'timeout');
    assert.equal(submitted, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('shutdown during a pre-read prevents the pending mutation', async () => {
  const f = fixture();
  f.client.getFireOverview = async () => { f.handler.dispose(); return { parameters: structuredClone(f.remote) }; };
  await assert.rejects(f.handler.setPower(true));
  assert.equal(f.writes.length, 0);
});

test('continuous commands do not extend the overview freshness window', async (t) => {
  const f = fixture(); t.after(() => f.handler.dispose());
  const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
  try {
    await f.handler.refresh();
    for (let n = 0; n < 5; n += 1) { now += 9000; await f.handler.setFlames(n % 2 === 0); }
    assert.equal(f.reads(), 3);
  } finally { Date.now = originalNow; }
});

test('a lagging post-write overview cannot undo Flames On or overwrite it during a brightness write', async (t) => {
  const f = fixture({ cacheSeconds: 5 }); t.after(() => f.handler.dispose());
  f.remote.flame.flameEffect = 0;
  f.remote.flame.brightness = 1; // LOW
  const stale = structuredClone(f.remote);
  f.client.getFireOverview = async () => ({ parameters: structuredClone(stale) });
  await f.handler.refresh();
  await f.handler.setFlames(true);
  // The cloud accepted the write, but the overview is still an older echo.
  await f.handler.refresh();
  assert.equal(await f.handler.getFlames(), true);
  assert.equal(f.remote.flame.flameEffect, 1);
  await f.handler.setFlameBrightness(100);
  assert.equal(f.remote.flame.flameEffect, 1);
  assert.equal(f.remote.flame.brightness, 0); // HIGH
  await f.handler.refresh();
  assert.equal(await f.handler.getFlameBrightness(), 100);
});

test('recent write reconciliation accepts unrelated cloud changes and expires after ten seconds', async (t) => {
  const f = fixture(); t.after(() => f.handler.dispose());
  f.remote.flame.flameEffect = 0;
  const stale = structuredClone(f.remote);
  f.client.getFireOverview = async () => ({ parameters: structuredClone(stale) });
  const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
  try {
    await f.handler.refresh();
    await f.handler.setFlames(true);
    stale.flame.overheadColor = { red: 0, green: 0, blue: 200, white: 0 };
    await f.handler.refresh();
    assert.equal(f.handler.state.flame.flameEffect, 1);
    assert.equal(f.handler.state.flame.overheadColor.blue, 200);
    now += 10001;
    assert.equal(await f.handler.getFlames(), false);
    assert.equal(f.handler.pendingAcknowledgements.size, 0);
  } finally { Date.now = originalNow; }
});

test('a matching echo followed by an older echo cannot reverse the latest flame command', async (t) => {
  const f = fixture(); t.after(() => f.handler.dispose()); await f.handler.refresh();
  await f.handler.setFlames(false);
  await f.handler.refresh(); // matches the latest Off command
  f.client.getFireOverview = async () => ({ parameters: { ...structuredClone(f.remote),
    flame: { ...structuredClone(f.remote.flame), flameEffect: 1 } } });
  await f.handler.refresh();
  assert.equal(await f.handler.getFlames(), false);
});

test('both native flame brightness levels remain effective while the cloud echoes older state', async (t) => {
  const f = fixture(); t.after(() => f.handler.dispose());
  const stale = structuredClone(f.remote);
  f.client.getFireOverview = async () => ({ parameters: structuredClone(stale) });
  await f.handler.refresh();
  for (const level of [100, 50, 100, 50]) {
    await f.handler.flameService.getCharacteristic(hap.Characteristic.Brightness).handleSetRequest(level);
    await f.handler.refresh();
    assert.equal(await f.handler.getFlameBrightness(), level);
    assert.equal(f.remote.flame.brightness, level === 100 ? 0 : 1);
    assert.equal(f.remote.flame.flameEffect, 1);
  }
});

test('failed or undecoded overviews invalidate mutation trust at default freshness', async (t) => {
  const f = fixture(); t.after(() => f.handler.dispose()); await f.handler.refresh();
  const good = f.client.getFireOverview;
  f.client.getFireOverview = async () => ({ parameters: { mode: f.remote.mode }, decodeErrors: [322] });
  await assert.rejects(f.handler.refresh());
  assert.equal(f.handler.snapshotTrusted, false);
  f.handler.cloudFailureUntil = 0;
  f.client.getFireOverview = good;
  await f.handler.setFlames(false);
  assert.equal(f.reads(), 2);
  assert.equal(f.handler.snapshotTrusted, true);
});

test('a cold empty snapshot fails and power cannot invent a missing mode', async (t) => {
  const f = fixture(); t.after(() => f.handler.dispose());
  f.client.getFireOverview = async () => ({ parameters: {} });
  await assert.rejects(f.handler.getPower());
  assert.equal(f.handler.lastRefresh, 0);
  f.handler.cloudFailureUntil = 0;
  f.client.getFireOverview = async () => ({ parameters: { flame: f.remote.flame } });
  await assert.rejects(f.handler.setPower(true));
  assert.equal(f.writes.length, 0);
});

test('a second color component cannot join an already-failed batch', async (t) => {
  const f = fixture(); t.after(() => f.handler.dispose()); await f.handler.refresh();
  f.handler.cloudFailureUntil = Date.now() + 2000;
  f.handler.lastCloudError = new FlameConnectCloudError('Synthetic outage');
  await assert.rejects(f.handler.setLightColor('mediaColor', 'hue', 120));
  const result = await Promise.race([
    f.handler.setLightColor('mediaColor', 'saturation', 90).then(() => 'success', () => 'failed'),
    sleep(300).then(() => 'hung'),
  ]);
  assert.equal(result, 'failed');
  assert.equal(f.handler.pendingColors.size, 0);
  assert.equal(f.handler.colorOperations.size, 0);
});

test('a continuous gesture has a bounded batch and cannot hold power hostage', async (t) => {
  const f = fixture(); t.after(() => f.handler.dispose()); await f.handler.refresh();
  const colors = [];
  for (let n = 0; n < 18; n += 1) {
    colors.push(f.handler.setLightColor('mediaColor', 'hue', n * 10));
    await sleep(50);
  }
  assert.ok(f.writes.length >= 1, 'the first batch must dispatch even though input continues');
  const power = f.handler.setPower(false);
  await Promise.all([...colors, power]);
  assert.equal(f.remote.mode.mode, 0);
});

test('non-color commands form an ordering boundary for later color input', async (t) => {
  const f = fixture(); t.after(() => f.handler.dispose()); await f.handler.refresh();
  await Promise.all([f.handler.setLightColor('mediaColor', 'hue', 120), f.handler.setHeat(true),
    f.handler.setLightColor('mediaColor', 'hue', 240)]);
  assert.deepEqual(f.writes.map((entries) => entries[0].type), ['flame', 'heat', 'flame']);
});

test('real HAP On and RGB components dispatch one final color without an intermediate white packet', async (t) => {
  const f = fixture(); t.after(() => f.handler.dispose()); await f.handler.refresh();
  const light = f.handler.mediaService;
  for (const hue of [240, 0, 240, 0]) {
    const before = f.writes.length;
    await Promise.all([
      light.getCharacteristic(hap.Characteristic.On).handleSetRequest(true),
      light.getCharacteristic(hap.Characteristic.Hue).handleSetRequest(hue),
      light.getCharacteristic(hap.Characteristic.Saturation).handleSetRequest(100),
      light.getCharacteristic(hap.Characteristic.Brightness).handleSetRequest(100),
    ]);
    assert.equal(f.writes.length, before + 1);
    const color = f.writes.at(-1)[0].mediaColor;
    assert.equal(color.white, 0);
    assert.equal(color[hue === 240 ? 'blue' : 'red'], 255);
    assert.deepEqual(f.remote.flame.overheadColor, { red: 0, green: 255, blue: 0, white: 0 });
  }
});

test('off cancels a staged color and on restores it atomically', async (t) => {
  const f = fixture(); t.after(() => f.handler.dispose()); await f.handler.refresh();
  await Promise.all([f.handler.setLightColor('mediaColor', 'hue', 240), f.handler.setFlameFlag('mediaLight', false)]);
  assert.equal(f.writes.length, 1);
  await f.handler.setFlameFlag('mediaLight', true);
  assert.equal(f.remote.flame.mediaLight, 1);
  assert.deepEqual(f.remote.flame.mediaColor, { red: 0, green: 0, blue: 255, white: 0 });
  assert.equal(f.writes.length, 2);
});

test('dim-to-zero retains the picker and restores the last nonzero brightness on On', async (t) => {
  const f = fixture(); t.after(() => f.handler.dispose()); await f.handler.refresh();
  await f.handler.setLightColor('mediaColor', 'brightness', 40);
  await f.handler.setLightColor('mediaColor', 'brightness', 0);
  assert.equal(f.handler.reportedHsv('mediaColor', f.remote.flame.mediaColor).saturation, 100);
  await f.handler.setFlameFlag('mediaLight', true);
  assert.equal(f.remote.flame.mediaColor.red, 102);
});

test('white remains selectable and an achromatic color preserves hue between sequential components', async (t) => {
  const f = fixture(); t.after(() => f.handler.dispose()); await f.handler.refresh();
  await f.handler.setLightColor('mediaColor', 'saturation', 0);
  assert.equal(f.remote.flame.mediaColor.white, 255);
  await f.handler.setLightColor('mediaColor', 'hue', 240);
  await f.handler.setLightColor('mediaColor', 'saturation', 100);
  assert.equal(f.remote.flame.mediaColor.blue, 255);
});

test('observed app-side color is remembered through Off and restart', async (t) => {
  const f = fixture(); t.after(() => f.handler.dispose()); await f.handler.refresh();
  f.remote.flame.mediaColor = { red: 0, green: 0, blue: 180, white: 0 };
  await f.handler.refresh();
  await f.handler.setFlameFlag('mediaLight', false);
  assert.equal(f.handler.reportedHsv('mediaColor', f.remote.flame.mediaColor).hue, 240);
  await f.handler.setFlameFlag('mediaLight', true);
  assert.equal(f.remote.flame.mediaColor.blue, 180);
});

test('omitted overview metadata preserves identity and features; conflicts fail closed', async (t) => {
  const f = fixture(); t.after(() => f.handler.dispose());
  f.handler.updateFire({ features: {} });
  assert.ok(f.handler.boostService);
  assert.equal(f.handler.fire.fireId, 'PRIVATE-ID');
  assert.throws(() => f.handler.updateFire({ fireId: 'different' }), /conflicting/);
  f.client.request = async () => ({ ResultCode: 0, WifiFireOverview: { Parameters: [
    { ParameterId: 322, Value: encodeFlame(f.remote.flame) },
  ] } });
  const overview = await FlameConnectClient.prototype.getFireOverview.call(f.client, 'PRIVATE-ID');
  assert.deepEqual(overview.fire.features, {});
  assert.equal(overview.fire.fireId, undefined);
});

test('missing authentication becomes a HAP communication error and speed is not reset on refresh', async (t) => {
  const f = fixture(); t.after(() => f.handler.dispose()); await f.handler.refresh();
  const values = [];
  const speed = f.handler.speedService.getCharacteristic(hap.Characteristic.RotationSpeed);
  speed.on('change', ({ newValue }) => values.push(newValue));
  await f.handler.refresh();
  assert.ok(!values.includes(20));
  const noToken = Object.assign(new Error('Missing sign-in'), { code: 'FLAMECONNECT_NO_TOKEN' });
  const mapped = f.handler.toHapError(noToken);
  assert.equal(mapped.hapStatus, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  assert.equal(mapped.code, noToken.code);
});

test('API errors redact identifiers and long Retry-After stops further requests', async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: false, status: 429, headers: { get: () => '60' }, text: async () => '' }; };
  try {
    const client = new FlameConnectClient({ getAccessToken: async () => 'synthetic' });
    await assert.rejects(client.getFireOverview('PRIVATE-ID'), (error) => error.retryAfterMs === 60000 && !error.message.includes('PRIVATE-ID'));
    await assert.rejects(client.getFires());
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('HTTP write success does not require a ResultCode; explicit failures still reject', async () => {
  const originalFetch = globalThis.fetch;
  const client = new FlameConnectClient({ getAccessToken: async () => 'synthetic' });
  try {
    for (const body of ['', '{}', '[]', '"ok"', '{"Success":true}', '{"ResultCode":0}', '{"ResultCode":"0"}']) {
      globalThis.fetch = async () => new Response(body || null, { status: body ? 200 : 204 });
      await client.writeParameters('synthetic', []);
    }
    for (const body of [{ ResultCode: 'not-a-number' }, { ResultCode: null }, { ResultCode: '' }]) {
      globalThis.fetch = async () => new Response(JSON.stringify(body));
      await assert.rejects(client.writeParameters('synthetic', []), /unconfirmed/);
    }
    globalThis.fetch = async () => new Response('{"ResultCode":1}');
    await assert.rejects(client.writeParameters('synthetic', []), (error) => error.kind === 'rejected' && error.resultCode === 1);
    globalThis.fetch = async () => new Response('not-json');
    await assert.rejects(client.writeParameters('synthetic', []), /invalid response/);
    globalThis.fetch = async () => new Response('{}', { status: 500 });
    await assert.rejects(client.writeParameters('synthetic', []), /HTTP 500/);
  } finally { globalThis.fetch = originalFetch; }
});

test('new explicit authentication replaces a revoked file and survives restart; invalid replacement preserves it', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flame-new-signin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'tokens.json');
  await writeTokenState(file, { refreshToken: 'synthetic-revoked' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '[]' });
  try {
    await replaceSignIn({ access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh', expires_in: 3600 }, file);
    const auth = new FlameConnectAuth({ refreshToken: 'synthetic-old-config', tokenFile: file });
    assert.equal(await auth.getAccessToken(), 'synthetic-new-access');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '' });
    await assert.rejects(replaceSignIn({ access_token: 'bad', refresh_token: 'bad', expires_in: 3600 }, file));
    assert.equal((await readTokenState(file)).refreshToken, 'synthetic-new-refresh');
  } finally { globalThis.fetch = originalFetch; }
});

test('independent authentication instances coordinate token rotation through storage', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flame-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'tokens.json');
  await writeTokenState(file, { refreshToken: 'synthetic-old', expiresAt: 0 });
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls += 1; await sleep(25); return { ok: true, status: 200,
    text: async () => JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-rotated', expires_in: 3600 }) }; };
  try {
    const first = new FlameConnectAuth({ tokenFile: file });
    const second = new FlameConnectAuth({ tokenFile: file });
    assert.deepEqual(await Promise.all([first.getAccessToken(), second.getAccessToken()]), ['synthetic-access', 'synthetic-access']);
    assert.equal(calls, 1);
    assert.equal((await readTokenState(file)).refreshToken, 'synthetic-rotated');
  } finally { globalThis.fetch = originalFetch; }
});

test('token-file locking is bounded and does not disturb another owner', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flame-lock-limit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'tokens.json');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const first = withTokenLock(file, async () => { ready(); await gate; });
  await started;
  try {
    await assert.rejects(withTokenLock(file, async () => {}, 1), (error) => error.kind === 'timeout');
    assert.ok((await readFile(`${file}.lock`, 'utf8')).includes('owner'));
  } finally { release(); await first; }
});

test('lighting diagnostics contain only control values and anonymous labels', async (t) => {
  const f = fixture({ debugLighting: true }); t.after(() => f.handler.dispose()); await f.handler.refresh();
  await f.handler.setLightColor('mediaColor', 'hue', 240);
  const lighting = f.messages.filter(([level, message]) => level === 'info' && message.startsWith('Lighting'));
  assert.ok(lighting.length >= 3);
  assert.ok(lighting.every(([, message]) => !message.includes('PRIVATE-ID') && !message.includes('Test Fireplace')));
});

// Keep real request/response handling in the HAP matrix. Mocking
// writeParameters itself previously hid the missing-ResultCode regression.
function useHttpWriter(f, t) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  f.client.auth = { getAccessToken: async () => 'synthetic' };
  f.client.writeParameters = FlameConnectClient.prototype.writeParameters.bind(f.client);
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    f.writes.push(body.Parameters.map((entry) => decodeParameter(entry.ParameterId, entry.Value)));
    for (const parameter of f.writes.at(-1)) f.remote[parameter.type] = structuredClone(parameter);
    return new Response(f.writes.length % 2 ? '{}' : '{"Success":true}');
  };
}

test('an explicit HTTP command rejection does not update HomeKit as a success', async (t) => {
  const f = fixture(); t.after(() => f.handler.dispose());
  useHttpWriter(f, t);
  globalThis.fetch = async () => new Response('{"ResultCode":1}');
  await f.handler.refresh();
  await assert.rejects(f.handler.flameService.getCharacteristic(hap.Characteristic.On).handleSetRequest(false));
  assert.equal(f.handler.state.flame.flameEffect, 1);
  assert.equal(f.remote.flame.flameEffect, 1);
});

const delayedControlCases = [
  ['Fireplace power', 'powerService', 'On', [false, true], (f, value) => assert.equal(f.remote.mode.mode, value ? 1 : 0)],
  ['Flames', 'flameService', 'On', [false, true], (f, value) => assert.equal(f.remote.flame.flameEffect, value ? 1 : 0)],
  ['Flame brightness', 'flameService', 'Brightness', [100, 50], (f, value) => assert.equal(f.remote.flame.brightness, value === 100 ? 0 : 1)],
  ['Flame speed', 'speedService', 'RotationSpeed', [20, 100], (f, value) => assert.equal(f.remote.flame.flameSpeed, value / 20)],
  ['Flame speed active', 'speedService', 'Active', [0, 1], (f, value) => assert.equal(f.remote.flame.flameEffect, value)],
  ['Heater power', 'heatService', 'TargetHeatingCoolingState', [1, 0], (f, value) => assert.equal(f.remote.heat.heatStatus, value)],
  ['Heater temperature', 'heatService', 'TargetTemperature', [21.5, 24.5], (f, value) => assert.equal(f.remote.heat.setpointTemperature, value)],
  ['Eco mode', 'ecoService', 'On', [true, false], (f, value) => { assert.equal(f.remote.heat.heatMode, value ? 2 : 0); assert.equal(f.remote.heat.heatStatus, 0); }],
  ['Fan Only', 'fanOnlyService', 'Active', [1, 0], (f, value) => { assert.equal(f.remote.heat.heatStatus, value); assert.equal(f.remote.heat.heatMode, value ? 3 : 0); }],
  ['Turbo Boost', 'boostService', 'On', [true, false], (f, value) => { assert.equal(f.remote.heat.heatStatus, value ? 1 : 0); assert.equal(f.remote.heat.heatMode, value ? 1 : 0); }],
  ['Media Bed power', 'mediaService', 'On', [false, true], (f, value) => assert.equal(f.remote.flame.mediaLight, value ? 1 : 0)],
  ['Media Accent power', 'overheadService', 'On', [false, true], (f, value) => assert.equal(f.remote.flame.overheadLight, value ? 1 : 0)],
  ['Logs power', 'logService', 'On', [false, true], (f, value) => assert.equal(f.remote.log.logEffect, value ? 1 : 0)],
  ['Pulsating Effect', 'pulseService', 'On', [true, false], (f, value) => assert.equal(f.remote.flame.pulsatingEffect, value ? 1 : 0)],
  ['Ambient Sensor', 'ambientService', 'On', [true, false], (f, value) => assert.equal(f.remote.flame.ambientSensor, value ? 1 : 0)],
];

for (const [name, serviceKey, characteristicKey, values, check] of delayedControlCases) {
  test(`${name} stays correct through delayed cloud reads and a subsequent reverse command`, async (t) => {
    const f = fixture({ advancedControls: true, commandStateMaxAgeSeconds: 0 });
    t.after(() => f.handler.dispose());
    useHttpWriter(f, t);
    const stale = structuredClone(f.remote);
    f.client.getFireOverview = async () => ({ parameters: structuredClone(stale) });
    await f.handler.refresh();
    const characteristic = f.handler[serviceKey].getCharacteristic(hap.Characteristic[characteristicKey]);
    for (const value of values) {
      await characteristic.handleSetRequest(value);
      check(f, value);
      await f.handler.refresh();
      assert.equal(await characteristic.handleGetRequest(), value);
      check(f, value);
      if (serviceKey === 'fanOnlyService') {
        assert.equal(await f.handler.getHeatTargetState(), 0);
        assert.equal(await f.handler.getHeatCurrentState(), 0);
      }
      if (characteristicKey === 'TargetTemperature') {
        assert.equal(await f.handler.heatService.getCharacteristic(hap.Characteristic.CurrentTemperature).handleGetRequest(), value);
      }
      if (characteristicKey === 'TargetHeatingCoolingState') {
        assert.equal(await f.handler.getHeatCurrentState(), value);
      }
    }
  });
}

for (const [name, serviceKey, parameterKey, colorKey] of [
  ['Media Bed', 'mediaService', 'flame', 'mediaColor'],
  ['Media Accent', 'overheadService', 'flame', 'overheadColor'],
  ['Logs', 'logService', 'log', 'color'],
]) {
  test(`${name} color and dimming survive cloud lag without overwriting other controls`, async (t) => {
    const f = fixture({ commandStateMaxAgeSeconds: 0 }); t.after(() => f.handler.dispose());
    useHttpWriter(f, t);
    const stale = structuredClone(f.remote);
    f.client.getFireOverview = async () => ({ parameters: structuredClone(stale) });
    await f.handler.refresh();
    const service = f.handler[serviceKey];
    for (const [hue, brightness] of [[240, 50], [0, 80]]) {
      await Promise.all([
        service.getCharacteristic(hap.Characteristic.Hue).handleSetRequest(hue),
        service.getCharacteristic(hap.Characteristic.Saturation).handleSetRequest(100),
        service.getCharacteristic(hap.Characteristic.Brightness).handleSetRequest(brightness),
      ]);
      await f.handler.refresh();
      assert.equal(await service.getCharacteristic(hap.Characteristic.Hue).handleGetRequest(), hue);
      assert.equal(await service.getCharacteristic(hap.Characteristic.Saturation).handleGetRequest(), 100);
      assert.ok(Math.abs(await service.getCharacteristic(hap.Characteristic.Brightness).handleGetRequest() - brightness) < 0.5);
      assert.equal(f.remote[parameterKey][colorKey][hue === 240 ? 'blue' : 'red'], Math.round(brightness / 100 * 255));
      assert.equal(f.remote.heat.heatStatus, 0);
      assert.equal(f.remote.flame.flameEffect, 1);
      if (colorKey !== 'overheadColor') assert.deepEqual(f.remote.flame.overheadColor, stale.flame.overheadColor);
      if (colorKey !== 'mediaColor') assert.deepEqual(f.remote.flame.mediaColor, stale.flame.mediaColor);
      if (parameterKey === 'flame') assert.deepEqual(f.remote.log.color, stale.log.color);
    }
  });
}

test('mixed heat, fan, flame, speed, and lighting commands preserve the latest intentions with lagging pre-reads', async (t) => {
  const f = fixture({ commandStateMaxAgeSeconds: 0 }); t.after(() => f.handler.dispose());
  const stale = structuredClone(f.remote);
  f.client.getFireOverview = async () => ({ parameters: structuredClone(stale) });
  await f.handler.refresh();
  await f.handler.setHeat(true);
  await f.handler.setFanOnly(true);
  await f.handler.setHeatTemperature(23.5);
  await f.handler.setFlames(false);
  await f.handler.setFlameSpeed(20);
  await f.handler.setLightColor('mediaColor', 'hue', 240);
  await f.handler.setLightColor('overheadColor', 'hue', 0);
  await f.handler.setLogs(false);
  await f.handler.refresh();
  assert.equal(f.remote.heat.heatMode, 3);
  assert.equal(f.remote.heat.heatStatus, 1);
  assert.equal(f.remote.heat.setpointTemperature, 23.5);
  assert.equal(await f.handler.getHeatTargetState(), 0, 'fan-only must never be reported as heating');
  assert.equal(f.remote.flame.flameEffect, 0);
  assert.equal(f.remote.flame.flameSpeed, 1);
  assert.equal(f.remote.flame.mediaColor.blue, 255);
  assert.equal(f.remote.flame.overheadColor.red, 255);
  assert.equal(f.remote.log.logEffect, 0);
});

test('an uncertain later write cannot leave an older acknowledgement overriding the recovery read', async (t) => {
  const f = fixture(); t.after(() => f.handler.dispose());
  f.remote.flame.flameEffect = 0;
  await f.handler.refresh();
  await f.handler.setFlames(true);
  assert.ok(f.handler.pendingAcknowledgements.size > 0);
  const write = f.client.writeParameters;
  f.client.writeParameters = async (...args) => {
    await write(...args); // The unit may have received the command even though its response was lost.
    throw new FlameConnectCloudError('Synthetic lost response', { kind: 'timeout' });
  };
  await assert.rejects(f.handler.setFlames(false));
  assert.equal(f.handler.pendingAcknowledgements.size, 0);
  f.client.writeParameters = write;
  f.handler.cloudFailureUntil = 0;
  await f.handler.refresh();
  assert.equal(await f.handler.getFlames(), false);
  await f.handler.setFlameBrightness(100);
  assert.equal(f.remote.flame.flameEffect, 0, 'a brightness change must not resurrect an uncertain earlier On');
});
