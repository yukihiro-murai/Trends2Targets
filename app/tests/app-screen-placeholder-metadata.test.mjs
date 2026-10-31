#!/usr/bin/env node
/** Synthetic regression: placeholder writes carry matching native sheet metadata; repair changes metadata only. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { OWNER, setUpEnv } from './gas-mock.mjs';

const env = setUpEnv();
env.run("appToday_ = function(){ return '2026-10-21'; }");
const FY = 2026;
const TARGET = ['OUTPUT', 'EVAL_COMPARE_MONTHLY', 'PROCESS_STATUS'];
function shortPlan(name) {
  const sheets = { CONFIG: { values: [
    ['項目', '値'], ['[必須] メーカー名（外部集計キー）', name],
    ['[必須] 予測年度FY（YYYY）', FY], ['[必須] 担当者（カンマ区切り）', '合成担当'],
  ] }, OUTPUT: { values: [['合成の予測']] } };
  for (const n of ['PRODUCT', 'CLIENT', 'OPINIONS', 'DEV_SPOT', 'SALES_INPUT', 'EVAL_COMPARE_MONTHLY', 'PROCESS_STATUS']) {
    sheets[n] = { values: [env.call('APP_ENGINE_SHEETS.' + n + '.header')] };
  }
  return env.seedPlan(env.makeBook(name, sheets));
}
const planId = shortPlan('短い寸法の合成製薬');
const protectedId = shortPlan('対象外の合成保護製薬');
env.run("appWithLock_(() => appPatchRow_('PLANS',{plan_id:__id},{state:'ARCHIVED'},'fixture'))", { __id: protectedId });
const names = env.call('Object.keys(APP_TABLES)');
const allTables = () => Object.fromEntries(names.map(n => [n, env.table(n)]));
const protectedBefore = Object.fromEntries(names.map(n => [n, env.table(n).filter(r => r.plan_id === protectedId)]));
const hashState = () => env.call('[appPlanInputHash_(__id), appForecastInputHash_(__id), appForecastSeed_(appPlanOf_(__id),appForecastInputHash_(__id),{version:"fixed",sourceSha256:"fixed"})]', { __id: planId });
const beforeSeed = hashState();
const initialTitle = env.table('ENG_ROWS').find(r => r.plan_id === planId && r.sheet === 'OUTPUT' && r.row_no === '1').cells_json;
// Warm view must not be sufficient evidence: always drop the mock cache for the post-write read.
assert.equal(env.call('apiPlanView(__in)', { __in: { planId } }).plan.planId, planId);
env.props.OWNER_TASK = JSON.stringify({ action: 'seedDummyLanding', fy: FY });
const seeded = env.call('apiOwnerTask()');
assert.equal(seeded.ok, true);
assert.ok(seeded.result.filled.some(p => p.planId === planId));
assert.ok(!seeded.result.filled.some(p => p.planId === protectedId));
assert.deepEqual(seeded.result.failed, []);
assert.equal(env.table('ENG_ROWS').find(r => r.plan_id === planId && r.sheet === 'OUTPUT' && r.row_no === '1').cells_json, initialTitle);

// Independent native persisted-bag hash oracle: schema column order and numeric key order; never invent gap rows.
function canonical(sheet, meta) {
  const tableRows = meta.mode === 'table' ? env.table('ENG_' + sheet).filter(r => r.plan_id === planId).sort((a, b) => Number(a.seq) - Number(b.seq)) : [];
  const header = meta.mode === 'table' ? env.call('APP_ENGINE_SHEETS[__sheet].header', { __sheet: sheet }) : [];
  const tr = tableRows.map(r => {
    const row = { seq: r.seq };
    for (const h of header) row[h] = r[h];
    row._types = r._types;
    return row;
  });
  const rr = env.table('ENG_ROWS').filter(r => r.plan_id === planId && r.sheet === sheet)
    .sort((a, b) => Number(a.row_no) - Number(b.row_no) || Number(a.col_from) - Number(b.col_from))
    .map(r => ({ sheet: r.sheet, row_no: r.row_no, col_from: r.col_from, cells_json: r.cells_json }));
  const fr = env.table('ENG_FORMATS').filter(r => r.plan_id === planId && r.sheet === sheet).sort((a, b) => Number(a.col) - Number(b.col))
    .map(r => ({ sheet: r.sheet, col: r.col, runs_json: r.runs_json }));
  const dims = ['max_rows', 'max_columns', 'last_row', 'last_column', 'fmt_columns'].map(k => Number(meta[k]));
  return createHash('sha256').update(JSON.stringify([sheet, meta.mode, ...dims, tr, rr, fr])).digest('hex');
}
for (const sheet of TARGET) {
  const meta = env.table('ENG_SHEETS').find(r => r.plan_id === planId && r.sheet === sheet);
  const physicalRows = sheet === 'OUTPUT' ? env.table('ENG_ROWS').filter(r => r.plan_id === planId && r.sheet === sheet).map(r => Number(r.row_no))
    : env.table('ENG_' + sheet).filter(r => r.plan_id === planId).map(r => Number(r.seq));
  assert.ok(physicalRows.length > 0);
  assert.ok(Number(meta.last_row) >= Math.max(...physicalRows), sheet + ' metadata contains all persisted rows');
  assert.ok(Number(meta.max_rows) >= Number(meta.last_row));
  assert.ok(Number(meta.max_columns) >= Number(meta.last_column));
  assert.equal(meta.content_hash, canonical(sheet, meta), sheet + ' hash describes persisted rows');
}
for (const k of Object.keys(env.cache)) delete env.cache[k];
assert.equal(env.call('apiPlanView(__in)', { __in: { planId } }).plan.planId, planId, 'cold plan view after placeholder creation');
const decoded = env.call('appEngLoadPlanSheets_(__id,__names)', { __id: planId, __names: TARGET });
assert.ok(decoded.OUTPUT.lastRow >= 40);
assert.ok(decoded.PROCESS_STATUS.lastRow >= 3);
assert.ok(decoded.EVAL_COMPARE_MONTHLY.lastRow >= 7);
const afterSeed = hashState();
assert.notEqual(afterSeed[0], beforeSeed[0], 'state/input hash changes after actual placeholder writes');
assert.equal(afterSeed[1], beforeSeed[1], 'these three sheets are excluded from forecast input hash');
assert.equal(afterSeed[2], beforeSeed[2], 'same-version seed remains unchanged');
for (const n of names) assert.deepEqual(env.table(n).filter(r => r.plan_id === protectedId), protectedBefore[n], 'protected plan: ' + n);
assert.equal(env.table('FORECAST_RUNS').filter(r => r.plan_id === planId).length, 0, 'no forecast run is created');

// Reproduce already persisted stale metadata without changing any business rows, then repair that metadata only.
env.run("appWithLock_(() => __names.forEach(sheet => appPatchRow_('ENG_SHEETS',{plan_id:__id,sheet:sheet},{last_row:'1',last_column:sheet==='OUTPUT'?'1':String(APP_ENGINE_SHEETS[sheet].header.length),content_hash:'0'.repeat(64)},'fixture')))", { __id: planId, __names: TARGET });
const beforeRepair = allTables();
const hashBeforeRepair = hashState();
const ops = env.call('__names.map(sheet=>appScreenSheetHashOp_(__id,sheet,"test"))', { __id: planId, __names: TARGET });
assert.deepEqual(allTables(), beforeRepair, 'building metadata operations is read-only');
assert.ok(ops.every(op => op && op.table === 'ENG_SHEETS' && op.mode === 'patch' && op.planId === planId));
const allowed = new Set(['content_hash', 'updated_at', 'updated_by', 'last_row', 'last_column', 'max_rows', 'max_columns']);
for (const op of ops) assert.ok(Object.keys(op.patch).every(k => allowed.has(k)), 'metadata repair allowlist');
env.run('appWithLock_(()=>appJournalRun_({actor:__owner,requestId:"synthetic-meta"},"synthetic metadata only",__id,__ops))', { __owner: OWNER, __id: planId, __ops: ops });
for (const n of names) {
  const after = env.table(n);
  if (n !== 'ENG_SHEETS') assert.deepEqual(after, beforeRepair[n], n + ' remains byte-for-byte equivalent');
  else {
    assert.deepEqual(after.filter(r => r.plan_id !== planId || !TARGET.includes(r.sheet)), beforeRepair[n].filter(r => r.plan_id !== planId || !TARGET.includes(r.sheet)), 'non-target metadata unchanged');
    for (const sheet of TARGET) {
      const meta = after.find(r => r.plan_id === planId && r.sheet === sheet);
      assert.equal(meta.content_hash, canonical(sheet, meta));
    }
  }
}
for (const k of Object.keys(env.cache)) delete env.cache[k];
assert.equal(env.call('apiPlanView(__in)', { __in: { planId } }).plan.planId, planId, 'cold read after metadata-only repair');
const hashAfterRepair = hashState();
assert.notEqual(hashAfterRepair[0], hashBeforeRepair[0]);
assert.equal(hashAfterRepair[1], hashBeforeRepair[1]);
assert.equal(hashAfterRepair[2], hashBeforeRepair[2]);
assert.ok(env.call('__names.map(sheet=>appScreenSheetHashOp_(__id,sheet,"test"))', { __id: planId, __names: TARGET }).every(op => op === null), 'second repair is a no-op');
console.log('app-screen-placeholder-metadata: placeholder bounds, cold view, protected plan, metadata-only repair and seed PASS');
