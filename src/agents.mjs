// The coding agents a sandbox terminal can start (`raytrace connect --claude`
// or `--codex`): their names, and their command lines inside the sandbox,
// without approval prompts, because the sandbox is what contains them.
export const AGENTS = {
  claude: { name: 'Claude Code', command: 'claude --dangerously-skip-permissions' },
  codex: { name: 'Codex', command: 'codex --dangerously-bypass-approvals-and-sandbox' },
};
