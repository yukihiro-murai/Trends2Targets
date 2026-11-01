#!/usr/bin/env node
/** Owner-only B1/B2/B4 aliases. All source records and jobs are synthetic local GAS mocks. */
import assert from 'node:assert/strict';
import { setUpEnv, OWNER, MEMBER, J, fmtDate } from './gas-mock.mjs';

const ACTIONS = [['importActuals', 'IMPORT.ACTUALS', 'ADMIN'], ['runEvalReport', 'EVAL.REPORT', 'PLANNER'], ['runEvalInsights', 'EVAL.INSIGHTS', 'PLANNER']];
const env = setUpEnv();
env.boot();
const FY = env.run('appFy_(new Date())') - 1;
const CLIENT = '合成評価製薬', OTHER = '合成保全薬品';
const H = J(env.run('Object.fromEntries(Object.keys(APP_ENGINE_SHEETS).map(k=>[k,APP_ENGINE_SHEETS[k].header||null]))'));
const POLICY = env.run('APP_EVAL_POLICY_VERSION');
const D = (y, m, d = 1) => new Date(Date.UTC(y, m - 1, d, 3));
const YM = FY + '/04', BEFORE = D(FY, 3, 15);
const row = (name, o) => H[name].map(h => o[h] === undefined ? '' : o[h]);
function fixture(client) {
  const sheets = Object.fromEntries(Object.entries(H).filter(([, h]) => h).map(([name, h]) => [name, { values: [h], cols: Math.max(36, h.length) }]));
  sheets.CONFIG = { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', FY], ['[必須] 担当者（カンマ区切り）', '合成担当']] };
  sheets.OUTPUT = { values: [['保持する合成予測'], [123.5, -10.25]], cols: 36 };
  sheets.PROCESS_STATUS.values.push(...['step1_status', 'step4_status'].map(step => row('PROCESS_STATUS', { step_key: step, last_run_date: BEFORE, status: 'success', target_client: client })));
  // This is a genuine pre-month source shape, never a forecast backdated by the execution aliases.
  sheets.FORECAST_SNAPSHOT.values.push(...['nega', 'neutral', 'posi'].map((scenario, i) => row('FORECAST_SNAPSHOT', {
    snapshot_id: 'SYNTHETIC-PRE-MONTH', run_date: BEFORE, client, target_month: YM, scenario, final_pred: [80, 100, 120][i], key_factors_json: '{"forecast_source":"forecast_open"}'
  })));
  sheets.FORECAST_SNAPSHOT.formats = { D: '@' };
  sheets.EVAL_LOG.values.push(...['nega', 'neutral', 'posi'].map(scenario => row('EVAL_LOG', { eval_id: 'OLD-' + scenario, evaluated_at: BEFORE, client,
    target_month: YM, scenario, pred: 11, actual: 10, evaluation_policy_version: 'policy-2026H1-v1', constraint_relevant_flag: 1 })));
  sheets.EVAL_LOG.formats = { D: '@' };
  sheets.EVAL_INSIGHTS.values.push(row('EVAL_INSIGHTS', { evaluated_at: BEFORE, client, target_month: YM, actual_total: 10, pred_p50: 11,
    cause_hypothesis: '合成の原因メモ', impacted_assumption: '合成の前提', action_type: 'add', next_cycle_reflection: '合成の次回反映', owner: '合成担当', due_date: D(FY, 5, 20), status: 'in_progress', cause_bucket: 'old-machine-bucket' }));
  sheets.EVAL_INSIGHTS.formats = { C: '@' };
  sheets.CALIBRATION_STATE.values.push(row('CALIBRATION_STATE', { client, bias_correction_factor: 1, residual_month_bias_json: '', auto_update_enabled: 0, note: '合成fixtureでは自動補正を無効' }));
  return env.seedPlan(env.makeBook('合成の評価計画', sheets));
}
const planId = fixture(CLIENT), otherId = fixture(OTHER);
const rows = (name, id = planId) => env.table('ENG_' + name).filter(r => r.plan_id === id);
const planHash = () => env.run('appOwnerPlanHash_(__id)', { __id: planId });
const jobs = () => Object.keys(env.props).filter(k => /^APP_JOB_(?!RESULT_)/.test(k)).length;
function task(t) { env.props.OWNER_TASK = JSON.stringify(t); return env.call('apiOwnerTask()'); }
function reject(t, re) {
  const count = jobs(), raw = JSON.stringify(t);
  assert.throws(() => task(t), re);
  assert.equal(jobs(), count, 'rejected request does not queue a job');
  assert.equal(env.props.OWNER_TASK, raw, 'rejected request remains available for correction');
  assert.equal(JSON.parse(env.props.OWNER_TASK_RESULT).ok, false);
}
function start(alias, inputHash) {
  const t = { action: alias, planId }; if (inputHash !== undefined) t.inputHash = inputHash;
  const expectedHash = planHash(), result = task(t);
  assert.equal(result.ok, true); assert.equal(result.auditAction, 'JOB.START');
  const id = result.result.jobId;
  assert.deepEqual(JSON.parse(env.props.OWNER_TASK), { action: 'jobStatus', jobId: id });
  assert.match(result.hint, /jobStatus/);
  const queued = env.call('appJobGet_(__id)', { __id: id });
  assert.equal(queued.kind, 'PLAN.RUN');
  assert.deepEqual(queued.payload, { planId, action: ACTIONS.find(a => a[0] === alias)[1], args: {}, inputHash: expectedHash });
  assert.equal(queued.requestedBy, OWNER);
  return id;
}
function finish(id) {
  const statusTask = env.props.OWNER_TASK;
  for (let i = 0; i < 60; i++) {
    env.fireTriggers('triggerRunJob');
    const out = env.call('apiOwnerTask()');
    assert.equal(env.props.OWNER_TASK, statusTask, 'polling does not repeat the original operation');
    const s = out.result;
    if (['QUEUED', 'RUNNING', 'CONTINUED'].includes(s.status)) continue;
    assert.equal(env.call('apiJobStatus(__in)', { __in: { jobId: id } }).status, s.status, 'the first job ID follows all continuation stages');
    return s;
  }
  throw new Error('synthetic job did not finish');
}
const storedPlan = id => JSON.stringify(env.data().getSheets().map(sh => ({ name: sh.getName(), rows: env.table(sh.getName()).filter(r => r.plan_id === id) })));
const stableForecast = () => JSON.stringify({ snapshots: rows('FORECAST_SNAPSHOT'), output: env.table('ENG_ROWS').filter(r => r.plan_id === planId && r.sheet === 'OUTPUT'),
  formats: env.table('ENG_FORMATS').filter(r => r.plan_id === planId && ['OUTPUT', 'FORECAST_SNAPSHOT'].includes(r.sheet)), runs: env.table('FORECAST_RUNS').filter(r => r.plan_id === planId) });
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log('PASS ' + name); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + e.stack); failed++; } }

for (const [alias, action, role] of ACTIONS) {
  test(alias + ': only the fixed action and plan/hash inputs are exposed', () => {
    const spec = J(env.run('(()=>{const x=APP_OWNER_ACTIONS[__a];return x&&{job:x.job,args:x.args,payload:x.payload({planId:__id,inputHash:__h})}})()', { __a: alias, __id: planId, __h: planHash() }));
    assert.deepEqual(spec, { job: 'PLAN.RUN', args: ['planId', 'inputHash'], payload: { planId, action, args: {}, inputHash: planHash() } });
    reject({ action: alias, planId, args: { action: 'FORECAST.RUN' } }, /使えない項目/);
  });
  test(alias + ': malformed, absent and stale identifiers stop before queuing', () => {
    for (const id of [undefined, '', 123]) reject({ action: alias, planId: id }, /計画の ID/);
    reject({ action: alias, planId: 'PL-none' }, /計画が見つかりません/);
    reject({ action: alias, planId, inputHash: 'bad' }, /inputHash.*64 桁/);
    reject({ action: alias, planId, inputHash: 'f'.repeat(64) }, /画面が古い/);
  });
  test(alias + ': non-owner and insufficient action role cannot queue', () => {
    const oldResult = env.props.OWNER_TASK_RESULT, count = jobs();
    env.as(MEMBER);
    try { assert.throws(() => task({ action: alias, planId }), /権限がありません/); assert.equal(env.props.OWNER_TASK_RESULT, oldResult); } finally { env.as(OWNER); }
    assert.equal(jobs(), count);
    assert.throws(() => env.call(`appOwnerRunAction_({actor:__by,requestId:'EVAL-DENIED',roles:[{role:__role,scope_type:'ALL',client_id:''}]},__t)`,
      { __by: OWNER, __role: role === 'ADMIN' ? 'PLANNER' : 'VIEWER', __t: { action: alias, planId } }), /権限がありません/);
    assert.equal(jobs(), count);
    assert.ok(env.audit().some(a => a.action === 'JOB.START' && a.phase === 'DENIED' && a.request_id === 'EVAL-DENIED'));
  });
  test(alias + ': frozen year is rejected without data or job changes', () => {
    const before = storedPlan(planId); env.run('var __openEvalYear=appYearIsFrozen_;appYearIsFrozen_=()=>true');
    try { reject({ action: alias, planId }, /締め済み/); } finally { env.run('appYearIsFrozen_=__openEvalYear'); }
    assert.equal(storedPlan(planId), before);
  });
}

let source;
test('B1 source failure is terminal, keeps data, and leaves only jobStatus for polling', () => {
  const before = storedPlan(planId), id = start('importActuals');
  const result = finish(id); assert.equal(result.status, 'FAILED'); assert.match(result.error, /ZAC の実績のスプレッドシート/);
  assert.equal(storedPlan(planId), before);
});
const otherBefore = storedPlan(otherId), forecastBefore = stableForecast();
test('B1 imports only the selected client through the configured source and real job stages', () => {
  const blank = Array(70).fill(''), rec = (client, amount) => { const a = blank.slice(); a[40] = client; a[45] = 'ベース'; a[49] = '合成製品'; a[56] = D(FY, 4, 15); a[65] = amount; return a; };
  source = env.makeBook('合成外部実績', { ['*' + FY + '_actual_value']: { cols: 70, values: [blank.map((_, i) => 'C' + i), rec(CLIENT, 125), rec(OTHER, 999)] } });
  env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: source.getUrl() } });
  const result = finish(start('importActuals')); assert.equal(result.status, 'DONE', result.error);
  assert.ok(result.result.changed.includes('ACTUAL_EVAL_MONTHLY'));
  assert.deepEqual(rows('ACTUAL_EVAL_MONTHLY').map(r => [r.client, fmtDate(new Date(r.target_month), 'Asia/Tokyo', 'yyyy/MM'), r.eval_actual_amount, r.actual_closed_flag]), [[CLIENT, YM, '125', 'closed']]);
  assert.equal(rows('EVAL_LOG').filter(r => r.evaluation_policy_version === POLICY).length, 0, 'B1 does not grade');
  assert.equal(storedPlan(otherId), otherBefore); assert.equal(stableForecast(), forecastBefore);
});
test('B2 grades the pre-month snapshot at current policy, keeping forecasts and unrelated plans', () => {
  const result = finish(start('runEvalReport', planHash())); assert.equal(result.status, 'DONE', result.error);
  assert.ok(result.result.changed.includes('EVAL_LOG')); assert.ok(result.result.changed.includes('EVAL_COMPARE_MONTHLY'));
  const evals = rows('EVAL_LOG'); assert.equal(evals.length, 3, 'old same-key grading is updated in place');
  assert.ok(evals.every(r => r.evaluation_policy_version === POLICY && r.actual === '125'));
  assert.equal(evals.find(r => r.scenario === 'neutral').pred, '100');
  assert.equal(rows('RUN_LOG').filter(r => r.function_name === 'updatePhase1EvaluationReport').at(-1).status, 'success');
  assert.equal(storedPlan(otherId), otherBefore); assert.equal(stableForecast(), forecastBefore);
});
const humanBefore = rows('EVAL_INSIGHTS')[0];
test('B4 regenerates current machine findings while preserving existing human fields', () => {
  const result = finish(start('runEvalInsights')); assert.equal(result.status, 'DONE', result.error);
  assert.ok(result.result.changed.includes('EVAL_INSIGHTS'));
  const insights = rows('EVAL_INSIGHTS'); assert.equal(insights.length, 1);
  assert.equal(insights[0].actual_total, '125'); assert.equal(insights[0].pred_p50, '100');
  for (const h of ['cause_hypothesis', 'impacted_assumption', 'action_type', 'next_cycle_reflection', 'owner', 'due_date', 'status']) assert.equal(insights[0][h], humanBefore[h], h);
  assert.notEqual(insights[0].cause_bucket, humanBefore.cause_bucket, 'machine cause classification may be refreshed');
  assert.equal(storedPlan(otherId), otherBefore); assert.equal(stableForecast(), forecastBefore);
  const view = env.call('apiPlanView(__in)', { __in: { planId } });
  assert.equal(view.boot.eval.readiness.code, 'READY'); assert.equal(view.boot.eval.insights.length, 1);
});
test('repeated B1/B2/B4 neither duplicate month keys nor repeat forecasts or erase human notes', () => {
  for (const [alias] of ACTIONS) { const done = finish(start(alias)); assert.equal(done.status, 'DONE', done.error); }
  assert.equal(rows('ACTUAL_EVAL_MONTHLY').length, 1); assert.equal(rows('EVAL_LOG').length, 3); assert.equal(rows('EVAL_INSIGHTS').length, 1);
  assert.equal(rows('EVAL_INSIGHTS')[0].cause_hypothesis, humanBefore.cause_hypothesis);
  assert.equal(storedPlan(otherId), otherBefore); assert.equal(stableForecast(), forecastBefore);
  for (const [, action] of ACTIONS) for (const stage of ['BUILD', 'CALC', 'SAVE']) {
    const a = env.audit().filter(r => r.action === 'PLAN.' + action + '.' + stage && r.phase === 'END').at(-1);
    assert.equal(a.result, 'OK'); assert.equal(a.actor_email, OWNER);
  }
});

test('preservation read validates plan/backup/verify shape before invoking the helper', () => {
  for (const id of [undefined, '', 123]) reject({ action: 'evaluationPreservation', planId: id, backupId: 'SYNTHETIC-BACKUP' }, /計画の ID/);
  for (const backupId of [undefined, '', '  ', 123]) reject({ action: 'evaluationPreservation', planId, backupId }, /backupId/);
  for (const verify of ['false', 0, null, []]) reject({ action: 'evaluationPreservation', planId, backupId: 'SYNTHETIC-BACKUP', verify }, /verify.*true.*false/);
  reject({ action: 'evaluationPreservation', planId, backupId: 'SYNTHETIC-BACKUP', extra: true }, /使えない項目/);
});
test('preservation read is owner-only, keeps the exact request, and delegates both read modes', () => {
  const before = storedPlan(planId), count = jobs();
  env.run('var __savedPreservation=typeof appEvaluationPreservation_==="function"?appEvaluationPreservation_:null,__preserveCalls=[];appEvaluationPreservation_=function(ctx,i){__preserveCalls.push({actor:ctx.actor,input:i});return {planId:i.planId,ok:true,inputHash:"a".repeat(64),verify:i.verify===true}}');
  try {
    const original = env.props.OWNER_TASK_RESULT; env.as(MEMBER);
    try { assert.throws(() => task({ action: 'evaluationPreservation', planId, backupId: 'SYNTHETIC-BACKUP' }), /権限がありません/); assert.equal(env.props.OWNER_TASK_RESULT, original); }
    finally { env.as(OWNER); }
    assert.equal(env.run('__preserveCalls.length'), 0);
    assert.deepEqual(J(env.run('APP_OWNER_ACTIONS.evaluationPreservation.opts({})')), { minRole: 'ADMIN', ownerOnly: true, audit: false });
    assert.throws(() => env.call(`appOwnerRunAction_({actor:__by,requestId:'EVAL-READ-DENIED',roles:[{role:'VIEWER',scope_type:'ALL'}]},__t)`,
      { __by: MEMBER, __t: { action: 'evaluationPreservation', planId, backupId: 'SYNTHETIC-BACKUP' } }), /権限がありません/);
    for (const verify of [undefined, false, true]) {
      const t = { action: 'evaluationPreservation', planId, backupId: 'SYNTHETIC-BACKUP' }; if (verify !== undefined) t.verify = verify;
      const out = task(t); assert.equal(out.auditAction, 'EVALUATION.PRESERVATION'); assert.equal(out.result.ok, true); assert.equal(out.result.verify, verify === true);
      assert.equal(env.props.OWNER_TASK, JSON.stringify(t), 'read mode leaves the exact request in place');
      assert.match(out.hint, /読むだけ/);
      assert.deepEqual(env.call('apiOwnerTask()').result, out.result, 'repeating a read delegates safely without starting a job');
    }
    assert.equal(env.run('__preserveCalls.length'), 6);
    assert.ok(env.run('__preserveCalls.every(c=>c.actor===__by)', { __by: OWNER }));
  } finally { env.run('if(__savedPreservation)appEvaluationPreservation_=__savedPreservation;else delete appEvaluationPreservation_'); }
  assert.equal(jobs(), count); assert.equal(storedPlan(planId), before);
});

console.log(`${passed} PASS / ${failed} FAIL`);
if (failed) process.exitCode = 1;
