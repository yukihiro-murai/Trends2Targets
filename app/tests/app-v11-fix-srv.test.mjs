#!/usr/bin/env node
/**
 * app-v11-fix-srv.test.mjs — 表の版 11（v0.31.0）の確かめで見つかったことの直し（サーバー。2026-10-09）。
 *   1. 過去の平均の形（appBudgetPastShape_）: 終わっていない年度（12 か月とも締まっていない年度）を「まるごとの年度」に数えない。
 *      来年度の計画を今の年度の途中に作ると、A-2 は今の年度を途中まで取り込む（残りの月は 0 円）。締まりは 今日の境目・取り込んだときの境目・
 *      SALES_INPUT の status のいちばん厳しい読み方。2 年に足りなければ今までどおり予測の月の形（そう書く）
 *   2. 本番の計画の見せる年度の値（appLandingAnnualShown_）: 年度の途中は中心も幅も着地の推定（同じ分布）。中心が自分の 80% の幅の外に出ない・
 *      予算に届く見込みの中心と確率で選ぶ 50% の金額と同じ。締まった月なしは月の合計と試しの幅。計画の一覧・予測の画面の shadow.annual・ホーム・分析で同じもの
 *      { p10, p50, p90, band, k, basis, monthSum, done, pending, legacy }。公式版の center は出したときの見せる中心と同じ
 *   3. 公式版の画面と分析の見直しの流れ: current.shown（今の見せる中心）・versions[].shownCenter・revisions[].live / p50Shown / basis（前の項目はそのまま）
 *   4. 版 11 の移行がバックアップを待っている間も、もうある版 10 の記録の表（入力の記録の自信など）には足す（表ごとに決める）。予算の下書きは待つ
 * 名前と数字はテスト用の架空のもの。モックの上の確かめで、本物の Apps Script の上では動かしていない。
 *
 *   node app/tests/app-v11-fix-srv.test.mjs
 */
import assert from 'node:assert/strict';
import { J, OWNER, makeEnv, setUpEnv } from './gas-mock.mjs';

const near = (a, b, tol, msg) => assert.ok(typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol, `${msg || ''}: ${a} と ${b}`);
const fyYms = (fy) => Array.from({ length: 12 }, (_, i) => { const m = 4 + i; return (m > 12 ? fy + 1 : fy) + '/' + String(m > 12 ? m - 12 : m).padStart(2, '0'); });
const sum = (a) => a.reduce((s, x) => s + x, 0);
const obj = (H, o) => H.map((h) => (o[h] === undefined ? '' : o[h]));

/**
 * 計画のブック（旧来の OUTPUT の形: 26 行の年度合計・29〜40 行の月。H = 採用予測）。
 * sales = [[ym, 円, status]]（SALES_INPUT。status を省くと closed）・importedAt = 取り込んだ日時（source_updated_at。null なら空）、
 * cmp = 締まった月の実績 { ym: 円 }、b1・b2 = PROCESS_STATUS の B-1・B-2 の成功の時刻（b2 が null なら無し）、owner = 補正を所有者が承認した値にして予測し直した（本番）
 */
function planBook(env, client, fy, { p50 = 1000, legacy = [11000, 11500, 12000], sales = [], importedAt = new Date(2026, 9, 6, 10), cmp = {}, b1 = new Date(2026, 9, 5, 10),
  b2 = new Date(2026, 9, 5, 11), owner = false, extra = {} } = {}) {
  const H = (name) => J(env.run(`APP_ENGINE_SHEETS.${name}.header`));
  const HS = H('SALES_INPUT'), HC = H('EVAL_COMPARE_MONTHLY'), HP = H('PROCESS_STATUS'), HCAL = H('CALIBRATION_STATE'), HSN = H('FORECAST_SNAPSHOT');
  const yms = fyYms(fy);
  const output = [['FY' + fy + ' 売上予測（' + client + '）']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', ...legacy]);
  output.push([], ['月', 'P10', 'P50', 'P90', '', '', '', '採用予測', '上乗せ']);
  yms.forEach((ym) => output.push([ym, p50 - 200, p50, p50 + 200, '', '', '', p50, '']));
  return env.makeBook(client, Object.assign({
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    OUTPUT: { values: output, formats: { A: '@' } },
    SALES_INPUT: { values: [HS, ...sales.map(([ym, v, st]) => [client, 'BASE', '製品A', ym, v, st === undefined ? 'closed' : st, importedAt === null ? '' : importedAt])], formats: { D: '@' } },
    EVAL_COMPARE_MONTHLY: { values: [HC, ...Object.entries(cmp).map(([ym, act]) => obj(HC, { target_month: ym, actual_total: act }))], formats: { A: '@' } },
    PROCESS_STATUS: { values: [HP, ['step2_status', b1, 'owner', 'success', client, 10, ''], ...(b2 ? [['step5_status', b2, 'owner', 'success', '', 6, '']] : [])] },
    CALIBRATION_STATE: { values: [HCAL, obj(HCAL, { client, bias_correction_factor: 1, residual_month_bias_json: '', auto_update_enabled: owner ? 0 : 1,
      note: owner ? 'owner-approved 2026-10-01 10:00: D7' : 'auto-learned' })] },
    FORECAST_SNAPSHOT: { values: [HSN, obj(HSN, { snapshot_id: 'S1', run_date: new Date(2026, 9, 2, 9), client, target_month: yms[0], scenario: 'neutral', final_pred: p50,
      calibration_applied_json: JSON.stringify({ version: 'v', bias_correction_factor: 1, residual_month_bias_json: '' }) })], formats: { D: '@' } },
  }, extra));
}
const year = (fy, v = 1000, st) => fyYms(fy).map((ym) => [ym, v, st]);
/** 直しごとに分けて動かす（前の版で、どの直しのテストも落ちることを確かめられるように）。落ちた部分があれば最後に止める */
const failed = [];
function part(name, fn) {
  try { fn(); } catch (e) { failed.push(name); console.error('FAIL ' + name + '\n' + (e && e.stack ? e.stack : e)); }
}

// ==== 1. 過去の平均の形: 終わっていない年度を数えない ====
part('F1 過去の平均の形', () => {
  const env = setUpEnv();
  env.run(`appToday_ = function () { return '2026-10-06'; }`);
  const shape = (planId) => env.call('appBudgetPastShape_(appPlanOf_(__p))', { __p: planId });
  const propose = (planId, prob) => env.call('apiBudgetProposal(__in)', { __in: { planId, prob } });
  // 来年度（FY2027）の計画を今の年度（FY2026）の 10 月に作った: A-2 は FY2023/04〜FY2026（2027/03）を取り込むが、FY2026 は 4〜9 月だけ（10 月からは来ていない）
  const next = env.seedPlan(planBook(env, '来年度製薬', 2027, { sales: [...year(2023), ...year(2024), ...year(2025), ...year(2026).slice(0, 6)] }));
  const s = shape(next);
  assert.deepEqual([s.years, s.fys], [3, [2023, 2024, 2025]], '途中まで取り込んだ FY2026 は数えない');
  s.shares.forEach((x) => near(x, 1 / 12, 1e-12, '毎月同じ売上なら月の割合も同じ'));
  const p = propose(next, 50);
  assert.deepEqual([p.ok, p.alloc, p.fallback, p.shapeYears], [true, 'PAST_SHAPE', false, 3], p.basisText);
  assert.equal(sum(p.months.map((m) => m.adopted)), p.annual);
  const lo = Math.min(...p.months.map((m) => m.adopted)), hi = Math.max(...p.months.map((m) => m.adopted));
  assert.ok(hi - lo <= 12, '月の割り振りは平ら（前は 4〜9 月に寄っていた）: ' + lo + '〜' + hi);
  assert.match(p.basisText, /過去 3 年の売上の月の形の平均/, '数えた年度の数を書く');
  // まるごとの年度が 1 年（FY2025）と途中の FY2026: 2 年に足りないので予測の月の形（今までどおりの文）
  const short = env.seedPlan(planBook(env, '一年製薬', 2027, { sales: [...year(2025), ...year(2026).slice(0, 6)] }));
  assert.deepEqual([shape(short).years, shape(short).shares], [1, null]);
  const ps = propose(short, 60);
  assert.deepEqual([ps.ok, ps.alloc, ps.fallback, ps.shapeYears], [true, 'FORECAST_SHAPE', true, 1]);
  assert.match(ps.basisText, /過去の売上が 2 年分そろわないので、予測の月の形で割り振りました/);
  // 締まりの読み方（いちばん厳しい読み方）: 今年度（FY2026）の計画・FY2022〜FY2025 の売上
  const past4 = [...year(2022), ...year(2023), ...year(2024), ...year(2025)];
  // a) status が open の月がある年度は数えない
  const open = env.seedPlan(planBook(env, '印製薬', 2026, { sales: past4.map(([ym, v]) => [ym, v, ym === '2025/06' ? 'open' : 'closed']) }));
  assert.deepEqual(shape(open).fys, [2022, 2023, 2024], 'FY2025 の 2025/06 が open（取り込み直す前の印）');
  // b) 取り込んだときに締まっていなかった月（行の無い 0 円の月も）: 4/03 の取り込みでは 3 月はまだ途中 → FY2025 は数えない（今日の境目では締まっていても）
  const noMar = past4.filter(([ym]) => ym !== '2026/03');
  const early = env.seedPlan(planBook(env, '早い取り込み製薬', 2026, { sales: noMar, importedAt: new Date(2026, 3, 3, 10) }));
  assert.deepEqual(shape(early).fys, [2022, 2023, 2024], '取り込んだときの境目より後の月がある年度は数えない');
  const late = env.seedPlan(planBook(env, '後の取り込み製薬', 2026, { sales: noMar, importedAt: new Date(2026, 3, 6, 10) }));
  assert.deepEqual(shape(late).fys, [2022, 2023, 2024, 2025], '4/06 の取り込みなら 3 月は締まっている（3 月は 0 円の月）');
  // c) 印も取り込みの日時も無ければ、今日の境目だけで決める
  const bare = env.seedPlan(planBook(env, '印なし製薬', 2027, { sales: [...year(2024, 1000, ''), ...year(2025, 1000, ''), ...year(2026, 1000, '').slice(0, 6)], importedAt: null }));
  assert.deepEqual(shape(bare).fys, [2024, 2025], '今日（2026-10-06）の境目より後の月がある FY2026 は数えない');
});

// ==== 2〜3 の準備: 本番の計画（年度の途中・締まった月なし・計算待ち）と本番でない計画、予測の回 ====
function liveEnv() {
  const env = makeEnv();
  env.run(`appToday_ = function () { return '2026-10-06'; }`);
  env.as(OWNER);
  env.call('apiSetup()');
  const y26 = fyYms(2026);
  const low = Object.fromEntries(y26.slice(0, 6).map((ym) => [ym, 800]));   // 締まった 6 か月の実績が予測（1000）の 8 割
  const idMid = env.seedPlan(planBook(env, '途中製薬', 2026, { owner: true, cmp: low }));            // 本番・年度の途中（k = 6）
  const idNext = env.seedPlan(planBook(env, '来年度製薬', 2027, { owner: true }));                    // 本番・締まった月なし（k = 0）
  const idWait = env.seedPlan(planBook(env, '計算待ち製薬', 2026, { owner: true, b2: null }));        // 本番・初めての取り込みの計算待ち
  const idTrial = env.seedPlan(planBook(env, '試し製薬', 2026, { owner: false, cmp: low }));          // 本番でない
  // 予測の回（分析の見直しの流れ）: 前の回は本番でない、今の回は本番（annual_aligned）。来年度製薬の本番の回は月が 11 か月しかない
  const run = (id, planId, at, fixes, a50, months) => ({ run: { run_id: id, plan_id: planId, status: 'DONE', annual_p10: a50 - 500, annual_p50: a50, annual_p90: a50 + 500,
    started_at: at, finished_at: at, actor_email: OWNER, fixes_json: JSON.stringify(fixes) }, monthly: months.map((ym, i) => ({ run_id: id, plan_id: planId, ym, p10: 800, p50: 1000 + i, p90: 1200 })) });
  const runs = [run('R-MID-1', idMid, '2026-09-01T10:00:00+0900', [], 11400, y26), run('R-MID-2', idMid, '2026-10-02T09:00:00+0900', ['annual_aligned'], 11500, y26),
    run('R-NEXT-1', idNext, '2026-10-02T09:00:00+0900', ['annual_aligned'], 11500, fyYms(2027).slice(0, 11))];
  env.run(`appWithLock_(() => { appInsertRows_('FORECAST_RUNS', __r); appInsertRows_('FORECAST_MONTHLY', __m); }); appBumpGen_();`,
    { __r: runs.map((x) => x.run), __m: [].concat(...runs.map((x) => x.monthly)) });
  return { env, idMid, idNext, idWait, idTrial };
}

// ==== 2. 本番の計画の見せる年度の値（中心と幅は同じ分布）と、公式版の center ====
part('F2 見せる年度の値', () => {
  const { env, idMid, idNext, idWait, idTrial } = liveEnv();
  const ps = Object.fromEntries(env.call('apiPortfolio()').plans.map((p) => [p.planId, p]));
  const legacy = { p10: 11000, p50: 11500, p90: 12000 };
  // ---- 年度の途中（k = 6）: 中心と幅は着地の推定。中心が幅の中 ----
  const M = ps[idMid];
  assert.deepEqual([M.alignedLive, M.k, M.annualBand], [true, 6, 'landing']);
  assert.ok(M.p10 <= M.p50 && M.p50 <= M.p90, `中心が自分の 80% の幅の中: ${M.p10} ≤ ${M.p50} ≤ ${M.p90}`);
  near(M.p50, M.landing, 1e-9, '中心 = 着地の推定');
  near(M.p50, M.reach.center, 1e-9, '予算に届く見込みの中心と同じ');
  assert.ok(M.p50 < 12000 - 1, '前提: 実績が予測より低いので、着地の推定は月の合計（12,000）より下');
  assert.deepEqual(M.annualShown, { p10: M.p10, p50: M.p50, p90: M.p90, band: 'landing', k: 6, basis: 'landing', monthSum: 12000, done: false, pending: false,
    legacy: { p10: 11000, p50: 11500, p90: 12000 } });
  assert.deepEqual(M.legacyAnnual, legacy, '旧来の年度合計（最新の予測の記録）はそのまま');
  // 予測の画面（shadow.annual）・ホーム・分析も同じもの
  const lat = env.call('apiForecastLatest(__in)', { __in: { planId: idMid } });
  assert.deepEqual(lat.shadow.annual, M.annualShown, '予測の画面の年度の値は計画の一覧と同じ');
  const hp = env.call('apiHome()').plans.find((x) => x.planId === idMid);
  assert.deepEqual([hp.p10, hp.p50, hp.p90, hp.annualShown], [M.p10, M.p50, M.p90, M.annualShown], 'ホームも同じ');
  const cross = env.call('apiCrossMaker(__in)', { __in: { fy: '2026' } });
  const cm = cross.plans.find((x) => x.planId === idMid);
  assert.deepEqual([cm.p50, cm.annualShown], [M.p50, M.annualShown], '分析も同じ');
  // 確率で選ぶ 50% の年間 = 見せる中心（同じ分布）
  const p50 = env.call('apiBudgetProposal(__in)', { __in: { planId: idMid, prob: 50, alloc: 'FORECAST_SHAPE' } });
  assert.equal(p50.annual, Math.round(M.p50), '50% の金額は見せる中心');
  // ---- 締まった月なし（k = 0）: 中心は月の合計、幅は試しの幅 ----
  const N = ps[idNext];
  assert.deepEqual([N.alignedLive, N.k, N.annualBand, N.annualShown.basis, N.annualShown.monthSum], [true, 0, 'aligned', 'monthsum', 12000]);
  near(N.p50, 12000, 1e-9, '中心 = 月の合計');
  near(N.p50, N.reach.center, 1e-9, '締まった月が無ければ、着地の推定の中心とも同じ');
  assert.ok(N.p10 < N.p50 && N.p50 < N.p90);
  // ---- 計算待ち: 中心は月の合計、幅なし ----
  const W = ps[idWait];
  assert.deepEqual([W.alignedLive, W.annualBand, W.annualShown.basis, W.annualShown.pending, W.p10, W.p90, W.reach], [true, '', 'monthsum', true, null, null, null]);
  near(W.p50, 12000, 1e-9);
  // ---- 本番でない計画は旧来の年度合計のまま ----
  assert.deepEqual([ps[idTrial].alignedLive, ps[idTrial].p50, ps[idTrial].annualShown], [false, 11500, null]);
  assert.equal(env.call('apiForecastLatest(__in)', { __in: { planId: idTrial } }).shadow.annual, null);
  // ---- 公式版を出す: 表の center = 出したときの見せる中心（年度の途中は着地の推定・締まった月なしは月の合計） ----
  for (const id of [idMid, idNext]) {
    const sh = env.call('apiForecastLatest(__in)', { __in: { planId: id } }).shadow.annual;
    const sub = env.call('appTestVersionSubmit_(__in)', { __in: { planId: id } });
    assert.equal(sub.version.reach.mode, 'LIVE');
    near(sub.version.reach.center, sh.p50, 1e-9, '公式版の center は出したときの見せる中心: ' + sh.basis);
    near(Number(env.table('PLAN_VERSIONS').find((v) => v.version_id === sub.version.versionId).center), sh.p50, 1e-6, '表の center');
    assert.equal(sub.version.annual.p50, 11500, '公式版の旧来の年度合計の列はそのまま');
  }
});

// ==== 3. 公式版の画面（今の中心・版の中心（年度））と分析の見直しの流れ ====
part('F4 公式版と見直しの流れ', () => {
  const { env, idMid, idNext, idWait, idTrial } = liveEnv();
  const shownOf = (id) => env.call('apiForecastLatest(__in)', { __in: { planId: id } }).shadow.annual;
  for (const [id, basis] of [[idMid, 'landing'], [idNext, 'monthsum']]) {
    const sh = shownOf(id);
    const before = env.call('apiVersionList(__in)', { __in: { planId: id } });
    assert.deepEqual(before.current.shown, { p50: sh.p50, basis, live: true }, '今の中心は予測の画面と同じ: ' + basis);
    assert.equal(before.current.annual.p50, 11500, '旧来の年度合計の項目はそのまま');
    const sub = env.call('appTestVersionSubmit_(__in)', { __in: { planId: id } });
    near(sub.version.shownCenter, sub.version.reach.center, 1e-9, '本番の版の中心（年度）は、出したときの見せる中心（reach.center）');
    near(sub.version.shownCenter, sh.p50, 1e-9);
    const after = env.call('apiVersionList(__in)', { __in: { planId: id } });
    near(after.versions.find((v) => v.versionId === sub.version.versionId).shownCenter, sh.p50, 1e-9, '一覧の版の中心（年度）');
  }
  // 着地見込みの無い本番の版（計算待ち）: center は空、見せる中心は出したときの月の合計
  const sw = env.call('appTestVersionSubmit_(__in)', { __in: { planId: idWait } });
  assert.deepEqual([sw.version.reach.mode, sw.version.reach.center, sw.version.shownCenter], ['LIVE', null, 12000]);
  assert.deepEqual(env.call('apiVersionList(__in)', { __in: { planId: idWait } }).current.shown, { p50: 12000, basis: 'monthsum', live: true });
  // 本番でない計画: 旧来の年度合計
  const lt = env.call('apiVersionList(__in)', { __in: { planId: idTrial } });
  assert.deepEqual(lt.current.shown, { p50: 11500, basis: 'legacy', live: false });
  const st = env.call('appTestVersionSubmit_(__in)', { __in: { planId: idTrial } });
  assert.deepEqual([st.version.reach.mode, st.version.shownCenter], ['SHADOW', 11500], '試しの版の中心（年度）は旧来の年度合計');
  // 版 11 より前の版（列が空）も旧来の年度合計
  env.run(`appWithLock_(() => appInsertRows_('PLAN_VERSIONS', [{ version_id: 'VER-OLD', plan_id: __p, version_no: 0, state: 'SUPERSEDED', annual_p50: 11111, budget_final: 900,
    submitted_by: '${OWNER}', row_version: 1 }])); appBumpGen_();`, { __p: idMid });
  assert.equal(env.call('apiVersionList(__in)', { __in: { planId: idMid } }).versions.find((v) => v.versionId === 'VER-OLD').shownCenter, 11111);

  // ---- 分析の見直しの流れ: 本番の回は月の合計、ほかは旧来の年度合計（前の項目はそのまま） ----
  const rev = (id) => env.call('apiCrossMaker(__in)', { __in: { fy: String(id === idNext ? 2027 : 2026) } }).plans.find((x) => x.planId === id).revisions;
  const rm = rev(idMid);
  assert.deepEqual(rm.map((r) => [r.p50, r.live, r.p50Shown, r.basis]), [[11400, false, 11400, 'legacy'], [11500, true, 12066, 'monthsum']],
    '本番の回は、その回の月の P50 の合計（1000〜1011 の 12 か月）');
  assert.deepEqual(Object.keys(rm[0]).sort(), ['at', 'basis', 'live', 'monthSum', 'p10', 'p50', 'p50Shown', 'p90']);
  assert.deepEqual(rev(idNext).map((r) => [r.live, r.p50Shown, r.basis]), [[true, 11500, 'legacy']], '月が 12 そろわない回は旧来の年度合計');
});

// ==== 4. 版 11 の移行がバックアップを待っている間も、版 10 の記録の表には足す ====
part('F5 移行を待つ間の記録', () => {
  const V10_VERSIONS = ['version_id', 'plan_id', 'version_no', 'state', 'input_hash', 'forecast_run_id', 'annual_p10', 'annual_p50', 'annual_p90',
    'budget_adopted', 'budget_uplift', 'budget_final', 'monthly_json', 'note', 'submitted_at', 'submitted_by', 'decided_at', 'decided_by',
    'decision_note', 'updated_at', 'updated_by', 'row_version'];
  const env = makeEnv();
  // 版 10 の姿のデータ本体（app-v11-drafts-migrate.test.mjs と同じ作り方）
  env.run(`__V11 = JSON.parse(JSON.stringify(APP_TABLES)); __ADDED = JSON.parse(JSON.stringify(APP_ADDED_COLUMNS));
    delete APP_TABLES.BUDGET_DRAFTS; delete APP_ADDED_COLUMNS.PLAN_VERSIONS; APP_TABLES.PLAN_VERSIONS.columns = JSON.parse(__pv);`, { __pv: JSON.stringify(V10_VERSIONS) });
  env.as(OWNER);
  env.call('apiSetup()');
  env.props.APP_TABLES_VERSION = String(env.call('APP_SCHEMA_VERSION'));
  env.data().getSheetByName('_SCHEMA').rows.slice(1).forEach((r) => { if (r && r[0]) r[1] = '10'; });
  const fy = env.run('appFy_(new Date())');
  const HPR = J(env.run('APP_ENGINE_SHEETS.PRODUCT.header'));
  const planId = env.seedPlan(planBook(env, '待ち製薬', fy, { extra: { PRODUCT: { values: [HPR] } } }));
  env.run('APP_STORE_CACHE_ = {}');
  // 版 11 のコードにする・バックアップが取れない
  env.run('Object.keys(__V11).forEach(n => { APP_TABLES[n] = __V11[n]; }); Object.keys(__ADDED).forEach(n => { APP_ADDED_COLUMNS[n] = __ADDED[n]; }); APP_STORE_CACHE_ = {};');
  env.props.APP_TABLES_VERSION = '10';
  const archiveId = env.props.APP_ARCHIVE_FOLDER_ID;
  delete env.props.APP_ARCHIVE_FOLDER_ID;
  env.call('apiListPlans()');
  assert.equal(env.props.APP_TABLES_VERSION, '10', '前提: 移行はバックアップを待っている');
  assert.equal(env.data().getSheetByName('BUDGET_DRAFTS'), null);
  const nLog = env.table('INPUT_LOG').length;
  // 入力の保存（自信つき）: 入力の記録に足す（前は版の印だけを見て足さず、自信が失われた）
  const v = env.call('apiPlanView(__in)', { __in: { planId } });
  const s = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', inputHash: v.inputHash,
    args: { kind: 'product', rows: [{ person: '鷹野', product: '製品A', ym: fy + '-06', step: '5', reason: '新規', selfConf: '高い' }] } });
  assert.equal(s.status, 'DONE', s.error);
  assert.deepEqual(s.result.changed, ['PRODUCT']);
  const added = env.table('INPUT_LOG').slice(nLog);
  assert.deepEqual(added.map((r) => [r.plan_id, r.action, r.change, r.self_conf]), [[planId, 'INPUT.SAVE', 'ADD', '高い']], '移行を待っている間の保存も記録に残る');
  assert.equal(env.errors().filter((e) => e.where === 'LOG.SKIPPED' && /INPUT_LOG/.test(e.message)).length, 0);
  // 予算の保存は通るが、下書きは版がそろうまで足さない（表もまだ無い）
  const v2 = env.call('apiPlanView(__in)', { __in: { planId } });
  const b = env.runJob('PLAN.EDIT', { planId, action: 'BUDGET.SAVE', inputHash: v2.inputHash, args: { rows: [{ row: 29, adopted: 1234 }] } });
  assert.equal(b.status, 'DONE', b.error);
  assert.equal(b.result.draft, null);
  assert.equal(env.call('appLogReady_("BUDGET_DRAFTS")'), false);
  assert.equal(env.call('appLogReady_("INPUT_LOG")'), true);
  assert.equal(env.call('appLogReady_()'), false, '表を渡さなければ版の印だけ（一度だけの写し・予測を断るか）');
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'FORECAST.RUN', payload: { planId } } }), /表の版 \d+ の移行（列を足す）がまだ済んでいないので/, '予測は今までどおり断る');
  // バックアップが取れるようになって移行が済んでも、その保存の記録は 1 行のまま残る
  env.props.APP_ARCHIVE_FOLDER_ID = archiveId;
  delete env.props.APP_MIGRATE_BACKUP_FAILED_AT;
  env.call('apiListPlans()');
  assert.equal(env.props.APP_TABLES_VERSION, String(env.call('APP_SCHEMA_VERSION')));
  assert.equal(env.table('INPUT_LOG').filter((r) => r.self_conf === '高い' && r.action === 'INPUT.SAVE').length, 1);
  assert.ok(env.table('BUDGET_DRAFTS').some((r) => r.plan_id === planId && r.basis === 'BASELINE'), '保存した予算は移行の後の写しで下書きになる');
});

if (failed.length) {
  console.error('app-v11-fix-srv: failed: ' + failed.join(' / '));
  process.exit(1);
}
console.log('app-v11-fix-srv: all tests passed');
