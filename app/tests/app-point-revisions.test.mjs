/** Point-only revisions use the real Store/Journal/readers and entirely constructed data. */
import assert from 'node:assert/strict';
import { J, OWNER, setUpEnv } from './gas-mock.mjs';

const METHOD = 'BB_EQUAL_WEIGHT_W_AA_COMBINATION';
const FY = 2026;
const MONTHS = Array.from({ length: 12 }, (_, i) => `${i < 9 ? FY : FY + 1}/${String((i + 3) % 12 + 1).padStart(2, '0')}`);
const W_POINTS = Array(12).fill(10);
const POINTS = Array(12).fill(8);
const latest = (f, id = f.ids[0]) => f.env.call('apiForecastLatest(__in)', { __in: { planId: id } });
const state = f => f.env.call('appPointLoadState_({user:{isOwner:true},actor:__actor},__id)', { __actor: OWNER, __id: f.preview.publicationId });

function fixture(measures = 5) {
  const env = setUpEnv();
  const sourceBook = env.makeBook('合成売上元', { Sheet1: { values: [['constructed']] } });
  const sourceUrl = 'https://docs.google.com/spreadsheets/d/' + sourceBook.getId() + '/edit';
  env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: sourceUrl } });
  const policy = env.call(`(() => {const p=appPointPolicy_(__method);return {policySha256:p.policySha256,engineSourceSha256:p.engineSourceSha256};})()`, { __method: METHOD });
  // Preserve the real immutable registry; substitute only the pure calculation entrypoint.
  env.run(`
    var __pointCalls=0;
    appPointEngine_=function(){
      const p=appPointPolicy_(__method);
      return {VERSION:'constructed-point-engine',SOURCE_SHA256:p.engineSourceSha256,WEB_SOURCE_SHA256:'c'.repeat(64),
        appHistoryCombinationForecast_:function(history,fy){
          __pointCalls++;
          if(history.length!==48||history[0].ym!=='2022-04'||history[47].ym!=='2026-03')throw Error('Wrong history prefix');
          const net=history.slice(-12).reduce((s,r)=>s+r.base,0)+history.slice(-12).reduce((s,r)=>s+r.spot,0);
          return {method:__method,points:Array(12).fill(8),total:96,active:true,net12:net,
            profileYears:[fy-3,fy-2,fy-1],halfTargets:[48,48],mode:'equal_weight_complete_policies',rescue:'none',
            wPoints12:Array(12).fill(10),completeAA:{points:Array(12).fill(6)}};
        }};
    };`, { __method: METHOD });
  const ids = [], books = [];
  for (let i = 0; i <= measures; i++) {
    const dates = Array.from({ length: 48 }, (_, m) => new Date(Date.UTC(2022, 3 + m, 1) - 9 * 3600000));
    const book = env.makeBook('Constructed point plan ' + i, {
      CONFIG: { values: [['field', 'value'], ['client', '合成メーカー' + i], ['FY', FY], ['people', '担当A']] },
      SALES_INPUT: { values: [['service_type', 'product', 'sales_month', 'amount']] },
      SALES_MONTHLY: { cols: 49, values: [['TYPE', ...dates], ['BASE', ...Array(48).fill(100)], ['SPOT', ...Array(48).fill(0)], ['TOTAL', ...Array(48).fill(100)]] },
    });
    const id = env.seedPlan(book);
    books.push(book);
    ids.push(id);
    env.run(`(() => {
      if(__measure)appPatchRow_('PLANS',{plan_id:__id},{purpose:'MEASURE',row_version:2},'constructed');
      const p=appPlanOf_(__id),engine={version:'original-engine',sourceSha256:'original-engine-source'};
      const planning={version:'HISTORY_MONTHLY_POINT_V2',applied:true,method:'W_COMPONENT_EVENT_HALF_SHAPE_BLEND',
        provisional:true,validationStatus:'in_progress',annualRawP50:100,annualTarget:120,annualBasis:'sum_monthly_points',
        trainingThroughYm:'2026/03',cleanHistoryStartYm:'2023/04',historyYearsUsed:[2023,2024,2025],halfTargets:[60,60],
        provisionalWeights:[0,0],provisionalFolds:[],provisionalMode:'complete_S',
        months:__months.map((ym,i)=>({ym:ym,point:10,share:1/12,mean:11+i}))};
      const run={plan_id:__id,run_id:'CONSTRUCTED-'+__id,status:'DONE',started_at:'2026-04-06T00:00:00Z',finished_at:'2026-04-06T00:00:01Z',
        as_of:'2026-04-06T00:00:00Z',app_version:APP_VERSION,engine_version:engine.version,engine_sha256:engine.sourceSha256,
        seed:appForecastSeed_(p,appForecastInputHash_(__id),engine),seed_rule:APP_FORECAST_SEED_RULE,planning_json:planning,
        annual_p10:50,annual_p50:100,annual_p90:200,objective_p10:50,objective_p50:100,objective_p90:200};
      appEnsureRows_('FORECAST_RUNS',[run]);
      appEnsureRows_('FORECAST_MONTHLY',__months.map(ym=>({plan_id:__id,run_id:run.run_id,ym:ym,p10:1,p50:10,p90:30,obj_p10:1,obj_p50:10,obj_p90:30})));
      appStoreForget_();
    })()`, { __id: id, __measure: i < measures, __months: MONTHS });
  }
  const f = { env, ids, books, sourceUrl, measures, normalId: ids.at(-1), policy };
  f.previewInput = { fy: FY, method: METHOD, policySha256: policy.policySha256 };
  f.previewAll = () => {
    let r = env.task('previewPointRevision(__in)', { __in: f.previewInput });
    assert.ok(r.computedThisCall <= 4);
    while (r.status === 'PREVIEW') {
      r = env.task('previewPointRevision(__in)', { __in: { ...f.previewInput, publicationId: r.publicationId } });
      assert.ok(r.computedThisCall <= 4);
    }
    assert.equal(r.status, 'READY');
    f.preview = r;
    f.applyInput = { publicationId: r.publicationId, method: METHOD, policySha256: policy.policySha256, previewSha256: r.previewSha256 };
    return r;
  };
  f.applyAll = () => {
    let r;
    do { r = env.task('applyPointRevision(__in)', { __in: f.applyInput }); assert.ok(r.appliedThisCall <= 4); } while (r.status === 'APPLYING');
    assert.equal(r.status, 'DONE');
    return r;
  };
  return f;
}
const allTables = f => f.env.call('Object.fromEntries(Object.keys(APP_TABLES).map(k=>[k,appReadTable_(k).map(appStripRow_)]))');

// The complete roster is preserved. Only append-only PLAN_ACTIONS rows change in the data store.
{
  const f = fixture(44);
  f.env.run(`appJournalRun_({actor:__actor},'constructed protected rows',__normal,[
    {table:'BUDGET_DRAFTS',mode:'append',rows:[{plan_id:__normal,draft_id:'CONSTRUCTED-DRAFT',ym:'2026/04',adopted:17,uplift:3,basis:'MANUAL',saved_at:'2026-04-06T00:00:00Z'}]},
    {table:'PLAN_VERSIONS',mode:'ensure',rows:[{plan_id:__normal,version_id:'CONSTRUCTED-OFFICIAL',version_no:1,state:'APPROVED',budget_adopted:17,budget_uplift:3,budget_final:20,monthly_json:[]}]},
    {table:'METHOD_WEIGHTS',mode:'append',rows:[{plan_id:__measure,weight_id:'CONSTRUCTED-WEIGHTS',run_id:'CONSTRUCTED-'+__measure,w_linear:.25,w_recent:.25,w_robust:.25,w_sim:.25,basis:'PRIOR',posterior_json:{kept:true},evidence_hash:'constructed-evidence'}]},
    {table:'EFFECT_COEFS',mode:'append',rows:[{plan_id:__measure,coef_id:'CONSTRUCTED-EFFECT',run_id:'CONSTRUCTED-'+__measure,beta_human:1,beta_ai:1,basis:'PRIOR',posterior_json:{kept:true},evidence_hash:'constructed-evidence'}]}
  ]);appStoreForget_();`, { __actor: OWNER, __normal: f.normalId, __measure: f.ids[0] });
  const before = allTables(f);
  assert.equal(f.env.run('Object.keys(APP_POINT_APPROVED_POLICIES).join()'), METHOD+',EE_PREQUENTIAL_AMOUNT_POLICY_BB');
  assert.equal(f.env.run('appPointPolicy_("Z_CALENDAR_SUPPORT_SHRINK_W")'), null);
  assert.equal(f.env.run('appPointPolicy_("__proto__")'), null);
  assert.equal(f.env.run('appLegacyEngine_(appLegacyServices_({}, {actor:Session.getActiveUser().getEmail()})).SOURCE_SHA256'), f.env.run('appPointPolicy_("EE_PREQUENTIAL_AMOUNT_POLICY_BB").engineSourceSha256'),
    'the approved policy binds the assembled engine source');
  assert.equal(latest(f).pointRevision, null);
  const first = f.env.task('previewPointRevision(__in)', { __in: f.previewInput });
  assert.equal(first.computedThisCall, 4);
  assert.equal(first.total, 44);
  assert.equal(first.excludedNormal, 1);
  let r = first;
  while (r.status === 'PREVIEW') r = f.env.task('previewPointRevision(__in)', { __in: { ...f.previewInput, publicationId: r.publicationId } });
  f.preview = r;
  f.applyInput = { publicationId: r.publicationId, method: METHOD, policySha256: f.policy.policySha256, previewSha256: r.previewSha256 };
  assert.equal(r.status, 'READY');
  assert.equal(f.env.run('__pointCalls'), 44);
  assert.deepEqual(allTables(f), before, 'preview writes private evidence files, never application tables');
  const applied = f.env.task('applyPointRevision(__in)', { __in: f.applyInput });
  assert.equal(applied.appliedThisCall, 4);
  f.applyAll();
  const after = allTables(f);
  assert.equal(after.PLAN_ACTIONS.length - before.PLAN_ACTIONS.length, 44);
  for (const name of Object.keys(before)) if (name !== 'PLAN_ACTIONS') assert.deepEqual(after[name], before[name], name + ' remains exact');
  for (const action of after.PLAN_ACTIONS.filter(a => a.action === 'FORECAST.POINT_REFRESH')) {
    assert.equal(action.changed_sheets_json, '[]');
    assert.equal(action.seed, '');
    assert.equal(action.engine_sha256, f.policy.engineSourceSha256);
    const payload = JSON.parse(action.result_json);
    assert.equal(payload.baseRunId, 'CONSTRUCTED-' + action.plan_id);
    assert.deepEqual(payload.planning.months.map(m => m.point), POINTS);
  }
  const d = latest(f);
  assert.equal(d.planning.method, METHOD);
  assert.equal(d.rawPlanning.annualTarget, 120);
  assert.equal(d.planning.annualTarget, 96);
  assert.equal(d.latest.annual_p50, 100);
  assert.deepEqual(d.monthly.map(m => m.p50), W_POINTS);
  assert.deepEqual(d.planning.months.map(m => m.mean), d.rawPlanning.months.map(m => m.mean));
  assert.equal(d.latest.finished_at, '2026-04-06T00:00:01Z');
  assert.ok(d.pointRevision);
  assert.equal(latest(f, f.normalId).pointRevision, null);
  assert.deepEqual(latest(f, f.normalId).planning.months.map(m => m.point), W_POINTS);
  const portfolio = f.env.call('appPortfolioData_()');
  assert.equal(portfolio.plans.length, 45);
  assert.equal(portfolio.plans.find(p => p.planId === f.ids[0]).forecastPointAnnual, 96);
  assert.equal(portfolio.plans.find(p => p.planId === f.normalId).forecastPointAnnual, 120);
  const ready = f.env.call('appProvisionalReadiness_(appPlanOf_(__id),appProvisionalSnapshot_())', { __id: f.ids[0] });
  assert.equal(ready.method, METHOD);
  assert.equal(ready.rawMethod, 'W_COMPONENT_EVENT_HALF_SHAPE_BLEND');
  assert.equal(ready.forecastReady, true);
  assert.equal(ready.planningReady, true);
  const n = after.PLAN_ACTIONS.length;
  assert.equal(f.env.task('applyPointRevision(__in)', { __in: f.applyInput }).appliedThisCall, 0);
  assert.equal(f.env.table('PLAN_ACTIONS').length, n, 'replay appends no duplicate revision');
  assert.equal(f.env.run('__pointCalls'), 44, 'readers and replay perform no model work');

  // Native CALC metadata is accepted only with the current registered source and validated planning contract.
  const unstamped = J(d.planning);
  delete unstamped.pointPolicySha256;
  delete unstamped.pointPolicySourceSha256;
  const stamp = (raw, source) => f.env.call('appPointNativePlanning_(__raw,{sourceSha256:__source},2026,100)', { __raw: raw, __source: source });
  assert.deepEqual(stamp(unstamped, f.policy.engineSourceSha256), d.planning);
  assert.equal(stamp(unstamped, '0'.repeat(64)), null);
  assert.equal(stamp({ ...unstamped, provisionalWeights: [0.5] }, f.policy.engineSourceSha256), null);
  assert.equal(f.env.call('appForecastPlanningOf_(__raw,2026,100)', { __raw: { ...d.planning, halfTargets: [49, 47] } }), null);
  assert.equal(f.env.call('appForecastPlanningOf_(__raw,2026,100)', { __raw: { ...d.planning, pointPolicySourceSha256: '0'.repeat(64) } }), null);
  assert.ok(f.env.call('appForecastPlanningOf_(__raw,2026,100)', { __raw: d.rawPlanning }), 'old W V2 remains readable');
  const v1 = { version: 'HISTORY_MONTHLY_POINT_V1', applied: true, method: 'CONSTRUCTED_V1', annualRawP50: 100, annualTarget: 100,
    trainingThroughYm: '2026/03', months: MONTHS.map((ym, i) => ({ ym, point: i ? 0 : 100, share: i ? 0 : 1, mean: 1 })) };
  assert.ok(f.env.call('appForecastPlanningOf_(__raw,2026,100)', { __raw: v1 }));
  assert.equal(f.env.call('appForecastPlanningOf_(__raw,2026,100)', { __raw: { ...v1, annualTarget: 99 } }), null);
}

// Actual native CALC → SAVE uses the approved source stamp. The MC body alone is a constructed stub.
{
  const env = setUpEnv(), output = Array.from({ length: 79 }, () => []);
  output[25] = ['年度合計（予測）', 50, 100, 200];
  output[64] = ['年度合計（客観）', 50, 100, 200];
  MONTHS.forEach((ym, i) => { output[28 + i] = [ym, 1, 10, 30, '', '', '', 10, '']; output[67 + i] = [ym, 1, 10, 30]; });
  const book = env.makeBook('合成CALC', {
    CONFIG: { values: [['field', 'value'], ['client', '合成CALCメーカー'], ['FY', FY], ['people', '担当A']] },
    OUTPUT: { values: output },
  });
  const id = env.seedPlan(book);
  env.run('appPatchRow_("PLANS",{plan_id:__id},{purpose:"MEASURE",row_version:2},"constructed");appStoreForget_()', { __id: id });
  const raw = { version: 'HISTORY_MONTHLY_POINT_V2', applied: true, method: METHOD, provisional: true, validationStatus: 'in_progress',
    annualRawP50: 100, annualTarget: 96, annualBasis: 'sum_monthly_points', trainingThroughYm: '2026/03', cleanHistoryStartYm: '2023/04',
    historyYearsUsed: [2023, 2024, 2025], halfTargets: [48, 48], provisionalWeights: [], provisionalFolds: [],
    provisionalMode: 'equal_weight_complete_policies', provisionalRescue: 'none',
    months: MONTHS.map((ym, i) => ({ ym, point: 8, share: 1 / 12, mean: 11 + i })) };
  env.run(`appLegacyEngine_=function(){return {WEB_UI_CONFIRMS_:{},VERSION:'constructed-calc',SOURCE_SHA256:appPointPolicy_(__method).engineSourceSha256,
    runPhase1Forecast:function(){return {monthlyPlanning:__raw};}};};`, { __raw: raw, __method: METHOD });
  const done = env.runJob('FORECAST.RUN', { planId: id });
  assert.equal(done.status, 'DONE', done.error);
  const row = env.table('FORECAST_RUNS').find(r => r.run_id === done.result.runId), saved = JSON.parse(row.planning_json);
  assert.equal(saved.method, METHOD);
  assert.equal(saved.pointPolicySourceSha256, env.run('appPointPolicy_(__method).engineSourceSha256', { __method: METHOD }));
  assert.equal(saved.annualRawP50, 100);
  assert.equal(saved.annualTarget, 96);
  assert.deepEqual(saved.months.map(m => m.point), POINTS);
  assert.equal(Number(row.annual_p50), 100);
  assert.deepEqual(env.table('FORECAST_MONTHLY').filter(r => r.run_id === row.run_id).map(r => Number(r.p50)), W_POINTS);
}

// Exact provenance invalidates an overlay; unrelated settings/runs leave it available.
{
  const f = fixture(1); f.previewAll(); f.applyAll();
  const id = f.ids[0], original = latest(f), active = () => latest(f).pointRevision;
  for (const [key, value] of [['landing.tau', 0.2], ['landing.w', 2]]) f.env.task('saveSetting(__in)', { __in: { key, value } });
  assert.ok(active(), 'landing display controls do not invalidate numerical points');
  const otherSource = f.env.makeBook('別の合成売上元', { Sheet1: { values: [['constructed']] } });
  f.env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + otherSource.getId() + '/edit' } });
  assert.equal(active(), null, 'different source identity invalidates points');
  f.env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: f.sourceUrl } });
  assert.ok(active());
  const meta = f.env.call('appReadPlanTable_("ENG_SHEETS",__id).find(r=>r.sheet==="SALES_MONTHLY")', { __id: id });
  const segments = f.env.call('appReadPlanTable_("ENG_ROWS",__id).filter(r=>r.sheet==="SALES_MONTHLY").map(appStripRow_)', { __id: id });
  const changedHistory = f.books[0].getSheetByName('SALES_MONTHLY');
  changedHistory.getRange(2, 2).setValue(101);
  changedHistory.getRange(4, 2).setValue(101);
  f.env.run(`(() => {const enc=appEngEncodeSheet_(__id,appSheetSnapshot_(__sheet,0));
    appJournalRun_({actor:__actor},'constructed history edit',__id,[appOpReplacePlan_('ENG_ROWS',__id,['SALES_MONTHLY'],enc.rowSegs)]);appStoreForget_();})()`,
  { __id: id, __sheet: changedHistory, __actor: OWNER });
  assert.equal(active(), null, 'decoded numerical history changes invalidate even a stale metadata hash');
  f.env.run('appJournalRun_({actor:__actor},"constructed restore",__id,[appOpReplacePlan_("ENG_ROWS",__id,["SALES_MONTHLY"],__rows)]);appStoreForget_()', { __id: id, __rows: segments, __actor: OWNER });
  assert.ok(active());
  f.env.run('appPatchRow_("ENG_SHEETS",{plan_id:__id,sheet:"SALES_MONTHLY"},{content_hash:"changed-history"},"constructed");appStoreForget_()', { __id: id });
  assert.equal(active(), null);
  f.env.run('appReplaceWhole_("ENG_ROWS",appReadTable_("ENG_ROWS").filter(r=>!(r.plan_id===__id&&r.sheet==="SALES_MONTHLY")).map(appStripRow_).concat(__rows));appPatchRow_("ENG_SHEETS",{plan_id:__id,sheet:"SALES_MONTHLY"},{content_hash:__hash},"constructed");appStoreForget_()', { __id: id, __rows: segments, __hash: meta.content_hash });
  assert.ok(active());
  f.env.run('appEnsureRows_("FORECAST_RUNS",[Object.assign({},appReadTable_("FORECAST_RUNS").find(r=>r.plan_id===__id),{run_id:"CONSTRUCTED-OTHER-NEW-RUN",finished_at:"2026-04-07T00:00:00Z"})]);appStoreForget_()', { __id: f.normalId });
  assert.ok(active(), 'another plan changing run does not invalidate this overlay');
  const cfg = f.env.call('appReadPlanTable_("ENG_SHEETS",__id).find(r=>r.sheet==="CONFIG")', { __id: id });
  f.env.run('appPatchRow_("ENG_SHEETS",{plan_id:__id,sheet:"CONFIG"},{content_hash:"changed-input"},"constructed");appStoreForget_()', { __id: id });
  assert.equal(active(), null, 'changed seed input invalidates points');
  f.env.run('appPatchRow_("ENG_SHEETS",{plan_id:__id,sheet:"CONFIG"},{content_hash:__hash},"constructed");appStoreForget_()', { __id: id, __hash: cfg.content_hash });
  assert.ok(active());
  f.env.run('appEnsureRows_("FORECAST_RUNS",[Object.assign({},appReadTable_("FORECAST_RUNS").find(r=>r.plan_id===__id),{run_id:"CONSTRUCTED-NEW-RUN",finished_at:"2026-04-07T00:00:00Z"})]);appStoreForget_()', { __id: id });
  assert.equal(active(), null, 'an old overlay cannot attach to a new MC run');
  assert.deepEqual(original.planning.months.map(m => m.point), POINTS);
}

// A foreign journal is never recovered by this operation; own exact intent can resume once.
{
  const f = fixture(1);
  assert.throws(() => f.env.call('appPointPreview_({actor:"other",user:{isOwner:false}},__in)', { __in: f.previewInput }), /所有者/);
  assert.throws(() => f.env.task('previewPointRevision(__in)', { __in: { ...f.previewInput, policySha256: '0'.repeat(64) } }), /方式が未承認|計算API/);
  assert.equal(f.env.run('__pointCalls'), 0);
  f.previewAll();
  const sheet = f.env.data().getSheetByName('PLAN_ACTIONS');
  sheet.failWrites = true;
  assert.throws(() => f.env.task('applyPointRevision(__in)', { __in: f.applyInput }), /write failed/);
  sheet.failWrites = false;
  const pending = f.env.call('appJournalPending_()');
  assert.ok(pending);
  assert.equal(state(f).entries[0].status, 'PREVIEWED', 'durable intent survives interrupted write');
  f.env.run('appProps_().setProperty(APP_JOURNAL_PROP,JSON.stringify(Object.assign({},__pending,{label:"foreign-journal"})))', { __pending: pending });
  assert.throws(() => f.env.task('applyPointRevision(__in)', { __in: f.applyInput }), /別の保存/);
  assert.equal(f.env.table('PLAN_ACTIONS').length, 0);
  assert.equal(f.env.call('appJournalPending_()').label, 'foreign-journal');
  f.env.run('appProps_().setProperty(APP_JOURNAL_PROP,JSON.stringify(__pending))', { __pending: pending });
  f.applyAll();
  assert.equal(f.env.call('appJournalPending_()'), null);
  assert.equal(f.env.table('PLAN_ACTIONS').filter(a => a.action === 'FORECAST.POINT_REFRESH').length, 1);
  assert.ok(latest(f).pointRevision);
  assert.equal(f.env.run('__pointCalls'), 1);
}

// The registered successor uses the saved BB as an immutable predecessor, not as a new raw run.
const EE_METHOD = 'EE_PREQUENTIAL_AMOUNT_POLICY_BB';
function enableEEFixture(f) {
  f.eePolicy = f.env.call(`(() => {const p=appPointPolicy_(__method);return {policySha256:p.policySha256,engineSourceSha256:p.engineSourceSha256};})()`, { __method: EE_METHOD });
  f.env.run(`
    var __eeCalls=0,__eeBadHalf=false,__eeBadYear=false;
    appPointEngine_=function(){const p=appPointPolicy_(__ee);return {
      VERSION:'constructed-ee-engine',SOURCE_SHA256:p.engineSourceSha256,WEB_SOURCE_SHA256:'c'.repeat(64),
      appHistoryPrequentialAmountForecast_:function(history,fy){
        __eeCalls++;
        if(history.length!==48||history[0].ym!=='2022-04'||history[47].ym!=='2026-03')throw Error('Wrong EE prefix');
        const net=history.slice(-12).reduce((s,r)=>s+r.base,0)+history.slice(-12).reduce((s,r)=>s+r.spot,0);
        const points=Array.from({length:12},(_,m)=>__eeBadYear||__eeBadHalf&&m<6?0:6);
        return {method:__ee,points:points,total:points.reduce((s,v)=>s+v,0),active:true,net12:net,
          profileYears:[fy-3,fy-2,fy-1],halfTargets:[points.slice(0,6).reduce((s,v)=>s+v,0),points.slice(6).reduce((s,v)=>s+v,0)],
          mode:'prequential_amount_selection',rescue:'none',weights:Array(12).fill(.75),selectedFoldFYs:[2024,2025],
          completeBB:{method:__bb,points:Array(12).fill(8),baseWPoints:Array(12).fill(10),total:96}};
      }};};`, { __ee: EE_METHOD, __bb: METHOD });
}
function previewEEFixture(f) {
  const input = { fy: FY, method: EE_METHOD, policySha256: f.eePolicy.policySha256 };
  let r = f.env.task('previewPointRevision(__in)', { __in: input });
  while (r.status === 'PREVIEW') r = f.env.task('previewPointRevision(__in)', { __in: { ...input, publicationId: r.publicationId } });
  assert.equal(r.status, 'READY');
  f.preview = r;
  f.applyInput = { publicationId: r.publicationId, method: EE_METHOD, policySha256: f.eePolicy.policySha256, previewSha256: r.previewSha256 };
  return r;
}
function eeFixture(measures = 1) {
  const f = fixture(measures);
  f.env.run("appNowIso_=function(){return '2026-10-18T00:00:00+0900';};");
  f.previewAll(); f.applyAll(); enableEEFixture(f);
  return f;
}

{
  const f = eeFixture(2), before = allTables(f), preceding = latest(f);
  assert.equal(preceding.planning.method, METHOD, 'old-source BB remains readable under the new generator');
  assert.notEqual(f.policy.engineSourceSha256, f.eePolicy.engineSourceSha256);
  previewEEFixture(f);
  assert.deepEqual(allTables(f), before);
  assert.ok(state(f).entries.every(e => e.predecessor.method === METHOD && e.predecessor.policySourceSha256 === f.policy.engineSourceSha256));
  f.applyAll();
  const after = allTables(f), d = latest(f);
  assert.equal(after.PLAN_ACTIONS.length - before.PLAN_ACTIONS.length, 2);
  assert.deepEqual(after.PLAN_ACTIONS.slice(0, before.PLAN_ACTIONS.length), before.PLAN_ACTIONS, 'original BB rows remain exact');
  for (const name of Object.keys(before)) if (name !== 'PLAN_ACTIONS') assert.deepEqual(after[name], before[name], name + ' remains exact after EE');
  assert.equal(d.planning.method, EE_METHOD, 'same-second successor beats its parent without self-invalidating');
  assert.deepEqual(d.planning.months.map(m => m.point), Array(12).fill(6));
  assert.equal(d.planning.annualTarget, 72);
  assert.equal(d.rawPlanning.annualTarget, 120);
  assert.equal(d.latest.annual_p50, 100);
  assert.equal(d.latest.finished_at, '2026-04-06T00:00:01Z');
  assert.deepEqual(d.monthly.map(m => m.p50), W_POINTS);
  assert.deepEqual(d.planning.months.map(m => m.mean), preceding.planning.months.map(m => m.mean));
  assert.equal(d.pointRevision.predecessorRevisionId, preceding.pointRevision.revisionId);
  const entry = state(f).entries[0];
  const proof = f.env.call('appOfflineReadFile_(__ref.fileId,__ref.sha256)', { __ref: entry.proofFileRef });
  assert.deepEqual(proof.precedingPlanning, preceding.planning);
  assert.deepEqual(proof.fullq.completeBB.points, POINTS);
  const row = after.PLAN_ACTIONS.find(a => a.action_id === d.pointRevision.revisionId), payload = JSON.parse(row.result_json);
  assert.equal(payload.version, 'FORECAST_POINT_REVISION_V2');
  assert.equal(payload.predecessor.revisionId, preceding.pointRevision.revisionId);
  assert.equal(payload.baseRunId, d.latest.run_id);
  assert.equal(latest(f, f.normalId).pointRevision, null);
  assert.equal(f.env.call('appPortfolioData_().plans.find(p=>p.planId===__id).forecastPointAnnual', { __id: f.ids[0] }), 72);
  assert.equal(f.env.call('appProvisionalReadiness_(appPlanOf_(__id),appProvisionalSnapshot_()).method', { __id: f.ids[0] }), EE_METHOD);
  assert.equal(f.env.task('applyPointRevision(__in)', { __in: f.applyInput }).appliedThisCall, 0);
  assert.deepEqual(allTables(f), after);
  assert.equal(f.env.run('__eeCalls'), 2, 'readers and replay do not recalculate the policy');
  assert.throws(() => previewEEFixture(f), /直前/);

  // Native metadata has twelve nonnegative lambdas, not probabilities or BB's empty array.
  const parse = p => f.env.call('appForecastPlanningOf_(__raw,2026,100)', { __raw: p });
  const native = J(d.planning);
  delete native.pointPolicySha256;
  delete native.pointPolicySourceSha256;
  assert.deepEqual(f.env.call('appPointNativePlanning_(__raw,{sourceSha256:__sha},2026,100)', { __raw: native, __sha: f.eePolicy.engineSourceSha256 }), d.planning);
  assert.equal(f.env.call('appPointNativePlanning_(__raw,{sourceSha256:__sha},2026,100)', { __raw: native, __sha: f.policy.engineSourceSha256 }), null);
  const lambdas = J(d.planning); lambdas.provisionalWeights[0] = 0; lambdas.provisionalWeights[1] = 2;
  assert.ok(parse(lambdas), 'finite lambda can be zero or greater than one');
  const fallback = J(d.planning);
  fallback.provisionalWeights = Array(12).fill(1); fallback.provisionalFolds = []; fallback.provisionalMode = 'complete_BB';
  fallback.months.forEach(m => { m.point = 8; m.share = 1 / 12; }); fallback.annualTarget = 96; fallback.halfTargets = [48, 48];
  assert.ok(parse(fallback), 'structural/numeric completed-BB fallback is valid with unit weights');
  const invalid = [
    p => p.provisionalWeights = Array(11).fill(1), p => p.provisionalWeights = Array(13).fill(1),
    p => p.provisionalWeights[0] = NaN, p => p.provisionalWeights[0] = Infinity,
    p => p.provisionalWeights[0] = -0.1, p => p.provisionalWeights[0] = '1',
    p => p.provisionalFolds = [2024], p => p.provisionalFolds = [2025, 2024],
    p => p.provisionalFolds = [2024, 2024], p => p.provisionalFolds = [2024, 2026],
    p => p.provisionalFolds = [2023, 2025], p => p.provisionalFolds = [],
    p => p.provisionalMode = 'unregistered_mode', p => delete p.provisional,
    p => p.pointPolicySourceSha256 = f.policy.engineSourceSha256,
    p => p.pointPolicySha256 = '0'.repeat(64),
  ];
  for (const mutate of invalid) { const p = J(d.planning); mutate(p); assert.equal(parse(p), null); }
  const badFallback = J(fallback); badFallback.provisionalWeights[0] = .5;
  assert.equal(parse(badFallback), null, 'no-fold fallback cannot claim fitted multipliers');
}

// A successor cannot start without its saved predecessor, and cannot retain a missing parent reference.
{
  const f = fixture(1); enableEEFixture(f); const before = allTables(f);
  assert.throws(() => previewEEFixture(f), /直前/);
  assert.equal(f.env.run('__eeCalls'), 0);
  assert.deepEqual(allTables(f), before);
}
{
  const f = eeFixture(); previewEEFixture(f); f.applyAll();
  f.env.run(`(() => {const r=appReadTable_('PLAN_ACTIONS').find(r=>r.plan_id===__id&&JSON.parse(r.result_json).method===__ee),v=JSON.parse(r.result_json);
    delete v.predecessor;appPatchRow_('PLAN_ACTIONS',{action_id:r.action_id},{result_json:JSON.stringify(v)},'constructed');appStoreForget_();})()`, { __id: f.ids[0], __ee: EE_METHOD });
  assert.equal(latest(f).planning.method, METHOD, 'unbound child falls back to original BB');
}

// Parser-valid economic corruption is rejected by the resolver, without hiding the valid BB parent.
for (const allYear of [true, false]) {
  const f = eeFixture(); previewEEFixture(f); f.applyAll();
  const parsed = f.env.call(`(() => {const r=appReadTable_('PLAN_ACTIONS').find(r=>r.plan_id===__id&&JSON.parse(r.result_json).method===__ee),v=JSON.parse(r.result_json),p=v.planning;
    p.months.forEach((m,i)=>{if(__all||i<6)m.point=0;});p.annualTarget=p.months.reduce((s,m)=>s+m.point,0);
    p.halfTargets=[p.months.slice(0,6).reduce((s,m)=>s+m.point,0),p.months.slice(6).reduce((s,m)=>s+m.point,0)];p.months.forEach(m=>m.share=p.annualTarget?m.point/p.annualTarget:0);
    const parsed=!!appForecastPlanningOf_(p,2026,100);appPatchRow_('PLAN_ACTIONS',{action_id:r.action_id},{result_json:JSON.stringify(v)},'constructed');appStoreForget_();return parsed;})()`,
  { __id: f.ids[0], __ee: EE_METHOD, __all: allYear });
  assert.equal(parsed, true, 'the economic guard adds a context check beyond numeric parsing');
  assert.equal(latest(f).planning.method, METHOD);
  assert.deepEqual(latest(f).planning.months.map(m => m.point), POINTS);
}

// Neither a bad pure result nor an altered approved READY image may reach the journal.
for (const bad of ['__eeBadYear', '__eeBadHalf']) {
  const f = eeFixture(), before = allTables(f);
  f.env.run(bad + '=true;');
  assert.throws(() => previewEEFixture(f), /計算結果/);
  assert.deepEqual(allTables(f), before);
  assert.equal(f.env.call('appJournalPending_()'), null);
}
for (const tamper of ['parent', 'point']) {
  const f = eeFixture(); previewEEFixture(f); const before = allTables(f);
  f.env.run(`(() => {const s=appPointLoadState_({user:{isOwner:true},actor:__actor},__pub);
    if(__tamper==='parent')s.entries[0].predecessor.actionHash='0'.repeat(64);else s.entries[0].planning.months[0].point++;
    appPointSaveState_(s);})()`, { __actor: OWNER, __pub: f.preview.publicationId, __tamper: tamper });
  assert.throws(() => f.env.task('applyPointRevision(__in)', { __in: f.applyInput }), /方式・版/);
  assert.deepEqual(allTables(f), before);
  assert.equal(f.env.call('appJournalPending_()'), null, 'digest refusal happens before creating a journal');
}

// Recovery after an exact child row append must not require its BB parent to stay current-active.
{
  const f = eeFixture(); previewEEFixture(f);
  f.env.run(`var __eeJournalApply=appJournalApply_;appJournalApply_=function(ops){__eeJournalApply(ops);appStoreForget_();throw Error('constructed after-append interruption');};`);
  assert.throws(() => f.env.task('applyPointRevision(__in)', { __in: f.applyInput }), /after-append interruption/);
  assert.ok(f.env.call('appJournalPending_()'));
  assert.equal(latest(f).planning.method, EE_METHOD);
  const afterAppend = allTables(f);
  assert.throws(() => f.env.task('applyPointRevision(__in)', { __in: { ...f.applyInput, policySha256: '0'.repeat(64) } }), /方式・版/);
  assert.deepEqual(allTables(f), afterAppend);
  assert.ok(f.env.call('appJournalPending_()'));
  f.env.run('appJournalApply_=__eeJournalApply;');
  f.applyAll();
  assert.equal(f.env.call('appJournalPending_()'), null);
  assert.deepEqual(allTables(f), afterAppend, 'recovery acknowledges the exact existing row without appending another');
  assert.equal(latest(f).planning.method, EE_METHOD);
}

console.log('app-point-revisions: all tests passed');
