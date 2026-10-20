#!/usr/bin/env node
/*
 * app-ui-call-resilience.test.mjs — 画面の通信の打ち切り・一時失敗のやり直し・先読みとの重ね読み・描画の例外。
 *   1. 時間内に応答が無ければ「観測中」のままにせず、失敗の印を付ける
 *   2. NetworkError は 1 回だけやり直して届く
 *   3. 書く処理はやり直さない
 *   4. 先読みの途中で同じ計画を開いても apiForecastPage を重ねない
 *   5. 先読みが失敗したら、開いている計画の読み込み中の印を失敗にする
 *   6. 描画が例外でも画面が空にならない
 *   7. 届く前に別の読み込みへ移った応答では描き直さない
 * モックの google.script.run。本物の Apps Script・ブラウザの上での確認の代わりではない。
 *
 *   node app/tests/app-ui-call-resilience.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { uiHtml, OWNER } from './gas-mock.mjs';

const makeUi = () => {
  const queue = [], calls = [], timers = [];
  const failNext = {};
  const makeRunner = () => {
    const t = { ok: null, fail: null };
    const p = new Proxy(t, { get: (o, k) => {
      if (k === 'withSuccessHandler') return (fn) => { o.ok = fn; return p; };
      if (k === 'withFailureHandler') return (fn) => { o.fail = fn; return p; };
      return (...args) => { calls.push(String(k)); queue.push({ fn: String(k), args, ok: o.ok, fail: o.fail }); };
    } });
    return p;
  };
  const flush = (resMap) => {
    const n = queue.length;
    for (let i = 0; i < n; i++) {
      const q = queue.shift();
      if (!q) break;
      if (failNext[q.fn] > 0) {
        failNext[q.fn]--;
        if (q.fail) q.fail({ message: 'NetworkError: Failed to fetch' });
        continue;
      }
      const res = resMap && Object.prototype.hasOwnProperty.call(resMap, q.fn) ? resMap[q.fn] : { ok: true, fy: 2026, plans: [] };
      if (typeof res === 'function') q.ok && q.ok(res(q));
      else if (q.ok) q.ok(res);
    }
  };
  const fireTimers = () => {
    const due = timers.splice(0);
    due.forEach((f) => { try { f(); } catch (e) { /* 時計の中の例外は各テストで見る */ } });
  };
  const els = {};
  const el = (id) => (els[id] = els[id] || {
    id, innerHTML: '', textContent: '', className: '', classList: { add() {}, remove() {} },
    querySelector() { return null; }, querySelectorAll() { return []; },
    set outerHTML(v) {}, getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; },
  });
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({
      app: { name: 'T', version: 'x' }, setUp: true, allowed: true,
      user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] },
      home: { fy: '2026', fyOptions: ['2026'], plans: [] },
    }));
  const ui = vm.createContext({
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    setTimeout: (f) => { timers.push(f); return timers.length; },
    clearTimeout() {},
    confirm: () => false,
    console: { error() {}, log() {} },
    window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
    google: { script: { get run() { return makeRunner(); } } },
  });
  vm.runInContext(js, ui);
  const run = (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };
  run('S.homePre = true; FC_PRE_MAX = 0');
  timers.length = 0;
  queue.length = 0;
  calls.length = 0;
  return { run, flush, fireTimers, calls, queue, timers, failNext, els, el };
};

// ==== 1. 時間内に応答が無ければ失敗の印（観測中のままにしない） ====
{
  const u = makeUi();
  const n = u.calls.length;
  u.run('CALL_TO = 1; CALL_RETRY_MS = 0; B.home = null; homeLoad()');
  assert.equal(u.run('!!(S.ld.home && S.ld.home.loading)'), true, '読み込み中');
  assert.ok(u.calls.slice(n).includes('apiHome'), 'apiHome を呼ぶ');
  u.fireTimers();   // 打ち切り → やり直し（CALL_RETRY_MS=0 ですぐ launch）
  u.fireTimers();   // やり直しの launch（打ち切りの時計を置く）
  u.fireTimers();   // やり直しの打ち切り → 失敗
  assert.equal(u.queue.length, 2, '打ち切り後も応答は待たない（キューに残る）');
  assert.equal(u.run('!!(S.ld.home && S.ld.home.error)'), true, '失敗の印');
  assert.match(u.run('S.ld.home.error'), /通信が途中/, '通信の切れとして出す');
  assert.equal(u.run('!!S.ld.home.loading'), false, '観測中のままにしない');
}

// ==== 2. NetworkError は 1 回やり直して届く ====
{
  const u = makeUi();
  u.failNext.apiHome = 1;
  u.run('CALL_RETRY_MS = 0; B.home = null; homeLoad()');
  u.flush({ apiHome: { fy: 2026, plans: [], fyOptions: ['2026'] } });
  assert.equal(u.run('!!(S.ld.home && S.ld.home.loading)'), true, '1 回目は失敗してやり直し待ち');
  u.fireTimers();
  u.flush({ apiHome: { fy: 2026, plans: [], fyOptions: ['2026'] } });
  assert.equal(u.run('!!(S.ld.home && S.ld.home.error)'), false, '届いたら失敗の印は無い');
  assert.equal(u.run('!!(B.home && B.home.fy === 2026)'), true, 'ホームの中身が入る');
  assert.equal(u.calls.filter((f) => f === 'apiHome').length, 2, '1 回失敗 + 1 回成功');
}

// ==== 3. 書く処理はやり直さない ====
{
  const u = makeUi();
  u.failNext.apiSetup = 1;
  const n = u.calls.length;
  u.run('CALL_RETRY_MS = 0; homeSetup()');
  u.flush();
  u.fireTimers();
  u.flush();
  assert.equal(u.calls.slice(n).filter((f) => f === 'apiSetup').length, 1, '書く処理は 1 回だけ');
}

// ==== 4. 先読みの途中で同じ計画を開いても重ねて読まない ====
{
  const u = makeUi();
  u.run("S.view='forecast'; S.fc.planId='p1'; S.fcPreBusy=true; S.fcPreId='p1'");
  const n = u.calls.length;
  u.run("fcFetch('p1', ['latest','view','basis','learn','ver'])");
  assert.deepEqual(u.calls.slice(n), [], '先読み中は apiForecastPage を重ねない');
  assert.equal(u.run('!!(S.ld.fcLatest && S.ld.fcLatest.loading)'), true, '読み込み中の印は付ける');
}

// ==== 5. 先読みが失敗したら、開いている計画の印を失敗にする ====
{
  const u = makeUi();
  u.run("S.view='forecast'; S.fc.planId='p1'; S.fcPreQ=['p1']; S.pending=0; S.writing=false; S.job=null; S.starting=false");
  u.run('CALL_RETRY_MS = 0');
  u.failNext.apiForecastPage = 2;
  u.run('fcPreNext()');
  u.run("fcFetch('p1', ['latest','view'])");
  assert.equal(u.calls.filter((f) => f === 'apiForecastPage').length, 1, '先読み中は重ねて読まない');
  assert.equal(u.run('!!(S.ld.fcLatest && S.ld.fcLatest.loading)'), true, '読み込み中の印');
  u.flush();
  u.fireTimers();
  u.flush();
  assert.equal(u.run('!!(S.ld.fcLatest && S.ld.fcLatest.error)'), true, '先読みの失敗を開いている計画へ付ける');
  assert.match(u.run('String(S.ld.fcLatest.error)'), /通信が途中/, '通信の切れとして出す');
}

// ==== 6. 描画が例外でも画面が空にならない ====
{
  const u = makeUi();
  u.run('var __v0 = viewHome; viewHome = function(){ throw new Error("描画の試験"); };');
  u.run("S.view='home'; render()");
  const html = u.el('main').innerHTML;
  assert.match(html, /この画面を表示できませんでした/, '例外を画面に出す');
  u.run('viewHome = __v0');
}

// ==== 7. 届く前に別の読み込みへ移った応答では描き直さない ====
{
  const u = makeUi();
  u.run('var __renders = 0; var __r0 = render; render = function(){ __renders++; return __r0(); }');
  u.run('B.home = null; homeLoad()');
  u.run('homeLoad()');   // 印を取り替える
  const before = u.run('__renders');
  u.flush({ apiHome: { fy: 2026, plans: [], fyOptions: ['2026'] } });
  const afterFirst = u.run('__renders');
  assert.equal(afterFirst, before + 1, '古い応答では描き直さず、新しい応答の 1 回だけ描く');
}

// ==== 8. オフラインならすぐ失敗（ハングしない） ====
{
  const u = makeUi();
  u.run('CALL_RETRY_MS = 0; navigator = { onLine: false }');
  u.run('B.home = null; homeLoad()');
  u.fireTimers();
  assert.equal(u.run('!!(S.ld.home && S.ld.home.error)'), true, 'オフラインは失敗の印');
  assert.equal(u.queue.length, 0, '通信を始めない');
}

// ==== 9. 通信の切れだけ、戻ったときに読み直す（権限エラーは読み直さない） ====
{
  const u = makeUi();
  u.run("S.view='home'; B.home=null; S.ld.home={ error:'通信が途中で切れました。少し待って、もう一度試してください（裏の処理は続いていることがあります）。', at: Date.now() }");
  const n = u.calls.length;
  u.run('ldRetryVisible()');
  assert.ok(u.calls.slice(n).includes('apiHome'), '通信の切れは読み直す');
}
{
  const u = makeUi();
  u.run("S.view='home'; S.ld.home={ error:'権限がありません', at: Date.now() }");
  const n = u.calls.length;
  u.run('ldRetryVisible()');
  assert.deepEqual(u.calls.slice(n), [], '権限の失敗は読み直さない');
}

console.log('app-ui-call-resilience: ok');
