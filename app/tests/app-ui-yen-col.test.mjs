#!/usr/bin/env node
/*
 * app-ui-yen-col.test.mjs — 表の金額の列の幅（提案 30。2026-10-13）。
 *   金額の列は格子の 1 マス（YEN_COL = --col = 160px）: 予算の表の採用予測・上乗せ、分析の着地の推定と予算・見直しの流れの最新の中心。
 *   年度合計（2,790,000,000 円）が 1 マスに入る。1280px の画面（カードの中 922px）で表ごと横に送らない。
 *   スマホは列の幅を中身に合わせる決まり（table-layout:auto・分析の表は col を auto・予算の表は横に送る）のまま
 * 名前と数字はテスト用の架空のもの。画面の見た目の最終の確かめは、写真と寸法（ローカルの点検の仕組み）で行う。
 *
 *   node app/tests/app-ui-yen-col.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setUpEnv, uiHtml, OWNER } from './gas-mock.mjs';

const css = uiHtml.slice(uiHtml.indexOf('<style>'), uiHtml.indexOf('</style>'));
const root = /:root\{([\s\S]*?)\n\}/.exec(css)[1];
const vars = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
function loadUi() {
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
  const ui = vm.createContext({ document: { getElementById: () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} }), querySelector: () => null, addEventListener() {} },
    setTimeout: () => 0, clearTimeout() {}, confirm: () => false, window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  return (code, v) => { Object.assign(ui, v || {}); return vm.runInContext(code, ui); };
}
const run = loadUi();
/** 表の列の幅（幅の無い列は 0）と見出し */
const cols = (html, cls) => { const m = new RegExp('<table class="' + cls + '"><colgroup>([\\s\\S]*?)</colgroup><thead><tr>([\\s\\S]*?)</tr></thead>').exec(html); assert.ok(m, cls + ' の表');
  return { w: [...m[1].matchAll(/<col(?: class="[^"]*")?(?: style="width:(\d+)px")?>/g)].map((x) => (x[1] ? Number(x[1]) : 0)), th: [...m[2].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => x[1].replace(/<[^>]*>/g, '')) }; };
const CARD_1280 = 922;   // 1280px の画面のカードの中の幅（1280 − 左のメニュー 220 − 余白 40×2 − カードの余白 28×2 − 枠 2）

{
  assert.equal(run('YEN_COL'), 160);
  assert.equal(vars.col, run('YEN_COL') + 'px', '格子の 1 マス（--col）と同じ');
  // 年度合計（10 けた + 円）が 1 マスに入る（14px の数字 1 字 8.5px まで・区切り 4px・空白と「円」・左右の余白 12px）
  assert.equal(run('yenU(2790000000)'), '2,790,000,000 円');
  assert.ok(10 * 8.5 + 3 * 4 + 4 + 14 + 24 <= run('YEN_COL'), '2,790,000,000 円 が 1 マスに入る');

  // 分析: 着地の推定と予算（下振れ・着地の推定・上振れ・予算は金額。予算比は割合で 112 のまま）
  const p = (n, budget, landing) => ({ planId: 'P' + n, clientName: 'メーカー' + n, fy: '2026', budget, budgetUsed: budget, landing, landingP10: landing * 0.9, landingP90: landing * 1.1, ratio: landing / budget });
  run(`S.an.view = 'table'; S.cv = {}`);
  const bullet = cols(run('anBulletCard(__p)', { __p: [p(1, 2790000000, 2600000000), p(2, 279000000, 300000000)] }), 'tbl anw');
  assert.deepEqual(bullet.th, ['メーカー', '下振れ', '着地の推定', '上振れ', '予算', '予算比']);
  assert.deepEqual(bullet.w, [0, 160, 160, 160, 160, 112], '金額の列は 1 マス・割合の列はそのまま');
  assert.ok(CARD_1280 - bullet.w.reduce((a, b) => a + b, 0) >= 160, '1280px の画面で、名前の列に 1 マス以上残る（横に送らない）');

  // 分析: 予測の見直しの流れ（グラフの形）。最新の中心は金額・流れ（小さなグラフ）152・前回から・回数は 112 のまま
  const rv = (n) => ({ planId: 'P' + n, clientName: 'メーカー' + n, fy: '2026', p50: 279000000, revisions: [{ at: '2026-05-01', p50: 270000000 }, { at: '2026-06-01', p50: 279000000 }] });
  run(`S.cv['an.rev'] = 'chart'`);
  const rev = cols(run('anRevCard(__p)', { __p: [rv(1), rv(2)] }), 'tbl anw');
  assert.deepEqual(rev.th, ['メーカー', '流れ', '前回から', '最新の中心', '回数']);
  assert.deepEqual(rev.w, [0, 152, 112, 160, 112]);

  // スマホの決まりはそのまま（列の幅は中身に合わせ、入らなければ表ごと横に送る）
  const auto = css.indexOf('table.tbl{table-layout:auto}');
  assert.ok(auto > 0 && css.lastIndexOf('@media', auto) === css.lastIndexOf('@media (max-width:760px){', auto), 'スマホでは列の幅を中身に合わせる');
  assert.match(css, /\.tbl\.anw\{width:100%\}\.tbl\.anw col\{width:auto!important\}/, '分析の表はスマホで col の幅を使わない');
  assert.match(css, /\.tbl\.scroll\{width:max\(100%,720px\)\}/, '予算の表はスマホで横に送る');
}
{
  // 予算の表（予測と予算のタブ・表で見る）: 採用予測・上乗せは 1 マス。月 96・下振れ〜上振れと最終予算は残りを分ける
  const D = (y, m, d = 1) => new Date(y, m - 1, d);
  const env = setUpEnv();
  const fy = env.run('appFy_(new Date())');
  const output = [['FY' + fy + ' 売上予測（テスト製薬）']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 250000000, 279000000, 310000000]);
  output.push([], ['月', 'P10', 'P50', 'P90', '', '', '', '採用予測', '上乗せ']);
  for (let i = 0; i < 12; i++) output.push([D(fy, 4 + i, 1), 20000000, 23250000, 26000000, '', '', '', 23250000, '']);
  const planId = env.seedPlan(env.makeBook('A', { CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', 'テスト製薬'], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '担当A']] }, OUTPUT: { values: output } }));
  const d = env.call('apiForecastLatest(__in)', { __in: { planId } });
  const v = env.call('apiPlanView(__in)', { __in: { planId } });
  run(`S.fc.plans = __l; S.fc.planId = __id; S.fc.view = __v; S.fc.data = __d; S.fc.budget = {}; S.fc.confirm = null; S.fc.tab = 'forecast'; S.cv.fcMonthly = 'table'`, { __l: env.call('apiListPlans()').plans, __id: planId, __v: v, __d: d });
  const html = run('fcForecastTab(S.fc.data, S.fc.view)');
  const t = cols(html, 'tbl scroll edit');
  assert.deepEqual(t.th, ['月', '下振れ', '中心', '上振れ', '採用予測', '上乗せ', '最終予算']);
  assert.deepEqual(t.w, [96, 0, 0, 0, 160, 160, 0], '採用予測・上乗せは 1 マス');
  // 1280px の画面で、残りを分けた 4 つの金額の列にも年度合計（279,000,000）が入る幅が残る（横に送らない）
  const rest = (CARD_1280 - t.w.reduce((a, b) => a + b, 0)) / 4;
  assert.ok(rest >= 9 * 8.5 + 2 * 4 + 16, '残りの列に 279,000,000 が入る: ' + rest);
  assert.match(html, /<tr class="total"><td>年度合計<\/td>/);
  assert.match(html, /279,000,000/);
}

console.log('app-ui-yen-col: ok');
