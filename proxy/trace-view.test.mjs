import test from 'node:test';
import assert from 'node:assert/strict';
import { readTraces } from './trace-view.mjs';

test('reused call IDs stay session-scoped and ambiguous same-session IDs stay unavailable',async()=>{
 const make=(id,session)=>({span_id:id,trace_id:id,session_id:session,provider:'test',timestamp:'2026-11-03T00:00:00Z',promptTitle:'test',request:{payload:{input:[]}},response:{payload:{output:[{type:'function_call',call_id:'reused',name:id,arguments:'{}'}]}}});
 const rows=[make('one','a'),make('two','b')];
 const db={exchangeRows:async()=>rows,divergence:async()=>[],descendants:async()=>[],snapshotsForCalls:async()=>new Map(),toolCallResult:async(id,{sessionId})=>({output:sessionId})};
 let traces=await readTraces(db,{includeHistory:true});
 assert.equal(JSON.parse(traces[0].events.find(e=>e.title==='Tool result: one').raw).output,'a');
 assert.equal(JSON.parse(traces[1].events.find(e=>e.title==='Tool result: two').raw).output,'b');
 rows[1].session_id='a';traces=await readTraces(db,{includeHistory:true});
 assert.ok(traces.every(t=>!t.events.some(e=>e.title.startsWith('Tool result:'))));
});

test('synthesizes terminal tool results for proposed calls with no subsequent exchange', async () => {
  const fakeRow = {
    span_id: 'span-1',
    trace_id: 'trace-1',
    session_id: 'rtp-12345678123456781234567812345678',
    provider: 'claude-code',
    timestamp: '2026-10-28T12:00:00.000Z',
    promptTitle: 'test prompt',
    request: {
      payload: {
        model: 'claude-3-5-sonnet',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run exit 7' }] }]
      }
    },
    response: {
      payload: {
        output: [
          {
            type: 'function_call',
            call_id: 'toolu_term_1',
            name: 'Bash',
            arguments: JSON.stringify({ command: 'exit 7' })
          }
        ]
      }
    }
  };

  const fakeDb = {
    exchangeRows: async () => [fakeRow],
    divergence: async () => [],
    descendants: async () => [],
    snapshotsForCalls: async () => new Map(),
    toolCallResult: async (callId) => {
      if (callId === 'toolu_term_1') {
        return { call_id: 'toolu_term_1', is_error: true, exit_code: 7, output: 'Process exited with code 7' };
      }
      return null;
    }
  };

  const traces = await readTraces(fakeDb, { includeHistory: true });
  assert.equal(traces.length, 1);
  const trace = traces[0];

  const resultEvent = trace.events.find((e) => e.title.startsWith('Tool result:') && e.raw.includes('toolu_term_1'));
  assert.ok(resultEvent, 'terminal tool result event was synthesized into trace.events');
  const parsed = JSON.parse(resultEvent.raw);
  assert.equal(parsed.call_id, 'toolu_term_1');
  assert.equal(parsed.exit_code, 7);
  assert.equal(parsed.is_error, true);
});

test('toolResultsFromTranscript extracts tool results from user messages', async () => {
  const { toolResultsFromTranscript } = await import('./claude-code-adapter.mjs');
  const lines = [
    { type: 'user', message: { content: [{ type: 'text', text: 'hello' }] } },
    { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'call_99', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call_99', content: 'file.txt', is_error: false }] } }
  ];
  const results = toolResultsFromTranscript(lines);
  assert.equal(results.size, 1);
  assert.deepEqual(results.get('call_99'), {
    type: 'function_call_output',
    call_id: 'call_99',
    output: 'file.txt'
  });
});

test('selected-run detail keeps full prompt/settings and signals the 2000-exchange limit',async()=>{
 const rows=Array.from({length:2001},(_,i)=>({span_id:`e${i}`,trace_id:'t',session_id:'host',provider:'test',timestamp:new Date(1000+i).toISOString(),promptTitle:'full prompt',
 request:{payload:{model:'m',instructions:'system',tools:[{name:'tool'}],temperature:0,input:[{role:'user',content:'full prompt'}]}},response:{payload:{output:[]}}}));
 const db={turnExchanges:async()=>rows,exchangeRows:async()=>[],divergence:async()=>[],descendants:async()=>[],snapshotsForCalls:async()=>new Map()};
 const [trace]=await readTraces(db,{turnId:'t',includeHistory:true});
 assert.equal(trace.captureComplete,false);assert.equal(trace.requests.length,2000);assert.equal(trace.promptRaw,'full prompt');
 assert.equal(trace.comparisonRequests[0].instructions,'system');assert.equal(trace.comparisonRequests[0].tools[0].name,'tool');
});
