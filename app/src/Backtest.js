/**
 * Backtest.js — 物差し（表の版 10 の 3-7・決定 9 (b)。2026-10-08 村井さん承認「版10はおすすめで」）。
 * 過去の区切り（年度の初めの 4 月）に戻って予測し直し、単純な方法・本番の予測と並べて、締まった月の実績で採点する点を BACKTEST に足す。
 * 1 回 = 12 か月 × 11 方法 = 132 行（追記だけ。予測の数字・OUTPUT・ENG_*・FORECAST_*・PLAN_VERSIONS は変えない）。記録は計算に使わない。
 * 比べる時点は 2 つ（2026-10-13 村井さん承認。時点の違う予測を比べると、情報の差だけで外れの差が出る）:
 *   区切りの「今」（4/1）に 1〜12 か月先を予測したもの（horizon = 1〜12）
 *     STAT_ONLY … 旧来の A-9（runForecastFYCore_）の統計の部分だけを、同じ順で呼ぶ（人の入力・AI・補正・既知のスポットを入れない）。
 *                 旧来の関数は LegacyEngine.js の入口（build-engine.mjs の ENGINE_EXPORTS）から呼ぶ。中身は 1 文字も変えない
 *     LAST_YEAR … 前年同月の売上（ベース + スポット）
 *     TWO_YEAR  … 前の 2 年の同じ月の売上の平均
 *     SEASONAL  … 旧来の季節加重（forecastSeasonalWeighted48_。OUTPUT の Seasonal Weighted Total と同じ式。既知のスポットは入れない）
 *     どれも区切りの「今」に締まっていた月（月末から 5 日たった月。D5）の売上だけを使う。4/1 には 3 月はまだ締まっていない
 *     （4/5 以降に取り込む）ので、3 月の売上は無いものとして予測する（appBacktestClosed_。統計だけは旧来の「今」を 3 月の終わりの日に置き、
 *     3 月を締まっていない月として補う。appBacktestStatAsOf_）。前年同月・2 年平均で、使う月が締まっていなければ予測は空
 *   各月が始まる前の最後の本番の予測の時点（horizon = その回から何か月先か。多くは 1）
 *     LIVE           … 本番の、その月が始まる前の最後の予測（FORECAST_RUNS・FORECAST_MONTHLY）。その年度に学んだ補正と更新した入力が入る
 *     LAST_YEAR_PACE … 同じ時点の単純な方法: 前年同月 × （その時点で締まっていた年度の月の実績 ÷ 前年の同じ月々の売上）。締まった年度の月が
 *                      無ければ前年同月のまま。本番の回が無い月は空
 *   統計だけは 4/1 の単純な方法と、本番は同じ時点の単純な方法と比べる（統計だけと本番は比べない）。
 * 乱数の種は、売上と CONFIG の中身・区切り・計画の地域・旧来の計算の版から決める（同じ中身なら同じ数字。appBacktestSeed_）。
 * 実績は締まった月だけ（実績の取り込み B-1 の日に、月末から 5 日たった月。D5）。締まっていない月は空。
 * 本物の月（real_months）: 区切りの前 48 か月のうち、最初に売上があった月から後で、売上の取り込み（A-2）の日に締まっていた月
 * （取引が始まる前の 0 円は本物と数えない。9 章 5 のおすすめ）。点として数える（counted）のは、本物の月が 48・実績が締まった・予測がある点だけ。
 * 動かすのは所有者だけ（apiOwnerTask の runBacktest → 裏の処理 MEASURE.BACKTEST。組み立て → 計算と保存。組み立てが 6 分に収まらなければ続きに分ける）。
 * 分析の画面には、年度の計画ごとに、その年度の初めを区切りにした今の数え方の回のうち一番新しい回の点だけを方法ごとにまとめて出す（appBacktestCard_。
 * 点の数と 95% の幅を必ず添える。95% の幅は、同じ計画の月どうしはつながっているので、点を独立とみなさず、メーカーごとに平均してから
 * メーカーの数の t 分布で出す（appBacktestClusterMean_。1 社だけなら幅を出さず「差を言えない」。点が 30 より少なければ「まだ判断できません」）。
 * 前の年度を区切りにした回（cutoffFy）は、計画が持つ売上が年度の前の 48 か月だけなので数えられる点が無く、まとめには入れない
 * （数えていない回の数だけ olderRuns に出す）。前の数え方（calc_version が今と違う）の回も入れない（oldCalcRuns）。
 */

/**
 * 物差しの版（数え方を変えたら上げて、新しい行を足す）。BT-2（2026-10-13）: 区切りの時点で締まった月だけを使う・本番と同じ時点の単純な方法
 * （LAST_YEAR_PACE）を足す・本番の horizon を本当の何か月先にする。前の版の回はまとめに入れない（行は消さない）
 */
const APP_BACKTEST_CALC_VERSION = 'BT-4';   // BT-4（2026-10-17）: 履歴による年間水準の統計予測・0 円月と負の実績も WAPE の分子に含め、分母は実績の絶対値
/** 組み立てる計算用のシート（統計の部分が読むものだけ） */
const APP_BACKTEST_SHEETS = ['CONFIG', 'SALES_INPUT', 'SALES_MONTHLY'];
/** 方法（記録の順。画面は比べる組で並べ直す）。単純な方法は p50 だけ */
const APP_BACKTEST_METHODS = ['STAT_ONLY', 'LIVE', 'LAST_YEAR', 'TWO_YEAR', 'SEASONAL', 'LAST_YEAR_PACE', 'LINEAR', 'RECENT', 'ROBUST', 'SIM', 'TRI'];
// 後ろの 5 つは、素の回帰との比べ（Methods.js。2026-10-15 村井さん承認）の手法を、同じ 4/1 の統計の部分から出したもの（乱数は使わない）。
// BT-3 から統計だけ（STAT_ONLY）は三角測量の土台（本番の A-9 と同じ）。SIM はシミュレーションの中心（線形回帰 ×（1 + 残差の中央値）+ 背景のスポット）。
// 物差しのカードには出さず、分析の「素の回帰との比べ」に出す
const APP_BACKTEST_SIMPLE = ['LAST_YEAR', 'TWO_YEAR', 'SEASONAL'];   // 区切りの「今」（4/1）の単純な方法（統計だけと比べる。外れ幅のいちばん小さいもの）
const APP_BACKTEST_SIMPLE_LIVE = 'LAST_YEAR_PACE';                    // 本番と同じ時点の単純な方法（本番と比べる）
const APP_BACKTEST_WINDOW = 48;          // 区切りの前の月の数（旧来の A-9 の 48 か月）
const APP_BACKTEST_BACK_YEARS = 3;       // 区切りは計画の年度から 3 年前まで（実績の取り込み B-1 が持つ範囲）
const APP_BACKTEST_MIN_POINTS = 30;      // 比べてよい点の数（これより少なければ「まだ判断できません」）
const APP_BACKTEST_MIN_MAKERS = 2;       // 比べてよいメーカーの数（1 社だけでは言わない。幅も出さない）

// ---- 区切りと種 ----

/** 区切りの年度（省くと計画の年度）。計画の年度から 3 年前まで */
function appBacktestCutoffFy_(plan, fy) {
  const own = Number(plan.fy);
  const v = fy === undefined || fy === null || fy === '' ? own : Number(fy);
  if (!Number.isInteger(v) || v > own || v < own - APP_BACKTEST_BACK_YEARS) {
    throw new Error('区切りの年度は、計画の年度（FY' + own + '）から ' + APP_BACKTEST_BACK_YEARS + ' 年前までにしてください。');
  }
  return v;
}

/** 'yyyy/MM' に k か月を足す */
function appBacktestYmAdd_(ym, k) {
  const m = /^(\d{4})\/(\d{2})$/.exec(String(ym || ''));
  const n = Number(m[1]) * 12 + Number(m[2]) - 1 + k;
  return Math.floor(n / 12) + '/' + ('0' + (n % 12 + 1)).slice(-2);
}

/** 「今」: 区切りの月の 1 日の正午（日本の時刻。どの時差の日付で読んでも区切りの月） */
function appBacktestAsOf_(cutoffYm) {
  return appMonthStartMs_(cutoffYm) + 12 * 3600e3;
}

/**
 * 区切りの「今」に締まっていた月（前の 48 か月の窓。[true = 締まっていた]。D5: 月末から 5 日たった月。appActualClosed_）。
 * 4/1 なら 2 月まで（3 月は 4/5 に締まる）
 */
function appBacktestClosed_(cutoffYm) {
  const day = Utilities.formatDate(new Date(appBacktestAsOf_(cutoffYm)), APP_TZ, 'yyyy-MM-dd');
  const start = appBacktestYmAdd_(cutoffYm, -APP_BACKTEST_WINDOW);
  return Array.from({ length: APP_BACKTEST_WINDOW }, (_, k) => appActualClosed_(appBacktestYmAdd_(start, k), day));
}

/**
 * 統計だけを動かす旧来の「今」。旧来の計算は「今」の前の月までを締まった月とみなす（getLastClosedMonthStart_・getForecastContext_）ので、
 * 区切りの「今」に締まっていない月（4/1 の 3 月）があれば、最後に締まっていた月の次の月の終わりの日の正午（日本の時刻。3/31）に置く
 * （その月は締まっていない月として、旧来の補い方で補う）。全部締まっていれば区切りの「今」
 */
function appBacktestStatAsOf_(cutoffYm, closed) {
  const last = (closed || []).lastIndexOf(true);
  const asOf = appBacktestAsOf_(cutoffYm);
  if (!closed || last === closed.length - 1) return asOf;
  const open = appBacktestYmAdd_(cutoffYm, -APP_BACKTEST_WINDOW + last + 1);   // 最後に締まっていた月の次の月
  return Math.min(asOf, appMonthStartMs_(appBacktestYmAdd_(open, 1)) - 12 * 3600e3);
}

/** 'yyyy/MM' の from から to まで何か月か（to − from） */
function appBacktestMonthsBetween_(fromYm, toYm) {
  const n = ym => { const m = /^(\d{4})\/(\d{2})$/.exec(String(ym || '')); return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null; };
  const a = n(fromYm), b = n(toYm);
  return a === null || b === null ? null : b - a;
}

/** 種が見る中身: 統計の部分が読む表（CONFIG・SALES_INPUT）の中身のハッシュ。SALES_MONTHLY は SALES_INPUT から作り直す */
function appBacktestInputHash_(planId) {
  const rows = appReadPlanTable_('ENG_SHEETS', planId).filter(r => r.sheet === 'CONFIG' || r.sheet === 'SALES_INPUT')
    .map(r => r.sheet + ':' + r.content_hash).sort();
  return appSha256Hex_(rows.join('|'));
}

/** 物差しの種（64 桁の 16 進）: 中身・区切り・計画の地域・旧来の計算の版と中身のハッシュ・物差しの版から。同じなら同じ数字 */
function appBacktestSeed_(plan, inputHash, cutoffYm, engine) {
  return appSha256Hex_(['backtest-seed-v1', inputHash, cutoffYm, plan.time_zone || '', plan.locale || '',
    engine && engine.version || '', engine && engine.sourceSha256 || '', APP_BACKTEST_CALC_VERSION].join('|'));
}

// ---- 統計だけ（STAT_ONLY）----

/**
 * 計算用ブック book（CONFIG・SALES_INPUT・SALES_MONTHLY を組み立てたもの）の上で、統計だけの 12 か月を作る。
 * opts: { fy（区切りの年度）, asOfMs（旧来の「今」）, closed（省ける。48 か月の窓の [締まっていたか]。締まっていない月の売上は 0 円 = まだ分からない
 * として読む。appBacktestClosed_）, seed（文字か、旧来の計算の版 { version, sourceSha256 } から種を作る関数）, uuidSeed, actor }。
 * 返り値: { p10, p50, p90, seasonal（12 か月）, total48（窓の 48 か月の売上 = ベース + スポット。締まっていない月も、取り込んだままの値）, seed, engine }
 */
function appBacktestStatRun_(book, opts) {
  const svc = appLegacyServices_(book, { asOfMs: opts.asOfMs, seed: 'backtest', uuidSeed: opts.uuidSeed || 'backtest', actor: opts.actor || '' });
  // 包んだ関数を作るだけ（乱数は使わない）。版から種を決めてから、乱数を固定して動かす（appRunLegacyForecast_ と同じ）
  const eng = appLegacyEngine_(svc);
  const engine = { version: eng.VERSION, sourceSha256: eng.SOURCE_SHA256 };
  const seed = String(typeof opts.seed === 'function' ? opts.seed(engine) : opts.seed);
  return appWithSeededRandom_(seed, () => Object.assign(appBacktestStatCore_(eng, book, Number(opts.fy), opts.asOfMs, opts.closed, !!opts.skipSync, !!opts.light), { seed: seed, engine: engine }));
}

/**
 * 旧来の runForecastFYCore_ の統計の部分を、同じ順で呼ぶ（乱数を使うのは混合のシミュレーションだけ。同じ種なら同じ並び）。
 * 人の入力（製品・メーカー全体・見解・既知のスポット）・AI・補正（CALIBRATION_STATE の値・学んだ偏り・AI のアシスト）・情報源の信頼度は入れない。
 * 売上の表は runPhase1Forecast と同じく SALES_INPUT から作り直す（syncSalesFromSalesInput_）。
 * closed（省ける）の締まっていない月の売上は、読んだ後に 0 円にする（その時点では分からない。旧来の「今」をその月に置けば、旧来の計算が
 * 締まっていない月として補う。SALES_MONTHLY のその月を 0 円にして本番の A-9 を動かすのと同じ）。
 * skipSync = true なら売上の表を作り直さない（本番の予測の直後に、旧来の予測が作り直した表をそのまま読む。計算用ブックを書き換えない。Methods.js）。
 * light = true なら混合のシミュレーション（1000 回）と季節加重を省く（手法の記録は土台の式と背景のスポットだけを使う。予測の計算の段の時間を縮める。
 * p10・p50・p90・seasonal は null の並び）
 */
function appBacktestStatCore_(eng, book, fy, asOfMs, closed, skipSync, light) {
  const cfg = book.getSheetByName(eng.SHEETS.CONFIG);
  const client = eng.normalizeClientName_(String(cfg ? cfg.getRange('B2').getValue() || '' : '').trim());
  if (!client) throw new Error('計画の CONFIG にメーカーがありません。');
  if (!skipSync) eng.syncSalesFromSalesInput_(fy, client);
  const salesData = eng.readSales48Months_(book.getSheetByName(eng.SHEETS.SALES_MONTHLY));
  const rawTotal48 = (salesData.baseSeries48 || []).map((v, i) => Number(v || 0) + Number((salesData.spotSeries48 || [])[i] || 0));
  if (closed) {
    // 製品ごとの並びと BASE・SPOT の並び（同じ配列のこともある）の、締まっていない月を 0 円に
    [].concat(salesData.monthlyByProduct || [], [salesData.baseSeries48 || [], salesData.spotSeries48 || []])
      .forEach(arr => closed.forEach((ok, k) => { if (!ok && k < arr.length) arr[k] = 0; }));
  }
  const tuning = eng.readModelTuningFromConfig_();
  const tuningApplied = eng.applyCalibrationToTuning_(tuning, eng.createDefaultCalibrationState_(client));   // 補正は入れない（既定の状態）
  const ctx = eng.getForecastContext_(fy, new Date(asOfMs), salesData.headerMonths || []);
  if (!salesData.isComplete48) throw new Error('売上の表が 48 か月そろっていません。');   // 本番は確かめの画面を出す（裏の処理では止まる）
  const aggYRaw = salesData.baseSeries48 && salesData.baseSeries48.length ? salesData.baseSeries48.slice() : eng.sumAcrossProducts_(salesData.monthlyByProduct);
  const seriesStart = salesData.headerMonths && salesData.headerMonths.length ? salesData.headerMonths[0] : new Date(fy - 4, 3, 1);
  const aggYAdj = eng.adjustForUnclosedMonths_(aggYRaw, seriesStart).series.slice();
  const smoothY = aggYAdj.slice();
  const model = eng.fitOpsModelTrendSeason_(smoothY);
  const residualPct = eng.buildResidualPool_(smoothY, model, seriesStart, ctx.lastClosedMonthStart);
  const q = { p10: eng.percentile_(residualPct, 0.10), p50: eng.percentile_(residualPct, 0.50), p90: eng.percentile_(residualPct, 0.90) };
  const months = ctx.forecastMonths;
  const closedSet = new Set(ctx.closedForecastMonthOffsets || []);
  const sourceByMonth = months.map((_, i) => (closedSet.has(i) ? 'actual_closed' : 'forecast_open'));
  const dlmModeRaw = eng.readDlmEngineMode_();
  let dlm = null;
  if (dlmModeRaw !== 'off') {
    try { dlm = eng.computeDlmFyForecast_(salesData.baseSeries48, seriesStart, ctx.lastClosedMonthStart, ctx.forecastMonths, tuning); }
    catch (e) { dlm = { ready: false, reason: String((e && e.message) || e) }; }
  }
  const dlmPrimary = dlmModeRaw === 'primary' && !!(dlm && dlm.ready);
  const spotCapBasis = eng.readDlmPrimarySpotCapBasis_();
  const known = new Array(12).fill(0);   // 既知のスポット（人の入力）は入れない
  // 三角測量（段 2。2026-10-15）: 本番の A-9 と同じ決まりで土台を作る（重みは計算に渡された AppTriangulation。物差しは渡さないので初めの重み）
  const tri = (!dlmPrimary && eng.readTriangulationEnabled_()) ? eng.buildTriangulationBase_(smoothY, model, q.p50, eng.readTriangulationWeights_(client)) : null;
  if (tri) model.triBase = tri.base;
  const baseOnlyP50 = eng.forecastByResidualQuantiles_(model, new Array(12).fill(0), q).p50;
  let baseForSpotCap = baseOnlyP50.slice();
  if (spotCapBasis === 'dlm' && dlmPrimary && dlm && dlm.ready) {
    baseForSpotCap = baseOnlyP50.map((ols, i) => { const d = dlm.p50[i]; return d === null || d === undefined ? ols : Math.max(0, Number(d)); });
  }
  const spotBgModel = eng.fitSpotRecurringModel_(salesData.spotSeries48 || [], seriesStart, ctx.lastClosedMonthStart, baseForSpotCap, tuning);
  const offsetRate = isFinite(tuning.knownSpotOffsetRate) ? tuning.knownSpotOffsetRate : eng.KNOWN_SPOT_OFFSET_RATE;
  const spotBg = spotBgModel.expectedByMonth.map((v, i) => Math.max(0, Number(v || 0) - Number(known[i] || 0) * offsetRate));
  const none12 = () => ({ p10: new Array(12).fill(null), p50: new Array(12).fill(null), p90: new Array(12).fill(null) });
  const mixed = light ? none12() : eng.forecastMonteCarloMixed_(model, {
    residualPct: residualPct, factorsProduct: [], factorsClient: [], opinions: [], productWeights: new Map(), aiScores: {},
    nSim: eng.N_SIM, months: months, sourceByMonth: sourceByMonth,
    aiWeight: tuningApplied.aiWeight, aiMaxAbsEffect: tuningApplied.aiMaxAbsEffect, tuning: tuningApplied,
    spotBgModel: spotBgModel, knownSpotProjectsByMonth: Array.from({ length: 12 }, () => []),
    historyAnnualAnchor: eng.buildHistoryAnnualAnchor_(salesData, ctx, tuning, dlmPrimary),
    knownSpotBgSuppressRate: isFinite(tuning.knownSpotBgSuppressRate) ? tuning.knownSpotBgSuppressRate : eng.KNOWN_SPOT_BG_SUPPRESS_RATE,
    dlmBaseLogByMonth: dlmPrimary ? dlm.logByMonth : null, reliabilityApply: false, reliabilityMap: new Map(), lmdiEnabled: false
  });
  const total48 = salesData.baseSeries48.map((v, i) => Number(v || 0) + Number((salesData.spotSeries48 || [])[i] || 0));   // 締まっていない月は 0 円
  // 締まった年度の月を実績で置き換える設定（本番と同じ。区切りの「今」では年度の月はまだ締まっていない）
  if (!light && eng.readForecastClosedMonthMode_() === 'actual') {
    months.forEach((_, i) => {
      if (sourceByMonth[i] !== 'actual_closed') return;
      const k = ctx.forecastMonthIndexesInSales[i];
      const a = closedSet.has(i) && k >= 0 ? Number(total48[k] || 0) : 0;
      mixed.p10[i] = a; mixed.p50[i] = a; mixed.p90[i] = a;
    });
  }
  // 季節加重（本番は OUTPUT を書くときに、補正を入れないチューニングで計算する）
  const seasonal = light ? { totalByMonth: new Array(12).fill(null) } : eng.forecastSeasonalWeighted48_({ adjustedBaseSeries48: aggYAdj, seriesStart: seriesStart, lastClosedMonthStart: ctx.lastClosedMonthStart,
    spotBackgroundExpectedByMonth: spotBg, knownSpotExpectedByMonth: known, tuning: eng.readModelTuningFromConfig_() });
  // 手法の材料（Methods.js。乱数を使った後に読むだけ）: 土台の売上・土台の式・背景のスポット・予測の月の印
  return { p10: mixed.p10.slice(), p50: mixed.p50.slice(), p90: mixed.p90.slice(), seasonal: seasonal.totalByMonth.slice(), total48: rawTotal48,
    y: aggYAdj.slice(), model: { slope: model.slope, intercept: model.intercept, seasonalIndex: model.seasonalIndex.slice() }, spotBg: spotBg.slice(), sourceByMonth: sourceByMonth.slice(),
    parts: eng.computeTriangulationParts_(smoothY, model, q.p50), triWeights: tri ? tri.weights : null };
}

// ---- 実績・本番の予測・本物の月 ----

/** PROCESS_STATUS の手順の成功の日（日本の暦の 'yyyy-MM-dd'。無い・読めなければ ''）。step1 = 売上の取り込み（A-2）、step2 = 実績の取り込み（B-1） */
function appBacktestStepDay_(rows, key) {
  const s = (rows || []).filter(r => r.step_key === key && String(r.status).toLowerCase() === 'success')[0];
  if (!s) return '';
  const ms = appIsDate_(s.last_run_date) ? s.last_run_date.getTime() : appLandingTime_(String(s._types || '').charAt(1), s.last_run_date);   // last_run_date は見出しの 2 列目
  return ms === null || !isFinite(ms) ? '' : Utilities.formatDate(new Date(ms), APP_TZ, 'yyyy-MM-dd');
}

/** 売上（A-2）と実績（B-1）を取り込んだ日（締まった月の決まり D5 で使う） */
function appBacktestImportDays_(planId) {
  const rows = appReadPlanTable_('ENG_PROCESS_STATUS', planId);
  return { sales: appBacktestStepDay_(rows, 'step1_status'), actuals: appBacktestStepDay_(rows, 'step2_status') };
}

/** 月ごとの実績（ベース + スポット。B-1 の表）。締まった月だけ（行の無い締まった月は 0 円 = ZAC に記録が無い）、ほかは null */
function appBacktestActuals_(planId, yms, day) {
  const sum = {};
  yms.forEach(ym => { sum[ym] = 0; });
  appReadPlanTable_('ENG_ACTUAL_EVAL_MONTHLY', planId).forEach(r => {
    const t = String(r.service_type || '').trim().toUpperCase();
    if (t !== 'BASE' && t !== 'SPOT') return;
    const ym = appCellYm_(String(r._types || '').charAt(3), r.target_month);   // target_month は見出しの 4 列目
    const v = Number(r.eval_actual_amount);
    if (Object.prototype.hasOwnProperty.call(sum, ym) && isFinite(v)) sum[ym] += v;
  });
  const out = {};
  yms.forEach(ym => { out[ym] = day && appActualClosed_(ym, day) ? sum[ym] : null; });
  return out;
}

/** 本番の予測（LIVE）: 月ごとに、その月が始まる前（「今」< 月の 1 日）の最後の予測の回の P10/P50/P90 と、その回の「今」（at。ミリ秒）。無ければ null */
function appBacktestLive_(planId, yms) {
  const runs = appReadTable_('FORECAST_RUNS').filter(r => r.plan_id === planId && r.status === 'DONE')
    .map(r => ({ id: r.run_id, at: appLandingTime_('', r.as_of), fin: String(r.finished_at || ''), row: r._row })).filter(r => r.at !== null);
  const ids = {};
  runs.forEach(r => { ids[r.id] = true; });
  const monthly = {};
  appReadTable_('FORECAST_MONTHLY').forEach(m => { if (ids[m.run_id]) monthly[m.run_id + '\u0001' + m.ym] = m; });
  const out = {};
  yms.forEach(ym => {
    const start = appMonthStartMs_(ym);
    const best = runs.filter(r => r.at < start && monthly[r.id + '\u0001' + ym])
      .sort((a, b) => b.at - a.at || b.fin.localeCompare(a.fin) || b.row - a.row)[0];
    const m = best ? monthly[best.id + '\u0001' + ym] : null;
    out[ym] = m ? { p10: appNum_(m.p10), p50: appNum_(m.p50), p90: appNum_(m.p90), runId: best.id, at: best.at } : null;
  });
  return out;
}

/**
 * 区切りの前 48 か月（startYm から）のうち本物の月の数: 最初に売上（ベース + スポット）があった月から後で、
 * 売上を取り込んだ日（salesDay）に締まっていた月（D5）。取引が始まる前の 0 円・取り込んだときに途中だった月は数えない
 */
function appBacktestRealMonths_(total48, startYm, salesDay) {
  if (!salesDay) return 0;
  const first = (total48 || []).findIndex(v => Number(v || 0) !== 0);
  if (first < 0) return 0;
  let n = 0;
  for (let k = first; k < APP_BACKTEST_WINDOW; k++) if (appActualClosed_(appBacktestYmAdd_(startYm, k), salesDay)) n++;
  return n;
}

/**
 * 物差し 1 回の行（12 か月 × 11 方法）。id と時刻はここで決める（控えの書き直しで同じ行になるように）。
 * horizon = 予測した時点から何か月先か: 区切りの「今」の方法は i + 1（4 月 = 1）、本番と同じ時点の単純な方法は、その月の本番の回の「今」の月から
 * （3/20 の回の 4 月 = 1）。本番の回が無い月は 0（予測が無い。数えない）
 */
function appBacktestRows_(ctx, plan, fy, btId, stat) {
  const cutoffYm = fy + '/04';
  const yms = appLandingFyYms_(fy);
  const startYm = appBacktestYmAdd_(cutoffYm, -APP_BACKTEST_WINDOW);
  const days = appBacktestImportDays_(plan.plan_id);
  const real = appBacktestRealMonths_(stat.total48, startYm, days.sales);
  const actual = appBacktestActuals_(plan.plan_id, yms, days.actuals);
  const live = appBacktestLive_(plan.plan_id, yms);
  const fin = v => (typeof v === 'number' && isFinite(v) ? v : null);
  const now = appNowIso_();
  const raw = stat.total48;
  const closed = appBacktestClosed_(cutoffYm);
  const t = k => (closed[k] ? Number(raw[k] || 0) : null);   // 区切りの「今」に分かっていた売上（締まっていない月は空）
  const dayOf = ms => Utilities.formatDate(new Date(ms), APP_TZ, 'yyyy-MM-dd');
  // 本番と同じ時点の単純な方法: 前年同月 × （その時点で締まっていた年度の月の実績 ÷ 前年の同じ月々の売上）
  const pace = (i, ym) => {
    const l = live[ym];
    if (!l) return null;
    const day = dayOf(l.at);
    const ly = k => (appActualClosed_(appBacktestYmAdd_(startYm, k), day) ? Number(raw[k] || 0) : null);
    const base = ly(36 + i);
    if (base === null) return null;
    let a = 0, b = 0;
    for (let j = 0; j < i; j++) {
      const lj = ly(36 + j);
      if (!appActualClosed_(yms[j], day) || fin(actual[yms[j]]) === null || lj === null) continue;
      a += actual[yms[j]]; b += lj;
    }
    return base * (b > 0 ? a / b : 1);
  };
  const meth = appMethodsFromStat_(stat, Array.from({ length: 12 }, (_, i) => t(36 + i)), stat.triWeights);   // 線形回帰・直近重視・季節の中央値・シミュレーションの中心・三角測量
  const value = (m, i, ym) => {
    if (m === 'STAT_ONLY') return [stat.p10[i], stat.p50[i], stat.p90[i]];
    if (meth[m] && m !== 'LAST_YEAR') return [null, meth[m][i], null];
    if (m === 'LIVE') return live[ym] ? [live[ym].p10, live[ym].p50, live[ym].p90] : [null, null, null];
    if (m === 'LAST_YEAR') return [null, t(36 + i), null];
    if (m === 'TWO_YEAR') return [null, t(24 + i) === null || t(36 + i) === null ? null : (t(24 + i) + t(36 + i)) / 2, null];
    if (m === 'LAST_YEAR_PACE') return [null, pace(i, ym), null];
    return [null, stat.seasonal[i], null];
  };
  const horizon = (m, i, ym) => {
    if (m !== 'LIVE' && m !== APP_BACKTEST_SIMPLE_LIVE) return i + 1;
    const l = live[ym];
    return l ? appBacktestMonthsBetween_(Utilities.formatDate(new Date(l.at), APP_TZ, 'yyyy/MM'), ym) : 0;
  };
  const rows = [];
  APP_BACKTEST_METHODS.forEach(m => yms.forEach((ym, i) => {
    const v = value(m, i, ym).map(fin);
    const a = fin(actual[ym]);
    rows.push({ plan_id: plan.plan_id, point_id: appStableLogId_(APP_LOG_PREFIX.BACKTEST, [btId, m, ym]), bt_id: btId, cutoff_ym: cutoffYm,
      target_ym: ym, horizon: horizon(m, i, ym), method: m, p10: v[0], p50: v[1], p90: v[2], actual: a, real_months: real,
      counted: real === APP_BACKTEST_WINDOW && a !== null && v[1] !== null,
      engine_sha256: stat.engine.sourceSha256, seed: stat.seed, calc_version: APP_BACKTEST_CALC_VERSION, computed_at: now, computed_by: ctx.actor });
  }));
  return rows;
}

// ---- 裏の処理（MEASURE.BACKTEST → MEASURE.BACKTEST_CALC）----

/**
 * 組み立て（MEASURE.BACKTEST）: 統計の部分が読むシートだけを、データ本体から計算用ブックに組み立てる。
 * 1 回の上限に収まらなければ同じ処理を続けて動かす。物差しの回の番号（bt_id）と入力のハッシュは最初の回に決めて渡す
 */
function appBacktestBuild_(ctx, p, job) {
  const plan = appPlanOf_(p.planId);
  const jobStart = new Date().getTime();
  return appWithLock_(() => {
    if (!p.build) appJournalRecover_(ctx);   // 締めた年度の計画は、処理を始める前に止まる（planScoped）
    const fy = appBacktestCutoffFy_(plan, p.fy);
    if (!p.build && !appBacktestImportDays_(plan.plan_id).sales) throw new Error('先に売上の取り込み（A-2）を動かしてください。');
    const inputHash = appPlanInputHash_(plan.plan_id);
    if (p.build && inputHash !== p.inputHash) throw new Error('組み立てている間にデータ本体が変わりました。もう一度動かしてください。');
    const step = appScratchBuildStep_(appWorkScratch_(plan), plan.plan_id, APP_BACKTEST_SHEETS, p.build || null, appBuildDeadline_(jobStart));
    const payload = { planId: plan.plan_id, fy: fy, btId: p.btId || appNewLogId_('BT'), inputHash: inputHash, build: step.state,
      steps: Number(p.steps || 0) + 1, buildMs: Number(p.buildMs || 0) + (new Date().getTime() - jobStart) };
    return { __next: { kind: step.complete ? 'MEASURE.BACKTEST_CALC' : 'MEASURE.BACKTEST', payload: payload },
      audit: { entityId: plan.plan_id, clientId: plan.client_id } };
  });
}

/**
 * 計算と保存（MEASURE.BACKTEST_CALC）: 統計だけを動かし、11 の方法の 132 行を、控えの書き方 append で BACKTEST に足す。
 * 統計だけは区切りの「今」に締まっていた月の売上だけで動かす（appBacktestClosed_・appBacktestStatAsOf_）
 */
function appBacktestCalc_(ctx, p) {
  const plan = appPlanOf_(p.planId);
  const t0 = new Date().getTime();
  return appWithLock_(() => {
    appJournalRecover_(ctx);
    if (!p.build || !appScratchOwnedBy_(p.build.token)) throw new Error('計算用ブックがほかの処理で使われました。もう一度動かしてください。');
    if (appPlanInputHash_(plan.plan_id) !== p.inputHash) throw new Error('物差しを計算している間にデータ本体が変わりました。もう一度動かしてください。');
    const fy = appBacktestCutoffFy_(plan, p.fy);
    const cutoffYm = fy + '/04';
    const inputHash = appBacktestInputHash_(plan.plan_id);
    const closed = appBacktestClosed_(cutoffYm);
    const stat = appBacktestStatRun_(appWorkScratch_(plan), { fy: fy, asOfMs: appBacktestStatAsOf_(cutoffYm, closed), closed: closed,
      seed: eng => appBacktestSeed_(plan, inputHash, cutoffYm, eng), uuidSeed: p.btId, actor: ctx.actor });
    const t1 = new Date().getTime();
    const rows = appBacktestRows_(ctx, plan, fy, p.btId, stat);
    const ops = appLogOps_('BACKTEST', rows);   // 表の版がそろう前は [] （記録を足さない。エラーのログに残る）
    const written = ops.length ? appJournalRun_(ctx, '物差し（FY' + fy + '）', plan.plan_id, ops) : null;
    const pts = rows.filter(r => r.method === 'STAT_ONLY');
    // onCard: 分析の物差しに入る回か（区切りが計画の年度の初めの回だけ。前の年度を区切りにした回は数えられる点が無い）
    return { planId: plan.plan_id, btId: p.btId, cutoffYm: cutoffYm, onCard: fy === Number(plan.fy), rows: rows.length, written: written ? (written.BACKTEST || {}).appended || 0 : 0,
      skipped: !ops.length, realMonths: pts.length ? pts[0].real_months : 0, counted: pts.filter(r => r.counted).length, seed: stat.seed,
      methods: appBacktestSummary_(rows, {}).methods.map(m => ({ method: m.method, n: m.n, mape: m.mape, bias: m.bias, cover: m.cover })),
      timing: { buildMs: p.buildMs || 0, steps: p.steps || 1, calcMs: t1 - t0, saveMs: new Date().getTime() - t1 },
      audit: { entityId: p.btId, clientId: plan.client_id } };
  });
}

// ---- 分析のまとめ ----

/**
 * t 分布の 97.5% 点（両側 95%。df = 自由度 1 以上）。P(|T| > t) = I_{df/(df+t²)}(df/2, 1/2) なので、I_x(df/2, 1/2) = 0.05 の x から
 * t = √(df (1 − x) / x)（appBetaQuantile_。df = 1 で 12.71、df = 2 で 4.30）。df が 1 より小さければ null
 */
function appBacktestT975_(df) {
  if (!(df >= 1)) return null;
  const x = appBetaQuantile_(0.05, df / 2, 0.5);
  return x > 0 ? Math.sqrt(df * (1 - x) / x) : null;
}

/**
 * メーカーごとに平均してから、メーカーの数で 95% の幅を出す（同じ計画の月どうしはつながっているので、点を独立とみなさない。2026-10-13 村井さん承認）。
 * byMaker = { メーカー: [値] }。mean = メーカーごとの平均の平均（メーカーを同じ重さで）、lo・hi = mean ± t(メーカーの数 − 1) × メーカーの平均の
 * 標準偏差 ÷ √メーカーの数（メーカーが 2 より少なければ null）。clamp01 = true なら幅を 0〜1 に収める（割合）。
 * 返り値: { mean, lo, hi, n（点の数）, makers }
 */
function appBacktestClusterMean_(byMaker, clamp01) {
  const means = Object.keys(byMaker).map(k => byMaker[k]).filter(xs => xs.length).map(xs => xs.reduce((a, b) => a + b, 0) / xs.length);
  const n = Object.keys(byMaker).reduce((s, k) => s + byMaker[k].length, 0);
  const g = means.length;
  if (!g) return { mean: null, lo: null, hi: null, n: 0, makers: 0 };
  const mean = means.reduce((a, b) => a + b, 0) / g;
  if (g < APP_BACKTEST_MIN_MAKERS) return { mean: mean, lo: null, hi: null, n: n, makers: g };
  const sd = Math.sqrt(means.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (g - 1));
  const half = appBacktestT975_(g - 1) * sd / Math.sqrt(g);
  const c = v => (clamp01 ? Math.min(1, Math.max(0, v)) : v);
  return { mean: mean, lo: c(mean - half), hi: c(mean + half), n: n, makers: g };
}

/**
 * メーカーごとに合計の比（Σ分子 ÷ Σ分母）を出してから、appBacktestClusterMean_ と同じくメーカーの数で平均と 95% の幅を出す。
 * byMaker = { メーカー: [[分子, 分母]] }。外れ幅・偏りを、実績が 0 に近い月 1 つで壊れない合計の比（WAPE）で測る。
 * 分母は実績の絶対値。0 円の月の誤差も分子に含める。メーカーの分母が全月 0 なら比は作らず（null）、点の数には残す。
 * 返り値は appBacktestClusterMean_ と同じ形（n は点の数）
 */
function appBacktestClusterRatio_(byMaker) {
  const ratios = {};
  let n = 0;
  Object.keys(byMaker).forEach(k => {
    const xs = byMaker[k] || [];
    const den = xs.reduce((s, x) => s + x[1], 0);
    n += xs.length;
    if (xs.length && den > 0) ratios[k] = [xs.reduce((s, x) => s + x[0], 0) / den];
  });
  return Object.assign(appBacktestClusterMean_(ratios), { n: n });
}

/**
 * 数えた点（counted）を方法ごとにまとめる。clientOf = { 計画の ID: メーカーの ID }（メーカーの数を数え、95% の幅をメーカーごとに出す）。返り値:
 *   methods: [{ method, n（点）, makers, mape・mapeLo・mapeHi（外れ幅 = Σ|予測 − 実績| ÷ Σ|実績|（合計の比）。メーカーごとの合計の比の平均と 95% の幅。0 円月・負の実績も含む）,
 *              bias・biasLo・biasHi（偏り = Σ(予測 − 実績) ÷ Σ|実績|）, pctN（外れ幅の分子を数えた点。分母が全月 0 なら比は null）, cover・coverLo・coverHi・coverN（P10〜P90 に入った割合。
 *              統計だけ・本番だけ。メーカーごとの割合の平均と 95% の幅）, horizonMin・horizonMax・horizon（何か月先か。最小・最大・平均）}]
 *              （95% の幅は appBacktestClusterMean_。メーカーが 2 より少なければ null）
 *   compare: [{ method（STAT_ONLY・LIVE）, vs（STAT_ONLY は外れ幅のいちばん小さい 4/1 の単純な方法、LIVE は同じ時点の単純な方法 LAST_YEAR_PACE）,
 *              n（両方に外れ幅のある点）, makers, diff・lo・hi（外れ幅の差の、メーカーごとの平均の平均と 95% の幅）,
 *              verdict: oneMaker（1 社だけ。差を言えない）・wait（点が 30 より少ない）・smaller・larger・unclear（幅が 0 をまたぐ）}]
 *   points（統計だけの点）, makers, ready（30 点以上・2 社以上）, minPoints・minMakers（その境目。画面の説明に使う）
 */
function appBacktestSummary_(rows, clientOf) {
  const of = r => (clientOf && clientOf[r.plan_id]) || r.plan_id;
  const pts = (rows || []).filter(r => r.counted && typeof r.p50 === 'number' && isFinite(r.p50) && typeof r.actual === 'number' && isFinite(r.actual));
  const keyOf = r => r.plan_id + '\u0001' + r.target_ym;
  const group = (xs, f) => xs.reduce((o, r) => { (o[of(r)] = o[of(r)] || []).push(f(r)); return o; }, {});
  const ape = {};
  const methods = APP_BACKTEST_METHODS.map(m => {
    const xs = pts.filter(r => r.method === m);
    const a = appBacktestClusterRatio_(group(xs, r => [Math.abs(r.p50 - r.actual), Math.abs(r.actual)]));
    const b = appBacktestClusterRatio_(group(xs, r => [r.p50 - r.actual, Math.abs(r.actual)]));
    ape[m] = {};
    xs.forEach(r => { ape[m][keyOf(r)] = { e: Math.abs(r.p50 - r.actual), a: Math.abs(r.actual), maker: of(r) }; });
    const band = xs.filter(r => typeof r.p10 === 'number' && typeof r.p90 === 'number' && isFinite(r.p10) && isFinite(r.p90));
    const w = appBacktestClusterMean_(group(band, r => (r.actual >= r.p10 && r.actual <= r.p90 ? 1 : 0)), true);
    const hs = xs.map(r => Number(r.horizon)).filter(h => isFinite(h) && h > 0);
    return { method: m, n: xs.length, makers: Object.keys(group(xs, r => 1)).length, pctN: xs.length,
      mape: a.mean, mapeLo: a.lo, mapeHi: a.hi, bias: b.mean, biasLo: b.lo, biasHi: b.hi,
      cover: band.length ? w.mean : null, coverLo: w.lo, coverHi: w.hi, coverN: band.length,
      horizonMin: hs.length ? Math.min.apply(null, hs) : null, horizonMax: hs.length ? Math.max.apply(null, hs) : null,
      horizon: hs.length ? hs.reduce((s, h) => s + h, 0) / hs.length : null };
  });
  const simple = methods.filter(m => APP_BACKTEST_SIMPLE.indexOf(m.method) >= 0 && m.mape !== null).sort((x, y) => x.mape - y.mape)[0] || null;
  const compare = [['STAT_ONLY', simple ? simple.method : ''], ['LIVE', APP_BACKTEST_SIMPLE_LIVE]].map(c => {
    const m = c[0], vs = c[1];
    if (!vs) return { method: m, vs: '', n: 0, makers: 0, diff: null, lo: null, hi: null, verdict: 'wait' };
    const keys = Object.keys(ape[m]).filter(k => ape[vs][k]);
    // 外れ幅の差: メーカーごとに、両方に予測のある同じ点で、合計の比どうしの差（Σ|方法の外れ| − Σ|比べる方法の外れ|）÷ Σ|実績|
    const by = {};
    keys.forEach(k => { (by[ape[m][k].maker] = by[ape[m][k].maker] || []).push([ape[m][k].e - ape[vs][k].e, ape[m][k].a]); });
    const d = appBacktestClusterRatio_(by);
    const verdict = !d.makers ? 'wait' : d.n && d.makers < APP_BACKTEST_MIN_MAKERS ? 'oneMaker' : d.n < APP_BACKTEST_MIN_POINTS || d.lo === null ? 'wait'
      : d.hi < 0 ? 'smaller' : d.lo > 0 ? 'larger' : 'unclear';
    return { method: m, vs: vs, n: d.n, makers: d.makers, diff: d.mean, lo: d.lo, hi: d.hi, verdict: verdict };
  });
  const stat = methods[0];
  return { methods: methods, compare: compare, points: stat.n, makers: stat.makers,
    ready: stat.n >= APP_BACKTEST_MIN_POINTS && stat.makers >= APP_BACKTEST_MIN_MAKERS, minPoints: APP_BACKTEST_MIN_POINTS, minMakers: APP_BACKTEST_MIN_MAKERS };
}

/**
 * 分析の画面の物差し（年度 fy の計画。計画ごとに、区切りがその年度の初め（fy/04）の今の数え方の回のうち一番新しい回の点だけ）。
 * 区切りが前の年度の回は数えない（計画の 48 か月の窓がそろうのは、計画の年度の初めを区切りにした回だけ。新しくても、その計画の数える回を隠さない）。
 * 前の数え方（calc_version が APP_BACKTEST_CALC_VERSION でない）の回も数えない（4/1 に締まっていない 3 月を使った・本番と時点の違う方法と比べた）。
 * 物差しの回が 1 つも無ければ null。前の数え方の回だけなら plans = 0（画面は動かし直すよう言う）。
 * 返り値: appBacktestSummary_ の中身 + { fy, plans（物差しのある計画の数）, at（一番新しい回の時刻）, olderRuns（数えていない、前の年度を区切りにした回の数）,
 * oldCalcRuns（数えていない、前の数え方の回の数）}。金額は出さない（割合と点の数だけ）
 */
function appBacktestCard_(fy) {
  const plans = appReadTable_('PLANS').filter(p => String(p.fy) === String(fy) && p.state !== 'ARCHIVED');
  const cut = Number(fy) + '/04';
  const clientOf = {};
  const pts = [];
  const older = {};
  const oldCalc = {};
  let at = '';
  try {
    plans.forEach(p => {
      // 計画の行だけを読む（大きくなった表は計画の ID で探す）。一番新しい回 = 時刻が一番新しく、同じ時刻なら後に足した回
      const rows = appReadPlanTable_('BACKTEST', p.plan_id);
      const now = r => String(r.calc_version) === APP_BACKTEST_CALC_VERSION;
      const mine = rows.filter(r => String(r.cutoff_ym) === cut && now(r));
      rows.forEach(r => { if (String(r.cutoff_ym) !== cut) older[r.bt_id] = true; else if (!now(r)) oldCalc[r.bt_id] = true; });
      const last = mine.reduce((b, r) => (!b || String(r.computed_at) > String(b.computed_at) || (String(r.computed_at) === String(b.computed_at) && r._row > b._row) ? r : b), null);
      if (!last) return;
      clientOf[p.plan_id] = p.client_id;
      mine.forEach(r => { if (r.bt_id === last.bt_id) pts.push(r); });
      if (String(last.computed_at) > at) at = String(last.computed_at);
    });
  } catch (e) { return null; }   // 表の版がそろう前（表が無い）
  const n = Object.keys(clientOf).length;
  const oldCalcRuns = Object.keys(oldCalc).length;
  return n || oldCalcRuns ? Object.assign({ fy: String(fy), plans: n, at: at, olderRuns: Object.keys(older).length, oldCalcRuns: oldCalcRuns }, appBacktestSummary_(pts, clientOf)) : null;
}
