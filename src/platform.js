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
    this.refreshAllPromise = null;
    this.authenticationBlocked = false;

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
      this.pollTimer = null;
      this.clearDiscoveryRetry();
      for (const handler of this.handlers.values()) handler.dispose();
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
      const refreshes = [];

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
        refreshes.push({ fire, handler });
      }

      const refreshResults = await mapWithConcurrency(
        refreshes,
        3,
        ({ handler }) => handler.refresh(),
      );
      refreshResults.forEach((result, index) => {
        const { fire } = refreshes[index];
        if (result.status === 'fulfilled') this.log.info(`Ready: ${fire.friendlyName}`);
        else this.log.warn(`Could not refresh ${fire.friendlyName}: ${result.reason?.message || result.reason}`);
      });

      for (const [uuid, accessory] of this.accessories) {
        if (!discovered.has(uuid)) {
          this.log.info(`Removing stale Flame Connect accessory: ${accessory.displayName}`);
          this.handlers.get(uuid)?.dispose();
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.delete(uuid);
          this.handlers.delete(uuid);
        }
      }

      if (!fires.length) {
        this.log.warn('Flame Connect account returned no fireplaces.');
      }
      this.discoveryAttempts = 0;
      this.authenticationBlocked = false;
      this.clearDiscoveryRetry();
      this.startPolling();
    } catch (error) {
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
    if (this.authenticationBlocked) return;
    const minutes = Math.min(1440, Math.max(5, Number(this.config.pollIntervalMinutes ?? 15)));
    this.pollTimer = setInterval(() => {
      void this.refreshAll();
    }, minutes * 60_000);
    this.pollTimer.unref?.();
  }

  async refreshAll() {
    if (this.authenticationBlocked) return;
    if (this.refreshAllPromise) return this.refreshAllPromise;
    this.refreshAllPromise = (async () => {
      const results = await mapWithConcurrency([...this.handlers.values()], 3, (handler) => handler.refresh());
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
