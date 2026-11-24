// create_sandbox's github option: the real `raytrace mcp` process, run in a
// real Git repository, against a fake RayTrace API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectScript } from '../src/github.mjs';

const SID = 'rtp-' + '0123456789abcdef'.repeat(2);
const BIN = new URL('../bin/raytrace.mjs', import.meta.url).pathname;
const CONNECTED = 'Connected to acme/app on branch raytrace/01234567/work. Push with: git push -u origin raytrace/01234567/work\n';

/** A Git repository with one commit and main pushed to `origin` (as this machine last saw it). */
function project(t, origin) {
  const root = mkdtempSync(join(tmpdir(), 'raytrace-mcp-github-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8' }).trim();
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  writeFileSync(join(root, 'app.js'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'x');
  git('remote', 'add', 'origin', origin);
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { root, head: git('rev-parse', 'HEAD') };
}

/** The MCP server in `cwd` against a fake API; `state` holds the attached repositories, a refusal, and the setup command's answer. */
async function mcp(t, cwd, state) {
  const calls = [];
  const api = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = req.headers['content-type'] === 'application/json' && raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, path: req.url, body });
      const route = `${req.method} ${req.url}`;
      let answer = [404, { error: 'Not found' }];
      if (route === 'POST /v1/sandboxes') answer = [201, { id: SID, name: 'app', status: 'running', transcripts: true }];
      else if (route === `GET /v1/sandboxes/${SID}/repos`) answer = [200, { id: SID, repos: state.repos }];
      else if (route === `PUT /v1/sandboxes/${SID}/repos`) {
        answer = state.refuse ? [400, { error: state.refuse }] : [200, { id: SID, repos: (state.repos = body.repos) }];
      } else if (route === `POST /v1/sandboxes/${SID}/commands`) answer = [202, { command_id: 'cmd-' + 'c'.repeat(32), ...state.command }];
      res.writeHead(answer[0], { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(answer[1]));
    });
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const home = mkdtempSync(join(tmpdir(), 'raytrace-mcp-home-'));
  const child = spawn(process.execPath, [BIN, 'mcp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, RAYTRACE_HOME: home, RAYTRACE_API_KEY: 'test-only-key', RAYTRACE_API_URL: `http://127.0.0.1:${api.address().port}`, RAYTRACE_NO_UPDATE_CHECK: '1' } });
  t.after(async () => { child.kill(); await new Promise((resolve) => api.close(resolve)); rmSync(home, { recursive: true, force: true }); });
  const waiting = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.trim()) { const message = JSON.parse(line); waiting.get(message.id)?.(message); }
    }
  });
  let next = 1;
  const rpc = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const init = (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result;
  const create = async (args) => { const { result } = await rpc('tools/call', { name: 'create_sandbox', arguments: { connect: false, ...args } }); return { ...result, text: result.content[0].text }; };
  const routes = () => calls.map((call) => `${call.method} ${call.path}`).filter((route) => !route.includes('/beta/'));
  return { rpc, init, create, calls, routes };
}

test('create_sandbox lists github and github_repo, and the instructions say what they do', async (t) => {
  const { root } = project(t, 'git@github.com:acme/app.git');
  const { rpc, init } = await mcp(t, root, { repos: [] });
  const props = (await rpc('tools/list', {})).result.tools.find((tool) => tool.name === 'create_sandbox').inputSchema.properties;
  assert.equal(props.github.type, 'boolean');
  assert.equal(props.github_repo.type, 'string');
  assert.match(init.instructions, /github: true/);
  assert.match(init.instructions, /never main/);
});

test('github: true uploads, then connects the sandbox to the origin, lined up with this commit', async (t) => {
  const { root, head } = project(t, 'https://github.com/acme/app.git');
  const state = { repos: [], command: { state: 'completed', exit_code: 0, stdout: CONNECTED, stderr: '' } };
  const { create, calls, routes } = await mcp(t, root, state);
  const result = await create({ github: true });
  assert.ok(!result.isError, result.text);
  assert.deepEqual(routes(), ['POST /v1/sandboxes', `GET /v1/sandboxes/${SID}/repos`, `PUT /v1/sandboxes/${SID}/repos`, `POST /v1/sandboxes/${SID}/commands`]);
  assert.deepEqual(state.repos, ['acme/app']);
  assert.equal(calls.find((call) => call.path.endsWith('/commands')).body.command, connectScript({ repo: 'acme/app', sandboxId: SID, commit: head, ref: 'main' }));
  assert.match(result.text, /is a clone of acme\/app on branch raytrace\/01234567\/work\. Its agent may push only to raytrace\/01234567\/<branch>/);
  assert.deepEqual(result.structuredContent.github, { repo: 'acme/app', connected: true });
});

test('github_repo connects another repository, at its default branch', async (t) => {
  const { root } = project(t, 'git@github.com:acme/app.git');
  const state = { repos: [], command: { state: 'completed', exit_code: 0, stdout: CONNECTED.replace('acme/app', 'acme/other'), stderr: '' } };
  const { create, calls } = await mcp(t, root, state);
  const result = await create({ github: true, github_repo: 'acme/other' });
  assert.ok(!result.isError, result.text);
  assert.deepEqual(state.repos, ['acme/other']);
  assert.equal(calls.find((call) => call.path.endsWith('/commands')).body.command, connectScript({ repo: 'acme/other', sandboxId: SID }));
});

test('what cannot be connected is refused before anything is uploaded', async (t) => {
  const { root } = project(t, 'https://gitlab.com/acme/app.git');
  const { create, routes } = await mcp(t, root, { repos: [] });
  for (const [args, message] of [
    [{ github: true }, /origin is not on GitHub\. Pass github_repo/],
    [{ github: true, github_repo: 'gitlab.com/acme/app' }, /github_repo is not a GitHub repository/],
    [{ github_repo: 'acme/app' }, /github_repo goes with github: true/],
    [{ github: true, local: true }, /cloud sandboxes only/],
  ]) {
    const result = await create(args);
    assert.ok(result.isError, JSON.stringify(args));
    assert.match(result.text, message);
  }
  assert.deepEqual(routes(), []);
});

test('a refused connect still reports the sandbox, says it is not connected, and how to retry', async (t) => {
  const { root } = project(t, 'git@github.com:acme/app.git');
  const refusal = 'Install the RayTrace GitHub App on acme/app and connect it on your account page first.';
  const { create, routes } = await mcp(t, root, { repos: [], refuse: refusal });
  const result = await create({ github: true });
  assert.ok(!result.isError, 'the sandbox exists: not an error');
  assert.match(result.text, new RegExp(`^Sandbox ${SID} is running\\.`));
  assert.ok(result.text.includes(`It is NOT connected to GitHub: ${refusal}`), result.text);
  assert.ok(result.text.includes(`raytrace sandbox repos ${SID} --add acme/app --connect`), result.text);
  assert.deepEqual(result.structuredContent.github, { repo: 'acme/app', connected: false });
  assert.ok(!routes().some((route) => route.endsWith('/commands')));
});

test('without github, create_sandbox never touches repositories', async (t) => {
  const { root } = project(t, 'git@github.com:acme/app.git');
  const { create, routes } = await mcp(t, root, { repos: [] });
  const result = await create({});
  assert.ok(!result.isError, result.text);
  assert.deepEqual(routes(), ['POST /v1/sandboxes']);
  assert.equal(result.structuredContent.github, undefined);
});
