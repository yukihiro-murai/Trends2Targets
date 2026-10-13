#!/usr/bin/env node
/**
 * app-persistence.test.mjs — 月の外れの続きやすさ（2026-10-13 村井さん承認。レビューの提案 2）。
 *   着地の推定は、今年の水準を除いた後の月の外れを独立とみなして幅を出す。続きやすいなら幅が狭すぎるので、AI の学びで続きやすさを測り続ける
 *   （読むだけ。幅の計算は変えない）。計画 × 年度ごとに log(実績 ÷ 中心) から年度の平均を引き、隣り合う月どうしの相関をまとめる。
 * モックの上の確かめで、本物の Apps Script の上では動かしていない。
 *
 *   node app/tests/app-persistence.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { OWNER, makeEnv, setUpEnv, uiHtml } from './gas-mock.mjs';

const env = makeEnv();
const run = (code, extra) => env.run(code, extra);
/** 決まった種の乱数 */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { const u = Math.max(1e-12, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const ymOf = (fy, i) => { const m = 4 + i; return (m > 12 ? fy + 1 : fy) + '/' + String(m > 12 ? m - 12 : m).padStart(2, '0'); };
/** 計画 n 個 × 年度 2 つ × 12 か月。月の外れは AR(1)（phi）。今年の水準（年度ごとの平均）も足す */
function accs(phi, n, seed) {
  const r = rng(seed), out = {};
  for (let p = 0; p < n; p++) {
    const months = [];
    [2024, 2025].forEach((fy) => {
      const level = 0.2 * gauss(r);
      let e = gauss(r) * 0.1;
      for (let i = 0; i < 12; i++) {
        e = phi * e + Math.sqrt(1 - phi * phi) * gauss(r) * 0.1;
        months.push({ month: ymOf(fy, i), p50: 100, actual: 100 * Math.exp(level + e) });
      }
    });
    out['PL-' + p] = { months };
  }
  return out;
}

// ==== 1. 続かない外れ（独立）: 相関はほぼ 0 で、続きやすいとは言わない ====
{
  const ps = run('appInsightPersistence_(__a)', { __a: accs(0, 6, 1) });
  assert.ok(Math.abs(ps.rho) < 0.2, '独立なら 0 に近い: ' + ps.rho);
  assert.equal(ps.sticky, false);
  assert.equal(ps.pairs, 6 * 2 * 11, '隣り合う月の組（計画 × 年度 × 11）');
  assert.equal(ps.plans, 6);
}

// ==== 2. 続く外れ（AR(1) 0.7）: 今年の水準を除いても相関が残り、続きやすいと言う ====
{
  const ps = run('appInsightPersistence_(__a)', { __a: accs(0.7, 6, 2) });
  assert.ok(ps.rho > 0.4 && ps.ci80[0] > 0.2, '続く外れ: ' + ps.rho + ' ' + ps.ci80);
  assert.equal(ps.sticky, true);
}

// ==== 3. 今年の水準だけのずれ（月の外れ 0）は続きやすさに入れない・組が少なければ測らない・締まった後の月と 0 円の月は除く ====
{
  const lvl = { 'PL-A': { months: Array.from({ length: 12 }, (_, i) => ({ month: ymOf(2025, i), p50: 100, actual: 130 + (i % 2 ? 1 : -1) })) } };
  const ps = run('appInsightPersistence_(__a)', { __a: lvl });
  assert.ok(ps.rho < 0, '水準を除くので、年度ごと 3 割高いだけでは続きやすくならない: ' + ps.rho);
  const few = run('appInsightPersistence_(__a)', { __a: { 'PL-B': { months: [0, 1, 2, 3].map((i) => ({ month: ymOf(2025, i), p50: 100, actual: 100 + i })) } } });
  assert.deepEqual([few.rho, few.pairs, few.sticky], [null, 3, false], '8 組より少なければ測らない');
  const gaps = { 'PL-C': { months: [
    { month: '2025/04', p50: 100, actual: 110 }, { month: '2025/05', p50: 100, actual: 0 }, { month: '2025/06', p50: 100, actual: 90, leak: true },
    { month: '2025/07', p50: 100, actual: 95 }, { month: '2025/08', p50: 100, actual: 105 } ] } };
  assert.equal(run('appInsightPersistence_(__a)', { __a: gaps }).pairs, 1, '0 円の月・締まった後の月を除き、隣り合う月（7・8 月）だけ');
}

// ==== 4. AI の学びの応答に入る・画面の札 ====
{
  const full = setUpEnv();   // 初期設定の済んだデータ本体
  const ai = full.call('apiAiLearning()');
  assert.ok(ai.persistence && 'rho' in ai.persistence && 'pairs' in ai.persistence, 'AI の学びに続きやすさ');
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [] }, setUp: true, allowed: true }));
  const el = () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
  const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  const chip = (ps) => { ui.__p = ps; return vm.runInContext('lrPersistChip(__p)', ui); };
  assert.match(chip({ rho: null, pairs: 3 }), /続きやすさ まだ/);
  assert.match(chip({ rho: 0.01, ci80: [-0.28, 0.29], pairs: 22, plans: 1, sticky: false }), /^<span class="chip" [^>]*>続きやすさ \+0\.01<\/span>$/);
  assert.match(chip({ rho: 0.6, ci80: [0.4, 0.75], pairs: 40, plans: 3, sticky: true }), /class="chip warn"[\s\S]*狭すぎるかもしれません[\s\S]*続きやすさ \+0\.60/);
  ui.__tl = [{ ym: '2025/04', n: 1, mape: 0.1, rolling3: 0.1, coverage: 0.8, coverageN: 5, coverageCi80: [0.5, 0.9] }];
  ui.__ps = { rho: 0.01, ci80: [-0.28, 0.29], pairs: 22, plans: 1, sticky: false };
  assert.match(vm.runInContext('lrTimeCard(__tl, __ps)', ui), /外れ幅と幅の当たり[\s\S]*続きやすさ \+0\.01/, '外れ幅と幅の当たりのカードの右に出す');
}

console.log('app-persistence: all tests passed');
