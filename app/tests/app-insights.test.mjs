#!/usr/bin/env node
/**
 * app-insights.test.mjs — 責任者の 3 つの画面の材料（分析・人の学び・AI の学び）。読むだけ。
 * 計算用の表をまとめて読む（appEngAll_）・月の日付と文字列の食い違い・振り返りの重複・ベータ分布の区間・Wilson の区間・空のとき。
 * 承認待ちの提案の見分け・予算の上乗せと合計の予算・人の名前を見せる範囲（人の学び・AI の学び）・保存の後の控え（計画ごとの当たりと精度）。
 *
 *   node app/tests/app-insights.test.mjs
 */
import assert from 'node:assert/strict';
import { makeEnv, setUpEnv, STATS, OWNER, MEMBER, OUTSIDER, J } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
/** 数の近さ。数でない値（null など）は通さない（null − b は −b になり、b が 0 なら通ってしまう） */
const close = (a, b, eps = 1e-9, msg = '') => {
  assert.ok(typeof a === 'number' && typeof b === 'number', `${msg} 数ではない: ${a} / ${b}`);
  assert.ok(Math.abs(a - b) < eps, `${msg} ${a} ≈ ${b}`);
};
const env = setUpEnv();
const H = env.run('(() => { const o = {}; Object.keys(APP_ENGINE_SHEETS).forEach(k => { o[k] = APP_ENGINE_SHEETS[k].header || null; }); return o; })()');
const row = (sheet, o) => H[sheet].map((h) => (o[h] === undefined ? '' : o[h]));
/** 今の検証の版（B-2 が EVAL_LOG に書く。精度・当たりの実績・振り返りは今の版で測った月だけ。2026-10-07 D4〜D6） */
const POLICY = env.run('APP_EVAL_POLICY_VERSION');
const config = (client, fy) => ({ values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '鷹野']] });
/**
 * 検証の記録: [月, 実績, P50, 幅, 版（省くと今の版）]（P10 = P50 × (1 − 幅)・P90 = P50 × (1 + 幅)）。
 * B-2 が測った日時（2026-09-01）は見本の振り返りの行より後（旧来の B-2 は測るたびに書き直す）。振り返りは、予測と実績がこの記録の
 * neutral の行と同じで、今の版の B-2 が初めて動いた時刻（RUN_LOG の記録 b2Log と、この記録の日時の一番古いもの）より後に書いた行だけを使う
 * （appInsightRowScored_）
 */
const evalLog = (client, months) => [H.EVAL_LOG].concat(...months.map(([ym, act, p50, w, ver = POLICY], i) => [['nega', p50 * (1 - w)], ['neutral', p50], ['posi', p50 * (1 + w)]]
  .map(([sc, p]) => row('EVAL_LOG', { eval_id: 'E' + i + sc, evaluated_at: D(2026, 9, 1), client, target_month: ym, scenario: sc, pred: p, actual: act,
    evaluation_policy_version: ver, constraint_relevant_flag: 1 }))));
/** RUN_LOG: 今の版の B-2 が成功した記録（旧来の logRun_ が足す。error_summary は「版: scored_months=…」）。at = 動いた時刻 */
const b2Log = (...ats) => ({ values: [H.RUN_LOG].concat(ats.map((at, i) => row('RUN_LOG', { run_id: 'L' + i, run_at: at, run_by: 'owner',
  function_name: 'updatePhase1EvaluationReport', status: 'success', count: 3, error_summary: POLICY + ': scored_months=3; open_months=0; no_pre_month_forecast=0' }))) });
const impact = (client, runAt, ym, quant, src = 'forecast_open') => row('AI_IMPACT_HISTORY', { run_id: 'R' + runAt.getTime(), run_at: runAt, client, target_month: ym, k_ai: 1,
  pred_p50_quant_only: quant, forecast_source: src });
const push = (client, runAt, ym, type, key, dir, src = 'forecast_open') => row('SUBJECTIVE_IMPACT_HISTORY', { run_id: 'R' + runAt.getTime(), run_at: runAt, client, target_month: ym,
  source_type: type, source_key: key, push_step: dir * 0.05, push_direction: dir, applied_reliability_r: 1, forecast_source: src });
/**
 * 実績の取り込み（B-1）→ 検証（B-2）の記録。2026-10-07 から（D4・D5）、振り返り・当たり・精度は締まった月（B-1 の日に月末から 5 日たった月）
 * だけで数えるので、この記録の無い計画には締まった月が無い。既定の 2026-10-06 の取り込みなら 2026/09 まで締まっている
 */
const doneStatus = (client, b1 = new Date(2026, 9, 6, 10)) => ({ values: [H.PROCESS_STATUS, ['step2_status', b1, 'owner', 'success', client, 10, ''],
  ['step5_status', new Date(b1.getTime() + 3600e3), 'owner', 'success', client, 10, '']] });
const research = (client, asOf, topic, rowType, dir, score) => row('AI_RESEARCH_STRUCTURED', { client, as_of_date: asOf, topic, row_type: rowType, direction: dir, impact_score: 3,
  confidence: 0.7, blended_score: score, relative_position_label: '中位' });

// ---- 甲製薬 FY2026: SUBJECTIVE_IMPACT_HISTORY の月が日付（旧来の書き方で、計算用ブックが日付に変えたもの）----
const r1 = D(2026, 3, 1), r2 = D(2026, 3, 15), r3 = D(2026, 3, 20);
const output = [['FY2026 売上予測（甲製薬）']];
for (let r = 2; r <= 25; r++) output.push([]);
output.push(['年度合計（予測）', 900, 1000, 1100], [], []);
for (let i = 0; i < 12; i++) { const m = 4 + i; output.push([(m > 12 ? 2027 : 2026) + '/' + String(m > 12 ? m - 12 : m).padStart(2, '0'), 90, 100, 110, '', '', '', 100, 10]); }
const bookA = env.makeBook('甲', {
  CONFIG: config('甲製薬', 2026),
  OUTPUT: { values: output },
  // 2025/05 は前の年度の、今の版で測った月（締まった後の予測 = 実績なので精度には数えない。振り返りは今の版で測った月だけに出す。2026-10-07）
  EVAL_LOG: { values: evalLog('甲製薬', [['2025/05', 800, 800, 0.05], ['2026/04', 1250, 1000, 0.05], ['2026/05', 900, 1000, 0.05], ['2026/06', 1000, 1000, 0.05],
    ['2026/07', 1100, 1050, 0.05]]), formats: { D: '@' } },
  EVAL_COMPARE_MONTHLY: { values: [H.EVAL_COMPARE_MONTHLY].concat([['2026/04', 1250], ['2026/05', 900], ['2026/06', 1000], ['2026/07', 1100]]
    .map(([ym, a]) => row('EVAL_COMPARE_MONTHLY', { target_month: ym, actual_total: a, forecast_total_p50: 1000, ape_p50: Math.abs(1000 - a) / a, range_outside_flag: 1 }))), formats: { A: '@' } },
  AI_IMPACT_HISTORY: { values: [H.AI_IMPACT_HISTORY,
    impact('甲製薬', r1, '2026/04', 1300), impact('甲製薬', r1, '2026/05', 950),
    impact('甲製薬', r2, '2026/04', 1000), impact('甲製薬', r2, '2026/05', 950), impact('甲製薬', r2, '2026/06', 1000),
    impact('甲製薬', r3, '2026/05', 800, 'actual_locked')] },
  SUBJECTIVE_IMPACT_HISTORY: { values: [H.SUBJECTIVE_IMPACT_HISTORY,
    push('甲製薬', r1, D(2026, 4), 'opinion', '鷹野', -1),
    push('甲製薬', r2, D(2026, 4), 'opinion', '鷹野', 1), push('甲製薬', r2, D(2026, 5), 'opinion', '鷹野', -1), push('甲製薬', r2, D(2026, 6), 'opinion', '鷹野', 1),
    push('甲製薬', r2, D(2026, 4), 'factor_product', '佐藤', -1), push('甲製薬', r2, D(2026, 5), 'factor_product', '佐藤', 1),
    push('甲製薬', r2, D(2026, 4), 'ai_topic', 'Market', 1), push('甲製薬', r2, D(2026, 5), 'ai_topic', 'Market', 1),
    push('甲製薬', r3, D(2026, 5), 'opinion', '鷹野', 1, 'actual_locked'),
    push('甲製薬', r2, D(2026, 10), 'opinion', '鷹野', 1)] },
  POOL_PRIOR: { values: [H.POOL_PRIOR, ['reliability:opinion', 'reliability_r', 1.2, 10, 3, D(2026, 9, 1), 'owner', '']] },
  SOURCE_RELIABILITY: { values: [H.SOURCE_RELIABILITY, ['甲製薬', 'opinion', '鷹野', 1.1, '', 'FY2025-Q3', D(2026, 1, 12), 'owner', 'applied via R1']] },
  EVAL_INSIGHTS: { values: [H.EVAL_INSIGHTS].concat([
    { evaluated_at: D(2026, 5, 10), target_month: D(2026, 4), actual_total: 1250, pred_p50: 1000, cause_hypothesis: '大型案件の前倒し', cause_bucket: 'over_forecast',
      action_type: '入力を修正', next_cycle_reflection: '見解を見直す', owner: '鷹野', status: 'in_progress', range_breach: 0 },
    { evaluated_at: D(2026, 6, 10), target_month: D(2026, 4), actual_total: 1250, pred_p50: 1000, cause_bucket: 'over_forecast', action_type: 'update',
      next_cycle_reflection: '次回サイクルで前提更新を反映', status: 'open', range_breach: 0 },
    { evaluated_at: D(2026, 6, 10), target_month: D(2026, 5), actual_total: 900, pred_p50: 1000, cause_bucket: 'under_forecast', action_type: 'update', status: 'open', range_breach: 1 },
    { evaluated_at: D(2026, 6, 10), target_month: D(2026, 6), actual_total: 1000, pred_p50: 1000, cause_bucket: 'under_forecast', action_type: 'keep', status: 'monitoring', range_breach: 0 },
    { evaluated_at: D(2026, 6, 10), target_month: '2025/05', actual_total: 800, pred_p50: 1000, cause_hypothesis: '失注', cause_bucket: 'under_forecast', action_type: 'update',
      owner: '佐藤', status: 'done', range_breach: 0 },
  ].map((o) => row('EVAL_INSIGHTS', Object.assign({ client: '甲製薬' }, o)))) },
  QUARTERLY_REVIEW_LOG: { values: [H.QUARTERLY_REVIEW_LOG].concat([
    { review_id: 'R1', proposal_id: 'P-B-1', reviewed_at: D(2026, 1, 10), quarter_label: 'FY2025-Q3', phase: 'B', target_field: 'reliability:opinion:鷹野', current_value: '1',
      proposed_value: '1.1', confidence: '中', rationale: '的中率=67% / n=3', approval_status: '承認', approval_decided_at: D(2026, 1, 12), approval_decided_by: OWNER, applied: 1, applied_at: D(2026, 1, 12) },
    { review_id: 'R1', proposal_id: 'P-A-1', reviewed_at: D(2026, 1, 10), quarter_label: 'FY2025-Q3', phase: 'A', target_field: 'ai_weight_override', current_value: '0.5',
      proposed_value: '0.35', confidence: '高', approval_status: '却下', approval_decided_at: D(2026, 1, 12), approval_decided_by: OWNER, applied: 0 },
    { review_id: 'R2', proposal_id: 'P-B-2', reviewed_at: D(2026, 7, 10), quarter_label: 'FY2026-Q1', phase: 'B', target_field: 'reliability:factor_product:佐藤', current_value: '1',
      proposed_value: '0.8', confidence: '中', approval_status: '保留', applied: 0 },
  ].map((o) => row('QUARTERLY_REVIEW_LOG', Object.assign({ client: '甲製薬' }, o)))) },
  QUARTERLY_REVIEW: { values: [['【四半期レビュー: FY2026-Q1】'], ['検証期間: 2026/04 〜 2026/06'], [], [], ['承認列を入力後、適用してください。'], [],
    ['提案ID', '対象', '現在値', '提案値', '自信度', '根拠', '影響見積もり', '承認列', 'ロールバック'],
    ['P-B-2', 'reliability:factor_product:佐藤', '1', '0.8', '中', '的中率=0% / n=2', '…', '承認', '…', 'R2']] },
  CALIBRATION_HISTORY: { values: [H.CALIBRATION_HISTORY].concat([
    { change_id: 'C1', changed_at: D(2026, 5, 10), quarter_label: 'FY2026-Q1', review_id: 'AUTO-MONTHLY', factor_name: 'bias_correction_factor', old_value: '1', new_value: '0.95' },
    { change_id: 'C2', changed_at: D(2026, 1, 12), quarter_label: 'FY2025-Q3', review_id: 'R1', factor_name: 'reliability:opinion:鷹野', old_value: '1', new_value: '1.1' },
    { change_id: 'C3', changed_at: D(2026, 6, 10), quarter_label: 'FY2026-Q1', review_id: 'AUTO-MONTHLY', factor_name: 'residual_month_bias_json', old_value: '', new_value: '{"04":-0.05}' },
  ].map((o) => row('CALIBRATION_HISTORY', Object.assign({ client: '甲製薬', changed_by: 'owner' }, o)))) },
  CALIBRATION_STATE: { values: [H.CALIBRATION_STATE, ['甲製薬', D(2026, 6, 10), 'owner', '', '', '', 0.75, '', '{}', '', '', 1, '']] },
  PROCESS_STATUS: doneStatus('甲製薬'),
  // 今の版の B-2 は 5/01 に初めて動いた（9/01 の B-2 が EVAL_LOG の日時を書き直した）。振り返りの行（5/10・6/10）はその後に B-4 が書いたもの
  RUN_LOG: b2Log(D(2026, 5, 1), D(2026, 9, 1)),
  AI_RESEARCH_STRUCTURED: { values: [H.AI_RESEARCH_STRUCTURED, research('甲製薬', D(2026, 8, 1), 'Market', 'event', 'down', -30),
    research('甲製薬', D(2026, 9, 1), 'Market', 'event', 'up', 10), research('甲製薬', D(2026, 9, 1), 'Market', 'benchmark', 'positive', 14),
    research('甲製薬', D(2026, 9, 1), 'Competitor', 'event', '低下', -5)] },
});

// ---- 乙製薬 FY2026: 月は文字列（'@'）----
const bookB = env.makeBook('乙', {
  CONFIG: config('乙製薬', 2026),
  EVAL_LOG: { values: evalLog('乙製薬', [['2026/04', 500, 520, 0.01], ['2026/05', 600, 560, 0.01], ['2026/06', 650, 600, 0.01], ['2026/07', 700, 680, 0.01],
    ['2026/08', 720, 700, 0.01], ['2026/09', 740, 760, 0.01]]), formats: { D: '@' } },
  AI_IMPACT_HISTORY: { values: [H.AI_IMPACT_HISTORY, impact('乙製薬', r2, '2026/04', 450), impact('乙製薬', r2, '2026/05', 650), impact('乙製薬', r2, '2026/07', 600)] },
  SUBJECTIVE_IMPACT_HISTORY: { values: [H.SUBJECTIVE_IMPACT_HISTORY,
    push('乙製薬', r2, '2026/04', 'opinion', '鷹野', 1), push('乙製薬', r2, '2026/05', 'opinion', '鷹野', 1), push('乙製薬', r2, '2026/07', 'opinion', '鷹野', 1),
    push('乙製薬', r2, '2026/04', 'opinion', '田中', -1)], formats: { D: '@' } },
  POOL_PRIOR: { values: [H.POOL_PRIOR, ['reliability:opinion', 'reliability_r', 0.8, 20, 3, D(2026, 3, 1), 'owner', '']] },   // 古い方（使わない）
  SOURCE_RELIABILITY: { values: [H.SOURCE_RELIABILITY, ['乙製薬', 'opinion', '鷹野', 0.9, '', 'FY2025-Q3', D(2026, 1, 12), 'owner', '']] },
  QUARTERLY_REVIEW_LOG: { values: [H.QUARTERLY_REVIEW_LOG, row('QUARTERLY_REVIEW_LOG', { review_id: 'R3', proposal_id: 'P-A-3', reviewed_at: D(2026, 8, 1), client: '乙製薬',
    quarter_label: 'FY2026-Q1', phase: 'A', target_field: 'ai_weight_override', current_value: '0.5', proposed_value: '0.75', confidence: '中', approval_status: '保留', applied: 0 })] },
  QUARTERLY_REVIEW: { values: [['【四半期レビュー: FY2026-Q1】'], [], [], [], [], [], ['提案ID', '対象', '現在値', '提案値', '自信度', '根拠', '影響見積もり', '承認列', 'ロールバック'],
    ['P-A-3', 'ai_weight_override', '0.5', '0.75', '中', '', '…', '', '…', 'R3']] },
  CALIBRATION_STATE: { values: [H.CALIBRATION_STATE, ['乙製薬', D(2026, 6, 10), 'owner', '', '', '', 1, '', '{}', '', '', 1, '']] },
  PROCESS_STATUS: doneStatus('乙製薬'),
  AI_RESEARCH_STRUCTURED: { values: [H.AI_RESEARCH_STRUCTURED, research('乙製薬', D(2026, 9, 15), 'Market', 'event', 'up', 20)] },
});
// ---- 丙製薬 FY2025: 記録が何も無い計画 ----
const bookC = env.makeBook('丙', { CONFIG: config('丙製薬', 2025) });
const A = env.seedPlan(bookA), B = env.seedPlan(bookB), C = env.seedPlan(bookC);

// 新アプリの予測の実行（14 回の完了と 1 回の失敗）と、公式版
env.run(`appInsertRows_('FORECAST_RUNS', __runs)`, { __runs: Array.from({ length: 15 }, (_, i) => ({ run_id: 'FR-' + String(i).padStart(2, '0'), plan_id: A,
  status: i === 14 ? 'ERROR' : 'DONE', annual_p10: 900 + i, annual_p50: 1000 + i, annual_p90: 1100 + i,
  started_at: `2026-09-${String(i + 1).padStart(2, '0')}T09:00:00+0900`, finished_at: `2026-09-${String(i + 1).padStart(2, '0')}T10:00:00+0900` })) });
env.run(`appInsertRows_('PLAN_VERSIONS', __v)`, { __v: [{ version_id: 'V1', plan_id: A, version_no: 1, state: 'APPROVED', annual_p10: 900, annual_p50: 1000, annual_p90: 1100,
  budget_adopted: 1200, budget_uplift: 120, budget_final: 1320, row_version: 1 }] });

// 日付に変わった月（旧来の不具合の元）と、文字列の月の両方がある
const types = (id) => env.table('ENG_SUBJECTIVE_IMPACT_HISTORY').filter((r) => r.plan_id === id).map((r) => r._types.charAt(3));
assert.ok(types(A).every((t) => t === 'd') && types(B).every((t) => t === 's'), '甲は日付・乙は文字列の月');

// ==== 1. 分析: 年度のメーカーを横に並べる ====
{
  const x = env.call('apiCrossMaker(__in)', { __in: {} });
  assert.equal(x.fy, '2026', '既定は今の年度');
  assert.deepEqual(x.fys, ['2025', '2026']);
  assert.deepEqual(x.plans.map((p) => p.clientName).sort(), ['乙製薬', '甲製薬']);
  const a = x.plans.find((p) => p.planId === A), b = x.plans.find((p) => p.planId === B);
  // 計画の一覧の項目はそのまま渡す（着地の見込み・暫定実績など。別の作業で足す項目も）
  const port = env.call('apiPortfolio()').plans.find((p) => p.planId === A);
  for (const k of Object.keys(port)) assert.deepEqual(a[k], port[k], '一覧の項目をそのまま: ' + k);
  assert.equal(a.p50, 1013, '一番新しい予測');
  assert.equal(a.budget, 1320);
  assert.equal(a.actualYtd, port.actualYtd, '暫定実績は計画の一覧と同じ（締まった月だけ）');
  // 予測の改訂: 完了した回だけ、古い順に最近の 12 回
  assert.equal(a.revisions.length, 12);
  assert.deepEqual([a.revisions[0].p50, a.revisions[11].p50], [1002, 1013]);
  assert.ok(a.revisions.every((r, i) => i === 0 || r.at > a.revisions[i - 1].at), '古い順');
  assert.deepEqual(b.revisions, []);
  // 精度（締まった後の予測の月は除く）
  assert.equal(a.accuracy.n, 3);
  assert.equal(a.accuracy.leaks, 2, '2026/06 と、振り返りのために足した 2025/05（どちらも予測 = 実績）');
  close(a.accuracy.mape, (0.2 + 100 / 900 + 50 / 1100) / 3, 1e-9, 'MAPE');
  close(a.accuracy.coverage, 1 / 3, 1e-9, 'P10〜P90 に入った割合');
  assert.equal(b.accuracy.coverage, 0);
  // AI の話題: 一番新しい回だけ。向きはそろえる
  assert.equal(a.topics.length, 3);
  assert.deepEqual(a.topics.map((t) => [t.topic, t.direction, t.score]), [['Market', 'up', 10], ['Market', 'up', 14], ['Competitor', 'down', -5]]);
  assert.equal(a.topics[0].asOf, '2026/09');
  // 市場のまとめ: 話題ごとに、上向き・下向きのメーカーの数と点数の平均（メーカーごとの平均の平均）
  assert.deepEqual(x.market.map((m) => [m.topic, m.makers, m.up, m.down, m.meanScore]), [['Market', 2, 2, 0, 16], ['Competitor', 1, 0, 1, -5]]);
  // 合計（比は予算のある計画だけ）
  assert.equal(x.totals.plans, 2);
  assert.equal(x.totals.budget, 1320);
  assert.equal(x.totals.budgetPlans, 1);
  assert.equal(x.totals.p50, 1013 + (b.p50 || 0));
  close(x.totals.ratioP50, 1013 / 1320);
  const landed = [a, b].filter((p) => typeof p.landing === 'number');
  assert.equal(x.totals.landing, landed.length ? landed.reduce((s, p) => s + p.landing, 0) : null, '着地の合計は着地のある計画だけ（霧で数字の無い計画は入れない）');
  // 年度を選ぶ: 記録の無い計画でも形はそろう
  const y = env.call('apiCrossMaker(__in)', { __in: { fy: 2025 } });
  assert.equal(y.fy, '2025');
  assert.equal(y.plans.length, 1);
  const c = y.plans[0];
  assert.deepEqual([c.planId, c.revisions, c.topics, c.accuracy.n, c.accuracy.mape], [C, [], [], 0, null]);
  assert.deepEqual(y.market, []);
  assert.equal(y.totals.budget, null);
  assert.equal(y.totals.ratioP50, null);
  assert.equal(env.call('apiCrossMaker(__in)', { __in: { fy: 'x' } }).fy, '2026', '年度でない値は既定にする');
}

// ==== 2. 人の学び ====
const people = env.call('apiPeopleLearning()');
{
  // 振り返り: 計画 × 月で 1 つ（B-4 の再実行で増えた行を除く）。人の書いた欄は残し、数字は新しい行から。向きは予測 − 実績から。
  // B-2 が測った日時（9/01）は振り返りの行（5/10・6/10）より後だが、今の版の B-2 が初めて動いたのは 5/01（RUN_LOG）なので、
  // 予測と実績が今の B-2 の数字と同じ行は出す。
  // 2025/05 の行（予測 1000・人の記入あり）は、今の B-2 が 800 で測った月なので出さない（ほかの測り方の数字。次の B-4 が書き直すまで。行は消さない）
  const L = people.lessons;
  assert.deepEqual(L.map((x) => x.ym), ['2026/04', '2026/05', '2026/06'], '誤差の大きい順');
  const apr = L[0];
  assert.equal(apr.duplicates, 1);
  assert.deepEqual([apr.hypothesis, apr.owner, apr.status, apr.statusLabel, apr.actionType, apr.human], ['大型案件の前倒し', '鷹野', 'in_progress', '対応中', '入力を修正', true]);
  assert.deepEqual([apr.direction, apr.directionLabel], ['under', '予測が低すぎた'], 'cause_bucket（over_forecast・逆向き）は使わない');
  close(apr.err, (1000 - 1250) / 1250);
  assert.equal(apr.miss, true);
  const may = L[1];
  assert.deepEqual([may.direction, may.range, may.miss, may.statusLabel, may.actionLabel, may.human], ['over', true, true, '未着手', '前提を更新', false]);
  assert.deepEqual([L[2].miss, L[2].direction, L[2].statusLabel], [false, 'exact', '見守り']);
  // scoredMonths: 今の決まりで B-2 が測った月（甲 5 か月・乙 6 か月）。乙は振り返りの行が無い。
  // waitingMonths: そのうち出せる振り返りの行がまだ無い月（甲 2025/05（数字の違う行だけ）・2026/07、乙 6 か月。どちらも締めていない年度）
  assert.deepEqual(people.summary, { months: 3, misses: 2, withNotes: 1, duplicatesRemoved: 1, scoredMonths: 11, waitingMonths: 8 });
  assert.deepEqual(people.openActions.map((x) => [x.ym, x.statusLabel]), [['2026/04', '対応中'], ['2026/05', '未着手']], '済み・見守りは出さない');
  assert.equal(people.causes.reduce((s, c) => s + c.n, 0), 2, '外れた月だけ数える');
  assert.ok(people.causes.some((c) => c.direction === 'under' && c.actionType === '入力を修正' && !c.range));
  assert.ok(people.causes.some((c) => c.direction === 'over' && c.range && c.actionType === 'update'));
  assert.deepEqual(people.repeats, [], '2025/05 の行は出さないので、違う年度の同じ月の外れも無い（15 で確かめる）');
  assert.equal(env.table('ENG_EVAL_INSIGHTS').filter((r) => r.plan_id === A).length, 5, '行は消さない');
}
{
  // 当たり: 日付の月（甲）も文字列の月（乙）も数える。予測の対象だった月（forecast_open）の一番新しい回だけ。全部の評価できた月で
  const S = people.scoreboard;
  const get = (type, key) => S.find((s) => s.type === type && s.key === key);
  const tk = get('opinion', '鷹野');
  assert.deepEqual([tk.n, tk.hit], [5, 4], '甲 2/2 + 乙 2/3');
  assert.deepEqual(tk.plans.map((p) => [p.clientName, p.n, p.hit, p.appliedR]).sort(), [['乙製薬', 3, 2, 0.9], ['甲製薬', 2, 2, 1.1]]);
  close(tk.appliedR, 1.0, 1e-9, '今の信頼度（計画の平均）');
  // 基準（いつも同じ向きと言った場合に当たる割合。2026-10-13）: 比べられた月の外れの向きは 甲 [上 1（4 月）・下 1（5 月）。6 月は外れ 0]・
  // 乙 [上 2（4・7 月）・下 1（5 月）]。全計画の上の割合 3/5。3 か月ぶん寄せる: 甲 上 (1 + 3 × 0.6) / 5 = 0.56、乙 上 (2 + 1.8) / 6
  const upA = 2.8 / 5, upB = 3.8 / 6;
  // 鷹野: 甲 4 月 上（0.56）・5 月 下（0.44）、乙 3 か月とも上（0.633）。基準で当たるはずの数 2.9（割合 0.58）
  close(tk.expected, upA + (1 - upA) + 3 * upB, 1e-12);
  close(tk.base, (upA + (1 - upA) + 3 * upB) / 5, 1e-12);
  assert.deepEqual(tk.plans.map((p) => [p.clientName, Math.round(p.expected * 1e9) / 1e9]).sort(), [['乙製薬', 1.9], ['甲製薬', 1]]);
  // 事前分布: 一番新しい POOL_PRIOR（μ = 1.2 / 2 = 0.6・強さ 10）を基準に合わせる: 中心 = 基準 0.58 + (0.6 − 0.5) = 0.68 → Beta(6.8, 3.2)。事後 Beta(10.8, 4.2)
  close(tk.prior.alpha0, 6.8, 1e-9); close(tk.prior.beta0, 3.2, 1e-9);
  assert.equal(tk.prior.from, 'pool');
  close(tk.alpha, 10.8, 1e-9); close(tk.beta, 4.2, 1e-9);
  close(tk.postMean, 10.8 / 15);
  assert.ok(tk.ci80[0] < tk.postMean && tk.postMean < tk.ci80[1]);
  assert.equal(tk.vsBase, tk.ci80[0] > tk.base ? 'above' : '', 'いつも同じ向きより当たっていると言うのは、80% の区間の下の端が基準より上のときだけ');
  assert.deepEqual([get('opinion', '田中').n, get('opinion', '田中').hit], [1, 0]);
  close(get('opinion', '田中').base, 1 - upB, 1e-12, '田中は乙の 4 月に下と言った（下の基準）');
  const sato = get('factor_product', '佐藤');
  // 佐藤: 甲 4 月 下（外れ・基準 0.44）・5 月 上（外れ・基準 0.56）。基準の割合 0.5 → 事前分布が無ければ基準を中心に強さ 4 = Beta(2, 2)
  assert.deepEqual([sato.n, sato.hit, sato.prior.from, sato.appliedR], [2, 0, 'default', null]);
  close(sato.base, 0.5, 1e-12);
  close(sato.alpha, 2, 1e-9); close(sato.beta, 4, 1e-9);
  assert.deepEqual([get('ai_topic', 'Market').n, get('ai_topic', 'Market').hit], [2, 1]);
  close(get('ai_topic', 'Market').expected, 2 * upA, 1e-12, 'Market は甲の 4・5 月に上と言った');
  assert.equal(S.length, 4);
  assert.ok(S.every((s, i) => i === 0 || s.ci80[0] - s.base <= S[i - 1].ci80[0] - S[i - 1].base + 1e-12), '80% の区間の下の端と基準の差が大きい順');
  assert.equal(S[0].key, '鷹野');
}
{
  // 判断の記録（新しい順）
  const Dd = people.decisions;
  assert.deepEqual(Dd.map((d) => d.proposalId), ['P-A-3', 'P-B-2', 'P-B-1', 'P-A-1']);
  const p1 = Dd.find((d) => d.proposalId === 'P-B-1');
  assert.deepEqual([p1.status, p1.applied, p1.decidedBy, p1.current, p1.proposed, p1.phaseLabel, p1.targetLabel],
    ['承認', true, 'owner', 1, 1.1, '情報源の信頼度', '見解「鷹野」の信頼度']);
  assert.deepEqual([Dd[1].targetLabel, Dd[1].status, Dd[1].applied, Dd[1].decidedAt], ['製品の入力「佐藤」の信頼度', '保留', false, '']);
  assert.equal(Dd.find((d) => d.proposalId === 'P-A-1').targetLabel, 'AI の重み');
  // 予算の上乗せの実績（公式版の予算と、年度の実績の合計）
  assert.equal(people.uplift.length, 1);
  const u = people.uplift[0];
  assert.deepEqual([u.planId, u.budgetFinal, u.complete], [A, 1320, false]);
  // 年度の途中は実績で見る割合を出さない。統計の着地の見込みで見た割合は別の名前で（10 で詳しく）。
  // 着地の見込みは計画の一覧から（霧・実績が古いときは null）。どちらでも、見込みが無ければ見込みの割合も null
  const portA = env.call('apiPortfolio()').plans.find((p) => p.planId === A);
  assert.deepEqual([u.ratio, u.upliftRealized, u.landing], [null, null, portA.landing]);
  if (portA.landing === null) assert.deepEqual([u.projectedRatio, u.projectedUpliftRealized], [null, null]);
  else {
    close(u.projectedRatio, portA.landing / 1320);
    close(u.projectedUpliftRealized, (portA.landing - 1200) / 120);
  }
  assert.equal(people.detail, 'full', '所有者（管理者）には人ごとの行も出す');
}

// ==== 3. AI の学び ====
const ai = env.call('apiAiLearning()');
{
  // 信頼度の学び: 種類ごとに、四半期ごとに積み上げた事後（Beta(α0 + 当たり, β0 + 外れ)）
  assert.deepEqual(ai.curves.map((c) => c.type), ['factor_product', 'factor_client', 'opinion', 'ai_topic', 'vertex_forecast']);
  const op = ai.curves.find((c) => c.type === 'opinion');
  // 基準: 見解の押した 6 か月（鷹野 5・田中 1）の基準の平均。事前分布の中心 = 基準 + (μ 0.6 − 0.5)（人と話題ごとの当たりと同じ）
  const upA = 2.8 / 5, upB = 3.8 / 6;
  const opExp = upA + (1 - upA) + 3 * upB + (1 - upB);
  close(op.base, opExp / 6, 1e-12);
  close(op.expected, opExp, 1e-12);
  close(op.prior.alpha0, (opExp / 6 + 0.1) * 10, 1e-9); close(op.prior.beta0, (1 - opExp / 6 - 0.1) * 10, 1e-9);
  assert.equal(op.prior.from, 'pool');
  close(op.prior.mu, 0.6, 1e-12, 'mu は POOL_PRIOR のまま');
  assert.deepEqual(op.quarters.map((q) => [q.quarter, q.n, q.hit, q.cumN]), [['FY2026-Q1', 5, 3, 5], ['FY2026-Q2', 1, 1, 6]]);
  op.quarters.forEach((q) => { close(q.alpha, op.prior.alpha0 + (q.quarter === 'FY2026-Q1' ? 3 : 4), 1e-9); close(q.beta, op.prior.beta0 + 2, 1e-9); });
  close(op.quarters[0].base, (upA + (1 - upA) + 2 * upB + (1 - upB)) / 5, 1e-12, 'その時点までの基準（Q1 は 7 月の乙を含まない）');
  close(op.quarters[1].base, opExp / 6, 1e-12);
  assert.deepEqual([op.n, op.hit], [6, 4]);
  const width = (ci) => ci[1] - ci[0];
  assert.ok(width(op.quarters[1].ci80) < width(op.quarters[0].ci80) && width(op.quarters[0].ci80) < width(op.prior.ci80), '数えるほど区間が狭くなる');
  const fp = ai.curves.find((c) => c.type === 'factor_product');
  assert.deepEqual([fp.prior.alpha0, fp.prior.beta0, fp.prior.from, fp.quarters.length], [2, 2, 'default', 1]);
  assert.deepEqual(ai.curves.find((c) => c.type === 'vertex_forecast').quarters, []);
  // 全計画で縮めた偏り（3 か月以上ある計画）
  const sh = ai.shrinkage;
  assert.equal(sh.pooled, true);
  assert.deepEqual(sh.plans.map((p) => p.planId).sort(), [A, B].sort());
  const accA = J(env.run(`appAccuracyOf_('${A}')`));
  const pa = sh.plans.find((p) => p.planId === A);
  close(pa.se, Math.sqrt(Math.max(accA.errVar, 1e-4) / Math.max(1, accA.biasW)), 1e-12, '標準誤差');
  close(pa.bias, accA.bias);
  for (const p of sh.plans) assert.ok(p.shrunk >= Math.min(p.bias, sh.mu) - 1e-12 && p.shrunk <= Math.max(p.bias, sh.mu) + 1e-12, '自分の偏りと平均の間');
  close(sh.tau, Math.sqrt(sh.tau2));
  // 精度の推移（全計画の月ごと。締まった後の予測の月は除く）
  const T = ai.timeline;
  assert.deepEqual(T.map((t) => t.ym), ['2026/04', '2026/05', '2026/06', '2026/07', '2026/08', '2026/09']);
  const apes = { '2026/04': [0.2, 20 / 500], '2026/05': [100 / 900, 40 / 600], '2026/06': [50 / 650], '2026/07': [50 / 1100, 20 / 700] };
  close(T[0].mape, (0.2 + 0.04) / 2);
  assert.deepEqual([T[2].n, T[2].coverageN], [1, 1], '甲の 6 月は締まった後の予測');
  close(T[2].rolling3, [].concat(apes['2026/04'], apes['2026/05'], apes['2026/06']).reduce((a, b) => a + b) / 5, 1e-12, '3 か月の平均');
  assert.equal(T[2].rolling3N, 5);
  assert.deepEqual([T[3].coverage, T[3].coverageN, T[3].target], [0.5, 2, 0.8]);
  assert.ok(T[3].coverageCi80[0] < 0.5 && T[3].coverageCi80[1] > 0.5);
  assert.equal(T[0].coverageCi80[0], 0);
  // 補正の変化（古い順。月次の自動学習と四半期レビュー）
  const ca = ai.calibration.find((c) => c.planId === A);
  assert.equal(ca.factorNow, 0.75);
  assert.deepEqual(ca.path.map((p) => [p.factor, p.old, p.new, p.source, p.sourceLabel]), [
    ['reliability:opinion:鷹野', 1, 1.1, 'R1', '四半期レビュー'],
    ['bias_correction_factor', 1, 0.95, 'AUTO-MONTHLY', '月次の自動学習'],
    ['residual_month_bias_json', '', '{"04":-0.05}', 'AUTO-MONTHLY', '月次の自動学習']]);
  assert.equal(ca.path[1].factorLabel, '偏りの補正');
  assert.equal(ai.calibration.find((c) => c.planId === B).path.length, 0);
  assert.equal(ai.calibration.find((c) => c.planId === C), undefined, '補正の記録が無い計画は出さない');
  // 承認待ちの提案: 一番新しいレビューで、まだ適用していないもの。保存した判断も出す
  assert.deepEqual(ai.pending.map((p) => [p.planId, p.reviewId, p.proposals.map((x) => [x.proposalId, x.targetLabel, x.current, x.proposed, x.decision])]).sort(), [
    [A, 'R2', [['P-B-2', '製品の入力「佐藤」の信頼度', 1, 0.8, '承認']]],
    [B, 'R3', [['P-A-3', 'AI の重み', 0.5, 0.75, '']]]].sort());
  // 気になる点: 補正が下限に張りつく（甲）・P10〜P90 に入る割合が低い（乙: 6 か月で 0）
  const keys = ai.health.map((h) => [h.planId, h.key]);
  assert.ok(keys.some(([p, k]) => p === A && k === 'factor_clamp'));
  assert.ok(keys.some(([p, k]) => p === B && k === 'coverage_low'));
  assert.ok(!keys.some(([p, k]) => p === A && k.startsWith('coverage')), '月が少ない計画は見ない');
  assert.ok(ai.health.every((h) => ['shadow_worse', 'factor_clamp', 'coverage_low', 'coverage_high'].includes(h.key) && h.label));
  const hx = J(env.run(`appInsightHealth_([{ planId: 'P', clientName: 'x', fy: '2026' }], { P: { coverage: 1, coverageN: 12 } },
    { plans: { P: { mapeNow: 0.1, mapeShadow: 0.12 } } }, { P: 1.25 })`));
  assert.deepEqual(hx.map((h) => h.key), ['shadow_worse', 'factor_clamp', 'coverage_high']);
}

// ==== 4. 読み方: 計算用の表は 1 回ずつ。計画ごとに組み立て直さない。控えから返す ====
{
  for (const k of Object.keys(env.cache)) delete env.cache[k];
  for (const k of Object.keys(STATS)) STATS[k] = k === 'bySheet' ? {} : 0;
  const n = env.run(`(() => { APP_STORE_CACHE_ = {}; let n = 0; const orig = appEngTableObjects_;
    appEngTableObjects_ = function () { n++; return orig.apply(null, arguments); };
    try { appAiLearning_(); appPeopleLearning_(); appCrossMaker_(); } finally { appEngTableObjects_ = orig; }
    return n; })()`);
  assert.equal(n, 0, '表の形の計画は appEngTableObjects_ を使わない');
  for (const s of ['ENG_EVAL_LOG', 'ENG_SUBJECTIVE_IMPACT_HISTORY', 'ENG_AI_IMPACT_HISTORY', 'ENG_EVAL_INSIGHTS', 'ENG_QUARTERLY_REVIEW_LOG', 'ENG_POOL_PRIOR']) {
    assert.ok(STATS.bySheet[s].reads <= 2, s + ' は 1 回だけ読む（見出しの確認と中身）');
  }
  assert.equal(STATS.bySheet.ENG_FORMATS, undefined, '表示形式は読まない');
  // 画面からの呼び出しは控えから返す（データ本体を読まない）
  env.call('apiPeopleLearning()'); env.call('apiAiLearning()'); env.call('apiCrossMaker(__in)', { __in: {} });
  const r0 = STATS.reads;
  assert.deepEqual(env.call('apiPeopleLearning()'), people);
  env.call('apiAiLearning()'); env.call('apiCrossMaker(__in)', { __in: {} });
  assert.equal(STATS.reads, r0, '控えから返す');
  // 閲覧は社内全員（外の人は読めない）
  env.call(`apiSaveMember({ email: '${MEMBER}', displayName: 'M' })`);
  env.as(MEMBER);
  assert.equal(env.call('apiCrossMaker(__in)', { __in: {} }).plans.length, 2);
  const pv = env.call('apiPeopleLearning()');
  assert.deepEqual([pv.detail, pv.scoreboard.length], ['summary', 3], '閲覧の人には情報源の種類ごとのまとめ（11 で詳しく）');
  assert.equal(env.call('apiAiLearning()').curves.length, 5);
  env.as(OUTSIDER);
  assert.throws(() => env.call('apiPeopleLearning()'), /権限がありません/);
  env.as(OWNER);
}

// ==== 5. まとめて読む表（appEngAll_）は、計画ごとに組み立てた表（appEngTableObjects_）と同じ。見出しの違う計画は行ごとに持った方から読む ====
{
  const e2 = setUpEnv();
  const H2 = H;
  const r = (sheet, o) => H2[sheet].map((h) => (o[h] === undefined ? '' : o[h]));
  const p1 = e2.seedPlan(e2.makeBook('一', {
    CONFIG: config('一製薬', 2026),
    EVAL_LOG: { values: [H2.EVAL_LOG, r('EVAL_LOG', { eval_id: 'E1', evaluated_at: D(2026, 9, 1), client: '一製薬', target_month: D(2026, 4), scenario: 'neutral', pred: 100, actual: 110,
      evaluation_policy_version: POLICY, constraint_relevant_flag: 1 }),
      [], r('EVAL_LOG', { eval_id: 'E2', evaluated_at: D(2026, 9, 1), client: '一製薬', target_month: '2026/05', scenario: 'neutral', pred: -0, actual: 90, was_overridden: true,
        evaluation_policy_version: POLICY })],
    formulas: { H2: '=1+1' } },
    SOURCE_RELIABILITY: { values: [H2.SOURCE_RELIABILITY, ['一製薬', 'opinion', '鷹野', 1.2, '', '', '', '', '']] },
    PROCESS_STATUS: doneStatus('一製薬', new Date(2026, 5, 6, 10)),
  }));
  const renamed = H2.SOURCE_RELIABILITY.map((h) => (h === 'note' ? 'memo' : h));
  const p2 = e2.seedPlan(e2.makeBook('二', {
    CONFIG: config('二製薬', 2026),
    EVAL_LOG: { values: [H2.EVAL_LOG, r('EVAL_LOG', { eval_id: 'E1', evaluated_at: D(2026, 9, 1), client: '二製薬', target_month: '2026/04', scenario: 'neutral', pred: 200, actual: 210 })] },
    SOURCE_RELIABILITY: { values: [renamed, ['二製薬', 'opinion', '佐藤', 0.8, '', '', '', '', 'メモ']] },
  }));
  assert.equal(e2.table('ENG_SHEETS').find((s) => s.plan_id === p2 && s.sheet === 'SOURCE_RELIABILITY').mode, 'rows', '見出しが違う → 行ごと');
  const same = e2.run(`(() => { APP_STORE_CACHE_ = {}; const bad = [];
    ['EVAL_LOG', 'SOURCE_RELIABILITY', 'EVAL_INSIGHTS'].forEach(s => { const all = appEngAll_(s);
      ['${p1}', '${p2}'].forEach(id => { const one = appEngTableObjects_(id, [s])[s];
        if (JSON.stringify(all[id] || []) !== JSON.stringify(one)) bad.push(s + ' ' + id + ' ' + JSON.stringify(all[id]) + ' / ' + JSON.stringify(one)); }); });
    return bad; })()`);
  assert.deepEqual(J(same), []);
  const ev = J(e2.run(`appEngAll_('EVAL_LOG')['${p1}']`));
  assert.equal(ev.length, 2, '空の行は除く');
  assert.equal(ev[0].ape, '', '数式のセルは空');
  assert.equal(ev[1].was_overridden, true);
  assert.equal(J(e2.run(`appEngAll_('SOURCE_RELIABILITY')['${p2}']`))[0].memo, 'メモ', '行ごとに持った計画は、その見出しのまま');
  assert.deepEqual(J(e2.run(`appEngAll_('EVAL_LOG', [])`)), {});
  assert.deepEqual(Object.keys(J(e2.run(`appEngAll_('EVAL_LOG', ['${p2}'])`))), [p2], '計画を選べる');
  // 精度は、まとめて読んだ行から計算しても同じ
  assert.equal(e2.run(`JSON.stringify(appAccuracyOf_('${p1}'))`), e2.run(`JSON.stringify(appAccuracyOf_('${p1}', appEngAll_('EVAL_LOG')['${p1}']))`));
  assert.equal(J(e2.run(`appAccuracyOf_('${p1}')`)).n, 2, '締まった 2 か月で比べる（記録が無ければ 0 か月で、比べても意味が無い）');
  // 読むのは表 1 回（表示形式や行ごとの表は読まない）
  for (const k of Object.keys(STATS)) STATS[k] = k === 'bySheet' ? {} : 0;
  e2.run(`(() => { APP_STORE_CACHE_ = {}; return appEngAll_('EVAL_LOG'); })()`);
  assert.ok(STATS.bySheet.ENG_EVAL_LOG.reads <= 2, '見出しの確認と中身');
  assert.equal(STATS.bySheet.ENG_FORMATS, undefined);
  assert.equal(STATS.bySheet.ENG_ROWS, undefined);
}

// ==== 6. ベータ分布の分位点・Wilson の区間・四半期 ====
{
  const q = (p, a, b) => env.run(`appBetaQuantile_(${p}, ${a}, ${b})`);
  close(q(0.1, 1, 1), 0.1, 1e-12, '一様分布');
  close(q(0.5, 2, 2), 0.5, 1e-12, '対称');
  close(q(0.1, 0.5, 0.5), Math.sin(0.05 * Math.PI) ** 2, 1e-10, '逆正弦分布（a, b が整数でない）');
  close(env.run('appBetaInc_(0.3, 1, 4)'), 1 - 0.7 ** 4, 1e-12, 'I_x(1, b) = 1 − (1 − x)^b');
  close(q(0.1, 2.5, 7.3), 1 - q(0.9, 7.3, 2.5), 1e-12, 'a と b を入れ替えると裏返し');
  // Beta(3, 7) の 10% 点を、密度の数値積分（シンプソン）で確かめる
  const x10 = q(0.1, 3, 7);
  const dens = (x) => x ** 2 * (1 - x) ** 6 / (2 * 720 / 362880);
  const N = 20000; let s = dens(0) + dens(x10);
  for (let i = 1; i < N; i++) s += (i % 2 ? 4 : 2) * dens((x10 * i) / N);
  close((s * x10) / N / 3, 0.1, 1e-8, '数値積分');
  // n が大きいときは正規分布に近い
  close(q(0.9, 300, 700), 0.3 + 1.2815515655446004 * Math.sqrt(300 * 700 / (1000 ** 2 * 1001)), 1e-3, '正規近似');
  const s1 = J(env.run('appBetaSummary_(10, 5)'));
  close(s1.mean, 2 / 3);
  assert.ok(s1.ci80[0] < s1.mean && s1.mean < s1.ci80[1]);
  // Wilson の区間（80%）
  const w = (k, n) => J(env.run(`appWilson_(${k}, ${n}, APP_INSIGHT_Z80)`));
  const z2 = 1.2815515655446004 ** 2;
  assert.deepEqual(w(0, 10)[0], 0);
  close(w(0, 10)[1], z2 / (10 + z2), 1e-12, 'k = 0 の上の端');
  close(w(8, 10)[0], 1 - w(2, 10)[1], 1e-12, '対称');
  close(w(8, 10)[1], 1 - w(2, 10)[0], 1e-12, '対称');
  assert.ok(w(8, 10)[0] < 0.8 && w(8, 10)[1] > 0.8);
  assert.ok(w(80, 100)[1] - w(80, 100)[0] < w(8, 10)[1] - w(8, 10)[0], '数が多いほど狭い');
  assert.equal(w(0, 0), null);
  assert.deepEqual(['2026/04', '2026/06', '2026/07', '2026/12', '2027/01', '2027/03'].map((m) => env.run(`appInsightQuarter_('${m}')`)),
    ['FY2026-Q1', 'FY2026-Q1', 'FY2026-Q2', 'FY2026-Q3', 'FY2026-Q4', 'FY2026-Q4'], '旧来の quarterLabelFromYm_ と同じ');
  assert.equal(env.run(`appInsightPrevYm_('2026/02', 2)`), '2025/12');
}

// ==== 7. 計画が無いとき: どの画面も空の形で返す ====
{
  const e3 = setUpEnv();
  const x = e3.call('apiCrossMaker(__in)', { __in: {} });
  assert.deepEqual([x.plans, x.fys, x.market, x.totals.plans, x.totals.budget, x.totals.p50, x.totals.ratioP50], [[], [], [], 0, null, null, null]);
  const p = e3.call('apiPeopleLearning()');
  assert.deepEqual([p.lessons, p.causes, p.openActions, p.repeats, p.scoreboard, p.decisions, p.uplift], [[], [], [], [], [], [], []]);
  assert.deepEqual(p.summary, { months: 0, misses: 0, withNotes: 0, duplicatesRemoved: 0, scoredMonths: 0, waitingMonths: 0 });
  const a = e3.call('apiAiLearning()');
  assert.equal(a.curves.length, 5);
  assert.ok(a.curves.every((c) => c.prior.alpha0 === 2 && c.prior.beta0 === 2 && c.prior.from === 'default' && c.quarters.length === 0 && c.n === 0));
  close(a.curves[0].prior.mean, 0.5);
  assert.deepEqual([a.shrinkage.plans, a.shrinkage.pooled, a.shrinkage.mu, a.shrinkage.tau, a.timeline, a.calibration, a.pending, a.health],
    [[], false, 0, 0, [], [], [], []]);
}

// ==== 8. 承認待ちの提案: 一番新しいレビューが判断・適用済みなら出さない。画面の review_id が一番新しいレビューと違えば出さない（C-3 はもう適用できない） ====
{
  const e4 = setUpEnv();
  const log = (client, o) => row('QUARTERLY_REVIEW_LOG', Object.assign({ client, quarter_label: 'FY2026-Q1', phase: 'A', target_field: 'ai_weight_override',
    current_value: '0.5', proposed_value: '0.4', confidence: '中', approval_status: '保留', applied: 0 }, o));
  const head = ['提案ID', '対象', '現在値', '提案値', '自信度', '根拠', '影響見積もり', '承認列', 'ロールバック'];
  const screen = (rid, pid, decision) => ({ values: [['【四半期レビュー: FY2026-Q1】'], [], [], [], [], [], head, [pid, 'ai_weight_override', '0.5', '0.4', '中', '', '…', decision, '…', rid]] });
  const plan = (client, logs, qr) => e4.seedPlan(e4.makeBook(client, { CONFIG: config(client, 2026), QUARTERLY_REVIEW_LOG: { values: [H.QUARTERLY_REVIEW_LOG].concat(logs) }, QUARTERLY_REVIEW: qr }));
  const decidedAt = { approval_decided_at: D(2026, 7, 12), approval_decided_by: OWNER };
  // 一番新しいレビューは却下と決めて処理した（古いレビューは保留のまま）
  plan('丁製薬', [log('丁製薬', { review_id: 'R4', proposal_id: 'P-4', reviewed_at: D(2026, 4, 10) }),
    log('丁製薬', Object.assign({ review_id: 'R5', proposal_id: 'P-5', reviewed_at: D(2026, 7, 10), approval_status: '却下' }, decidedAt))], screen('R5', 'P-5', '却下'));
  // 一番新しいレビューは適用済み
  plan('戊製薬', [log('戊製薬', { review_id: 'R6', proposal_id: 'P-6', reviewed_at: D(2026, 4, 10) }),
    log('戊製薬', Object.assign({ review_id: 'R7', proposal_id: 'P-7', reviewed_at: D(2026, 7, 10), approval_status: '承認', applied: 1, applied_at: D(2026, 7, 12) }, decidedAt))], screen('R7', 'P-7', '承認'));
  // その後の C-1 で提案が無かった（記録の表に行は増えず、画面の review_id だけが新しい）
  plan('己製薬', [log('己製薬', { review_id: 'R8', proposal_id: 'P-8', reviewed_at: D(2026, 7, 10) })],
    { values: [['【四半期レビュー: FY2026-Q2】'], [], [], [], [], [], head, ['', '', '', '', '', '', '', '', '', 'R9']] });
  // 実績が足りず、画面を消した（review_id が無い）
  plan('庚製薬', [log('庚製薬', { review_id: 'R10', proposal_id: 'P-10', reviewed_at: D(2026, 7, 10) })],
    { values: [['⚠ 検証期間不足（2か月のみ確定）'], ['実績が3か月分確定後に C-1 を再実行してください。']] });
  // 比べる: 画面の review_id が一番新しいレビューと同じで、まだ処理していない
  const open = plan('辛製薬', [log('辛製薬', { review_id: 'R11', proposal_id: 'P-11', reviewed_at: D(2026, 7, 10) })], screen('R11', 'P-11', '承認'));
  const pending = e4.call('apiAiLearning()').pending;
  assert.deepEqual(pending.map((p) => [p.planId, p.reviewId, p.proposals.map((x) => [x.proposalId, x.decision])]), [[open, 'R11', [['P-11', '承認']]]],
    '判断・適用済みのレビューと、画面から外れた古いレビューは出さない');
  // 判断の記録には、どのレビューも残る
  assert.deepEqual(e4.call('apiPeopleLearning()').decisions.map((d) => d.reviewId).sort(), ['R10', 'R11', 'R4', 'R5', 'R6', 'R7', 'R8']);
}

// ==== 9. 振り返り: 次回への反映だけを人が書いた行も、重複を除くときに残す。原因の数は画面に出す対応の名前でまとめる ====
{
  const e5 = setUpEnv();
  const ins = (o) => row('EVAL_INSIGHTS', Object.assign({ client: '壬製薬', pred_p50: 1000, range_breach: 1, action_type: 'update',
    next_cycle_reflection: '次回サイクルで前提更新を反映', status: 'open' }, o));
  // 振り返りに出すのは、今の版で測った月（EVAL_LOG の neutral の行がある締まった月）だけ（2026-10-07 D4〜D6）
  e5.seedPlan(e5.makeBook('壬', { CONFIG: config('壬製薬', 2026),
    EVAL_LOG: { values: evalLog('壬製薬', [['2026/04', 700, 1000, 0.05], ['2026/05', 800, 1000, 0.05], ['2026/06', 850, 1000, 0.05], ['2026/07', 1000, 1000, 0.05]]), formats: { D: '@' } },
    EVAL_INSIGHTS: { values: [H.EVAL_INSIGHTS,
    ins({ evaluated_at: D(2026, 5, 10), target_month: D(2026, 4), actual_total: 700, next_cycle_reflection: '単価の前提を見直す' }),   // 人は反映の欄だけを書いた
    ins({ evaluated_at: D(2026, 6, 10), target_month: D(2026, 4), actual_total: 700 }),   // B-4 の再実行で増えた行（自動の値だけ）
    ins({ evaluated_at: D(2026, 6, 10), target_month: D(2026, 5), actual_total: 800, action_type: '前提を更新' }),   // 人が画面で選んだ対応
    ins({ evaluated_at: D(2026, 6, 10), target_month: D(2026, 6), actual_total: 850 }),
    ins({ evaluated_at: D(2026, 6, 10), target_month: D(2026, 7), actual_total: 1000, range_breach: 0, action_type: 'keep', next_cycle_reflection: '現行運用を継続', status: 'monitoring' }),
  ] }, PROCESS_STATUS: doneStatus('壬製薬', new Date(2026, 7, 6, 10)), RUN_LOG: b2Log(D(2026, 5, 1)) }));   // 今の版の B-2 は 5/01 に初めて動いた
  const p = e5.call('apiPeopleLearning()');
  const by = Object.fromEntries(p.lessons.map((x) => [x.ym, x]));
  assert.deepEqual([by['2026/04'].reflection, by['2026/04'].human, by['2026/04'].duplicates], ['単価の前提を見直す', true, 1], '反映の欄だけの記入も、新しい自動の行に負けない');
  assert.deepEqual([by['2026/05'].human, by['2026/05'].actionLabel], [true, '前提を更新']);
  assert.deepEqual([by['2026/06'].human, by['2026/07'].human, by['2026/07'].reflection], [false, false, '現行運用を継続'], '自動の値だけなら人の記入ではない');
  assert.deepEqual(p.summary, { months: 4, misses: 3, withNotes: 2, duplicatesRemoved: 1, scoredMonths: 4, waitingMonths: 0 });
  // 自動の update と、人が選んだ「前提を更新」は画面では同じ名前なので 1 行
  assert.equal(p.causes.length, 1);
  const c = p.causes[0];
  assert.deepEqual([c.direction, c.range, c.actionLabel, c.n, c.actionTypes.slice().sort()], ['over', true, '前提を更新', 3, ['update', '前提を更新']]);
  // 人の記入の見分け方（B-4 が自動で入れる action_type は update と keep、next_cycle_reflection は決まった 2 つの文だけ）
  const human = (o) => e5.run(`appInsightHasHuman_(${JSON.stringify(o)})`);
  assert.deepEqual([
    human({ action_type: 'update', next_cycle_reflection: '次回サイクルで前提更新を反映', status: 'open' }),
    human({ action_type: 'keep', next_cycle_reflection: '現行運用を継続', status: 'monitoring' }),
    human({ next_cycle_reflection: 'メモ' }), human({ action_type: 'add' }), human({ action_type: 'remove' }), human({ status: 'done' })],
  [false, false, true, true, true, true]);
}

// ==== 10. 予算の上乗せは、年度の 12 か月が締まってから実績で見る（途中は統計の着地の見込みで、別の名前）。合計の予算は空模様と同じ（公式版があればその最終予算） ====
{
  const e6 = makeEnv();
  e6.run(`appToday_ = function () { return '2026-10-06'; }`);
  e6.as(OWNER);
  e6.call('apiSetup()');
  const yms = (fy) => Array.from({ length: 12 }, (_, i) => { const m = 4 + i; return (m > 12 ? fy + 1 : fy) + '/' + String(m > 12 ? m - 12 : m).padStart(2, '0'); });
  const output = (fy) => {
    const o = [['FY' + fy + ' 売上予測']];
    for (let r = 2; r <= 25; r++) o.push([]);
    o.push(['年度合計（予測）', 1080, 1200, 1320], [], ['月', 'P10', 'P50', 'P90', '', '', '', '採用予測', '上乗せ']);
    yms(fy).forEach((ym) => o.push([ym, 90, 100, 110, '', '', '', 100, 10]));
    return o;
  };
  const compare = (months, act) => ({ values: [H.EVAL_COMPARE_MONTHLY].concat(months.map((ym) => row('EVAL_COMPARE_MONTHLY', { target_month: ym, actual_total: act,
    forecast_total_p10: 90, forecast_total_p50: 100, forecast_total_p90: 110, ape_p50: Math.abs(100 - act) / act, range_outside_flag: 0 }))), formats: { A: '@' } });
  const HS = H.PROCESS_STATUS;
  const status = (client, b1) => ({ values: [HS, ['step2_status', b1, 'owner', 'success', client, 10, ''], ['step5_status', new Date(b1.getTime() + 3600e3), 'owner', 'success', '', 6, '']] });
  // 年度が終わった計画（FY2025・12 か月が締まった）・途中の計画（FY2026・4 か月）・予測の無い計画（FY2026）
  const done = e6.seedPlan(e6.makeBook('癸', { CONFIG: config('癸製薬', 2025), OUTPUT: { values: output(2025) }, EVAL_COMPARE_MONTHLY: compare(yms(2025), 110),
    PROCESS_STATUS: status('癸製薬', new Date(2026, 3, 5, 10)) }));
  const mid = e6.seedPlan(e6.makeBook('子', { CONFIG: config('子製薬', 2026), OUTPUT: { values: output(2026) }, EVAL_COMPARE_MONTHLY: compare(yms(2026).slice(0, 4), 100),
    PROCESS_STATUS: status('子製薬', new Date(2026, 7, 5, 10)) }));
  const none = e6.seedPlan(e6.makeBook('丑', { CONFIG: config('丑製薬', 2026) }));
  const ver = (id, planId, adopted, uplift) => ({ version_id: id, plan_id: planId, version_no: 1, state: 'APPROVED', annual_p50: 1200, budget_adopted: adopted, budget_uplift: uplift,
    budget_final: adopted + uplift, row_version: 1 });
  e6.run(`appInsertRows_('PLAN_VERSIONS', __v)`, { __v: [ver('V-D', done, 1200, 120), ver('V-M', mid, 1300, 200), ver('V-N', none, 500, 100)] });
  const port = Object.fromEntries(e6.call('apiPortfolio()').plans.map((p) => [p.planId, p]));
  const U = Object.fromEntries(e6.call('apiPeopleLearning()').uplift.map((u) => [u.planId, u]));
  // 途中（4 か月）: 4 か月の実績を年間の予算と比べない（前は 400 / 1500 を出していた）。着地の見込みで見た割合は出す
  const m = U[mid];
  assert.deepEqual([m.actual, m.months, m.complete, m.ratio, m.upliftRealized], [400, 4, false, null, null]);
  assert.equal(m.landing, port[mid].landing);
  close(m.landing, 1200, 1e-6, '実績が予測どおりなら着地は予測の合計');
  close(m.projectedRatio, port[mid].landing / 1500);
  close(m.projectedUpliftRealized, (port[mid].landing - 1300) / 200);
  // 着地の見込みが無い計画は、見込みの割合も null
  assert.deepEqual([U[none].landing, U[none].projectedRatio, U[none].projectedUpliftRealized, U[none].ratio, U[none].upliftRealized], [null, null, null, null, null]);
  // 12 か月が締まった年度: 実績で見る（着地の見込みは実績と同じ）
  const d = U[done];
  assert.deepEqual([d.actual, d.months, d.complete], [1320, 12, true]);
  for (const k of ['ratio', 'upliftRealized', 'projectedRatio', 'projectedUpliftRealized']) close(d[k], 1, 1e-9, k);
  // 合計: 予算は計画ごとの空模様と同じ予算（公式版の最終予算）。今の予算の合計は別の名前。着地の見込みが無い計画は着地の合計に入れない
  assert.deepEqual([port[mid].budget, port[mid].budgetUsed, port[none].budget, port[none].budgetUsed, port[none].landing], [1320, 1500, null, 600, null]);
  const t = e6.call('apiCrossMaker(__in)', { __in: { fy: 2026 } }).totals;
  assert.deepEqual([t.plans, t.budget, t.budgetDraft, t.budgetPlans, t.landingPlans, t.p50, t.p50Budgeted], [2, 2100, 1320, 2, 1, 1200, 1200]);
  close(t.landing, port[mid].landing);
  close(t.ratioLanding, port[mid].ratio, 1e-12, '計画ごとの空模様の比（着地 ÷ 公式版の予算）と同じ');
  close(t.ratioP50, 1200 / 1500, 1e-12, 'P50 のある計画の予算だけで割る');
}

// ==== 11. 人ごとの当たりと判断した人の名前は、予算策定担当以上だけ（ほかの人には情報源の種類ごとのまとめ。AI の学びも同じ）。見せ方の違う人に同じ控えを返さない ====
{
  env.as(OWNER);
  const full = env.call('apiPeopleLearning()');
  const aiFull = env.call('apiAiLearning()');
  env.as(MEMBER);   // 社内の人（閲覧・情報提供だけ）
  const sum = env.call('apiPeopleLearning()');
  const aiSum = env.call('apiAiLearning()');
  assert.deepEqual([full.detail, sum.detail, aiFull.detail, aiSum.detail], ['full', 'summary', 'full', 'summary']);
  // 人の名前・判断した人・人ごとの的中率（信頼度の提案の根拠）は、どちらの画面にも出さない
  const hidden = ['鷹野', '佐藤', '田中', OWNER, '的中率', '"decidedBy"'];
  const text = JSON.stringify(sum);
  for (const s of hidden.concat(['"key"', '"plans"'])) assert.ok(!text.includes(s), '閲覧の人には出さない: ' + s);
  const aiText = JSON.stringify(aiSum);
  for (const s of hidden) assert.ok(!aiText.includes(s), 'AI の学びでも閲覧の人には出さない: ' + s);
  assert.ok(JSON.stringify(full).includes('鷹野') && full.decisions.some((x) => x.decidedBy === 'owner'), '予算策定担当以上には出す');
  assert.equal(full.decisions.find((x) => x.proposalId === 'P-B-1').rationale, '的中率=67% / n=3');
  assert.ok(JSON.stringify(aiFull).includes('鷹野') && JSON.stringify(aiFull).includes('佐藤'));
  // 当たりは種類ごと（人や話題をまとめる）
  assert.deepEqual(sum.scoreboard.map((s) => [s.type, s.n, s.hit, s.sources]).sort(), [['ai_topic', 2, 1, 1], ['factor_product', 2, 0, 1], ['opinion', 6, 4, 2]]);
  const op = sum.scoreboard.find((s) => s.type === 'opinion');
  // 事前分布は種類の基準（AI の学びの曲線と同じ）に合わせる: Beta(α0, β0) に 4 当たり・2 外れ
  const opCurve = aiSum.curves.find((c) => c.type === 'opinion');
  close(op.base, opCurve.base, 1e-12);
  close(op.alpha, opCurve.prior.alpha0 + 4, 1e-9); close(op.beta, opCurve.prior.beta0 + 2, 1e-9);
  assert.equal(op.prior.from, 'pool');
  assert.ok(sum.scoreboard.every((s) => !('appliedR' in s)), '閲覧の人には今の信頼度を出さない（1 人だけの種類ではその人の値になる。2026-10-07）');
  close(full.scoreboard.find((s) => s.type === 'opinion' && s.key === '鷹野').appliedR, 1.0, 1e-9, '予算策定担当以上には人ごとの今の信頼度を出す（鷹野: 甲 1.1・乙 0.9 の平均）');
  assert.ok(sum.scoreboard.every((s, i) => i === 0 || s.ci80[0] - s.base <= sum.scoreboard[i - 1].ci80[0] - sum.scoreboard[i - 1].base + 1e-12));
  // 判断の記録: 判断した人は無し。信頼度の対象は種類まで
  const pb1 = sum.decisions.find((x) => x.proposalId === 'P-B-1');
  assert.deepEqual([pb1.target, pb1.targetLabel, pb1.status, pb1.applied], ['reliability:opinion', '見解の信頼度', '承認', true]);
  assert.equal(sum.decisions.find((x) => x.proposalId === 'P-B-2').targetLabel, '製品の入力の信頼度');
  assert.deepEqual(sum.decisions.map((x) => x.proposalId), full.decisions.map((x) => x.proposalId));
  assert.equal(sum.decisions.find((x) => x.proposalId === 'P-B-1').rationale, '', '信頼度の提案の根拠（その人の的中率）は出さない');
  // AI の学び: 承認待ちの提案と補正の変化の、信頼度の対象は種類まで・値も出さない（2026-10-07: 情報源が 1 人だけの種類では、種類ごとの値でもその人の信頼度がわかる）。ほかは同じ
  const pa = aiSum.pending.find((p) => p.planId === A).proposals[0];
  assert.deepEqual([pa.proposalId, pa.target, pa.targetLabel, pa.current, pa.proposed, pa.rationale, pa.decision],
    ['P-B-2', 'reliability:factor_product', '製品の入力の信頼度', '', '', '', '承認']);
  const paFull = aiFull.pending.find((p) => p.planId === A).proposals[0];
  assert.deepEqual([paFull.current, paFull.proposed], [1, 0.8], '予算策定担当以上には値も出す');
  assert.deepEqual([pb1.current, pb1.proposed], ['', ''], '判断の記録でも、閲覧の人には信頼度の値を出さない');
  const pathOf = (x) => x.calibration.find((c) => c.planId === A).path.map((p) => [p.factor, p.factorLabel, p.old, p.new, p.source]);
  assert.deepEqual(pathOf(aiSum)[0], ['reliability:opinion', '見解の信頼度', '', '', 'R1']);
  assert.deepEqual(pathOf(aiFull)[0], ['reliability:opinion:鷹野', '見解「鷹野」の信頼度', 1, 1.1, 'R1']);
  assert.deepEqual(pathOf(aiSum).slice(1), pathOf(aiFull).slice(1), '信頼度でない補正はそのまま');
  assert.deepEqual(aiSum.pending.find((p) => p.planId === B), aiFull.pending.find((p) => p.planId === B), '信頼度でない提案はそのまま');
  for (const k of ['curves', 'shrinkage', 'timeline', 'health']) assert.deepEqual(aiSum[k], aiFull[k], k);
  // 根拠を出さないのは信頼度の提案だけ
  const why = (o, hide) => env.run(`appInsightRationale_(${JSON.stringify(o)}, ${hide})`);
  assert.deepEqual([why({ target_field: 'reliability:opinion:x', rationale: '的中率=50% / n=2' }, true), why({ target_field: 'reliability:opinion:x', rationale: '的中率=50% / n=2' }, false),
    why({ target_field: 'ai_weight_override', rationale: '誤差が縮む' }, true)], ['', '的中率=50% / n=2', '誤差が縮む']);
  // ほかは同じ（振り返りの担当だけ空）
  const noOwner = (xs) => xs.map((x) => Object.assign({}, x, { owner: '' }));
  assert.deepEqual(sum.lessons, noOwner(full.lessons));
  assert.deepEqual(sum.openActions, noOwner(full.openActions));
  assert.deepEqual([sum.causes, sum.repeats, sum.summary, sum.uplift], [full.causes, full.repeats, full.summary, full.uplift]);
  // 控えは見せ方ごと: 同じデータのまま交互に呼んでも混ざらない（どちらも控えから）
  const r0 = STATS.reads;
  env.as(OWNER);
  assert.deepEqual(env.call('apiPeopleLearning()'), full);
  assert.deepEqual(env.call('apiAiLearning()'), aiFull);
  env.as(MEMBER);
  assert.deepEqual(env.call('apiPeopleLearning()'), sum);
  assert.deepEqual(env.call('apiAiLearning()'), aiSum);
  assert.equal(STATS.reads, r0, 'どちらも控えから');
  // クライアント単位の予算策定担当でも、人ごとの行を出す
  env.as(OWNER);
  env.call(`apiGrantRole({ email: '${MEMBER}', role: 'PLANNER', scopeType: 'CLIENT', clientId: '${env.table('PLANS').find((p) => p.plan_id === B).client_id}' })`);
  env.as(MEMBER);
  const planner = env.call('apiPeopleLearning()');
  assert.equal(planner.detail, 'full');
  assert.deepEqual([planner.scoreboard, planner.decisions, planner.lessons], [full.scoreboard, full.decisions, full.lessons]);
  assert.deepEqual(env.call('apiAiLearning()'), aiFull);
  env.as(OWNER);
  // 役割の判定（予算策定担当以上。範囲は問わない。分からなければ出さない）
  assert.deepEqual(['VIEWER', 'CONTRIBUTOR', 'PLANNER', 'APPROVER', 'ADMIN'].map((r) => env.run(`appInsightDetail_({ roles: [{ role: '${r}', scope_type: 'CLIENT', client_id: 'X' }] })`)),
    ['summary', 'summary', 'full', 'full', 'full']);
  assert.equal(env.run('appInsightDetail_(undefined)'), 'summary');
  assert.equal(J(env.run('appPeopleLearning_()')).detail, 'summary');
  assert.equal(J(env.run('appAiLearning_()')).detail, 'summary');
}

// ==== 12. 保存の後は新しい結果を返す。計画ごとの当たりと精度の控えは、保存した計画の分だけ計算し直す（ほかの計画の履歴は読み直さない） ====
{
  env.as(OWNER);
  env.call('apiPeopleLearning()'); env.call('apiAiLearning()');   // 控えがある状態から
  env.run('appPlanReadMinRows_ = () => 0');   // 表が大きいとき（計画の行だけを探して読む）
  env.run(`__evd = []; __acc = []; __evdOrig = appSourceEvidence_; __accOrig = appAccuracyOf_;
    appSourceEvidence_ = function (ids) { __evd.push(ids.slice()); return __evdOrig.apply(null, arguments); };
    appAccuracyOf_ = function (id) { __acc.push(id); return __accOrig.apply(null, arguments); }`);
  // 甲の振り返りを保存する（B-4 の再実行で増えた 4 月の行の、次回への反映だけ）
  const v = env.call('apiPlanView(__in)', { __in: { planId: A } });
  const st = env.runJob('PLAN.EDIT', { planId: A, action: 'INSIGHT.SAVE', inputHash: v.inputHash,
    args: { rows: [{ row: 3, hypothesis: '', actionType: 'update', reflection: '受注時期の前提を見直す', owner: '', status: 'open' }] } });
  assert.equal(st.status, 'DONE', st.error);
  env.run('__evd = []; __acc = []');
  for (const k of Object.keys(STATS)) STATS[k] = k === 'bySheet' ? {} : 0;
  const after = env.call('apiPeopleLearning()');
  const subjCells = STATS.bySheet.ENG_SUBJECTIVE_IMPACT_HISTORY.readCells;
  const apr = after.lessons.find((x) => x.planId === A && x.ym === '2026/04');
  assert.deepEqual([apr.reflection, apr.human, apr.duplicates], ['受注時期の前提を見直す', true, 1], '保存した記入がすぐ出る（古い控えを返さない）');
  assert.equal(after.summary.withNotes, 1, '4 月は 1 か月（2025/05 の行は数字が違うので出さない）');
  env.call('apiAiLearning()');
  assert.deepEqual(J(env.run('__evd')), [[A]], '当たりは保存した計画の分だけ数え直す（乙は控えから）');
  assert.deepEqual(J(env.run('__acc')), [A], '精度も保存した計画の分だけ');
  // 履歴の表は、保存した計画の行だけを読む
  for (const k of Object.keys(STATS)) STATS[k] = k === 'bySheet' ? {} : 0;
  env.run(`(() => { APP_STORE_CACHE_ = {}; appReadTable_('ENG_SUBJECTIVE_IMPACT_HISTORY'); })()`);
  assert.ok(subjCells < STATS.bySheet.ENG_SUBJECTIVE_IMPACT_HISTORY.readCells, `全部の行は読まない: ${subjCells} < ${STATS.bySheet.ENG_SUBJECTIVE_IMPACT_HISTORY.readCells}`);
  // 控えを使っても、全部を数え直しても同じ結果
  const aiAfter = env.call('apiAiLearning()');
  for (const k of Object.keys(env.cache)) delete env.cache[k];
  assert.deepEqual(env.call('apiPeopleLearning()'), after);
  assert.deepEqual(env.call('apiAiLearning()'), aiAfter);
  env.run('appSourceEvidence_ = __evdOrig; appAccuracyOf_ = __accOrig; appPlanReadMinRows_ = () => 3000');
}

// ==== 13. 締まった月だけで数える（2026-10-07 村井さん承認 D4・D5）・当たりはその月が始まる前の最後の予測の回で測る（D6） ====
{
  const e7 = setUpEnv();
  // B-1 は 10/03（9 月はまだ途中。8 月まで締まった）。9 月・10 月の記録（途中の実績で、大きく外れて見える）は読み飛ばす（消さない）
  const pRun = D(2026, 5, 20), qRun = D(2026, 6, 10), rRun = D(2026, 7, 15);   // P は 6 月の前・Q は 7 月の前・R は 8 月の前の最後の回
  const imp = (runAt, ym, quant) => impact('α製薬', runAt, ym, quant);
  const pu = (runAt, ym, key, dir) => push('α製薬', runAt, ym, 'opinion', key, dir);
  const id = e7.seedPlan(e7.makeBook('α', {
    CONFIG: config('α製薬', 2026),
    EVAL_LOG: { values: evalLog('α製薬', [['2026/05', 1000, 1100, 0.05], ['2026/06', 1000, 1100, 0.05], ['2026/07', 1000, 1100, 0.05], ['2026/08', 1000, 1100, 0.05],
      ['2026/09', 100, 1000, 0.05], ['2026/10', 50, 1000, 0.05]]), formats: { D: '@' } },
    EVAL_COMPARE_MONTHLY: { values: [H.EVAL_COMPARE_MONTHLY].concat([['2026/05', 1000], ['2026/06', 1000], ['2026/07', 1000], ['2026/08', 1000], ['2026/09', 100]]
      .map(([ym, a]) => row('EVAL_COMPARE_MONTHLY', { target_month: ym, actual_total: a, forecast_total_p50: 1100, ape_p50: Math.abs(1100 - a) / a, range_outside_flag: 1 }))), formats: { A: '@' } },
    EVAL_INSIGHTS: { values: [H.EVAL_INSIGHTS].concat([
      { evaluated_at: D(2026, 10, 3), target_month: '2026/06', actual_total: 1000, pred_p50: 1100, action_type: 'update', status: 'open', range_breach: 1 },
      { evaluated_at: D(2026, 10, 3), target_month: '2026/09', actual_total: 100, pred_p50: 1000, cause_hypothesis: '途中の実績', action_type: 'update', status: 'open', range_breach: 1 },
    ].map((o) => row('EVAL_INSIGHTS', Object.assign({ client: 'α製薬' }, o)))) },
    AI_IMPACT_HISTORY: { values: [H.AI_IMPACT_HISTORY,
      imp(pRun, '2026/05', 900), imp(pRun, '2026/06', 900), imp(pRun, '2026/07', 900), imp(pRun, '2026/08', 900), imp(pRun, '2026/09', 900),
      imp(qRun, '2026/06', 1100), imp(qRun, '2026/07', 1100), imp(qRun, '2026/08', 1100), imp(qRun, '2026/09', 1100),
      imp(rRun, '2026/07', 1300), imp(rRun, '2026/08', 1300), imp(rRun, '2026/09', 1300)] },
    SUBJECTIVE_IMPACT_HISTORY: { values: [H.SUBJECTIVE_IMPACT_HISTORY,
      pu(pRun, '2026/06', '鷹野', 1), pu(pRun, '2026/07', '鷹野', 1), pu(pRun, '2026/08', '佐藤', 1),
      pu(qRun, '2026/06', '鷹野', 1), pu(qRun, '2026/07', '鷹野', -1),
      pu(rRun, '2026/07', '鷹野', 1), pu(rRun, '2026/08', '鷹野', -1), pu(rRun, '2026/09', '鷹野', -1)] },
    PROCESS_STATUS: doneStatus('α製薬', new Date(2026, 9, 3, 10)),
  }));
  // 精度・精度の推移・縮めた偏りの材料: 締まった 4 か月（5〜8 月）だけ
  const acc = J(e7.run(`appAccuracyOf_('${id}')`));
  assert.deepEqual([acc.cutoffYm, acc.n, acc.months.map((m) => m.month)], ['2026/09', 4, ['2026/05', '2026/06', '2026/07', '2026/08']]);
  close(acc.mape, 0.1, 1e-12, '締まった月の外れ幅だけ（9・10 月の途中の実績は入れない）');
  const x = e7.call('apiCrossMaker(__in)', { __in: { fy: 2026 } }).plans[0];
  assert.deepEqual([x.accuracy.n, x.mapeMonths], [4, 4]);
  close(x.mape, 0.1, 1e-12, '計画の一覧の外れ幅（検証の表）も締まった月だけ（9 月の行の外れ幅 9.0 は入れない）');
  assert.deepEqual([x.k, x.actualMonths, x.actualYtd], [5, 5, 4000], '暫定実績は締まった 4〜8 月（行の無い 4 月は 0 円）。9 月の途中の実績は入れない');
  const ai = e7.call('apiAiLearning()');
  assert.deepEqual(ai.timeline.map((t) => t.ym), ['2026/05', '2026/06', '2026/07', '2026/08'], '精度の推移に締まっていない月を出さない');
  // 振り返り: 締まった 6 月だけ（9 月の行は人の記入があっても出さない）
  const pl = e7.call('apiPeopleLearning()');
  assert.deepEqual(pl.lessons.map((l) => l.ym), ['2026/06']);
  assert.deepEqual([pl.summary.months, pl.openActions.map((l) => l.ym)], [1, ['2026/06']]);
  // 当たり（D6）: 6 月は P（6/10 の Q は 6 月が始まった後）、7 月は Q、8 月は R で測る。佐藤は 8 月の前の最後の回（R）で押していないので数えない。
  // 9 月は締まっていない。5 月は締まって実績もあるが、5 月が始まる前の回が無い（P は 5/20）ので数えない
  //   6 月: P の過去の売上だけの予測 900 < 実績 1000（上）・鷹野 + → 当たり（前は 6/10 の Q（1100・下）で外れにしていた）
  //   7 月: Q の 1100 > 1000（下）・鷹野 − → 当たり（前は R（7/15）の + で外れ）
  //   8 月: R の 1300 > 1000（下）・鷹野 − → 当たり
  const tk = pl.scoreboard.find((s) => s.key === '鷹野');
  assert.deepEqual([tk.n, tk.hit], [3, 3]);
  assert.equal(pl.scoreboard.find((s) => s.key === '佐藤'), undefined, '前の回でしか押していない人は数えない');
  assert.deepEqual([pl.noPreMonth, ai.noPreMonth], [1, 1], 'その月が始まる前の予測が無い月（5 月）');
  assert.deepEqual(ai.curves.find((c) => c.type === 'opinion').quarters.map((q) => [q.quarter, q.n, q.hit]), [['FY2026-Q1', 1, 1], ['FY2026-Q2', 2, 2]]);
  // 控えから読んでも同じ（控えの形は { rows, noPre, cur }）
  for (const k of Object.keys(e7.cache)) if (!k.includes('EVD_')) delete e7.cache[k];
  const again = e7.call('apiPeopleLearning()');
  assert.deepEqual([again.scoreboard, again.noPreMonth], [pl.scoreboard, pl.noPreMonth]);
  // 行は消さない
  assert.equal(e7.table('ENG_EVAL_LOG').filter((r) => r.plan_id === id).length, 6 * 3);
  assert.equal(e7.table('ENG_EVAL_INSIGHTS').filter((r) => r.plan_id === id).length, 2);
  // 月の初めちょうど（日本の暦の 1 日 0 時）の回は、その月が始まった後の回。idA = A の回の人の行の run_id（空なら時刻で同じ回を見分ける）。
  // withB = false なら、B の回では人が押していない
  const tabs = (runA, runB, idA = 'A', withB = true) => ({
    PROCESS_STATUS: { P: [{ step_key: 'step2_status', status: 'success', last_run_date: new Date('2026-08-06T01:00:00Z') }, { step_key: 'step5_status', status: 'success', last_run_date: new Date('2026-08-06T02:00:00Z') }] },
    EVAL_LOG: { P: [{ scenario: 'neutral', constraint_relevant_flag: 1, target_month: '2026/06', actual: 1000, evaluation_policy_version: POLICY }] },
    AI_IMPACT_HISTORY: { P: [{ run_id: 'A', run_at: runA, target_month: '2026/06', pred_p50_quant_only: 900, forecast_source: 'forecast_open' },
      { run_id: 'B', run_at: runB, target_month: '2026/06', pred_p50_quant_only: 1100, forecast_source: 'forecast_open' }] },
    SUBJECTIVE_IMPACT_HISTORY: { P: [{ run_id: idA, run_at: runA, target_month: '2026/06', source_type: 'opinion', source_key: 'x', push_direction: 1, forecast_source: 'forecast_open' }]
      .concat(withB ? [{ run_id: 'B', run_at: runB, target_month: '2026/06', source_type: 'opinion', source_key: 'x', push_direction: -1, forecast_source: 'forecast_open' }] : []) }
  });
  const ev = (t) => J(e7.run(`(() => { const noPre = {}; const rows = appSourceEvidence_(['P'], s => __t[s] || {}, noPre); return { rows: rows, noPre: noPre }; })()`, { __t: t }));
  const last = new Date('2026-05-31T14:59:59Z'), first = new Date('2026-05-31T15:00:00Z');
  const one = (t) => ev(t).rows.map((r) => [r.ym, r.key, r.hit]);
  assert.deepEqual(one(tabs(new Date('2026-05-30T01:00:00Z'), last)), [['2026/06', 'x', 1]], '5/31 23:59:59 の回（B）が 6 月の前の最後: 1100 > 1000・− → 当たり（A の + は使わない）');
  assert.deepEqual(one(tabs(last, first)), [['2026/06', 'x', 1]], '6/1 0:00 の回（B）は使わない: A の 900 < 1000・+ → 当たり');
  assert.deepEqual(one(tabs(last, first, '')), [['2026/06', 'x', 1]], 'run_id の無い行は、時刻で同じ回を見分ける');
  assert.deepEqual([one(tabs(new Date('2026-05-30T01:00:00Z'), last, 'A', false)), one(tabs(new Date('2026-05-30T01:00:00Z'), last, '', false))], [[], []],
    '6 月の前の最後の回（B）で押していなければ、前の回（A）の押しでは数えない（run_id が無くても時刻で見分ける）');
  const none = ev(tabs(first, new Date('2026-06-15T00:00:00Z')));
  assert.deepEqual([none.rows, none.noPre], [[], { P: ['2026/06'] }], '6 月が始まる前の回が無ければ数えず、その月を返す');
}

// ==== 14. 今の検証の版で測った月だけ（2026-10-07 D4〜D6）。前の版の EVAL_LOG の行（月が始まった後の予測で測った）が締まった月に残っていても、
// 精度・精度の推移・縮めた偏り・当たり・振り返りには使わない（消さない）。その月が始まる前の予測が無い月は数える ====
{
  const e8 = setUpEnv();
  const pRun = D(2026, 4, 10);   // 4 月が始まった後・5 月より前の回（4 月には、その月が始まる前の回が無い）
  const imp = (ym) => impact('β製薬', pRun, ym, 900);
  const pu = (ym, dir) => push('β製薬', pRun, ym, 'opinion', '鷹野', dir);
  const V2 = 'policy-2026H1-v2';
  const id = e8.seedPlan(e8.makeBook('β', {
    CONFIG: config('β製薬', 2026),
    // 4・5 月は前の版の行だけ（今の B-2 は測らず、上書きもしない）。6〜8 月は今の版
    EVAL_LOG: { values: evalLog('β製薬', [['2026/04', 1000, 1500, 0.05, V2], ['2026/05', 1000, 600, 0.05, V2],
      ['2026/06', 1000, 1100, 0.05], ['2026/07', 1000, 1100, 0.05], ['2026/08', 1000, 1100, 0.05]]), formats: { D: '@' } },
    EVAL_INSIGHTS: { values: [H.EVAL_INSIGHTS].concat([
      { evaluated_at: D(2026, 9, 7), target_month: '2026/04', actual_total: 1000, pred_p50: 1500, cause_hypothesis: '前の版の外れ', owner: '鷹野', action_type: 'update', status: 'in_progress', range_breach: 1 },
      { evaluated_at: D(2026, 10, 6), target_month: '2026/06', actual_total: 1000, pred_p50: 1100, action_type: 'update', status: 'open', range_breach: 1 },
    ].map((o) => row('EVAL_INSIGHTS', Object.assign({ client: 'β製薬' }, o)))) },
    AI_IMPACT_HISTORY: { values: [H.AI_IMPACT_HISTORY, imp('2026/04'), imp('2026/05'), imp('2026/06'), imp('2026/07'), imp('2026/08')] },
    SUBJECTIVE_IMPACT_HISTORY: { values: [H.SUBJECTIVE_IMPACT_HISTORY, pu('2026/04', 1), pu('2026/05', 1), pu('2026/06', 1), pu('2026/07', 1), pu('2026/08', -1)] },
    PROCESS_STATUS: doneStatus('β製薬', new Date(2026, 9, 6, 10)),   // 10/06 の取り込み: 9 月まで締まった
  }));
  const acc = J(e8.run(`appAccuracyOf_('${id}')`));
  assert.deepEqual([acc.cutoffYm, acc.n, acc.months.map((m) => m.month)], ['2026/10', 3, ['2026/06', '2026/07', '2026/08']], '前の版の 4・5 月は精度に入れない');
  close(acc.mape, 0.1, 1e-12);
  const ai = e8.call('apiAiLearning()');
  assert.deepEqual(ai.timeline.map((t) => t.ym), ['2026/06', '2026/07', '2026/08'], '精度の推移に前の版の月を出さない');
  assert.deepEqual(ai.shrinkage.plans.map((p) => [p.planId, p.n]), [[id, 3]]);
  close(ai.shrinkage.plans[0].mapeNow, 0.1, 1e-12, '縮めた偏りの材料も今の版の月だけ');
  // 当たり: 6・7 月は当たり（900 < 1000・+）、8 月は外れ（−）。5 月は月が始まる前の回（4/10）があるが、前の版の行の実績では数えない。
  // 4 月は月が始まる前の回が無い（その月が始まる前の予測が無い月として数える）
  const pl = e8.call('apiPeopleLearning()');
  const tk = pl.scoreboard.find((x) => x.key === '鷹野');
  assert.deepEqual([tk.n, tk.hit], [3, 2]);
  assert.deepEqual([pl.noPreMonth, ai.noPreMonth], [1, 1], '4 月（締まって実績の行はあるが、その月が始まる前の予測が無い）');
  assert.deepEqual(ai.curves.find((c) => c.type === 'opinion').quarters.map((q) => [q.quarter, q.n, q.hit]), [['FY2026-Q1', 1, 1], ['FY2026-Q2', 2, 1]]);
  // 振り返り: 今の版で測った 6 月だけ（前の版の 4 月の行は、人の記入があっても出さない）
  assert.deepEqual([pl.lessons.map((l) => l.ym), pl.summary.months, pl.openActions.map((l) => l.ym)], [['2026/06'], 1, ['2026/06']]);
  // 控え（{ rows, dirs, noPre, cur, from }）から読んでも同じ。前の形の控え（dirs・cur・from が無い）は使わずに数え直す
  for (const k of Object.keys(e8.cache)) if (!k.includes('EVD_')) delete e8.cache[k];
  const again = e8.call('apiPeopleLearning()');
  assert.deepEqual([again.lessons, again.scoreboard, again.noPreMonth], [pl.lessons, pl.scoreboard, pl.noPreMonth]);
  const fromCache = (value) => {
    e8.run(`appJobPutResult_(appInsightEvidenceKey_('${id}'), __v)`, { __v: value });
    for (const k of Object.keys(e8.cache)) if (!k.includes('EVD_') && !k.includes('APP_JOB_RESULT_')) delete e8.cache[k];
    return e8.call('apiPeopleLearning()');
  };
  const b2At = D(2026, 9, 1).getTime();   // 今の版の B-2 が初めて動いた時刻（6 月の振り返りの行は 10/06 に書いた）
  const empty = fromCache({ rows: [], dirs: [0, 0], noPre: [], cur: [], from: null });
  assert.deepEqual([empty.lessons, empty.scoreboard, empty.noPreMonth, empty.summary.scoredMonths], [[], [], 0, 0], '今の形の控えはそのまま使う（振り返りの月も控えから）');
  const cached = fromCache({ rows: [], dirs: [0, 0], noPre: [], cur: [['2026/06', 1100, 1000]], from: b2At });
  assert.deepEqual([cached.lessons.map((l) => [l.ym, l.pred, l.actual]), cached.scoreboard, cached.summary.scoredMonths], [[['2026/06', 1100, 1000]], [], 1],
    '振り返りの月と数字・初めの B-2 の時刻も控えから（[月, 予測, 実績]・from）');
  assert.deepEqual(fromCache({ rows: [], dirs: [0, 0], noPre: [], cur: [['2026/06', 900, 1000]], from: b2At }).lessons, [], '控えの数字と違う行は出さない');
  assert.deepEqual(fromCache({ rows: [], dirs: [0, 0], noPre: [], cur: [['2026/06', 1100, 1000]], from: D(2026, 10, 7).getTime() }).lessons, [],
    '控えの時刻（今の版の B-2 が初めて動いた時刻）より前に書いた行は出さない');
  const noB2 = fromCache({ rows: [], dirs: [0, 0], noPre: [], cur: [['2026/06', 1100, 1000]], from: null });
  assert.deepEqual([noB2.lessons, noB2.summary.scoredMonths], [[], 1], '今の版の B-2 の時刻が無ければ出さない');
  const old = fromCache({ rows: [], dirs: [0, 0], noPre: [] });
  assert.deepEqual([old.lessons, old.scoreboard, old.noPreMonth], [pl.lessons, pl.scoreboard, pl.noPreMonth], '前の形の控え（cur が無い）は数え直す');
  const noFrom = fromCache({ rows: [], dirs: [0, 0], noPre: [], cur: [] });
  assert.deepEqual([noFrom.lessons, noFrom.scoreboard, noFrom.noPreMonth, noFrom.summary.scoredMonths], [pl.lessons, pl.scoreboard, pl.noPreMonth, 3],
    '前の形の控え（from が無い。cur の実績は B-4 の形にする前のもの）も数え直す');
  const monthsOnly = fromCache({ rows: [], dirs: [0, 0], noPre: [], cur: ['2026/06', '2026/07', '2026/08'], from: b2At });
  assert.deepEqual([monthsOnly.lessons, monthsOnly.scoreboard, monthsOnly.noPreMonth], [pl.lessons, pl.scoreboard, pl.noPreMonth],
    '前の形の控え（cur が月だけ）も数え直す');
  const timed = fromCache({ rows: [], dirs: [0, 0], noPre: [], cur: [['2026/06', Date.parse('2026-10-06T03:00:00Z')], ['2026/07', 0]], from: b2At });
  assert.deepEqual([timed.lessons, timed.scoreboard, timed.noPreMonth, timed.summary.scoredMonths], [pl.lessons, pl.scoreboard, pl.noPreMonth, 3],
    '前の形の控え（[月, B-2 が書いた時刻] の 2 つ組。時刻を予測と読まない）も数え直す');
  assert.deepEqual(fromCache({ rows: [], dirs: [0, 0], noPre: [], cur: [], from: '2026-09-01' }).summary.scoredMonths, 3, '時刻が数でない控えも数え直す');
  // 当たりの基準（2026-10-13）の前の形の控え（dirs が無い・行が [月, 種類, 人や話題, 当たり] の 4 つ組）は数え直す（基準を付けられないため）
  const noDirs = fromCache({ rows: [['2026/06', 'opinion', '鷹野', 1]], noPre: [], cur: [['2026/06', 1100, 1000]], from: b2At });
  assert.deepEqual([noDirs.scoreboard, noDirs.noPreMonth], [pl.scoreboard, pl.noPreMonth], 'dirs の無い控えは数え直す');
  const fourCols = fromCache({ rows: [['2026/06', 'opinion', '鷹野', 1]], dirs: [2, 1], noPre: [], cur: [['2026/06', 1100, 1000]], from: b2At });
  assert.deepEqual(fourCols.scoreboard, pl.scoreboard, '行が 4 つ組の控えは数え直す');
  // 今の形の控えなら、基準はその [上, 下] から付ける（全計画の割合はこの 1 計画だけ → 寄せても同じ割合）
  const withDirs = fromCache({ rows: [['2026/06', 'opinion', '鷹野', 1, 1], ['2026/08', 'opinion', '鷹野', 0, -1]], dirs: [2, 1], noPre: [], cur: [], from: b2At });
  const wt = withDirs.scoreboard.find((x) => x.key === '鷹野');
  assert.deepEqual([wt.n, wt.hit], [2, 1]);
  close(wt.expected, 2 / 3 + 1 / 3, 1e-12, '上の基準 2/3・下の基準 1/3');
  // 行は消さない
  assert.equal(e8.table('ENG_EVAL_LOG').filter((r) => r.plan_id === id).length, 5 * 3);
  assert.equal(e8.table('ENG_EVAL_LOG').filter((r) => r.plan_id === id && r.evaluation_policy_version === V2).length, 2 * 3);
  assert.equal(e8.table('ENG_EVAL_INSIGHTS').filter((r) => r.plan_id === id).length, 2);
}

// ==== 15. 振り返りは、予測と実績が今の版の B-2 が測った数字（B-4 が写す形）と同じで、その計画で今の版の B-2 が初めて動いた後に書いた行だけ
// （違う行は次の B-4 が書き直すまで出さない。行は消さない）。B-2 のたびの時刻では決めない（旧来の B-2 は測るたびに evaluated_at を書き直す） ====
{
  const at = Date.parse('2026-10-06T03:00:00Z');   // 今の版の B-2 が 7〜9 月を測り直した時刻（振り返りの決まりには使わない）
  const first = at - 864e5 * 40;                    // 今の版の B-2 が初めて動いた時刻（appEvalPolicySince_）
  const ins = (when, ym, pred, o) => Object.assign({ evaluated_at: when, client: 'γ製薬', target_month: ym, actual_total: 1000, pred_p50: pred, range_breach: 1,
    action_type: 'update', status: 'open' }, o || {});
  const lessons = (rows, months, plans, since) => J(env.run('appInsightLessons_(__p, __i, false, __m, __s)',
    { __p: plans || [{ planId: 'P', clientName: 'γ', fy: '2026' }], __i: plans ? rows : { P: rows }, __m: plans ? months : { P: months },
      __s: since || (plans ? Object.fromEntries(plans.map((p) => [p.planId, first])) : { P: first }) }));
  const months = [['2026/07', 1100, 1000], ['2026/08', 1100, 1000], ['2026/09', 1100, 1000]];
  const rows = [
    ins(new Date(at + 864e5), '2026/07', 900),                               // 前の版の数字（向きも逆）。B-2 の後の日時でも出さない
    ins(new Date(first - 864e5), '2026/08', 1100, { cause_hypothesis: '前の版の記入', action_type: 'keep', status: 'monitoring', range_breach: 0 }),
    //   ↑ 前の版の B-4 の行（初めの B-2 の前）。数字がたまたま同じでも、機械の列が前の決まりのままなので、人の記入があっても出さない
    ins(new Date(at - 864e5 * 30), '2026/08', 1100, { cause_hypothesis: '受注の前倒し' }),   // 後の B-2（at）より前でも、初めの B-2 の後に書いた行は出す
    ins(new Date(at - 864e5), '2026/09', 900, { cause_hypothesis: '前の記入' }),   // 数字の違う行は、数字には使わない（人の記入は、9 月に使える行があるので使う）
    ins(new Date(at + 3600e3), '2026/09', 1100),                             // 今の数字の行
    ins(new Date(at + 7200e3), '2026/09', ''),                               // 予測が空の行（空は同じとみなさない）
  ];
  const r = lessons(rows, months);
  // 人の記入は、その月に使える行があれば、その月の人が書いた一番新しい行から（数字・書いた時刻によらない。2026-10-08 村井さん承認）:
  // 9 月は数字の違う行の記入（その行もまとめた行に数える）。8 月は初めの B-2 の後の行の記入（初めの B-2 の前の行より新しい）
  assert.deepEqual(r.lessons.map((l) => [l.ym, l.pred, l.direction, l.range, l.human, l.hypothesis, l.duplicates]).sort(),
    [['2026/08', 1100, 'over', true, true, '受注の前倒し', 0], ['2026/09', 1100, 'over', true, true, '前の記入', 1]],
    '7 月（数字の違う行だけ）は出さない。数字は使える行から');
  assert.deepEqual([r.summary.months, r.summary.duplicatesRemoved, r.summary.scoredMonths, r.summary.waitingMonths], [2, 1, 3, 1], '7 月は B-4 待ち');
  // 今の版の B-2 の時刻が無い計画（null・渡さない）は、どの行も出さない（測った月の数は数える）
  for (const since of [{ P: null }, {}]) {
    const none = lessons(rows, months, undefined, since);
    assert.deepEqual([none.lessons, none.summary.months, none.summary.scoredMonths, none.summary.waitingMonths], [[], 0, 3, 3], '初めの B-2 の時刻が無い: ' + JSON.stringify(since));
  }
  // 差は 0.5 円より小さければ同じ。数は文字でも同じ読み方（appNum_）。B-2 の側が空なら同じとみなさない
  const one = (row, m) => lessons([row], [m || ['2026/07', 1100, 1000]]).lessons.map((l) => [l.pred, l.actual]);
  assert.deepEqual(one(ins(new Date(at), '2026/07', 1100.4, { actual_total: 999.6 })), [[1100.4, 999.6]]);
  assert.deepEqual([one(ins(new Date(at), '2026/07', 1100.5)), one(ins(new Date(at), '2026/07', 1100, { actual_total: 1000.5 }))], [[], []], '0.5 円の差は違う');
  assert.deepEqual(one(ins(new Date(at), '2026/07', '1100', { actual_total: '1000' })), [[1100, 1000]], '文字の数');
  assert.deepEqual([one(ins(new Date(at), '2026/07', 1100), ['2026/07', null, 1000]), one(ins(new Date(at), '2026/07', 1100, { actual_total: '' }))], [[], []], '空はどちらの側でも違う');
  assert.deepEqual(lessons([ins(new Date(at), '2026/07', 1100)], []).lessons, [], '今の版で測っていない月は出さない（これまでどおり）');
  // 書いた時刻: 初めの B-2 ちょうどは出す・その前と読めない時刻は出さない。文字の時刻（ISO・日本の時刻の 'yyyy/MM/dd HH:mm'）も読む
  assert.deepEqual([one(ins(new Date(first), '2026/07', 1100)), one(ins(new Date(first - 1), '2026/07', 1100)), one(ins('', '2026/07', 1100)), one(ins('x', '2026/07', 1100))],
    [[[1100, 1000]], [], [], []], '初めの B-2 と同じ時刻は出す・前と読めない時刻は出さない');
  assert.deepEqual([one(ins(new Date(first).toISOString(), '2026/07', 1100)), one(ins('2026/10/07 09:00', '2026/07', 1100)), one(ins('2026/08/01 09:00', '2026/07', 1100))],
    [[[1100, 1000]], [[1100, 1000]], []], '文字の時刻');
  const scoredRow = (when, since) => env.run(`appInsightRowScored_({ "2026/07": { pred: 0, actual: 0 } }, "2026/07", 0, 0, ${when}, ${since})`);
  assert.equal(scoredRow('new Date(1000)', 1000), true, '0 円どうしは同じ（空ではない）');
  assert.deepEqual([scoredRow('new Date(999)', 1000), scoredRow('new Date(1000)', 'null'), scoredRow('new Date(1000)', 'undefined')], [false, false, false],
    '初めの B-2 より前・初めの B-2 の時刻が無いときは違う');
  // B-4 が写す形: 予測はそのまま、実績は 0 円より下なら 0 円（返品・値引きの月）。数でなければ null
  assert.deepEqual(J(env.run('[appInsightB4View_(1100, -200), appInsightB4View_("1100", "-0.4"), appInsightB4View_(-50, 300), appInsightB4View_("", null), appInsightB4View_("x", "")]')),
    [{ pred: 1100, actual: 0 }, { pred: 1100, actual: 0 }, { pred: -50, actual: 300 }, { pred: null, actual: null }, { pred: null, actual: null }]);
  // 違う年度の同じ月にまた外れた（同じメーカー）。月は今の版で測った月だけ
  const rep = lessons({ P1: [ins(new Date(at), '2025/05', 1000, { actual_total: 800 })], P2: [ins(new Date(at), '2026/05', 1000, { actual_total: 900 })] },
    { P1: [['2025/05', 1000, 800]], P2: [['2026/05', 1000, 900]] }, [{ planId: 'P1', clientName: 'γ', fy: '2025' }, { planId: 'P2', clientName: 'γ', fy: '2026' }]);
  assert.deepEqual([rep.repeats, rep.summary.scoredMonths], [[{ clientName: 'γ', month: '05', fys: ['2025', '2026'], n: 2 }], 2]);
}

// ==== 16. 同じ月の行が 2 つ以上（v0.27.2 より前の B-4 の残り）で、人の記入が最後の行に無い: 記入は人が書いた一番新しい行から、数字は使える行から。
// 締めていない年度の計画の、B-2 が測ったのに振り返りの行がまだ無い月（waitingMonths）。2026-10-08 村井さん承認 ====
{
  const at = Date.parse('2026-10-06T03:00:00Z');
  const first = at - 864e5 * 40;
  const ins = (when, ym, pred, o) => Object.assign({ evaluated_at: new Date(when), client: 'γ製薬', target_month: ym, actual_total: 1000, pred_p50: pred, range_breach: 0,
    action_type: 'keep', status: 'monitoring', next_cycle_reflection: '現行運用を継続' }, o || {});
  const run = (rows, months, frozen, plans) => J(env.run('appInsightLessons_(__p, __i, false, __m, __s, __f)', {
    __p: plans || [{ planId: 'P', clientName: 'γ', fy: '2026' }], __i: plans ? rows : { P: rows }, __m: plans ? months : { P: months },
    __s: plans ? Object.fromEntries(plans.map((p) => [p.planId, first])) : { P: first }, __f: frozen }));
  const months = [['2026/07', 1100, 1000], ['2026/08', 1100, 1000], ['2026/09', 1100, 1000]];
  const rows = [
    // 7 月: 前の B-4 の 2 つの行。人の記入は 1 つ目（数字は前の B-2 の 900・初めの B-2 の前）。最後の行は B-4 が今の数字で書き直した（記入なし）
    ins(first - 864e5 * 3, '2026/07', 900, { cause_hypothesis: '大口の失注', action_type: '入力を修正', next_cycle_reflection: '見解を見直す', owner: '鷹野', status: 'in_progress', range_breach: 1 }),
    ins(at, '2026/07', 1100, { range_breach: 1, action_type: 'update', status: 'open', next_cycle_reflection: '次回サイクルで前提更新を反映' }),
    // 8 月: 人の記入のある行が 2 つ（どちらも使える行でない）。一番新しい方の記入を使う
    ins(first - 864e5 * 2, '2026/08', 950, { cause_hypothesis: '古い記入', owner: '佐藤' }),
    ins(first - 864e5, '2026/08', 980, { cause_hypothesis: '新しい記入', owner: '鷹野', status: 'done' }),
    ins(at, '2026/08', 1100),
    // 9 月: 使える行が無い（数字の違う行の記入だけ）→ 出さない（B-4 待ち）
    ins(at - 864e5, '2026/09', 900, { cause_hypothesis: '9 月の記入', owner: '鷹野' }),
  ];
  const r = run(rows, months);
  const by = Object.fromEntries(r.lessons.map((l) => [l.ym, l]));
  assert.deepEqual(Object.keys(by).sort(), ['2026/07', '2026/08'], '使える行が無い 9 月は出さない（人の記入があっても）');
  const jul = by['2026/07'];
  assert.deepEqual([jul.pred, jul.actual, jul.direction, jul.range], [1100, 1000, 'over', true], '7 月の数字・印は使える行（最後の行）から');
  assert.deepEqual([jul.hypothesis, jul.actionType, jul.reflection, jul.owner, jul.status, jul.statusLabel, jul.human, jul.duplicates],
    ['大口の失注', '入力を修正', '見解を見直す', '鷹野', 'in_progress', '対応中', true, 1], '7 月の記入は、最後の行でない人の記入の行から');
  const aug = by['2026/08'];
  assert.deepEqual([aug.pred, aug.hypothesis, aug.owner, aug.status, aug.human, aug.duplicates], [1100, '新しい記入', '鷹野', 'done', true, 1], '8 月は人が書いた一番新しい行の記入');
  assert.deepEqual(r.summary, { months: 2, misses: 2, withNotes: 2, duplicatesRemoved: 2, scoredMonths: 3, waitingMonths: 1 }, '9 月は B-4 待ち');
  assert.deepEqual(r.openActions.map((x) => [x.ym, x.statusLabel]), [['2026/07', '対応中']], '残っている対応も記入の状態から');
  // 同じ時刻なら後の行
  const tie = run([ins(first - 864e5, '2026/07', 900, { cause_hypothesis: '前' }), ins(first - 864e5, '2026/07', 900, { cause_hypothesis: '後' }), ins(at, '2026/07', 1100)], months);
  assert.equal(tie.lessons[0].hypothesis, '後');
  // waitingMonths: 締めた年度の計画（frozen）は数えない（B-4 を動かせない）。scoredMonths は数える
  const plans = [{ planId: 'P1', clientName: 'γ', fy: '2025' }, { planId: 'P2', clientName: 'δ', fy: '2026' }];
  const two = run({ P1: [], P2: [ins(at, '2026/07', 1100)] }, { P1: [['2025/07', 1100, 1000], ['2025/08', 1100, 1000]], P2: months }, { P1: true }, plans);
  assert.deepEqual([two.summary.scoredMonths, two.summary.waitingMonths, two.summary.months], [5, 2, 1], '締めた年度の P1 の 2 か月は数えない（P2 の 8・9 月だけ）');
  const open = run({ P1: [], P2: [ins(at, '2026/07', 1100)] }, { P1: [['2025/07', 1100, 1000], ['2025/08', 1100, 1000]], P2: months }, {}, plans);
  assert.equal(open.summary.waitingMonths, 4, '締めていなければ数える');
  assert.equal(run(rows, months, undefined).summary.waitingMonths, 1, 'frozen を渡さなければ、どの計画も締めていないものとして数える');
  // 締めた年度（appInsightFrozen_）: 年度ごとに 1 回だけ確かめる。確かめられない年度は締めたものとして数えない
  env.run(`(() => { const orig = appYearIsFrozen_; globalThis.__fyAsked = []; appYearIsFrozen_ = fy => { __fyAsked.push(String(fy)); if (String(fy) === '2024') throw new Error('x'); return String(fy) === '2025'; }; globalThis.__restoreFrozen = () => { appYearIsFrozen_ = orig; }; })()`);
  const fz = J(env.run('appInsightFrozen_(__p)', { __p: [{ planId: 'A', fy: '2025' }, { planId: 'B', fy: '2026' }, { planId: 'C', fy: '2025' }, { planId: 'D', fy: 2024 }] }));
  assert.deepEqual(fz, { A: true, C: true, D: true });
  assert.deepEqual(J(env.run('__fyAsked')), ['2025', '2026', '2024'], '年度ごとに 1 回');
  env.run('__restoreFrozen()');
}

console.log('app-insights: all tests passed');
