#!/usr/bin/env node
/* 表示専用の月次予測: 月中央値・分位点・予算を保存する経路と分ける。合成データの UI VM 検証。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

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
const digest = x => createHash('sha256').update(x).digest('hex');
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
assert.equal(digest(h), '6dc1e9fa0751e7d5ed5c6e7d379297815a1a72334db54883136e067816dc2399', 'V2追加前に固定した合成V1のHTMLを完全保持');
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

// V2は月次予測の年合計を独立に持つ。元の年間P50は同じ回であることの照合と詳細だけに使う。
const v2 = clone(d);
v2.planning.version = 'HISTORY_MONTHLY_POINT_V2';
v2.planning.method = 'test-independent-monthly';
v2.planning.annualRawP50 = annual.p50;
v2.planning.annualTarget = 390000;
v2.planning.months.forEach(m => { m.point /= 2; });
const v2Before = JSON.stringify({ d: v2, v, budget: run('S.fc.budget') });
const h2 = render(v2);
const c2 = chart();
assert.match(h2, /class="kpi main" data-tip="月次予測の合計\n390,000 円"><div class="k">月次予測の合計<\/div>/);
assert.deepEqual(rows(table(h2))[0], ['月', '下振れ', '月次予測', '上振れ']);
assert.deepEqual(rows(table(h2)).at(-1), ['年度合計', '1,000', '390,000', '1,800,000']);
assert.equal(rows(table(h2)).slice(1, 13).reduce((s, r) => s + Number(r[2].replaceAll(',', '')), 0), v2.planning.annualTarget);
assert.deepEqual(c2.series.map(s => [s.label, s.values]), [['月次予測', v2.planning.months.map(m => m.point)]]);
assert.deepEqual(c2.opts.band, c.opts.band, 'V2でも元の予測帯を変更しない');
assert.equal(c2.opts.bandLabel, '従来モデルの幅', 'V2の帯を新しい月次予測の確率帯と取り違えない');
assert.equal(c.opts.bandLabel, '下振れ〜上振れ', 'V1の帯表記は維持');
assert.match(h2, /帯 = 従来モデルの80%の幅/);
assert.match(h2, /data-tip="従来モデル：[^\"]+"><div class="k">下振れ<\/div>/);
assert.match(h2, /data-tip="従来モデル：[^\"]+"><div class="k">上振れ<\/div>/);
assert.equal(c2.opts.h, 280);
assert.equal((table(h2).match(/<col(?: |>|\/)/g) || []).length, 4);
assert.equal((h2.match(/<div class="card">/g) || []).length, 1);
assert.match(h2, /過去の実績に基づく月別の見込額。月中央値とは異なる/);
assert.doesNotMatch(h2, /年間の中心額を過去の月別傾向で配分|月次予測の合計は年間の中心額/);
const v2Detail = /<details class="mt12">([\s\S]*?)<\/details>/.exec(h2)[1];
assert.deepEqual(rows(table(v2Detail)).at(-1), ['年度中央値', '780,000'], '独立年額に置換せず元の年度中央値を残す');
assert.deepEqual(rows(table(v2Detail)).slice(1, 13), monthly.map(m => [m.month, '0']));
assert.equal(JSON.stringify({ d: v2, v, budget: run('S.fc.budget') }), v2Before);
const v2Reverse = clone(v2); v2Reverse.planning.months.reverse();
assert.equal(render(v2Reverse), h2);
const downgraded = clone(v2); downgraded.planning.version = 'HISTORY_MONTHLY_POINT_V1';
assert.equal(render(downgraded), oldHtml, 'V1に独立年額を許可しない');
for (const [label, change] of invalid.filter(([label]) => label !== '別年度中心額')) {
  const x = clone(v2); change(x.planning);
  assert.equal(render(x), oldHtml, `V2 ${label}も旧表示へ戻す`);
}
for (const raw of [undefined, NaN, Infinity, -1, '780000.4', annual.p50 + .1]) {
  const x = clone(v2); x.planning.annualRawP50 = raw;
  assert.equal(render(x), oldHtml, 'V2の元年度P50は数値と同じ回の生額まで照合する');
}
const blankMethod = clone(v2); blankMethod.planning.method = ' ';
assert.equal(render(blankMethod), oldHtml);
const v2Stored = clone(v2); delete v2Stored.latest; v2Stored.stored = { annual: clone(annual) };
assert.equal(render(v2Stored), h2);
const v2Shadow = clone(v2); v2Shadow.shadow = clone(shadowed.shadow);
assert.equal(render(v2Shadow), render(shadowOld), 'V2も表示中のshadow中央値が違う場合は適用しない');
v2Shadow.shadow.annual.p50 = annual.p50;
assert.match(render(v2Shadow), /<div class="k">月次予測の合計<\/div>/, 'shadow照合は独立年額ではなく元の年度P50へ行う');

// 元年度中央値と帯が0でも、V2は過去実績から得た正の月次点予測を表示できる。
const zeroView = clone(v);
Object.assign(zeroView.boot.output.sections[0].annual, { p10: 0, p50: 0, p90: 0 });
zeroView.boot.output.sections[0].monthly.forEach(m => { m.p10 = m.p50 = m.p90 = 0; });
const zeroBaseline = clone(v2);
zeroBaseline.latest.annual_p10 = zeroBaseline.latest.annual_p50 = zeroBaseline.latest.annual_p90 = 0;
zeroBaseline.planning.annualRawP50 = 0;
const zeroHtml = render(zeroBaseline, 'result', zeroView);
assert.match(zeroHtml, /<div class="k">月次予測の合計<\/div>/);
assert.deepEqual(rows(table(zeroHtml)).at(-1), ['年度合計', '0', '390,000', '0']);
assert.ok(rows(table(zeroHtml)).slice(1, 13).some(r => Number(r[2].replaceAll(',', '')) > 0));
assert.deepEqual(chart().opts.band, Array.from({ length: 12 }, () => ({ lo: 0, hi: 0 })));
assert.equal(chart().series[0].values[0], 5000, '全0帯でも月次点を切り詰めない');
const zeroDetail = /<details class="mt12">([\s\S]*?)<\/details>/.exec(zeroHtml)[1];
assert.deepEqual(rows(table(zeroDetail)).at(-1), ['年度中央値', '0']);

// 予算策定・測る専用の予算案内は同一。編集欄の採用予測/上乗せも従来の値を保つ。
assert.equal(render(d, 'budget'), render(legacy, 'budget'), '予算策定HTMLは全て不変');
assert.equal(digest(render(d, 'budget')), 'd7ec040044b8f4b6299f525d03fbedb738984cd0dbe7a1c4b8d4e9c8ace12b50', 'V2追加前の予算HTMLと完全一致');
assert.equal(render(v2, 'budget'), render(legacy, 'budget'), '独立年額のV2も予算HTMLへ影響しない');
assert.deepEqual(chart().series.map(s => [s.label, s.values]), [['中心', Array(12).fill(0)], ['最終予算', monthly.map(m => m.final)]]);
assert.match(render(d, 'budget'), /value="33,333"[\s\S]*value="-11"/);
const measureView = clone(v); measureView.plan.measure = true;
run('S.fc.view=__v', { __v: measureView });
const measureHtml = run('fcBudgetTab(__d,__v)', { __d: d, __v: measureView });
assert.equal(measureHtml, run('fcBudgetTab(__d,__v)', { __d: legacy, __v: measureView }));
assert.match(measureHtml, /この計画では予算を設定できません/);
assert.match(render(d, 'result', measureView), /月次予測/);

// 実際のSVG経路でも、帯の外にある月次予測を欠落させず描画できる。
run("S.fc.view=__v; S.cv.fcMonthly='chart';", { __v: v });
const svgHtml = render(d);
assert.match(svgHtml, /<svg[\s\S]*月次予測/);
assert.doesNotMatch(svgHtml, /NaN|Infinity/);
assert.deepEqual(chart().opts.band, monthly.map(m => ({ lo: m.p10, hi: m.p90 })));
const v2SvgHtml = render(zeroBaseline, 'result', zeroView);
assert.match(v2SvgHtml, /<svg[\s\S]*月次予測/);
assert.doesNotMatch(v2SvgHtml, /NaN|Infinity/);
assert.deepEqual(chart().opts.band, Array.from({ length: 12 }, () => ({ lo: 0, hi: 0 })));
const pointYs = html => [...html.matchAll(/<circle cx="[^"]+" cy="([^"]+)" r="9" class="hit"/g)].map(m => Number(m[1]));
const plotYs = html => [...html.matchAll(/<line[^>]*y1="([^"]+)"[^>]*class="(?:grid|axis)"/g)].map(m => Number(m[1]));
const assertPointsInsidePlot = html => {
  const dots = pointYs(html), axes = plotYs(html);
  assert.equal(dots.length, 12);
  assert.ok(axes.length >= 2, 'SVGの実際の目盛り座標を取得する');
  assert.ok(dots.every(y => y >= Math.min(...axes) - .01 && y <= Math.max(...axes) + .01), '帯外の全主点がSVG目盛り内に収まる');
};
assertPointsInsidePlot(v2SvgHtml);
const highBand = clone(v);
highBand.boot.output.sections[0].monthly.forEach(m => { m.p10 = 100000; m.p90 = 200000; });
const belowBand = render(v2, 'result', highBand);
assertPointsInsidePlot(belowBand);
assert.deepEqual(chart().opts.band, Array.from({ length: 12 }, () => ({ lo: 100000, hi: 200000 })), 'P10より下の主点も帯を下げず表示する');
assert.equal(calls.length, callsBefore);
// 暫定の主列と一覧は同じ月次合計を表示し、予算などが読む元の年度中央値を変更しない。
run("S.cv.fcMonthly='table'; S.fc.view=__v;", { __v: v });
const provisional = clone(v2);
Object.assign(provisional.planning, { method: 'W_COMPONENT_EVENT_HALF_SHAPE_BLEND', provisional: true, validationStatus: 'in_progress' });
const provisionalHtml = render(provisional);
assert.match(provisionalHtml, /月次予測の合計（暫定）/);
assert.match(provisionalHtml, /精度は検証中です/);
assert.equal(rows(table(provisionalHtml)).at(-1)[2], '390,000');
const listRow = { planId: 'P1', clientName: '合成製薬', fy: 2026, p10: 0, p50: 0, p90: 2,
  forecastPointAnnual: 390000, forecastPointProvisional: true, previousForecastPointAnnual: 300000, prevP50: 0 };
const listBefore = JSON.stringify(listRow);
run('S.pf={plans:__list};', { __list: [listRow] });
const listHtml = run('mkForecastTable(__list).html', { __list: [listRow] });
assert.match(listHtml, /<th[^>]*>予測額<\/th>/);
assert.match(listHtml, /月次予測の合計（暫定）/);
assert.match(listHtml, /390,000/);
assert.match(listHtml, /30\.0%/);
assert.equal(JSON.stringify(listRow), listBefore, '描画が元の中央値と前回中央値を上書きしない');
assert.equal(run('S.pf.plans[0].p50'), 0);
const invalidProvisional = clone(provisional); delete invalidProvisional.planning.provisional;
assert.equal(render(invalidProvisional), render(legacy), '暫定識別が欠けた控えは元の中央値へ戻す');

console.log('PASS app-ui-monthly-planning: V1 compatibility, V2 independent annual sum, zero baseline, month join, quantiles, budget isolation');
