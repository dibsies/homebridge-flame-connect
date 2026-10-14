# Validation: 1.0.0

Build date: 2026-10-13. Runtime source is unchanged from RC5. The owner confirmed that RC5 resolved the command failure and flame-switch regression, and that the brief physical white flash during color selection remains. It is a documented known issue, not a verified fix.

## Automated checks

- Full RC5 suite: 155 tests passing on Node 22.23.3 and Node 24.19.0. See CONTROL_REGRESSION_CHECKS.md for HTTP response compatibility, the delayed-cloud control matrix, mixed commands, and uncertain-write recovery checks.
- Regression coverage includes late-write prevention, color batch failure settlement, staging limits, ordering boundaries, stale/malformed overview rejection, off/on color restoration, new sign-in replacement, token-file locking, shutdown, and private diagnostics.
- Native HAP On/Hue/Saturation/Brightness requests produce one final RGBW packet per tested red/blue gesture, without an intermediate white packet. Sibling-light state remains unchanged.
- Existing cloud/HAP error mapping, service identities, naming migration, thermostat, Eco, Fan Only, and Turbo Boost tests pass.
- The RC5 packed tarball passed clean Homebridge 1.8.0 and 2.4.0 plugin discovery and dynamic-platform registration checks. Packed runtime files were compared byte-for-byte with the tested source.
- Published package contains 23 intended files, including guided sign-in UI and the terminal helper; no tests, dependencies, Git history, or native macOS app are included.
- Release-source scan found no personal-name, local-user-path, or live-device-identifier matches. Third-party notices and public OAuth application identifiers are retained.

## Physical checks still required

Automated packet checks do not establish the fireplace's physical transition behavior. Before stable v1.0.0, install this candidate on the unit and confirm:

1. Media Bed and Media Accent reach each selected color. A brief intermediate white flash remains a known issue; the owner requested no further color-control changes.
2. Dim either light to zero, then turn it on. The selected color and previous nonzero brightness return. Changing one light leaves the other alone.
3. Operate several different controls quickly; Home and the fireplace converge without a lasting “Updating…” state.
4. Confirm the existing thermostat, Eco, Fan Only, and Turbo Boost transitions still behave as before.
5. Restart Homebridge and confirm customized Home names and remembered colors persist.
6. If sign-in needs replacing, use guided sign-in or Apply manual token. The new saved session must work after restarting, even when an old token file existed.

If a white flash remains, temporarily enable Lighting Diagnostics, reproduce one transition, and preserve the anonymous input/batch/RGBW timing entries. The remaining question is whether a white packet was transmitted or the device flashed despite receiving only the requested colors. Disable diagnostics afterward.

Publication status is tracked by the repository release page. This report does not claim full physical revalidation of every control on v1.0.0.
