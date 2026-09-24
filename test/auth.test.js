import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

test('concurrent load() calls share a single in-flight token file read', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flame-load-'));
  const tokenFile = path.join(dir, 'tokens.json');
  await writeFile(tokenFile, JSON.stringify({ accessToken: '', refreshToken: 'file-rt', expiresAt: 0 }));
  const warnings = [];
  try {
    const auth = new FlameConnectAuth({ tokenFile, log: { warn: (m) => warnings.push(m) } });
    const first = auth.load();
    // The second caller must join the in-flight read, not observe `loaded`
    // and proceed with empty state while the file is still being read.
    await auth.load();
    assert.equal(auth.state.refreshToken, 'file-rt');
    await first;
    assert.equal(auth.state.refreshToken, 'file-rt');
    assert.deepEqual(warnings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing refresh token is a permanent configuration error, not a cloud error', async () => {
  const auth = new FlameConnectAuth({ tokenFile: null });
  await assert.rejects(
    auth.getAccessToken(),
    (error) => error.code === 'FLAMECONNECT_NO_TOKEN' && /flameconnect-auth/.test(error.message),
  );
});

test('an unreachable token endpoint is marked as a cloud error', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
  };
  try {
    await assert.rejects(
      exchangeRefreshToken('rt'),
      (error) => error.code === 'FLAMECONNECT_CLOUD_ERROR' && /Could not reach/.test(error.message),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('repeated token endpoint HTTP 503s are marked as cloud errors', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 503, text: async () => 'down' };
  };
  try {
    await assert.rejects(
      exchangeRefreshToken('rt'),
      (error) => error.code === 'FLAMECONNECT_CLOUD_ERROR',
    );
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test('a crashed token save cannot leave a truncated token file behind', async () => {
  const { readdir, readFile, stat } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flame-auth-'));
  try {
    const tokenFile = path.join(dir, 'tokens.json');
    const auth = new FlameConnectAuth({ tokenFile, log: { debug() {}, info() {}, warn() {}, error() {} } });
    auth.state.refreshToken = 'refresh-1';
    auth.state.accessToken = 'access-1';
    auth.state.expiresAt = Date.now() + 3600_000;
    // Simulate a crash mid-save: a leftover temp file and a truncated token file.
    await writeFile(`${tokenFile}.${process.pid}.tmp`, '{"truncated": tru');
    await writeFile(tokenFile, '{"truncated": tru');
    await auth.save();
    const parsed = JSON.parse(await readFile(tokenFile, 'utf8'));
    assert.equal(parsed.refreshToken, 'refresh-1');
    assert.equal(parsed.accessToken, 'access-1');
    assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), []);
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a refresh rejected after another process rotated the token retries once with the stored token', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flame-auth-'));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    if (String(options.body).includes('refresh_token=stale-token')) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_grant' }) };
    }
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ access_token: 'fresh-access', refresh_token: 'rotated-token', expires_in: 3600 }),
    };
  };
  try {
    const tokenFile = path.join(dir, 'tokens.json');
    const auth = new FlameConnectAuth({ tokenFile, log: { debug() {}, info() {}, warn() {}, error() {} } });
    auth.state.refreshToken = 'stale-token';
    // Another process (the settings-page validator) rotated the token file.
    await writeFile(tokenFile, JSON.stringify({ refreshToken: 'rotated-token' }));
    const token = await auth.performRefresh();
    assert.equal(token, 'fresh-access');
    assert.equal(auth.state.refreshToken, 'rotated-token');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test('a rejected refresh with no rotation clears state and surfaces re-auth', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flame-auth-'));
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_grant' }) });
  try {
    const tokenFile = path.join(dir, 'tokens.json');
    const auth = new FlameConnectAuth({ tokenFile, log: { debug() {}, info() {}, warn() {}, error() {} } });
    auth.state.refreshToken = 'dead-token';
    await writeFile(tokenFile, JSON.stringify({ refreshToken: 'dead-token' }));
    await assert.rejects(auth.performRefresh(), (error) => error.code === 'FLAMECONNECT_REAUTH_REQUIRED');
    assert.equal(auth.state.accessToken, '');
  } finally {
    globalThis.fetch = original;
    await rm(dir, { recursive: true, force: true });
  }
});
