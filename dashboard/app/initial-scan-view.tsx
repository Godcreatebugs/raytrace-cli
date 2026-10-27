'use client';

// Initial scan: every file of a sandbox's project with how dangerous it is to
// change, from 1 to 5, and why (worker/gvisor/file_scan.py scans the upload).
// The level is a proposal: its owner moves any file up or down, chooses which
// files a change is reported for, and which the agent may not change at all.
// Alerts lists what the agent then did to those files: changes it made, and
// attempts it made (an edit that was refused, a read, a command naming one),
// each with who saw it: the sandbox's hook or the kernel. Activity is what the
// kernel layer saw of the whole sandbox: connections, packages, files.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Ban, Bell, ChevronDown, ChevronRight, Lock, RotateCcw } from 'lucide-react';
import { api } from './api';
import { type FileAlert, type FileScore, type FileUpdate, type Scan, LEVEL_ACTIONS, LEVEL_WORDS, forgetFileLevels, loadAlerts, loadNotify, loadScan, markSeen, saveFiles, saveNotify } from './file-scan';
import { SandboxActivity } from './sandbox-activity';
import { type Trace } from './types';

type Box = { id: string; name: string; status: string; created: number | string };
const PAGE = 200;
const FLAG_WORDS: Record<string, [string, string]> = {
  untested: ['no test', 'No test file is named after this file.'],
  unreferenced: ['not imported', 'No other file imports this one, and nothing was found that starts it.'],
  large: ['large', 'Over 800 lines.'],
  created: ['new', 'Appeared after the initial scan, so it is scored by its path alone.'],
};
const ALERT_WORDS: Record<FileAlert['kind'], string> = {
  watched_changed: 'Watched file changed', restricted_changed: 'Restricted file changed', new_sensitive: 'Sensitive file created',
  restricted_blocked: 'Change to a restricted file blocked', restricted_read: 'Restricted file read',
  restricted_named: 'Restricted file named in a command', watched_read: 'Watched file read',
  network_refused: 'Connection to a private address refused',
};
const ALERT_NOTES: Partial<Record<FileAlert['kind'], string>> = {
  restricted_blocked: 'The agent tried to change this file and was refused.',
  restricted_named: 'The command mentions this file. What it does is not known: it may only read it.',
  network_refused: 'The sandbox firewall rejects private addresses: the VM\'s own services and the cloud metadata server are there.',
};
const STATUS_WORDS: Record<string, string> = { A: 'added', M: 'edited', D: 'deleted', R: 'renamed', T: 'type changed' };
const SOURCE_NOTES: Record<FileAlert['source'], string> = {
  kernel: 'Seen by the sandbox\'s kernel layer and its host: every program, whatever started it, and nothing the agent could write.',
  hook: 'Reported by the sandbox\'s Claude Code hook: the agent\'s own tool said so.',
};

/** An alert as shown: the hook and the kernel can both report one thing, and
 * such a pair is one row that names both. `by` is the program the kernel saw. */
type AlertRow = FileAlert & { ids: string[]; sources: FileAlert['source'][]; by: string | null };
function mergeAlerts(alerts: FileAlert[]): AlertRow[] {
  const rows: AlertRow[] = [];
  for (const alert of alerts) {
    const at = alert.at ?? alert.created;
    // The same file and event, from the other witness: for the same tool call, or with no call to go by within 20 seconds.
    const twin = rows.find((row) => row.path === alert.path && row.kind === alert.kind && !row.sources.includes(alert.source)
      && (row.call_id && alert.call_id ? row.call_id === alert.call_id : Math.abs((row.at ?? row.created) - at) <= 20));
    if (!twin) {
      rows.push({ ...alert, ids: [alert.id], sources: [alert.source], tool: alert.source === 'hook' ? alert.tool : null, by: alert.source === 'kernel' ? alert.tool : null });
      continue;
    }
    twin.ids.push(alert.id); twin.sources.push(alert.source);
    twin.seen = twin.seen && alert.seen;
    twin.call_id ??= alert.call_id;
    if (alert.source === 'kernel') twin.by = alert.tool;
    else { twin.tool = alert.tool; twin.status ??= alert.status; twin.added ??= alert.added; twin.removed ??= alert.removed; twin.commit ??= alert.commit; }
  }
  return rows;
}
const when = (value: number | string) => new Date(typeof value === 'number' ? value * 1000 : value)
  .toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function LevelBadge({ level, title }: { level: number; title?: string }) {
  return <span className={`rt-level level-${level}`} title={title ?? `Level ${level} of 5: ${LEVEL_WORDS[level]}`}>{level}</span>;
}

/** The sandboxes to choose from, when none is open. */
function Chooser({ onSelect }: { onSelect: (id: string) => void }) {
  const [boxes, setBoxes] = useState<Box[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let closed = false;
    void (async () => {
      try {
        const response = await api().fetch('/raytace/sandboxes', { cache: 'no-store' });
        const data = await response.json() as { sandboxes?: Box[]; error?: string };
        if (!response.ok) throw new Error(data.error || 'Sandbox list unavailable');
        if (!closed) setBoxes((data.sandboxes ?? []).filter((box) => box.status !== 'deleted'));
      } catch (problem) { if (!closed) setError(problem instanceof Error ? problem.message : 'Sandbox list unavailable'); }
    })();
    return () => { closed = true; };
  }, []);
  if (error) return <p className="rt-empty">{error}</p>;
  if (!boxes) return <p className="rt-empty">Loading…</p>;
  if (!boxes.length) return <p className="rt-empty">No sandboxes yet. A project is scanned when its sandbox is created.</p>;
  return <>
    <div className="rt-list-head"><span>CHOOSE A SANDBOX</span></div>
    <ol className="rt-prompts">{boxes.map((box) => <li key={box.id} className="rt-prompt">
      <button type="button" className="rt-prompt-row" onClick={() => onSelect(box.id)}>
        <time>{when(box.created)}</time><strong>{box.name}</strong><small>{box.id.slice(0, 12)}…</small>
      </button>
    </li>)}</ol>
  </>;
}

export function InitialScanView({ box, traces, onSelect, onOpenCall, onAlertsSeen }: {
  /** The sandbox whose scan is open; '' to choose one. */
  box: string;
  traces: Trace[];
  onSelect: (sandboxId: string) => void;
  onOpenCall: (traceId: string, callId: string) => void;
  /** The navigation's count of unseen alerts is out of date. */
  onAlertsSeen: () => void;
}) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [tab, setTab] = useState<'files' | 'alerts' | 'activity'>('files');
  const [level, setLevel] = useState<number | null>(null);
  const [only, setOnly] = useState<'restricted' | 'notify' | null>(null);
  const [search, setSearch] = useState('');
  const [closedLevels, setClosedLevels] = useState<ReadonlySet<number>>(() => new Set([5, 4, 3, 2, 1]));
  const [shown, setShown] = useState(PAGE);
  const [alerts, setAlerts] = useState<FileAlert[]>([]);
  /** Whether alerts are emailed; null where there is no account (the local dashboard). */
  const [email, setEmail] = useState<boolean | null>(null);
  useEffect(() => { let closed = false; void loadNotify().then((on) => { if (!closed) setEmail(on); }); return () => { closed = true; }; }, []);

  useEffect(() => {
    setScan(null); setError(null); setProblem(null); setShown(PAGE); setClosedLevels(new Set([5, 4, 3, 2, 1]));
    if (!box) return;
    let closed = false;
    loadScan(box).then((found) => { if (!closed) setScan(found); }, (failed: Error) => { if (!closed) setError(failed.message); });
    return () => { closed = true; };
  }, [box]);

  useEffect(() => {
    setAlerts([]);
    if (!box) return;
    let closed = false; let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const found = await loadAlerts(box); if (!closed) setAlerts(found.alerts); } catch { /* the list keeps what it had */ }
      if (!closed) timer = setTimeout(load, 10000);
    };
    void load(); return () => { closed = true; clearTimeout(timer); };
  }, [box]);

  // Shown at once, then confirmed by what the control plane kept; a refusal puts the scan back as it is there.
  const change = useCallback(async (update: FileUpdate, optimistic: Partial<FileScore>) => {
    setProblem(null);
    setScan((prev) => prev && { ...prev, files: prev.files.map((file) => (file.path === update.path ? { ...file, ...optimistic } : file)) });
    try {
      const saved = await saveFiles(box, [update]);
      const kept = new Map(saved.files.map((file) => [file.path, file]));
      setScan((prev) => prev && { ...prev, guardrails: saved.guardrails ?? prev.guardrails, files: prev.files.map((file) => kept.get(file.path) ?? file) });
      forgetFileLevels(box);
    } catch (failed) {
      setProblem(failed instanceof Error ? failed.message : 'That change could not be saved.');
      loadScan(box).then(setScan, () => undefined);
    }
  }, [box]);

  const files = useMemo(() => scan?.files ?? [], [scan]);
  const counts = useMemo(() => {
    const byLevel = [0, 0, 0, 0, 0, 0];
    let restricted = 0; let notify = 0;
    for (const file of files) { byLevel[file.level] += 1; if (file.restricted) restricted += 1; if (file.notify) notify += 1; }
    return { byLevel, restricted, notify };
  }, [files]);
  const visible = useMemo(() => {
    const words = search.trim().toLowerCase();
    // Most dangerous first, as the scan gives them; a file the owner moved takes its new place.
    return files.filter((file) => (level == null || file.level === level) && (only !== 'restricted' || file.restricted)
      && (only !== 'notify' || file.notify) && (!words || file.path.toLowerCase().includes(words)))
      .sort((a, b) => b.level - a.level || (b.reach?.score ?? b.reach?.dependents ?? 0) - (a.reach?.score ?? a.reach?.dependents ?? 0)
        || (b.reach?.dependents ?? 0) - (a.reach?.dependents ?? 0) || a.path.localeCompare(b.path));
  }, [files, level, only, search]);
  const groupsOpen = Boolean(search.trim() || level != null || only);
  const shownFiles = visible.slice(0, shown);
  const fileGroups = [5, 4, 3, 2, 1].map((value) => ({
    level: value,
    total: visible.filter((file) => file.level === value).length,
    files: shownFiles.filter((file) => file.level === value),
    closed: !groupsOpen && closedLevels.has(value),
  })).filter((group) => group.total > 0);
  const driverFor = (file: FileScore) => {
    const sensitive = (file.hazard?.level ?? 0) >= 4;
    const widelyUsed = (file.reach?.level ?? 0) >= 4;
    return sensitive && widelyUsed ? 'Sensitive · Widely used' : sensitive ? 'Sensitive' : widelyUsed ? 'Widely used' : null;
  };
  const locked = useMemo(() => new Set(scan?.guardrails?.read_only ?? []), [scan]);
  const unseen = alerts.filter((alert) => !alert.seen);
  const rows = useMemo(() => mergeAlerts(alerts), [alerts]);
  // The step a tool call belongs to, when its prompt is in the loaded history.
  const stepFor = (callId: string | null) => {
    if (!callId) return null;
    const trace = traces.find((item) => item.sandboxId === box && !item.forkId && item.callVerifications?.some((call) => call.call_id === callId));
    return trace ? { trace: trace.id, call: callId } : null;
  };
  const chooseEmail = async (on: boolean) => {
    setEmail(on); setProblem(null);
    try { await saveNotify(on); } catch (failed) {
      setEmail(!on);
      setProblem(failed instanceof Error ? failed.message : 'That setting could not be saved.');
    }
  };
  const seen = async (ids: string[]) => {
    setAlerts((prev) => prev.map((alert) => (ids.includes(alert.id) ? { ...alert, seen: true } : alert)));
    try { await markSeen(ids); } catch { /* counted again on the next load */ }
    onAlertsSeen();
  };

  const summary = scan?.scan;
  return <section className="rt-view">
    <header className="rt-view-head">
      <div><span className="eyebrow">INITIAL SCAN</span><h1>{scan?.name ? `How risky each file of ${scan.name} is to change` : 'How risky each file is to change'}</h1></div>
      {box && <div className="rt-actions"><button type="button" className="rt-button" onClick={() => onSelect('')}>Another sandbox</button></div>}
    </header>
    {!box && <Chooser onSelect={onSelect} />}
    {box && error && <p role="alert" className="verify-error">{error}</p>}
    {box && !error && !scan && <p className="rt-empty">Loading…</p>}
    {scan && <>
      <dl className="rt-stats">
        <div><dt>Files</dt><dd>{files.length.toLocaleString()}</dd></div>
        <div><dt>Level</dt><dd className="rt-sev-counts">{[5, 4, 3, 2, 1].map((value) =>
          <button key={value} type="button" aria-pressed={level === value}
            className={`rt-level level-${value}${level === value ? ' rt-sev-on' : ''}${level != null && level !== value ? ' rt-sev-off' : ''}`}
            title={level === value ? 'Show every level' : `Show only level ${value} (${LEVEL_ACTIONS[value].toLowerCase()})`}
            onClick={() => { setLevel((prev) => (prev === value ? null : value)); setShown(PAGE); }}>{value} · {counts.byLevel[value]}</button>)}</dd></div>
        <div><dt>Reported when changed</dt><dd><button type="button" className={`rt-pick${only === 'notify' ? ' on' : ''}`} aria-pressed={only === 'notify'}
          onClick={() => { setOnly((prev) => (prev === 'notify' ? null : 'notify')); setShown(PAGE); }}><Bell size={13} /> {counts.notify}</button></dd></div>
        <div><dt>Restricted</dt><dd><button type="button" className={`rt-pick${only === 'restricted' ? ' on' : ''}`} aria-pressed={only === 'restricted'}
          onClick={() => { setOnly((prev) => (prev === 'restricted' ? null : 'restricted')); setShown(PAGE); }}><Lock size={13} /> {counts.restricted}</button></dd></div>
      </dl>
      <div className="rt-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>Files</button>
        <button type="button" role="tab" aria-selected={tab === 'alerts'} className={tab === 'alerts' ? 'on' : ''} onClick={() => setTab('alerts')}>
          Alerts{unseen.length > 0 && <span className="rt-count">{unseen.length}</span>}</button>
        <button type="button" role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activity</button>
      </div>
      {problem && <p role="alert" className="rt-problem">{problem}</p>}

      {tab === 'files' && <>
        {summary && 'error' in summary && <p className="rt-problem">{summary.error}. Files the agent changes are still scored by their path.</p>}
        {!files.length && !(summary && 'error' in summary) && <p className="rt-empty">This sandbox was created before RayTrace scanned projects, so it has no scan.</p>}
        {files.length > 0 && <>
          <input className="rt-search" type="search" value={search} placeholder="Filter by path" aria-label="Filter files by path"
            onChange={(event) => { setSearch(event.target.value); setShown(PAGE); }} />
          <div className="rt-table-wrap"><table className="rt-table rt-scan">
            <thead><tr><th>Level</th><th>File</th><th>Why</th><th title="Report it when the agent changes this file">Report</th><th title="The agent may not change this file">Restrict</th></tr></thead>
            {fileGroups.map((group) => <tbody key={group.level}>
              <tr className="rt-scan-group"><td colSpan={5}>
                <button type="button" aria-expanded={!group.closed} onClick={() => setClosedLevels((prev) => {
                  const next = new Set(prev);
                  if (next.has(group.level)) next.delete(group.level); else next.add(group.level);
                  return next;
                })}>
                  {group.closed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  <span className={`rt-level level-${group.level}`}>{group.level}</span>
                  {LEVEL_ACTIONS[group.level]}
                  <span className="rt-muted">{group.total.toLocaleString()} file{group.total === 1 ? '' : 's'}</span>
                </button>
              </td></tr>
              {!group.closed && group.files.map((file) => <tr key={file.path}>
              <td className="rt-scan-level">
                <select className={`rt-level level-${file.level}`} value={file.level} aria-label={`Level of ${file.path}`}
                  onChange={(event) => { const next = Number(event.target.value); void change({ path: file.path, level: next === file.scanned_level ? null : next },
                    { level: next, edited: next !== file.scanned_level, ...(file.notify_set ? {} : { notify: next >= 4 }) }); }}>
                  {[5, 4, 3, 2, 1].map((value) => <option key={value} value={value}>{value} {LEVEL_ACTIONS[value]}{value === file.scanned_level ? ' (scanned)' : ''}</option>)}
                </select>
                {file.edited && <button type="button" className="rt-undo" title={`Back to the scanned level, ${file.scanned_level}`} aria-label={`Put ${file.path} back to its scanned level`}
                  onClick={() => void change({ path: file.path, level: null }, { level: file.scanned_level, edited: false, ...(file.notify_set ? {} : { notify: file.scanned_level >= 4 }) })}><RotateCcw size={11} /></button>}
              </td>
              <td><code>{file.path}</code></td>
              <td className="rt-scan-why">{file.reasons.join(' · ') || <span className="rt-muted">Nothing imports it, and its name marks nothing</span>}
                {driverFor(file) && <span className="rt-flag rt-driver" title="What put this file at its level: sensitivity of the code, weighted blast radius, or both">{driverFor(file)}</span>}
                {file.flags.map((flag) => <span key={flag} className="rt-flag" title={FLAG_WORDS[flag]?.[1]}>{FLAG_WORDS[flag]?.[0] ?? flag}</span>)}
                {file.restricted && <small className="rt-scan-lock">{locked.has(file.path) ? 'Read-only in the sandbox, for every tool.'
                  : 'Claude Code edits are refused now. Read-only for every tool after the sandbox is next stopped and started.'}</small>}</td>
              <td><input type="checkbox" checked={file.notify} aria-label={`Report changes to ${file.path}`}
                onChange={(event) => void change({ path: file.path, notify: event.target.checked }, { notify: event.target.checked, notify_set: true })} /></td>
              <td><input type="checkbox" checked={file.restricted} aria-label={`Restrict ${file.path}`}
                onChange={(event) => void change({ path: file.path, restricted: event.target.checked }, { restricted: event.target.checked })} /></td>
            </tr>)}
            </tbody>)}

          </table></div>
          {!visible.length && <p className="rt-empty">No files match.</p>}
          {visible.length > shown && <p className="rt-foot"><button type="button" className="rt-button" onClick={() => setShown((count) => count + PAGE)}>
            Show {Math.min(PAGE, visible.length - shown)} more</button> {shown.toLocaleString()} of {visible.length.toLocaleString()} shown</p>}
          {summary && !('error' in summary) && <p className="rt-foot">{summary.version === 'scan-v2'
            ? 'Level is the higher of weighted blast radius and sensitivity. Direct and startup dependents count most, then each extra hop decays; reach is banded by percentile in this project, while secret, destructive, credential, payment and deploy code can be sensitive at any reach.'
            : 'Level is the higher of how much of the project imports a file and what kind of file it is.'}
            {' '}{summary.edges.toLocaleString()} imports followed in JavaScript, TypeScript and Python; other files are scored by path. Secrets left out of the upload are scored when the agent creates them.</p>}
        </>}
      </>}

      {tab === 'alerts' && <>
        {email !== null && <label className="rt-foot rt-email">
          <input type="checkbox" checked={email} onChange={(event) => void chooseEmail(event.target.checked)} /> Email me about alerts
          <span className="rt-muted"> · batched, at most one message every 30 seconds per project</span></label>}
        {!alerts.length && <p className="rt-empty">No alerts. One is raised when the agent changes, tries to change or reads a file marked Report or Restrict, creates a sensitive one, or tries to reach a private address.</p>}
        {alerts.length > 0 && <>
          {unseen.length > 0 && <p className="rt-foot"><button type="button" className="rt-button" onClick={() => void seen(unseen.map((alert) => alert.id))}>Mark all seen</button></p>}
          <div className="rt-table-wrap"><table className="rt-table rt-scan">
            <thead><tr><th>When</th><th>Level</th><th>File or destination</th><th>What happened</th><th title="Who saw it: the sandbox's kernel layer, or the agent's own tool through the sandbox's hook">Seen by</th>
              <th title="The agent's tool, and the program the kernel saw do it">Tool</th><th>Step</th></tr></thead>
            <tbody>{rows.map((alert) => {
              const step = stepFor(alert.call_id);
              return <tr key={alert.id} className={`${alert.seen ? 'rt-seen' : ''}${alert.kind === 'restricted_blocked' || alert.kind === 'network_refused' ? ' rt-alert-blocked' : ''}`}>
                <td><time title={alert.at ? `Seen at ${new Date(alert.at * 1000).toISOString()}` : undefined}>{when(alert.at ?? alert.created)}</time></td>
                <td><LevelBadge level={alert.level} /></td>
                <td><code>{alert.path}</code></td>
                <td title={ALERT_NOTES[alert.kind]}>{(alert.kind === 'restricted_blocked' || alert.kind === 'network_refused') && <Ban size={12} aria-hidden="true" />} {ALERT_WORDS[alert.kind] ?? alert.kind}
                  {alert.status && STATUS_WORDS[alert.status] ? <span className="rt-muted"> · {STATUS_WORDS[alert.status]}</span> : null}
                  {alert.added != null && <span className="rt-muted"> · +{alert.added} −{alert.removed ?? 0}</span>}</td>
                <td>{[...alert.sources].sort().reverse().map((source) => <span key={source} className={`rt-flag rt-source-${source}`} title={SOURCE_NOTES[source]}>{source}</span>)}</td>
                <td>{alert.tool || alert.by ? <>{alert.tool}{alert.tool && alert.by ? ' · ' : ''}{alert.by && <span title="The program the kernel saw do it">{alert.by}</span>}</> : <span className="rt-muted">–</span>}</td>
                <td className="rt-scan-open">{step && <button type="button" className="link-button" onClick={() => { void seen(alert.ids); onOpenCall(step.trace, step.call); }}>
                  Open the step <ArrowRight size={11} /></button>}</td>
              </tr>;
            })}</tbody>
          </table></div>
        </>}
      </>}

      {tab === 'activity' && <SandboxActivity box={box} stepFor={stepFor} onOpenCall={onOpenCall} />}
    </>}
  </section>;
}
