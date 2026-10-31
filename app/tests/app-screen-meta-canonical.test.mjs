#!/usr/bin/env node
/** Synthetic independent persisted-bag oracle: sparse native seq keys must not hash unsaved blank rows. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setUpEnv, OWNER } from './gas-mock.mjs';
const env = setUpEnv();
const header = env.call('APP_ENGINE_SHEETS.PROCESS_STATUS.header');
const row = (key, note) => header.map(h => ({step_key:key,last_run_date:'2026-10-01T10:00:00+0900',last_run_by:'合成担当',status:'success',target_client:'合成欠番製薬',record_count:0,error_summary:note}[h] ?? ''));
const book = env.makeBook('合成欠番製薬', {
  CONFIG: {values:[['項目','値'],['[必須] メーカー名（外部集計キー）','合成欠番製薬'],['[必須] 予測年度FY（YYYY）',2026],['[必須] 担当者（カンマ区切り）','合成担当']]},
  PROCESS_STATUS: { values:[header,row('step1_status','先頭の本物'),[],[],row('step5_status','末尾の本物')],formats:{B:'@',F:'0'} },
});
const planId = env.seedPlan(book);
env.run("appWithLock_(()=>{const rows=appReadPlanTable_('ENG_PROCESS_STATUS',__id).filter(r=>Number(r.seq)===2||Number(r.seq)===5).map(appStripRow_).reverse();appReplaceRows_('ENG_PROCESS_STATUS',r=>r.plan_id!==__id,rows);appPatchRow_('ENG_SHEETS',{plan_id:__id,sheet:'PROCESS_STATUS'},{content_hash:'0'.repeat(64)},'fixture');})", {__id:planId});
const rawBefore = env.table('ENG_PROCESS_STATUS').filter(r=>r.plan_id===planId);
assert.deepEqual(rawBefore.map(r=>r.seq), ['5','2'], 'fixture storage order differs from canonical numeric key order');
const metaBefore = env.table('ENG_SHEETS').find(r=>r.plan_id===planId&&r.sheet==='PROCESS_STATUS');
const tableRows = rawBefore.slice().sort((a,b)=>Number(a.seq)-Number(b.seq));
const segs = env.table('ENG_ROWS').filter(r=>r.plan_id===planId&&r.sheet==='PROCESS_STATUS').sort((a,b)=>Number(a.row_no)-Number(b.row_no)||Number(a.col_from)-Number(b.col_from));
const fmts = env.table('ENG_FORMATS').filter(r=>r.plan_id===planId&&r.sheet==='PROCESS_STATUS').sort((a,b)=>Number(a.col)-Number(b.col));
const native = tableRows.map(r=>{
  const out={seq:r.seq};for(const h of header)out[h]=r[h];out._types=r._types;return out;
});
const rowContent=segs.map(r=>({sheet:r.sheet,row_no:r.row_no,col_from:r.col_from,cells_json:r.cells_json}));
const formatContent=fmts.map(r=>({sheet:r.sheet,col:r.col,runs_json:r.runs_json}));
const dims=['max_rows','max_columns','last_row','last_column','fmt_columns'].map(k=>Number(metaBefore[k]));
const expected=createHash('sha256').update(JSON.stringify(['PROCESS_STATUS','table',...dims,native,rowContent,formatContent])).digest('hex');
const decoded=env.run('appEngDecodeSheet_(__m,__tr,__rr,__fr)',{__m:metaBefore,__tr:tableRows,__rr:segs,__fr:fmts});
assert.equal(decoded.values.length,5);
assert.ok(decoded.values[2].every(v=>v==='')&&decoded.values[3].every(v=>v===''), 'logical decode restores blank positions without persisting blank records');
const logicalEncoded=env.run('appEngEncodeSheet_(__id,__d)',{__id:planId,__d:decoded});
assert.notEqual(logicalEncoded.sheetRow.content_hash,expected,'re-encoding a logical grid invents stored gap rows and is not the persisted-bag hash oracle');
const op=env.call('appScreenSheetHashOp_(__id,"PROCESS_STATUS","test")',{__id:planId});
assert.ok(op&&op.table==='ENG_SHEETS');
assert.equal(op.patch.content_hash,expected,'metadata hash equals explicit persisted-bag canonical oracle');
assert.deepEqual(env.table('ENG_PROCESS_STATUS').filter(r=>r.plan_id===planId),rawBefore,'hash preparation never adds empty seq records');
env.run('appWithLock_(()=>appJournalRun_({actor:__owner,requestId:"sparse-meta"},"sparse metadata",__id,[__op]))',{__owner:OWNER,__id:planId,__op:op});
assert.deepEqual(env.table('ENG_PROCESS_STATUS').filter(r=>r.plan_id===planId),rawBefore,'metadata application never adds empty seq records');
const stored=env.table('ENG_SHEETS').find(r=>r.plan_id===planId&&r.sheet==='PROCESS_STATUS');
assert.equal(stored.content_hash,expected);
assert.equal(env.call('appScreenSheetHashOp_(__id,"PROCESS_STATUS","test")',{__id:planId}),null,'same sparse persisted bag is idempotent');
const restored=env.run('appEngDecodeSheet_(__m,__tr,__rr,__fr)',{__m:stored,__tr:tableRows,__rr:segs,__fr:fmts});
assert.deepEqual(restored.values,decoded.values);assert.deepEqual(restored.formulas,decoded.formulas);assert.deepEqual(restored.formats,decoded.formats);
console.log('app-screen-meta-canonical: sparse seq, explicit column/key-order hash and logical decode preservation PASS');
