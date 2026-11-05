// A new terminal running one command, for `raytrace mcp` to open a sandbox's
// terminal next to the editor. The environment says where the agent itself
// runs (an MCP server inherits it from its client), and the new terminal goes
// there when that can be driven from outside: a tmux window beside it, an iTerm
// or WezTerm window or tab. Otherwise the system's own terminal. VS Code's
// built-in terminal cannot be opened from outside VS Code, so there it is a
// separate Terminal window.
import { spawnSync } from 'node:child_process';

/** One argument, quoted for sh. */
export const shellQuote = (arg) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`);
const appleString = (text) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const has = (program) => spawnSync('sh', ['-c', `command -v ${shellQuote(program)}`], { stdio: 'ignore' }).status === 0;

function attempt(how, program, args) {
  const result = spawnSync(program, args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 15_000 });
  if (result.error || result.status !== 0) {
    return { opened: false, how, error: (result.error?.message || result.stderr || `exit ${result.status}`).trim().split('\n').slice(-2).join(' ') };
  }
  return { opened: true, how };
}

/** Where to open it, best first: [label, program, args]. */
function candidates(args, title, env) {
  const command = args.map(shellQuote).join(' ');
  const found = [];
  if (env.TMUX && has('tmux')) found.push(['a new tmux window', 'tmux', ['new-window', '-n', title, command]]);
  if (process.platform === 'darwin') {
    if (env.TERM_PROGRAM === 'iTerm.app') {
      found.push(['a new iTerm window', 'osascript', ['-e', `tell application "iTerm"
  activate
  set w to (create window with default profile)
  tell current session of w to write text ${appleString(command)}
end tell`]]);
    }
    if (env.TERM_PROGRAM === 'WezTerm' && has('wezterm')) found.push(['a new WezTerm tab', 'wezterm', ['cli', 'spawn', '--', '/bin/sh', '-c', command]]);
    found.push(['a new Terminal window', 'osascript', ['-e', `tell application "Terminal"
  activate
  do script ${appleString(command)}
end tell`]]);
  } else if (process.platform === 'win32') {
    const line = args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(' ');
    if (spawnSync('where', ['wt'], { stdio: 'ignore' }).status === 0) found.push(['a new Windows Terminal tab', 'wt', ['new-tab', '--title', title, 'cmd', '/k', line]]);
    found.push(['a new Command Prompt window', 'cmd', ['/c', 'start', `"${title}"`, 'cmd', '/k', line]]);
  } else if (env.DISPLAY || env.WAYLAND_DISPLAY) {
    for (const [program, flag] of [['x-terminal-emulator', '-e'], ['gnome-terminal', '--'], ['konsole', '-e'], ['xfce4-terminal', '-x'],
      ['kitty', null], ['alacritty', '-e'], ['wezterm', 'start'], ['xterm', '-e']]) {
      if (has(program)) found.push([`a new ${program} window`, program, [...(flag ? [flag] : []), '/bin/sh', '-c', command]]);
    }
  }
  return found;
}

/**
 * Open a new terminal running `args` (a program and its arguments). Answers
 * { opened, how, command }: how it was opened, or why not, and the command as
 * the user would type it, for when it could not be.
 */
export function openTerminal(args, { title = 'RayTrace', env = process.env } = {}) {
  const command = args.map(shellQuote).join(' ');
  const errors = [];
  for (const [how, program, programArgs] of candidates(args, title, env)) {
    const result = attempt(how, program, programArgs);
    if (result.opened) return { opened: true, how, command };
    errors.push(`${how}: ${result.error}`);
  }
  return { opened: false, how: errors.length ? errors.join('; ') : 'no terminal found to open', command };
}
