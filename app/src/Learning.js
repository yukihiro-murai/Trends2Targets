/**
 * Learning.js — 精度の推移と、ベイジアン的な学習（進化の計画 C）。
 *
 * 旧来の計算は変えない。ここで計算するものは、次の 2 つに分ける:
 *   影（予測に効かない。画面に出すだけ）
 *     - 精度の推移: 月の誤差・偏り・P10〜P90 に実績が入った割合（目標 80%）。締まった後の予測（誤差 0）は除いて数える。
 *       外れ幅と偏りは、月ごとの外れの平均ではなく、誤差の合計 ÷ 実績の合計（WAPE。appWape_。2026-10-13 村井さん承認）。
 *       実績が 0 に近い月が 1 つあっても、値が何千 % に飛ばない（その月の外れは金額のとおりに数える）。月ごとの外れ（err）は月ごとの値のまま
 *       締まった月（月末から 5 日たってから取り込んだ月。appLandingCutoff_）だけを使う（2026-10-07 村井さん承認 D4。締まっていない月の
 *       EVAL_LOG の行は消さずに読み飛ばす）。どの回の予測で測るか（その月が始まる前の最後の回。D6）は、EVAL_LOG を書く旧来の B-2 が決める。
 *       そのため、今の検証の版（APP_EVAL_POLICY_VERSION）で B-2 が書いた行だけを使う（appEvalRowCurrent_。前の版の行は、月が始まった後の
 *       予測や途中の実績で測った行なので、締まった月の行でも消さずに読み飛ばす。旧来の B-3〜C-1 と同じ）
 *     - 全計画で縮めた偏りの補正（階層ベイズ / 経験ベイズ）: 計画ごとの偏りを、全計画の平均へ、ばらつきに応じて縮める。
 *       偏りは、補正（係数 ×（1 + 暦月の補正））を外した予測で測る（2026-10-13。旧来の B-5 と同じく、その予測に掛かっていた補正で割り戻す。
 *       appEvalAppliedK_）。掛けた後の予測で測ると、補正でちょうど直った計画は偏り 0・倍率 1 に見え、「補正を外せ」と読めてしまう
 *     - P10〜P90 の幅の較正（コンフォーマル）: 実績の 80% が入る幅にするには、今の幅を何倍にすればよいか
 *   人の判断で入れるもの
 *     - 情報源の信頼度の事前分布（ベータ二項の経験ベイズ）: 全計画の RELIABILITY_EVIDENCE（当たった数 / 数）から作り、
 *       各計画の POOL_PRIOR に入れる。旧来の C-1（四半期レビューの提案）が事前分布として使う（予測に効くのは、提案を人が承認してから）。
 *       締まった月で数えた行だけを使う（D4。appEvidenceClosed_。締まっていない月で数えた行は消さずに読み飛ばす）。
 *       今の検証の版の B-2 がその計画で初めて動いた後に数えた行だけを使う（D6。appEvidencePolicyFrom_。それより前の C-1 は、
 *       月が始まった後の予測で測った前の版の行で数えた。消さずに読み飛ばす）
 */
const APP_SOURCE_TYPES = ['factor_product', 'factor_client', 'opinion', 'ai_topic', 'vertex_forecast'];
const APP_POOL_MIN_PLANS = 2;      // 旧来の POOL_MIN_CLIENTS と同じ
const APP_POOL_MIN_SAMPLES = 5;    // 計画ごとに、これだけの数がある計画だけで作る
const APP_POOL_PRECISION_MIN = 2;
const APP_POOL_PRECISION_MAX = 50;
const APP_BIAS_HALF_LIFE = 4;      // 旧来の B-5 と同じ（月）
const APP_CAL_MONTH_BIAS_CAP = 0.25;   // 旧来の AUTOLEARN_FORECAST_BIAS_CAP（A-9 が暦月の補正を掛けるときの上限。補正を割り戻すときも同じに切る）

/**
 * 今の検証の版（旧来の EVALUATION_POLICY_VERSION と同じ値にする。旧来の側の直しが入っていれば app/tests が照合する）。
 * v3 = 2026-10-07 村井さん承認 D4〜D6: 締まった月だけを、その月が始まる前の最後の予測で測る。旧来の B-2 が EVAL_LOG の
 * evaluation_policy_version に書き、旧来の B-3〜C-1 はこの版の行だけを使う（isEvalLogRowCurrent_）。新アプリも同じ行だけを使う
 */
const APP_EVAL_POLICY_VERSION = 'policy-2026H1-v3';

/**
 * EVAL_LOG の行が、今の決まりで測った行か（旧来の isEvalLogRowCurrent_ と同じ。D4〜D6）: 締まった月（cutoffYm より前）の行で、
 * 今の検証の版（APP_EVAL_POLICY_VERSION）で B-2 が書いた行。B-2 は同じ月の行を上書きし、測らなくなった月の行は消さないので、
 * 前の版の行（月が始まった後の予測や、途中の実績で測った行）が締まった月にも残る。それは消さずに読み飛ばす。
 * cutoffYm が '' なら締まった月は無い（どの行も使わない）
 */
function appEvalRowCurrent_(r, cutoffYm) {
  const ym = appYm_(r.target_month);
  return !!cutoffYm && /^\d{4}\/\d{2}$/.test(ym) && ym < cutoffYm && String(r.evaluation_policy_version || '').trim() === APP_EVAL_POLICY_VERSION;
}

/**
 * 計画の EVAL_LOG を、締まった月（cutoffYm より前）ごとの P10/P50/P90 と実績にする（rows = 読んである EVAL_LOG の行。省くとその計画の分を読む）。
 * 今の検証の版の行だけ（appEvalRowCurrent_）。cutoffYm が '' なら締まった月は無い（空を返す）
 */
function appEvalMonths_(planId, rows, cutoffYm) {
  rows = rows || appEngTableObjects_(planId, ['EVAL_LOG']).EVAL_LOG;
  const cutoff = String(cutoffYm || '');
  const by = {};
  rows.forEach(r => {
    if (!appEvalRowCurrent_(r, cutoff)) return;   // 締まっていない月（途中の実績）と、前の版の行は読み飛ばす
    const ym = appYm_(r.target_month);
    const o = by[ym] = by[ym] || { month: ym };
    const pred = appNum_(r.pred), act = appNum_(r.actual);
    if (r.scenario === 'nega') o.p10 = pred;
    if (r.scenario === 'posi') o.p90 = pred;
    if (r.scenario === 'neutral') { o.p50 = pred; o.actual = act; o.evaluatedAt = r.evaluated_at; }
  });
  return Object.keys(by).sort().map(k => by[k]).filter(m => m.p50 !== null && m.p50 !== undefined && m.actual !== null && m.actual !== undefined && m.actual !== 0);
}

/**
 * 今の決まりで B-2 が測った月（締まった月で、今の検証の版の neutral の EVAL_LOG の行がある月。appEvalRowCurrent_）と、その行の数字を
 * 旧来の B-4 が EVAL_INSIGHTS に写す形にしたもの（appInsightB4View_）: [[月, 予測, 実績]]（月の順。同じ月の行が 2 つあれば後の行）。
 * 実績 0 円の月も入れる（精度の月 appEvalMonths_ は実績 0 円の月を除く）。学びの scoredMonths・振り返りに出す行の数字と、
 * 検証の画面の scoredMonths（appAccuracyOf_）は、どちらもこの月で数える
 */
function appEvalScoredMonths_(rows, cutoffYm) {
  const by = {};
  (rows || []).forEach(r => {
    if (String(r.scenario) !== 'neutral' || !appEvalRowCurrent_(r, String(cutoffYm || ''))) return;
    const v = appInsightB4View_(r.pred, r.actual);
    by[appYm_(r.target_month)] = [v.pred, v.actual];
  });
  return Object.keys(by).sort().map(ym => [ym, by[ym][0], by[ym][1]]);
}

/**
 * 計画の、今の検証の版（APP_EVAL_POLICY_VERSION）の B-2 が初めて動いた時刻（ミリ秒。動いていなければ null）。
 * evalRows = その計画の EVAL_LOG の行、runRows = RUN_LOG の行（どちらも見出し → 値）。今の版の EVAL_LOG の行の evaluated_at と、
 * RUN_LOG の B-2 の記録（function_name = updatePhase1EvaluationReport・成功・今の版の B-2 だけが error_summary に「版: scored_months=…」と書く）の
 * run_at の一番古いもの。B-2 は動くたびに測った月の EVAL_LOG の行を書き直す（evaluated_at が新しくなる）が、RUN_LOG は足すだけ
 * （旧来の logRun_ は appendRow）なので、初めの回の時刻が残る。全計画の事前分布（appEvidencePolicyFrom_）・学びの振り返り
 * （appSourceEvidence_）・計画の画面の記入（appPlanViewDropStale_）は、どれもこの時刻を使う
 */
function appEvalPolicySince_(evalRows, runRows) {
  let out = null;
  const take = t => { if (t !== null && (out === null || t < out)) out = t; };
  (evalRows || []).forEach(r => { if (String(r.evaluation_policy_version || '').trim() === APP_EVAL_POLICY_VERSION) take(appEvidenceMs_(r.evaluated_at)); });
  (runRows || []).forEach(r => {
    if (String(r.function_name || '').trim() !== 'updatePhase1EvaluationReport' || String(r.status || '').trim().toLowerCase() !== 'success') return;
    if (String(r.error_summary || '').trim().indexOf(APP_EVAL_POLICY_VERSION + ':') === 0) take(appEvidenceMs_(r.run_at));
  });
  return out;
}

/** 重み付きの平均 */
function appWMean_(xs, ws) { const sw = ws.reduce((a, b) => a + b, 0); return sw ? xs.reduce((a, x, i) => a + x * ws[i], 0) / sw : null; }

/**
 * 外れ幅と偏り（2026-10-13 村井さん承認。WAPE）: 外れ幅 = Σw|中心 − 実績| ÷ Σw|実績|、偏り = Σw(中心 − 実績) ÷ Σw|実績|。
 * ms = [{ p50, actual }]、ws = 月ごとの重み（省くとどの月も 1）。月ごとの外れ（(中心 − 実績) ÷ |実績|）の平均は、実績が 0 に近い月が
 * 1 つあるだけで何千 % にもなる（中心 1 億・実績 1 万円の月は 999,900%）。合計の比なら、その月の外れを金額のとおりに数える。
 * 実績が正なら、偏り = 中心の合計 ÷ 実績の合計 − 1。Σw|実績| が 0（月が無い）なら、どちらも null
 */
function appWape_(ms, ws) {
  let abs = 0, signed = 0, base = 0;
  ms.forEach((m, i) => {
    const w = ws ? ws[i] : 1;
    abs += w * Math.abs(m.p50 - m.actual);
    signed += w * (m.p50 - m.actual);
    base += w * Math.abs(m.actual);
  });
  return base > 0 ? { mape: abs / base, bias: signed / base } : { mape: null, bias: null };
}

/**
 * 偏りの月ごとのばらつき（全計画で縮める強さ appBiasShadow_ に使う）: 合計の比 R からの月ごとのずれ（中心 − 実績 − R・|実績|）を、
 * 月の実績の平均で割った値の分散。実績がどの月も同じなら、月ごとの外れ（中心 ÷ 実績 − 1）の分散と同じ。月が 2 つ未満なら null
 */
function appWapeVar_(ms) {
  if (ms.length < 2) return null;
  const base = ms.reduce((t, m) => t + Math.abs(m.actual), 0);
  if (!(base > 0)) return null;
  const r = ms.reduce((t, m) => t + (m.p50 - m.actual), 0) / base, mean = base / ms.length;
  return ms.reduce((t, m) => t + Math.pow((m.p50 - m.actual - r * Math.abs(m.actual)) / mean, 2), 0) / ms.length;
}

function appQuantile_(xs, q) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const pos = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[pos];
}

/**
 * 精度の形の印（控えの鍵に入れる）。測り方を変えたら変える（同じ版のまま出しても、前の測り方の控えを使わない）。
 * wape-1 = 2026-10-13: 外れ幅と偏りを合計の比（appWape_）にした。月ごとに掛かっていた補正の倍率（months[].k）と、
 * 補正を外した予測の偏り（raw）を足した
 */
const APP_ACCURACY_FORM = 'wape-1';

/** 計画の精度の控えの鍵（入力のハッシュが変われば変わる） */
function appAccuracyKey_(planId) {
  return 'ACC_' + appSha256Hex_([planId, appPlanInputHash_(planId), APP_VERSION, APP_ACCURACY_FORM].join('|')).slice(0, 32);
}

/**
 * 計画の精度を、入力のハッシュが同じあいだ 6 時間控える（全計画を見るので、毎回は計算しない）。
 * evalRowsOf（計画の ID → EVAL_LOG の行）を渡すと、控えが無いときはそこから計算する（全計画の分をまとめて 1 回で読むため）
 */
function appAccuracyCached_(planId, evalRowsOf) {
  const key = appAccuracyKey_(planId);
  const c = appJobGetResult_(key);
  if (c.found) return c.value;
  const v = appAccuracyOf_(planId, evalRowsOf ? evalRowsOf(planId) : null);
  try { appJobPutResult_(key, v); } catch (e) { /* 控えられなくても返す */ }
  return v;
}

/**
 * 計画ごとの精度（appAccuracyCached_ と同じもの）を、控えをまとめて読んで返す（{ planId: 精度 }。planIds の順。読めない計画は除く）。
 * 全計画の入力のハッシュは ENG_SHEETS を 1 回で読み、控えは getAll でまとめて取る
 */
function appAccuracyAll_(planIds) {
  if (planIds.length > 1) { try { appReadTable_('ENG_SHEETS'); } catch (e) { /* 読めなければ計画ごとに読む（その計画が除かれる） */ } }
  const keys = {};
  planIds.forEach(id => { try { keys[id] = appAccuracyKey_(id); } catch (e) { /* 読めない計画は除く */ } });
  const ids = planIds.filter(id => Object.prototype.hasOwnProperty.call(keys, id));
  const hits = appJobGetResults_(ids.map(id => keys[id]));
  const accs = {};
  ids.forEach(id => {
    try {
      const c = hits[keys[id]];
      if (c.found) { accs[id] = c.value; return; }
      const v = appAccuracyOf_(id);
      try { appJobPutResult_(keys[id], v); } catch (e) { /* 控えられなくても返す */ }
      accs[id] = v;
    } catch (e) { /* 読めない計画は除く */ }
  });
  return accs;
}

/**
 * 検証の月ごとに、その月を測った予測に掛かっていた補正の倍率 k = 係数 ×（1 + その暦月の補正）（2026-10-13）。
 * 旧来の B-5 が補正を割り戻すとき（attachAppliedCalibration_）と同じものを読む: EVAL_LOG の中心を作った FORECAST_SNAPSHOT の回を、B-2 と同じ決まり
 * （その月が始まる前の回のうち一番新しい回。締まった後の回 = forecast_source が actual_closed・印の無い回で中心が実績と同じ、は使わない）で選び、
 * その回の中心が EVAL_LOG の中心と同じなら、その回の calibration_applied_json の係数（正の数でなければ 1）と、その暦月の補正（±0.25 で切る。A-9 と同じ）。
 * 回が無い・中心が違う（B-2 の後に予測し直した）・読めない月は入れない（= 1。補正なしとして扱う。旧来と同じ）。Vertex の補正は学ぶ補正ではないので割り戻さない。
 * snapRows = FORECAST_SNAPSHOT の行（見出し → 値）、months = appEvalMonths_ の月。返り値 { 'yyyy/MM': k }。
 * 計画のブックは 1 つのメーカーの分なので、メーカーの名前では分けない（旧来は名前でも分ける）
 */
function appEvalAppliedK_(snapRows, months) {
  const want = {};
  (months || []).forEach(m => { want[m.month] = m; });
  const best = {};
  (snapRows || []).forEach((r, i) => {
    if (String(r.scenario || '') !== 'neutral') return;
    const ym = appYm_(r.target_month);
    const m = want[ym];
    if (!m) return;
    const t = appEvidenceMs_(r.run_date), start = appMonthStartMs_(ym);
    if (t === null || start === null || t >= start) return;   // その月が始まる前の回だけ（D6）
    let src = '';
    try { src = String((JSON.parse(String(r.key_factors_json || '{}')) || {}).forecast_source || ''); } catch (e) { src = ''; }
    const pred = appNum_(r.final_pred);
    if (src === 'actual_closed' || (!src && pred !== null && Math.abs(pred - m.actual) < 1e-6)) return;   // 締まった後の回は使わない
    const b = best[ym];
    if (!b || t > b.t || (t === b.t && i > b.i)) best[ym] = { t: t, i: i, pred: pred, cal: r.calibration_applied_json };
  });
  const out = {};
  Object.keys(best).forEach(ym => {
    const b = best[ym], p50 = want[ym].p50;
    if (b.pred === null || Math.abs(b.pred - p50) > Math.max(1e-6, 1e-9 * Math.abs(b.pred))) return;
    let cal = b.cal;
    if (typeof cal === 'string') { try { cal = JSON.parse(cal); } catch (e) { cal = null; } }
    if (!cal || typeof cal !== 'object') return;
    const f = Number(cal.bias_correction_factor);
    let mb = 0;
    try { mb = Number(JSON.parse(appCalibrationStoredMonthJson_(cal.residual_month_bias_json))[String(Number(ym.slice(5)))] || 0); } catch (e) { mb = 0; }
    const k = (isFinite(f) && f > 0 ? f : 1) * (1 + Math.min(APP_CAL_MONTH_BIAS_CAP, Math.max(-APP_CAL_MONTH_BIAS_CAP, isFinite(mb) ? mb : 0)));
    if (isFinite(k) && k > 0) out[ym] = k;
  });
  return out;
}

/**
 * 計画の締まった月の境目（appLandingCutoff_。stRows = その計画の PROCESS_STATUS の行）。計画の一覧（appPortfolioData_）と同じく、
 * 実績の取り込み（B-1）の後に当たり具合の計算（B-2）がまだの間は、消さずに足す記録（appPortfolioStepHist_）を渡して、最後に成功した
 * B-2 の前の B-1 の境目で数え続ける（2026-10-13。前は記録を渡さず、その間は締まった月が 0 か月になり、計画の一覧とずれていた）。
 * 記録を読むのは、B-1 の後に B-2 がまだの計画だけ
 */
function appPlanCutoff_(planId, stRows) {
  const st = stRows || [];
  const hist = appLandingPendingCutoff_(st) !== '' ? (appPortfolioStepHist_([planId])[planId] || []) : [];
  return appLandingCutoff_(st, hist);
}

/**
 * 計画の精度（影）。leak = 予測が実績とまったく同じ月（締まった後に予測し直した月。旧来の検証が拾ってしまう）。evalRows は appEvalMonths_ と同じ。
 * 締まった月の、今の検証の版の行だけで測る（D4〜D6。appEvalRowCurrent_）。cutoffYm（締まった月の境目。appLandingCutoff_）を省くと、
 * その計画の PROCESS_STATUS を読んで決める。scoredMonths = 今の決まりで B-2 が測った月の数（appEvalScoredMonths_。実績 0 円の月も数える。
 * months・n は実績 0 円の月を除くので、「まだ比べていない」と「比べた月がどれも売上 0 円」を見分けるのに使う）。
 * snapRows = その計画の FORECAST_SNAPSHOT の行（省くと読む）。月ごとに、その月を測った予測に掛かっていた補正の倍率 k（appEvalAppliedK_。
 * 分からなければ 1）を months[].k に入れ、raw = 補正を外した予測（中心 ÷ k）の偏り { bias, errVar, corrected（k が 1 でない月の数） } を返す
 * （全計画で縮めた偏り appBiasShadow_ が使う。2026-10-13）
 */
function appAccuracyOf_(planId, evalRows, cutoffYm, snapRows) {
  const need = (evalRows ? [] : ['EVAL_LOG']).concat(typeof cutoffYm === 'string' ? [] : ['PROCESS_STATUS']).concat(snapRows ? [] : ['FORECAST_SNAPSHOT']);
  const t = need.length ? appEngTableObjects_(planId, need) : {};
  const cutoff = typeof cutoffYm === 'string' ? cutoffYm : appPlanCutoff_(planId, t.PROCESS_STATUS);
  const scoredMonths = appEvalScoredMonths_(evalRows || t.EVAL_LOG, cutoff).length;
  const base = appEvalMonths_(planId, evalRows || t.EVAL_LOG, cutoff);
  const kOf = appEvalAppliedK_(snapRows || t.FORECAST_SNAPSHOT, base);
  const ms = base.map(m => {
    const err = (m.p50 - m.actual) / Math.abs(m.actual);
    const hasRange = m.p10 !== null && m.p10 !== undefined && m.p90 !== null && m.p90 !== undefined && m.p90 > m.p10;
    return Object.assign({}, m, { err: err, ape: Math.abs(err), leak: Math.abs(m.p50 - m.actual) < 1e-6,
      inside: hasRange ? (m.actual >= m.p10 && m.actual <= m.p90) : null,
      z: hasRange ? Math.abs(m.actual - m.p50) / ((m.p90 - m.p10) / 2) : null, k: kOf[m.month] || 1 });
  });
  const use = ms.filter(m => !m.leak);
  const inside = use.filter(m => m.inside !== null);
  const zs = use.map(m => m.z).filter(z => z !== null);
  // 偏り（旧来の B-5 と同じく、新しい月ほど重い）。外れ幅はどの月も同じ重み（今までと同じ）。どちらも合計の比（appWape_）
  const w = use.map((m, i) => Math.pow(0.5, (use.length - 1 - i) / APP_BIAS_HALF_LIFE));
  const half = Math.floor(use.length / 2);
  const wapeOf = xs => appWape_(xs).mape;
  const raw = use.map(m => ({ p50: m.p50 / m.k, actual: m.actual }));   // 補正を外した予測（旧来の B-5 と同じく割り戻す）
  return {
    months: ms, n: use.length, leaks: ms.length - use.length, cutoffYm: cutoff, scoredMonths: scoredMonths,
    mape: wapeOf(use), bias: appWape_(use, w).bias, biasW: w.reduce((a, b) => a + b, 0),
    errVar: appWapeVar_(use),
    raw: { bias: appWape_(raw, w).bias, errVar: appWapeVar_(raw), corrected: use.filter(m => m.k !== 1).length },
    coverage: inside.length ? inside.filter(m => m.inside).length / inside.length : null, coverageN: inside.length,
    // 実績の 80% が入る幅は、今の幅の何倍か（1 より大きければ今の幅は狭すぎる）
    widthScale: zs.length >= 3 ? appQuantile_(zs, 0.8) : null,
    trend: use.length >= 6 ? { recent: wapeOf(use.slice(-3)), before: wapeOf(use.slice(0, use.length - 3).slice(-3)) }
      : half >= 2 ? { recent: wapeOf(use.slice(half)), before: wapeOf(use.slice(0, half)) } : null
  };
}

/**
 * 全計画の偏りの補正を、全体の平均へ縮める（経験ベイズ・DerSimonian–Laird の τ²）。影: 予測には効かない。
 * 使う月は accs（appAccuracyOf_）の月 = 締まった月だけ（D4）。
 * 偏りは補正を外した予測で測る（accs[].raw。2026-10-13）。測っている予測は、補正（係数 ×（1 + 暦月の補正））を掛けた後の値なので、
 * そのまま縮めると、補正で直った計画（補正前 +25% を係数 0.8 で直した計画）の倍率は 1 に見え、補正の無い計画の偏りと混ざる。
 * 旧来の B-5 と同じく割り戻してから縮めるので、倍率（factorShadow = 1 ÷（1 + 縮めた偏り））は「今の補正の代わりに掛ける倍率」（今の補正に重ねて掛けるものではない）。
 * mapeNow = 今の予測（補正を掛けた後）の外れ幅、mapeShadow = 補正を外した予測に倍率だけを掛けたときの外れ幅（どちらも合計の比）。
 * mapeShadow は倍率を決めたのと同じ月で測るので、実際より良く見えやすい（画面で断る）。
 * 返り値: { mu, tau2, plans: { planId: { bias（補正を外した予測の偏り）, biasNow（今の予測の偏り）, corrected（割り戻した月の数）, se, shrunk,
 *   factorShadow, mapeNow, mapeShadow } } }（se = 偏りの標準誤差。縮める強さを決めたもの）
 */
function appBiasShadow_(accs) {
  // 前の形の控え（raw が無い）は、補正を掛けた後の偏りのまま（割り戻す材料が無い）
  const rawOf = id => { const a = accs[id]; return a.raw && typeof a.raw.bias === 'number' ? a.raw : { bias: a.bias, errVar: a.errVar, corrected: 0 }; };
  const ids = Object.keys(accs).filter(id => accs[id].n >= 3 && typeof rawOf(id).bias === 'number' && isFinite(rawOf(id).bias));
  const v = id => { const r = rawOf(id); const s2 = r.errVar === null || r.errVar === undefined ? 0.04 : Math.max(r.errVar, 1e-4); return s2 / Math.max(1, accs[id].biasW); };
  let mu = 0, tau2 = 0;
  if (ids.length >= 2) {
    const w = ids.map(id => 1 / v(id));
    mu = appWMean_(ids.map(id => rawOf(id).bias), w);
    const q = ids.reduce((s, id, i) => s + w[i] * Math.pow(rawOf(id).bias - mu, 2), 0);
    const c = w.reduce((a, b) => a + b, 0) - w.reduce((a, b) => a + b * b, 0) / w.reduce((a, b) => a + b, 0);
    tau2 = Math.max(0, (q - (ids.length - 1)) / (c || 1));
  }
  const plans = {};
  ids.forEach(id => {
    const a = accs[id], r = rawOf(id);
    // 計画が 1 つだけのときは、旧来と同じく 0 へ縮める（事前の精度 3 = 旧来の kG）
    const shrunk = ids.length >= 2 ? (tau2 > 0 ? (r.bias / v(id) + mu / tau2) / (1 / v(id) + 1 / tau2) : mu) : r.bias * a.biasW / (a.biasW + 3);
    // 倍率 = 1 ÷（1 + 縮めた偏り）（偏りは合計の比なので、倍率を掛けた予測の合計が実績の合計に合う値。2026-10-13）。
    // 前の 1 − 偏り は偏りが小さいときの近似で、補正の前に +25% の計画では 0.75（下限）になり、今の補正 0.8 と食い違って見えた。上下限は旧来と同じ
    const factor = Math.min(1.25, Math.max(0.75, 1 + shrunk > 0 ? 1 / (1 + shrunk) : 1.25));
    const use = a.months.filter(m => !m.leak);
    const kOf = m => (typeof m.k === 'number' && m.k > 0 ? m.k : 1);
    const mapeNow = appWape_(use).mape;
    const mapeShadow = appWape_(use.map(m => ({ p50: m.p50 / kOf(m) * factor, actual: m.actual }))).mape;   // 補正を外した予測に、倍率だけを掛ける
    plans[id] = { bias: r.bias, biasNow: a.bias, corrected: r.corrected || 0, se: Math.sqrt(v(id)), shrunk: shrunk, factorShadow: factor, mapeNow: mapeNow, mapeShadow: mapeShadow };
  });
  return { mu: mu, tau2: tau2, pooled: ids.length >= 2, plans: plans };
}

/**
 * 計画のメーカーの名前（CONFIG!B2）: { 計画の ID: 名前（無ければ ''） }。旧来の A-9・B-5 は、この名前の CALIBRATION_STATE の行の補正を
 * 予測に掛ける（名前が合う行が無ければ既定の行を足す）。「今の補正」はこの名前で選ぶ（appLandingCalRow_。Landing.js・Calibration.js と同じ。2026-10-13）。
 * データ本体の ENG_ROWS の CONFIG の 2 行目を読む（計画が 2 つ以上なら表を 1 回で。Portfolio.js の appPortfolioData_ と同じ読み方）
 */
function appPlanClients_(ids) {
  const want = {};
  (ids || []).forEach(id => { want[id] = true; });
  const out = {};
  (ids || []).forEach(id => { out[id] = ''; });
  if (!ids || !ids.length) return out;
  const rows = ids.length === 1 ? appReadPlanTable_('ENG_ROWS', ids[0]) : appReadTable_('ENG_ROWS');
  rows.forEach(s => {
    if (!want[s.plan_id] || s.sheet !== 'CONFIG' || Number(s.row_no) !== 2) return;
    const at = 2 - Number(s.col_from);   // B 列
    if (!(at >= 0)) return;
    let cells;
    try { cells = JSON.parse(s.cells_json) || []; } catch (e) { return; }
    const x = cells[at];
    if (x === undefined || x === null || x === '') return;
    const t = String(x).charAt(0);
    out[s.plan_id] = t === 'f' ? '' : String(appCellDecode_(t, String(x).slice(1))).trim();
  });
  return out;
}

/**
 * 計画の今の補正の行（CALIBRATION_STATE の行のうち、CONFIG!B2 のメーカーの行。appLandingCalRow_。無ければ null）。
 * 最後の行ではない（旧来はメーカーの名前が合わないと既定の行を足すので、行が 2 つになった計画では最後の行と予測に効く行がずれる）
 */
function appPlanCalRow_(planId, calRows) {
  return appLandingCalRow_(calRows, appPlanClients_([planId])[planId]);
}

/**
 * 計画の精度と学習の影（予測の画面の「検証」タブ）。データ本体が変わらない間は控えから返す（appCachedRead_）。
 * scoredMonths = 今の決まりで B-2 が測った月の数（実績 0 円の月も数える。appAccuracyOf_）。accuracy.months・n は実績 0 円の月を除くので、
 * 画面は scoredMonths で「まだ比べていない」と「比べた月がどれも売上 0 円」を見分ける
 */
function appLearningView_(planId) {
  return appCachedRead_('LEARN\u0001' + APP_VERSION + '\u0001' + String(planId || ''), () => appLearningViewData_(planId));
}

function appLearningViewData_(planId) {
  const plan = appPlanOf_(planId);
  const accs = appAccuracyAll_(appReadTable_('PLANS').filter(p => p.state !== 'ARCHIVED').map(p => p.plan_id));
  let mine = accs[plan.plan_id] || appAccuracyOf_(plan.plan_id);
  if (typeof mine.scoredMonths !== 'number') {
    // 前の形の控え（scoredMonths が無い）は、その計画の分だけ数え直す
    mine = appAccuracyOf_(plan.plan_id);
    try { appJobPutResult_(appAccuracyKey_(plan.plan_id), mine); } catch (e) { /* 控えられなくても返す */ }
  }
  const shadow = appBiasShadow_(accs);
  const cal = appPlanCalRow_(plan.plan_id, appEngTableObjects_(plan.plan_id, ['CALIBRATION_STATE']).CALIBRATION_STATE);   // CONFIG!B2 のメーカーの行
  return { planId: plan.plan_id, scoredMonths: mine.scoredMonths, accuracy: Object.assign({}, mine, { months: mine.months.map(m => ({ month: m.month, p10: m.p10, p50: m.p50, p90: m.p90, actual: m.actual,
    err: m.err, inside: m.inside, leak: m.leak })) }),
    shadow: shadow.plans[plan.plan_id] || null, pooledPlans: Object.keys(shadow.plans).length, pooled: shadow.pooled, mu: shadow.mu, tau2: shadow.tau2,
    factorNow: cal ? appNum_(cal.bias_correction_factor) : null };
}

// ---- 情報源の信頼度の事前分布（ベータ二項の経験ベイズ） ----

/** セルの日時をミリ秒に（日時の型・ISO の文字・'yyyy/MM/dd HH:mm' の文字。読めなければ null） */
function appEvidenceMs_(v) {
  const ms = appIsDate_(v) ? v.getTime() : appLandingTime_('', v);
  return ms === null || !isFinite(ms) ? null : ms;
}

/**
 * RELIABILITY_EVIDENCE の行（旧来の C-1 が四半期ごとに書く当たりの数）が、締まった月だけで数えたものでありうるか（D4）:
 * 四半期の最後の月（quarter_end_month）が、数えた日（computed_at。日本の暦）に締まっていたか（appActualClosed_）。
 * 実績はその日までに取り込んだものなので、その日に締まっていない月は、取り込んだ日にも締まっていない（途中の実績で数えた）。
 * 月か日時が読めない行も使わない。どの回の予測で数えたか（D6）は行に無いので、appEvidencePolicyFrom_ の時刻と比べる
 */
function appEvidenceClosed_(r) {
  const ms = appEvidenceMs_(r.computed_at);
  if (ms === null) return false;
  return appActualClosed_(appYm_(r.quarter_end_month), Utilities.formatDate(new Date(ms), APP_TZ, 'yyyy-MM-dd'));
}

/**
 * 計画ごとに、今の検証の版（APP_EVAL_POLICY_VERSION）の B-2 が初めて動いた時刻（ミリ秒。動いていなければ null）。
 * その後に数えた RELIABILITY_EVIDENCE の行は、今の版の旧来の C-1（今の版の EVAL_LOG の行だけを使い、その月が始まる前の予測で測る。D6）が数えたもの。
 * 前の版の C-1 が数えた行（月が始まった後の予測で測った）は、行に版の印が無いので、数えた時刻（computed_at）で見分ける。
 * 時刻の決め方は appEvalPolicySince_（今の版の EVAL_LOG の行の evaluated_at と、RUN_LOG の今の版の B-2 の記録の一番古いもの。
 * B-2 は動くたびに EVAL_LOG の時刻を書き直すので、EVAL_LOG だけでは時刻が後ろへずれ、前の B-2 の後に今の版の C-1 が数えた行まで落としてしまう）。
 * EVAL_LOG と RUN_LOG は全計画の分を 1 回ずつ読む（appEngAll_）
 */
function appEvidencePolicyFrom_(ids) {
  const out = {};
  ids.forEach(id => { out[id] = null; });
  if (!ids.length) return out;
  const ev = appEngAll_('EVAL_LOG', ids);
  const log = appEngAll_('RUN_LOG', ids);
  ids.forEach(id => { out[id] = appEvalPolicySince_(ev[id], log[id]); });
  return out;
}

/**
 * 全計画の当たった数から、情報源ごとの事前分布を作る（書かない。画面で見比べる）。
 * 締まった月で数えた行（appEvidenceClosed_）で、その計画で今の版の B-2 が初めて動いた後に数えた行（appEvidencePolicyFrom_）だけを使う。
 * 今の版の B-2 がまだ動いていない計画の行は使わない。使わなかった行の数は skippedEvidence（行は消さない）
 */
function appPoolPreview_() {
  const plans = appReadTable_('PLANS').filter(p => p.state !== 'ARCHIVED');
  const names = appClientNameMap_();
  const per = {};   // type → [{ planId, n, hit }]
  const current = {};
  let skipped = 0;
  let from = {};
  try { from = appEvidencePolicyFrom_(plans.map(p => p.plan_id)); } catch (e) { Logger.log('今の版の B-2 の時刻を読めません（どの行も使いません）: ' + (e && e.message ? e.message : e)); }
  plans.forEach(p => {
    let t;
    try { t = appEngTableObjects_(p.plan_id, ['RELIABILITY_EVIDENCE', 'POOL_PRIOR']); } catch (e) { return; }
    const sum = {};
    const since = from[p.plan_id] === undefined ? null : from[p.plan_id];
    t.RELIABILITY_EVIDENCE.forEach(r => {
      const k = String(r.source_type || ''); const n = appNum_(r.n), h = appNum_(r.hit);
      if (!k || n === null || h === null) return;
      if (!appEvidenceClosed_(r)) { skipped++; return; }   // 締まっていない月で数えた行は読み飛ばす（D4）
      const at = appEvidenceMs_(r.computed_at);
      if (since === null || at < since) { skipped++; return; }   // 今の版の B-2 の前に、前の版の C-1 が数えた行は読み飛ばす（D6）
      const o = sum[k] = sum[k] || { n: 0, hit: 0 }; o.n += n; o.hit += h;
    });
    Object.keys(sum).forEach(k => { (per[k] = per[k] || []).push({ planId: p.plan_id, client: names[p.client_id] || p.client_label, fy: p.fy, n: sum[k].n, hit: sum[k].hit }); });
    current[p.plan_id] = {};
    t.POOL_PRIOR.forEach(r => { current[p.plan_id][String(r.pool_scope)] = { value: appNum_(r.pooled_value), precision: appNum_(r.precision), nClients: appNum_(r.n_clients) }; });
  });
  const types = APP_SOURCE_TYPES.map(type => {
    const xs = (per[type] || []).filter(x => x.n >= APP_POOL_MIN_SAMPLES);
    const N = xs.reduce((s, x) => s + x.n, 0), Hh = xs.reduce((s, x) => s + x.hit, 0);
    const out = { type: type, label: APP_SOURCE_LABELS[type] || type, plans: xs.length, n: N, hit: Hh, ok: xs.length >= APP_POOL_MIN_PLANS && N > 0 };
    if (!out.ok) { out.note = '計画が ' + APP_POOL_MIN_PLANS + ' つ以上（それぞれ ' + APP_POOL_MIN_SAMPLES + ' 件以上）になると作れます'; return out; }
    const mu = Hh / N;
    // 計画どうしのばらつき（二項のばらつきを除いた分）から、事前分布の強さ（α + β）を決める
    const wv = xs.reduce((s, x) => s + x.n * Math.pow(x.hit / x.n - mu, 2), 0) / N;
    const nbar = N / xs.length;
    const between = Math.max(0, wv - mu * (1 - mu) / nbar);
    const precision = between > 0 ? Math.min(APP_POOL_PRECISION_MAX, Math.max(APP_POOL_PRECISION_MIN, mu * (1 - mu) / between - 1)) : APP_POOL_PRECISION_MAX;
    Object.assign(out, { hitRate: mu, alpha: mu * precision, beta: (1 - mu) * precision, precision: Math.round(precision * 10) / 10,
      pooledR: Math.round(Math.min(1.5, Math.max(0, 2 * mu)) * 1000) / 1000, between: between,
      perPlan: xs.map(x => ({ client: x.client, fy: x.fy, n: x.n, hitRate: x.hit / x.n,
        posterior: (x.hit + mu * precision) / (x.n + precision) })) });   // その計画の当たる割合の事後の平均（参考）
    return out;
  });
  return { types: types, plans: plans.length, current: current, ready: types.some(t => t.ok), skippedEvidence: skipped };
}

/**
 * 全計画の POOL_PRIOR に事前分布を書く（PLAN.RUN と同じく、計算用ブックで旧来の表の形のまま書き、控えを置いてから保存）。
 * 計画が多いときは、1 回の実行の目安（4 分）を過ぎたら残りの計画を続きの処理に回す。値が同じ行は書き直さない（更新日も変えない）
 */
function appPoolApply_(ctx, p) {
  const t0 = new Date().getTime();
  const rowsFor = p && p.rowsFor ? p.rowsFor : appPoolPreview_().types.filter(t => t.ok).map(t => ({ scope: 'reliability:' + t.type, value: t.pooledR, precision: t.precision, nClients: t.plans }));
  if (!rowsFor.length) throw new Error('事前分布を作れる情報源がまだありません（計画が ' + APP_POOL_MIN_PLANS + ' つ以上要ります）。');
  const remaining = p && p.remaining ? p.remaining.slice() : appReadTable_('PLANS').filter(x => x.state !== 'ARCHIVED' && !appYearIsFrozen_(x.fy)).map(x => x.plan_id);
  const done = (p && p.done) || [];
  const header = APP_ENGINE_SHEETS.POOL_PRIOR.header;
  const col = h => header.indexOf(h);
  while (remaining.length) {
    if (done.length > (p && p.done ? p.done.length : 0) && new Date().getTime() - t0 > APP_BUILD_BUDGET_MS) break;
    const planId = remaining.shift();
    appWithLock_(() => {
      appJournalRecover_(ctx);
      const plan = appPlanOf_(planId);
      if (appYearIsFrozen_(plan.fy)) { done.push({ planId: planId, skipped: true }); return; }   // 締めた年度の計画は書けない（読み取りの計算の材料としては使い続ける）
      const scratch = appWorkScratch_(plan);
      let st = null;
      do { st = appScratchBuildStep_(scratch, planId, ['POOL_PRIOR'], st && st.state, new Date().getTime() + 60000); } while (!st.complete);
      let sh = scratch.getSheetByName('POOL_PRIOR');
      if (!sh) { sh = scratch.insertSheet('POOL_PRIOR'); sh.getRange(1, 1, 1, header.length).setValues([header]); }
      const last = sh.getLastRow();
      const vals = last >= 2 ? sh.getRange(2, 1, last - 1, header.length).getValues() : [];
      let changed = 0;
      rowsFor.forEach(x => {
        const i = vals.findIndex(v => String(v[col('pool_scope')]) === x.scope && String(v[col('param_key')]) === 'reliability_r');
        const same = i >= 0 && Number(vals[i][col('pooled_value')]) === x.value && Number(vals[i][col('precision')]) === x.precision && Number(vals[i][col('n_clients')]) === x.nClients;
        if (same) return;
        const row = header.map(h => ({ pool_scope: x.scope, param_key: 'reliability_r', pooled_value: x.value, precision: x.precision, n_clients: x.nClients,
          updated_at: new Date(), updated_by: ctx.actor, note: '新アプリ: 全計画のベータ二項の経験ベイズ' })[h]);
        if (i >= 0) vals[i] = row; else vals.push(row);
        changed++;
      });
      if (changed) {
        sh.getRange(2, 1, vals.length, header.length).setValues(vals);
        const cap = appCaptureChanged_(scratch, planId, appStoredHashes_(planId), ['POOL_PRIOR']);
        if (cap.changed.length) appJournalRun_(ctx, '学習の事前分布（' + planId + '）', planId, appChangedOps_(ctx, planId, cap.changed, appId_('POOL')));
        appScratchMarkAfterSave_(scratch, planId, st.state.token, ['POOL_PRIOR'], !!st.state.reused, st.state.scope, st.state.problems);
      }
      done.push({ planId: planId, changed: changed > 0 });
    });
  }
  if (remaining.length) return { __next: { kind: 'LEARN.POOL', payload: { rowsFor: rowsFor, remaining: remaining, done: done } }, audit: { entityId: 'POOL_PRIOR' } };
  return { written: rowsFor, plans: done, audit: { entityId: 'POOL_PRIOR' } };
}

/**
 * 学びの画面に出す、着地見込みの τ・w（2026-10-08 村井さん承認の判断 29）。計画の一覧の控え（appPortfolioAll_）から読む。読めなければ null。
 * learned = 全計画の締まった月から学んだ値（試し。承認されるまで着地見込みには使わない。appLandingPrior_）:
 *   { tau, w, tauLearned（計画が足りて τ を学べたか）, wLearned（月が足りて w を学べたか）, planCount, monthCount }
 * used = 今使っている値（所有者が承認して業務の設定 landing.tau・landing.w に書いた値。無ければ 0.15 と 1。appLandingApproved_）:
 *   { tau, w, tauSet, wSet, tauFrom, wFrom }
 */
function appLandingPriorView_() {
  try {
    const pr = appPortfolioAll_().prior || {};
    const l = pr.learned || {}, u = pr.used || {};
    return {
      learned: { tau: l.tau, w: l.w, tauLearned: !!l.learned, wLearned: Number(l.months || 0) >= APP_LANDING.W_MIN_MONTHS, planCount: Number(l.plans || 0), monthCount: Number(l.months || 0) },
      used: { tau: u.tau, w: u.w, tauSet: !!u.tauSet, wSet: !!u.wSet, tauFrom: u.tauFrom || '', wFrom: u.wFrom || '' }
    };
  } catch (e) {
    Logger.log('着地見込みの学び: ' + (e && e.message ? e.message : e));
    return null;
  }
}
