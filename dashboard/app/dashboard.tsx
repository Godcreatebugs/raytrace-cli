'use client';

// The shell: six sections, each answering one question, linked to each other.
//   Prompts     what was asked and what came back (all prompts, by day)
//   Story       the summary layer: a timeline of the consequential steps of
//               one prompt, the most consequential command singled out, and
//               the story of why it was proposed (from the record alone)
//   Sandboxes   where agents ran: each sandbox, its VM, and what was asked in it
//   Initial scan  how risky each file of a sandbox's project is to change, and
//               the alerts when the agent changed one its owner watches
//   Tool calls  how the agent got there, for one prompt
//   Changes     what the prompt left different, and a patch to take it home
//   Sandbox     what actually ran, for one prompt
//   Context     what the model had in context when it answered
//   Chain of thought  why each tool call was made (sandbox prompts only)
//   Playground  rerun it from any step with part of it changed, and compare
// Which section and prompt are open lives in the URL, so every cross-link is a
// real link and Back works.
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Boxes, Brain, FileDiff, GitFork, Layers, MessagesSquare, Milestone, ScanSearch, Search as SearchIcon, ShieldCheck, Waypoints, Wrench } from 'lucide-react';
import { type Trace } from './types';
import { ChainOfThoughtView } from './chain-of-thought-view';
import { ContextView } from './context-view';
import { loadAlerts } from './file-scan';
import { InitialScanView } from './initial-scan-view';
import { PlaygroundView } from './playground-view';
import { PromptsView } from './prompts-view';
import { SearchView } from './search-view';
import { ToolCallsView } from './tool-calls-view';
import { StoryView } from './story-view';
import { ChangesView } from './changes-view';
import { SandboxView } from './sandbox-view';
import { SandboxesView } from './sandboxes-view';
import { ResizeHandle } from './resize-handle';
import { api } from './api';
import { setTheme, useTheme } from './theme';

export type View = 'prompts' | 'search' | 'story' | 'sandboxes' | 'scan' | 'calls' | 'changes' | 'sandbox' | 'context' | 'thought' | 'playground';
type Place = { view: View; trace: string; call: string | null; step: string | null; box: string; q: string };
export const VIEWS: View[] = ['prompts', 'search', 'story', 'sandboxes', 'scan', 'calls', 'changes', 'sandbox', 'context', 'thought', 'playground'];

function readPlace(views: View[]): Place {
  const query = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  // ?view=lab is what links from before the Lab became Context used.
  const asked = query.get('view');
  const view = (asked === 'lab' ? 'context' : asked) as View | null;
  return { view: view && views.includes(view) ? view : 'prompts', trace: query.get('trace') ?? '', call: query.get('call'), step: query.get('step'), box: query.get('box') ?? '', q: query.get('q') ?? '' };
}
function writePlace(place: Place) {
  const query = new URLSearchParams();
  if (place.view !== 'prompts') query.set('view', place.view);
  if (place.trace) query.set('trace', place.trace);
  if (place.call) query.set('call', place.call);
  if (place.step) query.set('step', place.step);
  if (place.box) query.set('box', place.box);
  if (place.view === 'search' && place.q) query.set('q', place.q);
  const search = query.toString();
  window.history.pushState(null, '', search ? `?${search}` : window.location.pathname);
}

const firstLine = (text: string) => text.split('\n').find((line) => line.trim())?.trim() ?? '';
const stepKey = (step: { exchange_id?: string; output_index?: number }) => `${step.exchange_id}:${step.output_index}`;

/** The dashboard: the `views` sections in the navigation (all of them
 * locally; the hosted dashboard shows those the cloud serves), `offline` what
 * the status says when data cannot be loaded, `footer` anything to show at
 * the bottom of the navigation. */
export function Dashboard({ views = VIEWS, offline = 'PROXY OFFLINE', footer = null }: { views?: View[]; offline?: string; footer?: ReactNode }) {
  const shows = (view: View) => views.includes(view);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [place, setPlace] = useState<Place>({ view: 'prompts', trace: '', call: null, step: null, box: '', q: '' });
  const [navSearch, setNavSearch] = useState('');
  const shell = useRef<HTMLElement>(null);
  const theme = useTheme();

  useEffect(() => {
    setPlace(readPlace(views));
    const onPop = () => setPlace(readPlace(views));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [views]);
  const go = useCallback((next: Partial<Place>) => {
    setPlace((prev) => { const value = { ...prev, call: null, step: null, box: '', q: '', ...next }; writePlace(value); return value; });
  }, []);

  // Every captured prompt, not only the latest session: the activity graph
  // and the prompt list span the whole history.
  useEffect(() => {
    let closed = false; let timer: ReturnType<typeof setTimeout>;
    // The proxy answers 304 when nothing changed since the version we hold,
    // so an idle poll moves no data and re-renders nothing.
    let version = '';
    const load = async () => {
      try {
        const response = await api().fetch('/raytace/traces?scope=history', { cache: 'no-store', headers: version ? { 'if-none-match': version } : {} });
        if (response.status === 304) { if (!closed) setConnected(true); }
        else {
          if (!response.ok) throw new Error('Proxy unavailable');
          const data = await response.json() as { traces: Trace[] };
          version = response.headers.get('etag') ?? '';
          if (!closed) { setTraces(data.traces || []); setConnected(true); }
        }
      } catch { if (!closed) setConnected(false); }
      if (!closed) { setLoaded(true); timer = setTimeout(load, 5000); }
    };
    void load(); return () => { closed = true; clearTimeout(timer); };
  }, []);

  // Changes to watched files nobody has looked at yet, counted beside Initial scan.
  const [unseen, setUnseen] = useState(0);
  const [alertsRead, setAlertsRead] = useState(0);
  const watching = views.includes('scan');
  useEffect(() => {
    if (!watching) return;
    let closed = false; let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const found = await loadAlerts(); if (!closed) setUnseen(found.unseen); } catch { /* the count keeps what it had */ }
      if (!closed) timer = setTimeout(load, 10000);
    };
    void load(); return () => { closed = true; clearTimeout(timer); };
  }, [watching, alertsRead]);

  const trace = traces.find((item) => item.id === place.trace);

  const nav: { view: View; label: string; icon: typeof Wrench }[] = ([
    { view: 'prompts', label: 'Prompts', icon: MessagesSquare },
    { view: 'search', label: 'Search', icon: SearchIcon },
    { view: 'story', label: 'Story', icon: Milestone },
    { view: 'sandboxes', label: 'Sandboxes', icon: Boxes },
    { view: 'scan', label: 'Initial scan', icon: ScanSearch },
    { view: 'calls', label: 'Tool calls', icon: Wrench },
    { view: 'changes', label: 'Changes', icon: FileDiff },
    { view: 'sandbox', label: 'Sandbox evidence', icon: ShieldCheck },
    { view: 'context', label: 'Context', icon: Layers },
    { view: 'thought', label: 'Chain of thought', icon: Brain },
    { view: 'playground', label: 'Playground', icon: GitFork },
  ] as { view: View; label: string; icon: typeof Wrench }[]).filter((item) => shows(item.view));

  function noPrompt() {
    if (!loaded && place.trace) return <section className="rt-view"><p className="rt-empty">Loading…</p></section>;
    return <section className="rt-view"><p className="rt-empty">
      {loaded && place.trace && !trace ? 'That prompt is no longer in the loaded history.' : 'Choose a prompt first.'}{' '}
      <button type="button" className="link-button" onClick={() => go({ view: 'prompts' })}>Go to Prompts</button>
    </p></section>;
  }

  return <main className="rt-shell" ref={shell}>
    <aside className="nav rt-nav">
      <div className="brand"><Waypoints size={22} /> RayTrace</div>
      {shows('search') && <form className="rt-nav-search" onSubmit={(event) => { event.preventDefault(); go({ view: 'search', q: navSearch }); }}>
        <SearchIcon size={13} />
        <input value={navSearch} onChange={(event) => setNavSearch(event.target.value)}
          placeholder="Search what agents did…" aria-label="Search agent activity" spellCheck={false} />
      </form>}
      <nav className="nav-destinations">
        {nav.map(({ view, label, icon: Icon }) => <button key={view} type="button" className={`nav-item ${place.view === view ? 'active' : ''}`}
          onClick={() => go({ view, trace: place.trace, ...(view === 'scan' ? { box: place.box || trace?.sandboxId || '' } : {}) })}><Icon size={16} /> {label}
          {view === 'scan' && unseen > 0 && <span className="rt-count" title={`${unseen} unseen alert${unseen === 1 ? '' : 's'}`}>{unseen}</span>}</button>)}
      </nav>
      {trace && <div className="rt-viewing">
        <span className="workspace-label">VIEWING</span>
        <button type="button" onClick={() => go({ view: 'prompts', trace: trace.id })} title={trace.title}>{firstLine(trace.title)}</button>
        <small>{new Date(trace.startedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</small>
      </div>}
      {/* Nothing is known until the first load answers (the whole history,
          which can take a second): neither connected nor offline yet. */}
      <div className="nav-bottom"><div className="nav-status"><span className={`status ${!loaded ? 'pending' : connected ? '' : 'offline'}`}><i />{!loaded ? 'CONNECTING…' : connected ? 'CONNECTED' : offline}</span>
        <button type="button" className="theme-toggle" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} aria-pressed={theme === 'dark'}
          aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}>◐</button></div>{footer}</div>
      <ResizeHandle target={shell} variable="--nav-width" storageKey="raytace.nav-width" min={180} max={480} label="Navigation width" />
    </aside>

    {place.view === 'prompts' && shows('prompts') && <PromptsView traces={traces.filter((item) => !item.forkId)} loaded={loaded} selectedId={place.trace}
      onSelect={(id) => go({ view: 'prompts', trace: id })}
      onOpen={(view, id) => go({ view, trace: id })} onOpenStep={(id, callId) => go({ view: 'calls', trace: id, call: callId })} canOpen={shows} />}

    {place.view === 'search' && shows('search') && <SearchView key={place.q} initialQuery={place.q}
      onQuery={(q) => go({ view: 'search', trace: place.trace, q })}
      onOpenCall={(traceId, callId) => go({ view: 'calls', trace: traceId, call: callId })}
      onOpenTrace={(traceId) => go({ view: 'prompts', trace: traceId })}
      onOpenSandbox={shows('sandbox') ? (traceId, callId) => go({ view: 'sandbox', trace: traceId, call: callId }) : undefined} />}

    {place.view === 'story' && shows('story') && (trace ? <StoryView key={trace.id} trace={trace} focusCall={place.call}
      onSelect={(callId) => go({ view: 'story', trace: trace.id, call: callId })}
      onOpenCall={(callId) => go({ view: 'calls', trace: trace.id, call: callId })}
      onOpenThought={shows('thought') ? (callId) => go({ view: 'thought', trace: trace.id, call: callId }) : undefined}
      onOpenSandbox={shows('sandbox') ? (callId) => go({ view: 'sandbox', trace: trace.id, call: callId }) : undefined} /> : noPrompt())}

    {place.view === 'sandboxes' && shows('sandboxes') && <SandboxesView traces={traces} selectedId={place.box}
      onSelect={(id) => go({ view: 'sandboxes', box: id })}
      onOpenTrace={(id) => go({ view: 'calls', trace: id })}
      onOpenScan={shows('scan') ? (id) => go({ view: 'scan', trace: place.trace, box: id }) : undefined} />}

    {place.view === 'scan' && shows('scan') && <InitialScanView box={place.box} traces={traces}
      onSelect={(id) => go({ view: 'scan', trace: place.trace, box: id })}
      onOpenCall={(traceId, callId) => go({ view: 'calls', trace: traceId, call: callId })}
      onAlertsSeen={() => setAlertsRead((count) => count + 1)} />}

    {place.view === 'calls' && shows('calls') && (trace ? <ToolCallsView key={trace.id} trace={trace} traces={traces} focusCall={place.call}
      onOpenSandbox={shows('sandbox') ? (callId) => go({ view: 'sandbox', trace: trace.id, call: callId ?? null }) : undefined}
      onOpenContext={shows('context') ? (selected) => go({ view: 'context', trace: trace.id, step: stepKey(selected) }) : undefined}
      onOpenThought={shows('thought') ? (callId) => go({ view: 'thought', trace: trace.id, call: callId }) : undefined}
      onOpenPlayground={shows('playground') ? (exchangeId, removeCall) => go({ view: 'playground', trace: trace.id, step: exchangeId, call: removeCall ?? null }) : undefined} /> : noPrompt())}

    {place.view === 'changes' && shows('changes') && (trace ? <ChangesView key={trace.id} trace={trace}
      onOpenCall={shows('calls') ? (callId) => go({ view: 'calls', trace: trace.id, call: callId }) : undefined} /> : noPrompt())}

    {place.view === 'sandbox' && shows('sandbox') && (trace ? <SandboxView key={trace.id} trace={trace} focusCall={place.call}
      onOpenCall={(callId) => go({ view: 'calls', trace: trace.id, call: callId ?? null })} /> : noPrompt())}

    {place.view === 'playground' && shows('playground') && (trace ? <PlaygroundView key={`${trace.id}:${place.step ?? ''}`} trace={trace} stepId={place.step} removeCall={place.call}
      forkTraces={traces.filter((item) => item.forkId)}
      onStep={(exchangeId) => go({ view: 'playground', trace: trace.id, step: exchangeId })}
      onOpenTrace={(traceId) => go({ view: 'calls', trace: traceId })} /> : noPrompt())}

    {place.view === 'context' && shows('context') && (trace ? <ContextView key={trace.id} trace={trace} stepKey={place.step}
      onStep={(key) => go({ view: 'context', trace: trace.id, step: key })}
      onRerunWithout={shows('playground') ? (exchangeId, callId) => go({ view: 'playground', trace: trace.id, step: exchangeId, call: callId }) : undefined} /> : noPrompt())}

    {place.view === 'thought' && shows('thought') && (trace ? <ChainOfThoughtView key={trace.id} trace={trace} focusCall={place.call} /> : noPrompt())}
  </main>;
}
