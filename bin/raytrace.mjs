#!/usr/bin/env node
// The `raytrace` command. Each subcommand lives in src/commands.mjs.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const HELP = `RayTrace: see what your coding agent did.

Usage: raytrace <command>

  setup        one-time setup: Claude Code hook, API keys, then start
  start        start RayTrace in the background (dashboard + recorder)
  stop         stop it
  status       is it running, and what is being recorded
  open         open the dashboard in your browser
  doctor       check the install without changing anything
  codex [...]  run Codex through RayTrace (needs an OpenRouter key)
  uninstall    remove the Claude Code hook, optionally all recorded data
  auth ...     sign in to RayTrace: login, status, logout
  connect <id> open a terminal in a cloud sandbox (signs you in if needed)
  sandbox ...  cloud sandboxes: create, list, shell, start, stop, destroy

Options for setup:   --yes  --no-claude-code  --no-start  --openrouter-key <key>
Options for uninstall: --yes  --purge (also delete ~/.raytrace)

Sandboxes (preview):
  raytrace sandbox create [--name <name>]   upload this Git repository to a new sandbox
                                            (up to 200 MiB, 25 MiB a file, 20,000 files)
  raytrace sandbox list
  raytrace connect [id]                     a terminal in it; run claude or codex there
                                            (same as: raytrace sandbox shell [id])
  raytrace sandbox start|stop [id]
  raytrace sandbox destroy [id] [--yes]     delete it; recorded evidence is kept

Data and settings live in ~/.raytrace (override with RAYTRACE_HOME).`;

// node:sqlite, which the recorder stores everything in, needs 22.13.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`RayTrace needs Node.js 22.13 or newer; this is ${process.version}.`);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);

// The hook runs on every Claude Code tool call: dispatch it before anything else.
if (command === 'hook') {
  const { hook } = await import('../src/commands.mjs');
  await hook(rest[0]);
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  process.exit(0);
}
if (!command || command === 'help' || command === '--help' || command === '-h') { console.log(HELP); process.exit(0); }

const commands = await import('../src/commands.mjs');

// `codex` passes everything after it straight to Codex.
if (command === 'codex') { await commands.codex(rest); process.exit(); }

if (command === 'auth') {
  const auth = await import('../src/auth.mjs');
  const sub = rest[0];
  const action = { login: auth.login, status: auth.status, logout: auth.logout }[sub];
  if (!action) { console.error(`Usage: raytrace auth login | status | logout`); process.exit(2); }
  try { await action(); process.exit(0); }
  catch (error) { console.error(`raytrace auth ${sub}: ${error.message}`); process.exit(1); }
}

// `raytrace connect <id>`: the sandbox's terminal, by the id the dashboard shows.
if (command === 'connect') {
  if (rest.length > 1 || rest[0]?.startsWith('-')) { console.error('Usage: raytrace connect [sandbox-id]'); process.exit(2); }
  const sandbox = await import('../src/sandbox.mjs');
  try { await sandbox.shell(rest[0]); process.exit(0); }
  catch (error) { console.error(`raytrace connect: ${error.message}`); process.exit(1); }
}

if (command === 'sandbox') {
  const sandbox = await import('../src/sandbox.mjs');
  let parsed;
  try {
    parsed = parseArgs({ args: rest, strict: true, allowPositionals: true, options: {
      yes: { type: 'boolean', short: 'y' },
      name: { type: 'string' },
    } });
  } catch (error) { console.error(`${error.message}\n\nRun \`raytrace help\` for usage.`); process.exit(2); }
  const [sub, id] = parsed.positionals;
  const action = {
    create: () => sandbox.create(parsed.values),
    list: () => sandbox.list(),
    shell: () => sandbox.shell(id),
    start: () => sandbox.start(id),
    stop: () => sandbox.stop(id),
    destroy: () => sandbox.destroy(id, parsed.values),
  }[sub];
  if (!action) { console.error(`Unknown sandbox command: ${sub ?? '(none)'}\n\n${HELP}`); process.exit(2); }
  try { await action(); process.exit(0); }
  catch (error) { console.error(`raytrace sandbox ${sub}: ${error.message}`); process.exit(1); }
}

let flags;
try {
  ({ values: flags } = parseArgs({ args: rest, strict: true, options: {
    yes: { type: 'boolean', short: 'y' },
    'no-claude-code': { type: 'boolean' },
    'no-start': { type: 'boolean' },
    'openrouter-key': { type: 'string' },
    purge: { type: 'boolean' },
  } }));
} catch (error) { console.error(`${error.message}\n\nRun \`raytrace help\` for usage.`); process.exit(2); }

const run = {
  setup: () => commands.setup(flags),
  start: () => commands.startCommand(),
  stop: () => commands.stopCommand(),
  status: () => commands.statusCommand(),
  open: () => commands.openCommand(),
  doctor: () => commands.doctor(),
  uninstall: () => commands.uninstall(flags),
}[command];

if (!run) { console.error(`Unknown command: ${command}\n\n${HELP}`); process.exit(2); }
try { await run(); }
catch (error) { console.error(`raytrace ${command}: ${error.message}`); process.exitCode = 1; }
