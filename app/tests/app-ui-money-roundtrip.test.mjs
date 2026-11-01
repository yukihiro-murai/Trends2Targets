#!/usr/bin/env node
/** Exact editable money text survives formatting; existing budget-number and SPOT-string save contracts stay unchanged. Synthetic only. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { uiHtml, OWNER, setUpEnv } from './gas-mock.mjs';

const decode = s => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function makeUi() {
  const els = {}, rpc = [], sent = [], events = {}, docEvents = {};
  const el = id => els[id] ||= { id, innerHTML: '', textContent: '', value: '', disabled: false, className: '', classList: { add() {}, remove() {} }, querySelector() { return null; }, querySelectorAll() { return []; }, focus() {} };
  const runner = () => { const handlers = {}; const proxy = new Proxy(handlers, { get(o, k) {
    if (k === 'withSuccessHandler') return f => { o.ok = f; return proxy; };
    if (k === 'withFailureHandler') return f => { o.fail = f; return proxy; };
    return (...args) => rpc.push({ name: String(k), args, ...o });
  } }); return proxy; };
  const script = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE=new Proxy({},{get:()=>""});var CHAR_SVG=new Proxy({},{get:()=>""});')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'test' }, setUp: true, allowed: true,
      user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, home: { fy: '2027', plans: [] } }));
  const context = vm.createContext({ document: { getElementById: el, querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener(k, f) { (docEvents[k] ||= new Set()).add(f); } },
    window: { innerWidth: 1280, innerHeight: 800, addEventListener(k, f) { (events[k] ||= new Set()).add(f); }, removeEventListener(k, f) { events[k]?.delete(f); }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
    setTimeout() { return 1; }, clearTimeout() {}, console, google: { script: { get run() { return runner(); } } } });
  vm.runInContext(script, context);
  const run = (code, vars = {}) => { Object.assign(context, vars); return vm.runInContext(code, context); };
  const monthly = Array.from({ length: 12 }, (_, i) => ({ row: 29 + i, month: (i < 9 ? '2027' : '2028') + '/' + String((i + 3) % 12 + 1).padStart(2, '0'), p10: 80, p50: 100, p90: 120, adopted: 100, uplift: 0, final: 100 }));
  run(`S.homePre=true;FC_PRE_MAX=0;S.view='budget';S.fc.planId='p1';S.fc.draftPlan='p1';
    S.fc.data={plan:{planId:'p1',fy:2027},latest:{annual_p50:1200}};
    S.fc.view={plan:{planId:'p1',fy:2027},can:{plan:true},inputHash:'synthetic-hash',boot:{setup:{people:['架空担当']},products:[],months:['2027-04'],stepOptions:[],input:{devspot:[{person:'架空担当',ym:'2027-04',project:'合成案件',amount:10,conf:.5}]},output:{sections:[{monthly:__monthly,annual:{p50:1200,adopted:1200,uplift:0,final:1200}}]}}};
    S.fc.basis={planId:'p1',calibration:{factor:1},triangulation:{sums:{FINAL:1200}}};
    var __renders=0;render=function(){__renders++};
    startJob=function(kind,payload){__sent.push({kind:kind,payload:payload})};`, { __monthly: monthly, __sent: sent });
  rpc.length = 0;
  function inputFor(kind, key = 'adopted') {
    const html = run(kind === 'spot' ? "fcInputCard(S.fc.view,'devspot')" : 'fcBudgetTab(S.fc.data,S.fc.view)');
    const name = kind === 'spot' ? '金額（円）' : kind === 'extra' ? null : '2027/04 ' + (key === 'adopted' ? '採用予測' : '上乗せ');
    const attrs = [...html.matchAll(/<input\b([^>]*)>/g)].map(m => Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], decode(a[2])]))).find(a => name ? a['aria-label'] === name : a.id === 'bud_extra');
    assert.ok(attrs, 'the real rendered money input is present: ' + kind);
    const input = { value: attrs.value || '', attrs, selectionStart: 0, selectionEnd: 0 };
    const fire = type => { assert.ok(attrs['on' + type], 'real inline handler: ' + type); run('(function(){' + attrs['on' + type] + '}).call(__input)', { __input: input }); for (const f of docEvents[type] || []) f({ target: input }); };
    return { input, fire };
  }
  return { run, rpc, sent, els, events, inputFor };
}

let failures = 0, passed = 0;
function test(name, body) { try { body(); passed++; } catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); } }
const cases = [
  ['1.5', '1.5'], ['-1.5', '-1.5'], ['-0', '-0'], ['0.000001', '0.000001'],
  ['1234567.890012345678901234', '1,234,567.890012345678901234'], ['1234567', '1,234,567'],
  ['1,234.5000', '1,234.5000'], [' 1,234.5000 ', '1,234.5000'], ['+001234.5000', '+001,234.5000'],
  ['-0.000000000000000000000001', '-0.000000000000000000000001'],
  ['9007199254740991', '9,007,199,254,740,991'], ['9007199254740993', '9,007,199,254,740,993'],
  ['1000000000000000128', '1,000,000,000,000,000,128'],
  ['999999999999999999999999', '999,999,999,999,999,999,999,999'],
  ['1e-7', '1e-7'], ['1e21', '1e21'], ['0x10', '0x10'], ['.5', '.5'], ['1234.', '1,234.'], ['', ''],
];
for (const [raw, shown] of cases) for (const kind of ['budget', 'spot']) test(kind + ' exact money round trip: ' + raw, () => {
  const u = makeUi(), { input, fire } = u.inputFor(kind), normalized = raw.replace(/[,\s]/g, '');
  fire('focus'); input.value = raw; input.selectionStart = raw.length; fire('input');
  assert.equal(input.value, raw, 'typing does not rewrite the field');
  assert.equal(u.run('__renders'), 0, 'existing-row typing does not redraw the page');
  assert.equal(u.sent.length, 0); assert.equal(u.rpc.length, 0);
  const draftExpression = kind === 'budget' ? 'S.fc.budget[29].adopted' : 'S.fc.draft.devspot[0].amount';
  const draftBeforeBlur = u.run(draftExpression);
  fire('blur'); assert.equal(input.value, shown, 'blur groups the integer part without rounding any digits');
  assert.equal(u.run(draftExpression), draftBeforeBlur, 'formatting leaves the existing input-handler draft contract unchanged');
  fire('focus'); assert.equal(input.value, normalized, 'focus restores the same editable text, including all fractional digits');
  fire('input'); // A later edit starts from the value the user now sees, not an earlier hidden value.
  u.run(kind === 'budget' ? 'fcSaveBudget(29)' : "fcSaveInput('devspot',0)");
  assert.equal(u.sent.length, 1); assert.equal(u.rpc.length, 0);
  const sent = u.sent[0]; assert.equal(sent.kind, 'PLAN.EDIT'); assert.equal(sent.payload.inputHash, 'synthetic-hash');
  if (kind === 'budget') {
    const row = sent.payload.args.rows[0];
    assert.ok(Object.is(row.adopted, normalized === '' ? '' : Number(normalized)), 'budget keeps its existing number-or-empty payload contract, including negative zero');
    assert.equal(row.uplift, 0); assert.equal(sent.payload.args.basis, 'MANUAL');
  } else {
    const row = sent.payload.args.rows[0];
    assert.equal(row.amount, normalized, 'SPOT keeps its existing exact text payload contract');
    assert.equal(row.fromRow, 0); assert.equal(row.person, '架空担当'); assert.equal(row.project, '合成案件'); assert.equal(row.conf, .5);
    assert.equal(sent.payload.args.fromRows, true);
  }
});

for (const kind of ['budget', 'spot']) test(kind + ' blur/focus then append uses the original decimal digits', () => {
  const u = makeUi(), { input, fire } = u.inputFor(kind);
  input.value = '1.5'; fire('input'); fire('blur'); fire('focus'); input.value += '6'; fire('input'); fire('blur');
  assert.equal(input.value, '1.56');
  u.run(kind === 'budget' ? 'fcSaveBudget(29)' : "fcSaveInput('devspot',0)");
  const row = u.sent[0].payload.args.rows[0]; assert.equal(kind === 'budget' ? row.adopted : row.amount, kind === 'budget' ? 1.56 : '1.56');
});

test('fractional uplift editing preserves the saved probability basis and adopted amount', () => {
  const u = makeUi(); u.run("S.fc.view.boot.budgetDraft={basis:'PROB',prob:60,alloc:'PAST_SHAPE'}");
  const { input, fire } = u.inputFor('budget', 'uplift');
  input.value = '-1.5'; fire('input'); fire('blur'); assert.equal(input.value, '-1.5');
  fire('focus'); input.value += '6'; fire('input'); u.run('fcSaveBudget(29)');
  const args = u.sent[0].payload.args;
  assert.equal(args.rows[0].adopted, 100); assert.equal(args.rows[0].uplift, -1.56);
  assert.equal(args.basis, 'PROB'); assert.equal(args.prob, 60); assert.equal(args.alloc, 'PAST_SHAPE');
});

for (const raw of ['-', '+', '.', '-.', '1e', '1.2.3', 'NaN', 'Infinity', '1e309', 'abc']) test('invalid/incomplete text remains visible: ' + raw, () => {
  const u = makeUi(), { input, fire } = u.inputFor('budget');
  input.value = raw; fire('input'); fire('blur'); assert.equal(input.value, raw); fire('focus'); assert.equal(input.value, raw);
  u.run('fcSaveBudget(29)'); assert.equal(u.sent.length, 0, 'existing invalid-budget save guard still refuses the value');
  assert.equal(u.rpc.length, 0);
});

test('numeric values and blank formatting do not lose small decimals or negative zero', () => {
  const u = makeUi();
  for (const [value, expected] of [[1.5, '1.5'], [-0, '-0'], [.000001, '0.000001'], [1e-7, '1e-7'], [1e21, '1e+21'], [null, ''], [undefined, ''], ['', '']]) {
    assert.equal(u.run('fcYenIn(__value)', { __value: value }), expected);
  }
});

test('viewing saved fractional values does not dirty drafts or alter the loaded source', () => {
  const u = makeUi(); u.run('S.fc.view.boot.output.sections[0].monthly[0].adopted=1.5;S.fc.view.boot.input.devspot[0].amount=1.5');
  const before = u.run('JSON.stringify({view:S.fc.view,data:S.fc.data})');
  const budget = u.inputFor('budget'), spot = u.inputFor('spot');
  assert.equal(budget.input.value, '1.5'); assert.equal(spot.input.value, '1.5');
  budget.fire('focus'); budget.fire('blur'); spot.fire('focus'); spot.fire('blur');
  // Reading a SPOT input lazily prepares its draft; it must remain clean and retain the saved amount.
  assert.equal(u.run('Object.keys(S.fc.budget).length'), 0); assert.equal(u.run('fcDirty()'), false);
  assert.equal(u.run('S.fc.view.boot.output.sections[0].monthly[0].adopted'), 1.5);
  assert.equal(u.run('S.fc.view.boot.input.devspot[0].amount'), 1.5);
  assert.equal(u.run('JSON.stringify({view:S.fc.view,data:S.fc.data})'), before);
  assert.equal(u.sent.length, 0); assert.equal(u.rpc.length, 0);
});

test('sales-extra formatting preserves decimals while existing explicit Apply still rounds to yen', () => {
  const u = makeUi(), { input, fire } = u.inputFor('extra');
  input.value = '1.5'; fire('input'); fire('blur'); assert.equal(input.value, '1.5');
  assert.equal(u.run('S.fc.budPick.extra'), '1.5');
  assert.equal(u.run('fcBudPreview(S.fc.data,S.fc.view,fcBudPick()).extra'), 2, 'existing composition calculation stays unchanged');
  u.run('fcBudApply()'); assert.equal(u.run('Object.keys(S.fc.budget).reduce(function(sum,k){return sum+Number(S.fc.budget[k].uplift)},0)'), 2);
  assert.equal(u.sent.length, 0); assert.equal(u.rpc.length, 0);
});

test('synthetic persisted budget and SPOT retain decimal saves and unrelated values', () => {
  const env = setUpEnv(), fy = Number(env.run('appFy_(new Date())'));
  const output = [['FY' + fy + ' 合成予測']];
  while (output.length < 23) output.push([]);
  output.push([' 混合（主要）'], [], ['年度合計（予測）', 80, 100, 120, '', '', '', '', '', ''], [], []);
  for (let i = 0; i < 12; i++) output.push([(i < 9 ? fy : fy + 1) + '/' + String((i + 3) % 12 + 1).padStart(2, '0'), 80, 100, 120, '', '', '', 100, 0, '']);
  const formulas = { H26: '=SUM(H29:H40)', I26: '=SUM(I29:I40)', J26: '=SUM(J29:J40)' };
  for (let i = 29; i <= 40; i++) formulas['J' + i] = '=H' + i + '+I' + i;
  const book = env.makeBook('合成金額テスト', { CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', '架空製薬'], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '架空担当']] }, OUTPUT: { values: output, formulas, formats: { A: '@' } }, DEV_SPOT: { values: [['担当者', '対象月', '案件名', '金額', '確度']] } });
  const planId = env.seedPlan(book);
  const view = () => env.call('apiPlanView(__in)', { __in: { planId } });
  const u = makeUi();
  for (const kind of ['budget', 'spot']) {
    const { input, fire } = u.inputFor(kind); input.value = '1.5'; fire('input'); fire('blur'); fire('focus'); input.value += '6'; fire('input');
    u.run(kind === 'budget' ? 'fcSaveBudget(29)' : "fcSaveInput('devspot',0)");
    const request = u.sent.at(-1).payload;
    const job = env.runJob('PLAN.EDIT', { ...request, planId, inputHash: view().inputHash });
    assert.equal(job.status, 'DONE', job.error);
  }
  const saved = view();
  assert.equal(saved.boot.output.sections[0].monthly[0].adopted, 1.56);
  assert.equal(saved.boot.output.sections[0].monthly[1].adopted, 100, 'other monthly values stay unchanged');
  assert.equal(saved.boot.input.devspot[0].amount, 1.56); assert.equal(saved.boot.input.devspot[0].project, '合成案件');
});

assert.equal(failures, 0, 'money round-trip regressions pass');
console.log('app-ui-money-roundtrip: ' + passed + ' exact text, real handlers, payload contracts and synthetic persistence cases PASS');
