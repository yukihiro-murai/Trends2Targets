/** Owner-only verified new-plan handoff through the native journal. */
const APP_OFFLINE_KEY = 'APP_PROVISIONAL_OFFLINE_V1';
const APP_OFFLINE_PROJECTION = [41, 46, 50, 56, 57, 66];
const APP_OFFLINE_LOGS = ['PLAN_ACTIONS', 'LAYER_EFFECTS', 'FORECAST_METHODS', 'METHOD_WEIGHTS', 'EFFECT_COEFS', 'PUSH_RAW'];

function appOfflineAssert_(yes, message) { if (!yes) throw new Error('Offline handoff: ' + message); }
function appOfflineHash_(v) { return appSha256Hex_(JSON.stringify(v)); }
function appOfflineHex_(v) { return typeof v === 'string' && /^[a-f0-9]{64}$/.test(v); }
function appOfflineSame_(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function appOfflineOwner_(ctx) { return appProvisionalRequireOwner_(ctx); }
function appOfflineState_() { return appProvisionalReadJson_(APP_OFFLINE_KEY); }
function appOfflineSave_(s) { appProvisionalSaveJson_(APP_OFFLINE_KEY, s); }
function appOfflinePartKey_(s, i) { return APP_OFFLINE_KEY + '_PART_' + s.manifestId + '_' + i; }
function appOfflineReceiptKey_(s, key) { return APP_OFFLINE_KEY + '_RECEIPT_' + s.manifestId + '_' + key; }
function appOfflineAllowedTables_() {
  return ['PLANS', 'CLIENTS', 'ENG_SHEETS', 'ENG_ROWS', 'ENG_FORMATS', 'FORECAST_RUNS', 'FORECAST_MONTHLY'].concat(
    Object.keys(APP_ENGINE_SHEETS).filter(n => APP_ENGINE_SHEETS[n].mode === 'table').map(n => 'ENG_' + n), APP_OFFLINE_LOGS);
}
function appOfflineContract_() {
  const e = appLegacyEngine_(appLegacyServices_({}, { asOfMs: Date.now(), seed: 'offline-contract', actor: '' }));
  return { appVersion: APP_VERSION, engineVersion: e.VERSION, engineSourceSha256: e.SOURCE_SHA256, webSourceSha256: e.WEB_SOURCE_SHA256,
    schemaVersion: APP_SCHEMA_VERSION, schemaSha256: appSha256Hex_(Object.keys(APP_TABLES).sort().map(n => n + ':' + appColumnsHash_(n)).join('|')) };
}
function appOfflineSchema_() {
  const out = {}; Object.keys(APP_TABLES).sort().forEach(n => { const d = APP_TABLES[n]; out[n] = { columns: d.columns.slice(), key: d.key.slice(), types: d.types || {}, raw: !!d.raw, appendOnly: !!d.appendOnly }; }); return out;
}
function appOfflineWriteFile_(label, value) {
  const text = JSON.stringify(value), folder = DriveApp.getFolderById(appProps_().getProperty(APP_PROP.folderId));
  const f = folder.createFile(label + '.json', text, MimeType.PLAIN_TEXT);
  return { fileId: f.getId(), sha256: appSha256Hex_(text), bytes: appUtf8Bytes_(text) };
}
function appOfflineReadFile_(id, sha) {
  appOfflineAssert_(typeof id === 'string' && id && appOfflineHex_(sha), 'file ID and expected SHA required');
  const text = DriveApp.getFileById(id).getBlob().getDataAsString();
  appOfflineAssert_(appUtf8Bytes_(text) <= 30000000 && appSha256Hex_(text) === sha, 'file hash/size mismatch');
  return JSON.parse(text);
}
function appOfflineSourceStamp_(id) {
  const f = DriveApp.getFileById(id);
  appOfflineAssert_(typeof f.getLastUpdated === 'function', 'source modification stamp unavailable');
  const d = f.getLastUpdated(); appOfflineAssert_(d && isFinite(d.getTime()), 'invalid source stamp'); return d.toISOString();
}
function appOfflineRows_(table, planId) { return appReadTable_(table).filter(r => r.plan_id === planId).map(appStripRow_); }
function appOfflineLearning_(ctx, plan, asOfMs) {
  const tri = appTriWeights_(ctx, plan, asOfMs), eff = appLearnEffects_(ctx, plan, asOfMs);
  return { tri: tri, eff: eff, sha256: appOfflineHash_({ tri: tri, eff: eff }) };
}
function appOfflineVirtualPlan_(r, m) { return { plan_id: r.planId, client_id: r.clientId, client_label: r.clientName, fy: String(m.fy), people_csv: '', purpose: APP_PLAN_MEASURE, state: 'ACTIVE', locale: m.locale, time_zone: m.timeZone }; }
function appOfflineRequireIdle_(allowPending) {
  appOfflineAssert_(!appJobList_().some(j => j.status === 'RUNNING' || j.status === 'QUEUED'), 'native jobs still active');
  appOfflineAssert_(allowPending || !appJournalPending_(), 'pending native journal');
}

function appOfflineQueuedBindings_(ctx,batch) {
  const queued=appJobList_().filter(j=>j.status==='QUEUED'&&j.payload&&j.payload.provisionalBatchId===batch.id);
  return queued.map(j=>{const cur=batch.current,p=j.payload,allowed={CREATE:['PLAN.CREATE','PLAN.CREATE_SAVE'],IMPORT:['PLAN.RUN','PLAN.RUN_CALC','PLAN.RUN_SAVE'],AGGREGATE:['PLAN.RUN','PLAN.RUN_CALC','PLAN.RUN_SAVE'],FORECAST:['FORECAST.RUN','FORECAST.RUN_CALC','FORECAST.RUN_SAVE']};
    appOfflineAssert_(cur&&cur.rootJobId&&cur.intentId&&j.requestedBy===ctx.actor&&p.provisionalIndex===cur.index&&p.provisionalStage===cur.stage&&p.provisionalIntentId===cur.intentId&&allowed[cur.stage]&&allowed[cur.stage].indexOf(j.kind)>=0&&appProvisionalRootId_(j)===cur.rootJobId,'queued intent/owner/ancestry mismatch');
    appProvisionalRequireWritable_(p);
    return{id:j.id,triggerUid:j.triggerUid,kind:j.kind,requestedBy:j.requestedBy,parentId:j.parentId,payloadSha256:appOfflineHash_(p)};
  });
}
function appOfflinePauseCurrent_(batch) {
  if(!batch.current)return;
  const item=appProvisionalItem_(batch,batch.current.index);
  item.status='PENDING';item.handoffPausedStage=item.stage||batch.current.stage||'';
  appProvisionalSaveItem_(batch,item);
}
function appOfflineCancelBound_(bindings) {
  (bindings||[]).forEach(b=>{const j=appJobGet_(b.id);appOfflineAssert_(j&&j.requestedBy===b.requestedBy&&j.kind===b.kind&&j.parentId===b.parentId&&j.triggerUid===b.triggerUid&&appOfflineHash_(j.payload)===b.payloadSha256,'queued handoff binding changed');
    appOfflineAssert_(j.status==='QUEUED'||j.status==='FAILED'&&j.error==='Transferred to verified offline handoff','queued handoff stage changed');
    j.status='FAILED';j.error='Transferred to verified offline handoff';j.finishedAt=appNowIso_();appJobSave_(j);
    ScriptApp.getProjectTriggers().forEach(t=>{if(String(t.getUniqueId())===b.triggerUid&&t.getHandlerFunction()==='triggerRunJob')ScriptApp.deleteTrigger(t);});
  });
}
/** Quiesce only at an idle execution boundary; never terminate a RUNNING job. */
function appOfflinePrepare_(ctx, input) {
  ctx = appOfflineOwner_(ctx); input = input || {};
  appOfflineAssert_(appOfflineHex_(input.sourceClosureSha256), 'source closure SHA required');
  return appWithLock_(() => {
    appOfflineAssert_(!appOfflineState_(), 'handoff already exists');
    const batch = appProvisionalState_();
    appOfflineAssert_(batch && batch.requestedBy === ctx.actor, 'owner batch required');
    appOfflineAssert_(!appJobList_().some(j => j.status === 'RUNNING'), 'wait for RUNNING native stage');
    appOfflineAssert_(!appJournalPending_() && !appBulkState_().active, 'journal/bulk still active');
    appRequireOpenYear_(batch.fy);
    const quiesceJobs=appOfflineQueuedBindings_(ctx,batch);
    const snap = appProvisionalSnapshot_(), items = appProvisionalItems_(batch), canaryItem = items.find(i => i.status === 'DONE' && i.planId);
    appOfflineAssert_(canaryItem, 'completed native canary required');
    const canaryRun = appProvisionalLatest_(snap.runs.filter(r => r.plan_id === canaryItem.planId && r.status === 'DONE'), 'finished_at', 'run_id');
    appOfflineAssert_(canaryRun && appProvisionalReadiness_(appPlanOf_(canaryItem.planId), snap).planningReady, 'native canary incomplete');
    const sourceId = appSettingValue_('source.zac_spreadsheet'), sourceStamp = appOfflineSourceStamp_(sourceId);
    const sourceSheets = appOfflineEngineSourceInfo_(sourceId).map(s => Object.assign({}, s, {readColumns:66, projection:APP_OFFLINE_PROJECTION.slice(),nativeSkipped:s.lastRow<2}));
    appOfflineAssert_(sourceSheets.length && sourceSheets.every(s => s.nativeSkipped || s.maxColumns >= 66), 'source sheets missing native columns');
    const m = { format: 'OFFLINE_NEW_MEASURE_EXPORT_V1', manifestId: appId_('OFF'), batchId: batch.id, fy: Number(batch.fy), asOfMs: Math.floor(Date.now()/1000)*1000, actor: ctx.actor,
      timeZone: APP_TZ, locale: appNewPlanTz_().locale, sourceClosureSha256: input.sourceClosureSha256, contract: appOfflineContract_(), schemaColumns: appOfflineSchema_(),
      sourceId: sourceId, sourceModifiedAt: sourceStamp, cutoff: batch.fy + '/03', sourceStart: (Number(batch.fy) - 4) + '/04', sourceSheets: sourceSheets,
      quiesceJobs:quiesceJobs,existingClients: snap.clients.map(appStripRow_), reservations: [], nativeOnly: items.filter(i => appProvisionalFindPlans_(i.key, batch.fy, snap).length).map(i => ({ index: i.index, key: i.key, planId: i.planId || '', status: i.status })) };
    items.filter(i => !appProvisionalFindPlans_(i.key, batch.fy, snap).length).forEach(item => {
      const client = snap.clients.find(c => c.normalized_name === item.key);
      const r = { reservationKey: appId_('RES'), index: item.index, clientName: item.clientName, normalizedName: item.key,
        planId: appId_('PL'), clientId: client ? client.client_id : appId_('CL'), clientNew: !client, runId: appId_('RUN'), createToken: appId_('SCR'), actionIds: { import: appId_('ACT'), aggregate: appId_('ACT') } };
      r.nativeLearning = appOfflineLearning_(ctx, appOfflineVirtualPlan_(r, m), m.asOfMs); m.reservations.push(r);
    });
    appOfflineAssert_(m.reservations.length && appMeasureCount_(snap.plans, '') + m.reservations.length <= APP_MEASURE_PLAN_MAX, 'new-plan roster/capacity invalid');
    const canaryTables = {}; appOfflineAllowedTables_().filter(t => t !== 'CLIENTS').forEach(t => { canaryTables[t] = appOfflineRows_(t, canaryItem.planId); });
    const canaryClocks = Array.from(new Set((canaryTables.ENG_FORECAST_SNAPSHOT || []).map(r => Date.parse(r.run_date))
      .filter(ms => isFinite(ms) && Math.floor(ms / 1000) === Math.floor(Date.parse(canaryRun.as_of) / 1000))));
    appOfflineAssert_(canaryClocks.length === 1, 'exact native canary clock unavailable');
    m.canary = { planId: canaryItem.planId, asOfMs: canaryClocks[0], run: appStripRow_(canaryRun), runSha256: appOfflineHash_(appStripRow_(canaryRun)), tables: canaryTables,
      nativeLearning: appOfflineLearning_(ctx, appPlanOf_(canaryItem.planId), canaryClocks[0]) };
    // Bind the complete export before quiescing. A failure leaves a recoverable state.
    const prepared = appOfflineWriteFile_('Trends2Targets_Offline_Prepare_' + m.manifestId, m);
    const state = { manifestId: m.manifestId, batchId: batch.id, requestedBy: ctx.actor, status: 'PREPARING', prepared: prepared, cursor: { sheetIndex: 0, rowStart: 1, partCount: 0 }, imported: 0 };
    appOfflineSave_(state);
    // A durable inactive batch prevents every tagged continuation's guardian from writing.
    appOfflinePauseCurrent_(batch);
    batch.active = false; batch.current = null; batch.waiting = 'OFFLINE_HANDOFF'; batch.offlineHandoff = { manifestId: m.manifestId, at: appNowIso_() }; appProvisionalSaveState_(batch);
    appOfflineCancelBound_(m.quiesceJobs);
    state.status = 'PREPARED'; appOfflineSave_(state); return state;
  });
}

/** One projected source row chunk; no model or source classification is changed. */
function appOfflineExportNext_(ctx) {
  ctx = appOfflineOwner_(ctx);
  return appWithLock_(() => {
    const state = appOfflineState_(); appOfflineAssert_(state && state.requestedBy === ctx.actor && ['PREPARING', 'PREPARED', 'EXPORTING'].indexOf(state.status) >= 0, 'prepare/export state required');
    const m = appOfflineReadFile_(state.prepared.fileId, state.prepared.sha256);
    if (state.status === 'PREPARING') appOfflineFinishQuiesce_(ctx, state, m);
    appOfflineAssert_(appOfflineSame_(m.contract, appOfflineContract_()), 'runtime/schema changed');
    appOfflineAssert_(appOfflineSourceStamp_(m.sourceId) === m.sourceModifiedAt, 'source changed during export');
    const c = state.cursor, meta = m.sourceSheets[c.sheetIndex];
    if (!meta) return appOfflineFinalize_(ctx, state, m);
    if(meta.nativeSkipped){c.sheetIndex++;c.rowStart=1;state.status='EXPORTING';appOfflineSave_(state);return c.sheetIndex>=m.sourceSheets.length?appOfflineFinalize_(ctx,state,m):state;}
    const count = Math.min(2000, meta.lastRow - c.rowStart + 1);
    const rows = appOfflineEngineSourcePart_(m.sourceId, meta, c.rowStart, count, APP_OFFLINE_PROJECTION);
    appOfflineAssert_(appOfflineSourceStamp_(m.sourceId) === m.sourceModifiedAt, 'source changed during read');
    if (rows.length) {
      const part = { format: 'OFFLINE_ZAC_PART_V1', manifestId: m.manifestId, sheetName: meta.name, rowStart: c.rowStart, rowCount: rows.length, projection: APP_OFFLINE_PROJECTION.slice(), rows: rows, nativeRecords:appOfflineEngineClassifyPart_(m,meta,c.rowStart,rows) };
      const saved = Object.assign(appOfflineWriteFile_('Trends2Targets_Offline_Source_' + m.manifestId + '_' + c.partCount, part), { sheetIndex: c.sheetIndex, rowStart: c.rowStart, rowCount: rows.length });
      appProvisionalSaveJson_(appOfflinePartKey_(state, c.partCount), saved); c.partCount++; c.rowStart += rows.length;
    }
    if (c.rowStart > meta.lastRow) { c.sheetIndex++; c.rowStart = 1; }
    state.status = 'EXPORTING'; appOfflineSave_(state);
    return c.sheetIndex >= m.sourceSheets.length ? appOfflineFinalize_(ctx, state, m) : state;
  });
}
function appOfflineFinishQuiesce_(ctx, state, m) {
  const batch=appProvisionalState_();
  appOfflineAssert_(batch && batch.id===m.batchId && batch.requestedBy===ctx.actor, 'batch changed before quiesce');
  appOfflineAssert_(!appJobList_().some(j=>j.status==='RUNNING') && !appJournalPending_(), 'wait for native stage/journal');
  appOfflinePauseCurrent_(batch);
  batch.active=false; batch.current=null; batch.waiting='OFFLINE_HANDOFF'; batch.offlineHandoff={manifestId:m.manifestId,at:appNowIso_()}; appProvisionalSaveState_(batch);
  appOfflineCancelBound_(m.quiesceJobs);
  state.status='PREPARED';appOfflineSave_(state);
}
function appOfflineFinalize_(ctx, state, m) {
  appOfflineAssert_(appOfflineSourceStamp_(m.sourceId) === m.sourceModifiedAt, 'source changed during export');
  const parts = Array.from({ length: state.cursor.partCount }, (_, i) => appProvisionalReadJson_(appOfflinePartKey_(state, i)));
  const records={};m.reservations.forEach(r=>records[r.reservationKey]=[]);
  parts.forEach(p=>{const part=appOfflineReadFile_(p.fileId,p.sha256);appOfflineAssert_(part.manifestId===m.manifestId&&part.nativeRecords,'native source record binding missing');Object.keys(part.nativeRecords).forEach(k=>{appOfflineAssert_(records[k],'unknown source reservation');records[k]=records[k].concat(part.nativeRecords[k]);});});
  m.reservations.forEach(r=>{r.nativeSourceHistory=appOfflineHistoryOfRecords_(records[r.reservationKey],m);});
  m.sourceSheets = m.sourceSheets.map((s, i) => Object.assign({}, s, { parts: parts.filter(p => p.sheetIndex === i) }));
  state.sourceManifest = appOfflineWriteFile_('Trends2Targets_Offline_Export_' + m.manifestId, m); state.status = 'EXPORTED'; appOfflineSave_(state); return state;
}

/** Canonical native import ordering; no amount or classification rule is changed. */
function appOfflineHistoryOfRecords_(records,m) {
  const sorted=records.slice().sort((a,b)=>(a[0]+a[1]+a[3]+a[2]).localeCompare(b[0]+b[1]+b[3]+b[2]));
  const base48=Array(48).fill(0),spot48=Array(48).fill(0);
  sorted.forEach(r=>{appOfflineAssert_(Array.isArray(r)&&r.length===5&&['BASE','SPOT'].indexOf(r[1])>=0&&typeof r[4]==='number'&&isFinite(r[4]),'invalid classified source record');const ym=String(r[3]).split('/').map(Number),i=(ym[0]-(m.fy-4))*12+ym[1]-4;appOfflineAssert_(Number.isInteger(i)&&i>=0&&i<48,'source record outside48');const a=r[1]==='BASE'?base48:spot48;a[i]+=r[4];appOfflineAssert_(isFinite(a[i]),'source monthly sum overflow');});
  const total48=base48.map((v,i)=>v+spot48[i]);appOfflineAssert_(total48.every(isFinite),'source total overflow');
  const sum=a=>a.reduce((v,x)=>{const n=v+x;appOfflineAssert_(isFinite(n),'source annual sum overflow');return n;},0);
  const out={recordCount:sorted.length,recordsSha256:appOfflineHash_(sorted),base48:base48,spot48:spot48,total48:total48,prior12Net:sum(base48.slice(-12))+sum(spot48.slice(-12)),prior12TotalNet:sum(total48.slice(-12))};
  appOfflineAssert_(isFinite(out.prior12Net),'source prior net overflow');out.historySha256=appOfflineHash_(out);return out;
}
function appOfflineTypedRows_(table, rows) {
  const d = APP_TABLES[table]; appOfflineAssert_(d && Array.isArray(rows), 'unknown table/rows');
  const keys = {}, normalized = [];
  rows.forEach(r => {
    appOfflineAssert_(r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === d.columns.length && d.columns.every(c => Object.prototype.hasOwnProperty.call(r, c)), 'noncanonical columns in ' + table);
    Object.keys(r).forEach(c => { const v = r[c], t = appColumnType_(c, d); appOfflineAssert_(v === null || ['string', 'number', 'boolean'].indexOf(typeof v) >= 0, 'nonprimitive row cell');
      if (typeof v === 'number') appOfflineAssert_(isFinite(v), 'nonfinite row cell');
      if (t === 'bool') appOfflineAssert_(typeof v === 'boolean', 'boolean row type');
      if (t === 'num' && v !== null) appOfflineAssert_(typeof v === 'number' && isFinite(v), 'numeric row type');
      if (t === 'int') appOfflineAssert_(Number.isSafeInteger(v), 'integer row type');
      if (['num','int','bool'].indexOf(t)<0) appOfflineAssert_(typeof v==='string','text row type');
      if (d.raw) appOfflineAssert_(typeof v === 'string', 'raw row type');
    });
    const k = d.key.map(c => String(r[c])).join('\u0001'); appOfflineAssert_(d.key.every(c => r[c] !== '' && r[c] !== null) && !keys[k], 'blank/duplicate row key'); keys[k] = true;
    normalized.push(appRowToObject_(d, appObjectToRow_(d, r)));
  }); return normalized;
}
function appOfflineSheetCheck_(planId, tables, seedOnly) {
  const sheets = tables.ENG_SHEETS || [], segs = tables.ENG_ROWS || [], fmts = tables.ENG_FORMATS || [], decoded = {};
  const required = seedOnly ? [] : APP_SETUP_ORDER.filter(n => APP_ENGINE_SHEETS[n]);
  appOfflineAssert_(required.every(n => sheets.some(s => s.sheet === n)), 'required native sheets missing');
  sheets.forEach(s => {
    appOfflineAssert_(APP_ENGINE_SHEETS[s.sheet] && ['table', 'rows'].indexOf(s.mode) >= 0 && appOfflineHex_(s.content_hash), 'invalid native sheet');
    const tr = (tables['ENG_' + s.sheet] || []).slice().sort((a, b) => Number(a.seq) - Number(b.seq)), rr = segs.filter(r => r.sheet === s.sheet).sort((a, b) => Number(a.row_no) - Number(b.row_no) || Number(a.col_from) - Number(b.col_from)), fr = fmts.filter(r => r.sheet === s.sheet).sort((a, b) => Number(a.col) - Number(b.col));
    const dims = ['max_rows', 'max_columns', 'last_row', 'last_column', 'fmt_columns'].map(k => Number(s[k]));
    appOfflineAssert_(dims.every(n => Number.isSafeInteger(n) && n >= 0) && dims[0] <= 200000 && dims[1] <= 1000 && dims[2] <= dims[0] && dims[3] <= dims[1] && dims[4] <= dims[1] && dims[0]*dims[4]<=2000000 && dims[2]*dims[3]<=2000000, 'invalid sheet dimensions');
    // Normalize native insertion order rather than trusting producer object order.
    appOfflineAssert_(!seedOnly || APP_FORECAST_SEED_SHEETS.indexOf(s.sheet)>=0, 'non-seed pre-forecast sheet');
    appOfflineAssert_(s.mode !== 'table' || APP_ENGINE_SHEETS[s.sheet].mode==='table', 'invalid native table mode');
    const tableContent = (s.mode==='table'?tr:[]).map(r => { const x = { seq: r.seq }; APP_ENGINE_SHEETS[s.sheet].header.forEach(h => { x[h] = r[h]; }); x._types = r._types; return x; });
    const rowContent = rr.map(r => ({ sheet: r.sheet, row_no: r.row_no, col_from: r.col_from, cells_json: r.cells_json }));
    const formatContent = fr.map(r => ({ sheet: r.sheet, col: r.col, runs_json: r.runs_json }));
    const content = [s.sheet, s.mode].concat(dims, [s.mode === 'table' ? tableContent : [], rowContent, formatContent]);
    appOfflineAssert_(appOfflineHash_(content) === s.content_hash, 'canonical sheet hash mismatch: ' + s.sheet);
    const d = appEngDecodeSheet_(s, s.mode === 'table' ? tr : [], rr, fr);
    appOfflineAssert_(d.values.every(row=>row.every(v=>typeof v!=='number'||isFinite(v))),'nonfinite native value');
    if (['CONFIG','OUTPUT','SALES_MONTHLY','SALES_INPUT','AI_IMPACT_HISTORY','SUBJECTIVE_IMPACT_HISTORY','FORECAST_SNAPSHOT'].indexOf(s.sheet) >= 0) decoded[s.sheet] = d;
    if (['PRODUCT', 'CLIENT', 'OPINIONS', 'DEV_SPOT', 'AI_RESEARCH_STRUCTURED', 'ACTUAL_EVAL_MONTHLY'].indexOf(s.sheet) >= 0) appOfflineAssert_(d.values.slice(1).every(r => r.every(v => v === '' || v === null)), 'new-only input/actual rows not blank');
  });
  appOfflineAssert_(segs.every(r => sheets.some(s => s.sheet === r.sheet)) && fmts.every(r => sheets.some(s => s.sheet === r.sheet)), 'orphan native row');
  return decoded;
}
function appOfflinePlanCheck_(ctx, m, r, p) {
  appOfflineAssert_(p && p.reservationKey === r.reservationKey && p.tables && typeof p.tables === 'object', 'invalid reservation payload');
  const allowed = appOfflineAllowedTables_(), tables = {};
  Object.keys(p.tables).forEach(t => { appOfflineAssert_(allowed.indexOf(t) >= 0, 'forbidden table: ' + t); tables[t] = appOfflineTypedRows_(t, p.tables[t]); });
  ['PLANS', 'ENG_SHEETS', 'ENG_ROWS', 'ENG_FORMATS', 'FORECAST_RUNS', 'FORECAST_MONTHLY'].forEach(t => appOfflineAssert_(Array.isArray(tables[t]), 'required table missing: ' + t));
  Object.keys(tables).forEach(t => tables[t].forEach(row => { if (t !== 'CLIENTS') appOfflineAssert_(row.plan_id === r.planId, 'cross-plan row'); if (t.indexOf('ENG_')!==0 && row.run_id) appOfflineAssert_(row.run_id === r.runId, 'cross-run row'); }));
  const plan = tables.PLANS[0]; appOfflineAssert_(tables.PLANS.length === 1 && plan.plan_id === r.planId && plan.client_id === r.clientId && plan.client_label === r.clientName && String(plan.fy) === String(m.fy) && plan.purpose === APP_PLAN_MEASURE && plan.people_csv === '' && plan.state === 'ACTIVE' && plan.time_zone === m.timeZone && plan.locale === m.locale, 'new plan identity/purpose mismatch');
  const cr = tables.CLIENTS || []; appOfflineAssert_(cr.length === (r.clientNew ? 1 : 0), 'client row count');
  if (r.clientNew) appOfflineAssert_(cr[0].client_id === r.clientId && cr[0].client_name === r.clientName && cr[0].normalized_name === r.normalizedName, 'client identity mismatch');
  const d = appOfflineSheetCheck_(r.planId, tables), cfg = d.CONFIG.values;
  appOfflineAssert_(cfg[1][1] === r.clientName && Number(cfg[2][1]) === m.fy && cfg[3][1] === '', 'canonical CONFIG mismatch');
  const last = d.SALES_MONTHLY.values[0]; appOfflineAssert_(last && appBudgetYmOf_(last[48]) === m.cutoff && appBudgetYmOf_(last[1]) === m.sourceStart, '48-month history cutoff mismatch');
  const runs = tables.FORECAST_RUNS, run = runs[0], months = tables.FORECAST_MONTHLY;
  appOfflineAssert_(runs.length === 1 && run.run_id === r.runId && run.status === 'DONE' && run.engine_version === m.contract.engineVersion && run.engine_sha256 === m.contract.engineSourceSha256 && run.app_version === m.contract.appVersion && run.actor_email === m.actor && Date.parse(run.as_of) === m.asOfMs && run.seed_rule === APP_FORECAST_SEED_RULE && appOfflineHex_(run.input_hash), 'forecast run provenance mismatch');
  const input = p.forecastInputs;
  appOfflineAssert_(input && appOfflineHex_(input.forecastInputHash) && input.inputHash === run.input_hash && input.seedSheetHashes && typeof input.seedSheetHashes === 'object', 'forecast input proof missing');
  const allHashes=input.preForecastAllSheetHashes;
  appOfflineAssert_(allHashes&&typeof allHashes==='object'&&!Array.isArray(allHashes)&&Object.keys(allHashes).length&&Object.keys(allHashes).every(n=>APP_ENGINE_SHEETS[n]&&appOfflineHex_(allHashes[n]))&&appSha256Hex_(Object.keys(allHashes).map(n=>n+':'+allHashes[n]).sort().join('|'))===run.input_hash,'full pre-forecast input hash mismatch');
  const preAll={};appOfflineAssert_(input.preForecastAllTables&&typeof input.preForecastAllTables==='object','full pre-forecast tables required');
  Object.keys(input.preForecastAllTables).forEach(t=>{appOfflineAssert_(t.indexOf('ENG_')===0&&allowed.indexOf(t)>=0,'non-engine pre-forecast table');preAll[t]=appOfflineTypedRows_(t,input.preForecastAllTables[t]);preAll[t].forEach(row=>appOfflineAssert_(row.plan_id===r.planId,'cross-plan pre-forecast row'));});
  appOfflineSheetCheck_(r.planId,preAll);
  appOfflineAssert_((preAll.ENG_SHEETS||[]).length===Object.keys(allHashes).length&&preAll.ENG_SHEETS.every(s=>allHashes[s.sheet]===s.content_hash),'full pre-forecast canonical hash mismatch');
  const seedNames = APP_FORECAST_SEED_SHEETS.filter(n => Object.prototype.hasOwnProperty.call(input.seedSheetHashes, n));
  appOfflineAssert_(seedNames.length && Object.keys(input.seedSheetHashes).every(n => APP_FORECAST_SEED_SHEETS.indexOf(n) >= 0 && appOfflineHex_(input.seedSheetHashes[n])), 'invalid seed sheets');
  const hash = appSha256Hex_(seedNames.map(n => n + ':' + input.seedSheetHashes[n]).sort().join('|'));
  appOfflineAssert_(hash === input.forecastInputHash && run.seed === appForecastSeed_(plan, hash, { version: m.contract.engineVersion, sourceSha256: m.contract.engineSourceSha256 }), 'seed rule mismatch');
  const pre = {}, preAllowed=['ENG_SHEETS','ENG_ROWS','ENG_FORMATS'].concat(APP_FORECAST_SEED_SHEETS.filter(n=>APP_ENGINE_SHEETS[n]&&APP_ENGINE_SHEETS[n].mode==='table').map(n=>'ENG_'+n));
  appOfflineAssert_(input.preForecastSeedTables && typeof input.preForecastSeedTables==='object', 'pre-forecast tables required');
  Object.keys(input.preForecastSeedTables).forEach(t=>{appOfflineAssert_(preAllowed.indexOf(t)>=0,'non-seed proof table');pre[t]=appOfflineTypedRows_(t,input.preForecastSeedTables[t]);pre[t].forEach(row=>appOfflineAssert_(row.plan_id===r.planId,'cross-plan seed proof'));});
  appOfflineSheetCheck_(r.planId,pre,true);
  appOfflineAssert_(seedNames.every(n=>allHashes[n]===input.seedSheetHashes[n]),'seed/full input hash mismatch');
  appOfflineAssert_(seedNames.every(n=>tables.ENG_SHEETS.some(s=>s.sheet===n&&s.content_hash===input.seedSheetHashes[n])),'stored numerical seed inputs differ from pre-forecast');
  appOfflineAssert_((pre.ENG_SHEETS||[]).length===seedNames.length && seedNames.every(n=>pre.ENG_SHEETS.some(s=>s.sheet===n&&s.content_hash===input.seedSheetHashes[n])), 'pre-forecast seed hash mismatch');
  const ordered = a => a.every(v => typeof v === 'number' && isFinite(v) && v >= 0) && a[0] <= a[1] && a[1] <= a[2];
  appOfflineAssert_(ordered([run.annual_p10, run.annual_p50, run.annual_p90]) && ordered([run.objective_p10, run.objective_p50, run.objective_p90]), 'invalid annual risk');
  // Independently sum signed last-12 source rows already imported by the native action.
  const sales=tables.ENG_SALES_INPUT||[],header=APP_ENGINE_SHEETS.SALES_INPUT.header;
  const cell=(row,name)=>appCellDecode_(row._types.charAt(header.indexOf(name)),row[name]);
  const records=sales.map(row=>[String(cell(row,'client')),String(cell(row,'service_type')),String(cell(row,'product')),appBudgetYmOf_(cell(row,'target_month')),cell(row,'input_amount')]);
  const history=appOfflineHistoryOfRecords_(records,m);
  appOfflineAssert_(r.nativeSourceHistory&&appOfflineSame_(history,r.nativeSourceHistory),'native source history mismatch');
  const histRows=d.SALES_MONTHLY.values;
  appOfflineAssert_(['BASE','SPOT','TOTAL'].every((n,i)=>histRows[i+1]&&histRows[i+1][0]===n&&appOfflineSame_(histRows[i+1].slice(1,49),history[['base48','spot48','total48'][i]])),'48-month aggregate source mismatch');
  const sourcePrior12Net=r.nativeSourceHistory.prior12TotalNet;
  const planning=appForecastPlanningOf_(run.planning_json,m.fy,run.annual_p50);
  const inactiveNoPlanning=!planning&&sourcePrior12Net<=0&&[run.annual_p10,run.annual_p50,run.annual_p90,run.objective_p10,run.objective_p50,run.objective_p90].every(v=>v===0)&&months.every(x=>[x.p10,x.p50,x.p90,x.obj_p10,x.obj_p50,x.obj_p90].every(v=>v===0));
  appOfflineAssert_(inactiveNoPlanning||planning&&planning.method==='W_COMPONENT_EVENT_HALF_SHAPE_BLEND'&&planning.provisional===true&&planning.trainingThroughYm===m.cutoff,'provisional planning invalid');
  if(sourcePrior12Net>=1)appOfflineAssert_(planning&&planning.annualTarget>=1&&planning.months.some(pm=>pm.point>=1),'positive-net all-year-zero forecast');
  const expectedMonths=Array.from({length:12},(_,i)=>{const mo=4+i;return(mo>12?m.fy+1:m.fy)+'/'+('0'+(mo>12?mo-12:mo)).slice(-2);});
  appOfflineAssert_(months.length===12&&expectedMonths.every(ym=>months.filter(x=>x.ym===ym&&ordered([x.p10,x.p50,x.p90])&&ordered([x.obj_p10,x.obj_p50,x.obj_p90])).length===1),'12-month risk mismatch');
  const book = { getSheetByName: n => d[n] ? appViewSheet_(d[n], book) : null }, headline = appForecastHeadline_(book);
  appOfflineAssert_(['p10', 'p50', 'p90'].every(k => headline.annual[k] === run['annual_' + k]), 'OUTPUT annual mismatch');
  appOfflineAssert_(['p10','p50','p90'].every(k=>headline.objective[k]===run['objective_'+k]),'OUTPUT objective annual mismatch');
  appOfflineAssert_(headline.objectiveMonthly.every(x=>{const row=months.find(v=>v.ym===x.month);return row&&['p10','p50','p90'].every(k=>x[k]===row['obj_'+k]);}),'OUTPUT objective monthly mismatch');
  appOfflineAssert_(headline.monthly.every(x => { const row = months.find(v => v.ym === x.month); return row && ['p10', 'p50', 'p90'].every(k => x[k] === row[k]); }), 'OUTPUT monthly mismatch');
  ['LAYER_EFFECTS','FORECAST_METHODS'].forEach(t=>appOfflineAssert_(Array.isArray(tables[t])&&tables[t].length===12&&expectedMonths.every(ym=>tables[t].filter(x=>x.ym===ym&&x.run_id===r.runId).length===1),'native monthly log incomplete: '+t));
  ['METHOD_WEIGHTS','EFFECT_COEFS'].forEach(t=>appOfflineAssert_(Array.isArray(tables[t])&&tables[t].length===1&&tables[t][0].run_id===r.runId&&Date.parse(tables[t][0].as_of)===m.asOfMs&&tables[t][0].evidence_hash===r.nativeLearning[t==='METHOD_WEIGHTS'?'tri':'eff'].hash,'native learning log incomplete: '+t));
  appOfflineAssert_(Array.isArray(tables.PUSH_RAW)&&tables.PUSH_RAW.length<=12&&tables.PUSH_RAW.every(row=>expectedMonths.indexOf(row.ym)>=0&&row.run_id===r.runId)&&new Set(tables.PUSH_RAW.map(row=>row.ym)).size===tables.PUSH_RAW.length,'native push log invalid');
  const snaps=tables.ENG_FORECAST_SNAPSHOT||[];appOfflineAssert_(snaps.length===36&&expectedMonths.every(ym=>['nega','neutral','posi'].every(sc=>snaps.filter(row=>row.target_month===ym&&row.scenario===sc).length===1)),'native snapshot incomplete');
  const acts=tables.PLAN_ACTIONS||[];
  appOfflineAssert_(acts.length===2 && [['IMPORT.SALES',r.actionIds.import],['SALES.AGGREGATE',r.actionIds.aggregate]].every(pair=>acts.filter(a=>a.action===pair[0]&&a.action_id===pair[1]&&a.status==='DONE'&&a.seed===pair[1]&&a.engine_version===m.contract.engineVersion&&a.engine_sha256===m.contract.engineSourceSha256&&a.web_sha256===m.contract.webSourceSha256&&a.actor_email===m.actor&&Date.parse(a.as_of)===m.asOfMs&&appOfflineHex_(a.input_hash)).length===1),'native import/aggregate action provenance');
  snaps.forEach(row=>{const month=months.find(x=>x.ym===row.target_month),col={nega:'p10',neutral:'p50',posi:'p90'}[row.scenario],h=APP_ENGINE_SHEETS.FORECAST_SNAPSHOT.header;
    const val=(name)=>appCellDecode_(row._types.charAt(h.indexOf(name)),row[name]);
    appOfflineAssert_(val('final_pred')===month[col],'native snapshot risk differs');
    if(planning){const k=JSON.parse(String(row.key_factors_json||'{}')).monthly_point,pm=planning.months.find(x=>x.ym===row.target_month);appOfflineAssert_(k&&k.point===pm.point&&k.annualTarget===planning.annualTarget&&k.version===planning.version&&k.method===planning.method,'native snapshot point differs');}
  });
  const nativePush=appPushOps_(ctx,plan,{runId:r.runId},book,[{table:'LAYER_EFFECTS',rows:tables.LAYER_EFFECTS}]).reduce((a,op)=>a.concat(op.rows||[]),[]);
  const withoutRecorded=row=>{const q=Object.assign({},row);delete q.recorded_at;return q;};
  appOfflineAssert_(appOfflineSame_(nativePush.map(withoutRecorded),tables.PUSH_RAW.map(withoutRecorded)),'native push log incomplete/different');
  const nativeLearning = appOfflineLearning_(ctx, appOfflineVirtualPlan_(r, m), m.asOfMs);
  appOfflineAssert_(nativeLearning.sha256 === r.nativeLearning.sha256 && appOfflineSame_(nativeLearning, r.nativeLearning), 'native learning evidence changed');
  const compact=appPayloadCompact_(null,nativeLearning.tri,nativeLearning.eff),params=Object.assign({runId:r.runId,asOfMs:m.asOfMs},compact);
  appTriWeightsOps_(ctx,plan,params).concat(appEffOps_(ctx,plan,params)).forEach(op=>{appOfflineAssert_(tables[op.table]&&tables[op.table].length===op.rows.length,'native learned log missing');op.rows.forEach((row,i)=>{const expect=Object.assign({},row),actual=Object.assign({},tables[op.table][i]);delete expect.recorded_at;delete actual.recorded_at;appOfflineAssert_(appOfflineSame_(appObjectToRow_(APP_TABLES[op.table],expect),appObjectToRow_(APP_TABLES[op.table],actual)),'native learned log differs: '+op.table);});});
  return { reservation: r, tables: tables, run: run, planning: planning, inactiveNoPlanning:inactiveNoPlanning,sourcePrior12Net:sourcePrior12Net };
}

/** Validate every submitted plan before opening a write journal. */
function appOfflinePreflight_(ctx, input) {
  ctx = appOfflineOwner_(ctx); input = input || {}; const state = appOfflineState_();
  appOfflineAssert_(state && state.requestedBy === ctx.actor && state.sourceManifest, 'finalized export required');
  const m = appOfflineReadFile_(state.sourceManifest.fileId, state.sourceManifest.sha256), bundle = appOfflineReadFile_(input.fileId, input.sha256);
  appOfflineAssert_(appOfflineSame_(m.contract, appOfflineContract_()), 'runtime/schema drift');
  if(m.sourceId)appOfflineAssert_(appOfflineSourceStamp_(m.sourceId)===m.sourceModifiedAt,'source changed after export');
  appOfflineAssert_(bundle.provenance&&bundle.provenance.sourceClosureSha256===m.sourceClosureSha256&&bundle.provenance.sourcePinSha256===m.sourceClosureSha256,'calculator closure mismatch');
  appOfflineAssert_(bundle.format === 'OFFLINE_NEW_MEASURE_BUNDLE_V1' && bundle.manifestId === m.manifestId && bundle.sourceManifestSha256 === state.sourceManifest.sha256 && appOfflineSame_(bundle.contract, m.contract) && bundle.fy === m.fy && bundle.asOfMs === m.asOfMs && bundle.actor === m.actor && Array.isArray(bundle.plans) && bundle.plans.length > 0, 'bundle contract mismatch');
  appRequireOpenYear_(m.fy); const plans = appReadTable_('PLANS'), clients = appReadTable_('CLIENTS'), seen = {}, globalKeys={}, verified = [];
  const absent=m.reservations.filter(r=>!plans.some(p=>p.plan_id===r.planId)).length;appOfflineAssert_(appMeasureCount_(plans,'')+absent<=APP_MEASURE_PLAN_MAX,'new-plan capacity changed');
  bundle.plans.forEach(p => {
    const r = m.reservations.find(v => v.reservationKey === p.reservationKey); appOfflineAssert_(r && !seen[r.reservationKey], 'unknown/duplicate reservation'); seen[r.reservationKey] = true;
    const receipt = appProvisionalReadJson_(appOfflineReceiptKey_(state, r.reservationKey));
    if(receipt) appOfflineAssert_(receipt.bundleSha256===input.sha256 && receipt.reservationKey===r.reservationKey && receipt.planId===r.planId && receipt.runId===r.runId && ['WRITING','DONE'].indexOf(receipt.status)>=0,'reservation receipt conflict');
    const existing = plans.filter(v => v.plan_id === r.planId || String(v.fy) === String(m.fy) && (v.client_id===r.clientId || appProvisionalPlanKey_(v,{clients:clients})===r.normalizedName || appNormalizeName_(v.client_label) === r.normalizedName));
    appOfflineAssert_(!existing.length || receipt && receipt.bundleSha256 === input.sha256 && existing.length === 1 && existing[0].plan_id === r.planId, 'target plan already exists');
    appOfflineAssert_(!clients.some(c => c.client_id !== r.clientId && c.normalized_name === r.normalizedName), 'client identity drift');
    if(!r.clientNew) {const frozen=m.existingClients.find(c=>c.client_id===r.clientId); const live=clients.find(c=>c.client_id===r.clientId); appOfflineAssert_(frozen&&live&&appOfflineSame_(appStripRow_(live),frozen),'reused client changed/missing');}
    const checked = appOfflinePlanCheck_(ctx, m, r, p);
    Object.keys(checked.tables).forEach(t => { const def = APP_TABLES[t], have = appReadTable_(t), key = row => def.key.map(k => String(row[k])).join('\u0001'), first = new Map();
      if (checked.tables[t].length) have.forEach(v => { const k = key(v); if (!first.has(k)) first.set(k, v); });
      checked.tables[t].forEach(row => {
      const rowKey=key(row),globalKey=t+'\u0001'+rowKey; appOfflineAssert_(!globalKeys[globalKey],'cross-plan duplicate global key: '+t);globalKeys[globalKey]=true;
      const old = first.get(rowKey);
      appOfflineAssert_(!old || receipt && receipt.bundleSha256 === input.sha256 && appOfflineSame_(appObjectToRow_(def, old), appObjectToRow_(def, row)), 'existing global key conflict: ' + t);
    }); }); verified.push(checked);
  });
  return { state: state, manifest: m, bundle: bundle, plans: verified };
}

/** One new plan per native journal; exact interrupted-journal replay only. */
function appOfflineImport_(ctx, input) {
  ctx=appOfflineOwner_(ctx);input=input||{};
  return appWithLock_(()=>{
    appOfflineRequireIdle_(true);
    const verified=appOfflinePreflight_(ctx,input),state=verified.state,m=verified.manifest;
    const batch=appProvisionalState_();appOfflineAssert_(batch&&batch.id===m.batchId&&!batch.active&&batch.offlineHandoff&&batch.offlineHandoff.manifestId===m.manifestId,'batch changed during handoff');
    const proof=appOfflineReadFile_(input.canaryProofFileId,input.canaryProofSha256);
    appOfflineAssert_(proof.format==='OFFLINE_NATIVE_CANARY_PROOF_V1'&&proof.pass===true&&proof.oldWholePlanInputHashReconstructed===false&&proof.inputHashScope==='FORECAST_SEED_SHEETS_CANONICAL_V1'&&proof.planningMeans===true&&proof.planningMetadata===true&&proof.nativeSaveApi===true&&proof.learningEvidenceMatches===true&&proof.manifestId===m.manifestId&&proof.sourceManifestSha256===state.sourceManifest.sha256&&proof.liveRunId===m.canary.run.run_id&&proof.liveRunSha256===m.canary.runSha256&&['inputHashes','annualQuantiles','monthlyQuantiles','planningPoints'].every(k=>proof[k]===true),'matched native canary proof required');
    const next=verified.plans.find(p=>{const q=appProvisionalReadJson_(appOfflineReceiptKey_(state,p.reservation.reservationKey));return !q||q.status!=='DONE';});
    const pending=appJournalPending_();
    if(!next){appOfflineAssert_(!pending,'unrelated pending journal');return {done:true,imported:state.imported,replay:true};}
    const r=next.reservation,label='Verified offline new MEASURE '+m.manifestId+' '+r.reservationKey;
    const order=['CLIENTS','PLANS'].concat(appOfflineAllowedTables_().filter(t=>t!=='CLIENTS'&&t!=='PLANS'));
    const ops=order.filter(t=>next.tables[t]&&next.tables[t].length).map(t=>({table:t,mode:'ensure',rows:next.tables[t]}));
    const prior=appProvisionalReadJson_(appOfflineReceiptKey_(state,r.reservationKey));
    if(prior) appOfflineAssert_(prior.canaryProofSha256===input.canaryProofSha256&&prior.opsSha256===appOfflineHash_(ops),'receipt proof/ops changed');
    if(pending){
      const body=JSON.parse(DriveApp.getFileById(pending.fileId).getBlob().getDataAsString());
      appOfflineAssert_(prior&&prior.status==='WRITING'&&pending.planId===r.planId&&pending.label===label&&body.id===pending.id&&body.actor===ctx.actor&&body.planId===r.planId&&body.label===label&&appOfflineHash_(body.ops)===appOfflineHash_(ops),'unrelated or changed pending journal');
      appJournalRecover_(ctx);
    }
    const receipt=prior||{reservationKey:r.reservationKey,planId:r.planId,runId:r.runId,bundleSha256:input.sha256,canaryProofSha256:input.canaryProofSha256,opsSha256:appOfflineHash_(ops),status:'WRITING'};
    appProvisionalSaveJson_(appOfflineReceiptKey_(state,r.reservationKey),receipt);
    appJournalRun_(ctx,label,r.planId,ops);
    // Re-read exact native rows after journal before assigning workflow readiness.
    Object.keys(next.tables).forEach(t=>{const def=APP_TABLES[t],have=appReadTable_(t),key=row=>def.key.map(k=>String(row[k])).join('\u0001'),first=new Map();if(next.tables[t].length)have.forEach(v=>{const k=key(v);if(!first.has(k))first.set(k,v);});next.tables[t].forEach(row=>{const old=first.get(key(row));appOfflineAssert_(old&&appOfflineSame_(appObjectToRow_(def,old),appObjectToRow_(def,row)),'post-import row mismatch: '+t);});});
    const readiness=appProvisionalReadiness_(appPlanOf_(r.planId),appProvisionalSnapshot_());appOfflineAssert_(readiness.forecastReady&&(readiness.planningReady||next.inactiveNoPlanning)&&readiness.runId===r.runId,'post-import readiness mismatch');
    const item=appProvisionalItem_(batch,r.index);appOfflineAssert_(item&&item.key===r.normalizedName,'reservation item changed');
    item.planId=r.planId;item.status=next.inactiveNoPlanning?'UNREADY':'DONE';item.stage='';item.error='';item.completionMode='verified_offline_bundle';item.offlineReceipt=Object.assign({},receipt,{status:'DONE',completionMode:'verified_offline_bundle'});item.readiness=readiness;appProvisionalSaveItem_(batch,item);
    receipt.status='DONE';receipt.completionMode='verified_offline_bundle';receipt.inactiveNoPlanning=next.inactiveNoPlanning;receipt.sourcePrior12Net=next.sourcePrior12Net;appProvisionalSaveJson_(appOfflineReceiptKey_(state,r.reservationKey),receipt);
    state.imported=m.reservations.filter(v=>{const q=appProvisionalReadJson_(appOfflineReceiptKey_(state,v.reservationKey));return q&&q.status==='DONE';}).length;state.status='IMPORTING';appOfflineSave_(state);
    return {done:false,imported:state.imported,receipt:receipt,readiness:readiness};
  });
}
