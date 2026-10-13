#!/usr/bin/env node
/*
 * app-v10-fix3-srv.test.mjs — 版 10（v0.30.0）の最後の点検の直し 3（サーバー側）を確かめる。
 *   H1. 入力の記録の行の印（row_key）を取り違えない: 欄の値の「%」「|」「#」は %25・%7C・%23 にする（案件名「案件#2」と 2 つ目の「案件」、
 *       名前の中の「|」で、別の行が同じ印にならない。ふつうの名前の印はそのまま）。記録の表に足す行に同じキーが 2 つあれば、
 *       控えを置く前に止める（appLogOps_・appJournalRun_。書きかけの控えがほかの計画の保存まで止めない）。
 *       一度だけの写し（BASELINE）は、行を確かめられない計画を飛ばして（エラーのログ・一度だけの写しの失敗に残す）、ほかの計画を写す
 *   H2. 行の跡は、その行自身の前の跡: 出どころで組んで担当者・製品・月を変えた行は、前にその印を使ったほかの行・外した行の跡を付けない
 *       （CHANGE の before_json の _key に前の印）。同じ位置で組んだ CHANGE（前の画面）で印が変わったものは、そこで止まる。
 *       見る人（閲覧）に送る跡は今の担当者の間の分だけ（前は本人の行だった、今はほかの人の行は、今までどおり送らない）
 *   H3. 自信だけ変えた保存は、入力の記録に足した行の数（inputLogRows）を返す（表は変わらない）
 * 名前と数字はテスト用の架空のもの。モックの上の確かめで、本物の Apps Script の上では動かしていない。
 *
 *   node app/tests/app-v10-fix3-srv.test.mjs
 */
import assert from 'node:assert/strict';
import { setUpEnv, OWNER, OTHER } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const CTX = `{ actor: '${OWNER}', requestId: 'T' }`;
const env0 = setUpEnv();
const FYC = env0.run('appFy_(new Date())');
const ym = (k) => FYC + '-' + String(k).padStart(2, '0');
function inputBook(env, client, { product = [], client: cl = [], devspot = [] } = {}) {
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
    DEV_SPOT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Project', 'Amount(JPY)', 'Confidence(0..1)']].concat(devspot) },
  });
}
const view = (env, planId, email = OWNER) => { env.as(email); try { return env.call('apiPlanView(__in)', { __in: { planId } }); } finally { env.as(OWNER); } };
const planLog = (env, planId) => env.table('INPUT_LOG').filter((r) => r.plan_id === planId);
const added = (env, planId, n0) => planLog(env, planId).slice(n0);   // 足した順（表の順）
const countOf = (env, planId) => planLog(env, planId).length;
/** 今の画面と同じ保存（fromRows: true・開いたときの入力のハッシュ）。flag: false = 前の画面（fromRows なし） */
const saveNew = (env, planId, kind, rows, opts = {}) => {
  const args = Object.assign({ kind, rows }, opts.flag === false ? {} : { fromRows: true });
  const payload = { planId, action: 'INPUT.SAVE', args };
  if (opts.hash !== null) payload.inputHash = opts.hash || view(env, planId).inputHash;
  return env.runJob('PLAN.EDIT', payload);
};
/** 開いたときの行（fromRow 付き）。pick = 残す行の位置、edit = { 位置: 直す値 } */
const fromRows = (loaded, pick, edit = {}) => pick.map((i) => Object.assign({}, loaded[i], edit[i] || {}, { fromRow: i }));
const brief = (rows) => rows.map((r) => [r.change, r.row_key, r.self_conf]);
const tidy = (v) => (v === '' || v === null || v === undefined ? v : JSON.parse(v));
const histOf = (x) => x.hist.map((h) => (h.change === 'BASELINE' ? 'BASELINE' : (h.change + ' ' + (h.conf || '')).trim()));
const pending = (env) => env.props.APP_WRITE_JOURNAL || null;
const backfills = (env) => JSON.parse(env.props.APP_BACKFILLS || '{"done":{},"failed":{}}');
/** A-2 のひな形と同じ形のメーカー全体の行（担当者なし・同じ月・0%。同じ印の組 client||月・#2・#3…） */
const TEMPLATE = (n) => Array.from({ length: n }, () => ['', D(FYC, 4), '0%', '']);
const T = 'client||' + ym(4);
const tAt = (i) => (i === 0 ? T : T + '#' + (i + 1));

// ==== H1-a. 行の印の欄の % | # を置き換える（ふつうの名前は読めるまま・1 対 1） ====
{
  const k = (kind, row) => env0.call('appInputLogKey_(__k, __r)', { __k: kind, __r: row });
  assert.equal(k('product', { person: '鷹野', product: '製品A', ym: ym(4) }), 'product|鷹野|製品A|' + ym(4), 'ふつうの名前の印はそのまま');
  assert.equal(k('client', { person: ' 鷹野 ', ym: ym(5) }), 'client|鷹野|' + ym(5), '前後の空白は今までどおり除く');
  assert.equal(k('devspot', { person: '鷹野', ym: ym(6), project: '案件#2' }), 'devspot|鷹野|' + ym(6) + '|案件%232', '欄の # は %23');
  assert.notEqual(k('product', { person: 'a|b', product: 'c', ym: ym(4) }), k('product', { person: 'a', product: 'b|c', ym: ym(4) }), '名前の | で別の行が同じ印にならない');
  assert.equal(k('product', { person: 'a|b', product: 'c', ym: ym(4) }), 'product|a%7Cb|c|' + ym(4));
  assert.notEqual(k('devspot', { person: '鷹野', ym: ym(6), project: '割引%23' }), k('devspot', { person: '鷹野', ym: ym(6), project: '割引#' }), '% も置き換えるので 1 対 1');
  assert.equal(k('devspot', { person: '鷹野', ym: ym(6), project: '割引%23' }), 'devspot|鷹野|' + ym(6) + '|割引%2523');
  assert.deepEqual(env0.call('["a#2", "a%232#3", "client||2026-04#12", "x"].map(appInputLogBaseKey_)'), ['a', 'a%232', 'client||2026-04', 'x'], '#n だけを除く');
}

// ==== H1-b. 点検の例: スポットの案件名「案件」「案件」「案件#2」・名前に「|」のある行 → 写しも保存も止まらない ====
{
  const E = setUpEnv();
  const Q = E.seedPlan(inputBook(E, '別製薬', { product: [['鷹野', '製品A', D(FYC, 4), '+5%', 'a']] }));
  const P = E.seedPlan(inputBook(E, '井桁製薬', {
    product: [['a|b', 'c', D(FYC, 4), '+1%', 'p1'], ['a', 'b|c', D(FYC, 4), '+2%', 'p2']],
    devspot: [['鷹野', D(FYC, 6), '案件', 100, 0.5], ['鷹野', D(FYC, 6), '案件', 200, 0.5], ['鷹野', D(FYC, 6), '案件#2', 300, 0.5]] }));
  E.call('apiListPlans()');   // 一度だけの写し（BASELINE）
  assert.equal(pending(E), null, '書きかけの控えを残さない');
  assert.ok(backfills(E).done.appV10BackfillInputLog_, '入力の記録の写しは済み');
  assert.deepEqual(backfills(E).failed, {});
  const K = 'devspot|鷹野|' + ym(6) + '|案件';
  assert.deepEqual(planLog(E, P).map((r) => [r.change, r.row_key]), [
    ['BASELINE', 'product|a%7Cb|c|' + ym(4)], ['BASELINE', 'product|a|b%7Cc|' + ym(4)],
    ['BASELINE', K], ['BASELINE', K + '#2'], ['BASELINE', K + '%232']], 'どの行も別の印');
  assert.equal(new Set(planLog(E, P).map((r) => r.log_id)).size, 5, '写しの番号も別');
  const vp = view(E, P);
  assert.ok(!vp.pendingWrite && vp.boot, 'その計画の画面が開く');
  assert.deepEqual(vp.inputLog.rows.devspot.map((x) => [x.n, x.hist[0].change, x.hist[0].after.project, x.hist[0].after.amount]),
    [[1, 'BASELINE', '案件', 100], [1, 'BASELINE', '案件', 200], [1, 'BASELINE', '案件#2', 300]], 'どの行の跡も自分の初めの姿');
  assert.deepEqual(vp.inputLog.rows.product.map((x) => x.hist[0].after.reason), ['p1', 'p2']);
  const vq = view(E, Q);
  assert.ok(!vq.pendingWrite && vq.boot, 'ほかの計画の画面も開く');
  let st = saveNew(E, Q, 'product', fromRows(vq.boot.input.product, [0], { 0: { step: '+1%' } }));
  assert.equal(st.status, 'DONE', st.error);
  // 2 つ目の「案件」を外す: 外したのはその行（案件#2 の名前の行と取り違えない）
  const n0 = countOf(E, P);
  st = saveNew(E, P, 'devspot', fromRows(vp.boot.input.devspot, [0, 2]));
  assert.equal(st.status, 'DONE', st.error);
  assert.deepEqual(added(E, P, n0).map((r) => [r.change, r.row_key, tidy(r.before_json).amount]), [['REMOVE', K + '#2', 200]]);
  const il = view(E, P).inputLog;
  assert.deepEqual(il.rows.devspot.map((x) => [x.hist[0].change, x.hist[0].after.project, x.hist[0].after.amount]), [['BASELINE', '案件', 100], ['BASELINE', '案件#2', 300]]);
}

// ==== H1-c. 同じキーの 2 行は、控えを置く前に止める（保存は失敗して何も書かない・ほかの計画は止めない） ====
{
  const E = setUpEnv();
  const P = E.seedPlan(inputBook(E, '重なり製薬', { product: [['鷹野', '製品A', D(FYC, 4), '+5%', 'a']] }));
  const Q = E.seedPlan(inputBook(E, '隣の製薬', { product: [['佐藤', '製品B', D(FYC, 5), '+3%', 'b']] }));
  E.call('apiListPlans()');
  const row = { plan_id: P, log_id: 'INL-DUP-1', action_id: 'ACT-T', action: 'INPUT.SAVE', kind: 'product', change: 'CONF', row_key: 'product|鷹野|製品A|' + ym(4),
    person: '鷹野', before_json: '', after_json: { person: '鷹野' }, self_conf: '高い', reason: '', signal_id: '', actor_email: OWNER, saved_at: '2026-10-01T10:00:00+0900' };
  assert.throws(() => E.call('appLogOps_("INPUT_LOG", [__r, __r])', { __r: row }), /同じキーの行が 2 つ/, 'appLogOps_ が控えを作る前に止める');
  assert.equal(E.call('appLogOps_("INPUT_LOG", [__r, __s])[0].rows.length', { __r: row, __s: Object.assign({}, row, { log_id: 'INL-DUP-2' }) }), 2, '別のキーなら足す');
  // 控えの書き方を手で作っても（appLogOps_ を通らない）、控えを置く前に止める
  const n0 = E.table('INPUT_LOG').length;
  assert.throws(() => E.call(`appWithLock_(() => appJournalRun_(${CTX}, 'テスト', __p, [{ table: 'INPUT_LOG', mode: 'append', rows: [__r, __r] }]))`, { __p: P, __r: row }), /同じキーの行が 2 つ/);
  assert.equal(pending(E), null, '控えを置かない');
  assert.throws(() => E.call(`appWithLock_(() => appJournalRun_(${CTX}, 'テスト', __p, [{ table: 'INPUT_LOG', mode: 'append', rows: [__r] }]))`, { __p: P, __r: Object.assign({}, row, { log_id: '' }) }), /キーが空/);
  assert.equal(pending(E), null, 'キーの空の行も、控えを置く前に止める');
  assert.equal(E.table('INPUT_LOG').length, n0, '何も書かない');
  // 保存の記録に同じ番号の行ができた（作れないはずのこと）: 保存は失敗して、本体も記録も書かない。ほかの計画の保存は止まらない
  E.run('__origNewLogId = appNewLogId_; appNewLogId_ = function(prefix) { return prefix + "-SAME"; };');
  const v = view(E, P);
  const twoRows = (loaded) => fromRows(loaded, [0], { 0: { reason: 'a を直した' } }).concat([{ person: '鷹野', product: '製品C', ym: ym(4), step: '+1%', reason: 'c' }]);   // CHANGE と ADD
  let st = saveNew(E, P, 'product', twoRows(v.boot.input.product));
  assert.equal(st.status, 'FAILED');
  assert.match(st.error, /同じキーの行が 2 つ/, '分かる理由で止める');
  assert.equal(pending(E), null, '書きかけの控えを残さない');
  assert.deepEqual(E.table('ENG_PRODUCT').filter((r) => r.plan_id === P).map((r) => r.ProductName), ['製品A'], '本体も書かない');
  assert.equal(E.table('INPUT_LOG').length, n0);
  E.run('appNewLogId_ = __origNewLogId;');
  st = saveNew(E, Q, 'product', fromRows(view(E, Q).boot.input.product, [0], { 0: { reason: 'b を直した' } }));
  assert.equal(st.status, 'DONE', st.error);
  st = saveNew(E, P, 'product', twoRows(view(E, P).boot.input.product));
  assert.equal(st.status, 'DONE', st.error);
  assert.deepEqual(E.table('ENG_PRODUCT').filter((r) => r.plan_id === P).map((r) => r.ProductName), ['製品A', '製品C']);
}

// ==== H1-d. 一度だけの写しで、行を確かめられない計画があっても、ほかの計画を写す（書きかけの控えで止めない） ====
{
  const E = setUpEnv();
  const A = E.seedPlan(inputBook(E, '一の製薬', { product: [['鷹野', '製品A', D(FYC, 4), '+5%', 'a']] }));
  const BAD = E.seedPlan(inputBook(E, '二の製薬', { product: [['鷹野', '製品A', D(FYC, 4), '+5%', 'a'], ['佐藤', '製品B', D(FYC, 5), '+3%', 'b']] }));
  const C = E.seedPlan(inputBook(E, '三の製薬', { client: [['鷹野', D(FYC, 6), '+2%', 'c']] }));
  // BAD の写しの番号だけ同じにする（行を確かめると止まる）
  E.run('__origStable = appStableLogId_; appStableLogId_ = function(prefix, parts) { return prefix === "INL" && parts && parts[1] === __bad ? "INL-SAME" : __origStable(prefix, parts); };', { __bad: BAD });
  E.call('apiListPlans()');
  assert.equal(pending(E), null, '書きかけの控えを残さない');
  const baseOf = (pid) => planLog(E, pid).filter((r) => r.change === 'BASELINE').length;
  assert.deepEqual([baseOf(A), baseOf(BAD), baseOf(C)], [1, 0, 1], 'ほかの計画は写す・確かめられない計画は飛ばす');
  let bf = backfills(E);
  assert.ok(!bf.done.appV10BackfillInputLog_, '飛ばした計画があるうちは済みにしない');
  assert.match(bf.failed.appV10BackfillInputLog_.error, new RegExp(BAD), '一度だけの写しの失敗に、飛ばした計画を残す');
  assert.ok(bf.done.appV10BackfillAiResearchLog_ && bf.done.appV10BackfillHitRecords_, 'ほかの写しは止まらない');
  assert.ok(E.errors().some((e) => e.where === 'INPUT_LOG.BACKFILL' && String(e.message).indexOf(BAD) >= 0 && /同じキーの行が 2 つ/.test(String(e.message))), 'エラーのログに計画と理由');
  for (const pid of [A, BAD, C]) assert.ok(!view(E, pid).pendingWrite && view(E, pid).boot, 'どの計画の画面も開く: ' + pid);
  let st = saveNew(E, A, 'product', fromRows(view(E, A).boot.input.product, [0], { 0: { selfConf: '高い' } }));
  assert.equal(st.status, 'DONE', st.error);
  assert.equal(view(E, A).inputLog.rows.product[0].conf, '高い');
  // 直った後（10 分たってやり直す）: 飛ばした計画も写し、済みにする
  E.run('appStableLogId_ = __origStable;');
  bf.failed.appV10BackfillInputLog_.at = Date.now() - 11 * 60 * 1000;
  E.props.APP_BACKFILLS = JSON.stringify(bf);
  E.call('apiListPlans()');
  assert.deepEqual([baseOf(A), baseOf(BAD), baseOf(C)], [1, 2, 1]);
  bf = backfills(E);
  assert.ok(bf.done.appV10BackfillInputLog_);
  assert.deepEqual(bf.failed, {});
  st = saveNew(E, BAD, 'product', fromRows(view(E, BAD).boot.input.product, [1]));
  assert.equal(st.status, 'DONE', st.error);
}

// ==== H2-a. 点検の例（ひな形 10 行）: 保存 1 で 5 行目を 鷹野・6 月、保存 2 で 2 行目を 鷹野・6 月 → 2 行目の跡は 2 行目のものだけ ====
{
  const E = setUpEnv();
  const P = E.seedPlan(inputBook(E, 'ひな形製薬', { client: TEMPLATE(10) }));
  E.call('apiListPlans()');
  const all = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  let st = saveNew(E, P, 'client', fromRows(view(E, P).boot.input.client, all, { 4: { person: '鷹野', ym: ym(6), step: '+5%', reason: 'R5', selfConf: '高い' } }));
  assert.equal(st.status, 'DONE', st.error);
  const n0 = countOf(E, P);
  st = saveNew(E, P, 'client', fromRows(view(E, P).boot.input.client, all, { 1: { person: '鷹野', ym: ym(6), step: '-3%', reason: 'R2' } }));
  assert.equal(st.status, 'DONE', st.error);
  const K = 'client|鷹野|' + ym(6);
  const add = added(E, P, n0);
  assert.deepEqual(brief(add), [['CHANGE', K, ''], ['CHANGE', K + '#2', '高い']]);
  assert.equal(tidy(add[0].before_json)._key, tAt(1), '印を変えた行の CHANGE に前の印（ひな形の 2 行目）');
  assert.equal(tidy(add[1].before_json)._key, K, '#n だけ詰まった行（5 行目）は今までどおり');
  const after = view(E, P);
  assert.deepEqual(after.boot.input.client.map((r) => r.reason).filter(Boolean), ['R2', 'R5']);
  const il = after.inputLog.rows.client;
  const r2 = il[1], r5 = il[4];
  assert.deepEqual([r2.conf, r2.n, histOf(r2)], ['', 2, ['CHANGE', 'BASELINE']], '2 行目: 自分の CHANGE と、ひな形だったときの初めの姿だけ');
  assert.deepEqual([r2.hist[0].after.reason, r2.hist[1].after.person], ['R2', '']);
  assert.doesNotMatch(JSON.stringify(r2), /R5|高い/, '5 行目の跡（理由 R5・自信 高い）を付けない');
  assert.deepEqual([r5.conf, r5.n, histOf(r5)], ['高い', 2, ['CHANGE 高い', 'BASELINE']], '5 行目は自分の自信と跡のまま');
  assert.equal(r5.hist[0].after.reason, 'R5');
  assert.ok(JSON.stringify(after.inputLog).indexOf('_key') < 0, '記録だけの印は送らない');
  assert.deepEqual(il.filter((x, i) => i !== 1 && i !== 4).map(histOf), Array(8).fill(['BASELINE']), 'ほかのひな形の行は初めの姿のまま');
}

// ==== H2-b. 外した行の印へ、ほかの行を変える（同じ保存・あとの保存・製品の表）→ 外した行の跡を付けない ====
{
  // 同じ保存: 鷹野・6 月（自信 高い）を外し、鷹野・5 月の行を 6 月に
  const E = setUpEnv();
  const P = E.seedPlan(inputBook(E, '外し製薬', { client: [['鷹野', D(FYC, 6), '+5%', 'X'], ['鷹野', D(FYC, 5), '+1%', 'Y']] }));
  E.call('apiListPlans()');
  let st = saveNew(E, P, 'client', fromRows(view(E, P).boot.input.client, [0, 1], { 0: { reason: 'X を直した', selfConf: '高い' } }));
  assert.equal(st.status, 'DONE', st.error);
  let n0 = countOf(E, P);
  st = saveNew(E, P, 'client', fromRows(view(E, P).boot.input.client, [1], { 1: { ym: ym(6) } }));
  assert.equal(st.status, 'DONE', st.error);
  const K6 = 'client|鷹野|' + ym(6), K5 = 'client|鷹野|' + ym(5);
  const add = added(E, P, n0);
  assert.deepEqual(brief(add), [['CHANGE', K6, ''], ['REMOVE', K6, '高い']]);
  assert.equal(tidy(add[0].before_json)._key, K5);
  let x = view(E, P).inputLog.rows.client[0];
  assert.deepEqual([x.conf, x.n, histOf(x)], ['', 2, ['CHANGE', 'BASELINE']], '外した行の REMOVE・CHANGE（高い）を付けない');
  assert.equal(x.hist[1].after.reason, 'Y', '初めの姿はこの行（Y）のもの');
  // あとの保存で 6 月に
  const E2 = setUpEnv();
  const P2 = E2.seedPlan(inputBook(E2, '外し製薬二', { client: [['鷹野', D(FYC, 6), '+5%', 'X'], ['鷹野', D(FYC, 5), '+1%', 'Y']] }));
  E2.call('apiListPlans()');
  assert.equal(saveNew(E2, P2, 'client', fromRows(view(E2, P2).boot.input.client, [0, 1], { 0: { reason: 'X を直した', selfConf: '高い' } })).status, 'DONE');
  assert.equal(saveNew(E2, P2, 'client', fromRows(view(E2, P2).boot.input.client, [1])).status, 'DONE');
  assert.equal(saveNew(E2, P2, 'client', fromRows(view(E2, P2).boot.input.client, [0], { 0: { ym: ym(6) } })).status, 'DONE');
  x = view(E2, P2).inputLog.rows.client[0];
  assert.deepEqual([x.conf, x.n, histOf(x)], ['', 2, ['CHANGE', 'BASELINE']]);
  // 製品の表: 製品A の行（自信 高い）を外し、あとで 製品B の行を 製品A に
  const E3 = setUpEnv();
  const P3 = E3.seedPlan(inputBook(E3, '製品製薬', { product: [['鷹野', '製品A', D(FYC, 4), '+5%', 'a'], ['鷹野', '製品B', D(FYC, 4), '+3%', 'b']] }));
  E3.call('apiListPlans()');
  assert.equal(saveNew(E3, P3, 'product', fromRows(view(E3, P3).boot.input.product, [0, 1], { 0: { selfConf: '高い' } })).status, 'DONE');
  assert.equal(saveNew(E3, P3, 'product', fromRows(view(E3, P3).boot.input.product, [1])).status, 'DONE');
  n0 = countOf(E3, P3);
  assert.equal(saveNew(E3, P3, 'product', fromRows(view(E3, P3).boot.input.product, [0], { 0: { product: '製品A' } })).status, 'DONE');
  assert.equal(tidy(added(E3, P3, n0)[0].before_json)._key, 'product|鷹野|製品B|' + ym(4));
  x = view(E3, P3).inputLog.rows.product[0];
  assert.deepEqual([x.conf, x.n, histOf(x)], ['', 2, ['CHANGE', 'BASELINE']], '外した 製品A の行の跡（外した・自信 高い・初めの姿）を付けない');
  assert.deepEqual([x.hist[0].before.product, x.hist[0].after.product, x.hist[1].after.product], ['製品B', '製品A', '製品B']);
}

// ==== H2-c. 同じ位置で組んだ保存（前の画面: fromRows も fromRow も無い）で印が変わった CHANGE は、跡をそこで止める ====
{
  const E = setUpEnv();
  const P = E.seedPlan(inputBook(E, '前の画面製薬', { client: [['鷹野', D(FYC, 6), '+5%', 'A'], ['佐藤', D(FYC, 5), '+1%', 'B']] }));
  E.call('apiListPlans()');
  assert.equal(saveNew(E, P, 'client', fromRows(view(E, P).boot.input.client, [0, 1], { 0: { selfConf: '高い' } })).status, 'DONE');
  assert.equal(saveNew(E, P, 'client', fromRows(view(E, P).boot.input.client, [1])).status, 'DONE');   // 鷹野・6 月を外す
  const n0 = countOf(E, P);
  const st = saveNew(E, P, 'client', [{ person: '鷹野', ym: ym(6), step: '+2%', reason: 'B2' }], { flag: false });   // 佐藤 の行を 鷹野・6 月に（前の画面）
  assert.equal(st.status, 'DONE', st.error);
  const add = added(E, P, n0);
  assert.deepEqual(brief(add), [['CHANGE', 'client|鷹野|' + ym(6), '']]);
  assert.equal(tidy(add[0].before_json)._key, undefined, '同じ位置で組んだ CHANGE には前の印を入れない');
  const x = view(E, P).inputLog.rows.client[0];
  assert.deepEqual([x.conf, x.n, histOf(x)], ['', 1, ['CHANGE']], '前にその印だった行の跡（外した・自信 高い・初めの姿）を付けない');
  assert.equal(x.hist[0].before.person, '佐藤');
  // 印の変わらない CHANGE（前の画面で中身だけ直した）は、今までどおり前の跡へ続く
  assert.equal(saveNew(E, P, 'client', [{ person: '鷹野', ym: ym(6), step: '+3%', reason: 'B3' }], { flag: false }).status, 'DONE');
  assert.deepEqual(histOf(view(E, P).inputLog.rows.client[0]), ['CHANGE', 'CHANGE']);
}

// ==== H2-d. 決まった乱数のくり返し: 印を変えた行（前に使われた印へ入った行も）は、自分の前の跡だけ ====
{
  const base = (r) => 'client|' + (r.person || '') + '|' + r.ym;
  const keysOf = (rows) => { const seen = {}; return rows.map((r) => { const k = base(r); seen[k] = (seen[k] || 0) + 1; return seen[k] > 1 ? k + '#' + seen[k] : k; }); };
  let movedIntoUsed = 0, checks = 0;
  for (let seed0 = 1; seed0 <= 12; seed0++) {
    const E = setUpEnv();
    let seed = seed0 * 15485863;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const P = E.seedPlan(inputBook(E, '乱数製薬' + seed0, { client: TEMPLATE(8) }));
    E.call('apiListPlans()');
    // 見る人（閲覧）: 鷹野 につながる人
    E.task(`saveMember({ email: '${OTHER}', displayName: 'ビー' })`);
    E.call('appWithLock_(() => appInsertRows_("PERSON_LINKS", __r))', { __r: [{ link_id: 'PLK-T1', person_name: '鷹野', email: OTHER, client_id: '', valid_from: '', valid_to: '',
      is_active: true, note: '', created_at: 'now', created_by: OWNER, updated_at: 'now', updated_by: OWNER, row_version: 1 }] });
    let model = view(E, P).boot.input.client.map(() => ({ conf: '', hist: ['BASELINE'] }));
    for (let round = 0; round < 12; round++) {
      const v = view(E, P);
      const loaded = v.boot.input.client;
      const oldUi = rnd() < 0.2;   // 前の画面の送り方: どの行にも今の自信を送る
      const rows = [], next = [], moved = [];
      model.forEach((m, i) => {
        if (rnd() < 0.12) return;   // 外す
        const r = Object.assign({}, loaded[i], { fromRow: i });
        const nm = { conf: m.conf, hist: m.hist.slice() };
        let edited = false, kc = false, conf = null;
        if (rnd() < 0.25) { const s = pick(['0%', '+5%', '-3%']), re = pick(['', 'a', 'b']); if (s !== r.step || re !== r.reason) { r.step = s; r.reason = re; edited = true; } }
        if (rnd() < 0.25) { const p = pick(['', '鷹野', '佐藤']), mo = pick([ym(4), ym(5)]); if (p !== (r.person || '') || mo !== r.ym) { r.person = p; r.ym = mo; edited = true; kc = true; } }
        if (rnd() < 0.25) { const c = pick(['', '高い', '低い']); if (c !== m.conf) conf = c; }
        if (conf !== null) r.selfConf = conf; else if (oldUi) r.selfConf = m.conf;
        if (edited) { nm.conf = conf !== null ? conf : m.conf; nm.hist.unshift('CHANGE ' + nm.conf); }   // 印を変えても、跡はその行の前の跡に続く
        else if (conf !== null) { nm.conf = conf; nm.hist.unshift('CONF ' + conf); }
        rows.push(r); next.push(nm); moved.push(kc);
      });
      while (rnd() < 0.4) {
        const p = pick(['', '鷹野']), s = pick(['0%', '+5%']), c = pick(['', '高い']);
        rows.push(Object.assign({ person: p, ym: ym(4), step: s, reason: '' }, c ? { selfConf: c } : {}));
        next.push({ conf: c, hist: ['ADD ' + c] }); moved.push(false);
      }
      const used = new Set(planLog(E, P).map((r) => r.row_key));
      const st = saveNew(E, P, 'client', rows, { hash: v.inputHash });
      assert.equal(st.status, 'DONE', st.error);
      model = next;
      const after = view(E, P);
      assert.equal(after.boot.input.client.length, model.length, '行の数');
      const keys = keysOf(after.boot.input.client);
      moved.forEach((kc, i) => { if (kc && used.has(keys[i])) movedIntoUsed++; });
      const il = after.inputLog.rows.client;
      const at = 'seed ' + seed0 + ' round ' + round;
      assert.deepEqual(il.map((x) => x.conf), model.map((m) => m.conf), '自信: ' + at);
      assert.deepEqual(il.map(histOf), model.map((m) => m.hist.slice(0, 5).map((s) => s.trim())), '跡: ' + at);
      assert.deepEqual(il.map((x) => x.n), model.map((m) => m.hist.length), '跡の数: ' + at);
      checks += model.length;
      // 見る人（鷹野 につながる人）: 今 鷹野 の行だけ、今の担当者の間の跡（その行の跡の新しい方の一部）と今の自信。
      // 前は 鷹野 だった行（担当者を変えた行）にも、跡と自信を出さない。名前・した人・理由・記録だけの印は送らない
      const ov = view(E, P, OTHER).inputLog;
      assert.equal(ov.full, false);
      ov.rows.client.forEach((x, i) => {
        const row = 'seed ' + seed0 + ' round ' + round + ' row ' + i;
        if (after.boot.input.client[i].person !== '鷹野') { assert.equal(x, null, '今は本人の行でない行は送らない: ' + row + ' ' + JSON.stringify(x)); return; }
        assert.ok(x, '本人の行: ' + row);
        const js = JSON.stringify(x);
        assert.ok(js.indexOf('_key') < 0 && js.indexOf('"person"') < 0 && x.hist.every((h) => !h.by && !h.reason), '見る人に送らないもの: ' + row + ' ' + js);
        assert.equal(x.conf, il[i].conf, '本人の行は今の自信: ' + row);
        assert.ok(x.n >= 1 && x.n <= il[i].n, '跡の数: ' + row);
        x.hist.forEach((h, j) => assert.equal(JSON.stringify([h.at, h.change, h.conf]), JSON.stringify([il[i].hist[j].at, il[i].hist[j].change, il[i].hist[j].conf]), '跡はその行の跡の新しい方: ' + row));
      });
    }
  }
  assert.ok(movedIntoUsed >= 50, '前に使われた印へ入った行を十分に確かめた: ' + movedIntoUsed);
  assert.ok(checks >= 500, '確かめた行の数: ' + checks);
}

// ==== H3. 自信だけ変えた保存: 表は変わらないが、入力の記録に足した行の数を返す ====
{
  const E = setUpEnv();
  const P = E.seedPlan(inputBook(E, '自信製薬', { product: [['鷹野', '製品A', D(FYC, 4), '+5%', 'a']] }));
  E.call('apiListPlans()');
  let st = saveNew(E, P, 'product', fromRows(view(E, P).boot.input.product, [0], { 0: { selfConf: '高い' } }));
  assert.equal(st.status, 'DONE', st.error);
  assert.deepEqual([st.result.changed, st.result.inputLogRows], [[], 1], '表は変わらない・CONF を 1 行足した');
  assert.deepEqual(brief(planLog(E, P).slice(-1)), [['CONF', 'product|鷹野|製品A|' + ym(4), '高い']]);
  st = saveNew(E, P, 'product', fromRows(view(E, P).boot.input.product, [0]));
  assert.deepEqual([st.status, st.result.changed, st.result.inputLogRows], ['DONE', [], 0], '何も変えない保存は 0');
  st = saveNew(E, P, 'product', fromRows(view(E, P).boot.input.product, [0], { 0: { reason: '直した' } }));
  assert.deepEqual([st.status, st.result.changed, st.result.inputLogRows], ['DONE', ['PRODUCT'], 1]);
  // 入力の記録と関係のない保存（担当者の保存）も 0 を返す
  st = E.runJob('PLAN.EDIT', { planId: P, action: 'SETUP.PEOPLE', args: { peopleCsv: '鷹野, 佐藤, 高橋' }, inputHash: view(E, P).inputHash });
  assert.equal(st.status, 'DONE', st.error);
  assert.equal(st.result.inputLogRows, 0);
}

console.log('app-v10-fix3-srv: ok');
