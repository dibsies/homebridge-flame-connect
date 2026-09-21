import { Brightness, FireMode, OnOff } from './flameconnect/client.js';
import { hsvToRgbw, rgbwToHsv } from './flameconnect/color.js';

export const CONTROL_NAMES = {
  power: ['powerName', 'Fireplace'], flames: ['flamesName', 'Flames'],
  heater: ['heaterName', 'Heater'], 'media-light': ['mediaLightName', 'Media Bed'],
  'overhead-light': ['overheadName', 'Media Accent'], 'log-effect': ['logsName', 'Logs'],
  pulsating: ['pulsatingName', 'Pulsating Effect'], ambient: ['ambientName', 'Ambient Sensor'],
};

export function applyServiceName(service, Characteristic, name) {
  // Apple Home uses ConfiguredName for user-facing service labels on modern
  // HomeKit accessories. Name alone is frequently replaced by the parent
  // accessory name when several switches/lights are grouped together.
  service.displayName = name;
  service.setCharacteristic(Characteristic.Name, name);
  if (Characteristic.ConfiguredName) {
    service.addOptionalCharacteristic?.(Characteristic.ConfiguredName);
    service.setCharacteristic(Characteristic.ConfiguredName, name);
  }
  return service;
}

// HomeKit stores a user's custom service label in ConfiguredName.  Rewriting
// Name/ConfiguredName on every cloud refresh makes Apple Home silently lose
// that customization, so only migrate labels that are still ours.
export function applyServiceNameIfGenerated(service, Characteristic, name, legacyNames = []) {
  const configured = Characteristic.ConfiguredName
    ? service.getCharacteristic?.(Characteristic.ConfiguredName)?.value
    : undefined;
  const serviceName = Characteristic.Name
    ? service.getCharacteristic?.(Characteristic.Name)?.value
    : undefined;
  const values = [configured, serviceName, service.displayName].filter(Boolean);
  const generated = values.length === 0
    || values.every((value) => value === name || legacyNames.includes(value));
  return generated ? applyServiceName(service, Characteristic, name) : service;
}

export function controlEnabled(config, key) {
  return config?.[key] !== false;
}

export function mergeFireMetadata(current, incoming, preferIncomingName = false) {
  const friendlyName = preferIncomingName
    ? (incoming.friendlyName || current.friendlyName)
    : (current.friendlyName || incoming.friendlyName);
  return { ...current, ...incoming, friendlyName };
}

export class FlameConnectAccessory {
  constructor(platform, accessory, fire) {
    this.platform = platform;
    this.accessory = accessory;
    this.fire = fire;
    this.state = {};
    this.lastRefresh = 0;
    this.refreshPromise = null;
    this.commandQueue = Promise.resolve();
    // Serialize the entire read/modify/write operation, not just the POST.
    for (const method of ['setPower', 'setFlames', 'setFlameBrightness', 'setFlameFlag', 'setHeat', 'setLogs', 'setLightColor']) {
      const operation = this[method].bind(this);
      this[method] = (...args) => {
        const pending = this.commandQueue.then(() => operation(...args));
        this.commandQueue = pending.catch(() => {});
        return pending;
      };
    }

    const { Service, Characteristic } = platform;
    accessory.context.fire = fire;

    accessory.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, fire.brand || 'Dimplex')
      .setCharacteristic(Characteristic.Model, fire.productModel || fire.productType || 'Flame Connect Fireplace')
      .setCharacteristic(Characteristic.SerialNumber, fire.fireId)
      .setCharacteristic(Characteristic.Name, fire.friendlyName);

    if (controlEnabled(platform.config, 'exposePower')) {
      this.powerService = this.getService(Service.Switch, 'Fireplace', 'power');
      this.powerService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getPower())
        .onSet((value) => this.setPower(Boolean(value)));
    } else {
      this.removeService(Service.Switch, 'power');
    }

    if (controlEnabled(platform.config, 'exposeFlames')) {
      this.flameService = this.getService(Service.Lightbulb, 'Flames', 'flames');
      this.flameService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getFlames())
        .onSet((value) => this.setFlames(Boolean(value)));
      this.flameService.getCharacteristic(Characteristic.Brightness)
        .onGet(() => this.getFlameBrightness())
        .onSet((value) => this.setFlameBrightness(Number(value)));
    } else {
      this.removeService(Service.Lightbulb, 'flames');
    }

    if (controlEnabled(platform.config, 'exposeHeater')
      && (fire.withHeat || fire.features?.simpleHeat || fire.features?.advancedHeat)) {
      this.heatService = this.getService(Service.Switch, 'Heater', 'heater');
      this.heatService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getHeat())
        .onSet((value) => this.setHeat(Boolean(value)));
    } else {
      this.removeService(Service.Switch, 'heater');
    }

    if (controlEnabled(platform.config, 'exposeMediaLight')) {
      this.mediaService = this.getService(Service.Lightbulb, 'Media Light', 'media-light');
      this.mediaService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getFlameFlag('mediaLight'))
        .onSet((value) => this.setFlameFlag('mediaLight', Boolean(value)));
    } else {
      this.removeService(Service.Lightbulb, 'media-light');
    }

    if (controlEnabled(platform.config, 'exposeOverheadLight')) {
      this.overheadService = this.getService(Service.Lightbulb, 'Overhead', 'overhead-light');
      this.overheadService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getFlameFlag('overheadLight'))
        .onSet((value) => this.setFlameFlag('overheadLight', Boolean(value)));
    } else {
      this.removeService(Service.Lightbulb, 'overhead-light');
    }

    if (controlEnabled(platform.config, 'exposeLogs') && fire.features?.rgbLogEffect) {
      this.logService = this.getService(Service.Lightbulb, 'Logs', 'log-effect');
      this.logService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getLogs())
        .onSet((value) => this.setLogs(Boolean(value)));
    } else {
      this.removeService(Service.Lightbulb, 'log-effect');
    }

    if (platform.config.advancedControls) {
      this.pulseService = this.getService(Service.Switch, 'Pulsating Effect', 'pulsating');
      this.pulseService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getFlameFlag('pulsatingEffect'))
        .onSet((value) => this.setFlameFlag('pulsatingEffect', Boolean(value)));

      this.ambientService = this.getService(Service.Switch, 'Ambient Sensor', 'ambient');
      this.ambientService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getFlameFlag('ambientSensor'))
        .onSet((value) => this.setFlameFlag('ambientSensor', Boolean(value)));
    } else {
      this.removeService(Service.Switch, 'pulsating');
      this.removeService(Service.Switch, 'ambient');
    }

    const primaryService = this.powerService || this.flameService || this.heatService
      || this.mediaService || this.overheadService || this.logService;
    if (primaryService) accessory.setPrimaryService?.(primaryService);
    for (const [service, key] of [[this.mediaService, 'mediaColor'], [this.overheadService, 'overheadColor']]) {
      if (!service) continue;
      for (const [characteristic, field] of [[Characteristic.Hue,'hue'], [Characteristic.Saturation,'saturation'], [Characteristic.Brightness,'brightness']]) {
        service.getCharacteristic(characteristic)
          .onGet(async () => { await this.ensureFresh(); return rgbwToHsv(this.state.flame?.[key])[field]; })
          .onSet(value => this.setLightColor(key, field, Number(value)));
      }
    }
  }

  getService(ServiceType, name, subtype) {
    const [configKey, defaultName] = CONTROL_NAMES[subtype];
    const oldDefault = subtype === 'media-light' ? 'Media Light' : subtype === 'overhead-light' ? 'Overhead' : defaultName;
    const configured = this.platform.config[configKey]?.trim();
    name = configured || defaultName;
    const existing = this.accessory.getServiceById?.(ServiceType, subtype)
      || this.accessory.services.find((service) => service.UUID === ServiceType.UUID && service.subtype === subtype);
    const service = existing || this.accessory.addService(ServiceType, name, subtype);
    const saved = this.accessory.context.controlNames ||= {};
    const previous = saved[subtype];
    // A deliberate config change wins once; subsequent restarts preserve Home edits.
    const defaultMigration = previous === oldDefault && name === defaultName && oldDefault !== defaultName;
    if (!existing || (previous !== undefined && previous !== name && !defaultMigration)
      || (previous === undefined && name !== defaultName)) {
      applyServiceName(service, this.platform.Characteristic, name);
    } else if (previous === undefined || defaultMigration) {
      applyServiceNameIfGenerated(service, this.platform.Characteristic, name, [
        `${this.fire.friendlyName} ${defaultName}`,
        `${this.fire.fireId} ${defaultName}`,
        oldDefault, `${this.fire.friendlyName} ${oldDefault}`, `${this.fire.fireId} ${oldDefault}`,
        ...(subtype === 'overhead-light'
          ? [`${this.fire.friendlyName} Overhead Light`, `${this.fire.fireId} Overhead Light`] : []),
      ]);
    }
    saved[subtype] = name;
    return service;
  }

  removeService(ServiceType, subtype) {
    const existing = this.accessory.getServiceById?.(ServiceType, subtype)
      || this.accessory.services.find((service) => service.UUID === ServiceType.UUID && service.subtype === subtype);
    if (existing) this.accessory.removeService(existing);
  }

  updateFire(fire, preferIncomingName = false) {
    this.fire = mergeFireMetadata(this.fire, fire, preferIncomingName);
    this.accessory.context.fire = this.fire;
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }

  async ensureFresh(force = false) {
    const cacheMs = Math.max(5, Number(this.platform.config.cacheSeconds || 30)) * 1000;
    if (!force && this.lastRefresh && Date.now() - this.lastRefresh < cacheMs) return this.state;
    return this.refresh();
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const overview = await this.platform.client.getFireOverview(this.fire.fireId);
      this.state = overview.parameters;
      this.lastRefresh = Date.now();
      if (overview.fire) this.updateFire(overview.fire);
      this.pushStateToHomeKit();
      return this.state;
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  pushStateToHomeKit() {
    const C = this.platform.Characteristic;
    for (const [service,key] of [[this.mediaService,'mediaColor'],[this.overheadService,'overheadColor']]) {
      if (!service || !this.state.flame?.[key]) continue;
      const hsv=rgbwToHsv(this.state.flame[key]);
      service.updateCharacteristic(C.Hue,hsv.hue);
      service.updateCharacteristic(C.Saturation,hsv.saturation);
      service.updateCharacteristic(C.Brightness,hsv.brightness);
    }
    if (this.state.mode) this.powerService?.updateCharacteristic(C.On, this.state.mode.mode === FireMode.MANUAL);
    if (this.state.flame) {
      this.flameService?.updateCharacteristic(C.On, this.state.flame.flameEffect === OnOff.ON);
      this.flameService?.updateCharacteristic(C.Brightness, this.state.flame.brightness === Brightness.HIGH ? 100 : 50);
      this.mediaService?.updateCharacteristic(C.On, this.state.flame.mediaLight === OnOff.ON);
      this.overheadService?.updateCharacteristic(C.On, this.state.flame.overheadLight === OnOff.ON);
      this.pulseService?.updateCharacteristic(C.On, this.state.flame.pulsatingEffect === OnOff.ON);
      this.ambientService?.updateCharacteristic(C.On, this.state.flame.ambientSensor === OnOff.ON);
    }
    if (this.state.heat && this.heatService) this.heatService.updateCharacteristic(C.On, this.state.heat.heatStatus === OnOff.ON);
    if (this.state.log && this.logService) this.logService.updateCharacteristic(C.On, this.state.log.logEffect === OnOff.ON);
  }

  async getPower() {
    await this.ensureFresh();
    return this.state.mode?.mode === FireMode.MANUAL;
  }

  async setPower(on) {
    await this.ensureFresh(true);
    await this.platform.client.setPower(this.fire.fireId, this.state, on);
    if (this.state.mode) this.state.mode = { ...this.state.mode, mode: on ? FireMode.MANUAL : FireMode.STANDBY };
    if (on && this.state.flame) this.state.flame = { ...this.state.flame, flameEffect: OnOff.ON };
    this.lastRefresh = Date.now();
    this.pushStateToHomeKit();
  }

  async getFlames() {
    await this.ensureFresh();
    return this.state.flame?.flameEffect === OnOff.ON;
  }

  async setFlames(on) {
    await this.ensureFresh(true);
    this.state.flame = await this.platform.client.setFlame(
      this.fire.fireId,
      this.state.flame,
      { flameEffect: on ? OnOff.ON : OnOff.OFF },
    );
    this.lastRefresh = Date.now();
    this.pushStateToHomeKit();
  }

  async getFlameBrightness() {
    await this.ensureFresh();
    return this.state.flame?.brightness === Brightness.LOW ? 50 : 100;
  }

  async setFlameBrightness(value) {
    await this.ensureFresh(true);
    const brightness = value <= 50 ? Brightness.LOW : Brightness.HIGH;
    this.state.flame = await this.platform.client.setFlame(this.fire.fireId, this.state.flame, { brightness });
    this.lastRefresh = Date.now();
    this.pushStateToHomeKit();
  }

  async getFlameFlag(key) {
    await this.ensureFresh();
    return this.state.flame?.[key] === OnOff.ON;
  }

  async setFlameFlag(key, on) {
    await this.ensureFresh(true);
    this.state.flame = await this.platform.client.setFlame(
      this.fire.fireId,
      this.state.flame,
      { [key]: on ? OnOff.ON : OnOff.OFF },
    );
    this.lastRefresh = Date.now();
    this.pushStateToHomeKit();
  }

  async setLightColor(key, field, value) {
    if (!['mediaColor','overheadColor'].includes(key) || !['hue','saturation','brightness'].includes(field)
      || !Number.isFinite(value)) throw new Error('Invalid lighting color setting.');
    await this.ensureFresh();
    const hsv = rgbwToHsv(this.state.flame?.[key]);
    // Retain selected hue/saturation while brightness is zero.
    const remembered = (this.accessory.context.lightColors ||= {});
    if (hsv.saturation === 0 && remembered[key]) hsv.hue = remembered[key].hue;
    const next = { ...(hsv.brightness === 0 ? remembered[key] || hsv : hsv), [field]:value };
    const changes = { [key]:hsvToRgbw(next), mediaTheme:0 };
    this.state.flame = await this.platform.client.setFlame(this.fire.fireId,this.state.flame,changes);
    remembered[key] = next;
    this.lastRefresh = Date.now();
    this.pushStateToHomeKit();
  }

  async getHeat() {
    await this.ensureFresh();
    return this.state.heat?.heatStatus === OnOff.ON;
  }

  async setHeat(on) {
    await this.ensureFresh(true);
    this.state.heat = await this.platform.client.setHeat(this.fire.fireId, this.state.heat, on);
    this.lastRefresh = Date.now();
    this.pushStateToHomeKit();
  }

  async getLogs() {
    await this.ensureFresh();
    return this.state.log?.logEffect === OnOff.ON;
  }

  async setLogs(on) {
    await this.ensureFresh(true);
    this.state.log = await this.platform.client.setLog(this.fire.fireId, this.state.log, on);
    this.lastRefresh = Date.now();
    this.pushStateToHomeKit();
  }
}
