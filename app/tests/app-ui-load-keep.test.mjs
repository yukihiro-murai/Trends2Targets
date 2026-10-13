#!/usr/bin/env node
/*
 * app-ui-load-keep.test.mjs — 読んだ中身の控え（LD_KEEP 10 分・古いの印 crossStale）。2026-10-13 提案 27。
 * 画面（UI.html の script）を vm で読み、google.script.run をモックのサーバー（gas-mock）につなぐ（応答は順に流す。呼ばれた入口を数える）。
 *   1. 予測は 1 カラム（2026-10-13）: 開いたら予測・画面の中身・根拠・振り返り・公式版を 1 回の通信（apiForecastPage）で読む。ホーム・メーカー・予測を行き来しても読み直さない
 *   2. 「もう一度読み込む」などの読む関数を直接呼べば、今までどおり読む。読み込み中に開き直しても重ねて読まない
 *   3. 10 分たったら読み直す
 *   4. 保存（裏の処理）の後は古いとみなし、次に開いたときに読み直す（開いている計画はその場で根拠なども読み直す）。読み込み中に古くなったものも
 *   5. 公式版を出した後も同じ。別の計画に移ったら、その計画のものを読む
 *   6. 初期データにホームがあるときは、ほかの画面から戻ってもすぐには読み直さない
 *   7. 先読み（2026-10-13）: ホームを開いたら一覧・最初のメーカー・分析・人の学びを裏で読む。予測を開いたら同じ年度のほかのメーカーを読む。
 *      先読みした画面・メーカーを開いても読み直さない。先読みは今の画面を描き直さない
 * 名前と数字はテスト用の架空のもの。本物の Apps Script・ブラウザの上での確認の代わりではない。
 *
 *   node app/tests/app-ui-load-keep.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fcSection, setUpEnv, uiHtml, OWNER } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const env = setUpEnv();
const FY = env.run('appFy_(new Date())');
const ym = (m) => (m >= 4 ? FY : FY + 1) + '-' + String(m).padStart(2, '0');

// ---- 準備: ZAC の実績と、本物の A-1・A-2 で作った 2 つの計画 ----
const ext = Array.from({ length: 70 }, () => '');
const rec = (client, product, month, amount) => { const r = ext.slice(); r[40] = client; r[45] = 'ベース'; r[49] = product; r[56] = month; r[65] = amount; return r; };
const zacRows = [ext.map((_, i) => 'c' + (i + 1))];
for (let m = 1; m <= 12; m++) zacRows.push(rec('甲製薬', '製品A', D(FY - 1, m, 15), 1000000), rec('乙薬品', '製品Q', D(FY - 1, m, 15), 300000));
const zac = env.makeBook('売上の元', { ['*' + (FY - 1) + '_actual_value']: { cols: 70, values: zacRows } });
env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
const makePlan = (client, people) => {
  const st = env.runJob('PLAN.CREATE', { clientName: client, fy: FY, peopleCsv: people });
  assert.equal(st.status, 'DONE', st.error);
  const imp = env.runJob('PLAN.RUN', { planId: st.result.planId, action: 'IMPORT.SALES' });
  assert.equal(imp.status, 'DONE', imp.error);
  return st.result.planId;
};
const X = makePlan('甲製薬', '鷹野');
const Y = makePlan('乙薬品', '鷹野');
const view = (planId) => env.call('apiPlanView(__in)', { __in: { planId } });
{
  const st = env.runJob('PLAN.EDIT', { planId: X, action: 'INPUT.SAVE', args: { kind: 'product', rows: [{ person: '鷹野', product: '製品A', ym: ym(4), step: '+5%', reason: '甲の理由' }] }, inputHash: view(X).inputHash });
  assert.equal(st.status, 'DONE', st.error);
}
// 公式版を出せるように、計画の数字（予測の年度合計と予算）をモックで返す（予測の計算はこのテストでは動かさない）
env.run(`appPlanNumbers_ = function(){ return { annual: { p10: 900, p50: 1000, p90: 1100 }, budget: { adopted: 1000, uplift: 0, final: 1000 }, monthly: [] }; }`);

// ---- 画面: google.script.run をモックのサーバーにつなぐ（呼ばれた順に控え、flush() で応答を流す） ----
const makeUi = (boot) => {
  const queue = [], calls = [], timers = [];
  const makeRunner = () => { const t = { ok: null, fail: null }; const p = new Proxy(t, { get: (o, k) => {
    if (k === 'withSuccessHandler') return (fn) => { o.ok = fn; return p; };
    if (k === 'withFailureHandler') return (fn) => { o.fail = fn; return p; };
    return (...args) => { calls.push(String(k)); queue.push({ fn: String(k), args, ok: o.ok, fail: o.fail }); };
  } }); return p; };
  const flush = () => {
    for (let i = 0; queue.length && i < 200; i++) {
      const q = queue.shift();
      let res;
      try { env.as(OWNER); res = env.call(q.fn + '.apply(null, __args)', { __args: JSON.parse(JSON.stringify(q.args)) }); } catch (e) { if (q.fail) q.fail({ message: e.message }); continue; }
      if (q.ok) q.ok(res);
    }
    assert.equal(queue.length, 0, '応答を流し切る');
  };
  const finishJobs = () => {
    for (let i = 0; i < 30; i++) env.fireTriggers('triggerRunJob');
    for (let i = 0; i < 10; i++) { const due = timers.splice(0); due.forEach((f) => f()); flush(); if (!timers.length) break; }
  };
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '', className: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify(Object.assign({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }, boot || {})));
  const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout() {}, confirm: () => false,
    window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
    google: { script: { get run() { return makeRunner(); } } } });
  vm.runInContext(js, ui);
  const run = (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };
  /** code を動かし、その間に呼ばれた入口（応答を流した後の分も含む）を返す */
  const callsOf = (code) => { const n = calls.length; run(code); flush(); timers.length = 0; return calls.slice(n).filter((f) => f !== 'apiJobStatus'); };
  return { run, flush, finishJobs, callsOf, calls, timers, el };
};

const u = makeUi();
u.flush();   // 起動のときのホームの読み込み（初期データにホームが無い）
u.timers.length = 0;
u.run('FC_PRE_MAX = 0; S.homePre = true');   // 1〜6 は先読みを止めて確かめる（先読みは 7）
const { run, callsOf } = u;

// ==== 1. 予測は 1 カラム: 開いたら根拠・振り返り・公式版も並べて読む。同じ計画・画面を行き来しても読み直さない ====
assert.deepEqual(callsOf(`go('makers')`), ['apiPortfolio'], 'メーカーは最初の 1 回だけ読む');
assert.deepEqual(callsOf(`go('home')`).filter((f) => f === 'apiHome'), [], 'ホームに戻っても読み直さない（読んでから 10 分以内）');
assert.deepEqual(callsOf(`go('makers')`), [], 'メーカーに戻っても読み直さない');
const ALL = ['apiForecastPage'];
const first = callsOf(`openPlan('${X}', 'basis')`);
assert.deepEqual(first.slice().sort(), ['apiForecastPage', 'apiListPlans'], '予測を開く: 一覧と、計画の中身・根拠・振り返り・公式版（1 回の通信）を読む');
assert.equal(run('S.fc.basis.planId'), X);
assert.equal(run('S.fc.learn.planId'), X);
assert.equal(run('S.fc.ver.planId'), X);
assert.equal(run('S.fc.jump'), 'basis', '根拠の区切りへ送る（描けたら送る）');
{
  const page = run('viewForecast()');
  assert.doesNotMatch(page, /観測中…/, '読めた中身をすぐ出す（「観測中…」を出さない）');
  assert.doesNotMatch(page, /role="tablist"[^>]*>\s*<button class="tab/, '画面の中のタブは無い');
  const ids = [...page.matchAll(/<section class="card fcsec" id="fcs-(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['forecast', 'basis', 'input', 'review', 'version', 'steps'], '区切りは今までのタブの順に上から');
}
assert.deepEqual(callsOf(`go('home'); go('makers'); go('forecast')`).filter((f) => f !== 'apiAiLearning'), [], 'ホーム・メーカー・予測（計画の一覧・根拠・振り返り・公式版）を行き来しても読み直さない');
assert.deepEqual(callsOf(`openPlan('${X}', 'review')`), [], '同じ計画を開き直しても読み直さない');
assert.deepEqual(callsOf(`openPlan('${X}')`), [], '「開く」（区切りの指定なし）でも読み直さない');
assert.equal(run('S.fc.jump'), '', '区切りの指定が無ければ画面の先頭から（送らない）');

// ==== 2. 読む関数を直接呼べば今までどおり読む。読み込み中は重ねない ====
assert.deepEqual(callsOf('fcLoadBasis()'), ['apiForecastPage'], '「もう一度読み込む」（fcLoadBasis）は読む');
assert.deepEqual(callsOf('homeLoad()').filter((f) => f === 'apiHome'), ['apiHome'], '「もう一度読み込む」（homeLoad）は読む');
assert.deepEqual(callsOf('mkLoad()'), ['apiPortfolio'], '「もう一度読み込む」（mkLoad）は読む');
assert.deepEqual(callsOf('fcLoadPlans()'), ['apiListPlans']);
{
  const n = u.calls.length;
  run(`S.ld.fcLearn.at = 0; fcEnter(); fcEnter(); go('forecast')`);   // 読み込み中に開き直す
  assert.deepEqual(u.calls.slice(n), ['apiForecastPage'], '読み込み中に開き直しても重ねて読まない');
  u.flush();
  assert.equal(run('S.fc.learn.planId'), X);
}
// 失敗した後は、その区切りの場所に理由ともう一度読む。開き直すと読む（「もう一度読み込む」と同じ）
run(`S.ld.fcVer = { error: 'つながりません', at: Date.now() }`);
{
  const page = run(`S.fc.ver = null; viewForecast()`);
  assert.match(fcSection(page, 'version'), /読み込めませんでした[\s\S]*fcLoadVersions\(\)[\s\S]*もう一度読み込む/, '公式版の場所だけに出す');
  assert.doesNotMatch(fcSection(page, 'basis'), /読み込めませんでした/, 'ほかの区切りはそのまま');
}
assert.deepEqual(callsOf(`go('forecast')`), ['apiForecastPage'], '失敗した後に開き直すと読む');

// ==== 3. 10 分たったら読み直す ====
run(`S.ld.fcBasis.at -= LD_KEEP + 1; S.ld.home.at -= LD_KEEP + 1; S.ld.mk.at -= LD_KEEP + 1; S.ld.fcPlans.at -= LD_KEEP + 1`);
assert.ok(callsOf(`go('home')`).includes('apiHome'), '10 分より古いホームは読み直す');
assert.deepEqual(callsOf(`go('makers')`), ['apiPortfolio'], '10 分より古いメーカーは読み直す');
assert.deepEqual(callsOf(`go('forecast')`).sort(), ['apiForecastPage', 'apiListPlans'], '10 分より古い計画の一覧と根拠は読み直す（振り返り・公式版は新しいまま）');

// ==== 4. 保存（裏の処理）の後は古いとみなす。開いている計画は根拠・振り返り・公式版も並べて読み直す ====
{
  // 製品の入力のカードで保存する（PLAN.EDIT）。終わると開いている計画を読み直す
  run(`viewForecast(); fcInput(0, 'reason', '甲の理由（直した）', 'product')`);
  const n0 = u.calls.length;
  run(`fcSaveInput('product')`); u.flush();   // 裏の処理の問い合わせ（setTimeout）は残す
  assert.deepEqual(u.calls.slice(n0), ['apiStartJob']);
  const n = u.calls.length;
  u.finishJobs();
  const after = u.calls.slice(n).filter((f) => f !== 'apiJobStatus');
  assert.deepEqual(after.slice().sort(), ALL, '終わったら開いている計画を読み直す（1 カラムに並ぶ根拠・振り返り・公式版も）');
  assert.equal(view(X).boot.input.product[0].reason, '甲の理由（直した）');
  for (const k of ['home', 'mk', 'fcPlans']) assert.equal(run(`S.ld.${k}.at`), 0, k + ' に古いの印');
  assert.deepEqual(callsOf(`go('forecast')`), ['apiListPlans'], '保存の後は計画の一覧を読み直す（中身は読み直したばかり）');
  assert.ok(callsOf(`go('home')`).includes('apiHome'), '保存の後はホームを読み直す');
  assert.deepEqual(callsOf(`go('makers')`), ['apiPortfolio'], '保存の後はメーカーを読み直す');
  assert.deepEqual(callsOf(`go('home'); go('makers'); go('forecast')`).filter((f) => f !== 'apiAiLearning'), [], 'その後はまた控える');
}
{
  // 処理が終わったら、開いている計画はその場で読み直す（予測を保存した形）
  const n = u.calls.length;
  run(`jobReload('${X}', { action: 'FORECAST.RUN' })`); u.flush();
  assert.deepEqual(u.calls.slice(n).sort(), ALL, '開いている計画は、根拠・振り返り・公式版もその場で読み直す');
}
{
  // 読み込み中に古くなった（保存が先に終わった）ものは、届いても古いとみなす
  run(`fcLoadBasis()`);
  run('crossStale()');
  u.flush();
  assert.equal(run('S.ld.fcBasis.at'), 0, '読み込み中に古くなったものは、届いても古い');
  assert.equal(run('S.fc.basis.planId'), X, '中身は出す');
  assert.deepEqual(callsOf(`fcEnter()`).sort(), ['apiForecastPage', 'apiListPlans'], '次に開いたときに読み直す（根拠・振り返り・公式版は 1 回の通信）');
}

// ==== 5. 公式版を出した後・別の計画に移ったとき ====
{
  // 公式版を出す（確かめる画面で「出す」）。出せたら公式版を読み直し、ほかは古いとみなす
  assert.equal(run('S.fc.ver.versions.length'), 0);
  run(`document.getElementById = (function(g){ return function(id){ var e = g(id); if (id === 'ver_submit_note') e.value = 'テスト'; return e; }; })(document.getElementById); verSubmit()`);
  const n = u.calls.length;
  run('askDone(true)'); u.flush();
  assert.deepEqual(u.calls.slice(n), ['apiVersionSubmit', 'apiForecastPage'], '出したら公式版を読み直す');
  assert.equal(run('S.fc.ver.versions.length'), 1, '出した版が一覧に出る');
  for (const k of ['home', 'mk', 'fcPlans', 'fcBasis', 'fcLearn']) assert.equal(run(`S.ld.${k}.at`), 0, '出したら ' + k + ' は古い');
  assert.deepEqual(callsOf(`fcEnter()`).sort(), ['apiForecastPage', 'apiListPlans'], '出した後は根拠・振り返り・計画の一覧を読み直す');
  assert.deepEqual(callsOf(`go('makers')`), ['apiPortfolio'], '出した後はメーカー（状態の列）を読み直す');
  run(`go('forecast')`); u.flush();
}
{
  assert.deepEqual(callsOf(`fcSwitch('${Y}')`).sort(), ALL, '別の計画に移ると、その計画の中身と根拠・振り返り・公式版を読む');
  assert.equal(run('S.fc.basis.planId'), Y);
  assert.equal(run('S.fc.learn.planId'), Y, '前の計画の控えを使わない');
  assert.deepEqual(callsOf(`fcEnter()`), [], 'その計画の中でも控える');
  assert.deepEqual(callsOf(`fcSwitch('${X}')`).sort(), ALL, '戻ったら、控えの古い分（保存の後に読んでいない予測と画面の中身）だけを読む');
  assert.deepEqual(callsOf(`fcSwitch('${Y}')`), [], 'もう一度移ると、10 分以内に読んだ控えをそのまま出す（読まない）');
  assert.equal(run('S.fc.view.plan.planId'), Y, '控えの中身はその計画のもの');
  assert.equal(run('S.fc.basis.planId'), Y);
  assert.deepEqual(callsOf(`fcSwitch('${X}')`), [], '戻っても読まない');
}

// ==== 6. 初期データにホームがあるとき ====
{
  const u2 = makeUi({ home: { fy: String(FY), plans: [] } });
  u2.flush(); u2.timers.length = 0;
  assert.equal(u2.calls.filter((f) => f === 'apiHome').length, 0, '初期データにホームがあれば、起動のときは読まない');
  assert.deepEqual(u2.callsOf(`go('makers')`), ['apiPortfolio']);
  assert.deepEqual(u2.callsOf(`go('home')`).filter((f) => f === 'apiHome'), [], 'ほかの画面から戻っても、すぐには読み直さない');
  u2.run('S.ld.home.at -= LD_KEEP + 1');
  assert.ok(u2.callsOf(`go('home')`).includes('apiHome'), '10 分たてば読み直す');
}

// ==== 7. 先読み ====
{
  const u3 = makeUi();
  u3.flush();
  const runTimers = () => { for (let i = 0; i < 20; i++) { const due = u3.timers.splice(0); if (!due.length) break; due.forEach((f) => f()); u3.flush(); } };
  u3.run('var __renders = 0; var __render0 = render; render = function(){ __renders++; return __render0(); }');
  const n = u3.calls.length;
  runTimers();
  const pre = u3.calls.slice(n);
  for (const f of ['apiListPlans', 'apiForecastPage', 'apiCrossMaker', 'apiPeopleLearning']) assert.ok(pre.includes(f), 'ホームを開くと先読みする: ' + f + '（' + pre.join(',') + '）');
  assert.equal(pre.filter((f) => f === 'apiForecastPage').length, 1, '予測は、開いたときに出る最初のメーカーだけ');
  assert.equal(u3.run('__renders'), 0, '先読みは今の画面（ホーム）を描き直さない');
  assert.deepEqual(u3.callsOf(`go('forecast')`), [], '先読みした予測は、開いても読まない');
  assert.ok(u3.run('!!(S.fc.view && S.fc.data && S.fc.basis && S.fc.learn && S.fc.ver)'), 'すぐに中身を出す');
  assert.doesNotMatch(u3.run('viewForecast()'), /class="skel"/, '読み込み中の帯は出ない');
  assert.deepEqual(u3.callsOf(`go('analysis')`), [], '先読みした分析は、開いても読まない');
  assert.deepEqual(u3.callsOf(`go('learning')`), [], '先読みした学び（人の学び・AI の学び）は、開いても読まない');
  // 予測を開いたら、同じ年度のほかのメーカーを先読みする。切り替えても読まない
  assert.equal(u3.run('S.fcPreQ.length'), 1, '予測を開くと、同じ年度のほかのメーカーを先読みの列に入れる');
  const m = u3.calls.length;
  u3.run('fcPreNext()');   // テストの道具は、callsOf のたびに待ちの時計を捨てるので、ここで動かす
  u3.flush(); runTimers();
  assert.deepEqual(u3.calls.slice(m).filter((f) => f !== 'apiJobStatus'), ['apiForecastPage'], '同じ年度のほかのメーカー（1 つ）を先読みする');
  const other = u3.run(`S.fc.planId === '${X}' ? '${Y}' : '${X}'`);
  assert.deepEqual(u3.callsOf(`fcSwitch('${other}')`), [], '先読みしたメーカーに切り替えても読まない');
  assert.equal(u3.run('S.fc.view.plan.planId'), other);
  // 保存などの後（古いの印）は、先読みの控えを捨てる
  u3.run('crossStale()');
  assert.equal(u3.run('Object.keys(S.fcMem).length'), 0, '控えを捨てる');
}

console.log('app-ui-load-keep: ok');
