/**
 * Home.js — ホームのダッシュボード（最重要のことだけ）。よみのセリフは画面がこの材料から選ぶ。
 * 数字と計画の状態は、データ本体が変わらない間は控えから返す（appCachedRead_）。バックアップの状態は、バックアップしたときに残した要点を読む。
 * 空模様（霧の判定・前提の変化の日数）は今日の日付で変わるので、計画の要点とホームの控えは日ごとに分ける。
 */

/**
 * 全部の計画の要点と、着地見込みの τ・w（承認して使っている値と、全計画から学んだ試しの値）。appPortfolioData_ の返り値。
 * データ本体が変わらない間（その日のうち）は控えから（業務の設定を書いても控えは変わる。書くとデータ本体の版の印が変わるため）。
 * 控えの鍵は前の形（計画の並びだけ）の 'PORTFOLIO' と分ける（アプリの版を上げずに公開しても、前の形の控えを読まない）
 */
function appPortfolioAll_() {
  return appCachedRead_('PORTFOLIO_ALL\u0001' + appToday_(), () => appPortfolioData_());
}

/** 全部の計画の要点（計画の一覧と同じもの）。データ本体が変わらない間（その日のうち）は控えから */
function appPortfolioCached_() {
  return appPortfolioAll_().plans;
}

/** その人のホーム（数字・計画の状態・着地見込みと空模様・見せる年度の合計・承認待ち）＋ 管理者には仕組みの状態 */
/** 選べる年度: 今の年度の前後 2 年（5 つ。古い順）。ホームの年度のプルダウン */
const APP_HOME_FY_SPAN = 2;
function appHomeFyOptions_() {
  const t = Number(appFy_(new Date()));
  const out = [];
  for (let y = t - APP_HOME_FY_SPAN; y <= t + APP_HOME_FY_SPAN; y++) out.push(String(y));
  return out;
}

function appHome_(ctx, fyAsked) {
  // 頼まれた年度は、選べる年度のうちのどれかだけ（ほかは既定の年度にする）
  const ask = String(fyAsked || '');
  const fy = appHomeFyOptions_().indexOf(ask) >= 0 ? ask : '';
  const out = appCachedRead_('HOME\u0001' + ctx.actor + '\u0001' + appToday_() + '\u0001' + fy, () => appHomeData_(ctx, fy));
  if (appHasRole_(ctx.roles, 'ADMIN')) out.system = appHomeSystem_();
  out.at = appNowIso_();
  return out;
}

function appHomeData_(ctx, fyAsked) {
  const all = appPortfolioAll_();
  const plans = all.plans;
  // 見せる年度: 選んだ年度。選んでいなければ、今の年度の計画があればそれ、無ければ一番新しい年度（予算を立てる計画があれば、それだけで決める。測る専用の計画は前の年度が多い）
  const thisFy = String(appFy_(new Date()));
  const budgeted = appBudgetPlanRows_(plans);
  const pick = budgeted.length ? budgeted : plans;
  const fy = fyAsked || (pick.some(p => String(p.fy) === thisFy) ? thisFy : pick.reduce((m, p) => (m === null || String(p.fy) > m ? String(p.fy) : m), null) || thisFy);
  const planRows = appReadTable_('PLANS');
  const clientOf = {};
  planRows.forEach(p => { clientOf[p.plan_id] = p.client_id; });
  const names = {};
  plans.forEach(p => { names[p.planId] = { clientName: p.clientName, fy: p.fy }; });
  // 承認待ち（承認できる人には「確認の依頼」、出した人には「待っている」）
  const approvals = [];
  const mine = [];
  appVersionTable_().filter(v => v.state === 'SUBMITTED' && names[v.plan_id]).forEach(v => {
    const o = { planId: v.plan_id, clientName: names[v.plan_id].clientName, fy: names[v.plan_id].fy, versionNo: v.version_no, budgetFinal: v.budget_final,
      submittedBy: String(v.submitted_by || '').split('@')[0], submittedAt: v.submitted_at };
    if (v.submitted_by === ctx.actor) mine.push(o);
    if ((v.submitted_by !== ctx.actor || ctx.user.isOwner) && appHasRole_(ctx.roles, 'APPROVER', clientOf[v.plan_id])) approvals.push(o);
  });
  return {
    fy: fy, thisFy: thisFy, fyOptions: appHomeFyOptions_(),
    plans: plans.map(p => ({ planId: p.planId, clientName: p.clientName, fy: String(p.fy), p10: p.p10, p50: p.p50, p90: p.p90, prevP50: p.prevP50, budget: p.budget, mape: p.mape,
      mapeMonths: p.mapeMonths, runs: p.runs, lastRunAt: p.lastRunAt, stepErrors: p.stepErrors, stepsDone: p.stepsDone, stepsTotal: p.stepsTotal,
      officialNo: p.officialNo, officialFinal: p.officialFinal, pendingNo: p.pendingNo,
      actualYtd: p.actualYtd, actualMonths: p.actualMonths, forecastYtd: p.forecastYtd, rangeOut: p.rangeOut, rangeN: p.rangeN,
      landing: p.landing, landingSd: p.landingSd, landingP10: p.landingP10, landingP90: p.landingP90, pAbove: p.pAbove, ratio: p.ratio,
      sky: p.sky, skyReason: p.skyReason, skyDir: p.skyDir, theta: p.theta, credibility: p.credibility, k: p.k, budgetUsed: p.budgetUsed, budgetSource: p.budgetSource,
      scoredMonths: p.scoredMonths, frozen: p.frozen, measure: !!p.measure,
      // 年度の見込みの本番（判断 10・24。2026-10-09）: 本番の計画の p10・p50・p90 は見せる年度の値（計画の一覧と同じ。annualShown: 中心と幅は同じ分布から。
      // 年度の途中は着地の推定）。旧来の年度合計は legacyAnnual
      alignedLive: !!p.alignedLive, annualBand: p.annualBand || '', legacyAnnual: p.legacyAnnual || null, annualShown: p.annualShown || null })),
    totals: appHomeTotals_(plans, fy, all.prior && all.prior.used),
    approvals: approvals, mine: mine
  };
}

/**
 * 見せる年度の合計（測る専用の計画 measure は入れない。版 10 の 3-9）。予算は空模様と同じ budgetUsed（承認済みの公式版の最終予算、無ければ今の予算）。
 * 着地見込みの無い計画（実績の取り込みの遅れ。空模様が霧（予算が無い）・雪でも同じ。予測が無い など）は、着地の合計にも着地 ÷ 予算にも入れない。入れた計画の数も返す
 * reach は、着地と予算の両方がある計画の合計の予算に届く見込み（試し。メーカーどうしが独立なら / 全部同じ向きなら。appLandingReachTotal_ に
 * 使っている τ・w を足したもの。判断 24）。used = appLandingApproved_ の返り値（省けば τ・w は入れない）。
 * reach.live = 入れた計画がどれも年度の見込みを本番にした計画（alignedLive。2026-10-09）。画面は「（試し）」を外す
 * 返り値: { plans, budget, budgetPlans, actualYtd, landing, landingPlans, ratio（着地と予算の両方がある計画だけで）, ratioPlans, reach（両方がある計画があるときだけ） }
 */
function appHomeTotals_(plans, fy, used) {
  const rows = appBudgetPlanRows_(plans).filter(p => String(p.fy) === String(fy));
  const num = v => typeof v === 'number' && isFinite(v);
  const sum = (xs, k) => xs.reduce((s, p) => (num(p[k]) ? (s || 0) + p[k] : s), null);
  const budgeted = rows.filter(p => num(p.budgetUsed) && p.budgetUsed > 0);
  const landed = rows.filter(p => num(p.landing));
  const both = budgeted.filter(p => num(p.landing));
  const bb = sum(both, 'budgetUsed');
  const out = { plans: rows.length, budget: sum(budgeted, 'budgetUsed'), budgetPlans: budgeted.length, actualYtd: sum(rows, 'actualYtd'),
    landing: sum(landed, 'landing'), landingPlans: landed.length, ratio: bb ? sum(both, 'landing') / bb : null, ratioPlans: both.length };
  const reach = appLandingReachTotal_(both.map(p => ({ landing: p.landing, sd: p.landingSd, budget: p.budgetUsed })));
  if (reach) reach.live = both.every(p => !!p.alignedLive);
  if (reach) out.reach = used ? Object.assign(reach, { tau: used.tau, w: used.w, tauSet: !!used.tauSet, wSet: !!used.wSet }) : reach;   // 着地と予算の両方がある計画が無ければ項目ごと無い
  return out;
}

/** 仕組みの状態（管理者）。バックアップは、バックアップしたときに残した要点を読む（ドライブを数えない。Backup.js の appBackupStatusFast_）。手入れは印に止まったか（stalled）を足す */
function appHomeSystem_() {
  let backup = null;
  try { backup = appBackupStatusFast_(); } catch (e) { backup = { error: String(e && e.message || e) }; }
  let backupAuto = null;   // 毎日のバックアップのトリガーが無いときだけ: 自動で作る仕組みの状態（Backup.js。画面が文を選ぶ）
  try { if (backup && backup.enabled === false) backupAuto = appBackupAutoStatus_(); } catch (e) { backupAuto = null; }
  let journal = null;
  try { journal = appJournalPending_(); } catch (e) { journal = null; }
  let autoResearch = null;   // 自動の AI 調査（AutoResearch.js）
  try { autoResearch = appAutoResearchStatus_(); } catch (e) { autoResearch = { error: String(e && e.message || e) }; }
  let bulk = null;   // 全部の計画をまとめて動かした結果のうち、まだ片付いていない計画（Bulk.js）
  try { bulk = appBulkHome_(); } catch (e) { bulk = null; }
  return { backup: backup, backupAuto: backupAuto, housekeeping: appHousekeepingStatus_(), journal: journal, autoResearch: autoResearch, bulk: bulk };
}
