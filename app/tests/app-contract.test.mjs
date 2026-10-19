#!/usr/bin/env node
/*
 * app-contract.test.mjs — Trends2Targets（段階1: 土台）の契約テスト。
 * app/src の *.js を GAS のモックの上で vm 実行し、入口・権限・記録・保存・バックアップの約束を確かめる。
 * GAS 上での実行の代わりではない（最終確認は GAS 側で行う）。
 *
 *   node app/tests/app-contract.test.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {
  appDir, srcDir, repoRoot, srcNames, sources, uiHtml, OWNER, MEMBER, OTHER, OUTSIDER,
  sha, J, fmtDate, jstDay, FY, MONTH, extractFunction, makeEnv, setUpEnv,
} from './gas-mock.mjs';

const manifest = JSON.parse(await readFile(path.join(srcDir, 'appsscript.json'), 'utf8'));

/**
 * 画面（ブラウザ）から呼べる関数。足すときはここにも足す。
 * 管理の操作（メンバー・役割・メーカー・設定・記録と状態・バックアップ・手入れ・事前分布・計画の候補・年度の確認）は、2026-10-13 に入口を外した
 * （所有者が apiOwnerTask で動かす。所有者でない管理者もブラウザのコンソールから呼べたため）。所有者がエディタで動かす apiSetup・apiAuthorizeAi・apiOwnerTask は残す
 */
const PUBLIC = ['doGet', 'apiSetup', 'apiAuthorizeAi', 'apiOwnerTask',
  'apiStartJob', 'apiJobStatus', 'apiListPlans', 'apiPortfolio', 'apiHome', 'apiVersionList', 'apiVersionSubmit', 'apiVersionDecide',
  'apiForecastBasis', 'apiLearningView', 'apiForecastLatest', 'apiPlanView',
  'apiForecastPage',
  'apiCrossMaker', 'apiPeopleLearning', 'apiAiLearning',
  'apiBudgetProposal',
  'triggerDailyBackup', 'triggerRunJob', 'triggerAutoResearch'];
/** 外した管理の入口（もう置かない。所有者の操作の名前で動かす） */
const REMOVED = ['apiBootstrap', 'apiListDirectory', 'apiSaveMember', 'apiGrantRole', 'apiRevokeRole', 'apiSaveClientName', 'apiSaveClient',
  'apiListSettings', 'apiSaveSetting', 'apiListAudit', 'apiVerifyAudit', 'apiRunHousekeeping', 'apiHealth', 'apiEnableBackup', 'apiRunBackup',
  'apiPoolPreview', 'apiPlanCandidates', 'apiYearPreview'];
/** 旧来の計算をそのまま包んだ自動生成のファイル（中の関数は外から呼べない。中身は app-engine.test.mjs が確かめる） */
const WRAPPED = ['LegacyEngine.js'];

const TODAY = jstDay(0);
const YESTERDAY = jstDay(-1);
const TOMORROW = jstDay(1);
const tables = makeEnv().run('APP_TABLES');
const auditCols = makeEnv().run('APP_LOG_TABLES.AUDIT');

// ==== 1. 入口の一覧（ブラウザから呼べる関数を増やさない） ====
{
  for (const n of srcNames) assert.match(n, /^(appsscript\.json|[A-Za-z][A-Za-z0-9]*\.(js|html))$/, `src に置けるのは GAS のファイルだけ: ${n}`);
  assert.deepEqual(srcNames.filter((n) => n.endsWith('.html')), ['UI.html']);
  const declared = [];
  for (const [file, src] of Object.entries(sources)) {
    if (WRAPPED.includes(file)) { declared.push({ file, name: 'appLegacyEngine_' }); continue; }
    for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm)) declared.push({ file, name: m[1] });
    assert.doesNotMatch(src, /^(?:var|let|const)\s+[A-Za-z0-9_$]+\s*=\s*(?:async\b|function\b|\([^)]*\)\s*=>|[A-Za-z0-9_$]+\s*=>)/m,
      `${file}: トップレベルで関数を変数に入れない（入口が増える）`);
  }
  const pub = declared.filter((d) => !d.name.endsWith('_'));
  assert.deepEqual(pub.map((d) => d.name).sort(), [...PUBLIC].sort(), '公開する関数は一覧のものだけ（ほかは名前の末尾を _ にする）');
  // 実際に読み込んだ後のグローバルでも確かめる（関数の中に包んだコードは外から呼べない）
  const probe = makeEnv();
  const globalFns = Object.keys(probe.ctx).filter((k) => typeof probe.ctx[k] === 'function');
  assert.deepEqual(globalFns.filter((k) => !k.endsWith('_')).sort(), [...PUBLIC].sort(), '読み込んだ後に外から呼べる関数も一覧のものだけ');
  assert.ok(pub.every((d) => d.file === 'Api.js'), '公開する関数は Api.js にだけ置く');
  const names = declared.map((d) => d.name);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], '同じ名前の関数がない（GAS では黙って上書きされる）');
  // 外した管理の入口は、どこにも無く・画面からも呼ばない。同じ操作は所有者の操作（apiOwnerTask）に、同じ操作の名前である
  for (const n of REMOVED) {
    assert.ok(!names.includes(n), `${n} は置かない`);
    assert.ok(!new RegExp('\\b' + n + '\\b').test(uiHtml), `画面は ${n} を呼ばない`);
  }
  const ownerNames = probe.run('Object.keys(APP_OWNER_ACTIONS).map(k => APP_OWNER_ACTIONS[k].name).filter(Boolean)');
  for (const a of ['DIRECTORY.LIST', 'MEMBER.SAVE', 'ROLE.GRANT', 'ROLE.REVOKE', 'CLIENT.NAME', 'CLIENT.SAVE', 'SETTINGS.LIST', 'SETTING.SAVE', 'AUDIT.LIST',
    'AUDIT.VERIFY', 'HOUSEKEEPING.RUN', 'HEALTH.CHECK', 'BACKUP.ENABLE', 'BACKUP.RUN', 'POOL.PREVIEW', 'PLAN.CANDIDATES', 'YEAR.PREVIEW']) {
    assert.ok(ownerNames.includes(a), `所有者の操作に ${a} がある`);
  }
  for (const name of PUBLIC.filter((n) => n !== 'doGet')) {
    const body = extractFunction(sources['Api.js'], name);
    assert.ok(body.slice(body.indexOf('{') + 1).trim().startsWith('return api_('), `${name} は api_ だけを通す`);
  }
  assert.match(extractFunction(sources['Api.js'], 'doGet'), /api_\('APP\.OPEN', \{ minRole: 'VIEWER', audit: false, allowAnonymousView: true \}/);
  // 業務のコードは SpreadsheetApp を Store / Audit / Setup の外で触らない
  for (const [file, src] of Object.entries(sources)) {
    if (!['Store.js', 'Audit.js', 'Setup.js', 'Backup.js', 'Engine.js', 'Migrate.js', 'Parity.js', 'Legacy.js', ...WRAPPED].includes(file)) assert.doesNotMatch(src, /SpreadsheetApp\./, `${file} は保存の層を通す`);
  }
}

// ==== 2. マニフェスト（段階1 は所有者だけが開ける） ====
{
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.equal(manifest.timeZone, 'Asia/Tokyo');
  assert.deepEqual(manifest.webapp, { executeAs: 'USER_DEPLOYING', access: 'DOMAIN' },
    '社内公開（DOMAIN）。戻すときは MYSELF にして同じ deploy ID で再公開（RUNBOOK_domain_yearclose_JA.md）');
  // 外への問い合わせと Google Cloud は A-4 AI 調査（Vertex AI）のため（2026-10-03 村井さん承認）。
  // メールの送信は毎日の処理の異常を管理者へ知らせるため（2026-10-05 村井さん承認）
  assert.deepEqual([...manifest.oauthScopes].sort(), [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/script.scriptapp',
    'https://www.googleapis.com/auth/script.send_mail',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/userinfo.email',
  ]);
  const clasp = JSON.parse(await readFile(path.join(appDir, '.clasp.json'), 'utf8'));
  assert.equal(clasp.rootDir, 'src');
  const rootClasp = JSON.parse(await readFile(path.join(repoRoot, '.clasp.json'), 'utf8'));
  assert.notEqual(clasp.scriptId, rootClasp.scriptId, '旧アプリとは別のプロジェクト');
  assert.match(await readFile(path.join(repoRoot, '.claspignore'), 'utf8'), /^app\/\*\*$/m, '旧アプリの clasp push に app/ を含めない');
}

// ==== 3. 画面（テンプレートと呼び出し） ====
{
  const scriptlets = [...uiHtml.matchAll(/<\?([\s\S]*?)\?>/g)].map((m) => m[1].trim()).sort();
  assert.deepEqual(scriptlets, ['!= bootJson', '!= charsJs'], 'テンプレートで差し込むのは初期データとキャラの絵だけ');
  const called = new Set([...uiHtml.matchAll(/call\(\\?'([A-Za-z0-9_]+)\\?'/g)].map((m) => m[1]));
  assert.ok(called.size >= 10);
  for (const n of called) assert.ok(PUBLIC.includes(n) && n.startsWith('api'), `画面から呼ぶのは公開の入口だけ: ${n}`);
  // 画面が「読むだけ」として扱う入口は、サーバーでも記録しない読み取り
  const reads = Object.keys(JSON.parse(/var READS = (\{[^}]*\});/.exec(uiHtml)[1].replace(/(\w+):/g, '"$1":')));
  for (const n of reads) assert.match(extractFunction(sources['Api.js'], n), /audit: false/, `${n} は読むだけ`);
  for (const n of called) {
    // 初期設定は自分で記録し、処理の開始は裏で動く処理そのものが記録する
    if (!reads.includes(n) && !['apiSetup', 'apiStartJob'].includes(n)) assert.doesNotMatch(extractFunction(sources['Api.js'], n), /audit: false/, `${n} は書き込みなので記録する`);
  }
  // キャラの絵は assets/characters と同じ（cd assets/characters/src && python3 build.py で作り直す）
  const env = makeEnv();
  const charsJs = env.run('APP_UI_CHARS_JS');
  assert.ok(!charsJs.includes('<?') && !/<\/script/i.test(charsJs));
  const box = vm.createContext({});
  vm.runInContext(charsJs + '\n;globalThis.__c = { CHAR_SVG, YOMI_POSE };', box);
  const { CHAR_SVG, YOMI_POSE } = J(box.__c);
  for (const id of Object.keys(CHAR_SVG)) {
    assert.equal(CHAR_SVG[id], (await readFile(path.join(repoRoot, 'assets/characters/svg', id + '.svg'), 'utf8')).trim(), `${id} が assets と違う`);
  }
  assert.equal(Object.keys(CHAR_SVG).length, 10);
  assert.deepEqual(Object.keys(YOMI_POSE).sort(), ['discover', 'done', 'explain', 'guide', 'observe']);
  for (const k of Object.keys(YOMI_POSE)) {
    assert.equal(YOMI_POSE[k], (await readFile(path.join(repoRoot, 'assets/characters/yomi/svg', 'yomi_' + k + '.svg'), 'utf8')).trim(), `yomi_${k} が assets と違う`);
  }
  for (const k of ['guide', 'observe', 'explain', 'done']) assert.ok(uiHtml.includes('YOMI_POSE.' + k) || uiHtml.includes("'" + k + "'"), `画面で ${k} を使う`);
  assert.match(env.run('APP_FAVICON_URL'), /^data:image\/png;base64,[A-Za-z0-9+/=]+#favicon\.png$/);
}

// ==== 4. 初期設定（所有者だけ・何度実行しても同じ） ====
{
  const env = makeEnv();
  let boot = env.boot();
  assert.deepEqual([boot.setUp, boot.allowed, boot.user.isOwner, boot.user.isAdmin], [false, true, true, true]);
  assert.throws(() => env.task(`saveMember({ email: '${MEMBER}', displayName: 'M' })`), /初期設定がまだです/);
  env.as(MEMBER);
  assert.throws(() => env.call('apiSetup()'), /権限がありません/);
  assert.equal(Object.keys(env.files).length, 0, '所有者以外の初期設定では何も作らない');
  env.as(OWNER);
  const r1 = env.call('apiSetup()');
  const folders = Object.values(env.files).filter((f) => f.kind === 'folder');
  const sheetsFiles = Object.values(env.files).filter((f) => f.kind === 'file');
  assert.deepEqual(folders.map((f) => f.name).sort(), ['アーカイブ', 'バックアップ', 'Trends2Targets_System'].sort());
  const top = folders.find((f) => f.name === 'Trends2Targets_System');
  assert.equal(top.parent, 'ROOT');
  assert.ok(folders.filter((f) => f !== top).every((f) => f.parent === top.id), 'バックアップとアーカイブはシステムのフォルダの中');
  assert.deepEqual(sheetsFiles.map((f) => f.name).sort(), ['Trends2Targets_Data', 'Trends2Targets_Logs_' + FY].sort(), 'スプレッドシートはデータ本体と今年度のログの 2 つだけ');
  assert.ok(sheetsFiles.every((f) => f.parent === top.id));
  assert.equal(env.props.APP_INTERNAL_DOMAIN, 'bigm2y.com');
  assert.deepEqual(env.data().getSheets().map((s) => s.name).sort(), Object.keys(tables).sort(), 'データ本体は表のシートだけ（最初の空のシートは消す）');
  for (const [name, def] of Object.entries(tables)) assert.deepEqual([...env.data().getSheetByName(name).rows[0]], [...def.columns], `${name} の 1 行目は列名だけ`);
  const schema = env.table('_SCHEMA');
  assert.equal(schema.length, Object.keys(tables).length);
  for (const s of schema) {
    assert.equal(s.schema_version, String(env.run('APP_SCHEMA_VERSION')));
    assert.equal(s.columns_hash, sha(tables[s.table].columns.join('|')));
  }
  assert.deepEqual(env.table('MEMBERS').map((m) => [m.email, m.is_active, m.row_version]), [[OWNER, 'TRUE', '1']]);
  assert.deepEqual(env.log().getSheets().map((s) => s.name), ['AUDIT_' + MONTH], 'ログは月ごとのシートだけ');
  assert.deepEqual(env.audit().map((a) => [a.action, a.phase, a.result, a.actor_email]), [['SETUP.INIT', 'END', 'OK', OWNER]]);
  assert.ok(r1.created.length >= 6 && r1.dataNew === true);
  assert.match(r1.dataUrl, /^https:\/\/docs\.google\.com\/spreadsheets\/d\//);
  // 2 回目: 何も増えない
  const fileCount = Object.keys(env.files).length;
  const r2 = env.call('apiSetup()');
  assert.deepEqual([r2.created, r2.tables, r2.dataNew], [[], [], false]);
  assert.equal(Object.keys(env.files).length, fileCount);
  assert.equal(env.table('_SCHEMA').length, Object.keys(tables).length);
  assert.equal(env.table('MEMBERS').length, 1);
  assert.equal(env.audit().filter((a) => a.action === 'SETUP.INIT').length, 2, '実行のたびに記録は残す');
  // 初期設定の後の最初の操作で、版ごとの一度だけの写しが動く（役割の判定より前）。写しごとに監査の記録つき（2026-10-13）。2 回目からは動かない
  const names = env.call('appBackfillNames_()');
  assert.ok(names.length >= 4);
  assert.deepEqual(env.audit().filter((a) => a.action === 'SCHEMA.BACKFILL').map((a) => [a.phase, a.result, a.entity_id, a.actor_email]),
    names.flatMap((n) => [['START', '', n, OWNER], ['END', 'OK', n, OWNER]]), '写しごとに開始と終わり');
  assert.equal(env.audit().length, 2 + names.length * 2);
  assert.deepEqual(Object.keys(JSON.parse(env.props.APP_BACKFILLS).done).sort(), [...names].sort());
  // 表が 1 つ消えていたら作り直す（ほかの表はそのまま）
  env.data().deleteSheet(env.data().getSheetByName('CLIENTS'));
  assert.deepEqual(env.call('apiSetup()').tables, ['CLIENTS']);
  boot = env.boot();
  assert.equal(boot.setUp, true);
  assert.equal(env.state.lockHeld, false);
}

// ==== 5. 本人確認と役割 ====
{
  const env = setUpEnv();
  env.as(MEMBER);
  const boot = env.boot();
  assert.equal(boot.allowed, true);
  assert.equal(boot.user.isAdmin, false);
  assert.deepEqual(boot.user.roles.map((r) => r.role), ['VIEWER', 'CONTRIBUTOR'], '社内の人は閲覧と情報提供を自動で持つ');
  const n0 = env.audit().length;
  assert.throws(() => env.task('listDirectory()'), /権限がありません/);
  assert.throws(() => env.task(`saveMember({ email: '${OTHER}', displayName: 'X' })`), /権限がありません/);
  // 管理の操作は所有者の操作（apiOwnerTask）だけ。断ったことは、その入口の名前で記録する
  assert.deepEqual(env.audit().slice(n0).map((a) => [a.action, a.phase, a.result, a.actor_email, a.actor_roles]), [
    ['OWNER.TASK', 'DENIED', 'DENIED', MEMBER, 'VIEWER,CONTRIBUTOR'],
    ['OWNER.TASK', 'DENIED', 'DENIED', MEMBER, 'VIEWER,CONTRIBUTOR'],
  ], '拒否も記録する');
  assert.equal(env.table('MEMBERS').length, 1, '拒否した操作は実行しない');
  for (const who of [OUTSIDER, '']) {
    env.as(who);
    const b = env.boot();
    assert.deepEqual([b.allowed, b.user.isAdmin, b.user.roles], [false, false, []], `社外・メールが取れない人には何も許さない: "${who}"`);
    assert.throws(() => env.task('health()'), /権限がありません/);
  }
  assert.equal(env.audit().slice(-1)[0].actor_email, '(unknown)');
  env.as('Owner@BIGM2Y.com');
  assert.equal(env.boot().user.isAdmin, true, 'メールの大文字・小文字は区別しない');
  // 社外のメールに付与の行があっても効かない
  env.as(OWNER);
  env.run(`appInsertRows_('ROLES', [{ role_id: 'RL-X', email: '${OUTSIDER}', role: 'ADMIN', scope_type: 'ALL', client_id: '', valid_from: '', valid_to: '', is_active: true, row_version: 1 }])`);
  env.as(OUTSIDER);
  assert.deepEqual(env.call('appRolesOf_(appCurrentUser_())'), []);
  // 役割の強さとクライアント単位
  const has = (roles, min, client) => env.run(`appHasRole_(__r, '${min}'${client ? `, '${client}'` : ''})`, { __r: roles });
  const planner = [{ role: 'PLANNER', scope_type: 'CLIENT', client_id: 'CL-1' }];
  assert.equal(has(planner, 'PLANNER'), false, 'クライアント単位の役割は全体の操作に効かない');
  assert.equal(has(planner, 'PLANNER', 'CL-1'), true);
  assert.equal(has(planner, 'PLANNER', 'CL-2'), false);
  assert.equal(has(planner, 'CONTRIBUTOR', 'CL-1'), true, '強い役割は弱い役割を含む');
  assert.equal(has(planner, 'APPROVER', 'CL-1'), false);
  assert.equal(has([{ role: 'ADMIN', scope_type: 'ALL', client_id: '' }], 'APPROVER'), true);
  assert.throws(() => has(planner, 'BOSS'), /未定義の役割/);
}

// ==== 6. メンバー・役割の付与と取り消し ====
{
  const env = setUpEnv();
  assert.throws(() => env.task(`saveMember({ email: '${OUTSIDER}', displayName: 'X' })`), /社内（@bigm2y\.com）のメールアドレスだけ/);
  assert.throws(() => env.task(`saveMember({ email: 'bad', displayName: 'X' })`), /形式が正しくありません/);
  assert.throws(() => env.task(`saveMember({ email: 'x@evil-bigm2y.com', displayName: 'X' })`), /社内/);
  assert.throws(() => env.task(`saveMember({ email: '${MEMBER}', displayName: '  ' })`), /名前を入力/);
  assert.throws(() => env.task(`grantRole({ email: '${MEMBER}', role: 'PLANNER' })`), /先にメンバーとして登録/);
  const m = env.task(`saveMember({ email: ' Member@BIGM2Y.com ', displayName: 'メンバー', department: '営業' })`);
  assert.deepEqual([m.member.email, m.created], [MEMBER, true]);
  const cl = env.task(`saveClient({ clientName: '株式会社テスト製薬', zacCode: 'Z001' })`).client;
  assert.match(cl.client_id, /^CL-\d{14}-[0-9A-F]{8}$/);
  assert.throws(() => env.task(`grantRole({ email: '${MEMBER}', role: 'VIEWER' })`), /付与できる役割は 予算策定担当・承認者・管理者/);
  assert.throws(() => env.task(`grantRole({ email: '${MEMBER}', role: 'APPROVER', scopeType: 'CLIENT', clientId: '${cl.client_id}' })`), /予算策定担当だけ/);
  assert.throws(() => env.task(`grantRole({ email: '${MEMBER}', role: 'PLANNER', scopeType: 'CLIENT', clientId: 'CL-none' })`), /メーカーを選んで/);
  assert.throws(() => env.task(`grantRole({ email: '${MEMBER}', role: 'PLANNER', validFrom: '2026/10/01' })`), /yyyy-MM-dd/);
  assert.throws(() => env.task(`grantRole({ email: '${MEMBER}', role: 'PLANNER', validFrom: '${TODAY}', validTo: '${YESTERDAY}' })`), /終わりの日が始まりの日より前/);
  const g = env.task(`grantRole({ email: '${MEMBER}', role: 'PLANNER', scopeType: 'CLIENT', clientId: '${cl.client_id}' })`).role;
  assert.deepEqual([g.scope_type, g.client_id, g.valid_from, g.is_active], ['CLIENT', cl.client_id, TODAY, true]);
  assert.throws(() => env.task(`grantRole({ email: '${MEMBER}', role: 'PLANNER', scopeType: 'CLIENT', clientId: '${cl.client_id}' })`), /すでに付いています/);
  const grantEnd = env.audit().filter((a) => a.action === 'ROLE.GRANT' && a.result === 'OK')[0];
  assert.deepEqual([grantEnd.entity_type, grantEnd.entity_id, grantEnd.client_id], ['ROLE', g.role_id, cl.client_id], '作った ID を終了の行に残す');
  const rolesOf = () => env.call('appRolesOf_(appCurrentUser_())');
  env.as(MEMBER);
  assert.deepEqual(rolesOf().map((r) => [r.role, r.scope_type, r.client_id]).slice(-1), [['PLANNER', 'CLIENT', cl.client_id]]);
  // 外す: 行は残して無効にする
  env.as(OWNER);
  const rv = env.task(`revokeRole({ roleId: '${g.role_id}', rowVersion: 1 })`).role;
  assert.deepEqual([rv.is_active, rv.valid_to, rv.row_version, rv.updated_by], [false, TODAY, 2, OWNER]);
  const end = env.audit().filter((a) => a.action === 'ROLE.REVOKE' && a.phase === 'END')[0];
  assert.equal(JSON.parse(end.before_json).is_active, true);
  assert.equal(JSON.parse(end.after_json).is_active, false);
  assert.deepEqual([end.entity_id, end.client_id], [g.role_id, cl.client_id]);
  assert.throws(() => env.task(`revokeRole({ roleId: '${g.role_id}' })`), /すでに外れています/);
  assert.throws(() => env.task(`revokeRole({ roleId: 'RL-none' })`), /見つかりません/);
  assert.equal(env.table('ROLES').length, 1, '外した役割の行も消さない');
  env.as(MEMBER);
  assert.equal(rolesOf().length, 2, '外した役割は効かない');
  // 期間の外は効かない（始まる前・終わった後）
  env.as(OWNER);
  env.task(`grantRole({ email: '${MEMBER}', role: 'APPROVER', validFrom: '${TOMORROW}' })`);
  env.task(`grantRole({ email: '${MEMBER}', role: 'ADMIN', validFrom: '2026-01-01', validTo: '${YESTERDAY}' })`);
  env.as(MEMBER);
  assert.deepEqual(rolesOf().map((r) => r.role), ['VIEWER', 'CONTRIBUTOR']);
  env.as(OWNER);
  assert.throws(() => env.task(`grantRole({ email: '${MEMBER}', role: 'APPROVER' })`), /同じ期間にすでに付いています/, '期間が重なる付与は二重にしない');
  // 所有者の管理者は外せない
  env.as(OWNER);
  const ga = env.task(`grantRole({ email: '${OWNER}', role: 'ADMIN' })`).role;
  assert.throws(() => env.task(`revokeRole({ roleId: '${ga.role_id}' })`), /所有者は管理者のまま/);
  // 期限が切れた付与の後には付け直せる。管理者を付けた人も、管理の操作（所有者の操作）はできない（2026-10-13。画面の入口も無い）
  env.task(`grantRole({ email: '${MEMBER}', role: 'ADMIN' })`);
  const dir = env.task('listDirectory()');
  assert.deepEqual([dir.members.length, dir.owner], [2, OWNER]);
  assert.ok(dir.members.every((x) => !('_row' in x)), '行番号は画面に出さない');
  env.as(MEMBER);
  assert.equal(env.boot().user.isAdmin, true, '管理者の役割は付いている');
  assert.throws(() => env.task('listDirectory()'), /権限がありません/, '所有者でない管理者は所有者の操作を使えない');
  for (const n of REMOVED) assert.equal(typeof env.ctx[n], 'undefined', `${n} は呼べない`);
  // 役割の表が壊れていたら付与なし（最小の権限）にする
  env.data().getSheetByName('ROLES').rows[0][2] = 'kind';
  env.run('appBumpGen_()');   // 表を手で直したときは、次の書き込みか 10 分で読み直す（読んだ結果の控え）
  assert.equal(env.boot().user.isAdmin, false, '役割の表が読めなければ管理者の付与も効かない');
  env.as(OWNER);
  assert.equal(env.boot().user.isAdmin, true, '所有者は表が壊れていても管理者（直すため）');
}

// ==== 7. 楽観ロック（ほかの人の更新を上書きしない） ====
{
  const env = setUpEnv();
  env.task(`saveMember({ email: '${MEMBER}', displayName: 'A' })`);
  const u1 = env.task(`saveMember({ email: '${MEMBER}', displayName: 'B', rowVersion: 1 })`);
  assert.deepEqual([u1.created, u1.member.row_version, u1.before.display_name], [false, 2, 'A']);
  assert.throws(() => env.task(`saveMember({ email: '${MEMBER}', displayName: 'C', rowVersion: 1 })`), /ほかの人が先に更新しました/);
  assert.equal(env.table('MEMBERS').find((x) => x.email === MEMBER).display_name, 'B');
  assert.deepEqual(env.audit().slice(-2).map((a) => [a.action, a.phase, a.result]), [['MEMBER.SAVE', 'START', ''], ['MEMBER.SAVE', 'END', 'FAILED']]);
  assert.match(env.audit().slice(-1)[0].error, /ほかの人が先に更新/);
  assert.ok(env.errors().some((e) => e.where === 'OWNER.TASK' && /ほかの人が先に更新/.test(e.message)), 'エラーのログにも残す（所有者の操作の入口の名前で）');
  const ok = env.audit().filter((a) => a.action === 'MEMBER.SAVE' && a.result === 'OK');
  assert.equal(JSON.parse(ok[1].before_json).display_name, 'A');
  assert.equal(JSON.parse(ok[1].after_json).display_name, 'B');
  assert.equal(ok[0].before_json, '', '新規は変更前なし');
  const startRow = env.audit().filter((a) => a.action === 'MEMBER.SAVE' && a.phase === 'START')[0];
  assert.equal(JSON.parse(startRow.detail_json).displayName, 'A', '入力を開始の行に残す');
  assert.equal(env.state.lockHeld, false, '失敗してもロックは返す');
}

// ==== 7b. 行の版は、今ある行を書き換える操作で必須（2026-10-13。省くと後から書いた方が勝っていた）。新しく作る操作には要らない。
//          所有者の操作（エディタから 1 人で動かす）は、頼みに無ければ今の版を読んで渡す ====
{
  const env = setUpEnv();
  const ctx = `{ actor: '${OWNER}', user: { email: '${OWNER}', owner: '${OWNER}', domain: 'bigm2y.com', isOwner: true }, roles: [{ role: 'ADMIN', scope_type: 'ALL', client_id: '' }] }`;
  const inner = (fn, input) => () => env.run(`${fn}(${ctx}, __in)`, { __in: input });
  const STALE = /画面が古いので、読み直してからもう一度操作してください。/;
  // 新しく作る: 版は要らない
  env.run(`appSaveMember_(${ctx}, { email: '${MEMBER}', displayName: 'A' })`);
  const cl = env.call(`appSaveClient_(${ctx}, { clientName: 'テスト製薬' })`).client;
  const role = env.call(`appGrantRole_(${ctx}, { email: '${MEMBER}', role: 'PLANNER', scopeType: 'CLIENT', clientId: '${cl.client_id}' })`).role;
  env.call(`appSaveClientName_(${ctx}, { clientId: '${cl.client_id}', displayName: 'テスト' })`);
  const link = env.call(`appLinkPerson_(${ctx}, { personName: '鷹野', email: '${MEMBER}' })`).link;
  const before = JSON.stringify(['MEMBERS', 'CLIENTS', 'ROLES', 'CLIENT_NAMES', 'PERSON_LINKS'].map((t) => env.table(t)));
  // 書き換える: 版が無ければ（undefined・null・空）止める。何も書かない
  for (const rv of [undefined, null, '']) {
    assert.throws(inner('appSaveMember_', { email: MEMBER, displayName: 'B', rowVersion: rv }), STALE, 'メンバー ' + rv);
    assert.throws(inner('appRevokeRole_', { roleId: role.role_id, rowVersion: rv }), STALE, '役割 ' + rv);
    assert.throws(inner('appSaveClientName_', { clientId: cl.client_id, displayName: 'テスト2', rowVersion: rv }), STALE, '表示名 ' + rv);
    assert.throws(inner('appSaveClient_', { clientId: cl.client_id, clientName: 'テスト製薬', rowVersion: rv }), STALE, 'メーカー ' + rv);
    assert.throws(inner('appUnlinkPerson_', { linkId: link.link_id, rowVersion: rv }), STALE, 'つなぎ ' + rv);
  }
  assert.equal(JSON.stringify(['MEMBERS', 'CLIENTS', 'ROLES', 'CLIENT_NAMES', 'PERSON_LINKS'].map((t) => env.table(t))), before, '何も書かない');
  // 書き換える仕組みの印は、画面から渡る同じ形の値では効かない
  assert.throws(inner('appSaveMember_', { email: MEMBER, displayName: 'B', rowVersion: { unchecked: true } }), /ほかの人が先に更新しました/);
  assert.throws(() => env.run(`appWithLock_(() => appUpdateByKey_('MEMBERS', { email: '${MEMBER}' }, { note: 'x' }, undefined, 'test'))`), STALE, '保存の層でも必須');
  env.run(`appWithLock_(() => appUpdateByKey_('MEMBERS', { email: '${MEMBER}' }, { note: '仕組み' }, APP_ROW_UNCHECKED, 'test'))`);
  assert.equal(env.table('MEMBERS').find((m) => m.email === MEMBER).note, '仕組み', '仕組みの中の書き直しは印で通す');
  // 自動に戻した表示名（空の行）も、一覧に版を出す（その行を書き直すので要る）
  env.call(`appSaveClientName_(${ctx}, { clientId: '${cl.client_id}', displayName: '', rowVersion: 1 })`);
  const dir = env.task('listDirectory()');
  const c = dir.clients.find((x) => x.client_id === cl.client_id);
  assert.deepEqual([c.display_auto, c.display_row_version], [true, 2], '自動に戻した行の版');
  // 所有者の操作: 頼みに版が無ければ、今の版を読んで渡す（エディタの操作は壊れない）。頼みに入れた古い版は断る
  const m0 = env.table('MEMBERS').find((m) => m.email === MEMBER).row_version;
  assert.equal(env.task(`saveMember({ email: '${MEMBER}', displayName: 'C' })`).member.display_name, 'C');
  assert.equal(String(env.table('MEMBERS').find((m) => m.email === MEMBER).row_version), String(Number(m0) + 1));
  assert.throws(() => env.task(`saveMember({ email: '${MEMBER}', displayName: 'D', rowVersion: ${m0} })`), /ほかの人が先に更新しました/, '古い版は断る');
  env.task(`saveClientName({ clientId: '${cl.client_id}', displayName: 'テスト3' })`);
  assert.equal(env.table('CLIENT_NAMES').find((r) => r.client_id === cl.client_id).display_name, 'テスト3');
  env.task(`revokeRole({ roleId: '${role.role_id}' })`);
  assert.equal(env.table('ROLES').find((r) => r.role_id === role.role_id).is_active, 'FALSE');
  env.task(`unlinkPerson({ linkId: '${link.link_id}' })`);
  assert.equal(env.table('PERSON_LINKS').find((r) => r.link_id === link.link_id).is_active, 'FALSE');
  const startOf = (a) => JSON.parse(env.audit().filter((x) => x.action === a && x.phase === 'START').slice(-1)[0].detail_json);
  assert.equal(startOf('ROLE.REVOKE').rowVersion, 1, '読んで渡した版は記録の入力に残る');
  // メーカーを直すのは、所有者の操作でも全部の項目と版が要る（前からの決まり）
  assert.throws(() => env.task(`saveClient({ clientId: '${cl.client_id}', clientName: 'テスト製薬', zacCode: '', isActive: true, note: '' })`), /足りない項目: rowVersion/);
}

// ==== 8. クライアント（表記ゆれを吸収して重複を防ぐ） ====
{
  const env = setUpEnv();
  const norm = (s) => env.run('appNormalizeName_(__s)', { __s: s });
  for (const s of ['テスト製薬', '（株）テスト製薬', '㈱テスト製薬', 'テスト製薬株式会社', 'ﾃｽﾄ製薬', ' テスト 製薬 ']) {
    assert.equal(norm(s), norm('株式会社テスト製薬'), s);
  }
  assert.equal(norm('ABC Pharma'), norm('ａｂｃ　ｐｈａｒｍａ'));
  assert.equal(norm('株主製薬'), '株主製薬', '会社の種類は語として除く（1 文字ずつは消さない）');
  assert.equal(norm('合同製薬'), '合同製薬');
  const c = env.task(`saveClient({ clientName: '株式会社テスト製薬' })`).client;
  assert.throws(() => env.task(`saveClient({ clientName: 'テスト製薬（株）' })`), /同じ名前のメーカー/);
  const u = env.task(`saveClient({ clientId: '${c.client_id}', clientName: 'テスト製薬', zacCode: 'Z9', isActive: true, note: '', rowVersion: 1 })`);
  assert.deepEqual([u.client.client_name, u.client.zac_code, u.client.row_version, u.created], ['テスト製薬', 'Z9', 2, false]);
  assert.throws(() => env.task(`saveClient({ clientName: ' ' })`), /メーカー名を入力/);
  assert.equal(env.table('CLIENTS').length, 1);
  assert.equal(env.table('CLIENTS')[0].aliases_json, '[]');
}

// ==== 9. 設定（既定値は旧来の値・範囲の確認・上書きしない履歴） ====
{
  const env = setUpEnv();
  // 数・整数・する/しないの型を確かめるため、テストだけの設定を足す（本番の設定は ZAC のスプレッドシートだけ）
  env.run(`Object.assign(APP_SETTING_DEFS, {
    'test.rate': { label: '割合', type: 'number', min: 0, max: 1, def: 0.12, unit: '割合' },
    'test.rate2': { label: '割合2', type: 'number', min: 0, max: 1, def: 0.05, unit: '割合' },
    'test.months': { label: '月数', type: 'int', min: 1, max: 24, def: 3, unit: 'か月' },
    'test.flag': { label: 'フラグ', type: 'bool', def: false, unit: 'する / しない' } })`);
  const cur = () => Object.fromEntries(env.task('listSettings()').settings.map((s) => [s.key, s]));
  let s = cur();
  // 着地見込みの τ・w（2026-10-08 判断 29・11: 学んだ値は所有者が承認して書くまで使わない）
  assert.deepEqual(Object.keys(s).filter((k) => !/^test\./.test(k)), ['source.zac_spreadsheet', 'landing.tau', 'landing.w'], '本番の設定は使うものだけ');
  // 本番の設定は、どれも所有者だけが変えられる（2026-10-13: ZAC の実績のスプレッドシートも。取り込みは所有者の権限でそのブックを読むため）。
  // スプレッドシートを指す設定は必ず所有者だけ。所有者の操作（saveSetting）が無くても、中の関数が所有者でない人を断る
  const defs = env.run('APP_SETTING_DEFS');
  for (const key of ['source.zac_spreadsheet', 'landing.tau', 'landing.w']) assert.equal(defs[key].owner, true, key + ' は所有者だけ');
  for (const key of Object.keys(defs).filter((k) => defs[k].type === 'sheet')) assert.equal(defs[key].owner, true, key + '（スプレッドシート）は所有者だけ');
  const book = env.makeBook('ほかのブック', { Sheet1: { values: [['x']] } });
  const notOwner = { actor: MEMBER, user: { email: MEMBER, isOwner: false }, roles: [{ role: 'ADMIN', scope_type: 'ALL', client_id: '' }] };
  for (const key of ['source.zac_spreadsheet', 'landing.tau']) {
    assert.throws(() => env.run('appSaveSetting_(__c, __in)', { __c: notOwner, __in: { key, value: key === 'landing.tau' ? 0.2 : 'https://docs.google.com/spreadsheets/d/' + book.getId() + '/edit' } }),
      /所有者だけが変えられます/, key + ' は管理者の役割があっても書けない');
  }
  assert.equal(env.table('SETTINGS').length, 0, '所有者でない人の値は保存しない');
  assert.ok(Object.values(s).every((x) => x.isDefault));
  for (const [key, value, re] of [
    ['test.rate', '1.5', /0〜1 の範囲/], ['test.rate', 'abc', /数値で入力/], ['test.rate', '', /数値で入力/],
    ['test.months', '2.5', /整数で入力/], ['test.flag', 'maybe', /する \/ しない/], ['no.such', '1', /未定義の設定/],
  ]) {
    assert.throws(() => env.task('saveSetting(__in)', { __in: { key, value } }), re, `${key}=${value}`);
  }
  assert.throws(() => env.task(`saveSetting({ key: 'test.rate', value: '0.2', effectiveFrom: '2026/10/01' })`), /yyyy-MM-dd/);
  assert.equal(env.table('SETTINGS').length, 0, 'だめな値は保存しない');
  env.task(`saveSetting({ key: 'test.rate', value: '0.15' })`);
  env.task(`saveSetting({ key: 'test.rate', value: 0.11 })`);
  s = cur();
  assert.deepEqual([s['test.rate'].value, s['test.rate'].isDefault, s['test.rate'].effectiveFrom], [0.11, false, TODAY],
    '同じ日に 2 回変えたら後の値');
  assert.equal(env.table('SETTINGS').length, 2, '上書きせず行を足す');
  const end = env.audit().filter((a) => a.action === 'SETTING.SAVE' && a.result === 'OK')[1];
  assert.equal(JSON.parse(end.before_json).value, 0.15);
  assert.equal(JSON.parse(end.after_json).value, '0.11');
  env.task(`saveSetting({ key: 'test.months', value: 6, effectiveFrom: '${TOMORROW}' })`);
  s = cur();
  assert.equal(s['test.months'].value, 3, '先の日付の設定はその日まで効かない');
  assert.deepEqual(s['test.months'].scheduled, [{ value: '6', effectiveFrom: TOMORROW }]);
  env.task(`saveSetting({ key: 'test.flag', value: 'true' })`);
  assert.equal(cur()['test.flag'].value, true);
  assert.equal(env.run(`appSettingValue_('test.rate')`), 0.11);
  // 表に紛れ込んだ不正な値は使わず既定値に戻す
  env.run(`appInsertRows_('SETTINGS', [{ setting_id: 'ST-X', key: 'test.rate2', value: '9', scope: 'GLOBAL', scope_id: '', effective_from: '${TODAY}', note: '', created_at: '', created_by: '' }])`);
  assert.equal(cur()['test.rate2'].value, 0.05);
}

// ==== 10. 操作の記録（鎖・改ざんの検出・一覧） ====
{
  const env = setUpEnv();
  env.task(`saveMember({ email: '${MEMBER}', displayName: 'A' })`);
  env.task(`saveClient({ clientName: 'テスト製薬' })`);
  const sh = env.auditSheet();
  assert.deepEqual([...sh.rows[0]], [...auditCols]);
  const ip = auditCols.indexOf('prev_hash');
  sh.rows.slice(1).forEach((r, i) => {
    assert.equal(r[ip], i === 0 ? '' : sh.rows[i][ip + 1], '前の行の hash につながる');
    assert.equal(r[ip + 1], sha(r[ip] + '\n' + JSON.stringify(r.slice(0, ip))), 'hash は「前の hash + 改行 + 行の内容」の SHA-256');
  });
  assert.equal(env.props.APP_AUDIT_LAST_HASH, sh.rows.slice(-1)[0][ip + 1], '最新の hash を控える');
  const verify = () => env.call('appVerifyAuditSheet_(__sh)', { __sh: sh });
  let v = verify();
  assert.deepEqual([v.ok, v.rows, v.lastHash], [true, sh.rows.length - 1, env.props.APP_AUDIT_LAST_HASH]);
  const h = env.task('health()');
  assert.ok(h.setUp && h.tables.every((t) => t.ok), JSON.stringify(h.tables));
  assert.deepEqual([h.audit.ok, h.audit.matchesLatest], [true, true]);
  assert.match(h.files.data, /spreadsheets/);
  // 一覧: 新しい順・絞り込み
  const list = env.task(`listAudit({ limit: 3 })`).rows;
  assert.equal(list.length, 3);
  assert.ok(list[0].occurred_at >= list[2].occurred_at);
  const q = env.task(`listAudit({ query: 'client.save' })`).rows;
  assert.ok(q.length === 2 && q.every((a) => a.action === 'CLIENT.SAVE'), '大文字小文字を区別せず絞り込む');
  // 書き換え・削除を見つける
  const saved = sh.rows.map((r) => r.slice());
  sh.rows[2][4] = 'TAMPERED';
  v = verify();
  assert.deepEqual([v.ok, v.brokenAt], [false, 3]);
  assert.equal(env.task('health()').audit.ok, false);
  sh.rows.splice(0, sh.rows.length, ...saved);
  sh.rows.splice(2, 1);
  assert.deepEqual([verify().ok, verify().brokenAt], [false, 3]);
  sh.rows.splice(0, sh.rows.length, ...saved);
  sh.rows.pop();
  v = verify();
  assert.equal(v.ok, true);
  assert.equal(env.task('health()').audit.matchesLatest, false, '末尾を消すと最新の hash と合わない');
  // 定義と違う表を見つける
  sh.rows.splice(0, sh.rows.length, ...saved);
  const schemaSheet = env.data().getSheetByName('_SCHEMA');
  schemaSheet.rows[1][2] = 'x';
  const bad = env.task('health()').tables.filter((t) => !t.ok);
  assert.equal(bad.length, 1);
  assert.match(bad[0].note, /_SCHEMA と違う/);
  // 数値などが来ても文字列にして書く（読み戻した値で鎖が合う）
  sh.rows.splice(0, sh.rows.length, ...saved);
  schemaSheet.rows[1][2] = sha(tables[schemaSheet.rows[1][0]].columns.join('|'));
  env.run(`appAuditAppend_({ actor: '${OWNER}', action: 'TEST.NUM', phase: 'END', result: 'OK', entityId: 123, clientId: 0 })`);
  const lastRow = sh.rows.slice(-1)[0];
  assert.equal(lastRow[auditCols.indexOf('entity_id')], '123');
  assert.equal(verify().ok, true);
  // 長い JSON はハッシュと先頭だけ
  const big = { big: 'x'.repeat(50000) };
  const j = JSON.parse(env.run('appJson_(__b)', { __b: big }));
  assert.deepEqual([j.truncated, j.sha256, j.head.length], [true, sha(JSON.stringify(big)), 2000]);
  // 年度は 4 月始まり・始まりの年で呼ぶ（旧来の計算の getForecastFYStart_ と同じ）
  assert.deepEqual([env.run('appFy_(new Date(2026, 2, 31))'), env.run('appFy_(new Date(2026, 3, 1))'), env.run('appFy_(new Date(2026, 9, 1))')], [2025, 2026, 2026]);
  const legacy = await readFile(path.join(repoRoot, 'Forecast_Agent.js'), 'utf8');
  assert.match(legacy, /function getForecastFYStart_\(fy\) \{\n  return new Date\(Number\(fy\), 3, 1\);/, '旧来の計算は FY N を N 年 4 月から数える');
}

// ==== 10b. 以前（終わりの年で呼んでいた）のログのファイル名を一度だけ直す ====
{
  const env = setUpEnv();
  env.boot();   // 最初の操作の一度だけの写し（監査に残る）を先に済ませる
  assert.equal(env.props.APP_FY_NAMING, 'start', '新しい環境は最初から始まりの年で呼ぶ');
  const logId = JSON.parse(env.props.APP_LOG_SPREADSHEETS_JSON)[FY];
  assert.equal(env.files[logId].name, 'Trends2Targets_Logs_' + FY);
  // 2026-10-01 の状態を作る: 終わりの年のキーと名前・印なし
  const oldKey = 'FY' + (Number(FY.slice(2)) + 1);
  const before = env.audit().length;
  env.props.APP_LOG_SPREADSHEETS_JSON = JSON.stringify({ [oldKey]: logId });
  env.files[logId].name = 'Trends2Targets_Logs_' + oldKey;
  delete env.props.APP_FY_NAMING;
  env.task(`saveClient({ clientName: 'テスト製薬' })`);
  assert.deepEqual(JSON.parse(env.props.APP_LOG_SPREADSHEETS_JSON), { [FY]: logId }, 'キーを 1 年ずらす');
  assert.equal(env.files[logId].name, 'Trends2Targets_Logs_' + FY, 'ファイル名も直す');
  assert.equal(env.props.APP_FY_NAMING, 'start');
  assert.equal(env.audit().length, before + 2, '同じファイルに記録を続ける（新しいファイルを作らない）');
  assert.equal(Object.values(env.files).filter((f) => /Logs_|ログ/.test(f.name)).length, 1);
  // 二度目は何もしない
  env.task(`saveClient({ clientName: '別の製薬' })`);
  assert.deepEqual(JSON.parse(env.props.APP_LOG_SPREADSHEETS_JSON), { [FY]: logId });
  assert.equal(env.state.lockHeld, false);
}

// ==== 11. 記録できなければ書き込まない（fail-closed）・列が違う表には書かない ====
{
  const env = setUpEnv();
  env.auditSheet().failWrites = true;
  assert.throws(() => env.task(`saveMember({ email: '${MEMBER}', displayName: 'A' })`), /write failed/);
  assert.equal(env.table('MEMBERS').length, 1, '開始を記録できなければ実行しない');
  env.auditSheet().failWrites = false;
  env.data().getSheetByName('MEMBERS').rows[0][1] = 'name';
  assert.throws(() => env.task(`saveMember({ email: '${MEMBER}', displayName: 'A' })`), /表の列が定義と違います（MEMBERS）/);
  assert.equal(env.data().getSheetByName('MEMBERS').rows.length, 2);
  env.data().getSheetByName('MEMBERS').rows[0][1] = 'display_name';
  env.auditSheet().rows[0][5] = 'step';
  assert.throws(() => env.task(`saveMember({ email: '${MEMBER}', displayName: 'A' })`), /ログの列が想定と違います/);
  assert.equal(env.table('MEMBERS').length, 1);
  env.auditSheet().rows[0][5] = 'phase';
  // キーの重複・空のキーは足さない
  assert.throws(() => env.run(`appInsertRows_('MEMBERS', [{ email: '${OWNER}', display_name: 'dup' }])`), /同じキーの行がすでにあります/);
  assert.throws(() => env.run(`appInsertRows_('MEMBERS', [{ email: '${MEMBER}' }, { email: '${MEMBER}' }])`), /同じキーの行/);
  assert.throws(() => env.run(`appInsertRows_('ROLES', [{ email: '${MEMBER}', role: 'ADMIN' }])`), /キーが空の行/);
  assert.equal(env.table('MEMBERS').length, 1);
  env.props.APP_LOG_SPREADSHEETS_JSON = JSON.stringify({ [FY]: 'missing' });
  assert.throws(() => env.task(`saveMember({ email: '${MEMBER}', displayName: 'A' })`), /not found/);
  assert.equal(env.table('MEMBERS').length, 1, 'ログのファイルを開けなければ実行しない');
  assert.equal(env.state.lockHeld, false);
}

// ==== 12. バックアップ（14 世代・古いものはアーカイブへ・データ本体は触らない。消さない・ゴミ箱にも送らない） ====
{
  const env = setUpEnv();
  const isBackup = (f) => f.kind === 'file' && f.name.startsWith('Trends2Targets_Data_Backup_');
  const all = () => Object.values(env.files).filter(isBackup).sort((a, b) => a.created - b.created);
  const archiveId = () => env.props.APP_ARCHIVE_FOLDER_ID;
  for (let i = 0; i < 16; i++) env.task('runBackup()');
  assert.equal(all().length, 16);
  const kept = env.backups().sort((a, b) => a.created - b.created);
  assert.equal(kept.length, 14, '新しい 14 世代はバックアップのフォルダに残す');
  const archived = all().filter((f) => f.parent === archiveId());
  assert.deepEqual(archived.map((f) => f.name), all().slice(0, 2).map((f) => f.name), '古いものはアーカイブのフォルダへ移す（消さない・ゴミ箱にも送らない）');
  assert.ok(all().every((f) => !f.trashed), 'ゴミ箱へは何も送らない');
  assert.ok(all().every((f) => f.name.startsWith('Trends2Targets_Data_Backup_')));
  assert.ok(env.sheetsById[kept[13].id].getSheetByName('MEMBERS').rows.length === 2, '複製にはデータ本体の表が入る');
  assert.ok(env.sheetsById[archived[0].id].getSheetByName('MEMBERS'), 'アーカイブに移した複製も中身はそのまま');
  assert.equal(env.files[env.props.APP_DATA_SPREADSHEET_ID].trashed, false);
  assert.equal(env.files[env.props.APP_DATA_SPREADSHEET_ID].parent, env.files[env.props.APP_BACKUP_FOLDER_ID].parent, 'データ本体は動かさない');
  assert.equal(env.runLog().filter((r) => r.kind === 'BACKUP' && r.status === 'OK').length, 16, '実行ログに残す');
  const h = env.task('health()');
  assert.deepEqual([h.backup.count, h.backup.enabled], [14, false], 'アーカイブへ移したものは数えない');
  assert.equal(h.backup.latest, kept[13].name);
  // 毎日のトリガー（二重に作らない）
  assert.equal(env.task('enableBackup()').already, false);
  assert.equal(env.task('enableBackup()').already, true);
  assert.equal(env.triggers.length, 1);
  assert.deepEqual([env.triggers[0].handler, env.triggers[0].everyDays, env.triggers[0].atHour], ['triggerDailyBackup', 1, 3]);
  assert.equal(env.task('health()').backup.enabled, true);
  // トリガーの中ではメールが空でも、このプロジェクトのトリガーなら所有者として動く
  const uid = env.triggers[0].uid;
  env.as('');
  env.call(`triggerDailyBackup({ triggerUid: '${uid}' })`);
  assert.equal(all().length, 17, 'トリガーで 1 つ増える');
  assert.equal(env.backups().length, 14, '残すのは 14 世代（増えた分はアーカイブへ）');
  assert.ok(all().every((f) => !f.trashed));
  const last = env.audit().slice(-1)[0];
  assert.deepEqual([last.action, last.result, last.actor_email], ['BACKUP.DAILY', 'OK', OWNER]);
  assert.throws(() => env.call(`triggerDailyBackup({ triggerUid: 'forged' })`), /権限がありません/);
  assert.throws(() => env.call('triggerDailyBackup()'), /権限がありません/);
  // ブラウザから社内の人が呼んでも、本人の権限で判定する（UID を知っていても所有者にならない）
  env.as(MEMBER);
  assert.throws(() => env.call(`triggerDailyBackup({ triggerUid: '${uid}' })`), /権限がありません/);
  assert.equal(all().length, 17);
}

// ==== 12b. トリガーの入口は、このプロジェクトのトリガーからだけ（2026-10-13。管理者・所有者でも、ブラウザからは動かせない） ====
{
  const env = setUpEnv();
  env.task(`saveMember({ email: '${MEMBER}', displayName: 'M' })`);
  env.task(`grantRole({ email: '${MEMBER}', role: 'ADMIN' })`);
  env.task('enableBackup()');
  const uid = env.triggers.find((t) => t.handler === 'triggerDailyBackup').uid;
  const backups0 = env.backups().length;
  const mail0 = env.state.mail.length;
  const daily = () => env.runLog().filter((r) => /BACKUP|HOUSEKEEPING|AUTO/.test(r.kind)).length;
  const daily0 = daily();
  const n0 = env.audit().length;
  const jobs = () => Object.keys(env.props).filter((k) => /^APP_JOB_(?!RESULT_|STAGE)/.test(k)).length;
  const jobs0 = jobs();
  const tries = ['triggerDailyBackup()', 'triggerDailyBackup({})', `triggerDailyBackup({ triggerUid: 'forged' })`,
    'triggerAutoResearch()', `triggerAutoResearch({ triggerUid: 'forged' })`, 'triggerRunJob()', `triggerRunJob({ triggerUid: 'forged' })`];
  for (const who of [OWNER, MEMBER]) {
    env.as(who);
    for (const code of tries) assert.throws(() => env.call(code), /権限がありません/, `${who}: ${code}`);
  }
  // 管理者（所有者でない人）は、本物の UID を知っていても動かせない
  env.as(MEMBER);
  assert.throws(() => env.call(`triggerDailyBackup({ triggerUid: '${uid}' })`), /権限がありません/);
  // ほかの入口のトリガーの UID は使えない（入口ごとに確かめる）
  env.as('');
  assert.throws(() => env.call(`triggerAutoResearch({ triggerUid: '${uid}' })`), /権限がありません/);
  assert.throws(() => env.call(`triggerRunJob({ triggerUid: '${uid}' })`), /権限がありません/);
  assert.equal(env.backups().length, backups0, 'バックアップを取らない');
  assert.equal(env.state.mail.length, mail0, '知らせのメールを送らない');
  assert.equal(jobs(), jobs0, '処理を始めない');
  assert.equal(daily(), daily0, '毎日の処理を動かさない');
  const denied = env.audit().slice(n0).filter((a) => a.phase === 'DENIED');
  assert.equal(denied.length, tries.length * 2 + 3, '断ったことは全部記録に残す');
  assert.deepEqual([...new Set(denied.map((a) => a.action))].sort(), ['AUTO.RESEARCH', 'BACKUP.DAILY', 'JOB.RUN']);
  assert.ok(denied.filter((a) => a.actor_email === MEMBER).length >= tries.length + 1, '呼んだ人の名前で残す（所有者として扱わない）');
  // 本物のトリガー（メールが空・所有者のメール）は動く
  env.as('');
  env.call(`triggerDailyBackup({ triggerUid: '${uid}' })`);
  assert.equal(env.backups().length, backups0 + 1);
  assert.equal(env.audit().slice(-1)[0].actor_email, OWNER, 'トリガーは所有者として記録する');
  env.as(OWNER);
  env.call(`triggerDailyBackup({ triggerUid: '${uid}' })`);
  assert.equal(env.backups().length, backups0 + 2);
  // 入口はどれも、トリガーの確かめを通す
  for (const n of ['triggerRunJob', 'triggerDailyBackup', 'triggerAutoResearch']) assert.match(extractFunction(sources['Api.js'], n), new RegExp(`trigger: \\{ event: e, handler: '${n}'`));
}

// ==== 13. 画面を開く（doGet） ====
{
  const env = setUpEnv();
  env.boot();   // 最初の操作の一度だけの写し（監査に残る）を先に済ませる
  const audit0 = env.audit().length;
  const out = env.run('doGet({})');
  assert.equal(out.title, 'Trends2Targets', 'タブは英語の名前だけ');
  assert.match(out.favicon, /^data:image\/png;base64,.+#favicon\.png$/);
  const html = out.getContent();
  const boot = JSON.parse(/var B = (.*);\n/.exec(html)[1]);
  assert.deepEqual([boot.allowed, boot.setUp, boot.user.isAdmin, boot.app.name], [true, true, true, 'Trends2Targets']);
  assert.match(html, /var CHAR_SVG = \{/);
  assert.match(html, /var YOMI_POSE = \{/);
  assert.doesNotMatch(html, /<\?/);
  assert.equal(env.audit().length, audit0, '画面を開くだけでは記録しない（読むだけの操作は記録しない）');
  env.as(OUTSIDER);
  const b2 = JSON.parse(/var B = (.*);\n/.exec(env.run('doGet({})').getContent())[1]);
  assert.deepEqual([b2.allowed, b2.user.roles, b2.user.isAdmin], [false, [], false], '社外の人には役割も出さない');
  // 初期データの「<」は \u003c にする（</script> で画面が壊れない）
  env.run(`appBootstrap_ = function () { return { app: { name: '</script><b>x', version: '0' }, user: { roles: [] }, setUp: true, allowed: true }; }`);
  env.as(OWNER);
  const html3 = env.run('doGet({})').getContent();
  assert.ok(html3.includes('"\\u003c/script>\\u003cb>x"'));
  assert.equal((html3.match(/<\/script>/g) || []).length, 1, '閉じタグは本来の 1 つだけ');
  // ファイルの読み込み順に依存しない（GAS はプロジェクトのファイル順に実行する）
  const rev = setUpEnv({ order: 'reverse' });
  assert.equal(JSON.parse(/var B = (.*);\n/.exec(rev.run('doGet({})').getContent())[1]).setUp, true);
}

// ==== 14. 乱数の固定（同じ種なら同じ結果・終われば元に戻す） ====
{
  const env = makeEnv();
  const seq = (seed, n) => env.run(`(() => { const r = appSeededRandom_(__s); return Array.from({ length: ${n} }, () => r()); })()`, { __s: seed });
  const a = seq('RUN-1', 5);
  assert.deepEqual([...a], [...seq('RUN-1', 5)], '同じ種なら同じ並び');
  assert.notDeepEqual([...a], [...seq('RUN-2', 5)], '種が違えば違う並び');
  const many = [...seq('dist', 100000)];
  assert.ok(many.every((x) => x >= 0 && x < 1));
  const mean = many.reduce((s, x) => s + x, 0) / many.length;
  assert.ok(Math.abs(mean - 0.5) < 0.005, `平均 ${mean}`);
  const buckets = Array(10).fill(0);
  many.forEach((x) => { buckets[Math.floor(x * 10)]++; });
  assert.ok(buckets.every((b) => Math.abs(b - 10000) < 500), `偏り ${buckets}`);
  const original = env.run('Math.random');
  const inside = env.run(`appWithSeededRandom_('S', () => [Math.random(), Math.random()])`);
  assert.deepEqual([...inside], [...seq('S', 2)], 'fn の中の Math.random は種つき');
  assert.equal(env.run('Math.random'), original, '終われば元に戻す');
  assert.throws(() => env.run(`appWithSeededRandom_('S', () => { throw new Error('boom'); })`), /boom/);
  assert.equal(env.run('Math.random'), original, '失敗しても元に戻す');
  assert.throws(() => env.run(`appWithSeededRandom_('A', () => appWithSeededRandom_('B', () => 1))`), /入れ子/);
  assert.equal(env.run('Math.random'), original);
}

console.log('app-contract: all tests passed');
