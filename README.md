# RayTrace

**See what your coding agent actually did.**

[ npm package ](https://www.npmjs.com/package/@raytrace-cli/cli) ·
[ Quick start ](#quick-start) · [ Cloud sandboxes ](#cloud-sandboxes-preview) ·
[ Local sandboxes ](#local-sandboxes) ·
[ Privacy ](#privacy) · [ Report an issue ](https://github.com/Godcreatebugs/raytrace-cli/issues)

Your agent finished the task. Which files did it read? What commands did it run?
Where did the tokens and money go?

RayTrace turns Claude Code and Codex sessions into a dashboard you can explore:
prompts, answers, tool calls, cost, and captured context. Run your agent in a
RayTrace cloud sandbox and review every session with your team.

![RayTrace tool-call timeline showing commands, reported results, cost, time, and token usage](https://raw.githubusercontent.com/Godcreatebugs/raytrace-cli/main/docs/images/tool-calls.jpg)

*One real coding task: 50 model round trips, 58 tool calls, and a command-by-command record.*

- **Follow the work.** Open a prompt and trace the steps that led to its answer.
- **Inspect the evidence.** Expand tool calls to see commands and their reported output.
- **Understand the cost.** See model, token usage, time, and cost when available.
- **Explore the context.** Review earlier conversation and files brought into the task.

## Quick start

You need **Node.js 22.13 or newer** (`node --version`). macOS and Linux are
supported. To keep your project on your own machine instead, see
[Local sandboxes](#local-sandboxes).

```sh
npm install -g @raytrace-cli/cli
raytrace auth login             # opens your browser: sign in, or create your account
cd your-project                 # any Git repository
raytrace sandbox create         # uploads it to a new cloud sandbox and prints its id
raytrace connect <sandbox-id>   # a terminal in the sandbox: run claude or codex there
```

`auth login` prints a short code and opens the sign-in page. New here? Create
your account on that page, approve the code, and come back to the terminal.

Then open **[app.raytracer.si](https://app.raytracer.si)** to review the
session with your team: prompts, tool calls, and the commands that actually
ran. You can also create the sandbox there, by dropping a project folder on the
Sandboxes page. RayTrace asks you for no API key. See
[Cloud sandboxes](#cloud-sandboxes-preview) for what is uploaded and the limits.

## Cloud sandboxes (preview)

A cloud sandbox is an isolated copy of your project on RayTrace's servers, with
a terminal you open from your machine. Run Claude Code or Codex inside it: what
the agent asked, the tool calls it made, and the commands that actually ran are
recorded for your organization.

The [quick start](#quick-start) has the commands. If you skip `raytrace auth
login`, `raytrace sandbox create` and `raytrace connect` start the same sign-in
first. With one sandbox, `raytrace connect` works without the id.

At **[app.raytracer.si](https://app.raytracer.si)**, sign in with the same
account to see your organization's prompts, sandboxes and tool calls. A sandbox
created there shows the command to open it, `raytrace connect <sandbox-id>`.
Sandboxes belong to the account that made them: `raytrace auth status` says
which one the CLI is using.

- **What is uploaded:** the files Git would track in the repository (including
  new files it does not ignore), without `.git`, dependencies such as
  `node_modules`, build output, `.env*` files, private keys (`.pem`, `.key`,
  `.p12`, `.pfx`) and common credential files (`.npmrc`, `.netrc`, `id_rsa`, …).
  Review your project for secrets inside other files before you upload.
- **Limits:** a project may be up to 200 MiB and 20,000 files, each file up to
  25 MiB (100 MiB once packed). A project over a limit is refused, with the
  files named, and nothing is uploaded; add them to `.gitignore`. You can have
  three sandboxes at a time.
- **Signing in to your agent:** sign in to Claude Code inside the sandbox as
  you would on your machine. That sign-in stays in the sandbox until you
  destroy it.
- **When you are done:** `raytrace sandbox stop` keeps the files;
  `raytrace sandbox destroy` deletes them and any sign-in made inside. The
  recorded sessions are kept for your organization.

Cloud sandboxes are a preview and may change; please
[report issues](https://github.com/Godcreatebugs/raytrace-cli/issues) you run into.

## Local sandboxes

Prefer to keep your project on your own machine? Run the same sandbox locally.
It is open source and needs no RayTrace account.

```sh
cd your-project
raytrace sandbox create --local --name my-box   # first run sets up a Linux VM; a few minutes
raytrace connect my-box                         # a terminal in it: run claude there
raytrace sandbox destroy my-box                 # asks whether to delete its logs too
```

- **How it runs:** a Linux VM made with [Lima](https://lima-vm.io), and inside
  it each sandbox in a Docker container under [gVisor](https://gvisor.dev),
  with no access to your machine's files or private networks. A copy of the
  project goes in, picked the same way as for a cloud sandbox; your own files
  are never changed. `--name` defaults to the repository folder's name.
- **What is recorded:** the commands, file changes and network connections the
  sandbox makes, by a collector outside it that the agent cannot turn off,
  and its Claude Code sessions. All of it is in your local dashboard
  (`raytrace open`): **Sandboxes** lists each sandbox with its prompts, and
  **Sandbox evidence** shows, for one prompt, every command that actually ran,
  its exit code and what it reached on the network, each joined to the tool
  call that ran it. The raw collector feed is at http://localhost:8798.
  Nothing leaves your machine.
- **Signing in to your agent:** run `claude` inside the sandbox and sign in.
  RayTrace passes no key in. The sign-in stays in the sandbox until you destroy it.
- **Destroying it:** `raytrace sandbox destroy <name>` deletes the sandbox and
  asks whether to delete the logs captured in it as well. Yes deletes them
  everywhere, dashboard included. No moves them to
  `~/.raytrace/archive/<name>-<time>/` (Claude Code transcripts, and the
  recorded commands, files and connections as JSON lines), and its sessions
  stay in your dashboard. `--delete-logs` or `--keep-logs` answers without
  asking.
- **What you need:** nothing to install on macOS 13.5 or later. RayTrace
  uses [Lima](https://lima-vm.io) for the VM: yours if you have Lima 2.0 or
  later, otherwise it offers to download Lima's own release into
  `~/.raytrace/lima` (no admin rights; checked against a pinned checksum).
  Docker, gVisor and the agents are installed inside the VM, not on your
  machine. On Linux, also QEMU and access to `/dev/kvm`. On macOS before
  13.5, QEMU (`brew install qemu`). `raytrace doctor` shows what is missing,
  and `create --local` says so before it starts. First run downloads about
  1 GB (Lima, Ubuntu, packages); the VM uses 4 GiB of memory while it runs.
- **Platforms:** macOS and Linux. Windows is experimental: Lima's Windows
  support is itself experimental, and RayTrace does not download Lima there.
- **The VM:** `limactl stop raytrace` frees its memory; `limactl delete
  raytrace` removes it.

## Commands

| Command | What it does |
|---|---|
| `raytrace sandbox create` | upload this Git repository to a new cloud sandbox; `--name <name>` |
| `raytrace connect [id]` | open a terminal in a sandbox, signing in first if needed (also `raytrace sandbox shell [id]`) |
| `raytrace sandbox list` | your cloud sandboxes |
| `raytrace sandbox start\|stop [id]` | start or stop a sandbox; stopping keeps its files |
| `raytrace sandbox destroy [id]` | delete a sandbox; its recorded sessions are kept |
| `raytrace auth login` | sign in to RayTrace; `status`, `logout` |
| `raytrace sandbox create --local [--name <name>]` | the same sandbox in a Linux VM on this machine; offers to download Lima if needed (`--yes` skips the question) |
| `raytrace sandbox list --local` | your local sandboxes; their names work with `connect`, `start`, `stop` and `destroy` |
| `raytrace sandbox destroy <name> [--delete-logs \| --keep-logs]` | delete a local sandbox; asks whether its captured logs go too, or move to `~/.raytrace/archive` |
| `raytrace doctor` | what this machine has and lacks, local sandboxes included |

## Privacy

Local sandboxes keep everything on your machine. Cloud sandboxes run on
RayTrace's servers.

- `raytrace sandbox create` uploads your project (see
  [what is uploaded](#cloud-sandboxes-preview)) to RayTrace.
- Inside a sandbox, the prompts, model requests and answers, tool calls and the
  commands that run are recorded on RayTrace's servers for your organization.
  Members of your organization can see them at app.raytracer.si; other
  organizations cannot.
- `raytrace auth login` keeps your sign-in in the macOS Keychain or the Linux
  secret service (a file readable only by you where neither is available), and
  `raytrace auth logout` removes it.

## Uninstall

```sh
raytrace sandbox destroy <sandbox-id>   # any sandboxes you no longer need
raytrace auth logout
npm uninstall -g @raytrace-cli/cli
```

Upgrading from 0.4 or earlier: the first start of the new version upgrades
`~/.raytrace/evidence.db` in place (your recorded sessions are kept), and older
versions cannot open it afterwards.

With local sandboxes, run `raytrace uninstall --purge` before removing the
package: it deletes the local sandbox VM and everything in `~/.raytrace`
(recorded sessions, archived logs, and the Lima RayTrace downloaded). Without
`--purge`, remove the VM yourself with `limactl delete --force raytrace`.

If you set up local recording with an earlier version, run
`raytrace uninstall` before removing the package so Claude Code is not left
with a hook that points at a missing command.

## Troubleshooting

- **`Cannot reach RayTrace at https://api.raytracer.si`:** check your
  connection. Networks that inspect HTTPS, such as some company Wi-Fi, can
  block it; try another network.
- **Sign-in or sandbox creation fails:** run `raytrace auth status`, and
  `raytrace auth login` again if needed. Create the sandbox from inside a Git
  repository.
- **A local sandbox's Claude Code sessions do not show in the dashboard:**
  RayTrace's proxy may be from before local sandboxes. Restart it:
  `raytrace stop && raytrace start`. `sandbox create --local` warns about this.
- **`sandbox create --local` says the machine is not ready:** each line names
  what is missing and how to fix it; `raytrace doctor` shows the same. Port
  8798 in use usually means another Lima VM is running (`limactl list`).
- **The VM fails to start or set up:** the last lines are shown; the whole
  log is in `~/.raytrace/logs/sandbox-vm.log`.
- **`raytrace connect` asks for a sandbox id:** run `raytrace sandbox list` and
  pass the one you want. The id is optional only when you have one sandbox.

## Developing

```sh
npm install
npm run build             # dashboard -> dist/dashboard
npm run dashboard:dev     # dashboard with hot reload, API from a running RayTrace
npm run typecheck
node bin/raytrace.mjs <command>   # run the CLI from this folder
npm pack                  # build the package as it would be published
```

To try it without touching your real setup, give it its own home and port:

```sh
mkdir -p /tmp/rt && echo RAYTACE_PORT=18797 > /tmp/rt/config.env
RAYTRACE_HOME=/tmp/rt node bin/raytrace.mjs setup --no-claude-code
```

## License

MIT
