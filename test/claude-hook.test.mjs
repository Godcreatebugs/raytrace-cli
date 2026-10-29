import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), '../worker/sandbox/claude-hook.mjs');

function runHook(env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], {
      env: { ...process.env, ...env }
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`Failed to parse hook output: ${out} (err: ${err})`));
      }
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

test('PreToolUse defaults to ask when permission_mode is not bypassPermissions', async () => {
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'call_test_1',
    tool_input: { command: 'echo hello' },
    permission_mode: 'ask'
  };
  const res = await runHook({}, input);
  assert.equal(res.hookSpecificOutput?.permissionDecision, 'ask');
  assert.equal(res.hookSpecificOutput?.updatedInput?.command, 'export RAYTRACE_CALL_ID=call_test_1\necho hello');
});

test('PreToolUse allows commands when RAYTRACE_ALLOW_ALL=1 in headless/CI mode', async () => {
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'call_test_2',
    tool_input: { command: 'pytest' },
    permission_mode: 'ask'
  };
  const res = await runHook({ RAYTRACE_ALLOW_ALL: '1' }, input);
  assert.equal(res.hookSpecificOutput?.permissionDecision, 'allow');
  assert.equal(res.hookSpecificOutput?.updatedInput?.command, 'export RAYTRACE_CALL_ID=call_test_2\npytest');
});

test('PreToolUse allows commands when permission_mode is bypassPermissions', async () => {
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'call_test_3',
    tool_input: { command: 'npm test' },
    permission_mode: 'bypassPermissions'
  };
  const res = await runHook({}, input);
  assert.equal(res.hookSpecificOutput?.permissionDecision, 'allow');
});

test('PreToolUse allows commands automatically in CI or GitHub Actions environment', async () => {
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'call_test_ci',
    tool_input: { command: 'cargo test' },
    permission_mode: 'ask'
  };
  const ciRes = await runHook({ CI: 'true' }, input);
  assert.equal(ciRes.hookSpecificOutput?.permissionDecision, 'allow');

  const ghaRes = await runHook({ GITHUB_ACTIONS: 'true' }, input);
  assert.equal(ghaRes.hookSpecificOutput?.permissionDecision, 'allow');

  const headlessRes = await runHook({ RAYTRACE_HEADLESS: '1' }, input);
  assert.equal(headlessRes.hookSpecificOutput?.permissionDecision, 'allow');
});
