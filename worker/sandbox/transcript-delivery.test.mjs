import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const session = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const setup = (repo) => {
  const dir = mkdtempSync(join(tmpdir(), 'raytrace-delivery-'));
  const home = join(dir, 'isolated-home');
  const state = join(dir, 'offsets');
  const transcript = join(home, '.claude', 'projects', 'test', `${session}.jsonl`);
  mkdirSync(resolve(transcript, '..'), {recursive:true});
  mkdirSync(join(home,'.raytace'), {recursive:true});
  mkdirSync(join(home,'.raytace-codex'), {recursive:true});
  writeFileSync(join(home,'.raytace','sandbox-token'), 'synthetic-token');
  writeFileSync(join(home,'.raytace-codex','config.toml'), '"x-raytace-sandbox-token" = "synthetic-token"');
  const hookPath = fileURLToPath(new URL('./claude-hook.mjs', import.meta.url));
  const source = readFileSync(hookPath,'utf8')
    .replace("const home = process.env.HOME || '/home/node';", `const home = ${JSON.stringify(home)};`)
    .replace("const STATE_DIR = '/tmp/raytace-claude';", `const STATE_DIR = ${JSON.stringify(state)};`);
  const hook = join(dir,'hook.mjs'); writeFileSync(hook,source);
  const preloader = join(dir,'fake-transport.mjs');
  const adapter = pathToFileURL(resolve(root,'proxy/claude-code-adapter.mjs')).href;
  writeFileSync(preloader, `
import {existsSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseTranscript,exchangesFromTranscript} from ${JSON.stringify(adapter)};
const dir=${JSON.stringify(dir)};
globalThis.fetch=async (url,init)=>{
 const note=JSON.parse(init.body), calls=join(dir,'calls.jsonl'), server=join(dir,'received.txt');
 appendFileSync(calls, JSON.stringify({note,bytes:Buffer.byteLength(init.body)})+'\\n');
 const mode=JSON.parse(readFileSync(join(dir,'mode.json'),'utf8'));
 if(mode.grow){appendFileSync(${JSON.stringify(transcript)},mode.grow);writeFileSync(join(dir,'mode.json'),'{}');}
 let bytes=existsSync(server)?readFileSync(server):Buffer.alloc(0);
 const answer=(status,body)=>({status,ok:status===200,json:async()=>body});
 if(mode.fail) return answer(503,{});
 if(mode.conflict) return answer(409,{size:bytes.length});
 if(note.offset!==bytes.length) return answer(409,{size:bytes.length});
 bytes=Buffer.concat([bytes,Buffer.from(note.text)]);writeFileSync(server,bytes);
 if(mode.loseAck){writeFileSync(join(dir,'mode.json'),'{}');throw new Error('synthetic lost acknowledgement');}
 const lines=parseTranscript(bytes.toString('utf8'));
 const rows=exchangesFromTranscript(lines,{final:note.hook_event_name==='Stop'&&note.more!==true});
 for(const row of rows) appendFileSync(join(dir,'rows.jsonl'),JSON.stringify(row)+'\\n');
 return answer(200,{size:bytes.length});
};`);
  writeFileSync(join(dir,'mode.json'),'{}');
  return {dir,state,transcript,run() {
    const result=spawnSync(process.execPath,['--import',preloader,hook],{
      input:JSON.stringify({session_id:session,transcript_path:transcript,hook_event_name:'Stop'}),
      encoding:'utf8',timeout:15000,maxBuffer:1024*1024,
    });
    assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
  }, calls(){return readFileSync(join(dir,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);},
  mode(value){writeFileSync(join(dir,'mode.json'),JSON.stringify(value));},
  offset(){return existsSync(join(state,`${session}.offset`))?Number(readFileSync(join(state,`${session}.offset`),'utf8')):0;},
  received(){return existsSync(join(dir,'received.txt'))?readFileSync(join(dir,'received.txt'),'utf8'):'';},
  close(){rmSync(dir,{recursive:true,force:true});}};
};
for (const repo of ['local']) {
 test(`${repo}: actual hook drains escaped oversized lines across UTF-8 boundaries and finalizes only once`,()=>{
  const fixture=setup(repo);
  try {
   const line=(type,message,extra={})=>JSON.stringify({type,sessionId:session,timestamp:'2026-10-28T00:00:00Z',message,...extra})+'\n';
   const raw=line('user',{content:'synthetic prompt'})
    +line('assistant',{id:'message',content:[{type:'text',text:'first part'}]},{requestId:'request'})
    +line('user',{content:[{type:'tool_result',tool_use_id:'call',content:'\\'.repeat(2_500_000)+'😀'.repeat(300_000)}]})
    +line('assistant',{id:'message',content:[{type:'text',text:'last part'}]},{requestId:'request'});
   writeFileSync(fixture.transcript,raw);fixture.run();
   assert.equal(fixture.received(),raw);assert.equal(fixture.offset(),Buffer.byteLength(raw));
   const calls=fixture.calls();assert.ok(calls.length>8);
   assert.ok(calls.every(c=>c.bytes<=4*1024*1024));
   assert.ok(calls.slice(0,-1).every(c=>c.note.more===true));assert.equal(calls.at(-1).note.more,false);
   const rows=readFileSync(join(fixture.dir,'rows.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
   assert.equal(rows.length,1);assert.equal(rows[0].response.payload.output.length,2);
  } finally {fixture.close();}
 });
 test(`${repo}: failed send retains offset and retry delivers exact bytes`,()=>{
  const fixture=setup(repo);try {
   const raw=JSON.stringify({type:'user',message:{content:'hello 😀'}})+'\n';
   writeFileSync(fixture.transcript,raw);fixture.mode({fail:true});fixture.run();
   assert.equal(fixture.offset(),0);assert.equal(fixture.received(),'');
   fixture.mode({});fixture.run();assert.equal(fixture.received(),raw);assert.equal(fixture.offset(),Buffer.byteLength(raw));
  } finally {fixture.close();}
 });
 test(`${repo}: lost acknowledgement resumes with 409 without duplicating bytes`,()=>{
  const fixture=setup(repo);try {
   const raw=JSON.stringify({type:'user',message:{content:'hello'}})+'\n';
   writeFileSync(fixture.transcript,raw);fixture.mode({loseAck:true});fixture.run();
   assert.equal(fixture.offset(),0);assert.equal(fixture.received(),raw);
   fixture.run();assert.equal(fixture.received(),raw);assert.equal(fixture.offset(),Buffer.byteLength(raw));
  } finally {fixture.close();}
 });
 test(`${repo}: drain stops at entry size and a later hook sends concurrently appended bytes`,()=>{
  const fixture=setup(repo);try {
   const raw=JSON.stringify({type:'user',message:{content:'initial'}})+'\n';
   const added=JSON.stringify({type:'user',message:{content:'appended during send'}})+'\n';
   writeFileSync(fixture.transcript,raw);fixture.mode({grow:added});fixture.run();
   assert.equal(fixture.received(),raw);assert.equal(fixture.offset(),Buffer.byteLength(raw));
   fixture.run();assert.equal(fixture.received(),raw+added);
  } finally {fixture.close();}
 });
 test(`${repo}: repeated conflicts have a bounded retry budget`,()=>{
  const fixture=setup(repo);try {
   writeFileSync(fixture.transcript,'{}\n');fixture.mode({conflict:true});fixture.run();
   assert.equal(fixture.calls().length,8);assert.equal(fixture.offset(),0);
  } finally {fixture.close();}
 });
}

const sessionPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
for (const repo of ['local']) {
 test(`${repo}: real receiver accepts partial lines, enforces byte offsets and validates fragment flags`,async()=>{
  const dir=mkdtempSync(join(tmpdir(), 'raytrace-receiver-'));
  try {
   const source=readFileSync(resolve(root,'proxy/raytace-proxy.mjs'),'utf8');
   const start=source.indexOf('async function appendSandboxTranscript(');
   const end=source.indexOf('\n/**',start);
   const fn=new Function('join','sandboxTranscripts','CLAUDE_SESSION_ID','serially','mkdir','stat','appendFile',
     `${source.slice(start,end)};return appendSandboxTranscript;`)(join,dir,sessionPattern,(_path,job)=>job(),fsPromises.mkdir,fsPromises.stat,fsPromises.appendFile);
   const initial={session_id:session,offset:0,text:'{"value":"😀',more:true};
   const first=await fn('rtp-synthetic',initial);assert.equal(first.status,200);
   assert.equal(first.body.size,Buffer.byteLength(initial.text));
   const duplicate=await fn('rtp-synthetic',initial);assert.equal(duplicate.status,409);assert.equal(duplicate.body.size,first.body.size);
   const tail={session_id:session,offset:first.body.size,text:'"}\n',more:false};
   const final=await fn('rtp-synthetic',tail);assert.equal(final.status,200);
   assert.equal(readFileSync(join(dir,'rtp-synthetic',`${session}.jsonl`),'utf8'),initial.text+tail.text);
   assert.equal((await fn('rtp-synthetic',{...tail,offset:final.body.size,more:'false'})).status,400);
   assert.equal((await fn('rtp-synthetic',{...tail,offset:-1})).status,400);
   assert.equal((await fn('rtp-synthetic',{...tail,session_id:'../../bad'})).status,400);
   // Existing whole-line senders remain accepted without the new flag.
   assert.equal((await fn('rtp-synthetic',{session_id:session,offset:final.body.size,text:'{}\n'})).status,200);
  } finally {rmSync(dir,{recursive:true,force:true});}
 });
 test(`${repo}: actual serialized envelope is bounded and queued metadata is retained`,()=>{
  const fixture=setup(repo);try {
   mkdirSync(fixture.state,{recursive:true});
   const event={id:'synthetic-large-event',detail:'x'.repeat(3_700_000)};
   const queue=join(fixture.state,`${session}.events.jsonl`);
   writeFileSync(queue,JSON.stringify(event)+'\n');
   const raw=JSON.stringify({type:'user',message:{content:'\\'.repeat(400_000)}})+'\n';
   writeFileSync(fixture.transcript,raw);fixture.run();
   assert.equal(fixture.received(),raw);
   const calls=fixture.calls();assert.ok(calls.length>1);assert.ok(calls.every(c=>c.bytes<=4*1024*1024));
   assert.deepEqual(calls[0].note.events,[event]);assert.equal(readFileSync(queue,'utf8'),'');
  } finally {fixture.close();}
 });
}

