import test from 'node:test';
import assert from 'node:assert/strict';
import {captureHealth,sourceStreamId} from './capture-health.mjs';
import {openEvidenceStore} from './evidence-store.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const sessionId='rtp-'+'a'.repeat(32);
const stream={id:'conn',collector_id:'boot',started_ms:100,heartbeat_ms:1000,ended_ms:null,clock_measured:true};
const checkpoint={source_instance_id:'boot',checked_at_ms:1000,latest:5,cursor:5,forwarded_through_ms:1000};
const sample=(extra={})=>captureHealth({sessionId,streams:[stream],checkpoints:[checkpoint],events:[],since:200,until:800,now:1100,...extra});
test('live liveness and historic interval are independent',()=>{
 assert.equal(sample().live,'reporting');assert.equal(sample().history,'no_known_gaps');
 const old=sample({now:17000});assert.equal(old.live,'not_reporting');assert.equal(old.history,'no_known_gaps');
 assert.equal(sample({checkpoints:[{...checkpoint,cursor:4}]}).live,'catching_up');
});
test('unknown start, missing clock, legacy recording and imported data never claim live health',()=>{
 assert.equal(sample({streams:[]}).history,'unknown');
 assert.equal(sample({streams:[{...stream,clock_measured:false}]}).history,'unknown');
 assert.equal(sample({checkpoints:[{...checkpoint,imported:true}]}).live,'unknown');
 assert.equal(captureHealth({sessionId:'host-session'}).history,'not_applicable');
});
test('gaps are scoped to the run, including the interval before the dropped-count report',()=>{
 assert.equal(sample({events:[{kind:'collection_gap',recorded_at_ms:900,gap_from_ms:700,dropped_delta:2}]}).history,'gaps_detected');
 assert.equal(sample({events:[{kind:'collection_gap',recorded_at_ms:1100,gap_from_ms:1001}]}).history,'no_known_gaps');
 assert.equal(sample({events:[{kind:'collector_disconnected',recorded_at_ms:700}]}).history,'unknown');
});
test('source identities survive event-id reuse after a collector restart',()=>{
 assert.notEqual(sourceStreamId('box',{source_instance_id:'a',source_connection_id:'c'}),sourceStreamId('box',{source_instance_id:'b',source_connection_id:'c'}));
});
test('SQLite progress survives reopening and deleting one sandbox removes its metadata only',()=>{
 const dir=mkdtempSync(join(tmpdir(),'recording-health-'));const file=join(dir,'evidence.db');let db=openEvidenceStore(file);
 try {
  db.saveCaptureProgress({containerId:'box',projectId:sessionId,sourceId:'boot',cursor:5,coverage:{...checkpoint,streams:[stream]}});
  db.saveCaptureProgress({containerId:'other',projectId:'rtp-'+'b'.repeat(32),sourceId:'boot',cursor:3,coverage:{...checkpoint,streams:[{...stream,id:'other'}]}});
  db.close();db=openEvidenceStore(file);assert.equal(db.captureCheckpoint('box','boot'),5);
  assert.equal(db.captureHealth(sessionId,{since:200,until:800,now:1100}).history,'no_known_gaps');
  db.forgetSessions([sessionId]);assert.equal(db.captureCheckpoint('box','boot'),0);assert.equal(db.captureCheckpoint('other','boot'),3);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('a current outage or later backlog cannot invalidate a previously forwarded historical interval',()=>{
 const health=sample({checkpoints:[{...checkpoint,unavailable:true,latest:100}],now:50000});
 assert.equal(health.live,'not_reporting');assert.equal(health.history,'no_known_gaps');
});
