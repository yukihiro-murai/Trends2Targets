/** Append-only publication of validated history-only monthly points; raw risk runs remain immutable. */
const APP_POINT_REVISION_ACTION = 'FORECAST.POINT_REFRESH';
// Owner-authorized provisional EE is not a formal accuracy pass. Earlier BB remains readable; component endpoints are internal.
// Config: { policySha256, engineSourceSha256, acceptedEngineSourceSha256s, entrypoint, normalize, validateNative, modes }.
// normalize is a fixed local function, never user-supplied source/code.
const APP_POINT_APPROVED_POLICIES = Object.freeze({ 'BB_EQUAL_WEIGHT_W_AA_COMBINATION': { policySha256:'c9c4046e25d904ccc1e507f34761b138974c820bedc44fc03294d38c864a4f93',engineSourceSha256:'b4b41fbbafcfe782da18949c5b935874529f986177341cacd4117994f63dae3f',acceptedEngineSourceSha256s:['b4b41fbbafcfe782da18949c5b935874529f986177341cacd4117994f63dae3f'],entrypoint:'appHistoryCombinationForecast_',normalize:appPointNormalizeCombination_,validateNative:appPointValidateCombination_,modes:['equal_weight_complete_policies','complete_W'] }, 'EE_PREQUENTIAL_AMOUNT_POLICY_BB': { policySha256:'891fe637890b07b37f22bf0a98e3c1745cdc2ab72527fd810b22e773b651cb1a',engineSourceSha256:'789825d1b2f2a0d8647417fd0300db3eea513020ff301c31ab6fec3b31baf621',acceptedEngineSourceSha256s:['789825d1b2f2a0d8647417fd0300db3eea513020ff301c31ab6fec3b31baf621'],entrypoint:'appHistoryPrequentialAmountForecast_',normalize:appPointNormalizePrequential_,validateNative:appPointValidatePrequential_,predecessorMethod:'BB_EQUAL_WEIGHT_W_AA_COMBINATION',modes:['prequential_amount_selection','complete_BB'] } });
const APP_POINT_REVISION_HEAD = 'APP_POINT_REVISION_HEAD_V1';
const APP_POINT_REVISION_LIMIT = 4;
const APP_POINT_REVISION_BUDGET_MS = 240000;
const APP_POINT_REVISION_RESERVE_MS = 45000;

function appPointAssert_(ok, reason) { if (!ok) throw new Error('月次予測の更新: ' + reason); }
function appPointHash_(v) { return appSha256Hex_(JSON.stringify(v)); }
function appPointOwner_(ctx) { appPointAssert_(ctx && ctx.user && ctx.user.isOwner === true && ctx.actor, '所有者だけが操作できます。'); return ctx; }
function appPointPolicy_(method) {
  if (!Object.prototype.hasOwnProperty.call(APP_POINT_APPROVED_POLICIES, method)) return null;
  const p=APP_POINT_APPROVED_POLICIES[method];
  return p && /^[a-f0-9]{64}$/.test(p.policySha256) && /^[a-f0-9]{64}$/.test(p.engineSourceSha256) &&
    Array.isArray(p.acceptedEngineSourceSha256s) && p.acceptedEngineSourceSha256s.indexOf(p.engineSourceSha256)>=0 && p.acceptedEngineSourceSha256s.every(x=>/^[a-f0-9]{64}$/.test(x)) &&
    (p.publishEnabled===undefined||typeof p.publishEnabled==='boolean') && (p.predecessorMethod===undefined||(typeof p.predecessorMethod==='string'&&p.predecessorMethod!==method&&/^[A-Za-z0-9_]{1,120}$/.test(p.predecessorMethod))) &&
    typeof p.validateNative==='function' && typeof p.entrypoint==='string' && /^[A-Za-z_][A-Za-z0-9_]*_$/.test(p.entrypoint) && typeof p.normalize==='function' &&
    Array.isArray(p.modes) && p.modes.length && p.modes.every(x=>typeof x==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(x)) ? p : null;
}
function appPointCanonical_(table, rows) {
  const def = APP_TABLES[table];
  return rows.map(r => appObjectToRow_(def, r)).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
}
/** A request can pass already-read tables/ENG_ROWS. No global ENG_ROWS scan here. */
function appPointSnapshot_(input) {
  input=input||{};const tables=Object.assign({},input.tables||{});
  ['PLANS','ENG_SHEETS','PLAN_ACTIONS','FORECAST_RUNS','FORECAST_MONTHLY'].forEach(n=>{if(!tables[n])tables[n]=appReadTable_(n);});
  return {tables:tables,history:{},engRows:input.engRows||null,engRowsByPlan:{},settings:input.settings||null,globalContextHash:null};
}
function appPointGlobalContext_(snap) {
  if(snap.globalContextHash!==null)return snap.globalContextHash;
  // Bind the source identity once. Landing display settings, clock and unrelated runs do not invalidate these points.
  const settings=(snap.settings||appSettingsCurrent_()).filter(s=>s.key==='source.zac_spreadsheet').map(s=>[s.key,s.value]).sort((a,b)=>a[0].localeCompare(b[0]));
  snap.globalContextHash=appPointHash_({version:'POINT_NEUTRAL_CONTEXT_V1',settings:settings});
  return snap.globalContextHash;
}
function appPointLatest_(planId, snap) {
  return snap.tables.FORECAST_RUNS.filter(r => r.plan_id === planId && r.status === 'DONE').slice()
    .sort((a,b) => String(b.finished_at).localeCompare(String(a.finished_at)) || Number(b._row||0)-Number(a._row||0) || String(b.run_id).localeCompare(String(a.run_id)))[0] || null;
}
function appPointMonths_(plan, run, snap) {
  const expected = Array.from({length:12},(_,i) => { const m=i+4; return (m>12?Number(plan.fy)+1:Number(plan.fy))+'/'+('0'+(m>12?m-12:m)).slice(-2); });
  const rows = snap.tables.FORECAST_MONTHLY.filter(r => r.plan_id === plan.plan_id && r.run_id === run.run_id);
  appPointAssert_(rows.length===12 && expected.every(ym => rows.filter(r=>r.ym===ym).length===1), '12か月の予測記録を確認できません。');
  const ordered = expected.map(ym => rows.filter(r=>r.ym===ym)[0]);
  const risk = (r,keys) => keys.every(k=>typeof r[k]==='number'&&isFinite(r[k])&&r[k]>=0) && r[keys[0]]<=r[keys[1]] && r[keys[1]]<=r[keys[2]];
  appPointAssert_(risk(run,['annual_p10','annual_p50','annual_p90']) && risk(run,['objective_p10','objective_p50','objective_p90']) && ordered.every(r=>risk(r,['p10','p50','p90'])&&risk(r,['obj_p10','obj_p50','obj_p90'])), '既存の予測帯が不正です。');
  return ordered;
}
function appPointHistory_(plan, snap) {
  if (snap.history[plan.plan_id]) return snap.history[plan.plan_id];
  const meta = snap.tables.ENG_SHEETS.filter(r=>r.plan_id===plan.plan_id&&r.sheet==='SALES_MONTHLY');
  appPointAssert_(meta.length===1 && meta[0].mode==='rows' && Number(meta[0].last_column)>=49, '48か月の売上表を確認できません。');
  if(!snap.engRowsByPlan[plan.plan_id])snap.engRowsByPlan[plan.plan_id]=(snap.engRows||appReadPlanTable_('ENG_ROWS',plan.plan_id)).filter(r=>r.plan_id===plan.plan_id&&r.sheet==='SALES_MONTHLY');
  const segs=snap.engRowsByPlan[plan.plan_id];
  const dec=appEngDecodeSheet_(Object.assign({},meta[0],{fmt_columns:'0'}),[],segs,[]),sh=appViewSheet_(dec,{}),v=sh.getRange(1,1,dec.lastRow,49).getValues();
  const named=n=>v.filter(r=>String(r[0]||'').trim().toUpperCase()===n);
  const b=named('BASE'),s=named('SPOT'),t=named('TOTAL');
  appPointAssert_(b.length===1&&s.length===1&&t.length<=1,'BASE/SPOTの重複または欠損です。');
  const rows=Array.from({length:48},(_,i)=>{
    const mm=i+4,yy=Number(plan.fy)-4+Math.floor((mm-1)/12),month=(mm-1)%12+1,expected=yy+'/'+('0'+month).slice(-2),h=v[0][i+1];
    const ym=appIsDate_(h)?Utilities.formatDate(h,plan.time_zone||APP_TZ,'yyyy/MM'):String(h||'').replace('-','/');
    const base=b[0][i+1],spot=s[0][i+1],total=base+spot;
    appPointAssert_(ym===expected&&typeof base==='number'&&isFinite(base)&&typeof spot==='number'&&isFinite(spot)&&isFinite(total),'履歴月または売上値が不正です。');
    if(t.length)appPointAssert_(typeof t[0][i+1]==='number'&&t[0][i+1]===total,'TOTALとBASE+SPOTが一致しません。');
    return {ym:expected.replace('/','-'),base:base,spot:spot};
  });
  return snap.history[plan.plan_id]={rows:rows,sha256:appPointHash_(rows),sheetHash:String(meta[0].content_hash||'')};
}
function appPointContext_(plan, run, snap) {
  appPointAssert_(plan && appPlanIsMeasure_(plan) && plan.state!=='ARCHIVED' && !appYearIsFrozen_(plan.fy), '更新できない計画です。');
  appPointAssert_(run && appPointLatest_(plan.plan_id,snap).run_id===run.run_id,'最新の予測が変わりました。');
  const months=appPointMonths_(plan,run,snap),rawPlanning=appForecastPlanningOf_(run.planning_json,plan.fy,run.annual_p50);
  appPointAssert_(rawPlanning && rawPlanning.method==='W_COMPONENT_EVENT_HALF_SHAPE_BLEND' && rawPlanning.provisional===true,'保存済みWの根拠を確認できません。');
  const seedRows=snap.tables.ENG_SHEETS.filter(r=>r.plan_id===plan.plan_id&&APP_FORECAST_SEED_SHEETS.indexOf(r.sheet)>=0).map(r=>r.sheet+':'+r.content_hash).sort();
  const seedHash=appSha256Hex_(seedRows.join('|')),oldSeed=appSha256Hex_(['forecast-seed-v1',seedHash,plan.time_zone||'',plan.locale||'',run.engine_version||'',run.engine_sha256||'',run.app_version||''].join('|'));
  appPointAssert_(run.seed_rule===APP_FORECAST_SEED_RULE && oldSeed===run.seed,'元の予測後に入力・設定が変わりました。');
  const history=appPointHistory_(plan,snap),baseRiskHash=appPointHash_({run:appPointCanonical_('FORECAST_RUNS',[run]),months:months.map(r=>appObjectToRow_(APP_TABLES.FORECAST_MONTHLY,r))}),meansHash=appPointHash_(rawPlanning.months.map(m=>m.mean));
  const binding={planId:plan.plan_id,clientId:plan.client_id,fy:Number(plan.fy),purpose:plan.purpose,state:plan.state,rowVersion:plan.row_version,timeZone:plan.time_zone,locale:plan.locale,baseRunId:run.run_id,baseRiskHash:baseRiskHash,
    basePlanningHash:appPointHash_(rawPlanning),meansHash:meansHash,historySha256:history.sha256,historySheetHash:history.sheetHash,seedInputHash:seedHash,globalContextHash:appPointGlobalContext_(snap),baseAsOf:run.as_of};
  return {binding:binding,hash:appPointHash_(binding),history:history.rows,rawPlanning:rawPlanning,months:months,run:run};
}
/** Accepted planning metadata only; invoked by the common planning parser. */
function appPointPlanningExtras_(value,out,fy) {
  const p=appPointPolicy_(out.method), integer=n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
  const half=[0,1].map(h=>out.months.slice(h*6,h*6+6).reduce((n,m)=>n+m.point,0));
  if(!p||value.version!=='HISTORY_MONTHLY_POINT_V2'||value.provisional!==true||value.validationStatus!=='in_progress'||
    value.pointPolicySha256!==p.policySha256||p.acceptedEngineSourceSha256s.indexOf(value.pointPolicySourceSha256)<0||
    !Array.isArray(value.halfTargets)||value.halfTargets.length!==2||!value.halfTargets.every((n,h)=>integer(n)&&n===half[h])||
    p.modes.indexOf(value.provisionalMode)<0||typeof value.provisionalRescue!=='string'||!(/^[A-Za-z0-9_]{1,120}$/).test(value.provisionalRescue)||
    !Array.isArray(out.historyYearsUsed)||!out.historyYearsUsed.length||!out.cleanHistoryStartYm)return null;
  const metadata=p.validateNative(value,fy);if(!metadata)return null;
  return Object.assign({provisional:true,validationStatus:'in_progress',pointPolicySha256:p.policySha256,pointPolicySourceSha256:value.pointPolicySourceSha256,
    halfTargets:half,provisionalMode:value.provisionalMode,provisionalRescue:value.provisionalRescue},metadata);
}
function appPointRevisionPayload_(raw, plan, run) {
  let v=raw;try{if(typeof v==='string')v=JSON.parse(v);}catch(e){return null;}
  const p=v&&appPointPolicy_(v.method);
  if(!p||!['FORECAST_POINT_REVISION_V1','FORECAST_POINT_REVISION_V2'].includes(v.version)||v.planId!==plan.plan_id||v.clientId!==plan.client_id||Number(v.fy)!==Number(plan.fy)||v.baseRunId!==run.run_id||
    v.policySha256!==p.policySha256||p.acceptedEngineSourceSha256s.indexOf(v.policySourceSha256)<0||!v.revisionId||!v.publicationId||!v.contextHash||!v.binding)return null;
  if(p.predecessorMethod){
    const b=v.predecessor;
    if(v.version!=='FORECAST_POINT_REVISION_V2'||!b||b.version!=='POINT_PREDECESSOR_V1'||b.method!==p.predecessorMethod||!b.revisionId||b.revisionId===v.revisionId||!b.publicationId||
      !['policySha256','policySourceSha256','actionHash','planningHash'].every(k=>typeof b[k]==='string'&&/^[a-f0-9]{64}$/.test(b[k])))return null;
  }else if(v.version!=='FORECAST_POINT_REVISION_V1'||v.predecessor!==undefined)return null;
  const planning=appForecastPlanningOf_(v.planning,plan.fy,run.annual_p50);
  if(!planning||planning.method!==v.method||planning.provisional!==true||planning.pointPolicySourceSha256!==v.policySourceSha256||appUtf8Bytes_(JSON.stringify(v))>18000)return null;
  return Object.assign({},v,{planning:planning});
}
/** Saved point policies must preserve the native annual and raw-W active-half economic guards. */
function appPointEconomicValid_(planning,c) {
  if(!planning||!c||!Array.isArray(c.history)||c.history.length!==48||!c.rawPlanning||!Array.isArray(c.rawPlanning.months)||c.rawPlanning.months.length!==12||!Array.isArray(planning.months)||planning.months.length!==12)return false;
  const points=planning.months.map(m=>m&&m.point),raw=c.rawPlanning.months.map(m=>m&&m.point),integer=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
  if(!points.every(integer)||!raw.every(integer)||c.history.some(r=>!r||!/^\d{4}-(0[1-9]|1[0-2])$/.test(r.ym)||typeof r.base!=='number'||!isFinite(r.base)||typeof r.spot!=='number'||!isFinite(r.spot)||!isFinite(r.base+r.spot)))return false;
  const total=points.reduce((a,b)=>a+b,0),net=c.history.slice(-12).reduce((a,r)=>a+r.base,0)+c.history.slice(-12).reduce((a,r)=>a+r.spot,0);
  if(!integer(total)||planning.annualTarget!==total||!isFinite(net)||(net>=1&&total===0)||(net<=0&&total!==0))return false;
  for(let h=0;h<2;h++){
    const rawHalf=raw.slice(h*6,h*6+6).reduce((a,b)=>a+b,0),pointHalf=points.slice(h*6,h*6+6).reduce((a,b)=>a+b,0);
    if(!integer(rawHalf)||!integer(pointHalf))return false;
    if(rawHalf>0&&c.history.some(r=>Math.floor(((Number(r.ym.slice(5,7))+8)%12)/6)===h&&r.base+r.spot>0)&&pointHalf===0)return false;
  }
  return true;
}
/** Raw context stays unchanged; a V2 predecessor is an immutable BB V1 row, not a current-active condition. */
function appPointRowMatchesContext_(row,p,c) {
  return row.action_id===p.revisionId&&row.engine_sha256===p.policySourceSha256&&p.contextHash===c.hash&&appPointHash_(p.binding)===appPointHash_(c.binding)&&row.input_hash===c.hash&&
    appPointHash_(p.planning.months.map(m=>m.mean))===c.binding.meansHash&&p.planning.annualRawP50===c.rawPlanning.annualRawP50&&appPointEconomicValid_(p.planning,c);
}
function appPointPredecessorValid_(p,plan,run,c,snap) {
  const policy=appPointPolicy_(p.method),b=p.predecessor,parentPolicy=b&&appPointPolicy_(b.method);
  if(!policy||!policy.predecessorMethod||!b||!parentPolicy||parentPolicy.predecessorMethod||b.method!==policy.predecessorMethod)return false;
  const rows=snap.tables.PLAN_ACTIONS.filter(r=>r.action_id===b.revisionId&&r.plan_id===plan.plan_id&&r.action===APP_POINT_REVISION_ACTION&&r.status==='DONE');
  if(rows.length!==1)return false;const row=rows[0],parent=appPointRevisionPayload_(row.result_json,plan,run);
  return !!parent&&parent.version==='FORECAST_POINT_REVISION_V1'&&parent.method===b.method&&parent.publicationId===b.publicationId&&parent.policySha256===b.policySha256&&parent.policySourceSha256===b.policySourceSha256&&
    appPointHash_(appObjectToRow_(APP_TABLES.PLAN_ACTIONS,row))===b.actionHash&&appPointHash_(parent.planning)===b.planningHash&&appPointRowMatchesContext_(row,parent,c);
}
function appPointCurrentPredecessor_(plan,run,c,snap,policy) {
  if(!policy.predecessorMethod)return null;
  const parentPolicy=appPointPolicy_(policy.predecessorMethod);appPointAssert_(parentPolicy&&!parentPolicy.predecessorMethod,'直前方式の契約が不正です。');
  const current=appPointRevisionResolve_(plan,run,c.months,snap),v=current.revision;
  appPointAssert_(v&&current.planning&&current.planning.method===policy.predecessorMethod,'期待する直前の月次予測が有効ではありません（既に別方式へ更新済みの場合も含みます）。');
  const rows=snap.tables.PLAN_ACTIONS.filter(r=>r.action_id===v.revisionId);appPointAssert_(rows.length===1,'直前改訂の行が一意ではありません。');
  return {planning:current.planning,reference:{version:'POINT_PREDECESSOR_V1',revisionId:v.revisionId,publicationId:v.publicationId,method:v.method,policySha256:v.policySha256,policySourceSha256:v.policySourceSha256,
    actionHash:appPointHash_(appObjectToRow_(APP_TABLES.PLAN_ACTIONS,rows[0])),planningHash:appPointHash_(current.planning)}};
}
function appPointRequirePredecessor_(plan,run,c,snap,policy,expected,ownIntent) {
  if(!policy.predecessorMethod){appPointAssert_(!expected,'不要な直前改訂が指定されています。');return null;}
  if(ownIntent){
    const own=snap.tables.PLAN_ACTIONS.filter(r=>r.action_id===ownIntent.action_id),active=appPointRevisionResolve_(plan,run,c.months,snap);
    if(own.length===1&&JSON.stringify(appObjectToRow_(APP_TABLES.PLAN_ACTIONS,own[0]))===JSON.stringify(appObjectToRow_(APP_TABLES.PLAN_ACTIONS,ownIntent))&&active.revision&&active.revision.revisionId===ownIntent.action_id)return null;
  }
  const current=appPointCurrentPredecessor_(plan,run,c,snap,policy);
  appPointAssert_(expected&&appPointHash_(expected)===appPointHash_(current.reference),'プレビュー後に直前の月次予測が変わりました。');return current;
}
/** Public-view resolver: no writes/model/learning calls; caller authorizes plan read. */
function appPointRevisionResolve_(plan, run, monthly, snap) {
  const raw=run?appForecastPlanningOf_(run.planning_json,plan.fy,run.annual_p50):null;
  const fallback={planning:raw,rawPlanning:raw,revision:null};
  if(!run||!appPlanIsMeasure_(plan)||!Object.keys(APP_POINT_APPROVED_POLICIES).length)return fallback;
  snap=snap||{tables:{PLAN_ACTIONS:appReadTable_('PLAN_ACTIONS')}};
  const candidates=snap.tables.PLAN_ACTIONS.filter(r=>r.plan_id===plan.plan_id&&r.action===APP_POINT_REVISION_ACTION&&r.status==='DONE').slice()
    .sort((a,b)=>String(b.finished_at).localeCompare(String(a.finished_at))||String(b.action_id).localeCompare(String(a.action_id)))
    .map(row=>({row:row,p:appPointRevisionPayload_(row.result_json,plan,run)})).filter(x=>x.p);
  if(!candidates.length)return fallback; // No indexed history read or global-context work for old plans.
  if(!snap.history)Object.assign(snap,appPointSnapshot_(snap));
  let context;try{context=appPointContext_(plan,run,snap);}catch(e){return fallback;}
  const valid=candidates.filter(x=>appPointRowMatchesContext_(x.row,x.p,context));
  const children=valid.filter(x=>x.p.predecessor&&appPointPredecessorValid_(x.p,plan,run,context,snap));
  // A valid child beats its parent even in the same timestamp second. Conflicting children fail back to the valid legacy BB.
  const selected=children.length===1?children[0]:valid.filter(x=>!x.p.predecessor)[0];if(!selected)return fallback;
  const row=selected.row,p=selected.p;
  return {planning:p.planning,rawPlanning:raw,revision:Object.assign({revisionId:p.revisionId,publicationId:p.publicationId,baseRunId:p.baseRunId,method:p.method,publishedAt:row.finished_at,
    historySha256:p.binding.historySha256,policySha256:p.policySha256,policySourceSha256:p.policySourceSha256},p.predecessor?{predecessorRevisionId:p.predecessor.revisionId,predecessorPlanningHash:p.predecessor.planningHash}:{})};
}
function appPointIdle_(allowPending) { appOfflineRequireIdle_(allowPending===true);appProvisionalRequireNoBulk_();const st=appProvisionalState_();appPointAssert_(!st||!st.active&&!st.current,'一括処理が進行中です。'); }
function appPointHead_() { const raw=appProps_().getProperty(APP_POINT_REVISION_HEAD);return raw?JSON.parse(raw):null; }
function appPointSaveState_(s) { const file=appOfflineWriteFile_('Point_publication_'+s.publicationId,s);appProps_().setProperty(APP_POINT_REVISION_HEAD,JSON.stringify({publicationId:s.publicationId,fileId:file.fileId,sha256:file.sha256}));return s; }
function appPointLoadState_(ctx,id) { const h=appPointHead_();appPointAssert_(h&&h.publicationId===id,'更新の控えが見つかりません。');const s=appOfflineReadFile_(h.fileId,h.sha256);appPointAssert_(s.actor===ctx.actor&&s.version==='POINT_PUBLICATION_V1','更新の所有者・形式が違います。');return s; }
function appPointEngine_(actor) { return appLegacyEngine_(appLegacyServices_({}, {asOfMs:Date.now(),seed:'point-only-no-random',actor:actor})); }
/** Fixed metadata contracts. These functions do not approve a policy by themselves. */
function appPointValidateSupportZ_(v,fy) {
  return Array.isArray(v.provisionalWeights)&&v.provisionalWeights.length===0&&Array.isArray(v.provisionalFolds)&&v.provisionalFolds.length===0 ?
    {provisionalWeights:[],provisionalFolds:[]} : null;
}
function appPointValidateGuardedAA_(v,fy) {
  const w=v.provisionalWeights,f=v.provisionalFolds;
  if(!Array.isArray(w)||w.length!==2||!w.every(n=>n===0||n===1)||!Array.isArray(f)||[0,2].indexOf(f.length)<0||
    !f.every((y,i,a)=>Number.isInteger(y)&&y>=2024&&y<fy&&(!i||y>a[i-1]))||(!f.length&&w.some(n=>n!==0)))return null;
  return {provisionalWeights:w.slice(),provisionalFolds:f.slice()};
}
function appPointValidateCombination_(v,fy) {
  return Array.isArray(v.provisionalWeights)&&v.provisionalWeights.length===0&&Array.isArray(v.provisionalFolds)&&v.provisionalFolds.length===0 ? {provisionalWeights:[],provisionalFolds:[]} : null;
}
function appPointNormalizeCombination_(q) {
  return {method:q.method,points:q.points,total:q.total,active:q.active,net12:q.net12,years:q.profileYears,
    halfTargets:q.halfTargets,mode:q.mode,rescue:q.rescue||'none',wPoints:q.wPoints12,weights:[],folds:[]};
}
function appPointValidatePrequential_(v,fy) {
  const w=v.provisionalWeights,f=v.provisionalFolds;
  if(!Array.isArray(w)||w.length!==12||!w.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0)||!Array.isArray(f)||[0,2].indexOf(f.length)<0||
    !f.every((y,i,a)=>Number.isInteger(y)&&y>=2024&&y<fy&&(!i||y>a[i-1]))||(!f.length&&w.some(n=>n!==1))||
    (v.provisionalMode==='prequential_amount_selection'&&f.length!==2))return null;
  return {provisionalWeights:w.slice(),provisionalFolds:f.slice()};
}
function appPointNormalizePrequential_(q) {
  return {method:q.method,points:q.points,total:q.total,active:q.active,net12:q.net12,years:q.profileYears,
    halfTargets:q.halfTargets,mode:q.mode,rescue:q.rescue||'none',wPoints:q.completeBB.baseWPoints,predecessorPoints:q.completeBB.points,weights:q.weights,folds:q.selectedFoldFYs};
}
/** Stamp only a CURRENT approved native engine result, then use the common strict parser. */
function appPointNativePlanning_(raw,engine,fy,annualRawP50) {
  const p=raw&&appPointPolicy_(raw.method);if(!p)return raw;
  if(!engine||(engine.sourceSha256||engine.SOURCE_SHA256)!==p.engineSourceSha256||!p.validateNative(raw,Number(fy)))return null;
  const stamped=Object.assign({},raw,{pointPolicySha256:p.policySha256,pointPolicySourceSha256:p.engineSourceSha256});
  return appForecastPlanningOf_(stamped,fy,annualRawP50);
}
/** Z is a non-approved reference adapter. AA needs only a separate fixed normalizer. */
function appPointNormalizeSupportZ_(q) {
  return {method:q.method,points:q.points,total:q.total,active:q.active,net12:q.net12,years:q.profileYears,
    halfTargets:q.halfTargets,mode:q.mode,rescue:q.rescue||'none',wPoints:q.wPoints12,weights:[],folds:[]};
}
function appPointNormalizeGuardedAA_(q) {
  return {method:q.method,points:q.points,total:q.total,active:q.active,net12:q.net12,years:q.profileYears,
    halfTargets:q.halfTargets,mode:q.mode,rescue:q.rescue||'none',wPoints:q.wPoints12,weights:q.weights,folds:q.selectedFoldFYs};
}
function appPointPlanning_(q,raw,fy,method,policy) {
  const integer=n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0,total=q.total;
  appPointAssert_(q.method===method&&Array.isArray(q.points)&&q.points.length===12&&q.points.every(integer)&&integer(total)&&q.points.reduce((a,b)=>a+b,0)===total&&
    Array.isArray(q.years)&&q.years.length>=1&&q.years.length<=3&&q.years.every((y,i,a)=>Number.isInteger(y)&&y>=2022&&y<fy&&(!i||y>a[i-1]))&&
    typeof q.active==='boolean'&&typeof q.net12==='number'&&isFinite(q.net12)&&(!q.active?total===0:true)&&
    (!(q.net12>=1)||total>0)&&policy.modes.indexOf(q.mode)>=0,'計算結果の点・年額・活動条件が不正です。');
  const half=[0,1].map(h=>q.points.slice(h*6,h*6+6).reduce((n,v)=>n+v,0));
  appPointAssert_(Array.isArray(q.halfTargets)&&q.halfTargets.length===2&&q.halfTargets.every((v,h)=>v===half[h]),'半期額が一致しません。');
  const p={version:'HISTORY_MONTHLY_POINT_V2',applied:true,method:method,provisional:true,validationStatus:'in_progress',pointPolicySha256:policy.policySha256,pointPolicySourceSha256:policy.engineSourceSha256,
    annualRawP50:raw.annualRawP50,annualTarget:total,annualBasis:'sum_monthly_points',trainingThroughYm:fy+'/03',
    cleanHistoryStartYm:q.years[0]+'/04',historyYearsUsed:q.years.slice(),halfTargets:half,provisionalWeights:q.weights,provisionalFolds:q.folds,provisionalMode:q.mode,provisionalRescue:q.rescue,inactive:!q.active,
    months:raw.months.map((m,i)=>({ym:m.ym,point:q.points[i],share:total>0?q.points[i]/total:0,mean:m.mean}))};
  const checked=appForecastPlanningOf_(p,fy,raw.annualRawP50);appPointAssert_(checked&&checked.method===method&&checked.provisional===true,'改訂の月次計画を検証できません。');return checked;
}
/** Owner only, durable roster first; at most4 pure computations per invocation. */
function appPointPreview_(ctx,input) {
  ctx=appPointOwner_(ctx);input=input||{};const started=Date.now();
  return appWithLock_(()=>{
    appPointIdle_();appStoreForget_();const snap=appPointSnapshot_(!input.publicationId?{engRows:appReadTable_('ENG_ROWS')}:{}),engine=appPointEngine_(ctx.actor),method=String(input.method||''),policy=appPointPolicy_(method);
    appPointAssert_(policy&&policy.publishEnabled!==false&&input.policySha256===policy.policySha256&&engine.SOURCE_SHA256===policy.engineSourceSha256&&typeof engine[policy.entrypoint]==='function','方式が未承認か計算APIがありません。');
    let s;if(input.publicationId)s=appPointLoadState_(ctx,String(input.publicationId));else{
      const prior=appPointHead_();if(prior)appPointAssert_(appPointLoadState_(ctx,prior.publicationId).status==='DONE','前のプレビューまたは適用を先に完了してください。');
      const fy=appProvisionalFy_(input);appRequireOpenYear_(fy);const all=snap.tables.PLANS.filter(p=>Number(p.fy)===fy&&p.state!=='ARCHIVED');
      s={version:'POINT_PUBLICATION_V1',publicationId:appId_('PPR'),actor:ctx.actor,fy:fy,method:method,policySha256:input.policySha256,engineVersion:engine.VERSION,engineSourceSha256:engine.SOURCE_SHA256,webSha256:engine.WEB_SOURCE_SHA256,appVersion:APP_VERSION,globalContextHash:appPointGlobalContext_(snap),createdAt:appNowIso_(),status:'PREVIEW',entries:all.filter(appPlanIsMeasure_).map(p=>{const r=appPointLatest_(p.plan_id,snap),c=appPointContext_(p,r,snap),prior=appPointCurrentPredecessor_(p,r,c,snap,policy),entry={planId:p.plan_id,clientId:p.client_id,baseRunId:r.run_id,originalContextHash:c.hash,originalBinding:c.binding,status:'PENDING'};if(prior)entry.predecessor=prior.reference;return entry;}),excludedNormal:all.filter(p=>!appPlanIsMeasure_(p)).map(p=>({planId:p.plan_id,reason:'NORMAL_PRESERVED'}))};
      appPointAssert_(s.entries.length>0&&s.entries.length<=100,'対象数を確認してください。');appPointSaveState_(s);
    }
    appPointAssert_(s.status==='PREVIEW'&&s.method===method&&s.policySha256===input.policySha256&&s.engineSourceSha256===engine.SOURCE_SHA256&&s.appVersion===APP_VERSION&&s.globalContextHash===appPointGlobalContext_(snap),'方式・版・更新状態が変わりました。');
    let done=0;const newFiles=[];
    for(let i=0;i<s.entries.length&&done<APP_POINT_REVISION_LIMIT;i++){
      const e=s.entries[i];if(e.status!=='PENDING')continue;if(Date.now()-started+APP_POINT_REVISION_RESERVE_MS>APP_POINT_REVISION_BUDGET_MS)break;
      const plan=snap.tables.PLANS.filter(p=>p.plan_id===e.planId)[0],run=appPointLatest_(e.planId,snap);appPointAssert_(run&&run.run_id===e.baseRunId,'基準の予測が変わりました。');
      const c=appPointContext_(plan,run,snap);appPointAssert_(c.hash===e.originalContextHash&&appPointHash_(c.binding)===appPointHash_(e.originalBinding),'名簿固定後に入力・履歴が変わりました。');const preceding=appPointRequirePredecessor_(plan,run,c,snap,policy,e.predecessor);const proof=engine[policy.entrypoint](c.history,s.fy),q=policy.normalize(proof);
      const net=c.history.slice(-12).reduce((a,r)=>a+r.base,0)+c.history.slice(-12).reduce((a,r)=>a+r.spot,0);
      appPointAssert_(isFinite(net)&&q.net12===net&&q.active===(net>0),'計算結果と対象履歴の活動条件が違います。');
      appPointAssert_(q.method===method&&JSON.stringify(q.wPoints)===JSON.stringify(c.rawPlanning.months.map(m=>m.point)),'保存Wと履歴からのWが一致しません。');
      if(preceding)appPointAssert_(Array.isArray(q.predecessorPoints)&&JSON.stringify(q.predecessorPoints)===JSON.stringify(preceding.planning.months.map(m=>m.point)),'履歴からの直前方式と現在の保存点が一致しません。');
      const planning=appPointPlanning_(q,c.rawPlanning,s.fy,method,policy);appPointAssert_(appPointEconomicValid_(planning,c),'計算結果が年額・半期の活動条件を満たしません。');
      const proofFile=appOfflineWriteFile_('Point_proof_'+s.publicationId+'_'+e.planId,Object.assign({version:'POINT_PREVIEW_PROOF_V1',publicationId:s.publicationId,planId:e.planId,fy:s.fy,method:method,policySha256:s.policySha256,policySourceSha256:s.engineSourceSha256,history:c.history,fullq:proof,rawRun:appStripRow_(run),monthly:c.months.map(appStripRow_),binding:c.binding,contextHash:c.hash,rawPlanning:c.rawPlanning,planning:planning},preceding?{predecessor:e.predecessor,precedingPlanning:preceding.planning}:{}));
      e.proofFileRef=proofFile;newFiles.push({planId:e.planId,file:proofFile}); // Durable full evidence before PREVIEWED/state head.
      e.status='PREVIEWED';e.contextHash=c.hash;e.binding=c.binding;e.planning=planning;e.policySha256=s.policySha256;e.revisionId='PPT-'+appSha256Hex_(s.publicationId+'|'+e.planId).slice(0,32);e.policySummary={mode:q.mode,rescue:q.rescue,active:q.active,net12:q.net12,proofSha256:appPointHash_(proof)};done++;
      appPointSaveState_(s);
    }
    if(s.entries.every(e=>e.status==='PREVIEWED')){s.status='READY';s.previewSha256=appPointPreviewDigest_(s);appPointSaveState_(s);}
    return {publicationId:s.publicationId,status:s.status,total:s.entries.length,previewed:s.entries.filter(e=>e.status==='PREVIEWED').length,excludedNormal:s.excludedNormal.length,computedThisCall:done,previewSha256:s.previewSha256||'',stateFile:appPointHead_(),newFiles:newFiles,proofFiles:s.entries.filter(e=>e.proofFileRef).map(e=>({planId:e.planId,file:e.proofFileRef})),modelOnly:true,mcCalls:0};
  });
}
/** Stable approved READY content; statuses and exact journal receipts are intentionally excluded. */
function appPointPreviewDigest_(s) {
  return appPointHash_({publicationId:s.publicationId,method:s.method,policySha256:s.policySha256,sourceSha256:s.engineSourceSha256,
    entries:s.entries.map(e=>({planId:e.planId,baseRunId:e.baseRunId,contextHash:e.contextHash,planning:e.planning,proofFileRef:e.proofFileRef,predecessor:e.predecessor||null}))});
}
function appPointMakeAction_(ctx,s,e) {
  const now=appNowIso_(),p={version:e.predecessor?'FORECAST_POINT_REVISION_V2':'FORECAST_POINT_REVISION_V1',publicationId:s.publicationId,revisionId:e.revisionId,planId:e.planId,clientId:e.clientId,fy:s.fy,baseRunId:e.baseRunId,method:s.method,policySha256:s.policySha256,policySourceSha256:s.engineSourceSha256,
    contextHash:e.contextHash,binding:e.binding,planning:e.planning,policySummary:e.policySummary,computedAt:s.createdAt};
  if(e.predecessor)p.predecessor=e.predecessor;
  return {action_id:e.revisionId,plan_id:e.planId,action:APP_POINT_REVISION_ACTION,status:'DONE',engine_version:s.engineVersion,engine_sha256:s.engineSourceSha256,web_sha256:s.webSha256,seed:'',as_of:now,input_hash:e.contextHash,changed_sheets_json:[],result_json:p,started_at:now,finished_at:now,actor_email:ctx.actor};
}
function appPointRecoverOwn_(ctx,s) {
  const pending=appJournalPending_();if(!pending)return;
  const entries=s.entries.filter(e=>e.actionRow&&e.planId===pending.planId&&pending.label==='月次点改訂:'+s.publicationId+':'+e.revisionId);appPointAssert_(entries.length===1,'別の保存が途中です。');
  const e=entries[0],body=JSON.parse(DriveApp.getFileById(pending.fileId).getBlob().getDataAsString()),ops=body.ops||[];
  appPointAssert_(body.actor===ctx.actor&&body.planId===e.planId&&body.label===pending.label&&ops.length===1&&ops[0].table==='PLAN_ACTIONS'&&ops[0].mode==='ensure'&&Object.keys(ops[0]).sort().join(',')==='mode,rows,table'&&ops[0].rows.length===1&&JSON.stringify(appObjectToRow_(APP_TABLES.PLAN_ACTIONS,ops[0].rows[0]))===JSON.stringify(appObjectToRow_(APP_TABLES.PLAN_ACTIONS,e.actionRow)),'保存の控えが固定した改訂と違います。');
  appStoreForget_();const snap=appPointSnapshot_(),p=snap.tables.PLANS.filter(p=>p.plan_id===e.planId)[0],r=appPointLatest_(e.planId,snap),c=appPointContext_(p,r,snap);appPointAssert_(c.hash===e.contextHash&&appPointEconomicValid_(e.planning,c),'保存の中断後に対象または活動条件が変わりました。');const intent=appPointRevisionPayload_(e.actionRow.result_json,p,r);appPointAssert_(intent&&appPointEconomicValid_(intent.planning,c),'保存の控えが活動条件を満たしません。');appPointRequirePredecessor_(p,r,c,snap,appPointPolicy_(s.method),e.predecessor,e.actionRow);appJournalRecover_(ctx);
}
/** Journal only the exact reserved action row; all data/risk/input/budget/learning tables stay untouched. */
function appPointApply_(ctx,input) {
  ctx=appPointOwner_(ctx);input=input||{};const started=Date.now();
  return appWithLock_(()=>{
    appPointIdle_(true);let s=appPointLoadState_(ctx,String(input.publicationId||''));appPointAssert_(['READY','APPLYING','DONE'].indexOf(s.status)>=0,'全件のプレビューが必要です。');
    appPointAssert_(s.method===input.method&&appPointPolicy_(s.method)&&appPointPolicy_(s.method).publishEnabled!==false&&s.policySha256===input.policySha256&&s.policySha256===appPointPolicy_(s.method).policySha256&&s.engineSourceSha256===appPointPolicy_(s.method).engineSourceSha256&&appPointEngine_(ctx.actor).SOURCE_SHA256===s.engineSourceSha256&&s.appVersion===APP_VERSION&&input.previewSha256===s.previewSha256&&s.previewSha256===appPointPreviewDigest_(s)&&/^[a-f0-9]{64}$/.test(s.previewSha256||''),'方式・版が変わりました。');
    appPointRecoverOwn_(ctx,s);appStoreForget_();const snap=appPointSnapshot_();let applied=0;
    for(let i=0;i<s.entries.length&&applied<APP_POINT_REVISION_LIMIT;i++){
      const e=s.entries[i];if(e.status==='DONE')continue;if(Date.now()-started+APP_POINT_REVISION_RESERVE_MS>APP_POINT_REVISION_BUDGET_MS)break;
      const plan=snap.tables.PLANS.filter(p=>p.plan_id===e.planId)[0],run=appPointLatest_(e.planId,snap),c=appPointContext_(plan,run,snap);
      appPointAssert_(run.run_id===e.baseRunId&&c.hash===e.contextHash&&appPointHash_(c.binding)===appPointHash_(e.binding)&&appPointEconomicValid_(e.planning,c),'プレビュー後に計画・履歴・入力・学習または活動条件が変わりました。');
      if(!e.actionRow){e.actionRow=appPointMakeAction_(ctx,s,e);s.status='APPLYING';appPointSaveState_(s);} // Durable exact intent before native journal.
      const old=snap.tables.PLAN_ACTIONS.filter(r=>r.action_id===e.revisionId);appPointAssert_(old.length<=1,'改訂IDが重複しています。');
      if(old.length)appPointAssert_(JSON.stringify(appObjectToRow_(APP_TABLES.PLAN_ACTIONS,old[0]))===JSON.stringify(appObjectToRow_(APP_TABLES.PLAN_ACTIONS,e.actionRow)),'同じ改訂IDの内容が違います。');
      else {appPointRequirePredecessor_(plan,run,c,snap,appPointPolicy_(s.method),e.predecessor,e.actionRow);appJournalRun_(ctx,'月次点改訂:'+s.publicationId+':'+e.revisionId,e.planId,[{table:'PLAN_ACTIONS',mode:'ensure',rows:[e.actionRow]}]);}
      appStoreForget_('PLAN_ACTIONS');snap.tables.PLAN_ACTIONS=appReadTable_('PLAN_ACTIONS');
      const active=appPointRevisionResolve_(plan,appPointLatest_(e.planId,snap),null,snap);
      appPointAssert_(active.revision&&active.revision.revisionId===e.revisionId&&appPointHash_(active.planning)===appPointHash_(e.planning),'改訂の保存を読み戻せません。');
      e.status='DONE';applied++;appPointSaveState_(s);
    }
    if(s.entries.every(e=>e.status==='DONE')){s.status='DONE';appPointSaveState_(s);}
    return {publicationId:s.publicationId,status:s.status,total:s.entries.length,done:s.entries.filter(e=>e.status==='DONE').length,appliedThisCall:applied,rawForecastWrites:0};
  });
}
function appPointReadback_(ctx,input) {
  appPointOwner_(ctx);input=input||{};return appWithLock_(()=>{appPointIdle_();appStoreForget_();const fy=appProvisionalFy_(input),snap=appPointSnapshot_({engRows:appReadTable_('ENG_ROWS')});
  const rows=snap.tables.PLANS.filter(p=>Number(p.fy)===fy&&p.state!=='ARCHIVED').map(plan=>{const run=appPointLatest_(plan.plan_id,snap),monthly=run?snap.tables.FORECAST_MONTHLY.filter(r=>r.plan_id===plan.plan_id&&r.run_id===run.run_id):[],r=appPointRevisionResolve_(plan,run,monthly,snap);return{planId:plan.plan_id,clientId:plan.client_id,measure:appPlanIsMeasure_(plan),run:run?appStripRow_(run):null,monthly:monthly.map(appStripRow_),rawPlanning:r.rawPlanning,activePlanning:r.planning,revision:r.revision};});
  const summary={roster:rows.length,activeRevisions:rows.filter(r=>r.revision).length};
  const payload={format:'POINT_REVISION_READBACK_V1',at:appNowIso_(),fy:fy,rows:rows,summary:summary,modelCalls:0,storeWrites:0,
    rawRiskPreservationEvidence:'Compare exact before/after native FORECAST_RUNS/MONTHLY and means hashes; this readback alone does not prove preservation.'};
  const file=appOfflineWriteFile_('Point_readback_'+fy,payload);
  return {format:payload.format,fy:fy,summary:summary,file:file,modelCalls:0,storeWrites:0,privateEvidenceFileWrites:1};
  });
}
