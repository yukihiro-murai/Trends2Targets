/** 計画用月額は予測帯とは別に同じ予測の控えへ保存し、旧回を補完しない。 */
import assert from 'node:assert/strict';
import { J, makeEnv, OWNER, setUpEnv } from './gas-mock.mjs';

const months = Array.from({ length: 12 }, (_, i) => `${i < 9 ? 2026 : 2027}/${String((i + 3) % 12 + 1).padStart(2, '0')}`);
const point = () => ({ version: 'HISTORY_MONTHLY_POINT_V1', applied: true, method: 'TEST_EXPECTATION_SHARE',
  annualRawP50: 1000.4, annualTarget: 1000, trainingThroughYm: '2026/03',
  months: months.map((ym, i) => ({ ym, point: i < 4 ? 84 : 83, share: 1 / 12, mean: 100 + i })) });
const pointV2 = () => ({ version: 'HISTORY_MONTHLY_POINT_V2', applied: true, method: 'TEST_HISTORY_COMPONENT_POINT',
  annualRawP50: 1000.4, annualTarget: 1200, annualBasis: 'sum_monthly_points', trainingThroughYm: '2026/03',
  months: months.map(ym => ({ ym, point: 100, share: 1 / 12, mean: 0 })) });
const SNAP = ['snapshot_id', 'run_date', 'client', 'target_month', 'scenario', 'base_pred', 'subjective_adj', 'ai_adj', 'deterministic_adj', 'final_pred',
  'confidence_interval_lower', 'confidence_interval_upper', 'key_factors_json', 'subjective_input_date', 'calibration_applied_json'];
function book(env) {
  const output = Array.from({ length: 79 }, () => []);
  output[0] = ['FY2026 売上予測（テスト製薬）'];
  output[25] = ['年度合計（予測）', 800, 1000.4, 1200];
  output[64] = ['年度合計（客観）', 800, 1000.4, 1200];
  months.forEach((ym, i) => { output[28 + i] = [ym, 0, 0, 500, '', '', '', 80, 5]; output[67 + i] = [ym, 0, 0, 500]; });
  return env.makeBook('テスト予測', {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', 'テスト製薬'], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '担当A']] },
    OUTPUT: { values: output },
    FORECAST_SNAPSHOT: { values: [SNAP, ['OLD', new Date(2026, 2, 1), 'テスト製薬', '2026/04', 'neutral', 0, 0, 0, 0, 0, 0, 500, '{}', '', '{}']] },
  });
}
function stub(env, planning, annual = 1000.4) {
  env.run(`appLegacyEngine_ = function(svc) { return { WEB_UI_CONFIRMS_: {}, VERSION: 'planning-stub', SOURCE_SHA256: 'stub',
    runPhase1Forecast() {
      const ss = svc.SpreadsheetApp.getActiveSpreadsheet(), out = ss.getSheetByName('OUTPUT');
      out.getRange(26, 1, 1, 4).setValues([['年度合計（予測）', Math.min(800,__annual), __annual, Math.max(1200,__annual)]]);
      for (let i = 0; i < 12; i++) out.getRange(29+i, 1, 1, 9).setValues([[__months[i], 0, 0, 500, '', '', '', 0, '']]);
      const snap = ss.getSheetByName('FORECAST_SNAPSHOT');
      const sidecar = __point && __point.applied === true ? {monthly_point:{version:__point.version,method:__point.method,
        point:__point.months[0].point,share:__point.months[0].share,mean:__point.months[0].mean,annualTarget:__point.annualTarget}} : {};
      snap.getRange(snap.getLastRow()+1, 1, 1, 15).setValues([[svc.Utilities.getUuid(),new svc.Date(),'テスト製薬','2026/04','neutral',0,0,0,0,0,0,500,JSON.stringify(sidecar),'','{}']]);
      return __point === undefined ? undefined : {monthlyPlanning:__point};
    } }; };`, { __point: planning, __months: months, __annual: annual });
}
function imported(planning = point()) {
  const env = setUpEnv(), planId = env.seedPlan(book(env));
  stub(env, planning);
  return { env, planId };
}
function throughCalc(env, planId) {
  delete env.props.APP_STAGE_MS;   // 既知の所要時間による段の直結を止め、保存前の引数を検査する
  const start = env.call('apiStartJob(__in)', { __in: { kind: 'FORECAST.RUN', payload: { planId } } });
  env.fireTriggers('triggerRunJob');
  env.fireTriggers('triggerRunJob');
  const st = env.call('apiJobStatus(__in)', { __in: { jobId: start.jobId } });
  assert.equal(st.kind, 'FORECAST.RUN_SAVE', JSON.stringify(st));
  assert.equal(st.status, 'QUEUED', JSON.stringify(st));
  const job = env.call('appJobGet_(__id)', { __id: st.jobId });
  return { start, job };
}
const latest = (env, planId) => env.call('apiForecastLatest(__in)', { __in: { planId } });

// Engine → 計算ジョブ → 同じ保存の控え → API。巨大な試行や余分なキーを保存しない。
{
  const raw = point();
  raw.paths = Array.from({ length: 1000 }, () => Array(12).fill(123));
  raw.months[0].paths = raw.paths;
  const { env, planId } = imported(raw), { start, job } = throughCalc(env, planId);
  assert.deepEqual(job.payload.planning, point());
  assert.ok(Buffer.byteLength(JSON.stringify(job)) < 8000, '処理の引数は12月の要約だけ');
  env.fireTriggers('triggerRunJob');
  const done = env.call('apiJobStatus(__in)', { __in: { jobId: start.jobId } });
  assert.equal(done.status, 'DONE', done.error);
  const runs = env.table('FORECAST_RUNS'), monthly = env.table('FORECAST_MONTHLY');
  assert.equal(runs.length, 1);
  assert.deepEqual(JSON.parse(runs[0].planning_json), point());
  assert.equal(monthly.length, 12);
  assert.ok(monthly.every(m => m.p50 === '0' && m.obj_p50 === '0'), '中央値と客観予測は計画値で書き換えない');
  assert.deepEqual(latest(env, planId).planning, point());
  assert.deepEqual(latest(env, planId).stored.annual, { p10: 800, p50: 1000.4, p90: 1200 });
  assert.ok(latest(env, planId).stored.monthly.every(m => m.p50 === 0));
  assert.equal(env.table('LAYER_EFFECTS').length, 12);
  assert.ok(env.table('LAYER_EFFECTS').every(m => Number(m.final_p50) === 0), '層の効きは従来の中央値');
  const snap = env.table('ENG_FORECAST_SNAPSHOT');
  assert.equal(snap.length, 2);
  assert.ok(snap.every(r => r.final_pred === '0'), 'neutral snapshotは中央値を保持');
  assert.equal(JSON.parse(snap[1].key_factors_json).monthly_point.point, 84, '計画値のsidecarをそのまま保存');
  const journal = Object.values(env.files).filter(f => /Journal_/.test(f.name)).map(f => JSON.parse(f.content)).find(j => j.ops.some(o => o.table === 'FORECAST_RUNS'));
  assert.ok(journal);
  assert.deepEqual(journal.ops.find(o => o.table === 'FORECAST_RUNS').rows[0].planning_json, point());
  assert.ok(journal.ops.some(o => o.table === 'ENG_FORECAST_SNAPSHOT'), 'snapshotと同じ控え');
  assert.ok(env.table('BUDGET_DRAFTS').length > 0, '既存の予算下書きは保持');
  const output = env.run('appWorkScratch_(appPlanOf_(__id)).getSheetByName("OUTPUT").getRange(29,8,12,2).getValues()', { __id: planId });
  assert.ok(output.every(r => r[0] === 80 && r[1] === 5), '計画値を予算に転記しない');
}

// 計画値が対象外・旧返り値の場合は保存/表示しない。非ゼロ年度中央値からの補完もしない。
for (const raw of [null, undefined, { version: 'HISTORY_MONTHLY_POINT_V1', applied: false, reason: 'additional_inputs' }]) {
  const { env, planId } = imported(raw);
  // 引数省略は imported の既定値になるため、undefinedの旧返り値を明示する。
  stub(env, raw);
  const done = env.runJob('FORECAST.RUN', { planId });
  assert.equal(done.status, 'DONE', done.error);
  assert.equal(env.table('FORECAST_RUNS')[0].planning_json, '');
  assert.equal(latest(env, planId).planning, null);
  assert.equal(latest(env, planId).latest.annual_p50, 1000.4);
}

// 不正な保存内容はAPIで破棄する。直前の正常な回や月中央値から補完しない。
{
  const { env, planId } = imported();
  assert.equal(latest(env, planId).planning, null, '旧取り込みには計画値無し');
  assert.equal(env.runJob('FORECAST.RUN', { planId }).status, 'DONE');
  const sh = env.data().getSheetByName('FORECAST_RUNS'), col = sh.rows[0].indexOf('planning_json');
  const first = [...sh.rows[1]], newer = [...first];
  newer[0] = 'NEWER'; newer[sh.rows[0].indexOf('finished_at')] = '9999-01-01'; sh.rows.push(newer);
  const invalid = [
    ['old', ''], ['json', '{'], ['version', { ...point(), version: 'OTHER' }],
    ['not-applied', { ...point(), applied: false }], ['empty-method', { ...point(), method: ' ' }],
    ['method-type', { ...point(), method: 12 }], ['missing', { ...point(), months: point().months.slice(1) }],
    ['duplicate', { ...point(), months: point().months.map((m, i, a) => i === 1 ? a[0] : m) }],
    ['wrong-year', { ...point(), months: point().months.map((m, i) => i ? m : { ...m, ym: '2025/04' }) }],
    ['negative', { ...point(), months: point().months.map((m, i) => i ? m : { ...m, point: -1 }) }],
    ['fraction', { ...point(), months: point().months.map((m, i) => i ? m : { ...m, point: 84.5 }) }],
    ['bad-sum', { ...point(), months: point().months.map((m, i) => i ? m : { ...m, point: 85 }) }],
    ['negative-mean', { ...point(), months: point().months.map((m, i) => i ? m : { ...m, mean: -1 }) }],
    ['negative-share', { ...point(), months: point().months.map((m, i) => i ? m : { ...m, share: -1 }) }],
    ['bad-share-sum', { ...point(), months: point().months.map(m => ({ ...m, share: 0 })) }],
    ['annual-mismatch', { ...point(), annualRawP50: 1000.6, annualTarget: 1001 }],
    ['future-training', { ...point(), trainingThroughYm: '2026/04' }],
  ];
  for (const [label, value] of invalid) {
    newer[col] = typeof value === 'string' ? value : JSON.stringify(value);
    sh.rows[2] = [...newer]; env.run('APP_STORE_CACHE_ = {}; appBumpGen_();');
    assert.equal(latest(env, planId).planning, null, label);
  }
  assert.equal(sh.rows[1][col], first[col], '正常な過去回は変更しない');
  for (const value of [NaN, Infinity, -Infinity]) {
    const raw = point(); raw.annualRawP50 = value;
    assert.equal(env.run('appForecastPlanningOf_(__raw,2026,1000.4)', { __raw: raw }), null);
  }
  const zero = point(); zero.annualRawP50 = 0; zero.annualTarget = 0;
  zero.months = zero.months.map(m => ({ ...m, point: 0, share: 0, mean: 0 }));
  assert.deepEqual(env.call('appForecastPlanningOf_(__raw,2026,0)', { __raw: zero }), zero);
  assert.deepEqual(env.call('appForecastPlanningOf_(__raw,2026,1000.4)', { __raw: { ...point(), months: point().months.reverse() } }), point());
}

// 任意の根拠は旧shapeを必須変更せず、小さな検証済み項目だけを保存/APIへ返す。
{
  const evidence = { componentBasis: 'positive_month_net_BASE_SPOT_last12', baseAnnualPositive: 300, spotAnnualPositive: 700,
    baseWeight: .3, baseProfileBasis: 'mc_base_mean', annualBasis: 'annual_p50_rounded_yen' };
  const raw = { ...point(), ...evidence }, { env, planId } = imported(raw);
  const { start, job } = throughCalc(env, planId);
  assert.deepEqual(job.payload.planning, raw);
  assert.ok(Buffer.byteLength(JSON.stringify(job.payload.planning)) <= 4000);
  env.fireTriggers('triggerRunJob');
  assert.equal(env.call('apiJobStatus(__in)', { __in: { jobId: start.jobId } }).status, 'DONE');
  assert.deepEqual(JSON.parse(env.table('FORECAST_RUNS')[0].planning_json), raw);
  assert.deepEqual(latest(env, planId).planning, raw);
  const clean = value => env.call('appForecastPlanningOf_(__raw,2026,1000.4)', { __raw: value });
  for (const [key, value] of [['componentBasis', 'other'], ['baseAnnualPositive', -1], ['spotAnnualPositive', Infinity],
    ['baseWeight', 2], ['baseProfileBasis', 'other'], ['annualBasis', 5]]) {
    const out = clean({ ...raw, [key]: value });
    assert.ok(out && !(key in out), '不正なoptionalのみ除外: ' + key);
    assert.deepEqual(out.months, point().months, '有効な計画値は保持: ' + key);
  }
  assert.equal(clean({ ...raw, baseWeight: .4 }).baseWeight, undefined, '成分額の比率と違うweightは除外');
  assert.equal(clean({ ...point(), baseWeight: .4 }).baseWeight, .4, 'optionalの一部だけでも保持');
  assert.equal(clean({ ...raw, baseAnnualPositive: 0, spotAnnualPositive: 0, baseWeight: 0 }).baseWeight, 0);
  assert.equal(clean({ ...raw, baseAnnualPositive: 0, spotAnnualPositive: 0, baseWeight: .4 }).baseWeight, undefined);
  assert.equal(clean({ ...raw, baseAnnualPositive: 1e308, spotAnnualPositive: 1e308 }).baseWeight, undefined, '成分合計のoverflowを比率に使わない');
  assert.equal(clean({ ...raw, baseProfileBasis: 'last12_base' }).baseProfileBasis, 'last12_base');
  assert.deepEqual(clean(point()), point(), '旧shapeへoptionalを補完しない');
}

// V2: 年額は12月の点予測合計。旧V1と旧年度P50をそのまま保持し、同じEngine/保存/API経路を通す。
{
  const { env, planId } = imported();
  assert.equal(env.runJob('FORECAST.RUN', { planId }).status, 'DONE');
  const v1row = env.table('FORECAST_RUNS')[0];
  assert.deepEqual(latest(env, planId).planning, point());
  const metadata = { cleanHistoryStartYm: '2022/04', historyYearsUsed: [2023, 2024, 2025],
    basePointBasis: 'mc_base_p50', spotPointBasis: 'history_quarter_median', spotPositiveMonths24: 6,
    spotQuarterPhase: 3, baseFallback: 'none', spotFallback: 'quarter_mean', zeroRoundedFallback: 'prior12_component_profile', inactive: false };
  const expected = { ...pointV2(), ...metadata }, raw = { ...expected, paths: Array(1000).fill(Array(12).fill(1)) };
  stub(env, raw);
  const { start, job } = throughCalc(env, planId);
  assert.deepEqual(job.payload.planning, expected);
  assert.ok(Buffer.byteLength(JSON.stringify(job.payload.planning)) <= 4000);
  env.fireTriggers('triggerRunJob');
  assert.equal(env.call('apiJobStatus(__in)', { __in: { jobId: start.jobId } }).status, 'DONE');
  const runs = env.table('FORECAST_RUNS'), v2row = runs[1];
  assert.deepEqual(runs[0], v1row, '既存V1を新しい年度定義で書き換えない');
  assert.deepEqual(JSON.parse(v2row.planning_json), expected);
  assert.deepEqual(latest(env, planId).planning, expected);
  assert.equal(latest(env, planId).latest.annual_p50, 1000.4, '旧年度P50と計画年額1200を別に保持');
  assert.ok(latest(env, planId).monthly.every(m => m.p50 === 0), '月P50をV2点予測で書き換えない');
  assert.ok(env.table('LAYER_EFFECTS').every(r => Number(r.final_p50) === 0));
  assert.equal(JSON.parse(env.table('ENG_FORECAST_SNAPSHOT').at(-1).key_factors_json).monthly_point.version, 'HISTORY_MONTHLY_POINT_V2');
  const budgets = env.run('appWorkScratch_(appPlanOf_(__p)).getSheetByName("OUTPUT").getRange(29,8,12,2).getValues()', { __p: planId });
  assert.ok(budgets.every(r => r[0] === 80 && r[1] === 5));
  const journal = Object.values(env.files).filter(f => /Journal_/.test(f.name)).map(f => JSON.parse(f.content))
    .find(j => j.ops.some(o => o.table === 'FORECAST_RUNS' && o.rows.some(r => r.run_id === v2row.run_id)));
  assert.deepEqual(journal.ops.find(o => o.table === 'FORECAST_RUNS').rows[0].planning_json, expected);
  assert.ok(JSON.parse(v2row.fixes_json).includes('HISTORY_MONTHLY_POINT_V1'));
  assert.ok(JSON.parse(v2row.fixes_json).includes('HISTORY_MONTHLY_POINT_V2'));
  const clean = value => env.call('appForecastPlanningOf_(__raw,2026,1000.4)', { __raw: value });
  for (const [key, value] of [['cleanHistoryStartYm', '2026/04'], ['historyYearsUsed', [2024,2024]],
    ['basePointBasis', { raw: [] }], ['spotPointBasis', ' '], ['spotPositiveMonths24', 25], ['spotQuarterPhase', 0],
    ['baseFallback', []], ['spotFallback', 'x'.repeat(101)], ['zeroRoundedFallback', 'one_yen_floor'], ['inactive', 'true']]) {
    const out = clean({ ...expected, [key]: value });
    assert.ok(out && !(key in out), 'V2の不正optionalを除外: ' + key);
  }
  for (const years of [[2026], [2021,2024], [2023,2022], [], [2022,2023,2024,2025], ['2024']]) {
    assert.equal(clean({ ...expected, historyYearsUsed: years }).historyYearsUsed, undefined, JSON.stringify(years));
  }
  assert.deepEqual(clean(pointV2()), pointV2(), 'optionalを必須にしない');
  assert.equal(clean({ ...expected, zeroRoundedFallback: 'none' }).zeroRoundedFallback, 'none');
  const sh = env.data().getSheetByName('FORECAST_RUNS'), col = sh.rows[0].indexOf('planning_json');
  const newer = [...sh.rows[2]]; newer[0] = 'INVALID-V2'; newer[sh.rows[0].indexOf('finished_at')] = '9999-01-01';
  for (const value of [
    {...pointV2(),version:'OTHER'}, {...pointV2(),version:'HISTORY_MONTHLY_POINT_V1'},
    {...pointV2(),annualBasis:'annual_p50_rounded_yen'}, {...pointV2(),annualBasis:undefined},
    {...pointV2(),annualTarget:1199}, {...pointV2(),annualRawP50:1001},
    {...pointV2(),months:pointV2().months.slice(1)},
    {...pointV2(),months:pointV2().months.map((m,i,a)=>i===1?a[0]:m)},
    {...pointV2(),months:pointV2().months.map(m=>({...m,share:0}))},
    {...pointV2(),months:pointV2().months.map((m,i)=>i?m:{...m,mean:-1})},
  ]) {
    newer[col] = JSON.stringify(value); sh.rows[3] = [...newer];
    env.run('APP_STORE_CACHE_={};appBumpGen_();');
    assert.equal(latest(env, planId).planning, null, '不正な最新V2から過去のV1/V2を補完しない');
  }
}

// 旧annualP50/MC平均0でも、履歴由来のV2正額は保存する。inactiveの0も独立年額として正当。
{
  const positive = { ...pointV2(), annualRawP50: 0 }, { env, planId } = imported();
  stub(env, positive, 0);
  assert.equal(env.runJob('FORECAST.RUN', { planId }).status, 'DONE');
  assert.deepEqual(latest(env, planId).planning, positive);
  assert.equal(latest(env, planId).latest.annual_p50, 0);
  assert.equal(env.run('appForecastPlanningOf_(__raw,2026,0)', { __raw: { ...positive, version:'HISTORY_MONTHLY_POINT_V1' } }), null, 'V1の年度一致条件は緩めない');
  const inactive = { ...pointV2(), annualTarget: 0, inactive: true,
    months: pointV2().months.map(m => ({ ...m, point: 0, share: 0 })) };
  assert.deepEqual(env.call('appForecastPlanningOf_(__raw,2026,1000.4)', { __raw: inactive }), inactive);
  stub(env, inactive);
  assert.equal(env.runJob('FORECAST.RUN', { planId }).status, 'DONE');
  assert.deepEqual(latest(env, planId).planning, inactive);
}

// V5の任意根拠は一組で保持する。件数・時点・重みの一部だけを控えへ残さない。
{
  const { env, planId } = imported();
  const timing = { timingHeldoutFy: 2025, timingTrainingYears: [2023, 2024], timingSupport: 4, timingHits: 1,
    spotTimingWeight: 2 / 6, timingRescue: 'none', timingStatus: 'beta11_calendar_support_shrink' };
  const expected = { ...pointV2(), ...timing };
  stub(env, { ...expected, paths: Array(1000).fill(Array(12).fill(1)) });
  const { start, job } = throughCalc(env, planId);
  assert.deepEqual(job.payload.planning, expected, 'Engineから計算段へcompact timing群を保持');
  assert.ok(Buffer.byteLength(JSON.stringify(job.payload.planning)) <= 4000);
  env.fireTriggers('triggerRunJob');
  assert.equal(env.call('apiJobStatus(__in)', { __in: { jobId: start.jobId } }).status, 'DONE');
  const row = env.table('FORECAST_RUNS')[0];
  assert.deepEqual(JSON.parse(row.planning_json), expected);
  assert.deepEqual(latest(env, planId).planning, expected, '同じ保存の控えからAPIへtiming群を返す');
  assert.equal(latest(env, planId).latest.annual_p50, 1000.4);
  assert.ok(latest(env, planId).monthly.every(m => m.p50 === 0), 'SPOT重みを旧P50へ適用しない');
  const clean = value => env.call('appForecastPlanningOf_(__raw,2026,1000.4)', { __raw: value });
  const timingKeys = Object.keys(timing);
  const bad = [];
  for (const key of timingKeys) { const missing = { ...expected }; delete missing[key]; bad.push([key + ' missing', missing]); }
  for (const [key, value] of [
    ['timingHeldoutFy', 2026], ['timingHeldoutFy', 2024], ['timingHeldoutFy', '2025'],
    ['timingTrainingYears', []], ['timingTrainingYears', [2025]], ['timingTrainingYears', [2024,2024]],
    ['timingTrainingYears', [2024,2023]], ['timingTrainingYears', [2022,2023,2024]], ['timingTrainingYears', ['2024']],
    ['timingTrainingYears', [999]], ['timingTrainingYears', [2023.5]],
    ['timingSupport', -1], ['timingSupport', 13], ['timingSupport', 1.5], ['timingSupport', '4'],
    ['timingHits', -1], ['timingHits', 5], ['timingHits', 1.5], ['timingHits', Infinity],
    ['spotTimingWeight', Infinity], ['spotTimingWeight', NaN], ['spotTimingWeight', -1],
    ['spotTimingWeight', .5], ['spotTimingWeight', 2 / 6 + 2e-12], ['spotTimingWeight', '0.3333333333333333'],
    ['timingRescue', 'minimum_one_yen'], ['timingStatus', 'prior_half_no_support'],
  ]) bad.push([key + ':' + JSON.stringify(value), { ...expected, [key]: value }]);
  for (const [label, raw] of bad) {
    const out = clean(raw);
    assert.deepEqual(out, pointV2(), '不正なtiming群のみ全除外、点予測は保持: ' + label);
  }
  assert.deepEqual(clean({ ...point(), ...timing }), point(), '旧V1へV5の根拠を追加しない');
  assert.deepEqual(clean(pointV2()), pointV2(), '従来の汎用V2にtiming群を必須にしない');
  assert.equal(clean({ ...expected, spotTimingWeight: 2 / 6 + 5e-13 }).spotTimingWeight, 2 / 6 + 5e-13);
  const prior = { ...expected, timingTrainingYears: [2024], timingSupport: 0, timingHits: 0, spotTimingWeight: .5,
    timingStatus: 'prior_half_no_support' };
  assert.deepEqual(clean(prior), prior, '1年warmupとsupport0の明示的priorを保持');
  assert.deepEqual(clean({ ...prior, timingHits: 1 }), pointV2(), 'support0のhitは不正');
  for (const timingRescue of ['none', 'inactive', 'prior12_weighted_profile', 'prior12_unweighted_profile']) {
    assert.equal(clean({ ...expected, timingRescue }).timingRescue, timingRescue);
  }
  const sh = env.data().getSheetByName('FORECAST_RUNS'), col = sh.rows[0].indexOf('planning_json');
  sh.rows[1][col] = JSON.stringify({ ...expected, timingHeldoutFy: 2026 });
  env.run('APP_STORE_CACHE_={};appBumpGen_();');
  assert.deepEqual(latest(env, planId).planning, pointV2(), 'APIも不正timing群を全除外して有効な点予測を返す');
}

// 月行保存で止まっても、計画値と同じrunの控えから一度だけ復旧する。
{
  const { env, planId } = imported(), { start } = throughCalc(env, planId);
  env.data().getSheetByName('FORECAST_MONTHLY').failWrites = true;
  env.fireTriggers('triggerRunJob');
  assert.equal(env.call('apiJobStatus(__in)', { __in: { jobId: start.jobId } }).status, 'FAILED');
  assert.ok(env.props.APP_WRITE_JOURNAL);
  assert.equal(env.table('FORECAST_RUNS').length, 1);
  env.data().getSheetByName('FORECAST_MONTHLY').failWrites = false;
  env.run('appWithLock_(() => appJournalRecover_({actor:__actor}))', { __actor: OWNER });
  env.run('appWithLock_(() => appJournalRecover_({actor:__actor}))', { __actor: OWNER });
  assert.equal(env.table('FORECAST_RUNS').length, 1);
  assert.equal(env.table('FORECAST_MONTHLY').length, 12);
  assert.deepEqual(latest(env, planId).planning, point());
  assert.equal(env.props.APP_WRITE_JOURNAL, undefined);
}

// schema15(22列) → 16(23列): 既存backup手順で末尾だけ増やし、旧行の値は空のまま。
function v15() {
  const env = makeEnv();
  env.run(`__currentRuns=JSON.parse(JSON.stringify(APP_TABLES.FORECAST_RUNS));
    __currentAdded=JSON.parse(JSON.stringify(APP_ADDED_COLUMNS.FORECAST_RUNS));
    APP_TABLES.FORECAST_RUNS.columns=APP_TABLES.FORECAST_RUNS.columns.slice(0,-1);
    APP_ADDED_COLUMNS.FORECAST_RUNS=APP_ADDED_COLUMNS.FORECAST_RUNS.filter(s=>s.version!==16);`);
  env.as(OWNER); env.call('apiSetup()');
  const planId = env.seedPlan(book(env)), runs = env.data().getSheetByName('FORECAST_RUNS');
  const row = runs.rows[0].map(c => ({run_id:'OLD',plan_id:planId,status:'DONE',annual_p50:'1000.4',finished_at:'2026-03-01',fixes_json:'["old"]'}[c] || ''));
  runs.rows.push(row);
  const schema = env.data().getSheetByName('_SCHEMA');
  schema.rows.find(r => r[0] === 'FORECAST_RUNS')[1] = '15';
  env.run('APP_TABLES.FORECAST_RUNS=__currentRuns;APP_ADDED_COLUMNS.FORECAST_RUNS=__currentAdded;APP_STORE_CACHE_={};');
  env.props.APP_TABLES_VERSION = '15';
  return { env, planId, before: J(runs.rows) };
}
{
  const { env, planId, before } = v15();
  assert.equal(env.run('APP_SCHEMA_VERSION'), 16);
  assert.equal(env.run('appReadTable_("FORECAST_RUNS")[0].planning_json'), '');
  assert.throws(() => env.run('appWithLock_(() => appInsertRows_("FORECAST_RUNS",[{run_id:"NO"}]))'), /移行がまだ/);
  env.call('apiListPlans()');
  const rows = env.data().getSheetByName('FORECAST_RUNS').rows;
  assert.equal(rows[0].length, 23);
  assert.equal(rows[0][22], 'planning_json');
  assert.deepEqual(J(rows[0].slice(0, 22)), before[0]);
  assert.deepEqual(J(rows[1].slice(0, 22)), before[1]);
  assert.ok(rows[1][22] === undefined || rows[1][22] === '');
  assert.equal(latest(env, planId).planning, null);
  assert.equal(env.backups().length, 1);
  assert.equal(env.props.APP_TABLES_VERSION, '16');
  const audit = env.audit().filter(r => r.action === 'SCHEMA.MIGRATE');
  assert.deepEqual(audit.map(r => [r.phase,r.result]), [['START',''],['END','OK']]);
  assert.ok(JSON.parse(audit[0].detail_json).backup.taken);
  const after = J(rows); env.call('apiListPlans()');
  assert.deepEqual(J(rows), after); assert.equal(env.backups().length, 1);
}
{
  const { env, before } = v15(), archive = env.props.APP_ARCHIVE_FOLDER_ID;
  delete env.props.APP_ARCHIVE_FOLDER_ID;
  env.call('apiListPlans()');
  assert.deepEqual(J(env.data().getSheetByName('FORECAST_RUNS').rows), before, 'backup失敗時は見出しも書かない');
  assert.equal(env.props.APP_TABLES_VERSION, '15');
  assert.equal(env.backups().length, 0);
  env.props.APP_ARCHIVE_FOLDER_ID = archive; delete env.props.APP_MIGRATE_BACKUP_FAILED_AT;
  env.call('apiListPlans()');
  assert.equal(env.props.APP_TABLES_VERSION, '16'); assert.equal(env.backups().length, 1);
}

console.log('app-monthly-planning-save: all tests passed');
