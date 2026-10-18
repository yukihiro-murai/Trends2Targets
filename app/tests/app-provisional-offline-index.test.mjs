/** First-match conflict/readback lookup parity, synthetic only; no model/service calls. */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const actual=fs.readFileSync(new URL('../src/ProvisionalOffline.js',import.meta.url),'utf8');
const schema=fs.readFileSync(new URL('../src/Schema.js',import.meta.url),'utf8');
const store=fs.readFileSync(new URL('../src/Store.js',import.meta.url),'utf8');
// Independent original linear-search behavior is the oracle, including error text.
const oracle=`
function preOriginal() {
 Object.keys(checked.tables).forEach(t=>{const def=APP_TABLES[t],have=appReadTable_(t),key=row=>def.key.map(k=>String(row[k])).join('\\u0001');checked.tables[t].forEach(row=>{
  const globalKey=t+'\\u0001'+key(row);appOfflineAssert_(!globalKeys[globalKey],'cross-plan duplicate global key: '+t);globalKeys[globalKey]=true;
  const old=have.find(v=>key(v)===key(row));
  appOfflineAssert_(!old||receipt&&receipt.bundleSha256===input.sha256&&appOfflineSame_(appObjectToRow_(def,old),appObjectToRow_(def,row)),'existing global key conflict: '+t);
 }); }); verified.push(checked);
}
// Re-read exact native rows
function postOriginal() {
 Object.keys(next.tables).forEach(t=>{const def=APP_TABLES[t],have=appReadTable_(t),key=row=>def.key.map(k=>String(row[k])).join('\\u0001');next.tables[t].forEach(row=>{const old=have.find(v=>key(v)===key(row));appOfflineAssert_(old&&appOfflineSame_(appObjectToRow_(def,old),appObjectToRow_(def,row)),'post-import row mismatch: '+t);});});
    const readiness=null;
}
`;
function loops(s){let a=s.indexOf('Object.keys(checked.tables).forEach'),z=s.indexOf(' verified.push(checked);',a);assert.ok(a>=0&&z>a);const pre=s.slice(a,z);a=s.indexOf('Object.keys(next.tables).forEach',s.indexOf('// Re-read exact native rows'));z=s.indexOf('\n    const readiness=',a);assert.ok(a>=0&&z>a);return{pre,post:s.slice(a,z)};}
const normalize=store.slice(store.indexOf('function appObjectToRow_('),store.indexOf('\n/** 表の全行',store.indexOf('function appObjectToRow_(')));
function env(src){const l=loops(src);let keyCalls=0,reads=0,have={};const e=vm.createContext({Map,JSON,String,Number,isFinite,appJson_:v=>JSON.stringify(v),appReadTable_:t=>{reads++;return have[t]||[];},appOfflineSame_:(a,b)=>JSON.stringify(a)===JSON.stringify(b),appOfflineAssert_:(v,m)=>{if(!v)throw Error(m);}});vm.runInContext(schema+'\n'+normalize+'\nfunction pre(checked,receipt,input){const globalKeys={};'+l.pre+'return globalKeys;}function post(next){'+l.post+'}\nglobalThis.schema=APP_TABLES;',e);return{e,set(tables,defs){have=tables;keyCalls=0;reads=0;if(defs)for(const[t,raw]of Object.entries(defs)){const def=structuredClone(raw),keys=def.key;keys.map=function(fn){keyCalls++;return Array.prototype.map.call(this,fn);};e.schema[t]=def;}else for(const def of Object.values(e.schema)){if(def.key.__counted)continue;def.key.map=function(fn){keyCalls++;return Array.prototype.map.call(this,fn);};def.key.__counted=true;}},run(kind,tables,receipt={bundleSha256:'sha'},input={sha256:'sha'}){try{const result=e[kind]({tables},receipt,input);return{ok:true,result:JSON.stringify(result??null)};}catch(err){return{ok:false,error:err.message};}},stats:()=>({keyCalls,reads})};}
const a=env(oracle),b=env(actual);let checks=0,cases=0;const eq=(x,y)=>{assert.deepEqual(x,y);checks++;};const T={key:['k1','k2'],columns:['k1','k2','value'],raw:true};
function parity(have,tables,{receipt={bundleSha256:'sha'},input={sha256:'sha'},defs={T},expectPre,expectPost}={}){for(const kind of['pre','post']){const frozen=JSON.stringify(have);a.set(have,defs);b.set(have,defs);const x=a.run(kind,tables,receipt,input),y=b.run(kind,tables,receipt,input);eq(x,y);eq(JSON.stringify(have),frozen);const exp=kind==='pre'?expectPre:expectPost;if(exp!==undefined)eq(y.ok,exp);}cases++;}
parity({T:[]},{T:[{k1:'a',k2:'b',value:'new'}]},{expectPre:true,expectPost:false});
parity({T:[{k1:'a',k2:'b',value:'same'}]},{T:[{k1:'a',k2:'b',value:'same'}]},{expectPre:true,expectPost:true});
parity({T:[{k1:'a',k2:'b',value:'same'}]},{T:[{k1:'a',k2:'b',value:'same'}]},{receipt:null,expectPre:false,expectPost:true});
parity({T:[{k1:'a',k2:'b',value:'same'}]},{T:[{k1:'a',k2:'b',value:'same'}]},{receipt:{bundleSha256:'wrong'},expectPre:false,expectPost:true});
parity({T:[{k1:'a',k2:'b',value:'same'},{k1:'a',k2:'b',value:'DIFFERENT'}]},{T:[{k1:'a',k2:'b',value:'same'}]},{expectPre:true,expectPost:true});
parity({T:[{k1:'a',k2:'b',value:'DIFFERENT'},{k1:'a',k2:'b',value:'same'}]},{T:[{k1:'a',k2:'b',value:'same'}]},{expectPre:false,expectPost:false});
parity({T:[{k1:'',k2:'',value:'empty-key'}]},{T:[{k1:'',k2:'',value:'empty-key'}]},{expectPre:true,expectPost:true});
parity({T:[{k1:'a\u0001b',k2:'c',value:'first'}]},{T:[{k1:'a',k2:'b\u0001c',value:'other'}]},{expectPre:false,expectPost:false});
parity({T:[{k1:'__proto__',k2:'constructor',value:'safe'}]},{T:[{k1:'__proto__',k2:'constructor',value:'safe'}]},{expectPre:true,expectPost:true});
parity({T:[{k1:'1',k2:'0',value:'same'}]},{T:[{k1:1,k2:0,value:'same'}]},{expectPre:true,expectPost:true});
parity({T:[{k1:'a',k2:'b',value:'same'}]},{T:[{k1:'a',k2:'b',value:'same'},{k1:'a',k2:'b',value:'same'}]},{expectPre:false,expectPost:true});
parity({T:[{k1:'a',k2:'b',value:'same'}]},{T:[]},{expectPre:true,expectPost:true});
parity({T:[{k1:undefined,k2:null,value:'edge'}]},{T:[{k1:undefined,k2:null,value:'edge'}]},{expectPre:true,expectPost:true});
const Typed={key:['id'],columns:['id','n','yes','data_json','row_version'],types:{n:'num',yes:'bool'}};
parity({T:[{id:'x',n:0,yes:false,data_json:'{}',row_version:0}]},{T:[{id:'x',n:0,yes:false,data_json:'{}',row_version:0}]},{defs:{T:Typed},expectPre:true,expectPost:true});
let rng=81723;const rand=n=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return rng%n;};const keys=['','a','b','__proto__','x\u0001y','null','0'];for(let z=0;z<400;z++){const have=Array.from({length:rand(20)},()=>({k1:keys[rand(keys.length)],k2:keys[rand(keys.length)],value:String(rand(4))}));const incoming=Array.from({length:rand(5)},()=>rand(2)&&have.length?{...have[rand(have.length)]}:{k1:keys[rand(keys.length)],k2:keys[rand(keys.length)],value:String(rand(4))});parity({T:have},{T:incoming});}
const large=Array.from({length:12000},(_,i)=>({k1:'P'+i,k2:String(i),value:'v'+i})),tail=large.slice(-120);a.set({T:large},{T});b.set({T:large},{T});eq(a.run('post',{T:tail}),b.run('post',{T:tail}));const operationCounts={original:a.stats(),indexed:b.stats()};assert.ok(operationCounts.original.keyCalls>operationCounts.indexed.keyCalls*100);checks++;cases++;
console.log(`app-provisional-offline-index: ${cases} cases / ${checks} checks PASS`);
