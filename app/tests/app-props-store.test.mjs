#!/usr/bin/env node
/*
 * app-props-store.test.mjs — 値の置き場（Store.js の appProps_。2026-10-13）。
 * 所有者がエディタで書く値（OWNER_TASK・止めるスイッチ）と、初期設定で決まる ID は Script Properties に、
 * アプリが動くたびに書き換える状態（監査の鎖の最新ハッシュ・処理の記録・保存の控え・手入れの結果など）は所有者の UserProperties に置く。
 * 一度だけの移し替え（Script Properties にある状態を UserProperties へ写してから消す。ロックの中）と、
 * ほかのファイルが PropertiesService を直接呼ばないことも確かめる。GAS のモックの上で確かめるだけ。
 *
 *   node app/tests/app-props-store.test.mjs
 */
import assert from 'node:assert/strict';
import { OWNER, setUpEnv, makeEnv, sources, J } from './gas-mock.mjs';

/** Script Properties に置いてよいキー（初期設定で決まる ID と社内のドメイン。ほかは APP_ で始まらない所有者のキー） */
const SCRIPT_IDS = ['APP_FOLDER_ID', 'APP_DATA_SPREADSHEET_ID', 'APP_BACKUP_FOLDER_ID', 'APP_ARCHIVE_FOLDER_ID', 'APP_INTERNAL_DOMAIN'];
const inScript = (k) => !k.startsWith('APP_') || SCRIPT_IDS.includes(k);
/** 置き場が正しいか: Script Properties にアプリの状態が無く、UserProperties に所有者のキー・ID が無い */
function placed(env, label) {
  const wrongScript = Object.keys(env.scriptProps).filter((k) => !inScript(k));
  const wrongUser = Object.keys(env.userProps).filter((k) => inScript(k));
  assert.deepEqual(wrongScript, [], label + ': Script Properties にアプリの状態を置かない');
  assert.deepEqual(wrongUser, [], label + ': UserProperties に所有者のキー・ID を置かない');
}
const runLogs = (env, kind) => env.runLog().filter((r) => r.kind === kind);

// ==== 1. 振り分け: アプリと同じ規則（APP_ で始まらないキーと 5 つの ID は Script Properties、ほかの APP_ は UserProperties） ====
{
  const env = setUpEnv();
  for (const k of ['OWNER_TASK', 'OWNER_TASK_RESULT', 'AUTO_RESEARCH_ENABLED', 'BACKUP_AUTO_ENABLE', ...SCRIPT_IDS]) {
    assert.equal(env.run(`appPropsInScript_(__k)`, { __k: k }), true, k);
  }
  for (const k of ['APP_AUDIT_LAST_HASH', 'APP_WRITE_JOURNAL', 'APP_JOB_JOB-1', 'APP_STAGE_MS', 'APP_HOUSEKEEPING', 'APP_AUTO_RESEARCH', 'APP_AUTO_RESEARCH_CHECKED',
    'APP_BACKUP_STATUS', 'APP_BACKUP_AUTO_CHECKED', 'APP_MAINTENANCE_NOTICES', 'APP_BACKFILLS', 'APP_V10_HIT_BACKFILL', 'APP_SCRATCH_STATE', 'APP_SCRATCH_OWNER',
    'APP_SCRATCH_SPREADSHEET_ID', 'APP_TABLES_VERSION', 'APP_LOG_SPREADSHEETS_JSON', 'APP_FY_NAMING', 'APP_MIGRATE_BACKUP_FAILED_AT', 'APP_PROPS_MOVED', 'APP_NEW_STATE']) {
    assert.equal(env.run(`appPropsInScript_(__k)`, { __k: k }), false, k);
  }
  // 初期設定の後: ID は Script Properties、鎖のハッシュ・ログのファイル・表の版は UserProperties
  placed(env, '初期設定の後');
  for (const k of SCRIPT_IDS) assert.ok(env.scriptProps[k], 'Script Properties に ' + k);
  for (const k of ['APP_AUDIT_LAST_HASH', 'APP_LOG_SPREADSHEETS_JSON', 'APP_TABLES_VERSION', 'APP_FY_NAMING', 'APP_PROPS_MOVED']) assert.ok(env.userProps[k], 'UserProperties に ' + k);
  assert.equal(JSON.parse(env.userProps.APP_PROPS_MOVED).copied, 0, '新しい環境は写すものが無い');
  assert.equal(runLogs(env, 'PROPS.MOVE').length, 0, '写すものが無ければ記録しない');
}

// ==== 2. いろいろな操作の後も、置き場は正しい（裏の処理・保存の控え・バックアップ・手入れ・自動の調べ・所有者の操作） ====
{
  const env = setUpEnv();
  env.run('doGet({})');   // バックアップと自動の調べのトリガーを確かめる（控えを書く）
  env.call('apiSaveClient(__in)', { __in: { clientName: 'テスト製薬' } });
  assert.equal(env.runJob('SYSTEM.RECOVER', {}).status, 'DONE');
  env.call('apiRunBackup()');
  env.call('apiRunHousekeeping()');
  env.run(`appNotifyMaintenance_({ user: appCurrentUser_(), roles: [], actor: 'test', requestId: 'P1' }, ['ERRORS'])`);
  env.props.OWNER_TASK = JSON.stringify({ action: 'health' });
  assert.equal(env.call('apiOwnerTask()').ok, true);
  placed(env, '操作の後');
  assert.ok(Object.keys(env.userProps).some((k) => k.startsWith('APP_JOB_')), '処理の記録は UserProperties');
  for (const k of ['APP_HOUSEKEEPING', 'APP_BACKUP_STATUS', 'APP_BACKUP_AUTO_CHECKED', 'APP_AUTO_RESEARCH_CHECKED', 'APP_MAINTENANCE_NOTICES', 'APP_STAGE_MS']) {
    assert.ok(env.userProps[k], 'UserProperties に ' + k);
  }
  // 所有者の頼みと結果は Script Properties（エディタで書いて、エディタで読む）
  assert.ok(env.scriptProps.OWNER_TASK, 'OWNER_TASK は Script Properties');
  assert.ok(env.scriptProps.OWNER_TASK_RESULT, 'OWNER_TASK_RESULT は Script Properties');
  // 止めるスイッチは Script Properties から読む
  env.scriptProps.AUTO_RESEARCH_ENABLED = 'false';
  env.scriptProps.BACKUP_AUTO_ENABLE = 'false';
  assert.deepEqual([env.run('appAutoResearchEnabled_()'), env.run('appBackupAutoEnabled_()')], [false, false], '止めるスイッチは Script Properties');
  env.userProps.AUTO_RESEARCH_ENABLED = 'true';   // 間違った置き場の値は見ない
  delete env.scriptProps.AUTO_RESEARCH_ENABLED;
  assert.equal(env.run('appAutoResearchEnabled_()'), true);
  delete env.userProps.AUTO_RESEARCH_ENABLED;
  // まとめて読む形（getProperties・getKeys）は 2 つの置き場を合わせる。間違った置き場に残った古い値は見ない
  env.scriptProps.APP_STAGE_MS = '{"old":[1]}';
  const all = J(env.run('appProps_().getProperties()'));
  assert.equal(all.APP_STAGE_MS, env.userProps.APP_STAGE_MS, 'UserProperties の値を見る');
  assert.equal(all.APP_DATA_SPREADSHEET_ID, env.scriptProps.APP_DATA_SPREADSHEET_ID);
  assert.deepEqual(J(env.run('appProps_().getKeys()')).sort(), Object.keys(all).sort());
  assert.notEqual(env.run(`appProps_().getProperty('APP_STAGE_MS')`), '{"old":[1]}', '1 つずつ読むときも、間違った置き場は見ない');
  delete env.scriptProps.APP_STAGE_MS;
}

// ==== 3. 一度だけの移し替え: 前の版の置き方（全部 Script Properties）から、最初の操作で UserProperties へ ====
/** 前の版と同じ置き方にする: アプリの状態を全部 Script Properties へ戻し、移し替えの印を消す（その実行の印も戻す） */
function toOldLayout(env) {
  for (const k of Object.keys(env.userProps)) {
    if (k !== 'APP_PROPS_MOVED') env.scriptProps[k] = env.userProps[k];
    delete env.userProps[k];
  }
  env.run('APP_PROPS_MOVED_ = false');
}
{
  const env = setUpEnv();
  env.call('apiSaveClient(__in)', { __in: { clientName: 'テスト製薬' } });
  assert.equal(env.runJob('SYSTEM.RECOVER', {}).status, 'DONE');
  const before = Object.assign({}, env.userProps);
  delete before.APP_PROPS_MOVED;
  toOldLayout(env);
  assert.equal(Object.keys(env.userProps).length, 0);
  // 移し替えの途中で止まる（UserProperties に書けない）: Script Properties からは何も消さない
  const realUser = env.ctx.PropertiesService.getUserProperties;
  env.ctx.PropertiesService.getUserProperties = () => Object.assign(realUser(), { setProperties: () => { throw new Error('書けません（テスト）'); } });
  assert.throws(() => env.call('apiSaveClient(__in)', { __in: { clientName: 'ほか製薬' } }), /書けません/);
  env.ctx.PropertiesService.getUserProperties = realUser;
  assert.equal(env.state.lockHeld, false);
  for (const k of Object.keys(before)) assert.equal(env.scriptProps[k], before[k], '止まっても Script Properties に残る: ' + k);
  assert.equal(env.userProps.APP_PROPS_MOVED, undefined, '印は付けない（次の実行がやり直す）');
  // 次の操作で移す（ロックの中で）。監査の鎖は切れずに続く
  const locks = env.state.locks;
  env.run(`__orig = appPropsMove_; appPropsMove_ = function () { __depth = APP_LOCK_DEPTH_; return __orig(); }`);
  env.call('apiSaveClient(__in)', { __in: { clientName: 'ほか製薬' } });
  assert.equal(env.run('__depth'), 1, '移し替えはロックの中');
  assert.ok(env.state.locks > locks);
  placed(env, '移し替えの後');
  for (const k of Object.keys(before)) {
    if (k === 'APP_AUDIT_LAST_HASH' || k === 'APP_STAGE_MS' || k.startsWith('APP_JOB_')) assert.ok(env.userProps[k], k);
    else assert.equal(env.userProps[k], before[k], '同じ値を写す: ' + k);
  }
  for (const k of SCRIPT_IDS) assert.ok(env.scriptProps[k], 'ID は Script Properties に残す: ' + k);
  const v = env.call('apiVerifyAudit()');
  assert.deepEqual([v.ok, v.matchesLatest], [true, true], '監査の鎖は切れない: ' + JSON.stringify(v.months));
  const mv = runLogs(env, 'PROPS.MOVE');
  assert.equal(mv.length, 1, '移し替えを実行ログに残す（1 回だけ）');
  const d = JSON.parse(mv[0].detail_json);
  assert.deepEqual(d.copied.slice().sort(), Object.keys(before).sort(), '写したキーの名前');
  assert.ok(!mv[0].detail_json.includes(before.APP_AUDIT_LAST_HASH), '値は記録に残さない');
  // もう一度動かしても何もしない（印がある）。後から Script Properties に置かれた古い値は見ない
  env.run('APP_PROPS_MOVED_ = false');
  env.scriptProps.APP_AUDIT_LAST_HASH = 'f'.repeat(64);
  env.call('apiSaveClient(__in)', { __in: { clientName: '三つ目製薬' } });
  assert.equal(runLogs(env, 'PROPS.MOVE').length, 1, '移し替えは一度だけ');
  assert.equal(env.call('apiVerifyAudit()').matchesLatest, true, 'Script Properties の古いハッシュは使わない');
  delete env.scriptProps.APP_AUDIT_LAST_HASH;
}
{
  // 両方にあるキーは UserProperties の値を残し（前の移し替えが途中で止まった後に変わった値）、Script Properties の古い値だけ消す
  const env = setUpEnv();
  const hash = env.userProps.APP_AUDIT_LAST_HASH;
  toOldLayout(env);
  env.userProps.APP_AUDIT_LAST_HASH = hash;
  env.scriptProps.APP_AUDIT_LAST_HASH = 'stale';
  env.call('apiSaveClient(__in)', { __in: { clientName: 'テスト製薬' } });
  assert.equal(env.scriptProps.APP_AUDIT_LAST_HASH, undefined);
  assert.equal(env.call('apiVerifyAudit()').matchesLatest, true);
  placed(env, '両方にあったキー');
}
{
  // ロックを待つ間に、ほかの実行が移し替えを済ませた: 写し直さない
  const env = setUpEnv();
  toOldLayout(env);
  env.run(`__real = appWithLock_; appWithLock_ = function (fn) {
    // ロックを取る前に、ほかの実行が済ませた（印と値を UserProperties に置いた）
    const u = PropertiesService.getUserProperties(), s = PropertiesService.getScriptProperties();
    Object.keys(s.getProperties()).filter(k => !appPropsInScript_(k)).forEach(k => { u.setProperty(k, s.getProperty(k)); s.deleteProperty(k); });
    u.setProperty(APP_PROPS_MOVED_KEY, '{"other":true}');
    appWithLock_ = __real;
    return __real(fn);
  }`);
  env.call('apiHome()');
  assert.equal(env.userProps.APP_PROPS_MOVED, '{"other":true}', 'ほかの実行の印のまま');
  assert.equal(runLogs(env, 'PROPS.MOVE').length, 0);
  placed(env, 'ほかの実行が済ませた');
}
{
  // 初期設定をしたのと別のアカウントで動いた（UserProperties が空で、写すものも無い）: 空の状態で進まず、何も書かずに止める
  const env = setUpEnv();
  env.call('apiSaveClient(__in)', { __in: { clientName: 'テスト製薬' } });
  const userBefore = Object.assign({}, env.userProps);
  const scriptBefore = Object.assign({}, env.scriptProps);
  const sheets = Object.keys(env.sheetsById).length;
  const audits = env.audit().length;
  for (const k of Object.keys(env.userProps)) delete env.userProps[k];   // 別のアカウントの置き場（空）
  env.run('APP_PROPS_MOVED_ = false');
  assert.throws(() => env.call('apiSaveClient(__in)', { __in: { clientName: 'ほか製薬' } }), /この実行のアカウントには、アプリの状態.*がありません/);
  assert.deepEqual(env.userProps, {}, '印も付けない（空の状態で始めない）');
  assert.deepEqual(env.scriptProps, scriptBefore, 'Script Properties は変えない');
  assert.equal(Object.keys(env.sheetsById).length, sheets, 'ログのファイルをもう 1 つ作らない');
  // 元のアカウントに戻れば、そのまま続く（鎖も切れない）
  Object.assign(env.userProps, userBefore);
  env.run('APP_PROPS_MOVED_ = false');
  env.call('apiSaveClient(__in)', { __in: { clientName: 'ほか製薬' } });
  assert.ok(env.audit().length > audits);
  assert.deepEqual([env.call('apiVerifyAudit()').ok, env.call('apiVerifyAudit()').matchesLatest], [true, true]);
}
{
  // 初期設定の前の新しい環境: 何も写さずに印だけ付ける。初期設定もそのまま動く
  const env = makeEnv();
  env.as(OWNER);
  env.call('apiSetup()');
  placed(env, '新しい環境');
  assert.ok(env.userProps.APP_PROPS_MOVED);
}

// ==== 4. ほかのファイルは PropertiesService を直接呼ばない（読み書きの入口は Store.js の appProps_ だけ） ====
{
  const direct = Object.keys(sources).filter((n) => n !== 'Store.js' && n !== 'LegacyEngine.js' && /PropertiesService\s*\.\s*get/.test(sources[n]));
  assert.deepEqual(direct, [], 'PropertiesService を直接呼ぶファイル');
  // 旧来の計算に渡すのは偽の PropertiesService（Engine.js の appLegacyServices_。本物の置き場には触らせない）
  assert.match(sources['Engine.js'], /getUserProperties: \(\) => \{ throw new Error\('旧来の計算からは User Properties を使いません。'\); \}/);
}

console.log('app-props-store: all tests passed');
