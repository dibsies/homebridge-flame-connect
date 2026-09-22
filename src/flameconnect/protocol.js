import { ParameterId } from './constants.js';

function ensureLength(buffer, expected, name) {
  if (buffer.length < expected) {
    throw new Error(`${name}: expected at least ${expected} bytes, got ${buffer.length}`);
  }
}

function makePacket(parameterId, payload) {
  const packet = Buffer.alloc(3 + payload.length);
  packet.writeUInt16LE(parameterId, 0);
  packet.writeUInt8(payload.length, 2);
  payload.copy(packet, 3);
  return packet;
}

function decodeTemperature(buffer, offset) {
  return buffer[offset] + buffer[offset + 1] / 10;
}

function encodeTemperature(value) {
  const tenths = Math.round(Number(value) * 10);
  return Buffer.from([Math.floor(tenths / 10), tenths % 10]);
}

export function decodeParameter(parameterId, base64Value) {
  const raw = Buffer.from(base64Value, 'base64');

  switch (Number(parameterId)) {
    case ParameterId.TEMPERATURE_UNIT:
      ensureLength(raw, 4, 'TemperatureUnit');
      return { type: 'temperatureUnit', unit: raw[3] };

    case ParameterId.MODE:
      ensureLength(raw, 6, 'Mode');
      return {
        type: 'mode',
        mode: raw[3],
        targetTemperature: decodeTemperature(raw, 4),
      };

    case ParameterId.FLAME_EFFECT:
      ensureLength(raw, 23, 'FlameEffect');
      return {
        type: 'flame',
        flameEffect: raw[3],
        flameSpeed: raw[4] + 1,
        brightness: raw[5] & 1,
        pulsatingEffect: (raw[5] >> 1) & 1,
        mediaTheme: raw[6],
        mediaLight: raw[7],
        mediaColor: { red: raw[8], blue: raw[9], green: raw[10], white: raw[11] },
        overheadLight: raw[13],
        overheadColor: { red: raw[14], blue: raw[15], green: raw[16], white: raw[17] },
        lightStatus: raw[18],
        flameColor: raw[19],
        ambientSensor: raw[22],
      };

    case ParameterId.HEAT_SETTINGS: {
      ensureLength(raw, 7, 'HeatSettings');
      const boostLo = raw.length > 7 ? raw[7] : 0;
      const boostHi = raw.length > 8 ? raw[8] : 0;
      return {
        type: 'heat',
        heatStatus: raw[3],
        heatMode: raw[4],
        setpointTemperature: decodeTemperature(raw, 5),
        boostDuration: (boostLo | (boostHi << 8)) + 1,
      };
    }

    case ParameterId.HEAT_MODE:
      ensureLength(raw, 4, 'HeatMode');
      return { type: 'heatMode', heatControl: raw[3] };

    case ParameterId.TIMER:
      ensureLength(raw, 6, 'Timer');
      return { type: 'timer', timerStatus: raw[3], duration: raw[4] | (raw[5] << 8) };

    case ParameterId.LOG_EFFECT:
      ensureLength(raw, 11, 'LogEffect');
      return {
        type: 'log',
        logEffect: raw[3],
        color: { red: raw[5], blue: raw[6], green: raw[7], white: raw[8] },
        pattern: raw[9],
      };

    case ParameterId.SOFTWARE_VERSION:
      ensureLength(raw, 12, 'SoftwareVersion');
      return {
        type: 'softwareVersion',
        ui: `${raw[3]}.${raw[4]}.${raw[5]}`,
        control: `${raw[6]}.${raw[7]}.${raw[8]}`,
        relay: `${raw[9]}.${raw[10]}.${raw[11]}`,
      };

    case ParameterId.ERROR:
      ensureLength(raw, 7, 'Error');
      return { type: 'error', bytes: [raw[3], raw[4], raw[5], raw[6]] };

    case ParameterId.SOUND:
      ensureLength(raw, 5, 'Sound');
      return { type: 'sound', volume: raw[3], soundFile: raw[4] };

    default:
      return { type: 'unknown', parameterId: Number(parameterId), raw };
  }
}

export function encodeMode(param) {
  const payload = Buffer.concat([
    Buffer.from([Number(param.mode)]),
    encodeTemperature(param.targetTemperature ?? 22),
  ]);
  return makePacket(ParameterId.MODE, payload).toString('base64');
}

export function encodeFlame(param) {
  const speed = Math.min(5, Math.max(1, Number(param.flameSpeed ?? 1)));
  const media = param.mediaColor ?? { red: 0, blue: 0, green: 0, white: 0 };
  const overhead = param.overheadColor ?? { red: 0, blue: 0, green: 0, white: 0 };
  const payload = Buffer.from([
    Number(param.flameEffect ?? 0),
    speed - 1,
    Number(param.brightness ?? 0) | (Number(param.pulsatingEffect ?? 0) << 1),
    Number(param.mediaTheme ?? 0),
    Number(param.mediaLight ?? 0),
    Number(media.red ?? 0),
    Number(media.blue ?? 0),
    Number(media.green ?? 0),
    Number(media.white ?? 0),
    0,
    Number(param.overheadLight ?? 0),
    Number(overhead.red ?? 0),
    Number(overhead.blue ?? 0),
    Number(overhead.green ?? 0),
    Number(overhead.white ?? 0),
    Number(param.lightStatus ?? 0),
    Number(param.flameColor ?? 0),
    0,
    0,
    Number(param.ambientSensor ?? 0),
  ]);
  return makePacket(ParameterId.FLAME_EFFECT, payload).toString('base64');
}

export function encodeHeat(param) {
  const duration = Math.min(20, Math.max(1, Number(param.boostDuration ?? 1)));
  const wireBoost = duration - 1;
  const payload = Buffer.concat([
    Buffer.from([Number(param.heatStatus ?? 0), Number(param.heatMode ?? 0)]),
    encodeTemperature(param.setpointTemperature ?? 22),
    // The Flame Connect write packet is exactly five payload bytes. Although
    // some reads contain an additional high duration byte, the official app
    // and upstream reference encoder write only the low byte here.
    Buffer.from([wireBoost & 0xff]),
  ]);
  return makePacket(ParameterId.HEAT_SETTINGS, payload).toString('base64');
}

export function encodeLog(param) {
  const color = param.color ?? { red: 0, blue: 0, green: 0, white: 0 };
  const payload = Buffer.from([
    Number(param.logEffect ?? 0),
    0,
    Number(color.red ?? 0),
    Number(color.blue ?? 0),
    Number(color.green ?? 0),
    Number(color.white ?? 0),
    Number(param.pattern ?? 0),
    0,
  ]);
  return makePacket(ParameterId.LOG_EFFECT, payload).toString('base64');
}

export function packetBytes(base64Value) {
  return Buffer.from(base64Value, 'base64');
}
