import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../src/api.mjs';
import { ensureSignedIn, formatCreditDeadline, normalizeBetaCode, redeemBetaCode } from '../src/beta.mjs';

const BIN = fileURLToPath(new URL('../bin/raytrace.mjs', import.meta.url));
const future = () => new Date(Date.now() + 71 * 3_600_000).toISOString();

test('codes are normalized before they are sent', () => {
  assert.equal(normalizeBetaCode('  rtb-ab cd-12 '), 'RTB-ABCD-12');
  assert.equal(normalizeBetaCode(''), '');
});

test('deadline formatting names the date and time left', () => {
  const text = formatCreditDeadline(future());
  assert.match(text, /hours left/);
  assert.match(formatCreditDeadline(new Date(Date.now() - 1000).toISOString()), /expired/);
  assert.equal(formatCreditDeadline(null), '');
});

test('not signed in: redeem refuses before any API call is made', async () => {
  let calls = 0;
  await assert.rejects(
    redeemBetaCode('RTB-AAAA-BBBB-CCCC', {
      ensure: () => ensureSignedIn(async () => null),
      apiCall: async () => { calls += 1; },
      log: () => {},
    }),
    /Not signed in\. Run: raytrace auth login/,
  );
  assert.equal(calls, 0, 'the code must not be sent, validated, or consumed while signed out');
});

test('successful redeem announces beta, credit, deadline, and next step', async () => {
  const lines = [];
  const sent = [];
  const result = await redeemBetaCode('rtb-aaaa-bbbb-cccc', {
    ensure: async () => {},
    apiCall: async (method, path, opts) => {
      sent.push([method, path, JSON.parse(opts.body).code]);
      return { credit_usd: 10, credit_expires_at: future() };
    },
    log: (line) => lines.push(line),
  });
  assert.deepEqual(sent, [['POST', '/v1/beta/redeem', 'RTB-AAAA-BBBB-CCCC']]);
  assert.equal(result.credit_usd, 10);
  assert.match(lines.join('\n'), /good for beta testing/);
  assert.match(lines.join('\n'), /\$10/);
  assert.match(lines.join('\n'), /Beta in the RayTrace dashboard/);
  assert.match(lines.join('\n'), /raytrace sandbox create/);
});

test('invalid, expired, and stacked codes map to distinct messages', async () => {
  const attempt = (status) => redeemBetaCode('RTB-AAAA-BBBB-CCCC', {
    ensure: async () => {},
    apiCall: async () => { throw new ApiError('server said no', { status }); },
    log: () => {},
  });
  await assert.rejects(attempt(422), /isn't valid/);
  await assert.rejects(attempt(410), /expired \(codes must be redeemed within 3 days\)/);
  await assert.rejects(attempt(409), /already has beta credit, so this code was not used/);
  await assert.rejects(attempt(429), /Too many code attempts/);
  await assert.rejects(attempt(401), /Not signed in/);
});

test('a lost success response still reports the entitlement, not failure', async () => {
  const lines = [];
  let calls = 0;
  const result = await redeemBetaCode('RTB-AAAA-BBBB-CCCC', {
    ensure: async () => {},
    apiCall: async (method) => {
      calls += 1;
      if (method === 'POST') throw new Error('socket hang up');
      return { entitled: true, credit_usd: 10, credit_expires_at: future(), sandbox_consumed: false };
    },
    log: (line) => lines.push(line),
  });
  assert.equal(calls, 2);
  assert.equal(result.entitled, true);
  assert.match(lines.join('\n'), /already good for beta testing/);
});

// ---------------------------------------------------------- integration

function stubApi(state) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.url === '/v1/beta/redeem') {
        const { code } = JSON.parse(body.toString() || '{}');
        if (code === 'RTB-GOOD-CODE-0001') return json(200, { credit_usd: 10, credit_expires_at: state.expires });
        if (code === 'RTB-OLD-CODE-0002') return json(410, { error: 'expired' });
        return json(422, { error: 'invalid' });
      }
      if (req.url === '/v1/beta/status') return json(200, state.betaStatus);
      if (req.url === '/v1/sandboxes' && req.method === 'POST') {
        state.lastCreditHeader = req.headers['x-raytrace-beta-credit'] ?? null;
        return json(200, {
          id: 'rtp-0123456789abcdef0123456789abcdef', transcripts: true,
          ...(state.lastCreditHeader ? { credit_applied: true, credit_usd: 10, credit_expires_at: state.expires } : {}),
        });
      }
      return json(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function withStub(run) {
  const state = { requests: [], expires: future(), betaStatus: { entitled: false }, lastCreditHeader: undefined };
  const server = await stubApi(state);
  const home = mkdtempSync(join(tmpdir(), 'raytrace-beta-home-'));
  const env = {
    ...process.env, RAYTRACE_API_KEY: 'test-key',
    RAYTRACE_API_URL: `http://127.0.0.1:${server.address().port}`, RAYTRACE_HOME: home,
  };
  try { await run(state, env); } finally { server.close(); }
}

const cli = (args, env, cwd) => new Promise((resolve) => {
  const child = spawn(process.execPath, [BIN, ...args], { env, cwd });
  let out = ''; let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => resolve({ code, out, err }));
});

test('CLI: --code, code, and --code= redeem; bad codes and missing values fail', async () => {
  await withStub(async (state, env) => {
    const ok = await cli(['--code', 'rtb-good-code-0001'], env);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /good for beta testing/);

    const alias = await cli(['code', 'RTB-GOOD-CODE-0001'], env);
    assert.equal(alias.code, 0, alias.err);

    const equals = await cli(['--code=RTB-GOOD-CODE-0001'], env);
    assert.equal(equals.code, 0, equals.err);

    const bad = await cli(['--code', 'RTB-NOPE-NOPE-0000'], env);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /isn't valid/);

    const expired = await cli(['--code', 'RTB-OLD-CODE-0002'], env);
    assert.equal(expired.code, 1);
    assert.match(expired.err, /expired/);

    const missing = await cli(['--code'], env);
    assert.equal(missing.code, 2);
    assert.match(missing.err, /Usage: raytrace --code <code>/);

    const redeemBodies = state.requests.filter((r) => r.url === '/v1/beta/redeem').map((r) => JSON.parse(r.body.toString()).code);
    assert.ok(redeemBodies.every((code) => code === code.toUpperCase()));
  });
});

test('CLI: help lists the beta command', async () => {
  const { code, out } = await cli(['help'], { ...process.env });
  assert.equal(code, 0);
  assert.match(out, /raytrace --code <code>/);
});

test('CLI: sandbox create consumes credit once, then creates plain', async () => {
  await withStub(async (state, env) => {
    const repo = mkdtempSync(join(tmpdir(), 'raytrace-beta-repo-'));
    writeFileSync(join(repo, 'index.txt'), 'hello\n');
    spawnSync('git', ['init', '-q'], { cwd: repo });

    state.betaStatus = { entitled: true, credit_usd: 10, credit_expires_at: state.expires, sandbox_consumed: false };
    const credited = await cli(['sandbox', 'create'], env, repo);
    assert.equal(credited.code, 0, credited.err);
    assert.equal(state.lastCreditHeader, '1');
    assert.match(credited.out, /Using your \$10 beta credit/);
    assert.match(credited.out, /Beta credit applied/);

    state.betaStatus = { entitled: true, credit_usd: 10, credit_expires_at: state.expires, sandbox_consumed: true, credited_sandbox_id: 'rtp-x' };
    const plain = await cli(['sandbox', 'create'], env, repo);
    assert.equal(plain.code, 0, plain.err);
    assert.equal(state.lastCreditHeader, null);
    assert.doesNotMatch(plain.out, /Beta credit applied/);
  });
});

test('CLI: expired beta credit blocks a non-interactive create', async () => {
  await withStub(async (state, env) => {
    const repo = mkdtempSync(join(tmpdir(), 'raytrace-beta-repo-'));
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'index.txt'), 'hello\n');
    spawnSync('git', ['init', '-q'], { cwd: repo });
    state.betaStatus = {
      entitled: true, credit_usd: 10, sandbox_consumed: false,
      credit_expires_at: new Date(Date.now() - 60_000).toISOString(),
    };
    const result = await cli(['sandbox', 'create'], env, repo);
    assert.equal(result.code, 1);
    assert.match(result.err + result.out, /beta credit has expired|Beta credit expired/i);
    assert.equal(state.requests.filter((r) => r.url === '/v1/sandboxes' && r.method === 'POST').length, 0);
  });
});
