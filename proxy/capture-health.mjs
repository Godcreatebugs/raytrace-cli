/** Recording health describes selected events, never certifies completeness. */
export const sourceStreamId = (sandbox, raw) => raw?.source_instance_id && raw?.source_connection_id
  ? `gvisor:${sandbox}:${raw.source_instance_id}:${raw.source_connection_id}` : `gvisor:${sandbox}`;
export function captureHealth({sessionId,streams=[],checkpoints=[],events=[],since,until,now=Date.now()}) {
  const applicable=/^rt[pf]-[a-f0-9]{32}$/.test(sessionId ?? '');
  const base={live:applicable?'unknown':'not_applicable',history:applicable?'unknown':'not_applicable',issues:[],lastHeartbeatAt:null,checkedAt:now,scope:'Selected recorded events; completeness is not certified'};
  if(!applicable) return base;
  const from=Number(since), to=Number(until);
  const latest=[...checkpoints].sort((a,b)=>(b.checked_at_ms??0)-(a.checked_at_ms??0))[0];
  const current=streams.filter(s=>s.collector_id===latest?.source_instance_id && !s.ended_ms);
  const beat=Math.max(0,...current.map(s=>Number(s.heartbeat_ms)||0));
  base.lastHeartbeatAt=beat||null;
  const described=streams.filter(s=>s.capabilities);
  base.capabilities=described.length?Object.fromEntries(['processes','files','network'].map(key=>[key,described.every(s=>s.capabilities[key]===true)])):null;
  if(latest?.imported || current.some(s=>!s.clock_measured)) base.live='unknown';
  else if(latest?.unavailable || (beat && now-beat>15000)) base.live='not_reporting';
  else if(current.length && beat && now-beat<=15000) base.live=Number(latest?.cursor)<Number(latest?.latest)?'catching_up':'reporting';
  else if(streams.some(s=>!s.ended_ms) && latest?.source_instance_id) base.live='not_reporting';
  else if(streams.length && streams.every(s=>s.ended_ms)) base.live='ended';
  if(!Number.isFinite(from)||!Number.isFinite(to)||to<from) return base;
  const markers=events.filter(e=>Number.isFinite(e.recorded_at_ms)&&e.recorded_at_ms>=from && (e.kind==='collection_gap' && Number.isFinite(e.gap_from_ms) ? e.gap_from_ms : e.recorded_at_ms)<=to);
  base.issues=markers.map(e=>({reason:e.kind,eventId:e.event_id,at:e.recorded_at_ms,dropped:e.kind==='collection_gap'?e.dropped_delta:null}));
  if(markers.some(e=>['collection_gap','collection_error'].includes(e.kind))) base.history='gaps_detected';
  else {
    const covering=streams.filter(s=>s.clock_measured && s.started_ms<=from && Math.min(s.ended_ms??Infinity,s.heartbeat_ms)>=to);
    const synced=covering.length && covering.every(s=>checkpoints.some(c=>c.source_instance_id===s.collector_id && Number(c.forwarded_through_ms)>=to));
    if(synced && !markers.some(e=>e.kind==='collector_disconnected')) base.history='no_known_gaps';
  }
  return base;
}
