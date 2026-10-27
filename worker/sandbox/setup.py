"""Run with sudo INSIDE the dedicated Lima VM, never on the Mac.

Which calls gVisor reports is not written here: trace_config() reads it from
the catalog (syscall_catalog.sql, the `capture` column), so what a host
subscribes to is what the catalog says, for the architecture it runs on.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import sqlite3
import subprocess
import urllib.request

# The runsc release installed. The catalog's numbers and coverage are generated
# for one release (catalog_numbers.py): change both together.
RELEASE = '20260817.0'
CONTEXT = ['time', 'thread_id', 'group_id', 'thread_group_start_time',
           'container_id', 'cwd', 'process_name', 'parent_thread_group_id']


def run(*args):
    subprocess.run(args, check=True)


def trace_config(arch, catalog_sql, endpoint, calls=True):
    """gVisor's trace session for this host: its own process points (clone,
    exec, exit), which are fixed, and with `calls` the file, network and
    identity calls the catalog captures. A captured call with a typed point
    is subscribed on that point's exit, with the optional fields its row asks
    for; one gVisor reports by number only (`watcher` rows: delete, rename...)
    on its raw exit point, for who made it, when, and whether it was refused."""
    catalog = sqlite3.connect(':memory:')
    try:
        catalog.executescript(catalog_sql)
        if not catalog.execute('SELECT count(*) FROM syscall_coverage WHERE gvisor_release = ?', (RELEASE,)).fetchone()[0]:
            raise SystemExit(f'The catalog has no coverage for gVisor {RELEASE}: run catalog_numbers.py for this release.')
        number = dict(catalog.execute('SELECT syscall_name, sysno FROM syscall_numbers WHERE arch = ?', (arch,)).fetchall())
        captured = catalog.execute(
            """SELECT c.syscall_name, c.capture, c.capture_fields, c.group_id, v.point, v.optional_fields
               FROM syscall_catalog AS c JOIN syscall_numbers AS n ON n.syscall_name = c.syscall_name AND n.arch = ?
               LEFT JOIN syscall_coverage AS v ON v.syscall_name = c.syscall_name AND v.gvisor_release = ?
               WHERE c.capture IN ('yes', 'watcher') ORDER BY n.sysno""", (arch, RELEASE)).fetchall() if calls else []
    finally:
        catalog.close()
    points = ['sentry/clone', 'sentry/execve', 'sentry/exit_notify_parent',
              'sentry/task_exit', 'syscall/execve/enter', 'syscall/execve/exit',
              'syscall/execveat/enter', 'syscall/execveat/exit']
    points += [f'syscall/sysno/{number[name]}/exit' for name in ('execve', 'execveat')]
    # `envv` is an optional field on the execve points. It is requested ONLY so
    # the collector can read the two RAYTRACE_* markers back off a process and
    # turn correlation from a text guess into an exact join; collector.py drops
    # every other variable (and the raw packet) before anything is written. A
    # real environment block carries every secret a process was started with,
    # so this must never be widened to other points or stored verbatim.
    marker_points = {'syscall/execve/enter', 'syscall/execveat/enter'}
    def point_config(point):
        entry = {'name': point, 'context_fields': [f for f in CONTEXT if not
                 (point == 'sentry/exit_notify_parent' and f == 'cwd')]}
        if point in marker_points:
            entry['optional_fields'] = ['envv']
        return entry
    configured = [point_config(point) for point in points]
    for name, capture, wanted, group, point, offered in captured:
        if capture == 'yes' and not point:
            raise SystemExit(f'The catalog captures {name}, but gVisor {RELEASE} has no typed trace point for it.')
        # A file call needs the working directory, to read a relative path; a
        # connection does not, and gVisor works it out for every event asked.
        entry = {'name': f'{point}/exit' if capture == 'yes' else f'syscall/sysno/{number[name]}/exit',
                 'context_fields': [f for f in CONTEXT if group == 'files' or f != 'cwd']}
        fields = [field for field in json.loads(wanted) if field in json.loads(offered or '[]')] if capture == 'yes' else []
        if fields:
            entry['optional_fields'] = fields
        configured.append(entry)
    # gVisor never waits long for the collector: when its socket is full it
    # tries again a few times, each wait twice the last (25 microseconds at
    # first), then drops the event and counts it. Three tries were under a
    # fifth of a millisecond, and a burst of opens (an `npm uninstall`) lost
    # events on a busy host. Eight is about six milliseconds at the very most,
    # paid only while the collector is behind.
    return {'trace_session': {'name': 'Default', 'points': configured,
        'sinks': [{'name': 'remote', 'ignore_setup_error': False,
                   'config': {'endpoint': endpoint, 'retries': 8}}]}}


if __name__ == '__main__':
    if platform.system() != 'Linux' or os.geteuid() != 0:
        raise SystemExit('Run this setup with sudo inside the RayTrace Linux VM.')
    arch = {'aarch64': 'aarch64', 'x86_64': 'x86_64'}[platform.machine()]
    base = f'https://storage.googleapis.com/gvisor/releases/release/{RELEASE}/{arch}/'
    binary = urllib.request.urlopen(base + 'runsc', timeout=120).read()
    checksum = urllib.request.urlopen(base + 'runsc.sha512', timeout=30).read().decode().split()[0]
    if hashlib.sha512(binary).hexdigest() != checksum:
        raise SystemExit('runsc checksum mismatch')
    # Written beside it and moved over: a host with sandboxes running is
    # running this file, and Linux refuses to write to a program in use.
    staged = Path('/usr/local/bin/runsc.new')
    staged.write_bytes(binary)
    staged.chmod(0o755)
    staged.replace('/usr/local/bin/runsc')
    for directory in ['/opt/raytace', '/etc/raytace', '/var/lib/raytace', '/run/raytace']:
        Path(directory).mkdir(exist_ok=True, mode=0o700)
    source = Path(__file__).parent
    # The collector's own modules: the fact engine, the catalog it and this
    # setup read, the path rules it shares with the initial scan, the resolver.
    for name in ['collector.py', 'viewer.py', 'network.py', 'projects.py',
                 'engine.py', 'dns_forwarder.py', 'file_scan.py', 'syscall_catalog.sql']:
        shutil.copyfile(source / name, Path('/opt/raytace') / name)
    config = trace_config(arch, (source / 'syscall_catalog.sql').read_text(), '/run/raytace/events.sock')
    Path('/etc/raytace/gvisor.json').write_text(json.dumps(config, indent=2))
    # The engine watches the folder of every file an owner restricted or watches.
    # And room for events on their way to the collector, so a burst waits in
    # the kernel and is not dropped: how many may queue on its socket, and how
    # many bytes a sandbox may have in flight. Both are read when a socket is
    # made, so they are set before the collector and any sandbox start.
    Path('/etc/sysctl.d/60-raytace.conf').write_text(
        'fs.inotify.max_user_watches = 1048576\nfs.inotify.max_user_instances = 1024\n'
        'net.unix.max_dgram_qlen = 8192\nnet.core.wmem_default = 8388608\nnet.core.wmem_max = 8388608\n')
    run('sysctl', '-q', '-p', '/etc/sysctl.d/60-raytace.conf')
    run('/usr/local/bin/runsc', 'install', '--runtime=raytace-gvisor', '--',
        '--pod-init-config=/etc/raytace/gvisor.json')
    for name, command in [('collector', 'collector.py --socket /run/raytace/events.sock --database /var/lib/raytace/runtime.db'),
                          ('viewer', 'viewer.py'), ('dns', 'dns_forwarder.py')]:
        # The resolver is what sandboxes resolve names with: it comes back whatever ended it.
        unit = f'''[Unit]
Description=RayTrace {name}
After=network.target{' docker.service' if name == 'dns' else ''}
[Service]
ExecStart=/usr/bin/python3 /opt/raytace/{command}
Restart={'always' if name == 'dns' else 'on-failure'}
RestartSec=2
UMask=0077
RuntimeDirectory=raytace
RuntimeDirectoryPreserve=yes
[Install]
WantedBy=multi-user.target
'''
        if name == 'collector':
            unit = unit.replace('ExecStart=', 'ExecStartPre=/usr/bin/rm -f /run/raytace/events.sock\nExecStart=')
        Path(f'/etc/systemd/system/raytace-{name}.service').write_text(unit)
    # Ubuntu's automatic updates restart services whose libraries changed. A
    # collector restart silently ends every running sandbox's evidence stream
    # (gVisor does not reconnect), so it is never restarted that way; projects.py
    # restarts sandboxes that predate the collector instead.
    if Path('/etc/needrestart/conf.d').is_dir():
        Path('/etc/needrestart/conf.d/raytace.conf').write_text(
            "$nrconf{override_rc}{qr(^raytace-)} = 0;\n")
    run('systemctl', 'daemon-reload')
    run('systemctl', 'restart', 'docker')
    run('systemctl', 'enable', '--now', 'raytace-collector', 'raytace-viewer')
    run('systemctl', 'restart', 'raytace-collector', 'raytace-viewer')
    run('python3', '/opt/raytace/network.py')
    # After the sandbox network exists: the resolver listens on its gateway.
    run('systemctl', 'enable', 'raytace-dns')
    run('systemctl', 'restart', 'raytace-dns')
    run('docker', 'build', '-t', 'raytace-gvisor-agent', '-f', str(source / 'Dockerfile'), str(source))
    print('Ready.')
