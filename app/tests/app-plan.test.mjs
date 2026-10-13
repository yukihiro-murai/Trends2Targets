#!/usr/bin/env node
/*
 * app-plan.test.mjs — 計画の画面（段階2-3）の契約テスト。
 * - 読むだけのブック（データ本体から組み立てる）が、旧来の画面の読み取りに Sheet と同じ値を返すこと（OUTPUT の予算の数式も）
 * - 画面の中身は旧来の webGetBootstrap_ を本物のまま動かしたもの（入力・予測・四半期レビュー）
 * - 保存（入力・予算・四半期レビューの承認）は旧来の webSave* を本物のまま動かし、変わったシートだけをデータ本体へ戻すこと
 * - 実行（B-3 など）は計算 → 保存の 2 段で戻すこと（旧来の計算の代わりで確かめる）
 * - 権限（予算策定担当・承認者）・画面を開いた後にデータが変わったときの止め方・記録（PLAN_ACTIONS・監査）
 *
 *   node app/tests/app-plan.test.mjs
 */

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { J, MEMBER, OWNER, fcSection, setUpEnv, uiHtml } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
function legacyBook(env) {
  const output = [['FY2026 売上予測（テスト製薬）']];
  for (let r = 2; r <= 23; r++) output.push([]);
  output.push([' 混合（主要）']);   // 24 行目（年度合計の 2 行上）
  output.push([]);
  output.push(['年度合計（予測）', 900, 1000, 1100, '', '', '', '', '', '']);   // 26 行目
  output.push([], []);
  const months = ['2026/04', '2026/05', '2026/06', '2026/07', '2026/08', '2026/09', '2026/10', '2026/11', '2026/12', '2027/01', '2027/02', '2027/03'];
  months.forEach((m) => output.push([m, 70, 80, 90, '', '', '', '', '', '']));
  const formulas = { H26: '=SUM(H29:H40)', I26: '=SUM(I29:I40)', J26: '=SUM(J29:J40)' };
  for (let i = 0; i < 12; i++) formulas['J' + (29 + i)] = `=H${29 + i}+I${29 + i}`;
  return env.makeBook('クライアント別売上予測', {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', 'テスト製薬'], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野,佐藤']] },
    OUTPUT: { values: output, formulas, formats: { A: '@' } },
    PRODUCT: { values: [['Person', 'ProductName', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason'], ['鷹野', '製品A', D(2026, 5), 5, '新規']] },
    CLIENT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']] },
    OPINIONS: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Confidence(0..1)', 'Note']] },
    DEV_SPOT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Project', 'Amount(JPY)', 'Confidence(0..1)']] },
    PROCESS_STATUS: {
      values: [['step_key', 'last_run_date', 'last_run_by', 'status', 'target_client', 'record_count', 'error_summary'],
        ['step4_status', D(2026, 9, 1), 'owner', 'success', 'テスト製薬', 12, '']],
    },
    SALES_INPUT: { values: [['client', 'service_type', 'product', 'target_month', 'input_amount', 'status', 'source_updated_at'],
      ['テスト製薬', 'BASE', '製品A', '2025/04', 1000000, 'closed', D(2026, 9, 1)]], formats: { D: '@' } },
    RUN_LOG: { values: [['run_id', 'run_at', 'run_by', 'function_name', 'client', 'status', 'count', 'model_version', 'parameters_snapshot_json', 'input_data_hash', 'execution_duration_sec', 'error_summary']] },
    QUARTERLY_REVIEW: {
      values: [['四半期レビュー（テスト製薬）'], ['2026/04〜2026/06'], [], [], [], [], ['proposal_id', 'target', 'current', 'proposed', 'conf', 'rationale', 'impact', '承認', 'rollback', 'review_id'],
        ['P1', 'bias_correction_factor', 1, 0.98, 0.7, '過大', '-2%', '', 1, 'R-1'],
        ['P2', 'ai_weight_override', '', 0.4, 0.5, '外れ', '-1%', '', '', '']],
      formats: { G: '@' },
    },
  });
}
function imported() {
  const env = setUpEnv();
  const book = legacyBook(env);
  return { env, book, planId: env.seedPlan(book) };
}
const engRows = (env, sheet, planId) => env.table('ENG_' + sheet).filter((r) => r.plan_id === planId);

// ==== 1. 読むだけのブック: Sheet と同じ値（数式は予算の列の SUM と足し算だけ）、書き込みは止める ====
{
  const { env, book, planId } = imported();
  env.ctx.__plan = env.run(`appPlanOf_('${planId}')`);
  const v = (expr) => J(env.run(`(() => { const b = appStoreBook_(__plan); return ${expr}; })()`));
  const real = book.getSheetByName('OUTPUT');
  assert.deepEqual(v(`b.getSheetByName('OUTPUT').getDataRange().getValues().length`), real.getLastRow());
  assert.equal(v(`b.getSheetByName('OUTPUT').getRange(26, 3).getValue()`), 1000);
  assert.equal(v(`b.getSheetByName('OUTPUT').getRange('C26').getValue()`), 1000, 'A1 でも読める');
  assert.deepEqual(v(`b.getSheetByName('OUTPUT').getRange('A29:B30').getValues()`), [['2026/04', 70], ['2026/05', 70]]);
  assert.equal(v(`b.getSheetByName('OUTPUT').getRange(29, 10).getValue()`), 0, '空の H+I は 0（Sheets と同じ）');
  assert.equal(v(`b.getSheetByName('OUTPUT').getRange(26, 10).getValue()`), 0);
  assert.equal(v(`b.getSheetByName('OUTPUT').getRange(29, 10).getFormula()`), '=H29+I29');
  assert.equal(v(`b.getSheetByName('OUTPUT').getRange(500, 30).getValue()`), '', '範囲の外は空');
  assert.equal(v(`b.getSheetByName('NOPE')`), null);
  assert.equal(v(`b.getSheetByName('PRODUCT').getRange(2, 3).getValue() instanceof Date`), true, '日付は日付のまま');
  assert.throws(() => env.run(`appStoreBook_(__plan).getSheetByName('OUTPUT').getRange(1, 1).setValue('x')`), /画面の表示では使えない操作です（Range\.setValue）/);
  assert.throws(() => env.run(`appStoreBook_(__plan).insertSheet('X')`), /Spreadsheet\.insertSheet/);
  assert.throws(() => env.run(`appStoreBook_(__plan).getSheetByName('OUTPUT').getRange(1, 1, 0, 1)`), /at least 1/);
  assert.equal(env.run(`appEvalFormula_('=AVERAGE(B1:B2)', () => 1)`), '', 'ほかの数式は空として読む');
}

// ==== 2. 画面の中身: 旧来の webGetBootstrap_ を本物のまま動かす（データ本体から・計算用ブックなし） ====
{
  const { env, planId } = imported();
  const scratchBefore = env.props.APP_SCRATCH_SPREADSHEET_ID;
  const view = env.call('apiPlanView(__in)', { __in: { planId } });
  assert.equal(view.plan.planId, planId);
  assert.equal(view.boot.setup.client, 'テスト製薬');
  assert.equal(view.boot.setup.fy, 2026);
  assert.deepEqual(view.boot.setup.people, ['鷹野', '佐藤']);
  assert.equal(view.boot.input.product.length, 1);
  assert.deepEqual(view.boot.input.product[0], { person: '鷹野', product: '製品A', ym: '2026-05', step: view.boot.input.product[0].step, reason: '新規' });
  assert.equal(view.boot.output.sections[0].annual.p50, 1000);
  assert.equal(view.boot.output.sections[0].monthly.length, 12);
  assert.equal(view.boot.output.sections[0].monthly[0].row, 29, '予算を書く行番号');
  assert.equal(view.boot.quarterly.proposals.length, 2);
  assert.equal(view.boot.quarterly.reviewId, 'R-1');
  assert.equal(view.boot.steps.find((s) => s.key === 'step4_status').status, 'success');
  assert.equal(view.boot.bookUrl, undefined, '旧ブックの URL は出さない');
  assert.equal(view.boot.access, undefined);
  assert.equal(view.can.plan, true);
  assert.equal(env.props.APP_SCRATCH_SPREADSHEET_ID, scratchBefore, '計算用ブックは使わない');
  const again = env.call('apiPlanView(__in)', { __in: { planId } });
  assert.deepEqual(again.boot, view.boot, '入力が同じなら覚えておいたものを返す');
  // 日本語の多い大きな結果も覚えておける（CacheService の上限はバイト数。2026-10-02 画面が読み込み中のまま）
  env.run(`appJobPutResult_('BIG', { t: '日本語'.repeat(40000) })`);
  assert.equal(J(env.run(`appJobGetResult_('BIG')`)).value.t.length, 120000);
}

// ==== 3. 保存: 旧来の webSave* を本物のまま動かし、変わったシートだけを戻す ====
{
  const { env, planId } = imported();
  const view = env.call('apiPlanView(__in)', { __in: { planId } });
  const before = Object.fromEntries(env.table('ENG_SHEETS').filter((r) => r.plan_id === planId).map((r) => [r.sheet, r.content_hash]));
  // 入力（製品）を全面書き換え
  const rows = [{ person: '鷹野', product: '製品A', ym: '2026-06', step: '10', reason: '増産' }, { person: '佐藤', product: '製品B', ym: '2026-07', step: '-5', reason: '' }];
  const st = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind: 'product', rows }, inputHash: view.inputHash });
  assert.equal(st.status, 'DONE', st.error);
  assert.deepEqual(st.result.changed, ['PRODUCT'], '変わったシートだけ');
  assert.equal(st.result.result.saved, 2);
  const prod = engRows(env, 'PRODUCT', planId);
  assert.equal(prod.length, 2);
  assert.equal(prod[0].ProductName, '製品A');
  assert.equal(prod[0]._types.charAt(2), 'd', '月は日付で持つ（旧来と同じ）');
  assert.equal(prod[0]._types.charAt(3), 'n', '増減率は数値に変わる（Sheets の自動変換と同じ）');
  const after = Object.fromEntries(env.table('ENG_SHEETS').filter((r) => r.plan_id === planId).map((r) => [r.sheet, r.content_hash]));
  Object.keys(before).filter((k) => k !== 'PRODUCT').forEach((k) => assert.equal(after[k], before[k], k + ' は変えない'));
  const row = env.table('PLAN_ACTIONS').slice(-1)[0];
  assert.equal(row.action, 'INPUT.SAVE'); assert.equal(row.actor_email, OWNER); assert.equal(row.changed_sheets_json, '["PRODUCT"]');
  const audit = env.audit().filter((a) => a.action === 'PLAN.INPUT.SAVE');
  assert.equal(audit.length, 2, '開始と終了');
  assert.match(audit[0].detail_json, /製品B/, '保存した中身を記録に残す');
  const v2 = env.call('apiPlanView(__in)', { __in: { planId } });
  assert.equal(v2.boot.input.product.length, 2, '画面にすぐ出る');
  assert.equal(v2.recent[0].action, 'INPUT.SAVE');
  assert.deepEqual(v2.recent[0].changed, ['PRODUCT'], '変わったシートは一覧で渡す（文字列のままだと「進み」が表示できない）');
  // 画面を開いた後にデータが変わったら止める（古い画面のまま上書きしない）
  const stale = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind: 'product', rows: [] }, inputHash: view.inputHash });
  assert.equal(stale.status, 'FAILED');
  assert.match(stale.error, /画面を開き直して/);
  assert.equal(engRows(env, 'PRODUCT', planId).length, 2);
  // 予算（OUTPUT の H/I 列）
  const b = env.runJob('PLAN.EDIT', { planId, action: 'BUDGET.SAVE', args: { rows: [{ row: 29, adopted: 85, uplift: 5 }, { row: 3, adopted: 1 }] }, inputHash: v2.inputHash });
  assert.equal(b.status, 'DONE', b.error);
  assert.deepEqual(b.result.changed, ['OUTPUT']);
  const v3 = env.call('apiPlanView(__in)', { __in: { planId } });
  const m = v3.boot.output.sections[0].monthly[0];
  assert.deepEqual([m.adopted, m.uplift, m.final], [85, 5, 90], 'J 列（数式）は H+I');
  assert.equal(v3.boot.output.sections[0].annual.final, 90, '年度合計は SUM');
  // 大きい入力（処理の記録の上限を超える）も保存できる
  const many = Array.from({ length: 120 }, (_, i) => ({ person: '鷹野', product: '製品' + i, ym: '2026-08', step: '1', reason: '理由'.repeat(10) }));
  const big = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind: 'product', rows: many }, inputHash: v3.inputHash });
  assert.equal(big.status, 'DONE', big.error);
  assert.equal(engRows(env, 'PRODUCT', planId).length, 120);
}

// ==== 4. 実行: 計算 → 保存の 2 段（旧来の計算の代わりで確かめる） ====
{
  const { env, planId } = imported();
  env.run(`appLegacyEngine_ = function (svc) {
    return { VERSION: 'stub-1', SOURCE_SHA256: 'stub', WEB_SOURCE_SHA256: 'stub-web',
      webRunDashboard() {
        const ss = svc.SpreadsheetApp.getActiveSpreadsheet();
        let sh = ss.getSheetByName('DASHBOARD');
        if (!sh) sh = ss.insertSheet('DASHBOARD');
        sh.getRange(1, 1, 2, 3).setValues([['metric', 'value', 'note'], ['sMAPE', 0.12, svc.Session.getActiveUser().getEmail()]]);
        return { boot: { big: 'x'.repeat(100000) } };
      } };
  };`);
  const st = env.runJob('PLAN.RUN', { planId, action: 'EVAL.DASHBOARD' });
  assert.equal(st.status, 'DONE', st.error);
  assert.deepEqual(st.result.changed, ['DASHBOARD']);
  assert.deepEqual(st.result.result, {}, '画面の中身（boot）は記録に残さない');
  const dash = engRows(env, 'DASHBOARD', planId);
  assert.equal(dash.length, 1);
  assert.equal(dash[0].note, OWNER, '頼んだ人を「操作した人」として見せる');
  const row = env.table('PLAN_ACTIONS').slice(-1)[0];
  assert.equal(row.action, 'EVAL.DASHBOARD'); assert.equal(row.web_sha256, 'stub-web');
  assert.ok(env.audit().some((a) => a.action === 'PLAN.EVAL.DASHBOARD.CALC') && env.audit().some((a) => a.action === 'PLAN.EVAL.DASHBOARD.SAVE'));
}

// ==== 5. 権限: 保存・実行は予算策定担当（その計画のクライアント）以上、承認は承認者。未定義の操作は止める ====
{
  const { env, planId } = imported();
  const clientId = env.table('PLANS')[0].client_id;
  env.task(`saveMember({ email: '${MEMBER}', displayName: 'M' })`);
  env.as(MEMBER);
  const view = env.call('apiPlanView(__in)', { __in: { planId } });
  assert.equal(view.can.plan, false, '見るのは社内全員');
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.EDIT', payload: { planId, action: 'INPUT.SAVE', args: { kind: 'product', rows: [] } } } }), /権限がありません/);
  env.as(OWNER);
  env.task('grantRole(__in)', { __in: { email: MEMBER, role: 'PLANNER', scopeType: 'CLIENT', clientId } });
  env.as(MEMBER);
  const v = env.call('apiPlanView(__in)', { __in: { planId } });
  assert.deepEqual([v.can.plan, v.can.approve], [true, false]);
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.EDIT', payload: { planId, action: 'REVIEW.DECIDE', args: { rows: [{ row: 8, decision: '承認' }] } } } }), /権限がありません/, '承認は承認者だけ');
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.RUN', payload: { planId, action: 'REVIEW.APPLY' } } }), /権限がありません/);
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.EDIT', payload: { planId, action: 'EVAL.REPORT' } } }), /未定義の操作です/, '実行の操作を保存として始められない');
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.RUN', payload: { planId, action: 'FORECAST.RUN' } } }), /未定義の操作です/);
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.RUN_SAVE', payload: { planId, action: 'EVAL.REPORT' } } }), /画面から始められません/);
  env.as(OWNER);
  env.task('grantRole(__in)', { __in: { email: MEMBER, role: 'APPROVER', scopeType: 'ALL' } });
  env.as(MEMBER);
  const st = env.runJob('PLAN.EDIT', { planId, action: 'REVIEW.DECIDE', args: { rows: [{ row: 8, decision: '承認' }, { row: 9, decision: '保留' }] }, inputHash: v.inputHash });
  assert.equal(st.status, 'DONE', st.error);
  assert.deepEqual(st.result.changed, ['QUARTERLY_REVIEW']);
  const q = env.call('apiPlanView(__in)', { __in: { planId } }).boot.quarterly.proposals;
  assert.deepEqual(q.map((x) => x.decision), ['承認', '保留']);
  const bad = env.runJob('PLAN.EDIT', { planId, action: 'REVIEW.DECIDE', args: { rows: [{ row: 8, decision: 'OK' }] } });
  assert.equal(bad.status, 'FAILED');
  assert.match(bad.error, /承認 \/ 却下 \/ 保留/, '旧来と同じ確かめ方');
}

// ==== 6. A-2 売上の取り込み（旧来の関数を本物のまま。元は設定の「ZAC の実績のスプレッドシート」）と担当者の保存 ====
{
  const { env, planId } = imported();
  const ext = Array.from({ length: 70 }, () => '');
  const rec = (client, cat, product, month, amount) => { const r = ext.slice(); r[40] = client; r[45] = cat; r[49] = product; r[56] = month; r[65] = amount; return r; };
  const zac = env.makeBook('Veeva 売上分析ツール', { '*2025_actual_value': { cols: 70, values: [ext.map((_, i) => 'c' + (i + 1)),
    rec('テスト製薬', 'ベース', '製品A', D(2025, 5, 15), 1200000), rec('テスト製薬', 'スポット', '製品B', D(2025, 6, 10), 300000),
    rec('別の製薬', 'ベース', '製品X', D(2025, 5, 15), 999)] } });
  const noSource = env.runJob('PLAN.RUN', { planId, action: 'IMPORT.SALES' });
  assert.equal(noSource.status, 'FAILED');
  assert.match(noSource.error, /ZAC の実績のスプレッドシート/, '元を決めていなければ取り込まない（旧来の既定に頼らない）');
  assert.equal(env.call('apiPlanView(__in)', { __in: { planId } }).sourceReady, false);
  env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
  const st = env.runJob('PLAN.RUN', { planId, action: 'IMPORT.SALES' });
  assert.equal(st.status, 'DONE', st.error);
  assert.ok(st.result.changed.includes('SALES_INPUT'));
  const sales = engRows(env, 'SALES_INPUT', planId);
  assert.deepEqual(sales.map((r) => [r.product, r.target_month, r.input_amount]), [['製品A', '2025/05', '1200000'], ['製品B', '2025/06', '300000']], 'そのクライアントの分だけ、旧来と同じ形で');
  assert.equal(st.result.result.count, 2);
  const calc = env.audit().filter((a) => a.action === 'PLAN.IMPORT.SALES.CALC' && a.phase === 'END').slice(-1)[0];
  assert.ok(calc, '計算の記録');
  const scratchBook = env.sheetsById[env.props.APP_SCRATCH_SPREADSHEET_ID];
  assert.deepEqual(scratchBook.getSheets().map((x) => x.getName()).filter((n) => !/^_/.test(n)).sort(),
    ['CLIENT', 'CONFIG', 'DEV_SPOT', 'OPINIONS', 'PROCESS_STATUS', 'PRODUCT', 'RUN_LOG', 'SALES_INPUT'], '使うシートだけを組み立てる（6 分の上限）');
  const steps = env.call('apiPlanView(__in)', { __in: { planId } }).boot.steps;
  assert.equal(steps.find((x) => x.key === 'step1_status').status, 'success');
  // 担当者（管理者）。クライアントと年度は変えない
  const v = env.call('apiPlanView(__in)', { __in: { planId } });
  const pe = env.runJob('PLAN.EDIT', { planId, action: 'SETUP.PEOPLE', args: { peopleCsv: '鷹野、佐藤 , 田中' }, inputHash: v.inputHash });
  assert.equal(pe.status, 'DONE', pe.error);
  assert.deepEqual(pe.result.changed, ['CONFIG']);
  const v2 = env.call('apiPlanView(__in)', { __in: { planId } });
  assert.deepEqual(v2.boot.setup.people, ['鷹野', '佐藤', '田中']);
  assert.equal(v2.boot.setup.client, 'テスト製薬');
  assert.equal(env.table('PLANS')[0].people_csv, '鷹野,佐藤,田中', '計画の表にも残す');
  const empty = env.runJob('PLAN.EDIT', { planId, action: 'SETUP.PEOPLE', args: { peopleCsv: ' , ' } });
  assert.match(empty.error, /1 人以上/);
  env.task(`saveMember({ email: '${MEMBER}', displayName: 'M' })`);
  env.task('grantRole(__in)', { __in: { email: MEMBER, role: 'PLANNER', scopeType: 'ALL' } });
  env.as(MEMBER);
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.RUN', payload: { planId, action: 'IMPORT.SALES' } } }), /権限がありません/, '取り込みは管理者');
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.EDIT', payload: { planId, action: 'SETUP.PEOPLE', args: { peopleCsv: 'x' } } } }), /権限がありません/);
}

// ==== 7. 画面: 実際の中身で 5 つのタブをすべて描ける（描く途中で止まらない） ====
{
  const { env, planId } = imported();
  env.runJob('PLAN.EDIT', { planId, action: 'BUDGET.SAVE', args: { rows: [{ row: 29, adopted: 85, uplift: 5 }] }, inputHash: env.call('apiPlanView(__in)', { __in: { planId } }).inputHash });
  const view = env.call('apiPlanView(__in)', { __in: { planId } });
  const latest = env.call('apiForecastLatest(__in)', { __in: { planId } });
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [] }, setUp: true, allowed: true }));
  const el = () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
  const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, confirm: () => false, window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  ui.__v = view; ui.__d = latest;
  vm.runInContext(`S.view = 'forecast'; S.fc.plans = [{ planId: __v.plan.planId, clientName: 'x', fy: '2026' }]; S.fc.planId = __v.plan.planId; S.fc.view = __v; S.fc.data = __d;`, ui);
  const page = vm.runInContext(`viewForecast()`, ui);
  assert.ok(!/ここを表示できませんでした/.test(page), '区切りをすべて描ける: ' + (page.match(/<p class="note">([^<]*)/) || [])[1]);
  for (const tab of ['forecast', 'basis', 'input', 'review', 'version', 'steps']) assert.ok(fcSection(page, tab), tab + ' の区切りがある');
  assert.match(fcSection(page, 'steps'), /予算の保存[\s\S]*予算と予測/, '最近の操作に変わったもの（シートの名前ではなく、ふつうの名前）が出る');
  // 旧来の計算が確認を求めたら、確認の窓（ブラウザが黙って「やめる」にすることがある）ではなく、画面の中のカードで聞く
  vm.runInContext(`S.fc.jump = 'review'; toast = function(){}; JOB_DONE['FORECAST.RUN_CALC']({ needConfirm: { key: 'extreme', title: '極端な入力', message: '増減率 +80%' } }, { planId: S.fc.planId, confirms: [] })`, ui);
  const cf = vm.runInContext(`viewForecast()`, ui);
  assert.match(fcSection(cf, 'forecast'), /極端な入力[\s\S]*増減率 \+80%[\s\S]*このまま実行/, '確認のカードが予測と予算の区切りに出る');
  assert.equal(vm.runInContext(`S.fc.jump`, ui), 'forecast', '予測と予算の区切りへ送る（タブは無い）');
  // 旧来の計算の文（表の名前・Step・kTotal・OK/キャンセル）は、画面の言葉とボタンの名前で見せる
  const legacyMsgs = [
    'Stepが極端です（±100%以上）。\n\nシート: PRODUCT / 担当: 鷹野 / 月: 2026/05 / Step: 120%\n\nプロモーション終了などで意図した入力ならOKで続行できます。\n修正する場合はキャンセルしてください。',
    'Stepがやや大きめです（±30%以上）。\n\nシート: OPINIONS / 担当: 鷹野 / 月: 2026/05 / Step: 35%\n\n修正する場合はキャンセル、続行する場合はOKを押してください。',
    'DEV/SPOT固定が大きい月があります（2026/06 / 1,200,000円, BASE平均比 130.0%）。\n\n意図した大型案件ならOKで続行できます。\n修正する場合はキャンセルしてください。',
    '主観/AIの合成係数が極端です（2026/07 / kTotal=1.734）。\n\n意図した戦略変更ならOKで続行できます。\n修正する場合はキャンセルしてください。'];
  for (const m of legacyMsgs) {
    vm.runInContext(`JOB_DONE['FORECAST.RUN_CALC']({ needConfirm: { key: 'extreme', title: '注意（影響が大きい入力）', message: ${JSON.stringify(m)} } }, { planId: S.fc.planId, confirms: [] })`, ui);
    const card = vm.runInContext(`viewForecast()`, ui);
    const pre = (card.match(/<div class="pre">([\s\S]*?)<\/div>/) || [])[1] || '';
    assert.doesNotMatch(pre, /PRODUCT|OPINIONS|Step|DEV\/SPOT|BASE|kTotal|OK|キャンセル/, '旧来の言葉を見せない: ' + pre);
    assert.match(pre, /このまま実行|やめる/, pre);
  }
  vm.runInContext(`S.fc.confirm = null`, ui);
  assert.doesNotMatch(vm.runInContext(`viewForecast()`, ui), /value="[0-9]+\.[0-9]+"/, '採用予測の欄は小数を見せない');
  // 検証のタブの、精度の推移と学習の影
  ui.__learn = env.call('apiLearningView(__in)', { __in: { planId } });
  const evalHtml = vm.runInContext(`S.fc.learn = __learn; fcSection(viewForecast(), 'review')`, Object.assign(ui, { fcSection }));
  // 振り返り（検証と四半期をまとめた）: 記録が無い計画は案内 1 枚、記録があれば精度の天気と精度の推移（学習の影は『学び』へ。2026-10-06）
  assert.match(evalHtml, ui.__learn.accuracy.months.length ? /精度の天気[\s\S]*精度の推移[\s\S]*振り返りの更新/ : /(まだ振り返りの記録がありません|人の記入|AI の見直し案)[\s\S]*振り返りの更新/);
  const withMonths = JSON.parse(JSON.stringify(ui.__learn)); withMonths.accuracy.months = [{ month: '2026/04', p10: 1, p50: 2, p90: 3, actual: 2, ape: 0, inside: true }];
  ui.__learn2 = withMonths;
  assert.match(vm.runInContext(`S.fc.learn = __learn2; viewForecast()`, ui), /精度の天気[\s\S]*精度の推移/);
  vm.runInContext(`S.fc.learn = __learn`, ui);
  assert.ok(!/undefined|NaN/.test(evalHtml.split('振り返りの更新')[0]), '精度の推移に undefined や NaN を出さない');
  // 管理の画面は外した（設定・記録と状態・年度の締め・計画を作る・全計画の学習・担当者の編集。所有者はエディタの apiOwnerTask。2026-10-06 村井さん）
  assert.equal(vm.runInContext(`[typeof viewSettings, typeof viewRecords, typeof membersView, typeof namesView, typeof settingsBizView, typeof auditView, typeof logDetail, typeof healthView,
    typeof hlAuditCard, typeof hlHousekeepingCard, typeof hlYearCard, typeof ycClose, typeof pfPoolCard, typeof pfCreateCard, typeof pfLoadCandidates, typeof mkCreate, typeof goSet, typeof goRec, typeof NAV_ADMIN].join()`, ui),
    Array(19).fill('undefined').join());
  assert.deepEqual(Object.keys(JSON.parse(vm.runInContext(`JSON.stringify(READS)`, ui))).filter((k) => /Directory|Settings|Audit|Health|PoolPreview|PlanCandidates|YearPreview|Bootstrap/.test(k)), [], '外した画面の読み込みは READS に残さない');
  // 旧ブックから移す画面・旧ブックの片付けは無い（このアプリだけを使う。2026-10-05）
  assert.equal(vm.runInContext(`[typeof viewMigrate, typeof legacyBooksCard, typeof NAV_OWNER].join()`, ui), 'undefined,undefined,undefined');
  assert.doesNotMatch(vm.runInContext(`JSON.stringify(NAV) + Object.keys(NAV_ICON)`, ui), /旧ブック|migrate/, 'メニューに旧ブックを出さない');
  // ホーム: 数字・計画の状態・最近の動きと、よみのセリフ（状況から選ぶ）
  ui.__home = env.call('apiHome()');
  const homeHtml = vm.runInContext(`S.view = 'home'; B.home = __home; viewHome()`, ui);
  assert.match(homeHtml, /年間予算[\s\S]*着地の推定[\s\S]*暫定実績[\s\S]*外れ幅[\s\S]*見通しの空模様[\s\S]*学びの進み[\s\S]*データからわかること/);
  // 空模様はいつも 8 つ（猛暑 → 快晴 → 晴れのち曇り → 曇り → 雨 → 雪 → 霧 → 天変地異。2026-10-13 霧と天変地異を入れ替え）。名前の文字は出さず、カーソルで説明
  assert.match(homeHtml, /aria-label="猛暑[\s\S]*aria-label="快晴[\s\S]*aria-label="晴れのち曇り[\s\S]*aria-label="曇り[\s\S]*aria-label="雨[\s\S]*aria-label="雪[\s\S]*aria-label="霧[\s\S]*aria-label="天変地異/);
  assert.doesNotMatch(homeHtml, /<span class="nm">/, '空模様の名前の文字は出さない');
  assert.equal((homeHtml.match(/class="sky( none)?"/g) || []).length, 8);
  // ホームは全体だけ: 空模様は数だけで、押しても画面を移らない・メーカーの名前を出さない（行き来は左のメニューから。2026-10-13）
  assert.match(homeHtml, /<div class="sky[^"]*" tabindex="0" role="group"/);
  assert.doesNotMatch(homeHtml, /onclick="go\('analysis'\)"/);
  // 2026-10-06 村井さん: ホームは全体の概要だけ（個社の表・名前は出さない。最近の動き・あなたの役割も出さない）
  assert.doesNotMatch(homeHtml, /最近の動き|あなたの役割|クライアント|計画の状態/);
  // 2026-10-13 村井さん: 空模様にだけ、当てはまるメーカーの名前を出す（ほかの所には出さない）
  const visible = homeHtml.replace(/data-tip="[^"]*"/g, '').replace(/<span class="mk">[\s\S]*?<\/span><\/div>/g, '');
  assert.doesNotMatch(visible, /テスト製薬|別の製薬/, 'ホームで個社の名前を出すのは空模様の中だけ');
  // 2026-10-06 村井さん: 「よみが観測しました（時刻）」は出さない・1 カラム（左右に分けない）・「状態を見る」のボタンは出さない
  assert.doesNotMatch(homeHtml, /よみが観測しました|class="dash"|状態を見る/);
  // 2026-10-06 村井さん: 読み込みの待ちは、右下ではなく画面の中で、よみが「観測中…」と話す
  const waitHtml = vm.runInContext(`S.homeLoading = true; B.home = null; var __w = viewHome(); B.home = __home; S.homeLoading = false; __w`, ui);
  assert.match(waitHtml, /class="card loading"[\s\S]*観測中…[\s\S]*読み込んでいます/);
  assert.doesNotMatch(waitHtml, /読み込み中…/);
  // 読み込みに失敗したら、理由と「もう一度読み込む」を出し、描くたびに読み直さない（前は失敗のたびに apiHome を呼び直していた）
  const failHtml = JSON.parse(vm.runInContext(`var __n = 0, __c0 = call; call = function(){ __n++; }; B.home = null; S.ld.home = { error: 'つながりません', at: Date.now() }; var __f = viewHome() + viewHome(); call = __c0; B.home = __home; S.ld.home = { at: Date.now() }; JSON.stringify([__f, __n])`, ui));
  assert.match(failHtml[0], /読み込めませんでした[\s\S]*つながりません[\s\S]*homeLoad\(\)[\s\S]*もう一度読み込む/);
  assert.equal(failHtml[1], 0, '描くだけでは読み直さない');
  assert.doesNotMatch(String(vm.runInContext(`busy.toString()`, ui)), /観測中…/, '右下に「観測中…」を出さない');
  // 保存中・裏の処理の間も、画面の中（見出しの下）でよみが話す（2026-10-06 村井さん）
  const saving = vm.runInContext(`S.writing = true; S.writingFn = 'apiSaveSetting'; S.writeShow = true; var __s = jobBanner(); S.writing = false; S.writeShow = false; __s`, ui);
  assert.match(saving, /class="card loading"[\s\S]*保存中…[\s\S]*保存しています/);
  assert.equal(vm.runInContext(`S.writing = true; S.writeShow = false; var __q = jobBanner(); S.writing = false; __q`, ui), '', '0.6 秒までは出さない');
  const jobSave = vm.runInContext(`S.job = { id: 'j', kind: 'PLAN.EDIT', payload: { action: 'INPUT.SAVE' }, status: 'RUNNING', started: Date.now() - 5000 }; var __j = jobBanner(); S.job = null; __j`, ui);
  assert.match(jobSave, /class="card loading"[\s\S]*保存中…[\s\S]*処理中・5 秒/);
  assert.doesNotMatch(String(vm.runInContext(`busy.toString()`, ui)), /innerHTML|classList/, '右下には何も出さない');
  assert.ok(!/undefined|NaN/.test(homeHtml), 'ホームに undefined や NaN を出さない');
  assert.doesNotMatch(homeHtml, /旧アプリ/, 'ホームに旧アプリの案内を出さない');
  const says = JSON.parse(vm.runInContext(`JSON.stringify(yomiSays(__home))`, ui));
  assert.ok(says.length >= 1 && says.every((x) => x.text && x.pose && x.lvl), JSON.stringify(says));
  // 承認待ちがあれば、承認者に確認を頼む（いちばん上）
  const h2 = JSON.parse(JSON.stringify(ui.__home));
  h2.approvals = [{ planId: h2.plans[0].planId, clientName: 'テスト製薬', fy: h2.fy, versionNo: 2, submittedBy: 'planner' }];
  ui.__h2 = h2;
  assert.match(JSON.parse(vm.runInContext(`JSON.stringify(yomiSays(__h2)[0])`, ui)).text, /承認待ちの公式版が 1 件[\s\S]*確認をお願いします/);
  // 仕組みの異常（バックアップが止まった等）はセリフで知らせ、「状態を見る」のボタンは付けない（2026-10-06）
  const h3 = JSON.parse(JSON.stringify(ui.__home));
  h3.system = { backup: { enabled: false }, housekeeping: { ok: false, problems: ['x'] }, journal: null };
  ui.__h3 = h3;
  const says3 = JSON.parse(vm.runInContext(`JSON.stringify(yomiSays(__h3))`, ui));
  assert.ok(says3.some((x) => /バックアップ/.test(x.text)) && says3.some((x) => /手入れ/.test(x.text)), JSON.stringify(says3));
  assert.ok(says3.every((x) => !x.act || x.act[0] !== '状態を見る'), JSON.stringify(says3));
  assert.doesNotMatch(vm.runInContext(`B.home = __h3; viewHome()`, ui), /状態を見る/);
  vm.runInContext(`B.home = __home`, ui);
  // 予算・着地見込みが無いメーカーがあるのに「おおむね晴れ」とは言わない（2026-10-06 点検）
  const fogSays = JSON.parse(vm.runInContext(`JSON.stringify(yomiSays({ fy: '2026', plans: [{ fy: '2026', planId: 'P', clientName: 'X', stepErrors: [], runs: 1, p50: 10, budget: null, officialFinal: null, landing: null, lastRunAt: new Date().toISOString(), officialNo: 1 }], approvals: [], mine: [] }))`, ui));
  assert.ok(fogSays.some((x) => /霧/.test(x.text)) && !fogSays.some((x) => /おおむね晴れ/.test(x.text)), JSON.stringify(fogSays));
  vm.runInContext(`S.view = 'forecast'`, ui);
  // 根拠のタブ
  ui.__basis = env.call('apiForecastBasis(__in)', { __in: { planId } });
  const basisHtml = vm.runInContext(`S.fc.basis = __basis; fcSection(viewForecast(), 'basis')`, ui);
  // 中身のある部分だけを出す（補正・市場の調査・前回からの変化は、記録があるときだけ。「まだありません」を重ねない。2026-10-06）
  assert.match(basisHtml, /過去の売上だけ[\s\S]*月ごとの内訳/);
  assert.ok((basisHtml.match(/まだ/g) || []).length <= 1, '根拠のタブに「まだ」を重ねない');
  assert.ok(!/undefined|NaN/.test(basisHtml), '根拠のタブに undefined や NaN を出さない');
  // 公式版のタブ（版がまだ無いとき・出したとき）
  ui.__ver = env.call('apiVersionList(__in)', { __in: { planId } });
  const verHtml = vm.runInContext(`S.fc.ver = __ver; fcSection(viewForecast(), 'version')`, ui);
  assert.match(verHtml, /公式版の最終予算[\s\S]*今の内容を公式版として出す[\s\S]*まだ版がありません/);
  env.call('appTestVersionSubmit_(__in)', { __in: { planId, note: 'テスト' } });
  ui.__ver = env.call('apiVersionList(__in)', { __in: { planId } });
  const verHtml2 = vm.runInContext(`S.fc.ver = __ver; S.fc.verCmp = __ver.versions[0].versionId; viewForecast()`, ui);
  assert.match(verHtml2, /承認待ち（v1）[\s\S]*v1 と今の比べ/);
  assert.ok(!/undefined|NaN/.test(verHtml2), '公式版のタブに undefined や NaN を出さない');
  // メーカー: その年度に計画のあるメーカーと、予算策定の状態・年度の数字（ZAC の候補・計画を作るは出さない。2026-10-06 村井さん）
  ui.__pf = env.call('apiPortfolio()').plans;
  const mkHtml = vm.runInContext(`S.pf = __pf; S.mkFy = String(__pf[0].fy); viewMakers()`, ui);
  assert.match(mkHtml, /<h1>メーカー一覧<\/h1><select[^>]*data-near[\s\S]*ステータス[\s\S]*年間予算[\s\S]*暫定実績[\s\S]*着地の推定[\s\S]*テスト製薬[\s\S]*(未着手|策定中|承認待ち|承認済み)[\s\S]*合計/);
  assert.equal((mkHtml.match(/>テスト製薬</g) || []).length, 1);
  assert.doesNotMatch(mkHtml, /ZAC コード|絞り込|並べ方|計画を作る|undefined|NaN/, '絞り込み・並べ替え・ZAC コード・計画を作るは出さない');
  // 計画の一覧を読む前は、ホームの初期データ（同じ項目）ですぐ描く
  assert.match(vm.runInContext(`var __kp = S.pf; S.pf = null; B.home = __home; var __m = viewMakers(); S.pf = __kp; __m`, ui), /<h1>メーカー一覧<\/h1>[\s\S]*テスト製薬[\s\S]*開く/);
  // 年度は題のすぐ横に出す
  assert.match(vm.runInContext(`viewTitle('<div class="page-head"><h1>メーカー</h1><select data-near="1"></select></div>')`, ui), /<h1[^>]*>メーカー<\/h1><span class="vnear"><select/);
  // 予測は「メーカーを選ぶ」だけの画面を出さない: 題の横に年度とメーカーの選ぶ欄（2026-10-13 村井さん）
  const pick = vm.runInContext(`var __keep = [S.fc.planId, S.fc.plans]; S.fc.planId = null; S.fc.plans = [{ planId: 'P1', clientName: 'テスト製薬', fy: '2026' }]; var __p = viewForecast(); S.fc.planId = __keep[0]; S.fc.plans = __keep[1]; __p`, ui);
  assert.doesNotMatch(pick, /メーカーを選ぶ/);
  assert.match(pick, /<h1>予測<\/h1><span class="fc-sels" data-near="1"><select[^>]*id="fc_fy"[\s\S]*FY2026[\s\S]*<select[^>]*id="fc_mk"[^>]*>[\s\S]*>テスト製薬<\/option>/);
  // メニュー: ホーム・メーカー・予測・分析・学び（使える人は全員同じ。2026-10-06 村井さん）
  assert.deepEqual(JSON.parse(vm.runInContext(`JSON.stringify(NAV.map(function(n){ return n[1]; }))`, ui)), ['ホーム', 'メーカー一覧', '予測', '分析', '学び']);
  assert.equal(vm.runInContext(`go('settings'); S.view`, ui), 'home', '無い画面へは移らない');
  // 分析（apiCrossMaker）: 年度は題の横。画面の中のタブは無く、1 カラムで縦に（要点のよみ → … → 話題ごとの向き。2026-10-13）
  ui.__an = env.call('apiCrossMaker(__in)', { __in: {} });
  const anHtml = vm.runInContext(`S.view = 'analysis'; S.an.data = __an; S.an.fy = String(__an.fy); viewAnalysis()`, ui);
  assert.match(anHtml, /<h1>分析<\/h1><select[^>]*data-near[^]*?<\/div><div class="card"><div class="hero">[\s\S]*話題ごとの向き/);
  assert.doesNotMatch(anHtml, /role="tablist"(?! aria-label="見せ方")|俯瞰|見通しの空模様/, 'タブと空模様の板は無い');
  assert.match(vm.runInContext(`S.an.data = null; S.ld.an = { error: 'x', at: 1 }; var __a = viewAnalysis(); S.an.data = __an; __a`, ui), /読み込めませんでした[\s\S]*anLoad\(\)/);
  // 学び（人の学び: apiPeopleLearning・AI の学び: apiAiLearning）
  ui.__lp = env.call('apiPeopleLearning()'); ui.__la = env.call('apiAiLearning()');
  const lrHtml = vm.runInContext(`S.view = 'learning'; S.lr.people = __lp; S.lr.ai = __la; lrTab('people'); viewLearning()`, ui);
  assert.match(lrHtml, /<h1>学び<\/h1>[\s\S]*人の学び[\s\S]*AI の学び/);
  assert.match(vm.runInContext(`lrTab('ai'); viewLearning()`, ui), /<button class="tab on"[^>]*>AI の学び</);
  for (const v of ['analysis', 'learning']) assert.ok(!/undefined|NaN/.test(vm.runInContext(`S.view = '${v}'; ${v === 'analysis' ? 'viewAnalysis()' : 'viewLearning()'}`, ui)), v);
  vm.runInContext(`S.view = 'forecast'`, ui);
  // 確かめる画面はアプリの中（ブラウザ標準の confirm を使わない）。はい で実行、やめる で何もしない
  assert.doesNotMatch(uiHtml.replace(/S\.fc\.confirm|fcConfirm|confirms/g, ''), /[^.\w]confirm\(/, 'confirm( を使わない');
  const askRes = JSON.parse(vm.runInContext(`(function(){ var aw = { innerHTML: '', classList: { add() {}, remove() {} } }; var g = document.getElementById; document.getElementById = function(id){ return id === 'askwrap' ? aw : g(id); };
    var hit = 0; ask('締めますか？', '締める', function(){ hit++; }, true); var h = aw.innerHTML; askDone(false); ask('出しますか？', '出す', function(){ hit += 10; }); askDone(true);
    document.getElementById = g; return JSON.stringify([h, hit]); })()`, ui));
  assert.match(askRes[0], /role="dialog"[\s\S]*締めますか？[\s\S]*>締める<[\s\S]*>やめる</);
  assert.equal(askRes[1], 10, 'やめる では実行しない・はい で 1 回だけ実行');
  // 進みは実行する順（A → B → C・番号順）に並べる
  const stepsHtml = vm.runInContext(`var __kv = S.fc.view; S.fc.view = JSON.parse(JSON.stringify(__kv)); S.fc.view.boot.steps = [{ menu: 'A-2', label: 'a2', status: 'not_run' }, { menu: 'B-1', label: 'b1', status: 'not_run' }, { menu: 'A-9', label: 'a9', status: 'not_run' }, { menu: 'A-4', label: 'a4', status: 'not_run' }]; var __st = fcStepsTab(S.fc.data, S.fc.view); S.fc.view = __kv; __st`, ui);
  assert.match(stepsHtml, />a2<[\s\S]*>a4<[\s\S]*>a9<[\s\S]*>b1</);
  // 振り返りの記録（検証・見直し案）が何も無いときは「まだありません」を重ねない（案内 1 枚 + 更新の操作）
  const evalEmpty = vm.runInContext(`var __kv2 = [S.fc.view, S.fc.learn]; S.fc.view = JSON.parse(JSON.stringify(__kv2[0])); S.fc.view.boot.eval = {}; S.fc.view.boot.quarterly = {}; S.fc.learn = { planId: S.fc.planId, accuracy: { months: [] }, shadow: null }; var __ev = fcReviewTab(S.fc.data, S.fc.view); S.fc.view = __kv2[0]; S.fc.learn = __kv2[1]; __ev`, ui);
  assert.equal((evalEmpty.match(/まだ/g) || []).length, 1, evalEmpty.slice(0, 400));
  assert.doesNotMatch(evalEmpty, /精度の推移<|学習の影</);
  // 値の無い金額に単位だけを付けない（「-円」「- 円」にしない）
  assert.doesNotMatch(vm.runInContext(`fcKpi('最終予算', null)`, ui), /円/);
  assert.equal(vm.runInContext(`yenU(null) + '|' + yenU(1200)`, ui), '-|1,200 円');
  // 言葉: 予測の幅は 下振れ・中心・上振れ、操作は旧来の番号なし（ボタン 8 字まで・完全な名前）、サーバーの文の番号は直して出す
  assert.equal(vm.runInContext(`[qName('p10'), qName('p50'), qName('p90')].join()`, ui), '下振れ,中心,上振れ');
  assert.equal(vm.runInContext(`plainMsg('A-9 予測実行で失敗。先に A-2 を実行してください（SHA-256）')`, ui), '予測で失敗。先に 売上を取り込む を実行してください（SHA-256）');
  assert.equal(vm.runInContext(`actName('REVIEW.APPLY') + '|' + actShort('EVAL.INSIGHTS')`, ui), '承認した見直し案を反映する|外れの原因を整理');
  assert.equal(vm.runInContext(`[tone(1.1), tone(1.0), tone(0.9), tone(null)].join()`, ui), 'warm,neutral,cool,neutral');
  assert.equal(vm.runInContext(`[accWeather(0.05), accWeather(0.12), accWeather(0.18), accWeather(0.25), accWeather(0.4), accWeather(0.05, true), accWeather(null)].join()`, ui), 'kaisei,harenochi,kumori,ame,taifuu,taifuu,mikakunin');
  assert.equal(vm.runInContext(`[yenShort(123456789), yenShort(34000000), yenShort(8000), yenShort(-2.5e9), yenShort(2.1e9)].join()`, ui), '1.2億,3,400万,8,000,-25.0億,21.0億');   // 億は小数 1 けたをいつも付ける（21.0億 と 20.7億 を並べて比べられる）
  assert.equal(vm.runInContext(`SKY8.map(function(s){ return s.key; }).join()`, ui), 'mousho,kaisei,harenochi,kumori,ame,sekka,mikakunin,tenpen');
  assert.equal(vm.runInContext(`[skyKey({ sky: 'taifuu' }), skyKey({}), skyKey({ sky: 'mousho' })].join()`, ui), 'mikakunin,mikakunin,mousho');
  // グラフ: 空・null・1 点・負の値・幅 0 でも止まらず、SVG か「データがまだありません」を返す（NaN を描かない）
  const charts = JSON.parse(vm.runInContext(`JSON.stringify([
    chartBullet([]), chartBullet([{ label: 'A', low: 1, mid: 2, high: 3, target: 2.5, tone: 'warm' }, { label: 'B', mid: null }]), chartBullet([{ label: 'A', low: 5, mid: 5, high: 5 }]),
    chartScatter(null), chartScatter([{ x: 1, y: 0.2, label: 'A', tone: 'cool' }], { refX: 1 }), chartScatter([{ x: 0.9, y: 0.1 }, { x: 1.3, y: -0.2 }, { x: NaN, y: 1 }]),
    chartBars([{ label: 'A', value: null }]), chartBars([{ label: 'A', value: -0.1 }, { label: 'B', value: 0.2 }]), chartBars([{ label: 'A', value: 0 }]), chartBars([{ label: 'A', value: 0.4 }], { min: 0, max: 1, ref: 0.8 }),
    chartIntervals([]), chartIntervals([{ label: 'A', lo: 0.2, mid: 0.5, hi: 0.9 }, { label: 'B', mid: 1.4 }], { ref: 0.8 }),
    chartSpark([]), chartSpark([null, 3]), chartSpark([1, null, 2, 5]),
    chartLine([]), chartLine([{ label: 'a', values: [1] }], { x: ['4月'] }), chartLine([{ label: 'a', values: [1, null, 3] }, { label: 'b', values: [2, 2, 2] }], { x: ['4月', '5月', '6月'], band: [{ lo: 0, hi: 3 }, null, { lo: 1, hi: 4 }], target: 2 }),
    chartStep([]), chartStep([{ x: '2026/04', y: 1 }]), chartStep([{ x: 'a', y: 0.98 }, { x: 'b', y: 1.02 }], { ref: 1 }),
    chartDensity([]), chartDensity([{ alpha: 0, beta: 1 }]), chartDensity([{ alpha: 2, beta: 2, dashed: true, label: '学ぶ前' }, { alpha: 30, beta: 10, label: '今', opacity: 0.6 }, { alpha: 0.5, beta: 0.5 }]),
    chartArrows([]), chartArrows([{ label: 'A', raw: 0.1, shrunk: 0.04 }, { label: 'B', raw: -0.2, shrunk: null }], { mu: 0.01, tau: 0.05 }), chartArrows([{ label: 'A', raw: 0, shrunk: 0 }])
  ])`, ui));
  for (const [i, c] of charts.entries()) {
    assert.ok(/^<svg|データがまだありません|^<span class="note">-<\/span>$/.test(c), `グラフ ${i}: ${c.slice(0, 120)}`);
    assert.ok(!/NaN|undefined|Infinity/.test(c), `グラフ ${i} に NaN を描かない: ${c.slice(0, 200)}`);
    if (c.startsWith('<svg class="chart"')) assert.match(c, /viewBox="0 0 \d+ \d+" width="100%"[\s\S]*role="img" aria-label="[^"]+"><title>/, `グラフ ${i} は幅いっぱいに縮み、名前がある`);
  }
  assert.ok(charts.filter((c) => c.startsWith('<svg class="chart"')).every((c) => /data-tip="/.test(c)), '印にカーソルの説明を付ける');
  assert.doesNotMatch(charts.join(''), /(fill|stroke)="#/, '色は CSS の変数（クラス）だけ');
  const cot = vm.runInContext(`var __t1 = chartOrTable('x', '<svg></svg>', '<table></table>'); cvSet('x', 'table'); __t1 + '|' + chartOrTable('x', '<svg></svg>', '<table></table>')`, ui);
  assert.match(cot, /グラフ<\/button>[\s\S]*表で見る<\/button>[\s\S]*<svg><\/svg>[^|]*\|[\s\S]*class="tab on"[^>]*>表で見る<[\s\S]*<table><\/table>/, '「表で見る」を選ぶと表に替わり、選んだ方を覚える');
  // 予測の題に、横の選ぶ欄と同じ名前を重ねない
  const two = vm.runInContext(`var __k2 = [S.fc.plans, S.fc.planId]; S.fc.plans = [{ planId: S.fc.planId, clientName: 'テスト製薬', fy: '2026' }, { planId: 'PX', clientName: '別の製薬', fy: '2026' }]; var __t = viewForecast(); S.fc.plans = __k2[0]; S.fc.planId = __k2[1]; __t`, ui);
  assert.match(two, /<h1>予測(<| )[\s\S]*?<span class="fc-sels" data-near="1"><select/);
  assert.doesNotMatch(two, /<h1>予測：/);
}

// スマホ幅では表の列幅を中身で決める（決まった幅の列で残りの列が 0 に潰れないように。2026-10-06 点検）
{
  const uiSrc = uiHtml;
  const mobile = uiSrc.slice(uiSrc.lastIndexOf('@media (max-width:760px){'));   // 共通のスマホの決まり（最後。画面ごとの決まりは各区切りの中）
  assert.match(mobile.slice(0, 4000), /table\.tbl\{table-layout:auto\}/);
}

console.log('app-plan: all tests passed');
