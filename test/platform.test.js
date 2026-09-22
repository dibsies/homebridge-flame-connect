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
