#!/usr/bin/env node
/** 履歴のみ年額補正の未締めガード、分位点の整合、追加情報と数値残差のfallback。全て合成値。 */
import assert from 'node:assert/strict';
import {setUpEnv} from './gas-mock.mjs';
const env = setUpEnv();
const result = env.call(`(() => {
  const asOf = new Date('2026-04-06T12:00:00+09:00').getTime();
  const eng = appLegacyEngine_(appLegacyServices_({}, {asOfMs:asOf,seed:'test'}));
  const months = Array.from({length:48},(_,i)=>new Date(2022,3+i,1));
  const ctx = eng.getForecastContext_(2026,new Date(asOf),months);
  const sales = {headerMonths:months,baseSeries48:Array(48).fill(100),spotSeries48:Array(48).fill(50)};
  const anchor = eng.buildHistoryAnnualAnchor_(sales,ctx,{},false);
  const unavailable = eng.buildHistoryAnnualAnchor_(sales,eng.getForecastContext_(2026,new Date(2026,2,31),months),{},false);
  const disabledSpot = eng.buildHistoryAnnualAnchor_(sales,ctx,{spotBgCapRate:0},false);
  const dlm = eng.buildHistoryAnnualAnchor_(sales,ctx,{},true);
  const missing = eng.buildHistoryAnnualAnchor_({...sales,headerMonths:months.slice(1)},ctx,{},false);
  const badDates = {...sales,headerMonths:months.slice()}; badDates.headerMonths[47]=months[46];
  const invalid = eng.buildHistoryAnnualAnchor_(badDates,ctx,{},false);
  const baseModel = {intercept:100,slope:0,seasonalIndex:Array(12).fill(1)};
  const spot = {occurrenceProbByMonth:Array(12).fill(.6),severitySamplesByMonth:Array.from({length:12},()=>[50])};
  const opt = {nSim:1000,months:ctx.forecastMonths,residualPct:[-.2,0,.2],spotBgModel:spot,aiScores:{},tuning:{aiTotalNeutralThreshold:0}};
  const run = (a,extra={},m=baseModel) => appWithSeededRandom_('fixed',()=>eng.forecastMonteCarloMixed_(m,{...opt,...extra,historyAnnualAnchor:a}));
  const old = run(null), current = run(anchor);
  const annual = r => r.diagnostics.totalCalibratedSimByMonth[0].map((_,s)=>r.diagnostics.totalCalibratedSimByMonth.reduce((a,m)=>a+m[s],0));
  const median = r=>eng.percentile_(annual(r),.5);
  const known = {knownSpotProjectsByMonth:Array.from({length:12},()=>[{amount:100,confidence:1}])};
  const knownOld=run(null,known),knownNew=run(anchor,known);
  const human = run(anchor,{factorsClient:[{}]});
  const ai = run(anchor,{aiScores:{Market:1},aiWeight:.1});
  const calibration = run(anchor,{historyCalibrationNeutral:false});
  const tiny=run(anchor,{spotBgModel:{},residualPct:[0]},{intercept:.001,slope:0,seasonalIndex:Array(12).fill(1)});
  const zero=run(anchor,{spotBgModel:{},residualPct:[0]},{intercept:0,slope:0,seasonalIndex:Array(12).fill(1)});
  return {anchor,unavailable,disabledSpot,dlm,missing,invalid,oldMedian:median(old),newMedian:median(current),
    oldMonthly:old.p50,newMonthly:current.p50,diag:current.diagnostics.historyAnnualAnchor,
    knownEqual:JSON.stringify(knownOld.p50)===JSON.stringify(knownNew.p50),known:knownNew.diagnostics.historyAnnualAnchor,
    human:human.diagnostics.historyAnnualAnchor,ai:ai.diagnostics.historyAnnualAnchor,calibration:calibration.diagnostics.historyAnnualAnchor,tiny:tiny.diagnostics.historyAnnualAnchor,zero:zero.diagnostics.historyAnnualAnchor,
    allFinite:annual(tiny).every(Number.isFinite)&&annual(zero).every(Number.isFinite)};
})()`);
assert.equal(result.anchor.targetAnnual,1800);
assert.equal(result.anchor.trainingThroughYm,'2026/03');
assert.equal(result.disabledSpot.targetAnnual,1200);
for (const key of ['unavailable','dlm','missing','invalid']) assert.equal(result[key].eligible,false,key);
assert.equal(result.unavailable.targetAnnual,null,'未締め3月を0として年額に含めない');
assert.equal(result.diag.applied,true,'AI=0かつneutral threshold=0でも補正する');
assert.ok(Math.abs(result.newMedian-1800)<1e-8);
for(let i=0;i<12;i++) assert.ok(Math.abs(result.newMonthly[i]-result.oldMonthly[i]*1800/result.oldMedian)<1e-8,'同じsampleの月と年を補正');
assert.equal(result.knownEqual,true,'既知案件がある回は旧経路を維持し二重補正しない');
for(const key of ['known','human','ai']) {
  assert.equal(result[key].applied,false,key);
  assert.equal(result[key].fallbackReason,'additional_inputs_present',key);
}
assert.equal(result.tiny.fallbackReason,'sub_yen_baseline');
assert.equal(result.calibration.fallbackReason,'post_calibration_present');
assert.equal(result.calibration.applied,false);
assert.equal(result.zero.fallbackReason,'zero_or_invalid_baseline_median');
assert.equal(result.allFinite,true);
console.log('app-history-anchor: all tests passed');
