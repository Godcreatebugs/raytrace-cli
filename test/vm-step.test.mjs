import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runVmStep } from '../src/vm-step.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'raytrace-vm-step-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const messages = [];
  return { messages, options: {
    stage: 'Downloading Ubuntu', logFile: join(root, 'logs', 'vm.log'),
    say: (message) => messages.push(message), intervalMs: 20, timeoutMs: 10_000,
  } };
}

test('long VM steps report progress, retain both output streams and stop their timer', async (t) => {
  const { messages, options } = fixture(t);
  await runVmStep(process.execPath, ['-e',
    'console.log("image download 50%"); console.error("provisioning"); setTimeout(() => {}, 120);'], options);
  assert.ok(messages.some((line) => /still running/.test(line)), messages.join('\n'));
  assert.match(messages.at(-1), /finished/);
  const log = readFileSync(options.logFile, 'utf8');
  assert.match(log, /image download 50%/);
  assert.match(log, /provisioning/);
  const count = messages.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(messages.length, count, 'no progress after completion');
});

test('a failed VM step reports its output, doctor, log and non-destructive retry', async (t) => {
  const { options } = fixture(t);
  await assert.rejects(runVmStep(process.execPath, ['-e',
    'console.error("image server unavailable"); process.exit(7);'], options), (error) => {
    assert.match(error.message, /failed \(exit 7\)/);
    assert.match(error.message, /image server unavailable/);
    assert.match(error.message, /raytrace doctor/);
    assert.ok(error.message.includes(options.logFile));
    assert.match(error.message, /retry this command to resume/);
    return true;
  });
});

test('a hung VM step is stopped on timeout and can be retried with its log preserved', async (t) => {
  const { options } = fixture(t);
  await assert.rejects(runVmStep(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    ...options, timeoutMs: 150,
  }), /timed out.*[\s\S]*raytrace doctor/);
  await runVmStep(process.execPath, ['-e', 'console.log("resumed")'], options);
  const log = readFileSync(options.logFile, 'utf8');
  assert.equal((log.match(/===/g) || []).length, 4, 'both attempt headers survive');
  assert.match(log, /resumed/);
});

test('failure to start Lima includes recovery guidance', async (t) => {
  const { options } = fixture(t);
  await assert.rejects(runVmStep(join(dirname(options.logFile), 'missing-limactl'), [], options),
    /could not start.*[\s\S]*raytrace doctor/);
});
