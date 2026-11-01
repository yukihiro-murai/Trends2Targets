#!/usr/bin/env node
// 再読込で隠れる人の記入を控えに保ち、送信済みの入力だけを解除する UI-only 回帰。
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { uiHtml, OWNER } from './gas-mock.mjs';

function makeUi() {
  const events = {}, docEvents = {}, queue = [], els = {};
  const el = id => els[id] ||= {
    value: '', innerHTML: '', textContent: '', className: '', classList: { add() {}, remove() {} },
    querySelector() { return null; }, querySelectorAll() { return []; }, focus() {},
  };
  const runner = () => {
    const handlers = {};
    const p = new Proxy(handlers, { get(o, k) {
      if (k === 'withSuccessHandler') return fn => { o.ok = fn; return p; };
      if (k === 'withFailureHandler') return fn => { o.fail = fn; return p; };
      return (...args) => queue.push({ fn: k, args, ...o });
    } });
    return p;
  };
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({
      app: { name: 'T', version: 'x' }, setUp: true, allowed: true,
      user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] },
      home: { fy: '2026', fyOptions: ['2026'], plans: [] },
    }));
  const ui = vm.createContext({
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [],
      addEventListener(k, f) { (docEvents[k] ||= new Set()).add(f); } },
    window: { innerWidth: 1280, innerHeight: 800,
      addEventListener(k, f) { (events[k] ||= new Set()).add(f); },
      removeEventListener(k, f) { events[k]?.delete(f); },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
    setTimeout() { return 1; }, clearTimeout() {}, console: { log() {}, error() {} },
    google: { script: { get run() { return runner(); } } },
  });
  vm.runInContext(js, ui);
  const run = (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };
  run("S.homePre=true; FC_PRE_MAX=0; S.fc.planId='p1'; S.fc.draftPlan='p1'");
  queue.length = 0;
  const input = code => { run(code); for (const f of docEvents.input || []) f({}); };
  const leave = () => {
    const e = { prevented: false, preventDefault() { this.prevented = true; } };
    for (const f of events.beforeunload || []) f(e);
    return e;
  };
  return { run, input, leave, el, queue, events };
}


const R = (row, month, extra = {}) => ({ row, month, actual: 1000, pred: 1200, errRate: 0.2,
  insight: '採点の見立て', nextAction: '原因を確認', annualBreach: false, halfBreach: false,
  overBreach: true, rangeBreach: false, causeBucket: 'over_forecast',
  hypothesis: '', actionType: 'update', reflection: '次回サイクルで前提更新を反映', owner: '', status: 'open', ...extra });
const V = (rows, planId = 'p1') => ({ plan: { planId, fy: 2026 }, can: { plan: true }, inputHash: 'a'.repeat(64),
  boot: { eval: { insights: rows }, quarterly: { proposals: [] } } });
function createUi(rows = [R(8, '2026/04'), R(9, '2026/05')]) {
  const u = makeUi();
  u.run(`S.view='prep';S.fc.view=__view;S.fc.data={plan:{planId:'p1'}};
    viewForecast=function(){return '<h1>予測準備</h1>'+(S.fc.view?fcRvNotes(S.fc.view.boot.eval.insights,true):'読込中')};render()`, { __view: V(rows) });
  u.queue.length = 0;
  u.copy = code => JSON.parse(u.run('JSON.stringify(' + code + ')'));
  // Inline input handlers run before the document-level unsaved guard.
  u.edit = (row, k, value) => { u.run('fcIns(__row,__k,__value)', { __row: row, __k: k, __value: value }); u.input(''); };
  u.read = (rows, { cached = false } = {}) => {
    if (cached) {
      u.run("S.fcMem.p1={view:{v:__v,at:Date.now()}};delete S.ld.fcView;fcMemUse('p1','view');render()", { __v: V(rows) });
    } else {
      u.run("fcFetch('p1',['view'])");
      const q = u.queue.filter(q => q.fn === 'apiForecastPage').at(-1);
      q.ok({ view: V(rows) });
    }
  };
  u.save = () => {
    const before = u.queue.length; u.run('fcSaveIns(9)');
    const q = u.queue.slice(before).find(q => q.fn === 'apiStartJob');
    assert.ok(q, 'a real PLAN.EDIT request is queued');
    assert.equal(q.args[0].kind, 'PLAN.EDIT');
    const p = q.args[0].payload;
    assert.equal(p.action, 'INSIGHT.SAVE');
    assert.deepEqual(Object.keys(p).sort(), ['action', 'args', 'inputHash', 'planId']);
    assert.deepEqual(Object.keys(p.args), ['rows']);
    for (const r of p.args.rows) assert.deepEqual(Object.keys(r).sort(), ['actionType','hypothesis','owner','reflection','row','status']);
    return q;
  };
  u.done = q => {
    q.ok({ jobId: 'synthetic-ins-save', status: 'QUEUED' });
    u.run('pollJob()');
    const poll = u.queue.filter(q => q.fn === 'apiJobStatus').at(-1);
    // Large job arguments can be stored behind argsRef; DONE need not echo rows.
    poll.ok({ status: 'DONE', result: { planId: 'p1', action: 'INSIGHT.SAVE', changed: ['EVAL_INSIGHTS'] }, payload: { planId: 'p1', action: 'INSIGHT.SAVE' } });
  };
  return u;
}
let failures = 0, passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('PASS ' + name); } catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); } }

for (const cached of [false, true]) test('hidden draft is readable in held card after ' + (cached ? 'cached' : 'network') + ' view replacement', () => {
  const u = createUi(); u.edit(8, 'hypothesis', '旧月の仮説<&"'); u.edit(8, 'owner', '担当A');
  u.read([R(9, '2026/05')], { cached });
  assert.equal(u.run('S.fc.ins[8]'), undefined, 'a hidden draft cannot be sent to a different displayed row');
  assert.match(u.el('main').innerHTML, /id="fc-held-drafts"/);
  assert.match(u.run('fcHeldCard()'), /2026\/04/);
  assert.match(u.run('fcHeldCard()'), /旧月の仮説&lt;&amp;&quot;/);
  assert.match(u.run('fcHeldCard()'), /担当A/);
  assert.equal(u.leave().prevented, true, 'held draft keeps beforeunload protection');
});

test('held content preserves unknown action and status values exactly and escapes markup', () => {
  const u = createUi(); u.edit(8, 'actionType', 'custom_action'); u.edit(8, 'status', 'CUSTOM_STATUS');
  u.edit(8, 'reflection', '<script>copy me</script>'); u.read([R(9, '2026/05')]);
  const held = u.run('fcHeldCard()'); assert.match(held, /custom_action/); assert.match(held, /CUSTOM_STATUS/);
  assert.match(held, /&lt;script&gt;copy me&lt;\/script&gt;/); assert.doesNotMatch(held, /<script>/);
});

test('an unchanged score keeps its unsaved values in editable fields', () => {
  const u = createUi(); u.edit(8, 'hypothesis', '追記を保持'); u.read([R(8, '2026/04'), R(9, '2026/05')]);
  assert.equal(u.run('S.fc.ins[8].hypothesis'), '追記を保持');
  assert.match(u.run('fcRvNotes(S.fc.view.boot.eval.insights,true)'), /value="追記を保持"/);
  assert.equal(u.run('fcHeldCard()'), ''); assert.equal(u.leave().prevented, true);
});

for (const changed of [{ month: '2026/06' }, { pred: 1300 }, { actual: 900 }, { insight: '新しい採点の見立て' }]) test('same row number with changed scoring context is held: ' + JSON.stringify(changed), () => {
  const u = createUi(); u.edit(8, 'reflection', '前の採点への記入');
  u.read([R(8, '2026/04', changed), R(9, '2026/05')]);
  assert.equal(u.run('S.fc.ins[8]'), undefined);
  assert.match(u.run('fcHeldCard()'), /前の採点への記入/);
  assert.doesNotMatch(u.run('fcRvNotes(S.fc.view.boot.eval.insights,true)'), /value="前の採点への記入"/);
});

test('same-month grouping cannot hide a draft even while its raw row remains in the response', () => {
  const u = createUi(); u.edit(8, 'hypothesis', 'まとめで隠れる前の仮説');
  u.read([R(8, '2026/04'), R(12, '2026/04'), R(9, '2026/05')]);
  assert.equal(u.run('S.fc.view.boot.eval.insights.length'), 3);
  assert.equal(u.run('S.fc.ins[8]'), undefined);
  assert.match(u.run('fcHeldCard()'), /まとめで隠れる前の仮説/);
});

test('loss of edit permission moves local input to readable held content', () => {
  const u = createUi(); u.edit(8, 'hypothesis', '権限変更前の自分の仮説');
  u.run("fcFetch('p1',['view'])");
  const view = V([R(8, '2026/04'), R(9, '2026/05')]); view.can.plan = false;
  u.queue.at(-1).ok({ view });
  assert.equal(u.run('S.fc.ins[8]'), undefined);
  assert.match(u.run('fcHeldCard()'), /権限変更前の自分の仮説/); assert.equal(u.leave().prevented, true);
});

test('failed view read retains the draft and its unsaved guard', () => {
  const u = createUi(); u.edit(8, 'hypothesis', '読込失敗でも残す');
  u.run("fcFetch('p1',['view'])"); u.queue.at(-1).fail({ message: '合成読込拒否' });
  assert.equal(u.run('S.fc.ins[8].hypothesis'), '読込失敗でも残す'); assert.equal(u.leave().prevented, true);
});

test('saving a visible row leaves the hidden held row and transmits only the existing server contract', () => {
  const u = createUi(); u.edit(8, 'hypothesis', '送信しない旧月'); u.read([R(9, '2026/05')]);
  u.edit(9, 'hypothesis', '今月だけ保存'); const q = u.save();
  assert.deepEqual(Array.from(q.args[0].payload.args.rows, r => r.row), [9]);
  u.done(q);
  assert.equal(u.run('S.fc.ins[9]'), undefined, 'the unchanged sent draft is cleared');
  assert.match(u.run('fcHeldCard()'), /送信しない旧月/);
  assert.equal(u.leave().prevented, true, 'saving another row cannot release held protection');
});

test('a successful save clears exactly the sent unchanged draft even when DONE omits args', () => {
  const u = createUi(); u.edit(9, 'hypothesis', '保存する内容'); const q = u.save();
  assert.equal(u.leave().prevented, true); u.done(q);
  assert.deepEqual(u.copy('S.fc.ins'), {}); assert.equal(u.leave().prevented, false);
});

for (const phase of ['start-refused', 'job-failed']) test('save failure never clears drafts: ' + phase, () => {
  const u = createUi(); u.edit(9, 'hypothesis', '失敗後も保存前の入力'); const q = u.save();
  if (phase === 'start-refused') q.fail({ message: '合成保存拒否' });
  else { q.ok({ jobId: 'failed-ins', status: 'QUEUED' }); u.run('pollJob()'); u.queue.at(-1).ok({ status: 'FAILED', error: '合成保存失敗' }); }
  assert.equal(u.run('S.fc.ins[9].hypothesis'), '失敗後も保存前の入力'); assert.equal(u.leave().prevented, true);
});

test('new fields added after the sent snapshot survive success', () => {
  const u = createUi(); u.edit(9, 'hypothesis', '送った元の仮説'); const q = u.save();
  // Busy handlers reject live edits; this simulates later state supplied by another local continuation.
  u.run("S.fc.ins[9].reflection='送信後の新しい追記'");
  u.done(q);
  assert.equal(u.run('S.fc.ins[9].reflection'), '送信後の新しい追記');
  assert.equal(u.run('S.fc.ins[9].hypothesis'), '送った元の仮説'); assert.equal(u.leave().prevented, true);
});

test('an unsent row created after the snapshot is never cleared by another row save', () => {
  const u = createUi([R(8, '2026/04'), R(9, '2026/05'), R(10, '2026/06')]);
  u.edit(9, 'hypothesis', '送った行'); const q = u.save();
  u.run("S.fc.ins[10]={hypothesis:'送っていない別行'}");
  u.done(q);
  assert.equal(u.run('S.fc.ins[10].hypothesis'), '送っていない別行'); assert.equal(u.leave().prevented, true);
});

test('EVAL.INSIGHTS success preserves input until the new scoring view can be compared', () => {
  const u = createUi(); u.edit(8, 'hypothesis', '自動整理に送っていない仮説');
  u.run("loadForecast('p1',true,{action:'EVAL.INSIGHTS'})");
  assert.equal(u.run('S.fc.ins[8].hypothesis'), '自動整理に送っていない仮説');
  const q = u.queue.filter(q => q.fn === 'apiForecastPage').at(-1); q.ok({ view: V([R(8, '2026/04', { pred: 1400 }), R(9, '2026/05')]) });
  assert.match(u.run('fcHeldCard()'), /自動整理に送っていない仮説/); assert.equal(u.leave().prevented, true);
});

test('empty input is retained in held text and only a successful sent save releases it', () => {
  const u = createUi(); u.edit(8, 'hypothesis', ''); u.read([R(9, '2026/05')]);
  assert.match(u.run('fcHeldCard()'), /原因の仮説:/); assert.equal(u.leave().prevented, true);
  const v = createUi(); v.edit(9, 'hypothesis', ''); const q = v.save(); v.done(q); assert.equal(v.leave().prevented, false);
});

test('a late success for another plan never clears current plan drafts', () => {
  const u = createUi(); u.edit(9, 'hypothesis', '前の計画の入力'); const q = u.save();
  u.run("S.starting=false;S.writing=false;S.job=null;fcDropDrafts();S.fc.planId='p2';S.fc.draftPlan='p2';S.fc.view=__v", { __v: V([R(9, '2026/05')], 'p2') });
  u.edit(9, 'hypothesis', '別計画の新しい入力');
  u.run("JOB_DONE['PLAN.EDIT']({planId:'p1',action:'INSIGHT.SAVE',changed:['EVAL_INSIGHTS']},{planId:'p1',action:'INSIGHT.SAVE'})");
  assert.equal(u.run('S.fc.ins[9].hypothesis'), '別計画の新しい入力'); assert.equal(u.leave().prevented, true);
});

test('discarding and re-entering on the same plan cannot let an old save clear the new container', () => {
  const u = createUi(); u.edit(9, 'hypothesis', '同じ内容'); const q = u.save();
  u.run('S.starting=false;S.writing=false;S.job=null;fcDropDrafts()'); u.edit(9, 'hypothesis', '同じ内容');
  u.run("JOB_DONE['PLAN.EDIT']({planId:'p1',action:'INSIGHT.SAVE',changed:['EVAL_INSIGHTS']},{planId:'p1',action:'INSIGHT.SAVE'})");
  assert.equal(u.run('S.fc.ins[9].hypothesis'), '同じ内容'); assert.equal(u.leave().prevented, true);
});

test('held discard is explicit, cancellation preserves it, and later held additions survive an open confirmation', () => {
  const u = createUi(); u.edit(8, 'hypothesis', '破棄確認前の控え'); u.read([R(9, '2026/05')]);
  u.run('fcHeldDiscard();askDone(false)'); assert.match(u.run('fcHeldCard()'), /破棄確認前の控え/);
  u.run("fcHeldDiscard();S.fc.held.push({label:'後から増えた控え',text:'新しい控え'});askDone(true)");
  assert.doesNotMatch(u.run('fcHeldCard()'), /破棄確認前の控え/); assert.match(u.run('fcHeldCard()'), /新しい控え/);
  assert.equal(u.leave().prevented, true);
  u.run('fcHeldDiscard();askDone(true)'); assert.equal(u.run('fcHeldCard()'), ''); assert.equal(u.leave().prevented, false);
});

if (failures) throw new Error(failures + ' of ' + (failures + passed) + ' hidden insight draft cases failed');
console.log('app-ui-hidden-insight-drafts: ' + passed + ' cases PASS');
