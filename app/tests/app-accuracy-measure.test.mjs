#!/usr/bin/env node
/**
 * app-accuracy-measure.test.mjs — 外れの測り方と補正の見せ方（2026-10-13 村井さん承認。レビューの提案 1・7・9・10・11）。
 *   1. 外れ幅と偏りは、月ごとの外れの平均ではなく合計の比（WAPE）: 外れ幅 = Σ|中心 − 実績| ÷ Σ|実績|、偏り = Σw(中心 − 実績) ÷ Σw|実績|。
 *      実績が 0 に近い月が 1 つあっても、外れ幅・偏り・縮めた補正の倍率が飛ばない（計画の一覧・検証・分析・AI の学びの推移）
 * モックの上の確かめで、本物の Apps Script の上では動かしていない。
 *
 *   node app/tests/app-accuracy-measure.test.mjs
 */
import assert from 'node:assert/strict';
import { OWNER, makeEnv, setUpEnv, J } from './gas-mock.mjs';

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < (eps || 1e-9), (msg || '') + ' ' + a + ' ≈ ' + b);
const pure = makeEnv();
const run = (code, vars) => J(pure.run(code, vars));
const POLICY = pure.run('APP_EVAL_POLICY_VERSION');

/** 検証の記録の行（見出し → 値）: [月, 実績, 中心, 幅]。下振れ = 中心 × (1 − 幅)・上振れ = 中心 × (1 + 幅) */
const evalRows = (months) => [].concat(...months.map(([ym, act, p50, w = 0.05]) => [['nega', p50 * (1 - w)], ['neutral', p50], ['posi', p50 * (1 + w)]]
  .map(([sc, p]) => ({ target_month: ym, scenario: sc, pred: p, actual: act, evaluated_at: '2026-04-10T10:00:00+0900', evaluation_policy_version: POLICY, constraint_relevant_flag: 1 }))));

// ==== 1. 外れ幅と偏りは合計の比（WAPE） ====
{
  // 合計の比の形
  const w = run('appWape_(__m)', { __m: [{ p50: 110, actual: 100 }, { p50: 90, actual: 100 }, { p50: 100, actual: 50 }] });
  close(w.mape, (10 + 10 + 50) / 250);
  close(w.bias, (10 - 10 + 50) / 250);
  const ww = run('appWape_(__m, [1, 3])', { __m: [{ p50: 100, actual: 50 }, { p50: 100, actual: 150 }] });
  close(ww.bias, (50 - 3 * 50) / (50 + 3 * 150), 1e-12, '重みつき');
  assert.deepEqual(run('appWape_([])'), { mape: null, bias: null }, '月が無ければ値なし');
  assert.deepEqual(run('appWape_([{ p50: 5, actual: 0 }])'), { mape: null, bias: null }, '実績の合計が 0 なら値なし');

  // 報告の例: 6 か月とも中心 1 億・実績ほぼ 1 億。いちばん新しい月だけ実績が 1 万円
  const acts = [1.02e8, 0.97e8, 1.03e8, 0.98e8, 1.01e8, 0.99e8];
  const yms = ['2025/10', '2025/11', '2025/12', '2026/01', '2026/02', '2026/03'];
  const acc = (last) => run(`appAccuracyOf_('X', __rows, '2026/04', [])`, { __rows: evalRows(yms.map((ym, i) => [ym, i === 5 ? last : acts[i], 1e8])) });
  const ok = acc(0.99e8), bad = acc(1e4);
  assert.deepEqual([ok.n, bad.n, bad.leaks], [6, 6, 0]);
  // 外れ幅: 外れの合計 ÷ 実績の合計（どの月も同じ重み）
  close(ok.mape, 0.12e8 / acts.reduce((s, a) => s + a, 0), 1e-12, '実績がほぼ 1 億: 外れ幅 2%');
  const sumBad = acts.slice(0, 5).reduce((s, a) => s + a, 0) + 1e4;
  close(bad.mape, (0.11e8 + (1e8 - 1e4)) / sumBad, 1e-12, '1 万円の月があっても 22% ほど');
  assert.ok(bad.mape > 0.2 && bad.mape < 0.25, '月ごとの外れの平均なら 166,000% を超える: ' + bad.mape);
  // 偏り: 新しい月ほど重い重み（半減期 4 か月）の合計の比
  const wt = yms.map((_, i) => Math.pow(0.5, (5 - i) / 4));
  const actsBad = acts.slice(0, 5).concat([1e4]);
  close(bad.bias, wt.reduce((s, x, i) => s + x * (1e8 - actsBad[i]), 0) / wt.reduce((s, x, i) => s + x * actsBad[i], 0), 1e-12, '偏り');
  assert.ok(bad.bias > 0.3 && bad.bias < 0.35, '強気に寄るが何千 % にはならない: ' + bad.bias);
  assert.ok(Math.abs(ok.bias) < 0.01, '実績がほぼ 1 億なら偏りはほぼ 0: ' + ok.bias);
  // 月ごとの外れ（表の「外れ」）は月ごとの値のまま
  close(bad.months[5].err, (1e8 - 1e4) / 1e4, 1e-9, '月の外れ');
  // 直近とその前（6 か月以上: 直近 3 か月とその前の 3 か月）も合計の比
  close(bad.trend.recent, (0.02e8 + 0.01e8 + (1e8 - 1e4)) / (0.98e8 + 1.01e8 + 1e4), 1e-12, '直近 3 か月');
  close(bad.trend.before, (0.02e8 + 0.03e8 + 0.03e8) / (1.02e8 + 0.97e8 + 1.03e8), 1e-12, 'その前の 3 か月');
  // 縮めた補正の倍率（計画が 1 つ: 0 へ縮める）は下限 0.75 に張りつかない
  const sh = run('appBiasShadow_({ X: __a })', { __a: bad }).plans.X;
  close(sh.shrunk, bad.bias * bad.biasW / (bad.biasW + 3), 1e-12, '縮めた偏り');
  assert.ok(sh.factorShadow > 0.8 && sh.factorShadow < 0.9, '倍率は下限に張りつかない: ' + sh.factorShadow);
  close(sh.mapeNow, bad.mape, 1e-12, '今の外れ幅は精度の外れ幅と同じ');
  // 実績がどの月も同じなら、月ごとの外れの平均と同じ（今までの値）
  const flat = run(`appAccuracyOf_('X', __rows, '2026/04', [])`, { __rows: evalRows(yms.map((ym, i) => [ym, 100, 100 + (i % 2 ? 7 : -4)])) });
  close(flat.mape, (3 * 7 + 3 * 4) / 600, 1e-12);
  const wf = yms.map((_, i) => Math.pow(0.5, (5 - i) / 4)), ef = yms.map((_, i) => (i % 2 ? 0.07 : -0.04));
  close(flat.bias, wf.reduce((s, x, i) => s + x * ef[i], 0) / wf.reduce((s, x) => s + x, 0), 1e-12, '重みつきの平均と同じ');
  const mf = ef.reduce((s, e) => s + e, 0) / 6;
  close(flat.errVar, ef.reduce((s, e) => s + (e - mf) * (e - mf), 0) / 6, 1e-12, 'ばらつきも月ごとの外れの分散と同じ');
}

// ---- 計画を通して確かめる見本（app-v11-live-landing と同じ形）: FY2026、締まった 4・5 月（実績 105・90、中心 100） ----
const fyYms = (fy) => Array.from({ length: 12 }, (_, i) => { const m = 4 + i; return (m > 12 ? fy + 1 : fy) + '/' + String(m > 12 ? m - 12 : m).padStart(2, '0'); });
function pipelineEnv() {
  const env = makeEnv();
  env.run(`appToday_ = function () { return '2026-07-08'; }`);
  env.as(OWNER);
  env.call('apiSetup()');
  const H = (s) => J(env.run(`APP_ENGINE_SHEETS.${s}.header`));
  const HC = H('EVAL_COMPARE_MONTHLY'), HS = H('PROCESS_STATUS'), HE = H('EVAL_LOG'), HR = H('RUN_LOG'), HK = H('CALIBRATION_STATE'), HF = H('FORECAST_SNAPSHOT');
  const obj = (head, o) => head.map((h) => (o[h] === undefined ? '' : o[h]));
  const output = [['FY2026 売上予測']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 1100, 1200, 1300]);
  output.push([], ['月', 'P10', 'P50', 'P90', '', '', '', '採用予測', '上乗せ']);
  fyYms(2026).forEach((ym) => output.push([ym, 80, 100, 120, '', '', '', 100, '']));
  /**
   * opts: { b1, b2（PROCESS_STATUS の B-1・B-2 の成功の時刻。b2 を省くと B-2 の成功なし）, runLog（[関数名, 時刻]）, months（[月, 実績, 中心]。
   * 検証の表と EVAL_LOG に入れる。EVAL_LOG は今の版）, extraCompare（検証の表だけに足す [月, 実績, 中心]）, cal（CALIBRATION_STATE の行 [{…}]）, snap（FORECAST_SNAPSHOT の行 [{…}]）, client }
   */
  const book = (client, o) => {
    const months = o.months || [['2026/04', 105, 100], ['2026/05', 90, 100]];
    const cmp = months.concat(o.extraCompare || []).map(([ym, a, p]) => obj(HC, { target_month: ym, actual_total: a, forecast_total_p10: p * 0.8, forecast_total_p50: p,
      forecast_total_p90: p * 1.2, ape_p50: Math.abs(p - a) / a, range_outside_flag: 0 }));
    const ev = [].concat(...months.map(([ym, a, p]) => [['nega', p * 0.8], ['neutral', p], ['posi', p * 1.2]].map(([sc, v]) => obj(HE, { eval_id: 'E-' + ym + sc,
      evaluated_at: o.evalAt || new Date(2026, 5, 6, 11), client: o.evalClient || client, target_month: ym, scenario: sc, pred: v, actual: a, evaluation_policy_version: POLICY, constraint_relevant_flag: 1 }))));
    const st = [HS, ['step2_status', o.b1, 'owner', 'success', client, 10, ''], ...(o.b2 ? [['step5_status', o.b2, 'owner', 'success', '', 2, '']] : [])];
    return env.makeBook(client, {
      CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
      OUTPUT: { values: output },
      EVAL_COMPARE_MONTHLY: { values: [HC, ...cmp] },
      EVAL_LOG: { values: [HE, ...ev], formats: { D: '@' } },
      PROCESS_STATUS: { values: st },
      ...(o.runLog ? { RUN_LOG: { values: [HR, ...o.runLog.map(([fn, at]) => obj(HR, { run_id: 'R-' + fn + at.getTime(), run_at: at, run_by: 'owner', function_name: fn, client, status: 'success', count: 1 }))] } } : {}),
      ...(o.cal ? { CALIBRATION_STATE: { values: [HK, ...o.cal.map((r) => obj(HK, r))] } } : {}),
      ...(o.snap ? { FORECAST_SNAPSHOT: { values: [HF, ...o.snap.map((r) => obj(HF, r))], formats: { D: '@' } } } : {}),
    });
  };
  return { env, book, seed: (client, o) => env.seedPlan(book(client, o)) };
}
const B1 = new Date(2026, 6, 6, 10), B2old = new Date(2026, 5, 6, 11), B2now = new Date(2026, 6, 6, 11);

// ==== 1（続き）. 計画の一覧の外れ幅も合計の比 ====
{
  const { env, seed } = pipelineEnv();
  const id = seed('ふつう製薬', { b1: B1, b2: B2now });
  const p = env.call('apiPortfolio()').plans.find((x) => x.planId === id);
  assert.equal(p.mapeMonths, 2);
  close(p.mape, (5 + 10) / (105 + 90), 1e-12, '外れの合計 ÷ 実績の合計（月ごとの外れの平均 7.9% ではない）');
  const lv = env.call('apiLearningView(__in)', { __in: { planId: id } });
  close(lv.accuracy.mape, p.mape, 1e-12, '検証の画面の外れ幅と同じ');
  close(lv.accuracy.bias, (Math.pow(0.5, 1 / 4) * -5 + 10) / (Math.pow(0.5, 1 / 4) * 105 + 90), 1e-12, '偏り（新しい月ほど重い）');
}

console.log('app-accuracy-measure: all tests passed');
