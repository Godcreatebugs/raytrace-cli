'use client';

// The shell: three sections, each answering one question, linked to each other.
//   Prompts     what was asked and what came back (all prompts, by day)
//   Tool calls  how the agent got there, for one prompt
//   Context     what the model had in context when it answered
// Which section and prompt are open lives in the URL, so every cross-link is a
// real link and Back works.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Layers, MessagesSquare, Waypoints, Wrench } from 'lucide-react';
import { type Trace } from './types';
import { ContextView } from './context-view';
import { PromptsView } from './prompts-view';
import { ToolCallsView } from './tool-calls-view';
import { ResizeHandle } from './resize-handle';

const PROXY_BASE = '';
type View = 'prompts' | 'calls' | 'context';
type Place = { view: View; trace: string; call: string | null; step: string | null };
const VIEWS: View[] = ['prompts', 'calls', 'context'];

function readPlace(): Place {
  const query = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  // ?view=lab is what links from before the Lab became Context used.
  const asked = query.get('view');
  const view = (asked === 'lab' ? 'context' : asked) as View | null;
  return { view: view && VIEWS.includes(view) ? view : 'prompts', trace: query.get('trace') ?? '', call: query.get('call'), step: query.get('step') };
}
function writePlace(place: Place) {
  const query = new URLSearchParams();
  if (place.view !== 'prompts') query.set('view', place.view);
  if (place.trace) query.set('trace', place.trace);
  if (place.call) query.set('call', place.call);
  if (place.step) query.set('step', place.step);
  const search = query.toString();
  window.history.pushState(null, '', search ? `?${search}` : window.location.pathname);
}

const firstLine = (text: string) => text.split('\n').find((line) => line.trim())?.trim() ?? '';
const stepKey = (step: { exchange_id?: string; output_index?: number }) => `${step.exchange_id}:${step.output_index}`;

export default function Home() {
  const [traces, setTraces] = useState<Trace[]>([]);
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [place, setPlace] = useState<Place>({ view: 'prompts', trace: '', call: null, step: null });
  const shell = useRef<HTMLElement>(null);

  useEffect(() => {
    setPlace(readPlace());
    const onPop = () => setPlace(readPlace());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = useCallback((next: Partial<Place>) => {
    setPlace((prev) => { const value = { ...prev, call: null, step: null, ...next }; writePlace(value); return value; });
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
        const response = await fetch(`${PROXY_BASE}/raytace/traces?scope=history`, { cache: 'no-store', headers: version ? { 'if-none-match': version } : {} });
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

  const trace = traces.find((item) => item.id === place.trace);

  const nav: { view: View; label: string; icon: typeof Wrench }[] = [
    { view: 'prompts', label: 'Prompts', icon: MessagesSquare },
    { view: 'calls', label: 'Tool calls', icon: Wrench },
    { view: 'context', label: 'Context', icon: Layers },
  ];

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
      <nav className="nav-destinations">
        {nav.map(({ view, label, icon: Icon }) => <button key={view} type="button" className={`nav-item ${place.view === view ? 'active' : ''}`}
          onClick={() => go({ view, trace: place.trace })}><Icon size={16} /> {label}</button>)}
      </nav>
      {trace && <div className="rt-viewing">
        <span className="workspace-label">VIEWING</span>
        <button type="button" onClick={() => go({ view: 'prompts', trace: trace.id })} title={trace.title}>{firstLine(trace.title)}</button>
        <small>{new Date(trace.startedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</small>
      </div>}
      {/* Nothing is known until the first load answers (the whole history,
          which can take a second): neither connected nor offline yet. */}
      <div className="nav-bottom"><span className={`status ${!loaded ? 'pending' : connected ? '' : 'offline'}`}><i />{!loaded ? 'CONNECTING…' : connected ? 'CONNECTED' : 'PROXY OFFLINE'}</span></div>
      <ResizeHandle target={shell} variable="--nav-width" storageKey="raytace.nav-width" min={180} max={480} label="Navigation width" />
    </aside>

    {place.view === 'prompts' && <PromptsView traces={traces} loaded={loaded} selectedId={place.trace}
      onSelect={(id) => go({ view: 'prompts', trace: id })}
      onOpen={(view, id) => go({ view, trace: id })} />}

    {place.view === 'calls' && (trace ? <ToolCallsView key={trace.id} trace={trace} traces={traces} focusCall={place.call}
      onOpenContext={(selected) => go({ view: 'context', trace: trace.id, step: stepKey(selected) })} /> : noPrompt())}

    {place.view === 'context' && (trace ? <ContextView key={trace.id} trace={trace} stepKey={place.step}
      onStep={(key) => go({ view: 'context', trace: trace.id, step: key })} /> : noPrompt())}
  </main>;
}
