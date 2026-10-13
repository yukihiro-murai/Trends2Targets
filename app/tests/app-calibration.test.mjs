#!/usr/bin/env node
/*
 * app-calibration.test.mjs — 所有者が承認した補正の値を書く（apiOwnerTask の setCalibration・Calibration.js）と、
 * 見直し案を作る操作（C-1）を止めたこと（2026-10-07 村井さん決定 D1・D2・D3・D7・D8）。本物の旧来の計算をモックの上で動かして確かめる。
 *   1. 書く前の確かめ（知らない項目・範囲の外・形の違う値・理由・計画）。範囲と今の値の読み方は旧来の計算と同じ
 *   2. 所有者だけ（管理者の役割があっても断る。エディタの入口・画面の入口・裏の処理のどこでも）
 *   3. AI の効きを 0 にすると、A-9 の AI の倍率（k_ai）だけが 1 になり、ほかの層は変わらない（同じ乱数で前と後の予測を比べる）
 *   4. D2 + D7 + D8 + 取り下げを 1 回で頼む（README の例）: CALIBRATION_STATE・履歴（前の行は残す）・前と後の値・記録・画面の中身が新しい値になる
 *   5. 同じ頼みをもう一度: 何も書かない（履歴も足さない）。月次の自動学習（B-5）は旗を 0 にしたので動かない
 *   6. 見直し案を作る（C-1）は止めている（始める前に断る。画面のボタンは押せない。反映済みの札も、そのボタンを案内しない）
 *   7. 締めた年度の計画には書かない
 *   8. 承認待ちの見直し案の取り下げ: 承認待ちに出ない・C-3 は何も適用しない（判断を保存し直しても）・行は消さない・もう一度でも何もしない
 *   9. C-3 を保留のまま動かした見直し案（本物のデータと同じ形: 保留・判断の日時あり・未反映）も取り下げる。取り下げなければ、承認し直した C-3 が反映してしまう
 *      （比べる計画）。反映した見直し案は取り下げない
 *  10. 取り下げられる見直し案の決まり（どの案も反映していない・まだ全部は取り下げていない。判断と判断の日時では決めない）
 *  11. 予測の記録（FORECAST_SNAPSHOT.calibration_applied_json）は、AI の重み 0 を 0 と書く（空にしない。2026-10-08 村井さん承認）。
 *      C-3 の反映できる案が無いときの文は、止めている「見直し案を作る」へ案内しない（取り下げた案・まだ案が無い・反映済み）
 * モックの上の確かめで、本物の Apps Script の上では動かしていない。
 *
 *   node app/tests/app-calibration.test.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { setUpEnv, extractFunction, repoRoot, uiHtml, OWNER, MEMBER, J, fcSection } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const CLIENT = 'テスト製薬';
/** 係数が 1 以外か月ごとの補正があるときの注意（旧来の A-9 は月の P10/P50/P90 にだけ掛け、年度の P10/P50/P90 には掛けない） */
const ANNUAL_WARNING = '係数が 1 以外か、月ごとの補正があると、年度の P10/P50/P90（ホームの中心・公式版の中心）には掛からず、月の合計とずれます。';
const legacySrc = await readFile(path.join(repoRoot, 'Forecast_Agent.js'), 'utf8');

// ---- 道具 ----

/** OWNER_TASK に頼みを置いて、エディタからの実行と同じく引数なしで apiOwnerTask を動かす */
function task(env, t) {
  env.props.OWNER_TASK = JSON.stringify(t);
  return env.call('apiOwnerTask()');
}
const result = (env) => JSON.parse(env.props.OWNER_TASK_RESULT);
const jobProps = (env) => Object.keys(env.props).filter((k) => /^APP_JOB_(?!RESULT_)/.test(k)).length;
/** 失敗する: 投げる・エラーが OWNER_TASK_RESULT に書かれ、頼みは残る・処理を入れない */
function fails(env, t, re) {
  const jobs0 = jobProps(env);
  const triggers0 = env.triggers.length;
  assert.throws(() => task(env, t), re, JSON.stringify(t));
  const rec = result(env);
  assert.equal(rec.ok, false);
  assert.match(rec.error, re);
  assert.equal(env.props.OWNER_TASK, JSON.stringify(t), '失敗したら頼みを残す');
  assert.equal(jobProps(env), jobs0, '処理を入れない: ' + JSON.stringify(t));
  assert.equal(env.triggers.length, triggers0, 'トリガーも作らない');
  delete env.props.OWNER_TASK;
  return rec;
}
/** 裏の処理を最後まで動かして、終わりの状態を受け取る（頼みは jobStatus に置き換わっているので、もう一度実行するだけ） */
function finishJob(env) {
  assert.equal(JSON.parse(env.props.OWNER_TASK).action, 'jobStatus', '裏の処理を始めた後の頼みは jobStatus');
  for (let i = 0; i < 30; i++) {
    env.fireTriggers('triggerRunJob');
    const st = env.call('apiOwnerTask()').result;
    if (['QUEUED', 'RUNNING', 'CONTINUED'].includes(st.status)) continue;
    delete env.props.OWNER_TASK;
    return st;
  }
  throw new Error('処理が終わらない');
}
/** setCalibration を頼んで、終わりまで動かす */
function setCal(env, t) {
  const full = task(env, Object.assign({ action: 'setCalibration' }, t));
  assert.equal(full.ok, true);
  assert.equal(full.auditAction, 'JOB.START');
  return finishJob(env);
}
const engRows = (env, sheet, planId) => env.table('ENG_' + sheet).filter((r) => r.plan_id === planId);
const audits = (env, action, phase) => env.audit().filter((a) => a.action === action && (!phase || a.phase === phase));
/**
 * テストの準備の道具: 計画の旧来のシートを計算用ブックの上で直し、本物の保存と同じ控えと書き方でデータ本体へ戻す。
 * edit はブックを受け取る関数の文（vm の中で動く）
 */
function editLegacy(env, planId, sheets, edit, extra) {
  env.run(`appWithLock_(() => {
    const plan = appPlanOf_(__p); const scratch = appWorkScratch_(plan); let st = null;
    do { st = appScratchBuildStep_(scratch, __p, __sheets, st && st.state, Date.now() + 60000); } while (!st.complete);
    (${edit})(scratch);
    const cap = appCaptureChanged_(scratch, __p, appStoredHashes_(__p), __sheets);
    if (cap.changed.length) appJournalRun_({ actor: 'test', requestId: 'T' }, 'テストの準備', __p, appChangedOps_({ actor: 'test' }, __p, cap.changed, 'T'));
  })`, Object.assign({ __p: planId, __sheets: sheets }, extra || {}));
}
/** 止めている操作を、待ち行列に直接入れて動かす（始める前の断りだけを飛ばす。旧来の C-1 で承認待ちの見直し案を作るため） */
function runQueued(env, kind, payload, by) {
  // 画面と同じく、計画への保存には今の指紋を添える（2026-10-13 から必須）
  if (kind === 'PLAN.EDIT' && payload.inputHash === undefined) payload = Object.assign({}, payload, { inputHash: env.run('appTestPlanHash_(__p)', { __p: payload.planId }) });
  let id = env.run(`appWithLock_(() => appEnqueueJob_(__k, __p, __by, '').id)`, { __k: kind, __p: payload, __by: by || OWNER });
  for (let i = 0; i < 60; i++) {
    env.fireTriggers('triggerRunJob');
    const st = env.run('appJobGet_(__id)', { __id: id });
    if (st.status === 'DONE' && st.nextJobId) { id = st.nextJobId; continue; }
    if (st.status === 'QUEUED' || st.status === 'RUNNING') continue;
    return st;
  }
  throw new Error('続きの処理が終わらない');
}
/** 今日の四半期（旧来の quarterLabelFromYm_ と同じ。4 月始まり） */
function quarterNow() {
  const t = new Date(Date.now() + 9 * 3600e3);
  const y = t.getUTCFullYear(); const m = t.getUTCMonth();
  return 'FY' + (m >= 3 ? y : y - 1) + '-Q' + (Math.floor(((m + 9) % 12) / 3) + 1);
}
/** 画面（UI.html の script）を vm で読み込む */
function loadUi() {
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
  const el = () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
  const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, confirm: () => false,
    window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  return ui;
}

// ==== 0. 範囲と今の値の読み方は、旧来の計算と同じ ====
{
  const env = setUpEnv();
  const legacyConst = (name) => Number(new RegExp('const ' + name + ' = ([0-9.]+);').exec(legacySrc)[1]);
  assert.equal(env.run('APP_CALIBRATION_FACTOR_MIN'), legacyConst('AUTOLEARN_GLOBAL_FACTOR_MIN'));
  assert.equal(env.run('APP_CALIBRATION_FACTOR_MAX'), legacyConst('AUTOLEARN_GLOBAL_FACTOR_MAX'));
  assert.equal(env.run('APP_CALIBRATION_MONTH_BIAS_MAX'), legacyConst('AUTOLEARN_MONTH_BIAS_CAP'));
  assert.match(legacySrc, /out\.aiWeight = Math\.max\(0, Math\.min\(0\.01, getCfg\('AI_WEIGHT', out\.aiWeight\)\)\);/, 'CONFIG の AI_WEIGHT の範囲は 0〜0.01');
  assert.equal(env.run('APP_CALIBRATION_AI_WEIGHT_MAX'), 0.01);
  // 暦月の補正・係数・旗・AI の効きの読み方（旧来の関数を取り出して比べる）
  const box = vm.createContext({});
  vm.runInContext(['parseResidualMonthBiasJson_', 'canonicalMonthBiasJson_', 'calibrationNumberOr_'].map((n) => extractFunction(legacySrc, n)).join('\n'), box);
  for (const raw of ['', null, '{}', '{"4":0.05,"9":-0.1}', '{"9":-0.1,"4":0.05}', '{"04":0.05}', '{"13":0.1,"2":"0.2"}', '[1,2]', '{bad', '{"1":"x","12":0.3}']) {
    box.__raw = raw;
    const legacy = vm.runInContext('canonicalMonthBiasJson_(parseResidualMonthBiasJson_(__raw))', box);
    assert.equal(env.run('appCalibrationNorm_("residual_month_bias_json", __raw)', { __raw: raw }), legacy, '暦月の補正: ' + raw);
  }
  for (const raw of ['', null, 0, '0', 1, '1', 0.8, '0.8', -1, 'abc', 2]) {
    box.__raw = raw;
    const f = vm.runInContext('(() => { const v = calibrationNumberOr_(__raw, 1); return v > 0 ? v : 1; })()', box);
    const a = vm.runInContext('calibrationNumberOr_(__raw, 1) === 1 ? 1 : 0', box);
    assert.equal(env.run('appCalibrationNorm_("bias_correction_factor", __raw)', { __raw: raw }), f, '係数: ' + raw);
    assert.equal(env.run('appCalibrationNorm_("auto_update_enabled", __raw)', { __raw: raw }), a, '旗: ' + raw);
  }
  // 予測の記録の補正（calibration_applied_json）: 空だけを既定の書き方にし、0 は 0 のまま（前は「|| ''」で 0 を空と書いた。2026-10-08 村井さん承認）
  vm.runInContext(['createDefaultCalibrationState_', 'buildCalibrationAppliedPayload_'].map((n) => extractFunction(legacySrc, n)).join('\n') + '\nconst VERSION = "v-test";', box);
  const applied = (cal) => JSON.parse(JSON.stringify(vm.runInContext('buildCalibrationAppliedPayload_(__r)', Object.assign(box, { __r: cal === undefined ? {} : { calibration: cal } }))));
  assert.deepEqual(applied({ ai_weight_override: 0, ai_max_abs_effect_override: 0, qual_scale_override: 0, bias_correction_factor: 0.8, ai_topic_disable_json: '["DX"]',
    residual_month_bias_json: '{"4":0.05}', last_applied_quarter: 'FY2026-Q1' }),
  { version: 'v-test', quarter: 'FY2026-Q1', ai_weight_override: 0, ai_max_abs_effect_override: 0, ai_topic_disable_json: '["DX"]', bias_correction_factor: 0.8,
    qual_scale_override: 0, residual_month_bias_json: '{"4":0.05}' }, '0 は 0 のまま（AI の重み・AI の効きの上限・入力の効きの倍率）');
  assert.deepEqual(applied({ ai_weight_override: '', ai_max_abs_effect_override: null, qual_scale_override: undefined, bias_correction_factor: '', ai_topic_disable_json: '',
    residual_month_bias_json: null, last_applied_quarter: '' }),
  { version: 'v-test', quarter: '', ai_weight_override: '', ai_max_abs_effect_override: '', ai_topic_disable_json: '[]', bias_correction_factor: 1, qual_scale_override: '',
    residual_month_bias_json: '' }, '空は前と同じ書き方（上書きなし・係数 1・話題は []）');
  assert.deepEqual(applied(undefined), { version: 'v-test', quarter: '', ai_weight_override: '', ai_max_abs_effect_override: '', ai_topic_disable_json: '[]', bias_correction_factor: 1,
    qual_scale_override: '', residual_month_bias_json: '' }, '補正が無い予測（既定の状態）');
  assert.deepEqual(applied({ ai_weight_override: 0.0004, ai_max_abs_effect_override: '0.03', bias_correction_factor: 1.1 }).ai_weight_override, 0.0004, '0 でない値はそのまま');
  assert.doesNotMatch(extractFunction(legacySrc, 'buildCalibrationAppliedPayload_'), /cal\.\w+\s*\|\|/, '値を「||」で既定にしない（0 を空にしてしまう）');
  // AI の効き: 空は未設定（CONFIG の値）、0 は 0（以前の直し: 0 を未設定として扱わない）
  assert.match(legacySrc, /if \(v === '' \|\| v === null \|\| v === undefined\) return null;\n    const n = Number\(v\);\n    return isFinite\(n\) \? n : null;/);
  assert.deepEqual(['', null, 0, '0', 0.0004, 'abc'].map((raw) => env.run('appCalibrationNorm_("ai_weight_override", __raw)', { __raw: raw })), ['', '', 0, 0, 0.0004, '']);
}

// ---- 準備（計画 1）: 本物の A-1・A-2・A-3 で計画を作り、入力・AI の調べ・学んだ補正を置く ----
const env = setUpEnv();
const currentFy = env.run('appFy_(new Date())');
let planId;
{
  const ext = Array.from({ length: 70 }, () => '');
  const rec = (product, month, amount) => { const r = ext.slice(); r[40] = CLIENT; r[45] = 'ベース'; r[49] = product; r[56] = month; r[65] = amount; return r; };
  const sheets = {};
  for (let y = currentFy - 5; y <= currentFy; y++) {
    const rows = [ext.map((_, i) => 'c' + (i + 1))];
    for (let m = 1; m <= 12; m++) {
      const dt = D(y, m, 15);
      if (dt < D(currentFy - 5, 4, 1) || dt > D(currentFy, 3, 31)) continue;
      rows.push(rec('製品A', dt, Math.round(1000000 + 50000 * Math.sin(m) + 12000 * (y - currentFy + 5) + m * 2000)));
      rows.push(rec('製品B', dt, Math.round(400000 + 20000 * Math.cos(m))));
    }
    sheets['*' + y + '_actual_value'] = { cols: 70, values: rows };
  }
  const zac = env.makeBook('売上の元', sheets);
  env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
  let st = env.runJob('PLAN.CREATE', { clientName: CLIENT, fy: currentFy, peopleCsv: '鷹野' });
  assert.equal(st.status, 'DONE', st.error);
  planId = st.result.planId;
  for (const action of ['IMPORT.SALES', 'SALES.AGGREGATE']) {
    st = env.runJob('PLAN.RUN', { planId, action });
    assert.equal(st.status, 'DONE', action + ': ' + st.error);
  }
  for (const [kind, row] of [['opinions', { person: '鷹野', ym: currentFy + '-04', step: '-5', conf: '0.6', note: '' }],
    ['product', { person: '鷹野', product: '製品A', ym: currentFy + '-04', step: '5', reason: '新規' }], ['client', { person: '鷹野', ym: currentFy + '-04', step: '-3', reason: '全体' }]]) {
    const v = env.call('apiPlanView(__in)', { __in: { planId } });
    st = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind, rows: [row] }, inputHash: v.inputHash });
    assert.equal(st.status, 'DONE', kind + ': ' + st.error);
  }
  // AI の調べ（4 つの話題とも上向き。AI の効きは上限の 5% で頭打ちになる大きさ）
  const H = env.run('APP_ENGINE_SHEETS.AI_RESEARCH_STRUCTURED.header');
  const t = new Date();
  const asOf = t.getFullYear() + '/' + String(t.getMonth() + 1).padStart(2, '0') + '/01';
  const ai = ['Market', 'Competitor', 'Channel', 'DX'].flatMap((topic) => [
    { client: CLIENT, as_of_date: asOf, topic, row_type: 'event', direction: 'up', impact_score: 60, confidence: 0.8, evidence: 'x', event_score: 30 },
    { client: CLIENT, as_of_date: asOf, topic, row_type: 'event', direction: 'up', impact_score: 50, confidence: 0.7, evidence: 'y', event_score: 25 },
    { client: CLIENT, as_of_date: asOf, topic, row_type: 'benchmark', relative_percentile: 70, relative_confidence: 0.8, benchmark_quality: 'high', benchmark_score: 16 }
  ].map((o) => H.map((h) => (o[h] === undefined ? '' : o[h]))));
  // 学んだ補正（月次の自動学習が下げた係数と暦月の補正）と、その履歴 2 行
  const calRow = { client: CLIENT, updated_at: D(currentFy, 10, 1), updated_by: 'auto', ai_weight_override: '', ai_max_abs_effect_override: '', ai_topic_disable_json: '[]',
    bias_correction_factor: 0.8, qual_scale_override: '', residual_month_bias_json: '{"4":0.05,"9":-0.1}', last_applied_quarter: '', last_applied_review_id: '',
    auto_update_enabled: 1, note: 'auto-learned' };
  const hist = [['H-1', D(currentFy, 10, 1), 'auto', CLIENT, 'FY' + currentFy + '-Q3', 'AUTO-MONTHLY', 'bias_correction_factor', '0.9', '0.85', '戻す'],
    ['H-2', D(currentFy, 10, 2), 'auto', CLIENT, 'FY' + currentFy + '-Q3', 'AUTO-MONTHLY', 'bias_correction_factor', '0.85', '0.8', '戻す']];
  editLegacy(env, planId, ['AI_RESEARCH_STRUCTURED', 'CALIBRATION_STATE', 'CALIBRATION_HISTORY'], `function (b) {
    let sh = b.getSheetByName('AI_RESEARCH_STRUCTURED');
    sh.getRange(2, 1, __ai.length, __ai[0].length).setValues(__ai);
    sh = b.getSheetByName('CALIBRATION_STATE');
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    sh.getRange(2, 1, 1, head.length).setValues([head.map(h => __cal[h] === undefined ? '' : __cal[h])]);
    sh = b.getSheetByName('CALIBRATION_HISTORY');
    sh.getRange(2, 1, __hist.length, __hist[0].length).setValues(__hist);
  }`, { __ai: ai, __cal: calRow, __hist: hist });
  assert.equal(engRows(env, 'CALIBRATION_STATE', planId).length, 1);
  assert.equal(engRows(env, 'CALIBRATION_STATE', planId)[0].bias_correction_factor, '0.8');
  assert.equal(engRows(env, 'CALIBRATION_HISTORY', planId).length, 2);
}
const histBefore = () => engRows(env, 'CALIBRATION_HISTORY', planId).map((r) => { const o = Object.assign({}, r); delete o._row; return o; });

// ==== 1. 書く前の確かめ: 何もせずに止める（処理を入れない・何も書かない） ====
{
  const cal0 = JSON.stringify(engRows(env, 'CALIBRATION_STATE', planId));
  const audit0 = env.audit().length;
  const base = { action: 'setCalibration', planId, reason: 'テスト' };
  const bad = [
    [{ set: { foo: 1 } }, /書けない項目です: foo。書ける項目: bias_correction_factor, residual_month_bias_json, auto_update_enabled, ai_weight_override/],
    [{ set: [1] }, /set は \{"項目": 値\} の形/],
    [{ set: { bias_correction_factor: 0.7 } }, /bias_correction_factor は 0\.75〜1\.25 の数/],
    [{ set: { bias_correction_factor: 1.3 } }, /bias_correction_factor は 0\.75〜1\.25 の数/],
    [{ set: { bias_correction_factor: '1' } }, /bias_correction_factor は 0\.75〜1\.25 の数/],
    [{ set: { auto_update_enabled: 2 } }, /auto_update_enabled は 0（自動の学びを止める）か 1/],
    [{ set: { auto_update_enabled: '0' } }, /auto_update_enabled は 0/],
    [{ set: { auto_update_enabled: false } }, /auto_update_enabled は 0/],
    [{ set: { ai_weight_override: -0.1 } }, /ai_weight_override は 0〜0\.01 の数/],
    [{ set: { ai_weight_override: 0.02 } }, /ai_weight_override は 0〜0\.01 の数/],
    [{ set: { ai_weight_override: '0' } }, /ai_weight_override は 0〜0\.01 の数/],
    [{ set: { residual_month_bias_json: '{bad' } }, /residual_month_bias_json の JSON が読めません/],
    [{ set: { residual_month_bias_json: '{"13":0.1}' } }, /residual_month_bias_json の月は 1〜12 にしてください: 13/],
    [{ set: { residual_month_bias_json: '{"04":0.1}' } }, /月は 1〜12 にしてください: 04/],
    [{ set: { residual_month_bias_json: { 4: 0.3 } } }, /residual_month_bias_json の値は ±0\.2 までの数/],
    [{ set: { residual_month_bias_json: { 4: '0.1' } } }, /residual_month_bias_json の値は ±0\.2 までの数/],
    [{ set: { residual_month_bias_json: '[1]' } }, /residual_month_bias_json は \{\}（補正なし）か/],
    [{ set: { residual_month_bias_json: 0 } }, /residual_month_bias_json は \{\}（補正なし）か/],
    [{ set: { bias_correction_factor: 1 }, withdrawPendingReview: 'true' }, /withdrawPendingReview は true か false/],
    [{ set: { bias_correction_factor: 1 }, reason: '  ' }, /理由（reason）を入れてください/],
    [{ set: { bias_correction_factor: 1 }, reason: 'x'.repeat(201) }, /理由（reason）は 200 字までに/],
    [{ set: {} }, /書く値（set）も、見直し案の取り下げ（withdrawPendingReview）もありません/],
    [{ withdrawPendingReview: false }, /書く値（set）も/],
    [{ set: { bias_correction_factor: 1 }, inputHash: 'abc' }, /inputHash は calibrationPreview の inputHash（64 桁）/],
    [{ set: { bias_correction_factor: 1 }, sett: {} }, /使えない項目があります: sett/],
    [{ set: { bias_correction_factor: 1 }, planId: '' }, /setCalibration には計画の ID（planId。listPlans の planId）を入れてください/],
    [{ set: { bias_correction_factor: 1 }, planId: 'PL-none' }, /計画が見つかりません/]
  ];
  for (const [t, re] of bad) fails(env, Object.assign({}, base, t), re);
  const noReason = Object.assign({}, base, { set: { bias_correction_factor: 1 } });
  delete noReason.reason;
  fails(env, noReason, /理由（reason）を入れてください/);
  fails(env, { action: 'calibrationPreview' }, /calibrationPreview には計画の ID/);
  assert.equal(JSON.stringify(engRows(env, 'CALIBRATION_STATE', planId)), cal0, '何も書かない');
  assert.equal(env.audit().length, audit0, '記録も増えない（何も動かしていない）');
  // 裏の処理の中でも確かめ直す（画面の入口から始めても同じ）: 範囲の外は書かずに失敗する
  const st = runQueued(env, 'PLAN.EDIT', { planId, action: 'CALIBRATION.SET', args: { set: { bias_correction_factor: 5 }, reason: 'x' } });
  assert.equal(st.status, 'FAILED');
  assert.match(st.error, /bias_correction_factor は 0\.75〜1\.25/);
  assert.equal(JSON.stringify(engRows(env, 'CALIBRATION_STATE', planId)), cal0, '何も書かない');
}

// ==== 2. 所有者だけ: 管理者の役割があっても、ほかの人は断る ====
{
  env.task('saveMember(__in)', { __in: { email: MEMBER, displayName: 'メンバー' } });
  env.task('grantRole(__in)', { __in: { email: MEMBER, role: 'ADMIN', scopeType: 'ALL' } });
  const cal0 = JSON.stringify(engRows(env, 'CALIBRATION_STATE', planId));
  const jobs0 = jobProps(env);
  const runs0 = audits(env, 'PLAN.CALIBRATION.SET').length;
  env.as(MEMBER);
  // エディタの入口（所有者だけ）
  env.props.OWNER_TASK = JSON.stringify({ action: 'setCalibration', planId, set: { bias_correction_factor: 1 }, reason: 'x' });
  assert.throws(() => env.call('apiOwnerTask()'), /権限がありません/);
  delete env.props.OWNER_TASK;
  // 画面の入口（apiStartJob）: 保存の操作として始めても断り、断ったことを記録する
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.EDIT', payload: { planId, action: 'CALIBRATION.SET', args: { set: { bias_correction_factor: 1 }, reason: 'x' } } } }), /権限がありません/);
  assert.ok(env.audit().some((a) => a.phase === 'DENIED' && a.action === 'JOB.START' && a.actor_email === MEMBER), '断ったことを記録する');
  // ほかの管理者の保存（担当者）は今までどおり始められる（所有者だけなのは補正の値だけ）
  const v = env.call('apiPlanView(__in)', { __in: { planId } });
  assert.equal(v.can.admin, true);
  env.as(OWNER);
  assert.equal(jobProps(env), jobs0, '処理を入れない');
  // 裏の処理の中でも確かめ直す（頼んだ人が所有者でなければ、動かす前に止める）
  const st = runQueued(env, 'PLAN.EDIT', { planId, action: 'CALIBRATION.SET', args: { set: { bias_correction_factor: 1 }, reason: 'x' } }, MEMBER);
  assert.equal(st.status, 'FAILED');
  assert.match(st.error, /権限がありません/);
  assert.equal(JSON.stringify(engRows(env, 'CALIBRATION_STATE', planId)), cal0, '何も書かない');
  assert.equal(audits(env, 'PLAN.CALIBRATION.SET').length, runs0, '中身は動かしていない');
}

// ==== 3. AI の効きを 0 にすると、A-9 の AI の倍率だけが 1 になる（同じ乱数で前と後の予測を比べる） ====
{
  // 2 回の予測で同じ乱数の並びにする（種は予測が読む表の中身から決まる。ここでは補正の値を変えて比べるので、種が変わる。ここでは固定する）
  env.run(`(() => { const orig = appWithSeededRandom_; appWithSeededRandom_ = function (seed, fn) { return orig('FIXED-SEED', fn); }; })()`);
  const influence = () => {
    const vals = env.call(`appEngLoadPlanSheets_(__p, ['OUTPUT'], true).OUTPUT.values`, { __p: planId });
    const r = vals.findIndex((row) => row[0] === 'Month' && row[5] === 'kAI');
    assert.ok(r > 0, '入力パラメータの影響の表');
    const head = vals[r];
    return vals.slice(r + 1, r + 13).map((row) => Object.fromEntries(head.map((h, j) => [h, row[j]])));
  };
  const impacts = () => engRows(env, 'AI_IMPACT_HISTORY', planId);
  const run = () => { const st = env.runJob('FORECAST.RUN', { planId, confirms: ['extreme'] }); assert.equal(st.status, 'DONE', st.error); return st.result; };

  const r1 = run();
  // 予測の注記（OUTPUT!A6 の写し）: 旧来の A-9 は「なし（全項目既定値）」と C-1 への案内を書く。C-1 を止めている間は、画面に案内を出さない
  const a6 = () => String(env.call(`appEngLoadPlanSheets_(__p, ['OUTPUT'], true).OUTPUT.values`, { __p: planId })[5][0]);
  const notes = () => { const o = env.call('apiPlanView(__in)', { __in: { planId } }).boot.output; return o.policyLines.join('\n') + '\n' + o.engineNote; };
  assert.match(a6(), /適用中の四半期チューニング: なし（全項目既定値） \/ 3か月以上の実績確定後に C-1 を実行してください。/, '前提: 旧来の A-9 の注記');
  assert.match(notes(), /適用中の四半期チューニング: なし（全項目既定値）/, '補正が自動の学びの値なら、そのまま');
  assert.doesNotMatch(notes(), /C-1 を実行してください/, '止めている C-1 は案内しない');
  const inf1 = influence();
  const imp1 = impacts();
  assert.equal(imp1.length, 12);
  assert.ok(imp1.every((x) => Number(x.k_ai) > 1), '前: AI の倍率が効いている（上向き）: ' + imp1.map((x) => x.k_ai).join(','));
  assert.ok(inf1.every((x) => x.kAI > 1));

  const st = setCal(env, { planId, set: { ai_weight_override: 0 }, reason: 'D8 AI の効きを止める' });
  assert.equal(st.status, 'DONE', st.error);
  assert.deepEqual(st.result.result.changed, [{ field: 'ai_weight_override', old: '', new: 0 }]);
  assert.deepEqual(st.result.result.warnings, [ANNUAL_WARNING], '書いた後も係数 0.8・月ごとの補正が残る（年度の P10/P50/P90 には掛からない）');
  assert.equal(engRows(env, 'CALIBRATION_STATE', planId)[0].ai_weight_override, '0', '0 は空にしない（0 を未設定として扱わない）');
  assert.equal(engRows(env, 'CALIBRATION_STATE', planId)[0].bias_correction_factor, '0.8', 'ほかの項目はそのまま');

  const r2 = run();
  // 所有者が承認した値を書いた後の注記: 「適用中の四半期チューニング: なし（全項目既定値）」ではなく、所有者が承認した値とその値（行のほかの文はそのまま）
  const OWNER_NOTE = '適用中の補正: 所有者が承認した値（偏りの補正 0.80・月ごとの補正 4 月 5.0% 上げ、9 月 10.0% 下げ・AI の効き 0%）';
  assert.match(a6(), /適用中の四半期チューニング: なし（全項目既定値）/, '旧来の A-9 の注記はそのまま（データは変えない）');
  const n2 = notes();
  assert.ok(n2.endsWith(OWNER_NOTE), n2);
  assert.doesNotMatch(n2, /四半期チューニング|全項目既定値|C-1 を実行してください/);
  assert.match(n2, /AI取込警告サマリー/, 'ほかの文は残す');
  // C-1 を止めていなければ、案内はそのまま出す（止めを外して、画面の中身を組み立て直す）
  env.run("APP_PLAN_ACTIONS['REVIEW.GENERATE'].paused = ''");
  for (const k of Object.keys(env.cache)) delete env.cache[k];
  assert.ok(notes().endsWith(OWNER_NOTE + ' / 3か月以上の実績確定後に C-1 を実行してください。'), notes());
  env.run("APP_PLAN_ACTIONS['REVIEW.GENERATE'].paused = APP_REVIEW_GENERATE_PAUSED");
  for (const k of Object.keys(env.cache)) delete env.cache[k];
  assert.doesNotMatch(notes(), /C-1 を実行してください/);
  const inf2 = influence();
  const imp2 = impacts().slice(12);
  assert.equal(imp2.length, 12);
  assert.ok(imp2.every((x) => x.k_ai === '1'), '後: AI の倍率はどの月も 1: ' + imp2.map((x) => x.k_ai).join(','));
  assert.deepEqual(imp2.map((x) => x.ai_total_score), imp1.map((x) => x.ai_total_score), 'AI の調べ（点数）はそのまま記録する（当たりは後から測れる）');
  assert.deepEqual(imp2.map((x) => x.pred_p50_quant_only), imp1.map((x) => x.pred_p50_quant_only), '統計だけの予測は同じ');
  for (let i = 0; i < 12; i++) {
    const a = inf1[i], b = inf2[i];
    assert.equal(b.kAI, 1, 'AI の層は 1: ' + a.Month);
    for (const k of ['Month', 'Ops基礎', 'kProd', 'kClient', 'kOpinion(P50)', 'Known Spot Expected', 'Known Spot P50', '背景SPOT(P50)', '定量P50']) {
      assert.equal(b[k], a[k], 'ほかの層は変わらない: ' + k + ' ' + a.Month);
    }
    assert.ok(b['混合P50(cal)'] < a['混合P50(cal)'], 'AI の上向きの分だけ予測が下がる: ' + a.Month);
  }
  assert.equal(r2.headline.objective.p50, r1.headline.objective.p50, '客観（統計だけ）の年間は同じ');
  assert.ok(r2.headline.annual.p50 < r1.headline.annual.p50);
  // 11. 予測の記録（FORECAST_SNAPSHOT.calibration_applied_json）: AI の重み 0 で動かした予測は 0 と書く（空にすると「上書きなし」に見える）
  const appliedOf = () => {
    const snap = engRows(env, 'FORECAST_SNAPSHOT', planId);
    const sids = [...new Set(snap.map((r) => r.snapshot_id))];
    return sids.map((sid) => [...new Set(snap.filter((r) => r.snapshot_id === sid).map((r) => r.calibration_applied_json))].map((t) => JSON.parse(t)));
  };
  const ap = appliedOf();
  assert.equal(ap.length, 2, '前提: 予測 2 回分の記録');
  assert.ok(ap.every((x) => x.length === 1), '1 回の予測の行は、どれも同じ補正の記録');
  assert.deepEqual([ap[0][0].ai_weight_override, ap[1][0].ai_weight_override], ['', 0], '前: 上書きなし（空）・後: 所有者が承認した 0（数の 0）');
  assert.deepEqual([ap[1][0].bias_correction_factor, ap[1][0].residual_month_bias_json, ap[1][0].ai_max_abs_effect_override, ap[1][0].quarter],
    [0.8, '{"4":0.05,"9":-0.1}', '', ''], 'ほかの項目は前と同じ書き方');

  // 前の C-3 の四半期が CALIBRATION_STATE に残っている（last_applied_quarter）と、旧来の A-9 は四半期と「・」の行を書き、AI の効き 0 を「既定」と書く。
  // 所有者が承認した値の後は、その区切りをまるごと、所有者が承認した値とその値に書き換える（前の四半期の値とは書かない）
  const setQuarter = (q, rid) => editLegacy(env, planId, ['CALIBRATION_STATE'], `function (b) {
    const sh = b.getSheetByName('CALIBRATION_STATE'); const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    sh.getRange(2, head.indexOf('last_applied_quarter') + 1).setValue(__q); sh.getRange(2, head.indexOf('last_applied_review_id') + 1).setValue(__rid); }`, { __q: q, __rid: rid });
  setQuarter('FY2026-Q1', 'R-OLD');
  assert.match(engRows(env, 'CALIBRATION_STATE', planId)[0].note, /^owner-approved /, '前提: 所有者が承認した値のまま');
  run();
  assert.ok(a6().endsWith('適用中の四半期チューニング: FY2026-Q1 / ・ai_weight_override: 既定 / ・ai_topic_disable: [] / ・bias_correction_factor: 0.8 / 次回の四半期レビューは3か月後に C-1 を実行してください。'),
    '前提: 旧来の A-9 の四半期の書き方: ' + a6());
  const n3 = notes();
  assert.ok(n3.endsWith(OWNER_NOTE), n3);
  assert.doesNotMatch(n3, /四半期チューニング|FY2026-Q1|ai_weight_override|ai_topic_disable|bias_correction_factor|C-1 を実行してください/, '四半期・「・」の行・C-1 への案内は出さない');
  assert.match(n3, /AI取込警告サマリー: なし/, 'ほかの文は残す');
  env.run("APP_PLAN_ACTIONS['REVIEW.GENERATE'].paused = ''");
  for (const k of Object.keys(env.cache)) delete env.cache[k];
  assert.ok(notes().endsWith(OWNER_NOTE + ' / 次回の四半期レビューは3か月後に C-1 を実行してください。'), 'C-1 を止めていなければ案内は残す: ' + notes());
  env.run("APP_PLAN_ACTIONS['REVIEW.GENERATE'].paused = APP_REVIEW_GENERATE_PAUSED");
  for (const k of Object.keys(env.cache)) delete env.cache[k];
  setQuarter('', '');   // 後の確かめのために戻す（ほかの列はそのまま）
}

// ==== 4. D2 + D7 + D8 + 取り下げを 1 回で頼む（README の例） ====
let readmeTask;
{
  const pv = task(env, { action: 'calibrationPreview', planId }).result;
  assert.equal(pv.client, CLIENT);
  assert.deepEqual(pv.values, { bias_correction_factor: 0.8, residual_month_bias_json: '{"4":0.05,"9":-0.1}', auto_update_enabled: 1, ai_weight_override: 0 });
  assert.deepEqual(pv.sheets, { state: true, history: true, reviewLog: true });
  assert.equal(pv.pending, null, 'この計画には承認待ちの見直し案が無い');
  assert.equal(pv.frozen, false);
  assert.deepEqual(pv.warnings, [ANNUAL_WARNING], '今の係数 0.8 と月ごとの補正は、年度の P10/P50/P90 には掛からない（止めない）');
  assert.match(pv.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(env.props.OWNER_TASK, JSON.stringify({ action: 'calibrationPreview', planId }), '読むだけなので頼みは残る');
  delete env.props.OWNER_TASK;

  const before = env.call('apiPlanView(__in)', { __in: { planId } }).boot.learning;
  assert.deepEqual([before.autoUpdate, before.biasFactor, before.monthBias], [true, 0.8, { 4: 0.05, 9: -0.1 }]);
  const hist0 = histBefore();
  assert.equal(hist0.length, 3);

  // README の例（planId と inputHash だけ写す）
  const readme = await readFile(path.join(repoRoot, 'app', 'README.md'), 'utf8');
  const m = /`(\{"action":"setCalibration","planId":"PL-…"[^`]*"withdrawPendingReview":true[^`]*\})`/.exec(readme);
  assert.ok(m, 'README に D2・D7・D8・取り下げを 1 回で頼む例がある');
  readmeTask = JSON.parse(m[1]);
  assert.deepEqual(readmeTask.set, { auto_update_enabled: 0, bias_correction_factor: 1, residual_month_bias_json: '{}', ai_weight_override: 0 });
  assert.equal(readmeTask.withdrawPendingReview, true);
  const t = Object.assign({}, readmeTask, { planId, inputHash: pv.inputHash });
  delete t.action;
  const st = setCal(env, t);
  assert.equal(st.status, 'DONE', st.error);
  const res = st.result.result;
  assert.deepEqual(res.changed, [
    { field: 'bias_correction_factor', old: 0.8, new: 1 },
    { field: 'residual_month_bias_json', old: '{"4":0.05,"9":-0.1}', new: '{}' },
    { field: 'auto_update_enabled', old: 1, new: 0 }]);
  assert.deepEqual(res.unchanged, [{ field: 'ai_weight_override', value: 0 }], 'もう 0 の項目は書かない');
  assert.equal(res.withdrawn, null, '取り下げる見直し案が無ければ何もしない');
  assert.deepEqual(res.warnings, [], '係数 1・月ごとの補正なしなら注意は無い');
  assert.deepEqual(st.result.changed.sort(), ['CALIBRATION_HISTORY', 'CALIBRATION_STATE']);

  // CALIBRATION_STATE: 承認した値・書いた人と日時・理由。ほかの列はそのまま
  const row = engRows(env, 'CALIBRATION_STATE', planId);
  assert.equal(row.length, 1, '行は増やさない');
  assert.equal(row[0].client, CLIENT);
  assert.deepEqual([row[0].bias_correction_factor, row[0].residual_month_bias_json, row[0].auto_update_enabled, row[0].ai_weight_override], ['1', '', '0', '0']);
  assert.deepEqual([row[0].ai_max_abs_effect_override, row[0].ai_topic_disable_json, row[0].qual_scale_override, row[0].last_applied_quarter, row[0].last_applied_review_id],
    ['', '[]', '', '', ''], 'ほかの列はそのまま');
  assert.equal(row[0].updated_by, OWNER);
  assert.ok(Math.abs(Date.parse(row[0].updated_at) - Date.now()) < 120000, '書いた日時');
  assert.match(row[0].note, /^owner-approved \d{4}-\d{2}-\d{2} \d{2}:\d{2}: 2026-10-07 決定/);

  // 履歴: 前の行はそのまま残り、変えた項目ごとに 1 行（B-5・C-3 と同じ形）
  const hist1 = histBefore();
  assert.equal(hist1.length, hist0.length + 3);
  assert.deepEqual(hist1.slice(0, hist0.length), hist0, '前の履歴は消さない・変えない');
  const added = hist1.slice(hist0.length);
  assert.deepEqual(added.map((r) => [r.factor_name, r.old_value, r.new_value]), [
    ['bias_correction_factor', '0.8', '1'], ['residual_month_bias_json', '{"4":0.05,"9":-0.1}', '{}'], ['auto_update_enabled', '1', '0']]);
  for (const r of added) {
    assert.equal(r.changed_by, OWNER);
    assert.equal(r.client, CLIENT);
    assert.equal(r.review_id, 'OWNER-APPROVED');
    assert.equal(r.quarter_label, quarterNow(), '書いた日の四半期（B-5 と同じ）');
    assert.match(r.change_id, /^[0-9a-f-]{36}$/);
    assert.ok(Math.abs(Date.parse(r.changed_at) - Date.now()) < 120000);
    assert.match(r.rollback_hint, /setCalibration/);
  }
  assert.equal(new Set(hist1.map((r) => r.change_id)).size, hist1.length, '履歴の ID は重ならない');
  assert.deepEqual(Object.keys(added[0]).filter((k) => k !== 'plan_id' && k !== 'seq' && k !== '_types'),
    ['change_id', 'changed_at', 'changed_by', 'client', 'quarter_label', 'review_id', 'factor_name', 'old_value', 'new_value', 'rollback_hint']);

  // 記録: 計画の操作の記録と監査（開始に頼んだ中身、終わりに前と後の値）
  const act = env.table('PLAN_ACTIONS').filter((r) => r.plan_id === planId && r.action === 'CALIBRATION.SET').slice(-1)[0];
  assert.equal(act.actor_email, OWNER);
  assert.deepEqual(JSON.parse(act.changed_sheets_json).sort(), ['CALIBRATION_HISTORY', 'CALIBRATION_STATE']);
  assert.match(act.engine_version, /^2\./, '旧来の関数の版を残す');
  const start = audits(env, 'PLAN.CALIBRATION.SET', 'START').slice(-1)[0];
  const end = audits(env, 'PLAN.CALIBRATION.SET', 'END').slice(-1)[0];
  assert.equal(end.result, 'OK');
  assert.equal(end.actor_email, OWNER);
  assert.equal(JSON.parse(start.detail_json).args.set.bias_correction_factor, 1);
  assert.match(JSON.parse(start.detail_json).args.reason, /2026-10-07 決定/);
  assert.deepEqual(JSON.parse(end.after_json).result.changed.map((x) => x.field), ['bias_correction_factor', 'residual_month_bias_json', 'auto_update_enabled']);

  // 控えの更新: 計画の画面・学びの画面は新しい値を出す（書いた後に古い中身を返さない）
  const after = env.call('apiPlanView(__in)', { __in: { planId } }).boot.learning;
  assert.deepEqual([after.autoUpdate, after.biasFactor, after.monthBias], [false, 1, {}]);
  assert.equal(env.call('apiLearningView(__in)', { __in: { planId } }).factorNow, 1);
  const ai = env.call('apiAiLearning()');
  const path1 = ai.calibration.filter((c) => c.planId === planId)[0].path;
  const owned = path1.filter((p) => p.source === 'OWNER-APPROVED');
  assert.equal(owned.length, 4, 'AI の効き・係数・暦月の補正・旗の 4 行');
  assert.ok(owned.every((p) => p.sourceLabel === '所有者が承認した値'));
  assert.ok(path1.some((p) => p.source === 'AUTO-MONTHLY' && p.sourceLabel === '月次の自動学習'), '前の自動学習の行も出る');
  assert.equal(owned.filter((p) => p.factor === 'auto_update_enabled')[0].factorLabel, '自動の学び');
}

// ==== 5. 同じ頼みをもう一度: 何も書かない。月次の自動学習（B-5）は止まっている ====
{
  const cal0 = JSON.stringify(engRows(env, 'CALIBRATION_STATE', planId));
  const hist0 = JSON.stringify(histBefore());
  const sheets0 = JSON.stringify(env.table('ENG_SHEETS').filter((r) => r.plan_id === planId && /^CALIBRATION_/.test(r.sheet)).map((r) => [r.sheet, r.content_hash]));
  const t = Object.assign({}, readmeTask, { planId });
  delete t.action;
  const st = setCal(env, t);
  assert.equal(st.status, 'DONE', st.error);
  assert.deepEqual(st.result.result.changed, []);
  assert.deepEqual(st.result.result.unchanged.map((x) => x.field), ['bias_correction_factor', 'residual_month_bias_json', 'auto_update_enabled', 'ai_weight_override']);
  assert.deepEqual(st.result.changed, [], 'シートは変わらない');
  assert.equal(JSON.stringify(engRows(env, 'CALIBRATION_STATE', planId)), cal0, '書いた日時も変えない');
  assert.equal(JSON.stringify(histBefore()), hist0, '履歴も足さない');
  assert.equal(JSON.stringify(env.table('ENG_SHEETS').filter((r) => r.plan_id === planId && /^CALIBRATION_/.test(r.sheet)).map((r) => [r.sheet, r.content_hash])), sheets0);
  // B-5: 旗が 0 なので学ばない（補正はそのまま）
  const learn = env.runJob('PLAN.RUN', { planId, action: 'LEARN.MONTHLY' });
  assert.equal(learn.status, 'DONE', learn.error);
  assert.equal(learn.result.result.result.skipped, 'auto_update_disabled');
  assert.equal(JSON.stringify(engRows(env, 'CALIBRATION_STATE', planId)), cal0, 'B-5 は補正を変えない');
  assert.equal(JSON.stringify(histBefore()), hist0);
  // 元に戻すときも同じ口で書ける（AI の効きは "" で CONFIG の値に戻す）
  const back = setCal(env, { planId, set: { ai_weight_override: '' }, reason: '戻すときの確かめ' });
  assert.equal(back.status, 'DONE', back.error);
  assert.deepEqual(back.result.result.changed, [{ field: 'ai_weight_override', old: 0, new: '' }]);
  assert.equal(engRows(env, 'CALIBRATION_STATE', planId)[0].ai_weight_override, '');
  assert.deepEqual(histBefore().slice(-1).map((r) => [r.factor_name, r.old_value, r.new_value]), [['ai_weight_override', '0', '']]);
  const again = setCal(env, { planId, set: { ai_weight_override: 0 }, reason: 'D8 にもう一度' });
  assert.deepEqual(again.result.result.changed, [{ field: 'ai_weight_override', old: '', new: 0 }]);
  assert.deepEqual(again.result.result.warnings, []);
  // 注意: 月ごとの補正だけでも出す（書くのは止めない）。値を書かない頼み（取り下げだけ）でも、書いた後の値で決める。戻せば消える
  const pv0 = task(env, { action: 'calibrationPreview', planId }).result;
  delete env.props.OWNER_TASK;
  assert.deepEqual(pv0.warnings, [], '係数 1・月ごとの補正なし');
  const mb = setCal(env, { planId, set: { residual_month_bias_json: '{"4":0.05}' }, reason: '注意の確かめ' });
  assert.equal(mb.status, 'DONE', mb.error);
  assert.deepEqual([mb.result.result.changed.map((x) => x.field), mb.result.result.warnings], [['residual_month_bias_json'], [ANNUAL_WARNING]], '書いて、注意を返す');
  const only = setCal(env, { planId, withdrawPendingReview: true, reason: '取り下げだけ' });
  assert.deepEqual([only.status, only.result.result.withdrawn, only.result.result.warnings], ['DONE', null, [ANNUAL_WARNING]], '値を書かなくても、今の値の注意');
  const pv1 = task(env, { action: 'calibrationPreview', planId }).result;
  delete env.props.OWNER_TASK;
  assert.deepEqual(pv1.warnings, [ANNUAL_WARNING]);
  const f = setCal(env, { planId, set: { residual_month_bias_json: '{}', bias_correction_factor: 1.1 }, reason: '係数だけ' });
  assert.deepEqual(f.result.result.warnings, [ANNUAL_WARNING], '係数だけでも出す');
  const off = setCal(env, { planId, set: { bias_correction_factor: 1 }, reason: '戻す' });
  assert.deepEqual(off.result.result.warnings, [], '戻せば消える');
  assert.deepEqual(J(env.run(`appCalibrationWarnings_(null)`)), [], '値が読めなければ出さない');
}

// ==== 6. 見直し案を作る（C-1）は止めている。判断の保存と反映（C-3）はそのまま ====
{
  const jobs0 = jobProps(env);
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.RUN', payload: { planId, action: 'REVIEW.GENERATE' } } }),
    /見直し案を作る操作は、学びの仕組みを直すまで止めています（2026\/10\/07 所有者の決定）。/);
  assert.equal(jobProps(env), jobs0, '処理を入れない');
  assert.ok(env.errors().some((e) => /学びの仕組みを直すまで止めています/.test(e.message)), 'エラーのログに残る');
  const view = env.call('apiPlanView(__in)', { __in: { planId } });
  const act = (a) => view.actions.filter((x) => x.action === a)[0];
  assert.match(act('REVIEW.GENERATE').paused, /学びの仕組みを直すまで止めています/);
  assert.equal(act('REVIEW.DECIDE').paused, '');
  assert.equal(act('REVIEW.APPLY').paused, '');
  assert.equal(act('LEARN.MONTHLY').paused, '');
  // 画面: 押せないボタンにし、止めている理由をカーソルで出す（ほかの実行は押せる）
  const ui = loadUi();
  ui.__v = view;
  vm.runInContext(`S.view='forecast'; S.fc.plans=[{planId:'${planId}'}]; S.fc.planId='${planId}'; S.fc.view=__v; S.fc.data={plan:__v.plan,latest:null,runs:[],stored:null};`, ui);
  const html = fcSection(vm.runInContext(`viewForecast()`, ui), 'review');
  assert.doesNotMatch(html, /fcRun\('REVIEW\.GENERATE'\)/);
  assert.match(html, /data-tip="AI の見直し案を作る\n見直し案を作る操作は、学びの仕組みを直すまで止めています（2026\/10\/07 所有者の決定）。"><button class="btn btn-ghost" disabled aria-disabled="true">見直し案を作る<\/button>/);
  assert.match(html, /fcRun\('EVAL\.REPORT'\)/);
  // 補正を学び直す（B-5）も、旗を 0 にした（D2）ので押せないボタンにする（動かしても補正は変わらない）
  assert.doesNotMatch(html, /fcRun\('LEARN\.MONTHLY'\)/);
  assert.match(html, /data-tip="実績から補正を学び直す\n自動の学びを止めています（\d{4}\/\d{2}\/\d{2} 所有者が設定）。今は動かしても補正は変わりません。"><button class="btn btn-ghost" disabled aria-disabled="true">補正を学び直す<\/button>/);
  // 反映済みの見直し案の札: 止めている間は「見直し案を作る」を案内せず、止めている理由を出す（止めていなければ、今までどおり案内する）
  ui.__q = { title: '', period: '', reviewId: 'R-1', applied: true, logRecent: [],
    proposals: [{ row: 8, pid: 'P1', target: 'ai_weight_override', current: '0.002', proposed: '0.001', conf: '中', rationale: '', impact: '', decision: '承認', rollback: '' }] };
  const chip = () => /<span class="chip ok" data-tip="([^"]*)">反映済み<\/span>/.exec(vm.runInContext('fcRvProposals(__q)', ui))[1];
  assert.equal(chip(), 'この見直し案は反映済みです。見直し案を作る操作は、学びの仕組みを直すまで止めています（2026/10/07 所有者の決定）。');
  ui.__v2 = Object.assign({}, view, { actions: view.actions.map((x) => Object.assign({}, x, { paused: '' })) });
  vm.runInContext('S.fc.view = __v2', ui);
  assert.equal(chip(), 'この見直し案は反映済みです。新しい案は「見直し案を作る」で作ります');
  // 予測の注記: 四半期レビューを反映した後の案内（次回の C-1）も、止めている間は出さない。ほかの文・「なし」以外のチューニングはそのまま
  const out = { output: { policyLines: ['適用中の四半期チューニング: FY2026-Q1 / ・ai_weight_override: 既定 / 次回の四半期レビューは3か月後に C-1 を実行してください。 / 補正の警告'],
    engineNote: '経過月は実績…\n適用中の四半期チューニング: なし（全項目既定値） / 3か月以上の実績確定後に C-1 を実行してください。' } };
  env.run('appPlanViewNotes_(__o, { getSheetByName: () => null })', { __o: out });
  assert.deepEqual(out.output, { policyLines: ['適用中の四半期チューニング: FY2026-Q1 / ・ai_weight_override: 既定 / 補正の警告'],
    engineNote: '経過月は実績…\n適用中の四半期チューニング: なし（全項目既定値）' }, '所有者が承認した値でなければ「なし」はそのまま');
  // 所有者が承認した値（CALIBRATION_STATE の note が owner-approved）なら、四半期チューニングの区切り（四半期と「・」の行）だけを書き換える。
  // 後ろの警告（旧来の calibrationWarning）・前の行はそのまま。AI の効きが空なら既定（業務の設定の値）、小さい値は 2 けた
  const HS = env.run('APP_ENGINE_SHEETS.CALIBRATION_STATE.header');
  const stateBook = (o) => { const rows = [HS, HS.map((h) => (o[h] === undefined ? '' : o[h]))];
    return { getSheetByName: (n) => (n === 'CALIBRATION_STATE' ? { getLastRow: () => rows.length, getDataRange: () => ({ getValues: () => rows }) } : null) }; };
  const owned = (state, text) => { const o = { output: { policyLines: [text], engineNote: 'AI取込警告サマリー: なし\n' + text } }; env.run('appPlanViewNotes_(__o, __b)', { __o: o, __b: stateBook(state) }); return o.output; };
  const quarterText = '経過月は実績… 適用中の四半期チューニング: FY2026-Q1 / ・ai_weight_override: 0.002 / ・ai_topic_disable: ["DX"] / ・bias_correction_factor: 1.1 / '
    + '次回の四半期レビューは3か月後に C-1 を実行してください。 / ⚠ calibration読み込み失敗 / fallbackで実行';
  const o1 = owned({ client: CLIENT, bias_correction_factor: 1, residual_month_bias_json: '', ai_weight_override: '', note: 'owner-approved 2026-10-07 10:00: x' }, quarterText);
  const want1 = '経過月は実績… 適用中の補正: 所有者が承認した値（偏りの補正 1.00・月ごとの補正 なし・AI の効き 既定） / ⚠ calibration読み込み失敗 / fallbackで実行';
  assert.deepEqual(o1, { policyLines: [want1], engineNote: 'AI取込警告サマリー: なし\n' + want1 });
  const o2 = owned({ bias_correction_factor: '0.9', residual_month_bias_json: '{"12":0.02}', ai_weight_override: '0.0008', note: 'owner-approved 2026-10-07 10:00: x' },
    'AI取込警告サマリー: なし 適用中の四半期チューニング: なし（全項目既定値） / 3か月以上の実績確定後に C-1 を実行してください。');
  assert.deepEqual(o2.policyLines, ['AI取込警告サマリー: なし 適用中の補正: 所有者が承認した値（偏りの補正 0.90・月ごとの補正 12 月 2.0% 上げ・AI の効き 0.08%）']);
  assert.deepEqual(owned({ bias_correction_factor: 0.9, note: 'auto-learned' }, quarterText).policyLines,
    [quarterText.replace(' / 次回の四半期レビューは3か月後に C-1 を実行してください。', '')], '自動の学びの値なら四半期の書き方はそのまま');
}

// ==== 7. 締めた年度の計画には書かない ====
{
  const past = currentFy - 1;
  const output = [['FY' + past + ' 売上予測（テスト薬品）']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 900, 1000, 1100]);
  output.push([], []);
  for (let i = 0; i < 12; i++) output.push([D(past, 4 + i, 1), 70, 80, 90, '', '', '', 80, '']);
  const H = env.run('APP_ENGINE_SHEETS.CALIBRATION_STATE.header');
  const HH = env.run('APP_ENGINE_SHEETS.CALIBRATION_HISTORY.header');
  const pastPlan = env.seedPlan(env.makeBook('過去の計画', {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', 'テスト薬品'], ['[必須] 予測年度FY（YYYY）', past], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    OUTPUT: { values: output },
    CALIBRATION_STATE: { values: [H, H.map((h) => ({ client: 'テスト薬品', bias_correction_factor: 0.8, auto_update_enabled: 1, ai_topic_disable_json: '[]' })[h] ?? '')] },
    CALIBRATION_HISTORY: { values: [HH] }
  }));
  const sub = env.call('appTestVersionSubmit_(__in)', { __in: { planId: pastPlan } });
  env.call('appTestVersionDecide_(__in)', { __in: { versionId: sub.version.versionId, decision: 'APPROVED', rowVersion: sub.version.rowVersion } });
  const yp = env.task('yearPreview(__in)', { __in: { fy: past } });
  assert.equal(yp.canClose, true, JSON.stringify(yp));
  const closed = env.runJob('YEAR.CLOSE', { fy: past, inputHash: yp.inputHash });
  assert.equal(closed.status, 'DONE', closed.error);
  const cal0 = JSON.stringify(engRows(env, 'CALIBRATION_STATE', pastPlan));
  fails(env, { action: 'setCalibration', planId: pastPlan, set: { bias_correction_factor: 1 }, reason: 'x' }, /締め済み/);
  assert.equal(JSON.stringify(engRows(env, 'CALIBRATION_STATE', pastPlan)), cal0, '締めた年度の行は変えない');
  // 読むのはできる（凍結の印つき）
  const pv = task(env, { action: 'calibrationPreview', planId: pastPlan }).result;
  delete env.props.OWNER_TASK;
  assert.equal(pv.frozen, true);
  assert.equal(pv.values.bias_correction_factor, 0.8);
  // 裏の処理の中でも止まる（始めた後に締められた場合）
  const st = runQueued(env, 'PLAN.EDIT', { planId: pastPlan, action: 'CALIBRATION.SET', args: { set: { bias_correction_factor: 1 }, reason: 'x' } });
  assert.equal(st.status, 'FAILED');
  assert.match(st.error, /締め済み/);
}

/**
 * 見直し案を作れる計画（3 か月の実績と評価・人の押し・AI の倍率の記録）。本物の C-1 で 2 件の案ができる。
 * withHistory: CALIBRATION_HISTORY の表も置く（C-3 が反映したときの履歴を数えるため）
 */
function seedReviewPlan(e, name, withHistory) {
  const H = e.run('(() => { const o = {}; Object.keys(APP_ENGINE_SHEETS).forEach(k => { o[k] = APP_ENGINE_SHEETS[k].header || null; }); return o; })()');
  const row = (sheet, o) => H[sheet].map((h) => (o[h] === undefined ? '' : o[h]));
  const MONTHS = [['2026/04', 1200, 1000], ['2026/05', 800, 1000], ['2026/06', 1050, 1000]];
  const evalLog = [H.EVAL_LOG].concat(...MONTHS.map(([ym, act, p50], i) => [['nega', p50 * 0.95], ['neutral', p50], ['posi', p50 * 1.05]]
    .map(([sc, p]) => row('EVAL_LOG', { eval_id: 'E' + i + sc, evaluated_at: D(2026, 9, 1), client: CLIENT, target_month: ym, scenario: sc, pred: p, actual: act,
      signed_error: p - act, abs_error: Math.abs(p - act), bias_direction: p > act ? 'over' : 'under', constraint_relevant_flag: sc === 'neutral' ? 1 : 0,
      evaluation_policy_version: 'policy-2026H1-v3' }))));   // 今の検証の版で測った行（締まった月だけ・月が始まる前の予測。2026-10-07 決定 4〜6）
  const run1 = D(2026, 3, 20);
  const impact = (m) => row('AI_IMPACT_HISTORY', { run_id: 'R1', run_at: run1, client: CLIENT, target_month: D(2026, m), k_ai: 1, ai_direction: 'flat', pred_p50: 1000, pred_p50_quant_only: 1000, forecast_source: 'forecast_open' });
  const push = (m, type, key, dir) => row('SUBJECTIVE_IMPACT_HISTORY', { run_id: 'R1', run_at: run1, client: CLIENT, target_month: D(2026, m), source_type: type,
    source_key: key, push_step: dir * 0.05, push_direction: dir, applied_reliability_r: 1, forecast_source: 'forecast_open' });
  const sheets = {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', CLIENT], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野,佐藤']] },
    PROCESS_STATUS: { values: [H.PROCESS_STATUS, ['step4_status', D(2026, 9, 1), 'owner', 'success', CLIENT, 12, ''], ['step5_status', D(2026, 9, 1), 'owner', 'success', CLIENT, 9, '']] },
    RUN_LOG: { values: [H.RUN_LOG] },
    EVAL_LOG: { values: evalLog, formats: { D: '@' } },
    // 実績は月末から 5 日より後（7/10）に取り込んだので、4〜6 月は締まった月
    ACTUAL_EVAL_MONTHLY: { values: [H.ACTUAL_EVAL_MONTHLY].concat(MONTHS.map(([ym, act]) => [CLIENT, 'BASE', '製品A', ym, act, 'closed', D(2026, 7, 10)])), formats: { D: '@' } },
    AI_IMPACT_HISTORY: { values: [H.AI_IMPACT_HISTORY, impact(4), impact(5), impact(6)] },
    SUBJECTIVE_IMPACT_HISTORY: { values: [H.SUBJECTIVE_IMPACT_HISTORY, push(4, 'opinion', '鷹野', 1), push(5, 'opinion', '鷹野', -1), push(6, 'opinion', '鷹野', 1),
      push(4, 'factor_product', '佐藤', -1), push(5, 'factor_product', '佐藤', 1), push(6, 'factor_product', '佐藤', -1)] },   // 佐藤は 3 か月とも実績と逆（いつも同じ向きより外れる。2026-10-13 から当たりは基準と比べる）
    AI_SCORE_HISTORY: { values: [H.AI_SCORE_HISTORY] },
    CALIBRATION_STATE: { values: [H.CALIBRATION_STATE, [CLIENT, D(2026, 9, 1), 'owner', '', '', '[]', 1, '', '{}', '', '', 1, '']] },
    SOURCE_RELIABILITY: { values: [H.SOURCE_RELIABILITY] },
    POOL_PRIOR: { values: [H.POOL_PRIOR] },
    QUARTERLY_REVIEW: { values: [['']] },
    QUARTERLY_REVIEW_LOG: { values: [H.QUARTERLY_REVIEW_LOG] },
    RELIABILITY_EVIDENCE: { values: [H.RELIABILITY_EVIDENCE] },
  };
  if (withHistory) sheets.CALIBRATION_HISTORY = { values: [H.CALIBRATION_HISTORY] };
  return e.seedPlan(e.makeBook(name, sheets));
}

// ==== 8. 承認待ちの見直し案の取り下げ（本物の C-1 で作った案。C-3 は何も適用しない） ====
{
  const envB = setUpEnv();
  const planB = seedReviewPlan(envB, '予測B', false);
  // 見直し案がまだ無い計画で C-3: 止めている「見直し案を作る」へは案内しない（前は「C-1 を再実行してください。」）
  const none = envB.runJob('PLAN.RUN', { planId: planB, action: 'REVIEW.APPLY' });
  assert.equal(none.status, 'FAILED');
  assert.equal(none.error, 'C-2 エラー: 反映できる見直し案がありません（まだ案がありません）。');
  assert.equal(engRows(envB, 'QUARTERLY_REVIEW_LOG', planB).length, 0, '何も書かない');
  // 本物の C-1 で見直し案を作る（止めているので、待ち行列に直接入れる）
  assert.throws(() => envB.call('apiStartJob(__in)', { __in: { kind: 'PLAN.RUN', payload: { planId: planB, action: 'REVIEW.GENERATE' } } }), /止めています/);
  const gen = runQueued(envB, 'PLAN.RUN', { planId: planB, action: 'REVIEW.GENERATE' });
  assert.equal(gen.status, 'DONE', gen.error);
  const log0 = engRows(envB, 'QUARTERLY_REVIEW_LOG', planB);
  assert.equal(log0.length, 2, '前提: 見直し案が 2 件');
  const rid = log0[0].review_id;
  assert.ok(log0.every((r) => r.review_id === rid && r.approval_status === '保留' && r.approval_decided_at === '' && r.applied === '0'));
  let view = envB.call('apiPlanView(__in)', { __in: { planId: planB } });
  assert.equal(view.boot.quarterly.reviewId, rid);
  assert.deepEqual(view.boot.quarterly.proposals.map((p) => p.decision), ['', '']);
  assert.equal(envB.call('apiAiLearning()').pending.filter((p) => p.planId === planB).length, 1, '前提: 承認待ちに出る');

  // 書く前に確かめる: 取り下げる見直し案が分かる
  const pv = task(envB, { action: 'calibrationPreview', planId: planB }).result;
  delete envB.props.OWNER_TASK;
  assert.deepEqual([pv.pending.reviewId, pv.pending.proposals, pv.pending.quarter], [rid, 2, 'FY2026-Q1']);
  assert.deepEqual(pv.pending.targets, log0.map((r) => r.target_field));
  assert.deepEqual([pv.pending.decisions, pv.pending.decidedAt], [['保留', '保留'], ['', '']], 'C-1 の直後: 保留で、判断の日時は空');
  assert.deepEqual(pv.sheets, { state: true, history: false, reviewLog: true });

  // 履歴の表が無い計画には値を書かない（旧来の履歴の書き込みは失敗しても黙って続けるので、先に止める）。取り下げも書かない
  const failed = setCal(envB, { planId: planB, set: { bias_correction_factor: 1 }, withdrawPendingReview: true, reason: 'x' });
  assert.equal(failed.status, 'FAILED');
  assert.match(failed.error, /この計画には CALIBRATION_HISTORY がありません/);
  assert.deepEqual(engRows(envB, 'QUARTERLY_REVIEW_LOG', planB), log0, '何も書かない');

  // 取り下げる
  const st = setCal(envB, { planId: planB, withdrawPendingReview: true, reason: '締まっていない月から作られた案（2026-10-07 決定 D3）' });
  assert.equal(st.status, 'DONE', st.error);
  const w = st.result.result.withdrawn;
  assert.deepEqual([w.reviewId, w.proposals, w.quarter, w.screen], [rid, 2, 'FY2026-Q1', true]);
  assert.deepEqual(w.before, log0.map((r) => ({ proposalId: r.proposal_id, status: '保留', decidedAt: '' })), '取り下げる前の判断を結果に残す');
  assert.deepEqual(st.result.result.changed, []);
  assert.deepEqual(st.result.changed.sort(), ['QUARTERLY_REVIEW', 'QUARTERLY_REVIEW_LOG']);
  const log1 = engRows(envB, 'QUARTERLY_REVIEW_LOG', planB);
  assert.equal(log1.length, log0.length, '行は消さない・増やさない');
  log1.forEach((r, i) => {
    assert.equal(r.approval_status, '取り下げ');
    assert.ok(Math.abs(Date.parse(r.approval_decided_at) - Date.now()) < 120000, '取り下げた日時');
    assert.equal(r.approval_decided_by, OWNER);
    assert.equal(r.applied, '0', '適用はしていない');
    assert.equal(r.applied_at, '');
    for (const k of Object.keys(r)) {
      if (['approval_status', 'approval_decided_at', 'approval_decided_by', '_types', '_row'].includes(k)) continue;
      assert.equal(r[k], log0[i][k], 'ほかの列はそのまま: ' + k);
    }
  });
  assert.deepEqual(engRows(envB, 'CALIBRATION_STATE', planB).map((r) => r.bias_correction_factor), ['1'], '補正の値は触らない');

  // 承認待ちに出ない（学び・ホーム）。計画の画面は取り下げた案として出し、判断と反映の操作は出さない
  assert.equal(envB.call('apiAiLearning()').pending.filter((p) => p.planId === planB).length, 0, '承認待ちに出ない');
  const decided = envB.call('apiPeopleLearning()').decisions.filter((d) => d.planId === planB);
  assert.equal(decided.length, 2);
  assert.ok(decided.every((d) => d.status === '取り下げ' && !d.applied), '判断の履歴は「取り下げ」');
  view = envB.call('apiPlanView(__in)', { __in: { planId: planB } });
  assert.equal(view.boot.quarterly.reviewId, '取り下げ:' + rid, 'C-3 が適用する review_id には「取り下げ:」が付く');
  assert.deepEqual(view.boot.quarterly.proposals.map((p) => p.decision), ['取り下げ', '取り下げ']);
  assert.equal(view.boot.quarterly.applied, false);
  const ui = loadUi();
  ui.__q = view.boot.quarterly;
  vm.runInContext(`S.fc.view={ can: { plan: true, approve: true, admin: true }, actions: [] };`, ui);
  const html = vm.runInContext('fcRvProposals(__q)', ui);
  assert.match(html, /<span class="chip off" data-tip="締まっていない月から作られた案なので、所有者が取り下げました（2026-10-07 の決定）。反映しません">取り下げ<\/span>/);
  assert.doesNotMatch(html, /fcDec\(|fcRvGo\(|未反映/, '判断と反映の操作は出さない');
  assert.equal((html.match(/<span class="chip st off">取り下げ<\/span>/g) || []).length, 2, '案ごとの判断も取り下げ');
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(`lrDecision({ status: '取り下げ', decidedAt: '' }, '')`, ui))), ['取り下げ', 'off', '所有者が取り下げました。反映しません']);

  // C-3（承認した案の適用）: 何も適用しない。承認の判断を保存し直しても同じ
  const rel0 = JSON.stringify(engRows(envB, 'SOURCE_RELIABILITY', planB));
  const cal0 = JSON.stringify(engRows(envB, 'CALIBRATION_STATE', planB));
  const apply = () => {
    const a = envB.runJob('PLAN.RUN', { planId: planB, action: 'REVIEW.APPLY' });
    assert.equal(a.status, 'FAILED', '適用するレビューが無い');
    assert.equal(a.error, 'C-2 エラー: 反映できる見直し案がありません（取り下げた案か、まだ案がありません）。', '止めている「見直し案を作る」へ案内しない');
    assert.equal(JSON.stringify(engRows(envB, 'SOURCE_RELIABILITY', planB)), rel0, '信頼度は変えない');
    assert.equal(JSON.stringify(engRows(envB, 'CALIBRATION_STATE', planB)), cal0, '補正は変えない');
    assert.deepEqual(engRows(envB, 'QUARTERLY_REVIEW_LOG', planB).map((r) => [r.approval_status, r.applied]), [['取り下げ', '0'], ['取り下げ', '0']]);
  };
  apply();
  const dec = envB.runJob('PLAN.EDIT', { planId: planB, action: 'REVIEW.DECIDE', args: { rows: view.boot.quarterly.proposals.map((p) => ({ row: p.row, decision: '承認' })) } });
  assert.equal(dec.status, 'DONE', dec.error);
  assert.deepEqual(envB.call('apiPlanView(__in)', { __in: { planId: planB } }).boot.quarterly.proposals.map((p) => p.decision), ['承認', '承認'], '前提: 承認を保存し直した');
  apply();
  assert.equal(envB.call('apiAiLearning()').pending.filter((p) => p.planId === planB).length, 0);

  // もう一度頼んでも、取り下げるものは無い（何も書かない）
  const log2 = JSON.stringify(engRows(envB, 'QUARTERLY_REVIEW_LOG', planB));
  const again = setCal(envB, { planId: planB, withdrawPendingReview: true, reason: 'もう一度' });
  assert.equal(again.status, 'DONE', again.error);
  assert.equal(again.result.result.withdrawn, null);
  assert.deepEqual(again.result.changed, []);
  assert.equal(JSON.stringify(engRows(envB, 'QUARTERLY_REVIEW_LOG', planB)), log2);
  assert.equal(task(envB, { action: 'calibrationPreview', planId: planB }).result.pending, null);
  delete envB.props.OWNER_TASK;
}

// ==== 9. C-3 を保留のまま動かした見直し案（本物のデータと同じ形）も取り下げる。反映した見直し案は取り下げない ====
{
  // 取り下げる計画（wc）と、比べる計画（wd。取り下げない）。どちらも本物の C-1 で案を作り、C-3 を判断なし（保留）のまま動かす
  const setUp = (name) => {
    const e = setUpEnv();
    const p = seedReviewPlan(e, name, true);
    const gen = runQueued(e, 'PLAN.RUN', { planId: p, action: 'REVIEW.GENERATE' });
    assert.equal(gen.status, 'DONE', gen.error);
    const held = e.runJob('PLAN.RUN', { planId: p, action: 'REVIEW.APPLY' });
    assert.equal(held.status, 'DONE', held.error);
    const log = engRows(e, 'QUARTERLY_REVIEW_LOG', p);
    assert.equal(log.length, 2);
    assert.ok(log.every((r) => r.approval_status === '保留' && r.approval_decided_at !== '' && r.approval_decided_by === OWNER && r.applied === '0' && r.applied_at === ''),
      '前提: 本物のデータと同じ形（保留・判断の日時あり・未反映）: ' + JSON.stringify(log.map((r) => [r.approval_status, r.approval_decided_at, r.applied])));
    assert.equal(engRows(e, 'CALIBRATION_STATE', p)[0].auto_update_enabled, '1', '前提: 自動の学びの旗は 1（承認した案は C-3 が反映する）');
    assert.equal(engRows(e, 'CALIBRATION_HISTORY', p).length, 0);
    return { e, p, rid: log[0].review_id, log };
  };
  const wc = setUp('予測C');
  const wd = setUp('予測D');
  const ui = loadUi();
  vm.runInContext(`S.fc.view={ can: { plan: true, approve: true, admin: true }, actions: [] };`, ui);
  const screen = (w) => { ui.__q = w.e.call('apiPlanView(__in)', { __in: { planId: w.p } }).boot.quarterly; return { q: ui.__q, html: vm.runInContext('fcRvProposals(__q)', ui) }; };

  // 前提: 学びの承認待ちには出ない（判断の日時があるため）が、計画の画面では未反映のままで、承認して反映できる
  let sc = screen(wc);
  assert.equal(sc.q.reviewId, wc.rid);
  assert.equal(sc.q.applied, false);
  assert.match(sc.html, /<span class="chip warn"[^>]*>未反映<\/span>/);
  assert.match(sc.html, /fcRvGo\(/);
  assert.equal(wc.e.call('apiAiLearning()').pending.filter((x) => x.planId === wc.p).length, 0);

  // 書く前に確かめる: 取り下げられる見直し案として出る（今の判断は保留・判断の日時あり）
  const pv = task(wc.e, { action: 'calibrationPreview', planId: wc.p }).result;
  delete wc.e.props.OWNER_TASK;
  assert.ok(pv.pending, 'C-3 で保留にした案も取り下げられる');
  assert.deepEqual([pv.pending.reviewId, pv.pending.proposals, pv.pending.decisions], [wc.rid, 2, ['保留', '保留']]);
  assert.ok(pv.pending.decidedAt.every((x) => x !== ''), 'C-3 が入れた判断の日時: ' + pv.pending.decidedAt.join(','));

  // 取り下げる
  const st = setCal(wc.e, { planId: wc.p, withdrawPendingReview: true, reason: 'C-3 で保留にした、締まっていない月から作られた案（2026-10-07 決定 D3）' });
  assert.equal(st.status, 'DONE', st.error);
  const w = st.result.result.withdrawn;
  assert.ok(w, '取り下げた（null ではない）');
  assert.deepEqual([w.reviewId, w.proposals, w.screen], [wc.rid, 2, true]);
  assert.deepEqual(w.before.map((x) => [x.proposalId, x.status]), wc.log.map((r) => [r.proposal_id, '保留']), '前の判断（保留）を結果に残す');
  assert.deepEqual(w.before.map((x) => x.decidedAt), pv.pending.decidedAt, '前の判断の日時も結果に残す');
  assert.deepEqual(st.result.changed.sort(), ['QUARTERLY_REVIEW', 'QUARTERLY_REVIEW_LOG']);
  const log1 = engRows(wc.e, 'QUARTERLY_REVIEW_LOG', wc.p);
  assert.equal(log1.length, wc.log.length, '行は消さない・増やさない');
  log1.forEach((r, i) => {
    assert.deepEqual([r.approval_status, r.approval_decided_by, r.applied, r.applied_at], ['取り下げ', OWNER, '0', '']);
    for (const k of Object.keys(r)) {
      if (['approval_status', 'approval_decided_at', 'approval_decided_by', '_types', '_row'].includes(k)) continue;
      assert.equal(r[k], wc.log[i][k], 'ほかの列はそのまま: ' + k);
    }
  });
  const end = audits(wc.e, 'PLAN.CALIBRATION.SET', 'END').slice(-1)[0];
  assert.deepEqual(JSON.parse(end.after_json).result.withdrawn.before.map((x) => x.status), ['保留', '保留'], '前の判断は記録にも残る');

  // 計画の画面: 取り下げた案として出し、判断と反映の操作は出さない
  sc = screen(wc);
  assert.equal(sc.q.reviewId, '取り下げ:' + wc.rid, 'C-3 が適用する review_id に「取り下げ:」が付く');
  assert.deepEqual(sc.q.proposals.map((x) => x.decision), ['取り下げ', '取り下げ']);
  assert.match(sc.html, /<span class="chip off" [^>]*>取り下げ<\/span>/);
  assert.doesNotMatch(sc.html, /fcDec\(|fcRvGo\(|未反映/);

  // 承認し直して C-3 を動かす（旗は 1）: 比べる計画（取り下げない）は反映する。取り下げた計画は何も反映しない
  const approveAndApply = (x) => {
    const q = x.e.call('apiPlanView(__in)', { __in: { planId: x.p } }).boot.quarterly;
    const dec = x.e.runJob('PLAN.EDIT', { planId: x.p, action: 'REVIEW.DECIDE', args: { rows: q.proposals.map((y) => ({ row: y.row, decision: '承認' })) } });
    assert.equal(dec.status, 'DONE', dec.error);
    return x.e.runJob('PLAN.RUN', { planId: x.p, action: 'REVIEW.APPLY' });
  };
  const snap = (x) => JSON.stringify(['CALIBRATION_STATE', 'SOURCE_RELIABILITY', 'CALIBRATION_HISTORY'].map((n) => engRows(x.e, n, x.p)));
  const d0 = snap(wd);
  const ad = approveAndApply(wd);
  assert.equal(ad.status, 'DONE', ad.error);
  assert.deepEqual(engRows(wd.e, 'QUARTERLY_REVIEW_LOG', wd.p).map((r) => [r.approval_status, r.applied]), [['承認', '1'], ['承認', '1']], '比べる計画: 取り下げなければ反映してしまう');
  assert.equal(engRows(wd.e, 'CALIBRATION_HISTORY', wd.p).filter((r) => r.review_id === wd.rid).length, 2);
  assert.notEqual(snap(wd), d0);
  // 反映済みの案でもう一度 C-3: 何も変えず、止めている「見直し案を作る」へは案内しない
  const d1 = snap(wd);
  const again2 = wd.e.runJob('PLAN.RUN', { planId: wd.p, action: 'REVIEW.APPLY' });
  assert.equal(again2.status, 'FAILED');
  assert.equal(again2.error, 'C-2 エラー: 適用済み: この見直し案は反映済みです（新しい案はまだありません）。');
  assert.equal(snap(wd), d1, '反映済みの案はもう一度反映しない');
  const c0 = snap(wc);
  const ac = approveAndApply(wc);
  assert.equal(ac.status, 'FAILED', '取り下げた計画: 適用するレビューが無い');
  assert.equal(ac.error, 'C-2 エラー: 反映できる見直し案がありません（取り下げた案か、まだ案がありません）。');
  assert.equal(snap(wc), c0, '補正・信頼度・履歴は変えない');
  assert.deepEqual(engRows(wc.e, 'QUARTERLY_REVIEW_LOG', wc.p).map((r) => [r.approval_status, r.applied]), [['取り下げ', '0'], ['取り下げ', '0']]);

  // もう一度頼んでも何もしない（全部を取り下げ済み）
  const log2 = JSON.stringify(engRows(wc.e, 'QUARTERLY_REVIEW_LOG', wc.p));
  const again = setCal(wc.e, { planId: wc.p, withdrawPendingReview: true, reason: 'もう一度' });
  assert.equal(again.status, 'DONE', again.error);
  assert.equal(again.result.result.withdrawn, null);
  assert.deepEqual(again.result.changed, []);
  assert.equal(JSON.stringify(engRows(wc.e, 'QUARTERLY_REVIEW_LOG', wc.p)), log2);
  assert.equal(task(wc.e, { action: 'calibrationPreview', planId: wc.p }).result.pending, null);
  delete wc.e.props.OWNER_TASK;

  // 反映した見直し案（比べる計画）は取り下げない（取り下げられる案として出さず、頼んでも何も書かない）
  assert.equal(task(wd.e, { action: 'calibrationPreview', planId: wd.p }).result.pending, null);
  delete wd.e.props.OWNER_TASK;
  const logD = JSON.stringify(engRows(wd.e, 'QUARTERLY_REVIEW_LOG', wd.p));
  const nd = setCal(wd.e, { planId: wd.p, withdrawPendingReview: true, reason: '反映した案' });
  assert.equal(nd.status, 'DONE', nd.error);
  assert.equal(nd.result.result.withdrawn, null);
  assert.deepEqual(nd.result.changed, []);
  assert.equal(JSON.stringify(engRows(wd.e, 'QUARTERLY_REVIEW_LOG', wd.p)), logD);
}

// ==== 10. 取り下げられる見直し案の決まり（どの案も反映していない・まだ全部は取り下げていない。判断と判断の日時では決めない） ====
{
  const H = env.run('APP_ENGINE_SHEETS.QUARTERLY_REVIEW_LOG.header');
  const mk = (rows) => [H].concat(rows.map(([rid, at, status, decidedAt, applied], i) => H.map((h) => ({ review_id: rid, proposal_id: 'P' + i, reviewed_at: at, client: CLIENT,
    quarter_label: 'FY2026-Q2', approval_status: status, approval_decided_at: decidedAt, approval_decided_by: decidedAt ? 'someone' : '', applied })[h] ?? '')));
  const t1 = D(2026, 7, 1), t2 = D(2026, 10, 3), dec = D(2026, 10, 4);
  const latest = (rows) => env.run('(() => { const x = appCalibrationLatestReview_(__v); return x && { rid: x.rid, statuses: x.statuses, withdrawable: x.withdrawable }; })()', { __v: mk(rows) });
  const cases = [
    ['C-1 の直後（保留・判断の日時なし）', [['R2', t2, '保留', '', 0], ['R2', t2, '保留', '', 0]], true],
    ['C-3 で保留（判断の日時あり・未反映）', [['R2', t2, '保留', dec, 0], ['R2', t2, '保留', dec, 0]], true],
    ['C-3 で却下', [['R2', t2, '却下', dec, 0]], true],
    ['C-3 で承認したが、旗が 0 で未反映', [['R2', t2, '承認', dec, 0], ['R2', t2, '保留', dec, 0]], true],
    ['1 つでも反映した', [['R2', t2, '承認', dec, 1], ['R2', t2, '却下', dec, 0]], false],
    ['全部を取り下げた', [['R2', t2, '取り下げ', dec, 0], ['R2', t2, '取り下げ', dec, 0]], false],
    ['一部だけ取り下げた', [['R2', t2, '取り下げ', dec, 0], ['R2', t2, '保留', dec, 0]], true],
    ['前の未反映の案より、新しい反映済みの案を見る', [['R1', t1, '保留', '', 0], ['R2', t2, '承認', dec, 1]], false],
    ['前の反映済みの案より、新しい未反映の案を見る', [['R1', t1, '承認', dec, 1], ['R2', t2, '保留', dec, 0]], true]
  ];
  for (const [name, rows, want] of cases) {
    const x = latest(rows);
    assert.equal(x.rid, 'R2', name);
    assert.equal(x.withdrawable, want, name);
  }
  assert.equal(env.run('appCalibrationLatestReview_(__v)', { __v: [H] }), null, '見直し案が無い');
  // 一部だけ取り下げた案: 残りだけを取り下げ、もう取り下げた行の日時と人はそのまま
  const book = env.makeBook('取り下げの途中', { QUARTERLY_REVIEW_LOG: { values: mk([['R2', t2, '取り下げ', dec, 0], ['R2', t2, '保留', dec, 0]]) } });
  const now = Date.now();
  const w = JSON.parse(JSON.stringify(env.run('appCalibrationWithdraw_(__b, { asOfMs: __t, actor: __a })', { __b: book, __t: now, __a: OWNER })));
  assert.deepEqual([w.reviewId, w.proposals, w.screen], ['R2', 1, false]);
  assert.deepEqual(w.before.map((x) => [x.proposalId, x.status]), [['P1', '保留']]);
  const v = book.getSheetByName('QUARTERLY_REVIEW_LOG').getDataRange().getValues();
  const col = (k) => H.indexOf(k);
  assert.deepEqual(v.slice(1).map((r) => r[col('approval_status')]), ['取り下げ', '取り下げ']);
  assert.equal(new Date(v[1][col('approval_decided_at')]).getTime(), dec.getTime(), 'もう取り下げた行の日時はそのまま');
  assert.equal(v[1][col('approval_decided_by')], 'someone');
  assert.equal(new Date(v[2][col('approval_decided_at')]).getTime(), now);
  assert.equal(v[2][col('approval_decided_by')], OWNER);
  assert.deepEqual(v.slice(1).map((r) => Number(r[col('applied')])), [0, 0], '適用はしていない');
}

console.log('app-calibration: all tests passed');
