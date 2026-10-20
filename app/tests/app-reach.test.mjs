#!/usr/bin/env node
/**
 * app-reach.test.mjs — 2026-10-08 村井さん承認（判断 10・11・24・25・29）の、着地見込みの τ・w の承認と、試しの数。
 *   1. 着地の分布（appLandingDist_）を年度の見込みの試し（appLandingAligned_）・予算に届く見込み（appLandingReach_・appLandingReachTotal_）が共有する
 *   2. 締まった月が無ければ、試しの中心 = 月の P50 の合計、その予算以上の確率 = 締まった月 0 の着地見込みの確率（予算の確率と同じ値）
 *   3. 届く金額（50〜80%）・5% 刻み・公式版と今の予算・先の年度（実績なし）・実績の遅れ（出さない）
 *   4. τ・w は業務の設定（所有者だけが書ける・範囲は APP_LANDING と同じ）に書くまで、学んだ値を使わない。書いた値・効き始める日
 *   5. 計画の一覧の scoredMonths（今の決まりで B-2 が測った締まった月の数。実績 0 円の月も数える）
 *   6. 画面: 予測の中心の下に試しの中心、予算のカードに届く見込み、ホームの年間予算の説明に合計の届く見込み、学びに学んだ値（試し）
 *   3b・7. 締まった月がある計画の試しの年度は中心だけ（aligned.k・幅は着地見込みの方）。12 か月を数えた計画だけ done（年度を締めても 12 か月に足りなければ見込み）
 *      （aligned.done・reach.done と reach.actual = 実績の合計。届く金額は出さない）。締まった月 0 は今までどおり（2026-10-08 F3）
 * モックの上の確かめで、本物の Apps Script・ブラウザの上では動かしていない。
 *
 *   node app/tests/app-reach.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { OWNER, MEMBER, makeEnv, J, uiHtml } from './gas-mock.mjs';

const near = (a, b, tol, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) <= tol, `${msg || ''}: ${a} と ${b}`);
const fyYms = (fy) => Array.from({ length: 12 }, (_, i) => { const m = 4 + i; return (m > 12 ? fy + 1 : fy) + '/' + String(m > 12 ? m - 12 : m).padStart(2, '0'); });
const yms = fyYms(2026);
const acts = (v) => Object.fromEntries(v.map((x, i) => [yms[i], x]));
const pure = makeEnv();
const run = (code, vars) => J(pure.run(code, vars));
const Z80 = pure.run('APP_LANDING.Z80');
// 月ごとに違う予測（P50 の合計 1,212。幅も月ごとに違う）
const months = yms.map((ym, i) => ({ ym, p10: 70 + i, p50: 90 + 2 * i, p90: 120 + 3 * i }));
const F = months.reduce((s, m) => s + m.p50, 0);

// ==== 1・2. 年度の見込みの試し: 中心 = 月の P50 の合計・幅は締まった月 0 の着地見込みと同じ ====
{
  for (const [tau, w] of [[0.15, 1], [0.25, 1.6]]) {
    const al = run('appLandingAligned_(2026, __m, __t, __w, 1300)', { __m: months, __t: tau, __w: w });
    near(al.center, F, 1e-9, '中心は月の P50 の合計');
    // 幅: sd² = (ΣP50)²・τ² + Σ(w・max((P90 − P10) / 2.5631, 0.05・F / 12))²
    const floor = 0.05 * F / 12;
    const sd = Math.sqrt(F * F * tau * tau + months.reduce((s, m) => s + Math.pow(w * Math.max((m.p90 - m.p10) / (2 * Z80), floor), 2), 0));
    near(al.sd, sd, 1e-9, 'ばらつき');
    near(al.p10, Math.max(0, F - Z80 * sd), 1e-9, '80% の幅の下');
    near(al.p90, F + Z80 * sd, 1e-9, '80% の幅の上');
    assert.deepEqual([al.tau, al.w, al.budget], [tau, w, 1300]);
    // 締まった月 0 の着地見込み（年度の始め・先の年度）と同じ分布・同じ確率（予算の確率と、締まった月 0 の着地見込みの確率が同じ値）
    const sky = run('appLandingSky_(__in)', { __in: { fy: 2026, months, actual: {}, cutoffYm: '2026/04', budget: 1300, tau, w } });
    assert.equal(sky.k, 0);
    near(al.center, sky.landing, 1e-9, '着地見込みの中心と同じ');
    near(al.sd, sky.landingSd, 1e-9, '着地見込みのばらつきと同じ');
    near(al.pAbove, sky.pAbove, 1e-12, '予算以上の確率も同じ');
    const rc = run('appLandingReach_(__s, { draft: 1300 }, { tau: __t, w: __w })', { __s: sky, __t: tau, __w: w });
    near(rc.draft.p, al.pAbove, 1e-12, '予算に届く見込みも同じ値');
  }
  assert.equal(run('appLandingAligned_(2026, __m, 0.15, 1, 1300)', { __m: months.slice(0, 11) }), null, '予測が 12 か月そろわなければ出さない');
  assert.equal(run('appLandingAligned_(2026, __m, 0.15, 1, null)', { __m: months }).pAbove, null, '予算が無ければ確率は出さない');
  assert.equal(run('appLandingAligned_(2026, __m, 0.15, 1, 0)', { __m: months }).pAbove, null, '予算 0 も出さない');
}

// ==== 3. 予算に届く見込み（届く金額・5% 刻み・公式版・実績の遅れ）と、全部のメーカーの合計 ====
{
  const sky = run('appLandingSky_(__in)', { __in: { fy: 2026, months, actual: acts([80, 85, 90, 95, 100, 105]), cutoffYm: '2026/10', todayYm: '2026/10', budget: 1250 } });
  assert.equal(sky.k, 6);
  const rc = run('appLandingReach_(__s, { draft: 1250, official: 1100, officialNo: 3 }, { tau: 0.15, w: 1, tauSet: false, wSet: false })', { __s: sky });
  near(rc.center, sky.landing, 1e-12); near(rc.sd, sky.landingSd, 1e-12);
  assert.deepEqual([rc.k, rc.actualYtd, rc.tau, rc.w, rc.tauSet, rc.wSet, rc.p10, rc.p90], [6, 555, 0.15, 1, false, false, sky.landingP10, sky.landingP90]);
  near(rc.draft.p, sky.pAbove, 1e-12, '今の予算の確率 = 着地見込みの確率（同じ予算）');
  assert.equal(rc.draft.pct, Math.round(rc.draft.p * 20) * 5, '5% 刻み');
  assert.deepEqual([rc.official.budget, rc.official.versionNo], [1100, 3]);
  assert.ok(rc.official.p > rc.draft.p, '低い予算ほど届きやすい');
  // 届く金額: その確率で届く（着地 − z・ばらつき）。90% 以上は出さない
  assert.deepEqual(rc.amounts.map((a) => a.pct), [50, 60, 70, 80]);
  for (const a of rc.amounts) near(pure.run(`appNormCdf_(${(rc.center - a.amount) / rc.sd})`), a.pct / 100, 1e-6, a.pct + '% で届く金額');
  near(rc.amounts[0].amount, rc.center, 1e-9, '50% は中心');
  assert.ok(rc.amounts.every((a, i) => i === 0 || a.amount < rc.amounts[i - 1].amount), '確率が高いほど金額は低い');
  // 届く金額は締まった月の実績の合計より下にしない（80% の幅の下と同じ）
  const late = run('appLandingSky_(__in)', { __in: { fy: 2026, months, actual: acts([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]), cutoffYm: '2027/03', todayYm: '2027/03', budget: 1250, w: 3 } });
  const rl = run('appLandingReach_(__s, { draft: 1250 }, null)', { __s: late });
  assert.ok(rl.amounts.every((a) => a.amount >= 1100), JSON.stringify(rl.amounts));
  // 5% 刻み（0 = 5% 未満・100 = 95% 超）
  assert.deepEqual([0.374, 0.375, 0.024, 0.025, 0.976, 0.5, 1, 0].map((p) => pure.run(`appLandingPct5_(${p})`)), [35, 40, 0, 5, 100, 50, 100, 0]);
  assert.equal(pure.run('appLandingPct5_(NaN)'), null);
  // 予算が無い・0 は出さない。着地見込みが無い（実績の遅れ・予測が無い）ときは全部出さない
  const nob = run('appLandingReach_(__s, { draft: null, official: 0 }, null)', { __s: sky });
  assert.deepEqual([nob.draft, nob.official, nob.amounts.length], [null, null, 4], '予算が無くても届く金額は出す');
  const stale = run('appLandingSky_(__in)', { __in: { fy: 2026, months, actual: acts([100]), cutoffYm: '2026/05', todayYm: '2026/10', budget: 1250 } });
  assert.equal(stale.skyReason, 'stale_actuals');
  assert.equal(run('appLandingReach_(__s, { draft: 1250 }, null)', { __s: stale }), null, '実績の遅れは出さない');
  assert.equal(run('appLandingReach_(null, { draft: 1250 }, null)'), null);
  // 12 か月締まった年度: ばらつき 0 → 届くか届かないか
  const done = run('appLandingSky_(__in)', { __in: { fy: 2026, months: [], actual: acts(Array(12).fill(100)), cutoffYm: '2027/04', budget: 1200 } });
  const rd = run('appLandingReach_(__s, { draft: 1200, official: 1201 }, null)', { __s: done });
  assert.deepEqual([rd.draft.p, rd.draft.pct, rd.official.p, rd.official.pct], [1, 100, 0, 0]);
  // 全部のメーカーの合計: 独立（√Σsd²）と、全部同じ向き（Σsd）
  const tot = run('appLandingReachTotal_(__r)', { __r: [{ landing: 1000, sd: 100, budget: 900 }, { landing: 1000, sd: 100, budget: 900 }, { landing: 500, sd: 50, budget: null }] });
  assert.deepEqual([tot.plans, tot.budget, tot.landing], [2, 1800, 2000], '予算の無い計画は入れない');
  near(tot.independent.p, pure.run('appNormCdf_(200 / Math.sqrt(20000))'), 1e-12, '独立');
  near(tot.together.p, pure.run('appNormCdf_(1)'), 1e-12, '全部同じ向き');
  assert.ok(tot.independent.p > tot.together.p, '着地が予算より上なら、独立の方が届きやすい');
  const low = run('appLandingReachTotal_(__r)', { __r: [{ landing: 800, sd: 100, budget: 900 }, { landing: 800, sd: 100, budget: 900 }] });
  assert.ok(low.independent.p < low.together.p, '着地が予算より下なら、全部同じ向きの方が届きやすい');
  assert.deepEqual([low.independent.pct, low.together.pct], [Math.round(low.independent.p * 20) * 5, Math.round(low.together.p * 20) * 5]);
  assert.equal(run('appLandingReachTotal_([])'), null);
  const flat0 = run('appLandingReachTotal_(__r)', { __r: [{ landing: 1000, sd: 0, budget: 900 }] });
  assert.deepEqual([flat0.independent.p, flat0.together.p], [1, 1], 'ばらつき 0 なら届くか届かないか');
}

// ==== 3b. 締まった月がある・年度が終わった（2026-10-08 F3）: 試しの年度は中心だけ。年度が終わった計画の届く見込みは、届いた／届かなかった ====
{
  // 締まった月 0（先の年度・年度の始め）は今までどおり幅つき（k と done を足しただけ）
  const a0 = run('appLandingAligned_(2026, __m, 0.15, 1, 1300)', { __m: months });
  const a0k = run('appLandingAligned_(2026, __m, 0.15, 1, 1300, { k: 0, frozen: false })', { __m: months });
  assert.deepEqual(a0k, a0, 'k = 0 を渡しても同じ');
  assert.deepEqual([a0.k, a0.done], [0, false]);
  assert.ok([a0.sd, a0.p10, a0.p90, a0.pAbove].every((x) => typeof x === 'number'), '締まった月 0 は幅と確率を出す');
  // 締まった月がある: 中心は月の P50 の合計のまま、幅（sd・p10・p90）と確率は出さない（年度の途中の幅は着地見込みの方）
  const a6 = run('appLandingAligned_(2026, __m, 0.15, 1, 1300, { k: 6 })', { __m: months });
  assert.deepEqual([a6.k, a6.done, a6.sd, a6.p10, a6.p90, a6.pAbove, a6.budget, a6.tau, a6.w], [6, false, null, null, null, null, 1300, 0.15, 1]);
  near(a6.center, a0.center, 1e-12, '中心は同じ');
  // 12 か月締まった: done（幅も出さない）
  const a12 = run('appLandingAligned_(2026, __m, 0.15, 1, 1300, { k: 12 })', { __m: months });
  assert.deepEqual([a12.k, a12.done, a12.p10, a12.p90], [12, true, null, null]);
  // 年度を締めても、数えた月が 12 に足りなければ done ではない（終わったと言い切らない。2026-10-08 点検）
  const af = run('appLandingAligned_(2026, __m, 0.15, 1, 1300, { k: 3, frozen: true })', { __m: months });
  assert.deepEqual([af.k, af.done, af.p10, af.p90], [3, false, null, null], '締めた年度でも 12 か月に足りなければ done ではない');
  // 締まった月を数え直している間（当たり具合の計算待ち・実績の遅れ）: 締まった月 0 に戻っても幅を出さない
  const ap = run('appLandingAligned_(2026, __m, 0.15, 1, 1300, { k: 0, pending: true })', { __m: months });
  assert.deepEqual([ap.k, ap.done, ap.pending, ap.sd, ap.p10, ap.p90, ap.pAbove], [0, false, true, null, null, null, null]);
  near(ap.center, a0.center, 1e-12, '中心は同じ');
  // 届く見込み: 12 か月締まった年度は done・actual = 実績の合計・届く金額なし・予算ごとに届いたか
  const done = run('appLandingSky_(__in)', { __in: { fy: 2026, months, actual: acts(Array(12).fill(100)), cutoffYm: '2027/04', todayYm: '2027/04', budget: 1150 } });
  const rd = run('appLandingReach_(__s, { draft: 1150, official: 1250, officialNo: 2 }, null)', { __s: done });
  assert.deepEqual([rd.done, rd.actual, rd.amounts, rd.k], [true, 1200, [], 12]);
  assert.deepEqual([rd.draft.reached, rd.draft.p, rd.draft.pct, rd.official.reached, rd.official.p, rd.official.versionNo], [true, 1, 100, false, 0, 2], '届いた／届かなかった');
  // 年度を締めた計画でも、締まった月が 12 か月に届かなければ done ではない（一部の実績で届いた・届かなかったと言い切らない）
  const mid = run('appLandingSky_(__in)', { __in: { fy: 2026, months, actual: acts([80, 85, 90, 95, 100, 105]), cutoffYm: '2026/10', todayYm: '2026/10', budget: 1250 } });
  const rf = run('appLandingReach_(__s, { draft: 1250 }, null, { frozen: true })', { __s: mid });
  assert.deepEqual([rf.done, rf.actual, rf.amounts.length, 'reached' in rf.draft], [false, null, 4, false]);
  // 年度の途中（締めていない）: 今までどおり（done = false・actual = null・届く金額 4 つ・reached なし）
  const rm = run('appLandingReach_(__s, { draft: 1250 }, null)', { __s: mid });
  assert.deepEqual([rm.done, rm.actual, rm.amounts.length, 'reached' in rm.draft], [false, null, 4, false]);
  const rm2 = run('appLandingReach_(__s, { draft: 1250 }, null, { frozen: false })', { __s: mid });
  assert.deepEqual(rm2, rm, 'frozen: false は省いたのと同じ');
}

// ==== 4〜5. 計画の一覧を通して: τ・w の承認（所有者だけ・範囲・効き始める日）・試しの数・scoredMonths・画面 ====
const env = makeEnv();
env.run(`appToday_ = function () { return '2026-10-06'; }`);
env.as(OWNER);
env.call('apiSetup()');
const HC = J(env.run('APP_ENGINE_SHEETS.EVAL_COMPARE_MONTHLY.header'));
const HS = J(env.run('APP_ENGINE_SHEETS.PROCESS_STATUS.header'));
const HE = J(env.run('APP_ENGINE_SHEETS.EVAL_LOG.header'));
/** OUTPUT: 26 行の年度合計（旧来の試行の値 = annual）と 29〜40 行の月（P10/P50/P90・採用予測・上乗せ） */
const output = (fy, annual, mm, adopted, uplift) => {
  const o = [['FY' + fy + ' 売上予測']];
  for (let r = 2; r <= 25; r++) o.push([]);
  o.push(['年度合計（予測）', ...annual]);
  o.push([], ['月', 'P10', 'P50', 'P90', '', '', '', '採用予測', '上乗せ']);
  fyYms(fy).forEach((ym, i) => o.push([ym, mm[i].p10, mm[i].p50, mm[i].p90, '', '', '', adopted[i], uplift[i]]));
  return o;
};
const cmpRow = (ym, act) => { const o = { target_month: ym, actual_total: act, forecast_total_p10: 80, forecast_total_p50: 100, forecast_total_p90: 120,
  ape_p50: act ? Math.abs(100 - act) / act : '', range_outside_flag: act < 80 || act > 120 ? 1 : 0 }; return HC.map((h) => (o[h] === undefined ? '' : o[h])); };
const evalRow = (ym, act, scenario = 'neutral', policy = 'policy-2026H1-v3') => { const o = { eval_id: 'E-' + ym + scenario, evaluated_at: new Date(2026, 9, 5, 12), client: 'x', target_month: ym, scenario,
  pred: 100, actual: act, evaluation_policy_version: policy, constraint_relevant_flag: 1 }; return HE.map((h) => (o[h] === undefined ? '' : o[h])); };
const book = (client, fy, { annual = [1000, 1200, 1400], mm, adopted, uplift, cmp = [], evalRows = [] }) => env.makeBook(client, {
  CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
  OUTPUT: { values: output(fy, annual, mm, adopted, uplift) },
  EVAL_COMPARE_MONTHLY: { values: [HC, ...cmp] },
  EVAL_LOG: { values: [HE, ...evalRows], formats: { D: '@' } },
  PROCESS_STATUS: { values: [HS, ['step2_status', new Date(2026, 9, 5, 10), 'owner', 'success', client, 10, ''], ['step5_status', new Date(2026, 9, 5, 11), 'owner', 'success', '', 6, '']] },
});
const flatM = yms.map(() => ({ p10: 80, p50: 100, p90: 120 }));
// 今の年度の計画: 締まった 6 か月（4〜9 月）。8 月は売上 0 円（実績の行はある）。6 月は前の版の行だけ。10 月は締まっていない月の今の版の行。
// 年度合計（旧来の試行）は 1,150 で、月の P50 の合計 1,200 と違う
const curEval = [evalRow('2026/04', 90), evalRow('2026/04', 70, 'nega'), evalRow('2026/04', 110, 'posi'), evalRow('2026/05', 95), evalRow('2026/06', 100, 'neutral', 'policy-2026H1-v2'),
  evalRow('2026/07', 105), evalRow('2026/08', 0), evalRow('2026/09', 90), evalRow('2026/10', 5)];
const idCur = env.seedPlan(book('今年製薬', 2026, { annual: [1050, 1150, 1250], mm: flatM, adopted: Array(12).fill(100), uplift: [...Array(11).fill(''), 60],
  cmp: [cmpRow('2026/04', 90), cmpRow('2026/05', 95), cmpRow('2026/06', 100), cmpRow('2026/07', 105), cmpRow('2026/08', 0), cmpRow('2026/09', 90), cmpRow('2026/10', 5)], evalRows: curEval }));
// 先の年度の計画（締まった月が無い）: 月の P50 は月ごとに違う
const mm27 = fyYms(2027).map((ym, i) => ({ p10: 70 + i, p50: 90 + 2 * i, p90: 120 + 3 * i }));
const idNext = env.seedPlan(book('来年製薬', 2027, { annual: [1000, 1100, 1200], mm: mm27, adopted: mm27.map((m) => m.p50), uplift: Array(12).fill(10) }));
const port = () => Object.fromEntries(env.call('apiPortfolio()').plans.map((p) => [p.planId, p]));

// ---- 試しの数（判断 10・24）: 保存している数字は変えない ----
{
  const p = port();
  const nx = p[idNext], cu = p[idCur];
  const F27 = mm27.reduce((s, m) => s + m.p50, 0);
  // 先の年度: 締まった月 0 → 試しの中心 = 月の P50 の合計、確率は着地見込み・予算に届く見込みと同じ
  assert.deepEqual([nx.k, nx.budget, nx.budgetUsed, nx.p50], [0, F27 + 120, F27 + 120, 1100], '年度の P50（旧来の試行）はそのまま');
  near(nx.aligned.center, F27, 1e-9, '試しの中心 = 月の P50 の合計');
  near(nx.aligned.center, nx.landing, 1e-9, '締まった月 0 の着地見込みと同じ中心');
  near(nx.aligned.pAbove, nx.pAbove, 1e-12, '予算の確率と、締まった月 0 の着地見込みの確率が同じ値');
  near(nx.reach.draft.p, nx.pAbove, 1e-12, '予算に届く見込みも同じ値');
  assert.deepEqual([nx.reach.k, nx.reach.actualYtd, nx.reach.official, nx.reach.tau, nx.reach.w], [0, 0, null, 0.15, 1], '先の年度は実績を入れない');
  // 今の年度: 試しの中心は 1,200（年度合計の 1,150 は変えない）。届く見込みは締まった月の実績を入れた着地見込みの分布
  assert.deepEqual([cu.p50, cu.k, cu.actualYtd, cu.budget], [1150, 6, 480, 1260]);
  near(cu.aligned.center, 1200, 1e-9, '月の P50 の合計');
  near(cu.reach.center, cu.landing, 1e-12); near(cu.reach.sd, cu.landingSd, 1e-12);
  near(cu.reach.draft.p, cu.pAbove, 1e-12, '公式版が無ければ今の予算 = 空模様の予算');
  assert.equal(env.table('ENG_ROWS').filter((r) => r.sheet === 'OUTPUT' && Number(r.row_no) === 26).length, 2, 'OUTPUT の年度合計の行は消さない');
  // 承認済みの公式版があれば、空模様はその予算で、今の予算（下書き）の届く見込みも別に出す
  env.run(`appInsertRows_('PLAN_VERSIONS', [{ version_id: 'VER-R1', plan_id: '${idCur}', version_no: 2, state: 'APPROVED', budget_final: 900, submitted_by: '${OWNER}', row_version: 1 }])`);
  const c2 = port()[idCur];
  assert.deepEqual([c2.budgetUsed, c2.reach.official.budget, c2.reach.official.versionNo, c2.reach.draft.budget], [900, 900, 2, 1260]);
  near(c2.reach.official.p, c2.pAbove, 1e-12, '公式版の予算の確率 = 空模様の確率');
  // 締まった月がある（6 か月）: 試しの年度は中心だけ（幅・確率は着地見込みの方。2026-10-08 F3）。予算は公式版のもの
  assert.deepEqual([c2.aligned.k, c2.aligned.done, c2.aligned.sd, c2.aligned.p10, c2.aligned.p90, c2.aligned.pAbove, c2.aligned.budget], [6, false, null, null, null, null, 900]);
  near(c2.aligned.center, 1200, 1e-9, '中心は月の P50 の合計のまま');
  assert.deepEqual([c2.reach.done, c2.reach.actual, c2.reach.amounts.length, 'reached' in c2.reach.draft], [false, null, 4, false], '年度の途中は確率と届く金額');
  assert.deepEqual([nx.aligned.k, nx.aligned.done, port()[idNext].reach.done], [0, false, false], '先の年度（締まった月 0）は幅つき');
  // 予測の画面の応答にも足す（計画の一覧の控えから）
  const l = env.call('apiForecastLatest(__in)', { __in: { planId: idCur } });
  assert.deepEqual([l.shadow.planId, l.shadow.scoredMonths], [idCur, c2.scoredMonths]);
  assert.deepEqual(l.shadow.reach, c2.reach);
  assert.deepEqual(l.shadow.aligned, c2.aligned);
  assert.equal(env.call('apiForecastLatest(__in)', { __in: { planId: idNext } }).shadow.reach.draft.budget, F27 + 120);
  // ホームの合計: 両方の計画の予算に届く見込み（独立なら / 全部同じ向きなら）
  const ht = env.call('apiHome()').totals;
  const both = [c2, port()[idNext]].filter((x) => String(x.fy) === '2026');
  assert.equal(ht.reach.plans, both.length);
  near(ht.reach.independent.p, J(pure.run('appLandingReachTotal_(__r)', { __r: both.map((x) => ({ landing: x.landing, sd: x.landingSd, budget: x.budgetUsed })) })).independent.p, 1e-12);
  assert.deepEqual([ht.reach.tau, ht.reach.w, ht.reach.tauSet], [0.15, 1, false]);
}

// ---- scoredMonths（今の決まりで B-2 が測った締まった月。実績 0 円の月も数える。前の版の行・締まっていない月・nega/posi は数えない） ----
{
  const p = port();
  assert.equal(p[idCur].scoredMonths, 5, '4・5・7・8（0 円）・9 月');
  assert.equal(p[idNext].scoredMonths, 0);
  assert.equal(env.call('apiLearningView(__in)', { __in: { planId: idCur } }).scoredMonths, p[idCur].scoredMonths, '検証の画面の scoredMonths と同じ');
  assert.equal(env.call('apiHome()').plans.find((x) => x.planId === idCur).scoredMonths, 5, 'ホームの計画にも渡す');
  assert.equal(typeof p[idCur].scoredMonths, 'number');
}

// ---- τ・w の承認（判断 29・11）: 所有者だけが業務の設定に書ける。範囲は APP_LANDING と同じ。書くまでは 0.15 と 1 ----
{
  const defs = J(env.run('APP_SETTING_DEFS'));
  const C = J(env.run('APP_LANDING'));
  assert.deepEqual([defs['landing.tau'].min, defs['landing.tau'].max, defs['landing.tau'].def, defs['landing.w'].min, defs['landing.w'].max, defs['landing.w'].def],
    [C.TAU_MIN, C.TAU_MAX, C.TAU0, 1, C.W_MAX, 1], '設定の範囲と既定値は着地の計算の決まりと同じ');
  assert.deepEqual([defs['landing.tau'].owner, defs['landing.w'].owner, defs['source.zac_spreadsheet'].owner], [true, true, true], 'どれも所有者だけ（ZAC の実績のスプレッドシートも。2026-10-13）');
  const used0 = env.call('apiAiLearning()').landing.used;
  assert.deepEqual([used0.tau, used0.w, used0.tauSet, used0.wSet, used0.tauFrom], [0.15, 1, false, false, '']);
  const before = port()[idCur];
  // 管理者の役割だけの人は書けない（記録は残る）
  env.task(`saveMember({ email: '${MEMBER}', displayName: 'M' })`);
  env.task(`grantRole({ email: '${MEMBER}', role: 'ADMIN', scopeType: 'ALL' })`);
  env.as(MEMBER);
  assert.throws(() => env.task(`saveSetting({ key: 'landing.tau', value: 0.3 })`), /権限がありません/, '所有者の操作そのものを断る（2026-10-13 から管理の入口は無い）');
  // 中の関数も、所有者でなければ断る（二重の守り）
  assert.throws(() => env.run(`appSaveSetting_({ actor: '${MEMBER}', user: { email: '${MEMBER}', isOwner: false }, roles: [] }, { key: 'landing.tau', value: 0.3 })`), /所有者だけ/);
  env.as(OWNER);
  // 範囲の外・数でない値は書かない
  for (const [key, value, re] of [['landing.tau', 0.36, /0\.05〜0\.35 の範囲/], ['landing.tau', 0.04, /0\.05〜0\.35 の範囲/], ['landing.w', 0.9, /1〜3 の範囲/], ['landing.w', 3.5, /1〜3 の範囲/], ['landing.tau', 'abc', /数値で入力/]]) {
    assert.throws(() => env.task('saveSetting(__in)', { __in: { key, value } }), re, `${key}=${value}`);
  }
  assert.equal(env.table('SETTINGS').length, 0, 'だめな値・所有者でない人の値は保存しない');
  // 明日から効く値は、今日はまだ使わない
  env.props.OWNER_TASK = JSON.stringify({ action: 'saveSetting', key: 'landing.tau', value: 0.3, effectiveFrom: '2026-10-07', note: '全計画から学んだ値を承認' });
  env.call('apiOwnerTask()');
  const t0 = port()[idCur];
  near(t0.landing, before.landing, 1e-12, '効き始める前は変わらない');
  env.run(`appToday_ = function () { return '2026-10-07'; }`);
  const t1 = port()[idCur];
  const inp = { fy: 2026, months: yms.map((ym) => ({ ym, p10: 80, p50: 100, p90: 120 })), actual: acts([90, 95, 100, 105, 0, 90]), cutoffYm: '2026/10', todayYm: '2026/10', budget: 900 };
  near(t1.landing, J(pure.run('appLandingSky_(__in)', { __in: Object.assign({}, inp, { tau: 0.3 }) })).landing, 1e-9, '書いた τ を使う');
  near(before.landing, J(pure.run('appLandingSky_(__in)', { __in: inp })).landing, 1e-9, '書く前は τ=0.15・w=1 の着地');
  assert.ok(Math.abs(t1.landing - before.landing) > 1e-6, 'τ を変えると着地が動く');
  assert.deepEqual([t1.reach.tau, t1.reach.w, t1.reach.tauSet, t1.reach.wSet, t1.aligned.tau], [0.3, 1, true, false, 0.3], '試しの数も同じ値を使う');
  env.task(`saveSetting({ key: 'landing.w', value: '1.5' })`);
  const t2 = port()[idCur];
  near(t2.landingSd, J(pure.run('appLandingSky_(__in)', { __in: Object.assign({}, inp, { tau: 0.3, w: 1.5 }) })).landingSd, 1e-9, '書いた w を使う');
  const u = env.call('apiAiLearning()').landing.used;
  assert.deepEqual([u.tau, u.w, u.tauSet, u.wSet, u.tauFrom, u.wFrom], [0.3, 1.5, true, true, '2026-10-07', '2026-10-07']);
  assert.deepEqual(env.call('apiHome()').totals.reach.tauSet, true);
  // 書いた行は消さずに足す（戻すときは 0.15 を書く）
  env.task(`saveSetting({ key: 'landing.tau', value: 0.15 })`);
  assert.equal(env.table('SETTINGS').filter((r) => r.key === 'landing.tau').length, 2);
  near(port()[idCur].landing, J(pure.run('appLandingSky_(__in)', { __in: Object.assign({}, inp, { w: 1.5 }) })).landing, 1e-9, '0.15 に戻すと戻る');
}

// ==== 6. 画面: 試しの数は「（試し）」をつけて出し、中の記号（P10/P50/P90・τ・w・B-2・EVAL_）は出さない ====
{
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: (t, k) => "<i data-pose=\\"" + String(k) + "\\"></i>" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
  const ui = vm.createContext({ document: { getElementById: () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} }), querySelector: () => null, addEventListener() {} },
    setTimeout: () => 0, clearTimeout() {}, confirm: () => false, window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  const R = (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };
  const tips = (html) => [...html.matchAll(/data-tip="([^"]*)"/g)].map((m) => m[1]).join('\n');
  const noCodes = (text, what) => assert.doesNotMatch(text, /P10|P50|P90|τ|\bw\b|B-\d|C-\d|EVAL_|undefined|NaN|null/, what + 'に中の記号・undefined を出さない');
  const latest = env.call('apiForecastLatest(__in)', { __in: { planId: idCur } });
  const sec = { annual: { p10: 1050, p50: 1150, p90: 1250, adopted: 1200, uplift: 60, final: 1260 },
    monthly: yms.map((ym, i) => ({ row: 29 + i, month: ym, p10: 80, p50: 100, p90: 120, adopted: 100, uplift: i === 11 ? 60 : '', final: i === 11 ? 160 : 100 })) };
  const view = { plan: latest.plan, can: { plan: true, approve: true, admin: true }, inputHash: 'h', actions: [], boot: { output: { sections: [sec] } } };
  const html = R(`S.fc.planId = __id; S.fc.view = __v; S.fc.data = __d; S.fc.budget = {}; fcBudgetTab(__d, __v)`, { __id: idCur, __d: latest, __v: view });
  const a = latest.shadow.aligned, rc = latest.shadow.reach;
  const ys = (n) => R(`yenShort(${n})`);
  assert.ok(!html.replace(/data-tip="[^"]*"/g, '').includes('（試し）'), '見える所に「試し」の注記を出さない（2026-10-13 村井さん）');
  const pctText = R(`reachPct(${rc.draft.pct})`);
  assert.match(html, new RegExp('data-tip="採用予測と上乗せの年度合計\\n\\nこの予算に届く見込み（試し）: ' + pctText + '\\n[^"]*"><div class="k">最終予算'), '届く見込みは最終予算の箱のカーソルで見込み');
  const t = tips(html);
  // 締まった月がある年度は、月の合計の中心だけを出し、幅は着地の推定の幅で見る（年度の途中の幅を広げすぎない）
  assert.match(t, /月の合計でそろえると 中心 [^・（]+（試し）/);
  assert.doesNotMatch(t, /月の合計でそろえると 中心 [^・（]+・80% の幅/, '締まった月がある年度は、そろえた値の幅を出さない');
  assert.match(t, /年度の途中の幅は、着地の推定（締まった 6 か月の実績を入れた見込み）の幅で見ます: 80% の幅 /);
  assert.match(t, /年度の売上を何度も試して出した値です/);
  assert.match(t, /採用予測 = 約束、上乗せ = 挑戦/);
  assert.match(t, /届く見込みが 50% の金額 [^・]+・60% の金額 [^・]+・70% の金額 [^・]+・80% の金額 /);
  assert.doesNotMatch(t, /90% の金額/, '90% 以上は出さない');
  assert.match(t, /承認済みの確定版（v2）の最終予算 900 円 には /);
  assert.match(t, /年の水準のぶれ 15%・幅の倍率 1\.5 倍（締まった 6 か月の実績を入れています）/, 'いま使っている前提（書いた値。τ は 0.15 に戻した）');
  assert.match(t, /保存している数字は変わりません/);
  noCodes(html.replace(/<[^>]*>/g, ' ') + '\n' + t.replace(/80% の幅/g, ''), '予測と予算');
  assert.match(R(`S.fc.budget = { 29: { adopted: '120' } }; fcBothTabs(__d, __v)`), /入力中の予算は、保存すると計算し直します/, '入力中の予算は保存すると計算し直す');
  // 試しの数が無い（前の控え・計画が違う）ときは、今までどおり出さない
  const plain = R(`S.fc.budget = {}; S.fc.planId = 'other'; fcBothTabs(__d, __v)`);
  assert.doesNotMatch(plain, /試し|届く見込み/);
  R(`S.fc.planId = __id`);
  assert.deepEqual([R('reachPct(0)'), R('reachPct(100)'), R('reachPct(35)'), R('reachPct(null)')], ['5% 未満', '95% 超', '約 35%', '-']);
  // ホーム: 年間予算の説明に、合計の届く見込み（独立なら〜全部同じ向きなら）
  const home = env.call('apiHome()');
  const hh = R(`S.view = 'home'; B.home = __h; viewHome()`, { __h: home });
  const r = home.totals.reach;
  assert.equal(r.plans, 1, '見せる年度（FY2026）の計画は 1 つ');
  assert.ok(!tips(hh).includes('この予算に届く見込み'), 'ホームの年度の数字に長い説明を付けない（2026-10-13 村井さん）');
  const two = R('homeReachTip(__r)', { __r: { plans: 3, budget: 3000, landing: 3300, independent: { p: 0.9, pct: 90 }, together: { p: 0.7, pct: 70 }, tau: 0.15, w: 1 } });
  assert.match(two, /^\nこの予算に届く見込み（試し）: 独立なら 約 90%〜全部同じ向きなら 約 70%\n着地と予算の両方がある 3 メーカーの予算 3,000 円 で見ています。メーカーどうしが別々に動くとみなすと前の値、全部が同じ向きに動くとみなすと後の値で、本当はその間です（年の水準のぶれ 15%・幅の倍率 1 倍）。保存している数字は変わりません$/);
  assert.equal(R(`homeReachTip(null)`), '', '合計の届く見込みが無ければ何も足さない');
  // 学び: 全計画から学んだ値（試し）。学べた値が無く、承認した値も無ければ出さない
  const card = (x) => R('lrLandingCard(__x)', { __x: x });
  assert.equal(card(null), '');
  assert.equal(card({ learned: { tau: 0.15, w: 1, tauLearned: false, wLearned: false, planCount: 1, monthCount: 3 }, used: { tau: 0.15, w: 1, tauSet: false, wSet: false } }), '');
  const lc = card({ learned: { tau: 0.2466, w: 1.42, tauLearned: true, wLearned: true, planCount: 4, monthCount: 24 }, used: { tau: 0.15, w: 1, tauSet: false, wSet: false, tauFrom: '', wFrom: '' } });
  assert.match(lc, /<p class="note">全計画から学んだ値（試し）: 年の水準のぶれ 24\.7%・幅の倍率 1\.42 倍（承認すると使います）<\/p>/);
  assert.match(tips(lc), /今使っている値: 年の水準のぶれ 15%・幅の倍率 1 倍（決まった値）/);
  assert.match(tips(lc), /4 計画・24 か月/);
  const lc2 = card({ learned: { tau: 0.2466, w: 1, tauLearned: true, wLearned: false, planCount: 4, monthCount: 6 }, used: { tau: 0.2466, w: 1, tauSet: true, wSet: false, tauFrom: '2026-10-08', wFrom: '' } });
  assert.match(lc2, /全計画から学んだ値（試し）: 年の水準のぶれ 24\.7%（承認して使っています）/, '幅の倍率は学べていなければ言わない');
  assert.match(tips(lc2), /（承認 2026\/10\/08 から）/);
  noCodes(lc.replace(/<[^>]*>/g, ' ') + tips(lc) + tips(lc2), '学び');
  // 本物の応答で、AI の学びの画面に出る（学べる計画が足りないときは出さない）
  const ai = env.call('apiAiLearning()');
  assert.ok(ai.landing && ai.landing.learned && ai.landing.used, '学びの応答に着地の τ・w');
  assert.equal(R('lrLandingCard(__x)', { __x: ai.landing }).includes('全計画から学んだ値'), !!(ai.landing.learned.tauLearned || ai.landing.learned.wLearned || ai.landing.used.tauSet || ai.landing.used.wSet));
  const lv = R(`lrAiView(__d)`, { __d: Object.assign({ curves: [], timeline: [{ ym: '2026/04', n: 1, mape: 0.1, rolling3: 0.1, coverage: 1, coverageN: 1 }], calibration: [], pending: [], health: [] }, { landing: ai.landing }) });
  assert.ok(lv.includes('着地の幅の学び'), 'AI の学びの最後にカード（承認した値があるので出す）');
}

// ==== 7. 計画の一覧を通して: 年度を締めても、数えた月が 12 に足りなければ done ではない（2026-10-08 点検。届いた・届かなかったと言い切らない） ====
{
  const before = port()[idNext];
  assert.deepEqual([before.aligned.done, before.reach.done], [false, false]);
  env.run(`appWithLock_(() => appInsertRows_('YEAR_CLOSURES', [{ fy: '2027', state: 'CLOSED', file_id: 'FILE-TEST', snapshot_sha256: __h,
    plan_count: 1, row_count: 1, bytes: 1, closed_at: appNowIso_(), closed_by: '${OWNER}' }]))`, { __h: 'a'.repeat(64) });
  const nx = port()[idNext];
  assert.equal(nx.frozen, true, '締めた年度の印');
  assert.deepEqual(nx.aligned, before.aligned, '締めても数えた月が 0 なら、試しの年度はそのまま');
  assert.deepEqual([nx.reach.done, nx.reach.actual, nx.reach.amounts.length], [false, null, 4], '締めても 12 か月を数えるまでは届く見込みのまま');
  const cu = port()[idCur];
  assert.deepEqual([cu.aligned.done, cu.reach.done], [false, false], 'ほかの年度は変わらない');
  const l = env.call('apiForecastLatest(__in)', { __in: { planId: idNext } });
  assert.deepEqual([l.shadow.aligned.done, l.shadow.reach.done], [false, false], '予測の画面にも同じ');
  // ホームの計画の行にも締めた年度の印（メーカーを選ぶ一覧・メーカーの画面が、当たり具合の計算待ちの案内を出さないため）
  const hp = (env.call('apiHome()').plans || []).find((x) => x.planId === idNext);
  assert.ok(hp && hp.frozen === true, 'ホームの行に frozen');
}

console.log('app-reach: all tests passed');
