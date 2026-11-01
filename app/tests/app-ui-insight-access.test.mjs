#!/usr/bin/env node
/** Normal navigation and learning links reach the real insight renderer. Synthetic RPC/DOM only; source renderers stay intact. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { uiHtml, OWNER } from './gas-mock.mjs';

const decode = value => String(value).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
function makeUi({ canPlan = true, frozen = false, withInsights = true, withScoring = true, withProposals = false } = {}) {
  const queue = [], timers = new Map(), events = {}, docEvents = {}, roots = [];
  let timerId = 0, renders = 0, document, execute;
  const scrolls = [];
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
      scrollIntoView() { scrolls.push({ id: n.id, text: n.textContent, values: n.querySelectorAll('input').map(input => input.value) }); },
      click() { execute(n, 'click'); },
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
      user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, home: { fy: '2026', fyOptions: ['2026'], plans: [] } }));
  const context = vm.createContext({ document, window: { innerWidth: 1280, innerHeight: 800,
    addEventListener(k, f) { (events[k] ||= new Set()).add(f); }, removeEventListener(k, f) { events[k]?.delete(f); },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
    setTimeout(f, ms = 0) { timers.set(++timerId, { f, ms }); return timerId; }, clearTimeout(id) { timers.delete(id); }, console,
    google: { script: { get run() { return runner(); } } } });
  vm.runInContext(script, context);
  const run = (code, vars = {}) => { Object.assign(context, vars); return vm.runInContext(code, context); };
  execute = (node, type, event = {}) => {
    const handler = node && node.getAttribute('on' + type); assert.ok(handler, 'real inline ' + type + ' handler exists');
    run('(function(){' + handler + '}).call(__node)', { __node: node, event });
    for (const f of docEvents[type] || []) f({ target: node });
  };
  const monthly = Array.from({ length: 12 }, (_, i) => ({ row: 29 + i, month: (i < 9 ? '2026' : '2027') + '/' + String((i + 3) % 12 + 1).padStart(2, '0'), p10: 80, p50: 100, p90: 120, adopted: 100, uplift: 0, final: 100 }));
  const pages = {};
  for (const planId of ['p1', 'p2']) {
    const plan = { planId, clientName: '架空製薬' + planId.slice(-1), fy: 2026, frozen };
    const insights = withInsights ? [{ row: 8, month: '2026/04', actual: 1000, pred: 1200, errRate: .2, insight: '合成採点', nextAction: '確認', annualBreach: false, halfBreach: false, overBreach: true, rangeBreach: false, causeBucket: 'over_forecast', hypothesis: '保存済みの仮説-' + planId, actionType: '前提を更新', reflection: '保存済みの記入-' + planId, owner: '架空担当', status: 'open' }] : [];
    pages[planId] = {
      latest: { plan, latest: { annual_p10: 960, annual_p50: 1200, annual_p90: 1440 } },
      view: { plan, can: { plan: canPlan && !frozen, approve: false }, sourceReady: true, inputHash: 'a'.repeat(64), actions: [], recent: [], boot: {
        setup: { people: ['架空担当'] }, products: [], months: ['2026-04'], stepOptions: [], input: { product: [], client: [], opinions: [], devspot: [] },
        eval: { insights }, quarterly: { reviewId: 'synthetic-review', title: 'FY2026-Q1', applied: false, proposals: withProposals ? [{ row: 2, pid: 'synthetic-proposal', target: 'bias_correction_factor', current: 1, proposed: 1.1, decision: '承認', rationale: '合成の見直し案', conf: .5 }] : [] }, output: { sections: [{ monthly, annual: { p10: 960, p50: 1200, p90: 1440, adopted: 1200, uplift: 0, final: 1200 } }] }, learning: {},
      } },
      basis: { planId, calibration: { factor: 1 }, triangulation: { sums: { FINAL: 1200 } } },
      learn: withScoring ? { planId, scoredMonths: 1, accuracy: { n: 1, mape: .2, bias: .2, coverage: 1, coverageN: 1, months: [{ month: '2026/04', err: .2, p10: 800, p50: 1200, p90: 1400, actual: 1000, inside: true }] } } : { planId, scoredMonths: 0, accuracy: { months: [] } },
      ver: { planId, versions: [] },
    };
  }
  const lesson = planId => ({ planId, clientName: planId ? pages[planId].view.plan.clientName : '計画のない架空製薬', fy: 2026, ym: '2026-04', miss: true, direction: 'over', pred: 1200, actual: 1000, err: .2, absErr: .2, hypothesis: '仮説', actionLabel: '前提を更新', human: true, reflection: '', owner: '架空担当', status: 'open' });
  run(`S.homePre=true;FC_PRE_MAX=0;S.view='home';S.fc.plans=__plans;S.ld.fcPlans={at:Date.now()};
    S.lr.people={detail:'full',summary:{months:1,scoredMonths:1,misses:1},lessons:__lessons,openActions:[],causes:[],scoreboard:[],decisions:[],uplift:[],hits:{},repeats:[]};
    S.lr.ai={pending:[]};S.ld.lrPeople={at:Date.now()};S.ld.lrAi={at:Date.now()};render();`, { __plans: Object.values(pages).map(p => p.view.plan), __lessons: [lesson('p1'), lesson('p2'), lesson('')] });
  queue.length = 0; timers.clear(); renders = 0;
  const main = () => document.getElementById('main');
  const clean = () => assert.doesNotMatch(main().textContent, /この画面を表示できません|ここを表示できません|undefined|NaN/, 'the real renderer completes without a swallowed section error');
  const immediate = () => { for (let i = 0; i < 20; i++) { const due = [...timers.entries()].filter(([, t]) => t.ms === 0); if (!due.length) break; for (const [id, t] of due) { timers.delete(id); t.f(); } } };
  const respond = (q, selected) => {
    assert.equal(q.name, 'apiForecastPage', 'this harness only returns synthetic read data');
    const input = q.args[0], p = pages[input.planId], response = {};
    for (const part of selected || input.parts) response[part] = p[part];
    q.ok(response); clean(); immediate();
  };
  const flush = () => { for (let i = 0; queue.length && i < 40; i++) respond(queue.shift()); assert.equal(queue.length, 0); clean(); };
  const nav = name => { const button = document.getElementById('nav').querySelector('[onclick="go(\'' + name + '\')"]'); assert.ok(button, 'real normal navigation button: ' + name); execute(button, 'click'); clean(); };
  const notes = () => document.getElementById('fc-insight-notes');
  const field = () => main().querySelector('[aria-label="原因の仮説"]');
  const edit = value => { const n = field(); assert.ok(n && !n.disabled, 'the real visible insight input is editable'); n.value = value; n.focus(); n.setSelectionRange(2, 2); execute(n, 'input'); return n; };
  const link = planId => main().querySelectorAll('a').find(n => n.getAttribute('onclick') === "openPlan('" + planId + "','review')") || null;
  return { run, pages, queue, document, main, nav, flush, respond, immediate, execute, notes, field, edit, link, scrolls, clean };
}

let passed = 0, failures = 0;
function test(name, body) { try { body(); passed++; console.log('PASS ' + name); } catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); } }
const sections = u => u.main().querySelectorAll('section').map(n => n.id);
const entered = options => { const u = makeUi(options); u.nav('prep'); u.flush(); return u; };
const noWrites = u => assert.equal(u.queue.filter(q => q.name === 'apiStartJob').length, 0, 'access/navigation never saves or starts a job');

test('normal preparation navigation renders the existing insight input after the normal data read', () => {
  const u = entered();
  assert.equal(u.run('S.view'), 'prep'); assert.equal(u.run('S.fc.planId'), 'p1');
  assert.deepEqual(sections(u), ['fcs-input', 'fcs-review']);
  assert.ok(u.notes(), 'real human-notes card has a stable target');
  assert.equal(u.field().value, '保存済みの仮説-p1');
  assert.match(u.main().textContent, /AI 補正/); assert.match(u.main().textContent, /人の記入/);
  assert.equal(u.run('fcDirty()'), false); noWrites(u);
});

test('editing the ordinary visible field retains dirty protection and sends only the existing explicit save contract', () => {
  const u = entered(), before = u.run('JSON.stringify(S.fc.view.boot)'), input = u.edit('通常導線からの仮説');
  assert.equal(u.run('S.fc.ins[8].hypothesis'), '通常導線からの仮説'); assert.equal(u.run('FC_LEAVE_ARMED'), true);
  assert.equal(u.field(), input); assert.equal(input.selectionStart, 2); noWrites(u);
  const save = u.main().querySelector('[onclick="fcSaveIns(8)"]'); assert.equal(save.disabled, false); u.execute(save, 'click');
  const q = u.queue.find(q => q.name === 'apiStartJob'); assert.ok(q);
  const p = q.args[0].payload; assert.equal(p.planId, 'p1'); assert.equal(p.action, 'INSIGHT.SAVE'); assert.equal(p.args.rows[0].hypothesis, '通常導線からの仮説');
  assert.deepEqual(Object.keys(p.args.rows[0]).sort(), ['actionType', 'hypothesis', 'owner', 'reflection', 'row', 'status']);
  assert.equal(u.run('JSON.stringify(S.fc.view.boot)'), before, 'opening/editing/queuing never mutates loaded saved data');
});

for (const options of [{ canPlan: false }, { frozen: true }]) test('the normal insight section respects read-only server capabilities ' + JSON.stringify(options), () => {
  const u = entered(options);
  assert.ok(u.notes()); assert.equal(u.field(), null); assert.match(u.main().textContent, /保存済みの仮説-p1/);
  assert.equal(u.main().querySelector('[onclick="fcSaveIns(8)"]'), null);
  assert.equal(u.main().querySelector('[onclick="fcForecastRun()"]'), null);
  assert.equal(u.run('fcDirty()'), false); noWrites(u);
});

test('ordinary navigation away and back retains an insight draft for the same plan', () => {
  const u = entered(); u.edit('画面移動しても残す'); u.nav('learning');
  assert.equal(u.run('fcDirty()'), true); u.nav('prep'); u.flush();
  assert.equal(u.field().value, '画面移動しても残す'); assert.equal(u.run('FC_LEAVE_ARMED'), true); noWrites(u);
});

test('the real learning renderer links maker names to the same plan notes without dropping its draft', () => {
  const u = entered(); u.edit('学びから戻って保持'); u.nav('learning');
  const link = u.link('p1'); assert.ok(link, 'a real learning maker link is rendered');
  assert.equal(link.getAttribute('role'), 'button'); assert.equal(link.getAttribute('tabindex'), '0');
  assert.equal(link.getAttribute('aria-label'), '架空製薬1の人の記入を開く');
  u.execute(link, 'click'); u.flush();
  assert.equal(u.run('S.view'), 'prep'); assert.equal(u.run('S.fc.planId'), 'p1');
  assert.equal(u.field().value, '学びから戻って保持'); assert.equal(u.scrolls.at(-1).id, 'fc-insight-notes'); noWrites(u);
});

for (const key of ['Enter', ' ']) test('learning maker link keyboard activation uses the existing accessible route: ' + JSON.stringify(key), () => {
  const u = makeUi(); u.nav('learning'); const link = u.link('p1'); assert.ok(link);
  const event = { key, prevented: false, preventDefault() { this.prevented = true; } };
  u.execute(link, 'keydown', event); assert.equal(event.prevented, true); u.flush();
  assert.equal(u.run('S.view'), 'prep'); assert.equal(u.run('S.fc.planId'), 'p1'); assert.ok(u.field());
  assert.equal(u.scrolls.at(-1).id, 'fc-insight-notes'); noWrites(u);
});

test('learning link to another maker confirms before discarding, cancellation keeps the original plan and draft', () => {
  const u = entered(); u.edit('変更前のメーカーの仮説'); u.nav('learning');
  u.execute(u.link('p2'), 'click'); assert.equal(u.run('!!ASK'), true); u.run('askDone(false)');
  assert.equal(u.run('S.view'), 'learning'); assert.equal(u.run('S.fc.planId'), 'p1'); assert.equal(u.run('S.fc.ins[8].hypothesis'), '変更前のメーカーの仮説'); noWrites(u);
  u.execute(u.link('p2'), 'click'); u.run('askDone(true)'); u.flush();
  assert.equal(u.run('S.fc.planId'), 'p2'); assert.equal(u.run('S.view'), 'prep');
  assert.equal(u.field().value, '保存済みの仮説-p2'); assert.equal(u.run('fcDirty()'), false);
  assert.equal(u.scrolls.at(-1).id, 'fc-insight-notes'); noWrites(u);
});

test('a learning row without a plan stays plain text', () => {
  const u = makeUi(); u.nav('learning');
  assert.match(u.main().textContent, /計画のない架空製薬/); assert.equal(u.link(''), null); noWrites(u);
});

test('cold review route keeps its jump until real notes have loaded', () => {
  const u = makeUi(); u.run("openPlan('p1','review')");
  assert.equal(u.run('S.view'), 'prep'); assert.equal(u.run('S.fc.jump'), 'review');
  assert.ok(u.document.getElementById('fcs-review'), 'review skeleton is visible while reading');
  assert.equal(u.notes(), null); assert.equal(u.scrolls.length, 0, 'a skeleton does not consume the target');
  u.flush(); assert.equal(u.run('S.fc.jump'), ''); assert.equal(u.scrolls.at(-1).id, 'fc-insight-notes');
  assert.ok(u.scrolls.at(-1).values.includes('保存済みの仮説-p1'));
});

for (const first of ['latest', 'view']) test('partial reads keep the target until latest and view both arrive: ' + first, () => {
  const u = makeUi();
  u.run("S.fc.planId='p1';S.fc.draftPlan='p1';S.fc.loadingId='p1';fcFetch('p1',['latest']);fcFetch('p1',['view']);openPlan('p1','review')");
  const a = u.queue.find(q => q.args[0].parts[0] === first), b = u.queue.find(q => q.args[0].parts[0] !== first);
  u.queue.length = 0; u.respond(a);
  assert.equal(u.run('S.fc.jump'), 'review'); assert.equal(u.scrolls.length, 0);
  u.respond(b); assert.equal(u.run('S.fc.jump'), ''); assert.equal(u.scrolls.at(-1).id, 'fc-insight-notes');
});

test('no insight rows still expose the named notes card as the ready target', () => {
  const u = makeUi({ withInsights: false }); u.run("openPlan('p1','review')");
  assert.equal(u.run('S.fc.jump'), 'review'); u.flush();
  assert.ok(u.notes()); assert.match(u.notes().textContent, /人の記入/); assert.match(u.notes().textContent, /記入対象の月はありません。理由はまだ確認できていません/);
  assert.equal(u.notes().querySelectorAll('input,select,textarea,button').length, 0, 'an empty card creates no editable fields or save controls');
  assert.equal(u.scrolls.at(-1).id, 'fc-insight-notes'); assert.equal(u.run('S.fc.jump'), '');
  assert.equal(u.run('fcDirty()'), false); noWrites(u);
});

for (const options of [
  { withScoring: false }, { withScoring: false, withProposals: true },
  { withScoring: false, frozen: true }, { withScoring: false, canPlan: false },
]) test('empty insight location remains visible without creating rows: ' + JSON.stringify(options), () => {
  const u = makeUi({ withInsights: false, ...options }), before = JSON.stringify(u.pages.p1.view.boot);
  u.nav('prep'); u.flush();
  const notes = u.notes(); assert.ok(notes, 'normal navigation always identifies the human-notes location');
  assert.match(notes.textContent, /人の記入/); assert.match(notes.textContent, /記入対象の月/);
  if (options.frozen) assert.match(notes.textContent, /締め済み.*読み取り専用/);
  else assert.match(notes.textContent, /理由はまだ確認できていません/);
  assert.equal(notes.querySelectorAll('input,select,textarea,button,tr').length, 0);
  assert.equal(u.main().querySelector('[onclick="fcSaveIns(8)"]'), null);
  assert.equal(u.run('Object.keys(S.fc.ins).length'), 0); assert.equal(u.run('fcDirty()'), false);
  assert.equal(JSON.stringify(u.pages.p1.view.boot), before, 'showing an empty card does not add saved records');
  noWrites(u);
});

test('pending writes keep the target until the normal view is recovered', () => {
  const u = makeUi(); u.pages.p1.view.pendingWrite = { label: '合成の書きかけ', at: '2026-11-01' };
  u.run("openPlan('p1','review')"); u.flush();
  assert.equal(u.run('S.fc.jump'), 'review'); assert.equal(u.scrolls.length, 0); assert.equal(u.notes(), null);
  delete u.pages.p1.view.pendingWrite; u.run("fcFetch('p1',['view'])"); u.flush();
  assert.equal(u.run('S.fc.jump'), ''); assert.equal(u.scrolls.at(-1).id, 'fc-insight-notes');
});

test('old-plan data cannot consume a new plan target', () => {
  const u = entered(); u.run("openPlan('p2','review')");
  u.run('S.fc.data=__old.latest;S.fc.view=__old.view;render();fcJump()', { __old: u.pages.p1 });
  assert.equal(u.run('S.fc.jump'), 'review'); assert.equal(u.scrolls.length, 0);
  u.flush(); assert.equal(u.run('S.fc.planId'), 'p2'); assert.equal(u.scrolls.at(-1).id, 'fc-insight-notes');
  assert.ok(u.scrolls.at(-1).values.includes('保存済みの仮説-p2'));
});

assert.equal(failures, 0, 'normal insight access regressions pass');
console.log('app-ui-insight-access: ' + passed + ' real navigation/renderer, learning, dirty/capability and delayed-target cases PASS');
