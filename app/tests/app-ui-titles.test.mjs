#!/usr/bin/env node
/*
 * app-ui-titles.test.mjs — 画面の見出しをメニュー名にそろえる・角を本格調に・予測準備の入力の上下位置・分析/学びの可視化（2026-10-20）。
 *   1. 予測一覧・予算一覧のカード見出しはメニューと同じ（「予測」「予算と実績」は出さない）
 *   2. ホームの学び・分析カードもメニュー名
 *   3. 角は 8・6・4（丸い札や 18px のカードにしない）
 *   4. 予測準備の入力セルはマスの上下中央
 *   5. 分析に合計の数字とメーカー横断の熱マップ、学びの先頭に数字
 *
 *   node app/tests/app-ui-titles.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { uiHtml, OWNER } from './gas-mock.mjs';

const css = uiHtml.slice(uiHtml.indexOf('<style>'), uiHtml.indexOf('</style>'));
const root = /:root\{([\s\S]*?)\n\}/.exec(css)[1];
const vars = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
assert.equal(vars.radius, '8px', 'カードの角');
assert.equal(vars['radius-s'], '6px', 'ボタンの角');
assert.equal(vars.pill, '4px', '札は角丸の短冊（丸くしない）');
assert.match(css, /\.tbl\.edit td\{[^}]*padding:16px 8px/, '入力セルの上下 16px で見出しと下線のあいだの中央');
assert.match(css, /\.tbl\.edit td\{[^}]*height:72px/, '入力行は 72px で見出しと下線のあいだを確保');
assert.match(css, /\.tbl\.edit \.inp\.cell\{[^}]*height:40px/, '欄は 40px');
assert.match(css, /select\.inp\{[^}]*display:flex;align-items:center/, 'プルダウンの文字は欄の上下中央');
assert.match(css, /\.mk-sum\{[^}]*grid-template-columns:repeat\(4,var\(--col\)\)/, '予算一覧の状態札は同じ幅');
assert.match(css, /\.sky\{[^}]*height:152px/, '予実の分布タイルは同じ高さ');
assert.match(css, /\.sky \.nm\{display:none\}/, '予実の分布にラベル文字を出さない');
assert.match(css, /\.cvt\{[^}]*height:360px/, 'グラフと表は同じ高さの枠');
assert.match(css, /\.hm-pair\{[^}]*grid-template-columns:1fr 1fr/, 'ホームの学びと分析は同じ高さ');
assert.match(css, /\.bud-src\{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/, '予算案の予測カードは 4 列');
assert.match(css, /\.lr-board\{[^}]*grid-template-columns:1fr/, '学びの持ち帰ること は 1 カラム');
assert.doesNotMatch(css, /--radius:18px|--radius-s:12px|--pill:999px/);
assert.doesNotMatch(css, /\.btn:active[^{]*\{[^}]*scale\(/, 'ボタンの縮小はしない');

const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
  .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: (t, k) => "<i data-pose=\\"" + String(k) + "\\"></i>" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
  .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
const ui = vm.createContext({
  document: { getElementById: () => ({ innerHTML: '', classList: { add() {}, remove() {} } }), querySelector: () => null, addEventListener() {} },
  setTimeout: () => 0, clearTimeout() {},
  window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
  google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } }
});
vm.runInContext(js, ui);
const run = (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };

const plans = [{ planId: 'P1', clientName: 'テスト製薬', fy: '2026', p10: 80, p50: 100, p90: 120, landing: 110, budget: 100, ratio: 1.1, accuracy: { n: 4, mape: 0.12, bias: 0.05 }, pAbove: 0.6, landingP10: 90, landingP90: 130, landingSd: 10 },
  { planId: 'P2', clientName: '別の製薬', fy: '2026', p10: 40, p50: 50, p90: 60, landing: 45, budget: 50, ratio: 0.9, accuracy: { n: 5, mape: 0.08, bias: -0.02 }, pAbove: 0.3, landingP10: 40, landingP90: 55, landingSd: 5 }];
const fcl = run(`S.pf = __p; S.mkFy = '2026'; viewMakers()`, { __p: plans });
assert.match(fcl, /<h1>予測一覧<\/h1>[\s\S]*<h2>予測一覧<\/h2>/);
assert.doesNotMatch(fcl, /<h2>予測<\/h2>/);
const bud = run(`S.pf = __p; S.mkFy = '2026'; viewBudgets()`, { __p: plans });
assert.match(bud, /<h1>予算一覧<\/h1>[\s\S]*<h2>予算一覧<\/h2>/);
assert.doesNotMatch(bud, /予算と実績/);

const an = run(`S.view = 'analysis'; S.cv = {}; S.an.view = 'chart'; S.an.data = __d; S.an.fy = '2026'; viewAnalysis()`, {
  __d: { fy: '2026', fys: ['2026'], totals: { budget: 150, landing: 155, budgetPlans: 2, ratioLanding: 155 / 150 }, market: [], plans: plans, insights: { total: { plans: 2, budget: 150, landing: 155, gap: 5, pIndependent: 0.6, pTogether: 0.55, settled: false }, gaps: [], spread: [] } }
});
assert.match(an, /<h1>分析<\/h1>/);
assert.match(an, /<h2>メーカー横断の指標/);
assert.match(an, /chartHeat|fill-opacity|メーカー横断/);
assert.ok(!/undefined|NaN/.test(an), '分析に undefined・NaN を出さない');

const heat = run(`chartHeat([{ label: '甲', cells: [{ v: 0.8, text: '110%', tone: 'warm' }, { v: 0.2, text: '8%', tone: 'cool' }] }], { cols: ['予算比', '外れ幅'], w: 720 })`);
assert.match(heat, /<svg class="chart"/);
assert.match(heat, /予算比/);
assert.match(heat, /fill-opacity/);
assert.match(run('chartHeat([])'), /chempty/);

const scatter = run(`chartScatter([{ x: 0.2, y: 0.3, label: '甲' }, { x: 0.8, y: 0.1, label: '乙' }], { refX: 0.5, refY: 0.2, quad: true, quadLabels: ['重点管理', '柱（守る）', '見張る', '安定'], w: 720 })`);
assert.match(scatter, /fill-opacity="0\.08"/);
assert.match(scatter, /重点管理/);

const lr = run(`S.view = 'learning'; S.lr.people = __p; S.lr.ai = { pending: [{}] }; viewLearning()`, {
  __p: { detail: 'full', summary: { scoredMonths: 8, months: 4, misses: 2 }, openActions: [{}], lessons: [{ miss: true, clientName: 'テスト製薬', ym: '2026/06', absErr: 0.2, direction: 'over', pred: 100, actual: 80 }], scoreboard: [{ type: 'opinion', label: '見解', n: 10, hit: 7, postMean: 0.7, ci80: [0.5, 0.8], base: 0.5 }] }
});
assert.match(lr, /<h1>学び<\/h1>/);
assert.match(lr, /実績と比べた月[\s\S]*大きく外れた月[\s\S]*残っている対応[\s\S]*承認待ち/);
assert.match(lr, /<h2>持ち帰ること/);
assert.ok(!/undefined|NaN/.test(lr), '学びに undefined・NaN を出さない');

const inHtml = run(`S.view = 'prep'; S.fc.planId = 'P1'; S.fc.view = __v; S.fc.inputDirty = {}; fcInputTab({}, __v)`, {
  __v: { can: { plan: true }, boot: { setup: { people: ['村井'] }, products: ['薬A'], months: ['2026-04'], stepOptions: ['+10%'], input: { product: [{}] } }, plan: {}, inputLog: { rows: {} } }
});
assert.match(inHtml, /class="in-steps"/);
assert.match(inHtml, /class="tbl scroll fc-in edit"/);
assert.match(inHtml, /class="inp cell"/);
assert.deepEqual(JSON.parse(run(`JSON.stringify(FC_SECS.map(function(s){ return s[1]; }))`)), ['予測結果', '根拠', '入力', '振り返り', '予算案', '確定版', '手法ごとの予測']);
assert.doesNotMatch(run(`SKY8.map(function(s){ return s.name; }).join()`), /猛暑|快晴|曇り|霧|天変地異/);
const skyHtml = run('homeSkyCard(__p)', { __p: [] });
assert.doesNotMatch(skyHtml, /<span class="nm">|大幅超え|>超え</);
assert.equal((skyHtml.match(/class="sky none"/g) || []).length, 8);

console.log('app-ui-titles: ok');
