# Future improvements

## Authentication status messaging

Once a refresh token has been retrieved and confirmed active, the custom Homebridge UI should clearly indicate that Flame Connect authentication is currently valid. It should also explain that users only need to sign in again when the plugin reports that authentication has expired or been revoked.

Suggested wording:

> Flame Connect is signed in and the saved token is valid. You only need to sign in again if the plugin prompts you to renew authentication.

The status must be based on an actual successful token validation rather than merely detecting that the configuration contains a token.

## Rapid multi-control responsiveness

Live v0.1.8 testing confirmed that rapidly toggling and sliding four different controls can temporarily build a serialized cloud-command backlog, after which the queue recovers without a restart. Consider a short settle window and selective coalescing for lighting, color, and brightness writes. Preserve strict ordering for Fireplace power, Heater, Eco Mode, Fan Only, and Turbo Boost commands, and provide a diagnostic rather than silently dropping operations.

## Local control research

No supported or reverse-engineered local-control protocol is currently known. Future research may examine passive LAN traffic, offline behavior, Bluetooth, provisioning, or hardware-level interfaces. Keep the proven cloud integration as a fallback and preserve all built-in heater safety controls.
