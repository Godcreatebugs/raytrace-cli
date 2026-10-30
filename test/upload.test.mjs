import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEvidenceStore } from '../proxy/evidence-store.mjs';
import { pickSandbox, sandboxStats, snapshotEvidences } from '../src/upload.mjs';

const exchange = (id, session) => ({
  event_type: 'model.exchange', span_id: id, trace_id: 't', session_id: session,
  session_started_at: new Date(0).toISOString(), provider: 'openrouter', route: '/v1/responses', method: 'POST',
  timestamp: new Date(1_790_000_000_000).toISOString(), completed_at: new Date(1_790_000_000_400).toISOString(),
  metrics: {},
  request: { headers: {}, bytes: 1, sha256: 'r', payload: { model: 'qwen', input: [{ role: 'user', type: 'message', content: 'hi' }] } },
  response: { status: 200, headers: {}, bytes: 1, sha256: 's', payload: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] } },
});

test('pickSandbox resolves by id, by name, and the only sandbox', () => {
  const boxes = { 'rtp-1': { name: 'alpha' } };
  assert.equal(pickSandbox(null, boxes).id, 'rtp-1');
  assert.equal(pickSandbox('alpha', boxes).id, 'rtp-1');
  assert.equal(pickSandbox('rtp-1', boxes).name, 'alpha');
  assert.throws(() => pickSandbox('nope', boxes), /No local sandbox named nope/);
  assert.throws(() => pickSandbox(null, {}), /No local sandboxes yet/);
  assert.throws(() => pickSandbox(null, { a: { name: 'a' }, b: { name: 'b' } }), /More than one local sandbox/);
});

test('snapshotEvidences makes a readable copy and sandboxStats counts its exchanges', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'raytrace-upload-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'evidence.db');
  const sandbox = 'rtp-' + 'c'.repeat(32);
  const store = openEvidenceStore(file);
  store.recordExchange(exchange('u1', sandbox));
  store.close();
  const { dir: snapDir, plain } = snapshotEvidences(file);
  t.after(() => rm(snapDir, { recursive: true, force: true }));
  const stats = sandboxStats(plain, sandbox);
  assert.equal(stats.exchanges, 1);
  assert.equal(stats.turns, 1);
  assert.equal(sandboxStats(plain, 'rtp-' + 'd'.repeat(32)).exchanges, 0);
});

