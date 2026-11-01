#!/usr/bin/env node
/** Exercise the real PLAN.RUN build/save stages: refuse destructive evaluation saves before Journal; preserve allowed and older callers. Synthetic only. */
import assert from 'node:assert/strict';
import { J, OWNER, setUpEnv } from './gas-mock.mjs';

const NOW = new Date('2026-11-01T03:00:00.000Z');
const CTX = { actor: OWNER, requestId: 'synthetic-eval-guard', roles: [] };
function fixture({ actualCount = 1, textMonthFormats = true } = {}) {
  const env = setUpEnv();
  const headers = env.run('Object.fromEntries(Object.entries(APP_ENGINE_SHEETS).filter(([,v])=>v.header).map(([k,v])=>[k,v.header]))');
  const row = (name, value) => headers[name].map(k => value[k] ?? '');
  const names = ['ACTUAL_EVAL_MONTHLY', 'EVAL_LOG', 'EVAL_COMPARE_MONTHLY', 'EVAL_INSIGHTS', 'PROCESS_STATUS', 'RUN_LOG', 'CALIBRATION_STATE', 'CALIBRATION_HISTORY', 'FORECAST_SNAPSHOT', 'PRODUCT', 'CLIENT', 'OPINIONS', 'DEV_SPOT'];
  function seed(client) {
    const sheets = {
      CONFIG: { values: [['項目', '値'], ['メーカー', client], ['FY', 2026], ['担当者', '合成担当']] },
      OUTPUT: { values: [['保持する予測'], ['保持する月', 100, 200]] },
      DASHBOARD: { values: [['指標', '値', '補足']] },
    };
    for (const name of names) sheets[name] = { values: [headers[name]] };
    // Persisted text-month cells already carry @. Scratch restoration protects strings with @ too.
    if (textMonthFormats) {
      sheets.ACTUAL_EVAL_MONTHLY.formats = { D: '@' };
      sheets.EVAL_INSIGHTS.formats = { C: '@' };
    }
    for (let i = 0; i < actualCount; i++) sheets.ACTUAL_EVAL_MONTHLY.values.push(row('ACTUAL_EVAL_MONTHLY', {
      client, service_type: 'BASE', product: '合成製品' + i, target_month: '2026/07', eval_actual_amount: 100 + i,
      actual_closed_flag: 'closed', source_updated_at: NOW,
    }));
    sheets.EVAL_INSIGHTS.values.push(row('EVAL_INSIGHTS', { evaluated_at: NOW, client, target_month: '2026/07', actual_total: 100, pred_p50: 120, cause_hypothesis: '保持する人の仮説', owner: '保持する担当', action_type: '前提を更新', next_cycle_reflection: '保持する反映', status: 'in_progress' }));
    sheets.CALIBRATION_STATE.values.push(row('CALIBRATION_STATE', { client, auto_update_enabled: 1, bias_correction_factor: 1 }));
    return env.seedPlan(env.makeBook(client, sheets));
  }
  const planId = seed('合成対象製薬'), protectedId = seed('合成対象外製薬');
  const run = (code, vars = {}) => env.run(code, { __ctx: CTX, __id: planId, ...vars });
  const build = (action, inputHash) => {
    const p = { planId, action };
    if (inputHash !== undefined) p.inputHash = inputHash;
    const result = J(run('appPlanRunBuild_(__ctx,__p)', { __p: p }));
    assert.equal(result.__next.kind, 'PLAN.RUN_CALC', 'real scratch build completes');
    return { ...result.__next.payload, engine: { version: 'synthetic', sourceSha256: 'synthetic-source', webSha256: 'synthetic-web' }, result: {}, runMs: 0 };
  };
  const save = payload => J(run('appPlanRunSave_(__ctx,__p,{kind:"PLAN.RUN_SAVE",payload:__p})', { __p: payload }));
  const scratch = code => run('(() => { const b=appWorkScratch_(appPlanOf_(__id));' + code + '})()');
  const matrix = name => J(run('appStoreBook_(appPlanOf_(__id)).getSheetByName(__name).getDataRange().getValues()', { __name: name }));
  const allData = () => JSON.stringify(env.data().getSheets().map(sh => ({ name: sh.getName(), values: sh.getDataRange().getValues(), formulas: sh.getDataRange().getFormulas(), formats: sh.getDataRange().getNumberFormats() })));
  const protectedRows = () => JSON.stringify(env.data().getSheets().map(sh => [sh.getName(), env.table(sh.getName()).filter(r => r.plan_id === protectedId)]));
  run('var __guardJournalReal=appJournalRun_,__guardJournalCalls=0;appJournalRun_=function(){__guardJournalCalls++;return __guardJournalReal.apply(null,arguments)}');
  const resetJournal = () => run('__guardJournalCalls=0');
  const journalCalls = () => run('__guardJournalCalls');
  return { env, planId, protectedId, run, headers, row, build, save, scratch, matrix, allData, protectedRows, resetJournal, journalCalls };
}
function rejectSave(f, payload, mutate, message) {
  f.scratch(mutate);
  const before = f.allData(), other = f.protectedRows(); f.resetJournal();
  assert.throws(() => f.save(payload), message);
  assert.equal(f.journalCalls(), 0, 'no Journal is created for the refused result');
  assert.equal(f.run('appJournalPending_()'), null, 'refusal leaves no pending save');
  assert.equal(f.allData(), before, 'all native values, formulas and formats stay unchanged');
  assert.equal(f.protectedRows(), other, 'other-plan rows stay unchanged');
}
let passed = 0, failures = 0;
function test(name, body) { try { body(); passed++; console.log('PASS ' + name); } catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); } }

test('the first queued build refuses an explicit hash invalidated after queuing', () => {
  const f = fixture(), hash = f.run('appPlanInputHash_(__id)');
  const started = f.env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.RUN', payload: { planId: f.planId, action: 'EVAL.REPORT', inputHash: hash } } });
  // A real intervening edit updates native CONFIG before the queued first build runs.
  f.run('appPlanEdit_(__ctx,{planId:__id,action:"SETUP.PEOPLE",args:{peopleCsv:"別の合成担当"},inputHash:__hash})', { __hash: hash });
  const before = f.allData(), scratchId = f.env.props.APP_SCRATCH_SPREADSHEET_ID; f.resetJournal();
  f.env.fireTriggers('triggerRunJob');
  const status = f.env.call('apiJobStatus(__in)', { __in: { jobId: started.jobId } });
  assert.equal(status.status, 'FAILED'); assert.match(status.error, /実行を確認した後にデータ本体が変わりました/);
  assert.equal(f.journalCalls(), 0); assert.equal(f.allData(), before);
  assert.equal(f.env.props.APP_SCRATCH_SPREADSHEET_ID, scratchId, 'stale initial request does not build a new scratch');
});

test('fresh explicit hashes and existing hashless run callers can start their first build', () => {
  const f = fixture();
  f.build('EVAL.REPORT', f.run('appPlanInputHash_(__id)'));
  f.build('EVAL.DASHBOARD');
  assert.equal(f.journalCalls(), 0, 'building alone does not save native data');
});

test('an existing actual table cannot be replaced by an empty import', () => {
  const f = fixture(), p = f.build('IMPORT.ACTUALS');
  rejectSave(f, p, "const s=b.getSheetByName('ACTUAL_EVAL_MONTHLY');s.getRange(2,1,s.getMaxRows()-1,7).clearContent();", /取込元の実績が0件/);
});

for (const change of [
  "b.getSheetByName('ACTUAL_EVAL_MONTHLY').getRange(1,1).setValue('unexpected_header');",
  "b.deleteSheet(b.getSheetByName('ACTUAL_EVAL_MONTHLY'));",
]) test('missing or mismatched imported actual headers refuse native save: ' + change, () => {
  const f = fixture(), p = f.build('IMPORT.ACTUALS');
  rejectSave(f, p, change, /取り込んだ実績の列を確認できない/);
});

for (const [action, change] of [
  ['IMPORT.ACTUALS', "b.getSheetByName('CONFIG').getRange(4,2).setValue('予定外の担当');"],
  ['EVAL.REPORT', "b.getSheetByName('OUTPUT').getRange(1,1).setValue('予定外の予測');"],
  ['EVAL.INSIGHTS', "b.getSheetByName('PRODUCT').getRange(2,1).setValue('予定外の入力');"],
]) test(action + ' rejects an out-of-scope captured sheet before Journal', () => {
  const f = fixture(), p = f.build(action);
  rejectSave(f, p, change, /対象外の表が変わった/);
});

test('B2 discards unrelated format normalization while saving the allowed evaluation change', () => {
  const f = fixture({ textMonthFormats: false }), p = f.build('EVAL.REPORT'), other = f.protectedRows();
  const preserved = () => JSON.stringify(['ENG_ACTUAL_EVAL_MONTHLY','ENG_EVAL_INSIGHTS','ENG_ROWS','ENG_FORMATS','ENG_SHEETS'].map(name => [name,
    f.env.table(name).filter(r => r.plan_id === f.planId && (!r.sheet || ['ACTUAL_EVAL_MONTHLY','EVAL_INSIGHTS'].includes(r.sheet))) ]));
  const before = preserved();
  const value = f.row('EVAL_LOG', { eval_id: 'format-safe-eval', evaluated_at: NOW, client: '合成対象製薬', target_month: '2026/07', scenario: 'neutral', pred: 120, actual: 100, evaluation_policy_version: 'policy-2026H1-v3' });
  f.run("appWorkScratch_(appPlanOf_(__id)).getSheetByName('EVAL_LOG').getRange(2,1,1,__row.length).setValues([__row])", { __row: value });
  f.resetJournal(); const result = f.save(p);
  assert.equal(f.journalCalls(), 1); assert.ok(result.changed.includes('EVAL_LOG'));
  assert.ok(!result.changed.includes('ACTUAL_EVAL_MONTHLY')); assert.ok(!result.changed.includes('EVAL_INSIGHTS'));
  assert.equal(f.matrix('EVAL_LOG')[1][0], 'format-safe-eval');
  assert.equal(preserved(), before, 'unrelated cells, stored formats, dimensions and hashes are preserved exactly');
  assert.equal(f.protectedRows(), other);
});

for (const change of [
  "b.getSheetByName('OUTPUT').getRange(2,3).setNumberFormat('@').setValue('200');",
  "b.getSheetByName('OUTPUT').getRange(2,3).setFormula('=100+100');",
]) test('B2 refuses type/formula changes even when the displayed numeric value is unchanged: ' + change, () => {
  const f = fixture(), p = f.build('EVAL.REPORT');
  rejectSave(f, p, change, /対象外の表が変わった/);
});

test('unused scratch dimension growth does not rewrite an unrelated native sheet', () => {
  const f = fixture(), p = f.build('EVAL.REPORT');
  const stable = () => JSON.stringify(JSON.parse(f.allData()).filter(s => s.name !== 'PLAN_ACTIONS'));
  const before = stable();
  f.scratch("const s=b.getSheetByName('OUTPUT');s.insertRowsAfter(s.getMaxRows(),2);s.insertColumnsAfter(s.getMaxColumns(),1);");
  f.resetJournal(); const result = f.save(p);
  assert.equal(f.journalCalls(), 1); assert.ok(!result.changed.includes('OUTPUT'));
  assert.equal(stable(), before, 'native allocation metadata, cells and formats retain the original copy');
});

test('a genuinely empty first import remains allowed without fabricating actual records', () => {
  const f = fixture({ actualCount: 0 }), p = f.build('IMPORT.ACTUALS'), other = f.protectedRows();
  f.resetJournal(); const result = f.save(p);
  assert.equal(f.journalCalls(), 1); assert.equal(result.action, 'IMPORT.ACTUALS');
  assert.equal(f.matrix('ACTUAL_EVAL_MONTHLY').length, 1); assert.equal(f.protectedRows(), other);
});

test('a nonzero actual decrease is allowed rather than introducing an unapproved count policy', () => {
  const f = fixture({ actualCount: 2 }), p = f.build('IMPORT.ACTUALS'), other = f.protectedRows(), output = f.matrix('OUTPUT');
  f.scratch("const s=b.getSheetByName('ACTUAL_EVAL_MONTHLY');s.getRange(3,1,1,7).clearContent();");
  const result = f.save(p);
  assert.equal(f.journalCalls(), 1); assert.ok(result.changed.includes('ACTUAL_EVAL_MONTHLY'));
  assert.equal(f.matrix('ACTUAL_EVAL_MONTHLY').length, 2); assert.deepEqual(f.matrix('OUTPUT'), output); assert.equal(f.protectedRows(), other);
  assert.equal(f.run("appScreenSheetHashOp_(__id,'ACTUAL_EVAL_MONTHLY','')"), null, 'normal save updates dimensions and canonical hash together');
});

test('a valid initial actual record is saved with matching dimensions/hash and unrelated data intact', () => {
  const f = fixture({ actualCount: 0 }), p = f.build('IMPORT.ACTUALS'), other = f.protectedRows(), output = f.matrix('OUTPUT');
  const incoming = f.row('ACTUAL_EVAL_MONTHLY', { client: '合成対象製薬', service_type: 'BASE', product: '初回の合成製品', target_month: '2026/07', eval_actual_amount: 55, actual_closed_flag: 'closed', source_updated_at: NOW });
  f.run("appWorkScratch_(appPlanOf_(__id)).getSheetByName('ACTUAL_EVAL_MONTHLY').getRange(2,1,1,7).setValues([__row])", { __row: incoming });
  const result = f.save(p);
  assert.ok(result.changed.includes('ACTUAL_EVAL_MONTHLY')); assert.equal(f.matrix('ACTUAL_EVAL_MONTHLY')[1][4], 55);
  assert.equal(f.run("appScreenSheetHashOp_(__id,'ACTUAL_EVAL_MONTHLY','')"), null);
  assert.deepEqual(f.matrix('OUTPUT'), output); assert.equal(f.protectedRows(), other);
});

test('B2 allows current evaluation and existing automatic-calibration tables, preserving other plans and forecasts', () => {
  const f = fixture(), p = f.build('EVAL.REPORT'), other = f.protectedRows(), output = f.matrix('OUTPUT'), actual = f.matrix('ACTUAL_EVAL_MONTHLY');
  const value = f.row('EVAL_LOG', { eval_id: 'synthetic-eval', evaluated_at: NOW, client: '合成対象製薬', target_month: '2026/07', scenario: 'neutral', pred: 120, actual: 100, evaluation_policy_version: 'policy-2026H1-v3' });
  f.run("const __s=appWorkScratch_(appPlanOf_(__id));__s.getSheetByName('EVAL_LOG').getRange(2,1,1,__row.length).setValues([__row]);__s.getSheetByName('CALIBRATION_STATE').getRange(2,7).setValue(0.98)", { __row: value });
  const result = f.save(p);
  assert.ok(result.changed.includes('EVAL_LOG')); assert.ok(result.changed.includes('CALIBRATION_STATE'));
  assert.equal(f.journalCalls(), 1); assert.equal(f.matrix('EVAL_LOG')[1][20], 'policy-2026H1-v3');
  assert.deepEqual(f.matrix('OUTPUT'), output); assert.deepEqual(f.matrix('ACTUAL_EVAL_MONTHLY'), actual); assert.equal(f.protectedRows(), other);
  for (const name of ['EVAL_LOG', 'CALIBRATION_STATE']) assert.equal(f.run('appScreenSheetHashOp_(__id,__name,"")', { __name: name }), null);
});

test('B4 saves allowed machine changes while preserving loaded human values and unrelated tables', () => {
  const f = fixture(), p = f.build('EVAL.INSIGHTS'), other = f.protectedRows(), original = f.matrix('EVAL_INSIGHTS')[1], output = f.matrix('OUTPUT');
  f.scratch("b.getSheetByName('EVAL_INSIGHTS').getRange(2,8).setValue('新しい採点の説明');");
  const result = f.save(p);
  assert.ok(result.changed.includes('EVAL_INSIGHTS')); assert.equal(f.journalCalls(), 1);
  const saved = f.matrix('EVAL_INSIGHTS')[1];
  for (const col of [14, 16, 18, 19, 20, 21, 22]) assert.equal(saved[col], original[col], 'human column ' + col);
  assert.equal(saved[7], '新しい採点の説明'); assert.equal(f.run("appScreenSheetHashOp_(__id,'EVAL_INSIGHTS','')"), null);
  assert.deepEqual(f.matrix('OUTPUT'), output); assert.equal(f.protectedRows(), other);
});

test('an unrelated run action retains its established save behavior', () => {
  const f = fixture(), p = f.build('EVAL.DASHBOARD'), other = f.protectedRows();
  f.scratch("b.getSheetByName('DASHBOARD').getRange(2,1,1,3).setValues([['合成指標',3,'既存動作']]);");
  const result = f.save(p);
  assert.equal(result.action, 'EVAL.DASHBOARD'); assert.ok(result.changed.includes('DASHBOARD')); assert.equal(f.journalCalls(), 1);
  assert.equal(f.matrix('DASHBOARD')[1][1], 3); assert.equal(f.protectedRows(), other);
});

assert.equal(failures, 0, 'evaluation save guards preserve native data and established run contracts');
console.log('app-plan-evaluation-save-guard: ' + passed + ' real build/save, Journal refusal, canonical metadata and preservation cases PASS');
