import test from 'node:test';
import assert from 'node:assert/strict';
import { reportedResult } from '../dashboard/app/trace-utils.ts';

const result = (data) => reportedResult([{title: 'Tool result: Bash', raw: JSON.stringify({call_id: 'c1', ...data})}], 'c1');

test('CLI: structured failure remains failed without a runner error header', () => {
  assert.deepEqual(result({is_error: true, output: 'Permission denied'}), {state: 'failed', code: null, output: 'Permission denied'});
  assert.deepEqual(result({is_error: true, exit_code: 127, output: 'command not found'}), {state: 'failed', code: 127, output: 'command not found'});
  assert.equal(result({is_error: true, output: 'Process exited with code 0'}).state, 'failed');
});

test('CLI: explicit exit code without is_error is respected', () => {
  assert.deepEqual(result({exit_code: 0, output: 'all good'}), {state: 'ok', code: 0, output: 'all good'});
  assert.deepEqual(result({exit_code: 2, output: 'syntax error'}), {state: 'failed', code: 2, output: 'syntax error'});
});

test('CLI: ordinary runner status and missing results stay distinct', () => {
  assert.equal(result({output: 'Process exited with code 7'}).state, 'failed');
  assert.equal(result({is_error: false, output: 'Process exited with code 0'}).state, 'ok');
  assert.equal(result({output: 'exec_command failed: Rejected(policy)'}).state, 'rejected');
  assert.equal(reportedResult([], 'c1').state, 'none');
});
