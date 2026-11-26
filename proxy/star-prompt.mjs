// Shared state for the one-time GitHub star prompt across the CLI and the
// local dashboard. Kept in ~/.raytrace/star-prompt.json so acting on either
// surface permanently remembers the choice for both, with zero outbound calls.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STAR_URL = 'https://github.com/Godcreatebugs/raytrace-cli';
export const WEBSITE_URL = 'https://raytracer.si';
export const STAR_PROMPT_THRESHOLD = 3;
export const STAR_PROMPT_FILE = 'star-prompt.json';
export const STAR_ACTIONS = new Set(['opened', 'already_starred', 'dismissed']);
const STAR_SOURCES = new Set(['cli', 'dashboard', 'sidebar']);

export function starPromptOptedOut(env = process.env) {
  const value = env?.RAYTRACE_NO_STAR_PROMPT;
  return value === '1' || value === 'true';
}

/** Read the saved star-prompt state from `dataDir`, or null when pending/missing. */
export function readStarPromptState(dataDir) {
  if (!dataDir) return null;
  const file = join(dataDir, STAR_PROMPT_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !STAR_ACTIONS.has(parsed.status)) return null;
    return {
      status: parsed.status,
      source: STAR_SOURCES.has(parsed.source) ? parsed.source : 'cli',
      at: typeof parsed.at === 'string' ? parsed.at : null,
    };
  } catch {
    return null;
  }
}

/** Persist the user's star-prompt choice in `dataDir` with owner-only permissions. */
export function recordStarPromptState(dataDir, action, source = 'cli', now = Date.now()) {
  if (!STAR_ACTIONS.has(action)) throw new Error(`Invalid star prompt action: ${action}`);
  const safeSource = STAR_SOURCES.has(source) ? source : 'cli';
  const state = { status: action, source: safeSource, at: new Date(now).toISOString() };
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, STAR_PROMPT_FILE);
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* filesystem without POSIX modes */ }
  return state;
}

/** Eligibility and metadata for the star prompt given `dataDir` and recorded prompt count. */
export function starPromptStatus({ dataDir, prompts = 0, threshold = STAR_PROMPT_THRESHOLD, env = process.env } = {}) {
  const count = Math.max(0, Math.floor(Number(prompts) || 0));
  const state = readStarPromptState(dataDir);
  const eligible = !starPromptOptedOut(env) && !state && count >= threshold;
  return {
    eligible,
    prompts: count,
    threshold,
    status: state?.status ?? 'pending',
    url: STAR_URL,
    website_url: WEBSITE_URL,
  };
}
