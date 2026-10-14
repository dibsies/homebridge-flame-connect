import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import {
  buildAuthorizationRequest,
  exchangeAuthorizationCode,
  FlameConnectAuth,
  parseAuthorizationRedirect,
} from '../src/flameconnect/auth.js';
import { loginWithCredentials } from '../src/flameconnect/b2c-login.js';
import { FlameConnectClient } from '../src/flameconnect/client.js';
import { replaceSignIn } from '../src/flameconnect/sign-in.js';

const SESSION_LIFETIME_MS = 10 * 60_000;
// Backstop for UI server requests: inner operations (B2C login, cloud client)
// carry their own shorter deadlines with specific messages; this only guards
// against something hanging outside them.
const UI_REQUEST_TIMEOUT_MS = 120_000;

function withUiTimeout(promise, operation) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${operation} timed out.`)), UI_REQUEST_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class FlameConnectUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.sessions = new Map();
    this.onRequest('/auth/start', this.startAuthorization.bind(this));
    this.onRequest('/auth/complete', this.completeAuthorization.bind(this));
    this.onRequest('/auth/credentials', this.authenticateCredentials.bind(this));
    this.onRequest('/auth/validate', this.validateAuthorization.bind(this));
    this.onRequest('/auth/replace', this.replaceAuthorization.bind(this));
    this.ready();
  }

  startAuthorization() {
    const request = buildAuthorizationRequest();
    const sessionId = randomBytes(24).toString('base64url');
    this.sessions.set(sessionId, {
      state: request.state,
      verifier: request.verifier,
      expiresAt: Date.now() + SESSION_LIFETIME_MS,
    });
    this.removeExpiredSessions();
    return { sessionId, authorizationUrl: request.url };
  }

  async completeAuthorization(payload = {}) {
    const session = this.sessions.get(payload.sessionId);
    this.sessions.delete(payload.sessionId);
    if (!session || session.expiresAt < Date.now()) {
      throw new RequestError('Sign-in session expired', {
        message: 'Select Start sign-in and try again.',
      });
    }
    try {
      const code = parseAuthorizationRedirect(payload.redirectUrl, session.state);
      const token = await withUiTimeout(
        exchangeAuthorizationCode(code, session.verifier), 'Flame Connect sign-in',
      );
      if (!token.refresh_token) throw new Error('Flame Connect did not return a refresh token.');
      return await this.persistSignIn(token, payload);
    } catch (error) {
      throw new RequestError('Flame Connect sign-in failed', { message: error.message });
    }
  }

  async authenticateCredentials(payload = {}) {
    const email = String(payload.email || '').trim();
    const password = String(payload.password || '');
    if (!email || !password) {
      throw new RequestError('Missing credentials', { message: 'Enter your Flame Connect email and password.' });
    }
    try {
      const request = buildAuthorizationRequest();
      const redirect = await withUiTimeout(
        loginWithCredentials(request.url, email, password), 'Flame Connect sign-in',
      );
      const code = parseAuthorizationRedirect(redirect, request.state);
      const token = await withUiTimeout(
        exchangeAuthorizationCode(code, request.verifier), 'Flame Connect sign-in',
      );
      if (!token.refresh_token) throw new Error('Flame Connect did not return a refresh token.');
      return await this.persistSignIn(token, payload);
    } catch (error) {
      throw new RequestError('Flame Connect sign-in failed', { message: error.message });
    }
  }

  async validateAuthorization(payload = {}) {
    const refreshToken = String(payload.refreshToken || '');
    const configuredTokenFile = String(payload.tokenFile || '').trim();
    const storagePath = this.homebridgeStoragePath;
    const tokenFile = configuredTokenFile || (storagePath
      ? path.join(storagePath, 'flame-connect-tokens.json') : undefined);
    if (!refreshToken && !tokenFile) return { status: 'not_configured' };
    const auth = new FlameConnectAuth({ refreshToken, tokenFile });
    const client = new FlameConnectClient(auth);
    try {
      await withUiTimeout(client.getFires(), 'Flame Connect sign-in check');
      return { status: 'valid' };
    } catch (error) {
      if (error?.code === 'FLAMECONNECT_NO_TOKEN') return { status: 'not_configured' };
      if (error?.code === 'FLAMECONNECT_REAUTH_REQUIRED') return { status: 'reauth_required' };
      return { status: 'temporarily_unavailable' };
    }
  }

  effectiveTokenFile(payload = {}) {
    const configured = String(payload.tokenFile || '').trim();
    if (configured && !path.isAbsolute(configured)) throw new Error('Token File must be an absolute path.');
    if (configured) return configured;
    if (!this.homebridgeStoragePath) throw new Error('Homebridge storage is unavailable; please reopen plugin settings.');
    return path.join(this.homebridgeStoragePath, 'flame-connect-tokens.json');
  }

  async persistSignIn(token, payload) {
    // Validate the new session independently of the old file. An expired
    // stored token must never override a successful explicit sign-in.
    return withUiTimeout(replaceSignIn(token, this.effectiveTokenFile(payload)), 'New Flame Connect sign-in check');
  }

  async replaceAuthorization(payload = {}) {
    const refreshToken = String(payload.refreshToken || '').trim();
    if (!refreshToken) throw new RequestError('Missing token', { message: 'Enter a manual refresh token in the settings first.' });
    try {
      return await this.persistSignIn({ refresh_token: refreshToken, expires_in: 0 }, payload);
    } catch (error) {
      throw new RequestError('Could not apply sign-in', { message: error.message });
    }
  }

  removeExpiredSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt < now) this.sessions.delete(id);
    }
  }
}

(() => new FlameConnectUiServer())();
