"""Loopback-only, read-only evidence viewer, forwarded by Lima to the Mac.

A forwarded port is open to every account on the Mac, so each request carries
the token the CLI writes here (src/local-sandbox.mjs). No token, no evidence.
"""
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
import time
from urllib.parse import urlparse, parse_qs

TOKEN = Path('/etc/raytace/viewer-token')


def allowed(header):
    try:
        token = TOKEN.read_text().strip()
    except OSError:
        return False
    return bool(token) and hmac.compare_digest(header.encode(), f'Bearer {token}'.encode())


def event_page(db, query):
    container = query.get('container', [''])[0]
    before = int(query.get('before', ['0'])[0])
    # `after` is the tailing cursor used by the RayTrace proxy's gVisor
    # forwarder: events with id > after, oldest first, so a poller can
    # advance through the log without gaps. `before` (the UI's "older
    # events" paging, newest first) still works on its own; `after` wins
    # when both are given.
    after = int(query.get('after', ['0'])[0])
    limit = min(500, max(1, int(query.get('limit', ['100'])[0])))
    # `since`/`until` (epoch ms, inclusive) scope a page to one agent turn --
    # from the prompt to the answer -- so the UI is not showing every command
    # ever run in this sandbox. Filtered on the collector's own `received_ms`
    # column rather than the event's timestamp_ns, which lives inside the JSON
    # body: the two differ by well under a millisecond, and a column is
    # indexable where a json_extract is not.
    since = int(query.get('since', ['0'])[0])
    until = int(query.get('until', ['0'])[0])
    clauses, params = [], []
    if container:
        clauses.append('container_id = ?'); params.append(container)
    if since:
        clauses.append('received_ms >= ?'); params.append(since)
    if until:
        clauses.append('received_ms <= ?'); params.append(until)
    if after:
        clauses.append('id > ?'); params.append(after)
    elif before:
        clauses.append('id < ?'); params.append(before)
    if query.get('processes', [''])[0] == '1':
        clauses.append("kind IN ('exec_succeeded','exec_failed','process_exit','collection_gap','collection_error','collector_disconnected')")
    where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
    order = 'ASC' if after else 'DESC'
    rows = db.execute('SELECT id,body FROM runtime_events'+where+' ORDER BY id '+order+' LIMIT ?', (*params, limit+1)).fetchall()
    events = []
    for identifier, body in rows[:limit]:
        event=json.loads(body); event.pop('raw_packet_base64',None)
        event['event_id']=identifier; events.append(event)
    page = {'events':events,'next_before':None if after else (rows[limit-1][0] if len(rows)>limit else None)}
    if after:
        page['next_after'] = rows[limit-1][0] if len(rows) > limit else None
    return page

def fact_page(db, query):
    """Facts the engine drew (engine.py), oldest first after `after`: the
    control plane's cursor over every sandbox of this host, or with `container`
    over one. A fact that grew since it was read comes again under a new id, so
    the reader replaces its copy. `latest` is the highest id ever given: a
    reader whose cursor is past it is looking at a new database."""
    container = query.get('container', [''])[0]
    after = int(query.get('after', ['0'])[0])
    limit = min(1000, max(1, int(query.get('limit', ['500'])[0])))
    clauses, params = ['id > ?'], [after]
    if container:
        clauses.append('container_id = ?'); params.append(container)
    rows = db.execute('SELECT id, body FROM facts WHERE ' + ' AND '.join(clauses) + ' ORDER BY id LIMIT ?', (*params, limit + 1)).fetchall()
    facts = [{**json.loads(body), 'id': identifier} for identifier, body in rows[:limit]]
    latest = db.execute("SELECT seq FROM sqlite_sequence WHERE name = 'facts'").fetchone()
    return {'facts': facts, 'next_after': facts[-1]['id'] if len(rows) > limit else None, 'latest': latest[0] if latest else 0}

PAGE = '''<!doctype html><meta charset="utf-8"><title>RayTrace runtime evidence</title>
<style>body{font:15px system-ui;background:#111827;color:#e5e7eb;margin:32px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px;border-bottom:1px solid #374151}code{white-space:pre-wrap}select{padding:8px} .note{color:#fbbf24}</style>
<h1>Runtime evidence</h1><p>Independent gVisor process events. Select a sandbox to inspect its timeline.</p>
<p class="note">Coverage: selected process events only. Missing evidence is not proof of non-execution. Disconnects do not certify completeness.</p>
<select id="jobs"><option value="">All sandboxes and collector health</option></select><p id="status"></p>
<table><thead><tr><th>Event</th><th>PID / parent</th><th>Executable / arguments / result</th></tr></thead><tbody id="events"></tbody></table>
<script>
const select=document.getElementById('jobs');
async function refresh(){try{const response=await fetch('events');if(!response.ok)throw Error('Collector unavailable');const data=await response.json();
const chosen=select.value;select.replaceChildren(new Option('All sandboxes and collector health',''));for(const id of data.containers)select.add(new Option(id.slice(0,16),id));select.value=chosen;
const rows=data.events.filter(e=>!select.value||e.container_id===select.value);
document.getElementById('status').textContent='Latest '+rows.length+' events (up to 500). '+data.gaps+' recorded collection errors/gaps.';
const body=document.getElementById('events');body.replaceChildren();for(const e of rows){const {raw_packet_base64,...detail}=e;const tr=document.createElement('tr');for(const v of [e.kind,`${e.pid??'—'} / ${e.ppid??'—'}`,JSON.stringify(detail)]){const td=document.createElement('td');const code=document.createElement('code');code.textContent=v;td.append(code);tr.append(td);}body.append(tr);}
}catch(e){document.getElementById('status').textContent=e.message;}}
select.onchange=refresh;refresh();setInterval(refresh,1500);
</script>'''


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get('Host', '').split(':')[0] not in ('localhost', '127.0.0.1'):
            self.send_error(403)
            return
        if not allowed(self.headers.get('Authorization', '')):
            self.send_error(401)
            return
        if self.path == '/':
            body, mime = PAGE.encode(), 'text/html; charset=utf-8'
        elif urlparse(self.path).path == '/time':
            # The VM's realtime clock, which gVisor stamps events with. The
            # proxy on the Mac samples this to map event times onto its own
            # clock; the two drift apart, notably after the Mac sleeps.
            body, mime = json.dumps({'realtime_ns': str(time.time_ns())}).encode(), 'application/json'
        elif urlparse(self.path).path == '/facts':
            try:
                with sqlite3.connect('file:/var/lib/raytace/runtime.db?mode=ro', uri=True) as db:
                    body, mime = json.dumps(fact_page(db, parse_qs(urlparse(self.path).query))).encode(), 'application/json'
            except sqlite3.OperationalError:
                # A host whose engine has not run yet has no facts table: none, not an error.
                body, mime = json.dumps({'facts': [], 'next_after': None, 'latest': 0}).encode(), 'application/json'
            except (sqlite3.Error, ValueError):
                self.send_error(503, 'Evidence database unavailable')
                return
        elif urlparse(self.path).path == '/events':
            try:
                with sqlite3.connect('file:/var/lib/raytace/runtime.db?mode=ro', uri=True) as db:
                    page = event_page(db, parse_qs(urlparse(self.path).query))
                    containers = [r[0] for r in db.execute("SELECT DISTINCT container_id FROM runtime_events WHERE container_id != ''")]
                    gaps = db.execute("SELECT COUNT(*) FROM runtime_events WHERE kind IN ('collection_error','collection_gap')").fetchone()[0]
                body = json.dumps({**page, 'containers': containers, 'gaps': gaps, 'coverage':'Selected process events; completeness not certified'}).encode()
                mime = 'application/json'
            except (sqlite3.Error, ValueError):
                self.send_error(503, 'Evidence database unavailable')
                return
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8798), Handler).serve_forever()
