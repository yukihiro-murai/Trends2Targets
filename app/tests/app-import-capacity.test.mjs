/** Native large sales import/aggregate and persistence, all records synthetic. */
import assert from 'node:assert/strict';
import { setUpEnv } from './gas-mock.mjs';
const FY=2026,AS_OF=Date.parse('2026-10-18T01:00:00Z');
function scenario(count,purpose){
 const env=setUpEnv();env.run(`(()=>{const D=Date;Date=class extends D{constructor(...args){super(...(args.length?args:[__now]));}static now(){return __now;}};})()`,{__now:AS_OF});
 const name='合成大量実績製薬',blank=Array(70).fill(''),rows=[blank.map((_,i)=>'c'+(i+1))],expected={BASE:Array(48).fill(0),SPOT:Array(48).fill(0)};
 const record=(client,service,month,amount,i=0)=>{const r=blank.slice();r[40]=client;r[45]=service;r[49]='合成製品'+i%3;r[56]=month;r[65]=amount;return r;};
 for(let i=0;i<count;i++){const m=i%48,type=i%5===0?'SPOT':'BASE',amount=i%37===0?-100:1000+i;rows.push(record(name,type==='BASE'?'ベース':'スポット',new Date(2022,3+m,1),amount,i));expected[type][m]+=amount;}
 rows.push(record(name,'ベース',new Date(2026,3,1),999999999),record(name,'認識外',new Date(2025,3,1),888888888),record('別会社','ベース',new Date(2025,3,1),777777777));
 const zac=env.makeBook('合成実績',{['*synthetic_actual_value']:{rows:rows.length+1,cols:70,values:rows}});env.task('saveSetting({key:"source.zac_spreadsheet",value:__id})',{__id:zac.getId()});
 const create=env.runJob('PLAN.CREATE',{clientName:name,fy:FY,peopleCsv:purpose?'':'合成担当',purpose});assert.equal(create.status,'DONE',create.error);const id=create.result.planId;
 if(!purpose)env.run("appWithLock_(()=>appJournalRun_({actor:'synthetic'},'existing synthetic budget',__pid,[{table:'BUDGET_DRAFTS',mode:'ensure',rows:[{plan_id:__pid,draft_id:'BD-SYNTHETIC',action_id:'ACT-BUDGET',ym:'2026/04',adopted:50000,uplift:123,basis:'MANUAL',prob:null,alloc:'MANUAL',run_id:'',center:0,actor_email:'synthetic',saved_at:'2026-10-18T01:00:00Z'}]}]));",{__pid:id});
 const outputBefore=env.table('ENG_ROWS').filter(r=>r.plan_id===id&&r.sheet==='OUTPUT'),budgetBefore=env.table('BUDGET_DRAFTS').filter(r=>r.plan_id===id);
 const before=env.table('ENG_SHEETS').find(r=>r.plan_id===id&&r.sheet==='SALES_INPUT');assert.equal(Number(before.max_rows),1000);
 const imported=env.runJob('PLAN.RUN',{planId:id,action:'IMPORT.SALES'});assert.equal(imported.status,'DONE',imported.error);
 const meta=env.table('ENG_SHEETS').find(r=>r.plan_id===id&&r.sheet==='SALES_INPUT'),sales=env.table('ENG_SALES_INPUT').filter(r=>r.plan_id===id);
 assert.equal(sales.length,count,'every in-window recognized record persists, including credits');assert.equal(Number(meta.last_row),count+1);assert.equal(Number(meta.max_rows),Math.max(1000,count+1),'capacity grows only to the required final row');assert.equal(meta.max_columns,before.max_columns,'no unrelated column expansion');
 assert.equal(Number(sales.at(-1).seq),count+1,'final partial chunk persists through native SAVE');
 const aggregate=env.runJob('PLAN.RUN',{planId:id,action:'SALES.AGGREGATE'});assert.equal(aggregate.status,'DONE',aggregate.error);
 const history=env.call('appEngLoadPlanSheets_(__pid,["SALES_MONTHLY"],true).SALES_MONTHLY.values',{__pid:id});
 assert.deepEqual(history[1].slice(1,49),expected.BASE);assert.deepEqual(history[2].slice(1,49),expected.SPOT);assert.deepEqual(history[3].slice(1,49),expected.BASE.map((v,i)=>v+expected.SPOT[i]),'48 month amounts unchanged by physical capacity');
 assert.deepEqual(env.table('ENG_ROWS').filter(r=>r.plan_id===id&&r.sheet==='OUTPUT'),outputBefore,'import/aggregate do not change existing prediction/budget output');assert.deepEqual(env.table('BUDGET_DRAFTS').filter(r=>r.plan_id===id),budgetBefore,'normal draft is preserved');
 const repeat=env.runJob('PLAN.RUN',{planId:id,action:'IMPORT.SALES'});assert.equal(repeat.status,'DONE',repeat.error);const repeated=env.table('ENG_SHEETS').find(r=>r.plan_id===id&&r.sheet==='SALES_INPUT');assert.equal(repeated.max_rows,meta.max_rows,'reimport does not keep appending physical rows');assert.equal(env.table('ENG_SALES_INPUT').filter(r=>r.plan_id===id).length,count,'reimport replaces records without duplicates');
 return {count,purpose,maxRows:Number(meta.max_rows)};
}
assert.equal(scenario(2821,'MEASURE').maxRows,2822);
assert.equal(scenario(2821,'').maxRows,2822);
assert.equal(scenario(12,'').maxRows,1000);
console.log('app-import-capacity: 2821 records MEASURE+normal native import/aggregate/save/reimport; small capacity and budget unchanged PASS');
