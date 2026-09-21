import { Brightness, FireMode, OnOff } from './flameconnect/client.js';

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

    const { Service, Characteristic } = platform;
    accessory.context.fire = fire;

    accessory.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, fire.brand || 'Dimplex')
      .setCharacteristic(Characteristic.Model, fire.productModel || fire.productType || 'Flame Connect Fireplace')
      .setCharacteristic(Characteristic.SerialNumber, fire.fireId)
      .setCharacteristic(Characteristic.Name, fire.friendlyName);

    if (controlEnabled(platform.config, 'exposePower')) {
      this.powerService = this.getService(Service.Switch, `${fire.friendlyName} Fireplace`, 'power');
      this.powerService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getPower())
        .onSet((value) => this.setPower(Boolean(value)));
    } else {
      this.removeService(Service.Switch, 'power');
    }

    if (controlEnabled(platform.config, 'exposeFlames')) {
      this.flameService = this.getService(Service.Lightbulb, `${fire.friendlyName} Flames`, 'flames');
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
      this.heatService = this.getService(Service.Switch, `${fire.friendlyName} Heater`, 'heater');
      this.heatService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getHeat())
        .onSet((value) => this.setHeat(Boolean(value)));
    } else {
      this.removeService(Service.Switch, 'heater');
    }

    if (controlEnabled(platform.config, 'exposeMediaLight')) {
      this.mediaService = this.getService(Service.Lightbulb, `${fire.friendlyName} Media Light`, 'media-light');
      this.mediaService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getFlameFlag('mediaLight'))
        .onSet((value) => this.setFlameFlag('mediaLight', Boolean(value)));
    } else {
      this.removeService(Service.Lightbulb, 'media-light');
    }

    if (controlEnabled(platform.config, 'exposeOverheadLight')) {
      this.overheadService = this.getService(Service.Lightbulb, `${fire.friendlyName} Overhead Light`, 'overhead-light');
      this.overheadService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getFlameFlag('overheadLight'))
        .onSet((value) => this.setFlameFlag('overheadLight', Boolean(value)));
    } else {
      this.removeService(Service.Lightbulb, 'overhead-light');
    }

    if (controlEnabled(platform.config, 'exposeLogs') && fire.features?.rgbLogEffect) {
      this.logService = this.getService(Service.Lightbulb, `${fire.friendlyName} Logs`, 'log-effect');
      this.logService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getLogs())
        .onSet((value) => this.setLogs(Boolean(value)));
    } else {
      this.removeService(Service.Lightbulb, 'log-effect');
    }

    if (platform.config.advancedControls) {
      this.pulseService = this.getService(Service.Switch, `${fire.friendlyName} Pulsating Effect`, 'pulsating');
      this.pulseService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getFlameFlag('pulsatingEffect'))
        .onSet((value) => this.setFlameFlag('pulsatingEffect', Boolean(value)));

      this.ambientService = this.getService(Service.Switch, `${fire.friendlyName} Ambient Sensor`, 'ambient');
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
  }

  getService(ServiceType, name, subtype) {
    const existing = this.accessory.getServiceById?.(ServiceType, subtype)
      || this.accessory.services.find((service) => service.UUID === ServiceType.UUID && service.subtype === subtype);
    const service = existing || this.accessory.addService(ServiceType, name, subtype);
    return applyServiceName(service, this.platform.Characteristic, name);
  }

  renameServices() {
    const name = this.fire.friendlyName;
    if (!name) return;
    const C = this.platform.Characteristic;
    if (this.powerService) applyServiceName(this.powerService, C, `${name} Fireplace`);
    if (this.flameService) applyServiceName(this.flameService, C, `${name} Flames`);
    if (this.heatService) applyServiceName(this.heatService, C, `${name} Heater`);
    if (this.mediaService) applyServiceName(this.mediaService, C, `${name} Media Light`);
    if (this.overheadService) applyServiceName(this.overheadService, C, `${name} Overhead Light`);
    if (this.logService) applyServiceName(this.logService, C, `${name} Logs`);
    if (this.pulseService) applyServiceName(this.pulseService, C, `${name} Pulsating Effect`);
    if (this.ambientService) applyServiceName(this.ambientService, C, `${name} Ambient Sensor`);
  }

  removeService(ServiceType, subtype) {
    const existing = this.accessory.getServiceById?.(ServiceType, subtype)
      || this.accessory.services.find((service) => service.UUID === ServiceType.UUID && service.subtype === subtype);
    if (existing) this.accessory.removeService(existing);
  }

  updateFire(fire, preferIncomingName = false) {
    this.fire = mergeFireMetadata(this.fire, fire, preferIncomingName);
    this.accessory.context.fire = this.fire;
    this.renameServices();
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
