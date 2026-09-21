#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { buildAuthorizationRequest, exchangeAuthorizationCode, parseAuthorizationRedirect } from '../src/flameconnect/auth.js';

const rl = readline.createInterface({ input, output });

try {
  const request = buildAuthorizationRequest();
  console.log('\nFlame Connect authorization\n');
  console.log('1. Open this URL in a browser and sign in to your Flame Connect account:\n');
  console.log(request.url);
  console.log('\n2. After sign-in, the browser will redirect to an msal...://auth URL.');
  console.log('   Your browser may say it cannot open the address. That is expected.');
  console.log('   Copy the FULL address from the browser address bar.\n');
  const redirect = await rl.question('Paste the full redirected URL here: ');
  const code = parseAuthorizationRedirect(redirect, request.state);
  const token = await exchangeAuthorizationCode(code, request.verifier);
  if (!token.refresh_token) {
    throw new Error('Authentication succeeded but Azure did not return a refresh token.');
  }
  console.log('\nSuccess. Paste this value into Homebridge → Flame Connect → Refresh Token:\n');
  console.log(token.refresh_token);
  console.log('\nTreat this refresh token like a password. Do not post it in logs or screenshots.\n');
} catch (error) {
  console.error(`\nAuthorization failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  rl.close();
}
