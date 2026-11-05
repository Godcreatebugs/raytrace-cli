// `raytrace sandbox`: cloud sandboxes, through RayTrace's API
// (https://api.raytracer.si; RAYTRACE_API_URL points elsewhere), or with
// --local on this machine (local-sandbox.mjs). A local sandbox's id is
// recognised wherever an id is given, so connect/stop/destroy need no flag.
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
import { account } from './auth.mjs';
import { api, call, ApiError, unreachable } from './api.mjs';
import { betaStatus, formatCreditDeadline } from './beta.mjs';
import { ask, confirm, interactive } from './prompt.mjs';
import * as local from './local-sandbox.mjs';

const say = (line = '') => console.log(line);
// What one project upload may be. RayTrace's API holds the dashboard's folder
// upload to the same numbers and checks them again; saying so here saves the upload.
const MIB = 1024 * 1024;
const MAX_FILE = 25 * MIB;      // any one file
const MAX_BYTES = 200 * MIB;    // all files, before compression
const MAX_FILES = 20_000;
const MAX_ARCHIVE = 100 * MIB;  // the packed upload
const ID = /^rtp-[a-f0-9]{32}$/;

// Never packed: version control, dependencies and build output (rebuilt in the
// sandbox), and files that usually hold credentials.
const EXCLUDED = new Set(['.git', '.raytace', '.raytrace', '.ssh', '.aws', '.azure', '.config', '.claude', 'node_modules', '.venv',
  '__pycache__', '.next', '.vinext', 'dist', 'coverage', '.wrangler', '.DS_Store']);
const SECRET_NAMES = new Set([
  '.npmrc', '.netrc', '.pypirc', '.htpasswd', '.dockercfg', 'credentials', 'credentials.json', 'credentials.ini',
  'auth.json', 'service-account.json', 'service_account.json', 'serviceAccountKey.json',
  'client_secret.json', 'client_secrets.json', 'token.json', 'id_rsa', 'id_dsa', 'id_ecdsa',
  'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk', 'known_hosts',
]);
const SECRET_EXTENSIONS = /\.(pem|key|p12|pfx)$/i;

export function packable(path) {
  const parts = path.split('/');
  const name = parts.at(-1);
  const lower = name.toLowerCase();
  return !parts.some((part) => EXCLUDED.has(part) || part === '..') && !path.startsWith('/')
    && !lower.startsWith('.env') && !lower.startsWith('.secret')
    && !SECRET_EXTENSIONS.test(name) && !SECRET_NAMES.has(lower);
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

/** The signed-in workspace's cloud sandboxes, minus deleted ones. */
export async function liveSandboxes() {
  return (await call('GET', '/v1/sandboxes')).filter((box) => box.status !== 'deleted');
}

export function checkId(id) {
  if (!ID.test(id)) throw new Error(`Not a sandbox id: ${id}`);
  return id;
}

async function pickId(id) {
  if (id) return checkId(id);
  const live = await liveSandboxes();
  if (live.length === 1) return live[0].id;
  throw new Error(live.length ? 'More than one sandbox; name one (raytrace sandbox list).'
    : `No sandboxes${account() ? ` in ${account()}'s workspace` : ''} yet: raytrace sandbox create`);
}

/** The top of the Git repository holding `dir`, or null. */
export function repoRoot(dir = process.cwd()) {
  const top = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return top.status === 0 ? top.stdout.trim() : null;
}

/** The files of the repository at `root` that may be uploaded, checked against the limits. */
export function listProject(root) {
  const project = projectFiles(root);
  if (!project.files.length) throw new Error('Nothing to upload.');
  return project;
}

/** Pack listed files into the gzip archive a sandbox is created from. */
export async function packArchive(root, files) {
  const archive = await pack(root, files);
  if (archive.length > MAX_ARCHIVE) throw new Error(`The packed project is ${Math.round(archive.length / MIB)} MiB; the most is ${MAX_ARCHIVE / MIB} MiB.`);
  return archive;
}

/** What beta credit does for the next cloud sandbox: 'use' it, it has
 * 'expired' (unused, past its hard 3 days), or 'none'. Credit is consumed by
 * the first cloud sandbox created after redemption. An older backend (or no
 * entitlement) never blocks a plain one, so no answer means 'none'; the
 * create call surfaces any real auth/network failure. */
export async function creditPlan() {
  let beta;
  try { beta = await betaStatus(); } catch { return { plan: 'none', beta: null }; }
  const deadlinePassed = beta?.credit_expires_at && Date.parse(beta.credit_expires_at) <= Date.now();
  if (beta && !beta.sandbox_consumed && deadlinePassed && (beta.entitled || beta.credit_usd)) return { plan: 'expired', beta };
  if (beta?.entitled && !beta.sandbox_consumed) return { plan: 'use', beta };
  return { plan: 'none', beta };
}

/** Create a cloud sandbox from a packed project. A credit refusal comes back
 * as an ApiError (see isCreditRefusal) for the caller to decide on. */
export function upload(archive, name, useCredit) {
  const headers = { 'content-type': 'application/gzip', 'x-raytrace-name': name.replace(/[^A-Za-z0-9._ -]/g, '-').slice(0, 100) };
  return call('POST', '/v1/sandboxes', { body: archive, headers: useCredit ? { ...headers, 'x-raytrace-beta-credit': '1' } : headers });
}

/** The API refused the credit: 409 already used on another sandbox, 410 expired. */
export const isCreditRefusal = (error) => error instanceof ApiError && [409, 410].includes(error.status);

export async function create(flags) {
  const root = repoRoot();
  if (!root) throw new Error('Run this from inside a Git repository.');
  const name = flags.name || basename(root);
  // What the machine lacks is said before the project is read, and Lima fetched if agreed.
  const localName = flags.local ? local.sandboxName(flags, root) : null;
  if (flags.local) await local.preflight(flags, { confirm, interactive });
  const { files, skipped, total } = listProject(root);
  // The same files, packed the same way, as a cloud sandbox gets: only the copy stays here.
  if (flags.local) return local.create(localName, { root, files, skipped, total, archive: await pack(root, files) });

  // A local sandbox never uses beta credit.
  const { plan, beta } = await creditPlan();
  if (plan === 'expired') {
    say('Your $10 beta credit has expired: the 3 days ran out, and unused credit does not carry over.');
    if (!interactive()) throw new Error('Beta credit expired; no sandbox was created. Ask RayTrace for a new code to try again.');
    if (!(await confirm('Create a plain sandbox without beta credit?', false))) { say('Not created.'); return; }
  } else if (plan === 'use') {
    say(`Using your $${beta.credit_usd ?? 10} beta credit (OpenRouter) on this sandbox`
      + `${beta.credit_expires_at ? ` — credit ends ${formatCreditDeadline(beta.credit_expires_at)}` : ''}.`);
  }
  const useCredit = plan === 'use';
  say(`Packing ${files.length} files (${(total / 1048576).toFixed(1)} MiB) from ${root}`);
  if (skipped.length) say(`Not uploaded (${skipped.length}): ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? ', ...' : ''}`);
  const archive = await packArchive(root, files);
  say('Creating the sandbox (the first one on a host takes a little longer)...');
  let box;
  try {
    box = await upload(archive, name, useCredit);
  } catch (error) {
    if (!useCredit || !isCreditRefusal(error)) throw error;
    say(error.status === 410 ? 'Your beta credit expired before the sandbox was created.'
      : 'Your beta credit was already used on another sandbox.');
    if (!interactive() || !(await confirm('Create a plain sandbox without beta credit?', false))) {
      throw new Error('Beta credit not applied; no sandbox was created.');
    }
    box = await upload(archive, name, false);
  }
  say(`\nSandbox ${box.id} is running.`);
  if (box.credit_applied) {
    say(`Beta credit applied: $${box.credit_usd ?? 10} (OpenRouter)${box.credit_expires_at ? `, ends ${formatCreditDeadline(box.credit_expires_at)}` : ''}. This sandbox shows as Beta in the dashboard.`);
  }
  say(box.transcripts ? 'Claude Code sessions in it are recorded.'
    : `Claude Code transcripts are off: ${box.transcripts_off}. Commands are still recorded.`);
  say(`Open it:  raytrace connect ${box.id}`);
}

export async function list(flags = {}) {
  if (flags.local) return local.list();
  const boxes = await liveSandboxes();
  if (!boxes.length) { say('No sandboxes. Create one from a Git repository: raytrace sandbox create'); return; }
  for (const box of boxes) {
    // The sandbox's creation time (seconds), or its container's once that is known.
    const created = typeof box.created === 'number' ? box.created * 1000 : Date.parse(box.created);
    const age = Math.round((Date.now() - created) / 60000);
    const beta = box.beta ? `  Beta${typeof box.credit_usd === 'number' ? ` ($${Math.max(0, box.credit_usd - (box.credit_spent_usd ?? 0)).toFixed(2)} of $${box.credit_usd} left${box.credit_expires_at ? `, ends ${formatCreditDeadline(box.credit_expires_at)}` : ''})` : ''}` : '';
    say(`${box.id}  ${String(box.status).padEnd(8)}  ${box.name}${beta}  (${age < 120 ? `${age} min` : `${Math.round(age / 60)} h`} old)`);
  }
}

export async function start(id, flags = {}) {
  if (flags.local || local.isLocal(id)) return local.start(id);
  const box = await call('POST', `/v1/sandboxes/${await pickId(id)}/start`); say(`${box.id} running`);
}
export async function stop(id, flags = {}) {
  if (flags.local || local.isLocal(id)) return local.stop(id);
  const box = await call('POST', `/v1/sandboxes/${await pickId(id)}/stop`); say(`${box.id} stopped; its files are kept`);
}

export async function destroy(id, flags) {
  if (flags.local || local.isLocal(id)) return local.destroy(id, flags, { ask, interactive });
  id = await pickId(id);
  const me = await call('GET', '/v1/me').catch(() => ({}));
  const plan = me.plan ?? {};
  const paid = plan.plan && plan.plan !== 'beta';
  let keep = Boolean(flags['keep-traces']);
  if (!flags.yes) {
    if (!interactive()) throw new Error('Pass --yes to destroy without a prompt (with --yes, traces are deleted unless --keep-traces is passed).');
    say(`This deletes ${id}: its files, and any sign-in made inside it.`);
    if (!paid) say('Free does not keep traces after destroy: its recorded traces are deleted too.\nTo keep them, upgrade to Pro first: https://raytracer.si/pricing');
    if ((await ask('Type the sandbox id to confirm: ')) !== id) { say('Not destroyed.'); return; }
    if (paid && !keep) {
      keep = /^y(es)?$/i.test((await ask('Keep its traces until your retention date? They stay readable and count against your evidences storage. [y/N] ')).trim());
    }
  }
  const result = await call('DELETE', `/v1/sandboxes/${id}${keep ? '?keep_traces=1' : ''}`);
  say(`${id} destroyed.`);
  if (result.traces_kept) say(`Its traces are kept until ${new Date(result.traces_kept_until * 1000).toLocaleDateString()}.`);
  else if (result.traces_deleted === false) say('Note: its traces could not be deleted; they may still show on the dashboard.');
}

/** Exported for tests: the warning shown when connecting to a beta sandbox
 * whose 3 days are up, or null. Model calls inside are refused by the
 * backend; the sandbox itself still opens. */
export function betaExpiryWarning(beta, id, now = Date.now()) {
  if (!beta || beta.credited_sandbox_id !== id) return null;
  const deadline = beta.credit_expires_at ? Date.parse(beta.credit_expires_at) : NaN;
  if (!beta.expired && !(deadline <= now)) return null;
  return `Warning: your beta credit for this sandbox expired${beta.credit_expires_at ? ` (${formatCreditDeadline(beta.credit_expires_at, now)})` : ''}; `
    + 'model calls in this sandbox will be refused. The sandbox itself still opens.';
}

/** An interactive terminal in the sandbox, carried over one upgraded HTTP request.
 * `raytrace connect <id>` and `raytrace sandbox shell [id]` are the same thing. */
export async function shell(id, flags = {}) {
  if (!interactive()) throw new Error('Connecting to a sandbox needs a terminal.');
  // With no id and no cloud sign-in, the one local sandbox is the likely one.
  if (flags.local || local.isLocal(id) || (!id && Object.keys(local.registry()).length && !account())) return local.shell(id, { claude: flags.claude });
  id = await pickId(id);
  try {
    const warning = betaExpiryWarning(await betaStatus(), id);
    if (warning) say(warning);
  } catch { /* no beta answer: connecting must not depend on it */ }
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
      say(flags.claude ? `Connected to ${id}, starting Claude Code without permission prompts (the sandbox is what contains it); when it exits you are in the sandbox's shell. The sandbox keeps running.\n`
        : `Connected to ${id}. Run \`claude\` (or codex) here; exit to leave. The sandbox keeps running.\n`);
      if (head.length) stdout.write(head);
      // The API's shell takes no command: Claude Code is started by typing it, which the terminal holds until the shell reads it.
      if (flags.claude) socket.write('claude --dangerously-skip-permissions\r');
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
