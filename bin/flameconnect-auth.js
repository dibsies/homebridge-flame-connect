#!/usr/bin/env node
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { buildAuthorizationRequest, exchangeAuthorizationCode, parseAuthorizationRedirect } from '../src/flameconnect/auth.js';

const rl = readline.createInterface({ input, output });

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function openBrowser(url) {
  if (process.argv.includes('--no-open')) return false;
  const command = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return true;
}

try {
  const request = buildAuthorizationRequest();
  console.log('\nFlame Connect authorization\n');
  console.log('1. Open this URL in a browser and sign in to your Flame Connect account:\n');
  console.log(request.url);
  if (openBrowser(request.url)) console.log('\n   Your default browser should open automatically.');
  console.log('\n2. After sign-in, the browser will redirect to an msal...://auth URL.');
  console.log('   Your browser may say it cannot open the address. That is expected.');
  console.log('   Copy the FULL address from the browser address bar.\n');
  const redirect = await rl.question('Paste the full redirected URL here: ');
  const code = parseAuthorizationRedirect(redirect, request.state);
  const token = await exchangeAuthorizationCode(code, request.verifier);
  if (!token.refresh_token) {
    throw new Error('Authentication succeeded but Azure did not return a refresh token.');
  }
  const tokenFile = option('--token-file');
  if (tokenFile) {
    const resolved = path.resolve(tokenFile);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, JSON.stringify({
      accessToken: token.access_token || '',
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000,
    }, null, 2), { mode: 0o600 });
    await chmod(resolved, 0o600);
    console.log(`\nSuccess. Tokens were saved securely to ${resolved}.`);
    console.log('Set Token File in the Homebridge plugin settings to that path; no token needs to be pasted.\n');
  } else {
    console.log('\nSuccess. Paste this value into Homebridge → Flame Connect → Refresh Token:\n');
    console.log(token.refresh_token);
    console.log('\nTreat this refresh token like a password. Do not post it in logs or screenshots.');
    console.log('Tip: use --token-file /path/to/flame-connect-tokens.json to save it without displaying it.\n');
  }
} catch (error) {
  console.error(`\nAuthorization failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  rl.close();
}
