#!/usr/bin/env node
/* Persisted latest-run months must render even when a transported OUTPUT has no monthly section. All data synthetic. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const html = fs.readFileSync(new URL('../src/UI.html', import.meta.url), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'))
  .replace('<?!= charsJs ?>', 'var YOMI_POSE=new Proxy({},{get:()=>""});var CHAR_SVG=new Proxy({},{get:()=>""});')
  .replace('<?!= bootJson ?>', JSON.stringify({app:{name:'Test',version:'test'},user:{email:'test@example.invalid',isOwner:true,isAdmin:true,roles:[{role:'ADMIN',scopeType:'ALL'}]},setUp:true,allowed:true}));
const element = {innerHTML:'',classList:{add(){},remove(){}},set outerHTML(v){}};
const calls = [];
const rpc = new Proxy({}, {get:(_,k)=>k==='withSuccessHandler'||k==='withFailureHandler'?()=>rpc:(...args)=>calls.push([k,args])});
const context = vm.createContext({document:{getElementById:()=>element,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}},
  setTimeout:()=>0,clearTimeout(){},confirm:()=>false,window:{addEventListener(){},innerWidth:1280,innerHeight:800,sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}}},google:{script:{run:rpc}}});
vm.runInContext(script,context);
const run=(code,vars={})=>{Object.assign(context,vars);return vm.runInContext(code,context);};
const clone=x=>structuredClone(x), plain=x=>JSON.parse(JSON.stringify(x));
const digest=x=>createHash('sha256').update(x).digest('hex');
const months=Array.from({length:12},(_,i)=>`${2026+Math.floor((i+3)/12)}/${String((i+3)%12+1).padStart(2,'0')}`);
const annual={p10:900000,p50:1800000,p90:3200000,adopted:1200000,uplift:12000,final:1212000};
const outputMonths=months.map((month,i)=>({row:29+i,month,p10:1,p50:111,p90:222,adopted:100000,uplift:1000,final:101000}));
const fullView={plan:{planId:'P-SAVED',fy:2026,measure:false},can:{plan:true},boot:{output:{sections:[{annual:{...annual,p10:700000,p50:1200000,p90:2400000},monthly:outputMonths}]}}};
const saved=months.map((ym,i)=>({plan_id:'P-SAVED',run_id:'RUN-LATEST',ym,p10:100+i,p50:1000+i,p90:2000+i,obj_p10:50+i,obj_p50:500+i,obj_p90:1500+i}));
const planning={version:'HISTORY_MONTHLY_POINT_V2',applied:true,method:'BB_EQUAL_WEIGHT_W_AA_COMBINATION',provisional:true,validationStatus:'in_progress',
  pointPolicySha256:'a'.repeat(64),pointPolicySourceSha256:'b'.repeat(64),annualRawP50:annual.p50,annualTarget:480000,
  months:months.map((ym,i)=>({ym,point:(i+1)*5000+(i===11?90000:0),share:1/12,mean:50000+i}))};
assert.equal(planning.months.reduce((s,m)=>s+m.point,0),planning.annualTarget);
const data={plan:{planId:'P-SAVED',fy:2026},latest:{plan_id:'P-SAVED',run_id:'RUN-LATEST',annual_p10:annual.p10,annual_p50:annual.p50,annual_p90:annual.p90},monthly:saved,planning};
run("S.fc.planId='P-SAVED';S.fc.budget={};S.cv.fcMonthly='table';S.cv.fcBudgetM='table';S.job=null;");
run('var __savedChartLine=chartLine;chartLine=function(series,opts){__savedChart={series:series,opts:opts};return __savedChartLine(series,opts);};');
const render=(d=data,v=fullView,mode='result')=>run('S.fc.view=__view;fcMonthlyTab(__data,__view,__mode)',{__data:d,__view:v,__mode:mode});
const chart=()=>plain(run('__savedChart'));
const table=h=>/<table class="tbl scroll[^>]*>[\s\S]*?<\/table>/.exec(h)?.[0];
const rows=t=>[...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m=>[...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c=>c[1]));
const before=JSON.stringify({data,fullView}), callsBefore=calls.length;

// Empty, missing and annual-only transported OUTPUT must not suppress the saved twelve months.
const empty=clone(fullView);empty.boot.output.sections[0].monthly=[];
const emptyHtml=render(data,empty);
assert.match(emptyHtml,/月次予測の合計（暫定）/);
assert.deepEqual(rows(table(emptyHtml))[0],['月','下振れ','月次予測','上振れ']);
assert.equal(rows(table(emptyHtml)).length,14);
assert.deepEqual(rows(table(emptyHtml)).at(-1),['年度合計','900,000','480,000','3,200,000']);
assert.deepEqual(chart().series[0],{label:'月次予測',values:planning.months.map(m=>m.point)});
assert.deepEqual(chart().opts.band,saved.map(m=>({lo:m.p10,hi:m.p90})));
assert.equal(chart().opts.h,280);
assert.equal((table(emptyHtml).match(/<col(?: |>|\/)/g)||[]).length,4);
for(const output of [null,{sections:[]},{sections:[{annual}]}]){const v=clone(fullView);v.boot.output=output;assert.equal(render(data,v),emptyHtml);}
assert.equal(render(),emptyHtml,'stale full OUTPUT is also superseded by latest saved risk and months');
const detail=/<details class="mt12">([\s\S]*?)<\/details>/.exec(emptyHtml)[1];
assert.deepEqual(rows(table(detail)).slice(1,13),saved.map((m,i)=>[months[i],(1000+i).toLocaleString('en-US')]));
assert.deepEqual(rows(table(detail)).at(-1),['年度中央値','1,800,000']);

// The unchanged web parser currently skips typed-Date OUTPUT labels, while stored FORECAST_MONTHLY is complete.
const web=fs.readFileSync(new URL('../../Forecast_WebApp.js',import.meta.url),'utf8');
const parser=web.slice(web.indexOf('function webParseOutput_(ss)'),web.indexOf('/** DASHBOARD + EVAL_COMPARE_MONTHLY'));
const parseContext=vm.createContext({SHEETS:{OUTPUT:'OUTPUT'}});vm.runInContext(parser,parseContext);
const rawOutput=Array.from({length:44},()=>Array(10).fill(''));
rawOutput[25]=['年度合計（予測）',annual.p10,annual.p50,annual.p90,0,0,0,annual.adopted,annual.uplift,annual.final];
saved.forEach((m,i)=>{rawOutput[28+i]=[new Date(months[i].replace('/','-')+'-01T00:00:00+09:00'),m.p10,m.p50,m.p90,0,0,0,100000,1000,101000];});
const parsed=values=>{parseContext.__book={getSheetByName:()=>({getLastRow:()=>values.length,getDataRange:()=>({getValues:()=>values})})};return vm.runInContext('webParseOutput_(__book)',parseContext);};
const dateParsed=parsed(rawOutput);assert.equal(dateParsed.sections[0].monthly.length,0,'actual typed-Date parser gap reproduced without changing calculator source');
const typedView=clone(fullView);typedView.boot.output=plain(dateParsed);assert.equal(render(data,typedView),emptyHtml,'saved canonical months repair the typed-Date view gap');
const stringOutput=rawOutput.map(r=>r.slice());months.forEach((ym,i)=>{stringOutput[28+i][0]=ym;});
const stringParsed=parsed(stringOutput);assert.equal(stringParsed.sections[0].monthly.length,12);

// Month keys, not wire order, define the canonical fiscal year. Old W planning uses the same saved path.
const reversed=clone(data);reversed.monthly.reverse();reversed.monthly.forEach(m=>{m.ym=m.ym.replace('/','-');});
assert.equal(render(reversed,empty),emptyHtml);
const oldW=clone(data);oldW.planning.method='W_COMPONENT_EVENT_HALF_SHAPE_BLEND';delete oldW.planning.pointPolicySha256;delete oldW.planning.pointPolicySourceSha256;
assert.match(render(oldW,empty),/月次予測の合計（暫定）/);
assert.equal(render(oldW),render(oldW,empty),'complete OUTPUT legacy W remains joined to latest months');
const sameOutput=clone(fullView);sameOutput.boot.output=plain(stringParsed);const legacyW=clone(oldW);delete legacyW.monthly;
assert.equal(render(oldW,sameOutput),render(legacyW,sameOutput),'matching full OUTPUT legacy W retains identical HTML');
const noPoint=clone(data);delete noPoint.planning;
render(noPoint,empty);assert.deepEqual(chart().series[0].values,saved.map(m=>m.p50),'no planning still shows canonical raw median');

// Explicit malformed or foreign saved rows never receive the current BB point overlay; old OUTPUT is retained.
const legacy=clone(data);delete legacy.planning;delete legacy.monthly;
const retained=render(legacy);
for(const mutate of [d=>d.monthly.pop(),d=>d.monthly.push(clone(d.monthly[0])),d=>d.monthly[0].run_id='RUN-OLD',d=>d.monthly[0].plan_id='P-OTHER',
  d=>d.latest.plan_id='P-OTHER',d=>d.latest.run_id='',d=>d.monthly[1].ym=d.monthly[0].ym,d=>d.monthly[0].ym='2025/04',
  d=>d.monthly[0].ym='2026/13',d=>d.monthly[0].p50='1000',d=>d.monthly[0].p50=NaN,d=>d.monthly[0].p90=Infinity,
  d=>d.monthly[0].p10=-1,d=>d.monthly[0].p10=d.monthly[0].p50+1,d=>d.monthly[0]=null,d=>d.monthly=null,
  d=>d.plan.fy=2025,d=>d.latest.annual_p10=d.latest.annual_p50+1]){
  const bad=clone(data);mutate(bad);const badLegacy=clone(bad);delete badLegacy.planning;delete badLegacy.monthly;
  assert.equal(run('fcResultMonthly(__d)',{__d:bad}),null);assert.equal(render(bad),render(badLegacy),'invalid canonical rows retain OUTPUT without BB overlay');
  assert.doesNotMatch(render(bad,empty),/月次予測|中央値を見る/);
}
const foreign=clone(data);run("S.fc.planId='P-OTHER';");assert.equal(run('fcResultMonthly(__d)',{__d:foreign}),null);run("S.fc.planId='P-SAVED';");

// No persisted-month field means an older payload: keep its original OUTPUT behavior.
const oldPayload=clone(data);delete oldPayload.monthly;
assert.match(render(oldPayload),/月次予測/);
assert.deepEqual(chart().opts.band,outputMonths.map(m=>({lo:m.p10,hi:m.p90})));

// Budget rows, inputs, adopted/uplift/final values and whole HTML remain on OUTPUT.
const budget=render(data,fullView,'budget');
assert.equal(budget,render(legacy,fullView,'budget'));
const corrupt=clone(data);corrupt.monthly[0].run_id='RUN-OTHER';corrupt.planning.months[0].point=999999;
assert.equal(render(corrupt,fullView,'budget'),budget);
assert.deepEqual(chart().series.map(s=>s.values),[outputMonths.map(m=>m.p50),outputMonths.map(m=>m.final)]);
assert.match(budget,/value="100,000"/);
assert.match(budget,/value="1,000"/);
assert.equal(JSON.stringify({data,fullView}),before,'rendering never changes saved risk/planning/OUTPUT');
assert.equal(calls.length,callsBefore,'rendering starts no RPC/save/learning');
console.log('PASS app-ui-saved-monthly: canonical latest12, absent/stale OUTPUT, strict run/FY/risk guards, legacy planning and budget isolation; budget SHA '+digest(budget));
