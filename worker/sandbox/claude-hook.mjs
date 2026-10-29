#!/usr/bin/env node
/**
 * Claude Code hook inside a RayTrace sandbox. projects.py enable-claude
 * installs it root-owned with a managed-settings file, so the agent can
 * neither edit nor turn it off.
 *
 * PreToolUse (Bash): starts the command with `export RAYTRACE_CALL_ID=<the
 * tool call's id>`. The shell carries the id in its argv and every program it
 * starts carries it in its environment, where the gVisor collector reads it
 * (collector.py MARKER_KEYS): the evidence joins the call exactly instead of
 * by command text.
 *
 * PreToolUse (a file tool): refuses an edit to a file the project's owner
 * restricted (the list projects.py guardrails() writes beside this script),
 * saying why. From the sandbox's next start the file is locked on the host
 * as well, which is what stops every other way of writing it.
 *
 * An attempt on a file the owner restricted or watches (an edit refused, a
 * read, a command naming it) is queued as one line in /tmp/raytace-claude and
 * goes to RayTrace as `events` with the next send: nothing is sent from here
 * before a tool runs, so a refusal is as fast as before. The owner is told.
 *
 * PostToolUse (a tool that can change files) and UserPromptSubmit: snapshots
 * the project folder, so the lab can later put it back exactly as it was at
 * any step. See snapshot() below.
 *
 * Every other event, and those two after their snapshot: sends the
 * transcript's new whole lines, and the snapshot taken, to RayTrace through
 * the RayTrace CLI's sandbox bridge on the host -- the only host service this
 * sandbox can reach -- with the sandbox's token. How far it got is kept in /tmp; if that is lost,
 * RayTrace answers 409 with the size of its copy and sending resumes from
 * there.
 *
 * Never blocks or fails Claude Code: RayTrace being down means no capture.
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmdirSync, statSync, lstatSync, readdirSync, readlinkSync, existsSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

// The RayTrace CLI's sandbox bridge on the host, as projects.py set it on this
// sandbox (Lima's address for the host when unset).
const BROKER = `${process.env.RAYTRACE_BROKER || 'http://192.168.5.2:8799'}/raytace/ingest/claude-code`;
const CHUNK = 512 * 1024; // even worst-case JSON escaping stays under 4 MiB
const home = process.env.HOME || '/home/node';

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }

const workspace = process.env.RAYTRACE_WORKSPACE || '/workspace';
const STATE_DIR = '/tmp/raytace-claude';
const MAX_QUEUED_BYTES = 128 * 1024;

// The owner's lists (projects.py guardrails()): `restricted` is refused,
// `watched` is reported. Nothing listed when the file is absent or unreadable.
const listed = (value) => (Array.isArray(value) ? value.filter((file) => typeof file === 'string' && file) : []);
let restricted = [];
let watched = [];
try {
  const lists = JSON.parse(readFileSync(new URL('./guardrails.json', import.meta.url), 'utf8'));
  restricted = listed(lists.restricted);
  watched = listed(lists.watched);
} catch { /* nothing is restricted or watched */ }

/** A file the tool named, relative to the project; null when it is outside it. */
const inside = (named) => {
  if (typeof named !== 'string' || !named) return null;
  const path = resolve(input.cwd || workspace, named);
  return path.startsWith(`${workspace}/`) ? path.slice(workspace.length + 1) : null;
};

/** One line for the next send; never throws and never waits on the network. */
function queue(event) {
  try {
    if (!/^[0-9a-f-]{36}$/.test(input.session_id ?? '')) return;
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const file = join(STATE_DIR, `${input.session_id}.events.jsonl`);
    try { if (statSync(file).size > MAX_QUEUED_BYTES) return; } catch { /* none yet */ }
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), call_id: input.tool_use_id ?? null, tool: input.tool_name, ...event })}\n`, { mode: 0o600 });
  } catch { /* never disturb Claude Code */ }
}

if (input.hook_event_name === 'PreToolUse') {
  const named = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (input.tool_name !== 'Bash' && typeof named === 'string') {
    const path = inside(named);
    if (path && restricted.includes(path)) {
      queue({ kind: 'blocked', path });
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: `RayTrace: ${path} is restricted by this project's owner and cannot be changed. `
          + 'Do not try another way to write it; tell the user it has to be unlocked under Initial scan in the RayTrace dashboard.' } }));
    }
    process.exit(0);
  }
  const id = input.tool_use_id;
  const command = input.tool_input?.command;
  // A command that names a restricted file is reported, not stopped: the text
  // says what it mentions, not what it does. The file lock is what stops it.
  if (input.tool_name === 'Bash' && typeof command === 'string') {
    for (const path of restricted.slice(0, 200)) if (command.includes(path)) queue({ kind: 'named', path });
  }
  if (input.tool_name === 'Bash' && /^[A-Za-z0-9_-]{1,128}$/.test(id ?? '') && typeof command === 'string') {
    // An input change needs a decision with it. Only a session that already
    // skips permission prompts gets "allow"; any other still asks as usual,
    // unless running in headless/CI agent mode with RAYTRACE_ALLOW_ALL=1.
    const allowAll = process.env.RAYTRACE_ALLOW_ALL === '1' || process.env.RAYTRACE_ALLOW_ALL === 'true';
    const decision = (input.permission_mode === 'bypassPermissions' || allowAll) ? 'allow' : 'ask';
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision,
      updatedInput: { ...input.tool_input, command: `export RAYTRACE_CALL_ID=${id}\n${command}` } } }));
  }
  process.exit(0);
}

// ---------------------------------------------------------------- snapshots
// A separate git history of /workspace, kept in the sandbox's home: never the
// project's own git, and blind to the project's .gitignore (-f), so ignored
// and never-committed files are captured too. Only SKIPPED folders (large,
// regenerable) and files over MAX_FILE are left out; those are listed on the
// snapshot so a restore can say it is not exact. Unchanged content is stored
// once, so a step that changed nothing costs nothing and is not committed.
// It sits beside the agent, not above it: the agent could alter it, so it is
// a lab tool, not evidence.
const WORKSPACE = process.env.RAYTRACE_WORKSPACE || '/workspace';
const STORE = join(home, '.raytace', 'snapshots.git');
const SKIPPED = ['node_modules', '.git', '.next', '.vinext', 'dist', 'build', 'out', 'coverage', '.cache', '.turbo',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', 'target', '.gradle', '.wrangler'];
const MAX_FILE = 5 * 1024 * 1024;
const MAX_LISTED = 300;
// Tools that only read. Anything else, including tools this list has never
// heard of, is assumed able to change files.
const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'ToolSearch',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'BashOutput', 'KillShell', 'ExitPlanMode', 'AskUserQuestion']);

/** Folders below /workspace with their own .git (a clone, or `git init` in
 * a subfolder), outermost only. */
function nestedRepositories() {
  const found = [];
  const walk = (relative) => {
    for (const entry of readdirSync(relative ? join(WORKSPACE, relative) : WORKSPACE, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIPPED.includes(entry.name)) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (existsSync(join(WORKSPACE, path, '.git'))) found.push(path); else walk(path);
    }
  };
  walk('');
  return found;
}

/**
 * `git add` records a nested repository as a pointer to it, not its files,
 * and refuses the whole add while it has no commit yet, so nested ones are
 * kept out of the add and their files written into the snapshot directly:
 * re-read in full each time (no change detection, so a very large nested
 * repository makes snapshots slow). Returns the paths left out for size.
 */
function addNestedRepositories(git, nested) {
  const tooBig = [];
  // A folder whose names, sizes and times match last time is left as the
  // index already has it: re-reading it costs several git calls per snapshot.
  const seenFile = join(STORE, 'raytrace-nested.json');
  let seen = {};
  try { seen = JSON.parse(readFileSync(seenFile, 'utf8')); } catch { /* none yet */ }
  const now = {};
  for (const folder of nested) {
    const files = [];
    const walk = (relative) => {
      for (const entry of readdirSync(join(WORKSPACE, relative), { withFileTypes: true })) {
        const path = `${relative}/${entry.name}`;
        if (entry.isDirectory()) { if (!SKIPPED.includes(entry.name)) walk(path); continue; }
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        const info = lstatSync(join(WORKSPACE, path));
        if (entry.isFile() && info.size > MAX_FILE) { tooBig.push(path); continue; }
        files.push({ path, mode: entry.isSymbolicLink() ? '120000' : info.mode & 0o111 ? '100755' : '100644', size: info.size, time: info.mtimeMs });
      }
    };
    walk(folder);
    now[folder] = JSON.stringify(files.map(({ path, mode, size, time }) => [path, mode, size, time]));
    if (seen[folder] === now[folder]) continue;
    git('rm', '-q', '-r', '--cached', '--ignore-unmatch', '--', folder);
    if (!files.length) continue;
    // Symbolic links are stored as their target, the way git stores them.
    const hashes = [];
    for (const file of files) {
      hashes.push(file.mode === '120000'
        ? execFileSync('git', ['hash-object', '-w', '--stdin'], { env: { ...process.env, GIT_DIR: STORE }, input: readlinkSync(join(WORKSPACE, file.path)), encoding: 'utf8' }).trim()
        : null);
    }
    const regular = files.filter((file, index) => !hashes[index]);
    const hashed = regular.length ? execFileSync('git', ['hash-object', '-w', '--no-filters', '--stdin-paths'],
      { cwd: WORKSPACE, env: { ...process.env, GIT_DIR: STORE }, input: regular.map((file) => file.path).join('\n'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n') : [];
    let next = 0;
    const lines = files.map((file, index) => `${file.mode} ${hashes[index] ?? hashed[next++]}\t${file.path}`);
    execFileSync('git', ['update-index', '--add', '--index-info'], { cwd: WORKSPACE, env: { ...process.env, GIT_DIR: STORE, GIT_WORK_TREE: WORKSPACE }, input: lines.join('\n') + '\n' });
  }
  writeFileSync(seenFile, JSON.stringify(now));
  return tooBig;
}

function snapshot(takenOn, callId) {
  const env = { ...process.env, GIT_DIR: STORE, GIT_WORK_TREE: WORKSPACE, GIT_AUTHOR_NAME: 'RayTrace', GIT_AUTHOR_EMAIL: 'snapshots@raytrace.local',
    GIT_COMMITTER_NAME: 'RayTrace', GIT_COMMITTER_EMAIL: 'snapshots@raytrace.local', GIT_TERMINAL_PROMPT: '0' };
  const git = (...args) => execFileSync('git', args, { cwd: WORKSPACE, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  // Tools that run at once snapshot one at a time; a lock older than 30s was
  // left by a hook that died.
  const lock = `${STORE}.lock`;
  const deadline = Date.now() + 4000;
  mkdirSync(join(home, '.raytace'), { recursive: true, mode: 0o700 });
  for (;;) {
    try { mkdirSync(lock); break; } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() > deadline) return null;
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { rmdirSync(lock); continue; } } catch { continue; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    if (!existsSync(STORE)) {
      git('init', '-q');
      git('config', 'core.autocrlf', 'false');
    }
    const nested = nestedRepositories();
    // A folder that was a nested repository last time and is not now (gone,
    // or its .git removed) goes back to `git add` like any other folder.
    try {
      for (const folder of Object.keys(JSON.parse(readFileSync(join(STORE, 'raytrace-nested.json'), 'utf8')))) {
        if (!nested.includes(folder)) git('rm', '-q', '-r', '--cached', '--ignore-unmatch', '--', folder);
      }
    } catch { /* none recorded yet */ }
    git('add', '-A', '-f', '--', '.', ...SKIPPED.map((name) => `:(glob,exclude)**/${name}/**`),
      ...nested.map((folder) => `:(literal,exclude)${folder}`));
    // Too big to keep: the snapshot holds its previous version, and says so.
    const tooBig = git('diff', '--cached', '--name-only', '-z', '--diff-filter=AM').split('\0').filter(Boolean)
      .filter((path) => { try { return statSync(join(WORKSPACE, path)).size > MAX_FILE; } catch { return false; } });
    if (tooBig.length) git('reset', '-q', '--', ...tooBig);
    tooBig.push(...addNestedRepositories(git, nested));
    const tree = git('write-tree').trim();
    let parent = null;
    try { parent = git('rev-parse', '-q', '--verify', 'HEAD').trim(); } catch { /* first snapshot */ }
    const parentTree = parent ? git('rev-parse', `${parent}^{tree}`).trim() : null;
    let commit = parent;
    const changes = [];
    if (tree !== parentTree) {
      commit = git('commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `${takenOn} ${callId ?? ''}`.trim()).trim();
      git('update-ref', 'HEAD', commit);
      const range = parent ? [parent, commit] : ['--root', commit];
      const counts = new Map(git('diff-tree', '-r', '--numstat', '-z', '--no-commit-id', ...range).split('\0').filter(Boolean)
        .map((entry) => { const [added, removed, ...path] = entry.split('\t'); return [path.join('\t'), [added, removed]]; }));
      const statuses = git('diff-tree', '-r', '--name-status', '-z', '--no-commit-id', ...range).split('\0').filter(Boolean);
      for (let i = 0; i + 1 < statuses.length && changes.length < MAX_LISTED; i += 2) {
        const [added, removed] = counts.get(statuses[i + 1]) ?? ['-', '-'];
        changes.push({ path: statuses[i + 1], status: statuses[i][0],
          added: added === '-' ? null : Number(added), removed: removed === '-' ? null : Number(removed) });
      }
    }
    return { commit, parent, taken_on: takenOn, call_id: callId ?? null, taken_at: new Date().toISOString(),
      changed: tree !== parentTree, changes, too_big: tooBig.slice(0, MAX_LISTED) };
  } catch (error) {
    if (process.env.RAYTRACE_HOOK_DEBUG) console.error(error); // silent otherwise: never disturb Claude Code
    return null;
  } finally { try { rmdirSync(lock); } catch { /* already gone */ } }
}

const session = input.session_id;
const transcript = input.transcript_path;
if (!/^[0-9a-f-]{36}$/.test(session ?? '') || typeof transcript !== 'string'
  || !transcript.startsWith(join(home, '.claude', 'projects') + '/')) process.exit(0);

const callId = /^[A-Za-z0-9_-]{1,128}$/.test(input.tool_use_id ?? '') ? input.tool_use_id : null;
// A read of a file the owner restricted or watches. A write that went through
// is in the snapshot below, with its size; a refused one was queued above.
if (input.hook_event_name === 'PostToolUse' && READ_ONLY.has(input.tool_name)) {
  const path = inside(input.tool_input?.file_path ?? input.tool_input?.notebook_path);
  if (path && (restricted.includes(path) || watched.includes(path))) queue({ kind: 'read', path });
}
const snap = input.hook_event_name === 'UserPromptSubmit' ? snapshot('prompt', null)
  : input.hook_event_name === 'PostToolUse' && !READ_ONLY.has(input.tool_name) ? snapshot('tool', callId) : null;

try {
  // The token projects.py set-token gave this sandbox.
  const token = readFileSync(join(home, '.raytace', 'sandbox-token'), 'utf8').trim();
  if (!token) process.exit(0);
  const stateDir = STATE_DIR;
  const stateFile = join(stateDir, `${session}.offset`);
  let offset = 0;
  try { offset = Number(readFileSync(stateFile, 'utf8')) || 0; } catch { /* first send, or /tmp was cleared */ }
  // The attempts queued since the last send. They go with the first send that
  // succeeds (RayTrace files each by an id of its own, so one that arrives
  // twice counts once) and are then taken off the file, not what came after.
  const queuedFile = join(stateDir, `${session}.events.jsonl`);
  let queued = Buffer.alloc(0);
  try { queued = readFileSync(queuedFile); } catch { /* none queued */ }
  const events = queued.toString('utf8').split('\n').filter(Boolean).slice(0, 1000)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  let delivered = events.length === 0;

  // Drain the bytes present at entry, not an endlessly growing transcript.
  // Successful fragments do not consume the bounded conflict retry budget.
  let endOffset = null;
  let conflicts = 0;
  while (conflicts < 8) {
    // A new session's first prompt fires before Claude Code has written its
    // transcript: send the snapshot anyway, with no lines yet.
    let fd = null;
    try { fd = openSync(transcript, 'r'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let text = '';
    let more = false;
    if (fd !== null) try {
      if (endOffset === null) endOffset = fstatSync(fd).size;
      const available = endOffset - offset;
      if (available > 0) {
        const buffer = Buffer.alloc(Math.min(available, CHUNK));
        let end = readSync(fd, buffer, 0, buffer.length, offset);
        // A fragment can split a JSON line, but never a UTF-8 codepoint:
        // decoding half a character would change its bytes and the offset.
        let lead = end - 1;
        while (lead >= 0 && (buffer[lead] & 0xc0) === 0x80) lead -= 1;
        if (lead >= 0) {
          const byte = buffer[lead];
          const width = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
          if (end - lead < width) end = lead;
        }
        text = buffer.subarray(0, end).toString('utf8');
        more = offset + end < endOffset;
      }
    } finally { closeSync(fd); }
    const envelope = () => JSON.stringify({ session_id: session, hook_event_name: input.hook_event_name, offset, text, more, ...(snap ? { snapshot: snap } : {}),
        ...(delivered ? {} : { events }),
        // A Playground fork's sandbox carries its own id (projects.py): RayTrace
        // files the fork's steps under it, not under the project it forks.
        ...(/^rtf-[a-f0-9]{32}$/.test(process.env.RAYTRACE_SESSION ?? '') ? { fork: process.env.RAYTRACE_SESSION } : {}) });
    let requestBody = envelope();
    while (Buffer.byteLength(requestBody) > 4 * 1024 * 1024 && text) {
      const bytes = Buffer.from(text);
      let end = Math.floor(bytes.length / 2);
      // Cut before any incomplete codepoint at the new boundary.
      while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
      text = bytes.subarray(0, end).toString('utf8');
      more = true;
      requestBody = envelope();
    }
    if (Buffer.byteLength(requestBody) > 4 * 1024 * 1024) {
      console.error('RayTrace: transcript metadata exceeds the request limit; pending data was retained.');
      break;
    }
    const response = await fetch(BROKER, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-raytace-sandbox-token': token },
      body: requestBody,
      signal: AbortSignal.timeout(4000),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 409 && Number.isInteger(body.size) && body.size >= 0) { offset = body.size; conflicts += 1; continue; }
    if (!response.ok || body.size !== offset + Buffer.byteLength(text)) break;
    if (!delivered) {
      delivered = true;
      try { writeFileSync(queuedFile, readFileSync(queuedFile).subarray(queued.length)); } catch { /* already gone */ }
    }
    offset = body.size;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(stateFile, String(offset));
    if (!more || !text) break; // an incomplete UTF-8 tail waits for the next hook
  }
} catch { /* RayTrace or the manager not running: stay silent */ }
