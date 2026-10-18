/**
 * Owner-only provisional all-maker workflow. Uses existing native jobs only.
 * Normal plans are never run or changed. New plans are MEASURE, with no people
 * or invented subjective/product/SPOT input. Existing MEASURE inputs are kept.
 * Root wires owner actions, terminal hook, cap and durable job marker fields.
 */
const APP_PROVISIONAL_HEAD_KEY = 'APP_PROVISIONAL_ALL_STATE';
const APP_PROVISIONAL_ITEM_PREFIX = 'APP_PROVISIONAL_ALL_ITEM_';
const APP_PROVISIONAL_VERSION = 'PROVISIONAL_ALLMAKERS_V1';
const APP_PROVISIONAL_PHASES = ['CREATE', 'IMPORT', 'AGGREGATE', 'FORECAST'];

function appProvisionalRequireOwner_(ctx) {
  const user = ctx && ctx.user ? ctx.user : appCurrentUser_();
  if (!user || user.isOwner !== true) throw new Error('暫定の全メーカー処理は、所有者だけが操作できます。');
  return ctx || { user: user, actor: user.email, roles: appRolesOf_(user) };
}
function appProvisionalReadJson_(key) {
  const raw = appProps_().getProperty(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { throw new Error('暫定一括の状態を読み取れません: ' + key); }
}
function appProvisionalSaveJson_(key, value) {
  const raw = JSON.stringify(value);
  if (appUtf8Bytes_(raw) > 8000) throw new Error('暫定一括の状態が大きすぎます。');
  appProps_().setProperty(key, raw);
}
function appProvisionalState_() {
  const st = appProvisionalReadJson_(APP_PROVISIONAL_HEAD_KEY);
  if (!st) return null;
  if (st.version !== APP_PROVISIONAL_VERSION || !st.id || !Number.isInteger(st.count) || st.count < 0 || st.count > 1000) throw new Error('暫定一括の状態の形式が違います。');
  return st;
}
function appProvisionalItemKey_(st, index) { return APP_PROVISIONAL_ITEM_PREFIX + st.id + '_' + index; }
function appProvisionalItem_(st, index) {
  const item = appProvisionalReadJson_(appProvisionalItemKey_(st, index));
  if (!item || item.index !== index || !item.key || !item.clientName) throw new Error('暫定一括のメーカー状態がありません: ' + index);
  return item;
}
function appProvisionalItems_(st) { return Array.from({ length: st.count }, (_, i) => appProvisionalItem_(st, i)); }
function appProvisionalSaveItem_(st, item) { appProvisionalSaveJson_(appProvisionalItemKey_(st, item.index), item); }
function appProvisionalSaveState_(st) { st.updatedAt = new Date().toISOString(); appProvisionalSaveJson_(APP_PROVISIONAL_HEAD_KEY, st); }
/** Recheck the durable intent and current plan under each native write lock. */
function appProvisionalRequireWritable_(payload) {
  if (!payload || !payload.provisionalBatchId) return;
  const st = appProvisionalState_();
  if (!st || !st.active || st.id !== payload.provisionalBatchId || !Number.isInteger(payload.provisionalIndex)) throw new Error('暫定一括の実行状態が変わりました。');
  const item = appProvisionalItem_(st, payload.provisionalIndex);
  if (!st.current || st.current.index !== item.index || (st.current.intentId && st.current.intentId !== payload.provisionalIntentId)) throw new Error('暫定一括の実行番号が変わりました。');
  if (item.stage !== payload.provisionalStage) throw new Error('暫定一括の処理段階が変わりました。');
  if (!payload.planId) {
    if (payload.clientName !== item.clientName || payload.purpose !== APP_PLAN_MEASURE || Number(payload.fy) !== Number(st.fy)) throw new Error('暫定一括の作成対象が変わりました。');
    return;
  }
  if (String(payload.planId) !== String(item.planId)) throw new Error('暫定一括の計画が一致しません。');
  appStoreForget_('PLANS');
  appStoreForget_('YEAR_CLOSURES');
  const plan = appPlanOf_(payload.planId);
  if (!appPlanIsMeasure_(plan) || plan.state === 'ARCHIVED' || Number(plan.fy) !== Number(st.fy)) throw new Error('計画の状態が変わったため、暫定一括を停止しました。');
  appRequireOpenPlan_(plan.plan_id);
}
function appProvisionalFy_(input) {
  const fy = Number(input && input.fy);
  if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) throw new Error('fy は年度を4桁の数で入れてください。');
  return fy;
}
function appProvisionalBoolean_(input, key) {
  if (input && input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(key + ' は true か false で入れてください。');
}
function appProvisionalSnapshot_() {
  return { plans: appReadTable_('PLANS'), clients: appReadTable_('CLIENTS'),
    runs: appReadTable_('FORECAST_RUNS'), monthly: appReadTable_('FORECAST_MONTHLY'), actions: appReadTable_('PLAN_ACTIONS') };
}
function appProvisionalPlanKey_(plan, snap) {
  const client = snap.clients.filter(c => c.client_id === plan.client_id)[0];
  return appNormalizeName_(client && client.client_name ? client.client_name : plan.client_label);
}
function appProvisionalFindPlans_(key, fy, snap) {
  return snap.plans.filter(p => String(p.fy) === String(fy) && appProvisionalPlanKey_(p, snap) === key);
}
function appProvisionalLatest_(rows, timeKey, idKey) {
  return rows.slice().sort((a, b) => String(b[timeKey] || '').localeCompare(String(a[timeKey] || '')) || String(b[idKey] || '').localeCompare(String(a[idKey] || '')))[0] || null;
}
function appProvisionalReadiness_(plan, snap) {
  if (!plan) return { forecastReady: false, planningReady: false, runId: '', method: '', reason: '計画がまだありません。' };
  const run = appProvisionalLatest_(snap.runs.filter(r => r.plan_id === plan.plan_id && r.status === 'DONE'), 'finished_at', 'run_id');
  if (!run) return { forecastReady: false, planningReady: false, runId: '', method: '', reason: '完了した予測がありません。' };
  const months = snap.monthly.filter(r => r.plan_id === plan.plan_id && r.run_id === run.run_id), expected = Array.from({ length: 12 }, (_, i) => {
    const m = 4 + i; return (m > 12 ? Number(plan.fy) + 1 : Number(plan.fy)) + '/' + ('0' + (m > 12 ? m - 12 : m)).slice(-2);
  });
  const annualReady = ['annual_p10', 'annual_p50', 'annual_p90'].every(k => typeof run[k] === 'number' && isFinite(run[k]) && run[k] >= 0) &&
    run.annual_p10 <= run.annual_p50 && run.annual_p50 <= run.annual_p90;
  const forecastReady = annualReady && months.length === 12 && expected.every(ym => months.filter(m => String(m.ym) === ym &&
    ['p10', 'p50', 'p90'].every(k => typeof m[k] === 'number' && isFinite(m[k]) && m[k] >= 0) && m.p10 <= m.p50 && m.p50 <= m.p90).length === 1);
  const planning = appForecastPlanningOf_(run.planning_json, plan.fy, run.annual_p50);
  return { forecastReady: forecastReady, planningReady: !!planning, runId: String(run.run_id), method: planning ? planning.method : 'LEGACY_MONTHLY_P50',
    appVersion: String(run.app_version || ''), engineVersion: String(run.engine_version || ''), finishedAt: String(run.finished_at || ''),
    annualRiskReady: annualReady,
    reason: !forecastReady ? '年度と12か月の予測帯がそろっていないか、数値・順序を確認できません。' : !planning ? '月別の計画値の控えがありません（従来の中央値を表示）。' : '',
    planId: plan.plan_id, measure: appPlanIsMeasure_(plan), frozen: appYearIsFrozen_(plan.fy) };
}
function appProvisionalRoster_(candidates, fy, snap) {
  const by = {};
  const add = (name, source) => {
    const raw = String(name || '').trim(), key = appNormalizeName_(raw);
    if (!raw || !key || raw.length > 100) throw new Error('メーカー候補の名前を確認してください。');
    if (!by[key]) by[key] = { key: key, clientName: raw, sources: [], aliases: [] };
    if (by[key].sources.indexOf(source) < 0) by[key].sources.push(source);
    if (by[key].aliases.indexOf(raw) < 0) by[key].aliases.push(raw);
  };
  (candidates || []).forEach(c => add(typeof c === 'string' ? c : c.zac, 'ZAC_LAST2_FY'));
  snap.plans.filter(p => String(p.fy) === String(fy) && p.state !== 'ARCHIVED').forEach(p => add(p.client_label, 'EXISTING_FY_PLAN'));
  return Object.keys(by).map(k => by[k]).sort((a, b) => a.clientName.localeCompare(b.clientName) || a.key.localeCompare(b.key));
}
function appProvisionalBusy_() {
  return appJobList_().filter(j => j.status === 'QUEUED' || j.status === 'RUNNING' && !appJobIsStale_(j));
}
function appProvisionalRequireNoBulk_() {
  if (typeof appBulkState_ === 'function' && appBulkState_().active) throw new Error('既存のまとめて実行が終わってから、暫定の全メーカー処理を始めてください。');
}
function appProvisionalRequireCapacity_(roster, fy, snap) {
  const missing = roster.filter(r => !appProvisionalFindPlans_(r.key, fy, snap).length && !appYearIsFrozen_(fy)).length;
  if (appMeasureCount_(snap.plans, '') + missing > APP_MEASURE_PLAN_MAX) throw new Error('全メーカーの暫定計画を作るには、測る専用の上限が足りません。必要数を確認してください。');
}
function appProvisionalClassify_(st, item, snap) {
  const all = appProvisionalFindPlans_(item.key, st.fy, snap), active = all.filter(p => p.state !== 'ARCHIVED');
  if (active.length > 1) { item.status = 'FAILED'; item.error = '同じメーカー・年度の計画が複数あります。'; return; }
  const plan = active[0] || all[0] || null;
  if (plan) item.planId = plan.plan_id;
  // Normal plans are a strict read-only boundary, even if their forecast is missing.
  if (plan && !appPlanIsMeasure_(plan)) {
    item.status = 'PRESERVED_NORMAL'; item.stage = ''; item.error = ''; item.readiness = appProvisionalReadiness_(plan, snap);
    if (!item.readiness.forecastReady) item.error = '通常計画を保全しましたが、完了した月別予測がありません。';
    return;
  }
  if (plan && plan.state === 'ARCHIVED') { item.status = 'SKIPPED_ARCHIVED'; item.stage = ''; item.error = '保管をやめた計画は変更しません。'; return; }
  if (appYearIsFrozen_(st.fy)) { item.status = 'SKIPPED_CLOSED'; item.stage = ''; item.error = '年度が締まっているため変更しません。'; return; }
  if (!item.stage) item.stage = plan ? 'IMPORT' : 'CREATE';
  if (!plan && item.stage !== 'CREATE') { item.status = 'FAILED'; item.error = '処理途中の計画が見つかりません。'; return; }
  item.status = 'PENDING'; item.error = '';
}
function appProvisionalStageRequest_(st, item) {
  if (item.stage === 'CREATE') return { kind: 'PLAN.CREATE', payload: { clientName: item.clientName, fy: st.fy, peopleCsv: '', purpose: APP_PLAN_MEASURE } };
  if (item.stage === 'IMPORT' || item.stage === 'AGGREGATE') return { kind: 'PLAN.RUN', payload: { planId: item.planId,
    action: item.stage === 'IMPORT' ? 'IMPORT.SALES' : 'SALES.AGGREGATE', args: {}, inputHash: appPlanInputHash_(item.planId) } };
  if (item.stage === 'FORECAST') return { kind: 'FORECAST.RUN', payload: { planId: item.planId } };
  throw new Error('暫定処理の段が違います。');
}
function appProvisionalBeforeReceipt_(st, item, snap) {
  const before = { runId: '', actionId: '' };
  if (item.stage === 'FORECAST') { const r = appProvisionalLatest_(snap.runs.filter(r => r.plan_id === item.planId && r.status === 'DONE'), 'finished_at', 'run_id'); before.runId = r ? r.run_id : ''; }
  if (item.stage === 'IMPORT' || item.stage === 'AGGREGATE') {
    const action = item.stage === 'IMPORT' ? 'IMPORT.SALES' : 'SALES.AGGREGATE';
    const a = appProvisionalLatest_(snap.actions.filter(r => r.plan_id === item.planId && r.action === action && r.status === 'DONE'), 'finished_at', 'action_id'); before.actionId = a ? a.action_id : '';
  }
  return before;
}
/** Caller holds the script lock; never nests appStartJob_'s lock. */
function appProvisionalEnqueue_(ctx, st, item, snap) {
  appProvisionalRequireOwner_(ctx); appProvisionalRequireNoBulk_();
  if (!appIsSetUp_()) throw new Error('初期設定がまだです。');
  if (appJournalPending_()) throw new Error('データ本体の保存が途中です。保存の続きを先に完了してください。');
  if (appProvisionalBusy_().length) return false;
  const req = appProvisionalStageRequest_(st, item), opts = appJobStartOpts_(req);
  if (!appHasRole_(ctx.roles || [], opts.minRole, opts.clientId)) throw new Error('この処理を始める役割がありません。');
  if (opts.ownerOnly && !ctx.user.isOwner) throw new Error('所有者だけが実行できます。');
  if (req.kind === 'PLAN.CREATE') { appPlanCreateCheck_(req.payload); appMeasureRequireOwner_(ctx, APP_PLAN_MEASURE); }
  else appRequireOpenPlan_(item.planId);
  if (req.kind === 'PLAN.RUN') {
    const paused = appPlanActionPaused_(req.payload.action) || appMeasureJobRefusal_(req.kind, req.payload);
    if (paused) throw new Error(paused);
  }
  const refusal = appV10WaitRefusal_(req.kind, req.payload); if (refusal) throw new Error(refusal);
  const startedAt = new Date().toISOString(), intent = { intentId: appId_('PVI'), index: item.index, stage: item.stage, rootJobId: '', startedAt: startedAt,
    kind: req.kind, action: req.payload.action || '', before: appProvisionalBeforeReceipt_(st, item, snap) };
  item.status = 'RUNNING'; item.attempts = Number(item.attempts || 0) + 1; item.lastStartedAt = startedAt;
  st.current = intent; st.active = true; st.waiting = ''; appProvisionalSaveItem_(st, item); appProvisionalSaveState_(st);
  const payload = Object.assign({}, req.payload, { provisionalBatchId: st.id, provisionalIndex: item.index, provisionalStage: item.stage, provisionalIntentId: intent.intentId });
  const job = appEnqueueJob_(req.kind, payload, st.requestedBy, '');
  st.current.rootJobId = job.id; item.lastRootJobId = job.id; appProvisionalSaveItem_(st, item); appProvisionalSaveState_(st);
  return true;
}
function appProvisionalContext_(st) {
  const ctx = appJobContext_({ requestedBy: st.requestedBy });
  appProvisionalRequireOwner_(ctx); return ctx;
}
function appProvisionalAdvance_(st, ctx) {
  const max = st.count * 2 + 2;
  for (let i = 0; i < max; i++) {
    const snap = appProvisionalSnapshot_();
    // Refresh existing plans before spending time setting up additional makers.
    const existing = item => appProvisionalFindPlans_(item.key, st.fy, snap).length ? 1 : 0;
    const pending = appProvisionalItems_(st).filter(x => x.status === 'PENDING')
      .sort((a, b) => existing(b) - existing(a) || a.index - b.index)[0];
    if (!pending) { st.active = false; st.current = null; st.waiting = ''; st.finishedAt = new Date().toISOString(); appProvisionalSaveState_(st); return; }
    appProvisionalClassify_(st, pending, snap); appProvisionalSaveItem_(st, pending);
    if (pending.status !== 'PENDING') continue;
    try {
      if (!appProvisionalEnqueue_(ctx, st, pending, snap)) { st.active = true; st.current = null; st.waiting = 'OTHER_JOB'; appProvisionalSaveState_(st); }
      return;
    } catch (e) {
      // An intent may already have a scheduled root job. Never discard that job.
      const scheduled = st.current && st.current.index === pending.index && st.current.rootJobId;
      if (scheduled) { st.waiting = 'STATE_SAVE_AFTER_ENQUEUE'; appProvisionalSaveState_(st); return; }
      pending.status = 'FAILED'; pending.error = String(e && e.message || e).slice(0, 240); st.current = null;
      appProvisionalSaveItem_(st, pending); appProvisionalSaveState_(st);
    }
  }
  throw new Error('暫定一括の進み方を確認してください。');
}
function appProvisionalAfterTime_(at, start) {
  const time = Date.parse(at || ''), minimum = Date.parse(start || '');
  return Number.isFinite(time) && Number.isFinite(minimum) && time >= Math.floor(minimum / 1000) * 1000;
}
/** Durable receipts are required when the six-hour result cache is missing. */
function appProvisionalReceipt_(st, item, cur, snap, result) {
  if (item.stage === 'CREATE') {
    const plans = appProvisionalFindPlans_(item.key, st.fy, snap).filter(p => p.state !== 'ARCHIVED');
    if (plans.length !== 1 || !appPlanIsMeasure_(plans[0])) return null;
    if (result && result.planId && result.planId !== plans[0].plan_id) return null;
    return { planId: plans[0].plan_id, kind: 'PLAN_CREATED' };
  }
  if (item.stage === 'IMPORT' || item.stage === 'AGGREGATE') {
    const action = item.stage === 'IMPORT' ? 'IMPORT.SALES' : 'SALES.AGGREGATE';
    const rows = snap.actions.filter(r => r.plan_id === item.planId && r.action === action && r.status === 'DONE' && r.action_id !== cur.before.actionId &&
      appProvisionalAfterTime_(r.finished_at, cur.startedAt) && (!r.actor_email || r.actor_email === st.requestedBy) && (!result || !result.actionId || r.action_id === result.actionId));
    const saved = appProvisionalLatest_(rows, 'finished_at', 'action_id'); return saved ? { kind: 'ACTION_SAVED', actionId: saved.action_id } : null;
  }
  const rows = snap.runs.filter(r => r.plan_id === item.planId && r.status === 'DONE' && r.run_id !== cur.before.runId &&
    appProvisionalAfterTime_(r.finished_at, cur.startedAt) && (!r.actor_email || r.actor_email === st.requestedBy) && (!result || !result.runId || r.run_id === result.runId));
  const saved = appProvisionalLatest_(rows, 'finished_at', 'run_id');
  if (!saved) return null;
  const plan = snap.plans.filter(p => p.plan_id === item.planId)[0], readiness = appProvisionalReadiness_(plan, Object.assign({}, snap, { runs: [saved] }));
  return { kind: 'FORECAST_SAVED', runId: saved.run_id, readiness: readiness };
}
function appProvisionalApplyTerminal_(st, job, status) {
  const cur = st.current, item = appProvisionalItem_(st, cur.index), snap = appProvisionalSnapshot_();
  let found = null;
  if (job) { try { const cached = appJobGetResult_(job.id); found = cached && cached.found ? cached.value : null; } catch (e) { found = null; } }
  const terminalKind = { CREATE: 'PLAN.CREATE_SAVE', IMPORT: 'PLAN.RUN_SAVE', AGGREGATE: 'PLAN.RUN_SAVE', FORECAST: 'FORECAST.RUN_SAVE' }[item.stage];
  const action = item.stage === 'IMPORT' ? 'IMPORT.SALES' : item.stage === 'AGGREGATE' ? 'SALES.AGGREGATE' : '';
  if (status === 'FAILED') { item.status = 'FAILED'; item.error = String(job && job.error || '処理が失敗しました。').slice(0, 240); }
  else if (found && found.needConfirm) { item.status = 'CONFIRM'; item.error = String(found.needConfirm.message || '予測前の確認が必要です。').slice(0, 240); }
  else {
    const receipt = appProvisionalReceipt_(st, item, cur, snap, found);
    if (job && (job.kind !== terminalKind || action && (!job.payload || job.payload.action !== action))) {
      item.status = 'CONFIRM'; item.error = '保存段までの完了を確認できません。画面で確認してから再開してください。';
    } else if (!receipt) { item.status = 'UNREADY'; item.error = '保存済みの完了記録を確認できません。成功には数えていません。'; }
    else {
      item.completed = item.completed || {}; item.completed[item.stage] = Object.assign({ at: new Date().toISOString() }, receipt);
      if (receipt.planId) item.planId = receipt.planId;
      if (item.stage === 'FORECAST') {
        item.readiness = receipt.readiness;
        item.status = receipt.readiness.forecastReady && receipt.readiness.planningReady ? 'DONE' : 'UNREADY';
        item.error = item.status === 'DONE' ? '' : receipt.readiness.reason;
      } else { item.stage = APP_PROVISIONAL_PHASES[APP_PROVISIONAL_PHASES.indexOf(item.stage) + 1]; item.status = 'PENDING'; item.error = ''; }
    }
  }
  item.lastFinishedAt = new Date().toISOString(); item.lastRootJobId = cur.rootJobId || item.lastRootJobId || '';
  item.lastIntent = cur; st.current = null; appProvisionalSaveItem_(st, item); appProvisionalSaveState_(st);
}
function appProvisionalRootId_(job) {
  let current = job;
  for (let i = 0; i < 32 && current && current.parentId; i++) current = appJobGet_(current.parentId);
  return current ? current.id : '';
}
function appProvisionalChain_(rootId) {
  let job = rootId ? appJobGet_(rootId) : null;
  const seen = {};
  for (let i = 0; i < 32 && job && job.nextJobId; i++) {
    if (seen[job.id]) return { job: null, reason: 'JOB_CHAIN_CYCLE' };
    seen[job.id] = true; const next = appJobGet_(job.nextJobId);
    if (!next) return { job: null, reason: 'MISSING_CONTINUATION' }; job = next;
  }
  return { job: job, reason: job ? '' : 'MISSING_ROOT_JOB' };
}
function appProvisionalRecoverIntent_(st) {
  if (!st.current || st.current.rootJobId) return;
  const c = st.current, candidates = appJobList_().filter(j => !j.parentId && j.requestedBy === st.requestedBy && j.kind === c.kind &&
    j.payload && j.payload.provisionalBatchId === st.id && Number(j.payload.provisionalIndex) === c.index && j.payload.provisionalStage === c.stage && (!c.intentId || j.payload.provisionalIntentId === c.intentId));
  if (candidates.length === 1) { c.rootJobId = candidates[0].id; appProvisionalSaveState_(st); }
  else if (candidates.length > 1) throw new Error('再開する処理が複数あります。状態を確認してください。');
}
/** Owner action. Refresh only extends the same-version roster; it never reruns completed items. */
function appProvisionalStart_(ctx, input) {
  ctx = appProvisionalRequireOwner_(ctx); const fy = appProvisionalFy_(input); appProvisionalBoolean_(input, 'refresh');
  appProvisionalRequireNoBulk_();
  const candidates = appPlanCandidates_(ctx, { refresh: !!(input && input.refresh) });
  appWithLock_(() => {
    appCleanupJobs_(); appExpireQueuedJobs_(); appProvisionalRequireNoBulk_();
    const previous = appProvisionalState_(), snap = appProvisionalSnapshot_(), roster = appProvisionalRoster_(candidates.candidates, fy, snap), version = typeof APP_VERSION === 'undefined' ? '' : APP_VERSION;
    if (!roster.length) throw new Error('メーカー候補がありません。');
    if (previous && previous.active && previous.fy !== fy) throw new Error('別年度の暫定一括が進行中です。');
    if (previous && previous.fy === fy && previous.appVersion === version) {
      if (input && input.refresh) {
        const have = appProvisionalItems_(previous).map(x => x.key), added = roster.filter(r => have.indexOf(r.key) < 0);
        appProvisionalRequireCapacity_(added, fy, snap);
        added.forEach(r => { const item = Object.assign({}, r, { index: previous.count++, planId: '', stage: '', status: 'PENDING', attempts: 0, completed: {} }); appProvisionalSaveItem_(previous, item); });
        previous.sourceCandidateCount = candidates.candidates.length;
        if (added.length) { previous.active = true; previous.finishedAt = ''; appProvisionalSaveState_(previous); if (!previous.current) appProvisionalAdvance_(previous, ctx); }
      }
      return;
    }
    if (previous && previous.active) throw new Error('暫定一括が進行中です。状態を確認して再開してください。');
    if (appProvisionalBusy_().length) throw new Error('ほかの処理が終わってから始めてください。');
    appProvisionalRequireCapacity_(roster, fy, snap);
    const st = { version: APP_PROVISIONAL_VERSION, id: appId_('PRV'), fy: fy, appVersion: version, count: roster.length, sourceCandidateCount: candidates.candidates.length,
      active: true, current: null, waiting: '', requestedBy: ctx.actor, startedAt: new Date().toISOString(), finishedAt: '',
      rosterSource: 'ZAC_LAST2_FY_UNION_EXISTING_FY_PLANS', sourceCutoff: fy + '/03', backtest: false, noNormalPlanWrites: true };
    roster.forEach((r, index) => appProvisionalSaveItem_(st, Object.assign({}, r, { index: index, planId: '', stage: '', status: 'PENDING', attempts: 0, completed: {} })));
    appProvisionalSaveState_(st); appProvisionalAdvance_(st, ctx);
  });
  return appProvisionalStatus_(ctx);
}
/** Owner-only read; never advances jobs or treats an old cached result as success. */
function appProvisionalStatus_(ctx) {
  appProvisionalRequireOwner_(ctx); const st = appProvisionalState_();
  if (!st) return { active: false, exists: false, note: '暫定の全メーカー処理はまだありません。', items: [] };
  const snap = appProvisionalSnapshot_(), items = appProvisionalItems_(st).map(item => {
    const plan = snap.plans.filter(p => p.plan_id === item.planId)[0] || null;
    return Object.assign({}, item, { readiness: appProvisionalReadiness_(plan, snap) });
  });
  const counts = {}; items.forEach(i => { counts[i.status] = (counts[i.status] || 0) + 1; });
  const leaf = st.current && st.current.rootJobId ? appProvisionalChain_(st.current.rootJobId).job : null;
  const currentJob = leaf ? { jobId: leaf.id, kind: leaf.kind, status: leaf.status, createdAt: leaf.createdAt, startedAt: leaf.startedAt, finishedAt: leaf.finishedAt, error: leaf.error || '' } : null;
  return { exists: true, id: st.id, version: st.version, fy: st.fy, active: !!st.active, current: st.current, currentJob: currentJob, waiting: st.waiting || '',
    startedAt: st.startedAt, finishedAt: st.finishedAt || '', count: st.count, sourceCandidateCount: st.sourceCandidateCount, counts: counts,
    forecastReady: items.filter(i => i.readiness.forecastReady).length, planningReady: items.filter(i => i.readiness.planningReady).length,
    allForecastReady: items.every(i => i.readiness.forecastReady), allMeasurePlanningReady: items.filter(i => i.status !== 'PRESERVED_NORMAL').every(i => i.readiness.planningReady),
    sourceCutoff: st.sourceCutoff, noNormalPlanWrites: true, backtest: false, items: items };
}
/** Owner action after a PC/trigger interruption. Explicit retry never confirms an alert. */
function appProvisionalResume_(ctx, input) {
  ctx = appProvisionalRequireOwner_(ctx); appProvisionalBoolean_(input, 'retryFailed'); appProvisionalRequireNoBulk_();
  appWithLock_(() => {
    appCleanupJobs_(); appExpireQueuedJobs_(); appProvisionalRequireNoBulk_();
    const st = appProvisionalState_(); if (!st) throw new Error('再開する暫定一括がありません。');
    if (st.requestedBy !== ctx.actor) throw new Error('始めた所有者として再開してください。');
    appProvisionalRecoverIntent_(st);
    if (st.current) {
      const chain = appProvisionalChain_(st.current.rootJobId), job = chain.job;
      if (job && (job.status === 'QUEUED' || job.status === 'RUNNING' && !appJobIsStale_(job))) return;
      if (job && (job.status === 'DONE' || job.status === 'FAILED')) appProvisionalApplyTerminal_(st, job, job.status);
      else {
        const item = appProvisionalItem_(st, st.current.index), saved = appProvisionalReceipt_(st, item, st.current, appProvisionalSnapshot_(), null);
        if (saved) appProvisionalApplyTerminal_(st, null, 'DONE');
        else { item.status = 'UNREADY'; item.error = chain.reason || '処理が止まっています。再試行が必要です。'; item.lastIntent = st.current; st.current = null; appProvisionalSaveItem_(st, item); appProvisionalSaveState_(st); }
      }
    }
    if (appProvisionalBusy_().length) throw new Error('ほかの処理が終わってから再開してください。');
    if (input && input.retryFailed) {
      const snap = appProvisionalSnapshot_();
      appProvisionalItems_(st).filter(i => ['FAILED', 'UNREADY'].indexOf(i.status) >= 0).forEach(item => {
        const plans = appProvisionalFindPlans_(item.key, st.fy, snap).filter(p => p.state !== 'ARCHIVED');
        if (item.stage === 'CREATE' && plans.length === 1 && appPlanIsMeasure_(plans[0])) { item.planId = plans[0].plan_id; item.stage = 'IMPORT'; }
        item.status = 'PENDING'; item.error = ''; appProvisionalSaveItem_(st, item);
      });
    }
    st.active = true; st.finishedAt = ''; appProvisionalSaveState_(st); appProvisionalAdvance_(st, ctx);
  });
  return appProvisionalStatus_(ctx);
}
/** Jobs.js terminal hook. Unrelated results never advance a maker's completed stage. */
function appProvisionalAfterJob_(job, status) {
  if (!job || job.nextJobId || status !== 'DONE' && status !== 'FAILED') return null;
  return appWithLock_(() => {
    const st = appProvisionalState_(); if (!st || !st.active || st.requestedBy !== job.requestedBy) return null;
    const ctx = appProvisionalContext_(st);
    if (!st.current) { if (st.waiting === 'OTHER_JOB') appProvisionalAdvance_(st, ctx); return st; }
    appProvisionalRecoverIntent_(st);
    if (!st.current.rootJobId || appProvisionalRootId_(job) !== st.current.rootJobId) return null;
    const item = appProvisionalItem_(st, st.current.index), expected = appProvisionalStageRequest_(st, item);
    if (expected.kind !== st.current.kind || (expected.payload.action || '') !== st.current.action) throw new Error('暫定一括の処理段が一致しません。');
    appProvisionalApplyTerminal_(st, job, status); appProvisionalAdvance_(st, ctx); return st;
  });
}

/** Owner-invoked accelerator; no recurring trigger or policy change.
 * Admission budget only: native appRunJob_ cannot be interrupted mid-stage.
 */
function appProvisionalRunNowAdmission_(job, elapsedMs, times) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return { ok: false, reason: 'CLOCK_CHANGED' };
  const past = times && times[appJobStageKey_(job)];
  if (!Array.isArray(past) || !past.length || past.length > 3 ||
      past.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) return { ok: false, reason: 'UNKNOWN_STAGE_TIME' };
  const needMs = Math.max.apply(null, past) * 1.5 + 30000;
  return { ok: Number.isFinite(needMs) && elapsedMs + needMs <= 240000,
    reason: Number.isFinite(needMs) && elapsedMs + needMs <= 240000 ? '' : 'BUDGET', needMs: needMs };
}

/** Select only the current frontier of the original batch, never a global queue. */
function appProvisionalRunNowFrontier_(ctx, batchId) {
  const st = appProvisionalState_();
  if (!st || st.id !== batchId) return { reason: 'BATCH_CHANGED' };
  if (!st.active) return { reason: 'BATCH_FINISHED' };
  if (st.requestedBy !== ctx.actor) return { reason: 'OWNER_CHANGED' };
  const cur = st.current;
  if (!cur || !cur.rootJobId || !cur.intentId) return { reason: 'NO_CURRENT_INTENT' };
  const item = appProvisionalItem_(st, cur.index);
  if (item.status !== 'RUNNING' || item.stage !== cur.stage) return { reason: 'INTENT_MISMATCH' };
  const root = appJobGet_(cur.rootJobId), chain = appProvisionalChain_(cur.rootJobId), job = chain.job;
  if (!root || !job) return { reason: chain.reason || 'MISSING_JOB' };
  if (job.status !== 'QUEUED') return { reason: job.status === 'RUNNING' ? 'CURRENT_RUNNING' : 'CURRENT_TERMINAL' };
  const allowed = { CREATE: ['PLAN.CREATE', 'PLAN.CREATE_SAVE'], IMPORT: ['PLAN.RUN', 'PLAN.RUN_CALC', 'PLAN.RUN_SAVE'],
    AGGREGATE: ['PLAN.RUN', 'PLAN.RUN_CALC', 'PLAN.RUN_SAVE'], FORECAST: ['FORECAST.RUN', 'FORECAST.RUN_CALC', 'FORECAST.RUN_SAVE'] };
  const action = cur.stage === 'IMPORT' ? 'IMPORT.SALES' : cur.stage === 'AGGREGATE' ? 'SALES.AGGREGATE' : '';
  const matches = j => j && j.requestedBy === st.requestedBy && j.payload && j.payload.provisionalBatchId === batchId &&
    j.payload.provisionalIndex === cur.index && j.payload.provisionalStage === cur.stage && j.payload.provisionalIntentId === cur.intentId;
  if (!allowed[cur.stage] || allowed[cur.stage].indexOf(job.kind) < 0 || root.kind !== cur.kind ||
      (root.payload && root.payload.action || '') !== cur.action || (job.payload && job.payload.action || '') !== action ||
      !matches(root) || !matches(job) || appProvisionalRootId_(job) !== cur.rootJobId) return { reason: 'INTENT_MISMATCH' };
  if (appProvisionalBusy_().some(j => j.id !== job.id) ||
      appJobList_().some(j => j.id !== job.id && j.status === 'RUNNING')) return { reason: 'COMPETING_JOB' };
  return { job: job, index: cur.index, stage: cur.stage, intentId: cur.intentId };
}

function appProvisionalRunNow_(ctx) {
  ctx = appProvisionalRequireOwner_(ctx);
  const startedMs = Date.now(), initial = appProvisionalState_();
  const out = { batchId: initial ? initial.id : '', admissionBudgetMs: 240000, ran: [], cleanupErrors: [], stoppedBecause: '', elapsedMs: 0 };
  if (!initial || !initial.active) { out.stoppedBecause = 'BATCH_INACTIVE'; return out; }
  if (initial.requestedBy !== ctx.actor) throw new Error('始めた所有者として実行してください。');
  for (let count = 0; count < 64; count++) {
    const selected = appProvisionalRunNowFrontier_(ctx, out.batchId);
    if (!selected.job) { out.stoppedBecause = selected.reason; break; }
    const admission = appProvisionalRunNowAdmission_(selected.job, Date.now() - startedMs, appJobStageTimes_());
    if (!admission.ok) { out.stoppedBecause = admission.reason; out.nextNeedMs = admission.needMs || null; break; }
    const job = selected.job;
    let result;
    try { result = appRunJob_(job.id); }
    catch (e) { out.stoppedBecause = 'RUN_ERROR'; out.error = String(e && e.message || e).slice(0, 240); break; }
    if (!result || result.skipped) { out.stoppedBecause = 'CLAIMED_ELSEWHERE'; break; }
    out.ran.push({ jobId: job.id, kind: job.kind, index: selected.index, stage: selected.stage,
      intentId: selected.intentId, status: result.status, nextJobId: result.nextJobId || '', estimatedMs: admission.needMs });
    // Delete only this completed invocation's own native trigger, after claim.
    // On claim failure the queued trigger stays scheduled; native claims are atomic.
    try {
      ScriptApp.getProjectTriggers().forEach(t => {
        if (job.triggerUid && t.getHandlerFunction() === 'triggerRunJob' && String(t.getUniqueId()) === String(job.triggerUid)) ScriptApp.deleteTrigger(t);
      });
    } catch (e) { out.cleanupErrors.push({ jobId: job.id, error: String(e && e.message || e).slice(0, 160) }); out.stoppedBecause = 'CLEANUP_ERROR'; break; }
    if (result.status !== 'DONE') { out.stoppedBecause = 'JOB_FAILED'; break; }
    if (!result.nextJobId) {
      const stored = appJobGetResult_(job.id);
      if (stored.found && stored.value && stored.value.needConfirm) { out.stoppedBecause = 'CONFIRM'; break; }
    }
    if (count === 63) out.stoppedBecause = 'ITERATION_LIMIT';
  }
  out.elapsedMs = Date.now() - startedMs;
  return out;
}
