# Troubleshooting and uninstall

## Troubleshooting

- **The MCP server doesn't show up in my editor:** restart the editor after
  adding it. In Claude Code, `claude mcp list` shows whether it's connected.
  Check that `node --version` is 22.13 or newer.
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

## Uninstall

```sh
raytrace sandbox destroy <id or name>   # any sandboxes you no longer need
raytrace uninstall --purge              # local sandboxes: deletes the VM and ~/.raytrace
raytrace auth logout
npm uninstall -g @raytrace-cli/cli     # or: pip uninstall raytrace-cli
claude mcp remove raytrace -s user      # if you added the MCP server to Claude Code
```

Without `--purge`, remove the VM yourself with `limactl delete --force raytrace`.
