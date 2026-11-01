#!/usr/bin/env node
/** Empty-state reasons, safe details and read-only retry use the actual UI helpers; no live browser or data. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { uiHtml, OWNER } from './gas-mock.mjs';

function makeUi() {
  const els = {}, rpc = [];
  const el = id => els[id] ||= { id, value: '', innerHTML: '', textContent: '', className: '', classList: { add() {}, remove() {} }, querySelector() { return null; }, querySelectorAll() { return []; } };
  const runner = () => { const h = {}; const p = new Proxy(h, { get(o, k) { if (k === 'withSuccessHandler') return f => { o.ok = f; return p; }; if (k === 'withFailureHandler') return f => { o.fail = f; return p; }; return (...args) => rpc.push({ name: String(k), args, ...o }); } }); return p; };
  const script = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE=new Proxy({},{get:()=>""});var CHAR_SVG=new Proxy({},{get:()=>""});')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'test' }, setUp: true, allowed: true, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, home: { fy: '2026', plans: [] } }));
  const c = vm.createContext({ document: { getElementById: el, querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {} }, window: { innerWidth: 1280, innerHeight: 800, addEventListener() {}, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } }, setTimeout() { return 1; }, clearTimeout() {}, console, google: { script: { get run() { return runner(); } } } });
  vm.runInContext(script, c);
  const run = (code, vars = {}) => { Object.assign(c, vars); return vm.runInContext(code, c); };
  run("S.homePre=true;FC_PRE_MAX=0;S.fc.planId='p1';S.fc.draftPlan='p1';S.fc.learn={planId:'p1',accuracy:{months:[]}}"); rpc.length = 0;
  const html = (readiness, frozen = false) => run('fcInsEmpty(__boot,__frozen)', { __boot: readiness ? { eval: { readiness } } : { eval: {} }, __frozen: frozen });
  return { run, html, rpc };
}
const q = (extra = {}) => ({ code: 'NO_ACTUALS', reason: '比較用の実績がありません。', currentPolicy: 'DO_NOT_DISPLAY_RAW_POLICY',
  counts: { actualRows: 0, closedCurrentFyMonths: 0, eligibleMonths: 0, insightRows: 0, displayedRows: 0 }, lastB2At: null, lastB4At: null, ...extra });
const visible = html => html.replace(/<[^>]+>/g, ' ');
let passed = 0, failures = 0;
function test(name, body) { try { body(); passed++; console.log('PASS ' + name); } catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); } }

test('the real review renderer shows the diagnosis reason and disclosure without fake editable rows', () => {
  const u = makeUi(), readiness = q();
  const boot = { eval: { insights: [], readiness }, quarterly: { proposals: [] } };
  u.run("S.fc.view={plan:{planId:'p1',frozen:false},can:{plan:true},boot:__boot}", { __boot: boot });
  const before = u.run('JSON.stringify(S.fc)'); const html = u.run('fcReviewTab({},S.fc.view)');
  assert.match(html, /id="fc-insight-notes"/); assert.match(html, /比較用の実績がありません/); assert.match(html, /<summary>確認した記録<\/summary>/);
  assert.doesNotMatch(html, /<input|<textarea|<select|fcSaveIns|startJob|NO_ACTUALS|DO_NOT_DISPLAY_RAW_POLICY/);
  assert.equal(u.run('JSON.stringify(S.fc)'), before); assert.equal(u.run('fcDirty()'), false); assert.deepEqual(u.rpc, []);
});

test('reasons are escaped and unexpected human/amount fields are not exposed', () => {
  const u = makeUi(), html = u.html(q({ reason: '<img src=x onerror="bad()">', owner: 'SYNTHETIC_PRIVATE_OWNER', amount: 987654321, counts: { actualRows: 0, hypothesis: 'SYNTHETIC_PRIVATE_MEMO' } }));
  assert.match(html, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt;/); assert.doesNotMatch(html, /<img|SYNTHETIC_PRIVATE|987654321|DO_NOT_DISPLAY_RAW_POLICY/);
});

test('zero is confirmed while null, negative, fractional, text and nonfinite counts remain unconfirmed', () => {
  const u = makeUi();
  for (const bad of [null, -1, .5, '1', Infinity, NaN, undefined]) {
    const html = u.html(q({ counts: { actualRows: 0, closedCurrentFyMonths: bad, eligibleMonths: bad, insightRows: 10, displayedRows: 0 } }));
    assert.match(html, /比較用の実績: 0行/); assert.match(html, /締まった今期の実績: 未確認/); assert.match(html, /今の基準で比較できる採点: 未確認/);
    assert.match(html, /保存済みの原因整理: 10行/); assert.match(html, /現在の記入対象: 0行/); assert.doesNotMatch(html, /NaN|Infinity|undefined/);
  }
});

test('successful log times are shown in JST; unknown times differ from no recorded success', () => {
  const u = makeUi();
  const normal = u.html(q({ lastB2At: '2026-08-11T03:00:00.000Z' }));
  assert.match(normal, /最後の採点: 2026\/08\/11 12:00/); assert.match(normal, /最後の原因整理: 記録なし/);
  const unknown = u.html(q({ code: 'UNKNOWN' })); assert.match(unknown, /最後の採点: 未確認/); assert.match(unknown, /最後の原因整理: 未確認/);
  const unprepared = u.html(q({ code: 'NOT_PREPARED', lastB4At: '2026-08-12T03:00:00.000Z' }));
  assert.match(unprepared, /最後の採点: 未確認/); assert.match(unprepared, /最後の原因整理: 2026\/08\/12 12:00/);
  assert.match(u.html(q({ lastB2At: 'not-a-time' })), /最後の採点: 未確認/);
});

test('frozen plans add read-only wording while preserving the diagnosed cause', () => {
  const u = makeUi(), html = u.html(q({ code: 'OLD_POLICY', reason: '以前の検証条件の記録だけです。' }), true);
  assert.match(html, /以前の検証条件の記録だけ/); assert.match(html, /締め済みの年度のため、読み取り専用/);
  assert.doesNotMatch(html, /fcSaveIns|startJob|<input|<select/);
});

test('old servers without diagnosis report the reason as unconfirmed', () => {
  const u = makeUi(), normal = u.html(null), frozen = u.html(null, true);
  assert.match(normal, /理由はまだ確認できていません/); assert.match(frozen, /理由はまだ確認できていません.*締め済み.*読み取り専用/);
  assert.match(normal, /画面を読み直して確認してください/); assert.match(frozen, /画面を読み直して確認してください/);
  assert.doesNotMatch(normal + frozen, /確認した記録|fcRetry|<input|fcSaveIns/);
});

test('only UNKNOWN offers the existing read retry; it sends no write job', () => {
  const u = makeUi();
  for (const code of ['NO_ACTUALS', 'OLD_POLICY', 'NO_CLOSED_ACTUALS', 'NO_CURRENT_EVAL', 'INSIGHTS_MISSING', 'INSIGHTS_STALE', 'NOT_PREPARED']) assert.doesNotMatch(u.html(q({ code })), /fcRetry/);
  const html = u.html(q({ code: 'UNKNOWN' })); assert.match(html, /onclick="fcRetry\(\)"/); assert.match(html, /もう一度読み込む/);
  u.run("S.ld.fcView={error:'synthetic read failure'}");
  const onclick = /onclick="([^"]+)"/.exec(html)[1]; u.run(onclick);
  assert.equal(u.rpc.length, 1); assert.equal(u.rpc[0].name, 'apiForecastPage'); assert.equal(u.rpc[0].args[0].planId, 'p1');
  assert.deepEqual(Array.from(u.rpc[0].args[0].parts), ['view']); assert.equal(u.run('fcDirty()'), false);
});

for (const state of ['S.writing=true', 'S.starting=true', "S.job={id:'busy'}"]) test('UNKNOWN retry is disabled while processing: ' + state, () => {
  const u = makeUi(); u.run(state); const html = u.html(q({ code: 'UNKNOWN' }));
  assert.match(html, /<button[^>]* disabled[^>]*onclick="fcRetry\(\)"/); assert.deepEqual(u.rpc, []);
});

assert.equal(failures, 0, 'insight readiness UI regressions pass');
console.log('app-ui-insight-readiness: ' + passed + ' safe empty reason, disclosure, fallback and read-only retry cases PASS');
