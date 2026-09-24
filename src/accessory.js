import { Brightness, FireMode, HeatMode, OnOff } from './flameconnect/client.js';
import { hsvToRgbw, rgbwToHsv } from './flameconnect/color.js';
import { FlameConnectCloudError, isCloudError } from './flameconnect/errors.js';

// HomeKit expects characteristic handlers to settle quickly; the installed
// HAP-NodeJS times out reads and writes after roughly nine seconds. Every
// Home request must therefore resolve or fail inside that window — a cloud
// call that outlasts it surfaces as a meaningful HAP error while the command
// continues in the background and reconciles on completion. It is never
// replayed: replaying an uncertain write could execute it twice.
const HAP_HANDLER_TIMEOUT_MS = 8_000;

// Heating modes in which the heater element is actually engaged. Fan-only
// deliberately runs with heatStatus on, but the unit is not heating.
const HEATING_MODES = [HeatMode.NORMAL, HeatMode.ECO, HeatMode.BOOST];

function deadlineExceededError(label) {
  const error = new Error(`${label} did not complete within the HomeKit response window.`);
  error.code = 'FLAMECONNECT_HAP_DEADLINE';
  return error;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(deadlineExceededError(label)), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

export const CONTROL_NAMES = {
  power: ['powerName', 'Fireplace'], flames: ['flamesName', 'Flames'],
  heater: ['heaterName', 'Heater'], 'media-light': ['mediaLightName', 'Media Bed'],
  'overhead-light': ['overheadName', 'Media Accent'], 'log-effect': ['logsName', 'Logs'],
  'flame-speed': ['flameSpeedName', 'Flame Speed'],
  'eco-mode': ['ecoModeName', 'Eco Mode'], 'fan-only': ['fanOnlyName', 'Fan Only'],
  'turbo-boost': ['turboBoostName', 'Turbo Boost'],
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
    // Monotonic state version. A refresh that started before a command
    // completed carries older data and must never overwrite the command's
    // newer state when it lands late.
    this.stateEpoch = 0;
    this.refreshPromise = null;
    this.commandQueue = Promise.resolve();
    this.queueDepth = 0;
    this.cloudFailureUntil = 0;
    this.lastCloudError = null;
    this.inCloudFailure = false;
    this.healthState = null;
    this.disposed = false;
    this.pendingColors = new Map();
    // Serialize the entire read/modify/write operation, not just the POST.
    for (const method of ['setPower', 'setFlames', 'setFlameBrightness', 'setFlameSpeed', 'setFlameFlag',
      'setHeat', 'setHeatTemperature', 'setEcoMode', 'setFanOnly', 'setTurboBoost',
      'setLogs']) {
      const operation = this[method].bind(this);
      this[method] = (...args) => {
        let cancelledColor;
        if (method === 'setFlameFlag' && args[1] === false) {
          const colorKey = args[0] === 'mediaLight' ? 'mediaColor'
            : args[0] === 'overheadLight' ? 'overheadColor' : undefined;
          if (colorKey) cancelledColor = this.cancelPendingColor(colorKey);
        } else if (method === 'setLogs' && args[0] === false) {
          cancelledColor = this.cancelPendingColor('logColor');
        }
        const queued = this.enqueueCommand(() => operation(...args), method);
        const pending = this.withWriteDeadline(queued, method);
        if (cancelledColor) this.settleColorWaiters(cancelledColor.waiters, pending);
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

    this.syncServices();
  }


  // Reconcile HomeKit services with config, reported capabilities, and
  // confirmed parameters. Runs at construction, after every overview,
  // and when discovery reports new capabilities, so unsupported
  // services are absent after a restart or capability change.
  syncServices() {
    const { Service, Characteristic } = this.platform;
    const fire = this.fire;
    if (controlEnabled(this.platform.config, 'exposePower')) {
      this.powerService = this.getService(Service.Switch, 'Fireplace', 'power');
      this.powerService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getPower())
        .onSet((value) => this.setPower(Boolean(value)));
    } else {
      this.removeService(Service.Switch, 'power');
      this.powerService = undefined;
    }

    if (controlEnabled(this.platform.config, 'exposeFlames')) {
      this.flameService = this.getService(Service.Lightbulb, 'Flames', 'flames');
      this.flameService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getFlames())
        .onSet((value) => this.setFlames(Boolean(value)));
      this.flameService.getCharacteristic(Characteristic.Brightness)
        .onGet(() => this.getFlameBrightness())
        .onSet((value) => this.setFlameBrightness(Number(value)));
    } else {
      this.removeService(Service.Lightbulb, 'flames');
      this.flameService = undefined;
    }

    if (controlEnabled(this.platform.config, 'exposeHeater')
      && (fire.withHeat || fire.features?.simpleHeat || fire.features?.advancedHeat)) {
      // v0.1.5 used a Switch with this subtype. Remove it before adding the
      // Thermostat service so Apple Home does not retain duplicate controls.
      const legacyHeatService = this.accessory.getServiceById?.(Service.Switch, 'heater')
        || this.accessory.services.find((service) => service.UUID === Service.Switch.UUID && service.subtype === 'heater');
      const legacyHeatName = legacyHeatService?.getCharacteristic?.(Characteristic.ConfiguredName)?.value;
      this.removeService(Service.Switch, 'heater');
      this.heatService = this.getService(Service.Thermostat, 'Heater', 'heater');
      if (legacyHeatName && ![
        'Heater', `${fire.friendlyName} Heater`, `${fire.fireId} Heater`,
      ].includes(legacyHeatName)) {
        applyServiceName(this.heatService, Characteristic, legacyHeatName);
      }
      const off = Characteristic.TargetHeatingCoolingState.OFF ?? 0;
      const heat = Characteristic.TargetHeatingCoolingState.HEAT ?? 1;
      this.heatService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
        .setProps?.({ validValues: [off, heat] })
        .onGet(() => this.getHeatTargetState())
        .onSet((value) => this.setHeat(Number(value) === heat));
      this.heatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
        .onGet(() => this.getHeatCurrentState());
      this.heatService.getCharacteristic(Characteristic.TargetTemperature)
        .setProps?.({ minStep: 0.5 })
        .onGet(() => this.getHeatSetpoint())
        .onSet((value) => this.setHeatTemperature(Number(value)));
      // The Flame Connect API exposes only a setpoint, not measured room
      // temperature. Mirror the setpoint to satisfy HomeKit's required field.
      this.heatService.getCharacteristic(Characteristic.CurrentTemperature)
        .onGet(() => this.getHeatSetpoint());
      this.heatService.getCharacteristic(Characteristic.TemperatureDisplayUnits)
        .onGet(() => Characteristic.TemperatureDisplayUnits.CELSIUS ?? 0);
    } else {
      this.removeService(Service.Switch, 'heater');
      this.removeService(Service.Thermostat, 'heater');
      this.heatService = undefined;
    }

    const hasAdvancedHeat = Boolean(this.heatService && fire.features?.advancedHeat);
    if (hasAdvancedHeat && controlEnabled(this.platform.config, 'exposeEcoMode')) {
      this.ecoService = this.getService(Service.Switch, 'Eco Mode', 'eco-mode');
      this.ecoService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getHeatMode(HeatMode.ECO))
        .onSet((value) => this.setEcoMode(Boolean(value)));
    } else {
      this.removeService(Service.Switch, 'eco-mode');
      this.ecoService = undefined;
    }

    if (this.heatService && fire.features?.fanOnly && controlEnabled(this.platform.config, 'exposeFanOnly')) {
      // Migrate the rejected v0.1.7 candidate's generic switch to a native fan
      // service. Apple Home represents this more clearly as a fan power tile.
      this.removeService(Service.Switch, 'fan-only');
      this.fanOnlyService = this.getService(Service.Fanv2, 'Fan Only', 'fan-only');
      this.fanOnlyService.getCharacteristic(Characteristic.Active)
        .onGet(() => this.getHeatMode(HeatMode.FAN_ONLY))
        .onSet((value) => this.setFanOnly(
          Number(value) !== (Characteristic.Active.INACTIVE ?? 0),
        ));
    } else {
      this.removeService(Service.Switch, 'fan-only');
      this.removeService(Service.Fanv2, 'fan-only');
      this.fanOnlyService = undefined;
    }

    if (this.heatService && fire.features?.powerBoost && controlEnabled(this.platform.config, 'exposeTurboBoost')) {
      this.boostService = this.getService(Service.Switch, 'Turbo Boost', 'turbo-boost');
      this.boostService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getHeatMode(HeatMode.BOOST))
        .onSet((value) => this.setTurboBoost(Boolean(value)));
    } else {
      this.removeService(Service.Switch, 'turbo-boost');
      this.boostService = undefined;
    }

    for (const service of [this.ecoService, this.fanOnlyService, this.boostService]) {
      if (service && !(this.heatService?.linkedServices || []).includes(service)) {
        this.heatService?.addLinkedService?.(service);
      }
    }

    if (controlEnabled(this.platform.config, 'exposeFlameSpeed') && this.flameParameterAvailable()) {
      this.speedService = this.getService(Service.Fanv2, 'Flame Speed', 'flame-speed');
      this.speedService.getCharacteristic(Characteristic.Active)
        .onGet(() => this.getFlameSpeedActive())
        .onSet((value) => this.setFlames(Number(value) !== (Characteristic.Active.INACTIVE ?? 0)));
      const speedCharacteristic = this.speedService.getCharacteristic(Characteristic.RotationSpeed);
      const speedLabel = this.speedService.getCharacteristic(Characteristic.ConfiguredName)?.value
        || this.speedService.displayName
        || 'Flame Speed';
      // RotationSpeed has a generic built-in name. Supply the service's actual
      // configured label as characteristic metadata so Home can identify this
      // otherwise-unlabelled slider while retaining user customisations.
      speedCharacteristic.displayName = speedLabel;
      speedCharacteristic.updateValue?.(20);
      speedCharacteristic
        .setProps?.({ minValue: 20, maxValue: 100, minStep: 20, description: speedLabel })
        .onGet(() => this.getFlameSpeedPercent())
        .onSet((value) => this.setFlameSpeed(Number(value)));
    } else {
      this.removeService(Service.Fanv2, 'flame-speed');
      this.speedService = undefined;
    }

    if (controlEnabled(this.platform.config, 'exposeMediaLight') && this.flameParameterAvailable()) {
      this.mediaService = this.getService(Service.Lightbulb, 'Media Light', 'media-light');
      this.mediaService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getFlameFlag('mediaLight'))
        .onSet((value) => this.setFlameFlag('mediaLight', Boolean(value)));
    } else {
      this.removeService(Service.Lightbulb, 'media-light');
      this.mediaService = undefined;
    }

    if (controlEnabled(this.platform.config, 'exposeOverheadLight') && this.flameParameterAvailable()) {
      this.overheadService = this.getService(Service.Lightbulb, 'Overhead', 'overhead-light');
      this.overheadService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getFlameFlag('overheadLight'))
        .onSet((value) => this.setFlameFlag('overheadLight', Boolean(value)));
    } else {
      this.removeService(Service.Lightbulb, 'overhead-light');
      this.overheadService = undefined;
    }

    if (controlEnabled(this.platform.config, 'exposeLogs') && fire.features?.rgbLogEffect
      && (this.lastRefresh === 0 || this.state.log !== undefined)) {
      this.logService = this.getService(Service.Lightbulb, 'Logs', 'log-effect');
      this.logService.getCharacteristic(Characteristic.On)
        .onGet(() => this.getLogs())
        .onSet((value) => this.setLogs(Boolean(value)));
      for (const [characteristic, field] of [[Characteristic.Hue, 'hue'],
        [Characteristic.Saturation, 'saturation'], [Characteristic.Brightness, 'brightness']]) {
        this.logService.getCharacteristic(characteristic)
          .onGet(async () => { await this.ensureFresh(); return this.reportedHsv('logColor', this.state.log?.color)[field]; })
          .onSet((value) => this.setLogColor(field, Number(value)));
      }
    } else {
      this.removeService(Service.Lightbulb, 'log-effect');
      this.logService = undefined;
    }

    if (this.platform.config.advancedControls && this.flameParameterAvailable()) {
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
      this.pulseService = undefined;
      this.ambientService = undefined;
    }

    const primaryService = this.powerService || this.flameService || this.heatService
      || this.mediaService || this.overheadService || this.logService;
    for (const service of [this.powerService, this.flameService, this.heatService,
      this.mediaService, this.overheadService, this.logService]) {
      if (service) service.isPrimaryService = service === primaryService;
    }
    for (const [service, key] of [[this.mediaService, 'mediaColor'], [this.overheadService, 'overheadColor']]) {
      if (!service) continue;
      for (const [characteristic, field] of [[Characteristic.Hue,'hue'], [Characteristic.Saturation,'saturation'], [Characteristic.Brightness,'brightness']]) {
        service.getCharacteristic(characteristic)
          .onGet(async () => { await this.ensureFresh(); return this.reportedHsv(key, this.state.flame?.[key])[field]; })
          .onSet(value => this.setLightColor(key, field, Number(value)));
      }
    }
  }

  // The flame-effect parameter (322) backs speed, media, overhead, and
  // advanced flag controls. Before the first successful refresh we
  // cannot disprove support, so services are built; afterwards the
  // parameter must actually be present.
  flameParameterAvailable() {
    return this.lastRefresh === 0 || this.state.flame !== undefined;
  }
  enqueueCommand(operation, label = 'command') {
    if (this.disposed) return Promise.reject(new Error('Flame Connect accessory is shutting down.'));
    const queuedAt = Date.now();
    this.queueDepth += 1;
    if (this.queueDepth > 1) {
      this.platform.log?.debug?.(`Flame Connect command queued (${this.queueDepth} pending).`);
    }
    const pending = this.commandQueue
      .then(() => {
        const waitedMs = Date.now() - queuedAt;
        if (waitedMs > 250) {
          this.platform.log?.debug?.(`Flame Connect command waited ${waitedMs}ms in the queue.`);
        }
        if (this.disposed) throw new Error('Flame Connect accessory is shutting down.');
        if (Date.now() < this.cloudFailureUntil && this.lastCloudError) throw this.lastCloudError;
        return this.runOperationWithAuthRetry(operation, label);
      })
      .then((value) => {
        if (this.inCloudFailure) {
          this.inCloudFailure = false;
          this.lastCloudError = null;
          this.platform.log?.info?.('Flame Connect cloud recovered.');
        }
        return value;
      })
      .catch((error) => {
        this.noteCloudFailure(error, label, Date.now() - queuedAt);
        throw this.toHapError(error);
      })
      .finally(() => {
        this.queueDepth = Math.max(0, this.queueDepth - 1);
      });
    this.commandQueue = pending.catch(() => {});
    return pending;
  }

  // A 401-rejected write never executed, so retrying the command once inside
  // the same queue slot is safe: the operation re-reads state first and
  // submits a single write. Retrying here (rather than re-enqueueing) avoids
  // chaining a new command behind the queue entry that is still settling.
  async runOperationWithAuthRetry(operation, label) {
    try {
      return await operation();
    } catch (error) {
      if (error?.code === 'FLAMECONNECT_WRITE_AUTH_REFRESHED' && !operation.authRetried) {
        operation.authRetried = true;
        this.platform.log?.debug?.(`Flame Connect ${label} retrying once after authentication refresh.`);
        return operation();
      }
      throw error;
    }
  }

  failureClass(error) {
    if (error?.kind === 'timeout') return 'timeout';
    if (error?.resultCode !== undefined) return `rejected(resultCode=${error.resultCode})`;
    if (error?.code === 'FLAMECONNECT_REAUTH_REQUIRED') return 'reauth_required';
    if (error?.code === 'FLAMECONNECT_NO_TOKEN') return 'not_configured';
    return 'communication';
  }

  noteCloudFailure(error, label, elapsedMs) {
    if (!isCloudError(error)) return;
    // One cloud failure creates one bounded cooldown. Already-queued commands
    // rethrow the identical error object; extending the cooldown for those
    // would let a burst hold every control hostage without another request.
    if (error === this.lastCloudError) return;
    this.cloudFailureUntil = Date.now() + 2_000;
    this.lastCloudError = error;
    if (this.inCloudFailure) {
      this.platform.log?.debug?.(
        `Flame Connect ${label} failed (${this.failureClass(error)}).`,
      );
      return;
    }
    this.inCloudFailure = true;
    // One concise, privacy-safe entry: control, operation, elapsed time, and
    // failure class. No device identifiers.
    this.platform.log?.warn?.(
      `Flame Connect ${label} failed after ${elapsedMs}ms (${this.failureClass(error)}): ${error.message}`,
    );
  }

  // HomeKit characteristic writes must settle inside the HAP response window.
  // On deadline the caller gets OPERATION_TIMED_OUT while the queued command
  // keeps running and reconciles via pushStateToHomeKit on completion.
  withWriteDeadline(promise, label) {
    return withTimeout(promise, HAP_HANDLER_TIMEOUT_MS, `Flame Connect ${label}`).catch((error) => {
      if (error?.code !== 'FLAMECONNECT_HAP_DEADLINE') throw error;
      this.platform.log?.warn?.(
        `Flame Connect ${label} did not finish within the HomeKit response window; reconciling in the background without replaying the write.`,
      );
      throw this.toHapError(new FlameConnectCloudError(
        `Flame Connect ${label} timed out waiting for the cloud.`,
        { kind: 'timeout' },
      ));
    });
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
    const merged = mergeFireMetadata(this.fire, fire, preferIncomingName);
    // Avoid a cache write on every overview: only persist when user-visible
    // metadata actually changed.
    const relevant = (value) => JSON.stringify({
      friendlyName: value.friendlyName,
      brand: value.brand,
      productModel: value.productModel,
      connectionState: value.connectionState,
      features: value.features,
    });
    const changed = relevant(merged) !== relevant(this.fire);
    this.fire = merged;
    this.accessory.context.fire = this.fire;
    if (changed) this.platform.api.updatePlatformAccessories([this.accessory]);
    // Capability flags may have changed: reconcile exposed services.
    this.syncServices();
  }

  async ensureFresh(force = false) {
    const cacheMs = Math.max(5, Number(this.platform.config.cacheSeconds || 30)) * 1000;
    if (!force && this.lastRefresh && Date.now() - this.lastRefresh < cacheMs) return this.state;
    // Reads must also settle inside the HAP window. On deadline the getter
    // proceeds with the last known state; the refresh continues in the
    // background and reconciles via pushStateToHomeKit on completion.
    try {
      return await withTimeout(this.refresh(), HAP_HANDLER_TIMEOUT_MS, 'Flame Connect read');
    } catch (error) {
      if (error?.code === 'FLAMECONNECT_HAP_DEADLINE') {
        this.platform.log?.debug?.('Flame Connect read exceeded the HomeKit response window; serving last known state.');
        return this.state;
      }
      throw error;
    }
  }

  async ensureCommandFresh() {
    const configured = Number(this.platform.config.commandStateMaxAgeSeconds ?? 10);
    const maximumAgeMs = Math.min(60, Math.max(0, Number.isFinite(configured) ? configured : 10)) * 1000;
    const ageMs = this.lastRefresh ? Date.now() - this.lastRefresh : Number.POSITIVE_INFINITY;
    if (maximumAgeMs > 0 && ageMs < maximumAgeMs) {
      this.platform.log?.debug?.(`Using ${Math.max(0, Math.round(ageMs))}ms-old state for Flame Connect command.`);
      return this.state;
    }
    this.platform.log?.debug?.('Refreshing state before Flame Connect command.');
    return this.refresh();
  }

  reportedHsv(key, color) {
    const actual = rgbwToHsv(color);
    const remembered = this.accessory.context.lightColors?.[key];
    // Whether the light is on is determined by its flag and brightness, not
    // by guessing from channel values: a device may report white channels
    // while the light is off. An off light always keeps showing its last
    // selected Home color.
    const flag = key === 'logColor'
      ? this.state.log?.logEffect
      : this.state.flame?.[key === 'mediaColor' ? 'mediaLight' : 'overheadLight'];
    const off = flag !== OnOff.ON || actual.brightness === 0;
    if (off && remembered) {
      return { hue: remembered.hue, saturation: remembered.saturation, brightness: 0 };
    }
    return actual;
  }

  stageColor(key, field, value) {
    if (this.disposed) return Promise.reject(new Error('Flame Connect accessory is shutting down.'));
    let pending = this.pendingColors.get(key);
    if (!pending) {
      pending = {
        changes: {}, waiters: [], timer: null,
        release: null, cancelled: false,
      };
      pending.gate = new Promise((resolve) => { pending.release = resolve; });
      this.pendingColors.set(key, pending);
      // Reserve the queue position now, not when the coalescing window
      // elapses: a later power or light command is enqueued behind the color
      // and can never pass it, so command order is defined at stage time.
      // The placeholder waits for the trailing-edge window, then either
      // commits the coalesced color or resolves quietly when cancelled.
      pending.operation = this.enqueueCommand(async () => {
        await pending.gate;
        if (pending.cancelled || this.disposed) return undefined;
        return this.commitColor(key, pending.changes);
      }, `color(${key})`);
      pending.operation.then(
        (result) => {
          if (!pending.cancelled) pending.waiters.forEach(({ resolve }) => resolve(result));
        },
        (error) => {
          if (!pending.cancelled) pending.waiters.forEach(({ reject }) => reject(error));
        },
      );
    }
    pending.changes[field] = value;
    const result = new Promise((resolve, reject) => pending.waiters.push({ resolve, reject }));
    // Trailing edge: every new component restarts the window, so a slow
    // gesture coalesces into a single cloud write.
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this.flushPendingColor(key), 200);
    return result;
  }

  flushPendingColor(key) {
    const pending = this.pendingColors.get(key);
    if (!pending) return;
    this.pendingColors.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    pending.release();
  }

  cancelPendingColor(key) {
    const pending = this.pendingColors.get(key);
    if (!pending) return null;
    this.pendingColors.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    const remembered = (this.accessory.context.lightColors ||= {});
    const color = key === 'logColor' ? this.state.log?.color : this.state.flame?.[key];
    remembered[key] = { ...this.reportedHsv(key, color), ...pending.changes };
    // Only a still-staged color can be cancelled. Once flushPendingColor has
    // released the gate the cloud write is underway and must not be
    // interrupted; later commands then execute after it in queue order.
    pending.cancelled = true;
    pending.release();
    return pending;
  }

  settleColorWaiters(waiters, operation) {
    operation.then(
      (value) => waiters.forEach(({ resolve }) => resolve(value)),
      (error) => waiters.forEach(({ reject }) => reject(error)),
    );
  }

  async commitColor(key, changes) {
    await this.ensureCommandFresh();
    const remembered = (this.accessory.context.lightColors ||= {});
    const color = key === 'logColor' ? this.state.log?.color : this.state.flame?.[key];
    const current = this.reportedHsv(key, color);
    const next = { ...(current.brightness === 0 ? remembered[key] || current : current), ...changes };
    if (key === 'logColor') {
      this.state.log = await this.platform.client.setLogColor(
        this.fire.fireId, this.state.log, hsvToRgbw(next),
      );
    } else {
      this.state.flame = await this.platform.client.setFlame(
        this.fire.fireId, this.state.flame, { [key]: hsvToRgbw(next), mediaTheme: 0 },
      );
    }
    remembered[key] = next;
    this.commandSucceeded();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.boostRefreshTimer) {
      clearTimeout(this.boostRefreshTimer);
      this.boostRefreshTimer = null;
    }
    const error = new Error('Flame Connect accessory is shutting down.');
    for (const key of [...this.pendingColors.keys()]) {
      const pending = this.cancelPendingColor(key);
      pending?.waiters.forEach(({ reject }) => reject(error));
    }
  }

  // Cloud and network failures become HomeKit communication errors so the
  // Home app shows "No Response" instead of silently keeping stale state.
  // Local validation errors pass through unchanged. This is a pure
  // conversion: failure bookkeeping lives in noteCloudFailure.
  toHapError(error) {
    const hap = this.platform?.api?.hap;
    if (!hap?.HapStatusError || !hap?.HAPStatus) return error;
    if (error instanceof hap.HapStatusError) return error;
    if (isCloudError(error)) {
      const status = error.kind === 'timeout'
        ? (hap.HAPStatus.OPERATION_TIMED_OUT ?? hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
        : hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
      const hapError = new hap.HapStatusError(status);
      if (error.code === 'FLAMECONNECT_REAUTH_REQUIRED') hapError.code = error.code;
      return hapError;
    }
    return error;
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      // Capture the state version before the GET: a command that completes
      // while this read is in flight holds newer state, and this older
      // response must not overwrite it when it lands late.
      const epoch = this.stateEpoch;
      try {
        const overview = await this.platform.client.getFireOverview(this.fire.fireId);
        if (epoch !== this.stateEpoch) {
          this.platform.log?.debug?.('Flame Connect discarded a stale overview that landed after a newer command.');
          return this.state;
        }
        const merged = { ...this.state, ...overview.parameters };
        const decodeErrors = overview.decodeErrors || [];
        if (decodeErrors.length > 0 && Object.keys(this.state).length === 0) {
          // Nothing usable to fall back to: fail loudly instead of marking
          // an incomplete snapshot fresh.
          throw new FlameConnectCloudError(
            `Flame Connect returned incomplete fireplace state (undecoded parameters: ${decodeErrors.join(', ')}).`,
          );
        }
        if (decodeErrors.length > 0) {
          // The merge above already retains last good values for parameters
          // that failed to decode, instead of silently dropping them.
          this.platform.log?.warn?.(
            `Flame Connect overview was missing parameters (${decodeErrors.join(', ')}); keeping last known values.`,
          );
        }
        this.state = merged;
        this.stateEpoch += 1;
        this.lastRefresh = Date.now();
        if (overview.fire) this.updateFire(overview.fire);
        this.updateHealthState();
        this.syncServices();
        this.pushStateToHomeKit();
        return this.state;
      } catch (error) {
        this.noteCloudFailure(error, 'refresh', 0);
        throw this.toHapError(error);
      }
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  updateHealthState() {
    const bytes = Array.isArray(this.state.error?.bytes) ? this.state.error.bytes : [];
    const faultBytes = bytes.map((value) => Number(value) & 0xff);
    const hasFault = faultBytes.some((value) => value !== 0);
    const connectionState = Number(this.fire.connectionState ?? 0);
    // Track hardware faults and connection state independently: a connection
    // change must not repeat an existing fault warning, and fault recovery
    // must not be announced twice.
    const previous = this.healthState ? JSON.parse(this.healthState) : null;
    const previousFault = previous?.faultBytes?.some((value) => value !== 0) ?? false;
    const previousConnection = previous?.connectionState;
    this.healthState = JSON.stringify({ faultBytes, connectionState });
    if (hasFault && !previousFault) {
      const code = faultBytes.map((value) => value.toString(16).padStart(2, '0')).join(' ');
      this.platform.log?.warn?.(`The fireplace reported a device fault (code ${code}).`);
    } else if (!hasFault && previousFault) {
      this.platform.log?.info?.('The fireplace no longer reports a device fault.');
    }
    if (previous && previousConnection !== connectionState) {
      this.platform.log?.debug?.(`Flame Connect device connection state changed to ${connectionState}.`);
    }
  }

  pushStateToHomeKit() {
    const C = this.platform.Characteristic;
    for (const [service,key] of [[this.mediaService,'mediaColor'],[this.overheadService,'overheadColor']]) {
      if (!service || !this.state.flame?.[key]) continue;
      const hsv=this.reportedHsv(key, this.state.flame[key]);
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
      this.speedService?.updateCharacteristic(C.Active, this.state.flame.flameEffect === OnOff.ON
        ? (C.Active.ACTIVE ?? 1) : (C.Active.INACTIVE ?? 0));
      this.speedService?.updateCharacteristic(C.RotationSpeed, this.state.flame.flameSpeed * 20);
    }
    if (this.state.heat && this.heatService) {
      const heating = this.isHeating();
      const fanRunning = this.state.heat.heatMode === HeatMode.FAN_ONLY
        && this.state.heat.heatStatus === OnOff.ON;
      this.heatService.updateCharacteristic(C.TargetHeatingCoolingState,
        heating ? (C.TargetHeatingCoolingState.HEAT ?? 1) : (C.TargetHeatingCoolingState.OFF ?? 0));
      this.heatService.updateCharacteristic(C.CurrentHeatingCoolingState,
        heating ? (C.CurrentHeatingCoolingState.HEAT ?? 1) : (C.CurrentHeatingCoolingState.OFF ?? 0));
      this.heatService.updateCharacteristic(C.TargetTemperature, this.state.heat.setpointTemperature);
      this.heatService.updateCharacteristic(C.CurrentTemperature, this.state.heat.setpointTemperature);
      this.ecoService?.updateCharacteristic(C.On, this.state.heat.heatMode === HeatMode.ECO);
      this.fanOnlyService?.updateCharacteristic(C.Active,
        fanRunning ? (C.Active.ACTIVE ?? 1) : (C.Active.INACTIVE ?? 0));
      this.boostService?.updateCharacteristic(C.On,
        this.state.heat.heatMode === HeatMode.BOOST && heating);
    }
    if (this.state.log && this.logService) {
      this.logService.updateCharacteristic(C.On, this.state.log.logEffect === OnOff.ON);
      const hsv = this.reportedHsv('logColor', this.state.log.color);
      this.logService.updateCharacteristic(C.Hue, hsv.hue);
      this.logService.updateCharacteristic(C.Saturation, hsv.saturation);
      this.logService.updateCharacteristic(C.Brightness, hsv.brightness);
    }
  }

  // Record a successful command's state change: bump the version so a stale
  // in-flight refresh cannot overwrite it, mark it fresh, and push to HomeKit.
  commandSucceeded() {
    this.stateEpoch += 1;
    this.lastRefresh = Date.now();
    this.pushStateToHomeKit();
  }

  async getPower() {
    await this.ensureFresh();
    return this.state.mode?.mode === FireMode.MANUAL;
  }

  async setPower(on) {
    await this.ensureCommandFresh();
    await this.platform.client.setPower(this.fire.fireId, this.state, on);
    if (this.state.mode) this.state.mode = { ...this.state.mode, mode: on ? FireMode.MANUAL : FireMode.STANDBY };
    if (on && this.state.flame) this.state.flame = { ...this.state.flame, flameEffect: OnOff.ON };
    this.commandSucceeded();
  }

  async getFlames() {
    await this.ensureFresh();
    return this.state.flame?.flameEffect === OnOff.ON;
  }

  async setFlames(on) {
    await this.ensureCommandFresh();
    this.state.flame = await this.platform.client.setFlame(
      this.fire.fireId,
      this.state.flame,
      { flameEffect: on ? OnOff.ON : OnOff.OFF },
    );
    this.commandSucceeded();
  }

  async getFlameBrightness() {
    await this.ensureFresh();
    return this.state.flame?.brightness === Brightness.LOW ? 50 : 100;
  }

  async setFlameBrightness(value) {
    await this.ensureCommandFresh();
    const brightness = value <= 50 ? Brightness.LOW : Brightness.HIGH;
    this.state.flame = await this.platform.client.setFlame(this.fire.fireId, this.state.flame, { brightness });
    this.commandSucceeded();
  }

  async getFlameSpeedActive() {
    await this.ensureFresh();
    return this.state.flame?.flameEffect === OnOff.ON
      ? (this.platform.Characteristic.Active.ACTIVE ?? 1)
      : (this.platform.Characteristic.Active.INACTIVE ?? 0);
  }

  async getFlameSpeedPercent() {
    await this.ensureFresh();
    return Math.min(5, Math.max(1, Number(this.state.flame?.flameSpeed ?? 1))) * 20;
  }

  async setFlameSpeed(percent) {
    if (!Number.isFinite(percent)) throw new Error('Invalid flame speed.');
    await this.ensureCommandFresh();
    const speed = Math.min(5, Math.max(1, Math.round(percent / 20)));
    this.state.flame = await this.platform.client.setFlameSpeed(this.fire.fireId, this.state.flame, speed);
    this.commandSucceeded();
  }

  async getFlameFlag(key) {
    await this.ensureFresh();
    return this.state.flame?.[key] === OnOff.ON;
  }

  async setFlameFlag(key, on) {
    await this.ensureCommandFresh();
    this.state.flame = await this.platform.client.setFlame(
      this.fire.fireId,
      this.state.flame,
      { [key]: on ? OnOff.ON : OnOff.OFF },
    );
    this.commandSucceeded();
  }

  setLightColor(key, field, value) {
    if (!['mediaColor','overheadColor'].includes(key) || !['hue','saturation','brightness'].includes(field)
      || !Number.isFinite(value)) throw new Error('Invalid lighting color setting.');
    return this.withWriteDeadline(this.stageColor(key, field, value), `color(${key})`);
  }

  async getHeat() {
    await this.ensureFresh();
    return this.state.heat?.heatStatus === OnOff.ON;
  }

  // True only when the heater element is actually engaged. Fan-only runs with
  // heatStatus on but is not heating — Home must not show "currently heating".
  isHeating() {
    return this.state.heat?.heatStatus === OnOff.ON
      && HEATING_MODES.includes(this.state.heat?.heatMode);
  }

  async getHeatTargetState() {
    await this.ensureFresh();
    return this.isHeating()
      ? (this.platform.Characteristic.TargetHeatingCoolingState.HEAT ?? 1)
      : (this.platform.Characteristic.TargetHeatingCoolingState.OFF ?? 0);
  }

  async getHeatCurrentState() {
    await this.ensureFresh();
    return this.isHeating()
      ? (this.platform.Characteristic.CurrentHeatingCoolingState.HEAT ?? 1)
      : (this.platform.Characteristic.CurrentHeatingCoolingState.OFF ?? 0);
  }

  async getHeatSetpoint() {
    await this.ensureFresh();
    return Number(this.state.heat?.setpointTemperature ?? 22);
  }

  async setHeat(on) {
    await this.ensureCommandFresh();
    if (on && this.state.heat && !HEATING_MODES.includes(this.state.heat.heatMode)) {
      // Turning on Heat from Fan Only must produce actual heating, not a
      // faster fan: return to Normal mode with the heater engaged.
      this.state.heat = await this.platform.client.setHeatMode(
        this.fire.fireId, this.state.heat, { heatMode: HeatMode.NORMAL, heatStatus: OnOff.ON },
      );
    } else {
      this.state.heat = await this.platform.client.setHeat(this.fire.fireId, this.state.heat, on);
    }
    this.commandSucceeded();
  }

  async setHeatTemperature(value) {
    if (!Number.isFinite(value)) throw new Error('Invalid heater target temperature.');
    await this.ensureCommandFresh();
    this.state.heat = await this.platform.client.setHeatTemperature(this.fire.fireId, this.state.heat, value);
    this.commandSucceeded();
  }

  async getHeatMode(mode) {
    await this.ensureFresh();
    return this.state.heat?.heatMode === mode
      && (mode === HeatMode.ECO || this.state.heat?.heatStatus === OnOff.ON);
  }

  rememberPersistentHeatState() {
    const heat = this.state.heat || {};
    if ([HeatMode.NORMAL, HeatMode.ECO].includes(heat.heatMode)) {
      this.accessory.context.previousHeatState = {
        heatMode: heat.heatMode,
        heatStatus: heat.heatStatus,
      };
    }
  }

  // Internal: callers (setEcoMode/setFanOnly/setTurboBoost) ensure command
  // freshness exactly once before delegating here, so a queued command makes
  // at most one pre-write overview GET even with commandStateMaxAgeSeconds 0.
  async setHeatMode(changes) {
    this.state.heat = await this.platform.client.setHeatMode(this.fire.fireId, this.state.heat, changes);
    this.commandSucceeded();
  }

  async setEcoMode(on) {
    await this.ensureCommandFresh();
    await this.setHeatMode({ heatMode: on ? HeatMode.ECO : HeatMode.NORMAL });
  }

  async setFanOnly(on) {
    await this.ensureCommandFresh();
    if (on) {
      this.rememberPersistentHeatState();
      return this.setHeatMode({ heatMode: HeatMode.FAN_ONLY, heatStatus: OnOff.ON });
    }
    const previous = this.accessory.context.previousHeatState || {};
    return this.setHeatMode({
      heatMode: [HeatMode.NORMAL, HeatMode.ECO].includes(previous.heatMode)
        ? previous.heatMode : HeatMode.NORMAL,
      // Exiting fan-only must never unexpectedly start the heater.
      heatStatus: OnOff.OFF,
    });
  }

  async setTurboBoost(on) {
    await this.ensureCommandFresh();
    if (on) {
      this.rememberPersistentHeatState();
      const duration = Math.min(20, Math.max(1, Number(this.platform.config.turboBoostMinutes || 20)));
      await this.setHeatMode({
        heatMode: HeatMode.BOOST,
        heatStatus: OnOff.ON,
        boostDuration: duration,
      });
      if (this.boostRefreshTimer) clearTimeout(this.boostRefreshTimer);
      this.boostRefreshTimer = setTimeout(() => {
        void this.refresh().catch((error) => this.platform.log?.warn?.(
          `Could not refresh Turbo Boost state: ${error.message}`,
        ));
      }, duration * 60_000 + 2_000);
      this.boostRefreshTimer.unref?.();
      return;
    }
    if (this.boostRefreshTimer) clearTimeout(this.boostRefreshTimer);
    const previous = this.accessory.context.previousHeatState || {};
    return this.setHeatMode({
      heatMode: [HeatMode.NORMAL, HeatMode.ECO].includes(previous.heatMode)
        ? previous.heatMode : HeatMode.NORMAL,
      heatStatus: previous.heatStatus === OnOff.ON ? OnOff.ON : OnOff.OFF,
    });
  }

  async getLogs() {
    await this.ensureFresh();
    return this.state.log?.logEffect === OnOff.ON;
  }

  async setLogs(on) {
    await this.ensureCommandFresh();
    this.state.log = await this.platform.client.setLog(this.fire.fireId, this.state.log, on);
    this.commandSucceeded();
  }

  setLogColor(field, value) {
    if (!['hue', 'saturation', 'brightness'].includes(field) || !Number.isFinite(value)) {
      throw new Error('Invalid log color setting.');
    }
    return this.withWriteDeadline(this.stageColor('logColor', field, value), 'color(logColor)');
  }
}
