// Where everything lives. The package's own files are found relative to this
// one; the user's data in ~/.raytrace (RAYTRACE_HOME overrides it, which is
// also how to run a second, throwaway install side by side).
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const home = () => process.env.RAYTRACE_HOME || join(homedir(), '.raytrace');

export const paths = {
  root,
  proxy: join(root, 'proxy', 'raytace-proxy.mjs'),
  codex: join(root, 'proxy', 'codex.mjs'),
  hook: join(root, 'proxy', 'claude-code-hook.mjs'),
  dashboard: join(root, 'dist', 'dashboard'),
  get home() { return home(); },
  get config() { return join(home(), 'config.env'); },
  get logs() { return join(home(), 'logs'); },
  get proxyLog() { return join(home(), 'logs', 'proxy.log'); },
  get run() { return join(home(), 'run'); },
  get proxyPid() { return join(home(), 'run', 'proxy.pid'); },
  get database() { return join(home(), 'evidence.db'); },
};

// How this copy was installed, for the commands we suggest: pip's wheel keeps
// the npm package in raytrace/app/ (python/build_wheels.py), next to its own Node.js.
const fromPip = basename(root) === 'app' && basename(dirname(root)) === 'raytrace';
export const install = fromPip
  ? { add: 'pip install raytrace', remove: 'pip uninstall raytrace', run: 'uvx raytrace' }
  : { add: 'npm install -g @raytrace-cli/cli', remove: 'npm uninstall -g @raytrace-cli/cli', run: 'npx -y @raytrace-cli/cli' };

export const DEFAULT_PORT = 8797;
