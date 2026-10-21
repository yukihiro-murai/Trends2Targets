#!/usr/bin/env node
/**
 * app-landing.test.mjs — 年度の着地見込み（統計。締まった月の実績で今年の水準を学ぶ）と、見通しの空模様（天気）。
 * 計算だけの関数（appLandingSky_ など）を見本の数で確かめ、全部の計画の一覧（apiPortfolio）を通しても確かめる。
 *
 *   node app/tests/app-landing.test.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { OWNER, makeEnv, STATS, J, repoRoot } from './gas-mock.mjs';

const near = (a, b, tol, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) <= tol, `${msg || ''}: ${a} と ${b}`);
const yms = Array.from({ length: 12 }, (_, i) => { const m = 4 + i; return (m > 12 ? 2027 : 2026) + '/' + String(m > 12 ? m - 12 : m).padStart(2, '0'); });
const flat = (p10, p50, p90) => yms.map((ym) => ({ ym, p10, p50, p90 }));
const acts = (v) => Object.fromEntries(v.map((x, i) => [yms[i], x]));
const base = { fy: 2026, months: flat(80, 100, 120), budget: 1200 };
const pure = makeEnv();
const sky = (over) => J(pure.run('appLandingSky_(__in)', { __in: Object.assign({}, base, over) }));
/**
 * 今の検証の版（D4〜D6）で B-2 が測った月の EVAL_LOG（neutral の行。[[月, 予測, 実績]]）。計画の一覧は、この行のある計画だけ
 * 検証の表の予測・外れ・幅の外を使う（appPortfolioScored_。前の版の表は、月が始まった後の予測のままのことがあるため）
 */
const evalLogSheet = (env, rows) => {
  const HE = J(env.run('APP_ENGINE_SHEETS.EVAL_LOG.header'));
  return { values: [HE, ...rows.map(([ym, pred, act]) => { const o = { eval_id: 'E-' + ym, evaluated_at: new Date(2026, 9, 6, 12), client: 'x', target_month: ym, scenario: 'neutral',
    pred, actual: act, evaluation_policy_version: 'policy-2026H1-v3', constraint_relevant_flag: 1 }; return HE.map((h) => (o[h] === undefined ? '' : o[h])); })], formats: { D: '@' } };
};

// ==== 1. 着地見込みと空模様（見本の表: 月の予測 80/100/120・年間予算 1,200） ====
{
  // A: 締まった月が無い（年度の始め）→ 着地 = 予測の合計。予算どおりなので晴れのち曇り
  const a = sky({ actual: {}, cutoffYm: '2026/04' });
  assert.deepEqual([a.sky, a.skyReason, a.skyDir, a.k, a.theta, a.credibility], ['harenochi', 'ratio', '', 0, 1, 0]);
  near(a.landing, 1200, 1e-9, 'A 着地');
  near(a.landingSd, 187.943, 1e-3, 'A sd');
  near(a.landingP10, 959.141, 1e-3, 'A P10');
  near(a.landingP90, 1440.859, 1e-3, 'A P90');
  near(a.pAbove, 0.5, 1e-9, 'A 予算以上の確率');
  // P / Q: 予算だけが違う
  const p = sky({ actual: {}, cutoffYm: '2026/04', budget: 1440 });
  assert.equal(p.sky, 'kumori');
  near(p.pAbove, 0.1008, 1e-4, 'P 予算以上の確率');
  const q = sky({ actual: {}, cutoffYm: '2026/04', budget: 700 });
  assert.equal(q.sky, 'mousho');
  near(q.ratio, 1.7143, 1e-4, 'Q 着地 / 予算');
  // B: 予測どおりの 6 か月 → 着地は変わらず、ばらつきが縮む
  const b = sky({ actual: acts([100, 100, 100, 100, 100, 100]), cutoffYm: '2026/10' });
  assert.deepEqual([b.sky, b.k, b.actualYtd], ['harenochi', 6, 600]);
  near(b.landing, 1200, 1e-9, 'B 着地');
  near(b.landingSd, 56.261, 1e-3, 'B sd');
  near(b.credibility, 0.7896, 1e-4, 'B 実績の重み');
  // C: 予測の 80% の 6 か月 → 水準 θ が下がり、残りの月にも伸ばす
  const c = sky({ actual: acts([80, 80, 80, 80, 80, 80]), cutoffYm: '2026/10' });
  assert.equal(c.sky, 'kumori');
  near(c.theta, 0.8421, 1e-4, 'C θ');
  near(c.landing, 985.244, 1e-3, 'C 着地');
  near(c.ratio, 0.8210, 1e-4, 'C 着地 / 予算');
  assert.ok(c.landingP10 >= c.actualYtd && c.landingP10 < c.landing && c.landingP90 > c.landing, 'P10 < 着地 < P90');
  // C（τ = 0.25）: 事前分布が緩いと、実績の重みが増す
  const c25 = sky({ actual: acts([80, 80, 80, 80, 80, 80]), cutoffYm: '2026/10', tau: 0.25 });
  near(c25.landing, 970.502, 1e-3, 'C τ=0.25 着地');
  near(c25.credibility, 0.9125, 1e-4, 'C τ=0.25 実績の重み');
  // D / E / F: 180% → 猛暑、130% → 快晴、30% → 雨
  for (const [v, want, r] of [[180, 'mousho', 1.7159], [130, 'kaisei', 1.2684], [30, 'ame', 0.3736]]) {
    const x = sky({ actual: acts(Array(6).fill(v)), cutoffYm: '2026/10' });
    assert.equal(x.sky, want, v + '%');
    near(x.ratio, r, 1e-4, v + '% の着地 / 予算');
  }
  // G: 締まった月に実績が無い（行も無い）→ 雪
  const g = sky({ actual: {}, cutoffYm: '2026/06' });
  assert.deepEqual([g.sky, g.skyReason, g.k, g.actualYtd], ['sekka', 'zero_sales', 2, 0]);
  // G2: 行の無い締まった月は 0 円として数える → 急な落ち込み（天変地異）
  const g2 = sky({ actual: acts([100, 100]), cutoffYm: '2026/07' });
  assert.deepEqual([g2.sky, g2.skyReason, g2.skyDir, g2.k, g2.actualYtd], ['tenpen', 'shock', 'down', 3, 200]);
  near(g2.zLast, -5.53, 0.01, 'G2 z');
  // H: 予算が無い → 霧（着地の数字は出す。着地 / 予算と確率は出さない）
  const h = sky({ budget: null, actual: acts([100]), cutoffYm: '2026/05' });
  assert.deepEqual([h.sky, h.skyReason, h.ratio, h.pAbove], ['mikakunin', 'no_budget', null, null]);
  assert.ok(h.landing > 0, '予測が使えれば着地は出す');
  assert.equal(sky({ budget: 0, actual: {}, cutoffYm: '2026/06' }).skyReason, 'no_budget', '予算 0 は無いのと同じ（雪より先）');
  // I: 月の予測が無い → 霧
  const i = sky({ months: [], actual: acts([100]), cutoffYm: '2026/05' });
  assert.deepEqual([i.sky, i.skyReason, i.landing], ['mikakunin', 'no_forecast', null]);
  const holes = flat(80, 100, 120); holes[7] = { ym: yms[7], p10: null, p50: 100, p90: 120 };
  assert.equal(sky({ months: holes, actual: acts([100]), cutoffYm: '2026/05' }).skyReason, 'no_forecast', 'P10 の無い月がある');
  assert.equal(sky({ months: flat(0, 0, 0), actual: acts([100]), cutoffYm: '2026/05' }).skyReason, 'no_forecast', '予測の合計が 0');
  assert.equal(sky({ months: [], actual: {}, cutoffYm: '2026/06' }).skyReason, 'zero_sales', '雪は予測が無くても先に出す');
  // J / J2: 締まった月の実績が 3 か月以上取り込まれていない → 霧。古い実績のままの着地の数字は出さない（合計にも入らない）
  const j = sky({ actual: acts([100]), cutoffYm: '2026/05', todayYm: '2026/10' });
  assert.deepEqual([j.sky, j.skyReason], ['mikakunin', 'stale_actuals']);
  assert.deepEqual([j.landing, j.landingSd, j.landingP10, j.landingP90, j.pAbove, j.ratio, j.theta, j.credibility], [null, null, null, null, null, null, null, null], '霧（遅れ）は着地の数字を出さない');
  assert.deepEqual([j.k, j.actualYtd, j.budget], [1, 100, 1200], '締まった月の実績と予算はそのまま');
  assert.equal(sky({ actual: acts([100, 100, 100, 100]), cutoffYm: '2026/08', todayYm: '2026/10' }).sky, 'harenochi', '2 か月の遅れは霧にしない');
  assert.equal(sky({ months: [], actual: acts([100]), cutoffYm: '2026/05', todayYm: '2026/10' }).skyReason, 'no_forecast', '予測が無いのが先');
  const nulls0 = (x) => [x.landing, x.landingSd, x.landingP10, x.landingP90, x.pAbove, x.ratio, x.theta, x.credibility];
  // J5: B-1 の後に B-2 がまだ（締まった月の境目が '' で 0 か月に見える）。B-1 の取り込みの境目で数えれば遅れていない → 計算待ち（eval_pending）。
  // 数字を出さないのは実績の遅れと同じ。B-1 の境目で数えても 3 か月以上遅れていれば、実績の遅れ（stale_actuals）のまま
  const j5 = sky({ actual: {}, cutoffYm: '', pendingCutoffYm: '2026/10', todayYm: '2026/10' });
  assert.deepEqual([j5.sky, j5.skyReason, j5.k, ...nulls0(j5)], ['mikakunin', 'eval_pending', 0, null, null, null, null, null, null, null, null], 'B-2 待ち');
  const j6 = sky({ actual: acts([100, 100, 100, 100]), cutoffYm: '2026/08', pendingCutoffYm: '2026/10', todayYm: '2026/10' });
  assert.deepEqual([j6.skyReason, j6.k], ['ratio', 4], '前の B-2 の境目で遅れが 3 か月未満なら、これまでどおり前の B-2 の月で着地を出す');
  assert.equal(sky({ actual: acts([100]), cutoffYm: '2026/05', pendingCutoffYm: '2026/10', todayYm: '2026/10' }).skyReason, 'eval_pending', '前の B-2 の月があっても、B-1 の境目で遅れていなければ計算待ち');
  assert.equal(sky({ actual: {}, cutoffYm: '', pendingCutoffYm: '2026/07', todayYm: '2026/10' }).skyReason, 'stale_actuals', 'B-1 の取り込み自体が 3 か月遅れていれば、実績の遅れ');
  assert.equal(sky({ actual: {}, cutoffYm: '', pendingCutoffYm: '2026/08', todayYm: '2026/10' }).skyReason, 'eval_pending', 'B-1 の境目で遅れが 2 か月なら計算待ち');
  assert.equal(sky({ actual: {}, cutoffYm: '', pendingCutoffYm: '', todayYm: '2026/10' }).skyReason, 'stale_actuals', 'B-1 が無ければ実績の遅れ');
  assert.equal(sky({ budget: null, actual: {}, cutoffYm: '', pendingCutoffYm: '2026/10', todayYm: '2026/10' }).skyReason, 'no_budget', '予算が無いのが先');
  // 境目の読み方: B-1 の後に B-2 が無い・古いときだけ B-1 の境目。B-2 が新しければ ''（締まった月の境目 appLandingCutoff_ の方）
  const stp = (b1, b2) => [['step2_status', b1], ['step5_status', b2]].filter((x) => x[1]).map(([k, t]) => ({ step_key: k, status: 'success', last_run_date: t }));
  const pc = (rows) => pure.run('appLandingPendingCutoff_(__r)', { __r: rows });
  const cu = (rows) => pure.run('appLandingCutoff_(__r)', { __r: rows });
  assert.deepEqual([pc(stp(new Date(2026, 9, 5, 10), new Date(2026, 8, 5, 10))), cu(stp(new Date(2026, 9, 5, 10), new Date(2026, 8, 5, 10)))], ['2026/10', ''], 'B-2 が古い');
  assert.deepEqual([pc(stp(new Date(2026, 9, 5, 10), null)), cu(stp(new Date(2026, 9, 5, 10), null))], ['2026/10', ''], 'B-2 が無い');
  assert.deepEqual([pc(stp(new Date(2026, 9, 5, 10), new Date(2026, 9, 5, 11))), cu(stp(new Date(2026, 9, 5, 10), new Date(2026, 9, 5, 11)))], ['', '2026/10'], 'B-2 が済んでいる');
  assert.deepEqual([pc(stp(null, new Date(2026, 9, 5, 11))), pc([]), pc(stp(new Date(2026, 9, 3, 10), null))], ['', '', '2026/09'], 'B-1 が無い・10/03 の取り込みは 9 月が途中');
  // J3 / J4: 予算が無い・雪が先に当たっても、実績の取り込みが遅れていれば着地の数字は出さない（空模様の順は変えない）
  const nulls = (x) => [x.landing, x.landingSd, x.landingP10, x.landingP90, x.pAbove, x.ratio, x.theta, x.credibility];
  const j3 = sky({ budget: null, actual: {}, cutoffYm: '', todayYm: '2026/10' });
  assert.deepEqual([j3.sky, j3.skyReason, j3.k, ...nulls(j3)], ['mikakunin', 'no_budget', 0, null, null, null, null, null, null, null, null], '予算が無い + 遅れ');
  assert.equal(sky({ budget: null, actual: {}, cutoffYm: '', todayYm: '2026/06' }).landing, 1200, '2 か月の遅れなら予算が無くても着地は出す');
  const j4 = sky({ actual: acts([0]), cutoffYm: '2026/05', todayYm: '2026/10' });
  assert.deepEqual([j4.sky, j4.skyReason, j4.k, j4.actualYtd, ...nulls(j4)], ['sekka', 'zero_sales', 1, 0, null, null, null, null, null, null, null, null], '雪 + 遅れ');
  assert.ok(sky({ actual: acts([0]), cutoffYm: '2026/05', todayYm: '2026/06' }).landing > 0, '遅れていない雪は着地を出す');
  assert.equal(sky({ fy: 2027, months: flat(80, 100, 120).map((m) => ({ ...m, ym: String(Number(m.ym.slice(0, 4)) + 1) + m.ym.slice(4) })), actual: {}, cutoffYm: '2026/10', todayYm: '2026/10' }).sky,
    'harenochi', '次の年度の計画は霧にしない（締まった月がまだ無い）');
  // K: 予測どおりの 5 か月のあと、ひと月だけ大きく落ちる → 天変地異（shock）
  const k = sky({ actual: acts([100, 100, 100, 100, 100, 30]), cutoffYm: '2026/10' });
  assert.deepEqual([k.sky, k.skyReason, k.skyDir], ['tenpen', 'shock', 'down']);
  near(k.zLast, -4.075, 1e-3, 'K z');
  near(k.dRatio1, -0.1264, 1e-4, 'K 着地 / 予算の動き');
  assert.equal(sky({ actual: acts([100, 100, 100, 100, 100, 30]), cutoffYm: '2026/10', todayYm: '2027/02' }).skyReason, 'stale_actuals', '霧が天変地異より先');
  // K2: 同じ外れ（|z| ≥ 3）でも、予算が大きくて着地 ÷ 予算が 0.05 も動かなければ天変地異にしない（重要度のしきい値）
  const kBig = sky({ actual: acts([100, 100, 100, 100, 100, 30]), cutoffYm: '2026/10', budget: 100000 });
  assert.deepEqual([kBig.sky, kBig.skyReason, kBig.skyDir], ['ame', 'ratio', ''], '予算 100,000 では着地 ÷ 予算がほとんど動かない');
  assert.ok(kBig.zLast <= -3 && Math.abs(kBig.dRatio1) < 0.05, `z ${kBig.zLast}・動き ${kBig.dRatio1}`);
  near(kBig.dRatio1, -0.0015, 1e-4, 'K2 着地 / 予算の動き');
  const k3000 = sky({ actual: acts([100, 100, 100, 100, 100, 30]), cutoffYm: '2026/10', budget: 3000 });
  assert.deepEqual([k3000.sky, k3000.skyReason, k3000.skyDir], ['tenpen', 'shock', 'down'], '予算 3,000 なら動きが 0.05 を超える');
  near(k3000.dRatio1, -0.0505, 1e-4, 'K3 着地 / 予算の動き');
  assert.equal(sky({ actual: acts([100, 100, 100, 100, 100, 30]), cutoffYm: '2026/10', budget: 3100 }).skyReason, 'ratio', '予算 3,100 では 0.05 に届かない');
  // L: 2 か月続けて同じ向きに外れる → 天変地異（shift）
  const l = sky({ actual: acts([100, 100, 100, 100, 140, 140]), cutoffYm: '2026/10' });
  assert.deepEqual([l.sky, l.skyReason, l.skyDir], ['tenpen', 'shift', 'up']);
  near(l.dRatio2, 0.1382, 1e-4, 'L 着地 / 予算の動き（2 か月）');
  // M / M2: 直近 2 回の予測の年間 P50 が 30% 以上違う（31 日以内）→ 天変地異（premise）
  const runs = (age0, p0 = 1700, p1 = 1200) => [{ p50: p0, ageDays: age0 }, { p50: p1, ageDays: age0 + 37 }];
  const m = sky({ actual: acts([100, 100]), cutoffYm: '2026/06', runs: runs(3) });
  assert.deepEqual([m.sky, m.skyReason, m.skyDir], ['tenpen', 'premise', 'up']);
  assert.equal(sky({ actual: acts([100, 100]), cutoffYm: '2026/06', runs: runs(40) }).sky, 'harenochi', '40 日前の変化は拾わない');
  assert.equal(sky({ actual: acts([100, 100]), cutoffYm: '2026/06', runs: runs(3, 800) }).skyDir, 'down', '下がった前提の変化');
  assert.equal(sky({ actual: acts([100, 100]), cutoffYm: '2026/06', runs: runs(3), budget: 10000 }).skyReason, 'ratio', '予算の 10% に満たない変化は拾わない');
  assert.equal(sky({ actual: acts([100, 100]), cutoffYm: '2026/06', runs: runs(3, null) }).skyReason, 'ratio', '年間 P50 の無い回は比べない');
  assert.equal(sky({ actual: {}, cutoffYm: '2026/04', runs: runs(0) }).skyReason, 'premise', '締まった月が無くても前提の変化は拾う');
  // M3: 12 か月締まった年度は、予測し直しても前提の変化にしない（着地は実績の合計で動かない）。11 か月なら拾う
  const closed = sky({ actual: acts(Array(12).fill(100)), cutoffYm: '2027/04', runs: runs(3) });
  assert.deepEqual([closed.k, closed.sky, closed.skyReason, closed.landing, closed.landingSd], [12, 'harenochi', 'ratio', 1200, 0]);
  assert.equal(sky({ months: [], actual: acts(Array(12).fill(100)), cutoffYm: '2027/04', runs: runs(0, 2000) }).skyReason, 'ratio', '予測が無くても同じ');
  assert.equal(sky({ actual: acts(Array(11).fill(100)), cutoffYm: '2027/03', runs: runs(3) }).skyReason, 'premise', '11 か月なら前提の変化を拾う');
  // N: 幅の倍率 w = 2 → 実績の重みが下がり、ばらつきが広がる
  const n = sky({ actual: acts([80, 80, 80]), cutoffYm: '2026/07', w: 2 });
  assert.equal(n.sky, 'kumori');
  near(n.credibility, 0.3705, 1e-4, 'N 実績の重み');
  near(n.pAbove, 0.1866, 1e-4, 'N 予算以上の確率');
  // O: 12 か月が締まった（予測が無くても）→ 着地 = 実績の合計。ばらつき 0
  const o = sky({ months: [], actual: acts([...Array(11).fill(100), 150]), cutoffYm: '2027/04' });
  assert.deepEqual([o.sky, o.landing, o.landingSd, o.landingP10, o.landingP90, o.pAbove, o.k], ['harenochi', 1250, 0, 1250, 1250, 1, 12]);
  // R: 取り込んだ月（途中の月）の実績は数えない
  const r = sky({ actual: { ...acts([100, 100, 100, 100, 100, 100]), '2026/10': 5 }, cutoffYm: '2026/10' });
  assert.deepEqual([r.actualYtd, r.landing, r.sky], [600, b.landing, 'harenochi']);
  assert.equal(sky({ actual: acts([100, 100, 100]), cutoffYm: '' }).k, 0, '境目が分からなければ締まった月は 0');
  // θ は 0〜5 に収める
  assert.equal(sky({ actual: acts(Array(6).fill(100000)), cutoffYm: '2026/10' }).theta, 5);
  // 境目（12 か月締まった年度で、着地 / 予算 = 1.5・1.1・1.0999・0.9・0.5・0.5001）
  for (const [total, want] of [[1800, 'mousho'], [1320, 'kaisei'], [1319.88, 'harenochi'], [1080, 'kumori'], [600, 'ame'], [600.12, 'kumori']]) {
    const x = sky({ months: [], actual: acts([...Array(11).fill(100), total - 1100]), cutoffYm: '2027/04' });
    assert.equal(x.sky, want, '着地 ' + total);
  }
}

// ==== 2. 全計画で学ぶ τ（今年の水準のばらつき）と w（P10〜P90 の幅の倍率） ====
{
  const mk = (f, as, p10, p90) => as.map((a) => ({ f, a, p10, p90 }));
  const prior = (plans) => J(pure.run('appLandingPrior_(__in)', { __in: plans }));
  const t = prior([mk(100, [90, 110, 100]), mk(100, [120, 130, 125]), mk(100, [70, 80, 75])]);
  near(t.tau, 0.2466, 1e-4, '水準 1.0・1.25・0.75 の 3 計画');
  assert.deepEqual([t.learned, t.plans, t.w], [true, 3, 1], '幅の倍率は月が 12 未満なら 1');
  assert.deepEqual(prior([mk(100, [90, 110, 100]), mk(100, [120, 130, 125])]).tau, 0.15, '2 計画では学ばない');
  assert.equal(prior([mk(100, [90, 110, 100]), mk(100, [120, 130, 125]), mk(100, [70, 80])]).tau, 0.15, '2 か月の計画は数えない');
  assert.equal(prior([mk(100, [99, 101, 100]), mk(100, [100, 102, 98]), mk(100, [101, 99, 100])]).tau, 0.05, '揃っていれば下限');
  assert.equal(prior([mk(100, [200, 210, 205]), mk(100, [10, 12, 11]), mk(100, [400, 390, 410])]).tau, 0.35, '上限');
  assert.equal(prior([]).tau, 0.15);
  // 雪（締まった月の売上が全部 0 円）の計画は学びに入れない（水準 −100% として τ を上限に押し上げ、ほかの計画の着地を動かすため）。
  // 0 円の月がいくつかあるだけの計画は、その月を 0 円のまま使う
  const three = [mk(100, [90, 110, 100]), mk(100, [120, 130, 125]), mk(100, [70, 80, 75])];
  const snow = mk(100, [0, 0, 0, 0, 0, 0], 80, 120);
  assert.deepEqual(prior([...three, snow]), t, '雪の計画は τ・w・数を変えない');
  assert.deepEqual(prior([...three, snow.map((x) => ({ ...x, a: 0.1 }))]), t, '合計が 1 円未満も雪と同じ');
  const steady = [mk(100, [100, 100, 100, 100, 100, 100]), mk(100, [105, 105, 105, 105, 105, 105]), mk(100, [95, 95, 95, 95, 95, 95]), mk(100, [102, 102, 102, 102, 102, 102])];
  assert.deepEqual([prior(steady).tau, prior([...steady, snow]).tau], [0.05, 0.05], '予測どおりの 4 計画に雪が 1 つ加わっても τ は 0.05 のまま（入れると上限 0.35）');
  const oneZero = prior([...steady.slice(1), mk(100, [100, 100, 0, 100, 100, 100])]);
  assert.deepEqual([oneZero.plans, oneZero.learned], [4, true], '0 円の月が 1 つの計画は入れる');
  assert.ok(oneZero.tau > 0.05 && oneZero.tau < 0.1, '0 円の月の分だけ τ が少し動く: ' + oneZero.tau);
  // w: 計画ごとの水準を除いた外れ ÷ 幅の 80% 点
  const wide = [mk(100, [90, 110, 90, 110], 95, 105), mk(100, [90, 110, 90, 110], 95, 105), mk(100, [90, 110, 90, 110], 95, 105)];
  near(prior(wide).w, 2, 1e-9, '幅が半分しかない');
  assert.equal(prior(wide.map((p) => p.map((x) => ({ ...x, p10: 99, p90: 101 })))).w, 3, '上限 3');
  assert.equal(prior(wide.map((p) => p.map((x) => ({ ...x, p10: 60, p90: 140 })))).w, 1, '幅が十分なら 1');
  const noBand = prior(wide.map((p) => p.map((x) => ({ ...x, p10: null, p90: null }))));
  assert.deepEqual([noBand.w, noBand.months, noBand.plans], [1, 0, 3], 'P10/P90 の無い月は幅に使わない（水準には使う）');
}

// ==== 3. 締まった月の境目・月の予測の読み取り・予測の日数 ====
{
  const H = J(pure.run('APP_ENGINE_SHEETS.PROCESS_STATUS.header'));
  assert.equal(H[1], 'last_run_date');
  const st = (key, t, v, status = 'success') => ({ step_key: key, last_run_date: v, status, _types: 's' + t + 'sssns' });
  const cut = (rows) => pure.run('appLandingCutoff_(__in)', { __in: rows });
  assert.equal(cut([st('step2_status', 'd', '2026-10-05T01:00:00.000Z'), st('step5_status', 'd', '2026-10-05T02:00:00.000Z')]), '2026/10', 'B-1 の後に B-2（10/05 の取り込みで 9 月は締まる）');
  assert.equal(cut([st('step2_status', 'd', '2026-10-05T01:00:00.000Z'), st('step5_status', 'd', '2026-09-05T02:00:00.000Z')]), '', 'B-2 が古い');
  assert.equal(cut([st('step2_status', 'd', '2026-10-05T01:00:00.000Z'), st('step5_status', 'd', '2026-10-06T02:00:00.000Z', 'error')]), '', 'B-2 が失敗');
  assert.equal(cut([st('step2_status', 'd', '2026-10-05T01:00:00.000Z')]), '', 'B-2 が無い');
  assert.equal(cut([st('step2_status', 's', '2026/10/05 10:00:00'), st('step5_status', 's', '2026/10/05 10:30')]), '2026/10', '文字の日時');
  // 2026-10-07 から（D5）: 月末から 5 日たってから取り込んだ月だけが締まった月。前は「取り込んだ月より前」だったので、
  // 10/01 の取り込みでも 9 月を締まった月にしていた（下の 3 つは前は '2026/10'）。境目の 10/04 と 10/05 の間で、日本の暦を見ることを確かめ直す
  assert.equal(cut([st('step2_status', 'd', '2026-09-30T16:00:00.000Z'), st('step5_status', 'd', '2026-09-30T17:00:00.000Z')]), '2026/09', '日本の暦で 10 月 1 日の取り込み: 9 月はまだ途中');
  assert.equal(cut([st('step2_status', 's', '2026-09-30T16:00:00Z'), st('step5_status', 's', '2026-09-30T17:00:00Z')]), '2026/09', '文字の ISO 時刻も日本の暦で 10 月 1 日');
  assert.equal(cut([st('step2_status', 's', '2026-10-01T00:30:00+0900'), st('step5_status', 's', '2026-10-01T01:00:00+0900')]), '2026/09', '時差つき（+0900）の 10 月 1 日');
  assert.equal(cut([st('step2_status', 's', '2026-09-30T14:59:00Z'), st('step5_status', 's', '2026-09-30T17:00:00Z')]), '2026/09', '日本の暦で 9 月 30 日 23:59（8 月までが締まった月）');
  assert.equal(cut([st('step2_status', 's', '2026-10-04T14:59:00Z'), st('step5_status', 's', '2026-10-04T17:00:00Z')]), '2026/09', '日本の暦で 10 月 4 日 23:59: 9 月はまだ途中');
  assert.equal(cut([st('step2_status', 's', '2026-10-04T15:00:00Z'), st('step5_status', 's', '2026-10-04T17:00:00Z')]), '2026/10', '日本の暦で 10 月 5 日 0:00: 9 月は締まる');
  assert.equal(cut([st('step2_status', 's', '2026-10-05T00:30:00+0900'), st('step5_status', 's', '2026-10-05T01:00:00+0900')]), '2026/10', '時差つき（+0900）の 10 月 5 日');
  assert.deepEqual(['2026-03-31T15:00:00.000Z', '2026-03-31T14:59:00Z', '2026/04', '2026-04-15', '2026年4月'].map((x) => pure.run(`appCellYm_('s', '${x}')`)),
    ['2026/04', '2026/03', '2026/04', '2026/04', '2026/04'], '月の文字（時刻つきの ISO は日本の暦で）');
  assert.equal(cut([]), '');
  // 締まった月の決まり（D5）: 月末 + 5 日 <= 取り込んだ日（日本の暦）。月末の日数・年の変わり目・うるう年
  assert.equal(pure.run('APP_ACTUAL_CLOSE_LAG_DAYS'), 5);
  const closed = (ym, day) => pure.run(`appActualClosed_('${ym}', '${day}')`);
  assert.deepEqual([closed('2026/09', '2026-10-03'), closed('2026/09', '2026-10-04'), closed('2026/09', '2026-10-05'), closed('2026/09', '2026-10-06')],
    [false, false, true, true], '9 月は 10/05 から');
  assert.deepEqual([closed('2026/08', '2026-09-04'), closed('2026/08', '2026-09-05'), closed('2026/08', '2026-10-03')], [false, true, true], '31 日の月');
  assert.deepEqual([closed('2028/02', '2028-03-04'), closed('2028/02', '2028-03-05'), closed('2027/02', '2027-03-04'), closed('2027/02', '2027-03-05')],
    [false, true, false, true], '2 月も翌月の 5 日から（うるう年でも同じ）');
  assert.deepEqual([closed('2026/12', '2027-01-04'), closed('2026/12', '2027-01-05'), closed('2026/10', '2026-10-31'), closed('', '2026-10-06'), closed('2026/09', '')],
    [false, true, false, false, false], '年の変わり目・取り込んだ月そのもの・読めない値');
  const cy = (day) => pure.run(`appCloseCutoffYm_('${day}')`);
  assert.deepEqual(['2026-10-03', '2026-10-06', '2026-10-31', '2027-01-04', '2027-01-05', '2028-03-04', '2028-03-05', 'x'].map(cy),
    ['2026/09', '2026/10', '2026/10', '2026/12', '2027/01', '2028/02', '2028/03', ''], '境目 = 締まった月の次の月');
  // 境目は、締まった月（appActualClosed_ が真）とそうでない月のちょうど間（1 日ずつ 1 年分）
  for (let d = Date.UTC(2026, 0, 1); d < Date.UTC(2027, 0, 1); d += 864e5) {
    const day = new Date(d).toISOString().slice(0, 10);
    const c = cy(day);
    const prev = pure.run(`appInsightPrevYm_('${c}', 1)`);
    assert.ok(closed(prev, day) && !closed(c, day), `${day}: 境目 ${c} の前の月は締まり、境目の月は締まっていない`);
  }
  // B-1 を月末から 3 日目に動かすと前の月は途中、6 日目なら締まる（B-2 はその後）
  const at = (b1, b2) => cut([st('step2_status', 's', b1), st('step5_status', 's', b2)]);
  assert.equal(at('2026/10/03 10:00', '2026/10/03 11:00'), '2026/09', 'B-1 が 10/03: 9 月は締まっていない（8 月まで）');
  assert.equal(at('2026/10/06 10:00', '2026/10/06 11:00'), '2026/10', 'B-1 が 10/06: 9 月は締まった');
  assert.equal(at('2026/10/03 10:00', '2026/10/06 11:00'), '2026/09', 'B-2 を後で動かしても、決めるのは B-1 の日');
  assert.equal(at('2026/10/06 10:00', '2026/10/03 11:00'), '', 'B-2 が B-1 より古い決まりはそのまま');
  // 読み戻した行（日時は日時の型。_types は無い）でも同じ
  const dated = (b1, b2) => pure.run(`appLandingCutoff_([{ step_key: 'step2_status', status: 'success', last_run_date: new Date('${b1}') },
    { step_key: 'step5_status', status: 'Success', last_run_date: new Date('${b2}') }])`);
  assert.deepEqual([dated('2026-10-03T01:00:00Z', '2026-10-03T02:00:00Z'), dated('2026-10-06T01:00:00Z', '2026-10-06T02:00:00Z'), dated('2026-10-06T01:00:00Z', '2026-10-03T02:00:00Z')],
    ['2026/09', '2026/10', ''], '日時の型の行');
  assert.equal(pure.run(`appMonthStartMs_('2026/10')`), Date.parse('2026-09-30T15:00:00Z'), '月の初めは日本の暦の 1 日 0 時');
  assert.equal(pure.run(`appMonthStartMs_('2026-10')`), null);
  // 旧来の側（Forecast_Agent.js）の同じ決まりの数とそろう（D5: 1 つの決まりを両方で使う）。旧来の側に定数がまだ無いときは知らせて飛ばす
  const legacySrc = await readFile(path.join(repoRoot, 'Forecast_Agent.js'), 'utf8');
  const legacyLag = [...legacySrc.matchAll(/\b([A-Z][A-Z0-9_]*CLOSE[A-Z0-9_]*DAYS?)\b\s*[:=]\s*(\d+)/g)];
  if (legacyLag.length) for (const m of legacyLag) assert.equal(Number(m[2]), pure.run('APP_ACTUAL_CLOSE_LAG_DAYS'), `旧来の ${m[1]} と同じ日数`);
  else console.log('app-landing: 旧来の側（Forecast_Agent.js）に締まりの日数の定数（…CLOSE…DAYS）がまだ無いので、照合を飛ばしました');
  assert.equal(pure.run(`appLandingAgeDays_('2026-10-03T12:00:00+0900', '2026-10-06')`), 3);
  assert.equal(pure.run(`appLandingAgeDays_('2026-10-05T15:30:00Z', '2026-10-06')`), 0, '日本の暦で同じ日');
  assert.equal(pure.run(`appLandingAgeDays_('', '2026-10-06')`), null);
  const ms = J(pure.run('appLandingMonths_(__in)', { __in: { 29: ['s2026/04', 'n80', 'n100', 'n120'], 30: ['d2026-04-30T15:00:00.000Z', 'n1', 'n2', 'n3'], 31: ['s2026/06', 'e', 'n100', 'f=B31'], 32: ['e'] } }));
  assert.deepEqual(ms, [{ ym: '2026/04', p10: 80, p50: 100, p90: 120 }, { ym: '2026/05', p10: 1, p50: 2, p90: 3 }, { ym: '2026/06', p10: null, p50: 100, p90: null }]);
  near(pure.run('appNormCdf_(1.2815515655446004)'), 0.9, 1e-6, 'Φ');
  near(pure.run('appNormCdf_(-3)'), 0.00135, 1e-5, 'Φ');
}

// ==== 4. 全部の計画の一覧を通して（OUTPUT・検証の表・手順の進みから）。今日の日付が変われば控えも変わる ====
{
  const env = makeEnv();
  env.run(`appToday_ = function () { return '2026-10-06'; }`);
  env.as(OWNER);
  env.call('apiSetup()');
  const HC = J(env.run('APP_ENGINE_SHEETS.EVAL_COMPARE_MONTHLY.header'));
  const HS = J(env.run('APP_ENGINE_SHEETS.PROCESS_STATUS.header'));
  const output = [['FY2026 売上予測']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 1000, 1200, 1400]);
  output.push([], ['月', 'P10', 'P50', 'P90', '', '', '', '採用予測', '上乗せ']);
  yms.forEach((ym) => output.push([ym, 80, 100, 120, '', '', '', 100, '']));
  const cmpRow = (ym, act, p50) => [ym, '', '', p50, '', '', act, '', p50 === '' ? '' : 80, p50, p50 === '' ? '' : 120, '', '', p50 === '' ? '' : Math.abs(p50 - act) / act, '', '', '', '', '', p50 === '' ? '' : 0, '', '', ''];
  const book = (client, b2) => env.makeBook(client, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    OUTPUT: { values: output },
    // 前の年度の月（予測なし）・締まった 6 か月（予測の 80%）・取り込んだ月の途中の実績
    EVAL_COMPARE_MONTHLY: { values: [HC, cmpRow('2026/03', 999, ''), ...yms.slice(0, 6).map((ym) => cmpRow(ym, 80, 100)), cmpRow('2026/10', 5, 100)] },
    EVAL_LOG: evalLogSheet(env, yms.slice(0, 6).map((ym) => [ym, 100, 80])),
    PROCESS_STATUS: { values: [HS, ['step2_status', new Date(2026, 9, 5, 10), 'owner', 'success', client, 10, ''], ['step5_status', b2, 'owner', 'success', '', 6, '']] },
  });
  const idA = env.seedPlan(book('甲製薬', new Date(2026, 9, 5, 11)));
  const idB = env.seedPlan(book('乙製薬', new Date(2026, 8, 5, 11)));   // B-2 が B-1 より古い
  const plan = (id) => env.call('apiPortfolio()').plans.filter((p) => p.planId === id)[0];
  const a = plan(idA);
  assert.deepEqual([a.k, a.actualYtd, a.actualMonths, a.forecastYtd, a.rangeN, a.rangeOut], [6, 480, 6, 600, 6, 0], '締まった 6 か月だけ（途中の月・前の年度は数えない）');
  // 外れ幅も締まった月だけ（2026-10-07 D4。前は取り込んだ 10 月の途中の実績 5（外れ幅 19）も平均に入れていた）
  assert.equal(a.mapeMonths, 6);
  near(a.mape, 0.25, 1e-12, '外れ幅');
  assert.deepEqual([a.sky, a.skyReason, a.skyDir, a.budget, a.budgetUsed, a.budgetSource], ['kumori', 'ratio', '', 1200, 1200, 'draft']);
  near(a.landing, 985.244, 1e-3, '着地（τ・w は学べないので 0.15・1）');
  near(a.ratio, 0.8210, 1e-4, '着地 / 予算');
  near(a.theta, 0.8421, 1e-4, 'θ');
  assert.ok(a.landingP10 < a.landing && a.landingP90 > a.landing && a.pAbove < 0.01 && a.credibility > 0.7);
  assert.deepEqual([a.p10, a.p50, a.p90], [1000, 1200, 1400], '年間の P10/P50/P90（まだ予測を実行していないので OUTPUT の 26 行）');
  const b = plan(idB);
  // B-1（10/05）の後に B-2 がまだ（9/05 の B-2 が最後）: 実績は取り込んだが、当たり具合の計算待ち（2026-10-08。前は「実績の遅れ」と出ていた）
  assert.deepEqual([b.k, b.actualYtd, b.actualMonths, b.sky, b.skyReason], [0, null, 0, 'mikakunin', 'eval_pending'], 'B-2 が古ければ締まった月は数えず霧（計算待ち）');
  assert.deepEqual([b.landing, b.landingSd, b.landingP10, b.landingP90, b.pAbove, b.ratio, b.theta, b.credibility], [null, null, null, null, null, null, null, null], '霧（計算待ち）は着地の数字を出さない');
  // ホームの合計: 着地の無い計画（霧）は着地の合計にも着地 ÷ 予算にも入れない。入れた数も返す
  const ht = env.call('apiHome()').totals;
  assert.deepEqual([ht.plans, ht.budget, ht.budgetPlans, ht.actualYtd, ht.landingPlans, ht.ratioPlans], [2, 2400, 2, 480, 1, 1], JSON.stringify(ht));
  near(ht.landing, a.landing, 1e-9, 'ホームの着地の合計は甲だけ');
  near(ht.ratio, a.landing / 1200, 1e-9, 'ホームの着地 / 予算は、着地と予算の両方がある計画だけで');
  // 分析の合計（apiCrossMaker）も同じ
  const xt = env.call('apiCrossMaker(__in)', { __in: {} }).totals;
  assert.equal(xt.plans, 2);
  near(xt.landing, a.landing, 1e-9, '分析の着地の合計も甲だけ');
  near(xt.ratioLanding, a.landing / 1200, 1e-9, '分析の着地 / 予算も甲だけ');
  // ホームにも同じ数を渡す
  const h = env.call('apiHome()').plans.filter((p) => p.planId === idA)[0];
  for (const key of ['landing', 'landingSd', 'landingP10', 'landingP90', 'pAbove', 'ratio', 'sky', 'skyReason', 'skyDir', 'theta', 'credibility', 'k', 'budgetUsed', 'budgetSource', 'p10', 'p90']) {
    assert.deepEqual(h[key], a[key], 'ホームの ' + key);
  }
  // 承認済みの公式版があれば、その最終予算で分ける
  env.run(`appInsertRows_('PLAN_VERSIONS', [{ version_id: 'VER-T1', plan_id: '${idA}', version_no: 1, state: 'APPROVED', budget_final: 900, submitted_by: '${OWNER}', row_version: 1 }])`);
  const a2 = plan(idA);
  assert.deepEqual([a2.budgetUsed, a2.budgetSource, a2.officialFinal, a2.budget, a2.sky], [900, 'official', 900, 1200, 'harenochi']);
  near(a2.ratio, 985.244 / 900, 1e-4, '公式版の予算で割る');
  // 直近 2 回の予測の年間 P50 が大きく違う（3 日前）→ 天変地異（前提の変化）
  const run = (id, p50, at) => ({ run_id: id, plan_id: idA, status: 'DONE', annual_p10: p50 * 0.8, annual_p50: p50, annual_p90: p50 * 1.2, finished_at: at, actor_email: OWNER });
  env.run(`appInsertRows_('FORECAST_RUNS', __r)`, { __r: [run('RUN-T1', 1200, '2026-09-01T12:00:00+0900'), run('RUN-T2', 1700, '2026-10-03T12:00:00+0900')] });
  const a3 = plan(idA);
  assert.deepEqual([a3.sky, a3.skyReason, a3.skyDir, a3.p50, a3.prevP50], ['tenpen', 'premise', 'up', 1700, 1200]);
  // 同じ日のうちは控えから（表を読まない）。日付が変わると読み直す（締まった月の遅れが 3 か月 → 霧）
  env.call('apiHome()');
  const r0 = STATS.reads;
  assert.equal(plan(idA).sky, 'tenpen');
  env.call('apiHome()');
  assert.equal(STATS.reads - r0, 0, '同じ日は控えから');
  env.run(`appToday_ = function () { return '2027-01-10'; }`);
  const a4 = plan(idA);
  assert.ok(STATS.reads > r0, '日付が変われば読み直す');
  assert.deepEqual([a4.sky, a4.skyReason], ['mikakunin', 'stale_actuals'], '今日の日付で空模様が変わる');
  assert.equal(env.call('apiHome()').plans.filter((p) => p.planId === idA)[0].sky, 'mikakunin', 'ホームの控えも日ごと');
}

// ==== 5. 全計画から学んだ τ・w（3 計画 × 締まった 6 か月。雪の計画は学びに入れない）は、所有者が承認して業務の設定に書くまで着地に使わない
//        （2026-10-08 判断 29・11。前は学べたらそのまま使っていた）。実績の空の締まった月（売上 0）も 0 円として数える ====
{
  const env = makeEnv();
  env.run(`appToday_ = function () { return '2026-10-06'; }`);
  env.as(OWNER);
  env.call('apiSetup()');
  const HC = J(env.run('APP_ENGINE_SHEETS.EVAL_COMPARE_MONTHLY.header'));
  const HS = J(env.run('APP_ENGINE_SHEETS.PROCESS_STATUS.header'));
  const output = [['FY2026 売上予測']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 1000, 1200, 1400]);
  output.push([], ['月', 'P10', 'P50', 'P90', '', '', '', '採用予測', '上乗せ']);
  yms.forEach((ym) => output.push([ym, 80, 100, 120, '', '', '', 100, '']));
  // 検証の表の行（実績が '' = ZAC に記録の無い月。旧来の B-2 は実績・誤差・幅の外の印を空にして、予測だけ書く）
  const cmpRow = (ym, act, p50) => { const o = { target_month: ym, actual_total: act, forecast_total_p10: 80, forecast_total_p50: p50, forecast_total_p90: 120,
    ape_p50: act === '' ? '' : Math.abs(p50 - act) / act, range_outside_flag: act === '' ? '' : act < 80 || act > 120 ? 1 : 0 }; return HC.map((h) => (o[h] === undefined ? '' : o[h])); };
  const book = (client, as) => env.makeBook(client, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    OUTPUT: { values: output },
    // 締まった 6 か月と、取り込んだ月の途中の実績（学びにも使わない）
    EVAL_COMPARE_MONTHLY: { values: [HC, ...as.map((x, i) => cmpRow(yms[i], x, 100)), cmpRow('2026/10', 5, 100)] },
    EVAL_LOG: evalLogSheet(env, as.map((x, i) => [yms[i], 100, x === '' ? 0 : x])),
    PROCESS_STATUS: { values: [HS, ['step2_status', new Date(2026, 9, 5, 10), 'owner', 'success', client, 10, ''], ['step5_status', new Date(2026, 9, 5, 11), 'owner', 'success', '', 6, '']] },
  });
  // 水準 0.8・1.2・1.0 で、月ごとに ±30 ぶれる（P10〜P90 の幅より大きい → w > 1）。丙の 8 月は売上 0（実績が空）
  const lv = { 甲: [50, 110, 50, 110, 50, 110], 乙: [90, 150, 90, 150, 90, 150], 丙: [70, 130, 70, 130, '', 130] };
  const ids = Object.fromEntries(Object.entries(lv).map(([k, as]) => [k, env.seedPlan(book(k + '製薬', as))]));
  // 丁は雪（締まった 6 か月の実績が全部空）。一覧には出すが、全計画の学び（τ・w）には入れない
  const snow = ['', '', '', '', '', ''];
  const idSnow = env.seedPlan(book('丁製薬', snow));
  const toPrior = (as) => as.map((x) => ({ f: 100, a: x === '' ? 0 : x, p10: 80, p90: 120 }));
  const prior = J(pure.run('appLandingPrior_(__in)', { __in: Object.values(lv).map(toPrior) }));
  assert.equal(prior.learned, true);
  assert.ok(Math.abs(prior.tau - 0.15) > 0.005 && prior.w > 1.5, JSON.stringify(prior));
  const withSnow = J(pure.run('appLandingPrior_(__in)', { __in: [...Object.values(lv), snow].map(toPrior) }));
  assert.deepEqual(withSnow, prior, '雪の丁を渡しても τ・w は同じ');
  let port = env.call('apiPortfolio()').plans;
  const inpOf = (as) => ({ fy: 2026, months: flat(80, 100, 120), actual: acts(as.map((x) => (x === '' ? 0 : x))), cutoffYm: '2026/10', todayYm: '2026/10', budget: 1200 });
  for (const [k, as] of Object.entries(lv)) {
    const p = port.find((x) => x.planId === ids[k]);
    const learned = sky(Object.assign({}, inpOf(as), { tau: prior.tau, w: prior.w }));
    const fixed = sky(inpOf(as));
    near(p.landing, fixed.landing, 1e-9, k + ' 承認するまでは τ=0.15・w=1 の着地');
    near(p.landingSd, fixed.landingSd, 1e-9, k + ' 承認するまでは τ=0.15・w=1 のばらつき');
    assert.ok(Math.abs(learned.landing - fixed.landing) > 10, `${k}: 学んだ τ・w の着地 ${learned.landing} は τ=0.15・w=1 の着地 ${fixed.landing} と違う（使っていないことが分かる）`);
  }
  // 学んだ値は、学びの画面に試しで出すだけ（学べた数と、今使っている値も）
  const shadow = env.call('apiAiLearning()').landing;
  near(shadow.learned.tau, prior.tau, 1e-12, '学んだ τ（試し）');
  near(shadow.learned.w, prior.w, 1e-12, '学んだ w（試し）');
  assert.deepEqual([shadow.learned.tauLearned, shadow.learned.planCount, shadow.used.tau, shadow.used.w, shadow.used.tauSet, shadow.used.wSet], [true, 3, 0.15, 1, false, false]);
  // 所有者が承認した値を業務の設定に書くと、その値を使う（管理者の役割だけの人は書けない）
  env.run(`appToday_ = function () { return '2026-10-06'; }`);
  env.props.OWNER_TASK = JSON.stringify({ action: 'saveSetting', key: 'landing.tau', value: prior.tau, note: '学んだ値を承認' });
  env.call('apiOwnerTask()');
  env.props.OWNER_TASK = JSON.stringify({ action: 'saveSetting', key: 'landing.w', value: prior.w });
  env.call('apiOwnerTask()');
  port = env.call('apiPortfolio()').plans;
  for (const [k, as] of Object.entries(lv)) {
    const p = port.find((x) => x.planId === ids[k]);
    const learned = sky(Object.assign({}, inpOf(as), { tau: prior.tau, w: prior.w }));
    near(p.landing, learned.landing, 1e-9, k + ' 書いた τ・w の着地');
    near(p.landingSd, learned.landingSd, 1e-9, k + ' 書いた τ・w のばらつき');
    near(p.reach.tau, prior.tau, 1e-12, k + ' 予算に届く見込みも同じ τ');
  }
  const used = env.call('apiAiLearning()').landing.used;
  assert.deepEqual([used.tauSet, used.wSet, used.tauFrom], [true, true, '2026-10-06']);
  // 売上 0 の締まった月があっても、予実の差（forecastYtd）は消えない（0 円と予測で比べる）
  const z = port.find((x) => x.planId === ids['丙']);
  assert.deepEqual([z.k, z.actualYtd, z.actualMonths, z.forecastYtd, z.rangeN], [6, 530, 6, 600, 5], '実績の空の月は 0 円・予測は数える（幅の外の印は空なので数えない）');
  assert.equal(env.call('apiHome()').plans.find((x) => x.planId === ids['丙']).forecastYtd, 600, 'ホームにも渡す');
  // 雪の丁: 空模様は雪。上の 3 計画の着地は、丁を除いて学んだ τ・w のまま（丁を入れて学ぶと τ が変わる）
  const s = port.find((x) => x.planId === idSnow);
  assert.deepEqual([s.sky, s.skyReason, s.k, s.actualYtd, s.forecastYtd], ['sekka', 'zero_sales', 6, 0, 600]);
  const cap = J(pure.run('APP_LANDING.TAU_MAX'));
  assert.ok(prior.tau < cap, `丁を入れずに学んだ τ ${prior.tau} は上限 ${cap} に張りつかない`);
}

// ==== 6. 予算の無い計画でも、実績の取り込みが遅れていれば着地の数字を出さない（ホームの合計に入れない） ====
{
  const env = makeEnv();
  env.run(`appToday_ = function () { return '2026-10-06'; }`);
  env.as(OWNER);
  env.call('apiSetup()');
  const HC = J(env.run('APP_ENGINE_SHEETS.EVAL_COMPARE_MONTHLY.header'));
  const HS = J(env.run('APP_ENGINE_SHEETS.PROCESS_STATUS.header'));
  const output = (adopted) => {
    const o = [['FY2026 売上予測']];
    for (let r = 2; r <= 25; r++) o.push([]);
    o.push(['年度合計（予測）', 1000, 1200, 1400]);
    o.push([], ['月', 'P10', 'P50', 'P90', '', '', '', '採用予測', '上乗せ']);
    yms.forEach((ym) => o.push([ym, 80, 100, 120, '', '', '', adopted, '']));
    return o;
  };
  const cmpRow = (ym, act) => { const o = { target_month: ym, actual_total: act, forecast_total_p10: 80, forecast_total_p50: 100, forecast_total_p90: 120,
    ape_p50: Math.abs(100 - act) / act, range_outside_flag: act < 80 || act > 120 ? 1 : 0 }; return HC.map((h) => (o[h] === undefined ? '' : o[h])); };
  // b2: B-2 の時刻（B-1 より前なら、締まった月を数えない = 実績の取り込みが遅れている）。adopted: 採用予測（空なら予算が無い）
  const book = (client, adopted, b2) => env.makeBook(client, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    OUTPUT: { values: output(adopted) },
    EVAL_COMPARE_MONTHLY: { values: [HC, ...yms.slice(0, 6).map((ym) => cmpRow(ym, 30))] },
    EVAL_LOG: evalLogSheet(env, yms.slice(0, 6).map((ym) => [ym, 100, 30])),
    PROCESS_STATUS: { values: [HS, ['step2_status', new Date(2026, 9, 5, 10), 'owner', 'success', client, 10, ''], ['step5_status', b2, 'owner', 'success', '', 6, '']] },
  });
  const fresh = new Date(2026, 9, 5, 11), old = new Date(2026, 8, 5, 11);
  const id = { 甲: env.seedPlan(book('甲製薬', 100, fresh)), 丙: env.seedPlan(book('丙製薬', '', old)), 丁: env.seedPlan(book('丁製薬', '', fresh)) };
  const port = Object.fromEntries(Object.entries(id).map(([k, v]) => [k, env.call('apiPortfolio()').plans.find((p) => p.planId === v)]));
  const nums = (p) => [p.landing, p.landingSd, p.landingP10, p.landingP90, p.pAbove, p.ratio, p.theta, p.credibility];
  // 丙: 予算が無い（霧）+ B-2 が B-1 より古い（締まった月 0・今日までに締まった 6 か月）→ 着地の数字は出さない
  assert.deepEqual([port.丙.budgetUsed, port.丙.sky, port.丙.skyReason, port.丙.k], [null, 'mikakunin', 'no_budget', 0]);
  assert.deepEqual(nums(port.丙), [null, null, null, null, null, null, null, null], '予算が無くても、遅れていれば着地の数字を出さない');
  // 丁: 予算が無い（霧）だが実績は取り込めている → 着地の数字は出す（着地 ÷ 予算と確率は出さない）
  assert.deepEqual([port.丁.sky, port.丁.skyReason, port.丁.k, port.丁.ratio, port.丁.pAbove], ['mikakunin', 'no_budget', 6, null, null]);
  assert.ok(typeof port.丁.landing === 'number' && port.丁.landing < 1200, '丁の着地: ' + port.丁.landing);
  assert.equal(port.甲.skyReason, 'ratio');
  // ホームの合計: 着地は甲と丁だけ（丙は入れない）。着地 ÷ 予算は予算もある甲だけ
  const ht = env.call('apiHome()').totals;
  assert.deepEqual([ht.plans, ht.budget, ht.budgetPlans, ht.actualYtd, ht.landingPlans, ht.ratioPlans], [3, 1200, 1, 360, 2, 1], JSON.stringify(ht));
  near(ht.landing, port.甲.landing + port.丁.landing, 1e-9, 'ホームの着地の合計に丙を入れない');
  near(ht.ratio, port.甲.landing / 1200, 1e-9, 'ホームの着地 / 予算は甲だけ');
}

// ==== 7. 締まった月は B-1 の日で決まる（2026-10-07 D5）: 月末から 3 日目の取り込みでは前の月は途中、6 日目なら締まる。外れ幅も締まった月だけ（D4） ====
{
  const env = makeEnv();
  env.run(`appToday_ = function () { return '2026-10-06'; }`);
  env.as(OWNER);
  env.call('apiSetup()');
  const HC = J(env.run('APP_ENGINE_SHEETS.EVAL_COMPARE_MONTHLY.header'));
  const HS = J(env.run('APP_ENGINE_SHEETS.PROCESS_STATUS.header'));
  const output = [['FY2026 売上予測']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 1000, 1200, 1400]);
  output.push([], ['月', 'P10', 'P50', 'P90', '', '', '', '採用予測', '上乗せ']);
  yms.forEach((ym) => output.push([ym, 80, 100, 120, '', '', '', 100, '']));
  const cmpRow = (ym, act) => { const o = { target_month: ym, actual_total: act, forecast_total_p10: 80, forecast_total_p50: 100, forecast_total_p90: 120,
    ape_p50: Math.abs(100 - act) / act, range_outside_flag: act < 80 || act > 120 ? 1 : 0 }; return HC.map((h) => (o[h] === undefined ? '' : o[h])); };
  // 4〜8 月は 80。9 月は sep（10/03 の取り込みでは途中の 30、10/06 なら 80）。10 月は途中の 5
  const book = (client, sep, b1) => env.makeBook(client, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    OUTPUT: { values: output },
    EVAL_COMPARE_MONTHLY: { values: [HC, ...yms.slice(0, 5).map((ym) => cmpRow(ym, 80)), cmpRow('2026/09', sep), cmpRow('2026/10', 5)] },
    // 今の版の B-2 は締まった月だけを測る（10/03 の取り込みなら 4〜8 月、10/06 なら 4〜9 月）
    EVAL_LOG: evalLogSheet(env, yms.slice(0, b1.getDate() >= 5 ? 6 : 5).map((ym) => [ym, 100, 80])),
    PROCESS_STATUS: { values: [HS, ['step2_status', b1, 'owner', 'success', client, 10, ''], ['step5_status', new Date(b1.getTime() + 3600e3), 'owner', 'success', '', 6, '']] },
  });
  const d3 = env.seedPlan(book('三日製薬', 30, new Date(2026, 9, 3, 10)));
  const d6 = env.seedPlan(book('六日製薬', 80, new Date(2026, 9, 6, 10)));
  const port = () => Object.fromEntries(env.call('apiPortfolio()').plans.map((p) => [p.planId, p]));
  const p = port();
  assert.deepEqual([p[d3].k, p[d3].actualMonths, p[d3].actualYtd, p[d3].forecastYtd, p[d3].rangeN, p[d3].mapeMonths], [5, 5, 400, 500, 5, 5], '10/03 の取り込み: 9 月は途中（数えない）');
  assert.deepEqual([p[d6].k, p[d6].actualMonths, p[d6].actualYtd, p[d6].forecastYtd, p[d6].rangeN, p[d6].mapeMonths], [6, 6, 480, 600, 6, 6], '10/06 の取り込み: 9 月は締まった');
  near(p[d3].mape, 0.25, 1e-12, '外れ幅は締まった月だけ（9 月の途中の 30・10 月の途中の 5 は入れない）');
  near(p[d6].mape, 0.25, 1e-12, '外れ幅は締まった月だけ（10 月の途中の 5 は入れない）');
  // 着地は、同じ締まった月を渡した計算だけの関数と同じ（τ・w は 2 計画では学ばない）
  near(p[d3].landing, sky({ actual: acts([80, 80, 80, 80, 80]), cutoffYm: '2026/09', todayYm: '2026/10' }).landing, 1e-9, '三日製薬の着地');
  near(p[d6].landing, sky({ actual: acts([80, 80, 80, 80, 80, 80]), cutoffYm: '2026/10', todayYm: '2026/10' }).landing, 1e-9, '六日製薬の着地');
  assert.deepEqual([p[d3].sky, p[d6].sky], ['kumori', 'kumori']);
  const ht = env.call('apiHome()').totals;
  assert.deepEqual([ht.actualYtd, ht.landingPlans], [880, 2]);
  near(ht.landing, p[d3].landing + p[d6].landing, 1e-9, 'ホームの着地の合計');
  // 霧（実績の遅れ）も同じ決まりで数える: 今日までに締まっているはずの月は、月末から 5 日たった月まで
  // （12/03 は 4〜10 月の 7 か月。10/03 の取り込みで締まった 5 か月との差は 2 → 霧にしない。12/05 なら 11 月も入り差が 3 → 霧）
  env.run(`appToday_ = function () { return '2026-12-03'; }`);
  assert.equal(port()[d3].skyReason, 'ratio', '12/03: 遅れは 2 か月');
  env.run(`appToday_ = function () { return '2026-12-05'; }`);
  assert.equal(port()[d3].skyReason, 'stale_actuals', '12/05: 遅れは 3 か月');
}

// ==== 8. 検証の表の予測は、今の決まり（D4〜D6）で B-2 が書き直した計画だけで使う（外れ幅・予実の差・幅の外・着地の τ・w の学び）。実績はそのまま ====
// 旧: 前の版の EVAL_LOG だけ（検証の表は月が始まった後の予測のまま）。新: 7〜9 月だけ今の版。甲・乙・丙: 6 か月とも今の版
{
  const env = makeEnv();
  env.run(`appToday_ = function () { return '2026-10-06'; }`);
  env.as(OWNER);
  env.call('apiSetup()');
  const HC = J(env.run('APP_ENGINE_SHEETS.EVAL_COMPARE_MONTHLY.header'));
  const HS = J(env.run('APP_ENGINE_SHEETS.PROCESS_STATUS.header'));
  const HE = J(env.run('APP_ENGINE_SHEETS.EVAL_LOG.header'));
  const output = [['FY2026 売上予測']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 1000, 1200, 1400]);
  output.push([], ['月', 'P10', 'P50', 'P90', '', '', '', '採用予測', '上乗せ']);
  yms.forEach((ym) => output.push([ym, 80, 100, 120, '', '', '', 100, '']));
  const cmpRow = (ym, act) => { const o = { target_month: ym, actual_total: act, forecast_total_p10: 80, forecast_total_p50: 100, forecast_total_p90: 120,
    ape_p50: Math.abs(100 - act) / act, range_outside_flag: act < 80 || act > 120 ? 1 : 0 }; return HC.map((h) => (o[h] === undefined ? '' : o[h])); };
  const evalRow = (ym, act, policy) => { const o = { eval_id: 'E-' + ym, evaluated_at: new Date(2026, 9, 5, 11), client: 'x', target_month: ym, scenario: 'neutral', pred: 100, actual: act,
    evaluation_policy_version: policy, constraint_relevant_flag: 1 }; return HE.map((h) => (o[h] === undefined ? '' : o[h])); };
  // as: 締まった 4〜9 月の実績。v3: 今の版で測った月（ほかの月は前の版の行）
  const book = (client, as, v3) => env.makeBook(client, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    OUTPUT: { values: output },
    EVAL_COMPARE_MONTHLY: { values: [HC, ...as.map((x, i) => cmpRow(yms[i], x)), cmpRow('2026/10', 5)] },
    EVAL_LOG: { values: [HE, ...as.map((x, i) => evalRow(yms[i], x, v3.includes(yms[i]) ? 'policy-2026H1-v3' : 'policy-2026H1-v2'))], formats: { D: '@' } },
    PROCESS_STATUS: { values: [HS, ['step2_status', new Date(2026, 9, 5, 10), 'owner', 'success', client, 10, ''], ['step5_status', new Date(2026, 9, 5, 11), 'owner', 'success', '', 6, '']] },
  });
  const all6 = yms.slice(0, 6);
  const lv = { 甲: [50, 110, 50, 110, 50, 110], 乙: [90, 150, 90, 150, 90, 150], 丙: [70, 130, 70, 130, 70, 130] };
  const ids = Object.fromEntries(Object.entries(lv).map(([k, as]) => [k, env.seedPlan(book(k + '製薬', as, all6))]));
  const oldAs = [300, 300, 300, 300, 300, 300];   // 前の版の表では水準 3 倍（学びに入れると τ が上限に張りつく）
  ids.旧 = env.seedPlan(book('旧製薬', oldAs, []));
  const newAs = [50, 50, 50, 80, 80, 80];        // 4〜6 月（前の版の行）の外れは 100%、7〜9 月（今の版）は 25%
  ids.新 = env.seedPlan(book('新製薬', newAs, ['2026/07', '2026/08', '2026/09']));
  const port = Object.fromEntries(env.call('apiPortfolio()').plans.map((p) => [p.planId, p]));
  const acc = (id) => env.call('apiLearningView(__in)', { __in: { planId: id } }).accuracy;
  const cross = Object.fromEntries(env.call('apiCrossMaker(__in)', { __in: { fy: 2026 } }).plans.map((p) => [p.planId, p]));
  const home = Object.fromEntries(env.call('apiHome()').plans.map((p) => [p.planId, p]));

  // (a) 前の版だけの計画: 外れ幅・予実の差・幅の外は出さない。暫定実績と着地（実績から）はそのまま
  const o = port[ids.旧];
  assert.deepEqual([o.mape, o.mapeMonths, o.forecastYtd, o.rangeN, o.rangeOut], [null, 0, null, 0, 0], '前の版の検証の表の予測は使わない');
  assert.deepEqual([o.actualYtd, o.actualMonths, o.k], [1800, 6, 6], '暫定実績は締まった 6 か月の実績のまま');
  assert.ok(typeof o.landing === 'number' && o.landing > 1800, '着地は実績から出す: ' + o.landing);
  const ao = acc(ids.旧);
  assert.deepEqual([ao.n, ao.mape], [0, null], '検証の画面の精度も無い');
  assert.deepEqual([home[ids.旧].mape, home[ids.旧].mapeMonths, home[ids.旧].forecastYtd, home[ids.旧].rangeN], [null, 0, null, 0], 'ホームも同じ');
  assert.deepEqual([cross[ids.旧].mape, cross[ids.旧].mapeMonths, cross[ids.旧].accuracy.n, cross[ids.旧].accuracy.mape], [null, 0, 0, null], '分析も同じ');

  // (b) 7〜9 月だけ今の版の計画: 外れ幅は 7〜9 月だけの平均（= 精度）。予測と幅の外の印は計画ごと（書き直した表）なので 6 か月とも使う
  const n = port[ids.新];
  const an = acc(ids.新);
  assert.equal(n.mapeMonths, 3, '今の版で測った 3 か月');
  near(n.mape, 0.25, 1e-12, '外れ幅は 7〜9 月の平均（4〜6 月の 100% は入れない）');
  assert.deepEqual([an.n, an.months.map((m) => m.month)], [3, ['2026/07', '2026/08', '2026/09']]);
  near(n.mape, an.mape, 1e-12, '計画の一覧の外れ幅 = 検証の画面の精度');
  near(home[ids.新].mape, an.mape, 1e-12, 'ホームの外れ幅も同じ');
  near(cross[ids.新].mape, cross[ids.新].accuracy.mape, 1e-12, '分析の外れ幅と精度も同じ');
  assert.deepEqual([n.forecastYtd, n.rangeN, n.actualYtd], [600, 6, 390]);
  for (const k of ['甲', '乙', '丙']) {
    const p = port[ids[k]];
    near(p.mape, acc(ids[k]).mape, 1e-12, k + ': 全部の月が今の版なら、外れ幅 = 精度');
    assert.equal(p.mapeMonths, 6);
  }

  // (c) 着地の τ・w の学び（試し）は、今の版の計画（甲・乙・丙・新）だけから（旧を入れると τ が変わる）。着地には、承認するまで使わない（判断 29）
  const toPrior = (as) => as.map((x) => ({ f: 100, a: x, p10: 80, p90: 120 }));
  const prior = J(pure.run('appLandingPrior_(__in)', { __in: [lv.甲, lv.乙, lv.丙, newAs].map(toPrior) }));
  const withOld = J(pure.run('appLandingPrior_(__in)', { __in: [lv.甲, lv.乙, lv.丙, newAs, oldAs].map(toPrior) }));
  assert.equal(prior.learned, true);
  assert.ok(Math.abs(prior.tau - withOld.tau) > 0.01, `旧を入れると τ が変わる（${prior.tau} / ${withOld.tau}）`);
  const shadow = env.call('apiAiLearning()').landing.learned;
  near(shadow.tau, prior.tau, 1e-12, '試しの τ は旧を除いて学ぶ');
  near(shadow.w, prior.w, 1e-12, '試しの w も同じ');
  for (const [k, as] of Object.entries(Object.assign({}, lv, { 新: newAs, 旧: oldAs }))) {
    const want = sky({ actual: acts(as), cutoffYm: '2026/10', todayYm: '2026/10', budget: 1200 });
    near(port[ids[k]].landing, want.landing, 1e-9, k + ': 承認するまでは τ=0.15・w=1 の着地');
    near(port[ids[k]].landingSd, want.landingSd, 1e-9, k + ': ばらつき');
  }
}

// ==== 仮の着地（seedDummyLanding）: 実績の遅れで消えていた着地を、仮実績と B-1/B-2 で出す ====
{
  const env = makeEnv();
  env.run(`appToday_ = function () { return '2026-10-21'; }`);
  env.as(OWNER);
  env.call('apiSetup()');
  const output = [['FY2026 売上予測']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 1000, 1200, 1400]);
  output.push([], ['月', 'P10', 'P50', 'P90', '', '', '', '採用予測', '上乗せ']);
  yms.forEach((ym) => output.push([ym, 80, 100, 120, '', '', '', 100, '']));
  const book = env.makeBook('着地欠け', {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', '着地欠け'], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    OUTPUT: { values: output, formats: { A: '@' } },
  });
  const id = env.seedPlan(book);
  const before = env.call('apiPortfolio()').plans.filter((p) => p.planId === id)[0];
  assert.equal(before.landing, null, 'B-1/B-2 が無ければ着地は出ない');
  assert.equal(before.skyReason, 'stale_actuals');
  env.props.OWNER_TASK = JSON.stringify({ action: 'seedDummyLanding', fy: 2026 });
  const seed = env.call('apiOwnerTask()');
  assert.equal(seed.ok, true, JSON.stringify(seed));
  assert.ok((seed.result.filled || []).some((x) => x.planId === id && (x.did || []).includes('landing')), JSON.stringify(seed.result));
  const after = env.call('apiPortfolio()').plans.filter((p) => p.planId === id)[0];
  assert.ok(typeof after.landing === 'number' && after.landing > 0, '仮実績のあと着地が出る');
  assert.notEqual(after.sky, 'mikakunin', '未算定のままにしない: ' + after.sky + '/' + after.skyReason);
  assert.equal(after.k, 6, '10/21 なら締まった月は 6');
}

console.log('app-landing: all tests passed');
