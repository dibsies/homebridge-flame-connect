import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import initializer from '../src/index.js';
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
