# RayTrace on Windows

Windows is **experimental**. This page is the honest version: what works
today, what does not, and the two paths that get you a sandbox anyway.

## What works on native Windows

Everything that does not need a local VM: installing the CLI, `raytrace
setup`, the proxy and the local dashboard, and **cloud sandboxes**
([docs/cloud.md](cloud.md)). Local sandboxes are the only part that does
not work natively, for the reason below.

## What does not: local sandboxes

Local sandboxes (`raytrace sandbox create --local`) run in a Linux VM
managed by [Lima](https://lima-vm.io). Two facts combine against native
Windows:

- RayTrace downloads Lima for you on macOS and Linux only. Its pinned
  release list has no Windows entry, and `raytrace doctor` will keep
  reporting Lima as missing no matter how often you run setup.
- Lima itself has no native Windows build. On Windows it is used inside
  WSL2, which is exactly the first path below.

So on native Windows, `raytrace doctor` says local sandboxes are
experimental and the Lima check fails. That is expected, not a broken
install.

## Path 1: local sandboxes inside WSL2

Run RayTrace inside a WSL2 Linux distribution and it behaves like Linux,
because it is Linux:

1. Install WSL2 with Ubuntu, from an admin PowerShell:

   ```powershell
   wsl --install
   ```

   Reboot if Windows asks, then open Ubuntu once to finish its setup.

2. Inside Ubuntu, install RayTrace. The npm package needs Node.js 22.13
   or newer; the PyPI package brings its own Node:

   ```sh
   uvx --from raytrace-cli raytrace doctor
   ```

   (or `npx -y @raytrace-cli/cli@latest doctor` with Node installed).

3. Follow the Linux requirements `doctor` prints there: Lima and QEMU
   (`sudo apt install qemu-system`), and access to `/dev/kvm`. Recent
   WSL2 on Windows 11 exposes `/dev/kvm`; if `doctor` reports no
   `/dev/kvm`, the VM runs emulated and is very slow, and cloud sandboxes
   (path 2) are the better choice on that machine.

4. Keep the project inside the WSL2 filesystem (for example under `~`),
   not under `/mnt/c`: the VM shares files with the sandbox, and the
   Windows mount is much slower for that.

Then create sandboxes as on Linux:

```sh
raytrace sandbox create --local
raytrace connect my-box --claude
```

## Path 2: cloud sandboxes from native Windows

No VM, no Lima, nothing to install beyond the CLI:

```sh
raytrace auth login
cd your-project
raytrace sandbox create
raytrace connect <sandbox-id> --claude
```

[docs/cloud.md](cloud.md) covers what gets uploaded, the limits, and how
to destroy a cloud sandbox when you are done.

## Reporting what you find

Windows feedback is genuinely useful here. If you try either path, open
an issue with:

- which path you took (native, WSL2, cloud) and your Windows version,
- the output of `raytrace doctor` (run it where you ran the CLI: inside
  WSL2 for path 1),
- what worked and what failed, with any secrets removed.
