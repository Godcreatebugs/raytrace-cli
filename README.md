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
