#!/usr/bin/env node
/*
 * app-legacy-closed-months.test.mjs — 検証の決まり（2026-10-07 村井さん承認 D4〜D6）を、本物の旧来の計算をモックの上で動かして確かめる。
 *   0. 締まりの日数（月末から 5 日）は旧来の計算と新アプリで同じ数（新アプリに締まりの日数らしい名前が出てくれば、定数でもオブジェクトの中でも
 *      読める定義がちょうど 1 つあり、同じ値であること）
 *   1. B-1（実績の取り込み）: 月末から 3 日後の取り込みでは 9 月は open、6 日後なら closed（取り込んだ日時を source_updated_at に残す）
 *   2. B-2（検証）: 締まった月だけを、その月が始まる前の最後の予測（6/19 の回）で測る。後から作った回（10/02）は使わない。
 *      月が始まる前の予測が無い月（4〜6 月）は測らずに数える。前の版で書いた EVAL_LOG の行は消さない。
 *      検証の表の横の要約（年間・半期・四半期・幅の外）も、締まって測った月だけ
 *   3. B-3・B-4・B-5・C-1 は、前の版で書いた行（締まっていない月の途中の売上・後から作った予測で測った行）を使わない。
 *      B-4 の年間・半期の印も、検証の表の締まって測った月だけで判定する
 *   4. B-5 は締まった月だけで学ぶ（3 日後の取り込みでは 2 か月で足りず学ばない。6 日後なら 7〜9 月の 3 か月で、6/19 の予測から学ぶ）
 *   5. C-1 は締まった 3 か月（7〜9 月）を、6/19 の回の AI と人の押しで数える
 *   6. 計画の画面の「人の記入」（旧来の webParseEval_）も、今の決まりで測った月の行だけ（前からある行は消さず、出さない）
 *   7. 振り返り（学び・計画の画面の人の記入）は、予測と実績が今の B-2 の数字と同じ行だけ: B-2 → B-4 で出る・何も変えずに B-2 をもう一度でも
 *      出したまま（人の記入も）・前の版の数字の行と、実績を取り込み直した月の行は B-4 まで出さない。人の学びの scoredMonths
 *   8. 前の版の B-4 の行で、数字がたまたま今の版の B-2 と同じ行は、今の版の B-2 が初めて動いた後に B-4 が書き直すまで出さない
 *      （機械の列が前の決まりのまま）。B-4 の後は、人の記入を足して B-2 をもう一度動かしても出したまま
 *   9. 返品・値引きで実績が負の締まった月: B-4 は実績を 0 円と書くので、振り返りも 0 円で比べる（B-4 の後に出る）
 *  10. 検証の画面の scoredMonths: B-2 の前は 0、B-2 の後は測った月の数（どの月も売上 0 円で、精度の月が 0 でも）
 *  11. 同じ月の行が 2 つ（v0.27.2 より前の B-4 の残り）で、人の記入が最後の行に無い: B-4 は最後の行だけを書き直すが、学びと計画の画面は
 *      その月の人が書いた一番新しい行の記入を、書き直した行の数字で出す（計画の画面からその行に書ける）。人の学びの waitingMonths
 *      （B-2 が測ったのに振り返りの行がまだ無い月。締めた年度の計画は数えない）。2026-10-08 村井さん承認
 * 数字はテスト用の作りもの。本物の Apps Script での確認の代わりではない。
 *
 *   node app/tests/app-legacy-closed-months.test.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { setUpEnv, sources, repoRoot, uiHtml, OWNER } from './gas-mock.mjs';

/** 日本の時刻（月は 1 始まり） */
const jst = (y, m, d, H = 0, M = 0) => new Date(Date.UTC(y, m - 1, d, H - 9, M));
const CLIENT = 'テスト製薬';
const POLICY = 'policy-2026H1-v3';
const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';   // 計算用ブックの日付は別の realm で作られる
const ymOf = (v, t) => {
  if (isDate(v) || t === 'd') { const d = new Date(v); return d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0'); }
  return String(v);
};

// ==== 0. 締まりの日数は 1 つの数（旧来の計算）。新アプリが締まりの日数を持つなら、読める定義がちょうど 1 つで、同じ値 ====
{
  const legacySrc = await readFile(path.join(repoRoot, 'Forecast_Agent.js'), 'utf8');
  const lagOf = (text) => [...text.matchAll(/^\s*const ([A-Z_]*CLOSE_LAG_DAYS)\s*=\s*(\d+)\s*;/gm)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(lagOf(legacySrc), [['ACTUAL_CLOSE_LAG_DAYS', 5]], '旧来の計算: 月末から 5 日（1 か所だけ）');
  assert.deepEqual(lagOf(sources['LegacyEngine.js']), [['ACTUAL_CLOSE_LAG_DAYS', 5]], '新アプリに取り込んだ旧来の計算も同じ');
  // 新アプリ側（LegacyEngine.js 以外）は、締まりの日数らしい名前（close lag・closing days など。大文字・小文字・_ の有無を問わない）を全部拾い、
  // 定数（const X = n）でも、オブジェクトの中の値（closeLagDays: n）でも定義を読む。名前の決まりに合わない書き方の数を見落とさないよう、
  // 名前が 1 つでも出てくるなら、読める定義がちょうど 1 つで 5、出てくる名前はその定義か旧来の ACTUAL_CLOSE_LAG_DAYS だけ
  const appSide = closeLagAppSide(Object.fromEntries(Object.entries(sources).filter(([n]) => n !== 'LegacyEngine.js')));
  assert.deepEqual(appSide.problems, [], '新アプリの締まりの日数');
  appSide.defs.forEach(([n, k, v]) => assert.equal(v, 5, `${n} の ${k} は旧来の計算の ACTUAL_CLOSE_LAG_DAYS と同じ日数`));
  // 見つけ方そのものの確かめ（作りもののソース）: 名前の違い・オブジェクトの中・2 つ目の定義・数の違いを見落とさない
  assert.deepEqual(closeLagAppSide({ 'A.js': '// 締まりの話はまだ無い\nconst APP_TZ = 1;' }), { defs: [], problems: [] }, 'まだ持っていなければ比べるものが無い');
  assert.deepEqual(closeLagAppSide({ 'A.js': 'const APP_ACTUAL_CLOSE_LAG_DAYS = 5;   // 月末から\nfunction f_() { return APP_ACTUAL_CLOSE_LAG_DAYS; }' }),
    { defs: [['A.js', 'APP_ACTUAL_CLOSE_LAG_DAYS', 5]], problems: [] }, '定数');
  assert.deepEqual(closeLagAppSide({ 'A.js': 'const APP_LANDING = {\n  STALE_MONTHS: 3,\n  closeLagDays: 6\n};\nconst x = APP_LANDING.closeLagDays;' }).defs,
    [['A.js', 'closeLagDays', 6]], 'オブジェクトの中の値も読む（6 なら上の比べで落ちる）');
  assert.deepEqual(closeLagAppSide({ 'A.js': 'const APP_LANDING = { STALE_MONTHS: 3, CLOSING_DAYS: 5 };' }).defs, [['A.js', 'CLOSING_DAYS', 5]], '1 行のオブジェクト・closing days の名前');
  assert.ok(closeLagAppSide({ 'A.js': 'function f_() { return APP_CLOSE_LAG; }' }).problems.length, '名前はあるのに数が読めない');
  assert.ok(closeLagAppSide({ 'A.js': 'const APP_CLOSE_LAG_DAYS = 5;', 'B.js': 'const LANDING_CLOSE_LAG_DAYS = 5;' }).problems.length, '定義が 2 つ');
  assert.ok(closeLagAppSide({ 'A.js': 'const ACTUAL_CLOSE_LAG_DAYS = 5;' }).problems.length, '旧来の数と同じ名前の定義（Apps Script では二重の定義になる）');
  assert.deepEqual(closeLagAppSide({ 'A.js': 'function f_() { return ACTUAL_CLOSE_LAG_DAYS; }' }), { defs: [], problems: [] }, '旧来の数をそのまま使うなら同じ数になる');
  assert.match(legacySrc, /^const EVAL_CALENDAR_TZ = 'Asia\/Tokyo';/m, '日本の暦で数える');
  assert.match(sources['Config.js'], /const APP_TZ = 'Asia\/Tokyo';/, '新アプリの暦も日本');
}

/**
 * 新アプリのソース（{ ファイル名: 本文 }）の、締まりの日数の定義と問題: { defs: [[ファイル, 名前, 数]], problems: [文] }。
 * 名前は close lag / closing days らしいもの（closeLag・CLOSE_LAG_DAYS・closingDays など）。定義は const・let・var と、オブジェクトの中の「名前: 数」
 */
function closeLagAppSide(files) {
  const isLagName = (s) => /clos(?:e|ing)_?(?:lag|days?)/i.test(s);
  const defRe = /(?:\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|(?:^|[{,])\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*:)\s*(\d+(?:\.\d+)?)\b/gm;
  const defs = Object.keys(files).flatMap((n) => [...files[n].matchAll(defRe)].map((m) => [n, m[1] || m[2], Number(m[3])]).filter(([, k]) => isLagName(k)));
  const names = [...new Set(Object.values(files).flatMap((t) => (t.match(/[A-Za-z_$][\w$]*/g) || []).filter(isLagName)))].sort();
  const own = names.filter((k) => k !== 'ACTUAL_CLOSE_LAG_DAYS');   // 旧来の数をそのまま使う名前は、同じ数になる
  const problems = [];
  if (defs.some(([, k]) => k === 'ACTUAL_CLOSE_LAG_DAYS')) problems.push('旧来の ACTUAL_CLOSE_LAG_DAYS と同じ名前の定義がある');
  if (own.length && defs.length !== 1) problems.push('締まりの日数の名前（' + own.join(', ') + '）があるのに、読める定義が ' + defs.length + ' 個（ちょうど 1 つにする）');
  if (defs.length === 1) own.filter((k) => k !== defs[0][1]).forEach((k) => problems.push(k + ' は定義（' + defs[0][1] + '）と別の名前'));
  return { defs, problems };
}

const env0 = setUpEnv();
const H = env0.run('(() => { const o = {}; Object.keys(APP_ENGINE_SHEETS).forEach(k => { o[k] = APP_ENGINE_SHEETS[k].header || null; }); return o; })()');
const row = (sheet, o) => H[sheet].map((h) => (o[h] === undefined ? '' : o[h]));
const CONFIG = { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', CLIENT], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] };

// ==== 1. B-1: 取り込んだ日で締まりが決まる ====
{
  const env = env0;
  const ext = Array.from({ length: 70 }, () => '');
  const rec = (month, amount) => { const r = ext.slice(); r[40] = CLIENT; r[45] = 'ベース'; r[49] = '製品A'; r[56] = month; r[65] = amount; return r; };
  const zac = env.makeBook('Veeva 売上分析ツール', { '*2026_actual_value': { cols: 70, values: [ext.map((_, i) => 'c' + (i + 1)),
    rec(new Date(2026, 7, 20), 1000), rec(new Date(2026, 8, 20), 1000), rec(new Date(2026, 9, 2), 300)] } });
  env.call('apiSaveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
  const importAt = (at) => {
    const book = env.makeBook('クライアント別売上予測', {
      CONFIG,
      PROCESS_STATUS: { values: [H.PROCESS_STATUS, ['step1_status', new Date(2026, 3, 1), 'owner', 'success', CLIENT, 48, '']] },
      RUN_LOG: { values: [H.RUN_LOG] },
      ACTUAL_EVAL_MONTHLY: { values: [H.ACTUAL_EVAL_MONTHLY] },
    });
    env.run('appLegacyCall_(__book, { asOfMs: __at, seed: "b1", actor: "owner@bigm2y.com" }, "webRunImportActuals", [])', { __book: book, __at: at.getTime() });
    return book.getSheetByName('ACTUAL_EVAL_MONTHLY').getDataRange().getValues().slice(1)
      .map((r) => [ymOf(r[3]), r[5], isDate(r[6]) ? r[6].getTime() : r[6]]);
  };
  const at3 = jst(2026, 10, 3, 12);
  assert.deepEqual(importAt(at3), [['2026/08', 'closed', at3.getTime()], ['2026/09', 'open', at3.getTime()], ['2026/10', 'open', at3.getTime()]],
    '月末から 3 日後の取り込み: 9 月は締まっていない（前は取り込んだ日の暦だけで closed にしていた）');
  const at6 = jst(2026, 10, 6, 9);
  assert.deepEqual(importAt(at6), [['2026/08', 'closed', at6.getTime()], ['2026/09', 'closed', at6.getTime()], ['2026/10', 'open', at6.getTime()]],
    '6 日後の取り込み: 9 月は締まった');
  assert.deepEqual(importAt(jst(2026, 10, 5, 0, 0)).map((r) => r[1]), ['closed', 'closed', 'open'], '境目: 月末 + 5 日（10/05 0:00）は締まった');
  assert.deepEqual(importAt(jst(2026, 10, 4, 23, 59)).map((r) => r[1]), ['closed', 'open', 'open'], '境目: 10/04 23:59 は締まっていない');
}

// ==== 2〜5. B-2〜C-1（PLAN.RUN で本物の旧来の計算を動かす） ====
const FY_MONTHS = ['2026/04', '2026/05', '2026/06', '2026/07', '2026/08', '2026/09', '2026/10', '2026/11', '2026/12', '2027/01', '2027/02', '2027/03'];
/** 実績（取り込んだ値）。10 月以降は途中の売上（締まっていない） */
const ACT = { '2026/04': 1000, '2026/05': 1000, '2026/06': 1000, '2026/07': 1000, '2026/08': 1000, '2026/09': 1000, '2026/10': 300, '2026/11': 50, '2026/12': 40, '2027/03': 30 };
const PRE = 1100;   // 6/19 の回（R1）の P50: 7 月以降の月が始まる前の予測
const LATE = 900;   // 10/02 の回（R2）の P50: 後から作った予測（7〜10 月には使わない）
const R1_AT = jst(2026, 6, 19, 10), R2_AT = jst(2026, 10, 2, 10);
const QUANT = 1050; // 統計だけの予測（7〜9 月の実績 1000 は下 = 驚きは下向き）

/** acts = 実績（取り込んだ値。省くと ACT） */
function planBook(env, importedAt, extraInsights = [], acts = ACT) {
  const snap = [H.FORECAST_SNAPSHOT];
  const run = (sid, at, p50, factor) => FY_MONTHS.forEach((ym) => ['nega', 'neutral', 'posi'].forEach((sc, i) => {
    const v = p50 * [0.9, 1, 1.1][i];
    snap.push([sid, at, CLIENT, ym, sc, p50, 0, 0, 0, v, p50 * 0.9, p50 * 1.1, JSON.stringify({ opinion: '', forecast_source: 'forecast_open' }), '',
      JSON.stringify({ version: 'test', bias_correction_factor: factor, residual_month_bias_json: '' })]);
  }));
  run('R1', R1_AT, PRE, 1);
  run('R2', R2_AT, LATE, 0.9);
  // 前の決まりの B-1 で付いた印（取り込んだ日の暦: 9 月までは closed）
  const actual = [H.ACTUAL_EVAL_MONTHLY].concat(Object.keys(acts).map((ym) => [CLIENT, 'BASE', '製品A', ym, acts[ym], ym <= '2026/09' ? 'closed' : 'open', importedAt]));
  // 前の版の B-2（10/02 の回で、締まっていない月も測った）が書いた EVAL_LOG。この 30 行は消さない
  const evalLog = [H.EVAL_LOG];
  Object.keys(acts).forEach((ym) => ['nega', 'neutral', 'posi'].forEach((sc, i) => {
    const p = LATE * [0.9, 1, 1.1][i];
    evalLog.push(row('EVAL_LOG', { eval_id: 'OLD-' + ym + sc, evaluated_at: jst(2026, 10, 2, 11), client: CLIENT, target_month: ym, scenario: sc, pred: p, actual: acts[ym],
      ape: acts[ym] ? Math.abs(p - acts[ym]) / Math.abs(acts[ym]) : '', signed_error: p - acts[ym], abs_error: Math.abs(p - acts[ym]), bias_direction: p > acts[ym] ? 'over' : 'under',
      model_version: '2.4.0-dev', evaluation_policy_version: 'policy-2026H1-v2', constraint_relevant_flag: sc === 'neutral' ? 1 : 0 }));
  }));
  // 前の版の B-2 が書いた検証の表（途中の売上の月も誤差あり）
  const cmp = [H.EVAL_COMPARE_MONTHLY].concat(FY_MONTHS.map((ym) => {
    const a = acts[ym];
    return row('EVAL_COMPARE_MONTHLY', { target_month: ym, forecast_total: LATE, actual_total: a === undefined ? '' : a, forecast_total_p10: LATE * 0.9, forecast_total_p50: LATE,
      forecast_total_p90: LATE * 1.1, signed_error_p50: a === undefined ? '' : LATE - a, abs_error_p50: a === undefined ? '' : Math.abs(LATE - a),
      ape_p50: a === undefined || !a ? '' : Math.abs(LATE - a) / Math.abs(a), half_label: ym < '2026/10' ? 'FY2026-H1' : 'FY2026-H2', over_flag: a !== undefined && LATE > a ? 1 : 0,
      range_outside_flag: a === undefined ? '' : (a < LATE * 0.9 || a > LATE * 1.1 ? 1 : 0) });
  }));
  // C-1 の材料: 7〜9 月。6/19 の回（R1）は当たり、10/02 の回（R2）は外れ
  const impact = (id, at, ym, dir, k) => row('AI_IMPACT_HISTORY', { run_id: id, run_at: at, client: CLIENT, target_month: ym, k_ai: k, ai_direction: dir,
    pred_p50: id === 'R1' ? PRE : LATE, pred_p50_quant_only: QUANT, forecast_source: 'forecast_open' });
  const push = (id, at, ym, dir) => row('SUBJECTIVE_IMPACT_HISTORY', { run_id: id, run_at: at, client: CLIENT, target_month: ym, source_type: 'opinion', source_key: '鷹野',
    push_step: dir * 0.05, push_direction: dir, applied_reliability_r: 1, forecast_source: 'forecast_open' });
  const Q2 = ['2026/07', '2026/08', '2026/09'];
  return env.makeBook('クライアント別売上予測', {
    CONFIG,
    // 前の版の B-2 は 10/02 に動いた（B-1 の前。B-4 は B-2 が成功していれば動く）
    PROCESS_STATUS: { values: [H.PROCESS_STATUS, ['step2_status', importedAt, 'owner', 'success', CLIENT, 10, ''], ['step4_status', R2_AT, 'owner', 'success', CLIENT, 12, ''],
      ['step5_status', jst(2026, 10, 2, 11), 'owner', 'success', '', 30, '']] },
    RUN_LOG: { values: [H.RUN_LOG] },
    ACTUAL_EVAL_MONTHLY: { values: actual, formats: { D: '@' } },
    FORECAST_SNAPSHOT: { values: snap, formats: { D: '@' } },
    EVAL_LOG: { values: evalLog, formats: { D: '@' } },
    EVAL_COMPARE_MONTHLY: { values: cmp, cols: 40 },
    // 前の版の B-4 が書いた、締まっていない 11 月の行（消さない・書き換えない）
    EVAL_INSIGHTS: { values: [H.EVAL_INSIGHTS, row('EVAL_INSIGHTS', { evaluated_at: jst(2026, 10, 2, 12), client: CLIENT, target_month: '2026/11', actual_total: 50, pred_p50: LATE,
      diff: 50 - LATE, error_rate: (50 - LATE) / 50, diagnostic_type: 'range_breach', cause_bucket: 'range_outside', action_type: 'update', status: 'open', review_cycle: 'monthly_light' })]
      .concat(extraInsights), formats: { C: '@' } },
    DASHBOARD: { values: [H.DASHBOARD] },
    AI_IMPACT_HISTORY: { values: [H.AI_IMPACT_HISTORY].concat(Q2.map((ym) => impact('R1', R1_AT, ym, 'down', 0.997)), Q2.map((ym) => impact('R2', R2_AT, ym, 'up', 1.05))) },
    SUBJECTIVE_IMPACT_HISTORY: { values: [H.SUBJECTIVE_IMPACT_HISTORY].concat(Q2.map((ym) => push('R1', R1_AT, ym, -1)), Q2.map((ym) => push('R2', R2_AT, ym, 1))) },
    AI_SCORE_HISTORY: { values: [H.AI_SCORE_HISTORY] },
    CALIBRATION_STATE: { values: [H.CALIBRATION_STATE, [CLIENT, jst(2026, 10, 2), 'auto', '', '', '[]', 1, '', '', '', '', 1, '']] },
    CALIBRATION_HISTORY: { values: [H.CALIBRATION_HISTORY] },
    SOURCE_RELIABILITY: { values: [H.SOURCE_RELIABILITY] },
    POOL_PRIOR: { values: [H.POOL_PRIOR] },
    QUARTERLY_REVIEW: { values: [['']] },
    QUARTERLY_REVIEW_LOG: { values: [H.QUARTERLY_REVIEW_LOG] },
    RELIABILITY_EVIDENCE: { values: [H.RELIABILITY_EVIDENCE] },
  });
}

function setUpPlan(importedAt, extraInsights, acts) {
  const env = setUpEnv();
  // 見直し案を作る（C-1）はアプリで止めている（2026-10-07 決定 3）。ここでは旧来の計算の C-1 の数え方を確かめるので、止めを外して動かす
  env.run("APP_PLAN_ACTIONS['REVIEW.GENERATE'].paused = ''");
  const planId = env.seedPlan(planBook(env, importedAt, extraInsights, acts));
  const rows = (sheet) => env.table('ENG_' + sheet).filter((r) => r.plan_id === planId);
  const runAction = (action) => env.runJob('PLAN.RUN', { planId, action });
  const ok = (action) => { const st = runAction(action); assert.equal(st.status, 'DONE', action + ': ' + st.error); return st; };
  const metric = (name) => { const m = rows('DASHBOARD').find((r) => r.metric === name); return m ? m.value : undefined; };
  const cal = () => { const c = rows('CALIBRATION_STATE'); assert.equal(c.length, 1); return c[0]; };
  const shownInsights = () => env.call('apiPlanView(__in)', { __in: { planId } }).boot.eval.insights.map((r) => [r.month, r.row]);
  return { env, planId, rows, runAction, ok, metric, cal, shownInsights };
}
const evalByYm = (rows) => {
  const o = {};
  rows('EVAL_LOG').forEach((r) => { const ym = ymOf(r.target_month, r._types.charAt(3)); (o[ym] = o[ym] || []).push(r); });
  return o;
};
const cmpByYm = (rows) => { const o = {}; rows('EVAL_COMPARE_MONTHLY').forEach((r) => { o[ymOf(r.target_month, r._types.charAt(0))] = r; }); return o; };
/** 検証の表の横の要約（Y 列から。見出しの外なので ENG_ROWS に持つ）: { 見出し: [値…] } */
const sideSummary = (P) => {
  const v = P.env.call('appEngLoadPlanSheets_(__p, ["EVAL_COMPARE_MONTHLY"], true)', { __p: P.planId }).EVAL_COMPARE_MONTHLY.values;
  const o = {};
  v.forEach((r) => { if (r[24] !== '' && r[24] !== undefined) o[r[24]] = r.slice(25, 32); });
  return o;
};
const near = (a, b, msg) => assert.ok(Math.abs(Number(a) - b) < 1e-9, `${msg}: ${a} / ${b}`);

// ---- 3 日後に取り込んだ計画（9 月は締まっていない。締まった月は 4〜8 月で、月が始まる前の予測があるのは 7・8 月だけ） ----
{
  const P = setUpPlan(jst(2026, 10, 3, 9));
  const insightsBefore = JSON.stringify(P.rows('EVAL_INSIGHTS'));

  // 3. B-2 の前（前の版の行だけ）: B-3・B-4・B-5・C-1 は前の版の行を使わない
  P.ok('EVAL.DASHBOARD');
  assert.equal(P.metric('annual_abs_error_rate_latest'), '', 'B-3: 前の版の検証の表（途中の売上の月）は使わない');
  assert.equal(P.metric('annual_constraint_pass'), 'N/A');
  assert.equal(P.metric('half2_wape_latest'), '', '下期（途中の月だけ）の外れ幅も出さない');
  assert.equal(P.metric('range_outside_count_latest'), '');
  P.ok('EVAL.INSIGHTS');
  assert.equal(JSON.stringify(P.rows('EVAL_INSIGHTS')), insightsBefore, 'B-4: 前の版の行からは書かない（前からある 11 月の行も消さない）');
  assert.deepEqual(P.shownInsights(), [], '画面の「人の記入」にも、締まっていない 11 月の古い行は出さない');
  let st = P.ok('LEARN.MONTHLY');
  assert.equal(st.result.result.result.skipped, 'insufficient_eval_months', 'B-5: 前の版の行では学ばない');
  assert.equal(st.result.result.result.n, 0);
  assert.equal(Number(P.cal().bias_correction_factor), 1, '補正は変わらない');
  st = P.runAction('REVIEW.GENERATE');
  assert.equal(st.status, 'FAILED');
  assert.match(st.error, /実績が3月分不足/, 'C-1: 前の版の行は数えない');

  // 2. B-2: 締まった 7・8 月だけを 6/19 の回で測る
  P.ok('EVAL.REPORT');
  const ev = evalByYm(P.rows);
  assert.equal(P.rows('EVAL_LOG').length, 30, 'EVAL_LOG の行は消さない（7・8 月の行は同じ行で書き直す）');
  const cur = P.rows('EVAL_LOG').filter((r) => r.evaluation_policy_version === POLICY);
  assert.deepEqual([...new Set(cur.map((r) => ymOf(r.target_month, r._types.charAt(3))))].sort(), ['2026/07', '2026/08'], '測ったのは締まった 7・8 月だけ');
  cur.forEach((r) => assert.equal(Number(r.pred), PRE * { nega: 0.9, neutral: 1, posi: 1.1 }[r.scenario], '月が始まる前の最後の回（6/19）。10/02 の回は新しくても使わない'));
  ['2026/04', '2026/09', '2026/10', '2026/11', '2027/03'].forEach((ym) => assert.ok(ev[ym].every((r) => r.evaluation_policy_version === 'policy-2026H1-v2'),
    ym + ': 前の版の行はそのまま残る（読む側が使わない）'));
  const cmp = cmpByYm(P.rows);
  near(cmp['2026/07'].ape_p50, 0.1, '7 月の外れ'); near(cmp['2026/07'].forecast_total_p50, PRE, '7 月の予測は 6/19 の回');
  ['2026/09', '2026/10', '2026/11', '2027/03'].forEach((ym) => {
    assert.equal(cmp[ym].ape_p50, '', ym + ': 締まっていない月は誤差を出さない');
    assert.equal(cmp[ym].range_outside_flag, '', ym);
    assert.equal(cmp[ym].note_for_investigation, '実績が締まっていない月（検証しない）', ym);
    assert.equal(Number(cmp[ym].actual_total), ACT[ym], ym + ': 実績の列は取り込んだ値のまま');
  });
  ['2026/04', '2026/05', '2026/06'].forEach((ym) => {
    assert.equal(cmp[ym].forecast_total_p50, '', ym + ': 月が始まる前の予測が無い（6/19・10/02 とも月が始まった後）');
    assert.equal(cmp[ym].note_for_investigation, '月が始まる前の予測が無い月（検証しない）', ym);
  });
  near(cmp['2026/11'].forecast_total_p50, LATE, '11 月の予測は 10/02 の回（11 月が始まる前）');
  // 横の要約（年間・半期・四半期・幅の外）も、締まって測った 7・8 月だけ。締まっていない 9〜3 月の途中の売上を入れると、
  // 年間は実績 3420 / 予測 7100 になる。4〜6 月は月が始まる前の予測が無いので入らない
  const side = sideSummary(P);
  assert.deepEqual([side.annual_actual_total[0], side.annual_p50_total[0]], [2000, 2200], '年間の実績と予測は 7・8 月だけ（6/19 の回）');
  near(side.annual_abs_error_rate[0], 0.1, '年間の外れ');
  assert.equal(side.annual_constraint_pass[0], 'PASS', '年間の外れ 10% 以下');
  assert.deepEqual(side['FY2026-H1'].slice(0, 2), [2000, 2200], '上期は 7・8 月');
  assert.deepEqual(side['FY2026-H2'].slice(0, 2).concat(side['FY2026-H2'][6]), ['', '', 'N/A'], '下期は締まった月が無い');
  assert.deepEqual(side['FY2026-Q2'].slice(0, 2), [2000, 2200], 'Q2 は 7・8 月（9 月は締まっていない）');
  ['FY2026-Q1', 'FY2026-Q3', 'FY2026-Q4'].forEach((q) => assert.deepEqual(side[q].slice(0, 3), ['', '', ''], q + ': 測った月が無い'));
  assert.deepEqual([side.range_outside_count[0], side.months_outside_range[0]], [0, ''], '幅の外の月も締まった月だけ');
  const log = P.rows('RUN_LOG').filter((r) => r.function_name === 'updatePhase1EvaluationReport');
  assert.equal(log.length, 1);
  assert.equal(log[0].error_summary, POLICY + ': scored_months=2; open_months=5; no_pre_month_forecast=3', '測った月・締まっていない月・前の予測が無い月の数');
  // B-2 の後の自動の B-5: 2 か月では学ばない
  const learn = P.rows('PROCESS_STATUS').find((r) => r.step_key === 'learn_status');
  assert.equal(learn.error_summary, 'skipped:insufficient_eval_months');
  assert.equal(Number(P.cal().bias_correction_factor), 1);
  assert.equal(P.rows('CALIBRATION_HISTORY').length, 0);

  // 3. B-2 の後: B-3・B-4 は 7・8 月だけ
  P.ok('EVAL.DASHBOARD');
  near(P.metric('annual_abs_error_rate_latest'), 0.1, 'B-3: 7・8 月だけ（予測 2200 / 実績 2000）');
  near(P.metric('half1_wape_latest'), 0.1, 'B-3 上期');
  assert.equal(P.metric('half2_wape_latest'), '', 'B-3 下期は締まった月が無い');
  near(P.metric('monthly_secondary_metric_latest'), 0.1, 'B-3 月の外れの平均');
  assert.equal(Number(P.metric('range_outside_count_latest')), 0);
  P.ok('EVAL.INSIGHTS');
  const ins = P.rows('EVAL_INSIGHTS');
  assert.deepEqual(ins.map((r) => ymOf(r.target_month, r._types.charAt(2))), ['2026/11', '2026/07', '2026/08'], 'B-4: 7・8 月の行を足す。前からある 11 月の行はそのまま');
  assert.equal(JSON.stringify(ins[0]), JSON.stringify(JSON.parse(insightsBefore)[0]), '11 月の行は書き換えない');
  ins.slice(1).forEach((r) => { near(r.pred_p50, PRE, 'B-4 の予測は 6/19 の回'); near(r.actual_total, 1000, 'B-4 の実績'); });
  // 年間・半期の印も、検証の表の 7・8 月だけで判定する（予測 2200 / 実績 2000: 外れ 10% は年間 10% 以下・上期 12% 以下、多すぎは 5% を超える）。
  // 検証の表の締まっていない 9〜3 月（途中の売上）を混ぜると、年間の印が付いてしまう
  ins.slice(1).forEach((r) => {
    const ym = ymOf(r.target_month, r._types.charAt(2));
    assert.deepEqual([r.annual_constraint_breach, r.half_constraint_breach, r.overforecast_breach].map(Number), [0, 0, 1], ym + ': B-4 の年間・半期・多すぎの印');
  });
  assert.deepEqual(P.shownInsights(), [['2026/07', 3], ['2026/08', 4]], '画面には測った 7・8 月だけ（行の番号はシートのまま）');
  st = P.runAction('REVIEW.GENERATE');
  assert.equal(st.status, 'FAILED');
  assert.match(st.error, /実績が1月分不足/, 'C-1: 締まった月で測った月は 2 か月だけ');
}

// ---- 6 日後に取り込んだ計画（9 月も締まった。7〜9 月を 6/19 の回で測る） ----
{
  const P = setUpPlan(jst(2026, 10, 6, 9));
  P.ok('EVAL.REPORT');
  const cur = P.rows('EVAL_LOG').filter((r) => r.evaluation_policy_version === POLICY);
  assert.deepEqual([...new Set(cur.map((r) => ymOf(r.target_month, r._types.charAt(3))))].sort(), ['2026/07', '2026/08', '2026/09'], '9 月も測る');
  assert.equal(P.rows('EVAL_LOG').length, 30, '行は消さない');
  assert.equal(P.rows('RUN_LOG').find((r) => r.function_name === 'updatePhase1EvaluationReport').error_summary,
    POLICY + ': scored_months=3; open_months=4; no_pre_month_forecast=3');
  const side = sideSummary(P);
  assert.deepEqual([side.annual_actual_total[0], side.annual_p50_total[0]], [3000, 3300], '横の要約は 7〜9 月だけ（10 月〜の途中の売上は入れない）');
  assert.deepEqual(side['FY2026-Q2'].slice(0, 2), [3000, 3300], 'Q2 は 7〜9 月');
  assert.deepEqual(side['FY2026-H2'].slice(0, 2), ['', ''], '下期は締まった月が無い');
  // 計画の一覧の外れ幅（ホーム・分析）も、今の版で測った 7〜9 月だけ（6/19 の回）。検証の画面の精度と同じ数
  const pf = P.env.call('apiPortfolio()').plans.find((p) => p.planId === P.planId);
  const acc = P.env.call('apiLearningView(__in)', { __in: { planId: P.planId } }).accuracy;
  assert.deepEqual([pf.mapeMonths, acc.n], [3, 3], '外れ幅の月 = 精度の月');
  near(pf.mape, 0.1, '外れ幅（6/19 の回: 1100 / 1000）');
  near(pf.mape, acc.mape, '計画の一覧の外れ幅 = 精度');

  // 4. B-2 の後の自動の B-5: 締まった 7〜9 月を、6/19 の予測（補正なし・10% 多い）で学ぶ。期待値は設計の式から（エンジンとは別に計算）
  const w = [0, 1, 2].map((i) => Math.pow(0.5, i / 4));   // 新しい月（9 月）から
  const S = w.reduce((a, b) => a + b, 0);
  const e = (PRE - 1000) / 1000;
  const factor = 1 / (1 + (e * S) / (S + 3));   // 目標 = 1 ÷ (1 + 縮めた偏り)（2026-10-13 から近似しない）
  const c = P.cal();
  near(c.bias_correction_factor, factor, 'B-5 の係数（7〜9 月・6/19 の予測）');
  assert.ok(Number(c.bias_correction_factor) < 1, '6/19 の予測は多すぎたので下げる（10/02 の回 900 なら上げていた）');
  assert.match(c.note, /\(n=3, raw, corrected=0\)$/, '3 か月だけで学んだ（前の版の行・締まっていない月は入らない）');
  const mb = JSON.parse(c.residual_month_bias_json);
  assert.deepEqual(Object.keys(mb).sort(), ['7', '8', '9'], '暦月の偏りも 7〜9 月だけ');
  ['9', '8', '7'].forEach((m, i) => near(mb[m], Number((1 / (1 + (w[i] * e) / (w[i] + 2)) - 1).toFixed(4)), m + ' 月の偏り'));
  assert.deepEqual(P.rows('CALIBRATION_HISTORY').map((r) => [r.review_id, r.factor_name, r.old_value]),
    [['AUTO-MONTHLY', 'bias_correction_factor', '1'], ['AUTO-MONTHLY', 'residual_month_bias_json', '{}']], '履歴に前の値を残す');

  // 5. C-1: 締まった 7〜9 月を、6/19 の回の押しで数える（10/02 の回は外れの向きなので、使えば当たりは 0）
  P.ok('REVIEW.GENERATE');
  const evd = P.rows('RELIABILITY_EVIDENCE');
  assert.deepEqual(evd.map((r) => [r.source_type, r.source_key, r.quarter_label, ymOf(r.quarter_end_month, r._types.charAt(4)), r.n, r.hit]),
    [['opinion', '鷹野', 'FY2026-Q2', '2026/09', '3', '3']], '人の押し: 6/19 の回で 3 か月とも当たり');
  const ai = P.rows('QUARTERLY_REVIEW_LOG').filter((r) => r.target_field === 'ai_weight_override');
  assert.equal(ai.length, 1);
  near(ai[0].proposed_value, 0.0008 * 1.5, 'AI: 6/19 の回で一致 100%・効き 0.3% → 1.5 倍の案（10/02 の回を混ぜると 0.7 倍・10/02 だけなら 0.5 倍）');
  assert.match(ai[0].rationale, /AI方向一致率=100\.0%/);
  assert.ok(P.rows('QUARTERLY_REVIEW_LOG').every((r) => r.quarter_label === 'FY2026-Q2'), '提案の四半期は締まった 7〜9 月');

  // B-3・B-4 は 7〜9 月
  P.ok('EVAL.DASHBOARD');
  near(P.metric('annual_abs_error_rate_latest'), 0.1, 'B-3: 7〜9 月（予測 3300 / 実績 3000）');
  P.ok('EVAL.INSIGHTS');
  assert.deepEqual(P.rows('EVAL_INSIGHTS').map((r) => ymOf(r.target_month, r._types.charAt(2))), ['2026/11', '2026/07', '2026/08', '2026/09']);
  P.rows('EVAL_INSIGHTS').slice(1).forEach((r) => assert.deepEqual([r.annual_constraint_breach, r.half_constraint_breach].map(Number), [0, 0],
    'B-4 の年間・半期の印は 7〜9 月だけで判定（予測 3300 / 実績 3000）'));
}

// ---- 7. 振り返りの行は、予測と実績が今の版の B-2 が測った数字と同じときだけ出す（B-4 が写す数字。違えば次の B-4 が書き直すまで出さない。行は消さない）。
// 書いた日時では決めない（旧来の B-2 は測った月の evaluated_at を毎回書き直す。日時で決めると、月ごとの B-2 のたびに振り返りが全部消えて見える）。
// 10/02 の前の版の B-4 は、7 月を後から作った回（900）で書いた（実績 1000 より低い = 向きも逆）。今の版の B-2 は 7 月を 6/19 の回（1100）で測る
{
  const old07 = row('EVAL_INSIGHTS', { evaluated_at: jst(2026, 10, 2, 12), client: CLIENT, target_month: '2026/07', actual_total: 1000, pred_p50: LATE, diff: 1000 - LATE,
    error_rate: (1000 - LATE) / 1000, diagnostic_type: 'range_breach', range_breach: 1, cause_bucket: 'range_outside', action_type: 'update', status: 'open', review_cycle: 'monthly_light' });
  const P = setUpPlan(jst(2026, 10, 6, 9), [old07]);
  const people = () => P.env.call('apiPeopleLearning()');
  const lessons = () => people().lessons.filter((l) => l.planId === P.planId).map((l) => [l.ym, l.pred, l.actual, l.direction, l.directionLabel]);
  const shown = () => P.env.call('apiPlanView(__in)', { __in: { planId: P.planId } }).boot.eval.insights.map((r) => [r.month, r.row, r.pred]);
  /** 人の学びの [出した振り返りの月, 今の決まりで B-2 が測った月]（画面が「まだ比べていない」と言うかは後の数で決める） */
  const counts = () => { const s = people().summary; return [s.months, s.scoredMonths]; };
  const evalAt = (ym) => { const r = P.rows('EVAL_LOG').find((x) => ymOf(x.target_month, x._types.charAt(3)) === ym && x.scenario === 'neutral'); return Date.parse(r.evaluated_at); };
  const insAt = (ym) => Date.parse(P.rows('EVAL_INSIGHTS').find((x) => ymOf(x.target_month, x._types.charAt(2)) === ym).evaluated_at);
  assert.deepEqual(counts(), [0, 0], 'B-2 の前: 今の決まりで測った月は無い（前の版の行だけ）');

  // (c) 前の版の数字の行（予測 900）は、今の版の B-2 の後は出さない
  P.ok('EVAL.REPORT');
  const n07 = P.rows('EVAL_LOG').find((r) => ymOf(r.target_month, r._types.charAt(3)) === '2026/07' && r.scenario === 'neutral');
  assert.deepEqual([n07.evaluation_policy_version, Number(n07.pred), Number(n07.actual)], [POLICY, PRE, 1000], '今の版の B-2 は 7 月を 6/19 の回で測った');
  assert.deepEqual(lessons(), [], '学びの振り返りに、前の版の B-4 の行（予測 900・予測が低すぎた）を出さない');
  assert.deepEqual(shown(), [], '計画の画面の記入にも出さない（旧来の画面は 7 月を今の版で測った月として出す）');
  assert.deepEqual(counts(), [0, 3], 'B-2 の後・B-4 の前: 測った月は 3 つ（振り返りはまだ出さない）');
  assert.equal(P.rows('EVAL_INSIGHTS').length, 2, '行は消さない');

  // (a) B-4 の後は、今の版の数字で出す
  P.ok('EVAL.INSIGHTS');
  assert.equal(P.rows('EVAL_INSIGHTS').length, 4, 'B-4 は 7 月の行を書き直し、8・9 月を足す');
  assert.deepEqual(lessons().find((l) => l[0] === '2026/07'), ['2026/07', PRE, 1000, 'over', '予測が高すぎた'], 'B-4 の後は今の版の数字で出す');
  assert.deepEqual(lessons().map((l) => l[0]).sort(), ['2026/07', '2026/08', '2026/09']);
  assert.deepEqual(shown(), [['2026/07', 3, PRE], ['2026/08', 4, PRE], ['2026/09', 5, PRE]], '計画の画面も同じ行（行の番号はシートのまま）');
  assert.deepEqual(counts(), [3, 3]);

  // (b) 人の記入（画面の保存 INSIGHT.SAVE）の後、何も変えずに B-2 をもう一度: B-2 は evaluated_at を書き直すが、数字は同じなので出したまま
  const v = P.env.call('apiPlanView(__in)', { __in: { planId: P.planId } });
  const saved = P.env.runJob('PLAN.EDIT', { planId: P.planId, action: 'INSIGHT.SAVE', inputHash: v.inputHash,
    args: { rows: [{ row: 4, hypothesis: '受注の前倒し', actionType: 'update', reflection: '', owner: '鷹野', status: 'in_progress' }] } });
  assert.equal(saved.status, 'DONE', saved.error);
  P.ok('EVAL.REPORT');
  assert.ok(evalAt('2026/08') > insAt('2026/08'), '前提: B-2 は測った月の日時を書き直した（振り返りの行より新しい）');
  assert.deepEqual(lessons().map((l) => l[0]).sort(), ['2026/07', '2026/08', '2026/09'], 'B-2 の後も振り返りは出したまま');
  const aug = people().lessons.find((l) => l.planId === P.planId && l.ym === '2026/08');
  assert.deepEqual([aug.hypothesis, aug.owner, aug.status, aug.human], ['受注の前倒し', '鷹野', 'in_progress', true], '人の記入も出したまま');
  assert.deepEqual(shown(), [['2026/07', 3, PRE], ['2026/08', 4, PRE], ['2026/09', 5, PRE]], '計画の画面の人の記入も');
  assert.equal(P.env.call('apiPlanView(__in)', { __in: { planId: P.planId } }).boot.eval.insights.find((r) => r.row === 4).hypothesis, '受注の前倒し');
  assert.deepEqual(counts(), [3, 3]);

  // (d) 7 月の実績を取り込み直して（1000 → 1200）B-2: 7 月の行は前の実績のままなので、B-4 が書き直すまで出さない。8・9 月はそのまま
  P.env.run(`appWithLock_(() => {
    const plan = appPlanOf_(__p); const scratch = appWorkScratch_(plan); let st = null;
    do { st = appScratchBuildStep_(scratch, __p, ['ACTUAL_EVAL_MONTHLY'], st && st.state, Date.now() + 60000); } while (!st.complete);
    const sh = scratch.getSheetByName('ACTUAL_EVAL_MONTHLY');
    sh.getDataRange().getValues().forEach((r, i) => { if (i > 0 && appYm_(r[3]) === '2026/07') sh.getRange(i + 1, 5).setValue(1200); });
    const cap = appCaptureChanged_(scratch, __p, appStoredHashes_(__p), ['ACTUAL_EVAL_MONTHLY']);
    appJournalRun_({ actor: 'test', requestId: 'T' }, 'テストの準備', __p, appChangedOps_({ actor: 'test' }, __p, cap.changed, 'T'));
  })`, { __p: P.planId });
  P.ok('EVAL.REPORT');
  const r07 = P.rows('EVAL_LOG').find((r) => ymOf(r.target_month, r._types.charAt(3)) === '2026/07' && r.scenario === 'neutral');
  assert.deepEqual([Number(r07.pred), Number(r07.actual)], [PRE, 1200], '前提: B-2 は取り込み直した実績で測った');
  assert.deepEqual(lessons().map((l) => l[0]).sort(), ['2026/08', '2026/09'], '7 月の行（実績 1000）は出さない');
  assert.deepEqual(shown(), [['2026/08', 4, PRE], ['2026/09', 5, PRE]]);
  assert.deepEqual(counts(), [2, 3]);
  assert.equal(P.rows('EVAL_INSIGHTS').length, 4, '行は消さない');
  P.ok('EVAL.INSIGHTS');
  assert.deepEqual(lessons().find((l) => l[0] === '2026/07'), ['2026/07', PRE, 1200, 'under', '予測が低すぎた'], 'B-4 の後は取り込み直した実績で出す');
  assert.deepEqual(shown(), [['2026/07', 3, PRE], ['2026/08', 4, PRE], ['2026/09', 5, PRE]]);
  assert.equal(people().lessons.find((l) => l.planId === P.planId && l.ym === '2026/08').hypothesis, '受注の前倒し', 'B-4 は人の記入を残す');
  assert.deepEqual(counts(), [3, 3]);
}

/** 計画の EVAL_INSIGHTS・EVAL_LOG（neutral）の、その月の行 */
const insOf = (P, ym) => P.rows('EVAL_INSIGHTS').find((x) => ymOf(x.target_month, x._types.charAt(2)) === ym);
const evalOf = (P, ym) => P.rows('EVAL_LOG').find((x) => ymOf(x.target_month, x._types.charAt(3)) === ym && x.scenario === 'neutral');

// ---- 8. 前の版の B-4 が 10/02 に書いた 8 月の行は、予測 1100・実績 1000 で、今の版の B-2 が測る数字とたまたま同じ。
// ただし機械の列（年間・半期・幅の外の印・cause_bucket・対応・状態）は前の決まりのまま。今の版の B-2 だけでは出さず
// （その計画で今の版の B-2 が初めて動いた時刻より前に書いた行）、B-4 が今の決まりで書き直すと出る。
// その後、人の記入を保存して B-2 をもう一度動かしても出したまま（初めの B-2 の時刻は RUN_LOG に残り、後の B-2 の時刻では決めない）
{
  const old08 = row('EVAL_INSIGHTS', { evaluated_at: jst(2026, 10, 2, 12), client: CLIENT, target_month: '2026/08', actual_total: 1000, pred_p50: PRE, diff: 1000 - PRE,
    error_rate: (1000 - PRE) / 1000, insight: '前の版の見立て', diagnostic_type: 'range_breach', annual_constraint_breach: 1, half_constraint_breach: 1, overforecast_breach: 0,
    range_breach: 1, cause_bucket: 'under_forecast', action_type: 'update', next_cycle_reflection: '次回サイクルで前提更新を反映', status: 'open', review_cycle: 'monthly_light' });
  const P = setUpPlan(jst(2026, 10, 6, 9), [old08]);
  const people = () => P.env.call('apiPeopleLearning()');
  const aug = () => people().lessons.find((l) => l.planId === P.planId && l.ym === '2026/08');
  const view = () => P.env.call('apiPlanView(__in)', { __in: { planId: P.planId } });
  const shown = () => view().boot.eval.insights.map((r) => [r.month, r.row]).sort();
  const counts = () => { const s = people().summary; return [s.months, s.scoredMonths]; };

  P.ok('EVAL.REPORT');
  const n08 = evalOf(P, '2026/08');
  assert.deepEqual([n08.evaluation_policy_version, Number(n08.pred), Number(n08.actual)], [POLICY, PRE, 1000], '前提: 今の版の B-2 は 8 月を前の版の行と同じ数字で測った');
  assert.ok(Date.parse(n08.evaluated_at) > Date.parse(insOf(P, '2026/08').evaluated_at), '前提: 前の版の行は、今の版の B-2 より前に書いた');
  assert.equal(aug(), undefined, 'B-2 の後・B-4 の前: 数字が同じでも、前の版の B-4 の行（前の決まりの印・対応・状態）は学びに出さない');
  assert.deepEqual(shown(), [], '計画の画面の記入にも出さない');
  assert.deepEqual(counts(), [0, 3], '測った月は 3 つ（振り返りはまだ出さない）');
  assert.equal(P.rows('EVAL_INSIGHTS').length, 2, '行は消さない');

  P.ok('EVAL.INSIGHTS');
  const r08 = insOf(P, '2026/08');
  assert.equal(P.rows('EVAL_INSIGHTS').length, 4, 'B-4 は 8 月の行を同じ行で書き直し、7・9 月を足す');
  assert.deepEqual([r08.cause_bucket, Number(r08.range_breach), Number(r08.annual_constraint_breach), Number(r08.half_constraint_breach), r08.diagnostic_type],
    ['over_forecast', 0, 0, 0, 'monthly_diagnostic'], '前提: B-4 は 8 月の機械の列を今の決まりで書き直した');
  const a = aug();
  assert.deepEqual([a.pred, a.actual, a.direction, a.range, a.actionType, a.status, a.human], [PRE, 1000, 'over', false, r08.action_type, r08.status, false],
    'B-4 の後は、今の決まりの列で出す（幅の外ではない）');
  assert.deepEqual(shown(), [['2026/07', 4], ['2026/08', 3], ['2026/09', 5]], '計画の画面も同じ（行の番号はシートのまま）');
  assert.deepEqual(counts(), [3, 3]);

  // 人の記入を保存して、何も変えずに B-2 をもう一度: B-2 は EVAL_LOG の日時を書き直すが、B-4 が初めの B-2 の後に書いた行は出したまま
  const saved = P.env.runJob('PLAN.EDIT', { planId: P.planId, action: 'INSIGHT.SAVE', inputHash: view().inputHash,
    args: { rows: [{ row: 3, hypothesis: '大口の受注が翌月にずれた', actionType: 'update', reflection: '', owner: '鷹野', status: 'in_progress' }] } });
  assert.equal(saved.status, 'DONE', saved.error);
  const b4At = Date.parse(insOf(P, '2026/08').evaluated_at);
  P.ok('EVAL.REPORT');
  assert.ok(Date.parse(evalOf(P, '2026/08').evaluated_at) > b4At, '前提: 後の B-2 は EVAL_LOG の日時を、振り返りの行より新しく書き直した');
  assert.equal(P.rows('RUN_LOG').filter((r) => r.function_name === 'updatePhase1EvaluationReport' && String(r.error_summary).indexOf(POLICY + ':') === 0).length, 2,
    '前提: RUN_LOG には今の版の B-2 の記録が 2 つ（初めの回の時刻が残る）');
  const after = aug();
  assert.deepEqual([after.hypothesis, after.owner, after.status, after.human, after.range], ['大口の受注が翌月にずれた', '鷹野', 'in_progress', true, false], '人の記入も出したまま');
  assert.deepEqual(shown(), [['2026/07', 4], ['2026/08', 3], ['2026/09', 5]]);
  assert.equal(view().boot.eval.insights.find((r) => r.row === 3).hypothesis, '大口の受注が翌月にずれた');
  assert.deepEqual(counts(), [3, 3]);
}

// ---- 9. 返品・値引きで実績が負の締まった月（8 月: −200）。今の版の B-2 は EVAL_LOG に −200 と書くが、旧来の B-4 は月の実績を
// 0 から Math.max で取るので actual_total = 0 と書く。振り返り（学び・計画の画面）は B-4 の見え方（負なら 0 円）で比べるので、B-4 の後に出る
// （前は EVAL_LOG の −200 と合わず、その月の振り返りはずっと出なかった） ----
{
  const P = setUpPlan(jst(2026, 10, 6, 9), [], Object.assign({}, ACT, { '2026/08': -200 }));
  const people = () => P.env.call('apiPeopleLearning()');
  const mine = () => people().lessons.filter((l) => l.planId === P.planId);
  const shown = () => P.env.call('apiPlanView(__in)', { __in: { planId: P.planId } }).boot.eval.insights.map((r) => [r.month, r.row]).sort();
  P.ok('EVAL.REPORT');
  const n08 = evalOf(P, '2026/08');
  assert.deepEqual([n08.evaluation_policy_version, Number(n08.pred), Number(n08.actual)], [POLICY, PRE, -200], '前提: 今の版の B-2 は 8 月を実績 −200 で測った');
  P.ok('EVAL.INSIGHTS');
  const r08 = insOf(P, '2026/08');
  assert.deepEqual([Number(r08.pred_p50), Number(r08.actual_total)], [PRE, 0], '前提: 旧来の B-4 は 8 月の実績を 0 円と書いた');
  const aug = mine().find((l) => l.ym === '2026/08');
  assert.ok(aug, 'B-4 の後は、実績が負の月の振り返りも出す');
  assert.deepEqual([aug.pred, aug.actual, aug.direction, aug.err], [PRE, 0, 'over', null], 'B-4 が書いた数字のまま（実績 0 円なので外れの率は出さない）');
  assert.deepEqual(mine().map((l) => l.ym).sort(), ['2026/07', '2026/08', '2026/09']);
  assert.deepEqual(shown(), [['2026/07', 3], ['2026/08', 4], ['2026/09', 5]], '計画の画面の記入も同じ月（2 行目は前からある 11 月の行）');
  const s = people().summary;
  const lv = P.env.call('apiLearningView(__in)', { __in: { planId: P.planId } });
  assert.deepEqual([s.months, s.scoredMonths, lv.scoredMonths], [3, 3, 3], '出した振り返りの月 = 測った月（学びと検証の画面で同じ数）');
  assert.deepEqual(lv.accuracy.months.map((m) => [m.month, m.actual]), [['2026/07', 1000], ['2026/08', -200], ['2026/09', 1000]], '精度は EVAL_LOG の実績のまま');
}

// ---- 10. 検証の画面の scoredMonths（今の決まりで B-2 が測った月の数）: B-2 の前は 0。B-2 の後は、どの月も売上 0 円で精度の月が 0 でも 3 ----
{
  const zero = Object.fromEntries(Object.keys(ACT).map((ym) => [ym, 0]));
  const P = setUpPlan(jst(2026, 10, 6, 9), [], zero);
  const lv = () => P.env.call('apiLearningView(__in)', { __in: { planId: P.planId } });
  const before = lv();
  assert.deepEqual([before.scoredMonths, before.accuracy.months.length, before.accuracy.n], [0, 0, 0], 'B-2 の前（前の版の行だけ）: まだ比べていない');
  P.ok('EVAL.REPORT');
  assert.deepEqual(P.rows('EVAL_LOG').filter((r) => r.evaluation_policy_version === POLICY && r.scenario === 'neutral').map((r) => [ymOf(r.target_month, r._types.charAt(3)), Number(r.actual)]).sort(),
    [['2026/07', 0], ['2026/08', 0], ['2026/09', 0]], '前提: 今の版の B-2 は 7〜9 月を売上 0 円で測った');
  const after = lv();
  assert.deepEqual([after.scoredMonths, after.accuracy.months.length, after.accuracy.n], [3, 0, 0], 'B-2 の後: 比べた月はどれも売上 0 円（精度の月は 0・scoredMonths は 3）');
  assert.equal(P.env.call('apiPeopleLearning()').summary.scoredMonths, 3, '人の学びの scoredMonths と同じ数');
}

// ---- 11. 同じ月の行が 2 つ（v0.27.2 より前の B-4 が月を日付で書き、上書きの鍵が合わずに増えた行）。人の記入は 1 つ目の行にだけある。
// B-4 は最後の行だけを今の数字で書き直す（人の記入の跡が無いので、機械の列も書き直す）。1 つ目の行の記入は、学びにも計画の画面にも出す ----
{
  const old = (at, o) => row('EVAL_INSIGHTS', Object.assign({ evaluated_at: at, client: CLIENT, target_month: '2026/07', actual_total: 1000, pred_p50: LATE, diff: 1000 - LATE,
    error_rate: (1000 - LATE) / 1000, insight: '前の版の見立て', diagnostic_type: 'range_breach', range_breach: 1, cause_bucket: 'range_outside', action_type: 'update',
    next_cycle_reflection: '次回サイクルで前提更新を反映', status: 'open', review_cycle: 'monthly_light' }, o));
  const noted = old(jst(2026, 10, 2, 12), { cause_hypothesis: '大口の失注', action_type: '入力を修正', next_cycle_reflection: '見解を見直す', owner: '鷹野', status: 'in_progress' });
  const P = setUpPlan(jst(2026, 10, 6, 9), [noted, old(jst(2026, 10, 2, 13))]);   // シートの 3 行目（記入あり）・4 行目（記入なし）
  const people = () => P.env.call('apiPeopleLearning()');
  const jul = () => people().lessons.find((l) => l.planId === P.planId && l.ym === '2026/07');
  const view = () => P.env.call('apiPlanView(__in)', { __in: { planId: P.planId } });
  const julRows = () => view().boot.eval.insights.filter((r) => r.month === '2026/07').map((r) => [r.row, r.pred, r.actual, r.hypothesis, r.owner, r.status, r.insight, r.rangeBreach]);

  // B-2 の後・B-4 の前: 7 月の 2 行はどちらも前の版の数字（使える行が無い）なので、記入があっても出さない。3 か月とも B-4 待ち
  P.ok('EVAL.REPORT');
  assert.equal(jul(), undefined);
  assert.deepEqual(julRows(), []);
  assert.deepEqual([people().summary.scoredMonths, people().summary.waitingMonths], [3, 3], 'B-4 待ちは 3 か月');
  // 締めた年度の計画は、B-4 を動かせないので B-4 待ちに数えない（測った月は数える）
  P.env.run(`(() => { const orig = appYearIsFrozen_; appYearIsFrozen_ = fy => String(fy) === '2026' || orig(fy); globalThis.__unfreeze = () => { appYearIsFrozen_ = orig; }; })()`);
  for (const k of Object.keys(P.env.cache)) delete P.env.cache[k];
  assert.deepEqual([people().summary.scoredMonths, people().summary.waitingMonths], [3, 0], '締めた年度: B-4 待ちは数えない');
  P.env.run('__unfreeze()');
  for (const k of Object.keys(P.env.cache)) delete P.env.cache[k];

  // B-4: 最後の行（4 行目）だけを今の数字で書き直し、8・9 月を足す。記入のある 3 行目はそのまま（消さない）
  P.ok('EVAL.INSIGHTS');
  const ins = P.rows('EVAL_INSIGHTS');
  assert.equal(ins.length, 5, '行は消さない');
  assert.deepEqual([Number(ins[1].pred_p50), ins[1].cause_hypothesis, Number(ins[2].pred_p50), ins[2].cause_hypothesis], [LATE, '大口の失注', PRE, ''],
    '前提: B-4 は最後の行だけを書き直した（記入は 1 つ目の行に残ったまま）');
  const j = jul();
  assert.ok(j, '7 月を出す');
  assert.deepEqual([j.pred, j.actual, j.direction, j.range], [PRE, 1000, 'over', false], '数字・印は書き直した行（今の B-2 の数字）から');
  assert.deepEqual([j.hypothesis, j.actionType, j.reflection, j.owner, j.status, j.human, j.duplicates], ['大口の失注', '入力を修正', '見解を見直す', '鷹野', 'in_progress', true, 1],
    '記入は 1 つ目の行から（前は隠れたまま）');
  assert.deepEqual([people().summary.months, people().summary.waitingMonths, people().summary.withNotes], [3, 0, 1]);
  // 計画の画面: 記入のある 3 行目を、書き直した行の数字・見立て・印で出す（行の番号は 3 のまま = 画面からそこに書ける）。書き直した 4 行目も出す（画面がまとめる）
  const r4 = view().boot.eval.insights.find((r) => r.row === 4);
  assert.deepEqual(julRows(), [[3, PRE, 1000, '大口の失注', '鷹野', 'in_progress', r4.insight, false], [4, PRE, 1000, '', '', r4.status, r4.insight, false]]);
  assert.notEqual(r4.insight, '前の版の見立て', '前提: 見立ては今の B-4 のもの');
  // 画面の「人の記入」は、人が書いた行（3 行目）を出し、自動の 4 行目はまとめる
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [] }, setUp: true, allowed: true }));
  const el = () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
  const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, confirm: () => false,
    window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  ui.__ins = view().boot.eval.insights;
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('fcInsRows(__ins).map(function(o){ return [o.r.month, o.r.row, o.hidden]; })', ui))),
    [['2026/07', 3, 1], ['2026/08', 5, 0], ['2026/09', 6, 0]], '画面は 7 月を記入のある 3 行目で出す');

  // 計画の画面から 3 行目の記入を直す → 学びにも出る。もう一度 B-4 を動かしても、記入は出したまま（行は増えない）
  const saved = P.env.runJob('PLAN.EDIT', { planId: P.planId, action: 'INSIGHT.SAVE', inputHash: view().inputHash,
    args: { rows: [{ row: 3, hypothesis: '大口の失注（確認済み）', actionType: '入力を修正', reflection: '見解を見直す', owner: '鷹野', status: 'done' }] } });
  assert.equal(saved.status, 'DONE', saved.error);
  assert.deepEqual([jul().hypothesis, jul().status], ['大口の失注（確認済み）', 'done']);
  P.ok('EVAL.INSIGHTS');
  assert.equal(P.rows('EVAL_INSIGHTS').length, 5, '行は増えない・消さない');
  assert.deepEqual([jul().hypothesis, jul().status, jul().pred], ['大口の失注（確認済み）', 'done', PRE]);
  assert.deepEqual(julRows().map((r) => [r[0], r[3]]), [[3, '大口の失注（確認済み）'], [4, '']]);
}

console.log('app-legacy-closed-months: all tests passed');
