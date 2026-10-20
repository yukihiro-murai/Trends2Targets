#!/usr/bin/env node
/**
 * app-analysis-insights.test.mjs — 分析の全体の読み解き（2026-10-13 村井さん「専門家レベルの推定・示唆・洞察をグラフで」）。
 *   1. サーバー（appCrossInsights_）: 予算の合計に届く確率（独立なら Φ((L − B) / √Σσ²)・全部同じ向きなら Φ((L − B) / Σσ)）・予算との差の内訳（|差| の大きい順）と
 *      上位 2 社の割合・不確かさの寄与（σᵢ² ÷ Σσ²・80% に届く数・実質の数）・見直しの向き（同じ作り方の値どうし・符号検定）・読みのクセのそろい方・
 *      市場の話題のそろい方と順位相関。測る専用・予算や着地の無い計画は入れない。締めた年度（σ がどれも 0）・計画の無い年度でも崩れない
 *   2. 符号検定・順位（同じ値は平均）・スピアマンの順位相関
 *   3. apiCrossMaker が insights を返す
 *   4. 画面: タブは無く 1 カラム（要点のよみ → 全体の着地の分布 → 予算との差の内訳 → 不確かさの寄与 → メーカーごとのグラフ → 物差し → 話題ごとの向き）。
 *      空模様の板は無い。要点は気になる順に 5 つまで・根拠の式はカーソル。締めた年度・数字の無い年度はよみが理由を言う。undefined・NaN・P10 などを出さない
 *   5. グラフの道具（chartWaterfall・chartNormal）: 空・幅 0 でも止まらない。滝は上から順に足す
 * モックの上の確かめで、本物の Apps Script・ブラウザの上では動かしていない。
 *
 *   node app/tests/app-analysis-insights.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setUpEnv, uiHtml, OWNER } from './gas-mock.mjs';

const env = setUpEnv();
const close = (a, b, eps = 1e-9, msg = '') => {
  assert.ok(typeof a === 'number' && typeof b === 'number', `${msg} 数ではない: ${a} / ${b}`);
  assert.ok(Math.abs(a - b) < eps, `${msg} ${a} ≈ ${b}`);
};
const Phi = (x) => env.run(`appNormCdf_(${x})`);
const J = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));   // 別の realm の配列・オブジェクトを、この realm の形に
const ins = (rows) => J(env.run('appCrossInsights_(__r)', { __r: rows }));

const rev = (...xs) => xs.map((x, i) => Object.assign({ at: '2026-0' + (5 + i) + '-01', p50: x.p50Shown, live: false, basis: 'legacy', monthSum: null }, x));
const ROWS = [
  { planId: 'PA', clientName: 'メーカーA', fy: '2026', budget: 100, budgetUsed: null, landing: 80, landingSd: 10, ratio: 0.8,
    accuracy: { n: 4, bias: 0.1 }, topics: [{ topic: 'market', score: 10 }, { topic: 'competitor', score: 20 }], revisions: rev({ p50Shown: 100 }, { p50Shown: 90 }) },
  { planId: 'PB', clientName: 'メーカーB', fy: '2026', budget: 999, budgetUsed: 200, landing: 230, landingSd: 20, ratio: 1.15,
    accuracy: { n: 3, bias: 0.05 }, topics: [{ topic: 'market', score: -10 }], revisions: rev({ p50Shown: 200 }, { p50Shown: 210 }) },
  // 本番の回（月の合計）と、その前の旧来の回: 前回は月の合計どうしで比べる（48 → 50）
  { planId: 'PC', clientName: 'メーカーC', fy: '2026', budget: 50, budgetUsed: null, landing: 45, landingSd: 5, ratio: 0.9,
    accuracy: { n: 5, bias: -0.01 }, topics: [{ topic: 'market', score: 2 }], revisions: rev({ p50Shown: 52, p50: 52, monthSum: 48 }, { p50Shown: 50, live: true, basis: 'monthsum', monthSum: 50 }) },
  // 測る専用（入れない）
  { planId: 'PD', clientName: 'メーカーD', fy: '2026', measure: true, budget: 10, landing: 100, landingSd: 50, ratio: 10,
    accuracy: { n: 6, bias: 0.3 }, topics: [{ topic: 'market', score: 50 }], revisions: rev({ p50Shown: 100 }, { p50Shown: 50 }) },
  // 着地の推定が無い（全体には入れない。読みのクセ・市場・見直しには入れる）
  { planId: 'PE', clientName: 'メーカーE', fy: '2026', budget: 100, landing: null, landingSd: null, ratio: null, accuracy: null, topics: [], revisions: [] }
];

// ==== 1. サーバー: 全体の読み解き ====
{
  const x = ins(ROWS);
  const L = 355, B = 350, sdI = Math.sqrt(100 + 400 + 25), sdT = 35;
  assert.deepEqual([x.total.plans, x.total.budget, x.total.landing, x.total.gap, x.total.settled], [3, B, L, 5, false], '予算は budgetUsed（無ければ budget）。測る専用・着地の無い計画は入れない');
  close(x.total.sdIndependent, sdI, 1e-9, '独立なら √Σσ²');
  close(x.total.sdTogether, sdT, 1e-9, '全部同じ向きなら Σσ');
  close(x.total.pIndependent, Phi(5 / sdI), 1e-12, '独立なら Φ((L − B) / √Σσ²)');
  close(x.total.pTogether, Phi(5 / sdT), 1e-12, '全部同じ向きなら Φ((L − B) / Σσ)');
  assert.ok(x.total.pTogether < x.total.pIndependent, '着地が予算より上なら、同じ向きに振れるほど届く確率は下がる');
  // 予算との差の内訳: |差| の大きい順・割合 = |差| ÷ Σ|差|
  assert.deepEqual(x.gaps.map((g) => [g.clientName, g.gap]), [['メーカーB', 30], ['メーカーA', -20], ['メーカーC', -5]]);
  close(x.gaps[0].share, 30 / 55);
  close(x.gaps.reduce((s, g) => s + g.gap, 0), x.total.gap, 1e-9, '差の合計 = 着地の推定の合計 − 予算の合計（滝の最後が合計に着く）');
  assert.equal(x.gapTop.n, 2);
  close(x.gapTop.share, 50 / 55, 1e-12, '上位 2 社の |差| の割合');
  // 不確かさの寄与: σᵢ² ÷ Σσ²・80% に届く数・実質の数 1 ÷ Σshare²
  assert.deepEqual(x.spread.map((s) => s.clientName), ['メーカーB', 'メーカーA', 'メーカーC']);
  close(x.spread[0].share, 400 / 525);
  close(x.spread.reduce((s, v) => s + v.share, 0), 1);
  assert.equal(x.spreadTop.k80, 2, 'B（76%）だけでは 80% に届かず、A を足して届く');
  close(x.spreadTop.effective, 1 / ((400 / 525) ** 2 + (100 / 525) ** 2 + (25 / 525) ** 2));
  // 見直しの向き: A −10%・B +5%・C は月の合計どうしで 48 → 50（+4.2%。旧来の年度合計 52 とは比べない）
  assert.deepEqual([x.drift.plans, x.drift.up, x.drift.down, x.drift.flat], [3, 2, 1, 0], '測る専用（−50%）は入れない');
  close(x.drift.items.find((i) => i.clientName === 'メーカーC').change, 50 / 48 - 1, 1e-12, '前回は今回と同じ作り方の値（月の合計）');
  close(x.drift.change, (90 + 210 + 50) / (100 + 200 + 48) - 1);
  assert.equal(x.drift.pValue, 1, '2 対 1 は偶然と区別できない');
  assert.deepEqual(x.drift.items.map((i) => i.clientName), ['メーカーA', 'メーカーC', 'メーカーB'], '下向きの大きい順');
  // 読みのクセ: 比べた月が 3 か月以上の計画だけ。±3% 未満は釣り合い
  assert.deepEqual([x.lean.plans, x.lean.over, x.lean.even, x.lean.under], [3, 2, 1, 0]);
  close(x.lean.meanBias, (0.1 + 0.05 - 0.01) / 3);
  // 市場: メーカーごとの話題の点数の平均（A 15 上向き・B −10 下向き・C 2 横ばい）。順位相関は 4 社から
  assert.deepEqual([x.market.makers, x.market.up, x.market.down, x.market.flat, x.market.rho, x.market.rhoN], [3, 1, 1, 1, null, 0]);
}
{
  // 締めた年度（σ がどれも 0）: 確定。寄与は出さない。確率は 0 / 1
  const settled = ins(ROWS.slice(0, 3).map((p) => Object.assign({}, p, { landingSd: 0 })));
  assert.equal(settled.total.settled, true);
  assert.deepEqual([settled.total.pIndependent, settled.total.pTogether, settled.spread, settled.spreadTop], [1, 1, [], null]);
  // 計画が無い・数字が無い: どれも空
  assert.deepEqual(ins([]), { total: null, gaps: [], gapTop: null, spread: [], spreadTop: null, drift: null, lean: null, market: null });
  const bare = ins([ROWS[4]]);
  assert.deepEqual([bare.total, bare.gaps, bare.drift, bare.lean, bare.market], [null, [], null, null, null]);
  // 2 社だけなら上位 2 社の割合は言わない（いつも 100%）
  assert.equal(ins(ROWS.slice(0, 2)).gapTop, null);
  // 予算が 0 の計画は入れない
  assert.equal(ins([Object.assign({}, ROWS[0], { budget: 0 })]).total, null);
}

// ==== 2. 符号検定・順位・順位相関 ====
{
  close(env.run('appSignTest_(7, 1)'), 2 * 9 / 256, 1e-12, '8 回中 7 回が同じ向き');
  close(env.run('appSignTest_(1, 7)'), 2 * 9 / 256, 1e-12, '向きによらない（両側）');
  assert.equal(env.run('appSignTest_(2, 2)'), 1);
  assert.equal(env.run('appSignTest_(0, 0)'), null);
  close(env.run('appSignTest_(5, 0)'), 2 / 32);
  assert.deepEqual(J(env.run('appInsightRanks_([30, 10, 20, 10])')), [4, 1.5, 3, 1.5], '同じ値は順位の平均');
  close(env.run('appSpearman_([1, 2, 3, 4], [10, 20, 30, 45])'), 1);
  close(env.run('appSpearman_([1, 1, 2], [3, 3, 1])'), -1);
  assert.equal(env.run('appSpearman_([1, 1, 1, 1], [1, 2, 3, 4])'), null, 'ばらつきが無ければ出さない');
  // 市場の順位相関（4 社以上）: 話題の点数の平均と、着地 ÷ 予算
  const four = [10, 20, 30, 40].map((s, i) => ({ planId: 'Q' + i, clientName: 'Q' + i, budget: 100, landing: 90 + i * 10, topics: [{ score: s }] }));
  const m = J(env.run('appInsightMarketTilt_(__r, (p) => p.budget)', { __r: four }));
  assert.deepEqual([m.makers, m.up, m.rhoN], [4, 4, 4]);
  close(m.rho, 1);
}

// ==== 3. apiCrossMaker が insights を返す ====
{
  const x = env.call('apiCrossMaker(__in)', { __in: {} });
  assert.ok(x.insights && 'total' in x.insights && Array.isArray(x.insights.gaps) && Array.isArray(x.insights.spread), JSON.stringify(x.insights));
}

// ==== 4. 画面 ====
const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
  .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: (t, k) => "<i data-pose=\\"" + String(k) + "\\"></i>" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
  .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
const ui = vm.createContext({ document: { getElementById: () => ({ innerHTML: '', classList: { add() {}, remove() {} } }), querySelector: () => null, addEventListener() {} }, setTimeout: () => 0, clearTimeout() {},
  window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 }, google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
vm.runInContext(js, ui);
const run = (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };
const clean = (html, what) => {
  assert.ok(!/undefined|NaN|Infinity/.test(html), what + 'に undefined・NaN を出さない');
  assert.ok(!/\bP(10|50|90)\b/.test(html.replace(/<[^>]*>/g, ' ')), what + 'に P10 などを出さない');
  return html;
};
const view = (d) => run(`S.view = 'analysis'; S.cv = {}; S.an.view = 'chart'; S.an.data = __d; S.an.fy = String(__d.fy); viewAnalysis()`, { __d: d });
const says = (html) => [...((/<div class="hero">[\s\S]*?<div class="bubble">([\s\S]*?)<\/div><\/div><\/div>/.exec(html) || [])[1] || '').matchAll(/<span class="(t[^"]*|anmiss|)"(?: data-tip="([^"]*)")?>([^<]*)<\/span>/g)]
  .map((m) => ({ cls: m[1], tip: m[2] || '', text: m[3] }));
const PLANS = ROWS.map((p) => Object.assign({ sky: 'harenochi', skyReason: 'ratio', landingP10: p.landing ? p.landing * 0.9 : null, landingP90: p.landing ? p.landing * 1.1 : null,
  pAbove: p.landing ? 0.5 : null }, p, { accuracy: p.accuracy ? Object.assign({ mape: 0.1, coverage: 0.8, coverageN: 4, leaks: 0 }, p.accuracy) : null }));
const D0 = { fy: '2026', fys: ['2026'], totals: {}, market: [], plans: PLANS, insights: ins(ROWS) };
{
  const html = clean(view(D0), '分析');
  assert.doesNotMatch(html, /subTabs|俯瞰|class="ansky"|見通しの空模様/, 'タブと空模様の板は無い');
  assert.doesNotMatch(html, /role="tablist"(?! aria-label="見せ方")/, '画面の中のタブは無い（グラフ / 表で見る だけ）');
  // 並び
  const order = ['<div class="hero">', '<h2>メーカー横断の指標', '<h2>全体の着地の分布', '<h2>予算との差の内訳', '<h2>不確かさの寄与', '<h2>着地の推定と予算', '<h2>着地 ÷ 予算と不確かさ', '<h2>予算を超える確率',
    '<h2>外れ幅', '<h2>読みのクセ', '<h2>予測の見直しの流れ', '<h2>話題ごとの向き'].map((k) => html.indexOf(k));
  assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), '1 カラムの並び: ' + order.join(','));
  assert.match(html, /<h2>メーカー横断の指標/, 'メーカー横断の熱マップ');
  // 要点: 気になる順（要確認が先）。届く確率は 独立〜同じ向き。上位 2 社・ぶれの 8 割・読みのクセ
  const s = says(html);
  assert.ok(s.length >= 3 && s.length <= 5, s.map((x) => x.text).join('\n'));
  const pI = run(`anProb(${D0.insights.total.pIndependent})`), pT = run(`anProb(${D0.insights.total.pTogether})`);
  const reach = s.find((x) => /予算の合計に届く確率/.test(x.text));
  assert.equal(reach.text, '予算の合計に届く確率は ' + pT + '〜' + pI + ' と見ています（着地の推定は予算の 101%）。');
  assert.match(reach.tip, /確率 = Φ\(\(着地の推定の合計 − 予算の合計\) ÷ ぶれ\)/, '根拠の式はカーソルで');
  assert.ok(s.some((x) => x.text === '予算との差の 9 割は、メーカーB・メーカーAの 2 社から来ています。'));
  assert.ok(s.some((x) => x.text === '全体のぶれの 8 割は、2 社（メーカーB・メーカーA）から来ています。ここが固まると、全体の幅が大きく縮む見込みです。'));
  assert.ok(s.some((x) => /3 社中 2 社で、予測が実績より高め（強気）です/.test(x.text)), '読みのクセが 3 分の 2 以上そろえば言う');
  assert.equal(s[0], reach, '予算に届く確率はいつも先頭');
  const lv = [...html.matchAll(/<span class="lvl (\w+)"/g)].map((m) => m[1]).slice(1);
  const rank = { ng: 0, warn: 1, info: 2, ok: 3 };
  assert.ok(lv.every((l, i) => i === 0 || rank[l] >= rank[lv[i - 1]]), 'ほかは気になる順: ' + lv.join(','));
  assert.match(html, /<i data-pose="discover"><\/i>/, '要確認があれば見つけた姿');
  // 予算との差の内訳: 予算（合計）→ |差| の大きい順 → 着地の推定（合計）。測る専用は入れない
  const wf = /<h2>予算との差の内訳[\s\S]*?<svg class="chart"[\s\S]*?<\/svg>/.exec(html)[0];
  const labels = [...wf.matchAll(/<text[^>]*class="lb"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['予算', 'メーカーB', 'メーカーA', 'メーカーC', '着地の推定'], 'スマホの名前の列（88px）に入る短い名前');
  assert.match(wf, />\+30円<[\s\S]*>−20円<[\s\S]*>−5円</);
  assert.doesNotMatch(wf, /メーカーD/);
  // 全体の着地の分布: 2 本の曲線・予算の点線・届く分の面。凡例に届く確率
  const dist = /<h2>全体の着地の分布[\s\S]*?<svg class="chart"[\s\S]*?<\/svg>/.exec(html)[0];
  assert.equal((dist.match(/<path d="[^"]*" class="ln s-/g) || []).length, 2, '曲線は 2 本');
  assert.match(dist, /class="area"/);
  assert.match(dist, /class="ref"/);
  assert.ok(dist.includes('独立なら：届く ' + pI) && dist.includes('全部同じ向きなら：届く ' + pT));
  // 表で見る
  const tbl = clean(run(`S.cv = { 'an.dist': 'table', 'an.wf': 'table', 'an.spread': 'table' }; viewAnalysis()`), '分析（表）');
  assert.match(tbl, /<th class="colmin">見方<\/th>[\s\S]*<td>独立なら<\/td>/);
  assert.match(tbl, /<tr class="total"><td>合計<\/td><td class="num">350 円<\/td><td class="num">355 円<\/td><td class="num">\+5円<\/td>/);
}
{
  // 締めた年度（σ がどれも 0）: 確定と言い、分布は描かない
  const rows = ROWS.slice(0, 3).map((p) => Object.assign({}, p, { landingSd: 0 }));
  const html = clean(view(Object.assign({}, D0, { fy: '2025', plans: PLANS.slice(0, 3).map((p) => Object.assign({}, p, { fy: '2025', landingSd: 0, frozen: true })), insights: ins(rows) })), '締めた年度');
  assert.ok(says(html).some((x) => x.text === 'FY2025 の着地は、予算の 101%で確定しています（予算との差 +5円）。'));
  assert.match(html, /<h2>全体の着地の分布[\s\S]*?年度の 12 か月が締まったので、着地は確定しています/);
  assert.doesNotMatch(html, /<h2>不確かさの寄与/, 'ぶれが無ければ寄与は出さない');
  assert.doesNotMatch(html, /予算の合計に届く確率/);
}
{
  // 着地の推定が無い年度: よみが理由を言う（出していないグラフの案内と重ねない）
  const plans = [Object.assign({}, PLANS[4], { sky: 'mikakunin', skyReason: 'no_forecast' })];
  const html = clean(view(Object.assign({}, D0, { plans, insights: ins([ROWS[4]]) })), '着地の無い年度');
  const s = says(html);
  assert.equal(s.length, 1, s.map((x) => x.text).join('\n'));
  assert.match(s[0].text, /^まだ着地の推定や、予測と実績の比べがないため、グラフは出していません。/);
  assert.doesNotMatch(html, /<h2>全体の着地の分布|<h2>予算との差の内訳/);
  // 古いサーバー（insights が無い）でも描ける
  clean(view(Object.assign({}, D0, { insights: undefined })), '古いサーバー');
  // 予算と着地の両方がそろう計画が無い（着地はあるが予算が無い）: 理由を言う
  const noBudget = [Object.assign({}, PLANS[0], { budget: null, budgetUsed: null, ratio: null, accuracy: null, revisions: [], topics: [] })];
  const nb = says(clean(view(Object.assign({}, D0, { plans: noBudget, insights: ins(noBudget) })), '予算の無い年度'));
  assert.ok(nb.some((x) => x.text === '予算と着地の推定がそろうメーカーがまだ無いため、全体の見通しは出していません。' && /メーカーA（予算がまだありません）/.test(x.tip)), JSON.stringify(nb));
  // 計画の無い年度
  assert.match(view(Object.assign({}, D0, { plans: [], insights: ins([]) })), /FY2026 の計画はまだありません/);
}
{
  // 見直しが下向きに偏る（符号検定）: 要確認で言う
  const many = Array.from({ length: 8 }, (_, i) => ({ planId: 'R' + i, clientName: 'R' + i, budget: 100, landing: 95, landingSd: 5, accuracy: null, topics: [],
    revisions: rev({ p50Shown: 100 }, { p50Shown: i === 0 ? 103 : 95 }) }));
  const x = ins(many);
  close(x.drift.pValue, 2 * 9 / 256, 1e-12);
  const s = says(clean(view(Object.assign({}, D0, { plans: many.map((p) => Object.assign({ sky: 'kumori', ratio: 0.95, landingP10: 90, landingP90: 100, pAbove: 0.2 }, p)), insights: x })), '見直しの偏り'));
  const dr = s.find((y) => /見直し/.test(y.text));
  assert.equal(dr.text, '直近の予測の見直しは、8 社中 7 社が下向きで、下方修正に偏っています。');
  assert.match(dr.tip, /五分五分の偶然でこれ以上偏る確率（符号検定・両側） 7%/);
}

// ==== 5. グラフの道具 ====
{
  assert.match(run('chartWaterfall([])'), /chempty/);
  assert.match(run('chartNormal([{ mean: 100, sd: 0 }])'), /chempty/, '幅 0 は描かない');
  assert.match(run('chartHeat([])'), /chempty/);
  assert.match(run('chartHeat([{ label: "甲", cells: [{ v: 0.8, text: "110%", tone: "warm", tip: "甲 予算比" }] }], { cols: ["予算比"], w: 720 })'), /<svg class="chart"|予算比/);
  // 合計が差より十分大きいときは目盛りを途中から（切れ目の印）
  const big = run('chartWaterfall([{ label: "予算", value: 1e9, total: true }, { label: "a", value: -2e7 }, { label: "b", value: 1e7 }, { label: "着地", value: 9.9e8, total: true }], { w: 720 })');
  assert.match(big, /class="brk"/);
  // 0 から始められるときは切れ目なし
  assert.doesNotMatch(run('chartWaterfall([{ label: "予算", value: 10, total: true }, { label: "a", value: -8 }, { label: "着地", value: 2, total: true }], { w: 720 })'), /class="brk"/);
  // スマホの幅でも描ける
  assert.match(run('chartNormal([{ mean: 100, sd: 10, label: "x" }, { mean: 100, sd: 20, label: "y", dashed: true }], { w: 300, ref: 110, refLabel: "予算", shade: true })'), /<svg class="chart" viewBox="0 0 300 220"/);
  // 金額の目盛り: 幅が狭くて同じ名前が並ぶときだけ小数を付ける
  assert.equal(run('chYenTicks([1e8, 2e8, 3e8])'), run('yenShort'), 'ふつうは yenShort');
  assert.deepEqual(J(run('[4.70e8, 4.72e8, 4.74e8].map(chYenTicks([4.70e8, 4.72e8, 4.74e8]))')), ['4.70億', '4.72億', '4.74億']);
  const narrow = run('chartNormal([{ mean: 4.75e8, sd: 5e6, label: "x" }], { w: 720 })');
  const ticks = [...narrow.matchAll(/<text[^>]*>([\d.,]+億)<\/text>/g)].map((m) => m[1]);
  assert.ok(ticks.length >= 3 && new Set(ticks).size === ticks.length, '同じ目盛りの名前を並べない: ' + ticks.join(' '));
  assert.equal(run('anWari(0.909)'), '9 割');
  assert.equal(run('anWari(0.99)'), 'ほぼすべて');
  assert.equal(run('anYenS(-2e7)'), '−2,000万円');
}

console.log('app-analysis-insights: all tests passed');
