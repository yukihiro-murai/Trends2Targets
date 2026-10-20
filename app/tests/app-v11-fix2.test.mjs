#!/usr/bin/env node
/**
 * app-v11-fix2.test.mjs — 表の版 11（v0.31.0）の 2 回目の確かめで見つかったことの直し（2026-10-09）。本番の計画の年度の途中は、予測の画面の中心が
 * 着地の推定になったので、ほかの画面で「中心」と月ごとの中心の合計を取り違えない:
 *   D1. 根拠: 最終の中心（annual.p50）は予測の画面と同じ見せる中心（basis・k も。控えの後で毎回のせる）。月ごとの中心の合計は annual.monthSum。
 *       過去の売上からの差・前回からは月の合計どうしで比べ、画面はそう言う（中心が月の合計と違うとき）
 *   D2. 予算の下書きの 1 行: 下書きのときと今の値・動き（月ごとの中心の合計）を、上の中心が月の合計の本番の計画のときだけ「中心」と言う
 *   D3. 分析の見直しの流れ: 本番の回の値は月の合計（「中心」と言わない）。前回からは同じ作り方の値どうし（revisions[].monthSum: 本番の回がある計画の回）。
 *       最新の中心は今の中心で作り方を添える。本番でも旧来の年度合計にした回の印は「旧来の計算」
 *   D4. 確率で決める欄（選ぶ前）: 過去の平均の形（過去の売上が 2 年分そろわなければ予測の月の形）
 *   D5. 計算のしかたが違う値どうしの比べ（本番の前の公式版と今の中心の差・旧来の計算の回から本番の回への前回から）に、そう添える
 * 名前と数字はテスト用の架空のもの。モックの上の確かめで、本物の Apps Script・ブラウザの上では動かしていない。
 *
 *   node app/tests/app-v11-fix2.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { J, OWNER, makeEnv, uiHtml } from './gas-mock.mjs';

const near = (a, b, tol, msg) => assert.ok(typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol, `${msg || ''}: ${a} と ${b}`);
const fyYms = (fy) => Array.from({ length: 12 }, (_, i) => { const m = 4 + i; return (m > 12 ? fy + 1 : fy) + '/' + String(m > 12 ? m - 12 : m).padStart(2, '0'); });
const obj = (H, o) => H.map((h) => (o[h] === undefined ? '' : o[h]));

/** 計画のブック（app-v11-fix-srv.test.mjs と同じ形。月の P50 は 1,000 円 × 12 = 12,000 円・旧来の年度合計 11,500 円） */
function planBook(env, client, fy, { cmp = {}, owner = false } = {}) {
  const H = (name) => J(env.run(`APP_ENGINE_SHEETS.${name}.header`));
  const HC = H('EVAL_COMPARE_MONTHLY'), HP = H('PROCESS_STATUS'), HCAL = H('CALIBRATION_STATE'), HSN = H('FORECAST_SNAPSHOT');
  const yms = fyYms(fy);
  const output = [['FY' + fy + ' 売上予測（' + client + '）']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 11000, 11500, 12000]);
  output.push([], ['月', 'P10', 'P50', 'P90', '', '', '', '採用予測', '上乗せ']);
  yms.forEach((ym) => output.push([ym, 800, 1000, 1200, '', '', '', 1000, '']));
  return env.makeBook(client, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    OUTPUT: { values: output, formats: { A: '@' } },
    EVAL_COMPARE_MONTHLY: { values: [HC, ...Object.entries(cmp).map(([ym, act]) => obj(HC, { target_month: ym, actual_total: act }))], formats: { A: '@' } },
    PROCESS_STATUS: { values: [HP, ['step2_status', new Date(2026, 9, 5, 10), 'owner', 'success', client, 10, ''], ['step5_status', new Date(2026, 9, 5, 11), 'owner', 'success', '', 6, '']] },
    CALIBRATION_STATE: { values: [HCAL, obj(HCAL, { client, bias_correction_factor: 1, residual_month_bias_json: '', auto_update_enabled: owner ? 0 : 1,
      note: owner ? 'owner-approved 2026-10-01 10:00: D7' : 'auto-learned' })] },
    FORECAST_SNAPSHOT: { values: [HSN, obj(HSN, { snapshot_id: 'S1', run_date: new Date(2026, 9, 2, 9), client, target_month: yms[0], scenario: 'neutral', final_pred: 1000,
      calibration_applied_json: JSON.stringify({ version: 'v', bias_correction_factor: 1, residual_month_bias_json: '' }) })], formats: { D: '@' } },
  });
}

/**
 * 本番の計画（年度の途中 k = 6・締まった月なし k = 0）と本番でない計画。予測の回: 前の回は本番でない（月の P50 990 円 = 合計 11,880 円）、
 * 今の回は本番（月の P50 1,000 円 = OUTPUT と同じ）。過去の売上だけは月 900 円（合計 10,800 円）。本番の回が 11 か月しかない計画も
 */
function setup() {
  const env = makeEnv();
  env.run(`appToday_ = function () { return '2026-10-06'; }`);
  env.as(OWNER);
  env.call('apiSetup()');
  const low = Object.fromEntries(fyYms(2026).slice(0, 6).map((ym) => [ym, 800]));   // 締まった 6 か月の実績が予測の 8 割
  const idMid = env.seedPlan(planBook(env, '途中製薬', 2026, { owner: true, cmp: low }));
  const idNext = env.seedPlan(planBook(env, '来年度製薬', 2027, { owner: true }));
  const idTrial = env.seedPlan(planBook(env, '試し製薬', 2026, { owner: false, cmp: low }));
  const idShort = env.seedPlan(planBook(env, '欠け製薬', 2026, { owner: true, cmp: low }));
  const run = (id, planId, at, fixes, a50, yms, p50) => ({ run: { run_id: id, plan_id: planId, status: 'DONE', annual_p10: a50 - 500, annual_p50: a50, annual_p90: a50 + 500,
    objective_p50: 10500, started_at: at, finished_at: at, actor_email: OWNER, fixes_json: JSON.stringify(fixes) },
  monthly: yms.map((ym) => ({ run_id: id, plan_id: planId, ym, p10: p50 - 200, p50, p90: p50 + 200, obj_p50: 900 })) });
  const A1 = '2026-09-01T10:00:00+0900', A2 = '2026-10-02T09:00:00+0900';
  const runs = [run('R-MID-1', idMid, A1, [], 11400, fyYms(2026), 990), run('R-MID-2', idMid, A2, ['annual_aligned'], 11500, fyYms(2026), 1000),
    run('R-NEXT-1', idNext, A1, [], 11400, fyYms(2027), 990), run('R-NEXT-2', idNext, A2, ['annual_aligned'], 11500, fyYms(2027), 1000),
    run('R-TRIAL-1', idTrial, A1, [], 11400, fyYms(2026), 990), run('R-TRIAL-2', idTrial, A2, [], 11600, fyYms(2026), 1000),
    run('R-SHORT-1', idShort, A1, [], 11400, fyYms(2026), 990), run('R-SHORT-2', idShort, A2, ['annual_aligned'], 11500, fyYms(2026).slice(0, 11), 1000)];
  env.run(`appWithLock_(() => { appInsertRows_('FORECAST_RUNS', __r); appInsertRows_('FORECAST_MONTHLY', __m); }); appBumpGen_();`,
    { __r: runs.map((x) => x.run), __m: [].concat(...runs.map((x) => x.monthly)) });
  return { env, idMid, idNext, idTrial, idShort };
}

// ---- 画面（UI.html の script を vm で読む） ----
const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
  .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
  .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: false, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
const ui = vm.createContext({ document: { getElementById: () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} }), querySelector: () => null, addEventListener() {} },
  setTimeout: () => 0, clearTimeout() {}, confirm: () => false, window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
  google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
vm.runInContext(js, ui);
const R = (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const tipsOf = (html) => [...html.matchAll(/data-tip="([^"]*)"/g)].map((m) => unesc(m[1]));
const visible = (html) => html.replace(/<[^>]*>/g, ' ');
const CODES = /\b(monthsum|landing|actual|basis|monthSum|shownCenter|p50Shown|legacy|live|LIVE|SHADOW|PAST_SHAPE|FORECAST_SHAPE)\b|undefined|NaN/;
const noCodes = (html, why) => { assert.doesNotMatch(visible(html), CODES, why); tipsOf(html).forEach((t) => assert.doesNotMatch(t, CODES, why + ': ' + t)); };
const yu = (n) => R(`yenU(${n})`);
const ys = (n) => R(`yenShort(${n})`);
const ay = (n) => R(`anYen(${n})`);   // 分析の金額の見せ方（1.2万円など）
/** 数字の箱（fcKpi）: { v: 見える値, tip: 説明の行 } */
const kpi = (h, label) => {
  const m = new RegExp('<div class="kpi( main)?"( data-tip="([^"]*)")?><div class="k">' + label + '</div><div class="v">([\\s\\S]*?)</div>').exec(h);
  assert.ok(m, '数字の箱: ' + label);
  return { v: m[4].replace(/<span class="u">円<\/span>/, ''), tip: m[3] === undefined ? [] : unesc(m[3]).split('\n') };
};

/** 直しごとに分けて動かす（前の版で、どの直しのテストも落ちることを確かめられるように）。落ちた部分があれば最後に止める */
const failed = [];
function part(name, fn) {
  try { fn(); } catch (e) { failed.push(name); console.error('FAIL ' + name + '\n' + (e && e.stack ? e.stack : e)); }
}

// ==== D1. 根拠の最終の中心 = 予測の画面の中心 ====
part('D1 根拠の最終の中心', () => {
  const { env, idMid, idNext, idTrial } = setup();
  const basisOf = (id) => env.call('apiForecastBasis(__in)', { __in: { planId: id } });
  const shownOf = (id) => env.call('apiForecastLatest(__in)', { __in: { planId: id } }).shadow.annual;
  // ---- 年度の途中（k = 6）: 予測の画面の中心は着地の推定（月の合計 12,000 円より下） ----
  const sh = shownOf(idMid);
  assert.deepEqual([sh.basis, sh.k, sh.monthSum], ['landing', 6, 12000]);
  assert.ok(sh.p50 < 12000 - 1, '前提: 実績が予測より低いので、着地の推定は月の合計より下: ' + sh.p50);
  const b = basisOf(idMid);
  assert.deepEqual([b.annual.live, b.annual.basis, b.annual.k], [true, 'landing', 6]);
  near(b.annual.p50, sh.p50, 1e-9, '根拠の最終の中心 = 予測の画面の中心（着地の推定）');
  assert.deepEqual([b.annual.monthSum, b.annual.objective, b.annual.prevP50], [12000, 10800, 11880], '月ごとの中心の合計・過去の売上だけ・前回は月の合計');
  assert.equal(b.annual.monthSum, b.monthly.reduce((s, m) => s + m.p50, 0), '月ごとの内訳の合計');
  assert.deepEqual(b.annual.legacy, { p50: 11500, objective: 10500, prevP50: 11400 }, '旧来の年度合計は残す');
  // 公式版の今の中心・分析の中心とも同じ
  near(env.call('apiVersionList(__in)', { __in: { planId: idMid } }).current.shown.p50, b.annual.p50, 1e-9, '公式版の今の中心');
  near(env.call('apiCrossMaker(__in)', { __in: { fy: '2026' } }).plans.find((x) => x.planId === idMid).p50, b.annual.p50, 1e-9, '分析の中心');
  // 見せる中心は控えの外で毎回のせる（控えた根拠を読むときも、今の見せる中心）
  env.run(`__keepT = appEngTableObjects_; appEngTableObjects_ = function () { throw new Error('控えから読むはず'); };
    __keepS = appPlanShadow_; appPlanShadow_ = function (id) { const s = __keepS(id); return s && s.annual ? Object.assign({}, s, { annual: Object.assign({}, s.annual, { p50: 7777, k: 7 }) }) : s; };`);
  try {
    const c = basisOf(idMid);
    assert.deepEqual([c.annual.p50, c.annual.k, c.annual.basis, c.annual.monthSum, c.annual.objective], [7777, 7, 'landing', 12000, 10800], '控えた根拠に今の見せる中心をのせる');
    env.run(`appPlanShadow_ = function () { return null; };`);
    const d = basisOf(idMid);
    assert.deepEqual([d.annual.p50, d.annual.basis, d.annual.monthSum], [12000, 'monthsum', 12000], '見せる中心が読めなければ月の合計のまま');
  } finally {
    env.run(`appEngTableObjects_ = __keepT; appPlanShadow_ = __keepS;`);
  }
  // ---- 締まった月なし（k = 0）: 見せる中心 = 月の合計 ----
  const n = basisOf(idNext);
  assert.deepEqual([n.annual.live, n.annual.basis, n.annual.k, n.annual.p50, n.annual.monthSum, n.annual.prevP50], [true, 'monthsum', 0, 12000, 12000, 11880]);
  // ---- 本番でない: 今までどおり旧来の年度合計 ----
  const t = basisOf(idTrial);
  assert.deepEqual([t.annual.live, t.annual.p50, t.annual.basis, t.annual.monthSum], [undefined, 11600, undefined, undefined]);

  // ---- 画面: 根拠のタブ ----
  const tab = (r) => { const h = R(`S.fc.planId = __r.planId; S.fc.basis = __r; fcBasisTab({}, {})`, { __r: J(r) }); noCodes(h, '根拠'); return h; };
  const say = (h) => /<h2>前回の予測からの変化[\s\S]*?<p class="fc-say"[^>]*>([^<]*)<\/p>/.exec(h)[1];
  let h = tab(b);
  let k = kpi(h, '今回の予測');
  assert.equal(k.v, ys(b.annual.p50), '見える値は予測の画面と同じ中心');
  assert.deepEqual(k.tip, ['上下に半々で外れる見込みの真ん中（年度合計。予測と予算の画面と同じ）', yu(b.annual.p50), '着地の推定です（締まった 6 か月の実績＋残りの月の予測。補正を入れた値）',
    '月ごとの中心の合計 12,000 円（下の月ごとの内訳の合計。過去の売上からの差と前回からは、この合計で比べます）']);
  k = kpi(h, '過去実績ベース');
  assert.deepEqual([k.v, k.tip[0]], [ys(10800), '人の入力や AI を入れない、過去の売上だけの予測']);
  k = kpi(h, '足した分');
  assert.deepEqual([k.v, k.tip[0], k.tip[1]], ['+' + ys(1200), '今回の予測 − 過去実績ベース。入力・AI・スポット・補正の合計', '+1,200 円'],
    '月の合計どうしの差（着地の推定 − 過去の売上だけ ではない）');
  k = kpi(h, '前回から');
  assert.deepEqual([k.v, k.tip[0], k.tip[1]], ['+' + ys(120), '前回の予測からの変化', '+120 円']);
  assert.equal(say(h), '月ごとの中心の合計は前回より ' + ys(120) + '円 上がりました');
  // 締まった月なし: 中心は月の合計なので「年度の中心」のまま（月ごとの中心の合計の行は出さない）
  h = tab(n);
  k = kpi(h, '今回の予測');
  assert.deepEqual(k.tip, ['上下に半々で外れる見込みの真ん中（年度合計。予測と予算の画面と同じ）', '12,000 円', '月ごとの中心を足した値です（補正を入れた値）']);
  assert.match(kpi(h, '足した分').tip[0], /^今回の予測 − 過去実績ベース。/);
  assert.equal(kpi(h, '前回から').tip[0], '前回の予測からの変化');
  assert.equal(say(h), '年度の中心は前回より ' + ys(120) + '円 上がりました');
  // 12 か月の実績（実績の合計）
  h = tab(Object.assign(J(b), { annual: Object.assign(J(b.annual), { p50: 9600, basis: 'actual', k: 12 }) }));
  assert.deepEqual(kpi(h, '今回の予測').tip.slice(0, 3), ['12 か月の実績の合計（年度合計。予測と予算の画面と同じ）', '9,600 円', '12 か月の実績を足した値です']);
  // 本番でない: 今までどおり
  h = tab(t);
  assert.deepEqual(kpi(h, '今回の予測').tip, ['入力・AI・スポット・補正を入れた今回の予測', '11,600 円']);
  assert.equal(kpi(h, '過去実績ベース').tip[0], '人の入力や AI を入れない、過去の売上だけの予測');
});

// ==== D2. 予算の下書きの 1 行: 月ごとの中心の合計と言う ====
part('D2 予算の下書きの言い方', () => {
  const at = '2026-10-09T10:00:00+09:00';
  const dd = { basis: 'PROB', prob: 80, alloc: 'PAST_SHAPE', runId: 'FR-1', runAt: '2026-10-08T09:30:00+09:00', savedAt: at, centerAtDraft: 1000000, centerNow: 1124000,
    drift: 0.124, driftLimit: 0.1, warn: true, adopted: 915800, uplift: 50000, months: 12 };
  const line = (lv) => { const h = R(`S.fc.planId = 'P1'; S.fc.view = { can: { plan: true }, boot: { budgetDraft: __d } }; fcBudDraftLine(false, __lv)`, { __d: dd, __lv: lv }); noCodes(h, '下書き'); return tipsOf(h).map((t) => t.split('\n')); };
  const LAND = { p50: 1100000, basis: 'landing', k: 6, monthSum: 1124000 };
  let [t1, t2] = line(LAND);
  assert.deepEqual(t1.slice(-2), ['下書きを作ったときの予測（2026/10/08 09:30）の月ごとの中心の合計 1,000,000 円・今の月ごとの中心の合計 1,124,000 円',
    '上の中心は着地の推定（締まった月の実績＋残りの月）で、この合計とは違う数です'], '年度の途中の本番: 上の中心（着地の推定）と同じ数と言わない');
  assert.equal(t2[0], '下書きを作ったときから、予測の月ごとの中心の合計が +12.4% 動きました');
  [t1, t2] = line({ p50: 1300000, basis: 'actual', k: 12, monthSum: 1124000 });
  assert.equal(t1[t1.length - 1], '上の中心は実績の合計で、この合計とは違う数です');
  // 本番で中心が月の合計（締まった月なし）: 上の中心と同じ数なので「中心」
  [t1, t2] = line({ p50: 1124000, basis: 'monthsum', k: 0, monthSum: 1124000 });
  assert.equal(t1[t1.length - 1], '下書きを作ったときの予測（2026/10/08 09:30）の中心 1,000,000 円・今の中心 1,124,000 円');
  assert.equal(t2[0], '下書きを作ったときから、予測の中心が +12.4% 動きました');
  // 本番でない（上の中心は旧来の計算の年度合計）: 月ごとの中心の合計（上の中心の作り方の行は出さない）
  [t1, t2] = line(null);
  assert.equal(t1[t1.length - 1], '下書きを作ったときの予測（2026/10/08 09:30）の月ごとの中心の合計 1,000,000 円・今の月ごとの中心の合計 1,124,000 円');
  assert.equal(t2[0], '下書きを作ったときから、予測の月ごとの中心の合計が +12.4% 動きました');

  // ---- サーバーを通して: 年度の途中の本番の計画で予算を保存 → 予測と予算の画面の下書きの 1 行と上の中心 ----
  const { env, idMid } = setup();
  const v = env.call('apiPlanView(__in)', { __in: { planId: idMid } });
  const s = env.runJob('PLAN.EDIT', { planId: idMid, action: 'BUDGET.SAVE', inputHash: v.inputHash, args: { rows: [{ row: 35, adopted: 1100 }] } });
  assert.equal(s.status, 'DONE', s.error);
  const view = env.call('apiPlanView(__in)', { __in: { planId: idMid } });
  const latest = env.call('apiForecastLatest(__in)', { __in: { planId: idMid } });
  assert.deepEqual([view.boot.budgetDraft.centerAtDraft, view.boot.budgetDraft.centerNow, latest.shadow.annual.basis], [12000, 12000, 'landing'], '前提: 下書きの値は月の合計・上の中心は着地の推定');
  const html = R(`S.fc.planId = __id; S.fc.view = __v; S.fc.data = __d; S.fc.budget = {}; S.fc.confirm = null; fcBothTabs(__d, __v)`, { __id: idMid, __v: J(view), __d: J(latest) });
  assert.equal(kpi(html, '中心').v, ys(latest.shadow.annual.p50), '上の中心は着地の推定');
  assert.ok(!tipsOf(html).some((t) => t.startsWith('予算の下書き')) && !/予算の下書き/.test(html), '予算の下書きの 1 行は出さない（2026-10-13 村井さん「細かいテキストは不要」）');
});

// ==== D3・D5. 分析の見直しの流れ ====
part('D3 見直しの流れ', () => {
  const { env, idMid, idNext, idTrial, idShort } = setup();
  const cross = env.call('apiCrossMaker(__in)', { __in: { fy: '2026' } });
  const rev = (id) => cross.plans.find((x) => x.planId === id).revisions;
  // サーバー: 本番の回がある計画は、どの回にも月の合計（monthSum。前の回も）。本番の回が無い計画は読まない（null）
  assert.deepEqual(rev(idMid).map((r) => [r.live, r.p50Shown, r.basis, r.monthSum]), [[false, 11400, 'legacy', 11880], [true, 12000, 'monthsum', 12000]]);
  assert.deepEqual(rev(idTrial).map((r) => [r.live, r.p50Shown, r.basis, r.monthSum]), [[false, 11400, 'legacy', null], [false, 11600, 'legacy', null]]);
  assert.deepEqual(rev(idShort).map((r) => [r.live, r.p50Shown, r.basis, r.monthSum]), [[false, 11400, 'legacy', 11880], [true, 11500, 'legacy', null]], '本番でも月が 12 そろわない回は旧来の年度合計');
  const nx = env.call('apiCrossMaker(__in)', { __in: { fy: '2027' } }).plans.find((x) => x.planId === idNext).revisions;
  assert.deepEqual(nx.map((r) => [r.live, r.basis, r.monthSum]), [[false, 'legacy', 11880], [true, 'monthsum', 12000]]);

  // 画面
  const card = (plans) => { const h = R(`S.cv['an.rev'] = 'chart'; anRevCard(__p)`, { __p: J(plans) }); noCodes(h, '見直しの流れ'); return h; };
  const row = (h, name) => new RegExp('<tr><td data-tip="' + name + '">' + name + '</td>([\\s\\S]*?)</tr>').exec(h)[1];
  const cells = (r) => [...r.matchAll(/<td class="num"( data-tip="([^"]*)")?>([^<]*)<\/td>/g)].map((m) => ({ text: m[3], tip: m[2] === undefined ? null : unesc(m[2]).split('\n') }));
  const h = card(cross.plans);
  const mid = cross.plans.find((x) => x.planId === idMid);
  let c = cells(row(h, '途中製薬'));
  // 前回から: 今回（本番・月の合計 12,000）と前回の月の合計（11,880）で比べる（前は旧来の年度合計 11,400 と比べて +5.3%）
  assert.deepEqual(c.map((x) => x.text), ['+1.0%', R(`anYen(${mid.p50})`), '2 回']);
  assert.deepEqual(c[0].tip, ['前回 2026/09/01 ' + ay(11880) + '（月の合計）', '今回 2026/10/02 ' + ay(12000) + '（月の合計）'], '同じ作り方の値どうし（前の回の月の合計）');
  // 最新の中心: 今の中心（予測と予算の画面と同じ着地の推定）。最新の回の値（月の合計）は印つきで
  assert.deepEqual(c[1].tip, ['今の中心 ' + yu(mid.p50) + '（予測と予算の画面と同じ・着地の推定）', '最新の予測 2026/10/02 ' + ay(12000) + '（月の合計）']);
  // 流れ: 本番の回のある計画は「年間の中心」と言わず、作り方の違う回が混ざることを添える
  const spark = tipsOf(row(h, '途中製薬')).find((t) => t.startsWith('途中製薬 の見直し'));
  assert.equal(spark, '途中製薬 の見直し\n2026/09/01 ' + ay(11400) + '（旧来の計算）\n2026/10/02 ' + ay(12000) + '（月の合計）\n旧来の計算と月の合計の回は、計算のしかたが違います');
  // 見出しの説明: 本番の回は月ごとの中心の合計
  assert.match(h, /data-tip="直近の 2 回の予測の、年間の中心の変わり方（同じ作り方の値どうしで比べます。本番の回は月ごとの中心の合計）">前回から<\/th>/);
  assert.match(h, /data-tip="古い順。右の点が最新。どのメーカーも同じ縦の範囲（最初の予測からの変わり方）で描いています。本番の回は月ごとの中心の合計です">流れ<\/th>/);
  // 本番でも旧来の年度合計にした回（月が 12 そろわない）の印は旧来の計算。前回からも旧来の年度合計どうし
  c = cells(row(h, '欠け製薬'));
  assert.deepEqual(c[0].tip, ['前回 2026/09/01 ' + ay(11400) + '（旧来の計算）', '今回 2026/10/02 ' + ay(11500) + '（旧来の計算）']);
  assert.equal(c[0].text, '+0.9%');
  assert.equal(R(`anRevMark({ live: true, basis: 'legacy' })`), '旧来の計算');
  assert.equal(R(`anRevMark({ live: true, basis: 'monthsum' })`), '月の合計');
  assert.equal(R(`anRevMark({ live: true })`), '月の合計', '作り方の無い前のサーバーの本番の回は月の合計');
  assert.equal(R(`anRevMark({ live: false, basis: 'monthsum' })`), '旧来の計算');
  // 本番の回の無い計画: 今までどおり（印なし・見出しに本番の回の話を足さない）
  const only = card(cross.plans.filter((x) => x.planId === idTrial));
  assert.deepEqual(cells(row(only, '試し製薬'))[0].tip, ['前回 2026/09/01 ' + ay(11400), '今回 2026/10/02 ' + ay(11600)]);
  assert.doesNotMatch(only, /本番の回|計算のしかた/);
  // 本番の回の後に本番でない回（自動の学びを戻した）: 旧来の年度合計どうし
  const back = card([{ planId: 'P8', clientName: '戻し製薬', alignedLive: false, p50: 11600, revisions: [
    { at: '2026-09-01T10:00:00+0900', p50: 11500, live: true, p50Shown: 12000, basis: 'monthsum', monthSum: 12000 },
    { at: '2026-10-02T09:00:00+0900', p50: 11600, live: false, p50Shown: 11600, basis: 'legacy', monthSum: 12100 }] }]);
  c = cells(row(back, '戻し製薬'));
  assert.deepEqual([c[0].text, c[0].tip], ['+0.9%', ['前回 2026/09/01 ' + ay(11500) + '（旧来の計算）', '今回 2026/10/02 ' + ay(11600) + '（旧来の計算）']]);
});

part('D5 計算のしかたが違う比べ', () => {
  // 見直しの流れ: 前の回に月の合計が無い（本番の回の前の記録・前のサーバー）ときは、そのまま比べて添える
  const rh = R(`S.cv['an.rev'] = 'table'; anRevCard(__p)`, { __p: [{ planId: 'P1', clientName: 'A製薬', alignedLive: true, p50: 12000, revisions: [
    { at: '2026-09-01T10:00:00+0900', p50: 11400 }, { at: '2026-10-02T09:00:00+0900', p50: 11500, live: true, p50Shown: 12000, basis: 'monthsum' }] }] });
  noCodes(rh, '見直しの流れ（表）');
  const r = /<tr><td data-tip="A製薬">A製薬<\/td>([\s\S]*?)<\/tr>/.exec(rh)[1];
  assert.ok(r.includes('<td class="num" data-tip="前回 2026/09/01 ' + ay(11400) + '（旧来の計算）\n今回 2026/10/02 ' + ay(12000) + '（月の合計）\n前回と今回は計算のしかたが違います">+5.3%</td>'),
    '前の回に月の合計が無ければ、そのまま比べて添える: ' + r);
  assert.ok(r.includes('<td class="wrap" data-tip="2026/09/01 ' + ay(11400) + '（旧来の計算）\n2026/10/02 ' + ay(12000) + '（月の合計）\n旧来の計算と月の合計の回は、計算のしかたが違います">'));

  // 公式版: 今の中心（本番）と本番の前の公式版の中心の差
  const monthly = fyYms(2026).map((ym) => ({ month: ym, p10: 800, p50: 1000, p90: 1200, adopted: 1000, uplift: 0, final: 1000 }));
  const ver = (no, state, a50, extra) => Object.assign({ versionId: 'V' + no, no, state, inputHash: 'h', runId: 'FR-' + no, annual: { p10: a50 - 500, p50: a50, p90: a50 + 500 },
    budget: { adopted: 12000, uplift: 0, final: 12000 }, monthly, note: '', submittedAt: '2026-10-01T10:00:00+09:00', submittedBy: 'planner@bigm2y.com',
    decidedAt: '2026-10-02T10:00:00+09:00', decidedBy: OWNER, decisionNote: '', rowVersion: 1 }, extra || {});
  const tab = (shown, off) => {
    const cur = Object.assign({ annual: { p10: 11000, p50: 11500, p90: 12000 }, budget: { adopted: 12000, uplift: 0, final: 12000 }, monthly }, shown ? { shown } : {});
    const x = { planId: 'P1', frozen: false, measure: false, current: cur, inputHash: 'h', versions: [off], official: off, pending: null, pendingChanged: false, can: { submit: true, approve: true }, me: 'other@bigm2y.com' };
    const out = R(`S.fc.planId = 'P1'; S.fc.ver = __x; S.fc.verCmp = __x.official.versionId; fcVersionTab({}, {})`, { __x: J(x) });
    noCodes(out, '公式版');
    return out;
  };
  const diffTip = (h) => { const m = /<tr><td( data-tip="([^"]*)")?>中心（年度）<\/td><td class="num">[^<]*<\/td><td class="num">[^<]*<\/td><td class="num"( data-tip="([^"]*)")?>[^<]*<\/td><\/tr>/.exec(h); return { label: m[2] ? unesc(m[2]) : null, diff: m[4] ? unesc(m[4]) : null }; };
  const totalTip = (h) => { const m = /<tr class="total"><td>年度<\/td>(?:<td class="num"[^>]*>[^<]*<\/td>){5}<td class="num"( data-tip="([^"]*)")?>[^<]*<\/td><\/tr>/.exec(h); return m[2] ? unesc(m[2]) : null; };
  const LAND = { p50: 9852, basis: 'landing', live: true };
  const OLD = '公式版の中心は本番の計算に切り替える前の旧来の計算の値で、今の中心とは計算のしかたが違います';
  // 本番の前に出した公式版（試し SHADOW・版 11 より前）
  for (const off of [ver(1, 'APPROVED', 11400, { reach: { final: 0.5, adopted: 0.7, center: 11400, sd: 500, tau: 0.15, w: 1, closedMonths: 0, mode: 'SHADOW' }, shownCenter: 11400 }), ver(1, 'APPROVED', 11400)]) {
    const h = tab(LAND, off);
    const t = diffTip(h);
    assert.equal(t.diff, '今 − 公式版\n' + OLD);
    assert.ok(t.label.split('\n').includes(OLD), '中心（年度）の説明にも');
    assert.equal(totalTip(h), '今 − v1\nv1 の中心は本番の計算に切り替える前の旧来の計算の値で、今の中心とは計算のしかたが違います', '月ごとの比べの年度の差も');
  }
  // 本番で出した公式版と今の本番の中心: 添えない（作り方が月の合計と着地の推定で違っても）
  const liveOff = ver(2, 'APPROVED', 11500, { reach: { final: 0.5, adopted: 0.7, center: 12000, sd: 500, tau: 0.15, w: 1, closedMonths: 0, mode: 'LIVE' }, shownCenter: 12000 });
  let h = tab(LAND, liveOff);
  assert.equal(diffTip(h).diff, null);
  assert.equal(totalTip(h), null);
  assert.doesNotMatch(tipsOf(h).join('\n'), /計算のしかたが違います/);
  // 今が本番でない（旧来の計算）と本番で出した版
  h = tab(null, liveOff);
  assert.equal(diffTip(h).diff, '今 − 公式版\n公式版の中心は本番の計算の値で、今の中心（旧来の計算）とは計算のしかたが違います');
  // どちらも本番でない: 今までどおり
  h = tab(null, ver(1, 'APPROVED', 11400));
  assert.deepEqual(diffTip(h), { label: null, diff: null });
  assert.equal(totalTip(h), null);
});

// ==== D4. 確率で決める欄（選ぶ前）の割り振りの言い方 ====
part('D4 確率で決める前の割り振り', () => {
  const lines = (code) => R(`S.fc.planId = 'P1'; ${code}; fcProbTip()`).split('\n');
  assert.ok(lines(`S.fc.budget = {}; S.fc.budBasis = null`).includes('月への割り振りは過去の平均の形です（過去の売上が 2 年分そろわなければ予測の月の形）'), '選ぶ前');
  const chosen = lines(`S.fc.budget = { 29: { adopted: '1000' } }; S.fc.budBasis = { planId: 'P1', basis: 'PROB', prob: 60, alloc: 'FORECAST_SHAPE', annual: 12000, basisText: '', trial: false }`);
  assert.ok(chosen.includes('月への割り振りは予測の月の形です'), '選んだ後はサーバーの割り振り');
  assert.ok(!chosen.some((x) => /過去の平均/.test(x)));
  assert.ok(lines(`S.fc.budBasis = { planId: 'P1', basis: 'PROB', prob: 60, alloc: 'PAST_SHAPE' }`).includes('月への割り振りは過去の平均の形です'));
});

// ==== D6. 本番でない計画の見直しの流れの最新の中心・中心のままの下書きの言い方（2026-10-09 最後の点検） ====
part('D6 本番でない計画の最新の中心と、中心のままの下書き', () => {
  // 補正を変えて本番でなくなった計画（最新の回は本番の回で、月の合計 12,000・計画の一覧の中心 8,000）
  const rh = R(`S.cv['an.rev'] = 'chart'; anRevCard(__p)`, { __p: [{ planId: 'P1', clientName: 'A製薬', alignedLive: false, p50: 8000, revisions: [
    { at: '2026-09-01T10:00:00+09:00', p50: 8000, live: false, p50Shown: 8000, basis: 'legacy' },
    { at: '2026-10-02T10:00:00+09:00', p50: 8000, live: true, p50Shown: 12000, monthSum: 12000, basis: 'monthsum' }] }] });
  noCodes(rh, '見直しの流れ');
  assert.ok(visible(rh).includes(ay(8000)), '最新の中心は予測と予算の画面と同じ（計画の一覧の中心）');
  assert.ok(tipsOf(rh).some((t) => /今の中心 .*（予測と予算の画面と同じ）/.test(t) && /月の合計/.test(t)), '最新の回の月の合計はカーソルで');
  // 年度の途中の本番の計画で、中心のままの下書き: 上の中心（着地の推定）と取り違えない言い方
  const dd = { basis: 'CENTER', alloc: 'FORECAST_SHAPE', savedAt: '2026-10-09T10:00:00+09:00', adopted: 12000, centerAtDraft: 12000, centerNow: 12000, drift: 0, warn: false };
  const say = (lv) => visible(R(`S.fc.planId = 'P1'; S.fc.view = { can: { plan: true }, boot: { budgetDraft: __d } }; fcBudDraftLine(false, __lv)`, { __d: dd, __lv: lv }));
  assert.match(say({ basis: 'landing', k: 6, p50: 9852 }), /月ごとの予測の中心のまま/);
  assert.match(say({ basis: 'monthsum', k: 0, p50: 12000 }), /予測の中心のまま/);
  assert.doesNotMatch(say({ basis: 'monthsum', k: 0, p50: 12000 }), /月ごとの予測の中心のまま/);
});

if (failed.length) {
  console.error('app-v11-fix2: failed: ' + failed.join(' / '));
  process.exit(1);
}
console.log('app-v11-fix2: all tests passed');
