import assert from 'node:assert/strict';
import { setUpEnv, OWNER, MEMBER } from './gas-mock.mjs';

let checks = 0; const cases = [];
const eq = (a,b,msg) => { checks++; assert.deepEqual(a,b,msg); };
const ok = (v,msg) => { checks++; assert.ok(v,msg); };
const task = (env,t) => { env.props.OWNER_TASK=JSON.stringify(t); return env.call('apiOwnerTask()').result; };
const status = env => task(env,{action:'provisionalStatus'});
const run = env => task(env,{action:'runProvisionalNow'});
function environment() {
  const env=setUpEnv();
  const sheets={}, blank=Array(70).fill('');
  for(let y=2022;y<=2026;y++) {
    const rows=[blank.map((_,i)=>'c'+i)];
    for(let m=1;m<=12;m++) {
      const r=blank.slice();r[40]='加速合成製薬';r[45]='ベース';r[49]='合成製品';r[56]=new Date(y,m-1,15);r[65]=1000000+m*1000;rows.push(r);
    }
    sheets['*'+y+'_actual_value']={cols:70,values:rows};
  }
  const book=env.makeBook('合成売上',sheets);
  env.task('saveSetting(__in)',{__in:{key:'source.zac_spreadsheet',value:'https://docs.google.com/spreadsheets/d/'+book.getId()+'/edit'}});
  env.run('CacheService.getScriptCache().put(APP_CANDIDATES_CACHE_KEY,JSON.stringify(["加速合成製薬"]),21600)');
  env.run(`const keys=['PLAN.CREATE','PLAN.CREATE_SAVE','PLAN.RUN:IMPORT.SALES','PLAN.RUN_CALC:IMPORT.SALES','PLAN.RUN_SAVE:IMPORT.SALES','PLAN.RUN:SALES.AGGREGATE','PLAN.RUN_CALC:SALES.AGGREGATE','PLAN.RUN_SAVE:SALES.AGGREGATE','FORECAST.RUN','FORECAST.RUN_CALC','FORECAST.RUN_SAVE']; appProps_().setProperty(APP_JOB_STAGE_PROP,JSON.stringify(Object.fromEntries(keys.map(k=>[k,[1]]))));`);
  return env;
}
const start = env => task(env,{action:'startProvisionalAll',fy:2026});
const root = env => env.call('appJobGet_(appProvisionalState_().current.rootJobId)');
const triggerIds = env => env.triggers.map(t=>t.uid).sort();

{
  const env=environment();
  eq(run(env).stoppedBecause,'BATCH_INACTIVE');
  env.task('saveMember(__in)',{__in:{email:MEMBER,displayName:'管理者'}});
  env.task('grantRole(__in)',{__in:{email:MEMBER,role:'ADMIN',scopeType:'ALL'}});
  env.as(MEMBER); checks++; assert.throws(()=>run(env),/権限/);
  checks++; assert.throws(()=>env.call('appProvisionalRunNow_()'),/所有者だけ/);
  env.as(OWNER); cases.push('inactive_and_owner_only');
}
{
  const env=environment(), j={kind:'PLAN.CREATE'};
  const admit=(elapsed,times)=>env.call('appProvisionalRunNowAdmission_(__j,__elapsed,__times)',{__j:j,__elapsed:elapsed,__times:{'PLAN.CREATE':times}});
  eq(admit(0,[140000]).ok,true,'exact 240s admission boundary');
  eq(admit(1,[140000]).ok,false);
  eq(admit(0,[1,10000,1]).needMs,45000,'max of latest three, not mean/latest');
  eq(admit(0,[]).reason,'UNKNOWN_STAGE_TIME');
  eq(admit(0,[1,2,3,4]).reason,'UNKNOWN_STAGE_TIME');
  eq(admit(0,[-1]).reason,'UNKNOWN_STAGE_TIME');
  eq(env.run('appProvisionalRunNowAdmission_({kind:"PLAN.CREATE"},0,{"PLAN.CREATE":[NaN]}).ok'),false);
  eq(env.run('appProvisionalRunNowAdmission_({kind:"PLAN.CREATE"},0,{"PLAN.CREATE":[Infinity]}).ok'),false);
  eq(admit(-1,[1]).reason,'CLOCK_CHANGED');
  cases.push('exact_budget_and_invalid_timing');
}
{
  const env=environment();start(env);
  const before=triggerIds(env), initial=root(env);
  env.run('appProps_().setProperty(APP_JOB_STAGE_PROP,"{}")');
  eq(run(env).stoppedBecause,'UNKNOWN_STAGE_TIME');eq(root(env).status,'QUEUED');eq(triggerIds(env),before);
  env.run('appProps_().setProperty(APP_JOB_STAGE_PROP,JSON.stringify({"PLAN.CREATE":[160000]}))');
  eq(run(env).stoppedBecause,'BUDGET');eq(root(env).id,initial.id);eq(root(env).attempts,0);
  cases.push('unknown_or_long_stage_preserves_scheduled_trigger');
}
{
  const env=environment(), initial=start(env), beforeIds=triggerIds(env);
  const r=run(env), s=status(env);
  eq(r.stoppedBecause,'BATCH_FINISHED');eq(s.items[0].status,'DONE');eq(s.active,false);
  eq(r.ran.length,11,'all native stages including transitions between four roots');
  eq(env.table('PLANS').length,1);eq(env.table('FORECAST_RUNS').length,1);eq(env.table('FORECAST_MONTHLY').length,12);
  const jobs=env.call('appJobList_().filter(j=>j.payload&&j.payload.provisionalBatchId===__id)',{__id:initial.id});
  ok(jobs.every(j=>j.status==='DONE'&&j.attempts===1));
  ok(jobs.every(j=>!triggerIds(env).includes(j.triggerUid)),'only ran native UIDs removed');
  ok(r.ran.every(j=>j.status==='DONE'&&j.intentId));
  eq(r.batchId,initial.id);ok(r.admissionBudgetMs===240000&&beforeIds.length>0);
  cases.push('real_native_chain_durable_save_api_and_post_cleanup');
}
{
  const env=environment();start(env);
  env.run(`__realNow=Date.now; __tick=__realNow(); Date.now=()=>__tick; __nativeRun=appRunJob_; appRunJob_=function(id){const r=__nativeRun(id);__tick+=80000;return r;};`);
  const r=run(env), s=status(env), pending=env.call('appProvisionalChain_(__id).job',{__id:s.current.rootJobId});
  eq(r.stoppedBecause,'BUDGET');eq(r.elapsedMs,240000);eq(r.ran.length,3);
  eq(pending.status,'QUEUED');ok(triggerIds(env).includes(pending.triggerUid));
  env.run('Date.now=__realNow');cases.push('budget_stops_between_stages_without_orphaning');
}
for(const condition of ['RUNNING','COMPETITOR','BAD_TOKEN']) {
  const env=environment();start(env);const j=root(env), before=triggerIds(env);
  if(condition==='RUNNING') env.run('const j=appJobGet_(__id);j.status="RUNNING";j.startedAt=new Date().toISOString();appJobSave_(j)',{__id:j.id});
  if(condition==='COMPETITOR') env.run('appEnqueueJob_("SYSTEM.HOUSEKEEPING",{},__owner,"")',{__owner:OWNER});
  if(condition==='BAD_TOKEN') env.run('const j=appJobGet_(__id);j.payload.provisionalIntentId="wrong";appJobSave_(j)',{__id:j.id});
  const allBefore=triggerIds(env), r=run(env);
  eq(r.stoppedBecause,{RUNNING:'CURRENT_RUNNING',COMPETITOR:'COMPETING_JOB',BAD_TOKEN:'INTENT_MISMATCH'}[condition]);
  eq(r.ran.length,0);eq(triggerIds(env),allBefore);eq(root(env).attempts,0);ok(before.length>0);
  cases.push(condition.toLowerCase()+'_does_not_dispatch');
}
{
  const env=environment();start(env);const j=root(env), before=triggerIds(env);
  env.run(`__nativeRun=appRunJob_;appRunJob_=function(id){const j=appJobGet_(id);j.status='RUNNING';j.startedAt=new Date().toISOString();appJobSave_(j);return __nativeRun(id);};`);
  const r=run(env);eq(r.stoppedBecause,'CLAIMED_ELSEWHERE');eq(r.ran.length,0);eq(triggerIds(env),before);eq(root(env).id,j.id);
  cases.push('atomic_claim_lost_keeps_trigger');
}
{
  const env=environment();start(env);
  env.run('appPlanCreateBuild_=function(){throw new Error("synthetic native failure")};');
  const r=run(env);eq(r.stoppedBecause,'JOB_FAILED');eq(r.ran.length,1);eq(status(env).items[0].status,'FAILED');eq(env.table('FORECAST_RUNS').length,0);
  cases.push('native_failure_uses_guarded_terminal_receipt');
}
{
  const env=environment();start(env);
  env.run('appForecastRunCalc_=function(){return {needConfirm:{key:"extreme",message:"synthetic confirmation"}}};');
  const r=run(env);eq(r.stoppedBecause,'CONFIRM');eq(status(env).items[0].status,'CONFIRM');eq(env.table('FORECAST_RUNS').length,0);
  cases.push('confirmation_never_auto_accepts');
}
{
  const env=environment();start(env);const j=root(env);
  env.run('ScriptApp.deleteTrigger=function(){throw new Error("synthetic cleanup failure")};');
  const r=run(env);eq(r.stoppedBecause,'CLEANUP_ERROR');eq(r.ran.length,1);eq(r.cleanupErrors.length,1);
  eq(env.call('appJobGet_(__id).status',{__id:j.id}),'DONE');ok(triggerIds(env).includes(j.triggerUid));
  const next=env.call('appProvisionalChain_(__id).job',{__id:j.id});eq(next.status,'QUEUED');ok(triggerIds(env).includes(next.triggerUid));
  cases.push('cleanup_failure_keeps_native_followup_trigger');
}

console.log('PASS app-provisional-run-now: '+cases.length+' cases, '+checks+' assertions');
