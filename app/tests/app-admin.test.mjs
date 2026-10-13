/**
 * app-admin.test.mjs — 毎日の手入れ・監査の鎖の全期間の確かめ・ログの画面。
 */
import assert from 'node:assert/strict';
import { setUpEnv } from './gas-mock.mjs';

const env = setUpEnv();
env.task('saveClient(__in)', { __in: { clientName: 'テスト製薬' } });   // 監査に何行か残す

// ==== 1. 鎖を全部の月で確かめる ====
let v = env.task('verifyAudit()');
assert.equal(v.ok, true, JSON.stringify(v.months));
assert.equal(v.months.length, 1);
assert.ok(v.rows >= 2);
assert.equal(v.matchesLatest, true);

// 書き換えると見つかる
const sh = env.auditSheet();
const keep = sh.rows[2].slice();
sh.rows[2][env.run('APP_LOG_TABLES.AUDIT').indexOf('actor_email')] = 'someone-else@bigm2y.com';
v = env.task('verifyAudit()');
assert.equal(v.ok, false);
assert.match(v.months[0].note, /鎖が切れている/);
sh.rows[2] = keep;
assert.equal(env.task('verifyAudit()').ok, true, '元に戻すと正しい');

// 締めの控えと違えば見つかる（切り詰め・書き換えの疑い）
const month = v.months[0].month;
env.run(`appInsertRows_('AUDIT_ANCHORS', [{ month: '${month}', rows: '1', first_prev: '', last_hash: 'x', anchored_at: '', anchored_by: '' }])`);
v = env.task('verifyAudit()');
assert.equal(v.ok, false);
assert.match(v.months[0].note, /締めの控え/);
env.run(`appReplaceWhole_('AUDIT_ANCHORS', [])`);

// 毎日の確かめ（速い方）: 控えのある前の月は、端の行だけ見る。端の値は全部の行で確かめたときと同じ
const ends = env.run(`(() => { const sh = appAuditSheets_('AUDIT')[0].sheet; const f = appVerifyAuditSheet_(sh), e = appAuditSheetEnds_(sh); return [f.rows === e.rows, f.firstPrev === e.firstPrev, f.lastHash === e.lastHash, e.ok]; })()`);
assert.equal(JSON.stringify(ends), '[true,true,true,true]');
assert.equal(env.run('appVerifyAuditAll_(true).ok'), true);

// ==== 2. 毎日の手入れ: 月次のバックアップ（月に 1 つ）・古いログはアーカイブへ・結果を状態に出す ====
// 3 年前の年度のログのファイルがある
const oldLog = env.run(`(() => { const ss = SpreadsheetApp.create('old log'); const p = appProps_(); const f = JSON.parse(p.getProperty(APP_PROP.logFiles)); f['FY' + (appFy_(new Date()) - 3)] = ss.getId(); p.setProperty(APP_PROP.logFiles, JSON.stringify(f)); return ss.getId(); })()`);
const hk = env.task('runHousekeeping()');
assert.equal(hk.ok, true, JSON.stringify(hk.problems));
assert.ok(hk.steps.monthly.created, '月次のバックアップを作る');
assert.deepEqual(hk.steps.archive.moved, ['FY' + (env.run('appFy_(new Date())') - 3)]);
const archiveId = env.run('appProps_().getProperty(APP_PROP.archiveFolderId)');
assert.equal(env.files[oldLog].parent, archiveId, '古いログはアーカイブのフォルダに移る（消さない）');
assert.equal(env.files[oldLog].trashed, false);
const hk2 = env.task('runHousekeeping()');
assert.equal(hk2.steps.monthly.created, '', '同じ月に 2 つ目は作らない');
// データ本体の表を整える: 使っていない空の行を減らす（値は変えない）
assert.ok(hk.steps.dataBook.sheets > 10);
const big = env.data().getSheetByName('MEMBERS');
const rowsBefore = env.table('MEMBERS').length;
big.insertRowsAfter(big.getMaxRows(), 5000);
const hk3 = env.task('runHousekeeping()');
assert.ok(hk3.steps.dataBook.trimmedRows >= 4000, '空の行を減らす: ' + hk3.steps.dataBook.trimmedRows);
assert.equal(env.table('MEMBERS').length, rowsBefore, '行の中身はそのまま');
const health = env.task('health()');
assert.equal(health.housekeeping.ok, true);
assert.ok(health.backup.keep > 0);

// ==== 3. ログの画面: 種類と月を選ぶ。実行ログに手入れが残る ====
const runs = env.task('listAudit(__in)', { __in: { kind: 'RUN' } });
assert.ok(runs.rows.some((r) => r.kind === 'HOUSEKEEPING'));
assert.equal(runs.months.length, 1);
const audits = env.task('listAudit(__in)', { __in: { kind: 'AUDIT', query: 'テスト製薬' } });
assert.ok(audits.rows.length >= 1 && audits.rows.every((r) => JSON.stringify(r).includes('テスト製薬')));
assert.ok(env.task('listAudit(__in)', { __in: { kind: 'AUDIT' } }).rows.some((r) => r.action === 'AUDIT.VERIFY'), '確かめたことも記録に残る');
console.log('app-admin: all tests passed');
