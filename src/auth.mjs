// `raytrace auth`: sign in to RayTrace with WorkOS's device login.
//
// `login` asks WorkOS for a short code, opens the approval page, and polls
// until the code is approved. The tokens never touch a file in plain text:
// they go in the macOS Keychain or the Linux secret service, and only fall
// back to a file readable by you alone (with a warning) where neither exists.
// The client id is public by design: a CLI cannot keep a secret.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { paths } from './paths.mjs';

const say = (line = '') => console.log(line);
const WORKOS = 'https://api.workos.com/user_management';
export const CLIENT_ID = process.env.RAYTRACE_WORKOS_CLIENT_ID || 'client_01M4BC8GZZ9HG67EAV65SBRCPX';
const SERVICE = 'raytrace-cli';
const ACCOUNT = 'raytrace';
const FILE = join(paths.home, 'credentials.json');

// ------------------------------------------------------------- storage

function save(session) {
  const value = Buffer.from(JSON.stringify(session)).toString('base64');
  if (process.platform === 'darwin') {
    // `security -i` reads its command from stdin, so the token never shows in a process list.
    const result = spawnSync('security', ['-i'], { input: `add-generic-password -U -a ${ACCOUNT} -s ${SERVICE} -l "RayTrace CLI" -w ${value}\n`, encoding: 'utf8' });
    if (result.status === 0 && !/error/i.test(result.stderr)) return 'the macOS Keychain';
  } else if (spawnSync('secret-tool', ['--version']).status === 0) {
    const result = spawnSync('secret-tool', ['store', '--label=RayTrace CLI', 'service', SERVICE, 'account', ACCOUNT], { input: value });
    if (result.status === 0) return 'the system keyring';
  }
  mkdirSync(paths.home, { recursive: true });
  writeFileSync(FILE, value, { mode: 0o600 });
  chmodSync(FILE, 0o600);
  return `${FILE} (no keychain found; readable only by you)`;
}

function load() {
  let value = '';
  if (process.platform === 'darwin') {
    const result = spawnSync('security', ['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w'], { encoding: 'utf8' });
    if (result.status === 0) value = result.stdout.trim();
  } else if (spawnSync('secret-tool', ['--version']).status === 0) {
    const result = spawnSync('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT], { encoding: 'utf8' });
    if (result.status === 0) value = result.stdout.trim();
  }
  if (!value && existsSync(FILE)) value = readFileSync(FILE, 'utf8').trim();
  if (!value) return null;
  try { return JSON.parse(Buffer.from(value, 'base64').toString('utf8')); } catch { return null; }
}

function forget() {
  if (process.platform === 'darwin') spawnSync('security', ['delete-generic-password', '-a', ACCOUNT, '-s', SERVICE]);
  else if (spawnSync('secret-tool', ['--version']).status === 0) spawnSync('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT]);
  rmSync(FILE, { force: true });
}

// ------------------------------------------------------------- tokens

/** The access token's claims, read without verifying: RayTrace's API verifies. */
function claims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

async function workos(path, form) {
  const response = await fetch(`${WORKOS}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

function keep(data) {
  return {
    access_token: data.access_token, refresh_token: data.refresh_token,
    user: { id: data.user?.id, email: data.user?.email, name: [data.user?.first_name, data.user?.last_name].filter(Boolean).join(' ') },
    organization_id: data.organization_id ?? null,
  };
}

/** A current access token, refreshed when it is about to expire; null when signed out. */
export async function accessToken() {
  const session = load();
  if (!session?.access_token) return null;
  const { exp = 0 } = claims(session.access_token);
  if (exp * 1000 - Date.now() > 60_000) return session.access_token;
  if (!session.refresh_token) return null;
  const { status, data } = await workos('/authenticate', {
    grant_type: 'refresh_token', refresh_token: session.refresh_token, client_id: CLIENT_ID,
    ...(session.organization_id ? { organization_id: session.organization_id } : {}),
  });
  if (status !== 200 || !data.access_token) {
    throw new Error(`Your RayTrace sign-in expired and could not be renewed (${data.error_description || data.error || data.message || `HTTP ${status}`}). Run: raytrace auth login`);
  }
  save(keep(data));
  return data.access_token;
}

// ------------------------------------------------------------- commands

function openUrl(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

export async function login() {
  const start = await workos('/authorize/device', { client_id: CLIENT_ID });
  if (start.status !== 200 || !start.data.device_code) {
    throw new Error(`WorkOS refused to start the sign-in: ${start.data.error_description || start.data.message || `HTTP ${start.status}`}`);
  }
  const { device_code, user_code, verification_uri, verification_uri_complete } = start.data;
  let interval = (start.data.interval || 5) * 1000;
  const deadline = Date.now() + (start.data.expires_in || 300) * 1000;
  say(`Your sign-in code: ${user_code}`);
  say(`Opening ${verification_uri} to approve it (or open it yourself on any device).`);
  openUrl(verification_uri_complete || verification_uri);
  say('Waiting for approval...');
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const { status, data } = await workos('/authenticate', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code, client_id: CLIENT_ID,
      device_id: hostname().slice(0, 100),
    });
    if (status === 200 && data.access_token) {
      const where = save(keep(data));
      say(`\nSigned in as ${data.user?.email}. Your sign-in is kept in ${where}.`);
      return;
    }
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { interval += 5000; continue; }
    if (data.error === 'access_denied') throw new Error('The sign-in was declined.');
    if (data.error === 'expired_token') break;
    throw new Error(`Sign-in failed: ${data.error_description || data.error || `HTTP ${status}`}`);
  }
  throw new Error('The code expired before it was approved. Run raytrace auth login again.');
}

export async function status() {
  const session = load();
  if (!session) { say('Not signed in. Run: raytrace auth login'); return; }
  const { exp = 0, org_id: org } = claims(session.access_token);
  say(`Signed in as ${session.user?.email}${session.user?.name ? ` (${session.user.name})` : ''}`);
  say(`Organization: ${org || session.organization_id || 'personal'}`);
  const left = Math.round((exp * 1000 - Date.now()) / 60000);
  say(left > 0 ? `Access token valid for ${left} more min; renewed automatically.` : 'Access token expired; it is renewed on the next command.');
}

export async function logout() {
  if (!load()) { say('Not signed in.'); return; }
  forget();
  say('Signed out: your RayTrace sign-in was removed from this machine.');
}
