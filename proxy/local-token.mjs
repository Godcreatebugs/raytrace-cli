/**
 * The local API's credential: a random token in the data folder, readable only
 * by the user who runs RayTrace. Binding to 127.0.0.1 keeps the network out and
 * the Origin and Host checks keep web pages out, but neither says anything
 * about another account on the same machine; this file's mode does.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FILE = 'api-token';

/** The data folder of a caller the CLI did not start, such as the Claude Code hook. */
export const dataFolder = () => process.env.RAYTACE_DATA_DIR || process.env.RAYTRACE_HOME || join(homedir(), '.raytrace');

export function readToken(folder = dataFolder()) {
  try { return readFileSync(join(folder, FILE), 'utf8').trim() || null; } catch { return null; }
}

/** The token, made on first use. Also closes the folder: what is recorded in it
 * (prompts, tool output) is as private as the token. */
export function ensureToken(folder = dataFolder()) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  try { chmodSync(folder, 0o700); } catch { /* not ours to change, or a filesystem without modes */ }
  try { writeFileSync(join(folder, FILE), `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  chmodSync(join(folder, FILE), 0o600);
  return readToken(folder);
}
