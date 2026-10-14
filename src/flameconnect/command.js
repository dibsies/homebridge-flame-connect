import { AsyncLocalStorage } from 'node:async_hooks';
import { FlameConnectCloudError } from './errors.js';

const commands = new AsyncLocalStorage();

export function runCommand(entry, operation) {
  return commands.run(entry, operation);
}

export function assertCanSubmit() {
  const entry = commands.getStore();
  if (entry && (entry.cancelled || entry.isDisposed() || Date.now() >= entry.deadlineAt)) {
    throw new FlameConnectCloudError('The Home request expired before its command could be submitted.', {
      kind: 'timeout', code: 'FLAMECONNECT_COMMAND_EXPIRED',
    });
  }
}

export function markCommandDispatched() {
  assertCanSubmit();
  const entry = commands.getStore();
  if (entry) entry.dispatched = true;
}

export function markCommandRejected() {
  const entry = commands.getStore();
  if (entry) entry.dispatched = false;
}
