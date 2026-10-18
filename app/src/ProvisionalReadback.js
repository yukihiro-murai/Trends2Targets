/** Owner-only persisted snapshot. No model, input, journal or job writes. */
function appProvisionalReadbackRows_(table, rows, columns) {
  const d=APP_TABLES[table],cols=columns||d.columns;
  const keyed=rows.map(r=>{const all=appObjectToRow_(d,r);return {key:JSON.stringify(d.key.map(k=>r[k])),cells:cols.map(c=>all[d.columns.indexOf(c)])};});
  keyed.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:JSON.stringify(a.cells)<JSON.stringify(b.cells)?-1:JSON.stringify(a.cells)>JSON.stringify(b.cells)?1:0);
  return {count:keyed.length,sha256:appOfflineHash_({columns:cols,rows:keyed.map(x=>x.cells)})};
}
function appProvisionalReadbackCategory_(table,row) {
  const sheet=table==='ENG_SHEETS'||table==='ENG_ROWS'||table==='ENG_FORMATS'?row.sheet:table.slice(0,4)==='ENG_'?table.slice(4):'';
  if(['PLANS','CLIENTS','CLIENT_NAMES','PERSON_LINKS'].indexOf(table)>=0)return 'identity_people';
  if(table==='BUDGET_DRAFTS')return 'budget';
  if(table==='PLAN_VERSIONS')return 'official_versions';
  if(['PRODUCT','CLIENT','OPINIONS','DEV_SPOT','AI_RESEARCH','AI_RESEARCH_STRUCTURED'].indexOf(sheet)>=0)return 'subjective';
  if(sheet==='CONFIG')return 'configuration';
  if(['CALIBRATION_STATE','CALIBRATION_HISTORY','SOURCE_RELIABILITY','RELIABILITY_EVIDENCE','POOL_PRIOR','QUARTERLY_REVIEW','QUARTERLY_REVIEW_LOG'].indexOf(sheet)>=0||['HIT_RECORDS','LEARNING_LOG','BACKTEST'].indexOf(table)>=0)return 'calibration_learning';
  if(['SALES_INPUT','SALES_MONTHLY','OUTPUT','RUN_LOG','FORECAST_SNAPSHOT','PROCESS_STATUS','AI_SCORE_HISTORY','AI_IMPACT_HISTORY','SUBJECTIVE_IMPACT_HISTORY','LANDING_FORECAST'].indexOf(sheet)>=0||['FORECAST_RUNS','FORECAST_MONTHLY','PLAN_ACTIONS','LAYER_EFFECTS','FORECAST_METHODS','METHOD_WEIGHTS','EFFECT_COEFS','PUSH_RAW'].indexOf(table)>=0)return 'expected_sales_forecast_logs';
  return 'other_protected';
}
function appProvisionalReadbackProtect_(plan,cache) {
  const tables={},categories={};
  Object.keys(APP_TABLES).sort().forEach(table=>{
    const d=APP_TABLES[table];let rows;
    if(d.columns.indexOf('plan_id')>=0)rows=d.columns[0]==='plan_id'?appReadPlanTable_(table,plan.plan_id):(cache[table]||(cache[table]=appReadTable_(table))).filter(r=>r.plan_id===plan.plan_id);
    else if(['CLIENTS','CLIENT_NAMES','PERSON_LINKS'].indexOf(table)>=0)rows=(cache[table]||(cache[table]=appReadTable_(table))).filter(r=>r.client_id===plan.client_id);
    else return;
    tables[table]=appProvisionalReadbackRows_(table,rows);
    const split={};rows.forEach(r=>{const c=appProvisionalReadbackCategory_(table,r);(split[c]||(split[c]=[])).push(r);});
    // Empty tables remain bound, including tables with no current input rows.
    if(!rows.length)split[appProvisionalReadbackCategory_(table,{})]=[];
    Object.keys(split).forEach(c=>{
      const execution=['updated_at','updated_by','row_version'];
      (categories[c]||(categories[c]={}))[table]=appProvisionalReadbackRows_(table,split[c],table==='PLANS'?d.columns.filter(k=>execution.indexOf(k)<0):null);
      if(table==='PLANS')(categories.expected_execution_metadata||(categories.expected_execution_metadata={}))[table]=appProvisionalReadbackRows_(table,split[c],['plan_id'].concat(execution));
    });
  });
  const categoryHashes={};Object.keys(categories).sort().forEach(c=>{categoryHashes[c]=appOfflineHash_(categories[c]);});
  return {planId:plan.plan_id,clientId:plan.client_id,measure:appPlanIsMeasure_(plan),tables:tables,categories:categories,categoryHashes:categoryHashes,fullRowsSha256:appOfflineHash_(tables)};
}
function appProvisionalReadbackCompare_(current,baseline) {
  const out={baselineAt:baseline.at,normal:[],protected:[],globals:[]};
  current.forEach(p=>{
    const before=baseline.protectedPlans.filter(x=>x.planId===p.planId)[0];
    appOfflineAssert_(before&&before.clientId===p.clientId&&before.measure===p.measure,'readback baseline protected identity mismatch');
    const changes=[];Array.from(new Set(Object.keys(before.categoryHashes).concat(Object.keys(p.categoryHashes)))).sort().forEach(c=>{if(before.categoryHashes[c]!==p.categoryHashes[c])changes.push(c);});
    const changedTables=Array.from(new Set(Object.keys(before.tables).concat(Object.keys(p.tables)))).sort().filter(t=>!appOfflineSame_(before.tables[t],p.tables[t])).map(t=>({table:t,before:before.tables[t]||null,after:p.tables[t]||null}));
    out.protected.push({planId:p.planId,unchanged:changes.length===0,stableUnchanged:changes.every(c=>['expected_sales_forecast_logs','expected_execution_metadata'].indexOf(c)>=0),changedCategories:changes,changedTables:changedTables});
    if(!p.measure)out.normal.push({planId:p.planId,unchanged:p.fullRowsSha256===before.fullRowsSha256});
  });
  return out;
}
/** Optional baseline is a prior artifact, never asserted retroactively to predate work. */
function appProvisionalReadback_(ctx,input) {
  ctx=appOfflineOwner_(ctx);input=input||{};const fy=appProvisionalFy_(input);
  appOfflineAssert_(Array.isArray(input.protectedPlanIds)&&input.protectedPlanIds.length<=7&&input.protectedPlanIds.every(x=>typeof x==='string'&&x)&&new Set(input.protectedPlanIds).size===input.protectedPlanIds.length,'readback requires up to7 unique protected plan IDs');
  appOfflineAssert_((!input.baselineFileId&&!input.baselineSha256)||(typeof input.baselineFileId==='string'&&input.baselineFileId&&appOfflineHex_(input.baselineSha256)),'readback baseline ID and SHA required together');
  return appWithLock_(()=>{
    appOfflineRequireIdle_();appProvisionalRequireNoBulk_();appStoreForget_();
    const batch=appProvisionalState_(),state=appOfflineState_();
    appOfflineAssert_(batch&&Number(batch.fy)===fy&&batch.requestedBy===ctx.actor&&!batch.active&&!batch.current&&state&&state.batchId===batch.id&&state.requestedBy===ctx.actor&&state.sourceManifest,'readback requires idle owner handoff');
    const manifest=appOfflineReadFile_(state.sourceManifest.fileId,state.sourceManifest.sha256);
    appOfflineAssert_(manifest.manifestId===state.manifestId&&manifest.batchId===batch.id&&Number(manifest.fy)===fy&&manifest.actor===ctx.actor,'readback frozen manifest mismatch');
    const schemaSha256=appSha256Hex_(Object.keys(APP_TABLES).sort().map(n=>n+':'+appColumnsHash_(n)).join('|'));
    appOfflineAssert_(manifest.contract&&Number(manifest.contract.schemaVersion)===APP_SCHEMA_VERSION&&manifest.contract.schemaSha256===schemaSha256,'readback schema drift');
    const plans=appReadTable_('PLANS'),clients=appReadTable_('CLIENTS'),runs=appReadTable_('FORECAST_RUNS'),monthly=appReadTable_('FORECAST_MONTHLY');
    const cache={PLANS:plans,CLIENTS:clients,FORECAST_RUNS:runs,FORECAST_MONTHLY:monthly},snap={plans:plans,clients:clients};
    const expected=Array.from({length:12},(_,i)=>{const m=4+i;return(m>12?fy+1:fy)+'/'+('0'+(m>12?m-12:m)).slice(-2);});
    const items=appProvisionalItems_(batch),keys=items.map(i=>i.key);appOfflineAssert_(new Set(keys).size===items.length,'readback duplicate roster');
    const roster=items.map(item=>{
      const matches=appProvisionalFindPlans_(item.key,fy,snap),errors=[];
      if(matches.length!==1)return {key:item.key,clientName:item.clientName,errors:['PLAN_COUNT_'+matches.length],forecastReady:false,planningReady:false};
      const plan=matches[0],run=appProvisionalLatest_(runs.filter(r=>r.plan_id===plan.plan_id&&r.status==='DONE'),'finished_at','run_id');
      const months=run?monthly.filter(r=>r.plan_id===plan.plan_id&&r.run_id===run.run_id):[];
      const finite=n=>typeof n==='number'&&isFinite(n)&&n>=0;
      const ordered=(r,cols)=>cols.every(k=>finite(r[k]))&&r[cols[0]]<=r[cols[1]]&&r[cols[1]]<=r[cols[2]];
      if(!run)errors.push('MISSING_DONE_RUN');
      if(run&&(!ordered(run,['annual_p10','annual_p50','annual_p90'])||!ordered(run,['objective_p10','objective_p50','objective_p90'])))errors.push('ANNUAL_RISK');
      if(months.length!==12||!expected.every(ym=>months.filter(r=>r.ym===ym&&ordered(r,['p10','p50','p90'])&&ordered(r,['obj_p10','obj_p50','obj_p90'])).length===1))errors.push('MONTHLY_RISK');
      const planning=run?appForecastPlanningOf_(run.planning_json,fy,run.annual_p50):null,measure=appPlanIsMeasure_(plan);
      if(measure&&!planning)errors.push('MISSING_VALID_PLANNING');
      const reservation=manifest.reservations.filter(r=>r.planId===plan.plan_id)[0]||null;
      const sourceNet=reservation&&reservation.nativeSourceHistory?reservation.nativeSourceHistory.prior12Net:null;
      if(reservation&&run&&run.run_id!==reservation.runId)errors.push('RESERVED_RUN_CHANGED');
      if(reservation&&(!planning||planning.method!=='W_COMPONENT_EVENT_HALF_SHAPE_BLEND'))errors.push('RESERVED_W_MISSING');
      if(reservation&&typeof sourceNet!=='number')errors.push('SOURCE_NET_UNAVAILABLE');
      if(typeof sourceNet==='number'&&sourceNet>=1&&(!planning||planning.annualTarget<1))errors.push('POSITIVE_SOURCE_ALL_ZERO');
      if(planning&&planning.method==='W_COMPONENT_EVENT_HALF_SHAPE_BLEND'&&planning.trainingThroughYm!==fy+'/03')errors.push('TRAINING_CUTOFF');
      const halfTargets=planning?[0,1].map(h=>planning.months.slice(h*6,h*6+6).reduce((s,m)=>s+m.point,0)):null;
      return {key:item.key,clientName:item.clientName,clientDisplayName:(clients.filter(c=>c.client_id===plan.client_id)[0]||{}).client_name||plan.client_label,plan:appStripRow_(plan),run:run?appStripRow_(run):null,monthly:expected.map(ym=>months.filter(r=>r.ym===ym).map(appStripRow_)).reduce((a,b)=>a.concat(b),[]),unmatchedMonthly:months.filter(r=>expected.indexOf(r.ym)<0).map(appStripRow_),planning:planning,halfTargets:halfTargets,sourcePrior12Net:sourceNet,sourceHistorySha256:reservation&&reservation.nativeSourceHistory?reservation.nativeSourceHistory.historySha256:null,receipt:reservation?appProvisionalReadJson_(appOfflineReceiptKey_(state,reservation.reservationKey)):null,measure:measure,forecastReady:!errors.some(e=>['MISSING_DONE_RUN','ANNUAL_RISK','MONTHLY_RISK'].indexOf(e)>=0),planningReady:!!planning,errors:errors};
    });
    const selected=input.protectedPlanIds.slice(),normal=plans.filter(p=>String(p.fy)===String(fy)&&!appPlanIsMeasure_(p));
    normal.forEach(p=>{if(selected.indexOf(p.plan_id)<0)selected.push(p.plan_id);});
    const existingProtected=plans.filter(p=>String(p.fy)===String(fy)&&!manifest.reservations.some(r=>r.planId===p.plan_id));
    appOfflineAssert_(selected.length===existingProtected.length&&existingProtected.every(p=>selected.indexOf(p.plan_id)>=0),'readback must protect every pre-existing FY plan');
    appOfflineAssert_(selected.length<=7&&selected.every(id=>plans.some(p=>p.plan_id===id&&String(p.fy)===String(fy))&&!manifest.reservations.some(r=>r.planId===id)),'readback protected plans must be existing FY plans');
    const protectedPlans=selected.slice().sort().map(id=>appProvisionalReadbackProtect_(plans.filter(p=>p.plan_id===id)[0],cache));
    const globals={};['SETTINGS','MEMBERS','ROLES','YEAR_CLOSURES'].forEach(t=>{globals[t]=appProvisionalReadbackRows_(t,appReadTable_(t));});
    // Global applied-learning rows have no plan_id. Plan-scoped learning is already above.
    ['LEARNING_LOG','HIT_RECORDS','BACKTEST','PERSON_LINKS'].forEach(t=>{globals[t]=appProvisionalReadbackRows_(t,appReadTable_(t).filter(r=>t==='PERSON_LINKS'?!r.client_id:!r.plan_id));});
    const value={format:'PROVISIONAL_PERSISTED_READBACK_V1',at:new Date().toISOString(),actor:ctx.actor,fy:fy,batchId:batch.id,manifestId:state.manifestId,sourceManifestSha256:state.sourceManifest.sha256,calculatorContract:manifest.contract,calculatorSourceClosureSha256:manifest.sourceClosureSha256,controlAppVersion:APP_VERSION,schemaVersion:APP_SCHEMA_VERSION,schemaSha256:schemaSha256,sourceCutoff:fy+'/03',modelInvocations:0,storeWrites:0,expectedMonths:expected,roster:roster,protectedPlans:protectedPlans,globals:globals,preservationComparison:null};
    value.summary={roster:roster.length,forecastReady:roster.filter(r=>r.forecastReady).length,planningReady:roster.filter(r=>r.planningReady).length,positiveAnnualPoint:roster.filter(r=>r.planning&&r.planning.annualTarget>0).length,zeroAnnualPoint:roster.filter(r=>r.planning&&r.planning.annualTarget===0).length,errors:roster.filter(r=>r.errors.length).map(r=>({key:r.key,planId:r.plan&&r.plan.plan_id,errors:r.errors})),complete:roster.length===batch.count&&roster.every(r=>r.errors.length===0)};
    if(input.baselineFileId){
      const before=appOfflineReadFile_(input.baselineFileId,input.baselineSha256);
      appOfflineAssert_(before.format===value.format&&before.fy===fy&&before.batchId===batch.id&&before.manifestId===state.manifestId&&before.sourceManifestSha256===state.sourceManifest.sha256&&Array.isArray(before.protectedPlans)&&before.protectedPlans.length===protectedPlans.length,'readback baseline scope mismatch');
      const compared=appProvisionalReadbackCompare_(protectedPlans,before);Object.keys(globals).forEach(t=>compared.globals.push({table:t,unchanged:!!before.globals&&appOfflineSame_(globals[t],before.globals[t])}));
      value.preservationComparison={baselineFileId:input.baselineFileId,baselineSha256:input.baselineSha256,baselineAt:before.at,result:compared,normalUnchanged:compared.normal.every(r=>r.unchanged),stableProtectedUnchanged:compared.protected.every(r=>r.stableUnchanged),globalUnchanged:compared.globals.every(r=>r.unchanged)};
    }
    appOfflineRequireIdle_(); // Still inside the same lock; no model/write path was entered.
    const file=appOfflineWriteFile_('Trends2Targets_Persisted_Readback_'+fy+'_'+Date.now(),value);
    return {format:value.format,file:file,summary:value.summary,protectedPlanIds:selected,baselineCompared:!!value.preservationComparison,preservation:value.preservationComparison?{normalUnchanged:value.preservationComparison.normalUnchanged,stableProtectedUnchanged:value.preservationComparison.stableProtectedUnchanged,globalUnchanged:value.preservationComparison.globalUnchanged}:null};
  });
}
