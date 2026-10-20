#!/usr/bin/env node
/**
 * app-v11-drafts.test.mjs — 表の版 11（SCHEMA_PLAN_v10-12_JA.md の 4 章。2026-10-09 村井さん承認「推奨する対応を継続」）の予算の下書きと公式版の列。
 *   1. 表の定義: BUDGET_DRAFTS の列とキー（4-1）・PLAN_VERSIONS の後ろの 9 列（4-2）
 *   2. 予算の保存（BUDGET.SAVE）のたびに 12 行の下書き（同じ控え）。決め方・確率・割り振りの確かめと、保存した値から決める決め方
 *   3. 予測し直しても下書きが戻る（旧来の計算の後・データ本体へ戻す前に OUTPUT の採用予測と上乗せを書き直す）。下書きが無ければ真ん中（旧来のとおり）。
 *      公式版の数字（appPlanNumbers_）が下書きと同じ。予測が動いた大きさ（boot.budgetDraft の drift・warn）
 *   4. 確率で選ぶ（apiBudgetProposal）: 予算に届く見込みと同じ届く金額・過去の平均の形・足りなければ予測の月の形・年度の途中は締まった月が実績のまま
 *   5. 公式版を出すと、届く見込みと前提の列が入り、後から変わらない。一覧の versions[].reach。試しか本番か（appPlanAlignedLive_）
 *   6. 控えを書き直しても下書きは二重にならない
 * モックの上の確かめで、本物の Apps Script の上では動かしていない（最終の確かめは GAS 側）。
 *
 *   node app/tests/app-v11-drafts.test.mjs
 */
import assert from 'node:assert/strict';
import { J, OWNER, MEMBER, OUTSIDER, setUpEnv } from './gas-mock.mjs';

const near = (a, b, tol, msg) => assert.ok(typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol, `${msg || ''}: ${a} と ${b}`);
const fyYms = (fy) => Array.from({ length: 12 }, (_, i) => { const m = 4 + i; return (m > 12 ? fy + 1 : fy) + '/' + String(m > 12 ? m - 12 : m).padStart(2, '0'); });
const sum = (a) => a.reduce((s, x) => s + x, 0);
/** 月の金額が年間 × 重みの割合か（円に丸める。端数は重みの一番大きい月に入るので、その月だけ 12 か月分の丸めの差まで） */
const allocated = (months, annual, w) => {
  const W = sum(w);
  let big = 0;
  w.forEach((x, i) => { if (x > w[big]) big = i; });
  return months.every((m, i) => Number.isInteger(m.adopted) && Math.abs(m.adopted - annual * w[i] / W) <= (i === big ? 6 : 0.5 + 1e-9));
};

const env = setUpEnv();
env.run(`appToday_ = function () { return '2026-10-06'; }`);
const H = (name) => J(env.run(`APP_ENGINE_SHEETS.${name}.header`));
const HS = H('SALES_INPUT'), HC = H('EVAL_COMPARE_MONTHLY'), HP = H('PROCESS_STATUS');

/**
 * 計画のブック（旧来の OUTPUT の形: 26 行の年度合計・29〜40 行の月。H = 採用予測・I = 上乗せ・J = H + I の数式・年度の合計は SUM）。
 * p50[i] = 月の真ん中。adopted を省くと真ん中（旧来の初期値）。sales = 過去の売上 { 'yyyy/MM': 円 }、cmp = 締まった月の実績 { 'yyyy/MM': 円 }
 */
function planBook(client, fy, { p50, adopted, uplift, sales = {}, cmp = {} }) {
  const yms = fyYms(fy);
  const output = [['FY' + fy + ' 売上予測（' + client + '）']];
  for (let r = 2; r <= 23; r++) output.push([]);
  output.push([' 混合（主要）'], []);
  output.push(['年度合計（予測）', sum(p50) * 0.9, sum(p50), sum(p50) * 1.1, '', '', '', '', '', '']);   // 26 行目
  output.push([], ['Month', 'Downside(P10)', 'Baseline(P50)', 'Upside(P90)', '', '', '', 'Adopted Forecast', 'Sales Uplift', 'Final Budget']);
  yms.forEach((ym, i) => output.push([ym, p50[i] - 100, p50[i], p50[i] + 100, '', '', '', adopted ? adopted[i] : p50[i], uplift ? uplift[i] : '', '']));
  const formulas = { H26: '=SUM(H29:H40)', I26: '=SUM(I29:I40)', J26: '=SUM(J29:J40)' };
  for (let i = 0; i < 12; i++) formulas['J' + (29 + i)] = `=H${29 + i}+I${29 + i}`;
  return env.makeBook(client, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    PRODUCT: { values: [['Person', 'ProductName', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']] },
    CLIENT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']] },
    OPINIONS: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Confidence(0..1)', 'Note']] },
    DEV_SPOT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Project', 'Amount(JPY)', 'Confidence(0..1)']] },
    OUTPUT: { values: output, formulas, formats: { A: '@' } },
    SALES_INPUT: { values: [HS, ...Object.entries(sales).map(([ym, v]) => [client, 'BASE', '製品A', ym, v, 'closed', new Date(2026, 8, 1)])], formats: { D: '@' } },
    EVAL_COMPARE_MONTHLY: { values: [HC, ...Object.entries(cmp).map(([ym, act]) => HC.map((h) => ({ target_month: ym, actual_total: act,
      forecast_total_p10: 900, forecast_total_p50: 1000, forecast_total_p90: 1100 })[h] ?? ''))], formats: { A: '@' } },
    PROCESS_STATUS: { values: [HP, ['step2_status', new Date(2026, 9, 5, 10), 'owner', 'success', client, 10, ''], ['step5_status', new Date(2026, 9, 5, 11), 'owner', 'success', '', 6, '']] },
  });
}
/** 旧来の予測（A-9）の代わり: 旧来と同じく、月の P10/P50/P90 を書き、採用予測（H）を真ん中に・上乗せ（I）を空に書き直す。真ん中は __P50（月ごと） */
env.run(`__origEngine = appLegacyEngine_;
appLegacyEngine_ = function (svc) {
  const e = __origEngine(svc);
  e.runPhase1Forecast = function () {
    const out = svc.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('OUTPUT');
    const p = __P50;
    const tot = p.reduce((s, x) => s + x, 0);
    out.getRange(26, 1, 1, 4).setValues([['年度合計（予測）', tot * 0.9, tot, tot * 1.1]]);
    for (let i = 0; i < 12; i++) {
      out.getRange(29 + i, 2, 1, 3).setValues([[p[i] - 100, p[i], p[i] + 100]]);
      out.getRange(29 + i, 8, 1, 2).setValues([[p[i], '']]);
    }
  };
  return e;
};`);
const setP50 = (p) => env.run('__P50 = JSON.parse(__p)', { __p: JSON.stringify(p) });
const drafts = (planId) => env.table('BUDGET_DRAFTS').filter((r) => r.plan_id === planId);
const nums = (planId) => env.call(`appPlanNumbers_('${planId}')`);
const view = (planId) => env.call('apiPlanView(__in)', { __in: { planId } });
const save = (planId, rows, extra) => env.runJob('PLAN.EDIT', { planId, action: 'BUDGET.SAVE', args: Object.assign({ rows }, extra || {}), inputHash: view(planId).inputHash });
const rowsOf = (fy, adopted, uplift) => fyYms(fy).map((ym, i) => ({ row: 29 + i, adopted: adopted[i], uplift: uplift ? uplift[i] : '' }));

const FY = 2027;
const YMS = fyYms(FY);
const P0 = YMS.map((_, i) => 1000 + 20 * i);   // 月の真ん中（合計 13,320）
// 過去の売上: まるごとの年度は FY2024・FY2025 の 2 年（FY2023 の途中から取引が始まった: 2024/01 が最初の売上）。
// 今の年度 FY2026 は、A-2 が取り込むとおり 4〜9 月だけ（10 月からはまだ来ていない。終わっていない年度は数えない: 2026-10-09）
const salesA = {};
fyYms(2023).slice(9).forEach((ym) => { salesA[ym] = 500; });
fyYms(2024).forEach((ym, i) => { salesA[ym] = 100 + 10 * i; });
fyYms(2025).forEach((ym, i) => { salesA[ym] = i === 11 ? 800 : 200; });
fyYms(2026).slice(0, 6).forEach((ym) => { salesA[ym] = 5000; });
const planA = env.seedPlan(planBook('テスト製薬', FY, { p50: P0, sales: salesA }));

// ==== 1. 表の定義（4-1・4-2） ====
{
  assert.ok(env.call('APP_SCHEMA_VERSION') >= 11);
  const d = env.call('APP_TABLES.BUDGET_DRAFTS');
  assert.deepEqual(d.columns, ['plan_id', 'draft_id', 'action_id', 'ym', 'adopted', 'uplift', 'basis', 'prob', 'alloc', 'run_id', 'center', 'actor_email', 'saved_at']);
  assert.deepEqual([d.key, d.appendOnly], [['draft_id'], true]);
  const add = ['reach_final', 'reach_adopted', 'center', 'sd', 'tau', 'w', 'closed_months', 'prob_mode', 'prob_basis_json'];
  const v = env.call('APP_TABLES.PLAN_VERSIONS.columns');
  assert.deepEqual(v.slice(-9), add, '公式版の後ろに 9 列');
  assert.deepEqual(env.call('APP_ADDED_COLUMNS.PLAN_VERSIONS'), [{ version: 11, columns: add }]);
  assert.deepEqual(env.call('appBackfillNames_()').slice(-1), ['appV11BackfillBudgetDrafts_'], '版 11 の写しは版 10 の写しの後');
  assert.ok(env.table('_SCHEMA').some((r) => r.table === 'BUDGET_DRAFTS' && r.schema_version === String(env.call('APP_SCHEMA_VERSION'))));
}

// ==== 2. 予算の保存のたびに 12 行の下書き ====
{
  assert.equal(view(planA).boot.budgetDraft, null, '下書きが無ければ null（予算は月の真ん中のまま）');
  // 1 か月だけ直した保存（決め方を送らない前の画面）: 保存した後の 12 か月を写す・手で直した（MANUAL）
  const s1 = save(planA, [{ row: 29, adopted: 1500, uplift: 50 }]);
  assert.equal(s1.status, 'DONE', s1.error);
  assert.deepEqual(s1.result.draft, { basis: 'MANUAL', prob: null, alloc: 'MANUAL', months: 12 });
  let d = drafts(planA);
  assert.equal(d.length, 12, '12 か月分');
  assert.deepEqual(d.map((r) => r.ym), YMS);
  const act1 = d[0].action_id;
  assert.ok(d.every((r) => r.action_id === act1 && r.basis === 'MANUAL' && r.alloc === 'MANUAL' && r.prob === '' && r.actor_email === OWNER && r.run_id === ''));
  assert.deepEqual(d.map((r) => r.adopted), ['1500', ...P0.slice(1).map(String)], '直した月と、ほかの月は真ん中のまま');
  assert.deepEqual(d.map((r) => r.uplift), ['50', ...Array(11).fill('')], '上乗せの空は空');
  assert.deepEqual(d.map((r) => r.center), P0.map(String), '保存したときの月の真ん中');
  assert.ok(env.table('PLAN_ACTIONS').some((r) => r.action_id === act1 && r.action === 'BUDGET.SAVE'), '下書きの番号は予算の保存の番号');
  const bd = view(planA).boot.budgetDraft;
  assert.deepEqual([bd.basis, bd.prob, bd.alloc, bd.months, bd.centerAtDraft, bd.centerNow, bd.drift, bd.warn, bd.driftLimit], ['MANUAL', null, 'MANUAL', 12, sum(P0), sum(P0), 0, false, 0.1]);
  assert.deepEqual([bd.adopted, bd.uplift], [sum(P0) - 1000 + 1500, 50]);
  assert.ok(!('actor_email' in bd) && !JSON.stringify(bd).includes(OWNER), '保存した人は返さない');
  // だめな決め方・確率・割り振りは、何も書かずに止める
  const nDraft = env.table('BUDGET_DRAFTS').length, nAct = env.table('PLAN_ACTIONS').length;
  for (const [extra, re] of [[{ basis: 'GUESS' }, /予算の決め方/], [{ basis: 'PROB' }, /確率（50・60・70・80%）を選んで/], [{ basis: 'PROB', prob: 65 }, /50・60・70・80% のどれか/],
    [{ basis: 'PROB', prob: 90 }, /50・60・70・80% のどれか/], [{ basis: 'PROB', prob: true }, /50・60・70・80% のどれか/], [{ basis: 'MANUAL', alloc: 'EVEN' }, /月への割り振り/]]) {
    const st = save(planA, [{ row: 30, adopted: 999 }], extra);
    assert.equal(st.status, 'FAILED', JSON.stringify(extra));
    assert.match(st.error, re, JSON.stringify(extra));
  }
  assert.deepEqual([env.table('BUDGET_DRAFTS').length, env.table('PLAN_ACTIONS').length], [nDraft, nAct], '止めた保存は何も書かない');
  assert.equal(nums(planA).monthly[1].adopted, P0[1], '予算も変えない');
  // CENTER と申告しても、真ん中と違う月があれば MANUAL（保存した値を信じる）
  const s2 = save(planA, [{ row: 30, adopted: 1777 }], { basis: 'CENTER' });
  assert.equal(s2.status, 'DONE', s2.error);
  assert.equal(s2.result.draft.basis, 'MANUAL');
  // 真ん中に戻した保存（決め方を送らない）: CENTER・割り振りは予測の月の形・上乗せは空
  const s3 = save(planA, rowsOf(FY, P0));
  assert.deepEqual(s3.result.draft, { basis: 'CENTER', prob: null, alloc: 'FORECAST_SHAPE', months: 12 });
  // 確率を CENTER や MANUAL に添えても残さない（確率で選んだときだけ）
  const s4 = save(planA, [{ row: 31, adopted: 1111 }], { basis: 'MANUAL', prob: 70, alloc: 'PAST_SHAPE' });
  assert.deepEqual(s4.result.draft, { basis: 'MANUAL', prob: null, alloc: 'PAST_SHAPE', months: 12 });
  d = drafts(planA);
  assert.equal(d.length, 48, '保存 4 回で 48 行（消さずに足す）');
  assert.deepEqual(d.slice(0, 12).map((r) => r.adopted), ['1500', ...P0.slice(1).map(String)], '前の下書きは書き換えない');
}

// ==== 3. 予測し直しても下書きが戻る ====
const planB = env.seedPlan(planBook('別の製薬', FY, { p50: P0, sales: salesA }));
{
  const adopted = P0.map((x, i) => x + (i % 2 ? 300 : -100));
  const uplift = P0.map((_, i) => (i === 5 ? 0 : i === 11 ? 777 : ''));
  const st = save(planA, rowsOf(FY, adopted, uplift));
  assert.equal(st.status, 'DONE', st.error);
  const P1 = P0.map((x) => Math.round(x * 1.15));   // 予測が 15% 上がる
  setP50(P1);
  const before = env.table('BUDGET_DRAFTS').length;
  const f = env.runJob('FORECAST.RUN', { planId: planA });
  assert.equal(f.status, 'DONE', f.error);
  assert.equal(f.result.budgetRestored, 12, '12 か月を戻した');
  const n = nums(planA);
  assert.deepEqual(n.monthly.map((m) => m.p50), P1, '予測の数字は新しい回のもの（変えない）');
  assert.deepEqual(n.monthly.map((m) => m.adopted), adopted, '採用予測は下書きのまま（真ん中に戻らない）');
  assert.deepEqual(n.monthly.map((m) => m.uplift), uplift.map((u) => (u === '' ? null : u)), '上乗せも下書きのまま（0 は 0・空は空）');
  assert.deepEqual([n.budget.adopted, n.budget.uplift, n.budget.final], [sum(adopted), 777, sum(adopted) + 777], '公式版の数字（appPlanNumbers_）が下書きと同じ');
  assert.equal(env.table('BUDGET_DRAFTS').length, before, '予測し直しても下書きは足さない');
  // 画面: 年度の合計の数式（SUM）も下書きの値で計算する
  const sec = view(planA).boot.output.sections[0];
  assert.deepEqual([sec.annual.adopted, sec.annual.uplift, sec.annual.final], [sum(adopted), 777, sum(adopted) + 777]);
  // 予測が動いた大きさ: 下書きを作ったときの真ん中の合計 → 今の真ん中の合計（15% 上がった → 知らせる）
  const bd = view(planA).boot.budgetDraft;
  assert.deepEqual([bd.basis, bd.centerAtDraft, bd.centerNow], ['MANUAL', sum(P0), sum(P1)]);
  near(bd.drift, sum(P1) / sum(P0) - 1, 1e-12, 'drift');
  assert.equal(bd.warn, true, '10% 以上動いたら知らせる');
  // 同じ下書きのまま、もう一度予測し直しても同じ（今の下書きは同じ・二重にならない）
  setP50(P1);
  assert.equal(env.runJob('FORECAST.RUN', { planId: planA }).status, 'DONE');
  assert.deepEqual(nums(planA).monthly.map((m) => m.adopted), adopted);
  // 下書きを作ったときの予測の回と日時（下書きは予測の回の後に保存したもの）
  const s5 = save(planA, rowsOf(FY, adopted, uplift));
  const runs = env.table('FORECAST_RUNS').filter((r) => r.plan_id === planA);
  const lastRun = runs[runs.length - 1];
  assert.ok(drafts(planA).filter((r) => r.action_id === s5.result.actionId).every((r) => r.run_id === lastRun.run_id && r.center === String(P1[YMS.indexOf(r.ym)])));
  const bd2 = view(planA).boot.budgetDraft;
  assert.deepEqual([bd2.runId, bd2.runAt, bd2.drift, bd2.warn], [lastRun.run_id, lastRun.finished_at, 0, false]);
  // 少しだけ動いた（5%）なら知らせない
  setP50(P1.map((x) => x * 1.05));
  assert.equal(env.runJob('FORECAST.RUN', { planId: planA }).status, 'DONE');
  const bd3 = view(planA).boot.budgetDraft;
  near(bd3.drift, 0.05, 1e-9, '5%');
  assert.equal(bd3.warn, false);
  // 下書きの無い計画は旧来のとおり（採用予測 = 新しい真ん中・上乗せは空）
  setP50(P1);
  const fb = env.runJob('FORECAST.RUN', { planId: planB });
  assert.equal(fb.status, 'DONE', fb.error);
  assert.equal(fb.result.budgetRestored, 0);
  assert.deepEqual(nums(planB).monthly.map((m) => [m.adopted, m.uplift]), P1.map((x) => [x, null]), '初期値は中心');
  assert.equal(drafts(planB).length, 0, '手で直した跡の無い計画には写しを足さない');
  assert.equal(view(planB).boot.budgetDraft, null);
}

// ==== 4. 確率で選ぶ（予算に届く見込みと同じ届く金額。締まった月の無い先の年度） ====
const propose = (planId, prob, alloc) => env.call('apiBudgetProposal(__in)', { __in: { planId, prob, alloc } });
{
  setP50(P0);
  assert.equal(env.runJob('FORECAST.RUN', { planId: planB }).status, 'DONE');
  const shadow = env.call('apiForecastLatest(__in)', { __in: { planId: planB } }).shadow;
  assert.equal(shadow.reach.k, 0, '先の年度は締まった月が無い');
  // 過去の平均の形: FY2024 と FY2025 の月の割合の平均（FY2023 は取引が始まる前の月があり、FY2026 は終わっていないので使わない）
  const share = (fy) => { const v = fyYms(fy).map((ym) => salesA[ym] || 0); const t = sum(v); return v.map((x) => x / t); };
  const s24 = share(2024), s25 = share(2025);
  const avg = s24.map((x, i) => (x + s25[i]) / 2);
  for (const prob of [50, 60, 70, 80]) {
    const p = propose(planB, prob);
    const amount = shadow.reach.amounts.find((a) => a.pct === prob).amount;
    assert.deepEqual([p.prob, p.ok, p.alloc, p.mode, p.closedMonths, p.actualClosed, p.shapeYears, p.fallback], [prob, true, 'PAST_SHAPE', 'SHADOW', 0, 0, 2, false]);
    assert.equal(p.annual, Math.round(amount), prob + '% の年間 = 届く金額');
    assert.deepEqual(p.months.map((m) => m.ym), YMS);
    assert.equal(sum(p.months.map((m) => m.adopted)), p.annual, '月の合計 = 年間');
    assert.ok(allocated(p.months, p.annual, avg) && p.months.every((m) => m.closed === false), '過去の平均の形で割り振る');
    assert.equal(p.center, sum(P0));
    assert.match(p.basisText, /^試しの計算です。/);
    assert.match(p.basisText, new RegExp(prob + '% の見込みで届く年間の金額です'));
    assert.match(p.basisText, /過去 2 年の売上の月の形の平均/);
    assert.doesNotMatch(p.basisText, /P10|P50|P90|PAST_SHAPE|FORECAST_SHAPE|PROB|CENTER|τ|undefined|null|NaN/, '中の記号を出さない');
  }
  assert.ok(propose(planB, 80).annual < propose(planB, 50).annual, '確率が高いほど低い');
  // 予測の月の形
  const pf = propose(planB, 70, 'FORECAST_SHAPE');
  assert.deepEqual([pf.alloc, pf.fallback], ['FORECAST_SHAPE', false]);
  assert.ok(allocated(pf.months, pf.annual, P0), '予測の月の真ん中の形');
  assert.match(pf.basisText, /予測の月の形で割り振りました/);
  // だめな値は止める・閲覧の人も見られる（読むだけ）
  assert.throws(() => propose(planB, 90), /50・60・70・80% のどれか/);
  assert.throws(() => propose(planB, undefined), /確率（50・60・70・80%）を選んで/);
  assert.throws(() => propose(planB, 70, 'MANUAL'), /過去の平均の形」か「予測の月の形/);
  env.as(OUTSIDER);
  assert.throws(() => propose(planB, 70), /権限/, '社外の人は見られない');
  env.as(MEMBER);
  assert.equal(propose(planB, 70).annual, propose(planB, 70).annual, '社内の人（閲覧）は見られる');
  env.as(OWNER);
  // 案を、ふつうの予算の保存で basis = PROB と添えて保存する（上乗せはそのまま）
  const p70 = propose(planB, 70);
  const up = P0.map((_, i) => (i === 0 ? 40 : ''));
  const st = save(planB, p70.months.map((m) => ({ row: 29 + YMS.indexOf(m.ym), adopted: m.adopted, uplift: up[YMS.indexOf(m.ym)] })), { basis: 'PROB', prob: 70, alloc: p70.alloc });
  assert.equal(st.status, 'DONE', st.error);
  assert.deepEqual(st.result.draft, { basis: 'PROB', prob: 70, alloc: 'PAST_SHAPE', months: 12 });
  assert.ok(drafts(planB).every((r) => r.basis === 'PROB' && r.prob === '70' && r.alloc === 'PAST_SHAPE'));
  assert.deepEqual(nums(planB).monthly.map((m) => m.adopted), p70.months.map((m) => m.adopted));
  assert.equal(nums(planB).budget.adopted, p70.annual);
  assert.deepEqual([view(planB).boot.budgetDraft.basis, view(planB).boot.budgetDraft.prob, view(planB).boot.budgetDraft.alloc], ['PROB', 70, 'PAST_SHAPE']);
  // 本番になった計画（決定 4・7 の後。appPlanAlignedLive_ は Portfolio.js）は試しと書かない
  // 本物では、本番にする記録を書くとデータ本体の版の印が変わり、読んだ結果の控えも変わる。ここでは印を変えて同じにする
  // 本物の appPlanAlignedLive_（Portfolio.js）を控えて差し替え、後で戻す（関数の宣言は delete では消せない）
  env.run('globalThis.__liveOrig = appPlanAlignedLive_; appPlanAlignedLive_ = function (plan) { return plan.plan_id === __id; }; appBumpGen_();', { __id: planB });
  const live = propose(planB, 60);
  assert.equal(live.mode, 'LIVE');
  assert.doesNotMatch(live.basisText, /試し/);
  assert.equal(propose(planA, 60).mode, 'SHADOW', 'ほかの計画は試しのまま');
  env.run('appPlanAlignedLive_ = globalThis.__liveOrig; appBumpGen_();');
  assert.equal(propose(planB, 60).mode, 'SHADOW');
  // まるごとの年度が 1 年しかなければ、予測の月の形にして、そう書く
  const sales1 = {};
  fyYms(2025).forEach((ym, i) => { sales1[ym] = 300 + i; });
  const planC = env.seedPlan(planBook('一年製薬', FY, { p50: P0, sales: sales1 }));
  const pc = propose(planC, 60);
  assert.deepEqual([pc.ok, pc.alloc, pc.fallback, pc.shapeYears], [true, 'FORECAST_SHAPE', true, 1]);
  assert.match(pc.basisText, /過去の売上が 2 年分そろわないので、予測の月の形で割り振りました/);
  // 測る専用の計画は予算を立てない
  env.call(`appWithLock_(() => appUpdateByKey_('PLANS', { plan_id: '${planC}' }, { purpose: 'MEASURE' }, APP_ROW_UNCHECKED, '${OWNER}'))`);
  assert.throws(() => propose(planC, 60), /この計画では予算を設定できません/);
}

// ==== 4b. 年度の途中（締まった 6 か月）: 締まった月は実績のまま、残りの月に割り振る ====
{
  const fy = 2026, yms = fyYms(fy);
  const P = yms.map(() => 1000);
  const cmp = Object.fromEntries(yms.slice(0, 6).map((ym, i) => [ym, 900 + 10 * i]));   // 4〜9 月の実績（合計 5,550）
  const sales = {};
  [2024, 2025].forEach((y) => fyYms(y).forEach((ym, i) => { sales[ym] = 100 + (i < 6 ? 0 : 100); }));   // 後半が重い
  const planM = env.seedPlan(planBook('途中製薬', fy, { p50: P, sales, cmp }));
  const sh = env.call('apiForecastLatest(__in)', { __in: { planId: planM } }).shadow;
  assert.equal(sh.reach.k, 6);
  assert.equal(sh.reach.actualYtd, 5550);
  const p = propose(planM, 70);
  assert.equal(p.ok, true, p.basisText);
  assert.deepEqual([p.closedMonths, p.actualClosed], [6, 5550]);
  assert.equal(p.annual, Math.round(sh.reach.amounts.find((a) => a.pct === 70).amount));
  assert.deepEqual(p.months.slice(0, 6).map((m) => [m.adopted, m.closed]), yms.slice(0, 6).map((ym) => [cmp[ym], true]), '締まった月は実績のまま');
  const rest = p.annual - 5550;
  assert.equal(sum(p.months.slice(6).map((m) => m.adopted)), rest, '残りの月 = 年間 − 締まった月の実績');
  assert.ok(p.months.slice(6).every((m) => !m.closed) && allocated(p.months.slice(6), rest, Array(6).fill(1)), '残りの月は過去の形（後半は同じ重み）で等しく');
  assert.match(p.basisText, /締まった 6 か月は実績のまま、残りの 6 か月に割り振りました/);
  // 実績が遅れている（B-2 が古い）・予測が無い計画は、確率から選べない
  const planN = env.seedPlan(env.makeBook('予測なし', { CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', '予測なし'], ['[必須] 予測年度FY（YYYY）', FY], ['[必須] 担当者（カンマ区切り）', '鷹野']] } }));
  const pn = propose(planN, 70);
  assert.deepEqual([pn.ok, pn.annual, pn.months], [false, null, []]);
  assert.match(pn.basisText, /着地見込みがまだ出ていないので、確率からは選べません/);
}

// ==== 5. 公式版を出すと、届く見込みと前提の列が入る（出した後は変えない） ====
{
  const shadow = env.call('apiForecastLatest(__in)', { __in: { planId: planB } }).shadow;
  const n = nums(planB);
  const sub = env.call('appTestVersionSubmit_(__in)', { __in: { planId: planB, note: '確率 70%' } });
  const Phi = (x) => env.call(`appNormCdf_(${x})`);
  const rc = sub.version.reach;
  assert.deepEqual([rc.mode, rc.closedMonths, rc.tau, rc.w], ['SHADOW', 0, 0.15, 1]);
  near(rc.center, shadow.reach.center, 1e-9, '中心 = 着地の分布の中心');
  near(rc.center, sum(P0), 1e-9, '締まった月が無ければ、月の真ん中の合計');
  near(rc.sd, shadow.reach.sd, 1e-9, '幅');
  near(rc.final, Phi((rc.center - n.budget.final) / rc.sd), 1e-12, '最終予算に届く見込み');
  near(rc.adopted, Phi((rc.center - n.budget.adopted) / rc.sd), 1e-12, '採用予測に届く見込み');
  near(rc.adopted, 0.7, 0.02, '70% で選んだ採用予測に届く見込みはほぼ 70%');
  assert.ok(rc.final < rc.adopted, '上乗せ（挑戦）の分だけ届きにくい');
  const row = env.table('PLAN_VERSIONS').find((v) => v.version_id === sub.version.versionId);
  const basis = JSON.parse(row.prob_basis_json);
  const lastRun = env.table('FORECAST_RUNS').filter((r) => r.plan_id === planB).slice(-1)[0];
  assert.deepEqual([basis.formula, basis.runId, basis.actualClosed, basis.monthCenterSum, row.prob_mode], ['LANDING_DIST_V1', lastRun.run_id, 0, sum(P0), 'SHADOW']);
  // 承認しても、後から予算を変えても、出した版の列は変わらない
  const cols = ['reach_final', 'reach_adopted', 'center', 'sd', 'tau', 'w', 'closed_months', 'prob_mode', 'prob_basis_json'];
  const keep = Object.fromEntries(cols.map((c) => [c, row[c]]));
  env.call('appTestVersionDecide_(__in)', { __in: { versionId: sub.version.versionId, decision: 'APPROVED', note: 'ok', rowVersion: sub.version.rowVersion } });
  assert.equal(save(planB, [{ row: 29, adopted: 1 }]).status, 'DONE');
  const after = env.table('PLAN_VERSIONS').find((v) => v.version_id === sub.version.versionId);
  assert.equal(after.state, 'APPROVED');
  assert.deepEqual(Object.fromEntries(cols.map((c) => [c, after[c]])), keep, '出した後は変えない');
  // 一覧: 版ごとの reach（承認する人が見て判断する）。前の版（列が空）は null
  env.run(`appInsertRows_('PLAN_VERSIONS', [{ version_id: 'VER-OLD', plan_id: '${planB}', version_no: 0, state: 'SUPERSEDED', budget_final: 900, submitted_by: '${OWNER}', row_version: 1 }])`);
  const list = env.call('apiVersionList(__in)', { __in: { planId: planB } });
  const v1 = list.versions.find((v) => v.versionId === sub.version.versionId);
  assert.deepEqual(v1.reach, rc);
  assert.equal(list.versions.find((v) => v.versionId === 'VER-OLD').reach, null);
  // 本番の計画（appPlanAlignedLive_ が真）は LIVE
  env.run('globalThis.__liveOrig = appPlanAlignedLive_; appPlanAlignedLive_ = function () { return true; }; appBumpGen_();');
  const sub2 = env.call('appTestVersionSubmit_(__in)', { __in: { planId: planB } });
  assert.equal(sub2.version.reach.mode, 'LIVE');
  env.run('appPlanAlignedLive_ = globalThis.__liveOrig; appBumpGen_();');
  // 着地見込みが出ていない計画（今の年度で、実績を取り込んでいない = 実績の遅れ）も出せる（数は空で、理由を残す）
  const stale = env.seedPlan(env.makeBook('遅れ製薬', { CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', '遅れ製薬'], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    OUTPUT: { values: (() => { const o = [['FY2026']]; for (let r = 2; r <= 25; r++) o.push([]); o.push(['年度合計（予測）', 1, 2, 3], [], []); fyYms(2026).forEach((ym) => o.push([ym, 1, 2, 3, '', '', '', 2, ''])); return o; })(), formats: { A: '@' } } }));
  assert.equal(env.call('apiForecastLatest(__in)', { __in: { planId: stale } }).shadow.reach, null, '前提: 着地見込みが無い');
  const s3 = env.call('appTestVersionSubmit_(__in)', { __in: { planId: stale } });
  assert.deepEqual([s3.version.reach.final, s3.version.reach.center, s3.version.reach.mode], [null, null, 'SHADOW']);
  assert.equal(JSON.parse(env.table('PLAN_VERSIONS').find((v) => v.version_id === s3.version.versionId).prob_basis_json).missing, 'no_landing');
}

// ==== 6. 控えを書き直しても、下書きは二重にならない（キーは保存の番号と月から決まる） ====
{
  const rows = env.call(`appReadPlanTable_('BUDGET_DRAFTS', '${planA}').map(appStripRow_)`);
  const n0 = env.table('BUDGET_DRAFTS').length;
  const added = env.call(`appWithLock_(() => appAppendLogRows_('BUDGET_DRAFTS', __r, []))`, { __r: rows.slice(0, 12) });
  assert.deepEqual([added.length, env.table('BUDGET_DRAFTS').length], [0, n0]);
  assert.equal(env.call(`appStableLogId_('BDR', ['ACT-1', '2027/04'])`), env.call(`appStableLogId_('BDR', ['ACT-1', '2027/04'])`));
  assert.equal(env.table('BUDGET_DRAFTS').filter((r) => r.actor_email.indexOf('SYSTEM:') === 0).length, 0, '写しの行はまだ無い');
  assert.deepEqual(env.errors().filter((e) => /BUDGET_DRAFTS/.test(e.where)).map((e) => e.message), [], '下書きのエラーは無い');
}

// ==== 7. 仮の予算策定（seedDummyBudgets）: 測る専用は印を外して入力と予算を書く。確定版・手で直した予算は触らない ====
{
  const beforeA = nums(planA).monthly.map((m) => [m.adopted, m.uplift]);
  const planB = env.seedPlan(planBook('別の製薬', FY, { p50: P0, sales: salesA }));
  const planM = env.seedPlan(planBook('測る製薬', FY, { p50: P0, sales: salesA }));
  env.props.OWNER_TASK = JSON.stringify({ action: 'setPlanPurpose', planId: planM, purpose: 'MEASURE' });
  const setM = env.call('apiOwnerTask()');
  assert.equal(setM.ok, true, JSON.stringify(setM));
  assert.equal(env.table('PLANS').filter((p) => p.plan_id === planM)[0].purpose, 'MEASURE');
  env.props.OWNER_TASK = JSON.stringify({ action: 'seedDummyBudgets', fy: FY });
  const full = env.call('apiOwnerTask()');
  assert.equal(full.ok, true, JSON.stringify(full));
  const filled = full.result.filled || [];
  const skipped = full.result.skipped || [];
  assert.ok(filled.some((x) => x.planId === planB && (x.did || []).includes('budget')), '未編集の計画は仮予算を書く');
  const aHit = filled.concat(skipped).find((x) => x.planId === planA);
  assert.ok(aHit && (aHit.reason === 'edited' || aHit.reason === 'done' || aHit.skippedBudget === 'edited'), '手で直した予算は上書きしない: ' + JSON.stringify(aHit));
  assert.deepEqual(nums(planA).monthly.map((m) => [m.adopted, m.uplift]), beforeA);
  const mHit = filled.find((x) => x.planId === planM);
  assert.ok(mHit && (mHit.did || []).includes('purpose') && (mHit.did || []).includes('budget'), '測る専用は印を外して仮予算を書く: ' + JSON.stringify(mHit));
  assert.equal(env.table('PLANS').filter((p) => p.plan_id === planM)[0].purpose, '');
  assert.ok(env.call(`appReadPlanTable_('ENG_CLIENT', '${planM}')`).length, '動向の仮入力がある');
  assert.ok(env.call(`appReadPlanTable_('ENG_OPINIONS', '${planM}')`).length, '見解の仮入力がある');
  assert.ok(env.call(`appReadPlanTable_('ENG_DEV_SPOT', '${planM}')`).length, 'スポットの仮入力がある');
  const n = nums(planB);
  assert.equal(n.monthly.length, 12);
  assert.ok(n.monthly.every((m) => Number.isInteger(m.adopted) && m.adopted >= 0), '仮予算の採用予測が入る');
  const afterB = n.monthly.map((m) => [m.adopted, m.uplift]);
  env.props.OWNER_TASK = JSON.stringify({ action: 'seedDummyBudgets', fy: FY });
  const again = env.call('apiOwnerTask()');
  assert.ok(!(again.result.filled || []).some((x) => x.planId === planB && (x.did || []).includes('budget')), '2 回目は予算を書き直さない');
  assert.ok((again.result.skipped || []).some((x) => x.planId === planB && x.reason === 'done'), '済んだ計画は done として飛ばす');
  assert.deepEqual(nums(planB).monthly.map((m) => [m.adopted, m.uplift]), afterB);
}

console.log('app-v11-drafts: all tests passed');
