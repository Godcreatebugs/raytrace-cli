import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { call, ApiError } from '../src/api.mjs';

function setup(t, response) {
  const home = mkdtempSync(join(tmpdir(), 'raytrace-api-json-'));
  const changes = { RAYTRACE_HOME: home, RAYTRACE_API_KEY: 'test-key', RAYTRACE_API_URL: 'https://api.test' };
  const before = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  Object.assign(process.env, changes);
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', async () => response);
}

test('a truncated successful JSON response is not reported as success', async t => {
  setup(t, new Response('{"id":', { status: 201 }));
  await assert.rejects(call('POST', '/v1/sandboxes', { autoLogin: false }), /Invalid JSON response/);
});

test('a response body read failure is reported as a connection failure', async t => {
  setup(t, new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection reset')); } })));
  await assert.rejects(call('GET', '/v1/sandboxes', { autoLogin: false }), /Cannot reach RayTrace/);
});

test('empty and whitespace-only successful responses remain supported', async t => {
  setup(t, new Response(null, { status: 204 }));
  assert.deepEqual(await call('DELETE', '/v1/sandboxes/test', { autoLogin: false }), {});
  setup(t, new Response('  \n', { status: 200 }));
  assert.deepEqual(await call('DELETE', '/v1/sandboxes/test', { autoLogin: false }), {});
});

test('non-JSON and null-JSON HTTP errors retain their status', async t => {
  setup(t, new Response('<h1>Bad Gateway</h1>', { status: 502 }));
  await assert.rejects(call('GET', '/v1/sandboxes', { autoLogin: false }),
    error => error instanceof ApiError && error.status === 502 && error.message === 'HTTP 502');
  setup(t, new Response('null', { status: 500 }));
  await assert.rejects(call('GET', '/v1/sandboxes', { autoLogin: false }),
    error => error instanceof ApiError && error.status === 500 && error.message === 'HTTP 500');
});

test('valid responses still return parsed data', async t => {
  setup(t, Response.json([{ id: 'rtp-test' }]));
  assert.deepEqual(await call('GET', '/v1/sandboxes', { autoLogin: false }), [{ id: 'rtp-test' }]);
});
