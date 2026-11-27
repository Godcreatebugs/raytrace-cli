import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openEvidenceStore } from './evidence-store.mjs';
import { ingestExecutions, attributeLateProcesses } from './runtime-attribution.mjs';
import { commandMarker, toExecutionEvent } from './gvisor-forwarder.mjs';
import { readTraces } from './trace-view.mjs';

const CONTAINER = 'a'.repeat(64);
const SESSION = 'rtp-' + '1'.repeat(32);
const NS = (ms) => String(BigInt(ms) * 1_000_000n);

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'raytace-attr-'));
  const store = openEvidenceStore(join(dir, 'evidence.db'));
  return Promise.resolve()
    .then(() => fn(store))
    .finally(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
}

function recordCall(store, { spanId, callId, name = 'Bash', args = {}, startedMs = Date.now(), prompt = 'run task' }) {
  store.recordExchange({
    event_type: 'model.exchange',
    session_id: SESSION,
    session_started_at: new Date(startedMs).toISOString(),
    trace_id: `trace-${spanId}`,
    span_id: spanId,
    timestamp: new Date(startedMs).toISOString(),
    completed_at: new Date(startedMs + 500).toISOString(),
    provider: 'claude-code',
    route: '/claude-code/v1/messages',
    method: 'POST',
    request: { payload: { model: 'claude-sonnet-4', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }] } },
    response: { status: 200, payload: { status: 'completed', output: [{ type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) }] } },
  });
}

function execEvent(eventId, pid, ppid, argv, ms, extra = {}) {
  return {
    event_id: eventId,
    kind: 'exec_succeeded',
    pid,
    ppid,
    argv,
    container_id: CONTAINER,
    process_start_ns: NS(ms),
    timestamp_ns: NS(ms),
    cwd: '/workspace',
    ...extra,
  };
}

test('commandMarker recognizes both single- and double-quoted export wrappers (#152)', () => {
  assert.equal(commandMarker("eval 'export RAYTRACE_CALL_ID=toolu_01abc\ncurl https://example.com'"), 'toolu_01abc');
  assert.equal(commandMarker('eval "export RAYTRACE_CALL_ID=toolu_02def; ls"'), 'toolu_02def');
});

test('weak text match is superseded when a later process arrives with RAYTRACE_CALL_ID (#152)', () => withStore(async (store) => {
  const t0 = Date.now() - 5_000;
  recordCall(store, { spanId: 'span-1', callId: 'toolu_weak_1', args: { command: 'curl -sS https://example.com' }, startedMs: t0 });

  // Simulate an earlier weak window/text attribution (e.g. a stray child process).
  const stray = store.recordProcessStart({
    containerId: CONTAINER, projectId: SESSION,
    raw: execEvent(1, 200, 10, ['tail', '-3'], t0 + 100), startedMs: t0 + 100,
  });
  const [cand] = store.candidatesInWindow(0, Number.MAX_SAFE_INTEGER, { sessionId: SESSION });
  store.attribute({ toolCallId: cand.call_id, eventId: stray.eventId, method: 'window', confidence: 'corroborated', score: 0.85 });
  assert.equal(store.divergence(['span-1'])[0].match_basis, 'window');

  // Later, the real wrapping bash with RAYTRACE_CALL_ID and its curl child arrive.
  const bashRaw = execEvent(2, 300, 10, ['/bin/bash', '-c', "eval 'export RAYTRACE_CALL_ID=toolu_weak_1\ncurl -sS https://example.com'"], t0 + 200);
  const curlRaw = execEvent(3, 301, 300, ['curl', '-sS', 'https://example.com'], t0 + 250, { markers: { RAYTRACE_CALL_ID: 'toolu_weak_1' } });
  store.recordProcessStart({ containerId: CONTAINER, projectId: SESSION, raw: bashRaw, startedMs: t0 + 200 });
  store.recordProcessStart({ containerId: CONTAINER, projectId: SESSION, raw: curlRaw, startedMs: t0 + 250 });

  await attributeLateProcesses(store, SESSION, () => {});
  const [row] = store.divergence(['span-1']);
  assert.equal(row.match_basis, 'id');
  assert.equal(row.tier, 'mediated');
  assert.equal(row.kernel_confirmed, 1);
  assert.deepEqual(row.argv, bashRaw.argv);
  assert.equal(row.descendant_count, 1);
  const descendants = store.descendants(['span-1']);
  assert.deepEqual(descendants[0].argv, ['curl', '-sS', 'https://example.com']);
}));

test('marked process whose call is not recorded yet never steals an earlier call by text (#152)', () => withStore(async (store) => {
  const t0 = Date.now() - 5_000;
  recordCall(store, { spanId: 'span-a', callId: 'toolu_call_A', args: { command: 'curl -sS https://example.com' }, startedMs: t0 });

  // Process carries RAYTRACE_CALL_ID=toolu_call_B (call B not stored yet), same command text as call A.
  const markedExec = toExecutionEvent(execEvent(10, 400, 10, ['curl', '-sS', 'https://example.com'], t0 + 300, { markers: { RAYTRACE_CALL_ID: 'toolu_call_B' } }));
  const matches = await ingestExecutions(store, [markedExec], { sessionId: SESSION });
  assert.equal(matches.size, 0, 'marked process must not fall back to text-matching another call');
  assert.equal(store.divergence(['span-a'])[0].outcome, 'not_executed');

  // Once call B arrives, late attribution joins it cleanly to call B.
  recordCall(store, { spanId: 'span-b', callId: 'toolu_call_B', args: { command: 'curl -sS https://example.com' }, startedMs: t0 + 250 });
  await attributeLateProcesses(store, SESSION, () => {});
  assert.equal(store.divergence(['span-a'])[0].outcome, 'not_executed');
  assert.equal(store.divergence(['span-b'])[0].match_basis, 'id');
  assert.equal(store.divergence(['span-b'])[0].tier, 'mediated');
}));

test('process seen before tool-call row exists joins on trace reconciliation without a second transcript (#151)', () => withStore(async (store) => {
  const t0 = Date.now() - 5_000;
  // 1. gVisor observes bash + curl BEFORE the transcript exchange is stored.
  const bashExec = toExecutionEvent(execEvent(20, 500, 10, ['/bin/bash', '-c', "source /home/node/.claude/shell-snapshots/s.sh && eval 'export RAYTRACE_CALL_ID=toolu_curl_1\ncurl -sS https://example.com'"], t0));
  const curlExec = toExecutionEvent(execEvent(21, 501, 500, ['curl', '-sS', 'https://example.com'], t0 + 50, { markers: { RAYTRACE_CALL_ID: 'toolu_curl_1' } }));
  await ingestExecutions(store, [bashExec, curlExec], { sessionId: SESSION });

  // 2. Transcript arrives later with the single Bash call (no second session).
  recordCall(store, { spanId: 'span-curl', callId: 'toolu_curl_1', args: { command: 'curl -sS https://example.com' }, startedMs: t0 + 100 });

  // 3. Traces read triggers attributeLateProcesses before readTraces (no second transcript).
  const tied = await attributeLateProcesses(store, SESSION, () => {});
  assert.equal(tied, 2);
  const [trace] = await readTraces(store, { includeHistory: true });
  const [call] = trace.callVerifications;
  assert.equal(call.call_id, 'toolu_curl_1');
  assert.equal(call.verified, true);
  assert.equal(call.kernel_confirmed, true);
  assert.equal(call.tier, 'mediated');
  assert.equal(call.match_basis, 'id');
  assert.equal(call.descendant_count, 1);
  assert.deepEqual(call.descendants[0].argv, ['curl', '-sS', 'https://example.com']);
}));

test('ingestExecutions matches RAYTRACE_CALL_ID even when transcript timestamp exceeds tight window margin (#151)', () => withStore(async (store) => {
  const t0 = Date.now() - 10_000;
  // Transcript exchange timestamp is 10s after the VM exec timestamp (past default 2s margin).
  recordCall(store, { spanId: 'span-skew', callId: 'toolu_skew_1', args: { command: 'curl https://example.com' }, startedMs: t0 + 10_000 });
  const bashExec = toExecutionEvent(execEvent(30, 600, 10, ['/bin/bash', '-c', "eval 'export RAYTRACE_CALL_ID=toolu_skew_1\ncurl https://example.com'"], t0));
  const matches = await ingestExecutions(store, [bashExec], { sessionId: SESSION });
  assert.equal(matches.size, 1);
  assert.equal(store.divergence(['span-skew'])[0].match_basis, 'id');
  assert.equal(store.divergence(['span-skew'])[0].tier, 'mediated');
}));

test('isolated Edit (no Bash) is verified=true from file fact without kernel_confirmed from /bin/true, and Read is in_agent (#150)', () => withStore(async (store) => {
  // Hook announce process must still be dropped by toExecutionEvent.
  const announce = toExecutionEvent({
    event_id: 40, kind: 'exec_succeeded', pid: 742, ppid: 741,
    executable: '/bin/true', argv: ['/bin/true', 'raytrace-tool', 'begin', 'Edit', '/workspace/slugify.py'],
    markers: { RAYTRACE_CALL_ID: 'toolu_edit_1' }, container_id: CONTAINER, timestamp_ns: NS(Date.now()),
  });
  assert.equal(announce, null, '/bin/true raytrace-tool announce must never become a process attribution');

  const t0 = Date.now() - 3_000;
  store.recordExchange({
    event_type: 'model.exchange',
    session_id: SESSION,
    session_started_at: new Date(t0).toISOString(),
    trace_id: 'trace-edit',
    span_id: 'span-edit',
    timestamp: new Date(t0).toISOString(),
    completed_at: new Date(t0 + 400).toISOString(),
    provider: 'claude-code',
    route: '/claude-code/v1/messages',
    method: 'POST',
    request: { payload: { model: 'claude-sonnet-4', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Edit slugify.py' }] }] } },
    response: {
      status: 200,
      payload: {
        status: 'completed',
        output: [
          { type: 'function_call', call_id: 'toolu_read_1', name: 'Read', arguments: JSON.stringify({ file_path: '/workspace/slugify.py' }) },
          { type: 'function_call', call_id: 'toolu_edit_1', name: 'Edit', arguments: JSON.stringify({ file_path: '/workspace/slugify.py', old_string: 'a', new_string: 'b' }) },
        ],
      },
    },
  });

  // Simulate hosted db reader returning the host-observed file fact from sandbox_facts.
  const dbWithFacts = {
    ...store,
    activityFactsForCalls: async (callIds) => new Map(
      callIds.includes('toolu_edit_1')
        ? [['toolu_edit_1', [{ kind: 'file', subject: 'slugify.py', effect: 'changed', call_from: 'tool_report', pid: 741, process: 'claude.exe' }]]]
        : [],
    ),
  };

  const [trace] = await readTraces(dbWithFacts, { includeHistory: true });
  const readCall = trace.callVerifications.find((c) => c.call_id === 'toolu_read_1');
  const editCall = trace.callVerifications.find((c) => c.call_id === 'toolu_edit_1');

  assert.equal(editCall.verified, true);
  assert.equal(editCall.file_confirmed, true);
  assert.equal(editCall.kernel_confirmed, false);
  assert.equal(editCall.source, 'file_fact');
  assert.equal(editCall.match_basis, 'tool_report');
  assert.equal(editCall.tier, 'corroborated');

  assert.equal(readCall.verified, false);
  assert.equal(readCall.kernel_confirmed, false);
  assert.equal(readCall.file_confirmed, false);
  assert.equal(readCall.status, 'in_agent', 'Read must not look like a missing command');
}));

test('command call with an activity fact carrying call_id reports join_pending instead of not_executed (#151)', () => withStore(async (store) => {
  const t0 = Date.now() - 2_000;
  recordCall(store, { spanId: 'span-net', callId: 'toolu_net_1', args: { command: 'curl https://example.com' }, startedMs: t0 });
  const dbWithFacts = {
    ...store,
    activityFactsForCalls: async (callIds) => new Map(
      callIds.includes('toolu_net_1')
        ? [['toolu_net_1', [{ kind: 'network', subject: 'example.com:443', effect: 'connect', call_from: null, pid: 800, process: 'curl' }]]]
        : [],
    ),
  };
  const [trace] = await readTraces(dbWithFacts, { includeHistory: true });
  const [call] = trace.callVerifications;
  assert.equal(call.verified, true);
  assert.equal(call.status, 'join_pending');
  assert.equal(call.kernel_confirmed, false);
  assert.equal(call.source, 'activity_fact');
  assert.equal(call.match_basis, 'id');
}));
