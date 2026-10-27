"""The sandbox host's fact engine. Python stdlib only; never mount into guests.

gVisor reports every open, connect, delete and rename a sandbox makes. That is
far too much to keep and most of it concerns nobody: one `npm install` opens
tens of thousands of files. The engine looks at each event once, in memory,
keeps what matters as a fact, counts the rest and stores no event at all.

What matters:

    files     a file the project's owner restricted or watches, and a new file
              whose path marks it sensitive (a .env, a key): read, created,
              changed, emptied, appended, deleted, renamed, or an attempt
              the kernel refused
    network   every connection out of the sandbox, one fact for each
              destination a step reached, and whether the firewall refuses it
    packages  what a package manager left installed once it had run
    identity  a change of user or group id, which a sandbox should never make

A fact combines three witnesses, and says which it had (`basis`, `certainty`):

    gVisor     who asked for what, and when (collector.py). For an open it
               gives the path and flags; for a delete or rename only the
               number of the call and whether it was refused.
    the host   what the file is before and after: size, time, inode, SHA-256,
               read from the sandbox's volume by this process, not the agent.
    a watcher  inotify on the folders of those files, which names the file a
               delete or rename hit; it is matched to gVisor's call by time.

    confirmed     a call was seen and the file shows its effect
    attempted     the kernel refused the call
    possible      opened for writing, and the file is as it was
    one_of        more than one process made such a call at that moment
    unattributed  the file changed and no call was seen for it
    reported      read from files the agent could have written (packages)

Each fact names its process and, when the process carries one, the tool call
(RAYTRACE_CALL_ID, as the forwarder reads it). Facts go to the `facts` table of
the collector's database, where viewer.py serves them and the control plane
(facts.py) collects them. Which calls arrive at all is syscall_catalog.sql's
`capture` column, through setup.py.
"""
import collections
import ctypes
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import platform
import posixpath
import queue
import re
import sqlite3
import stat
import struct
import threading
import time

import file_scan
import network

CATALOG = Path(__file__).with_name('syscall_catalog.sql')
# Which sandbox a container is, and where its volumes are (projects.py writes one file each).
CONTAINERS = Path('/var/lib/raytace/containers')
# Each sandbox's restricted and watched files (projects.py guardrails()).
GUARDRAILS = Path('/var/lib/raytace/guardrails')
BRIDGE = Path('/etc/raytace/bridge')
WORKSPACE = '/workspace/'
# Large, regenerable folders: the same ones the sandbox hook leaves out of its snapshots.
SKIPPED = frozenset(['node_modules', '.git', '.next', '.vinext', 'dist', 'build', 'out', 'coverage', '.cache', '.turbo',
                     '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', 'target', '.gradle', '.wrangler'])
SCHEMA = '''
  CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY AUTOINCREMENT, fact_id TEXT NOT NULL UNIQUE,
    container_id TEXT NOT NULL, kind TEXT NOT NULL, at_ns TEXT NOT NULL, received_ms INTEGER NOT NULL, body TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS facts_container ON facts(container_id, id);
  CREATE TABLE IF NOT EXISTS dns_cache (client TEXT NOT NULL, ip TEXT NOT NULL, name TEXT NOT NULL, seen_ns INTEGER NOT NULL,
    PRIMARY KEY (client, ip));
'''
AT_FDCWD = -100
O_ACCMODE, O_CREAT, O_TRUNC, O_APPEND = 3, 0o100, 0o1000, 0o2000
REFUSED = {1: 'EPERM', 13: 'EACCES', 30: 'EROFS'}
ERRNO = {**REFUSED, 2: 'ENOENT', 101: 'ENETUNREACH', 110: 'ETIMEDOUT', 111: 'ECONNREFUSED', 113: 'EHOSTUNREACH', 115: 'EINPROGRESS'}
EINPROGRESS = 115
MAX_HASHED = 5 * 1024 * 1024    # a larger file is compared by size, time and inode
HASH_LIMIT = 2000               # with more files than this to keep, none is hashed up front
SENSITIVE_FROM = 4              # file_scan's level from which a new file's path alone is worth a fact
SETTLE = 0.3                    # seconds between a change seen on disk and looking: gVisor's call may still be on its way
WRITER_LIFE = 900               # how long an open for writing may explain a later change
RAW_WINDOW = (2_000_000_000, 1_000_000_000)   # ns a delete or rename call may precede, or follow, the watcher's notice
BULK = 200                      # opens from which a step is worth one summary line
RETAIN_DAYS, RETAIN_ROWS = 14, 50_000
PACKAGE_TOOLS = frozenset(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'uv', 'poetry'])
REGISTRIES = frozenset(['registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org'])
MAX_PACKAGES = 400
REJECTED = [ipaddress.ip_network(block) for block in network.REJECTED]
OWN_KINDS = frozenset(['open', 'connect', 'listen', 'setid'])
PROCESS_KINDS = frozenset(['exec_succeeded', 'clone', 'process_exit', 'collection_gap', 'collector_disconnected'])
CALL_MARKER = re.compile(r'(?:^|[\s;])export RAYTRACE_CALL_ID=([A-Za-z0-9_-]{1,128})(?=[\s;]|$)')
SANDBOX_ID = re.compile(r'rt[pf]-[a-f0-9]{32}')


def open_inside(root, path, directory=False):
    """A descriptor for a file below `root`, every step of the way opened
    without following links: the agent names its own folders, and a link out
    of the project is never read."""
    at = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        parts = PurePosixPath(path).parts
        for index, part in enumerate(parts):
            last = index == len(parts) - 1
            below = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_DIRECTORY if directory or not last else 0), dir_fd=at)
            os.close(at)
            at = below
        return at
    except BaseException:
        os.close(at)
        raise


def photo(root, path, hashed=True):
    """What a project file is now: None when it is not there (or is no regular file)."""
    try:
        fd = open_inside(root, path)
    except (OSError, ValueError):
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            return None
        found = {'size': info.st_size, 'mtime_ns': info.st_mtime_ns, 'inode': info.st_ino, 'mode': stat.S_IMODE(info.st_mode), 'sha256': None}
        if hashed and info.st_size <= MAX_HASHED:
            digest = hashlib.sha256()
            while chunk := os.read(fd, 1024 * 1024):
                digest.update(chunk)
            found['sha256'] = digest.hexdigest()
        return found
    except OSError:
        return None
    finally:
        os.close(fd)


def read_inside(root, path, limit):
    """A file's bytes, or None when it is absent, no regular file or over `limit`."""
    try:
        fd = open_inside(root, path)
    except (OSError, ValueError):
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            return None
        return b''.join(iter(lambda: os.read(fd, 1024 * 1024), b''))
    except OSError:
        return None
    finally:
        os.close(fd)


def names_inside(root, path):
    try:
        fd = open_inside(root, path, directory=True)
    except (OSError, ValueError):
        return []
    try:
        return os.listdir(fd)
    except OSError:
        return []
    finally:
        os.close(fd)


def change(before, after, events, flags):
    """What happened to a file between two photos, or None when nothing did."""
    if after is None:
        return None if before is None else 'renamed' if 'moved_from' in events else 'deleted'
    if before is None:
        return 'created'
    if before['sha256'] and after['sha256']:
        same = before['sha256'] == after['sha256']
    else:
        same = (before['size'], before['mtime_ns'], before['inode']) == (after['size'], after['mtime_ns'], after['inode'])
    if same:
        return 'permissions_changed' if before['mode'] != after['mode'] else None
    if after['size'] == 0:
        return 'emptied'
    if flags & O_APPEND and after['size'] > before['size']:
        return 'appended'
    return 'changed'


def project_path(event):
    """The project file an open names, relative to the project, or None when
    it is outside it. Worked out from the text of the path: links inside the
    project are not followed, which a fact says as `resolution: lexical`."""
    name = event.get('pathname') or ''
    if not name:
        return None
    if not name.startswith('/'):
        base = event.get('cwd') if event.get('dirfd', AT_FDCWD) == AT_FDCWD else event.get('fd_path')
        if not base or not base.startswith('/'):
            return None
        name = base + '/' + name
    name = posixpath.normpath(name)
    return name[len(WORKSPACE):] if name.startswith(WORKSPACE) else None


def installed(workspace, home):
    """{(manager, name, version): where it came from} as the package managers'
    own records on the volume have it. The agent can write those files, so a
    fact drawn from them is `reported`, not seen."""
    found = {}
    roots = [''] + [name for name in names_inside(workspace, '') if name not in SKIPPED and not name.startswith('.')][:50]
    for root in roots:
        modules = posixpath.join(root, 'node_modules')
        lock = read_inside(workspace, posixpath.join(modules, '.package-lock.json'), 32 * 1024 * 1024)
        try:
            listed = json.loads(lock)['packages'] if lock else None
        except (ValueError, KeyError, TypeError):
            listed = None
        if isinstance(listed, dict):
            for key, entry in listed.items():
                if isinstance(key, str) and isinstance(entry, dict) and isinstance(entry.get('version'), str):
                    found[('npm', key.rsplit('node_modules/', 1)[-1][:200], entry['version'][:80])] = str(entry.get('resolved') or '')[:300] or None
            continue
        # No npm record (yarn, pnpm, bun): the packages at the top of node_modules.
        for name in names_inside(workspace, modules)[:1000]:
            for package in ([posixpath.join(name, inner) for inner in names_inside(workspace, posixpath.join(modules, name))[:200]]
                            if name.startswith('@') else [name]):
                text = read_inside(workspace, posixpath.join(modules, package, 'package.json'), 1024 * 1024)
                try:
                    version = json.loads(text)['version'] if text else None
                except (ValueError, KeyError, TypeError):
                    version = None
                if isinstance(version, str):
                    found[('node', package[:200], version[:80])] = None
    sites = [(workspace, posixpath.join(env, 'lib')) for env in ('.venv', 'venv')] + ([(home, '.local/lib')] if home else [])
    for volume, lib in sites:
        for python in names_inside(volume, lib)[:10]:
            for name in names_inside(volume, posixpath.join(lib, python, 'site-packages')):
                if name.endswith('.dist-info') and '-' in name:
                    package, _, version = name[:-len('.dist-info')].rpartition('-')
                    found[('pip', package[:200], version[:80])] = None
    return found


class Inotify:
    """The host kernel's file notifications, for the folders of the files
    worth a fact. It names the file a delete or rename hit, which gVisor does not."""
    CLOSE_WRITE, MODIFY, ATTRIB, CREATE, DELETE, MOVED_FROM, MOVED_TO = 0x8, 0x2, 0x4, 0x100, 0x200, 0x40, 0x80
    DELETE_SELF, MOVE_SELF, OVERFLOW, IGNORED, ONLYDIR = 0x400, 0x800, 0x4000, 0x8000, 0x01000000
    WORDS = [(CLOSE_WRITE, 'close_write'), (MODIFY, 'modify'), (ATTRIB, 'attrib'), (CREATE, 'create'), (DELETE, 'delete'),
             (MOVED_FROM, 'moved_from'), (MOVED_TO, 'moved_to')]
    FOLDER = CLOSE_WRITE | MODIFY | ATTRIB | CREATE | DELETE | MOVED_FROM | MOVED_TO | DELETE_SELF | MOVE_SELF | ONLYDIR

    def __init__(self):
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.fd = self.libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)  # AttributeError where there is no inotify
        if self.fd < 0:
            raise OSError(ctypes.get_errno(), 'inotify_init1')

    def add(self, root, folder):
        """Watches a folder of a project, reached without following links."""
        fd = open_inside(root, folder, directory=True)
        try:
            watch = self.libc.inotify_add_watch(self.fd, f'/proc/self/fd/{fd}'.encode(), self.FOLDER)
            if watch < 0:
                raise OSError(ctypes.get_errno(), 'inotify_add_watch')
            return watch
        finally:
            os.close(fd)

    def remove(self, watch):
        self.libc.inotify_rm_watch(self.fd, watch)

    def read(self):
        try:
            data = os.read(self.fd, 256 * 1024)
        except BlockingIOError:
            return []
        events, at = [], 0
        while at + 16 <= len(data):
            watch, mask, cookie, size = struct.unpack_from('iIII', data, at)
            events.append((watch, mask, cookie, os.fsdecode(data[at + 16:at + 16 + size].split(b'\0', 1)[0])))
            at += 16 + size
        return events


class Sandbox:
    """What the engine holds of one container, all of it in memory."""
    def __init__(self, container):
        self.container = container
        self.sid = self.workspace = self.home = self.ip = None
        self.fork = False
        self.mapped = self.guarded_at = None   # the two files' times, as last read
        self.restricted, self.watched, self.sensitive = set(), set(), set()
        self.guarded = {}        # path -> restricted | watched | sensitive
        self.hashing = True
        self.photos = {}         # path -> its last photo; None: it was not there
        self.known = None        # project paths that exist, to tell a new file from an old one
        self.processes = {}      # pid -> {start_ns, ppid, name, argv, call_id}
        self.writers = {}        # path -> opens for writing that may explain a change
        self.due = {}            # path -> when to look at it next (monotonic)
        self.final = {}          # path -> when to stop waiting for a change
        self.causes = {}         # path -> what the watcher saw of it since the last look
        self.raw = collections.deque(maxlen=512)   # recent delete, rename, resize and mode calls: they carry no path
        self.watches = {}        # folder -> inotify watch
        self.counts = {}         # step -> opens that were only counted
        self.packages = None     # what was installed when last looked
        self.package_due = self.package_who = None
        self.registry_at = float('-inf')   # when a package registry was last connected to
        self.gap_at = float('-inf')        # when events were last lost
        self.names = {}          # ip -> (host name, when read)


class Engine(threading.Thread):
    def __init__(self, database, arch=None, watch=True, clock=time.monotonic):
        super().__init__(daemon=True, name='raytace-engine')
        self.database = database
        self.clock = clock
        catalog = sqlite3.connect(':memory:')
        try:
            catalog.executescript(CATALOG.read_text())
            # number -> (name, rule) for the calls the catalog captures on this architecture.
            self.calls = {number: (name, rule) for number, name, rule in catalog.execute(
                "SELECT n.sysno, c.syscall_name, c.effect_rule FROM syscall_catalog AS c JOIN syscall_numbers AS n "
                "ON n.syscall_name = c.syscall_name AND n.arch = ? WHERE c.capture IN ('yes', 'watcher')",
                (arch or {'arm64': 'aarch64'}.get(platform.machine(), platform.machine()),))}
        finally:
            catalog.close()
        # Calls gVisor reports by number only: taken from the collector whole.
        self.numbered = frozenset(number for number, (_, rule) in self.calls.items() if rule in ('remove', 'rename', 'resize', 'mkdir', 'metadata'))
        self.inbox = queue.Queue(maxsize=200_000)
        self.overflowed = float('-inf')
        self.bridge = ('', float('-inf'))   # RayTrace's own bridge as sandboxes reach it, and when that was read
        self.boxes = {}
        self.facts = {}          # fact id -> the fact, while it may still grow
        self.dirty = {}          # fact ids to write
        self.inotify = None
        self.watched = {}        # inotify watch -> (sandbox, folder)
        if watch:
            try:
                self.inotify = Inotify()
            except (AttributeError, OSError) as error:
                print(f'RayTrace engine: no file watcher ({error}); deletes and renames will not be named', flush=True)
        self.db = None
        self.ticked = self.flushed = self.swept = 0.0
        self.errors = 0

    # ------------------------------------------------------------ from the collector

    def accept(self, event):
        """Called on a sandbox's reader thread for every event: queues it and
        answers whether it is the engine's own (a file or network call), which
        the collector then does not write. Never blocks and never raises."""
        try:
            kind = event.get('kind')
            own = kind in OWN_KINDS or (kind in ('syscall_return', 'syscall_enter') and event.get('sysno') in self.numbered)
            if own or kind in PROCESS_KINDS:
                try:
                    self.inbox.put_nowait(event)
                except queue.Full:
                    self.overflowed = self.clock()   # said on every fact for a minute: coverage has a gap
            return own
        except Exception:
            return False

    def run(self):
        self.db = sqlite3.connect(self.database, timeout=10)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript(SCHEMA)
        while True:
            try:
                busy = self.turn()
            except Exception as error:
                busy = False
                self.errors += 1
                if self.errors <= 20:
                    print(f'RayTrace engine: {type(error).__name__}: {error}', flush=True)
            if not busy:
                time.sleep(0.02)

    def turn(self):
        """One pass: the events waiting, the watcher, then whatever is due."""
        handled = 0
        while handled < 5000:
            try:
                event = self.inbox.get_nowait()
            except queue.Empty:
                break
            handled += 1
            try:
                self.handle(event)
            except Exception as error:
                self.errors += 1
                if self.errors <= 20:
                    print(f'RayTrace engine: {event.get("kind")}: {type(error).__name__}: {error}', flush=True)
        seen = self.watcher_events()
        now = self.clock()
        for box in list(self.boxes.values()):
            for path in [path for path, at in box.due.items() if at <= now]:
                del box.due[path]
                self.look(box, path)
            for path in [path for path, at in box.final.items() if at <= now and path not in box.due]:
                del box.final[path]
                self.look(box, path, final=True)
            if box.package_due and box.package_due <= now:
                box.package_due = None
                self.packages(box)
        if now - self.ticked >= 1:
            self.ticked = now
            for box in list(self.boxes.values()):
                self.refresh(box)
                self.summaries(box, now)
        if now - self.flushed >= 1:
            self.flushed = now
            self.flush()
        if now - self.swept >= 3600:
            self.swept = now
            self.sweep()
        return bool(handled or seen)

    def handle(self, event):
        container = event.get('container_id')
        if not container:
            return
        kind = event['kind']
        if kind == 'collector_disconnected':
            box = self.boxes.pop(container, None)
            if box:
                self.close(box)
            return
        box = self.boxes.get(container)
        if box is None:
            box = self.boxes[container] = Sandbox(container)
            self.refresh(box)
        if kind == 'open':
            self.opened(box, event)
        elif kind in ('connect', 'listen'):
            self.connected(box, event)
        elif kind == 'setid':
            self.identity(box, event)
        elif kind == 'syscall_return':
            self.numbered_call(box, event)
        elif kind == 'exec_succeeded':
            self.executed(box, event)
        elif kind == 'clone':
            child, parent = event.get('child_pid'), box.processes.get(event.get('pid'))
            if child and child != event.get('pid'):
                box.processes[child] = {**(parent or {'name': event.get('process_name'), 'argv': [], 'call_id': None}),
                                        'ppid': event.get('pid'), 'start_ns': event.get('child_start_ns')}
        elif kind == 'process_exit':
            self.exited(box, event)
        elif kind == 'collection_gap':
            box.gap_at = self.clock()

    # ------------------------------------------------------------ sandboxes and their lists

    def refresh(self, box):
        """Reads again, when either changed, which sandbox the container is and
        which of its files to keep facts of."""
        mapping = CONTAINERS / (box.container + '.json')
        try:
            mapped = mapping.stat().st_mtime_ns
        except OSError:
            mapped = None
        if mapped != box.mapped:
            box.mapped = mapped
            try:
                found = json.loads(mapping.read_text()) if mapped else {}
            except (OSError, ValueError):
                found = {}
            sid = found.get('id') if SANDBOX_ID.fullmatch(str(found.get('id') or '')) else None
            workspace = found.get('workspace') if sid and os.path.isdir(str(found.get('workspace') or '')) else None
            fresh = workspace != box.workspace
            box.sid, box.workspace, box.home, box.ip = sid, workspace, found.get('home') or None, found.get('ip') or None
            box.fork = bool(found.get('fork_of'))
            if fresh:
                box.guarded_at, box.known, box.packages = None, None, None
                if workspace:
                    box.known = set()
                    for folder, folders, files in os.walk(workspace):
                        folders[:] = [name for name in folders if name not in SKIPPED]
                        inside = os.path.relpath(folder, workspace)
                        box.known.update(name if inside == '.' else inside + '/' + name for name in files)
                        if len(box.known) > 200_000:
                            break
                    box.packages = installed(workspace, box.home)
        if not box.workspace:
            return
        lists = GUARDRAILS / (box.sid + '.json')
        try:
            at = lists.stat().st_mtime_ns
        except OSError:
            at = 0
        if at != box.guarded_at:
            box.guarded_at = at
            try:
                kept = json.loads(lists.read_text()) if at else {}
            except (OSError, ValueError):
                kept = {}
            box.restricted = {path for path in kept.get('restricted') or [] if isinstance(path, str)}
            box.watched = {path for path in kept.get('watched') or [] if isinstance(path, str)}
            self.guard(box)
        self.arm(box)

    def guard(self, box):
        """The files to keep facts of, each with a first photo to compare later ones with."""
        guarded = {path: 'sensitive' for path in box.sensitive}
        guarded.update({path: 'watched' for path in box.watched})
        guarded.update({path: 'restricted' for path in box.restricted})
        box.hashing = len(guarded) <= HASH_LIMIT
        for path in guarded:
            if path not in box.photos:
                box.photos[path] = photo(box.workspace, path, box.hashing)
        for path in [path for path in box.photos if path not in guarded]:
            del box.photos[path]
        box.guarded = guarded

    def arm(self, box):
        """Watches the folder of every file to keep facts of; one that is not
        there yet is tried again on the next pass."""
        if not self.inotify:
            return
        wanted = {posixpath.dirname(path) for path in box.guarded}
        for folder in [folder for folder in box.watches if folder not in wanted]:
            self.unwatch(box, folder)
        for folder in wanted - box.watches.keys():
            try:
                watch = self.inotify.add(box.workspace, folder)
            except (OSError, ValueError):
                continue
            box.watches[folder] = watch
            self.watched[watch] = (box, folder)

    def unwatch(self, box, folder):
        watch = box.watches.pop(folder, None)
        if watch is not None and self.watched.pop(watch, None):
            self.inotify.remove(watch)

    def close(self, box):
        """A sandbox's stream ended: settle what was pending and let it go."""
        for path in set(box.due) | set(box.final):
            self.look(box, path, final=True)
        self.summaries(box, self.clock(), closing=True)
        for folder in list(box.watches):
            self.unwatch(box, folder)

    # ------------------------------------------------------------ processes

    def executed(self, box, event):
        pid, argv = event.get('pid'), [str(part) for part in event.get('argv') or []]
        known = box.processes.get(pid) or {}
        parent = box.processes.get(event.get('ppid')) or {}
        # The call id travels in the environment, and for the shell that runs a
        # command in its own text (claude-hook.mjs): the forwarder reads both the same way.
        marker = (event.get('markers') or {}).get('RAYTRACE_CALL_ID') or (CALL_MARKER.search(' '.join(argv)) or [None, None])[1]
        box.processes[pid] = {'start_ns': event.get('process_start_ns'), 'ppid': event.get('ppid'),
                              'name': posixpath.basename(event.get('executable') or (argv[0] if argv else '')) or event.get('process_name'),
                              'argv': [part[:400] for part in argv[:24]],
                              'call_id': marker or known.get('call_id') or parent.get('call_id')}
        if len(box.processes) > 20_000:   # exits that never arrived: forget the oldest half
            for stale in list(box.processes)[:10_000]:
                del box.processes[stale]

    def exited(self, box, event):
        gone = box.processes.pop(event.get('pid'), None)
        if gone and box.workspace and PACKAGE_TOOLS & {posixpath.basename(part) for part in gone['argv'][:4]}:
            # A package manager finished: see what it left, once it has settled.
            box.package_due = self.clock() + 1
            box.package_who = self.who(box, event, gone)

    def who(self, box, event, known=None):
        """The process an event is from, and the tool call it belongs to."""
        pid = event.get('pid')
        known = known or box.processes.get(pid) or {}
        if known.get('start_ns') and event.get('process_start_ns') and known['start_ns'] != event['process_start_ns']:
            known = {}   # the pid was used again
        parent = box.processes.get(event.get('ppid')) or {}
        return {'pid': pid, 'start_ns': known.get('start_ns') or event.get('process_start_ns'),
                'name': known.get('name') or event.get('process_name') or None, 'argv': known.get('argv') or [],
                'call_id': known.get('call_id') or parent.get('call_id')}

    # ------------------------------------------------------------ facts

    def fact(self, box, kind, key, who, body, at_ns):
        """The fact these say, begun or added to: one fact for the same thing
        done by the same step, with a count, not one for each time."""
        step = who.get('call_id') or (f"{who.get('pid')}:{who.get('start_ns')}" if who.get('pid') else '')
        fact_id = hashlib.sha256('\0'.join([box.container, kind, step, *map(str, key)]).encode()).hexdigest()[:32]
        fact = self.facts.get(fact_id)
        if fact is None:
            fact = self.facts[fact_id] = {
                'fact_id': fact_id, 'container_id': box.container, 'kind': kind, 'count': 0, 'first_ns': str(at_ns),
                'pid': who.get('pid'), 'process_start_ns': who.get('start_ns'), 'process': who.get('name'),
                'command': ' '.join(who.get('argv') or [])[:160] or None, 'call_id': who.get('call_id'), **body}
            if box.fork:
                fact['fork'] = True
        fact['count'] += 1
        fact['last_ns'] = str(at_ns)
        now = self.clock()
        if now - box.gap_at < 60 or now - self.overflowed < 60:
            fact['coverage'] = 'gaps'   # events were lost about now: this may not be all of it
        fact['touched'] = now
        self.dirty[fact_id] = True
        return fact

    def flush(self):
        if self.dirty:
            now = int(time.time() * 1000)
            rows = []
            for fact_id in self.dirty:
                fact = {key: value for key, value in self.facts[fact_id].items() if key != 'touched'}
                rows.append((fact_id, fact['container_id'], fact['kind'], fact['last_ns'], now, json.dumps(fact)))
            # Replaced, not updated: a fact that grew gets a new row id, so
            # whoever reads by "newer than" sees it again.
            self.db.executemany('INSERT OR REPLACE INTO facts (fact_id, container_id, kind, at_ns, received_ms, body) VALUES (?,?,?,?,?,?)', rows)
            self.db.commit()
            self.dirty.clear()
        idle = self.clock() - 600
        for fact_id in [fact_id for fact_id, fact in self.facts.items() if fact['touched'] < idle]:
            del self.facts[fact_id]

    def sweep(self):
        """Retention on this host: facts are kept two weeks, and no sandbox keeps more than its newest 50,000."""
        self.db.execute('DELETE FROM facts WHERE received_ms < ?', (int(time.time() * 1000) - RETAIN_DAYS * 86_400_000,))
        for (container,) in self.db.execute('SELECT container_id FROM facts GROUP BY container_id HAVING count(*) > ?', (RETAIN_ROWS,)).fetchall():
            self.db.execute('DELETE FROM facts WHERE container_id = ? AND id NOT IN (SELECT id FROM facts WHERE container_id = ? ORDER BY id DESC LIMIT ?)',
                            (container, container, RETAIN_ROWS))
        self.db.execute('DELETE FROM dns_cache WHERE seen_ns < ?', (time.time_ns() - 86_400_000_000_000,))
        self.db.commit()

    def counted(self, box, who, top, at_ns):
        """An open that is nobody's business: counted for its step, and gone."""
        step = who.get('call_id') or f"{who.get('pid')}:{who.get('start_ns')}"
        count = box.counts.get(step)
        if count is None:
            count = box.counts[step] = {'who': who, 'opens': 0, 'tops': {}, 'first_ns': at_ns, 'written': 0}
        count['opens'] += 1
        count['tops'][top] = count['tops'].get(top, 0) + 1
        count['last_ns'], count['touched'] = at_ns, self.clock()

    def summaries(self, box, now, closing=False):
        """One line for a step that opened files in bulk: how many, and where."""
        for step, count in list(box.counts.items()):
            idle = now - count['touched']
            if count['opens'] >= BULK and count['opens'] != count['written'] and (closing or idle > 3 or now - count.get('wrote_at', 0) > 15):
                # A tool call's count is of all its processes: it names the call, not whichever opened first.
                who = {'call_id': count['who']['call_id']} if count['who'].get('call_id') else count['who']
                fact = self.fact(box, 'summary', ('opens',), who, {'effect': 'opened'}, count['last_ns'])
                fact.update(count=1, first_ns=str(count['first_ns']), opens=count['opens'],
                            folders=dict(sorted(count['tops'].items(), key=lambda item: -item[1])[:5]))
                count['written'], count['wrote_at'] = count['opens'], now
            if closing or idle > 120:
                del box.counts[step]

    # ------------------------------------------------------------ files

    def opened(self, box, event):
        at_ns = int(event.get('timestamp_ns') or 0) or time.time_ns()
        who = self.who(box, event)
        path = project_path(event)
        if path is None or not box.workspace:
            return self.counted(box, who, '(outside the project)', at_ns)
        flags, errno = event.get('flags', 0), event.get('errno', 0)
        writing = (flags & O_ACCMODE) != 0 or bool(flags & (O_CREAT | O_TRUNC))
        guard = box.guarded.get(path)
        top = path.split('/', 1)[0] if '/' in path else '(project root)'
        if guard is None:
            # A file that was not there and now is: worth a fact when its path alone marks it (a .env, a key).
            if flags & O_CREAT and not errno and box.known is not None and path not in box.known and not SKIPPED.intersection(path.split('/')):
                box.known.add(path)
                if file_scan.created_entry(path)['level'] >= SENSITIVE_FROM:
                    box.sensitive.add(path)
                    box.photos[path] = None
                    self.guard(box)
                    self.arm(box)
                    guard = 'sensitive'
            if guard is None:
                return self.counted(box, who, top, at_ns)
        call = self.calls.get(event.get('sysno'), ('open', 'open'))[0]
        basis = {'syscall': call, 'flags': flags, 'resolution': 'lexical'}
        if errno:
            if errno in REFUSED:
                self.fact(box, 'file', (path, 'attempted', 'write' if writing else 'read'), who,
                          {'path': path, 'guard': guard, 'effect': 'attempted', 'certainty': 'attempted', 'intent': 'write' if writing else 'read',
                           'basis': {**basis, 'errno': REFUSED[errno]}}, at_ns)
            return
        if not writing:
            self.fact(box, 'file', (path, 'read'), who, {'path': path, 'guard': guard, 'effect': 'read', 'certainty': 'confirmed',
                      'basis': {**basis, 'note': 'opened for reading; the bytes read are not captured'}}, at_ns)
            return
        now = self.clock()
        box.writers.setdefault(path, []).append({'who': who, 'at_ns': at_ns, 'flags': flags, 'syscall': call, 'credited': False, 'seen': now})
        box.due[path] = min(box.due.get(path, now + 1), now + 1)
        box.final[path] = now + 30

    def numbered_call(self, box, event):
        """A delete, rename, resize, mkdir or mode change: gVisor gives its
        number and result, not its path. Kept a moment, for the watcher to say
        which file; a refusal is a fact at once."""
        name, rule = self.calls.get(event.get('sysno'), (None, None))
        if not name:
            return
        at_ns = int(event.get('timestamp_ns') or 0) or time.time_ns()
        who, errno = self.who(box, event), event.get('errno', 0)
        box.raw.append({'rule': rule, 'syscall': name, 'errno': errno, 'at_ns': at_ns, 'who': who})
        if errno not in REFUSED or rule == 'mkdir':
            return
        # The process's own arguments, as gVisor reported them at exec, may name
        # the file: `rm notes.txt`. Text that only contains the name is weaker.
        named = self.named(box, who, event.get('cwd'))
        basis = {'syscall': name, 'errno': REFUSED[errno], 'note': 'gVisor does not report the path of this call'}
        for path, how in named or [(None, None)]:
            self.fact(box, 'file', (path or '', 'attempted', name), who,
                      {'path': path, 'guard': box.guarded.get(path) if path else None, 'effect': 'attempted', 'certainty': 'attempted',
                       'intent': {'remove': 'delete', 'rename': 'rename', 'resize': 'write', 'metadata': 'permissions'}[rule],
                       'basis': {**basis, **({'path_from': how} if how else {})}}, at_ns)

    def named(self, box, who, cwd):
        """Restricted or watched files a process's arguments name: [(path, how)]."""
        found = {}
        for part in who.get('argv') or []:
            if not part or part.startswith('-'):
                continue
            name = posixpath.normpath(part if part.startswith('/') else (cwd or WORKSPACE) + '/' + part)
            if name + '/' != WORKSPACE and not name.startswith(WORKSPACE):
                continue
            at = name[len(WORKSPACE):]   # empty for the project folder itself: `rm -r .` names everything
            if at in box.guarded:
                found[at] = 'argv'
            for path in box.guarded:   # `rm -r src` reaches every file under src
                if not at or path.startswith(at + '/'):
                    found.setdefault(path, 'argv_folder')
        if not found:
            text = ' '.join(who.get('argv') or [])
            found = {path: 'argv_text' for path in box.guarded if path in text}
        return sorted(found.items())[:5]

    def actors(self, box, rule, at_ns, path):
        """The processes whose delete, rename, resize or mode call succeeded
        about when the watcher saw `path` change, likeliest first."""
        found = {}
        for call in box.raw:
            if call['rule'] == rule and not call['errno'] and at_ns - RAW_WINDOW[0] <= call['at_ns'] <= at_ns + RAW_WINDOW[1]:
                found.setdefault((call['who']['pid'], call['who']['start_ns']), call)
        names = lambda call: any(posixpath.basename(path) == posixpath.basename(part) for part in call['who']['argv'])
        ranked = sorted(found.values(), key=lambda call: (not names(call), abs(call['at_ns'] - at_ns)))
        own = [call for call in ranked if names(call)]
        return [(call['who'], call['syscall']) for call in (own if len(own) == 1 else ranked)[:5]]

    def watcher_events(self):
        if not self.inotify:
            return 0
        events = self.inotify.read()
        moved = {cookie: posixpath.join(self.watched[watch][1], name) for watch, mask, cookie, name in events
                 if mask & Inotify.MOVED_TO and watch in self.watched}
        for watch, mask, cookie, name in events:
            if mask & Inotify.OVERFLOW:   # the kernel dropped notices: look at everything again
                for box in self.boxes.values():
                    box.gap_at = self.clock()
                    for path in box.guarded:
                        self.noticed(box, path, [])
                continue
            target = self.watched.get(watch)
            if not target:
                continue
            box, folder = target
            if mask & (Inotify.IGNORED | Inotify.DELETE_SELF | Inotify.MOVE_SELF):
                # The folder itself went: its files went with it, and nothing named them.
                if mask & Inotify.IGNORED:
                    box.watches.pop(folder, None)
                    self.watched.pop(watch, None)
                for path in box.guarded:
                    if posixpath.dirname(path) == folder:
                        self.noticed(box, path, [])
                continue
            path = posixpath.join(folder, name)
            if path in box.guarded:
                self.noticed(box, path, [word for bit, word in Inotify.WORDS if mask & bit],
                             moved.get(cookie) if mask & Inotify.MOVED_FROM else None)
        return len(events)

    def noticed(self, box, path, words, moved_to=None):
        """The watcher saw something of a file: look at it once things settle."""
        cause = box.causes.setdefault(path, {'events': set(), 'at_ns': time.time_ns()})
        cause['events'].update(words)
        if moved_to:
            cause['to'] = moved_to
        now = self.clock()
        box.due[path] = min(box.due.get(path, now + SETTLE), now + SETTLE)

    def look(self, box, path, final=False):
        """Compares a file with its last photo and says what happened to it, and who did it."""
        guard = box.guarded.get(path)
        if guard is None or not box.workspace:
            box.writers.pop(path, None)
            return
        cause = box.causes.pop(path, None) or {'events': set(), 'at_ns': time.time_ns()}
        now = self.clock()
        writers = box.writers[path] = [writer for writer in box.writers.get(path, []) if now - writer['seen'] < WRITER_LIFE]
        before = box.photos.get(path)
        after = photo(box.workspace, path, box.hashing)
        flags = 0
        for writer in writers:
            flags |= writer['flags']
        effect = change(before, after, cause['events'], flags)
        if effect:
            box.photos[path] = after
            if after is None and box.known is not None:
                box.known.discard(path)
            if effect in ('deleted', 'renamed'):
                found = self.actors(box, 'remove' if effect == 'deleted' else 'rename', cause['at_ns'], path)
            elif effect == 'permissions_changed':
                found = self.actors(box, 'metadata', cause['at_ns'], path)
            else:
                found, seen = [], set()
                for writer in reversed(writers):   # the latest to open it first
                    key = (writer['who']['pid'], writer['who']['start_ns'])
                    if key not in seen:
                        seen.add(key)
                        found.append((writer['who'], writer['syscall']))
                    writer['credited'] = True
                if 'moved_to' in cause['events']:   # written elsewhere and moved over it, as editors and `sed -i` do
                    found += self.actors(box, 'rename', cause['at_ns'], path)
                if not found:
                    found = self.actors(box, 'resize', cause['at_ns'], path)
            who, call = found[0] if found else ({}, None)
            certainty = 'unattributed' if not found else 'confirmed' if len(found) == 1 else 'one_of'
            basis = {'syscall': call, 'watcher': sorted(cause['events']), 'before': before, 'after': after, 'resolution': 'lexical'}
            if len(found) > 1:
                basis['candidates'] = [{'pid': other['pid'], 'process': other['name']} for other, _ in found[:5]]
            fact = self.fact(box, 'file', (path, effect, certainty), who,
                             {'path': path, 'guard': guard, 'effect': effect, 'certainty': certainty, 'basis': basis}, cause['at_ns'])
            fact['basis']['after'] = after
            if cause.get('to'):
                fact['to'] = cause['to']
        elif final:
            for writer in writers:
                if not writer['credited']:
                    writer['credited'] = True
                    self.fact(box, 'file', (path, 'opened_for_writing'), writer['who'],
                              {'path': path, 'guard': guard, 'effect': 'opened_for_writing', 'certainty': 'possible',
                               'basis': {'syscall': writer['syscall'], 'flags': writer['flags'], 'before': before, 'after': after,
                                         'resolution': 'lexical', 'note': 'opened for writing; the file is as it was'}}, writer['at_ns'])
        if not writers:
            box.writers.pop(path, None)

    # ------------------------------------------------------------ network, identity, packages

    def host_name(self, box, ip):
        """The name last looked up, from this sandbox, that answered with this
        address (dns_forwarder.py). A best match: an address can serve many names."""
        kept = box.names.get(ip)
        now = self.clock()
        if kept and now - kept[1] < 30:
            return kept[0]
        try:
            row = self.db.execute('SELECT name FROM dns_cache WHERE client = ? AND ip = ?', (box.ip or '', ip)).fetchone()
        except sqlite3.Error:
            row = None
        box.names[ip] = (row[0] if row else None, now)
        if len(box.names) > 5000:
            box.names.clear()
        return row[0] if row else None

    def connected(self, box, event):
        if event.get('family') != 'inet':
            return   # a socket file inside the sandbox, or a family that leaves no machine
        ip, port, errno = event['ip'], event['port'], event.get('errno', 0)
        there = ipaddress.ip_address(ip)
        at_ns = int(event.get('timestamp_ns') or 0) or time.time_ns()
        listening = event['kind'] == 'listen'
        if not listening and (there.is_loopback or there.is_unspecified):
            return   # the sandbox talking to itself
        if not listening and port == 0:
            # No traffic: the resolver library "connects" a datagram socket to each
            # address a name answered with, port 0, to choose which to use.
            return
        now = self.clock()
        if now - self.bridge[1] > 30:
            try:
                self.bridge = (BRIDGE.read_text().strip().removeprefix('http://'), now)
            except OSError:
                self.bridge = ('', now)
        if f'{ip}:{port}' in (self.bridge[0], f'{network.GATEWAY}:53'):
            return   # RayTrace's own: the model and transcript bridge, and the resolver (dns_forwarder.py records lookups)
        who = self.who(box, event)
        if listening:
            outcome = 'failed' if errno else 'listening'
        elif there.version == 4 and any(there in block for block in REJECTED):
            outcome = 'refused_by_policy'   # the firewall rejects it, whatever a non-blocking call returned
        else:
            outcome = 'connected' if not errno else 'attempted' if errno == EINPROGRESS else 'failed'
        name = None if listening else self.host_name(box, ip)
        # One fact for a site, not one for each address its name answers with:
        # a registry has a dozen, and a program tries IPv6 before IPv4.
        fact = self.fact(box, 'network', (name or ip, port, event['kind']), who,
                         {'ip': ip, 'port': port, 'host': name, 'addresses': [], 'effect': event['kind'], 'outcomes': {},
                          'basis': {'syscall': event['kind'], 'note': 'the address is what the program asked for; the name is the lookup that answered with it'}}, at_ns)
        fact['outcomes'][outcome] = fact['outcomes'].get(outcome, 0) + 1
        if ip not in fact['addresses'] and len(fact['addresses']) < 32:
            fact['addresses'].append(ip)
        if outcome == 'connected':
            fact['ip'] = ip   # shown first: an address that answered
        if errno and outcome == 'failed':
            fact['errno'] = ERRNO.get(errno, str(errno))
        if name in REGISTRIES:
            box.registry_at = self.clock()

    def identity(self, box, event):
        errno = event.get('errno', 0)
        call = self.calls.get(event.get('sysno'), ('setid', None))[0]
        at_ns = int(event.get('timestamp_ns') or 0) or time.time_ns()
        self.fact(box, 'identity', (call, *event.get('ids', []), bool(errno)), self.who(box, event),
                  {'effect': 'attempted' if errno else 'changed', 'certainty': 'attempted' if errno else 'confirmed',
                   'ids': event.get('ids', []), 'basis': {'syscall': call, **({'errno': ERRNO.get(errno, str(errno))} if errno else {})}}, at_ns)

    def packages(self, box):
        """What a package manager left that was not there before."""
        if not box.workspace:
            return
        now = installed(box.workspace, box.home)
        before, box.packages = box.packages or {}, now
        fresh = sorted(key for key in now if key not in before)
        if not fresh:
            return
        who = box.package_who or {}
        # Seen reaching a registry about then: the list is the manager's own word, with that beside it.
        certainty = 'corroborated' if self.clock() - box.registry_at < 300 else 'reported'
        for manager in sorted({key[0] for key in fresh}):
            mine = [key for key in fresh if key[0] == manager]
            fact = self.fact(box, 'package', (manager,), who, {'manager': manager, 'packages': [], 'total': 0, 'effect': 'installed',
                             'basis': {'note': "read from the package manager's own records in the sandbox after it ran; the agent can write those files"}},
                             time.time_ns())
            fact['certainty'] = certainty
            fact['total'] += len(mine)
            room = MAX_PACKAGES - len(fact['packages'])
            fact['packages'] += [{'name': name, 'version': version, **({'source': now[(manager, name, version)]} if now[(manager, name, version)] else {})}
                                 for _, name, version in mine[:max(0, room)]]
