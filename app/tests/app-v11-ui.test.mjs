#!/usr/bin/env node
/*
 * app-v11-ui.test.mjs — 表の版 11 の画面（予測の「予算」のカードと「公式版」のタブ。UI.html の script を vm で読む）。
 *   U1. 予算のカードの「確率で決める」（50・60・70・80%）: 予算策定担当だけ・測る専用の計画と締め済みの年度には出さない。
 *       着地見込みが無い・年度が終わったときは押せない欄（わけはカーソル）。
 *       選ぶと apiBudgetProposal({ planId, prob }) を尋ね、採用予測の欄に入れる（保存はまだ・未保存の印）。選べないと答えたら、そのわけを知らせる。
 *       保存で送る決め方: 確率で決めた → basis PROB・prob・alloc / その後に採用予測を手で直した → MANUAL /
 *       採用予測に触れていない → 今の下書きの決め方のまま（下書きが無ければ CENTER）。上乗せだけ直しても決め方は変わらない
 *   U2. 予算の下書きの 1 行（boot.budgetDraft）: 「予算の下書き: 80% で決めた額（10/09）」。サーバーが知らせると決めた（warn）とき
 *       「下書きを作った後に予測が N% 動きました」（くわしくはカーソル。締め済みの年度は出さない）。下書きが無ければ何も出さない
 *   U3. 公式版: 版ごとに出したときの届く見込み（最終予算の下の段。採用予測と前提はカーソル）。試し（SHADOW）は札。前の版は空。
 *       出したときに着地見込みが無かった版は「-」。承認待ちのカード（承認する人が判断する所）に、最終予算・採用予測の両方の見込み
 * サーバーの apiBudgetProposal・boot.budgetDraft・versions[].reach は同じ回の別の作業で足すので、ここでは決めた形の応答で確かめる
 * （保存は今のモックのサーバーまで通し、前のサーバーでも保存できることも確かめる）。
 * 名前と数字はテスト用の架空のもの。モックの上の確かめで、本物の Apps Script・ブラウザの上では動かしていない。
 *
 *   node app/tests/app-v11-ui.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setUpEnv, uiHtml, OWNER } from './gas-mock.mjs';

const env = setUpEnv();
const FY = Number(env.run('appFy_(new Date())'));
const css = uiHtml.slice(uiHtml.indexOf('<style>'), uiHtml.indexOf('</style>'));
const visible = (html) => html.replace(/<[^>]*>/g, ' ');
const tipsOf = (html) => [...html.matchAll(/data-tip="([^"]*)"/g)].map((m) => m[1]);
const CODES = /\b(PROB|CENTER|MANUAL|BASELINE|PAST_SHAPE|FORECAST_SHAPE|SHADOW|LIVE|drift|basis|alloc)\b/;

// ---- 計画: 旧来の形の計算用ブック（OUTPUT の 29〜40 行が月、H・I が採用予測と上乗せ） ----
function legacyBook(client) {
  const output = [['FY' + FY + ' 売上予測（' + client + '）']];
  for (let r = 2; r <= 23; r++) output.push([]);
  output.push([' 混合（主要）']);
  output.push([]);
  output.push(['年度合計（予測）', 900, 1000, 1100, '', '', '', '', '', '']);
  output.push([], []);
  const months = Array.from({ length: 12 }, (_, i) => { const m = 4 + i; return (m > 12 ? FY + 1 : FY) + '/' + String(m > 12 ? m - 12 : m).padStart(2, '0'); });
  months.forEach((m) => output.push([m, 70, 80, 90, '', '', '', '', '', '']));
  const formulas = { H26: '=SUM(H29:H40)', I26: '=SUM(I29:I40)', J26: '=SUM(J29:J40)' };
  for (let i = 0; i < 12; i++) formulas['J' + (29 + i)] = `=H${29 + i}+I${29 + i}`;
  return env.makeBook(client, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', FY], ['[必須] 担当者（カンマ区切り）', '鷹野,佐藤']] },
    OUTPUT: { values: output, formulas, formats: { A: '@' } },
  });
}
const X = env.seedPlan(legacyBook('テスト製薬'));
const Y = env.seedPlan(legacyBook('別の製薬'));
const view = (id) => env.call('apiPlanView(__in)', { __in: { planId: id } });
const yms = view(X).boot.output.sections[0].monthly.map((m) => m.month);
assert.equal(yms.length, 12, '前提: 月が 12 行');

// ---- 画面: google.script.run をモックのサーバーにつなぐ（apiBudgetProposal だけは決めた形の応答で答える） ----
const queue = [];
const started = [];
const timers = [];
const asked = [];   // apiBudgetProposal に渡したもの
let proposal = null;   // (input) => 応答
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
      if (q.fn === 'apiBudgetProposal') { asked.push(JSON.parse(JSON.stringify(q.args[0]))); res = proposal(q.args[0]); }
      else {
        env.as(OWNER);
        res = env.call(q.fn + '.apply(null, __args)', { __args: JSON.parse(JSON.stringify(q.args)) });
        if (q.fn === 'apiStartJob') started.push(JSON.parse(JSON.stringify(q.args[0])));
      }
    } catch (e) { if (q.fail) q.fail({ message: e.message }); continue; }
    if (q.ok) q.ok(res);
  }
  assert.equal(queue.length, 0, '応答を流し切る');
};
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
const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '', value: '', className: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
  .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
  .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout() {}, confirm: () => false,
  window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
  google: { script: { get run() { return makeRunner(); } } } });
vm.runInContext(js, ui);
const run = (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };
run('var __toasts = []; toast = function(m, err){ __toasts.push([m, !!err]); };');
flush();
timers.length = 0;

/** 予算のカード（予測と予算のタブ）の HTML */
const card = () => { const h = run(`fcBothTabs(S.fc.data, S.fc.view)`); assert.doesNotMatch(h, /undefined|NaN/); return h; };
const selectOf = (h) => /<span class="act" data-tip="([^"]*)"><select class="inp sm" id="fcProb"([^>]*)>([\s\S]*?)<\/select><\/span>/.exec(h);
const optionsOf = (sel) => [...sel[3].matchAll(/<option value="(\d*)"( selected)?>([^<]*)<\/option>/g)].map((m) => [m[1], !!m[2], m[3]]);
const chosen = (h) => optionsOf(selectOf(h)).find((o) => o[1])[0];
const draftLine = (h) => /<div class="fc-bud">([\s\S]*?)<\/div>/.exec(h);
/** 保存で送る中身（startJob を止めて控える） */
const savePayload = () => JSON.parse(run(`var __sent = null, __sj = startJob; startJob = function(k, p){ __sent = { kind: k, payload: p }; }; fcSaveBudget(); startJob = __sj; JSON.stringify(__sent)`));
const toasts = () => JSON.parse(run('var __t = __toasts; __toasts = []; JSON.stringify(__t)'));
/** 予算に届く見込み（予測の記録の shadow.reach。今のサーバーの形。これがあると確率で決められる） */
const REACH = { center: 1000000, sd: 100000, p10: 870000, p90: 1130000, k: 0, actualYtd: 0, tau: 0.15, w: 1, tauSet: false, wSet: false, done: false, actual: null,
  amounts: [{ pct: 50, amount: 1000000 }, { pct: 60, amount: 974700 }, { pct: 70, amount: 947600 }, { pct: 80, amount: 915800 }], draft: null, official: null };
const reachOn = (reach = REACH) => run('S.fc.data.shadow = { planId: S.fc.planId, aligned: null, reach: __r }', { __r: reach });
/** apiBudgetProposal の答えの形（月は 'yyyy/MM'。締まった月は closed） */
const shape = [0.06, 0.07, 0.08, 0.08, 0.09, 0.09, 0.09, 0.09, 0.08, 0.09, 0.09, 0.09];
const makeProposal = (annual, opts = {}) => (input) => ({ planId: input.planId, prob: input.prob, annual, alloc: 'PAST_SHAPE', ok: true, mode: 'SHADOW',
  basisText: '試しの計算です。' + input.prob + '% の見込みで届く年間の金額です（着地見込みと同じ計算）。月へは、過去 3 年の売上の月の形の平均で割り振りました。上乗せはそのままです。',
  months: yms.map((m, i) => ({ ym: opts.ymFmt ? opts.ymFmt(m) : m, adopted: Math.round(annual * shape[i]), closed: false })), ...opts.extra });

run(`openPlan('${X}', 'forecast')`); flush();
assert.equal(run('S.fc.view.plan.planId'), X);
reachOn();

// ==== U1-1. 確率で決める欄: 予算策定担当・表で見ているとき、保存のボタンの左に 1 つ（1 マス 160px の選ぶ欄） ====
{
  const h = card();
  const sel = selectOf(h);
  assert.ok(sel, '確率で決める欄');
  assert.doesNotMatch(sel[2], /disabled/);
  assert.match(sel[2], /aria-label="届く見込みで採用予測を決める"/);
  assert.match(sel[2], /onchange="fcBudProb\(this\.value\)"/);
  const opts = optionsOf(sel);
  assert.deepEqual(opts.map((o) => o[0]), ['', '50', '60', '70', '80'], '50・60・70・80% だけ（90% 以上は選ばない）');
  assert.deepEqual(opts.map((o) => o[2]), ['確率で決める', '50% で決める', '60% で決める', '70% で決める', '80% で決める']);
  assert.ok(opts.every((o) => o[2].length <= 8), '名前は 8 文字まで');
  assert.equal(chosen(h), '', '初めは何も選んでいない（初期値は中心）');
  assert.deepEqual(sel[1].split('\n'), ['届く見込みで採用予測を決めます（80% なら 10 回に 8 回は届く額）', '採用予測 = 約束、上乗せ = 挑戦（上乗せはそのまま）',
    '月への割り振りは過去の平均の形です（過去の売上が 2 年分そろわなければ予測の月の形）', '保存するまで、予算は変わりません']);
  assert.match(h, /<span class="fc-insave"><span class="act" data-tip="[^"]*"><select class="inp sm" id="fcProb"[\s\S]*?<\/select><\/span><\/span>[\s\S]*<button class="btn btn-sm" disabled onclick="fcSaveBudget\(\d+\)">保存<\/button>/, '保存のボタンの左。入力が無ければ保存は押せない');
  assert.ok(css.includes('.inp.sm{width:var(--w-inp-sm)}') && /--w-inp-sm:var\(--col\)/.test(css) && /--col:160px/.test(css), '選ぶ欄は 1 マス（160px）');
  assert.equal(draftLine(h), null, '下書きが無ければ下書きの 1 行を出さない');
  assert.doesNotMatch(visible(h), CODES);
  tipsOf(h).forEach((t) => assert.doesNotMatch(t, CODES, '説明にも中の印を出さない: ' + t));
  // 決められないとき（届く見込みが無い・年度が終わった・別の計画の見込み）: 欄を出さず、届く見込みの話を何も出さない。保存のボタンは今までどおり
  for (const [why, set] of [['着地見込みが無い', () => reachOn(null)], ['年度が終わった', () => reachOn(Object.assign({}, REACH, { done: true, k: 12, amounts: [] }))],
    ['別の計画の見込み', () => run('S.fc.data.shadow = { planId: "other", reach: __r }', { __r: REACH })]]) {
    set();
    const n = card();
    assert.equal(selectOf(n), null, why + ': 出さない');
    assert.doesNotMatch(n, /試し|届く見込み/, why);
    assert.match(n, /<button class="btn btn-sm" disabled onclick="fcSaveBudget\(\d+\)">保存<\/button>/, why);
  }
  run('delete S.fc.data.shadow');
  assert.doesNotMatch(selectOf(card())[2], /disabled/, 'shadow を返さない前のサーバーは出す（選べないわけはサーバーの答えで知らせる）');
  reachOn();
}

// ==== U1-2. 80% を選ぶ → 尋ねる → 採用予測の欄に入る（未保存）→ 保存で PROB・80・過去の平均の形を送る → 今のサーバーでも保存できる ====
{
  proposal = makeProposal(1200000);
  run(`fcBudProb('80')`);
  assert.ok(run('!!S.fc.budProb'), '尋ねている間');
  const wait = selectOf(card());
  assert.match(wait[2], / disabled/, '尋ねている間は選べない');
  assert.equal(optionsOf(wait).find((o) => o[1])[2], '計算しています');
  assert.match(card(), /<button class="btn btn-sm" disabled onclick="fcSaveBudget\(\d+\)">/, '尋ねている間は保存しない');
  flush();
  assert.deepEqual(asked, [{ planId: X, prob: 80 }], 'apiBudgetProposal({ planId, prob })');
  const want = yms.map((m, i) => Math.round(1200000 * shape[i]));
  assert.deepEqual(JSON.parse(run(`JSON.stringify(S.fc.view.boot.output.sections[0].monthly.map(function(m){ return S.fc.budget[m.row] && S.fc.budget[m.row].adopted; }))`)), want.map(String), '採用予測の欄に入る（月は ym で合わせる）');
  assert.ok(run('fcDirty()'), '未保存');
  assert.equal(run(`S.cv.fcBudgetM`), 'table');
  const h = card();
  assert.match(h, /<span class="chip warn">未保存<\/span>/);
  assert.ok(h.includes('value="' + want[0].toLocaleString('ja-JP') + '"'), '表に入れた額が見える');
  const sel = selectOf(h);
  assert.equal(chosen(h), '80', '選んだ確率');
  assert.match(sel[1], /\n選んだ額: 届く見込み 80%・年度 1,200,000 円（試し）\n試しの計算です。80% の見込みで届く年間の金額です/, '選んだ額（試しの見込みから出した額は試し）とサーバーの前提の言葉');
  assert.match(h, /<button class="btn btn-sm" onclick="fcSaveBudget\(\d+\)">/, '保存できる');
  const p = savePayload();
  assert.equal(p.kind, 'PLAN.EDIT');
  assert.equal(p.payload.action, 'BUDGET.SAVE');
  assert.equal(p.payload.planId, X);
  assert.deepEqual({ basis: p.payload.args.basis, prob: p.payload.args.prob, alloc: p.payload.args.alloc }, { basis: 'PROB', prob: 80, alloc: 'PAST_SHAPE' });
  assert.deepEqual(p.payload.args.rows.map((r) => [r.row, r.adopted, r.uplift]), want.map((a, i) => [29 + i, a, '']), '12 か月の採用予測（上乗せはそのまま）');
  // 今の（前の）サーバーまで通す: rows だけを使って保存できる
  run('fcSaveBudget()'); flush();
  const s = started[started.length - 1];
  assert.deepEqual([s.kind, s.payload.action, s.payload.args.basis, s.payload.args.prob, s.payload.args.alloc], ['PLAN.EDIT', 'BUDGET.SAVE', 'PROB', 80, 'PAST_SHAPE']);
  finishJobs();
  assert.deepEqual(view(X).boot.output.sections[0].monthly.map((m) => m.adopted), want, '保存できた');
  assert.equal(run('Object.keys(S.fc.budget).length'), 0, '保存の後は入力中の値を消す');
  assert.equal(run('S.fc.budBasis'), null, '決め方も消す');
  // 版 11 のサーバー（下書きを返す）につないだときは、保存した決め方の下書きが 1 行に出る（前のサーバーは下書きを返さない）
  const dd = JSON.parse(run('JSON.stringify(S.fc.view.boot.budgetDraft || null)'));
  if (dd) {
    assert.deepEqual([dd.basis, dd.prob, dd.alloc], ['PROB', 80, 'PAST_SHAPE'], 'サーバーの下書き');
    reachOn();
    assert.doesNotMatch(card(), /予算の下書き/, '予算の下書きの 1 行は出さない（2026-10-13）');
  }
  reachOn();
  assert.equal(chosen(card()), '', '選ぶ欄も戻る');
  // 割り振りを予測の月の形に替えた答え（過去の売上が足りない）は、その名前で
  proposal = makeProposal(1200000, { extra: { alloc: 'FORECAST_SHAPE', mode: 'LIVE' } });
  run(`fcBudProb('50')`); flush();
  const t = selectOf(card())[1];
  assert.match(t, /\n月への割り振りは予測の月の形です\n選んだ額: 届く見込み 50%・年度 1,200,000 円\n/, '本番の見込みから出した額には試しと書かない');
  assert.equal(savePayload().payload.args.alloc, 'FORECAST_SHAPE');
  run('fcDropDrafts()');
}

// ==== U1-3. 確率で決めた後: 上乗せだけ直す → PROB のまま / 採用予測を手で直す → MANUAL（選ぶ欄は「確率で決める」に戻る） ====
{
  proposal = makeProposal(1500000);
  run(`fcBudProb('60')`); flush();
  run(`fcBudget(29, 'uplift', '10,000')`);
  let a = savePayload().payload.args;
  assert.deepEqual([a.basis, a.prob, a.alloc], ['PROB', 60, 'PAST_SHAPE'], '上乗せ（挑戦）を直しても、採用予測の決め方は変わらない');
  assert.equal(a.rows[0].uplift, 10000);
  els.fcProb = Object.assign(el('fcProb'), { value: '60', parentNode: { tip: '', setAttribute(k, v) { this.tip = v; } } });
  run(`fcBudget(30, 'adopted', '99,999')`);
  assert.equal(els.fcProb.value, '', '描き直さずに、選ぶ欄を戻す');
  assert.doesNotMatch(els.fcProb.parentNode.tip, /選んだ額/, '説明も戻す');
  a = savePayload().payload.args;
  assert.deepEqual([a.basis, 'prob' in a, a.alloc], ['MANUAL', false, 'MANUAL'], '手で直したら MANUAL（prob は送らない）');
  assert.equal(a.rows.find((r) => r.row === 30).adopted, 99999);
  assert.equal(chosen(card()), '', '描き直しても「確率で決める」');
  // 手で直した採用予測があるときに確率を選ぶ: 置き換えてよいか先に確かめる（やめる → 尋ねない）
  const n = asked.length;
  run(`fcBudProb('70')`);
  assert.equal(queue.length, 0, '確かめる前に尋ねない');
  assert.match(run(`$('askwrap').innerHTML`), /入力中の採用予測を、届く見込み 70% の額に置き換えますか？（上乗せはそのまま）/);
  run('askDone(false)'); flush();
  assert.equal(asked.length, n);
  assert.equal(run('fcBudArgs().basis'), 'MANUAL');
  run(`fcBudProb('70')`); run('askDone(true)'); flush();
  assert.deepEqual(asked[asked.length - 1], { planId: X, prob: 70 });
  a = savePayload().payload.args;
  assert.deepEqual([a.basis, a.prob], ['PROB', 70], '選び直したら PROB');
  assert.equal(a.rows.find((r) => r.row === 29).uplift, 10000, '上乗せはそのまま');
  assert.equal(a.rows.find((r) => r.row === 30).adopted, Math.round(1500000 * shape[1]), '手で直した採用予測は置き換わる');
  // 「確率で決める」に戻しただけ・決めていない値・尋ねている途中は何もしない
  const q = asked.length;
  run(`fcBudProb('')`); run(`fcBudProb('90')`); run(`fcBudProb('55')`); flush();
  assert.equal(asked.length, q);
  run(`fcBudProb('50')`); run(`fcBudProb('60')`); flush();
  assert.equal(asked.length, q + 1, '尋ねている途中にもう一度選んでも尋ねない');
  run('fcDropDrafts()');
}

// ==== U1-4. 採用予測に触れていない保存: 今の下書きの決め方のまま。下書きが無ければ CENTER（予測の月の形） ====
{
  const argsWith = (draft) => {
    run(`fcDropDrafts(); S.fc.view.boot.budgetDraft = __d; fcBudget(31, 'uplift', '5000')`, { __d: draft });
    const a = savePayload().payload.args;
    return [a.basis, 'prob' in a ? a.prob : '-', a.alloc];
  };
  assert.deepEqual(argsWith(undefined), ['CENTER', '-', 'FORECAST_SHAPE'], '下書きが無い（前のサーバー）: 真ん中のまま');
  assert.deepEqual(argsWith(null), ['CENTER', '-', 'FORECAST_SHAPE']);
  assert.deepEqual(argsWith({ basis: 'PROB', prob: 70, alloc: 'PAST_SHAPE', savedAt: '2026-10-09T10:00:00+09:00' }), ['PROB', 70, 'PAST_SHAPE'], '確率で決めた下書きのまま');
  assert.deepEqual(argsWith({ basis: 'PROB', prob: 50, alloc: 'FORECAST_SHAPE' }), ['PROB', 50, 'FORECAST_SHAPE']);
  assert.deepEqual(argsWith({ basis: 'MANUAL', alloc: 'MANUAL' }), ['MANUAL', '-', 'MANUAL']);
  assert.deepEqual(argsWith({ basis: 'BASELINE', alloc: 'MANUAL' }), ['MANUAL', '-', 'MANUAL'], '移したときの下書き（前に入れた額）は手で直した額');
  assert.deepEqual(argsWith({ basis: 'CENTER', alloc: 'FORECAST_SHAPE' }), ['CENTER', '-', 'FORECAST_SHAPE']);
  assert.deepEqual(argsWith({ basis: 'PROB', prob: 95 }), ['CENTER', '-', 'FORECAST_SHAPE'], '決めていない確率は使わない');
  run(`fcDropDrafts(); delete S.fc.view.boot.budgetDraft`);
}

// ==== U1-5. 答えが来る前に別の計画を開いたら捨てる。選べないという答え・月が合わない答えは入れずに知らせる ====
{
  proposal = makeProposal(900000);
  run(`fcBudProb('50')`);
  run(`openPlan('${Y}', 'forecast')`);
  flush();
  reachOn();
  assert.equal(run('S.fc.planId'), Y);
  assert.equal(run('Object.keys(S.fc.budget).length'), 0, '前の計画の答えを入れない');
  assert.equal(run('S.fc.budProb'), null);
  assert.ok(!run('fcDirty()'));
  toasts();
  // サーバーが選べないと答えた（着地見込みがまだ無い）
  proposal = (input) => ({ planId: input.planId, prob: input.prob, annual: null, months: [], alloc: 'PAST_SHAPE', ok: false, mode: 'SHADOW',
    basisText: '着地見込みがまだ出ていないので、確率からは選べません（予測と実績の取り込みの後に使えます）。' });
  run(`fcBudProb('50')`); flush();
  assert.equal(run('Object.keys(S.fc.budget).length'), 0);
  assert.deepEqual(toasts(), [['着地見込みがまだ出ていないので、確率からは選べません（予測と実績の取り込みの後に使えます）。', true]]);
  // 月が合わない
  proposal = makeProposal(900000, { ymFmt: () => '1999/01' });
  run(`fcBudProb('50')`); flush();
  assert.equal(run('Object.keys(S.fc.budget).length'), 0);
  assert.deepEqual(toasts(), [['届く見込みの額を、月に割り振れませんでした', true]]);
  // 月の書き方の違い（2026/04・2026-04・2026-04-01）は合わせる
  for (const f of [(m) => m.replace('/', '-'), (m) => m.replace('/', '-') + '-01']) {
    proposal = makeProposal(900000, { ymFmt: f });
    run(`fcDropDrafts(); fcBudProb('50')`); flush();
    assert.equal(run('Object.keys(S.fc.budget).length'), 12);
  }
  // 失敗したら知らせて、また選べる
  proposal = () => { throw new Error('つながりません'); };
  run(`fcBudProb('60')`); flush();
  assert.equal(run('S.fc.budProb'), null);
  assert.deepEqual(toasts(), [['つながりません', true]]);
  assert.doesNotMatch(selectOf(card())[2], /disabled/);
  // 入口の無いサーバー（版 11 より前）: 尋ねている途中のまま止まらない
  const keep = ui.google;
  ui.google = { script: { get run() { const o = { withSuccessHandler: () => o, withFailureHandler: () => o }; return o; } } };
  run(`fcBudProb('70')`);
  ui.google = keep;
  assert.equal(run('S.fc.budProb'), null);
  assert.deepEqual(toasts(), [['今は確率からは選べません。画面を読み直してください', true]]);
  assert.doesNotMatch(selectOf(card())[2], /disabled/);
  run('fcDropDrafts()');
  run(`openPlan('${X}', 'forecast')`); flush();
  reachOn();
}

// ==== U1-6. 出さないとき: 見るだけの人・測る専用の計画・締め済みの年度・グラフで見ているとき（入力も無い） ====
{
  const with_ = (mod, code = '') => { const keep = JSON.stringify(run('S.fc.view')); run(`(function(v){ ${mod} })(S.fc.view); ${code}`); const h = card(); run(`S.fc.view = JSON.parse(__k)`, { __k: keep }); return h; };
  const draft = { basis: 'PROB', prob: 80, alloc: 'PAST_SHAPE', savedAt: '2026-10-09T10:00:00+09:00', centerAtDraft: 1000000, centerNow: 1200000, drift: 0.2, driftLimit: 0.1, warn: true };
  run('S.fc.view.boot.budgetDraft = __d', { __d: draft });
  const viewer = with_('v.can.plan = false;');
  assert.equal(selectOf(viewer), null, '見るだけの人には出さない');
  assert.doesNotMatch(viewer, /予算の下書き|動きました/, '下書きの 1 行は出さない（2026-10-13 村井さん「細かいテキストは不要」）');
  const measure = with_('v.plan.measure = true;');
  assert.equal(selectOf(measure), null, '測る専用の計画には出さない');
  assert.equal(draftLine(measure), null, '測る専用の計画には下書きの 1 行も出さない');
  const closed = with_('v.plan.frozen = true;');
  assert.equal(selectOf(closed), null, '締め済みの年度には出さない');
  assert.doesNotMatch(closed, /予算の下書き/);
  assert.doesNotMatch(closed, /動きました/, '締め済みの年度は、予測が動いた知らせを出さない');
  const closedD = with_('', `S.fc.data.plan.frozen = true;`);
  run('S.fc.data.plan.frozen = false');
  assert.equal(selectOf(closedD), null, '予測の記録の側の締めの印でも出さない');
  const chart = with_('', `S.cv.fcBudgetM = 'chart';`);
  run(`S.cv.fcMonthly = S.cv.fcBudgetM = 'table'`);
  assert.notEqual(selectOf(chart), null, '確率で決める・保存は見出しの右なので、グラフで見ていても出す（2026-10-16）');
  assert.doesNotMatch(chart, /予算の下書き/, 'グラフでも出さない');
  run('delete S.fc.view.boot.budgetDraft');
}

// ==== U2. 予算の下書きの 1 行は出さない（2026-10-13 村井さん「細かいテキストは不要」）====
{
  run('S.fc.view.boot.budgetDraft = __d', { __d: { basis: 'PROB', prob: 80, alloc: 'PAST_SHAPE', savedAt: '2026-10-09T10:00:00+09:00', centerAtDraft: 1000000, centerNow: 1200000, drift: 0.2, driftLimit: 0.1, warn: true } });
  assert.equal(draftLine(card()), null);
  assert.doesNotMatch(card(), /予算の下書き|動きました/);
  run('delete S.fc.view.boot.budgetDraft');
}

// ==== U3. 公式版: 出したときの届く見込み ====
{
  const at = (d) => '2026-10-0' + d + 'T10:00:00+09:00';
  const ver = (no, state, reach) => ({ versionId: 'V' + no, no, state, inputHash: 'h' + no, runId: 'FR-' + no,
    annual: { p10: 900000, p50: 1000000, p90: 1100000 }, budget: { adopted: 1000000, uplift: 200000, final: 1200000 }, monthly: [], note: 'メモ' + no,
    submittedAt: at(no), submittedBy: 'planner@bigm2y.com', decidedAt: state === 'SUBMITTED' ? '' : at(no + 1), decidedBy: state === 'SUBMITTED' ? '' : OWNER, decisionNote: '', rowVersion: 1, reach });
  const SH = { final: 0.68, adopted: 0.86, center: 1050000, sd: 120000, tau: 0.15, w: 1, closedMonths: 3, mode: 'SHADOW' };
  const LV = { final: 0.52, adopted: 0.71, center: 1210000, sd: 90000, tau: 0.123, w: 1.25, closedMonths: 0, mode: 'LIVE' };
  const NO = { final: null, adopted: null, center: null, sd: null, tau: null, w: null, closedMonths: null, mode: 'SHADOW' };   // 出したときに着地見込みが無かった版
  const versions = [ver(5, 'SUBMITTED', SH), ver(4, 'APPROVED', LV), ver(3, 'WITHDRAWN', NO), ver(2, 'SUPERSEDED', null), ver(1, 'REJECTED', undefined)];
  const r = { planId: X, frozen: false, measure: false, current: { annual: { p10: 900000, p50: 1000000, p90: 1100000 }, budget: { adopted: 1000000, uplift: 0, final: 1000000 }, monthly: [] },
    inputHash: 'h', versions, official: versions[1], pending: versions[0], pendingChanged: false, can: { submit: true, approve: true }, me: 'planner@bigm2y.com' };
  const tab = (x) => { run('S.fc.ver = __r; S.fc.verCmp = null', { __r: x }); const h = run(`fcVersionTab(S.fc.data, S.fc.view)`); assert.doesNotMatch(h, /undefined|NaN/); return h; };
  const h = tab(r);
  // 版の一覧: 列は増やさない（1280px の枠に入る並びのまま）。届く見込みは最終予算の下の段。
  // 状態の列は札（.chip.st 112px）+ 左右の余白 24px = 136px（120px では札の右が切れていた。2026-10-13）
  assert.match(h, /<table class="tbl fc-vers"><colgroup><col style="width:56px"><col style="width:136px"><col style="width:128px"><col style="width:128px"><col style="width:112px"><col style="width:112px"><col><col style="width:152px"><\/colgroup>/);
  // 届く見込みは見える所に出さず、最終予算のセルのカーソルの説明に（2026-10-13 村井さん「細かいテキストは不要」）
  const rows = [...h.matchAll(/<tr><td>v(\d+)<\/td><td>[\s\S]*?<\/td><td class="num"(?: data-tip="([^"]*)")?>([\s\S]*?)<\/td>/g)].map((x) => [x[1], { tip: x[2] || '', v: x[3] }]);
  assert.deepEqual(rows.map((x) => x[0]), ['5', '4', '3', '2', '1']);
  const cell = Object.fromEntries(rows);
  ['5', '4', '3', '2', '1'].forEach((k) => assert.equal(cell[k].v, '1,200,000', '金額だけ（下の段の注記は出さない）'));
  assert.deepEqual(cell[5].tip.split('\n').slice(0, 3), ['出したときの届く見込み（試し）', '最終予算 1,200,000 円 に 約 70%', '採用予測 1,000,000 円 に 約 85%']);
  assert.deepEqual(cell[4].tip.split('\n').slice(0, 2), ['出したときの届く見込み', '最終予算 1,200,000 円 に 約 50%'], '本番（LIVE）は試しと言わない');
  assert.equal(cell[3].tip, '出したときは着地見込みがまだ無かったので、届く見込みはありません');
  assert.equal(cell[2].tip, '', '前の版は説明なし');
  assert.doesNotMatch(visible(h), /届く見込み|試し|未満|超/, '見える所に届く見込みを出さない');
  // 承認待ちのカード: 届く見込みの行は出さない（承認する人は、版の一覧の最終予算のカーソルで見られる）
  const pend = /<div class="card caution"><div class="card-head"><h2>承認待ち（v5）<\/h2>[\s\S]*?<\/div><\/div>/.exec(h)[0];
  assert.doesNotMatch(pend, /届く見込み/);
  assert.match(pend, /承認する<\/button>/, '承認する人が見る所');
  const viewer = tab(Object.assign({}, r, { can: { submit: false, approve: false } }));
  assert.doesNotMatch(viewer, /承認する<\/button>/);
  // 見える言葉・説明に中の印を出さない
  assert.doesNotMatch(visible(h), CODES);
  tipsOf(h).forEach((t) => assert.doesNotMatch(t, /SHADOW|LIVE|closedMonths|tau\b/));
  // サーバーの一覧のまま: 前のサーバー（届く見込みを返さない）は今までどおり。版 11 のサーバーは出したときの見込み（この計画は着地見込みが無いので「-」）
  env.call('appTestVersionSubmit_(__in)', { __in: { planId: X, note: 'テスト' } });
  const rl = env.call('apiVersionList(__in)', { __in: { planId: X } });
  const real = tab(rl);
  assert.match(real, /承認待ち（v1）/);
  assert.doesNotMatch(visible(real), /届く見込み:/);
}

// ==== 画面確認の仮: 予算のカードに知らせを出す。保存は止めない。中の印は見せない ====
{
  run('S.fc.view.boot.budgetDraft = { basis: "SCREEN_CHECK", placeholder: true, alloc: "SCREEN_CHECK", prob: null, months: 12 }');
  const h = card();
  assert.match(h, /画面確認の仮の予算が残っています。/);
  assert.doesNotMatch(h, /止まります/);
  assert.doesNotMatch(visible(h) + tipsOf(h).join('\n'), /SCREEN_CHECK/);
  assert.equal(run('fcBudHow(S.fc.view.boot.budgetDraft).say'), '画面確認の仮');
  run('S.fc.budget = { 29: { adopted: "100", uplift: "" } }');
  toasts();
  const sent = savePayload();
  assert.equal(sent.kind, 'PLAN.EDIT');
  assert.equal(sent.payload.action, 'BUDGET.SAVE');
  assert.equal(sent.payload.args.rows[0].row, 29);
  assert.deepEqual(toasts(), []);
  run('S.fc.budget = {}; S.fc.view.boot.budgetDraft = { basis: "MANUAL", alloc: "MANUAL", prob: null, months: 12 }');
  assert.doesNotMatch(card(), /画面確認の仮の予算が残っています/);
  run('delete S.fc.view.boot.budgetDraft');
}

console.log('app-v11-ui: ok');
