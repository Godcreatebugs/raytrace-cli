# Syscall catalog

`syscall_catalog.sql` is a standalone, version-controlled SQLite catalog (catalog
version **2**). It has one row for every syscall name gVisor knows, 353 in all,
in eight groups: files, network, process, identity, memory, IPC, time and other.
Version 1 held the 84 file rows only; they are unchanged.

The catalog is the rulebook the sandbox host runs from:

- `setup.py` builds gVisor's trace configuration from the rows whose `capture`
  is `yes` or `watcher`, so what is subscribed cannot drift from what is listed.
- `engine.py` names raw events with `syscall_numbers` and reads each captured
  call with the rule its row names in `effect_rule`.

Loading the file into a database still enables nothing by itself, and changing
a row changes what is captured only after `setup.py` runs again on a host.

## Import and query

From the repository root, create a disposable database:

```sh
catalog_dir=$(mktemp -d)
sqlite3 "$catalog_dir/catalog.db" < worker/gvisor/syscall_catalog.sql
sqlite3 -header -column "$catalog_dir/catalog.db" \
  "SELECT syscall_name, category, default_impact_level, capture, detail FROM syscall_catalog_readable WHERE syscall_name = 'unlinkat';"
```

Expected result:

```text
syscall_name  category  default_impact_level  capture  detail
------------  --------  --------------------  -------  -----------
unlinkat      Delete    3                     watcher  number_only
```

What RayTrace captures, and how much gVisor can tell of each:

```sh
sqlite3 -header -column "$catalog_dir/catalog.db" \
  "SELECT group_id, syscall_name, capture, detail, effect_rule FROM syscall_catalog_readable WHERE capture != 'no' ORDER BY group_id, syscall_name;"
```

The import is transactional and idempotent. Re-importing restores catalog-owned
rows using upserts and preserves unrelated rows. It does not delete removed
entries or upgrade a version 1 database; use a fresh database. Use a dedicated
database, not the application or runtime evidence database. The script does not
modify `PRAGMA user_version`.

## Data model

| Table/view | Purpose |
| --- | --- |
| `syscall_impact_levels` | Four file impact levels and their meanings. |
| `syscall_groups` | The eight top-level groups. |
| `syscall_categories` | Stable operation identifiers, labels, and descriptions; the second level under a group. |
| `syscall_catalog` | One row per syscall name: description, group, category, nullable default level, rule identifier, required evidence, interpretation notes, the capture decision, and catalog version. |
| `syscall_numbers` | Generated. The number of each call on `x86_64` and `aarch64`, and whether gVisor implements it. |
| `syscall_coverage` | Generated. For the pinned gVisor release, whether a call has a typed trace point and with which optional fields, and what a live test observed. |
| `syscall_catalog_readable` | Joined view with group, category and impact labels, `detail` and `observed`, for inspection or export. |

| Level | Label | Meaning |
| --- | --- | --- |
| 0 | Observe | Read or inspect; sensitive reads and incidental access-time updates remain possible. |
| 1 | Create | Add an entry without replacing existing data. |
| 2 | Modify | Change contents, metadata, layout, or location. |
| 3 | Remove/replace | Remove an entry or replace an existing destination. |

Levels describe filesystem impact, **not maliciousness**. A level-0 secret read
can be concerning; a level-3 temporary-file deletion can be expected. Null means
conditional or not applicable, never level 0, and every row outside the file
group has a null level. Unknown syscall names have no row and must remain
unclassified. A recognized syscall with missing evidence may still have a known
operation category, but its actual effect stays unknown.

Names are not architecture-specific syscall numbers. For example, `newfstatat`
is a syscall name while `fstatat` is a common library interface. A listed name
need not exist on every architecture: `open`, `unlink` and `rename` have no
number on `aarch64`, where only the `*at` forms exist. Resolve numbers in
`syscall_numbers` against the execution architecture before lookup; do not
infer them from the collector host.

## What is captured

`capture` is RayTrace's decision for each row:

| `capture` | Meaning | Rows |
| --- | --- | --- |
| `yes` | Its gVisor trace point is subscribed, with the optional fields in `capture_fields`. | `open`, `openat`, `creat`, `connect`, `listen`, `setuid`, `setgid`, `setresuid`, `setresgid` |
| `watcher` | Only its raw exit point is subscribed: which process, when, and whether it was refused. gVisor does not decode its path, so the host's file watcher supplies the name. | `unlink`, `unlinkat`, `rmdir`, `rename`, `renameat`, `renameat2`, `truncate`, `ftruncate`, `mkdir`, `mkdirat`, `chmod`, `fchmod`, `fchmodat` |
| `sentry` | Seen through gVisor's own process points (clone, exec, exit), whatever syscall caused them. | `clone`, `clone3`, `fork`, `vfork`, `execve`, `execveat`, `exit`, `exit_group` |
| `no` | Not captured. | everything else |

`read` and `write` are deliberately `no`: they are by far the most frequent
calls, and whether a file changed is settled by comparing it before and after.
Every other `no` row is there so that no call is without a group, and so the
coverage can be stated: "we read this", "we see it without its path", or "we do
not watch it".

`detail` in the view is what gVisor can tell of a call in the pinned release:
`full` (a typed point with decoded paths, flags or addresses), `number_only`
(the number and six integers) or `none` (that release has no such call, as for
`openat2`). `observed` records what a live test saw arrive and is null until
`spike_points.py` has run for the release.

## Regenerating the generated tables

`syscall_numbers` and `syscall_coverage` come from gVisor's own source for the
release `setup.py` installs. After changing that release:

```sh
python3 worker/gvisor/catalog_numbers.py            # fetch the release, rewrite both tables
python3 worker/gvisor/catalog_numbers.py --check    # change nothing; fail if a call has no row
```

A syscall the new release has and the catalog lacks is refused until its row
is written. What a spike observed is kept for the same release and cleared for
a new one, since it has to be seen again.

## Classification contract

The rule identifiers below are specifications. `engine.py` implements the ones
its captured rows name (`open_effect`, `remove_entry`, `rename_effect`,
`file_resize`, `directory_create`, `metadata_change`, `connect_effect`,
`listen_effect`, `identity_effect`); the others describe calls that are not
captured. Keep the raw observation, attempted operation, outcome, and confirmed
effect separate. Preserve the catalog version when persisting classifications.

Every event needs sandbox/process identity, timestamp, syscall identity, and
outcome. A missing exit result is unknown, not success. Apply the row-specific
`required_evidence` and rules only after decoding signed results and errno.

| Rule | Interpretation |
| --- | --- |
| `open_effect` | Read-only opens without mutation flags are level 0, but do not prove bytes were read. Confirmed creation is level 1; successful truncation of an existing file is level 2. Writable access alone has no confirmed mutation level. `O_CREAT` alone does not establish creation. `creat` implies `O_WRONLY\|O_CREAT\|O_TRUNC`; `openat2` requires decoding `open_how`. Successful `O_CREAT\|O_EXCL` can establish new creation. Other ambiguous cases stay unresolved. |
| `file_write` | Level 2 applies only to file targets. Positive returned bytes establish writes, not necessarily different contents or durable storage. Record actual bytes, not just requested bytes; zero-byte and failed writes do not confirm modification. Honor append/offset flags without inventing an unavailable actual offset. |
| `remove_entry` | Level 3 is the attempted operation. A successful result confirms entry removal; failure does not. `AT_REMOVEDIR` distinguishes directory deletion. Other hard links or open descriptors may retain data. |
| `rename_effect` | Confirmed non-replacing move is level 2; confirmed replacement is level 3. Unknown destination history remains unresolved. `RENAME_NOREPLACE` success excludes replacement; `RENAME_EXCHANGE` is an exchange at level 2. Same-object operations may be no-ops. `RENAME_WHITEOUT` and unsupported flag combinations stay unresolved until specifically decoded. An earlier directory scan alone is not race-free replacement evidence. |
| `file_resize` | Level 2 operation; record requested length. Success confirms a length-setting operation, not a change from an unknown prior size. |
| `directory_create` | Level 1 operation; success confirms creation. Requested mode may differ from effective permissions because of umask or ACLs. |
| `file_read` | Level 0 for file targets; positive returned bytes establish a read. Zero bytes, failures, and an open alone do not. Do not retain buffer contents. |
| `inspect` | Level 0 inspection; metadata and accessibility checks do not prove later content access. |
| `metadata_change` | Level 2 operation; success does not prove a value differed. Keep attribute names and relevant permissions/ownership/timestamps, not attribute payloads. |
| `link_create` | Level 1 entry creation; distinguish hard links from symbolic-link target text. No claim that contents were copied or the target is safe. |
| `copy_effect` | Positive transfer to a known existing file is level 2. Creation is established separately by creation evidence. Unknown targets remain unresolved; pipes and sockets are not filesystem edits. |
| `allocation_effect` | Successful, decoded file allocation/range changes are level 2. Distinguish allocation from punch-hole, zero-range, collapse-range and insert-range; allocation does not alone establish changed content. Unknown flags remain unresolved. |
| `ioctl_effect` | Decode command-specific semantics first. Supported file clone operations and attribute changes are level 2; supported inspection is level 0. Unknown commands have no default level. |
| `mapping_effect` | Record mapping capability/lifecycle, not confirmed reads or writes. `MAP_SHARED` plus writable protection permits edits but does not prove them. `msync`/`munmap` alone do not prove changed bytes. Leave confirmed impact unresolved without additional evidence. |
| `bookkeeping` | No direct filesystem impact level. Track descriptor duplication/reuse, working directories, offsets, synchronization, and command-dependent `fcntl` behavior as context. |
| `connect_effect` | Decode the address family, IP address and port. A zero result is a connection on a stream socket and only a default peer on a datagram socket. `EINPROGRESS` is an attempt whose outcome this call does not report. A destination in a range the sandbox firewall rejects is a refused attempt. The address is never a host name: a name shown beside it comes from DNS evidence and is a best match. No payload is captured. |
| `listen_effect` | Success means the process accepts connections on the bound address. Nothing outside the sandbox network is routed to it. |
| `identity_effect` | Record the requested IDs and the result. Success changes the identity the process acts as; the sandbox has no capabilities, so a successful change away from its one user is unexpected, and a failure is an attempt. |
| `process_lifecycle` | gVisor's clone, exec and exit points report every task, program start and exit, whichever syscall caused it. A successful exec proves a program started, not what it did; a zero result on the exec syscall point is not treated as success. Keep arguments as observed and, of the environment, only the two `RAYTRACE_` markers. |
| `not_classified` | The call is listed and grouped, and nothing is collected for it. No fact records its use and none rules it out. |

For example, successful `unlinkat` can display **L3 · Delete · Succeeded**;
`EACCES` can display **L3 · Delete · Failed: permission denied**. Neither label
requires a new process or PID. A failed operation must not appear in a list of
confirmed file changes.

Store the supplied pathname and directory base independently; do not label a
lexically joined path as fully resolved through symlinks. Descriptor identities
must account for reuse and inheritance. Unresolved target types/paths must stay
explicit. Preserve both source and destination for rename/link/copy events.

## Boundaries and validation

A row is not a completeness guarantee, and a default level is not evidence of
success. What the captured set does not see:

- **Bytes read or written.** An open for reading is recorded as a read of the
  file; whether a file changed comes from comparing it before and after.
- **Memory-mapped writes and `io_uring`.** Both change files without the
  ordinary calls. The file still has to be opened, and the before/after
  comparison still sees the change.
- **Datagrams sent without `connect`.** `sendto` and `sendmsg` name their own
  destination and are not captured. The firewall still applies, and DNS is seen
  by the host resolver.
- **Paths of `watcher` calls.** A refused delete or rename is known by process
  and time, not by file.
- **Calls gVisor does not implement** (`support = 'unsupported'` in
  `syscall_numbers`) fail inside the sandbox whatever the catalog says.

No buffer contents or environment values are required by these rules. This
catalog does not change existing evidence storage, retention, or redaction.

Run isolated validation, including repeat import and constraints:

```sh
python3 -B -m unittest discover -s worker/gvisor -p 'test_syscall_catalog.py'
```

Semantic references: [Linux syscall inventory](https://man7.org/linux/man-pages/man2/syscalls.2.html),
[open](https://man7.org/linux/man-pages/man2/open.2.html),
[rename](https://man7.org/linux/man-pages/man2/rename.2.html),
[memory mappings](https://man7.org/linux/man-pages/man2/mmap.2.html), and
[gVisor SecCheck](https://github.com/google/gvisor/blob/release-20260817.0/pkg/sentry/seccheck/README.md).
