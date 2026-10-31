#!/usr/bin/env node
// 未保存の離脱保護、保存完了時の解除、再描画でのメモ保持。実ブラウザの確認とは別のVM回帰。
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

// 閲覧だけでは標準確認を登録しない。4種の編集は、画面に依存せず離脱を止める。
for (const edit of [
  'S.fc.inputDirty.product=true', 'S.fc.budget[1]={adopted:"0"}',
  'S.fc.ins[1]={memo:"入力中"}', 'S.fc.dec[1]="保留"',
]) {
  const u = makeUi();
  assert.equal(u.leave().prevented, false);
  u.input(edit);
  assert.equal(u.leave().prevented, true, edit);
  assert.equal(u.leave().returnValue, '');
  u.run("go('home')");
  assert.equal(u.leave().prevented, true, 'ホームでも編集を保護する');
  u.run('fcDropDrafts()');
  assert.equal(u.leave().prevented, false, '明示的な破棄で解除');
  assert.equal(u.events.beforeunload.size, 0, '不要なリスナーを残さない');
}

// 保存開始や失敗では解除しない。保存した種類だけ消し、ほかの編集と判断は残す。
{
  const u = makeUi();
  u.input('S.fc.inputDirty.product=true; S.fc.budget[1]={adopted:"0"}; S.fc.dec[1]="保留"');
  u.run('S.writing=true; S.starting=true');
  assert.equal(u.leave().prevented, true, '保存中も保護');
  u.run('S.writing=false; S.starting=false; render()');
  assert.equal(u.leave().prevented, true, '失敗後も保護');
  u.run("loadForecast('p1', true, {action:'INPUT.SAVE',kind:'product'})");
  assert.equal(u.run('!!S.fc.inputDirty.product'), false);
  assert.equal(u.run('S.fc.dec[1]'), '保留', '別種類の保存で判断を消さない');
  assert.equal(u.leave().prevented, true);
  u.run("loadForecast('p1', true, {action:'BUDGET.SAVE'})");
  assert.equal(u.leave().prevented, true, '判断が残る');
  u.run("loadForecast('p1', true, {action:'REVIEW.DECIDE'})");
  assert.equal(u.leave().prevented, false, '全部保存できた後だけ解除');
}

// 反映前の予算組立を保護する。入力・選択だけではサーバーを呼ばない。
for (const edit of ["fcBudSetExtra('120,000')", "fcBudSetSrc('TRI')", 'fcBudSetCalib(false)']) {
  const u = makeUi();
  u.input(edit);
  assert.equal(u.leave().prevented, true, edit);
  assert.equal(u.queue.length, 0, '組立の編集では通信しない');
  u.run('fcDropDrafts()');
  assert.equal(u.leave().prevented, false);
  assert.equal(u.run('S.fc.budPick'), null, '破棄した組立は再表示しない');
}

// 確定版のメモは描画に使う値を状態へ保持する。別メーカーへ持ち越さない。
for (const kind of ['submit', 'decision']) {
  const u = makeUi();
  u.run("S.fc.ver={planId:'p1',pending:{versionId:'v1'}}");
  u.input(`verNoteSet('${kind}', 'メモ<&"')`);
  u.run('render()');
  assert.equal(u.run(`verNoteGet('${kind}')`), 'メモ<&"');
  assert.equal(u.leave().prevented, true);
  u.run('fcDropDrafts()');
  assert.equal(u.run(`verNoteGet('${kind}')`), '');
  assert.equal(u.leave().prevented, false);
}

// 実際の確定版HTMLにも、保持したメモを安全に戻す。
{
  const u = makeUi();
  u.run(`S.fc.ver={planId:'p1',versions:[],can:{submit:true,approve:true},me:'owner@example.test',
    current:{annual:{p50:100},budget:{adopted:100,uplift:0,final:100},monthly:[]},
    pending:{versionId:'v1',no:1,state:'SUBMITTED',annual:{p50:100},budget:{final:100},submittedBy:'other@example.test'}}`);
  u.input("verNoteSet('submit','提出<&\"'); verNoteSet('decision','判断<&\"')");
  const html = u.run('fcVersionTab(null,null)');
  assert.match(html, /id="ver_submit_note"[^>]*value="提出&lt;&amp;&quot;"[^>]*oninput=/);
  assert.match(html, /id="ver_note"[^>]*value="判断&lt;&amp;&quot;"[^>]*oninput=/);
}

// 処理開始直後から入力を固定し、保存中の追記を受け付けて後で消すことを防ぐ。
{
  const u = makeUi();
  u.input("S.fc.draft.product=[{reason:'送信した入力'}]; S.fc.inputDirty.product=true; S.fc.budget[1]={adopted:'100'}; S.fc.ins[1]={hypothesis:'元'}; S.fc.dec[1]='保留'");
  for (const state of ["S.starting=true", "S.starting=false; S.writing=true", "S.writing=false; S.job={kind:'PLAN.EDIT'}"]) {
    u.run(state);
    u.input("fcInputType(0,'reason','追記','product'); fcInput(0,'step','+20%','product'); fcBudget(1,'adopted','200'); fcIns(1,'hypothesis','追記'); fcDec(1,'承認')");
    assert.equal(u.run('S.fc.draft.product[0].reason'), '送信した入力');
    assert.equal(u.run('S.fc.draft.product[0].step'), undefined);
    assert.equal(u.run('S.fc.budget[1].adopted'), '100');
    assert.equal(u.run('S.fc.ins[1].hypothesis'), '元');
    assert.equal(u.run('S.fc.dec[1]'), '保留');
    assert.equal(u.leave().prevented, true);
    const fields = [{ disabled: false }, { disabled: false }];
    u.run("fcLockDrafts(__root)", { __root: { querySelectorAll: selector => selector === 'button' ? [] : fields } });
    assert.equal(fields.every(f => f.disabled), true, '表示した欄も固定する');
  }
}

// 別の版・見直し案へ変わっても古い入力は流用せず、控えを表示して明示的に破棄できる。
{
  const u = makeUi();
  u.run("S.fc.ver={pending:{versionId:'v1'}}");
  u.input("verNoteSet('decision','前の版の理由')");
  u.run("S.fc.ver.pending={versionId:'v2'}");
  assert.equal(u.run("verNoteGet('decision')"), '');
  assert.match(u.run('fcHeldCard()'), /前の版の理由/);
  u.run("S.fc.view={boot:{quarterly:{reviewId:'r1',proposals:[{row:10,target:'ai_weight',current:0.5,proposed:0.6}]}}}");
  u.input("fcDec(10,'却下')");
  u.run("fcFetch('p1',['view'])");
  u.queue.shift().ok({ view: { plan: { planId: 'p1' }, boot: { quarterly: { reviewId: 'r2', proposals: [{ row: 10, target: 'ai_weight', current: 0.5, proposed: 0.8 }] } } } });
  assert.equal(u.run('S.fc.dec[10]'), undefined, '別案へ旧判断を使わない');
  assert.match(u.run('fcHeldCard()'), /却下/);
  assert.equal(u.leave().prevented, true, '控えも未保存として守る');
  u.run("ask=function(m,l,ok){ok()}; fcHeldDiscard()");
  assert.equal(u.run('fcHeldCard()'), '');
  assert.equal(u.leave().prevented, false, '控えを明示的に破棄して解除');
}

// 成功応答で消すのは送ったメモだけ。失敗・新しい追記・別メーカーのメモを消さない。
{
  const u = makeUi();
  u.run("S.fc.ver={planId:'p1',pending:null,inputHash:'h'}; ask=function(m,l,ok){ok()}");
  u.input("verNoteSet('submit','元のメモ')");
  u.el('ver_submit_note').value = '元のメモ';
  u.run('verSubmit()');
  const failed = u.queue.shift();
  failed.fail({ message: '保存を拒否しました' });
  assert.equal(u.leave().prevented, true);
  u.run('verSubmit()');
  const saved = u.queue.shift();
  u.input("verNoteSet('submit','新しいメモ')");
  saved.ok({ version: { no: 1 } });
  assert.equal(u.run("verNoteGet('submit')"), '新しいメモ');
  assert.equal(u.leave().prevented, true);
  u.el('ver_submit_note').value = '新しいメモ';
  u.run('verSubmit()');
  const final = u.queue.find(q => q.fn === 'apiVersionSubmit');
  final.ok({ version: { no: 2 } });
  assert.equal(u.run("verNoteGet('submit')"), '');
  assert.equal(u.leave().prevented, false);
}

console.log('app-ui-unsaved: ok');
