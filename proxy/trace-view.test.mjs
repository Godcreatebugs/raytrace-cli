import test from 'node:test';
import assert from 'node:assert/strict';
import { readTraces } from './trace-view.mjs';

test('synthesizes terminal tool results for proposed calls with no subsequent exchange', async () => {
  const fakeRow = {
    span_id: 'span-1',
    trace_id: 'trace-1',
    session_id: 'rtp-12345678123456781234567812345678',
    provider: 'claude-code',
    timestamp: '2026-10-28T12:00:00.000Z',
    promptTitle: 'test prompt',
    request: {
      payload: {
        model: 'claude-3-5-sonnet',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run exit 7' }] }]
      }
    },
    response: {
      payload: {
        output: [
          {
            type: 'function_call',
            call_id: 'toolu_term_1',
            name: 'Bash',
            arguments: JSON.stringify({ command: 'exit 7' })
          }
        ]
      }
    }
  };

  const fakeDb = {
    exchangeRows: async () => [fakeRow],
    divergence: async () => [],
    descendants: async () => [],
    snapshotsForCalls: async () => new Map(),
    toolCallResult: async (callId) => {
      if (callId === 'toolu_term_1') {
        return { call_id: 'toolu_term_1', is_error: true, exit_code: 7, output: 'Process exited with code 7' };
      }
      return null;
    }
  };

  const traces = await readTraces(fakeDb, { includeHistory: true });
  assert.equal(traces.length, 1);
  const trace = traces[0];

  const resultEvent = trace.events.find((e) => e.title.startsWith('Tool result:') && e.raw.includes('toolu_term_1'));
  assert.ok(resultEvent, 'terminal tool result event was synthesized into trace.events');
  const parsed = JSON.parse(resultEvent.raw);
  assert.equal(parsed.call_id, 'toolu_term_1');
  assert.equal(parsed.exit_code, 7);
  assert.equal(parsed.is_error, true);
});

test('toolResultsFromTranscript extracts tool results from user messages', async () => {
  const { toolResultsFromTranscript } = await import('./claude-code-adapter.mjs');
  const lines = [
    { type: 'user', message: { content: [{ type: 'text', text: 'hello' }] } },
    { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'call_99', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call_99', content: 'file.txt', is_error: false }] } }
  ];
  const results = toolResultsFromTranscript(lines);
  assert.equal(results.size, 1);
  assert.deepEqual(results.get('call_99'), {
    type: 'function_call_output',
    call_id: 'call_99',
    output: 'file.txt'
  });
});
