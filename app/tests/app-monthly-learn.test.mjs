#!/usr/bin/env node
/*
 * app-monthly-learn.test.mjs — B-5 月次の自動学習を、本物の旧来の計算で、新アプリの実行（PLAN.RUN）から動かす（2026-10-07 の直し）。
 * - 誤差は補正を掛ける前の予測で測る（FORECAST_SNAPSHOT の calibration_applied_json の係数で割り戻す）
 * - LEARN.MONTHLY から動かしても、B-2（EVAL.REPORT）の後の自動の実行でも、同じ学び方になる
 * - 補正の掛かっていない計画では、今までと同じ値
 * 実績は月末から 6 日後（4/06）に取り込んだので 6 か月とも締まった月、予測 S1 はどの月も始まる前の回（2026-10-07 の検証の決まり。
 * 締まっていない月・月が始まった後の回は app-legacy-closed-months.test.mjs で確かめる）
 * 数字はテスト用の作りもの。GAS 上での動作確認の代わりではない。
 *
 *   node app/tests/app-monthly-learn.test.mjs
 */
import assert from 'node:assert/strict';
import { setUpEnv } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const CLIENT = 'テスト製薬';
const MONTHS = ['2025/10', '2025/11', '2025/12', '2026/01', '2026/02', '2026/03'];
const ACTUAL = 100;
const RAW = 110;   // 補正の前の予測は、どの月も 10% 多い

/**
 * 計画のブック。月ごとに、締まる前の予測の回（S1・係数 factorUsed を掛けた）と、締まった後の回（S2・予測 = 実績・別の係数）がある。
 * evalLog = true なら、B-2 が書くのと同じ EVAL_LOG も入れる（LEARN.MONTHLY だけを動かす場合）
 */
function book(env, factorUsed, evalLog) {
  const H = env.run('(() => { const o = {}; Object.keys(APP_ENGINE_SHEETS).forEach(k => { o[k] = APP_ENGINE_SHEETS[k].header || null; }); return o; })()');
  const pred = RAW * factorUsed;
  const snap = [H.FORECAST_SNAPSHOT];
  const run = (sid, at, ym, p50, source, factor) => ['nega', 'neutral', 'posi'].forEach((sc, i) => {
    const v = p50 * [0.9, 1, 1.1][i];
    snap.push([sid, at, CLIENT, ym, sc, p50, 0, 0, 0, v, p50 * 0.9, p50 * 1.1, JSON.stringify({ opinion: '', forecast_source: source }), '',
      JSON.stringify({ version: 'test', bias_correction_factor: factor, residual_month_bias_json: '' })]);
  });
  MONTHS.forEach((ym, i) => {
    run('S1-' + i, D(2025, 9 + i, 20), ym, pred, 'forecast_open', factorUsed);
    run('S2-' + i, D(2025, 10 + i, 20), ym, ACTUAL, 'actual_closed', 0.8);   // 締まった後の回（使わない。係数も違う）
  });
  const evalRows = [H.EVAL_LOG];
  if (evalLog) MONTHS.forEach((ym, i) => evalRows.push(['E' + i, D(2026, 4, 2), CLIENT, ym, 'neutral', pred, ACTUAL, Math.abs(pred - ACTUAL) / ACTUAL, 0, 'model_limitation',
    'P50', 1, pred - ACTUAL, Math.abs(pred - ACTUAL), 'over', 1, '', '', '', 'test', 'policy-2026H1-v3', 1]));
  return env.makeBook('クライアント別売上予測', {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', CLIENT], ['[必須] 予測年度FY（YYYY）', 2025], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    PROCESS_STATUS: { values: [H.PROCESS_STATUS, ['step2_status', D(2026, 4, 6), 'owner', 'success', CLIENT, 6, ''], ['step4_status', D(2026, 3, 20), 'owner', 'success', CLIENT, 12, '']] },
    RUN_LOG: { values: [H.RUN_LOG] },
    ACTUAL_EVAL_MONTHLY: { values: [H.ACTUAL_EVAL_MONTHLY].concat(MONTHS.map((ym) => [CLIENT, 'BASE', '製品A', ym, ACTUAL, 1, D(2026, 4, 6)])), formats: { D: '@' } },
    FORECAST_SNAPSHOT: { values: snap, formats: { D: '@' } },
    EVAL_LOG: { values: evalRows, formats: { D: '@' } },
    EVAL_COMPARE_MONTHLY: { values: [H.EVAL_COMPARE_MONTHLY], cols: 40 },   // B-2 は 25 列目から横に要約を書く
    CALIBRATION_STATE: { values: [H.CALIBRATION_STATE, [CLIENT, D(2026, 3, 1), 'auto', '', '', '[]', factorUsed, '', '', '', '', 1, '']] },
    CALIBRATION_HISTORY: { values: [H.CALIBRATION_HISTORY] },
  });
}

/** 期待値（エンジンとは別に、設計の式から）: 新しい月から w = 0.5^(i/4)、postBias = Σw·e / (Σw + 3)、目標 = 1 ÷ (1 + postBias)、1 回の幅 ±0.05、暦月は 1 ÷ (1 + Σw·eM / (Σw + 2)) − 1（2026-10-13 から近似しない） */
function expected(e, eM, cur) {
  const w = MONTHS.map((_, i) => Math.pow(0.5, i / 4));
  const ws = w.reduce((s, x) => s + x, 0);
  const target = 1 / (1 + (e * ws) / (ws + 3));
  const factor = cur + Math.max(-0.05, Math.min(0.05, target - cur));
  const mb = {};
  // 新しい月（2026/03）から順に。暦月はどれも 1 回だけ
  [...MONTHS].reverse().forEach((ym, i) => { const b = 1 / (1 + (w[i] * eM) / (w[i] + 2)) - 1; if (Math.abs(b) >= 0.005) mb[String(Number(ym.slice(5)))] = Number(b.toFixed(4)); });
  return { factor, target, mb };
}

function calState(env, planId) {
  const rows = env.table('ENG_CALIBRATION_STATE').filter((r) => r.plan_id === planId);
  assert.equal(rows.length, 1);
  return rows[0];
}
const history = (env, planId) => env.table('ENG_CALIBRATION_HISTORY').filter((r) => r.plan_id === planId);
const sameMonthBias = (json, exp) => {
  const got = JSON.parse(json || '{}');
  assert.deepEqual(Object.keys(got).sort(), Object.keys(exp).sort());
  Object.keys(exp).forEach((k) => assert.ok(Math.abs(got[k] - exp[k]) < 1e-9, k + ': ' + got[k] + ' / ' + exp[k]));
};

// ==== 1. LEARN.MONTHLY: 係数 0.95 が掛かった予測（104.5）から、割り戻した 110 で学ぶ ====
{
  const env = setUpEnv();
  const planId = env.seedPlan(book(env, 0.95, true));
  const st = env.runJob('PLAN.RUN', { planId, action: 'LEARN.MONTHLY' });
  assert.equal(st.status, 'DONE', st.error);
  const res = st.result.result.result;
  assert.equal(res.method, 'raw');
  assert.equal(res.corrected, 6, '6 か月とも、掛かっていた係数 0.95 を割り戻した');
  // 補正の前の誤差 e = +10%。暦月は係数 0.95 を掛けた後に残る誤差 eM = 110 × 0.95 / 100 − 1 = +4.5%
  const exp = expected(0.10, RAW * 0.95 / ACTUAL - 1, 0.95);
  const cal = calState(env, planId);
  assert.ok(Math.abs(Number(cal.bias_correction_factor) - exp.factor) < 1e-9, cal.bias_correction_factor + ' / ' + exp.factor);
  assert.ok(Number(cal.bias_correction_factor) < 0.95, '係数は下がり続ける（今までは 1 に向かって戻っていた）');
  // 今までの学び方（104.5 をそのまま使う）なら e = +4.5% で、係数は 0.974 へ戻っていた
  const old = expected(RAW * 0.95 / ACTUAL - 1, RAW * 0.95 / ACTUAL - 1, 0.95);
  assert.ok(old.factor > 0.97 && Math.abs(Number(cal.bias_correction_factor) - old.factor) > 0.025);
  sameMonthBias(cal.residual_month_bias_json, exp.mb);
  assert.match(cal.note, /^auto-learned .+ \(n=6, raw, corrected=6\)$/, 'どの学び方かをメモに残す');
  const h = history(env, planId);
  assert.deepEqual(h.map((r) => [r.review_id, r.factor_name]), [['AUTO-MONTHLY', 'bias_correction_factor'], ['AUTO-MONTHLY', 'residual_month_bias_json']], '履歴の列はそのまま');
  assert.equal(h[0].old_value, '0.95');
  const action = env.table('PLAN_ACTIONS').filter((r) => r.plan_id === planId && r.action === 'LEARN.MONTHLY');
  assert.equal(action.length, 1);
  assert.match(String(action[0].result_json), /"method":"raw"/, '実行の記録にも残る');
}

// ==== 2. EVAL.REPORT（B-2）の後の自動の実行も、同じ学び方 ====
{
  const env = setUpEnv();
  const planId = env.seedPlan(book(env, 0.95, false));
  const st = env.runJob('PLAN.RUN', { planId, action: 'EVAL.REPORT' });
  assert.equal(st.status, 'DONE', st.error);
  const evalLog = env.table('ENG_EVAL_LOG').filter((r) => r.plan_id === planId && r.scenario === 'neutral');
  assert.equal(evalLog.length, 6, 'B-2 が締まる前の回（S1）で EVAL_LOG を書いた');
  evalLog.forEach((r) => assert.ok(Math.abs(Number(r.pred) - RAW * 0.95) < 1e-9, '締まった後の回（予測 = 実績）は使わない'));
  const exp = expected(0.10, RAW * 0.95 / ACTUAL - 1, 0.95);
  const cal = calState(env, planId);
  assert.ok(Math.abs(Number(cal.bias_correction_factor) - exp.factor) < 1e-9, cal.bias_correction_factor + ' / ' + exp.factor);
  sameMonthBias(cal.residual_month_bias_json, exp.mb);
  assert.match(cal.note, /\(n=6, raw, corrected=6\)$/);
  const ps = env.table('ENG_PROCESS_STATUS').filter((r) => r.plan_id === planId && r.step_key === 'learn_status');
  assert.equal(ps.length, 1);
  assert.match(ps[0].error_summary, /^auto:bias_correction_factor,residual_month_bias_json$/);
}

// ==== 3. 補正の掛かっていない計画（係数 1）は、今までと同じ値 ====
{
  const env = setUpEnv();
  const planId = env.seedPlan(book(env, 1, true));
  const st = env.runJob('PLAN.RUN', { planId, action: 'LEARN.MONTHLY' });
  assert.equal(st.status, 'DONE', st.error);
  assert.equal(st.result.result.result.corrected, 0);
  // 今までの式: e = eM = +10%（pred = 110）。1 回の幅で 0.95 まで
  const exp = expected(0.10, 0.10, 1);
  const cal = calState(env, planId);
  assert.equal(Number(cal.bias_correction_factor), 0.95);
  assert.equal(exp.factor, 0.95);
  sameMonthBias(cal.residual_month_bias_json, exp.mb);
  assert.match(cal.note, /\(n=6, raw, corrected=0\)$/);
}

console.log('app-monthly-learn: all tests passed');
