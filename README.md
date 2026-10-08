# RayTrace

**See what your coding agent actually did.**

[ npm package ](https://www.npmjs.com/package/@raytrace-cli/cli) ·
[ Quick start ](#quick-start) · [ Dashboard tour ](#dashboard-tour) ·
[ Privacy ](#privacy) · [ Report an issue ](https://github.com/Godcreatebugs/raytrace-cli/issues)

Your agent finished the task. Which files did it read? What commands did it run?
Where did the tokens and money go?

RayTrace turns Claude Code and Codex sessions into a dashboard you can explore
on your own machine: prompts, answers, tool calls, cost, and captured context.

![RayTrace tool-call timeline showing commands, reported results, cost, time, and token usage](https://raw.githubusercontent.com/Godcreatebugs/raytrace-cli/main/docs/images/tool-calls.jpg)

*One real coding task: 50 model round trips, 58 tool calls, and a command-by-command record.*

- **Follow the work.** Open a prompt and trace the steps that led to its answer.
- **Inspect the evidence.** Expand tool calls to see commands and their reported output.
- **Understand the cost.** See model, token usage, time, and cost when available.
- **Explore the context.** Review earlier conversation and files brought into the task.

Session capture and the dashboard work locally. Claude Code recording needs no
OpenRouter key; optional AI summaries and the Codex launcher do. See [Privacy](#privacy)
for what those features send outside your machine.

**New: [cloud sandboxes](#cloud-sandboxes-preview) (preview).** Run your agent
in an isolated sandbox on RayTrace's servers instead of your laptop, and review
every session with your team at [app.raytracer.si](https://app.raytracer.si).

## Quick start

You need **Node.js 22.13 or newer** (`node --version`). macOS and Linux are
supported.

```sh
npm install -g @raytrace-cli/cli
raytrace setup
```

`setup` asks two things:

1. **Record Claude Code sessions?** It adds a small hook to
   `~/.claude/settings.json`. Your other settings and hooks are left as they
   are, and the previous file is kept as `settings.json.raytrace-backup`.
2. **An OpenRouter API key** (optional, Enter to skip). It turns on one-line
   step summaries and `raytrace codex`.

Then it starts RayTrace and opens the dashboard at **http://127.0.0.1:8797**.

Install globally (`-g`): the Claude Code hook runs the `raytrace` command, so it
has to stay on your PATH.

### See your first trace

Use Claude Code as you normally do. Try a small task such as:

> List the files in this project and explain where the main entry point is.

After the agent answers, open **Prompts** in the dashboard. Select your prompt,
then choose **Tool calls** to follow the work or **Context** to inspect what
was brought into the task.

For Codex, add an OpenRouter key during setup and start it through RayTrace:

```sh
raytrace codex            # pass Codex arguments after this command
```

## Dashboard tour

### Prompts — find the conversation

Browse your prompt history, revisit answers, and see activity across the year.
Each prompt links to its tool calls and context, with model and cost information
alongside it when available.

![RayTrace prompt history with an activity calendar and real Claude Code tasks](https://raw.githubusercontent.com/Godcreatebugs/raytrace-cli/main/docs/images/prompts.jpg)

### Tool calls — follow each step

The timeline shows the commands the agent chose, their reported results, and
metrics for each model round trip. Expand a row for details, group similar steps,
or switch to **Graph** to follow the sequence visually.

![RayTrace graph connecting three model requests with reported tool-call results and request metrics](https://raw.githubusercontent.com/Godcreatebugs/raytrace-cli/main/docs/images/trace-graph.jpg)

*Graph view works without AI summaries; an optional OpenRouter key adds short descriptions.*

### Context — inspect what informed the answer

Explore earlier prompts, files read during the task, and captured internal
instructions. Open a file entry to inspect the text associated with it. Token
counts and file-use indicators help you explore what contributed to the context.

![RayTrace context inspector showing file reads, estimated tokens, and an expanded file entry](https://raw.githubusercontent.com/Godcreatebugs/raytrace-cli/main/docs/images/context.jpg)

*Screenshots captured from RayTrace running locally in Brave with selected real
Claude Code transcript excerpts. Local paths are anonymized; prior conversation
was omitted from the screenshot dataset. Token estimates and Claude Code costs
are approximate; file reads inferred from shell commands are marked in the UI.*

## Cloud sandboxes (preview)

A cloud sandbox is an isolated copy of your project on RayTrace's servers, with
a terminal you open from your machine. Run Claude Code or Codex inside it: what
the agent asked, the tool calls it made, and the commands that actually ran are
recorded for your organization.

```sh
raytrace auth login          # sign in once; a code opens in your browser
cd your-project              # any Git repository
raytrace sandbox create      # upload it to a new sandbox
raytrace connect             # a terminal in the sandbox: run claude or codex there
```

Then open **[app.raytracer.si](https://app.raytracer.si)** and sign in with the
same account to see your organization's prompts, sandboxes and tool calls. You
can also create a sandbox there by dropping a project folder on the Sandboxes
page; it shows the command to open it, `raytrace connect <sandbox-id>`, which
signs you in first if you are not. Sandboxes belong to the account that made
them: `raytrace auth status` says which one the CLI is using.

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

## Commands

| Command | What it does |
|---|---|
| `raytrace setup` | one-time setup; run it again to change settings |
| `raytrace start` | start recording in the background |
| `raytrace stop` | stop it |
| `raytrace status` | is it running, and is Claude Code being recorded |
| `raytrace open` | open the dashboard |
| `raytrace doctor` | check the install without changing anything |
| `raytrace codex [args]` | run Codex through RayTrace |
| `raytrace uninstall` | remove the Claude Code hook; `--purge` also deletes recorded data |
| `raytrace auth login` | sign in to RayTrace (needed for cloud sandboxes); `status`, `logout` |
| `raytrace sandbox create` | upload this Git repository to a new cloud sandbox; `--name <name>` |
| `raytrace sandbox list` | your cloud sandboxes |
| `raytrace connect [id]` | open a terminal in a sandbox, signing in first if needed (also `raytrace sandbox shell [id]`) |
| `raytrace sandbox start\|stop [id]` | start or stop a sandbox; stopping keeps its files |
| `raytrace sandbox destroy [id]` | delete a sandbox; its recorded sessions are kept |

## Getting the most out of it

RayTrace shows what the agent **reported** at each step: the commands it chose,
their output, and whether it said they succeeded. That is exactly what the
agent believed, which is usually what you want to debug.

It works best when the agent runs in **its own container or virtual machine**
rather than directly on your laptop. A run you can tell apart from everything
else on the machine is easier to trust and easier to compare: you know what the
agent started from, nothing else was changing the files under it, and a second
attempt starts from the same place. If you already run agents that way, point
RayTrace at the same sessions and the records line up run for run.

## Privacy

- Recorded sessions, settings and logs live in `~/.raytrace` (move it with the
  `RAYTRACE_HOME` environment variable). The dashboard and its API listen on
  `127.0.0.1` only.
- API keys you give `setup` are stored in `~/.raytrace/config.env`, readable
  only by you. Keys and auth headers in recorded requests are replaced with
  `[REDACTED]` before they are saved.
- With an OpenRouter key, summaries send short excerpts of each step (and of
  your earlier prompts, for the Context view) to OpenRouter, using your key.
  Rerunning a Codex step in the Lab sends that step's whole request again.
  Without a key, none of this happens.
- To show how full a model's context window was, the dashboard fetches
  OpenRouter's public list of models once. That request carries none of your
  data.

Cloud sandboxes are different by design: they run on RayTrace's servers.

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
raytrace uninstall --purge   # removes the hook and ~/.raytrace
npm uninstall -g @raytrace-cli/cli
```

## Troubleshooting

Run `raytrace doctor` first; it lists anything wrong and how to fix it. The
background process logs to `~/.raytrace/logs/proxy.log`.

- **Nothing shows up for Claude Code:** check `raytrace status` says
  "recording", and that `raytrace` is on your PATH (`which raytrace`). Sessions
  appear when the agent finishes a step, not while it is typing.
- **`Cannot reach RayTrace at https://api.raytracer.si`:** check your
  connection. Networks that inspect HTTPS, such as some company Wi-Fi, can
  block it; try another network.
- **Port 8797 is in use:** set `RAYTACE_PORT=<port>` in `~/.raytrace/config.env`,
  then `raytrace stop && raytrace start`.

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
