import type { RequestMetric } from './request-metrics';
import type { ContextItem, CaptureHealth, CallVerification } from './types';
export type ComparisonRequest = {exchangeId:string;model:string|null;settings:unknown;instructions:unknown;tools:unknown;context:ContextItem[]};
export type ComparisonTrace = { promptRaw?:string; sandboxId?:string; endedAt?:string; captureComplete?:boolean; captureHealth?:CaptureHealth; comparisonRequests?:ComparisonRequest[]; callVerifications?:CallVerification[]; id: string; title: string; model: string; provider: string; startedAt: string; requests?: RequestMetric[]; events: { title: string; raw: string; exchange_id?: string; output_index?:number }[]; evidence: ContextItem[] };
export type Action = { name: string; args: string; exchangeId?:string; outputIndex?:number; callId?:string; result?:string; reportedExit?:number|null; reportedFailure?:boolean|null; observedExit?:number|null; ambiguous?:boolean };
function parse(raw: string) { try { return JSON.parse(raw); } catch { return {}; } }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? '';
}
export function actions(trace: ComparisonTrace): Action[] {
  return trace.events.filter(e => e.title.startsWith('Tool call:')).map(e => {
    const raw = parse(e.raw); let args = raw.arguments ?? raw.input ?? raw.function?.arguments ?? '';
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* plain arguments */ } }
    const identity = e.exchange_id && Number.isInteger(e.output_index) ? {exchangeId:e.exchange_id,outputIndex:e.output_index,callId:raw.call_id} : {};
    const results=trace.events.filter(result=>result.title.startsWith('Tool result:') && identity.exchangeId && result.exchange_id===identity.exchangeId && result.output_index===identity.outputIndex);
    const verification=trace.callVerifications?.find(v=>v.exchange_id===identity.exchangeId && v.output_index===identity.outputIndex);
    const result=results.length===1 ? parse(results[0].raw) : null;
    return { name: raw.name ?? raw.function?.name ?? e.title.slice(11), args: stable(args), ...identity,
      ...(result?{result:resultText(result.output??result.content),reportedExit:reportedExit(result),reportedFailure:typeof result.is_error==='boolean'?result.is_error:result.status==='failed'?true:null}:{}),
      ...(verification?{observedExit:verification.exit_code??null}:{}),...(results.length>1?{ambiguous:true}:{}) };
  });
}
// Exact matches anchor the sequence. Pair same-name calls only within unmatched gaps.
export function alignActions(a: Action[], b: Action[]): { a?: Action; b?: Action; status: string }[] {
  const rows: { a?: Action; b?: Action; status: string }[] = [];
  if (a.length * b.length > 250000) return [...a.map(a => ({ a, status: 'Baseline only' })), ...b.map(b => ({ b, status: 'Comparison only' }))];
  const key = (x: Action) => `${x.name}\n${x.args}`;
  const dp = Array.from({length: a.length + 1}, () => new Uint32Array(b.length + 1));
  for (let i=a.length-1;i>=0;i--) for(let j=b.length-1;j>=0;j--) dp[i][j]=key(a[i])===key(b[j]) ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j],dp[i][j+1]);
  let i=0,j=0; let left: Action[] = [], right: Action[] = [];
  function flush() {
    for (const item of left) { const match = right.findIndex(x => x.name === item.name); rows.push(match < 0 ? {a:item,status:'Removed'} : {a:item,b:right.splice(match,1)[0],status:'Arguments changed'}); }
    rows.push(...right.map(b => ({b,status:'Added'}))); left=[];right=[];
  }
  while(i<a.length || j<b.length) {
    if(i<a.length && j<b.length && key(a[i])===key(b[j])) { flush(); rows.push({a:a[i++],b:b[j++],status:'Same'}); }
    else if(i<a.length && (j===b.length || dp[i+1][j]>=dp[i][j+1])) left.push(a[i++]);
    else right.push(b[j++]);
  }
  flush(); return rows;
}
export function metrics(trace: ComparisonTrace) {
  const r=trace.requests ?? [];
  const total=(key:'cost'|'input'|'output'|'durationMs') => r.length && r.every(x => typeof x[key]==='number' && Number.isFinite(x[key])) ? r.reduce((n,x)=>n+x[key]!,0) : null;
  const starts=r.map(x=>Date.parse(x.startedAt)), ends=r.map(x=>Date.parse(x.completedAt ?? ''));
  return { cost:total('cost'), input:total('input'), output:total('output'), time:total('durationMs'), span:r.length && [...starts,...ends].every(Number.isFinite) ? Math.max(...ends)-Math.min(...starts) : null, calls:r.length || trace.events.filter(e=>e.title==='Context assembled').length, tools:actions(trace).length };
}
export function answer(trace: ComparisonTrace) {
  const event=trace.events.findLast(e=>e.title==='Model answer');
  if(!event) return 'No model answer captured.';
  const raw=parse(event.raw);
  const extract=(x: unknown): string => {
    if (typeof x === 'string') return x;
    if (Array.isArray(x)) return x.map(extract).join('\n');
    if (!x || typeof x !== 'object') return '';
    const value = x as { text?: unknown; content?: unknown };
    return typeof value.text === 'string' ? value.text : value.content ? extract(value.content) : '';
  };
  return extract(raw) || event.raw;
}
export function contextText(trace: ComparisonTrace, exchange: string) {
  // A repeated item's text is sent once, on the item content_of names.
  const byId = new Map(trace.evidence.map((e) => [e.id, e]));
  return trace.evidence.filter(e=>e.exchange_id===exchange).map((e) => {
    const full = e.content_of ? byId.get(e.content_of) ?? e : e;
    return `[${e.kind}] ${e.label}\n${full.content ?? full.preview ?? ''}${full.content === undefined ? '\n[Preview only]' : ''}`;
  }).join('\n\n') || 'No context captured.';
}

// Only recognize metadata at the start. File contents and test logs can
// themselves contain an "Output:" line or a quoted exit code.
const runnerHeader = /^(?:Chunk ID: [^\r\n]+\r?\n)?(?:Wall time: [^\r\n]+\r?\n)?Process exited with code (-?\d+)(?:\r?\n(?:Original token count: \d+\r?\n)?(?:Final output|Output):\r?\n|$)/;
function resultText(value:unknown):string {
  const text=typeof value==='string'?value:stable(value);
  return text.replace(runnerHeader,'');
}
function reportedExit(raw:Record<string,unknown>):number|null {
  if(typeof raw.exit_code==='number') return raw.exit_code;
  const output=raw.output;
  if(output && typeof output==='object' && 'exit_code' in output && typeof output.exit_code==='number') return output.exit_code;
  const code = typeof output === 'string' && runnerHeader.exec(output);
  return code ? Number(code[1]) : null;
}
export type Difference={kind:string;summary:string;a?:Action;b?:Action;step?:number;baselineEvidence?:unknown;comparisonEvidence?:unknown};
export function firstDifference(a:ComparisonTrace,b:ComparisonTrace):Difference|null {
  const promptA=a.promptRaw, promptB=b.promptRaw;
  if(promptA!==undefined && promptB!==undefined && promptA!==promptB) return {kind:'prompt',summary:'Starting prompts differ.',baselineEvidence:promptA,comparisonEvidence:promptB};
  if(a.provider!==b.provider)return {kind:'settings',summary:'Model providers differ.',baselineEvidence:a.provider,comparisonEvidence:b.provider};
  const ax=a.comparisonRequests??[],bx=b.comparisonRequests??[];
  const config=(r:ComparisonRequest)=>({model:r.model,settings:r.settings,instructions:r.instructions,tools:r.tools});
  if(ax[0] && bx[0] && stable(config(ax[0]))!==stable(config(bx[0]))) return {kind:'settings',summary:'Starting model, instructions, or tool definitions differ.',baselineEvidence:config(ax[0]),comparisonEvidence:config(bx[0])};
  const initialContext=(request:ComparisonRequest)=>request.context.map(item=>({kind:item.kind,content:item.content}));
  if(ax[0]&&bx[0]&&ax[0].context.every(i=>i.content!==undefined)&&bx[0].context.every(i=>i.content!==undefined)&&stable(initialContext(ax[0]))!==stable(initialContext(bx[0]))) return {kind:'context',summary:'Starting recorded context differs.',baselineEvidence:initialContext(ax[0]),comparisonEvidence:initialContext(bx[0])};
  const aa=actions(a),bb=actions(b);
  if(aa.length*bb.length>250000) return {kind:'unavailable',summary:'Runs exceed the alignment limit; first difference is unavailable.'};
  const aligned=alignActions(aa,bb);
  const checked=new Set<string>();
  for(const [index,row] of aligned.entries()) {
    const pair={a:row.a,b:row.b,step:index+1};
    if(row.a?.ambiguous||row.b?.ambiguous) return {kind:'unavailable',summary:'A repeated call has ambiguous result evidence.',...pair};
    const ar=ax.find(r=>r.exchangeId===row.a?.exchangeId),br=bx.find(r=>r.exchangeId===row.b?.exchangeId);
    if(ar&&br&&!checked.has(ar.exchangeId+'|'+br.exchangeId)) {
      checked.add(ar.exchangeId+'|'+br.exchangeId);
      if(stable(config(ar))!==stable(config(br))) return {kind:'settings',summary:`Request settings differ before step ${index+1}.`,...pair};
      const contents=(r:ComparisonRequest)=>r.context.map(i=>({kind:i.kind,content:i.content}));
      if(ar.context.every(i=>i.content!==undefined)&&br.context.every(i=>i.content!==undefined)&&stable(contents(ar))!==stable(contents(br))) return {kind:'context',summary:`Recorded context differs before step ${index+1}.`,...pair};
    }
    if(row.status==='Arguments changed' && (aa.filter(x=>x.name===row.a?.name).length>1 || bb.filter(x=>x.name===row.b?.name).length>1)) return {kind:'unavailable',summary:'Repeated calls cannot be paired confidently across these changed steps.',...pair};
    if(row.status!=='Same') return {kind:'call',summary:`Step ${index+1}: ${row.status.toLowerCase()}.`,...pair};
    const left=row.a!,right=row.b!;
    if(left.observedExit!=null&&right.observedExit!=null&&left.observedExit!==right.observedExit) return {kind:'exit',summary:`Step ${index+1}: command same; observed exit ${left.observedExit} → ${right.observedExit}.`,...pair};
    if(left.reportedExit!=null&&right.reportedExit!=null&&left.reportedExit!==right.reportedExit) return {kind:'result',summary:`Step ${index+1}: command same; reported exit ${left.reportedExit} → ${right.reportedExit}.`,...pair};
    if(left.reportedFailure!=null&&right.reportedFailure!=null&&left.reportedFailure!==right.reportedFailure) return {kind:'result',summary:`Step ${index+1}: the tool's reported error status changed.`,...pair};
    if(left.result!==undefined&&right.result!==undefined&&left.result!==right.result) return {kind:'result',summary:`Step ${index+1}: ${/^(?:read|read_file|readfile|read_text_file|read_multiple_files)$/i.test(left.name)?'Captured file content':'Tool output'} changed.`,...pair};
  }
  if(answer(a)!==answer(b))return {kind:'answer',summary:'Last captured model answers differ.',baselineEvidence:answer(a),comparisonEvidence:answer(b)};
  return null;
}
export function comparisonLimits(a:ComparisonTrace,b:ComparisonTrace):string[] {
  const issues:string[]=[];
  for(const [label,trace] of [['Baseline',a],['Comparison',b]] as const) {
    if(trace.captureComplete!==true)issues.push(`${label}: full run detail is unavailable or truncated.`);
    if(trace.promptRaw===undefined||!trace.comparisonRequests?.length)issues.push(`${label}: full prompt or request settings unavailable.`);
    if(trace.evidence.some(e=>e.content===undefined&&!e.content_of))issues.push(`${label}: some content is preview only.`);
    if(actions(trace).some(a=>a.result===undefined))issues.push(`${label}: some tool results were not captured.`);
    if(trace.captureHealth?.history!=='no_known_gaps')issues.push(`${label}: sandbox recording has gaps or is unverified.`);
  }
  return issues;
}
