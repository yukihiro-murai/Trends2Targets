#!/usr/bin/env node
/** Synthetic diagnosis only. Never executes EVAL jobs, edits policy records, or includes real customer rows. */
import assert from 'node:assert/strict';
import { setUpEnv, OWNER, STATS, J } from './gas-mock.mjs';

const CLIENT = '合成診断製薬', PRIVATE = 'SYNTHETIC_PRIVATE_MEMO_7123456789';
const NAMES = ['ACTUAL_EVAL_MONTHLY', 'EVAL_LOG', 'EVAL_INSIGHTS', 'RUN_LOG'];
const env = setUpEnv();
const H = J(env.run('Object.fromEntries(Object.keys(APP_ENGINE_SHEETS).map(k=>[k,APP_ENGINE_SHEETS[k].header||null]))'));
const POLICY = env.run('APP_EVAL_POLICY_VERSION');
const iso = day => day + 'T12:00:00+09:00';
const values = (name, rows) => [H[name].slice(), ...rows.map(r => H[name].map(h => r[h] === undefined ? '' : r[h]))];
const ev = (extra = {}) => ({ client: CLIENT, target_month: '2026/07', scenario: 'neutral', pred: 110, actual: 100, evaluated_at: iso('2026-08-11'), evaluation_policy_version: POLICY, constraint_relevant_flag: 1, ...extra });
const actual = (extra = {}) => ({ client: CLIENT, service_type: 'ベース', product: '合成製品', target_month: '2026/07', eval_actual_amount: 100, actual_closed_flag: 1, source_updated_at: iso('2026-08-06'), ...extra });
const ins = (extra = {}) => ({ client: CLIENT, target_month: '2026/07', actual_total: 100, pred_p50: 110, evaluated_at: iso('2026-08-12'), cause_hypothesis: PRIVATE, owner: PRIVATE, next_cycle_reflection: PRIVATE, action_type: 'update', status: 'open', ...extra });
const log = (name, day, extra = {}) => ({ function_name: name, status: 'success', run_at: iso(day), run_by: PRIVATE, error_summary: name === 'updatePhase1EvaluationReport' ? POLICY + ': scored_months=1' : '', ...extra });
const visible = () => ({ row: 2, month: '2026/07', actual: 100, pred: 110, hypothesis: PRIVATE, owner: PRIVATE });
function fixture({ actuals = [actual()], evals = [], insights = [], displayed = [], logs = [], before } = {}) {
  const matrices = Object.fromEntries(NAMES.map(name => [name, values(name, ({ ACTUAL_EVAL_MONTHLY: actuals, EVAL_LOG: evals, EVAL_INSIGHTS: insights, RUN_LOG: logs })[name])]));
  const boot = { setup: { client: CLIENT, fy: 2026 }, eval: { insights: displayed } }, reads = Object.fromEntries(NAMES.map(n => [n, 0])), throws = new Set();
  const book = { getSheetByName(name) {
    if (!(name in matrices)) return null;
    return { getDataRange() { return { getValues() { reads[name]++; if (throws.has(name)) throw new Error(PRIVATE); return matrices[name].map(r => r.slice()); } }; } };
  } };
  return { matrices, boot, book, reads, throws, before };
}
function diagnose(f) {
  const before = JSON.stringify([f.boot, f.matrices, f.before]);
  const writes = STATS.writes;
  const result = J(env.run('appInsightReadiness_(__boot,__book,__before)', { __boot: f.boot, __book: f.book, __before: f.before }));
  assert.equal(JSON.stringify([f.boot, f.matrices, f.before]), before, 'diagnosis never mutates boot, source rows or before-filter rows');
  assert.equal(STATS.writes, writes, 'diagnosis writes no stored cells');
  assert.equal(result.currentPolicy, POLICY);
  assert.deepEqual(Object.keys(result).sort(), ['code', 'counts', 'currentPolicy', 'lastB2At', 'lastB4At', 'reason']);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(PRIVATE + '|' + CLIENT + '|合成製品'), 'diagnosis contains no person, client, memo, product or money values');
  for (const count of Object.values(f.reads)) assert.ok(count <= 1, 'each source table is read at most once');
  return result;
}
let passed = 0, failures = 0;
function test(name, body) { try { body(); passed++; console.log('PASS ' + name); } catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); } }

// Production-shaped counts only: one old-policy plan (30 scenario rows/10 insights) and 44 empty plans.
// The names, amounts, dates and human notes below are entirely synthetic.
test('the old-policy-only plan is distinct from the 44 all-empty plans', () => {
  const months = Array.from({ length: 10 }, (_, i) => (i < 6 ? '2025' : '2026') + '/' + String((i + 6) % 12 + 1).padStart(2, '0'));
  const f = fixture({ actuals: months.map(target_month => actual({ target_month, source_updated_at: iso('2026-10-06') })),
    evals: months.flatMap(target_month => ['nega', 'neutral', 'posi'].map(scenario => ev({ target_month, scenario, evaluation_policy_version: 'policy-2026H1-v1' }))),
    insights: months.map(target_month => ins({ target_month })), before: [] });
  const r = diagnose(f); assert.equal(r.code, 'OLD_POLICY');
  assert.equal(r.counts.evalRows, 30); assert.equal(r.counts.oldPolicyNeutralRows, 10); assert.equal(r.counts.insightRows, 10); assert.equal(r.counts.currentPolicyNeutralMonths, 0);
  const e = fixture({ actuals: [] }), empty = diagnose(e);
  assert.equal(empty.code, 'NO_ACTUALS'); assert.equal(empty.counts.evalRows, 0); assert.equal(empty.counts.insightRows, 0); assert.equal(empty.counts.actualRows, 0);
  const roster = [r, ...Array.from({ length: 44 }, () => diagnose(fixture({ actuals: [] })))];
  assert.deepEqual(roster.reduce((by, result) => { by[result.code] = (by[result.code] || 0) + 1; return by; }, {}), { OLD_POLICY: 1, NO_ACTUALS: 44 }, 'the observed roster classification stays intact without importing real rows');
});

test('closed actuals without current scoring are not mistaken for missing actuals', () => {
  const r = diagnose(fixture()); assert.equal(r.code, 'NO_CURRENT_EVAL'); assert.equal(r.counts.closedActualMonths, 1); assert.equal(r.counts.eligibleMonths, 0);
});

test('an explicit open flag or import before the close lag cannot make a closed month', () => {
  for (const row of [actual({ actual_closed_flag: 0 }), actual({ source_updated_at: iso('2026-08-04') })]) {
    const r = diagnose(fixture({ actuals: [row], evals: [ev()] })); assert.equal(r.code, 'NO_CLOSED_ACTUALS'); assert.equal(r.counts.closedActualMonths, 0);
  }
});

test('all service rows for a client/month must satisfy closure, not just one', () => {
  const r = diagnose(fixture({ actuals: [actual(), actual({ actual_closed_flag: 'open', product: '合成別製品' })], evals: [ev()] }));
  assert.equal(r.code, 'NO_CLOSED_ACTUALS'); assert.equal(r.counts.closedActualMonths, 0);
});

test('current scoring with no generated insight rows reports missing insight records', () => {
  const f = fixture({ evals: [ev()], logs: [log('updatePhase1EvaluationReport', '2026-08-11')] }), r = diagnose(f);
  assert.equal(r.code, 'INSIGHTS_MISSING'); assert.equal(r.counts.eligibleMonths, 1); assert.equal(r.counts.insightRows, 0);
  assert.equal(r.lastB2At, '2026-08-11T03:00:00.000Z'); assert.equal(r.lastB4At, null);
  assert.deepEqual(Object.values(f.reads), [1, 1, 1, 1], 'successful classification reads exactly four source tables');
});

test('an older insight time is separated from a changed scored amount', () => {
  for (const [row, time, mismatch] of [[ins({ evaluated_at: iso('2026-08-10') }), 1, 0], [ins({ pred_p50: 111 }), 0, 1]]) {
    const r = diagnose(fixture({ evals: [ev()], insights: [row], before: [visible()] }));
    assert.equal(r.code, 'INSIGHTS_STALE'); assert.equal(r.counts.staleTimeRows, time); assert.equal(r.counts.mismatchedValueRows, mismatch);
  }
});

test('matching displayed records are ready and return only safe counts and last successful times', () => {
  const r = diagnose(fixture({ evals: [ev()], insights: [ins()], displayed: [visible()], before: [visible()], logs: [
    log('updatePhase1EvaluationReport', '2026-08-09'), log('updatePhase1EvaluationReport', '2026-08-11'), log('updatePhase1EvaluationReport', '2026-08-14', { status: 'failed' }),
    log('updatePhase1LearningInsights', '2026-08-12'), log('updatePhase1LearningInsights', '2026-08-15', { status: 'failed' }),
  ] }));
  assert.equal(r.code, 'READY'); assert.equal(r.counts.displayedRows, 1); assert.equal(r.counts.legacyVisibleRows, 1);
  assert.equal(r.lastB2At, '2026-08-11T03:00:00.000Z'); assert.equal(r.lastB4At, '2026-08-12T03:00:00.000Z');
});

test('client-scoped actuals and a malformed fiscal year do not fabricate current-FY counts', () => {
  const f = fixture({ actuals: [actual(), actual({ client: '別の合成製薬' })] }); f.boot.setup.fy = 'unknown';
  const r = diagnose(f); assert.equal(r.counts.actualRows, 1); assert.equal(r.counts.closedActualMonths, 1); assert.equal(r.counts.closedCurrentFyMonths, null);
});

for (const name of NAMES) test('missing table is not prepared, never a fabricated zero count: ' + name, () => {
  const f = fixture(); delete f.matrices[name]; const r = diagnose(f);
  assert.equal(r.code, 'NOT_PREPARED'); assert.equal(r.counts.missingTables, 1);
  if (name === 'ACTUAL_EVAL_MONTHLY') assert.equal(r.counts.actualRows, null);
  if (name === 'EVAL_LOG') assert.equal(r.counts.evalRows, null);
  if (name === 'EVAL_INSIGHTS') assert.equal(r.counts.insightRows, null);
});

for (const name of NAMES) test('missing or duplicated mandatory header is unknown: ' + name, () => {
  for (const duplicate of [false, true]) {
    const f = fixture();
    if (duplicate) f.matrices[name][0].push(f.matrices[name][0][0]); else f.matrices[name][0].shift();
    const r = diagnose(f); assert.equal(r.code, 'UNKNOWN');
    assert.equal(r.counts.eligibleMonths, null, 'incomplete evidence does not become a no-target conclusion');
  }
});

for (const name of NAMES) test('partial read failure is unknown and never leaks its error text: ' + name, () => {
  const f = fixture(); f.throws.add(name); const r = diagnose(f); assert.equal(r.code, 'UNKNOWN'); assert.equal(r.counts.eligibleMonths, null);
});

test('invalid month/time/context and inconsistent before-filter rows are unknown', () => {
  const fixtures = [fixture({ actuals: [actual({ target_month: '2026/99' })] }), fixture({ logs: [log('updatePhase1EvaluationReport', '2026-08-11', { run_at: PRIVATE })] }),
    fixture({ evals: [ev()], insights: [ins()], before: [] }), fixture()];
  delete fixtures.at(-1).boot.setup.client;
  for (const f of fixtures) assert.equal(diagnose(f).code, 'UNKNOWN');
});

test('source row gaps retain their real sheet row and invented displayed rows are unknown', () => {
  const f = fixture({ evals: [ev()], insights: [ins()], displayed: [{ ...visible(), row: 3 }], before: [{ ...visible(), row: 3 }] });
  f.matrices.EVAL_INSIGHTS.splice(1, 0, Array(H.EVAL_INSIGHTS.length).fill(''));
  assert.equal(diagnose(f).code, 'READY', 'a blank preceding source row does not shift the record identity');
  for (const row of [99, 'not-a-row']) {
    const bad = fixture({ evals: [ev()], insights: [ins()], displayed: [{ ...visible(), row }], before: [visible()] });
    assert.equal(diagnose(bad).code, 'UNKNOWN', 'diagnosis must not invent a visible source row');
  }
});

function planFixture() {
  const e = setUpEnv(), f = fixture({ evals: [ev()], insights: [ins()], logs: [log('updatePhase1EvaluationReport', '2026-08-11'), log('updatePhase1LearningInsights', '2026-08-12')] });
  const sheets = { CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', CLIENT], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '合成担当']] }, OUTPUT: { values: [['合成予測']] } };
  for (const name of NAMES) sheets[name] = { values: f.matrices[name], formats: { [name === 'EVAL_LOG' ? 'D' : name === 'EVAL_INSIGHTS' ? 'C' : name === 'ACTUAL_EVAL_MONTHLY' ? 'D' : 'B']: '@' } };
  const planId = e.seedPlan(e.makeBook('合成診断計画', sheets));
  const read = () => e.call('apiPlanView(__in)', { __in: { planId } });
  const clear = () => { for (const k of Object.keys(e.cache)) delete e.cache[k]; };
  return { e, planId, read, clear };
}
const dataSnapshot = e => JSON.stringify(e.data().getSheets().map(s => ({ name: s.getName(), values: s.getDataRange().getValues(), formulas: s.getDataRange().getFormulas(), formats: s.getDataRange().getNumberFormats() })));

test('both view APIs, warm caches, privacy and budget wrappers preserve readiness without altering data', () => {
  const { e, planId, read } = planFixture(), before = dataSnapshot(e);
  const first = read(); assert.equal(first.boot.eval.readiness.code, 'READY');
  const warm = read(), page = e.call('apiForecastPage(__in)', { __in: { planId, parts: ['view'] } });
  assert.deepEqual(warm.boot.eval.readiness, first.boot.eval.readiness); assert.deepEqual(page.view.boot.eval.readiness, first.boot.eval.readiness);
  const wrapped = J(e.run(`(() => { const v=__v, before=JSON.stringify(v);const out=appPlanViewFor_({roles:[{role:'VIEWER',scope_type:'ALL'}]},v,{client_id:'synthetic'});return {same:JSON.stringify(v)===before,privacy:out.boot.eval, budget:appPlanViewBudgetDraft_(out.boot,appPlanOf_(__id)).eval}; })()`, { __v: first, __id: planId }));
  assert.equal(wrapped.same, true); assert.deepEqual(wrapped.privacy.readiness, first.boot.eval.readiness); assert.deepEqual(wrapped.budget.readiness, first.boot.eval.readiness);
  assert.equal(wrapped.privacy.insights[0].owner, ''); assert.equal(first.boot.eval.insights[0].owner, PRIVATE);
  assert.equal(dataSnapshot(e), before, 'readiness reads do not modify existing rows, formulas or formats');
});

test('frozen capability and pending metadata preserve existing read contracts', () => {
  const { e, planId, read, clear } = planFixture(); const normal = read().boot.eval.readiness;
  e.run('appYearIsFrozen_=function(){return true}'); clear();
  const frozen = read(); assert.equal(frozen.can.plan, false); assert.deepEqual(frozen.boot.eval.readiness, normal);
  clear(); e.run("appJournalPending_=function(){return {label:'synthetic pending',at:'2026-11-01'}}");
  const pending = read(); assert.equal(pending.boot, null); assert.ok(pending.pendingWrite);
});

test('unknown diagnosis is not cached in either layer and a later read can recover', () => {
  const { e, read } = planFixture();
  e.run("var __readyReal=appInsightReadiness_,__readyCalls=0;appInsightReadiness_=function(){__readyCalls++;if(__readyCalls===1)return {code:'UNKNOWN',reason:'一時読込失敗',counts:{},currentPolicy:APP_EVAL_POLICY_VERSION,lastB2At:null,lastB4At:null};return __readyReal.apply(null,arguments)}");
  assert.equal(read().boot.eval.readiness.code, 'UNKNOWN');
  assert.equal(read().boot.eval.readiness.code, 'READY'); assert.equal(e.run('__readyCalls'), 2, 'both inner and outer unknown results were bypassed');
  read(); assert.equal(e.run('__readyCalls'), 2, 'the recovered result is cached normally');
});

test('unversioned old inner and outer cache entries cannot hide the new diagnosis', () => {
  const { e, planId, read } = planFixture();
  const proof = J(e.run(`(() => { const id=__id,old={boot:{setup:{client:'old-cache'},eval:{insights:[]}},engine:{},builtMs:0};const day=Utilities.formatDate(new Date(),APP_TZ,'yyyy-MM-dd');const key='VIEW_'+appSha256Hex_([id,appPlanInputHash_(id),day,APP_VERSION].join('|')).slice(0,32),outer='VIEW\\u0001'+__owner+'\\u0001'+id+'\\u0001'+appToday_();appJobPutResult_(key,old);appCachedRead_(outer,()=>old);return {inner:appJobGetResult_(key).value.boot.setup.client,outer:appCachedRead_(outer,()=>null).boot.setup.client}; })()`, { __id: planId, __owner: OWNER }));
  assert.deepEqual(proof, { inner: 'old-cache', outer: 'old-cache' }, 'both old entries are present and readable before the new route is called');
  const result = read(); assert.equal(result.boot.eval.readiness.code, 'READY'); assert.equal(result.boot.setup.client, CLIENT);
});

test('previously cached UNKNOWN results are also retried in both current cache layers', () => {
  const { e, planId, read } = planFixture();
  e.run(`(() => { const id=__id,old={boot:{setup:{client:__client},eval:{insights:[],readiness:{code:'UNKNOWN'}}},engine:{},builtMs:0};const day=Utilities.formatDate(new Date(),APP_TZ,'yyyy-MM-dd'),inner='VIEW_'+appSha256Hex_([id,appPlanInputHash_(id),day,APP_VERSION,APP_INSIGHT_READINESS_REV].join('|')).slice(0,32);appJobPutResult_(inner,old);appCachedRead_('VIEW\\u0001'+APP_INSIGHT_READINESS_REV+'\\u0001'+__owner+'\\u0001'+id+'\\u0001'+appToday_(),()=>old); })()`, { __id: planId, __owner: OWNER, __client: CLIENT });
  assert.equal(read().boot.eval.readiness.code, 'READY');
});

test('job warming uses the same diagnosis read path without executing a save or evaluation job', () => {
  const { e, planId, read, clear } = planFixture(); clear(); const before = dataSnapshot(e);
  e.run("var __warmCount=0,__warmRead=appInsightReadiness_;appInsightReadiness_=function(){__warmCount++;return __warmRead.apply(null,arguments)};appJobWarm_({kind:'PLAN.EDIT',payload:{planId:__id},actor_email:__owner},0)", { __id: planId, __owner: OWNER });
  assert.equal(read().boot.eval.readiness.code, 'READY'); assert.equal(e.run('__warmCount'), 1);
  assert.equal(dataSnapshot(e), before);
});

test('optional cacheIf preserves old callers and skips caching only when asked', () => {
  const e = setUpEnv();
  const r = J(e.run(`(() => { let old=0,skip=0;const one=appCachedRead_('synthetic-old',()=>++old),two=appCachedRead_('synthetic-old',()=>++old);const a=appCachedRead_('synthetic-skip',()=>++skip,()=>false),b=appCachedRead_('synthetic-skip',()=>++skip,()=>false);return {one,two,old,a,b,skip}; })()`));
  assert.deepEqual(r, { one: 1, two: 1, old: 1, a: 1, b: 2, skip: 2 });
});

assert.equal(failures, 0, 'insight readiness regressions pass');
console.log('app-insight-readiness: ' + passed + ' safe classification, immutable evidence, permissions and cache-path cases PASS');
