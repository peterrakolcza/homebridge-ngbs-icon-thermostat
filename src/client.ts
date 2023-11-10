import axios from 'axios';
import cheerio from 'cheerio';
import FormData from 'form-data';
import { globalLogger, sessionID, iCONid } from './platform';

const baseURL = 'https://enzoldhazam.hu';

export async function login(username: string, password: string) {
  try {
    const response = await axios.get(baseURL);
    const $ = cheerio.load(response.data);
    const token = $('input[name="token"]').val();

    const cookies = response.headers['set-cookie'] || [];
    const phpsessid = cookies.find(cookie => cookie.includes('PHPSESSID'));

    if (phpsessid) {
      const sessionID = phpsessid.split(';')[0];
      const data = new URLSearchParams();
      data.append('username', username);
      data.append('password', password);
      data.append('token', token as string);
      data.append('x-email', '');

      const response2 = await axios.post(baseURL, data, {
        headers: {
          'Cookie': sessionID,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      if (response2.data.includes('Bejelentkezés')) {
        globalLogger.debug('Failed to login and/or connect to the client: ' + response2.data);
      }

      return sessionID;
    }
  } catch (error) {
    if (error instanceof Error) {
      globalLogger.error(error.toString());
    }
  }
}

export async function getData() {
  try {
    const response = await axios.get(baseURL + '/Ax?action=iconList', {
      headers: {
        'Cookie': sessionID as string,
      },
    });

    globalLogger.debug(response.data);
    return response.data;
  } catch (error) {
    if (error instanceof Error) {
      globalLogger.error(error.toString());
    }
  }
}

export async function setAttr(deviceID: string, attr: string, value: string) {
  try {
    const form = new FormData();

    form.append('action', 'setThermostat');
    form.append('icon', iCONid);
    form.append('thermostat', deviceID);
    form.append('attr', attr);
    form.append('value', value);

    await axios.post(baseURL + '/Ax', form, {
      headers: {
        'Content-Type': 'multipart/form-data; boundary=${form._boundary}',
        Cookie: sessionID,
      },
    });
  } catch (error) {
    if (error instanceof Error) {
      globalLogger.error(error.toString());
    }
  }
}

export async function getDevices() {
  const response = await getData();

  try {

    const home = response.ICONS[iCONid];

    if (home !== undefined) {
      return home.DP;
    } else {
      return undefined;
    }
  } catch (error) {
    if (response.includes('Bejelentkezés')) {
      return {};
    }
  }

}