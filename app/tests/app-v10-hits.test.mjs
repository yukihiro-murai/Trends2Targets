#!/usr/bin/env node
/*
 * app-v10-hits.test.mjs — 版 10 の当たりの記録（HIT_RECORDS・3-4）・学びの記録（LEARNING_LOG・3-5）・人のつなぎ（PERSON_LINKS・3-6）。
 *   1. B-2 の保存で、締まった四半期の当たりを足す（本物の旧来の B-2 をモックの上で動かす）: 1 人を四半期に 1 回（種類と月をまとめる）・
 *      その月が始まる前の最後の予測の回で採点（後から作った回は使わない）・3 か月の合計で比べる・AI 調査は使った A-4 ごと・四半期の印。
 *      何度動かしても増えない。人と AI でない押し（AI の話題）は人に数えない
 *   2. 締まっていない月が 1 つでも入る四半期は数えない（月末から 5 日たつ前の取り込み）
 *   3. 見せる範囲: 予算策定担当以上は全部と名前・メーカー単位の担当はそのメーカー・本人（つなぎ）は自分の行・閲覧の人は件数だけ（名前を送らない）。
 *      古さの重み（四半期ごとに 0.8 倍）は読むときに掛ける。順位は作らない（名前の順）
 *   4. 移行の写し: 今ある記録から 1 回作る（BACKFILL の印）・後の B-2 と重ならない・続きに分けても同じ・締めた年度の計画は飛ばす
 *   5. 年度を締める条件: 締まった月のある予算の計画に、最後の四半期（1〜3 月）の印が要る（測る専用・実績の無い計画は外す）
 *   6. 学びの記録: 補正の書き込み（APPLY）・同じ頼みでは足さない・取り下げ（DECIDE）・C-1 の案（PROPOSE）・判断の保存（DECIDE）・
 *      C-3（旗 0 は判断だけ・旗 1 は反映）。同じ案は proposal_id でつながる。τ・w の承認（全計画の行）
 *   7. 人のつなぎ: 所有者だけ・登録していないメールはつながない・同じ名前を同じ範囲で 2 人にしない・メーカーで分かれる・期間の外は効かない・
 *      外しても行は残る・名前が同じメンバーを案に出す
 *   8. 画面（学び > 人の学び・AI の学び）: 名前の順・件数を添える・閲覧の人は件数だけ・中の記号を出さない
 * 数字はテスト用の作りもの。モックの上の確かめで、本物の Apps Script の上では動かしていない。
 *
 *   node app/tests/app-v10-hits.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setUpEnv, uiHtml, OWNER, MEMBER, OTHER } from './gas-mock.mjs';

/** 日本の時刻（月は 1 始まり） */
const jst = (y, m, d, H = 0, M = 0) => new Date(Date.UTC(y, m - 1, d, H - 9, M));
const CLIENT = 'テスト製薬';
const FY_MONTHS = ['2026/04', '2026/05', '2026/06', '2026/07', '2026/08', '2026/09', '2026/10', '2026/11', '2026/12', '2027/01', '2027/02', '2027/03'];
const ACT = { '2026/04': 1000, '2026/05': 1000, '2026/06': 1000, '2026/07': 1000, '2026/08': 1000, '2026/09': 1000, '2026/10': 300 };
// 予測の回: R0（3/20。4〜6 月の前の最後の回）・R1（6/19。7〜9 月の前の最後の回）・R2（10/02。後から作った回。採点に使わない）
const RUNS = { R0: jst(2026, 3, 20, 10), R1: jst(2026, 6, 19, 10), R2: jst(2026, 10, 2, 10) };
const QUANT = { R0: 1100, R1: 950, R2: 1200 };   // 統計だけの予測: 4〜6 月は実績が下（−1）、7〜9 月は上（+1）。R2 なら下になる（使えば外れる）
const KAI = { R0: [1.03, 'up'], R1: [1.02, 'up'], R2: [0.95, 'down'] };
const MONTHS_OF = { R0: FY_MONTHS.slice(0, 6), R1: FY_MONTHS.slice(3, 9), R2: FY_MONTHS.slice(3, 9) };
const Q1 = FY_MONTHS.slice(0, 3), Q2 = FY_MONTHS.slice(3, 6);

const env0 = setUpEnv();
const H = env0.run('(() => { const o = {}; Object.keys(APP_ENGINE_SHEETS).forEach(k => { o[k] = APP_ENGINE_SHEETS[k].header || null; }); return o; })()');
const row = (sheet, o) => H[sheet].map((h) => (o[h] === undefined ? '' : o[h]));
const CONFIG = (client, fy, people = '鷹野,佐藤') => ({ values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', people]] });
const POLICY = env0.run('APP_EVAL_POLICY_VERSION');

/**
 * 人の押し（SUBJECTIVE_IMPACT_HISTORY）: [回, 月, 種類, 名前, 押し]。
 * 鷹野: 4〜6 月は見解で下げ（4 月だけ製品で少し上げ。1 人 1 件にまとめる）→ 当たり、7〜9 月は上げ → 当たり、後の回 R2 は下げ（使わない）。
 * 佐藤: 5 月だけメーカー全体で上げ → 外れ、7 月だけ上げ → 当たり。AI の話題（市場）は人ではない
 */
const PUSHES = [].concat(
  Q1.map((ym) => ['R0', ym, 'opinion', '鷹野', -0.05]), [['R0', '2026/04', 'factor_product', '鷹野', 0.02]], [['R0', '2026/05', 'factor_client', '佐藤', 0.05]],
  Q2.map((ym) => ['R1', ym, 'opinion', '鷹野', 0.05]), [['R1', '2026/07', 'factor_client', '佐藤', 0.05]], Q2.map((ym) => ['R1', ym, 'ai_topic', 'Market', 0.3]),
  Q2.map((ym) => ['R2', ym, 'opinion', '鷹野', -0.05]));

/** 計画のブック。evaluated = 今の版の B-2 が測った後の形（移行の写しの確かめ）。importedAt = B-1 の日時 */
function planBook(env, { client = CLIENT, importedAt = jst(2026, 10, 6, 9), evaluated = false, b2At = null } = {}) {
  const snap = [H.FORECAST_SNAPSHOT];
  Object.keys(RUNS).forEach((id) => FY_MONTHS.forEach((ym) => ['nega', 'neutral', 'posi'].forEach((sc, i) => {
    const p50 = QUANT[id] + 50;
    snap.push([id, RUNS[id], client, ym, sc, p50, 0, 0, 0, p50 * [0.9, 1, 1.1][i], p50 * 0.9, p50 * 1.1, JSON.stringify({ opinion: '', forecast_source: 'forecast_open' }), '',
      JSON.stringify({ version: 'test', bias_correction_factor: 1, residual_month_bias_json: '' })]);
  })));
  const actual = [H.ACTUAL_EVAL_MONTHLY].concat(Object.keys(ACT).map((ym) => [client, 'BASE', '製品A', ym, ACT[ym], ym <= '2026/09' ? 'closed' : 'open', importedAt]));
  // B-2 の前: 前の版の行。B-2 の後（evaluated）: 今の版で、その月が始まる前の最後の回で測った行
  const evalLog = [H.EVAL_LOG];
  Object.keys(ACT).forEach((ym) => ['nega', 'neutral', 'posi'].forEach((sc, i) => {
    const pre = ym < '2026/07' ? 'R0' : 'R1';
    const p = (QUANT[evaluated ? pre : 'R2'] + 50) * [0.9, 1, 1.1][i];
    if (evaluated && ym > '2026/09') return;
    evalLog.push(row('EVAL_LOG', { eval_id: 'E-' + ym + sc, evaluated_at: evaluated ? jst(2026, 10, 7, 10) : jst(2026, 10, 2, 11), client, target_month: ym, scenario: sc, pred: p,
      actual: ACT[ym], evaluation_policy_version: evaluated ? POLICY : 'policy-2026H1-v2', constraint_relevant_flag: sc === 'neutral' ? 1 : 0 }));
  }));
  const impact = [H.AI_IMPACT_HISTORY];
  Object.keys(RUNS).forEach((id) => MONTHS_OF[id].forEach((ym) => impact.push(row('AI_IMPACT_HISTORY', { run_id: id, run_at: RUNS[id], client, target_month: ym,
    k_ai: KAI[id][0], ai_direction: KAI[id][1], pred_p50: QUANT[id] + 50, pred_p50_quant_only: QUANT[id], forecast_source: 'forecast_open' }))));
  const subj = [H.SUBJECTIVE_IMPACT_HISTORY].concat(PUSHES.map(([id, ym, type, key, step]) => row('SUBJECTIVE_IMPACT_HISTORY', { run_id: id, run_at: RUNS[id], client,
    target_month: ym, source_type: type, source_key: key, push_step: step, push_direction: Math.sign(step), applied_reliability_r: 1, forecast_source: 'forecast_open' })));
  const status = [H.PROCESS_STATUS, ['step2_status', importedAt, 'owner', 'success', client, 10, ''], ['step4_status', RUNS.R2, 'owner', 'success', client, 12, ''],
    ['step5_status', b2At || (evaluated ? jst(2026, 10, 7, 10) : jst(2026, 10, 2, 11)), 'owner', 'success', '', 30, '']];
  return env.makeBook('クライアント別売上予測', {
    CONFIG: CONFIG(client, 2026),
    PROCESS_STATUS: { values: status },
    RUN_LOG: { values: [H.RUN_LOG] },
    ACTUAL_EVAL_MONTHLY: { values: actual, formats: { D: '@' } },
    FORECAST_SNAPSHOT: { values: snap, formats: { D: '@' } },
    EVAL_LOG: { values: evalLog, formats: { D: '@' } },
    EVAL_COMPARE_MONTHLY: { values: [H.EVAL_COMPARE_MONTHLY], cols: 40 },
    EVAL_INSIGHTS: { values: [H.EVAL_INSIGHTS], formats: { C: '@' } },
    DASHBOARD: { values: [H.DASHBOARD] },
    AI_IMPACT_HISTORY: { values: impact },
    SUBJECTIVE_IMPACT_HISTORY: { values: subj },
    AI_SCORE_HISTORY: { values: [H.AI_SCORE_HISTORY] },
    CALIBRATION_STATE: { values: [H.CALIBRATION_STATE, [client, jst(2026, 10, 2), 'auto', '', '', '[]', 1, '', '', '', '', 1, '']] },
    CALIBRATION_HISTORY: { values: [H.CALIBRATION_HISTORY] },
    SOURCE_RELIABILITY: { values: [H.SOURCE_RELIABILITY] },
    POOL_PRIOR: { values: [H.POOL_PRIOR] },
    QUARTERLY_REVIEW: { values: [['']] },
    QUARTERLY_REVIEW_LOG: { values: [H.QUARTERLY_REVIEW_LOG] },
    RELIABILITY_EVIDENCE: { values: [H.RELIABILITY_EVIDENCE] },
  });
}

/** A-4（AI 調査）の記録: A4-1（3/15。R0 が使う）・A4-2（6/10。R1 が使う） */
function seedA4(env, planId) {
  const a = (id, at) => ({ action_id: id, plan_id: planId, action: 'AI.RESEARCH', status: 'DONE', engine_version: 't', engine_sha256: '', web_sha256: '', seed: id, as_of: at,
    input_hash: '', changed_sheets_json: '[]', result_json: '{}', started_at: at, finished_at: at, actor_email: OWNER });
  env.call('appWithLock_(() => appInsertRows_("PLAN_ACTIONS", __r))', { __r: [a('A4-1', '2026-03-15T10:00:00+0900'), a('A4-2', '2026-06-10T10:00:00+0900')] });
}
const hits = (env, planId) => env.table('HIT_RECORDS').filter((r) => !planId || r.plan_id === planId);
const brief = (rows) => rows.map((r) => [r.quarter, r.source_kind, r.source_key, Number(r.push || 0), Number(r.actual_dir), r.source_kind === 'QUARTER' ? null : Number(r.hit), Number(r.n_months)])
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const near = (a, b) => Math.abs(a - b) < 1e-6;
/** 2026 年度の 4〜9 月が締まった計画（10/06 の取り込み）の当たり。押しは 1 人の月ごとの押し（種類を足す）の平均 */
const WANT = [
  ['FY2026-Q1', 'AI_RESEARCH', 'A4-1', 0.03, -1, 0, 3],
  ['FY2026-Q1', 'PERSON', '佐藤', 0.05, -1, 0, 1],
  ['FY2026-Q1', 'PERSON', '鷹野', (-0.03 - 0.05 - 0.05) / 3, -1, 1, 3],
  ['FY2026-Q1', 'QUARTER', '', 0, -1, null, 3],
  ['FY2026-Q2', 'AI_RESEARCH', 'A4-2', 0.02, 1, 1, 3],
  ['FY2026-Q2', 'PERSON', '佐藤', 0.05, 1, 1, 1],
  ['FY2026-Q2', 'PERSON', '鷹野', 0.05, 1, 1, 3],
  ['FY2026-Q2', 'QUARTER', '', 0, 1, null, 3],
];
const sameRows = (got, want, msg) => {
  assert.equal(got.length, want.length, msg + ': ' + JSON.stringify(got));
  got.forEach((g, i) => {
    const w = want[i];
    assert.deepEqual([g[0], g[1], g[2], g[4], g[5], g[6]], [w[0], w[1], w[2], w[4], w[5], w[6]], msg);
    assert.ok(near(g[3], w[3]), msg + ' の押し: ' + g[3] + ' / ' + w[3]);
  });
};

// ==== 1. B-2 の保存で、締まった四半期の当たりを足す ====
const E1 = setUpEnv();
const P1 = E1.seedPlan(planBook(E1));
seedA4(E1, P1);
{
  assert.equal(hits(E1).length, 0, '前提: B-2 の前は無い（移行の写しは、締まった月の無い計画を飛ばす）');
  const st = E1.runJob('PLAN.RUN', { planId: P1, action: 'EVAL.REPORT' });
  assert.equal(st.status, 'DONE', st.error);
  const rows = hits(E1, P1);
  sameRows(brief(rows), brief(WANT.map((w) => ({ quarter: w[0], source_kind: w[1], source_key: w[2], push: w[3], actual_dir: w[4], hit: w[5], n_months: w[6] }))), 'B-2 の後の当たり');
  assert.ok(!rows.some((r) => r.quarter === 'FY2026-Q3'), '10 月は締まっていないので 10〜12 月は数えない');
  assert.ok(!rows.some((r) => r.source_key === 'Market'), 'AI の話題は人に数えない');
  const takano2 = rows.find((r) => r.quarter === 'FY2026-Q2' && r.source_key === '鷹野');
  assert.deepEqual(JSON.parse(takano2.months_json).map((m) => [m.ym, m.run]), Q2.map((ym) => [ym, 'R1']), '月が始まる前の最後の回（6/19）で採点。後から作った 10/02 の回は使わない');
  const q1 = rows.find((r) => r.quarter === 'FY2026-Q1' && r.source_kind === 'QUARTER');
  assert.deepEqual(JSON.parse(q1.months_json), Q1.map((ym) => ({ ym, run: 'R0' })));
  rows.forEach((r) => {
    assert.match(r.hit_id, /^HIT-[0-9A-F]{24}$/);
    assert.equal(r.hit_id, E1.call('appStableLogId_("HIT", [__p, __k, __s, __q, "HIT-V1"])', { __p: P1, __k: r.source_kind, __s: r.source_key, __q: r.quarter }), '中身から決まる番号');
    assert.deepEqual([r.policy_version, r.calc_version, r.computed_by, r.client_id], [POLICY, 'HIT-V1', OWNER, E1.table('PLANS')[0].client_id]);
    assert.equal(r.person_email, '', 'つなぎが無ければ空');
  });
  // B-2 と同じ控えで書いた（B-2 の保存の記録と一緒）
  const act = E1.table('PLAN_ACTIONS').filter((r) => r.action === 'EVAL.REPORT');
  assert.equal(act.length, 1);
  // もう一度動かしても増えない
  const st2 = E1.runJob('PLAN.RUN', { planId: P1, action: 'EVAL.REPORT' });
  assert.equal(st2.status, 'DONE', st2.error);
  assert.equal(hits(E1, P1).length, WANT.length, '何度動かしても同じ件数');
  assert.equal(E1.call('appLogTruncatedCells_("HIT_RECORDS")'), 0);
  assert.ok(!E1.errors().some((e) => e.where === 'HIT.RECORD'), 'エラーなし');
}

// ==== 2. 締まっていない月が 1 つでも入る四半期は数えない ====
{
  const E2 = setUpEnv();
  const P2 = E2.seedPlan(planBook(E2, { importedAt: jst(2026, 10, 3, 9) }));   // 月末から 3 日: 9 月は締まっていない
  seedA4(E2, P2);
  const st = E2.runJob('PLAN.RUN', { planId: P2, action: 'EVAL.REPORT' });
  assert.equal(st.status, 'DONE', st.error);
  const rows = hits(E2, P2);
  assert.deepEqual([...new Set(rows.map((r) => r.quarter))], ['FY2026-Q1'], '7〜9 月は 9 月が締まっていないので数えない: ' + JSON.stringify(rows.map((r) => r.quarter)));
  assert.equal(rows.length, 4);
}

// ==== 3. 見せる範囲・古さの重み・順位を作らない ====
{
  const cur = E1.call('appHitQuarterIndex_(appInsightQuarter_(Utilities.formatDate(new Date(), APP_TZ, "yyyy/MM")))');
  const w = (q) => Math.pow(0.8, Math.max(0, cur - 1 - E1.call('appHitQuarterIndex_(__q)', { __q: q })));
  const full = E1.call('apiPeopleLearning()').hits;
  assert.deepEqual(full.people.map((p) => p.name), ['佐藤', '鷹野'].sort((a, b) => a.localeCompare(b, 'ja')), '名前の順（当たりの順ではない）');
  const by = Object.fromEntries(full.people.map((p) => [p.name, p]));
  assert.deepEqual([by['鷹野'].n, by['鷹野'].hit, by['鷹野'].own, by['鷹野'].makers], [2, 2, false, 1]);
  assert.deepEqual([by['佐藤'].n, by['佐藤'].hit], [2, 1]);
  assert.ok(near(by['佐藤'].rate, w('FY2026-Q2') / (w('FY2026-Q1') + w('FY2026-Q2'))), '新しい四半期ほど重い（0.8 倍ずつ）: ' + by['佐藤'].rate);
  assert.ok(by['佐藤'].rate > 0.5, '新しい四半期で当たっているので半分より上');
  assert.deepEqual(by['鷹野'].quarters.map((q) => [q.quarter, q.hit]), [['FY2026-Q2', 1], ['FY2026-Q1', 1]]);
  assert.equal(full.hidden, 0);
  assert.equal(full.quarters, 2);
  const ai = E1.call('apiAiLearning()').research;
  assert.deepEqual(ai.research.map((x) => [x.date, x.n, x.hit, x.clientName]), [['2026-06-10', 1, 1, CLIENT], ['2026-03-15', 1, 0, CLIENT]], 'AI 調査 1 回ごと（新しい順）');
  assert.ok(!JSON.stringify(ai).includes('A4-'), 'A-4 の番号は画面に送らない');
  assert.ok(!JSON.stringify(full).includes('@'), 'メールは送らない');
  // 閲覧の人（つなぎなし）: 件数だけ。名前を送らない
  E1.task('saveMember(__in)', { __in: { email: MEMBER, displayName: 'メンバー', department: '営業' } });
  E1.task('saveMember(__in)', { __in: { email: OTHER, displayName: '鷹野', department: '営業' } });
  E1.as(MEMBER);
  let v = E1.call('apiPeopleLearning()');
  assert.deepEqual([v.hits.people, v.hits.hidden], [[], 4], '人の行 4 件は件数だけ');
  assert.ok(!JSON.stringify(v.hits).includes('鷹野') && !JSON.stringify(v.hits).includes('佐藤'), '名前を送らない');
  let va = E1.call('apiAiLearning()').research;
  assert.deepEqual([va.research, va.hidden], [[], 2], 'AI 調査の当たりも件数だけ');
  E1.as(OWNER);
  // 本人（OTHER を 鷹野 につなぐ）: 自分の行だけ
  const t = (o) => { E1.props.OWNER_TASK = JSON.stringify(o); const r = E1.call('apiOwnerTask()'); delete E1.props.OWNER_TASK; return r; };
  assert.equal(t({ action: 'linkPerson', personName: '鷹野', email: OTHER }).ok, true);
  E1.as(OTHER);
  v = E1.call('apiPeopleLearning()').hits;
  assert.deepEqual(v.people.map((p) => [p.name, p.own, p.n, p.hit]), [['鷹野', true, 2, 2]], '本人には自分の行だけ');
  assert.equal(v.hidden, 2, 'ほかの人の行は件数だけ');
  assert.ok(!JSON.stringify(v).includes('佐藤'));
  E1.as(MEMBER);
  assert.deepEqual(E1.call('apiPeopleLearning()').hits.people, [], 'ほかの人の行は見えないまま');
  E1.as(OWNER);
  // メーカー単位の予算策定担当: そのメーカーは全部
  E1.task('grantRole(__in)', { __in: { email: MEMBER, role: 'PLANNER', scopeType: 'CLIENT', clientId: E1.table('PLANS')[0].client_id } });
  E1.as(MEMBER);
  v = E1.call('apiPeopleLearning()').hits;
  assert.deepEqual([v.people.length, v.hidden], [2, 0], 'そのメーカーの担当は全部');
  assert.equal(E1.call('apiAiLearning()').research.research.length, 2);
  E1.as(OWNER);
  // 古さの重みの道具
  assert.equal(E1.call('appHitWeight_("FY2026-Q2", __c)', { __c: E1.call('appHitQuarterIndex_("FY2026-Q3")') }), 1, '一番新しい締まった四半期が 1');
  assert.ok(near(E1.call('appHitWeight_("FY2026-Q1", __c)', { __c: E1.call('appHitQuarterIndex_("FY2026-Q3")') }), 0.8));
  assert.deepEqual(E1.call('appHitQuarterMonths_("FY2026-Q4")'), ['2027/01', '2027/02', '2027/03']);
  assert.equal(E1.call('appHitQuarterEnd_("FY2026-Q4")'), '2027-03-31');
  assert.equal(E1.call('appHitQuarterEnd_("FY2027-Q4")'), '2028-03-31');
}

// ==== 4. 移行の写し: 今ある記録から 1 回作る ====
{
  const E3 = setUpEnv();
  E3.run('appHitBackfillBudgetMs_ = function() { return -1; };');   // 1 計画ずつ続きに分ける
  const PA = E3.seedPlan(planBook(E3, { evaluated: true }));
  const PB = E3.seedPlan(planBook(E3, { client: '別の製薬', evaluated: true }));
  seedA4(E3, PA);
  E3.call('apiListPlans()');   // 表の版がそろった後の最初の操作で写す（1 つ目の計画で区切る）
  let bf = JSON.parse(E3.props.APP_BACKFILLS || '{"done":{}}');
  assert.equal(bf.done.appV10BackfillHitRecords_, undefined, '続きがある');
  const first = [PA, PB].sort()[0], second = [PA, PB].sort()[1];
  assert.ok(hits(E3, first).length > 0 && hits(E3, second).length === 0, '1 つ目の計画だけ');
  E3.call('apiListPlans()');
  bf = JSON.parse(E3.props.APP_BACKFILLS);
  assert.ok(bf.done.appV10BackfillHitRecords_, '続きで済んだ');
  assert.equal(E3.props.APP_V10_HIT_BACKFILL, undefined, '済んだら続きの印を消す');
  const a = hits(E3, PA);
  sameRows(brief(a), brief(WANT.map((w) => ({ quarter: w[0], source_kind: w[1], source_key: w[2], push: w[3], actual_dir: w[4], hit: w[5], n_months: w[6] }))), '移行の写し');
  assert.ok(a.every((r) => r.calc_version === 'HIT-V1+BACKFILL'), '移行で作った印');
  assert.equal(hits(E3, PB).filter((r) => r.source_kind === 'AI_RESEARCH').length, 0, 'A-4 の記録が無い計画の AI の押しは、どの調査か分からないので数えない');
  // 後の B-2 は同じ四半期の行を足さない（番号が同じ）
  const n = hits(E3).length;
  const st = E3.runJob('PLAN.RUN', { planId: PA, action: 'EVAL.REPORT' });
  assert.equal(st.status, 'DONE', st.error);
  assert.equal(hits(E3).length, n, '移行の行と B-2 の行は重ならない');
  // もう一度動かしても足さない（同じ番号）
  E3.props.APP_BACKFILLS = '';
  E3.run('appHitBackfillBudgetMs_ = function() { return 20000; };');
  assert.deepEqual(E3.call('appV10BackfillHitRecords_({ actor: "x@bigm2y.com", requestId: "T" })'), { rows: 0, plans: 2 });
  assert.equal(hits(E3).length, n);
  // 前の版の検証の行しか無いときの写し: 四半期の印だけ（そろった月 0）。後の B-2 でそろったら、人と AI の行と新しい印を足す（読むときは新しい印）
  const E3b = setUpEnv();
  const PC = E3b.seedPlan(planBook(E3b, { b2At: jst(2026, 10, 7, 10) }));
  seedA4(E3b, PC);
  E3b.call('apiListPlans()');
  assert.deepEqual(brief(hits(E3b, PC)).map((r) => [r[0], r[1], r[6]]), [['FY2026-Q1', 'QUARTER', 0], ['FY2026-Q2', 'QUARTER', 0]]);
  assert.deepEqual(JSON.parse(hits(E3b, PC)[0].months_json).map((m) => m.miss), ['actual', 'actual', 'actual'], '足りないのは今の版の実績');
  assert.equal(E3b.call('apiPeopleLearning()').hits.quarters, 0);
  const st3 = E3b.runJob('PLAN.RUN', { planId: PC, action: 'EVAL.REPORT' });
  assert.equal(st3.status, 'DONE', st3.error);
  assert.equal(hits(E3b, PC).length, 2 + WANT.length, '前の印は残し（消さない）、そろった分を足す');
  assert.equal(E3b.call('apiPeopleLearning()').hits.quarters, 2, '読むときは新しい印');
  assert.equal(E3b.call('apiPeopleLearning()').hits.people.length, 2);
}

// ==== 5. 年度を締める条件（最後の四半期の当たり） / 締めた年度の計画は移行の写しで飛ばす ====
{
  const E4 = setUpEnv();
  const fy = E4.run('appFy_(new Date())') - 1;
  const done = [H.PROCESS_STATUS, ['step2_status', jst(fy + 1, 4, 6, 9), 'owner', 'success', 'x', 10, ''], ['step5_status', jst(fy + 1, 4, 6, 10), 'owner', 'success', 'x', 10, '']];
  const output = [['FY' + fy + ' 売上予測']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 900, 1000, 1100], [], []);
  for (let i = 0; i < 12; i++) output.push([new Date(fy, 3 + i, 1), 70, 80, 90, '', '', '', 80, '']);
  const book = (client, status) => E4.makeBook(client, Object.assign({ CONFIG: CONFIG(client, fy), OUTPUT: { values: output } }, status ? { PROCESS_STATUS: { values: status } } : {}));
  // 移行の写しは止めておく（締める条件を確かめるため。後で戻す）
  const real = E4.run('appV10BackfillHitRecords_.toString()');
  E4.run('appV10BackfillHitRecords_ = function(ctx) { return { skipped: true }; };');
  const PA = E4.seedPlan(book('甲製薬', done));      // 実績を取り込んだ予算の計画
  const PM = E4.seedPlan(book('乙製薬', done));      // 測る専用の計画（外す）
  const PN = E4.seedPlan(book('丙製薬', null));      // 実績の無い計画（外す）
  E4.call(`appWithLock_(() => appUpdateByKey_('PLANS', { plan_id: '${PM}' }, { purpose: 'MEASURE' }, APP_ROW_UNCHECKED, '${OWNER}'))`);
  for (const p of [PA, PN]) {
    const sub = E4.call('appTestVersionSubmit_(__in)', { __in: { planId: p } });
    E4.call('appTestVersionDecide_(__in)', { __in: { versionId: sub.version.versionId, decision: 'APPROVED', rowVersion: sub.version.rowVersion } });
  }
  let pv = E4.task('yearPreview(__in)', { __in: { fy } });
  assert.equal(pv.canClose, false);
  assert.equal(pv.reason, 'FY' + fy + ' の 1〜3 月の当たりをまだ数えていない計画があります（甲製薬）。3 月の実績が締まってから（4 月 5 日以降に）実績を取り込み、当たり具合を計算してから締めてください。',
    '測る専用・実績の無い計画は挙げない');
  // 四半期の印があれば締められる（ここでは、そろっていない四半期の印だけ: 実績と予測の回が無い月）
  const rows = E4.call('appHitRowsOf_(appPlanOf_(__p), appEngTableObjects_(__p, APP_HIT_TABLES), [], [])', { __p: PA });
  assert.deepEqual(rows.map((r) => [r.quarter, r.source_kind, r.n_months]), [1, 2, 3, 4].map((q) => ['FY' + fy + '-Q' + q, 'QUARTER', 0]), '締まった四半期ごとに印（数えられない月は印だけ）');
  assert.deepEqual(rows[3].months_json.map((m) => m.miss), ['forecast', 'forecast', 'forecast']);
  E4.call(`appWithLock_(() => appJournalRun_({ actor: '${OWNER}', requestId: 'T' }, 'テスト', __p, appHitOps_({ actor: '${OWNER}' }, appPlanOf_(__p), __r.filter(r => /Q4$/.test(r.quarter)), 'HIT-V1')))`,
    { __p: PA, __r: rows });
  pv = E4.task('yearPreview(__in)', { __in: { fy } });
  assert.equal(pv.canClose, true, pv.reason);
  assert.equal(E4.runJob('YEAR.CLOSE', { fy, inputHash: pv.inputHash }).status, 'DONE');
  // 締めた後に移行の写しを動かす: 締めた年度の計画は飛ばす（書こうとすると止まる）
  E4.run('appV10BackfillHitRecords_ = ' + real);
  const before = hits(E4).length;
  E4.call('apiListPlans()');
  const bf = JSON.parse(E4.props.APP_BACKFILLS);
  assert.ok(bf.done.appV10BackfillHitRecords_, '済んだ（失敗していない）: ' + JSON.stringify(bf.failed));
  assert.equal(hits(E4).length, before, '締めた年度の計画には足さない');
  assert.equal(E4.call('appYearHitsPending_(__f, [])', { __f: fy }), '', '計画が無ければ止めない');
}

// ==== 6. 学びの記録 ====
/** OWNER_TASK に頼みを置いて動かす（裏の処理なら最後まで） */
function ownerTask(env, t) {
  env.props.OWNER_TASK = JSON.stringify(t);
  const full = env.call('apiOwnerTask()');
  if (full.result && full.result.jobId) {
    for (let i = 0; i < 30; i++) {
      env.fireTriggers('triggerRunJob');
      const st = env.call('apiOwnerTask()').result;
      if (['QUEUED', 'RUNNING', 'CONTINUED'].includes(st.status)) continue;
      delete env.props.OWNER_TASK;
      return st;
    }
    throw new Error('処理が終わらない');
  }
  delete env.props.OWNER_TASK;
  return full;
}
/** 止めている操作を、待ち行列に直接入れて動かす（C-1 で見直し案を作るため。app-calibration.test.mjs と同じ） */
function runQueued(env, kind, payload) {
  let id = env.run(`appWithLock_(() => appEnqueueJob_(__k, __p, __by, '').id)`, { __k: kind, __p: payload, __by: OWNER });
  for (let i = 0; i < 60; i++) {
    env.fireTriggers('triggerRunJob');
    const st = env.run('appJobGet_(__id)', { __id: id });
    if (st.status === 'DONE' && st.nextJobId) { id = st.nextJobId; continue; }
    if (st.status === 'QUEUED' || st.status === 'RUNNING') continue;
    return st;
  }
  throw new Error('続きの処理が終わらない');
}
/** 見直し案を作れる計画（app-calibration.test.mjs の seedReviewPlan と同じ形。本物の C-1 で 2 件の案ができる） */
function seedReviewPlan(e, name) {
  const D = (y, m, d = 1) => new Date(y, m - 1, d);
  const MONTHS = [['2026/04', 1200, 1000], ['2026/05', 800, 1000], ['2026/06', 1050, 1000]];
  const evalLog = [H.EVAL_LOG].concat(...MONTHS.map(([ym, act, p50], i) => [['nega', p50 * 0.95], ['neutral', p50], ['posi', p50 * 1.05]]
    .map(([sc, p]) => row('EVAL_LOG', { eval_id: 'E' + i + sc, evaluated_at: D(2026, 9, 1), client: CLIENT, target_month: ym, scenario: sc, pred: p, actual: act,
      signed_error: p - act, abs_error: Math.abs(p - act), bias_direction: p > act ? 'over' : 'under', constraint_relevant_flag: sc === 'neutral' ? 1 : 0, evaluation_policy_version: POLICY }))));
  const run1 = D(2026, 3, 20);
  const impact = (m) => row('AI_IMPACT_HISTORY', { run_id: 'R1', run_at: run1, client: CLIENT, target_month: D(2026, m), k_ai: 1, ai_direction: 'flat', pred_p50: 1000, pred_p50_quant_only: 1000, forecast_source: 'forecast_open' });
  const push = (m, type, key, dir) => row('SUBJECTIVE_IMPACT_HISTORY', { run_id: 'R1', run_at: run1, client: CLIENT, target_month: D(2026, m), source_type: type,
    source_key: key, push_step: dir * 0.05, push_direction: dir, applied_reliability_r: 1, forecast_source: 'forecast_open' });
  return e.seedPlan(e.makeBook(name, {
    CONFIG: CONFIG(CLIENT, 2026),
    PROCESS_STATUS: { values: [H.PROCESS_STATUS, ['step4_status', D(2026, 9, 1), 'owner', 'success', CLIENT, 12, ''], ['step5_status', D(2026, 9, 1), 'owner', 'success', CLIENT, 9, '']] },
    RUN_LOG: { values: [H.RUN_LOG] },
    EVAL_LOG: { values: evalLog, formats: { D: '@' } },
    ACTUAL_EVAL_MONTHLY: { values: [H.ACTUAL_EVAL_MONTHLY].concat(MONTHS.map(([ym, act]) => [CLIENT, 'BASE', '製品A', ym, act, 'closed', D(2026, 7, 10)])), formats: { D: '@' } },
    AI_IMPACT_HISTORY: { values: [H.AI_IMPACT_HISTORY, impact(4), impact(5), impact(6)] },
    SUBJECTIVE_IMPACT_HISTORY: { values: [H.SUBJECTIVE_IMPACT_HISTORY, push(4, 'opinion', '鷹野', 1), push(5, 'opinion', '鷹野', -1), push(6, 'opinion', '鷹野', 1),
      push(4, 'factor_product', '佐藤', -1), push(5, 'factor_product', '佐藤', 1), push(6, 'factor_product', '佐藤', -1)] },   // 佐藤は 3 か月とも実績と逆（いつも同じ向きより外れる。2026-10-13 から当たりは基準と比べる）
    AI_SCORE_HISTORY: { values: [H.AI_SCORE_HISTORY] },
    CALIBRATION_STATE: { values: [H.CALIBRATION_STATE, [CLIENT, D(2026, 9, 1), 'owner', '', '', '[]', 1, '', '{}', '', '', 1, '']] },
    CALIBRATION_HISTORY: { values: [H.CALIBRATION_HISTORY] },
    SOURCE_RELIABILITY: { values: [H.SOURCE_RELIABILITY] },
    POOL_PRIOR: { values: [H.POOL_PRIOR] },
    QUARTERLY_REVIEW: { values: [['']] },
    QUARTERLY_REVIEW_LOG: { values: [H.QUARTERLY_REVIEW_LOG] },
    RELIABILITY_EVIDENCE: { values: [H.RELIABILITY_EVIDENCE] },
  }));
}
const learn = (env, planId) => env.table('LEARNING_LOG').filter((r) => planId === undefined || r.plan_id === planId);
{
  const E5 = setUpEnv();
  const P = seedReviewPlan(E5, '予測L');
  const hash = () => { E5.props.OWNER_TASK = JSON.stringify({ action: 'calibrationPreview', planId: P }); const h = E5.call('apiOwnerTask()').result.inputHash; delete E5.props.OWNER_TASK; return h; };
  // 補正の書き込み: 変えた項目ごとに APPLY
  let st = ownerTask(E5, { action: 'setCalibration', planId: P, set: { bias_correction_factor: 1.1, auto_update_enabled: 0 }, reason: '学びの記録の確かめ', inputHash: hash() });
  assert.equal(st.status, 'DONE', st.error);
  let L = learn(E5, P);
  assert.deepEqual(L.map((r) => [r.event, r.origin, r.target, r.current_value, r.proposed_value, r.applied_value, r.note, r.actor_email]),
    [['APPLY', 'OWNER', 'bias_correction_factor', '1', '1.1', '1.1', '学びの記録の確かめ', OWNER], ['APPLY', 'OWNER', 'auto_update_enabled', '1', '0', '0', '学びの記録の確かめ', OWNER]]);
  assert.ok(L.every((r) => /^OWNER:ACT-.+:(bias_correction_factor|auto_update_enabled)$/.test(r.proposal_id) && /^LRN-[0-9A-F]{24}$/.test(r.learn_id)));
  // 同じ頼みをもう一度: 変わる値が無いので足さない
  st = ownerTask(E5, { action: 'setCalibration', planId: P, set: { bias_correction_factor: 1.1, auto_update_enabled: 0 }, reason: '学びの記録の確かめ', inputHash: hash() });
  assert.equal(st.status, 'DONE', st.error);
  assert.equal(learn(E5, P).length, 2, '同じ頼みでは足さない');
  // C-1（止めている。待ち行列に直接入れる）: 案ごとに PROPOSE
  const gen = runQueued(E5, 'PLAN.RUN', { planId: P, action: 'REVIEW.GENERATE' });
  assert.equal(gen.status, 'DONE', gen.error);
  const log = E5.table('ENG_QUARTERLY_REVIEW_LOG').filter((r) => r.plan_id === P);
  assert.equal(log.length, 2, '前提: 見直し案が 2 件');
  const rid = log[0].review_id;
  const pid = (r) => rid + ':' + r.proposal_id;
  L = learn(E5, P).filter((r) => r.event === 'PROPOSE');
  assert.deepEqual(L.map((r) => [r.proposal_id, r.origin, r.target, r.proposed_value, r.review_quarter]), log.map((r) => [pid(r), 'QUARTERLY', r.target_field, r.proposed_value, 'FY2026-Q1']));
  // C-3（自動の学びの旗が 0。判断なし）: 判断（保留）だけ。反映は足さない
  st = E5.runJob('PLAN.RUN', { planId: P, action: 'REVIEW.APPLY' });
  assert.equal(st.status, 'DONE', st.error);
  L = learn(E5, P);
  assert.deepEqual(L.filter((r) => r.event === 'DECIDE').map((r) => [r.proposal_id, r.decision, r.origin]), log.map((r) => [pid(r), '保留', 'REVIEW_APPLY']));
  assert.equal(L.filter((r) => r.event === 'APPLY').length, 2, '旗が 0 の C-3 は反映しないので APPLY を足さない（所有者の 2 行だけ）');
  // 判断の保存: 変わった判断ごとに DECIDE
  const view = E5.call('apiPlanView(__in)', { __in: { planId: P } }).boot.quarterly;
  const decide = (ds) => { const s = E5.runJob('PLAN.EDIT', { planId: P, action: 'REVIEW.DECIDE', args: { rows: view.proposals.map((p, i) => ({ row: p.row, decision: ds[i] })) } }); assert.equal(s.status, 'DONE', s.error); };
  const n0 = learn(E5, P).length;
  decide(['承認', '却下']);
  L = learn(E5, P).slice(n0);
  assert.deepEqual(L.map((r) => [r.event, r.decision, r.origin, r.proposal_id]), [['DECIDE', '承認', 'QUARTERLY', rid + ':' + view.proposals[0].pid], ['DECIDE', '却下', 'QUARTERLY', rid + ':' + view.proposals[1].pid]]);
  decide(['承認', '却下']);
  assert.equal(learn(E5, P).length, n0 + 2, '同じ判断をもう一度保存しても足さない');
  // C-3（旗 0）: 判断は記録どおりなので足さない
  st = E5.runJob('PLAN.RUN', { planId: P, action: 'REVIEW.APPLY' });
  assert.equal(st.status, 'DONE', st.error);
  assert.equal(learn(E5, P).length, n0 + 2);
  // 旗を 1 に戻して C-3: 承認した案を反映 → APPLY
  st = ownerTask(E5, { action: 'setCalibration', planId: P, set: { auto_update_enabled: 1 }, reason: '戻す', inputHash: hash() });
  assert.equal(st.status, 'DONE', st.error);
  st = E5.runJob('PLAN.RUN', { planId: P, action: 'REVIEW.APPLY' });
  assert.equal(st.status, 'DONE', st.error);
  const applied = E5.table('ENG_QUARTERLY_REVIEW_LOG').filter((r) => r.plan_id === P && r.applied === '1');
  assert.equal(applied.length, 1, '前提: 承認した 1 件を反映');
  L = learn(E5, P).filter((r) => r.event === 'APPLY' && r.origin === 'REVIEW_APPLY');
  assert.deepEqual(L.map((r) => [r.proposal_id, r.target, r.applied_value]), [[pid(applied[0]), applied[0].target_field, applied[0].proposed_value]]);
  // 同じ案の行が proposal_id でつながる: 案 → 判断（保留）→ 判断（承認）→ 反映
  const chain = learn(E5, P).filter((r) => r.proposal_id === pid(applied[0])).map((r) => [r.event, r.decision]);
  assert.deepEqual(chain, [['PROPOSE', ''], ['DECIDE', '保留'], ['DECIDE', '承認'], ['APPLY', '']]);
  // 反映した後にもう一度 C-3: 足さない（反映は案ごとに 1 回）
  const n1 = learn(E5, P).length;
  E5.runJob('PLAN.RUN', { planId: P, action: 'REVIEW.APPLY' });
  assert.equal(learn(E5, P).length, n1);
  // 年度の控えに入る（計画の行）
  assert.equal(E5.call('appReadPlanTable_("LEARNING_LOG", __p)', { __p: P }).length, n1);

  // 取り下げ: 案ごとに DECIDE「取り下げ」（所有者）
  const E6 = setUpEnv();
  const P6 = seedReviewPlan(E6, '予測W');
  assert.equal(runQueued(E6, 'PLAN.RUN', { planId: P6, action: 'REVIEW.GENERATE' }).status, 'DONE');
  const log6 = E6.table('ENG_QUARTERLY_REVIEW_LOG').filter((r) => r.plan_id === P6);
  const w = ownerTask(E6, { action: 'setCalibration', planId: P6, withdrawPendingReview: true, reason: '締まっていない月の案' });
  assert.equal(w.status, 'DONE', w.error);
  const L6 = learn(E6, P6).filter((r) => r.event === 'DECIDE');
  assert.deepEqual(L6.map((r) => [r.proposal_id, r.decision, r.origin, r.target, r.note]), log6.map((r) => [log6[0].review_id + ':' + r.proposal_id, '取り下げ', 'OWNER', r.target_field, '締まっていない月の案']));
  ownerTask(E6, { action: 'setCalibration', planId: P6, withdrawPendingReview: true, reason: 'もう一度' });
  assert.equal(learn(E6, P6).length, L6.length + 2, 'もう一度でも足さない（PROPOSE 2 件 + 取り下げ 2 件）');

  // τ・w の承認: 全計画の行（plan_id が空）。同じ値をもう一度書いても足さない
  const tau = ownerTask(E5, { action: 'saveSetting', key: 'landing.tau', value: 0.2, note: '学びの画面の試しの値を承認' });
  assert.equal(tau.ok, true);
  let G = learn(E5, '');
  assert.deepEqual(G.map((r) => [r.event, r.origin, r.target, r.current_value, r.proposed_value, r.applied_value, r.note]),
    [['APPLY', 'OWNER', 'landing.tau', '0.15', '0.2', '0.2', '学びの画面の試しの値を承認']]);
  assert.equal(G[0].proposal_id, G[0].learn_id);
  assert.equal(E5.table('SETTINGS').filter((r) => r.key === 'landing.tau').length, 1, '設定の行も同じ控えで書いた');
  ownerTask(E5, { action: 'saveSetting', key: 'landing.tau', value: 0.2 });
  assert.equal(learn(E5, '').length, 1, '同じ値は足さない');
  const later = E5.run('Utilities.formatDate(new Date(Date.now() + 40 * 864e5), APP_TZ, "yyyy-MM-dd")');
  ownerTask(E5, { action: 'saveSetting', key: 'landing.w', value: 1.5, effectiveFrom: later });
  ownerTask(E5, { action: 'saveSetting', key: 'landing.w', value: 1.5, effectiveFrom: later });
  G = learn(E5, '');
  assert.deepEqual(G.slice(1).map((r) => [r.target, r.current_value, r.proposed_value, r.note]), [['landing.w', '1', '1.5', later + ' から。']], '先の日から効く値: 同じ頼みは 1 行');
  assert.deepEqual(E5.call('appLearnSettingOps_({ actor: "x" }, "source.zac_spreadsheet", null, "abc", "2026-10-08", "")'), [], 'ほかの設定は学びではない');
  const snap = JSON.parse(E5.call('appYearSnapshot_(2026)').text).tables.find((t) => t.name === 'LEARNING_LOG');
  assert.ok(snap.rows.length === n1, '全計画の行は年度の控えに入らない');
}

// ==== 7. 人のつなぎ ====
{
  const E7 = setUpEnv();
  const P7 = E7.seedPlan(planBook(E7));
  const X = E7.table('PLANS').find((p) => p.plan_id === P7).client_id;
  const t = (o) => { E7.props.OWNER_TASK = JSON.stringify(o); try { return E7.call('apiOwnerTask()'); } finally { delete E7.props.OWNER_TASK; } };
  const links = () => E7.table('PERSON_LINKS');
  E7.task('saveMember(__in)', { __in: { email: MEMBER, displayName: '鷹野', department: '営業' } });
  E7.task('saveMember(__in)', { __in: { email: OTHER, displayName: 'ほかの人', department: '営業' } });
  // 一覧と案: 入力の担当者の名前と、表示名が同じメンバー（つなぐのは所有者）
  let ls = t({ action: 'listPersonLinks' }).result;
  assert.deepEqual(ls.links, []);
  assert.deepEqual(ls.names.map((n) => [n.personName, n.clientIds, n.linked]).sort(), [['佐藤', [X], false], ['鷹野', [X], false]]);
  assert.deepEqual(ls.suggestions, [{ personName: '鷹野', email: MEMBER, displayName: '鷹野', clientIds: [X] }]);
  // 登録していないメールはつながない・所有者だけ
  assert.throws(() => t({ action: 'linkPerson', personName: '鷹野', email: 'nobody@bigm2y.com' }), /メンバーに登録済みの人だけ/);
  assert.throws(() => E7.call('appLinkPerson_({ actor: __m, user: { email: __m, isOwner: false } }, { personName: "鷹野", email: __m })', { __m: MEMBER }), /所有者だけ/);
  assert.throws(() => t({ action: 'linkPerson', personName: '=IMPORTXML("x")', email: MEMBER }), /数式/);
  assert.equal(links().length, 0, '何も書かない');
  // つなぐ（全部のメーカー）・同じつなぎ・同じ名前を別の人に（同じ範囲と期間）は断る
  const r1 = t({ action: 'linkPerson', personName: '鷹野', email: MEMBER, note: '本人に確かめた' }).result.link;
  assert.deepEqual([r1.person_name, r1.email, r1.client_id, r1.valid_from, r1.valid_to, r1.is_active], ['鷹野', MEMBER, '', '', '', true]);
  assert.match(r1.link_id, /^PLK-/);
  assert.ok(E7.audit().some((a) => a.action === 'PERSON.LINK' && a.phase === 'END'), '監査に残る');
  assert.throws(() => t({ action: 'linkPerson', personName: '鷹野', email: MEMBER }), /同じつなぎ/);
  assert.throws(() => t({ action: 'linkPerson', personName: '鷹野', email: OTHER }), /別の人につながっています/);
  // メーカーを決めたつなぎは、そのメーカーで先に効く（同じ名前がメーカーごとに別の人）
  t({ action: 'linkPerson', personName: '鷹野', email: OTHER, clientId: X });
  const emailOf = (n, c, d) => E7.call('appPersonEmailOf_(__n, __c, __d)', { __n: n, __c: c, __d: d || undefined });
  assert.deepEqual([emailOf('鷹野', X), emailOf('鷹野', 'CL-OTHER')], [OTHER, MEMBER]);
  // 期間の外は効かない
  t({ action: 'linkPerson', personName: '佐藤', email: OTHER, validFrom: '2025-04-01', validTo: '2025-12-31' });
  assert.deepEqual([emailOf('佐藤', X), emailOf('佐藤', X, '2025-06-30')], ['', OTHER]);
  assert.throws(() => t({ action: 'linkPerson', personName: '佐藤', email: MEMBER, validFrom: '2025-06-01' }), /別の人/, '期間が重なれば断る');
  assert.equal(t({ action: 'linkPerson', personName: '佐藤', email: MEMBER, validFrom: '2026-01-01' }).ok, true, '重ならなければつなげる');
  assert.throws(() => t({ action: 'linkPerson', personName: '佐藤', email: MEMBER, validFrom: '2026-02-01', validTo: '2026-01-01' }), /終わりの日が始まりの日より前/);
  // 外す: 行は残して無効にする（消さない）
  const n = links().length;
  const un = t({ action: 'unlinkPerson', linkId: r1.link_id, rowVersion: 1 }).result.link;
  assert.deepEqual([un.is_active, un.row_version], [false, 2]);
  assert.equal(links().length, n, '行は残る');
  assert.equal(links().find((l) => l.link_id === r1.link_id).is_active, 'FALSE');
  assert.equal(emailOf('鷹野', 'CL-OTHER'), '', '外したつなぎは効かない');
  assert.throws(() => t({ action: 'unlinkPerson', linkId: r1.link_id }), /すでに外れています/);
  assert.throws(() => t({ action: 'unlinkPerson', linkId: 'PLK-NONE' }), /見つかりません/);
  ls = t({ action: 'listPersonLinks' }).result;
  assert.equal(ls.links.length, n, '一覧には外した行も出る');
  assert.deepEqual(ls.suggestions, [], 'つないだ名前は案に出さない');
}

// ==== 8. 画面（学び） ====
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
  const clean = (html, what) => {
    assert.doesNotMatch(html, /undefined|NaN|null/, what + ': 空の値を出さない');
    assert.doesNotMatch(html, /PERSON|AI_RESEARCH|QUARTER|HIT-|A4-|FY\d{4}-Q\d/, what + ': 中の記号を出さない');
  };
  const people = E1.call('apiPeopleLearning()');
  const h1 = run('lrHitCard(__h)', { __h: people.hits });
  clean(h1, '人ごとの当たり');
  assert.match(h1, /<h2>人ごとの当たり<span class="tip"/);
  assert.ok(h1.indexOf('佐藤') < h1.indexOf('鷹野') === ('佐藤'.localeCompare('鷹野', 'ja') < 0), '名前の順のまま');
  assert.match(h1, />2 \/ 2</);
  assert.match(h1, /FY2026 7〜9月 テスト製薬 ↑ \+5% 当たり/, 'カーソルに四半期ごとの当たり');
  // 閲覧の人: 件数だけ（表は出さない）
  const h2 = run('lrHitCard(__h)', { __h: { people: [], hidden: 4, quarters: 2 } });
  clean(h2, '閲覧の人');
  assert.match(h2, /当たりの記録 4 件/);
  assert.doesNotMatch(h2, /<table/);
  // 本人: 自分の札と、ほかの件数
  const h3 = run('lrHitCard(__h)', { __h: { people: [{ name: '鷹野', own: true, n: 2, hit: 2, rate: 1, makers: 1, quarters: [] }], hidden: 2, quarters: 2 } });
  clean(h3, '本人');
  assert.match(h3, /鷹野 <span class="chip">自分<\/span>/);
  assert.match(h3, />ほか 2 件<\/span>/);
  assert.equal(run('lrHitCard(null) + lrHitCard({ people: [], hidden: 0 }) + lrResearchCard(null)'), '', '記録が無ければカードを出さない');
  const ai = E1.call('apiAiLearning()');
  const r1 = run('lrResearchCard(__r)', { __r: ai.research });
  clean(r1, '調査ごとの当たり');
  assert.match(r1, /<h2>調査ごとの当たり<span class="tip"/);
  assert.ok(r1.indexOf('2026/06/10') < r1.indexOf('2026/03/15'), '新しい調査から');
  // 人の学びに当たりの記録だけがあるときも、カードを出す（案内に置き換えない）
  // 2026-10-16: 人ごとの当たり・調査ごとの当たりは、分析の「予測の仕組み」（anMechanics。学びと同じ読み込み）
  run('S.lr.people = __d; S.lr.ai = null', { __d: { detail: 'summary', lessons: [], openActions: [], causes: [], scoreboard: [], decisions: [], uplift: [], summary: {}, hits: { people: [], hidden: 3, quarters: 1 } } });
  assert.match(run('anMechanics()'), /人ごとの当たり/);
  // 学びの画面に渡る中身（本物の応答）で描いても空の値が出ない
  run('S.lr.people = __p; S.lr.ai = __a', { __p: people, __a: ai });
  const page = run('viewLearning()');
  assert.doesNotMatch(page, /undefined|NaN/);
  const mech = run('anMechanics()');
  assert.ok(mech.indexOf('調査ごとの当たり') > 0 && mech.indexOf('人ごとの当たり') > 0 && !/undefined|NaN/.test(mech), '人ごとの当たり・調査ごとの当たりは分析の予測の仕組み');
  assert.ok(page.indexOf('人ごとの当たり') < 0 && page.indexOf('調査ごとの当たり') < 0, '当たりの統計は学びに出さない');
}

console.log('app-v10-hits: ok');
