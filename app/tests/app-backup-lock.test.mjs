#!/usr/bin/env node
/*
 * app-backup-lock.test.mjs — バックアップの写しを、保存と同じロックの中で取る（Backup.js の appCopyDataBook_。2026-10-13）。
 * 写す前に書きかけの保存（控え。Journal.js）を書き終える・書き終えられなければ写さない（前の世代はそのまま）・
 * 月次の写しも同じ・表の列を足す移行の前の写しだけは書きかけでも写す・控えを書き終えた印を外す前にシートへ反映する、を確かめる。
 * GAS のモックの上で確かめるだけ。
 *
 *   node app/tests/app-backup-lock.test.mjs
 */
import assert from 'node:assert/strict';
import { OWNER, setUpEnv } from './gas-mock.mjs';

const CTX = `{ user: appCurrentUser_(), roles: [], actor: '${OWNER}', requestId: 'B1' }`;
const isBackup = (f) => f.kind === 'file' && f.name.startsWith('Trends2Targets_Data_Backup_');
const isMonthly = (f) => f.kind === 'file' && f.name.startsWith('Trends2Targets_Data_Monthly_');
const filesOf = (env, test) => Object.values(env.files).filter(test);
/** データ本体の写しを作った時に、ロックを持っていたか・書きかけの印があったかを控える */
function watchCopies(env) {
  const seen = [];
  const data = env.files[env.props.APP_DATA_SPREADSHEET_ID];
  const orig = data.makeCopy;
  data.makeCopy = (...a) => { seen.push({ lock: env.state.lockHeld, journal: env.props.APP_WRITE_JOURNAL || null, name: a[0] }); return orig(...a); };
  return seen;
}
/** 書きかけの保存の控えを置く（メンバーを 1 人足す保存が、書く前に止まった）。fileId を 'missing' にすると読めない控え */
function pendingSave(env, email, fileId) {
  const body = JSON.stringify({ id: 'JNL-T', label: 'テストの保存', planId: '', actor: OWNER, createdAt: '2026-10-13T03:00:00+0900',
    ops: [{ table: 'MEMBERS', mode: 'ensure', rows: [{ email, display_name: 'T', department: '', is_active: 'true', note: '', created_at: '', created_by: '', updated_at: '', updated_by: '', row_version: '1' }] }] });
  const id = fileId || env.run('DriveApp.getFolderById(__f).createFile("Trends2Targets_Journal_JNL-T.json", __b, MimeType.PLAIN_TEXT).getId()', { __f: env.props.APP_FOLDER_ID, __b: body });
  env.run('appProps_().setProperty(APP_JOURNAL_PROP, __v)', { __v: JSON.stringify({ id: 'JNL-T', fileId: id, label: 'テストの保存', planId: '', at: '2026-10-13T03:00:00+0900' }) });
  return id;
}
/** 写しのブックの、表の行（メールの列） */
const copiedEmails = (env, file) => env.sheetsById[file.id].getSheetByName('MEMBERS').rows.slice(1).map((r) => r && r[0]).filter(Boolean);

// ==== 1. 毎日のバックアップ・所有者のバックアップは、ロックの中で反映（flush）してから写す ====
{
  const env = setUpEnv();
  const seen = watchCopies(env);
  const flushes = [];
  const origFlush = env.ctx.SpreadsheetApp.flush;
  env.ctx.SpreadsheetApp.flush = () => { flushes.push(env.state.lockHeld); return origFlush(); };
  env.call('apiRunBackup()');
  assert.deepEqual(seen.map((s) => s.lock), [true], '写しはロックの中で取る');
  assert.ok(flushes.length >= 1 && flushes.every(Boolean), '反映もロックの中');
  env.call('apiEnableBackup()');
  const uid = env.triggers.find((t) => t.handler === 'triggerDailyBackup').uid;
  env.as('');
  env.call(`triggerDailyBackup({ triggerUid: '${uid}' })`);
  env.fireTriggers('triggerRunJob');   // 手入れ（月次の写し）は数分後の裏の処理
  env.as(OWNER);
  assert.deepEqual(seen.map((s) => [s.lock, /Monthly/.test(s.name)]), [[true, false], [true, false], [true, true]], '毎日のトリガーも、手入れの月次の写しも同じ');
  assert.equal(env.state.lockHeld, false);
  env.ctx.SpreadsheetApp.flush = origFlush;
}

// ==== 2. 書きかけの保存があれば、写す前に書き終える（写しは書き終えた後の中身） ====
{
  const env = setUpEnv();
  const seen = watchCopies(env);
  const jnl = pendingSave(env, 'pending@bigm2y.com');
  const r = env.call('apiRunBackup()');
  assert.deepEqual(r.recovered, { journalId: 'JNL-T', label: 'テストの保存' }, '書き終えた保存を返す');
  assert.deepEqual(seen.map((s) => [s.lock, s.journal]), [[true, null]], '写す時には書きかけの印が無い');
  assert.equal(env.run('appJournalPending_()'), null);
  assert.ok(env.table('MEMBERS').some((m) => m.email === 'pending@bigm2y.com'), 'データ本体は控えのとおり');
  assert.ok(copiedEmails(env, filesOf(env, isBackup)[0]).includes('pending@bigm2y.com'), '写しも書き終えた後の中身');
  assert.ok(env.runLog().some((x) => x.kind === 'JOURNAL.RECOVER'), '書き終えたことを実行ログに残す');
  assert.equal(env.files[jnl].trashed, true, '書き終えた控えのファイルは今までどおりゴミ箱へ（一時的な制御用のファイル。「消さない」の対象外）');
}

// ==== 3. 書き終えられない（控えが読めない）ときは写さない。前の世代はそのまま・印も残る・直れば取れる ====
{
  const env = setUpEnv();
  env.call('apiRunBackup()');
  const before = filesOf(env, isBackup).map((f) => [f.id, f.parent]);
  const seen = watchCopies(env);
  pendingSave(env, 'x@bigm2y.com', 'missing');
  assert.throws(() => env.call('apiRunBackup()'), /保存が途中で止まっていて（テストの保存）、続きを書けません。.*写しを取りませんでした/);
  assert.equal(seen.length, 0, '写しを作らない');
  assert.deepEqual(filesOf(env, isBackup).map((f) => [f.id, f.parent]), before, '前の世代はそのまま（移しも消しもしない）');
  assert.ok(env.run('appJournalPending_()'), '書きかけの印は残す');
  assert.equal(env.state.lockHeld, false);
  // 毎日のトリガーでも同じ: バックアップの失敗として残り、異常を知らせる
  env.call('apiEnableBackup()');
  const uid = env.triggers.find((t) => t.handler === 'triggerDailyBackup').uid;
  env.as('');
  assert.throws(() => env.call(`triggerDailyBackup({ triggerUid: '${uid}' })`), /写しを取りませんでした/);
  env.as(OWNER);
  assert.equal(seen.length, 0);
  assert.ok(env.state.mail.some((m) => m.body.includes('バックアップ')), 'バックアップの失敗を知らせる');
  // 表の列を足す移行の前の写しだけは、書きかけでも写す（移行は見出しに列を足すだけ。控えは移行の後に書き終える）
  const m = env.call(`appBackup_(${CTX}, { allowPending: true })`);
  assert.equal(seen.length, 1);
  assert.deepEqual(m.journalPending, { id: 'JNL-T', label: 'テストの保存', planId: '', at: '2026-10-13T03:00:00+0900' }, '書きかけのまま写したことを返す');
  // 控えを片づければ、ふつうに取れる
  env.run('appProps_().deleteProperty(APP_JOURNAL_PROP)');
  env.call('apiRunBackup()');
  assert.equal(seen.length, 2);
}

// ==== 4. 月次の写しも同じ: ロックの中・書き終えられなければ作らず、次の日の手入れでもう一度試す ====
{
  const env = setUpEnv();
  const seen = watchCopies(env);
  pendingSave(env, 'y@bigm2y.com', 'missing');
  const hk = env.call('apiRunHousekeeping()');
  assert.match(hk.steps.monthly.error, /写しを取りませんでした/);
  assert.ok(hk.problems.some((p) => /^monthly: /.test(p)), '手入れの要確認に出す');
  assert.equal(filesOf(env, isMonthly).length, 0, '月次の写しを作らない');
  env.run('appProps_().deleteProperty(APP_JOURNAL_PROP)');
  const hk2 = env.call('apiRunHousekeeping()');
  assert.ok(hk2.steps.monthly.created, '直れば作る');
  assert.deepEqual(seen.map((s) => s.lock), [true], '月次の写しもロックの中');
  const jnl = pendingSave(env, 'z@bigm2y.com');
  void jnl;
  assert.equal(env.call('apiRunHousekeeping()').steps.monthly.created, '', '同じ月に 2 つ目は作らない（書きかけがあっても写さない）');
  env.run('appWithLock_(() => appJournalRecover_({ requestId: "t" }))');
}

// ==== 5. 保存の控えを書き終えた印は、書いた表をシートへ反映（flush）してから外す ====
{
  const env = setUpEnv();
  pendingSave(env, 'w@bigm2y.com');
  const at = [];
  const origFlush = env.ctx.SpreadsheetApp.flush;
  env.ctx.SpreadsheetApp.flush = () => { at.push(env.props.APP_WRITE_JOURNAL ? 'pending' : 'cleared'); return origFlush(); };
  env.run('appWithLock_(() => appJournalRecover_({ requestId: "t" }))');
  env.ctx.SpreadsheetApp.flush = origFlush;
  assert.equal(at[0], 'pending', '印を外す前に反映する');
  assert.equal(env.run('appJournalPending_()'), null);
}

console.log('app-backup-lock: all tests passed');
