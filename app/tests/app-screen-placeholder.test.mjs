#!/usr/bin/env node
/**
 * 画面確認の仮（仮予算・仮実績・B-1/B-2）を、人の MANUAL と分けて印を付け、印の行だけ消す。
 * 既存の行は、印を付ける操作を実行するまで変えない。数字だけ似ている行は消さない。
 * 印が残っていても保存は止まらない。消す前の行と OUTPUT の H・I は控えから戻せる。
 *
 *   node app/tests/app-screen-placeholder.test.mjs
 */
import assert from 'node:assert/strict';
import { OWNER, setUpEnv } from './gas-mock.mjs';

const env = setUpEnv();
env.run(`appToday_ = function () { return '2026-10-21'; }`);
env.as(OWNER);
const FY = 2026;
const yms = Array.from({ length: 12 }, (_, i) => { const m = 4 + i; return (m > 12 ? FY + 1 : FY) + '/' + String(m > 12 ? m - 12 : m).padStart(2, '0'); });
const P50 = yms.map((_, i) => 1000 + i * 10);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const HC = env.call('APP_ENGINE_SHEETS.EVAL_COMPARE_MONTHLY.header');
const HP = env.call('APP_ENGINE_SHEETS.PROCESS_STATUS.header');
const HS = env.call('APP_ENGINE_SHEETS.SALES_INPUT.header');

function book(client, { adopted, uplift, cmp = [], status = [] } = {}) {
  const output = [['FY' + FY + ' 売上予測（' + client + '）']];
  for (let r = 2; r <= 23; r++) output.push([]);
  output.push([' 混合（主要）'], []);
  output.push(['年度合計（予測）', sum(P50) * 0.9, sum(P50), sum(P50) * 1.1, '', '', '', '', '', '']);
  output.push([], ['Month', 'Downside(P10)', 'Baseline(P50)', 'Upside(P90)', '', '', '', 'Adopted Forecast', 'Sales Uplift', 'Final Budget']);
  yms.forEach((ym, i) => output.push([ym, P50[i] - 100, P50[i], P50[i] + 100, '', '', '', adopted ? adopted[i] : P50[i], uplift ? uplift[i] : '', '']));
  const formulas = { H26: '=SUM(H29:H40)', I26: '=SUM(I29:I40)', J26: '=SUM(J29:J40)' };
  for (let i = 0; i < 12; i++) formulas['J' + (29 + i)] = `=H${29 + i}+I${29 + i}`;
  const sheets = {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', FY], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    PRODUCT: { values: [['Person', 'ProductName', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']] },
    CLIENT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']] },
    OPINIONS: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Confidence(0..1)', 'Note']] },
    DEV_SPOT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Project', 'Amount(JPY)', 'Confidence(0..1)']] },
    OUTPUT: { values: output, formulas, formats: { A: '@' } },
    SALES_INPUT: { values: [HS], formats: { D: '@' } },
  };
  if (cmp.length) sheets.EVAL_COMPARE_MONTHLY = { values: [HC, ...cmp], formats: { A: '@' } };
  if (status.length) sheets.PROCESS_STATUS = { values: [HP, ...status] };
  return env.makeBook(client, sheets);
}
const nums = (id) => env.call(`appPlanNumbers_('${id}')`);
const view = (id) => env.call('apiPlanView(__in)', { __in: { planId: id } });
const drafts = (id) => env.table('BUDGET_DRAFTS').filter((r) => r.plan_id === id);
const save = (id, rows, extra) => env.runJob('PLAN.EDIT', { planId: id, action: 'BUDGET.SAVE', args: Object.assign({ rows }, extra || {}) });
const task = (action, extra) => {
  env.props.OWNER_TASK = JSON.stringify(Object.assign({ action }, extra || {}));
  return env.call('apiOwnerTask()');
};
const clientRow = (id, reason) => ({ plan_id: id, seq: '2', Person: '鷹野', 'Month(yyyy/mm/dd)': '2026-04-01', 'Step(増減率%)': '0', Reason: reason, _types: 'ssss' });
const legacyDrafts = (id, scale, rate) => yms.map((ym, i) => {
  const adopted = Math.round(P50[i] * scale);
  return { plan_id: id, draft_id: 'BDR-LEG-' + id + '-' + i, action_id: 'ACT-LEG-' + id, ym, adopted, uplift: Math.round(adopted * rate),
    basis: 'MANUAL', alloc: 'MANUAL', prob: null, run_id: '', center: P50[i], actor_email: OWNER, saved_at: '2026-09-01T00:00:00+0900' };
});

const human = env.seedPlan(book('人手の製薬'));
const dummy = env.seedPlan(book('仮の製薬'));
env.run(`appInsertRows_('ENG_CLIENT', __r)`, { __r: [clientRow(human, '本物の動向')] });
const humanSave = save(human, [{ row: 29, adopted: 1500, uplift: 50 }]);
assert.equal(humanSave.status, 'DONE', humanSave.error);
assert.equal(humanSave.result.draft.basis, 'MANUAL');

const seeded = task('seedDummyBudgets', { fy: FY });
assert.equal(seeded.ok, true, JSON.stringify(seeded));
const dummyDrafts = drafts(dummy);
assert.equal(dummyDrafts.length, 12);
assert.ok(dummyDrafts.every((r) => r.basis === 'SCREEN_CHECK' && r.alloc === 'SCREEN_CHECK'), '新しい仮予算は MANUAL と違う印');
assert.equal(view(dummy).boot.budgetDraft.placeholder, true);
assert.ok(env.table('ENG_CLIENT').some((r) => r.plan_id === dummy && String(r.Reason).indexOf('SCREEN_CHECK') === 0));
assert.ok(env.table('ENG_OPINIONS').some((r) => r.plan_id === dummy && String(r.Note).indexOf('SCREEN_CHECK') === 0));
assert.ok(env.table('ENG_DEV_SPOT').some((r) => r.plan_id === dummy && String(r.Project).indexOf('SCREEN_CHECK') === 0));
assert.ok(drafts(human).every((r) => r.basis === 'MANUAL' && r.alloc === 'MANUAL'), '人の保存は MANUAL のまま');
assert.equal(env.table('ENG_CLIENT').filter((r) => r.plan_id === human).map((r) => r.Reason).join(','), '本物の動向');
const beforeHuman = nums(human).monthly.map((m) => [m.adopted, m.uplift]);
const beforeDummy = nums(dummy).monthly.map((m) => m.adopted);
let proposalMsg = '';
try { env.call('apiBudgetProposal(__in)', { __in: { planId: dummy, prob: 50 } }); }
catch (e) { proposalMsg = String(e && e.message || e); }
assert.doesNotMatch(proposalMsg, /画面確認の仮が残っている/, proposalMsg);
const badBasis = save(human, [{ row: 30, adopted: 1600 }], { basis: 'SCREEN_CHECK' });
assert.equal(badBasis.status, 'FAILED');
assert.match(badBasis.error, /予算の決め方/);
assert.deepEqual(nums(human).monthly.map((m) => [m.adopted, m.uplift]), beforeHuman, '止めた保存は人の予算を変えない');

const suspected = env.seedPlan(book('疑いの製薬'));
env.run(`appWithLock_(() => appAppendLogRows_('BUDGET_DRAFTS', __r, []))`, { __r: legacyDrafts(suspected, 0.62, 0.02) });
let preview = task('previewScreenPlaceholders', { fy: FY });
assert.equal(preview.ok, true, JSON.stringify(preview));
assert.equal(env.props.OWNER_TASK, JSON.stringify({ action: 'previewScreenPlaceholders', fy: FY }), '件数の確認は読むだけ');
assert.ok(preview.result.marked.drafts >= 12, JSON.stringify(preview.result.marked));
assert.equal(preview.result.suspected.drafts, 12, JSON.stringify(preview.result.suspected));
assert.equal(preview.result.markable.drafts, 0, '数字だけ似ている行には印を付けない');
const marked0 = task('markScreenPlaceholders', { fy: FY });
assert.equal(marked0.ok, true, JSON.stringify(marked0));
assert.deepEqual(marked0.result.marked, { drafts: 0, inputs: 0, evals: 0, status: 0, outputMonths: 0 });
assert.ok(drafts(suspected).every((r) => r.basis === 'MANUAL'));
const staleSave = save(suspected, [{ row: 29, adopted: 1700, uplift: 20 }]);
assert.equal(staleSave.status, 'DONE', staleSave.error || '');
assert.equal(staleSave.result.draft.basis, 'MANUAL', '印の無い仮が残っていても、予算の保存は止まらない');
assert.equal(drafts(suspected).filter((r) => String(r.draft_id).indexOf('BDR-LEG-') === 0).length, 12, '印の無い下書きは保存では消えない');

const legacy = env.seedPlan(book('旧仮の製薬'));
env.run(`appInsertRows_('ENG_CLIENT', __r)`, { __r: [clientRow(legacy, '検証用の仮の動向')] });
env.run(`appWithLock_(() => appAppendLogRows_('BUDGET_DRAFTS', __r, []))`, { __r: legacyDrafts(legacy, 0.82, 0.05) });
preview = task('previewScreenPlaceholders', { fy: FY });
assert.equal(preview.result.markable.drafts, 0, '数字が似ていても下書きには印を付けない');
assert.equal(preview.result.markable.inputs, 1);
assert.ok(preview.result.suspected.drafts >= 12, JSON.stringify(preview.result.suspected));
assert.ok(drafts(legacy).every((r) => r.basis === 'MANUAL'), '印を付けるまでは既存の行を変えない');
const marked = task('markScreenPlaceholders', { fy: FY });
assert.equal(marked.ok, true, JSON.stringify(marked));
assert.equal(marked.result.marked.drafts, 0);
assert.equal(marked.result.marked.inputs, 1);
assert.ok(drafts(legacy).every((r) => r.basis === 'MANUAL' && r.alloc === 'MANUAL'));
assert.ok(env.table('ENG_CLIENT').some((r) => r.plan_id === legacy && r.Reason === 'SCREEN_CHECK 検証用の仮の動向'));
assert.ok(drafts(human).every((r) => r.basis === 'MANUAL'));
assert.ok(drafts(suspected).every((r) => r.basis === 'MANUAL'));
const legacyNums = nums(legacy).monthly.map((m) => [m.adopted, m.uplift]);

const dry = task('deleteScreenPlaceholders', { fy: FY });
assert.equal(dry.ok, true, JSON.stringify(dry));
assert.equal(dry.result.apply, false);
assert.equal(dry.result.deleted, null);
assert.equal(drafts(dummy).length, 12, '確認だけでは消さない');
assert.throws(() => task('deleteScreenPlaceholders', { fy: FY, apply: 'true' }), /apply/);

env.run(`appWithLock_(() => {
  const row = appReadPlanTable_('ENG_ROWS', __id).filter(r => r.sheet === 'OUTPUT' && Number(r.col_from) === 1 && Number(r.row_no) === 29)[0];
  const cells = JSON.parse(row.cells_json);
  while (cells.length < 9) cells.push('e');
  cells[8] = 'n999';
  appPatchRow_('ENG_ROWS', { plan_id: row.plan_id, sheet: row.sheet, row_no: row.row_no, col_from: row.col_from }, { cells_json: JSON.stringify(cells) }, 'test');
})`, { __id: dummy });
const hashOf = (id) => Object.fromEntries(env.table('ENG_SHEETS').filter((r) => r.plan_id === id && (r.sheet === 'OUTPUT' || r.sheet === 'CLIENT')).map((r) => [r.sheet, r.content_hash]));
const hashBefore = hashOf(dummy);
const gone = task('deleteScreenPlaceholders', { fy: FY, apply: true });
assert.equal(gone.ok, true, JSON.stringify(gone));
assert.equal(gone.result.apply, true);
assert.ok(gone.result.deleted.drafts >= 12);
assert.equal(drafts(dummy).length, 0);
assert.equal(drafts(legacy).length, 12, '印の無い下書きは残す');
assert.ok(drafts(legacy).every((r) => r.basis === 'MANUAL'));
assert.equal(drafts(suspected).filter((r) => String(r.draft_id).indexOf('BDR-LEG-') === 0).length, 12, '数字だけ似ている行は残す');
assert.ok(drafts(human).every((r) => r.basis === 'MANUAL' && r.alloc === 'MANUAL'));
assert.deepEqual(nums(human).monthly.map((m) => [m.adopted, m.uplift]), beforeHuman);
assert.deepEqual(nums(legacy).monthly.map((m) => [m.adopted, m.uplift]), legacyNums, '印の無い計画の本体は戻さない');
assert.equal(nums(dummy).monthly[0].adopted, P50[0]);
assert.equal(nums(dummy).monthly[0].uplift, 999, '仮が書いていない上乗せは残す');
assert.ok(nums(dummy).monthly.slice(1).every((m, i) => m.adopted === P50[i + 1] && m.uplift === null), '仮の本体だけ、仮を書く前の真ん中に戻す');
assert.ok(beforeDummy.some((v, i) => v !== P50[i]), '戻す前は仮の金額だった');
assert.equal(env.table('ENG_CLIENT').filter((r) => r.plan_id === dummy).length, 0);
assert.equal(env.table('ENG_CLIENT').filter((r) => r.plan_id === legacy && String(r.Reason).indexOf('SCREEN_CHECK') === 0).length, 0);
assert.equal(env.table('ENG_CLIENT').filter((r) => r.plan_id === human).map((r) => r.Reason).join(','), '本物の動向');
assert.equal(env.table('PLANS').filter((p) => p.plan_id === dummy)[0].people_csv, '鷹野');
const hashAfter = hashOf(dummy);
assert.notEqual(hashAfter.OUTPUT, hashBefore.OUTPUT, '消したあとの OUTPUT のハッシュを書き直す');
assert.notEqual(hashAfter.CLIENT, hashBefore.CLIENT, '消したあとの入力のハッシュを書き直す');
assert.equal(env.run(`(() => { const plan = appPlanOf_(__id); return appScratchTryReuse_(appWorkScratch_(plan), plan.plan_id, ['OUTPUT'], 'TOK-SCREEN') ? 'reused' : 'fresh'; })()`, { __id: dummy }), 'fresh', '消す前の計算用ブックは使い回さない');
const diffAt = beforeDummy.findIndex((v, i) => v !== P50[i] && i >= 2);
assert.ok(diffAt >= 2);
const mid = save(dummy, [{ row: 30, adopted: 2222, uplift: 3 }]);
assert.equal(mid.status, 'DONE', mid.error || '');
assert.equal(nums(dummy).monthly[1].adopted, 2222);
assert.equal(nums(dummy).monthly[0].uplift, 999, '1 か月の保存が、残した上乗せを仮の値に戻さない');
assert.equal(nums(dummy).monthly[diffAt].adopted, P50[diffAt], '1 か月の保存が、消した仮の金額をほかの月へ戻さない');
const april = env.table('SCREEN_HOLD').filter((r) => r.plan_id === dummy && r.kind === 'output').map((r) => JSON.parse(r.payload_json)).find((p) => Number(p.row_no) === 29);
assert.equal(april.before[1], 'n999', '書き戻さない列の元の値も控えに残す');
assert.deepEqual(april.wrote, [true, false]);
assert.ok(env.table('SCREEN_HOLD').some((r) => r.plan_id === dummy && r.kind === 'row' && r.table_name === 'BUDGET_DRAFTS'));
const back = task('restoreScreenPlaceholders', { fy: FY, batch: gone.result.batchId });
assert.equal(back.ok, true, JSON.stringify(back));
assert.equal(back.result.batchId, gone.result.batchId);
assert.ok(back.result.restored.rows >= 12);
assert.ok(drafts(dummy).some((r) => r.basis === 'SCREEN_CHECK'), '消した下書きが戻る');
assert.equal(nums(dummy).monthly[0].adopted, beforeDummy[0]);
assert.equal(nums(dummy).monthly[0].uplift, 999, '戻すときは、書き戻さなかった列も消す前の値に戻す');
assert.equal(nums(dummy).monthly[diffAt].adopted, beforeDummy[diffAt]);
assert.ok(env.table('ENG_CLIENT').some((r) => r.plan_id === dummy && String(r.Reason).indexOf('SCREEN_CHECK') === 0));
assert.ok(env.table('ENG_CLIENT').some((r) => r.plan_id === legacy && r.Reason === 'SCREEN_CHECK 検証用の仮の動向'));
const backAgain = task('restoreScreenPlaceholders', { fy: FY, batch: gone.result.batchId });
assert.equal(backAgain.ok, true, JSON.stringify(backAgain));
assert.equal(drafts(dummy).filter((r) => r.basis === 'SCREEN_CHECK').length, 12, '2 回戻しても下書きは増えない');
const gone2 = task('deleteScreenPlaceholders', { fy: FY, apply: true });
assert.equal(gone2.ok, true, JSON.stringify(gone2));
assert.equal(drafts(dummy).some((r) => r.basis === 'SCREEN_CHECK'), false);
assert.equal(drafts(legacy).filter((r) => r.basis === 'MANUAL').length, 12);

const again = task('markScreenPlaceholders', { fy: FY });
assert.deepEqual(again.result.marked, { drafts: 0, inputs: 0, evals: 0, status: 0, outputMonths: 0 });
const againDel = task('deleteScreenPlaceholders', { fy: FY, apply: true });
assert.deepEqual(againDel.result.deleted, { drafts: 0, inputs: 0, evals: 0, status: 0, outputMonths: 0 });
let proposalThrew = false;
try { env.call('apiBudgetProposal(__in)', { __in: { planId: dummy, prob: 50 } }); }
catch (e) { proposalThrew = /画面確認の仮が残っている/.test(String(e && e.message)); }
assert.equal(proposalThrew, false);
const resumed = save(dummy, [{ row: 29, adopted: 1800, uplift: 10 }]);
assert.equal(resumed.status, 'DONE', resumed.error);
assert.equal(resumed.result.draft.basis, 'MANUAL');

const evalRow = (ym, actual, note) => HC.map((h) => ({ target_month: ym, actual_total: actual, forecast_total: 100, forecast_total_p50: 100, note_for_investigation: note }[h] ?? ''));
const statusRow = (key, by, count) => HP.map((h) => ({ step_key: key, last_run_date: '2026-10-01T10:00:00+0900', last_run_by: by, status: 'success', target_client: '着地の製薬', record_count: count, error_summary: '' }[h] ?? ''));
const landing = env.seedPlan(book('着地の製薬', {
  adopted: P50.map(() => 100), uplift: P50.map(() => ''),
  cmp: [evalRow('2026/04', 777, '本物の実績')],
  status: [statusRow('step1_status', 'owner@bigm2y.com', 3), statusRow('step2_status', 'owner@bigm2y.com', 10)],
}));
const landed = task('seedDummyLanding', { fy: FY });
assert.equal(landed.ok, true, JSON.stringify(landed));
assert.ok((landed.result.filled || []).some((x) => x.planId === landing));
const steps = () => env.table('ENG_PROCESS_STATUS').filter((r) => r.plan_id === landing);
assert.ok(steps().some((r) => r.step_key === 'step2_status' && r.last_run_by === 'owner@bigm2y.com' && r.error_summary === ''));
assert.ok(steps().some((r) => r.step_key === 'step5_status' && r.error_summary === 'SCREEN_CHECK'));
const notes = () => env.table('ENG_EVAL_COMPARE_MONTHLY').filter((r) => r.plan_id === landing);
assert.ok(notes().some((r) => r.note_for_investigation === '本物の実績'));
assert.ok(notes().some((r) => r.note_for_investigation === 'SCREEN_CHECK'));
const landingSave = save(landing, [{ row: 29, adopted: 1900, uplift: 15 }]);
assert.equal(landingSave.status, 'DONE', landingSave.error || '');
assert.equal(landingSave.result.draft.basis, 'MANUAL', '印の付いた仮が残っていても、予算の保存は止まらない');
const cleared = task('deleteScreenPlaceholders', { fy: FY, apply: true });
assert.equal(cleared.ok, true, JSON.stringify(cleared));
assert.ok(cleared.result.deleted.evals > 0);
assert.ok(cleared.result.deleted.status > 0);
assert.ok(steps().some((r) => r.step_key === 'step1_status'));
assert.ok(steps().some((r) => r.step_key === 'step2_status' && r.last_run_by === 'owner@bigm2y.com'));
assert.equal(steps().some((r) => r.error_summary === 'SCREEN_CHECK'), false);
assert.deepEqual(notes().map((r) => r.note_for_investigation), ['本物の実績']);
assert.ok(drafts(human).every((r) => r.basis === 'MANUAL'));
assert.ok(drafts(suspected).every((r) => r.basis === 'MANUAL'));

console.log('app-screen-placeholder: all tests passed');
