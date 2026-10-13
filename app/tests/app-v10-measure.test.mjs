#!/usr/bin/env node
/*
 * app-v10-measure.test.mjs — 表の版 10 の測る専用の印（PLANS.purpose = MEASURE。SCHEMA_PLAN_v10-12_JA.md の 3-9・9 章 9。PlanPurpose.js）。
 *   1. 計画を作るとき（createPlan の purpose）: 印が PLANS に入り、監査に残る。打ち間違いは始める前に断る。所有者でなければ断る
 *   2. 後から（setPlanPurpose）: 所有者だけ・監査に前と後・同じ印なら書かない・締めた年度・承認待ちの公式版・計画の数字（ENG_*）は変えない
 *   3. 5 計画まで（6 つ目は付け直しでも作るときでも断る。保管をやめた計画は数えない）
 *   4. 予算の保存・公式版を出す・手で動かす A-4 を断る（始める前・途中で印が付いたときも）。計画の画面は断る操作を止めている操作と同じに出す
 *   5. 週 1 回の自動の AI 調査・着地の τ・w の学び・ホームと分析の合計に入らない（行には印つきで残る）
 *   6. 年度を締める条件（公式版）に入らない・年度の控えには入る
 *   7. 画面: メーカーの一覧・分析・ホーム・予測（予算と公式版と A-4）に印を付けて分け、合計に入れない
 * モックの上の確かめで、本物の Apps Script・ブラウザの上では動かしていない。
 *
 *   node app/tests/app-v10-measure.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setUpEnv, uiHtml, OWNER, MEMBER } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
/** 見本の計画（OUTPUT の年度合計と月ごとの P10/P50/P90・採用予測 = adopted） */
function planBook(client, fy, adopted = 80) {
  const output = [['FY' + fy + ' 売上予測（' + client + '）']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 900, 1000, 1100]);
  output.push([], ['月', 'P10', 'P50', 'P90', '', '', '', '採用予測', '上乗せ']);
  for (let i = 0; i < 12; i++) output.push([D(fy, 4 + i, 1), 70, 80, 90, '', '', '', adopted, '']);
  return { CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '担当A']] }, OUTPUT: { values: output } };
}
/** OWNER_TASK に頼みを置いて、エディタからの実行と同じく引数なしで動かす */
function task(env, t) {
  env.props.OWNER_TASK = JSON.stringify(t);
  return env.call('apiOwnerTask()');
}
/** 裏の処理をトリガーで最後まで動かし、終わりの状態を受け取る（続きの段はサーバーがたどる） */
function finish(env, jobId) {
  for (let i = 0; i < 30; i++) {
    env.fireTriggers('triggerRunJob');
    const st = env.call('apiJobStatus(__in)', { __in: { jobId } });
    if (!['QUEUED', 'RUNNING', 'CONTINUED'].includes(st.status)) return st;
  }
  throw new Error('処理が終わらない');
}
const plan = (env, id) => env.table('PLANS').filter((p) => p.plan_id === id)[0];
const audits = (env, action, phase) => env.audit().filter((a) => a.action === action && (!phase || a.phase === phase));
const REFUSED = (env) => env.call('APP_MEASURE_REFUSED');
const VERSION_REFUSED = '測る専用の計画なので、公式版は出しません。';

// ==== 1. 計画を作るとき: purpose を足せる（印が PLANS に入り、作る処理の監査に残る） ====
{
  const env = setUpEnv();
  const fy = env.run('appFy_(new Date())');
  const r = task(env, { action: 'createPlan', clientName: 'テスト製薬', fy, peopleCsv: '鷹野', purpose: 'MEASURE' });
  const st = finish(env, r.result.jobId);
  assert.equal(st.status, 'DONE', st.error);
  const p = plan(env, st.result.planId);
  assert.equal(p.purpose, 'MEASURE', '測る専用の印が入る');
  assert.equal(st.result.purpose, 'MEASURE');
  assert.equal(JSON.parse(audits(env, 'PLAN.CREATE.BUILD', 'START').slice(-1)[0].detail_json).purpose, 'MEASURE', '作る処理の監査に印が残る');
  assert.equal(JSON.parse(audits(env, 'PLAN.CREATE.SAVE', 'START').slice(-1)[0].detail_json).purpose, 'MEASURE');
  // 省けば予算を立てる計画（今までどおり）。小文字でも同じ印
  const r2 = task(env, { action: 'createPlan', clientName: 'テスト薬品', fy, peopleCsv: '鷹野' });
  const st2 = finish(env, r2.result.jobId);
  assert.equal(st2.status, 'DONE', st2.error);
  assert.equal(plan(env, st2.result.planId).purpose, '', '省けば空（予算を立てる計画）');
  assert.equal(env.call('appPlanPurposeOf_("measure")'), 'MEASURE');
  // 打ち間違いは、処理を始める前に断る（頼みは残る）
  for (const bad of ['BUDGET', 1, true]) {
    const raw = JSON.stringify({ action: 'createPlan', clientName: 'テスト化学', fy, peopleCsv: '鷹野', purpose: bad });
    env.props.OWNER_TASK = raw;
    assert.throws(() => env.call('apiOwnerTask()'), /purpose は/, String(bad));
    assert.equal(env.props.OWNER_TASK, raw, '失敗したら頼みを残す');
  }
  assert.equal(env.call('appJobList_()').filter((j) => j.payload && j.payload.clientName === 'テスト化学').length, 0, '待ち行列に入れない');
  // 画面の入口（管理者）から測る専用を作ろうとしても、所有者でなければ断る（印の無い計画は今までどおり作れる）
  env.task(`saveMember({ email: '${MEMBER}', displayName: 'M' })`);
  env.task('grantRole(__in)', { __in: { email: MEMBER, role: 'ADMIN', scopeType: 'ALL' } });
  env.as(MEMBER);
  const j = env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.CREATE', payload: { clientName: 'テスト化学', fy, peopleCsv: '鷹野', purpose: 'MEASURE' } } });
  const sj = finish(env, j.jobId);
  assert.equal(sj.status, 'FAILED');
  assert.match(sj.error, /所有者だけが付けられます/);
  env.as(OWNER);
  assert.equal(env.table('PLANS').filter((x) => x.client_label === 'テスト化学').length, 0, '作らない');
}

// ==== 2. 後から: setPlanPurpose（所有者だけ・監査に前と後・同じ印なら書かない） ====
{
  const env = setUpEnv();
  const fy = env.run('appFy_(new Date())');
  const planA = env.seedPlan(env.makeBook('A', planBook('テスト製薬', fy)));
  const eng0 = JSON.stringify(env.table('ENG_ROWS')) + JSON.stringify(env.table('ENG_SHEETS'));
  const rv0 = Number(plan(env, planA).row_version);
  const r = task(env, { action: 'setPlanPurpose', planId: planA, purpose: 'MEASURE' });
  assert.deepEqual([r.result.changed, r.result.plan.purpose, r.result.before.purpose], [true, 'MEASURE', '']);
  assert.equal('OWNER_TASK' in env.props, false, '書く操作は、うまくいったら頼みを消す');
  assert.equal(plan(env, planA).purpose, 'MEASURE');
  assert.equal(Number(plan(env, planA).row_version), rv0 + 1, '行の版を上げる');
  const end = audits(env, 'PLAN.PURPOSE', 'END').slice(-1)[0];
  assert.equal(end.result, 'OK');
  assert.equal(end.actor_email, OWNER);
  assert.equal(end.entity_id, planA);
  assert.equal(JSON.parse(end.before_json).purpose, '', '監査に前の値');
  assert.equal(JSON.parse(end.after_json).purpose, 'MEASURE', '監査に後の値');
  assert.match(audits(env, 'PLAN.PURPOSE', 'START').slice(-1)[0].reason, /OWNER_TASK/);
  assert.equal(JSON.stringify(env.table('ENG_ROWS')) + JSON.stringify(env.table('ENG_SHEETS')), eng0, '計画の数字（ENG_*）は変えない');
  // 同じ印なら書かない
  const same = task(env, { action: 'setPlanPurpose', planId: planA, purpose: 'MEASURE' });
  assert.equal(same.result.changed, false);
  assert.equal(Number(plan(env, planA).row_version), rv0 + 1);
  // 外す（"" = 予算を立てる計画に戻す）
  const back = task(env, { action: 'setPlanPurpose', planId: planA, purpose: '' });
  assert.deepEqual([back.result.changed, back.result.plan.purpose, back.result.before.purpose], [true, '', 'MEASURE']);
  // 打ち間違い・印の無い頼み・無い計画は、何もせずに止める
  assert.throws(() => task(env, { action: 'setPlanPurpose', planId: planA }), /印（purpose）を入れてください/);
  assert.throws(() => task(env, { action: 'setPlanPurpose', planId: planA, purpose: 'X' }), /purpose は/);
  assert.throws(() => task(env, { action: 'setPlanPurpose', purpose: 'MEASURE' }), /計画の ID/);
  assert.throws(() => task(env, { action: 'setPlanPurpose', planId: 'PL-none', purpose: 'MEASURE' }), /計画が見つかりません/);
  assert.equal(plan(env, planA).purpose, '');
  // 所有者だけ（中の関数も確かめる。apiOwnerTask は所有者だけの入口）
  assert.throws(() => env.call(`appSetPlanPurpose_({ user: { email: '${MEMBER}', isOwner: false }, actor: '${MEMBER}', roles: [] }, { planId: '${planA}', purpose: 'MEASURE' })`), /所有者だけ/);
  env.task(`saveMember({ email: '${MEMBER}', displayName: 'M' })`);
  env.task('grantRole(__in)', { __in: { email: MEMBER, role: 'ADMIN', scopeType: 'ALL' } });
  env.as(MEMBER);
  env.props.OWNER_TASK = JSON.stringify({ action: 'setPlanPurpose', planId: planA, purpose: 'MEASURE' });
  assert.throws(() => env.call('apiOwnerTask()'), /権限がありません/, '管理者でも所有者でなければ断る');
  env.as(OWNER);
  assert.equal(plan(env, planA).purpose, '');
  // 承認待ちの公式版がある計画は、測る専用にしない（承認か却下が先）
  const sub = env.call('appTestVersionSubmit_(__in)', { __in: { planId: planA } });
  assert.throws(() => task(env, { action: 'setPlanPurpose', planId: planA, purpose: 'MEASURE' }), /承認待ちの公式版があります/);
  env.call('appTestVersionDecide_(__in)', { __in: { versionId: sub.version.versionId, decision: 'REJECTED', note: '見直す', rowVersion: sub.version.rowVersion } });
  assert.equal(task(env, { action: 'setPlanPurpose', planId: planA, purpose: 'MEASURE' }).result.changed, true, '却下の後は付けられる');
  // 書きかけの保存があるときは止める
  env.props.APP_WRITE_JOURNAL = JSON.stringify({ id: 'JNL-x', fileId: '', label: 'x', planId: planA, at: '' });
  assert.throws(() => task(env, { action: 'setPlanPurpose', planId: planA, purpose: '' }), /保存が途中で止まっています/);
  delete env.props.APP_WRITE_JOURNAL;
  assert.equal(plan(env, planA).purpose, 'MEASURE', '書かない');
}

// ==== 3. 測る専用は 5 計画まで（付け直しでも作るときでも。保管をやめた計画は数えない） ====
{
  const env = setUpEnv();
  const fy = env.run('appFy_(new Date())');
  assert.equal(env.call('APP_MEASURE_PLAN_MAX'), 5);
  const ids = ['甲', '乙', '丙', '丁', '戊', '己'].map((c, i) => env.seedPlan(env.makeBook('B' + i, planBook(c + '製薬', fy))));
  ids.slice(0, 5).forEach((id) => assert.equal(task(env, { action: 'setPlanPurpose', planId: id, purpose: 'MEASURE' }).result.changed, true));
  assert.throws(() => task(env, { action: 'setPlanPurpose', planId: ids[5], purpose: 'MEASURE' }), /測る専用の計画は 5 つまでです（今 5 つ）/);
  assert.equal(plan(env, ids[5]).purpose, '');
  assert.equal(audits(env, 'PLAN.PURPOSE', 'END').slice(-1)[0].result, 'FAILED', '断ったことも監査に残る');
  // 作るときも同じ（組み立ての前に断る）
  const r = task(env, { action: 'createPlan', clientName: '庚製薬', fy, peopleCsv: '鷹野', purpose: 'MEASURE' });
  const st = finish(env, r.result.jobId);
  assert.equal(st.status, 'FAILED');
  assert.match(st.error, /5 つまで/);
  assert.equal(env.table('PLANS').filter((x) => x.client_label === '庚製薬').length, 0);
  // すでに測る専用の計画の付け直し（同じ印）は数に関係なく通る
  assert.equal(task(env, { action: 'setPlanPurpose', planId: ids[0], purpose: 'MEASURE' }).result.changed, false);
  // 保管をやめた計画は数えない
  env.run(`appWithLock_(() => appUpdateByKey_('PLANS', { plan_id: '${ids[1]}' }, { state: 'ARCHIVED' }, APP_ROW_UNCHECKED, 'test'))`);
  assert.equal(task(env, { action: 'setPlanPurpose', planId: ids[5], purpose: 'MEASURE' }).result.changed, true);
}

// ==== 4. 予算の保存・公式版・A-4 を断る（始める前と、途中で印が付いたとき）。計画の画面は止めている操作と同じに出す ====
{
  const env = setUpEnv();
  const fy = env.run('appFy_(new Date())');
  const planA = env.seedPlan(env.makeBook('A', planBook('テスト製薬', fy)));
  const planM = env.seedPlan(env.makeBook('M', planBook('テスト薬品', fy)));
  task(env, { action: 'setPlanPurpose', planId: planM, purpose: 'MEASURE' });
  const R = REFUSED(env);
  assert.deepEqual(Object.keys(R).sort(), ['AI.RESEARCH', 'BUDGET.SAVE']);
  const jobs0 = env.call('appJobList_()').length;
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.EDIT', payload: { planId: planM, action: 'BUDGET.SAVE', args: { rows: [{ row: 29, adopted: 1, uplift: '' }] } } } }),
    /測る専用の計画なので、予算は立てません。/);
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.RUN', payload: { planId: planM, action: 'AI.RESEARCH' } } }), /測る専用の計画なので、市場は調べません/);
  assert.equal(env.call('appJobList_()').length, jobs0, '待ち行列に入れない');
  assert.throws(() => env.call('appTestVersionSubmit_(__in)', { __in: { planId: planM } }), new RegExp(VERSION_REFUSED));
  assert.equal(env.table('PLAN_VERSIONS').length, 0, '公式版を書かない');
  // 予算を立てる計画は今までどおり（公式版を出せる）
  assert.equal(env.call('appTestVersionSubmit_(__in)', { __in: { planId: planA } }).version.no, 1);
  // 公式版の画面: 出せない（can.submit が false）・印を返す
  const vm1 = env.call('apiVersionList(__in)', { __in: { planId: planM } });
  assert.deepEqual([vm1.measure, vm1.can.submit, vm1.can.approve], [true, false, true]);
  const va = env.call('apiVersionList(__in)', { __in: { planId: planA } });
  assert.deepEqual([va.measure, va.can.submit], [false, true]);
  // 計画の画面: 断る操作は止めている操作と同じ（paused に理由）。ほかの操作・予算を立てる計画は止めない
  const view = env.call('apiPlanView(__in)', { __in: { planId: planM } });
  assert.equal(view.plan.measure, true);
  const paused = (v, a) => v.actions.filter((x) => x.action === a)[0].paused;
  assert.equal(paused(view, 'BUDGET.SAVE'), R['BUDGET.SAVE']);
  assert.equal(paused(view, 'AI.RESEARCH'), R['AI.RESEARCH']);
  assert.equal(paused(view, 'INPUT.SAVE'), '');
  assert.equal(paused(view, 'IMPORT.SALES'), '', '売上の取り込みは使う（過去の売上だけを取り込む計画）');
  assert.equal(paused(view, 'REVIEW.GENERATE'), env.run('APP_REVIEW_GENERATE_PAUSED'), '止めている操作の理由はそのまま');
  const viewA = env.call('apiPlanView(__in)', { __in: { planId: planA } });
  assert.equal(viewA.plan.measure, false);
  assert.deepEqual([paused(viewA, 'BUDGET.SAVE'), paused(viewA, 'AI.RESEARCH')], ['', '']);
  // 予算を立てる計画の予算の保存を待ち行列に入れた後で、測る専用の印が付いた: 動かす前に断る（何も書かない）
  const out0 = JSON.stringify(env.table('ENG_ROWS').filter((r) => r.plan_id === planA));
  const j = env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.EDIT', payload: { planId: planA, action: 'BUDGET.SAVE', args: { rows: [{ row: 29, adopted: 5, uplift: '' }] },
    inputHash: env.run('appTestPlanHash_(__p)', { __p: planA }) } } });
  if (j.status === 'QUEUED') {
    env.call(`appWithLock_(() => appUpdateByKey_('PLANS', { plan_id: '${planA}' }, { purpose: 'MEASURE' }, APP_ROW_UNCHECKED, 'test'))`);
    const st = finish(env, j.jobId);
    assert.equal(st.status, 'FAILED');
    assert.equal(st.error, R['BUDGET.SAVE'], '途中で印が付いた計画も止める');
    assert.equal(JSON.stringify(env.table('ENG_ROWS').filter((r) => r.plan_id === planA)), out0, '書かない');
  } else {
    assert.fail('予算の保存が、始めたその場で動いた（このテストは待ち行列に入る前提）: ' + JSON.stringify(j));
  }
}

// ==== 5. 自動の AI 調査・着地の τ・w の学び・ホームと分析の合計に入らない（行には印つきで残る） ====
{
  const env = setUpEnv();
  const fy = env.run('appFy_(new Date())');
  const planA = env.seedPlan(env.makeBook('A', planBook('テスト製薬', fy, 80)));    // 予算 960
  const planB = env.seedPlan(env.makeBook('B', planBook('テスト化学', fy, 100)));   // 予算 1,200
  const planM = env.seedPlan(env.makeBook('M', planBook('テスト薬品', fy, 500)));   // 測る専用（予算の欄 6,000 は数えない）
  env.run('var __priorN = []; var __priorOrig = appLandingPrior_; appLandingPrior_ = function (plans) { __priorN.push(plans.length); return __priorOrig(plans); };');
  const before = env.call('apiCrossMaker(__in)', { __in: {} }).totals;
  assert.deepEqual([before.plans, before.budget, before.measurePlans], [3, 960 + 1200 + 6000, 0], '印の前は 3 計画');
  task(env, { action: 'setPlanPurpose', planId: planM, purpose: 'MEASURE' });
  // 自動の AI 調査の候補にしない
  const auto = env.call(`appAutoResearchPlans_(${fy})`).map((p) => p.planId);
  assert.deepEqual(auto.slice().sort(), [planA, planB].sort(), '測る専用の計画は自動で調べない');
  // 計画の一覧（予測の画面）・計画の要点に印
  assert.equal(env.call('apiListPlans()').plans.filter((p) => p.planId === planM)[0].measure, true);
  assert.equal(env.call('apiListPlans()').plans.filter((p) => p.planId === planA)[0].measure, false);
  const pf = env.call('apiPortfolio()').plans;
  assert.deepEqual(pf.map((p) => [p.planId, p.measure]).sort(), [[planA, false], [planB, false], [planM, true]].sort());
  // 着地の τ・w の学びには、測る専用の計画を渡さない
  const n = env.call('__priorN');
  assert.equal(n[n.length - 1], 2, '全計画の学びに入れるのは予算を立てる 2 計画: ' + JSON.stringify(n));
  // ホームの合計: 予算・計画の数に入れない（行は印つきで返す）
  const home = env.call('apiHome()');
  assert.equal(home.fy, String(fy));
  assert.deepEqual([home.totals.plans, home.totals.budget, home.totals.budgetPlans], [2, 960 + 1200, 2], JSON.stringify(home.totals));
  assert.equal(home.plans.filter((p) => p.planId === planM)[0].measure, true);
  // 合計の中身の関数も（見せる年度の計画のうち、印の無いものだけ）
  const t = env.call('appHomeTotals_(__p, __fy)', { __p: [{ fy: '2026', budgetUsed: 100, landing: 90, landingSd: 5, actualYtd: 10 }, { fy: '2026', budgetUsed: 900, landing: 950, landingSd: 9, actualYtd: 90, measure: true }], __fy: '2026' });
  assert.deepEqual([t.plans, t.budget, t.landing, t.actualYtd, t.ratioPlans], [1, 100, 90, 10, 1]);
  assert.equal(t.reach.plans, 1, '合計の届く見込みにも入れない');
  // 分析の合計: 入れない。行には残す（外れ幅などは出す）
  const x = env.call('apiCrossMaker(__in)', { __in: {} });
  assert.deepEqual([x.totals.plans, x.totals.budget, x.totals.budgetPlans, x.totals.measurePlans], [2, 960 + 1200, 2, 1], JSON.stringify(x.totals));
  assert.equal(x.totals.budgetDraft, 960 + 1200);
  assert.equal(x.totals.p50, 2000, '年度の中心の合計も 2 計画');
  assert.equal(x.plans.length, 3, '行には残す');
  assert.equal(x.plans.filter((p) => p.planId === planM)[0].measure, true);
}

// ==== 6. 年度を締める条件（公式版）に入らない・年度の控えには入る ====
{
  const env = setUpEnv();
  const past = env.run('appFy_(new Date())') - 1;
  const planA = env.seedPlan(env.makeBook('A', planBook('テスト製薬', past)));
  const planM = env.seedPlan(env.makeBook('M', planBook('テスト薬品', past)));
  const sub = env.call('appTestVersionSubmit_(__in)', { __in: { planId: planA } });
  env.call('appTestVersionDecide_(__in)', { __in: { versionId: sub.version.versionId, decision: 'APPROVED', rowVersion: sub.version.rowVersion } });
  assert.match(env.task('yearPreview(__in)', { __in: { fy: past } }).reason, /公式版のない計画/, '印の前は締められない');
  task(env, { action: 'setPlanPurpose', planId: planM, purpose: 'MEASURE' });
  const pv = env.task('yearPreview(__in)', { __in: { fy: past } });
  assert.equal(pv.canClose, true, pv.reason);
  assert.equal(pv.planCount, 2, '控えには測る専用の計画も入る');
  const snap = JSON.parse(env.run(`appYearSnapshot_(${past}).text`));
  const plans = snap.tables.filter((t) => t.name === 'PLANS')[0];
  const col = plans.columns.indexOf('purpose');
  const idCol = plans.columns.indexOf('plan_id');
  assert.ok(col > 0);
  const rowM = plans.rows.filter((r) => String(r[idCol]).includes(planM))[0];
  assert.ok(rowM && String(rowM[col]).includes('MEASURE'), '控えの PLANS の行に印: ' + JSON.stringify(rowM));
  assert.ok(snap.tables.filter((t) => t.name === 'ENG_ROWS')[0].rows.some((r) => JSON.stringify(r).includes(planM)), '計画の明細も控えに入る');
  // 締めた年度の計画の印は変えない
  const job = env.call('apiStartJob(__in)', { __in: { kind: 'YEAR.CLOSE', payload: { fy: past, inputHash: pv.inputHash } } });
  assert.equal(finish(env, job.jobId).status, 'DONE');
  assert.throws(() => task(env, { action: 'setPlanPurpose', planId: planM, purpose: '' }), /締め/);
  assert.equal(plan(env, planM).purpose, 'MEASURE');
}

// ==== 7. 画面: 印を付けて分け、合計に入れない（UI.html の script を vm で読む。中身はモックのサーバーの返り値） ====
{
  const env = setUpEnv();
  const fy = env.run('appFy_(new Date())');
  const planA = env.seedPlan(env.makeBook('A', planBook('テスト製薬', fy, 80)));
  const planM = env.seedPlan(env.makeBook('M', planBook('テスト薬品', fy, 500)));
  task(env, { action: 'setPlanPurpose', planId: planM, purpose: 'MEASURE' });
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: (t, k) => "<i data-pose=\\"" + String(k) + "\\"></i>" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
  const ui = vm.createContext({ document: { getElementById: () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} }), querySelector: () => null, addEventListener() {} },
    setTimeout: () => 0, clearTimeout() {}, confirm: () => false, window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  const run = (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };
  const clean = (html, what) => { assert.ok(!/undefined|NaN/.test(html), what + 'に undefined や NaN を出さない'); return html; };

  // メーカーの一覧: 状態の札の代わりに印・空模様と予算は出さない・合計は予算を立てるメーカーだけ・合計の行の後ろに分ける
  const pf = env.call('apiPortfolio()').plans;
  const mk = clean(run(`S.pf = __p; S.mkFy = __fy; viewMakers()`, { __p: pf, __fy: String(fy) }), 'メーカーの一覧');
  assert.match(mk, /<span class="chip st off" data-tip="測る専用の計画です。[^"]*">測る専用<\/span>/, '状態の列の札（ほかの状態の札と同じ幅）');
  assert.match(mk, /<span class="chip off" data-tip="[^"]*">測る専用 1<\/span>/, '状態の数の横に、測る専用の数');
  const states = [...mk.matchAll(/>(承認済み|承認待ち|策定中|未着手) (\d+)<\/span>/g)].reduce((n, x) => n + Number(x[2]), 0);
  assert.equal(states, 1, '状態の数は予算を立てるメーカーだけ');
  const foot = /<tr class="total">([\s\S]*?)<\/tr>/.exec(mk)[1];
  assert.match(foot, /data-tip="測る専用の 1 メーカーは入れていません">1 メーカー<\/td><td class="num">960<\/td>/, '合計の予算は 960（測る専用の 6,000 は入れない）: ' + foot);
  assert.ok(mk.indexOf('<tr class="total">') < mk.indexOf('テスト薬品'), '測る専用の行は合計の行の後ろ');
  assert.ok(mk.indexOf('テスト製薬') < mk.indexOf('<tr class="total">'));
  const rowM = /<tr><td class="wrap">[^]*?テスト薬品[^]*?<\/tr>/.exec(mk.slice(mk.indexOf('<tr class="total">')))[0];
  assert.match(rowM, /<td>-<\/td><td><span class="chip st off"[^>]*>測る専用<\/span><\/td><td class="num">-<\/td>/, '空模様・予算は出さない');

  // ホーム: 測る専用の計画は見せる年度の計画に入れない（合計・空模様・よみの話）
  const home = env.call('apiHome()');
  run('B.home = __h', { __h: home });
  assert.deepEqual(run('homePlans(B.home).map(function(p){ return p.planId; })'), [planA]);
  const h = clean(run(`S.view = 'home'; S.lr.ai = null; viewHome()`), 'ホーム');
  assert.doesNotMatch(h, /テスト薬品/, 'ホームに出さない');
  assert.match(h, /<div class="k">年間予算<\/div><div class="v">960<span class="u">円<\/span><\/div>[^]*?1 メーカー/, 'ホームの年間予算は 960（測る専用の 6,000 は入れない）');

  // 分析: 合計・空模様・予算のグラフに入れず、数と名前（カーソル）を添える
  const an = env.call('apiCrossMaker(__in)', { __in: {} });
  const a = clean(run(`S.view = 'analysis'; S.an.data = __a; S.an.fy = __a.fy; S.an.tab = 'overview'; viewAnalysis()`, { __a: an }), '分析');
  assert.match(a, /<p class="note anx" data-tip="測る専用の計画です。予算は立てず、合計・空模様・予算と比べるグラフには入れません（外れ幅・読みのクセ・見直しの流れには入れます）\nテスト薬品">測る専用 1<\/p>/);
  const board = /<div class="ansky">([\s\S]*?)<\/div><\/div>(?=<p|<div class="guide"|<div class="card")/.exec(a);
  assert.ok(board && !board[1].includes('テスト薬品') && board[1].includes('テスト製薬'), '空模様の板は予算を立てるメーカーだけ');
  assert.doesNotMatch(a, /<div class="k">年間予算<\/div>/, '年度の合計の数字はホームだけ（分析はメーカーを並べて読み解く画面。2026-10-13）');
  // 測る専用の計画だけの年度: 合計と空模様は出さず、数を出す
  const onlyM = Object.assign({}, an, { plans: an.plans.filter((p) => p.measure) });
  const a2 = clean(run(`S.an.data = __a; viewAnalysis()`, { __a: onlyM }), '分析（測る専用だけ）');
  assert.doesNotMatch(a2, /見通しの空模様|<div class="k">年間予算/);
  assert.match(a2, /測る専用 1<\/p>/);
  assert.doesNotMatch(a2, /着地の推定や/, '着地の推定の話をしない');

  // 予測: 題の横に印・予算の欄と保存と届く見込みを出さない・公式版は出さないと言う・A-4 は押せない（理由はカーソル）
  const fc = (id) => {
    const d = env.call('apiForecastLatest(__in)', { __in: { planId: id } });
    const v = env.call('apiPlanView(__in)', { __in: { planId: id } });
    // 月ごとの予算の欄（旧来の画面の中身の形。モックの旧来の画面は月の行を読まないので、ここで入れる）
    v.boot.output.sections[0].monthly = Array.from({ length: 12 }, (_, i) => ({ row: 29 + i, month: fy + '/' + String(i + 1).padStart(2, '0'), p10: 70, p50: 80, p90: 90, adopted: 80, uplift: '', final: 80 }));
    run(`S.fc.plans = __l; S.fc.planId = __id; S.fc.view = __v; S.fc.data = __d; S.fc.budget = {}; S.fc.confirm = null; S.fc.tab = 'forecast'`, { __l: env.call('apiListPlans()').plans, __id: id, __v: v, __d: d });
    return { d, v };
  };
  const m = fc(planM);
  const head = clean(run('viewForecast()'), '予測（測る専用）');
  assert.match(head, /<h1>予測[\s\S]*?<span class="chip off" data-tip="測る専用の計画です。[^"]*">測る専用<\/span><\/h1>/);
  assert.match(head, /テスト薬品 FY\d{4}（測る専用）<\/option>/, '選ぶ欄にも印');
  const tabM = clean(run('fcForecastTab(__d, __v)', { __d: m.d, __v: m.v }), '予測と予算（測る専用）');
  assert.doesNotMatch(tabM, /fcBudget\(|fcSaveBudget\(\)|この予算に/, '予算の欄・保存・届く見込みを出さない');
  assert.match(tabM, /fcForecastRun\(\)/, '予測の実行は出す（物差しの点を作る）');
  const stepsM = clean(run('fcStepsTab(__d, __v)', { __d: m.d, __v: m.v }), '進み（測る専用）');
  assert.match(stepsM, /<span class="act" data-tip="市場・競合の動きを AI で調べる\n測る専用の計画なので、市場は調べません（費用のため）。"><button class="btn btn-ghost" disabled aria-disabled="true">市場を調べる<\/button><\/span>/);
  assert.doesNotMatch(stepsM, /fcRun\('AI\.RESEARCH'\)/);
  assert.match(stepsM, /fcRun\('SALES\.AGGREGATE'\)/, 'ほかの準備は押せる');
  run('S.fc.ver = __r', { __r: env.call('apiVersionList(__in)', { __in: { planId: planM } }) });
  const verM = clean(run('fcVersionTab(S.fc.data, S.fc.view)'), '公式版（測る専用）');
  assert.match(verM, /測る専用の計画なので、公式版は出しません。/);
  assert.doesNotMatch(verM, /verSubmit\(\)/);
  // 予算を立てる計画は今までどおり
  const A = fc(planA);
  const headA = run('viewForecast()');
  assert.doesNotMatch(headA, /<h1>[^]*?測る専用[^]*?<\/h1>/);
  const tabA = clean(run('fcForecastTab(__d, __v)', { __d: A.d, __v: A.v }), '予測と予算');
  assert.match(tabA, /fcBudget\(/);
  assert.match(tabA, /fcSaveBudget\(\)/);
  assert.match(clean(run('fcStepsTab(__d, __v)', { __d: A.d, __v: A.v }), '進み'), /fcRun\('AI\.RESEARCH'\)/);
  run('S.fc.ver = __r', { __r: env.call('apiVersionList(__in)', { __in: { planId: planA } }) });
  assert.match(run('fcVersionTab(S.fc.data, S.fc.view)'), /verSubmit\(\)/);
  // 画面の名前は 8 字まで・中の印（MEASURE）を見せない
  assert.ok('測る専用'.length <= 8);
  for (const html of [mk, h, a, head, tabM, stepsM, verM]) assert.doesNotMatch(html.replace(/<[^>]*>/g, ' '), /MEASURE|purpose/, '中の印を見せない');
}

console.log('app-v10-measure: ok');
