#!/usr/bin/env node
/*
 * app-v10-fixes-srv.test.mjs — 版 10（v0.30.0）の点検で見つかったことの直し（サーバー側）を確かめる。
 *   S1. 本人の行は、行ごとにその行の日に効く有効なつなぎで決める（当たりの記録は四半期の終わり・入力の記録は保存した日）。
 *       行に残したメール（person_email）は書いたときの控えで、見せる判定とまとめに使わない:
 *       つなぐ → B-2 → 外す → 本人にも出ない / 期間のあるつなぎ（同じ名前を後から別の人）→ 前の人の行は出ない /
 *       全部のメーカーのつなぎとメーカーのつなぎ / 閲覧の人に名前を送らない / 入力の記録も同じ（担当者が変わった行の前の中身は出さない）
 *   S2. 入力の保存は、画面が送る行の出どころ（fromRow）で前と後を組む（行を外して下の行を変えても取り違えない）。送らない保存は今までどおり
 *   S3. 列を足す移行がバックアップを待っている間: 予測の実行・計画を作る・担当者の保存は始めない / 控えを置く前に書く表を確かめる（書きかけを残さない）/
 *       足す 7 つの表の状態の注記
 *   S4. 一度だけの写し: ロックの中で書きかけの保存を先に書き終えてから読む / BASELINE がある計画は飛ばす / 済みの控えを消さない /
 *       した人は仕組み（SYSTEM:V10_BACKFILL）で、画面に人として出さない
 *   S5. 学びの記録の evidence_n は数（分からない件数は空のまま。0 にしない）。列のハッシュは変わらない
 *   S6. 年度を締める条件: 実績が足りない月のある四半期の印（n_months = 0 の移行の印）では締めない
 *   S7. 物差しのまとめは、区切りが計画の年度の初めの回だけ（新しくても前の年度を区切りにした回は数えない）
 *   S8. 文書: 空の seed_rule の読み方・公開後の最初の予測の動き・版 10 を作り終えたこと
 * 名前と数字はテスト用の架空のもの。モックの上の確かめで、本物の Apps Script の上では動かしていない。
 *
 *   node app/tests/app-v10-fixes-srv.test.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setUpEnv, makeEnv, OWNER, MEMBER, OTHER, appDir } from './gas-mock.mjs';

const VIEWER3 = 'viewer3@bigm2y.com';
const SYS = 'SYSTEM:V10_BACKFILL';
const jst = (y, m, d, H = 0, M = 0) => new Date(Date.UTC(y, m - 1, d, H - 9, M));
const D = (y, m, d = 1) => new Date(y, m - 1, d);
const CTX = `{ actor: '${OWNER}', requestId: 'T' }`;

// ---- 当たりの記録の見本（app-v10-hits.test.mjs と同じ形。2026 年度の 4〜9 月が締まった計画）----
const CLIENT = 'テスト製薬';
const FY_MONTHS = ['2026/04', '2026/05', '2026/06', '2026/07', '2026/08', '2026/09', '2026/10', '2026/11', '2026/12', '2027/01', '2027/02', '2027/03'];
const ACT = { '2026/04': 1000, '2026/05': 1000, '2026/06': 1000, '2026/07': 1000, '2026/08': 1000, '2026/09': 1000, '2026/10': 300 };
const RUNS = { R0: jst(2026, 3, 20, 10), R1: jst(2026, 6, 19, 10), R2: jst(2026, 10, 2, 10) };
const QUANT = { R0: 1100, R1: 950, R2: 1200 };
const KAI = { R0: [1.03, 'up'], R1: [1.02, 'up'], R2: [0.95, 'down'] };
const MONTHS_OF = { R0: FY_MONTHS.slice(0, 6), R1: FY_MONTHS.slice(3, 9), R2: FY_MONTHS.slice(3, 9) };
const Q1 = FY_MONTHS.slice(0, 3), Q2 = FY_MONTHS.slice(3, 6);
const env0 = setUpEnv();
const H = env0.run('(() => { const o = {}; Object.keys(APP_ENGINE_SHEETS).forEach(k => { o[k] = APP_ENGINE_SHEETS[k].header || null; }); return o; })()');
const row = (sheet, o) => H[sheet].map((h) => (o[h] === undefined ? '' : o[h]));
const CONFIG = (client, fy, people = '鷹野,佐藤') => ({ values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', people]] });
const POLICY = env0.run('APP_EVAL_POLICY_VERSION');
// 鷹野: 4〜6 月・7〜9 月とも当たり。佐藤: 5 月だけ上げ（外れ）・7 月だけ上げ（当たり）
const PUSHES = [].concat(
  Q1.map((ym) => ['R0', ym, 'opinion', '鷹野', -0.05]), [['R0', '2026/04', 'factor_product', '鷹野', 0.02]], [['R0', '2026/05', 'factor_client', '佐藤', 0.05]],
  Q2.map((ym) => ['R1', ym, 'opinion', '鷹野', 0.05]), [['R1', '2026/07', 'factor_client', '佐藤', 0.05]],
  Q2.map((ym) => ['R2', ym, 'opinion', '鷹野', -0.05]));

function planBook(env, { client = CLIENT, importedAt = jst(2026, 10, 6, 9), evaluated = false } = {}) {
  const snap = [H.FORECAST_SNAPSHOT];
  Object.keys(RUNS).forEach((id) => FY_MONTHS.forEach((ym) => ['nega', 'neutral', 'posi'].forEach((sc, i) => {
    const p50 = QUANT[id] + 50;
    snap.push([id, RUNS[id], client, ym, sc, p50, 0, 0, 0, p50 * [0.9, 1, 1.1][i], p50 * 0.9, p50 * 1.1, JSON.stringify({ opinion: '', forecast_source: 'forecast_open' }), '',
      JSON.stringify({ version: 'test', bias_correction_factor: 1, residual_month_bias_json: '' })]);
  })));
  const actual = [H.ACTUAL_EVAL_MONTHLY].concat(Object.keys(ACT).map((ym) => [client, 'BASE', '製品A', ym, ACT[ym], ym <= '2026/09' ? 'closed' : 'open', importedAt]));
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
    ['step5_status', evaluated ? jst(2026, 10, 7, 10) : jst(2026, 10, 2, 11), 'owner', 'success', '', 30, '']];
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

/** 入力の行のある計画のブック（製品の行 product = [[担当者, 製品, 月の日付, 増減率, 理由]]） */
function inputBook(env, client, fy, product, extra) {
  const output = [['FY' + fy + ' 売上予測（' + client + '）']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 900, 1000, 1100], [], []);
  for (let i = 0; i < 12; i++) output.push([D(fy, 4 + i, 1), 70, 80, 90, '', '', '', 80, '']);
  return env.makeBook(client, Object.assign({
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '鷹野,佐藤']] },
    OUTPUT: { values: output },
    PRODUCT: { values: [['Person', 'ProductName', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']].concat(product) },
    CLIENT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']] },
    OPINIONS: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Confidence(0..1)', 'Note']] },
    DEV_SPOT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Project', 'Amount(JPY)', 'Confidence(0..1)']] },
  }, extra || {}));
}

const task = (env, o) => { env.props.OWNER_TASK = JSON.stringify(o); try { return env.call('apiOwnerTask()'); } finally { delete env.props.OWNER_TASK; } };
const as = (env, email, fn) => { env.as(email); try { return fn(); } finally { env.as(OWNER); } };
const hitsOf = (env, email) => as(env, email, () => env.call('apiPeopleLearning()').hits);
const brief = (h) => h.people.map((p) => [p.name, p.own, p.n, p.quarters.map((q) => q.quarter + ' ' + q.clientName).sort()]);
const members = (env, list) => list.forEach(([email, name]) => env.call('apiSaveMember(__in)', { __in: { email, displayName: name, department: '営業' } }));
const b2 = (env, planId) => { const st = env.runJob('PLAN.RUN', { planId, action: 'EVAL.REPORT' }); assert.equal(st.status, 'DONE', st.error); };
const personHits = (env, planId, name) => env.table('HIT_RECORDS').filter((r) => r.plan_id === planId && r.source_kind === 'PERSON' && (!name || r.source_key === name));
const noNames = (v, what) => assert.doesNotMatch(JSON.stringify(v), /鷹野|佐藤|@/, what + ': 名前とメールを送らない');

// ==== S1-a. つなぐ → B-2 → 外す: 本人にも出ない。後で別の名前をつないでも 2 人をまとめない ====
{
  const E = setUpEnv();
  const P = E.seedPlan(planBook(E));
  members(E, [[MEMBER, 'メンバー'], [OTHER, 'ほかの人'], [VIEWER3, '閲覧']]);
  const link = task(E, { action: 'linkPerson', personName: '佐藤', email: MEMBER }).result.link;
  b2(E, P);
  assert.deepEqual(personHits(E, P, '佐藤').map((r) => r.person_email), [MEMBER, MEMBER], '前提: 書いたときのつなぎのメールが行に残る');
  assert.deepEqual(brief(hitsOf(E, MEMBER)), [['佐藤', true, 2, ['FY2026-Q1 テスト製薬', 'FY2026-Q2 テスト製薬']]], '前提: つないでいる間は本人の行');
  assert.equal(task(E, { action: 'unlinkPerson', linkId: link.link_id }).ok, true);
  let v = hitsOf(E, MEMBER);
  assert.deepEqual([v.people, v.hidden], [[], 4], '外した後は、前に数えた行も本人に出ない（件数だけ）');
  noNames(v, '外した後');
  b2(E, P);   // B-2 をもう一度動かしても行は増えず、見え方も変わらない
  assert.equal(personHits(E, P).length, 4);
  assert.deepEqual(hitsOf(E, MEMBER).people, []);
  // 別の名前（鷹野）を同じ人につなぐ: 外した 佐藤 の行とまとめない
  task(E, { action: 'linkPerson', personName: '鷹野', email: MEMBER });
  const full = hitsOf(E, OWNER);
  assert.deepEqual(brief(full).map((p) => [p[0], p[2]]), [['佐藤', 2], ['鷹野', 2]].sort((a, b) => a[0].localeCompare(b[0], 'ja')), '2 人は別の人のまま（「佐藤・鷹野」にしない）');
  v = hitsOf(E, MEMBER);
  assert.deepEqual(brief(v).map((p) => p.slice(0, 3)), [['鷹野', true, 2]]);
  assert.equal(v.hidden, 2);
  assert.ok(!JSON.stringify(v).includes('佐藤'), '外した名前は出ない');
  const v3 = hitsOf(E, VIEWER3);
  assert.deepEqual([v3.people, v3.hidden], [[], 4], 'つなぎの無い閲覧の人は件数だけ');
  noNames(v3, '閲覧の人');
  const ai = as(E, VIEWER3, () => E.call('apiAiLearning()').research);
  assert.deepEqual(ai.research, [], 'AI 調査の当たりも件数だけ');
}

// ==== S1-b. 期間のあるつなぎ（同じ名前を後から別の人）: それぞれ自分の期間の四半期だけ ====
{
  const E = setUpEnv();
  const P = E.seedPlan(planBook(E));
  members(E, [[MEMBER, 'メンバー'], [OTHER, 'ほかの人']]);
  task(E, { action: 'linkPerson', personName: '鷹野', email: MEMBER, validTo: '2026-06-30' });
  task(E, { action: 'linkPerson', personName: '鷹野', email: OTHER, validFrom: '2026-07-01' });
  b2(E, P);
  assert.deepEqual(personHits(E, P, '鷹野').map((r) => [r.quarter, r.person_email]).sort(), [['FY2026-Q1', MEMBER], ['FY2026-Q2', OTHER]]);
  assert.deepEqual(brief(hitsOf(E, OTHER)), [['鷹野', true, 1, ['FY2026-Q2 テスト製薬']]], '後から名前を使う人に、前の人の 4〜6 月を出さない');
  assert.deepEqual(brief(hitsOf(E, MEMBER)), [['鷹野', true, 1, ['FY2026-Q1 テスト製薬']]], '前の人には自分の期間だけ');
  assert.deepEqual(hitsOf(E, OTHER).hidden, 3);
  const full = hitsOf(E, OWNER).people.filter((p) => p.name === '鷹野');
  assert.deepEqual(full.map((p) => p.n), [1, 1], '同じ名前の 2 人は別の人として数える');
}

// ==== S1-c. B-2 の後でつなぐ（つなぎの始まりが四半期より後）: 前の四半期は本人の行にしない ====
{
  const E = setUpEnv();
  const P = E.seedPlan(planBook(E));
  members(E, [[MEMBER, 'メンバー']]);
  b2(E, P);
  assert.ok(personHits(E, P).every((r) => r.person_email === ''), '前提: つなぎの無いときに書いた');
  const l1 = task(E, { action: 'linkPerson', personName: '佐藤', email: MEMBER, validFrom: '2026-10-01' }).result.link;
  let v = hitsOf(E, MEMBER);
  assert.deepEqual([v.people, v.hidden], [[], 4], 'つなぎが始まる前の四半期は出さない（今日のつなぎで前の行を決めない）');
  task(E, { action: 'unlinkPerson', linkId: l1.link_id });
  task(E, { action: 'linkPerson', personName: '佐藤', email: MEMBER, validFrom: '2026-07-01' });
  v = hitsOf(E, MEMBER);
  assert.deepEqual(brief(v), [['佐藤', true, 1, ['FY2026-Q2 テスト製薬']]], '期間の中の四半期（7〜9 月）だけ');
}

// ==== S1-d. 全部のメーカーのつなぎとメーカーのつなぎ（メーカーのつなぎが先） ====
{
  const E = setUpEnv();
  const PA = E.seedPlan(planBook(E));
  const PB = E.seedPlan(planBook(E, { client: '別の製薬' }));
  members(E, [[MEMBER, 'メンバー'], [OTHER, 'ほかの人']]);
  const XB = E.table('PLANS').find((p) => p.plan_id === PB).client_id;
  task(E, { action: 'linkPerson', personName: '鷹野', email: MEMBER });
  task(E, { action: 'linkPerson', personName: '鷹野', email: OTHER, clientId: XB });
  b2(E, PA);
  b2(E, PB);
  assert.deepEqual(brief(hitsOf(E, MEMBER)), [['鷹野', true, 2, ['FY2026-Q1 テスト製薬', 'FY2026-Q2 テスト製薬']]], '全部のメーカーのつなぎ: 別の製薬の 鷹野 はほかの人');
  assert.deepEqual(brief(hitsOf(E, OTHER)), [['鷹野', true, 2, ['FY2026-Q1 別の製薬', 'FY2026-Q2 別の製薬']]], 'メーカーのつなぎが先に効く');
  const full = hitsOf(E, OWNER).people;
  assert.deepEqual(full.filter((p) => p.name === '鷹野').map((p) => [p.n, p.makers]), [[2, 1], [2, 1]], '鷹野 は 2 人');
  assert.deepEqual(full.filter((p) => p.name === '佐藤').map((p) => [p.n, p.makers]), [[4, 2]], 'つながらない名前は名前でまとめる（今までどおり）');
}

// ==== S1-e. 入力の記録も、保存した日に効くつなぎで決める ====
const view = (env, planId, email = OWNER) => as(env, email, () => env.call('apiPlanView(__in)', { __in: { planId } }));
const save = (env, planId, kind, rows, extra) => env.runJob('PLAN.EDIT', Object.assign({ planId, action: 'INPUT.SAVE', args: { kind, rows }, inputHash: view(env, planId).inputHash }, extra || {}));
const logOf = (env, planId) => env.call('appInputLogRead_(__p)', { __p: planId });
{
  const E = setUpEnv();
  const fy = E.run('appFy_(new Date())');
  const today = E.run('appToday_()');
  const P = E.seedPlan(inputBook(E, '入力製薬', fy, [['佐藤', '製品A', D(fy, 5), '+5%', '理由A'], ['鷹野', '製品B', D(fy, 6), '+3%', '理由B']]));
  const PX = E.seedPlan(inputBook(E, '別製薬', fy, []));
  const X = E.table('PLANS').find((p) => p.plan_id === P).client_id, XO = E.table('PLANS').find((p) => p.plan_id === PX).client_id;
  members(E, [[MEMBER, 'メンバー'], [OTHER, 'ほかの人']]);
  E.call('apiListPlans()');   // 一度だけの写し（BASELINE）
  const v0 = view(E, P);
  const keySato = 'product|佐藤|製品A|' + v0.boot.input.product[0].ym;
  // つなぎが始まる前（9/1）に保存した 佐藤 の行（記録の表に直接）
  E.call(`appWithLock_(() => appJournalRun_(${CTX}, 'テスト', __p, appLogOps_('INPUT_LOG', [{ plan_id: __p, log_id: 'INL-OLD-1', action_id: 'ACT-OLD', action: 'INPUT.SAVE',
    kind: 'product', change: 'CONF', row_key: __k, person: '佐藤', before_json: '', after_json: { person: '佐藤', product: '製品A' }, self_conf: '低い', reason: '前の保存',
    signal_id: '', actor_email: '${OWNER}', saved_at: '2026-09-01T10:00:00+0900' }])))`, { __p: P, __k: keySato });
  const total = logOf(E, P).length;
  task(E, { action: 'linkPerson', personName: '佐藤', email: MEMBER, validFrom: today });
  let il = view(E, P, MEMBER).inputLog;
  assert.equal(il.full, false);
  assert.deepEqual(il.rows.product.map((x) => x && x.hist.map((h) => h.change)), [['BASELINE'], null], 'つなぎが始まった日からの 佐藤 の行だけ（9/1 の保存は出さない）');
  assert.equal(il.hidden, total - 1);
  assert.doesNotMatch(JSON.stringify(il), /佐藤|鷹野|@|前の保存|SYSTEM/, '名前・保存した人・理由・仕組みの印を送らない');
  assert.equal(view(E, P).inputLog.rows.product[0].n, 2, '予算策定担当以上には全部');
  assert.equal(view(E, P).inputLog.rows.product[0].hist.find((h) => h.change === 'BASELINE').by, '', '一度だけの写しの行は、した人を人として出さない');
  // 鷹野 の行を 佐藤 に変える（担当者が変わった行）: 佐藤 の本人には、前の中身（鷹野 の入力）を送らない
  const rows = view(E, P).boot.input.product.map((r, i) => Object.assign({}, r, { fromRow: i }, i === 1 ? { person: '佐藤' } : {}));
  const st = save(E, P, 'product', rows);
  assert.equal(st.status, 'DONE', st.error);
  const ch = logOf(E, P).filter((r) => r.change === 'CHANGE');
  assert.deepEqual(ch.map((r) => [r.person, JSON.parse(r.before_json).person, JSON.parse(r.after_json).person]), [['佐藤', '鷹野', '佐藤']]);
  il = view(E, P, MEMBER).inputLog;
  assert.deepEqual(il.rows.product[1].hist[0].change, 'CHANGE', '引き継いだ行は本人の行');
  assert.equal(il.rows.product[1].hist[0].before, null, '前の担当者（鷹野）の中身は送らない');
  assert.ok(il.rows.product[1].hist[0].after && !('person' in il.rows.product[1].hist[0].after));
  assert.equal(view(E, P).inputLog.rows.product[1].hist[0].before.person, '鷹野', '予算策定担当以上には前の中身も');
  // 外す: 本人にも出ない
  const lid = E.table('PERSON_LINKS').find((l) => l.person_name === '佐藤' && l.email === MEMBER).link_id;
  task(E, { action: 'unlinkPerson', linkId: lid });
  il = view(E, P, MEMBER).inputLog;
  assert.ok(Object.values(il.rows).every((list) => list.every((x) => x === null)), '外した後は本人の行も送らない');
  assert.equal(il.hidden, logOf(E, P).length);
  // メーカーのつなぎ: ほかのメーカーのつなぎは効かない。このメーカーのつなぎ（期間なし）は前の保存にも効く
  task(E, { action: 'linkPerson', personName: '佐藤', email: OTHER, clientId: XO });
  assert.ok(Object.values(view(E, P, OTHER).inputLog.rows).every((list) => list.every((x) => x === null)), 'ほかのメーカーのつなぎは効かない');
  task(E, { action: 'linkPerson', personName: '佐藤', email: OTHER, clientId: X });
  il = view(E, P, OTHER).inputLog;
  assert.ok(il.rows.product[0].hist.some((h) => h.change === 'CONF'), '期間のないつなぎは、前の保存にも効く');
}

// ==== S2. 行の出どころ（fromRow）で前と後を組む ====
{
  const E = setUpEnv();
  const fy = E.run('appFy_(new Date())');
  const P = E.seedPlan(inputBook(E, '組み製薬', fy, [['鷹野', '製品A', D(fy, 5), '+5%', 'a'], ['佐藤', '製品B', D(fy, 6), '+3%', 'b']]));
  E.call('apiListPlans()');
  const m = (k) => fy + '-' + String(k).padStart(2, '0');
  // 点検の例: 1 行目を外し、佐藤 の行の月を 6 月から 7 月に変えて、同じ保存
  let n0 = logOf(E, P).length;
  let loaded = view(E, P).boot.input.product;
  let st = save(E, P, 'product', [Object.assign({}, loaded[1], { ym: m(7), fromRow: 1 })]);
  assert.equal(st.status, 'DONE', st.error);
  let add = logOf(E, P).slice(n0);
  assert.deepEqual(add.map((r) => [r.change, r.row_key, r.before_json ? JSON.parse(r.before_json).person + ' ' + JSON.parse(r.before_json).ym : '']).sort(),
    [['CHANGE', 'product|佐藤|製品B|' + m(7), '佐藤 ' + m(6)], ['REMOVE', 'product|鷹野|製品A|' + m(5), '鷹野 ' + m(5)]],
    '佐藤 の行は 佐藤 の前の行から変えた・外したのは 鷹野 の行（取り違えない）');
  const eng = E.table('ENG_PRODUCT').filter((r) => r.plan_id === P);
  assert.equal(eng.length, 1, '旧来の表は 1 行');
  assert.deepEqual([eng[0].Person, eng[0].ProductName], ['佐藤', '製品B']);
  assert.ok(!E.call('APP_TABLES.ENG_PRODUCT.columns').includes('fromRow') && E.scratch().getSheetByName('PRODUCT').getLastColumn() === 5, '出どころは旧来の表に渡さない（5 列のまま）');
  let il = view(E, P).inputLog;
  assert.deepEqual([il.rows.product[0].hist[0].change, il.rows.product[0].hist[0].before.person, il.rows.product[0].hist[0].before.ym], ['CHANGE', '佐藤', m(6)], '跡の前の行も 佐藤');
  // 足した行（出どころなし）・中身の空の行（書かない）・同じ中身の行の 1 行目を外す
  loaded = view(E, P).boot.input.product;
  n0 = logOf(E, P).length;
  const dup = { person: '鷹野', product: '製品C', ym: m(8), step: '+1%', reason: '同じ' };
  st = save(E, P, 'product', [Object.assign({}, loaded[0], { fromRow: 0 }), Object.assign({}, dup), Object.assign({}, dup), { person: '', product: '', ym: '', step: '', reason: '', fromRow: 0 }]);
  assert.equal(st.status, 'DONE', st.error);
  add = logOf(E, P).slice(n0);
  assert.deepEqual(add.map((r) => [r.change, r.row_key]), [['ADD', 'product|鷹野|製品C|' + m(8)], ['ADD', 'product|鷹野|製品C|' + m(8) + '#2']], '出どころの無い行は ADD（中身の空の行は書かない）');
  assert.equal(E.table('ENG_PRODUCT').filter((r) => r.plan_id === P).length, 3);
  loaded = view(E, P).boot.input.product;
  n0 = logOf(E, P).length;
  st = save(E, P, 'product', [Object.assign({}, loaded[0], { fromRow: 0 }), Object.assign({}, loaded[2], { fromRow: 2 })]);   // 同じ中身の 1 行目（2 行目の位置）を外す
  assert.equal(st.status, 'DONE', st.error);
  add = logOf(E, P).slice(n0);
  assert.deepEqual(add.map((r) => [r.change, r.row_key]), [['REMOVE', 'product|鷹野|製品C|' + m(8) + '#2']], '同じ中身の行は見分けない（無くなる印 #2 を外したことにする。CHANGE は足さない）');
  il = view(E, P).inputLog;
  assert.equal(il.rows.product[1].hist[0].change, 'ADD', '残った行の跡は ADD のまま（外した跡を出さない）');
  // 外した行と同じ印に、ほかの行を変えた（同じ保存で外した跡と変えた跡が同じ印）: 残った行の跡は変えた方から、その行自身の前の跡へ
  // （v0.30.0 の最後の点検の直し 3 の H2: 出どころで組んで印を変えた CHANGE は _key で前の印につなぐ。外した行の REMOVE を付けない）
  loaded = view(E, P).boot.input.product;   // [佐藤 製品B 7 月, 鷹野 製品C 8 月]
  n0 = logOf(E, P).length;
  st = save(E, P, 'product', [Object.assign({}, loaded[1], { person: '佐藤', product: '製品B', ym: m(7), step: '+9%', fromRow: 1 })]);
  assert.equal(st.status, 'DONE', st.error);
  add = logOf(E, P).slice(n0);
  assert.deepEqual(add.map((r) => [r.change, r.row_key]).sort(), [['CHANGE', 'product|佐藤|製品B|' + m(7)], ['REMOVE', 'product|佐藤|製品B|' + m(7)]].sort());
  il = view(E, P).inputLog;
  assert.deepEqual(il.rows.product[0].hist.map((h) => h.change), ['CHANGE', 'ADD'], '変えた行の跡は、その行自身の前の跡（鷹野 製品C を足した ADD）。外した行の REMOVE を付けない');
  assert.equal(il.rows.product[0].n, 2);
  assert.equal(il.rows.product[0].hist[0].before.product, '製品C');
  assert.equal(il.rows.product[0].hist[1].after.product, '製品C');
  // 入力のハッシュを確かめない保存は、出どころを使わない（前の画面と同じ組み方: 同じ位置）
  const P2 = E.seedPlan(inputBook(E, '組み製薬二', fy, [['鷹野', '製品A', D(fy, 5), '+5%', 'a'], ['佐藤', '製品B', D(fy, 6), '+3%', 'b']]));
  E.call('apiListPlans()');
  loaded = view(E, P2).boot.input.product;
  n0 = logOf(E, P2).length;
  st = E.runJob('PLAN.EDIT', { planId: P2, action: 'INPUT.SAVE', args: { kind: 'product', rows: [Object.assign({}, loaded[1], { ym: m(7), fromRow: 1 })] } });
  assert.equal(st.status, 'DONE', st.error);
  add = logOf(E, P2).slice(n0);
  assert.deepEqual(add.map((r) => [r.change, r.row_key, r.before_json ? JSON.parse(r.before_json).person : '']).sort(),
    [['CHANGE', 'product|佐藤|製品B|' + m(7), '鷹野'], ['REMOVE', 'product|佐藤|製品B|' + m(6), '佐藤']], 'ハッシュを確かめない保存は、今までの組み方（同じ位置）');
  // 道具: 出どころの読み方
  assert.deepEqual(E.call('[0, 2, "3", -1, 1.5, "x", null, "", true].map(appInputLogFromRow_)'), [0, 2, 3, null, null, null, null, null, null]);
}

// ==== S3. 列を足す移行がバックアップを待っている間 ====
const V9 = {
  PLANS: ['plan_id', 'client_id', 'fy', 'client_label', 'people_csv', 'source_book_id', 'locale', 'time_zone', 'state', 'note',
    'created_at', 'created_by', 'updated_at', 'updated_by', 'row_version'],
  FORECAST_RUNS: ['run_id', 'plan_id', 'status', 'engine_version', 'engine_sha256', 'seed', 'as_of', 'input_hash',
    'annual_p10', 'annual_p50', 'annual_p90', 'objective_p10', 'objective_p50', 'objective_p90',
    'changed_sheets_json', 'confirms_json', 'started_at', 'finished_at', 'actor_email'],
};
const NEW_TABLES = ['INPUT_LOG', 'AI_RESEARCH_LOG', 'LAYER_EFFECTS', 'HIT_RECORDS', 'LEARNING_LOG', 'PERSON_LINKS', 'BACKTEST'];
{
  const env = makeEnv();
  env.run(`__V10 = JSON.parse(JSON.stringify(APP_TABLES));
    JSON.parse(__nt).forEach(n => { delete APP_TABLES[n]; });
    const v9 = JSON.parse(__v9); Object.keys(v9).forEach(n => { APP_TABLES[n].columns = v9[n]; });`, { __nt: JSON.stringify(NEW_TABLES), __v9: JSON.stringify(V9) });
  env.as(OWNER);
  env.call('apiSetup()');
  env.props.APP_TABLES_VERSION = String(env.run('APP_SCHEMA_VERSION'));
  const fy = env.run('appFy_(new Date())');
  const planId = env.seedPlan(inputBook(env, '移行製薬', fy, [['鷹野', '製品A', D(fy, 5), '+5%', 'a']]));
  // 版 10 のコードに戻す。バックアップが取れない（アーカイブのフォルダが無い）
  env.run('Object.keys(__V10).forEach(n => { APP_TABLES[n] = __V10[n]; }); APP_STORE_CACHE_ = {};');
  env.props.APP_TABLES_VERSION = '9';
  const archiveId = env.props.APP_ARCHIVE_FOLDER_ID;
  delete env.props.APP_ARCHIVE_FOLDER_ID;
  const start = (kind, payload) => () => env.call('apiStartJob(__in)', { __in: { kind, payload } });
  assert.throws(start('FORECAST.RUN', { planId }), /表の版 \d+ の移行（列を足す）がまだ済んでいないので、予測の実行は始めません/, '長い計算の前に断る');
  assert.throws(start('PLAN.CREATE', { clientName: '新しい製薬', fy, peopleCsv: '鷹野' }), /計画の作成は始めません/);
  assert.throws(start('PLAN.EDIT', { planId, action: 'SETUP.PEOPLE', args: { peopleCsv: '鷹野,佐藤' }, inputHash: 'x' }), /担当者の保存は始めません/);
  assert.equal(env.props.APP_TABLES_VERSION, '9', '前提: 移行はまだ');
  assert.equal(env.call('appJournalPending_()'), null, '書きかけの控えを残さない');
  assert.equal(env.call(`appV10WaitRefusal_('PLAN.EDIT', { action: 'INPUT.SAVE' })`), '', '入力の保存は断らない（列を足す前の表に書かない）');
  // 控えを置く前に、書く表を確かめる（列を足す前の表に書く控えは、何も書かずに止める）
  const acts0 = env.table('PLAN_ACTIONS').length;
  assert.throws(() => env.run(`appWithLock_(() => appJournalRun_(${CTX}, 'テスト', '${planId}', [
    { table: 'PLAN_ACTIONS', mode: 'ensure', rows: [{ action_id: 'ACT-T1', plan_id: '${planId}', action: 'TEST', status: 'DONE' }] },
    { table: 'FORECAST_RUNS', mode: 'ensure', rows: [{ run_id: 'RUN-T1', plan_id: '${planId}', status: 'DONE' }] }]))`), /表の列を足す移行がまだです（FORECAST_RUNS）/);
  assert.equal(env.table('PLAN_ACTIONS').length, acts0, '先の表（PLAN_ACTIONS）も書かない');
  assert.equal(env.call('appJournalPending_()'), null, '控えも置かない（ほかの人の保存を止めない）');
  // ほかの人の入力の保存は、そのあいだも通る
  const v = env.call('apiPlanView(__in)', { __in: { planId } });
  const st = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind: 'product', rows: v.boot.input.product.map((r) => Object.assign({}, r, { reason: 'b' })) }, inputHash: v.inputHash });
  assert.equal(st.status, 'DONE', st.error);
  // 状態の点検: 足す 7 つの表は、移行の後に次の操作で作る
  const h = env.call('apiHealth()');
  assert.deepEqual(h.tables.filter((t) => t.pending).map((t) => t.name), ['PLANS', 'FORECAST_RUNS']);
  const missing = h.tables.filter((t) => t.missing);
  assert.deepEqual(missing.map((t) => t.name), NEW_TABLES);
  assert.ok(missing.every((t) => t.note === '未作成（列を足す移行の後に作る。移行の前のバックアップが取れたら、次の操作で作られます）'), missing.map((t) => t.note).join(' / '));
  // バックアップが取れるようになったら移し、断らなくなる
  env.props.APP_ARCHIVE_FOLDER_ID = archiveId;
  delete env.props.APP_MIGRATE_BACKUP_FAILED_AT;
  env.call('apiListPlans()');
  assert.equal(env.props.APP_TABLES_VERSION, String(env.run('APP_SCHEMA_VERSION')));
  assert.equal(env.call(`appV10WaitRefusal_('FORECAST.RUN', {})`), '');
  assert.deepEqual(env.call('apiHealth()').tables.filter((t) => !t.ok).map((t) => t.name), []);
}

// ==== S4-a. 入力の記録の写し: 書きかけの保存を先に書き終えてから読む・記録のある行には足さない・した人は仕組み ====
{
  const E = setUpEnv();
  const fy = E.run('appFy_(new Date())');
  E.props.APP_BACKFILLS = JSON.stringify({ done: { appV10BackfillInputLog_: { at: 'x', v: 10, rows: 0 } }, failed: {} });   // 写しを止めておく
  const P = E.seedPlan(inputBook(E, '写し製薬', fy, [['鷹野', '製品A', D(fy, 5), '+5%', '新規'], ['佐藤', '製品B', D(fy, 6), '-3%', '全体']]));
  members(E, [[MEMBER, 'メンバー']]);
  const v = view(E, P);
  E.data().getSheetByName('ENG_PRODUCT').failWrites = true;
  const st = save(E, P, 'product', v.boot.input.product.map((r, i) => Object.assign({}, r, { fromRow: i }, i === 0 ? { step: '+9%', selfConf: '高い' } : {})));
  E.data().getSheetByName('ENG_PRODUCT').failWrites = false;
  assert.equal(st.status, 'FAILED', '前提: 本体を書く途中で止まった');
  assert.ok(E.call('appJournalPending_()'), '前提: 書きかけの控え');
  E.props.APP_BACKFILLS = JSON.stringify({ done: {}, failed: {} });
  as(E, MEMBER, () => { try { E.call('apiListPlans()'); } catch (e) { /* 一覧を読めなくても、写しは操作の初めに動く */ } });   // 閲覧の人の操作が最初
  assert.equal(E.call('appJournalPending_()'), null, '写しが先に書き終えた');
  assert.ok(JSON.parse(E.props.APP_BACKFILLS).done.appV10BackfillInputLog_, '写しは済んだ');
  const log = logOf(E, P);
  const key0 = 'product|鷹野|製品A|' + v.boot.input.product[0].ym, key1 = 'product|佐藤|製品B|' + v.boot.input.product[1].ym;
  assert.deepEqual(log.map((r) => [r.change, r.row_key, r.self_conf]).sort(), [['BASELINE', key1, ''], ['CHANGE', key0, '高い']], '記録のある行には BASELINE を足さない（保存の自信を隠さない）');
  assert.ok(log.filter((r) => r.change === 'BASELINE').every((r) => r.actor_email === SYS), 'した人は仕組み（閲覧の人ではない）');
  assert.equal(E.table('ENG_PRODUCT').filter((r) => r.plan_id === P)[0]['Step(増減率%)'], '+9%');
  const il = view(E, P).inputLog;
  assert.deepEqual([il.rows.product[0].conf, il.rows.product[0].hist[0].change], ['高い', 'CHANGE'], '画面の自信は保存したまま');
  assert.deepEqual([il.rows.product[1].hist[0].change, il.rows.product[1].hist[0].by], ['BASELINE', ''], '写しの行に人の名前を出さない');
  assert.doesNotMatch(JSON.stringify(il), /SYSTEM|member@/);
}

// ==== S4-b. AI 調査の記録の写し: 書きかけの保存を先に書き終えてから読む・BASELINE のある計画は飛ばす ====
{
  const E = setUpEnv();
  const fy = E.run('appFy_(new Date())');
  const head = H.AI_RESEARCH_STRUCTURED;
  const ai = (topic, score) => head.map((h) => ({ client: '調査製薬', as_of_date: D(fy, 9, 1), topic, row_type: 'event', direction: 'up', impact_score: score, confidence: 0.5,
    evidence: '根拠', time_horizon: '3M', event_score: score, benchmark_score: '', blended_score: score })[h] ?? '');
  const P = E.seedPlan(inputBook(E, '調査製薬', fy, [], { AI_RESEARCH_STRUCTURED: { values: [head, ai('market', 10), ai('competitor', -5)] } }));
  const eng = () => E.table('ENG_AI_RESEARCH_STRUCTURED').filter((r) => r.plan_id === P);
  assert.equal(eng().length, 2);
  // 書きかけの控え（AI_RESEARCH_STRUCTURED に 1 行足す保存が途中で止まった）
  const extra = Object.assign({}, eng()[0], { seq: '9', topic: 'channel' });
  E.data().getSheetByName('ENG_AI_RESEARCH_STRUCTURED').failWrites = true;
  assert.throws(() => E.call(`appWithLock_(() => appJournalRun_(${CTX}, 'テスト', __p, [{ table: 'ENG_AI_RESEARCH_STRUCTURED', mode: 'ensure', rows: [__r] }]))`, { __p: P, __r: extra }));
  E.data().getSheetByName('ENG_AI_RESEARCH_STRUCTURED').failWrites = false;
  assert.ok(E.call('appJournalPending_()'));
  const r1 = E.call(`appAiResearchBackfill_(${CTX})`);
  assert.equal(E.call('appJournalPending_()'), null, '先に書き終えた');
  const base = () => E.table('AI_RESEARCH_LOG').filter((r) => r.plan_id === P && r.action_id === 'BASELINE');
  assert.deepEqual([r1.rows, base().length], [3, 3], '書き終えた後の 3 行を写す');
  // 写しの控えが消えて、もう一度動いても: BASELINE のある計画は飛ばす（後の A-4 で増えた行を BASELINE として足さない）
  E.call(`appWithLock_(() => appJournalRun_(${CTX}, 'テスト', __p, [{ table: 'ENG_AI_RESEARCH_STRUCTURED', mode: 'ensure', rows: [__r] }]))`,
    { __p: P, __r: Object.assign({}, eng()[0], { seq: '10', topic: 'dx' }) });
  assert.deepEqual(E.call(`appAiResearchBackfill_(${CTX})`), { rows: 0 });
  assert.equal(base().length, 3, '増やさない');
}

// ==== S4-c. 写しの済みの控えは、ほかの操作が先に書いた「済み」を消さない ====
{
  const E = setUpEnv();
  E.run(`__keep = [appV10BackfillInputLog_, appV10BackfillAiResearchLog_, appV10BackfillHitRecords_];
    appV10BackfillInputLog_ = function (ctx) {
      // この写しの間に、ほかの操作が 3 つとも済ませた（その操作の控え）
      const at = { at: '2026-10-08T10:00:00+0900', v: 10, rows: 1 };
      PropertiesService.getScriptProperties().setProperty('APP_BACKFILLS', JSON.stringify({ done: { appV10BackfillInputLog_: at, appV10BackfillAiResearchLog_: at, appV10BackfillHitRecords_: at }, failed: {} }));
      return { more: true, rows: 0 };
    };
    appV10BackfillAiResearchLog_ = function () { throw new Error('Lock timeout'); };
    appV10BackfillHitRecords_ = function () { return { rows: 0 }; };
    appBackfillNames_ = function () { return APP_V10_BACKFILLS.slice(); };`);   // ここでは版 10 の写しの控えだけを見る（版 11 の写しは app-v11-drafts-migrate.test.mjs）
  E.props.APP_BACKFILLS = JSON.stringify({ done: {}, failed: {} });
  E.run(`appRunBackfills_(${CTX})`);
  const stt = JSON.parse(E.props.APP_BACKFILLS);
  assert.deepEqual(Object.keys(stt.done).sort(), ['appV10BackfillAiResearchLog_', 'appV10BackfillHitRecords_', 'appV10BackfillInputLog_'], '済みの印を消さない');
  assert.deepEqual(stt.failed, {}, '済んだ写しの失敗は書かない');
  assert.equal(stt.done.appV10BackfillAiResearchLog_.rows, 1, 'ほかの操作の控えのまま');
  // 済んでいない写しの失敗は残す（10 分あけてやり直す）
  E.props.APP_BACKFILLS = JSON.stringify({ done: {}, failed: {} });
  E.run('appV10BackfillInputLog_ = function () { return { rows: 2 }; };');
  E.run(`appRunBackfills_(${CTX})`);
  const st2 = JSON.parse(E.props.APP_BACKFILLS);
  assert.deepEqual([Object.keys(st2.done).sort(), Object.keys(st2.failed)], [['appV10BackfillHitRecords_', 'appV10BackfillInputLog_'], ['appV10BackfillAiResearchLog_']]);
  E.run('appV10BackfillInputLog_ = __keep[0]; appV10BackfillAiResearchLog_ = __keep[1]; appV10BackfillHitRecords_ = __keep[2];');
}

// ==== S4-d. 当たりの記録の写しの computed_by は仕組み ====
{
  const E = setUpEnv();
  const P = E.seedPlan(planBook(E, { evaluated: true }));
  members(E, [[MEMBER, 'メンバー']]);
  as(E, MEMBER, () => { try { E.call('apiListPlans()'); } catch (e) { /* 写しは操作の初めに動く */ } });
  const rows = E.table('HIT_RECORDS').filter((r) => r.plan_id === P);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.computed_by === SYS && r.calc_version === 'HIT-V1+BACKFILL'), '写しを動かした閲覧の人ではない');
}

// ==== S5. 学びの記録の evidence_n: 分からない件数は空（0 にしない）。列のハッシュは変わらない ====
{
  const E = setUpEnv();
  const base = { plan_id: '', proposal_id: 'P-1', event: 'PROPOSE', origin: 'QUARTERLY', target: 'bias_correction_factor', current_value: '1', proposed_value: '1.1',
    decision: '', applied_value: '', review_quarter: 'FY2026-Q1', note: '', actor_email: OWNER, at: '2026-10-08T10:00:00+0900' };
  E.call(`appWithLock_(() => appJournalRun_(${CTX}, 'テスト', '', appLogOps_('LEARNING_LOG', [Object.assign({ learn_id: 'LRN-T1', evidence_n: null }, __b),
    Object.assign({ learn_id: 'LRN-T2', evidence_n: 12 }, __b), Object.assign({ learn_id: 'LRN-T3', evidence_n: 0 }, __b)])))`, { __b: base });
  const raw = E.data().getSheetByName('LEARNING_LOG').rows;
  const col = raw[0].indexOf('evidence_n');
  assert.deepEqual(raw.slice(1, 4).map((r) => r[col]), ['', '12', '0'], '分からない件数は空のセル');
  assert.deepEqual(E.call('appReadTable_("LEARNING_LOG").map(r => r.evidence_n)'), [null, 12, 0], '読むと null（0 と区別できる）');
  assert.equal(E.call('appColumnType_("evidence_n", APP_TABLES.LEARNING_LOG)'), 'num');
  const cols = E.call('APP_TABLES.LEARNING_LOG.columns');
  assert.equal(E.call('appColumnsHash_("LEARNING_LOG")'), createHash('sha256').update(cols.join('|'), 'utf8').digest('hex'), '列のハッシュは列の名前だけ（型は入らない）');
  assert.equal(E.table('_SCHEMA').find((r) => r.table === 'LEARNING_LOG').columns_hash, E.call('appColumnsHash_("LEARNING_LOG")'), '_SCHEMA と一致（移行は要らない）');
  assert.ok(E.call('apiHealth()').tables.find((t) => t.name === 'LEARNING_LOG').ok);
}

// ==== S6. 年度を締める条件: 実績が足りない月のある印では締めない ====
{
  const E = setUpEnv();
  const fy = E.run('appFy_(new Date())') - 1;
  E.run('appV10BackfillHitRecords_ = function () { return { skipped: true }; };');
  const done = [H.PROCESS_STATUS, ['step2_status', jst(fy + 1, 4, 6, 9), 'owner', 'success', 'x', 10, ''], ['step5_status', jst(fy + 1, 4, 6, 10), 'owner', 'success', 'x', 10, '']];
  const output = [['FY' + fy + ' 売上予測']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 900, 1000, 1100], [], []);
  for (let i = 0; i < 12; i++) output.push([new Date(fy, 3 + i, 1), 70, 80, 90, '', '', '', 80, '']);
  const P = E.seedPlan(E.makeBook('甲製薬', { CONFIG: CONFIG('甲製薬', fy), OUTPUT: { values: output }, PROCESS_STATUS: { values: done } }));
  const sub = E.call('apiVersionSubmit(__in)', { __in: { planId: P } });
  E.call('apiVersionDecide(__in)', { __in: { versionId: sub.version.versionId, decision: 'APPROVED', rowVersion: sub.version.rowVersion } });
  const months = E.call('appHitQuarterMonths_(__q)', { __q: 'FY' + fy + '-Q4' });
  const marker = (n, miss) => ({ plan_id: P, client_id: E.table('PLANS').find((p) => p.plan_id === P).client_id, quarter: 'FY' + fy + '-Q4', source_kind: 'QUARTER', source_key: '',
    person_email: '', months_json: months.map((ym, i) => (miss[i] ? { ym, run: miss[i] === 'forecast' ? '' : 'R', miss: miss[i] } : { ym, run: 'R' })), push: null, actual_dir: n === 3 ? 1 : null, hit: null, n_months: n });
  const write = (r) => E.call(`appWithLock_(() => appJournalRun_(${CTX}, 'テスト', __p, appHitOps_(${CTX}, appPlanOf_(__p), [__r], 'HIT-V1+BACKFILL', 'SYSTEM:V10_BACKFILL')))`, { __p: P, __r: r });
  // 前の版の検証の行しか無いときの移行の印（n_months 0・3 か月とも実績が足りない）
  write(marker(0, ['actual', 'actual', 'actual']));
  let pv = E.call('apiYearPreview(__in)', { __in: { fy } });
  assert.equal(pv.canClose, false, '実績が足りない月のある印では締めない');
  assert.match(pv.reason, /1〜3 月の当たりをまだ数えていない計画があります（甲製薬）/);
  // 今の版の B-2 で数えた: 1 月は採点、2・3 月は月が始まる前の予測の回が無い（採点するものが無い）
  write(marker(1, [null, 'forecast', 'forecast']));
  pv = E.call('apiYearPreview(__in)', { __in: { fy } });
  assert.equal(pv.canClose, true, pv.reason);
  // 道具
  const counted = (r) => E.call('appHitQuarterCounted_(__r)', { __r: r });
  assert.deepEqual([counted({ n_months: 3, months_json: '[]' }), counted({ n_months: 0, months_json: JSON.stringify([{ miss: 'forecast' }, { miss: 'forecast' }, { miss: 'forecast' }]) }),
    counted({ n_months: 2, months_json: JSON.stringify([{}, {}, { miss: 'actual' }]) }), counted({ n_months: 0, months_json: 'x' }), counted({ n_months: 0, months_json: '[]' })],
    [true, true, false, false, false]);
}

// ==== S7. 物差しのまとめは、区切りが計画の年度の初めの回だけ ====
{
  const E = setUpEnv();
  const fy = E.run('appFy_(new Date())');
  const PA = E.seedPlan(inputBook(E, '甲製薬', fy, []));
  const PB = E.seedPlan(inputBook(E, '乙製薬', fy, []));
  const yms = Array.from({ length: 12 }, (_, i) => { const mo = 4 + i; return (mo > 12 ? fy + 1 : fy) + '/' + String(mo > 12 ? mo - 12 : mo).padStart(2, '0'); });
  const VER = E.run('APP_BACKTEST_CALC_VERSION');   // 今の数え方の回（前の数え方の回はまとめに入れない。Backtest.js の appBacktestCard_）
  const run = (planId, btId, cutFy, counted, at) => ['STAT_ONLY', 'LIVE', 'LAST_YEAR', 'TWO_YEAR', 'SEASONAL'].flatMap((m) => yms.map((ym, i) => ({ plan_id: planId,
    point_id: btId + '-' + m + '-' + i, bt_id: btId, cutoff_ym: cutFy + '/04', target_ym: ym, horizon: i + 1, method: m, p10: m === 'STAT_ONLY' ? 80 : null, p50: 100 + i, p90: m === 'STAT_ONLY' ? 120 : null,
    actual: 110, real_months: counted ? 48 : 36, counted, engine_sha256: 'e', seed: 's', calc_version: VER, computed_at: at, computed_by: OWNER })));
  const put = (rows) => E.call(`appWithLock_(() => appJournalRun_(${CTX}, 'テスト', __p, appLogOps_('BACKTEST', __r)))`, { __p: rows[0].plan_id, __r: rows });
  put(run(PA, 'BT-A-NOW', fy, true, '2026-10-01T10:00:00+0900'));
  let card = E.call('appBacktestCard_(__f)', { __f: fy });
  assert.deepEqual([card.plans, card.points, card.olderRuns], [1, 12, 0]);
  // 後から前の年度を区切りにした回（数えられる点が無い）: 新しくても、数える回を隠さない
  put(run(PA, 'BT-A-OLD', fy - 1, false, '2026-10-05T10:00:00+0900'));
  card = E.call('appBacktestCard_(__f)', { __f: fy });
  assert.deepEqual([card.plans, card.points, card.olderRuns, card.at], [1, 12, 1, '2026-10-01T10:00:00+0900'], '前の年度を区切りにした回は数えない（数えていない回の数だけ）');
  // 前の年度を区切りにした回しか無い計画は、物差しのある計画に数えない
  put(run(PB, 'BT-B-OLD', fy - 2, false, '2026-10-06T10:00:00+0900'));
  card = E.call('appBacktestCard_(__f)', { __f: fy });
  assert.deepEqual([card.plans, card.points, card.makers, card.olderRuns], [1, 12, 1, 2]);
  assert.equal(E.call('appBacktestCard_(__f)', { __f: fy + 1 }), null, '計画の無い年度は null');
}

// ==== S8. 文書 ====
{
  const readme = await readFile(path.join(appDir, 'README.md'), 'utf8');
  const plan = await readFile(path.join(appDir, 'SCHEMA_PLAN_v10-12_JA.md'), 'utf8');
  assert.match(readme, /## 表の版 10（[^）]*v0\.30\.0・@66 公開）/, 'README: 版 10 は @66 で公開した');
  assert.match(readme, /空の `seed_rule` は、`seed` で読み分けます: 64 文字の 16 進なら `INPUT_V1`（v0\.29\.0・@65 の回）、`RUN-…` なら実行ごとの種（v0\.28\.0 まで）/);
  assert.match(readme, /公開した後の最初の予測は、数字が少し動きます[^\n]*`APP_VERSION`[^\n]*−0\.56%/);
  assert.match(plan, /^- 日付: 2026-10-08。\*\*版 10 は作りました\*\*（v0\.30\.0/m, 'SCHEMA_PLAN: 状態の行');
  assert.doesNotMatch(plan, /まだ作っていません/);
  assert.match(plan, /空 = 版 10 より前の回: `seed` が 64 文字の 16 進なら INPUT_V1＝v0\.29\.0・@65、`RUN-…` なら実行ごとの種＝v0\.28\.0 まで/);
  assert.doesNotMatch(plan + readme, /空の `seed_rule` は「?実行ごとの種」?(と読みます|）です)/, '前の読み方（空 = 実行ごとの種だけ）を残さない');
}

console.log('app-v10-fixes-srv: ok');
