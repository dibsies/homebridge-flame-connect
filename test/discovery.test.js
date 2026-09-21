import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import initializer from '../src/index.js';
import { applyServiceName, controlEnabled, mergeFireMetadata } from '../src/accessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.js';

test('package metadata satisfies Homebridge plugin discovery rules', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.name, /^(?:@[^/]+\/)?homebridge-[\w-]+$/u);
  assert.equal(pkg.name, PLUGIN_NAME);
  assert.ok(pkg.keywords.includes('homebridge-plugin'));
  assert.ok(pkg.keywords.includes('supports-hap'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'src/index.js');
  assert.equal(pkg.private, undefined);
});

test('default ESM initializer registers the dynamic platform', () => {
  const calls = [];
  initializer({ registerPlatform: (...args) => calls.push(args) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], PLATFORM_NAME);
  assert.equal(typeof calls[0][1], 'function');
});

test('config schema alias matches registered platform', async () => {
  const schema = JSON.parse(await readFile(new URL('../config.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.pluginAlias, PLATFORM_NAME);
  assert.equal(schema.pluginType, 'platform');
});

test('service names include the modern HomeKit configured name', () => {
  const calls = [];
  const service = {
    displayName: '',
    addOptionalCharacteristic: (characteristic) => calls.push(['optional', characteristic]),
    setCharacteristic: (characteristic, value) => {
      calls.push(['set', characteristic, value]);
      return service;
    },
  };
  const Characteristic = { Name: 'Name', ConfiguredName: 'ConfiguredName' };

  applyServiceName(service, Characteristic, 'Living Room Fire Flames');

  assert.equal(service.displayName, 'Living Room Fire Flames');
  assert.deepEqual(calls, [
    ['set', 'Name', 'Living Room Fire Flames'],
    ['optional', 'ConfiguredName'],
    ['set', 'ConfiguredName', 'Living Room Fire Flames'],
  ]);
});

test('individual controls default to enabled and can be disabled', () => {
  assert.equal(controlEnabled({}, 'exposeHeater'), true);
  assert.equal(controlEnabled({ exposeHeater: true }, 'exposeHeater'), true);
  assert.equal(controlEnabled({ exposeHeater: false }, 'exposeHeater'), false);
});

test('device overview cannot replace the authoritative friendly name with a hardware id', () => {
  const cached = { fireId: 'fire-1', friendlyName: '0702222A0006' };
  const accountDevice = { fireId: 'fire-1', friendlyName: 'Living Room Fire' };
  const overview = { fireId: 'fire-1', friendlyName: '0702222A0006', withHeat: true };

  const authoritative = mergeFireMetadata(cached, accountDevice, true);
  const refreshed = mergeFireMetadata(authoritative, overview);

  assert.equal(authoritative.friendlyName, 'Living Room Fire');
  assert.equal(refreshed.friendlyName, 'Living Room Fire');
  assert.equal(refreshed.withHeat, true);
});

test('config schema exposes individual control toggles', async () => {
  const schema = JSON.parse(await readFile(new URL('../config.schema.json', import.meta.url), 'utf8'));
  for (const key of [
    'exposePower', 'exposeFlames', 'exposeHeater',
    'exposeMediaLight', 'exposeOverheadLight', 'exposeLogs',
  ]) {
    assert.equal(schema.schema.properties[key].type, 'boolean');
    assert.equal(schema.schema.properties[key].default, true);
    assert.ok(schema.layout.includes(key));
  }
});
