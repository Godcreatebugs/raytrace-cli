# Cloud sandboxes

A cloud sandbox is the same isolated copy of your project, on RayTrace's
servers, with sessions recorded for your organization at
**[app.raytracer.si](https://app.raytracer.si)**. This is a preview. The
[README](../README.md#cloud-sandboxes) has the short setup. This page covers
what is uploaded, limits, beta invites, and what happens when you are done.

```sh
npm install -g @raytrace-cli/cli
raytrace auth login                    # opens your browser: sign in, or create your account
cd your-project                        # any Git repository
raytrace sandbox create                # uploads it and prints the sandbox id
raytrace connect <sandbox-id> --claude # a terminal in it, with Claude Code running
```

`auth login` prints a short code and opens the sign-in page; approve it there.
If you skip it, `sandbox create` and `connect` ask you to sign in first. With
one sandbox, `connect` needs no id. You can also create a sandbox in the web
dashboard by dropping a project folder on the **Sandboxes** page.

## What is uploaded

The files Git would track (including new files it doesn't ignore), **without**
`.git`, dependencies such as `node_modules`, build output, `.env*` files, private
keys (`.pem`, `.key`, `.p12`, `.pfx`) and common credential files (`.npmrc`,
`.netrc`, `id_rsa`, …). Check for secrets inside other files before you upload.

## Limits

- **Project size:** up to 200 MiB and 20,000 files, each file up to 25 MiB
  (100 MiB once packed). A project over a limit is refused, with the files
  named, and nothing is uploaded; add those files to `.gitignore`.
- **Sandboxes at a time:** Beta 1, Individual 5, Team & Enterprise 20.
  Destroyed ones don't count.
- **Each sandbox:** 2 GB of memory, 2 CPUs, 256 processes, a 512 MB `/tmp`.

## When you are done

`raytrace sandbox stop` keeps the files. `raytrace sandbox destroy` deletes them
and any sign-in made inside, along with the recorded traces. To keep the traces,
use `--keep-traces` (paid plans).

## Beta invites

If RayTrace gave you a beta code, sign in, redeem it, then create your sandbox:

```sh
raytrace auth login
raytrace --code <code>
raytrace sandbox create
```

The code gives you one sandbox with $10 of model credit. Codes are single-use
and expire 3 days after they're issued, and the credit expires 3 days after you
redeem it. Your account and that sandbox show as **Beta** in the cloud dashboard
until then.
