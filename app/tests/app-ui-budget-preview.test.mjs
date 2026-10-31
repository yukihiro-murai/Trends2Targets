#!/usr/bin/env node
/** Synthetic UI regression: typing only updates the preview; applying is an explicit, local draft operation. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { uiHtml, OWNER } from './gas-mock.mjs';

function makeUi({base = Array(12).fill(100000), uplift = Array(12).fill(0), factor = 1} = {}) {
  const elements = {}, rpc = [], docEvents = {}, windowEvents = {}, mutations = [];
  let equation = null, mounted = false;
  const text = html => String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ');
  let document;
  function element(id, attrs = '') {
    let html = '', content = '';
    const attributes = Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1],m[2]]));
    const node = { id, tagName:'DIV', value:attributes.value || '', className:attributes.class || '', disabled:/\bdisabled\b/.test(attrs), selectionStart:null, selectionEnd:null, isConnected:true,
      classList:{add(){},remove(){}}, querySelector(){return null;},querySelectorAll(){return [];},
      getAttribute(k){return attributes[k] || null;},hasAttribute(k){return k in attributes;},setAttribute(k,v){attributes[k]=String(v);},
      closest(){return elements.main || null;},focus(){document.activeElement=node;},setSelectionRange(a,b){node.selectionStart=a;node.selectionEnd=b;},
      getBoundingClientRect(){return {top:0,bottom:0,left:0,right:100,width:100,height:40};},
      get innerHTML(){return html;},set innerHTML(v){html=String(v);content=text(v);mutations.push(id);if(id==='bud_preview'||id==='main')equation=null;parse(html);},
      get textContent(){return content;},set textContent(v){content=String(v);html=String(v);mutations.push(id);},
      get outerHTML(){return html;},set outerHTML(v){html=String(v);content=text(v);mutations.push(id);parse(html);},
    };
    return node;
  }
  function parse(html) {
    for(const m of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
      const n=element(m[3],m[2]);n.tagName=m[1].toUpperCase();elements[m[3]]=n;
    }
    const eq=/<div\b([^>]*class="[^"]*\bbud-eq\b[^"]*"[^>]*)>([\s\S]*?)<\/div>/.exec(html);
    if(eq){
      const id=/\bid="([^"]+)"/.exec(eq[1]);
      equation=id&&elements[id[1]]?elements[id[1]]:element('equation',eq[1]);
      // This content has no nested div, so assigning it cannot remount input controls.
      equation.innerHTML=eq[2];
    }
  }
  const get=id=>mounted ? (elements[id] || null) : (elements[id] ||= element(id));
  for(const id of ['main','nav','hdrTools','toast','askwrap','tipbox'])get(id);
  document={activeElement:null,getElementById:get,querySelector(selector){
    if(selector==='.bud-eq'||selector.endsWith(' .bud-eq'))return equation;
    if(selector.startsWith('#'))return elements[selector.slice(1)] || null;
    return null;
  },querySelectorAll(){return [];},addEventListener(k,f){(docEvents[k] ||= new Set()).add(f);}};
  const runner=()=>{const handlers={};const proxy=new Proxy(handlers,{get(o,k){
    if(k==='withSuccessHandler')return fn=>{o.ok=fn;return proxy;};if(k==='withFailureHandler')return fn=>{o.fail=fn;return proxy;};
    return (...args)=>rpc.push({name:String(k),args,...o});
  }});return proxy;};
  const script=uiHtml.slice(uiHtml.indexOf('<script>')+8,uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>','var YOMI_POSE=new Proxy({},{get:()=>""});var CHAR_SVG=new Proxy({},{get:()=>""});')
    .replace('<?!= bootJson ?>',JSON.stringify({app:{name:'T',version:'test'},setUp:true,allowed:true,user:{email:OWNER,isOwner:true,isAdmin:true,roles:[{role:'ADMIN',scopeType:'ALL'}]},home:{fy:'2027',fyOptions:['2027'],plans:[]}}));
  const ui=vm.createContext({document,window:{innerWidth:1280,innerHeight:800,addEventListener(k,f){(windowEvents[k] ||= new Set()).add(f);},removeEventListener(k,f){windowEvents[k]?.delete(f);},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}}},
    setTimeout(){return 0;},clearTimeout(){},console:{log(){},error(){}},google:{script:{get run(){return runner();}}}});
  vm.runInContext(script,ui);
  const run=(code,vars={})=>{Object.assign(ui,vars);return vm.runInContext(code,ui);};
  const monthly=base.map((p50,i)=>({row:29+i,month:(i<9?'2027':'2028')+'/'+String((i+3)%12+1).padStart(2,'0'),p10:p50*.8,p50,p90:p50*1.2,adopted:p50,uplift:uplift[i],final:p50+uplift[i]}));
  run(`S.homePre=true;FC_PRE_MAX=0;S.view='budget';S.fc.planId='p1';S.fc.draftPlan='p1';S.fc.data={plan:{planId:'p1',fy:2027},latest:{annual_p50:__sum}};S.fc.view={plan:{planId:'p1',fy:2027},can:{plan:true},boot:{output:{sections:[{monthly:__monthly}]}}};S.fc.basis={planId:'p1',calibration:{factor:__factor},triangulation:{sums:{FINAL:__sum}}};S.fc.budget={};`,{__sum:base.reduce((a,b)=>a+b,0),__monthly:monthly,__factor:factor});
  get('main').innerHTML=run('fcBudgetCompose(S.fc.data,S.fc.view)');
  const input=get('bud_extra');input.tagName='INPUT';document.activeElement=input;mounted=true;
  run('var __renderCount=0;render=function(){__renderCount++};');
  mutations.length=0;rpc.length=0;
  const type=value=>{input.value=value;run('fcBudSetExtra(__value)',{__value:value});for(const f of docEvents.input || [])f({type:'input',target:input,isTrusted:true});};
  const equationText=()=>equation?equation.textContent:(elements.bud_preview ? elements.bud_preview.textContent : '');
  return {run,type,rpc,input,document,elements,mutations,equationText};
}
const normalized=s=>s.replace(/\s+/g,' ');
const assertFinal=(u,n)=>{const m=/→\s*(-?[\d,]+)\s*円/.exec(normalized(u.equationText()));assert.ok(m,'visible final amount is available');assert.equal(Number(m[1].replace(/,/g,'')),n,'visible final rounded amount');};

// Regression: typing 120,000 instantly updates the visible preview without RPC, full render, or overwriting existing manual drafts.
{
  const u=makeUi();
  u.run("S.fc.budget={29:{adopted:'777',uplift:'888'}}");
  const before=u.run('JSON.stringify(S.fc.budget)'), input=u.input;
  input.selectionStart=3;input.selectionEnd=3;
  u.type('120,000');
  assertFinal(u,1320000);
  assert.equal(u.run('S.fc.budPick.extra'),'120000');
  assert.equal(u.run('JSON.stringify(S.fc.budget)'),before,'typing must not replace hand-edited monthly drafts');
  assert.equal(u.run('__renderCount'),0,'typing updates only the preview region');
  assert.equal(u.elements.bud_extra,input,'the input element is retained');
  assert.equal(input.value,'120,000','do not reformat a field while the user is typing');
  assert.equal(input.selectionStart,3);assert.equal(input.selectionEnd,3);assert.equal(u.document.activeElement,input);
  assert.equal(u.run('fcDirty()'),true);assert.equal(u.run('FC_LEAVE_ARMED'),true);
  assert.deepEqual(u.rpc,[],'typing never calls an API');
}

// Empty means keeping existing monthly uplifts; explicit zero means replacing them with zeros.
{
  const u=makeUi({uplift:Array.from({length:12},(_,i)=>(i+1)*10)});
  for(const [value,final] of [['120,000',1320000],['0',1200000],['-120',1199880],['',1200780]]) {
    u.type(value);assertFinal(u,final);assert.deepEqual(u.rpc,[]);
  }
  u.run('fcBudApply()');
  const budget=JSON.parse(u.run('JSON.stringify(S.fc.budget)'));
  assert.deepEqual(Object.values(budget).map(r=>Number(r.uplift)),Array.from({length:12},(_,i)=>(i+1)*10));
  assert.equal(u.run('S.fc.budPick.dirty'),false,'apply clears only unapplied composition dirtiness');
  assert.equal(u.run('fcDirty()'),true,'the resulting monthly drafts still need saving');
  assert.deepEqual(u.rpc,[],'applying to local monthly drafts does not save');
}

// Per-month rounding and residual distribution are reflected in the preview, then match the explicit Apply result.
for(const [base,factor,extra,bases,extras,total] of [
  [Array(12).fill(1),.5,'5',Array(12).fill(1),[0,0,0,0,0,0,0,0,0,0,0,5],17],
  [Array(12).fill(0),1,'5',Array(12).fill(0),[0,0,0,0,0,0,0,0,0,0,0,5],5],
  [Array(12).fill(1),1,'-5',Array(12).fill(1),[0,0,0,0,0,0,0,0,0,0,0,-5],7],
  [Array(12).fill(1),1,'1.5',Array(12).fill(1),[0,0,0,0,0,0,0,0,0,0,0,2],14],
]) {
  const u=makeUi({base,factor});u.type(extra);assertFinal(u,total);
  assert.equal(u.run('Object.keys(S.fc.budget).length'),0,'preview has no monthly write effect');
  u.run('fcBudApply()');
  const budget=JSON.parse(u.run('JSON.stringify(S.fc.budget)'));
  assert.deepEqual(Object.values(budget).map(r=>Number(r.adopted)),bases);
  assert.deepEqual(Object.values(budget).map(r=>Number(r.uplift)),extras);
  assert.equal(Object.values(budget).reduce((s,r)=>s+Number(r.adopted)+Number(r.uplift),0),total);
  assert.deepEqual(u.rpc,[]);
}

// An incomplete/nonfinite number does not masquerade as zero and cannot be applied to the monthly drafts.
for(const value of ['-', '1e', 'NaN', 'Infinity', '1e20']) {
  const u=makeUi();
  u.run("S.fc.budget={29:{adopted:'777',uplift:'888'}}");
  const before=u.run('JSON.stringify(S.fc.budget)');
  u.type(value);
  assert.match(u.equationText(),value==='1e20'?/金額が大きすぎます/:/追加額は数で入れてください/);
  assert.doesNotMatch(u.equationText(),/→\s*-?[\d,]+\s*円/,'do not publish a confirmed total while input is invalid');
  assert.equal(u.elements.bud_apply.disabled,true,'invalid input disables Apply');
  assert.equal(u.run('__renderCount'),0,'typing invalid text retains the same input/cursor');
  assert.equal(u.input.value,value);
  assert.equal(u.run('JSON.stringify(S.fc.budget)'),before);
  assert.deepEqual(u.rpc,[]);
  u.run('fcBudApply()');
  assert.equal(u.run('JSON.stringify(S.fc.budget)'),before,'an old click cannot apply invalid text');
  assert.deepEqual(u.rpc,[]);
  u.type('120000');
  assert.equal(u.elements.bud_apply.disabled,false,'a valid edit re-enables Apply');
  assertFinal(u,1320000);
}

// An unsafe annual subtotal or uplift cannot become valid merely because their cancellation produces a safe final total.
for(const [base,uplift,extra] of [
  [Array(12).fill(1000000000000000),Array(12).fill(0),'-4000000000000000'], // only adopted annual subtotal is unsafe
  [Array(12).fill(100000),Array(12).fill(0),'-9007199254740993'], // unsafe explicit amount rounds away one yen
  [Array(12).fill(500000000000000),Array(12).fill(-1000000000000000),''], // only existing uplift subtotal is unsafe
  [Array(12).fill(1000000000000000),Array(12).fill(0),'-11999999999999999'], // unsafe cancellation must not publish zero
]) {
  const u=makeUi({base,uplift});
  u.run("S.fc.budget={29:{adopted:'777',uplift:'888'}}");
  const before=u.run('JSON.stringify(S.fc.budget)');
  u.type(extra);
  assert.match(u.equationText(),/金額が大きすぎます/,'unsafe subtotal is rejected before publishing a rounded-away result');
  assert.doesNotMatch(u.equationText(),/→\s*-?[\d,]+\s*円/);
  assert.equal(u.elements.bud_apply.disabled,true);
  u.run('fcBudApply()');
  assert.equal(u.run('JSON.stringify(S.fc.budget)'),before);
  assert.deepEqual(u.rpc,[]);
}

// In-flight saving/starting/jobs cannot alter the composition, preview or drafts, even if an old event reaches a disabled control.
for(const busy of ['S.writing=true','S.starting=true',"S.job={id:'busy'}"]) {
  const u=makeUi();u.type('120000');
  const before=u.run('JSON.stringify([S.fc.budPick,S.fc.budget])'), preview=u.equationText();
  u.run(busy);u.type('999999');u.run('fcBudApply()');
  assert.equal(u.run('JSON.stringify([S.fc.budPick,S.fc.budget])'),before);
  assert.equal(u.equationText(),preview);
  assert.deepEqual(u.rpc,[]);
}
console.log('app-ui-budget-preview: input-following DOM, cursor, manual drafts, zero/empty/negative, monthly rounding and busy guards PASS');
