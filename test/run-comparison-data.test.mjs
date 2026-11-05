import test from 'node:test';
import assert from 'node:assert/strict';
import { alignActions, actions, metrics, answer } from '../dashboard/app/run-comparison-data.ts';
const call=(args)=>({name:'read',args});
test('aligns inserted calls without shifting exact matches; retains repetitions',()=>{
 const rows=alignActions([call('a'),call('a'),call('b')],[call('a'),{name:'search',args:'q'},call('a'),call('b')]);
 assert.deepEqual(rows.map(r=>r.status),['Same','Added','Same','Same']);
});
test('pairs changed arguments and reports removed calls',()=>{
 assert.deepEqual(alignActions([call('a'),{name:'edit',args:'b'}],[call('c')]).map(r=>r.status),['Arguments changed','Removed']);
});
test('canonicalizes JSON arguments and excludes carried results',()=>{
 const t={events:[{title:'Tool call: read',raw:JSON.stringify({name:'read',arguments:'{"b":2,"a":1}'})},{title:'Tool result: read',raw:'{}'}]};
 assert.deepEqual(actions(t),[{name:'read',args:'{"a":1,"b":2}'}]);
});
test('missing cost does not produce a misleading partial savings comparison',()=>{
 const t={events:[],requests:[{cost:0,input:10,output:3,durationMs:1000,startedAt:'2026-01-01T00:00:00Z',completedAt:'2026-01-01T00:00:01Z'},{cost:null,input:10,output:3,durationMs:1000,startedAt:'2026-01-01T00:00:00Z',completedAt:'2026-01-01T00:00:01Z'}]};
 assert.equal(metrics(t).cost,null);assert.equal(metrics(t).time,2000);assert.equal(metrics(t).span,1000);
 assert.equal(metrics({...t,requests:[t.requests[0]]}).cost,0);
});
test('extracts last answer rather than earlier commentary',()=>{
 assert.equal(answer({events:[{title:'Model answer',raw:'{"content":[{"text":"Earlier"}]}'},{title:'Model answer',raw:'{"content":[{"text":"Final"}]}'}]}),'Final');
});

const detailed=(output,extra={})=>({id:'t',title:'same',promptRaw:'run tests',evidence:[],captureComplete:true,
 comparisonRequests:[{exchangeId:'e',model:'m',settings:{},instructions:'system',tools:[],context:[]}],
 events:[{title:'Tool call: exec_command',exchange_id:'e',output_index:0,raw:JSON.stringify({name:'exec_command',call_id:'repeated',arguments:'{"cmd":"npm test"}'})},
 {title:'Tool result: exec_command',exchange_id:'e',output_index:0,raw:JSON.stringify({call_id:'repeated',output})}],...extra});
const {firstDifference,comparisonLimits}=await import('../dashboard/app/run-comparison-data.ts');
test('same command with exit 0 versus 1 is a result difference with proof references',()=>{
 const d=firstDifference(detailed('Process exited with code 0\nOutput:\npass'),detailed('Process exited with code 1\nOutput:\nfail'));
 assert.equal(d.kind,'result');assert.equal(d.a.exchangeId,'e');assert.equal(d.b.reportedExit,1);
});
test('prompt and settings differences precede later tool failures',()=>{
 assert.equal(firstDifference(detailed('ok',{promptRaw:'A'}),detailed('fail',{promptRaw:'B'})).kind,'prompt');
 const b=detailed('fail');b.comparisonRequests[0].instructions='different';
 assert.equal(firstDifference(detailed('ok'),b).kind,'settings');
});
test('canonical JSON and runner timing noise do not create a false output difference',()=>{
 assert.equal(firstDifference(detailed('Wall time: 1 seconds\nProcess exited with code 0\nOutput:\nsame'),detailed('Wall time: 2 seconds\nProcess exited with code 0\nOutput:\nsame')),null);
});
test('an unrelated repeated call id cannot supply a result for a different exchange',()=>{
 const a=detailed('out');a.events[1].exchange_id='other';
 assert.equal(actions(a)[0].result,undefined);assert.ok(comparisonLimits(a,a).some(s=>s.includes('not captured')));
});
test('observed exits are distinct from reported outcomes',()=>{
 const a=detailed('Process exited with code 0',{callVerifications:[{exchange_id:'e',output_index:0,exit_code:0}]}),b=detailed('Process exited with code 0',{callVerifications:[{exchange_id:'e',output_index:0,exit_code:7}]});
 assert.equal(firstDifference(a,b).kind,'exit');assert.equal(firstDifference(a,b).b.reportedExit,0);
});
test('missing details and preview-only evidence are explicitly limited',()=>{
 const a=detailed('x',{captureComplete:false,evidence:[{id:'x',preview:'partial'}]});
 assert.ok(comparisonLimits(a,a).some(x=>x.includes('truncated')));assert.ok(comparisonLimits(a,a).some(x=>x.includes('preview')));
});
test('keeps quoted exit codes and header-like lines in the actual output',()=>{
 const output='Output:\nexample\nProcess exited with code 1';
 const [call]=actions(detailed(output));
 assert.equal(call.reportedExit,null);
 assert.equal(call.result,output);
 const wrapped='Process exited with code 1\nOutput:\n'+output;
 assert.equal(actions(detailed(wrapped))[0].result,output);
});
