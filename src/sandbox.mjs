// `raytrace sandbox`: cloud sandboxes, through RayTrace's API
// (https://api.raytracer.si; RAYTRACE_API_URL points elsewhere).
//
// The project is packed here, so files that must stay on this machine never
// leave it, then uploaded once; RayTrace creates an isolated sandbox from it
// that records its Claude Code sessions. Requests carry your `raytrace auth
// login` token; RAYTRACE_API_KEY overrides it for a server running without
// accounts (development).
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, join } from 'node:path';
import { accessToken, account, login } from './auth.mjs';
import { readConfig } from './config.mjs';
import { ask, interactive } from './prompt.mjs';

const say = (line = '') => console.log(line);
// What one project upload may be. RayTrace's API holds the dashboard's folder
// upload to the same numbers and checks them again; saying so here saves the upload.
const MIB = 1024 * 1024;
const MAX_FILE = 25 * MIB;      // any one file
const MAX_BYTES = 200 * MIB;    // all files, before compression
const MAX_FILES = 20_000;
const MAX_ARCHIVE = 100 * MIB;  // the packed upload
const ID = /^rtp-[a-f0-9]{32}$/;
const API = 'https://api.raytracer.si';
const unreachable = (url) => new Error(`Cannot reach RayTrace at ${url.origin}. Check your connection; `
  + 'networks that inspect HTTPS (some company Wi-Fi) may block it.');

// Never packed: version control, dependencies and build output (rebuilt in the
// sandbox), and files that usually hold credentials.
const EXCLUDED = new Set(['.git', '.raytace', '.raytrace', '.ssh', '.aws', '.azure', '.config', 'node_modules', '.venv',
  '__pycache__', '.next', '.vinext', 'dist', 'coverage', '.wrangler', '.DS_Store']);
const SECRET_NAMES = new Set(['.npmrc', '.netrc', '.pypirc', 'credentials', 'auth.json', 'id_rsa', 'id_ed25519']);
const SECRET_EXTENSIONS = /\.(pem|key|p12|pfx)$/i;

export function packable(path) {
  const parts = path.split('/');
  const name = parts.at(-1);
  return !parts.some((part) => EXCLUDED.has(part) || part === '..') && !path.startsWith('/')
    && !name.startsWith('.env') && !SECRET_EXTENSIONS.test(name) && !SECRET_NAMES.has(name);
}

async function api() {
  const config = readConfig();
  const url = process.env.RAYTRACE_API_URL || config.RAYTRACE_API_URL || API;
  let key = process.env.RAYTRACE_API_KEY || config.RAYTRACE_API_KEY || await accessToken();
  if (!key) {
    if (!interactive()) throw new Error('Not signed in. Run: raytrace auth login');
    say('You are not signed in to RayTrace yet.');
    await login();
    key = await accessToken();
    if (!key) throw new Error('Not signed in. Run: raytrace auth login');
    say();
  }
  return { url: new URL(url), key };
}

async function call(method, path, { body, headers = {} } = {}) {
  const { url, key } = await api();
  let response;
  try {
    response = await fetch(new URL(path, url), { method, body, headers: { authorization: `Bearer ${key}`, ...headers } });
  } catch {
    throw unreachable(url);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

/** The project's files git would track, minus what must not leave this machine. */
function projectFiles(root) {
  const listed = spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 256 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`${root} is not a Git repository. Run this from inside one.`);
  const files = []; const skipped = []; const large = []; let total = 0;
  for (const name of [...new Set(listed.stdout.toString().split('\0').filter(Boolean))].sort()) {
    let stat;
    try { stat = lstatSync(join(root, name)); } catch { continue; } // deleted, still in the index
    if (!packable(name) || !stat.isFile()) { skipped.push(name); continue; } // symlinks too
    if (stat.size > MAX_FILE) { large.push(`${name} (${Math.round(stat.size / MIB)} MiB)`); continue; }
    total += stat.size;
    files.push(name);
  }
  // Refused, never trimmed: a project missing its large files would not be the project.
  if (large.length) {
    throw new Error(`${large.length === 1 ? 'This file is' : 'These files are'} over ${MAX_FILE / MIB} MiB, the most one file may be:\n  `
      + `${large.slice(0, 10).join('\n  ')}${large.length > 10 ? `\n  ... and ${large.length - 10} more` : ''}\nAdd ${large.length === 1 ? 'it' : 'them'} to .gitignore (or remove ${large.length === 1 ? 'it' : 'them'}), then try again.`);
  }
  if (files.length > MAX_FILES) throw new Error(`The project has ${files.length.toLocaleString()} files; the most is ${MAX_FILES.toLocaleString()}. Add generated files to .gitignore first.`);
  if (total > MAX_BYTES) throw new Error(`The project is ${Math.round(total / MIB)} MiB; the most is ${MAX_BYTES / MIB} MiB. Add large generated files to .gitignore first.`);
  return { files, skipped, total };
}

function pack(root, files) {
  return new Promise((resolve, reject) => {
    // Extended attributes stay here: macOS tags nearly every file (com.apple.provenance),
    // and bsdtar would also add AppleDouble files for them.
    const mac = process.platform === 'darwin' ? ['--no-mac-metadata', '--no-xattrs'] : [];
    const tar = spawn('tar', ['-czf', '-', ...mac, '--no-recursion', '--null', '-T', '-'],
      { cwd: root, env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let error = '';
    tar.stdout.on('data', (chunk) => chunks.push(chunk));
    tar.stderr.on('data', (chunk) => { error += chunk; });
    tar.on('error', reject);
    tar.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar failed: ${error.trim()}`)));
    tar.stdin.end(files.map((name) => `${name}\0`).join(''));
  });
}

async function pickId(id) {
  if (id) {
    if (!ID.test(id)) throw new Error(`Not a sandbox id: ${id}`);
    return id;
  }
  const live = (await call('GET', '/v1/sandboxes')).filter((box) => box.status !== 'deleted');
  if (live.length === 1) return live[0].id;
  throw new Error(live.length ? 'More than one sandbox; name one (raytrace sandbox list).'
    : `No sandboxes${account() ? ` in ${account()}'s workspace` : ''} yet: raytrace sandbox create`);
}

export async function create(flags) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0) throw new Error('Run this from inside a Git repository.');
  const root = top.stdout.trim();
  const name = flags.name || basename(root);
  const { files, skipped, total } = projectFiles(root);
  if (!files.length) throw new Error('Nothing to upload.');
  say(`Packing ${files.length} files (${(total / 1048576).toFixed(1)} MiB) from ${root}`);
  if (skipped.length) say(`Not uploaded (${skipped.length}): ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? ', ...' : ''}`);
  const archive = await pack(root, files);
  if (archive.length > MAX_ARCHIVE) throw new Error(`The packed project is ${Math.round(archive.length / MIB)} MiB; the most is ${MAX_ARCHIVE / MIB} MiB.`);
  say('Creating the sandbox (the first one on a host takes a little longer)...');
  const box = await call('POST', '/v1/sandboxes', {
    body: archive, headers: { 'content-type': 'application/gzip', 'x-raytrace-name': name.replace(/[^A-Za-z0-9._ -]/g, '-').slice(0, 100) },
  });
  say(`\nSandbox ${box.id} is running.`);
  say(box.transcripts ? 'Claude Code sessions in it are recorded.'
    : `Claude Code transcripts are off: ${box.transcripts_off}. Commands are still recorded.`);
  say(`Open it:  raytrace connect ${box.id}`);
}

export async function list() {
  const boxes = (await call('GET', '/v1/sandboxes')).filter((box) => box.status !== 'deleted');
  if (!boxes.length) { say('No sandboxes. Create one from a Git repository: raytrace sandbox create'); return; }
  for (const box of boxes) {
    // The sandbox's creation time (seconds), or its container's once that is known.
    const created = typeof box.created === 'number' ? box.created * 1000 : Date.parse(box.created);
    const age = Math.round((Date.now() - created) / 60000);
    say(`${box.id}  ${String(box.status).padEnd(8)}  ${box.name}  (${age < 120 ? `${age} min` : `${Math.round(age / 60)} h`} old)`);
  }
}

export async function start(id) { const box = await call('POST', `/v1/sandboxes/${await pickId(id)}/start`); say(`${box.id} running`); }
export async function stop(id) { const box = await call('POST', `/v1/sandboxes/${await pickId(id)}/stop`); say(`${box.id} stopped; its files are kept`); }

export async function destroy(id, flags) {
  id = await pickId(id);
  if (!flags.yes) {
    if (!interactive()) throw new Error('Pass --yes to destroy without a prompt.');
    say(`This deletes ${id}: its files, and any sign-in made inside it. Recorded evidence is kept.`);
    if ((await ask('Type the sandbox id to confirm: ')) !== id) { say('Not destroyed.'); return; }
  }
  await call('DELETE', `/v1/sandboxes/${id}`);
  say(`${id} destroyed.`);
}

/** An interactive terminal in the sandbox, carried over one upgraded HTTP request.
 * `raytrace connect <id>` and `raytrace sandbox shell [id]` are the same thing. */
export async function shell(id) {
  if (!interactive()) throw new Error('Connecting to a sandbox needs a terminal.');
  id = await pickId(id);
  const { url, key } = await api();
  const { stdin, stdout } = process;
  const path = `/v1/sandboxes/${id}/shell?rows=${stdout.rows || 24}&cols=${stdout.columns || 80}`;
  await new Promise((resolve, reject) => {
    const target = new URL(path, url);
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(target, { headers: { authorization: `Bearer ${key}`, connection: 'Upgrade', upgrade: 'raytrace-shell' } });
    req.on('response', (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        // The API does not say whether another account has this sandbox; the likely mix-up is worth naming.
        if (response.statusCode === 404 && account()) {
          return reject(new Error(`No sandbox ${id} in ${account()}'s workspace. If it was made under another account `
            + '(for example in the dashboard), sign in as that one: raytrace auth login'));
        }
        try { reject(new Error(JSON.parse(text).error)); } catch { reject(new Error(`HTTP ${response.statusCode}`)); }
      });
    });
    req.on('upgrade', (_response, socket, head) => {
      say(`Connected to ${id}. Run \`claude\` (or codex) here; exit to leave. The sandbox keeps running.\n`);
      if (head.length) stdout.write(head);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.pipe(socket);
      socket.pipe(stdout);
      const done = () => { stdin.unpipe(socket); stdin.setRawMode(false); stdin.pause(); resolve(); };
      socket.on('close', done);
      socket.on('error', done);
    });
    req.on('error', () => reject(unreachable(url)));
    req.end();
  });
  say(`\nLeft ${id}. It is still running. Back in: raytrace connect ${id}   Stop it: raytrace sandbox stop ${id}`);
}
