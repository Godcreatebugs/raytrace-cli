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
  const entries = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => [key, String(value)]);
  const lines = entries.map(([key, value]) => `${key}=${quote(value)}`);
  const text = `# RayTrace settings. Restart with \`raytrace stop && raytrace start\` after editing.\n${lines.join('\n')}\n`;
  const parsed = parseEnv(text);
  // Validate before touching the existing settings. dotenv has no general
  // quote-escaping syntax, so some values cannot be represented losslessly.
  for (const [key, value] of entries) {
    if (parsed[key] !== value) throw new Error(`Cannot save setting ${key} without changing its value.`);
  }
  mkdirSync(paths.home, { recursive: true });
  writeFileSync(paths.config, text, { mode: 0o600 });
  chmodSync(paths.config, 0o600); // the mode above only applies when the file is new
}

// Choose a delimiter absent from the value. Backslash does not escape a
// delimiter in parseEnv; double quotes also expand literal backslash-n.
function quote(value) {
  if (!/[\s#"'`]/.test(value)) return value;
  const delimiter = ["'", '`', '"'].find((candidate) => !value.includes(candidate));
  return delimiter ? `${delimiter}${value}${delimiter}` : value;
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
