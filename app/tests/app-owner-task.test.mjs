#!/usr/bin/env node
/*
 * app-owner-task.test.mjs — 所有者が Apps Script のエディタから管理の操作をする入口（apiOwnerTask・OwnerTask.js）。
 * スクリプト プロパティ OWNER_TASK に JSON を置き、エディタと同じく引数なしで実行する。
 * 画面の入口と同じ中の関数・同じ監査（操作ごとの名前）で動くこと・結果は OWNER_TASK_RESULT（9KB まで）と実行ログ・
 * うまくいった後の頼み（読むだけは残す・書いたら消す・裏の処理は jobStatus に置き換える）・失敗したら残すこと・
 * 所有者だけ・年度の締めは確認の指紋が要ることを確かめる。
 *
 *   node app/tests/app-owner-task.test.mjs
 */
import assert from 'node:assert/strict';
import { OWNER, MEMBER, OUTSIDER, sources, extractFunction, setUpEnv } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const RESULT_MAX = 8000;
/** 読むだけの操作（頼みを残す）と、裏の処理を始める操作（頼みを jobStatus に置き換える）。ほかは書く操作（頼みを消す） */
const READS = ['listDirectory', 'listSettings', 'listPlans', 'planCandidates', 'health', 'listAudit', 'yearPreview', 'poolPreview', 'calibrationPreview', 'jobStatus',
  'listPersonLinks', 'vertexConfigPreview', 'bulkStatus', 'provisionalStatus', 'preflightProvisionalOffline', 'exportProvisionalReadback'];   // 人のつなぎ（listPersonLinks・linkPerson・unlinkPerson）は app-v10-hits.test.mjs、AI 調査の問い合わせ先は app-vertex-config.test.mjs で確かめる
const JOBS = ['createPlan', 'setPeople', 'importSales', 'aggregateSales', 'runForecast', 'yearClose', 'poolApply', 'setCalibration', 'runBacktest'];   // 補正の値（setCalibration）は app-calibration.test.mjs、物差し（runBacktest）は app-v10-backtest.test.mjs で確かめる
const seen = { direct: 0, queued: 0 };   // 裏の処理が、始めたその場で終わった回数・まだ終わっていなかった回数

/** OWNER_TASK に頼みを置いて、エディタからの実行と同じく引数なしで apiOwnerTask を動かす */
function task(env, t) {
  env.props.OWNER_TASK = typeof t === 'string' ? t : JSON.stringify(t);
  return env.call('apiOwnerTask()');
}
/** プロパティを触らずに、もう一度 apiOwnerTask を実行する */
const rerun = (env) => env.call('apiOwnerTask()');
/** OWNER_TASK_RESULT（9KB の上限に収まる JSON） */
function result(env) {
  const raw = env.props.OWNER_TASK_RESULT;
  assert.ok(raw, 'OWNER_TASK_RESULT がある');
  assert.ok(Buffer.byteLength(raw, 'utf8') <= RESULT_MAX, '結果は 1 つの値の上限に収まる: ' + Buffer.byteLength(raw, 'utf8'));
  return JSON.parse(raw);
}
/**
 * うまくいく: 結果が書かれる。頼みは、読むだけなら残り・書いたら消え・裏の処理を始めたら jobStatus（jobId つき）に置き換わる。
 * 一言（hint）は、すぐに終わったのか裏の処理を始めたのかを言う。{ full: 返り値（全部）, rec: OWNER_TASK_RESULT }
 */
function ok(env, t) {
  const raw = JSON.stringify(t);
  const full = task(env, t);
  const rec = result(env);
  assert.equal(rec.ok, true, JSON.stringify(rec));
  assert.equal(rec.action, t.action);
  assert.equal(full.ok, true);
  assert.equal(rec.hint, full.hint);
  if (READS.includes(t.action)) {
    assert.equal(env.props.OWNER_TASK, raw, '読むだけの操作は頼みを残す: ' + t.action);
    assert.match(full.hint, /^すぐに終わりました（読むだけ。裏の処理はありません）。OWNER_TASK はそのまま残しています/, t.action);
  } else if (JOBS.includes(t.action)) {
    assert.equal(full.auditAction, 'JOB.START');
    assert.deepEqual(JSON.parse(env.props.OWNER_TASK), { action: 'jobStatus', jobId: full.result.jobId }, '裏の処理を始めたら jobStatus に置き換える: ' + t.action);
    if (['DONE', 'FAILED'].includes(full.result.status)) { seen.direct++; assert.match(full.hint, /^裏の処理として始め、すぐに終わりました（(DONE|FAILED)）。/); }
    else { seen.queued++; assert.match(full.hint, /^裏の処理として始めました。まだ終わっていません/); }
    assert.match(full.hint, /OWNER_TASK を \{"action":"jobStatus","jobId":"…"\} に置き換えた/);
  } else {
    assert.equal('OWNER_TASK' in env.props, false, '書く操作はうまくいったら頼みを消す: ' + t.action);
    assert.match(full.hint, /^すぐに終わりました（書きました。裏の処理はありません）。同じ操作を 2 度動かさないよう、OWNER_TASK を消しました/, t.action);
  }
  return { full, rec };
}
/** 失敗する: 投げる・エラーが OWNER_TASK_RESULT に書かれ、頼みは残る */
function fails(env, t, re) {
  const raw = typeof t === 'string' ? t : JSON.stringify(t);
  assert.throws(() => task(env, t), re);
  const rec = result(env);
  assert.equal(rec.ok, false);
  assert.match(rec.error, re);
  assert.equal(env.props.OWNER_TASK, raw, '失敗したら頼みを残す（直してもう一度実行する）');
  return rec;
}
/**
 * 裏の処理をトリガーで動かし、終わりの状態を受け取る。始めたときに頼みが jobStatus に置き換わっているので、
 * プロパティを触らずにもう一度実行するだけで確かめられる（確かめるのは読むだけなので、頼みはそのまま）
 */
function finishJob(env) {
  const raw = env.props.OWNER_TASK;
  assert.equal(JSON.parse(raw).action, 'jobStatus', '裏の処理を始めた後の頼みは jobStatus');
  for (let i = 0; i < 30; i++) {
    env.fireTriggers('triggerRunJob');
    const full = rerun(env);
    assert.equal(env.props.OWNER_TASK, raw, '確かめても頼みは残る');
    assert.equal(result(env).ok, true);
    const st = full.result;
    if (['QUEUED', 'RUNNING', 'CONTINUED'].includes(st.status)) continue;
    return st;
  }
  throw new Error('処理が終わらない');
}
/** 監査の行（操作の名前・段階で） */
const audits = (env, action, phase) => env.audit().filter((a) => a.action === action && (!phase || a.phase === phase));
/** 書く操作は、入口と同じ操作の名前で開始と終了（OK）が所有者の名前で残り、理由の欄にエディタからと残る */
function audited(env, action) {
  const start = audits(env, action, 'START').slice(-1)[0];
  const end = audits(env, action, 'END').slice(-1)[0];
  assert.ok(start && end, action + ' の開始と終了の記録');
  assert.equal(end.result, 'OK', action);
  assert.equal(end.actor_email, OWNER);
  assert.equal(start.request_id, end.request_id);
  assert.match(start.reason, /OWNER_TASK/, 'エディタからの操作と分かる');
  return { start, end };
}
const jobProps = (env) => Object.keys(env.props).filter((k) => /^APP_JOB_(?!RESULT_)/.test(k)).length;

// ==== 1. 入口: 所有者だけ・本体は api_ だけ・この入口そのものは記録しない ====
{
  const body = extractFunction(sources['Api.js'], 'apiOwnerTask');
  assert.match(body, /return api_\('OWNER\.TASK', \{ ownerOnly: true, audit: false \}, ctx => appOwnerTask_\(ctx\)\);/);
  assert.doesNotMatch(sources['OwnerTask.js'], /SpreadsheetApp\./, '保存の層を通す');
}

const env = setUpEnv();
env.boot();   // 初期設定の後の最初の操作で動く一度だけの写し（写しごとに監査に SCHEMA.BACKFILL が残る）を、先に済ませておく
const currentFy = env.run('appFy_(new Date())');
const past = currentFy - 1;

// ==== 2. 頼みが空・JSON が読めない・形が違う・未定義の操作・使えない項目: 何もせずにエラーを残す ====
{
  const members0 = JSON.stringify(env.table('MEMBERS'));
  const audit0 = env.audit().length;
  fails(env, '', /OWNER_TASK が空です/);
  fails(env, '   ', /OWNER_TASK が空です/);
  fails(env, '{"action":"health"', /JSON が読めません/);
  fails(env, "{'action':'health'}", /JSON が読めません/);
  fails(env, '[1,2]', /\{"action":"…"\} の形/);
  fails(env, '"health"', /\{"action":"…"\} の形/);
  fails(env, {}, /未定義の操作です: （action がありません）/);
  const unknown = fails(env, { action: 'dropAllTables' }, /未定義の操作です: dropAllTables/);
  assert.match(unknown.error, /listDirectory/, '使える操作の一覧を出す');
  fails(env, { action: 'toString' }, /未定義の操作です: toString/);
  fails(env, { action: 'saveMember', mail: MEMBER, displayName: 'X' }, /使えない項目があります: mail。saveMember で使える項目: email/);
  fails(env, { action: 'health', verbose: true }, /使えない項目があります: verbose/);
  assert.equal(JSON.stringify(env.table('MEMBERS')), members0, '何も書かない');
  assert.equal(env.audit().length, audit0, '操作の記録も増えない（何も動かしていない）');
  assert.ok(env.errors().some((e) => e.where === 'OWNER.TASK' && /未定義の操作/.test(e.message)), 'エラーのログに残る');
  assert.ok(env.runLog().some((r) => r.kind === 'OWNER.TASK' && r.status === 'FAILED'), '実行ログに残る');
  assert.ok(env.logs.some((l) => /OWNER_TASK dropAllTables: 失敗しました/.test(l)), 'エディタの実行ログに出る');
}

// ==== 3. メンバー・役割（画面の入口と同じ中の関数・同じ監査） ====
let memberRole;
{
  const { full } = ok(env, { action: 'saveMember', email: MEMBER, displayName: 'メンバー', department: '営業部' });
  assert.equal(full.auditAction, 'MEMBER.SAVE');
  assert.equal(full.result.member.email, MEMBER);
  assert.equal(env.table('MEMBERS').filter((m) => m.email === MEMBER)[0].department, '営業部');
  const a = audited(env, 'MEMBER.SAVE');
  assert.equal(a.end.entity_id, MEMBER);
  assert.equal(a.start.entity_type, 'MEMBER');

  ok(env, { action: 'grantRole', email: MEMBER, role: 'ADMIN', scopeType: 'ALL' });
  audited(env, 'ROLE.GRANT');
  assert.equal(env.table('ROLES').filter((r) => r.email === MEMBER && r.role === 'ADMIN').length, 1);
  // 社外のメールは中の関数が断る（入口と同じ判定。記録は FAILED）
  fails(env, { action: 'saveMember', email: OUTSIDER, displayName: 'X' }, /社内/);
  assert.equal(audits(env, 'MEMBER.SAVE', 'END').slice(-1)[0].result, 'FAILED');

  // 一覧: OWNER_TASK_RESULT には次の操作にそのまま写せる短い形、返り値と実行ログには全部
  const dir = ok(env, { action: 'listDirectory' });
  assert.equal(dir.rec.summarized, true);
  memberRole = dir.rec.result.roles.filter((r) => r.email === MEMBER)[0];
  assert.ok(memberRole.roleId && memberRole.rowVersion === 1, JSON.stringify(memberRole));
  assert.ok(dir.rec.result.members.some((m) => m.email === MEMBER && m.displayName === 'メンバー'));
  assert.ok(dir.full.result.members.some((m) => m.email === MEMBER && m.display_name === 'メンバー'), '全部の形');
  assert.equal(audits(env, 'DIRECTORY.LIST').length, 0, '読むだけの操作は記録しない（入口と同じ）');
  assert.ok(env.logs.some((l) => /^結果/.test(l) && l.includes('"display_name": "メンバー"')), '全部は実行ログに出る');
}

// ==== 4. 所有者だけ: 管理者の役割があっても、ほかの人は断る（何もせず、結果も書かず、断ったことを記録する） ====
{
  // 準備: MEMBER は全体の管理者（3 で付けた）
  const settings0 = JSON.stringify(env.table('SETTINGS'));
  const prevResult = env.props.OWNER_TASK_RESULT;
  const raw = JSON.stringify({ action: 'saveSetting', key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + 'x'.repeat(30) + '/edit' });
  for (const who of [MEMBER, OUTSIDER, '']) {
    env.as(who);
    env.props.OWNER_TASK = raw;
    assert.throws(() => env.call('apiOwnerTask()'), /権限がありません/, who);
    assert.equal(env.props.OWNER_TASK, raw, '頼みはそのまま');
    assert.equal(env.props.OWNER_TASK_RESULT, prevResult, '結果も書かない');
  }
  env.as(MEMBER);
  assert.equal(env.boot().user.isAdmin, true, 'MEMBER は管理者（役割は効いている）。管理の操作の入口は画面にも無い（2026-10-13）');
  assert.equal(typeof env.ctx.apiListDirectory, 'undefined');
  env.as(OWNER);
  assert.equal(JSON.stringify(env.table('SETTINGS')), settings0, '何も書かない');
  const denied = env.audit().filter((a) => a.phase === 'DENIED' && a.action === 'OWNER.TASK');
  assert.ok(denied.some((a) => a.actor_email === MEMBER), '断ったことは記録に残る');
  delete env.props.OWNER_TASK;
}

// ==== 5. 役割を外す（rowVersion つき）。外した役割をもう一度外すと止まる ====
{
  ok(env, { action: 'revokeRole', roleId: memberRole.roleId, rowVersion: memberRole.rowVersion });
  audited(env, 'ROLE.REVOKE');
  const row = env.table('ROLES').filter((r) => r.role_id === memberRole.roleId)[0];
  assert.equal(row.is_active, 'FALSE');
  fails(env, { action: 'revokeRole', roleId: memberRole.roleId, rowVersion: 2 }, /すでに外れています/);
  env.as(MEMBER);
  assert.equal(env.boot().user.isAdmin, false, '外した役割はすぐ効く');
  env.as(OWNER);
}

// ==== 6. 業務の設定 ====
const ext = Array.from({ length: 70 }, () => '');
const rec = (client, month, amount) => { const r = ext.slice(); r[40] = client; r[45] = 'ベース'; r[49] = '製品A'; r[56] = month; r[65] = amount; return r; };
const zac = env.makeBook('Veeva 売上分析ツール', { ['*' + past + '_actual_value']: { cols: 70, values: [ext.map((_, i) => 'c' + (i + 1)),
  rec('テスト製薬', D(past, 5, 15), 1200000), rec('ｻﾝﾌﾟﾙ製薬(株)', D(past, 6, 10), 300000)] } });
{
  fails(env, { action: 'saveSetting', key: 'source.zac_spreadsheet', value: 'not a url' }, /URL で入力/);
  assert.equal(audits(env, 'SETTING.SAVE', 'END').slice(-1)[0].result, 'FAILED', '中の関数が断っても記録は残る');
  fails(env, { action: 'saveSetting', key: 'no.such.key', value: '1' }, /未定義の設定/);
  ok(env, { action: 'saveSetting', key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' });
  const a = audited(env, 'SETTING.SAVE');
  assert.equal(a.end.entity_id, 'source.zac_spreadsheet');
  const s = ok(env, { action: 'listSettings' }).rec.result.settings.filter((x) => x.key === 'source.zac_spreadsheet')[0];
  assert.equal(s.value, zac.getId());
  assert.equal(s.display, 'Veeva 売上分析ツール');
  assert.equal(s.isDefault, false);
}

// ==== 7. 計画: 候補 → 作る（裏の処理）→ 一覧 → 担当者（裏の処理）→ メーカーの表示名 ====
let planId;
{
  const cand = ok(env, { action: 'planCandidates' });
  assert.ok(cand.rec.result.candidates.includes('テスト製薬'), JSON.stringify(cand.rec.result));
  assert.ok(Number.isInteger(cand.rec.result.defaultFy));
  assert.ok(cand.full.result.candidates.some((c) => c.zac === 'テスト製薬'), '全部の形は表示名つき');

  const started = ok(env, { action: 'createPlan', clientName: 'テスト製薬', fy: currentFy, peopleCsv: '鷹野, 佐藤' });
  assert.equal(started.full.auditAction, 'JOB.START');
  assert.match(started.full.result.jobId, /^JOB-/);
  assert.match(started.rec.hint, /jobStatus/);
  const st = finishJob(env);   // 置き換わった頼み（jobStatus と jobId）のまま、もう一度実行する
  assert.equal(st.status, 'DONE', st.error);
  // jobId を省くと、自分が最後に始めた処理（続きの段はたどって、最後の段の状態）
  assert.equal(ok(env, { action: 'jobStatus' }).full.result.jobId, st.jobId);
  planId = st.result.planId;
  const plan = env.table('PLANS').filter((p) => p.plan_id === planId)[0];
  assert.equal(plan.fy, String(currentFy));
  assert.equal(plan.people_csv, '鷹野,佐藤');
  assert.equal(audits(env, 'PLAN.CREATE.SAVE', 'END').slice(-1)[0].actor_email, OWNER, '裏の処理が頼んだ人の名前で記録する');
  assert.equal(audits(env, 'PLAN.CREATE.SAVE', 'END').slice(-1)[0].result, 'OK');
  // 同じメーカー × 年度は作らない（中の関数の判定のまま）
  ok(env, { action: 'createPlan', clientName: 'テスト製薬', fy: currentFy, peopleCsv: '鷹野' });
  assert.match(finishJob(env).error, /すでにあります/);

  assert.ok(ok(env, { action: 'listPlans' }).rec.result.plans.some((p) => p.planId === planId));

  ok(env, { action: 'setPeople', planId, peopleCsv: '鷹野、田中' });
  const sp = finishJob(env);
  assert.equal(sp.status, 'DONE', sp.error);
  assert.equal(env.table('PLANS').filter((p) => p.plan_id === planId)[0].people_csv, '鷹野,田中');
  assert.equal(audits(env, 'PLAN.SETUP.PEOPLE', 'END').slice(-1)[0].result, 'OK');
  // 画面を開いた後に変わった（指紋が違う）なら書かない（入口と同じ）
  ok(env, { action: 'setPeople', planId, peopleCsv: '佐藤', inputHash: 'f'.repeat(64) });
  assert.match(finishJob(env).error, /データが変わりました/);
  assert.equal(env.table('PLANS').filter((p) => p.plan_id === planId)[0].people_csv, '鷹野,田中');
  // 計画が無ければ、始める前に止まる（apiStartJob と同じ判定）
  fails(env, { action: 'setPeople', planId: 'PL-none', peopleCsv: '鷹野' }, /計画が見つかりません/);

  const dir = ok(env, { action: 'listDirectory' }).rec.result;
  const client = dir.clients.filter((c) => c.zacName === 'テスト製薬')[0];
  assert.ok(client && client.auto === true);
  ok(env, { action: 'saveClientName', clientId: client.clientId, displayName: 'テスト', rowVersion: client.rowVersion });
  audited(env, 'CLIENT.NAME');
  const after = ok(env, { action: 'listDirectory' }).rec.result.clients.filter((c) => c.clientId === client.clientId)[0];
  assert.equal(after.displayName, 'テスト');
  assert.equal(after.auto, false);
  assert.equal(after.rowVersion, 1);
}

// ==== 7b. 指定した計画の売上取り込み・月別集計・予測: 同じ裏の処理、役割、監査と jobStatus を通す ====
{
  const jobs0 = jobProps(env);
  for (const action of ['importSales', 'aggregateSales', 'runForecast']) {
    for (const badId of [undefined, '', 123]) fails(env, { action, planId: badId }, /計画の ID/);
    fails(env, { action, planId: 'PL-none' }, /計画が見つかりません/);
  }
  for (const action of ['importSales', 'aggregateSales']) {
    fails(env, { action, planId, inputHash: 'abc' }, /inputHash.*64 桁/);
    fails(env, { action, planId, inputHash: 'f'.repeat(64) }, /画面が古い/);
  }
  fails(env, { action: 'runForecast', planId, confirms: ['extreme'] }, /使えない項目があります: confirms/);
  assert.equal(jobProps(env), jobs0, '入力の不備と古い指紋は、裏の処理を始める前に断る');

  // 所有者でなければ apiOwnerTask は断り、操作の結果も書き換えない
  const prevResult = env.props.OWNER_TASK_RESULT;
  env.as(MEMBER);
  for (const action of ['importSales', 'aggregateSales', 'runForecast']) {
    assert.throws(() => task(env, { action, planId }), /権限がありません/);
    assert.equal(env.props.OWNER_TASK_RESULT, prevResult);
  }
  env.as(OWNER);
  assert.equal(jobProps(env), jobs0, '所有者以外は処理を入れない');

  // 所有者の中の経路も、apiStartJob と同じ操作ごとの役割を求める
  for (const [action, role] of [['importSales', 'PLANNER'], ['aggregateSales', 'VIEWER'], ['runForecast', 'VIEWER']]) {
    assert.throws(() => env.call(`appOwnerRunAction_({ actor: __actor, requestId: 'REQ-SALES-DENIED',
      roles: [{ role: __role, scope_type: 'ALL', client_id: '' }] }, __task)`,
    { __actor: OWNER, __role: role, __task: { action, planId } }), /権限がありません/);
  }
  assert.equal(audits(env, 'JOB.START', 'DENIED').filter(a => a.request_id === 'REQ-SALES-DENIED').length, 3);
  assert.equal(jobProps(env), jobs0);

  for (const [action, planAction, sheet] of [['importSales', 'IMPORT.SALES', 'SALES_INPUT'], ['aggregateSales', 'SALES.AGGREGATE', 'SALES_MONTHLY']]) {
    const inputHash = env.run('appOwnerPlanHash_(__p)', { __p: planId });
    // 取り込みは現在の指紋を省略補完し、集計は明示した現在の指紋を使う
    const started = ok(env, Object.assign({ action, planId }, action === 'aggregateSales' ? { inputHash } : {}));
    const queued = env.call('appJobGet_(__id)', { __id: started.full.result.jobId });
    assert.equal(queued.kind, 'PLAN.RUN');
    assert.deepEqual(queued.payload, { planId, action: planAction, args: {}, inputHash });
    assert.equal(queued.requestedBy, OWNER);
    const done = finishJob(env);
    assert.equal(done.status, 'DONE', done.error);
    assert.ok(done.result.changed.includes(sheet), JSON.stringify(done.result));
    const saved = sheet === 'SALES_INPUT' ? env.table('ENG_SALES_INPUT') : env.table('ENG_ROWS').filter(r => r.sheet === sheet);
    assert.ok(saved.some(r => r.plan_id === planId), action + ' の結果がデータ本体に残る');
    for (const stage of ['BUILD', 'CALC', 'SAVE']) {
      const audit = audits(env, 'PLAN.' + planAction + '.' + stage, 'END').slice(-1)[0];
      assert.equal(audit.result, 'OK');
      assert.equal(audit.actor_email, OWNER);
    }
  }

  // 主観入力のない通常の計画は、既存の予測の確かめ方で止まる。所有者の入口でも確認を勝手に通さない
  const started = ok(env, { action: 'runForecast', planId });
  const queued = env.call('appJobGet_(__id)', { __id: started.full.result.jobId });
  assert.equal(queued.kind, 'FORECAST.RUN');
  assert.deepEqual(queued.payload, { planId });
  const before = env.table('FORECAST_RUNS').length;
  const done = finishJob(env);
  assert.equal(done.status, 'FAILED');
  assert.match(done.error, /未入力|足りません|不足/);
  assert.equal(env.table('FORECAST_RUNS').length, before);
  const audit = audits(env, 'FORECAST.RUN.CALC', 'END').slice(-1)[0];
  assert.equal(audit.result, 'FAILED');
  assert.equal(audit.actor_email, OWNER);
}

// ==== 8. バックアップ・手入れ・監査の鎖・状態（要約） ====
{
  ok(env, { action: 'enableBackup' });
  audited(env, 'BACKUP.ENABLE');
  assert.equal(env.triggers.filter((t) => t.handler === 'triggerDailyBackup').length, 1);
  ok(env, { action: 'enableBackup' });
  assert.equal(env.triggers.filter((t) => t.handler === 'triggerDailyBackup').length, 1, '2 度目は何もしない');
  ok(env, { action: 'runBackup' });
  audited(env, 'BACKUP.RUN');
  assert.equal(env.backups().length, 1);
  const hk = ok(env, { action: 'runHousekeeping' });
  assert.equal(hk.full.result.ok, true, JSON.stringify(hk.full.result.problems));
  audited(env, 'HOUSEKEEPING.RUN');
  const v = ok(env, { action: 'verifyAudit' });
  assert.equal(v.full.result.ok, true, JSON.stringify(v.full.result.months));
  audited(env, 'AUDIT.VERIFY');

  // 模擬のファイルの作成日は過去の時計で付くので、今取ったバックアップは今の時刻にする（26 時間より古いと要確認になる）
  env.backups().forEach((f) => { f.created = new Date(); });
  const h = ok(env, { action: 'health' });
  assert.equal(h.rec.summarized, true, '状態は要約して置く');
  assert.equal(h.rec.result.setUp, true);
  assert.equal(h.rec.result.ok, true, JSON.stringify(h.rec.result));
  assert.deepEqual(h.rec.result.warnings, []);
  assert.equal(h.rec.result.housekeeping.openStarts, 0, '手入れの数（終わりの無い開始）も残す');
  assert.equal(typeof h.rec.result.housekeeping.errors, 'number', '手入れの数（24 時間のエラー）も残す');
  assert.ok(h.rec.result.tables.count > 10);
  assert.equal(h.rec.result.tables.ok, h.rec.result.tables.count);
  assert.deepEqual(h.rec.result.tables.problems, []);
  assert.equal(h.rec.result.audit.ok, true);
  assert.equal(h.rec.result.backup.enabled, true);
  assert.equal(h.rec.result.triggers.triggerDailyBackup, 1);
  assert.equal(h.rec.result.housekeeping.ok, true);
  assert.ok(Array.isArray(h.full.result.tables), '全部の形（返り値・実行ログ）は表ごと');
  assert.equal(audits(env, 'HEALTH.CHECK').length, 0, '読むだけの操作は記録しない');
}

// ==== 9. 事前分布: 見比べる → 書く（裏の処理。作れる情報源が無ければ中の関数が止める） ====
{
  const pv = ok(env, { action: 'poolPreview' }).rec.result;
  assert.equal(pv.ready, false);
  assert.ok(pv.types.length > 0);
  ok(env, { action: 'poolApply' });
  const st = finishJob(env);
  assert.equal(st.status, 'FAILED');
  assert.match(st.error, /事前分布を作れる情報源がまだありません/);
  assert.equal(audits(env, 'LEARN.POOL', 'END').slice(-1)[0].result, 'FAILED');
}

// ==== 10. 年度の締め: 確認の指紋（inputHash）が要る。違う指紋・指紋なし・今年度は締めない ====
{
  const planBook = (client, fy) => {
    const output = [['FY' + fy + ' 売上予測（' + client + '）']];
    for (let r = 2; r <= 25; r++) output.push([]);
    output.push(['年度合計（予測）', 900, 1000, 1100]);
    output.push([], []);
    for (let i = 0; i < 12; i++) output.push([D(fy, 4 + i, 1), 70, 80, 90, '', '', '', 80, '']);
    return env.makeBook('予測 ' + client, { CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '鷹野']] }, OUTPUT: { values: output } });
  };
  for (const c of ['過去製薬', '過去薬品']) {
    const id = env.seedPlan(planBook(c, past));
    const sub = env.call('appTestVersionSubmit_(__in)', { __in: { planId: id } });
    env.call('appTestVersionDecide_(__in)', { __in: { versionId: sub.version.versionId, decision: 'APPROVED', rowVersion: sub.version.rowVersion } });
  }
  const pv = ok(env, { action: 'yearPreview', fy: past });
  assert.equal(pv.rec.result.canClose, true, JSON.stringify(pv.rec.result));
  assert.match(pv.rec.result.inputHash, /^[a-f0-9]{64}$/, '指紋は OWNER_TASK_RESULT から写せる');
  assert.equal(pv.rec.result.planCount, 2);
  assert.equal(audits(env, 'YEAR.PREVIEW').length, 0, '確認は何も書かない・記録しない（入口と同じ）');
  assert.equal(ok(env, { action: 'yearPreview', fy: currentFy }).rec.result.canClose, false);

  const jobs0 = jobProps(env);
  fails(env, { action: 'yearClose', fy: past }, /「内容を確認」/);
  fails(env, { action: 'yearClose', fy: past, inputHash: 'abc' }, /「内容を確認」/);
  fails(env, { action: 'yearClose', fy: currentFy, inputHash: pv.rec.result.inputHash }, /今年度/);
  assert.equal(jobProps(env), jobs0, '始める前に止まる（処理を入れない）');
  // 形は正しいが確認と違う指紋: 裏の処理が今の控えと比べて止める（何も凍結しない）
  ok(env, { action: 'yearClose', fy: past, inputHash: '0'.repeat(64) });
  const bad = finishJob(env);
  assert.equal(bad.status, 'FAILED');
  assert.match(bad.error, /確認したあとに年度の内容が変わりました/);
  assert.equal(env.table('YEAR_CLOSURES').length, 0);
  assert.equal(audits(env, 'YEAR.CLOSE', 'END').slice(-1)[0].result, 'FAILED');
  // 確認した指紋なら締まる
  ok(env, { action: 'yearClose', fy: past, inputHash: pv.rec.result.inputHash });
  const done = finishJob(env);
  assert.equal(done.status, 'DONE', done.error);
  assert.equal(done.result.state, 'CLOSED');
  assert.equal(done.result.planCount, 2);
  const closures = env.table('YEAR_CLOSURES');
  assert.equal(closures.length, 1);
  assert.equal(closures[0].closed_by, OWNER);
  const end = audits(env, 'YEAR.CLOSE', 'END').slice(-1)[0];
  assert.equal(end.result, 'OK');
  assert.equal(end.actor_email, OWNER);
  assert.equal(ok(env, { action: 'health' }).rec.result.years.years.filter((y) => y.fy === past)[0].state, 'CLOSED');
  assert.equal(ok(env, { action: 'yearPreview', fy: past }).rec.result.canClose, false, '締めた年度はもう締めない');
}

// ==== 11. ログ: 種類・月・絞り込み。大きい結果は OWNER_TASK_RESULT に要約、全部は実行ログに分けて出す ====
{
  for (let i = 0; i < 30; i++) {
    ok(env, { action: 'saveMember', email: MEMBER, displayName: 'メンバー' + i, department: '営業部 第' + i + '課（ログを大きくするための長い部署の名前）' });
  }
  const before = env.logs.length;
  const la = ok(env, { action: 'listAudit', kind: 'AUDIT' });
  const total = la.full.result.rows.length;
  assert.ok(total > 60, '記録の行: ' + total);
  assert.equal(la.rec.summarized, true);
  assert.equal(la.rec.result.count, total, '件数は全部の数');
  assert.ok(la.rec.result.rows.length < total, '置く行は先頭（新しい方）だけ');
  assert.match(String(la.rec.result.rows[la.rec.result.rows.length - 1]), /ほか \d+ 件/);
  assert.deepEqual(Object.keys(la.rec.result.rows[0]), ['at', 'actor', 'action', 'phase', 'result', 'entity', 'error'], '要る列だけ');
  assert.match(la.rec.note, /全部は実行ログ/);
  // 実行ログを分けて出した全部をつなげると、元の結果になる
  const parts = env.logs.slice(before).filter((l) => /^結果（\d+\/\d+）: /.test(l));
  assert.ok(parts.length >= 2, '長い結果は分けて出す: ' + parts.length);
  const joined = JSON.parse(parts.map((l) => l.replace(/^結果（\d+\/\d+）: /, '')).join(''));
  assert.equal(joined.result.rows.length, total);
  assert.equal(joined.action, 'listAudit');

  const runs = ok(env, { action: 'listAudit', kind: 'RUN' }).rec.result;
  assert.equal(runs.kind, 'RUN');
  assert.ok(runs.rows.some((r) => r.kind === 'OWNER.TASK' && r.status === 'OK'), '操作ごとに実行ログ（RUN）に残る');
  const errs = ok(env, { action: 'listAudit', kind: 'ERROR' }).rec.result;
  assert.ok(errs.rows.some((r) => r.where === 'OWNER.TASK'));
  const q = ok(env, { action: 'listAudit', kind: 'AUDIT', query: 'ROLE.REVOKE' }).full.result;
  assert.ok(q.rows.length >= 2 && q.rows.every((r) => JSON.stringify(r).includes('ROLE.REVOKE')));
  // 月の指定（無い月は空）
  assert.equal(ok(env, { action: 'listAudit', kind: 'AUDIT', month: '2001_01' }).rec.result.count, 0);
}

// ==== 12. 結果を縮める仕組み: どんな大きさでも 1 つの値の上限に収まる ====
{
  const big = env.run(`(() => {
    const rows = []; for (let i = 0; i < 3000; i++) rows.push({ id: 'R' + i, text: '長い文字'.repeat(200), nested: { list: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], s: 'x'.repeat(1000) } });
    const rec = appOwnerResultRecord_({ ok: true, action: 'listAudit', at: 'now', requestId: 'r', result: { rows: rows } }, {});
    return { bytes: appUtf8Bytes_(JSON.stringify(rec)), summarized: rec.summarized, n: rec.result.rows.length };
  })()`);
  assert.ok(big.bytes <= RESULT_MAX, String(big.bytes));
  assert.equal(big.summarized, true);
  assert.ok(big.n < 3000);
  const wide = env.run(`(() => { const o = {}; for (let i = 0; i < 5000; i++) o['k' + i] = '値'.repeat(50);
    const rec = appOwnerResultRecord_({ ok: true, action: 'x', result: o }, {}); return appUtf8Bytes_(JSON.stringify(rec)); })()`);
  assert.ok(wide <= RESULT_MAX, String(wide));
  const small = env.run(`appOwnerResultRecord_({ ok: true, action: 'x', result: { a: 1 } }, {})`);
  assert.equal(small.summarized, undefined, '小さい結果はそのまま');
}

// ==== 13. 操作ごとの役割の判定は弱めない（役割が足りなければ中の関数を動かさず、断ったことを記録する） ====
{
  const ran = env.call(`(() => { let ran = false;
    try { appOwnerRun_({ roles: [{ role: 'PLANNER', scope_type: 'ALL', client_id: '' }], actor: 'x@bigm2y.com', requestId: 'REQ-DENY' }, 'SETTING.SAVE',
      { minRole: 'ADMIN', entityType: 'SETTING', entityId: 'k' }, () => { ran = true; }); } catch (e) { return { ran: ran, error: e.message }; }
    return { ran: ran, error: '' }; })()`);
  assert.deepEqual(ran, { ran: false, error: 'この操作をする権限がありません。' });
  assert.ok(env.audit().some((a) => a.phase === 'DENIED' && a.action === 'SETTING.SAVE' && a.request_id === 'REQ-DENY'));
}

/** 中の関数 name を差し替えて、その途中で fn を動かす（body が終わったら元に戻す） */
function during(env, name, fn, body) {
  const orig = env.ctx[name];
  env.ctx[name] = function (...args) { fn(); return orig.apply(this, args); };
  try { return body(); } finally { env.ctx[name] = orig; }
}

// ==== 14. うまくいった後の頼み: 読むだけは残す・書いたら消す・裏の処理は jobStatus に置き換える。実行中に書き換えられた頼みは触らない ====
{
  // 操作の一覧と、このテストの分け方（READS・JOBS）がずれていない
  const kinds = env.call(`Object.keys(APP_OWNER_ACTIONS).map(k => [k, APP_OWNER_ACTIONS[k].job ? 'job' : APP_OWNER_ACTIONS[k].opts({}).audit === false ? 'read' : 'write'])`);
  assert.deepEqual(kinds.filter(([, k]) => k === 'read').map(([a]) => a).sort(), READS.slice().sort());
  assert.deepEqual(kinds.filter(([, k]) => k === 'job').map(([a]) => a).sort(), JOBS.slice().sort());

  // 読むだけ: 何度実行しても頼みはそのまま（読み直すだけ）
  const raw = JSON.stringify({ action: 'listPlans' });
  ok(env, { action: 'listPlans' });
  for (let i = 0; i < 2; i++) {
    assert.equal(rerun(env).ok, true);
    assert.equal(env.props.OWNER_TASK, raw);
  }

  const other = JSON.stringify({ action: 'listDirectory' });
  // 書く操作の途中で、所有者がプロパティを書き換えた: 書き換えた頼みは消さない
  during(env, 'appSaveMember_', () => { env.props.OWNER_TASK = other; }, () => {
    const full = task(env, { action: 'saveMember', email: MEMBER, displayName: 'メンバー' });
    assert.equal(full.ok, true);
    assert.match(full.hint, /^すぐに終わりました（書きました。裏の処理はありません）。OWNER_TASK は実行中に書き換えられていたので、そのままにしました。$/);
  });
  assert.equal(env.props.OWNER_TASK, other, '書き換えた頼みは消さない');
  audited(env, 'MEMBER.SAVE');

  // 裏の処理を始める途中で書き換えた: jobStatus に置き換えない（確かめ方は一言に書く）
  let jobId;
  during(env, 'appStartJobNow_', () => { env.props.OWNER_TASK = other; }, () => {
    const full = task(env, { action: 'setPeople', planId, peopleCsv: '鷹野' });
    jobId = full.result.jobId;
    assert.match(jobId, /^JOB-/);
    assert.ok(full.hint.endsWith('OWNER_TASK は実行中に書き換えられていたので、そのままにしました。結果は {"action":"jobStatus","jobId":"' + jobId + '"} で確かめられます。'), full.hint);
  });
  assert.equal(env.props.OWNER_TASK, other, '書き換えた頼みは置き換えない');
  env.props.OWNER_TASK = JSON.stringify({ action: 'jobStatus', jobId });
  assert.equal(finishJob(env).status, 'DONE');
  delete env.props.OWNER_TASK;
}

// ==== 15. 状態の要約: 監査の最後の行・バックアップ（無効・26 時間より古い）・年度の一覧のエラーは、どれも ok を false にする ====
{
  env.backups().forEach((f) => { f.created = new Date(); });
  const health = () => ok(env, { action: 'health' }).rec.result;
  const base = health();
  assert.equal(base.ok, true, JSON.stringify(base.warnings));

  // 控えた最新のハッシュと今月の最後の行が合わない（最後の行が消えた疑い）。鎖そのものはつながっている
  const hash = env.props.APP_AUDIT_LAST_HASH;
  env.props.APP_AUDIT_LAST_HASH = 'f'.repeat(64);
  let h;
  try { h = health(); } finally { env.props.APP_AUDIT_LAST_HASH = hash; }
  assert.equal(h.ok, false);
  assert.equal(h.audit.ok, true);
  assert.equal(h.audit.matchesLatest, false);
  assert.deepEqual(h.warnings, ['監査の最後の行が消えた疑いがあります']);

  // 毎日のバックアップが無効（トリガーが無い）
  const [trig] = env.triggers.splice(env.triggers.findIndex((t) => t.handler === 'triggerDailyBackup'), 1);
  try { h = health(); } finally { env.triggers.push(trig); }
  assert.equal(h.ok, false);
  assert.equal(h.backup.enabled, false);
  assert.deepEqual(h.warnings, ['毎日のバックアップが有効ではありません']);

  // 最新のバックアップが 26 時間より古い（26 時間までは止まっていない）
  env.backups().forEach((f) => { f.created = new Date(Date.now() - 30 * 3600e3); });
  h = health();
  assert.equal(h.ok, false);
  assert.equal(h.backup.ageHours, 30);
  assert.deepEqual(h.warnings, ['バックアップが 30 時間止まっています']);
  env.backups().forEach((f) => { f.created = new Date(Date.now() - 26 * 3600e3); });
  assert.equal(health().ok, true, '26 時間ちょうどは要確認にしない（画面と同じ）');
  env.backups().forEach((f) => { f.created = new Date(); });

  // 年度の一覧を読めない
  const orig = env.ctx.appYearStatus_;
  env.ctx.appYearStatus_ = () => { throw new Error('年度の表を読めません（テスト）'); };
  try { h = health(); } finally { env.ctx.appYearStatus_ = orig; }
  assert.equal(h.ok, false);
  assert.match(h.years.error, /テスト/);
  assert.deepEqual(h.warnings, ['年度の一覧を読めません']);

  assert.equal(health().ok, true, '元に戻せば ok');
}

// ==== 16. メーカーを足す・直す（saveClient。前の画面の入口と同じ CLIENT.SAVE で記録する） ====
{
  const added = ok(env, { action: 'saveClient', clientName: '新規製薬', zacCode: 'Z-1' });
  assert.equal(added.full.auditAction, 'CLIENT.SAVE');
  const id = added.full.result.client.client_id;
  assert.match(id, /^CL-/);
  const a = audited(env, 'CLIENT.SAVE');
  assert.equal(a.start.entity_type, 'CLIENT');
  assert.equal(a.end.entity_id, id);
  assert.equal(JSON.parse(a.end.after_json).client_name, '新規製薬', '変更後の値（res.client）が残る');

  // 一覧の短い形に、直すときに写す値（ZAC のコード・有効・メモ・メーカーの行の版）がある
  const c = ok(env, { action: 'listDirectory' }).rec.result.clients.filter((x) => x.clientId === id)[0];
  assert.deepEqual({ zacName: c.zacName, zacCode: c.zacCode, active: c.active, note: c.note, clientRowVersion: c.clientRowVersion, rowVersion: c.rowVersion },
    { zacName: '新規製薬', zacCode: 'Z-1', active: true, note: '', clientRowVersion: 1, rowVersion: '' });

  // 直す（今の値と clientRowVersion を写し、変えたい項目だけ変える）
  ok(env, { action: 'saveClient', clientId: id, clientName: c.zacName, zacCode: 'Z-2', isActive: false, note: c.note, rowVersion: c.clientRowVersion });
  const u = audited(env, 'CLIENT.SAVE');
  assert.equal(u.end.entity_id, id);
  // 開始の行にも、画面の入口と同じく対象のメーカー（entityId）と頼んだ中身（detail）が残る
  assert.equal(u.start.entity_type, 'CLIENT');
  assert.equal(u.start.entity_id, id, '開始の行の対象（opts の entityId）');
  const detail = JSON.parse(u.start.detail_json);
  assert.equal(detail.clientId, id, '開始の行の中身（opts の detail）');
  assert.equal(detail.zacCode, 'Z-2');
  let row = env.table('CLIENTS').filter((x) => x.client_id === id)[0];
  assert.equal(row.zac_code, 'Z-2');
  assert.equal(row.is_active, 'FALSE');
  assert.equal(String(row.row_version), '2');

  // 古い rowVersion: ほかの変更を上書きしない（記録は FAILED、頼みは残る）
  fails(env, { action: 'saveClient', clientId: id, clientName: '新規製薬', zacCode: 'Z-3', isActive: true, note: '', rowVersion: 1 }, /ほかの人が先に更新しました/);
  assert.equal(audits(env, 'CLIENT.SAVE', 'END').slice(-1)[0].result, 'FAILED');
  row = env.table('CLIENTS').filter((x) => x.client_id === id)[0];
  assert.equal(row.zac_code, 'Z-2', '書かない');
  assert.equal(String(row.row_version), '2');

  // 直すときに項目を省く・rowVersion が空・isActive が文字: 何もせずに止める（省いた項目が空や有効に戻らないように）
  const audit0 = env.audit().length;
  fails(env, { action: 'saveClient', clientId: id, clientName: '新規製薬', rowVersion: 2 }, /足りない項目: zacCode, isActive, note。/);
  fails(env, { action: 'saveClient', clientId: id, clientName: '新規製薬', zacCode: 'Z-2', isActive: false, note: '', rowVersion: '' }, /足りない項目: rowVersion。/);
  fails(env, { action: 'saveClient', clientName: '別の製薬', isActive: 'false' }, /isActive は true か false/);
  assert.equal(env.audit().length, audit0, '動かしていないので記録も増えない');
  assert.equal(env.table('CLIENTS').filter((x) => x.client_id === id)[0].zac_code, 'Z-2');

  // 同じ名前のメーカーは足さない（中の関数の判定のまま）
  fails(env, { action: 'saveClient', clientName: '新規製薬' }, /同じ名前のメーカーがすでにあります/);
}

// ==== 17. ログ: limit を省くと新しい 200 行まで。全部を実行ログに出せないときは「全部は実行ログ」と書かず、絞り方を言う ====
{
  env.run(`(() => { for (let i = 0; i < 220; i++) appAuditAppend_({ actor: '${OWNER}', action: 'TEST.FILL', phase: 'END', result: 'OK', entityType: 'SYSTEM', entityId: 'F' + i, requestId: 'REQ-FILL' }); })()`);
  assert.ok(env.audit().length > 220);
  const d = ok(env, { action: 'listAudit', kind: 'AUDIT' });
  assert.equal(d.full.result.rows.length, 200, '省くと 200 行');
  assert.equal(d.full.result.limit, 200);
  assert.equal(d.rec.result.count, 200);
  assert.equal(d.rec.result.limit, 200, '何行までにしたかを置く');
  assert.equal(d.rec.note, '要約です。全部は実行ログにあります。');
  const more = ok(env, { action: 'listAudit', kind: 'AUDIT', limit: 300 }).full.result;
  assert.equal(more.rows.length, 300);
  assert.equal(more.limit, 300);
  assert.equal(ok(env, { action: 'listAudit', kind: 'AUDIT', limit: 5000 }).full.result.limit, 2000, '最大 2000 行（画面と同じ）');

  // 長い行が多い: 実行ログの上限（4000 文字 × 60 回）に収まらない
  env.run(`(() => { for (let i = 0; i < 80; i++) appAuditAppend_({ actor: '${OWNER}', action: 'TEST.BIG', phase: 'END', result: 'OK', entityType: 'SYSTEM', entityId: 'B' + i, detail: { text: __big }, requestId: 'REQ-BIG' }); })()`, { __big: 'x'.repeat(3500) });
  const before = env.logs.length;
  const cut = ok(env, { action: 'listAudit', kind: 'AUDIT', query: 'TEST.BIG' });
  assert.equal(cut.full.result.rows.length, 80);
  assert.equal(cut.rec.summarized, true);
  assert.doesNotMatch(cut.rec.note, /全部は実行ログにあります/);
  assert.match(cut.rec.note, /limit を小さくするか、month・query で絞って/);
  const lines = env.logs.slice(before);
  assert.ok(lines.some((l) => /終わりました。OWNER_TASK_RESULT には要約を置きました。長すぎるので、下には途中までを出します。/.test(l)));
  assert.equal(lines.filter((l) => /^結果（\d+\/\d+）: /.test(l)).length, 60);
  assert.ok(lines.some((l) => /ここまでにしました（60\/\d+）。listAudit なら limit を小さくするか/.test(l)));
  // 絞れば全部を出せる
  const small = ok(env, { action: 'listAudit', kind: 'AUDIT', query: 'TEST.BIG', limit: 10 });
  assert.equal(small.rec.note, '要約です。全部は実行ログにあります。');
}

// ==== 18. 年度（fy）が要る操作: 無い・4 桁の数でないなら、裏の処理を入れる前に止める（頼みは残す） ====
{
  const jobs0 = jobProps(env);
  const triggers0 = env.triggers.length;
  const audit0 = env.audit().length;
  const tasks = [
    { action: 'createPlan', clientName: 'テスト製薬', peopleCsv: '鷹野' },
    { action: 'createPlan', clientName: 'テスト製薬', fy: 'abc', peopleCsv: '鷹野' },
    { action: 'createPlan', clientName: 'テスト製薬', fy: 27, peopleCsv: '鷹野' },
    { action: 'createPlan', clientName: 'テスト製薬', fy: 2027.5, peopleCsv: '鷹野' },
    { action: 'createPlan', clientName: 'テスト製薬', fy: null, peopleCsv: '鷹野' },
    { action: 'yearPreview' },
    { action: 'yearPreview', fy: '' },
    { action: 'yearClose', inputHash: '0'.repeat(64) },
    { action: 'yearClose', fy: '20255', inputHash: '0'.repeat(64) }
  ];
  for (const t of tasks) {
    const rec = fails(env, t, /には年度（fy）を 4 桁の数で入れてください/);
    assert.ok(rec.error.startsWith(t.action + ' には'), rec.error);
  }
  assert.equal(jobProps(env), jobs0, '処理を入れない');
  assert.equal(env.triggers.length, triggers0, 'トリガーも作らない');
  assert.equal(env.audit().length, audit0, '記録も増えない');
  // 文字の 4 桁は通す（数にして使う）
  assert.equal(ok(env, { action: 'yearPreview', fy: String(past) }).rec.result.canClose, false, '締めた年度');
}

// ==== 19. 一言（hint）: 裏の処理が始めたその場で終わった場合と、まだ終わっていない場合の両方を確かめた ====
assert.ok(seen.direct > 0 && seen.queued > 0, JSON.stringify(seen));

console.log('app-owner-task: all tests passed');
