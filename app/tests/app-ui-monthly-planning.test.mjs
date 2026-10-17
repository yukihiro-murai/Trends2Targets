#!/usr/bin/env node
/* 表示専用の月次予測: 月中央値・分位点・予算を保存する経路と分ける。合成データの UI VM 検証。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const uiHtml = fs.readFileSync(new URL('../src/UI.html', import.meta.url), 'utf8');
const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
  .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, {get:()=>""}); var CHAR_SVG = new Proxy({}, {get:()=>""});')
  .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'Test', version: 'test' }, user: { email: 'test@example.invalid', isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
const el = { innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} };
const calls = [];
const runner = new Proxy({}, { get: (_, k) => k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => runner : (...a) => calls.push([k, a]) });
const ui = vm.createContext({
  document: { getElementById: () => el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  setTimeout: () => 0, clearTimeout() {}, confirm: () => false,
  window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
  google: { script: { run: runner } }
});
vm.runInContext(js, ui);
const run = (code, vars = {}) => { Object.assign(ui, vars); return vm.runInContext(code, ui); };
const clone = x => structuredClone(x);
const plain = x => JSON.parse(JSON.stringify(x));
const months = Array.from({ length: 12 }, (_, i) => `${2026 + Math.floor((i + 3) / 12)}/${String((i + 3) % 12 + 1).padStart(2, '0')}`);
const annual = { p10: 1000, p50: 780000.4, p90: 1800000, adopted: 345600, uplift: 2400, final: 348000 };
const monthly = months.map((month, i) => ({ row: 29 + i, month, p10: 0, p50: 0, p90: i === 0 ? 0 : 50000 + i, adopted: 28800, uplift: 200, final: 29000 }));
const v = { plan: { planId: 'P1', fy: 2026, measure: false }, can: { plan: true }, boot: { output: { sections: [{ annual, monthly }] } } };
const planning = { version: 'HISTORY_MONTHLY_POINT_V1', applied: true, method: 'test-history', annualTarget: 780000,
  months: months.map((ym, i) => ({ ym, point: (i + 1) * 10000, share: (i + 1) / 78, mean: (i + 1) * 12000 })) };
const d = { plan: v.plan, latest: { annual_p10: annual.p10, annual_p50: annual.p50, annual_p90: annual.p90 }, planning };
run("S.fc.planId='P1'; S.fc.view=__v; S.fc.budget={29:{adopted:33333,uplift:-11}}; S.cv.fcMonthly='table'; S.cv.fcBudgetM='table'; S.job=null;", { __v: v });
run('var __chartLine=chartLine; chartLine=function(series,opts){ __chart={series:series,opts:opts}; return __chartLine(series,opts); };');
const render = (data, mode = 'result', view = v) => run('fcMonthlyTab(__d,__v,__mode)', { __d: data, __v: view, __mode: mode });
const chart = () => plain(run('__chart'));
const table = h => /<table class="tbl scroll[^>]*>[\s\S]*?<\/table>/.exec(h)?.[0];
const rows = t => [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => c[1]));

// 元の月中央値が全て 0 でも、主列・主線は 12 個の月次予測。月の順番ではなく月キーで結ぶ。
const original = JSON.stringify({ d, v, budget: run('S.fc.budget') });
const callsBefore = calls.length;
const h = render(d);
const c = chart();
assert.deepEqual(rows(table(h))[0], ['月', '下振れ', '月次予測', '上振れ']);
assert.deepEqual(rows(table(h)).slice(1, 13), monthly.map((m, i) => [m.month, '0', ((i + 1) * 10000).toLocaleString('en-US'), m.p90.toLocaleString('en-US')]));
assert.deepEqual(rows(table(h)).at(-1), ['年度合計', '1,000', '780,000', '1,800,000']);
assert.equal(rows(table(h)).slice(1, 13).reduce((s, r) => s + Number(r[2].replaceAll(',', '')), 0), planning.annualTarget);
assert.deepEqual(c.series.map(s => [s.label, s.values]), [['月次予測', planning.months.map(m => m.point)]]);
assert.deepEqual(c.opts.band, monthly.map(m => ({ lo: m.p10, hi: m.p90 })), '帯は点推定の外れ方に関係なく元の P10/P90 のまま');
assert.equal(c.series[0].values[0], 10000, 'P10/P90 が共に 0 の月も点を帯に丸め込まない');
assert.equal(c.opts.h, 280, 'グラフの固定高さを維持');
assert.equal((table(h).match(/<col(?: |>|\/)/g) || []).length, 4, '主表の列数を維持');
assert.equal((h.match(/<div class="card">/g) || []).length, 1, '表示用カードを追加しない');
assert.match(h, /年間の中心額を過去の月別傾向で配分した見込額。月中央値とは異なる/);
assert.match(h, /月次予測の合計は年間の中心額/);
const detail = /<details class="mt12">([\s\S]*?)<\/details>/.exec(h)?.[1];
assert.ok(detail, '従来中央値は閉じた詳細に残す');
assert.match(detail, /^<summary class="note">中央値を見る<\/summary>/);
assert.deepEqual(rows(table(detail)).slice(1, 13), monthly.map(m => [m.month, '0']));
assert.deepEqual(rows(table(detail)).at(-1), ['年度中央値', '780,000']);
assert.equal(JSON.stringify({ d, v, budget: run('S.fc.budget') }), original, '元の分位点・予算・APIデータを変更しない');
assert.equal(calls.length, callsBefore, '描画から保存・学習・外部操作を開始しない');
const reversed = clone(d); reversed.planning.months.reverse();
assert.equal(render(reversed), h, '計画配列の順番は表示を変えない');
const hyphenView = clone(v); hyphenView.boot.output.sections[0].monthly.forEach(m => { m.month = m.month.replace('/', '-'); });
assert.deepEqual(rows(table(render(d, 'result', hyphenView))).slice(1, 13).map(r => r[2]), rows(table(h)).slice(1, 13).map(r => r[2]), 'OUTPUT のハイフン月表記もキーで対応');

// 旧 JSON / 不正な新 JSON は従来 HTML へ戻す。年度中心額は最新と保存データの両経路を扱う。
const legacy = clone(d); delete legacy.planning;
const oldHtml = render(legacy);
assert.doesNotMatch(oldHtml, /月次予測|中央値を見る/);
assert.deepEqual(chart().series[0].values, Array(12).fill(0));
const invalid = [
  ['旧バージョン', p => { p.version = 'HISTORY_MONTHLY_POINT_V0'; }],
  ['未適用', p => { p.applied = false; }],
  ['方式無し', p => { p.method = ''; }],
  ['欠月', p => { p.months.pop(); }],
  ['余分な月', p => { p.months.push({ ym: '2027/04', point: 0 }); }],
  ['重複月', p => { p.months[1].ym = p.months[0].ym; }],
  ['別年度月', p => { p.months[1].ym = '2025/05'; }],
  ['月不正', p => { p.months[1].ym = '2026/13'; }],
  ['空行', p => { p.months[1] = null; }],
  ['整数未満', p => { p.months[0].point += .1; }],
  ['文字金額', p => { p.months[0].point = '10000'; }],
  ['負の金額', p => { p.months[0].point = -10000; }],
  ['NaN', p => { p.months[0].point = NaN; }],
  ['Infinity', p => { p.months[0].point = Infinity; }],
  ['不正合計', p => { p.months[0].point++; }],
  ['別年度中心額', p => { p.annualTarget++; p.months[0].point++; }],
  ['端数年度金額', p => { p.annualTarget += .4; }],
  ['安全整数外', p => { p.annualTarget = 9007199254740992; }]
];
for (const [label, change] of invalid) {
  const x = clone(d); change(x.planning);
  assert.equal(render(x), oldHtml, `${label}は旧表示`);
}
for (const value of [null, '', '{}', JSON.stringify(planning), [], {}]) {
  assert.equal(render({ ...d, planning: value }), oldHtml, '型の違う旧JSONは旧表示');
}
const stored = clone(d); delete stored.latest; stored.stored = { annual: clone(annual) };
assert.equal(render(stored), h, 'latest が無くても保存された年度中央値に照合');
const badOutput = clone(v); badOutput.boot.output.sections[0].monthly[1].month = months[0];
const badOld = clone(legacy);
assert.equal(render(d, 'result', badOutput), render(badOld, 'result', badOutput), 'OUTPUT側の重複月も旧表示');
const shadowed = clone(d); shadowed.shadow = { planId: 'P1', live: true, annual: { p10: 1000, p50: 1200000, p90: 1800000 } };
const shadowOld = clone(shadowed); delete shadowOld.planning;
assert.equal(render(shadowed), render(shadowOld), '本番年度中心額と不一致なら計画値だけを切り替えない');

// 予算策定・測る専用の予算案内は同一。編集欄の採用予測/上乗せも従来の値を保つ。
assert.equal(render(d, 'budget'), render(legacy, 'budget'), '予算策定HTMLは全て不変');
assert.deepEqual(chart().series.map(s => [s.label, s.values]), [['中心', Array(12).fill(0)], ['最終予算', monthly.map(m => m.final)]]);
assert.match(render(d, 'budget'), /value="33,333"[\s\S]*value="-11"/);
const measureView = clone(v); measureView.plan.measure = true;
run('S.fc.view=__v', { __v: measureView });
const measureHtml = run('fcBudgetTab(__d,__v)', { __d: d, __v: measureView });
assert.equal(measureHtml, run('fcBudgetTab(__d,__v)', { __d: legacy, __v: measureView }));
assert.match(measureHtml, /測る専用の計画なので、予算は立てません/);
assert.match(render(d, 'result', measureView), /月次予測/);

// 実際のSVG経路でも、帯の外にある月次予測を欠落させず描画できる。
run("S.fc.view=__v; S.cv.fcMonthly='chart';", { __v: v });
const svgHtml = render(d);
assert.match(svgHtml, /<svg[\s\S]*月次予測/);
assert.doesNotMatch(svgHtml, /NaN|Infinity/);
assert.deepEqual(chart().opts.band, monthly.map(m => ({ lo: m.p10, hi: m.p90 })));
assert.equal(calls.length, callsBefore);
console.log('PASS app-ui-monthly-planning: point/month join, annual total, quantiles, legacy fallback, budget isolation');
