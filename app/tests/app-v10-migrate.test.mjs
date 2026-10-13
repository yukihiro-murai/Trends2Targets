/**
 * app-v10-migrate.test.mjs — 表の版 10 の移行（SCHEMA_PLAN_v10-12_JA.md の 3-10）。
 * 版 9 の姿のデータ本体（版 10 のコードの表の定義を版 9 に戻して初期設定したもの）から、版を上げた後の最初の操作で:
 * 列を後ろに足す・前の値は 1 文字も変えない・2 回動かしても同じ・見出しを書いた後に止まっても続きから終わる・
 * バックアップが取れなければ移行しない（読むだけで使える）・どの版でもない見出しなら何も書かない・締めた年度の控えと食い違わない。
 *
 *   node app/tests/app-v10-migrate.test.mjs
 */
import assert from 'node:assert/strict';
import { makeEnv, OWNER, sha } from './gas-mock.mjs';

const NEW_TABLES = ['INPUT_LOG', 'AI_RESEARCH_LOG', 'LAYER_EFFECTS', 'HIT_RECORDS', 'LEARNING_LOG', 'PERSON_LINKS', 'BACKTEST'];
// 版 9 の列（v0.29.0 の Schema.js のまま。移行の前の姿を、コードとは別に書く）
const V9 = {
  PLANS: ['plan_id', 'client_id', 'fy', 'client_label', 'people_csv', 'source_book_id', 'locale', 'time_zone', 'state', 'note',
    'created_at', 'created_by', 'updated_at', 'updated_by', 'row_version'],
  FORECAST_RUNS: ['run_id', 'plan_id', 'status', 'engine_version', 'engine_sha256', 'seed', 'as_of', 'input_hash',
    'annual_p10', 'annual_p50', 'annual_p90', 'objective_p10', 'objective_p50', 'objective_p90',
    'changed_sheets_json', 'confirms_json', 'started_at', 'finished_at', 'actor_email'],
};
const ADDED = { PLANS: ['purpose'], FORECAST_RUNS: ['app_version', 'seed_rule', 'fixes_json'] };
const D = (y, m, d = 1) => new Date(y, m - 1, d);

/** 年度 fy・メーカー名 client の計画のブック（OUTPUT に公式版に要る数字） */
function planBook(client, fy) {
  const output = [['FY' + fy + ' 売上予測（' + client + '）']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 900, 1000, 1100]);
  output.push([], []);
  for (let i = 0; i < 12; i++) output.push([D(fy, 4 + i, 1), 70, 80, 90, '', '', '', 80, '']);
  return { CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '担当A']] },
    PRODUCT: { values: [['Person', 'ProductName', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason'], ['担当A', '製品X', D(fy, 6, 1), 5, '理由']] },
    OUTPUT: { values: output } };
}

/** 版 9 の姿のデータ本体（版 10 の表の定義を版 9 に戻して初期設定する）。版 9 の間は最初の操作の移行を動かさない */
function v9Env({ closePast = false } = {}) {
  const env = makeEnv();
  env.run(`__V10 = JSON.parse(JSON.stringify(APP_TABLES));
    JSON.parse(__newTables).forEach(n => { delete APP_TABLES[n]; });
    const v9 = JSON.parse(__v9);
    Object.keys(v9).forEach(n => { APP_TABLES[n].columns = v9[n]; });`, { __newTables: JSON.stringify(NEW_TABLES), __v9: JSON.stringify(V9) });
  env.as(OWNER);
  env.call('apiSetup()');
  env.props.APP_TABLES_VERSION = String(env.run('APP_SCHEMA_VERSION'));   // 版 9 の姿の間は、最初の操作の移行を動かさない
  // _SCHEMA の版の欄も版 9 のころの姿にする（列のハッシュは版 9 の列のもの）
  const schema = env.data().getSheetByName('_SCHEMA');
  schema.rows.slice(1).forEach((r) => { if (r && r[0]) r[1] = '9'; });
  const currentFy = env.run('appFy_(new Date())');
  const past = currentFy - 1;
  const planA = env.seedPlan(env.makeBook('A', planBook('テスト製薬', past)));
  const planB = env.seedPlan(env.makeBook('B', planBook('テスト薬品', currentFy)));
  // 予測の回（版 9 の 19 列）。値は文字のまま持つ
  const runs = env.data().getSheetByName('FORECAST_RUNS');
  [[ 'FR-1', planA, 'DONE', 'eng-1', 'a'.repeat(64), 's1', '2026-01-05T09:00:00+0900', 'h1', '900', '1000', '1100', '', '950', '', '["OUTPUT"]', '', 't0', 't1', OWNER ],
   [ 'FR-2', planB, 'DONE', 'eng-1', 'b'.repeat(64), 's2', '2026-10-01T09:00:00+0900', 'h2', '1', '2', '3', '', '', '', '[]', '{"x":1}', 't0', 't1', OWNER ]]
    .forEach((r, i) => runs.getRange(2 + i, 1, 1, r.length).setNumberFormat('@').setValues([r]));
  env.run('APP_STORE_CACHE_ = {}');
  if (closePast) {
    const sub = env.call('apiVersionSubmit(__in)', { __in: { planId: planA } });
    env.call('apiVersionDecide(__in)', { __in: { versionId: sub.version.versionId, decision: 'APPROVED', rowVersion: sub.version.rowVersion } });
    const pv = env.task('yearPreview(__in)', { __in: { fy: past } });
    assert.equal(pv.canClose, true, JSON.stringify(pv));
    const st = env.runJob('YEAR.CLOSE', { fy: past, inputHash: pv.inputHash });
    assert.equal(st.status, 'DONE', JSON.stringify(st));
  }
  for (const n of Object.keys(V9)) assert.deepEqual([...env.data().getSheetByName(n).rows[0]], V9[n], '版 9 の姿: ' + n);
  for (const n of NEW_TABLES) assert.equal(env.data().getSheetByName(n), null, '版 9 には無い表: ' + n);
  return { env, planA, planB, past };
}

/** 版 10 のコードに戻す（表の定義を元に戻し、データ本体の版の印を 9 にする）。次の操作で移行が動く */
function toV10(env) {
  env.run('Object.keys(__V10).forEach(n => { APP_TABLES[n] = __V10[n]; }); APP_STORE_CACHE_ = {};');
  env.props.APP_TABLES_VERSION = '9';
}

/** データ本体の全部のシートの中身（比べるため） */
const sheetsOf = (env) => JSON.parse(JSON.stringify(env.data().sheets.map((s) => ({ name: s.name, rows: s.rows, maxCols: s.getMaxColumns() }))));
const cols = (env, n) => env.call(`APP_TABLES['${n}'].columns.slice()`);
const migrateAudits = (env) => env.audit().filter((a) => a.action === 'SCHEMA.MIGRATE');

/** 移行の後の姿: 見出し・_SCHEMA・新しい表・前の値が 1 文字も変わっていない（変わってよいのは _SCHEMA の移した表の行の版と記録だけ） */
function checkMigrated(env, before) {
  assert.equal(env.props.APP_TABLES_VERSION, String(env.run('APP_SCHEMA_VERSION')));
  for (const n of Object.keys(V9)) {
    assert.deepEqual([...env.data().getSheetByName(n).rows[0]], V9[n].concat(ADDED[n]), '後ろに列を足した: ' + n);
    assert.deepEqual(cols(env, n), V9[n].concat(ADDED[n]), '定義の終わりが足した列: ' + n);
  }
  for (const n of NEW_TABLES) assert.deepEqual([...env.data().getSheetByName(n).rows[0]], cols(env, n), '新しい表: ' + n);
  const schema = env.table('_SCHEMA');
  for (const n of Object.keys(V9)) {
    const s = schema.find((r) => r.table === n);
    assert.equal(s.schema_version, String(env.run('APP_SCHEMA_VERSION')), n);
    assert.equal(s.columns_hash, sha(V9[n].concat(ADDED[n]).join('|')), n);
  }
  for (const n of NEW_TABLES) assert.ok(schema.some((r) => r.table === n && r.columns_hash === sha(cols(env, n).join('|'))), '_SCHEMA に新しい表: ' + n);
  const after = Object.fromEntries(sheetsOf(env).map((s) => [s.name, s]));
  const schemaCols = cols(env, '_SCHEMA');
  for (const b of before) {
    const a = after[b.name];
    assert.ok(a, '前からあるシートは残る: ' + b.name);
    b.rows.forEach((row, r) => (row || []).forEach((v, c) => {
      if (b.name === '_SCHEMA' && r > 0 && ADDED[row[0]] && c >= 1) return;   // 移した表の行の版・ハッシュ・記録だけは書き直す
      assert.equal((a.rows[r] || [])[c], v, `前の値が変わった: ${b.name} ${r + 1} 行 ${c + 1} 列`);
    }));
    if (ADDED[b.name]) {
      const w = V9[b.name].length;
      a.rows.slice(1).forEach((row, r) => (row || []).slice(w).forEach((v) => assert.ok(v === '' || v === null || v === undefined, `前からある行の新しい列は空: ${b.name} ${r + 2}`)));
    }
    if (b.name === '_SCHEMA') assert.equal(schemaCols.length, b.rows[0].length);
  }
  const health = env.task('health()');
  assert.deepEqual(health.tables.filter((t) => !t.ok).map((t) => t.name + ' ' + t.note), [], '状態の点検が通る');
  return health;
}

// ==== 1. 版 9 → 版 10（締めた年度があるデータ本体）: 列を足す・前の値はそのまま・控えと食い違わない・2 回動かしても同じ ====
{
  const { env, planA, past } = v9Env({ closePast: true });
  const archived = env.table('YEAR_CLOSURES').find((r) => r.fy === String(past));
  assert.equal(archived.state, 'CLOSED');
  const before = sheetsOf(env);
  const backups0 = env.backups().length;
  assert.equal(backups0, 0, '今日のバックアップはまだ無い');
  toV10(env);
  // 列を足す前の表も読める（足した列は空）。書くと止まる
  const plans0 = env.run('appReadTable_("PLANS")').map((p) => ({ id: p.plan_id, purpose: p.purpose }));
  assert.ok(plans0.length === 2 && plans0.every((p) => p.purpose === ''), '列を足す前の表は、足した列を空で読む');
  assert.throws(() => env.run(`appWithLock_(() => appUpdateByKey_('PLANS', { plan_id: '${planA}' }, { note: 'x' }, undefined, 'test'))`), /移行がまだ/);
  // 一度だけの写しを数える（移行が済んだ後に 1 回だけ動く）
  env.run('__bf = 0; appV10BackfillInputLog_ = function(ctx) { __bf++; return { rows: 2 }; };');
  // 版を上げた後の最初の操作
  env.call('apiListPlans()');
  const health = checkMigrated(env, before);
  assert.equal(env.backups().length, 1, '移行の前にその日のバックアップを取った');
  assert.match(env.backups()[0].name, new RegExp('^Trends2Targets_Data_Backup_' + new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)));
  const ma = migrateAudits(env);
  assert.deepEqual(ma.map((a) => [a.phase, a.result]), [['START', ''], ['END', 'OK']], '監査に移行の開始と終わり');
  const beforeCols = JSON.parse(ma[0].before_json).tables;
  assert.deepEqual(beforeCols.map((t) => [t.table, t.columns]), [['PLANS', V9.PLANS], ['FORECAST_RUNS', V9.FORECAST_RUNS]], '前の列');
  assert.deepEqual(JSON.parse(ma[1].after_json).tables.map((t) => [t.table, t.columns, t.wroteHead]),
    [['PLANS', V9.PLANS.concat(ADDED.PLANS), true], ['FORECAST_RUNS', V9.FORECAST_RUNS.concat(ADDED.FORECAST_RUNS), true]], '後の列');
  assert.ok(JSON.parse(ma[0].detail_json).backup.taken, '詳しい記録にバックアップ');
  assert.ok(env.runLog().some((r) => r.kind === 'SCHEMA.MIGRATE' && r.status === 'OK'));
  assert.equal(env.run('__bf'), 1, '一度だけの写しは移行の後に動いた');
  // 締めた年度: 控えのファイルは締めたときのまま、今の行を控えの列で見ると控えと 1 文字も違わない。凍結も続く
  const file = env.files[archived.file_id];
  assert.equal(sha(file.content), archived.snapshot_sha256, '控えのファイルは締めたときのまま');
  const snap = JSON.parse(file.content);
  for (const t of snap.tables) {
    const keyIdx = t.key.map((k) => t.columns.indexOf(k));
    const want = new Map(t.rows.map((r) => [JSON.stringify(keyIdx.map((i) => r[i])), r]));
    const got = env.table(t.name).filter((o) => want.has(JSON.stringify(t.key.map((k) => o[k])))).map((o) => t.columns.map((c) => o[c] ?? ''));
    assert.equal(got.length, t.rows.length, '控えの行が全部ある: ' + t.name);
    for (const g of got) assert.deepEqual(g, want.get(JSON.stringify(keyIdx.map((i) => g[i]))), '控えと同じ: ' + t.name);
  }
  assert.deepEqual(snap.tables.find((t) => t.name === 'PLANS').columns, V9.PLANS, '控えは版 9 の列のまま');
  assert.equal(env.table('PLANS').find((p) => p.plan_id === planA).purpose, '', '締めた年度の計画の新しい列は空');
  assert.equal(health.years.years.find((y) => y.fy === past).state, 'CLOSED');
  assert.throws(() => env.run(`appWithLock_(() => appAppendLogRows_('INPUT_LOG', [{ plan_id: '${planA}', log_id: 'INL-X' }]))`), /締め済み/, '締めた年度の計画の記録は書けない');
  // 2 回目: 何も変わらない（版の印がそろっているので移行は動かない。印を戻しても同じ）
  const once = sheetsOf(env);
  env.call('apiListPlans()');
  env.props.APP_TABLES_VERSION = '9';
  env.call('apiListPlans()');
  assert.deepEqual(sheetsOf(env), once, '2 回動かしても同じ');
  assert.equal(migrateAudits(env).length, 2, '移すものが無ければ監査も足さない');
  assert.equal(env.backups().length, 1, 'バックアップも取り直さない');
  assert.equal(env.run('__bf'), 1, '済んだ写しはもう動かさない');
}

// ==== 2. 見出しを書いた後に止まっても、次の操作が続きから終わる ====
{
  const { env } = v9Env();
  const before = sheetsOf(env);
  toV10(env);
  env.data().getSheetByName('_SCHEMA').failWrites = true;   // PLANS の見出しを書いた後、_SCHEMA を書けずに止まる
  env.call('apiListPlans()');
  assert.equal(env.props.APP_TABLES_VERSION, '9', '版はそろえていない');
  assert.deepEqual([...env.data().getSheetByName('PLANS').rows[0]], V9.PLANS.concat(ADDED.PLANS), 'PLANS の見出しは書いた');
  assert.deepEqual([...env.data().getSheetByName('FORECAST_RUNS').rows[0]], V9.FORECAST_RUNS, 'FORECAST_RUNS はまだ');
  assert.ok(env.errors().some((e) => e.where === 'SCHEMA.ENSURE'), '止まったことをエラーのログに残す');
  assert.deepEqual(migrateAudits(env).map((a) => [a.phase, a.result]), [['START', ''], ['END', 'FAILED']]);
  // 止まっている間も読める（PLANS は新しい列・FORECAST_RUNS は前の列のまま）。操作のたびに続きを試す（書けなければまた止まる）
  assert.equal(env.call('apiListPlans()').plans.length, 2);
  const h = env.task('health()');
  assert.ok(h.tables.find((t) => t.name === 'FORECAST_RUNS').pending, '列を足す前の表は「移行がまだ」');
  assert.match(h.tables.find((t) => t.name === 'PLANS').note, /_SCHEMA と違う/, '見出しだけ新しい表は _SCHEMA が前のまま');
  env.data().getSheetByName('_SCHEMA').failWrites = false;
  env.call('apiListPlans()');
  checkMigrated(env, before);
  const ma = migrateAudits(env);
  assert.deepEqual(ma.slice(-2).map((a) => [a.phase, a.result]), [['START', ''], ['END', 'OK']]);
  assert.ok(ma.slice(0, -2).every((a) => a.phase === 'START' || a.result === 'FAILED'), '止まった回は FAILED');
  assert.deepEqual(JSON.parse(ma[ma.length - 2].detail_json).tables.map((t) => [t.table, t.resume]), [['PLANS', true], ['FORECAST_RUNS', false]], 'PLANS は _SCHEMA だけ');
  assert.equal(env.backups().length, 1, 'その日のバックアップがあれば取り直さない');
  // 続きから終えた後の姿は、止まらずに移したときと同じ（見出し・_SCHEMA・値は checkMigrated が確かめた）
  const once = sheetsOf(env);
  env.props.APP_TABLES_VERSION = '9';
  env.call('apiListPlans()');
  assert.deepEqual(sheetsOf(env), once, 'もう一度動かしても同じ');
}

// ==== 3. バックアップが取れなければ移行しない（列を足す前の表は読むだけで使える）。取れるようになったら移す ====
{
  const { env, planA } = v9Env();
  const before = sheetsOf(env);
  const archiveId = env.props.APP_ARCHIVE_FOLDER_ID;
  delete env.props.APP_ARCHIVE_FOLDER_ID;   // バックアップが止まる（複製を作る前に止まる）
  toV10(env);
  env.run('__bf = 0; appV10BackfillInputLog_ = function(ctx) { __bf++; return { rows: 1 }; };');
  const plans = env.call('apiListPlans()').plans;
  assert.equal(plans.length, 2, '画面は開ける（計画の一覧を読める）');
  assert.deepEqual(sheetsOf(env), before, 'データ本体は 1 つも変えない（表も作らない）');
  assert.equal(env.props.APP_TABLES_VERSION, '9');
  assert.equal(env.backups().length, 0);
  assert.ok(env.errors().some((e) => e.where === 'SCHEMA.ENSURE' && /バックアップが取れない/.test(e.message)));
  assert.equal(migrateAudits(env).length, 0, '監査の開始も書かない');
  assert.equal(env.run('__bf'), 0, '移行の前は一度だけの写しも動かさない');
  const h = env.task('health()');
  assert.deepEqual(h.tables.filter((t) => t.pending).map((t) => t.name), ['PLANS', 'FORECAST_RUNS']);
  assert.deepEqual(h.tables.filter((t) => t.missing).map((t) => t.name), NEW_TABLES);
  assert.throws(() => env.run(`appWithLock_(() => appUpdateByKey_('PLANS', { plan_id: '${planA}' }, { note: 'x' }, undefined, 'test'))`), /移行がまだ/, '列を足す前の表には書かない');
  assert.deepEqual(env.call(`appLogOps_('INPUT_LOG', [{ plan_id: '${planA}', log_id: 'INL-1' }])`), [], '版がそろう前は記録を足さない');
  // 取れない間は、操作のたびに複製を試さない（10 分あける）
  env.props.APP_ARCHIVE_FOLDER_ID = archiveId;
  env.call('apiListPlans()');
  assert.equal(env.props.APP_TABLES_VERSION, '9', 'まだ試さない');
  assert.ok(env.errors().some((e) => /まだしません/.test(e.message)));
  delete env.props.APP_MIGRATE_BACKUP_FAILED_AT;   // 10 分たった
  env.run('APP_STORE_CACHE_ = {}; appReadTable_("PLANS"); __stale = APP_STORE_CACHE_;');   // ほかの実行: 移行の前に読んだ控えを持ったまま
  env.call('apiListPlans()');
  checkMigrated(env, before);
  assert.equal(env.backups().length, 1);
  assert.equal(env.props.APP_MIGRATE_BACKUP_FAILED_AT, undefined);
  assert.equal(env.run('__bf'), 1);
  // 移行の前に読んだ控え（列を足す前）を持つ実行も、ロックを取ると見出しを読み直す。足した列に入った値を空で書き戻さない
  env.run(`APP_STORE_CACHE_ = {}; appWithLock_(() => appUpdateByKey_('PLANS', { plan_id: '${planA}' }, { purpose: 'MEASURE' }, undefined, 'test'));`);
  env.run(`APP_STORE_CACHE_ = __stale; appWithLock_(() => appUpdateByKey_('PLANS', { plan_id: '${planA}' }, { note: '移行の後' }, undefined, 'test'));`);
  const row = env.data().getSheetByName('PLANS').rows.find((r) => r && r[0] === planA);
  assert.equal(row.length, V9.PLANS.length + 1, '今の列の数で書く');
  assert.equal(row[V9.PLANS.indexOf('note')], '移行の後');
  assert.equal(row[V9.PLANS.length], 'MEASURE', '足した列の値はそのまま');
}

// ==== 4. どの版の列でもない表・足す場所に値がある表があれば、何も書かない（今までどおり） ====
{
  const { env } = v9Env();
  env.data().getSheetByName('PLANS').rows[0][9] = 'memo';   // 列の名前が違う
  const before = sheetsOf(env);
  toV10(env);
  try { env.call('apiListPlans()'); } catch (e) { /* PLANS を読めないので一覧は止まる */ }
  assert.deepEqual(sheetsOf(env), before, '何も書かない');
  assert.equal(env.backups().length, 0, 'バックアップも取らない');
  assert.equal(env.props.APP_TABLES_VERSION, '9');
  assert.ok(env.errors().some((e) => e.where === 'SCHEMA.ENSURE' && /表の列が定義と違います（PLANS）/.test(e.message)));
}
{
  const { env } = v9Env();
  const sh = env.data().getSheetByName('FORECAST_RUNS');
  sh.insertColumnsAfter(sh.getMaxColumns(), 2);
  sh.rows[2][19] = '手で書いた値';   // 足す場所（20 列目）に値がある
  const before = sheetsOf(env);
  toV10(env);
  env.call('apiListPlans()');
  assert.deepEqual(sheetsOf(env), before, '何も書かない');
  assert.equal(env.props.APP_TABLES_VERSION, '9');
  assert.ok(env.errors().some((e) => /列を足す場所に値があります（FORECAST_RUNS）/.test(e.message)));
}

console.log('app-v10-migrate: ok');
