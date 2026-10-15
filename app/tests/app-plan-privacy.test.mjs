#!/usr/bin/env node
/*
 * app-plan-privacy.test.mjs — 計画の画面（apiPlanView）と予測の根拠（apiForecastBasis）でも、人ごとの当たりと外れた月の担当は
 * 予算策定担当以上の人だけに出す（学びと同じ決まり: appInsightDetail_。2026-10-07 村井さん承認）。
 * - 閲覧・情報提供の人: 四半期レビューの提案の信頼度の対象は種類まで・その根拠（的中率）と見込みは空・検証の記入の担当は空・
 *   根拠の押したものの人や話題ごとの内訳（名前と信頼度）は空・予測の注記（OUTPUT!A6）の信頼度の行は人や話題ごとの一覧（適用中=…）を除く。
 *   入力の行・担当者の一覧・見解の一文（入力のまとめ）はこれまでどおり
 * - 予算策定担当（その計画のクライアント・ほかのクライアント・全体）・承認者・管理者: 前と同じ中身
 * - 控えは見る人によらず同じものを使う: どちらの順に開いても、それぞれの形が返る（控えそのものは変えない）
 * - 画面: 閲覧の人の形でも、振り返りと根拠のタブを描ける（undefined・人の名前・空の札を出さない）
 * 名前はテスト用の架空のもの（鷹野・佐藤）。
 *
 *   node app/tests/app-plan-privacy.test.mjs
 */

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { J, MEMBER, OTHER, OWNER, extractFunction, fcSection, setUpEnv, sources, uiHtml } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const PLANNER_ALL = 'planner@bigm2y.com';
const APPROVER = 'approver@bigm2y.com';
const PLANNER_ELSEWHERE = OTHER;   // ほかのクライアントだけの予算策定担当
const NAMES = ['鷹野', '佐藤'];
const IMPACT_B1 = '次回A-9で opinion:鷹野 の主観/AI寄与を reliability_r=1.100 で重み付け';
/** 旧来の A-9 が OUTPUT!A6 に書く信頼度の行（本物の buildReliabilityText_ で作る。C-3 で信頼度の提案を適用した後の形） */
const reliabilityText = vm.runInNewContext(extractFunction(sources['LegacyEngine.js'], 'buildReliabilityText_') + '; buildReliabilityText_');
const relText = (map, apply = true) => reliabilityText({ reliabilityApply: apply, nonDefaultReliabilityCount: [...map.values()].filter((v) => v !== 1).length,
  reliabilityInputs: { reliabilityMap: map }, spotCapBasis: 'dlm' });
const REL_FULL = 'Source Reliability: ON / 非1.0ソース数=2 / 適用中=factor_product:佐藤=0.80, opinion:鷹野=1.10 / SPOT上限基準=dlm';
const REL_VIEWER = 'Source Reliability: ON / 非1.0ソース数=2 / SPOT上限基準=dlm';
assert.equal(relText(new Map([['opinion:鷹野', 1.1], ['factor_product:佐藤', 0.8], ['vertex_forecast:assist', 1]])), REL_FULL, '旧来の信頼度の行の形');
/** OUTPUT!A6 の注記（旧来の writeOutputFY_ と同じ並び。経過月は実績の形なので engineNote にも写る） */
const NOTE_A6 = ['経過月は実績（ActualClosed列）で表示していますが、年度合計(P10/P50/P90)は12ヶ月すべてを予測として算出した通年予測です（経過実績で固定した着地値ではありません）。',
  '予測エンジン: 既存Ops（トレンド+季節）', '主観入力は月次上限（cap）内でそのまま反映されます（3c-1でオーバーレイ率の自動調整を撤去）。', REL_FULL,
  'AI取込警告サマリー: なし', '適用中の四半期チューニング: なし（全項目既定値） / 3か月以上の実績確定後に C-1 を実行してください。'].join('\n');
/** 画面に出す注記: 見直し案を作る操作（C-1）を止めている間は、C-1 への案内を除く（appPlanViewNotes_。2026-10-07 決定 D3） */
const NOTE_SHOWN = NOTE_A6.replace(' / 3か月以上の実績確定後に C-1 を実行してください。', '');

/** 計画 1 つ（入力・検証の記入・四半期レビューの提案）と、旧来の予測の代わりで 1 回分の根拠の記録。役割も付けておく（付けると控えが古くなるので先に） */
function build() {
  const env = setUpEnv();
  const H = env.run('(() => { const o = {}; Object.keys(APP_ENGINE_SHEETS).forEach(k => { o[k] = APP_ENGINE_SHEETS[k].header || null; }); return o; })()');
  const output = [['FY2026 売上予測（テスト製薬）']];
  for (let r = 2; r <= 79; r++) output.push([]);
  output[5] = [NOTE_A6];
  output[25] = ['年度合計（予測）', 900, 1000, 1100];
  for (let i = 0; i < 12; i++) output[28 + i] = [D(2026, 4 + i), 70, 80, 90];
  output[64] = ['年度合計（予測）', 800, 900, 1000];
  for (let i = 0; i < 12; i++) output[67 + i] = [D(2026, 4 + i), 60, 70, 80];
  const ins = (month, extra) => H.EVAL_INSIGHTS.map((h) => (h in extra ? extra[h] : { evaluated_at: D(2026, 9, 1), client: 'テスト製薬', target_month: month,
    actual_total: 100, pred_p50: 120, diff: -20, error_rate: -0.2, insight: '実績が予測未達。失注・延期・単価低下要因を確認。', next_action: '追加調査 / 前提見直し / 入力項目反映 を実施。',
    range_breach: 1, action_type: 'update', next_cycle_reflection: '次回サイクルで前提更新を反映', status: 'open' }[h] ?? ''));
  const book = env.makeBook('クライアント別売上予測', {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', 'テスト製薬'], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野,佐藤']] },
    OUTPUT: { values: output },
    PRODUCT: { values: [['Person', 'ProductName', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason'], ['鷹野', '製品A', D(2026, 5), 5, '新規']] },
    CLIENT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']] },
    OPINIONS: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Confidence(0..1)', 'Note'], ['佐藤', D(2026, 5), 5, 0.7, '採用が広がる']] },
    DEV_SPOT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Project', 'Amount(JPY)', 'Confidence(0..1)']] },
    EVAL_INSIGHTS: { values: [H.EVAL_INSIGHTS, ins('2026/04', { cause_hypothesis: '受注の遅れ', owner: '鷹野', status: 'in_progress' }), ins('2026/05', {})], formats: { C: '@' } },
    // 検証の記入を画面に出すのは、今の検証の版で測った締まった月だけ（2026-10-07）。4・5 月は 9/01 に取り込んで締まり、B-2 が測った
    ACTUAL_EVAL_MONTHLY: { values: [H.ACTUAL_EVAL_MONTHLY, ['テスト製薬', 'BASE', '製品A', '2026/04', 100, 'closed', D(2026, 9, 1)],
      ['テスト製薬', 'BASE', '製品A', '2026/05', 100, 'closed', D(2026, 9, 1)]], formats: { D: '@' } },
    EVAL_LOG: { values: [H.EVAL_LOG].concat(['2026/04', '2026/05'].map((ym) => H.EVAL_LOG.map((h) => ({ eval_id: 'E' + ym, evaluated_at: D(2026, 9, 1),
      client: 'テスト製薬', target_month: ym, scenario: 'neutral', pred: 120, actual: 100, evaluation_policy_version: 'policy-2026H1-v3', constraint_relevant_flag: 1 }[h] ?? '')))),
    formats: { D: '@' } },
    QUARTERLY_REVIEW: {
      values: [['【四半期レビュー: FY2026-Q1】'], ['検証期間: 2026/04 〜 2026/06（実績確定済み）'], [], [], [], [], ['提案ID', '対象', '現在値', '提案値', '自信度', '根拠', '影響見積もり', '承認列', 'ロールバック'],
        ['P-B-1', 'reliability:opinion:鷹野', 1, 1.1, 0.7, '的中率=67% / n=3', IMPACT_B1, '', 'C-2で却下、またはSOURCE_RELIABILITYを手動で旧値へ戻す', 'R-1'],
        ['P-B-2', 'reliability:factor_product:佐藤', 1, 0.8, 0.6, '的中率=20% / n=5', '次回A-9で factor_product:佐藤 の主観/AI寄与を reliability_r=0.800 で重み付け', '', 'C-2で却下、またはSOURCE_RELIABILITYを手動で旧値へ戻す'],
        ['P-A-1', 'ai_weight_override', 0.5, 0.4, 0.5, 'AI方向一致率=40.0% / mean|kAI-1|=1.00%', '次期AI寄与を80%へ調整', '', 'C-2で却下または手動で元値に戻す']],
      formats: { G: '@' },
    },
    FORECAST_SNAPSHOT: { values: [H.FORECAST_SNAPSHOT], formats: { D: '@' } },
    AI_IMPACT_HISTORY: { values: [H.AI_IMPACT_HISTORY] },
    SUBJECTIVE_IMPACT_HISTORY: { values: [H.SUBJECTIVE_IMPACT_HISTORY] },
    PROCESS_STATUS: { values: [H.PROCESS_STATUS, ['step4_status', D(2026, 9, 1), 'owner', 'success', 'テスト製薬', 12, '']] },
  });
  const planId = env.seedPlan(book);
  env.seedPlan(env.makeBook('別のメーカー', { CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', '別の製薬'], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '佐藤']] } }));
  // 旧来の予測の代わり: 押したものの記録（人や話題ごと・信頼度つき）と、見解の一文（入力の見解のまとめ）を 1 回分書く
  env.run(`(() => {
    const base = appLegacyEngine_;
    appLegacyEngine_ = function (svc) {
      const eng = base(svc);
      eng.runPhase1Forecast = function () {
        const ss = svc.SpreadsheetApp.getActiveSpreadsheet(), now = new svc.Date();
        const ym = i => '2026/' + String(4 + i > 12 ? 4 + i - 12 : 4 + i).padStart(2, '0');
        const snap = ss.getSheetByName('FORECAST_SNAPSHOT');
        for (let i = 0; i < 12; i++) snap.getRange(snap.getLastRow() + 1, 1, 1, 15).setValues([['S-' + i, now, 'テスト製薬', ym(i), 'neutral', 80, 0, 0, 0, 80, 70, 90,
          JSON.stringify({ opinion: i === 1 ? '佐藤:+5%(0.70)' : '' }), '', JSON.stringify({ bias_correction_factor: 1 })]]);
        const ai = ss.getSheetByName('AI_IMPACT_HISTORY');
        for (let i = 0; i < 12; i++) ai.getRange(ai.getLastRow() + 1, 1, 1, 12).setValues([['R1', now, 'テスト製薬', ym(i), 1.02, 0.3, 'up', 80, 78, 0, 0, 'forecast_open']]);
        const sp = ss.getSheetByName('SUBJECTIVE_IMPACT_HISTORY');
        sp.getRange(sp.getLastRow() + 1, 1, 3, 11).setValues([
          ['R1', now, 'テスト製薬', ym(1), 'opinion', '佐藤', 0.05, 'up', 0.8, '', 'forecast_open'],
          ['R1', now, 'テスト製薬', ym(1), 'factor_product', '鷹野', -0.03, 'down', 1.2, '', 'forecast_open'],
          ['R1', now, 'テスト製薬', ym(1), 'ai_topic', 'Market', 0.02, 'up', 1, '', 'forecast_open']]);
      };
      return eng;
    };
  })()`);
  const run = env.runJob('FORECAST.RUN', { planId });
  assert.equal(run.status, 'DONE', run.error);
  const plans = env.table('PLANS');
  const here = plans.find((p) => p.plan_id === planId).client_id;
  const elsewhere = plans.find((p) => p.plan_id !== planId).client_id;
  assert.ok(here && elsewhere && here !== elsewhere, 'クライアントは 2 つ');
  for (const email of [MEMBER, PLANNER_ALL, APPROVER, PLANNER_ELSEWHERE, 'planner.here@bigm2y.com']) env.task(`saveMember({ email: '${email}', displayName: 'T' })`);
  env.task('grantRole(__in)', { __in: { email: 'planner.here@bigm2y.com', role: 'PLANNER', scopeType: 'CLIENT', clientId: here } });
  env.task('grantRole(__in)', { __in: { email: PLANNER_ELSEWHERE, role: 'PLANNER', scopeType: 'CLIENT', clientId: elsewhere } });
  env.task('grantRole(__in)', { __in: { email: PLANNER_ALL, role: 'PLANNER', scopeType: 'ALL' } });
  env.task('grantRole(__in)', { __in: { email: APPROVER, role: 'APPROVER', scopeType: 'ALL' } });
  const as = (email, fn) => { env.as(email); try { return fn(); } finally { env.as(OWNER); } };
  return {
    env, planId,
    view: (email) => as(email, () => env.call('apiPlanView(__in)', { __in: { planId } })),
    basis: (email) => as(email, () => env.call('apiForecastBasis(__in)', { __in: { planId } })),
  };
}
// 管理者・承認者・予算策定担当（全体・その計画のメーカー）。ほかのメーカーだけの予算策定担当（PLANNER_ELSEWHERE）は、この計画では閲覧の人と同じ
// （2026-10-13。前は全部の中身を渡していた。計画ごとの画面は、その計画のメーカーで予算策定担当以上かで決める）
const FULL_ROLES = [OWNER, APPROVER, PLANNER_ALL, 'planner.here@bigm2y.com'];
const hasName = (text) => NAMES.filter((n) => text.includes(n));
/** 入力の画面に出すもの（入力の行・担当者の一覧・見解の一文）を除いた写し。残りに人の名前が無いことを確かめる */
const withoutInputs = (v) => {
  const x = J(v);
  if (x.boot) {
    delete x.boot.input; delete x.boot.setup.people; delete x.boot.setup.peopleCsv;
    ((x.boot.output && x.boot.output.breakdown) || []).forEach((r) => { delete r.opinions; });
  }
  (x.monthly || []).forEach((m) => { delete m.opinion; });
  return x;
};
/** 閲覧の人に見せる形を、全部の中身から手で作る（決まりの書き下し） */
const redactedView = (full) => {
  const x = J(full);
  x.boot.quarterly.proposals.forEach((p) => {
    if (!p.target.startsWith('reliability:')) return;
    p.target = p.target.split(':').slice(0, 2).join(':'); p.rationale = ''; p.impact = '';
    p.current = ''; p.proposed = '';   // 信頼度の今と案の値も出さない（情報源が 1 人だけの種類で、その人の値がわかるため。2026-10-07）
  });
  x.boot.eval.insights.forEach((r) => { r.owner = ''; });
  (x.boot.runLog || []).forEach((r) => { r.by = ''; });   // 操作した人（2026-10-13）
  (x.boot.steps || []).forEach((s) => { s.by = ''; });
  const o = x.boot.output;
  o.policyLines = o.policyLines.map((t) => t.split(REL_FULL).join(REL_VIEWER));
  o.engineNote = o.engineNote.split(REL_FULL).join(REL_VIEWER);
  return x;
};
const redactedBasis = (full) => {
  const x = J(full);
  x.monthly.forEach((m) => m.sources.forEach((s) => { s.keys = []; }));
  (x.between || []).forEach((b) => { b.actor = ''; });   // 操作した人（2026-10-13）
  return x;
};

// ==== 1. 計画の画面: 閲覧の人には人ごとの当たり（信頼度の提案の対象の名前・根拠・見込み）と担当を出さない。予算策定担当以上は前と同じ ====
{
  const t = build();
  const full = t.view(OWNER);
  // 前提: 全部の中身には、人の名前・的中率・担当がある
  const pb1 = full.boot.quarterly.proposals.find((p) => p.pid === 'P-B-1');
  assert.deepEqual([pb1.target, pb1.rationale, pb1.impact], ['reliability:opinion:鷹野', '的中率=67% / n=3', IMPACT_B1]);
  assert.equal(full.boot.eval.insights.find((r) => r.month === '2026/04').owner, '鷹野');
  assert.deepEqual([full.boot.output.policyLines, full.boot.output.engineNote], [[NOTE_SHOWN.replace(/\n+/g, ' ')], NOTE_SHOWN], '予測の注記には、信頼度を効かせている人の名前がある');
  for (const email of FULL_ROLES) assert.deepEqual(t.view(email).boot, full.boot, email + ' には前と同じ中身');
  assert.deepEqual([t.view('planner.here@bigm2y.com').can.plan, t.view(PLANNER_ELSEWHERE).can.plan], [true, false], '保存できるかは前と同じ（見せ方とは別）');

  const sum = t.view(MEMBER);
  assert.equal(sum.can.plan, false);
  assert.deepEqual(sum.boot, redactedView(full).boot, '閲覧の人: 信頼度の対象は種類まで・根拠と見込みは空・担当は空。ほかは同じ');
  assert.deepEqual(t.view(PLANNER_ELSEWHERE).boot, sum.boot, 'ほかのメーカーだけの予算策定担当には、閲覧の人と同じ中身');
  assert.deepEqual(sum.boot.quarterly.proposals.map((p) => [p.pid, p.target, p.current, p.proposed, p.rationale, p.impact]), [
    ['P-B-1', 'reliability:opinion', '', '', '', ''],
    ['P-B-2', 'reliability:factor_product', '', '', '', ''],
    ['P-A-1', 'ai_weight_override', '0.5', '0.4', 'AI方向一致率=40.0% / mean|kAI-1|=1.00%', '次期AI寄与を80%へ調整']]);
  assert.deepEqual(sum.boot.eval.insights.map((r) => [r.month, r.owner, r.hypothesis]), [['2026/04', '', '受注の遅れ'], ['2026/05', '', '']]);
  assert.deepEqual([sum.boot.output.policyLines, sum.boot.output.engineNote], [[NOTE_SHOWN.replace(REL_FULL, REL_VIEWER).replace(/\n+/g, ' ')], NOTE_SHOWN.replace(REL_FULL, REL_VIEWER)],
    '予測の注記: 信頼度の行は ON/OFF と数だけ（人や話題ごとの一覧を除く）。ほかの行はそのまま');
  assert.ok(!JSON.stringify(sum.boot.output).includes('適用中='), '予測の注記に人や話題ごとの信頼度を出さない');
  // 人の名前と的中率は、入力の画面に出すもの（入力の行・担当者の一覧）のほかには、どこにも無い
  for (const part of [sum.boot.quarterly, sum.boot.eval]) assert.deepEqual(hasName(JSON.stringify(part)), []);
  assert.deepEqual(hasName(JSON.stringify(withoutInputs(sum))), [], '閲覧の人の中身に人の名前を出さない');
  assert.ok(!JSON.stringify(sum).includes('的中率'), '人ごとの的中率を出さない');
  assert.deepEqual([sum.boot.input, sum.boot.setup.people], [full.boot.input, full.boot.setup.people], '入力の行と担当者の一覧はこれまでどおり');
  assert.deepEqual(sum.boot.input.product.map((r) => r.person).concat(sum.boot.input.opinions.map((r) => r.person)), ['鷹野', '佐藤']);
}

// ==== 1b. 予測の注記の信頼度の行: 旧来の形のどれでも、人や話題ごとの一覧だけ除く（6 件以上の「ほか」・OFF・手入力なし・途中で切れた行） ====
{
  const env = setUpEnv();
  const six = new Map(['鷹野', '佐藤', '話題A', '話題B', '話題C', '話題D'].map((k, i) => ['opinion:' + k, 1 + (i + 1) / 10]));
  const lines = {
    many: relText(six), off: relText(six, false), neutral: relText(new Map()), cut: 'Source Reliability: ON / 非1.0ソース数=2 / 適用中=opinion:鷹野=1.10, factor_product:佐藤',
  };
  assert.match(lines.many, /ほか 1件 \/ SPOT上限基準=dlm$/);
  assert.match(lines.neutral, /手入力なし/);
  const r = J(env.run(`(() => {
    const L = ${JSON.stringify(lines)}, viewer = { roles: [{ role: 'VIEWER', scope_type: 'ALL', client_id: '' }] };
    const out = {};
    Object.keys(L).forEach(k => { const o = appPlanViewFor_(viewer, { boot: { output: { policyLines: ['前の行', L[k] + ' AI取込警告サマリー: なし'], engineNote: '経過月は実績…\\n' + L[k] + '\\nAI取込警告サマリー: なし' } } }).boot.output; out[k] = o; });
    out.noNote = appPlanViewFor_(viewer, { boot: { output: { policyLines: [], engineNote: '' } } }).boot.output;
    return out;
  })()`));
  const note = (t) => ({ policyLines: ['前の行', t + ' AI取込警告サマリー: なし'], engineNote: '経過月は実績…\n' + t + '\nAI取込警告サマリー: なし' });
  assert.deepEqual(r.many, note('Source Reliability: ON / 非1.0ソース数=6 / SPOT上限基準=dlm'), '6 件以上（ほか N件）でも一覧ごと除く');
  assert.deepEqual(r.off, note(lines.off), '信頼度を効かせていない（OFF）行はそのまま');
  assert.deepEqual(r.neutral, note(lines.neutral), '手入力なしの行はそのまま');
  assert.deepEqual(r.cut, { policyLines: ['前の行', 'Source Reliability: ON / 非1.0ソース数=2'], engineNote: '経過月は実績…\nSource Reliability: ON / 非1.0ソース数=2\nAI取込警告サマリー: なし' },
    '一覧の終わりが見つからなければ、その行の終わりまで除く（出さない側）');
  assert.deepEqual(r.noNote, { policyLines: [], engineNote: '' }, '注記が無くても止まらない');
  assert.deepEqual(hasName(JSON.stringify(r)), [], '人の名前を出さない');
}

// ==== 2. 予測の根拠: 閲覧の人には押したものの人や話題ごとの内訳（名前と信頼度）を出さない（種類ごとの押しだけ）。予算策定担当以上は前と同じ ====
{
  const t = build();
  const full = t.basis(OWNER);
  const may = full.monthly.find((m) => m.month === '2026/05');
  assert.deepEqual(may.sources.map((s) => [s.type, s.keys]), [['opinion', ['佐藤 +5%（信頼度 0.80）']], ['factor_product', ['鷹野 -3%（信頼度 1.20）']], ['ai_topic', ['Market +2%']]]);
  for (const email of FULL_ROLES) assert.deepEqual(t.basis(email), full, email + ' には前と同じ中身');

  const sum = t.basis(MEMBER);
  assert.deepEqual(sum, redactedBasis(full), '閲覧の人: 内訳だけ空。ほかは同じ');
  assert.deepEqual(t.basis(PLANNER_ELSEWHERE), sum, 'ほかのメーカーだけの予算策定担当には、閲覧の人と同じ根拠');
  assert.deepEqual(sum.monthly.find((m) => m.month === '2026/05').sources.map((s) => [s.type, s.label, Math.round(s.step * 100), s.n, s.keys]),
    [['opinion', '見解', 5, 1, []], ['factor_product', '製品の入力', -3, 1, []], ['ai_topic', 'AI の話題', 2, 1, []]], '種類ごとの押しと数は出す');
  assert.ok(!JSON.stringify(sum).includes('信頼度'), '人や話題ごとの信頼度を出さない');
  assert.deepEqual(hasName(JSON.stringify(withoutInputs(sum))), [], '閲覧の人の根拠に人の名前を出さない（見解の一文は入力のまとめ）');
  assert.equal(sum.monthly.find((m) => m.month === '2026/05').opinion, may.opinion, '見解の一文（入力の見解のまとめ）はこれまでどおり');
}

// ==== 3. 控え: 見る人によらず同じ控えを使い、どちらの順に開いてもそれぞれの形が返る。控えそのものは変えない ====
{
  const a = build();
  const b = build();
  // 処理の終わりに作る画面の中身の控え（appJobWarm_）を捨て、見る人の順に控えを作り直す（2026-10-13 から処理の終わりにも控えを作る）
  for (const t of [a, b]) for (const k of Object.keys(t.env.cache)) delete t.env.cache[k];
  const count = (env) => env.run(`(() => { globalThis.__builds = { view: 0, basis: 0 };
    const sb = appStoreBook_, et = appEngTableObjects_;
    appStoreBook_ = function () { __builds.view++; return sb.apply(null, arguments); };
    appEngTableObjects_ = function () { __builds.basis++; return et.apply(null, arguments); }; })()`);
  count(a.env); count(b.env);
  // a: 閲覧の人が先（控えを作る）→ 予算策定担当 → また閲覧の人 → 管理者。b: その逆の順
  const aSum = [a.view(MEMBER), a.basis(MEMBER)];
  const aFull = [a.view(PLANNER_ALL), a.basis(PLANNER_ALL)];
  const aSum2 = [a.view(MEMBER), a.basis(MEMBER)];
  const aAdmin = [a.view(OWNER), a.basis(OWNER)];
  const bFull = [b.view(PLANNER_ALL), b.basis(PLANNER_ALL)];
  const bSum = [b.view(MEMBER), b.basis(MEMBER)];
  assert.deepEqual(J(a.env.run('__builds')), { view: 1, basis: 1 }, '画面の中身と根拠は 1 回だけ組み立てる（見る人で分けない）');
  assert.deepEqual(J(b.env.run('__builds')), { view: 1, basis: 1 });
  // 2 つの環境は、計画の ID と予測した時刻だけが違う（作った秒が違う）ので、そこをそろえて比べる
  const same = (t, x) => JSON.parse(JSON.stringify(x).split(t.planId).join('PLAN').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^"]*/g, 'TIME'));
  assert.deepEqual(same(a, [aSum[0].boot, aSum[1]]), same(b, [bSum[0].boot, bSum[1]]), '閲覧の人の形は順に依らない');
  assert.deepEqual(same(a, [aFull[0].boot, aFull[1]]), same(b, [bFull[0].boot, bFull[1]]), '予算策定担当の形は順に依らない');
  assert.deepEqual([aSum2[0].boot, aSum2[1]], [aSum[0].boot, aSum[1]]);
  assert.deepEqual([aAdmin[0].boot, aAdmin[1]], [aFull[0].boot, aFull[1]]);
  assert.deepEqual([aSum[0].boot, aSum[1]], [redactedView(aFull[0]).boot, redactedBasis(aFull[1])]);
  // 皆で使う控え（入力のハッシュごと）は、閲覧の人が開いた後も全部の中身のまま
  const keyOf = (env, kind) => {
    const k = Object.keys(env.cache).filter((x) => new RegExp('^APP_JOB_RESULT_' + kind + '_[0-9a-f]{32}$').test(x));
    assert.equal(k.length, 1, kind + ' の控えは 1 つ');
    return k[0].slice('APP_JOB_RESULT_'.length);
  };
  const shared = (env, kind) => J(env.run(`appJobGetResult_('${keyOf(env, kind)}')`)).value;
  // 予算の下書き（boot.budgetDraft。版 11）は皆で使う控えに入れず、開くたびに足す
  const noDraft = (b) => { const c = Object.assign({}, b); delete c.budgetDraft; return c; };
  assert.equal(aFull[0].boot.budgetDraft, null, '下書きが無ければ null');
  assert.deepEqual(shared(a.env, 'VIEW').boot, noDraft(aFull[0].boot), '画面の中身の控えは全部の中身のまま');
  assert.deepEqual(shared(a.env, 'BASIS'), aFull[1], '根拠の控えも全部の中身のまま');
  // 写しを直す: 渡したものは変えない。予算策定担当以上には、渡したものをそのまま返す
  const r = J(a.env.run(`(() => {
    const v = appJobGetResult_('${keyOf(a.env, 'VIEW')}').value;
    const b = appJobGetResult_('${keyOf(a.env, 'BASIS')}').value;
    const v0 = JSON.stringify(v), b0 = JSON.stringify(b);
    const viewer = { roles: [{ role: 'VIEWER', scope_type: 'ALL', client_id: '' }, { role: 'CONTRIBUTOR', scope_type: 'ALL', client_id: '' }] };
    const planner = { roles: [{ role: 'PLANNER', scope_type: 'CLIENT', client_id: 'X' }] };
    const sv = appPlanViewFor_(viewer, v), sb = appBasisFor_(viewer, b);
    return { same: [JSON.stringify(v) === v0, JSON.stringify(b) === b0], copy: [sv !== v, sb !== b],
      planner: [appPlanViewFor_(planner, v, { client_id: 'X' }) === v, appBasisFor_(planner, b, { client_id: 'X' }) === b],
      elsewhere: [appPlanViewFor_(planner, v, { client_id: 'Y' }) !== v, appBasisFor_(planner, b, { client_id: 'Y' }) !== b, appPlanViewFor_(planner, v) !== v],
      none: [appPlanViewFor_(undefined, v) !== v, appBasisFor_(undefined, b) !== b],
      empty: [appPlanViewFor_(viewer, null), appBasisFor_(viewer, null), appPlanViewFor_(viewer, { boot: { quarterly: {}, eval: {} } })] };
  })()`));
  assert.deepEqual(r.same, [true, true], '控えから読んだものを変えない');
  assert.deepEqual(r.copy, [true, true], '閲覧の人には写し');
  assert.deepEqual(r.planner, [true, true], 'その計画のメーカーの予算策定担当以上には、そのまま（前と同じ）');
  assert.deepEqual(r.elsewhere, [true, true, true], 'ほかのメーカーだけの担当・計画が分からないときは写し（出さない側）');
  assert.deepEqual(r.none, [true, true], '見る人が分からなければ閲覧の人と同じ（出さない側）');
  assert.deepEqual(r.empty, [null, null, { boot: { quarterly: {}, eval: {} } }], '提案や記入が無くても止まらない');
  // 役割が変われば、同じ人でも形が変わる（役割を付けると控えが古くなる）
  a.env.task('grantRole(__in)', { __in: { email: MEMBER, role: 'PLANNER', scopeType: 'ALL' } });
  assert.deepEqual([a.view(MEMBER).boot, a.basis(MEMBER)], [aFull[0].boot, aFull[1]], '予算策定担当になった後は全部の中身');
}

// ==== 4. 予算策定担当以上の中身は、この変更の前（見せ方を分ける前）と同じ ====
{
  const t = build();
  const after = FULL_ROLES.map((email) => [t.view(email), t.basis(email)]);
  t.env.run(`__pvf = appPlanViewFor_; __bf = appBasisFor_; appPlanViewFor_ = function (ctx, v) { return v; }; appBasisFor_ = function (ctx, b) { return b; }; appBumpGen_();`);
  const before = FULL_ROLES.map((email) => [t.view(email), t.basis(email)]);
  const beforeViewer = [t.view(MEMBER), t.basis(MEMBER)];
  t.env.run(`appPlanViewFor_ = __pvf; appBasisFor_ = __bf; appBumpGen_();`);
  assert.deepEqual(after, before, '予算策定担当・承認者・管理者は前と同じ');
  assert.deepEqual([beforeViewer[0].boot, beforeViewer[1]], [after[0][0].boot, after[0][1]], '前は閲覧の人にも同じものを渡していた');
  assert.deepEqual([t.view(MEMBER).boot, t.basis(MEMBER)], [redactedView(after[0][0]).boot, redactedBasis(after[0][1])]);
}

// ==== 5. 画面: 閲覧の人の形でも、振り返りと根拠のタブを描ける（undefined・人の名前・的中率・空の札を出さない） ====
{
  const t = build();
  const roles = { viewer: [{ role: 'VIEWER' }, { role: 'CONTRIBUTOR' }], planner: [{ role: 'VIEWER' }, { role: 'CONTRIBUTOR' }, { role: 'PLANNER' }] };
  const render = (email, who) => {
    const view = t.view(email), basis = t.basis(email);
    t.env.as(email);
    const learn = t.env.call('apiLearningView(__in)', { __in: { planId: t.planId } });
    const data = t.env.call('apiForecastLatest(__in)', { __in: { planId: t.planId } });
    t.env.as(OWNER);
    const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
      .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
      .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email, isOwner: false, isAdmin: false, roles: roles[who] }, setUp: true, allowed: true }));
    const el = () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
    const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, confirm: () => false, window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
      google: { script: { run: new Proxy({}, { get: (tg, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
    vm.runInContext(js, ui);
    Object.assign(ui, { __v: view, __d: data, __b: basis, __l: learn });
    vm.runInContext(`S.view = 'forecast'; S.fc.plans = [{ planId: __v.plan.planId, clientName: 'x', fy: '2026' }]; S.fc.planId = __v.plan.planId; S.fc.view = __v; S.fc.data = __d; S.fc.basis = __b; S.fc.learn = __l;`, ui);
    return { review: fcSection(vm.runInContext(`viewForecastAll()`, ui), 'review'), basisChart: fcSection(vm.runInContext(`viewForecastAll()`, ui), 'basis'),
      basis: fcSection(vm.runInContext(`S.cv.fcPush = 'table'; S.cv.fcBasisM = 'table'; viewForecastAll()`, ui), 'basis') };   // 表で見る（月ごとの内訳の札）
  };
  const chips = (html) => [...html.matchAll(/<span class="fc-src"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1].trim());
  const sum = render(MEMBER, 'viewer');
  for (const [tab, html] of Object.entries(sum)) {
    assert.ok(!/ここを表示できませんでした/.test(html), tab + ' タブを描ける');
    assert.ok(!/undefined|NaN/.test(html), tab + ' タブに undefined や NaN を出さない');
  }
  assert.match(sum.review, /人の記入[\s\S]*受注の遅れ/, '検証の記入は出す（担当の列は無し）');
  assert.match(sum.review, /AI の見直し案[\s\S]*見解の信頼度[\s\S]*製品の入力の信頼度[\s\S]*AI の効き/, '信頼度の対象は種類の名前で出す');
  assert.deepEqual(hasName(sum.review), [], '振り返りのタブに人の名前を出さない');
  assert.ok(!/的中率|当たった割合/.test(sum.review), '人ごとの的中率を出さない');
  assert.ok(!/（信頼度/.test(sum.basis) && !sum.basis.includes('鷹野'), '根拠のタブに人ごとの信頼度と名前を出さない（見解の一文は入力のまとめ）');
  assert.deepEqual(chips(sum.basis), ['↑ 見解 +5.0%', '↓ 製品 -3.0%', '↑ 話題 +2.0%'], '押したものの札は種類ごとに出す（空の札を出さない）');
  // 予算策定担当には、これまでどおり名前と信頼度を出す
  const full = render(PLANNER_ALL, 'planner');
  assert.ok(full.review.includes('鷹野') && /当たった割合 67%/.test(full.review));
  assert.ok(full.basis.includes('（信頼度 0.80）') && full.basis.includes('鷹野'));
  assert.deepEqual(chips(full.basis), chips(sum.basis), '札そのものは同じ（内訳はカーソルの説明だけ）');
}

// ==== 6. 操作した人のメール: その計画で予算策定担当以上でない人（閲覧の人・ほかのメーカーだけの担当）には返さない。画面は「-」で止まらない（2026-10-13） ====
{
  const t = build();
  const env = t.env;
  const run0 = env.call(`appReadTable_('FORECAST_RUNS').filter(r => r.plan_id === '${t.planId}').map(appStripRow_)[0]`);
  // 前回の予測と今回の予測の間に、予算策定担当の操作を 1 つ。今回の予測は承認者が動かした（根拠の「前回からの間の操作」と最新の予測の人）
  const T1 = '2099-01-01T00:00:00+0900', T2 = '2099-01-02T00:00:00+0900', T3 = '2099-01-02T00:01:00+0900';
  env.run(`appInsertRows_('PLAN_ACTIONS', __a); appInsertRows_('FORECAST_RUNS', __r); appBumpGen_();`, {
    __a: [{ action_id: 'ACT-T6', plan_id: t.planId, action: 'INPUT.SAVE', status: 'DONE', changed_sheets_json: '["PRODUCT"]', result_json: '{}', started_at: T1, finished_at: T1, actor_email: PLANNER_ALL }],
    __r: [Object.assign({}, run0, { run_id: 'FR-T6', started_at: T2, finished_at: T3, actor_email: APPROVER })] });
  // 行を直に足したので（ふつうは処理が書き、計算の入力も変わる）、処理の終わりに作った画面の中身の控え（appJobWarm_）を捨てる
  for (const k of Object.keys(env.cache)) delete env.cache[k];
  // 公式版: 予算策定担当が出し、承認者が承認した
  env.as(PLANNER_ALL);
  const sub = env.call('appTestVersionSubmit_(__in)', { __in: { planId: t.planId, inputHash: env.call('apiVersionList(__in)', { __in: { planId: t.planId } }).inputHash } });
  env.as(APPROVER);
  env.call('appTestVersionDecide_(__in)', { __in: { versionId: sub.version.versionId, decision: 'APPROVED', rowVersion: sub.version.rowVersion } });
  env.as(OWNER);
  const read = (email) => {
    env.as(email);
    try {
      return { view: env.call('apiPlanView(__in)', { __in: { planId: t.planId } }), basis: env.call('apiForecastBasis(__in)', { __in: { planId: t.planId } }),
        latest: env.call('apiForecastLatest(__in)', { __in: { planId: t.planId } }), ver: env.call('apiVersionList(__in)', { __in: { planId: t.planId } }) };
    } finally { env.as(OWNER); }
  };
  const emails = (x) => [...new Set((JSON.stringify(x).match(/[A-Za-z0-9._-]+@bigm2y\.com/g) || []))].sort();
  const full = read('planner.here@bigm2y.com');
  // 前提: 予算策定担当以上には、操作した人が出る
  assert.ok(full.view.recent.some((r) => r.actor === PLANNER_ALL), '最近の操作の人');
  assert.ok(full.view.boot.steps.some((s) => s.by), '手順の進みの人');
  assert.ok(full.basis.between.some((b) => b.actor === PLANNER_ALL), '前回からの間の操作の人');
  assert.deepEqual([full.latest.latest.actor_email, full.latest.runs[0].actor], [APPROVER, APPROVER]);
  const v1 = full.ver.versions.find((v) => v.versionId === sub.version.versionId);
  assert.deepEqual([v1.submittedBy, v1.decidedBy], [PLANNER_ALL, APPROVER]);
  for (const who of [MEMBER, PLANNER_ELSEWHERE]) {
    const x = read(who);
    assert.ok(x.view.recent.length && x.view.recent.every((r) => r.actor === ''), who + ': 最近の操作の人は空');
    assert.ok(x.view.boot.steps.every((s) => s.by === '') && (x.view.boot.runLog || []).every((r) => r.by === ''), who + ': 旧来の手順の進みと実行の記録の人は空');
    assert.ok(x.basis.between.length && x.basis.between.every((b) => b.actor === ''), who + ': 前回からの間の操作の人は空');
    assert.equal(x.latest.latest.actor_email, '', who + ': 最新の予測の人（行まるごとの actor_email）は空');
    assert.ok(x.latest.runs.every((r) => r.actor === ''), who + ': 予測の回の人は空');
    assert.ok(x.ver.versions.every((v) => v.submittedBy === '' && v.decidedBy === ''), who + ': 公式版を出した人・判断した人は空');
    assert.deepEqual([x.ver.official.submittedBy, x.ver.official.decidedBy], ['', '']);
    // 自分のメール（公式版の一覧の me）のほかに、人のメールを返さない
    const rest = Object.assign({}, x.ver); delete rest.me;
    assert.deepEqual(emails([x.view, x.basis, x.latest, rest]), [], who + ': 人のメールを返さない');
    // 数字などはそのまま
    assert.deepEqual([x.latest.latest.run_id, x.latest.runs.length, x.ver.versions.length], [full.latest.latest.run_id, full.latest.runs.length, full.ver.versions.length]);
  }
  // 控え（最新の予測は計画ごと・見る人によらず同じ）は全部の中身のまま: 閲覧の人が先に読んでも、予算策定担当には人が出る
  assert.equal(read(PLANNER_ALL).latest.latest.actor_email, APPROVER);
  // 画面: 空にした人は「-」。止まらない・undefined を出さない
  const viewer = read(MEMBER);
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: MEMBER, isOwner: false, isAdmin: false, roles: [{ role: 'VIEWER' }, { role: 'CONTRIBUTOR' }] }, setUp: true, allowed: true }));
  const el = () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
  const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, confirm: () => false, window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (tg, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  Object.assign(ui, { __v: viewer.view, __d: viewer.latest, __b: viewer.basis, __r: viewer.ver });
  vm.runInContext(`S.view = 'forecast'; S.fc.plans = [{ planId: __v.plan.planId, clientName: 'x', fy: '2026' }]; S.fc.planId = __v.plan.planId; S.fc.view = __v; S.fc.data = __d; S.fc.basis = __b; S.fc.ver = __r;`, ui);
  const tabs = {};
  const page = vm.runInContext(`viewForecastAll()`, ui);
  for (const tab of ['forecast', 'basis', 'version', 'steps']) { tabs[tab] = fcSection(page, tab); assert.ok(tabs[tab], tab + ' の区切りがある'); }
  for (const [tab, html] of Object.entries(tabs)) {
    assert.ok(!/ここを表示できませんでした/.test(html), tab + ' タブを描ける');
    assert.ok(!/undefined|NaN/.test(html), tab + ' タブに undefined や NaN を出さない');
    assert.deepEqual(emails(html), [], tab + ' タブに人のメールを出さない');
  }
  assert.match(tabs.steps, /この計画の最近の操作[\s\S]*<td>-<\/td>/, '最近の操作の「した人」は「-」');
  assert.match(tabs.version, /<td>-<\/td><td>-<\/td>/, '公式版の出した人・判断した人は「-」');
  assert.doesNotMatch(tabs.forecast, /最新 [^<]*・-/, '最新の予測の時刻の後ろに「・-」を付けない');
  assert.equal(vm.runInContext(`[fcWho(''), fcWho(null), fcWho('a.b@bigm2y.com')].join()`, ui), '-,-,a.b');
}

console.log('app-plan-privacy: all tests passed');
