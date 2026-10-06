# RayTrace

See what your coding agent actually did. RayTrace records every prompt you
give Claude Code or Codex, every tool call the agent made on the way to its
answer, what each step cost, and what the model had in front of it when it
decided. You browse all of it in a dashboard on your own machine.

Everything stays on your computer. Your sessions are not sent anywhere unless you
turn on the optional AI features (see [Privacy](#privacy)).

## Install

You need **Node.js 22.13 or newer** (`node --version`). macOS and Linux are
supported.

```sh
npm install -g @raytrace/cli
raytrace setup
```

`setup` asks two things:

1. **Record Claude Code sessions?** It adds a small hook to
   `~/.claude/settings.json`. Your other settings and hooks are left as they
   are, and the previous file is kept as `settings.json.raytrace-backup`.
2. **An OpenRouter API key** (optional, Enter to skip). It turns on one-line
   step summaries and `raytrace codex`. Everything else works without it.

Then it starts RayTrace and opens the dashboard at http://127.0.0.1:8797.

Install globally (`-g`) rather than running it with `npx`: the Claude Code hook
runs the `raytrace` command, so it has to stay on your PATH.

## Use

Use Claude Code as you normally do. Each prompt shows up in the dashboard a
moment after the agent answers.

| Section | What it answers |
|---|---|
| **Prompts** | What you asked and what came back, with a year of activity at a glance |
| **Tool calls** | How the agent got there: every round trip to the model and every tool call, with cost, time and tokens, as a list or a graph |
| **Context** | What the model was working from: earlier prompts, files it read, and how full its context window was |

For Codex, start it through RayTrace instead of directly (needs the OpenRouter
key):

```sh
raytrace codex            # any Codex arguments work after it
```

## Commands

| Command | |
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
npm uninstall -g @raytrace/cli
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
