/** Control-only synthetic fault/clock tests, plus unchanged real native importer. */
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import crypto from 'node:crypto';
const source=fs.readFileSync(new URL('../src/ProvisionalOfflineBatch.js',import.meta.url),'utf8'),sha=s=>crypto.createHash('sha256').update(s).digest('hex');
let checks=0,cases=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;},ok=x=>{assert.ok(x);checks++;},throws=(f,r)=>{assert.throws(f,r);checks++;};
function fixture(n=8){
 const clock={now:0,perImport:0,readDelay:0},receipts={},calls=[],reads=[],files={},state={manifestId:'M',batchId:'B',requestedBy:'owner',status:'EXPORTED',sourceManifest:{fileId:'manifest',sha256:'a'.repeat(64)}},batch={id:'B',requestedBy:'owner',active:false,current:null,offlineHandoff:{manifestId:'M'}},m={manifestId:'M',batchId:'B',actor:'owner',fy:2026,contract:{app:'frozen'},reservations:Array.from({length:n},(_,i)=>({reservationKey:'R'+i,planId:'PL'+i,runId:'RUN'+i}))};
 const refs=m.reservations.map(r=>({reservationKey:r.reservationKey,fileId:'F'+r.reservationKey,sha256:sha(r.reservationKey)}));refs.forEach(ref=>files[ref.fileId]={sha:ref.sha256,value:{format:'OFFLINE_NEW_MEASURE_BUNDLE_V1',manifestId:'M',sourceManifestSha256:state.sourceManifest.sha256,plans:[{reservationKey:ref.reservationKey}]}});
 files.manifest={sha:state.sourceManifest.sha256,value:m};files.proof={sha:'b'.repeat(64),value:{format:'OFFLINE_NATIVE_CANARY_PROOF_V1',pass:true,manifestId:'M',sourceManifestSha256:state.sourceManifest.sha256}};
 const input={manifestId:'M',sourceManifestSha256:state.sourceManifest.sha256,files:refs,canaryProofFileId:'proof',canaryProofSha256:files.proof.sha},ctx={actor:'owner',user:{isOwner:true}},control={pending:false,jobs:false,locked:0,failAt:0,returnPending:false,reactivate:false};
 const done=i=>{const r=m.reservations[i],ref=refs[i];receipts[r.reservationKey]={reservationKey:r.reservationKey,planId:r.planId,runId:r.runId,bundleSha256:ref.sha256,canaryProofSha256:input.canaryProofSha256,status:'DONE',completionMode:'verified_offline_bundle'};};
 const env=vm.createContext({Date:{now:()=>clock.now},appOfflineOwner_:c=>{if(!c?.user?.isOwner)throw Error('OWNER_ONLY');return c;},appOfflineAssert_:(v,msg)=>{if(!v)throw Error(msg);},appOfflineHex_:v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v),appOfflineHash_:v=>sha(JSON.stringify(v)),appOfflineSame_:(a,b)=>JSON.stringify(a)===JSON.stringify(b),appWithLock_:f=>{control.locked++;try{return f();}finally{control.locked--;}},appOfflineState_:()=>state,appProvisionalState_:()=>batch,appOfflineReceiptKey_:(_s,k)=>k,appProvisionalReadJson_:k=>receipts[k]||null,appOfflineContract_:()=>({app:'frozen'}),appRequireOpenYear_:()=>{},appOfflineRequireIdle_:()=>{if(control.pending)throw Error('PENDING_JOURNAL');if(control.jobs)throw Error('NATIVE_JOBS');},appJournalPending_:()=>control.pending,appOfflineReadFile_:(id,h)=>{reads.push(id);const f=files[id];if(!f||f.sha!==h)throw Error('FILE_SHA');if(id.startsWith('F'))clock.now+=clock.readDelay;return f.value;},appOfflineImport_:(_ctx,i)=>{assert.ok(control.locked>0);calls.push(structuredClone(i));const index=refs.findIndex(r=>r.fileId===i.fileId),r=m.reservations[index];clock.now+=clock.perImport;if(control.failAt===calls.length){receipts[r.reservationKey]={reservationKey:r.reservationKey,planId:r.planId,runId:r.runId,bundleSha256:i.sha256,canaryProofSha256:i.canaryProofSha256,status:'WRITING'};control.pending=true;throw Error('NATIVE_INTERRUPTION');}done(index);if(control.returnPending)control.pending=true;if(control.reactivate)batch.active=true;}});vm.runInContext(source,env);
 return{clock,receipts,calls,reads,files,state,batch,m,refs,input,ctx,control,done,run:()=>JSON.parse(JSON.stringify(env.appOfflineImportBatch_(ctx,input)))};
}
{
 const f=fixture(38),a=f.run();eq(a.imported.length,4);eq(a.remainingRequested,34);eq(a.reason,'IMPORT_COUNT_LIMIT');eq(f.calls.length,4);const b=f.run();eq(b.skipped.length,4);eq(b.imported.length,4);eq(b.remainingRequested,30);ok(f.calls.every(x=>Object.keys(x).sort().join()===['canaryProofFileId','canaryProofSha256','fileId','sha256'].sort().join()));cases++;
}
{
 const f=fixture(38);for(let i=0;i<38;i++)f.done(i);const r=f.run();eq(r.imported.length,0);eq(r.skipped.length,38);eq(r.doneForRequestedFiles,true);eq(f.reads,['manifest','proof']);cases++;
}
{
 const f=fixture();f.clock.perImport=60000;const r=f.run();eq(r.imported.length,2);eq(r.reason,'ADMISSION_BUDGET');eq(r.elapsedMs,120000);const g=fixture();g.clock.readDelay=120000;eq(g.run().imported.length,0);eq(g.calls.length,0);cases++;
}
{
 for(const mutate of[
 f=>f.input.files.push({...f.refs[0]}),f=>f.input.files[7].reservationKey='FOREIGN',f=>f.input.sourceManifestSha256='0'.repeat(64),f=>f.batch.active=true,f=>f.m.contract={app:'changed'},f=>f.files.proof.value.sourceManifestSha256='0'.repeat(64),f=>{f.done(0);f.receipts.R0.runId='FOREIGN';},f=>{f.done(0);f.receipts.R0.completionMode='fake';},f=>{f.done(0);f.receipts.R0.canaryProofSha256='0'.repeat(64);},f=>{f.done(0);f.input.files[0].sha256='1'.repeat(64);},f=>f.control.pending=true,f=>f.control.jobs=true,
 ]){const f=fixture();mutate(f);throws(()=>f.run(),/./);eq(f.calls.length,0);}const f=fixture();f.ctx.user.isOwner=false;throws(()=>f.run(),/OWNER_ONLY/);eq(f.reads.length,0);cases++;
}
{
 const f=fixture();f.files.FR0.value.plans.push({reservationKey:'R1'});throws(()=>f.run(),/exactly/);eq(f.calls.length,0);const g=fixture();g.files.FR0.sha='0'.repeat(64);throws(()=>g.run(),/FILE_SHA/);eq(g.calls.length,0);cases++;
}
{
 const f=fixture();f.control.failAt=2;throws(()=>f.run(),/NATIVE_INTERRUPTION/);eq(f.calls.length,2);eq(f.receipts.R0.status,'DONE');eq(f.receipts.R1.status,'WRITING');throws(()=>f.run(),/PENDING_JOURNAL/);eq(f.calls.length,2);f.control.pending=false;f.control.failAt=0;f.done(1);const r=f.run();eq(r.skipped.length,2);eq(r.imported.length,4);cases++;
}
{
 const f=fixture();f.control.returnPending=true;throws(()=>f.run(),/pending/);eq(f.calls.length,1);const g=fixture();g.control.reactivate=true;throws(()=>g.run(),/inactive/);eq(g.calls.length,1);cases++;
}
// Real native importer unchanged: synthetic generated-engine bundle -> journal -> API receipt.
{
 const mockUrl=new URL('./gas-mock.mjs',import.meta.url).href;
 let setup=fs.readFileSync(new URL('./app-provisional-offline.test.mjs',import.meta.url),'utf8');const cut=setup.indexOf('// Actual native producer bundle:');assert.ok(cut>0,'synthetic native fixture boundary is available');setup=setup.slice(0,cut);setup=setup.replace("'./gas-mock.mjs'",JSON.stringify(mockUrl))+ '\nexport {fixture};';
 const mod=await import('data:text/javascript;base64,'+Buffer.from(setup).toString('base64')),f=mod.fixture();vm.runInContext(source,f.e.ctx);
 const input={manifestId:f.m.manifestId,sourceManifestSha256:f.mf.sha256,files:[{reservationKey:f.m.reservations[0].reservationKey,fileId:f.input.fileId,sha256:f.input.sha256}],canaryProofFileId:f.input.canaryProofFileId,canaryProofSha256:f.input.canaryProofSha256};
 const first=f.e.call('appOfflineImportBatch_(__ctx,__in)',{__ctx:f.ctx,__in:input});eq(first.imported.length,1);eq(first.doneForRequestedFiles,true);eq(f.e.table('FORECAST_MONTHLY').length,12);eq(f.e.call('appReadTable_("FORECAST_RUNS").length'),1);
 const again=f.e.call('appOfflineImportBatch_(__ctx,__in)',{__ctx:f.ctx,__in:input});eq(again.skipped.length,1);eq(again.imported.length,0);eq(again.skipped[0].status,'receipt_already_done');cases++;
}
const result={status:'PASS_CONTROL_ONLY_BATCH',cases,checks,sourceSha256:sha(source),newRealForecasts:0,newLiveCalls:0};console.log('app-offline-batch: '+cases+' cases / '+checks+' assertions PASS');
