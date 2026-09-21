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
    });
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
    const fire = accessory.context?.fire;
    if (fire?.fireId) {
      this.attach(accessory, fire);
    }
  }

  attach(accessory, fire) {
    let handler = this.handlers.get(accessory.UUID);
    if (!handler) {
      handler = new FlameConnectAccessory(this, accessory, fire);
      this.handlers.set(accessory.UUID, handler);
    } else {
      handler.updateFire(fire);
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
      this.startPolling();
    } catch (error) {
      this.log.error(`Flame Connect startup failed: ${error.message}`);
      if (!this.config.refreshToken) {
        this.log.error('Run flameconnect-auth once, then add the returned refresh token to this plugin configuration.');
      }
    }
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
