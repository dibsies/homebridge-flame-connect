import assert from 'node:assert/strict';
import test from 'node:test';

import { FlameConnectAuth, buildAuthorizationRequest, exchangeRefreshToken, parseAuthorizationRedirect } from '../src/flameconnect/auth.js';

test('authorization request mirrors the upstream MSAL OIDC flow', () => {
  const request = buildAuthorizationRequest();
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_info'), '1');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.equal(url.searchParams.get('state'), request.state);
  assert.ok(url.searchParams.get('nonce'));
  assert.ok(request.nonce);
  assert.ok(request.verifier.length >= 43);
});

test('redirect parser explains truncated browser addresses', () => {
  assert.throws(() => parseAuthorizationRedirect('msal-test://auth?code=abc…', 'right'), /truncated/u);
});

test('revoked refresh tokens are identified as requiring sign-in', async () => {
  const original=globalThis.fetch;
  globalThis.fetch=async()=>({ok:false,status:400,text:async()=>JSON.stringify({error:'invalid_grant'})});
  try {
    await assert.rejects(exchangeRefreshToken('expired'),error=>error.code==='FLAMECONNECT_REAUTH_REQUIRED');
  } finally { globalThis.fetch=original; }
});

test('redirect parser accepts matching state and rejects mismatches', () => {
  assert.equal(parseAuthorizationRedirect('msal-test://auth?code=abc&state=right', 'right'), 'abc');
  assert.throws(
    () => parseAuthorizationRedirect('msal-test://auth?code=abc&state=wrong', 'right'),
    /state mismatch/u,
  );
});

test('concurrent token refreshes share a single network call', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'tok', refresh_token: 'rt2', expires_in: 3600 }),
    };
  };
  try {
    const auth = new FlameConnectAuth({ refreshToken: 'rt', tokenFile: null });
    const [first, second, third] = await Promise.all([
      auth.getAccessToken(true),
      auth.getAccessToken(true),
      auth.getAccessToken(true),
    ]);
    assert.equal(first, 'tok');
    assert.equal(second, 'tok');
    assert.equal(third, 'tok');
    assert.equal(calls, 1);
    assert.equal(auth.state.refreshToken, 'rt2');
    // A later forced refresh starts a new network call once the first settles.
    await auth.getAccessToken(true);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('token endpoint requests carry an abort timeout signal', async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = options;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
    };
  };
  try {
    const data = await exchangeRefreshToken('rt');
    assert.equal(data.access_token, 'a');
    assert.ok(seen.signal instanceof AbortSignal);
  } finally {
    globalThis.fetch = original;
  }
});
