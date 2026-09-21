import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  API_SCOPE,
  AUTH_SCOPES,
  AUTHORIZE_ENDPOINT,
  CLIENT_ID,
  REDIRECT_URI,
  TOKEN_ENDPOINT,
} from './constants.js';

function base64Url(buffer) {
  return buffer
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function createPkce() {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizationRequest() {
  const { verifier, challenge } = createPkce();
  const state = base64Url(randomBytes(24));
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    response_mode: 'query',
    scope: AUTH_SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return { url: url.toString(), state, verifier };
}

export function parseAuthorizationRedirect(input, expectedState) {
  const value = String(input).trim();
  const question = value.indexOf('?');
  const hash = value.indexOf('#');
  const separator = question >= 0 ? question : hash;
  if (separator < 0) {
    throw new Error('The pasted redirect URL does not contain query parameters.');
  }
  const params = new URLSearchParams(value.slice(separator + 1));
  const error = params.get('error');
  if (error) {
    throw new Error(params.get('error_description') || error);
  }
  const state = params.get('state');
  if (!state || state !== expectedState) {
    throw new Error('OAuth state mismatch. Start the authorization helper again.');
  }
  const code = params.get('code');
  if (!code) {
    throw new Error('No authorization code was found in the pasted redirect URL.');
  }
  return code;
}

async function tokenRequest(fields) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Flame Connect token endpoint returned HTTP ${response.status}: ${text}`);
  }
  if (!response.ok || data.error) {
    throw new Error(data.error_description || data.error || `OAuth HTTP ${response.status}`);
  }
  return data;
}

export async function exchangeAuthorizationCode(code, verifier) {
  return tokenRequest({
    client_id: CLIENT_ID,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    scope: AUTH_SCOPES.join(' '),
  });
}

export async function exchangeRefreshToken(refreshToken) {
  return tokenRequest({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: `offline_access ${API_SCOPE}`,
  });
}

export class FlameConnectAuth {
  constructor({ refreshToken, tokenFile, log }) {
    this.configRefreshToken = refreshToken || '';
    this.tokenFile = tokenFile;
    this.log = log;
    this.loaded = false;
    this.state = {
      accessToken: '',
      refreshToken: '',
      expiresAt: 0,
    };
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (this.tokenFile) {
      try {
        const stored = JSON.parse(await readFile(this.tokenFile, 'utf8'));
        this.state.accessToken = stored.accessToken || '';
        this.state.refreshToken = stored.refreshToken || '';
        this.state.expiresAt = Number(stored.expiresAt || 0);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this.log?.warn?.(`Could not read Flame Connect token file: ${error.message}`);
        }
      }
    }
    if (!this.state.refreshToken && this.configRefreshToken) {
      this.state.refreshToken = this.configRefreshToken;
    }
  }

  async save() {
    if (!this.tokenFile) return;
    await mkdir(path.dirname(this.tokenFile), { recursive: true });
    await writeFile(
      this.tokenFile,
      JSON.stringify({
        accessToken: this.state.accessToken,
        refreshToken: this.state.refreshToken,
        expiresAt: this.state.expiresAt,
      }, null, 2),
      { mode: 0o600 },
    );
  }

  async getAccessToken(forceRefresh = false) {
    await this.load();
    const now = Date.now();
    if (!forceRefresh && this.state.accessToken && this.state.expiresAt - now > 5 * 60_000) {
      return this.state.accessToken;
    }
    if (!this.state.refreshToken) {
      throw new Error(
        'No Flame Connect refresh token is configured. Run flameconnect-auth and paste its refresh token into the Homebridge plugin settings.',
      );
    }
    const data = await exchangeRefreshToken(this.state.refreshToken);
    this.state.accessToken = data.access_token;
    this.state.refreshToken = data.refresh_token || this.state.refreshToken;
    this.state.expiresAt = Date.now() + Math.max(60, Number(data.expires_in || 3600)) * 1000;
    await this.save();
    return this.state.accessToken;
  }
}
