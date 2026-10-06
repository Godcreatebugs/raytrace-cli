// Where everything lives. The package's own files are found relative to this
// one; the user's data in ~/.raytrace (RAYTRACE_HOME overrides it, which is
// also how to run a second, throwaway install side by side).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const home = process.env.RAYTRACE_HOME || join(homedir(), '.raytrace');

export const paths = {
  root,
  proxy: join(root, 'proxy', 'raytace-proxy.mjs'),
  codex: join(root, 'proxy', 'codex.mjs'),
  hook: join(root, 'proxy', 'claude-code-hook.mjs'),
  dashboard: join(root, 'dist', 'dashboard'),
  home,
  config: join(home, 'config.env'),
  logs: join(home, 'logs'),
  proxyLog: join(home, 'logs', 'proxy.log'),
  run: join(home, 'run'),
  proxyPid: join(home, 'run', 'proxy.pid'),
  database: join(home, 'evidence.db'),
};

export const DEFAULT_PORT = 8797;
