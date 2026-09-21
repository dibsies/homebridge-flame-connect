import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAuthorizationRequest, parseAuthorizationRedirect } from '../src/flameconnect/auth.js';

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

test('redirect parser accepts matching state and rejects mismatches', () => {
  assert.equal(parseAuthorizationRedirect('msal-test://auth?code=abc&state=right', 'right'), 'abc');
  assert.throws(
    () => parseAuthorizationRedirect('msal-test://auth?code=abc&state=wrong', 'right'),
    /state mismatch/u,
  );
});
