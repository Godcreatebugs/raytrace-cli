# Contributing to RayTrace

Thanks for wanting to help. This guide is how to set up a checkout, run the
tests, and open a pull request. The product itself — local and cloud sandboxes,
the MCP server, and the dashboard — is described in the [README](README.md).

## What you need

- **Node.js 22.13 or newer** (`node --version`) and npm
- **Git**
- For trying a **local sandbox** from your checkout: macOS 13.5 or later, or
  Linux with Lima, QEMU, and access to `/dev/kvm`. Windows is experimental;
  RayTrace doesn't download Lima there. `raytrace doctor` (or
  `node bin/raytrace.mjs doctor`) checks what's missing.

## Set up

```sh
git clone https://github.com/Godcreatebugs/raytrace-cli.git
cd raytrace-cli
npm install
npm run build                     # dashboard -> dist/dashboard
npm run typecheck
npm test
node bin/raytrace.mjs <command>   # run the CLI from this folder
```

To use your checkout as the MCP server in Claude Code:

```sh
claude mcp add --scope user raytrace -- node /path/to/raytrace-cli/bin/raytrace.mjs mcp
```

To try it without touching your real setup, give it its own home and port:

```sh
mkdir -p /tmp/rt && echo RAYTACE_PORT=18797 > /tmp/rt/config.env
RAYTRACE_HOME=/tmp/rt node bin/raytrace.mjs setup --no-claude-code
```

`npm run dashboard:dev` runs the dashboard with hot reload, using the API from
a running RayTrace.

Before you open a pull request, run:

```sh
npm test
npm run typecheck
npm run build
```

## Project layout

```
raytrace-cli/
├── bin/raytrace.mjs      # CLI entry
├── src/                  # CLI: sandbox, MCP, auth, Lima, report, upload
├── proxy/                # recording, evidence store, playground, traces
├── worker/sandbox/       # gVisor sandbox image, collector, Lima config
├── dashboard/            # local dashboard (Vite and React)
├── python/               # PyPI wrapper and wheel build
├── test/                 # CLI tests (`npm test` also runs proxy/*.test.mjs)
└── docs/                 # guides and screenshots
```

## Where help is needed

These are real gaps, already named in the README. If an issue for the one you
want isn't open yet, open one first and say you'd like to take it.

- **Windows.** Local sandboxes are experimental; Lima isn't downloaded on
  Windows. Honest docs and collected failure reports would help, and so would
  making first-run work there.
- **Codex prompts.** In local sandboxes, Codex's prompts don't reach the
  dashboard's Prompts page yet. Commands, file changes and network connections
  are already recorded.
- **First-run of the local VM.** The first `raytrace sandbox create --local`
  sets up a Lima VM and can take a few minutes. Clearer status and recovery
  when that gets stuck would help a lot of first-time users.
- **Docs.** A short demo GIF for the README, and anything in `docs/` that is
  unclear after you try the product yourself.

Look at [Issues](https://github.com/Godcreatebugs/raytrace-cli/issues) for
`good first issue` and `help wanted`. If you want to do something that isn't
listed, open an issue before a large pull request.

## Pull requests

1. Fork the repo and create a branch from `main`, named for what it does
   (`fix/codex-prompts-page`, `docs/windows-setup`).
2. Keep the change focused on one concern. Follow the style of the surrounding
   code. The CLI and proxy are JavaScript (`.mjs`); the dashboard is TypeScript
   and React.
3. Add or update tests when you change behavior. CLI tests live in `test/`,
   proxy tests next to the files they cover in `proxy/`.
4. Run `npm test`, `npm run typecheck`, and `npm run build`.
5. Open a pull request that says what changed and why, and links the issue.
   Screenshots help for dashboard changes.

## Reporting bugs and proposing features

For a bug, include your OS, `node --version`, the command or MCP prompt you
ran, what you expected, what happened, and any output from `raytrace doctor`
or logs under `~/.raytrace/logs/` (redact secrets). For a feature, say what
problem it solves and how you think it should work.

## Releasing (maintainers)

Each release goes to npm (`@raytrace-cli/cli`) and PyPI (`raytrace-cli`) at
the same version. The pip package is the npm package plus an official Node.js
build, one wheel per platform. PyPI does not allow the name `raytrace`.

Bump the version (`npm version x.y.z`), push the `vx.y.z` tag, `npm publish`,
then build the same version's wheels and upload them:

```sh
python3 python/build_wheels.py    # all six platforms, into python/dist/
twine upload python/dist/*.whl
```

The *pip wheels* workflow builds the same wheels on every `v*` tag and installs
them on Linux, macOS and Windows (x64 and ARM); its `wheels` artifact can be
uploaded instead (`gh run download <run-id> -n wheels`). The Node.js version
is `NODE_VERSION` in `python/build_wheels.py`. Run `twine upload` in a real
terminal, since it asks for the PyPI token (username `__token__`); `--verbose`
shows why PyPI refuses an upload. A version can only be uploaded once, and the
PyPI page's description (`python/README.md`) only changes with a new version.

## License

By contributing, you agree that your contributions are licensed under the MIT
License, the same as the rest of the project. See [LICENSE](LICENSE).
