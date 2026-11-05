import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SID = 'rtp-' + 'a'.repeat(32);
const CID = 'cmd-' + 'b'.repeat(32);
const record = (extra = {}) => ({ command_id: CID, sandbox_id: SID, state: 'completed', exit_code: 0, stdout: '', stderr: '', timed_out: false, output_truncated: false, created_at: 1, ...extra });

/** The real `raytrace mcp` process speaking JSON-RPC on stdio, against a fake RayTrace API.
 * `respond({method, path, body}, callNumber)` returns [status, json]. */
async function mcp(t, respond) {
  const calls = [];
  const api = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const call = { method: req.method, path: req.url, body: raw ? JSON.parse(raw) : null };
      calls.push(call);
      const [status, body] = respond(call, calls.length);
      // Like the real control API (Python, HTTP/1.0): one request per connection. Node 26 delays a reused connection by ~2 s after a 1 s idle.
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const home = await mkdtemp(join(tmpdir(), 'raytrace-mcp-commands-'));
  const child = spawn(process.execPath, ['bin/raytrace.mjs', 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, RAYTRACE_HOME: home, RAYTRACE_API_KEY: 'test-only-key', RAYTRACE_API_URL: `http://127.0.0.1:${api.address().port}` } });
  t.after(async () => { child.kill(); await new Promise((resolve) => api.close(resolve)); await rm(home, { recursive: true, force: true }); });
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
  const call = async (name, args) => { const { result } = await rpc('tools/call', { name, arguments: args }); return { ...result, text: result.content[0].text }; };
  return { rpc, call, calls, init };
}

test('the command tools are listed with accurate hints, and the instructions send the agent to them, not to a terminal', async (t) => {
  const { rpc, init } = await mcp(t, () => [200, {}]);
  const tools = (await rpc('tools/list', {})).result.tools, byName = (name) => tools.find((x) => x.name === name);
  assert.equal(tools.length, 11);
  assert.equal(byName('run_command').annotations.readOnlyHint, false);
  assert.equal(byName('get_command_result').annotations.readOnlyHint, true);
  assert.equal(byName('cancel_command').annotations.readOnlyHint, false);
  for (const name of ['run_command', 'get_command_result']) assert.match(byName(name).description, /untrusted/i, name);
  assert.match(init.instructions, /run_command/);
  assert.match(init.instructions, /get_command_result/);
  assert.match(init.instructions, /cannot drive|can't drive|interactive terminal/i, 'it explains why raytrace connect is for the user');
});

test('run_command starts the command in the sandbox with a retry-safe request id', async (t) => {
  const { call, calls } = await mcp(t, () => [202, record({ state: 'queued', exit_code: null })]);
  const started = await call('run_command', { id: SID, command: 'npm test' });
  assert.equal(started.isError, undefined);
  assert.deepEqual([calls[0].method, calls[0].path], ['POST', `/v1/sandboxes/${SID}/commands`]);
  assert.equal(calls[0].body.command, 'npm test');
  assert.equal(calls[0].body.timeout_seconds, 120);
  assert.match(calls[0].body.request_id, /^[A-Za-z0-9_-]{8,100}$/);
  assert.match(started.text, new RegExp(CID));
  assert.match(started.text, /get_command_result/);
  assert.equal(started.structuredContent.command_id, CID);
  await call('run_command', { id: SID, command: 'ls', timeout_seconds: 600, request_id: 'my-retry-key-1' });
  assert.deepEqual([calls[1].body.timeout_seconds, calls[1].body.request_id], [600, 'my-retry-key-1']);
  await call('run_command', { id: SID, command: 'ls' });
  assert.notEqual(calls[2].body.request_id, calls[0].body.request_id, 'two separate calls are two separate commands');
});

test('bad input is refused before anything reaches the server', async (t) => {
  const { call, calls } = await mcp(t, () => [202, record()]);
  const bad = [{ id: 'rtp-short', command: 'ls' }, { id: SID, command: '' }, { id: SID, command: 'x'.repeat(16001) }, { id: SID, command: 'a\0b' },
    { id: SID, command: 5 }, { id: SID, command: 'ls', timeout_seconds: 0 }, { id: SID, command: 'ls', timeout_seconds: 1801 },
    { id: SID, command: 'ls', timeout_seconds: 1.5 }, { id: SID, command: 'ls', request_id: 'short' }, { id: SID, command: 'ls', request_id: 'has spaces in it' }];
  for (const args of bad) assert.equal((await call('run_command', args)).isError, true, JSON.stringify(args).slice(0, 60));
  for (const args of [{ id: SID, command_id: 'cmd-nope' }, { id: SID, command_id: CID, wait_seconds: 31 }, { id: SID, command_id: CID, wait_seconds: -1 }, { id: 'x', command_id: CID }]) {
    assert.equal((await call('get_command_result', args)).isError, true, JSON.stringify(args));
  }
  assert.equal((await call('cancel_command', { id: SID, command_id: 'nope' })).isError, true);
  assert.equal(calls.length, 0);
});

test('get_command_result reports the real exit code and never turns unknown into success', async (t) => {
  let answer;
  const { call, calls } = await mcp(t, () => [200, answer]);
  answer = record({ exit_code: 1, stdout: 'ran 3 tests\n', stderr: 'FAIL: widget\n' });
  const failed = await call('get_command_result', { id: SID, command_id: CID });
  assert.deepEqual([calls[0].method, calls[0].path], ['GET', `/v1/sandboxes/${SID}/commands/${CID}`]);
  assert.match(failed.text, /completed/); assert.match(failed.text, /exit code 1/i);
  assert.match(failed.text, /FAIL: widget/); assert.match(failed.text, /untrusted/i);
  assert.equal(failed.structuredContent.exit_code, 1);
  answer = record({ state: 'interrupted', exit_code: null, recovery_pending: true });
  const unknown = await call('get_command_result', { id: SID, command_id: CID });
  assert.match(unknown.text, /exit code unknown/i);
  assert.doesNotMatch(unknown.text, /succe|exit code 0/i);
  assert.match(unknown.text, /poll again|try again|not reached/i, 'a recovering command is not reported as over');
  answer = record({ state: 'timed_out', exit_code: null, timed_out: true });
  assert.match((await call('get_command_result', { id: SID, command_id: CID })).text, /timed_out/);
});

test('long output is cut to its tail, where failures are, and says so', async (t) => {
  const { call } = await mcp(t, () => [200, record({ stdout: 'HEAD-' + 'x'.repeat(200_000) + '-THE-END', output_truncated: true })]);
  const result = await call('get_command_result', { id: SID, command_id: CID });
  assert.ok(result.text.length < 60_000, `${result.text.length} chars`);
  assert.match(result.text, /-THE-END/); assert.doesNotMatch(result.text, /HEAD-/);
  assert.match(result.text, /earlier characters omitted/i);
  assert.match(result.text, /1 MiB|truncated|dropped/i, "the server's own truncation is reported too");
  assert.ok(JSON.stringify(result.structuredContent).length < 60_000, 'structured output is bounded as well');
});

test('wait_seconds waits for a running command instead of making the agent poll', async (t) => {
  const states = ['running', 'running', 'completed'];
  const { call, calls } = await mcp(t, (_, n) => [200, record({ state: states[Math.min(n - 1, 2)], exit_code: n >= 3 ? 0 : null, stdout: n >= 3 ? 'done' : '' })]);
  const started = Date.now();
  const result = await call('get_command_result', { id: SID, command_id: CID, wait_seconds: 10 });
  assert.equal(calls.length, 3);
  assert.match(result.text, /completed/); assert.match(result.text, /done/);
  assert.ok(Date.now() - started < 6000, 'it stops as soon as the command is over');
});

test('waiting continues past an interrupted command whose host could not be reached: that is not the end yet', async (t) => {
  const { call, calls } = await mcp(t, (_, n) => [200, n === 1 ? record({ state: 'interrupted', exit_code: null, recovery_pending: true }) : record({ state: 'completed', exit_code: 0, stdout: 'recovered' })]);
  const result = await call('get_command_result', { id: SID, command_id: CID, wait_seconds: 5 });
  assert.equal(calls.length, 2);
  assert.match(result.text, /completed, exit code 0/); assert.match(result.text, /recovered/);
});

test('wait_seconds gives up on schedule and says the command is still running', async (t) => {
  const { call, calls } = await mcp(t, () => [200, record({ state: 'running', exit_code: null })]);
  const started = Date.now();
  const result = await call('get_command_result', { id: SID, command_id: CID, wait_seconds: 1 });
  assert.ok(Date.now() - started < 4000);
  assert.ok(calls.length >= 1 && calls.length <= 3);
  assert.match(result.text, /still running/i);
  assert.equal(result.isError, undefined);
});

test('cancel_command asks the server to stop the command and its process group', async (t) => {
  const { call, calls } = await mcp(t, () => [200, record({ state: 'cancelled', exit_code: null })]);
  const result = await call('cancel_command', { id: SID, command_id: CID });
  assert.deepEqual([calls[0].method, calls[0].path, calls[0].body], ['POST', `/v1/sandboxes/${SID}/commands/${CID}/cancel`, {}]);
  assert.match(result.text, /cancel/i);
});

test('a server that cannot run commands yet is reported plainly, with the terminal route as the fallback', async (t) => {
  let answer = [404, { error: 'Not found' }];
  const { call } = await mcp(t, () => answer);
  for (const [name, args] of [['run_command', { id: SID, command: 'ls' }], ['get_command_result', { id: SID, command_id: CID }], ['cancel_command', { id: SID, command_id: CID }]]) {
    const result = await call(name, args);
    assert.equal(result.isError, true, name);
    assert.match(result.text, /does not support running commands yet/i, name);
    assert.match(result.text, new RegExp(`raytrace connect ${SID}`), name);
  }
  answer = [404, { error: 'No such sandbox' }];
  const missing = await call('run_command', { id: SID, command: 'ls' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /No such sandbox/);
  assert.doesNotMatch(missing.text, /does not support/, 'a missing sandbox is not blamed on the server version');
  answer = [429, { error: 'This sandbox already has 4 commands running. Wait for one to finish or cancel one, then try again.' }];
  assert.match((await call('run_command', { id: SID, command: 'ls' })).text, /already has 4 commands running/);
});
