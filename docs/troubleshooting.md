# Troubleshooting and uninstall

## Troubleshooting

- **The MCP server doesn't show up in my editor:** restart the editor after
  adding it. In Claude Code, `claude mcp list` shows whether it's connected.
  Check that `node --version` is 22.16 or newer (Node.js 23 is not supported).
- **No terminal opened after "connect":** the agent's reply has the command to
  paste, such as `raytrace connect my-box --claude`. On macOS, allow your editor
  to control your terminal app in **System Settings → Privacy & Security →
  Automation**.
- **The first local sandbox is taking long:** setting up the VM takes a few
  minutes. Ask the agent for the sandbox status, or read
  `~/.raytrace/logs/mcp-create-<name>-*.log`. The whole VM log is in
  `~/.raytrace/logs/sandbox-vm.log`.
- **`sandbox create --local` says the machine isn't ready:** each line says
  what's missing and how to fix it; `raytrace doctor` shows the same. Port 8798
  in use usually means another Lima VM is running (`limactl list`).
- **A local sandbox's sessions don't show in the dashboard:** restart RayTrace
  with `raytrace stop && raytrace start`.
- **The dashboard says this browser isn't signed in:** run `raytrace open`.
- **`Cannot reach RayTrace at https://api.raytracer.si`:** check your
  connection. Networks that inspect HTTPS, such as some company Wi-Fi, can block
  it.
- **A sandbox isn't found:** `raytrace auth status` shows which account you're
  signed in as. Sandboxes belong to the account that made them.

## Git in a connected sandbox

A refusal from RayTrace comes back as git's own error (`remote: ...` or
`! [remote rejected] ... (...)`). What each one means:

- **`agents here push only to raytrace/<8 characters>/<branch>`:** the push went
  to a branch outside the sandbox's own. Push to that prefix, such as
  `git push -u origin HEAD:raytrace/<8 characters>/fix`, and open the pull
  request from it.
- **`deleting branches is not allowed from a sandbox`:** delete it on GitHub.
- **`Attach owner/name to this sandbox to push to it.`** or
  **`owner/name is private or does not exist: attach it to this sandbox to use it here.`:**
  run `raytrace sandbox repos <id> --add owner/name`. Check the spelling.
- **`Install the RayTrace GitHub App on owner/name and connect it on your account page first.`**
  or **`The RayTrace GitHub App is not installed on owner/name for this organization.`:**
  an org admin adds the repository to the App's installation on GitHub, or
  connects GitHub on the [account page](https://raytracer.si/account.html).
- **`GitHub did not let this sandbox reach owner/name. Is the RayTrace GitHub App still installed on it?`:**
  the App was removed from the repository, or lost access. Reinstall it, then try again.
- **`GitHub moved owner/name (it may have been renamed): attach the new name.`:**
  `raytrace sandbox repos <id> --remove owner/name --add owner/new-name`, then
  `git remote set-url origin https://github.com/owner/new-name.git` in the sandbox.
- **`GitHub could not open owner/name just now; try again.`:** GitHub did not
  answer RayTrace in time; try again in a minute.
- **`The GitHub connector is not set up on this RayTrace.`:** the RayTrace you use
  has no GitHub App configured. On a self-hosted one, see its control-plane README.
- **`Too many git requests from this sandbox; wait a minute.`:** a loop of git
  commands; wait a minute.
- **`Git is not available in Playground forks.`:** forks never reach GitHub;
  push from the sandbox itself.
- **`sandbox create --connect` said "created, but not connected":** the sandbox
  is running; fix what it says and run the `Try again:` command it printed.

## First local sandbox setup

The commands below are for macOS and Linux. On Windows, follow the
[WSL2 guide](windows.md). Start with `raytrace doctor`; it checks prerequisites
without downloading Lima or creating a sandbox.

### Find the VM and its logs

`raytrace doctor` says whether Lima is **installed** or **downloaded by
RayTrace**. Use that same binary for the commands below:

```sh
LIMACTL=limactl                         # installed Lima 2.0 or newer
# If doctor reports a managed copy, use its directory plus /bin/limactl:
# LIMACTL="$HOME/.raytrace/lima/2.2.1/bin/limactl"
"$LIMACTL" list
```

The managed version and directory are printed by `doctor`; do not use an older
`limactl` on your PATH instead. If you set `RAYTRACE_HOME`, the managed copy and
RayTrace logs are under that directory rather than `~/.raytrace`.

In a second terminal, watch the VM setup log:

```sh
tail -f "${RAYTRACE_HOME:-$HOME/.raytrace}/logs/sandbox-vm.log"
```

An MCP create request also writes `logs/mcp-create-<name>-*.log` under the same
RayTrace home. These files may not exist yet while Lima itself is downloading.

### A download or provisioning step is slow

The first run downloads Lima if needed, an Ubuntu image, and dependencies for
the sandbox image (about 1 GB in total). Later runs reuse the VM. Check the
latest log lines for download progress or a concrete network error; a quiet
terminal alone does not mean setup failed. Slow networks can take longer than
the usual few minutes.

VM creation, startup and provisioning print a status update every ten seconds,
including elapsed time and the latest VM log line. Each step has a thirty-minute
timeout. A failed or timed-out step prints its recent output, full log path and
the `raytrace doctor` command. After fixing the reported problem, retry the same
command: it reuses the existing VM and repeats unfinished provisioning. The
timeout does not delete the VM or local sandboxes.

If the download fails, check that your network can reach GitHub releases and
the image/package URLs named in the log, then retry `raytrace sandbox create
--local` from your repository. For a Lima download error, installing Lima 2.0+
yourself is another option; see [Lima installation](https://lima-vm.io/docs/installation/).
A checksum mismatch must be resolved before continuing; do not bypass it.

### Port 8798 is already in use

8798 is the VM's evidence viewer port, separate from the dashboard on 8797.
Check `"$LIMACTL" list` and identify the listener:

```sh
lsof -nP -iTCP:8798 -sTCP:LISTEN          # macOS, or Linux with lsof
# On Linux, alternatively: ss -ltnp 'sport = :8798'
```

Stop the application that owns the port, or stop the other Lima VM with
`"$LIMACTL" stop <its-name>` if it is safe to interrupt its work. Do not delete
another VM to free the port. If the `raytrace` VM is already running, RayTrace
normally reuses it and recognizes that the viewer port belongs to it. Rerun
`raytrace doctor` before retrying.

### Linux reports missing or inaccessible /dev/kvm

```sh
ls -l /dev/kvm
id -nG
```

If the device is absent, enable hardware virtualization in your firmware; on a
virtual machine, the host must expose nested virtualization. Without KVM,
emulation can be very slow. If the device exists but `doctor` reports no access,
on systems using the `kvm` group run `sudo usermod -aG kvm "$USER"`, then log out
and back in. Verify with `raytrace doctor`. Also install the QEMU package named
by `doctor` if it is missing.

### Setup was interrupted

Wait for the previous create/Lima process to finish or stop it before retrying;
do not run two setups at once. Check `"$LIMACTL" list` and the logs. Rerun
`raytrace sandbox create --local` from the same repository: it starts an existing
stopped `raytrace` VM, reuses a running one, and reruns incomplete VM provisioning.

If `raytrace sandbox list --local` already lists your sandbox, use
`raytrace sandbox start <name>` and then `raytrace connect <name>` instead of
creating the same name again. This can happen when setup was interrupted after
the sandbox was registered.

### Reset a half-created first-run VM

Use this only after the checks above, when the first VM cannot start or finish
provisioning and there are no local sandboxes you need to keep. **Deleting the
`raytrace` VM deletes every local sandbox and all data inside that VM**, including
changes that exist only there. Check `raytrace sandbox list --local` and save
needed work first. Your original project on the host is separate.

Once the previous setup process has stopped:

```sh
"$LIMACTL" delete --force raytrace
raytrace sandbox create --local         # from your Git repository
```

This resets the VM, not RayTrace's host-side registry or logs. If you already
have registered sandboxes, follow their individual start/destroy workflow
instead of treating this as a first-run reset. If setup still fails, include
your OS, `raytrace doctor` output and relevant log lines in an issue, with keys
and private paths redacted.

## Uninstall

```sh
raytrace sandbox destroy <id or name>   # any sandboxes you no longer need
raytrace uninstall --purge              # local sandboxes: deletes the VM and ~/.raytrace
raytrace auth logout
npm uninstall -g @raytrace-cli/cli     # or: pip uninstall raytrace-cli
claude mcp remove raytrace -s user      # if you added the MCP server to Claude Code
```

Without `--purge`, remove the VM yourself with `limactl delete --force raytrace`.
