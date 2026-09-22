import assert from 'node:assert/strict';
import test from 'node:test';
import { loginWithCredentials } from '../src/flameconnect/b2c-login.js';
import { CLIENT_ID, TENANT_HOST } from '../src/flameconnect/constants.js';

function headers(values = {}, cookies = []) {
  const result = new Headers(values);
  result.getSetCookie = () => cookies;
  return result;
}

test('credential login captures the custom redirect without storing credentials', async () => {
  const state = 'matching-state';
  const redirect = `msal${CLIENT_ID}://auth?code=authorization-code&state=${state}`;
  const responses = [
    {
      status: 200, url: `https://${TENANT_HOST}/tenant/policy/oauth2/v2.0/authorize`,
      headers: headers({}, ['session=one; Path=/']),
      text: async () => 'var SETTINGS = {"csrf":"csrf-value","transId":"tx-value"};',
    },
    {
      status: 200, url: '', headers: headers({}, ['session=two; Path=/']),
      text: async () => JSON.stringify({ status: '200' }),
    },
    {
      status: 302, url: '', headers: headers({ location: redirect }), text: async () => '',
    },
  ];
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return responses.shift();
  };

  const result = await loginWithCredentials(
    `https://${TENANT_HOST}/tenant/policy/oauth2/v2.0/authorize`,
    'person@example.com', 'temporary-password', fetchImpl,
  );

  assert.equal(result, redirect);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].options.method, 'POST');
  assert.match(String(requests[1].options.body), /email=person%40example.com/u);
  assert.match(String(requests[1].options.body), /password=temporary-password/u);
  assert.match(requests[2].options.headers.get('Cookie'), /session=two/u);
});

test('credential login refuses to submit to an unexpected host', async () => {
  const fetchImpl = async () => ({
    status: 200,
    url: 'https://example.com/pretend-login',
    headers: headers(),
    text: async () => 'var SETTINGS = {"csrf":"csrf-value","transId":"tx-value"};',
  });
  await assert.rejects(
    loginWithCredentials(`https://${TENANT_HOST}/start`, 'person@example.com', 'secret', fetchImpl),
    /unexpected host/u,
  );
});
