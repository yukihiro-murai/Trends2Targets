#!/usr/bin/env node
/** Synthetic-only regression for changing clocks and interrupted repair-manifest finalization. */
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


function bodyOf(env, id) { return JSON.parse(env.files[id].content); }
function failFirstApplyManifestWrite(env) {
  const folder = env.ctx.DriveApp.getFolderById(env.props.APP_FOLDER_ID);
  const original = folder.createFile;
  let fired = false;
  folder.createFile = (...args) => {
    const file = original(...args);
    if (file.name.startsWith('Trends2Targets_MetadataRepair_')) {
      const write = file.setContent;
      file.setContent = text => {
        if (!fired && JSON.parse(text).status === 'VERIFIED') { fired = true; throw new Error('fixture manifest apply finalization failed'); }
        return write(text);
      };
    }
    return file;
  };
  return () => fired;
}

// The metadata operation is built before the journal writes it; actual wall time can move between those steps.
{
  const f = fixture(), {env} = f;
  env.run(`var __metaTick=0;appNowIso_=function(){return '2026-10-21T12:00:'+String(__metaTick++).padStart(2,'0')+'+0900';}`);
  const before = snapshot(env), p = f.preview(), backupId = f.copy();
  const r = f.apply(p, backupId);
  assert.equal(bodyOf(env,r.repairFileId).status,'VERIFIED');
  assert.ok(env.run('__metaTick') > 3,'clock advances across real preview/apply/journal calls');
  f.rollback(r.repairFileId);
  assert.deepEqual(snapshot(env),before,'original timestamps and metadata are restored exactly despite time moving');
}

// A completed journal with a PREPARED manifest can be verified without writing any business table again.
{
  const f=fixture(), fired=failFirstApplyManifestWrite(f.env);
  assert.throws(()=>f.apply(),/fixture manifest apply finalization failed/);
  assert.equal(fired(),true);
  const files=repairFiles(f.env);assert.equal(files.length,1);
  const id=files[0].id;
  assert.equal(bodyOf(f.env,id).status,'PREPARED');
  const afterCommit=snapshot(f.env);
  task(f.env,'resumeNativeMetadataRepair',{repairFileId:id});
  assert.equal(bodyOf(f.env,id).status,'VERIFIED');
  assert.deepEqual(snapshot(f.env),afterCommit,'resume only finalizes the proof file');
  assert.match(bodyOf(f.env,id).afterDigest,/^[a-f0-9]{64}$/);
  f.rollback(id);
  assert.equal(bodyOf(f.env,id).status,'ROLLED_BACK');
}

// PREPARED after an applied journal is also safely reversible before resume.
{
  const f=fixture(),before=snapshot(f.env);failFirstApplyManifestWrite(f.env);
  assert.throws(()=>f.apply(),/fixture manifest apply finalization failed/);
  const id=repairFiles(f.env)[0].id;
  f.rollback(id);
  assert.deepEqual(snapshot(f.env),before);
  assert.equal(bodyOf(f.env,id).status,'ROLLED_BACK');
}

// A manifest write can fail after rollback committed: repeating rollback must finalize the same original state.
{
  const f=fixture(),before=snapshot(f.env),r=f.apply(),file=f.env.files[r.repairFileId];
  const original=file.setContent;let fired=false;
  file.setContent=text=>{
    if(!fired&&JSON.parse(text).status==='ROLLED_BACK'){fired=true;throw new Error('fixture manifest rollback finalization failed');}
    return original(text);
  };
  assert.throws(()=>f.rollback(r.repairFileId),/fixture manifest rollback finalization failed/);
  assert.equal(fired,true);
  assert.deepEqual(snapshot(f.env),before,'journal already restored the metadata');
  assert.equal(bodyOf(f.env,r.repairFileId).status,'VERIFIED','proof still reflects pre-finalization status');
  f.rollback(r.repairFileId);
  assert.deepEqual(snapshot(f.env),before,'second rollback never changes other rows');
  assert.equal(bodyOf(f.env,r.repairFileId).status,'ROLLED_BACK');
  f.rollback(r.repairFileId);
  assert.deepEqual(snapshot(f.env),before,'a fully finalized rollback remains idempotent');
}

// A PREPARED proof is not permission to finalize after any later business-data edit.
{
  const f=fixture();failFirstApplyManifestWrite(f.env);
  assert.throws(()=>f.apply(),/fixture manifest apply finalization failed/);
  const id=repairFiles(f.env)[0].id;
  f.env.run("appWithLock_(()=>appPatchRow_('PLANS',{plan_id:__id},{note:'中断後の人の保存'},'fixture'))",{__id:f.protectedId});
  const afterEdit=snapshot(f.env);
  assert.throws(()=>task(f.env,'resumeNativeMetadataRepair',{repairFileId:id}),/変わ|一致|状態/);
  assert.deepEqual(snapshot(f.env),afterEdit);
  assert.equal(bodyOf(f.env,id).status,'PREPARED');
}

// Mid-journal write failure retains both prepared proof and journal; recover the journal before finalizing its proof.
{
  const f=fixture(), before=snapshot(f.env), meta=f.env.data().getSheetByName('ENG_SHEETS');
  meta.failWrites=true;
  assert.throws(()=>f.apply(),/write failed/);
  const id=repairFiles(f.env)[0].id;
  assert.equal(bodyOf(f.env,id).status,'PREPARED');
  assert.ok(f.env.props.APP_WRITE_JOURNAL);
  assert.throws(()=>task(f.env,'resumeNativeMetadataRepair',{repairFileId:id}),/未完了の保存/);
  meta.failWrites=false;
  f.env.run('appWithLock_(()=>appJournalRecover_({actor:__owner,requestId:"fixture-recovery"}))',{__owner:OWNER});
  assert.equal(!!f.env.props.APP_WRITE_JOURNAL,false);
  const committed=snapshot(f.env);
  task(f.env,'resumeNativeMetadataRepair',{repairFileId:id});
  assert.deepEqual(snapshot(f.env),committed);
  assert.equal(bodyOf(f.env,id).status,'VERIFIED');
  f.rollback(id);
  assert.deepEqual(snapshot(f.env),before);
}

console.log('app-native-metadata-repair-resume: changing clock, PREPARED resume/rollback, interrupted rollback and later-edit refusal PASS');
