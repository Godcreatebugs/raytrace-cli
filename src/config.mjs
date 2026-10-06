// ~/.raytrace/config.env: the same KEY=value settings the proxy has always
// read from .env, kept in one place readable only by the user since it holds
// API keys.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { DEFAULT_PORT, paths } from './paths.mjs';

export function readConfig() {
  if (!existsSync(paths.config)) return {};
  return parseEnv(readFileSync(paths.config, 'utf8'));
}

export function writeConfig(values) {
  mkdirSync(paths.home, { recursive: true });
  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${quote(String(value))}`);
  writeFileSync(paths.config, `# RayTrace settings. Restart with \`raytrace stop && raytrace start\` after editing.\n${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(paths.config, 0o600); // the mode above only applies when the file is new
}

// Single quotes are taken literally by parseEnv, so JSON values (a custom
// RAYTACE_OPENROUTER_MODELS) survive a round trip; double quotes otherwise.
function quote(value) {
  if (!/[\s#"'`]/.test(value)) return value;
  return value.includes("'") ? `"${value}"` : `'${value}'`;
}

export const portOf = (config) => Number(config.RAYTACE_PORT || DEFAULT_PORT);

/** The environment the proxy and the Codex launcher run with. */
export function proxyEnv(config = readConfig()) {
  return {
    ...process.env,
    ...config,
    RAYTACE_PORT: String(portOf(config)),
    RAYTACE_DATA_DIR: paths.home,
    RAYTACE_DASHBOARD_DIR: paths.dashboard,
  };
}
