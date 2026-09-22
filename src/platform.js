import path from 'node:path';
import { FlameConnectAccessory } from './accessory.js';
import { FlameConnectAuth } from './flameconnect/auth.js';
import { FlameConnectClient } from './flameconnect/client.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export class FlameConnectPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
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

    const storagePath = api.user.storagePath();
    const tokenFile = this.config.tokenFile || path.join(storagePath, 'flame-connect-tokens.json');
    this.auth = new FlameConnectAuth({
      refreshToken: this.config.refreshToken,
      tokenFile,
      log,
    });
    this.client = new FlameConnectClient(this.auth, log);

    api.on('didFinishLaunching', () => {
      void this.discoverDevices();
    });
    api.on('shutdown', () => {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.clearDiscoveryRetry();
    });
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
    // Do not construct services from cached capabilities. New plugin versions
    // may learn additional feature flags (PowerBoost in v0.1.7), and a cached
    // handler would omit those services before current discovery data arrives.
  }

  attach(accessory, fire) {
    let handler = this.handlers.get(accessory.UUID);
    if (!handler) {
      handler = new FlameConnectAccessory(this, accessory, fire);
      this.handlers.set(accessory.UUID, handler);
    } else {
      // The account device list contains the authoritative user-facing name.
      // Overview responses on some models return a hardware identifier instead.
      handler.updateFire(fire, true);
    }
    return handler;
  }

  async discoverDevices() {
    try {
      this.log.info('Connecting to Flame Connect...');
      const fires = await this.client.getFires();
      const discovered = new Set();

      for (const fire of fires) {
        const uuid = this.api.hap.uuid.generate(`flameconnect:${fire.fireId}`);
        discovered.add(uuid);
        let accessory = this.accessories.get(uuid);
        if (!accessory) {
          accessory = new this.api.platformAccessory(fire.friendlyName, uuid);
          accessory.context.fire = fire;
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.set(uuid, accessory);
          this.log.info(`Added Flame Connect fireplace: ${fire.friendlyName}`);
        }
        const handler = this.attach(accessory, fire);
        const controls = [
          ['Fireplace', handler.powerService], ['Flames', handler.flameService],
          ['Heater', handler.heatService], ['Eco Mode', handler.ecoService],
          ['Fan Only', handler.fanOnlyService], ['Turbo Boost', handler.boostService],
          ['Flame Speed', handler.speedService], ['Media Bed', handler.mediaService],
          ['Media Accent', handler.overheadService], ['Logs', handler.logService],
        ].filter(([, service]) => Boolean(service)).map(([name]) => name);
        this.log.info(`Exposed HomeKit controls: ${controls.join(', ')}.`);
        this.log.info(`Capabilities: heat=${Boolean(fire.withHeat)}, advanced heat=${Boolean(fire.features?.advancedHeat)}, eco=${Boolean(fire.features?.advancedHeat)}, fan only=${Boolean(fire.features?.fanOnly)}, turbo boost=${Boolean(fire.features?.powerBoost)}, RGB logs=${Boolean(fire.features?.rgbLogEffect)}.`);
        try {
          await handler.refresh();
          this.log.info(`Ready: ${fire.friendlyName}`);
        } catch (error) {
          this.log.warn(`Could not refresh ${fire.friendlyName}: ${error.message}`);
        }
      }

      for (const [uuid, accessory] of this.accessories) {
        if (!discovered.has(uuid)) {
          this.log.info(`Removing stale Flame Connect accessory: ${accessory.displayName}`);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.delete(uuid);
          this.handlers.delete(uuid);
        }
      }

      if (!fires.length) {
        this.log.warn('Flame Connect account returned no fireplaces.');
      }
      this.discoveryAttempts = 0;
      this.clearDiscoveryRetry();
      this.startPolling();
    } catch (error) {
      this.log.error(`Flame Connect startup failed: ${error.message}`);
      // Permanent authentication states need the user, not another attempt:
      // retrying them on the backoff schedule burns requests and spams the
      // log every five minutes until someone restarts Homebridge.
      if (error?.code === 'FLAMECONNECT_REAUTH_REQUIRED') {
        this.log.error('The saved Flame Connect sign-in is no longer valid. Run flameconnect-auth again; your fireplace configuration is unaffected.');
        return;
      }
      if (error?.code === 'FLAMECONNECT_NO_TOKEN') {
        this.log.error('Run flameconnect-auth once, then add the returned refresh token to this plugin configuration.');
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
    const attempt = this.discoveryAttempts;
    this.discoveryAttempts += 1;
    const delayMs = this.discoveryRetryDelay(attempt);
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
    const minutes = Math.max(5, Number(this.config.pollIntervalMinutes || 1440));
    this.pollTimer = setInterval(() => {
      void this.refreshAll();
    }, minutes * 60_000);
    this.pollTimer.unref?.();
  }

  async refreshAll() {
    const results = await Promise.allSettled([...this.handlers.values()].map((handler) => handler.refresh()));
    for (const result of results) {
      if (result.status === 'rejected') {
        this.log.warn(`Flame Connect background refresh failed: ${result.reason?.message || result.reason}`);
      }
    }
  }
}
