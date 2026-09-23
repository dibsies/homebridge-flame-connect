import {
  API_BASE,
  Brightness,
  DEFAULT_HEADERS,
  FireMode,
  HeatMode,
  OnOff,
  ParameterId,
} from './constants.js';
import { FlameConnectCloudError, asCloudError, isCloudError } from './errors.js';
import { decodeParameter, encodeFlame, encodeHeat, encodeLog, encodeMode } from './protocol.js';

// A single API command must never block a fireplace's whole command queue
// indefinitely: a hung cloud call fails fast and the caller sees a proper
// HomeKit communication error instead of a spinning tile.
const API_REQUEST_TIMEOUT_MS = 15_000;

export { isCloudError } from './errors.js';

const OVERVIEW_RETRY_DELAY_MS = 500;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function retryAfterMilliseconds(response) {
  const value = response.headers?.get?.('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function parseFeatures(data = {}) {
  return {
    sound: Boolean(data.Sound),
    simpleHeat: Boolean(data.SimpleHeat),
    advancedHeat: Boolean(data.AdvancedHeat),
    countDownTimer: Boolean(data.CountDownTimer),
    moods: Boolean(data.Moods),
    flameDimming: Boolean(data.FlameDimming),
    rgbFuelBed: Boolean(data.RgbFuelBed),
    rgbBackLight: Boolean(data.RgbBackLight),
    mediaAccent: Boolean(data.MediaAccent),
    rgbLogEffect: Boolean(data.RgbLogEffect),
    fanOnly: Boolean(data.FanOnly),
    powerBoost: Boolean(data.PowerBoost),
  };
}

function parseFire(data = {}, features) {
  return {
    fireId: data.FireId,
    friendlyName: data.FriendlyName || data.FireId,
    brand: data.Brand || 'Dimplex',
    productType: data.ProductType || 'Electric Fireplace',
    productModel: data.ProductModel || '',
    itemCode: data.ItemCode || '',
    connectionState: Number(data.IoTConnectionState ?? 0),
    withHeat: Boolean(data.WithHeat),
    isIotFire: Boolean(data.IsIotFire),
    features: features ?? parseFeatures(data.FireFeature),
  };
}

export class FlameConnectClient {
  constructor(auth, log) {
    this.auth = auth;
    this.log = log;
  }

  async request(method, route, body, retried = false) {
    // Token acquisition is part of the cloud call: a dead token endpoint must
    // surface as a communication failure, not a generic error. markCloudError
    // preserves existing codes, so FLAMECONNECT_REAUTH_REQUIRED still means
    // "the user must sign in again".
    let token;
    try {
      token = await this.auth.getAccessToken();
    } catch (error) {
      throw asCloudError(error);
    }
    let response;
    try {
      response = await fetch(`${API_BASE}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...DEFAULT_HEADERS,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw asCloudError(error);
    }
    let text;
    try {
      text = await response.text();
    } catch (error) {
      throw asCloudError(error);
    }
    if (!response.ok) {
      if (response.status === 401 && !retried) {
        await this.auth.getAccessToken(true);
        return this.request(method, route, body, true);
      }
      const retryAfterMs = retryAfterMilliseconds(response);
      if (method === 'GET' && !retried && [429, 503].includes(response.status)
        && retryAfterMs !== undefined && retryAfterMs <= 5_000) {
        await delay(retryAfterMs);
        return this.request(method, route, body, true);
      }
      throw new FlameConnectCloudError(
        `Flame Connect API ${method} ${route} failed (HTTP ${response.status}).`,
        { retryAfterMs },
      );
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new FlameConnectCloudError(
        `Flame Connect API ${method} ${route} returned an invalid response.`,
      );
    }
  }

  async getFires() {
    const data = await this.request('GET', '/api/Fires/GetFires');
    return Array.isArray(data) ? data.map((entry) => parseFire(entry)) : [];
  }

  async getFireOverview(fireId, retried = false) {
    const data = await this.request(
      'GET',
      `/api/Fires/GetFireOverview?FireId=${encodeURIComponent(fireId)}`,
    );
    const resultCode = Number(data?.ResultCode ?? 0);
    if (resultCode !== 0) {
      if (!retried) {
        await delay(OVERVIEW_RETRY_DELAY_MS);
        return this.getFireOverview(fireId, true);
      }
      throw new FlameConnectCloudError(
        `Flame Connect reported that the fireplace is temporarily unavailable (result code ${resultCode}).`,
        { resultCode },
      );
    }
    const wifi = data?.WifiFireOverview;
    if (!wifi) {
      throw new FlameConnectCloudError('Flame Connect did not return fireplace status data.');
    }
    const featureData = data?.FireDetails?.FireFeature || wifi.FireFeature || {};
    const fire = parseFire(wifi, parseFeatures(featureData));
    const parameters = {};
    for (const entry of wifi.Parameters || []) {
      try {
        const decoded = decodeParameter(entry.ParameterId, entry.Value);
        parameters[decoded.type] = decoded;
      } catch (error) {
        this.log?.debug?.(`Could not decode Flame Connect parameter ${entry.ParameterId}: ${error.message}`);
      }
    }
    return { fire, parameters };
  }

  async writeParameters(fireId, entries) {
    const parameters = entries.map(({ parameterId, value }) => ({
      ParameterId: parameterId,
      Value: value,
    }));
    const result = await this.request('POST', '/api/Fires/WriteWifiParameters', {
      FireId: fireId,
      Parameters: parameters,
    });
    if (result?.ResultCode !== undefined && Number(result.ResultCode) !== 0) {
      throw new Error(`Flame Connect rejected the command (result code ${result.ResultCode}).`);
    }
  }

  async setPower(fireId, state, on) {
    const mode = state.mode ?? { type: 'mode', mode: FireMode.STANDBY, targetTemperature: 22 };
    if (on) {
      const writes = [
        {
          parameterId: ParameterId.MODE,
          value: encodeMode({ ...mode, mode: FireMode.MANUAL }),
        },
      ];
      if (state.flame) {
        writes.push({
          parameterId: ParameterId.FLAME_EFFECT,
          value: encodeFlame({ ...state.flame, flameEffect: OnOff.ON }),
        });
      }
      if (state.heat) {
        writes.push({ parameterId: ParameterId.HEAT_SETTINGS, value: encodeHeat(state.heat) });
      }
      await this.writeParameters(fireId, writes);
    } else {
      await this.writeParameters(fireId, [{
        parameterId: ParameterId.MODE,
        value: encodeMode({ ...mode, mode: FireMode.STANDBY }),
      }]);
    }
  }

  async setFlame(fireId, current, changes) {
    if (!current) throw new Error('This fireplace did not report Flame Effect parameter 322.');
    const next = { ...current, ...changes };
    await this.writeParameters(fireId, [{ parameterId: ParameterId.FLAME_EFFECT, value: encodeFlame(next) }]);
    return next;
  }

  async setHeat(fireId, current, on) {
    if (!current) throw new Error('This fireplace did not report Heat Settings parameter 323.');
    const next = { ...current, heatStatus: on ? OnOff.ON : OnOff.OFF };
    await this.writeParameters(fireId, [{ parameterId: ParameterId.HEAT_SETTINGS, value: encodeHeat(next) }]);
    return next;
  }

  async setHeatTemperature(fireId, current, temperature) {
    if (!current) throw new Error('This fireplace did not report Heat Settings parameter 323.');
    if (!Number.isFinite(temperature)) throw new Error('Invalid heater target temperature.');
    const next = { ...current, setpointTemperature: Math.round(temperature * 2) / 2 };
    await this.writeParameters(fireId, [{ parameterId: ParameterId.HEAT_SETTINGS, value: encodeHeat(next) }]);
    return next;
  }

  async setHeatMode(fireId, current, changes) {
    if (!current) throw new Error('This fireplace did not report Heat Settings parameter 323.');
    const next = { ...current, ...changes };
    await this.writeParameters(fireId, [{ parameterId: ParameterId.HEAT_SETTINGS, value: encodeHeat(next) }]);
    return next;
  }

  async setFlameSpeed(fireId, current, speed) {
    if (!current) throw new Error('This fireplace did not report Flame Effect parameter 322.');
    const next = { ...current, flameSpeed: Math.min(5, Math.max(1, Math.round(Number(speed)))) };
    await this.writeParameters(fireId, [{ parameterId: ParameterId.FLAME_EFFECT, value: encodeFlame(next) }]);
    return next;
  }

  async setLog(fireId, current, on) {
    if (!current) throw new Error('This fireplace did not report Log Effect parameter 370.');
    const next = { ...current, logEffect: on ? OnOff.ON : OnOff.OFF };
    await this.writeParameters(fireId, [{ parameterId: ParameterId.LOG_EFFECT, value: encodeLog(next) }]);
    return next;
  }

  async setLogColor(fireId, current, color) {
    if (!current) throw new Error('This fireplace did not report Log Effect parameter 370.');
    const next = { ...current, color };
    await this.writeParameters(fireId, [{ parameterId: ParameterId.LOG_EFFECT, value: encodeLog(next) }]);
    return next;
  }
}

export { Brightness, FireMode, HeatMode, OnOff };
