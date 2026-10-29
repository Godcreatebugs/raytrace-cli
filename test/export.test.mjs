import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEvidenceStore } from '../proxy/evidence-store.mjs';
import { exportCommand, formatTraceMarkdown, formatTraceJson } from '../src/export.mjs';

const tempDir = mkdtempSync(join(tmpdir(), 'raytrace-export-test-'));
const dbFile = join(tempDir, 'evidence.db');
process.env.RAYTRACE_HOME = tempDir;

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const PROMPT = { role: 'user', type: 'message', content: 'Run `npm test` & check <script>alert(1)</script>' };
const CALL = { type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{"command":"npm test"}' };
const RESULT = { type: 'function_call_output', call_id: 'call_1', output: 'Tests passed: 42\n```js\nconsole.log(true);\n```' };

function createTestRecord(turnId, sessionId, status = 'completed') {
  const at = Date.now();
  return {
    event_type: 'model.exchange',
    span_id: turnId,
    trace_id: turnId,
    session_id: sessionId,
    session_started_at: new Date(at - 1000).toISOString(),
    provider: 'anthropic',
    route: '/v1/messages',
    method: 'POST',
    timestamp: new Date(at).toISOString(),
    completed_at: new Date(at + 200).toISOString(),
    metrics: { cost: null, input_tokens: 15, output_tokens: 30 },
    request: {
      headers: { 'content-type': 'application/json' },
      bytes: 120,
      sha256: 'req_sha',
      payload: { model: 'claude-3-5-sonnet', input: [PROMPT] }
    },
    response: {
      status: 200,
      headers: {},
      bytes: 250,
      sha256: 'res_sha',
      payload: { output: [CALL, { type: 'message', content: 'Here is the result.' }] }
    }
  };
}

test('exportCommand rejects missing trace ID and invalid format', async () => {
  await assert.rejects(() => exportCommand(null), /Trace ID is required/);
  await assert.rejects(() => exportCommand('   '), /Trace ID is required/);
  await assert.rejects(() => exportCommand('trace_123', { format: 'yaml' }), /Invalid format: yaml/);
});

test('openEvidenceStore with readOnly: true does not modify the database or write journal', async () => {
  // Create and seed with a writable store first
  const writer = openEvidenceStore(dbFile);
  writer.recordExchange(createTestRecord('turn_readonly_1', 'sess_ro'));
  writer.close();

  const statBefore = statSync(dbFile);
  // Set fixed mtime in the past
  const past = new Date(Date.now() - 60_000);
  utimesSync(dbFile, past, past);
  const timeBefore = statSync(dbFile).mtimeMs;

  // Open read-only
  const roStore = openEvidenceStore(dbFile, { readOnly: true });
  assert.equal(roStore.journal, 'read-only');
  const rows = roStore.turnExchanges('turn_readonly_1');
  assert.equal(rows.length, 1);
  roStore.close();

  const timeAfter = statSync(dbFile).mtimeMs;
  assert.equal(timeAfter, timeBefore);
});

test('formats trace in Markdown with proper escaping and preserves status', async () => {
  const writer = openEvidenceStore(dbFile);
  const record = createTestRecord('turn_md_1', 'sess_md');
  writer.recordExchange(record);
  writer.recordToolResult('call_1', RESULT, { exchangeId: 'turn_md_1' });
  const turnId = writer.db.prepare('SELECT turn_id FROM agent_exchanges WHERE id = ?').get('turn_md_1').turn_id;
  writer.db.prepare('UPDATE agent_turns SET status = ? WHERE id = ?').run('completed', turnId);
  writer.close();

  const md = await exportCommand(turnId, { format: 'markdown' });
  assert.match(md, new RegExp(`# Trace ${turnId}`));
  assert.match(md, /\*\*Status:\*\*\s*`completed`/);
  assert.match(md, /\*\*Model:\*\*\s*`claude-3-5-sonnet`/);
  assert.match(md, /\*\*Cost:\*\*\s*`unknown`/); // null cost as unknown, not zero
  assert.match(md, /Run `npm test`/);
  assert.match(md, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/); // HTML escaped
});

test('formats trace in JSON with expected structure and export metadata', async () => {
  const writer = openEvidenceStore(dbFile);
  const turnId = writer.db.prepare('SELECT turn_id FROM agent_exchanges WHERE id = ?').get('turn_md_1').turn_id;
  writer.close();

  const jsonStr = await exportCommand(turnId, { format: 'json' });
  const data = JSON.parse(jsonStr);
  assert.equal(data.version, '1.0.0');
  assert.equal(data.trace.id, turnId);
  assert.equal(data.trace.model, 'claude-3-5-sonnet');
  assert.equal(data.trace.status, 'completed');
  assert.ok(Array.isArray(data.trace.events));
  assert.ok(Array.isArray(data.trace.requests));
});

test('exportCommand writes output file with mode 0o600 and refuses to overwrite', async () => {
  const writer = openEvidenceStore(dbFile);
  const turnId = writer.db.prepare('SELECT turn_id FROM agent_exchanges WHERE id = ?').get('turn_md_1').turn_id;
  writer.close();

  const outFile = join(tempDir, 'exported.md');
  await exportCommand(turnId, { format: 'markdown', output: outFile });
  assert.ok(existsSync(outFile));

  if (process.platform !== 'win32') {
    const mode = statSync(outFile).mode & 0o777;
    assert.equal(mode, 0o600);
  }

  // Refuse overwrite
  await assert.rejects(
    () => exportCommand(turnId, { format: 'markdown', output: outFile }),
    /File already exists/
  );
});

test('tool results remain scoped to owning session when call_ids collide', async () => {
  const writer = openEvidenceStore(dbFile);
  const turnA = 'turn_collision_a';
  const turnB = 'turn_collision_b';
  const sessA = 'sess_coll_a';
  const sessB = 'sess_coll_b';

  const recA = createTestRecord(turnA, sessA);
  const recB = createTestRecord(turnB, sessB);

  writer.recordExchange(recA);
  writer.recordToolResult('call_1', { output: 'RESULT_FROM_SESSION_A' }, { exchangeId: turnA });

  writer.recordExchange(recB);
  writer.recordToolResult('call_1', { output: 'RESULT_FROM_SESSION_B' }, { exchangeId: turnB });

  const turnIdA = writer.db.prepare('SELECT turn_id FROM agent_exchanges WHERE id = ?').get(turnA).turn_id;
  const turnIdB = writer.db.prepare('SELECT turn_id FROM agent_exchanges WHERE id = ?').get(turnB).turn_id;
  writer.close();

  const mdA = await exportCommand(turnIdA, { format: 'markdown' });
  const mdB = await exportCommand(turnIdB, { format: 'markdown' });

  assert.ok(mdA.includes('RESULT_FROM_SESSION_A'));
  assert.ok(!mdA.includes('RESULT_FROM_SESSION_B'));
  assert.ok(mdB.includes('RESULT_FROM_SESSION_B'));
  assert.ok(!mdB.includes('RESULT_FROM_SESSION_A'));
});
