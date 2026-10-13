#!/usr/bin/env node
/**
 * app-v11-drafts-migrate.test.mjs — 表の版 11 の移行（SCHEMA_PLAN_v10-12_JA.md の 4 章・3-10 の仕組み）と、予算の下書きの一度だけの写し。
 *   1. 版 10 の姿のデータ本体から: PLAN_VERSIONS の後ろに 9 列・前の値は 1 文字も変えない・BUDGET_DRAFTS を作る・バックアップ・監査・2 回動かしても同じ・
 *      締めた年度の控えと食い違わない。写し: 手で直した跡のある計画だけ BASELINE を 12 行（測る専用・締めた年度・跡の無い計画は写さない）。前の版は reach なし
 *   2. 版 9 の姿から、版 10 を通って版 11 まで 1 回で（PLANS・FORECAST_RUNS・PLAN_VERSIONS）
 *   3. 見出しを書いた後に止まっても続きから終わる。バックアップが取れない間は移さない（予算の保存は通る・公式版は止まる・予測は始めない）
 *   4. 写しより先に予測し直しても、直した予算を BASELINE として同じ控えに足して戻す（その後の写しは足さない）
 * モックの上の確かめで、本物の Apps Script の上では動かしていない。
 *
 *   node app/tests/app-v11-drafts-migrate.test.mjs
 */
import assert from 'node:assert/strict';
import { J, makeEnv, setUpEnv, OWNER, sha } from './gas-mock.mjs';

const fyYms = (fy) => Array.from({ length: 12 }, (_, i) => { const m = 4 + i; return (m > 12 ? fy + 1 : fy) + '/' + String(m > 12 ? m - 12 : m).padStart(2, '0'); });
const V10_VERSIONS = ['version_id', 'plan_id', 'version_no', 'state', 'input_hash', 'forecast_run_id', 'annual_p10', 'annual_p50', 'annual_p90',
  'budget_adopted', 'budget_uplift', 'budget_final', 'monthly_json', 'note', 'submitted_at', 'submitted_by', 'decided_at', 'decided_by',
  'decision_note', 'updated_at', 'updated_by', 'row_version'];
const ADDED = ['reach_final', 'reach_adopted', 'center', 'sd', 'tau', 'w', 'closed_months', 'prob_mode', 'prob_basis_json'];
const V9 = {
  PLANS: ['plan_id', 'client_id', 'fy', 'client_label', 'people_csv', 'source_book_id', 'locale', 'time_zone', 'state', 'note',
    'created_at', 'created_by', 'updated_at', 'updated_by', 'row_version'],
  FORECAST_RUNS: ['run_id', 'plan_id', 'status', 'engine_version', 'engine_sha256', 'seed', 'as_of', 'input_hash',
    'annual_p10', 'annual_p50', 'annual_p90', 'objective_p10', 'objective_p50', 'objective_p90',
    'changed_sheets_json', 'confirms_json', 'started_at', 'finished_at', 'actor_email'],
};
const V10_TABLES = ['INPUT_LOG', 'AI_RESEARCH_LOG', 'LAYER_EFFECTS', 'HIT_RECORDS', 'LEARNING_LOG', 'PERSON_LINKS', 'BACKTEST'];

/** 計画のブック（旧来の OUTPUT の形）。adopted を省くと真ん中（旧来の初期値） */
function book(env, client, fy, { adopted, uplift } = {}) {
  const yms = fyYms(fy);
  const p50 = yms.map((_, i) => 1000 + 10 * i);
  const o = [['FY' + fy + ' 売上予測（' + client + '）']];
  for (let r = 2; r <= 25; r++) o.push([]);
  o.push(['年度合計（予測）', 11000, 12660, 14000, '', '', '', '', '', ''], [], []);
  yms.forEach((ym, i) => o.push([ym, p50[i] - 100, p50[i], p50[i] + 100, '', '', '', adopted ? adopted[i] : p50[i], uplift ? uplift[i] : '', '']));
  const formulas = { H26: '=SUM(H29:H40)', I26: '=SUM(I29:I40)', J26: '=SUM(J29:J40)' };
  for (let i = 0; i < 12; i++) formulas['J' + (29 + i)] = `=H${29 + i}+I${29 + i}`;
  return env.makeBook(client, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    OUTPUT: { values: o, formulas, formats: { A: '@' } },
  });
}
const P50 = (fy) => fyYms(fy).map((_, i) => 1000 + 10 * i);
const edited = (fy) => ({ adopted: P50(fy).map((x, i) => (i === 3 ? x + 500 : x)), uplift: P50(fy).map((_, i) => (i === 11 ? 300 : '')) });

/** 旧来の予測（A-9）の代わり: 旧来と同じく採用予測を真ん中に・上乗せを空に書き直す（真ん中は 2 割上がる） */
const STUB = `__origEngine = appLegacyEngine_;
appLegacyEngine_ = function (svc) {
  const e = __origEngine(svc);
  e.runPhase1Forecast = function () {
    const out = svc.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('OUTPUT');
    for (let i = 0; i < 12; i++) {
      const p = 1200 + 12 * i;
      out.getRange(29 + i, 2, 1, 3).setValues([[p - 100, p, p + 100]]);
      out.getRange(29 + i, 8, 1, 2).setValues([[p, '']]);
    }
  };
  return e;
};`;

const sheetsOf = (env) => JSON.parse(JSON.stringify(env.data().sheets.map((s) => ({ name: s.name, rows: s.rows, maxCols: s.getMaxColumns() }))));
const migrateAudits = (env) => env.audit().filter((a) => a.action === 'SCHEMA.MIGRATE');
const nums = (env, planId) => env.call(`appPlanNumbers_('${planId}')`);

/**
 * 前の版の姿のデータ本体（版 11 のコードの表の定義を前の版に戻して初期設定する）。from = 10（BUDGET_DRAFTS が無く、PLAN_VERSIONS は 22 列）か
 * 9（それに加えて版 10 の 7 つの表が無く、PLANS・FORECAST_RUNS も前の列）。前の版の間は最初の操作の移行を動かさない。
 * 計画: edit（今の年度・手で直した予算）・plain（直していない）・measure（直したが測る専用）・past（前の年度・直した・公式版を承認して年度を締める）
 */
function oldEnv(from, { closePast = false } = {}) {
  const env = makeEnv();
  env.run(`__V11 = JSON.parse(JSON.stringify(APP_TABLES)); __ADDED = JSON.parse(JSON.stringify(APP_ADDED_COLUMNS));
    delete APP_TABLES.BUDGET_DRAFTS; delete APP_ADDED_COLUMNS.PLAN_VERSIONS; APP_TABLES.PLAN_VERSIONS.columns = JSON.parse(__pv);
    if (__from === 9) { JSON.parse(__v10t).forEach(n => { delete APP_TABLES[n]; }); const v9 = JSON.parse(__v9); Object.keys(v9).forEach(n => { APP_TABLES[n].columns = v9[n]; }); }`,
  { __pv: JSON.stringify(V10_VERSIONS), __from: from, __v10t: JSON.stringify(V10_TABLES), __v9: JSON.stringify(V9) });
  env.as(OWNER);
  env.call('apiSetup()');
  env.props.APP_TABLES_VERSION = '11';   // 前の版の間は、最初の操作の移行を動かさない（今の版の印にしておく）
  env.data().getSheetByName('_SCHEMA').rows.slice(1).forEach((r) => { if (r && r[0]) r[1] = String(from); });
  const fy = env.run('appFy_(new Date())');
  const ids = {
    edit: env.seedPlan(book(env, '直した製薬', fy, edited(fy))),
    plain: env.seedPlan(book(env, 'そのまま製薬', fy)),
    measure: env.seedPlan(book(env, '測る製薬', fy, edited(fy))),
    past: env.seedPlan(book(env, '前の製薬', fy - 1, edited(fy - 1))),
  };
  if (from === 10) env.call(`appWithLock_(() => appUpdateByKey_('PLANS', { plan_id: '${ids.measure}' }, { purpose: 'MEASURE' }, APP_ROW_UNCHECKED, '${OWNER}'))`);   // 版 9 には印の列が無い
  // 前の版の公式版（版 11 の列が無い）
  const sub = env.call('appTestVersionSubmit_(__in)', { __in: { planId: ids.edit, note: '前の版' } });
  if (closePast) {
    const s = env.call('appTestVersionSubmit_(__in)', { __in: { planId: ids.past } });
    env.call('appTestVersionDecide_(__in)', { __in: { versionId: s.version.versionId, decision: 'APPROVED', rowVersion: s.version.rowVersion } });
    const pv = env.task('yearPreview(__in)', { __in: { fy: fy - 1 } });
    assert.equal(pv.canClose, true, JSON.stringify(pv));
    const st = env.runJob('YEAR.CLOSE', { fy: fy - 1, inputHash: pv.inputHash });
    assert.equal(st.status, 'DONE', JSON.stringify(st));
  }
  assert.deepEqual([...env.data().getSheetByName('PLAN_VERSIONS').rows[0]], V10_VERSIONS, '前の版の姿: PLAN_VERSIONS');
  assert.equal(env.data().getSheetByName('BUDGET_DRAFTS'), null, '前の版には下書きの表が無い');
  if (from === 9) for (const n of Object.keys(V9)) assert.deepEqual([...env.data().getSheetByName(n).rows[0]], V9[n], '版 9 の姿: ' + n);
  env.run('APP_STORE_CACHE_ = {}');
  return { env, ids, fy, oldVersionId: sub.version.versionId };
}

/** 版 11 のコードに戻す（表の定義を元に戻し、データ本体の版の印を前の版にする）。次の操作で移行が動く */
function toV11(env, from) {
  env.run('Object.keys(__V11).forEach(n => { APP_TABLES[n] = __V11[n]; }); Object.keys(__ADDED).forEach(n => { APP_ADDED_COLUMNS[n] = __ADDED[n]; }); APP_STORE_CACHE_ = {};');
  env.props.APP_TABLES_VERSION = String(from);
}

/** 移行の後の姿: 見出し・_SCHEMA・新しい表・前の値が 1 文字も変わっていない（変わってよいのは _SCHEMA の移した表の行だけ） */
function checkMigrated(env, before, moved) {
  assert.equal(env.props.APP_TABLES_VERSION, '11');
  const cols = (n) => env.call(`APP_TABLES['${n}'].columns.slice()`);
  assert.deepEqual([...env.data().getSheetByName('PLAN_VERSIONS').rows[0]], V10_VERSIONS.concat(ADDED), 'PLAN_VERSIONS の後ろに 9 列');
  assert.deepEqual([...env.data().getSheetByName('BUDGET_DRAFTS').rows[0]], cols('BUDGET_DRAFTS'), '下書きの表を作った');
  const schema = env.table('_SCHEMA');
  for (const n of moved) {
    const s = schema.find((r) => r.table === n);
    assert.deepEqual([s.schema_version, s.columns_hash], ['11', sha(cols(n).join('|'))], '_SCHEMA: ' + n);
  }
  assert.ok(schema.some((r) => r.table === 'BUDGET_DRAFTS' && r.columns_hash === sha(cols('BUDGET_DRAFTS').join('|'))));
  const after = Object.fromEntries(sheetsOf(env).map((s) => [s.name, s]));
  for (const b of before) {
    const a = after[b.name];
    assert.ok(a, '前からあるシートは残る: ' + b.name);
    b.rows.forEach((row, r) => (row || []).forEach((v, c) => {
      if (b.name === '_SCHEMA' && r > 0 && moved.includes(row[0]) && c >= 1) return;
      assert.equal((a.rows[r] || [])[c], v, `前の値が変わった: ${b.name} ${r + 1} 行 ${c + 1} 列`);
    }));
  }
  const pv = env.data().getSheetByName('PLAN_VERSIONS');
  pv.rows.slice(1).forEach((row) => (row || []).slice(V10_VERSIONS.length).forEach((v) => assert.ok(v === '' || v === null || v === undefined, '前の版の新しい列は空')));
  const health = env.task('health()');
  assert.deepEqual(health.tables.filter((t) => !t.ok).map((t) => t.name + ' ' + t.note), [], '状態の点検が通る');
  return health;
}

// ==== 1. 版 10 → 版 11（締めた年度があるデータ本体）と、予算の下書きの写し ====
{
  const { env, ids, fy, oldVersionId } = oldEnv(10, { closePast: true });
  const archived = env.table('YEAR_CLOSURES').find((r) => r.fy === String(fy - 1));
  assert.equal(archived.state, 'CLOSED');
  const before = sheetsOf(env);
  const backups0 = env.backups().length;
  toV11(env, 10);
  // 列を足す前の表も読める（足した列は空）。書くと止まる
  assert.equal(env.call(`appVersionRows_('${ids.edit}')`).length, 1);
  assert.throws(() => env.run(`appWithLock_(() => appUpdateByKey_('PLAN_VERSIONS', { version_id: '${oldVersionId}' }, { note: 'x' }, APP_ROW_UNCHECKED, 'test'))`), /移行がまだ/);
  env.call('apiListPlans()');   // 版を上げた後の最初の操作
  const health = checkMigrated(env, before, ['PLAN_VERSIONS']);
  assert.equal(env.backups().length, backups0 + 1, '移行の前にその日のバックアップを取った');
  const ma = migrateAudits(env);
  assert.deepEqual(ma.map((a) => [a.phase, a.result]), [['START', ''], ['END', 'OK']]);
  assert.deepEqual(JSON.parse(ma[0].before_json).tables.map((t) => [t.table, t.columns]), [['PLAN_VERSIONS', V10_VERSIONS]]);
  assert.deepEqual(JSON.parse(ma[1].after_json).tables.map((t) => [t.table, t.columns, t.wroteHead]), [['PLAN_VERSIONS', V10_VERSIONS.concat(ADDED), true]]);
  assert.equal(JSON.parse(ma[0].detail_json).version, 11);
  // 一度だけの写し: 手で直した跡のある計画（edit）だけ 12 行。測る専用・締めた年度・跡の無い計画は写さない
  const d = env.table('BUDGET_DRAFTS');
  assert.deepEqual([...new Set(d.map((r) => r.plan_id))], [ids.edit]);
  assert.equal(d.length, 12);
  const n = nums(env, ids.edit);
  assert.deepEqual(d.map((r) => r.ym), fyYms(fy));
  assert.deepEqual(d.map((r) => r.adopted), n.monthly.map((m) => String(m.adopted)), '今の採用予測を写す');
  assert.deepEqual(d.map((r) => r.uplift), n.monthly.map((m) => (m.uplift === null ? '' : String(m.uplift))), '今の上乗せを写す');
  assert.deepEqual(d.map((r) => r.center), n.monthly.map((m) => String(m.p50)), 'そのときの月の真ん中');
  assert.ok(d.every((r) => r.action_id === 'BASELINE' && r.basis === 'BASELINE' && r.prob === '' && r.alloc === '' && r.actor_email === 'SYSTEM:V11_BACKFILL'));
  assert.equal(health.backfills.done.includes('appV11BackfillBudgetDrafts_'), true);
  assert.equal(JSON.parse(env.props.APP_BACKFILLS).done.appV11BackfillBudgetDrafts_.rows, 12);
  // もう一度動かしても足さない（下書きのある計画は飛ばす）
  assert.deepEqual(env.call(`appV11BackfillBudgetDrafts_({ actor: 'test', requestId: 'T' })`), { rows: 0 });
  assert.equal(env.table('BUDGET_DRAFTS').length, 12);
  // 前の版（列が空）は読めて、届く見込みは無い（後から作らない）。新しく出した版には入る
  const list = env.call('apiVersionList(__in)', { __in: { planId: ids.edit } });
  assert.equal(list.versions.find((v) => v.versionId === oldVersionId).reach, null);
  const sub = env.call('appTestVersionSubmit_(__in)', { __in: { planId: ids.edit } });
  assert.equal(sub.version.reach.mode, 'SHADOW');
  assert.equal(env.table('PLAN_VERSIONS').find((v) => v.version_id === sub.version.versionId).prob_mode, 'SHADOW');
  // 締めた年度: 控えのファイルは締めたときのまま。下書きは書けない
  const file = env.files[archived.file_id];
  assert.equal(sha(file.content), archived.snapshot_sha256, '控えのファイルは締めたときのまま');
  const snap = JSON.parse(file.content);
  const sv = snap.tables.find((t) => t.name === 'PLAN_VERSIONS');
  assert.deepEqual(sv.columns, V10_VERSIONS, '控えは版 10 の列のまま');
  for (const r of sv.rows) {
    const now = env.table('PLAN_VERSIONS').find((v) => v.version_id === r[0]);
    assert.deepEqual(V10_VERSIONS.map((c) => now[c] ?? ''), r, '控えの行と今の行（前の列）が同じ');
  }
  assert.throws(() => env.run(`appWithLock_(() => appAppendLogRows_('BUDGET_DRAFTS', [{ plan_id: '${ids.past}', draft_id: 'BDR-X', ym: '${fyYms(fy - 1)[0]}' }]))`), /締め済み/);
  // 予測し直すと、写した BASELINE に戻る（旧来の計算は真ん中に書き直す）
  env.run(STUB);
  const f = env.runJob('FORECAST.RUN', { planId: ids.edit });
  assert.equal(f.status, 'DONE', f.error);
  assert.deepEqual(nums(env, ids.edit).monthly.map((m) => [m.adopted, m.uplift]), n.monthly.map((m) => [m.adopted, m.uplift]), '予測し直しても直した予算のまま');
  assert.notDeepEqual(nums(env, ids.edit).monthly.map((m) => m.p50), n.monthly.map((m) => m.p50), '予測の数字は新しい回');
  const fp = env.runJob('FORECAST.RUN', { planId: ids.plain });
  assert.equal(fp.status, 'DONE', fp.error);
  assert.deepEqual(nums(env, ids.plain).monthly.map((m) => [m.adopted, m.uplift]), nums(env, ids.plain).monthly.map((m) => [m.p50, null]), '下書きの無い計画は真ん中');
  // 2 回目: 何も変わらない（版の印を戻しても同じ）
  const once = sheetsOf(env);
  env.props.APP_TABLES_VERSION = '10';
  env.call('apiListPlans()');
  assert.deepEqual(sheetsOf(env), once, '2 回動かしても同じ');
  assert.equal(migrateAudits(env).length, 2, '移すものが無ければ監査も足さない');
}

// ==== 2. 版 9 → 版 11 を 1 回で（版 10 の列と表も足す） ====
{
  const { env, ids } = oldEnv(9);
  const before = sheetsOf(env);
  toV11(env, 9);
  env.call('apiListPlans()');
  checkMigrated(env, before, ['PLANS', 'FORECAST_RUNS', 'PLAN_VERSIONS']);
  assert.deepEqual([...env.data().getSheetByName('PLANS').rows[0]], V9.PLANS.concat(['purpose']));
  assert.deepEqual([...env.data().getSheetByName('FORECAST_RUNS').rows[0]], V9.FORECAST_RUNS.concat(['app_version', 'seed_rule', 'fixes_json']));
  for (const n of V10_TABLES) assert.ok(env.data().getSheetByName(n), '版 10 の表も作った: ' + n);
  const ma = migrateAudits(env);
  assert.deepEqual(JSON.parse(ma[ma.length - 1].after_json).tables.map((t) => t.table), ['PLANS', 'FORECAST_RUNS', 'PLAN_VERSIONS']);
  // 版 9 の姿には測る専用の印が無いので、measure の計画も手で直した跡があれば写す（印は版 10 の後に付ける）
  assert.deepEqual([...new Set(env.table('BUDGET_DRAFTS').map((r) => r.plan_id))].sort(), [ids.edit, ids.measure, ids.past].sort());
}

// ==== 3. 見出しを書いた後に止まっても続きから終わる・バックアップが取れない間は移さない ====
{
  const { env, ids } = oldEnv(10);
  const before = sheetsOf(env);
  const archiveId = env.props.APP_ARCHIVE_FOLDER_ID;
  delete env.props.APP_ARCHIVE_FOLDER_ID;   // バックアップが止まる
  toV11(env, 10);
  env.call('apiListPlans()');
  assert.deepEqual(sheetsOf(env), before, 'データ本体は 1 つも変えない（表も作らない）');
  assert.equal(env.props.APP_TABLES_VERSION, '10');
  const h = env.task('health()');
  assert.deepEqual(h.tables.filter((t) => t.pending).map((t) => t.name), ['PLAN_VERSIONS']);
  assert.deepEqual(h.tables.filter((t) => t.missing).map((t) => t.name), ['BUDGET_DRAFTS']);
  // そのあいだ: 予算の保存は通る（下書きはまだ足さない）・公式版は書くところで止まる・予測は長い計算の前に断る
  const v = env.call('apiPlanView(__in)', { __in: { planId: ids.plain } });
  assert.equal(v.boot.budgetDraft, null, '下書きの表が無くても画面は開く');
  const st = env.runJob('PLAN.EDIT', { planId: ids.plain, action: 'BUDGET.SAVE', args: { rows: [{ row: 29, adopted: 1234 }] }, inputHash: v.inputHash });
  assert.equal(st.status, 'DONE', st.error);
  assert.equal(st.result.draft, null);
  assert.equal(nums(env, ids.plain).monthly[0].adopted, 1234);
  assert.throws(() => env.call('appTestVersionSubmit_(__in)', { __in: { planId: ids.plain } }), /表の列を足す移行がまだです（PLAN_VERSIONS）/);
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'FORECAST.RUN', payload: { planId: ids.plain } } }), /表の版 11 の移行（列を足す）がまだ済んでいないので、予測の実行は始めません/);
  // 取れるようになったら移す。_SCHEMA を書く前に止まっても、次の操作が続きから終わる
  env.props.APP_ARCHIVE_FOLDER_ID = archiveId;
  delete env.props.APP_MIGRATE_BACKUP_FAILED_AT;
  env.data().getSheetByName('_SCHEMA').failWrites = true;
  env.call('apiListPlans()');
  assert.equal(env.props.APP_TABLES_VERSION, '10', '版はそろえていない');
  assert.deepEqual([...env.data().getSheetByName('PLAN_VERSIONS').rows[0]], V10_VERSIONS.concat(ADDED), '見出しは書いた');
  env.data().getSheetByName('_SCHEMA').failWrites = false;
  env.call('apiListPlans()');
  assert.equal(env.props.APP_TABLES_VERSION, '11');
  const ma = migrateAudits(env);
  assert.deepEqual(JSON.parse(ma[ma.length - 2].detail_json).tables.map((t) => [t.table, t.resume]), [['PLAN_VERSIONS', true]], '続きは _SCHEMA だけ');
  assert.deepEqual(env.task('health()').tables.filter((t) => !t.ok).map((t) => t.name), []);
  // 保存した予算（1234）は、写しで BASELINE になる（手で直した跡）
  assert.equal(env.table('BUDGET_DRAFTS').filter((r) => r.plan_id === ids.plain && r.ym === fyYms(env.run('appFy_(new Date())'))[0])[0].adopted, '1234');
}

// ==== 4. 写しより先に予測し直しても、直した予算を BASELINE として同じ控えに足して戻す ====
{
  const env = setUpEnv();
  const fy = env.run('appFy_(new Date())');
  env.props.APP_BACKFILLS = JSON.stringify({ done: { appV11BackfillBudgetDrafts_: { at: 'x', v: 11, rows: 0 } }, failed: {} });   // 写しはまだこの計画を見ていない
  const planId = env.seedPlan(book(env, '先に予測製薬', fy, edited(fy)));
  const plain = env.seedPlan(book(env, '直していない製薬', fy));
  const n0 = nums(env, planId);
  env.run(STUB);
  const f = env.runJob('FORECAST.RUN', { planId });
  assert.equal(f.status, 'DONE', f.error);
  assert.equal(f.result.budgetRestored, 12);
  assert.deepEqual(nums(env, planId).monthly.map((m) => [m.adopted, m.uplift]), n0.monthly.map((m) => [m.adopted, m.uplift]), '直した予算を失わない');
  const d = env.table('BUDGET_DRAFTS');
  assert.equal(d.length, 12);
  assert.ok(d.every((r) => r.plan_id === planId && r.basis === 'BASELINE' && r.actor_email === 'SYSTEM:V11_BACKFILL'));
  assert.deepEqual(d.map((r) => r.center), n0.monthly.map((m) => String(m.p50)), '予測で上書きする前の真ん中');
  assert.ok(env.table('FORECAST_RUNS').some((r) => r.plan_id === planId), '予測の回と同じ控えで足した');
  // その後の写しは足さない（下書きがある）。直していない計画は写さない
  env.props.APP_BACKFILLS = JSON.stringify({ done: {}, failed: {} });
  assert.deepEqual(env.call(`appV11BackfillBudgetDrafts_({ actor: 'test', requestId: 'T' })`), { rows: 0 });
  assert.equal(env.table('BUDGET_DRAFTS').length, 12);
  assert.equal(env.runJob('FORECAST.RUN', { planId: plain }).status, 'DONE');
  assert.equal(env.table('BUDGET_DRAFTS').length, 12, '直した跡の無い計画は写さない');
  // 測る専用の計画は予算を立てないので、直した跡があっても写さない（旧来のとおり真ん中に戻る）
  const measure = env.seedPlan(book(env, '測る専用製薬', fy, edited(fy)));
  env.call(`appWithLock_(() => appUpdateByKey_('PLANS', { plan_id: '${measure}' }, { purpose: 'MEASURE' }, APP_ROW_UNCHECKED, '${OWNER}'))`);
  assert.equal(env.runJob('FORECAST.RUN', { planId: measure }).status, 'DONE');
  assert.equal(env.table('BUDGET_DRAFTS').length, 12, '測る専用の計画は写さない');
  assert.deepEqual(nums(env, measure).monthly.map((m) => [m.adopted, m.uplift]), nums(env, measure).monthly.map((m) => [m.p50, null]));
  assert.deepEqual(env.errors().filter((e) => /BUDGET_DRAFTS/.test(e.where)).map((e) => e.message), []);
}

console.log('app-v11-drafts-migrate: all tests passed');
