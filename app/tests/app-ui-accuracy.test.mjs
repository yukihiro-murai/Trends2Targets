#!/usr/bin/env node
/*
 * app-ui-accuracy.test.mjs — 外れの測り方と補正の見せ方の画面の言葉（2026-10-13 村井さん承認。UI.html の script を vm で読む）。
 *   2. 偏りの縮め（AI の学び）: 偏りは今の補正を外した予測で測ったと言い、倍率は今の補正の代わりに掛ける値（重ねて掛けない）と言う。
 *      寄せると の外れ幅は、倍率を決めたのと同じ月で測るので良く見えやすいと断る
 * モックの上の確かめで、本物の Apps Script・ブラウザの上では動かしていない。
 *
 *   node app/tests/app-ui-accuracy.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { uiHtml, OWNER } from './gas-mock.mjs';

/** 画面（UI.html の script）を vm で読み込む（app-ui-texts と同じ読み方。よみの絵は、どの姿か分かる印にする） */
function loadUi() {
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: (t, k) => "<i data-pose=\\"" + String(k) + "\\"></i>" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
  const el = () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
  const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, confirm: () => false,
    window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  return ui;
}
const ui = loadUi();
const run = (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };
/** HTML の data-tip の中身（&quot; などを戻す） */
const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const tips = (html) => Array.from(String(html).matchAll(/data-tip="([^"]*)"/g)).map((m) => unesc(m[1]));
const text = (html) => unesc(String(html).replace(/<[^>]*>/g, ' '));

// ==== 2. 偏りの縮め: 補正を外した予測の偏り・今の補正の代わりの倍率・寄せると は良く見えやすい ====
{
  const sh = { mu: 0.17, tau: 0.05, tau2: 0.0025, pooled: true, plans: [
    { planId: 'A', clientName: '甲製薬', fy: '2026', n: 3, bias: 0.251, biasNow: 0.001, corrected: 3, se: 0.007, shrunk: 0.2508, factorShadow: 0.8, factorNow: 0.8, mapeNow: 0.0083, mapeShadow: 0.0082 },
    { planId: 'B', clientName: '乙製薬', fy: '2026', n: 3, bias: 0.1, biasNow: 0.1, corrected: 0, se: 0.006, shrunk: 0.1002, factorShadow: 0.909, factorNow: null, mapeNow: 0.1, mapeShadow: 0.0002 }] };
  const html = run(`S.cv.lrShrink = 'chart'; lrShrinkCard(__sh)`, { __sh: sh }) + run(`S.cv.lrShrink = 'table'; lrShrinkCard(__sh)`, { __sh: sh });   // グラフと表で見る
  const all = tips(html).join('\n');
  assert.match(all, /今の補正を外した予測で測ります/, 'カードの説明: 偏りは補正を外した予測で');
  assert.match(all, /甲製薬\n補正を外した予測の偏り \+25\.1% → 全体に寄せた偏り \+25\.1%\n3 か月は、そのとき掛けていた補正を外して測りました（補正を掛けた今の予測の偏りは \+0\.1%）/);
  assert.match(all, /補正を外した予測から学んだ倍率 0\.800（今の補正 0\.800 の代わりに掛ける値。今の補正に重ねて掛けるものではありません）/, '今の補正と並べても「補正を外せ」と読めない');
  assert.match(all, /外れ幅 今 0\.8% → 寄せると 0\.8%（倍率を決めたのと同じ月で測るので、良く見えやすい値です）/);
  assert.match(all, /倍率を決めたのと同じ月で測るので、実際より良く見えやすい値です/, '寄せる の見出しの説明');
  assert.match(all, /補正を外した予測から学んだ倍率 0\.909（今の補正の代わりに掛ける値）/, '今の補正が分からない計画');
  assert.doesNotMatch(all, /乙製薬\n[^\n]*\n\d+ か月は、そのとき掛けていた補正/, '割り戻していない計画は言わない');
  assert.doesNotMatch(html, /undefined|NaN/);
}

console.log('app-ui-accuracy: all tests passed');
