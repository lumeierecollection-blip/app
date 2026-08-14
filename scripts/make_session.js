/**
 * Amendment E -- one-time Telegram session creator (Task E3). Run this once
 * on your own machine (or anywhere with internet) to produce the
 * `TELEGRAM_SESSION` env string for the cloud server:
 *
 *   node scripts/make_session.js
 *
 * You need a free `api_id` + `api_hash` from https://my.telegram.org
 * (Apps -> API development tools) and a phone number you can receive a
 * login code on. The printed session string is the server's identity --
 * treat it like a password: only ever in the Render env var, never in the
 * repo. See docs/RUNBOOK.md.
 *
 * Imports grammJS via a file path into backend/node_modules (this script
 * lives outside backend/ on purpose -- it is a one-time human tool, not
 * shipped in the server image).
 */

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { TelegramClient } from '../backend/node_modules/telegram/index.js';
import { StringSession } from '../backend/node_modules/telegram/sessions/index.js';

const rl = readline.createInterface({ input, output });

async function ask(prompt) {
  const answer = await rl.question(prompt);
  return answer.trim();
}

const apiIdRaw = await ask('api_id (from my.telegram.org): ');
const apiId = Number(apiIdRaw);
if (!Number.isInteger(apiId) || apiId <= 0) {
  console.error('Invalid api_id. It is the numeric "api_id" from my.telegram.org.');
  process.exit(1);
}
const apiHash = await ask('api_hash (from my.telegram.org): ');
if (!/^[0-9a-f]{32}$/.test(apiHash)) {
  console.error('Invalid api_hash. It is the 32-hex "api_hash" from my.telegram.org.');
  process.exit(1);
}
const phoneNumber = await ask('phone number, international format (e.g. +27781234567): ');
if (!phoneNumber.startsWith('+') || phoneNumber.length < 8) {
  console.error('Invalid phone number. Use international format with leading +.');
  process.exit(1);
}

const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
  connectionRetries: 3,
});

await client.start({
  phoneNumber: () => phoneNumber,
  password: async () => {
    const pwd = await ask('2FA password (blank if you have none): ');
    if (!pwd) throw new Error('Two-step verification is enabled; the password is required.');
    return pwd;
  },
  phoneCode: async () => await ask('Login code sent to your phone: '),
  onError: (err) => console.error('login error:', err.message),
  firstCode: true,
});

const session = client.session.save();
console.log('\nLogged in successfully.');
console.log('\n--- TELEGRAM_SESSION (secret -- only for the Render env var) ---\n');
console.log(session);
console.log('\n--- end ---');
console.log('\nSanity check (channels your account can read):');
try {
  const me = await client.getMe();
  console.log(`  logged in as: ${me.username ?? me.firstName ?? me.id}`);
} catch (err) {
  console.log('  (could not resolve account, but session was created)');
}

await client.disconnect();
rl.close();
