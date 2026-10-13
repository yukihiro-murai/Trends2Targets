#!/usr/bin/env node
/*
 * app-hit-baseline.test.mjs — 当たりの基準（2026-10-13 村井さん承認）。当たる割合を 50% ではなく
 * 「いつも同じ向きと言った場合に当たる割合」（基準）と比べる。
 *   1. 基準の式: 計画の比べられた月の外れの向きの割合を、月が少なければ全計画の割合へ寄せる（3 か月ぶん。四半期の記録は 1 四半期ぶん）
 *   2. 人の学びの当たり: 統計だけの予測が低めの計画で、いつも上と言う人は 75% 当たっても「いつも同じ向きより当たっている」と言わない。
 *      向きを読める人は言う。逆の人は「外れている」。並びは 80% の区間の下の端と基準の差。事前分布は基準を中心にする
 *   3. AI の学びの曲線: 種類ごとの基準・四半期ごとの基準・基準の線
 *   4. 当たりの記録（四半期）: 人ごと・AI 調査ごとに基準で当たるはずの数と、古さの重みを掛けた基準の割合
 *   5. 数字に効く所: 旧来の C-1 は基準を引いた当たる割合を RELIABILITY_EVIDENCE に書き（note に基準で当たるはずの数）、信頼度の案もそれで作る。
 *      全計画の事前分布（LEARN.POOL）は基準を引いた当たりで作り、全計画の外れの向きの割合（hit_base）も書く。C-1 はそれで基準を寄せる。
 *      基準の無い前の行は読み飛ばす（消さない）
 *   6. 画面: 「当てずっぽう」と言わない。基準の印・上回る／下回るの札・基準の列
 * 数字はテスト用の作りもの。モックの上の確かめで、本物の Apps Script の上では動かしていない。
 *
 *   node app/tests/app-hit-baseline.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setUpEnv, uiHtml, OWNER, J } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const close = (a, b, eps = 1e-9, msg = '') => {
  assert.ok(typeof a === 'number' && typeof b === 'number', `${msg} 数ではない: ${a} / ${b}`);
  assert.ok(Math.abs(a - b) < eps, `${msg} ${a} ≈ ${b}`);
};
const env = setUpEnv();
const H = env.run('(() => { const o = {}; Object.keys(APP_ENGINE_SHEETS).forEach(k => { o[k] = APP_ENGINE_SHEETS[k].header || null; }); return o; })()');
const row = (sheet, o) => H[sheet].map((h) => (o[h] === undefined ? '' : o[h]));
const POLICY = env.run('APP_EVAL_POLICY_VERSION');

// ==== 1. 基準の式 ====
{
  close(env.call('appHitBaseShare_(__c)', { __c: { A: [5, 1], B: [4, 2] } }), 9 / 12);
  assert.equal(env.call('appHitBaseShare_({})'), 0.5, '比べられた月が無ければ半々');
  const r = env.call('appHitBaseRates_([5, 1], 0.75, 3)');
  close(r.up, (5 + 3 * 0.75) / 9); close(r.down, 1 - (5 + 3 * 0.75) / 9);
  close(env.call('appHitBaseRates_([0, 0], 0.75, 3)').up, 0.75, 1e-12, '月が無ければ全計画の割合');
  close(env.call('appHitBaseRates_([2, 1], 0.9, 0)').up, 2 / 3, 1e-12, '寄せる強さ 0 なら計画の割合のまま');
  close(env.call('appHitBaseRates_([0, 0], 0.9, 0)').up, 0.5, 1e-12);
  assert.deepEqual([env.call('appHitBaseOf_({ up: 0.8, down: 0.2 }, 1)'), env.call('appHitBaseOf_({ up: 0.8, down: 0.2 }, -0.05)'), env.call('appHitBaseOf_({ up: 0.8, down: 0.2 }, 0)')],
    [0.8, 0.2, null]);
  assert.equal(env.run('APP_HIT_BASE_MONTHS'), 3);
}

// ==== 2・3. 人の学び・AI の学び: 統計だけの予測が低めの 2 計画 ====
// 実績はどの月も 1000。統計だけの予測は 900（実績が上に外れる）か 1100（下に外れる）。
// 甲: 4〜8 月 上・9 月 下（[5, 1]）。乙: 4〜7 月 上・8・9 月 下（[4, 2]）。全計画の上の割合 9/12
const YMS = ['2026/04', '2026/05', '2026/06', '2026/07', '2026/08', '2026/09'];
const UP = { 甲製薬: [1, 1, 1, 1, 1, -1], 乙製薬: [1, 1, 1, 1, -1, -1] };
const runAt = D(2026, 3, 20);
const config = (client) => ({ values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '上田,読田,逆田']] });
const evalLog = (client) => [H.EVAL_LOG].concat(...YMS.map((ym, i) => [['nega', 950], ['neutral', 1000], ['posi', 1050]].map(([sc, p]) => row('EVAL_LOG', {
  eval_id: 'E' + i + sc, evaluated_at: D(2026, 10, 6, 12), client, target_month: ym, scenario: sc, pred: p, actual: 1000, evaluation_policy_version: POLICY, constraint_relevant_flag: 1 }))));
const impact = (client) => [H.AI_IMPACT_HISTORY].concat(YMS.map((ym, i) => row('AI_IMPACT_HISTORY', { run_id: 'R1', run_at: runAt, client, target_month: ym, k_ai: 1,
  ai_direction: 'flat', pred_p50: 1000, pred_p50_quant_only: UP[client][i] > 0 ? 900 : 1100, forecast_source: 'forecast_open' })));
/** 押し: 上田 = いつも上・読田 = 外れる向きを毎月当てる・逆田 = 毎月逆 */
const pushes = (client) => [H.SUBJECTIVE_IMPACT_HISTORY].concat(...YMS.map((ym, i) => [['上田', 1], ['読田', UP[client][i]], ['逆田', -UP[client][i]]].map(([key, dir]) =>
  row('SUBJECTIVE_IMPACT_HISTORY', { run_id: 'R1', run_at: runAt, client, target_month: ym, source_type: 'opinion', source_key: key, push_step: dir * 0.05, push_direction: dir,
    applied_reliability_r: 1, forecast_source: 'forecast_open' }))));
const status = (client) => ({ values: [H.PROCESS_STATUS, ['step2_status', D(2026, 10, 6, 10), 'owner', 'success', client, 10, ''],
  ['step5_status', D(2026, 10, 6, 12), 'owner', 'success', client, 10, '']] });
const plan = (e, client) => e.seedPlan(e.makeBook(client, {
  CONFIG: config(client), EVAL_LOG: { values: evalLog(client), formats: { D: '@' } }, AI_IMPACT_HISTORY: { values: impact(client) },
  SUBJECTIVE_IMPACT_HISTORY: { values: pushes(client), formats: { D: '@' } }, PROCESS_STATUS: status(client), POOL_PRIOR: { values: [H.POOL_PRIOR] } }));
const KO = plan(env, '甲製薬'), OTSU = plan(env, '乙製薬');
const upKo = (5 + 3 * 0.75) / 9, upOtsu = (4 + 3 * 0.75) / 9;
{
  const pl = env.call('apiPeopleLearning()');
  const S = pl.scoreboard;
  const get = (key) => S.find((s) => s.key === key);
  // いつも上: 12 か月で 9 当たり（75%）。基準で当たるはずの数も 6 × 甲の上 + 6 × 乙の上 = 9（全計画の割合に寄せても、合計は同じ）
  const ue = get('上田');
  assert.deepEqual([ue.n, ue.hit], [12, 9]);
  close(ue.expected, 6 * upKo + 6 * upOtsu, 1e-12); close(ue.expected, 9, 1e-12);
  close(ue.base, 0.75, 1e-12);
  // 事前分布（POOL_PRIOR が無い）: 基準 0.75 を中心に強さ 4 → Beta(3, 1)。事後 Beta(12, 4)
  close(ue.prior.alpha0, 3, 1e-12); close(ue.prior.beta0, 1, 1e-12);
  assert.equal(ue.prior.from, 'default');
  close(ue.alpha, 12, 1e-12); close(ue.beta, 4, 1e-12);
  assert.ok(ue.ci80[0] > 0.5, '前提: 半々と比べれば「当たっている」ように見える（前の言い方なら当てずっぽうより当たっていると言った）');
  assert.equal(ue.vsBase, '', 'いつも上と言うだけなら、いつも同じ向きより当たっているとは言わない');
  assert.ok(ue.ci80[0] < ue.base && ue.base < ue.ci80[1]);
  // 読める人: 12 か月とも当たり。基準 = 押した向きの割合の合計（甲 上 5・下 1、乙 上 4・下 2）
  const yo = get('読田');
  const yoExp = 5 * upKo + (1 - upKo) + 4 * upOtsu + 2 * (1 - upOtsu);
  assert.deepEqual([yo.n, yo.hit], [12, 12]);
  close(yo.expected, yoExp, 1e-12);
  close(yo.prior.alpha0, 4 * yoExp / 12, 1e-12);
  assert.equal(yo.vsBase, 'above', '向きを読める人は、いつも同じ向きより当たっている');
  assert.ok(yo.ci80[0] > yo.base);
  // 逆の人: 当たり 0
  const gy = get('逆田');
  assert.deepEqual([gy.n, gy.hit], [12, 0]);
  close(gy.expected, 12 - yoExp, 1e-12);
  assert.equal(gy.vsBase, 'below', 'いつも同じ向きより外れている');
  // 並び: 80% の区間の下の端と基準の差が大きい順（読田 → 上田 → 逆田）
  assert.deepEqual(S.map((s) => s.key), ['読田', '上田', '逆田']);
  // 計画ごとの基準で当たるはずの数
  assert.deepEqual(ue.plans.map((p) => [p.clientName, p.n, p.hit, Math.round(p.expected * 1e9) / 1e9]).sort(),
    [['乙製薬', 6, 4, Math.round(6 * upOtsu * 1e9) / 1e9], ['甲製薬', 6, 5, Math.round(6 * upKo * 1e9) / 1e9]]);

  // AI の学び: 見解の曲線。基準 = 36 回の押しの基準の平均。事前分布は基準を中心に強さ 4
  const ai = env.call('apiAiLearning()');
  const op = ai.curves.find((c) => c.type === 'opinion');
  const allExp = 9 + yoExp + (12 - yoExp);
  close(op.expected, allExp, 1e-9); close(op.base, allExp / 36, 1e-12);
  assert.deepEqual([op.n, op.hit, op.prior.from], [36, 21, 'default']);
  close(op.prior.mean, allExp / 36, 1e-12, '最初の見立ては基準');
  assert.deepEqual(op.quarters.map((q) => [q.quarter, q.n, q.hit, q.cumN]), [['FY2026-Q1', 18, 12, 18], ['FY2026-Q2', 18, 9, 36]]);
  close(op.quarters[1].base, op.base, 1e-12, '最後の四半期の基準 = 全部の基準');
  // 種類がまとまった閲覧の人の当たり（同じ式）
  const sum = env.run(`appSourceScoreboard_(appInsightPlans_(), __e, {}, {}, true)`, { __e: env.call('appInsightEvidence_(__ids, appInsightTables_(__ids))', { __ids: [KO, OTSU] }) });
  const so = J(sum).find((s) => s.type === 'opinion');
  assert.deepEqual([so.n, so.hit, so.sources], [36, 21, 3]);
  close(so.base, op.base, 1e-12);
}

// ==== 4. 当たりの記録（四半期）: 人ごと・AI 調査ごとの基準 ====
{
  const at = '2026-10-07T10:00:00+0900';
  const pl = J(env.table('PLANS'));
  const cid = (id) => pl.find((p) => p.plan_id === id).client_id;
  const rec = (planId, quarter, kind, key, push, dir, hit) => ({ plan_id: planId, hit_id: 'HIT-' + [planId, kind, key, quarter].join('-'), client_id: cid(planId), quarter, source_kind: kind,
    source_key: key, person_email: '', months_json: '[]', push, actual_dir: dir, hit, n_months: 3, policy_version: POLICY, calc_version: 'HIT-V1', computed_at: at, computed_by: OWNER });
  // 四半期の外れの向き: 甲 Q1 上・Q2 上、乙 Q1 上・Q2 下 → 全計画の上の割合 3/4。1 四半期ぶん寄せる: 甲 上 (2 + 0.75) / 3・乙 上 (1 + 0.75) / 3
  env.run('appWithLock_(() => appInsertRows_("HIT_RECORDS", __r))', { __r: [
    rec(KO, 'FY2026-Q1', 'QUARTER', '', null, 1, 0), rec(KO, 'FY2026-Q2', 'QUARTER', '', null, 1, 0),
    rec(OTSU, 'FY2026-Q1', 'QUARTER', '', null, 1, 0), rec(OTSU, 'FY2026-Q2', 'QUARTER', '', null, -1, 0),
    rec(KO, 'FY2026-Q1', 'PERSON', '上田', 0.05, 1, 1), rec(KO, 'FY2026-Q2', 'PERSON', '上田', 0.05, 1, 1),
    rec(OTSU, 'FY2026-Q1', 'PERSON', '上田', 0.05, 1, 1), rec(OTSU, 'FY2026-Q2', 'PERSON', '上田', 0.05, -1, 0),
    rec(OTSU, 'FY2026-Q2', 'PERSON', '下川', -0.02, -1, 1),
    rec(KO, 'FY2026-Q2', 'AI_RESEARCH', 'A4-X', 0.01, 1, 1),
  ] });
  const kU = (2 + 0.75) / 3, oU = (1 + 0.75) / 3;
  const h = env.call('apiPeopleLearning()').hits;
  const ue = h.people.find((p) => p.name === '上田');
  assert.deepEqual([ue.n, ue.hit], [4, 3]);
  close(ue.expected, 2 * kU + 2 * oU, 1e-12, 'いつも上: 4 四半期で 3 当たり。基準で当たるはずの数も 3');
  close(ue.expected, 3, 1e-12);
  const cur = env.run('appHitQuarterIndex_(appInsightQuarter_(Utilities.formatDate(new Date(), APP_TZ, "yyyy/MM")))');
  const w = (q) => env.run('appHitWeight_(__q, __c)', { __q: q, __c: cur });
  const sw = 2 * w('FY2026-Q1') + 2 * w('FY2026-Q2');
  close(ue.base, (w('FY2026-Q1') * (kU + oU) + w('FY2026-Q2') * (kU + oU)) / sw, 1e-12, '割合と同じ古さの重み');
  close(ue.rate, (2 * w('FY2026-Q1') + w('FY2026-Q2')) / sw, 1e-12);
  assert.deepEqual(ue.quarters.map((q) => [q.quarter, q.clientName, Math.round(q.base * 1e9) / 1e9]),
    [['FY2026-Q2', '乙製薬', Math.round(oU * 1e9) / 1e9], ['FY2026-Q2', '甲製薬', Math.round(kU * 1e9) / 1e9], ['FY2026-Q1', '乙製薬', Math.round(oU * 1e9) / 1e9],
      ['FY2026-Q1', '甲製薬', Math.round(kU * 1e9) / 1e9]]);
  const sh = h.people.find((p) => p.name === '下川');
  close(sh.expected, 1 - oU, 1e-12, '下に押した四半期は下の基準');
  const r = env.call('apiAiLearning()').research.research.find((x) => x.planId === KO);
  close(r.expected, kU, 1e-12, 'AI 調査の当たりも同じ基準');
  close(r.quarters[0].base, kU, 1e-12);
  // 四半期の印がまだ無い計画は、全計画の割合（記録の hit は変えない）
  const only = J(env.run('appHitWithBase_(__r, {})', { __r: [{ plan_id: 'X', push: 0.1 }] }));
  close(only[0].base, 0.5, 1e-12);
}

// ==== 5. 数字に効く所: 旧来の C-1 と全計画の事前分布 ====
{
  const e = setUpEnv();
  const He = e.run('(() => { const o = {}; Object.keys(APP_ENGINE_SHEETS).forEach(k => { o[k] = APP_ENGINE_SHEETS[k].header || null; }); return o; })()');
  const rw = (sheet, o) => He[sheet].map((h) => (o[h] === undefined ? '' : o[h]));
  const CL = (n) => 'テスト製薬' + n;
  /** C-1 が動く計画: 4〜6 月の実績（4 月 上・5 月 下・6 月 上に外れた）、鷹野（毎月当てる）・佐藤（いつも上）の押し。evidence = 前からある RELIABILITY_EVIDENCE の行 */
  const MONTHS = [['2026/04', 1200], ['2026/05', 800], ['2026/06', 1050]];
  const reviewPlan = (client, evidence) => {
    const evalRows = [He.EVAL_LOG].concat(...MONTHS.map(([ym, act], i) => [['nega', 950], ['neutral', 1000], ['posi', 1050]].map(([sc, p]) => rw('EVAL_LOG', {
      eval_id: 'E' + i + sc, evaluated_at: D(2026, 9, 1), client, target_month: ym, scenario: sc, pred: p, actual: act, evaluation_policy_version: POLICY,
      constraint_relevant_flag: sc === 'neutral' ? 1 : 0 }))));
    const run1 = D(2026, 3, 20);
    const imp = (m) => rw('AI_IMPACT_HISTORY', { run_id: 'R1', run_at: run1, client, target_month: D(2026, m), k_ai: 1, ai_direction: 'flat', pred_p50: 1000, pred_p50_quant_only: 1000,
      forecast_source: 'forecast_open' });
    const push = (m, key, dir) => rw('SUBJECTIVE_IMPACT_HISTORY', { run_id: 'R1', run_at: run1, client, target_month: D(2026, m), source_type: 'opinion', source_key: key,
      push_step: dir * 0.05, push_direction: dir, applied_reliability_r: 1, forecast_source: 'forecast_open' });
    return e.seedPlan(e.makeBook(client, {
      CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野,佐藤']] },
      PROCESS_STATUS: { values: [He.PROCESS_STATUS, ['step2_status', D(2026, 7, 10), 'owner', 'success', client, 3, ''], ['step5_status', D(2026, 9, 1), 'owner', 'success', client, 3, '']] },
      RUN_LOG: { values: [He.RUN_LOG] },
      EVAL_LOG: { values: evalRows, formats: { D: '@' } },
      ACTUAL_EVAL_MONTHLY: { values: [He.ACTUAL_EVAL_MONTHLY].concat(MONTHS.map(([ym, act]) => [client, 'BASE', '製品A', ym, act, 'closed', D(2026, 7, 10)])), formats: { D: '@' } },
      AI_IMPACT_HISTORY: { values: [He.AI_IMPACT_HISTORY, imp(4), imp(5), imp(6)] },
      SUBJECTIVE_IMPACT_HISTORY: { values: [He.SUBJECTIVE_IMPACT_HISTORY, push(4, '鷹野', 1), push(5, '鷹野', -1), push(6, '鷹野', 1), push(4, '佐藤', 1), push(5, '佐藤', 1), push(6, '佐藤', 1)] },
      AI_SCORE_HISTORY: { values: [He.AI_SCORE_HISTORY] },
      CALIBRATION_STATE: { values: [He.CALIBRATION_STATE, [client, D(2026, 9, 1), 'owner', '', '', '[]', 1, '', '{}', '', '', 1, '']] },
      CALIBRATION_HISTORY: { values: [He.CALIBRATION_HISTORY] },
      SOURCE_RELIABILITY: { values: [He.SOURCE_RELIABILITY] },
      POOL_PRIOR: { values: [He.POOL_PRIOR] },
      QUARTERLY_REVIEW: { values: [['']] },
      QUARTERLY_REVIEW_LOG: { values: [He.QUARTERLY_REVIEW_LOG] },
      RELIABILITY_EVIDENCE: { values: [He.RELIABILITY_EVIDENCE].concat(evidence.map(([key, n, hit, note]) => [client, 'opinion', key, 'FY2026-Q1', '2026/06', n, hit, hit / n, D(2026, 9, 2), 'R0', note])) },
    }));
  };
  // 前からある当たりの行: 甲 = 基準つき（いつも上と同じだけ当たった 8/10・基準 8）と基準の無い前の行、乙 = 基準つき（10 回で 9 当たり・基準 6）
  const P1 = reviewPlan(CL('甲'), [['a', 10, 8, 'expected=8.0000'], ['old', 10, 10, '']]);
  const P2 = reviewPlan(CL('乙'), [['b', 10, 9, 'expected=6.0000']]);
  const pv = e.task('poolPreview()');
  const op = pv.types.find((t) => t.type === 'opinion');
  assert.deepEqual([op.ok, op.plans, op.n, op.hit, pv.noBaseEvidence, pv.skippedEvidence], [true, 2, 20, 17, 1, 0], '基準の無い前の行は読み飛ばす');
  close(op.expected, 14, 1e-12);
  close(op.hitRate, 0.5 + (17 - 14) / 20, 1e-12, '基準を引いた当たる割合（基準を引かなければ 17/20 = 0.85）');
  close(op.rawHitRate, 17 / 20, 1e-12); close(op.baseRate, 14 / 20, 1e-12);
  close(op.pooledR, 2 * 0.65, 1e-9, '旧来と同じ r の尺度（2 × 基準を引いた当たる割合。前の数え方なら 1.5 に張りつく）');
  assert.deepEqual(op.perPlan.map((x) => [x.client, x.hitRate]).sort(), [[CL('乙'), 0.8], [CL('甲'), 0.5]], 'いつも上と同じだけ当たった計画は 0.5');
  // 全計画の外れの向き: 2 計画とも 上・下・上 → 上の割合 4/6
  assert.deepEqual(pv.hitBase, { share: Math.round(4 / 6 * 10000) / 10000, months: 6, plans: 2 });
  // 書く: 各計画の POOL_PRIOR に信頼度の行と hit_base の行
  const st = e.runJob('LEARN.POOL', {});
  assert.equal(st.status, 'DONE', st.error);
  for (const id of [P1, P2]) {
    const rows = e.table('ENG_POOL_PRIOR').filter((r) => r.plan_id === id);
    assert.equal(rows.find((r) => r.pool_scope === 'reliability:opinion' && r.param_key === 'reliability_r').pooled_value, '1.3');
    const hb = rows.find((r) => r.pool_scope === 'hit_base');
    assert.deepEqual([hb.param_key, Number(hb.pooled_value), Number(hb.precision), Number(hb.n_clients)], ['up_share', 0.6667, 3, 2]);
  }
  // 見解の事前分布（人の学び）: μ = 0.65 は基準を引いた当たり。中心 = 基準 + 0.15
  assert.equal(e.table('ENG_RELIABILITY_EVIDENCE').filter((r) => r.plan_id === P1).length, 2, '読み飛ばした行も残る');

  // C-1（止めている。待ち行列に直接入れる）: 甲の 4〜6 月。基準は hit_base（4/6・3 か月ぶん）へ寄せる: 上 (2 + 3 × 0.6667) / 6
  let id = e.run(`appWithLock_(() => appEnqueueJob_('PLAN.RUN', { planId: __p, action: 'REVIEW.GENERATE' }, __by, '').id)`, { __p: P1, __by: OWNER });
  let done = null;
  for (let i = 0; i < 60 && !done; i++) {
    e.fireTriggers('triggerRunJob');
    const s = e.call('apiJobStatus(__in)', { __in: { jobId: id } });
    if (s.status === 'CONTINUED') { id = s.nextJobId; continue; }
    if (s.status === 'QUEUED' || s.status === 'RUNNING') { id = s.jobId; continue; }
    done = s;
  }
  assert.equal(done.status, 'DONE', done.error);
  const up = (2 + 3 * 0.6667) / 6;
  const ev = e.table('ENG_RELIABILITY_EVIDENCE').filter((r) => r.plan_id === P1 && r.run_id !== 'R0');
  const tk = ev.find((r) => r.source_key === '鷹野'), sa = ev.find((r) => r.source_key === '佐藤');
  assert.deepEqual([tk.n, tk.hit, sa.n, sa.hit], ['3', '3', '3', '2']);
  assert.equal(tk.note, 'expected=' + (2 * up + (1 - up)).toFixed(4), '鷹野: 上・下・上と当てた（基準で当たるはずの数）');
  close(Number(tk.hit_rate), 0.5 + (3 - (2 * up + (1 - up))) / 3, 1e-9);
  assert.equal(sa.note, 'expected=' + (3 * up).toFixed(4), '佐藤: いつも上');
  close(Number(sa.hit_rate), 0.5 + (2 - 3 * up) / 3, 1e-9, 'いつも上と言っただけの当たりは 0.5 の近く（基準を全計画の割合に寄せたぶんだけずれる）');
  // 信頼度の案: r̂ = 2 × 基準を引いた当たる割合、事前分布（POOL_PRIOR の reliability:opinion = 1.3・強さ）へ寄せる
  const log = e.table('ENG_QUARTERLY_REVIEW_LOG').filter((r) => r.plan_id === P1);
  const tkLog = log.find((r) => r.target_field === 'reliability:opinion:鷹野');
  assert.ok(tkLog, '鷹野の信頼度の案');
  const k = Number(e.table('ENG_POOL_PRIOR').find((r) => r.plan_id === P1 && r.pool_scope === 'reliability:opinion').precision);
  const rHat = Math.min(1.5, 2 * Number(tk.hit_rate));
  close(Number(tkLog.proposed_value), Math.min(1.5, (3 * rHat + k * 1.3) / (3 + k)), 1e-9);
  assert.equal(tkLog.rationale, `的中率=100% / 基準=${Math.round((2 * up + (1 - up)) / 3 * 100)}% / n=3`);
}

// ==== 6. 画面 ====
{
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
  const el = () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
  const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, confirm: () => false,
    window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  const run = (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };
  const clean = (html, what) => { assert.doesNotMatch(html, /undefined|NaN|null/, what + ': 空の値を出さない'); return html; };
  const pl = env.call('apiPeopleLearning()');
  const card = clean(run('lrScoreCard(__d, true)', { __d: pl }), '当たりの確かさ（グラフ）');
  assert.doesNotMatch(card, /当てずっぽう|半々（50%）/, '半々と比べる言い方をしない');
  assert.match(card, /いつも同じ向きと言うよりも当たっています/);
  assert.match(card, /<i class="lr-k-ref"><\/i>いつも同じ向き<\/span>/, '凡例は基準の印');
  // グラフ: 行ごとの基準の印（3 本）。カーソルの説明に基準と、言えること
  assert.equal((card.match(/<line[^>]*class="ref"/g) || []).length, 3, '行ごとの基準の縦の印');
  assert.match(card, /いつも同じ向きなら 75%（当たるはずの数 9\.0）/);
  assert.match(card, /いつも同じ向きと言うのと、まだ見分けられません/, '上田のカーソルの説明');
  // 表: 上回る・下回るの札は、そう言える行だけ（読田 = 上回る・逆田 = 下回る・上田 = 札なし）
  run('S.cv.lrScore = "table"');
  const tbl = clean(run('lrScoreCard(__d, true)', { __d: pl }), '当たりの確かさ（表）');
  run('S.cv.lrScore = "chart"');
  const names = [...tbl.matchAll(/<td class="lr-wr" data-tip="[^"]*">([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/ <span class="chip"[^>]*>/, '|').replace(/<\/span>/, ''));
  assert.deepEqual(names, ['見解・読田|上回る', '見解・上田', '見解・逆田|下回る']);
  assert.match(tbl, /<th class="num" data-tip="いつも同じ向きと言った場合に当たる割合[^"]*">基準<\/th>/);
  assert.match(tbl, /<td class="num">75%<\/td>/, '上田の基準 75%');
  // 重みの学び: 基準の線・パネルの見出しに基準
  const ai = env.call('apiAiLearning()');
  const curves = (ai.curves || []).filter((c) => c && c.prior && (c.quarters || []).length);
  const cc = clean(run('lrCurveCard(__c)', { __c: curves }), '重みの学び');
  assert.doesNotMatch(cc, /当てずっぽう|半々（50%）/);
  assert.match(cc, /・基準 \d+%<\/span>/);
  assert.match(cc, /いつも同じ向きと言った場合に当たる割合で、80% の幅の左の端がこの線より右なら/);
  // 人ごとの当たり・調査ごとの当たり: 基準の列（基準の無い前の形でも空の値を出さない）
  const hc = clean(run('lrHitCard(__h)', { __h: pl.hits }), '人ごとの当たり');
  assert.match(hc, /<th class="num" data-tip="いつも同じ向きと言った場合に当たる割合[^"]*">基準<\/th>/);
  assert.match(hc, /（いつも同じ向きなら \d+%）/, '四半期ごとの基準をカーソルに');
  clean(run('lrHitCard(__h)', { __h: { people: [{ name: '鷹野', own: false, n: 2, hit: 1, rate: 0.5, makers: 1, quarters: [] }], hidden: 0, quarters: 2 } }), '前の形');
  const rc = clean(run('lrResearchCard(__r)', { __r: ai.research }), '調査ごとの当たり');
  assert.match(rc, />\d\.\d \/ \d+<\/td>/, '基準で当たるはずの四半期の数');
  clean(run('lrResearchCard(__r)', { __r: { research: [{ planId: 'P1', clientName: 'テスト製薬', fy: '2026', date: '2026-06-10', n: 1, hit: 1, quarters: [] }], hidden: 0 } }), '前の形');
  // 区間のグラフの行ごとの印（ほかの画面の全部の行の基準線はそのまま）
  const iv = run(`chartIntervals([{ label: 'A', lo: 0.2, mid: 0.5, hi: 0.9, ref: 0.6 }, { label: 'B', lo: 0.1, mid: 0.2, hi: 0.3 }], {})`);
  assert.equal((iv.match(/class="ref"/g) || []).length, 1, '印は ref のある行だけ');
}

console.log('app-hit-baseline: all tests passed');
