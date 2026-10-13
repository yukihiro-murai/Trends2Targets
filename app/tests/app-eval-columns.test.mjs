#!/usr/bin/env node
/*
 * app-eval-columns.test.mjs — 新アプリで作った計画の B-2（検証レポートの更新）が、検証の表の列が足りずに止まらないこと（2026-10-08 F1）。
 * 旧来の B-2 は検証の表（EVAL_COMPARE_MONTHLY）の Y〜AJ 列（25〜36 列）に横の要約を書くが、旧来の A-1 が作る表は 26 列で、
 * 「The coordinates of the range are outside the dimensions of the sheet」で止まっていた。旧来の計算は変えず、新アプリが計算用ブックの表を広げる。
 *   1. 計画を作ると、データ本体の表の大きさ（ENG_SHEETS.max_columns）は 36 列（ほかのシートは A-1 のまま）
 *   2. 本物の A-1 → A-2 → A-3 → 入力 → 予測（年度の前）→ B-1 → B-2 が、テストの側で表を広げずに動き、今の検証の版の EVAL_LOG の行を書く
 *   3. この直しの前に作った計画（表が 26 列のまま保存されている）も、B-2 の前に広げるので動き、保存した大きさが 36 列になる。
 *      広げないと、モックでも本物と同じく範囲の外で止まる（直しが効いていることの確かめ）
 *   4. 36 列以上の表は変えない（減らさない・中身もハッシュも同じ）。足りない表は右に空の列を足すだけで、セルの値・表示形式は変えない
 * 数字はテスト用の作りもの。本物の Apps Script での確認の代わりではない。
 *
 *   node app/tests/app-eval-columns.test.mjs
 */
import assert from 'node:assert/strict';
import { setUpEnv, OWNER } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
/** 日本の時刻（月は 1 始まり） */
const jst = (y, m, d, H = 0, M = 0) => new Date(Date.UTC(y, m - 1, d, H - 9, M));
const CLIENTS = ['テスト製薬', '見本薬品'];
const env = setUpEnv();
const FY = env.run('appFy_(new Date())') - 1;   // 前の年度（年度の月は締まっている。B-2 で測る月がある）
const POLICY = env.run('APP_EVAL_POLICY_VERSION');
const engSheet = (planId, sheet) => env.table('ENG_SHEETS').find((r) => r.plan_id === planId && r.sheet === sheet);
const engRows = (planId, sheet) => env.table('ENG_' + sheet).filter((r) => r.plan_id === planId);

// ZAC の実績（年度の終わりまで）。2 つのメーカーの分
{
  const ext = Array.from({ length: 70 }, () => '');
  const rec = (client, product, month, amount) => { const r = ext.slice(); r[40] = client; r[45] = 'ベース'; r[49] = product; r[56] = month; r[65] = amount; return r; };
  const sheets = {};
  for (let y = FY - 5; y <= FY + 1; y++) {
    const rows = [ext.map((_, i) => 'c' + (i + 1))];
    for (let m = 1; m <= 12; m++) {
      const dt = D(y, m, 15);
      if (dt < D(FY - 5, 4, 1) || dt > D(FY + 1, 3, 31)) continue;
      CLIENTS.forEach((c, k) => {
        rows.push(rec(c, '製品A', dt, Math.round((1000000 + 50000 * Math.sin(m) + 12000 * (y - FY + 5) + m * 2000) * (k ? 0.6 : 1))));
        rows.push(rec(c, '製品B', dt, Math.round((400000 + 20000 * Math.cos(m)) * (k ? 0.5 : 1))));
      });
    }
    sheets['*' + y + '_actual_value'] = { cols: 70, values: rows };
  }
  const zac = env.makeBook('売上の元', sheets);
  env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
}

/** 予測を「今」= asOfMs で動かす（待ち行列に直接入れる。画面からは渡せない項目） */
function forecastAt(planId, asOfMs) {
  let id = env.run(`appWithLock_(() => appEnqueueJob_('FORECAST.RUN', { planId: __p, confirms: ['extreme'], asOfMs: __t }, __by, '').id)`, { __p: planId, __t: asOfMs, __by: OWNER });
  for (let i = 0; i < 60; i++) {
    env.fireTriggers('triggerRunJob');
    const st = env.call('apiJobStatus(__in)', { __in: { jobId: id } });
    if (st.status === 'CONTINUED') { id = st.nextJobId; continue; }
    if (st.status === 'QUEUED' || st.status === 'RUNNING') { id = st.jobId; continue; }
    assert.equal(st.status, 'DONE', st.error);
    return st.result;
  }
  throw new Error('続きの処理が終わらない');
}

/** A-2 → A-3 → 入力 → 予測（年度が始まる前の 3/20）→ B-1。ここまでは表の列に関係しない */
function prepare(planId) {
  for (const action of ['IMPORT.SALES', 'SALES.AGGREGATE']) {
    const st = env.runJob('PLAN.RUN', { planId, action });
    assert.equal(st.status, 'DONE', action + ': ' + st.error);
  }
  for (const [kind, row] of [['opinions', { person: '鷹野', ym: FY + '-05', step: '3', conf: '0.6', note: '' }],
    ['product', { person: '鷹野', product: '製品A', ym: FY + '-04', step: '5', reason: '新規' }], ['client', { person: '鷹野', ym: FY + '-04', step: '-3', reason: '全体' }]]) {
    const st = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind, rows: [row] }, inputHash: env.call('apiPlanView(__in)', { __in: { planId } }).inputHash });
    assert.equal(st.status, 'DONE', kind + ': ' + st.error);
  }
  forecastAt(planId, jst(FY, 3, 20, 10).getTime());
  const b1 = env.runJob('PLAN.RUN', { planId, action: 'IMPORT.ACTUALS' });
  assert.equal(b1.status, 'DONE', 'B-1: ' + b1.error);
}

/** B-2 の後: 今の検証の版の EVAL_LOG の行（締まった月 × 3 つのシナリオ）と B-2 の記録 */
function assertScored(planId, label) {
  const cur = engRows(planId, 'EVAL_LOG').filter((r) => r.evaluation_policy_version === POLICY);
  const months = [...new Set(cur.filter((r) => r.scenario === 'neutral').map((r) => String(r.target_month).slice(0, 7)))];
  assert.ok(months.length >= 6, label + ': B-2 が年度の締まった月を今の版で測った: ' + months.join(','));
  assert.equal(cur.length, months.length * 3, label + ': 月ごとに 3 つのシナリオ');
  const log = engRows(planId, 'RUN_LOG').filter((r) => r.function_name === 'updatePhase1EvaluationReport').slice(-1)[0];
  assert.ok(log && log.status === 'success', label + ': B-2 の記録');
  assert.match(log.error_summary, new RegExp('^' + POLICY + ': scored_months=' + months.length + ';'));
  // 横の要約（Y 列 = 25 列目から）も書けている
  const seg = env.table('ENG_ROWS').filter((r) => r.plan_id === planId && r.sheet === 'EVAL_COMPARE_MONTHLY' && r.row_no === '1');
  assert.ok(seg.some((s) => Number(s.col_from) <= 25 && JSON.parse(s.cells_json).some((x) => x === 's年間制約サマリー')), label + ': 年間の要約の見出し: ' + JSON.stringify(seg));
}

// ==== 1・2. ふつうに作った計画: 作った時点で 36 列。テストの側で広げずに B-2 まで動く ====
let planA;
{
  const st = env.runJob('PLAN.CREATE', { clientName: CLIENTS[0], fy: FY, peopleCsv: '鷹野' });
  assert.equal(st.status, 'DONE', st.error);
  planA = st.result.planId;
  assert.equal(engSheet(planA, 'EVAL_COMPARE_MONTHLY').max_columns, '36', '計画を作った時点で検証の表は 36 列');
  assert.equal(engSheet(planA, 'EVAL_LOG').max_columns, '26', 'ほかのシートは A-1 のまま（広げるのは検証の表だけ）');
  assert.equal(engSheet(planA, 'EVAL_COMPARE_MONTHLY').last_column, '23', '中身は A-1 の見出しのまま');
  prepare(planA);
  assert.equal(engSheet(planA, 'EVAL_COMPARE_MONTHLY').max_columns, '36', 'ほかの操作でも 36 列のまま');
  const b2 = env.runJob('PLAN.RUN', { planId: planA, action: 'EVAL.REPORT' });
  assert.equal(b2.status, 'DONE', 'B-2: ' + b2.error);
  assert.ok(b2.result.changed.includes('EVAL_COMPARE_MONTHLY') && b2.result.changed.includes('EVAL_LOG'), b2.result.changed.join(','));
  assertScored(planA, '新しい計画');
  assert.equal(engSheet(planA, 'EVAL_COMPARE_MONTHLY').max_columns, '36');
  assert.ok(Number(engSheet(planA, 'EVAL_COMPARE_MONTHLY').last_column) > 26, '要約は 26 列目より右にも書く（A-1 の 26 列のままでは書けなかった）');
  // もう一度 B-2（使い回しの計算用ブックでも、組み立て直しでも同じ）
  const again = env.runJob('PLAN.RUN', { planId: planA, action: 'EVAL.REPORT' });
  assert.equal(again.status, 'DONE', 'B-2 2 回目: ' + again.error);
  assert.equal(engSheet(planA, 'EVAL_COMPARE_MONTHLY').max_columns, '36');
}

// ==== 3. この直しの前に作った計画（26 列のまま保存）: B-2 の前に広げる。広げないと止まる ====
{
  const real = env.run('appEnsureMinColumns_');
  env.run('appEnsureMinColumns_ = function () { return []; }');   // 直しの前の動き（計画を作るときに広げない）
  const st = env.runJob('PLAN.CREATE', { clientName: CLIENTS[1], fy: FY, peopleCsv: '鷹野' });
  assert.equal(st.status, 'DONE', st.error);
  const planB = st.result.planId;
  assert.equal(engSheet(planB, 'EVAL_COMPARE_MONTHLY').max_columns, '26', '前提: 直しの前の計画は 26 列で保存されている');
  prepare(planB);
  // 広げないと、旧来の B-2 は範囲の外に書いて止まる（モックも本物と同じく止まる）
  const bad = env.runJob('PLAN.RUN', { planId: planB, action: 'EVAL.REPORT' });
  assert.equal(bad.status, 'FAILED', '広げないと止まる');
  assert.match(bad.error, /outside the dimensions of the sheet\. EVAL_COMPARE_MONTHLY 1,25,1000,12/);
  assert.equal(engSheet(planB, 'EVAL_COMPARE_MONTHLY').max_columns, '26', '止まった B-2 は何も書かない');
  // 直した後: B-2 の前に計算用ブックの表を広げるので動き、広げた大きさが保存される
  env.run('appEnsureMinColumns_ = __f', { __f: real });
  const b2 = env.runJob('PLAN.RUN', { planId: planB, action: 'EVAL.REPORT' });
  assert.equal(b2.status, 'DONE', 'B-2: ' + b2.error);
  assertScored(planB, '前に作った計画');
  assert.equal(engSheet(planB, 'EVAL_COMPARE_MONTHLY').max_columns, '36', '広げた大きさがふつうの保存で残る');
  // ほかの計画（A）は触らない
  assert.equal(engSheet(planA, 'EVAL_COMPARE_MONTHLY').max_columns, '36');
}

// ==== 4. 36 列以上の表は変えない。足りない表は右に空の列を足すだけ ====
{
  const H = env.run('APP_ENGINE_SHEETS.EVAL_COMPARE_MONTHLY.header');
  const row = H.map((h, i) => (h === 'target_month' ? FY + '/04' : i < 8 ? 1000 + i : ''));
  const wide = Array.from({ length: 40 }, () => ''); wide[37] = '右のメモ';   // 38 列目（AL）: B-2 が消さない列の値
  const book = env.makeBook('旧ブック', {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', 'テスト製薬'], ['[必須] 予測年度FY（YYYY）', FY], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    EVAL_COMPARE_MONTHLY: { values: [H.concat(Array(40 - H.length).fill('')).map((v, i) => (i === 37 ? '右のメモ' : v)), row], cols: 40, formats: { B: '¥#,##0' } },
  });
  const planC = env.seedPlan(book);
  const before = engSheet(planC, 'EVAL_COMPARE_MONTHLY');
  assert.equal(before.max_columns, '40');
  const r = env.call(`appWithLock_(() => {
    const scratch = appWorkScratch_(appPlanOf_(__p)); let st = null;
    do { st = appScratchBuildStep_(scratch, __p, ['EVAL_COMPARE_MONTHLY'], st && st.state, Date.now() + 60000); } while (!st.complete);
    const sh = scratch.getSheetByName('EVAL_COMPARE_MONTHLY');
    const hash = () => appEngEncodeSheet_(__p, appSheetSnapshot_(sh, APP_ENGINE_SHEETS.EVAL_COMPARE_MONTHLY.header.length)).sheetRow.content_hash;
    const h0 = hash();
    const widened = appEnsureMinColumns_(scratch);
    return { widened: widened, cols: sh.getMaxColumns(), same: hash() === h0, memo: sh.getRange(1, 38).getValue() };
  })`, { __p: planC });
  assert.deepEqual(r, { widened: [], cols: 40, same: true, memo: '右のメモ' }, '40 列の表は変えない（減らさない・中身のハッシュも同じ）');

  // 30 列の表（値・数式・表示形式あり）: 36 列まで足す。足す前のセルは値も表示形式もそのまま
  const s = env.call(`(() => {
    const ss = SpreadsheetApp.create('広げる確かめ');
    const sh = ss.insertSheet('EVAL_COMPARE_MONTHLY');
    sh.insertColumnsAfter(26, 4);
    sh.getRange(1, 1, 2, 3).setValues([['target_month', 'forecast_base', 'x'], ['2026/04', 1200, 'メモ']]);
    sh.getRange(2, 30).setValue('右端');
    sh.getRange(2, 2).setNumberFormat('¥#,##0');
    const read = () => JSON.stringify([sh.getRange(1, 1, 2, 30).getValues(), sh.getRange(1, 1, 2, 30).getNumberFormats()]);
    const b = read();
    const w = appEnsureMinColumns_(ss, ['EVAL_COMPARE_MONTHLY', 'OUTPUT']);   // 無いシートは何もしない
    const again = appEnsureMinColumns_(ss);
    return { w: w, again: again, cols: sh.getMaxColumns(), same: read() === b, tail: sh.getRange(1, 31, 2, 6).getValues() };
  })()`);
  assert.deepEqual(s.w, ['EVAL_COMPARE_MONTHLY']);
  assert.deepEqual(s.again, [], '2 回目は何もしない');
  assert.equal(s.cols, 36);
  assert.ok(s.same, '足す前のセルの値・表示形式はそのまま');
  assert.deepEqual(s.tail, [Array(6).fill(''), Array(6).fill('')], '足した列は空');
}

console.log('app-eval-columns: all tests passed');
