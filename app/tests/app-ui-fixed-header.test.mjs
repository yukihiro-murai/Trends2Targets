/** Shared header controls retain their slots across views and loading/empty/frozen states. Synthetic UI only. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {uiHtml,OWNER} from './gas-mock.mjs';

const js=uiHtml.slice(uiHtml.indexOf('<script>')+8,uiHtml.lastIndexOf('</script>'))
 .replace('<?!= charsJs ?>','var YOMI_POSE = new Proxy({}, {get:()=>""});var CHAR_SVG=new Proxy({}, {get:()=>""});')
 .replace('<?!= bootJson ?>',JSON.stringify({app:{name:'T',version:'x'},setUp:true,allowed:true,user:{email:OWNER,isOwner:true,isAdmin:true,roles:[{role:'ADMIN',scopeType:'ALL'}]}}));
const el=()=>({innerHTML:'',classList:{add(){},remove(){}},set outerHTML(v){}});
const ui=vm.createContext({document:{getElementById:el,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}},
 window:{innerWidth:1280,innerHeight:800,addEventListener(){}},setTimeout:()=>0,clearTimeout(){},confirm:()=>false,
 google:{script:{run:new Proxy({},{get:(t,k)=>k==='withSuccessHandler'||k==='withFailureHandler'?()=>ui.google.script.run:()=>{}})}}});
vm.runInContext(js,ui);
const run=(code,vars={})=>{Object.assign(ui,vars);return vm.runInContext(code,ui);};
const selects=h=>[...h.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)].map(m=>({attrs:m[1],options:m[2]}));
const checkSlots=(h,label)=>{const s=selects(h);assert.equal(s.length,2,label);assert.match(s[0].attrs,/aria-label="(?:年度|見る年度)"/,label);assert.match(s[1].attrs,/aria-label="メーカー"/,label);assert.doesNotMatch(h,/測る専用|管理者|所有者/,label);return s;};
const fy='<select class="inp sm" id="hm_fy" aria-label="見る年度" onchange="homeSetFy(this.value)"><option value="2026" selected>FY2026</option></select>';
const maker='<select class="inp sm" id="fc_mk" aria-label="メーカー" onchange="fcSwitch(this.value)"><option value="p1">架空製薬</option></select>';

for(const view of ['home','makers','budgets','analysis','learning']){
 const h=run('S.view=__view;headerTools(__tools)',{__view:view,__tools:fy+maker});
 const s=checkSlots(h,view);assert.match(s[1].attrs,/\bdisabled\b/,view);assert.match(s[1].options,/全メーカー/,view);
 if(view==='learning'){assert.match(s[0].attrs,/\bdisabled\b/);assert.match(s[0].options,/全年度/);}
 else{assert.match(s[0].attrs,/onchange="homeSetFy\(this.value\)"/);assert.doesNotMatch(s[0].attrs,/\bdisabled\b/);}
 checkSlots(run('headerTools("")'),view+' empty/loading');
}
run(`S.fc.plans=[{planId:'p1',clientName:'短い名前',fy:2026},{planId:'p2',clientName:'とても長い架空メーカーの名前',fy:2026}];S.fc.fy=2026;S.fc.planId='p1'`);
for(const view of ['prep','forecast','tri','budget']){
 run('S.view=__view',{__view:view});
 const h=run('headerTools(fcHeadSel(2026))'),s=checkSlots(h,view);
 assert.match(s[0].attrs,/id="fc_fy"/);assert.match(s[0].attrs,/onchange="fcSetFy\(this.value\)"/);
 assert.match(s[1].attrs,/id="fc_mk"/);assert.match(s[1].attrs,/onchange="fcSwitch\(this.value\)"/);assert.doesNotMatch(s[1].attrs,/\bdisabled\b|--selw/);
 const wait=checkSlots(run('headerTools(fcHeadSelWait(2026))'),view+' loading');assert.ok(wait.every(s=>/\bdisabled\b/.test(s.attrs)));
 const empty=checkSlots(run('headerTools(fcHeadSel(2099))'),view+' no plans in FY');assert.match(empty[1].attrs,/\bdisabled\b/);
 const closed=run(`headerTools('<span class="chip warn">締め済み</span>'+fcHeadSel(2026))`);
 const closedSlots=checkSlots(closed,view+' frozen');assert.doesNotMatch(closed,/class="chip/);assert.match(closedSlots[0].options,/<option value="2026" selected>FY2026・締め済み<\/option>/);assert.equal(closedSlots[1].attrs,s[1].attrs);
 assert.match(closedSlots[0].attrs,/title="締め済みの年度（読み取り専用）"/);assert.match(closedSlots[0].attrs,/aria-description="この年度は締め済みで、読み取り専用です"/);
}
run('S.fc.plans=[];S.fc.planId="";S.view="forecast"');
assert.match(checkSlots(run('headerTools(fcHeadSel(2026))'),'no plans')[1].attrs,/disabled/);
assert.equal(run('measureChip({measure:true})'),'');
const css=uiHtml.slice(uiHtml.indexOf('<style>'),uiHtml.indexOf('</style>'));
assert.match(css,/\.topbar\{[^}]*padding:0 var\(--gutter\)/);
assert.match(css,/\.hdrtools \.hdr-sels\{[^}]*grid-template-columns:var\(--col\) var\(--col2\);gap:var\(--s3\)/);
assert.match(css,/\.hdrtools \.hdr-sels\{width:100%;grid-template-columns:96px minmax\(0,1fr\)\}/);
console.log('Shared header: global/plan/loading/empty/frozen controls and release wording PASS');
