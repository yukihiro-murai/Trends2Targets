/** Canonical setup parity and native service forwarding contracts over synthetic data. */
import assert from 'node:assert/strict';
import{setUpEnv}from'./gas-mock.mjs';
let checks=0;
function setup(mode){
 const env=setUpEnv();
 const got=env.call(`(()=>{
  const ss=appWorkScratch_({time_zone:APP_TZ,locale:'ja_JP'}),rawInsert=ss.insertSheet;
  // Deterministic mock physical IDs let the GUIDE gid formulas compare exactly.
  // The production facade never changes IDs and forwards getSheetId unchanged.
  ss.insertSheet=function(name){const sh=rawInsert.call(ss,name);sh.getSheetId=()=>1000+APP_SETUP_ORDER.indexOf(name);return sh;};
  const token='SYNTHETIC_SETUP',stats={};appScratchReset_(ss,token);
  const opts={asOfMs:new Date(2026,3,6,12).getTime(),seed:token,actor:'synthetic@example.invalid',provisionalSetup:__mode==='fast'};
  const book=__mode==='counted'?appProvisionalSetupCosmeticBook_(ss,stats,false):ss;
  const runner=__mode==='fast'?appProvisionalFreshSetupBook_:appLegacySetupBook_;
  const engine=runner(book,opts,APP_SETUP_ORDER,'合成速度テスト製薬',2026,'',stats);
  appEnsureMinColumns_(ss);
  const snapshots=APP_SETUP_ORDER.map(name=>{const sh=ss.getSheetByName(name);return{name,id:sh.getSheetId(),snapshot:appSheetSnapshot_(sh,APP_ENGINE_SHEETS[name]?.header?.length||0)};});
  const encoded=snapshots.filter(s=>APP_ENGINE_SHEETS[s.name]).map(s=>appEngEncodeSheet_('SYNTHETIC_PLAN',s.snapshot));
  return{engine,snapshots,encoded,stats};
 })()`,{__mode:mode});
 return got;
}
const started=performance.now(),normal=setup('raw'),counted=setup('counted'),fast=setup('fast');
assert.deepEqual(fast.engine,normal.engine);assert.deepEqual(counted.snapshots,normal.snapshots);checks+=2;
assert.equal(normal.snapshots.length,28);assert.equal(fast.snapshots.length,28);checks+=2;
for(let i=0;i<28;i++){
 assert.equal(fast.snapshots[i].name,normal.snapshots[i].name);assert.equal(fast.snapshots[i].id,normal.snapshots[i].id);assert.deepEqual(fast.snapshots[i].snapshot,normal.snapshots[i].snapshot,normal.snapshots[i].name+' persisted snapshot');checks+=3;
}
for(let i=0;i<normal.encoded.length;i++){assert.deepEqual(fast.encoded[i],normal.encoded[i],'canonical encoded metadata/rows/formats/hash');checks++;}
const count=o=>Object.values(o).reduce((s,v)=>s+v,0),skipped=count(fast.stats.skipped),normalForward=count(counted.stats.forwarded),fastForward=count(fast.stats.forwarded);
assert.ok(skipped>0,'cosmetic setter calls suppressed');assert.equal(count(counted.stats.skipped),0);assert.ok(normalForward-fastForward>=skipped);checks+=3;
for(const name of['range.setValues','range.setFormula','range.setNumberFormat','range.clearFormats','range.setNote','range.setDataValidation','range.merge']){
 assert.ok((fast.stats.forwarded[name]||0)<=(counted.stats.forwarded[name]||0),name+' forwarded call count');assert.equal(fast.stats.skipped[name]||0,0);checks+=2;
}
// Native-identity and stateful-contract sentinel: mock GAS does not model DV/merge state.
const env=setUpEnv();
const sentinel=env.call(`(()=>{
 const log=[],range={setValue(v){log.push(['value',v]);return this;},setFormula(v){log.push(['formula',v]);return this;},setNumberFormat(v){log.push(['numberformat',v]);return this;},clearFormat(){log.push(['clearformat']);return this;},setDataValidation(v){log.push(['validation',v.tag]);return this;},merge(){log.push(['merge']);return this;},breakApart(){log.push(['breakApart']);return this;},setNote(v){log.push(['note',v]);return this;},copyTo(other){if(other!==range)throw new Error('proxy range leaked');log.push(['copyTo']);return this;},setBackground(v){log.push(['background',v]);return this;},getMergedRanges(){return[range];},getValue(){return 17;}};
 const sheet={getRange(){return range;},getDataRange(){return range;},getSheetId(){return 91;},setColumnWidth(){log.push(['width']);return this;}};
 const book={getSheetByName(){return sheet;},getSheets(){return[sheet];},setActiveSheet(s){if(s!==sheet)throw new Error('proxy sheet leaked');return s;}};
 const stats={},p=appProvisionalSetupCosmeticBook_(book,stats,true),sh=p.getSheetByName('x'),r=sh.getRange(1,1);
 if(p.getSheets()[0]!==sh||r!==sh.getDataRange())throw new Error('native wrapper identity changed');
 r.setBackground('red').setValue(8).setFormula('=1+1').setNumberFormat('0.00').clearFormat().setDataValidation({tag:'kept'}).merge().breakApart().setNote('kept').copyTo(r);
 p.setActiveSheet(sh);sh.setColumnWidth(1,20);r.getMergedRanges()[0].setValue(9);
 return{log,id:sh.getSheetId(),value:r.getValue(),stats};
})()`);
assert.deepEqual(sentinel.log,[['value',8],['formula','=1+1'],['numberformat','0.00'],['clearformat'],['validation','kept'],['merge'],['breakApart'],['note','kept'],['copyTo'],['value',9]]);assert.equal(sentinel.id,91);assert.equal(sentinel.value,17);checks+=3;
const extra=env.call(`(()=>{
 const log=[],nativeRange={setValue(){log.push('value');return this;}},sub={addRange(r){if(r!==nativeRange)throw new Error('subtype proxy leaked');log.push('chartRange');return this;},build(){return {type:'chart'};}},builder={asLineChart(){return sub;}};
 const sh={getRange(){return nativeRange;},getSheetId(){return 42;},showSheet(){throw new Error('native show');},hideSheet(){throw new Error('native hide');},isSheetHidden(){return false;},newChart(){return builder;}};
 const b={getSheetByName(){return sh;},setActiveSheet(){throw new Error('native activate');},getActiveSheet(){throw new Error('native active read');},moveActiveSheet(){throw new Error('native move');}};
 const p=appProvisionalSetupCosmeticBook_(b,{},true,{freshSetup:true}),s=p.getSheetByName('a');
 if(p.setActiveSheet(s)!==s||p.getActiveSheet()!==s)throw new Error('virtual active mismatch');
 p.moveActiveSheet(1);s.hideSheet();if(!s.isSheetHidden())throw new Error('hidden read mismatch');s.showSheet();if(s.isSheetHidden())throw new Error('shown read mismatch');
 s.newChart().asLineChart().addRange(s.getRange(1,1)).build();
 let rejected=false;try{appProvisionalFreshSetupBook_(b,{},[],'a',2026,'');}catch(e){rejected=true;}
 return{log,rejected,id:s.getSheetId()};
})()`);assert.deepEqual(extra.log,['chartRange']);assert.equal(extra.rejected,true);assert.equal(extra.id,42);checks+=3;
console.log('PASS app-provisional-setup: '+checks+' assertions; canonical data and formats unchanged');
