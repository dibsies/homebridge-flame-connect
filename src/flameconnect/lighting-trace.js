import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { decodeParameter } from './protocol.js';

// Privacy by selection, not redaction: never accept arbitrary request bodies,
// headers, error messages, account metadata, or device identifiers.
const scalarKeys = ['mode', 'targetTemperature', 'flameEffect', 'flameSpeed',
  'brightness', 'pulsatingEffect', 'mediaTheme', 'mediaLight', 'overheadLight',
  'lightStatus', 'flameColor', 'ambientSensor', 'heatStatus', 'heatMode',
  'setpointTemperature', 'boostDuration', 'logEffect', 'pattern'];
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const readTraces = new AsyncLocalStorage();
export const withReadTrace = (trace, operation) => readTraces.run(trace, operation);
export const currentReadTrace = () => readTraces.getStore();
export function lightingState(state = {}) {
  const result = {};
  for (const key of ['mode', 'flame', 'heat', 'log']) {
    const source = state[key];
    if (!source || typeof source !== 'object') continue;
    const safe = {};
    for (const field of scalarKeys) if (number(source[field]) !== null) safe[field] = source[field];
    for (const field of ['mediaColor', 'overheadColor', 'color']) {
      if (!source[field] || typeof source[field] !== 'object') continue;
      safe[field] = Object.fromEntries(['red', 'green', 'blue', 'white'].map((channel) => [channel, number(source[field][channel])]));
    }
    result[key] = safe;
  }
  return result;
}

export function lightingPackets(parameters = []) {
  return parameters.map((entry) => {
    const id = Number(entry.ParameterId);
    // Only fixed control packets can be logged as bytes. Unknown parameters
    // are omitted entirely; their bytes might contain identifying data.
    if (![321, 322, 323, 370].includes(id) || typeof entry.Value !== 'string') return null;
    try {
      const packet = Buffer.from(entry.Value, 'base64');
      const expectedLength = { 321: 6, 322: 23, 323: 8, 370: 11 }[id];
      if (packet.length !== expectedLength || packet.readUInt16LE(0) !== id || packet[2] !== expectedLength - 3) {
        return { parameter: id, omitted: true };
      }
      const decoded = decodeParameter(id, entry.Value);
      return { parameter: id, hex: packet.toString('hex'), decoded: lightingState({ [decoded.type]: decoded }) };
    } catch { return { parameter: id, undecodable: true }; }
  }).filter(Boolean);
}

export function createLightingTrace(enabled, label, log) {
  let started;
  let session;
  let eventSequence = 0;
  let commandSequence = 0;
  let requestSequence = 0;
  return {
    enabled,
    nextCommand: () => `c${++commandSequence}`,
    nextRequest: () => `r${++requestSequence}`,
    emit(event, details = {}, command = '-') {
      if (!enabled()) return;
      try {
        if (started === undefined) { started = performance.now(); session = randomUUID().slice(0, 8); }
        const name = /^fireplace \d+$/.test(label()) ? label() : 'fireplace';
        log?.info?.(`LightingTrace ${JSON.stringify({ session, fireplace: name,
          eventNumber: ++eventSequence, elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
          command: /^c\d+$/.test(command) ? command : '-', event, ...details })}`);
      } catch { /* Diagnostics must never change command success/failure. */ }
    },
  };
}
