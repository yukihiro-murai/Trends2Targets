#!/usr/bin/env node
/** 履歴SPOTの月位置だけを混合する契約。顧客実績を含まない合成値。 */
import assert from 'node:assert/strict';
import {setUpEnv} from './gas-mock.mjs';
const env = setUpEnv();
const r = env.call(`(() => {
  const asOf = new Date('2026-04-06T12:00:00+09:00').getTime();
  const eng = appLegacyEngine_(appLegacyServices_({}, {asOfMs:asOf,seed:'timing-test'}));
  const policy=eng.buildHistorySpotTiming_('武田薬品工業(株)');
  const input=Array.from({length:12},(_,m)=>Array.from({length:1000},(_,s)=>m*1000+s));
  const before=JSON.stringify(input);
  const shifted=eng.redistributeHistorySpotTiming_(input,policy);
  const identity=eng.redistributeHistorySpotTiming_(input,{...policy,mix:0});
  const uniform=eng.redistributeHistorySpotTiming_(input,{...policy,mix:1});
  const phase=shifted.simByMonth[0].slice(0,4).map((v,s)=>(12-(v-s)/1000)%12);
  const annual=matrix=>matrix[0].map((_,s)=>matrix.reduce((a,row)=>a+row[s],0));
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  let invalidRejected=0;
  for(const [matrix,p] of [[Array(12).fill(null),policy],[input,{...policy,mix:2}],[input.map((a,i)=>i?a:[-1]),policy]]) {
    try { eng.redistributeHistorySpotTiming_(matrix,p); } catch(e) { invalidRejected++; }
  }
  const nextDraw=withTiming=>appWithSeededRandom_('independent',()=>{
    if(withTiming) eng.redistributeHistorySpotTiming_(input,policy);
    return Math.random();
  });
  const months=Array.from({length:48},(_,i)=>new Date(2022,3+i,1));
  const ctx=eng.getForecastContext_(2026,new Date(asOf),months);
  const sales={headerMonths:months,baseSeries48:Array(48).fill(100),spotSeries48:Array(48).fill(50)};
  const anchor=eng.buildHistoryAnnualAnchor_(sales,ctx,{},false);
  const model={intercept:100,slope:1,seasonalIndex:Array(12).fill(1)};
  const spot={occurrenceProbByMonth:Array.from({length:12},(_,i)=>i===5?.6:0),severitySamplesByMonth:Array.from({length:12},()=>[200])};
  const opt={nSim:1000,months:ctx.forecastMonths,residualPct:[-.2,0,.2],spotBgModel:spot,aiScores:{},historyAnnualAnchor:anchor};
  const run=(extra={})=>appWithSeededRandom_('same-draws',()=>eng.forecastMonteCarloMixed_(model,{...opt,...extra}));
  const old=run(),current=run({historySpotTiming:policy});
  const d=current.diagnostics,od=old.diagnostics;
  const bandsAgree=['p10','p50','p90'].every((key,i)=>current[key].every((v,m)=>
    Math.abs(v-eng.percentile_(d.totalCalibratedSimByMonth[m],[.1,.5,.9][i]))<1e-9));
  const guards={};
  for(const [name,extra] of Object.entries({
    known:{knownSpotProjectsByMonth:Array.from({length:12},()=>[{amount:100,confidence:1}])},
    human:{factorsClient:[{}]},ai:{aiScores:{Market:1},aiWeight:.1},
    calibration:{historyCalibrationNeutral:false},
    unclosed:{historyAnnualAnchor:eng.buildHistoryAnnualAnchor_(sales,eng.getForecastContext_(2026,new Date(2026,2,31),months),{},false)},
    dlm:{historyAnnualAnchor:eng.buildHistoryAnnualAnchor_(sales,ctx,{},true)}
  })) {
    const a=run(extra), b=run({...extra,historySpotTiming:policy});
    guards[name]={same:same(a.p50,b.p50),timing:b.diagnostics.historySpotTiming};
  }
  const baseOnly=run({spotBgModel:{},historySpotTiming:policy});
  const tinyModel={intercept:.001,slope:0,seasonalIndex:Array(12).fill(1)};
  const tinySpot={occurrenceProbByMonth:Array(12).fill(1),severitySamplesByMonth:Array.from({length:12},()=>[.001])};
  const tiny=appWithSeededRandom_('tiny',()=>eng.forecastMonteCarloMixed_(tinyModel,{...opt,residualPct:[0],spotBgModel:tinySpot,historySpotTiming:policy}));
  return {policy,phase,immutable:before===JSON.stringify(input),identity:same(input,identity.simByMonth),
    uniform:uniform.phaseCounts,conserved:same(annual(input),annual(shifted.simByMonth)),
    independent:nextDraw(false)===nextDraw(true),invalidRejected,
    baseSame:same(od.quantOpsSimByMonth,d.quantOpsSimByMonth),
    annualMax:Math.max(...annual(od.totalCalibratedSimByMonth).map((v,s)=>Math.abs(v-annual(d.totalCalibratedSimByMonth)[s]))),
    bandsAgree,timing:d.historySpotTiming,snapshot:d.historyAnnualAnchor.spotTiming,guards,
    baseOnly:baseOnly.diagnostics.historySpotTiming,tiny:tiny.diagnostics};
})()`);
assert.equal(r.policy.seed,2335657416,'SHA256 LE32 (GASの符号付きbyteを含む)');
assert.deepEqual(r.phase,[9,1,11,9],'凍結した独立乱数の最初の4位相');
for(const key of ['immutable','identity','conserved','independent','baseSame','bandsAgree']) assert.equal(r[key],true,key);
assert.equal(r.invalidRejected,3);
assert.ok(r.uniform.every(n=>n>45&&n<125),'mix=1は元位相も含む全12位相');
assert.ok(r.annualMax<1e-8,'各pathの年度合計保持');
assert.equal(r.timing.applied,true);
assert.equal(r.timing.mix,.5);
assert.deepEqual(r.snapshot,r.timing,'保存用年額metadataへ時期の仮定を記録');
for(const [name,g] of Object.entries(r.guards)) {
  assert.equal(g.same,true,name);
  assert.equal(g.timing.applied,false,name);
}
assert.equal(r.baseOnly.applied,false);
assert.equal(r.baseOnly.fallbackReason,'no_background_spot');
assert.equal(r.tiny.historyAnnualAnchor.applied,false);
assert.equal(r.tiny.historyAnnualAnchor.fallbackReason,'sub_yen_baseline');
assert.equal(r.tiny.historySpotTiming.applied,true,'年額倍率を使えない小額分布でも時期の移動は安全');
console.log('app-history-spot-timing: all tests passed');
