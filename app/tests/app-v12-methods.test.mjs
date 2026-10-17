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

// ==== 1. 手法の計算（式は旧来の計算の computeTriangulationParts_・buildTriangulationBase_ の 1 か所だけ） ====
const ENG = '(globalThis.__eng = globalThis.__eng || appLegacyEngine_({ SpreadsheetApp, Date, Utilities, PropertiesService, UrlFetchApp: null, HtmlService: null, Session, AppTriangulation: null }))';
const parts = (y, model, q50) => JSON.parse(JSON.stringify(env.run(`${ENG}.computeTriangulationParts_(__y, __m, __q)`, { __y: y, __m: model, __q: q50 })));
{
  const flat = new Array(12).fill(1);
  assert.deepEqual(JSON.parse(JSON.stringify(env.run(`${ENG}.TRI_PRIOR_WEIGHTS`))), JSON.parse(JSON.stringify(env.call('APP_TRI_PRIOR'))), '初めの重みは旧来の計算と新アプリで同じ');
  // まっすぐな線（季節なし）: 線形回帰・直近重視は同じ線を延ばす。シミュレーションの中心 = 線形回帰 ×（1 + 残差の中央値）
  const y = Array.from({ length: 48 }, (_, i) => 1000 + 10 * (i + 1));
  const P = parts(y, { intercept: 1000, slope: 10, seasonalIndex: flat }, 0.02);
  assert.deepEqual(P.LINEAR.slice(0, 3), [1000 + 10 * 49, 1000 + 10 * 50, 1000 + 10 * 51], '線形回帰 = 土台の式を 49 か月目から延ばす');
  P.RECENT.forEach((v, i) => assert.ok(near(v, P.LINEAR[i], 1e-9), '直線なら直近重視も同じ線'));
  P.SIM.forEach((v, i) => assert.ok(near(v, P.LINEAR[i] * 1.02), 'シミュレーションの中心'));
  const m = compute({ parts: P, spotBg: new Array(12).fill(5), lastYear: y.slice(36) });
  assert.equal(m.LINEAR[0], P.LINEAR[0] + 5, '記録は背景のスポットを足す');
  assert.deepEqual(m.LAST_YEAR, y.slice(36));
  const w = env.call('APP_TRI_PRIOR');
  m.TRI.forEach((v, i) => assert.ok(near(v, w.LINEAR * P.LINEAR[i] + w.ROBUST * P.ROBUST[i] + w.RECENT * P.RECENT[i] + w.SIM * P.SIM[i] + 5), '三角測量 = 重み付きの平均 + スポット'));
  assert.ok(near(w.LINEAR + w.ROBUST + w.RECENT + w.SIM, 1), '重みを足すと 1');
  // 旧来の土台（buildTriangulationBase_）: 中心 = 記録の三角測量 − スポット、残差を掛ける前の土台 = 中心 ÷（1 + 残差の中央値）
  const B = env.run(`${ENG}.buildTriangulationBase_(__y, __m, 0.02, __w)`, { __y: y, __m: { intercept: 1000, slope: 10, seasonalIndex: flat }, __w: w });
  B.center.forEach((c, i) => { assert.ok(near(c, m.TRI[i] - 5)); assert.ok(near(B.base[i], c / 1.02)); });
  // 重みを変えると記録も同じ重みで混ぜる
  const w2 = { LINEAR: 0.7, RECENT: 0.1, ROBUST: 0.1, SIM: 0.1 };
  const m2 = compute({ parts: P, spotBg: [], lastYear: [], weights: w2 });
  const B2 = env.run(`${ENG}.buildTriangulationBase_(__y, __m, 0.02, __w)`, { __y: y, __m: { intercept: 1000, slope: 10, seasonalIndex: flat }, __w: w2 });
  m2.TRI.forEach((v, i) => assert.ok(near(v, B2.center[i])));
  assert.ok(near(B2.weights.LINEAR, 0.7));

  // 3 年は横ばい、最後の 1 年で伸びた: 直近重視の方が高く延ばす
  const bend = Array.from({ length: 48 }, (_, i) => (i < 36 ? 1000 : 1000 + 40 * (i - 35)));
  const model = env.run(`${ENG}.fitOpsModelTrendSeason_(__y)`, { __y: bend });
  const Pb = parts(bend, Object.assign({}, model, { seasonalIndex: flat }), 0);
  assert.ok(Pb.RECENT[0] > Pb.LINEAR[0], '直近の伸びに寄る: ' + Pb.RECENT[0] + ' > ' + Pb.LINEAR[0]);

  // 季節の形（4 月が高く 8 月が低い）× 水準 1000: 季節の中央値は形を取り出す。1 か月だけの飛び値は中央値で効かない
  const shape = [1.3, 1, 1, 1, 0.7, 1, 1, 1, 1, 1, 1, 1];
  const sea = Array.from({ length: 48 }, (_, i) => 1000 * shape[i % 12]);
  sea[16] = 50000;
  const Ps = parts(sea, { intercept: 1000, slope: 0, seasonalIndex: flat }, 0);
  const avg = shape.reduce((a, b) => a + b, 0) / 12;
  shape.forEach((sh, k) => assert.ok(Math.abs(Ps.ROBUST[k] / Ps.ROBUST[1] - sh) < 0.03, k + ': ' + Ps.ROBUST[k]));
  assert.ok(avg > 0);
  // 売上が無い（新しいメーカー）: 出せる手法だけ。三角測量は線形回帰も無ければ空
  const none = compute({ parts: parts([], null, 0), spotBg: [], lastYear: [] });
  assert.deepEqual([none.LINEAR[0], none.RECENT[0], none.ROBUST[0], none.TRI[0]], [null, null, null, null]);
}

// ==== 1b. ベイズの重み（計算だけ） ====
{
  const post = (pts, own) => env.call('appTriPosterior_(__p, __o, "2026/10")', { __p: pts, __o: own });
  const floorOf = (w) => env.call('appTriFloor_(__w)', { __w: w });
  const step = (w, p) => env.call('appTriStep_(__w, __p)', { __w: w, __p: p });
  const sum = (w) => Object.values(w).reduce((a, b) => a + b, 0);
  // 3 社 × 12 か月: 季節の中央値がいつも当たり（外れ 2%）、線形回帰は 15% 外れる
  const pts = [];
  ['A', 'B', 'C'].forEach((mk) => { for (let k = 0; k < 12; k++) {
    const a = 1000, s = k % 2 ? 1 : -1;
    pts.push({ maker: mk, ym: '2026/' + String((k % 9) + 1).padStart(2, '0'), actual: a, v: { LINEAR: a * (1 + 0.15 * s), RECENT: a * (1 + 0.08 * s), ROBUST: a * (1 + 0.02 * s), SIM: a * (1 + 0.12 * s) } });
  } });
  const r = post(pts, 'A');
  assert.equal(r.points, 36);
  assert.equal(r.makers, 3);
  assert.equal(r.own, 12);
  const W = r.weights;
  assert.ok(W.ROBUST > W.RECENT && W.RECENT > W.SIM && W.SIM > W.LINEAR, '外れの小さい順に重い: ' + JSON.stringify(W));
  assert.ok(W.ROBUST > 0.6 && W.LINEAR < 0.05, '3 社 × 1 年分で、当たる手法に寄る（1 年分を 1 回の観測として数えるので極端にはならない）: ' + JSON.stringify(W));
  assert.ok(near(sum(r.weights), 1));
  const f = floorOf(r.weights);
  assert.ok(Object.values(f).every((v) => v >= 0.05 - 1e-12) && near(sum(f), 1), '下限 0.05: ' + JSON.stringify(f));
  const prior = env.call('APP_TRI_PRIOR');
  const st = step(r.weights, prior);
  assert.ok(Object.keys(prior).every((k) => Math.abs(st[k] - prior[k]) <= 0.1 + 1e-9) && near(sum(st), 1), '1 回で動けるのは ±0.10: ' + JSON.stringify(st));
  assert.ok(st.ROBUST > prior.ROBUST && st.LINEAR < prior.LINEAR, '向きは事後のほう');
  // 階層の縮め: ほかの社の点が無く、自分の点が 2 か月だけなら、初めの重みから少しだけ動く。自分の点が無ければ、ほかの社の事後のまま
  const few = post(pts.filter((p) => p.maker === 'A').slice(0, 2), 'A');
  assert.ok(Math.abs(few.weights.ROBUST - prior.ROBUST) < 0.3 && few.weights.ROBUST > prior.ROBUST, '2 か月だけ: ' + JSON.stringify(few.weights));
  const other = post(pts.filter((p) => p.maker !== 'A'), 'A');
  Object.keys(other.pool).forEach((k) => assert.ok(near(other.weights[k], other.pool[k], 1e-12), '自分の点が無ければ、ほかの社の事後 = 自分の重み'));
  // 古さの基準は証拠の中の一番新しい月: 予測した月が変わっても、同じ証拠なら同じ重み
  const later = env.call('appTriPosterior_(__p, "A", "2027/03")', { __p: pts });
  Object.keys(r.weights).forEach((k) => assert.ok(near(later.weights[k], r.weights[k], 1e-12), '同じ証拠なら月をまたいでも同じ: ' + k));
  // 4 つそろわない点・実績 0 以下の点は数えない
  assert.equal(post([{ maker: 'A', ym: '2026/04', actual: 100, v: { LINEAR: 90, RECENT: 95, ROBUST: 99 } }, { maker: 'A', ym: '2026/05', actual: 0, v: { LINEAR: 1, RECENT: 1, ROBUST: 1, SIM: 1 } }], 'A').points, 0);
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
  // 実績が 0 円の月も数える。値の無い段は除外し、全 0 の分母は比を作らない。
  const s2 = sum([{ maker: 'A', ym: '2026/04', actual: 0, v: { LINEAR: 5, FINAL: 5 } }, { maker: 'A', ym: '2026/05', actual: 100, v: { LINEAR: 110, FINAL: null } }]);
  assert.deepEqual([s2[0].n, s2[3].n], [2, 1]);
  assert.ok(near(s2[0].mape, 0.15));
  assert.equal(s2[3].mape, null);
  assert.deepEqual([s2[3].vsLinear.n, s2[3].vsLinear.makers, s2[3].vsLinear.diff, s2[3].vsLinear.verdict], [1, 0, null, 'wait']);
  // 正・0・負の実績を同じ定義で集計。メーカーごとの比の平均と、同じ点での比較を保つ。
  const mixed = [
    { maker: 'A', ym: 'M1', actual: 100, v: { LINEAR: 110, STAT: 130, PLUS_HUMAN: 120, FINAL: 120 } },
    { maker: 'A', ym: 'M2', actual: 0, v: { LINEAR: 50, STAT: 0, PLUS_HUMAN: 10, FINAL: 10 } },
    { maker: 'A', ym: 'M3', actual: -100, v: { LINEAR: -120, STAT: -100, PLUS_HUMAN: -100, FINAL: -100 } },
    { maker: 'B', ym: 'M1', actual: 100, v: { LINEAR: 120, STAT: 140, PLUS_HUMAN: 150, FINAL: 150 } },
    { maker: 'B', ym: 'M2', actual: 0, v: { LINEAR: 10, STAT: 0, PLUS_HUMAN: 0, FINAL: 0 } },
    { maker: 'B', ym: 'M3', actual: -100, v: { LINEAR: -100, STAT: -100, PLUS_HUMAN: -100, FINAL: -100 } }
  ];
  const sm = sum(mixed);
  assert.deepEqual([sm[0].n, sm[0].makers], [6, 2]);
  assert.ok(near(sm[0].mape, (80 / 200 + 30 / 200) / 2));
  assert.ok(near(sm[0].bias, (40 / 200 + 30 / 200) / 2));
  assert.ok(sm[0].mapeLo < sm[0].mape && sm[0].mapeHi > sm[0].mape, 'メーカー単位の幅');
  assert.deepEqual([sm[1].vsLinear.n, sm[1].vsLinear.makers], [6, 2]);
  assert.ok(near(sm[1].vsLinear.diff, (-50 / 200 + 10 / 200) / 2));
  assert.ok(near(sm[2].vsPrev.diff, 0.025));
  const singleStage = { maker: 'A', ym: 'ONLY_FINAL', actual: 100, v: { FINAL: 99999 } };
  const unpaired = sum(mixed.concat(singleStage));
  assert.equal(unpaired[3].n, 7);
  assert.deepEqual(unpaired[3].vsLinear, sm[3].vsLinear, '片方だけの値を paired 比較に混ぜない');
  assert.deepEqual(unpaired[3].vsPrev, sm[3].vsPrev);
  const invalid = sum([{ maker: 'A', ym: 'INVALID', actual: null, v: { LINEAR: 10, FINAL: 10 } }]);
  assert.ok(invalid.every(r => r.n === 0 && r.mape === null), '欠測を実績 0 として扱わない');
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
    assert.equal(r.calc_version, 'M-2');
    assert.ok(Math.abs(Number(r.stat) - Number(r.tri)) <= 1, r.ym + ': 統計の土台 = 三角測量（予測の土台が 4 つの手法の重み付き平均になっている。記録は円に丸める）: ' + r.stat + ' / ' + r.tri);
    assert.match(r.method_row_id, /^FMR-[0-9A-F]{24}$/);
  });
  assert.ok(rows.some((r) => Math.abs(r.plus_human - r.plus_spot) > 0), '人の入力が効いた月がある');
  assert.ok(rows.some((r) => Math.abs(Number(r.tri) - Number(r.linear)) > 1), '三角測量は線形回帰と違う');
  // 使った重み（METHOD_WEIGHTS）: 締まった月の点が無いので初めの重み
  // 計算から保存へ渡した中身（続きの処理の記録）は、上限 8,000 バイトに十分ゆとりがある
  const calcJob = env.call('appJobList_()').filter((j) => j.kind === 'FORECAST.RUN_SAVE').pop();
  assert.ok(calcJob, '保存の段の処理');
  const compact = env.call('appPayloadCompact_(__m, __t, __e)', { __m: { v: { LINEAR: [1234.56], SIM: [null] }, ms: 5, triUsed: true },
    __t: { weights: { LINEAR: 0.123456789 }, prev: { LINEAR: 1 }, hash: 'h', basis: 'PRIOR' }, __e: { betaHuman: 0.987654321, prev: { betaHuman: 1 }, hash: 'h', basis: 'PRIOR', capped: false } });
  assert.deepEqual([compact.methods.v.LINEAR[0], compact.methods.v.SIM[0], compact.tri.weights.LINEAR, compact.tri.prev, compact.eff.betaHuman, compact.eff.prev, compact.eff.hash],
    [1235, null, 0.123457, undefined, 0.987654, undefined, 'h'], '円に丸める・小数 6 桁・前の値は渡さない');
  const mw = env.table('METHOD_WEIGHTS').filter((r) => r.run_id === runA.run_id);
  assert.equal(mw.length, 1);
  assert.deepEqual([mw[0].basis, Number(mw[0].w_linear), Number(mw[0].w_recent), Number(mw[0].w_robust), Number(mw[0].w_sim), mw[0].calc_version], ['PRIOR', 0.15, 0.25, 0.4, 0.2, 'W-1']);
  assert.match(mw[0].weight_id, /^MWT-[0-9A-F]{24}$/);

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
  // 根拠の「予測の土台」: 一番新しい回の重みと手法ごとの 12 か月の合計（三角測量の合計 = その回の記録の合計）
  const b = env.call('apiForecastBasis(__in)', { __in: { planId } });
  assert.ok(b.triangulation, '根拠に予測の土台');
  assert.equal(b.triangulation.basis, 'PRIOR');
  assert.deepEqual(['LINEAR', 'RECENT', 'ROBUST', 'SIM'].map((k) => b.triangulation.weights[k]), [0.15, 0.25, 0.4, 0.2]);
  const last = env.table('FORECAST_RUNS').filter((r) => r.plan_id === planId).sort((x, y) => String(x.finished_at).localeCompare(String(y.finished_at))).pop();
  const triSum = env.table('FORECAST_METHODS').filter((r) => r.run_id === last.run_id).reduce((a, r) => a + Number(r.tri), 0);
  assert.ok(near(b.triangulation.sums.TRI, triSum, 1e-9));
  assert.ok(['LINEAR', 'RECENT', 'ROBUST', 'SIM'].every((k) => b.triangulation.sums[k] > 0));
}

// ==== 5. 証拠を集めて重みを出す（物差しの点から）・同じ証拠なら同じ重み・証拠が増えたら前の重みから ±0.10 ====
{
  const CTX = `({ actor: '${OWNER}', requestId: 'TEST', roles: [] })`;
  const plan = env.table('PLANS').find((p) => p.plan_id === planId);
  const cut = FY + '/04';
  const yms = Array.from({ length: 12 }, (_, i) => { const n = FY * 12 + 3 + i; return Math.floor(n / 12) + '/' + String(n % 12 + 1).padStart(2, '0'); });
  const rows = [];
  // 季節の中央値がよく当たり（2%）、線形回帰は 20% 外れる点を 8 か月分
  yms.slice(0, 8).forEach((ym, i) => {
    const a = 1000000, s = i % 2 ? 1 : -1;
    [['LINEAR', 0.2], ['RECENT', 0.1], ['ROBUST', 0.02], ['SIM', 0.15]].forEach(([m, e]) => rows.push({ plan_id: planId, point_id: 'BTP-T-' + m + '-' + ym, bt_id: 'BT-T1', cutoff_ym: cut,
      target_ym: ym, horizon: i + 1, method: m, p10: null, p50: a * (1 + s * e), p90: null, actual: a, real_months: 48, counted: true, engine_sha256: '', seed: '',
      calc_version: env.run('APP_BACKTEST_CALC_VERSION'), computed_at: '2026-10-15T10:00:00+0900', computed_by: OWNER }));
  });
  env.run(`appWithLock_(() => appInsertRows_('BACKTEST', __r))`, { __r: rows });
  const asOf = new Date(FY + 1, 6, 1, 10).getTime();   // 翌年度の 7 月（年度の月は全部締まっている）
  const w1 = env.call(`appTriWeights_(${CTX}, __p, __t)`, { __p: plan, __t: asOf });
  assert.equal(w1.basis, 'POSTERIOR');
  assert.equal(w1.points, 8);
  const prior = env.call('APP_TRI_PRIOR');
  assert.ok(w1.weights.ROBUST > prior.ROBUST && w1.weights.LINEAR < prior.LINEAR, '当たる手法に寄る: ' + JSON.stringify(w1.weights));
  Object.keys(prior).forEach((k) => assert.ok(Math.abs(w1.weights[k] - prior[k]) <= 0.1 + 1e-9, '初めの重みから ±0.10: ' + k));
  // 記録して、同じ証拠でもう一度: 同じ重み（何も変えずに予測し直しても数字が揺れない）
  const rec = (w, runId) => env.run(`appWithLock_(() => appJournalApply_(appTriWeightsOps_(${CTX}, __p, { tri: __w, runId: __r, asOfMs: __t })))`, { __p: plan, __w: w, __r: runId, __t: asOf });
  rec(w1, 'RUN-T1');
  const w1b = env.call(`appTriWeights_(${CTX}, __p, __t)`, { __p: plan, __t: asOf });
  Object.keys(prior).forEach((k) => assert.ok(near(w1b.weights[k], w1.weights[k], 1e-12), '同じ証拠なら同じ重み: ' + k));
  rec(w1b, 'RUN-T2');
  // 証拠が増えた（4 か月分）: 前の重み（w1）から ±0.10 だけ、さらに当たる手法へ
  const more = [];
  yms.slice(8).forEach((ym, i) => [['LINEAR', 0.2], ['RECENT', 0.1], ['ROBUST', 0.02], ['SIM', 0.15]].forEach(([m, e]) => more.push(Object.assign({}, rows[0],
    { point_id: 'BTP-T-' + m + '-' + ym, target_ym: ym, horizon: 9 + i, method: m, p50: 1000000 * (1 + (i % 2 ? 1 : -1) * e) }))));
  env.run(`appWithLock_(() => appInsertRows_('BACKTEST', __r))`, { __r: more });
  const w2 = env.call(`appTriWeights_(${CTX}, __p, __t)`, { __p: plan, __t: asOf });
  assert.equal(w2.points, 12);
  assert.notEqual(w2.hash, w1.hash);
  Object.keys(prior).forEach((k) => assert.ok(Math.abs(w2.weights[k] - w1.weights[k]) <= 0.1 + 1e-9, '前の重みから ±0.10: ' + k));
  assert.ok(w2.weights.ROBUST > w1.weights.ROBUST, 'さらに当たる手法へ: ' + w1.weights.ROBUST + ' → ' + w2.weights.ROBUST);
  assert.ok(Object.values(w2.weights).every((v) => v >= 0.05 - 1e-12));
  // 予測の「今」より後に締まる月は数えない（年度の初め: 点 0 → 初めの重み）
  const early = env.call(`appTriWeights_(${CTX}, __p, __t)`, { __p: plan, __t: new Date(FY, 3, 10).getTime() });
  assert.deepEqual([early.basis, early.points], ['PRIOR', 0]);
}

console.log('app-v12-methods: ok');
