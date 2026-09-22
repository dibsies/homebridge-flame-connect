# Homebridge Flame Connect

Unofficial Homebridge plugin for Dimplex, Faber, and Real Flame electric fireplaces that use the Flame Connect app/cloud service.

This is an early community prototype. It was built from the publicly documented/reverse-engineered Flame Connect protocol work in `deviantintegral/flameconnect` and `deviantintegral/flame_connect_ha`. It does not require Home Assistant or Python at runtime.

## Current controls

Each Flame Connect fireplace is exposed as one HomeKit accessory with separate services:

- Fireplace: main power / standby
- Flames: flame effect on/off and High/Low brightness
- Heater: off/heat thermostat and target temperature, when supported
- Flame Speed: five steps represented as 20–100% in HomeKit
- Media Bed: on/off, color picker, and brightness
- Media Accent: on/off, color picker, and brightness
- Logs: log/ember effect on/off, RGBW color, and brightness, when supported
- Optional advanced switches: Pulsating Effect and Ambient Sensor

This means Siri commands can be named naturally, for example:

- “Turn off Living Room Flames.”
- “Turn on Living Room Fireplace.”
- “Turn off Living Room Heater.”

## Requirements

- Homebridge 2.x recommended
- Node.js 22 or 24
- A working Flame Connect account with the fireplace already paired in the official app

## One-time authentication

The plugin does not need to save your Flame Connect email/password. It uses Flame Connect's Azure AD B2C public-client OAuth flow.

### Recommended on macOS

Download `Flame-Connect-Token-Helper-macOS.zip` from the matching GitHub release, unzip it, and open **Flame Connect Token Helper**. It will:

1. Open the secure Flame Connect sign-in page in your default browser.
2. Receive the registered `msal…://auth` callback locally on your Mac.
3. Exchange the one-time authorization code directly with Flame Connect.
4. Restore the previous URL handler and offer a **Copy Refresh Token** button.

No credentials or tokens pass through an external proxy. Paste the copied value into Homebridge → Flame Connect → **Refresh Token**.

### Terminal fallback

After installing the package, run:

```bash
flameconnect-auth
```

The helper prints a Microsoft/Azure B2C sign-in URL. Open it in a browser and sign in. At the end, the browser redirects to a URL beginning with:

```text
msal1af761dc-085a-411f-9cb9-53e5e2115bd2://auth
```

The browser may say it cannot open that URL. Copy the complete URL from the address bar and paste it back into the helper. It will print a refresh token.

Treat the refresh token like a password.

## Homebridge configuration

Media Bed and Media Accent use the native Apple Home color picker and dimmer. Dimming scales RGBW intensity; it is separate from the Flames High/Low control. Selecting a color or brightness uses the shared User Defined media theme, so it can replace a theme selected in the Flame Connect app. The other light's color and on/off values are preserved. Color and dimming have been user-confirmed on a live fireplace; compatibility with other models still requires testing.

The Heater uses HomeKit's thermostat interface for off/heat and target-temperature control. Flame Connect stores the setpoint in Celsius and HomeKit handles display conversion. The cloud API does not provide measured room temperature, although HomeKit requires that field, so the displayed current temperature mirrors the target and must not be interpreted as a sensor reading.

HomeKit has no generic 1–5 control. Flame Speed therefore uses a native speed slider: 20%, 40%, 60%, 80%, and 100% map to speeds 1, 2, 3, 4, and 5. Its active control mirrors the Flames on/off state.

Supported Logs effects use the same native color picker and dimmer behavior as the other RGBW lights. Changing Logs color preserves its on/off state.

Existing explicit names in configuration remain in effect, including Media Light or Overhead. Clear those fields to use the new defaults. Custom names already assigned in Apple Home remain preserved.

The package credits @dibsies. Homebridge UI's dashboard author label is sourced from its plugin catalog or npm maintainer data rather than the local package author field; a locally installed, unpublished package can therefore still show an empty author label.

Each control has an editable name in plugin settings, including the optional advanced controls. Blank names use the defaults listed above. Names apply to all fireplaces on this platform. Save and restart Homebridge to apply a changed setting. Afterward, names changed in Apple Home are preserved across cloud refreshes and restarts; deliberately changing a plugin name setting applies that new name once.

Commands for each fireplace run in order so simultaneous Home commands do not write over one another. Cloud result-code rejections are reported as errors. Successful cloud requests do not by themselves prove a physical lighting change; Logs still needs device validation.

In Homebridge UI, add the Flame Connect platform and paste the refresh token into **Flame Connect Refresh Token**.

Equivalent JSON:

```json
{
  "platform": "FlameConnect",
  "name": "Flame Connect",
  "refreshToken": "PASTE_REFRESH_TOKEN_HERE",
  "pollIntervalMinutes": 1440,
  "cacheSeconds": 30,
  "advancedControls": false
}
```

After the first successful token refresh, rotated OAuth tokens are persisted to Homebridge storage in `flame-connect-tokens.json` with restrictive file permissions.

## Cloud polling behavior

Flame Connect is a cloud API. The upstream reverse-engineering project intentionally avoids aggressive polling. This plugin defaults to one background refresh every 24 hours. When HomeKit requests state, stale data is refreshed on demand with a short cache to coalesce multiple characteristic reads.

Writes refresh the fireplace state immediately before changing a multi-field parameter, because Flame Connect encodes several visual settings together in one binary parameter and changing one field must preserve the others.

## Installation from a local package on Homebridge Raspberry Pi image

Until this prototype is published to npm, download the generated `.tgz` on the Homebridge machine and install it into the same `/var/lib/homebridge` package tree used by the Homebridge service:

```bash
cd /tmp
wget https://github.com/dibsies/homebridge-flame-connect/releases/download/v0.1.5/homebridge-flame-connect-0.1.5.tgz
/opt/homebridge/bin/npm install --prefix /var/lib/homebridge /tmp/homebridge-flame-connect-0.1.5.tgz
```

Do not use `npm install -g` for this Homebridge image: that puts the plugin under `/opt/homebridge/lib/node_modules`, while the service and its locally installed plugins live under `/var/lib/homebridge/node_modules`. Restart Homebridge after installation.

## Plugin discovery metadata

The package name starts with `homebridge-`, its keywords include `homebridge-plugin` and `supports-hap`, and its ESM entry point has a default initializer export. Those are the fields and loader shape used by current Homebridge. The official Homebridge 2.x template does not use a `homebridge.apiVersion` package field.

## Limitations

- Main power/flame operation and Media Bed/Media Accent color and dimming have been user-confirmed on one fireplace. The thermostat, Flame Speed, full-color Logs control, and other models still need physical verification.
- Media Bed, Media Accent, and Logs are implemented writes (Flame Effect parameter 322 and Log Effect parameter 370). Unsupported features or rejected commands may prevent a physical effect.
- Flame color presets, timer, sound, heater presets, and media-theme selection are not exposed as HomeKit controls.
- Flame Connect is an unofficial, unversioned cloud API and Dimplex/Glen Dimplex can change it at any time.
- Because the API is cloud-based, commands require Internet access and may be slower than local HomeKit accessories.

## Attribution

Protocol behavior, endpoint names, Azure B2C application identifiers, parameter IDs, and binary layouts were independently implemented here based on the Apache-2.0 licensed projects:

- https://github.com/deviantintegral/flameconnect
- https://github.com/deviantintegral/flame_connect_ha

This project is not affiliated with or endorsed by Dimplex, Glen Dimplex, Faber, or Real Flame.
