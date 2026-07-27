import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { NGBSiCONThermostatAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

// This is only required when using Custom Services and Characteristics not support by HomeKit
import { EveHomeKitTypes } from 'homebridge-lib/EveHomeKitTypes';

import { login, getDevices, errorMessage, switchoverMode, switchoverMaster } from './client.js';

export let globalLogger: Logging;
export let sessionID: string;
export let iCONid: string;

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class NGBSiCONThermostat implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  // the handlers of the registered thermostats, so that every poll can hand
  // them their new state
  private readonly thermostats: NGBSiCONThermostatAccessory[] = [];

  // whether the last poll failed, so that an outage is only reported once
  private disconnected = false;

  // the login in flight, if any, so that concurrent renewals collapse into one
  private renewing: Promise<void> | undefined;

  // This is only required when using Custom Services and Characteristics not support by HomeKit
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly CustomServices: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly CustomCharacteristics: any;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    globalLogger = this.log;
    iCONid = this.config.iCONid;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    // This is only required when using Custom Services and Characteristics not support by HomeKit
    this.CustomServices = new EveHomeKitTypes(this.api).Services;
    this.CustomCharacteristics = new EveHomeKitTypes(this.api).Characteristics;

    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.start();

      // Backstop for a session that goes stale without the server saying so.
      // An expired one is normally noticed by the poll and renewed there, so
      // this rarely has anything to do.
      setInterval(() => this.renewSession(), 3600000);

      // Pull latest data every 10s. One request covers the whole home, however
      // many thermostats are in it.
      setInterval(() => this.refresh(), 10000);
    });
  }

  /**
   * Logs in again, at most once at a time.
   */
  private renewSession(): Promise<void> {
    this.renewing ??= (async () => {
      const session = await login(this.config.username, this.config.password);

      // Hold on to the previous session if the renewal failed: it is probably
      // still valid, and dropping it would turn a hiccup into an outage.
      if (session !== undefined) {
        sessionID = session;
      }

      this.renewing = undefined;
    })();

    return this.renewing;
  }

  /**
   * Logs in and registers the thermostats, retrying until the cloud answers.
   * A timing out request used to take the whole child bridge down with it.
   */
  async start() {
    const session = await login(this.config.username, this.config.password);

    if (session === undefined) {
      this.log.error('Could not log in to the NGBS iCON cloud, retrying in 30 seconds.');
      setTimeout(() => this.start(), 30000);
      return;
    }

    sessionID = session;

    try {
      await this.discoverDevices();
    } catch (error) {
      this.log.error('Could not retrieve the thermostats: ' + errorMessage(error) + '. Retrying in 30 seconds.');
      setTimeout(() => this.start(), 30000);
      return;
    }

    // Say up front what the controller reports about the switchover, so that a
    // refused mode change later on is not a surprise.
    if (this.config.manualHeatingCoolingSwitch === true) {
      this.log.info('Manual heating/cooling switching is enabled. This system switches over in "' +
        (switchoverMode ?? 'unknown') + '" mode' + (switchoverMaster === undefined ? '' : ', following "' + switchoverMaster + '"') +
        '. Thermostats that turn out not to be allowed to switch will fall back to Auto.');
    }
  }

  /**
   * Refreshes the buffered state and hands it to the thermostats.
   */
  async refresh() {
    try {
      const thermostats = await getDevices();

      // The cloud handed back the login page: the session is gone, so get a new
      // one now rather than waiting for the hourly renewal.
      if (thermostats !== undefined && thermostats.length === 0) {
        this.log.debug('The session has expired, logging in again.');
        await this.renewSession();
        return;
      }
    } catch (error) {
      // The poll runs every ten seconds, so only complain once per outage.
      if (!this.disconnected) {
        this.log.error('Lost contact with the NGBS iCON cloud: ' + errorMessage(error));
        this.disconnected = true;
      }
      return;
    }

    if (this.disconnected) {
      this.log.info('Reconnected to the NGBS iCON cloud.');
      this.disconnected = false;
    }

    for (const thermostat of this.thermostats) {
      thermostat.update();
    }
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async discoverDevices() {
    const fetchedData = await getDevices();
    let Devices;
    if (fetchedData !== undefined && Object.keys(fetchedData).length > 0) {
      Devices = fetchedData.map(device => {
        return {
          UniqueId: device.ID,
          DisplayName: device.title,
        };
      });
    } else if (fetchedData !== undefined && Object.keys(fetchedData).length === 0) {
      for (const [uuid, accessory] of this.accessories) {
        if (!this.discoveredCacheUUIDs.includes(uuid)) {
          this.log.info('Removing existing accessory from cache:', accessory.displayName);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      }
      this.log.error('Invalid email and/or password.');
      return;
    } else {
      this.log.error('Invalid or nonexistent HomeID.');
      return;
    }

    // loop over the discovered devices and register each one if it has not already been registered
    for (const device of Devices) {
      // generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address
      const uuid = this.api.hap.uuid.generate(device.UniqueId);

      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        // the accessory already exists
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. e.g.:
        // existingAccessory.context.device = device;
        // this.api.updatePlatformAccessories([existingAccessory]);

        // create the accessory handler for the restored accessory
        // this is imported from `platformAccessory.ts`
        this.thermostats.push(new NGBSiCONThermostatAccessory(this, existingAccessory));

        // it is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`, e.g.:
        // remove platform accessories when no longer present
        // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
        // this.log.info('Removing existing accessory from cache:', existingAccessory.displayName);
      } else {
        // the accessory does not yet exist, so we need to create it
        this.log.info('Adding new accessory:', device.DisplayName);

        // create a new accessory
        const accessory = new this.api.platformAccessory(device.DisplayName, uuid);

        // store a copy of the device object in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        accessory.context.device = device;

        // create the accessory handler for the newly create accessory
        // this is imported from `platformAccessory.ts`
        this.thermostats.push(new NGBSiCONThermostatAccessory(this, accessory));

        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      // push into discoveredCacheUUIDs
      this.discoveredCacheUUIDs.push(uuid);
    }

    // you can also deal with accessories from the cache which are no longer present by removing them from Homebridge
    // for example, if your plugin logs into a cloud account to retrieve a device list, and a user has previously removed a device
    // from this cloud account, then this device will no longer be present in the device list but will still be in the Homebridge cache
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}
