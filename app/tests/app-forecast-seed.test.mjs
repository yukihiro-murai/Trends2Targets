#!/usr/bin/env node
/*
 * app-forecast-seed.test.mjs — 同じ入力なら同じ数字（2026-10-08 村井さん承認 決定 13）。本物の旧来の予測（A-9）をモックの上で動かして確かめる。
 *   1. 何も変えずに 2 回予測すると、同じ種・同じ P10/P50/P90（年度・月・客観）。実行の ID と旧来の計算が作る ID（snapshot_id・
 *      AI_IMPACT_HISTORY の run_id など）は回ごとに違う。データ本体のハッシュ（予測が書いた表も入る）は変わる
 *   2. 種が見る表（APP_FORECAST_SEED_SHEETS）: 本物の A-9 が開く表は、種が見る表か、A-9 が自分で書く表のどちらか。
 *      種が見る表を A-9 は書き換えない（書き換えると、次の予測で種が変わる）
 *   3. 入力（見解）を変えると種と数字が変わる。実績の取り込み（B-1。A-9 は取り込んだ実績の表を読まない）では種も数字も変わらない
 *   4. 「今」（as_of）は種に入れない: 同じ月の別の日に予測しても同じ数字
 *   5. B-2 は同じ数字の 2 回の予測（3/10・3/20）を回ごとに分けたまま（snapshot_id・run_id が違う）、月が始まる前の最後の回で測る
 *   6. 根拠の「前回の予測からの変化」のわけ（changeCause）: 何も変えない → none、入力を変えた → inputs、実績の取り込みだけ → none、
 *      「今」の月が違う → calendar（2026-10-08 F4）
 * 数字はテスト用の作りもの。本物の Apps Script での確認の代わりではない。
 *
 *   node app/tests/app-forecast-seed.test.mjs
 */
import assert from 'node:assert/strict';
import { setUpEnv, OWNER } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
/** 日本の時刻（月は 1 始まり） */
const jst = (y, m, d, H = 0, M = 0) => new Date(Date.UTC(y, m - 1, d, H - 9, M));
const CLIENT = 'テスト製薬';
const env = setUpEnv();
// 計画の年度は前の年度（今日がいつでも、その年度の月はほぼ締まっている。B-2 で測る月がある）
const FY = env.run('appFy_(new Date())') - 1;
const ymOf = (v) => { if (Object.prototype.toString.call(v) === '[object Date]' || /^\d{4}-\d{2}-\d{2}T/.test(String(v))) { const d = new Date(v); return d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0'); } return String(v); };

// ---- 準備: 本物の A-1・A-2・A-3 で計画を作り、入力を置く（ZAC の実績は年度の終わりまで。B-1 で年度の月の実績を取り込める） ----
let planId;
{
  const ext = Array.from({ length: 70 }, () => '');
  const rec = (product, month, amount) => { const r = ext.slice(); r[40] = CLIENT; r[45] = 'ベース'; r[49] = product; r[56] = month; r[65] = amount; return r; };
  const sheets = {};
  for (let y = FY - 5; y <= FY + 1; y++) {
    const rows = [ext.map((_, i) => 'c' + (i + 1))];
    for (let m = 1; m <= 12; m++) {
      const dt = D(y, m, 15);
      if (dt < D(FY - 5, 4, 1) || dt > D(FY + 1, 3, 31)) continue;
      rows.push(rec('製品A', dt, Math.round(1000000 + 50000 * Math.sin(m) + 12000 * (y - FY + 5) + m * 2000)));
      rows.push(rec('製品B', dt, Math.round(400000 + 20000 * Math.cos(m))));
    }
    sheets['*' + y + '_actual_value'] = { cols: 70, values: rows };
  }
  const zac = env.makeBook('売上の元', sheets);
  env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
  let st = env.runJob('PLAN.CREATE', { clientName: CLIENT, fy: FY, peopleCsv: '鷹野' });
  assert.equal(st.status, 'DONE', st.error);
  planId = st.result.planId;
  for (const action of ['IMPORT.SALES', 'SALES.AGGREGATE']) {
    st = env.runJob('PLAN.RUN', { planId, action });
    assert.equal(st.status, 'DONE', action + ': ' + st.error);
  }
  for (const [kind, row] of [['opinions', { person: '鷹野', ym: FY + '-04', step: '-5', conf: '0.6', note: '' }],
    ['product', { person: '鷹野', product: '製品A', ym: FY + '-04', step: '5', reason: '新規' }], ['client', { person: '鷹野', ym: FY + '-04', step: '-3', reason: '全体' }]]) {
    st = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind, rows: [row] }, inputHash: env.call('apiPlanView(__in)', { __in: { planId } }).inputHash });
    assert.equal(st.status, 'DONE', kind + ': ' + st.error);
  }
}

const engRows = (sheet) => env.table('ENG_' + sheet).filter((r) => r.plan_id === planId);
const runsOf = () => env.table('FORECAST_RUNS').filter((r) => r.plan_id === planId);
/** 予測の数字（FORECAST_RUNS の年度・客観と、FORECAST_MONTHLY の月ごと） */
const numbers = (runId) => {
  const r = runsOf().find((x) => x.run_id === runId);
  return { annual: [r.annual_p10, r.annual_p50, r.annual_p90], objective: [r.objective_p10, r.objective_p50, r.objective_p90],
    monthly: env.table('FORECAST_MONTHLY').filter((m) => m.run_id === runId).map((m) => [m.ym, m.p10, m.p50, m.p90, m.obj_p10, m.obj_p50, m.obj_p90]) };
};
/** 予測を動かす（画面と同じ入口）。asOfMs を渡すと、その時刻を「今」にして待ち行列に直接入れる（画面からは渡せない項目） */
function forecast(asOfMs) {
  if (asOfMs === undefined) {
    const st = env.runJob('FORECAST.RUN', { planId, confirms: ['extreme'] });
    assert.equal(st.status, 'DONE', st.error);
    return st.result;
  }
  let id = env.run(`appWithLock_(() => appEnqueueJob_('FORECAST.RUN', { planId: __p, confirms: ['extreme'], asOfMs: __t }, __by, '').id)`, { __p: planId, __t: asOfMs, __by: OWNER });
  for (let i = 0; i < 60; i++) {
    env.fireTriggers('triggerRunJob');
    const st = env.call('apiJobStatus(__in)', { __in: { jobId: id } });
    if (st.status === 'CONTINUED') { id = st.nextJobId; continue; }
    if (st.status === 'QUEUED' || st.status === 'RUNNING') { id = st.jobId; continue; }
    assert.equal(st.status, 'DONE', st.error);
    return st.result;
  }
  throw new Error('続きの処理が終わらない');
}
const SEED_SHEETS = [...env.run('APP_FORECAST_SEED_SHEETS')];
/** 次の秒になるまで待つ（記録の時刻は秒まで。前の予測と同じ秒に終わった操作は「この間の操作」に入らない） */
const nextSecond = () => { const s = Math.floor(Date.now() / 1000); while (Math.floor(Date.now() / 1000) === s) { /* 待つ */ } };
/** 予測の根拠（前回の予測からの変化のわけ changeCause） */
const basis = () => env.call('apiForecastBasis(__in)', { __in: { planId } });

// ==== 1・2. 何も変えずに 2 回: 同じ種・同じ数字。ID は回ごとに違う。A-9 が開く表は、種が見る表か、A-9 が書く表 ====
let r1, r2;
{
  // 1 回目は、A-9 が計算用ブックで開く表を記録する
  env.run(`(() => { const orig = appLegacyServices_; appLegacyServices_ = function (book, opts) {
    const opened = (globalThis.__opened = []);
    const view = new Proxy(book, { get(t, k) { if (k === 'getSheetByName') return n => { opened.push(String(n)); return t.getSheetByName(n); };
      const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
    appLegacyServices_ = orig;
    return orig(view, opts); }; })()`);
  r1 = forecast();
  const opened = [...new Set(env.run('globalThis.__opened'))].sort();
  r2 = forecast();
  const [a, b] = runsOf();
  assert.notEqual(a.run_id, b.run_id, '実行の ID は回ごとに違う');
  assert.match(a.seed, /^[a-f0-9]{64}$/, '種は中身から作ったハッシュ（実行の ID ではない）');
  assert.equal(b.seed, a.seed, '同じ入力なら同じ種');
  assert.notEqual(b.input_hash, a.input_hash, '前提: データ本体のハッシュ（予測が書いた表も入る）は 1 回目の予測で変わった');
  assert.deepEqual(numbers(b.run_id), numbers(a.run_id), '同じ P10/P50/P90（年度・客観・月ごと）');
  assert.equal(numbers(a.run_id).monthly.length, 12);
  assert.ok(numbers(a.run_id).annual.every((x) => Number(x) > 0));
  assert.deepEqual(r2.headline, r1.headline);
  assert.equal(basis().changeCause, 'none', '根拠の「前回の予測からの変化」: 変わっていない');
  assert.ok(!r2.changed.includes('OUTPUT'), 'OUTPUT（結果）は 1 回目と同じ中身なので書き直さない: ' + r2.changed.join(','));
  // 旧来の計算が作る ID は回ごとに違う（B-2 は snapshot_id・run_id で回を分ける）
  const snap = engRows('FORECAST_SNAPSHOT');
  const sids = [...new Set(snap.map((r) => r.snapshot_id))];
  assert.equal(sids.length, 2, 'snapshot_id は 2 回分');
  sids.forEach((sid) => assert.equal(snap.filter((r) => r.snapshot_id === sid).length, 36, '1 回 = 12 か月 × 3 つのシナリオ'));
  const preds = (sid) => snap.filter((r) => r.snapshot_id === sid).map((r) => [ymOf(r.target_month), r.scenario, r.final_pred]);
  assert.deepEqual(preds(sids[1]), preds(sids[0]), '予測の記録の数字も同じ');
  for (const sheet of ['AI_IMPACT_HISTORY', 'SUBJECTIVE_IMPACT_HISTORY']) {
    const ids = [...new Set(engRows(sheet).map((r) => r.run_id))];
    assert.equal(ids.length, 2, sheet + ' の run_id は回ごとに違う（C-1・当たりの数え方は run_id で回を分ける）: ' + ids.join(','));
    const n = ids.map((id) => engRows(sheet).filter((r) => r.run_id === id).length);
    assert.equal(n[0], n[1], sheet + ': 回ごとの行の数は同じ（1 回目の行に 2 回目が混ざらない）');
  }
  assert.deepEqual(engRows('AI_IMPACT_HISTORY').map((r) => r.run_id).slice(0, 12), Array(12).fill(engRows('AI_IMPACT_HISTORY')[0].run_id), '1 回 = 12 か月');
  const logIds = engRows('RUN_LOG').map((r) => r.run_id);
  assert.equal(new Set(logIds).size, logIds.length, 'RUN_LOG の run_id も重ならない');

  // 2. 種が見る表: A-9 が開く表は、種が見る表か、A-9 が自分で書く表（結果・記録。SALES_MONTHLY は SALES_INPUT から作り直す）
  const writes = [...new Set(r1.changed.concat(r2.changed, ['SALES_MONTHLY']))].sort();
  assert.deepEqual(opened.filter((n) => !SEED_SHEETS.includes(n) && !writes.includes(n)), [],
    'A-9 が読むのに種に入っていない表がある（APP_FORECAST_SEED_SHEETS に足す）: opened=' + opened.join(','));
  assert.deepEqual(SEED_SHEETS.filter((n) => r1.changed.includes(n) || r2.changed.includes(n)), [], '種が見る表を A-9 は書き換えない');
  assert.deepEqual(r2.changed.slice().sort(), ['AI_IMPACT_HISTORY', 'AI_SCORE_HISTORY', 'FORECAST_SNAPSHOT', 'PROCESS_STATUS', 'RUN_LOG', 'SUBJECTIVE_IMPACT_HISTORY'],
    '2 回目に書くのは記録の表だけ');
  for (const n of ['EVAL_LOG', 'EVAL_INSIGHTS', 'OUTPUT', 'FORECAST_SNAPSHOT', 'SALES_MONTHLY', 'QUARTERLY_REVIEW']) assert.ok(!SEED_SHEETS.includes(n), n + ' は種に入れない');
}

// ==== 3. 入力を変えると種と数字が変わる。予算の保存（A-9 は読まない）では変わらない ====
{
  const before = runsOf().slice(-1)[0];
  nextSecond();   // 記録の時刻は秒まで。操作が前の予測の後だとわかるように（根拠の「この間の操作」）
  const st = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind: 'opinions', rows: [{ person: '鷹野', ym: FY + '-04', step: '-2', conf: '0.6', note: '' }] },
    inputHash: env.call('apiPlanView(__in)', { __in: { planId } }).inputHash });
  assert.equal(st.status, 'DONE', st.error);
  forecast();
  const r3 = runsOf().slice(-1)[0];
  assert.notEqual(r3.seed, before.seed, '見解を変えると種が変わる');
  assert.notDeepEqual(numbers(r3.run_id).annual, numbers(before.run_id).annual, '数字も変わる');
  assert.deepEqual([basis().changeCause, basis().inputChanged], ['inputs', true], '変化のわけは入力');
  // 実績の取り込み（B-1。ACTUAL_EVAL_MONTHLY・PROCESS_STATUS・RUN_LOG に書く。A-9 はどれも数字に使わない）の後に予測: 種も数字も同じ
  nextSecond();
  const b1 = env.runJob('PLAN.RUN', { planId, action: 'IMPORT.ACTUALS' });
  assert.equal(b1.status, 'DONE', 'B-1: ' + b1.error);
  assert.ok(b1.result.changed.includes('ACTUAL_EVAL_MONTHLY'), '前提: 実績を取り込んだ: ' + b1.result.changed.join(','));
  forecast();
  const r4 = runsOf().slice(-1)[0];
  assert.equal(r4.seed, r3.seed, '予測が読まない表が変わっても種は変わらない');
  assert.deepEqual(numbers(r4.run_id), numbers(r3.run_id), '数字も同じ');
  assert.deepEqual([basis().changeCause, basis().inputChanged], ['none', true], '実績の取り込みはあったが、予測は変わっていない');
}

// ==== 4・5. 「今」は種に入れない（同じ月の別の日でも同じ数字）。B-2 は同じ数字の 2 回を分けたまま、月が始まる前の最後の回で測る ====
{
  // 年度が始まる前の 2 回（3/10 と 3/20。同じ月）。どちらも年度の月が始まる前の予測
  const n0 = runsOf().length;
  forecast(jst(FY, 3, 10, 10).getTime());
  forecast(jst(FY, 3, 20, 15).getTime());
  const [p1, p2] = runsOf().slice(n0);
  assert.equal(p2.seed, p1.seed, '「今」が違っても種は同じ');
  assert.notEqual(p1.as_of, p2.as_of);
  assert.deepEqual(numbers(p2.run_id), numbers(p1.run_id), '同じ月の別の日でも同じ数字');
  assert.equal(basis().changeCause, 'none', '3/10 → 3/20: 変わっていない');
  // 3/10 の回の前は今日の回: 「今」の月が違う（締まった月が違う）ので数字が変わる → 月の変わり目
  const b310 = env.call('appBasisChangeCause_(__l, __p, __c, __b, [])', { __l: p1, __p: runsOf()[n0 - 1],
    __c: Object.fromEntries(env.table('FORECAST_MONTHLY').filter((m) => m.run_id === p1.run_id).map((m) => [m.ym, m])),
    __b: Object.fromEntries(env.table('FORECAST_MONTHLY').filter((m) => m.run_id === runsOf()[n0 - 1].run_id).map((m) => [m.ym, m])) });
  assert.notDeepEqual(numbers(p1.run_id).annual, numbers(runsOf()[n0 - 1].run_id).annual, '前提: 締まった月が違えば数字が変わる');
  assert.equal(b310.changeCause, 'calendar', '今日の回 → 3/10 の回: 月が違う');

  // B-2（上の B-1 は今日の取り込み: 年度の月は締まっている）。旧来の B-2 は検証の表の Y〜AJ 列（25〜36 列）に要約を書く。
  // 新アプリが計画を作るときと B-2 の前に表を 36 列まで広げるので、テストの側では広げない（app-eval-columns.test.mjs）
  const st = env.runJob('PLAN.RUN', { planId, action: 'EVAL.REPORT' });
  assert.equal(st.status, 'DONE', 'B-2: ' + st.error);
  const policy = env.run('APP_EVAL_POLICY_VERSION');
  const cur = engRows('EVAL_LOG').filter((r) => r.evaluation_policy_version === policy);
  const by = {};
  cur.forEach((r) => { const k = ymOf(r.target_month); (by[k] = by[k] || []).push(r); });
  const months = Object.keys(by).sort();
  assert.ok(months.length >= 6, 'B-2 は年度の締まった月を測った: ' + months.join(','));
  months.forEach((ym) => assert.deepEqual(by[ym].map((r) => r.scenario).sort(), ['nega', 'neutral', 'posi'], ym + ': 月ごとに 3 つのシナリオ 1 回分'));
  const p2sid = [...new Set(engRows('FORECAST_SNAPSHOT').map((r) => r.snapshot_id))];
  assert.equal(p2sid.length, runsOf().length, 'snapshot_id は予測の回の数だけある（同じ数字の 3/10 と 3/20 の回も別の回）');
  // 測った予測は、月が始まる前の最後の回（3/20 の回）の数字（3/10 の回と同じ数字だが、別の回として分けたまま）
  const snap = engRows('FORECAST_SNAPSHOT');
  const lastSid = [...new Set(snap.map((r) => r.snapshot_id))].slice(-1)[0];
  months.forEach((ym) => {
    const s = snap.find((r) => r.snapshot_id === lastSid && ymOf(r.target_month) === ym && r.scenario === 'neutral');
    const e = by[ym].find((r) => r.scenario === 'neutral');
    assert.ok(Math.abs(Number(e.pred) - Number(s.final_pred)) < 1e-6, ym + ': 測った予測 = 3/20 の回の P50');
  });
  const log = engRows('RUN_LOG').filter((r) => r.function_name === 'updatePhase1EvaluationReport').slice(-1)[0];
  assert.match(log.error_summary, new RegExp('^' + policy + ': scored_months=' + months.length + ';'), 'B-2 の記録: ' + log.error_summary);
}

console.log('app-forecast-seed: all tests passed');
