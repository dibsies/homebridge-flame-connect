import { FlameConnectAuth } from './auth.js';
import { FlameConnectClient } from './client.js';
import { writeTokenState } from './token-store.js';

export async function replaceSignIn(token, tokenFile) {
  if (!tokenFile) throw new Error('Homebridge token storage is required.');
  if (!token.refresh_token) throw new Error('Flame Connect did not return a refresh token.');
  const auth = new FlameConnectAuth({ refreshToken: token.refresh_token, tokenFile: null });
  auth.loaded = true;
  auth.state = { accessToken: token.access_token || '', refreshToken: token.refresh_token,
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000 };
  await new FlameConnectClient(auth).getFires();
  await writeTokenState(tokenFile, auth.state);
  return { refreshToken: auth.state.refreshToken };
}
