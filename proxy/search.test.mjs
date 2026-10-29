import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEvidenceStore } from './evidence-store.mjs';
import { parseSearchQuery, reportedOutcome, combineOutcomes, pathsFromText } from './search.mjs';
import { failureSignature } from './failure-signature.mjs';

const SESSION = 'rtp-' + 'f'.repeat(32);
const CONTAINER = 'c'.repeat(64);
const PROMPT = { role: 'user', type: 'message', content: 'In /workspace/demo, run npm test and fix notes.md.' };
const CALL = { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"cd /workspace/demo && npm test"}' };
const EDIT = { type: 'tool_use', call_id: 'call_2', name: 'Edit', input: { file_path: '/workspace/demo/notes.md', old_string: 'a', new_string: 'b' } };
const RESULT = (call_id, output) => ({ type: 'function_call_output', call_id, output });
const HEADER = (code, body) => `Wall time: 0.4 seconds\nProcess exited with code ${code}\nOutput:\n${body}`;

let clock = 0;
const exchange = (id, input, output, { status = 200 } = {}) => ({
  event_type: 'model.exchange', span_id: id, trace_id: 't', session_id: SESSION, session_started_at: new Date(0).toISOString(),
  provider: 'openrouter', route: '/v1/responses', method: 'POST',
  timestamp: new Date(1_790_000_000_000 + (clock += 1000)).toISOString(),
  completed_at: new Date(1_790_000_000_000 + clock + 400).toISOString(), metrics: { cost: 0.001 },
  request: { headers: {}, bytes: 10, sha256: 'req', payload: { model: 'qwen', tools: [], input } },
  response: { status, headers: {}, bytes: 20, sha256: 'res', payload: { output } },
});

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'raytace-search-'));
  const file = join(dir, 'evidence.db');
  const store = openEvidenceStore(file);
  try { await run(store, file); } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
}

const FAILING = HEADER(1, "Error: Cannot find module './missing.js'");

function captureFailing(store, reported = FAILING) {
  store.recordExchange(exchange('e1', [PROMPT], [CALL, EDIT]));
  store.recordExchange(exchange('e2', [PROMPT, CALL, RESULT('call_1', reported), EDIT, { type: 'tool_result', call_id: 'call_2', content: 'edited' }],
    [{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }]));
}

test('parser: fields, phrases, negation, pipes, unknown fields', () => {
  const parsed = parseSearchQuery('outcome:failed tool:Bash "permission denied" -flaky exit:>=1 bogus:x');
  assert.deepEqual(parsed.filters, [
    { field: 'outcome', value: 'failed', negated: false },
    { field: 'tool', value: 'Bash', negated: false },
    { field: 'exit_code', value: '>=1', negated: false },
  ]);
  assert.equal(parsed.text.length, 3); // phrase, -flaky, bogus:x as text
  assert.deepEqual(parsed.errors, ['Unknown field: bogus']);
  assert.deepEqual(parseSearchQuery('failed | stats count by tool').pipe, { type: 'stats', agg: 'count', by: 'tool' });
  assert.deepEqual(parseSearchQuery('x | timechart count by model span=1d').pipe, { type: 'timechart', by: 'model', spanMs: 86_400_000 });
  assert.equal(parseSearchQuery('perm*').text[0].prefix, true);
});

test('outcome truth table: missing evidence stays unknown', () => {
  assert.equal(combineOutcomes('ok', 'failed'), 'failed');
  assert.equal(combineOutcomes('failed', 'ok'), 'failed');
  assert.equal(combineOutcomes('ok', 'unknown'), 'ok');
  assert.equal(combineOutcomes('unknown', 'ok'), 'ok');
  assert.equal(combineOutcomes('unknown', 'unknown'), 'unknown');
  assert.equal(reportedOutcome(null), 'unknown');
  assert.equal(reportedOutcome({ type: 'function_call_output', output: HEADER(2, 'boom') }), 'failed');
  assert.equal(reportedOutcome({ type: 'function_call_output', output: HEADER(0, 'fine') }), 'ok');
  assert.equal(reportedOutcome({ type: 'tool_result', is_error: true, content: 'no' }), 'failed');
});

test('failure signatures cluster volatile parts, split distinct errors', () => {
  const a = failureSignature({ errorText: 'Error: ENOENT open /Users/a/proj/src/index.js', exitCode: 1, toolName: 'Bash' });
  const b = failureSignature({ errorText: 'Error: ENOENT open /home/b/other/src/index.js', exitCode: 1, toolName: 'Bash' });
  const c = failureSignature({ errorText: 'TypeError: x is not a function', exitCode: 1, toolName: 'Bash' });
  assert.equal(a.signature, b.signature);
  assert.notEqual(a.signature, c.signature);
  const headed = failureSignature({ errorText: FAILING, exitCode: 1, toolName: 'exec_command' });
  assert.match(headed.label, /cannot find module/);
  assert.equal(failureSignature({ errorText: '' }), null);
});

test('captured failure is indexed and searchable by outcome, text and file', () => withStore((store) => {
  captureFailing(store);
  const failed = store.search({ q: 'outcome:failed kind:call' });
  assert.equal(failed.mode, 'events');
  assert.equal(failed.total, 1);
  const [hit] = failed.hits;
  assert.equal(hit.tool_name, 'exec_command');
  assert.equal(hit.outcome_reported, 'failed');
  assert.equal(hit.outcome_observed, 'unknown');
  assert.equal(hit.exit_code, 1);
  assert.ok(hit.failure_signature);
  assert.equal(hit.turn_id.length > 0, true);
  assert.equal(hit.external_call_id, 'call_1');

  assert.equal(store.search({ q: '"cannot find module"' }).total, 1);
  assert.equal(store.search({ q: 'missing' }).total >= 1, true);
  assert.equal(store.search({ q: 'missing -module' }).total, 0);
  assert.equal(store.search({ q: 'tool:Edit' }).total, 1);
  assert.equal(store.search({ q: 'file:notes.md' }).total, 1);
  assert.deepEqual([...pathsFromText('node src/parser.js && cat ./a/b.test.ts; echo v1.2 done')], ['src/parser.js', './a/b.test.ts']);
  assert.equal(store.search({ q: 'exit:1' }).total, 1);
  assert.equal(store.search({ q: 'exit:>=2' }).total, 0);
  assert.equal(store.search({ q: 'kind:turn outcome:failed' }).total, 1, 'turn inherits its failed call');
  assert.equal(failed.summary.failed, 1);
  assert.ok(failed.facets.tool.some((f) => f.value === 'exec_command'));
  assert.ok(failed.histogram.length >= 1);
}));

test('agent reported ok but sandbox saw failure is findable as a mismatch', () => withStore((store) => {
  captureFailing(store, HEADER(0, '1 passing'));
  const [candidate] = store.candidatesInWindow(0, Number.MAX_SAFE_INTEGER, { sessionId: SESSION });
  const t = candidate.window_start + 100;
  const proc = store.recordProcessStart({ containerId: CONTAINER, projectId: SESSION,
    raw: { event_id: 1, kind: 'exec_succeeded', pid: 108, ppid: 10, argv: ['/bin/bash', '-c', 'npm test'], container_id: CONTAINER, process_start_ns: '1000', timestamp_ns: String(BigInt(t) * 1_000_000n) }, startedMs: t });
  store.attribute({ toolCallId: candidate.call_id, eventId: proc.eventId, method: 'window', score: 1, windowStartMs: candidate.window_start, windowEndMs: candidate.window_end });
  store.recordProcessExit({ containerId: CONTAINER,
    raw: { event_id: 2, kind: 'process_exit', pid: 108, container_id: CONTAINER, process_start_ns: '1000', exit_code: 1, timestamp_ns: String(BigInt(t + 300) * 1_000_000n) }, endedMs: t + 300, exit_code: 1 });

  const mismatch = store.search({ q: 'reported:ok observed:failed' });
  assert.equal(mismatch.total, 1);
  assert.equal(mismatch.hits[0].outcome, 'failed');
  assert.equal(mismatch.hits[0].exit_code, 1);
  assert.equal(mismatch.summary.mismatched, 1);
}));

test('unanswered call with no process stays unknown, pipes aggregate', () => withStore((store) => {
  store.recordExchange(exchange('e1', [PROMPT], [CALL]));
  const unknown = store.search({ q: 'outcome:unknown kind:call' });
  assert.equal(unknown.total, 1);
  assert.equal(unknown.hits[0].failure_signature, null);

  captureFailing(store);
  const stats = store.search({ q: '| stats count by outcome' });
  assert.equal(stats.mode, 'stats');
  assert.ok(stats.rows.some((row) => row.key === 'failed' && row.count >= 1));
  const chart = store.search({ q: 'failed | timechart count by tool span=1d' });
  assert.equal(chart.mode, 'timechart');
  assert.ok(chart.rows.length >= 1);

  const clusters = store.failureSignatures({});
  assert.equal(clusters.length, 1);
  assert.match(clusters[0].label, /cannot find module/);
}));

test('backfill fills the index for captures that predate it; reindex rebuilds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'raytace-search-backfill-'));
  const file = join(dir, 'evidence.db');
  try {
    const first = openEvidenceStore(file);
    captureFailing(first);
    first.db.exec('DELETE FROM search_events');
    assert.equal(first.search({ q: 'outcome:failed' }).total, 0);
    first.close();
    const reopened = openEvidenceStore(file);
    try {
      assert.equal(reopened.search({ q: 'outcome:failed kind:call' }).total, 1, 'reopen backfills');
      reopened.db.exec('DELETE FROM search_events');
      assert.ok(reopened.reindexSearch() >= 3);
      assert.equal(reopened.search({ q: 'outcome:failed kind:call' }).total, 1);
    } finally { reopened.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
