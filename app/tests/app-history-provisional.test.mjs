#!/usr/bin/env node
/** 暫定の履歴月額: 固定Wの数値契約・中立入力限定・旧MC不変・保存/再読込。金額はすべて合成。 */
import assert from 'node:assert/strict';
import {setUpEnv} from './gas-mock.mjs';

const METHOD='W_COMPONENT_EVENT_HALF_SHAPE_BLEND',ACTIVE='KK_NEVER_POSITIVE_CALENDAR_ENVELOPE',env=setUpEnv();
const r=env.call(`(() => {
 const fy=2026,asOf=new Date('2026-04-06T12:00:00+09:00').getTime();
 const e=appLegacyEngine_(appLegacyServices_({}, {asOfMs:asOf}));
 const months=Array.from({length:12},(_,m)=>new Date(fy,3+m,1)),headers=Array.from({length:48},(_,m)=>new Date(2022,3+m,1));
 // 古い上期の単発と、最近の下期案件。最新3年だけの四半期中央値では上期がすべて0になる。
 const rows=headers.map((d,i)=>({ym:(d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')),base:0,
   spot:i===5?120000:i%12===8?600000:i%12===11?900000:0}));
 const hist={headerMonths:headers,baseSeries48:rows.map(h=>h.base),spotSeries48:rows.map(h=>h.spot)};
 const ctx=e.getForecastContext_(fy,new Date(asOf),headers),anchor=e.buildHistoryAnnualAnchor_(hist,ctx,{},false);
 const opt={months,nSim:1000,residualPct:[0],spotBgModel:{occurrenceProbByMonth:Array(12).fill(.2),severitySamplesByMonth:Array.from({length:12},()=>[50])},
  historyAnnualAnchor:anchor,historySpotTiming:e.buildHistorySpotTiming_('合成暫定テスト')};
 const model={intercept:0,slope:0,seasonalIndex:Array(12).fill(1)};
 const run=(flag,extra={})=>appWithSeededRandom_('provisional-explicit-seed',()=>{
  const mixed=e.forecastMonteCarloMixed_(model,{...opt,...extra}),before=JSON.stringify(mixed);
  const p=e.buildHistoryMonthlyPlanning_(mixed,months,hist,{closedMonthMode:'forecast',provisionalHistoryPoint:flag});
  return {mixed,p,tail:Math.random(),unchanged:before===JSON.stringify(mixed)};
 });
 const off=run(false),on=run(true),before=JSON.stringify(rows),helper=e.appHistoryProvisionalForecast_(rows,fy),compact=e.appHistoryProvisionalCompact_(helper);
 const active=e.appHistoryInactiveCalendarForecast_(rows,fy);
 const zero=Array.from({length:12},()=>[0,0,0]),oldRiskZero={diagnostics:{...on.mixed.diagnostics,totalCalibratedSimByMonth:zero,quantOpsSimByMonth:zero}};
 const riskZero=e.buildHistoryMonthlyPlanning_(oldRiskZero,months,hist,{closedMonthMode:'forecast',provisionalHistoryPoint:true});
 const oldPoint=e.estimateHistoryMonthlyPoint_(months,hist,off.mixed.diagnostics.quantOpsSimByMonth,e.HISTORY_MONTHLY_POINT_METHOD);
 const disabled={};
 for(const[key,extra]of Object.entries({known:{knownSpotProjectsByMonth:Array.from({length:12},()=>[{amount:100,confidence:1}])},
   human:{factorsClient:[{}]},ai:{aiScores:{Market:1},aiWeight:.1},calibration:{historyCalibrationNeutral:false},
   dlm:{historyAnnualAnchor:e.buildHistoryAnnualAnchor_(hist,ctx,{},true)}}))disabled[key]=run(true,extra).p;
 disabled.actual=e.buildHistoryMonthlyPlanning_(on.mixed,months,hist,{closedMonthMode:'actual',sourceByMonth:Array(12).fill('actual_closed'),provisionalHistoryPoint:true});
 disabled.spotOff=e.buildHistoryMonthlyPlanning_({diagnostics:{...on.mixed.diagnostics,historyAnnualAnchor:{...anchor,componentBasis:'BASE'}}},months,hist,{provisionalHistoryPoint:true});
 const make=amount=>rows.map(h=>({...h,base:amount,spot:0}));
 const inactive=e.appHistoryProvisionalForecast_(make(0),fy),negative=e.appHistoryProvisionalForecast_(make(-1),fy),tiny=e.appHistoryProvisionalForecast_(make(.000001),fy);
 const credits=make(0);credits[47].base=-10;credits[46].spot=20;const credited=e.appHistoryProvisionalForecast_(credits,fy);
 let rejected=0;
 for(const h of[rows.slice().reverse(),rows.concat(rows[0]),rows.map((h,i)=>i===47?{...h,ym:'2026-04'}:h),rows.map((h,i)=>i===47?{...h,base:NaN}:h),
  rows.slice(-12),rows.map(h=>({...h,base:Number.MAX_VALUE,spot:Number.MAX_VALUE}))]){
  try{e.appHistoryProvisionalForecast_(h,fy);}catch(err){rejected++;}
 }
 const randomIndependent=appWithSeededRandom_('provisional-no-rng',()=>{e.appHistoryProvisionalForecast_(rows,fy);return Math.random();})===appWithSeededRandom_('provisional-no-rng',()=>Math.random());
 return {engineSource:e.SOURCE_SHA256,off:off.p,on:on.p,riskZero,helper:{method:helper.method,points:helper.points,total:helper.total,halfTargets:helper.halfTargets,applied:helper.applied,mode:helper.mode},compact,active:{points:active.points,total:active.total,halfTargets:active.halfTargets,eePoints:active.completeEE.points,profileYears:active.profileYears,neverPositiveMask:active.neverPositiveMask},
  mcExact:JSON.stringify(off.mixed)===JSON.stringify(on.mixed),tailExact:off.tail===on.tail,inputUnchanged:before===JSON.stringify(rows),pathsUnchanged:off.unchanged&&on.unchanged,
  oldOffPoints:oldPoint.points,disabled,inactive:{points:inactive.points,total:inactive.total},negative:{points:negative.points,total:negative.total},tiny:{points:tiny.points,total:tiny.total,net:tiny.net12},
  credited:{net:credited.net12,total:credited.total},rejected,randomIndependent};
})()`);
assert.equal(r.helper.method,METHOD);
assert.ok(r.helper.points.slice(0,6).some(v=>v>0),'疎履歴でも過去上期の根拠があれば上期の計画額を残す');
assert.ok(r.helper.total>0);
assert.equal(r.helper.applied,false,'形状を変えない完全S分岐を検証する合成例');
assert.equal(r.on.applied,true,'内部shapeの未適用と計画値の有効性を混同しない');
assert.equal(r.on.provisional,true);assert.equal(r.on.validationStatus,'in_progress');assert.equal(r.on.method,ACTIVE);
assert.deepEqual(r.on.months.map(m=>m.point),r.active.points);
assert.deepEqual(r.on.halfTargets,r.active.halfTargets);
assert.equal(r.on.annualTarget,r.active.total);assert.equal(r.on.annualBasis,'sum_monthly_points');
assert.deepEqual(r.active.profileYears,[2022,2023,2024,2025],'利用した全4年度を保持する');
assert.ok(r.active.points.every((v,m)=>v<=r.active.eePoints[m]));
assert.ok(r.active.points.slice(0,6).some(v=>v>0),'過去の上期根拠を残して上期全0へ戻さない');
assert.equal(r.off.method,'CAP_NET12_MC_BASE_SPOT_PHASE3_BETA_TIMING');assert.deepEqual(r.off.months.map(m=>m.point),r.oldOffPoints,'flag offは既存V5を保持');
assert.ok(r.off.months.slice(0,6).every(m=>m.point===0),'対照の旧方式は合成例の上期が全0');
assert.equal(r.mcExact,true,'flag on/offで全MC試行・分位点・診断配列が完全同一');
assert.equal(r.tailExact,true,'同じ明示seedのMC後の乱数列を変えない');
assert.equal(r.pathsUnchanged,true);assert.equal(r.inputUnchanged,true);assert.equal(r.randomIndependent,true);
assert.equal(r.riskZero.annualRawP50,0);assert.ok(r.riskZero.annualTarget>0,'旧月/年P50とMC平均0でも正の計画額を消さない');
assert.ok(r.riskZero.months.every(m=>m.mean===0),'計画値をMC期待額と偽称しない');
assert.ok(Buffer.byteLength(JSON.stringify(r.compact),'utf8')<=4000);
for(const[key,v]of Object.entries(r.disabled))assert.equal(v.applied,false,key+'は暫定の純履歴経路へ入れない');
for(const v of[r.inactive,r.negative]){assert.equal(v.total,0);assert.ok(v.points.every(n=>n===0));}
assert.ok(r.tiny.net>0&&r.tiny.net<1);assert.equal(r.tiny.total,0,'円未満には1円floorを足さない');
assert.equal(r.credited.net,10);assert.ok(r.credited.total>0,'返品後の成分netを活動判定へ使う');
assert.equal(r.rejected,6,'期間・重複・未来・非有限・不足・unsafe額を拒否');

// V2保存validator: 新しい暫定根拠を保ち、不正な半期額を隠して受理しない。
const valid=env.call('appPointNativePlanning_(__p,{sourceSha256:__sha},2026,0)',{__p:r.riskZero,__sha:r.engineSource});
assert.ok(valid);assert.equal(valid.provisional,true);assert.equal(valid.validationStatus,'in_progress');
assert.equal(valid.annualTarget,r.riskZero.annualTarget);assert.deepEqual(valid.halfTargets,r.riskZero.halfTargets);
assert.ok(Buffer.byteLength(JSON.stringify(valid),'utf8')<=4000);
for(const change of[
 p=>delete p.provisional,p=>{p.method=' '+METHOD+' ';delete p.provisional;},p=>p.provisional=false,p=>p.validationStatus='verified',p=>p.halfTargets[0]++,p=>p.halfTargets=[p.annualTarget,0],
 p=>p.provisionalWeights=[NaN,0],p=>p.provisionalWeights=[-.1,0],p=>p.provisionalFolds=[2026],p=>p.provisionalFolds=[2025,2024],p=>p.provisionalMode='unknown',
]){const p=structuredClone(r.riskZero);change(p);assert.equal(env.call('appForecastPlanningOf_(__p,2026,0)',{__p:p}),null);}
const yms=Array.from({length:12},(_,i)=>`${2026+Math.floor((i+3)/12)}/${String((i+3)%12+1).padStart(2,'0')}`);
for(const version of['HISTORY_MONTHLY_POINT_V1','HISTORY_MONTHLY_POINT_V2']){
 const p={version,applied:true,method:'SYNTHETIC_EXISTING_POINT',annualRawP50:1200,annualTarget:1200,annualBasis:version.endsWith('V2')?'sum_monthly_points':'annual_p50_rounded_yen',trainingThroughYm:'2026/03',months:yms.map(ym=>({ym,point:100,share:1/12,mean:100}))};
 assert.ok(env.call('appForecastPlanningOf_(__p,2026,1200)',{__p:p}),'旧V1/V2は引き続き有効');
}

// 本物のEngine→計算→保存journal→API経路。計画値は上で本物のWから算出、I/Oだけstub。
const SNAP=['snapshot_id','run_date','client','target_month','scenario','base_pred','subjective_adj','ai_adj','deterministic_adj','final_pred','confidence_interval_lower','confidence_interval_upper','key_factors_json','subjective_input_date','calibration_applied_json'];
function fixtureBook(e){
 const output=Array.from({length:79},()=>[]);output[0]=['FY2026 合成計画'];output[25]=['年度合計（予測）',0,0,500];output[64]=['年度合計（客観）',0,0,500];
 yms.forEach((ym,i)=>{output[28+i]=[ym,0,0,500,'','','',80,5];output[67+i]=[ym,0,0,500];});
 return e.makeBook('合成暫定計画',{CONFIG:{values:[['項目','値'],['メーカー名','合成暫定製薬'],['年度',2026],['担当者','合成担当']]},OUTPUT:{values:output},FORECAST_SNAPSHOT:{values:[SNAP]}});
}
for(const measure of[true,false]){
 const e=setUpEnv(),planId=e.seedPlan(fixtureBook(e));
 if(measure)e.task('setPlanPurpose(__in)',{__in:{planId,purpose:'MEASURE'}});
 e.run(`var __seenProvisional=[];appLegacyEngine_=function(svc){return{WEB_UI_CONFIRMS_:{},VERSION:'synthetic-provisional-io',SOURCE_SHA256:__engineSource,runPhase1Forecast(opt){
  __seenProvisional.push(opt.provisionalHistoryPoint===true);const p=opt.provisionalHistoryPoint?__planning:null,ss=svc.SpreadsheetApp.getActiveSpreadsheet(),sh=ss.getSheetByName('FORECAST_SNAPSHOT');
  sh.getRange(sh.getLastRow()+1,1,1,15).setValues([[svc.Utilities.getUuid(),new svc.Date(),'合成暫定製薬','2026/04','neutral',0,0,0,0,0,0,500,JSON.stringify(p?{monthly_point:{version:p.version,method:p.method,point:p.months[0].point,annualTarget:p.annualTarget}}:{}),'','{}']]);
  return{monthlyPlanning:p};}};};`,{__planning:valid,__engineSource:r.engineSource});
 const done=e.runJob('FORECAST.RUN',{planId});assert.equal(done.status,'DONE',done.error);
 const latest=e.call('apiForecastLatest(__in)',{__in:{planId}}),runs=e.table('FORECAST_RUNS');
 assert.deepEqual(e.call('__seenProvisional'),[measure],'MEASUREだけが明示opt-in');
 assert.equal(runs.length,1);assert.equal(e.table('FORECAST_MONTHLY').length,12);
 assert.ok(e.table('FORECAST_MONTHLY').every(m=>Number(m.p50)===0),'点計画額を旧中央値へ書き込まない');
 assert.equal(latest.stored.annual.p50,0);
 if(measure){
  assert.deepEqual(JSON.parse(runs[0].planning_json),valid);assert.deepEqual(latest.planning,valid);
  const journal=Object.values(e.files).filter(f=>/Journal_/.test(f.name)).map(f=>JSON.parse(f.content)).find(j=>j.ops.some(o=>o.table==='FORECAST_RUNS'));
  assert.ok(journal);assert.deepEqual(journal.ops.find(o=>o.table==='FORECAST_RUNS').rows[0].planning_json,valid);assert.ok(journal.ops.some(o=>o.table==='ENG_FORECAST_SNAPSHOT'),'同じ控えへsnapshotを保存');
  const restored=e.call('appForecastLatest_(__id)',{__id:planId});assert.deepEqual(restored.planning,valid,'再読込も保存した同じ計画値');
 }else{assert.equal(runs[0].planning_json,'');assert.equal(latest.planning,null,'通常計画は既存経路');}
}
console.log('app-history-provisional: all tests passed');
