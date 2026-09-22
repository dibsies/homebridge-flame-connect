import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

function waitForMessage(child, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for custom UI server.')), 5_000);
    const listener = (message) => {
      if (!predicate(message)) return;
      clearTimeout(timeout);
      child.off('message', listener);
      resolve(message);
    };
    child.on('message', listener);
  });
}

test('custom UI server starts over Homebridge IPC and creates an OAuth session', async (t) => {
  const child = fork(fileURLToPath(new URL('../homebridge-ui/server.js', import.meta.url)), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(() => child.kill());
  await waitForMessage(child, (message) => message?.action === 'ready');
  child.send({ action: 'request', requestId: 'start', path: '/auth/start', body: {} });
  const message = await waitForMessage(child,
    (candidate) => candidate?.action === 'response' && candidate.payload?.requestId === 'start');
  assert.equal(message.payload.success, true);
  assert.ok(message.payload.data.sessionId.length >= 32);
  const url = new URL(message.payload.data.authorizationUrl);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.ok(url.searchParams.get('state'));
});
