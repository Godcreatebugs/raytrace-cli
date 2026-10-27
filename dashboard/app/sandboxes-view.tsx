'use client';

// Sandboxes: every sandbox RayTrace has made, grouped by the VM it runs on,
// and what was asked in each. The list comes from the sandbox manager; each
// sandbox's history is the prompts whose session ran in it, with how many of
// their commands the sandbox itself saw run. Destroyed sandboxes stay: their
// evidence outlives them.
import { useEffect, useState } from 'react';
import { api } from './api';
import { ArrowRight, Copy, ScanSearch, Server } from 'lucide-react';
import { NewSandbox } from './new-sandbox';
import { type Trace } from './types';


type Sandbox = {
  id: string;
  name: string;
  host: string;
  /** False when the manager is connected to a different host: `status` is then the last recorded. */
  on_host: boolean;
  status: string;
  created: number | string;
  deleted: number | null;
  size_bytes: number | null;
  imported_bytes: number | null;
  transcripts: boolean | null;
  skipped_count: number;
  /** The initial scan's totals, when the project was scanned as it was uploaded. */
  scan?: { files?: number; by_level?: Record<string, number> } | null;
};

const firstLine = (text: string) => text.split('\n').find((line) => line.trim())?.trim() ?? '(empty prompt)';
const when = (value: number | string) => new Date(typeof value === 'number' ? value * 1000 : value)
  .toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const mib = (bytes: number | null) => bytes == null ? '—' : `${(bytes / 1048576).toFixed(bytes < 1048576 ? 2 : 1)} MiB`;

/** `raytace@34.55.7.7` is a cloud VM reached over SSH; `lima` the local one. */
function hostLabel(host: string) {
  if (host === 'lima') return { title: 'Local VM', detail: 'Lima on this machine' };
  return { title: `Cloud VM ${host.split('@').pop()}`, detail: host };
}

function state(box: Sandbox) {
  if (box.status === 'deleted') return { label: 'Destroyed', tone: 'deleted' };
  if (!box.on_host) return { label: 'Not connected', tone: 'unknown' };
  if (box.status === 'running') return { label: 'Running', tone: 'running' };
  if (box.status === 'import_failed') return { label: 'Failed to create', tone: 'deleted' };
  return { label: 'Stopped', tone: 'stopped' };
}

export function SandboxesView({ traces, selectedId, onSelect, onOpenTrace, onOpenScan }: {
  traces: Trace[];
  selectedId: string;
  onSelect: (sandboxId: string) => void;
  onOpenTrace: (traceId: string) => void;
  /** Opens a sandbox's initial scan, where there is that section. */
  onOpenScan?: (sandboxId: string) => void;
}) {
  const [boxes, setBoxes] = useState<Sandbox[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState('');
  const [destroying, setDestroying] = useState('');
  const [destroyError, setDestroyError] = useState('');
  // Bumped to list again at once, after a sandbox is created here.
  const [listed, setListed] = useState(0);
  const canCreate = Boolean(api().createSandbox);

  useEffect(() => {
    let closed = false; let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await api().fetch('/raytace/sandboxes', { cache: 'no-store' });
        const data = await response.json() as { sandboxes?: Sandbox[]; error?: string };
        if (!response.ok) throw new Error(data.error || 'Sandbox list unavailable');
        if (!closed) { setBoxes(data.sandboxes ?? []); setError(null); }
      } catch (problem) { if (!closed) setError(problem instanceof Error ? problem.message : 'Proxy unavailable'); }
      if (!closed) timer = setTimeout(load, 10000);
    };
    void load(); return () => { closed = true; clearTimeout(timer); };
  }, [listed]);

  const history = new Map<string, Trace[]>();
  for (const trace of traces) {
    if (!trace.sandboxId || trace.forkId) continue;
    history.set(trace.sandboxId, [...(history.get(trace.sandboxId) ?? []), trace]);
  }
  // The connected VM first, then by name; inside a VM, live sandboxes first, newest first.
  const hosts = [...new Set((boxes ?? []).map((box) => box.host))].sort((a, b) => {
    const live = (host: string) => (boxes ?? []).some((box) => box.host === host && box.on_host) ? 0 : 1;
    return live(a) - live(b) || a.localeCompare(b);
  });
  const created = (box: Sandbox) => typeof box.created === 'number' ? box.created * 1000 : Date.parse(box.created);

  const copy = (text: string) => { void navigator.clipboard?.writeText(text); setCopied(text); setTimeout(() => setCopied(''), 1500); };

  const [pendingDestroy, setPendingDestroy] = useState<Sandbox | null>(null);

  const destroy = async (box: Sandbox) => {
    setDestroying(box.id); setDestroyError('');
    try {
      const response = await api().fetch(`/raytace/sandboxes/${box.id}`, { method: 'DELETE', headers: { 'x-raytace-experiment': '1' } });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error || 'Destroy failed');
      onSelect('');
      setListed((count) => count + 1);
    } catch (problem) { setDestroyError(problem instanceof Error ? problem.message : 'Destroy failed'); }
    finally { setDestroying(''); setPendingDestroy(null); }
  };

  return <section className="rt-view">
    <header className="rt-view-head"><div><span className="eyebrow">SANDBOXES</span><h1>Where your agents ran</h1></div></header>
    {/* A new sandbox opens on its scan: what the upload holds, before any agent runs in it. */}
    {canCreate && <NewSandbox onCreated={(id) => { setListed((count) => count + 1); (onOpenScan ?? onSelect)(id); }} />}
    {error && <p className="rt-empty">{error}</p>}
    {destroyError && <p className="rt-empty">{destroyError}</p>}
    {!error && boxes === null && <p className="rt-empty">Loading…</p>}
    {!error && boxes?.length === 0 && <p className="rt-empty">No sandboxes yet. {canCreate ? 'Drop a project folder above, or from' : 'From'} a Git repository: <code>raytrace sandbox create</code></p>}
    {hosts.map((host) => {
      const label = hostLabel(host);
      const inHost = (boxes ?? []).filter((box) => box.host === host)
        .sort((a, b) => Number(a.status === 'deleted') - Number(b.status === 'deleted') || created(b) - created(a));
      const connected = inHost.some((box) => box.on_host);
      return <div key={host} className="rt-host">
        <div className="rt-list-head">
          <span className="rt-host-title"><Server size={13} /> {label.title.toUpperCase()}</span>
          <small>{label.detail} · {connected ? 'connected' : 'not connected now'} · {inHost.length} sandbox{inHost.length === 1 ? '' : 'es'}</small>
        </div>
        <ol className="rt-prompts">
          {inHost.map((box) => {
            const open = box.id === selectedId;
            const prompts = (history.get(box.id) ?? []).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
            const shown = state(box);
            const shell = `raytrace connect ${box.host === 'lima' && box.name ? box.name : box.id}`;
            return <li key={box.id} className={open ? 'rt-prompt open' : 'rt-prompt'}>
              <button type="button" className="rt-prompt-row" aria-expanded={open} onClick={() => onSelect(open ? '' : box.id)}>
                <time>{when(box.created)}</time>
                <strong><span className={`rt-state s-${shown.tone}`}>{shown.label}</span>{box.name}</strong>
                <small>{prompts.length} prompt{prompts.length === 1 ? '' : 's'} · {box.id.slice(0, 12)}…</small>
              </button>
              {open && <div className="rt-prompt-detail">
                <dl className="rt-facts">
                  <dt>Sandbox</dt><dd><code>{box.id}</code></dd>
                  <dt>Runs on</dt><dd>{label.title} <span className="rt-muted">({label.detail})</span></dd>
                  <dt>State</dt><dd>{shown.label}{!box.on_host && box.status !== 'deleted' ? <span className="rt-muted"> — the manager is connected to another VM; last recorded: {box.status}</span> : null}</dd>
                  <dt>Created</dt><dd>{when(box.created)}{box.deleted ? <span className="rt-muted"> · destroyed {when(box.deleted)}</span> : null}</dd>
                  {box.host !== 'lima' && <><dt>Uploaded</dt><dd>{mib(box.imported_bytes)}{box.skipped_count ? <span className="rt-muted"> · {box.skipped_count} file{box.skipped_count === 1 ? '' : 's'} left out</span> : null}</dd></>}
                  <dt>Recording</dt><dd>{box.transcripts === false ? 'Commands only (no Claude Code transcripts)' : 'Commands and Claude Code transcripts'}</dd>
                  {onOpenScan && box.scan?.by_level && <><dt>Initial scan</dt><dd>{box.scan.files} files, {(box.scan.by_level['4'] ?? 0) + (box.scan.by_level['5'] ?? 0)} at level 4 or 5{' '}
                    <button type="button" className="link-button" onClick={() => onOpenScan(box.id)}><ScanSearch size={11} /> Open the scan</button></dd></>}
                </dl>
                {box.status !== 'deleted' && box.on_host && <div className="rt-shell-line">
                  <code>{shell}</code>
                  <button type="button" className="rt-button" onClick={() => copy(shell)}><Copy size={13} /> {copied === shell ? 'Copied' : 'Copy'}</button>
                </div>}
                {box.host === 'lima' && <div className="rt-shell-line">
                  <code>raytrace sandbox destroy {box.name || box.id}</code>
                  <button type="button" className="rt-button" onClick={() => copy(`raytrace sandbox destroy ${box.name || box.id}`)}><Copy size={13} /> {copied === `raytrace sandbox destroy ${box.name || box.id}` ? 'Copied' : 'Copy'}</button>
                </div>}
                {box.host === 'lima' && <p className="rt-foot">Run the first command in a terminal to open this sandbox, then start <code>claude</code> or <code>codex</code> there.
                  The second deletes it, and asks whether to delete the logs recorded in it too.</p>}
                {box.host !== 'lima' && box.status !== 'deleted' && box.on_host && <div className="rt-shell-line">
                  <code>Destroy this sandbox and stop anything running in it. Its recorded evidence stays.</code>
                  <button type="button" className="rt-button" disabled={destroying === box.id} onClick={() => setPendingDestroy(box)}>{destroying === box.id ? 'Destroying…' : 'Destroy'}</button>
                </div>}
                {box.host !== 'lima' && box.status !== 'deleted' && box.on_host && <p className="rt-foot">Run it in a terminal to open this sandbox, then start <code>claude</code> or <code>codex</code> there.
                  Needs the RayTrace CLI, signed in as this account: <code>npm install -g @raytrace-cli/cli@latest</code>.
                  On CLI 0.2 the command is <code>raytrace sandbox shell {box.id}</code>.</p>}
                <h3>History</h3>
                {!prompts.length && <p className="rt-muted">No prompts recorded in this sandbox yet.</p>}
                {prompts.length > 0 && <ol className="rt-history">
                  {prompts.map((trace) => {
                    // Commands only: a Read or Edit runs inside the agent and never starts a program.
                    const all = trace.callVerifications ?? [];
                    const calls = all.filter((call) => call.exec_id || (call.kind ? call.kind === 'command' : call.proposed != null));
                    const verified = calls.filter((call) => call.exec_id).length;
                    const fileCalls = all.filter((call) => call.kind === 'file' && !call.exec_id).length;
                    return <li key={trace.id}>
                      <button type="button" onClick={() => onOpenTrace(trace.id)}>
                        <time dateTime={trace.startedAt}>{when(trace.startedAt)}</time>
                        <span>{firstLine(trace.title)}</span>
                        <small className={calls.length && verified === calls.length ? 'all' : ''}>
                          {calls.length ? `${verified} of ${calls.length} command${calls.length === 1 ? '' : 's'} observed in the sandbox` : 'no commands'}
                          {fileCalls > 0 && ` · ${fileCalls} file operation${fileCalls === 1 ? '' : 's'}`}
                        </small>
                        <ArrowRight size={13} />
                      </button>
                    </li>;
                  })}
                </ol>}
              </div>}
            </li>;
          })}
        </ol>
      </div>;
    })}
    {pendingDestroy && <dialog open className="rt-dialog" aria-labelledby="rt-destroy-title"
      onCancel={(event) => { event.preventDefault(); if (!destroying) setPendingDestroy(null); }}>
        <h2 id="rt-destroy-title">Destroy this sandbox?</h2>
        <p>“{pendingDestroy.name || pendingDestroy.id}” stops and is deleted. Its recorded evidence stays.</p>
        <div className="rt-dialog-actions">
          <button type="button" className="rt-button" autoFocus disabled={Boolean(destroying)} onClick={() => setPendingDestroy(null)}>No</button>
          <button type="button" className="rt-button rt-danger" disabled={Boolean(destroying)} onClick={() => void destroy(pendingDestroy)}>{destroying ? 'Destroying…' : 'Yes, destroy'}</button>
        </div>
    </dialog>}
  </section>;
}
