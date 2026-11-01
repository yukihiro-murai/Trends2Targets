#!/usr/bin/env node
/** Synthetic-only full-book preservation checks. No real Drive, network or credentials. */
import assert from 'node:assert/strict';
import {setUpEnv, OWNER, STATS} from './gas-mock.mjs';

let cases=0;
const test=(name,fn)=>{fn();cases++;};
function fixture(){
  const e=setUpEnv(),H=e.call('Object.fromEntries(Object.entries(APP_ENGINE_SHEETS).map(([k,v])=>[k,v.header||[]]))');
  const r=(s,o)=>H[s].map(k=>o[k]??'');
  const plan=name=>{
    const sheets={CONFIG:{values:[['項目','値'],['メーカー',name],['FY',2026],['担当','合成担当']]},OUTPUT:{values:[['合成予測'],['保存してある出力',42]]}};
    for(const name of ['ACTUAL_EVAL_MONTHLY','EVAL_LOG','EVAL_COMPARE_MONTHLY','PROCESS_STATUS','RUN_LOG','CALIBRATION_STATE','CALIBRATION_HISTORY'])sheets[name]={values:[H[name],r(name,{client:name,step_key:'step5_status',run_id:'OLD-RUN',eval_id:'OLD-EVAL',change_id:'OLD-CAL',target_month:'2026/04',actual:100,pred:120,actual_total:100})]};
    sheets.PRODUCT={values:[H.PRODUCT,['合成担当','合成製品','2026/04',.1,'保護した理由']]};
    sheets.EVAL_INSIGHTS={values:[H.EVAL_INSIGHTS,
      r('EVAL_INSIGHTS',{client:name,target_month:'2026/04',cause_hypothesis:'合成仮説',impacted_assumption:'合成の前提',action_type:'入力を修正',next_cycle_reflection:'合成の反映',owner:'合成担当',due_date:new Date('2026-10-01T00:00:00Z'),status:'in_progress',cause_bucket:'old'}),
      r('EVAL_INSIGHTS',{client:name,target_month:'2026/05',impacted_assumption:'CONFIG:環境前提',action_type:'update',next_cycle_reflection:'次回サイクルで前提更新を反映',status:'open'})
    ]};
    return e.seedPlan(e.makeBook(name,sheets));
  };
  const planId=plan('合成対象製薬'),otherId=plan('合成保護製薬');
  e.run("appWithLock_(()=>{appInsertRows_('PLAN_ACTIONS',[{action_id:'OLD-ACTION',plan_id:__id,action:'EVAL.REPORT',status:'DONE'}]);appInsertRows_('HIT_RECORDS',[{hit_id:'OLD-HIT',plan_id:__id,source_key:'保護した情報源',hit:1}]);})",{__id:planId});
  const dataId=e.props.APP_DATA_SPREADSHEET_ID,folderId=e.props.APP_FOLDER_ID;
  const backupId=e.run('DriveApp.getFileById(__data).makeCopy("合成退避版",DriveApp.getFolderById(__folder)).getId()',{__data:dataId,__folder:folderId});
  // Missing read-only Drive metadata methods are scoped to this fixture.
  e.ctx.DriveApp.Access={PRIVATE:'PRIVATE',ANYONE:'ANYONE'};
  for(const id of [dataId,backupId]){
    const file=e.files[id];file.fixtureOwner=OWNER;file.fixtureAccess='PRIVATE';file.fixtureEditors=[];file.fixtureViewers=[];
    file.getOwner=()=>file.fixtureOwner?{getEmail:()=>file.fixtureOwner}:null;
    file.getSharingAccess=()=>file.fixtureAccess;
    file.getEditors=()=>file.fixtureEditors;file.getViewers=()=>file.fixtureViewers;
  }
  const backup=e.sheetsById[backupId],data=e.data();
  const call=(verify=false,more={})=>e.call('appEvaluationPreservation_(__ctx,__input)',{__ctx:{actor:OWNER,requestId:'SYNTHETIC'},__input:{planId,backupId,verify,...more}});
  const digest=book=>e.call('appNativeMetaBookProof_(__book).digest',{__book:book});
  const sh=name=>data.getSheetByName(name);
  const find=(name,id=planId,extra=()=>true)=>{const s=sh(name),pi=s.rows[0].indexOf('plan_id');return s.rows.findIndex((r,i)=>i>0&&r[pi]===id&&extra(r,s.rows[0]));};
  const set=(name,field,value,id=planId,extra)=>{const s=sh(name),i=find(name,id,extra);assert.ok(i>0,name);s.rows[i][s.rows[0].indexOf(field)]=value;};
  const add=(name,o)=>{const s=sh(name),i=s.rows.length;s.rows.push(s.rows[0].map(k=>o[k]??''));s.fmts[i]=s.rows[0].map(()=> '@');};
  return {e,planId,otherId,dataId,backupId,data,backup,call,digest,sh,find,set,add};
}
function unchanged(f,fn){const a=f.digest(f.data),b=f.digest(f.backup),w=STATS.writes;const r=fn();assert.equal(f.digest(f.data),a);assert.equal(f.digest(f.backup),b);assert.equal(STATS.writes,w);return r;}
function legacyFixture(){
  const f=fixture();
  for(const book of [f.data,f.backup]){
    book.sheets.splice(book.sheets.findIndex(s=>s.getName()==='SCREEN_HOLD'),1);
    const sh=book.insertSheet('IMPORT_BATCHES');
    sh.getRange(1,1,3,4).setNumberFormat('@').setValues([['batch_id','source_book_id','imported_at','note'],['OLD-1','synthetic-source-1','2026-09-01','旧記録を保持'],['OLD-2','synthetic-source-2','2026-09-02','旧記録を保持']]);
  }
  return f;
}

test('preflight exact 54 tables, hashes only and no writes',()=>{
  const f=fixture();const seen=[];
  for(const book of [f.data,f.backup]){const old=book.getSheets;book.getSheets=()=>{seen.push(f.e.state.lockHeld);return old();};}
  const r=unchanged(f,()=>f.call());
  assert.equal(r.preserved,true);assert.equal(r.exact,true);assert.equal(r.verified,false);assert.equal(r.checkedTables,54);assert.deepEqual(r.changedTables,[]);
  assert.equal(r.backupSha256,r.currentSha256);assert.equal(r.storeWrites,0);assert.match(r.inputHash,/^[a-f0-9]{64}$/);
  assert.equal(Object.keys(r.tables).length,54);assert.ok(seen.filter(Boolean).length>=3);
  assert(!JSON.stringify(r).includes('合成担当'));assert(!JSON.stringify(r).includes('合成仮説'));
});

test('live legacy 54-table composition accepts missing optional SCREEN_HOLD',()=>{
  const f=legacyFixture();
  for(const verify of [false,true]){const r=unchanged(f,()=>f.call(verify));assert.equal(r.preserved,true);assert.equal(r.checkedTables,54);assert.equal(r.exact,true);assert.ok(r.tables.IMPORT_BATCHES);assert.equal(r.tables.SCREEN_HOLD,undefined);}
  assert.equal(f.data.getSheetByName('SCREEN_HOLD'),null);assert.equal(f.backup.getSheetByName('SCREEN_HOLD'),null);
  f.set('ENG_EVAL_LOG','actual','updated');assert.equal(unchanged(f,()=>f.call(true)).preserved,true,'known allowlisted target changes still work beside an unknown retired table');
});
for(const alter of [
  sh=>{sh.rows[1][3]='changed';},sh=>{sh.rows[1][3]=7;},
  sh=>{sh.fmts[1][3]='0.00';},sh=>{sh.fmls[1]=[];sh.fmls[1][3]='=3+4';},
  sh=>{[sh.rows[1],sh.rows[2]]=[sh.rows[2],sh.rows[1]];},
])test('unknown retired table is exact protected including row order',()=>{
  const f=legacyFixture();alter(f.data.getSheetByName('IMPORT_BATCHES'));unchanged(f,()=>assert.throws(()=>f.call(true),/未知の旧表/));
});

test('all allowed evaluation tables may change only target plan',()=>{
  const f=fixture(),sheets=f.e.call('APP_EVAL_PRESERVE_SHEETS');
  for(const sheet of sheets){const name='ENG_'+sheet,col=f.sh(name).rows[0][2];if(sheet!=='EVAL_INSIGHTS')f.set(name,col,'changed');}
  f.set('ENG_EVAL_INSIGHTS','pred_p50','130');f.set('ENG_EVAL_INSIGHTS','cause_bucket','new');
  f.set('ENG_EVAL_INSIGHTS','action_type','keep',f.planId,r=>r[f.sh('ENG_EVAL_INSIGHTS').rows[0].indexOf('target_month')]==='2026/05');
  f.add('PLAN_ACTIONS',{action_id:'NEW-ACTION',plan_id:f.planId,action:'EVAL.INSIGHTS',status:'DONE'});
  f.add('HIT_RECORDS',{hit_id:'NEW-HIT',plan_id:f.planId,source_key:'新しい合成情報源',hit:0});
  const r=unchanged(f,()=>f.call(true));assert.equal(r.preserved,true);assert.equal(r.verified,true);assert.equal(r.exact,false);
  assert.equal(r.existingInsightRows,2);assert.equal(r.preservedHumanRows,1);assert.equal(r.preservedHumanCells,7);
  assert.ok(r.changedTables.includes('ENG_EVAL_LOG'));assert.ok(r.changedTables.includes('HIT_RECORDS'));
});

test('allowed meta/segments and reordered protected rows retain typed row bags',()=>{
  const f=fixture();f.set('ENG_SHEETS','content_hash','f'.repeat(64),f.planId,(r,h)=>r[h.indexOf('sheet')]==='EVAL_LOG');
  f.add('ENG_ROWS',{plan_id:f.planId,sheet:'EVAL_LOG',row_no:'100',col_from:'30',cells_json:'["schanged"]'});
  f.set('ENG_FORMATS','runs_json','[[1,3,"0.00"]]',f.planId,(r,h)=>r[h.indexOf('sheet')]==='EVAL_LOG');
  for(const s of f.data.getSheets())for(const a of [s.rows,s.fmls,s.fmts])if(a.length>2){const head=a.shift();a.reverse();a.unshift(head);}
  const r=unchanged(f,()=>f.call(true));assert.equal(r.preserved,true);assert.ok(r.changedTables.includes('ENG_SHEETS'));
});

for(const [name,field,value,id,extra] of [
  ['ENG_PRODUCT','Reason','changed'],['ENG_EVAL_LOG','actual','changed','other'],
  ['ENG_SHEETS','content_hash','changed',null,(r,h)=>r[h.indexOf('sheet')]==='OUTPUT'],
  ['ENG_ROWS','cells_json','["schanged"]',null,(r,h)=>r[h.indexOf('sheet')]==='OUTPUT'],
  ['ENG_FORMATS','runs_json','[]',null,(r,h)=>r[h.indexOf('sheet')]==='PRODUCT'],
  ['PLANS','note','changed'],
])test('protected rejection '+name+' '+field,()=>{const f=fixture();f.set(name,field,value,id==='other'?f.otherId:f.planId,extra);unchanged(f,()=>assert.throws(()=>f.call(true),/保護対象/));});

for(const field of ['cause_hypothesis','impacted_assumption','action_type','next_cycle_reflection','owner','due_date','status'])test('nonempty human column protected '+field,()=>{
  const f=fixture();f.set('ENG_EVAL_INSIGHTS',field,'changed',f.planId,(r,h)=>r[h.indexOf('seq')]==='2');unchanged(f,()=>assert.throws(()=>f.call(true),/人の記入/));
});
for(const field of ['client','target_month'])test('human row identity protected '+field,()=>{
  const f=fixture();f.set('ENG_EVAL_INSIGHTS',field,field==='client'?'別の合成製薬':'2026/06',f.planId,(r,h)=>r[h.indexOf('seq')]==='2');unchanged(f,()=>assert.throws(()=>f.call(true),/所属・月/));
});
test('machine-only row month also protected',()=>{
  const f=fixture();f.set('ENG_EVAL_INSIGHTS','target_month','2026/06',f.planId,(r,h)=>r[h.indexOf('seq')]==='3');unchanged(f,()=>assert.throws(()=>f.call(true),/所属・月/));
});
test('encoded identity type protected',()=>{
  const f=fixture(),s=f.sh('ENG_EVAL_INSIGHTS'),h=s.rows[0],i=f.find('ENG_EVAL_INSIGHTS'),ti=h.indexOf('_types'),t=f.e.call('APP_ENGINE_SHEETS.EVAL_INSIGHTS.header.indexOf("target_month")'),types=s.rows[i][ti].split('');types[t]='d';s.rows[i][ti]=types.join('');unchanged(f,()=>assert.throws(()=>f.call(true),/所属・月/));
});
test('encoded human type protected',()=>{const f=fixture(),h=f.sh('ENG_EVAL_INSIGHTS').rows[0],i=f.find('ENG_EVAL_INSIGHTS',f.planId,(r,h)=>r[h.indexOf('seq')]==='2'),s=f.sh('ENG_EVAL_INSIGHTS'),ti=h.indexOf('_types'),t=f.e.call('APP_ENGINE_SHEETS.EVAL_INSIGHTS.header.indexOf("cause_hypothesis")');const a=s.rows[i][ti].split('');a[t]='n';s.rows[i][ti]=a.join('');unchanged(f,()=>assert.throws(()=>f.call(true),/人の記入/));});
test('all old seq retained including machine-only rows',()=>{const f=fixture(),s=f.sh('ENG_EVAL_INSIGHTS'),i=f.find('ENG_EVAL_INSIGHTS',f.planId,(r,h)=>r[h.indexOf('seq')]==='3');s.rows.splice(i,1);s.fmts.splice(i,1);unchanged(f,()=>assert.throws(()=>f.call(true),/既存の振り返り/));});
test('duplicate insight seq rejected',()=>{const f=fixture(),s=f.sh('ENG_EVAL_INSIGHTS'),i=f.find('ENG_EVAL_INSIGHTS');s.rows.push(s.rows[i].slice());s.fmts.push(s.rows[0].map(()=> '@'));unchanged(f,()=>assert.throws(()=>f.call(true),/重複/));});

for(const name of ['PLAN_ACTIONS','HIT_RECORDS']){
  test('existing append row protected '+name,()=>{const f=fixture();f.set(name,name==='PLAN_ACTIONS'?'status':'source_key','changed');unchanged(f,()=>assert.throws(()=>f.call(true),/既存の追記/));});
  test('new other-plan append rejected '+name,()=>{const f=fixture();f.add(name,name==='PLAN_ACTIONS'?{action_id:'OTHER-A',plan_id:f.otherId}:{hit_id:'OTHER-H',plan_id:f.otherId});unchanged(f,()=>assert.throws(()=>f.call(true),/保護対象/));});
  test('duplicate append key rejected '+name,()=>{const f=fixture(),s=f.sh(name),i=f.find(name);s.rows.push(s.rows[i].slice());s.fmts.push(s.rows[0].map(()=> '@'));unchanged(f,()=>assert.throws(()=>f.call(true),/重複/));});
}

for(const alter of [
  f=>f.sh('CLIENTS').rows[1][1]='changed',f=>f.sh('CLIENTS').rows[1][1]=7,
  f=>{f.sh('CLIENTS').fmls[1]=[];f.sh('CLIENTS').fmls[1][1]='=3+4';},
  f=>{f.sh('CLIENTS').fmts[1][1]='0.00';},
  f=>f.data.setSpreadsheetLocale('en_US'),f=>f.data.setSpreadsheetTimeZone('UTC'),
])test('exact baseline rejects cell/type/formula/format/locale/tz',()=>{const f=fixture();alter(f);unchanged(f,()=>assert.throws(()=>f.call(),/全表|地域/));});

for(const alter of [
  f=>{f.e.files[f.backupId].fixtureOwner='other@bigm2y.com';},
  f=>{f.e.files[f.backupId].fixtureAccess='ANYONE';},
  f=>{f.e.files[f.backupId].fixtureEditors=['editor'];},
  f=>{f.e.files[f.backupId].fixtureViewers=['viewer'];},
  f=>{f.e.files[f.backupId].parent=f.e.props.APP_BACKUP_FOLDER_ID;},
  f=>{f.e.files[f.backupId].mime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';},
  f=>{f.e.files[f.backupId].trashed=true;},
])test('private native owner/parent metadata guard',()=>{const f=fixture();alter(f);unchanged(f,()=>assert.throws(()=>f.call(),/所有者|非公開|親フォルダ|native Sheets/));});

for(const block of ['queued','running','bulk','journal','frozen','missing-plan'])test('idle/open guard precedes Drive reads '+block,()=>{
  const f=fixture();if(block==='queued'||block==='running')f.e.props.APP_JOB_FIXTURE=JSON.stringify({id:'FIXTURE',status:block.toUpperCase(),createdAt:'2026-10-21T00:00:00Z'});
  if(block==='bulk')f.e.props.APP_BULK_STATE=JSON.stringify({active:true});if(block==='journal')f.e.props.APP_WRITE_JOURNAL=JSON.stringify({id:'JNL-fixture',fileId:'missing',label:'fixture'});
  if(block==='frozen')f.e.run("appWithLock_(()=>appInsertRows_('YEAR_CLOSURES',[{fy:'2026',state:'CLOSED',file_id:'fixture'}]))");
  let reads=0;const old=f.e.ctx.DriveApp.getFileById;f.e.ctx.DriveApp.getFileById=id=>{reads++;return old(id);};
  unchanged(f,()=>assert.throws(()=>f.call(false,block==='missing-plan'?{planId:'PL-MISSING'}:{}),/処理|保存|締め済み|計画が見つかりません/));assert.equal(reads,0);
});
test('same ID rejected',()=>{const f=fixture();unchanged(f,()=>assert.throws(()=>f.call(false,{backupId:f.dataId}),/データ本体/));});
test('missing table and changed header are rejected',()=>{
  const f=fixture();f.backup.sheets.pop();unchanged(f,()=>assert.throws(()=>f.call(true),/全表/));
  const g=fixture();g.sh('ENG_EVAL_LOG').rows[0][2]='bad';unchanged(g,()=>assert.throws(()=>g.call(true),/見出し/));
});
test('backup external mutation during comparison is detected',()=>{
  const f=fixture(),old=f.backup.getSheets;let reads=0;f.backup.getSheets=()=>{if(++reads===2)f.backup.getSheetByName('CLIENTS').rows[1][1]='external change';return old();};
  assert.throws(()=>f.call(true),/照合中に退避版/);
});
console.log('app-evaluation-preservation: '+cases+' synthetic cases PASS');
