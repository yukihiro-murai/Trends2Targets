#!/usr/bin/env node
/*
 * app-maintenance.test.mjs — バックアップのアーカイブ移動（消さない・ゴミ箱に送らない）と、
 * 毎日の処理（appDailyMaintenance_）の異常を管理者へメールで知らせる Notifications.js の契約テスト。
 *
 *   node app/tests/app-maintenance.test.mjs
 */
import assert from 'node:assert/strict';
import { setUpEnv, OWNER, MEMBER, OTHER, OUTSIDER, jstDay } from './gas-mock.mjs';

const DCTX = `{ user: appCurrentUser_(), roles: [], actor: 'test', requestId: 'M1' }`;
const notify = (env, codes) => env.call(`appNotifyMaintenance_(${DCTX}, __c)`, { __c: codes });
const daily = (env) => env.call(`appDailyMaintenance_(${DCTX})`);
const recipients = (env, extra) => env.call(`appMaintenanceRecipients_(${extra || DCTX})`);
const isBackup = (f) => f.kind === 'file' && f.name.startsWith('Trends2Targets_Data_Backup_');
const all = (env) => Object.values(env.files).filter(isBackup).sort((a, b) => a.created - b.created);
const SUBJECT = 'Trends2Targets 要対応';

const grant = (env, row) => env.run(`appInsertRows_('ROLES', [__r])`, { __r: Object.assign({
  role_id: 'RL-' + Math.random().toString(16).slice(2, 10), email: MEMBER, role: 'ADMIN', scope_type: 'ALL',
  client_id: '', valid_from: '', valid_to: '', is_active: true, row_version: 1 }, row) });

// ==== 1. 正常な日は送らない（毎日の処理が全部うまくいったとき） ====
{
  const env = setUpEnv();
  assert.equal(notify(env, []).status, 'SKIPPED');
  assert.equal(env.state.mail.length, 0);
  const r = daily(env);
  assert.ok(r.backup.backup, 'バックアップを作る');
  assert.equal(r.housekeeping.ok, true, JSON.stringify(r.housekeeping));
  assert.equal(r.notify.status, 'SKIPPED', '異常がなければ知らせない');
  assert.equal(env.state.mail.length, 0);
  assert.ok(env.state.lockHeld === false);
}

// ==== 2. 異常の種類ごとに、管理者（所有者）へ 1 通だけ送る ====
{
  const env = setUpEnv();
  const labels = { BACKUP: 'バックアップ', HOUSEKEEPING: '手入れ', AUDIT: '監査', OPEN_STARTS: '止まった', JOURNAL: '控え', ERRORS: 'エラー' };
  for (const code of Object.keys(labels)) {
    const env2 = setUpEnv();
    const r = notify(env2, [code]);
    assert.deepEqual([r.status, r.sent], ['SENT', 1], code);
    assert.equal(env2.state.mail.length, 1);
    assert.equal(env2.state.mail[0].to, OWNER, '管理者 1 人ずつ別々に送る');
    assert.equal(env2.state.mail[0].subject, SUBJECT);
    assert.ok(env2.state.mail[0].body.includes(labels[code]), code + ' の種類の名まえを本文に入れる');
    assert.doesNotMatch(env2.state.mail[0].body, /@/, '本文にメールアドレス・ID を入れない');
    // 実行ログに宛先・本文を残さない
    const rl = env2.runLog().filter((x) => x.kind === 'MAINTENANCE.NOTIFY')[0];
    assert.equal(rl.status, 'SENT');
    assert.doesNotMatch(JSON.stringify(rl), /@/, '実行ログにもアドレスを残さない');
  }
  // 一覧にない種類は捨てる
  const r = notify(env, ['NOPE', 'X']);
  assert.equal(r.status, 'SKIPPED');
  assert.equal(env.state.mail.length, 0);
  // 一覧の中の種類だけ残す
  const r2 = notify(env, ['ERRORS', 'NOPE', 'ERRORS']);
  assert.equal(r2.status, 'SENT');
  assert.equal(env.state.mail.length, 1, '重複した種類は 1 回ぶん');
}

// ==== 3. 送り先: 所有者と、いま効いている全体の管理者だけ ====
{
  const env = setUpEnv();
  assert.deepEqual(recipients(env), [OWNER], '最初は所有者だけ');
  env.call(`apiSaveMember({ email: '${MEMBER}', displayName: 'M' })`);
  env.call(`apiSaveMember({ email: '${OTHER}', displayName: 'O' })`);
  env.call(`apiGrantRole({ email: '${MEMBER}', role: 'ADMIN' })`);
  assert.deepEqual(recipients(env), [OWNER, MEMBER], '全体の管理者を足す');
  // 社外・クライアント単位・期限外・無効・管理者以外は除く
  grant(env, { email: OUTSIDER, role: 'ADMIN' });
  grant(env, { email: OTHER, role: 'ADMIN', scope_type: 'CLIENT', client_id: 'CL-1' });
  grant(env, { email: OTHER, role: 'ADMIN', valid_to: jstDay(-1) });
  grant(env, { email: OTHER, role: 'ADMIN', valid_from: jstDay(1) });
  grant(env, { email: OTHER, role: 'ADMIN', is_active: false });
  grant(env, { email: OTHER, role: 'PLANNER' });
  grant(env, { email: OTHER, role: 'APPROVER' });
  assert.deepEqual(recipients(env), [OWNER, MEMBER], '条件の合わない付与は除く');
  // 大文字・小文字・空白は揃えて重複しない
  grant(env, { email: ' Owner@BIGM2Y.com ', role: 'ADMIN' });
  assert.deepEqual(recipients(env), [OWNER, MEMBER]);
  // 役割の表が読めなくても所有者には届く
  const ss = env.data();
  ss.sheets.splice(ss.sheets.findIndex((s) => s.name === 'ROLES'), 1);
  env.run('APP_STORE_CACHE_ = {}');   // 実行の間の控えを捨てる（本物は入口ごとに新しい実行）
  assert.deepEqual(recipients(env), [OWNER], '表が壊れていても所有者には届ける');
}
{
  // 所有者が分からなければ送らない（fail-closed）
  const env = setUpEnv();
  const bad = `{ user: { email: '', owner: '', domain: '' }, roles: [], actor: 'x', requestId: 'X' }`;
  const r = env.call(`appNotifyMaintenance_(${bad}, ['ERRORS'])`);
  assert.equal(r.status, 'SENT', 'ctx に owner が無くても実効ユーザーから取る');
  assert.equal(env.state.mail.length, 1);
}
{
  // 所有者自身が社内ドメインの設定を消しても、所有者のドメインで判定する
  const env = setUpEnv();
  delete env.props.APP_INTERNAL_DOMAIN;
  grant(env, { email: OUTSIDER, role: 'ADMIN' });
  grant(env, { email: MEMBER, role: 'ADMIN' });
  assert.deepEqual(recipients(env), [OWNER, MEMBER]);
}

{
  // メールアドレスとして正しくないもの・社外のものは、所有者でも付与でも除く
  const env = setUpEnv();
  for (const bad of ['a,b@bigm2y.com', 'a; b@bigm2y.com', 'a b@bigm2y.com', 'a\nb@bigm2y.com', '<a@bigm2y.com>',
    'a@b@bigm2y.com', '@bigm2y.com', 'a@', 'a@bigm2y.com.evil.example', 'notmail']) {
    env.run(`appInsertRows_('ROLES', [__r])`, { __r: { role_id: 'RL-' + Math.random().toString(16).slice(2, 10), email: bad,
      role: 'ADMIN', scope_type: 'ALL', client_id: '', valid_from: '', valid_to: '', is_active: true, row_version: 1 } });
    env.run('APP_STORE_CACHE_ = {}');
    assert.deepEqual(recipients(env), [OWNER], '正しくない宛先は除く: ' + JSON.stringify(bad));
  }
  // 設定の社内ドメインと違うドメインの所有者は宛先に入れない（fail-closed）
  env.props.APP_INTERNAL_DOMAIN = 'other.example';
  assert.deepEqual(recipients(env), [], '所有者が社内ドメイン外なら誰にも送らない');
}
{
  // 設定の社内ドメイン自体が壊れているときは誰にも送らない（@ の右と等しいかの比較だけでは済まない）
  for (const bad of ['bigm2y.com;extra', 'big m2y.com', 'bigm2y.com\nx', 'bigm2y..com', '-bad.com', 'bigm2y.com;', 'nodot']) {
    const env = setUpEnv();
    env.props.APP_INTERNAL_DOMAIN = bad;
    grant(env, { email: 'boss@' + 'bigm2y.com' });
    assert.deepEqual(recipients(env), [], '壊れたドメイン設定では誰にも送らない: ' + JSON.stringify(bad));
  }
  // 所有者が正しいアドレスでなくても、別の管理者の付与があっても誰にも送らない（先に所有者を確かめて即座に空を返す）
  const env = setUpEnv();
  env.props.APP_INTERNAL_DOMAIN = 'other.example';   // 所有者（bigm2y.com）は設定ドメインの外
  grant(env, { email: 'boss@other.example' });       // そのドメインの中の正しい管理者付与
  assert.deepEqual(recipients(env), [], '所有者が社内ドメイン外なら全体の管理者も拾わない');
  const r = notify(env, ['ERRORS']);
  assert.equal(r.status, 'FAILED');
  assert.equal(env.state.mail.length, 0);
}
{
  // 種類の一覧の判定は自分のキーだけ（__proto__ や constructor は捨てる）
  const env = setUpEnv();
  const r = notify(env, ['__proto__', 'constructor', 'ERRORS']);
  assert.equal(r.status, 'SENT');
  assert.equal(env.state.mail.length, 1);
  assert.ok(env.state.mail[0].body.includes('エラー'));
  assert.doesNotMatch(env.state.mail[0].body, /proto|constructor|Object/);
}
{
  // 送信枠が読めない・数でない・足りない → 誰にも送らず FAILED（印は残さない）
  for (const [quota, label] of [[0, '0'], [NaN, 'NaN'], [undefined, 'undefined（モックは既定 500）'], ['x', '文字']]) {
    const env = setUpEnv();
    env.state.mailQuota = quota;
    const r = notify(env, ['ERRORS']);
    if (quota === undefined) { assert.equal(r.status, 'SENT', label); continue; }
    assert.equal(r.status, 'FAILED', label);
    assert.equal(r.reason, 'quota', label);
    assert.equal(env.state.mail.length, 0, label);
    assert.equal(env.props.APP_MAINTENANCE_NOTICES, undefined, '印を残さない: ' + label);
  }
}
{
  // 控えが入りきらないときは誰にも送らず、古い印も捨てない（capacity）
  const env = setUpEnv();
  const day = env.run('appToday_()');
  const marks = [];
  while (JSON.stringify({ day, sent: marks }).length < 8200) marks.push('f'.repeat(64) + String(marks.length).padStart(3, '0'));
  env.props.APP_MAINTENANCE_NOTICES = JSON.stringify({ day, sent: marks });
  const before = env.props.APP_MAINTENANCE_NOTICES;
  const r = notify(env, ['ERRORS']);
  assert.equal(r.status, 'FAILED');
  assert.equal(r.reason, 'capacity', '控えに入らないときは送らない');
  assert.equal(env.state.mail.length, 0);
  assert.equal(env.props.APP_MAINTENANCE_NOTICES, before, '古い印は捨てない（残った分は翌日以降の再送を妨げない）');
}
{
  // 送った後に控えを書けなければ FAILED（SENT とは言わない）・次の宛先へは進まない
  const env = setUpEnv();
  env.call(`apiSaveMember({ email: '${MEMBER}', displayName: 'M' })`);
  env.call(`apiGrantRole({ email: '${MEMBER}', role: 'ADMIN' })`);
  const props = env.state;
  let n = 0;
  const real = env.ctx.PropertiesService;
  const orig = real.getUserProperties;   // 知らせの控えは所有者の UserProperties
  env.ctx.PropertiesService = { getScriptProperties: real.getScriptProperties, getUserProperties: () => Object.assign(orig(), {
    setProperty: (k, v) => { if (k === 'APP_MAINTENANCE_NOTICES' && ++n > 1) throw new Error('書けない（テスト）'); orig().setProperty(k, v); } }) };
  const r = notify(env, ['ERRORS']);
  assert.equal(r.status, 'FAILED', '控えの書き込みが失敗したら FAILED');
  assert.equal(r.reason, 'persist');
  assert.ok(env.state.mail.length >= 1, '送れた分は送れている（届いたかの区別は記録に残す）');
  env.ctx.PropertiesService = real;
  void props;
}
{
  // ロック・宛先の解決・控えの読み込みが失敗しても例外にせず FAILED
  const env = setUpEnv();
  env.run(`appWithLock_ = function () { throw new Error('lock boom'); }`);
  const r = notify(env, ['ERRORS']);
  assert.equal(r.status, 'FAILED');
  assert.equal(r.reason, 'exception');
  assert.equal(env.state.mail.length, 0);
  const env2 = setUpEnv();
  env2.run(`appMaintenanceRecipients_ = function () { throw new Error('recipients boom'); }`);
  const r2 = notify(env2, ['ERRORS']);
  assert.equal(r2.status, 'FAILED');
  assert.equal(env2.state.mail.length, 0);
}
{
  // メールを送る権限の許可（所有者が Apps Script エディタで動かす）。メールは送らない
  const env = setUpEnv();
  env.as(OWNER);
  const r = env.call('appAuthorizeMaintenance_()');
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(env.state.scopeRequests), JSON.stringify([{ mode: 'FULL', scopes: ['https://www.googleapis.com/auth/script.send_mail'] }]), 'メールの権限だけを求める');
  assert.equal(env.state.mail.length, 0, 'メールは送らない');
  env.state.scopeRequests.length = 0;
  for (const who of [MEMBER, OUTSIDER, '']) {
    env.as(who);
    assert.throws(() => env.call('appAuthorizeMaintenance_()'), /権限がありません/, who);
    assert.equal(env.state.scopeRequests.length, 0, '権限のない人は権限の確認もできない: ' + who);
  }
}

// ==== 4. 同じ日の同じ知らせは 1 回まで（翌日は日付で控えが替わる） ====
{
  const env = setUpEnv();
  assert.equal(notify(env, ['ERRORS']).status, 'SENT');
  assert.equal(notify(env, ['ERRORS']).status, 'SKIPPED', '同じ組み合わせはもう送らない');
  assert.equal(env.state.mail.length, 1);
  assert.equal(notify(env, ['ERRORS', 'AUDIT']).status, 'SENT', '種類が増えれば別の知らせ');
  assert.equal(env.state.mail.length, 2);
  // 前の日の控えが残っていても、今日の分として送る
  env.props.APP_MAINTENANCE_NOTICES = JSON.stringify({ day: jstDay(-1), sent: ['old-fingerprint'] });
  assert.equal(notify(env, ['ERRORS']).status, 'SENT', '日が替われば控えは替わる');
  assert.equal(JSON.parse(env.props.APP_MAINTENANCE_NOTICES).day, env.run('appToday_()'));
}

// ==== 5. 送信の失敗は印を残さない（次の実行で送り直せる）・一部だけの失敗・枠不足 ====
{
  const env = setUpEnv();
  env.state.mailFail = true;
  const r = notify(env, ['ERRORS']);
  assert.deepEqual([r.status, r.sent], ['FAILED', 0]);
  assert.equal(env.state.mail.length, 0);
  env.state.mailFail = undefined;
  assert.equal(notify(env, ['ERRORS']).status, 'SENT', '直れば送り直せる');
  assert.equal(env.state.mail.length, 1);
}
{
  const env = setUpEnv();
  env.call(`apiSaveMember({ email: '${MEMBER}', displayName: 'M' })`);
  env.call(`apiGrantRole({ email: '${MEMBER}', role: 'ADMIN' })`);
  env.state.mailFail = (to) => to === MEMBER;
  const r = notify(env, ['ERRORS']);
  assert.equal(r.status, 'FAILED');
  assert.equal(r.sent, 1);
  assert.deepEqual(env.state.mail.map((m) => m.to), [OWNER], '送れた分だけ印を残す');
  env.state.mailFail = undefined;
  const r2 = notify(env, ['ERRORS']);
  assert.equal(r2.status, 'SENT');
  assert.deepEqual(env.state.mail.map((m) => m.to), [OWNER, MEMBER], '失敗した分だけ送り直す（所有者には二度送らない）');
}
{
  const env = setUpEnv();
  env.state.mailQuota = 0;
  const r = notify(env, ['ERRORS']);
  assert.deepEqual([r.status, r.reason], ['FAILED', 'quota'], '枠が無ければ誰にも送らない');
  assert.equal(env.state.mail.length, 0);
  const box = JSON.parse(env.props.APP_MAINTENANCE_NOTICES || '{}');
  assert.deepEqual(box.sent || [], [], '印を残さない');
  env.state.mailQuota = undefined;
  assert.equal(notify(env, ['ERRORS']).status, 'SENT');
}
{
  // 送信枠の問い合わせ自体が投げる → 誰にも送らず FAILED（quota）
  const env = setUpEnv();
  const origQuota = env.ctx.MailApp.getRemainingDailyQuota;
  env.ctx.MailApp.getRemainingDailyQuota = () => { throw new Error('quota boom'); };
  const r = notify(env, ['ERRORS']);
  assert.deepEqual([r.status, r.reason], ['FAILED', 'quota'], '枠が読めなければ送らない');
  assert.equal(env.state.mail.length, 0);
  env.ctx.MailApp.getRemainingDailyQuota = origQuota;
  assert.equal(notify(env, ['ERRORS']).status, 'SENT', '直れば送れる');
}
{
  // 控えの読み込み（保存場所そのものの一時的な失敗）は壊れたJSONとは別: 控えを捨てて再送しないで FAILED
  const env = setUpEnv();
  assert.equal(notify(env, ['ERRORS']).status, 'SENT');
  const sent = JSON.parse(env.props.APP_MAINTENANCE_NOTICES).sent;
  const realPS = env.ctx.PropertiesService;
  const origProps = realPS.getUserProperties;   // 知らせの控えは所有者の UserProperties
  env.ctx.PropertiesService = { getScriptProperties: realPS.getScriptProperties, getUserProperties: () => Object.assign(origProps(), {
    getProperty: (k) => { if (k === 'APP_MAINTENANCE_NOTICES') throw new Error('読めない（テスト）'); return origProps().getProperty(k); } }) };
  const r = notify(env, ['ERRORS']);
  assert.equal(r.status, 'FAILED', '控えが読めなければ送らない（読めずに再送しない）');
  assert.equal(env.state.mail.length, 1, '追加で送らない');
  env.ctx.PropertiesService = realPS;
  const r2 = notify(env, ['ERRORS']);
  assert.equal(r2.status, 'SKIPPED', '直れば控えは残っている（同じ人にもう一度送らない）');
  assert.equal(env.state.mail.length, 1);
  assert.equal(JSON.parse(env.props.APP_MAINTENANCE_NOTICES).sent.length, sent.length, '印はそのまま');
}
{
  // 壊れた控えは、その日の分として始め直す（悪い印を残さない）
  const env = setUpEnv();
  env.props.APP_MAINTENANCE_NOTICES = '{壊れた';
  assert.equal(notify(env, ['ERRORS']).status, 'SENT');
  assert.equal(JSON.parse(env.props.APP_MAINTENANCE_NOTICES).sent.length, 1);
  env.props.APP_MAINTENANCE_NOTICES = JSON.stringify({ day: env.run('appToday_()'), sent: 'not-an-array' });
  assert.equal(notify(env, ['ERRORS']).status, 'SENT', '形の違う控えも安全に扱う');
}

// ==== 6. バックアップ: アーカイブのフォルダが決まらない・開けないときは複製を作る前に止める ====
{
  const env = setUpEnv();
  const n0 = Object.keys(env.files).length;
  delete env.props.APP_ARCHIVE_FOLDER_ID;
  assert.throws(() => env.call('apiRunBackup()'), /アーカイブ/);
  assert.equal(Object.keys(env.files).length, n0, '複製も移動もしない');
}
{
  const env = setUpEnv();
  env.run('apiRunBackup()');
  const archiveId = env.props.APP_ARCHIVE_FOLDER_ID;
  delete env.files[archiveId];   // フォルダが消えている
  const n0 = Object.keys(env.files).length;
  assert.throws(() => env.call('apiRunBackup()'), /folder|アーカイブ|no folder/);
  assert.equal(Object.keys(env.files).length, n0, '複製を作る前に止める');
  assert.equal(all(env)[0].parent, env.props.APP_BACKUP_FOLDER_ID, '前のバックアップはそのまま');
}

// ==== 7. バックアップ: 関係ないものは触らない・移せなければ例外（ゴミ箱の代わりはしない）・やり直せる ====
{
  const env = setUpEnv();
  const backupFolder = env.run(`DriveApp.getFolderById(appProps_().getProperty(APP_PROP.backupFolderId))`);
  env.run(`__bf.createFile('メモ.txt', '中身')`, { __bf: backupFolder });
  env.call('apiRunBackup()');
  all(env)[0].trashed = true;   // ゴミ箱にある同じ名まえの古いもの
  for (let i = 0; i < 15; i++) env.call('apiRunBackup()');
  assert.equal(all(env).filter((f) => f.parent === env.props.APP_BACKUP_FOLDER_ID && !f.trashed).length, 14, '新しい 14 世代を残す');
  const memo = Object.values(env.files).find((f) => f.name === 'メモ.txt');
  assert.deepEqual([memo.parent, memo.trashed], [env.props.APP_BACKUP_FOLDER_ID, false], '関係ないファイルはそのまま');
  const gone = all(env).filter((f) => f.trashed);
  assert.equal(gone.length, 1, 'もともとゴミ箱のものはそのまま（一覧に出るが対象外）');
  assert.equal(all(env).filter((f) => f.parent === env.props.APP_ARCHIVE_FOLDER_ID).length, 1, '15 世代のうち新しい 14 を残して 1 つをアーカイブへ');
}
{
  const env = setUpEnv();
  for (let i = 0; i < 14; i++) env.call('apiRunBackup()');   // ちょうど上限。次の 1 回で最古がアーカイブへ移る
  const oldest = all(env)[0];
  const orig = oldest.moveTo;
  oldest.moveTo = () => { throw new Error('move failed'); };
  assert.throws(() => env.call('apiRunBackup()'), /move failed/);
  assert.equal(oldest.trashed, false, '移せなくてもゴミ箱には送らない');
  assert.equal(oldest.parent, env.props.APP_BACKUP_FOLDER_ID, '元の場所のまま');
  oldest.moveTo = orig;
  env.call('apiRunBackup()');
  assert.equal(env.files[oldest.id].parent, env.props.APP_ARCHIVE_FOLDER_ID, 'やり直せば、同じものが同じ ID でアーカイブへ移る');
}

// ==== 8. 毎日の処理: バックアップが失敗しても手入れと知らせは動き、最後に失敗を投げ直す ====
{
  const env = setUpEnv();
  env.call('apiEnableBackup()');
  const uid = env.triggers[0].uid;
  delete env.sheetsById[env.props.APP_DATA_SPREADSHEET_ID];   // データ本体が開けない → バックアップは失敗
  env.as('');
  assert.throws(() => env.call(`triggerDailyBackup({ triggerUid: '${uid}' })`));
  const last = env.audit().slice(-1)[0];
  assert.deepEqual([last.action, last.result], ['BACKUP.DAILY', 'FAILED'], '失敗は記録に残る');
  assert.ok(env.runLog().some((r) => r.kind === 'HOUSEKEEPING'), '手入れは動かす');
  assert.ok(env.state.mail.length >= 1, '異常を知らせる');
  assert.ok(env.state.mail.every((m) => m.subject === SUBJECT));
  assert.ok(env.runLog().some((r) => r.kind === 'MAINTENANCE.NOTIFY'));
}

// ==== 9. 毎日の処理: 手入れが失敗してもバックアップの結果は返し、知らせは届く ====
{
  const env = setUpEnv();
  env.run(`appHousekeeping_ = function () { throw new Error('hk boom'); }`);
  const r = daily(env);
  assert.ok(r.backup.backup, 'バックアップは成功のまま返す');
  assert.match(r.housekeeping.error, /hk boom/);
  assert.equal(r.notify.status, 'SENT');
  assert.equal(env.state.mail.length, 1);
  assert.ok(env.state.mail[0].body.includes('手入れ'));
  assert.equal(env.state.lockHeld, false);
}

// ==== 10. 改名（2026-10-06）の前の名前で作ったバックアップと月次の写しも数える（今あるファイルは同じ ID のまま改名した） ====
{
  const env = setUpEnv();
  const J = (x) => (typeof x === 'string' ? JSON.parse(x) : x);
  const ym = env.run(`Utilities.formatDate(new Date(), APP_TZ, 'yyyy-MM')`);
  env.run(`DriveApp.getFileById(__d).makeCopy('売上予測アプリ データ バックアップ 2026-10-01 0300', DriveApp.getFolderById(__b))`,
    { __d: env.props.APP_DATA_SPREADSHEET_ID, __b: env.props.APP_BACKUP_FOLDER_ID });
  env.run(`DriveApp.getFileById(__d).makeCopy('売上予測アプリ データ 月次 ' + __ym, DriveApp.getFolderById(__a))`,
    { __d: env.props.APP_DATA_SPREADSHEET_ID, __a: env.props.APP_ARCHIVE_FOLDER_ID, __ym: ym });
  const st = J(env.run('appBackupStatus_()'));
  assert.deepEqual([st.count, st.latest], [1, '売上予測アプリ データ バックアップ 2026-10-01 0300'], '前の名前の世代も数える');
  assert.equal(env.run('appMonthlyBackup_()'), '', '前の名前で今月の写しがあれば作らない');
  const r = daily(env);
  assert.ok(r.backup.backup.startsWith('Trends2Targets_Data_Backup_'), '新しい世代は新しい名前');
  assert.equal(J(env.run('appBackupStatus_()')).count, 2, '前の名前と新しい名前の世代を合わせて数える');
  assert.equal(Object.values(env.files).filter((f) => f.kind === 'file' && f.parent === env.props.APP_ARCHIVE_FOLDER_ID && /Monthly_|月次/.test(f.name)).length, 1, '月次の写しは増えない');
}
// ==== 11. 2026-10-06〜07 の間の名前（「Trends2Targets データ …」）で作ったものも数える ====
{
  const env = setUpEnv();
  const J = (x) => (typeof x === 'string' ? JSON.parse(x) : x);
  const ym = env.run(`Utilities.formatDate(new Date(), APP_TZ, 'yyyy-MM')`);
  env.run(`DriveApp.getFileById(__d).makeCopy('Trends2Targets データ バックアップ 2026-10-07 0300', DriveApp.getFolderById(__b))`,
    { __d: env.props.APP_DATA_SPREADSHEET_ID, __b: env.props.APP_BACKUP_FOLDER_ID });
  env.run(`DriveApp.getFileById(__d).makeCopy('Trends2Targets データ 月次 ' + __ym, DriveApp.getFolderById(__a))`,
    { __d: env.props.APP_DATA_SPREADSHEET_ID, __a: env.props.APP_ARCHIVE_FOLDER_ID, __ym: ym });
  assert.equal(J(env.run('appBackupStatus_()')).count, 1, '間の名前の世代も数える');
  assert.equal(env.run('appMonthlyBackup_()'), '', '間の名前で今月の写しがあれば作らない');
  assert.equal(env.run('APP_FILES.backupPrefix + "|" + APP_FILES.data + "|" + APP_FILES.logPrefix + "FY2026"'), 'Trends2Targets_Data_Backup_|Trends2Targets_Data|Trends2Targets_Logs_FY2026',
    '新しい名前は名前の決まり（アプリ名_役割。Drive の今のファイル名と同じ形）');
}

console.log('app-maintenance: all tests passed');
