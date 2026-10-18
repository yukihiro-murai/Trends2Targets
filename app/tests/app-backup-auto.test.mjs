#!/usr/bin/env node
/**
 * app-backup-auto.test.mjs — 毎日のバックアップのトリガーを、所有者が画面を開いたときに自動で作る（Backup.js の appEnsureBackupTrigger_。2026-10-07 村井さん承認）。
 * 所有者が開くと 1 つ作る・同じ日は確かめ直さない・次の日に確かめ直す・あるトリガーには触らない・止めるスイッチ（BACKUP_AUTO_ENABLE）・
 * 所有者でなければ何もしない・ロックの中で確かめ直して二重に作らない・作れなくても画面は開く・トリガーの上限・ホームのよみの文（今日もう確かめたときは明日以降）。
 * GAS のモックの上で確かめるだけ（本物の Apps Script・本物のデータでは確かめていない）。
 *
 *   node app/tests/app-backup-auto.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { OWNER, MEMBER, OUTSIDER, setUpEnv, makeEnv, jstDay, J, uiHtml } from './gas-mock.mjs';

const backupTriggers = (env) => env.triggers.filter((t) => t.handler === 'triggerDailyBackup');
const ensureRuns = (env) => env.runLog().filter((r) => r.kind === 'BACKUP.ENSURE').map((r) => [r.status, JSON.parse(r.detail_json || '{}'), r.error]);
const ensure = (env) => J(env.run(`appEnsureBackupTrigger_({ requestId: 'TEST', actor: '${OWNER}' })`));
const checked = (env) => JSON.parse(env.props.APP_BACKUP_AUTO_CHECKED || 'null');
/** 画面を開いて、最初のデータ（var B）を読む */
const open = (env) => {
  const out = env.run('doGet({})');
  return { out, boot: JSON.parse(/var B = (.*);\n/.exec(out.getContent())[1]) };
};
const dropBackupTriggers = (env) => { for (let i = env.triggers.length - 1; i >= 0; i--) if (env.triggers[i].handler === 'triggerDailyBackup') env.triggers.splice(i, 1); };

// ==== 1. 所有者が開くと 1 つ作る（appEnableBackup_ と同じ作り方）。バックアップそのものは取らない。記録は実行ログだけ ====
{
  const env = setUpEnv();
  env.boot();   // 初期設定の後の最初の操作で動く一度だけの写し（監査に残る）を先に済ませる
  const audits = env.audit().length;
  const { out, boot } = open(env);
  assert.equal(out.title, 'Trends2Targets');
  assert.equal(backupTriggers(env).length, 1, '所有者が開くとトリガーを作る');
  const t = backupTriggers(env)[0];
  assert.deepEqual([t.everyDays, t.atHour, t.nearMinute], [1, 3, undefined], '毎日 3 時ごろ（所有者の enableBackup と同じ）');
  assert.deepEqual(ensureRuns(env).map((x) => [x[0], x[1].hour, x[1].by]), [['CREATED', 3, OWNER]], '作ったことを実行ログ（BACKUP.ENSURE）に残す');
  assert.deepEqual(checked(env), { date: jstDay(0), installed: true, reason: '' }, '確かめた日を控える');
  assert.equal(env.audit().length, audits, '画面を開くだけでは監査の記録を増やさない');
  assert.equal(env.backups().length, 0, '画面を開いたときはバックアップを取らない（3 時ごろのトリガーが取る）');
  assert.equal(env.runLog().filter((r) => r.kind === 'BACKUP').length, 0);
  assert.deepEqual([boot.home.system.backup.enabled, boot.home.system.backupAuto], [true, null], '最初の画面のホームでも、すぐに有効と出す');
  // 作ったトリガーは毎日のバックアップの入口に所有者として受け付けられる（所有者の enableBackup で作ったものと同じ）
  env.as('');
  const daily = env.call(`triggerDailyBackup({ triggerUid: '${t.uid}' })`);
  env.as(OWNER);
  assert.ok(daily.backup && /^Trends2Targets_Data_Backup_/.test(daily.backup.backup), 'トリガーからバックアップを取れる');
  assert.equal(backupTriggers(env).length, 1, '毎日の処理はバックアップのトリガーを増やさない');
}

// ==== 2. 同じ日は確かめ直さない（ロックも取らない）。次の日に確かめ直す ====
{
  const env = setUpEnv();
  open(env);
  dropBackupTriggers(env);   // アプリの外でトリガーを消した
  open(env);
  assert.equal(backupTriggers(env).length, 0, '同じ日のうちは確かめ直さない（開くたびに重くしない）');
  const locks = env.state.locks;
  const r = ensure(env);
  assert.deepEqual([r.checked, r.reason, r.installed], [false, 'CHECKED_TODAY', true]);
  assert.equal(env.state.locks, locks, '確かめた日はロックを取らない');
  assert.equal(ensureRuns(env).length, 1);
  // ホーム（所有者でない管理者にも）: トリガーが無く、今日もう確かめたなら、そう渡す（画面は明日以降に作ると出す）
  const sys = env.call('apiHome()').system;
  assert.deepEqual([sys.backup.enabled, sys.backupAuto], [false, { off: false, checkedOn: jstDay(0), checkedToday: true, reason: '' }], '今日はもう確かめたと渡す（その日のうちは作らない）');
  // 確かめる途中で止まった（控えが CHECKING のまま）も、今日はもう確かめた
  env.props.APP_BACKUP_AUTO_CHECKED = JSON.stringify({ date: jstDay(0), installed: false, reason: 'CHECKING' });
  assert.deepEqual(env.call('apiHome()').system.backupAuto, { off: false, checkedOn: jstDay(0), checkedToday: true, reason: 'CHECKING' });
  assert.equal(ensure(env).reason, 'CHECKED_TODAY');
  // 次の日（控えの日付が違う）: 作り直す
  env.props.APP_BACKUP_AUTO_CHECKED = JSON.stringify({ date: jstDay(-1), installed: true, reason: '' });
  assert.deepEqual(env.call('apiHome()').system.backupAuto, { off: false, checkedOn: jstDay(-1), checkedToday: false, reason: '' }, '前の日の控えは、今日はまだ確かめていない');
  open(env);
  assert.equal(backupTriggers(env).length, 1, '次の日に確かめ直して作る');
  assert.deepEqual(ensureRuns(env).map((x) => x[0]), ['CREATED', 'CREATED']);
  assert.equal(checked(env).date, jstDay(0));
  // 控えが壊れていても止まらない（確かめ直す）
  env.props.APP_BACKUP_AUTO_CHECKED = '{壊れた';
  const again = ensure(env);
  assert.deepEqual([again.checked, again.installed, again.created], [true, true, false]);
  assert.deepEqual(checked(env), { date: jstDay(0), installed: true, reason: '' });
}

// ==== 3. あるトリガーには触らない（作り直さない・消さない・ロックも取らない・実行ログにも残さない） ====
{
  const env = setUpEnv();
  env.task('enableBackup()');
  const uid = backupTriggers(env)[0].uid;
  const locks = env.state.locks;
  const r = ensure(env);
  assert.deepEqual([r.checked, r.installed, r.created], [true, true, false]);
  assert.equal(env.state.locks, locks, 'トリガーがある日はロックを取らない（画面を開くのを待たせない）');
  assert.deepEqual(backupTriggers(env).map((t) => t.uid), [uid], 'あるトリガーはそのまま');
  assert.deepEqual(checked(env), { date: jstDay(0), installed: true, reason: '' });
  // 二重にできていても触らない（どちらも残す）
  env.run(`ScriptApp.newTrigger('triggerDailyBackup').timeBased().everyDays(1).atHour(3).create()`);
  const both = backupTriggers(env).map((t) => t.uid);
  env.props.APP_BACKUP_AUTO_CHECKED = JSON.stringify({ date: jstDay(-1), installed: true, reason: '' });
  open(env);
  assert.deepEqual(backupTriggers(env).map((t) => t.uid), both, '二重のトリガーも消さない');
  assert.equal(ensureRuns(env).length, 0, '作っていなければ実行ログに残さない');
}

// ==== 4. 止めるスイッチ（BACKUP_AUTO_ENABLE が 'false' か '0'）: 作らない。控えも書かない（消せばその日のうちに作る） ====
{
  const env = setUpEnv();
  for (const v of ['false', ' FALSE ', '0']) {
    env.props.BACKUP_AUTO_ENABLE = v;
    open(env);
    assert.equal(backupTriggers(env).length, 0, `止めてあれば作らない（${JSON.stringify(v)}）`);
    assert.equal(ensure(env).reason, 'DISABLED');
  }
  assert.equal(env.props.APP_BACKUP_AUTO_CHECKED, undefined, '止めてある間は確かめた控えを書かない');
  assert.equal(ensureRuns(env).length, 0);
  assert.deepEqual(env.call('apiHome()').system.backupAuto, { off: true, checkedOn: '', checkedToday: false, reason: '' }, 'ホームに止めてあることを渡す');
  // 止めてあっても、あるトリガーは消さない
  env.task('enableBackup()');
  open(env);
  assert.equal(backupTriggers(env).length, 1);
  assert.equal(env.call('apiHome()').system.backupAuto, null, 'トリガーがあれば渡さない');
  dropBackupTriggers(env);
  // 'true' やほかの値は止めない。消せば、その日のうちに作る
  env.props.BACKUP_AUTO_ENABLE = 'true';
  open(env);
  assert.equal(backupTriggers(env).length, 1, "'true' なら作る");
  dropBackupTriggers(env);
  delete env.props.APP_BACKUP_AUTO_CHECKED;
  env.props.BACKUP_AUTO_ENABLE = 'false';
  open(env);
  delete env.props.BACKUP_AUTO_ENABLE;
  open(env);
  assert.equal(backupTriggers(env).length, 1, 'スイッチを消せば、その日のうちに作る');
}

// ==== 5. 所有者でなければ何もしない（社内の閲覧・所有者でない管理者・社外の人）。初期設定の前も何もしない ====
{
  const env = setUpEnv();
  env.task(`saveMember({ email: '${MEMBER}', displayName: 'M' })`);
  env.task(`grantRole({ email: '${MEMBER}', role: 'ADMIN' })`);
  const audits = env.audit().length;
  env.as(MEMBER);
  const { boot } = open(env);
  assert.equal(boot.user.isAdmin, true, '管理者として開いた');
  assert.equal(backupTriggers(env).length, 0, '所有者でない管理者が開いても作らない');
  assert.equal(env.props.APP_BACKUP_AUTO_CHECKED, undefined, '控えも書かない');
  assert.deepEqual([boot.home.system.backup.enabled, boot.home.system.backupAuto], [false, { off: false, checkedOn: '', checkedToday: false, reason: '' }]);
  env.as(OUTSIDER);
  assert.equal(open(env).boot.allowed, false);
  assert.equal(backupTriggers(env).length, 0, '社外の人が開いても作らない');
  env.as(OWNER);
  assert.equal(env.audit().length, audits);
  assert.equal(ensureRuns(env).length, 0);
  // 初期設定の前: 所有者が開いても作らない（止まらない）
  const fresh = makeEnv();
  fresh.as(OWNER);
  assert.equal(open(fresh).boot.setUp, false);
  assert.equal(backupTriggers(fresh).length, 0);
  assert.equal(J(fresh.run(`appEnsureBackupTrigger_({ requestId: 'TEST', actor: '${OWNER}' })`)).reason, 'NOT_SET_UP');
}

// ==== 6. 2 つのタブが同時に開く: 後の実行はロックの中で確かめ直して作らない ====
{
  const race = (env, other) => env.run(`(() => {
    const orig = appWithLock_;
    let first = true;
    appWithLock_ = (fn) => {
      if (first) { first = false; globalThis.__other = ${other}; }
      return orig(fn);
    };
    globalThis.__restoreLock = () => { appWithLock_ = orig; };
  })()`);
  // 先の実行が確かめて作った（控えは今日）
  const env = setUpEnv();
  race(env, `appEnsureBackupTrigger_({ requestId: 'OTHER', actor: '${OWNER}' })`);
  const late = ensure(env);
  const early = J(env.run('__other'));
  env.run('__restoreLock()');
  assert.equal(early.created, true, '先の実行が作る');
  assert.equal(late.reason, 'CHECKED_TODAY', '後の実行はロックの中で控えを読み直して作らない');
  assert.equal(backupTriggers(env).length, 1, 'トリガーは 1 つだけ');
  assert.deepEqual(ensureRuns(env).map((x) => x[0]), ['CREATED']);
  // ロックを待つ間に、ほかの経路（所有者の enableBackup）でトリガーができた（控えは無い）: トリガーを確かめ直して作らない
  const two = setUpEnv();
  race(two, 'appEnableBackup_()');
  const r = ensure(two);
  two.run('__restoreLock()');
  assert.deepEqual([r.checked, r.installed, r.created], [true, true, false]);
  assert.equal(backupTriggers(two).length, 1, '二重に作らない');
  assert.deepEqual(checked(two), { date: jstDay(0), installed: true, reason: '' });
  assert.equal(ensureRuns(two).length, 0);
  assert.equal(two.state.lockHeld, false, 'ロックを返す');
}

// ==== 7. 作れなくても画面は開く（例外を doGet の外へ出さない）。失敗は実行ログに残し、その日は試し直さない ====
{
  const env = setUpEnv();
  env.run(`(() => {
    const orig = ScriptApp.newTrigger;
    globalThis.__made = 0;
    ScriptApp.newTrigger = (h) => { if (h === 'triggerDailyBackup') { __made++; throw new Error('トリガーを作れません（テスト）'); } return orig(h); };
  })()`);
  const { out, boot } = open(env);
  assert.equal(out.title, 'Trends2Targets', '作れなくても画面は開く');
  assert.deepEqual([boot.allowed, boot.setUp, boot.user.isOwner], [true, true, true]);
  assert.equal(backupTriggers(env).length, 0);
  assert.deepEqual(ensureRuns(env).map((x) => [x[0], x[1].reason, x[2]]), [['FAILED', 'FAILED', 'トリガーを作れません（テスト）']], '失敗を実行ログに残す');
  assert.deepEqual(checked(env), { date: jstDay(0), installed: false, reason: 'FAILED' });
  assert.equal(env.state.lockHeld, false);
  assert.equal(env.triggers.filter((t) => t.handler === 'triggerAutoResearch').length, 1, 'AI 調査のトリガーはそのまま確かめる');
  assert.deepEqual(boot.home.system.backupAuto, { off: false, checkedOn: jstDay(0), checkedToday: true, reason: 'FAILED' }, 'ホームに作れなかったことを渡す');
  open(env);
  assert.equal(env.run('__made'), 1, '同じ日は試し直さない');
  // トリガーの一覧そのものが読めない（ロックの前で止まる）: 画面は開き、ログに残す。控えを書かないので次に開いたときに試す
  const broken = setUpEnv();
  broken.run(`ScriptApp.getProjectTriggers = () => { throw new Error('一覧を読めません（テスト）'); }`);
  const b2 = open(broken);
  assert.equal(b2.out.title, 'Trends2Targets');
  assert.equal(b2.boot.allowed, true);
  assert.ok(broken.logs.some((m) => /毎日のバックアップのトリガー: 一覧を読めません/.test(m)), broken.logs.join('\n'));
  assert.equal(broken.props.APP_BACKUP_AUTO_CHECKED, undefined);
  assert.equal(broken.state.lockHeld, false);
  // 控え（所有者の UserProperties）を書けない: 画面は開く
  const ro = setUpEnv();
  ro.run(`(() => {
    const real = PropertiesService.getUserProperties;
    PropertiesService.getUserProperties = () => { const p = real(); const set = p.setProperty; p.setProperty = (k, v) => { if (k === 'APP_BACKUP_AUTO_CHECKED') throw new Error('書けません（テスト）'); return set(k, v); }; return p; };
  })()`);
  assert.equal(open(ro).boot.allowed, true);
  assert.ok(ro.logs.some((m) => /毎日のバックアップのトリガー: 書けません/.test(m)), ro.logs.join('\n'));
  assert.equal(ro.state.lockHeld, false);
}

// ==== 8. トリガーの上限（20）: 裏の処理の分（3）を空けて、足りなければ作らない（自動の AI 調査と同じ）。バックアップを先に確かめる ====
{
  const env = setUpEnv();
  for (let i = 0; i < 17; i++) env.run(`ScriptApp.newTrigger('triggerDummy').timeBased().everyDays(1).atHour(5).create()`);
  const r = ensure(env);
  assert.deepEqual([r.checked, r.installed, r.created, r.reason], [true, false, false, 'TRIGGER_LIMIT'], '上限に余裕が無ければ作らない');
  assert.equal(backupTriggers(env).length, 0);
  assert.deepEqual(ensureRuns(env).map((x) => [x[0], x[1].reason, x[1].triggers]), [['SKIPPED', 'TRIGGER_LIMIT', 17]], '見送ったことを実行ログに残す');
  assert.deepEqual(checked(env), { date: jstDay(0), installed: false, reason: 'TRIGGER_LIMIT' });
  assert.deepEqual(env.call('apiHome()').system.backupAuto, { off: false, checkedOn: jstDay(0), checkedToday: true, reason: 'TRIGGER_LIMIT' });
  // 16 個なら作れる（20 - 3 の余裕）。画面を開いたときはバックアップを先に確かめるので、枠が 1 つだけならバックアップに使う
  env.triggers.splice(env.triggers.findIndex((t) => t.handler === 'triggerDummy'), 1);
  delete env.props.APP_BACKUP_AUTO_CHECKED;
  open(env);
  assert.equal(backupTriggers(env).length, 1, '16 個なら作れる');
  assert.equal(env.triggers.filter((t) => t.handler === 'triggerAutoResearch').length, 0, '残りの枠が無いので AI 調査のトリガーは作らない');
  assert.equal(JSON.parse(env.props.APP_AUTO_RESEARCH_CHECKED).reason, 'TRIGGER_LIMIT');
}

// ==== 9. ホームのよみの文（管理者だけ）: トリガーがあれば出さない。無ければ、自動で有効になる（今日もう確かめたなら明日以降）・止めてある・作れなかった ====
{
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [] }, setUp: true, allowed: true }));
  const el = () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
  const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, confirm: () => false, window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  const items = (sys) => JSON.parse(vm.runInContext(`JSON.stringify(homeSysItems(${JSON.stringify(sys)}))`, ui)).filter((x) => x[0] === 'バックアップ');
  const backup = { enabled: false, count: 0, latest: '', ageHours: null, keep: 14 };
  assert.deepEqual(items({ backup: Object.assign({}, backup, { enabled: true, count: 3, ageHours: 2 }), backupAuto: null }), [], 'トリガーがあれば出さない');
  // 保守の有効化・トリガー枠などは通常ホームへ表示しない。バックアップ本体の検査は上記1〜8で維持。
  const scenarios = [
    { backup, backupAuto: { off: false, checkedOn: '', checkedToday: false, reason: '' } },
    { backup, backupAuto: { off: false, checkedOn: jstDay(-1), checkedToday: false, reason: '' } },
    ...['', 'CHECKING', 'TRIGGER_LIMIT', 'FAILED'].map(reason => ({ backup, backupAuto: { off: false, checkedOn: jstDay(0), checkedToday: true, reason } })),
    { backup }, { backup, backupAuto: { off: true } },
    { backup: Object.assign({}, backup, { enabled: true }) },
    { backup: Object.assign({}, backup, { enabled: true, count: 3, ageHours: 60 }) }
  ];
  scenarios.forEach(sys => assert.deepEqual(items(sys), [], '保守状態を通常ホームへ出さない'));
  const says = JSON.parse(vm.runInContext(`JSON.stringify(yomiSays({ fy: '2026', plans: [], approvals: [], mine: [], system: ${JSON.stringify(scenarios[0])} }))`, ui));
  assert.ok(says.every(x => !/所有者|バックアップ|トリガー/.test(x.text || '')), '利用者への案内に運用説明を混ぜない');

}

console.log('app-backup-auto: all tests passed');
