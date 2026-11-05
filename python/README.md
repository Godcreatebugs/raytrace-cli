# RayTrace

See what your coding agent did: traces, tool calls, cost and step-by-step evidence for Claude Code and Codex, and sandboxes (cloud or local) to run them in.

This is the RayTrace CLI from npm (`@raytrace-cli/cli`), packaged for pip with its own Node.js, so you don't need Node installed.

```sh
pip install raytrace        # or: uv tool install raytrace / pipx install raytrace
raytrace auth login
raytrace sandbox create
```

## In your editor (MCP)

Claude Code:

```sh
claude mcp add raytrace -- uvx raytrace mcp
```

Codex (`~/.codex/config.toml`), Cursor and others take the same command:

```toml
[mcp_servers.raytrace]
command = "uvx"
args = ["raytrace", "mcp"]
```

Wheels are built for macOS 13.5+ (Apple Silicon and Intel), Linux with glibc 2.28+ (x86-64 and ARM64) and Windows (x64 and ARM64). Local sandboxes also need Lima on the machine; `raytrace sandbox create --local` offers to install it.

Full documentation: https://github.com/Godcreatebugs/raytrace-cli
