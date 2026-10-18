#!/usr/bin/env node
/**
 * app-spot-history.test.mjs — BASE がゼロでも、確定した SPOT の履歴は統計予測に残す。
 * 合成 ZAC の SPOT 専業を空担当者・空主観の FY2026 MEASURE 計画で A-1 → A-2 → A-3 → A-9 と動かす。
 * 同月のゼロ年と新旧の重み、既存 BASE 上限、決定性、入力不変、STAT_ONLY との一致と 4/1 の未締め月を確認する。
 * 数字は作りもの。実 GAS と実データの確認は別。
 */
import assert from 'node:assert/strict';
import { setUpEnv, OWNER } from './gas-mock.mjs';

const env = setUpEnv();
const FY = 2026;
const CLIENT = 'スポット履歴テスト製薬';
const D = (y, m, d = 1) => new Date(y, m - 1, d);
const AS_OF = new Date('2026-10-17T12:00:00+09:00').getTime();
const months = Array.from({ length: 12 }, (_, i) => {
  const d = D(FY, 4 + i);
  return d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0');
});

// BASE 行は置かない。毎年の同じ月に SPOT があり、売上ゼロの月もある履歴。
// 直前の 3 月は大きくし、4/1 に未締めの 3 月を除く確認にも使う。
{
  const blank = Array(70).fill('');
  const sheets = {};
  for (let y = FY - 5; y <= FY + 1; y++) {
    const rows = [blank.map((_, i) => 'c' + (i + 1))];
    for (let m = 1; m <= 12; m++) {
      const dt = D(y, m, 15);
      if (dt < D(FY - 5, 4) || dt > D(FY + 1, 3, 31)) continue;
      const amount = m === 3 ? 2000000 + (y - FY + 5) * 150000 : (m % 3 === 0 ? 0 : 400000 + m * 10000 + (y - FY + 5) * 20000);
      if (amount === 0) continue;
      const r = blank.slice();
      r[40] = CLIENT; r[45] = 'スポット'; r[49] = '既存スポット'; r[56] = dt; r[65] = amount;
      rows.push(r);
    }
    sheets['*' + y + '_actual_value'] = { cols: 70, values: rows };
  }
  const zac = env.makeBook('合成 SPOT 専業の売上', sheets);
  env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
}
const made = env.runJob('PLAN.CREATE', { clientName: CLIENT, fy: FY, peopleCsv: '', purpose: 'MEASURE' });
assert.equal(made.status, 'DONE', made.error);
const planId = made.result.planId;
for (const action of ['IMPORT.SALES', 'SALES.AGGREGATE']) {
  const st = env.runJob('PLAN.RUN', { planId, action });
  assert.equal(st.status, 'DONE', action + ': ' + st.error);
}
const sales = env.table('ENG_SALES_INPUT').filter(r => r.plan_id === planId);
assert.ok(sales.length > 0);
assert.ok(sales.every(r => r.service_type === 'SPOT'), '入力は SPOT の売上だけ');
const view = env.call('apiPlanView(__in)', { __in: { planId } });
assert.deepEqual(view.boot.setup.people, []);
for (const kind of ['product', 'client', 'opinions', 'devspot']) assert.deepEqual(view.boot.input[kind], [], '主観・既知案件を補完しない: ' + kind);

const seedSheets = env.run('APP_FORECAST_SEED_SHEETS');
const snapshot = () => Object.fromEntries(['ENG_SHEETS', 'ENG_ROWS', 'ENG_FORMATS', ...seedSheets.map(s => 'ENG_' + s)]
  .map(table => [table, env.table(table).filter(r => r.plan_id === planId && (!r.sheet || seedSheets.includes(r.sheet)))]));
const before = snapshot();
function forecast() {
  let jobId = env.run(`appWithLock_(() => appEnqueueJob_('FORECAST.RUN', { planId: __p, asOfMs: __t }, __by, '').id)`,
    { __p: planId, __t: AS_OF, __by: OWNER });
  for (let i = 0; i < 60; i++) {
    env.fireTriggers('triggerRunJob');
    const st = env.call('apiJobStatus(__in)', { __in: { jobId } });
    if (st.status === 'CONTINUED') { jobId = st.nextJobId; continue; }
    if (st.status === 'QUEUED' || st.status === 'RUNNING') { jobId = st.jobId; continue; }
    assert.equal(st.status, 'DONE', st.error);
    assert.ok(st.result.runId, '確認の自動承認なしで予測を保存できる');
    return st.result;
  }
  throw new Error('予測が終わらない');
}
const numbers = runId => {
  const r = env.table('FORECAST_RUNS').find(x => x.run_id === runId);
  return { annual: [r.annual_p10, r.annual_p50, r.annual_p90].map(Number),
    objective: [r.objective_p10, r.objective_p50, r.objective_p90].map(Number),
    monthly: env.table('FORECAST_MONTHLY').filter(m => m.run_id === runId).sort((a, b) => a.ym.localeCompare(b.ym)) };
};
const bands = (rows, key) => rows.map(r => Number(r[key]));
const first = forecast();
const firstRun = env.table('FORECAST_RUNS').find(r => r.run_id === first.runId);
const n1 = numbers(first.runId);
// 本物のA-9 → Engine → 計算/保存ジョブで計画値と任意根拠が残る。分位点は別項目のまま。
const planning1 = JSON.parse(firstRun.planning_json);
assert.equal(planning1.version, 'HISTORY_MONTHLY_POINT_V2');
assert.equal(planning1.method, 'W_COMPONENT_EVENT_HALF_SHAPE_BLEND');
assert.equal(planning1.provisional,true);
assert.equal(planning1.validationStatus,'in_progress');
assert.equal(planning1.applied, true);
assert.deepEqual(planning1.months.map(m => m.ym), months);
assert.equal(planning1.annualRawP50, n1.annual[1]);
assert.equal(planning1.annualBasis, 'sum_monthly_points');
assert.equal(planning1.months.reduce((s, m) => s + m.point, 0), planning1.annualTarget);
assert.ok(planning1.months.every(m => Number.isSafeInteger(m.point) && m.point >= 0 && Number.isFinite(m.mean)));
assert.ok(planning1.months.some(m => m.point > 0));
assert.ok(planning1.provisionalWeights.length===2 && planning1.provisionalWeights.every(w=>w>=0 && w<=1));
assert.ok(planning1.provisionalFolds.length<=2 && planning1.provisionalFolds.every(y=>y<FY));
assert.deepEqual(planning1.halfTargets,[0,1].map(h=>planning1.months.slice(h*6,h*6+6).reduce((s,m)=>s+m.point,0)));
assert.ok(Buffer.byteLength(firstRun.planning_json) <= 4000);
assert.deepEqual(env.call('apiForecastLatest(__in)', {__in:{planId}}).planning, planning1);
assert.ok(n1.annual[1] > 0, 'BASE がゼロでも年間 P50 をゼロにしない');
assert.ok(n1.annual.every(Number.isFinite));
assert.ok(n1.annual[0] <= n1.annual[1] && n1.annual[1] <= n1.annual[2], '年間 P10 <= P50 <= P90');
assert.deepEqual(n1.monthly.map(m => m.ym), months);
assert.ok(n1.monthly.every(m => [m.p10, m.p50, m.p90].every(v => Number.isFinite(Number(v))) && Number(m.p10) <= Number(m.p50) && Number(m.p50) <= Number(m.p90)), '12 か月の予測と帯の順序');
const effects = env.table('LAYER_EFFECTS').filter(r => r.run_id === first.runId);
const historyEvidence = env.table('ENG_FORECAST_SNAPSHOT').filter(r => r.plan_id === planId)
  .map(r => JSON.parse(r.key_factors_json || '{}').history_model).filter(Boolean);
assert.ok(historyEvidence.some(r => r.version === 'HISTORY_ANNUAL_ANCHOR_V1' && r.applied), '履歴の方式・水準・補正倍率を保存する');
assert.ok(historyEvidence.some(r => r.spotTiming && r.spotTiming.applied && r.spotTiming.mix === .5), '月位置の混合条件もsnapshotへ保存する');
const neutral1 = env.table('ENG_FORECAST_SNAPSHOT').filter(r => r.plan_id === planId && r.scenario === 'neutral');
assert.equal(neutral1.length, 12);
for (const row of neutral1) {
  const month = n1.monthly.find(m => m.ym === row.target_month), point = planning1.months.find(m => m.ym === row.target_month);
  assert.equal(Number(row.final_pred), Number(month.p50), 'neutral snapshotは月中央値を維持');
  assert.deepEqual(JSON.parse(row.key_factors_json).monthly_point,
    {...point, version:planning1.version, method:planning1.method, annualTarget:planning1.annualTarget}, '計画値は別のsidecar');
}
assert.ok(Math.abs(n1.annual[1] - historyEvidence[0].targetAnnual) < 1e-6, '年間P50は直近12月の水準に一致');
assert.equal(effects.length, 12);
assert.ok(effects.every(r => ['human_yen', 'spot_yen', 'ai_yen'].every(k => Number(r[k]) === 0)), '履歴 SPOT を主観・既知 SPOT・AI の寄与にしない');
assert.ok(effects.some(r => Number(r.stat_p50) > 0), '履歴 SPOT は統計の土台に含む');
assert.deepEqual(snapshot(), before, '予測で売上・CONFIG・主観・AI の入力を変えない');
const second = forecast();
const secondRun = env.table('FORECAST_RUNS').find(r => r.run_id === second.runId);
const n2 = numbers(second.runId);
assert.notEqual(second.runId, first.runId);
assert.equal(secondRun.seed, firstRun.seed, '同じ入力は同じ乱数の種');
assert.deepEqual(n2.annual, n1.annual);
assert.deepEqual(n2.objective, n1.objective);
for (const key of ['p10', 'p50', 'p90', 'obj_p10', 'obj_p50', 'obj_p90']) assert.deepEqual(bands(n2.monthly, key), bands(n1.monthly, key), key + ' は再実行で一致');
assert.deepEqual(snapshot(), before);
assert.deepEqual(JSON.parse(secondRun.planning_json), planning1);

// 既存の予算下書きがある合成状態でも、本物A-9の計画値を予算へ転記せず従来の復元を通す。
// MEASUREは新規予算を作らないため、ここでは過去から存在する下書きをfixtureとして置く。
const budgetFixture = months.map((ym, i) => ({plan_id:planId,draft_id:'BDR-POINT-'+i,action_id:'OLD-BUDGET',ym,
  adopted:12345+i,uplift:20+i,basis:'MANUAL',prob:null,alloc:'MANUAL',run_id:second.runId,
  center:Number(n2.monthly[i].p50),actor_email:OWNER,saved_at:'2026-04-01T00:00:00+0900'}));
env.run('appWithLock_(() => appAppendLogRows_("BUDGET_DRAFTS",__rows))',{__rows:budgetFixture});
const budgetBefore = env.table('BUDGET_DRAFTS');
const third = forecast(), n3 = numbers(third.runId);
assert.deepEqual(n3.annual,n1.annual);
for (const key of ['p10','p50','p90','obj_p10','obj_p50','obj_p90']) assert.deepEqual(bands(n3.monthly,key),bands(n1.monthly,key),'予算と計画値を足しても予測帯は不変: '+key);
assert.deepEqual(env.table('BUDGET_DRAFTS'),budgetBefore,'新しい計画値から予算下書きを作らない');
assert.deepEqual(env.call('apiForecastLatest(__in)',{__in:{planId}}).planning,planning1);
const savedBudget = env.call('appWorkScratch_(appPlanOf_(__p)).getSheetByName("OUTPUT").getRange(29,8,12,2).getValues()',{__p:planId});
assert.deepEqual(savedBudget,budgetFixture.map(r=>[r.adopted,r.uplift]),'3段階の保存後も既存予算はそのまま');
assert.equal(third.budgetRestored,12);
assert.deepEqual(snapshot(),before,'計画値の保存で履歴入力を変えない');
// anchor/timing適用時でもSeasonal参照線は独立方式で、物差しと同じ定義を保つ。
const savedSeasonal = env.call(`(() => { const rows = {}; appReadPlanTable_('ENG_ROWS', __p)
  .filter(r => r.sheet === 'OUTPUT' && Number(r.col_from) === 1)
  .forEach(r => { rows[Number(r.row_no)] = JSON.parse(r.cells_json); });
  return Array.from({length:12},(_,i)=>{ const x=rows[29+i][5]; return appCellDecode_(x.charAt(0),x.slice(1)); });
})()`, {__p:planId});

/** 本番 A-9 と STAT_ONLY を同じ種・時点で動かす。閉じていない月のマスクは本番側にも同じ条件で渡す。 */
function cores(seed, asOfMs, closed = null) {
  return env.call(`(() => {
    APP_STORE_CACHE_ = {};
    const plan = appPlanOf_(__p), book = appWorkScratch_(plan);
    let st = null;
    do { st = appScratchBuildStep_(book, plan.plan_id, null, st && st.state, Date.now() + 60000); } while (!st.complete);
    const stat = appBacktestStatRun_(book, { fy: ${FY}, asOfMs: __t, seed: __s, closed: __k || undefined });
    const ctx = { actor: '', requestId: 'TEST', roles: [] };
    const eng = appLegacyEngine_(appLegacyServices_(book, { asOfMs: __t, seed: 'x', actor: '',
      triWeights: appTriWeights_(ctx, plan, __t).weights, effects: appEffForEngine_(appLearnEffects_(ctx, plan, __t)) }));
    const live = appWithSeededRandom_(__s, () => {
      eng.syncSalesFromSalesInput_(${FY}, __client);
      const sm = book.getSheetByName('SALES_MONTHLY');
      (__k || []).forEach((ok, k) => { if (!ok) for (let r = 2; r <= sm.getLastRow(); r++) sm.getRange(r, 2 + k).setValue(0); });
      return eng.runForecastFYCore_(${FY}, __client);
    });
    return { stat: stat, live: { p10: live.mixed.p10, p50: live.mixed.p50, p90: live.mixed.p90,
      base: live.baseSeries48, background: live.spotBackgroundByMonth, known: live.knownSpotExpectedByMonth } };
  })()`, { __p: planId, __client: CLIENT, __s: seed, __t: asOfMs, __k: closed });
}
const liveNow = cores(firstRun.seed, AS_OF);
assert.deepEqual(liveNow.stat.seasonal,savedSeasonal,'補正適用時も保存OUTPUTとBacktest.SEASONALの12月が一致');
assert.ok(liveNow.live.base.every(v => Number(v) === 0), 'BASE の正の推計に依存しない');
assert.ok(liveNow.live.background.some(v => v > 0));
assert.ok(liveNow.live.known.every(v => v === 0));
for (const key of ['p10', 'p50', 'p90']) {
  assert.deepEqual(liveNow.stat[key], liveNow.live[key], key + ': STAT_ONLY と空主観の本番 core が一致');
  assert.deepEqual(bands(n1.monthly, key), liveNow.live[key], key + ': 保存された本番予測と core が一致');
}

// 4/1 の物差しは、4/5 まで未締めの直前 3 月を使わず本番 core と同じ予測になる。
const cutoff = FY + '/04';
const closed = env.run('appBacktestClosed_(__c)', { __c: cutoff });
const statAsOf = env.run('appBacktestStatAsOf_(__c, __k)', { __c: cutoff, __k: closed });
assert.equal(closed.length, 48);
assert.equal(closed.filter(v => !v).length, 1);
assert.equal(closed[47], false);
const masked = cores('SPOT-APRIL-CLOSED', statAsOf, closed);
const cutoffAsOf = env.run('appBacktestAsOf_(__c)', { __c: cutoff });
const unmasked = cores('SPOT-APRIL-CLOSED', cutoffAsOf);
for (const key of ['p10', 'p50', 'p90']) assert.deepEqual(masked.stat[key], masked.live[key], key + ': 未締め 3 月を除く統計だけと本番 core が一致');
assert.notDeepEqual(masked.stat.spotBg, unmasked.stat.spotBg, '直前 3 月の SPOT を使うと背景推計が変わる');
assert.deepEqual(snapshot(), before, 'core と物差しの計算も保存入力に書き戻さない');

// 同月の四年が 100・0・0・0 と 0・0・0・100 なら、最近の実績を重くし、ゼロ年も含める。
// BASE が正の月の上限式と、capRate=0 の明示設定は保持する。
const models = env.call(`(() => {
  const eng = appLegacyEngine_(appLegacyServices_({}, { asOfMs: __t, seed: 'x' }));
  const start = new Date(${FY - 4}, 3, 1), end = new Date(${FY}, 2, 1);
  const cfg = { spotBgShrink: 0.35, spotBgFloorRate: 0.15, spotBgCapRate: 0.20,
    seasonalYearWeightY1: 0.10, seasonalYearWeightY2: 0.20, seasonalYearWeightY3: 0.30, seasonalYearWeightY4: 0.40 };
  const old = Array(48).fill(0), recent = Array(48).fill(0), full = Array(48).fill(100);
  old[0] = 100; recent[36] = 100;
  return { old: eng.fitSpotRecurringModel_(old, start, end, Array(12).fill(0), cfg),
    recent: eng.fitSpotRecurringModel_(recent, start, end, Array(12).fill(0), cfg),
    full: eng.fitSpotRecurringModel_(full, start, end, Array(12).fill(0), cfg),
    capped: eng.fitSpotRecurringModel_(full, start, end, Array(12).fill(100), cfg),
    disabled: eng.fitSpotRecurringModel_(full, start, end, Array(12).fill(0), Object.assign({}, cfg, { spotBgCapRate: 0 })) };
})()`, { __t: AS_OF });
assert.ok(models.recent.expectedByMonth[0] > models.old.expectedByMonth[0], '同額でも最近の年を重視');
assert.ok(models.recent.expectedByMonth[0] < models.full.expectedByMonth[0], '売上ゼロの三年を無視しない');
assert.ok(Math.abs(models.recent.expectedByMonth[0] - 40) < 1e-10, '0・0・0・100 の既存年重み。BASEへの補助用の縮小は掛けない');
assert.ok(Math.abs(models.recent.occurrenceProbByMonth[0] - 0.4) < 1e-10, '発生率もゼロ年込みの重みで計算');
assert.deepEqual(models.recent.severitySamplesByMonth[0], [100]);
assert.deepEqual(models.recent.severityWeightsByMonth[0], [0.4]);
assert.ok(models.capped.expectedByMonth.every(v => v === 20), 'BASE 100 の従来の 20% 上限');
assert.ok(models.capped.severitySamplesByMonth.every(a => a.every(v => v <= 20)));
assert.ok(models.disabled.expectedByMonth.every(v => v === 0), '明示的な背景無効化を維持');

// 売上なし・負値のみから正売上を作らず、古い単発を毎年確定の売上へ変えない。
// 抽選の平均がゼロ込みの加重期待額と一致し、既知案件は一度だけ加わる。
const edges = env.call(`(() => {
  const eng = appLegacyEngine_(appLegacyServices_({}, { asOfMs: __t, seed: 'x' }));
  const start = new Date(2022, 3, 1), end = new Date(2026, 2, 1), zero = Array(48).fill(0);
  const fit = (s, cfg) => eng.fitSpotRecurringModel_(s, start, end, Array(12).fill(0), cfg || {});
  const lone = zero.slice(), weighted = zero.slice();
  lone[0] = 100; weighted[0] = 100; weighted[36] = 200;
  const simulate = (spot, known) => appWithSeededRandom_('SPOT-EDGE', () => {
    const projects = Array.from({length:12}, (_, i) => i === 0 && known ? [{amount:1000, confidence:1}] : []);
    const r = eng.forecastMonteCarloMixed_({intercept:0, slope:0, seasonalIndex:Array(12).fill(1)}, {
      residualPct:[0], months:Array.from({length:12},(_,i)=>new Date(2026,3+i,1)), nSim:10000,
      spotBgModel:spot, knownSpotProjectsByMonth:projects, knownSpotBgSuppressRate:0.5 });
    const bg = r.diagnostics.bgSpotSimByMonth[0], total = r.diagnostics.totalCalibratedSimByMonth[0];
    return {p50:r.p50[0], bgMean:bg.reduce((a,b)=>a+b,0)/bg.length, min:Math.min(...total), max:Math.max(...total)};
  });
  const wm=fit(weighted);
  return { zero:fit(zero), negative:fit(Array(48).fill(-100)), lone:fit(lone),
    disabledYears:fit(Array(48).fill(100), {seasonalYearWeightY1:0,seasonalYearWeightY2:0,seasonalYearWeightY3:0,seasonalYearWeightY4:0}),
    loneSim:simulate(fit(lone)), weighted:wm, weightedSim:simulate(wm), knownSim:simulate(wm,true) };
})()`, {__t: AS_OF});
for (const key of ['zero', 'negative', 'disabledYears']) {
  assert.ok(edges[key].expectedByMonth.every(v => v === 0), key + ': 架空の正売上を作らない');
}
assert.equal(edges.loneSim.p50, 0, '古い一件だけなら中央値は0のまま');
assert.equal(edges.loneSim.max, 100, '一件を複数案件や増額した売上にしない');
assert.ok(edges.lone.occurrenceProbByMonth[0] <= 0.1 + 1e-12, '古い単発の低い発生率を保持');
assert.ok(Math.abs(edges.weighted.expectedByMonth[0] - 90) < 1e-10);
assert.ok(Math.abs(edges.weightedSim.bgMean - 90) < 4, '金額抽選の重みを二重に掛けない');
assert.ok(Math.abs(edges.knownSim.bgMean - 45) < 4, '既知案件発生時の背景抑制は1回だけ');
assert.equal(edges.knownSim.min, 1000, '既知確度1の金額を1回加える');
assert.equal(edges.knownSim.max, 1200, '履歴をBASEにも再加算しない');

console.log('app-spot-history: all tests passed');
