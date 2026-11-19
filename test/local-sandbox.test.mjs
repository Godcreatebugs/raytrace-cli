import test from 'node:test';
import assert from 'node:assert/strict';
import { ambiguousLocalSandboxMessage, logsChoice, missingLocalSandboxMessage } from '../src/local-sandbox.mjs';

test('a missing local sandbox name is quoted before the list command', () => {
  assert.equal(
    missingLocalSandboxMessage('my-box'),
    'No local sandbox named "my-box". List them with: raytrace sandbox list --local',
  );
});

test('an ambiguous local sandbox message names the list command separately', () => {
  assert.equal(
    ambiguousLocalSandboxMessage(),
    'More than one local sandbox. Name one with: raytrace sandbox list --local',
  );
});

test('logsChoice rejects passing both --delete-logs and --keep-logs', () => {
  assert.throws(
    () => logsChoice({ 'delete-logs': true, 'keep-logs': true }),
    /Pick one: --delete-logs or --keep-logs/,
  );
});

test('logsChoice accepts each flag on its own', () => {
  assert.equal(logsChoice({ 'delete-logs': true }), true);
  assert.equal(logsChoice({ 'keep-logs': true }), false);
  assert.equal(logsChoice({}), null);
});
