import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSseResponse } from './capture.mjs';

for (const newline of ['\n', '\r\n', '\r']) {
  for (const bom of ['', '\uFEFF']) {
    test(`SSE capture accepts ${JSON.stringify(newline)} frames with BOM ${Boolean(bom)}`, () => {
      const events = [{ type: 'message_start', message: { id: 'start' } }, { type: 'message_stop' }];
      const stream = bom + events.map(event => `data: ${JSON.stringify(event)}${newline}${newline}`).join('');
      assert.deepEqual(parseSseResponse(Buffer.from(stream)), { stream: true, events });
    });
  }
}

test('a BOM-prefixed terminal response is retained as the final object', () => {
  const response = { id: 'done', output: [] };
  const stream = '\uFEFFdata: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n';
  assert.deepEqual(parseSseResponse(Buffer.from(stream)), response);
});
