#!/usr/bin/env node
/** 全月0の再発、過大な年度配分、月位置の過信、返品・円未満の境界を合成値で検証。 */
import assert from 'node:assert/strict';
import {setUpEnv} from './gas-mock.mjs';
const env=setUpEnv();
const r=env.call(`(() => {
  const asOf=new Date('2026-04-06T12:00:00+09:00').getTime();
  const eng=appLegacyEngine_(appLegacyServices_({}, {asOfMs:asOf,seed:'point-unit'}));
  const months=Array.from({length:12},(_,i)=>new Date(2026,3+i,1));
  const headers=Array.from({length:48},(_,i)=>new Date(2022,3+i,1));
  const ctx=eng.getForecastContext_(2026,new Date(asOf),headers);
  const spot48=Array(48).fill(0);spot48[24+5]=100;spot48[36+7]=200;spot48[36+11]=300;
  const hist={headerMonths:headers,baseSeries48:Array(48).fill(0),spotSeries48:spot48};
  const anchor=eng.buildHistoryAnnualAnchor_(hist,ctx,{},false);
  const opt={months,nSim:1000,residualPct:[0],spotBgModel:{occurrenceProbByMonth:Array(12).fill(.3),severitySamplesByMonth:Array.from({length:12},()=>[100])},
    historyAnnualAnchor:anchor,historySpotTiming:eng.buildHistorySpotTiming_('合成月次製薬')};
  const simulate=extra=>appWithSeededRandom_('month-point',()=>eng.forecastMonteCarloMixed_({intercept:0,slope:0,seasonalIndex:Array(12).fill(1)},{...opt,...extra}));
  const mixed=simulate(),before=JSON.stringify(mixed);
  const plan=(h=hist,m=mixed)=>eng.buildHistoryMonthlyPlanning_(m,months,h,{closedMonthMode:'forecast'});
  const planning=plan(),zeroMatrix=Array.from({length:12},()=>[0,0,0]);
  const withPaths=(total,base=zeroMatrix)=>({diagnostics:{...mixed.diagnostics,totalCalibratedSimByMonth:total,quantOpsSimByMonth:base}});
  const allRiskZero=plan(hist,withPaths(zeroMatrix));
  const next=withPlan=>appWithSeededRandom_('no-new-random',()=>{if(withPlan)plan();return Math.random();});
  const disabled={};
  for(const [key,extra] of Object.entries({known:{knownSpotProjectsByMonth:Array.from({length:12},()=>[{amount:100,confidence:1}])},
    human:{factorsClient:[{}]},ai:{aiScores:{Market:1},aiWeight:.1},calibration:{historyCalibrationNeutral:false},
    unclosed:{historyAnnualAnchor:eng.buildHistoryAnnualAnchor_(hist,eng.getForecastContext_(2026,new Date(2026,2,31),headers),{},false)},
    dlm:{historyAnnualAnchor:eng.buildHistoryAnnualAnchor_(hist,ctx,{},true)}}))disabled[key]=plan(hist,simulate(extra));
  const closed=eng.buildHistoryMonthlyPlanning_(mixed,months,hist,{closedMonthMode:'actual',sourceByMonth:Array(12).fill('actual_closed')});
  const spotDisabled=plan(hist,{diagnostics:{...mixed.diagnostics,historyAnnualAnchor:{...anchor,componentBasis:'BASE'}}});
  const zeros={...hist,spotSeries48:Array(48).fill(0)};
  const inactive=plan(zeros,withPaths(zeroMatrix));
  const baseHistory={...zeros,baseSeries48:Array.from({length:48},(_,i)=>i===36?100:0)};
  const tiny=zeroMatrix.map((a,i)=>i<2?[.1,.1,.1]:a);
  const wholeYen=plan(baseHistory,withPaths(zeroMatrix,tiny));
  const capHistory={...zeros,baseSeries48:Array.from({length:48},(_,i)=>i>=36?10:0)};
  const large=zeroMatrix.map(()=>[1000,1000,1000]),capped=plan(capHistory,withPaths(large,large));
  const credit={...baseHistory,spotSeries48:Array.from({length:48},(_,i)=>i===36?-100:0)};
  const cancellation=plan(credit,withPaths(large,large));
  const sparseY=Array.from({length:48},(_,i)=>i>=24&&i<36?100:0);
  const boundaryDense=extra=>{const sp=sparseY.slice();if(extra)sp[36]=100;return plan({...zeros,spotSeries48:sp},withPaths(zeroMatrix));};
  const invalids=[{...hist,headerMonths:headers.slice().reverse()}, {...hist,headerMonths:headers.map((h,i)=>i===47?new Date(2026,3,1):h)},
    {...hist,headerMonths:headers.slice(36),baseSeries48:Array(12).fill(0),spotSeries48:spot48.slice(-12)},
    {...hist,spotSeries48:spot48.map((v,i)=>i===47?NaN:v)}].map(h=>plan(h));
  const shortHistory=n=>plan({headerMonths:headers.slice(-n),baseSeries48:hist.baseSeries48.slice(-n),spotSeries48:spot48.slice(-n)});
  const short24=shortHistory(24),partial30=shortHistory(30);
  const tiedMedian=.02*.5+.28*.5;
  const tinyTie=eng.estimateHistoryMonthlyPoint_(months,{...zeros,baseSeries48:Array(48).fill(100)},[[.02,.28],...Array.from({length:3},()=>[tiedMedian,tiedMedian]),...Array.from({length:8},()=>[0,0])],eng.HISTORY_MONTHLY_POINT_METHOD);
  const noHeaders=plan({...hist,headerMonths:[]});
  const badPath=plan(hist,withPaths(Array(12).fill([NaN])));
  const subSpot=Array(48).fill(0);subSpot[24]=1;subSpot[36]=1;
  const edge=plan({...zeros,spotSeries48:subSpot},withPaths(zeroMatrix));
  const subyen=plan({...zeros,spotSeries48:subSpot.map(v=>v*.1)},withPaths(zeroMatrix));
  const p=eng.historySpotTimingReliability_([Array(12).fill(0)],Array(12).fill(10),2025);
  const train=Array(12).fill(0);train[0]=1;const hold=Array(12).fill(0);hold[2]=1;
  const hit=eng.historySpotTimingReliability_([train],hold,2025);
  const hitLarge=eng.historySpotTimingReliability_([train],hold.map(v=>v*1e9),2025);
  let invalidRound=0;for(const raw of [Array(12).fill(NaN),Array(12).fill(-1),Array(12).fill(Number.MAX_SAFE_INTEGER)]){
    try{eng.roundMonthlyPointYen_(raw);}catch(e){invalidRound++;}}
  return {method:eng.HISTORY_MONTHLY_POINT_METHOD,planning,allRiskZero,unchanged:before===JSON.stringify(mixed),
    allMedianZero:mixed.p50.every(v=>v===0),independent:next(false)===next(true),disabled,closed,spotDisabled,inactive,wholeYen,capped,cancellation,
    dense:boundaryDense(true),sparse:boundaryDense(false),short24,partial30,tinyTie,invalids,noHeaders,badPath,edge,subyen,p,hit,hitLarge,invalidRound,
    rounded:eng.roundMonthlyPointYen_(Array(12).fill(.14)),cleanYears:planning.historyYearsUsed};
})()`);
assert.equal(r.method,'CAP_NET12_MC_BASE_SPOT_PHASE3_BETA_TIMING');
assert.equal(r.planning.version,'HISTORY_MONTHLY_POINT_V2');
assert.equal(r.planning.applied,true);
assert.equal(r.planning.annualTarget,67);
assert.equal(r.planning.annualBasis,'sum_monthly_points');
assert.deepEqual(r.planning.months.map(m=>m.point),[0,0,0,0,0,11,0,0,22,0,0,34]);
assert.deepEqual(r.cleanYears,[2023,2024,2025]);
assert.equal(r.planning.timingHeldoutFy,2025);
assert.deepEqual(r.planning.timingTrainingYears,[2023,2024]);
assert.equal(r.planning.timingSupport,1);
assert.equal(r.planning.timingHits,0);
assert.equal(r.planning.spotTimingWeight,1/3);
assert.equal(r.allMedianZero,true);
assert.equal(r.allRiskZero.annualRawP50,0);
assert.equal(r.allRiskZero.annualTarget,67,'旧月/年中央値とMC平均が0でも実績の正額を消さない');
assert.ok(r.allRiskZero.months.some(m=>m.point>0));
assert.equal(r.unchanged,true,'全MC試行とP10/P50/P90を変えない');
assert.equal(r.independent,true,'新しい点予測は乱数を消費しない');
for(const [key,v]of Object.entries(r.disabled))assert.equal(v.applied,false,key);
assert.equal(r.closed.reason,'closed_month_actual_view');
assert.equal(r.spotDisabled.reason,'background_spot_disabled');
assert.equal(r.inactive.applied,true);assert.equal(r.inactive.annualTarget,0);
assert.ok(r.inactive.months.every(m=>m.point===0),'休止会社に固定floorを足さない');
assert.equal(r.wholeYen.zeroRoundedFallback,'prior12_component_profile');
assert.deepEqual(r.wholeYen.months.map(m=>m.point),[100,...Array(11).fill(0)],'円未満MC残差から全0へ戻る場合は実在額へ戻す');
assert.equal(r.capped.annualRawP50,12000);assert.equal(r.capped.annualTarget,120,'BASEの過大化を直近成分netで抑え、年P50を使い切らない');
assert.ok(r.capped.months.every(m=>m.point===10));
assert.equal(r.cancellation.annualTarget,0,'BASEとSPOTの返品相殺後netを活動判定へ使う');
assert.equal(r.sparse.spotPointBasis,'history_quarter_median','12/24正額月は疎');
assert.equal(r.dense.spotPointBasis,'history_month_median','13/24正額月は密');
for(const invalid of [...r.invalids,r.noHeaders,r.badPath])assert.equal(invalid.applied,false,'不正/未観測の暦を埋めない');
assert.equal(r.short24.applied,true,'最低24月の契約: 完全2年度なら利用する');
assert.deepEqual(r.short24.historyYearsUsed,[2024,2025]);
assert.deepEqual(r.partial30.historyYearsUsed,[2024,2025],'最古不完全FYは除き、観測済みの完全2FYを保つ');
assert.deepEqual(r.tinyTie.points,[1,...Array(11).fill(0)],'固定検証の加重型medianと円順位tieを一致させる');
assert.equal(r.edge.timingRescue,'prior12_unweighted_profile');
assert.equal(r.edge.annualTarget,1,'実在する前年1円へ戻す境界。最低額の注入ではない');
assert.equal(r.subyen.annualTarget,0,'正netが円未満なら正直に円丸め0を許容');
assert.equal(r.p.support,0);assert.equal(r.p.weight,.5,'無支持は明示的Beta(1,1)事前値');
assert.equal(r.hit.support,1);assert.equal(r.hit.hits,1);assert.equal(r.hit.weight,2/3);
assert.deepEqual(r.hit,r.hitLarge,'hitは有無だけ。金額精度の校正とは主張しない');
assert.equal(r.invalidRound,3);
assert.equal(r.rounded.annualTarget,2);assert.deepEqual(r.rounded.points,[1,1,...Array(10).fill(0)]);
console.log('app-history-monthly-point: all tests passed');
