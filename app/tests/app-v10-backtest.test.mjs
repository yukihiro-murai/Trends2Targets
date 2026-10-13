#!/usr/bin/env node
/*
 * app-v10-backtest.test.mjs — 物差し（表の版 10 の 3-7・決定 9 (b)。Backtest.js）。本物の旧来の計算（A-1・A-2・A-3・B-1・A-9）をモックの上で動かして確かめる。
 *   1. 統計だけ（STAT_ONLY）は、人の入力の無い本番の A-9 の中身（runForecastFYCore_）と差 0（同じ種・同じ「今」）。
 *      物差しの種は、売上と CONFIG の中身・区切り・旧来の計算の版から決まる（記録した種で動かし直すと同じ数字）
 *   2. 本番の A-9（FORECAST.RUN）と、同じ入力・種・「今」で中身を直接呼んだ結果は差 0（1 と合わせて、統計だけ = 人の入力の無い本番）。
 *      季節加重は本番の OUTPUT の Seasonal Weighted Total と差 0
 *   3. 単純な方法（前年同月・2 年平均）が合成の売上で正しい。本番の予測（LIVE）は、その月が始まる前の最後の回
 *   4. 締まっていない月は実績を空にし、数えない
 *   5. 48 か月がそろわない区切りは数えない（前の年度の区切り・取引が途中から始まった）。取引が始まる前の 0 円は本物の月と数えない
 *   6. 続きの処理に分けても結果が同じ。人の入力を変えても統計だけの種と数字は同じ
 *   7. 予測の数字・OUTPUT・計算用の表は変わらない（BACKTEST に 60 行を足すだけ）
 *   8. 所有者だけ（apiOwnerTask の runBacktest）。締めた年度の計画は断る。区切りの年度を確かめる
 *   9. 分析のまとめ: 方法ごとの外れ幅・偏り・帯に入った割合と 95% の幅。点が 30 より少ない・1 社だけなら比べない
 *  10. 分析の画面の物差しのカード（計画ごとに一番新しい回だけ・中の記号と金額を出さない）
 * 数字はテスト用の作りもの。本物の Apps Script での確認の代わりではない。
 *
 *   node app/tests/app-v10-backtest.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setUpEnv, uiHtml, OWNER, MEMBER } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const env = setUpEnv();
// 計画の年度は前の年度（今日がいつでも、その年度の月はほぼ締まっている）
const FY = env.run('appFy_(new Date())') - 1;
const TODAY = env.run('appToday_()');
const A = 'テスト製薬', B = '別の製薬';
const ym = (y, m) => y + '/' + String(m).padStart(2, '0');
const fyYms = (fy) => Array.from({ length: 12 }, (_, i) => (i < 9 ? ym(fy, 4 + i) : ym(fy + 1, i - 8)));
const split = (s) => s.split('/').map(Number);

// ---- 合成の売上（ZAC の実績の形）。甲は 5 年前から、乙は年度の 4 年前の 7 月から（途中の 1 か月は売上なし）----
/** その月の行 [区分, 製品, 金額] */
function records(client, y, m) {
  if (client === A) {
    const out = [['ベース', '製品A', Math.round(1000000 + 50000 * Math.sin(m) + 12000 * (y - FY + 5) + m * 2000)], ['ベース', '製品B', Math.round(400000 + 20000 * Math.cos(m))]];
    if (m % 3 === 0) out.push(['スポット', '開発', 150000 + 1000 * m]);
    return out;
  }
  if (D(y, m) < D(FY - 4, 7) || (y === FY - 2 && m === 1)) return [];
  return [['ベース', '製品C', 600000 + 10000 * m + 3000 * (y - FY + 4)]];
}
const total = (client, y, m) => records(client, y, m).reduce((s, r) => s + r[2], 0);
{
  const ext = Array.from({ length: 70 }, () => '');
  const rec = (client, kind, product, month, amount) => { const r = ext.slice(); r[40] = client; r[45] = kind; r[49] = product; r[56] = month; r[65] = amount; return r; };
  const sheets = {};
  for (let y = FY - 5; y <= FY + 1; y++) {
    const rows = [ext.map((_, i) => 'c' + (i + 1))];
    for (let m = 1; m <= 12; m++) {
      if (D(y, m) < D(FY - 5, 4) || D(y, m) > D(FY + 1, 3)) continue;
      for (const c of [A, B]) records(c, y, m).forEach(([k, p, v]) => rows.push(rec(c, k, p, D(y, m, 15), v)));
    }
    sheets['*' + y + '_actual_value'] = { cols: 70, values: rows };
  }
  const zac = env.makeBook('売上の元', sheets);
  env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
}
/** 本物の A-1 → A-2 → A-3 → B-1 で計画を作る（人の入力は無い） */
function makePlan(client) {
  let st = env.runJob('PLAN.CREATE', { clientName: client, fy: FY, peopleCsv: '鷹野' });
  assert.equal(st.status, 'DONE', st.error);
  const planId = st.result.planId;
  for (const action of ['IMPORT.SALES', 'SALES.AGGREGATE', 'IMPORT.ACTUALS']) {
    st = env.runJob('PLAN.RUN', { planId, action });
    assert.equal(st.status, 'DONE', action + ': ' + st.error);
  }
  return planId;
}
const planA = makePlan(A);
const planB = makePlan(B);

const bt = () => env.call('appReadTable_("BACKTEST")');
/** 物差しを動かす（所有者の入口と同じ裏の処理）。返り値 { st, rows（その回の 60 行） } */
function backtest(planId, fy) {
  const st = env.runJob('MEASURE.BACKTEST', fy === undefined ? { planId } : { planId, fy });
  if (st.status !== 'DONE') return { st, rows: [] };
  return { st, rows: bt().filter((r) => r.bt_id === st.result.btId) };
}
const of = (rows, method) => rows.filter((r) => r.method === method).sort((a, b) => a.horizon - b.horizon);
/** 予測を動かす（「今」= asOfMs。画面からは渡せない項目なので待ち行列に直接入れる。app-forecast-seed と同じ） */
function forecast(planId, asOfMs) {
  let id = env.run(`appWithLock_(() => appEnqueueJob_('FORECAST.RUN', { planId: __p, confirms: ['extreme'], asOfMs: __t }, __by, '').id)`, { __p: planId, __t: asOfMs, __by: OWNER });
  for (let i = 0; i < 60; i++) {
    env.fireTriggers('triggerRunJob');
    const st = env.call('apiJobStatus(__in)', { __in: { jobId: id } });
    if (st.status === 'CONTINUED') { id = st.nextJobId; continue; }
    if (st.status === 'QUEUED' || st.status === 'RUNNING') { id = st.jobId; continue; }
    assert.equal(st.status, 'DONE', st.error);
    return env.table('FORECAST_RUNS').find((r) => r.run_id === st.result.runId);
  }
  throw new Error('続きの処理が終わらない');
}
const CUT = ym(FY, 4);
const T = env.run('appBacktestAsOf_(__c)', { __c: CUT });   // 区切りの「今」（年度の 4 月 1 日の正午）
/**
 * 計算用ブックを全部組み立て、旧来の A-9 の中身（runForecastFYCore_）を、runPhase1Forecast と同じく売上の表を作り直してから、種と「今」を決めて直接呼ぶ。
 * 同じブックの上で物差しの統計だけ（appBacktestStatRun_）も動かす（seed が渡されたとき）
 */
function cores(planId, seed, asOfMs) {
  return env.call(`(() => {
    APP_STORE_CACHE_ = {};
    const plan = appPlanOf_(__p);
    const s = appWorkScratch_(plan);
    let st = null;
    do { st = appScratchBuildStep_(s, plan.plan_id, null, st && st.state, Date.now() + 60000); } while (!st.complete);
    const stat = appBacktestStatRun_(s, { fy: ${FY}, asOfMs: __t, seed: __s });
    const eng = appLegacyEngine_(appLegacyServices_(s, { asOfMs: __t, seed: 'x', actor: '' }));
    const client = eng.normalizeClientName_(String(s.getSheetByName('CONFIG').getRange('B2').getValue()).trim());
    const live = appWithSeededRandom_(__s, () => { eng.syncSalesFromSalesInput_(${FY}, client); return eng.runForecastFYCore_(${FY}, client); });
    return { stat: stat, live: { p10: live.mixed.p10, p50: live.mixed.p50, p90: live.mixed.p90, months: live.months.length } };
  })()`, { __p: planId, __t: asOfMs, __s: seed });
}

// ==== 1. 統計だけは、人の入力の無い本番の中身と差 0。物差しの種は中身と区切りから決まる ====
let first;
{
  const c = cores(planA, 'SEED-1', T);
  assert.equal(c.live.months, 12);
  assert.ok(c.stat.p50.every((v) => v > 0));
  for (const k of ['p10', 'p50', 'p90']) assert.deepEqual(c.stat[k], c.live[k], k + ': 統計だけ = 人の入力の無い本番の A-9 の中身（差 0）');
  assert.notDeepEqual(cores(planA, 'SEED-2', T).stat.p50, c.stat.p50, '前提: 種が違えば数字が違う（混合のシミュレーション）');

  first = backtest(planA);
  assert.equal(first.st.status, 'DONE', first.st.error);
  const r = first.st.result;
  assert.deepEqual([r.rows, r.written, r.skipped, r.cutoffYm, r.realMonths], [60, 60, false, CUT, 48]);
  assert.equal(first.rows.length, 60, '12 か月 × 5 方法');
  assert.deepEqual([...new Set(first.rows.map((x) => x.method))].sort(), ['LAST_YEAR', 'LIVE', 'SEASONAL', 'STAT_ONLY', 'TWO_YEAR']);
  assert.ok(first.rows.every((x) => x.plan_id === planA && x.cutoff_ym === CUT && x.calc_version === 'BT-1' && x.computed_by === OWNER && /^[a-f0-9]{64}$/.test(x.engine_sha256)));
  assert.ok(first.rows.every((x) => /^BTP-[0-9A-F]{24}$/.test(x.point_id)), '点の印は回・方法・月から決まる');
  assert.deepEqual(of(first.rows, 'STAT_ONLY').map((x) => x.target_ym), fyYms(FY));
  assert.deepEqual(of(first.rows, 'STAT_ONLY').map((x) => x.horizon), Array.from({ length: 12 }, (_, i) => i + 1));
  // 種: 中身（CONFIG・SALES_INPUT）・区切り・地域・旧来の計算の版から
  const seed = env.call(`(() => { const plan = appPlanOf_(__p); const eng = appLegacyEngine_(appLegacyServices_({}, { asOfMs: 0, seed: 'x' }));
    return appBacktestSeed_(plan, appBacktestInputHash_(plan.plan_id), __c, { version: eng.VERSION, sourceSha256: eng.SOURCE_SHA256 }); })()`, { __p: planA, __c: CUT });
  assert.equal(r.seed, seed);
  assert.ok(first.rows.every((x) => x.seed === seed && x.engine_sha256 === env.run('appLegacyEngine_(appLegacyServices_({}, { asOfMs: 0, seed: "x" })).SOURCE_SHA256')));
  // 記録した種で動かし直すと同じ数字（統計だけ・季節加重）
  const again = cores(planA, seed, T).stat;
  const st0 = of(first.rows, 'STAT_ONLY');
  assert.deepEqual([st0.map((x) => x.p10), st0.map((x) => x.p50), st0.map((x) => x.p90)], [again.p10, again.p50, again.p90]);
  assert.deepEqual(of(first.rows, 'SEASONAL').map((x) => x.p50), again.seasonal);
  assert.ok(of(first.rows, 'SEASONAL').every((x) => x.p10 === null && x.p90 === null), '単純な方法は p50 だけ');
  // 監査: 組み立てと計算・保存
  assert.ok(env.audit().some((a) => a.action === 'MEASURE.BACKTEST.BUILD' && a.phase === 'END' && a.result === 'OK'));
  assert.ok(env.audit().some((a) => a.action === 'MEASURE.BACKTEST.CALC' && a.phase === 'END' && a.result === 'OK' && a.entity_id === r.btId));
}

// ==== 2. 本番の A-9 = 同じ入力・種・「今」で中身を直接呼んだ結果（差 0）。季節加重 = 本番の OUTPUT ====
let runT;
{
  for (const [kind, row] of [['opinions', { person: '鷹野', ym: FY + '-04', step: '-5', conf: '0.6', note: '' }],
    ['product', { person: '鷹野', product: '製品A', ym: FY + '-04', step: '5', reason: '新規' }], ['client', { person: '鷹野', ym: FY + '-06', step: '-3', reason: '全体' }]]) {
    const st = env.runJob('PLAN.EDIT', { planId: planA, action: 'INPUT.SAVE', args: { kind, rows: [row] }, inputHash: env.call('apiPlanView(__in)', { __in: { planId: planA } }).inputHash });
    assert.equal(st.status, 'DONE', kind + ': ' + st.error);
  }
  runT = forecast(planA, T);
  const monthly = env.table('FORECAST_MONTHLY').filter((m) => m.run_id === runT.run_id).sort((a, b) => a.ym.localeCompare(b.ym));
  assert.deepEqual(monthly.map((m) => m.ym), fyYms(FY));
  const c = cores(planA, runT.seed, T);
  for (const k of ['p10', 'p50', 'p90']) assert.deepEqual(monthly.map((m) => Number(m[k])), c.live[k], k + ': 本番の予測 = 中身を直接呼んだ結果（差 0）');
  assert.notDeepEqual(c.live.p50, c.stat.p50, '前提: 人の入力があれば、統計だけとは違う');
  // OUTPUT の 29〜40 行の F 列（Seasonal Weighted Total）
  const seasonal = env.call(`(() => { const rows = {}; appReadPlanTable_('ENG_ROWS', __p).filter(r => r.sheet === 'OUTPUT' && Number(r.col_from) === 1)
    .forEach(s => { rows[Number(s.row_no)] = JSON.parse(s.cells_json); }); const out = [];
    for (let r = 29; r <= 40; r++) { const x = rows[r][5]; out.push(appCellDecode_(x.charAt(0), x.slice(1))); } return out; })()`, { __p: planA });
  assert.deepEqual(of(first.rows, 'SEASONAL').map((x) => x.p50), seasonal, '季節加重 = 本番の OUTPUT の Seasonal Weighted Total（差 0）');
}

// ==== 3. 単純な方法と実績が合成の売上どおり。本番の予測は、その月が始まる前の最後の回 ====
let second;
{
  const runMar = forecast(planA, Date.UTC(FY, 2, 20, 1));   // 年度が始まる前（3/20）の回
  second = backtest(planA);
  assert.equal(second.st.status, 'DONE', second.st.error);
  const yms = fyYms(FY);
  const ly = of(second.rows, 'LAST_YEAR'), two = of(second.rows, 'TWO_YEAR');
  yms.forEach((t, i) => {
    const [y, m] = split(t);
    assert.equal(ly[i].p50, total(A, y - 1, m), t + ': 前年同月');
    assert.equal(two[i].p50, (total(A, y - 2, m) + total(A, y - 1, m)) / 2, t + ': 2 年平均');
  });
  // 実績: 締まった月だけ（B-1 は今日の取り込み。月末から 5 日たった月）
  const closed = (t) => env.run('appActualClosed_(__m, __d)', { __m: t, __d: TODAY });
  of(second.rows, 'STAT_ONLY').forEach((x, i) => {
    const [y, m] = split(yms[i]);
    assert.equal(x.actual, closed(yms[i]) ? total(A, y, m) : null, yms[i] + ': 実績');
    assert.equal(x.counted, closed(yms[i]), yms[i] + ': 数えるのは締まった月だけ');
    assert.equal(x.real_months, 48);
  });
  // 本番: 4 月は 3/20 の回（4/1 正午の回は 4 月が始まった後）。5 月から後は 4/1 正午の回
  const live = of(second.rows, 'LIVE');
  const monthOf = (runId, t) => env.table('FORECAST_MONTHLY').find((m) => m.run_id === runId && m.ym === t);
  live.forEach((x, i) => {
    const src = monthOf(i === 0 ? runMar.run_id : runT.run_id, yms[i]);
    assert.deepEqual([x.p10, x.p50, x.p90], [Number(src.p10), Number(src.p50), Number(src.p90)], yms[i] + ': 月が始まる前の最後の回');
  });
  // 人の入力を足しても、統計だけの種と数字は変わらない（売上と CONFIG の中身だけを見る）
  assert.equal(second.st.result.seed, first.st.result.seed);
  for (const m of ['STAT_ONLY', 'SEASONAL', 'LAST_YEAR', 'TWO_YEAR']) assert.deepEqual(of(second.rows, m).map((x) => [x.p10, x.p50, x.p90]), of(first.rows, m).map((x) => [x.p10, x.p50, x.p90]), m);
  assert.notEqual(second.st.result.btId, first.st.result.btId, '回の番号は回ごと');
  assert.ok(second.rows.every((x) => !first.rows.some((y) => y.point_id === x.point_id)), '点の印も回ごと');
}

// ==== 4. 締まっていない月は実績を空にし、数えない ====
{
  env.run(`globalThis.__origDays = appBacktestImportDays_; appBacktestImportDays_ = function (id) { return Object.assign(__origDays(id), { actuals: '${FY}-10-10' }); }`);
  try {
    const { st, rows } = backtest(planA);
    assert.equal(st.status, 'DONE', st.error);
    of(rows, 'STAT_ONLY').forEach((x, i) => {
      const done = i < 6;   // 10/10 の取り込みで締まっているのは 4〜9 月（9 月は月末から 5 日たった）
      assert.equal(x.actual === null, !done, x.target_ym + ': 締まっていない月の実績は空');
      assert.equal(x.counted, done, x.target_ym);
    });
    assert.equal(st.result.counted, 6);
    assert.ok(rows.filter((x) => x.actual === null).every((x) => !x.counted), '実績の無い点は数えない');
  } finally { env.run('appBacktestImportDays_ = __origDays'); }
}

// ==== 5. 48 か月がそろわない区切りは数えない。取引が始まる前の 0 円は本物の月ではない ====
{
  // 前の年度の区切り: 計画が持つ売上は年度の前の 48 か月なので、窓の最初の 12 か月は売上が無い（取引が始まる前と同じ扱い）
  const prev = backtest(planA, FY - 1);
  assert.equal(prev.st.status, 'DONE', prev.st.error);
  assert.deepEqual([prev.st.result.cutoffYm, prev.st.result.realMonths, prev.st.result.counted], [ym(FY - 1, 4), 36, 0]);
  assert.ok(prev.rows.every((x) => x.real_months === 36 && !x.counted));
  of(prev.rows, 'STAT_ONLY').forEach((x) => { const [y, m] = split(x.target_ym); assert.equal(x.actual, total(A, y, m), '実績はある（数えないだけ）'); });
  of(prev.rows, 'LAST_YEAR').forEach((x) => { const [y, m] = split(x.target_ym); assert.equal(x.p50, total(A, y - 1, m)); });
  assert.ok(of(prev.rows, 'LIVE').every((x) => x.p50 === null), '前の年度の月の本番の予測は無い');
  // 取引が年度の 4 年前の 7 月から: 窓の 4〜6 月は本物の月でない（途中の売上の無い月は本物と数える）
  const b = backtest(planB);
  assert.equal(b.st.status, 'DONE', b.st.error);
  assert.deepEqual([b.st.result.realMonths, b.st.result.counted], [45, 0]);
  assert.ok(b.rows.every((x) => !x.counted));
  // 数え方そのもの（売上を取り込んだ日に締まっていない月も本物でない）
  const real = (arr, day) => env.call('appBacktestRealMonths_(__a, __s, __d)', { __a: arr, __s: '2021/04', __d: day });
  const arr = Array.from({ length: 48 }, (_, i) => (i < 2 ? 0 : i === 5 ? 0 : 100));
  assert.equal(real(arr, '2025-06-01'), 46, '最初の売上（3 か月目）から後を数える。途中の 0 円は本物');
  assert.equal(real(Array(48).fill(100), '2025-06-01'), 48);
  assert.equal(real(Array(48).fill(100), '2025-04-04'), 47, '3 月は 4/4 の取り込みでは途中（月末から 5 日たっていない）');
  assert.equal(real(Array(48).fill(100), '2025-03-03'), 46, '2・3 月は 3/3 の取り込みでは途中');
  assert.equal(real(Array(48).fill(0), '2025-06-01'), 0);
  assert.equal(real(Array(48).fill(100), ''), 0, '取り込んだ日が分からなければ数えない');
}

// ==== 6・7. 続きの処理に分けても同じ。予測の数字・OUTPUT・計算用の表は変わらない（BACKTEST に足すだけ）====
{
  const keep = () => Object.fromEntries(env.data().getSheets().filter((s) => s.name !== 'BACKTEST').map((s) => [s.name, JSON.stringify(s.rows)]));
  const before = keep();
  const n0 = bt().length;
  env.run('globalThis.__origDeadline = appBuildDeadline_; appBuildDeadline_ = function () { return 0; }');   // 1 回に 1 枚ずつ組み立てる
  let third;
  try { third = backtest(planA); } finally { env.run('appBuildDeadline_ = __origDeadline'); }
  assert.equal(third.st.status, 'DONE', third.st.error);
  assert.equal(third.st.result.timing.steps, 3, '組み立てを 3 回に分けた（CONFIG・SALES_INPUT・SALES_MONTHLY）');
  const strip = (rows) => rows.map((x) => [x.method, x.target_ym, x.horizon, x.p10, x.p50, x.p90, x.actual, x.real_months, x.counted, x.seed]);
  assert.deepEqual(strip(third.rows), strip(second.rows), '分けても分けなくても同じ点');
  const after = keep();
  for (const name of Object.keys(before)) assert.equal(after[name], before[name], name + ' は変わらない（予測の数字・OUTPUT・計算用の表）');
  assert.equal(bt().length, n0 + 60, 'BACKTEST に 60 行を足しただけ');
  assert.equal(env.call('appLogTruncatedCells_("BACKTEST")'), 0, '切り詰めたセルは無い');
}

// ==== 8. 所有者だけ。締めた年度の計画は断る。区切りの年度を確かめる ====
{
  // 所有者がエディタから: 裏の処理として始め、OWNER_TASK は jobStatus に置き換わる
  env.props.OWNER_TASK = JSON.stringify({ action: 'runBacktest', planId: planB });
  const full = env.call('apiOwnerTask()');
  assert.equal(full.ok, true);
  assert.match(full.result.jobId, /^JOB-/);
  assert.equal(JSON.parse(env.props.OWNER_TASK).action, 'jobStatus');
  for (let i = 0; i < 10; i++) env.fireTriggers('triggerRunJob');
  env.props.OWNER_TASK = JSON.stringify({ action: 'jobStatus', jobId: full.result.jobId });
  const done = env.call('apiOwnerTask()').result;
  assert.deepEqual([done.status, done.kind, done.result.rows, done.result.planId], ['DONE', 'MEASURE.BACKTEST_CALC', 60, planB], '組み立て → 計算と保存（続きをたどった結果）');
  // 区切りの年度
  env.props.OWNER_TASK = JSON.stringify({ action: 'runBacktest', planId: planA, cutoffFy: '20x5' });
  assert.throws(() => env.call('apiOwnerTask()'), /cutoffFy（区切りの年度）は 4 桁の数/);
  for (const fy of [FY + 1, FY - 4]) {
    const st = backtest(planA, fy);
    assert.equal(st.st.status, 'FAILED');
    assert.match(st.st.error, /区切りの年度は、計画の年度（FY\d{4}）から 3 年前まで/);
  }
  // 所有者でない管理者は断る（画面から始められない）。中の段は画面から始められない
  env.task(`saveMember({ email: '${MEMBER}', displayName: 'M' })`);
  env.task(`grantRole({ email: '${MEMBER}', role: 'ADMIN' })`);
  env.as(MEMBER);
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'MEASURE.BACKTEST', payload: { planId: planA } } }), /権限がありません/);
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'MEASURE.BACKTEST_CALC', payload: { planId: planA } } }), /画面から始められません/);
  env.as(OWNER);
  // 締めた年度の計画: 始める前に断る（何も書かない）
  const n0 = bt().length;
  env.run(`globalThis.__origFrozen = appYearIsFrozen_; appYearIsFrozen_ = function (fy) { return String(fy) === '${FY}'; }`);
  try {
    assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'MEASURE.BACKTEST', payload: { planId: planA } } }), /締め/);
  } finally { env.run('appYearIsFrozen_ = __origFrozen'); }
  assert.equal(bt().length, n0);
}

// ==== 9. 分析のまとめ: 外れ幅・偏り・帯に入った割合と 95% の幅。30 点・2 社に足りなければ比べない ====
{
  const sum = (rows, clients) => env.call('appBacktestSummary_(__r, __c)', { __r: rows, __c: clients || {} });
  const pt = (plan, i, method, p50, actual, band) => ({ plan_id: plan, target_ym: 'M' + i, method, p50, actual, counted: true,
    p10: band ? p50 * 0.9 : null, p90: band ? p50 * 1.1 : null });
  // 小さな例で式を確かめる
  const small = [pt('P1', 1, 'STAT_ONLY', 110, 100, true), pt('P1', 2, 'STAT_ONLY', 90, 100, true), pt('P1', 3, 'STAT_ONLY', 100, 0, true),
    Object.assign(pt('P1', 4, 'STAT_ONLY', 100, 100, true), { counted: false })];
  const s = sum(small);
  const st0 = s.methods.find((m) => m.method === 'STAT_ONLY');
  assert.deepEqual([st0.n, st0.pctN, st0.makers, st0.coverN], [3, 2, 1, 3], '数えない点は入れない。実績 0 円の点は外れ幅に入れない');
  assert.ok(Math.abs(st0.mape - 0.1) < 1e-12 && Math.abs(st0.bias) < 1e-12);
  const half = 1.959963984540054 * Math.sqrt(0.02) / Math.sqrt(2);   // 偏り [+0.1, −0.1] の標本の標準偏差 √0.02
  assert.ok(Math.abs(st0.biasLo + half) < 1e-12 && Math.abs(st0.biasHi - half) < 1e-12, '偏りの 95% の幅');
  assert.ok(Math.abs(st0.cover - 1 / 3) < 1e-12, '帯に入った割合（110 の幅 99〜121 に 100 は入る。90 の幅 81〜99・実績 0 円は外）');
  const w = env.call('appWilson_(1, 3, 1.959963984540054)');
  assert.deepEqual([st0.coverLo, st0.coverHi], w, 'Wilson の 95%');
  assert.equal(s.methods.find((m) => m.method === 'LAST_YEAR').n, 0);
  assert.equal(s.ready, false);
  // 統計だけがはっきり小さい外れ: 29 点は待つ・30 点でも 1 社なら待つ・30 点 2 社なら言う
  const many = (n, makers) => {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const p = 'P' + (i % makers), a = 1000 + i;
      rows.push(pt(p, i, 'STAT_ONLY', a * (1 + 0.02 + 0.001 * (i % 3)), a, true), pt(p, i, 'LAST_YEAR', a * (1 + 0.2 + 0.01 * (i % 5)), a), pt(p, i, 'SEASONAL', a * 0.7, a));
    }
    return rows;
  };
  const clients = { P0: 'C0', P1: 'C1' };
  const v29 = sum(many(29, 2), clients), v30one = sum(many(30, 1), clients), v30 = sum(many(30, 2), clients);
  assert.deepEqual([v29.ready, v29.compare[0].verdict], [false, 'wait'], '29 点はまだ');
  assert.deepEqual([v30one.ready, v30one.compare[0].verdict, v30one.makers], [false, 'wait', 1], '1 社だけはまだ');
  assert.deepEqual([v30.ready, v30.points, v30.makers, v30.minPoints, v30.minMakers], [true, 30, 2, 30, 2]);
  const c0 = v30.compare.find((c) => c.method === 'STAT_ONLY');
  assert.deepEqual([c0.vs, c0.n, c0.makers, c0.verdict], ['LAST_YEAR', 30, 2, 'smaller'], '外れ幅のいちばん小さい単純な方法と比べる');
  assert.ok(c0.hi < 0 && c0.lo < c0.diff && c0.diff < c0.hi);
  assert.equal(v30.compare.find((c) => c.method === 'LIVE').verdict, 'wait', '本番の点が無ければ言わない');
  // 差が 0 をまたぐなら「はっきりしない」
  const mixed = many(30, 2).map((r) => (r.method === 'STAT_ONLY' ? Object.assign({}, r, { p50: r.actual * (Number(r.target_ym.slice(1)) % 2 ? 1.35 : 1.05) }) : r));
  assert.equal(sum(mixed, clients).compare[0].verdict, 'unclear');
}

// ==== 10. 分析の画面の物差し: 計画ごとに一番新しい回だけ。割合と点の数だけ（金額・中の記号を出さない） ====
{
  const x = env.call('apiCrossMaker(__in)', { __in: { fy: FY } });
  const b = x.backtest;
  assert.equal(b.fy, String(FY));
  assert.equal(b.plans, 2, '物差しのある計画（甲・乙）');
  const lastA = bt().filter((r) => r.plan_id === planA).pop();   // 後に足した回（時刻が同じ秒でも）
  const expected = bt().filter((r) => r.plan_id === planA && r.bt_id === lastA.bt_id && r.method === 'STAT_ONLY' && r.counted).length;
  assert.equal(b.points, expected, '甲の一番新しい回の数えた点だけ（乙は 48 か月がそろわない）');
  assert.equal(b.makers, expected ? 1 : 0);
  assert.equal(b.ready, false, '1 社・30 点未満');
  assert.ok(b.compare.every((c) => c.verdict === 'wait'));
  const keys = new Set();
  const walk = (o) => { if (o && typeof o === 'object') Object.keys(o).forEach((k) => { keys.add(k); walk(o[k]); }); };
  walk(b);
  for (const k of ['actual', 'p10', 'p50', 'p90', 'plan_id', 'bt_id', 'seed']) assert.ok(!keys.has(k), '金額・中の印は送らない: ' + k);
  // 閲覧の人にも同じ（計画の数字と同じ範囲。割合だけ）
  env.task(`saveMember({ email: 'viewer@bigm2y.com', displayName: 'V' })`);
  env.as('viewer@bigm2y.com');
  assert.deepEqual(env.call('apiCrossMaker(__in)', { __in: { fy: FY } }).backtest, b);
  env.as(OWNER);
  // 物差しを動かしていない年度は出さない
  assert.equal(env.call('apiCrossMaker(__in)', { __in: { fy: FY - 1 } }).backtest, null);

  // 画面（UI.html の script を vm で読む）
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: (t, k) => "<i data-pose=\\"" + String(k) + "\\"></i>" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
  const ui = vm.createContext({ document: { getElementById: () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} }), querySelector: () => null, addEventListener() {} },
    setTimeout: () => 0, clearTimeout() {}, confirm: () => false, window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  const render = (d) => { ui.__d = d; return vm.runInContext('anBacktestCard(__d)', ui); };
  const clean = (html) => {
    assert.ok(!/undefined|NaN|null/.test(html), '中身の無い値を出さない');
    assert.ok(!/STAT_ONLY|LAST_YEAR|TWO_YEAR|SEASONAL|LIVE|\bP10\b|\bP90\b|BT-|BTP-/.test(html), '中の記号を出さない');
    return html;
  };
  const card = clean(render(x));
  assert.match(card, /<h2>物差し<span class="tip"/);
  assert.match(card, /<p class="note" data-tip="点が 30 以上・2 社以上になると比べます（今は \d+ 点・[01] 社）">まだ判断できません<\/p>/);
  for (const name of ['統計だけ', '本番', '前年同月', '2 年平均', '季節加重']) assert.ok(card.includes('>' + name + '</td>'), name);
  assert.match(card, /<th class="num"[^>]*>外れ幅<\/th><th class="num"[^>]*>偏り<\/th><th class="num"[^>]*>帯に入る<\/th><th class="num"[^>]*>点<\/th>/);
  assert.match(card, />\d+\.\d% <span class="note">\d+\.\d%〜\d+\.\d%<\/span><\/td>/, '外れ幅に 95% の幅を添える');
  assert.match(card, /data-tip="単純な方法には幅がありません">-<\/td>/);
  // 30 点・2 社の例（はっきり小さい）では言う。本番の点が無ければ本番はまだ
  const ready = { fy: '2026', backtest: Object.assign({ fy: '2026', plans: 2 }, env.call('appBacktestSummary_(__r, __c)', { __r: (() => {
    const rows = [];
    for (let i = 0; i < 30; i++) { const p = 'P' + (i % 2), a = 1000 + i; rows.push({ plan_id: p, target_ym: 'M' + i, method: 'STAT_ONLY', p50: a * 1.02, p10: a * 0.9, p90: a * 1.1, actual: a, counted: true },
      { plan_id: p, target_ym: 'M' + i, method: 'LAST_YEAR', p50: a * (1.2 + 0.01 * (i % 5)), actual: a, counted: true }); }
    return rows; })(), __c: { P0: 'C0', P1: 'C1' } })) };
  const said = clean(render(ready));
  assert.match(said, />統計だけ：単純な方法より外れが小さい・本番：まだ判断できません<\/p>/);
  assert.match(said, /外れ幅の差（統計だけ − 前年同月） -?\d+\.\d%（95% の幅 -?\d+\.\d%〜-?\d+\.\d%・30 点・2 社）/);
  assert.equal(render({ fy: '2026', backtest: null }), '', '物差しが無ければカードを出さない');
  assert.equal(render({ fy: '2026' }), '', '古いサーバー（backtest が無い）でも描ける');
  // 分析の俯瞰の最後に出る
  ui.__a = x;
  const view = vm.runInContext(`S.view = 'analysis'; S.an.data = __a; S.an.fy = __a.fy; S.an.tab = 'overview'; viewAnalysis()`, ui);
  assert.ok(!/undefined|NaN/.test(view));
  assert.ok(view.endsWith(card), '物差しは俯瞰の最後');
}

console.log('app-v10-backtest: all tests passed');
