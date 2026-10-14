import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FlameConnectCloudError } from './errors.js';

const heldLocks = new AsyncLocalStorage();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readTokenState(file) {
  if (!file) return null;
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// A shared lock covers refresh-token rotation as well as saving. Atomic
// rename alone cannot prevent two processes from rotating the same token.
export async function withTokenLock(file, operation, timeoutMs = 70_000) {
  if (!file) return operation();
  const target = path.resolve(file);
  if (heldLocks.getStore()?.has(target)) return operation();
  await mkdir(path.dirname(target), { recursive: true });
  const lock = `${target}.lock`;
  const owner = `${process.pid}:${randomBytes(12).toString('hex')}`;
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(lock, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ owner, pid: process.pid })); }
      finally { await handle.close(); }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const contents = await readFile(lock, 'utf8');
        let dead = false;
        try {
          const saved = JSON.parse(contents);
          if (Number.isInteger(saved.pid) && saved.pid > 0) {
            try { process.kill(saved.pid, 0); } catch (probe) { dead = probe.code === 'ESRCH'; }
          } else dead = Date.now() - (await stat(lock)).mtimeMs > 10_000;
        } catch { dead = Date.now() - (await stat(lock)).mtimeMs > 10_000; }
        if (dead && await readFile(lock, 'utf8') === contents) await rm(lock, { force: true });
      } catch (probe) { if (probe.code !== 'ENOENT') throw probe; }
      if (Date.now() >= until) throw new FlameConnectCloudError('Saved sign-in is busy; try again shortly.', { kind: 'timeout' });
      await delay(50);
    }
  }
  try {
    return await heldLocks.run(new Set([...(heldLocks.getStore() || []), target]), operation);
  } finally {
    try {
      if (JSON.parse(await readFile(lock, 'utf8')).owner === owner) await rm(lock, { force: true });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function writeTokenState(file, state) {
  if (!file) return;
  return withTokenLock(file, async () => {
    await rm(`${file}.${process.pid}.tmp`, { force: true });
    const temporary = `${file}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  });
}
