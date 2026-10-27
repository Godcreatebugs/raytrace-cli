'use client';

// What the sandbox's kernel layer saw the agent do (worker/gvisor/engine.py),
// as the control plane collected it: the connections it made, the packages it
// installed, and what happened to the files its owner restricted or watches.
// Facts, not events: a row is one thing one step did, with a count, and it
// says what it rests on. Nothing here is the agent's own report.
import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { type Activity, type Certainty, type FileFact, type NetworkFact, type PackageFact, loadActivity } from './file-scan';

type Step = { trace: string; call: string } | null;

const EFFECT_WORDS: Record<FileFact['effect'], string> = {
  read: 'Read', created: 'Created', changed: 'Changed', emptied: 'Emptied', appended: 'Appended to', deleted: 'Deleted', renamed: 'Renamed',
  permissions_changed: 'Permissions changed', attempted: 'Refused', opened_for_writing: 'Opened for writing, not changed',
};
const INTENT_WORDS: Record<string, string> = { read: 'a read', write: 'a write', delete: 'a delete', rename: 'a rename', permissions: 'a permission change' };
const CERTAINTY_WORDS: Record<Certainty, [string, string]> = {
  confirmed: ['confirmed', 'The kernel saw the call, and the file shows its effect.'],
  attempted: ['refused', 'The kernel refused the call. Nothing changed.'],
  possible: ['possible', 'The file was opened for writing and is as it was.'],
  one_of: ['one of several', 'More than one process made such a call at that moment; this is the likeliest.'],
  unattributed: ['no call seen', 'The file changed on disk and the kernel reported no call for it: events may have been lost, or it was changed another way.'],
};
const OUTCOME_WORDS: Record<string, [string, string]> = {
  connected: ['connected', 'The connection was made.'],
  attempted: ['attempted', 'The program did not wait for the result, so the call says only that it tried.'],
  refused_by_policy: ['refused by the firewall', 'A private address: the sandbox firewall rejects it, whatever the call returned.'],
  failed: ['failed', 'The connection was not made.'],
  listening: ['listening', 'The program accepts connections here. Nothing outside the sandbox network is routed to it.'],
};
const when = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const times = (count: number) => (count > 1 ? ` ×${count.toLocaleString()}` : '');
const short = (hash?: string | null) => (hash ? hash.slice(0, 8) : null);

/** What a file fact rests on, for a row's hover. */
function basisOf(fact: FileFact) {
  const basis = fact.basis ?? {};
  const before = short(basis.before?.sha256); const after = short(basis.after?.sha256);
  return [
    basis.syscall && `Call: ${basis.syscall}${basis.errno ? ` (${basis.errno})` : ''}`,
    basis.watcher?.length && `Seen on disk: ${basis.watcher.join(', ')}`,
    before && after && before !== after && `SHA-256 ${before}… → ${after}…`,
    basis.path_from && { argv: 'The file is named in the program\'s own arguments.', argv_folder: 'A folder in the program\'s arguments holds the file.',
      argv_text: 'The file\'s name appears in the program\'s arguments.' }[basis.path_from],
    basis.candidates?.length && `Also at that moment: ${basis.candidates.map((other) => other.process ?? `pid ${other.pid}`).join(', ')}`,
    basis.note,
  ].filter(Boolean).join('\n');
}

function Who({ fact, step, onOpenCall }: { fact: { process: string | null; command: string | null; pid: number | null }; step: Step; onOpenCall: (traceId: string, callId: string) => void }) {
  return <>
    <td title={fact.command ?? undefined}>{fact.process ?? <span className="rt-muted">–</span>}</td>
    <td className="rt-scan-open">{step && <button type="button" className="link-button" onClick={() => onOpenCall(step.trace, step.call)}>Open the step <ArrowRight size={11} /></button>}</td>
  </>;
}

function Outcomes({ fact }: { fact: NetworkFact }) {
  return <>{Object.entries(fact.outcomes).map(([name, count], index) => <span key={name} title={OUTCOME_WORDS[name]?.[1]}
    className={name === 'refused_by_policy' || name === 'failed' ? 'exec-fail' : undefined}>{index ? ' · ' : ''}{OUTCOME_WORDS[name]?.[0] ?? name}{times(count)}</span>)}
    {fact.errno && <span className="rt-muted"> ({fact.errno})</span>}</>;
}

function Packages({ fact }: { fact: PackageFact }) {
  const [all, setAll] = useState(false);
  const shown = all ? fact.packages : fact.packages.slice(0, 12);
  return <>
    {shown.map((item) => <code key={`${item.name}@${item.version}`} title={item.source} className="rt-package">{item.name}@{item.version}</code>)}
    {fact.packages.length > shown.length && <button type="button" className="link-button" onClick={() => setAll(true)}>and {(fact.total - shown.length).toLocaleString()} more</button>}
    {all && fact.total > fact.packages.length && <span className="rt-muted"> and {(fact.total - fact.packages.length).toLocaleString()} not listed</span>}
  </>;
}

export function SandboxActivity({ box, stepFor, onOpenCall }: {
  box: string;
  /** The step a tool call id belongs to, when its prompt is in the loaded history. */
  stepFor: (callId: string | null) => Step;
  onOpenCall: (traceId: string, callId: string) => void;
}) {
  const [data, setData] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null); setError(null);
    let closed = false; let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const found = await loadActivity(box); if (!closed) { setData(found); setError(null); } }
      catch (failed) { if (!closed) setError(failed instanceof Error ? failed.message : 'Sandbox activity could not be loaded.'); }
      if (!closed) timer = setTimeout(load, 10000);
    };
    void load(); return () => { closed = true; clearTimeout(timer); };
  }, [box]);

  if (error && !data) return <p role="alert" className="rt-problem">{error}</p>;
  if (!data) return <p className="rt-empty">Loading…</p>;
  const reached = new Set(data.network.map((fact) => fact.host).filter(Boolean));
  const unreached = data.lookups.filter((fact) => !reached.has(fact.name));
  const nothing = !data.network.length && !data.packages.length && !data.files.length && !data.lookups.length && !data.bulk.length && !data.identity.length;
  const gaps = [...data.network, ...data.files, ...data.packages].some((fact) => fact.coverage === 'gaps');
  if (nothing) return <p className="rt-empty">Nothing recorded yet. The kernel layer of the sandbox reports every connection the agent makes, the packages it installs,
    and what happens to files marked Report or Restrict. A sandbox started before this was turned on reports once it is stopped and started again.</p>;

  return <>
    {gaps && <p className="rt-problem">Some events were lost while these were recorded, so a row marked <em>gaps</em> may not be all that happened.</p>}

    <div className="rt-list-head"><span>NETWORK</span><small>{data.network.length} destination{data.network.length === 1 ? '' : 's'}{data.more.includes('network') ? ', newest shown' : ''}</small></div>
    {!data.network.length ? <p className="rt-empty">No connection left the sandbox.</p> :
      <div className="rt-table-wrap"><table className="rt-table rt-scan">
        <thead><tr><th>Last</th><th>Destination</th><th>Result</th><th>Program</th><th>Step</th></tr></thead>
        <tbody>{data.network.map((fact) => <tr key={fact.id}>
          <td><time>{when(fact.at)}</time></td>
          <td><code>{fact.host ?? fact.ip}:{fact.port}</code>{fact.host && <span className="rt-muted"
            title={`The address${(fact.addresses?.length ?? 1) > 1 ? 'es' : ''} the program connected to. The name is the lookup that answered with ${(fact.addresses?.length ?? 1) > 1 ? 'them' : 'it'}.\n${(fact.addresses ?? [fact.ip]).join('\n')}`}>
            {' '}{fact.ip}{(fact.addresses?.length ?? 1) > 1 ? ` and ${fact.addresses!.length - 1} more` : ''}</span>}
            {fact.coverage === 'gaps' && <span className="rt-flag" title="Events were lost about then.">gaps</span>}</td>
          <td><Outcomes fact={fact} /></td>
          <Who fact={fact} step={stepFor(fact.call_id)} onOpenCall={onOpenCall} />
        </tr>)}</tbody>
      </table></div>}
    {unreached.length > 0 && <p className="rt-foot">Looked up, with no connection seen: {unreached.slice(0, 40).map((fact, index) =>
      <span key={fact.id} title={fact.failed ? `The lookup failed: ${fact.failed}` : fact.addresses.join(', ')}>{index ? ', ' : ''}<code>{fact.name}</code>{fact.failed ? ` (${fact.failed})` : ''}</span>)}
      {unreached.length > 40 ? ` and ${unreached.length - 40} more` : ''}.</p>}

    <div className="rt-list-head"><span>PACKAGES INSTALLED</span></div>
    {!data.packages.length ? <p className="rt-empty">No package manager left anything new.</p> :
      <div className="rt-table-wrap"><table className="rt-table rt-scan">
        <thead><tr><th>When</th><th>Manager</th><th>Packages</th><th>Basis</th><th>Program</th><th>Step</th></tr></thead>
        <tbody>{data.packages.map((fact) => <tr key={fact.id}>
          <td><time>{when(fact.at)}</time></td>
          <td>{fact.manager} <span className="rt-muted">· {fact.total.toLocaleString()}</span></td>
          <td className="rt-scan-why"><Packages fact={fact} /></td>
          <td title={fact.certainty === 'corroborated' ? 'Read from the package manager\'s own records in the sandbox, and a package registry was reached about then.'
            : 'Read from the package manager\'s own records in the sandbox, which the agent can write. No registry connection was seen with it.'}>
            {fact.certainty === 'corroborated' ? 'records, registry reached' : 'records only'}</td>
          <Who fact={fact} step={stepFor(fact.call_id)} onOpenCall={onOpenCall} />
        </tr>)}</tbody>
      </table></div>}

    <div className="rt-list-head"><span>FILES, AS THE KERNEL SAW THEM</span><small>files marked Report or Restrict, and new sensitive ones</small></div>
    {!data.files.length ? <p className="rt-empty">Nothing happened to a file marked Report or Restrict.</p> :
      <div className="rt-table-wrap"><table className="rt-table rt-scan">
        <thead><tr><th>When</th><th>File</th><th>What happened</th><th>How sure</th><th>Program</th><th>Step</th></tr></thead>
        <tbody>{data.files.map((fact) => <tr key={fact.id} className={fact.effect === 'attempted' ? 'rt-fact-refused' : undefined} title={basisOf(fact)}>
          <td><time>{when(fact.at)}</time></td>
          <td>{fact.path ? <code>{fact.path}</code> : <span className="rt-muted" title="gVisor reports this call by number, without its path.">file not reported</span>}
            {fact.guard && <span className="rt-flag">{fact.guard}</span>}</td>
          <td>{EFFECT_WORDS[fact.effect] ?? fact.effect}{fact.effect === 'attempted' && fact.intent ? `: ${INTENT_WORDS[fact.intent] ?? fact.intent}` : ''}
            {fact.to ? <> to <code>{fact.to}</code></> : null}{times(fact.count)}
            {fact.basis?.errno && <span className="rt-muted"> ({fact.basis.errno})</span>}</td>
          <td title={CERTAINTY_WORDS[fact.certainty]?.[1]}>{CERTAINTY_WORDS[fact.certainty]?.[0] ?? fact.certainty}</td>
          <Who fact={fact} step={stepFor(fact.call_id)} onOpenCall={onOpenCall} />
        </tr>)}</tbody>
      </table></div>}

    {data.bulk.length > 0 && <>
      <div className="rt-list-head"><span>BULK FILE ACCESS</span><small>counted, not kept</small></div>
      <ul className="rt-foot rt-bulk">{data.bulk.slice(0, 20).map((fact) => {
        const step = stepFor(fact.call_id);
        return <li key={fact.id}>{when(fact.at)}: {fact.process ?? 'a step'} opened {fact.opens.toLocaleString()} files
          ({Object.entries(fact.folders).map(([folder, count]) => `${count.toLocaleString()} under ${folder}`).join(', ')}){' '}
          {step && <button type="button" className="link-button" onClick={() => onOpenCall(step.trace, step.call)}>Open the step <ArrowRight size={11} /></button>}</li>;
      })}</ul>
    </>}
    {data.identity.length > 0 && <p className="rt-problem">A program asked to change its user or group id: {data.identity.map((fact) =>
      `${fact.basis?.syscall ?? 'setid'}(${fact.ids.join(', ')}) by ${fact.process ?? 'a process'}, ${fact.effect === 'changed' ? 'allowed' : `refused${fact.basis?.errno ? ` (${fact.basis.errno})` : ''}`}`).join('; ')}.</p>}

    <p className="rt-foot">Seen by the kernel layer of the sandbox and its host, not reported by the agent. An address is what a program connected to; the name beside it is the
      lookup that answered with it. HTTPS contents are not read. A file that was read is one opened for reading. A file not marked Report or Restrict is counted, not listed.</p>
  </>;
}

export type FactChip = { key: string; text: string; title: string; fail?: boolean };

/** Each fact as a few words, by the tool call and by the process it belongs
 * to, for marking the commands that did them (Sandbox evidence). */
export function factChips(activity: Activity | null) {
  const byCall = new Map<string, FactChip[]>();
  const byProcess = new Map<string, FactChip[]>();
  const add = (fact: { call_id: string | null; pid: number | null; process_start_ns: string | null }, chip: FactChip) => {
    if (fact.call_id) byCall.set(fact.call_id, [...(byCall.get(fact.call_id) ?? []), chip]);
    if (fact.pid != null) { const key = `${fact.pid}:${fact.process_start_ns ?? ''}`; byProcess.set(key, [...(byProcess.get(key) ?? []), chip]); }
  };
  if (!activity) return { byCall, byProcess };
  for (const fact of activity.network) {
    const refused = !!fact.outcomes.refused_by_policy;
    add(fact, { key: fact.id, fail: refused, text: `${refused ? 'refused ' : fact.effect === 'listen' ? 'listens on ' : '→ '}${fact.host ?? fact.ip}:${fact.port}${times(fact.count)}`,
      title: Object.entries(fact.outcomes).map(([name, count]) => `${OUTCOME_WORDS[name]?.[0] ?? name}${times(count)}`).join(', ') });
  }
  for (const fact of activity.packages) {
    add(fact, { key: fact.id, text: `${fact.manager}: ${fact.total.toLocaleString()} package${fact.total === 1 ? '' : 's'}`,
      title: fact.packages.slice(0, 20).map((item) => `${item.name}@${item.version}`).join(', ') });
  }
  for (const fact of activity.files) {
    if (!fact.path) continue;
    add(fact, { key: fact.id, fail: fact.effect === 'attempted', text: `${fact.path.split('/').pop()} ${(EFFECT_WORDS[fact.effect] ?? fact.effect).toLowerCase()}`,
      title: `${fact.path}\n${CERTAINTY_WORDS[fact.certainty]?.[1] ?? ''}\n${basisOf(fact)}` });
  }
  return { byCall, byProcess };
}
