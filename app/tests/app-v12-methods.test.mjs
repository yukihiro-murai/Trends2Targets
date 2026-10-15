#!/usr/bin/env node
/**
 * app-v12-methods.test.mjs — 手法ごとの予測と素の回帰との比べ（表の版 12 の FORECAST_METHODS。Methods.js。app/DESIGN_triangulation_bayes_JA.md の 1・2 章）。
 *   1. 手法の計算（計算だけ）: 線形回帰は旧来の土台の式を延ばしたもの・直近を重くした回帰は最近の伸びに寄る・ロバスト季節は季節の形を取り出す・
 *      三角測量（試し）は 4 つの重み付きの平均（出せない手法は除いて重みを割り直す）
 *   2. まとめ（計算だけ）: 外れ幅と線形回帰との差・1 つ前の段との差・点が少ない / 1 社だけ / はっきりした差
 *   3. 本物の A-9（モックの上）: 予測 1 回で 12 行。段は層ごとの効きを足したもの・最終は本番の真ん中・前年同月は前の年度の売上・
 *      予測の数字と保存する表は手法の記録が無いときと同じ（計算用ブックを書き換えない）
 *   4. 分析の画面の応答: 記録があれば実績の前でもカードを返す（点 0）
 * 数字はテスト用の作りもの。モックの上の確かめで、本物の Apps Script の上では動かしていない。
 *
 *   node app/tests/app-v12-methods.test.mjs
 */
import assert from 'node:assert/strict';
import { setUpEnv, OWNER } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const CLIENT = 'テスト製薬';
const near = (a, b, tol = 1e-9) => Math.abs(Number(a) - Number(b)) <= tol * Math.max(1, Math.abs(Number(b)));

const env = setUpEnv();
const compute = (o) => env.call('appMethodsCompute_(__o)', { __o: o });

// ==== 1. 手法の計算 ====
{
  const flat = new Array(12).fill(1);
  // まっすぐな線（季節なし）: 線形回帰・直近重視は同じ線を延ばす
  const y = Array.from({ length: 48 }, (_, i) => 1000 + 10 * (i + 1));
  const m = compute({ y, model: { intercept: 1000, slope: 10, seasonalIndex: flat }, spotBg: new Array(12).fill(5), sim: new Array(12).fill(2000), lastYear: y.slice(36) });
  assert.deepEqual(m.LINEAR.slice(0, 3), [1000 + 10 * 49 + 5, 1000 + 10 * 50 + 5, 1000 + 10 * 51 + 5], '線形回帰 = 土台の式を 49 か月目から延ばす + 背景のスポット');
  m.RECENT.forEach((v, i) => assert.ok(near(v, m.LINEAR[i], 1e-9), '直線なら直近重視も同じ線'));
  assert.deepEqual(m.LAST_YEAR, y.slice(36));
  assert.deepEqual(m.SIM, new Array(12).fill(2000));
  const w = env.call('APP_METHODS_TRI_PRIOR');
  m.TRI.forEach((v, i) => assert.ok(near(v, w.LINEAR * m.LINEAR[i] + w.ROBUST * m.ROBUST[i] + w.RECENT * m.RECENT[i] + w.SIM * m.SIM[i]), '三角測量 = 重み付きの平均'));
  assert.ok(near(w.LINEAR + w.ROBUST + w.RECENT + w.SIM, 1), '重みを足すと 1');

  // 3 年は横ばい、最後の 1 年で伸びた: 直近重視の方が高く延ばす
  const bend = Array.from({ length: 48 }, (_, i) => (i < 36 ? 1000 : 1000 + 40 * (i - 35)));
  const fit = env.call('appMethodsWls_(__y, __w)', { __y: bend, __w: new Array(48).fill(1) });
  const b = compute({ y: bend, model: { intercept: fit.intercept, slope: fit.slope, seasonalIndex: flat }, spotBg: [], sim: [], lastYear: [] });
  assert.ok(b.RECENT[0] > b.LINEAR[0], '直近の伸びに寄る: ' + b.RECENT[0] + ' > ' + b.LINEAR[0]);
  assert.deepEqual(b.SIM, new Array(12).fill(null), 'シミュレーションが無ければ空');
  b.TRI.forEach((v, i) => assert.ok(near(v, (w.LINEAR * b.LINEAR[i] + w.ROBUST * b.ROBUST[i] + w.RECENT * b.RECENT[i]) / (w.LINEAR + w.ROBUST + w.RECENT)), '出せない手法は除いて重みを割り直す'));

  // 季節の形（4 月が高く 8 月が低い）× 水準 1000: ロバスト季節は形を取り出す。1 か月だけの飛び値は中央値で効かない
  const shape = [1.3, 1, 1, 1, 0.7, 1, 1, 1, 1, 1, 1, 1];
  const sea = Array.from({ length: 48 }, (_, i) => 1000 * shape[i % 12]);
  sea[16] = 50000;   // 2 年目の 8 月だけの飛び値
  const R = env.call('appMethodsRobustSeason_(__y)', { __y: sea });
  shape.forEach((s, k) => assert.ok(Math.abs(R[k] - s) < 0.02, k + ': ' + R[k] + ' ≒ ' + s));
  const r = compute({ y: sea, model: { intercept: 1000, slope: 0, seasonalIndex: flat }, spotBg: [], sim: [], lastYear: [] });
  assert.ok(r.ROBUST[0] > r.ROBUST[1] && r.ROBUST[4] < r.ROBUST[3], '4 月が高く 8 月が低い');
  // 売上が無い（新しいメーカー）: 出せる手法だけ
  const none = compute({ y: [], model: null, spotBg: [], sim: [], lastYear: [] });
  assert.deepEqual([none.LINEAR[0], none.RECENT[0], none.ROBUST[0], none.TRI[0]], [null, null, null, null]);
}

// ==== 2. まとめ ====
{
  const sum = (pts) => env.call('appMethodsSummary_(__p, __k, __s)', { __p: pts, __k: ['LINEAR', 'STAT', 'PLUS_HUMAN', 'FINAL'], __s: ['STAT', 'PLUS_HUMAN', 'FINAL'] });
  // 4 社 × 10 か月: 線形回帰は外れ 5%、人を足すと外れ 15%（人は外した）、最終は 12%
  const pts = [];
  ['A', 'B', 'C', 'D'].forEach((mk, j) => {
    for (let k = 0; k < 10; k++) {
      const a = 1000 + 100 * j + 10 * k;
      const sgn = k % 2 ? 1 : -1;
      pts.push({ maker: mk, ym: '2026/' + String(k + 1).padStart(2, '0'), actual: a,
        v: { LINEAR: a * (1 + sgn * (0.05 + 0.002 * j)), STAT: a * (1 + sgn * (0.06 + 0.002 * j)), PLUS_HUMAN: a * (1 + sgn * (0.15 + 0.003 * j)), FINAL: a * (1 + sgn * (0.12 + 0.001 * j)) } });
    }
  });
  const s = sum(pts);
  const by = Object.fromEntries(s.map((x) => [x.key, x]));
  assert.ok(Math.abs(by.LINEAR.mape - 0.053) < 0.003, '線形回帰の外れ幅 ≒ 5.3%: ' + by.LINEAR.mape);
  assert.equal(by.LINEAR.vsLinear, null);
  assert.equal(by.STAT.vsPrev, null, '最初の段は前の段と比べない');
  assert.deepEqual([by.FINAL.vsLinear.verdict, by.PLUS_HUMAN.vsPrev.verdict, by.FINAL.vsPrev.verdict], ['larger', 'larger', 'smaller'],
    '最終は線形回帰より外れが大きい・人を足すと外れが増えた・補正で減った');
  assert.equal(by.FINAL.n, 40);
  assert.ok(by.FINAL.vsLinear.lo > 0 && by.FINAL.vsLinear.diff > 0.05);
  // 点が少ない・1 社だけ
  assert.equal(sum(pts.slice(0, 20))[3].vsLinear.verdict, 'wait', '20 点（30 点より少ない）');
  assert.equal(sum(pts.filter((p) => p.maker === 'A').concat(pts.filter((p) => p.maker === 'A').map((p) => Object.assign({}, p, { ym: '2027/' + p.ym.slice(5) })).slice(0, 25)))[3].vsLinear.verdict,
    'oneMaker', '1 社だけ');
  // 実績が 0 円以下の点と、値の無い段は数えない
  const s2 = sum([{ maker: 'A', ym: '2026/04', actual: 0, v: { LINEAR: 5, FINAL: 5 } }, { maker: 'A', ym: '2026/05', actual: 100, v: { LINEAR: 110, FINAL: null } }]);
  assert.deepEqual([s2[0].n, s2[3].n], [1, 0]);
}

// ---- 準備: 本物の A-1・A-2・A-3 で計画を作り、入力を置く（app-v10-layer-effects.test.mjs と同じ作り。年度は前の年度） ----
const FY = env.run('appFy_(new Date())') - 1;
let planId;
const viewHash = () => env.call('apiPlanView(__in)', { __in: { planId } }).inputHash;
const save = (kind, rows) => { const st = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind, rows }, inputHash: viewHash() }); assert.equal(st.status, 'DONE', kind + ': ' + st.error); };
const sales = {};
{
  const ext = Array.from({ length: 70 }, () => '');
  const rec = (product, month, amount) => { const r = ext.slice(); r[40] = CLIENT; r[45] = 'ベース'; r[49] = product; r[56] = month; r[65] = amount; return r; };
  const sheets = {};
  for (let y = FY - 5; y <= FY + 1; y++) {
    const rows = [ext.map((_, i) => 'c' + (i + 1))];
    for (let m = 1; m <= 12; m++) {
      const dt = D(y, m, 15);
      if (dt < D(FY - 5, 4, 1) || dt > D(FY + 1, 3, 31)) continue;
      const a = Math.round(1000000 + 50000 * Math.sin(m) + 12000 * (y - FY + 5) + m * 2000), b = Math.round(400000 + 20000 * Math.cos(m));
      rows.push(rec('製品A', dt, a));
      rows.push(rec('製品B', dt, b));
      sales[y + '/' + String(m).padStart(2, '0')] = a + b;
    }
    sheets['*' + y + '_actual_value'] = { cols: 70, values: rows };
  }
  const zac = env.makeBook('売上の元', sheets);
  env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
  let st = env.runJob('PLAN.CREATE', { clientName: CLIENT, fy: FY, peopleCsv: '鷹野,佐藤' });
  assert.equal(st.status, 'DONE', st.error);
  planId = st.result.planId;
  for (const action of ['IMPORT.SALES', 'SALES.AGGREGATE']) {
    st = env.runJob('PLAN.RUN', { planId, action });
    assert.equal(st.status, 'DONE', action + ': ' + st.error);
  }
  save('opinions', [{ person: '鷹野', ym: FY + '-11', step: '-5', conf: '0.6', note: '' }, { person: '佐藤', ym: FY + '-04', step: '2', conf: '0.5', note: '' }]);
  save('product', [{ person: '鷹野', product: '製品A', ym: FY + '-10', step: '5', reason: '新規' }]);
  save('client', [{ person: '佐藤', ym: FY + '-12', step: '-3', reason: '全体' }]);
  save('devspot', [{ person: '鷹野', ym: (FY + 1) + '-01', project: '案件X', amount: '3000000', conf: '0.8' }]);
}
/** 予測を動かす（「今」は前の年度の 4 月 10 日。年度の月はまだ締まっていない） */
const AS_OF = new Date(FY, 3, 10, 10).getTime();
function forecast() {
  let id = env.run(`appWithLock_(() => appEnqueueJob_('FORECAST.RUN', { planId: __p, confirms: ['extreme'], asOfMs: __t }, __by, '').id)`, { __p: planId, __t: AS_OF, __by: OWNER });
  for (let i = 0; i < 60; i++) {
    env.fireTriggers('triggerRunJob');
    const st = env.call('apiJobStatus(__in)', { __in: { jobId: id } });
    if (st.status === 'CONTINUED') { id = st.nextJobId; continue; }
    if (st.status === 'QUEUED' || st.status === 'RUNNING') { id = st.jobId; continue; }
    return st;
  }
  throw new Error('続きの処理が終わらない');
}

// ==== 3. 本物の A-9 ====
let runA;
{
  const n0 = env.errors().length;
  // 手法の計算の前と後で、計算用ブックの全部のシートの中身が同じか（書き換えない）
  env.run(`__realMethodsLive = appMethodsLive_; __same = null; appMethodsLive_ = function (ctx, plan, book) {
    const snap = () => book.getSheets().map(sh => sh.getName() + JSON.stringify(sh.getDataRange().getValues())).join('|');
    const a = snap(); const r = __realMethodsLive.apply(null, arguments); __same = a === snap(); return r; };`);
  const st = forecast();
  assert.equal(env.run('__same'), true, '手法の計算は計算用ブックを書き換えない');
  env.run('appMethodsLive_ = __realMethodsLive;');
  assert.equal(st.status, 'DONE', st.error);
  runA = env.table('FORECAST_RUNS').filter((r) => r.plan_id === planId).pop();
  const rows = env.table('FORECAST_METHODS').filter((r) => r.run_id === runA.run_id);
  assert.equal(rows.length, 12, '予測 1 回で 12 行');
  assert.equal(env.errors().slice(n0).filter((e) => /FORECAST_METHODS/.test(e.where)).length, 0, 'エラーなし');
  const monthly = Object.fromEntries(env.table('FORECAST_MONTHLY').filter((m) => m.run_id === runA.run_id).map((m) => [m.ym, m]));
  const layers = Object.fromEntries(env.table('LAYER_EFFECTS').filter((m) => m.run_id === runA.run_id).map((m) => [m.ym, m]));
  rows.forEach((r, i) => {
    const L = layers[r.ym];
    assert.ok(near(r.final, monthly[r.ym].p50), r.ym + ': 最終 = 本番の真ん中');
    const n = (k) => Number(L[k]);
    assert.ok(near(r.stat, n('stat_p50')) && near(r.plus_spot, n('stat_p50') + n('spot_yen')) && near(r.plus_human, Number(r.plus_spot) + n('human_yen')) && near(r.plus_ai, Number(r.plus_human) + n('ai_yen')),
      r.ym + ': 段は層を足したもの ' + JSON.stringify([r.stat, r.plus_spot, r.plus_human, r.plus_ai, L.stat_p50, L.spot_yen, L.human_yen, L.ai_yen]));
    for (const k of ['linear', 'recent', 'robust', 'sim', 'tri']) assert.ok(Number(r[k]) > 0, r.ym + ' ' + k + ': ' + r[k]);
    const prevYm = (Number(r.ym.slice(0, 4)) - 1) + r.ym.slice(4);
    assert.equal(Number(r.last_year), sales[prevYm], r.ym + ': 前年同月 = 前の年度の同じ月の売上');
    assert.equal(r.source, 'forecast_open');
    assert.equal(r.calc_version, 'M-1');
    assert.match(r.method_row_id, /^FMR-[0-9A-F]{24}$/);
  });
  assert.ok(rows.some((r) => Math.abs(r.plus_human - r.plus_spot) > 0), '人の入力が効いた月がある');

  // 予測の数字は、手法の記録が無いときと同じ（同じ入力なら同じ種）
  env.run('appMethodsLive_ = function () { return null; };');
  const st2 = forecast();
  assert.equal(st2.status, 'DONE', st2.error);
  env.run('appMethodsLive_ = __realMethodsLive;');
  const runB = env.table('FORECAST_RUNS').filter((r) => r.plan_id === planId).pop();
  assert.deepEqual(['annual_p10', 'annual_p50', 'annual_p90', 'seed'].map((k) => runB[k]), ['annual_p10', 'annual_p50', 'annual_p90', 'seed'].map((k) => runA[k]), '予測の数字と種は同じ');
  const rowsB = env.table('FORECAST_METHODS').filter((r) => r.run_id === runB.run_id);
  assert.equal(rowsB.length, 12, '手法が出せなくても段は残す');
  assert.ok(rowsB.every((r) => r.linear === '' || r.linear === null), '手法の列は空');
  // もう一度（手法あり）: 同じ入力なら手法の値も同じ（乱数の種は予測の種から）
  const st3 = forecast();
  assert.equal(st3.status, 'DONE', st3.error);
  const runC = env.table('FORECAST_RUNS').filter((r) => r.plan_id === planId).pop();
  const rowsC = env.table('FORECAST_METHODS').filter((r) => r.run_id === runC.run_id);
  assert.deepEqual(rowsC.map((r) => r.sim), rows.map((r) => r.sim), 'シミュレーションも同じ数字');
}

// ==== 4. 分析の画面の応答 ====
{
  const d = env.call('apiCrossMaker(__in)', { __in: { fy: String(FY) } });
  assert.ok(d.methods, '記録があればカードを返す');
  assert.equal(d.methods.live.points, 0, '実績が締まる前は点 0');
  assert.equal(d.methods.live.ready, false);
  assert.ok(d.methods.records >= 36);
  assert.deepEqual(d.methods.live.rows.map((r) => r.key), ['LAST_YEAR', 'LINEAR', 'RECENT', 'ROBUST', 'SIM', 'TRI', 'STAT', 'PLUS_SPOT', 'PLUS_HUMAN', 'PLUS_AI', 'FINAL']);
}

console.log('app-v12-methods: ok');
