/** Synthetic persisted readback only; no native model or live calls. */
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {setUpEnv,OWNER} from './gas-mock.mjs';
const source=fs.readFileSync(new URL('../src/ProvisionalReadback.js',import.meta.url),'utf8'),hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
let cases=0,checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;},ok=x=>{assert.ok(x);checks++;},reject=(f,re)=>{assert.throws(f,re);checks++;};
function fixture(){
 const e=setUpEnv();vm.runInContext(source,e.ctx);const ctx={actor:OWNER,user:{isOwner:true,email:OWNER},roles:[]};
 const months=Array.from({length:12},(_,i)=>{const m=4+i;return(m>12?2027:2026)+'/'+String(m>12?m-12:m).padStart(2,'0');});
 const clients=[],plans=[],runs=[],monthly=[],items=[],reservations=[];
 for(let i=0;i<45;i++){
  const planId='SYN-PL-'+i,clientId='SYN-CL-'+i,name='合成メーカー'+String(i).padStart(2,'0'),inactive=i===44;
  clients.push({client_id:clientId,client_name:name,normalized_name:name,is_active:true});plans.push({plan_id:planId,client_id:clientId,fy:'2026',client_label:name,people_csv:i<7?'合成担当':'',purpose:i===0?'':'MEASURE',state:'ACTIVE'});
  const points=months.map((ym,m)=>({ym,point:inactive?0:(m===0||m===11?100:0),share:inactive?0:(m===0||m===11?0.5:0),mean:0}));
  const planning={version:'HISTORY_MONTHLY_POINT_V2',applied:true,method:'W_COMPONENT_EVENT_HALF_SHAPE_BLEND',annualRawP50:0,annualTarget:inactive?0:200,annualBasis:'sum_monthly_points',trainingThroughYm:'2026/03',months:points,provisional:true,validationStatus:'in_progress',halfTargets:inactive?[0,0]:[100,100],provisionalWeights:[0,0],provisionalFolds:[],provisionalMode:'complete_S'};
  runs.push({plan_id:planId,run_id:'SYN-RUN-'+i,status:'DONE',annual_p10:0,annual_p50:0,annual_p90:0,objective_p10:0,objective_p50:0,objective_p90:0,planning_json:i===0?'':JSON.stringify(planning),finished_at:'2026-10-18T01:00:00Z',app_version:'0.49.0'});
  months.forEach(ym=>monthly.push({plan_id:planId,run_id:'SYN-RUN-'+i,ym,p10:0,p50:0,p90:0,obj_p10:0,obj_p50:0,obj_p90:0}));
  items.push({index:i,key:name,clientName:name,planId,status:i===0?'PRESERVED_NORMAL':'DONE',completed:{}});
  if(i>=7)reservations.push({reservationKey:'SYN-RES-'+i,planId,runId:'SYN-RUN-'+i,nativeSourceHistory:{prior12Net:inactive?0:100,historySha256:'a'.repeat(64)}});
 }
 e.run('appInsertRows_("CLIENTS",__clients);appInsertRows_("PLANS",__plans);appInsertRows_("FORECAST_RUNS",__runs);appInsertRows_("FORECAST_MONTHLY",__monthly);',{__clients:clients,__plans:plans,__runs:runs,__monthly:monthly});
 e.run('appInsertRows_("BUDGET_DRAFTS",[{draft_id:"SYN-BUDGET",plan_id:"SYN-PL-0",adopted:500}]);appInsertRows_("PLAN_VERSIONS",[{version_id:"SYN-VERSION",plan_id:"SYN-PL-0",state:"APPROVED",budget_final:500}]);appInsertRows_("ENG_OPINIONS",[{plan_id:"SYN-PL-0",seq:"1",Person:"合成担当",Note:"保持",_types:"ssssss"}]);');
 const m={manifestId:'SYN-MANIFEST',batchId:'SYN-BATCH',fy:2026,actor:OWNER,contract:{appVersion:'0.49.0',schemaVersion:16,schemaSha256:e.call('appSha256Hex_(Object.keys(APP_TABLES).sort().map(n=>n+":"+appColumnsHash_(n)).join("|"))')},sourceClosureSha256:'b'.repeat(64),reservations};
 const mf=e.call('appOfflineWriteFile_("synthetic-manifest",__m)',{__m:m});
 e.run('appProvisionalSaveState_({version:APP_PROVISIONAL_VERSION,id:__m.batchId,requestedBy:__m.actor,fy:2026,count:45,active:false,current:null});__items.forEach(i=>appProvisionalSaveItem_(appProvisionalState_(),i));appOfflineSave_({manifestId:__m.manifestId,batchId:__m.batchId,requestedBy:__m.actor,status:"IMPORTING",sourceManifest:__mf});',{__m:m,__items:items,__mf:mf});
 const input={fy:2026,protectedPlanIds:plans.slice(0,7).map(p=>p.plan_id)};
 const read=extra=>e.call('appProvisionalReadback_(__ctx,__in)',{__ctx:ctx,__in:{...input,...extra}}),file=r=>e.call('appOfflineReadFile_(__f.fileId,__f.sha256)',{__f:r.file});
 const store=()=>hash(e.data().sheets.map(s=>({name:s.name,rows:s.rows})));
 return{e,ctx,m,mf,input,read,file,store};
}
{
 const f=fixture();f.e.run('appLegacyEngine_=()=>{throw Error("MODEL_MUST_NOT_RUN");};');const before=f.store(),a=f.read(),d=f.file(a);eq(a.summary.roster,45);eq(a.summary.forecastReady,45);eq(a.summary.planningReady,44);eq(a.summary.positiveAnnualPoint,43);eq(a.summary.zeroAnnualPoint,1);eq(a.summary.complete,true);eq(d.roster.reduce((n,r)=>n+r.monthly.length,0),540);eq(d.roster[7].run.annual_p50,0);eq(d.roster[7].planning.annualTarget,200);eq(d.roster[44].planning.annualTarget,0);eq(d.roster[7].halfTargets,[100,100]);eq(d.protectedPlans.length,7);eq(f.store(),before);eq(d.modelInvocations,0);eq(d.storeWrites,0);eq(d.preservationComparison,null);ok(d.protectedPlans[0].tables.BUDGET_DRAFTS.count===1);ok(d.protectedPlans[0].tables.PLAN_VERSIONS.count===1);ok(d.protectedPlans[0].categories.subjective.ENG_OPINIONS.count===1);cases++;
}
{
 const f=fixture(),a=f.read();const b=f.read({baselineFileId:a.file.fileId,baselineSha256:a.file.sha256});eq(b.preservation,{normalUnchanged:true,stableProtectedUnchanged:true,globalUnchanged:true});
 f.e.run('appInsertRows_("PLAN_ACTIONS",[{plan_id:"SYN-PL-1",action_id:"SYN-EXPECTED",action:"IMPORT.SALES",status:"DONE"}]);');
 const c=f.read({baselineFileId:a.file.fileId,baselineSha256:a.file.sha256}),d=f.file(c);eq(c.preservation,{normalUnchanged:true,stableProtectedUnchanged:true,globalUnchanged:true});eq(d.preservationComparison.result.protected.find(p=>p.planId==='SYN-PL-1').changedCategories,['expected_sales_forecast_logs']);
 f.e.run('appPatchRow_("BUDGET_DRAFTS",{draft_id:"SYN-BUDGET"},{adopted:501},"owner");');
 const changed=f.read({baselineFileId:a.file.fileId,baselineSha256:a.file.sha256});eq(changed.preservation.normalUnchanged,false);eq(changed.preservation.stableProtectedUnchanged,false);cases++;
}
{
 const f=fixture();f.e.run('appInsertRows_("PLAN_ACTIONS",[{plan_id:"SYN-PL-0",action_id:"SYN-NORMAL-NEW-LOG",status:"DONE"}]);');const baseline=f.read();
 f.e.run('appInsertRows_("PLAN_ACTIONS",[{plan_id:"SYN-PL-0",action_id:"SYN-NORMAL-CHANGED-LOG",status:"DONE"}]);');
 eq(f.read({baselineFileId:baseline.file.fileId,baselineSha256:baseline.file.sha256}).preservation.normalUnchanged,false);
 f.e.run('appInsertRows_("CLIENT_NAMES",[{client_id:"SYN-CL-0",display_name:"別の表示名"}]);');
 const next=f.read({baselineFileId:baseline.file.fileId,baselineSha256:baseline.file.sha256});eq(next.preservation.stableProtectedUnchanged,false);cases++;
}
{
 const f=fixture(),base=f.read();
 f.e.run('appPatchRow_("PLANS",{plan_id:"SYN-PL-1"},{updated_at:"2026-10-18T02:00:00Z",row_version:2},"owner");');
 const metadata=f.read({baselineFileId:base.file.fileId,baselineSha256:base.file.sha256}),d=f.file(metadata);
 eq(metadata.preservation.stableProtectedUnchanged,true);eq(d.preservationComparison.result.protected.find(p=>p.planId==='SYN-PL-1').changedCategories,['expected_execution_metadata']);
 f.e.run('appInsertRows_("ENG_SOURCE_RELIABILITY",[{plan_id:"SYN-PL-1",seq:"1",client:"合成",source_type:"person",source_key:"担当",reliability_r:"0.5",_types:"sssnsssss"}]);');
 eq(f.read({baselineFileId:base.file.fileId,baselineSha256:base.file.sha256}).preservation.stableProtectedUnchanged,false);
 f.e.run('appPatchRow_("PLANS",{plan_id:"SYN-PL-1"},{people_csv:"変更された担当"},"owner");');
 const changed=f.file(f.read({baselineFileId:base.file.fileId,baselineSha256:base.file.sha256}));ok(changed.preservationComparison.result.protected.find(p=>p.planId==='SYN-PL-1').changedCategories.includes('identity_people'));cases++;
}
{
 const f=fixture();f.e.run('appReplaceRows_("FORECAST_MONTHLY",r=>!(r.plan_id==="SYN-PL-7"&&r.ym==="2026/04"),[]);');const a=f.read();eq(a.summary.forecastReady,44);eq(a.summary.complete,false);ok(a.summary.errors.some(x=>x.errors.includes('MONTHLY_RISK')));
 f.e.run('appPatchRow_("FORECAST_RUNS",{run_id:"SYN-RUN-8"},{objective_p10:5,objective_p50:0},"owner");');ok(f.read().summary.errors.some(x=>x.errors.includes('ANNUAL_RISK')));cases++;
}
{
 const f=fixture();f.e.run('const r=appReadTable_("FORECAST_RUNS").find(x=>x.run_id==="SYN-RUN-7"),p=JSON.parse(r.planning_json);p.annualTarget=0;p.halfTargets=[0,0];p.months.forEach(m=>{m.point=0;m.share=0;});appPatchRow_("FORECAST_RUNS",{run_id:r.run_id},{planning_json:JSON.stringify(p)},"owner");');
 ok(f.read().summary.errors.some(x=>x.errors.includes('POSITIVE_SOURCE_ALL_ZERO')));cases++;
}
{
 for(const mutate of[
 f=>f.ctx.user.isOwner=false,
 f=>f.e.run('const b=appProvisionalState_();b.active=true;appProvisionalSaveState_(b);'),
 f=>f.input.protectedPlanIds=['FOREIGN'],
 f=>f.input.protectedPlanIds=['SYN-PL-7'],
 f=>f.input.protectedPlanIds=['SYN-PL-0'],
 f=>f.e.run('appColumnsHash_=()=>"changed-schema";'),
 f=>f.input.protectedPlanIds=['SYN-PL-0','SYN-PL-0'],
 f=>f.input.baselineSha256='c'.repeat(64),
 f=>f.e.run('appJobList_=()=>[{status:"RUNNING"}];'),
 f=>f.e.run('appJournalPending_=()=>({id:"PENDING"});'),
 f=>f.e.run('appBulkState_=()=>({active:true});'),
 ]){const f=fixture();mutate(f);const before=f.store(),files=Object.keys(f.e.files).length;reject(()=>f.read(),/./);eq(f.store(),before);eq(Object.keys(f.e.files).length,files);}cases++;
}
{
 const f=fixture(),a=f.read(),before=f.store();reject(()=>f.read({baselineFileId:a.file.fileId,baselineSha256:'0'.repeat(64)}),/hash/);eq(f.store(),before);
 const wrong=f.e.call('appOfflineWriteFile_("foreign-baseline",{format:"PROVISIONAL_PERSISTED_READBACK_V1",fy:2025})');reject(()=>f.read({baselineFileId:wrong.fileId,baselineSha256:wrong.sha256}),/baseline scope/);cases++;
}
console.log('app-provisional-readback: '+cases+' cases / '+checks+' assertions PASS');
