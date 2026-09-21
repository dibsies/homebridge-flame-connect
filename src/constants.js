export const API_BASE = 'https://mobileapi.gdhv-iot.com';
export const CLIENT_ID = '1af761dc-085a-411f-9cb9-53e5e2115bd2';
export const POLICY = 'B2C_1A_FirePhoneSignUpOrSignInWithPhoneOrEmail';
export const TENANT_HOST = 'gdhvb2cflameconnect.b2clogin.com';
export const TENANT = 'gdhvb2cflameconnect.onmicrosoft.com';
export const AUTHORITY = `https://${TENANT_HOST}/${TENANT}/${POLICY}`;
export const AUTHORIZE_ENDPOINT = `${AUTHORITY}/oauth2/v2.0/authorize`;
export const TOKEN_ENDPOINT = `${AUTHORITY}/oauth2/v2.0/token`;
export const REDIRECT_URI = `msal${CLIENT_ID}://auth`;
export const API_SCOPE = 'https://gdhvb2cflameconnect.onmicrosoft.com/Mobile/read';
export const AUTH_SCOPES = ['openid', 'profile', 'offline_access', API_SCOPE];

export const DEFAULT_HEADERS = Object.freeze({
  app_name: 'FlameConnect',
  api_version: '1.0',
  app_version: '2.22.0',
  app_device_os: 'android',
  device_version: '14',
  device_manufacturer: 'Homebridge',
  device_model: 'FlameConnectBridge',
  lang_code: 'en',
  country: 'US',
  logging_required_flag: 'True',
});

export const ParameterId = Object.freeze({
  TEMPERATURE_UNIT: 236,
  MODE: 321,
  FLAME_EFFECT: 322,
  HEAT_SETTINGS: 323,
  HEAT_MODE: 325,
  TIMER: 326,
  SOFTWARE_VERSION: 327,
  ERROR: 329,
  SOUND: 369,
  LOG_EFFECT: 370,
});

export const FireMode = Object.freeze({ STANDBY: 0, MANUAL: 1 });
export const OnOff = Object.freeze({ OFF: 0, ON: 1 });
export const Brightness = Object.freeze({ HIGH: 0, LOW: 1 });
