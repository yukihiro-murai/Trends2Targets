#!/usr/bin/env node
/**
 * app-auto-research.test.mjs — 市場の動き（A-4 AI 調査）の週 1 回の自動収集（AutoResearch.js）。
 * トリガーの作成（1 日 1 回だけ確かめる・二重にしない・上限・止めるスイッチ・前の版の時刻から作り直す）、入口の本人確認、
 * 4 時から 7 時より前だけ・毎日の手入れの後に始める、いちばん古い計画を選ぶ・ほかの処理が動いていれば何もしない・
 * 準備ができていない・権限が足りない計画は 3 日あけて次へ・締めた年度には書かない、状態を約 8000 バイトより小さく保つ。
 * Vertex AI の答えはテストの決まった形（app-ai.test.mjs と同じ）。
 * 日付は今日から動かすが、年度をまたがないように基準の日（B）を選ぶ（3 月末に流しても落ちない）。
 *
 *   node app/tests/app-auto-research.test.mjs
 */
import assert from 'node:assert/strict';
import { OWNER, MEMBER, setUpEnv as setUpBase, jstDay, J, sources } from './gas-mock.mjs';

/**
 * このファイルは AI 調査のトリガーと手入れの待ちを見るので、所有者が開いても毎日のバックアップのトリガーは自動では作らない（BACKUP_AUTO_ENABLE）。
 * バックアップのトリガーが要るところは apiEnableBackup で作る。自動で作るほうは app-backup-auto.test.mjs
 */
const setUpEnv = (opts) => { const e = setUpBase(opts); e.props.BACKUP_AUTO_ENABLE = 'false'; return e; };

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const DAY = 864e5;
const p2 = (n) => String(n).padStart(2, '0');
/** 今日から offset 日の、日本時間の hh:mm（ミリ秒） */
const jst = (offset, hh, mm = 0) => new Date(`${jstDay(offset)}T${p2(hh)}:${p2(mm)}:00+09:00`).getTime();
/** 今日から offset 日の年度（4 月始まり） */
const fyOf = (offset) => { const [y, m] = jstDay(offset).split('-').map(Number); return m >= 4 ? y : y - 1; };
/** 基準の日: 今日から 25 日のうちに 4 月 1 日が来るなら 40 日前（B から B + 25 日が同じ年度に入る） */
const B = fyOf(0) === fyOf(25) ? 0 : -40;

function stubVertex(env, code = 200) {
  env.run(`(() => {
    ScriptApp.getOAuthToken = () => 'test-token';
    const gemini = (text) => JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/a', title: 'a' } }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
    globalThis.UrlFetchApp = { fetch: (u, o) => {
      if (${code} !== 200) return { getResponseCode: () => ${code}, getContentText: () => JSON.stringify({ error: { code: ${code}, status: 'PERMISSION_DENIED', message: 'denied' } }) };
      const body = JSON.parse(o.payload);
      const structured = !!(body.generationConfig && body.generationConfig.responseMimeType);
      return { getResponseCode: () => 200, getContentText: () => gemini(structured ? JSON.stringify({ rows: [] }) : '市場は横ばい。') };
    } };
    appAiDeadline_ = () => Date.now() + 60000;
  })()`);
}

/** A-4 を動かせる計画の見本（ai = 0 なら AI 調査を無効にした計画） */
function seed(env, client, fy, ai = 1) {
  return env.seedPlan(env.makeBook(client, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '鷹野'],
      ['VERTEX_PROJECT_ID', 'test-project'], ['VERTEX_LOCATION', 'asia-northeast1'], ['VERTEX_GEMINI_MODEL', 'gemini-test'], ['AI_RESEARCH_ENABLED（0/1）', ai]] },
    PROCESS_STATUS: { values: [['step_key', 'last_run_date', 'last_run_by', 'status', 'target_client', 'record_count', 'error_summary'],
      ['step1_status', D(2026, 9, 1), 'owner', 'success', client, 10, '']] },
    PRODUCT: { values: [['Person', 'ProductName', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']] },
    CLIENT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']] },
    OPINIONS: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Confidence(0..1)', 'Note']] },
    DEV_SPOT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Project', 'Amount(JPY)', 'Confidence(0..1)']] },
  }));
}

let actSeq = 0;
/** 過去に A-4 が終わった記録を足す（finished_at = ms） */
function researchedAt(env, planId, ms) {
  env.run(`appWithLock_(() => appInsertRows_('PLAN_ACTIONS', [{ action_id: __id, plan_id: __p, action: 'AI.RESEARCH', status: 'DONE',
    started_at: appAutoResearchIso_(new Date(__ms)), finished_at: appAutoResearchIso_(new Date(__ms)), actor_email: 'owner@bigm2y.com' }]))`,
  { __id: 'ACT-TEST-' + (++actSeq), __p: planId, __ms: ms });
}

const setNow = (env, ms) => env.run(`appAutoResearchNow_ = () => new Date(${ms})`);
const autoTriggers = (env) => env.triggers.filter((t) => t.handler === 'triggerAutoResearch');
const state = (env) => J(env.run('appAutoResearchState_()'));
const stateBytes = (env) => Buffer.byteLength(env.props.APP_AUTO_RESEARCH || '', 'utf8');
const status = (env) => J(env.run('appAutoResearchStatus_()'));
const jobs = (env) => J(env.run('appJobList_()'));
const ensure = (env) => J(env.run(`appEnsureAutoResearchTrigger_({ requestId: 'TEST', actor: '${OWNER}' })`));
/** 毎日の手入れが offset 日の hh:mm に始まり durationMs で終わった控え（前の版の形。今の形 state・finishedAt は app-ops-night.test.mjs で確かめる。どちらも読む） */
const maintained = (env, offset, hh = 3, mm = 10, durationMs = 60000) => {
  env.props.APP_HOUSEKEEPING = JSON.stringify({ at: `${jstDay(offset)}T${p2(hh)}:${p2(mm)}:00+0900`, ok: true, problems: [], durationMs });
};
/** 毎日のトリガー（triggerAutoResearch）を動かす（トリガーの中では操作者のメールが空） */
function tick(env) {
  const uid = autoTriggers(env)[0].uid;
  const prev = env.state.active;
  env.as('');
  try { return env.call(`triggerAutoResearch({ triggerUid: '${uid}' })`); } finally { env.as(prev); }
}
/** 続き（CHAIN）を直接動かす（自動で始めた A-4 が終わった後と同じ。頼んだ人は所有者） */
const chainNext = (env) => env.call(`appAutoResearchNext_(appJobContext_({ requestedBy: '${OWNER}' }), 'CHAIN')`);
/** 裏の処理を、until() が真になるか、待っている処理が無くなるまで動かす */
function drain(env, until) {
  for (let i = 0; i < 300; i++) {
    if (until && until()) return;
    if (!env.triggers.some((t) => t.handler === 'triggerRunJob')) return;
    env.fireTriggers('triggerRunJob');
  }
  throw new Error('裏の処理が終わらない');
}
/** テストの中で動かした A-4 の数（足した過去の記録は数えない） */
const researched = (env, planId) => env.table('PLAN_ACTIONS').filter((r) => r.plan_id === planId && r.action === 'AI.RESEARCH' && r.status === 'DONE' && !r.action_id.startsWith('ACT-TEST-')).length;
const autoRuns = (env) => env.runLog().filter((r) => r.kind === 'AUTO.RESEARCH').map((r) => Object.assign(JSON.parse(r.detail_json || '{}'), { status: r.status, error: r.error }));
/** APP_AUTO_RESEARCH（所有者の UserProperties）を書けなくする（n 回。Infinity でずっと） */
function failStateWrites(env) {
  const real = env.ctx.PropertiesService.getUserProperties;
  const ctl = { left: 0, restore: () => { env.ctx.PropertiesService.getUserProperties = real; } };
  env.ctx.PropertiesService.getUserProperties = () => {
    const p = real();
    const set = p.setProperty;
    p.setProperty = (k, v) => {
      if (k === 'APP_AUTO_RESEARCH' && ctl.left > 0) { ctl.left--; throw new Error('書けません（テスト）'); }
      return set(k, v);
    };
    return p;
  };
  return ctl;
}
/** 旧来の A-4 が失敗したときの文の形（決まった前置き → 問い合わせの失敗の行） */
const LEGACY_FAIL = 'AI調査エラー: Vertex調査エラー: Vertex AI への問い合わせに失敗しました。CONFIG の VERTEX_PROJECT_ID・VERTEX_LOCATION と、所有者の許可を確認してください。\n' +
  '問い合わせの失敗（2 件）:\nasia-northeast1-aiplatform.googleapis.com … gemini-test:generateContent → 403 PERMISSION_DENIED denied\n' +
  'asia-northeast1-aiplatform.googleapis.com … gemini-test:generateContent → 500 INTERNAL';

// ==== 1. トリガー: 所有者が開いたとき・毎日の手入れで、無ければ作る（1 日 1 回だけ確かめる・二重にしない・上限・止めるスイッチ） ====
{
  const env = setUpEnv();
  const audits = env.audit().length;
  env.run('doGet({})');
  assert.equal(autoTriggers(env).length, 1, '所有者が開くとトリガーを作る');
  assert.deepEqual([autoTriggers(env)[0].everyDays, autoTriggers(env)[0].atHour, autoTriggers(env)[0].nearMinute], [1, 4, 30], '毎日 4 時半ごろ（3 時台のバックアップと手入れの後）');
  assert.equal(env.audit().length, audits, '画面を開くだけでは監査の記録を増やさない');
  assert.deepEqual(env.runLog().filter((r) => r.kind === 'AUTO.RESEARCH.TRIGGER').map((r) => r.status), ['CREATED'], '作ったことは実行ログに残す');
  assert.equal(JSON.parse(env.props.APP_AUTO_RESEARCH_CHECKED).schedule, 2, '確かめた控えに時刻の版を残す');
  // 同じ日は確かめ直さない（開くたびに重くしない）
  env.triggers.splice(env.triggers.indexOf(autoTriggers(env)[0]), 1);
  env.run('doGet({})');
  assert.equal(autoTriggers(env).length, 0, '同じ日のうちは確かめ直さない');
  assert.equal(ensure(env).reason, 'CHECKED_TODAY');
  // 次の日（控えの日付が違う）: 所有者以外が開いても作らない。所有者が開けば作る
  env.props.APP_AUTO_RESEARCH_CHECKED = JSON.stringify({ date: jstDay(-1), installed: true, schedule: 2 });
  env.as(MEMBER);
  env.run('doGet({})');
  assert.equal(autoTriggers(env).length, 0, '所有者でなければ確かめない');
  env.as(OWNER);
  env.run('doGet({})');
  assert.equal(autoTriggers(env).length, 1);
  // 二重にできていたら 1 つにする（今の版の時刻なら、前からあるものを残す）
  const keep = autoTriggers(env)[0].uid;
  env.run(`ScriptApp.newTrigger('triggerAutoResearch').timeBased().everyDays(1).atHour(4).nearMinute(30).create()`);
  env.props.APP_AUTO_RESEARCH_CHECKED = JSON.stringify({ date: jstDay(-1), installed: true, schedule: 2 });
  const dup = ensure(env);
  assert.deepEqual([dup.installed, dup.created, dup.removed, autoTriggers(env).length, autoTriggers(env)[0].uid], [true, false, 1, 1, keep], '二重のトリガーは 1 つにする');
  // 止めるスイッチ: 作らない
  env.triggers.splice(env.triggers.indexOf(autoTriggers(env)[0]), 1);
  delete env.props.APP_AUTO_RESEARCH_CHECKED;
  env.props.AUTO_RESEARCH_ENABLED = 'false';
  assert.deepEqual([ensure(env).reason, autoTriggers(env).length], ['DISABLED', 0]);
  delete env.props.AUTO_RESEARCH_ENABLED;
  // トリガーの上限（20）: 裏の処理の分（3）を空けて、足りなければ作らない
  for (let i = 0; i < 17; i++) env.run(`ScriptApp.newTrigger('triggerDummy').timeBased().everyDays(1).atHour(5).create()`);
  delete env.props.APP_AUTO_RESEARCH_CHECKED;
  assert.deepEqual([ensure(env).reason, autoTriggers(env).length], ['TRIGGER_LIMIT', 0], '上限に余裕が無ければ作らない');
  assert.ok(env.runLog().some((r) => r.kind === 'AUTO.RESEARCH.TRIGGER' && r.status === 'SKIPPED'));
  env.triggers.splice(env.triggers.findIndex((t) => t.handler === 'triggerDummy'), 1);
  delete env.props.APP_AUTO_RESEARCH_CHECKED;
  assert.deepEqual([ensure(env).created, autoTriggers(env).length], [true, 1], '16 個なら作れる（20 - 3 の余裕）');
  for (let i = env.triggers.length - 1; i >= 0; i--) if (env.triggers[i].handler === 'triggerDummy') env.triggers.splice(i, 1);
  // 毎日の手入れ（triggerDailyBackup）でも作る
  env.triggers.splice(env.triggers.indexOf(autoTriggers(env)[0]), 1);
  delete env.props.APP_AUTO_RESEARCH_CHECKED;
  env.call('apiEnableBackup()');
  const uid = env.triggers.find((t) => t.handler === 'triggerDailyBackup').uid;
  env.as('');
  const daily = env.call(`triggerDailyBackup({ triggerUid: '${uid}' })`);
  env.fireTriggers('triggerRunJob');   // 手入れは別の実行（数分後の裏の処理）
  env.as(OWNER);
  assert.equal(daily.autoResearch.created, true, '毎日の手入れでも作る');
  assert.equal(autoTriggers(env).length, 1);
  // 毎日の手入れの控えは、自動の回が「手入れが終わったか」を見る形（終わった印と終わった時刻）
  const hk = JSON.parse(env.props.APP_HOUSEKEEPING);
  const hkEnd = new Date(hk.finishedAt).getTime();
  assert.ok(hk.state === 'DONE' && isFinite(hkEnd), '手入れの控えに終わった印と終わった時刻がある');
  const pendingAt = (ms) => env.run(`appAutoResearchMaintenancePending_(new Date(${ms}))`);
  assert.equal(pendingAt(hkEnd + 60 * 1000), true, '手入れが終わってから 5 分は待つ');
  if (jstDay(0) === new Date(hkEnd + 6 * 60 * 1000 + 9 * 3600e3).toISOString().slice(0, 10)) assert.equal(pendingAt(hkEnd + 6 * 60 * 1000), false, '手入れが終わって 5 分たてば始められる');
  // 入口の本人確認（triggerDailyBackup と同じ）: このプロジェクトのトリガーの UID でなければ所有者として扱わない
  const auid = autoTriggers(env)[0].uid;
  env.as('');
  assert.throws(() => env.call(`triggerAutoResearch({ triggerUid: 'forged' })`), /権限がありません/);
  assert.throws(() => env.call('triggerAutoResearch()'), /権限がありません/);
  env.as(MEMBER);
  assert.throws(() => env.call(`triggerAutoResearch({ triggerUid: '${auid}' })`), /権限がありません/, 'UID を知っていても所有者にならない');
  env.as(OWNER);
  setNow(env, jst(B, 4, 35));
  maintained(env, B);
  const r = tick(env);
  assert.deepEqual([r.status, r.reason], ['SKIPPED', 'NO_STALE_PLAN'], '計画が無ければ何もしない');
  assert.equal(env.audit().filter((x) => x.action === 'AUTO.RESEARCH' && x.phase === 'DENIED').length, 3, '断ったことも記録に残る');
  const a = env.audit().filter((x) => x.action === 'AUTO.RESEARCH' && x.phase !== 'DENIED');
  assert.deepEqual(a.map((x) => [x.phase, x.actor_email]), [['START', OWNER], ['END', OWNER]], '所有者として記録つきで動く');
}

// ==== 2. 時刻の版: 前の版（1 時ごろ）のトリガーは、その日のうちでも 1 回だけ作り直す。同じ日に 2 つ同時に確かめても二重に作らない ====
{
  const env = setUpEnv();
  env.run(`ScriptApp.newTrigger('triggerAutoResearch').timeBased().everyDays(1).atHour(1).nearMinute(0).create()`);
  const oldUid = autoTriggers(env)[0].uid;
  env.props.APP_AUTO_RESEARCH_CHECKED = JSON.stringify({ date: jstDay(0), installed: true, reason: '' });   // 前の版が今日もう確かめた（版の印が無い）
  const r = ensure(env);
  assert.deepEqual([r.created, r.replaced], [true, 1], '前の版のトリガーを消して作り直す');
  assert.equal(autoTriggers(env).length, 1);
  const t = autoTriggers(env)[0];
  assert.notEqual(t.uid, oldUid);
  assert.deepEqual([t.everyDays, t.atHour, t.nearMinute], [1, 4, 30]);
  assert.deepEqual(J(JSON.parse(env.props.APP_AUTO_RESEARCH_CHECKED)), { date: jstDay(0), installed: true, reason: '', schedule: 2 });
  const created = env.runLog().filter((x) => x.kind === 'AUTO.RESEARCH.TRIGGER' && x.status === 'CREATED').map((x) => JSON.parse(x.detail_json));
  assert.deepEqual(created.map((x) => [x.hour, x.minute, x.schedule, x.replaced]), [[4, 30, 2, 1]], '作り直したことを実行ログに残す');
  // 同じ日にもう一度: 作り直さない
  assert.equal(ensure(env).reason, 'CHECKED_TODAY');
  env.run('doGet({})');
  assert.deepEqual(autoTriggers(env).map((x) => x.uid), [t.uid], '作り直すのは 1 回だけ');
  // 次の日: 今の版のトリガーが 1 つなら、そのまま（ロックも取らない）
  env.props.APP_AUTO_RESEARCH_CHECKED = JSON.stringify({ date: jstDay(-1), installed: true, reason: '', schedule: 2 });
  const locks = env.state.locks;
  const n = ensure(env);
  assert.deepEqual([n.checked, n.installed, n.created], [true, true, false]);
  assert.deepEqual(autoTriggers(env).map((x) => x.uid), [t.uid]);
  assert.equal(env.state.locks, locks, 'ふだんの日はロックを取らない（画面を開くのを待たせない）');
  // 前の版のまま確かめる途中で止まった日は、その日のうちはやり直さない（次の日に作り直す）
  env.props.APP_AUTO_RESEARCH_CHECKED = JSON.stringify({ date: jstDay(0), installed: true, reason: 'CHECKING' });
  assert.equal(ensure(env).reason, 'CHECKED_TODAY');

  // 同じ日に 2 つの実行が同時に確かめる: 後の実行がロックを待つ間に、先の実行が作った（ロックの中で控えを読み直して作らない）
  const two = setUpEnv();
  two.run(`(() => {
    const orig = appWithLock_;
    let first = true;
    appWithLock_ = (fn) => {
      if (first) { first = false; globalThis.__other = appEnsureAutoResearchTrigger_({ requestId: 'OTHER', actor: '${OWNER}' }); }
      return orig(fn);
    };
    globalThis.__restoreLock = () => { appWithLock_ = orig; };
  })()`);
  const late = ensure(two);
  const early = J(two.run('__other'));
  two.run('__restoreLock()');
  assert.equal(early.created, true, '先の実行が作る');
  assert.equal(late.reason, 'CHECKED_TODAY', '後の実行はロックの中で控えを読み直して作らない');
  assert.equal(autoTriggers(two).length, 1, 'トリガーは 1 つだけ');
  // 同じ日に 2 つ: 前の版のトリガーがある日も、作り直しは 1 回（後の実行は先の実行が作ったものを消さない）
  delete two.props.APP_AUTO_RESEARCH_CHECKED;
  two.triggers.splice(two.triggers.indexOf(autoTriggers(two)[0]), 1);
  two.run(`ScriptApp.newTrigger('triggerAutoResearch').timeBased().everyDays(1).atHour(1).nearMinute(0).create()`);
  two.props.APP_AUTO_RESEARCH_CHECKED = JSON.stringify({ date: jstDay(-1), installed: true, reason: '' });
  two.run(`(() => {
    const orig = appWithLock_;
    let first = true;
    appWithLock_ = (fn) => {
      if (first) { first = false; globalThis.__other = appEnsureAutoResearchTrigger_({ requestId: 'OTHER', actor: '${OWNER}' }); }
      return orig(fn);
    };
    globalThis.__restoreLock = () => { appWithLock_ = orig; };
  })()`);
  const late2 = ensure(two);
  const early2 = J(two.run('__other'));
  two.run('__restoreLock()');
  assert.deepEqual([early2.created, early2.replaced, late2.reason], [true, 1, 'CHECKED_TODAY']);
  assert.deepEqual(autoTriggers(two).map((x) => x.atHour), [4], '今の版のトリガーが 1 つだけ');
}

// ==== 3. 時間帯（4 時から 7 時より前だけ）と、毎日の手入れの後（バックアップのトリガーがあるときだけ待つ） ====
{
  const env = setUpEnv();
  env.run('doGet({})');
  setNow(env, jst(B, 3, 50));
  assert.deepEqual([tick(env).reason, chainNext(env).reason], ['BEFORE_HOURS', 'BEFORE_HOURS'], '4 時より前は始めない（続きも）');
  setNow(env, jst(B, 7, 0));
  assert.deepEqual([tick(env).reason, chainNext(env).reason], ['AFTER_HOURS', 'AFTER_HOURS'], '7 時からは始めない（続きも）');
  setNow(env, jst(B, 4, 0));
  assert.equal(tick(env).reason, 'NO_STALE_PLAN', '4 時ちょうどからは始められる（バックアップのトリガーが無ければ手入れを待たない）');
  setNow(env, jst(B, 6, 59));
  assert.equal(tick(env).reason, 'NO_STALE_PLAN');
  // 毎日のバックアップのトリガーがあれば、その日の手入れが終わってから
  env.call('apiEnableBackup()');
  delete env.props.APP_HOUSEKEEPING;
  setNow(env, jst(B, 4, 35));
  assert.equal(tick(env).reason, 'MAINTENANCE_PENDING', '手入れの控えが無い');
  maintained(env, B - 1);
  assert.equal(tick(env).reason, 'MAINTENANCE_PENDING', '前の日の手入れしか無い（今日の手入れがまだ）');
  maintained(env, B, 4, 31, 60000);
  assert.equal(tick(env).reason, 'MAINTENANCE_PENDING', '手入れが 4:32 に終わったばかり（5 分は待つ）');
  maintained(env, B);
  assert.equal(tick(env).reason, 'NO_STALE_PLAN', '今日の手入れが終わっていれば始められる');
  const last = autoRuns(env).filter((x) => x.reason === 'MAINTENANCE_PENDING');
  assert.equal(last.length, 3, '見送ったことも実行ログに残す');
  // バックアップのトリガーを外せば、手入れを待たない
  for (let i = env.triggers.length - 1; i >= 0; i--) if (env.triggers[i].handler === 'triggerDailyBackup') env.triggers.splice(i, 1);
  delete env.props.APP_HOUSEKEEPING;
  assert.equal(tick(env).reason, 'NO_STALE_PLAN');
}

// ==== 4. いちばん古い計画を選ぶ・ほかの処理が動いていれば何もしない・終わったら 7 時まで次へ ====
const env = setUpEnv();
stubVertex(env);
setNow(env, jst(B, 4, 35));
const fy = env.run('appFy_(appAutoResearchNow_())');
assert.equal(env.run(`appFy_(new Date(${jst(B + 25, 4, 35)}))`), fy, '基準の日から 25 日は同じ年度');
const pPast = seed(env, '己製薬', fy - 1);          // 前の年度（対象外）
const pNever = seed(env, '甲製薬', fy);             // 一度も無い
const pOff = seed(env, '乙製薬', fy, 0);            // AI 調査を無効にしてある（30 日前）
const p10 = seed(env, '丙製薬', fy);                // 10 日前
const pNext = seed(env, '丁製薬', fy + 1);          // 来年度・8 日前
const pTwo = seed(env, '戊製薬', fy);               // 2 日前（まだ新しい）
researchedAt(env, pOff, jst(B - 30, 12));
researchedAt(env, p10, jst(B - 10, 12));
researchedAt(env, pNext, jst(B - 8, 12));
researchedAt(env, pTwo, jst(B - 2, 12));
env.run('doGet({})');
assert.equal(autoTriggers(env).length, 1);
{
  const plans = J(env.run(`appAutoResearchPlans_(${fy})`)).map((p) => p.planId);
  assert.deepEqual(plans, [pNever, pOff, p10, pNext, pTwo], '進行中・今年度か来年度。古い順（一度も無いものが先）');
  const r = tick(env);
  assert.deepEqual([r.status, r.planId, r.via], ['STARTED', pNever, 'TICK'], r.reason);
  const q = jobs(env).filter((j) => j.status === 'QUEUED');
  assert.equal(q.length, 1);
  assert.deepEqual([q[0].kind, q[0].payload.planId, q[0].payload.action, q[0].requestedBy], ['PLAN.RUN', pNever, 'AI.RESEARCH', OWNER], '画面から始めるのと同じ処理を所有者として');
  assert.equal(state(env).chain.jobId, q[0].id, '自動で始めた印は状態の控えに置く');
  // ほかの処理が待っている間は何もしない
  const busy = tick(env);
  assert.deepEqual([busy.status, busy.reason], ['SKIPPED', 'BUSY']);
  assert.equal(jobs(env).filter((j) => j.status === 'QUEUED').length, 1, '二重に始めない');
  // 終わったら（4 時台）次に古い計画へ。準備ができていない計画（AI 調査が無効）は飛ばす
  drain(env, () => (state(env).chain || {}).planId === p10);
  assert.equal(researched(env, pNever), 1, '一度も無かった計画の A-4 が終わった');
  assert.equal(state(env).chain.planId, p10, '続けて次に古い計画（10 日前）を始める');
  assert.equal(state(env).tried[pOff].status, 'NOT_READY');
  assert.equal(state(env).tried[pOff].reason, 'AI_DISABLED');
  assert.equal(state(env).lastResult.status, 'DONE');
  assert.equal(state(env).lastResult.planId, pNever);
  const save = env.audit().filter((x) => x.action === 'PLAN.AI.RESEARCH.SAVE' && x.phase === 'END');
  assert.ok(save.length >= 1 && save.every((x) => x.actor_email === OWNER && x.result === 'OK'), '段ごとに監査の記録が残る');
  // 7 時を過ぎて終わったら、次は始めない
  setNow(env, jst(B, 7, 10));
  drain(env);
  assert.equal(researched(env, p10), 1);
  assert.equal(researched(env, pNext), 0, '7 時を過ぎたら続けない');
  assert.equal(state(env).chain, null);
  const last = autoRuns(env).slice(-1)[0];
  assert.deepEqual([last.status, last.reason, last.via], ['SKIPPED', 'AFTER_HOURS', 'CHAIN']);
  assert.ok(autoRuns(env).some((x) => x.status === 'DONE' && x.event === 'FINISHED' && x.planId === pNever), '結果を実行ログに残す');
  // 次の日の 4 時半: 残りの古い計画（来年度・9 日前）。準備ができていない計画は 3 日あける
  setNow(env, jst(B + 1, 4, 35));
  const r2 = tick(env);
  assert.deepEqual([r2.status, r2.planId], ['STARTED', pNext], r2.reason);
  assert.equal(r2.notReady, undefined, '準備ができていない計画は 3 日たつまで確かめ直さない');
  drain(env);
  assert.equal(researched(env, pNext), 1);
  const done = autoRuns(env).slice(-1)[0];
  assert.deepEqual([done.status, done.reason], ['SKIPPED', 'NO_STALE_PLAN'], 'もう古い計画は無い');
  assert.equal(researched(env, pTwo), 0, '7 日たっていない計画はそのまま');
  assert.equal(researched(env, pPast), 0, '前の年度の計画は集めない');
  assert.equal(researched(env, pOff), 0);
}

// ==== 5. 失敗も控える（要点だけ・次の計画へは進む・3 日あける）。状態を画面の名前つきでホームに出す ====
{
  stubVertex(env, 403);
  setNow(env, jst(B + 6, 4, 35));
  const r = tick(env);
  assert.deepEqual([r.status, r.planId], ['STARTED', pTwo], '2 日前だった計画が 8 日前になった');
  assert.deepEqual(r.notReady, [{ planId: pOff, reason: 'AI_DISABLED' }], '3 日たったので確かめ直す（まだ無効）');
  drain(env);
  const st = state(env);
  assert.equal(st.lastResult.status, 'FAILED');
  assert.match(st.lastResult.error, /^403 PERMISSION_DENIED/, '最後の結果には失敗の要点（旧来の決まった前置きではなく）');
  assert.deepEqual([st.tried[pTwo].status, st.tried[pTwo].reason], ['FAILED', '403 PERMISSION_DENIED denied'], '計画ごとの理由は要点だけ（40 字まで）');
  const fin = autoRuns(env).filter((x) => x.event === 'FINISHED' && x.status === 'FAILED').slice(-1)[0];
  assert.match(fin.error, /問い合わせの失敗/, '実行ログには失敗の文をそのまま残す');
  assert.equal(autoRuns(env).slice(-1)[0].reason, 'NO_STALE_PLAN', '失敗した計画は 3 日あける（すぐには繰り返さない）');
  const s = status(env);
  assert.equal(s.enabled, true);
  assert.equal(s.failures7d, 1);
  assert.deepEqual([s.lastStartedPlan.planId, s.lastStartedPlan.via, s.lastStartedPlan.viaLabel], [pTwo, 'TICK', '毎日の回'], '始めたきっかけにも画面の名前');
  assert.deepEqual([s.lastResult.status, s.lastResult.statusLabel], ['FAILED', '失敗した'], '画面の名前を添える');
  assert.deepEqual([s.lastTick.status, s.lastTick.reason, s.lastTick.reasonLabel, s.lastTick.viaLabel], ['SKIPPED', 'NO_STALE_PLAN', '集め直す計画が無い', '続き']);
  assert.ok(s.lastTickAt && s.trigger.installed && s.trigger.current);
  assert.deepEqual([s.schedule.hour, s.schedule.minute, s.schedule.endHour], [4, 30, 7]);
  assert.deepEqual(s.stalePlans.map((p) => p.planId), [pOff, pTwo], '古いままの計画（古い順）と、自動で最後に試した結果');
  assert.deepEqual([s.stalePlans[0].lastTry.status, s.stalePlans[0].lastTry.reason, s.stalePlans[0].lastTry.statusLabel, s.stalePlans[0].lastTry.reasonLabel],
    ['NOT_READY', 'AI_DISABLED', '準備ができていない', 'AI 調査が無効（AI_RESEARCH_ENABLED）']);
  assert.deepEqual([s.stalePlans[1].lastTry.statusLabel, s.stalePlans[1].lastTry.reasonLabel], ['失敗した', '403 PERMISSION_DENIED denied'], '失敗の文は名前の表に無いのでそのまま');
  assert.equal(env.call('apiHome()').system.autoResearch.failures7d, 1, '管理者のホームの仕組みの状態に出す');
  // 終わりの知らせなしに止まった自動の A-4 は、次の回に「止まった」として控える
  env.run(`appAutoResearchUpdate_(s => { s.chain = { jobId: 'JOB-GONE', planId: __p, requestedBy: '${OWNER}', startedAt: appAutoResearchIso_(appAutoResearchNow_()) }; })`, { __p: pOff });
  setNow(env, jst(B + 6, 5, 0));
  const r3 = tick(env);
  assert.equal(r3.stalled, pOff);
  assert.equal(state(env).chain, null);
  assert.equal(status(env).failures7d, 2);
  // 知らせだけが届かなかった（始めた後に A-4 の記録がある）ものは、終わったとして控える
  env.run(`appAutoResearchUpdate_(s => { s.chain = { jobId: 'JOB-QUIET', planId: __p, requestedBy: '${OWNER}', startedAt: appAutoResearchIso_(new Date(${jst(B - 1, 4, 35)})) }; })`, { __p: pNever });
  const r4 = tick(env);
  assert.equal(r4.stalled, undefined);
  assert.equal(state(env).tried[pNever].status, 'DONE');
  assert.equal(status(env).failures7d, 2, '失敗には数えない');
}

// ==== 6. 止めるスイッチ（毎日の回も、続きも）・1 晩の上限 ====
{
  stubVertex(env);
  setNow(env, jst(B + 20, 4, 35));
  const r = tick(env);
  assert.equal(r.status, 'STARTED', r.reason);
  env.props.AUTO_RESEARCH_ENABLED = 'false';
  drain(env);
  const last = autoRuns(env).slice(-1)[0];
  assert.deepEqual([last.status, last.reason, last.via], ['SKIPPED', 'DISABLED', 'CHAIN'], '止めたら続きも始めない');
  assert.equal(jobs(env).filter((j) => j.status === 'QUEUED').length, 0);
  const off = tick(env);
  assert.deepEqual([off.status, off.reason], ['SKIPPED', 'DISABLED']);
  assert.equal(jobs(env).filter((j) => j.status === 'QUEUED').length, 0);
  assert.equal(status(env).enabled, false);
  delete env.props.AUTO_RESEARCH_ENABLED;
  env.run(`appAutoResearchUpdate_(s => { s.night = { date: __d, count: 12 }; })`, { __d: jstDay(B + 20) });
  const lim = tick(env);
  assert.deepEqual([lim.status, lim.reason], ['SKIPPED', 'NIGHT_LIMIT'], '1 晩に始める数の上限');
  // 画面から始めた A-4 は、同じ人・同じ計画でも、自動で始めた処理（の続き）でなければ自動の続きにしない
  setNow(env, jst(B + 21, 4, 35));
  env.run(`appAutoResearchUpdate_(s => { s.night = null; s.chain = { jobId: 'JOB-OLD', planId: __p, requestedBy: '${OWNER}', startedAt: appAutoResearchIso_(appAutoResearchNow_()) }; })`, { __p: p10 });
  env.as(OWNER);
  const before = autoRuns(env).length;
  const manual = env.runJob('PLAN.RUN', { planId: p10, action: 'AI.RESEARCH' });
  assert.equal(manual.status, 'DONE', manual.error);
  assert.equal(autoRuns(env).length, before, '画面から始めた処理は自動の続きにしない');
  assert.equal(state(env).chain.jobId, 'JOB-OLD', '自動の印はそのまま（次の回に止まったとして控える）');
  assert.equal(env.state.lockHeld, false);
}

// ==== 7. 締めた年度の計画には書かない（選ばない・続きでも選ばない） ====
{
  const fz = setUpEnv();
  stubVertex(fz);
  setNow(fz, jst(B, 4, 35));
  const y = fz.run('appFy_(appAutoResearchNow_())');
  const pNextFy = seed(fz, '甲製薬', y + 1);   // 先に作る（ID の順では先に選ばれるはず）
  const pThisFy = seed(fz, '乙製薬', y);
  const close = (year) => fz.run(`appWithLock_(() => appInsertRows_('YEAR_CLOSURES', [{ fy: __fy, state: 'CLOSED', file_id: 'FILE-TEST', snapshot_sha256: __h,
    plan_count: 1, row_count: 1, bytes: 1, closed_at: appNowIso_(), closed_by: '${OWNER}' }]))`, { __fy: String(year), __h: 'a'.repeat(64) });
  close(y + 1);
  assert.deepEqual(J(fz.run(`appAutoResearchPlans_(${y})`)).map((p) => p.planId), [pThisFy], '締めた年度の計画は候補にしない');
  fz.run('doGet({})');
  const r = tick(fz);
  assert.deepEqual([r.status, r.planId], ['STARTED', pThisFy]);
  close(y);   // 始めた後で今年度も締まった
  drain(fz);
  assert.equal(researched(fz, pThisFy), 0, '裏の処理が年度の締めを確かめて止める');
  assert.equal(researched(fz, pNextFy), 0);
  const runs = autoRuns(fz);
  assert.deepEqual(runs.slice(-1).map((x) => [x.status, x.reason]), [['SKIPPED', 'NO_STALE_PLAN']], '続きでも締めた年度は選ばない');
  assert.ok(!J(fz.run('appJobList_()')).some((j) => j.payload && j.payload.planId === pNextFy), '締めた年度の計画の処理は一度も作らない');
  assert.equal(J(fz.run('appAutoResearchStatus_()')).stalePlans.length, 0);
}

// ==== 8. 準備ができていない計画が続いても、同じ回で次を探す。権限が足りない計画も 3 日あけて次へ ====
{
  const nr = setUpEnv();
  stubVertex(nr);
  setNow(nr, jst(B, 4, 35));
  const y = nr.run('appFy_(appAutoResearchNow_())');
  const off = ['子', '丑', '寅', '卯', '辰', '巳'].map((c) => seed(nr, c + '製薬', y, 0));   // AI 調査が無効（一度も無い＝いちばん古い）
  const ready = seed(nr, '午製薬', y);
  researchedAt(nr, ready, jst(B - 9, 12));   // 準備のできた計画は 9 日前（無効の計画の後に並ぶ）
  nr.run('doGet({})');
  const r = tick(nr);
  assert.deepEqual([r.status, r.planId], ['STARTED', ready], '準備ができていない計画が 6 つ続いても、その次を始める');
  assert.deepEqual(r.notReady.map((n) => n.planId).sort(), off.slice().sort());
  assert.ok(off.every((id) => state(nr).tried[id].status === 'NOT_READY'));
  drain(nr);
  assert.equal(researched(nr, ready), 1);
  // 権限が足りない計画（所有者には起きないので、役割の確かめを差し替える）
  const pDeny = seed(nr, '未製薬', y);
  const pOk = seed(nr, '申製薬', y);
  researchedAt(nr, pOk, jst(B - 8, 12));
  const denyClient = J(nr.run(`appAutoResearchPlans_(${y})`)).find((p) => p.planId === pDeny).clientId;
  nr.run('globalThis.__hasRole = appHasRole_; appHasRole_ = (roles, min, clientId) => clientId !== __deny && __hasRole(roles, min, clientId)', { __deny: denyClient });
  setNow(nr, jst(B + 1, 4, 35));
  const d1 = tick(nr);
  assert.deepEqual([d1.status, d1.planId, d1.denied], ['STARTED', pOk, [pDeny]], '権限が足りない計画は控えて次の計画を始める');
  assert.equal(state(nr).tried[pDeny].status, 'DENIED');
  drain(nr);
  setNow(nr, jst(B + 2, 4, 35));
  const d2 = tick(nr);
  assert.deepEqual([d2.reason, d2.denied], ['NO_STALE_PLAN', undefined], '3 日たつまで確かめ直さない（毎晩ふさがない）');
  setNow(nr, jst(B + 4, 4, 35));
  const d3 = tick(nr);
  assert.deepEqual(d3.denied, [pDeny], '3 日たったら確かめ直す');
  assert.equal(d3.status, 'SKIPPED');
  nr.run('appHasRole_ = __hasRole');
  // 権限が足りない計画しか無いときの理由は DENIED
  nr.run('appHasRole_ = (roles, min, clientId) => clientId !== __deny && __hasRole(roles, min, clientId)', { __deny: denyClient });
  nr.run(`appAutoResearchUpdate_(s => { Object.keys(s.tried).forEach(k => { if (k !== __p) delete s.tried[k]; }); delete s.tried[__p]; })`, { __p: pDeny });
  for (const id of off) researchedAt(nr, id, jst(B + 4, 3));
  const d4 = tick(nr);
  assert.deepEqual([d4.status, d4.reason, d4.planId], ['SKIPPED', 'DENIED', pDeny]);
  nr.run('appHasRole_ = __hasRole');
}

// ==== 9. 状態は約 8000 バイトより小さく（失敗した計画が 40 を超えても）。書けなくても毎日の回は止まらず、印も残らない ====
{
  const big = setUpEnv();
  stubVertex(big, 403);
  setNow(big, jst(B, 4, 35));
  const y = big.run('appFy_(appAutoResearchNow_())');
  const pA = seed(big, '甲製薬', y);
  big.run('doGet({})');
  const longFail = LEGACY_FAIL.replace('403 PERMISSION_DENIED denied', '403 PERMISSION_DENIED 権限がありません。プロジェクトの設定と所有者の許可を確かめてください');
  const fill = (n) => big.run(`appAutoResearchUpdate_(s => { for (let i = 0; i < ${n}; i++) appAutoResearchNote_(s, 'PL-20261006' + String(i).padStart(6, '0') + '-ABCDEF12', 'FAILED', __now - i * 60000, __msg); })`,
    { __now: jst(B, 4, 0), __msg: longFail });
  fill(45);
  const s45 = state(big);
  assert.ok(stateBytes(big) < 8000, '失敗した計画が 45 でも 8000 バイトより小さい: ' + stateBytes(big));
  assert.equal(Object.keys(s45.tried).length, 45, '理由の文を外せば、試した結果は全部残る');
  assert.ok(Object.values(s45.tried).every((t) => t.status === 'FAILED' && t.reason === undefined));
  assert.equal(s45.history.length, 30);
  assert.equal(status(big).failures7d, 45);
  // 自動の回はそのまま動く（始める → 失敗 → 印を外す）
  const r = tick(big);
  assert.deepEqual([r.status, r.planId], ['STARTED', pA], r.reason);
  drain(big);
  assert.equal(state(big).chain, null, '印（chain）は外れる');
  assert.equal(state(big).lastResult.status, 'FAILED');
  assert.ok(stateBytes(big) < 8000);
  assert.equal(status(big).failures7d, 46);
  // もっと多い（150）: 古い試した結果から減らす（新しいものは残す）
  fill(150);
  const s150 = state(big);
  assert.ok(stateBytes(big) < 8000, '150 でも 8000 バイトより小さい: ' + stateBytes(big));
  assert.ok(Object.keys(s150.tried).length < 150);
  assert.ok(s150.tried['PL-20261006000000-ABCDEF12'], '新しい試した結果は残す');
  assert.ok(!s150.tried['PL-20261006000149-ABCDEF12'], '古い試した結果から減らす');
  assert.equal(s150.tried[pA].status, 'FAILED', 'さっき失敗した計画（3 日あける印）は残る');

  // Script Properties に書けなくても: 毎日の回は例外にせず結果を返し、実行ログに残す
  const wr = setUpEnv();
  stubVertex(wr, 403);
  setNow(wr, jst(B, 4, 35));
  const pW = seed(wr, '乙製薬', wr.run('appFy_(appAutoResearchNow_())'));
  wr.run('doGet({})');
  const ctl = failStateWrites(wr);
  ctl.left = Infinity;
  const w1 = tick(wr);
  assert.deepEqual([w1.status, w1.planId], ['STARTED', pW], '状態を書けなくても始める');
  assert.ok(wr.logs.some((m) => /自動の AI 調査の状態を控えられません/.test(m)), '書けなかったことはログに残す');
  assert.ok(autoRuns(wr).some((x) => x.status === 'STARTED'), '実行ログには残る');
  drain(wr);
  assert.equal(state(wr).chain, undefined, '書けなかったので印も無い（続きは始めない）');
  // 結果を書けなかった（1 回だけ）: 印だけでも外す
  ctl.left = 0;
  setNow(wr, jst(B + 4, 4, 35));
  const w2 = tick(wr);
  assert.equal(w2.status, 'STARTED', w2.reason);
  assert.ok(state(wr).chain);
  ctl.left = 1;
  drain(wr);
  assert.equal(state(wr).chain, null, '結果を書けなくても、印は外す');
  // ずっと書けない間に終わった: 印は残るが、次の回に片付けて先へ進む
  setNow(wr, jst(B + 8, 4, 35));
  assert.equal(tick(wr).status, 'STARTED');
  ctl.left = Infinity;
  drain(wr);
  assert.ok(state(wr).chain, '書けない間は印が残る');
  ctl.restore();
  setNow(wr, jst(B + 8, 5, 30));
  const w3 = tick(wr);
  assert.equal(w3.stalled, pW, '次の回に止まったとして片付ける');
  assert.equal(state(wr).chain, null);
}

// ==== 10. 失敗の要点・7 日の失敗の数（結果の一覧の件数とは別）・すべての印に画面の名前 ====
{
  const g = setUpEnv();
  const gist = (m, n = 40) => g.run('appAutoResearchGist_(__m, __n)', { __m: m, __n: n });
  assert.equal(gist(LEGACY_FAIL), '403 PERMISSION_DENIED denied', '「問い合わせの失敗」の最初の行の、→ の後');
  assert.equal(gist(LEGACY_FAIL, 120), '403 PERMISSION_DENIED denied');
  assert.equal(gist('AI調査エラー: 長い前置きの文。\nVertex の応答: 429 RESOURCE_EXHAUSTED'), 'Vertex の応答: 429 RESOURCE_EXHAUSTED', '無ければ最後の行');
  const tail = gist('あ'.repeat(50) + ' 403 PERMISSION_DENIED');
  assert.ok(tail.length === 40 && tail.startsWith('…') && tail.endsWith('403 PERMISSION_DENIED'), '長い最後の行は後ろを残す: ' + tail);
  assert.equal(gist('ほかの処理（予測）が終わるまでお待ちください。'), 'ほかの処理（予測）が終わるまでお待ちください。');
  assert.equal(gist('AI_DISABLED'), 'AI_DISABLED');
  assert.equal(gist(''), '');
  // 1 週間に 30 を超える結果: 結果の一覧は 30 件でも、7 日の失敗は全部数える（7 日より前は数えない）
  setNow(g, jst(B, 4, 35));
  g.run(`appAutoResearchUpdate_(s => {
    for (let i = 0; i < 35; i++) appAutoResearchNote_(s, 'PL-F' + i, i % 2 ? 'FAILED' : 'STALLED', __now - i * 4 * 3600e3, 'x');
    for (let i = 0; i < 5; i++) appAutoResearchNote_(s, 'PL-D' + i, 'DONE', __now - i * 3600e3);
    for (let i = 0; i < 3; i++) appAutoResearchNote_(s, 'PL-OLD' + i, 'FAILED', __now - (8 + i) * ${DAY}, 'x');
  })`, { __now: jst(B, 4, 30) });
  assert.equal(state(g).history.length, 30);
  assert.equal(status(g).failures7d, 35, '結果の一覧から落ちた失敗も数える');
  assert.equal(state(g).fails.length, 35, '7 日より前の失敗の時刻は忘れる');
  setNow(g, jst(B + 7, 4, 35));
  assert.ok(status(g).failures7d < 35, '日がたてば減る');
  // すべての状態と理由の印に、画面の名前がある
  const labels = J(g.run('APP_AUTO_RESEARCH_LABELS'));
  const src = sources['AutoResearch.js'];
  const codes = new Set(['DONE', 'FAILED', 'STALLED', 'STARTED', 'SKIPPED', 'TICK', 'CHAIN', 'JOB']);
  for (const re of [/finish\('([A-Z_]+)'(?:, '([A-Z_]+)')?/g, /reason: '([A-Z_]+)'/g, /appAutoResearchNote_\(s, [^,]+, '([A-Z_]+)'/g, /mark\([^,]+, '([A-Z_]+)'/g]) {
    for (const m of src.matchAll(re)) m.slice(1).filter(Boolean).forEach((c) => codes.add(c));
  }
  assert.ok(codes.has('MAINTENANCE_PENDING') && codes.has('NO_SALES_DATA') && codes.has('TRIGGER_LIMIT'), [...codes].join(','));
  const missing = [...codes].filter((c) => !labels[c]);
  assert.deepEqual(missing, [], '画面の名前の無い印');
  assert.equal(g.run(`appAutoResearchLabel_('BEFORE_HOURS')`), '4 時より前（毎日の手入れの時間）');
  assert.equal(g.run(`appAutoResearchLabel_('')`), '');
}

console.log('app-auto-research: all tests passed');
