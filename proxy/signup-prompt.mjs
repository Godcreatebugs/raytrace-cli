// Shared state and eligibility for the Phase 2 local dashboard card:
// primary CTA to create a free RayTrace account, with a lightweight weekly
// newsletter email fallback. Shown at most once per machine, only after >= 10
// prompts AND >= 24 hours after the Phase 1 star prompt was resolved, and
// never if this machine has already signed into RayTrace Cloud.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStarPromptState, starPromptOptedOut } from './star-prompt.mjs';

export const SIGNUP_URL = 'https://raytracer.si/sign-in.html?src=local-dashboard';
export const SIGNUP_PROMPT_THRESHOLD = 10;
export const STAR_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const SIGNUP_PROMPT_FILE = 'signup-prompt.json';
export const ACCOUNT_LINKED_FILE = 'account-linked';
export const CREDENTIALS_FILE = 'credentials.json';
export const SIGNUP_ACTIONS = new Set(['clicked_signup', 'subscribed', 'dismissed']);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validEmail(value) {
  const clean = String(value ?? '').trim().toLowerCase();
  return clean.length <= 254 && EMAIL_RE.test(clean) ? clean : null;
}

/** True when this machine has ever signed into RayTrace Cloud via the CLI. */
export function hasLinkedAccount(dataDir) {
  if (!dataDir) return false;
  return existsSync(join(dataDir, ACCOUNT_LINKED_FILE)) || existsSync(join(dataDir, CREDENTIALS_FILE));
}

/** Read saved signup-prompt state from `dataDir`, or null when pending/missing. */
export function readSignupPromptState(dataDir) {
  if (!dataDir) return null;
  const file = join(dataDir, SIGNUP_PROMPT_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !SIGNUP_ACTIONS.has(parsed.status)) return null;
    return {
      status: parsed.status,
      source: typeof parsed.source === 'string' ? parsed.source : 'local-dashboard',
      at: typeof parsed.at === 'string' ? parsed.at : null,
    };
  } catch {
    return null;
  }
}

/** Persist the user's signup/newsletter card choice in `dataDir` with 0600 permissions. */
export function recordSignupPromptState(dataDir, action, source = 'local-dashboard', now = Date.now()) {
  if (!SIGNUP_ACTIONS.has(action)) throw new Error(`Invalid signup prompt action: ${action}`);
  const state = { status: action, source, at: new Date(now).toISOString() };
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, SIGNUP_PROMPT_FILE);
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* filesystem without POSIX modes */ }
  return state;
}

/** Eligibility and metadata for the Phase 2 local dashboard card. */
export function signupPromptStatus({
  dataDir,
  prompts = 0,
  threshold = SIGNUP_PROMPT_THRESHOLD,
  cooldownMs = STAR_COOLDOWN_MS,
  env = process.env,
  now = Date.now(),
} = {}) {
  const count = Math.max(0, Math.floor(Number(prompts) || 0));
  const state = readSignupPromptState(dataDir);
  const starState = readStarPromptState(dataDir);
  const starAt = starState?.at ? Date.parse(starState.at) : NaN;
  const starCooledDown = Number.isFinite(starAt) && (now - starAt) >= cooldownMs;
  const eligible = !starPromptOptedOut(env)
    && !state
    && !hasLinkedAccount(dataDir)
    && count >= threshold
    && starCooledDown;
  return {
    eligible,
    prompts: count,
    threshold,
    status: state?.status ?? 'pending',
    signup_url: SIGNUP_URL,
  };
}
