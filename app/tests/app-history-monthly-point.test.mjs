#!/usr/bin/env node
/** 月次点予測の整数配分・成分分離・0月・分位点不変を合成値で検証。 */
import assert from 'node:assert/strict';
import {setUpEnv} from './gas-mock.mjs';
const env=setUpEnv();
const r=env.call(`(() => {
  const asOf=new Date('2026-04-06T12:00:00+09:00').getTime();
  const eng=appLegacyEngine_(appLegacyServices_({}, {asOfMs:asOf,seed:'point-unit'}));
  const months=Array.from({length:12},(_,i)=>new Date(2026,3+i,1));
  const trainingMonths=Array.from({length:48},(_,i)=>new Date(2022,3+i,1));
  const ctx=eng.getForecastContext_(2026,new Date(asOf),trainingMonths);
  const spot48=Array(48).fill(0); spot48[24+5]=100;spot48[36+7]=200;spot48[36+11]=300;
  const hist={headerMonths:trainingMonths,baseSeries48:Array(48).fill(0),spotSeries48:spot48};
  const anchor=eng.buildHistoryAnnualAnchor_(hist,ctx,{},false);
  const opt={months,nSim:1000,residualPct:[0],spotBgModel:{occurrenceProbByMonth:Array(12).fill(.3),severitySamplesByMonth:Array.from({length:12},()=>[100])},
    historyAnnualAnchor:anchor,historySpotTiming:eng.buildHistorySpotTiming_('合成月次製薬')};
  const simulate=extra=>appWithSeededRandom_('month-point',()=>eng.forecastMonteCarloMixed_({intercept:0,slope:0,seasonalIndex:Array(12).fill(1)},{...opt,...extra}));
  const mixed=simulate(),before=JSON.stringify(mixed),planning=eng.buildHistoryMonthlyPlanning_(mixed,months,hist,{closedMonthMode:'forecast'});
  const next=withPlan=>appWithSeededRandom_('no-new-random',()=>{ if(withPlan)eng.buildHistoryMonthlyPlanning_(mixed,months,hist,{}); return Math.random(); });
  const disabled={};
  for(const [key,extra] of Object.entries({known:{knownSpotProjectsByMonth:Array.from({length:12},()=>[{amount:100,confidence:1}])},
    human:{factorsClient:[{}]},ai:{aiScores:{Market:1},aiWeight:.1},calibration:{historyCalibrationNeutral:false},
    unclosed:{historyAnnualAnchor:eng.buildHistoryAnnualAnchor_(hist,eng.getForecastContext_(2026,new Date(2026,2,31),trainingMonths),{},false)},
    dlm:{historyAnnualAnchor:eng.buildHistoryAnnualAnchor_(hist,ctx,{},true)}})) disabled[key]=eng.buildHistoryMonthlyPlanning_(simulate(extra),months,hist,{});
  const closed=eng.buildHistoryMonthlyPlanning_(mixed,months,hist,{closedMonthMode:'actual',sourceByMonth:Array(12).fill('actual_closed')});
  const spotDisabled=eng.buildHistoryMonthlyPlanning_({diagnostics:{...mixed.diagnostics,historyAnnualAnchor:{...anchor,componentBasis:'BASE'}}},months,
    {...hist,baseSeries48:Array(48).fill(100)},{});
  const matrix=Array.from({length:12},()=>[0,0,0]);
  const zero=eng.buildHistoryMonthlyPlanning_({diagnostics:{...mixed.diagnostics,totalCalibratedSimByMonth:matrix,quantOpsSimByMonth:matrix}},months,{...hist,spotSeries48:Array(48).fill(0)},{});
  const rootMatrix=Array.from({length:12},()=>[10,10,10]),zeroBase=rootMatrix.map(()=>[0,0,0]);
  const fallback=eng.buildHistoryMonthlyPlanning_({diagnostics:{...mixed.diagnostics,totalCalibratedSimByMonth:rootMatrix,quantOpsSimByMonth:zeroBase}},months,
    {baseSeries48:Array.from({length:48},(_,i)=>i===36?100:0),spotSeries48:Array(48).fill(0)},{});
  const negativeHist={baseSeries48:Array(48).fill(0),spotSeries48:spot48.slice()};negativeHist.spotSeries48[24+7]=-200;
  const negative=eng.buildHistoryMonthlyPlanning_(mixed,months,negativeHist,{});
  const invalid=eng.buildHistoryMonthlyPlanning_({diagnostics:{...mixed.diagnostics,totalCalibratedSimByMonth:Array(12).fill([NaN]),quantOpsSimByMonth:Array(12).fill([0])}},months,hist,{});
  const noHistory=eng.buildHistoryMonthlyPlanning_({diagnostics:{...mixed.diagnostics,totalCalibratedSimByMonth:rootMatrix,quantOpsSimByMonth:zeroBase}},months,
    {baseSeries48:Array(48).fill(0),spotSeries48:Array(48).fill(0)},{});
  let rejected=0;
  for(const [a,w] of [[1.5,Array(12).fill(1)],[100,Array(12).fill(0)],[100,Array(12).fill(-1)],[100,Array(12).fill(NaN)]]) {
    try{eng.allocateAnnualYen_(a,w);}catch(e){rejected++;}
  }
  return {method:eng.HISTORY_MONTHLY_POINT_METHOD,planning,unchanged:before===JSON.stringify(mixed),allMedianZero:mixed.p50.every(v=>v===0),
    independent:next(false)===next(true),disabled,closed,spotDisabled,zero,fallback,negative,invalid,noHistory,rejected,
    rounded:eng.allocateAnnualYen_(14,Array(12).fill(1)).points,
    sparse:eng.allocateAnnualYen_(7,[1,2,...Array(10).fill(0)]).points};
})()`);
assert.equal(r.method,'BASE_MC_SPOT_EWMA24');
assert.equal(r.planning.applied,true);
assert.equal(r.planning.annualTarget,500);
assert.equal(r.allMedianZero,true,'中央値0でも年額配分の点予測を作れる');
assert.deepEqual(r.planning.months.map(m=>m.point),[0,0,0,0,0,45,0,182,0,0,0,273],'SPOTは前々年1:直近2、未発生月の0は保持');
assert.equal(r.planning.months.reduce((s,m)=>s+m.point,0),500);
assert.equal(r.unchanged,true,'P10/P50/P90と全simulationを変えない');
assert.equal(r.independent,true);
for(const [k,v] of Object.entries(r.disabled)) assert.equal(v.applied,false,k);
assert.equal(r.closed.applied,false);
assert.equal(r.closed.reason,'closed_month_actual_view');
assert.equal(r.spotDisabled.applied,false,'明示的に除外したSPOTを点予測だけに再投入しない');
assert.equal(r.spotDisabled.reason,'background_spot_disabled');
assert.equal(r.zero.applied,true);
assert.equal(r.zero.annualTarget,0);
assert.ok(r.zero.months.every(m=>m.point===0));
assert.equal(r.fallback.baseProfileBasis,'last12_base','円未満のBASEの数値残差を増幅しない');
assert.deepEqual(r.fallback.months.map(m=>m.point),[120,...Array(11).fill(0)]);
assert.deepEqual(r.negative.months.map(m=>m.point),r.planning.months.map(m=>m.point),'成分分布は各年の月次netの正部分、年額は別のnet水準');
assert.equal(r.invalid.applied,false);
assert.equal(r.noHistory.applied,false);
assert.equal(r.noHistory.reason,'no_prior12_positive_sales');
assert.equal(r.rejected,4);
assert.deepEqual(r.rounded,[2,2,...Array(10).fill(1)],'端数tieは年度の早い月から');
assert.deepEqual(r.sparse,[2,5,...Array(10).fill(0)],'年額丸めで0share月へ金額を作らない');
console.log('app-history-monthly-point: all tests passed');
