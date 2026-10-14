# RC5 control regression checks

The local RC5 build tests every exposed control against delayed cloud overviews through native HAP requests, the real Flame Connect encoders, and the actual HTTP request/response parser with simulated cloud responses. The matrix alternates successful response bodies lacking ResultCode. Unlike RC4's matrix, it does not mock writeParameters. All 155 tests pass on Node 22 and Node 24.

Response compatibility checks cover empty HTTP 204, empty objects, arrays, JSON strings, success objects, and numeric/string zero ResultCode. Explicit nonzero ResultCode, malformed supplied codes, invalid JSON, and HTTP failure still reject. A native HAP rejection test verifies failed commands do not become successful local state updates. These are simulated responses, not captured private cloud payloads.

| Control | Verified under delayed cloud reads |
| --- | --- |
| Fireplace | Off, On, and reverse commands |
| Flames | Off, On, and reverse commands |
| Flame brightness | Both native levels, 50% and 100% |
| Flame Speed | Speed changes and its Active control |
| Heater | Heat/Off; current and target heating states agree |
| Target temperature | Half-degree setpoints and existing mirrored current-temperature behavior |
| Eco Mode | Eco/Normal without engaging a stopped heater |
| Fan Only | Start/stop while both thermostat heating states remain Off |
| Turbo Boost | Start/stop and restoration to prior persistent state |
| Media Bed | On/off, RGB color, dimming, preservation of other lights |
| Media Accent | On/off, RGB color, dimming, preservation of other lights |
| Logs | On/off, RGB color, dimming, preservation of media lights |
| Pulsating Effect | On/off |
| Ambient Sensor | On/off |

Mixed-command checks interleave heat, fan, setpoint, flames, speed, Bed, Accent, and Logs with conservative pre-reads enabled. Latest field settings survive subsequent stale overviews and full-parameter writes.

The failure check includes a later write that may reach the unit but loses its response. Older acknowledgement guards are cleared so the recovery read reports actual state, and a later brightness change cannot resurrect an old On command.

These are automated protocol/HAP checks. Physical white-flash behavior, timed Turbo Boost expiry, and hardware-specific capabilities still require the actual unit. The macOS helper remains retired.
