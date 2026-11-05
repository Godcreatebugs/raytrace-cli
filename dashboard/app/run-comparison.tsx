'use client';
import {CaptureHealthStatus} from './capture-health';
import { useEffect, useState } from 'react';
import { api } from './api';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { actions, alignActions, metrics, answer, contextText, firstDifference, comparisonLimits, type ComparisonTrace } from './run-comparison-data';
function TextDiff({ title, a, b }: { title: string; a: string; b: string }) {
  const left=new Set(a.split('\n')),right=new Set(b.split('\n'));
  return <details className="compare-detail"><summary>{title} · {a===b ? 'Same' : 'Different'}</summary><p>Highlighted lines occur only on that side.</p><details><summary>How this is measured</summary><p>Line order is preserved; this is not a word-level diff.</p></details><div className="compare-pair">{[a,b].map((text,side)=><div key={side}><h4>{side ? 'Comparison' : 'Baseline'}</h4><pre>{text.split('\n').map((line,i)=><span className={!(side ? left : right).has(line) ? 'diff-line' : ''} key={i}>{line || ' '} {'\n'}</span>)}</pre></div>)}</div></details>;
}
function Results({ a,b }: {a: ComparisonTrace;b: ComparisonTrace}) {
  const [ai,setAi]=useState(''),[bi,setBi]=useState('');
  const exchanges=(t:ComparisonTrace)=>t.events.filter(e=>e.title==='Context assembled').map(e=>{try{return JSON.parse(e.raw).exchange_id as string;}catch{return '';}}).filter(Boolean);
  const ax=exchanges(a),bx=exchanges(b),ae=ax.includes(ai)?ai:ax[0]??'',be=bx.includes(bi)?bi:bx[0]??'';
  const difference=firstDifference(a,b), limits=comparisonLimits(a,b);
  const ma=metrics(a),mb=metrics(b); const aa=actions(a),bb=actions(b); const aligned=alignActions(aa,bb);
  const failedIndex = bb.findIndex(call => call.reportedFailure || [call.observedExit, call.reportedExit].some(code => code != null && code !== 0));
  const failedCall = bb[failedIndex];
  const format=(v:number|null,unit:string)=>v===null?'Unavailable':unit==='$'?`$${v.toFixed(6)}`:unit==='s'?`${(v/1000).toFixed(2)} s`:v.toLocaleString();
  const fields=[['cost','Reported cost','$'],['span','Elapsed time','s'],['time','Summed request time','s'],['input','Input tokens',''],['output','Output tokens',''],['calls','API calls',''],['tools','Proposed tool calls','']] as const;
  return <><section aria-label="First recorded difference"><h3>First recorded difference</h3>
    <p>{difference?.summary??'No difference found in the available recording.'}</p>
    {failedCall && <section aria-label="Failed tool call"><h4>Failed tool call {failedIndex + 1}: {failedCall.name}</h4>
      {failedCall.result ? <pre>{failedCall.result}</pre> : <p>No output was captured for this call.</p>}</section>}
    <p>This is the first recorded difference. It does not establish why the run failed.</p>
    <div className="compare-pair">{[a,b].map((trace,side)=><div key={trace.id}><CaptureHealthStatus health={trace.captureHealth}/>
      <a href={`?view=calls&trace=${encodeURIComponent(trace.id)}${(side?difference?.b:difference?.a)?.callId?`&call=${encodeURIComponent((side?difference?.b:difference?.a)!.callId!)}`:''}`}>Open {side?'comparison':'baseline'} evidence</a>
      {difference && <pre>{JSON.stringify((side?difference.b:difference.a)??(side?difference.comparisonEvidence:difference.baselineEvidence),null,2)}</pre>}</div>)}</div>
    {!!limits.length&&<details open><summary>Limits of this comparison</summary><ul>{limits.map(text=><li key={text}>{text}</li>)}</ul></details>}
    </section><div className="compare-pair compare-identities">{[a,b].map((t,i)=><div key={t.id}><h3>{i?'Comparison':'Baseline'}</h3><p>{t.provider} · {[...new Set(t.requests?.map(r=>r.model) ?? [t.model])].join(', ')}</p><small>{new Date(t.startedAt).toLocaleString()}</small></div>)}</div>
    <p className="compare-notice">{a.promptRaw!==undefined&&b.promptRaw!==undefined?(a.promptRaw===b.promptRaw?'Starting prompts match.':'Starting prompts differ.'):'Full starting prompts unavailable.'}</p><details className="compare-detail"><summary>How this is measured</summary><p className="compare-note">Review captured context below before interpreting changes. Lower cost or time does not establish answer quality.</p></details>
    <div className="metrics-table"><table><thead><tr><th>Metric</th><th>Baseline</th><th>Comparison</th><th>Change (B − A)</th></tr></thead><tbody>{fields.map(([key,label,unit])=>{const x=ma[key],y=mb[key],d=x===null||y===null?null:y-x;return <tr key={key}><th>{label}</th><td>{format(x,unit)}</td><td>{format(y,unit)}</td><td>{d===null?'Unavailable':`${d>0?'+':''}${format(d,unit)}${x===0?' · % unavailable':` (${d>0?'+':''}${(d/x!*100).toFixed(1)}%)`}`}</td></tr>;})}</tbody></table></div>
    <p className="compare-note">Totals require every call to report the metric.</p><details className="compare-detail"><summary>How this is measured</summary><p className="compare-note">Elapsed time spans the first request to the last response; summed time can include overlapping calls.</p></details>
    <TextDiff title="Starting prompt" a={a.promptRaw??'Full prompt unavailable'} b={b.promptRaw??'Full prompt unavailable'}/>
    <section><h3>Execution differences</h3><p>{aligned.filter(r=>r.status==='Same').length} matching · {aligned.filter(r=>r.status==='Added').length} added · {aligned.filter(r=>r.status==='Removed').length} removed · {aligned.filter(r=>r.status==='Arguments changed').length} changed</p><p className="compare-note">Exact tool names and arguments anchor matches.</p><details className="compare-detail"><summary>How this is measured</summary><p className="compare-note">Same-name calls between anchors are paired as possible argument changes. Reordered calls may appear as added and removed. Each repeated call stays separate; carried tool results are excluded.</p></details>{aa.length*bb.length>250000&&<p>These runs exceed the alignment limit. Calls are listed separately.</p>}
    {aligned.length ? aligned.map((r,i)=><details className="compare-detail" key={i}><summary>{r.status==='Same'?'Same call; compare captured results below':r.status} · {r.a?.name??r.b?.name}</summary><div className="compare-pair"><pre>{JSON.stringify(r.a??'No call',null,2)}</pre><pre>{JSON.stringify(r.b??'No call',null,2)}</pre></div></details>):<p>No proposed tool calls captured.</p>}</section>
    <section><h3>Captured context by request</h3><div className="compare-pair">{[ax,bx].map((ids,side)=><label key={side}>{side?'Comparison request':'Baseline request'}<NativeSelect value={side?be:ae} onChange={e=>(side?setBi:setAi)(e.target.value)}>{!ids.length&&<NativeSelectOption value="">No requests</NativeSelectOption>}{ids.map((id,i)=><NativeSelectOption key={id} value={id}>Request {i+1}</NativeSelectOption>)}</NativeSelect></label>)}</div><TextDiff title="Instructions, messages, and tool results" a={contextText(a,ae)} b={contextText(b,be)}/></section>
    <TextDiff title="Last captured model answer" a={answer(a)} b={answer(b)}/>
  </>;
}
export function RunComparison({traces: liveTraces,currentId}:{traces:ComparisonTrace[];currentId:string}) {
  const [history,setHistory]=useState<ComparisonTrace[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  // The saved history carries each run's context items; the live list does not.
  const traces=[...new Map([...liveTraces,...history].map(t=>[t.id,t])).values()].sort((a,b)=>b.startedAt.localeCompare(a.startedAt));
  const [details,setDetails]=useState<ComparisonTrace[]>([]),[detailLoading,setDetailLoading]=useState(false),[detailError,setDetailError]=useState('');
  const [open,setOpen]=useState(false),[base,setBase]=useState(''),[other,setOther]=useState('');
  useEffect(()=>{
    if(!open) return;
    const controller=new AbortController(); setLoading(true);setError('');
    api().fetch('/raytace/traces?scope=history',{signal:controller.signal}).then(async response=>{
      if(!response.ok) throw new Error('Could not load saved runs. Check that the proxy is running with the latest version.');
      const data=await response.json() as {traces:ComparisonTrace[]}; if(!Array.isArray(data.traces)) throw new Error('Invalid saved-run response.');
      if(!controller.signal.aborted) setHistory(data.traces);
    }).catch(err=>{if(!controller.signal.aborted)setError(err.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[open,retry]);
  useEffect(()=>{
    if(!open||!base||!other||base===other)return;
    let ignore=false; const controller=new AbortController();
    setDetails([]);setDetailLoading(true);setDetailError('');
    const load=async()=>{
      try {
        const selected=await Promise.all([base,other].map(async id=>{
          const response=await api().fetch(`/raytace/traces?trace=${encodeURIComponent(id)}`,{signal:controller.signal,cache:'no-store'});
          if(!response.ok)throw Error('Could not load complete selected runs. Update the proxy, or retry.');
          const data=await response.json() as {traces:ComparisonTrace[]};
          const trace=data.traces?.find(t=>t.id===id);if(!trace)throw Error('Selected run was not returned.');return trace;
        }));
        if(!ignore){setDetails(selected);setDetailError('');}
      }catch(err){if(!ignore)setDetailError(err instanceof Error?err.message:String(err));}
      finally{if(!ignore){setDetailLoading(false);}}
    };
    void load();return()=>{ignore=true;controller.abort();};
  },[open,base,other,retry]);
  const withLiveHealth=(id:string)=>{const detail=details.find(t=>t.id===id);return detail?{...detail,captureHealth:liveTraces.find(t=>t.id===id)?.captureHealth??detail.captureHealth}:undefined;};
  const a=withLiveHealth(base),b=withLiveHealth(other);
  return <Sheet open={open} onOpenChange={value=>{setOpen(value);if(value){setBase(currentId||traces[0]?.id||'');setOther('');}}}><SheetTrigger className="graph-open-button">Compare runs</SheetTrigger><SheetContent className="run-compare-panel"><SheetHeader><SheetTitle>Compare runs</SheetTitle><SheetDescription>Compare saved captures. No new model calls are made.</SheetDescription></SheetHeader><div className="compare-body">{loading&&<output>Loading saved runs…</output>}{error&&<p role="alert">{error} <button className="graph-open-button" onClick={()=>setRetry(n=>n+1)}>Retry</button></p>}<p className="compare-note">Most recent 100 saved runs across sessions. Reopen to refresh history.</p><div className="compare-pair">{[base,other].map((value,i)=><label key={i}>{i?'Comparison run':'Baseline run'}<NativeSelect value={value} onChange={e=>(i?setOther:setBase)(e.target.value)}><NativeSelectOption value="">Choose a captured run</NativeSelectOption>{traces.map(t=><NativeSelectOption key={t.id} value={t.id}>{new Date(t.startedAt).toLocaleString()} · {t.model} · {t.title.slice(0,90)}</NativeSelectOption>)}</NativeSelect></label>)}</div>{detailError&&<p role="alert">{detailError}</p>}{base&&other&&<button type="button" className="graph-open-button" onClick={()=>setRetry(n=>n+1)}>Refresh selected runs</button>}{detailLoading&&<output>Loading selected runs…</output>}{loading||detailLoading ? null : traces.length<2?<p>Capture at least two runs to compare them. Try the same task with a different prompt or model.</p>:!a||!b?<p>Select two saved runs to see cost, timing, execution, context, and answer differences.</p>:a.id===b.id?<p>Choose two different runs.</p>:<Results key={`${a.id}-${b.id}`} a={a} b={b}/>}</div></SheetContent></Sheet>;
}
