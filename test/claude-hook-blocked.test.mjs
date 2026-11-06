// Blocked commands: the hook refuses a command that starts a program the
// owner blocked (guardrails.json `blocked`, written beside the hook by projects.py).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'worker', 'sandbox', 'claude-hook.mjs');
const dir = mkdtempSync(join(tmpdir(), 'raytrace-hook-blocked-'));
const hookPath = join(dir, 'claude-hook.mjs');
copyFileSync(source, hookPath);
writeFileSync(join(dir, 'guardrails.json'), JSON.stringify({ restricted: [], watched: [], blocked: ['curl', 'rm'] }));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const AMBIENT = ['CI', 'GITHUB_ACTIONS', 'HEADLESS', 'RAYTRACE_HEADLESS', 'RAYTRACE_ALLOW_ALL'];
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !AMBIENT.includes(name)));

function decide(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], { env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      try { resolve(JSON.parse(out).hookSpecificOutput); } catch { reject(new Error(`Unexpected hook output: ${out}`)); }
    });
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'call_blocked_1',
      tool_input: { command }, permission_mode: 'bypassPermissions' }));
  });
}

for (const command of ['curl https://example.com', '/usr/bin/curl x', 'FOO=1 curl x', 'sudo -u root curl x',
  'echo hi && curl x', 'ls | rm -rf build', 'echo $(curl x)', '\\curl x']) {
  test(`refuses: ${command}`, async () => {
    const answer = await decide(command);
    assert.equal(answer.permissionDecision, 'deny');
    assert.match(answer.permissionDecisionReason, /is blocked by this project's owner/);
    assert.equal(answer.updatedInput, undefined);
  });
}

for (const command of ['curly x', 'echo curl', 'npm test', 'git rm-cache x']) {
  test(`allows: ${command}`, async () => {
    const answer = await decide(command);
    assert.equal(answer.permissionDecision, 'allow');
    assert.equal(answer.updatedInput.command, `export RAYTRACE_CALL_ID=call_blocked_1\n${command}`);
  });
}

test("text alone misses sh -c 'curl x': the kernel check is what catches it", async () => {
  const answer = await decide("sh -c 'curl x'");
  assert.equal(answer.permissionDecision, 'allow');
});
