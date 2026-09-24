import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  API_SCOPE,
  AUTH_SCOPES,
  AUTHORIZE_ENDPOINT,
  CLIENT_ID,
  REDIRECT_URI,
  TOKEN_ENDPOINT,
} from './constants.js';
import { FlameConnectCloudError, asCloudError } from './errors.js';

function base64Url(buffer) {
  return buffer
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export class FlameConnectReauthenticationRequiredError extends Error {
  constructor(message = 'The Flame Connect sign-in has expired or was revoked. Run flameconnect-auth again.') {
    super(message);
    this.name = 'FlameConnectReauthenticationRequiredError';
    this.code = 'FLAMECONNECT_REAUTH_REQUIRED';
  }
}

export function createPkce() {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizationRequest() {
  const { verifier, challenge } = createPkce();
  const state = base64Url(randomBytes(24));
  // Match MSAL's OIDC auth-code flow. Flame Connect's B2C custom policy
  // expects the hashed nonce claim that MSAL adds automatically.
  const nonce = base64Url(randomBytes(24));
  const nonceHash = base64Url(createHash('sha256').update(nonce).digest());
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    client_info: '1',
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    response_mode: 'query',
    scope: AUTH_SCOPES.join(' '),
    state,
    nonce: nonceHash,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return { url: url.toString(), state, verifier, nonce };
}

export function parseAuthorizationRedirect(input, expectedState) {
  const value = String(input).trim();
  if (value.includes('\u2026') || value.includes('...')) {
    throw new Error('The redirect address appears truncated. Copy the full address from the browser address bar.');
  }
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

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Authentication calls get a slightly longer budget than API commands: the
// token endpoint occasionally pauses before responding, and a slow sign-in
// must not wedge the whole plugin.
const AUTH_REQUEST_TIMEOUT_MS = 20_000;

async function tokenRequest(fields) {
  let response;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields),
        signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
      });
      if (![429, 500, 502, 503, 504].includes(response.status)) break;
      lastError = new Error(`OAuth HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) await delay(250 * (2 ** attempt));
  }
  if (!response) {
    // The token endpoint was unreachable on every attempt: a transient
    // network failure, so mark it for HomeKit communication-error mapping
    // rather than leaving a generic error.
    throw asCloudError(
      lastError,
      `Could not reach Flame Connect authentication: ${lastError?.message || 'network error'}`,
    );
  }
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // The endpoint answered but not with JSON: a cloud-side problem, so
    // classify it deliberately rather than leaving a generic SyntaxError.
    throw new FlameConnectCloudError(
      `Flame Connect token endpoint returned an invalid response (HTTP ${response.status}).`,
    );
  }
  if (!response.ok || data.error) {
    if (data.error === 'invalid_grant' || data.error === 'interaction_required') {
      throw new FlameConnectReauthenticationRequiredError();
    }
    const message = data.error_description || data.error || `OAuth HTTP ${response.status}`;
    // 429/5xx after retries is a transient cloud problem; other OAuth errors
    // (e.g. invalid_client) are configuration problems and stay unmarked.
    if ([429, 500, 502, 503, 504].includes(response.status)) {
      throw new FlameConnectCloudError(message);
    }
    throw new Error(message);
  }
  return data;
}

export async function exchangeAuthorizationCode(code, verifier) {
  return tokenRequest({
    client_id: CLIENT_ID,
    client_info: '1',
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
    // Shared in-flight token-file load. load() is asynchronous: without this,
    // a concurrent caller observes `loaded` while the first caller is still
    // reading the file, skips the read, and proceeds with empty state.
    this.loadPromise = null;
    // Shared in-flight refresh. Azure rotates refresh tokens on use, so two
    // concurrent refreshes can race and invalidate each other; every caller
    // while a refresh is running joins the same promise instead.
    this.refreshPromise = null;
    this.state = {
      accessToken: '',
      refreshToken: '',
      expiresAt: 0,
    };
  }

  async load() {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = this.performLoad().finally(() => {
        this.loadPromise = null;
      });
    }
    await this.loadPromise;
  }

  async performLoad() {
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
    this.loaded = true;
  }

  async save() {
    if (!this.tokenFile) return;
    await mkdir(path.dirname(this.tokenFile), { recursive: true });
    // Write to a temporary file and rename atomically: an interrupted save
    // must never leave a truncated token file behind.
    const temporary = `${this.tokenFile}.${process.pid}.tmp`;
    // A previous crashed save may have left a temp file behind with stale
    // permissions; remove it so the write below creates the file with 0o600.
    await rm(temporary, { force: true });
    await writeFile(
      temporary,
      JSON.stringify({
        accessToken: this.state.accessToken,
        refreshToken: this.state.refreshToken,
        expiresAt: this.state.expiresAt,
      }, null, 2),
      { mode: 0o600 },
    );
    await rename(temporary, this.tokenFile);
  }

  // Read the persisted refresh token without disturbing in-memory state. Used
  // to recover when another process (for example the settings-page validator)
  // rotated the token after this instance loaded it.
  async readStoredRefreshToken() {
    if (!this.tokenFile) return '';
    try {
      const stored = JSON.parse(await readFile(this.tokenFile, 'utf8'));
      return stored.refreshToken || '';
    } catch {
      return '';
    }
  }

  async getAccessToken(forceRefresh = false) {
    await this.load();
    const now = Date.now();
    if (!forceRefresh && this.state.accessToken && this.state.expiresAt - now > 5 * 60_000) {
      return this.state.accessToken;
    }
    if (!this.state.refreshToken) {
      const error = new Error(
        'No Flame Connect refresh token is configured. Run flameconnect-auth and paste its refresh token into the Homebridge plugin settings.',
      );
      // Permanent configuration state, not a transient failure: callers use
      // this code to avoid retrying something that needs user action.
      error.code = 'FLAMECONNECT_NO_TOKEN';
      throw error;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  async performRefresh() {
    let data;
    try {
      data = await exchangeRefreshToken(this.state.refreshToken);
    } catch (error) {
      if (error?.code === 'FLAMECONNECT_REAUTH_REQUIRED') {
        // Another owner (for example the settings-page validator) may have
        // rotated the refresh token after this instance loaded it. The token
        // file is the coordination point: if it now holds a different refresh
        // token, retry once with that one before asking the user to sign in.
        const stored = await this.readStoredRefreshToken();
        if (stored && stored !== this.state.refreshToken) {
          this.log?.debug?.('Flame Connect refresh token was rotated by another process; retrying with the stored token.');
          this.state.refreshToken = stored;
          return this.performRefresh();
        }
        this.state.accessToken = '';
        this.state.expiresAt = 0;
        await this.save();
      }
      throw error;
    }
    this.state.accessToken = data.access_token;
    this.state.refreshToken = data.refresh_token || this.state.refreshToken;
    this.state.expiresAt = Date.now() + Math.max(60, Number(data.expires_in || 3600)) * 1000;
    await this.save();
    return this.state.accessToken;
  }
}
