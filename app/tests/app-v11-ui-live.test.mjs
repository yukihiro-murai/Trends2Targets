#!/usr/bin/env node
/*
 * app-v11-ui-live.test.mjs — 年度の見込みを本番にした計画（shadow.live）の中心を、画面のどこでも同じ値・同じ言い方にする（UI.html の script を vm で読む）。
 *   V1. 予測と予算: 月ごとの表の「年度合計」の行の下振れ・中心・上振れは、上の数字の箱と同じ本番の値（旧来の計算の年度合計はカーソルで）。
 *       カードの見出しの説明は、本番なら「年度で計算した値」と言わず作り方を言う（月の合計・着地の推定（締まった月の実績＋残りの月）・実績の合計）。
 *       実行の記録の説明（過去の売上だけの予測・これまでの実行）は、本番なら旧来の計算の値と言う
 *   V2. 数字の箱の説明: 中心の作り方（basis）を言う。中心が幅と同じ見込みの真ん中でないとき（前のサーバーの年度の途中: 月の合計の中心と
 *       着地の推定の幅・12 か月の実績）は「上下に半々」と言わない
 *   V3. 公式版: 今の中心・承認待ちのカードの中心は予測と予算の画面と同じ中心（current.shown・出したときの shownCenter）。
 *       版の一覧と比べの表の中心も shownCenter（無い版は記録の年度合計の中心）。記録の年度合計の中心はカーソルで。届く見込みの前提は「着地の推定」
 *   V4. 分析「予測の見直しの流れ」: 各回の中心は p50Shown（無ければ p50）。本番の回（月の合計など）と前の回（旧来の計算）をカーソルで分ける。
 *       最新の中心は、本番の計画なら計画の一覧の中心（予測と予算の画面と同じ）。前回からは同じ作り方の値どうしで、比べられなければ
 *       「計算のしかたが違います」と添える（2026-10-09。くわしくは app-v11-fix2.test.mjs）
 * 確かめる形: 本番（締まった月なし）・本番（締まった月あり）・前のサーバーの本番（basis なし・年度の途中）・本番でない・12 か月の実績。
 * サーバーの basis・monthSum・current.shown・shownCenter・p50Shown は同じ回の別の作業で足すので、ここでは決めた形の応答で確かめる（サーバーは通さない）。
 * 名前と数字はテスト用の架空のもの。モックの上の確かめで、本物の Apps Script・ブラウザの上では動かしていない。
 *
 *   node app/tests/app-v11-ui-live.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { uiHtml, OWNER } from './gas-mock.mjs';

const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
  .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
  .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: false, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
const ui = vm.createContext({ document: { getElementById: () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} }), querySelector: () => null, addEventListener() {} },
  setTimeout: () => 0, clearTimeout() {}, confirm: () => false, window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
  google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
vm.runInContext(js, ui);
const run = (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const tipsOf = (html) => [...html.matchAll(/data-tip="([^"]*)"/g)].map((m) => unesc(m[1]));
const visible = (html) => html.replace(/<[^>]*>/g, ' ');
const CODES = /\b(monthsum|landing|actual|basis|monthSum|shownCenter|p50Shown|legacy|live|LIVE|SHADOW)\b/;
const noCodes = (html, why) => { assert.doesNotMatch(visible(html), CODES, why); tipsOf(html).forEach((t) => assert.doesNotMatch(t, CODES, why + ': ' + t)); };
const yu = (n) => run(`yenU(${n})`);
const ys = (n) => run(`yenShort(${n})`);

// ---- 決めた形: 旧来の計算の年度合計（OUTPUT の 26 行・予測の記録）と、月ごとの中心（1 か月 1,010 万 → 月の合計 1 億 2,120 万） ----
const LEG = { p10: 100e6, p50: 110e6, p90: 120e6 };
const MONTH_SUM = 121.2e6;
const yms = Array.from({ length: 12 }, (_, i) => { const m = 4 + i; return (m > 12 ? 2027 : 2026) + '/' + String(m > 12 ? m - 12 : m).padStart(2, '0'); });
const sec = { annual: Object.assign({ adopted: MONTH_SUM, uplift: 0, final: MONTH_SUM }, LEG),
  monthly: yms.map((ym, i) => ({ row: 29 + i, month: ym, p10: 9e6, p50: 10.1e6, p90: 11.2e6, adopted: 10.1e6, uplift: '', final: 10.1e6 })) };
const latest = { annual_p10: LEG.p10, annual_p50: LEG.p50, annual_p90: LEG.p90, objective_p10: 90e6, objective_p50: 100e6, objective_p90: 110e6, finished_at: '2026-10-08T10:00:00+09:00', actor_email: OWNER };
const runs = [{ finishedAt: '2026-10-08T10:00:00+09:00', p50: LEG.p50 }, { finishedAt: '2026-10-01T10:00:00+09:00', p50: 108e6 }];
const aligned = { center: MONTH_SUM, sd: 1e7, p10: 105e6, p90: 137e6, budget: MONTH_SUM, pAbove: 0.5, tau: 0.15, w: 1, k: 0 };
// サーバーの shadow.annual の形（画面に出す年度の値。basis = 作り方・monthSum = 月ごとの中心の合計・legacy = 旧来の計算の年度合計）
const LIVE = {
  k0: { p10: 105e6, p50: MONTH_SUM, p90: 137e6, band: 'aligned', k: 0, done: false, pending: false, basis: 'monthsum', monthSum: MONTH_SUM, legacy: LEG },
  k4: { p10: 112e6, p50: 123.6e6, p90: 135e6, band: 'landing', k: 4, done: false, pending: false, basis: 'landing', monthSum: MONTH_SUM, legacy: LEG },
  old: { p10: 90e6, p50: MONTH_SUM, p90: 117.8e6, band: 'landing', k: 4, done: false, pending: false, legacy: LEG },   // 前のサーバー（basis なし）の年度の途中
  act: { p10: null, p50: 130e6, p90: null, band: '', k: 12, done: true, pending: false, basis: 'actual', monthSum: MONTH_SUM, legacy: LEG },
};
/** 予測と予算のタブ（annual: shadow.annual。null なら本番でない） */
const fcTab = (annual) => {
  const d = { plan: { planId: 'P1', clientName: 'テスト製薬', fy: 2026, frozen: false }, latest, runs, stored: null,
    shadow: { planId: 'P1', live: !!annual, annual: annual || null, aligned: annual ? Object.assign({}, aligned, { k: annual.k }) : aligned, reach: null } };
  const v = { plan: d.plan, can: { plan: true, approve: true, admin: true }, inputHash: 'h', actions: [], boot: { output: { sections: [sec] } } };
  const h = run(`S.fc.planId = 'P1'; S.fc.view = __v; S.fc.data = __d; S.fc.budget = {}; S.fc.confirm = null; S.cv.fcMonthly = S.cv.fcBudgetM = 'table'; fcBothTabs(__d, __v)`, { __d: d, __v: v });
  assert.doesNotMatch(h, /undefined|NaN/);
  return h;
};
const kpiTip = (h, k) => unesc(new RegExp('<div class="kpi[^"]*" data-tip="([^"]*)"><div class="k">' + k + '</div>').exec(h)[1]).split('\n');
const kpiVal = (h, k) => new RegExp('<div class="k">' + k + '</div><div class="v">([^<]*)').exec(h)[1];
/** 表の年度合計の行: 下振れ・中心・上振れの [値, 説明] */
const totalRow = (h) => {
  const row = /<tr class="total"><td>年度合計<\/td>([\s\S]*?)<\/tr>/.exec(h)[1];
  return [...row.matchAll(/<td class="num"( data-tip="([^"]*)")?>([^<]*)<\/td>/g)].slice(0, 3).map((m) => [m[3], m[2] === undefined ? null : unesc(m[2])]);
};
const headTip = (h) => unesc(/<h2>月ごとの見通し<span class="tip" tabindex="0" role="img" aria-label="[^"]*" data-tip="([^"]*)">/.exec(h)[1]);
// 予測の実行の注記（最新の日時・人・これまでの実行）は出さない（2026-10-13 村井さん）
const noRunMeta = (h) => assert.ok(!/fc-run|予測の記録なし|最新 \d{4}\//.test(h), '予測の実行の注記を出さない');
const LEG_LINE = '旧来の計算の年度合計 下振れ 100,000,000 円・中心 110,000,000 円・上振れ 120,000,000 円（年度の売上を何度も試して出した値。記録に残しています）';
const MID = '上下に半々で外れる見込みの真ん中';

// ==== V1・V2. 予測と予算 ====
{
  // (a) 本番でない: 今までどおり（表の年度合計は旧来の計算の年度合計・説明なし・見出しは「年度で計算した値」）
  const h = fcTab(null);
  assert.deepEqual(totalRow(h), [['100,000,000', null], ['110,000,000', null], ['120,000,000', null]]);
  assert.match(headTip(h), /\n年度合計（下振れ・中心・上振れ）は月の合計ではなく、年度で計算した値です$/);
  assert.equal(kpiTip(h, '中心')[0], MID + '（年度合計）');
  noRunMeta(h);
  assert.doesNotMatch(tipsOf(h).join('\n'), /旧来の計算/);
}
{
  // (b) 本番・締まった月なし（basis 月の合計・幅は着地見込みと同じ式）
  const lv = LIVE.k0, h = fcTab(lv);
  const row = totalRow(h);
  assert.deepEqual(row.map((x) => x[0]), ['105,000,000', '121,200,000', '137,000,000'], '表の年度合計は数字の箱と同じ本番の値');
  assert.deepEqual([kpiVal(h, '下振れ'), kpiVal(h, '中心'), kpiVal(h, '上振れ')], [ys(lv.p10), ys(lv.p50), ys(lv.p90)]);
  for (const [k, n] of [['下振れ', lv.p10], ['中心', lv.p50], ['上振れ', lv.p90]]) assert.equal(kpiTip(h, k)[1], yu(n), '数字の箱の正確な金額: ' + k);
  row.forEach((x) => assert.deepEqual(x[1].split('\n'), ['年度合計の中心は月の合計です（上の数字の箱と同じ）', LEG_LINE], '旧来の計算の年度合計はカーソルで'));
  assert.ok(!visible(h).includes('110,000,000'), '旧来の計算の年度合計の中心は、見える所に出さない');
  const ht = headTip(h);
  assert.doesNotMatch(ht, /年度で計算した値/, '本番では「年度で計算した値」と言わない');
  assert.match(ht, /\n年度合計の中心は月の合計です。旧来の計算の年度合計は、年度合計の行のカーソルで見ます$/);
  assert.deepEqual(kpiTip(h, '中心'), [MID + '（年度合計）', yu(lv.p50), '月ごとの中心を足した値です（補正を入れた値）',
    '80% の幅は、着地見込みと同じ式（締まった月なし・年の水準のぶれ 15%・幅の倍率 1 倍）でつけています', LEG_LINE], '締まった月が無ければ、月の合計が幅の真ん中');
  assert.deepEqual(kpiTip(h, '下振れ').slice(-1), ['80% の幅は、着地見込みと同じ式（締まった月なし・年の水準のぶれ 15%・幅の倍率 1 倍）でつけています']);
  noRunMeta(h);
  noCodes(h, '本番・締まった月なし');
}
{
  // (c) 本番・締まった 4 か月（basis 着地の推定・幅は着地の推定の幅）: 中心は幅と同じ見込みの真ん中
  const lv = LIVE.k4, h = fcTab(lv);
  const row = totalRow(h);
  assert.deepEqual(row.map((x) => x[0]), ['112,000,000', '123,600,000', '135,000,000']);
  assert.equal(kpiTip(h, '中心')[1], yu(lv.p50), '表の中心と数字の箱の中心は同じ');
  row.forEach((x) => assert.deepEqual(x[1].split('\n'), ['年度合計（下振れ・中心・上振れ）は着地の推定（締まった月の実績＋残りの月）です（上の数字の箱と同じ）',
    '月ごとの予測の中心の合計 121,200,000 円', LEG_LINE], '月の中心の列の合計と違うわけ・旧来の計算の年度合計'));
  assert.match(headTip(h), /\n年度合計（下振れ・中心・上振れ）は着地の推定（締まった月の実績＋残りの月）です。旧来の計算の年度合計は、年度合計の行のカーソルで見ます$/);
  assert.deepEqual(kpiTip(h, '中心'), [MID + '（年度合計）', yu(lv.p50), '着地の推定です（締まった 4 か月の実績＋残りの月の予測。補正を入れた値）',
    '80% の幅は、着地の推定（締まった 4 か月の実績を入れた見込み）の幅です', '月ごとの予測の中心の合計 121,200,000 円', LEG_LINE]);
  assert.doesNotMatch(kpiTip(h, '中心').join('\n'), /月ごとの中心を足した値です/, '着地の推定を月の合計と言わない');
  noCodes(h, '本番・締まった月あり');
}
{
  // (d) 前のサーバーの本番の年度の途中（basis なし: 中心は月の合計・幅は着地の推定）: 「上下に半々」と言わず、真ん中がずれることを言う
  const lv = LIVE.old, h = fcTab(lv);
  assert.deepEqual(totalRow(h).map((x) => x[0]), ['90,000,000', '121,200,000', '117,800,000'], '表も数字の箱と同じ値');
  const t = kpiTip(h, '中心');
  assert.equal(t[0], '月ごとの中心の合計（年度合計）');
  assert.ok(!t.join('\n').includes('上下に半々'), '真ん中でない中心に「上下に半々」と言わない');
  assert.deepEqual(t.slice(1), [yu(lv.p50), '月ごとの中心を足した値です（補正を入れた値。締まった月も予測の値のまま）',
    '80% の幅は、着地の推定（締まった 4 か月の実績を入れた見込み）の幅です', '幅の真ん中は着地の推定（締まった月の実績＋残りの月）なので、中心とはずれます', LEG_LINE]);
  assert.match(headTip(h), /\n年度合計の中心は月の合計です。/);
  // 前のサーバーの締まった月なし（basis なし・k 0）は今までどおり
  const k0old = Object.assign({}, LIVE.k0);
  delete k0old.basis; delete k0old.monthSum;
  assert.deepEqual(kpiTip(fcTab(k0old), '中心').slice(0, 3), [MID + '（年度合計）', yu(k0old.p50), '月ごとの中心を足した値です（補正を入れた値）']);
  noCodes(h, '前のサーバーの年度の途中');
}
{
  // (e) 12 か月の実績（basis 実績の合計・幅なし）
  const lv = LIVE.act, h = fcTab(lv);
  const row = totalRow(h);
  assert.deepEqual(row.map((x) => x[0]), ['-', '130,000,000', '-']);
  assert.deepEqual(row[1][1].split('\n'), ['年度合計の中心は実績の合計です（上の数字の箱と同じ）', '月ごとの予測の中心の合計 121,200,000 円', LEG_LINE]);
  assert.match(headTip(h), /\n年度合計の中心は実績の合計です。旧来の計算の年度合計は、年度合計の行のカーソルで見ます$/);
  const t = kpiTip(h, '中心');
  assert.deepEqual(t, ['12 か月の実績の合計（年度合計）', yu(lv.p50), '12 か月の実績を足した値です', '12 か月の実績がそろったので、幅はありません', '月ごとの予測の中心の合計 121,200,000 円', LEG_LINE]);
  assert.ok(!t.join('\n').includes('上下に半々'), '実績の合計に「上下に半々」と言わない');
  assert.equal(kpiVal(h, '下振れ'), '-');
  // done の無いサーバーでも、実績の合計なら幅が無いわけは同じ
  assert.equal(run('fcLiveBandTip({ band: "", basis: "actual" }, null)'), '12 か月の実績がそろったので、幅はありません');
  noCodes(h, '12 か月の実績');
}

// ==== V3. 公式版 ====
const monthly = yms.map((ym) => ({ month: ym, p10: 9e6, p50: 10.1e6, p90: 11.2e6, adopted: 10.1e6, uplift: 0, final: 10.1e6 }));
const ver = (no, state, annualP50, shownCenter, reach) => Object.assign({ versionId: 'V' + no, no, state, inputHash: 'h', runId: 'FR-' + no,
  annual: { p10: annualP50 - 10e6, p50: annualP50, p90: annualP50 + 10e6 }, budget: { adopted: 120e6, uplift: 5e6, final: 125e6 }, monthly, note: '',
  submittedAt: '2026-10-0' + no + 'T10:00:00+09:00', submittedBy: 'planner@bigm2y.com', decidedAt: state === 'SUBMITTED' ? '' : '2026-10-0' + (no + 1) + 'T10:00:00+09:00',
  decidedBy: state === 'SUBMITTED' ? '' : OWNER, decisionNote: '', rowVersion: 1, reach }, shownCenter === undefined ? {} : { shownCenter });
const verTab = ({ shown, pending, official, versions }) => {
  const cur = Object.assign({ annual: LEG, budget: { adopted: 121.2e6, uplift: 5e6, final: 126.2e6 }, monthly }, shown === undefined ? {} : { shown });
  const r = { planId: 'P1', frozen: false, measure: false, current: cur, inputHash: 'h', versions, official, pending, pendingChanged: false, can: { submit: true, approve: true }, me: 'other@bigm2y.com' };
  const h = run(`S.fc.planId = 'P1'; S.fc.ver = __r; S.fc.verCmp = __c; fcVersionTab(S.fc.data, S.fc.view)`, { __r: r, __c: official ? official.versionId : null });
  assert.doesNotMatch(h, /undefined|NaN/);
  return h;
};
// 今の中心の説明（2026-10-16: 公式版の「今の中心」の箱は予算策定の上の箱と重なるので外した。説明は比べの表の中心の行に出す）
const nowTip = (shown) => String(run(`verCurMidTip(__c)`, { __c: Object.assign({ annual: LEG, budget: { adopted: 121.2e6, uplift: 5e6, final: 126.2e6 }, monthly }, shown === undefined ? {} : { shown }) }) || '').split('\n').slice(1);
const verRows = (h) => Object.fromEntries([...h.matchAll(/<tr><td>v(\d+)<\/td><td>[\s\S]*?<\/td><td class="num"(?: data-tip="[^"]*")?>[\s\S]*?<\/td><td class="num"( data-tip="([^"]*)")?>([^<]*)<\/td>/g)].map((m) => [m[1], [m[4], m[3] === undefined ? null : unesc(m[3])]]));
// 差の欄の説明（diffTip）は、今と版の中心の計算のしかたが違うときだけ（2026-10-09。app-v11-fix2.test.mjs）
const cmpRow = (h) => { const m = /<tr><td( data-tip="([^"]*)")?>中心（年度）<\/td><td class="num">([^<]*)<\/td><td class="num">([^<]*)<\/td><td class="num"( data-tip="([^"]*)")?>([^<]*)<\/td><\/tr>/.exec(h);
  return { tip: m[2] === undefined ? null : unesc(m[2]), now: m[3], off: m[4], diff: m[7], diffTip: m[6] === undefined ? null : unesc(m[6]) }; };
const monthTotal = (h) => { const m = /<tr class="total"><td>年度<\/td>(?:<td class="num">[^<]*<\/td>){3}<td class="num"( data-tip="([^"]*)")?>([^<]*)<\/td><td class="num"( data-tip="([^"]*)")?>([^<]*)<\/td><td class="num"( data-tip="([^"]*)")?>([^<]*)<\/td><\/tr>/.exec(h);
  return { ver: m[3], verTip: m[2] === undefined ? null : unesc(m[2]), now: m[6], nowTip: m[5] === undefined ? null : unesc(m[5]), diff: m[9], diffTip: m[8] === undefined ? null : unesc(m[8]) }; };
const pendLine = (h) => /<div class="card caution"><div class="card-head"><h2>承認待ち[\s\S]*?<p>最終予算 [^・]*・([\s\S]*?)　出した人/.exec(h)[1];
const REACH = { final: 0.52, adopted: 0.71, center: 123.6e6, sd: 9e6, tau: 0.123, w: 1.25, closedMonths: 4, mode: 'LIVE' };
{
  // (a) 本番（今の中心 = current.shown）。公式版 v2 は出したときに画面に出していた中心 1 億 1,800 万（記録の年度合計の中心は 1 億 800 万）。v1 は shownCenter の無い前の版
  const v3 = ver(3, 'SUBMITTED', 110e6, 123.6e6, REACH), v2 = ver(2, 'APPROVED', 108e6, 118e6), v1 = ver(1, 'SUPERSEDED', 100e6);
  const h = verTab({ shown: { p50: 121.2e6, basis: 'monthsum', live: true }, pending: v3, official: v2, versions: [v3, v2, v1] });
  assert.doesNotMatch(h, /<div class="k">今の(中心|最終予算)<\/div>/, '今の中心・最終予算の箱は出さない（予算策定の上と重なる）');
  assert.deepEqual(nowTip({ p50: 121.2e6, basis: 'monthsum', live: true }), ['年度合計の中心は月の合計です', '旧来の計算の年度合計の中心 110,000,000 円（記録に残しています）']);
  assert.deepEqual(kpiTip(h, '確定版の中心'), ['出したときの予測の中心（承認済みの確定版・年度合計）', yu(118e6), '旧来の計算の年度合計の中心 108,000,000 円（記録に残しています）']);
  // 承認待ちのカード: 出したときに画面に出していた中心（同じカードの最終予算と同じく、出したときの値）
  const pl = pendLine(h);
  assert.equal(visible(pl).trim(), '中心 123,600,000 円');
  assert.deepEqual(tipsOf(pl), ['出したときに画面に出していた中心です\n旧来の計算の年度合計の中心 110,000,000 円（記録に残しています）']);
  // 届く見込みの前提は「着地の推定」（予測と予算の画面と同じ言い方。中心と呼ばない）
  assert.match(h, /data-tip="出したときの届く見込み\n[^"]*\n前提: 着地の推定 123,600,000 円・/);
  assert.doesNotMatch(tipsOf(h).join('\n'), /前提: 中心/);
  // 版の一覧の中心: shownCenter（無い版は記録の年度合計の中心・説明なし）
  const rows = verRows(h);
  assert.deepEqual(rows['3'], ['123,600,000', '出したときに画面に出していた中心です\n旧来の計算の年度合計の中心 110,000,000 円（記録に残しています）']);
  assert.deepEqual(rows['2'], ['118,000,000', '出したときに画面に出していた中心です\n旧来の計算の年度合計の中心 108,000,000 円（記録に残しています）']);
  assert.deepEqual(rows['1'], ['100,000,000', null], '前の版は記録の年度合計の中心（そのときの画面の中心）');
  // 今の内容を出すカードの比べ: 今 = 今の中心・公式版 = 出したときの中心
  const c = cmpRow(h);
  assert.deepEqual([c.now, c.off, c.diff], ['121,200,000', '118,000,000', '+3,200,000']);
  assert.deepEqual(c.tip.split('\n'), ['今: 今の予測の中心です（予測と予算の画面と同じ）・年度合計の中心は月の合計です・旧来の計算の年度合計の中心 110,000,000 円（記録に残しています）',
    '確定版: 出したときに画面に出していた中心です・旧来の計算の年度合計の中心 108,000,000 円（記録に残しています）']);
  // 月ごとの比べの年度の行
  const mt = monthTotal(h);
  assert.deepEqual([mt.ver, mt.now, mt.diff], ['118,000,000', '121,200,000', '+3,200,000']);
  assert.match(mt.nowTip, /^今の予測の中心です（予測と予算の画面と同じ）\n/);
  assert.match(mt.verTip, /^出したときに画面に出していた中心です\n/);
  assert.ok(!visible(h).includes('110,000,000'), '今の記録の年度合計の中心は見える所に出さない');
  noCodes(h, '公式版（本番）');
}
{
  // (b) 本番・締まった月あり（着地の推定）・承認待ちに shownCenter が無い: 承認待ちの中心は今の中心（記録の値はカーソル）
  const v2 = ver(2, 'SUBMITTED', 110e6), v1 = ver(1, 'APPROVED', 100e6);
  const h = verTab({ shown: { p50: 123.6e6, basis: 'landing', live: true }, pending: v2, official: v1, versions: [v2, v1] });
  assert.deepEqual(nowTip({ p50: 123.6e6, basis: 'landing', live: true }), ['年度合計（下振れ・中心・上振れ）は着地の推定（締まった月の実績＋残りの月）です', '旧来の計算の年度合計の中心 110,000,000 円（記録に残しています）']);
  const pl = pendLine(h);
  assert.equal(visible(pl).trim(), '中心 123,600,000 円', '承認待ちの中心は予測と予算の画面と同じ');
  assert.deepEqual(tipsOf(pl)[0].split('\n'), ['今の予測の中心です（予測と予算の画面と同じ）', '年度合計（下振れ・中心・上振れ）は着地の推定（締まった月の実績＋残りの月）です',
    'この版の記録の 旧来の計算の年度合計の中心 110,000,000 円（記録に残しています）']);
  assert.equal(kpiTip(h, '確定版の中心')[0], MID + '（承認済みの確定版・年度合計）', 'shownCenter の無い前の確定版は今までどおり');
  const cb = cmpRow(h);
  assert.deepEqual([cb.now, cb.off, cb.diff], ['123,600,000', '100,000,000', '+23,600,000']);
  assert.equal(cb.diffTip, '今 − 確定版\n確定版の中心は本番の計算に切り替える前の旧来の計算の値で、今の中心とは計算のしかたが違います', '本番の前の確定版との差');
  noCodes(h, '公式版（本番・着地の推定）');
}
{
  // (c) 12 か月の実績（実績の合計）
  const v1 = ver(1, 'APPROVED', 100e6, 100e6);
  const h = verTab({ shown: { p50: 130e6, basis: 'actual', live: true }, pending: null, official: v1, versions: [v1] });
  assert.deepEqual(nowTip({ p50: 130e6, basis: 'actual', live: true }), ['年度合計の中心は実績の合計です', '旧来の計算の年度合計の中心 110,000,000 円（記録に残しています）']);
  assert.equal(kpiTip(h, '確定版の中心')[0], MID + '（承認済みの確定版・年度合計）', '出したときの中心が記録の年度合計と同じなら今までどおり');
  assert.deepEqual(verRows(h)['1'], ['100,000,000', null]);
}
{
  // (d) 本番でない（current.shown が無い・live でない）: 今までどおり記録の年度合計の中心
  const v2 = ver(2, 'SUBMITTED', 110e6), v1 = ver(1, 'APPROVED', 100e6);
  for (const shown of [undefined, { p50: 121.2e6, basis: 'monthsum', live: false }]) {
    const h = verTab({ shown, pending: v2, official: v1, versions: [v2, v1] });
    assert.deepEqual(nowTip(shown), [], '本番でなければ今の中心に説明を足さない');
    assert.equal(pendLine(h), '中心 110,000,000 円', '説明なし');
    assert.deepEqual(Object.values(cmpRow(h)), [null, '110,000,000', '100,000,000', '+10,000,000', null]);
    assert.deepEqual(monthTotal(h), { ver: '100,000,000', verTip: null, now: '110,000,000', nowTip: null, diff: '+10,000,000', diffTip: null });
    assert.doesNotMatch(tipsOf(h).join('\n'), /旧来の計算/);
  }
}

// ==== V4. 分析「予測の見直しの流れ」 ====
const revCard = (plans, view) => { const h = run(`S.cv['an.rev'] = __v; anRevCard(__p)`, { __p: plans, __v: view }); assert.doesNotMatch(h, /undefined|NaN/); return h; };
const revRow = (h, name) => { const m = new RegExp('<tr><td data-tip="' + name + '">' + name + '</td>([\\s\\S]*?)</tr>').exec(h); return m[1]; };
const cellsOf = (row) => [...row.matchAll(/<td class="num"( data-tip="([^"]*)")?>([^<]*)<\/td>/g)].map((m) => ({ text: m[3], tip: m[2] === undefined ? null : unesc(m[2]) }));
{
  const at = (d) => '2026-' + d + 'T10:00:00+09:00';
  const plans = [
    // 本番・締まった月なし: 前の回は旧来の計算・本番の回は月の合計。最新の中心は計画の一覧の中心（予測と予算の画面と同じ）
    { planId: 'P1', clientName: 'A製薬', alignedLive: true, p50: MONTH_SUM, revisions: [{ at: at('09-01'), p50: 108e6 }, { at: at('10-01'), p50: 110e6, p50Shown: MONTH_SUM, live: true, basis: 'monthsum' }] },
    // 本番・締まった月あり: 今の中心（着地の推定）は最新の回の中心から動いている
    { planId: 'P2', clientName: 'B製薬', alignedLive: true, p50: 123.6e6, revisions: [{ at: at('09-01'), p50: 108e6, p50Shown: 118e6, live: true, basis: 'monthsum' }, { at: at('10-01'), p50: 110e6, p50Shown: 120e6, live: true, basis: 'landing' }] },
    // 本番でない: 今までどおり
    { planId: 'P3', clientName: 'C製薬', alignedLive: false, p50: 95e6, revisions: [{ at: at('09-01'), p50: 90e6 }, { at: at('10-01'), p50: 95e6 }] },
    // 12 か月の実績・前のサーバー（p50Shown なし）の本番の計画
    { planId: 'P4', clientName: 'D製薬', alignedLive: true, p50: 130e6, revisions: [{ at: at('09-01'), p50: 100e6, p50Shown: 125e6, live: true, basis: 'actual' }] },
    { planId: 'P5', clientName: 'E製薬', alignedLive: true, p50: MONTH_SUM, revisions: [{ at: at('09-01'), p50: 100e6 }, { at: at('10-01'), p50: 110e6 }] },
  ];
  const h = revCard(plans, 'chart');
  // A: 前回から = 1 億 800 万（旧来の計算）→ 1 億 2,120 万（月の合計）
  let c = cellsOf(revRow(h, 'A製薬'));
  assert.deepEqual(c.map((x) => x.text), ['+12.2%', ys(MONTH_SUM) + '円', '2 回']);
  assert.deepEqual(c[0].tip.split('\n'), ['前回 2026/09/01 1.1億円（旧来の計算）', '今回 2026/10/01 1.2億円（月の合計）', '前回と今回は計算のしかたが違います'],
    '本番の回と前の回を分ける。前の回に月の合計が無ければ、計算のしかたが違う値どうしと添える（2026-10-09）');
  assert.equal(c[1].tip, '今の中心 121,200,000 円（予測と予算の画面と同じ）', '最新の回と同じなら、その回は重ねて言わない');
  const spark = tipsOf(revRow(h, 'A製薬')).find((t) => t.startsWith('A製薬 の見直し'));
  assert.equal(spark, 'A製薬 の見直し\n2026/09/01 1.1億円（旧来の計算）\n2026/10/01 1.2億円（月の合計）\n旧来の計算と月の合計の回は、計算のしかたが違います',
    '本番の回のある流れは「年間の中心」と言わない（本番の回は月の合計）');
  // B: 着地の推定の回。最新の中心は今の中心（最新の回の値はカーソル）
  c = cellsOf(revRow(h, 'B製薬'));
  assert.deepEqual(c.map((x) => x.text), ['+1.7%', ys(123.6e6) + '円', '2 回']);
  assert.deepEqual(c[0].tip.split('\n'), ['前回 2026/09/01 1.2億円（月の合計）', '今回 2026/10/01 1.2億円（着地の推定）', '前回と今回は計算のしかたが違います']);
  assert.deepEqual(c[1].tip.split('\n'), ['今の中心 123,600,000 円（予測と予算の画面と同じ）', '最新の予測 2026/10/01 1.2億円（着地の推定）']);
  // C: 本番でない計画は今までどおり（印なし・最新の中心は最新の回）
  c = cellsOf(revRow(h, 'C製薬'));
  assert.deepEqual(c.map((x) => x.text), ['+5.6%', '9,500万円', '2 回']);
  assert.equal(c[0].tip, '前回 2026/09/01 9,000万円\n今回 2026/10/01 9,500万円');
  assert.equal(c[1].tip, null);
  // D: 実績の合計の回
  c = cellsOf(revRow(h, 'D製薬'));
  assert.deepEqual(c.map((x) => x.text), ['-', ys(130e6) + '円', '1 回']);
  assert.deepEqual(c[1].tip.split('\n'), ['今の中心 130,000,000 円（予測と予算の画面と同じ）', '最新の予測 2026/09/01 1.3億円（実績の合計）']);
  // E: 前のサーバー（p50Shown なし）でも、最新の中心は今の中心
  c = cellsOf(revRow(h, 'E製薬'));
  assert.equal(c[1].text, ys(MONTH_SUM) + '円');
  assert.deepEqual(c[1].tip.split('\n'), ['今の中心 121,200,000 円（予測と予算の画面と同じ）', '最新の予測 2026/10/01 1.1億円']);
  assert.equal(c[0].tip, '前回 2026/09/01 1.0億円\n今回 2026/10/01 1.1億円', '本番の回が無ければ印なし');
  noCodes(h, '見直しの流れ');
  // 表で見る: 流れの金額は各回の中心（p50Shown）、カーソルで印
  const t = revCard(plans, 'table');
  const ra = revRow(t, 'A製薬');
  assert.match(ra, /<td class="wrap" data-tip="2026\/09\/01 1\.1億円（旧来の計算）\n2026\/10\/01 1\.2億円（月の合計）\n旧来の計算と月の合計の回は、計算のしかたが違います">1\.1億 → 1\.2億<\/td>/);
  assert.match(revRow(t, 'B製薬'), />1\.2億 → 1\.2億<\/td>/);
  noCodes(t, '見直しの流れ（表）');
  // 中心の値が無い回は除く（p50Shown も p50 も無い）
  const only = revCard([{ planId: 'P9', clientName: 'Z製薬', alignedLive: false, p50: null, revisions: [{ at: at('09-01'), p50: null, p50Shown: 100e6, live: true }, { at: at('10-01'), p50: null }] }], 'chart');
  assert.deepEqual(cellsOf(revRow(only, 'Z製薬')).map((x) => x.text), ['-', '1.0億円', '1 回']);
}

console.log('app-v11-ui-live: ok');
