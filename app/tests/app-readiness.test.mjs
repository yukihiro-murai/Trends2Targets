#!/usr/bin/env node
/*
 * app-readiness.test.mjs — 公開前の点検（P1）。権限の fail-closed・クライアント単位の役割・
 * 同時に使うときの止め方（入力のハッシュ・処理の busy）・権限のない人に書き込みのボタンを出さない画面。
 * 想定される役割は実装からは推測しない（下の一覧は仕様の静的な表）。
 *
 *   node app/tests/app-readiness.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { J, OWNER, MEMBER, OTHER, OUTSIDER, fcSection, setUpEnv, uiHtml } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
/** 見本の計画のブック（clientName でクライアントを分ける）。入力・予算・提案つき */
function planBook(env, clientName) {
  const output = [['FY2026 売上予測']];
  for (let r = 2; r <= 23; r++) output.push([]);
  output.push([' 混合（主要）']);
  output.push([]);
  output.push(['年度合計（予測）', 900, 1000, 1100]);
  output.push([], []);
  ['2026/04', '2026/05', '2026/06', '2026/07', '2026/08', '2026/09', '2026/10', '2026/11', '2026/12', '2027/01', '2027/02', '2027/03']
    .forEach((m) => output.push([m, 70, 80, 90]));
  const formulas = { H26: '=SUM(H29:H40)', I26: '=SUM(I29:I40)', J26: '=SUM(J29:J40)' };
  for (let i = 0; i < 12; i++) formulas['J' + (29 + i)] = `=H${29 + i}+I${29 + i}`;
  return env.makeBook('クライアント別売上予測 ' + clientName, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', clientName], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '担当A,担当B']] },
    OUTPUT: { values: output, formulas, formats: { A: '@' } },
    PRODUCT: { values: [['Person', 'ProductName', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason'], ['担当A', '製品A', D(2026, 5), 5, '新規']] },
    CLIENT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']] },
    OPINIONS: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Confidence(0..1)', 'Note']] },
    DEV_SPOT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Project', 'Amount(JPY)', 'Confidence(0..1)']] },
    PROCESS_STATUS: { values: [['step_key', 'last_run_date', 'last_run_by', 'status', 'target_client', 'record_count', 'error_summary'],
      ['step4_status', D(2026, 9, 1), 'owner', 'success', clientName, 12, '']] },
    SALES_INPUT: { values: [['client', 'service_type', 'product', 'target_month', 'input_amount', 'status', 'source_updated_at']] },
    RUN_LOG: { values: [['run_id', 'run_at', 'run_by', 'function_name', 'client', 'status', 'count', 'model_version', 'parameters_snapshot_json', 'input_data_hash', 'execution_duration_sec', 'error_summary']] },
    QUARTERLY_REVIEW: { values: [['四半期レビュー'], ['2026/04〜2026/06'], [], [], [], [],
      ['proposal_id', 'target', 'current', 'proposed', 'conf', 'rationale', 'impact', '承認', 'rollback', 'review_id'],
      ['P1', 'bias_correction_factor', 1, 0.98, 0.7, '過大', '-2%', '', 1, 'R-1']] },
  });
}
const seeded = () => {
  const env = setUpEnv();
  const planId = env.seedPlan(planBook(env, 'テスト製薬'));
  const planId2 = env.seedPlan(planBook(env, '別の製薬'));
  const clientId = env.table('PLANS').filter((p) => p.plan_id === planId)[0].client_id;
  const clientId2 = env.table('PLANS').filter((p) => p.plan_id === planId2)[0].client_id;
  return { env, planId, planId2, clientId, clientId2 };
};
const deny = (env, code, extra, re) => assert.throws(() => env.call(code, extra), re || /権限がありません/, code);
/** 所有者の操作（apiOwnerTask。管理の操作は 2026-10-13 からここだけ）を断る */
const denyTask = (env, expr, extra) => assert.throws(() => env.task(expr, extra), /権限がありません/, expr);
const jobProps = (env) => env.run(`appProps_().getKeys().filter(k => k.indexOf('APP_JOB_') === 0)`).length;

// 仕様の静的な表（実装から推測しない。変更するときはこの表を先に合わせる）
const JOB_KINDS_PUBLIC = ['FORECAST.RUN', 'PLAN.EDIT', 'PLAN.RUN', 'PLAN.CREATE', 'LEARN.POOL', 'YEAR.CLOSE', 'SYSTEM.RECOVER'];
const JOB_KINDS_INTERNAL = ['FORECAST.RUN_CALC', 'FORECAST.RUN_SAVE', 'PLAN.RUN_CALC', 'PLAN.RUN_SAVE', 'PLAN.CREATE_SAVE'];
// CALIBRATION.SET（補正の値）は所有者だけ（管理者の役割があっても断る。app-calibration.test.mjs）
const EDIT_ACTIONS = ['INPUT.SAVE', 'BUDGET.SAVE', 'INSIGHT.SAVE', 'REVIEW.DECIDE', 'SETUP.PEOPLE', 'CALIBRATION.SET'];
const RUN_ACTIONS = ['IMPORT.SALES', 'IMPORT.ACTUALS', 'SALES.AGGREGATE', 'AI.RESEARCH',
  'EVAL.REPORT', 'EVAL.DASHBOARD', 'EVAL.INSIGHTS', 'LEARN.MONTHLY', 'REVIEW.GENERATE', 'REVIEW.APPLY'];

// ==== 1. 社内のふつうの人（閲覧・情報提供だけ）は、書き込み・実行の入口を全部断る ====
{
  const { env, planId, clientId } = seeded();
  env.as(OWNER);
  env.call('appTestVersionSubmit_(__in)', { __in: { planId, note: 'v1' } });   // 承認の選択が解る承認待ちを作る
  const versionId = env.table('PLAN_VERSIONS').filter((v) => v.state === 'SUBMITTED')[0].version_id;
  const before = Object.fromEntries(['MEMBERS', 'CLIENTS', 'ROLES', 'SETTINGS', 'PLANS', 'PLAN_VERSIONS'].map((t) => [t, JSON.stringify(env.table(t))]));
  env.as(MEMBER);
  // 管理者・所有者だけの入口
  deny(env, 'apiSetup()');
  deny(env, 'apiAuthorizeAi()');
  deny(env, 'apiOwnerTask()');
  denyTask(env, `saveMember({ email: '${OTHER}', displayName: 'X' })`);
  denyTask(env, `grantRole({ email: '${OTHER}', role: 'PLANNER' })`);
  denyTask(env, `revokeRole({ roleId: '${'RL-1'}' })`);
  denyTask(env, `saveClientName({ clientId: '${clientId}', displayName: 'X' })`);
  denyTask(env, `saveClient({ clientName: '新しいクライアント' })`);
  denyTask(env, `saveSetting({ key: 'source.zac_spreadsheet', value: 'https://x' })`);
  denyTask(env, 'verifyAudit()');
  denyTask(env, 'runHousekeeping()');
  denyTask(env, 'enableBackup()');
  denyTask(env, 'runBackup()');
  denyTask(env, 'poolPreview()');
  denyTask(env, `planCandidates({})`);
  delete env.props.OWNER_TASK;
  // 公式版（選択が解ける実在の計画・版を渡す → 選んでから門で断る）
  deny(env, `apiVersionSubmit({ planId: '${planId}' })`);
  deny(env, `apiVersionDecide({ versionId: '${versionId}', decision: 'APPROVED' })`);
  // 処理の入口: 画面から始められる種類は全部断る（選択が解ける実在の計画を渡す）
  for (const kind of JOB_KINDS_PUBLIC) {
    const payload = kind === 'PLAN.CREATE' ? { clientName: 'x', fy: 2026, peopleCsv: 'a' }
      : kind === 'PLAN.EDIT' ? { planId, action: 'INPUT.SAVE', args: { kind: 'product', rows: [] } }
      : kind === 'PLAN.RUN' ? { planId, action: 'EVAL.DASHBOARD' }
      : { planId };
    deny(env, 'apiStartJob(__in)', { __in: { kind, payload } });
  }
  for (const kind of JOB_KINDS_INTERNAL) deny(env, `apiStartJob({ kind: '${kind}', payload: {} })`, null, /画面から始められません/);
  for (const action of EDIT_ACTIONS) deny(env, 'apiStartJob(__in)', { __in: { kind: 'PLAN.EDIT', payload: { planId, action, args: {} } } });
  for (const action of RUN_ACTIONS) deny(env, 'apiStartJob(__in)', { __in: { kind: 'PLAN.RUN', payload: { planId, action } } });
  // 断った操作は何も書かない・処理を入れない・トリガーを作らない・メールを送らない（拒否の記録だけは残る）
  for (const t of Object.keys(before)) assert.equal(JSON.stringify(env.table(t)), before[t], t + ' の中身は変わっていない');
  assert.equal(jobProps(env), 0, '処理の記録を残さない');
  assert.equal(env.triggers.length, 0);
  assert.equal(env.state.mail.length, 0);
  assert.ok(env.audit().some((a) => a.phase === 'DENIED'), '拒否は記録に残る');
  assert.ok(env.audit().filter((a) => a.phase === 'DENIED').every((a) => a.actor_email === MEMBER));
}

// ==== 2. 社外の人・メールが取れない人: 何もできない（読み取りも含めて fail-closed） ====
{
  const { env, planId } = seeded();
  const reads = [`apiHome()`, `apiPlanView({ planId: '${planId}' })`, 'apiListPlans()', 'apiPortfolio()',
    `apiForecastLatest({ planId: '${planId}' })`, `apiForecastBasis({ planId: '${planId}' })`, `apiLearningView({ planId: '${planId}' })`,
    `apiVersionList({ planId: '${planId}' })`, `apiJobStatus({ jobId: 'JOB-x' })`];
  const ownerReads = ['listAudit({})', 'listDirectory()', 'listSettings()', 'health()', 'poolPreview()', 'planCandidates({})'];
  for (const who of [OUTSIDER, '']) {
    env.as(who);
    const b = env.boot();
    assert.equal(b.allowed, false, who);
    assert.deepEqual(b.user.roles, []);
    assert.deepEqual(Object.keys(b).sort(), ['allowed', 'app', 'setUp', 'user'], '初期データに仕事の中身を出さない: ' + who);
    for (const code of reads) deny(env, code);
    for (const expr of ownerReads) denyTask(env, expr);
  }
}

// ==== 3. クライアント単位の予算策定担当: 自分のクライアントには書ける、ほかには書けない。全体の管理はできない ====
{
  const { env, planId, planId2, clientId } = seeded();
  env.as(OWNER);
  env.task(`saveMember({ email: '${MEMBER}', displayName: 'M' })`);
  env.task('grantRole(__in)', { __in: { email: MEMBER, role: 'PLANNER', scopeType: 'CLIENT', clientId } });
  env.as(MEMBER);
  const mine = env.call(`apiPlanView({ planId: '${planId}' })`);
  const other = env.call(`apiPlanView({ planId: '${planId2}' })`);
  assert.deepEqual([mine.can.plan, mine.can.approve], [true, false], '自分のクライアントは書ける');
  assert.deepEqual([other.can.plan, other.can.approve], [false, false], 'ほかのクライアントは読むだけ');
  // ほかのクライアントの計画には書けない・全体の管理操作もできない（どれも門で断る）
  deny(env, 'apiStartJob(__in)', { __in: { kind: 'PLAN.EDIT', payload: { planId: planId2, action: 'INPUT.SAVE', args: { kind: 'product', rows: [] } } } });
  deny(env, 'apiStartJob(__in)', { __in: { kind: 'PLAN.RUN', payload: { planId: planId2, action: 'SALES.AGGREGATE' } } });
  deny(env, `apiVersionSubmit({ planId: '${planId2}' })`);
  deny(env, 'apiStartJob(__in)', { __in: { kind: 'PLAN.EDIT', payload: { planId, action: 'SETUP.PEOPLE', args: { peopleCsv: 'x' } } } }, /権限がありません/, '自分の計画でも管理者だけの操作');
  // 自分のクライアントの入力の保存は通る（実際に保存できる）
  const st = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind: 'product', rows: [{ person: '担当A', product: '製品A', ym: '2026-06', step: '10', reason: '' }] }, inputHash: mine.inputHash });
  assert.equal(st.status, 'DONE', st.error);
  assert.equal(env.table('ENG_PRODUCT').filter((r) => r.plan_id === planId).length, 1);
  // 予算の保存も通る
  const stB = env.runJob('PLAN.EDIT', { planId, action: 'BUDGET.SAVE',
    args: { rows: [{ row: 29, adopted: 85, uplift: 5 }] }, inputHash: env.call('apiPlanView(__in)', { __in: { planId } }).inputHash });
  assert.equal(stB.status, 'DONE', stB.error);
  assert.ok(env.table('ENG_ROWS').some((r) => r.plan_id === planId && r.sheet === 'OUTPUT'), '予算を OUTPUT に残す');
  // 公式版も出せる（自分のクライアントの計画）
  const sub = env.call('appTestVersionSubmit_(__in)', { __in: { planId, note: 'v1' } });
  assert.equal(sub.version.state, 'SUBMITTED');
  assert.equal(env.table('PLAN_VERSIONS').filter((v) => v.plan_id === planId && v.state === 'SUBMITTED').length, 1);
}

// ==== 4. 承認者: ほかの人が出した承認待ちを承認できる。予算策定担当は承認できない ====
{
  const { env, planId, clientId } = seeded();
  env.as(OWNER);
  env.task(`saveMember({ email: '${MEMBER}', displayName: 'M' })`);
  env.task(`saveMember({ email: '${OTHER}', displayName: 'O' })`);
  env.task('grantRole(__in)', { __in: { email: MEMBER, role: 'PLANNER', scopeType: 'CLIENT', clientId } });
  env.task('grantRole(__in)', { __in: { email: OTHER, role: 'APPROVER', scopeType: 'ALL' } });
  env.as(MEMBER);
  env.call('appTestVersionSubmit_(__in)', { __in: { planId, note: 'v1' } });
  const v1 = env.table('PLAN_VERSIONS').filter((v) => v.state === 'SUBMITTED')[0];
  deny(env, `apiVersionDecide({ versionId: '${v1.version_id}', decision: 'APPROVED' })`, null, /権限がありません/, '策定担当は承認できない');
  env.as(OTHER);
  const ok = env.call(`apiVersionDecide({ versionId: '${v1.version_id}', decision: 'APPROVED', note: 'ok', rowVersion: ${v1.row_version} })`);
  assert.equal(ok.version.state, 'APPROVED', '承認者はほかの人の版を承認できる');
  // 別の版でも同じ（出した本人ではない承認者が決める）
  env.as(OWNER);
  env.call('appTestVersionSubmit_(__in)', { __in: { planId, note: 'v2' } });
  const v2 = env.table('PLAN_VERSIONS').filter((v) => v.state === 'SUBMITTED')[0];
  env.as(OTHER);
  const ok2 = env.call(`apiVersionDecide({ versionId: '${v2.version_id}', decision: 'APPROVED', rowVersion: ${v2.row_version} })`);
  assert.equal(ok2.version.state, 'APPROVED');
}

// ==== 5. 画面: 権限のない人には保存・実行・提出・承認のボタンを出さない ====
function uiFor(env, who, isAdmin) {
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: who, isOwner: false, isAdmin: !!isAdmin, roles: [] }, setUp: true, allowed: true }));
  const el = () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
  const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, confirm: () => false,
    window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  return ui;
}
const WRITE_MARKS = /fcRun\(|fcEdit\(|fcSaveInput|fcSaveIns|fcSaveDec|fcRvGo\(|verSubmit|verDecide|startJob\(|fcInputAdd|fcInputDel|fcBudget\(|fcDec\(|fcIns\(|fcInput\(/;
{
  const { env, planId, planId2 } = seeded();
  env.as(OWNER);
  env.call('appTestVersionSubmit_(__in)', { __in: { planId, note: 'v1' } });   // 承認待ちがある状態で描く
  // 閲覧だけの社内の人
  env.as(MEMBER);
  const view = env.call('apiPlanView(__in)', { __in: { planId } });
  assert.deepEqual([view.can.plan, view.can.approve, view.can.admin], [false, false, false]);
  const ui = uiFor(env, MEMBER);
  ui.fcSection = fcSection;
  ui.__v = view; ui.__ver = env.call('apiVersionList(__in)', { __in: { planId } }); ui.__learn = env.call('apiLearningView(__in)', { __in: { planId } });
  vm.runInContext(`S.view='forecast'; S.fc.plans=[{planId:'${planId}'}]; S.fc.planId='${planId}'; S.fc.view=__v; S.fc.learn=__learn; S.fc.ver=__ver; S.fc.data={plan:__v.plan,latest:null,runs:[],stored:null};`, ui);
  for (const tab of ['forecast', 'input', 'review', 'version', 'steps']) {
    const html = vm.runInContext(`S.fc.inputKind='product'; fcSection(viewForecastAll(), '${tab}')`, ui);
    assert.doesNotMatch(html, WRITE_MARKS, `閲覧の人の ${tab} タブに書き込みの操作を出さない`);
    assert.ok(html, tab + ' の区切りがある');
    assert.doesNotMatch(html, /<input|<select/, tab + ' の区切りに入力欄を出さない');
  }
  assert.doesNotMatch(vm.runInContext(`fcSection(viewForecastAll(), 'forecast')`, ui), /fcForecastRun\(\)/, '閲覧の人には予測を実行を出さない（注記も出さない。2026-10-13）');
  assert.match(vm.runInContext(`fcSection(viewForecastAll(), 'input')`, ui), /入力は予算策定担当ができます/);
  assert.match(vm.runInContext(`fcSection(viewForecastAll(), 'review')`, ui), /承認は承認者ができます/);
  assert.match(vm.runInContext(`fcSection(viewForecastAll(), 'version')`, ui), /承認者が承認します/, '承認待ちを見せるが操作は出さない');
  // 担当者は見るだけ（画面からは変えない。変えるのは所有者がエディタから。2026-10-06 村井さん）
  assert.match(vm.runInContext(`fcSection(viewForecastAll(), 'steps')`, ui), /担当者[\s\S]*変えるのは所有者です/);
  // 入力が空の画面でも同じ（読むだけ。操作は出さない）
  const empty = env.call('apiPlanView(__in)', { __in: { planId: planId2 } });
  ui.__v2 = empty; ui.__ver2 = env.call('apiVersionList(__in)', { __in: { planId: planId2 } });
  vm.runInContext(`S.fc.view=__v2; S.fc.ver=__ver2; S.fc.inputKind='devspot';`, ui);
  for (const tab of ['forecast', 'input', 'review', 'version', 'steps']) {
    assert.doesNotMatch(vm.runInContext(`fcSection(viewForecastAll(), '${tab}')`, ui), WRITE_MARKS, `空の画面（${tab}）でも操作を出さない`);
  }
  // ホームの役割の札は 2026-10-06 に外した（情報利得がない。村井さん）
  assert.equal(vm.runInContext(`typeof homeRolesCard`, ui), 'undefined');
  // ボタンの名前は 8 字まで（長い名前はツールチップへ）
  const shorts = vm.runInContext(`JSON.stringify(FC_ACTION_SHORT)`, ui);
  assert.ok(Object.values(JSON.parse(shorts)).every((s) => s.length <= 8), 'ボタンの名前は 8 字まで');
  // 承認者（APPROVER は PLANNER を含む役割の階層）: 策定と承認の操作は出る。管理者だけの操作は出ない
  env.as(OWNER);
  env.task(`saveMember({ email: '${OTHER}', displayName: 'O' })`);
  env.task('grantRole(__in)', { __in: { email: OTHER, role: 'APPROVER', scopeType: 'ALL' } });
  env.as(OTHER);
  const av = env.call('apiPlanView(__in)', { __in: { planId } });
  assert.deepEqual([av.can.plan, av.can.approve, av.can.admin], [true, true, false], '承認者は策定と承認を持つが管理者ではない');
  const ua = uiFor(env, OTHER);
  ua.fcSection = fcSection;
  ua.__v = av;
  vm.runInContext(`S.fc.plans=[{planId:'${planId}'}]; S.fc.planId='${planId}'; S.fc.view=__v; S.fc.data={plan:__v.plan,latest:null,runs:[],stored:null};`, ua);
  const q = vm.runInContext(`fcSection(viewForecastAll(), 'review')`, ua);
  assert.match(q, /fcRvGo\(/, '承認者には「承認して反映」（判断の保存 → 見直しを反映）を出す');
  assert.match(q, /fcRun\('EVAL.INSIGHTS'\)/, '策定の実行も出る（承認者は策定担当の役割を含む）');
  // 見直し案を作る（C-1）は止めている（2026-10-07 所有者の決定）: 押せないボタンにして、理由はカーソルで出す
  assert.doesNotMatch(q, /fcRun\('REVIEW.GENERATE'\)/, '見直し案を作る操作は押せない');
  assert.match(q, /data-tip="AI の見直し案を作る\n見直し案を作る操作は、学びの仕組みを直すまで止めています（2026\/10\/07 所有者の決定）。"><button class="btn btn-ghost" disabled aria-disabled="true">見直し案を作る<\/button>/);
  assert.match(q, /fcDec\(/, '承認の選択は出す');
  const ev = vm.runInContext(`fcSection(viewForecastAll(), 'review')`, ua);
  assert.match(ev, /fcRun\('EVAL.REPORT'\)/, '策定の実行は出る');
  assert.doesNotMatch(ev, /IMPORT.ACTUALS/, '管理者だけの取り込みは出さない');
  const st = vm.runInContext(`fcSection(viewForecastAll(), 'steps')`, ua);
  assert.match(st, /fcRun\('SALES.AGGREGATE'\)/, '策定の実行は出る');
  assert.doesNotMatch(st, /IMPORT.SALES|fc_people/, '管理者だけの操作は出さない');
  assert.match(st, /担当者[\s\S]*変えるのは所有者です/);
  assert.match(vm.runInContext(`fcSection(viewForecastAll(), 'input')`, ua), /fcInput\(|fcSaveInput/, '入力の保存は出る');
}

// ==== 6. 2 人が同じ計画を同時に開いて保存: 入力のハッシュで後の人を止める（データは壊れない） ====
{
  const { env, planId, planId2, clientId } = seeded();
  env.as(OWNER);
  env.task(`saveMember({ email: '${MEMBER}', displayName: 'M' })`);
  env.task(`saveMember({ email: '${OTHER}', displayName: 'O' })`);
  env.task('grantRole(__in)', { __in: { email: MEMBER, role: 'PLANNER', scopeType: 'CLIENT', clientId } });
  env.task('grantRole(__in)', { __in: { email: OTHER, role: 'PLANNER', scopeType: 'CLIENT', clientId } });
  env.as(MEMBER);
  const viewA = env.call('apiPlanView(__in)', { __in: { planId } });
  env.as(OTHER);
  const viewB = env.call('apiPlanView(__in)', { __in: { planId } });
  assert.equal(viewA.inputHash, viewB.inputHash, '同じ中身なら同じ入力のハッシュ');
  env.as(MEMBER);
  const rowsA = [{ person: '担当A', product: '製品A', ym: '2026-06', step: '10', reason: 'A' }, { person: '担当B', product: '製品B', ym: '2026-07', step: '-5', reason: '' }];
  const stA = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind: 'product', rows: rowsA }, inputHash: viewA.inputHash });
  assert.equal(stA.status, 'DONE', stA.error);
  env.as(OTHER);
  const stB = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind: 'product', rows: [{ person: '担当B', product: '上書き', ym: '2026-08', step: '1', reason: '' }] }, inputHash: viewB.inputHash });
  assert.equal(stB.status, 'FAILED');
  assert.match(stB.error, /読み直|開き直|変わりました/, '古い画面のまま上書きしない');
  const prod = env.table('ENG_PRODUCT').filter((r) => r.plan_id === planId);
  assert.equal(prod.length, 2, 'A の保存はそのまま');
  assert.equal(prod[0].ProductName, '製品A');
  assert.equal(env.table('ENG_PRODUCT').filter((r) => r.plan_id === planId2).length, 1, 'ほかの計画は触らない');
  const viewB2 = env.call('apiPlanView(__in)', { __in: { planId } });
  assert.notEqual(viewB2.inputHash, viewB.inputHash);
  const stB2 = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind: 'product', rows: [{ person: '担当B', product: '製品C', ym: '2026-08', step: '1', reason: '' }] }, inputHash: viewB2.inputHash });
  assert.equal(stB2.status, 'DONE', '読み直せば保存できる');
  assert.equal(env.table('ENG_PRODUCT').filter((r) => r.plan_id === planId).length, 1);
}

// ==== 7. 処理の実行中にほかの人が頼む: busy で断り、増えない。終われば頼める ====
{
  const { env, planId, clientId } = seeded();
  env.as(OWNER);
  env.task(`saveMember({ email: '${MEMBER}', displayName: 'M' })`);
  env.task(`saveMember({ email: '${OTHER}', displayName: 'O' })`);
  env.task('grantRole(__in)', { __in: { email: MEMBER, role: 'PLANNER', scopeType: 'CLIENT', clientId } });
  env.task('grantRole(__in)', { __in: { email: OTHER, role: 'PLANNER', scopeType: 'CLIENT', clientId } });
  // 実行を短く止める（計算の代わり）
  env.run(`appLegacyEngine_ = function () { return { VERSION: 'stub', SOURCE_SHA256: 's', WEB_SOURCE_SHA256: 'w',
    webRunDashboard() { return {}; } }; }`);
  env.as(MEMBER);
  const started = env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.RUN', payload: { planId, action: 'EVAL.DASHBOARD' } } });
  assert.ok(started.jobId);
  const nJobs = jobProps(env), nTrg = env.triggers.length;
  env.as(OTHER);
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.EDIT', payload: { planId, action: 'INPUT.SAVE', args: { kind: 'product', rows: [] } } } }),
    /終わるまでお待ちください/, '実行中はほかの人の頼みを断る');
  assert.equal(jobProps(env), nJobs, '断られた頼みは待ち行列に増えない');
  assert.equal(env.triggers.length, nTrg, 'トリガーも増えない');
  env.as(MEMBER);   // 処理の状態は頼んだ本人か管理者が見る
  let id = started.jobId, st;
  for (let i = 0; i < 20; i++) {
    env.fireTriggers('triggerRunJob');
    st = env.call('apiJobStatus(__in)', { __in: { jobId: id } });
    if (st.status === 'CONTINUED') { id = st.nextJobId; continue; }
    if (st.status === 'QUEUED' || st.status === 'RUNNING') { id = st.jobId; continue; }
    break;
  }
  assert.equal(st.status, 'DONE', JSON.stringify(st));
  env.as(OTHER);
  const retry = env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.RUN', payload: { planId, action: 'EVAL.DASHBOARD' } } });
  assert.ok(retry.jobId && retry.jobId !== started.jobId, '終われば頼める');
}

console.log('app-readiness: all tests passed');
