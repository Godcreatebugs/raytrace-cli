import test from 'node:test';
import assert from 'node:assert/strict';
import { requestMetrics } from './request-metrics.mjs';

test('Anthropic streaming keeps initial input tokens and the latest cumulative output count', () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 150, output_tokens: 1 } } },
    { type: 'message_delta', usage: { output_tokens: 12 } },
    { type: 'message_delta', usage: { output_tokens: 24 } },
    { type: 'message_stop' },
  ];
  assert.deepEqual(requestMetrics({ provider: 'anthropic', response: { payload: { events } } }),
    { input: 150, output: 24, cost: null, durationMs: null });
  assert.equal(requestMetrics({ provider: 'anthropic', response: { payload: { events: events.slice(0, 1) } } }).output, 1);
});

test('direct usage still takes precedence over streaming events', () => {
  const payload = { usage: { input_tokens: 0, output_tokens: 0 }, events: [
    { type: 'message_start', message: { usage: { input_tokens: 150, output_tokens: 1 } } },
  ] };
  assert.equal(requestMetrics({ provider: 'anthropic', response: { payload } }).input, 0);
});
