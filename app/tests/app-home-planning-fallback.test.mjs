/** Synthetic bootstrap->cold makers list, without an apiPortfolio response. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setUpEnv, uiHtml } from './gas-mock.mjs';
const env=setUpEnv(),FY=2026;
const output=[['合成予測']];while(output.length<25)output.push([]);
output.push(['年度合計（予測）',0,0,0],[],['月','P10','P50','P90','','','','採用予測','上乗せ']);
for(let i=0;i<12;i++)output.push([new Date(FY,3+i,1),0,0,0,'','','',0,0]);
const id=env.seedPlan(env.makeBook('合成暫定計画',{CONFIG:{values:[['項目','値'],['メーカー','合成暫定製薬'],['FY',FY],['担当者','']]},OUTPUT:{values:output}}));
const months=Array.from({length:12},(_,i)=>`${FY+Math.floor((i+3)/12)}/${String((i+3)%12+1).padStart(2,'0')}`);
const planning=target=>({version:'HISTORY_MONTHLY_POINT_V2',applied:true,method:'W_COMPONENT_EVENT_HALF_SHAPE_BLEND',annualRawP50:0,annualTarget:target,annualBasis:'sum_monthly_points',trainingThroughYm:'2026/03',months:months.map(ym=>({ym,point:target/12,share:1/12,mean:0})),provisional:true,validationStatus:'in_progress',halfTargets:[target/2,target/2],provisionalWeights:[0,0],provisionalFolds:[2024,2025],provisionalMode:'complete_S',provisionalRescue:'none'});
env.run(`appWithLock_(()=>{appPatchRow_('PLANS',{plan_id:__pid},{purpose:'MEASURE'},'synthetic');appJournalRun_({actor:'synthetic'},'synthetic planning records',__pid,[{table:'FORECAST_RUNS',mode:'ensure',rows:__runs}]);});`,{__pid:id,__runs:[
 {run_id:'RUN-SYNTH-PREV',plan_id:id,status:'DONE',annual_p10:0,annual_p50:0,annual_p90:0,planning_json:JSON.stringify(planning(300000)),finished_at:'2026-10-17T00:00:00Z'},
 {run_id:'RUN-SYNTH-NOW',plan_id:id,status:'DONE',annual_p10:0,annual_p50:0,annual_p90:0,planning_json:JSON.stringify(planning(390000)),finished_at:'2026-10-18T00:00:00Z'}]});
const portfolio=env.call('apiPortfolio()'),boot=env.boot(),row=boot.home.plans.find(p=>p.planId===id);
assert.equal(portfolio.plans[0].forecastPointAnnual,390000);
assert.equal(row.forecastPointAnnual,390000,'bootstrap home projection carries current point even when annual P50 is0');
assert.equal(row.forecastPointProvisional,true);assert.equal(row.previousForecastPointAnnual,300000);
assert.equal(row.p50,0,'raw annual median remains unchanged');assert.equal(row.prevP50,0);
assert.equal(boot.home.totals.plans,0,'MEASURE remains excluded from home totals');
const js=uiHtml.slice(uiHtml.indexOf('<script>')+8,uiHtml.lastIndexOf('</script>')).replace('<?!= charsJs ?>','var YOMI_POSE=new Proxy({},{get:()=>""});var CHAR_SVG=new Proxy({},{get:()=>""});').replace('<?!= bootJson ?>',JSON.stringify(boot));
const el={innerHTML:'',classList:{add(){},remove(){}},set outerHTML(v){}};const calls=[];
const runner=new Proxy({},{get:(_,k)=>k==='withSuccessHandler'||k==='withFailureHandler'?()=>runner:(...a)=>calls.push([k,a])});
const ui=vm.createContext({document:{getElementById:()=>el,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}},setTimeout:()=>0,clearTimeout(){},window:{addEventListener(){},innerWidth:1280,innerHeight:800,sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}}},google:{script:{run:runner}}});vm.runInContext(js,ui);
const run=(code,vars={})=>{Object.assign(ui,vars);return vm.runInContext(code,ui);};
run("S.view='makers';S.pf=null;S.mkFy='2026';S.ld.mk={loading:true};");
const before=JSON.stringify(boot.home.plans),cold=run('viewMakers()');
assert.match(cold,/390,000/,'cold list uses monthly forecast sum from bootstrap, without waiting for portfolio RPC');assert.match(cold,/月次予測の合計（暫定）/);assert.match(cold,/30\.0%/);
run("S.ld.mk={error:'synthetic failed apiPortfolio',at:Date.now()};");assert.equal(run('viewMakers()'),cold,'failed portfolio RPC retains the correct bootstrap forecast point');
assert.equal(run('S.pf'),null);assert.equal(run('B.home.plans[0].p50'),0);assert.equal(JSON.stringify(boot.home.plans),before,'rendering does not replace stored medians or home totals');
run('S.pf=__plans;',{__plans:portfolio.plans});assert.equal(run('viewMakers()'),cold,'cold bootstrap and loaded portfolio render identically');
console.log('app-home-planning-fallback: bootstrap/cold list/error fallback/portfolio equality and isolation PASS');
