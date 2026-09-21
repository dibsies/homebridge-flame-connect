import {
  API_BASE,
  Brightness,
  DEFAULT_HEADERS,
  FireMode,
  OnOff,
  ParameterId,
} from './constants.js';
import { decodeParameter, encodeFlame, encodeHeat, encodeLog, encodeMode } from './protocol.js';

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

  async request(method, route, body) {
    const token = await this.auth.getAccessToken();
    const response = await fetch(`${API_BASE}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...DEFAULT_HEADERS,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 401) {
        await this.auth.getAccessToken(true);
        return this.request(method, route, body);
      }
      throw new Error(`Flame Connect API ${method} ${route} failed (${response.status}): ${text}`);
    }
    if (!text) return null;
    return JSON.parse(text);
  }

  async getFires() {
    const data = await this.request('GET', '/api/Fires/GetFires');
    return Array.isArray(data) ? data.map((entry) => parseFire(entry)) : [];
  }

  async getFireOverview(fireId) {
    const data = await this.request(
      'GET',
      `/api/Fires/GetFireOverview?FireId=${encodeURIComponent(fireId)}`,
    );
    const resultCode = Number(data?.ResultCode ?? 0);
    if (resultCode !== 0) {
      throw new Error(`Fireplace ${fireId} is unavailable (Flame Connect result code ${resultCode}).`);
    }
    const wifi = data?.WifiFireOverview;
    if (!wifi) {
      throw new Error(`Flame Connect did not return WifiFireOverview for ${fireId}.`);
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
    await this.request('POST', '/api/Fires/WriteWifiParameters', {
      FireId: fireId,
      Parameters: parameters,
    });
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

  async setLog(fireId, current, on) {
    if (!current) throw new Error('This fireplace did not report Log Effect parameter 370.');
    const next = { ...current, logEffect: on ? OnOff.ON : OnOff.OFF };
    await this.writeParameters(fireId, [{ parameterId: ParameterId.LOG_EFFECT, value: encodeLog(next) }]);
    return next;
  }
}

export { Brightness, FireMode, OnOff };
