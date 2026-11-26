import test from 'node:test';
import assert from 'node:assert/strict';
import { toolResultFacts, toolResultStatus } from './tool-metadata.mjs';

for (const encode of [value => value, JSON.stringify]) {
  test(`structured execution facts and status agree (${encode.name || 'object'})`, () => {
    for (const exitCode of [0, 2, -1]) {
      const output = encode({ output: 'Process exited with code 0', exit_code: exitCode, wall_time_seconds: 1.25 });
      assert.deepEqual(toolResultFacts({ output }), { exitCode, wallMs: 1250 });
      assert.equal(toolResultStatus({ output }), exitCode === 0 ? 'Successful' : 'Failed');
    }
    const output = encode({ output: 'started', session_id: 123, wall_time_seconds: 5 });
    assert.deepEqual(toolResultFacts({ output }), { exitCode: null, wallMs: null });
    assert.equal(toolResultStatus({ output }), 'Still running');
  });
}

test('runner-looking JSON inside command output is not interpreted recursively', () => {
  const output = JSON.stringify({ output: JSON.stringify({ output: '', exit_code: 1 }), exit_code: 0, wall_time_seconds: 0 });
  assert.deepEqual(toolResultFacts({ output }), { exitCode: 0, wallMs: 0 });
  assert.equal(toolResultStatus({ output }), 'Successful');
});
