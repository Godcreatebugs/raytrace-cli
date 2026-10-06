import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { paths } from './paths.mjs';
import { portOf, proxyEnv, readConfig, writeConfig } from './config.mjs';
import { healthy, portInUse, runningPid, start, status, stop } from './proxy-process.mjs';
import { HOOK_COMMAND, hookState, setHook } from './claude-code.mjs';
import { askSecret, confirm, interactive } from './prompt.mjs';

const say = (line = '') => console.log(line);

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

  // OpenRouter powers step summaries and `raytrace codex`.
  // Without it the proxy runs native: traces still record, those features are off.
  let openrouter = flags['openrouter-key'] ?? config.OPENROUTER_API_KEY ?? '';
  if (!yes && flags['openrouter-key'] === undefined) {
    say('\n  OpenRouter key: turns on step summaries and `raytrace codex`.');
    const entered = await askSecret(`  Paste it${openrouter ? ' (Enter keeps the current one)' : ' (Enter to skip)'}: `);
    if (entered) openrouter = entered;
  }
  writeConfig({
    ...config,
    RAYTACE_PROVIDER: openrouter ? 'openrouter' : 'native',
    OPENROUTER_API_KEY: openrouter,
  });
  say(`\n  Settings saved (only you can read ${paths.config}).`);

  if (hookClaude && !onPath('raytrace')) {
    say(`\n  Warning: \`raytrace\` is not on your PATH, and Claude Code's hook runs \`${HOOK_COMMAND}\`.`);
    say('  Install it globally so the hook can find it:  npm install -g @raytrace/cli');
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
  say(result.started ? `RayTrace is running: ${url}` : `RayTrace was already running: ${url}`);
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

// ------------------------------------------------------------------ doctor

export async function doctor() {
  let problems = 0;
  const line = (ok, label, detail) => { if (ok === false) problems += 1; say(`${ok === false ? '✗' : ok === null ? '·' : '✓'} ${label.padEnd(22)} ${detail}`); };
  const config = readConfig();
  const port = portOf(config);

  line(true, 'node', process.version);
  if (!existsSync(paths.config)) line(false, 'settings', `missing; run \`raytrace setup\``);
  else {
    const mode = statSync(paths.config).mode & 0o777;
    line(process.platform === 'win32' || (mode & 0o077) === 0, 'settings', `${paths.config}${(mode & 0o077) && process.platform !== 'win32' ? ` is readable by others (chmod 600 it)` : ''}`);
  }
  line(existsSync(paths.dashboard) ? true : false, 'dashboard', existsSync(paths.dashboard) ? 'built' : `missing from ${paths.dashboard}; reinstall`);
  line(onPath('raytrace') ? true : false, 'raytrace on PATH', onPath('raytrace') ? 'yes' : 'no: Claude Code\'s hook cannot run it (npm install -g @raytrace/cli)');

  const hooks = hookState();
  line(hooks.installed ? true : null, 'claude code hook', hooks.installed ? `installed in ${hooks.file}` : 'not installed (raytrace setup)');
  if (hooks.repoHook) line(null, 'repo hook', 'the RayTrace repo\'s hook is also installed; sessions are reported twice');

  line(config.OPENROUTER_API_KEY ? true : null, 'openrouter', config.OPENROUTER_API_KEY ? 'key set: summaries and codex on' : 'no key: summaries and codex off');

  const pid = runningPid();
  if (await healthy(port)) line(true, 'proxy', `running on :${port}${pid ? ` (pid ${pid})` : ' (started outside this CLI)'}`);
  else if (await portInUse(port)) line(false, 'proxy', `port ${port} is held by something that is not RayTrace`);
  else line(null, 'proxy', `stopped (port ${port} free)`);
  line(existsSync(paths.database) ? true : null, 'database', existsSync(paths.database) ? `${paths.database} (${(statSync(paths.database).size / 1e6).toFixed(1)} MB)` : 'not created yet; it is made on first start');

  say(problems ? `\n${problems} problem${problems === 1 ? '' : 's'} found.` : '\nNo problems found.');
  if (problems) process.exitCode = 1;
}

// ------------------------------------------------------------------ codex

export async function codex(args) {
  const config = readConfig();
  if (!config.OPENROUTER_API_KEY) { say('`raytrace codex` routes Codex through OpenRouter. Add a key with `raytrace setup` first.'); process.exitCode = 1; return; }
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
    if (purge) { rmSync(paths.home, { recursive: true, force: true }); say(`Deleted ${paths.home}.`); }
    else say(`Kept ${paths.home}.`);
  }
  say('To remove the command itself: npm uninstall -g @raytrace/cli');
}
