# Changelog

## 0.1.5

- Refine default light names to Media Bed and Media Accent, matching the official app.
- Add HomeKit Hue, Saturation, and Brightness to both lights with RGBW conversion, shared User Defined media theme selection, and queued color updates.
- Preserve color selections when dimmed to zero and preserve customized names during default-name migration.
- Clarify the Homebridge UI dashboard author limitation for unpublished local packages.

- Add editable configuration names for every control; apply intentional config changes once and preserve subsequent Apple Home renames.
- Serialize each fireplace's commands to prevent concurrent read/modify/write operations from losing changes.
- Surface explicit command result-code failures and limit authorization retries.
- Add regression coverage for naming across refresh/restart, concurrent light writes, log writes, and failed-command recovery.
- User-confirmed Media Bed and Media Accent color/dimming operation on a live fireplace; 21 automated checks pass. Compatibility with other models and Logs behavior are not established by that test.

- Use concise function names by default: Fireplace, Flames, Heater, Media Bed, Media Accent, and Logs.
- Preserve service names customized in Apple Home during refreshes and upgrades.
- Migrate the plugin's prior generated names to the new function-only names without replacing custom labels.
- Identify the plugin author as @dibsies in Homebridge metadata.
- Keep Media Light, Overhead, and Logs connected to the Flame Connect flame/log effect controls.

## 0.1.4

- Fixed cached overview metadata replacing the user-facing fireplace name with a hardware identifier such as `0702222A0006`.
- Reapply all HomeKit service names from the authoritative account device list during discovery.

## 0.1.3

- Added a native macOS token helper that automatically receives Flame Connect's custom `msal…://auth` callback.
- The helper performs the OAuth exchange locally, restores the previous URL handler, and copies the refresh token only when requested.
- Kept the terminal-based `flameconnect-auth` helper as a cross-platform fallback.
- Added modern HomeKit configured names for each fireplace service so Apple Home labels the individual Fireplace, Flames, Heater, Media Light, Overhead Light, and Logs controls correctly.
- Added configuration switches to hide any unwanted Fireplace Power, Flames/Brightness, Heater, Media Light, Overhead Light, or Logs services; disabled cached services are removed on restart.

## 0.1.2

- Fixed interactive authentication to mirror the upstream Flame Connect MSAL OIDC flow.
- Added the hashed nonce and `client_info` values required by the Azure AD B2C custom policy.
- Added regression coverage for the complete authorization request.

## 0.1.1

- Remove the npm `private` flag and add repository, homepage, and issue metadata.
- Document the correct Homebridge Raspberry Pi image installation target under `/var/lib/homebridge`.
- Confirm compatibility with the current Homebridge 2.x ESM initializer and dynamic-platform loader.
- Add regression coverage for package discovery metadata, platform registration, config schema, OAuth PKCE handling, and the Flame Connect binary protocol.

## 0.1.0

- Initial experimental Homebridge platform for Flame Connect fireplaces.
