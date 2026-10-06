// RayTrace's hook in Claude Code's user settings (~/.claude/settings.json).
// Adds or removes only its own entries, leaving every other setting and hook
// as it was; the previous file is kept as settings.json.raytrace-backup.
//
// The hook runs `raytrace hook claude-code`, not a path into this package: a
// path breaks the day the package moves (an update, a cleared npx cache) and
// Claude Code then records nothing, silently.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// After each tool, when Claude finishes answering, and when the session ends.
const EVENTS = ['PostToolUse', 'Stop', 'SubagentStop', 'SessionEnd'];
export const HOOK_COMMAND = 'raytrace hook claude-code';
const settingsFile = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');

const isOurs = (hook) => hook?.command === HOOK_COMMAND;
// The RayTrace repo's own hook (proxy/claude-code-install.mjs). Left alone,
// but worth knowing about: both would report the same sessions.
const isRepoHook = (hook) => typeof hook?.command === 'string' && hook.command.includes('claude-code-hook.mjs');

function readSettings() {
  const file = settingsFile();
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${file} is not valid JSON (${error.message}); fix it, then try again.`); }
}

function allHooks(settings) {
  return EVENTS.flatMap((event) => (settings.hooks?.[event] ?? []).flatMap((group) => group.hooks ?? []));
}

export function hookState() {
  const settings = readSettings();
  const hooks = allHooks(settings);
  return { file: settingsFile(), installed: EVENTS.every((event) => (settings.hooks?.[event] ?? []).some((group) => (group.hooks ?? []).some(isOurs))), repoHook: hooks.some(isRepoHook) };
}

/** Installs (or with remove, removes) the hook. Returns the settings file. */
export function setHook({ remove = false } = {}) {
  const file = settingsFile();
  const settings = readSettings();
  settings.hooks ??= {};
  for (const event of EVENTS) {
    const groups = (settings.hooks[event] ?? [])
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook)) }))
      .filter((group) => group.hooks.length);
    if (!remove) groups.push({ ...(event === 'PostToolUse' ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 5 }] });
    if (groups.length) settings.hooks[event] = groups; else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.raytrace-backup`);
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}
