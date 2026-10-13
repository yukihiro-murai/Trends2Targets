#!/usr/bin/env node
/*
 * app-legacy-records.test.mjs — 旧来の計算の記録の直し（2026-10-07 村井さん承認）を、本物の旧来の計算をモックの上で動かして確かめる。
 * 計算用ブックは、Sheets と同じく 'yyyy/MM' の文字を日付に変える（モックが真似する）。直す前は、どれもこの変換で食い違っていた。
 *   1. C-1 の当たりの記録（RELIABILITY_EVIDENCE）: SUBJECTIVE_IMPACT_HISTORY の月が日付でも、実績の月と合わせて数える
 *   2. B-4 を動かし直しても EVAL_INSIGHTS の行が増えない（同じ月の行を上書きし、人の記入は残す）
 *   3. EVAL_INSIGHTS.cause_bucket の向き: over_forecast = 予測 > 実績（EVAL_LOG・EVAL_COMPARE_MONTHLY と同じ向き）
 *   4. 四半期レビューの案の確度（高・中・低）を文字のまま画面へ渡し、画面に出す
 *
 *   node app/tests/app-legacy-records.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setUpEnv, uiHtml, OWNER } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const env = setUpEnv();
const H = env.run('(() => { const o = {}; Object.keys(APP_ENGINE_SHEETS).forEach(k => { o[k] = APP_ENGINE_SHEETS[k].header || null; }); return o; })()');
const row = (sheet, o) => H[sheet].map((h) => (o[h] === undefined ? '' : o[h]));
const CLIENT = 'テスト製薬';
/** 検証の月: [月, 実績, P50]。4 月は予測が低すぎた・5 月は高すぎた・6 月は少し低すぎた */
const MONTHS = [['2026/04', 1200, 1000], ['2026/05', 800, 1000], ['2026/06', 1050, 1000]];
/** 検証の記録（P10・P90 は ±5%）。月は旧来の B-2 と同じく書式なしテキストの列に書いた形。今の検証の版（締まった月を月が始まる前の予測で測った行） */
const evalLog = [H.EVAL_LOG].concat(...MONTHS.map(([ym, act, p50], i) => [['nega', p50 * 0.95], ['neutral', p50], ['posi', p50 * 1.05]]
  .map(([sc, p]) => row('EVAL_LOG', { eval_id: 'E' + i + sc, evaluated_at: D(2026, 9, 1), client: CLIENT, target_month: ym, scenario: sc, pred: p, actual: act,
    signed_error: p - act, abs_error: Math.abs(p - act), bias_direction: p > act ? 'over' : 'under', evaluation_policy_version: 'policy-2026H1-v3',
    constraint_relevant_flag: sc === 'neutral' ? 1 : 0 }))));
/** 予測の記録の月は、旧来が書式を付けずに書くので、計算用ブックでは日付になっている（その形で置く） */
const run1 = D(2026, 3, 20);
const impact = (m, quant) => row('AI_IMPACT_HISTORY', { run_id: 'R1', run_at: run1, client: CLIENT, target_month: D(2026, m), k_ai: 1, ai_direction: 'flat',
  pred_p50: 1000, pred_p50_quant_only: quant, forecast_source: 'forecast_open' });
const push = (m, type, key, dir) => row('SUBJECTIVE_IMPACT_HISTORY', { run_id: 'R1', run_at: run1, client: CLIENT, target_month: D(2026, m), source_type: type,
  source_key: key, push_step: dir * 0.05, push_direction: dir, applied_reliability_r: 1, forecast_source: 'forecast_open' });
const book = env.makeBook('クライアント別売上予測', {
  CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', CLIENT], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野,佐藤']] },
  PROCESS_STATUS: { values: [H.PROCESS_STATUS, ['step4_status', D(2026, 9, 1), 'owner', 'success', CLIENT, 12, ''], ['step5_status', D(2026, 9, 1), 'owner', 'success', CLIENT, 9, '']] },
  RUN_LOG: { values: [H.RUN_LOG] },
  // 実績は 7/10 に取り込んだ（4〜6 月は月末から 5 日たっているので締まった月）
  ACTUAL_EVAL_MONTHLY: { values: [H.ACTUAL_EVAL_MONTHLY].concat(MONTHS.map(([ym, act]) => [CLIENT, 'BASE', '製品A', ym, act, 'closed', D(2026, 7, 10)])), formats: { D: '@' } },
  EVAL_LOG: { values: evalLog, formats: { D: '@' } },
  // 旧来の B-2 は月を書式なしで書くので日付になっている。幅の外の印は付けない（B-4 がこの表から幅の外の印を探すところは
  // app-legacy-b4-range.test.mjs で確かめる。2026-10-07 に月を ymKey_ でそろえて直した）
  EVAL_COMPARE_MONTHLY: { values: [H.EVAL_COMPARE_MONTHLY].concat(MONTHS.map(([ym, act, p50]) => row('EVAL_COMPARE_MONTHLY', {
    target_month: D(Number(ym.slice(0, 4)), Number(ym.slice(5))), forecast_total: p50, actual_total: act, forecast_total_p50: p50, signed_error_p50: p50 - act,
    abs_error_p50: Math.abs(p50 - act), half_label: 'FY2026-H1', over_flag: p50 > act ? 1 : 0, under_flag: p50 < act ? 1 : 0, range_outside_flag: 0 }))) },
  EVAL_INSIGHTS: { values: [H.EVAL_INSIGHTS] },
  // 統計だけの予測はどの月も 1000。実績の向きは 4 月 上・5 月 下・6 月 上
  AI_IMPACT_HISTORY: { values: [H.AI_IMPACT_HISTORY, impact(4, 1000), impact(5, 1000), impact(6, 1000)] },
  // 鷹野（見解）: 3 か月とも実績の向きに押した。佐藤（製品）: 3 か月とも上に押した（当たり 2・外れ 1）
  SUBJECTIVE_IMPACT_HISTORY: { values: [H.SUBJECTIVE_IMPACT_HISTORY,
    push(4, 'opinion', '鷹野', 1), push(5, 'opinion', '鷹野', -1), push(6, 'opinion', '鷹野', 1),
    push(4, 'factor_product', '佐藤', 1), push(5, 'factor_product', '佐藤', 1), push(6, 'factor_product', '佐藤', 1)] },
  AI_SCORE_HISTORY: { values: [H.AI_SCORE_HISTORY] },
  CALIBRATION_STATE: { values: [H.CALIBRATION_STATE, [CLIENT, D(2026, 9, 1), 'owner', '', '', '[]', 1, '', '{}', '', '', 1, '']] },
  SOURCE_RELIABILITY: { values: [H.SOURCE_RELIABILITY] },
  POOL_PRIOR: { values: [H.POOL_PRIOR] },
  QUARTERLY_REVIEW: { values: [['']] },
  QUARTERLY_REVIEW_LOG: { values: [H.QUARTERLY_REVIEW_LOG] },
  RELIABILITY_EVIDENCE: { values: [H.RELIABILITY_EVIDENCE] },
});
const planId = env.seedPlan(book);
const engRows = (sheet) => env.table('ENG_' + sheet).filter((r) => r.plan_id === planId);
const ym = (iso) => { const d = new Date(iso); return d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0'); };
const runAction = (action) => { const st = env.runJob('PLAN.RUN', { planId, action }); assert.equal(st.status, 'DONE', action + ': ' + st.error); };
/**
 * C-1（見直し案を作る）は、画面・所有者の操作からは始められない（学びの仕組みを直すまで止めている。2026-10-07 村井さん決定）。
 * 旧来の C-1 の記録の直しを確かめるため、ここでは待ち行列に直接入れて動かす（始める前の断りだけを飛ばす。中身は画面から始めたときと同じ）
 */
const runPausedAction = (action) => {
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.RUN', payload: { planId, action } } }), /学びの仕組みを直すまで止めています/);
  let id = env.run(`appWithLock_(() => appEnqueueJob_('PLAN.RUN', { planId: __p, action: __a }, __by, '').id)`, { __p: planId, __a: action, __by: OWNER });
  for (let i = 0; i < 60; i++) {
    env.fireTriggers('triggerRunJob');
    const st = env.call('apiJobStatus(__in)', { __in: { jobId: id } });
    if (st.status === 'CONTINUED') { id = st.nextJobId; continue; }
    if (st.status === 'QUEUED' || st.status === 'RUNNING') { id = st.jobId; continue; }
    assert.equal(st.status, 'DONE', action + ': ' + st.error);
    return st;
  }
  throw new Error('続きの処理が終わらない');
};

// ==== 2・3. B-4（学習インサイトの更新） ====
runAction('EVAL.INSIGHTS');
let ins = engRows('EVAL_INSIGHTS');
assert.deepEqual(ins.map((r) => r._types.charAt(2)), ['d', 'd', 'd'], '前提: 計算用ブックでは月が日付になる（Sheets と同じ）');
assert.deepEqual(ins.map((r) => [ym(r.target_month), r.cause_bucket]), [['2026/04', 'under_forecast'], ['2026/05', 'over_forecast'], ['2026/06', 'under_forecast']],
  'over_forecast は予測 > 実績（実績が上回った 4 月・6 月は under_forecast）');
const cmpOver = engRows('EVAL_COMPARE_MONTHLY').map((r) => String(r.over_flag));
assert.deepEqual(ins.map((r) => (r.cause_bucket === 'over_forecast' ? '1' : '0')), cmpOver, 'EVAL_COMPARE_MONTHLY の over_flag と同じ向き');
const firstAt = Date.parse(ins[0].evaluated_at);

// 人が 4 月の行に原因の仮説などを書く（画面の「人の記入」と同じ保存）
let view = env.call('apiPlanView(__in)', { __in: { planId } });
const apr = view.boot.eval.insights.find((r) => r.month === '2026/04');
const saved = env.runJob('PLAN.EDIT', { planId, action: 'INSIGHT.SAVE', inputHash: view.inputHash,
  args: { rows: [{ row: apr.row, hypothesis: '大型案件の前倒し', actionType: '入力を修正', reflection: '見解を見直す', owner: '鷹野', status: 'in_progress' }] } });
assert.equal(saved.status, 'DONE', saved.error);

// 動かし直す: 行は月の数のまま（直す前は 6 行になり、人の記入は古い行にだけ残った）
runAction('EVAL.INSIGHTS');
ins = engRows('EVAL_INSIGHTS');
assert.deepEqual(ins.map((r) => ym(r.target_month)), ['2026/04', '2026/05', '2026/06'], '同じ月の行は増えない');
assert.ok(ins.every((r) => Date.parse(r.evaluated_at) > firstAt), '自動で入る列は同じ行で書き直す');
assert.deepEqual([ins[0].cause_hypothesis, ins[0].action_type, ins[0].next_cycle_reflection, ins[0].owner, ins[0].status],
  ['大型案件の前倒し', '入力を修正', '見解を見直す', '鷹野', 'in_progress'], '人の記入は同じ行に残る');
assert.deepEqual(ins.map((r) => r.cause_bucket), ['under_forecast', 'over_forecast', 'under_forecast']);
view = env.call('apiPlanView(__in)', { __in: { planId } });
assert.deepEqual(view.boot.eval.insights.map((r) => [r.month, r.hypothesis]), [['2026/04', '大型案件の前倒し'], ['2026/05', ''], ['2026/06', '']], '画面にも 1 か月 1 行');

// ==== 1. C-1（四半期レビューの提案）: 当たりの記録が残る（直す前は空で、信頼度の案も出なかった） ====
runPausedAction('REVIEW.GENERATE');
const ev = engRows('RELIABILITY_EVIDENCE');
assert.deepEqual(ev.map((r) => [r.source_type, r.source_key, r.quarter_label, r.n, r.hit]),
  [['opinion', '鷹野', 'FY2026-Q1', '3', '3'], ['factor_product', '佐藤', 'FY2026-Q1', '3', '2']], '月が日付でも人ごとの当たりを数える');
// 当たりの基準（2026-10-13）: 実績の向きは 上・下・上 なので、いつも上と言えば 2/3 当たる。hit_rate は基準を引いた当たる割合、note に基準で当たるはずの数
// 鷹野（上・下・上）: 基準で 2/3 + 1/3 + 2/3 = 5/3 → 0.5 + (3 − 5/3) / 3。佐藤（いつも上）: 基準で 2 → 0.5（いつも同じ向きと同じ）
assert.ok(Math.abs(Number(ev[0].hit_rate) - (0.5 + (3 - 5 / 3) / 3)) < 1e-9, '鷹野の基準を引いた当たる割合: ' + ev[0].hit_rate);
assert.equal(ev[0].note, 'expected=' + (5 / 3).toFixed(4));
assert.deepEqual([Number(ev[1].hit_rate), ev[1].note], [0.5, 'expected=2.0000'], '佐藤はいつも上と言っただけ（当たる割合 2/3 = 基準）');
const log = engRows('QUARTERLY_REVIEW_LOG');
assert.deepEqual(log.map((r) => [r.target_field, r.confidence]), [['reliability:opinion:鷹野', '中']],
  '信頼度の見直し案は鷹野だけ（佐藤はいつも上と言っただけなので r = 2 × 0.5 = 1.0 のまま。基準を引く前は 2/3 当たりで案が出ていた）');
assert.equal(log[0].rationale, '的中率=100% / 基準=56% / n=3', '根拠に基準を添える');

// ==== 4. 案の確度は 高・中・低 の文字のまま画面へ（直す前は数にして null になり、画面は「-」だった） ====
view = env.call('apiPlanView(__in)', { __in: { planId } });
assert.deepEqual(view.boot.quarterly.proposals.map((p) => p.conf), ['中'], '確度は文字のまま');
const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
  .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
  .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [] }, setUp: true, allowed: true }));
const el = () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, confirm: () => false,
  window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
  google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
vm.runInContext(js, ui);
ui.__q = view.boot.quarterly;
const props = vm.runInContext('fcRvProposals(__q)', ui);
assert.equal((props.match(/<td class="num">中<\/td>/g) || []).length, 1, '確度の列に 中 を出す');
// 根拠（基準つき・前の書き方）をふつうの言葉に（予算策定担当以上の人に出す。閲覧の人には出さない）
assert.equal(vm.runInContext(`qrWhy(${JSON.stringify(log[0].rationale)}, 'reliability:opinion:鷹野', false)`, ui), '当たった割合 100%（いつも同じ向きなら 56%・3 件）');
assert.equal(vm.runInContext(`qrWhy('的中率=67% / n=3', 'reliability:opinion:鷹野', false)`, ui), '当たった割合 67%（3 件）', '前の書き方の根拠もそのまま読む');
assert.equal(vm.runInContext(`qrWhy(${JSON.stringify(log[0].rationale)}, 'reliability:opinion:鷹野', true)`, ui), '');
assert.equal(vm.runInContext(`fcRvProposals({ proposals: [{ row: 8, target: 'ai_weight_override', current: '1', proposed: '0.5', conf: null, rationale: '', impact: '' }] })`, ui)
  .match(/<td class="num">-<\/td>/g).length, 1, '確度が無ければ -');

console.log('app-legacy-records: all tests passed');
