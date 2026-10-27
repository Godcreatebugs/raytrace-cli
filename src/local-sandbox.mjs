// `raytrace sandbox … --local`: sandboxes on this machine, in a Lima Linux VM.
//
// Your project never leaves the machine. The VM runs each sandbox as a Docker
// container under gVisor; the collector beside it (worker/sandbox) records the
// commands, files and connections it makes, independently of the agent, and the
// evidence viewer shows them on http://localhost:8798. The sandbox's Claude Code
// hook sends its transcript to this CLI's proxy through the sandbox bridge
// (proxy/sandbox-bridge.mjs), so its sessions show in the local dashboard.
//
// Lima picks the VM type for the host: macOS and Linux work; Windows is
// experimental. Sign in to Claude Code or Codex inside the sandbox: no key is
// passed in from here.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { paths } from './paths.mjs';
import { portInUse, runningPid, start as startProxy, stop as stopProxy } from './proxy-process.mjs';
import { readConfig } from './config.mjs';
import { LIMA_VERSION, canDownload, checks, downloadLima, findLima } from './lima.mjs';

const say = (line = '') => console.log(line);
const VM = 'raytrace';
const ID = /^rtp-[a-f0-9]{32}$/;
// How a local sandbox is named on the command line: unique among them.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SOURCE = join(paths.root, 'worker', 'sandbox');
const HOOK = join(SOURCE, 'claude-hook.mjs');
const REGISTRY = join(paths.home, 'sandboxes.json');
// Where the proxy keeps each sandbox's copy of its Claude Code transcripts,
// and where the first local sandboxes' bridge kept them.
const transcripts = (id) => join(paths.home, 'claude-code', id);
const earlierTranscripts = (id) => join(paths.home, 'sandboxes', id, 'claude');
// Logs kept when a sandbox is destroyed without them.
const ARCHIVE = join(paths.home, 'archive');
// What the VM's setup was last run from; a CLI upgrade that changes it runs setup again.
const SETUP_MARK = '/etc/raytace/cli-setup';
// Lima's and the VM setup's own output, which is long: shown only when a step fails.
const VM_LOG = join(paths.logs, 'sandbox-vm.log');

/** Local sandboxes this CLI made: id → {name, root, token, created}. */
export function registry() {
  try { return JSON.parse(readFileSync(REGISTRY, 'utf8')); } catch { return {}; }
}
function save(boxes) {
  mkdirSync(paths.home, { recursive: true });
  writeFileSync(REGISTRY, `${JSON.stringify(boxes, null, 2)}\n`, { mode: 0o600 });
}
const byName = (boxes, name) => Object.keys(boxes).find((id) => boxes[id].name === name);
/** Whether a sandbox id or name is one of this machine's local sandboxes. */
export const isLocal = (ref) => Boolean(ref && (registry()[ref] || byName(registry(), ref)));

let lima = null;
/** The limactl to run: the user's own Lima, or the one RayTrace downloaded. */
function limactlBinary() {
  lima ??= findLima()?.binary;
  if (!lima) throw new Error('Lima is not set up. `raytrace sandbox create --local` sets it up; `raytrace doctor` says what is missing.');
  return lima;
}

const tail = (file, lines = 25) => { try { return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n'); } catch { return ''; } };

/**
 * Runs limactl. `inherit` gives it the terminal (a shell); `log` sends its
 * output to the VM log instead, and on failure shows the log's last lines.
 */
function limactl(args, { input, inherit = false, log = false, check = true } = {}) {
  let fd = null;
  if (log) {
    mkdirSync(paths.logs, { recursive: true });
    fd = openSync(VM_LOG, 'a');
    writeFileSync(fd, `\n=== ${new Date().toISOString()} limactl ${args.join(' ')} ===\n`);
  }
  let result;
  try {
    result = spawnSync(limactlBinary(), args, {
      input, stdio: inherit ? 'inherit' : [input === undefined ? 'ignore' : 'pipe', fd ?? 'pipe', fd ?? 'pipe'],
      encoding: inherit || log ? undefined : 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
  } finally { if (fd !== null) closeSync(fd); }
  if (result.error) throw result.error;
  if (check && result.status !== 0) {
    const detail = log ? `${tail(VM_LOG)}\n(full log: ${VM_LOG})` : String(result.stderr ?? '').trim().split('\n').slice(-6).join('\n');
    throw new Error(`limactl ${args[0]} failed${detail ? `:\n${detail}` : ''}`);
  }
  return result;
}

/** A command in the VM as root: projects.py and setup.py run there. */
const inVm = (args, options) => limactl(['shell', '--workdir', '/', VM, 'sudo', ...args], options);
const projects = (args, options) => inVm(['python3', '/opt/raytace/projects.py', ...args], options);

/** Removes the RayTrace VM and every local sandbox in it; false when there was none. */
export function deleteVm() {
  if (!findLima()?.binary || !vmStatus()) return false;
  limactl(['delete', '--force', VM], { log: true });
  return true;
}

export function vmStatus() {
  const listed = limactl(['list', '--format', '{{.Name}} {{.Status}}']).stdout;
  const line = listed.split('\n').find((row) => row.split(' ')[0] === VM);
  return line ? line.split(' ')[1] : null;
}

function setupVersion() {
  const hash = createHash('sha256');
  for (const name of readdirSync(SOURCE).sort()) hash.update(name).update(readFileSync(join(SOURCE, name)));
  return hash.digest('hex').slice(0, 16);
}

/** The VM up, with gVisor, the collector and the sandbox image as this CLI ships them. */
function ensureVm() {
  const status = vmStatus();
  if (!status) {
    say(`Creating the RayTrace VM "${VM}" (first time only: it downloads Ubuntu, a few minutes)...`);
    limactl(['start', '--name', VM, '--tty=false', join(SOURCE, 'lima.yaml')], { log: true });
  } else if (status !== 'Running') {
    say(`Starting the RayTrace VM "${VM}"...`);
    limactl(['start', '--tty=false', VM], { log: true });
  }
  const version = setupVersion();
  const installed = inVm(['cat', SETUP_MARK], { check: false }).stdout?.trim();
  if (installed === version) return;
  say(`Installing gVisor, the evidence collector and the sandbox image in the VM (a few minutes; progress in ${VM_LOG})...`);
  inVm(['rm', '-rf', '/tmp/raytrace-sandbox-source']);
  limactl(['shell', '--workdir', '/', VM, 'mkdir', '-p', '/tmp/raytrace-sandbox-source']);
  limactl(['copy', '-r', `${SOURCE}/.`, `${VM}:/tmp/raytrace-sandbox-source/`]);
  inVm(['python3', '/tmp/raytrace-sandbox-source/setup.py'], { log: true });
  inVm(['sh', '-c', `echo ${version} > ${SETUP_MARK}`]);
}

/** Transcripts reach the dashboard through the proxy's sandbox bridge. */
async function ensureBridge() {
  try { await startProxy(); } catch (error) {
    say(`Note: the RayTrace proxy did not start (${error.message.split('\n')[0]}). `
      + 'Commands are still recorded in the VM; Claude Code transcripts reach the dashboard once `raytrace start` works.');
    return;
  }
  // A proxy from before local sandboxes is reused as it is, and has no bridge.
  if (!(await portInUse(Number(readConfig().RAYTRACE_BRIDGE_PORT || 8799)))) {
    say('Note: the running RayTrace proxy has no sandbox bridge (it predates local sandboxes). '
      + 'Restart it so Claude Code sessions reach the dashboard: raytrace stop && raytrace start');
  }
}

/**
 * Before anything is packed or started: what this machine lacks for a local
 * sandbox, each with its fix, and Lima downloaded if the user agrees.
 */
export async function preflight(flags, { confirm, interactive }) {
  let vmRunning = false;
  try { vmRunning = Boolean(findLima()?.binary) && vmStatus() === 'Running'; } catch { /* reported below */ }
  const rows = await checks({ vmRunning });
  for (const { ok, label, detail } of rows) if (ok === null && label !== 'lima') say(`Note (${label}): ${detail}`);
  const failed = rows.filter((row) => row.ok === false);
  if (failed.length) {
    throw new Error(`This machine is not ready for local sandboxes:\n${failed.map((row) => `  ${row.label}: ${row.detail}${row.fix ? `\n    fix: ${row.fix}` : ''}`).join('\n')}`);
  }
  if (findLima()?.binary) return;
  if (!canDownload()) throw new Error('Local sandboxes need Lima: https://lima-vm.io/docs/installation/');
  const question = `Local sandboxes run in a Linux VM made with Lima (open source, Apache-2.0), which is not installed. `
    + `Download Lima ${LIMA_VERSION} (about 25-40 MB) into ${join(paths.home, 'lima')}? No admin rights needed.`;
  if (!flags.yes) {
    if (!interactive()) throw new Error(`${question}\nRun again with --yes to download it, or install Lima yourself: https://lima-vm.io/docs/installation/`);
    if (!(await confirm(question, true))) throw new Error('Not downloaded. Install Lima yourself to use local sandboxes: https://lima-vm.io/docs/installation/');
  }
  lima = (await downloadLima(say)).binary;
}

/** A local sandbox's id, from its id or name; with neither, the only one there is. */
function pickId(ref) {
  const boxes = registry();
  if (ref) {
    const id = boxes[ref] ? ref : byName(boxes, ref);
    if (!id) throw new Error(`No local sandbox named ${ref}: raytrace sandbox list --local`);
    return id;
  }
  const ids = Object.keys(boxes);
  if (ids.length === 1) return ids[0];
  throw new Error(ids.length ? 'More than one local sandbox; name one (raytrace sandbox list --local).'
    : 'No local sandboxes yet: raytrace sandbox create --local');
}

/** The new sandbox's name: --name, or the repository folder's; unique among local sandboxes. */
export function sandboxName(flags, root) {
  const name = flags.name ?? basename(root).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);
  if (!NAME.test(name)) throw new Error(`"${name}" cannot be a sandbox name: use letters, digits, dot, dash and underscore (up to 64), starting with a letter or digit.`);
  if (byName(registry(), name)) throw new Error(`There is already a local sandbox named ${name}. Pick another with --name, or destroy that one: raytrace sandbox destroy ${name}`);
  return name;
}

export async function create(name, { root, files, skipped, total, archive }) {
  ensureVm();
  const id = `rtp-${randomBytes(16).toString('hex')}`;
  const token = randomBytes(32).toString('base64url');
  say(`Copying ${files.length} files (${(total / 1048576).toFixed(1)} MiB) from ${root} into a new sandbox`);
  if (skipped.length) say(`Left out (${skipped.length}): ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? ', ...' : ''}`);
  projects(['create', id, '--archive', '-'], { input: archive });
  // Recorded before anything else can fail, so destroy can always find it.
  save({ ...registry(), [id]: { name, root, token, created: new Date().toISOString() } });
  projects(['start', id]);
  projects(['enable-claude', id], { input: readFileSync(HOOK) });
  projects(['set-token', id], { input: token });
  await ensureBridge();
  say(`\nLocal sandbox ${name} (${id}) is running.`);
  say('Claude Code sessions in it go to your local dashboard; commands, files and connections are recorded in the VM.');
  say(`Open it:  raytrace connect ${name}`);
}

export async function list() {
  const boxes = registry();
  if (!Object.keys(boxes).length) { say('No local sandboxes. Create one from a Git repository: raytrace sandbox create --local'); return; }
  const running = vmStatus() === 'Running';
  const states = running ? Object.fromEntries(JSON.parse(projects(['list']).stdout || '[]').map((box) => [box.id, box.status])) : {};
  for (const [id, box] of Object.entries(boxes)) {
    const age = Math.round((Date.now() - Date.parse(box.created)) / 60000);
    const status = running ? (states[id] === 'running' ? 'running' : states[id] ? 'stopped' : 'missing') : 'stopped';
    say(`${box.name.padEnd(20)}  ${status.padEnd(8)}  ${id}  (${age < 120 ? `${age} min` : `${Math.round(age / 60)} h`} old, local)`);
  }
  if (!running) say(`\nThe RayTrace VM is stopped; \`raytrace sandbox start <name>\` starts it.`);
}

export async function start(id) {
  id = pickId(id);
  ensureVm();
  projects(['start', id]);
  await ensureBridge();
  say(`${registry()[id].name} running`);
}

export async function stop(id) {
  id = pickId(id);
  if (vmStatus() === 'Running') projects(['stop', id]);
  say(`${registry()[id].name} stopped; its files are kept`);
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** The sandbox's Claude Code session ids, from the bridge's transcript copies. */
function sessionIds(id) {
  const listed = (folder) => { try { return readdirSync(folder).filter((file) => file.endsWith('.jsonl')).map((file) => file.slice(0, -6)); } catch { return []; } };
  return [...listed(transcripts(id)), ...listed(earlierTranscripts(id))];
}

/**
 * Deletes a local sandbox, and asks about the logs captured in it: deleted
 * with it, or moved to ~/.raytrace/archive/<name>-<time>/ (the Claude Code
 * transcripts and the VM's command, file and network evidence), staying in
 * the dashboard. --delete-logs / --keep-logs answer without asking; without a
 * terminal and neither flag, the logs are kept.
 */
export async function destroy(ref, flags, { ask, interactive }) {
  const id = pickId(ref);
  const box = registry()[id];
  if (!flags.yes) {
    if (!interactive()) throw new Error('Pass --yes to destroy without a prompt.');
    say(`This deletes local sandbox ${box.name}: its files, and any sign-in made inside it.`);
    if ((await ask('Type the sandbox name to confirm: ')) !== box.name) { say('Not destroyed.'); return; }
  }
  let deleteLogs = flags['delete-logs'] ? true : flags['keep-logs'] ? false : null;
  if (deleteLogs === null) {
    deleteLogs = interactive()
      && /^y(es)?$/i.test((await ask('Also delete the logs captured in this sandbox? (yes/no) [no]: ')).trim());
  }

  ensureVm();
  const inVmNow = JSON.parse(projects(['list']).stdout || '[]');
  const exists = inVmNow.some((item) => item.id === id);
  // Its Playground forks, which are sandboxes of their own in the VM.
  const forks = inVmNow.filter((item) => item.fork_of === id).map((item) => item.id);
  // Stopped first: stopping is recorded too, and must not land after the logs are dealt with.
  if (exists) projects(['stop', id]);
  if (deleteLogs) {
    // Its sessions are filed under its id; ones recorded before that, under their own.
    const { openEvidenceStore } = await import('../proxy/evidence-store.mjs');
    const store = openEvidenceStore(paths.database);
    try { store.forgetSessions([id, ...sessionIds(id)]); } finally { store.close(); }
    rmSync(transcripts(id), { recursive: true, force: true });
    rmSync(join(paths.home, 'sandboxes', id), { recursive: true, force: true });
  } else {
    const folder = join(ARCHIVE, `${box.name}-${stamp()}`);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const { token, ...about } = box;
    writeFileSync(join(folder, 'sandbox.json'), `${JSON.stringify({ id, ...about, destroyed: new Date().toISOString() }, null, 2)}\n`);
    if (exists) writeFileSync(join(folder, 'runtime-evidence.jsonl'), projects(['evidence', id]).stdout);
    for (const from of [transcripts(id), earlierTranscripts(id)]) {
      if (existsSync(from)) { renameSync(from, join(folder, 'claude-code')); break; }
    }
    // Forks' transcripts are filed under their own ids; their recorded
    // commands are already in the dashboard, with the forks themselves.
    for (const fork of forks) {
      if (!existsSync(transcripts(fork))) continue;
      mkdirSync(join(folder, 'forks'), { recursive: true, mode: 0o700 });
      renameSync(transcripts(fork), join(folder, 'forks', fork));
    }
    rmSync(join(paths.home, 'sandboxes', id), { recursive: true, force: true });
    say(`Logs moved to ${folder}`);
    say('Its Claude Code sessions stay in your dashboard.');
  }
  // The VM's record of it goes either way: deleted, or by now in the archive.
  for (const fork of forks) projects(['fork-delete', fork, '--forget-evidence']);
  if (deleteLogs) for (const fork of forks) rmSync(transcripts(fork), { recursive: true, force: true });
  if (exists) projects(['delete', id, '--confirm', id, '--forget-evidence']);
  const boxes = registry();
  delete boxes[id];
  save(boxes);
  say(`${box.name} destroyed${forks.length ? `, with its ${forks.length} Playground fork${forks.length === 1 ? '' : 's'}` : ''}${deleteLogs ? ', and its logs' : ''}.`);
  // The proxy keeps the Playground's forks in memory: one this CLI started is
  // restarted, so the forks just deleted are not listed any more.
  if (deleteLogs && forks.length && runningPid()) { await stopProxy(); await startProxy(); }
}

/** A terminal in the sandbox, through the VM. Leaving it keeps the sandbox running. */
export async function shell(id) {
  id = pickId(id);
  ensureVm();
  await ensureBridge();
  const { name } = registry()[id];
  say(`Connected to ${name}. Run \`claude\` (or codex) here; exit to leave. The sandbox keeps running.`);
  say('Recorded commands, files and connections: http://localhost:8798\n');
  projects(['shell', id], { inherit: true, check: false });
  say(`\nLeft ${name}. It is still running. Back in: raytrace connect ${name}   Stop it: raytrace sandbox stop ${name}`);
}
