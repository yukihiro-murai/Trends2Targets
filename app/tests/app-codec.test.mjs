#!/usr/bin/env node
/*
 * app-codec.test.mjs — 計算用ブックのシート ↔ データ本体の ENG_* の相互変換と、表・裏の処理の仕組みの契約テスト。
 * 変換が値・型・数式・表示形式を失わないこと、計算用ブックに組み立て直したときに自動変換で値が変わるセルを直せること、
 * 使わなくなった表を隠すこと、裏で動かす処理（トリガー・状態・権限）を確かめる。
 * GAS 上での実行の代わりではない（本物のシートの自動変換は、本物の計算用ブックで確かめる）。
 * 2026-10-05: 旧ブックからの取り込み（試し読み・取り込み）を外した（このアプリだけを使う）。そのテストも外した。
 *
 *   node app/tests/app-codec.test.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot, OWNER, MEMBER, J, isDate, makeEnv, setUpEnv } from './gas-mock.mjs';

const legacySrc = await readFile(path.join(repoRoot, 'Forecast_Agent.js'), 'utf8');
const archivedSrc = await readFile(path.join(repoRoot, 'archive', 'legacy-2026-10-04', 'Forecast_Agent.js'), 'utf8');   // 新アプリで使わない部分を除く前の元

// ==== 1. データ本体に持つシートの一覧と見出しは旧来のコードと同じ ====
{
  const env = makeEnv();
  const reg = J(env.run('APP_ENGINE_SHEETS'));
  const notStored = J(env.run('APP_ENGINE_NOT_STORED'));
  // 旧来の SHEETS 定数のシート名をすべて「持つ」か「持たない」に分けてある
  const sheetsBlock = /const SHEETS = \{([\s\S]*?)\n\};/.exec(legacySrc)[1];
  const legacyNames = [...sheetsBlock.matchAll(/:\s*'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(legacyNames.length >= 30);
  for (const n of legacyNames) assert.ok(reg[n] || notStored.includes(n), `旧来のシート ${n} の扱いが決まっていない`);
  for (const n of Object.keys(reg)) assert.ok(legacyNames.includes(n), `${n} は旧来のシートにない`);
  // 表の見出しは旧来のコードにそのままの並びで書かれている
  for (const [name, d] of Object.entries(reg)) {
    if (d.mode !== 'table') continue;
    const pattern = new RegExp('\\[\\s*' + d.header.map((h) => "'" + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'").join('\\s*,\\s*') + '\\s*\\]');
    // POOL_PRIOR の見出しは、新アプリで使わない管理ハブの集約（2026-10-04 に archive/ へ移した）にだけ書かれていた
    assert.ok(pattern.test(legacySrc) || pattern.test(archivedSrc), `${name} の見出しが Forecast_Agent.js の定義と違う`);
  }
  // ENG_ の表の列 = 計画・行番号・見出し・型の並び（文字列のまま持つ）
  const tables = J(env.run('APP_TABLES'));
  for (const [name, d] of Object.entries(reg)) {
    if (d.mode !== 'table') { assert.ok(!tables['ENG_' + name]); continue; }
    assert.deepEqual(tables['ENG_' + name].columns, ['plan_id', 'seq', ...d.header, '_types']);
    assert.equal(tables['ENG_' + name].raw, true);
  }
  for (const [name, d] of Object.entries(tables)) assert.equal(new Set(d.columns).size, d.columns.length, `${name} の列名が重複`);
}

// ==== 2. セル 1 つの変換（型ごと元に戻る） ====
{
  const env = makeEnv();
  const vals = ['', 'abc', '2026/04', '0012', '=not formula', 0, -0, 0.1 + 0.2, 1e21, -1234.5678, true, false, new Date(2026, 3, 1), new Date('2026-10-01T10:20:30.456Z')];
  for (const v of vals) {
    const e = env.run('appCellEncode_(__v, "")', { __v: v });
    const back = env.run('appCellDecode_(__e[0], __e[1])', { __e: e });
    assert.ok(env.run('appCellSame_(__a, __b)', { __a: v, __b: back }), `戻らない: ${String(v)}`);
    if (typeof v === 'number') assert.ok(Object.is(v, back), `数値がずれる: ${v}`);
    if (isDate(v)) assert.equal(back.getTime(), v.getTime());
  }
  assert.deepEqual(J(env.run(`appCellEncode_('', '=SUM(A1:A3)')`)), ['f', '=SUM(A1:A3)']);
  assert.equal(env.run(`appCellSame_('1', 1)`), false, '文字列と数値は別');
  assert.equal(env.run(`appCellSame_('', null)`), true);
  assert.deepEqual(J(env.run('[appA1_(0, 0), appA1_(9, 25), appA1_(0, 26), appA1_(1, 701)]')), ['A1', 'Z10', 'AA1', 'ZZ2']);
}

// ---- 計算用のシートの見本（値・表示形式・数式。中身は作り物） ----
const D = (y, m, d = 1) => new Date(y, m - 1, d);
function legacySpec() {
  return {
    GUIDE: { values: [['売上予測ツール ガイド']] },
    CONFIG: {
      values: [
        ['項目', '値'],
        ['[必須] メーカー名（外部集計キー）', 'テスト製薬'],
        ['[必須] 予測年度FY（YYYY）', 2027],
        ['[必須] 担当者（カンマ区切り）', '鷹野,鶴田'],
        ['RELIABILITY_APPLY_ENABLED（信頼度を反映）', 1],
        ['AI_SCORE_BASIS（level/momentum）', 'level'],
        ['メモ', '0012'],   // 自動の書式なのに文字列のまま残っているセル（作り物の難しい例）
      ],
    },
    SALES_INPUT: {
      values: [
        ['client', 'service_type', 'product', 'target_month', 'input_amount', 'status', 'source_updated_at'],
        ['テスト製薬', 'BASE', '製品A', D(2023, 4), 1200000, 'closed', D(2026, 9, 30)],
        ['テスト製薬', 'SPOT', '開発', D(2023, 5), 300000, 'closed', D(2026, 9, 30)],
        ['テスト製薬', 'BASE', '製品A', '2023/06', -5000, 'closed', ''],
      ],
      formats: { D: '@', E: '#,##0' },   // 旧来は書いた後に D 列を書式なしテキストにする（日付のまま残る）
    },
    PRODUCT: {
      values: [
        ['Person', 'ProductName', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason'],
        ['鷹野', '製品A', D(2026, 4), '+10%', '新しい適応'],
        ['', '製品B', D(2026, 4), '0%', ''],
      ],
      formats: { C: 'yyyy/MM/dd', D: '@' },
    },
    OPINIONS: {
      values: [
        ['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Confidence(0..1)', 'Note'],
        ['鷹野', D(2026, 4), '+5%', 0.7, ''],
        ['鶴田', D(2026, 4), '-2.5%', 0.5, '慎重'],
      ],
      formats: { C: '@' },
    },
    EVAL_LOG: {
      values: [
        ['eval_id', 'evaluated_at', 'client', 'target_month', 'scenario', 'pred', 'actual', 'ape', 'was_overridden', 'error_category', 'forecast_role',
          'is_planning_point_estimate', 'signed_error', 'abs_error', 'bias_direction', 'range_contains_actual', 'quarter_label', 'half_label', 'fy_label',
          'model_version', 'evaluation_policy_version', 'constraint_relevant_flag'],
        ['E1', D(2026, 5, 2), 'テスト製薬', '2026/04', 'neutral', 1000, 900, 0.111, 0, 'model_limitation', 'P50', 1, 100, 100, 'over', true, 'Q1', 'H1', 'FY2027', '2.4.0', 'policy-2026H1-v1', 1],
      ],
      formats: { D: '@' },
    },
    EVAL_COMPARE_MONTHLY: {
      values: [
        ['target_month', 'forecast_base', 'forecast_spot', 'forecast_total', 'actual_base', 'actual_spot', 'actual_total', 'gap_total', 'forecast_total_p10',
          'forecast_total_p50', 'forecast_total_p90', 'signed_error_p50', 'abs_error_p50', 'ape_p50', 'quarter_label', 'half_label', 'fy_label', 'over_flag',
          'under_flag', 'range_outside_flag', 'note_for_investigation', 'planning_point_estimate_label', 'range_label', '', '年間制約サマリー', '値'],
        [D(2026, 4), 800, 200, 1000, 700, 200, 900, -100, 800, 1000, 1200, 100, 100, 0.111, 'Q1', 'H1', 'FY2027', 1, 0, 0, '', 'P50', 'P10-P90', '', 'annual_actual_total', 900],
      ],
    },
    DASHBOARD: { values: [['metric', 'value', 'memo'], ['plan_point_estimate', 'P50', '']] },   // 見出しが旧来と違う
    OUTPUT: {
      values: [['FY2027 売上予測（テスト製薬）'], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [],
        ['年度合計（予測）', 9000, 10000, 11000, '', '', 2000, '', 10000, 500]],
      formulas: { J26: '=H26+I26' },
    },
    CALIBRATION_STATE: {
      values: [
        ['client', 'updated_at', 'updated_by', 'ai_weight_override', 'ai_max_abs_effect_override', 'ai_topic_disable_json', 'bias_correction_factor',
          'qual_scale_override', 'residual_month_bias_json', 'last_applied_quarter', 'last_applied_review_id', 'auto_update_enabled', 'note'],
        ['テスト製薬', D(2026, 9, 1), 'auto', '', '', '[]', 0.98, '', '{"1":0.01}', '', '', 1, ''],
      ],
    },
    'メモ': { values: [['人が足したシート']] },
  };
}
// ==== 3. シート 1 枚: 保存の形にして戻すと元と同じ（値・数式・表示形式・大きさ） ====
{
  const env = setUpEnv();
  const book = env.makeBook('クライアント別売上予測', legacySpec());
  const snap = (name) => env.run('appSheetSnapshot_(__sh, __n)', { __sh: book.getSheetByName(name), __n: name === 'SALES_INPUT' ? 7 : 0 });
  for (const name of ['CONFIG', 'SALES_INPUT', 'PRODUCT', 'OPINIONS', 'EVAL_LOG', 'EVAL_COMPARE_MONTHLY', 'DASHBOARD', 'OUTPUT', 'CALIBRATION_STATE']) {
    const s = snap(name);
    const enc = env.run('appEngEncodeSheet_("PL-T", __s)', { __s: s });
    const dec = env.run('appEngDecodeSheet_(__e.sheetRow, __e.tableRows, __e.rowSegs, __e.formatRows)', { __e: enc });
    assert.deepEqual(J(env.run('appEngCompare_(__s, __d)', { __s: s, __d: dec })), [], `${name} が元に戻らない`);
  }
  const si = env.run('appEngEncodeSheet_("PL-T", __s)', { __s: snap('SALES_INPUT') });
  assert.equal(si.sheetRow.mode, 'table');
  assert.equal(si.tableRows.length, 3, '見出しの次の行から 1 行 = 1 件');
  assert.equal(si.tableRows[0]._types, 'sssdnsd');
  assert.equal(si.tableRows[2]._types, 'ssssnse', '同じ列でも行ごとに型を持つ（文字列の月・空のセル）');
  assert.equal(si.tableRows[0].target_month, D(2023, 4).toISOString());
  const fmtD = JSON.parse(si.formatRows.find((f) => f.col === '4').runs_json);
  assert.deepEqual(fmtD, [[1, 1000, '@']], '表示形式は列ごとの続いた範囲で持つ');
  // 表の外のセル（右側の集計の欄）は行ごとに持つ
  const cmp = env.run('appEngEncodeSheet_("PL-T", __s)', { __s: snap('EVAL_COMPARE_MONTHLY') });
  assert.equal(cmp.sheetRow.mode, 'table');
  assert.deepEqual(J(cmp.rowSegs.map((r) => [r.row_no, r.col_from, JSON.parse(r.cells_json)])), [
    ['1', '24', ['e', 's年間制約サマリー', 's値']],
    ['2', '24', ['e', 'sannual_actual_total', 'n900']],
  ]);
  // 見出しが違う表は、値を失わないよう行ごとに持つ
  const dash = env.run('appEngEncodeSheet_("PL-T", __s)', { __s: snap('DASHBOARD') });
  assert.equal(dash.sheetRow.mode, 'rows');
  assert.equal(dash.tableRows.length, 0);
  assert.match(dash.warnings[0], /見出しが旧来の定義と違う/);
  // 数式は数式として持つ
  const out = env.run('appEngEncodeSheet_("PL-T", __s)', { __s: snap('OUTPUT') });
  assert.equal(out.formulaCount, 1);
  assert.ok(out.rowSegs.find((r) => r.row_no === '26').cells_json.includes('"f=H26+I26"'));
  // 内容のハッシュは計画の ID に左右されない
  assert.equal(env.run('appEngEncodeSheet_("PL-OTHER", __s)', { __s: snap('SALES_INPUT') }).sheetRow.content_hash, si.sheetRow.content_hash);
}

// ==== 4. 計算用ブックに書く: 自動変換で値が変わるセルは書き方を変えて直す ====
{
  const env = setUpEnv();
  const book = env.makeBook('見本', legacySpec());
  const res = J(env.run(`(() => {
    const ss = SpreadsheetApp.create('書き先');
    return Object.keys(APP_ENGINE_SHEETS).filter(n => __b.getSheetByName(n)).map(n => {
      const reg = APP_ENGINE_SHEETS[n];
      const snap = appSheetSnapshot_(__b.getSheetByName(n), reg.header ? reg.header.length : 0);
      const e = appEngEncodeSheet_('PL-T', snap);
      const w = appEngWriteSheet_(ss, appEngDecodeSheet_(e.sheetRow, e.tableRows, e.rowSegs, e.formatRows));
      const back = w.sheet.getRange(1, 1, snap.lastRow, snap.lastCol).getValues();
      const diff = [];
      snap.values.forEach((row, i) => row.forEach((v, j) => { if (!snap.formulas[i][j] && !appCellSame_(v, back[i][j])) diff.push(appA1_(i, j)); }));
      return { sheet: n, mismatch: w.mismatches, repaired: w.repaired, forcedText: w.forcedText, diff: diff,
        size: [w.sheet.getMaxRows(), w.sheet.getMaxColumns()], want: [snap.maxRows, snap.maxCols] };
    });
  })()`, { __b: book }));
  const by = Object.fromEntries(res.map((x) => [x.sheet, x]));
  for (const x of res) {
    assert.deepEqual([x.mismatch, x.diff], [0, []], `${x.sheet} の値が元に戻らない`);
    assert.deepEqual(x.size, x.want, `${x.sheet} の大きさ`);
  }
  assert.equal(by.SALES_INPUT.repaired, 2, '書式なしテキストの列の日付は「書いてから形式を付ける」で直る');
  assert.equal(by.CONFIG.forcedText, 1, '自動の書式で文字列のまま残っていたセルは文字列に固定する');
  assert.equal(by.EVAL_LOG.repaired, 0, '書式なしテキストの列の文字列の月はそのまま');
  assert.ok(!by.GUIDE && !by['メモ'], 'データ本体に持たないシートは書かない');
}

// ==== 5. 使わなくなった表（IMPORT_BATCHES）は作らず、前からあるシートは消さずに隠す ====
{
  const env = setUpEnv();
  assert.equal(env.data().getSheetByName('IMPORT_BATCHES'), null, '新しく作らない');
  assert.ok(!env.task('health()').tables.some((t) => t.name === 'IMPORT_BATCHES'));
  const old = env.data().insertSheet('IMPORT_BATCHES');
  old.getRange(1, 1, 2, 2).setNumberFormat('@').setValues([['batch_id', 'plan_id'], ['IB-1', 'PL-1']]);
  env.props.APP_TABLES_VERSION = '7';   // 版を上げる前のデータ本体
  env.task('health()');   // 最初の操作で表をそろえる
  assert.equal(env.props.APP_TABLES_VERSION, String(env.run('APP_SCHEMA_VERSION')));
  assert.equal(old.isSheetHidden(), true, '隠す');
  assert.deepEqual(old.getRange(2, 1, 1, 2).getValues(), [['IB-1', 'PL-1']], '中身はそのまま');
  assert.ok(env.task('health()').tables.every((t) => t.ok));
}

// ==== 6. 表を足した版: 足りない表は「状態」に出て、初期設定をもう一度実行すると作られる ====
{
  const env = setUpEnv();
  env.data().deleteSheet(env.data().getSheetByName('ENG_RUN_LOG'));
  const h = env.task('health()');
  const t = h.tables.find((x) => x.name === 'ENG_RUN_LOG');
  assert.deepEqual([t.ok, t.missing, t.engine], [false, true, true]);
  assert.match(t.note, /未作成/);
  assert.ok(h.tables.filter((x) => x.name !== 'ENG_RUN_LOG').every((x) => x.ok));
  assert.deepEqual(env.call('apiSetup()').tables, ['ENG_RUN_LOG']);
  assert.ok(env.task('health()').tables.every((x) => x.ok));
  // 列の多い表もシートの列数を合わせて作る（既定の 26 列を超える）
  assert.equal(env.data().getSheetByName('ENG_EVAL_INSIGHTS').getMaxColumns(), 27);
  assert.equal(env.data().getSheetByName('MEMBERS').getMaxColumns(), 10, '余った列は消してセルの上限を節約する');
}

// ==== 7. 入れ替え（appReplaceRows_）: 残す行・足す行・余りの行を消す・キーの重複は止める ====
{
  const env = setUpEnv();
  const row = (plan, seq) => ({ plan_id: plan, seq: String(seq), client: plan + seq, _types: 's' });
  env.run(`appInsertRows_('ENG_RUN_LOG', __r)`, { __r: [row('A', 2), row('A', 3), row('B', 2), row('A', 4)] });
  const r = env.call(`appReplaceRows_('ENG_RUN_LOG', (x) => x.plan_id !== 'A', __n)`, { __n: [row('A', 2)] });
  assert.deepEqual(r, { removed: 3, kept: 1, added: 1 });
  assert.deepEqual(env.table('ENG_RUN_LOG').map((x) => x.client), ['B2', 'A2']);
  assert.equal(env.data().getSheetByName('ENG_RUN_LOG').getLastRow(), 3, '余った古い行は消す');
  assert.throws(() => env.run(`appReplaceRows_('ENG_RUN_LOG', () => true, __n)`, { __n: [row('B', 2)] }), /同じキー/);
  assert.deepEqual(env.table('ENG_RUN_LOG').map((x) => x.client), ['B2', 'A2'], '止めたときは書かない');
}

// ==== 8. 裏で動かす処理（画面の通信と切り離す。HTTP 503 を避ける） ====
{
  const env = setUpEnv();
  const jobError = (kind, payload) => { const st = env.runJob(kind, payload); assert.equal(st.status, 'FAILED'); return st.error; };
  const RECOVER = { kind: 'SYSTEM.RECOVER', payload: {} };   // すぐ終わる処理（保存の続き。書きかけが無ければ何もしない）
  const started = env.call('apiStartJob(__in)', { __in: RECOVER });
  assert.equal(started.status, 'QUEUED');
  const jobTriggers = () => env.triggers.filter((t) => t.handler === 'triggerRunJob');
  assert.equal(jobTriggers().length, 1);
  assert.equal(jobTriggers()[0].afterMs, 1000, '1 回だけ動くトリガー');
  const st0 = env.call('apiJobStatus(__in)', { __in: { jobId: started.jobId } });
  assert.equal(st0.status, 'QUEUED');
  // 終わるまで次の処理は始めない
  assert.throws(() => env.call('apiStartJob(__in)', { __in: RECOVER }), /ほかの処理（保存の続き）が終わるまで/);
  // 画面を開き直したときに続きから待てる
  assert.equal(env.boot().activeJob.jobId, started.jobId);
  // トリガーの中では操作者のメールが空でも、自分で作ったトリガーなら所有者として動く
  const fired = env.fireTriggers('triggerRunJob');
  assert.equal(fired.length, 1);
  assert.equal(jobTriggers().length, 0, '動いたトリガーは消す');
  const st1 = env.call('apiJobStatus(__in)', { __in: { jobId: started.jobId } });
  assert.equal(st1.status, 'DONE');
  assert.equal(st1.result.nothing, true);
  assert.equal(env.boot().activeJob, null);
  const audit = env.audit().filter((a) => a.action === 'SYSTEM.RECOVER');
  assert.deepEqual(audit.map((a) => [a.phase, a.result, a.actor_email]), [['START', '', OWNER], ['END', 'OK', OWNER]], '裏の処理も頼んだ人の名前で記録する');
  assert.ok(env.runLog().some((r) => r.kind === 'JOB:SYSTEM.RECOVER' && r.status === 'DONE'));
  // トリガーが一覧から先に消えていても、待っている処理の UID なら動く
  const s2 = env.call('apiStartJob(__in)', { __in: RECOVER });
  env.fireTriggers('triggerRunJob', { dropFirst: true });
  assert.equal(env.call('apiJobStatus(__in)', { __in: { jobId: s2.jobId } }).status, 'DONE');
  // 偽の UID・社内の人がブラウザから呼んでも動かない
  env.call('apiStartJob(__in)', { __in: RECOVER });
  env.as('');
  assert.throws(() => env.call(`triggerRunJob({ triggerUid: 'forged' })`), /権限がありません/);
  env.as(MEMBER);
  assert.throws(() => env.call(`triggerRunJob({ triggerUid: '${jobTriggers()[0].uid}' })`), /権限がありません/);
  assert.throws(() => env.call('apiJobStatus(__in)', { __in: { jobId: s2.jobId } }), /状態を見る権限がありません/);
  env.as(OWNER);
  env.fireTriggers('triggerRunJob');
  // 未定義の処理・見つからない処理
  assert.throws(() => env.call(`apiStartJob({ kind: 'NOPE' })`), /未定義の処理/);
  for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.throws(() => env.call(`apiStartJob({ kind: '${k}' })`), /未定義の処理/, k);
  assert.throws(() => env.call(`apiJobStatus({ jobId: 'JOB-none' })`), /見つかりません/);
  // 失敗はエラーの文言を返し、エラーのログにも残す
  assert.match(jobError('PLAN.CREATE', {}), /メーカーを選んでください/);
  assert.ok(env.errors().some((e) => e.where === 'PLAN.CREATE'));
  // 実行中のまま上限を超えたら止まったとみなす・始まらないまま 15 分たったら知らせる・結果が消えたら知らせる
  const job = (id) => JSON.parse(env.props['APP_JOB_' + id]);
  const put = (j) => { env.props['APP_JOB_' + j.id] = JSON.stringify(j); };
  const j1 = job(s2.jobId);
  put(Object.assign({}, j1, { status: 'RUNNING', startedAt: new Date(Date.now() - 9 * 60e3).toISOString() }));
  assert.equal(env.call('apiJobStatus(__in)', { __in: { jobId: s2.jobId } }).status, 'STALLED');
  put(Object.assign({}, j1, { status: 'QUEUED', createdAt: new Date(Date.now() - 16 * 60e3).toISOString() }));
  assert.equal(env.call('apiJobStatus(__in)', { __in: { jobId: s2.jobId } }).status, 'STALLED');
  put(Object.assign({}, j1, { status: 'DONE' }));
  Object.keys(env.cache).forEach((k) => { if (k.includes(s2.jobId)) delete env.cache[k]; });
  assert.equal(env.call('apiJobStatus(__in)', { __in: { jobId: s2.jobId } }).status, 'LOST');
  // 頼んだ人の権限は動かす前に確かめ直す
  const s3 = env.call('apiStartJob(__in)', { __in: RECOVER });
  put(Object.assign(job(s3.jobId), { requestedBy: MEMBER }));
  env.fireTriggers('triggerRunJob');
  const st3 = JSON.parse(env.props['APP_JOB_' + s3.jobId]);
  assert.deepEqual([st3.status, st3.error], ['FAILED', 'この操作をする権限がありません。']);
  // 大きな結果も分けて置いて受け取れる（1 つ 100KB まで）
  const big = { text: 'あ'.repeat(250000) };
  env.run(`appJobPutResult_('JOB-BIG', __b)`, { __b: big });
  assert.equal(J(env.run(`appJobGetResult_('JOB-BIG')`)).value.text.length, 250000);
  // 1 日より前の記録と、待っている処理のないトリガーは片付ける
  put(Object.assign({}, j1, { id: 'JOB-OLD', status: 'DONE', createdAt: new Date(Date.now() - 25 * 3600e3).toISOString() }));
  env.run(`ScriptApp.newTrigger('triggerRunJob').timeBased().after(1000).create()`);
  const s4 = env.call('apiStartJob(__in)', { __in: RECOVER });
  assert.ok(!('APP_JOB_JOB-OLD' in env.props));
  assert.deepEqual(jobTriggers().map((t) => t.uid), [job(s4.jobId).triggerUid], '待っている処理のトリガーだけが残る');
  env.fireTriggers('triggerRunJob');
  assert.equal(env.state.lockHeld, false);
  // 24h 超の QUEUED は先に期限切れにしてトリガーを消し、その後に記録を片付ける（逆順だとトリガーが残る）
  const orphanUid = 'UID-ORPHAN-QUEUED';
  env.run(`ScriptApp.newTrigger('triggerRunJob').timeBased().after(1000).create()`);
  const orphanTrig = env.triggers.filter((t) => t.handler === 'triggerRunJob').pop();
  orphanTrig.uid = orphanUid;
  put({ id: 'JOB-STALE-Q', kind: 'SYSTEM.RECOVER', status: 'QUEUED', payload: {}, requestedBy: OWNER,
    createdAt: new Date(Date.now() - 25 * 3600e3).toISOString(), triggerUid: orphanUid });
  const s5 = env.call('apiStartJob(__in)', { __in: RECOVER });
  assert.ok(!('APP_JOB_JOB-STALE-Q' in env.props), '期限切れの後に 24h 超の記録を消す');
  assert.ok(!env.triggers.some((t) => t.uid === orphanUid), '期限切れでトリガーも消す');
  assert.deepEqual(jobTriggers().map((t) => t.uid), [job(s5.jobId).triggerUid]);
  env.fireTriggers('triggerRunJob');
}

console.log('app-codec: all tests passed');
