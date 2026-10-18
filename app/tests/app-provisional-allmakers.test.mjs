#!/usr/bin/env node
/**
 * Owner-only all-maker provisional workflow: real native create/import/aggregate/
 * forecast/save jobs over synthetic ZAC records. Normal plans, official versions
 * and budgets remain untouched. GAS persistence/trigger behaviour is mocked.
 */
import assert from 'node:assert/strict';
import { setUpEnv, OWNER, MEMBER } from './gas-mock.mjs';

const FY = 2026;
const date = (y, m, d = 15) => new Date(y, m - 1, d);
const owner = (env, task) => { env.props.OWNER_TASK = JSON.stringify(task); return env.call('apiOwnerTask()').result; };
const status = (env) => owner(env, { action: 'provisionalStatus' });
const start = (env, extra = {}) => owner(env, { action: 'startProvisionalAll', fy: FY, ...extra });
const resume = (env, extra = {}) => owner(env, { action: 'resumeProvisionalAll', ...extra });
const plansFor = (env, name) => env.table('PLANS').filter((p) => p.client_label === name && String(p.fy) === String(FY));
function drain(env) {
  for (let i = 0; i < 180 && status(env).active; i++) env.fireTriggers('triggerRunJob');
  const s = status(env);
  assert.equal(s.active, false, JSON.stringify(s).slice(0, 1800));
  return s;
}
function fixture(names) {
  const env = setUpEnv(), blank = Array(70).fill(''), sheets = {};
  for (let y = FY - 4; y <= FY; y++) {
    const rows = [blank.map((_, i) => 'c' + (i + 1))];
    for (let m = 1; m <= 12; m++) {
      if (y === FY - 4 && m < 4) continue;
      names.forEach((name, k) => {
        const r = blank.slice(); r[40] = name; r[45] = 'ベース'; r[49] = '合成既存製品'; r[56] = date(y, m);
        // FY target actuals are a large sentinel: they must never enter SALES_INPUT.
        r[65] = y === FY && m >= 4 ? 900000000 + k : 800000 + k * 100000 + m * 1000;
        rows.push(r);
      });
    }
    sheets['*' + y + '_actual_value'] = { cols: 70, values: rows };
  }
  const source = env.makeBook('合成ZAC', sheets);
  env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + source.getId() + '/edit' } });
  return env;
}
function makeMeasure(env, name) {
  const r = env.runJob('PLAN.CREATE', { clientName: name, fy: FY, peopleCsv: '', purpose: 'MEASURE' });
  assert.equal(r.status, 'DONE', r.error);
  return r.result.planId;
}
function seedNormal(env, name) {
  const output = [['合成の予測']];
  while (output.length < 25) output.push([]);
  output.push(['年度合計（予測）', 900000, 1000000, 1100000], [], ['月', 'P10', 'P50', 'P90', '', '', '', '採用予測', '上乗せ']);
  for (let m = 0; m < 12; m++) output.push([new Date(FY, 3 + m, 1), 70000, 80000, 90000, '', '', '', 75000 + m, 123]);
  const id = env.seedPlan(env.makeBook('既存通常計画', {
    CONFIG: { values: [['項目', '値'], ['メーカー', name], ['FY', FY], ['担当者', '既存担当']] },
    OUTPUT: { values: output }, OPINIONS: { values: [['person', 'ym', 'step', 'conf', 'note'], ['既存担当', '2026/04', '8%', 0.8, '保持']] },
  }));
  const sub = env.call('appTestVersionSubmit_(__in)', { __in: { planId: id, note: '保持する公式版' } });
  env.call('appTestVersionDecide_(__in)', { __in: { versionId: sub.version.versionId, decision: 'APPROVED', rowVersion: sub.version.rowVersion } });
  return id;
}
function planSnapshot(env, planId) {
  const client = env.table('PLANS').find((p) => p.plan_id === planId).client_id;
  return Object.fromEntries(env.data().sheets.map((s) => [s.name, env.table(s.name).filter((r) => r.plan_id === planId || s.name === 'CLIENTS' && r.client_id === client)]).filter(([, rows]) => rows.length));
}
function inputSnapshot(env, planId) {
  const inputSheets = ['PRODUCT', 'CLIENT', 'OPINIONS', 'DEV_SPOT'];
  return Object.fromEntries(['ENG_ROWS', 'ENG_FORMATS', 'ENG_SHEETS', ...inputSheets.map((n) => 'ENG_' + n)].map((name) => [name,
    env.table(name).filter((r) => r.plan_id === planId && (!r.sheet || inputSheets.includes(r.sheet)))]));
}

// Alias resolution is the same canonical key as plan creation, and the roster
// includes FY plans absent from the current ZAC candidate list.
{
  const env = fixture(['ＡＢＣ製薬株式会社']);
  makeMeasure(env, '既存のみ製薬');
  const roster = env.call('appProvisionalRoster_(__names,__fy,appProvisionalSnapshot_())', { __names: [
    { zac: 'ＡＢＣ製薬株式会社' }, { zac: 'ABC 製薬(株)' },
  ], __fy: FY });
  assert.equal(roster.length, 2);
  const merged = roster.find((r) => r.key === 'abc製薬');
  assert.equal(merged.aliases.length, 2, '表記ゆれで同年度計画を重複作成しない');
  assert.ok(roster.some((r) => r.clientName === '既存のみ製薬' && r.sources.includes('EXISTING_FY_PLAN')));
}

// Native happy path + existing normal preservation + persistent/repeated entry.
{
  const env = fixture(['通常保全製薬', '再利用製薬', '新規製薬']);
  const normal = seedNormal(env, '通常保全製薬'), reused = makeMeasure(env, '再利用製薬');
  // Keep an eligible plan for the older bulk entry point, so its mutual
  // exclusion check cannot be mistaken for an empty-queue validation error.
  assert.equal(env.runJob('PLAN.RUN', { planId: reused, action: 'IMPORT.SALES' }).status, 'DONE');
  assert.equal(env.runJob('PLAN.RUN', { planId: reused, action: 'SALES.AGGREGATE' }).status, 'DONE');
  const save = env.runJob('PLAN.EDIT', { planId: reused, action: 'INPUT.SAVE', args: { kind: 'opinions', rows: [
    { person: '既存入力者', ym: '2026-06', step: '5', conf: 0.8, note: '暫定実行でも残す' },
  ] } });
  assert.equal(save.status, 'DONE', save.error);
  const normalBefore = planSnapshot(env, normal), inputsBefore = inputSnapshot(env, reused);
  const initial = start(env);
  assert.equal(initial.count, 3);
  assert.equal(initial.noNormalPlanWrites, true);
  assert.equal(initial.backtest, false);
  assert.equal(initial.sourceCutoff, '2026/03');
  const firstRoot = initial.current.rootJobId, jobsBeforeRepeat = env.call('appJobList_()').length;
  const repeated = start(env);
  assert.equal(repeated.id, initial.id, '同版同年度の再要求は同じバッチを返す');
  assert.equal(repeated.current.rootJobId, firstRoot);
  assert.equal(env.call('appJobList_()').length, jobsBeforeRepeat, '同じ要求で重複enqueueしない');
  assert.throws(() => owner(env, { action: 'runForecastAll', fy: FY }), /暫定/, '別の一括jobを同時に始めない');
  assert.throws(() => owner(env, { action: 'runBacktestAll', fy: FY }), /暫定/);
  const end = drain(env), byName = Object.fromEntries(end.items.map((i) => [i.clientName, i]));
  assert.equal(byName['通常保全製薬'].status, 'PRESERVED_NORMAL');
  assert.equal(byName['通常保全製薬'].readiness.forecastReady, false, '未完通常予測を完了と偽称しない');
  assert.deepEqual(planSnapshot(env, normal), normalBefore, '通常計画の全plan表・予算・公式版・入力を完全保全');
  assert.deepEqual(inputSnapshot(env, reused), inputsBefore, '再利用MEASUREの入力をmask/削除/書換しない');
  assert.equal(plansFor(env, '新規製薬').length, 1);
  const made = plansFor(env, '新規製薬')[0];
  assert.deepEqual([made.purpose, made.people_csv], ['MEASURE', '']);
  assert.equal(byName['新規製薬'].status, 'DONE', JSON.stringify(byName['新規製薬']));
  assert.equal(byName['新規製薬'].readiness.planningReady, true);
  assert.deepEqual(Object.keys(byName['新規製薬'].completed), ['CREATE', 'IMPORT', 'AGGREGATE', 'FORECAST']);
  assert.equal(byName['再利用製薬'].status, 'UNREADY', '非中立の既存入力があればW完了と偽称しない');
  assert.equal(byName['再利用製薬'].readiness.forecastReady, true);
  assert.equal(byName['再利用製薬'].readiness.planningReady, false);
  const sales = env.table('ENG_SALES_INPUT').filter((r) => r.plan_id === made.plan_id);
  assert.ok(sales.length > 0);
  const importedMonths = env.call('appReadPlanTable_("ENG_SALES_INPUT",__id).map(r => appCellYm_(r._types.charAt(3),r.target_month))', { __id: made.plan_id });
  assert.equal(importedMonths.length, 48);
  assert.deepEqual([importedMonths[0], importedMonths.at(-1)], ['2022/04', '2026/03']);
  assert.ok(sales.every((r) => Number(r.input_amount) < 900000000), 'FY2026実績sentinelを過去48月に入れない');
  assert.equal(env.table('FORECAST_RUNS').filter((r) => r.plan_id === made.plan_id).length, 1);
  for (const n of ['ENG_PRODUCT', 'ENG_CLIENT', 'ENG_OPINIONS', 'ENG_DEV_SPOT']) assert.equal(env.table(n).filter((r) => r.plan_id === made.plan_id).length, 0, '新規主観行を捏造しない: ' + n);
  const latest = env.call('apiForecastLatest(__in)', { __in: { planId: made.plan_id } });
  assert.equal(latest.planning.method, 'W_COMPONENT_EVENT_HALF_SHAPE_BLEND');
  assert.equal(latest.planning.provisional, true);
  assert.equal(latest.monthly.length, 12, '保存後APIから同じ12月を読める');
  const planCount = env.table('PLANS').length, runCount = env.table('FORECAST_RUNS').length;
  assert.equal(start(env).id, end.id);
  assert.equal(resume(env).active, false);
  assert.equal(env.table('PLANS').length, planCount);
  assert.equal(env.table('FORECAST_RUNS').length, runCount, '完了後start/resumeはDONEを再計算しない');
}

// Owner permission and malformed arguments do not enqueue jobs.
{
  const env = fixture(['権限検証製薬']);
  env.task('saveMember(__in)', { __in: { email: MEMBER, displayName: '管理者' } });
  env.task('grantRole(__in)', { __in: { email: MEMBER, role: 'ADMIN', scopeType: 'ALL' } });
  const before = env.call('appJobList_()').length;
  env.as(MEMBER);
  for (const task of [{ action: 'startProvisionalAll', fy: FY }, { action: 'provisionalStatus' }, { action: 'resumeProvisionalAll' }]) {
    assert.throws(() => owner(env, task), /権限/);
  }
  assert.throws(() => env.call('appProvisionalStatus_()'), /所有者だけ/);
  env.as(OWNER);
  for (const bad of [2026.5, 'bad', 1999, 2101]) assert.throws(() => start(env, { fy: bad }), /fy|年度/);
  assert.throws(() => start(env, { refresh: 'yes' }), /refresh.*true.*false/);
  assert.throws(() => resume(env, { retryFailed: 'yes' }), /retryFailed.*true.*false/);
  assert.equal(env.call('appJobList_()').length, before);
  env.run('appBulkSave_({active:true, current:{planId:"other"}})');
  assert.throws(() => start(env), /まとめて実行/);
}

// Frozen year and archived plans are never written or silently replaced.
{
  const env = fixture(['保管終了製薬', '未作成閉鎖製薬']);
  const archived = makeMeasure(env, '保管終了製薬');
  env.run('appUpdateByKey_("PLANS", {plan_id:__id}, {state:"ARCHIVED"}, APP_ROW_UNCHECKED, "test")', { __id: archived });
  env.run('appInsertRows_("YEAR_CLOSURES", [{fy:String(__fy), state:"CLOSED", file_id:"test-archive", snapshot_sha256:"a".repeat(64), plan_count:1, row_count:1, bytes:1}])', { __fy: FY });
  const before = planSnapshot(env, archived), count = env.table('PLANS').length, jobs = env.call('appJobList_()').length;
  const done = start(env);
  assert.equal(done.active, false);
  assert.deepEqual(new Set(done.items.map((i) => i.status)), new Set(['SKIPPED_ARCHIVED', 'SKIPPED_CLOSED']));
  assert.deepEqual(planSnapshot(env, archived), before);
  assert.equal(env.table('PLANS').length, count);
  assert.equal(env.call('appJobList_()').length, jobs, '凍結年度は作成もnative jobも始めない');
  assert.equal(done.allForecastReady, false);
}

// A missing native receipt / confirm / failed job must not count as DONE.
// Stop only calculation in this block; successful native persistence is above.
{
  const env = fixture(['確認待製薬', '失敗製薬']);
  const confirm = makeMeasure(env, '確認待製薬'), failed = makeMeasure(env, '失敗製薬');
  env.run(`__nativePlanCalc = appPlanRunCalc_; __nativeForecastCalc = appForecastRunCalc_;
    appPlanRunCalc_ = function(ctx,p) { if (p.planId === __failed && p.action === 'IMPORT.SALES') throw new Error('synthetic import failure'); return __nativePlanCalc.apply(null,arguments); };
    appForecastRunCalc_ = function(ctx,p) { if (p.planId === __confirm) return {needConfirm:{key:'extreme',message:'synthetic explicit confirmation'}}; return __nativeForecastCalc.apply(null,arguments); };`, { __failed: failed, __confirm: confirm });
  const initial = start(env), headBefore = env.run('JSON.stringify(appProvisionalState_())');
  env.run('appProvisionalAfterJob_({id:"unrelated",kind:"FORECAST.RUN_SAVE",requestedBy:__owner,payload:{planId:__plan},status:"DONE"},"DONE")', { __owner: OWNER, __plan: confirm });
  assert.equal(env.run('JSON.stringify(appProvisionalState_())'), headBefore, '別jobの終端はcurrentを進めない');
  const done = drain(env), byName = Object.fromEntries(done.items.map((i) => [i.clientName, i]));
  assert.equal(byName['失敗製薬'].status, 'FAILED');
  assert.match(byName['失敗製薬'].error, /synthetic import failure/);
  assert.equal(byName['確認待製薬'].status, 'CONFIRM');
  assert.equal(env.table('FORECAST_RUNS').filter((r) => [confirm, failed].includes(r.plan_id)).length, 0);
  assert.ok(!done.counts.DONE);
  const count = env.table('PLANS').length;
  env.run('appPlanRunCalc_ = __nativePlanCalc');
  resume(env, { retryFailed: true });
  const retried = drain(env), confirmed = retried.items.find((i) => i.clientName === '確認待製薬');
  assert.equal(confirmed.status, 'CONFIRM', '再試行を頼んでも確認を代行しない');
  assert.equal(env.table('PLANS').length, count, '失敗再開時に計画を重複作成しない');
  assert.equal(retried.items.find((i) => i.clientName === '失敗製薬').status, 'DONE');
}

// A completed native stage survives a lost result cache and missed terminal hook.
// Each stage is accepted only from the corresponding durable plan/action/run.
{
  const env = fixture(['復旧製薬']);
  start(env);
  env.run('__afterJob = appProvisionalAfterJob_; appProvisionalAfterJob_ = function(){ return null; }');
  const seen = [];
  for (const stage of ['CREATE', 'IMPORT', 'AGGREGATE', 'FORECAST']) {
    const current = status(env).current;
    assert.equal(current.stage, stage);
    let terminal;
    for (let k = 0; k < 80; k++) {
      env.fireTriggers('triggerRunJob');
      terminal = env.call('appProvisionalChain_(__root).job', { __root: current.rootJobId });
      if (terminal && ['DONE', 'FAILED'].includes(terminal.status) && !terminal.nextJobId) break;
    }
    assert.equal(terminal.status, 'DONE', terminal.error);
    assert.equal(status(env).current.rootJobId, current.rootJobId, 'native保存済みでもhook未実行の状態を再現');
    env.run('CacheService.getScriptCache().remove(APP_JOB_RESULT_PREFIX + __id)', { __id: terminal.id });
    assert.equal(env.call('appJobGetResult_(__id).found', { __id: terminal.id }), false);
    const recovered = resume(env);
    seen.push(recovered.items[0].completed[stage].kind);
    assert.equal(plansFor(env, '復旧製薬').length, 1, 'cache失効でも既存planを重複作成しない');
  }
  assert.deepEqual(seen, ['PLAN_CREATED', 'ACTION_SAVED', 'ACTION_SAVED', 'FORECAST_SAVED']);
  assert.equal(status(env).items[0].status, 'DONE');
  assert.equal(env.table('FORECAST_RUNS').length, 1);
  env.run('appProvisionalAfterJob_ = __afterJob');
}

// Native DONE without a forecast save receipt is UNREADY, never false success.
{
  const env = fixture(['保存欠落製薬']);
  env.run('appForecastRunSave_ = function(ctx,p) { return {runId:"not-persisted",planId:p.planId}; }');
  start(env);
  const done = drain(env);
  assert.equal(done.items[0].stage, 'FORECAST');
  assert.equal(done.items[0].status, 'UNREADY');
  assert.match(done.items[0].error, /完了記録/);
  assert.equal(env.table('FORECAST_RUNS').length, 0);
  assert.equal(done.allForecastReady, false);
}

// Re-check the protected plan boundary at execution time, including internal
// continuation/save stages. Purpose changes do not change the ENG input hash.
for (const boundary of ['IMPORT', 'FORECAST.RUN_SAVE']) {
  const env = fixture(['途中通常化製薬']), id = makeMeasure(env, '途中通常化製薬');
  start(env);
  if (boundary !== 'IMPORT') {
    for (let k = 0; k < 90; k++) {
      const current = status(env).current;
      assert.ok(current, '保存直前まで暫定jobが継続する');
      const job = env.call('appProvisionalChain_(__root).job', { __root: current.rootJobId });
      if (job.kind === boundary && job.status === 'QUEUED') break;
      env.call('appRunJob_(__id)', { __id: job.id });
    }
    const current = status(env).current;
    assert.equal(env.call('appProvisionalChain_(__root).job.kind', { __root: current.rootJobId }), boundary);
  }
  owner(env, { action: 'setPlanPurpose', planId: id, purpose: '' });
  const protectedState = planSnapshot(env, id);
  const end = drain(env);
  assert.deepEqual(planSnapshot(env, id), protectedState, 'queue後に通常計画へ変わったらその段を保存しない: ' + boundary);
  assert.ok(!end.counts.DONE, '通常化したplanを暫定完了に数えない');
}

// Same execution-time guardian for archived plans and closed years.
for (const protection of ['ARCHIVED', 'CLOSED']) {
  const env = fixture(['途中保全製薬']), id = makeMeasure(env, '途中保全製薬');
  start(env);
  if (protection === 'ARCHIVED') env.run('appUpdateByKey_("PLANS", {plan_id:__id}, {state:"ARCHIVED"}, APP_ROW_UNCHECKED, "test")', { __id: id });
  else env.run('appInsertRows_("YEAR_CLOSURES", [{fy:String(__fy), state:"CLOSED"}])', { __fy: FY });
  const protectedState = planSnapshot(env, id), end = drain(env);
  assert.deepEqual(planSnapshot(env, id), protectedState, 'queue後の保全変更も尊重する: ' + protection);
  assert.ok(!end.counts.DONE);
}

// Recheck inside the native save lock, after the generic job guardian has run.
// Simulate another owner execution winning the lock just before this save.
for (const saveKind of ['PLAN.RUN_SAVE', 'FORECAST.RUN_SAVE']) {
  const env = fixture(['保存競合製薬']), id = makeMeasure(env, '保存競合製薬');
  start(env);
  for (let k = 0; k < 90; k++) {
    const current = status(env).current;
    assert.ok(current);
    const job = env.call('appProvisionalChain_(__root).job', { __root: current.rootJobId });
    if (job.kind === saveKind && job.status === 'QUEUED') break;
    env.call('appRunJob_(__id)', { __id: job.id });
  }
  const current = status(env).current;
  assert.equal(env.call('appProvisionalChain_(__root).job.kind', { __root: current.rootJobId }), saveKind);
  const fn = saveKind === 'PLAN.RUN_SAVE' ? 'appPlanRunSave_' : 'appForecastRunSave_';
  const protectedBefore = planSnapshot(env, id);
  delete protectedBefore.PLANS;
  env.run(`__nativeSave = ${fn}; ${fn} = function(ctx,p,job) {
    const stalePlans = appRawTable_('PLANS').map(r => r.slice());
    appWithLock_(() => appUpdateByKey_('PLANS',{plan_id:p.planId},{purpose:''},APP_ROW_UNCHECKED,'test-race'));
    // A write by a different GAS execution cannot invalidate this execution's
    // in-memory PLANS cache. Preserve that stale view until the save lock check.
    (APP_STORE_CACHE_.raw || (APP_STORE_CACHE_.raw = {})).PLANS = stalePlans;
    return __nativeSave.apply(null,arguments);
  };`);
  const end = drain(env), protectedAfter = planSnapshot(env, id);
  assert.equal(protectedAfter.PLANS[0].purpose, '');
  delete protectedAfter.PLANS;
  assert.deepEqual(protectedAfter, protectedBefore, '用途変更とsave lockの間のraceでも通常計画へ書かない: ' + saveKind);
  assert.ok(!end.counts.DONE);
}

// A queued trigger that never ran can be explicitly retried, without duplicating
// the plan or skipping create/import/aggregate. Status alone does not advance it.
{
  const env = fixture(['未開始復旧製薬']), initial = start(env), first = initial.current.rootJobId;
  env.run('const j=appJobGet_(__id); j.createdAt=new Date(Date.now()-20*60*1000).toISOString(); appJobSave_(j)', { __id: first });
  assert.equal(status(env).current.rootJobId, first);
  const next = resume(env, { retryFailed: true });
  assert.equal(env.call('appJobGet_(__id).status', { __id: first }), 'FAILED');
  assert.notEqual(next.current.rootJobId, first);
  assert.equal(next.current.stage, 'CREATE');
  const done = drain(env);
  assert.equal(done.items[0].status, 'DONE');
  assert.equal(plansFor(env, '未開始復旧製薬').length, 1);
  assert.equal(env.table('FORECAST_RUNS').length, 1);
}

// Recovery of a new retry intent must not confuse it with an older failed root
// for the same maker/stage. The per-intent token also survives native children.
{
  const env = fixture(['意図復旧製薬']);
  env.run('__nativeCreateBuild = appPlanCreateBuild_; appPlanCreateBuild_ = function(){ throw new Error("synthetic first attempt"); }');
  const initial = start(env), oldRoot = initial.current.rootJobId, oldToken = initial.current.intentId;
  assert.equal(drain(env).items[0].status, 'FAILED');
  env.run('appPlanCreateBuild_ = __nativeCreateBuild');
  const retry = resume(env, { retryFailed: true }), newRoot = retry.current.rootJobId, newToken = retry.current.intentId;
  assert.ok(oldToken && newToken && oldToken !== newToken);
  assert.notEqual(newRoot, oldRoot);
  assert.equal(env.call('appJobGet_(__id).payload.provisionalIntentId', { __id: newRoot }), newToken);
  env.run('const lost=appProvisionalState_(); lost.current.rootJobId=""; appProvisionalSaveState_(lost)');
  const recovered = resume(env);
  assert.equal(recovered.current.rootJobId, newRoot, '失われたroot IDを現在のintentだけから復旧');
  assert.equal(recovered.current.intentId, newToken);
  assert.equal(drain(env).items[0].status, 'DONE');
  assert.equal(plansFor(env, '意図復旧製薬').length, 1);
  const children = env.call('appJobList_().filter(j => j.payload && j.payload.provisionalBatchId===__batch && j.payload.provisionalStage==="CREATE" && j.id!==__old)', { __batch: initial.id, __old: oldRoot });
  assert.ok(children.some((j) => j.kind === 'PLAN.CREATE_SAVE'));
  assert.ok(children.every((j) => j.payload.provisionalIntentId === newToken), '子段と終端recordも同じintent tokenを保持');
}

console.log('app-provisional-allmakers: all tests passed');
