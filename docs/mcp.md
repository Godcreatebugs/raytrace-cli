# Set up in your editor (MCP)

`raytrace mcp` is an [MCP](https://modelcontextprotocol.io) server. Add it to
your editor once, and your agent can create, open, stop and destroy sandboxes
for you. There is nothing to install first: `npx` downloads the CLI on first use.

A shorter pointer is in the [README](../README.md#set-up-in-your-editor-mcp).
Local sandboxes need no account; creating one from the CLI is in
[Create a local sandbox](../README.md#create-a-local-sandbox).

## 1. Add the server

**Claude Code.** One command, then restart Claude Code. `--scope user` makes it
available in every project:

```sh
claude mcp add --scope user raytrace -- npx -y @raytrace-cli/cli@latest mcp
```

Check it with `claude mcp list`, which should show `raytrace` as connected.

**Cursor.** Add to `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "raytrace": { "command": "npx", "args": ["-y", "@raytrace-cli/cli@latest", "mcp"] }
  }
}
```

**VS Code.** Add to `.vscode/mcp.json` in the project, or run **MCP: Open User
Configuration** from the command palette for every project:

```json
{
  "servers": {
    "raytrace": { "command": "npx", "args": ["-y", "@raytrace-cli/cli@latest", "mcp"] }
  }
}
```

**Codex.** `codex mcp add raytrace -- npx -y @raytrace-cli/cli@latest mcp`

**Any other MCP client.** Run the command `npx` with the arguments
`-y @raytrace-cli/cli@latest mcp`, over stdio. Most clients use the same
`mcpServers` JSON as Cursor.

> Already have the CLI installed globally? You can use `raytrace mcp` as the
> command instead of `npx`. The PyPI package is the same CLI: where a command
> below uses `npx -y @raytrace-cli/cli@latest`, you can use
> `uvx --from raytrace-cli raytrace` instead.

## 2. Ask for a sandbox

Open a Git project in your editor and ask your agent in plain words:

| You say | What happens |
|---|---|
| "Create a local sandbox and connect this repo" | a sandbox on your machine, then a terminal opens with Claude Code running in it |
| "Put this project in a cloud sandbox" | uploads the repo to RayTrace's cloud, then opens a terminal with Claude Code in it |
| "Open my sandbox with Codex" | a terminal connected to an existing sandbox, with Codex running in it |
| "List my sandboxes" / "Stop demo-box" / "Destroy it" | manages them; the agent asks you before it destroys anything |
| "Run `npm test` in the sandbox" | runs a command in a cloud sandbox and reports the result back in the chat |

**The first time:**

- **Cloud sandboxes** need a RayTrace sign-in. The agent shows you a short code
  and opens a browser page. Approve it there (or create your account), and the
  agent carries on. Local sandboxes need no account.
- **The first local sandbox** sets up a Linux VM, which takes a few minutes. If
  [Lima](https://lima-vm.io) is missing, the agent asks before downloading it.
  See [what you need](../README.md#what-you-need).
- **In each new sandbox**, Claude Code or Codex asks you to sign in to your
  Anthropic or OpenAI account, as it would on your machine.
- **On macOS**, the first time a terminal is opened for you, macOS asks whether
  your editor may control your terminal app. Allow it.

## 3. Work in the sandbox

The terminal opens where you work: a new tmux window if you're in tmux, a new
iTerm window or WezTerm tab, otherwise a new Terminal window on macOS (VS Code's
built-in terminal can't be opened from outside), your desktop's terminal on
Linux, or Windows Terminal. If none can be opened, the agent gives you the
command to paste instead, such as `raytrace connect demo-box --claude`.

Inside, the agent runs **without approval prompts**. The sandbox is what keeps
it contained, so there's no need to approve every command, and everything it
does is recorded. See [Inside the sandbox](../README.md#inside-the-sandbox).

## MCP tools reference

This is the full list of tools exposed by `raytrace mcp`.

| Tool | What it does |
|---|---|
| `login` | signs in to RayTrace (cloud only): shows a code to approve in the browser |
| `create_sandbox` | copies the open Git project into a new sandbox. `local: true` for one on your machine, `agent: "codex"` to open it with Codex, `connect: false` to skip opening a terminal |
| `connect_sandbox` | opens a terminal in an existing sandbox with Claude Code (default), Codex (`agent: "codex"`) or a plain shell (`agent: "none"`); starts it first if it's stopped |
| `list_sandboxes`, `sandbox_status` | your local and cloud sandboxes, and one sandbox's details or creation progress |
| `start_sandbox`, `stop_sandbox` | stopping keeps the files |
| `destroy_sandbox` | deletes a sandbox. Cloud: its traces go too, unless `keep_traces` (paid plans). Local: its logs are archived, unless `delete_logs` |
| `run_command`, `get_command_result`, `cancel_command` | run shell commands in a cloud sandbox from the chat: up to 4 at once, 120 s by default and at most 30 minutes, with the real exit code and output |

Local sandboxes are named by their name and cloud ones by their id (`rtp-…`).
Whatever a command prints is treated as data from your project, never as
instructions to the agent.
