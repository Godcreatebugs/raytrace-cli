import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { paths } from './paths.mjs';
import { portOf, proxyEnv, readConfig, writeConfig } from './config.mjs';
import { checkRunningPid, healthy, portInUse, runningPid, start, status, stop } from './proxy-process.mjs';
import { HOOK_COMMAND, hookState, setHook } from './claude-code.mjs';
import { askSecret, confirm, interactive } from './prompt.mjs';

const say = (line = '') => console.log(line);
const CLOUD_URL = 'https://app.raytracer.si';

/** Whether `name` resolves on PATH: the Claude Code hook calls `raytrace` by name. */
function onPath(name) {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  return (process.env.PATH || '').split(delimiter).some((dir) => exts.some((ext) => {
    try { accessSync(join(dir, name + ext), constants.X_OK); return true; } catch { return false; }
  }));
}

function openUrl(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => say(`Open ${url} in your browser.`)).unref();
}

const claudeCodePresent = () => onPath('claude') || existsSync(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));

// ------------------------------------------------------------------ setup

export async function setup(flags) {
  const yes = flags.yes || !interactive();
  mkdirSync(paths.home, { recursive: true });
  const config = readConfig();
  say(`RayTrace setup. Settings go in ${paths.config}.\n`);

  // Claude Code: recorded through its hook, no proxy routing needed.
  const hooks = hookState();
  let hookClaude = !flags['no-claude-code'];
  if (hookClaude && !yes) hookClaude = await confirm(hooks.installed ? 'Keep recording Claude Code sessions?' : 'Record Claude Code sessions?', true);
  else if (hookClaude && !claudeCodePresent()) hookClaude = false;
  if (hookClaude) { const file = setHook(); say(`  Claude Code: hook ${hooks.installed ? 'kept' : 'added'} in ${file}`); }
  else if (hooks.installed) { setHook({ remove: true }); say('  Claude Code: hook removed'); }
  else say('  Claude Code: not recorded');
  if (hooks.repoHook) say('  Note: the RayTrace repo\'s own Claude Code hook is also installed; sessions will be reported by both.');

  // Setup never asks for an OpenRouter key: recording needs none. A key passed
  // with --openrouter-key (or already saved) turns on local step summaries and
  // `raytrace codex`; without one the proxy runs native and those are off.
  const openrouter = flags['openrouter-key'] ?? config.OPENROUTER_API_KEY ?? '';
  writeConfig({
    ...config,
    RAYTACE_PROVIDER: openrouter ? 'openrouter' : 'native',
    OPENROUTER_API_KEY: openrouter,
  });
  say(`\n  Settings saved (only you can read ${paths.config}).`);
  say('\n  Cloud sandboxes (preview): run your agent on RayTrace\'s servers, no API key to add.');
  say(`  raytrace auth login, then in a Git repository: raytrace sandbox create   (or on the web: ${CLOUD_URL})`);

  if (hookClaude && !onPath('raytrace')) {
    say(`\n  Warning: \`raytrace\` is not on your PATH, and Claude Code's hook runs \`${HOOK_COMMAND}\`.`);
    say('  Install it globally so the hook can find it:  npm install -g @raytrace-cli/cli');
  }

  // A proxy this CLI started is restarted so the new settings apply.
  const port = portOf(readConfig());
  if (runningPid()) { await stop(); say('\nRestarting RayTrace with the new settings.'); await startCommand(); return; }
  if (await healthy(port)) { say(`\nA RayTrace proxy started outside this CLI is answering on :${port}; stop it to use these settings.`); return; }
  if (flags['no-start'] || (!yes && !(await confirm('\nStart RayTrace now?', true)))) { say('\nRun `raytrace start` when you are ready.'); return; }
  await startCommand({ open: !yes });
}

// --------------------------------------------------------- start / stop / status

export async function startCommand({ open = false } = {}) {
  const result = await start();
  const url = `http://127.0.0.1:${result.port}`;
  say(result.replaced ? `RayTrace restarted with this version (an older one was running): ${url}`
    : result.started ? `RayTrace is running: ${url}` : `RayTrace was already running: ${url}`);
  if (!result.started && !result.pid) say('  (started outside this CLI, e.g. from the RayTrace repo; `raytrace stop` will not stop it)');
  say(`  Logs: ${paths.proxyLog}`);
  if (open) openUrl(url);
}

export async function stopCommand() {
  const result = await stop();
  if (result.stopped) say(`RayTrace stopped (pid ${result.pid}).`);
  else if (result.foreign) say(`A RayTrace proxy not started by this CLI is answering on :${result.port}. Stop it where it was started.`);
  else say('RayTrace is not running.');
}

export async function statusCommand() {
  const state = await status();
  const hooks = hookState();
  say(`proxy        ${state.healthy ? `running  ${state.url}${state.pid ? ` (pid ${state.pid})` : ' (started outside this CLI)'}` : state.pid ? `pid ${state.pid}, not answering` : 'stopped'}`);
  say(`claude code  ${hooks.installed ? 'recording' : 'not recorded (raytrace setup)'}`);
  say(`data         ${paths.home}`);
}

export async function openCommand() {
  const state = await status();
  if (!state.healthy) { say('RayTrace is not running. Start it with `raytrace start`.'); process.exitCode = 1; return; }
  openUrl(state.url);
  say(`Opening ${state.url}`);
}

// ------------------------------------------------------------------ keys

// The keys the dashboard's AI features run on: the user's own, kept in
// config.env (readable only by them) and used only by the proxy here.
const KEYS = {
  openrouter: { name: 'OPENROUTER_API_KEY', label: 'OpenRouter', where: 'https://openrouter.ai/keys',
    turnsOn: 'step summaries, command descriptions, run recaps and Chain of thought, and `raytrace codex`',
    models: 'Qwen3 Coder (Chain of thought), gpt-oss-120b (summaries), Claude Sonnet 5.5 (recaps)' },
  typesafe: { name: 'TYPESAFE_API_KEY', label: 'TypeSafe (Jev)', where: 'your TypeSafe account',
    turnsOn: 'ranking Chain of thought\'s causes and rating each command\'s severity' },
};
const masked = (value) => (value ? `set (…${value.slice(-4)})` : 'not set');

/**
 * `raytrace key` lists the keys; `raytrace key <openrouter|typesafe>` asks for
 * one (typed without echo, or piped in) and saves it; `--remove` deletes it.
 * The key is never taken as an argument, so it stays out of shell history.
 */
export async function keyCommand(which, flags) {
  const config = readConfig();
  if (!which) {
    for (const [id, key] of Object.entries(KEYS)) say(`${id.padEnd(11)} ${masked(config[key.name])}   ${key.turnsOn}`);
    say('\nAdd one: raytrace key openrouter   (or typesafe). Remove one: raytrace key openrouter --remove');
    return;
  }
  const key = KEYS[which];
  if (!key) throw new Error(`Unknown key "${which}". Use: raytrace key openrouter | typesafe`);
  let value = '';
  if (!flags.remove) {
    if (interactive()) {
      say(`Your ${key.label} key turns on ${key.turnsOn}. Get one at ${key.where}.`);
      if (key.models) say(`Calls are made on your key and billed to you; models: ${key.models}.`);
      value = await askSecret(`${key.label} key: `);
    } else {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      value = Buffer.concat(chunks).toString('utf8').trim();
    }
    if (!value) throw new Error('No key given; nothing changed.');
    if (/\s/.test(value)) throw new Error('That does not look like a key (it has spaces); nothing changed.');
  }
  const next = { ...config, [key.name]: value };
  if (which === 'openrouter') next.RAYTACE_PROVIDER = value ? 'openrouter' : 'native';
  writeConfig(next);
  say(value ? `${key.label} key saved in ${paths.config} (only you can read it).` : `${key.label} key removed.`);
  // A proxy this CLI started is restarted so the key applies.
  if (runningPid()) { await stop(); await start(); say('RayTrace restarted with it.'); }
  else if (await healthy(portOf(readConfig()))) say('A RayTrace proxy started outside this CLI is running; restart it to use this.');
}

// ------------------------------------------------------------------ doctor

export async function doctor() {
  let problems = 0;
  const line = (ok, label, detail) => { if (ok === false) problems += 1; say(`${ok === false ? '✗' : ok === null ? '·' : '✓'} ${label.padEnd(22)} ${detail}`); };
  let config;
  try { config = readConfig(); } catch (err) { config = {}; line(false, 'settings', `malformed config: ${err.message}`); }
  const port = portOf(config);

  line(true, 'node', process.version);
  if (!existsSync(paths.config)) line(false, 'settings', `missing; run \`raytrace setup\``);
  else {
    try {
      const mode = statSync(paths.config).mode & 0o777;
      line(process.platform === 'win32' || (mode & 0o077) === 0, 'settings', `${paths.config}${(mode & 0o077) && process.platform !== 'win32' ? ` is readable by others (chmod 600 it)` : ''}`);
    } catch (err) {
      line(false, 'settings', `cannot inspect ${paths.config}: ${err.message}`);
    }
  }
  line(existsSync(paths.dashboard) ? true : false, 'dashboard', existsSync(paths.dashboard) ? 'built' : `missing from ${paths.dashboard}; reinstall`);
  line(onPath('raytrace') ? true : false, 'raytrace on PATH', onPath('raytrace') ? 'yes' : 'no: Claude Code\'s hook cannot run it (npm install -g @raytrace-cli/cli)');

  try {
    const hooks = hookState();
    if (!hooks.installed) {
      line(null, 'claude code hook', `not installed (${hooks.file}); run \`raytrace setup\``);
    } else if (!hooks.valid) {
      const issues = [];
      if (hooks.missingEvents.length) issues.push(`missing: ${hooks.missingEvents.join(', ')}`);
      if (hooks.invalidType) issues.push('invalid hook type (expected command)');
      if (hooks.invalidMatcher) issues.push('restricted PostToolUse matcher (must be *)');
      if (hooks.duplicates) issues.push('duplicate hooks detected');
      line(false, 'claude code hook', `misconfigured in ${hooks.file} (${issues.join('; ')}); run \`raytrace setup\``);
    } else {
      line(true, 'claude code hook', `installed and valid in ${hooks.file}`);
    }
    if (hooks.repoHook) line(null, 'repo hook', 'the RayTrace repo\'s hook is also installed; sessions are reported twice');
  } catch (error) {
    line(false, 'claude code hook', `cannot read settings: ${error.message}`);
  }

  line(config.OPENROUTER_API_KEY ? true : null, 'openrouter', config.OPENROUTER_API_KEY ? 'key set: AI features on' : 'no key: AI features off (raytrace key openrouter)');

  const pid = checkRunningPid();
  try {
    if (await healthy(port)) line(true, 'proxy', `running on :${port}${pid ? ` (pid ${pid})` : ' (started outside this CLI)'}`);
    else if (await portInUse(port)) line(false, 'proxy', `port ${port} is held by something that is not RayTrace`);
    else line(null, 'proxy', `stopped (port ${port} free)`);
  } catch (err) {
    line(false, 'proxy', `connectivity check failed: ${err.message}`);
  }

  const bridgePort = Number(process.env.RAYTRACE_BRIDGE_PORT || 8799);
  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/raytace/identity`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      const info = await res.json();
      line(true, 'sandbox bridge', `listening on :${bridgePort} (${info.service} v${info.version})`);
    } else {
      line(false, 'sandbox bridge', `port ${bridgePort} returned HTTP ${res.status}`);
    }
  } catch {
    line(null, 'sandbox bridge', `not responding on :${bridgePort} (starts with proxy)`);
  }

  line(existsSync(paths.database) ? true : null, 'database', existsSync(paths.database) ? `${paths.database} (${(statSync(paths.database).size / 1e6).toFixed(1)} MB)` : 'not created yet; it is made on first start');

  // Local sandboxes are optional: what they lack is shown, not counted as a problem.
  say('\nLocal sandboxes (raytrace sandbox create --local):');
  try {
    const { checks } = await import('./lima.mjs');
    const { vmStatus, inVm } = await import('./local-sandbox.mjs');
    let vm = null;
    try { vm = vmStatus(); } catch { /* no Lima yet */ }
    const rows = await checks({ vmRunning: vm === 'Running', runInVm: inVm });
    for (const { ok, label, detail, fix } of rows) say(`${ok === false ? '✗' : ok === null ? '·' : '✓'} ${label.padEnd(22)} ${detail}${fix ? `\n  ${''.padEnd(22)} fix: ${fix}` : ''}`);
    if (vm) say(`· ${'vm'.padEnd(22)} raytrace: ${vm.toLowerCase()}`);
    else if (rows.every((row) => row.ok !== false)) say(`· ${'vm'.padEnd(22)} not created yet; the first local sandbox makes it`);
  } catch (err) {
    say(`· ${'vm checks'.padEnd(22)} skipped (${err.message})`);
  }

  say(problems ? `\n${problems} problem${problems === 1 ? '' : 's'} found.` : '\nNo problems found.');
  if (problems) process.exitCode = 1;
}

// ------------------------------------------------------------------ codex

export async function codex(args) {
  const config = readConfig();
  if (!config.OPENROUTER_API_KEY) { say('`raytrace codex` routes Codex through OpenRouter. Add a key first: raytrace setup --openrouter-key <key>'); process.exitCode = 1; return; }
  if (!(await healthy(portOf(config)))) await startCommand();
  const child = spawn(process.execPath, [paths.codex, ...args], { stdio: 'inherit', env: proxyEnv(config) });
  await new Promise((done) => child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); done(); }));
}

// ------------------------------------------------------------------ hook

/** Called by Claude Code on each hook event; must stay fast and silent. */
export async function hook(agent) {
  if (agent !== 'claude-code') return;
  try { process.env.RAYTACE_PORT = String(portOf(readConfig())); } catch { /* default port */ }
  await import(paths.hook);
}

// ------------------------------------------------------------------ uninstall

export async function uninstall(flags) {
  const yes = flags.yes || !interactive();
  const stopped = await stop();
  if (stopped.stopped) say('Stopped RayTrace.');
  if (hookState().installed) say(`Removed the Claude Code hook from ${setHook({ remove: true })}.`);
  if (existsSync(paths.home)) {
    const purge = flags.purge || (!yes && await confirm(`Delete ${paths.home} (recorded sessions and settings)?`, false));
    if (purge) {
      // Before the folder goes: the Lima that RayTrace downloaded, which removes the VM, is in it.
      const { deleteVm } = await import('./local-sandbox.mjs');
      try { if (deleteVm()) say('Deleted the local sandbox VM (raytrace) and its sandboxes.'); }
      catch (error) { say(`The local sandbox VM was not deleted (${error.message.split('\n')[0]}); limactl delete --force raytrace removes it.`); }
      rmSync(paths.home, { recursive: true, force: true });
      say(`Deleted ${paths.home}.`);
    }
    else say(`Kept ${paths.home}.`);
  }
  say('To remove the command itself: npm uninstall -g @raytrace-cli/cli');
}
