import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import initializer from '../src/index.js';
import {
  applyServiceName,
  applyServiceNameIfGenerated,
  controlEnabled,
  mergeFireMetadata,
} from '../src/accessory.js';
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
  assert.equal(pkg.version, '1.0.0-rc.1');
  assert.deepEqual(pkg.author, {
    name: 'dibsies',
    url: 'https://github.com/dibsies',
  });
  assert.equal(pkg.dependencies['@homebridge/plugin-ui-utils'], '^2.2.6');
  assert.ok(pkg.files.includes('homebridge-ui'));
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
  assert.equal(schema.customUi, true);
});

test('custom UI provides direct and browser-fallback sign-in paths', async () => {
  const html = await readFile(new URL('../homebridge-ui/public/index.html', import.meta.url), 'utf8');
  const server = await readFile(new URL('../homebridge-ui/server.js', import.meta.url), 'utf8');
  assert.match(html, /Start sign-in/u);
  assert.match(html, /Sign in and connect/u);
  assert.match(html, /Complete sign-in/u);
  assert.match(server, /parseAuthorizationRedirect/u);
  assert.match(html, /type=["']password["']/u);
  assert.match(html, /passwordInput\.value = ''/u);
  assert.doesNotMatch(server, /console\.(?:log|debug).*token/iu);
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

test('generated service labels migrate while Apple Home custom labels are preserved', () => {
  const C = { Name: 'Name', ConfiguredName: 'ConfiguredName' };
  const makeService = (value) => {
    const values = { Name: value, ConfiguredName: value };
    const service = {
      displayName: value,
      getCharacteristic: (key) => ({ value: values[key] }),
      addOptionalCharacteristic: () => {},
      setCharacteristic: (key, next) => {
        values[key] = next;
        return service;
      },
    };
    return service;
  };

  const generated = makeService('Living Room Fire Flames');
  applyServiceNameIfGenerated(generated, C, 'Flames', ['Living Room Fire Flames']);
  assert.equal(generated.displayName, 'Flames');

  const custom = makeService('Cozy Fire');
  applyServiceNameIfGenerated(custom, C, 'Flames', ['Living Room Fire Flames']);
  assert.equal(custom.displayName, 'Cozy Fire');

  const customConfigured = makeService('Living Room Fire Flames');
  customConfigured.getCharacteristic = (key) => ({
    value: key === C.ConfiguredName ? 'My Custom Flames' : 'Living Room Fire Flames',
  });
  applyServiceNameIfGenerated(customConfigured, C, 'Flames', ['Living Room Fire Flames']);
  assert.equal(customConfigured.displayName, 'Living Room Fire Flames');
});

test('device overview cannot replace the authoritative friendly name with a hardware id', () => {
  const cached = { fireId: 'fire-1', friendlyName: 'HARDWARE-ID-EXAMPLE' };
  const accountDevice = { fireId: 'fire-1', friendlyName: 'Living Room Fire' };
  const overview = { fireId: 'fire-1', friendlyName: 'HARDWARE-ID-EXAMPLE', withHeat: true };

  const authoritative = mergeFireMetadata(cached, accountDevice, true);
  const refreshed = mergeFireMetadata(authoritative, overview);

  assert.equal(authoritative.friendlyName, 'Living Room Fire');
  assert.equal(refreshed.friendlyName, 'Living Room Fire');
  assert.equal(refreshed.withHeat, true);
});

test('config schema exposes individual control toggles', async () => {
  const schema = JSON.parse(await readFile(new URL('../config.schema.json', import.meta.url), 'utf8'));
  for (const key of [
    'exposePower', 'exposeFlames', 'exposeHeater', 'exposeEcoMode', 'exposeFanOnly',
    'exposeTurboBoost', 'exposeFlameSpeed',
    'exposeMediaLight', 'exposeOverheadLight', 'exposeLogs',
  ]) {
    assert.equal(schema.schema.properties[key].type, 'boolean');
    assert.equal(schema.schema.properties[key].default, true);
    assert.ok(schema.layout.includes(key));
  }
});
