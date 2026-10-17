/** 計画用月額は予測帯とは別に同じ予測の控えへ保存し、旧回を補完しない。 */
import assert from 'node:assert/strict';
import { J, makeEnv, OWNER, setUpEnv } from './gas-mock.mjs';

const months = Array.from({ length: 12 }, (_, i) => `${i < 9 ? 2026 : 2027}/${String((i + 3) % 12 + 1).padStart(2, '0')}`);
const point = () => ({ version: 'HISTORY_MONTHLY_POINT_V1', applied: true, method: 'TEST_EXPECTATION_SHARE',
  annualRawP50: 1000.4, annualTarget: 1000, trainingThroughYm: '2026/03',
  months: months.map((ym, i) => ({ ym, point: i < 4 ? 84 : 83, share: 1 / 12, mean: 100 + i })) });
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
function stub(env, planning) {
  env.run(`appLegacyEngine_ = function(svc) { return { WEB_UI_CONFIRMS_: {}, VERSION: 'planning-stub', SOURCE_SHA256: 'stub',
    runPhase1Forecast() {
      const ss = svc.SpreadsheetApp.getActiveSpreadsheet(), out = ss.getSheetByName('OUTPUT');
      out.getRange(26, 1, 1, 4).setValues([['年度合計（予測）', 800, 1000.4, 1200]]);
      for (let i = 0; i < 12; i++) out.getRange(29+i, 1, 1, 9).setValues([[__months[i], 0, 0, 500, '', '', '', 0, '']]);
      const snap = ss.getSheetByName('FORECAST_SNAPSHOT');
      const sidecar = __point && __point.applied === true ? {monthly_point:{version:__point.version,method:__point.method,
        point:__point.months[0].point,share:__point.months[0].share,mean:__point.months[0].mean,annualTarget:__point.annualTarget}} : {};
      snap.getRange(snap.getLastRow()+1, 1, 1, 15).setValues([[svc.Utilities.getUuid(),new svc.Date(),'テスト製薬','2026/04','neutral',0,0,0,0,0,0,500,JSON.stringify(sidecar),'','{}']]);
      return __point === undefined ? undefined : {monthlyPlanning:__point};
    } }; };`, { __point: planning, __months: months });
}
function imported(planning = point()) {
  const env = setUpEnv(), planId = env.seedPlan(book(env));
  stub(env, planning);
  return { env, planId };
}
function throughCalc(env, planId) {
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
