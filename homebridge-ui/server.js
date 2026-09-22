import { randomBytes } from 'node:crypto';
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import {
  buildAuthorizationRequest,
  exchangeAuthorizationCode,
  parseAuthorizationRedirect,
} from '../src/flameconnect/auth.js';
import { loginWithCredentials } from '../src/flameconnect/b2c-login.js';

const SESSION_LIFETIME_MS = 10 * 60_000;

class FlameConnectUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.sessions = new Map();
    this.onRequest('/auth/start', this.startAuthorization.bind(this));
    this.onRequest('/auth/complete', this.completeAuthorization.bind(this));
    this.onRequest('/auth/credentials', this.authenticateCredentials.bind(this));
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
      const token = await exchangeAuthorizationCode(code, session.verifier);
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
      const redirect = await loginWithCredentials(request.url, email, password);
      const code = parseAuthorizationRedirect(redirect, request.state);
      const token = await exchangeAuthorizationCode(code, request.verifier);
      if (!token.refresh_token) throw new Error('Flame Connect did not return a refresh token.');
      return { refreshToken: token.refresh_token };
    } catch (error) {
      throw new RequestError('Flame Connect sign-in failed', { message: error.message });
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
