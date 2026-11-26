// Interactive one-time GitHub star prompt shown once a user has recorded at
// least STAR_PROMPT_THRESHOLD prompts across all agents. State lives in
// ~/.raytrace/star-prompt.json and is shared with the local dashboard popup.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { paths } from './paths.mjs';
import { confirm as promptConfirm } from './prompt.mjs';
import {
  STAR_ACTIONS,
  STAR_PROMPT_FILE,
  STAR_PROMPT_THRESHOLD,
  STAR_URL,
  WEBSITE_URL,
  readStarPromptState,
  recordStarPromptState,
  starPromptOptedOut,
} from '../proxy/star-prompt.mjs';

export {
  STAR_ACTIONS,
  STAR_PROMPT_FILE,
  STAR_PROMPT_THRESHOLD,
  STAR_URL,
  WEBSITE_URL,
  readStarPromptState,
  recordStarPromptState,
};

// Any non-empty CI value counts, including "false": the variable being set is
// the signal that this run is not a person sitting at an interactive terminal.
function ciSet(env) {
  return typeof env.CI === 'string' && env.CI !== '';
}

function machineReadable(flags) {
  if (!flags) return false;
  if (flags.yes || flags.json || flags.quiet || flags.silent) return true;
  return String(flags.format || '').toLowerCase() === 'json';
}

function suppressed(flags, env, stdout, stdin) {
  if (starPromptOptedOut(env)) return true;
  if (ciSet(env)) return true;
  if (!stdout?.isTTY || !stdin?.isTTY) return true;
  return machineReadable(flags);
}

/** Count all recorded prompt turns in the local evidence database; 0 if unavailable. */
export function recordedPromptCount(dbFile = paths.database) {
  if (!dbFile || !existsSync(dbFile)) return 0;
  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    return Number(db.prepare('SELECT COUNT(*) AS n FROM agent_turns').get()?.n ?? 0);
  } catch {
    return 0;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** Open `url` in the user's default browser, falling back to printing it. */
export function openBrowser(url, say = console.log) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => say(`Open ${url} in your browser.`));
    child.unref();
  } catch {
    say(`Open ${url} in your browser.`);
  }
}

export const starQuestion = (prompts) =>
  `You've recorded ${prompts} prompts in RayTrace. If it's been useful, open GitHub to star the repo?`;

/**
 * Ask once (when >= STAR_PROMPT_THRESHOLD prompts are recorded and this run is
 * an interactive terminal) whether to open the GitHub repo to star it.
 * Never throws. Returns whether the prompt was shown. `deps` is for tests.
 */
export async function maybeStarPrompt(flags = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const stdin = deps.stdin ?? process.stdin;
  const log = deps.log ?? ((line) => console.log(line));
  const home = deps.home ?? paths.home;
  const dbFile = deps.database ?? paths.database;
  const threshold = deps.threshold ?? STAR_PROMPT_THRESHOLD;
  const confirm = deps.confirm ?? promptConfirm;
  const openUrl = deps.openUrl ?? ((url) => openBrowser(url, log));
  const now = deps.now ?? Date.now;

  if (suppressed(flags, env, stdout, stdin)) return false;
  if (readStarPromptState(home)) return false;

  const prompts = deps.prompts !== undefined ? Math.max(0, Math.floor(Number(deps.prompts) || 0)) : recordedPromptCount(dbFile);
  if (prompts < threshold) return false;

  // Verify the home directory is usable before prompting so we never nag on every run.
  try { mkdirSync(home, { recursive: true }); } catch { return false; }

  let accepted = false;
  try {
    accepted = Boolean(await confirm(`\n${starQuestion(prompts)}`, false));
  } catch {
    try { recordStarPromptState(home, 'dismissed', 'cli', now()); } catch { /* ignore */ }
    return true;
  }

  const action = accepted ? 'opened' : 'dismissed';
  try {
    recordStarPromptState(home, action, 'cli', now());
  } catch {
    // Do not fail the user's command if ~/.raytrace is not writable.
    if (accepted) {
      openUrl(STAR_URL);
      log(`Opening ${STAR_URL} — thanks for supporting RayTrace!`);
    }
    return true;
  }

  if (accepted) {
    openUrl(STAR_URL);
    log(`Opening ${STAR_URL} — thanks for supporting RayTrace!`);
  }
  return true;
}
