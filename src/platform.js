import path from 'node:path';
import { FlameConnectAccessory } from './accessory.js';
import { FlameConnectAuth } from './flameconnect/auth.js';
import { FlameConnectClient } from './flameconnect/client.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      try {
        results[current] = { status: 'fulfilled', value: await worker(items[current], current) };
      } catch (reason) {
        results[current] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export class FlameConnectPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config && typeof config === 'object' && !Array.isArray(config) ? { ...config } : {};
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.accessories = new Map();
    this.handlers = new Map();
    this.pollTimer = null;
    // Startup discovery retry state. A failed first getFires() must not leave
    // the plugin permanently dead: there may be no handlers for the poll loop
    // to refresh, so discovery itself retries on a bounded backoff schedule.
    this.discoveryTimer = null;
    this.discoveryAttempts = 0;
    this.refreshAllPromise = null;
    this.authenticationBlocked = false;
    this.stopped = false;
    this.sanitizeConfig();

    const storagePath = api.user.storagePath();
    const tokenFile = this.config.tokenFile || path.join(storagePath, 'flame-connect-tokens.json');
    this.auth = new FlameConnectAuth({
      refreshToken: this.config.refreshToken,
      tokenFile,
      log,
    });
    this.client = new FlameConnectClient(this.auth, log);

    api.on('didFinishLaunching', () => {
      if (this.allControlsDisabled()) {
        for (const accessory of this.accessories.values()) {
          this.handlers.get(accessory.UUID)?.dispose();
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
        this.handlers.clear();
        this.accessories.clear();
        return;
      }
      void this.discoverDevices();
    });
    api.on('shutdown', () => {
      this.stopped = true;
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.clearDiscoveryRetry();
      for (const handler of this.handlers.values()) handler.dispose();
    });
  }

  // Runtime config validation: the UI schema cannot be trusted to constrain
  // values (hand-edited config, older cached values). Sanitize independently
  // so invalid values can neither crash nor trigger rapid polling.
  sanitizeConfig() {
    const config = this.config;
    if (typeof config.name === 'string') {
      const name = config.name.trim().slice(0, 64);
      if (name) config.name = name; else delete config.name;
    }
    const numeric = (key, { min, max, fallback }) => {
      const value = config[key] === '' || config[key] == null || typeof config[key] === 'boolean' ? NaN : Number(config[key]);
      config[key] = Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback;
    };
    numeric('pollIntervalMinutes', { min: 5, max: 1440, fallback: 15 });
    numeric('cacheSeconds', { min: 5, max: 600, fallback: 30 });
    numeric('commandStateMaxAgeSeconds', { min: 0, max: 60, fallback: 10 });
    numeric('turboBoostMinutes', { min: 1, max: 20, fallback: 20 });
    if (typeof config.tokenFile === 'string' && config.tokenFile.trim()) config.tokenFile = config.tokenFile.trim();
    else delete config.tokenFile;
    for (const key of Object.keys(config).filter((key) => key.endsWith('Name'))) {
      if (typeof config[key] !== 'string') delete config[key];
      else config[key] = config[key].trim().slice(0, 64);
    }
  }

  // True when the user has explicitly disabled every control. Such a
  // fireplace gets no accessory at all rather than a confusing
  // information-only tile with nothing to operate.
  allControlsDisabled() {
    const keys = ['exposePower', 'exposeFlames', 'exposeHeater', 'exposeEcoMode',
      'exposeFanOnly', 'exposeTurboBoost', 'exposeFlameSpeed', 'exposeMediaLight',
      'exposeOverheadLight', 'exposeLogs'];
    return keys.every((key) => this.config[key] === false) && !this.config.advancedControls;
  }

  configureAccessory(accessory) {
    if (this.stopped) return;
    this.accessories.set(accessory.UUID, accessory);
    // Configure handlers immediately from cached context so existing controls
    // keep working through a startup outage. syncServices() reconciles with
    // current capabilities once discovery and the first refresh complete, so
    // a cached handler can never permanently omit newly learned services.
    if (accessory.context?.fire && !this.handlers.has(accessory.UUID)) {
      const handler = new FlameConnectAccessory(this, accessory, accessory.context.fire);
      this.handlers.set(accessory.UUID, handler);
      handler.debugLabel = `fireplace ${this.handlers.size}`;
    }
  }

  attach(accessory, fire) {
    let handler = this.handlers.get(accessory.UUID);
    if (!handler) {
      handler = new FlameConnectAccessory(this, accessory, fire);
      this.handlers.set(accessory.UUID, handler);
      handler.debugLabel = `fireplace ${this.handlers.size}`;
    } else {
      // The account device list contains the authoritative user-facing name.
      // Overview responses on some models return a hardware identifier instead.
      handler.updateFire(fire, true);
    }
    return handler;
  }

  async discoverDevices() {
    if (this.stopped) return;
    try {
      this.log.info('Connecting to Flame Connect...');
      const { fires, malformed } = await this.client.getFires();
      if (this.stopped) return;
      const discovered = new Set();
      const refreshes = [];

      for (const fire of fires) {
        const uuid = this.api.hap.uuid.generate(`flameconnect:${fire.fireId}`);
        if (this.allControlsDisabled()) {
          this.log.info(`All controls disabled for ${fire.friendlyName}; skipping HomeKit registration.`);
          continue;
        }
        discovered.add(uuid);
        let accessory = this.accessories.get(uuid);
        if (!accessory) {
          accessory = new this.api.platformAccessory(fire.friendlyName, uuid);
          accessory.context.fire = fire;
          // Attach the handler before registering so the accessory is fully
          // configured (services, handlers, primary service) when HomeKit
          // first sees it.
          const handler = this.attach(accessory, fire);
          if (!accessory.services.some((service) => service.subtype)) {
            handler.dispose();
            this.handlers.delete(uuid);
            discovered.delete(uuid);
            this.log.info('No supported controls are enabled; skipping fireplace registration.');
            continue;
          }
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.set(uuid, accessory);
          this.log.info(`Added Flame Connect fireplace: ${fire.friendlyName}`);
        } else {
          this.attach(accessory, fire);
        }
        const handler = this.handlers.get(uuid);
        const controls = [
          ['Fireplace', handler.powerService], ['Flames', handler.flameService],
          ['Heater', handler.heatService], ['Eco Mode', handler.ecoService],
          ['Fan Only', handler.fanOnlyService], ['Turbo Boost', handler.boostService],
          ['Flame Speed', handler.speedService], ['Media Bed', handler.mediaService],
          ['Media Accent', handler.overheadService], ['Logs', handler.logService],
        ].filter(([, service]) => Boolean(service)).map(([name]) => name);
        this.log.info(`Exposed HomeKit controls: ${controls.join(', ')}.`);
        this.log.info(`Capabilities: heat=${Boolean(fire.withHeat)}, advanced heat=${Boolean(fire.features?.advancedHeat)}, eco=${Boolean(fire.features?.advancedHeat)}, fan only=${Boolean(fire.features?.fanOnly)}, turbo boost=${Boolean(fire.features?.powerBoost)}, RGB logs=${Boolean(fire.features?.rgbLogEffect)}.`);
        refreshes.push({ fire, handler });
      }

      // Remove stale accessories before the first refresh: a removed device's
      // handler must not consume a refresh slot or briefly reappear.
      // A device list containing records without identifiers is not
      // authoritative — an accessory missing from it may simply have been
      // dropped from the malformed response — so fail closed and keep
      // existing accessories instead of unregistering anything.
      if (malformed) {
        this.log.warn('Flame Connect device list contained invalid records; keeping existing accessories.');
      } else {
        for (const [uuid, accessory] of this.accessories) {
          if (!discovered.has(uuid)) {
            this.log.info(`Removing stale Flame Connect accessory: ${accessory.displayName}`);
            this.handlers.get(uuid)?.dispose();
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.accessories.delete(uuid);
            this.handlers.delete(uuid);
          }
        }
      }

      const refreshResults = await mapWithConcurrency(
        refreshes,
        3,
        ({ handler }) => handler.refresh(),
      );
      if (this.stopped) return;
      refreshResults.forEach((result, index) => {
        const { fire } = refreshes[index];
        if (result.status === 'fulfilled') this.log.info(`Ready: ${fire.friendlyName}`);
        else this.log.warn(`Could not refresh ${fire.friendlyName}: ${result.reason?.message || result.reason}`);
      });

      if (!fires.length) {
        this.log.warn('Flame Connect account returned no fireplaces.');
      }
      this.discoveryAttempts = 0;
      this.authenticationBlocked = refreshResults.some((result) => result.status === 'rejected'
        && ['FLAMECONNECT_REAUTH_REQUIRED', 'FLAMECONNECT_NO_TOKEN'].includes(result.reason?.code));
      if (this.authenticationBlocked) this.log.error('Open the plugin settings and sign in again to resume background refresh.');
      this.clearDiscoveryRetry();
      this.startPolling();
    } catch (error) {
      if (this.stopped) return;
      this.log.error(`Flame Connect startup failed: ${error.message}`);
      // Permanent authentication states need the user, not another attempt:
      // retrying them on the backoff schedule burns requests and spams the
      // log every five minutes until someone restarts Homebridge.
      if (error?.code === 'FLAMECONNECT_REAUTH_REQUIRED') {
        this.authenticationBlocked = true;
        this.log.error('The saved Flame Connect sign-in is no longer valid. Open the plugin settings and sign in again; your fireplace configuration is unaffected.');
        return;
      }
      if (error?.code === 'FLAMECONNECT_NO_TOKEN') {
        this.authenticationBlocked = true;
        this.log.error('Open the Flame Connect plugin settings and complete guided sign-in.');
        return;
      }
      this.scheduleDiscoveryRetry(error);
    }
  }

  // Bounded exponential backoff for discovery retries: 10s, 20s, 40s, ...
  // capped at 5 minutes. Kept as a method so tests can assert the bound.
  discoveryRetryDelay(attempt) {
    return Math.min(10_000 * 2 ** attempt, 300_000);
  }

  clearDiscoveryRetry() {
    if (this.discoveryTimer) {
      clearTimeout(this.discoveryTimer);
      this.discoveryTimer = null;
    }
  }

  scheduleDiscoveryRetry(error) {
    if (this.stopped) return;
    const attempt = this.discoveryAttempts;
    this.discoveryAttempts += 1;
    const delayMs = Math.max(this.discoveryRetryDelay(attempt), Number(error?.retryAfterMs || 0));
    this.log.error(
      `Flame Connect discovery failed (attempt ${attempt + 1}); retrying in ${Math.round(delayMs / 1000)}s: ${error.message}`,
    );
    this.clearDiscoveryRetry();
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = null;
      void this.discoverDevices();
    }, delayMs);
    this.discoveryTimer.unref?.();
  }

  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.authenticationBlocked || this.stopped) return;
    const minutes = Math.min(1440, Math.max(5, Number(this.config.pollIntervalMinutes ?? 15)));
    this.pollTimer = setInterval(() => {
      void this.refreshAll();
    }, minutes * 60_000);
    this.pollTimer.unref?.();
  }

  async refreshAll() {
    if (this.authenticationBlocked || this.stopped) return;
    if (this.refreshAllPromise) return this.refreshAllPromise;
    this.refreshAllPromise = (async () => {
      const results = await mapWithConcurrency([...this.handlers.values()], 3, (handler) => handler.refresh());
      if (this.stopped) return;
      for (const result of results) {
        if (result.status !== 'rejected') continue;
        const error = result.reason;
        if (error?.code === 'FLAMECONNECT_REAUTH_REQUIRED' || error?.code === 'FLAMECONNECT_NO_TOKEN') {
          this.authenticationBlocked = true;
          if (this.pollTimer) clearInterval(this.pollTimer);
          this.pollTimer = null;
          this.log.error('Flame Connect background refresh stopped. Open the plugin settings and sign in again.');
          break;
        }
        this.log.warn(`Flame Connect background refresh failed: ${error?.message || error}`);
      }
    })().finally(() => {
      this.refreshAllPromise = null;
    });
    return this.refreshAllPromise;
  }
}
