import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'raytrace-claude-test-'));
const settingsPath = join(tempDir, 'settings.json');
process.env.CLAUDE_CONFIG_DIR = tempDir;

const { hookState, setHook, HOOK_COMMAND } = await import('../src/claude-code.mjs');

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(settingsPath, { force: true });
});

test('hookState reports not installed when settings file is empty or missing', () => {
  const state = hookState();
  assert.equal(state.installed, false);
  assert.equal(state.valid, false);
  assert.deepEqual(state.missingEvents, ['PostToolUse', 'Stop', 'SubagentStop', 'SessionEnd']);
});

test('setHook installs valid hooks for all events and hookState confirms it', () => {
  setHook();
  const state = hookState();
  assert.equal(state.installed, true);
  assert.equal(state.valid, true);
  assert.deepEqual(state.missingEvents, []);
  assert.equal(state.invalidType, false);
  assert.equal(state.invalidMatcher, false);
  assert.equal(state.duplicates, false);
  assert.equal(state.repoHook, false);
});

test('hookState detects missing events', () => {
  const settings = {
    hooks: {
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 5 }] }],
      Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 5 }] }]
    }
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const state = hookState();
  assert.equal(state.installed, false);
  assert.equal(state.valid, false);
  assert.deepEqual(state.missingEvents, ['SubagentStop', 'SessionEnd']);
});

test('hookState detects invalid hook type', () => {
  const settings = {
    hooks: {
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'prompt', command: HOOK_COMMAND }] }],
      Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }]
    }
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const state = hookState();
  assert.equal(state.installed, true);
  assert.equal(state.valid, false);
  assert.equal(state.invalidType, true);
});

test('hookState detects invalid or overly restrictive matcher on PostToolUse', () => {
  const settings = {
    hooks: {
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
      Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }]
    }
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const state = hookState();
  assert.equal(state.installed, true);
  assert.equal(state.valid, false);
  assert.equal(state.invalidMatcher, true);
});

test('hookState detects duplicate hook commands', () => {
  const settings = {
    hooks: {
      PostToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: HOOK_COMMAND }, { type: 'command', command: HOOK_COMMAND }] }
      ],
      Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }]
    }
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const state = hookState();
  assert.equal(state.installed, true);
  assert.equal(state.valid, false);
  assert.equal(state.duplicates, true);
});

test('hookState detects repo hook', () => {
  const settings = {
    hooks: {
      PostToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: 'node /path/to/claude-code-hook.mjs' }] }
      ]
    }
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const state = hookState();
  assert.equal(state.repoHook, true);
});
