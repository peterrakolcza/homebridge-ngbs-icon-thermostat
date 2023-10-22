import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { NGBSiCONThermostat, globalLogger, iCONid } from './platform';
import { getData, setAttr, setEcoMode } from './client';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class NGBSiCONThermostatAccessory {
  private service: Service;
  private id: number;

  constructor(
    private readonly platform: NGBSiCONThermostat,
    private readonly accessory: PlatformAccessory,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'NGBS')
      .setCharacteristic(this.platform.Characteristic.Model, 'iCON')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.UniqueId);

    this.service = this.accessory.getService(this.platform.Service.Thermostat)
      || this.accessory.addService(this.platform.Service.Thermostat);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.DisplayName);
    this.id = this.accessory.context.device.UniqueId;

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature) // Global
      .onGet(this.getCurrentTemp.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature) // Per device
      .onGet(this.getTargetTemp.bind(this))
      .onSet(this.setTargetTemp.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onSet(this.setTargetState.bind(this))
      .setProps({
        minValue: 0,
        maxValue: 3,
        validValues: [0, 3],
      });

    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.getDisplayUnits.bind(this))
      .onSet(this.setDisplayUnits.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getRelativeHumidity.bind(this));

  }

  async getDevice() {
    const response = await getData();
    const home = response.ICONS[iCONid];
    const devices = home.DP;
    return devices.find(item => item.ID === this.id);
  }

  async getCurrentTemp(): Promise<CharacteristicValue> {
    const device = await this.getDevice();
    return device.TEMP;
  }

  async getTargetTemp(): Promise<CharacteristicValue> {
    const device = await this.getDevice();
    return device.REQ;
  }

  async setTargetTemp(value: CharacteristicValue) {
    // Only allow changing in steps of 0.5
    const nearestHalfDecimal = Math.round(value as number / 0.5) * 0.5;
    await setEcoMode(this.id.toString(), '0');
    await setAttr(this.id.toString(), 'REQ', nearestHalfDecimal.toString());
  }

  async getCurrentState(): Promise<CharacteristicValue> {
    const device = await this.getDevice();

    if (device.PUMP === 0) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    } else if (device.PUMP === 1 && device.TEMP < device.REQ) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
    } else if (device.PUMP === 1 && device.TEMP > device.REQ) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
    }

    return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
  }

  async getTargetState(): Promise<CharacteristicValue> {
    const device = await this.getDevice();
    globalLogger.debug(device.CE);
    if (device.CE === 1) {
      globalLogger.debug('OFF');
      return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    } else {
      return this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
    }
  }

  async setTargetState(value: CharacteristicValue) {
    if (value === this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
      await setEcoMode(this.id.toString(), '1');
    } else if (value === this.platform.Characteristic.TargetHeatingCoolingState.AUTO) {
      await setEcoMode(this.id.toString(), '0');

    }
  }

  // Also a global property
  async getDisplayUnits(): Promise<CharacteristicValue> {
    return this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
  }

  async setDisplayUnits(value: CharacteristicValue) {
    this.platform.log.warn('Setting temperature units to ' + value + ' failed! It is not possible to change this setting at the moment.');
  }

  // This is a global property
  async getRelativeHumidity(): Promise<CharacteristicValue> {
    const device = await this.getDevice();
    return device.RH;
  }

}
