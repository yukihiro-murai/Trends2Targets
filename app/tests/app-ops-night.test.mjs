#!/usr/bin/env node
/*
 * app-ops-night.test.mjs — 夜の運用（2026-10-13）: 毎日のバックアップと手入れを別の実行に分ける（Housekeeping.js・Jobs.js）。
 * 毎日のトリガーはバックアップだけをして、手入れは数分後の裏の処理（SYSTEM.HOUSEKEEPING。頼んだ人は所有者）で動かす・
 * 入れられない／前の手入れが始まらなかったときはその実行で続けて動かす・手入れは始めた印を書いて終わったら結果で上書きする・
 * 打ち切られたら「始めたまま」が残り、ホーム・状態の点検・次の手入れで気づける・自動の調べは新しい印で「その日の手入れが済んだか」を見る・
 * 監査の鎖の全部の行の確認は、控えのある月を 7 日で一巡するよう 1 日に少しずつ回す（時間の上限を過ぎたら見送りを要確認に出す）。
 * GAS のモックの上で確かめるだけ（本物の Apps Script では確かめていない）。
 *
 *   node app/tests/app-ops-night.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { OWNER, MEMBER, setUpEnv, jstDay, J, uiHtml } from './gas-mock.mjs';

const DCTX = `{ user: appCurrentUser_(), roles: [], actor: '${OWNER}', requestId: 'N1' }`;
const daily = (env) => env.call(`appDailyMaintenance_(${DCTX})`);
const hkMark = (env) => JSON.parse(env.props.APP_HOUSEKEEPING || 'null');
const hkJobs = (env) => J(env.run('appJobList_()')).filter((j) => j.kind === 'SYSTEM.HOUSEKEEPING');
const jobTriggers = (env) => env.triggers.filter((t) => t.handler === 'triggerRunJob');
/** 日本時間の ISO（+0900）。ms はミリ秒の時刻 */
const iso = (env, ms) => env.run(`Utilities.formatDate(new Date(${ms}), APP_TZ, "yyyy-MM-dd'T'HH:mm:ssZ")`);
/** 手入れの印の時刻をずらす（minutes 分前に始めた） */
const shiftMark = (env, minutes, patch) => {
  const m = hkMark(env);
  const at = iso(env, Date.now() - minutes * 60000);
  env.props.APP_HOUSEKEEPING = JSON.stringify(Object.assign(m, { at, startedAt: at }, patch || {}));
};

// ==== 1. 毎日のトリガーはバックアップだけ。手入れは数分後の裏の処理（所有者が頼んだ形）で動き、印と結果を残す ====
{
  const env = setUpEnv();
  env.task('enableBackup()');
  const uid = env.triggers.find((t) => t.handler === 'triggerDailyBackup').uid;
  env.as('');
  const r = env.call(`triggerDailyBackup({ triggerUid: '${uid}' })`);
  env.as(OWNER);
  assert.ok(r.backup && r.backup.backup, 'バックアップを取る');
  assert.equal(r.housekeeping.scheduled, true, JSON.stringify(r.housekeeping));
  assert.equal(hkMark(env), null, 'バックアップの実行では手入れを動かさない');
  assert.equal(env.runLog().filter((x) => x.kind === 'HOUSEKEEPING').length, 0);
  const jobs = hkJobs(env);
  assert.equal(jobs.length, 1);
  assert.deepEqual([jobs[0].status, jobs[0].requestedBy], ['QUEUED', OWNER], '頼んだ人は所有者');
  const t = jobTriggers(env).find((x) => x.uid === jobs[0].triggerUid);
  assert.equal(t.afterMs, 2 * 60 * 1000, '数分後（2 分）に 1 回だけ動くトリガー');
  // もう一度動いても、待っている手入れを二重に入れない
  assert.equal(daily(env).housekeeping.already, true);
  assert.equal(hkJobs(env).length, 1);
  // 画面からは始められない
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'SYSTEM.HOUSEKEEPING', payload: {} } }), /画面から始められません/);
  // 動いている間の印: 始めた（RUNNING）・前に終わった時刻は無い（初めて）
  env.run(`__open = appOpenStarts_; appOpenStarts_ = function () { __mid = appHousekeepingLast_(); return __open(); }`);
  env.fireTriggers('triggerRunJob');
  const mid = J(env.run('__mid'));
  assert.deepEqual([mid.state, mid.via, mid.lastDoneAt], ['RUNNING', 'JOB', undefined], '始める前に「始めた」の印を書く');
  assert.equal(mid.at, mid.startedAt);
  const done = hkMark(env);
  assert.deepEqual([done.state, done.via, done.ok, done.at, done.startedAt], ['DONE', 'JOB', true, mid.at, mid.at], '終わったら結果で上書きする: ' + JSON.stringify(done.problems));
  assert.ok(new Date(done.finishedAt).getTime() >= new Date(done.startedAt).getTime());
  assert.equal(hkJobs(env)[0].status, 'DONE');
  assert.ok(env.runLog().some((x) => x.kind === 'HOUSEKEEPING' && x.status === 'OK'), '実行ログに残す');
  const a = env.audit().filter((x) => x.action === 'HOUSEKEEPING.DAILY');
  assert.deepEqual(a.map((x) => [x.phase, x.result, x.actor_email]), [['START', '', OWNER], ['END', 'OK', OWNER]], '監査にも残す');
  // 次の手入れの「始めた」の印には、前に終わった時刻を残す
  env.task('runHousekeeping()');
  const mid2 = J(env.run('__mid'));
  assert.deepEqual([mid2.state, mid2.via, mid2.lastDoneAt], ['RUNNING', 'MANUAL', done.finishedAt]);
  assert.equal(env.state.lockHeld, false);
}

// ==== 2. 入れられない・前の手入れが始まらなかったときは、バックアップの実行で続けて動かす（止まりっぱなしにしない） ====
{
  const env = setUpEnv();
  // 入れようとして失敗した
  env.run(`__enq = appEnqueueJob_; appEnqueueJob_ = function (kind) { if (kind === 'SYSTEM.HOUSEKEEPING') throw new Error('enqueue boom'); return __enq.apply(null, arguments); }`);
  let r = daily(env);
  assert.deepEqual([r.housekeeping.inline, r.housekeeping.reason, r.housekeeping.ok], [true, 'FAILED', true]);
  assert.equal(hkMark(env).via, 'INLINE');
  assert.ok(env.errors().some((x) => x.where === 'HOUSEKEEPING.SCHEDULE' && /enqueue boom/.test(x.message)), 'エラーのログに残す');
  env.run('appEnqueueJob_ = __enq');
  // 前の手入れを始めてから 30 時間を過ぎた（裏の処理が動かなかった）: その実行で動かす
  shiftMark(env, 31 * 60, { state: 'DONE', finishedAt: iso(env, Date.now() - 31 * 3600e3 + 60000) });
  r = daily(env);
  assert.deepEqual([r.housekeeping.inline, r.housekeeping.reason], [true, 'MISSED']);
  assert.equal(hkJobs(env).length, 0, '裏の処理は入れない');
  // 始めたまま 30 時間を過ぎた印も同じ（裏の処理が続けて動かなかった）
  shiftMark(env, 31 * 60, { state: 'RUNNING' });
  r = daily(env);
  assert.deepEqual([r.housekeeping.inline, r.housekeeping.reason], [true, 'MISSED']);
  assert.match(r.housekeeping.problems[0], /前回の手入れ（.*に始めた）が途中で止まっていました/, '止まっていたことを要確認に出す');
  assert.equal(r.notify.status, 'SENT', '知らせる');
  // 1 日以内に始めた手入れがあれば、ふつうに裏の処理で
  r = daily(env);
  assert.equal(r.housekeeping.scheduled, true);
  // 前の日に入れた手入れが、トリガーが動かずに待ったまま残っていても、二重とは数えずに入れ直す（始まらずに 15 分たった処理は止まったとみなす）
  const old = hkJobs(env)[0];
  env.props['APP_JOB_' + old.id] = JSON.stringify(Object.assign(old, { createdAt: new Date(Date.now() - 20 * 3600e3).toISOString() }));
  r = daily(env);
  assert.deepEqual([r.housekeeping.scheduled, r.housekeeping.already], [true, false], '入れ直す');
  assert.notEqual(r.housekeeping.jobId, old.id);
  assert.equal(hkJobs(env).find((j) => j.id === old.id).status, 'FAILED', '前の日の分は始まらなかったとして閉じる');
  assert.equal(jobTriggers(env).filter((t) => t.uid === old.triggerUid).length, 0, '前の日の分のトリガーは消す');
}

// ==== 3. 打ち切られた手入れ（始めたまま）は、ホーム・状態の点検・次の手入れで気づける ====
{
  const env = setUpEnv();
  env.task('enableBackup()');
  env.task('runHousekeeping()');
  const prevDone = hkMark(env).finishedAt;
  // 時間切れで打ち切られた（結果の上書きの前に実行が止まった）
  env.run(`__fin = appHousekeepingFinish_; appHousekeepingFinish_ = function () { throw new Error('Exceeded maximum execution time'); }`);
  daily(env);
  env.fireTriggers('triggerRunJob');
  env.run('appHousekeepingFinish_ = __fin');
  const m = hkMark(env);
  assert.deepEqual([m.state, m.via, m.lastDoneAt], ['RUNNING', 'JOB', prevDone], '「始めた」の印が残る');
  const home = () => env.call('apiHome()').system.housekeeping;
  assert.deepEqual([home().stalled, home().lastDoneAt], [false, prevDone], '始めて 10 分までは動いているとみなす');
  shiftMark(env, 11);
  assert.equal(home().stalled, true, '始めて 10 分を過ぎたら、途中で止まった');
  env.props.OWNER_TASK = JSON.stringify({ action: 'health' });
  const h = env.call('apiOwnerTask()');
  assert.equal(h.result.housekeeping.stalled, true, '状態の点検にも、止まったことを出す');
  const brief = JSON.parse(env.props.OWNER_TASK_RESULT).result;
  assert.ok(brief.warnings.some((w) => /毎日の手入れが途中で止まりました/.test(w)), '状態の点検の要確認に出す: ' + JSON.stringify(brief.warnings));
  assert.equal(brief.housekeeping.state, 'RUNNING');
  // 次の手入れ: 前回が止まっていたことを要確認に出し、知らせる
  const r2 = daily(env);
  env.fireTriggers('triggerRunJob');
  const res = J(env.run(`appJobGetResult_(__id)`, { __id: r2.housekeeping.jobId })).value;
  assert.equal(res.ok, false);
  assert.match(res.problems[0], /前回の手入れ（.*に始めた）が途中で止まっていました/);
  assert.equal(res.notify.status, 'SENT');
  assert.ok(env.state.mail.some((x) => x.body.includes('毎日の手入れ')));
  assert.equal(hkMark(env).state, 'DONE');
  assert.equal(home().stalled, false);
}

// ==== 4. 自動の調べは、新しい印で「今日の手入れが済んだか」を見る（済んで 5 分・始めたまま止まったら待たない・まだ・前の日） ====
{
  const env = setUpEnv();
  env.task('enableBackup()');
  const at = (hh, mm) => `${jstDay(0)}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+0900`;
  const ms = (hh, mm) => new Date(at(hh, mm)).getTime();
  const pending = (hh, mm) => env.run(`appAutoResearchMaintenancePending_(new Date(${ms(hh, mm)}))`);
  delete env.props.APP_HOUSEKEEPING;
  assert.equal(pending(4, 30), true, '印が無い（今日の手入れがまだ）');
  env.props.APP_HOUSEKEEPING = JSON.stringify({ state: 'RUNNING', at: at(4, 10), startedAt: at(4, 10), via: 'JOB', lastDoneAt: `${jstDay(-1)}T03:05:00+0900` });
  assert.equal(pending(4, 15), true, '動いている（始めて 10 分まで）');
  assert.equal(pending(4, 21), false, '始めたまま 10 分を過ぎた（止まった。もう動いていないので待たない）');
  env.props.APP_HOUSEKEEPING = JSON.stringify({ state: 'RUNNING', at: `${jstDay(-1)}T03:05:00+0900`, startedAt: `${jstDay(-1)}T03:05:00+0900`, via: 'JOB' });
  assert.equal(pending(4, 30), true, '前の日に始めたまま（今日の手入れはまだ）');
  env.props.APP_HOUSEKEEPING = JSON.stringify({ state: 'DONE', at: at(4, 10), startedAt: at(4, 10), finishedAt: at(4, 20), via: 'JOB', ok: true, durationMs: 1 });
  assert.equal(pending(4, 22), true, '終わってから 5 分は待つ（終わった時刻で見る）');
  assert.equal(pending(4, 25), false);
  env.props.APP_HOUSEKEEPING = JSON.stringify({ at: at(3, 10), ok: true, problems: [], durationMs: 60000 });
  assert.deepEqual([pending(3, 15), pending(3, 17)], [true, false], '前の版の形（始めた時刻とかかった時間）も読む');
  // 毎日の回（triggerAutoResearch）: 止まった手入れの後は見送らない
  env.run('doGet({})');
  const auid = env.triggers.find((t) => t.handler === 'triggerAutoResearch').uid;
  env.run(`appAutoResearchNow_ = () => new Date(${ms(4, 35)})`);
  env.props.APP_HOUSEKEEPING = JSON.stringify({ state: 'RUNNING', at: at(4, 10), startedAt: at(4, 10), via: 'JOB' });
  env.as('');
  const tick = env.call(`triggerAutoResearch({ triggerUid: '${auid}' })`);
  env.as(OWNER);
  assert.notEqual(tick.reason, 'MAINTENANCE_PENDING', JSON.stringify(tick));
}

// ==== 5. 監査の鎖: 控えのある前の月は、1 日に少しずつ全部の行で確かめ、7 日で一巡する ====
{
  const env = setUpEnv();
  // 前の月より前の 10 か月ぶんの監査のシートを作り、今月の行まで 1 本の鎖につなぎ直す（モックの上だけの組み立て）
  const months = J(env.run(`(() => {
    const ss = appLogSpreadsheet_(new Date(), 'write');
    const cols = APP_LOG_TABLES.AUDIT;
    const ip = cols.indexOf('prev_hash');
    const now = new Date();
    const months = [];
    for (let k = 11; k >= 2; k--) months.push(Utilities.formatDate(new Date(now.getFullYear(), now.getMonth() - k, 1), APP_TZ, 'yyyy_MM'));
    let prev = '';
    const chain = body => { const h = appSha256Hex_(prev + '\\n' + JSON.stringify(body)); const row = body.concat([prev, h]); prev = h; return row; };
    months.forEach(m => {
      const sh = ss.insertSheet('AUDIT_' + m);
      sh.getRange(1, 1, 1, cols.length).setNumberFormat('@').setValues([cols]);
      const rows = [0, 1, 2].map(i => chain(cols.slice(0, ip).map((c, j) => (j === 0 ? m + '-' + i : 'x'))));
      sh.getRange(2, 1, rows.length, cols.length).setNumberFormat('@').setValues(rows);
    });
    const cur = ss.getSheetByName('AUDIT_' + Utilities.formatDate(now, APP_TZ, 'yyyy_MM'));
    const vals = cur.getRange(2, 1, cur.getLastRow() - 1, cols.length).getValues().map(r => chain(r.slice(0, ip).map(String)));
    cur.getRange(2, 1, vals.length, cols.length).setNumberFormat('@').setValues(vals);
    appProps_().setProperty(APP_PROP.auditLastHash, prev);
    return months;
  })()`));
  const v = env.task('verifyAudit()');
  assert.equal(v.ok, true, JSON.stringify(v.months.filter((m) => !m.ok)));
  assert.ok(months.every((m) => v.anchored.includes(m)), '締まった月を控える');
  // 7 日ぶんの番: どの月も 1 回だけ全部の行で確かめる
  const seen = {};
  for (let turn = 0; turn < 7; turn++) {
    env.run(`appAuditTurn_ = () => ${turn}`);
    const q = env.call('appVerifyAuditAll_(true)');
    assert.equal(q.ok, true);
    assert.equal(q.cycleDays, 7);
    assert.deepEqual(q.deferred, []);
    q.fullMonths.forEach((m) => { seen[m] = (seen[m] || 0) + 1; });
    assert.ok(q.fullMonths.length <= Math.ceil(months.length / 7) + 1, '1 日に確かめるのは全体の 1/7 くらい: ' + q.fullMonths.length);
  }
  assert.deepEqual(Object.keys(seen).sort(), months.slice().sort(), '7 日で全部の月を一巡する');
  assert.ok(Object.values(seen).every((n) => n === 1));
  // 月の中ほどの行の書き換えは、端だけの日には見えず、その月の番の日に見つかる
  const target = months[4];
  const sh = env.log().getSheetByName('AUDIT_' + target);
  const keep = sh.rows[2].slice();
  sh.rows[2][2] = 'someone-else@bigm2y.com';
  const turnOf = env.run(`appAuditMonthTurn_('${target}')`);
  env.run(`appAuditTurn_ = () => ${(turnOf + 1) % 7}`);
  assert.equal(env.call('appVerifyAuditAll_(true)').ok, true, '端だけの日には見えない（行の数・最初と最後は同じ）');
  env.run(`appAuditTurn_ = () => ${turnOf}`);
  const bad = env.call('appVerifyAuditAll_(true)');
  assert.equal(bad.ok, false, 'その月の番の日に見つかる');
  const flagged = bad.months.find((m) => m.month === target);
  assert.deepEqual([flagged.ok, flagged.brokenAt], [false, 3], '3 行目で切れている（注記は締めの控えとの違いが上書きする）: ' + flagged.note);
  const hk = env.task('runHousekeeping()');
  assert.equal(hk.ok, false);
  assert.ok(hk.problems.some((p) => p.includes(target)), '手入れの要確認に出す');
  assert.equal(env.task('verifyAudit()').ok, false, '手で全部を確かめる入口は、いつも全部の行');
  sh.rows[2] = keep;
  // 時間の上限を過ぎたら、その日の番の月も端だけにして、見送ったことを要確認に出す
  env.run(`appAuditFullBudgetMs_ = () => -1`);
  const late = env.call('appVerifyAuditAll_(true)');
  assert.equal(late.ok, true);
  assert.deepEqual(late.fullMonths, []);
  assert.ok(late.deferred.includes(target), '見送った月を返す');
  const hk2 = env.task('runHousekeeping()');
  assert.ok(hk2.problems.some((p) => /全部の行の確認を \d+ か月見送りました/.test(p)), JSON.stringify(hk2.problems));
  assert.deepEqual(hkMark(env).audit.deferred, late.deferred, '手入れの結果にも残す');
}

// ==== 6. ホームの仕組みの状態（管理者）: 途中で止まった手入れの 1 行・最後に終わってからの時間 ====
{
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [] }, setUp: true, allowed: true }));
  const el = () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
  const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, confirm: () => false, window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const okBackup = { enabled: true, count: 3, ageHours: 5 };
  const arOk = { enabled: true, failures7d: 0, trigger: { installed: true }, lastTickAt: ago(20), stalePlans: [] };
  const items = (hk) => JSON.parse(vm.runInContext(`JSON.stringify(homeSysItems(${JSON.stringify({ housekeeping: hk, backup: okBackup, autoResearch: arOk })}))`, ui));
  const stalled = items({ state: 'RUNNING', stalled: true, at: '2026-10-13T03:02:00+0900', startedAt: '2026-10-13T03:02:00+0900', lastDoneAt: ago(30) });
  assert.equal(stalled.length, 1, '止まった 1 行だけ（古さの行と重ねない）');
  assert.equal(stalled[0][1], '毎日の手入れが途中で止まりました（2026-10-13 03:02 に始めて、終わりの記録がありません）');
  assert.doesNotMatch(stalled[0][2], /OWNER_TASK|apiOwnerTask|"action":|README|スクリプト プロパティ|BACKUP_AUTO_ENABLE/, 'エディタの操作の手順は画面に出さない（2026-10-15 村井さん）');
  assert.deepEqual(items({ state: 'RUNNING', stalled: false, at: ago(0.05), startedAt: ago(0.05), lastDoneAt: ago(20) }), [], '動いている間は出さない');
  assert.match(items({ state: 'RUNNING', stalled: false, at: ago(0.05), startedAt: ago(0.05), lastDoneAt: ago(30) })[0][1], /最後に終わってから 30 時間たっています/, '最後に終わった時刻で見る');
  assert.deepEqual(items({ state: 'DONE', at: ago(31), startedAt: ago(31), finishedAt: ago(20), lastDoneAt: ago(20), ok: true }), []);
  assert.match(items({ at: ago(30), ok: true })[0][1], /最後に終わってから 30 時間たっています/, '前の版の形（at だけ）も今までどおり');
}

void MEMBER;
console.log('app-ops-night: all tests passed');
