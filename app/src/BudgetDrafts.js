/**
 * BudgetDrafts.js — 予算の下書き（表の版 11。SCHEMA_PLAN_v10-12_JA.md の 4-1・決定 25・26・27。2026-10-09 村井さん承認「推奨する対応を継続」）。
 *
 * 予算（計算用の表 OUTPUT の 29〜40 行: H = 採用予測（約束）・I = 上乗せ（挑戦）・J = 最終予算 = H + I の数式）は、旧来の予測（A-9）が
 * 動くたびに H を月の真ん中（P50）に、I を空に書き直す。そこで、予算の保存のたびに 12 か月分を下書き（BUDGET_DRAFTS）に足し、
 * 予測し直したときは、旧来の計算の後・データ本体へ戻す前に、計算用ブックの H・I を月ごとの一番新しい下書きで書き直す（appBudgetRestoreOnForecast_）。
 *   - 下書きが無い計画は旧来のとおり（月の真ん中のまま = 初期値は中心）。
 *   - そのため、予測し直した後にデータ本体に残る OUTPUT の H・I は、旧来の計算だけの結果と違う（入力のハッシュも変わる）。P10/P50/P90 と乱数の種は変えない
 *     （OUTPUT は種の表に入っていない: Forecast.js の APP_FORECAST_SEED_SHEETS）。
 *   - 下書きは「保存したときの値」をそのまま戻す。決め方が CENTER（真ん中のまま）でも、そのときの真ん中の値に戻る（新しい真ん中には動かない）。
 *     予測が大きく動いたら、計画の画面が知らせる（boot.budgetDraft の drift・warn。APP_BUDGET_DRIFT_WARN）。
 * 確率で選ぶ（決定 25・27）: 着地見込みと同じ分布（Landing.js の appLandingDist_ を使う appLandingReach_ の届く金額。計画の一覧の控え appPlanShadow_ から読む）で、
 *   50・60・70・80% の見込みで届く年間の金額を出し、月へ割り振る（appBudgetProposal_）。画面はそれを、ふつうの予算の保存（BUDGET.SAVE）で
 *   basis = PROB・prob・alloc を添えて保存する。採用予測 = 約束、上乗せ = 挑戦（確率で選ぶのは採用予測だけ。上乗せは変えない）。
 * 下書きの表は追記だけ（行は消さず書き換えない。足すのは本体の保存と同じ控え: V10.js の appLogOps_ → 控えの書き方 append）。締めた年度の行は書けない。
 * 新しい自動の処理とメールは足さない。保存している予測の数字は変えない。
 */

/** 予算の決め方（画面から渡せるもの。BASELINE は版 11 の移行の写しだけ） */
const APP_BUDGET_BASES = ['CENTER', 'PROB', 'MANUAL'];
/** 確率で選べる値（%。90% 以上は出さない: Landing.js の APP_LANDING.REACH と同じ） */
const APP_BUDGET_PROBS = [50, 60, 70, 80];
/** 月への割り振り */
const APP_BUDGET_ALLOCS = ['PAST_SHAPE', 'FORECAST_SHAPE', 'MANUAL'];
/** 下書きの番号の頭（appStableLogId_。予算の保存の番号と月から決まる: 控えを書き直しても二重にならない） */
const APP_BUDGET_DRAFT_PREFIX = 'BDR';
/** 予算の表の月の行（旧来の OUTPUT の混合のセクション。Forecast.js の appStoredHeadline_・Versions.js の appPlanNumbers_ と同じ位置）と列 */
const APP_BUDGET_ROW_FIRST = 29;
const APP_BUDGET_COL_ADOPTED = 8;   // H = 採用予測（I = 上乗せは次の列）
/** 採用予測が真ん中と同じとみなす差（円。1 円未満の違いは同じ） */
const APP_BUDGET_SAME_YEN = 0.5;
/** 下書きを作ったときから、年度の真ん中（月の真ん中の合計）がこれだけ動いたら知らせる（10%。空模様の「晴れのち曇り」「快晴」の境目 0.9・1.1 と同じ幅） */
const APP_BUDGET_DRIFT_WARN = 0.1;
/** 過去の平均の形に使う、まるごとの年度の数の下限（足りなければ予測の月の形で割り振り、そう書く）と、見る年度の数（A-2 が取り込む前の 4 年） */
const APP_BUDGET_SHAPE_MIN_YEARS = 2;
const APP_BUDGET_SHAPE_YEARS = 4;
/** 届く見込みの式の版（PLAN_VERSIONS.prob_basis_json・確率で選んだ案に残す。Landing.js の分布の式を変えたら上げる） */
const APP_BUDGET_PROB_FORMULA = 'LANDING_DIST_V1';

// ---- 共通 ----

/** 予算のセルの値を数にする（空・数でないものは null） */
function appBudgetNum_(v) {
  if (v === '' || v === null || v === undefined || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : null;
}

/** 月の見出し（'yyyy/MM' の文字・日付）を 'yyyy/MM' に（読めなければ ''） */
function appBudgetYmOf_(v) {
  const ym = appYm_(v);
  return /^\d{4}\/\d{2}$/.test(ym) ? ym : '';
}

/** 計算用ブックの OUTPUT 29〜40 行 A を yyyy/MM の文字にする（日付セルだと旧来の予算保存が拒否する） */
function appBudgetCoerceMonthLabels_(book) {
  const sh = book && book.getSheetByName('OUTPUT');
  if (!sh || sh.getLastRow() < APP_BUDGET_ROW_FIRST + 11) return 0;
  let n = 0;
  for (let r = APP_BUDGET_ROW_FIRST; r <= APP_BUDGET_ROW_FIRST + 11; r++) {
    const cell = sh.getRange(r, 1);
    const v = cell.getValue();
    const ym = appBudgetYmOf_(v);
    if (!ym || (!appIsDate_(v) && String(v || '').trim() === ym)) continue;
    cell.setNumberFormat('@');
    cell.setValue(ym);
    n++;
  }
  return n;
}

/** 12 か月がそろい、月が重ならないか */
function appBudgetMonthsOk_(ms) {
  const seen = {};
  return ms.length === 12 && ms.every(m => { if (!m.ym || seen[m.ym]) return false; seen[m.ym] = true; return true; });
}

/** 2 つの金額が同じとみなせるか（どちらかが空なら違う） */
function appBudgetSame_(a, b) {
  return a !== null && b !== null && Math.abs(a - b) <= APP_BUDGET_SAME_YEN;
}

/** 計算用ブックの OUTPUT の 12 か月（[{ ym, center, adopted, uplift }]）。形が読めなければ [] */
function appBudgetBookMonths_(book) {
  const sh = book && book.getSheetByName('OUTPUT');
  if (!sh || sh.getLastRow() < APP_BUDGET_ROW_FIRST + 11) return [];
  const out = sh.getRange(APP_BUDGET_ROW_FIRST, 1, 12, APP_BUDGET_COL_ADOPTED + 1).getValues().map(r => ({
    ym: appBudgetYmOf_(r[0]), center: appBudgetNum_(r[2]), adopted: appBudgetNum_(r[APP_BUDGET_COL_ADOPTED - 1]), uplift: appBudgetNum_(r[APP_BUDGET_COL_ADOPTED]) }));
  return appBudgetMonthsOk_(out) ? out : [];
}

/** データ本体の OUTPUT の 12 か月（appPlanNumbers_ から。[{ ym, center, adopted, uplift }]）。読めなければ [] */
function appBudgetStoredMonths_(planId) {
  const nums = appPlanNumbers_(planId);
  if (!nums) return [];
  const out = nums.monthly.map(m => ({ ym: appBudgetYmOf_(m.month), center: m.p50, adopted: m.adopted, uplift: m.uplift }));
  return appBudgetMonthsOk_(out) ? out : [];
}

/**
 * 予算に手で直した跡があるか（採用予測に数が入っていて月の真ん中と違う・上乗せが空でない月が 1 つでもある）。
 * 採用予測が空の月は跡に数えない（旧来の予測は必ず真ん中を書くので、空は予算の欄の無い前の形。写すと予測し直しても空のまま戻ってしまう）
 */
function appBudgetEdited_(months) {
  return months.some(m => m.uplift !== null || (m.adopted !== null && !appBudgetSame_(m.adopted, m.center)));
}

/** 計画の一番新しい予測の回（FORECAST_RUNS。公式版と同じ選び方。無ければ null） */
function appBudgetLatestRun_(planId) {
  return appReadTable_('FORECAST_RUNS').filter(r => r.plan_id === planId && r.status === 'DONE')
    .sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)) || b._row - a._row)[0] || null;
}

/** 確率で選んだ値を本番として扱うか（決定 4・7 の後。appPlanAlignedLive_ はほかの担当が作る。無い・真でなければ試し） */
function appBudgetProbLive_(plan) {
  try { return typeof appPlanAlignedLive_ === 'function' && appPlanAlignedLive_(plan) === true; } catch (e) { return false; }
}

// ---- 予算の保存（BUDGET.SAVE）: 下書きを足す ----

/**
 * 予算の保存の引数の、下書きの項目を確かめる（旧来の webSaveBudget には rows だけを渡す。Plan.js の APP_PLAN_ACTIONS）。
 * basis = CENTER・PROB・MANUAL（省くと、保存した後の値から決める）、prob = 50・60・70・80（PROB のときは必ず）、
 * alloc = PAST_SHAPE・FORECAST_SHAPE・MANUAL（省くと決め方から決める）。だめな値なら、何も書かずに止める。返り値 { basis, prob, alloc }（省いた項目は '' / null）
 */
function appBudgetDraftArgs_(args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const s = v => (v === undefined || v === null ? '' : String(v).trim().toUpperCase());
  const basis = s(a.basis), alloc = s(a.alloc);
  if (basis && APP_BUDGET_BASES.indexOf(basis) < 0) throw new Error('予算の決め方は「真ん中のまま」「確率で選ぶ」「手で直す」のどれかにしてください。');
  if (alloc && APP_BUDGET_ALLOCS.indexOf(alloc) < 0) throw new Error('月への割り振りは「過去の平均の形」「予測の月の形」「手で直す」のどれかにしてください。');
  return { basis: basis, prob: appBudgetProbOf_(a.prob, basis === 'PROB'), alloc: alloc };
}

/** 確率（50・60・70・80）。空なら null（required なら止める）。ほかの値なら止める */
function appBudgetProbOf_(v, required) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error('確率（50・60・70・80%）を選んでください。');
    return null;
  }
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (APP_BUDGET_PROBS.indexOf(n) < 0) throw new Error('確率は 50・60・70・80% のどれかにしてください。');
  return n;
}

/**
 * 下書きの決め方を、保存した後の 12 か月の値から決める（画面の申告より、保存した値を信じる）:
 *   - 省いた: 採用予測がどの月も真ん中と同じなら CENTER、ほかは MANUAL
 *   - CENTER と申告しても、真ん中と違う月があれば MANUAL（手で直した）
 *   - 確率（prob）は PROB のときだけ残す（ほかの決め方では空）
 *   - 割り振り: CENTER は FORECAST_SHAPE（月の真ん中そのもの）。ほかは申告のまま、省けば PROB は PAST_SHAPE・MANUAL は MANUAL
 */
function appBudgetResolve_(a, months) {
  const isCenter = months.every(m => appBudgetSame_(m.adopted, m.center));
  let basis = a.basis || (isCenter ? 'CENTER' : 'MANUAL');
  if (basis === 'CENTER' && !isCenter) basis = 'MANUAL';
  const prob = basis === 'PROB' ? a.prob : null;
  const alloc = basis === 'CENTER' ? 'FORECAST_SHAPE' : (a.alloc || (basis === 'PROB' ? 'PAST_SHAPE' : 'MANUAL'));
  return { basis: basis, prob: prob, alloc: alloc };
}

/**
 * 予算の保存（Plan.js の appPlanEdit_）で、旧来の webSaveBudget を動かした後の計算用ブックから、12 か月分の下書きの行を作り、
 * 本体と同じ控えに足す書き方（ops）にする。画面が送った行（変えた月だけのこともある）ではなく、保存した後の 12 か月の値を写す。
 * a = appBudgetDraftArgs_ の返り値。center = 保存したときの月の真ん中（P50）、run_id = そのときの一番新しい予測の回。
 * 予算の表の 12 か月が読めなければ、下書きを足さずにエラーのログに残す（保存は止めない）。返り値 { ops, draft: { basis, prob, alloc, months } | null }
 */
function appBudgetDraftOps_(ctx, plan, actionId, book, a) {
  const months = appBudgetBookMonths_(book);
  if (!months.length) {
    appLogError_('BUDGET_DRAFTS.SKIPPED', new Error('予算の表の 12 か月が読めないので、下書きを足しませんでした（' + plan.plan_id + '）。'), ctx);
    return { ops: [], draft: null };
  }
  const r = appBudgetResolve_(a || { basis: '', prob: null, alloc: '' }, months);
  const run = appBudgetLatestRun_(plan.plan_id);
  const now = appNowIso_();
  const rows = months.map(m => ({ plan_id: plan.plan_id, draft_id: appStableLogId_(APP_BUDGET_DRAFT_PREFIX, [actionId, m.ym]), action_id: actionId, ym: m.ym,
    adopted: m.adopted, uplift: m.uplift, basis: r.basis, prob: r.prob, alloc: r.alloc, run_id: run ? run.run_id : '', center: m.center,
    actor_email: ctx.actor, saved_at: now }));
  const ops = appLogOps_('BUDGET_DRAFTS', rows);
  return { ops: ops, draft: ops.length ? { basis: r.basis, prob: r.prob, alloc: r.alloc, months: rows.length } : null };
}

/**
 * 今のデータ本体の予算を BASELINE の下書きにする行（版 11 の移行の写し V11.js と、写す前に予測し直したとき appBudgetRestoreOnForecast_ が使う）。
 * 手で直した跡（appBudgetEdited_）が無い・12 か月が読めない計画は []。番号は計画と月から決まる（2 回動かしても二重にならない）
 */
function appBudgetBaselineRows_(plan, actor) {
  const months = appBudgetStoredMonths_(plan.plan_id);
  if (!months.length || !appBudgetEdited_(months)) return [];
  const run = appBudgetLatestRun_(plan.plan_id);
  const now = appNowIso_();
  return months.map(m => ({ plan_id: plan.plan_id, draft_id: appStableLogId_(APP_BUDGET_DRAFT_PREFIX, ['BASELINE', plan.plan_id, m.ym]), action_id: 'BASELINE',
    ym: m.ym, adopted: m.adopted, uplift: m.uplift, basis: 'BASELINE', prob: null, alloc: '', run_id: run ? run.run_id : '', center: m.center,
    actor_email: actor, saved_at: now }));
}

// ---- 下書きを読む ----

/** 計画の下書きの行（表がまだ無い = 版 11 の移行の前なら []。ほかの読めないときは止める） */
function appBudgetDraftRows_(planId) {
  try { return appReadPlanTable_('BUDGET_DRAFTS', planId); } catch (e) { if (/表がありません/.test(String(e && e.message))) return []; throw e; }
}

/** 行 a が行 b より新しいか（保存した時刻、同じなら表の後ろの行） */
function appBudgetNewer_(a, b) {
  return !b || String(a.saved_at) > String(b.saved_at) || (String(a.saved_at) === String(b.saved_at) && Number(a._row) > Number(b._row));
}

/** 月ごとの一番新しい下書き（{ 'yyyy/MM': 行 }） */
function appBudgetLatestDrafts_(planId) {
  const best = {};
  appBudgetDraftRows_(planId).forEach(r => { if (r.ym && appBudgetNewer_(r, best[r.ym])) best[r.ym] = r; });
  return best;
}

// ---- 予測し直したとき（Forecast.js の appForecastRunSave_）: 下書きを戻す ----

/**
 * 旧来の予測（A-9）の後、データ本体へ戻す前（控えの形にする前）に、計算用ブックの OUTPUT の採用予測（H）と上乗せ（I）を、
 * 月ごとの一番新しい下書きで書き直す（J の数式と年度の合計の SUM はそのまま）。下書きの無い月は旧来のとおり（真ん中・空）。
 * 下書きが 1 行も無く、予測で上書きする前のデータ本体の予算に手で直した跡があれば、それを BASELINE として同じ控えに足してから戻す
 * （版 11 の一度だけの写しより先に予測し直しても、直した予算を失わない。測る専用の計画は写さない）。表の版がそろう前（移行の前・途中）は何もしない（旧来のとおり）。
 * 予算の表の形が読めなければ戻さず、エラーのログに残す（下書きは残るので、次に予測し直したときに戻る）。
 * 返り値 { ops（BASELINE を足す書き方。無ければ []）, restored（戻した月の数）, baseline（足した BASELINE の行の数） }
 */
function appBudgetRestoreOnForecast_(ctx, plan, book) {
  if (!appLogReady_()) return { ops: [], restored: 0, baseline: 0 };
  let latest = appBudgetLatestDrafts_(plan.plan_id);
  let ops = [];
  let baseline = 0;
  if (!Object.keys(latest).length && !appPlanIsMeasure_(plan)) {   // 測る専用の計画は予算を立てないので写さない（一度だけの写しと同じ）
    const base = appBudgetBaselineRows_(plan, APP_V11_BACKFILL_ACTOR);
    if (base.length) ops = appLogOps_('BUDGET_DRAFTS', base);
    if (ops.length) { baseline = base.length; latest = {}; base.forEach(r => { latest[r.ym] = r; }); }
  }
  if (!Object.keys(latest).length) return { ops: ops, restored: 0, baseline: baseline };
  const months = appBudgetBookMonths_(book);
  if (!months.length) {
    appLogError_('BUDGET_DRAFTS.RESTORE', new Error('予測の後の予算の表の 12 か月が読めないので、下書きを戻しませんでした（' + plan.plan_id + '）。'), ctx);
    return { ops: ops, restored: 0, baseline: baseline };
  }
  const sh = book.getSheetByName('OUTPUT');
  const range = sh.getRange(APP_BUDGET_ROW_FIRST, APP_BUDGET_COL_ADOPTED, 12, 2);
  const cur = range.getValues();
  const cell = v => (v === null || v === undefined || v === '' ? '' : Number(v));
  let n = 0;
  const next = months.map((m, i) => {
    const d = latest[m.ym];
    if (!d) return cur[i];
    n++;
    return [cell(d.adopted), cell(d.uplift)];
  });
  if (n) range.setValues(next);
  return { ops: ops, restored: n, baseline: baseline };
}

// ---- 計画の画面（boot.budgetDraft） ----

/**
 * 今の下書き（一番新しい予算の保存 = BASELINE を含む、その 12 行）と、作ったときから予測がどれだけ動いたか。下書きが無ければ null（予算は月の真ん中）。
 * centerAtDraft = 下書きの月の真ん中の合計、centerNow = 今の月の真ん中（データ本体の OUTPUT）の合計、drift = (centerNow − centerAtDraft) ÷ centerAtDraft、
 * warn = |drift| が APP_BUDGET_DRIFT_WARN（10%）以上。runAt = 下書きを作ったときの予測の日時。保存した人は返さない。
 * 動き（drift）は、いつも月の真ん中の合計どうしで測る（2026-10-09。予測し直して月の予測が動いたかを見るもの。下書きの行は、そのときの月の真ん中しか残さず、
 * 見せる年度の中心（本番の計画の年度の途中は着地の推定）は締まった月の実績・日付でも動くので、比べる相手にしない）。
 * そのため画面は、見せる中心が月の合計でない計画（本番の年度の途中・12 か月の実績・本番でない計画）では、これらを「予測の月ごとの中心の合計」と呼び、
 * 予測と予算の画面の「中心」と同じ数とは言わない（UI.html の fcBudDraftLine）
 */
function appBudgetDraftView_(planId) {
  const rows = appBudgetDraftRows_(planId);
  if (!rows.length) return null;
  let last = null;
  rows.forEach(r => { if (appBudgetNewer_(r, last)) last = r; });
  const mine = rows.filter(r => r.action_id === last.action_id);
  const sum = (list, k) => list.reduce((s, r) => (typeof r[k] === 'number' && isFinite(r[k]) ? (s === null ? 0 : s) + r[k] : s), null);
  const centerAtDraft = sum(mine, 'center');
  const now = appBudgetStoredMonths_(planId);
  const centerNow = now.length ? sum(now, 'center') : null;
  const drift = centerAtDraft !== null && centerAtDraft > 0 && centerNow !== null ? (centerNow - centerAtDraft) / centerAtDraft : null;
  const run = last.run_id ? appReadTable_('FORECAST_RUNS').filter(r => r.run_id === last.run_id)[0] : null;
  return { basis: last.basis, prob: last.prob, alloc: last.alloc, runId: last.run_id, runAt: run ? run.finished_at : '', savedAt: last.saved_at,
    centerAtDraft: centerAtDraft, centerNow: centerNow, drift: drift, driftLimit: APP_BUDGET_DRIFT_WARN,
    warn: drift !== null && Math.abs(drift) >= APP_BUDGET_DRIFT_WARN, adopted: sum(mine, 'adopted'), uplift: sum(mine, 'uplift'), months: mine.length };
}

// ---- 確率で選ぶ（apiBudgetProposal。決定 25・27） ----

/**
 * 過去の売上の月が締まっているか（ym → 真偽の関数。過去の平均の形の「まるごとの年度」に使う。2026-10-09）。いちばん厳しい読み方で、次のすべてを満たす月だけ:
 *   a) 今日の境目より前（appCloseCutoffYm_(今日)。月末から 5 日たった月。着地見込みの締まった月と同じ決まり。いつでも分かる）
 *   b) 取り込んだときの境目より前（SALES_INPUT の source_updated_at の一番新しい日時 = A-2 の取り込みの日時。取り込みは表を丸ごと書き直すので、
 *      どの行も同じ日時。取り込んだ後に締まった月の売上は、取り込み直すまで足りないまま。行の無い 0 円の月もこれで見る）。日時が読めなければ見ない
 *   c) その月の行の status に、closed でない印（open など）が無い（A-2 が月ごとに付ける締まりの印。空の印は見ない）
 * rows = SALES_INPUT の行（appEngAll_ の形。サービスの種類は問わない）
 */
function appBudgetSalesClosed_(rows) {
  const todayCut = appCloseCutoffYm_(appToday_());
  const open = {};
  let importMs = null;
  (rows || []).forEach(r => {
    const ym = appBudgetYmOf_(r.target_month);
    const s = String(r.status === undefined || r.status === null ? '' : r.status).trim().toLowerCase();
    if (ym && s && s !== 'closed') open[ym] = true;
    const v = r.source_updated_at;
    const ms = appIsDate_(v) ? v.getTime() : appLandingTime_('', v);
    if (ms !== null && isFinite(ms) && (importMs === null || ms > importMs)) importMs = ms;
  });
  const importCut = importMs !== null ? appLandingDayCutoff_(importMs) : '';
  return ym => !!todayCut && ym < todayCut && (!importCut || ym < importCut) && !open[ym];
}

/**
 * 過去の平均の形（PAST_SHAPE）: 計画が持つ過去の売上（SALES_INPUT。A-2 が取り込む、計画の年度の前の 4 年。BASE・SPOT の行。旧来の A-3 と同じ見分け方）の、
 * まるごとの年度ごとの月の割合（4 月〜翌 3 月）の平均。まるごとの年度 = 次の 3 つがそろう年度:
 *   1) 12 か月とも締まっている（appBudgetSalesClosed_。A-2 は計画の年度の前月（fy/03）まで取り込むので、来年度の計画を今の年度の途中に作ると、
 *      今の年度の残りの月は 0 円のまま入っている。それを数えると、割り振りがもう売上のある月に寄るため。2026-10-09）
 *   2) 最初に売上のある月が、その年度の 4 月以前（取引が始まる前の 0 円の月を含まない）
 *   3) 合計が 0 より大きい
 * 月の売上が負なら 0 として割合を出す（戻りで割り振りが負にならないように）。行の無い月は 0 円。
 * 返り値 { years: 使った年度の数, fys: [年度], shares: [12 か月の割合] | null }（APP_BUDGET_SHAPE_MIN_YEARS に足りなければ shares は null）
 */
function appBudgetPastShape_(plan) {
  const rows = appEngAll_('SALES_INPUT', [plan.plan_id], true)[plan.plan_id] || [];
  const closed = appBudgetSalesClosed_(rows);
  const byYm = {};
  let first = '';
  rows.forEach(r => {
    const t = String(r.service_type === undefined || r.service_type === null ? '' : r.service_type).trim();
    if (t !== 'BASE' && t !== 'SPOT') return;
    const ym = appBudgetYmOf_(r.target_month);
    const a = appBudgetNum_(r.input_amount);
    if (!ym || a === null) return;
    byYm[ym] = (byYm[ym] || 0) + a;
    if (a !== 0 && (!first || ym < first)) first = ym;
  });
  const fy = Number(plan.fy);
  const years = [];
  for (let y = fy - APP_BUDGET_SHAPE_YEARS; y < fy; y++) {
    const yms = appLandingFyYms_(y);
    if (!yms.every(closed)) continue;   // 終わっていない（締まっていない月がある）年度は数えない
    if (!first || yms[0] < first) continue;
    const v = yms.map(ym => Math.max(0, byYm[ym] || 0));
    const tot = v.reduce((s, x) => s + x, 0);
    if (!(tot > 0)) continue;
    years.push({ fy: y, shares: v.map(x => x / tot) });
  }
  const shares = years.length >= APP_BUDGET_SHAPE_MIN_YEARS
    ? Array.from({ length: 12 }, (_, i) => years.reduce((s, y) => s + y.shares[i], 0) / years.length) : null;
  return { years: years.length, fys: years.map(y => y.fy), shares: shares };
}

/** 締まった月の実績（{ 'yyyy/MM': 円 }。着地見込みと同じ検証の表 EVAL_COMPARE_MONTHLY の実績。行の無い・空の月は 0 円） */
function appBudgetClosedActuals_(planId, yms) {
  const got = {};
  (appEngAll_('EVAL_COMPARE_MONTHLY', [planId], true)[planId] || []).forEach(r => {
    const ym = appBudgetYmOf_(r.target_month);
    const a = appBudgetNum_(r.actual_total);
    if (ym && a !== null) got[ym] = a;
  });
  const out = {};
  yms.forEach(ym => { out[ym] = got[ym] || 0; });
  return out;
}

/**
 * 確率で選ぶ予算の案（読むだけ。書かない）。input: { planId, prob（50・60・70・80）, alloc（PAST_SHAPE 既定・FORECAST_SHAPE） }。
 * annual = その確率で届く年間の金額（予算に届く見込みの届く金額 = max(締まった月の実績の合計, 着地 − z・幅)。appPlanShadow_ の reach.amounts。円に丸める）。
 * 年度の途中（締まった月が k か月）: 締まった月の採用予測は実績のまま（確率の計算に入れない。着地見込みと同じ）、annual − 締まった月の実績の合計を
 * 残りの月に割り振る。割り振りの重み: PAST_SHAPE = 過去の平均の形の残りの月の分（まるごとの年度が足りなければ予測の月の形にし、そう書く）・
 * FORECAST_SHAPE = 今の予測の月の真ん中（負は 0）。重みが全部 0 なら等分。月は円に丸め、端数は重みの一番大きい月に入れる（月の合計 = annual）。
 * 着地見込みが無い（実績の遅れ・予測が無い）・年度が終わったときは annual = null・months = [] で、理由を basisText に書く。
 * 返り値 { planId, prob, annual, months: [{ ym, adopted, closed }], alloc（使った割り振り）, basisText, ok, mode（SHADOW 試し・LIVE）,
 *          closedMonths, actualClosed, center（今の月の真ん中の合計）, shapeYears, fallback（過去の平均の形から予測の月の形に替えた） }
 */
function appBudgetProposal_(input) {
  const prob = appBudgetProbOf_(input && input.prob, true);
  const want = String(input && input.alloc || 'PAST_SHAPE').trim().toUpperCase();
  if (want !== 'PAST_SHAPE' && want !== 'FORECAST_SHAPE') throw new Error('月への割り振りは「過去の平均の形」か「予測の月の形」にしてください。');
  const plan = appPlanOf_(input && input.planId);
  if (appPlanIsMeasure_(plan)) throw new Error(APP_MEASURE_REFUSED['BUDGET.SAVE']);
  const live = appBudgetProbLive_(plan);
  const trial = live ? '' : '試しの計算です。';
  const months = appBudgetStoredMonths_(plan.plan_id);
  const center = months.length ? months.reduce((s, m) => s + (m.center === null ? 0 : m.center), 0) : null;
  const out = { planId: plan.plan_id, prob: prob, annual: null, months: [], alloc: want, basisText: '', ok: false, mode: live ? 'LIVE' : 'SHADOW',
    closedMonths: null, actualClosed: null, center: center, shapeYears: 0, fallback: false };
  const shadow = appPlanShadow_(plan.plan_id);
  const rc = shadow && shadow.reach;
  if (!months.length || !rc) {
    out.basisText = '着地見込みがまだ出ていないので、確率からは選べません（予測と実績の取り込みの後に使えます）。';
    return out;
  }
  if (rc.done) {
    out.basisText = '年度が終わったので、確率からは選べません。';
    return out;
  }
  const amt = (rc.amounts || []).filter(a => a.pct === prob)[0];
  if (!amt || !isFinite(amt.amount)) {
    out.basisText = '着地見込みがまだ出ていないので、確率からは選べません（予測と実績の取り込みの後に使えます）。';
    return out;
  }
  // 月は年度の順（4 月〜翌 3 月）。予算の表の月が計画の年度の 12 か月とそろわなければ選べない
  const fyYms = appLandingFyYms_(plan.fy);
  const byYm = {};
  months.forEach(m => { byYm[m.ym] = m; });
  if (!fyYms.every(ym => byYm[ym])) {
    out.basisText = '予算の表の月が年度の 12 か月とそろわないので、確率からは選べません。';
    return out;
  }
  const k = Math.max(0, Math.min(12, Math.floor(Number(rc.k) || 0)));
  const closedYms = fyYms.slice(0, k);
  const act = k ? appBudgetClosedActuals_(plan.plan_id, closedYms) : {};
  const closedAdopted = closedYms.map(ym => Math.round(act[ym]));
  const closedSum = closedAdopted.reduce((s, x) => s + x, 0);
  const annual = Math.max(closedSum, Math.round(amt.amount));
  const open = fyYms.slice(k).map(ym => byYm[ym]);
  // 重み
  let alloc = want, fallback = false, shapeYears = 0;
  let wts = null;
  if (want === 'PAST_SHAPE') {
    const ps = appBudgetPastShape_(plan);
    shapeYears = ps.years;
    if (ps.shares) {
      wts = fyYms.slice(k).map(ym => ps.shares[fyYms.indexOf(ym)]);
      if (!(wts.reduce((s, x) => s + x, 0) > 0)) wts = null;
    }
    if (!wts) { alloc = 'FORECAST_SHAPE'; fallback = true; }
  }
  if (!wts) wts = open.map(m => Math.max(0, m.center === null ? 0 : m.center));
  let W = wts.reduce((s, x) => s + x, 0);
  if (!(W > 0)) { wts = open.map(() => 1); W = open.length; }
  const rest = annual - closedSum;
  const openAdopted = wts.map(x => Math.round(rest * x / W));
  if (open.length) {
    let big = 0;
    wts.forEach((x, i) => { if (x > wts[big]) big = i; });
    openAdopted[big] += rest - openAdopted.reduce((s, x) => s + x, 0);
  }
  out.annual = annual;
  out.months = closedYms.map((ym, i) => ({ ym: ym, adopted: closedAdopted[i], closed: true }))
    .concat(open.map((m, i) => ({ ym: m.ym, adopted: openAdopted[i], closed: false })));
  out.alloc = alloc;
  out.ok = true;
  out.closedMonths = k;
  out.actualClosed = closedSum;
  out.shapeYears = shapeYears;
  out.fallback = fallback;
  const how = alloc === 'PAST_SHAPE' ? '月へは、過去 ' + shapeYears + ' 年の売上の月の形の平均で割り振りました。'
    : fallback ? '過去の売上が ' + APP_BUDGET_SHAPE_MIN_YEARS + ' 年分そろわないので、予測の月の形で割り振りました。' : '月へは、予測の月の形で割り振りました。';
  out.basisText = trial + prob + '% の見込みで届く年間の金額です（着地見込みと同じ計算）。' +
    (k ? '締まった ' + k + ' か月は実績のまま、残りの ' + (12 - k) + ' か月に割り振りました。' : '') + how + '上乗せはそのままです。';
  return out;
}

/** 仮の人間補正の幅（画面確認用。計画ごとに変えて予実の分布が分かれて見えるようにする） */
const APP_BUDGET_DUMMY_SCALES = [0.62, 0.82, 0.92, 1.0, 1.08, 1.22, 1.55, 2.1];
const APP_BUDGET_DUMMY_UPLIFT = [0.02, 0.05, 0.08, 0.12, 0, 0.03, 0.15, 0.06];
const APP_BUDGET_DUMMY_STEPS = ['-10', '-5', '-2', '0', '5', '8', '10', '-8'];
const APP_BUDGET_DUMMY_CONF = ['高い', 'ふつう', '低い'];
/** 仮予算の一括書き込みで、次の計画に進むのをやめる残り時間（ミリ秒。1 計画の保存が途中で切れないように） */
const APP_BUDGET_DUMMY_TIME_MS = 4 * 60 * 1000;

function appDummyPick_(arr, i) {
  return arr[Math.abs(Number(i) || 0) % arr.length];
}

function appDummyYm_(fy, i) {
  const m = 4 + (Math.abs(Number(i) || 0) % 12);
  const y = m > 12 ? Number(fy) + 1 : Number(fy);
  const mm = m > 12 ? m - 12 : m;
  return y + '-' + String(mm).padStart(2, '0');
}

function appDummyPerson_(plan) {
  const csv = String((plan && plan.people_csv) || '').split(/[,、，]/).map(s => s.trim()).filter(Boolean);
  if (csv.length) return csv[0];
  try {
    const m = appReadTable_('MEMBERS').filter(r => r.is_active !== false && String(r.display_name || '').trim())[0];
    if (m) return String(m.display_name).trim();
  } catch (e) { /* 名簿が無いときは下の仮の名前 */ }
  return '検証担当';
}

/** 予算保存が書ける月見出しか（OUTPUT 29〜40 行の A が yyyy/MM。日付セルも月として読む） */
function appDummyOutputWritable_(planId) {
  const rows = {};
  try {
    appReadPlanTable_('ENG_ROWS', planId).filter(r => r.sheet === 'OUTPUT' && Number(r.col_from) === 1)
      .forEach(s => { rows[Number(s.row_no)] = JSON.parse(s.cells_json); });
  } catch (e) { return false; }
  for (let r = 29; r <= 40; r++) {
    const x = (rows[r] || [])[0];
    if (!x) return false;
    const t = x.charAt(0);
    const v = t === 'f' ? '' : appCellDecode_(t, x.slice(1));
    if (!appBudgetYmOf_(v)) return false;
  }
  return true;
}

function appDummyKindRows_(planId, kind) {
  const sheet = { client: 'CLIENT', opinions: 'OPINIONS', devspot: 'DEV_SPOT', product: 'PRODUCT' }[kind];
  if (!sheet) return [];
  try { return appReadPlanTable_('ENG_' + sheet, planId) || []; } catch (e) { return []; }
}

/** 動向・見解・スポットが無ければ 1 行ずつ（予算のあとでも足す。画面確認用） */
function appDummySeedInputs_(ctx, plan, fy, index, item) {
  const person = appDummyPerson_(plan);
  const ym = appDummyYm_(fy, index);
  const step = appDummyPick_(APP_BUDGET_DUMMY_STEPS, index);
  const conf = appDummyPick_(APP_BUDGET_DUMMY_CONF, index);
  const kinds = [
    ['client', { person: person, ym: ym, step: step, reason: '検証用の仮の動向', selfConf: conf }],
    ['opinions', { person: person, ym: ym, step: appDummyPick_(APP_BUDGET_DUMMY_STEPS, index + 3),
      conf: String(0.35 + (Math.abs(index) % 5) * 0.12), note: '検証用の仮の見解' }],
    ['devspot', { person: person, ym: ym, project: '検証スポット' + String((Math.abs(index) % 9) + 1),
      amount: 180000 + (Math.abs(index) % 8) * 70000, conf: String(0.4 + (Math.abs(index) % 4) * 0.15) }]
  ];
  kinds.forEach(pair => {
    if (appDummyKindRows_(plan.plan_id, pair[0]).length) return;
    try {
      appDummySeedEdit_(ctx, plan.plan_id, 'INPUT.SAVE', { kind: pair[0], fromRows: true, rows: [pair[1]] });
      item.did.push(pair[0]);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if (!/シートがありません/.test(msg)) throw e;
      Logger.log('仮入力を飛ばす: ' + pair[0] + ' ' + msg);
    }
  });
}

/**
 * 月ごとの仮予算の行（AI の月次予測があればそれ、無ければ月の真ん中。scale で予算の大きさを変える）。
 * 予測の月が 12 そろわなければ null。usedAi: 月次予測を使ったか
 */
function appDummyBudgetRows_(planId, scale, upliftRate) {
  const nums = appPlanNumbers_(planId);
  if (!nums || !nums.monthly || nums.monthly.length !== 12) return null;
  if (nums.monthly.every(m => m.p50 === null && m.adopted === null)) return null;
  let points = null;
  try {
    const plan = appPlanOf_(planId);
    const latest = appBudgetLatestRun_(planId);
    const planning = latest ? appForecastPlanningOf_(latest.planning_json, plan.fy, latest.annual_p50) : null;
    if (planning && planning.months && planning.months.length === 12) {
      points = planning.months.map(m => m && typeof m.point === 'number' && isFinite(m.point) ? m.point : null);
      if (points.some(v => v === null)) points = null;
    }
  } catch (e) {
    Logger.log('仮予算の月次予測: ' + (e && e.message ? e.message : e));
  }
  const s = (scale === undefined || scale === null || !isFinite(Number(scale))) ? 1 : Number(scale);
  const u = (upliftRate === undefined || upliftRate === null || !isFinite(Number(upliftRate))) ? 0.05 : Number(upliftRate);
  const rows = nums.monthly.map((m, i) => {
    const base = points && points[i] !== null ? points[i] : m.p50;
    const adopted = base === null ? 0 : Math.round(base * s);
    return { row: 29 + i, adopted: adopted, uplift: Math.round(adopted * u) };
  });
  return { rows: rows, usedAi: !!points };
}

function appDummySeedEdit_(ctx, planId, action, args) {
  return appPlanEdit_(ctx, { planId: planId, action: action, args: args, inputHash: appPlanInputHash_(planId) });
}

/** 1 計画へ、画面確認用の仮の担当者・予算・人間入力を書く（確定版は触らない。予測の月が無ければ予算だけ飛ばす） */
function appSeedDummyOne_(ctx, plan, fy, index) {
  const item = { planId: plan.plan_id, name: plan.client_label || '', did: [] };
  let p = plan;
  if (appPlanIsMeasure_(p)) {
    appSetPlanPurpose_(ctx, { planId: p.plan_id, purpose: '' });
    p = appReadTable_('PLANS').filter(x => x.plan_id === p.plan_id)[0] || p;
    item.did.push('purpose');
  }
  const vers = appVersionRows_(p.plan_id);
  if (vers.some(v => v.state === 'APPROVED')) return { skipped: Object.assign({ reason: 'official' }, item) };
  if (!String(p.people_csv || '').trim()) {
    appDummySeedEdit_(ctx, p.plan_id, 'SETUP.PEOPLE', { peopleCsv: appDummyPerson_(p) });
    p = appReadTable_('PLANS').filter(x => x.plan_id === p.plan_id)[0] || p;
    item.did.push('people');
  }
  const months = appBudgetStoredMonths_(p.plan_id);
  let usedAi = false;
  if (!months.length) {
    appDummySeedInputs_(ctx, p, fy, index, item);
    return { skipped: Object.assign({ reason: 'no_forecast' }, item) };
  }
  if (!appBudgetEdited_(months)) {
    if (!appDummyOutputWritable_(p.plan_id)) {
      appDummySeedInputs_(ctx, p, fy, index, item);
      return { skipped: Object.assign({ reason: 'no_output' }, item) };
    }
    const dummy = appDummyBudgetRows_(p.plan_id, appDummyPick_(APP_BUDGET_DUMMY_SCALES, index), appDummyPick_(APP_BUDGET_DUMMY_UPLIFT, index));
    if (!dummy) {
      appDummySeedInputs_(ctx, p, fy, index, item);
      return { skipped: Object.assign({ reason: 'no_forecast' }, item) };
    }
    try {
      appDummySeedEdit_(ctx, p.plan_id, 'BUDGET.SAVE', { rows: dummy.rows, basis: 'MANUAL', alloc: 'MANUAL' });
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if (/有効な月次行/.test(msg)) {
        appDummySeedInputs_(ctx, p, fy, index, item);
        return { skipped: Object.assign({ reason: 'no_output' }, item) };
      }
      throw e;
    }
    item.did.push('budget');
    usedAi = dummy.usedAi;
  }
  appDummySeedInputs_(ctx, p, fy, index, item);
  if (item.did.indexOf('budget') >= 0) return { filled: Object.assign({ usedAi: usedAi }, item) };
  if (!item.did.length) return { skipped: Object.assign({ reason: 'done' }, item) };
  return { filled: Object.assign({ skippedBudget: 'edited' }, item) };
}

/** 以前入れた apiOwnerTask の時間予約が残っていれば消す（手動実行と重ならないように） */
function appDummySeedClearSchedule_() {
  try {
    (ScriptApp.getProjectTriggers() || []).forEach(t => {
      try {
        if (t.getHandlerFunction() === 'apiOwnerTask') ScriptApp.deleteTrigger(t);
      } catch (e) { /* 残っても次で消す */ }
    });
  } catch (e) { /* テストや権限の無いときは何もしない */ }
}

/**
 * 今の年度（または fy）の計画を、画面確認用の「予算策定した状態」にする（所有者。検証用。確定版は触らない）。
 * 測る専用の印は外す。担当者が無ければ仮の名前。人間入力が無ければ動向・見解・スポットを 1 行ずつ。
 * 予測の月があれば先に仮予算（日付の月見出しも書く。AI の月次予測があればそれ）、そのあと仮入力。時間切れなら remaining に残し、OWNER_TASK を残す（手動でもう一度実行する。自動予約はしない）。
 */
function appSeedDummyBudgets_(ctx, fy) {
  const y = fy === undefined || fy === null || fy === '' ? appFy_(new Date()) : Number(fy);
  appRequireOpenYear_(y);
  appDummySeedClearSchedule_();
  let plans = appReadTable_('PLANS').filter(p => String(p.fy) === String(y) && p.state !== 'ARCHIVED')
    .sort((a, b) => String(a.client_label || '').localeCompare(String(b.client_label || ''), 'ja') || String(a.plan_id).localeCompare(String(b.plan_id)));
  const out = { fy: y, filled: [], skipped: [], failed: [], remaining: [] };
  const t0 = new Date().getTime();
  let stop = false;
  plans.forEach((p, i) => {
    const item = { planId: p.plan_id, name: p.client_label || '' };
    if (stop) { out.remaining.push(item); return; }
    if (new Date().getTime() - t0 > APP_BUDGET_DUMMY_TIME_MS) { stop = true; out.remaining.push(item); return; }
    try {
      const r = appSeedDummyOne_(ctx, p, y, i);
      if (r.filled) out.filled.push(r.filled);
      else if (r.skipped) out.skipped.push(r.skipped);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if (/ロックのタイムアウト|サービス エラー/.test(msg)) {
        stop = true;
        out.remaining.push(Object.assign({ error: msg.slice(0, 160) }, item));
        return;
      }
      out.failed.push(Object.assign({ error: msg.slice(0, 160) }, item));
    }
  });
  appDummySeedClearSchedule_();
  return out;
}
