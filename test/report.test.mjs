import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKER, formatReport, postComment, redactSecrets, reportCommand, summarize } from '../src/report.mjs';

const SANDBOX = 'rtp-' + 'a'.repeat(32);
const trace = (over = {}) => ({
  id: 'turn_1', status: 'complete', model: 'claude-sonnet-4', sandboxId: SANDBOX,
  requests: [{ cost: 0.01 }, { cost: 0.0234 }, { cost: null }],
  callVerifications: [
    { kind: 'command', name: 'Bash', proposed: 'npm test', verified: true, exit_code: 0 },
    { kind: 'command', name: 'Bash', proposed: 'npm run build | tee log', verified: true, exit_code: 2 },
    { kind: 'command', name: 'Bash', proposed: 'echo never', verified: false, exit_code: null },
    { kind: 'file', name: 'Edit', proposed: 'src/a.ts', verified: true,
      snapshot: { changes: [{ path: 'src/a.ts', status: 'M', added: 3, removed: 1 }, { path: 'src/b.ts', status: 'A', added: 9, removed: 0 }] } },
    { kind: 'file', name: 'Read', proposed: 'README.md', verified: true },
  ],
  ...over,
});
const quiet = () => {};

test('the summary counts commands, failures, changed files and cost', () => {
  const found = summarize(trace());
  assert.equal(found.commands.length, 3);
  assert.equal(found.failed, 1);
  assert.deepEqual(found.files.map((f) => f.path), ['src/a.ts', 'src/b.ts']);   // a read is not a change
  assert.ok(Math.abs(found.cost - 0.0334) < 1e-9);
});

test('the comment is marked, puts failures first and keeps pipes inside the cell', () => {
  const body = formatReport(trace());
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /\*\*Cost:\*\* \$0\.0334/);
  assert.match(body, /\*\*Failed:\*\* 1/);
  const rows = body.split('\n').filter((line) => line.startsWith('| ❌') || line.startsWith('| ✅') || line.startsWith('| ⚪'));
  assert.match(rows[0], /❌ 2.*npm run build &#124; tee log/);
  assert.match(body, /src\/b\.ts<\/code> A \+9 −0/);
  assert.doesNotMatch(body, /Open this run/);
});

test('secrets in command text are hidden and counted', () => {
  const key = 'sk-ant-' + 'x'.repeat(40);
  const body = formatReport(trace({ callVerifications: [
    { kind: 'command', proposed: `curl -H "x-api-key: ${key}" https://api.example`, exit_code: 0, verified: true },
    { kind: 'command', proposed: 'TOKEN=abcdefghijkl123 ./deploy', exit_code: 0, verified: true },
    { kind: 'command', proposed: 'git push https://ghp_' + 'A'.repeat(36) + '@github.com/o/r', exit_code: 0, verified: true },
  ] }));
  assert.doesNotMatch(body, /sk-ant-x/);
  assert.doesNotMatch(body, /abcdefghijkl123/);
  assert.doesNotMatch(body, /ghp_A/);
  assert.match(body, /TOKEN=\[REDACTED\]/);
  assert.match(body, /3 values that looked like secrets were hidden/);
  assert.equal(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----').text, '[REDACTED]');
  assert.equal(redactSecrets('npm test').count, 0);
});

test('a share limit gives a comment with no link', async () => {
  const api = async (method, path) => {
    assert.equal(`${method} ${path}`, 'POST /v1/shares');
    throw Object.assign(new Error('You already have 1 active share link.'), { status: 409, data: { code: 'share_limit' } });
  };
  const { body } = await reportCommand('turn_1', { link: true }, { loadLocal: async () => trace(), api, say: quiet });
  assert.doesNotMatch(body, /Open this run/);
  assert.match(body, /share links are all in use/);
});

test('a cloud run gets a full link with its expiry', async () => {
  const api = async () => ({ url: '/share/tok_123', share: { expires: 1_900_000_000 } });
  const { body } = await reportCommand('turn_1', { link: true }, { loadLocal: async () => trace(), api, say: quiet });
  assert.match(body, /\[Open this run in RayTrace\]\(https:\/\/app\.raytracer\.si\/share\/tok_123\) \(the link expires 2030-03-17/);
});

test('a local run never asks for a link', async () => {
  const api = async () => { throw new Error('must not be called'); };
  const { body } = await reportCommand('turn_1', { link: true }, { loadLocal: async () => trace({ sandboxId: 'my-local-box' }), api, say: quiet });
  assert.match(body, /this run was in a local sandbox/);
});

test('a cloud trace is read when it is not on this machine', async () => {
  const seen = [];
  const api = async (method, path) => { seen.push(`${method} ${path}`); return { traces: [trace({ id: 'other' }), trace()] }; };
  const { body } = await reportCommand('turn_1', { sandbox: SANDBOX }, { loadLocal: async () => null, api, say: quiet });
  assert.deepEqual(seen, [`GET /v1/evidence/traces?sandbox=${SANDBOX}&scope=history&evidence=1`]);
  assert.match(body, /\*\*Commands:\*\* 3/);
});

test('--dry-run prints and posts nothing, and makes no link', async () => {
  const printed = [];
  const post = () => { throw new Error('must not post'); };
  const api = async () => { throw new Error('must not make a link'); };
  const result = await reportCommand('turn_1', { pr: '12', link: true, dryRun: true }, { loadLocal: async () => trace(), api, post, say: (line) => printed.push(line) });
  assert.equal(result.posted, null);
  assert.ok(printed[0].startsWith(MARKER));
});

test('bad input is refused before anything is read', async () => {
  const loadLocal = async () => { throw new Error('must not load'); };
  await assert.rejects(reportCommand('turn_1', { pr: '12; rm -rf /' }, { loadLocal }), /Not a pull request number/);
  await assert.rejects(reportCommand('turn_1', { sandbox: 'nope' }, { loadLocal }), /Not a cloud sandbox id/);
  await assert.rejects(reportCommand('', {}, { loadLocal }), /Trace ID is required/);
});

test('posting updates only this user\'s earlier report, never another comment', () => {
  const calls = [];
  const run = (args, input) => {
    calls.push({ args, input });
    if (args[1] === 'user') return 'me\n';
    if (args[0] === 'api' && args[1].endsWith('/comments') && args.includes('--slurp')) {
      return JSON.stringify([[{ id: 1, user: { login: 'me' }, body: 'my own review' }, { id: 2, user: { login: 'bot' }, body: `${MARKER} old` }],
        [{ id: 3, user: { login: 'me' }, body: `${MARKER} old` }]]);
    }
    return '';
  };
  assert.equal(postComment(7, `${MARKER} new`, run), 'updated');
  const write = calls.at(-1);
  assert.deepEqual(write.args.slice(0, 4), ['api', '-X', 'PATCH', 'repos/{owner}/{repo}/issues/comments/3']);
  assert.equal(JSON.parse(write.input).body, `${MARKER} new`);

  calls.length = 0;
  const fresh = (args) => (args[1] === 'user' ? 'me\n' : args.includes('--slurp') ? '[[{"id":1,"user":{"login":"me"},"body":"hi"}]]' : '');
  assert.equal(postComment(7, 'x', (args, input) => { calls.push({ args, input }); return fresh(args); }), 'created');
  assert.deepEqual(calls.at(-1).args.slice(0, 4), ['api', '-X', 'POST', 'repos/{owner}/{repo}/issues/7/comments']);
});

test('without gh the comment is printed to paste', async () => {
  const printed = [];
  const post = () => { throw Object.assign(new Error('GitHub CLI (gh) not found'), { code: 'ENOENT' }); };
  const result = await reportCommand('turn_1', { pr: '12' }, { loadLocal: async () => trace(), post, say: (line) => printed.push(line) });
  assert.equal(result.posted, null);
  assert.match(printed[0], /gh\) is not installed/);
});
