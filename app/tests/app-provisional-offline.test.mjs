/** New-only offline handoff: synthetic native engine/journal, no live calls. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeEnv, MEMBER } from './gas-mock.mjs';
const hash=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const NAME='合成オフライン製薬',AS_OF=Date.parse('2026-10-18T01:00:00Z');
const SOURCE_PARTS=Array.from({length:4},(_,j)=>{const fy=2022+j,rows=[[41,46,50,56,57,66].map(x=>'sheader'+x)];for(let i=0;i<12;i++){const date=new Date(fy,3+i,1).toISOString();rows.push(['s'+NAME,'sベース','s合成品','e','d'+date,'n'+(100000+j*12000+i*5000)]);if(i===8)rows.push(['s'+NAME,'sスポット','s合成案件','e','d'+date,'n50000']);}return{fy,sheetName:'*'+fy+'_actual_value',rowStart:1,rowCount:rows.length,rows};});
// Keep the historical W-only transport contract distinct from new native BB calculation.
// The transformed synthetic engine has its own honest fingerprint; no live artifact is changed.
function historicalWEngine(e){
 e.run(`(()=>{const original=appLegacyEngine_.toString(),needle='const q = appHistoryInactiveCalendarForecast_(rows,';
  if(!original.includes(needle))throw Error('Historical W fixture dispatch missing');
  const source=original.replace(needle,'const q = appHistoryProvisionalForecast_(rows,'),factory=eval('('+source+')'),sha=appSha256Hex_(source);
  appLegacyEngine_=function(svc){const out=factory(svc);out.SOURCE_SHA256=sha;return out;};})();`);
}
function nativeFixture(sourceParts=SOURCE_PARTS){
 const e=makeEnv();historicalWEngine(e);e.call('apiSetup()');const ctx=e.call('(()=>{const user=appCurrentUser_();return{user,actor:user.email,roles:appRolesOf_(user),requestId:"SYNTHETIC-NATIVE"};})()');
 const specs={};for(const p of sourceParts){const rows=p.rows.map(c=>{const full=Array(66).fill('');[41,46,50,56,57,66].forEach((col,i)=>{const t=c[i][0],v=c[i].slice(1);full[col-1]=t==='d'?new Date(v):t==='n'?Number(v):t==='e'?'':v;});return full;});specs[p.sheetName]={cols:66,values:rows};}
 const source=e.makeBook('合成実績',specs);e.task('saveSetting({key:"source.zac_spreadsheet",value:__id})',{__id:source.getId()});
 function stage(kind,payload){let req={kind,payload};for(let i=0;i<40;i++){const r=e.call('appJobExecute_(__ctx,__job)',{__ctx:ctx,__job:{id:'SYNTHETIC-STAGE-'+i,kind:req.kind,payload:req.payload,requestedBy:ctx.actor,parentId:''}});assert.ok(!r.needConfirm);if(!r.__next)return r;req=r.__next;}throw Error('native continuation limit');}
 const made=stage('PLAN.CREATE',{clientName:NAME,fy:2026,peopleCsv:'',purpose:'MEASURE'}),planId=made.planId;
 const actionIds={import:'ACT-SYNTHETIC-IMPORT',aggregate:'ACT-SYNTHETIC-AGGREGATE'};
 stage('PLAN.RUN',{planId,action:'IMPORT.SALES',actionId:actionIds.import,asOfMs:AS_OF});stage('PLAN.RUN',{planId,action:'SALES.AGGREGATE',actionId:actionIds.aggregate,asOfMs:AS_OF});
 const pre=e.call('(()=>{const out={};Object.keys(APP_TABLES).filter(n=>n.startsWith("ENG_")).forEach(n=>out[n]=appReadTable_(n).filter(r=>r.plan_id===__pid).map(appStripRow_));const metas=out.ENG_SHEETS;const seed={};Object.keys(out).forEach(n=>{if(["ENG_SHEETS","ENG_ROWS","ENG_FORMATS"].includes(n))seed[n]=out[n].filter(r=>APP_FORECAST_SEED_SHEETS.includes(r.sheet));else if(APP_FORECAST_SEED_SHEETS.includes(n.slice(4)))seed[n]=out[n];});return{inputHash:appPlanInputHash_(__pid),forecastInputHash:appForecastInputHash_(__pid),preForecastAllSheetHashes:Object.fromEntries(metas.map(r=>[r.sheet,r.content_hash])),seedSheetHashes:Object.fromEntries(metas.filter(r=>APP_FORECAST_SEED_SHEETS.includes(r.sheet)).map(r=>[r.sheet,r.content_hash])),preForecastAllTables:out,preForecastSeedTables:seed};})()',{__pid:planId});
 const plan=e.call('appStripRow_(appPlanOf_(__pid))',{__pid:planId}),nativeLearning=e.call('appOfflineLearning_(__ctx,__plan,__ms)',{__ctx:ctx,__plan:plan,__ms:AS_OF}),runId='RUN-SYNTHETIC-OFFLINE';
 stage('FORECAST.RUN',{planId,runId,asOfMs:AS_OF,confirms:[]});
 const tables=e.call('(()=>{const o={};appOfflineAllowedTables_().forEach(n=>o[n]=appReadTable_(n).filter(r=>n==="CLIENTS"?r.client_id===__cid:r.plan_id===__pid).map(appStripRow_));return o;})()',{__pid:planId,__cid:plan.client_id});
 const contract=e.call('appOfflineContract_()'),reservation={reservationKey:'SYNTHETIC-RESERVATION',index:0,clientName:NAME,normalizedName:e.call('appNormalizeName_(__n)',{__n:NAME}),planId,clientId:plan.client_id,clientNew:true,runId,actionIds,nativeLearning};
 const m={format:'OFFLINE_NEW_MEASURE_EXPORT_V1',manifestId:'SYNTHETIC-MANIFEST',sourceClosureSha256:'a'.repeat(64),contract,fy:2026,asOfMs:AS_OF,actor:ctx.actor,timeZone:'Asia/Tokyo',locale:'ja_JP',existingClients:[],reservations:[reservation],sourceSheets:[]};
 return{m,b:{format:'OFFLINE_NEW_MEASURE_BUNDLE_V1',manifestId:m.manifestId,contract,fy:m.fy,asOfMs:AS_OF,actor:m.actor,plans:[{reservationKey:reservation.reservationKey,tables,forecastInputs:pre}],provenance:{sourceClosureSha256:m.sourceClosureSha256,sourcePinSha256:m.sourceClosureSha256}}};
}
const {m:rawManifest,b:rawBundle}=nativeFixture();
let checks=0,cases=0;const eq=(a,b,n)=>{assert.deepEqual(a,b,n);checks++;},ok=(v,n)=>{assert.ok(v,n);checks++;},reject=(f,re)=>{assert.throws(f,re);checks++;};
function addFile(e,v,label='synthetic.json'){return e.call(`(()=>{const f=DriveApp.getFolderById(appProps_().getProperty(APP_PROP.folderId)).createFile(__label,__text,MimeType.PLAIN_TEXT);return{fileId:f.getId(),sha256:appSha256Hex_(__text)};})()`,{__text:JSON.stringify(v),__label:label});}
function fixture(src={m:rawManifest,b:rawBundle,parts:SOURCE_PARTS}){
 const e=makeEnv({owner:src.m.actor,active:src.m.actor});historicalWEngine(e);e.call('apiSetup()');
 const ctx=e.call(`(()=>{const user=appCurrentUser_();return{user,actor:user.email,roles:appRolesOf_(user),requestId:'SYNTHETIC-OFFLINE'};})()`),m=structuredClone(src.m),b=structuredClone(src.b);
 m.cutoff='2026/03';m.sourceStart='2022/04';m.batchId='SYNTHETIC-BATCH';
 const sourceRecords={};m.reservations.forEach(r=>sourceRecords[r.reservationKey]=[]);for(let fy=2022;fy<=2025;fy++){const part=structuredClone(src.parts.find(p=>p.fy===fy));const rec=e.call('appOfflineEngineClassifyPart_(__m,__meta,__start,__rows)',{__m:m,__meta:{name:part.sheetName},__start:part.rowStart,__rows:part.rows});for(const k of Object.keys(rec))sourceRecords[k].push(...rec[k]);}for(const r of m.reservations)r.nativeSourceHistory=e.call('appOfflineHistoryOfRecords_(__rows,__m)',{__rows:sourceRecords[r.reservationKey],__m:m});
 m.canary={planId:'NATIVE-CANARY',run:{run_id:'NATIVE-CANARY-RUN'},runSha256:'c'.repeat(64)};
 const mf=addFile(e,m),bf=addFile(e,{...b,sourceManifestSha256:mf.sha256});
 const proof={format:'OFFLINE_NATIVE_CANARY_PROOF_V1',pass:true,oldWholePlanInputHashReconstructed:false,inputHashScope:'FORECAST_SEED_SHEETS_CANONICAL_V1',planningMeans:true,planningMetadata:true,nativeSaveApi:true,learningEvidenceMatches:true,manifestId:m.manifestId,sourceManifestSha256:mf.sha256,liveRunId:m.canary.run.run_id,liveRunSha256:m.canary.runSha256,inputHashes:true,annualQuantiles:true,monthlyQuantiles:true,planningPoints:true};const pf=addFile(e,proof);
 e.run(`appProvisionalSaveState_({version:APP_PROVISIONAL_VERSION,id:__m.batchId,requestedBy:__m.actor,fy:__m.fy,count:1,active:false,current:null,offlineHandoff:{manifestId:__m.manifestId}});appProvisionalSaveItem_(appProvisionalState_(),{index:0,key:__m.reservations[0].normalizedName,clientName:__m.reservations[0].clientName,status:'PENDING',completed:{}});appOfflineSave_({manifestId:__m.manifestId,batchId:__m.batchId,requestedBy:__m.actor,status:'EXPORTED',sourceManifest:__mf,imported:0});`,{__m:m,__mf:mf});
 const input={...bf,canaryProofFileId:pf.fileId,canaryProofSha256:pf.sha256};
 return {e,ctx,m,b,input,mf,pf,proof,call:(code,ex={})=>e.call(code,{__ctx:ctx,__in:input,...ex}),replaceBundle(b2){const f=addFile(e,{...b2,sourceManifestSha256:mf.sha256});Object.assign(input,f);return f;}};
}
// Actual native producer bundle: every canonical hash/type is checked, then native journal save/readback.
{
 const f=fixture(),{e}=f;const before=e.table('PLANS').length;
 const v=f.call('appOfflinePreflight_(__ctx,__in)');eq(v.plans.length,1);ok(v.plans[0].sourcePrior12Net>0,'native frozen source guard is positive');eq(e.table('PLANS').length,before,'preflight cannot write');
 const r=f.call('appOfflineImport_(__ctx,__in)');eq(r.readiness.planningReady,true);eq(r.receipt.completionMode,'verified_offline_bundle');eq(e.table('FORECAST_MONTHLY').length,12);
 const run=e.table('FORECAST_RUNS')[0];eq(JSON.parse(run.planning_json).method,'W_COMPONENT_EVENT_HALF_SHAPE_BLEND');
 const snapshot=JSON.stringify(e.data().sheets.map(s=>[s.name,e.table(s.name)]));
 eq(f.call('appOfflineImport_(__ctx,__in)').replay,true);eq(JSON.stringify(e.data().sheets.map(s=>[s.name,e.table(s.name)])),snapshot,'replay cannot alter rows');cases++;
}
// Exact file/contract checks fail before writes, owner-only, no arbitrary ops/table injection.
{
 for(const [label,change,re]of[
 ['SHA',(f)=>{f.input.sha256='0'.repeat(64);},/hash/],
 ['app',(f)=>{const b=structuredClone(f.b);b.contract.appVersion='old';f.replaceBundle(b);},/contract/],
 ['purpose',(f)=>{const b=structuredClone(f.b);b.plans[0].tables.PLANS[0].purpose='';f.replaceBundle(b);},/identity\/purpose/],
 ['table',(f)=>{const b=structuredClone(f.b);b.plans[0].tables.BUDGET_DRAFTS=[];f.replaceBundle(b);},/forbidden/],
 ['crossplan',(f)=>{const b=structuredClone(f.b);b.plans[0].tables.ENG_ROWS[0].plan_id='OTHER';f.replaceBundle(b);},/cross-plan/],
 ['boolean',(f)=>{const b=structuredClone(f.b);b.plans[0].tables.CLIENTS[0].is_active='FALSE';f.replaceBundle(b);},/boolean/],
 ['risk',(f)=>{const b=structuredClone(f.b);b.plans[0].tables.FORECAST_MONTHLY[0].p10=b.plans[0].tables.FORECAST_MONTHLY[0].p90+1;f.replaceBundle(b);},/risk/],
 ['point',(f)=>{const b=structuredClone(f.b),j=JSON.parse(b.plans[0].tables.FORECAST_RUNS[0].planning_json);j.months[0].point++;b.plans[0].tables.FORECAST_RUNS[0].planning_json=JSON.stringify(j);f.replaceBundle(b);},/planning/],
 ['content',(f)=>{const b=structuredClone(f.b);b.plans[0].tables.ENG_ROWS[0].cells_json='["sBROKEN"]';f.replaceBundle(b);},/hash/],
 ['input',(f)=>{const b=structuredClone(f.b);b.plans[0].forecastInputs.preForecastAllSheetHashes.OUTPUT='a'.repeat(64);f.replaceBundle(b);},/input hash/],
 ['action',(f)=>{const b=structuredClone(f.b);b.plans[0].tables.PLAN_ACTIONS[0].action='INPUT.SAVE';f.replaceBundle(b);},/action provenance/],
 ['missinglog',(f)=>{const b=structuredClone(f.b);delete b.plans[0].tables.LAYER_EFFECTS;f.replaceBundle(b);},/log incomplete/],
 ['missingseed',(f)=>{const b=structuredClone(f.b);b.plans[0].forecastInputs.preForecastAllTables.ENG_ROWS[0].cells_json='["sFORGED"]';f.replaceBundle(b);},/hash/],
 ['source',(f)=>{const b=structuredClone(f.b);b.plans[0].tables.ENG_SALES_INPUT[0].input_amount='0';f.replaceBundle(b);},/hash|source/],
 ['proof',(f)=>{f.input.canaryProofSha256='1'.repeat(64);},/hash/],
 ]){const f=fixture();change(f);reject(()=>f.call('appOfflineImport_(__ctx,__in)'),re);eq(f.e.table('PLANS').length,0,label+' prewrite');}
 const f=fixture();f.e.as(MEMBER);reject(()=>f.e.call('appOfflineImport_(null,__in)',{__in:f.input}),/所有者/);cases++;
}
// Existing normal row (even exact reserved identity) and closed FY cannot be overwritten.
{
 const f=fixture(),row=structuredClone(f.b.plans[0].tables.PLANS[0]);row.purpose='';f.e.run('appWithLock_(()=>appJournalRun_(__ctx,"Synthetic protected normal","",[{table:"PLANS",mode:"ensure",rows:[__row]}]));',{__ctx:f.ctx,__row:row});
 const snap=JSON.stringify(f.e.table('PLANS'));reject(()=>f.call('appOfflineImport_(__ctx,__in)'),/already exists/);eq(JSON.stringify(f.e.table('PLANS')),snap);cases++;
}
// Interrupted native journal resumes only its exact pinned ops; replay stays unique.
{
 const f=fixture();f.e.run(`var __realApply=appJournalApply_;var __faultOnce=true;appJournalApply_=function(ops){if(__faultOnce){__faultOnce=false;__realApply(ops.slice(0,3));throw new Error('SYNTHETIC_INTERRUPTION');}return __realApply(ops);};`);
 reject(()=>f.call('appOfflineImport_(__ctx,__in)'),/SYNTHETIC_INTERRUPTION/);ok(f.e.call('!!appJournalPending_()'));eq(f.e.call('appProvisionalReadJson_(appOfflineReceiptKey_(appOfflineState_(),__key)).status',{__key:f.m.reservations[0].reservationKey}),'WRITING');
 const r=f.call('appOfflineImport_(__ctx,__in)');eq(r.receipt.status,'DONE');eq(f.e.call('appJournalPending_()'),null);eq(f.e.table('PLANS').length,1);eq(f.e.table('FORECAST_MONTHLY').length,12);eq(f.e.table('PLAN_ACTIONS').length,2);cases++;
}
// Unrelated journal cannot be recovered by the offline importer.
{
 const f=fixture();f.e.run(`var __realApply=appJournalApply_;appJournalApply_=function(){throw new Error('SYNTHETIC_UNRELATED');};try{appWithLock_(()=>appJournalRun_(__ctx,'unrelated','',[]));}catch(e){}appJournalApply_=__realApply;`,{__ctx:f.ctx});reject(()=>f.call('appOfflineImport_(__ctx,__in)'),/unrelated/);eq(f.e.table('PLANS').length,0);ok(f.e.call('!!appJournalPending_()'));cases++;
}
// A valid zero point cannot bypass the independent positive native-source guard.
{
 const f=fixture(),b=structuredClone(f.b),j=JSON.parse(b.plans[0].tables.FORECAST_RUNS[0].planning_json);j.annualTarget=0;j.halfTargets=[0,0];j.months.forEach(x=>x.point=0);b.plans[0].tables.FORECAST_RUNS[0].planning_json=JSON.stringify(j);
 ok(f.e.call('!!appForecastPlanningOf_(__j,2026,__a)',{__j:JSON.stringify(j),__a:b.plans[0].tables.FORECAST_RUNS[0].annual_p50}),'zero point is structurally valid V2 before source guard');f.replaceBundle(b);reject(()=>f.call('appOfflineImport_(__ctx,__in)'),/positive-net all-year-zero/);eq(f.e.table('PLANS').length,0);cases++;
}
// Native inactive history keeps zero values; no minimum forecast is invented.
{
 const parts=structuredClone(SOURCE_PARTS);parts.forEach(p=>p.rows.slice(1).forEach(row=>row[5]='n0'));
 const zero=nativeFixture(parts),f=fixture({...zero,parts});const v=f.call('appOfflinePreflight_(__ctx,__in)');eq(v.plans[0].sourcePrior12Net,0);eq(v.plans[0].planning.annualTarget,0);eq(v.plans[0].tables.PUSH_RAW.length,0,'zero-base months legitimately emit no raw-push logs');
 const r=f.call('appOfflineImport_(__ctx,__in)');eq(r.readiness.forecastReady,true);eq(r.readiness.planningReady,true);const run=f.e.call('appReadTable_("FORECAST_RUNS")[0]');eq([run.annual_p10,run.annual_p50,run.annual_p90],[0,0,0]);ok(JSON.parse(run.planning_json).months.every(x=>x.point===0));cases++;
}
// Prepare/export: native canary preserved, only missing canonical manufacturer/FY reserved,
// no running cancellation, only matching queued UID cleaned, native ignored tabs preserved.
{
 const f=fixture(),{e,ctx}=f,t=f.b.plans[0].tables;
 e.run('appWithLock_(()=>appJournalRun_(__ctx,"synthetic native canary","",Object.keys(__tables).filter(n=>__tables[n].length).map(n=>({table:n,mode:"ensure",rows:__tables[n]}))));',{__ctx:ctx,__tables:t});
 const normal=structuredClone(t.PLANS[0]),client=structuredClone(t.CLIENTS[0]);normal.plan_id='NORMAL-PRESERVE';normal.client_id='NORMAL-CLIENT';normal.client_label='通常保全合成';normal.purpose='';client.client_id=normal.client_id;client.client_name=normal.client_label;client.normalized_name=e.call('appNormalizeName_(__n)',{__n:normal.client_label});
 e.run('appWithLock_(()=>appJournalRun_(__ctx,"synthetic normal","",[{table:"CLIENTS",mode:"ensure",rows:[__client]},{table:"PLANS",mode:"ensure",rows:[__normal]}]));',{__ctx:ctx,__client:client,__normal:normal});
 const missing='新規書き出し合成',spec={};
 for(let fy=2022;fy<=2025;fy++){
  const part=structuredClone(SOURCE_PARTS.find(p=>p.fy===fy));const rows=part.rows.map(c=>{const full=Array(66).fill('');[41,46,50,56,57,66].forEach((col,i)=>{const x=c[i],tt=x[0],txt=x.slice(1);full[col-1]=tt==='d'?new Date(txt):tt==='n'?Number(txt):tt==='b'?txt==='1':tt==='e'?'':txt;});return full;});rows.slice(1).forEach(r=>r[40]=missing);spec[part.sheetName]={cols:66,values:rows};
 }
 spec['*empty_actual_value']={cols:26,values:[]};spec['*header_actual_value']={cols:26,values:[['header']]};
 const book=e.makeBook('Synthetic frozen source',spec);e.task('saveSetting({key:"source.zac_spreadsheet",value:__id})',{__id:book.getId()});
 e.run(`appProps_().deleteProperty(APP_OFFLINE_KEY);appProvisionalSaveState_({version:APP_PROVISIONAL_VERSION,id:'EXPORT-BATCH',requestedBy:__ctx.actor,fy:2026,count:3,active:true,current:{index:1,stage:'CREATE',intentId:'EXPORT-INTENT'}});const st=appProvisionalState_();[__canary,__missing,__normal].forEach((n,i)=>appProvisionalSaveItem_(st,{index:i,key:appNormalizeName_(n),clientName:n,status:i===0?'DONE':i===2?'PRESERVED_NORMAL':'PENDING',stage:i===1?'CREATE':'',planId:i===0?__canaryId:i===2?'NORMAL-PRESERVE':'',completed:{}}));var __queued=appEnqueueJob_('PLAN.CREATE',{clientName:__missing,fy:2026,peopleCsv:'',purpose:'MEASURE',provisionalBatchId:st.id,provisionalIndex:1,provisionalStage:'CREATE',provisionalIntentId:'EXPORT-INTENT'},__ctx.actor,'');var __unrelated=appEnqueueJob_('PLAN.CREATE',{clientName:'無関係合成',fy:2026,purpose:'MEASURE'},__ctx.actor,'');const st2=appProvisionalState_();st2.current.rootJobId=__queued.id;st2.current.kind='PLAN.CREATE';st2.current.action='';appProvisionalSaveState_(st2);__queued.status='RUNNING';appJobSave_(__queued);`,{__ctx:ctx,__canary:t.PLANS[0].client_label,__canaryId:t.PLANS[0].plan_id,__missing:missing,__normal:normal.client_label});
 const prior=JSON.stringify(e.table('PLANS'));reject(()=>e.call('appOfflinePrepare_(__ctx,{sourceClosureSha256:__sha})',{__ctx:ctx,__sha:'a'.repeat(64)}),/RUNNING/);eq(e.call('appProvisionalState_().active'),true);eq(e.call('appOfflineState_()'),null);
 e.run('__queued.status="QUEUED";appJobSave_(__queued);Date.now=()=>1792285200123;');
 const initial=e.call('appOfflinePrepare_(__ctx,{sourceClosureSha256:__sha})',{__ctx:ctx,__sha:'a'.repeat(64)});eq(initial.status,'PREPARED');eq(e.call('appProvisionalState_().active'),false);eq(e.call('appProvisionalItem_(appProvisionalState_(),1).status'),'PENDING','paused native frontier remains resumable');
 eq(e.call('appJobGet_(__queued.id).status'),'FAILED');eq(e.call('appJobGet_(__unrelated.id).status'),'QUEUED');
 eq(e.call('ScriptApp.getProjectTriggers().some(t=>String(t.getUniqueId())===__queued.triggerUid)'),false);eq(e.call('ScriptApp.getProjectTriggers().some(t=>String(t.getUniqueId())===__unrelated.triggerUid)'),true);
 const prep=e.call('appOfflineReadFile_(__id,__sha)',{__id:initial.prepared.fileId,__sha:initial.prepared.sha256});eq(prep.reservations.length,1);eq(prep.reservations[0].clientName,missing);eq(prep.asOfMs,1792285200000,'truncate milliseconds before native seed/learning');eq(prep.sourceSheets.filter(x=>x.nativeSkipped).length,2);
 let state=initial;for(let i=0;i<10&&state.status!=='EXPORTED';i++)state=e.call('appOfflineExportNext_(__ctx)',{__ctx:ctx});eq(state.status,'EXPORTED');const final=e.call('appOfflineReadFile_(__id,__sha)',{__id:state.sourceManifest.fileId,__sha:state.sourceManifest.sha256});ok(final.reservations[0].nativeSourceHistory.prior12Net>0);eq(final.reservations[0].nativeSourceHistory.recordCount,52);eq(final.sourceSheets.filter(x=>x.nativeSkipped).every(x=>x.parts.length===0),true);eq(JSON.stringify(e.table('PLANS')),prior,'prepare/export preserve canary+normal tables');
 // Source edit after export is detected before model/import work.
 e.files[book.getId()].updated=new Date('2026-10-19T00:00:00Z');const finalSource=e.call('appOfflineSourceStamp_(__id)',{__id:book.getId()});ok(finalSource!==final.sourceModifiedAt);cases++;
}
console.log('app-provisional-offline: '+cases+' cases / '+checks+' assertions PASS (synthetic native pipeline only)');
