<p align="center">
  <img alt="NGBS iCON Thermostat Homebridge Plugin" src="https://raw.githubusercontent.com/peterrakolcza/homebridge-ngbs-icon-thermostat/latest/assets/config.png" width="500px">
</p>
<span align="center">

# NGBS iCON Thermostat Homebridge Plugin

[![npm Release](https://flat.badgen.net/npm/v/homebridge-ngbs-icon-thermostat?icon=npm)](https://www.npmjs.com/package/homebridge-ngbs-icon-thermostat)

[![Apple HomeKit](https://flat.badgen.net/badge/apple/homekit/f89f1a?icon=apple)](https://www.apple.com/ios/home/) 

</span>

## Supported Features

<div align="left">
  <img align="right" width="319" height="692" alt="Screen capture of Konnected accessories in HomeKit via the Konnected Homebridge plugin." src="https://user-images.githubusercontent.com/1437667/128083751-1eb31022-0c44-4954-9b0f-09c5c749d0f4.gif">
  <b>Native HomeKit Security System Control</b>
  <ul>
    <li>Arm/Disarm Security System</li>
    <li>Optional Home/Stay and Night Modes</li>
    <li>Configurable Sensor Security System Triggering</li>
    <li>Configurable Entry Delay Times</li>
    <li>Traditional Alarm System Integration</li>
    <li>Panic Button via Alarm Siren Switch</li>
    <li>Inverting Sensors</li>
    <li>Switch Trigger States (high vs low)</li>
  </ul>
  <b>Sensor States</b>
  <ul>
    <li>Contact</li>
    <li>Motion</li>
    <li>Glass Break</li>
    <li>Temperature</li>
    <li>Humidity</li>
    <li>Smoke</li>
    <li>Water Leak</li>
  </ul>
  <b>Switches/Actuators</b>
  <ul>
    <li>Beeper</li>
    <li>Siren</li>
    <li>Strobe Light</li>
    <li>Generic Switch</li>
  </ul>
</div>

## Upcoming Features

  * Bypass Switch for Sensor Zones
  * Virtual Zones for HomeKit Automation
  * Professional 24/7 smart home monitoring (powered by [Noonlight](https://noonlight.com/))

## Introduction
This homebridge plugin exposes CT200 status allowing for heater control

**Note:** The thermostat accessory in Home app shows a single button to change the control mode. On is the same as 'Auto' mode in the bosch EasyControl App. Off is the same as 'manual'.

Changing the temperature when set on 'Auto', only changes the setpoint until the next defined setpoint is reached.

## Compatibility
While I haven't tested this for myself, the plugin apparently also works with the Buderus TC100 v2 as well as bosch radiator valves, and probably other smart thermostats that make use of boschs' EasyControl API.

## Installation
To install homebridge ct200:
- Install the plugin through Homebridge Config UI X or manually by:
```
$ sudo npm -g i homebridge-ct200
```
- Configure within Homebridge Config UI X or edit `config.json` manually e.g:
```
"platforms": [
    {
        "access": "ACCESS_KEY",
        "serial": "SERIAL_KEY",
        "password": "PASSWORD",
        "zones": [
            {
                "index": 1,
                "name": "NAME1"
            },
            {
                "index": 2,
                "name": "NAME2"
            }
        ],
        "platform": "CT200"
    }
]
```
### Configuration settings
- `access` is the access key (found in bosch EasyControl app)
- `serial` is the serial key (found in bosch EasyControl app)
- `password` is the password used to login.
For each device you want to control, add a zone, where:
- `index` is the zone id (from 1 to X)
- `name` is what will show up in the Home app.

### Troubleshooting
List of problems you might encounter and how to fix them
- **"SyntaxError ... Double-check login details!"** If you encounter this error, then most likely you are using the wrong password. You need to set and use the password that is in 'Settings' -> 'Personal' -> 'Change Password', not the BOSCH ID password. More details [here](https://github.com/lynxcs/homebridge-ct200/issues/22).

### Getting help
If you need help troubleshooting, create an issue and I'll try to help you fix it.

Also it's always good to restart the HomeKit app after changes made to the Homebridge configuration as HomeKit does some background cleanup to the states and presence of devices in its accessory database.
