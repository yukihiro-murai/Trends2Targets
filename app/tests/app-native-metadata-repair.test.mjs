#!/usr/bin/env node
/** Synthetic-only owner-operation regression. No live Drive, credentials or production data. */
import assert from 'node:assert/strict';
import { OWNER, MEMBER, setUpEnv } from './gas-mock.mjs';

function task(env, action, input = {}) {
  env.props.OWNER_TASK = JSON.stringify({ action, ...input });
  return env.call('apiOwnerTask()').result;
}
function snapshot(env) {
  return {
    locale: env.data().getSpreadsheetLocale(), tz: env.data().getSpreadsheetTimeZone(),
    sheets: env.data().getSheets().map(sh => {
      const rows = sh.getLastRow(), cols = sh.getLastColumn();
      const r = rows && cols ? sh.getRange(1, 1, rows, cols) : null;
      return { name: sh.getName(), rows, cols, values: r ? r.getValues() : [], formulas: r ? r.getFormulas() : [], formats: r ? r.getNumberFormats() : [] };
    }),
  };
}
function fixture() {
  const env = setUpEnv();
  // File.setContent is a real Drive File API, absent in the shared minimal mock. Add only that missing mock behavior.
  const getFolder = env.ctx.DriveApp.getFolderById;
  const wrapped = new Set();
  env.ctx.DriveApp.getFolderById = id => {
    const folder = getFolder(id);
    if (!wrapped.has(folder)) {
      wrapped.add(folder);
      const create = folder.createFile;
      folder.createFile = (...args) => {
        const file = create(...args);
        file.setContent = text => { file.content = String(text); return file; };
        return file;
      };
    }
    return folder;
  };
  env.run("appToday_=function(){return '2026-10-21'}");
  function plan(name) {
    const sheets = { CONFIG: { values: [['項目','値'],['[必須] メーカー名（外部集計キー）',name],['[必須] 予測年度FY（YYYY）',2026],['[必須] 担当者（カンマ区切り）','合成担当']] }, OUTPUT: { values: [['合成の予測']] } };
    for (const n of ['PRODUCT','CLIENT','OPINIONS','DEV_SPOT','SALES_INPUT','EVAL_COMPARE_MONTHLY','PROCESS_STATUS']) sheets[n] = { values: [env.call('APP_ENGINE_SHEETS.' + n + '.header')] };
    return env.seedPlan(env.makeBook(name,sheets));
  }
  const planId = plan('合成修復製薬'), protectedId = plan('合成保護製薬');
  task(env,'seedDummyLanding',{fy:2026});
  // Already persisted business rows with outdated metadata, matching the A2 failure; create no fake rows during repair.
  env.run("appWithLock_(()=>appPatchRow_('ENG_SHEETS',{plan_id:__id,sheet:'EVAL_COMPARE_MONTHLY'},{last_row:'1',content_hash:'0'.repeat(64)},'fixture'))",{__id:planId});
  const ids = [planId];
  const preview = () => task(env,'previewNativeMetadataRepair',{planIds:ids});
  const copy = () => env.run('appWithLock_(()=>DriveApp.getFileById(__id).makeCopy("Trends2Targets_Data_Backup_SYNTHETIC",DriveApp.getFolderById(__folder)).getId())',{__id:env.props.APP_DATA_SPREADSHEET_ID,__folder:env.props.APP_FOLDER_ID});
  const apply = (p = preview(), backupId = copy()) => task(env,'applyNativeMetadataRepair',{planIds:ids,previewSha256:p.previewSha256,backupId});
  const rollback = repairFileId => task(env,'rollbackNativeMetadataRepair',{repairFileId});
  return {env,planId,protectedId,preview,copy,apply,rollback};
}
const repairFiles = env => Object.values(env.files).filter(f => f.name && f.name.startsWith('Trends2Targets_MetadataRepair_'));

// Preview reads only. Apply changes just the allowlisted metadata and retains exact before/after proof for a full rollback.
{
  const f = fixture(), { env, planId, protectedId } = f;
  const before = snapshot(env), count = repairFiles(env).length;
  const p = f.preview();
  assert.deepEqual(snapshot(env),before);
  assert.equal(repairFiles(env).length,count);
  assert.equal(p.plans,1);assert.equal(p.checkedSheets,3);assert.equal(p.changedSheets,1);
  assert.equal(p.metadataOnly,true);assert.match(p.previewSha256,/^[a-f0-9]{64}$/);
  assert.equal(f.preview().previewSha256,p.previewSha256,'preview is independent of request time/id');
  const backupId = f.copy();
  const copyBook = env.sheetsById[backupId];
  assert.ok(copyBook && backupId !== env.props.APP_DATA_SPREADSHEET_ID);
  const lockSeen=[];
  for (const book of [env.data(),copyBook]) {
    const old=book.getSheets;book.getSheets=()=>{lockSeen.push(env.state.lockHeld);return old();};
  }
  const inputHash=env.call('appPlanInputHash_(__id)',{__id:planId});
  const forecastHash=env.call('appForecastInputHash_(__id)',{__id:planId});
  const result = f.apply(p,backupId);
  assert.ok(lockSeen.length>=3 && lockSeen.every(Boolean),'before/backup/after proofs run inside lock');
  assert.equal(result.changedSheets,1);assert.equal(result.changedPlans,1);assert.equal(result.metadataOnly,true);
  assert.equal(result.checkedTables,result.preservedTables+1);
  assert.equal(result.backupId,backupId);
  const after=snapshot(env);
  for (const sh of before.sheets) {
    const now=after.sheets.find(s=>s.name===sh.name);
    if(sh.name!=='ENG_SHEETS')assert.deepEqual(now,sh,'all rows/types/formulas/formats preserved: '+sh.name);
    else {
      const h=sh.values[0],pi=h.indexOf('plan_id'),si=h.indexOf('sheet');
      const changed=[];
      for(let r=0;r<sh.values.length;r++)for(let c=0;c<h.length;c++)if(sh.values[r][c]!==now.values[r][c])changed.push([r,c]);
      assert.ok(changed.length>0);
      const allowed=new Set(['last_row','last_column','max_rows','max_columns','content_hash','updated_at','updated_by']);
      for(const [r,c] of changed){assert.equal(sh.values[r][pi],planId);assert.equal(sh.values[r][si],'EVAL_COMPARE_MONTHLY');assert.ok(allowed.has(h[c]));}
      assert.deepEqual(now.values.filter(r=>r[pi]===protectedId),sh.values.filter(r=>r[pi]===protectedId));
      assert.deepEqual(now.formulas,sh.formulas);assert.deepEqual(now.formats,sh.formats);
    }
  }
  assert.notEqual(env.call('appPlanInputHash_(__id)',{__id:planId}),inputHash);
  assert.equal(env.call('appForecastInputHash_(__id)',{__id:planId}),forecastHash);
  for(const k of Object.keys(env.cache))delete env.cache[k];
  assert.equal(env.call('apiPlanView(__in)',{__in:{planId}}).plan.planId,planId,'cold view after repair');
  const body=JSON.parse(env.files[result.repairFileId].content);
  assert.equal(body.status,'VERIFIED');assert.equal(body.kind,'NATIVE_METADATA_REPAIR_V1');
  assert.equal(body.entries.length,1);assert.equal(body.entries[0].planId,planId);assert.equal(body.entries[0].sheet,'EVAL_COMPARE_MONTHLY');
  const noChange=f.apply(f.preview(),backupId);assert.equal(noChange.unchanged,true);assert.equal(noChange.changedSheets,0);
  assert.equal(repairFiles(env).length,count+1,'no second repair file for no-op');
  const rolled=f.rollback(result.repairFileId);assert.equal(rolled.restored,true);assert.equal(rolled.metadataOnly,true);
  assert.deepEqual(snapshot(env),before,'rollback restores original complete book state');
  assert.equal(JSON.parse(env.files[result.repairFileId].content).status,'ROLLED_BACK');
  assert.equal(f.rollback(result.repairFileId).changedSheets,0,'a repeated rollback confirms the unchanged original book');
}

// Owner-only and explicit allowlists; malformed task requests cannot change the data book.
{
  const f=fixture(),before=snapshot(f.env);
  for(const planIds of [[],[f.planId,f.planId],['bad-id']])assert.throws(()=>task(f.env,'previewNativeMetadataRepair',{planIds}));
  f.env.as(MEMBER);assert.throws(()=>f.preview(),/所有者|権限/);f.env.as(OWNER);
  assert.deepEqual(snapshot(f.env),before);
  const p=f.preview();
  assert.throws(()=>task(f.env,'applyNativeMetadataRepair',{planIds:[f.planId],previewSha256:p.previewSha256,backupId:f.env.props.APP_DATA_SPREADSHEET_ID}),/データ本体をバックアップ/);
  assert.deepEqual(snapshot(f.env),before);
}

// Bad backup: changed value, cell type, number format, locale and timezone are all rejected before metadata writes.
for(const alter of [
  (book)=>{book.getSheetByName('CLIENTS').rows[1][1]='退避版だけ変えた値';},
  (book)=>{book.getSheetByName('CLIENTS').rows[1][1]=7;},
  (book)=>{book.getSheetByName('CLIENTS').fmts[0][0]='0.00';},
  (book)=>book.setSpreadsheetLocale('en_US'),
  (book)=>book.setSpreadsheetTimeZone('UTC'),
]) {
  const f=fixture(),p=f.preview(),backupId=f.copy();alter(f.env.sheetsById[backupId]);
  const before=snapshot(f.env),count=repairFiles(f.env).length;
  assert.throws(()=>f.apply(p,backupId),/退避版と現在の全表/);
  assert.deepEqual(snapshot(f.env),before);assert.equal(repairFiles(f.env).length,count);
}

// A changed persisted target row invalidates the preview even when metadata was not updated by that edit.
{
  const f=fixture(),p=f.preview(),backupId=f.copy();
  f.env.run("appWithLock_(()=>{const r=appReadPlanTable_('ENG_EVAL_COMPARE_MONTHLY',__id)[0];appPatchRow_('ENG_EVAL_COMPARE_MONTHLY',{plan_id:__id,seq:r.seq},{actual_total:'123456'},'fixture');})",{__id:f.planId});
  const before=snapshot(f.env);
  assert.throws(()=>f.apply(p,backupId),/確認後に保存状態が変わりました/);
  assert.deepEqual(snapshot(f.env),before);
}

// Every active state blocks apply, including unrelated jobs; a frozen target fiscal year is never repaired.
for(const block of ['queued','running','bulk','journal','frozen']) {
  const f=fixture(),p=f.preview(),backupId=f.copy();
  if(block==='queued'||block==='running')f.env.props.APP_JOB_FIXTURE=JSON.stringify({id:'FIXTURE',status:block.toUpperCase(),createdAt:'2026-10-21T00:00:00Z'});
  if(block==='bulk')f.env.props.APP_BULK_STATE=JSON.stringify({active:true});
  if(block==='journal')f.env.props.APP_WRITE_JOURNAL=JSON.stringify({id:'JNL-fixture',fileId:'missing',label:'fixture'});
  if(block==='frozen')f.env.run("appWithLock_(()=>appInsertRows_('YEAR_CLOSURES',[{fy:'2026',state:'CLOSED',file_id:'fixture',snapshot_sha256:'0'.repeat(64),plan_count:1,row_count:1,bytes:1,closed_at:'2026-10-21',closed_by:__owner}]))",{__owner:OWNER});
  const before=snapshot(f.env),count=repairFiles(f.env).length;
  assert.throws(()=>f.apply(p,backupId),/処理|保存|締め済み/,'block '+block);
  assert.deepEqual(snapshot(f.env),before,'blocked apply is read-only: '+block);
  assert.equal(repairFiles(f.env).length,count);
}

// Rollback refuses to overwrite any later real data edit and leaves its verified repair proof available.
{
  const f=fixture(),r=f.apply();
  f.env.run("appWithLock_(()=>appPatchRow_('PLANS',{plan_id:__id},{note:'修復後に保存した人のメモ'},'fixture'))",{__id:f.protectedId});
  const before=snapshot(f.env);
  assert.throws(()=>f.rollback(r.repairFileId),/修復後にデータが変わっています/);
  assert.deepEqual(snapshot(f.env),before);assert.equal(JSON.parse(f.env.files[r.repairFileId].content).status,'VERIFIED');
}

// Matrix proof distinguishes raw types and formulas even when their displayed/evaluated value is identical.
{
  const f=fixture(),base={rows:1,cols:1,values:[[7]],formulas:[['']],formats:[['0.00']]};
  const hash=x=>f.env.call('appNativeMetaMatrixHash_(__state)',{__state:x});
  assert.notEqual(hash(base),hash({...base,values:[['7']]}));
  assert.notEqual(hash(base),hash({...base,formulas:[['=3+4']]}));
  assert.notEqual(hash(base),hash({...base,formats:[['0']]}));
}
console.log('app-native-metadata-repair: preview/apply/copy proof, allowlisted metadata-only writes, cold view, blocked states and guarded rollback PASS');
