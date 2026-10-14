import test from 'node:test';
import assert from 'node:assert/strict';
import {hsvToRgbw,rgbwToHsv} from '../src/flameconnect/color.js';

test('color conversion covers primary colors, white, dimming, and black',()=>{
  assert.deepEqual(hsvToRgbw({hue:0,saturation:100,brightness:100}),{red:255,green:0,blue:0,white:0});
  assert.deepEqual(hsvToRgbw({hue:120,saturation:100,brightness:100}),{red:0,green:255,blue:0,white:0});
  assert.deepEqual(hsvToRgbw({hue:0,saturation:0,brightness:50}),{red:0,green:0,blue:0,white:128});
  for (const hue of [0,60,120,180,240,300,359]) {
    const actual=rgbwToHsv(hsvToRgbw({hue,saturation:70,brightness:80}));
    assert.ok(Math.abs(actual.hue-hue)<1);
    assert.ok(Math.abs(actual.saturation-70)<1);
    assert.ok(Math.abs(actual.brightness-80)<1);
  }
  assert.deepEqual(rgbwToHsv({}),{hue:0,saturation:0,brightness:0});
});
