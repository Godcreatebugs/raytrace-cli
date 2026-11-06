# RayTrace

See what your coding agent did: traces, tool calls, cost and step-by-step evidence for Claude Code and Codex, and sandboxes (cloud or local) to run them in.

This is the RayTrace CLI from npm (`@raytrace-cli/cli`), packaged for pip with its own Node.js, so you don't need Node installed. The command is `raytrace`.

```sh
pip install raytrace-cli    # or: uv tool install raytrace-cli / pipx install raytrace-cli
```

## Local sandbox (your project stays on this machine)

No account needed. From a Git repository:

```sh
raytrace sandbox create --local              # a copy of this repo in a gVisor sandbox in a Linux VM
raytrace connect <name> --claude             # a terminal in it, with Claude Code running (or --codex)
raytrace open                                # the local dashboard: what the agent ran, read and connected to
```

The first one sets up the VM, which takes several minutes. Local sandboxes need Lima; `raytrace sandbox create --local` offers to download it. macOS and Linux; Windows is experimental. `raytrace doctor` shows what is missing.

## Cloud sandbox

```sh
raytrace auth login                          # sign in, or create your account, in the browser
raytrace sandbox create                      # upload this Git repository to a new sandbox
raytrace connect <sandbox-id> --claude       # a terminal in it, with Claude Code running (or --codex)
```

Sessions show up at https://app.raytracer.si.

## In your editor (MCP)

Your agent can create, open, list, start, stop and destroy local and cloud sandboxes for you. Claude Code:

```sh
claude mcp add --scope user raytrace -- uvx --from raytrace-cli raytrace mcp
```

Codex (`~/.codex/config.toml`), Cursor and others take the same command:

```toml
[mcp_servers.raytrace]
command = "uvx"
args = ["--from", "raytrace-cli", "raytrace", "mcp"]
```

Then ask your agent, for example, "put this repo in a local sandbox and open it".

## Commands

| Command | What it does |
|---|---|
| `raytrace sandbox create [--local] [--name <name>]` | copy this Git repository into a new sandbox, in the cloud or (`--local`) on this machine |
| `raytrace connect [id or name] [--claude \| --codex]` | open a terminal in a sandbox, optionally with an agent running in it |
| `raytrace sandbox list [--local]` | your sandboxes |
| `raytrace sandbox start\|stop <id or name>` | start or stop one; stopping keeps its files |
| `raytrace sandbox destroy <id or name>` | delete one. Cloud: `--keep-traces` (paid plans). Local: `--delete-logs` or `--keep-logs` |
| `raytrace open` | open the local dashboard |
| `raytrace mcp` | the MCP server for your editor (above) |
| `raytrace auth login\|status\|logout` | your RayTrace sign-in, for cloud sandboxes |
| `raytrace upload logs [--sandbox <name>]` | send a local sandbox's recorded logs to the cloud dashboard; `raytrace upload status` shows your storage |
| `raytrace share <trace-id> [--fork]` | a time-limited link to one recorded prompt; `--list`, `--revoke <share-id>` |
| `raytrace export <trace-id> [--format json\|markdown] [--output <file>]` | export a recorded prompt to the terminal or a file |
| `raytrace --code <code>` | redeem a beta invite code |
| `raytrace key [openrouter\|typesafe] [--remove]` | your keys for the dashboard's AI features |
| `raytrace doctor` | what this machine has and lacks |

`raytrace help` lists everything.

## Uninstall

```sh
raytrace sandbox destroy <id or name>        # any sandboxes you no longer need
raytrace uninstall --purge                   # local sandboxes: deletes the VM and ~/.raytrace
raytrace auth logout
pip uninstall raytrace-cli
claude mcp remove raytrace -s user           # if you added the MCP server to Claude Code
```

Wheels are built for macOS 13.5+ (Apple Silicon and Intel), Linux with glibc 2.28+ (x86-64 and ARM64) and Windows (x64 and ARM64).

Full documentation: https://github.com/Godcreatebugs/raytrace-cli
