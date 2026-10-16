#!/usr/bin/env node
/**
 * app-v10-layer-effects.test.mjs — 層ごとの効き（LAYER_EFFECTS。SCHEMA_PLAN_v10-12_JA.md の 3-3）と予測の版の列（FORECAST_RUNS。3-8）。
 *   1. 分け方（計算だけ）: 6 つの層を足すと最後の値（月ごと）・補正と Vertex・人の種類ごとの内訳・締まった月・記録が無い月・倍率が 0 以下
 *   2. 本物の A-9（モックの上）: 予測 1 回で 12 行。final_p50 = FORECAST_MONTHLY の p50・stat_p50 = obj_p50・足すと一致・締まった月の印（actual_closed）と層 0・
 *      スポット・人の内訳に名前が無い・同じ入力なら同じ値。FORECAST_RUNS の 3 列（新しい回だけ。前の行は空のまま読める）
 *   3. 控えの書き直しで二重にならない
 *   4. 根拠: 最新と前の回の層ごとの月の合計（どの層で変わったか）。閲覧の人にも出す（名前は無い）。画面の表（内訳・前回から）
 *   5. LMDI を使わない理由: 1 にしても予測の数字は同じだが、保存する OUTPUT に表が足され、CONFIG の中身（種が見る表）が変わる
 * 数字はテスト用の作りもの。モックの上の確かめで、本物の Apps Script の上では動かしていない。
 *
 *   node app/tests/app-v10-layer-effects.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setUpEnv, OWNER, uiHtml, sources } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
/** 日本の時刻（月は 1 始まり） */
const jst = (y, m, d, H = 0, M = 0) => new Date(Date.UTC(y, m - 1, d, H - 9, M));
const CLIENT = 'テスト製薬';
const LAYER_KEYS = ['stat_p50', 'spot_yen', 'human_yen', 'ai_yen', 'calib_yen', 'other_yen'];
const sumOf = (r) => LAYER_KEYS.reduce((a, k) => a + Number(r[k]), 0);
const near = (a, b, tol = 1e-6) => Math.abs(Number(a) - Number(b)) <= tol * Math.max(1, Math.abs(Number(b)));

const env = setUpEnv();
const CTX = `({ actor: '${OWNER}', requestId: 'TEST', roles: [] })`;
const effects = (h, r) => env.call('appLayerEffects_(__h, __r)', { __h: h, __r: r });

// ==== 1. 分け方（計算だけ） ====
{
  // 補正（係数 0.9・4 月の補正 +30% は上限の 25% で止まる）× Vertex（+10%）を、記録どおりに組み立てた最後の値で
  const q = 1000000, ks = [1.05, 0.97, 1.01], kAi = 1.02, spot = 300000;
  const kH = ks[0] * ks[1] * ks[2];
  const S = 1010000;
  const pre = S + spot + q * (kH - 1) + q * kH * (kAi - 1);
  const kc = 0.9 * 1.25, kv = 1.1, F = pre * kc * kv;
  const rec = { influence: { '2026/04': { opsBase: q, kProd: ks[0], kClient: ks[1], kOpinion: ks[2], kAi: 1, spot } }, kAi: { '2026/04': kAi },
    source: { '2026/04': 'forecast_open' }, vertex: { '2026/04': 0.1 }, cal: { factor: 0.9, monthBias: { 4: 0.3 } } };
  const [m] = effects({ monthly: [{ month: '2026/04', p50: F }], objectiveMonthly: [{ month: '2026/04', p50: S }] }, rec);
  assert.deepEqual([m.ym, m.final_p50, m.stat_p50, m.method, m.source], ['2026/04', F, S, 'RATIO', 'forecast_open']);
  assert.ok(near(sumOf(m), F, 1e-12), '足すと最後の値: ' + sumOf(m) + ' / ' + F);
  assert.ok(Math.abs(m.other_yen) < 5, '記録どおりに組み立てた値なら、合わない分は丸めの分だけ: ' + m.other_yen);
  assert.equal(m.spot_yen, spot);
  const bt = m.human_by_type_json;
  assert.deepEqual(Object.keys(bt), ['factor_product', 'factor_client', 'opinion'], '種類ごと（人の名前は無い）');
  assert.equal(bt.factor_product + bt.factor_client + bt.opinion, m.human_yen, '種類ごとの内訳を足すと人の層');
  assert.ok(Math.abs(m.human_yen - q * (kH - 1)) <= 2, '人 = 土台 ×（倍率の積 − 1）');
  assert.ok(bt.factor_product > 0 && bt.factor_client < 0 && bt.opinion > 0, '押した向きのとおり');
  assert.ok(Math.abs(m.calib_yen + (m.ai_yen - Math.round(q * kH * (kAi - 1))) - (F - pre)) <= 3, '補正 + Vertex = 最後の値 − 掛ける前');
  assert.ok(m.calib_yen > 0 && m.ai_yen > 0, '係数 0.9 × 1.25 は上げ・Vertex も上げ');
  // 月ごとの補正が上限で止まらなければ（+30% のまま）合わない分が残る = 上限で止めているのを確かめる
  assert.ok(Math.abs(effects({ monthly: [{ month: '2026/04', p50: pre * 0.9 * 1.3 * kv }], objectiveMonthly: [{ month: '2026/04', p50: S }] }, rec)[0].other_yen) > 1000);
  assert.ok(sources['LegacyEngine.js'].includes('const AUTOLEARN_FORECAST_BIAS_CAP = ' + env.run('APP_LAYER_MONTH_BIAS_CAP') + ';'), '月ごとの補正の上限は旧来と同じ');

  // 締まった月（実績に置き換え: 最後の値 = 過去の売上だけ）: 層はすべて 0。予測のまま（FORECAST_CLOSED_MONTH_MODE = forecast）の締まった月は補正を掛けない
  const closed = effects({ monthly: [{ month: '2026/05', p50: 777 }, { month: '2026/06', p50: 1200 }], objectiveMonthly: [{ month: '2026/05', p50: 777 }, { month: '2026/06', p50: 1000 }] },
    { influence: { '2026/05': rec.influence['2026/04'], '2026/06': { opsBase: 1000, kProd: 1.1, kClient: 1, kOpinion: 1, spot: 0 } }, source: { '2026/05': 'actual_closed', '2026/06': 'actual_closed' },
      vertex: { '2026/06': 0.2 }, cal: { factor: 2, monthBias: {} } });
  assert.deepEqual(LAYER_KEYS.slice(1).map((k) => closed[0][k]), [0, 0, 0, 0, 0]);
  assert.deepEqual([closed[0].source, closed[0].stat_p50, closed[0].final_p50], ['actual_closed', 777, 777]);
  assert.deepEqual([closed[1].human_yen, closed[1].calib_yen, closed[1].ai_yen, closed[1].other_yen], [100, 0, 0, 100], '締まった月には補正・Vertex を掛けない');

  // 記録が無い月（旧来の表の形が違う・古い回）: 合わない分にすべて入れる。最後の値か過去の売上だけが無い月は返さない
  const bare = effects({ monthly: [{ month: '2026/07', p50: 1500 }, { month: '2026/08', p50: null }], objectiveMonthly: [{ month: '2026/07', p50: 1000 }, { month: '2026/08', p50: 900 }] }, null);
  assert.equal(bare.length, 1);
  assert.deepEqual([bare[0].spot_yen, bare[0].human_yen, bare[0].ai_yen, bare[0].calib_yen, bare[0].other_yen, bare[0].source], [0, 0, 0, 0, 500, 'forecast_open']);
  // 倍率が 0 以下（対数で分けられない）: (k − 1) の割合で分け、内訳を足すと人の層
  const zero = effects({ monthly: [{ month: '2026/09', p50: 100 }], objectiveMonthly: [{ month: '2026/09', p50: 1000 }] },
    { influence: { '2026/09': { opsBase: 1000, kProd: 0, kClient: 1.1, kOpinion: 1, spot: 0 } } })[0];
  assert.equal(zero.human_by_type_json.factor_product + zero.human_by_type_json.factor_client + zero.human_by_type_json.opinion, zero.human_yen);
  assert.equal(zero.human_yen, -1000, '1000 ×（0 × 1.1 − 1）');
  // どんな値でも、足すと最後の値（200 通り）
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 200; i++) {
    const ym = '2026/' + String(1 + (i % 12)).padStart(2, '0');
    const r = effects({ monthly: [{ month: ym, p50: rnd() * 5e7 }], objectiveMonthly: [{ month: ym, p50: rnd() * 5e7 }] },
      { influence: { [ym]: { opsBase: rnd() * 4e7, kProd: 0.7 + rnd() * 0.6, kClient: 0.7 + rnd() * 0.6, kOpinion: 0.8 + rnd() * 0.4, spot: rnd() < 0.3 ? rnd() * 1e7 : 0 } },
        kAi: { [ym]: 0.95 + rnd() * 0.1 }, vertex: { [ym]: rnd() * 0.6 - 0.3 }, cal: { factor: 0.8 + rnd() * 0.4, monthBias: { [String(1 + (i % 12))]: rnd() - 0.5 } },
        source: { [ym]: rnd() < 0.2 ? 'actual_closed' : 'forecast_open' } })[0];
    assert.ok(near(sumOf(r), r.final_p50, 1e-12), i + ': 足すと最後の値');
    assert.ok(['spot_yen', 'human_yen', 'ai_yen', 'calib_yen'].every((k) => Number.isInteger(r[k])), '層は 1 円に丸める');
  }
}

// ---- 準備: 本物の A-1・A-2・A-3 で計画を作り、入力を置く（app-forecast-seed.test.mjs と同じ作り。年度は前の年度） ----
const FY = env.run('appFy_(new Date())') - 1;
let planId;
const viewHash = () => env.call('apiPlanView(__in)', { __in: { planId } }).inputHash;
const save = (kind, rows) => { const st = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind, rows }, inputHash: viewHash() }); assert.equal(st.status, 'DONE', kind + ': ' + st.error); };
{
  const ext = Array.from({ length: 70 }, () => '');
  const rec = (product, month, amount) => { const r = ext.slice(); r[40] = CLIENT; r[45] = 'ベース'; r[49] = product; r[56] = month; r[65] = amount; return r; };
  const sheets = {};
  for (let y = FY - 5; y <= FY + 1; y++) {
    const rows = [ext.map((_, i) => 'c' + (i + 1))];
    for (let m = 1; m <= 12; m++) {
      const dt = D(y, m, 15);
      if (dt < D(FY - 5, 4, 1) || dt > D(FY + 1, 3, 31)) continue;
      rows.push(rec('製品A', dt, Math.round(1000000 + 50000 * Math.sin(m) + 12000 * (y - FY + 5) + m * 2000)));
      rows.push(rec('製品B', dt, Math.round(400000 + 20000 * Math.cos(m))));
    }
    sheets['*' + y + '_actual_value'] = { cols: 70, values: rows };
  }
  const zac = env.makeBook('売上の元', sheets);
  env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
  let st = env.runJob('PLAN.CREATE', { clientName: CLIENT, fy: FY, peopleCsv: '鷹野,佐藤' });
  assert.equal(st.status, 'DONE', st.error);
  planId = st.result.planId;
  for (const action of ['IMPORT.SALES', 'SALES.AGGREGATE']) {
    st = env.runJob('PLAN.RUN', { planId, action });
    assert.equal(st.status, 'DONE', action + ': ' + st.error);
  }
  save('opinions', [{ person: '鷹野', ym: FY + '-11', step: '-5', conf: '0.6', note: '' }, { person: '佐藤', ym: FY + '-04', step: '2', conf: '0.5', note: '' }]);
  save('product', [{ person: '鷹野', product: '製品A', ym: FY + '-10', step: '5', reason: '新規' }]);
  save('client', [{ person: '佐藤', ym: FY + '-12', step: '-3', reason: '全体' }]);
  save('devspot', [{ person: '鷹野', ym: (FY + 1) + '-01', project: '案件X', amount: '3000000', conf: '0.8' }]);
}
/** 予測を動かす。asOfMs を「今」にして待ち行列に直接入れる（画面からは渡せない項目） */
function forecast(asOfMs) {
  let id = env.run(`appWithLock_(() => appEnqueueJob_('FORECAST.RUN', { planId: __p, confirms: ['extreme'], asOfMs: __t }, __by, '').id)`, { __p: planId, __t: asOfMs, __by: OWNER });
  for (let i = 0; i < 60; i++) {
    env.fireTriggers('triggerRunJob');
    const st = env.call('apiJobStatus(__in)', { __in: { jobId: id } });
    if (st.status === 'CONTINUED') { id = st.nextJobId; continue; }
    if (st.status === 'QUEUED' || st.status === 'RUNNING') { id = st.jobId; continue; }
    return st;
  }
  throw new Error('続きの処理が終わらない');
}
const runsOf = () => env.table('FORECAST_RUNS').filter((r) => r.plan_id === planId);
const layersOf = (runId) => env.call('appReadPlanTable_("LAYER_EFFECTS", __p)', { __p: planId }).filter((r) => r.run_id === runId);
const monthlyOf = (runId) => env.call('appReadTable_("FORECAST_MONTHLY")').filter((r) => r.run_id === runId);
const AS_OF = jst(FY, 10, 20, 10).getTime();   // 年度の途中（4〜9 月は締まった月）

// ==== 2. 本物の A-9: 予測 1 回で 12 行 ====
let run1;
{
  const st = forecast(AS_OF);
  assert.equal(st.status, 'DONE', st.error);
  run1 = runsOf().slice(-1)[0];
  const rows = layersOf(run1.run_id);
  const mon = monthlyOf(run1.run_id);
  assert.equal(rows.length, 12, '12 か月');
  assert.deepEqual(rows.map((r) => r.ym), mon.map((m) => m.ym), '月は予測の月ごとの記録と同じ');
  rows.forEach((r, i) => {
    assert.equal(r.final_p50, mon[i].p50, r.ym + ': 最後の真ん中は FORECAST_MONTHLY の値');
    assert.equal(r.stat_p50, mon[i].obj_p50, r.ym + ': 統計の土台は過去の売上だけの真ん中');
    assert.ok(near(sumOf(r), r.final_p50), r.ym + ': 6 つの層を足すと最後の値（' + sumOf(r) + ' / ' + r.final_p50 + '）');
    assert.equal(r.effect_id, env.call('appStableLogId_("LEF", [__r, __m])', { __r: run1.run_id, __m: r.ym }), '番号は予測の回と月から');
    assert.deepEqual([r.method, r.plan_id, !!r.recorded_at], ['RATIO', planId, true]);
    assert.ok(!/鷹野|佐藤/.test(r.human_by_type_json), '人の内訳に名前は入れない');
  });
  // 締まった月の印: 旧来の A-9 は締まった月を AI_IMPACT_HISTORY の forecast_source（actual_closed）に書く。今の売上の窓（年度の前の 48 か月）では
  // 予測の月が締まった月にならないので、ここでは全部が予測の月（締まった月の行は 2c で確かめる）
  const closed = rows.filter((r) => r.source === 'actual_closed'), open = rows.filter((r) => r.source === 'forecast_open');
  assert.equal(closed.length + open.length, 12, 'どの月にも印');
  const impact = env.table('ENG_AI_IMPACT_HISTORY').filter((r) => r.plan_id === planId).slice(-12);
  assert.deepEqual(rows.map((r) => r.source), impact.map((r) => r.forecast_source), '印は旧来の記録のとおり');
  closed.forEach((r) => assert.deepEqual(LAYER_KEYS.slice(1).map((k) => r[k]), [0, 0, 0, 0, 0], r.ym + ': 層は 0'));
  // スポット（1 月に 300 万円・確度 0.8 → 真ん中は 300 万円）・人（10 月から製品 +5%）
  const jan = rows.find((r) => r.ym === (FY + 1) + '/01');
  assert.equal(jan.source, 'forecast_open');
  assert.equal(jan.spot_yen, 3000000, '確定しているスポット案件の真ん中');
  const oct = rows.find((r) => r.ym === FY + '/10');
  assert.ok(JSON.parse(oct.human_by_type_json).factor_product > 0, '10 月: 製品の入力で押し上げ');
  open.forEach((r) => assert.ok(Math.abs(r.other_yen) < 0.05 * Math.abs(r.final_p50), r.ym + ': 合わない分は小さい（' + r.other_yen + '）'));
  // 予測の版の列（新しい回）
  assert.deepEqual([run1.app_version, run1.seed_rule, run1.fixes_json], [env.run('APP_VERSION'), 'INPUT_V1', '[]']);
  assert.equal(env.call('appLogTruncatedCells_("LAYER_EFFECTS")'), 0);
  assert.ok(!env.errors().some((e) => /^LOG\./.test(e.where)), 'エラーのログに記録の失敗が無い: ' + JSON.stringify(env.errors()));
}

// ==== 2b. 同じ入力・同じ「今」なら同じ値（番号だけが違う）。前からある行の 3 列は空のまま読める ====
let run2;
{
  assert.equal(forecast(AS_OF + 3600e3).status, 'DONE');
  run2 = runsOf().slice(-1)[0];
  assert.equal(run2.seed, run1.seed, '前提: 同じ種');
  const pick = (r) => [r.ym, r.final_p50, r.stat_p50, r.spot_yen, r.human_yen, r.human_by_type_json, r.ai_yen, r.calib_yen, r.other_yen, r.source];
  assert.deepEqual(layersOf(run2.run_id).map(pick), layersOf(run1.run_id).map(pick), '同じ入力なら層ごとの効きも同じ');
  assert.notDeepEqual(layersOf(run2.run_id).map((r) => r.effect_id), layersOf(run1.run_id).map((r) => r.effect_id));
  // v0.28.0 までの回（3 列が無い行）: 空のまま読める（書き換えない）
  env.run(`appWithLock_(() => appEnsureRows_('FORECAST_RUNS', [{ run_id: 'RUN-OLD', plan_id: __p, status: 'DONE', seed: 'run-seed', finished_at: '2026-01-01T00:00:00+0900' }]))`, { __p: planId });
  const old = env.call('appReadTable_("FORECAST_RUNS")').find((r) => r.run_id === 'RUN-OLD');
  assert.deepEqual([old.app_version, old.seed_rule, old.fixes_json], ['', '', '']);
  assert.ok(runsOf().filter((r) => r.run_id !== 'RUN-OLD').every((r) => r.seed_rule === 'INPUT_V1'));
}

// ==== 2c. 締まった月・補正・Vertex を記録から読む（旧来の予測の代わりが、記録を決まった形で書く） ====
{
  const env2 = setUpEnv();
  const fy = 2026;
  const SNAP_HEADER = ['snapshot_id', 'run_date', 'client', 'target_month', 'scenario', 'base_pred', 'subjective_adj', 'ai_adj', 'deterministic_adj', 'final_pred',
    'confidence_interval_lower', 'confidence_interval_upper', 'key_factors_json', 'subjective_input_date', 'calibration_applied_json'];
  const AI_HEADER = ['run_id', 'run_at', 'client', 'target_month', 'k_ai', 'ai_total_score', 'ai_direction', 'pred_p50', 'pred_p50_quant_only', 'ai_neutralized', 'disabled_topics_count', 'forecast_source'];
  const SUBJ_HEADER = ['run_id', 'run_at', 'client', 'target_month', 'source_type', 'source_key', 'push_step', 'push_direction', 'applied_reliability_r', 'source_updated_at', 'forecast_source'];
  // 月ごとの記録: 前の 4 か月は締まった月（実績に置き換え）。予測の月は 係数 0.95 ×（1 + 月ごとの補正。10 月だけ +10%）× Vertex（+5%）を掛けた値
  const spec = Array.from({ length: 12 }, (_, i) => {
    const m = 4 + i, ym = (m > 12 ? fy + 1 : fy) + '/' + String(m > 12 ? m - 12 : m).padStart(2, '0');
    const closed = i < 4, obj = 1000000 + i * 10000, q = 900000 + i * 10000, k = [1.05, 0.98, 1.01], kAi = 1.02, spot = i === 9 ? 500000 : 0;
    const vx = closed ? 0 : 0.05, mb = ym.endsWith('/10') ? 0.1 : 0;
    const kH = k[0] * k[1] * k[2], pre = obj + spot + q * (kH - 1) + q * kH * (kAi - 1);
    return { ym, closed, obj, q, k, kAi, spot, vx, pre, final: closed ? obj : pre * 0.95 * (1 + mb) * (1 + vx) };
  });
  const output = [['FY2026 売上予測（' + CLIENT + '）']];
  const book = env2.makeBook('クライアント別売上予測', {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', CLIENT], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    OUTPUT: { values: output },
    FORECAST_SNAPSHOT: { values: [SNAP_HEADER], formats: { D: '@' } },
    AI_IMPACT_HISTORY: { values: [AI_HEADER] },
    SUBJECTIVE_IMPACT_HISTORY: { values: [SUBJ_HEADER] },
    PROCESS_STATUS: { values: [['step_key', 'last_run_date', 'last_run_by', 'status', 'target_client', 'record_count', 'error_summary'], ['step4_status', D(2026, 9, 1), 'owner', 'success', CLIENT, 12, '']] },
  });
  env2.run(`appLegacyEngine_ = function (svc) {
    const SPEC = ${JSON.stringify(spec)};
    return { WEB_UI_CONFIRMS_: {}, VERSION: 'stub-1', SOURCE_SHA256: 'stub',
      runPhase1Forecast() {
        const ss = svc.SpreadsheetApp.getActiveSpreadsheet();
        const md = (s) => new svc.Date(Number(s.slice(0, 4)), Number(s.slice(5)) - 1, 1);
        const out = ss.getSheetByName('OUTPUT');
        out.getRange(26, 1, 1, 4).setValues([['年度合計（予測）', 1, SPEC.reduce((a, s) => a + s.final, 0), 3]]);
        SPEC.forEach((s, i) => out.getRange(29 + i, 1, 1, 4).setValues([[md(s.ym), s.final * 0.9, s.final, s.final * 1.1]]));
        out.getRange(65, 1, 1, 4).setValues([['年度合計（客観）', 1, SPEC.reduce((a, s) => a + s.obj, 0), 3]]);
        SPEC.forEach((s, i) => out.getRange(68 + i, 1, 1, 4).setValues([[md(s.ym), s.obj * 0.9, s.obj, s.obj * 1.1]]));
        out.getRange(100, 1, 1, 12).setValues([['Month', 'Ops基礎', 'kProd', 'kClient', 'kOpinion(P50)', 'kAI', 'Known Spot Expected', 'Known Spot P50', '背景SPOT(P50)', '混合P50(cal)', '混合P50(raw)', '定量P50']]);
        SPEC.forEach((s, i) => out.getRange(101 + i, 1, 1, 12).setValues([[s.ym, s.q, s.k[0], s.k[1], s.k[2], s.kAi, s.spot * 0.8, s.spot, 0, s.final, s.final, s.obj]]));
        const runId = svc.Utilities.getUuid(), sid = svc.Utilities.getUuid(), now = new svc.Date();
        const add = (name, rows) => { const sh = ss.getSheetByName(name); if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows); };
        const src = (s) => (s.closed ? 'actual_closed' : 'forecast_open');
        add('FORECAST_SNAPSHOT', SPEC.map((s) => [sid, now, '${CLIENT}', s.ym, 'neutral', s.final, 0, 0, s.spot, s.final, s.final * 0.9, s.final * 1.1,
          JSON.stringify({ opinion: '', forecast_source: src(s) }), '', JSON.stringify({ version: 'stub', bias_correction_factor: 0.95, residual_month_bias_json: '{"10":0.1}' })]));
        add('AI_IMPACT_HISTORY', SPEC.map((s) => [runId, now, '${CLIENT}', s.ym, s.kAi, 3, 'up', s.final, s.obj, 0, 0, src(s)]));
        add('SUBJECTIVE_IMPACT_HISTORY', SPEC.filter((s) => s.vx).map((s) => [runId, now, '${CLIENT}', s.ym, 'vertex_forecast', 'assist', s.vx, 1, 1, '', src(s)])
          .concat(SPEC.map((s) => [runId, now, '${CLIENT}', s.ym, 'opinion', '鷹野', 0.01, 1, 1, '', src(s)])));
      } };
  };`);
  const pid = env2.seedPlan(book);
  for (let n = 1; n <= 2; n++) {
    const st = env2.runJob('FORECAST.RUN', { planId: pid, confirms: [] });
    assert.equal(st.status, 'DONE', st.error);
  }
  const runs = env2.table('FORECAST_RUNS').filter((r) => r.plan_id === pid);
  const rowsOf = (runId) => env2.call('appReadPlanTable_("LAYER_EFFECTS", __p)', { __p: pid }).filter((r) => r.run_id === runId);
  const rows = rowsOf(runs[1].run_id);
  assert.equal(rows.length, 12);
  rows.forEach((r, i) => {
    const s = spec[i];
    assert.equal(r.ym, s.ym);
    assert.ok(near(sumOf(r), r.final_p50), r.ym + ': 足すと最後の値');
    assert.equal(r.source, s.closed ? 'actual_closed' : 'forecast_open', r.ym + ': 締まった月の印');
    if (s.closed) { assert.deepEqual(LAYER_KEYS.slice(1).map((k) => r[k]), [0, 0, 0, 0, 0], r.ym + ': 締まった月の層は 0'); return; }
    assert.ok(Math.abs(r.other_yen) < 5, r.ym + ': 記録どおりなら合わない分は丸めだけ（' + r.other_yen + '）');
    assert.equal(r.spot_yen, s.spot, r.ym + ': スポットは真ん中');
    assert.ok(s.ym.endsWith('/10') ? r.calib_yen > 0 : r.calib_yen < 0, r.ym + ': 係数 0.95 は下げ・10 月は 0.95 × 1.1 で上げ（' + r.calib_yen + '）');
    const vxYen = r.ai_yen - Math.round(s.q * s.k[0] * s.k[1] * s.k[2] * (s.kAi - 1));
    assert.ok(Math.abs(r.calib_yen + vxYen - (s.final - s.pre)) <= 3, r.ym + ': 補正 + Vertex = 最後の値 − 掛ける前');
    assert.ok(vxYen > 0, r.ym + ': Vertex（+5%）は AI の層に入る');
  });
  assert.ok(!/鷹野/.test(JSON.stringify(rows)), '人の名前は入らない');
  // 前の回の記録の行（Vertex・見解）を数えない: 2 回目も 1 回目と同じ値
  const pick = (r) => [r.ym, r.spot_yen, r.human_yen, r.ai_yen, r.calib_yen, r.other_yen, r.source];
  assert.deepEqual(rows.map(pick), rowsOf(runs[0].run_id).map(pick), 'この回に足された行だけを読む');
  // 計算の前の行の数を渡さない（公開の前に始めた予測）: 最後の回の行で読む（同じ値）
  const rec = env2.call('appLayerRecords_(__b)', { __b: env2.scratch() });
  assert.equal(rec.vertex[spec[11].ym], 0.05);
  assert.equal(rec.cal.factor, 0.95);
}

// ==== 3. 控えの書き直しで二重にならない ====
let run3;
{
  const sh = env.data().getSheetByName('LAYER_EFFECTS');
  const before = env.table('LAYER_EFFECTS').length;
  sh.failWrites = true;
  const st = forecast(AS_OF + 7200e3);
  sh.failWrites = false;
  assert.equal(st.status, 'FAILED', '前提: 層ごとの効きを書く途中で止まった');
  assert.ok(env.call('appJournalPending_()'), '控えが残る');
  const rec = env.call(`appWithLock_(() => appJournalRecover_(${CTX}))`);
  assert.equal(rec.written.LAYER_EFFECTS.appended, 12);
  run3 = runsOf().slice(-1)[0];
  assert.equal(layersOf(run3.run_id).length, 12, '書き直しで 12 行');
  assert.equal(env.table('LAYER_EFFECTS').length, before + 12);
  const again = env.call(`appWithLock_(() => appJournalApply_(appLogOps_('LAYER_EFFECTS', __r)))`, { __r: layersOf(run3.run_id).map((r) => { delete r._row; return r; }) });
  assert.equal(again.LAYER_EFFECTS.appended, 0, 'もう一度足しても増えない');
  assert.equal(new Set(env.table('LAYER_EFFECTS').map((r) => r.effect_id)).size, env.table('LAYER_EFFECTS').length);
}

// ==== 4. 根拠: 最新と前の回の層ごとの月の合計 ====
{
  // 入力を変えて（製品 +5% → +15%）予測し直す: 人の層だけが動く
  save('product', [{ person: '鷹野', product: '製品A', ym: FY + '-10', step: '15', reason: '新規' }]);
  assert.equal(forecast(AS_OF + 10800e3).status, 'DONE');
  const b = env.call('apiForecastBasis(__in)', { __in: { planId } });
  const L = b.layers;
  assert.ok(L && L.latest && L.prev, '最新と前の回の層ごとの効き');
  assert.equal(L.latest.months, 12);
  assert.equal(L.latest.method, 'RATIO');
  const latest = runsOf().slice(-1)[0];
  assert.equal(L.latest.closed, layersOf(latest.run_id).filter((r) => r.source === 'actual_closed').length, '締まった月の数');
  const sumRun = (runId, k) => layersOf(runId).reduce((a, r) => a + Number(r[k]), 0);
  assert.ok(near(L.latest.final, sumRun(latest.run_id, 'final_p50')) && near(L.latest.human, sumRun(latest.run_id, 'human_yen')));
  assert.ok(near(L.latest.stat + L.latest.spot + L.latest.human + L.latest.ai + L.latest.calib + L.latest.other, L.latest.final), '月の合計も足すと一致');
  assert.ok(L.latest.human > L.prev.human, '製品の入力を上げたので人の層が上がった');
  assert.ok(L.latest.byType.factor_product > L.prev.byType.factor_product);
  assert.ok(near(L.latest.stat, L.prev.stat) && L.latest.spot === L.prev.spot, '過去の売上とスポットは変わらない');
  assert.ok(!/鷹野|佐藤/.test(JSON.stringify(L)), '層ごとの効きに名前は無い');
  // 閲覧の人にも出す（人ごとの内訳を外す appBasisFor_ を通っても、そのまま）
  const viewer = env.call(`appBasisFor_({ user: { email: 'viewer@bigm2y.com' }, roles: [{ role: 'VIEWER', scope_type: 'ALL', client_id: '' }] }, __b)`, { __b: b });
  assert.deepEqual(viewer.layers, L);
  // 前の回に層ごとの効きが無い（v10 より前の回）: 前は null
  const only = env.call('appBasisLayers_(__p, __l, { run_id: "RUN-OLD" })', { __p: planId, __l: latest });
  assert.deepEqual([!!only.latest, only.prev], [true, null]);
  assert.equal(env.call('appBasisLayers_(__p, null, null)', { __p: planId }), null);
}

// ==== 4b. 画面: 「前回の予測からの変化」に、層ごとの月の合計の差（内訳・前回から） ====
{
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: (t, k) => "<i data-pose=\\"" + String(k) + "\\"></i>" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
  const ui = vm.createContext({ document: { getElementById: () => ({ innerHTML: '', classList: { add() {}, remove() {} } }), querySelector: () => null, addEventListener() {} }, setTimeout: () => 0, clearTimeout() {},
    confirm: () => false, window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  const view = { plan: { planId: 'P1', clientName: 'テスト製薬', fy: 2026 }, inputHash: 'h', can: { plan: true }, recent: [], actions: [], boot: { eval: { insights: [] }, quarterly: { proposals: [] }, learning: {} } };
  const lay = (o) => Object.assign({ final: 0, stat: 0, spot: 0, human: 0, ai: 0, calib: 0, other: 0, byType: {}, months: 12, closed: 6, method: 'RATIO' }, o);
  const draw = (layers) => { Object.assign(ui, { __v: view, __b: { planId: 'P1', annual: { p50: 1300, prevP50: 1000 }, monthly: [], research: [], applied: null, calibration: null,
    latestRunAt: '2026-10-08T10:00:00+09:00', prevRunAt: '2026-10-01T10:00:00+09:00', inputChanged: true, changeCause: 'inputs', between: [], layers } });
  return vm.runInContext('S.fc.planId = "P1"; S.fc.view = __v; S.fc.basis = __b; fcBasisTab(S.fc.data, __v)', ui); };
  const html = draw({ latest: lay({ final: 1300, stat: 1000, human: 250, ai: 30, other: 20, byType: { factor_product: 300, factor_client: -50, opinion: 0 } }),
    prev: lay({ final: 1000, stat: 1000, human: 0, ai: 10, other: -10 }) });
  const table = /<table class="tbl fc-layers">[\s\S]*?<\/table>/.exec(html);
  assert.ok(table, '層ごとの表がある');
  const rows = [...table[0].matchAll(/<tr><td data-tip="([^"]*)">([^<]*)<\/td><td class="num" data-tip="([^"]*)">([^<]*)<\/td><\/tr>/g)].map((m) => ({ tip: m[1], name: m[2], numTip: m[3], value: m[4] }));
  assert.deepEqual(rows.map((r) => [r.name, r.value]), [['過去の売上', '0'], ['人の入力', '+250'], ['AI', '+20'], ['そのほか', '+30']], '0 円の層（スポット・補正）は出さない');
  assert.ok(rows.every((r) => r.name.length <= 8), '名前は 8 字まで');
  assert.equal(rows[1].tip, '製品・メーカー全体・見解の効き\n今回: 製品 +300 円・全体 -50 円', '人の入力の種類ごとの内訳はカーソルで');
  assert.equal(rows[1].numTip, '今回 250 円・前回 0 円');
  assert.match(table[0], /<th data-tip="予測の中心を[^"]*">内訳<\/th><th class="num" data-tip="前回の予測からの変化（月の合計）">前回から（月の合計）<\/th>/);
  assert.match(table[0], /<colgroup><col><col style="width:160px"><\/colgroup>/, '数の列は 1 マス');
  // 前の回に層ごとの効きが無い・層ごとの効きが無いサーバー: 表を出さない（ほかは今までどおり）
  for (const l of [{ latest: lay({ final: 1 }), prev: null }, null, undefined]) {
    const h = draw(l);
    assert.ok(!/fc-layers/.test(h));
    assert.ok(h.includes('<h2>前回の予測からの変化</h2>'));
  }
}

// ==== 5. LMDI を使わない理由（同じ種なら数字は同じ。だが OUTPUT に表が足され、CONFIG の中身が変わる） ====
{
  const book = env.scratch();
  const enc = (name) => env.call('appEngEncodeSheet_(__p, appSheetSnapshot_(__b.getSheetByName(__n), 0)).sheetRow.content_hash', { __p: planId, __b: book, __n: name });
  const runLegacy = () => env.call(`(() => { const r = appRunLegacyForecast_(__b, { asOfMs: __t, seed: 'lmdi-eval', uuidSeed: 'lmdi-eval-id', confirms: ['extreme'], actor: '${OWNER}' });
    const out = __b.getSheetByName('OUTPUT').getDataRange().getValues(); return { ok: r.ok, headline: appForecastHeadline_(__b), rows: out.length,
    lmdi: out.some((x) => String(x[0]).indexOf('主観寄与の厳密加法分解') === 0) }; })()`, { __b: book, __t: AS_OF });
  const cfg = book.getSheetByName('CONFIG');
  const at = cfg.getDataRange().getValues().findIndex((r) => String(r[0]).indexOf('LMDI_DECOMPOSITION_ENABLED') === 0);
  assert.ok(at > 0, '前提: CONFIG に LMDI の設定がある');
  assert.equal(cfg.getRange(at + 1, 2).getValue(), 0, '今は 0（使っていない）');
  const off = runLegacy();
  const hashOff = enc('CONFIG');
  cfg.getRange(at + 1, 2).setValue(1);
  const on = runLegacy();
  assert.ok(off.ok && on.ok);
  assert.deepEqual(on.headline, off.headline, 'LMDI を 1 にしても、同じ種なら予測の数字は同じ（乱数を使わない）');
  assert.deepEqual([off.lmdi, on.lmdi], [false, true], 'だが 1 にすると OUTPUT の末尾に表が足される（保存する OUTPUT が変わる）');
  assert.ok(on.rows > off.rows);
  assert.notEqual(enc('CONFIG'), hashOff, 'CONFIG の中身（種が見る表）も変わる → 1 を保存すると種が変わる');
  assert.ok(env.run('APP_FORECAST_SEED_SHEETS').includes('CONFIG'));
  // 計算用ブックをじかに変えたので、次の処理は組み立て直す
  delete env.props.APP_SCRATCH_STATE;
  // 保存しているデータ本体の CONFIG は 0 のまま（層ごとの効きは RATIO）
  assert.ok(env.table('LAYER_EFFECTS').every((r) => r.method === 'RATIO'));
}

console.log('app-v10-layer-effects: ok');
