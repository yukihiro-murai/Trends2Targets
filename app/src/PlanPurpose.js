/**
 * PlanPurpose.js — 測る専用の計画（PLANS.purpose = MEASURE。SCHEMA_PLAN_v10-12_JA.md の 3-9・9 章 9。2026-10-08 村井さん承認「版10はおすすめで」）。
 * 予算を立てないメーカー・前の年度の計画に付ける印。過去の売上だけを取り込み、物差し（BACKTEST）の点を増やすために使う。
 * - 付けるのは所有者だけ: 計画を作るとき（apiOwnerTask の createPlan の purpose）か、後から（setPlanPurpose。監査に前と後の値が残る）。
 *   測る専用は 100 計画まで（APP_MEASURE_PLAN_MAX。保管をやめた計画は数えない。締めた年度の計画は数える＝セルを使うため）。上限を超える作成は断る。
 * - 印の付いた計画は、次の操作を断る: 予算の保存・公式版を出す・手で動かす A-4（費用のため）。週 1 回の自動の AI 調査の候補にもしない（AutoResearch.js）。
 * - 入れないもの: 着地見込みの全計画の学び（τ・w。Portfolio.js）・ホームと分析の合計（Home.js・Insights.js）・年度を締める条件の公式版（V10.js）。
 *   年度の控えには計画の行として入る（YearSnapshot.js がほかの計画と同じく写す）。
 * 計算と保存している数字は変えない（断る操作と、合計への入れ方だけ）。
 */

/** 測る専用の計画で断る、計画への保存・実行（PLAN.EDIT・PLAN.RUN の action）と、その理由（始める前に断る・画面のボタンの説明） */
const APP_MEASURE_REFUSED = {
  'BUDGET.SAVE': 'この計画では予算を設定できません。',
  'AI.RESEARCH': 'この計画では市場調査を実行できません。'
};
const APP_MEASURE_VERSION_REFUSED = 'この計画では公式版を発行できません。';

/** 頼まれた印を、表に書く値にする（空 = 予算を立てる計画・MEASURE = 測る専用）。ほかの値なら止める */
function appPlanPurposeOf_(v) {
  const s = String(v === undefined || v === null ? '' : v).trim().toUpperCase();
  if (s === '' || s === APP_PLAN_MEASURE) return s;
  throw new Error('purpose は "" （予算を立てる計画）か "MEASURE"（測る専用）で入れてください。');
}

/** OWNER_TASK の purpose（省けば予算を立てる計画）を、動かす前に確かめる */
function appPlanPurposeCheck_(t) {
  if (t.purpose !== undefined && typeof t.purpose !== 'string') throw new Error('purpose は "" か "MEASURE" を "" で囲んで入れてください。');
  appPlanPurposeOf_(t.purpose);
}

/** 測る専用の計画の数（保管をやめた計画は数えない）。exceptId の計画は数えない（印を付け直すとき） */
function appMeasureCount_(plans, exceptId) {
  return (plans || []).filter(p => p.plan_id !== exceptId && p.state !== 'ARCHIVED' && appPlanIsMeasure_(p)).length;
}

/** 測る専用の計画をもう 1 つ増やせるか（ロックの中で呼ぶ）。上限なら止める */
function appMeasureRequireRoom_(plans, exceptId) {
  const n = appMeasureCount_(plans, exceptId);
  if (n >= APP_MEASURE_PLAN_MAX) {
    throw new Error('測る専用の計画は ' + APP_MEASURE_PLAN_MAX + ' つまでです（今 ' + n + ' つ）。ほかの計画の印を外してから付けてください。');
  }
}

/** 測る専用の印を付けられる人か（所有者だけ）。付けない（空）ときは確かめない */
function appMeasureRequireOwner_(ctx, purpose) {
  if (purpose === APP_PLAN_MEASURE && !(ctx && ctx.user && ctx.user.isOwner)) throw new Error('測る専用の印は、所有者だけが付けられます。');
}

/**
 * 計画への保存・実行を、測る専用の計画で断るなら、その理由（断らなければ空）。plan は PLANS の行か計画の ID。
 * 始める前（Jobs.js の appStartJob_）と、段ごと（appRunJob_）に確かめる（処理の途中で印が付いても止める）
 */
function appMeasureActionRefusal_(plan, action) {
  const why = APP_MEASURE_REFUSED[String(action || '')];
  if (!why) return '';
  const row = plan && typeof plan === 'object' ? plan : appReadTable_('PLANS').filter(x => x.plan_id === String(plan || ''))[0];
  return row && appPlanIsMeasure_(row) ? why : '';
}

/** 裏の処理（PLAN.EDIT・PLAN.RUN とその続きの段）を、測る専用の計画で断るなら、その理由 */
function appMeasureJobRefusal_(kind, payload) {
  if (!/^PLAN\.(EDIT|RUN)/.test(String(kind || ''))) return '';
  return appMeasureActionRefusal_(payload && payload.planId, payload && payload.action);
}

/** 公式版を出す前に（Versions.js の appVersionSubmit_）: 測る専用の計画なら止める */
function appMeasureRequireBudgetPlan_(plan) {
  if (appPlanIsMeasure_(plan)) throw new Error(APP_MEASURE_VERSION_REFUSED);
}

/** 合計に入れる計画（計画の要点の行。measure の付いた計画を除く。ホーム・分析の合計） */
function appBudgetPlanRows_(rows) {
  return (rows || []).filter(p => !p.measure);
}

/**
 * setPlanPurpose（apiOwnerTask。所有者だけ）: 計画の印を付ける・外す。年度を締めた計画・書きかけの保存があるときは止める。
 * 測る専用にするときは、100 計画の上限と、承認待ちの公式版が無いことを確かめる。同じ印なら書かない。
 * 返り値: { plan: { planId, purpose, rowVersion }, changed, before: { purpose } }（監査の終わりに前と後が残る）
 */
function appSetPlanPurpose_(ctx, input) {
  if (!(ctx && ctx.user && ctx.user.isOwner)) throw new Error('計画の印は、所有者だけが変えられます。');
  const purpose = appPlanPurposeOf_(input && input.purpose);
  return appWithLock_(() => {
    if (appJournalPending_()) throw new Error('データ本体の保存が途中で止まっています。予測の画面の「保存の続きを書く」を先に行ってください。');
    const plan = appRequireOpenPlan_(input && input.planId);   // 締めた年度の計画は変えない
    const before = String(plan.purpose || '');
    const out = r => ({ plan: { planId: r.plan_id, purpose: String(r.purpose || ''), rowVersion: r.row_version }, before: { purpose: before },
      audit: { entityId: plan.plan_id, clientId: plan.client_id } });
    if (before === purpose) return Object.assign(out(plan), { changed: false });
    if (purpose === APP_PLAN_MEASURE) {
      appMeasureRequireRoom_(appReadTable_('PLANS'), plan.plan_id);
      if (appVersionTable_().some(v => v.plan_id === plan.plan_id && v.state === 'SUBMITTED')) {
        throw new Error('承認待ちの公式版があります。承認か却下を済ませてから、測る専用にしてください。');
      }
    }
    const res = appUpdateByKey_('PLANS', { plan_id: plan.plan_id }, { purpose: purpose }, plan.row_version, ctx.actor);
    return Object.assign(out(res.after), { changed: true });
  });
}
