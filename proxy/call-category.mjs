/**
 * What kind of step a tool call was, for the Tool column: one of twelve
 * categories named for what the call did, not for the tool or agent that made
 * it. Claude Code's Read, Codex's `cat` and a shell `head` all read "Read".
 *
 * Decided in this order:
 *   1. A named tool (Read, apply_patch, an MCP tool) by its name alone.
 *   2. A shell command by the programs it runs. Each part of the line is
 *      placed by rule; a line of several parts takes its most consequential
 *      one (PRIORITY), so `cd app && cat x && rm y` is a delete.
 *   3. A shell command with a part no rule can place is put to Jev as one
 *      choice among the categories, asked in both orders and averaged (Jev
 *      leans toward the first option; see step-attribution.mjs).
 *
 * "Not sure" (`unsure`) is the answer wherever there is none: Jev unsure,
 * switched off or unreachable, or a tool nothing here knows. A category is a
 * description of the step, never evidence of what ran: that is the Sandbox
 * column's job, and no model has a say in it.
 */
import { digest } from './experiment-engine.mjs';

export const CATEGORY_VERSION = 1;
export const UNSURE = 'unsure';
export const CATEGORIES = ['read', 'search', 'write', 'edit', 'delete', 'run', 'test', 'build', 'git', 'web', 'plan', 'delegate'];
/** Most consequential first; decides a command of several parts. */
const PRIORITY = ['delete', 'edit', 'write', 'git', 'build', 'test', 'web', 'run', 'search', 'read'];
const strongest = (found) => PRIORITY.find((category) => found.has(category)) ?? null;

// --- named tools ------------------------------------------------------------------

const TOOLS = {
  // Claude Code
  Read: 'read', NotebookRead: 'read', Grep: 'search', Glob: 'search', LS: 'search',
  Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  BashOutput: 'run', KillShell: 'run', KillBash: 'run',
  WebFetch: 'web', WebSearch: 'web',
  TodoWrite: 'plan', TodoRead: 'plan', AskUserQuestion: 'plan', ExitPlanMode: 'plan', EnterPlanMode: 'plan', ToolSearch: 'plan',
  Task: 'delegate', Agent: 'delegate', Skill: 'delegate', SlashCommand: 'delegate',
  // Codex and other agents
  update_plan: 'plan', view_image: 'read', write_stdin: 'run', web_search: 'web',
  read_file: 'read', list_dir: 'search', list_files: 'search', grep_files: 'search', search_files: 'search',
  write_file: 'write', edit_file: 'edit',
};
/** Tools whose argument is a shell command line. */
const SHELL_TOOLS = /^(bash|shell|shell_command|exec_command|local_shell|container\.exec|unified_exec|run_terminal_cmd|run_command|execute_command)$/i;
const EDITOR_TOOLS = /^(str_replace_editor|str_replace_based_edit_tool|text_editor)$/;

/** The call's arguments as an object; captures can carry them JSON-encoded twice. */
function argsOf(argsRaw) {
  let value = argsRaw;
  for (let depth = 0; typeof value === 'string' && depth < 3; depth += 1) {
    try { value = JSON.parse(value); } catch { break; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** The whole command line a call carries (never clipped), or '' when it has none. */
function commandOf(args, argsRaw) {
  const value = args ? (args.cmd ?? args.command ?? args.script) : null;
  if (Array.isArray(value)) {
    const parts = value.map(String);
    const wrapped = /(^|\/)(ba|z)?sh$/.test(parts[0] || '') && /^-\w*c$/.test(parts[1] || '');
    return (wrapped ? parts.slice(2) : parts).join(' ').trim();
  }
  if (typeof value === 'string') return value.trim();
  return !args && typeof argsRaw === 'string' ? argsRaw.trim() : '';
}

/** A patch by what it does to files: any delete or move, else any update, else adds. */
function patchCategory(text) {
  const verbs = new Set([...text.matchAll(/\*{3} (Add|Update|Delete) File:/g)].map((match) => match[1]));
  if (verbs.has('Delete') || /\*{3} Move to:/.test(text)) return 'delete';
  if (verbs.has('Update') || !verbs.has('Add')) return 'edit';
  return 'write';
}

// --- shell commands ---------------------------------------------------------------

const set = (words) => new Set(words.split(' '));
/** Shell words that set a line up and do nothing a reader would call the step. */
const QUIET = set('cd pushd popd export set unset source . true false : echo printf pwd date whoami id uname hostname sleep wait test [ [[ printenv which type hash alias unalias ulimit umask trap shopt local declare typeset readonly read exit return break continue clear history basename dirname realpath readlink nproc arch uptime tty seq yes getconf for case function select fi done esac } )');
/** Words in front of the real program. */
const PREFIX = set('sudo time nice nohup command exec builtin env if then elif else while until do ! { (');
const READ = set('cat head tail less more bat nl wc stat file du df diff cmp md5sum sha1sum sha256sum shasum xxd hexdump od strings jq yq sort uniq cut column tr awk gawk comm paste fold zcat tac rev');
const SEARCH = set('grep egrep fgrep zgrep rg ag ack find fd fdfind ls tree locate exa eza');
const WRITE = set('touch mkdir ln cp rsync install dd mktemp unzip zip gzip gunzip');
const EDIT = set('patch apply_patch ed ex chmod chown chgrp truncate dos2unix isort');
const DELETE = set('rm rmdir unlink shred mv trash');
const TEST = set('pytest py.test tox nox jest vitest mocha ava cypress rspec phpunit oxlint biome tsc mypy pyright pylint flake8 shellcheck ctest stylelint markdownlint hadolint yamllint actionlint');
const BUILD = set('cmake ninja gcc g++ cc clang clang++ rustc javac swiftc ld webpack rollup esbuild pipx');
const GIT = set('gh hub svn hg');
const WEB = set('curl wget http https ssh scp sftp nc ncat netcat ping dig nslookup host telnet ftp traceroute whois');
const RUN = set('node deno ruby php lua Rscript java tsx ts-node swift open xdg-open kill pkill killall watch screen tmux osascript expect');
const SHELLS = set('sh bash zsh dash fish ksh');
const PYTHON = /^(python[\d.]*|py)$/;
const INSTALLERS = set('apt apt-get brew yum dnf apk pacman conda mamba gem composer');
const INSTALL_VERBS = set('install i ci add remove uninstall rm update upgrade up rebuild link dedupe prune sync lock create require');
/** A file run by its path: ./check.sh, /opt/tool/run, scripts/build.py. */
const SCRIPT_PATH = /\/|\.(sh|bash|py|js|mjs|cjs|ts|rb|pl|php)$/;

/** A package script or make target by its name; null when the name does not say. */
function scriptCategory(name) {
  if (/^(test|tests|spec|e2e|lint|typecheck|type-check|check|verify|tsc|ci|format:check|fmt:check)\b/i.test(name)) return 'test';
  if (/^(lint:fix|format|fmt|fix)\b/i.test(name)) return 'edit';
  if (/^(build|compile|bundle|dist|prepare|generate|codegen|all|install|release)\b/i.test(name)) return 'build';
  if (/^(start|dev|serve|preview|watch|run)\b/i.test(name)) return 'run';
  if (/^(clean|distclean)\b/i.test(name)) return 'delete';
  return null;
}

const VAGUE = Symbol('vague'); // a real program no rule places
const QUIETLY = Symbol('quiet'); // nothing worth a category
const has = (args, ...flags) => args.some((arg) => flags.includes(arg));
const firstPlain = (args) => args.find((arg) => !arg.startsWith('-') && !/^\w+=/.test(arg));
const afterPlain = (args) => { const index = args.findIndex((arg) => !arg.startsWith('-') && !/^\w+=/.test(arg)); return index < 0 ? [] : args.slice(index + 1); };

/** Shell words, honouring single and double quotes. */
function shellWords(text) {
  return [...text.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

/** One program with its arguments: a category, VAGUE, QUIETLY, or the
 * result of the command it wraps (`bash -c`, `npx`, `find -exec`). */
function programCategory(words) {
  const list = [...words];
  // Past `sudo`, `FOO=bar`, `timeout 30`, `if`, `xargs -n 1` to the real program.
  for (;;) {
    const word = list[0];
    if (word === undefined) return QUIETLY;
    if (/^\w+=/.test(word)) { list.shift(); continue; }
    if (word === 'command' && /^-[vV]$/.test(list[1] ?? '')) return QUIETLY;
    if (PREFIX.has(word)) { list.shift(); continue; }
    if (word === 'timeout') { list.splice(0, /^\d/.test(list[1] ?? '') ? 2 : 1); continue; }
    if (word === 'xargs') {
      list.shift();
      while (list[0]?.startsWith('-')) list.splice(0, /^-[InLPdEs]$/.test(list[0]) ? 2 : 1);
      if (!list.length) return QUIETLY;
      continue;
    }
    break;
  }
  const program = list[0].replace(/^[({!]+|[)}]+$/g, '').split('/').pop();
  const args = list.slice(1);
  const sub = firstPlain(args);
  if (!program || QUIET.has(program)) return QUIETLY;
  // `terraform --version` asks a program about itself, whatever the program.
  if (args.length === 1 && has(args, '--version', '--help')) return QUIETLY;

  if (SHELLS.has(program)) {
    const inline = args.findIndex((arg) => /^-\w*c$/.test(arg));
    return inline >= 0 && args[inline + 1] ? shellResult(args[inline + 1]) : 'run';
  }
  if (program === 'eval') return args.length ? shellResult(args.join(' ')) : QUIETLY;
  if (PYTHON.test(program)) {
    const flag = args.indexOf('-m'); const name = args[flag + 1];
    if (flag < 0 || !name) return 'run';
    const inner = programCategory([name, ...args.slice(flag + 2)]);
    return inner === VAGUE || inner === QUIETLY ? (name === 'unittest' ? 'test' : name === 'venv' ? 'build' : 'run') : inner;
  }
  if (['npx', 'bunx', 'pnpx', 'uvx'].includes(program)) {
    const rest = [...args];
    while (rest[0]?.startsWith('-')) rest.splice(0, /^(-p|--package)$/.test(rest[0]) ? 2 : 1);
    return rest.length ? programCategory(rest) : VAGUE;
  }
  if (program === 'git') return ['grep', 'ls-files', 'ls-tree'].includes(sub) ? 'search' : 'git';
  if (GIT.has(program)) return 'git';
  if (program === 'find' || program === 'fd' || program === 'fdfind') {
    if (has(args, '-delete')) return 'delete';
    const exec = args.findIndex((arg) => /^-(exec|execdir|ok|x|X)$/.test(arg));
    if (exec >= 0 && args[exec + 1]) { const inner = programCategory(args.slice(exec + 1)); return inner === QUIETLY ? 'search' : inner; }
    return 'search';
  }
  if (program === 'sed') return args.some((arg) => /^(-i|--in-place)/.test(arg) || /^-[a-zA-Z]*i/.test(arg)) ? 'edit' : 'read';
  if (program === 'perl') return args.some((arg) => /^-[a-zA-Z]*i/.test(arg)) ? 'edit' : 'run';
  if (program === 'tee') return has(args, '-a', '--append') ? 'edit' : 'write';
  if (program === 'tar') return /t/.test((args[0] ?? '').replace(/^--?/, '')) && !/[xc]/.test(args[0] ?? '') ? 'read' : 'write';
  if (program === 'prettier') return has(args, '--write', '-w') ? 'edit' : 'test';
  if (program === 'eslint') return has(args, '--fix') ? 'edit' : 'test';
  if (program === 'black' || program === 'rustfmt') return has(args, '--check', '--diff') ? 'test' : 'edit';
  if (program === 'gofmt') return has(args, '-w') ? 'edit' : 'test';
  if (program === 'ruff') return sub === 'format' ? (has(args, '--check', '--diff') ? 'test' : 'edit') : has(args, '--fix') ? 'edit' : 'test';
  if (program === 'playwright') return sub === 'test' ? 'test' : sub === 'install' ? 'build' : VAGUE;
  if (program === 'node') return has(args, '--test') ? 'test' : 'run';
  if (program === 'deno') return ['test', 'lint', 'check'].includes(sub) ? 'test' : sub === 'fmt' ? 'edit' : sub === 'install' ? 'build' : 'run';

  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) {
    if (!sub) return program === 'yarn' ? 'build' : VAGUE;
    if (sub === 'test' || sub === 't') return 'test';
    if (sub === 'start') return 'run';
    if (sub === 'run' || sub === 'run-script') {
      const name = firstPlain(afterPlain(args));
      return (name && (scriptCategory(name) ?? (SCRIPT_PATH.test(name) ? 'run' : null))) || VAGUE;
    }
    if (['exec', 'dlx', 'x'].includes(sub)) { const rest = afterPlain(args); return rest.length ? programCategory(rest) : VAGUE; }
    if (INSTALL_VERBS.has(sub)) return 'build';
    if (program === 'bun' && SCRIPT_PATH.test(sub)) return 'run';
    // yarn, pnpm and bun run a package script named without `run`.
    return program === 'npm' ? VAGUE : scriptCategory(sub) ?? VAGUE;
  }
  if (program === 'pip' || program === 'pip3') return ['install', 'uninstall', 'download', 'wheel'].includes(sub) ? 'build' : ['list', 'show', 'freeze'].includes(sub) ? 'read' : VAGUE;
  if (['uv', 'poetry', 'pdm', 'bundle'].includes(program)) {
    if (sub === 'run' || sub === 'exec') { const rest = afterPlain(args); return rest.length ? programCategory(rest) : VAGUE; }
    return INSTALL_VERBS.has(sub) || ['pip', 'venv', 'build'].includes(sub) ? 'build' : VAGUE;
  }
  if (INSTALLERS.has(program)) return INSTALL_VERBS.has(sub) ? 'build' : ['list', 'search', 'info', 'show'].includes(sub) ? 'search' : VAGUE;
  if (program === 'cargo') {
    if (['test', 'clippy', 'check', 'bench'].includes(sub)) return 'test';
    if (sub === 'fmt') return has(args, '--check') ? 'test' : 'edit';
    if (['build', 'install', 'add', 'remove', 'fetch', 'update', 'doc'].includes(sub)) return 'build';
    return sub === 'run' ? 'run' : VAGUE;
  }
  if (program === 'go') {
    if (sub === 'test' || sub === 'vet') return 'test';
    if (['build', 'install', 'get', 'mod', 'generate'].includes(sub)) return 'build';
    return sub === 'run' ? 'run' : sub === 'fmt' ? 'edit' : VAGUE;
  }
  if (['mvn', 'mvnw', 'gradle', 'gradlew'].includes(program)) return ['test', 'verify', 'check'].includes(sub) ? 'test' : 'build';
  if (program === 'dotnet') return sub === 'test' ? 'test' : ['build', 'restore', 'publish', 'add'].includes(sub) ? 'build' : sub === 'run' ? 'run' : VAGUE;
  if (program === 'vite' || program === 'next') return sub === 'build' ? 'build' : sub === 'lint' ? 'test' : 'run';
  if (['make', 'gmake', 'just', 'task'].includes(program)) return sub ? scriptCategory(sub) ?? VAGUE : 'build';
  if (['docker', 'podman', 'docker-compose'].includes(program)) {
    const verb = sub === 'compose' ? firstPlain(afterPlain(args)) : sub;
    if (['build', 'buildx', 'pull'].includes(verb)) return 'build';
    if (['run', 'exec', 'start', 'up'].includes(verb)) return 'run';
    if (['push', 'login'].includes(verb)) return 'web';
    return ['rm', 'rmi', 'prune', 'down'].includes(verb) ? 'delete' : VAGUE;
  }

  for (const [category, programs] of [['read', READ], ['search', SEARCH], ['write', WRITE], ['edit', EDIT], ['delete', DELETE],
    ['test', TEST], ['build', BUILD], ['web', WEB], ['run', RUN]]) if (programs.has(program)) return category;
  return SCRIPT_PATH.test(list[0]) ? 'run' : VAGUE;
}

/** Quoted text blanked, so an operator inside quotes is not read as one. */
function maskQuotes(text) {
  return text.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, (quoted) => quoted[0] + 'x'.repeat(quoted.length - 2) + quoted[0]);
}

/** A here-document's body is data, not commands: keep only the line that opens it. */
function withoutHeredocs(text) {
  return text.replace(/(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1')
    .replace(/(<<-?\s*(['"]?)\w+\2[^\n]*)\n[\s\S]*$/, '$1'); // one cut off before its end
}

/** The line's parts: split at && || ; | & and newlines, outside quotes. */
function partsOf(line) {
  const masked = maskQuotes(line);
  const parts = [];
  let start = 0;
  const cut = (end, skip) => { if (line.slice(start, end).trim()) parts.push(line.slice(start, end).trim()); start = end + skip; };
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index]; const two = masked.slice(index, index + 2);
    if (char === '\\') { index += 1; continue; }
    // A command substitution's inside is a command of its own.
    if (two === '&&' || two === '||' || two === '$(') { cut(index, 2); index += 1; continue; }
    if (char === ';' || char === '\n' || char === '|' || char === '`') { cut(index, 1); continue; }
    // A lone & backgrounds a command; next to > it is part of a redirect (2>&1, &>).
    if (char === '&' && masked[index - 1] !== '>' && masked[index + 1] !== '>') cut(index, 1);
  }
  cut(masked.length, 0);
  return parts;
}

/** What a part's own output redirect does: `> file` writes, `>> file` appends.
 * Standard error, another descriptor and /dev/* are not files being written. */
function redirectCategory(part) {
  const masked = maskQuotes(part);
  for (const match of masked.matchAll(/(^|[^>&=\-\d])(>>|>\|?)(?![>&])\s*([^\s;&|<>]+)/g)) {
    if (match[3].startsWith('/dev/')) continue;
    return match[2] === '>>' ? 'edit' : 'write';
  }
  return null;
}

/** A part without its redirects (`2>&1`, `> out.txt`, `< in.txt`), which are not arguments. */
function withoutRedirects(part) {
  let text = part;
  for (const match of [...maskQuotes(part).matchAll(/[&\d]?(?:>>|>\||>|<<-?|<)&?\s*[^\s;&|<>]*/g)].reverse()) {
    text = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`;
  }
  return text;
}

/** Every part's category, how many parts no rule placed, and how many parts there were. */
function shellParts(command) {
  const found = new Set(); let vague = 0; let programs = 0;
  for (const part of partsOf(withoutHeredocs(command))) {
    programs += 1;
    const redirect = redirectCategory(part);
    if (redirect) found.add(redirect);
    const result = programCategory(shellWords(withoutRedirects(part)));
    if (result === QUIETLY) continue;
    if (result === VAGUE) vague += 1;
    else if (typeof result === 'string') found.add(result);
    else { for (const category of result.found) found.add(category); vague += result.vague; }
  }
  return { found, vague, programs };
}

/** A wrapped command line (`bash -c '…'`) as one program's result. */
function shellResult(command) {
  const { found, vague, programs } = shellParts(command);
  if (!found.size && !vague) return programs ? 'run' : QUIETLY;
  return { found, vague };
}

/**
 * A shell command line's category by rule, or null when a part of it is a
 * program no rule places (Jev's question). A delete is the most consequential
 * thing a line can do, so one settles the line whatever else is in it; a line
 * that only sets things up or prints (`cd x`, `echo done`) ran something.
 */
export function shellCategory(command) {
  const { found, vague, programs } = shellParts(String(command ?? ''));
  if (found.has('delete')) return 'delete';
  if (vague) return null;
  return strongest(found) ?? (programs ? 'run' : UNSURE);
}

// --- one call ---------------------------------------------------------------------

/**
 * A call's category from its tool name and arguments. `category` is null only
 * for a shell command with a part no rule places; `command` is then the text
 * to put to Jev (resolveCategories). `source` is recorded, never shown.
 */
export function callCategory(name, argsRaw) {
  const rule = (category) => ({ category, source: 'rule', command: null });
  const tool = String(name ?? '');
  if (tool in TOOLS) return rule(TOOLS[tool]);
  if (tool.startsWith('mcp__')) return rule('delegate');
  const args = argsOf(argsRaw);
  const raw = typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw ?? '');
  if (tool === 'apply_patch') return rule(patchCategory(raw));
  if (EDITOR_TOOLS.test(tool)) return rule(args?.command === 'view' ? 'read' : args?.command === 'create' ? 'write' : 'edit');
  const command = commandOf(args, argsRaw);
  if (!command || !(SHELL_TOOLS.test(tool) || args)) return rule(UNSURE);
  // A patch handed to the shell (`apply_patch <<'EOF'`), not a command that merely quotes one.
  if (/^(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:apply_patch\b|\*{3} Begin Patch)/.test(command) && /\*{3} Begin Patch/.test(command)) return rule(patchCategory(command));
  const category = shellCategory(command);
  return category ? rule(category) : { category: null, source: null, command };
}

// --- Jev --------------------------------------------------------------------------

const MAX_COMMAND_CHARS = 600;
const UNSURE_BELOW = 0.5;
/** What Jev chooses among for a shell command. Plan and Delegate are tools, never commands. */
const CHOICES = {
  read: 'Looks at the contents of files',
  search: 'Looks for files or text, or lists what is there',
  write: 'Creates or replaces whole files or folders',
  edit: 'Changes part of existing files, or their permissions',
  delete: 'Removes, renames or moves files',
  run: 'Runs a script or program',
  test: 'Runs tests, linters or type checks',
  build: 'Builds the project or installs dependencies',
  git: 'Version control',
  web: 'Reaches the network',
  other: 'None of these, or the command text does not say',
};
const clip = (text, max) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

/** Cache key for one command: everything that decides Jev's answer. */
export function categoryKey(command, model) {
  return digest({ kind: 'call-category', version: CATEGORY_VERSION, model, command: clip(command, MAX_COMMAND_CHARS) });
}

/** Two requests for one command: the choice in list order, then reversed. */
export function categoryRequests(command) {
  const state = { command: clip(command, MAX_COMMAND_CHARS) };
  const question = (order) => ({ category: { type: 'choice',
    instructions: 'What does this shell command do? Judge by its most consequential part, not by how it is set up.',
    criteria: Object.fromEntries(order) } });
  const order = Object.entries(CHOICES);
  return [{ state, questions: question(order) }, { state, questions: question([...order].reverse()) }];
}

/** Averages the two orders. Unsure when they disagree, when the top choice is
 * weak or is "none of these", or when Jev itself reports low confidence. */
export function combineCategory(responses) {
  const answers = responses.map((response) => response?.answers?.category ?? null);
  const dists = answers.filter((answer) => answer?.probabilities && typeof answer.probabilities === 'object');
  const unsure = (reason) => ({ category: UNSURE, probability: null, confidence: null, unsure_reason: reason });
  if (!dists.length) return unsure('Jev returned no probabilities.');
  const ranked = Object.keys(CHOICES).map((key) => ({ key,
    probability: dists.reduce((sum, answer) => sum + (Number(answer.probabilities[key]) || 0), 0) / dists.length }))
    .sort((a, b) => b.probability - a.probability);
  const total = ranked.reduce((sum, item) => sum + item.probability, 0) || 1;
  const top = { key: ranked[0].key, probability: ranked[0].probability / total };
  const confidences = answers.map((answer) => answer?.confidence).filter((value) => typeof value === 'number');
  const confidence = confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null;
  let reason = null;
  if (answers[0]?.choice && answers[1]?.choice && answers[0].choice !== answers[1].choice) reason = 'The answer changed when the options were reordered.';
  else if (top.key === 'other') reason = 'The command text does not say.';
  else if (top.probability < UNSURE_BELOW) reason = 'No single category stands out.';
  else if (confidence != null && confidence < UNSURE_BELOW) reason = 'Jev reported low confidence.';
  return { category: reason ? UNSURE : top.key, probability: top.probability, confidence, unsure_reason: reason };
}

/**
 * Fills in the categories readTraces left open (`category: null`), for the
 * local proxy and the hosted evidence service alike. `ask` sends one request
 * to Jev; the returned function takes the traces and where answers are kept:
 * `get(key)` / `put(key, model, value)` over a store's call assessments, and
 * `scope` (an org) to keep one tenant's pending work apart from another's.
 *
 * An answer is asked for once per command and kept. A read waits `waitMs` for
 * answers it started, then returns; a call still open stays `category: null`
 * (shown without a category) and is filled by a later read. `onSettled` tells
 * a caller that caches its trace view that an answer arrived.
 */
export function categoryResolver({ config, ask, waitMs = 1500, retryMs = 60_000, maxPending = 4 }) {
  const settled = new Map(); // scope\nkey -> category, from Jev or the store
  const pending = new Map(); // scope\nkey -> Promise
  const failed = new Map(); // scope\nkey -> when, so a failing Jev is not asked on every poll
  return async function resolveCategories(traces, { scope = '', get, put, onSettled } = {}) {
    const open = new Map(); // command -> calls
    for (const trace of traces) for (const call of trace.callVerifications ?? []) {
      const command = call.category_command;
      delete call.category_command;
      if (call.category == null && command) open.set(command, [...(open.get(command) ?? []), call]);
    }
    const apply = (command, category, source) => { for (const call of open.get(command) ?? []) { call.category = category; call.category_source = source; } };
    const started = [];
    await Promise.all([...open.keys()].map(async (command) => {
      if (!config?.enabled) return apply(command, UNSURE, 'rule');
      const key = categoryKey(command, config.model); const id = `${scope}\n${key}`;
      if (settled.has(id)) return apply(command, settled.get(id), 'jev');
      if (Date.now() - (failed.get(id) ?? -Infinity) < retryMs) return apply(command, UNSURE, 'rule');
      if (!pending.has(id)) {
        let cached = null;
        try { cached = await get(key); } catch (error) { console.error(`[raytace] call categories unreadable: ${error.message}`); }
        if (cached?.category) { settled.set(id, cached.category); return apply(command, cached.category, 'jev'); }
        // The lookup above yielded: another read may have started this one meanwhile.
        if (!pending.has(id)) {
          if ([...pending.keys()].filter((item) => item.startsWith(`${scope}\n`)).length >= maxPending) return undefined;
          pending.set(id, (async () => {
            try {
              const responses = await Promise.all(categoryRequests(command).map(ask));
              const model = responses[0]?.model ?? config.model;
              const result = combineCategory(responses);
              await put(key, model, { ...result, model, command: clip(command, MAX_COMMAND_CHARS) });
              if (settled.size > 5000) settled.clear();
              settled.set(id, result.category);
            } catch (error) {
              console.error(`[raytace] Jev category unavailable: ${error.message}`);
              failed.set(id, Date.now());
            } finally { pending.delete(id); onSettled?.(); }
          })());
        }
      }
      started.push(pending.get(id).then(() => {
        if (settled.has(id)) apply(command, settled.get(id), 'jev'); else if (failed.has(id)) apply(command, UNSURE, 'rule');
      }));
      return undefined;
    }));
    if (started.length) await Promise.race([Promise.all(started), new Promise((resolve) => setTimeout(resolve, waitMs))]);
    return traces;
  };
}
