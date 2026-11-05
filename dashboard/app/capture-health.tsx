'use client';
import {useEffect,useState} from 'react';
import type {CaptureHealth} from './types';
const labels:Record<string,string>={reporting:'Reporting',catching_up:'Catching up',not_reporting:'Not reporting',ended:'Stream ended',unknown:'Unknown',not_applicable:'No sandbox recording',gaps_detected:'Gaps detected',no_known_gaps:'No gaps reported'};
export function CaptureHealthStatus({health}:{health?:CaptureHealth}) {
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),5000);return()=>clearInterval(timer);},[]);
  const live=(health?.live==='reporting'||health?.live==='catching_up') && health.lastHeartbeatAt && now-health.lastHeartbeatAt>15000 ? 'not_reporting' : health?.live??'unknown';
  const disconnect = health?.issues.find(issue => issue.reason === 'collector_disconnected');
  return <div className="capture-health" role="status" aria-live="polite">
    <strong>Recording: {labels[health?.history??'unknown']}</strong>{' · '}
    <span>Now: {labels[live]}</span>
    <small> Selected recorded events; completeness is not certified.</small>
    {disconnect && <p>Recorder disconnected at {new Date(disconnect.at).toLocaleTimeString()} during this run. Commands may be missing from the recording.</p>}
    {health?.capabilities && (!health.capabilities.files||!health.capabilities.network)&&<small> File or network recording is unavailable for part of this capture.</small>}
    {!!health?.issues.length && <details><summary>Recording issues ({health.issues.length})</summary><ul>{health.issues.map((issue,i)=><li key={i}>{issue.reason} · {new Date(issue.at).toLocaleString()}</li>)}</ul></details>}
  </div>;
}
