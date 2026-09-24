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
      return { refreshToken: token.refresh_token };
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
      return { refreshToken: token.refresh_token };
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

  removeExpiredSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt < now) this.sessions.delete(id);
    }
  }
}

(() => new FlameConnectUiServer())();
