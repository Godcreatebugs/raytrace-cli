import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readToken } from './local-token.mjs';
import { openEvidenceStore } from './evidence-store.mjs';
import { readStarPromptState, STAR_URL, WEBSITE_URL } from './star-prompt.mjs';

test('proxy /raytace/star-prompt: enforces auth, checks 3-prompt threshold, and persists choice', { timeout: 20000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'raytace-star-proxy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const dbFile = join(directory, 'evidence.db');
  const seed = (count) => {
    const store = openEvidenceStore(dbFile);
    try {
      for (let i = 1; i <= count; i++) {
        store.recordExchange({
          event_type: 'model.exchange',
          span_id: `ex-star-${i}`,
          trace_id: `trace-star-${i}`,
          session_id: i === 3 ? 'session-codex' : 'session-claude',
          session_started_at: '2026-11-26T12:00:00.000Z',
          provider: i === 3 ? 'openai' : 'anthropic',
          route: i === 3 ? '/v1/responses' : '/v1/messages',
          method: 'POST',
          timestamp: new Date(1_790_000_000_000 + i * 1000).toISOString(),
          completed_at: new Date(1_790_000_000_400 + i * 1000).toISOString(),
          request: {
            headers: { 'content-type': 'application/json' },
            bytes: 10,
            sha256: `req-star-${i}`,
            payload: i === 3
              ? { model: 'gpt-5', input: [{ role: 'user', type: 'message', content: `Prompt number ${i}` }] }
              : { model: 'claude-sonnet', messages: [{ role: 'user', content: `Prompt number ${i}` }] },
          },
          response: {
            status: 200,
            headers: {},
            bytes: 20,
            sha256: `res-star-${i}`,
            payload: i === 3
              ? { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }
              : { content: [{ type: 'text', text: 'ok' }] },
          },
        });
      }
    } finally {
      store.close();
    }
  };
  seed(2);

  const env = {
    ...process.env,
    RAYTACE_PORT: '0',
    RAYTACE_DATA_DIR: directory,
    RAYTACE_DB: dbFile,
  };
  delete env.RAYTRACE_NO_STAR_PROMPT;

  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'proxy/raytace-proxy.mjs'], {
    cwd: join(import.meta.dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; });
  const url = await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
    child.stderr.on('data', (chunk) => reject(new Error(String(chunk))));
    child.on('exit', (code) => reject(new Error(`Proxy exited before startup (${code})`)));
  });

  // Unauthenticated access is rejected.
  const unauth = await fetch(`${url}/raytace/star-prompt`);
  assert.equal(unauth.status, 401);

  const signedIn = { authorization: `Bearer ${readToken(directory)}` };

  // With 2 prompts, not yet eligible.
  const two = await fetch(`${url}/raytace/star-prompt`, { headers: signedIn }).then((r) => r.json());
  assert.equal(two.eligible, false);
  assert.equal(two.prompts, 2);
  assert.equal(two.status, 'pending');

  // After a 3rd prompt is recorded, eligible becomes true.
  seed(3);
  const three = await fetch(`${url}/raytace/star-prompt`, { headers: signedIn }).then((r) => r.json());
  assert.equal(three.eligible, true);
  assert.equal(three.prompts, 3);
  assert.equal(three.url, STAR_URL);
  assert.equal(three.website_url, WEBSITE_URL);

  // POST without dashboard CSRF header is rejected.
  const noCsrf = await fetch(`${url}/raytace/star-prompt`, {
    method: 'POST',
    headers: { ...signedIn, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'opened' }),
  });
  assert.equal(noCsrf.status, 403);

  // POST with invalid action returns 400.
  const badAction = await fetch(`${url}/raytace/star-prompt`, {
    method: 'POST',
    headers: { ...signedIn, 'content-type': 'application/json', 'x-raytace-experiment': '1' },
    body: JSON.stringify({ action: 'bogus' }),
  });
  assert.equal(badAction.status, 400);

  // POST with valid action persists to star-prompt.json and disables eligibility permanently.
  const saved = await fetch(`${url}/raytace/star-prompt`, {
    method: 'POST',
    headers: { ...signedIn, 'content-type': 'application/json', 'x-raytace-experiment': '1' },
    body: JSON.stringify({ action: 'opened', source: 'dashboard' }),
  });
  assert.equal(saved.status, 200);
  const savedJson = await saved.json();
  assert.equal(savedJson.ok, true);
  assert.equal(savedJson.state.status, 'opened');
  assert.equal(savedJson.state.source, 'dashboard');

  assert.equal(readStarPromptState(directory)?.status, 'opened');

  const after = await fetch(`${url}/raytace/star-prompt`, { headers: signedIn }).then((r) => r.json());
  assert.equal(after.eligible, false);
  assert.equal(after.status, 'opened');
});
