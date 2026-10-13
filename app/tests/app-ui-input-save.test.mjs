#!/usr/bin/env node
/*
 * app-ui-input-save.test.mjs — 入力の保存で画面が送る中身（版 10 の最後の点検の直し V1・V2）。
 * 画面（UI.html の script）を vm で読み、google.script.run をモックのサーバー（gas-mock）につなぐ（応答は順に流す）。
 * 計画は本物の A-1（計画を作る）・A-2（売上の取り込み）・入力の保存（PLAN.EDIT INPUT.SAVE）で作る。
 *   V1. この画面の保存は、いつも fromRows: true を送る（どの行も開いたときの行の印 fromRow で組む）。開いたときの行をすべて外して足した保存、
 *       すべて空にして足した保存でも送る（fromRow の付いた行が 1 つも無くても、サーバーが位置で組んで「変えた」としないように）
 *   V2. 自信（selfConf）は、開いたときの自信から変えた行だけ送る（送らない行は、サーバーが今の自信のままにする）。
 *       - 1 行の自信だけ変えた → その行だけ送る。変えて戻した行・自信以外だけ変えた行は送らない。「—」に戻したら空を送る
 *       - 古い画面: 開いた後に、ほかの人が自信だけ変えた（入力のハッシュは変わらない）。この画面で別の行を直して保存しても、その自信を戻さない
 *       - 画面だけの印（_lk・_conf0）は送らない
 * 名前と数字はテスト用の架空のもの。モックの上の確かめで、本物の Apps Script・ブラウザの上では動かしていない。
 *
 *   node app/tests/app-ui-input-save.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setUpEnv, uiHtml, OWNER } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const env = setUpEnv();
const FY = env.run('appFy_(new Date())');
const ym = (m) => (m >= 4 ? FY : FY + 1) + '-' + String(m).padStart(2, '0');

// ---- 準備: ZAC の実績（甲製薬: 製品A・製品B）と、本物の A-1・A-2 で作った計画 ----
const ext = Array.from({ length: 70 }, () => '');
const rec = (client, product, month, amount) => { const r = ext.slice(); r[40] = client; r[45] = 'ベース'; r[49] = product; r[56] = month; r[65] = amount; return r; };
const zacRows = [ext.map((_, i) => 'c' + (i + 1))];
for (let m = 1; m <= 12; m++) zacRows.push(rec('甲製薬', '製品A', D(FY - 1, m, 15), 1000000), rec('甲製薬', '製品B', D(FY - 1, m, 15), 400000));
const zac = env.makeBook('売上の元', { ['*' + (FY - 1) + '_actual_value']: { cols: 70, values: zacRows } });
env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
const st0 = env.runJob('PLAN.CREATE', { clientName: '甲製薬', fy: FY, peopleCsv: '鷹野,佐藤' });
assert.equal(st0.status, 'DONE', st0.error);
const X = st0.result.planId;
assert.equal(env.runJob('PLAN.RUN', { planId: X, action: 'IMPORT.SALES' }).status, 'DONE');
const view = () => env.call('apiPlanView(__in)', { __in: { planId: X } });
const confs = () => view().inputLog.rows.product.map((e) => (e ? e.conf : null));
const logRows = () => env.call('appInputLogRead_(__p)', { __p: X });
/** ほかの人の保存（画面を通さない。開いた後の入力のハッシュを渡す） */
const saveDirect = (rows) => {
  const st = env.runJob('PLAN.EDIT', { planId: X, action: 'INPUT.SAVE', args: { kind: 'product', rows }, inputHash: view().inputHash });
  assert.equal(st.status, 'DONE', st.error);
};
const R0 = { person: '鷹野', product: '製品A', ym: ym(4), step: '+5%', reason: '理由1' };
const R1 = { person: '佐藤', product: '製品B', ym: ym(5), step: '-5%', reason: '理由2' };
saveDirect([Object.assign({ selfConf: '低い' }, R0), Object.assign({ selfConf: 'ふつう' }, R1)]);
assert.deepEqual(confs(), ['低い', 'ふつう']);

// ---- 画面: google.script.run をモックのサーバーにつなぐ（呼ばれた順に控え、flush() で応答を流す。裏の処理の始まりは控えて、サーバーでも始める） ----
const queue = [];
const started = [];
const timers = [];
const makeRunner = () => { const t = { ok: null, fail: null }; const p = new Proxy(t, { get: (o, k) => {
  if (k === 'withSuccessHandler') return (fn) => { o.ok = fn; return p; };
  if (k === 'withFailureHandler') return (fn) => { o.fail = fn; return p; };
  return (...args) => { queue.push({ fn: String(k), args, ok: o.ok, fail: o.fail }); };
} }); return p; };
const flush = () => {
  for (let i = 0; queue.length && i < 200; i++) {
    const q = queue.shift();
    let res;
    try {
      env.as(OWNER);
      res = env.call(q.fn + '.apply(null, __args)', { __args: JSON.parse(JSON.stringify(q.args)) });
      if (q.fn === 'apiStartJob') started.push(JSON.parse(JSON.stringify(q.args[0])));
    } catch (e) { if (q.fail) q.fail({ message: e.message }); continue; }
    if (q.ok) q.ok(res);
  }
  assert.equal(queue.length, 0, '応答を流し切る');
};
/** 裏の処理をトリガーで最後まで動かし、画面の問い合わせ（pollJob）を流す */
const finishJobs = () => {
  for (let i = 0; i < 30; i++) env.fireTriggers('triggerRunJob');
  for (let i = 0; i < 10; i++) {
    const due = timers.splice(0);
    due.forEach((f) => f());
    flush();
    if (!timers.length) break;
  }
};
const els = {};
const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '', className: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
  .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
  .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout() {}, confirm: () => false,
  window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
  google: { script: { get run() { return makeRunner(); } } } });
vm.runInContext(js, ui);
const run = (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };
flush();   // 起動のときのホームの読み込み
timers.length = 0;
const grid = () => run(`S.fc.inputKind = 'product'; viewForecast()`);
/** 入力の保存を押して、送った中身（INPUT.SAVE の args）を返す */
const save = () => {
  const n = started.length;
  run('fcSaveInput()'); flush();
  assert.equal(started.length, n + 1, '保存を始める');
  const s = started[started.length - 1];
  assert.equal(s.kind, 'PLAN.EDIT');
  assert.equal(s.payload.action, 'INPUT.SAVE');
  assert.equal(s.payload.planId, X);
  assert.ok(s.payload.args.rows.every((r) => Object.keys(r).every((k) => k.charAt(0) !== '_')), '画面だけの印（_lk・_conf0）は送らない: ' + JSON.stringify(s.payload.args.rows));
  return s.payload.args;
};
/** 入力中の行の自信（画面の中の値） */
const draftConfs = () => JSON.parse(run('JSON.stringify(S.fc.draft.product.map(function(r){ return r.selfConf; }))'));
const confSent = (args) => args.rows.map((r) => ('selfConf' in r ? r.selfConf : '-'));
const fromSent = (args) => args.rows.map((r) => ('fromRow' in r ? r.fromRow : '-'));

run(`openPlan('${X}', 'input')`); flush();
grid();
assert.deepEqual(draftConfs(), ['低い', 'ふつう'], '開いたときの自信');

// ==== V2-1. 1 行の自信だけ変えた: その行だけ送る ====
{
  run(`fcInput(1, 'selfConf', '高い')`);
  const seen = new Set(logRows().map((r) => r.log_id));
  const a = save();
  assert.equal(a.fromRows, true, 'V1: いつも fromRows を送る');
  assert.deepEqual(fromSent(a), [0, 1]);
  assert.deepEqual(confSent(a), ['-', '高い'], '自信を変えた行だけ送る（変えていない行は送らない）');
  finishJobs();
  assert.deepEqual(confs(), ['低い', '高い']);
  const added = logRows().filter((r) => !seen.has(r.log_id));
  assert.deepEqual(added.map((r) => [r.change, r.row_key.split('|')[1], r.self_conf]), [['CONF', '佐藤', '高い']], '記録は変えた行の自信だけ');
}

// ==== V2-2. 「—」に戻したら空を送る。変えて戻した行・自信以外だけ変えた行は送らない ====
{
  assert.deepEqual(draftConfs(), ['低い', '高い'], '保存の後に読み直した自信');
  run(`fcInput(0, 'selfConf', ''); fcInput(1, 'selfConf', '低い'); fcInput(1, 'selfConf', '高い'); fcInput(1, 'reason', '理由2（直した）')`);
  const a = save();
  assert.equal(a.fromRows, true);
  assert.deepEqual(confSent(a), ['', '-'], '外した自信は空を送る・変えて戻した行は送らない');
  finishJobs();
  assert.deepEqual(confs(), ['', '高い'], '直した行は今の自信のまま');
}

// ==== V2-3. 古い画面: 開いた後に、ほかの人が自信だけ変えた。この画面で別の行を直して保存しても、その自信を戻さない ====
{
  grid();
  const hashA = run('S.fc.view.inputHash');
  assert.deepEqual(draftConfs(), ['', '高い']);
  // ほかの人: 行は同じまま、1 行目の自信だけ「低い」にした（入力の表は変わらないので、入力のハッシュも変わらない）
  const cur = view().boot.input.product;
  saveDirect(cur.map((r, i) => Object.assign({}, r, i === 0 ? { selfConf: '低い' } : {})));
  assert.equal(view().inputHash, hashA, '自信だけの保存では入力のハッシュは変わらない');
  assert.deepEqual(confs(), ['低い', '高い']);
  // この画面（古い）: 2 行目の理由だけ直して保存
  run(`fcInput(1, 'reason', 'この画面の理由')`);
  const seen = new Set(logRows().map((r) => r.log_id));
  const a = save();
  assert.deepEqual(confSent(a), ['-', '-'], '自信を変えていないので送らない（古い自信「—」を送らない）');
  finishJobs();
  assert.deepEqual(view().boot.input.product.map((r) => r.reason), ['理由1', 'この画面の理由'], '保存は通る');
  assert.deepEqual(confs(), ['低い', '高い'], 'ほかの人の自信を戻さない');
  const added = logRows().filter((r) => !seen.has(r.log_id));
  assert.deepEqual(added.map((r) => [r.change, r.row_key.split('|')[1], r.self_conf]), [['CHANGE', '佐藤', '高い']], 'この画面が触っていない行の自信の記録を足さない');
}

// ==== V1-1. 開いたときの行をすべて外して、行を足した: fromRows を送る（fromRow の付いた行は無い）。古い自信も送らない ====
{
  grid();
  run(`fcInputDel(1); fcInputDel(0); fcInputAdd(); fcInput(0, 'person', '佐藤'); fcInput(0, 'product', '製品A'); fcInput(0, 'ym', '${ym(10)}'); fcInput(0, 'step', '+5%'); fcInput(0, 'reason', '足した行')`);
  const a = save();
  assert.equal(a.fromRows, true, '開いたときの行が 1 つも残っていなくても、fromRows を送る');
  assert.deepEqual(fromSent(a), ['-'], '足した行に fromRow は付けない');
  assert.deepEqual(confSent(a), ['-'], '外した行の自信を送らない');
  assert.deepEqual(a.rows, [{ person: '佐藤', product: '製品A', ym: ym(10), step: '+5%', reason: '足した行' }]);
  finishJobs();
  assert.deepEqual(view().boot.input.product.map((r) => [r.person, r.product, r.ym, r.reason]), [['佐藤', '製品A', ym(10), '足した行']], '旧来の表は送った行のとおり');
  assert.ok(view().boot.input.product.every((r) => !('fromRows' in r) && !('fromRow' in r)), '旧来の表に印は入らない');
}

// ==== V1-2. 開いたときの行の値をすべて空にして、行を足した: fromRows を送る（空にした行にも、足した行にも fromRow は付けない） ====
{
  grid();
  run(`fcInput(0, 'person', ''); fcInput(0, 'product', ''); fcInput(0, 'ym', ''); fcInput(0, 'step', ''); fcInput(0, 'reason', ''); fcInputAdd(); fcInput(1, 'person', '鷹野'); fcInput(1, 'product', '製品B'); fcInput(1, 'ym', '${ym(11)}'); fcInput(1, 'step', '-5%'); fcInput(1, 'reason', '足した行2')`);
  const a = save();
  assert.equal(a.fromRows, true);
  assert.deepEqual(fromSent(a), ['-', '-']);
  assert.deepEqual(confSent(a), ['-', '-']);
  finishJobs();
  assert.deepEqual(view().boot.input.product.map((r) => [r.person, r.product, r.reason]), [['鷹野', '製品B', '足した行2']]);
}

// ==== V2-4. 足した行で自信を選んだら送る ====
{
  grid();
  run(`fcInputAdd(); fcInput(1, 'person', '佐藤'); fcInput(1, 'product', '製品A'); fcInput(1, 'ym', '${ym(12)}'); fcInput(1, 'step', '+5%'); fcInput(1, 'selfConf', 'ふつう')`);
  const a = save();
  assert.equal(a.fromRows, true);
  assert.deepEqual(fromSent(a), [0, '-']);
  assert.deepEqual(confSent(a), ['-', 'ふつう']);
  finishJobs();
  assert.deepEqual(confs().slice(1), ['ふつう']);
}

console.log('app-ui-input-save: ok');
