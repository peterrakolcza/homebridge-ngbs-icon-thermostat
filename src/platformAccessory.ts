import { Service, PlatformAccessory, CharacteristicValue, Characteristic, WithUUID } from 'homebridge';

import { NGBSiCONThermostat } from './platform.js';
import { setAttr, getDevice, isCooling, errorMessage, switchoverMode, switchoverMaster } from './client.js';

// How many polls a manual heating/cooling switchover gets to take effect before
// we conclude that this system does not allow it. The controller needs a few
// seconds to apply the change and actuate the valves.
const switchoverPolls = 4;

type CharacteristicClass = WithUUID<new () => Characteristic>;

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class NGBSiCONThermostatAccessory {
  private service: Service;
  private id: string;

  // The modes currently offered to HomeKit, remembered so that they are only
  // republished when they actually change.
  private states: number[] = [];

  // A manual switchover waiting to be confirmed by the controller, and how many
  // polls it has been waiting for.
  private pending: { cooling: boolean; polls: number } | undefined;

  // Set once this thermostat has proven that it cannot switch season by itself,
  // which is the normal state of affairs in a centrally controlled building.
  private switchoverRejected = false;

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
      .onSet(this.setTargetTemp.bind(this))
      .setProps({
        minStep: 0.5, // The thermostat only accepts half degrees.
      });

    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.getTargetState.bind(this))
      .onSet(this.setTargetState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.getDisplayUnits.bind(this))
      .onSet(this.setDisplayUnits.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getRelativeHumidity.bind(this));

    this.update();
  }

  /** The state the last poll saw, if it saw this thermostat. */
  private get device() {
    return getDevice(this.id);
  }

  /** The same, but reports the thermostat as unavailable when it is missing. */
  private requireDevice() {
    const device = this.device;

    if (device === undefined) {
      // Nothing buffered for this thermostat, either because the first poll has
      // not finished yet or because it is gone. Say so, instead of tripping over
      // an undefined property and handing HomeKit an opaque failure.
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }

    return device;
  }

  /**
   * The mode HomeKit is asked to show while the thermostat is on. Auto means
   * "whatever season the system is running", which is all a thermostat in a
   * centrally switched building can offer. It is kept in the accessory context
   * so that a manual choice survives a restart.
   */
  private get mode(): number {
    return this.accessory.context.mode ?? this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
  }

  private set mode(mode: number) {
    if (this.accessory.context.mode !== mode) {
      this.accessory.context.mode = mode;
      this.platform.api.updatePlatformAccessories([this.accessory]);
    }
  }

  /**
   * Called by the platform after every successful poll: settles a manual
   * switchover against what the controller actually did, then publishes.
   */
  update() {
    this.checkSwitchover();
    this.publish();
  }

  /**
   * A manual switchover is only a request. The controller silently ignores it
   * when the season is switched centrally, so watch the polls that follow and
   * fall back to Auto - and stop offering the modes - once it is clear that
   * this thermostat is not allowed to decide for itself.
   */
  private checkSwitchover() {
    const device = this.device;

    if (this.pending === undefined || device === undefined) {
      return;
    }

    if (isCooling(device) === this.pending.cooling) {
      this.pending = undefined;
      return;
    }

    if (++this.pending.polls < switchoverPolls) {
      return;
    }

    this.pending = undefined;
    this.switchoverRejected = true;
    this.mode = this.platform.Characteristic.TargetHeatingCoolingState.AUTO;

    this.platform.log.warn(
      this.accessory.displayName + ' cannot switch between heating and cooling on its own' + this.switchoverHint() +
      '. Falling back to Auto, which follows whatever the system is running.');
  }

  /** Whatever the controller told us about who owns the switchover. */
  private switchoverHint(): string {
    const details = [
      switchoverMode === undefined ? undefined : 'mode: ' + switchoverMode,
      switchoverMaster === undefined ? undefined : 'master: ' + switchoverMaster,
    ].filter(detail => detail !== undefined);

    return details.length > 0 ? ' (' + details.join(', ') + ')' : '';
  }

  /** Whether this thermostat may ask the controller to switch season. */
  private switchoverAllowed(): boolean {
    return this.platform.config.manualHeatingCoolingSwitch === true && !this.switchoverRejected;
  }

  /** The modes to offer HomeKit. */
  private validStates(): number[] {
    const { OFF, HEAT, COOL, AUTO } = this.platform.Characteristic.TargetHeatingCoolingState;

    return this.switchoverAllowed() ? [OFF, HEAT, COOL, AUTO] : [OFF, AUTO];
  }

  /**
   * Hands a value to HomeKit, but only when it is new.
   *
   * hap-nodejs notifies every subscriber on every update, unchanged values
   * included. Polling a dozen thermostats every ten seconds would otherwise
   * keep pushing the same half dozen values each to every device in the home.
   */
  private push(characteristic: CharacteristicClass, value: CharacteristicValue) {
    if (this.service.getCharacteristic(characteristic).value !== value) {
      this.service.updateCharacteristic(characteristic, value);
    }
  }

  /**
   * Publishes the state to HomeKit. Reporting it instead of waiting to be asked
   * for it is what keeps the Home app tiles up to date.
   */
  private publish() {
    const { CurrentHeatingCoolingState, TargetHeatingCoolingState } = this.platform.Characteristic;
    const states = this.validStates();

    if (states.join() !== this.states.join()) {
      this.states = states;
      this.service.getCharacteristic(TargetHeatingCoolingState).setProps({ validValues: states });
    }

    const device = this.device;

    if (device === undefined) {
      return;
    }

    this.push(CurrentHeatingCoolingState, device.OUT === 1
      ? (isCooling(device) ? CurrentHeatingCoolingState.COOL : CurrentHeatingCoolingState.HEAT)
      : CurrentHeatingCoolingState.OFF);
    this.push(TargetHeatingCoolingState, device.CE === 1 ? TargetHeatingCoolingState.OFF : this.mode);
    this.push(this.platform.Characteristic.CurrentTemperature, device.TEMP);
    this.push(this.platform.Characteristic.TargetTemperature, device.REQ);
    this.push(this.platform.Characteristic.CurrentRelativeHumidity, device.RH);
  }

  /**
   * Applies a change to the buffered state and hands it to HomeKit right away,
   * so that a read arriving before the next poll does not undo it.
   */
  private apply(changes: Record<string, number>) {
    const device = this.device;

    if (device !== undefined) {
      Object.assign(device, changes);
    }

    this.publish();
  }

  /**
   * Reports a queued change that the cloud ended up refusing. HomeKit is not
   * kept waiting for it: the cloud regularly needs several seconds to answer,
   * while HomeKit gives up on a write after about three and marks the accessory
   * as not responding. The next poll reconciles whatever the cloud actually did.
   */
  private send(what: string, request: Promise<unknown>) {
    request.catch(error => {
      this.platform.log.error('Failed to set the ' + what + ' of ' + this.accessory.displayName + ': ' + errorMessage(error));
    });
  }

  async getCurrentTemp(): Promise<CharacteristicValue> {
    return this.requireDevice().TEMP;
  }

  async getTargetTemp(): Promise<CharacteristicValue> {
    return this.requireDevice().REQ;
  }

  async setTargetTemp(value: CharacteristicValue) {
    // Only allow changing in steps of 0.5
    const nearestHalfDecimal = Math.round(value as number / 0.5) * 0.5;
    const device = this.device;
    const requests: Promise<void>[] = [];

    // Only send what actually differs: a scene that puts a room into the state
    // it is already in should not cost a request at all.
    if (device?.CE !== 0) {
      requests.push(setAttr(this.id, 'CE', '0')); // picking a temperature takes it out of ECO mode
    }

    if (device?.REQ !== nearestHalfDecimal) {
      requests.push(setAttr(this.id, 'REQ', nearestHalfDecimal.toString()));
    }

    this.apply({ CE: 0, REQ: nearestHalfDecimal });

    if (requests.length > 0) {
      this.send('temperature', Promise.all(requests));
    }
  }

  async getCurrentState(): Promise<CharacteristicValue> {
    const device = this.requireDevice();
    const CurrentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState;

    // OUT is the valve: the room is only heated or cooled while it is open.
    if (device.OUT !== 1) {
      return CurrentHeatingCoolingState.OFF;
    }

    return isCooling(device) ? CurrentHeatingCoolingState.COOL : CurrentHeatingCoolingState.HEAT;
  }

  async getTargetState(): Promise<CharacteristicValue> {
    const device = this.requireDevice();
    const TargetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState;

    // The thermostat has no off switch of its own, ECO mode stands in for it.
    return device.CE === 1 ? TargetHeatingCoolingState.OFF : this.mode;
  }

  async setTargetState(value: CharacteristicValue) {
    const { OFF, HEAT, COOL, AUTO } = this.platform.Characteristic.TargetHeatingCoolingState;
    const device = this.device;
    const eco = value === OFF ? 1 : 0;
    const changes: Record<string, number> = { CE: eco };

    // Heat and cool ask the controller to switch season, which it is free to
    // refuse. HomeKit is only asked not to send them, and a warning is all it
    // gets for sending them anyway, so the option is enforced here as well.
    const switching = (value === HEAT || value === COOL) && this.switchoverAllowed();

    if (value !== OFF) {
      this.mode = switching ? value as number : AUTO;
    }

    if (device?.CE !== eco) {
      this.send('mode', setAttr(this.id, 'CE', eco.toString())); // set ECO mode
    }

    if (switching && isCooling(device) !== (value === COOL)) {
      const cooling = value === COOL;

      changes.HC = cooling ? 1 : 0;

      // checkSwitchover() settles this against the polls that follow, so
      // nothing here has to guess whether the controller will go along with it.
      this.pending = { cooling, polls: 0 };
      this.send('heating/cooling mode', setAttr(this.id, 'HC', cooling ? '1' : '0'));
    }

    this.apply(changes);
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
    return this.requireDevice().RH;
  }

}
