"""External gVisor SecCheck v1 collector. Python stdlib only; never mount into guests.

Wire/schema references: google/gvisor pkg/sentry/seccheck/{points,sinks/remote}.
Only selected fields are decoded; unknown event payloads are retained as base64.
The bounded protobuf reader handles wire types, not arbitrary recursive schemas.

Two kinds of event leave here. Process events (exec, clone, exit) are written
to runtime_events as they always were, now a batch at a time. File and network
calls are far too many to keep: each goes to the engine (engine.py), which
keeps what matters of it as a fact and counts the rest, and is never written.
"""
import argparse
import base64
import ipaddress
import json
import os
import queue
import socket
import sqlite3
import struct
import threading
import time
import uuid

try:
    import engine as facts_engine
except Exception as problem:  # a host without the engine still records processes
    facts_engine = None
    print(f'RayTrace collector: no fact engine ({problem}); recording processes only', flush=True)

MAX_PACKET = 1024 * 1024

# The ONLY environment variables ever read off a traced process. `envv` is
# requested on the execve points (see setup.py) purely to carry these two
# markers, which turn tool-call correlation from a text-similarity guess into
# an exact join. Everything else in the environment block -- API keys, tokens,
# database passwords -- is dropped here, before any write, and the raw packet
# is withheld for events that carried one (see decode). Never widen this list.
MARKER_KEYS = ('RAYTRACE_CALL_ID', 'RAYTRACE_SESSION')


def markers(entries):
    """Pick the allowlisted markers out of a raw `envv` list. Returns {} when
    none are present, and never retains a variable outside MARKER_KEYS."""
    found = {}
    for entry in entries:
        name, separator, value = string(entry).partition('=')
        if separator and name in MARKER_KEYS and len(value) <= 256:
            found[name] = value
    return found


def fields(data):
    result = {}
    pos = 0

    def varint():
        nonlocal pos
        value = 0
        for shift in range(0, 70, 7):
            if pos >= len(data):
                raise ValueError('truncated varint')
            byte = data[pos]
            pos += 1
            if shift == 63 and byte > 1:
                raise ValueError('varint overflow')
            value |= (byte & 127) << shift
            if byte < 128:
                return value
        raise ValueError('invalid varint')

    while pos < len(data):
        tag = varint()
        number, wire = tag >> 3, tag & 7
        if not number:
            raise ValueError('invalid field zero')
        if wire == 0:
            value = varint()
        elif wire in (1, 2, 5):
            size = varint() if wire == 2 else (8 if wire == 1 else 4)
            if pos + size > len(data):
                raise ValueError('truncated field')
            value = data[pos:pos + size]
            pos += size
        else:
            raise ValueError('unsupported wire type')
        result.setdefault(number, []).append(value)
    return result


def one(data, key, default=0):
    return data.get(key, [default])[-1]


def string(value):
    if not isinstance(value, bytes):
        raise ValueError('expected string field')
    return value.decode('utf-8', errors='replace')


def signed(value):
    return value - (1 << 64) if value >= (1 << 63) else value


def result_of(data):
    """A syscall's result on its exit point; nothing on an enter point. gVisor
    reports a failure in `errno` and leaves the result zero, so errno alone
    says whether a call succeeded."""
    if 2 not in data:
        return {}
    status = fields(one(data, 2, b''))
    return {'result': signed(one(status, 1)), 'errno': abs(signed(one(status, 2)))}


def address(raw):
    """A socket address as the program passed it (Linux's struct sockaddr): an
    IP address and port, never a host name."""
    family = struct.unpack_from('<H', raw)[0] if len(raw) >= 2 else None
    if family == 2 and len(raw) >= 8:
        return {'family': 'inet', 'ip': str(ipaddress.IPv4Address(raw[4:8])), 'port': struct.unpack_from('>H', raw, 2)[0]}
    if family == 10 and len(raw) >= 24:
        found = ipaddress.IPv6Address(raw[8:24])
        return {'family': 'inet', 'ip': str(found.ipv4_mapped or found), 'port': struct.unpack_from('>H', raw, 2)[0]}
    if family == 1:
        return {'family': 'unix', 'path': raw[2:].split(b'\0')[0].decode('utf-8', errors='replace')[:200]}
    return {'family': 'other' if family is not None else 'unknown'}


def decode(packet):
    if len(packet) < 8 or len(packet) > MAX_PACKET:
        raise ValueError('invalid packet size')
    size, kind, dropped = struct.unpack_from('<HHI', packet)
    if size < 8 or size > len(packet):
        raise ValueError('invalid header size')
    data = fields(packet[size:])
    context = fields(one(data, 1, b''))
    carried_env = False
    event = {
        'source': 'gvisor_seccheck', 'message_type': kind,
        'dropped_count': dropped, 'timestamp_ns': str(one(context, 1)),
        'container_id': string(one(context, 6, b'')),
        'pid': one(context, 4), 'tid': one(context, 2),
        'process_start_ns': str(one(context, 5)),
        'ppid': one(context, 10), 'cwd': string(one(context, 8, b'')),
        'process_name': string(one(context, 9, b'')),
        'kind': 'runtime_event',
    }
    if kind == 3:
        event.update(kind='exec_succeeded', executable=string(one(data, 2, b'')),
                     argv=[string(v) for v in data.get(3, [])])
        # Field 4 is `envv` on sentry/execve. Unlike the syscall points this is
        # NOT opt-in -- the Sentry has always sent it, so every raw packet kept
        # here carried the process's entire environment (keys, tokens,
        # passwords) into the database. Same treatment as the syscall points:
        # keep the allowlisted markers, withhold the raw bytes.
        if 4 in data:
            carried_env = True
            found = markers(data[4])
            if found:
                event['markers'] = found
    elif kind == 11:
        event.update(kind='exec_attempt', executable=string(one(data, 6, b'')),
                     argv=[string(v) for v in data.get(7, [])])
        # Field 8 is `envv`, requested only for the markers (see MARKER_KEYS).
        # `carried_env` records that an environment block was present so the
        # raw packet can be withheld below -- the markers themselves are safe
        # to keep, the block they arrived in is not.
        if 8 in data:
            carried_env = True
            found = markers(data[8])
            if found:
                event['markers'] = found
        if 2 in data:
            status = fields(one(data, 2))
            errno = one(status, 2)
            event.update(kind='exec_failed' if errno else 'exec_syscall_return',
                         errno=errno, result=signed(one(status, 1)))
    elif kind == 2:
        event.update(kind='clone', child_pid=one(data, 4), child_tid=one(data, 3),
                     child_start_ns=str(one(data, 5)))
    elif kind in (4, 5):
        status = one(data, 2)
        event.update(kind='process_exit' if kind == 4 else 'thread_exit',
                     wait_status=status,
                     exit_code=(status >> 8) & 255 if status & 127 == 0 else None,
                     signal=status & 127 if status & 127 else None)
    elif kind == 6:
        status = fields(one(data, 2, b''))
        # A call gVisor has no typed point for: its number and six integers.
        # A path argument is a pointer into the program's memory, so the
        # integers name no file.
        event.update(kind='syscall_return' if 2 in data else 'syscall_enter',
                     sysno=one(data, 4), result=signed(one(status, 1)), errno=one(status, 2),
                     args=[one(data, number) for number in range(5, 11)])
    elif kind == 7:
        # open, openat and creat. `dirfd` is what a relative path is relative
        # to (-100: the working directory), `fd_path` that folder's path.
        event.update(kind='open', sysno=one(data, 3), dirfd=signed(one(data, 4)), fd_path=string(one(data, 5, b'')),
                     pathname=string(one(data, 6, b'')), flags=one(data, 7), mode=one(data, 8), **result_of(data))
    elif kind == 10:
        event.update(kind='connect', sysno=one(data, 3), **address(one(data, 6, b'')), **result_of(data))
    elif kind == 37:
        event.update(kind='listen', sysno=one(data, 3), backlog=one(data, 6), **address(one(data, 7, b'')), **result_of(data))
    elif kind in (14, 15):
        # setuid/setgid carry one id; setresuid/setresgid the real, effective and saved ones.
        event.update(kind='setid', sysno=one(data, 3), ids=[one(data, number) for number in ((4,) if kind == 14 else (4, 5, 6))],
                     **result_of(data))
    else:
        event['payload_base64'] = base64.b64encode(packet[size:]).decode('ascii')
    if carried_env:
        event['raw_withheld'] = 'envv'
    return event


def with_raw(event, packet):
    """The event with its original packet, for the ones that are stored.
    Preserves original evidence for decoder corrections and schema upgrades.
    This may contain sensitive argv; the DB must stay outside the workload.
    Withheld entirely when the packet carried an environment block: the
    decoded event keeps only the allowlisted markers, and storing the raw
    bytes would put every other variable -- keys, tokens, passwords -- back
    into the database through the side door."""
    if 'raw_withheld' not in event:
        event['raw_packet_base64'] = base64.b64encode(packet).decode('ascii')
    return event


def init_db(path):
    db = sqlite3.connect(path, timeout=10)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('''CREATE TABLE IF NOT EXISTS runtime_events (
      id INTEGER PRIMARY KEY, connection TEXT NOT NULL, received_ms INTEGER NOT NULL,
      container_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL)''')
    db.execute('CREATE INDEX IF NOT EXISTS runtime_container ON runtime_events(container_id,id)')
    db.commit()
    return db


class Writer(threading.Thread):
    """Writes runtime_events a batch at a time: one commit for a quarter second
    of events, not one for each. A sandbox's thread only queues its row, so a
    slow disk never holds up reading from gVisor."""
    def __init__(self, database):
        super().__init__(daemon=True, name='raytace-writer')
        self.database = database
        self.rows = queue.SimpleQueue()

    def put(self, connection, event):
        self.rows.put((connection, int(time.time() * 1000), event.get('container_id', ''), event['kind'], json.dumps(event)))

    def run(self):
        db = init_db(self.database)
        while True:
            batch = [self.rows.get()]
            deadline = time.monotonic() + 0.25
            while len(batch) < 200:
                try:
                    batch.append(self.rows.get(timeout=max(0.0, deadline - time.monotonic())))
                except queue.Empty:
                    break
            while True:
                try:
                    db.executemany('INSERT INTO runtime_events(connection,received_ms,container_id,kind,body) VALUES(?,?,?,?,?)', batch)
                    db.commit()
                    break
                except sqlite3.Error as error:  # a locked or full database: keep the batch and try again
                    print(f'RayTrace collector: runtime_events not written ({error}); retrying', flush=True)
                    time.sleep(1)


def serve(endpoint, database):
    os.umask(0o077)
    init_db(database).close()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    # Refuse to replace an existing socket: a second collector must not steal it.
    server.bind(endpoint)
    server.listen(32)
    slots = threading.BoundedSemaphore(64)
    writer = Writer(database)
    writer.start()
    engine = None
    if facts_engine:
        try:
            engine = facts_engine.Engine(database)
            engine.start()
        except Exception as error:
            print(f'RayTrace collector: fact engine not started ({error}); recording processes only', flush=True)

    def taken(event):
        """Whether the engine took the event as its own: a file or network
        call, which is then not written. It sees process events too, to know
        which program and tool call a later call belongs to."""
        return bool(engine and engine.accept(event))

    def client(conn):
        connection = str(uuid.uuid4())
        container = ''
        def record(event):
            writer.put(connection, event)
        try:
            conn.settimeout(5)
            greeting, _, flags, _ = conn.recvmsg(4096)
            if flags & socket.MSG_TRUNC or one(fields(greeting), 1) != 1:
                raise ValueError('unsupported handshake')
            conn.sendall(b'\x08\x01')
            conn.settimeout(None)
            record({'kind': 'collector_connected', 'source': 'collector'})
            previous_dropped = 0
            while True:
                packet, _, flags, _ = conn.recvmsg(MAX_PACKET)
                if not packet:
                    break
                if flags & socket.MSG_TRUNC:
                    raise ValueError('oversized event')
                event = decode(packet)
                if event['container_id']:
                    container = event['container_id']
                if event['dropped_count'] != previous_dropped:
                    gap = {'kind': 'collection_gap', 'container_id': event['container_id'],
                           'dropped_delta': (event['dropped_count'] - previous_dropped) % (1 << 32)}
                    record(gap)
                    taken(gap)
                    previous_dropped = event['dropped_count']
                if not taken(event):
                    record(with_raw(event, packet))
        except Exception as error:
            record({'kind': 'collection_error', 'container_id': container, 'error': str(error)[:500]})
        finally:
            # EOF alone does not prove a complete trace; final dropped events
            # may never have been reported in a subsequent packet. Tagged with
            # the sandbox this connection carried (one per sandbox), so a
            # consumer can tell whose open processes will now never report an
            # exit; empty if no event ever arrived.
            gone = {'kind': 'collector_disconnected', 'container_id': container, 'coverage': 'not_certified'}
            record(gone)
            taken(gone)
            conn.close()
            slots.release()
    print('RayTrace collector ready: ' + endpoint, flush=True)
    try:
        while True:
            conn, _ = server.accept()
            if not slots.acquire(blocking=False):
                conn.close()
                continue
            threading.Thread(target=client, args=(conn,), daemon=True).start()
    finally:
        server.close()
        os.unlink(endpoint)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--socket', required=True)
    parser.add_argument('--database', required=True)
    opts = parser.parse_args()
    serve(opts.socket, opts.database)
