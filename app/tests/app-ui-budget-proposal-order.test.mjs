#!/usr/bin/env node
/** Synthetic asynchronous UI regression. Real call/gsRun/toast/render run against a minimal DOM and held RPC responses. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { uiHtml, OWNER } from './gas-mock.mjs';

const decode = value => String(value).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
function makeUi() {
  const queue = [], timers = new Map(), events = {}, docEvents = {}, roots = [];
  let timerId = 0, renders = 0, document;
  function matches(node, selector) {
    if (!node || typeof node === 'string') return false;
    const attr = /^\[([\w-]+)="([^"]*)"\]$/.exec(selector);
    if (attr) return node.getAttribute(attr[1]) === attr[2];
    if (selector.startsWith('#')) return node.id === selector.slice(1);
    if (selector.startsWith('.')) return selector.slice(1).split('.').every(c => node.className.split(/\s+/).includes(c));
    return node.tagName === selector.toUpperCase();
  }
  function node(tag, attrs = {}) {
    let html = '', value;
    const n = {
      tagName: tag.toUpperCase(), attrs, children: [], parentNode: null, selectionStart: null, selectionEnd: null, scrollWidth: 0, clientWidth: 0,
      get id() { return attrs.id || ''; }, get className() { return attrs.class || ''; }, set className(v) { attrs.class = String(v); },
      get disabled() { return 'disabled' in attrs; }, set disabled(v) { if (v) attrs.disabled = ''; else delete attrs.disabled; },
      get value() { if (value !== undefined) return value; if (n.tagName === 'SELECT') { const os = n.options; const o = os.find(x => x.hasAttribute('selected')) || os[0]; return o ? o.value : ''; } return attrs.value || ''; },
      set value(v) { value = String(v); }, get options() { return n.querySelectorAll('option'); },
      get textContent() { return n.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); },
      set textContent(v) { n.children = [String(v)]; html = String(v); },
      get innerHTML() { return html; }, set innerHTML(v) { html = String(v); n.children = parse(html, n); if (n.id === 'main') renders++; },
      getAttribute(k) { return k in attrs ? attrs[k] : null; }, hasAttribute(k) { return k in attrs; },
      setAttribute(k, v) { attrs[k] = String(v); }, removeAttribute(k) { delete attrs[k]; },
      querySelectorAll(selector) { const result = []; const selectors = selector.split(',').map(s => s.trim()); const visit = p => p.children.forEach(c => { if (typeof c !== 'string') { if (selectors.some(s => matches(c, s))) result.push(c); visit(c); } }); visit(n); return result; },
      querySelector(selector) { return n.querySelectorAll(selector)[0] || null; },
      closest(selector) { for (let p = n; p; p = p.parentNode) if (selector.split(',').some(s => matches(p, s.trim()))) return p; return null; },
      focus() { document.activeElement = n; }, setSelectionRange(a, b) { n.selectionStart = a; n.selectionEnd = b; },
      getBoundingClientRect() { return { top: 0, bottom: 40, left: 0, right: 160, width: 160, height: 40 }; },
      insertAdjacentHTML(where, source) { const cs = parse(source, n); if (where === 'afterbegin') n.children.unshift(...cs); else n.children.push(...cs); },
    };
    n.classList = { add(c) { if (!n.className.split(/\s+/).includes(c)) n.className += ' ' + c; }, remove(c) { n.className = n.className.split(/\s+/).filter(x => x !== c).join(' '); } };
    return n;
  }
  function parse(source, parent) {
    const holder = { children: [] }, stack = [holder];
    for (const token of source.match(/<[^>]*>|[^<]+/g) || []) {
      if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      if (token.startsWith('<!')) continue;
      const m = /^<([\w-]+)\b([\s\S]*?)\/?\s*>$/.exec(token);
      if (!m) { stack.at(-1).children.push(decode(token)); continue; }
      const attrs = {};
      for (const a of m[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = decode(a[2] || '');
      const child = node(m[1], attrs), p = stack.at(-1); child.parentNode = p === holder ? parent : p; p.children.push(child);
      if (!/^(input|br|hr|img|meta|link|col|path)$/i.test(m[1]) && !token.endsWith('/>')) stack.push(child);
    }
    return holder.children;
  }
  for (const id of ['main', 'nav', 'hdrTools', 'toast', 'askwrap', 'tipbox']) roots.push(node('div', { id }));
  document = {
    activeElement: null,
    getElementById(id) { for (const r of roots) { if (r.id === id) return r; const found = r.querySelector('#' + id); if (found) return found; } return null; },
    querySelector(selector) { for (const r of roots) { if (matches(r, selector)) return r; const found = r.querySelector(selector); if (found) return found; } return null; },
    querySelectorAll(selector) { return roots.flatMap(r => r.querySelectorAll(selector)); },
    addEventListener(k, f) { (docEvents[k] ||= new Set()).add(f); },
  };
  const runner = () => { const handlers = {}; const proxy = new Proxy(handlers, { get(o, k) {
    if (k === 'withSuccessHandler') return f => { o.ok = f; return proxy; };
    if (k === 'withFailureHandler') return f => { o.fail = f; return proxy; };
    return (...args) => queue.push({ name: String(k), args, ok: o.ok, fail: o.fail });
  } }); return proxy; };
  const script = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE=new Proxy({},{get:()=>""});var CHAR_SVG=new Proxy({},{get:()=>""});')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'test' }, setUp: true, allowed: true,
      user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, home: { fy: '2027', fyOptions: ['2027'], plans: [] } }));
  const context = vm.createContext({ document, window: { innerWidth: 1280, innerHeight: 800,
    addEventListener(k, f) { (events[k] ||= new Set()).add(f); }, removeEventListener(k, f) { events[k]?.delete(f); },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
    setTimeout(f) { timers.set(++timerId, f); return timerId; }, clearTimeout(id) { timers.delete(id); }, console,
    google: { script: { get run() { return runner(); } } } });
  vm.runInContext(script, context);
  const run = (code, vars = {}) => { Object.assign(context, vars); return vm.runInContext(code, context); };
  const monthly = Array.from({ length: 12 }, (_, i) => ({ row: 29 + i, month: (i < 9 ? '2027' : '2028') + '/' + String((i + 3) % 12 + 1).padStart(2, '0'), p10: 80000, p50: 100000, p90: 120000, adopted: 100000, uplift: 0, final: 100000 }));
  run(`S.homePre=true;FC_PRE_MAX=0;S.view='budget';S.fc.planId='p1';S.fc.draftPlan='p1';
    S.fc.plans=[{planId:'p1',fy:2027,clientName:'架空製薬'}];
    S.fc.data={plan:{planId:'p1',fy:2027},latest:{annual_p10:960000,annual_p50:1200000,annual_p90:1440000}};
    S.fc.view={plan:{planId:'p1',fy:2027},can:{plan:true},boot:{output:{sections:[{monthly:__monthly,annual:{p10:960000,p50:1200000,p90:1440000,adopted:1200000,uplift:0,final:1200000}}]}}};
    S.fc.basis={planId:'p1',calibration:{factor:1},triangulation:{sums:{FINAL:1200000}}};
    viewForecast=function(){return '<h1>予算策定</h1>'+fcBudgetTab(S.fc.data,S.fc.view)};
    render();`, { __monthly: monthly });
  assert.ok(document.getElementById('fcProb'), 'fixture renders the real probability selector');
  assert.ok(document.querySelector('[aria-label="2027/04 採用予測"]'), 'fixture renders the real monthly input');
  assert.doesNotMatch(document.getElementById('main').textContent, /表示できません|ここを表示できません/);
  queue.length = 0; timers.clear(); renders = 0;
  const copy = expression => JSON.parse(run('JSON.stringify(' + expression + ')'));
  const field = (kind = 'adopted') => document.querySelector('[aria-label="2027/04 ' + (kind === 'adopted' ? '採用予測' : '上乗せ') + '"]');
  const type = (kind, value) => { const input = field(kind); assert.ok(input && !input.disabled, 'monthly input remains editable'); input.focus(); input.value = value; input.setSelectionRange(2, 2); run('fcBudget(29,__kind,__value)', { __kind: kind, __value: value }); for (const f of docEvents.input || []) f({ target: input }); return input; };
  const request = (prob = '50') => { const n = queue.length; run('fcBudProb(__prob)', { __prob: prob }); if (run('!!ASK')) run('askDone(true)'); assert.equal(queue.length, n + 1, 'one asynchronous read is queued'); const q = queue.at(-1); assert.equal(q.name, 'apiBudgetProposal'); return q; };
  const response = (q, adopted = 100) => ({ planId: q.args[0].planId, prob: q.args[0].prob, ok: true, alloc: 'FORECAST_SHAPE', annual: adopted * 12, months: monthly.map(m => ({ ym: m.month, adopted })) });
  const succeed = (q, adopted = 100) => q.ok(response(q, adopted));
  const fail = q => q.fail({ message: '合成テストの拒否' });
  const selector = () => document.getElementById('fcProb');
  const selectorReady = () => { assert.equal(selector().disabled, false, 'probability selector is enabled'); assert.equal(selector().value, '', 'selector returns to the unselected placeholder'); assert.equal(selector().options[0].textContent, '確率で決める', 'waiting placeholder is cleared'); };
  const surface = () => ({ draft: copy('S.fc.budget'), basis: copy('S.fc.budBasis'), toast: document.getElementById('toast').innerHTML, error: copy('S.lastError || null'), renders });
  return { run, copy, document, queue, field, type, request, succeed, fail, selector, selectorReady, surface, get renders() { return renders; } };
}

let failures = 0;
function test(name, fn) { try { fn(); console.log('PASS ' + name); } catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); } }

for (const outcome of ['success', 'failure']) test('manual adopted edit cancels pending proposal; old ' + outcome + ' is silent', () => {
  const u = makeUi(), q = u.request();
  assert.equal(u.selector().disabled, true);
  assert.equal(u.selector().options[0].textContent, '計算しています');
  const input = u.type('adopted', '777');
  assert.equal(u.field(), input, 'editing does not remount the active field');
  assert.equal(input.selectionStart, 2); assert.equal(u.document.activeElement, input);
  const before = u.surface();
  u[outcome === 'success' ? 'succeed' : 'fail'](q);
  assert.deepEqual(u.surface(), before, 'obsolete response changes no draft, basis, toast, error or rendered DOM');
  u.selectorReady();
  assert.equal(u.field(), input); assert.equal(input.value, '777'); assert.equal(input.selectionStart, 2);
  assert.equal(u.run('fcDirty()'), true); assert.equal(u.run('FC_LEAVE_ARMED'), true);
});

test('explicit composition Apply wins over an earlier probability proposal', () => {
  const u = makeUi(), q = u.request();
  const extra = u.document.getElementById('bud_extra'); extra.value = '120000';
  u.run("fcBudSetExtra('120000');fcBudApply()");
  assert.deepEqual(u.copy('S.fc.budget[29]'), { adopted: '100000', uplift: '10000' });
  const before = u.surface(); u.succeed(q, 100);
  assert.deepEqual(u.surface(), before);
  u.selectorReady();
  assert.equal(u.queue.length, 1, 'local composition Apply does not save or start another read');
});

for (const outcome of ['success', 'failure']) test('old ' + outcome + ' cannot clear a newer proposal or redraw its active input', () => {
  const u = makeUi(), old = u.request();
  u.type('adopted', '777');
  const latest = u.request('60');
  assert.equal(u.selector().disabled, true);
  const token = u.run('S.fc.budProb'), before = u.surface();
  u[outcome === 'success' ? 'succeed' : 'fail'](old);
  assert.equal(u.run('S.fc.budProb'), token, 'new request still owns the pending state');
  assert.equal(u.selector().disabled, true);
  assert.deepEqual(u.surface(), before, 'old completion is silent even while another request is pending');
  u.succeed(latest, 600);
  assert.equal(u.run('S.fc.budget[29].adopted'), '600');
  assert.equal(u.run('S.fc.budBasis.basis'), 'PROB'); assert.equal(u.run('S.fc.budBasis.prob'), 60);
  assert.equal(u.selector().disabled, false); assert.equal(u.selector().value, '60');
});

test('uplift-only edits retain a valid in-flight proposal and its uplift', () => {
  const u = makeUi(), q = u.request();
  u.type('uplift', '888');
  assert.equal(u.selector().disabled, true);
  u.succeed(q, 500);
  assert.deepEqual(u.copy('S.fc.budget[29]'), { adopted: '500', uplift: '888' });
  assert.equal(u.selector().value, '50'); assert.equal(u.selector().disabled, false);
  assert.equal(u.run('fcDirty()'), true); assert.equal(u.run('FC_LEAVE_ARMED'), true);
});

test('a current request failure remains visible and clears the waiting selector', () => {
  const u = makeUi(), q = u.request();
  u.fail(q);
  assert.match(u.document.getElementById('toast').textContent, /合成テストの拒否/);
  assert.match(u.run('S.lastError.message'), /合成テストの拒否/);
  assert.equal(u.run('Object.keys(S.fc.budget).length'), 0);
  u.selectorReady();
});

for (const outcome of ['success', 'failure']) test('discard makes a pending ' + outcome + ' harmless', () => {
  const u = makeUi(), q = u.request();
  u.run('fcDropDrafts();render()'); u.selectorReady();
  const before = u.surface(); u[outcome === 'success' ? 'succeed' : 'fail'](q);
  assert.deepEqual(u.surface(), before); assert.equal(u.run('fcDirty()'), false);
});

test('a response for a departed plan does not enter the newly opened plan', () => {
  const u = makeUi(), q = u.request();
  u.run("fcDropDrafts();S.fc.planId='p2';S.fc.draftPlan='p2';S.fc.view.plan.planId='p2';S.fc.data.plan.planId='p2';render()");
  const before = u.surface(); u.succeed(q);
  assert.deepEqual(u.surface(), before); assert.equal(u.run('Object.keys(S.fc.budget).length'), 0);
});

test('a replacement view from a same-plan reload invalidates the old proposal', () => {
  const u = makeUi(), q = u.request();
  u.run('S.fc.view=JSON.parse(JSON.stringify(S.fc.view));render()');
  u.succeed(q);
  assert.equal(u.run('Object.keys(S.fc.budget).length'), 0, 'proposal based on the old view cannot create drafts');
  u.selectorReady(); assert.equal(u.run('fcDirty()'), false);
});

for (const state of ['S.writing=true', 'S.starting=true', "S.job={id:'synthetic-job'}"]) test('a proposal cannot mutate drafts while processing: ' + state, () => {
  const u = makeUi(), q = u.request();
  u.run(state); const before = u.copy('S.fc.budget'); u.succeed(q);
  assert.deepEqual(u.copy('S.fc.budget'), before); assert.equal(u.run('fcDirty()'), false);
  u.run('S.writing=false;S.starting=false;S.job=null;render()'); u.selectorReady();
});

for (const state of ['S.writing=true', 'S.starting=true', "S.job={id:'synthetic-job'}"]) test('a busy page cannot start a new probability request: ' + state, () => {
  const u = makeUi(); u.run(state + ";fcBudProb('50')"); assert.equal(u.queue.length, 0);
});

for (const change of ['S.writing=true', "S.fc.planId='p2'"]) test('confirmation cannot start a proposal after its original context changes: ' + change, () => {
  const u = makeUi(); u.type('adopted', '777');
  u.run("fcBudProb('50')");
  assert.equal(u.run('!!ASK'), true, 'replacing a manual adopted value requires confirmation');
  assert.equal(u.queue.length, 0);
  u.run(change + ';askDone(true)');
  assert.equal(u.queue.length, 0, 'a stale confirmation cannot start a read');
  assert.equal(u.run('S.fc.budget[29].adopted'), '777');
});

assert.equal(failures, 0, 'all budget proposal ordering cases pass');
console.log('app-ui-budget-proposal-order: asynchronous ownership, manual drafts, DOM/cursor, discard/reload and busy guards PASS');
