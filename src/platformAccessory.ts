import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { NGBSiCONThermostat } from './platform';
import { setAttr, getDevices } from './client';

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
      .onGet(this.getTargetState.bind(this))
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

  async findDevice() {
    const devices = await getDevices();

    if (devices !== null) {
      return devices.find(item => item.ID === this.id);
    }

    throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  async getCurrentTemp(): Promise<CharacteristicValue> {
    const device = await this.findDevice();

    return device.TEMP;
  }

  async getTargetTemp(): Promise<CharacteristicValue> {
    const device = await this.findDevice();

    return device.REQ;
  }

  async setTargetTemp(value: CharacteristicValue) {
    // Only allow changing in steps of 0.5
    const nearestHalfDecimal = Math.round(value as number / 0.5) * 0.5;
    await setAttr(this.id.toString(), 'CE', '0'); // set ECO mode
    await setAttr(this.id.toString(), 'REQ', nearestHalfDecimal.toString());
  }

  async getCurrentState(): Promise<CharacteristicValue> {
    const device = await this.findDevice();

    if (device.OUT === 0) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    } else if (device.OUT === 1 && device.TEMP < device.REQ) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
    } else if (device.OUT === 1 && device.TEMP > device.REQ) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
    }

    return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
  }

  async getTargetState(): Promise<CharacteristicValue> {
    const device = await this.findDevice();

    if (device.CE === 1) {
      return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    } else {
      return this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
    }
  }

  async setTargetState(value: CharacteristicValue) {
    if (value === this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
      await setAttr(this.id.toString(), 'CE', '1'); // set ECO mode
    } else if (value === this.platform.Characteristic.TargetHeatingCoolingState.AUTO) {
      await setAttr(this.id.toString(), 'CE', '0'); // set ECO mode

    }
  }

  // Also a global property
  async getDisplayUnits(): Promise<CharacteristicValue> {
    return this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
  }

  async setDisplayUnits(value: CharacteristicValue) {

    this.platform.log.info('Failed to set temperature units to ' + value + ' for thermostat: ' + this.accessory.context.device.DisplayName);
  }

  // This is a global property
  async getRelativeHumidity(): Promise<CharacteristicValue> {
    const device = await this.findDevice();
    return device.RH;
  }

}
