#!/usr/bin/env node
/*
 * app-forecast.test.mjs — 新アプリでの予測の実行（段階2-2b）の契約テスト。
 * 旧来の予測の代わり（決まった値を書く）で、計算 → 保存の 2 段の処理・確認が要るときの扱い・書き戻し（足された行だけ）・
 * 予測の記録（FORECAST_RUNS / FORECAST_MONTHLY）・計算の間にデータ本体が変わったときの止め方・権限を確かめる。
 * 乱数の種は、予測が読む表の中身と計算の版から決まる（同じ入力なら同じ数字。2026-10-08 決定 13）。ID は実行ごとに違う。
 * 本物の A-9 での確かめは app-forecast-seed.test.mjs。
 * 旧来の予測そのものは本物の GAS の上で確かめる（モックでは動かさない）。
 *
 *   node app/tests/app-forecast.test.mjs
 */

import assert from 'node:assert/strict';
import { J, MEMBER, OTHER, OWNER, setUpEnv, sha } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const SNAP_HEADER = ['snapshot_id', 'run_date', 'client', 'target_month', 'scenario', 'base_pred', 'subjective_adj', 'ai_adj', 'deterministic_adj', 'final_pred',
  'confidence_interval_lower', 'confidence_interval_upper', 'key_factors_json', 'subjective_input_date', 'calibration_applied_json'];
function legacyBook(env) {
  const output = [['FY2026 売上予測（テスト製薬）']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 900, 1000, 1100]);   // 26 行目
  output.push([], []);
  for (let i = 0; i < 12; i++) output.push([D(2026, 4 + i), 70, 80, 90]);   // 29〜40 行目
  return env.makeBook('クライアント別売上予測', {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', 'テスト製薬'], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    OUTPUT: { values: output },
    FORECAST_SNAPSHOT: {
      values: [SNAP_HEADER, ['S1', D(2026, 9, 1), 'テスト製薬', '2026/04', 'neutral', 80, 0, 0, 0, 80, 70, 90, '{}', '', '{}'],
        ['S1', D(2026, 9, 1), 'テスト製薬', '2026/05', 'neutral', 81, 0, 0, 0, 81, 71, 91, '{}', '', '{}']],
      formats: { D: '@' },
    },
    PROCESS_STATUS: {
      values: [['step_key', 'last_run_date', 'last_run_by', 'status', 'target_client', 'record_count', 'error_summary'],
        ['step4_status', D(2026, 9, 1), 'owner', 'success', 'テスト製薬', 12, '']],
    },
    CALIBRATION_STATE: {
      values: [['client', 'updated_at', 'updated_by', 'ai_weight_override', 'ai_max_abs_effect_override', 'ai_topic_disable_json', 'bias_correction_factor',
        'qual_scale_override', 'residual_month_bias_json', 'last_applied_quarter', 'last_applied_review_id', 'auto_update_enabled', 'note'],
      ['テスト製薬', D(2026, 9, 1), 'auto', '', '', '[]', 0.98, '', '{}', '', '', 1, '']],
    },
  });
}
/** 旧来の予測の代わり: 極端な入力の確認を求め、OUTPUT・FORECAST_SNAPSHOT（2 行足す）・PROCESS_STATUS を書く */
const STUB = `appLegacyEngine_ = function (svc) {
  return {
    WEB_UI_CONFIRMS_: {}, VERSION: 'stub-1', SOURCE_SHA256: 'stub',
    runPhase1Forecast() {
      if (!this.WEB_UI_CONFIRMS_.extreme) throw Object.assign(new Error('確認'), { webConfirm: { key: 'extreme', title: '極端な入力値', message: '製品Aの増減率が大きい' } });
      const ss = svc.SpreadsheetApp.getActiveSpreadsheet();
      ss.toast('予測を更新しています');
      const r = () => Math.round(Math.random() * 1000);
      const out = ss.getSheetByName('OUTPUT');
      out.getRange(26, 1, 1, 4).setValues([['年度合計（予測）', 100000 + r(), 200000 + r(), 300000 + r()]]);
      for (let i = 0; i < 12; i++) out.getRange(29 + i, 1, 1, 4).setValues([[new svc.Date(2026, 3 + i, 1), r(), 1000 + r(), 2000 + r()]]);
      out.getRange(65, 1, 1, 4).setValues([['年度合計（客観）', 90000 + r(), 190000 + r(), 290000 + r()]]);
      for (let i = 0; i < 12; i++) out.getRange(68 + i, 1, 1, 4).setValues([[new svc.Date(2026, 3 + i, 1), r(), 900 + r(), 1900 + r()]]);
      const snap = ss.getSheetByName('FORECAST_SNAPSHOT');
      const id = svc.Utilities.getUuid();
      snap.getRange(snap.getLastRow() + 1, 1, 2, 15).setValues([
        [id, new svc.Date(), 'テスト製薬', '2026/04', 'neutral', 1, 0, 0, 0, 1, 0, 2, '{}', '', '{}'],
        [id, new svc.Date(), 'テスト製薬', '2026/05', 'neutral', 2, 0, 0, 0, 2, 1, 3, '{}', '', '{}']]);
      ss.getSheetByName('PROCESS_STATUS').getRange(2, 2, 1, 3).setValues([[new svc.Date(), 'owner', 'success']]);
    }
  };
};`;
function imported() {
  const env = setUpEnv();
  const book = legacyBook(env);
  env.run(STUB);
  return { env, book, planId: env.seedPlan(book) };
}
const engRows = (env, sheet, planId) => env.table('ENG_' + sheet).filter((r) => r.plan_id === planId);
const sheetMeta = (env, planId) => Object.fromEntries(env.table('ENG_SHEETS').filter((r) => r.plan_id === planId).map((r) => [r.sheet, r]));

// ==== 0. 版を上げて足した表は、最初の操作で自動で作る（2026-10-02「表がありません（FORECAST_RUNS）」） ====
{
  const { env, planId } = imported();
  // 版 2 のころの状態にする（FORECAST_RUNS / FORECAST_MONTHLY が無い）
  for (const n of ['FORECAST_RUNS', 'FORECAST_MONTHLY']) env.data().deleteSheet(env.data().getSheetByName(n));
  env.props.APP_TABLES_VERSION = '2';
  const l = env.call('apiForecastLatest(__in)', { __in: { planId } });
  assert.equal(l.latest, null, '表が無くても画面を開ける');
  assert.ok(env.data().getSheetByName('FORECAST_RUNS') && env.data().getSheetByName('FORECAST_MONTHLY'), '足りない表を作った');
  assert.equal(env.props.APP_TABLES_VERSION, String(env.run('APP_SCHEMA_VERSION')));
  assert.ok(env.runLog().some((r) => r.kind === 'SCHEMA.ENSURE' && JSON.parse(r.detail_json).made.includes('FORECAST_RUNS')));
  // 社外の人の操作では作らない
  env.data().deleteSheet(env.data().getSheetByName('FORECAST_MONTHLY'));
  env.props.APP_TABLES_VERSION = '2';
  env.as('someone@gmail.com');
  env.boot();
  assert.equal(env.data().getSheetByName('FORECAST_MONTHLY'), null);
  env.as(OWNER);
  env.boot();
  assert.ok(env.data().getSheetByName('FORECAST_MONTHLY'));
}

// ==== 1. 実行の前: 旧ブックで最後に実行した結果を見せる ====
{
  const { env, planId } = imported();
  const l = env.call('apiForecastLatest(__in)', { __in: { planId } });
  assert.equal(l.latest, null);
  assert.deepEqual(l.stored.annual, { p10: 900, p50: 1000, p90: 1100 }, '取り込んだ OUTPUT の年度合計');
  assert.equal(l.stored.monthly.length, 12);
  assert.equal(l.stored.monthly[0].month, '2026/04');
  assert.deepEqual(l.plan, { planId, clientName: 'テスト製薬', fy: '2026' });
  assert.deepEqual(env.call('apiListPlans()').plans.map((p) => p.planId), [planId]);
}

// ==== 2. 確認が要るときは何も保存せず、確認の内容を返す。確認して実行すると、書き換わったシートだけを戻して記録を残す ====
{
  const { env, planId } = imported();
  const before = sheetMeta(env, planId);
  const dataBefore = env.data().getSheets().map((s) => [s.name, s.rows.length]);
  const st1 = env.runJob('FORECAST.RUN', { planId });
  assert.equal(st1.status, 'DONE', st1.error);
  assert.deepEqual(st1.result.needConfirm, { key: 'extreme', title: '極端な入力値', message: '製品Aの増減率が大きい' });
  assert.deepEqual(env.data().getSheets().map((s) => [s.name, s.rows.length]), dataBefore, '確認が要るときはデータ本体に書かない');
  assert.equal(env.table('FORECAST_RUNS').length, 0);
  const st2 = env.runJob('FORECAST.RUN', { planId, confirms: ['extreme'] });
  assert.equal(st2.status, 'DONE', st2.error);
  const r = st2.result;
  assert.match(r.runId, /^RUN-/);
  assert.deepEqual([...r.changed].sort(), ['FORECAST_SNAPSHOT', 'OUTPUT', 'PROCESS_STATUS'], '書き換わったシートだけ');
  assert.deepEqual(r.written.ENG_FORECAST_SNAPSHOT, { appended: 2 }, '履歴は足された行だけを書く');
  assert.equal(r.written.ENG_PROCESS_STATUS.replaced, true, '行が変わった表は入れ替える');
  assert.equal(engRows(env, 'FORECAST_SNAPSHOT', planId).length, 4);
  const after = sheetMeta(env, planId);
  for (const name of Object.keys(before)) {
    if (r.changed.includes(name)) {
      assert.equal(after[name].import_batch_id, r.runId, `${name} は予測の実行で書いた`);
      assert.notEqual(after[name].content_hash, before[name].content_hash);
    } else {
      assert.deepEqual(after[name], before[name], `${name} は変えない`);
    }
  }
  // 予測の記録
  const runs = env.table('FORECAST_RUNS');
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].run_id, runs[0].plan_id, runs[0].status, runs[0].engine_version, runs[0].actor_email],
    [r.runId, planId, 'DONE', 'stub-1', OWNER]);
  // 乱数の種: 予測が読む表の中身（シートごとのハッシュ）・計画の時差と地域・計算の版と中身・アプリの版から（実行の ID ではない）
  const seedSheets = env.run('APP_FORECAST_SEED_SHEETS');
  const fih = sha(env.table('ENG_SHEETS').filter((x) => x.plan_id === planId && seedSheets.includes(x.sheet)).map((x) => x.sheet + ':' + x.content_hash).sort().join('|'));
  const plan = env.table('PLANS').find((x) => x.plan_id === planId);
  assert.equal(runs[0].seed, sha(['forecast-seed-v1', fih, plan.time_zone, plan.locale, 'stub-1', 'stub', env.run('APP_VERSION')].join('|')), '種の作り方');
  assert.match(runs[0].seed, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(runs[0].confirms_json)[0], 'extreme');
  assert.ok(Number(runs[0].annual_p50) >= 200000 && Number(runs[0].annual_p50) <= 201000);
  assert.equal(Number(runs[0].annual_p50), r.headline.annual.p50);
  const monthly = env.table('FORECAST_MONTHLY');
  assert.equal(monthly.length, 12);
  assert.deepEqual([monthly[0].ym, Number(monthly[0].p50), Number(monthly[0].obj_p50)], ['2026/04', r.headline.monthly[0].p50, r.headline.objectiveMonthly[0].p50]);
  // 画面: 最新の予測
  const l = env.call('apiForecastLatest(__in)', { __in: { planId } });
  assert.equal(l.latest.run_id, r.runId);
  assert.equal(l.latest.annual_p50, r.headline.annual.p50, '数値の列は数値で返す');
  assert.equal(l.monthly.length, 12);
  assert.deepEqual(l.stored.annual, r.headline.annual, 'データ本体の OUTPUT も新しい結果になる');
  // データ本体から組み立て直すと、計算後の計算用ブックと同じ（値・表示形式）
  const scratch = env.scratch();
  const loaded = env.run('appEngLoadPlanSheets_(__p)', { __p: planId });
  for (const name of ['FORECAST_SNAPSHOT', 'PROCESS_STATUS', 'OUTPUT']) {
    const snap = env.run('appSheetSnapshot_(__s, __n)', { __s: scratch.getSheetByName(name), __n: Number(loaded[name].fmtCols) });
    assert.deepEqual(J(env.run('appEngCompare_(__a, __b)', { __a: snap, __b: loaded[name] })), [], `${name} が計算後のとおりに残る`);
  }
  // 記録: 組み立て → 計算（確認が要って止まる）、組み立て → 計算 → 保存
  const au = env.audit().filter((a) => /^FORECAST\.RUN/.test(a.action) && a.phase === 'END').map((a) => [a.action, a.result]);
  assert.deepEqual(au, [['FORECAST.RUN.BUILD', 'OK'], ['FORECAST.RUN.CALC', 'OK'], ['FORECAST.RUN.BUILD', 'OK'], ['FORECAST.RUN.CALC', 'OK'], ['FORECAST.RUN.SAVE', 'OK']]);
  assert.equal(env.props.APP_WRITE_JOURNAL, undefined, '書き終えたら保存の控えを消す');
  const journals = Object.values(env.files).filter((f) => f.kind === 'file' && /Journal_|保存の控え/.test(f.name));
  assert.ok(journals.length >= 1 && journals.every((f) => f.trashed), '控えのファイルはゴミ箱へ');
  // 2 回目: また足された行だけ
  const st3 = env.runJob('FORECAST.RUN', { planId, confirms: ['extreme'] });
  assert.equal(st3.status, 'DONE', st3.error);
  assert.deepEqual(st3.result.written.ENG_FORECAST_SNAPSHOT, { appended: 2 });
  assert.equal(engRows(env, 'FORECAST_SNAPSHOT', planId).length, 6);
  assert.equal(env.table('FORECAST_RUNS').length, 2);
  assert.notEqual(st3.result.runId, r.runId);
  // 同じ入力（予測が書いた OUTPUT・記録の表は種に入れない）: 同じ種・同じ P10/P50/P90。ID（snapshot_id）は回ごとに違う
  const runs2 = env.table('FORECAST_RUNS');
  assert.equal(runs2[1].seed, runs2[0].seed, '同じ入力なら同じ種');
  assert.notEqual(runs2[1].input_hash, runs2[0].input_hash, '前提: データ本体のハッシュ（予測が書いた表も入る）は変わった');
  assert.deepEqual(st3.result.headline, r.headline, '同じ入力なら同じ数字（年度・月・客観）');
  const mon = env.table('FORECAST_MONTHLY');
  const byRun = (id) => mon.filter((m) => m.run_id === id).map((m) => [m.ym, m.p10, m.p50, m.p90, m.obj_p10, m.obj_p50, m.obj_p90]);
  assert.deepEqual(byRun(st3.result.runId), byRun(r.runId), '月ごとの P10/P50/P90 も同じ');
  const sids = [...new Set(engRows(env, 'FORECAST_SNAPSHOT', planId).map((x) => x.snapshot_id))];
  assert.equal(sids.length, 3, 'snapshot_id は回ごとに違う（取り込んだ 1 回 + 予測 2 回）');
  // 入力を変えると種が変わる（CALIBRATION_STATE は予測が読む表。本物の保存と同じ控えと書き方でデータ本体へ）
  env.run(`appWithLock_(() => {
    const plan = appPlanOf_(__p); const scratch = appWorkScratch_(plan); let st = null;
    do { st = appScratchBuildStep_(scratch, __p, ['CALIBRATION_STATE'], st && st.state, Date.now() + 60000); } while (!st.complete);
    scratch.getSheetByName('CALIBRATION_STATE').getRange(2, 7).setValue(0.97);
    const cap = appCaptureChanged_(scratch, __p, appStoredHashes_(__p), ['CALIBRATION_STATE']);
    appJournalRun_({ actor: 'test', requestId: 'T' }, 'テストの準備', __p, appChangedOps_({ actor: 'test' }, __p, cap.changed, 'T'));
  })`, { __p: planId });
  const st4 = env.runJob('FORECAST.RUN', { planId, confirms: ['extreme'] });
  assert.equal(st4.status, 'DONE', st4.error);
  assert.notEqual(env.table('FORECAST_RUNS')[2].seed, runs2[0].seed, '入力が変われば種も変わる');
  const l2 = env.call('apiForecastLatest(__in)', { __in: { planId } });
  assert.equal(l2.runs.length, 3);
  assert.equal(env.state.lockHeld, false);
}

// ==== 3. 計算の間にデータ本体が変わったら、保存しない ====
{
  const { env, planId } = imported();
  const started = env.call('apiStartJob(__in)', { __in: { kind: 'FORECAST.RUN', payload: { planId, confirms: ['extreme'] } } });
  env.fireTriggers('triggerRunJob');   // 組み立てだけ動く（計算・保存は次のトリガー）
  const st = env.call('apiJobStatus(__in)', { __in: { jobId: started.jobId } });
  assert.equal(st.status, 'QUEUED', '終わった組み立てはたどり、次の計算を待っている');
  assert.equal(st.kind, 'FORECAST.RUN_CALC');
  const meta = env.data().getSheetByName('ENG_SHEETS');
  const H = meta.rows[0];
  meta.rows[1][H.indexOf('content_hash')] = 'changed-by-someone';
  env.fireTriggers('triggerRunJob');
  const st2 = env.call('apiJobStatus(__in)', { __in: { jobId: st.jobId } });
  assert.equal(st2.status, 'FAILED');
  assert.match(st2.error, /データ本体が変わりました/);
  assert.equal(env.table('FORECAST_RUNS').length, 0);
  assert.equal(engRows(env, 'FORECAST_SNAPSHOT', planId).length, 2, '書き戻さない');
}

// ==== 4. 権限: 予算策定担当（その計画のクライアント）以上。見るだけなら社内全員 ====
{
  const { env, planId } = imported();
  const clientId = env.table('PLANS')[0].client_id;
  env.task(`saveMember({ email: '${MEMBER}', displayName: 'M' })`);
  env.task(`saveMember({ email: '${OTHER}', displayName: 'O' })`);
  const other = env.task(`saveClient({ clientName: '別の製薬' })`).client;
  env.task('grantRole(__in)', { __in: { email: OTHER, role: 'PLANNER', scopeType: 'CLIENT', clientId: other.client_id } });
  env.as(MEMBER);
  assert.equal(env.call('apiForecastLatest(__in)', { __in: { planId } }).plan.planId, planId, '見るのは社内全員');
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'FORECAST.RUN', payload: { planId } } }), /権限がありません/, '閲覧だけの人は実行できない');
  env.as(OTHER);
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'FORECAST.RUN', payload: { planId } } }), /権限がありません/, 'ほかのクライアントの担当は実行できない');
  const denied = env.audit().filter((a) => a.action === 'JOB.START' && a.result === 'DENIED').slice(-1)[0];
  assert.equal(denied.client_id, clientId, '拒否の記録に計画のクライアントを残す');
  env.as(OWNER);
  env.task('grantRole(__in)', { __in: { email: MEMBER, role: 'PLANNER', scopeType: 'CLIENT', clientId } });
  env.as(MEMBER);
  const st = env.runJob('FORECAST.RUN', { planId, confirms: ['extreme'] });
  assert.equal(st.status, 'DONE', st.error);
  assert.equal(env.table('FORECAST_RUNS')[0].actor_email, MEMBER, 'その計画のクライアントの担当は実行できる');
  assert.throws(() => env.call(`apiStartJob({ kind: 'FORECAST.RUN', payload: { planId: 'PL-none' } })`), /計画が見つかりません/);
  assert.throws(() => env.call(`apiStartJob({ kind: 'FORECAST.RUN_SAVE', payload: { planId: '${planId}' } })`), /画面から始められません/);
}

console.log('app-forecast: all tests passed');
