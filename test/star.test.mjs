import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  maybeStarPrompt,
  recordedPromptCount,
  readStarPromptState,
  recordStarPromptState,
  STAR_PROMPT_FILE,
  STAR_PROMPT_THRESHOLD,
  STAR_URL,
  WEBSITE_URL,
  starQuestion,
} from '../src/star.mjs';
import { starPromptStatus } from '../proxy/star-prompt.mjs';
import { openEvidenceStore } from '../proxy/evidence-store.mjs';
import { setup } from '../src/commands.mjs';

const tty = { isTTY: true };
const notty = { isTTY: false };
const interactive = { env: {}, stdout: tty, stdin: tty };

function homeDir() {
  return mkdtempSync(join(tmpdir(), 'raytrace-star-'));
}

async function runPrompt(home, flags = {}, extra = {}) {
  const lines = [];
  const opened = [];
  const questions = [];
  const answer = extra.answer ?? false;
  const shown = await maybeStarPrompt(flags, {
    ...interactive,
    home,
    prompts: STAR_PROMPT_THRESHOLD,
    log: (line) => lines.push(line),
    openUrl: (url) => opened.push(url),
    confirm: async (q, fallback) => {
      questions.push({ q, fallback });
      if (extra.confirmError) throw extra.confirmError;
      return answer;
    },
    ...extra,
  });
  return {
    shown,
    lines,
    opened,
    questions,
    state: readStarPromptState(home),
    hasFile: existsSync(join(home, STAR_PROMPT_FILE)),
  };
}

describe('shared star-prompt state', { concurrency: false }, () => {
  test('threshold is 3 prompts and URLs point to the CLI repo and website', () => {
    assert.equal(STAR_PROMPT_THRESHOLD, 3);
    assert.equal(STAR_URL, 'https://github.com/Godcreatebugs/raytrace-cli');
    assert.equal(WEBSITE_URL, 'https://raytracer.si');
  });

  test('starPromptStatus becomes eligible at 3 prompts and stops after any recorded action', () => {
    const home = homeDir();
    try {
      assert.equal(starPromptStatus({ dataDir: home, prompts: 0, env: {} }).eligible, false);
      assert.equal(starPromptStatus({ dataDir: home, prompts: 2, env: {} }).eligible, false);

      const ready = starPromptStatus({ dataDir: home, prompts: 3, env: {} });
      assert.equal(ready.eligible, true);
      assert.equal(ready.prompts, 3);
      assert.equal(ready.status, 'pending');
      assert.equal(ready.url, STAR_URL);
      assert.equal(ready.website_url, WEBSITE_URL);

      assert.equal(starPromptStatus({ dataDir: home, prompts: 5, env: { RAYTRACE_NO_STAR_PROMPT: '1' } }).eligible, false);

      const saved = recordStarPromptState(home, 'already_starred', 'dashboard', 1_700_000_000_000);
      assert.equal(saved.status, 'already_starred');
      assert.equal(saved.source, 'dashboard');

      const after = starPromptStatus({ dataDir: home, prompts: 10, env: {} });
      assert.equal(after.eligible, false);
      assert.equal(after.status, 'already_starred');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('recordStarPromptState rejects invalid actions', () => {
    const home = homeDir();
    try {
      assert.throws(() => recordStarPromptState(home, 'auto_star'), /Invalid star prompt action/);
      assert.equal(existsSync(join(home, STAR_PROMPT_FILE)), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('turnCount and recordedPromptCount count all prompts across agents', async () => {
    const home = homeDir();
    const dbFile = join(home, 'evidence.db');
    try {
      assert.equal(await recordedPromptCount(dbFile), 0);
      const store = openEvidenceStore(dbFile);
      try {
        assert.equal(store.turnCount(), 0);
        const addTurn = (sessionId, provider, route, prompt, id, offsetSec) => store.recordExchange({
          event_type: 'model.exchange',
          span_id: id,
          trace_id: `trace-${id}`,
          session_id: sessionId,
          session_started_at: '2026-11-26T12:00:00.000Z',
          provider,
          route,
          method: 'POST',
          timestamp: new Date(1_790_000_000_000 + offsetSec * 1000).toISOString(),
          completed_at: new Date(1_790_000_000_400 + offsetSec * 1000).toISOString(),
          request: {
            headers: { 'content-type': 'application/json' },
            bytes: 10,
            sha256: `req-${id}`,
            payload: route === '/v1/messages'
              ? { model: 'claude-sonnet', messages: [{ role: 'user', content: prompt }] }
              : { model: 'gpt-5', input: [{ role: 'user', type: 'message', content: prompt }] },
          },
          response: {
            status: 200,
            headers: {},
            bytes: 20,
            sha256: `res-${id}`,
            payload: route === '/v1/messages'
              ? { content: [{ type: 'text', text: 'ok' }] }
              : { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] },
          },
        });
        addTurn('s1', 'anthropic', '/v1/messages', 'first prompt', 'ex-1', 1);
        addTurn('s1', 'anthropic', '/v1/messages', 'second prompt', 'ex-2', 2);
        addTurn('s2', 'openai', '/v1/responses', 'third prompt', 'ex-3', 3);
        assert.equal(store.turnCount(), 3);
      } finally {
        store.close();
      }
      assert.equal(await recordedPromptCount(dbFile), 3);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('CLI star prompt', { concurrency: false }, () => {
  test('does not ask before 3 recorded prompts and does not write state', async () => {
    const home = homeDir();
    try {
      for (const prompts of [0, 1, 2]) {
        const res = await runPrompt(home, {}, { prompts, answer: true });
        assert.equal(res.shown, false);
        assert.equal(res.questions.length, 0);
        assert.equal(res.opened.length, 0);
        assert.equal(res.hasFile, false);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('when user answers yes at >= 3 prompts, opens GitHub repo and remembers permanently', async () => {
    const home = homeDir();
    try {
      const first = await runPrompt(home, {}, { prompts: 4, answer: true });
      assert.equal(first.shown, true);
      assert.equal(first.questions.length, 1);
      assert.equal(first.questions[0].fallback, false);
      assert.equal(first.questions[0].q.includes(starQuestion(4)), true);
      assert.deepEqual(first.opened, [STAR_URL]);
      assert.equal(first.state?.status, 'opened');
      assert.equal(first.state?.source, 'cli');

      const second = await runPrompt(home, {}, { prompts: 10, answer: true });
      assert.equal(second.shown, false);
      assert.equal(second.questions.length, 0);
      assert.deepEqual(second.opened, []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('when user answers no, does not open repo and remembers permanently', async () => {
    const home = homeDir();
    try {
      const first = await runPrompt(home, {}, { prompts: 3, answer: false });
      assert.equal(first.shown, true);
      assert.deepEqual(first.opened, []);
      assert.equal(first.state?.status, 'dismissed');

      const second = await runPrompt(home, {}, { prompts: 8, answer: true });
      assert.equal(second.shown, false);
      assert.equal(second.questions.length, 0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('Ctrl-C during prompt does not throw and remembers dismissal', async () => {
    const home = homeDir();
    try {
      const res = await runPrompt(home, {}, { prompts: 3, confirmError: new Error('Cancelled.') });
      assert.equal(res.shown, true);
      assert.deepEqual(res.opened, []);
      assert.equal(res.state?.status, 'dismissed');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('already recorded from dashboard or sidebar suppresses CLI prompt', async () => {
    const home = homeDir();
    try {
      recordStarPromptState(home, 'opened', 'sidebar');
      const res = await runPrompt(home, {}, { prompts: 5, answer: true });
      assert.equal(res.shown, false);
      assert.equal(res.questions.length, 0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('opt-out env, CI, non-TTY, and machine-readable flags stay silent and do not use up the ask', async () => {
    const home = homeDir();
    try {
      const suppressedCases = [
        { flags: {}, extra: { env: { RAYTRACE_NO_STAR_PROMPT: '1' } } },
        { flags: {}, extra: { env: { RAYTRACE_NO_STAR_PROMPT: 'true' } } },
        { flags: {}, extra: { env: { CI: 'true' } } },
        { flags: {}, extra: { env: { CI: 'false' } } },
        { flags: {}, extra: { stdout: notty, stdin: tty } },
        { flags: {}, extra: { stdout: tty, stdin: notty } },
        { flags: { yes: true }, extra: {} },
        { flags: { json: true }, extra: {} },
        { flags: { quiet: true }, extra: {} },
        { flags: { silent: true }, extra: {} },
        { flags: { format: 'json' }, extra: {} },
      ];
      for (const item of suppressedCases) {
        const skipped = await runPrompt(home, item.flags, { ...item.extra, answer: true });
        assert.equal(skipped.shown, false);
        assert.equal(skipped.hasFile, false);
      }

      const later = await runPrompt(home, {}, { answer: true });
      assert.equal(later.shown, true);
      assert.deepEqual(later.opened, [STAR_URL]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('an unwritable home path does not throw or prompt', async () => {
    const dir = homeDir();
    const home = join(dir, 'not-a-directory');
    try {
      writeFileSync(home, 'occupied');
      const res = await runPrompt(home, {}, { answer: true });
      assert.equal(res.shown, false);
      assert.equal(res.questions.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('raytrace setup does not show the old star prompt', { concurrency: false }, () => {
  test('setup never prints a star URL or writes star-prompted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raytrace-star-setup-'));
    const claude = mkdtempSync(join(tmpdir(), 'raytrace-star-claude-'));
    const prev = {
      home: process.env.RAYTRACE_HOME,
      claude: process.env.CLAUDE_CONFIG_DIR,
      ci: process.env.CI,
      noStar: process.env.RAYTRACE_NO_STAR_PROMPT,
      log: console.log,
      stdout: process.stdout.isTTY,
      stdin: process.stdin.isTTY,
    };
    process.env.RAYTRACE_HOME = home;
    process.env.CLAUDE_CONFIG_DIR = claude;
    delete process.env.CI;
    delete process.env.RAYTRACE_NO_STAR_PROMPT;
    writeFileSync(join(home, 'config.env'), 'RAYTACE_PORT=1\n');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const lines = [];
    console.log = (line = '') => lines.push(String(line));
    try {
      await setup({ yes: true, 'no-claude-code': true, 'no-start': true });
      assert.equal(lines.some((line) => line.includes(STAR_URL)), false);
      assert.equal(existsSync(join(home, 'star-prompted')), false);
      assert.equal(existsSync(join(home, STAR_PROMPT_FILE)), false);
      assert.equal(readFileSync(join(home, 'config.env'), 'utf8').includes(STAR_URL), false);
    } finally {
      console.log = prev.log;
      if (prev.stdout === undefined) delete process.stdout.isTTY;
      else Object.defineProperty(process.stdout, 'isTTY', { value: prev.stdout, configurable: true });
      if (prev.stdin === undefined) delete process.stdin.isTTY;
      else Object.defineProperty(process.stdin, 'isTTY', { value: prev.stdin, configurable: true });
      if (prev.home === undefined) delete process.env.RAYTRACE_HOME;
      else process.env.RAYTRACE_HOME = prev.home;
      if (prev.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev.claude;
      if (prev.ci === undefined) delete process.env.CI;
      else process.env.CI = prev.ci;
      if (prev.noStar === undefined) delete process.env.RAYTRACE_NO_STAR_PROMPT;
      else process.env.RAYTRACE_NO_STAR_PROMPT = prev.noStar;
      rmSync(home, { recursive: true, force: true });
      rmSync(claude, { recursive: true, force: true });
    }
  });
});
