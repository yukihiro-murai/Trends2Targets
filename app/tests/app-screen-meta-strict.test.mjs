import assert from 'node:assert/strict';
import { setUpEnv, STATS } from './gas-mock.mjs';

const e = setUpEnv();
const header = e.run('APP_ENGINE_SHEETS.CLIENT.header');
const id = e.seedPlan(e.makeBook('合成の厳格検証', {
  CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', '合成'], ['[必須] 予測年度FY（YYYY）', 2026]] },
  CLIENT: { values: [header, ['甲', '2026/04', '+5%', 'one'], ['乙', '2026/05', '+10%', 'two']] },
  OUTPUT: { values: [['output']], formats: { A: '@' } },
}));
const writes = STATS.writes;
const unchanged = JSON.stringify(e.table('ENG_CLIENT').filter(r => r.plan_id === id));
for (const [mutate, pattern] of [
  ['bag.tableRows[0].seq="0"', /保存行の番号/],
  ['bag.tableRows[0].seq="2.5"', /保存行の番号/],
  ['bag.tableRows[1].seq="2"', /重複/],
  ['bag.tableRows[0]._types="s"', /型の数/],
  ['bag.tableRows[0]._types="xsss"', /型が不正/],
  ['bag.tableRows[0]._types="nsss"; bag.tableRows[0].Person="NaN"', /数値セル/],
  ['bag.tableRows[0].plan_id="other"', /別の計画/],
  ['bag.segs.push({plan_id:__id,sheet:"CLIENT",row_no:"2",col_from:"5",cells_json:"not json"})', /JSON/],
  ['bag.segs.push({plan_id:__id,sheet:"CLIENT",row_no:"2",col_from:"4",cells_json:JSON.stringify(["sbad"])})', /重なっ/],
  ['bag.segs.push({plan_id:__id,sheet:"CLIENT",row_no:"2",col_from:"5",cells_json:JSON.stringify(["sone","stwo"])},{plan_id:__id,sheet:"CLIENT",row_no:"2",col_from:"6",cells_json:JSON.stringify(["sbad"])})', /範囲が重複/],
  ['bag.tableRows[0].seq="200001"', /安全な上限/],
]) {
  assert.throws(() => e.run(`appScreenSheetHashOp_(__id, 'CLIENT', 'synthetic', bag => {${mutate}})`, { __id: id }), pattern, mutate);
}
assert.throws(() => e.run("appScreenSheetHashOp_(__id, 'EVAL_COMPARE_MONTHLY', 'synthetic')", { __id: id }), /シート情報がありません/);
assert.equal(JSON.stringify(e.table('ENG_CLIENT').filter(r => r.plan_id === id)), unchanged);
assert.equal(STATS.writes, writes, 'strict validation never writes to the mock data tables');

// ensure keeps an existing key's actual value; later patch/drop/replace apply in Journal order.
const result = e.run(`(function(){
  const bag={tableRows:[{plan_id:__id,seq:'2',Person:'human'}],segs:[]};
  appScreenOverlaySheetOps_(bag,__id,'CLIENT',[
    {table:'ENG_CLIENT',mode:'ensure',rows:[{plan_id:__id,seq:'2',Person:'ignored'},{plan_id:__id,seq:'3',Person:'new'}]},
    {table:'ENG_CLIENT',mode:'patch',key:{plan_id:__id,seq:'3'},patch:{Person:'patched'}},
    {table:'ENG_CLIENT',mode:'drop',keys:[{plan_id:__id,seq:'3'}]},
    {table:'ENG_CLIENT',mode:'ensure',rows:[{plan_id:'other',seq:'9',Person:'outside'}]}
  ]);
  return bag;
})()`, { __id: id });
assert.deepEqual(JSON.parse(JSON.stringify(result.tableRows)), [{ plan_id: id, seq: '2', Person: 'human' }]);
console.log('app-screen-meta-strict: ok');
