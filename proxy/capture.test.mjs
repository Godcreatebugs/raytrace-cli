import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSseResponse } from './capture.mjs';
import { splitExchange } from './trace-view.mjs';

const sse = (events) => Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
const exchange = (payload, input = []) => ({
  span_id: 'test-span', timestamp: '2026-10-28T00:00:00Z',
  request: { payload: { input } }, response: { status: 200, payload },
});

test('all supported tool result types reach the timeline with their content and identity', () => {
  const input = [
    { type: 'function_call_output', call_id: 'function-1', output: 'ordinary result' },
    { type: 'custom_tool_call_output', call_id: 'custom-1', output: 'patch result' },
    { type: 'tool_result', call_id: 'native-1', content: 'native result' },
  ];
  const events = splitExchange(exchange({ status: 'completed', output: [] }, input))
    .filter((event) => event.title.startsWith('Tool result:'));
  assert.deepEqual(events.map((event) => JSON.parse(event.raw)), input);
});

for (const status of ['completed', 'failed', 'incomplete']) {
  test(`streamed ${status} response preserves terminal status, details and output for the dashboard`, () => {
    const response = {
      status,
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial or final answer' }] }],
      ...(status === 'failed' ? { error: { code: 'server_error', message: 'synthetic failure' } } : {}),
      ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    };
    const parsed = parseSseResponse(sse([
      { type: 'response.created', response: { status: 'in_progress', output: [] } },
      { type: `response.${status}`, response },
    ]));
    assert.deepEqual(parsed, response);
    const events = splitExchange(exchange(parsed));
    assert.equal(JSON.parse(events.at(-1).raw).response_status, status);
    assert.ok(events.some((event) => event.title === 'Model answer'));
  });
}

test('a stream without a terminal response retains raw events without claiming a completed model response', () => {
  const events = [{ type: 'response.created', response: { status: 'in_progress', output: [] } },
    { type: 'response.output_text.delta', delta: 'unfinished' }];
  const parsed = parseSseResponse(sse(events));
  assert.deepEqual(parsed, { stream: true, events });
  assert.equal(parsed.status, undefined);
  assert.equal(parseSseResponse(Buffer.from('data: [DONE]\n\n')), null);
});
