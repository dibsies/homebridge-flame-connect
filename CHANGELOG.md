# Changelog

## 0.1.4

- Fixed cached overview metadata replacing the user-facing fireplace name with a hardware identifier such as `0702222A0000`.
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
