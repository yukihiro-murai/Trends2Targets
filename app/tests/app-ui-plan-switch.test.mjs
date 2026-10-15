#!/usr/bin/env node
/*
 * app-ui-plan-switch.test.mjs — 入力の表を別のメーカーに持ち越さない（@65 からあった不具合の直し）と、保存で送る行の元の位置（fromRow）。
 * 画面（UI.html の script）を vm で読み、google.script.run をモックのサーバー（gas-mock）につなぐ（応答は順に流す）。
 * 計画は本物の A-1（計画を作る）・A-2（売上の取り込み）・入力の保存（PLAN.EDIT INPUT.SAVE）で作る。
 *   1. メーカー X の入力を開き、「開く」（openPlan）でメーカー Y を開く → Y の入力の表に Y の行だけ（X の行を出さない）。版の比べも捨てる
 *   2. Y で直して保存 → 送る中身は Y の計画・Y の入力のハッシュ・Y の行（fromRow 付き）。サーバーで Y の行だけが書き換わり、X は変わらない
 *   3. 守り: 別の計画の入力中の行・読み直す前の入力から作った行は、保存しない（確かめて出し直す）。打っていない行は読み直した入力で作り直す
 *   4. 保存していない入力があるときの「開く」・選ぶ欄（fcSwitch）: 確かめてから捨てる。同じ計画の読み直しでは、ほかの種類の入力中の行を残す
 *   5. fromRow: 読んだ行の何番目か（0 から）。行を外しても行についていく。足した行・値を全部空にした行には付けない。画面だけの印 _lk は送らない。
 *      サーバーの記録（INPUT_LOG の前と後）にも、旧来の表にも fromRow は入らない
 * 名前と数字はテスト用の架空のもの。本物の Apps Script・ブラウザの上での確認の代わりではない。
 *
 *   node app/tests/app-ui-plan-switch.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setUpEnv, uiHtml, OWNER } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const env = setUpEnv();
const FY = env.run('appFy_(new Date())');
const ym = (m) => (m >= 4 ? FY : FY + 1) + '-' + String(m).padStart(2, '0');

// ---- 準備: ZAC の実績（甲製薬: 製品A・製品B、乙薬品: 製品Q）と、本物の A-1・A-2 で作った 2 つの計画 ----
const ext = Array.from({ length: 70 }, () => '');
const rec = (client, product, month, amount) => { const r = ext.slice(); r[40] = client; r[45] = 'ベース'; r[49] = product; r[56] = month; r[65] = amount; return r; };
const zacRows = [ext.map((_, i) => 'c' + (i + 1))];
for (let m = 1; m <= 12; m++) zacRows.push(rec('甲製薬', '製品A', D(FY - 1, m, 15), 1000000), rec('甲製薬', '製品B', D(FY - 1, m, 15), 400000), rec('乙薬品', '製品Q', D(FY - 1, m, 15), 300000));
const zac = env.makeBook('売上の元', { ['*' + (FY - 1) + '_actual_value']: { cols: 70, values: zacRows } });
env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
const makePlan = (client, people) => {
  const st = env.runJob('PLAN.CREATE', { clientName: client, fy: FY, peopleCsv: people });
  assert.equal(st.status, 'DONE', st.error);
  const imp = env.runJob('PLAN.RUN', { planId: st.result.planId, action: 'IMPORT.SALES' });
  assert.equal(imp.status, 'DONE', imp.error);
  return st.result.planId;
};
const X = makePlan('甲製薬', '鷹野,佐藤');
const Y = makePlan('乙薬品', '鷹野');
const view = (planId) => env.call('apiPlanView(__in)', { __in: { planId } });
const saveDirect = (planId, kind, rows) => {
  const st = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind, rows }, inputHash: view(planId).inputHash });
  assert.equal(st.status, 'DONE', st.error);
};
saveDirect(X, 'product', [{ person: '鷹野', product: '製品A', ym: ym(4), step: '+5%', reason: '甲の理由1' }, { person: '佐藤', product: '製品B', ym: ym(5), step: '-5%', reason: '甲の理由2' }]);
saveDirect(Y, 'product', [{ person: '鷹野', product: '製品Q', ym: ym(6), step: '+10%', reason: '乙の理由' }]);
const xRows0 = view(X).boot.input.product;
assert.deepEqual(xRows0.map((r) => r.reason), ['甲の理由1', '甲の理由2']);
assert.deepEqual(view(Y).boot.input.product.map((r) => r.reason), ['乙の理由']);

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
/** 製品の入力の表の、理由の欄の値（行の順）。入力の 4 種類は 1 カラムに並ぶので、製品のカードの欄だけ */
const reasons = (html) => [...html.matchAll(/<input class="inp cell" type="text" value="([^"]*)" oninput="fcInputType\(\d+,'reason',this\.value,'product'\)/g)].map((m) => m[1]);
const grid = () => run(`S.fc.inputKind = 'product'; viewForecastAll()`);
const lastStart = () => started[started.length - 1];

// ==== 1. X の入力を開き、「開く」で Y を開く ====
run(`openPlan('${X}', 'input')`); flush();
assert.equal(run('S.fc.view.plan.planId'), X);
assert.deepEqual(reasons(grid()), ['甲の理由1', '甲の理由2'], 'X の入力の表');
assert.equal(run('S.fc.draft.product.planId'), X, '入力中の行は、作った計画を持つ');
run(`S.fc.verCmp = 'V-x'`);
const xDraft = run('S.fc.draft.product');
run(`openPlan('${Y}', 'input')`);   // 打っていないので、確かめずに開く
assert.equal(run('ASK'), null);
flush();
assert.equal(run('S.fc.view.plan.planId'), Y);
const gy = grid();
assert.deepEqual(reasons(gy), ['乙の理由'], 'Y の入力の表に Y の行だけ（X の行を出さない）');
assert.doesNotMatch(gy, /甲の理由/);
assert.match(gy, /<option value="製品Q" selected>製品Q<\/option>/);
assert.equal(run('S.fc.draftPlan'), Y);
assert.equal(run('S.fc.verCmp'), null, '版の比べも捨てる');
assert.equal(run('S.fc.draft.product.planId'), Y);
assert.notEqual(run('S.fc.draft.product'), xDraft);

// ==== 2. Y で直して保存: Y の計画・Y のハッシュ・Y の行 ====
const yHash = view(Y).inputHash;
assert.equal(run('S.fc.view.inputHash'), yHash);
assert.notEqual(yHash, view(X).inputHash);
run(`fcInput(0, 'reason', '乙の理由（直した）'); fcSaveInput()`);
flush();
let s = lastStart();
assert.equal(s.kind, 'PLAN.EDIT');
assert.equal(s.payload.planId, Y, 'Y の計画へ');
assert.equal(s.payload.inputHash, yHash, 'Y の入力のハッシュ');
assert.equal(s.payload.action, 'INPUT.SAVE');
assert.equal(s.payload.args.kind, 'product');
assert.deepEqual(s.payload.args.rows.map((r) => [r.product, r.reason, r.fromRow]), [['製品Q', '乙の理由（直した）', 0]], 'Y の行だけ（元の位置つき）');
assert.ok(s.payload.args.rows.every((r) => !('_lk' in r)), '画面だけの印は送らない');
finishJobs();
assert.deepEqual(view(Y).boot.input.product.map((r) => [r.product, r.reason]), [['製品Q', '乙の理由（直した）']], 'サーバーで Y の行が書き換わる');
assert.deepEqual(view(X).boot.input.product, xRows0, 'X は変わらない');
assert.deepEqual(reasons(grid()), ['乙の理由（直した）'], '保存の後に読み直した Y の行');
assert.equal(run('S.fc.inputDirty.product'), undefined, '保存した種類の入力中の印は消える');

// ==== 3. 守り: 別の計画の入力中の行・読み直す前の入力から作った行は保存しない ====
{
  const n = started.length;
  run('S.fc.draft.product = __d; S.fc.inputDirty.product = true', { __d: xDraft });   // 前の計画の行が残った形（直す前の不具合と同じ形）
  run('fcSaveInput()'); flush();
  assert.equal(started.length, n, '保存しない');
  assert.match(String(run('ASK && "asked"')), /asked/, '確かめる');
  assert.match(el('askwrap').innerHTML, /メーカーかこの入力が変わりました。保存はしていません/);
  assert.match(el('askwrap').innerHTML, />出し直す<\/button>/);
  run('askDone(true)');
  assert.deepEqual(reasons(grid()), ['乙の理由（直した）'], '出し直すと、今のメーカーの行');
  assert.equal(run('S.fc.inputDirty.product'), undefined);
  // 打っている途中で、ほかの人が同じ種類を保存し、画面が読み直した（予測の実行の後など）: 保存しない
  run(`fcInput(0, 'reason', '乙の理由（打ちかけ）')`);
  saveDirect(Y, 'product', [{ person: '鷹野', product: '製品Q', ym: ym(6), step: '+10%', reason: 'ほかの人の保存' }]);
  run(`loadForecast('${Y}', true, { action: 'FORECAST.RUN' })`); flush();
  assert.deepEqual(reasons(grid()), ['乙の理由（打ちかけ）'], '打っている行は残す');
  run('fcSaveInput()'); flush();
  assert.equal(started.length, n, '読み直す前の入力から作った行は保存しない（ほかの人の保存を上書きしない）');
  run('askDone(true)');
  assert.deepEqual(reasons(grid()), ['ほかの人の保存'], '出し直すと、今の入力');
  // 打っていない行は、読み直した入力が変わっていれば作り直す（確かめない）
  saveDirect(Y, 'product', [{ person: '鷹野', product: '製品Q', ym: ym(6), step: '+10%', reason: '乙の理由（3 回目）' }]);
  run(`loadForecast('${Y}', true, { action: 'FORECAST.RUN' })`); flush();
  assert.deepEqual(reasons(grid()), ['乙の理由（3 回目）']);
  assert.equal(run('ASK'), null);
}

// ==== 4. 保存していない入力があるときの「開く」・選ぶ欄。同じ計画の読み直しでは、ほかの種類の入力中の行を残す ====
{
  run(`fcInput(0, 'reason', '乙の打ちかけ')`);
  run(`openPlan('${X}', 'input')`);
  assert.match(el('askwrap').innerHTML, /保存していない入力があります。保存せずに、ほかのメーカーを開きますか？/);
  assert.equal(run('S.fc.planId'), Y, 'やめれば Y のまま');
  run('askDone(true)'); flush();
  assert.deepEqual(reasons(grid()), ['甲の理由1', '甲の理由2'], '開くと X の行だけ');
  assert.equal(run('Object.keys(S.fc.inputDirty).length'), 0);
  // 選ぶ欄で Y へ（打っていない）→ Y の行だけ
  run(`fcSwitch('${Y}')`); flush();
  assert.deepEqual(reasons(grid()), ['乙の理由（3 回目）']);
  // メーカー全体を打ちかけ、製品を保存して読み直しても、メーカー全体の打ちかけは残る（同じ計画）
  run(`S.fc.inputKind = 'client'; viewForecastAll(); fcInput(0, 'reason', '全体の打ちかけ'); S.fc.inputKind = 'product'; viewForecastAll(); fcInput(0, 'reason', '乙の製品の保存'); fcSaveInput()`);
  flush(); finishJobs();
  assert.equal(run('S.fc.draft.client[0].reason'), '全体の打ちかけ', 'ほかの種類の入力中の行は残す');
  assert.equal(run('S.fc.inputDirty.client'), true);
  assert.deepEqual(reasons(grid()), ['乙の製品の保存']);
  // 残ったメーカー全体の行は、そのまま保存できる（同じ計画・もとの入力は変わっていない）
  const n = started.length;
  run(`S.fc.inputKind = 'client'; fcSaveInput()`); flush();
  assert.equal(started.length, n + 1);
  assert.equal(lastStart().payload.planId, Y);
  assert.equal(lastStart().payload.args.rows[0].reason, '全体の打ちかけ');
  assert.equal(lastStart().payload.args.rows[0].fromRow, 0);
  finishJobs();
  run(`S.fc.inputKind = 'product'`);
}

// ==== 5. fromRow: 行を外しても行についていく・足した行と空にした行には付けない ====
{
  run(`openPlan('${X}', 'input')`); flush();
  assert.deepEqual(reasons(grid()), ['甲の理由1', '甲の理由2']);
  // 1 行目を外し、残った行（もとの 2 行目）の月を変え、行を足す
  run(`fcInputDel(0); fcInput(0, 'ym', '${ym(7)}'); fcInputAdd(); fcInput(1, 'person', '鷹野'); fcInput(1, 'product', '製品A'); fcInput(1, 'ym', '${ym(8)}'); fcInput(1, 'step', '+5%'); fcInput(1, 'reason', '足した行')`);
  run('fcSaveInput()'); flush();
  s = lastStart();
  assert.equal(s.payload.planId, X);
  assert.deepEqual(s.payload.args.rows.map((r) => [r.person, r.product, r.ym, r.reason, 'fromRow' in r ? r.fromRow : '-']),
    [['佐藤', '製品B', ym(7), '甲の理由2', 1], ['鷹野', '製品A', ym(8), '足した行', '-']], '外した行の下の行は元の位置 1・足した行には付けない');
  assert.ok(s.payload.args.rows.every((r) => !('_lk' in r)));
  finishJobs();
  const after = view(X).boot.input.product;
  assert.deepEqual(after.map((r) => [r.person, r.product, r.ym, r.reason]), [['佐藤', '製品B', ym(7), '甲の理由2'], ['鷹野', '製品A', ym(8), '足した行']], '旧来の表は送った行のとおり');
  assert.ok(after.every((r) => !('fromRow' in r)), '旧来の表に fromRow は入らない');
  const log = env.call('appInputLogRead_(__p)', { __p: X });
  assert.ok(log.length > 0 && log.every((r) => !/fromRow/.test(JSON.stringify(r.before_json) + JSON.stringify(r.after_json))), '記録の前と後に fromRow は入らない');
  // 値を全部空にした行には付けない（旧来の保存が書かない行。自信だけの行も同じ）
  run(`fcInput(0, 'person', ''); fcInput(0, 'product', ''); fcInput(0, 'ym', ''); fcInput(0, 'step', ''); fcInput(0, 'reason', ''); fcInput(0, 'selfConf', '高い'); fcSaveInput()`);
  flush();
  s = lastStart();
  assert.ok(!('fromRow' in s.payload.args.rows[0]), '空にした行には付けない: ' + JSON.stringify(s.payload.args.rows[0]));
  assert.equal(s.payload.args.rows[1].fromRow, 1, 'ほかの行はそのまま');
  finishJobs();
}

// ==== 6. 文字の欄は打つたびに控える: 描き直しても（読み込みの終わりなど）打ちかけの文字が残り、保存できる（2026-10-13） ====
{
  run(`openPlan('${X}', 'input')`); flush();
  const before = reasons(grid());
  run(`fcInputType(0, 'reason', '打ちかけの理由')`);
  assert.equal(run('S.fc.inputDirty.product'), true, '打ったら未保存の印（描き直さずに付ける）');
  assert.equal(reasons(grid())[0], '打ちかけの理由', '描き直しても打ちかけの文字が残る（前は欄を離れるまで控えなかった）');
  assert.equal(reasons(grid())[1], before[1]);
  run('fcSaveInput()'); flush();
  assert.equal(lastStart().payload.args.rows[0].reason, '打ちかけの理由');
  finishJobs();
}

console.log('app-ui-plan-switch: ok');
