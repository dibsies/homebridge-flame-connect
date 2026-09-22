# Changelog

## 0.1.9

- Replace ad-hoc cloud error flags with a consistent typed Flame Connect cloud error that safely wraps native Node errors.
- Recognize Node's native `TimeoutError` and return HomeKit's operation-timed-out status instead of producing an unhandled characteristic warning.
- Convert nonzero overview result codes and malformed status responses into HomeKit communication failures.
- Retry a transient fireplace overview result once; writes remain non-retried to avoid duplicating a command whose outcome is uncertain.
- Add a short post-failure cooldown that drains an already queued rapid-control burst without hammering an unavailable cloud service.
- Add privacy-safe queue diagnostics and remove complete device identifiers from routine cloud error messages.
- Add regression coverage for the reported timeout → result-code-1 sequence, safe recovery, queue cooldown, and identifier redaction; 58 tests pass.

## 0.1.8

- Deduplicate concurrent token-file loading and OAuth refreshes, preventing rotated refresh-token races and intermittent startup authentication failures.
- Add bounded 15-second API and 20-second authentication request timeouts so stalled cloud connections cannot block a fireplace command queue indefinitely.
- Retry failed startup discovery with bounded exponential backoff while correctly stopping for missing or revoked authentication that requires user action.
- Surface cloud, authentication, malformed-response, and timeout failures as HomeKit communication errors while preserving local validation errors.
- Add repository hygiene and pnpm-based CI across Node.js 22 and 24.
- Expand regression coverage to 55 tests, including concurrency, timeouts, discovery recovery, permanent authentication states, and HomeKit error mapping.
- Validate the release candidate on a live fireplace across power, lighting, color, flame speed, thermostat, Eco, Fan Only, and Turbo Boost controls.

## 0.1.7

- Add capability-gated Eco Mode, Fan Only, and timed Turbo Boost controls while leaving the thermostat behavior unchanged.
- Correct the Heat Settings write packet to the authoritative five-byte payload; the rejected test candidate briefly used an invalid extra byte.
- Represent Fan Only as a native HomeKit fan service and link advanced heater controls to the thermostat.
- Restore Normal/Eco state safely after temporary heater modes; exiting Fan Only never unexpectedly starts heat.
- Label the Flame Speed slider using its configured HomeKit service name.
- Add a guided Flame Connect sign-in card directly to Homebridge settings for macOS, Windows, and Linux, while retaining the browser-aware terminal helper and secure token-file workflow.
- Make one-time email/password sign-in the recommended cross-platform path, forwarding credentials only to the known Flame Connect Microsoft B2C tenant and never persisting or logging them; retain browser sign-in as a fallback.
- Retry transient OAuth failures, preserve rotated refresh tokens, identify revoked sign-ins clearly, and avoid logging secrets.
- Add privacy-safe capability diagnostics and expanded protocol/control/authentication regression coverage.

## 0.1.6

- Replace the heater switch with a HomeKit thermostat supporting off/heat and half-degree target-temperature changes.
- Add full RGBW color and brightness control for supported Logs effects.
- Add an optional five-step Flame Speed control using a native HomeKit speed slider.
- Preserve serialized read/modify/write commands across the new controls.
- Document that Flame Connect does not report measured room temperature; HomeKit's required current-temperature value mirrors the target.

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

- Fixed cached overview metadata replacing the user-facing fireplace name with a device hardware identifier.
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
