/**
 * Turns raw gVisor process events into something a person can read: one line
 * per command the agent actually ran, in plain English, with the noise folded
 * away and counted.
 *
 * Why this is needed: the collector records every exec faithfully, and that is
 * the point -- but faithfully includes Codex's own machinery. A single
 * `npm test` produces four exec events in one pid:
 *
 *   /bin/bash -c __CODEX_SNAPSHOT_OVERRIDE_SET_0=...   16,027 characters
 *   /bin/bash -c cd /workspace/demo && npm test        the command as written
 *   /usr/local/bin/npm test                            re-exec, same pid
 *   node /usr/local/bin/npm test                       re-exec, same pid
 *
 * Rendered verbatim that is unreadable, and the 16k preamble collapses any
 * table it lands in. So events are folded -- never dropped. `fold()` returns
 * the commands plus a count of exactly what it folded, and callers are
 * expected to show that count and offer the raw events. A tool that claims to
 * show what really happened does not get to quietly hide two thirds of it.
 *
 * Claude Code has machinery of its own. It runs each Bash tool call as
 *
 *   /bin/bash -c source <shell snapshot> … && eval '<the command>' && pwd -P >| /tmp/claude-…-cwd
 *
 * so the command the agent wrote is the eval's argument, unwrapped here. And
 * around the tool calls it starts processes no tool call asked for: it writes
 * that shell snapshot, lists the project's files, reads the git identity and
 * the environment, and runs RayTrace's own hook (which snapshots the project
 * with git). Those, and everything they start, are folded as machinery.
 */

const CODEX_PREAMBLE = /__CODEX_SNAPSHOT_(?:OVERRIDE|PROXY)/;
/** npm probes the architecture before running a script; it says nothing about
 * what the agent asked for. Matched exactly, never by prefix. */
const MACHINERY = [/^getconf (?:LONG_BIT|_NPROCESSORS_ONLN)$/];
/** What Claude Code and RayTrace's hook start by themselves (see the header).
 * Matched on the whole command line as executed; whatever such a process
 * starts is folded with it. An agent's own `env` or `rg` arrives inside the
 * tool-call wrapper, so it never has these shapes. */
const HARNESS = [
  /^(?:\S*\/)?(?:sh|bash) -c node \/opt\/raytace-claude\/hook\.mjs$/,
  /^node \/opt\/raytace-claude\/hook\.mjs$/,
  /^(?:\S*\/)?bash -c -l SNAPSHOT_FILE=\S*\/\.claude\/shell-snapshots\//,
  /^(?:\S*\/)?bash -c env$/,
  /^(?:\S*\/)?git (?:-c \S+ )+config --get user\.(?:email|name)$/,
  /^(?:\S*\/)?rg --no-config --files --follow --hidden /,
];
/** Claude Code's wrapper around one Bash tool call; group 1 is the command, quoted for eval. */
// Newer Claude Code versions feed the eval from /dev/null (`eval '...' < /dev/null`).
const CLAUDE_TOOL_CALL = /^source \S*\/\.claude\/shell-snapshots\/\S+[\s\S]*? && eval '([\s\S]*)'(?: < \/dev\/null)? && pwd -P >\| \S+$/;
/** RayTrace's PreToolUse hook puts the call's id first, so the kernel's record names it. */
const CALL_MARKER = /^export RAYTRACE_CALL_ID=([A-Za-z0-9_-]{1,128})\s*\n?/;

/** Codex wraps every tool call as `/bin/bash -c <cmd>` (or -lc). Stripping the
 * wrapper leaves the command the agent actually wrote -- the same normalisation
 * execution-correlation.mjs does before matching. */
const SHELL_WRAPPER = /^(?:\S*\/)?(?:sh|bash|zsh|dash)\s+-[a-z]*c\s+/;

/** Quoting differs between a shell's argv and its child's, so compare on the
 * text alone: `node -e "x"` and `node -e x` are the same work. */
function normalizeForCompare(command) {
  return String(command).replace(/["']/g, '').replace(/\s+/g, ' ').trim();
}

export function commandText(argv) {
  return (Array.isArray(argv) ? argv : []).join(' ').trim();
}

export function isPreamble(argv) { return CODEX_PREAMBLE.test(commandText(argv)); }

export function isMachinery(argv) {
  const text = commandText(argv);
  return MACHINERY.some((pattern) => pattern.test(text));
}

/** Started by Claude Code or RayTrace's hook, not by a tool call. */
export function isHarness(argv) {
  const text = commandText(argv);
  return HARNESS.some((pattern) => pattern.test(text));
}

/** A Claude Code Bash tool call, out of its wrapper: the command as the agent
 * wrote it and the call id RayTrace's hook marked it with (null without the
 * hook). Null when the text is not that wrapper. */
export function claudeToolCall(text) {
  const wrapped = CLAUDE_TOOL_CALL.exec(String(text ?? ''));
  if (!wrapped) return null;
  // eval's argument is single-quoted, each quote inside written as '"'"'.
  const inner = wrapped[1].replaceAll(`'"'"'`, "'");
  const marker = CALL_MARKER.exec(inner);
  return { command: (marker ? inner.slice(marker[0].length) : inner).trim(), call_id: marker ? marker[1] : null };
}

/** The command without Codex's or Claude Code's shell wrapper, for display and for the rules. */
export function bareCommand(argv) {
  const text = commandText(argv).replace(SHELL_WRAPPER, '').trim();
  return claudeToolCall(text)?.command ?? text;
}

/**
 * Folds a page of collector events into one entry per command.
 *
 * Same-pid re-execs collapse onto the FIRST non-preamble exec in that pid:
 * `/bin/bash -c cd … && npm test` is what the agent asked for, and
 * `npm test` -> `node …/npm test` are that command implementing itself. Keeping
 * the first is what makes the line match the tool call above it.
 *
 * @param {Array<object>} events - raw viewer events (any order)
 * @returns {{commands: Array<object>, folded: {preamble: number, machinery: number, reexec: number, exits: number, preambleChars: number}}}
 */
export function fold(events) {
  const folded = { preamble: 0, machinery: 0, reexec: 0, exits: 0, preambleChars: 0 };
  const ordered = (Array.isArray(events) ? events : [])
    .filter((event) => Number.isFinite(Number(event?.event_id)))
    .sort((a, b) => Number(a.event_id) - Number(b.event_id));

  const byPid = new Map();   // pid -> the command entry that owns it
  // pid -> ppid for EVERY process seen, whether or not it became a command.
  // Two kinds of process are missing from `byPid` but still sit between a
  // command and its real parent: ones we folded (machinery, preamble), and
  // ones that forked without ever exec'ing -- a shell running `a | b | c`
  // forks a subshell per stage, and a subshell inherits its parent's image, so
  // gVisor has no exec to report for it. Without their ppid the stages below
  // them look parentless and float to the top level as though nothing had
  // started them. `process_exit` names the ppid even when no exec did.
  const lineage = new Map();
  const remember = (pid, ppid) => { if (!lineage.has(pid) && ppid != null) lineage.set(pid, ppid); };
  const commands = [];
  // What the harness started, and everything started under that: a hook's
  // git commands are the hook's work, not the agent's. (A probe like getconf
  // folds alone: what ran under it was the agent's pipeline.)
  const harness = new Set();
  const underHarness = (pid) => {
    const seen = new Set();
    for (let at = pid; at != null && !seen.has(at); at = lineage.get(at) ?? null) { if (harness.has(at)) return true; seen.add(at); }
    return false;
  };

  for (const event of ordered) {
    const pid = Number(event.pid);
    const eventPpid = Number.isFinite(Number(event.ppid)) ? Number(event.ppid) : null;
    remember(pid, eventPpid);
    if (event.kind === 'process_exit') {
      folded.exits += 1;
      const owner = byPid.get(pid);
      if (owner) {
        owner.exit_code = typeof event.exit_code === 'number' ? event.exit_code : null;
        owner.signal = typeof event.signal === 'number' && event.signal > 0 ? event.signal : null;
        owner.ended_ns = event.timestamp_ns ?? null;
      }
      continue;
    }
    if (event.kind !== 'exec_succeeded') continue;

    const argv = Array.isArray(event.argv) ? event.argv : [];
    if (isPreamble(argv)) { folded.preamble += 1; folded.preambleChars += commandText(argv).length; continue; }
    if (underHarness(pid) || isHarness(argv)) { harness.add(pid); folded.machinery += 1; continue; }
    if (isMachinery(argv)) { folded.machinery += 1; continue; }

    // A pid that already has a command is re-execing: same job, new image.
    if (byPid.has(pid)) { folded.reexec += 1; continue; }

    const entry = {
      event_id: Number(event.event_id),
      pid,
      ppid: eventPpid,
      argv,
      command: bareCommand(argv),
      // Set for a Claude Code tool call that RayTrace's hook marked: the call
      // this process is, by its own command line (attributeMarked).
      marker_call_id: claudeToolCall(commandText(argv).replace(SHELL_WRAPPER, '').trim())?.call_id ?? null,
      started_ns: event.timestamp_ns ?? null,
      // The process's own start time: with pid, the identity the dashboard
      // uses to find which tool call this process belongs to. Stable across
      // the re-execs this entry absorbs, unlike the event id kept above.
      process_start_ns: typeof event.process_start_ns === 'string' ? event.process_start_ns : null,
      ended_ns: null,
      exit_code: null,
      signal: null,
      // Set by the caller once parents are known; a child of a command the
      // agent ran is shown nested under it rather than as its own step.
      parent_event_id: null,
    };
    byPid.set(pid, entry);
    commands.push(entry);
  }

  // Nest: a command whose ppid belongs to another command in this window is a
  // consequence of it, not a separate thing the agent did. Walk the lineage
  // upward rather than taking a single hop, so a folded parent hands its
  // children to the nearest ancestor that survived. A process whose parent ran
  // outside this window is genuinely unattributed and stays at the top level.
  for (const entry of commands) {
    let ancestor = entry.ppid;
    const seen = new Set([entry.pid]);
    while (ancestor != null && !seen.has(ancestor)) {
      const parent = byPid.get(ancestor);
      if (parent && parent !== entry) { entry.parent_event_id = parent.event_id; break; }
      seen.add(ancestor);
      ancestor = lineage.has(ancestor) ? lineage.get(ancestor) : null;
    }
  }

  // `sh -c "node -e X"` forks a `node -e X`. Two processes, one action -- the
  // shell is doing precisely what it was handed, so showing both reads as the
  // agent having deleted the same file twice. Collapse the child onto the
  // parent when their commands are the same once quoting is ignored, keeping
  // the child's outcome (it is the process that actually did the work).
  const sameWork = (a, b) => a && b && normalizeForCompare(a) === normalizeForCompare(b);
  const byEventId = new Map(commands.map((entry) => [entry.event_id, entry]));
  const collapsed = commands.filter((entry) => {
    const parent = entry.parent_event_id != null ? byEventId.get(entry.parent_event_id) : null;
    if (!parent || !sameWork(entry.command, parent.command)) return true;
    parent.exit_code = entry.exit_code ?? parent.exit_code;
    parent.signal = entry.signal ?? parent.signal;
    parent.ended_ns = entry.ended_ns ?? parent.ended_ns;
    byEventId.set(entry.event_id, parent);   // re-point any grandchildren
    folded.reexec += 1;
    return false;
  });
  for (const entry of collapsed) {
    const parent = entry.parent_event_id != null ? byEventId.get(entry.parent_event_id) : null;
    entry.parent_event_id = parent && parent !== entry ? parent.event_id : null;
  }

  return { commands: collapsed, folded };
}

// --- plain-English rules -----------------------------------------------------
//
// Deterministic, in the spirit of describeCall() in experiment-engine.mjs.
// A rule may only say what the command text already proves. Anything else
// falls through to `null`, and the caller either shows the command verbatim or
// asks a model -- clearly marked as a model's reading, never as observation.

const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);
/** Last two path segments: enough to recognise, short enough to read. */
const shortPath = (value) => {
  const parts = String(value).replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.length <= 2 ? String(value) : '…/' + parts.slice(-2).join('/');
};

/** Shell words with their quotes taken off: `rg 'a b' src/` -> [rg, a b, src/]. */
function shellWords(text) {
  const words = [];
  let word = ''; let quote = null; let started = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) { if (char === quote) quote = null; else word += char; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (char === '\\' && i + 1 < text.length) { word += text[i + 1]; i += 1; started = true; continue; }
    if (/\s/.test(char)) { if (started || word) { words.push(word); word = ''; started = false; } continue; }
    word += char; started = true;
  }
  if (started || word) words.push(word);
  return words;
}

/** Split on separators that sit outside quotes (`;`, `&&`, `||`, newlines,
 * or one lone `|`), so a `;` inside an inline script stays in its clause. */
function splitShell(text, lonePipe = false) {
  const parts = [];
  let part = ''; let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) { part += char; if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; part += char; continue; }
    if (char === '\\' && i + 1 < text.length) { part += char + text[i + 1]; i += 1; continue; }
    const pair = text.slice(i, i + 2);
    if (!lonePipe && (pair === '&&' || pair === '||')) { parts.push(part); part = ''; i += 1; continue; }
    if (!lonePipe && (char === ';' || char === '\n')) { parts.push(part); part = ''; continue; }
    if (lonePipe && char === '|' && pair !== '||') { parts.push(part); part = ''; continue; }
    part += char;
  }
  parts.push(part);
  return parts.map((piece) => piece.trim()).filter(Boolean);
}

/** `grep`/`rg` in words: the actual text searched for, and where. The bare
 * phrase "a pattern" is never an answer -- it tells the reader nothing. */
function describeSearch(words) {
  const args = words.slice(1);
  if (args.includes('--files')) {
    const where = args.find((arg) => !arg.startsWith('-'));
    return where ? `listed the files in ${shortPath(where)}` : 'listed the files';
  }
  // Options whose next word is a value, not the pattern or a place to search.
  const TAKES_VALUE = new Set(['-A', '-B', '-C', '-m', '-f', '-g', '--glob', '--include', '--exclude',
    '-t', '--type', '--type-not', '--max-count', '--after-context', '--before-context', '--context']);
  let pattern = null;
  const places = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-e' || arg === '--regexp') { pattern = args[i + 1] ?? pattern; i += 1; continue; }
    if (arg.startsWith('--regexp=')) { pattern = arg.slice('--regexp='.length); continue; }
    if (TAKES_VALUE.has(arg)) { i += 1; continue; }
    if (arg.startsWith('-')) continue;
    if (pattern == null) pattern = arg; else places.push(arg);
  }
  if (!pattern) return 'searched the contents of files';
  const onlyNames = args.some((arg) => arg === '-l' || arg === '--files-with-matches' || /^-[a-z]*l/.test(arg));
  const where = places.length ? ` in ${places.map(shortPath).slice(0, 2).join(', ')}` : '';
  return `${onlyNames ? 'found which files mention' : 'searched for'} "${clip(pattern, 40)}"${where}`;
}

function describeFind(words) {
  const args = words.slice(1);
  const root = args.find((arg) => !arg.startsWith('-'));
  const nameAt = args.findIndex((arg) => arg === '-name' || arg === '-iname');
  const under = root ? ` under ${shortPath(root)}` : '';
  return nameAt >= 0 && args[nameAt + 1]
    ? `looked for files named ${clip(args[nameAt + 1], 40)}${under}`
    : `looked for files${under}`;
}

const GIT_PLAIN = {
  status: 'checked which files have unsaved changes (git status)',
  diff: 'looked at what changed in the files (git diff)',
  log: 'looked at the commit history (git log)',
  add: 'marked files to be saved in the next commit (git add)',
  commit: 'saved the changes as a commit (git commit)',
  checkout: 'switched branch (git checkout)',
  switch: 'switched branch (git switch)',
  branch: 'listed or changed branches (git branch)',
  clone: 'downloaded a copy of a project (git clone)',
  pull: 'downloaded the latest changes (git pull)',
  fetch: 'checked for newer changes (git fetch)',
  push: 'uploaded its commits (git push)',
  show: 'looked at a past commit (git show)',
  config: 'checked a git setting (git config)',
  'rev-parse': 'checked where git is pointing (git rev-parse)',
  init: 'started tracking this folder with git (git init)',
  stash: 'set the changes aside for later (git stash)',
  merge: 'combined another branch in (git merge)',
  rebase: 'replayed its commits onto another branch (git rebase)',
  reset: 'moved the project back to an earlier state (git reset)',
  rm: 'removed files from git (git rm)',
  mv: 'renamed a file in git (git mv)',
};

function firstUrl(command) { return command.match(/https?:\/\/\S+/)?.[0] ?? null; }

/** `node -e "<script>"` is common enough to be worth reading into, but only
 * for operations the script text states outright. */
function describeInlineNode(command) {
  // The script usually arrives still wrapped in the quotes the shell saw
  // (`node -e "console.log('x')"`); strip them so anchored patterns match.
  const script = command.replace(/^node\s+-e\s*/, '').replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
  const unlink = script.match(/unlinkSync\(\s*["']([^"']+)["']/);
  if (unlink) return `deleted ${shortPath(unlink[1])}`;
  const write = script.match(/writeFileSync\(\s*["']([^"']+)["']/);
  if (write) return `wrote ${shortPath(write[1])}`;
  const mkdir = script.match(/mkdirSync\(\s*["']([^"']+)["']/);
  if (mkdir) return `created folder ${shortPath(mkdir[1])}`;
  const log = script.match(/^\s*console\.log\(\s*["']([^"']*)["']\s*\)\s*$/);
  if (log) return `printed "${clip(log[1], 40)}"`;
  return null;   // an inline script doing something else: show it verbatim
}

/** A command line that carries its tool call's id is that call, whatever the
 * store has (or has not yet) recorded for the process: the wrapper is what
 * the agent's call became, and its children are the call's steps. Sets
 * `attribution` on such commands; call it after the store's own answers. */
export function attributeMarked(commands) {
  for (const entry of Array.isArray(commands) ? commands : []) {
    if (entry.marker_call_id && !entry.attribution?.call_id) entry.attribution = { call_id: entry.marker_call_id, parent_call_id: null, tier: 'mediated' };
  }
  return commands;
}

/**
 * One clause (`pwd`, `ls -la src/`) in plain English. Returns '' for shell
 * set-up that does no work of its own (`set -e`), and null when the clause
 * cannot be proved from its text. Plain words come first; the command's own
 * name rides along in brackets where a reader may not know it (`pwd`).
 */
function describeClause(clause) {
  const written = clause.match(/^(?:cat|echo|printf)\b[^>]*>{1,2}\s*(\S+)/);
  if (written) return `wrote ${shortPath(written[1])}`;
  const clean = clause.replace(/\s*\d*>&\d+/g, '').replace(/\s*\d*>>?\s*\S+/g, '').replace(/\s*<\s*\S+/g, '').trim();
  const words = shellWords(clean);
  const settings = [];
  while (words.length && /^[A-Za-z_]\w*=/.test(words[0])) settings.push(words.shift().split('=')[0]);
  if (!words.length) return settings.length ? `set the ${settings.join(', ')} environment setting${settings.length > 1 ? 's' : ''}` : null;
  if (words[0] === 'sudo') words.shift();
  if (!words.length) return null;
  const prog = words[0].split('/').filter(Boolean).at(-1) ?? words[0];
  const args = words.slice(1);
  const plain = args.filter((arg) => !arg.startsWith('-'));
  const last = plain.at(-1) ?? '';
  const first = plain[0] ?? '';
  const hasFlag = (letter) => args.some((arg) => arg === `--${letter}` || new RegExp(`^-[a-z]*${letter}`).test(arg));
  switch (prog) {
    case 'cd': return first ? `changed folder to ${shortPath(first)}` : 'changed folder to the home folder';
    case 'pwd': return 'checked which folder it was in (pwd)';
    case 'whoami': return 'checked which user it was running as (whoami)';
    case 'id': return 'checked which user and groups it was running as (id)';
    case 'hostname': return "checked the machine's name (hostname)";
    case 'date': return 'checked the current date and time (date)';
    case 'uname': {
      const flags = args.join('');
      if (/^-m+$/.test(args[0] ?? '')) return 'checked what kind of machine this is (uname -m)';
      if (/^-r+$/.test(args[0] ?? '')) return 'checked the operating system version (uname -r)';
      if (/^-s+$/.test(args[0] ?? '')) return 'checked the operating system name (uname -s)';
      return flags.includes('a') ? 'checked all the system details (uname -a)' : 'checked the operating system (uname)';
    }
    case 'ls': {
      const hidden = hasFlag('all') || hasFlag('a') || hasFlag('A');
      const where = first ? ` in ${shortPath(first)}` : ' here';
      return `listed the files${where}${hidden ? ', including hidden ones' : ''}`;
    }
    case 'mkdir': return first ? `created folder ${shortPath(last)}` : null;
    case 'rmdir': return first ? `removed folder ${shortPath(last)}` : null;
    case 'rm': return first ? `deleted ${shortPath(first)}${plain.length > 1 ? ` and ${plain.length - 1} more` : ''}` : null;
    case 'touch': return first ? `created empty file ${shortPath(last)}` : null;
    case 'cp': return plain.length >= 2 ? `copied ${shortPath(first)} to ${shortPath(last)}` : null;
    case 'mv': return plain.length >= 2 ? `moved ${shortPath(first)} to ${shortPath(last)}` : null;
    case 'chmod': return last ? `changed permissions on ${shortPath(last)}` : null;
    case 'cat': return first ? `read ${plain.map(shortPath).slice(0, 3).join(', ')}` : null;
    case 'head': case 'tail': {
      if (!last) return null;
      const count = args.find((arg) => /^-\d+$/.test(arg))?.slice(1) ?? args[args.indexOf('-n') + 1];
      return `read the ${prog === 'head' ? 'first' : 'last'}${count && /^\d+$/.test(count) ? ` ${count}` : ''} lines of ${shortPath(last)}`;
    }
    case 'grep': case 'rg': case 'egrep': case 'fgrep': return describeSearch(words);
    case 'find': return describeFind(words);
    case 'git': {
      const rest = [...args];
      while (rest.length && rest[0].startsWith('-')) rest.splice(0, rest[0] === '-C' || rest[0] === '-c' ? 2 : 1);
      const sub = rest[0];
      return sub ? (GIT_PLAIN[sub] ?? `ran git ${sub}`) : null;
    }
    case 'npm': case 'yarn': case 'pnpm': {
      const script = args[0] === 'run' ? args[1] : args[0];
      if (!script) return null;
      if (script === 'install' || script === 'i' || script === 'ci' || script === 'add') return 'installed dependencies';
      if (script === 'test') return 'ran the test script';
      if (prog === 'npm' && (script === 'exec' || script === 'x')) return args[1] ? `ran ${args[1]} (via npm exec)` : null;
      return `ran the ${script} script`;
    }
    case 'npx': return first ? `ran ${first} (via npx)` : null;
    case 'node': {
      if (args.includes('--test')) return 'ran the tests';
      if (args.some((arg) => arg === '-e' || arg === '--eval')) return describeInlineNode(clean) ?? 'ran an inline JavaScript script';
      const file = args.find((arg) => /\.(?:js|mjs|cjs|ts)$/.test(arg));
      return file ? `ran ${shortPath(file)}` : null;
    }
    case 'python': case 'python3': {
      if (args.includes('-c') || args[0] === '-') return 'ran an inline Python script';
      const moduleAt = args.indexOf('-m');
      if (moduleAt >= 0) {
        const mod = args[moduleAt + 1] ?? '';
        return mod === 'pytest' || mod === 'unittest' ? 'ran the Python tests' : mod ? `ran the Python module ${mod}` : null;
      }
      const file = args.find((arg) => arg.endsWith('.py'));
      return file ? `ran ${shortPath(file)}` : null;
    }
    case 'pytest': return 'ran the Python tests';
    case 'jest': case 'vitest': case 'mocha': return 'ran the JavaScript tests';
    case 'go': case 'cargo': return args[0] === 'test' ? 'ran the tests' : args[0] ? `ran ${prog} ${args[0]}` : null;
    case 'curl': case 'wget': return `fetched ${clip(firstUrl(clean) || 'a URL', 50)}`;
    case 'which': return first ? `checked whether ${plain.join(', ')} is installed (which)` : null;
    case 'command': return args[0] === '-v' && args[1] ? `checked whether ${args.slice(1).join(', ')} is installed` : null;
    case 'env': case 'printenv': return prog === 'printenv' || !args.length ? 'listed its environment settings' : describeClause(args.join(' '));
    case 'export': {
      const names = args.map((arg) => arg.split('=')[0]).filter((name) => /^[A-Za-z_]\w*$/.test(name));
      return names.length ? `set the ${names.join(', ')} environment setting${names.length > 1 ? 's' : ''}` : null;
    }
    case 'source': case '.': return first ? `loaded shell settings from ${shortPath(first)}` : null;
    case 'echo': case 'printf': {
      const said = args.filter((arg) => arg !== '-n' && arg !== '-e').join(' ');
      return said ? `printed "${clip(said, 40)}"` : 'printed a blank line';
    }
    case 'wc': return last ? `counted the ${hasFlag('w') ? 'words' : hasFlag('c') ? 'bytes' : 'lines'} in ${shortPath(last)}` : null;
    case 'sed': return hasFlag('i') && plain.length >= 2 ? `edited ${shortPath(last)} with a find-and-replace` : null;
    case 'test': case '[': {
      const checked = args.filter((arg) => arg !== ']');
      return (checked[0] === '-f' || checked[0] === '-d' || checked[0] === '-e') && checked[1]
        ? `checked whether ${shortPath(checked[1])} exists` : null;
    }
    case 'sleep': return first ? `waited ${first}` : null;
    case 'set': case 'shopt': case 'true': return '';
    case 'sh': case 'bash': case 'zsh': case 'dash': {
      const dashC = args.findIndex((arg) => /^-[a-z]*c$/.test(arg));
      if (dashC >= 0) return args[dashC + 1] ? describeCommand(args[dashC + 1]) : null;
      const file = args.find((arg) => arg.endsWith('.sh'));
      return file ? `ran the shell script ${shortPath(file)}` : null;
    }
    default: return null;
  }
}

/** `prog - <<'E' … E` plus whatever follows the closing marker. */
function describeHeredoc(text) {
  const opened = text.match(/<<-?\s*['"]?([A-Za-z_][\w]*)['"]?/);
  if (!opened) return null;
  const language = { python: 'Python', python3: 'Python', node: 'JavaScript', ruby: 'Ruby', perl: 'Perl', bash: 'shell', sh: 'shell' };
  // The opener may not be the first clause: `cd /workspace; python3 - <<'E'`.
  const clauses = splitShell(text.slice(0, text.indexOf('<<')));
  const opener = clauses.pop() ?? '';
  const prog = shellWords(opener)[0]?.split('/').at(-1) ?? '';
  const before = clauses.length ? describeCommand(clauses.join(' && ')) : null;
  const inline = `ran an inline ${language[prog] ?? prog ?? ''} script`.replace(/\s+/g, ' ').trim();
  const head = before ? `${before}, then ${inline}` : inline;
  const lines = text.split('\n');
  const closedAt = lines.findIndex((line, index) => index > 0 && line.trim() === opened[1]);
  const after = closedAt >= 0 ? lines.slice(closedAt + 1).join('\n').trim() : '';
  const rest = after ? describeCommand(after) : null;
  return rest ? `${head}, then ${rest}` : head;
}

/**
 * A sentence for one command, or null when no rule applies with certainty.
 * Null is a real answer: it means "show the command itself", which is always
 * honest, rather than inventing a description that might be wrong.
 *
 * A compound command is told clause by clause (`changed folder to X, then
 * listed the files here`): every clause is part of what ran, the `cd`
 * included. If any clause cannot be proved, the whole sentence is withheld.
 */
export function describeCommand(command) {
  // Strip the shell wrapper, then any quotes it left behind: `sh -c "npm test"`
  // becomes `npm test`, so the rules see the command rather than the quoting.
  const text = String(command ?? '')
    .replace(SHELL_WRAPPER, '')
    .replace(/^(["'])([\s\S]*)\1$/, '$2')
    .trim();
  if (!text) return null;
  // `for c in npm yarn pnpm; do command -v "$c" …; done`: one check, many names.
  const loop = text.match(/^for\s+\w+\s+in\s+([^;]+?)\s*;\s*do\s+command\s+-v\b/);
  if (loop) return `checked which of ${loop[1].split(/\s+/).filter(Boolean).join(', ')} are installed`;
  if (/<<-?\s*['"]?[A-Za-z_]/.test(text)) { const heredoc = describeHeredoc(text); if (heredoc) return heredoc; }
  const described = [];
  for (const clause of splitShell(text)) {
    // A pipe's later stages only shape the output (`| head -3`); the work
    // itself is the first stage.
    const saying = describeClause(splitShell(clause, true)[0] ?? clause);
    if (saying == null) return null;
    if (saying && described.at(-1) !== saying) described.push(saying);
  }
  return described.length ? described.join(', then ') : null;
}

/** Every command in `commands` that no rule could describe, deduplicated --
 * the batch a caller sends to a model in ONE request rather than per line. */
export function undescribed(commands) {
  const seen = new Set();
  for (const entry of Array.isArray(commands) ? commands : []) {
    if (entry.description) continue;
    if (describeCommand(entry.command)) continue;
    if (entry.command) seen.add(entry.command);
  }
  return [...seen];
}

/**
 * Attaches a `description` and `description_source` to each command.
 * `lookup` maps a command string to a model-written sentence (cache or fresh);
 * anything it does not cover keeps `source: 'raw'` and is rendered verbatim.
 */
export function describeAll(commands, lookup = () => null) {
  for (const entry of Array.isArray(commands) ? commands : []) {
    const rule = describeCommand(entry.command);
    if (rule) { entry.description = rule; entry.description_source = 'rule'; continue; }
    const model = lookup(entry.command);
    if (model) { entry.description = model; entry.description_source = 'model'; continue; }
    entry.description = null; entry.description_source = 'raw';
  }
  return commands;
}

// --- model fallback for commands no rule can describe ------------------------
//
// Batched: every unknown command in a turn goes in ONE request, deduplicated,
// and the result is cached by command text (migration 006). A per-line call
// would be both slow and a real cost on every trace view.

const MAX_BATCH = 25;
const MAX_COMMAND_CHARS = 600;

export const DESCRIBE_INSTRUCTIONS = [
  'You are labelling shell commands that were observed running inside a sandbox.',
  'For each numbered command, reply with the same number and one short phrase saying what the command does.',
  'Use plain past tense, under 14 words, no trailing period. Example: 3. compiled the native addon',
  'Name the actual folder, file, or text searched for when the command shows it; never say just "a pattern" or "a file".',
  'Describe only what the command text itself shows. If you cannot tell, reply exactly: unclear.',
  'Never guess at intent, outcome, or whether it succeeded.',
].join(' ');

/** Request for a batch of unknown commands. Shape mirrors summaryRequest() in
 * summaries.mjs so both go through the same provider path. */
export function describeRequest(commands, model) {
  const batch = [...new Set(commands)].slice(0, MAX_BATCH)
    .map((command) => String(command).slice(0, MAX_COMMAND_CHARS));
  return {
    commands: batch,
    payload: {
      model, store: false, stream: false,
      max_output_tokens: 40 * batch.length + 120,
      // A labelling task, not a reasoning one -- and reasoning tokens compete
      // with the output budget, which is what broke summaries at v3.
      reasoning: { effort: 'low' },
      instructions: DESCRIBE_INSTRUCTIONS,
      input: batch.map((command, index) => `${index + 1}. ${command}`).join('\n'),
    },
  };
}

/**
 * Parses the numbered reply back into command -> sentence.
 * A line the model marked `unclear`, or did not answer at all, is left out
 * entirely: the caller then shows the raw command, which is always honest.
 */
export function parseDescriptions(text, commands) {
  const out = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const match = line.match(/^\s*(\d{1,2})[.)]\s*(.+?)\s*$/);
    if (!match) continue;
    const command = commands[Number(match[1]) - 1];
    const description = match[2].replace(/\s+/g, ' ').replace(/\.$/, '').slice(0, 120);
    if (!command || !description || /^unclear$/i.test(description)) continue;
    out.set(command, description);
  }
  return out;
}
