# Changelog

## 1.0.0

- Promote the owner-confirmed RC5 command-response correction without changing runtime control logic.
- Start fresh repository history under the public `dibsies` identity. Retain upstream license and attribution notices.
- Document the unresolved brief white flash during color selection. Final colors apply; no additional color-control changes are included.
- Retain guided cross-platform sign-in and the terminal fallback. The native macOS helper remains retired.

## 1.0.0-rc.5

- Correct an RC3/RC4 regression that rejected successful command HTTP responses without a ResultCode. A command could reach the fireplace while HomeKit reported failure and reverted its switch. Missing ResultCode now retains the original HTTP-success behavior; explicit nonzero or malformed codes, invalid JSON, and HTTP errors still reject.
- Exercise native HAP controls through the real HTTP request/response handler, including all power, flame, heater, effect, color, and dimming controls. Previously the control matrix mocked the write method and missed this compatibility failure.
- Retain RC4's bounded delayed-cloud reconciliation and uncertain-write recovery safeguards. HTTP success is not a guarantee of physical execution; hardware testing remains required.

## 1.0.0-rc.4

- Fix a post-write reconciliation regression: a lagging cloud overview could replace acknowledged Flames On with Off in Home, and carry that old flag into a later brightness command.
- Protect only the fields changed by successful commands for ten seconds while the cloud catches up. Matching echoes cannot release the guard early and let an older echo reverse a later command. Unrelated app-side changes remain visible, and expired protection forces a real read.
- Add regression tests for Flames On followed by a stale overview, both native flame brightness levels, unrelated cloud changes, and bounded reconciliation.
- Validate delayed-cloud and reverse-command behavior through native HAP for all exposed controls, all colored-light dimmers, and mixed commands. Clear older acknowledgements after an uncertain dispatched write so the recovery read can report the actual state.

## 1.0.0-rc.3

- Prevent commands from submitting after the Home response deadline, including after a slow pre-read, token refresh, shutdown, or rejected-write authentication recovery. Already submitted writes are never replayed.
- Bound color staging to 750 ms, settle failed batches immediately, and preserve ordering across color, power, and heat commands.
- Combine light On with hue, saturation, and brightness in one RGBW update, suppress redundant writes, and restore the last nonzero selected color and brightness after Off. Protect pending color intent from unrelated Home state updates.
- Keep overview freshness separate from successful local commands, and require a new trusted overview after malformed reads or uncertain writes.
- Save newly verified guided or manual sign-ins directly to persistent storage. Coordinate refresh-token rotation and replacement across UI/runtime processes with private atomic token storage and bounded locking.
- Preserve identity and capabilities when overview metadata is absent; prevent discovery and polling from restarting after shutdown.
- Honor server backoff, map missing sign-in to Home communication errors, and remove device identifiers from API error text.
- Add readable sign-in status panels, an explicit manual-token apply action, and optional private Lighting Diagnostics for investigating physical transitions.
- Align configuration bounds with the schema and avoid resetting the Flame Speed characteristic on every refresh. Existing service identities, custom names, and thermostat behavior remain compatible.
- Add regression tests covering real HAP color requests, expired writes, trusted-state recovery, color restoration, metadata omissions, token replacement/locking, and privacy-safe diagnostics.
- Retire the separate native macOS helper; guided Homebridge sign-in is the supported cross-platform workflow, with the terminal helper retained as a fallback.

This candidate's packet-level color transitions are tested automatically. Physical confirmation that the reported white flash is gone is still required before promoting v1.0.0 to stable.

## 1.0.0-rc.2

- Fail a refresh when an overview omits any previously confirmed parameter, whether the response is empty or partial: known-good state, the HomeKit accessory layout, and freshness are preserved, so a single anomalous overview can never remove a control. Writes fail closed while the cloud-failure cooldown is active and re-read the overview after recovery instead of trusting a rejected snapshot.
- Fail closed on partially malformed device lists: previously discovered accessories are kept rather than unregistered when a later discovery response is malformed.
- Adopt and retry a cross-process rotated token when a refresh fails with `invalid_grant`, instead of demanding re-authentication; the failed-refresh path never writes the token file, eliminating the token lost-update race.
- Return a HomeKit communication error for cold-start reads with no confirmed state instead of reporting "off"; cancel queued commands that expire before starting so they never execute late, while already-started writes finish and reconcile without replay.
- Assign the primary HomeKit service through HAP's `setPrimaryService`, guarded against repeated configuration-change events.
- Expand automated coverage for incomplete overviews, malformed discovery, token rotation races, deadline handling, and primary-service assignment; 106 tests pass.

## 1.0.0-rc.1

- Reuse recently confirmed fireplace state inside the serialized command queue, reducing most commands from two cloud round trips to one while retaining a configurable conservative mode.
- Coalesce HomeKit hue, saturation, and brightness gestures into one trailing-edge write per light without coalescing power, heater, mode, or on/off commands.
- Preserve the selected Media Bed, Media Accent, and Logs color in Apple Home while brightness is zero and restore it when the light returns.
- Cancel a color write that is still staged when the same light is turned off, preserving the final selected color for the next turn-on.
- Refresh multiple fireplaces with bounded concurrency, prevent overlapping poll cycles, and change the new-installation background synchronization default to 15 minutes.
- Stop background polling when authentication requires user action and replace terminal-helper-only messages with guided Homebridge settings instructions.
- Honor usable `Retry-After` guidance for safe reads without replaying writes whose outcome could be uncertain.
- Validate saved authentication through the Flame Connect API and distinguish revoked authentication from temporary cloud unavailability.
- Clear accessory timers and staged color operations on shutdown or accessory removal.
- Log fireplace-reported fault transitions without exposing device identifiers; avoid unsupported HomeKit fault-characteristic placement.
- Expand automated coverage for atomic freshness checks, conservative mode, coalescing, color/off ordering, zero-brightness color retention, bounded concurrency, polling, lifecycle cleanup, and fault transitions.

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
