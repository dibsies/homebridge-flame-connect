# Future improvements

## Authentication status messaging

Once a refresh token has been retrieved and confirmed active, the custom Homebridge UI should clearly indicate that Flame Connect authentication is currently valid. It should also explain that users only need to sign in again when the plugin reports that authentication has expired or been revoked.

Suggested wording:

> Flame Connect is signed in and the saved token is valid. You only need to sign in again if the plugin prompts you to renew authentication.

The status must be based on an actual successful token validation rather than merely detecting that the configuration contains a token.
