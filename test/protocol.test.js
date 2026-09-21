import assert from 'node:assert/strict';
import test from 'node:test';

import { Brightness, FireMode, OnOff, ParameterId } from '../src/flameconnect/constants.js';
import { decodeParameter, encodeFlame, encodeHeat, encodeLog, encodeMode, packetBytes } from '../src/flameconnect/protocol.js';

test('mode packet round trips', () => {
  const value = encodeMode({ mode: FireMode.MANUAL, targetTemperature: 22.5 });
  assert.deepEqual(decodeParameter(ParameterId.MODE, value), {
    type: 'mode', mode: FireMode.MANUAL, targetTemperature: 22.5,
  });
});

test('flame packet preserves all multi-field values', () => {
  const value = encodeFlame({
    flameEffect: OnOff.ON, flameSpeed: 5, brightness: Brightness.HIGH,
    pulsatingEffect: OnOff.ON, mediaTheme: 3, mediaLight: OnOff.ON,
    mediaColor: { red: 1, blue: 2, green: 3, white: 4 },
    overheadLight: OnOff.ON, overheadColor: { red: 5, blue: 6, green: 7, white: 8 },
    lightStatus: 1, flameColor: 4, ambientSensor: OnOff.ON,
  });
  const decoded = decodeParameter(ParameterId.FLAME_EFFECT, value);
  assert.equal(decoded.flameEffect, OnOff.ON);
  assert.equal(decoded.flameSpeed, 5);
  assert.equal(decoded.brightness, Brightness.HIGH);
  assert.equal(decoded.pulsatingEffect, OnOff.ON);
  assert.deepEqual(decoded.mediaColor, { red: 1, blue: 2, green: 3, white: 4 });
  assert.deepEqual(decoded.overheadColor, { red: 5, blue: 6, green: 7, white: 8 });
  assert.equal(decoded.ambientSensor, OnOff.ON);
});

test('heat and log packets round trip', () => {
  const heat = decodeParameter(ParameterId.HEAT_SETTINGS, encodeHeat({
    heatStatus: OnOff.ON, heatMode: 2, setpointTemperature: 19.5, boostDuration: 30,
  }));
  assert.deepEqual(heat, {
    type: 'heat', heatStatus: OnOff.ON, heatMode: 2,
    setpointTemperature: 19.5, boostDuration: 30,
  });

  const log = decodeParameter(ParameterId.LOG_EFFECT, encodeLog({
    logEffect: OnOff.ON, color: { red: 9, blue: 8, green: 7, white: 6 }, pattern: 4,
  }));
  assert.equal(log.logEffect, OnOff.ON);
  assert.deepEqual(log.color, { red: 9, blue: 8, green: 7, white: 6 });
  assert.equal(log.pattern, 4);
});

test('encoded packet header contains parameter and payload length', () => {
  const bytes = packetBytes(encodeMode({ mode: FireMode.STANDBY, targetTemperature: 20 }));
  assert.equal(bytes.readUInt16LE(0), ParameterId.MODE);
  assert.equal(bytes[2], bytes.length - 3);
});
