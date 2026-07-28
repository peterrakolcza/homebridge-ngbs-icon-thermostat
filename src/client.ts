import axios from 'axios';
import * as cheerio from 'cheerio';
import FormData from 'form-data';
import { globalLogger, sessionID, iCONid } from './platform.js';

const baseURL = 'https://enzoldhazam.hu';

// The cloud is slow and every now and then unreachable. Without an upper bound a
// single request can hang forever, taking the poll loop and every pending
// HomeKit read down with it.
const requestTimeout = 15000;

// How long queued attribute changes are held back before being sent. Long
// enough to collapse a dial being dragged or a scene touching every room into
// one request per attribute, short enough not to be noticed.
const writeDelay = 400;

/** A thermostat as the cloud reports it. Only the fields we read are listed. */
export interface Thermostat {
  ID: string;
  title: string;
  HC: number; // heating/cooling season: 0 is heating, 1 is cooling
  TEMP: number; // measured temperature
  REQ: number; // target temperature
  RH: number; // relative humidity
  OUT: number; // valve: 1 while the room is being heated or cooled
  CE: number; // ECO mode
  [field: string]: unknown;
}

// Indexed by ID: with a dozen thermostats and half a dozen characteristics each,
// walking the list on every read added up on every poll.
const thermostats = new Map<string, Thermostat>();

// Heating/cooling season as reported by the controller. Only used for the
// thermostats that do not report one of their own.
let controllerCooling: boolean | undefined;

// How the controller switches between heating and cooling. NGBS localises
// HC_SWITCH_MODE ("központi", "central", ...) and HC_MASTERICON is the name of
// the thermostat the whole system follows, so neither is worth matching on -
// they are only good enough to explain a rejected switchover in the log.
export let switchoverMode: string | undefined;
export let switchoverMaster: string | undefined;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The server answers requests made without a valid session with the login page
 * instead of an error, so this is the only way to notice that we are logged out.
 */
function isLoginPage(body: unknown): boolean {
  return typeof body === 'string' && body.includes('Bejelentkezés');
}

export async function login(username: string, password: string) {
  try {
    const response = await axios.get(baseURL, { timeout: requestTimeout });
    const $ = cheerio.load(response.data);
    const token = $('input[name="token"]').val();

    const cookies = response.headers['set-cookie'] || [];
    const phpsessid = cookies.find(cookie => cookie.includes('PHPSESSID'));

    if (!phpsessid) {
      globalLogger.error('The server did not hand out a session cookie.');
      return undefined;
    }

    const session = phpsessid.split(';')[0];
    const credentials = new URLSearchParams();
    credentials.append('username', username);
    credentials.append('password', password);
    credentials.append('token', token as string);
    credentials.append('x-email', '');

    const result = await axios.post(baseURL, credentials, {
      headers: {
        'Cookie': session,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: requestTimeout,
    });

    if (isLoginPage(result.data)) {
      globalLogger.debug('Failed to login and/or connect to the client: ' + result.data);
    }

    return session;
  } catch (error) {
    globalLogger.error('Failed to log in: ' + errorMessage(error));
    return undefined;
  }
}

/**
 * Refreshes the thermostats.
 *
 * Resolves to the thermostats of the configured iCON, to an empty array when the
 * session is no longer valid, or to undefined when the configured iCONid is
 * unknown. Failed requests are thrown, so that callers can tell a network
 * hiccup apart from a configuration problem.
 *
 * One request covers the whole home however many thermostats it has, so this is
 * the only thing worth polling.
 */
export async function getDevices(): Promise<Thermostat[] | undefined> {
  const response = await axios.get(baseURL + '/Ax?action=iconList', {
    headers: {
      'Cookie': sessionID as string,
    },
    timeout: requestTimeout,
  });

  if (isLoginPage(response.data)) {
    return [];
  }

  const home = response.data?.ICONS?.[iCONid];

  if (home === undefined) {
    return undefined;
  }

  const devices: Thermostat[] = home.DP ?? [];

  thermostats.clear();
  for (const device of devices) {
    thermostats.set(device.ID, device);
  }

  controllerCooling = home.HC === undefined ? undefined : home.HC === 1;
  switchoverMode = home.HC_SWITCH_MODE;
  switchoverMaster = home.HC_MASTERICON;

  // Everything the controller says about the season, not just the thermostats.
  // A home that reports no HC of its own leaves the season to be read off the
  // thermostats, and when they do not report one either the plugin has been
  // taking the home for a heating one - so these are the values to ask for when
  // heating and cooling come out the wrong way round.
  globalLogger.debug('season: %o', {
    HC: home.HC,
    HC_SWITCH: home.HC_SWITCH,
    HC_SW_VALUE: home.HC_SW_VALUE,
    HC_SWITCH_MODE: home.HC_SWITCH_MODE,
    HC_MASTERICON: home.HC_MASTERICON,
    HCMASTER: home.HCMASTER,
    WTEMP: home.WTEMP,
    thermostats: devices.map(device => ({ ID: device.ID, HC: device.HC, OUT: device.OUT, CE: device.CE })),
  });
  globalLogger.debug('%o', devices);

  return devices;
}

/** The state the last poll saw, or undefined if it did not see this thermostat. */
export function getDevice(id: string): Thermostat | undefined {
  return thermostats.get(id);
}

/**
 * NGBS reports the heating/cooling season in HC: 0 is heating, 1 is cooling.
 * Every thermostat carries its own copy, so prefer that and fall back to the
 * controller for the firmwares that leave it out.
 */
export function isCooling(device: Thermostat | undefined): boolean {
  return device?.HC === undefined ? controllerCooling === true : device.HC === 1;
}

interface QueuedWrite {
  value: string;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

// Queued attribute changes, by thermostat and then by attribute. Both maps keep
// insertion order, so writes go out in the order they were asked for.
const queue = new Map<string, Map<string, QueuedWrite>>();
let queueHandle: NodeJS.Timeout | undefined;
let draining = false;

async function sendAttr(deviceID: string, attr: string, value: string) {
  const form = new FormData();

  form.append('action', 'setThermostat');
  form.append('icon', iCONid);
  form.append('thermostat', deviceID);
  form.append('attr', attr);
  form.append('value', value);

  // form-data picks the multipart boundary, so let it write the Content-Type
  // as well - spelling the header out by hand only gets the boundary wrong.
  await axios.post(baseURL + '/Ax', form, {
    headers: {
      ...form.getHeaders(),
      Cookie: sessionID,
    },
    timeout: requestTimeout,
  });

  globalLogger.debug(deviceID + ' thermostat: Updated ' + attr + ' to ' + value);
}

async function drain() {
  // Set before the first await, so nothing can slip in between the timer firing
  // and the queue being taken over.
  draining = true;

  try {
    while (queue.size > 0) {
      const [deviceID, attrs] = queue.entries().next().value!;

      queue.delete(deviceID);

      for (const [attr, write] of attrs) {
        try {
          await sendAttr(deviceID, attr, write.value);
          write.resolve();
        } catch (error) {
          write.reject(error);
        }
      }
    }
  } finally {
    // Anything queued while a request was in flight has already been picked up
    // by the loop above: nothing else can run between its last check and here.
    draining = false;
  }
}

function scheduleDrain() {
  if (queueHandle === undefined && !draining) {
    queueHandle = setTimeout(() => {
      queueHandle = undefined;
      drain();
    }, writeDelay);
  }
}

/**
 * Queues an attribute change.
 *
 * Nothing is sent straight away: writes to the same attribute of the same
 * thermostat collapse into the last one, and whatever is left goes out one
 * request at a time. A scene covering every room in a house, or a temperature
 * dial being dragged, would otherwise put a burst of requests on a server that
 * is slow to answer even one.
 *
 * Resolves once the change has been sent, or as soon as a newer value for the
 * same attribute makes it pointless.
 */
export function setAttr(deviceID: string, attr: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let attrs = queue.get(deviceID);

    if (attrs === undefined) {
      attrs = new Map();
      queue.set(deviceID, attrs);
    }

    attrs.get(attr)?.resolve(); // superseded before it ever went out
    attrs.set(attr, { value, resolve, reject });

    scheduleDrain();
  });
}
