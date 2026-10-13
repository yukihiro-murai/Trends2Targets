#!/usr/bin/env node
/*
 * app-v10-fix2-srv.test.mjs — 版 10（v0.30.0）の最後の点検で見つかったことの直し（サーバー側）を確かめる。
 *   G1. 年度を締める条件: 1〜3 月に売上の記録が無い月がある予算の計画でも、今の版の B-2 の後なら締められる
 *       （B-2 の後に測った行の無い月は miss 'none' = 採点するものが無い）。移行の写しの印（'actual'）は、まだ測っていないので締めない。
 *       同じ月の数でも、B-2 の印は移行の印と番号が重ならずに足される。B-1 の後に B-2 がまだなら、'none' の印では締めない
 *   G2. 今の画面の保存（fromRows: true）は、行に fromRow が 1 つも無くても出どころで組む: 全部の行を外して足すと REMOVE と ADD
 *       （CHANGE にしない・外した行の自信を足した行に付けない）。fromRows の無い保存（前の画面）は今までどおり。旧来には渡さない
 *   G3. 同じ印の組（#2・#3…）の行を外しても、下の行は自分の自信と跡のまま（#n だけ変わった行は、前の印から引き継ぐ。ほかの行の跡を付けない）。
 *       見分けられない行（中身も跡も同じ）は記録を足さない。付け直しだけの記録は画面の跡に出さない
 *   G4. 自信は、選び直した行だけ送る（送らない行は今の自信のまま）: 古い画面の A がほかの欄を直して保存しても、B が変えた自信は残る
 *       （同じ印の組の上の行を A が外しても、B の自信はその行についていく）
 * 名前と数字はテスト用の架空のもの。モックの上の確かめで、本物の Apps Script の上では動かしていない。
 *
 *   node app/tests/app-v10-fix2-srv.test.mjs
 */
import assert from 'node:assert/strict';
import { setUpEnv, OWNER, MEMBER, OTHER } from './gas-mock.mjs';

const jst = (y, m, d, H = 0, M = 0) => new Date(Date.UTC(y, m - 1, d, H - 9, M));
const D = (y, m, d = 1) => new Date(y, m - 1, d);
const CTX = `{ actor: '${OWNER}', requestId: 'T' }`;
const env0 = setUpEnv();
const H = env0.run('(() => { const o = {}; Object.keys(APP_ENGINE_SHEETS).forEach(k => { o[k] = APP_ENGINE_SHEETS[k].header || null; }); return o; })()');
const row = (sheet, o) => H[sheet].map((h) => (o[h] === undefined ? '' : o[h]));
const POLICY = env0.run('APP_EVAL_POLICY_VERSION');

// ---- G1 の見本: 前の年度の予算の計画。4/10 に取り込み（全部の月が締まった）。2 月だけ売上の記録が無い ----
const CLIENT = 'テスト製薬';
const FYP = env0.run('appFy_(new Date())') - 1;
const MONTHS = Array.from({ length: 12 }, (_, i) => { const m = 4 + i; return (m > 12 ? FYP + 1 : FYP) + '/' + String(m > 12 ? m - 12 : m).padStart(2, '0'); });
const Q4 = MONTHS.slice(9);
const FEB = (FYP + 1) + '/02';
const RUNS = { R0: jst(FYP, 3, 20, 10), R3: jst(FYP, 12, 19, 10) };   // R0: 4〜12 月の前の最後の回、R3: 1〜3 月の前の最後の回
const QUANT = { R0: 1100, R3: 900 };
const MONTHS_OF = { R0: MONTHS, R3: Q4 };
const IMPORTED = jst(FYP + 1, 4, 10, 9);

/** evaluated = 前に今の版の B-2 が測った後の形（売上のある月だけに EVAL_LOG の行。B-2 の成功が B-1 より新しい） */
function yearBook(env, { evaluated = false, skip = [FEB] } = {}) {
  const act = {};
  MONTHS.forEach((ym) => { if (skip.indexOf(ym) < 0) act[ym] = 1000; });
  const snap = [H.FORECAST_SNAPSHOT];
  Object.keys(RUNS).forEach((id) => MONTHS_OF[id].forEach((ym) => ['nega', 'neutral', 'posi'].forEach((sc, i) => {
    const p50 = QUANT[id] + 50;
    snap.push([id, RUNS[id], CLIENT, ym, sc, p50, 0, 0, 0, p50 * [0.9, 1, 1.1][i], p50 * 0.9, p50 * 1.1, JSON.stringify({ opinion: '', forecast_source: 'forecast_open' }), '',
      JSON.stringify({ version: 'test', bias_correction_factor: 1, residual_month_bias_json: '' })]);
  })));
  const actual = [H.ACTUAL_EVAL_MONTHLY].concat(Object.keys(act).map((ym) => [CLIENT, 'BASE', '製品A', ym, act[ym], 'closed', IMPORTED]));
  const evalLog = [H.EVAL_LOG];
  if (evaluated) Object.keys(act).forEach((ym) => ['nega', 'neutral', 'posi'].forEach((sc, i) => {
    const pre = Q4.indexOf(ym) >= 0 ? 'R3' : 'R0';
    evalLog.push(row('EVAL_LOG', { eval_id: 'E-' + ym + sc, evaluated_at: jst(FYP + 1, 4, 11, 10), client: CLIENT, target_month: ym, scenario: sc,
      pred: (QUANT[pre] + 50) * [0.9, 1, 1.1][i], actual: act[ym], evaluation_policy_version: POLICY, constraint_relevant_flag: sc === 'neutral' ? 1 : 0 }));
  }));
  const impact = [H.AI_IMPACT_HISTORY];
  Object.keys(RUNS).forEach((id) => MONTHS_OF[id].forEach((ym) => impact.push(row('AI_IMPACT_HISTORY', { run_id: id, run_at: RUNS[id], client: CLIENT, target_month: ym,
    k_ai: 1.02, ai_direction: 'up', pred_p50: QUANT[id] + 50, pred_p50_quant_only: QUANT[id], forecast_source: 'forecast_open' }))));
  const subj = [H.SUBJECTIVE_IMPACT_HISTORY].concat(Q4.map((ym) => row('SUBJECTIVE_IMPACT_HISTORY', { run_id: 'R3', run_at: RUNS.R3, client: CLIENT,
    target_month: ym, source_type: 'opinion', source_key: '鷹野', push_step: 0.05, push_direction: 1, applied_reliability_r: 1, forecast_source: 'forecast_open' })));
  const status = [H.PROCESS_STATUS, ['step2_status', IMPORTED, 'owner', 'success', CLIENT, 10, ''], ['step4_status', RUNS.R3, 'owner', 'success', CLIENT, 12, '']]
    .concat(evaluated ? [['step5_status', jst(FYP + 1, 4, 11, 10), 'owner', 'success', '', 30, '']] : []);
  const output = [['FY' + FYP + ' 売上予測']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 900, 1000, 1100], [], []);
  for (let i = 0; i < 12; i++) output.push([new Date(FYP, 3 + i, 1), 70, 80, 90, '', '', '', 80, '']);
  return env.makeBook('クライアント別売上予測', {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', CLIENT], ['[必須] 予測年度FY（YYYY）', FYP], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    OUTPUT: { values: output },
    PROCESS_STATUS: { values: status }, RUN_LOG: { values: [H.RUN_LOG] },
    ACTUAL_EVAL_MONTHLY: { values: actual, formats: { D: '@' } }, FORECAST_SNAPSHOT: { values: snap, formats: { D: '@' } },
    EVAL_LOG: { values: evalLog, formats: { D: '@' } }, EVAL_COMPARE_MONTHLY: { values: [H.EVAL_COMPARE_MONTHLY], cols: 40 },
    EVAL_INSIGHTS: { values: [H.EVAL_INSIGHTS], formats: { C: '@' } }, DASHBOARD: { values: [H.DASHBOARD] },
    AI_IMPACT_HISTORY: { values: impact }, SUBJECTIVE_IMPACT_HISTORY: { values: subj }, AI_SCORE_HISTORY: { values: [H.AI_SCORE_HISTORY] },
    CALIBRATION_STATE: { values: [H.CALIBRATION_STATE, [CLIENT, jst(FYP, 10, 2), 'auto', '', '', '[]', 1, '', '', '', '', 1, '']] },
    CALIBRATION_HISTORY: { values: [H.CALIBRATION_HISTORY] }, SOURCE_RELIABILITY: { values: [H.SOURCE_RELIABILITY] }, POOL_PRIOR: { values: [H.POOL_PRIOR] },
    QUARTERLY_REVIEW: { values: [['']] }, QUARTERLY_REVIEW_LOG: { values: [H.QUARTERLY_REVIEW_LOG] }, RELIABILITY_EVIDENCE: { values: [H.RELIABILITY_EVIDENCE] },
  });
}
const b2 = (env, planId) => { const st = env.runJob('PLAN.RUN', { planId, action: 'EVAL.REPORT' }); assert.equal(st.status, 'DONE', st.error); };
const approve = (env, planId) => {
  const sub = env.call('apiVersionSubmit(__in)', { __in: { planId } });
  env.call('apiVersionDecide(__in)', { __in: { versionId: sub.version.versionId, decision: 'APPROVED', rowVersion: sub.version.rowVersion } });
};
const preview = (env) => env.task('yearPreview(__in)', { __in: { fy: FYP } });
const q4Markers = (env, planId) => env.table('HIT_RECORDS').filter((r) => r.plan_id === planId && r.source_kind === 'QUARTER' && r.quarter === 'FY' + FYP + '-Q4');
const misses = (r) => JSON.parse(r.months_json).map((m) => m.miss || '-');
const PENDING = /FY\d{4} の 1〜3 月の当たりをまだ数えていない計画があります（テスト製薬）/;

// ==== G1-a. 2 月に売上の記録が無い → 今の版の B-2 → 締められる ====
{
  const E = setUpEnv();
  const P = E.seedPlan(yearBook(E));
  E.call('apiListPlans()');   // 移行の写し（B-2 の成功が無いので、締まった月の無い計画として飛ばす）
  approve(E, P);
  let pv = preview(E);
  assert.equal(pv.canClose, false, '前提: B-2 の前は締めない');
  assert.match(pv.reason, PENDING);
  b2(E, P);
  const evalMonths = [...new Set(E.call('appEngTableObjects_(__p, ["EVAL_LOG"]).EVAL_LOG', { __p: P }).filter((r) => r.scenario === 'neutral').map((r) => String(r.target_month)))];
  assert.ok(!evalMonths.includes(FEB) && evalMonths.length === 11, '前提: 旧来の B-2 は売上の記録が無い月を測らない: ' + evalMonths.join(' '));
  const m = q4Markers(E, P);
  assert.deepEqual(m.map((r) => [Number(r.n_months), misses(r), r.calc_version]), [[2, ['-', 'none', '-'], 'HIT-V1']], '売上の記録が無い月は none（採点するものが無い）');
  pv = preview(E);
  assert.equal(pv.canClose, true, '今の版の B-2 の後なら締められる: ' + pv.reason);
  const n = E.table('HIT_RECORDS').length;
  b2(E, P);
  assert.equal(E.table('HIT_RECORDS').length, n, 'B-2 をもう一度動かしても増えない');
  // B-1 の後に B-2 がまだ（後から売上が入ったかもしれない）: none の印では締めない。B-2 を動かせば締められる
  const sh = E.data().getSheetByName('ENG_PROCESS_STATUS');
  const col = sh.rows[0].indexOf('last_run_date'), key = sh.rows[0].indexOf('step_key');
  const s5 = sh.rows.find((r) => r[0] === P && r[key] === 'step5_status');
  sh.rows.find((r) => r[0] === P && r[key] === 'step2_status')[col] = new Date(Date.parse(s5[col]) + 1).toISOString();
  E.run('APP_STORE_CACHE_ = {}; appBumpGen_();');
  pv = preview(E);
  assert.equal(pv.canClose, false, 'B-2 待ちの計画の none の印では締めない');
  assert.match(pv.reason, PENDING);
  b2(E, P);
  pv = preview(E);
  assert.equal(pv.canClose, true, 'B-2 の後は締められる: ' + pv.reason);
  // 道具
  const counted = (r, pending) => E.call('appHitQuarterCounted_(__r, __b)', { __r: r, __b: pending });
  const none = { n_months: 2, months_json: JSON.stringify([{ ym: Q4[0] }, { ym: FEB, miss: 'none' }, { ym: Q4[2] }]) };
  assert.deepEqual([counted(none, false), counted(none, true), counted({ n_months: 3, months_json: '[]' }, true),
    counted({ n_months: 0, months_json: JSON.stringify(Q4.map((ym) => ({ ym, miss: 'forecast' }))) }, true),
    counted({ n_months: 2, months_json: JSON.stringify([{}, { miss: 'actual' }, {}]) }, false)], [true, false, true, true, false]);
}

// ==== G1-b. 移行の写しの印（まだ測っていない月）は締めない。同じ月の数でも B-2 の印を足して締められる ====
{
  const E = setUpEnv();
  const P = E.seedPlan(yearBook(E, { evaluated: true }));
  E.call('apiListPlans()');   // 移行の写し: データ本体の検証の行から作る（2 月は、売上が無いのか、まだ測っていないのか分からない）
  approve(E, P);
  const bf = q4Markers(E, P);
  assert.deepEqual(bf.map((r) => [Number(r.n_months), misses(r), r.calc_version]), [[2, ['-', 'actual', '-'], 'HIT-V1+BACKFILL']], '移行の写しは actual（まだ測っていないかもしれない）');
  let pv = preview(E);
  assert.equal(pv.canClose, false, '移行の写しの印（まだ測っていない月）では締めない');
  assert.match(pv.reason, PENDING);
  b2(E, P);
  const m = q4Markers(E, P);
  assert.equal(m.length, 2, '前の印は残し（消さない）、B-2 の印を足す（同じ月の数でも番号が重ならない）');
  const mine = m.find((r) => r.calc_version === 'HIT-V1');
  assert.deepEqual([Number(mine.n_months), misses(mine)], [2, ['-', 'none', '-']]);
  assert.notEqual(mine.hit_id, bf[0].hit_id);
  assert.equal(bf[0].hit_id, E.call('appStableLogId_("HIT", [__p, "QUARTER", "", __q, "HIT-V1", "PARTIAL:2"])', { __p: P, __q: 'FY' + FYP + '-Q4' }), 'none の無い印の番号は前と同じ');
  assert.equal(mine.hit_id, E.call('appStableLogId_("HIT", [__p, "QUARTER", "", __q, "HIT-V1", "PARTIAL:2", "NONE:" + __m])', { __p: P, __q: 'FY' + FYP + '-Q4', __m: FEB }));
  assert.match(E.call('appHitId_({ plan_id: "p", source_kind: "QUARTER", source_key: "", quarter: "FY2025-Q4", n_months: 0, months_json: "x" })'), /^HIT-/, '読めない months_json でも止まらない');
  pv = preview(E);
  assert.equal(pv.canClose, true, pv.reason);
  assert.equal(E.runJob('YEAR.CLOSE', { fy: FYP, inputHash: pv.inputHash }).status, 'DONE');
}

// ---- G2〜G4 の見本: 入力の行のある今年度の計画 ----
const FYC = env0.run('appFy_(new Date())');
const ym = (k) => FYC + '-' + String(k).padStart(2, '0');
function inputBook(env, client, { product = [], client: cl = [] } = {}) {
  const output = [['FY' + FYC + ' 売上予測（' + client + '）']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 900, 1000, 1100], [], []);
  for (let i = 0; i < 12; i++) output.push([D(FYC, 4 + i, 1), 70, 80, 90, '', '', '', 80, '']);
  return env.makeBook(client, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', FYC], ['[必須] 担当者（カンマ区切り）', '鷹野,佐藤']] },
    OUTPUT: { values: output },
    PRODUCT: { values: [['Person', 'ProductName', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']].concat(product) },
    CLIENT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']].concat(cl) },
    OPINIONS: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Confidence(0..1)', 'Note']] },
    DEV_SPOT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Project', 'Amount(JPY)', 'Confidence(0..1)']] },
  });
}
const view = (env, planId, email = OWNER) => { env.as(email); try { return env.call('apiPlanView(__in)', { __in: { planId } }); } finally { env.as(OWNER); } };
const logOf = (env, planId) => env.call('appInputLogRead_(__p)', { __p: planId });
const added = (env, planId, n0) => env.table('INPUT_LOG').filter((r) => r.plan_id === planId).slice(n0);   // 足した順（表の順）
const countOf = (env, planId) => env.table('INPUT_LOG').filter((r) => r.plan_id === planId).length;
/** 今の画面と同じ保存（fromRows: true）。hash を渡すと古い画面の保存 */
const saveNew = (env, planId, kind, rows, opts = {}) => {
  const args = Object.assign({ kind, rows }, opts.flag === false ? {} : { fromRows: true });
  const payload = { planId, action: 'INPUT.SAVE', args };
  if (opts.hash !== null) payload.inputHash = opts.hash || view(env, planId, opts.as).inputHash;
  if (opts.as) env.as(opts.as);
  try { return env.runJob('PLAN.EDIT', payload); } finally { env.as(OWNER); }
};
/** 開いたときの行（fromRow 付き）。pick = 残す行の位置、edit = { 位置: 直す値 } */
const fromRows = (loaded, pick, edit = {}) => pick.map((i) => Object.assign({}, loaded[i], edit[i] || {}, { fromRow: i }));
const brief = (rows) => rows.map((r) => [r.change, r.row_key, r.self_conf]);
const tidy = (v) => (v === '' || v === null || v === undefined ? v : JSON.parse(v));
/** A-2 のひな形と同じ形のメーカー全体の行（担当者なし・同じ月・0%。同じ印の組 client||月・#2・#3…） */
const TEMPLATE = (n) => Array.from({ length: n }, () => ['', D(FYC, 4), '0%', '']);
const K = 'client||' + ym(4);
const keyAt = (i) => (i === 0 ? K : K + '#' + (i + 1));

// ==== G2. 全部の行を外して足す（fromRow が 1 つも無い今の画面の保存）→ REMOVE と ADD ====
{
  const E = setUpEnv();
  const X = E.seedPlan(inputBook(E, '組み製薬', { product: [['鷹野', '製品A', D(FYC, 4), '+5%', 'a'], ['佐藤', '製品B', D(FYC, 5), '+3%', 'b']] }));
  const Y = E.seedPlan(inputBook(E, '一行製薬', { product: [['鷹野', '製品Q', D(FYC, 6), '+2%', 'q']] }));
  E.call('apiListPlans()');   // 初めの姿（BASELINE）
  // 鷹野 の行に自信 高い（今の画面: 選び直した行だけ自信を送る）
  let st = saveNew(E, X, 'product', fromRows(view(E, X).boot.input.product, [0, 1], { 0: { selfConf: '高い' } }));
  assert.equal(st.status, 'DONE', st.error);
  // 点検の例: 2 行とも外し、佐藤 の新しい行を足す
  let n0 = countOf(E, X);
  st = saveNew(E, X, 'product', [{ person: '佐藤', product: '製品A', ym: ym(10), step: '+1%', reason: '新しい行' }]);
  assert.equal(st.status, 'DONE', st.error);
  let add = added(E, X, n0);
  assert.deepEqual(brief(add), [['ADD', 'product|佐藤|製品A|' + ym(10), ''], ['REMOVE', 'product|鷹野|製品A|' + ym(4), '高い'], ['REMOVE', 'product|佐藤|製品B|' + ym(5), '']],
    '外した 2 行は REMOVE、足した行は ADD（鷹野 の行を 佐藤 の行に変えたことにしない・外した行の自信を付けない）');
  let il = view(E, X).inputLog;
  assert.deepEqual([il.rows.product.length, il.rows.product[0].conf, il.rows.product[0].hist.map((h) => h.change)], [1, '', ['ADD']]);
  const eng = E.table('ENG_PRODUCT').filter((r) => r.plan_id === X);
  assert.deepEqual(eng.map((r) => [r.Person, r.ProductName]), [['佐藤', '製品A']]);
  assert.equal(E.scratch().getSheetByName('PRODUCT').getLastColumn(), 5, '旧来の表は 5 列のまま');
  // 1 行の計画: 行を外して、同じ印の新しい行を足す → REMOVE と ADD。新しい行の跡は ADD から（外した行の跡を付けない）
  n0 = countOf(E, Y);
  st = saveNew(E, Y, 'product', [{ person: '鷹野', product: '製品Q', ym: ym(6), step: '+7%', reason: '入れ直し' }]);
  assert.equal(st.status, 'DONE', st.error);
  add = added(E, Y, n0);
  assert.deepEqual(add.map((r) => [r.change, r.row_key]), [['ADD', 'product|鷹野|製品Q|' + ym(6)], ['REMOVE', 'product|鷹野|製品Q|' + ym(6)]]);
  il = view(E, Y).inputLog;
  assert.deepEqual(il.rows.product[0].hist.map((h) => h.change), ['ADD'], '足した行の跡は ADD から');
  assert.equal(il.rows.product[0].n, 1);
  // 印をとっておかない前の画面（fromRows も fromRow も無い）: 今までどおり同じ位置で組む
  n0 = countOf(E, Y);
  st = saveNew(E, Y, 'product', [{ person: '佐藤', product: '製品R', ym: ym(7), step: '+1%', reason: '前の画面' }], { flag: false });
  assert.equal(st.status, 'DONE', st.error);
  assert.deepEqual(added(E, Y, n0).map((r) => [r.change, r.row_key, tidy(r.before_json).product]), [['CHANGE', 'product|佐藤|製品R|' + ym(7), '製品Q']], '前の画面は同じ位置で組む');
  // 入力のハッシュを確かめない保存は、fromRows があっても出どころを使わない
  n0 = countOf(E, Y);
  st = saveNew(E, Y, 'product', [{ person: '鷹野', product: '製品S', ym: ym(8), step: '+1%', reason: 'ハッシュなし' }], { hash: null });
  assert.equal(st.status, 'DONE', st.error);
  assert.deepEqual(added(E, Y, n0).map((r) => r.change), ['CHANGE']);
  // 道具: fromRows は記録にだけ使い、旧来に渡す中身から外す
  const take = E.call('(() => { const i = { action: "INPUT.SAVE" }; const out = appInputLogTake_({ kind: "product", rows: [{ person: "a" }], fromRows: true }, i); return { out: out, from: i.from }; })()');
  assert.deepEqual(take, { out: { kind: 'product', rows: [{ person: 'a' }] }, from: { kind: 'product', bySeq: {} } });
  const take2 = E.call('(() => { const i = { action: "INPUT.SAVE" }; const out = appInputLogTake_({ kind: "product", rows: [{ person: "a" }], fromRows: "yes" }, i); return { out: out, from: i.from || null }; })()');
  assert.deepEqual(take2, { out: { kind: 'product', rows: [{ person: 'a' }] }, from: null }, 'true だけを今の画面の印とみなす（ほかの値は外すだけ）');
}

// ==== G3. 同じ印の組の行を外す: 下の行は自分の自信と跡のまま ====
{
  const E = setUpEnv();
  const P = E.seedPlan(inputBook(E, '組の製薬', { client: TEMPLATE(5) }));
  E.call('apiListPlans()');
  // 同じ中身の 5 行に、違う自信（2 行目 低い・3 行目 ふつう・4 行目 高い）
  let loaded = view(E, P).boot.input.client;
  let st = saveNew(E, P, 'client', fromRows(loaded, [0, 1, 2, 3, 4], { 1: { selfConf: '低い' }, 2: { selfConf: 'ふつう' }, 3: { selfConf: '高い' } }));
  assert.equal(st.status, 'DONE', st.error);
  assert.deepEqual(view(E, P).inputLog.rows.client.map((x) => x.conf), ['', '低い', 'ふつう', '高い', '']);
  // 真ん中（3 行目・ふつう）を外す。自信は送らない（選び直していない）
  let n0 = countOf(E, P);
  st = saveNew(E, P, 'client', fromRows(view(E, P).boot.input.client, [0, 1, 3, 4]));
  assert.equal(st.status, 'DONE', st.error);
  let add = added(E, P, n0);
  assert.deepEqual(brief(add).sort(), [['CHANGE', keyAt(2), '高い'], ['CHANGE', keyAt(3), ''], ['REMOVE', keyAt(2), 'ふつう']].sort(),
    '外したのは 3 行目。#n の詰まった行は、自信を引き継ぐ CHANGE（自信だけの CONF は足さない）');
  const moves = add.filter((r) => r.change === 'CHANGE');
  moves.forEach((r) => {
    const b = tidy(r.before_json), a = tidy(r.after_json);
    assert.equal(b._key, r.row_key === keyAt(2) ? keyAt(3) : keyAt(4), '前の印を before_json の _key に');
    delete b._key;
    assert.deepEqual(b, a, '中身は同じ');
  });
  let il = view(E, P).inputLog;
  assert.deepEqual(il.rows.client.map((x) => x.conf), ['', '低い', '高い', ''], 'どの行も自分の自信のまま（4 行目の 高い は 3 行目に詰まっても 高い）');
  assert.deepEqual(il.rows.client.map((x) => x.hist.map((h) => h.change + (h.conf ? ' ' + h.conf : ''))),
    [['BASELINE'], ['CONF 低い', 'BASELINE'], ['CONF 高い', 'BASELINE'], ['BASELINE']], '跡も自分のもの（外した行の跡を付けない・付け直しだけの記録は出さない）');
  assert.ok(JSON.stringify(il).indexOf('_key') < 0, '記録だけの印は送らない');
  assert.deepEqual(il.rows.client.map((x) => x.n), [1, 2, 2, 1]);
  // 今の画面より前の送り方（全部の行に自信を送る）でも同じ: 選んでいない行に CONF を足さない
  loaded = view(E, P).boot.input.client;
  const confs = view(E, P).inputLog.rows.client.map((x) => x.conf);
  n0 = countOf(E, P);
  st = saveNew(E, P, 'client', [0, 2, 3].map((i) => Object.assign({}, loaded[i], { fromRow: i, selfConf: confs[i] })));   // 2 行目（低い）を外す
  assert.equal(st.status, 'DONE', st.error);
  add = added(E, P, n0);
  assert.ok(!add.some((r) => r.change === 'CONF'), 'CONF を足さない: ' + JSON.stringify(brief(add)));
  assert.deepEqual(brief(add.filter((r) => r.change === 'REMOVE')), [['REMOVE', keyAt(1), '低い']]);
  il = view(E, P).inputLog;
  assert.deepEqual(il.rows.client.map((x) => x.conf), ['', '高い', '']);
  assert.deepEqual(il.rows.client.map((x) => x.hist.map((h) => h.change + (h.conf ? ' ' + h.conf : ''))), [['BASELINE'], ['CONF 高い', 'BASELINE'], ['BASELINE']]);
  // 自信を選び直した行の印が同じ保存で詰まった: 引き継ぐ CHANGE と、選んだ自信の CONF
  loaded = view(E, P).boot.input.client;
  n0 = countOf(E, P);
  st = saveNew(E, P, 'client', fromRows(loaded, [1, 2], { 1: { selfConf: 'ふつう' } }));   // 1 行目を外し、2 行目（高い）を ふつう に
  assert.equal(st.status, 'DONE', st.error);
  add = added(E, P, n0);
  assert.deepEqual(brief(add), [['CHANGE', K, '高い'], ['CONF', K, 'ふつう'], ['CHANGE', keyAt(1), ''], ['REMOVE', K, '']], JSON.stringify(brief(add)));
  il = view(E, P).inputLog;
  assert.deepEqual(il.rows.client.map((x) => x.conf), ['ふつう', '']);
  assert.deepEqual(il.rows.client[0].hist.map((h) => h.change + (h.conf ? ' ' + h.conf : '')), ['CONF ふつう', 'CONF 高い', 'BASELINE']);
}
// 点検の例（手を付けていないひな形の組。2 行目に理由と自信 低い、4 行目に自信 高い → 2 行目を外す）
{
  const E = setUpEnv();
  const P = E.seedPlan(inputBook(E, 'ひな形製薬', { client: TEMPLATE(6) }));
  E.call('apiListPlans()');
  let st = saveNew(E, P, 'client', fromRows(view(E, P).boot.input.client, [0, 1, 2, 3, 4, 5], { 1: { reason: 'ドライラン K', selfConf: '低い' }, 3: { selfConf: '高い' } }));
  assert.equal(st.status, 'DONE', st.error);
  const n0 = countOf(E, P);
  st = saveNew(E, P, 'client', fromRows(view(E, P).boot.input.client, [0, 2, 3, 4, 5]));
  assert.equal(st.status, 'DONE', st.error);
  const add = added(E, P, n0);
  assert.deepEqual(add.filter((r) => r.change !== 'CHANGE').map((r) => [r.change, r.row_key, r.self_conf]), [['REMOVE', keyAt(1), '低い']], 'CONF を足さない');
  assert.ok(add.filter((r) => r.change === 'CHANGE').every((r) => { const b = tidy(r.before_json); const k = b._key; delete b._key; return k && JSON.stringify(b) === r.after_json; }),
    '足すのは中身の同じ付け直しだけ');
  const il = view(E, P).inputLog;
  assert.deepEqual(il.rows.client.map((x) => x.conf), ['', '', '高い', '', '']);
  assert.deepEqual(il.rows.client.map((x) => x.hist.map((h) => h.change)), [['BASELINE'], ['BASELINE'], ['CONF', 'BASELINE'], ['BASELINE'], ['BASELINE']],
    '外した行の跡（理由 ドライラン K・自信 低い）を下の行に付けない');
  assert.ok(!JSON.stringify(il).includes('ドライラン'));
  // 手を付けていない行どうし（見分けられない）は、外しても記録を足さない（今までどおり）
  const P2 = E.seedPlan(inputBook(E, '同じ製薬', { client: TEMPLATE(3) }));
  E.call('apiListPlans()');
  const m0 = countOf(E, P2);
  assert.equal(saveNew(E, P2, 'client', fromRows(view(E, P2).boot.input.client, [1, 2])).status, 'DONE');
  assert.deepEqual(added(E, P2, m0).map((r) => [r.change, r.row_key]), [['REMOVE', keyAt(2)]], '無くなる印（#3）を外したことにする');
}
// 決まった乱数で、外す・直す・自信を選ぶ・足すを重ねる: どの行も、自分の自信と跡（画面に出る分）のまま
for (let seed0 = 1; seed0 <= 6; seed0++) {
  const E = setUpEnv();   // 初めの姿（BASELINE）の写しは 1 回だけなので、計画ごとに新しく
  let seed = seed0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const P = E.seedPlan(inputBook(E, '重ね製薬' + seed0, { client: TEMPLATE(6) }));
  E.call('apiListPlans()');
  const oldUi = seed0 % 2 === 0;   // 前の画面は、どの行にも今の自信を送る
  let model = Array.from({ length: 6 }, () => ({ step: '0%', reason: '', conf: '', hist: ['BASELINE'] }));
  for (let round = 0; round < 10; round++) {
    const v = view(E, P);
    const loaded = v.boot.input.client;
    const rows = [], next = [];
    model.forEach((m, i) => {
      if (rnd() < 0.3) return;   // 外す
      const r = Object.assign({}, loaded[i], { fromRow: i });
      const nm = Object.assign({}, m, { hist: m.hist.slice() });
      let edited = false, conf = null;
      if (rnd() < 0.3) { const s = pick(['0%', '+5%', '-3%']), re = pick(['', 'a', 'b']); if (s !== m.step || re !== m.reason) { Object.assign(r, { step: s, reason: re }); Object.assign(nm, { step: s, reason: re }); edited = true; } }
      if (rnd() < 0.3) { const c = pick(['', '高い', '低い']); if (c !== m.conf) conf = c; }
      if (conf !== null) r.selfConf = conf; else if (oldUi) r.selfConf = m.conf;
      if (edited) { nm.conf = conf !== null ? conf : m.conf; nm.hist.unshift('CHANGE ' + nm.conf); } else if (conf !== null) { nm.conf = conf; nm.hist.unshift('CONF ' + conf); }
      rows.push(r);
      next.push(nm);
    });
    if (rnd() < 0.3) {
      const s = pick(['0%', '+5%']), re = pick(['', 'c']), c = pick(['', '高い']);
      rows.push(Object.assign({ person: '', ym: ym(4), step: s, reason: re }, c ? { selfConf: c } : {}));
      next.push({ step: s, reason: re, conf: c, hist: ['ADD ' + c] });
    }
    assert.equal(saveNew(E, P, 'client', rows, { hash: v.inputHash }).status, 'DONE');
    model = next;
    const il = view(E, P).inputLog.rows.client;
    const at = 'seed ' + seed0 + ' round ' + round;
    assert.deepEqual(il.map((x) => x.conf), model.map((m) => m.conf), '自信: ' + at);
    assert.deepEqual(il.map((x) => x.hist.map((h) => (h.change === 'BASELINE' ? h.change : (h.change + ' ' + (h.conf || '')).trim()))), model.map((m) => m.hist.slice(0, 5).map((s) => s.trim())), '跡: ' + at);
    assert.deepEqual(il.map((x) => x.n), model.map((m) => m.hist.length), '跡の数: ' + at);
  }
}

// ==== G4. 自信は選び直した行だけ: 古い画面の保存で、ほかの人が変えた自信を戻さない ====
{
  const E = setUpEnv();
  const P = E.seedPlan(inputBook(E, '二人製薬', { product: [['鷹野', '製品A', D(FYC, 4), '+5%', 'a'], ['佐藤', '製品B', D(FYC, 5), '+3%', 'b']], client: TEMPLATE(4) }));
  E.call('apiListPlans()');
  const clientId = E.table('PLANS').find((p) => p.plan_id === P).client_id;
  for (const [email, name] of [[MEMBER, 'エー'], [OTHER, 'ビー']]) {
    E.task('saveMember(__in)', { __in: { email, displayName: name, department: '営業' } });
    E.task('grantRole(__in)', { __in: { email, role: 'PLANNER', scopeType: 'CLIENT', clientId } });
  }
  // A（MEMBER）が画面を開く。そのあと B（OTHER）が 1 行目の自信だけ 低い にする（入力のハッシュは変わらない）
  const a = view(E, P, MEMBER);
  let st = saveNew(E, P, 'product', fromRows(view(E, P, OTHER).boot.input.product, [0, 1], { 0: { selfConf: '低い' } }), { as: OTHER });
  assert.equal(st.status, 'DONE', st.error);
  assert.equal(view(E, P, OTHER).inputHash, a.inputHash, '前提: 自信だけの保存では入力のハッシュは変わらない');
  // A は古い画面のまま 2 行目の理由だけ直して保存（自信は選び直していないので送らない）
  const n0 = countOf(E, P);
  st = saveNew(E, P, 'product', fromRows(a.boot.input.product, [0, 1], { 1: { reason: 'b を直した' } }), { as: MEMBER, hash: a.inputHash });
  assert.equal(st.status, 'DONE', st.error);
  assert.deepEqual(added(E, P, n0).map((r) => [r.change, r.row_key, r.self_conf, r.actor_email]), [['CHANGE', 'product|佐藤|製品B|' + ym(5), '', MEMBER]], 'A の保存は直した行だけ');
  assert.equal(view(E, P).inputLog.rows.product[0].conf, '低い', 'B の自信が残る');
  // 同じ印の組: A が画面を開く → B が 3 行目に自信 高い → A（古い画面）が 1 行目を外し、2 行目の理由を直す。B の自信は 3 行目だった行についていく
  const a2 = view(E, P, MEMBER);
  st = saveNew(E, P, 'client', fromRows(view(E, P, OTHER).boot.input.client, [0, 1, 2, 3], { 2: { selfConf: '高い' } }), { as: OTHER });
  assert.equal(st.status, 'DONE', st.error);
  st = saveNew(E, P, 'client', fromRows(a2.boot.input.client, [1, 2, 3], { 1: { reason: '直した' } }), { as: MEMBER, hash: a2.inputHash });
  assert.equal(st.status, 'DONE', st.error);
  const il = view(E, P).inputLog;
  assert.deepEqual(il.rows.client.map((x) => x.conf), ['', '高い', ''], 'B の 高い は、詰まって 2 行目になった行のまま');
  assert.deepEqual(il.rows.client[1].hist.map((h) => [h.change, h.conf, h.by]), [['CONF', '高い', OTHER], ['BASELINE', '', '']]);
  assert.deepEqual(il.rows.client[0].hist.map((h) => [h.change, h.by]), [['CHANGE', MEMBER], ['BASELINE', '']], 'A が直した行の跡は A の変えた跡から');
}

console.log('app-v10-fix2-srv: ok');
