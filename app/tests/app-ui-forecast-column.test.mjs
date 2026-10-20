#!/usr/bin/env node
/*
 * app-ui-forecast-column.test.mjs — 予測の画面を 1 カラムにした（2026-10-13 村井さん「タブ切り替えが使いにくいので 1 カラムで縦に」
 * 「予測画面も年度を選択するプルダウンを。メーカーのフィールド幅が広すぎる」）。
 * 画面（UI.html の script）を vm で読み、google.script.run をモックのサーバー（gas-mock）につなぐ（応答は順に流す）。
 *   1. 「メーカーを選ぶ」だけの画面は無い。予測を開くと、見ている年度の最初のメーカー（名前の順）を開く
 *   2. 題の横: 年度（1 マス）とメーカー（1 マス・名前だけ）のプルダウン。中身は 6 つの区切りのカードを上から（タブ・目次は無い）
 *   3. 年度を選ぶ: 同じ名前のメーカーがあればそれ、無ければ最初のメーカー。計画の無い年度はよみの案内 1 枚。保存していない入力があれば先に確かめる
 *   4. 入力の 4 種類は同時に見える: 未保存の印と「入力を保存」は種類ごとのカード（保存も種類ごと）
 *   5. ほかの画面から区切りを指して開く（openPlan(planId, 'version') など）: その区切りへ画面の中で送る。「開く」は先頭から
 *   6. 1 つの区切りの表示で失敗しても、ほかの区切りは出す
 *   7. CSS: 区切りのカード・中の段・題の横の 2 つの欄（スマホは半分ずつ）
 * 名前と数字はテスト用の架空のもの。モックの上の確かめで、本物の Apps Script・ブラウザの上では動かしていない。
 *
 *   node app/tests/app-ui-forecast-column.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fcSection, setUpEnv, uiHtml, OWNER } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const env = setUpEnv();
const FY = env.run('appFy_(new Date())');

// ---- 準備: ZAC の実績と、本物の A-1・A-2 で作った計画（今の年度に 2 社、前の年度に 2 社） ----
const ext = Array.from({ length: 70 }, () => '');
const rec = (client, product, month, amount) => { const r = ext.slice(); r[40] = client; r[45] = 'ベース'; r[49] = product; r[56] = month; r[65] = amount; return r; };
const zacRows = [ext.map((_, i) => 'c' + (i + 1))];
for (const y of [FY - 2, FY - 1]) for (let m = 1; m <= 12; m++) zacRows.push(rec('甲製薬', '製品A', D(y, m, 15), 1000000), rec('乙薬品', '製品Q', D(y, m, 15), 300000));
const zac = env.makeBook('売上の元', { ['*' + (FY - 1) + '_actual_value']: { cols: 70, values: zacRows } });
env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
const makePlan = (client, fy) => {
  const st = env.runJob('PLAN.CREATE', { clientName: client, fy, peopleCsv: '鷹野' });
  assert.equal(st.status, 'DONE', st.error);
  assert.equal(env.runJob('PLAN.RUN', { planId: st.result.planId, action: 'IMPORT.SALES' }).status, 'DONE');
  return st.result.planId;
};
const P = { 甲: { [FY]: makePlan('甲製薬', FY), [FY - 1]: makePlan('甲製薬', FY - 1) }, 乙: { [FY]: makePlan('乙薬品', FY), [FY - 1]: makePlan('乙薬品', FY - 1) } };
const byName = ['甲製薬', '乙薬品'].sort((a, b) => a.localeCompare(b, 'ja'));
const firstKey = byName[0] === '甲製薬' ? '甲' : '乙', secondKey = firstKey === '甲' ? '乙' : '甲';

// ---- 画面 ----
const queue = [], started = [], timers = [];
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
const els = {}, selectors = [], scrolled = [];
const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '', className: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
  .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
  .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
const ui = vm.createContext({ document: { getElementById: el, querySelector: (q) => { selectors.push(q); return null; }, querySelectorAll: () => [], addEventListener() {} },
  setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout() {}, confirm: () => false,
  window: { addEventListener() {}, scrollTo() { scrolled.push('top'); }, innerWidth: 1280, innerHeight: 800, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
  google: { script: { get run() { return makeRunner(); } } } });
vm.runInContext(js, ui);
const run = (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };
flush();   // 起動のときのホームの読み込み（ホームの年度 = 今の年度・年度の選択肢）
timers.length = 0;
const page = () => run('viewForecastAll()');
const head = (h) => h.slice(0, h.indexOf('</div>') + 6);
const card = (h, kind) => { const i = h.indexOf('id="fc-in-' + kind + '"'); return i < 0 ? '' : h.slice(i, h.indexOf('<div class="card fc-inkind"', i + 10) > 0 ? h.indexOf('<div class="card fc-inkind"', i + 10) : h.indexOf('</section>', i)); };

// ==== 1. 予測を開くと、見ている年度の最初のメーカーを開く（「メーカーを選ぶ」の画面は無い） ====
run(`go('forecast')`);
{
  // 一覧を読むまでも、区切りのカード（見出しと灰色の帯）を出しておく（読めたら同じ場所に中身が入る。2026-10-13 村井さん）
  const w = page();
  assert.deepEqual([...w.matchAll(/<section class="card fcsec(?: nohead)?" id="fcs-(\w+)"/g)].map((m) => m[1]), ['input', 'forecast', 'basis', 'tri', 'budget', 'version'], '読み込み中も区切り（予測準備・予測結果・三角測量・予算策定の 4 つの画面）');
  assert.match(w, /class="skel" role="status"/, '中身の場所は灰色の帯');
  assert.doesNotMatch(w, /観測中…/, 'よみの待ちのカードは出さない（中身と大きさが違い、読めたときに画面が動くため）');
}
flush(); flush();
assert.equal(run('S.fc.planId'), P[firstKey][FY], '今の年度の、名前の順で最初のメーカーを開く');
let h = page();
assert.doesNotMatch(h, /メーカーを選ぶ/);

// ==== 2. 題の横: 年度とメーカー（1 マスずつ・名前だけ）。中身は 6 つの区切り ====
assert.match(head(h), /^<div class="page-head"><h1>予測準備<\/h1><span class="fc-sels" data-near="1"><select class="inp sm" id="fc_fy" aria-label="年度"/, '題のすぐ横（data-near）に年度');
assert.match(head(h), new RegExp('<option value="' + FY + '" selected>FY' + FY + '</option>'), '年度は開いている計画の年度');
const mk = /<select class="inp sm" id="fc_mk" aria-label="メーカー"[^>]*>([\s\S]*?)<\/select>/.exec(head(h));
assert.ok(mk, 'メーカーのプルダウン（1 マス: .inp.sm）');
assert.deepEqual([...mk[1].matchAll(/>([^<]*)<\/option>/g)].map((m) => m[1]), byName, 'その年度のメーカーだけを名前の順に、名前だけ（年度や印を付けない）');
assert.equal(run(`viewTitle(${JSON.stringify(head(h))}).tools`).startsWith('<span class="fc-sels"'), true, '題の横の道具の位置（ホーム・メーカー一覧と同じ .vnear）');
assert.deepEqual([...h.matchAll(/<section class="card fcsec(?: nohead)?" id="fcs-(\w+)"/g)].map((m) => m[1]), ['input', 'forecast', 'basis', 'tri', 'budget', 'version']);
// 中身がすぐ小見出しで始まる区切り（入力など）は、区切りの見出しを重ねない（2026-10-16 村井さん）
assert.deepEqual([...h.matchAll(/<h2 id="fcs-h-\w+">([^<]*)/g)].map((m) => m[1]), ['入力', '予測結果', '根拠', '手法ごとの予測', '予算案', '確定版'], '見出しのある区切りは同じ形の見出し');
assert.match(h, /<section class="card fcsec" id="fcs-input"[\s\S]*<ol class="in-steps"[\s\S]*<div class="card fc-inkind" id="fc-in-product"><div class="card-head"><h2>製品の動向/, '入力は順の案内のあと、製品の動向');
assert.doesNotMatch(h, /class="tabs"|onclick="fcTab\(|class="tabs sub"><button/, 'タブ・目次は無い（グラフ / 表で見る の切り替えだけ）');
assert.deepEqual([...fcSection(h, 'input').matchAll(/<div class="card fc-inkind" id="fc-in-(\w+)"><div class="card-head"><h2>([^<]*)</g)].map((m) => [m[1], m[2]]),
  [['product', '製品の動向'], ['client', 'メーカーの動向'], ['opinions', '担当者の洞察'], ['devspot', '新製品やスポット開発の予定']], '入力の 4 種類はカードを縦に');
assert.doesNotMatch(h, /全体の学びは『学び』で見られます|go\('learning'\)/, '画面の中に別の画面へのリンクを置かない');

// ==== 3. 年度を選ぶ ====
run(`fcSwitch('${P[secondKey][FY]}')`); flush();
run(`fcSetFy('${FY - 1}')`); flush();
assert.equal(run('S.fc.planId'), P[secondKey][FY - 1], '同じ名前のメーカーがあれば、その年度の同じメーカー');
assert.match(head(page()), new RegExp('<option value="' + (FY - 1) + '" selected>FY' + (FY - 1)));
run(`fcSetFy('${FY + 2}')`); flush();
assert.equal(run('S.fc.planId'), '', '計画の無い年度は、メーカーを開かない');
h = page();
assert.match(h, new RegExp('FY' + (FY + 2) + ' の計画はまだありません'), 'よみの案内 1 枚');
assert.equal((h.match(/class="card"/g) || []).length, 4, 'カードは画面ごとに案内の 1 枚だけ（予測準備・予測結果・三角測量・予算策定）');
assert.match(head(h), new RegExp('<option value="' + (FY + 2) + '" selected>'), '選んだ年度のまま');
assert.match(head(h), /id="fc_mk" aria-label="メーカー" disabled><option>メーカーなし<\/option>/, '選べるメーカーが無い年度も同じ欄を無効にして残す');
run(`fcSetFy('${FY}')`); flush();
assert.equal(run('S.fc.planId'), P[firstKey][FY], 'メーカーが決まっていなければ、その年度の最初のメーカー');
// 保存していない入力があれば、先に確かめる（「やめる」なら今の年度・メーカーのまま）
run(`viewForecastAll(); fcInputType(0, 'reason', '打ちかけ', 'client')`);
run(`fcSetFy('${FY - 1}')`);
assert.match(el('askwrap').innerHTML, /保存していない入力があります。保存せずに、ほかのメーカーを開きますか？/);
run('askDone(false)'); flush();
assert.equal(run('S.fc.planId'), P[firstKey][FY], 'やめれば今のまま');
assert.equal(run('S.fc.draft.client[0].reason'), '打ちかけ', '打ちかけも残る');

// ==== 4. 入力: 未保存の印と保存は種類ごと ====
assert.equal(run('S.fc.inputDirty.client'), true);
assert.equal(run('!!S.fc.inputDirty.product'), false, 'ほかの種類には印を付けない');
assert.ok(selectors.includes(`[onclick="fcSaveInput('client',0)"]`), '打ったときは、その行の保存のボタンだけを押せるようにする（描き直さない）');
h = fcSection(page(), 'input');
assert.match(card(h, 'client'), /<h2>メーカーの動向<\/h2><span class="chip warn">未保存<\/span>/, 'メーカーの動向のカードに未保存の印');
assert.match(card(h, 'client'), /<td><button class="btn btn-sm" onclick="fcSaveInput\('client',0\)">保存<\/button><\/td>/, '打った行の横の保存は押せる');
assert.match(card(h, 'client'), /<button class="btn btn-sm" disabled onclick="fcSaveInput\('client',1\)">保存/, 'ほかの行の保存は押せないまま');
for (const k of ['product', 'opinions', 'devspot']) {
  assert.doesNotMatch(card(h, k), /<button class="btn btn-sm" onclick=/, k + ' の保存は押せないまま');
  assert.doesNotMatch(card(h, k), /未保存/, k + ' に未保存の印は出さない');
}
run(`fcSaveInput('client')`); flush();
const s = started[started.length - 1];
assert.deepEqual([s.payload.action, s.payload.args.kind, s.payload.planId], ['INPUT.SAVE', 'client', P[firstKey][FY]], '保存は種類ごと');
assert.equal(s.payload.args.rows[0].reason, '打ちかけ');
run('fcDropDrafts(); S.job = null');   // 保存の終わりは待たない（ここでは画面の送る中身だけを見る）

// ==== 5. 区切りを指して開く: その区切りへ画面の中で送る。「開く」は先頭から ====
{
  const sec = el('fcs-version');
  sec.scrollIntoView = (o) => scrolled.push(['version', o && o.block]);
  run(`go('home'); openPlan('${P[firstKey][FY]}', 'version')`);
  assert.deepEqual(scrolled[scrolled.length - 1], ['version', 'start'], '公式版の区切りへ送る');
  assert.equal(run('S.fc.jump'), '', '送ったら控えを消す');
  assert.equal(run('S.view'), 'budget', '公式版は予算策定の画面');
  run(`go('makers'); openPlan('${P[secondKey][FY]}')`);
  assert.equal(scrolled[scrolled.length - 1], 'top', 'メーカー一覧の「開く」は画面の先頭から');
  assert.equal(run('S.fc.jump'), '');
  flush();
  // 描けていない（読み込み中）ときは、描けたときに送る
  const send = sec.scrollIntoView;
  delete sec.scrollIntoView;   // まだ区切りが無い（読み込み中）の形
  run(`go('home'); openPlan('${P[firstKey][FY]}', 'version')`);
  assert.equal(run('S.fc.jump'), 'version', '中身を読む前は控えておく');
  flush(); sec.scrollIntoView = send; page();
  timers.splice(0).forEach((f) => f());
  assert.equal(run('S.fc.jump'), '', '描けたら送る');
  assert.deepEqual(scrolled[scrolled.length - 1], ['version', 'start']);
}

// ==== 6. 1 つの区切りの表示で失敗しても、ほかの区切りは出す ====
{
  h = run(`var __st = fcTriTab; fcTriTab = function(){ throw new Error('テストの失敗'); }; var __h = viewForecastAll(); fcTriTab = __st; __h`);
  assert.match(fcSection(h, 'tri'), /ここを表示できませんでした[\s\S]*テストの失敗/);
  for (const k of ['forecast', 'basis', 'input', 'version']) assert.doesNotMatch(fcSection(h, k), /ここを表示できませんでした/, k + ' は出す');
}

// ==== 7. CSS ====
{
  const css = uiHtml.slice(uiHtml.indexOf('<style>'), uiHtml.indexOf('</style>'));
  assert.ok(css.includes('.fc-sels{display:flex;align-items:center;gap:var(--s3)}'), '題の横の 2 つの欄は、格子の間 12px で並べる');
  assert.ok(css.includes('.viewtitle .vnear .inp{width:var(--selw, var(--col))}'), '欄は 1 マスから、いちばん長い名前が見切れない幅まで（共通の決まり）');
  assert.ok(css.includes('.viewtitle .vnear .fc-sels{flex:1 1 100%;flex-direction:column;align-items:stretch}.viewtitle .vnear .fc-sels .inp{width:100%}'), 'スマホは次の行に 1 つずつ幅いっぱい（2026-10-13 メーカーの名前が切れていた）');
  assert.match(css, /\.fcsec \.card:not\(\.caution\):not\(\.alert\):not\(\.soft\)\{background:none;border:0;border-top:1px solid var\(--line-soft\)/, '中のカードは区切りの中の段（枠を付けない）');
  assert.ok(!/\.fc-link|\.fc-open|fc-pick/.test(css), '使わなくなった決まりを残さない');
}

console.log('app-ui-forecast-column: ok');
