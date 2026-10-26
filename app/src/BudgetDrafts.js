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
 * 下書きの表は追記だけ（ふだんは行を消さず、計画ごとにも入れ替えない。足すのは本体の保存と同じ控え: V10.js の appLogOps_ → 控えの書き方 append）。
 * 画面確認の仮だけ、所有者の操作で印を付け、その印の行だけを消せる（appScreenPlaceholderMark_ / appScreenPlaceholderDelete_）。
 * 消す前に、消す行と OUTPUT の H・I の元の値を SCREEN_HOLD に足す。印の無い行は選ばないので残る。人の MANUAL は消さない。保存や確率の案は止めない。締めた年度の行は書けない。
 * 新しい自動の処理とメールは足さない。保存している予測の数字は変えない。
 */

/** 予算の決め方（画面から渡せるもの。BASELINE は版 11 の移行の写しだけ） */
const APP_BUDGET_BASES = ['CENTER', 'PROB', 'MANUAL'];
/** 画面確認の仮（人の MANUAL ではない。画面からは選べない。この印の行だけを、所有者の操作で消せる） */
const APP_SCREEN_PLACEHOLDER = 'SCREEN_CHECK';
const APP_SCREEN_INPUT_CLIENT = '検証用の仮の動向';
const APP_SCREEN_INPUT_NOTE = '検証用の仮の見解';
const APP_SCREEN_INPUT_SPOT = '検証スポット';
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
  if (a && a.placeholder === true) return { basis: APP_SCREEN_PLACEHOLDER, prob: null, alloc: APP_SCREEN_PLACEHOLDER };
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

/** 画面確認の仮か（SCREEN_CHECK。basis が MANUAL のままの仮も含む） */
function appBudgetPlaceholderRow_(r) {
  if (!r) return false;
  const basis = String(r.basis || '');
  if (basis === APP_SCREEN_PLACEHOLDER) return true;
  return basis === 'MANUAL' && (String(r.action_id || '') === APP_SCREEN_PLACEHOLDER || String(r.alloc || '') === APP_SCREEN_PLACEHOLDER);
}

/** 写し（BASELINE）に、戻せる金額があるか（採用予測が空・数でない月は、人が入れた額ではない） */
function appBudgetBaselineAmount_(r) {
  return !!(r && String(r.basis || '') === 'BASELINE' && appBudgetNum_(r.adopted) !== null);
}

/** 人の側か（手入力・確率・真ん中はこれまでどおり。BASELINE は金額がある月だけ。仮の MANUAL は含めない） */
function appBudgetHumanSide_(r) {
  if (!r || appBudgetPlaceholderRow_(r)) return false;
  const basis = String(r.basis || '');
  if (basis === 'MANUAL' || basis === 'PROB' || basis === 'CENTER') return true;
  return appBudgetBaselineAmount_(r);
}

/** 保存した時刻が新しいか（同じなら表の後ろの行）。人の側どうしはこの順のまま */
function appBudgetByTime_(a, b) {
  if (!b) return true;
  return String(a.saved_at) > String(b.saved_at) || (String(a.saved_at) === String(b.saved_at) && Number(a._row) > Number(b._row));
}

/** 行 a が行 b より新しいか。人の側が相手の仮より新しいことは、時刻では決めない */
function appBudgetNewer_(a, b) {
  if (!b) return true;
  if (appBudgetHumanSide_(a) && appBudgetPlaceholderRow_(b)) return true;
  if (appBudgetPlaceholderRow_(a) && appBudgetHumanSide_(b)) return false;
  return appBudgetByTime_(a, b);
}

/**
 * 同じキーの勝ちの行。人の側（手入力・確率・真ん中・金額のある BASELINE）が 1 行でもあれば仮を先に外し、残りを時刻で選ぶ。
 * 金額の無い BASELINE は、ほかに行がある月では候補にしない（仮の値を空で上書きしない）。行の順では決まらない。人の側が無ければ時刻だけ
 */
function appBudgetPick_(rows) {
  let list = (rows || []).filter(r => r);
  const emptyBase = r => String(r.basis || '') === 'BASELINE' && !appBudgetBaselineAmount_(r);
  if (list.some(r => !emptyBase(r))) list = list.filter(r => !emptyBase(r));
  const keep = list.some(appBudgetHumanSide_) ? list.filter(r => !appBudgetPlaceholderRow_(r)) : list;
  let best = null;
  keep.forEach(r => { if (appBudgetByTime_(r, best)) best = r; });
  return best;
}

/** 月ごとの一番新しい下書き（{ 'yyyy/MM': 行 }） */
function appBudgetLatestDrafts_(planId) {
  const by = {};
  appBudgetDraftRows_(planId).forEach(r => { if (r.ym) (by[r.ym] || (by[r.ym] = [])).push(r); });
  const best = {};
  Object.keys(by).forEach(ym => { best[ym] = appBudgetPick_(by[ym]); });
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
  const by = {};
  rows.forEach(r => { if (r.ym) (by[r.ym] || (by[r.ym] = [])).push(r); });
  const winners = Object.keys(by).map(ym => appBudgetPick_(by[ym])).filter(Boolean);
  const last = appBudgetPick_(winners) || appBudgetPick_(rows);
  const mine = winners.length ? winners : rows.filter(r => r.action_id === last.action_id);
  const sum = (list, k) => list.reduce((s, r) => (typeof r[k] === 'number' && isFinite(r[k]) ? (s === null ? 0 : s) + r[k] : s), null);
  const centerAtDraft = sum(mine, 'center');
  const now = appBudgetStoredMonths_(planId);
  const centerNow = now.length ? sum(now, 'center') : null;
  const drift = centerAtDraft !== null && centerAtDraft > 0 && centerNow !== null ? (centerNow - centerAtDraft) / centerAtDraft : null;
  const run = last.run_id ? appReadTable_('FORECAST_RUNS').filter(r => r.run_id === last.run_id)[0] : null;
  return { basis: last.basis, prob: last.prob, alloc: last.alloc, runId: last.run_id, runAt: run ? run.finished_at : '', savedAt: last.saved_at,
    centerAtDraft: centerAtDraft, centerNow: centerNow, drift: drift, driftLimit: APP_BUDGET_DRIFT_WARN,
    warn: drift !== null && Math.abs(drift) >= APP_BUDGET_DRIFT_WARN, adopted: sum(mine, 'adopted'), uplift: sum(mine, 'uplift'), months: mine.length,
    placeholder: winners.some(appBudgetPlaceholderRow_) };
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
    ['client', { person: person, ym: ym, step: step, reason: APP_SCREEN_PLACEHOLDER + ' ' + APP_SCREEN_INPUT_CLIENT, selfConf: conf }],
    ['opinions', { person: person, ym: ym, step: appDummyPick_(APP_BUDGET_DUMMY_STEPS, index + 3),
      conf: String(0.35 + (Math.abs(index) % 5) * 0.12), note: APP_SCREEN_PLACEHOLDER + ' ' + APP_SCREEN_INPUT_NOTE }],
    ['devspot', { person: person, ym: ym, project: APP_SCREEN_PLACEHOLDER + ' ' + APP_SCREEN_INPUT_SPOT + String((Math.abs(index) % 9) + 1),
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
  return appPlanEdit_(ctx, { planId: planId, action: action, args: args, inputHash: appPlanInputHash_(planId),
    screenPlaceholder: action === 'BUDGET.SAVE' });
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

/** 着地 ÷ 予算が空模様で分かれて見える仮の実績倍率（猛暑〜雨） */
const APP_LANDING_DUMMY_RATES = [1.65, 1.28, 1.08, 0.96, 0.72, 0.38, 1.18, 0.82];

function appDummyCellNum_(cell) {
  if (!cell || String(cell).charAt(0) !== 'n') return null;
  const n = Number(String(cell).slice(1));
  return isFinite(n) ? n : null;
}

function appDummyEnsureOutputMonths_(planId, fy, index) {
  const yms = appLandingFyYms_(fy);
  const all = (appReadPlanTable_('ENG_ROWS', planId) || []).filter(r => r.sheet === 'OUTPUT');
  const byRow = {};
  all.filter(r => Number(r.col_from) === 1).forEach(r => { byRow[Number(r.row_no)] = r; });
  let changed = false;
  const budgetWrites = [];
  const next = all.map(r => Object.assign({}, r));
  const put = (rowNo, cells) => {
    const i = next.findIndex(r => Number(r.row_no) === rowNo && Number(r.col_from) === 1);
    const row = { plan_id: planId, sheet: 'OUTPUT', row_no: String(rowNo), col_from: '1', cells_json: JSON.stringify(cells) };
    if (i >= 0) next[i] = row; else next.push(row);
  };
  yms.forEach((ym, i) => {
    const rowNo = 29 + i;
    const cur = byRow[rowNo];
    const cells = cur ? JSON.parse(cur.cells_json || '[]').slice() : [];
    while (cells.length < 9) cells.push('e');
    const p50 = appDummyCellNum_(cells[2]);
    const p10 = appDummyCellNum_(cells[1]);
    const p90 = appDummyCellNum_(cells[3]);
    const adopted = appDummyCellNum_(cells[7]);
    const base = p50 !== null ? p50 : 800000 + (Math.abs(index) % 9) * 120000 + i * 15000;
    if (!appBudgetYmOf_(cells[0] ? appCellDecode_(cells[0].charAt(0), cells[0].slice(1)) : '')) {
      cells[0] = 's' + ym;
      changed = true;
    }
    if (p10 === null || p50 === null || p90 === null) {
      cells[1] = 'n' + Math.round(base * 0.85);
      cells[2] = 'n' + Math.round(base);
      cells[3] = 'n' + Math.round(base * 1.18);
      changed = true;
    }
    if (adopted === null) {
      const scale = appDummyPick_(APP_BUDGET_DUMMY_SCALES, index);
      const up = appDummyPick_(APP_BUDGET_DUMMY_UPLIFT, index);
      const ad = Math.round((p50 !== null ? p50 : base) * scale);
      const uplift = Math.round(ad * up);
      cells[7] = 'n' + ad;
      cells[8] = 'n' + uplift;
      changed = true;
      budgetWrites.push({ ym: ym, adopted: ad, uplift: uplift, center: p50 !== null ? p50 : base });
    }
    if (changed || !cur) put(rowNo, cells);
  });
  return { op: changed ? appOpReplacePlan_('ENG_ROWS', planId, ['OUTPUT'], next) : null, budgets: budgetWrites };
}

function appDummyEvalRow_(planId, seq, ym, p10, p50, p90, actual) {
  const header = APP_ENGINE_SHEETS.EVAL_COMPARE_MONTHLY.header;
  const vals = {
    target_month: ym, forecast_total: p50, actual_total: actual, gap_total: actual - p50,
    forecast_total_p10: p10, forecast_total_p50: p50, forecast_total_p90: p90,
    signed_error_p50: actual - p50, abs_error_p50: Math.abs(actual - p50),
    ape_p50: p50 ? Math.abs(actual - p50) / p50 : 0, fy_label: 'FY' + ym.slice(0, 4),
    range_outside_flag: (actual < p10 || actual > p90) ? 1 : 0,
    note_for_investigation: APP_SCREEN_PLACEHOLDER
  };
  const o = { plan_id: planId, seq: String(seq) };
  let types = '';
  header.forEach(h => {
    const v = vals[h];
    if (v === undefined || v === '') { o[h] = ''; types += 'e'; }
    else if (typeof v === 'number') { o[h] = String(v); types += 'n'; }
    else { o[h] = String(v); types += 's'; }
  });
  o._types = types;
  return o;
}

function appDummyStatusRows_(planId, name, atIso) {
  const mk = (seq, key) => ({
    plan_id: planId, seq: String(seq), step_key: key, last_run_date: atIso, last_run_by: '検証担当',
    status: 'success', target_client: name || '', record_count: '6', error_summary: APP_SCREEN_PLACEHOLDER, _types: 'sdsssns'
  });
  const existing = appReadPlanTable_('ENG_PROCESS_STATUS', planId) || [];
  const keep = existing.filter(r => {
    if (r.step_key !== 'step2_status' && r.step_key !== 'step5_status') return true;
    return String(r.error_summary || '') !== APP_SCREEN_PLACEHOLDER && !appScreenLegacyStatus_(r);
  }).map(appStripRow_);
  let n = keep.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 1);
  const add = [];
  ['step2_status', 'step5_status'].forEach(key => {
    if (keep.some(r => r.step_key === key)) return;
    n += 1;
    add.push(mk(n, key));
  });
  return keep.concat(add);
}

function appDummyLandingNeeded_(plan, todayYm) {
  const o = {};
  (appReadPlanTable_('ENG_ROWS', plan.plan_id) || []).filter(r => r.sheet === 'OUTPUT' && Number(r.col_from) === 1)
    .forEach(r => { o[Number(r.row_no)] = JSON.parse(r.cells_json || '[]'); });
  const months = appLandingMonths_(o);
  const steps = appReadPlanTable_('ENG_PROCESS_STATUS', plan.plan_id) || [];
  const cut = appLandingCutoff_(steps);
  const adopted = months.reduce((s, m) => {
    const row = o[29 + appLandingFyYms_(plan.fy).indexOf(m.ym)] || [];
    const a = appDummyCellNum_(row[7]), u = appDummyCellNum_(row[8]);
    return s + (a === null ? 0 : a) + (u === null ? 0 : u);
  }, 0);
  const budget = adopted > 0 ? adopted : null;
  const yt = {};
  (appReadPlanTable_('ENG_EVAL_COMPARE_MONTHLY', plan.plan_id) || []).forEach(r => {
    const ym = appCellYm_(String(r._types || '').charAt(0), r.target_month);
    const n = Number(r.actual_total);
    if (ym) yt[ym] = r.actual_total === '' || r.actual_total === null || !isFinite(n) ? 0 : n;
  });
  const sky = appLandingSky_({ fy: plan.fy, months: months, actual: yt, cutoffYm: cut, todayYm: todayYm, budget: budget,
    pendingCutoffYm: appLandingPendingCutoff_(steps) });
  return sky.landing === null || sky.landingSd === null;
}

function appDummyLandingDraftRows_(plan, budgets, actor, atIso) {
  return (budgets || []).map(m => ({ plan_id: plan.plan_id,
    draft_id: appStableLogId_(APP_BUDGET_DRAFT_PREFIX, [APP_SCREEN_PLACEHOLDER, plan.plan_id, m.ym]), action_id: APP_SCREEN_PLACEHOLDER,
    ym: m.ym, adopted: m.adopted, uplift: m.uplift, basis: APP_SCREEN_PLACEHOLDER, prob: null, alloc: APP_SCREEN_PLACEHOLDER,
    run_id: '', center: m.center, actor_email: actor || '', saved_at: atIso }));
}

function appDummyLandingOps_(plan, fy, index, todayYm, atIso, actor) {
  const ops = [];
  const ensured = appDummyEnsureOutputMonths_(plan.plan_id, fy, index);
  const outOp = ensured.op;
  if (outOp) ops.push(outOp);
  ops.push.apply(ops, appLogOps_('BUDGET_DRAFTS', appDummyLandingDraftRows_(plan, ensured.budgets, actor, atIso)));
  const o = {};
  (appReadPlanTable_('ENG_ROWS', plan.plan_id) || []).filter(r => r.sheet === 'OUTPUT' && Number(r.col_from) === 1)
    .forEach(r => { o[Number(r.row_no)] = JSON.parse(r.cells_json || '[]'); });
  if (outOp) {
    (outOp.rows || []).filter(r => Number(r.col_from) === 1).forEach(r => { o[Number(r.row_no)] = JSON.parse(r.cells_json || '[]'); });
  }
  const months = appLandingMonths_(o);
  const rate = appDummyPick_(APP_LANDING_DUMMY_RATES, index);
  const closed = appLandingFyYms_(fy).filter(ym => ym < todayYm);
  const fresh = closed.map((ym, i) => {
    const m = months.filter(x => x.ym === ym)[0] || {};
    const p50 = m.p50 === null || m.p50 === undefined ? 1000000 : m.p50;
    const p10 = m.p10 === null || m.p10 === undefined ? Math.round(p50 * 0.85) : m.p10;
    const p90 = m.p90 === null || m.p90 === undefined ? Math.round(p50 * 1.18) : m.p90;
    return appDummyEvalRow_(plan.plan_id, i + 2, ym, p10, p50, p90, Math.round(p50 * rate));
  });
  ops.push(appOpReplaceOrAppend_('ENG_EVAL_COMPARE_MONTHLY', plan.plan_id, appDummyMergeEval_(plan.plan_id, fresh)));
  ops.push(appOpReplaceOrAppend_('ENG_PROCESS_STATUS', plan.plan_id, appDummyStatusRows_(plan.plan_id, plan.client_label, atIso)));
  return ops;
}

/** 仮実績は、印の無い同じ月の行を残す（本物の実績は消さない。印の付いた仮だけ入れ替える） */
function appDummyMergeEval_(planId, evalRows) {
  const existing = (appReadPlanTable_('ENG_EVAL_COMPARE_MONTHLY', planId) || []).map(appStripRow_);
  const have = {};
  existing.forEach(r => {
    if (String(r.note_for_investigation || '') === APP_SCREEN_PLACEHOLDER) return;
    if (String(r.target_month || '')) have[String(r.target_month)] = true;
  });
  const kept = existing.filter(r => String(r.note_for_investigation || '') !== APP_SCREEN_PLACEHOLDER);
  let n = kept.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 1);
  const add = [];
  (evalRows || []).forEach(r => {
    if (have[String(r.target_month || '')]) return;
    n += 1;
    add.push(Object.assign({}, r, { seq: String(n) }));
  });
  return kept.concat(add);
}

/**
 * 画面確認用に、着地の推定が出る欠けるデータを仮で埋める（所有者。検証用。確定版は触らない）。
 * 月の予測・仮予算が無ければ足す。締まった月の仮実績と B-1/B-2 の成功を書き、実績の遅れで着地が消えないようにする。
 */
function appSeedDummyLanding_(ctx, fy) {
  const y = fy === undefined || fy === null || fy === '' ? appFy_(new Date()) : Number(fy);
  appRequireOpenYear_(y);
  appDummySeedClearSchedule_();
  const today = appToday_();
  const todayYm = appCloseCutoffYm_(today);
  const atIso = today + 'T12:00:00+0900';
  const plans = appReadTable_('PLANS').filter(p => String(p.fy) === String(y) && p.state !== 'ARCHIVED')
    .sort((a, b) => String(a.client_label || '').localeCompare(String(b.client_label || ''), 'ja') || String(a.plan_id).localeCompare(String(b.plan_id)));
  const out = { fy: y, filled: [], skipped: [], failed: [], remaining: [] };
  const t0 = new Date().getTime();
  let stop = false;
  const opsAll = [];
  plans.forEach((p, i) => {
    const item = { planId: p.plan_id, name: p.client_label || '' };
    if (stop) { out.remaining.push(item); return; }
    if (new Date().getTime() - t0 > APP_BUDGET_DUMMY_TIME_MS) { stop = true; out.remaining.push(item); return; }
    try {
      if (!appDummyLandingNeeded_(p, todayYm)) {
        out.skipped.push(Object.assign({ reason: 'done' }, item));
        return;
      }
      const ops = appDummyLandingOps_(p, y, i, todayYm, atIso, ctx.actor).filter(op => op && (op.mode !== 'ensure' || (op.rows && op.rows.length)));
      opsAll.push.apply(opsAll, ops);
      out.filled.push(Object.assign({ did: ['landing'] }, item));
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
  if (opsAll.length) {
    appWithLock_(() => {
      appJournalRun_(ctx, '仮の着地（画面確認）', '', opsAll);
    });
  }
  appDummySeedClearSchedule_();
  return out;
}

// ---- 画面確認の仮を見分ける・印を付ける・仮だけ消す（開いただけでは何も変えない。保存は止めない） ----

function appScreenFy_(fy) {
  if (fy === undefined || fy === null || fy === '') return appFy_(new Date());
  const text = String(fy).trim();
  if (!/^\d{4}$/.test(text)) throw new Error('年度（fy）は 4 桁の数で指定してください。');
  return Number(text);
}

function appScreenReadPlan_(name, planId) {
  try { return appReadPlanTable_(name, planId) || []; }
  catch (e) { if (/表がありません/.test(String(e && e.message || e))) return []; throw e; }
}

function appScreenNum_(v) {
  if (v === '' || v === null || v === undefined || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : null;
}

function appScreenDecodeCell_(cell) {
  if (!cell) return '';
  const t = String(cell).charAt(0);
  if (t === 'e' || t === 'f') return '';
  try { return appCellDecode_(t, String(cell).slice(1)); } catch (e) { return ''; }
}

function appScreenDecodeNum_(cell) {
  return appScreenNum_(appScreenDecodeCell_(cell));
}

/** 仮の文章の先頭が印か（人の文が偶然この印で始まることは、削除の対象にしないための条件にする） */
function appScreenMarkedText_(v) {
  return String(v || '').indexOf(APP_SCREEN_PLACEHOLDER) === 0;
}

function appScreenRetype_(row, header, field) {
  const i = header.indexOf(field);
  if (i < 0) return row;
  const cur = String(row._types || '');
  if (cur.charAt(i) === 's') return row;
  const next = cur.split('');
  while (next.length < header.length) next.push('e');
  next[i] = 's';
  row._types = next.join('');
  return row;
}

function appScreenInputSpec_(kind) {
  if (kind === 'client') return { table: 'ENG_CLIENT', field: 'Reason', header: 'CLIENT' };
  if (kind === 'note') return { table: 'ENG_OPINIONS', field: 'Note', header: 'OPINIONS' };
  if (kind === 'spot') return { table: 'ENG_DEV_SPOT', field: 'Project', header: 'DEV_SPOT' };
  return null;
}

function appScreenInputText_(row, kind) {
  const spec = appScreenInputSpec_(kind);
  return spec ? String(row[spec.field] || '') : '';
}

function appScreenInputMarked_(row, kind) {
  return appScreenMarkedText_(appScreenInputText_(row, kind));
}

/** 印を付ける前の仮入力（文章が完全一致。スポットは名前と金額の組も一致するときだけ） */
function appScreenInputLegacy_(row, kind) {
  const text = appScreenInputText_(row, kind);
  if (!text || appScreenMarkedText_(text)) return false;
  if (kind === 'client') return text === APP_SCREEN_INPUT_CLIENT;
  if (kind === 'note') return text === APP_SCREEN_INPUT_NOTE;
  if (kind === 'spot') {
    const m = /^検証スポット([1-9])$/.exec(text);
    if (!m) return false;
    const n = Number(m[1]);
    const amount = appScreenNum_(row['Amount(JPY)']);
    for (let index = 0; index < 72; index++) {
      if ((index % 9) + 1 !== n) continue;
      if (appBudgetSame_(amount, 180000 + (index % 8) * 70000)) return true;
    }
  }
  return false;
}

/** 旧来の仮の B-1/B-2（検証担当・件数 6・成功・概要が空）。人の実行はメールが残るので対象にしない */
function appScreenLegacyStatus_(row) {
  if (!row || (row.step_key !== 'step2_status' && row.step_key !== 'step5_status')) return false;
  return String(row.last_run_by || '') === '検証担当' && String(row.record_count || '') === '6' &&
    String(row.status || '') === 'success' && String(row.error_summary || '') === '';
}

function appScreenStatusMarked_(row) {
  if (!row || (row.step_key !== 'step2_status' && row.step_key !== 'step5_status')) return false;
  return String(row.error_summary || '') === APP_SCREEN_PLACEHOLDER;
}

function appScreenPairHit_(adopted, uplift, center, scale, rate) {
  if (center === null || adopted === null || uplift === null) return false;
  const ad = Math.round(center * scale);
  return appBudgetSame_(adopted, ad) && appBudgetSame_(uplift, Math.round(ad * rate));
}

/** 1 回の保存が 12 か月そろっていて、どれも手入力の印のままか */
function appScreenManualGroup_(rows) {
  if (!rows || rows.length !== 12) return false;
  const seen = {};
  return rows.every(r => {
    const ym = String(r.ym || '');
    if (String(r.basis || '') !== 'MANUAL' || String(r.alloc || '') !== 'MANUAL') return false;
    if (!/^\d{4}\/\d{2}$/.test(ym) || seen[ym]) return false;
    seen[ym] = true;
    return true;
  });
}

function appScreenGroupMatchesScale_(rows) {
  if (!appScreenManualGroup_(rows)) return false;
  return APP_BUDGET_DUMMY_SCALES.some((scale, i) => rows.every(r => appScreenPairHit_(appScreenNum_(r.adopted), appScreenNum_(r.uplift), appScreenNum_(r.center), scale, APP_BUDGET_DUMMY_UPLIFT[i])));
}

/** 予測が動いていないとき、今の仮予算の式と一致するか（下書きに残した真ん中が、今の真ん中と同じときだけ） */
function appScreenGroupMatchesCurrent_(planId, rows) {
  if (!appScreenManualGroup_(rows)) return false;
  const nums = appPlanNumbers_(planId);
  if (!nums || !nums.monthly || nums.monthly.length !== 12) return false;
  const byYm = {};
  nums.monthly.forEach((m, i) => { byYm[appBudgetYmOf_(m.month)] = { m: m, i: i }; });
  if (!rows.every(r => {
    const hit = byYm[String(r.ym)];
    return hit && appBudgetSame_(appScreenNum_(r.center), hit.m.p50);
  })) return false;
  return APP_BUDGET_DUMMY_SCALES.some((scale, s) => {
    const dummy = appDummyBudgetRows_(planId, scale, APP_BUDGET_DUMMY_UPLIFT[s]);
    if (!dummy || !dummy.rows || dummy.rows.length !== 12) return false;
    return rows.every(r => {
      const hit = byYm[String(r.ym)];
      const d = dummy.rows[hit.i];
      return d && appBudgetSame_(appScreenNum_(r.adopted), d.adopted) && appBudgetSame_(appScreenNum_(r.uplift), d.uplift);
    });
  });
}

/** 下書きが無く、12 か月ぜんぶが同じ仮の倍率に合うときだけ（一部の月だけ似ているものは対象にしない） */
function appScreenOutputMonths_(planId, drafted) {
  const months = appBudgetStoredMonths_(planId);
  if (months.length !== 12) return [];
  const open = months.filter(m => !drafted[m.ym]);
  if (open.length !== 12) return [];
  const hit = APP_BUDGET_DUMMY_SCALES.some((scale, i) => open.every(m => appScreenPairHit_(m.adopted, m.uplift, m.center, scale, APP_BUDGET_DUMMY_UPLIFT[i])));
  return hit ? open.map(m => ({ ym: m.ym, adopted: m.adopted, uplift: m.uplift, center: m.center })) : [];
}

/** 概要が空の実績が、すべて同じ仮の倍率のとき、その行（1 行でも倍率が違えば空） */
function appScreenEvalLegacyRows_(rows) {
  const nums = (rows || []).filter(r => String(r.note_for_investigation || '') === '' && appScreenNum_(r.actual_total) !== null && appScreenNum_(r.forecast_total_p50) !== null);
  if (!nums.length) return [];
  const ok = APP_LANDING_DUMMY_RATES.some(rate => nums.every(r => appBudgetSame_(appScreenNum_(r.actual_total), Math.round(appScreenNum_(r.forecast_total_p50) * rate))));
  return ok ? nums : [];
}

function appScreenScanPlan_(plan) {
  const planId = plan.plan_id;
  const drafts = appScreenReadPlan_('BUDGET_DRAFTS', planId);
  const markedDrafts = drafts.filter(r => String(r.basis || '') === APP_SCREEN_PLACEHOLDER);
  const groups = {};
  drafts.forEach(r => { const id = String(r.action_id || ''); (groups[id] = groups[id] || []).push(r); });
  const client = appScreenReadPlan_('ENG_CLIENT', planId);
  const notes = appScreenReadPlan_('ENG_OPINIONS', planId);
  const spots = appScreenReadPlan_('ENG_DEV_SPOT', planId);
  const pick = (rows, kind, pred) => rows.filter(r => pred(r, kind)).map(r => Object.assign({}, r, { _screenKind: kind }));
  const markedInputs = pick(client, 'client', appScreenInputMarked_).concat(pick(notes, 'note', appScreenInputMarked_), pick(spots, 'spot', appScreenInputMarked_));
  const legacyInputs = pick(client, 'client', appScreenInputLegacy_).concat(pick(notes, 'note', appScreenInputLegacy_), pick(spots, 'spot', appScreenInputLegacy_));
  const status = appScreenReadPlan_('ENG_PROCESS_STATUS', planId);
  const markedStatus = status.filter(appScreenStatusMarked_);
  const legacyStatus = status.filter(appScreenLegacyStatus_);
  const evals = appScreenReadPlan_('ENG_EVAL_COMPARE_MONTHLY', planId);
  const markedEvals = evals.filter(r => String(r.note_for_investigation || '') === APP_SCREEN_PLACEHOLDER);
  const legacyEvals = appScreenEvalLegacyRows_(evals);
  const suspectedDrafts = [];
  Object.keys(groups).forEach(id => {
    const rows = groups[id];
    if (rows.some(r => String(r.basis || '') === APP_SCREEN_PLACEHOLDER)) return;
    if (!appScreenGroupMatchesScale_(rows) && !appScreenGroupMatchesCurrent_(planId, rows)) return;
    suspectedDrafts.push.apply(suspectedDrafts, rows);
  });
  const drafted = {};
  drafts.forEach(r => { if (r.ym) drafted[String(r.ym)] = true; });
  const output = appScreenOutputMonths_(planId, drafted);
  return {
    planId: planId, name: plan.client_label || '',
    marked: { drafts: markedDrafts, inputs: markedInputs, evals: markedEvals, status: markedStatus, outputMonths: [] },
    markable: { drafts: [], inputs: legacyInputs, evals: [], status: legacyStatus, outputMonths: [] },
    suspected: { drafts: suspectedDrafts, inputs: [], evals: legacyEvals, status: [], outputMonths: output }
  };
}

function appScreenPlans_(fy) {
  const y = appScreenFy_(fy);
  return appReadTable_('PLANS').filter(p => String(p.fy) === String(y) && p.state !== 'ARCHIVED');
}

function appScreenScan_(fy) {
  return appScreenPlans_(fy).map(appScreenScanPlan_);
}

function appScreenTally_(bag) {
  return { drafts: (bag.drafts || []).length, inputs: (bag.inputs || []).length, evals: (bag.evals || []).length,
    status: (bag.status || []).length, outputMonths: (bag.outputMonths || []).length };
}

function appScreenBagHit_(bag) {
  const t = appScreenTally_(bag);
  return t.drafts + t.inputs + t.evals + t.status + t.outputMonths > 0;
}

function appScreenSummary_(scans) {
  const add = (dst, bag) => {
    const t = appScreenTally_(bag);
    if (!appScreenBagHit_(bag)) return;
    dst.plans += 1;
    dst.drafts += t.drafts; dst.inputs += t.inputs; dst.evals += t.evals; dst.status += t.status; dst.outputMonths += t.outputMonths;
  };
  const blank = () => ({ plans: 0, drafts: 0, inputs: 0, evals: 0, status: 0, outputMonths: 0 });
  const marked = blank(), markable = blank(), suspected = blank();
  (scans || []).forEach(s => { add(marked, s.marked); add(markable, s.markable); add(suspected, s.suspected); });
  return { marked: marked, markable: markable, suspected: suspected };
}

function appScreenPlaceholderPreview_(fy) {
  const y = appScreenFy_(fy);
  return Object.assign({ fy: y }, appScreenSummary_(appScreenScan_(y)));
}

function appScreenAssertBudget_(row) {
  const b = String(row && row.basis || '');
  if (b !== APP_SCREEN_PLACEHOLDER || APP_BUDGET_BASES.indexOf(b) >= 0 || b === 'BASELINE') throw new Error('人の予算は消せません。');
}

function appScreenAssertInput_(row, kind) {
  if (!appScreenInputMarked_(row, kind)) throw new Error('画面確認の印の無い入力は消せません。');
}

function appScreenAssertEval_(row) {
  if (String(row && row.note_for_investigation || '') !== APP_SCREEN_PLACEHOLDER) throw new Error('画面確認の印の無い実績は消せません。');
}

function appScreenAssertStatus_(row) {
  if (!appScreenStatusMarked_(row)) throw new Error('画面確認の印の無い処理状況は消せません。');
}

function appScreenStampInput_(row, kind) {
  const spec = appScreenInputSpec_(kind);
  const copy = appStripRow_(row);
  copy[spec.field] = APP_SCREEN_PLACEHOLDER + ' ' + appScreenInputText_(row, kind);
  return appScreenRetype_(copy, APP_ENGINE_SHEETS[spec.header].header, spec.field);
}

/** 消す直前の控えの表が無ければ作る（版は上げない。初期設定済みの環境でも、消すときにここが作る） */
function appScreenEnsureHold_() {
  appTableSheet_('SCREEN_HOLD', true);
  if (appReadTable_('_SCHEMA').some(r => r.table === 'SCREEN_HOLD')) return;
  appInsertRows_('_SCHEMA', [{ table: 'SCREEN_HOLD', schema_version: APP_SCHEMA_VERSION, columns_hash: appColumnsHash_('SCREEN_HOLD'),
    migrated_at: appNowIso_(), migrated_by: 'SCREEN_HOLD' }]);
}

function appScreenHoldRow_(planId, batchId, fy, table, rowKey, kind, payload, actor, at) {
  return {
    plan_id: planId, hold_id: appStableLogId_('HLD', [batchId, table, planId, rowKey, kind]), batch_id: batchId, fy: String(fy),
    table_name: table, row_key: String(rowKey), kind: kind, payload_json: JSON.stringify(payload), actor_email: actor || '', saved_at: at
  };
}

/**
 * シートの中身を変えたあとの content_hash（計算用ブックの使い回しが、消す前の表を正と見ないようにする）。
 * mutate は、これから書く行を bag.tableRows / bag.segs に反映する。ハッシュは控えに入れる値で、書くときに作り直さない
 */
function appScreenSheetHashOp_(planId, sheet, actor, mutate) {
  const meta = appScreenReadPlan_('ENG_SHEETS', planId).filter(r => r.sheet === sheet)[0];
  if (!meta) return null;
  const bag = {
    tableRows: meta.mode === 'table' ? appScreenReadPlan_('ENG_' + sheet, planId).map(appStripRow_) : [],
    segs: appScreenReadPlan_('ENG_ROWS', planId).filter(r => r.sheet === sheet).map(appStripRow_)
  };
  if (mutate) mutate(bag);
  const fit = Object.assign({}, meta);
  let lastRow = Number(meta.last_row) || 0;
  let lastCol = Number(meta.last_column) || 0;
  bag.tableRows.forEach(r => { if (Number(r.seq) > lastRow) lastRow = Number(r.seq); });
  bag.segs.forEach(seg => {
    if (Number(seg.row_no) > lastRow) lastRow = Number(seg.row_no);
    let n = 0;
    try { n = JSON.parse(seg.cells_json || '[]').length; } catch (e) { n = 0; }
    const col = (Number(seg.col_from) || 1) - 1 + n;
    if (col > lastCol) lastCol = col;
  });
  fit.last_row = String(lastRow);
  fit.last_column = String(lastCol);
  if (lastRow > (Number(meta.max_rows) || 0)) fit.max_rows = String(lastRow);
  if (lastCol > (Number(meta.max_columns) || 0)) fit.max_columns = String(lastCol);
  const fmts = appScreenReadPlan_('ENG_FORMATS', planId).filter(r => r.sheet === sheet);
  let enc;
  try { enc = appEngEncodeSheet_(planId, appEngDecodeSheet_(fit, bag.tableRows, bag.segs, fmts)); }
  catch (e) { throw new Error('「' + sheet + '」のハッシュを作れません。' + (e && e.message ? e.message : e)); }
  const patch = { content_hash: enc.sheetRow.content_hash, updated_at: appNowIso_(), updated_by: actor || '' };
  if (String(fit.last_row) !== String(meta.last_row)) patch.last_row = String(fit.last_row);
  if (String(fit.last_column) !== String(meta.last_column)) patch.last_column = String(fit.last_column);
  if (String(fit.max_rows) !== String(meta.max_rows)) patch.max_rows = String(fit.max_rows);
  if (String(fit.max_columns) !== String(meta.max_columns)) patch.max_columns = String(fit.max_columns);
  if (String(patch.content_hash) === String(meta.content_hash) && !patch.last_row && !patch.last_column && !patch.max_rows && !patch.max_columns) return null;
  return { table: 'ENG_SHEETS', mode: 'patch', planId: planId, key: { plan_id: planId, sheet: sheet }, patch: patch, actor: actor || '' };
}

function appScreenMarkOps_(ctx, scan, ops, counts) {
  const planId = scan.planId;
  const touched = {};
  const stamp = (table, sheet, seq, patch) => {
    ops.push({ table: table, mode: 'patch', planId: planId, key: { plan_id: planId, seq: String(seq) }, patch: patch, actor: ctx.actor });
    (touched[sheet] = touched[sheet] || []).push({ seq: String(seq), patch: patch });
  };
  scan.markable.inputs.forEach(r => {
    const spec = appScreenInputSpec_(r._screenKind);
    const stamped = appScreenStampInput_(r, r._screenKind);
    const patch = {};
    patch[spec.field] = stamped[spec.field];
    patch._types = stamped._types;
    stamp(spec.table, spec.header, r.seq, patch);
    counts.inputs += 1;
  });
  scan.markable.status.forEach(r => {
    const copy = appStripRow_(r);
    copy.error_summary = APP_SCREEN_PLACEHOLDER;
    const stamped = appScreenRetype_(copy, APP_ENGINE_SHEETS.PROCESS_STATUS.header, 'error_summary');
    stamp('ENG_PROCESS_STATUS', 'PROCESS_STATUS', r.seq, { error_summary: stamped.error_summary, _types: stamped._types });
    counts.status += 1;
  });
  Object.keys(touched).forEach(sheet => {
    const op = appScreenSheetHashOp_(planId, sheet, ctx.actor, bag => {
      const by = {};
      touched[sheet].forEach(s => { by[s.seq] = s.patch; });
      bag.tableRows.forEach(row => {
        const patch = by[String(row.seq)];
        if (!patch) return;
        Object.keys(patch).forEach(k => { row[k] = patch[k]; });
      });
    });
    if (op) ops.push(op);
  });
}

/** 印の付いた仮がまだ入っているセルだけ、前の下書きか真ん中へ戻す。戻さないセルの元の値も控えに残す */
function appScreenOutputEdits_(planId, removed, kept) {
  const latest = {}, prev = {};
  removed.forEach(r => { const ym = String(r.ym || ''); if (!latest[ym] || appBudgetNewer_(r, latest[ym])) latest[ym] = r; });
  kept.forEach(r => {
    const ym = String(r.ym || '');
    if (String(r.basis || '') === APP_SCREEN_PLACEHOLDER) return;
    if (!prev[ym] || appBudgetNewer_(r, prev[ym])) prev[ym] = r;
  });
  const edits = [];
  appScreenReadPlan_('ENG_ROWS', planId).forEach(row => {
    if (row.sheet !== 'OUTPUT' || Number(row.col_from) !== 1) return;
    const rowNo = Number(row.row_no);
    if (rowNo < APP_BUDGET_ROW_FIRST || rowNo > APP_BUDGET_ROW_FIRST + 11) return;
    let cells;
    try { cells = JSON.parse(row.cells_json || '[]'); } catch (e) { return; }
    while (cells.length < 9) cells.push('e');
    const ym = appBudgetYmOf_(appScreenDecodeCell_(cells[0]));
    const scr = latest[ym];
    if (!scr) return;
    const hMatch = appBudgetSame_(appScreenDecodeNum_(cells[7]), appScreenNum_(scr.adopted));
    const iMatch = appBudgetSame_(appScreenDecodeNum_(cells[8]), appScreenNum_(scr.uplift));
    if (!hMatch && !iMatch) return;
    const back = prev[ym];
    const p50 = appScreenDecodeNum_(cells[2]);
    const hasBack = back && appScreenNum_(back.adopted) !== null;
    let targetH = null, targetI = null;
    if (hasBack) {
      targetH = 'n' + appScreenNum_(back.adopted);
      const u = appScreenNum_(back.uplift);
      targetI = u === null ? 'e' : 'n' + u;
    } else if (p50 !== null) {
      targetH = 'n' + p50;
      targetI = 'e';
    }
    const copy = cells.slice();
    const wroteH = hMatch && targetH !== null;
    const wroteI = iMatch && targetI !== null;
    if (wroteH) copy[7] = targetH;
    if (wroteI) copy[8] = targetI;
    if (!wroteH && !wroteI) return;
    edits.push({
      row_no: String(row.row_no), col_from: String(row.col_from), ym: ym,
      before: [String(cells[7]), String(cells[8])], wrote: [wroteH, wroteI],
      written: [String(copy[7]), String(copy[8])], cells_json: JSON.stringify(copy)
    });
  });
  return edits;
}

function appScreenDeleteOps_(ctx, scan, ops, holds, counts, batchId, fy, at) {
  const planId = scan.planId;
  const actor = ctx.actor;
  const dropped = {};
  const pushRow = (table, sheet, row, key, rowKey) => {
    holds.push(appScreenHoldRow_(planId, batchId, fy, table, rowKey, 'row', appStripRow_(row), actor, at));
    ops.push({ table: table, mode: 'drop', planId: planId, keys: [key] });
    if (sheet) (dropped[sheet] = dropped[sheet] || []).push(String(row.seq));
  };
  const drafts = appScreenReadPlan_('BUDGET_DRAFTS', planId);
  const drop = drafts.filter(r => String(r.basis || '') === APP_SCREEN_PLACEHOLDER);
  drop.forEach(r => {
    appScreenAssertBudget_(r);
    pushRow('BUDGET_DRAFTS', '', r, { draft_id: r.draft_id }, r.draft_id);
    counts.drafts += 1;
  });
  const kept = drafts.filter(r => String(r.basis || '') !== APP_SCREEN_PLACEHOLDER);
  const edits = drop.length ? appScreenOutputEdits_(planId, drop, kept) : [];
  edits.forEach(e => {
    holds.push(appScreenHoldRow_(planId, batchId, fy, 'ENG_ROWS', e.row_no + ':' + e.col_from, 'output',
      { row_no: e.row_no, col_from: e.col_from, ym: e.ym, before: e.before, wrote: e.wrote, written: e.written }, actor, at));
    ops.push({ table: 'ENG_ROWS', mode: 'patch', planId: planId,
      key: { plan_id: planId, sheet: 'OUTPUT', row_no: e.row_no, col_from: e.col_from },
      patch: { cells_json: e.cells_json }, actor: actor });
    counts.outputMonths += 1;
  });
  [['ENG_CLIENT', 'client', 'CLIENT'], ['ENG_OPINIONS', 'note', 'OPINIONS'], ['ENG_DEV_SPOT', 'spot', 'DEV_SPOT']].forEach(pair => {
    appScreenReadPlan_(pair[0], planId).filter(r => appScreenInputMarked_(r, pair[1])).forEach(r => {
      appScreenAssertInput_(r, pair[1]);
      pushRow(pair[0], pair[2], r, { plan_id: planId, seq: String(r.seq) }, String(r.seq));
      counts.inputs += 1;
    });
  });
  appScreenReadPlan_('ENG_EVAL_COMPARE_MONTHLY', planId).filter(r => String(r.note_for_investigation || '') === APP_SCREEN_PLACEHOLDER).forEach(r => {
    appScreenAssertEval_(r);
    pushRow('ENG_EVAL_COMPARE_MONTHLY', 'EVAL_COMPARE_MONTHLY', r, { plan_id: planId, seq: String(r.seq) }, String(r.seq));
    counts.evals += 1;
  });
  appScreenReadPlan_('ENG_PROCESS_STATUS', planId).filter(appScreenStatusMarked_).forEach(r => {
    appScreenAssertStatus_(r);
    pushRow('ENG_PROCESS_STATUS', 'PROCESS_STATUS', r, { plan_id: planId, seq: String(r.seq) }, String(r.seq));
    counts.status += 1;
  });
  Object.keys(dropped).forEach(sheet => {
    const op = appScreenSheetHashOp_(planId, sheet, actor, bag => {
      const gone = {};
      dropped[sheet].forEach(seq => { gone[seq] = true; });
      bag.tableRows = bag.tableRows.filter(r => !gone[String(r.seq)]);
    });
    if (op) ops.push(op);
  });
  if (edits.length) {
    const op = appScreenSheetHashOp_(planId, 'OUTPUT', actor, bag => {
      const by = {};
      edits.forEach(e => { by[e.row_no + ':' + e.col_from] = e.cells_json; });
      bag.segs.forEach(seg => {
        const next = by[String(seg.row_no) + ':' + String(seg.col_from)];
        if (next) seg.cells_json = next;
      });
    });
    if (op) ops.push(op);
  }
}

function appScreenPlaceholderMark_(ctx, fy) {
  const y = appScreenFy_(fy);
  appRequireOpenYear_(y);
  return appWithLock_(() => {
    appJournalRecover_(ctx);
    const counts = { drafts: 0, inputs: 0, evals: 0, status: 0, outputMonths: 0 };
    const ops = [];
    appScreenScan_(y).forEach(s => appScreenMarkOps_(ctx, s, ops, counts));
    if (ops.length) appJournalRun_(ctx, '画面確認の仮に印', '', ops);
    return { fy: y, marked: counts };
  });
}

function appScreenPlaceholderDelete_(ctx, fy, apply) {
  const y = appScreenFy_(fy);
  if (apply !== true) return Object.assign({ apply: false, deleted: null }, appScreenPlaceholderPreview_(y));
  appRequireOpenYear_(y);
  return appWithLock_(() => {
    appJournalRecover_(ctx);
    const counts = { drafts: 0, inputs: 0, evals: 0, status: 0, outputMonths: 0 };
    const ops = [];
    const holds = [];
    const batchId = appId_('SBK');
    const at = appNowIso_();
    appScreenScan_(y).forEach(s => appScreenDeleteOps_(ctx, s, ops, holds, counts, batchId, y, at));
    const holdOps = holds.length ? appLogOps_('SCREEN_HOLD', holds) : [];
    if (holds.length && !holdOps.length) throw new Error('消す前の控えを置けません。何も消していません。');
    const all = holdOps.concat(ops);
    if (all.length) {
      appScreenEnsureHold_();
      appJournalRun_(ctx, '画面確認の仮を削除', '', all);
    }
    return { fy: y, apply: true, deleted: counts, batchId: all.length ? batchId : '' };
  });
}

/** 控えの行を、表へ戻す書き方にする（すでに同じキーがあれば足さない） */
function appScreenRestoreRowOps_(holds) {
  const by = {};
  holds.forEach(h => {
    let row;
    try { row = JSON.parse(h.payload_json); } catch (e) { throw new Error('消す前の控えが読めません（' + h.hold_id + '）。'); }
    (by[h.table_name] = by[h.table_name] || []).push(row);
  });
  const ops = [];
  Object.keys(by).forEach(table => {
    const def = APP_TABLES[table];
    if (!def) throw new Error('戻す表がありません（' + table + '）。');
    if (def.appendOnly) {
      const add = appLogOps_(table, by[table]);
      if (by[table].length && !add.length) throw new Error('消した行を戻せません（' + table + '）。');
      add.forEach(op => ops.push(op));
    } else ops.push({ table: table, mode: 'ensure', rows: by[table] });
  });
  return { ops: ops, by: by };
}

/** 控えのセルと、今のセルが同じ値か（表記が違っても、空どうし・円の差が無いなら同じ） */
function appScreenHoldCellSame_(a, b) {
  if (String(a) === String(b)) return true;
  const da = appScreenDecodeNum_(a), db = appScreenDecodeNum_(b);
  if (da === null && db === null) return String(appScreenDecodeCell_(a) || '') === '' && String(appScreenDecodeCell_(b) || '') === '';
  return appBudgetSame_(da, db);
}

/**
 * OUTPUT の H・I を、消したときに書いた値のままのセルだけ、消す前の値へ戻す。
 * 今の値が違うセルは飛ばす。返り値 { cells, skipped, changed }
 */
function appScreenRestoreOutput_(cells, payload) {
  const copy = cells.slice();
  const wrote = payload && payload.wrote || [];
  const written = payload && payload.written || [];
  const before = payload && payload.before || [];
  let skipped = 0;
  let changed = false;
  [0, 1].forEach(i => {
    if (!wrote[i]) return;
    const was = written[i];
    const back = before[i];
    const now = copy[7 + i] === undefined ? 'e' : copy[7 + i];
    if (was === undefined || was === null || back === undefined || !appScreenHoldCellSame_(now, was)) { skipped += 1; return; }
    if (!appScreenHoldCellSame_(now, back)) {
      while (copy.length <= 7 + i) copy.push('e');
      copy[7 + i] = String(back);
      changed = true;
    }
  });
  return { cells: copy, skipped: skipped, changed: changed };
}

function appScreenPlaceholderRestore_(ctx, fy, batch) {
  const y = appScreenFy_(fy);
  appRequireOpenYear_(y);
  return appWithLock_(() => {
    appJournalRecover_(ctx);
    let holds = [];
    try { holds = appReadTable_('SCREEN_HOLD').filter(r => String(r.fy) === String(y)); }
    catch (e) { if (!/表がありません/.test(String(e && e.message || e))) throw e; }
    const want = batch ? String(batch) : '';
    if (want) holds = holds.filter(r => r.batch_id === want);
    else {
      let best = '';
      holds.forEach(r => { if (String(r.saved_at) > best) best = String(r.saved_at); });
      const id = (holds.filter(r => String(r.saved_at) === best)[0] || {}).batch_id || '';
      holds = id ? holds.filter(r => r.batch_id === id) : [];
    }
    const batchId = holds.length ? holds[0].batch_id : (want || '');
    if (!holds.length) return { fy: y, batchId: batchId, restored: { rows: 0, outputMonths: 0, skippedCells: 0 } };
    const rows = holds.filter(h => h.kind === 'row');
    const outputs = holds.filter(h => h.kind === 'output');
    const built = appScreenRestoreRowOps_(rows);
    const ops = built.ops.slice();
    const outByPlan = {};
    let skippedCells = 0;
    outputs.forEach(h => {
      let payload;
      try { payload = JSON.parse(h.payload_json); } catch (e) { throw new Error('消す前の控えが読めません（' + h.hold_id + '）。'); }
      (outByPlan[h.plan_id] = outByPlan[h.plan_id] || []).push(payload);
    });
    Object.keys(outByPlan).forEach(planId => {
      const nextByKey = {};
      outByPlan[planId].forEach(p => {
        const row = appScreenReadPlan_('ENG_ROWS', planId).filter(r => r.sheet === 'OUTPUT' && String(r.row_no) === String(p.row_no) && String(r.col_from) === String(p.col_from))[0];
        if (!row || !p.before || p.before.length < 2) { skippedCells += 2; return; }
        let cells;
        try { cells = JSON.parse(row.cells_json || '[]'); } catch (e) { skippedCells += 2; return; }
        const back = appScreenRestoreOutput_(cells, p);
        skippedCells += back.skipped;
        if (!back.changed) return;
        const json = JSON.stringify(back.cells);
        nextByKey[String(p.row_no) + ':' + String(p.col_from)] = json;
        ops.push({ table: 'ENG_ROWS', mode: 'patch', planId: planId,
          key: { plan_id: planId, sheet: 'OUTPUT', row_no: String(row.row_no), col_from: String(row.col_from) },
          patch: { cells_json: json }, actor: ctx.actor });
      });
      const hop = appScreenSheetHashOp_(planId, 'OUTPUT', ctx.actor, bag => {
        bag.segs.forEach(seg => {
          const json = nextByKey[String(seg.row_no) + ':' + String(seg.col_from)];
          if (json) seg.cells_json = json;
        });
      });
      if (hop) ops.push(hop);
    });
    const backBySheet = {};
    rows.forEach(h => {
      if (String(h.table_name || '').indexOf('ENG_') !== 0) return;
      const sheet = h.table_name.slice(4);
      if (!APP_ENGINE_SHEETS[sheet]) return;
      let row;
      try { row = JSON.parse(h.payload_json); } catch (e) { return; }
      const k = h.plan_id + '\u0001' + sheet;
      (backBySheet[k] = backBySheet[k] || []).push(row);
    });
    Object.keys(backBySheet).forEach(k => {
      const planId = k.split('\u0001')[0];
      const sheet = k.split('\u0001')[1];
      const op = appScreenSheetHashOp_(planId, sheet, ctx.actor, bag => {
        const def = APP_TABLES['ENG_' + sheet];
        const keyOf = o => def.key.map(c => String(o[c] === undefined || o[c] === null ? '' : o[c])).join('\u0001');
        const have = {};
        bag.tableRows.forEach(r => { have[keyOf(r)] = true; });
        backBySheet[k].forEach(r => { if (!have[keyOf(r)]) bag.tableRows.push(r); });
      });
      if (op) ops.push(op);
    });
    if (ops.length) appJournalRun_(ctx, '画面確認の仮を戻す', '', ops);
    return { fy: y, batchId: batchId, restored: { rows: rows.length, outputMonths: outputs.length, skippedCells: skippedCells } };
  });
}
