import { CLIENT_ID, POLICY, TENANT_HOST } from './constants.js';

const REDIRECT_PREFIX = `msal${CLIENT_ID}://auth`;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Bounded deadlines: no sign-in step may hang the UI server, and the whole
// flow has an overall cap so a stalled B2C session cannot linger.
const STEP_TIMEOUT_MS = 20_000;
const OVERALL_TIMEOUT_MS = 90_000;

function assertTrustedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== TENANT_HOST) {
    throw new Error('Flame Connect authentication attempted to use an unexpected host.');
  }
  return url;
}

function responseCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const combined = headers.get('set-cookie');
  return combined ? combined.split(/,(?=\s*[^;,=]+=[^;,]*)/u) : [];
}

function mergeCookies(jar, headers) {
  for (const cookie of responseCookies(headers)) {
    const pair = cookie.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator > 0) jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1));
  }
}

function cookieHeader(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function extractLoginFields(html, pageUrl) {
  const csrf = html.match(/"csrf"\s*:\s*"([^"]+)"/u)?.[1];
  const tx = html.match(/"transId"\s*:\s*"([^"]+)"/u)?.[1];
  if (!csrf || !tx) throw new Error('Flame Connect changed its sign-in page; required fields were not found.');
  const page = assertTrustedUrl(pageUrl);
  const tenant = page.pathname.split('/').filter(Boolean)[0];
  if (!tenant) throw new Error('Flame Connect returned an invalid sign-in address.');
  const base = `https://${TENANT_HOST}/${tenant}/${POLICY}/`;
  return {
    csrf,
    tx,
    postUrl: `${base}SelfAsserted?tx=${tx}&p=${POLICY}`,
    confirmedUrl: `${base}api/CombinedSigninAndSignup/confirmed`,
  };
}

async function trustedFetch(fetchImpl, url, options, jar, signal) {
  assertTrustedUrl(url);
  const headers = new Headers(options.headers || {});
  if (jar.size) headers.set('Cookie', cookieHeader(jar));
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(STEP_TIMEOUT_MS)])
    : AbortSignal.timeout(STEP_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...options, headers, redirect: 'manual', signal: combined });
    mergeCookies(jar, response.headers);
    return response;
  } catch (error) {
    if (combined.aborted) {
      throw new Error(signal?.aborted
        ? 'Flame Connect sign-in timed out.'
        : 'A Flame Connect sign-in step timed out.');
    }
    throw error;
  }
}

async function loadLoginPage(fetchImpl, initialUrl, jar, signal) {
  let next = initialUrl;
  for (let hop = 0; hop < 20; hop += 1) {
    const response = await trustedFetch(fetchImpl, next, { method: 'GET' }, jar, signal);
    if (!REDIRECT_STATUSES.has(response.status)) {
      if (response.status !== 200) throw new Error(`Flame Connect sign-in returned HTTP ${response.status}.`);
      return { html: await response.text(), url: response.url || next };
    }
    const location = response.headers.get('location');
    if (!location) throw new Error('Flame Connect sign-in returned a redirect without a destination.');
    next = new URL(location, next).toString();
  }
  throw new Error('Flame Connect sign-in used too many redirects.');
}

export async function loginWithCredentials(authorizationUrl, email, password, fetchImpl = fetch) {
  if (!String(email).trim() || !String(password)) throw new Error('Email and password are required.');
  const overall = AbortSignal.timeout(OVERALL_TIMEOUT_MS);
  const jar = new Map();
  const loginPage = await loadLoginPage(fetchImpl, authorizationUrl, jar, overall);
  const fields = extractLoginFields(loginPage.html, loginPage.url);
  const origin = `https://${TENANT_HOST}`;
  const response = await trustedFetch(fetchImpl, fields.postUrl, {
    method: 'POST',
    headers: {
      'X-CSRF-TOKEN': fields.csrf,
      'X-Requested-With': 'XMLHttpRequest',
      Referer: authorizationUrl,
      Origin: origin,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: new URLSearchParams({ request_type: 'RESPONSE', email: String(email).trim(), password }),
  }, jar, overall);
  const body = await response.text();
  if (response.status !== 200) throw new Error(`Credential submission returned HTTP ${response.status}.`);
  try {
    const data = JSON.parse(body);
    if (String(data.status) === '400') throw new Error('Invalid Flame Connect email or password.');
  } catch (error) {
    if (error instanceof SyntaxError) {
      // Successful B2C responses are not guaranteed to use JSON.
    } else throw error;
  }

  const query = `rememberMe=false&csrf_token=${fields.csrf}&tx=${fields.tx}&p=${POLICY}`;
  let next = `${fields.confirmedUrl}?${query}`;
  for (let hop = 0; hop < 20; hop += 1) {
    const confirmed = await trustedFetch(fetchImpl, next, { method: 'GET' }, jar, overall);
    const confirmedBody = await confirmed.text();
    if (REDIRECT_STATUSES.has(confirmed.status)) {
      const location = confirmed.headers.get('location');
      if (!location) throw new Error('Flame Connect returned an incomplete sign-in redirect.');
      if (location === REDIRECT_PREFIX || location.startsWith(`${REDIRECT_PREFIX}?`)
        || location.startsWith(`${REDIRECT_PREFIX}/`)) return location;
      next = new URL(location, next).toString();
      continue;
    }
    if (confirmed.status === 200) {
      const redirect = confirmedBody.match(/(msal[a-f0-9-]+:\/\/auth\?[^\s"'<]+)/u)?.[1];
      if (redirect) return redirect;
      throw new Error('Flame Connect completed sign-in without returning an authorization code.');
    }
    throw new Error(`Flame Connect confirmation returned HTTP ${confirmed.status}.`);
  }
  throw new Error('Flame Connect sign-in used too many redirects.');
}
