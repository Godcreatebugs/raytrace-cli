import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The collector runs in the VM under Python; its tests are Python too (collector_restart.py).
const script = fileURLToPath(new URL('./collector_restart.py', import.meta.url));
const python = spawnSync('python3', ['--version']);

test('a restarted collector ends the streams the stopped one left open', { skip: python.error ? 'python3 not installed' : false }, () => {
  const run = spawnSync('python3', ['-B', script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
