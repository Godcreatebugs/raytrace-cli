import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/raytrace.mjs', import.meta.url));

function startMcp(env = {}) {
  const child = spawn(process.execPath, [BIN, 'mcp'], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const responses = [];
  const waiters = [];

  lines.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (waiters.length) waiters.shift()(msg);
      else responses.push(msg);
    } catch {}
  });

  const send = (msg) => {
    child.stdin.write(JSON.stringify(msg) + '\n');
    return new Promise((resolve) => {
      if (responses.length) resolve(responses.shift());
      else waiters.push(resolve);
    });
  };

  const close = () => {
    child.stdin.end();
    child.kill();
  };

  return { child, send, close };
}

test('MCP: initialize negotiates protocol and returns server metadata', async (t) => {
  const mcp = startMcp();
  t.after(() => mcp.close());

  const res = await mcp.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test-editor', version: '1.0' },
    },
  });

  assert.equal(res.jsonrpc, '2.0');
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, '2025-11-25');
  assert.equal(res.result.serverInfo.name, 'raytrace');
  assert.match(res.result.serverInfo.version, /^\d+\.\d+\.\d+$/);
  assert.equal(res.result.capabilities.tools.listChanged, false);
  assert.match(res.result.instructions, /cloud sandboxes/i);
});

test('MCP: ping responds with empty result', async (t) => {
  const mcp = startMcp();
  t.after(() => mcp.close());

  const res = await mcp.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.equal(res.jsonrpc, '2.0');
  assert.equal(res.id, 2);
  assert.deepEqual(res.result, {});
});

test('MCP: tools/list returns standard cloud sandbox tools', async (t) => {
  const mcp = startMcp();
  t.after(() => mcp.close());

  const res = await mcp.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(res.id, 3);
  const tools = res.result.tools;
  assert.ok(Array.isArray(tools));
  assert.equal(tools.length, 11);

  const names = tools.map((t) => t.name);
  assert.deepEqual(names.sort(), [
    'cancel_command',
    'connect_sandbox',
    'create_sandbox',
    'destroy_sandbox',
    'get_command_result',
    'list_sandboxes',
    'login',
    'run_command',
    'sandbox_status',
    'start_sandbox',
    'stop_sandbox',
  ]);

  const create = tools.find((t) => t.name === 'create_sandbox');
  assert.equal(create.annotations.readOnlyHint, false);
  assert.equal(create.inputSchema.properties.path.type, 'string');

  const destroy = tools.find((t) => t.name === 'destroy_sandbox');
  assert.equal(destroy.annotations.destructiveHint, true);
  assert.deepEqual(destroy.inputSchema.required, ['id']);
});

test('MCP: handles unknown methods and unknown tools gracefully', async (t) => {
  const mcp = startMcp();
  t.after(() => mcp.close());

  const badMethod = await mcp.send({ jsonrpc: '2.0', id: 4, method: 'unsupported/method' });
  assert.equal(badMethod.id, 4);
  assert.equal(badMethod.error.code, -32601);
  assert.match(badMethod.error.message, /Method not found/);

  const badTool = await mcp.send({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'fictional_tool', arguments: {} },
  });
  assert.equal(badTool.id, 5);
  assert.equal(badTool.error.code, -32602);
  assert.match(badTool.error.message, /Unknown tool/);
});

test('MCP: login tool honors RAYTRACE_API_KEY environment override', async (t) => {
  const mcp = startMcp({ RAYTRACE_API_KEY: 'test-key-override' });
  t.after(() => mcp.close());

  const res = await mcp.send({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'login', arguments: {} },
  });
  assert.equal(res.id, 6);
  assert.ok(res.result.content);
  assert.match(res.result.content[0].text, /RAYTRACE_API_KEY/);
});

test('MCP: tools/call rejects unauthorized sandbox_status with tool error', async (t) => {
  const mcp = startMcp({ RAYTRACE_API_KEY: 'invalid-token-test' });
  t.after(() => mcp.close());

  const res = await mcp.send({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'sandbox_status', arguments: { id: 'invalid-id-format' } },
  });
  assert.equal(res.id, 7);
  assert.equal(res.result.isError, true);
  assert.ok(res.result.content[0].text.length > 0);
});
