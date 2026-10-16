/**
 * Methods.js — 手法ごとの予測・三角測量の重み・素の回帰との比べ（app/DESIGN_triangulation_bayes_JA.md の 1・2 章。2026-10-15 村井さん承認「全部おすすめどおり」）。
 * 段 1（v0.35.0）: 予測を実行するたびに、同じ回・同じ時点の次の値を月ごとに FORECAST_METHODS に残す（追記だけ。記録は計算に使わない）:
 *   手法（統計だけ。人の入力・AI・補正・既知のスポットは入れない。背景のスポットは足す）
 *     LAST_YEAR … 前年同月の売上（ベース + スポット。その時点で締まっていた月だけ）。比べの物差し（混ぜない）
 *     LINEAR    … 線形回帰: 旧来の土台の式（直線の傾き × 季節の波）を延ばしたもの（旧来の「線形回帰（参考）」と同じ）
 *     RECENT    … 直近を重くした回帰: 同じ直線を、新しい月ほど重く当てたもの（半減期 12 か月）× 同じ季節の波
 *     ROBUST    … 季節の中央値: 年ごとの平均に対する比の中央値の季節指数 × 直近 12 か月の水準（上下 5% で切る）
 *     SIM       … シミュレーションの中心: 線形回帰 ×（1 + 過去の外れ方の中央値）
 *     TRI       … 三角測量: 上の 4 つを、その回に使った重みで混ぜたもの（段 2 から予測の土台）
 *   手法の式は旧来の計算の computeTriangulationParts_（Forecast_Agent.js）の 1 か所だけにある（ここでは背景のスポットを足して重みで混ぜるだけ）。
 *   段（その回の本番の予測の層ごとの効き LAYER_EFFECTS から）
 *     STAT（統計の土台。段 2 から三角測量）→ PLUS_SPOT（+ 確定スポット）→ PLUS_HUMAN（+ 人）→ PLUS_AI（+ AI）→ FINAL（+ 補正。本番の真ん中）
 * 段 2（v0.36.0）: 三角測量の重みをベイズで出し（appTriWeights_）、旧来の計算に渡して予測の土台にする。使った重みは METHOD_WEIGHTS に残す。
 *   事前 = 設計書 v7 の初めの重み（0.15・0.25・0.40・0.20）、尤度 = 締まった月の外れ（実績 ÷ 予測 の対数）を正規分布とみなしたもの。
 *   1 年分（12 か月。古い月ほど軽く、半減期 12 か月）の当たり方を 1 回の観測として数える（同じメーカーの月どうしはつながっているので、
 *   月を独立に数えると重みが極端になる）。ほかのメーカーの事後を、そのメーカーの事前にする（階層の縮め。データの少ないメーカーは全体に寄る）。
 *   1 つの手法の重みは 0.05 より下げず、証拠が増えた 1 回で動けるのは ±0.10 まで（v7）。締まった月が 3 つより少なければ初めの重みのまま。
 * 比べ（分析の「素の回帰との比べ」。appMethodsCard_）: 締まった月ごとに、その月が始まる前の最後の回の値と実績で、外れ幅・偏りを出し、
 * 線形回帰との差・1 つ前の段との差を、物差しと同じ数え方（メーカーごとに平均してから 95% の幅。appBacktestClusterRatio_）で比べる。
 */

/** 記録の数え方の版（数え方を変えたら上げる。前の版の行はまとめに入れない）。M-2（段 2）: SIM をシミュレーションの中心に、TRI をその回の重みに */
const APP_METHODS_CALC_VERSION = 'M-2';
/** 手法（記録の列の順） */
const APP_METHODS_KEYS = ['LAST_YEAR', 'LINEAR', 'RECENT', 'ROBUST', 'SIM', 'TRI'];
/** 段（記録の列の順） */
const APP_METHODS_STAGES = ['STAT', 'PLUS_SPOT', 'PLUS_HUMAN', 'PLUS_AI', 'FINAL'];
/** 記録の列の名前（手法・段 → FORECAST_METHODS の列） */
const APP_METHODS_COLUMN = { LAST_YEAR: 'last_year', LINEAR: 'linear', RECENT: 'recent', ROBUST: 'robust', SIM: 'sim', TRI: 'tri',
  STAT: 'stat', PLUS_SPOT: 'plus_spot', PLUS_HUMAN: 'plus_human', PLUS_AI: 'plus_ai', FINAL: 'final' };

/** 三角測量で混ぜる手法と初めの重み（旧来の計算の TRI_PRIOR_WEIGHTS と同じ。app/tests が照らす） */
const APP_TRI_METHODS = ['LINEAR', 'RECENT', 'ROBUST', 'SIM'];
const APP_TRI_PRIOR = { LINEAR: 0.15, RECENT: 0.25, ROBUST: 0.40, SIM: 0.20 };
/** 重みの数え方の版 */
const APP_TRI_CALC_VERSION = 'W-1';
const APP_TRI_FLOOR = 0.05;          // 1 つの手法の重みの下限（v7）
const APP_TRI_STEP = 0.10;           // 証拠が増えた 1 回で動ける幅（v7）
const APP_TRI_MIN_POINTS = 3;        // これより締まった月の点が少なければ初めの重み（v7）
const APP_TRI_HALFLIFE = 12;         // 古い月ほど軽く（か月）
const APP_TRI_YEAR = 12;             // 1 年分の当たり方を 1 回の観測として数える
const APP_TRI_SIGMA2_MIN = 0.0025;   // 外れ（対数）の分散の下限（5% の二乗）

// ---- 手法の値（乱数は使わない）----

/** 数（数でなければ null） */
function appMethodsNum_(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/**
 * 手法ごとの 12 か月（年度の 4 月から）。o = { parts（旧来の computeTriangulationParts_ の BASE の 12 か月: LINEAR・RECENT・ROBUST・SIM）,
 * spotBg（12 か月の背景のスポット）, lastYear（12 か月の前年同月。分からない月は null）, weights（三角測量の重み。省けば初めの重み）}。
 * 返り値 { LAST_YEAR, LINEAR, RECENT, ROBUST, SIM, TRI }（それぞれ 12 か月。出せない月は null）。
 * TRI の混ぜ方は旧来の buildTriangulationBase_ と同じ（出せない手法は除いて割り直す）+ 背景のスポット
 */
function appMethodsCompute_(o) {
  const parts = o.parts || {};
  const spot = i => Number((o.spotBg || [])[i] || 0);
  const w = o.weights || APP_TRI_PRIOR;
  const out = { LAST_YEAR: Array.from({ length: 12 }, (_, i) => appMethodsNum_((o.lastYear || [])[i])) };
  APP_TRI_METHODS.forEach(k => { out[k] = Array.from({ length: 12 }, (_, i) => { const v = appMethodsNum_((parts[k] || [])[i]); return v === null ? null : v + spot(i); }); });
  out.TRI = Array.from({ length: 12 }, (_, i) => {
    let s = 0, ws = 0;
    APP_TRI_METHODS.forEach(k => { const v = appMethodsNum_((parts[k] || [])[i]); const wi = Math.max(0, Number(w[k]) || 0); if (v !== null && wi > 0) { s += wi * v; ws += wi; } });
    return ws > 0 ? s / ws + spot(i) : null;
  });
  return out;
}

/** 物差しの統計だけの結果（appBacktestStatRun_）から手法を出す。lastYear = 12 か月の前年同月（分からない月は null）、weights = 三角測量の重み */
function appMethodsFromStat_(stat, lastYear, weights) {
  return appMethodsCompute_({ parts: stat.parts, spotBg: stat.spotBg, lastYear: lastYear, weights: weights });
}

// ---- 三角測量の重み（ベイズ）----

/**
 * 重み t を、合計 1 で、手法ごとに lo〜hi の中に収める（t + λ を lo〜hi で切った合計が 1 になる λ を二分探索で探す。Σlo ≤ 1 ≤ Σhi のとき解がある）
 */
function appTriProject_(t, lo, hi) {
  const f = lam => APP_TRI_METHODS.reduce((a, k) => a + Math.min(hi[k], Math.max(lo[k], t[k] + lam)), 0);
  let a = -2, b = 2;
  for (let it = 0; it < 80; it++) { const m = (a + b) / 2; if (f(m) < 1) a = m; else b = m; }
  const lam = (a + b) / 2;
  const out = {};
  APP_TRI_METHODS.forEach(k => { out[k] = Math.min(hi[k], Math.max(lo[k], t[k] + lam)); });
  return out;
}

/** 合計 1 にそろえた重み（負は 0。全部 0 なら等分） */
function appTriNormalize_(w) {
  const sum = APP_TRI_METHODS.reduce((a, k) => a + Math.max(0, Number(w[k]) || 0), 0);
  const out = {};
  APP_TRI_METHODS.forEach(k => { out[k] = sum > 0 ? Math.max(0, Number(w[k]) || 0) / sum : 1 / APP_TRI_METHODS.length; });
  return out;
}

/** 重みを合計 1・どの手法も下限 APP_TRI_FLOOR 以上にする */
function appTriFloor_(w) {
  const lo = {}, hi = {};
  APP_TRI_METHODS.forEach(k => { lo[k] = APP_TRI_FLOOR; hi[k] = 1; });
  return appTriProject_(appTriNormalize_(w), lo, hi);
}

/** 前の重み prev から ±APP_TRI_STEP の中・下限 APP_TRI_FLOOR 以上・合計 1 に収める */
function appTriStep_(w, prev) {
  const p = appTriNormalize_(prev), lo = {}, hi = {};
  APP_TRI_METHODS.forEach(k => { lo[k] = Math.max(APP_TRI_FLOOR, p[k] - APP_TRI_STEP); hi[k] = Math.min(1, p[k] + APP_TRI_STEP); });
  // 前の重みが下限より小さかった手法でも解があるように（Σlo ≤ 1）
  const sumLo = APP_TRI_METHODS.reduce((a, k) => a + lo[k], 0);
  if (sumLo > 1) APP_TRI_METHODS.forEach(k => { lo[k] = APP_TRI_FLOOR; });
  return appTriProject_(appTriNormalize_(w), lo, hi);
}

/** 対数の重みを、合計 1 の重みに（大きい値で割ってから指数） */
function appTriSoftmax_(lp) {
  const mx = Math.max.apply(null, APP_TRI_METHODS.map(k => lp[k]));
  const e = {};
  let sum = 0;
  APP_TRI_METHODS.forEach(k => { e[k] = Math.exp(lp[k] - mx); sum += e[k]; });
  APP_TRI_METHODS.forEach(k => { e[k] /= sum; });
  return e;
}

/** 'yyyy/MM' どうしの月の差（b − a） */
function appTriMonths_(a, b) {
  const n = ym => { const m = /^(\d{4})\/(\d{2})$/.exec(String(ym || '')); return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null; };
  const x = n(a), y = n(b);
  return x === null || y === null ? null : y - x;
}

/**
 * 事後の重み。pts = [{ maker, ym, v: { LINEAR, RECENT, ROBUST, SIM }, actual }]（4 つそろった点だけ数える）、ownMaker = 重みを出すメーカー、
 * asOfYm = 予測の「今」の月（古さの重みの基準）。返り値 { weights（下限前の事後）, pool（ほかのメーカーの事後 = このメーカーの事前）, sigma,
 * points（数えた点）, makers（点のあるメーカー）, own（このメーカーの点）}
 */
function appTriPosterior_(pts, ownMaker, asOfYm) {
  const by = {};
  // 古さの基準は証拠の中の一番新しい月（同じ証拠なら、予測した月が変わっても同じ重み。無ければ予測の「今」の月）
  const baseYm = (pts || []).reduce((m, p) => (String(p.ym) > m ? String(p.ym) : m), '') || asOfYm;
  (pts || []).forEach(p => {
    if (!(p.actual > 0)) return;
    if (!APP_TRI_METHODS.every(k => typeof p.v[k] === 'number' && isFinite(p.v[k]) && p.v[k] > 0)) return;
    const age = Math.max(0, appTriMonths_(p.ym, baseYm) || 0);
    const r = Math.pow(0.5, age / APP_TRI_HALFLIFE);
    const o = by[p.maker] = by[p.maker] || { n: 0, cnt: 0, sse: {} };
    o.n += r; o.cnt++;
    APP_TRI_METHODS.forEach(k => { const e = Math.log(p.actual / p.v[k]); o.sse[k] = (o.sse[k] || 0) + r * e * e; });
  });
  const makers = Object.keys(by);
  const mse = m => { const o = by[m]; const x = {}; APP_TRI_METHODS.forEach(k => { x[k] = o.sse[k] / o.n; }); return x; };
  let num = 0, den = 0;
  makers.forEach(m => { const x = mse(m); APP_TRI_METHODS.forEach(k => { num += by[m].n * x[k]; }); den += by[m].n * APP_TRI_METHODS.length; });
  const sigma2 = Math.max(APP_TRI_SIGMA2_MIN, den > 0 ? num / den : APP_TRI_SIGMA2_MIN);
  const strength = m => Math.min(by[m].n, APP_TRI_YEAR) / APP_TRI_YEAR;
  const lp = {};
  APP_TRI_METHODS.forEach(k => { lp[k] = Math.log(APP_TRI_PRIOR[k]); });
  makers.filter(m => m !== String(ownMaker)).forEach(m => { const x = mse(m); APP_TRI_METHODS.forEach(k => { lp[k] -= 0.5 * strength(m) * x[k] / sigma2; }); });
  const pool = appTriSoftmax_(lp);
  const lo = {};
  APP_TRI_METHODS.forEach(k => { lo[k] = Math.log(pool[k]); });
  if (by[ownMaker]) { const x = mse(ownMaker); APP_TRI_METHODS.forEach(k => { lo[k] -= 0.5 * strength(ownMaker) * x[k] / sigma2; }); }
  return { weights: appTriSoftmax_(lo), pool: pool, sigma: Math.sqrt(sigma2), points: makers.reduce((a, m) => a + by[m].cnt, 0), makers: makers.length,
    own: by[ownMaker] ? by[ownMaker].cnt : 0 };
}

/**
 * 重みの証拠: 全部の計画（片付けた計画は除く）の、予測の「今」（asOfMs）までに締まった月の点。物差し（今の数え方 BT-3 の、区切りごとに一番新しい回）と、
 * 本番の記録（FORECAST_METHODS の今の数え方。各月が始まる前の最後の回）。返り値 [{ maker, plan, ym, src, v, actual }]
 */
function appTriEvidence_(asOfMs) {
  const day = Utilities.formatDate(new Date(asOfMs), APP_TZ, 'yyyy-MM-dd');
  const out = [];
  appReadTable_('PLANS').filter(p => p.state !== 'ARCHIVED').forEach(p => {
    const bt = appReadPlanTable_('BACKTEST', p.plan_id).filter(r => String(r.calc_version) === APP_BACKTEST_CALC_VERSION);
    const lastOf = {};
    bt.forEach(r => { const b = lastOf[r.cutoff_ym]; if (!b || String(r.computed_at) > String(b.computed_at) || (String(r.computed_at) === String(b.computed_at) && r._row > b._row)) lastOf[r.cutoff_ym] = r; });
    const pt = {};
    bt.forEach(r => {
      const last = lastOf[r.cutoff_ym];
      if (!last || r.bt_id !== last.bt_id || !r.counted || typeof r.actual !== 'number' || !appActualClosed_(r.target_ym, day)) return;
      if (APP_TRI_METHODS.indexOf(r.method) < 0) return;
      const o = pt[r.bt_id + '\u0001' + r.target_ym] = pt[r.bt_id + '\u0001' + r.target_ym] || { maker: p.client_id, plan: p.plan_id, ym: r.target_ym, src: 'BACKTEST', v: {}, actual: r.actual, cutoff: r.cutoff_ym };
      o.v[r.method] = appMethodsNum_(r.p50);
    });
    Object.keys(pt).forEach(k => out.push(Object.assign(pt[k], { stamp: String(lastOf[pt[k].cutoff] ? lastOf[pt[k].cutoff].computed_at : '') })));
    appMethodsLivePoints_(p).pts.forEach(x => {
      if (!appActualClosed_(x.ym, day)) return;
      const v = {};
      APP_TRI_METHODS.forEach(k => { v[k] = appMethodsNum_(x.row[APP_METHODS_COLUMN[k]]); });
      out.push({ maker: p.client_id, plan: p.plan_id, ym: x.ym, src: 'LIVE', v: v, actual: x.actual, stamp: String(x.row.recorded_at || '') });
    });
  });
  // 同じメーカー・同じ出どころ・同じ月は 1 点だけ（年度の違う計画・区切りの違う物差しで同じ月を二重に数えない）。新しい方を残す
  const keep = {};
  out.forEach(p => { const k = p.maker + '\u0001' + p.src + '\u0001' + p.ym; if (!keep[k] || String(p.stamp) > String(keep[k].stamp)) keep[k] = p; });
  return Object.keys(keep).sort().map(k => keep[k]);
}

/**
 * その計画の予測に使う三角測量の重み（予測の計算の段で、旧来の予測を動かす前に）。失敗したら初めの重み（エラーのログに残す）。返り値:
 * { weights（使う重み。合計 1）, posterior（下限・幅の前の事後）, basis（PRIOR = 初めの重み・POSTERIOR = 証拠から）, points, makers, own, sigma,
 *   hash（証拠の印。同じ証拠なら同じ重み = 何も変えずに予測し直しても数字が揺れない）, prev（幅の基準にした前の重み）}
 * 幅の基準: 証拠の印が今と違う、一番新しい記録の重み（無ければ初めの重み）。同じ証拠のまま何回予測しても、重みは動かない
 */
function appTriWeights_(ctx, plan, asOfMs) {
  try {
    const pts = appTriEvidence_(asOfMs);
    const asOfYm = Utilities.formatDate(new Date(asOfMs), APP_TZ, 'yyyy/MM');
    const hash = appSha256Hex_(pts.map(p => [p.plan, p.src, p.ym, p.actual].concat(APP_TRI_METHODS.map(k => p.v[k])).join(',')).sort().join('|'));
    const post = appTriPosterior_(pts, plan.client_id, asOfYm);
    let prev = null;
    try {
      appReadPlanTable_('METHOD_WEIGHTS', plan.plan_id).filter(r => String(r.calc_version) === APP_TRI_CALC_VERSION && r.evidence_hash !== hash)
        .forEach(r => { if (!prev || String(r.recorded_at) > String(prev.recorded_at) || (String(r.recorded_at) === String(prev.recorded_at) && r._row > prev._row)) prev = r; });
    } catch (e) { prev = null; }   // 表の版がそろう前
    const prevW = prev ? { LINEAR: Number(prev.w_linear), RECENT: Number(prev.w_recent), ROBUST: Number(prev.w_robust), SIM: Number(prev.w_sim) } : Object.assign({}, APP_TRI_PRIOR);
    const enough = post.points >= APP_TRI_MIN_POINTS;
    const weights = enough ? appTriStep_(post.weights, prevW) : Object.assign({}, APP_TRI_PRIOR);
    return { weights: weights, posterior: enough ? post.weights : null, basis: enough ? 'POSTERIOR' : 'PRIOR', points: post.points, makers: post.makers, own: post.own,
      sigma: post.points ? post.sigma : null, hash: hash, prev: prevW };
  } catch (e) {
    appLogError_('LOG.METHOD_WEIGHTS', e, ctx);
    return { weights: Object.assign({}, APP_TRI_PRIOR), posterior: null, basis: 'PRIOR', points: 0, makers: 0, own: 0, sigma: null, hash: '', prev: null };
  }
}

/**
 * 予測の計算から保存へ渡す中身を小さくする（1 つの処理に渡せるのは約 8,000 バイト。Jobs.js の appEnqueueJob_）:
 * 手法の値は円に丸め、重み・効き係数は小数 6 桁に、記録に使わない「前の値」（prev）は渡さない
 */
function appPayloadCompact_(methods, tri, eff) {
  const r6 = v => (typeof v === 'number' && isFinite(v) ? Math.round(v * 1e6) / 1e6 : v);
  const obj6 = o => { if (!o || typeof o !== 'object') return o; const x = {}; Object.keys(o).forEach(k => { x[k] = r6(o[k]); }); return x; };
  const m = methods ? { v: {}, ms: methods.ms, triUsed: methods.triUsed } : null;
  if (m) Object.keys(methods.v || {}).forEach(k => { m.v[k] = (methods.v[k] || []).map(v => (typeof v === 'number' && isFinite(v) ? Math.round(v) : v)); });
  const t = tri ? Object.assign({}, tri, { weights: obj6(tri.weights), posterior: obj6(tri.posterior), sigma: r6(tri.sigma) }) : tri;
  if (t) delete t.prev;
  const e = eff ? Object.assign({}, obj6(eff), { posterior: obj6(eff.posterior) }) : eff;
  if (e) { delete e.prev; e.hash = eff.hash; e.basis = eff.basis; e.capped = eff.capped; }
  return { methods: m, tri: t, eff: e };
}

/** 予測の保存の段で足す METHOD_WEIGHTS の 1 行（使った重みと証拠）。重みが無ければ足さない */
function appTriWeightsOps_(ctx, plan, p) {
  try {
    const t = p.tri;
    if (!t || !t.weights) return [];
    if (p.methods && p.methods.triUsed === false) return [];   // 三角測量を使わなかった回（TRIANGULATION_ENABLED = 0・DLM が primary）は記録しない（根拠に土台のカードを出さない）
    return appLogOps_('METHOD_WEIGHTS', [{ plan_id: plan.plan_id, weight_id: appStableLogId_(APP_LOG_PREFIX.METHOD_WEIGHTS, [p.runId]), run_id: p.runId,
      as_of: Utilities.formatDate(new Date(p.asOfMs), APP_TZ, "yyyy-MM-dd'T'HH:mm:ssZ"),
      w_linear: t.weights.LINEAR, w_recent: t.weights.RECENT, w_robust: t.weights.ROBUST, w_sim: t.weights.SIM, basis: t.basis,
      posterior_json: t.posterior || null, evidence_points: t.points, evidence_makers: t.makers, own_points: t.own, sigma: t.sigma,
      evidence_hash: t.hash, calc_version: APP_TRI_CALC_VERSION, recorded_at: appNowIso_() }]);
  } catch (e) {
    appLogError_('LOG.METHOD_WEIGHTS', e, ctx);
    return [];
  }
}

/**
 * 根拠の「予測の土台」（その回の重みと、手法ごとの 12 か月の合計）。記録が無ければ null（段 2 より前の回）。
 * 返り値 { weights: { LINEAR, RECENT, ROBUST, SIM }, basis, points, makers, own, sums: { LINEAR, RECENT, ROBUST, SIM, TRI }（背景のスポット込み）}
 */
function appBasisTriangulation_(planId, runId) {
  if (!runId) return null;
  try {
    const w = appReadPlanTable_('METHOD_WEIGHTS', planId).filter(r => r.run_id === runId)[0];
    if (!w) return null;
    const rows = appReadPlanTable_('FORECAST_METHODS', planId).filter(r => r.run_id === runId);
    const sums = {};
    APP_TRI_METHODS.concat(['TRI']).forEach(k => {
      const xs = rows.map(r => appMethodsNum_(r[APP_METHODS_COLUMN[k]]));
      sums[k] = xs.length === 12 && xs.every(v => v !== null) ? xs.reduce((a, b) => a + b, 0) : null;
    });
    const n = v => appMethodsNum_(v);
    // 三角測量の画面（2026-10-16）: 手法と段の 12 か月（年度の 4 月から）と年度の合計・このメーカーの物差しの外れ幅（予算策定の補助。読むだけ）
    const keys = APP_METHODS_KEYS.concat(APP_METHODS_STAGES);
    keys.forEach(k => {
      if (sums[k] !== undefined) return;
      const xs = rows.map(r => n(r[APP_METHODS_COLUMN[k]]));
      sums[k] = xs.length === 12 && xs.every(v => v !== null) ? xs.reduce((a, b) => a + b, 0) : null;
    });
    const months = rows.slice().sort((x, y) => String(x.ym).localeCompare(String(y.ym)))
      .map(r => { const v = {}; keys.forEach(k => { v[k] = n(r[APP_METHODS_COLUMN[k]]); }); return { ym: String(r.ym), actual: r.source === 'actual_closed', v: v }; });
    return { weights: { LINEAR: n(w.w_linear), RECENT: n(w.w_recent), ROBUST: n(w.w_robust), SIM: n(w.w_sim) }, basis: String(w.basis || ''),
      points: n(w.evidence_points) || 0, makers: n(w.evidence_makers) || 0, own: n(w.own_points) || 0, sums: sums, months: months, acc: appTriPlanAcc_(planId) };
  } catch (e) {
    return null;   // 表の版がそろう前
  }
}

/**
 * このメーカーの手法ごとの外れ幅（三角測量の画面。物差し = 年度の初めに戻って予測し直した、いちばん新しい回の数えた月）。
 * 返り値 { fy, n, mape: { 手法: Σ|予測 − 実績| ÷ Σ実績 } }。物差しが無ければ null
 */
function appTriPlanAcc_(planId) {
  try {
    const plan = appReadTable_('PLANS').filter(p => p.plan_id === planId)[0];
    if (!plan) return null;
    const cut = Number(plan.fy) + '/04';
    const rows = appReadPlanTable_('BACKTEST', planId).filter(r => String(r.cutoff_ym) === cut && String(r.calc_version) === APP_BACKTEST_CALC_VERSION);
    const last = rows.reduce((b, r) => (!b || String(r.computed_at) > String(b.computed_at) || (String(r.computed_at) === String(b.computed_at) && r._row > b._row) ? r : b), null);
    if (!last) return null;
    const by = {}, yms = {};
    rows.filter(r => r.bt_id === last.bt_id && r.counted && typeof r.actual === 'number' && r.actual > 0 && typeof r.p50 === 'number').forEach(r => {
      if (APP_METHODS_KEYS.indexOf(r.method) < 0) return;
      const o = by[r.method] = by[r.method] || { e: 0, a: 0 };
      o.e += Math.abs(r.p50 - r.actual); o.a += r.actual; yms[r.target_ym] = 1;
    });
    const mape = {};
    Object.keys(by).forEach(k => { mape[k] = by[k].a > 0 ? by[k].e / by[k].a : null; });
    return { fy: String(plan.fy), n: Object.keys(yms).length, mape: mape };
  } catch (e) {
    return null;   // 表の版がそろう前
  }
}

// ---- 本番の予測の回（予測の計算 FORECAST.RUN_CALC → 保存 FORECAST.RUN_SAVE）----

/**
 * 本番の予測の回の手法（計算の段で、旧来の予測を動かした後の計算用ブックで、統計の部分だけをもう一度動かす）。
 * 売上の表は旧来の予測が作り直したものをそのまま読む（作り直さない。計算用ブックは書き換えない）。乱数の種は予測の種から決める。
 * 三角測量は、その回に使った重み（weights）で混ぜる。失敗しても予測は止めない（エラーのログに残し null）。返り値 { v: 手法ごとの 12 か月, ms }
 */
function appMethodsLive_(ctx, plan, book, p, seed, weights) {
  const t0 = new Date().getTime();
  try {
    const fy = Number(plan.fy);
    const stat = appBacktestStatRun_(book, { fy: fy, asOfMs: p.asOfMs, closed: null, skipSync: true, light: true,   // シミュレーションは使わない（手法は土台の式から）
      seed: appSha256Hex_(['methods-seed-v1', seed].join('|')), uuidSeed: p.runId + '-M', actor: ctx.actor });
    const day = Utilities.formatDate(new Date(p.asOfMs), APP_TZ, 'yyyy-MM-dd');
    const startYm = (fy - 4) + '/04';
    const lastYear = Array.from({ length: 12 }, (_, i) => (appActualClosed_(appBacktestYmAdd_(startYm, 36 + i), day) ? Number(stat.total48[36 + i] || 0) : null));
    // triUsed: 統計の部分を同じ計算用ブック（CONFIG・DLM の設定）で動かしたとき、三角測量の土台を使ったか（本番の A-9 と同じ決まり）
    return { v: appMethodsFromStat_(stat, lastYear, weights), ms: new Date().getTime() - t0, triUsed: !!stat.triWeights };
  } catch (e) {
    appLogError_('LOG.FORECAST_METHODS', e, ctx);
    return null;
  }
}

/**
 * 予測の保存の段で足す FORECAST_METHODS の 12 行（appJournalRun_ に渡す ops）。methods = appMethodsLive_ の結果（無ければ手法の列は空）、
 * layerOps = 同じ回の層ごとの効きの ops（段の値をそこから出す。無ければ最終だけ）、headline = 予測の主な結果（月ごとの真ん中）
 */
function appMethodsOps_(ctx, plan, p, headline, layerOps) {
  try {
    const layer = {};
    (layerOps || []).forEach(op => { if (op.table === 'LAYER_EFFECTS') (op.rows || []).forEach(r => { layer[r.ym] = r; }); });
    const v = (p.methods && p.methods.v) || {};
    const now = appNowIso_();
    const rows = ((headline && headline.monthly) || []).map((m, i) => {
      const L = layer[m.month];
      const n = x => appMethodsNum_(x);
      const stat = L ? n(L.stat_p50) : null;
      const sum = (a, b) => (a === null || n(b) === null ? null : a + n(b));
      const plusSpot = sum(stat, L && L.spot_yen), plusHuman = sum(plusSpot, L && L.human_yen), plusAi = sum(plusHuman, L && L.ai_yen);
      const row = { plan_id: plan.plan_id, method_row_id: appStableLogId_(APP_LOG_PREFIX.FORECAST_METHODS, [p.runId, m.month]), run_id: p.runId, ym: m.month,
        source: L ? L.source : '', stat: stat, plus_spot: plusSpot, plus_human: plusHuman, plus_ai: plusAi,
        final: L && n(L.final_p50) !== null ? n(L.final_p50) : n(m.p50), calc_version: APP_METHODS_CALC_VERSION, recorded_at: now };
      APP_METHODS_KEYS.forEach(k => { row[APP_METHODS_COLUMN[k]] = v[k] ? n(v[k][i]) : null; });
      return row;
    });
    return appLogOps_('FORECAST_METHODS', rows);
  } catch (e) {
    appLogError_('LOG.FORECAST_METHODS', e, ctx);
    return [];
  }
}

// ---- 分析の「素の回帰との比べ」----

/**
 * 本番の記録の点: 年度 fy の計画ごとに、締まった月ごとに、その月が始まる前（「今」< 月の 1 日）の最後の回の記録の行と、実績。
 * 返り値 { recs（その計画の今の数え方の記録の行の数）, pts: [{ plan_id, ym, row（FORECAST_METHODS の行）, actual }] }
 */
function appMethodsLivePoints_(plan) {
  // 1 回の実行の中で計画ごとに 1 回だけ作る（重みと効き係数の両方が使う。書き込みがあれば appStoreForget_ が捨てる）
  const memo = APP_STORE_CACHE_.livePts = APP_STORE_CACHE_.livePts || {};
  if (memo[plan.plan_id]) return memo[plan.plan_id];
  const recs = appReadPlanTable_('FORECAST_METHODS', plan.plan_id).filter(r => String(r.calc_version) === APP_METHODS_CALC_VERSION);
  if (!recs.length) return (memo[plan.plan_id] = { recs: 0, pts: [] });   // 記録が無ければ、実績の表を読まない
  const yms = appLandingFyYms_(Number(plan.fy));
  const days = appBacktestImportDays_(plan.plan_id);
  const actual = appBacktestActuals_(plan.plan_id, yms, days.actuals);
  const runs = appMethodsRunsOf_(plan.plan_id);
  const out = [];
  yms.forEach(ym => {
    const a = actual[ym];
    if (a === null || a === undefined) return;
    const start = appMonthStartMs_(ym);
    const best = recs.filter(r => r.ym === ym && runs[r.run_id] && runs[r.run_id].at < start && r.source !== 'actual_closed')
      .sort((x, y) => runs[y.run_id].at - runs[x.run_id].at || runs[y.run_id].fin.localeCompare(runs[x.run_id].fin) || runs[y.run_id].row - runs[x.run_id].row)[0];
    if (best) out.push({ plan_id: plan.plan_id, ym: ym, row: best, actual: a });
  });
  return (memo[plan.plan_id] = { recs: recs.length, pts: out });
}

/** 計画の済んだ予測の回（{ run_id: { at, fin, row } }）。FORECAST_RUNS を 1 回の実行で 1 回だけ計画ごとに分ける */
function appMethodsRunsOf_(planId) {
  if (!APP_STORE_CACHE_.runsByPlan) {
    const by = {};
    appReadTable_('FORECAST_RUNS').forEach(r => {
      if (r.status !== 'DONE') return;
      const at = appLandingTime_('', r.as_of);
      if (at !== null) (by[r.plan_id] = by[r.plan_id] || {})[r.run_id] = { at: at, fin: String(r.finished_at || ''), row: r._row };
    });
    APP_STORE_CACHE_.runsByPlan = by;
  }
  return APP_STORE_CACHE_.runsByPlan[planId] || {};
}

/**
 * 点をまとめる。pts = [{ maker, ym, v: { 手法・段: 値 }, actual }]、keys = 並べる手法・段。返り値:
 *   rows: [{ key, n, makers, mape・mapeLo・mapeHi, bias・biasLo・biasHi,
 *            vsLinear: { diff, lo, hi, n, makers, verdict }（線形回帰との外れ幅の差。LINEAR 自身は null）,
 *            vsPrev: 同じ形（1 つ前の段との差。段の 2 つ目から。手法は null）}]
 *   verdict は appBacktestSummary_ と同じ: oneMaker・wait・smaller・larger・unclear
 */
function appMethodsSummary_(pts, keys, stages) {
  const ok = (p, k) => typeof p.v[k] === 'number' && isFinite(p.v[k]) && p.actual > 0;
  const by = (k, f) => pts.filter(p => ok(p, k)).reduce((o, p) => { (o[p.maker] = o[p.maker] || []).push(f(p)); return o; }, {});
  const diff = (k, vs) => {
    const b = {};
    pts.filter(p => ok(p, k) && ok(p, vs)).forEach(p => { (b[p.maker] = b[p.maker] || []).push([Math.abs(p.v[k] - p.actual) - Math.abs(p.v[vs] - p.actual), p.actual]); });
    const d = appBacktestClusterRatio_(b);
    const verdict = d.n && d.makers < APP_BACKTEST_MIN_MAKERS ? 'oneMaker' : d.n < APP_BACKTEST_MIN_POINTS || d.lo === null ? 'wait'
      : d.hi < 0 ? 'smaller' : d.lo > 0 ? 'larger' : 'unclear';
    return { vs: vs, diff: d.mean, lo: d.lo, hi: d.hi, n: d.n, makers: d.makers, verdict: verdict };
  };
  return keys.map(k => {
    const a = appBacktestClusterRatio_(by(k, p => [Math.abs(p.v[k] - p.actual), p.actual]));
    const b = appBacktestClusterRatio_(by(k, p => [p.v[k] - p.actual, p.actual]));
    const si = (stages || []).indexOf(k);
    return { key: k, n: a.n, makers: a.makers, mape: a.mean, mapeLo: a.lo, mapeHi: a.hi, bias: b.mean, biasLo: b.lo, biasHi: b.hi,
      vsLinear: k === 'LINEAR' ? null : diff(k, 'LINEAR'), vsPrev: si > 0 ? diff(k, stages[si - 1]) : null };
  });
}

/**
 * 分析の画面の「素の回帰との比べ」（年度 fy の計画）。金額は出さない（割合と点の数だけ）。記録も物差しの回も無ければ null。返り値:
 *   live: { rows（手法と段。appMethodsSummary_）, points, makers, ready } … 本番の記録（各月が始まる前の最後の回）
 *   back: { rows（手法だけ）, points, makers, ready } … 物差し（年度の初め 4/1 に戻って予測し直したもの。新しい手法は足した後に動かした回だけ）
 *   minPoints・minMakers（比べる境目）
 */
function appMethodsCard_(fy) {
  const plans = appReadTable_('PLANS').filter(p => String(p.fy) === String(fy) && p.state !== 'ARCHIVED');
  const livePts = [];
  const backPts = [];
  let recs = 0, backRuns = 0;
  try {
    plans.forEach(p => {
      const lp = appMethodsLivePoints_(p);
      recs += lp.recs;
      lp.pts.forEach(x => {
        const v = {};
        APP_METHODS_KEYS.concat(APP_METHODS_STAGES).forEach(k => { v[k] = appMethodsNum_(x.row[APP_METHODS_COLUMN[k]]); });
        livePts.push({ maker: p.client_id, ym: x.ym, v: v, actual: x.actual });
      });
      // 物差し: その年度の初めを区切りにした今の数え方の回のうち、一番新しい回（appBacktestCard_ と同じ選び方）
      const rows = appReadPlanTable_('BACKTEST', p.plan_id).filter(r => String(r.cutoff_ym) === Number(fy) + '/04' && String(r.calc_version) === APP_BACKTEST_CALC_VERSION);
      const last = rows.reduce((b, r) => (!b || String(r.computed_at) > String(b.computed_at) || (String(r.computed_at) === String(b.computed_at) && r._row > b._row) ? r : b), null);
      if (!last) return;
      backRuns++;
      const pt = {};
      rows.filter(r => r.bt_id === last.bt_id && r.counted && typeof r.actual === 'number').forEach(r => {
        const o = pt[r.target_ym] = pt[r.target_ym] || { maker: p.client_id, ym: r.target_ym, v: {}, actual: r.actual };
        const k = r.method;
        if (APP_METHODS_KEYS.indexOf(k) >= 0) o.v[k] = appMethodsNum_(r.p50);
      });
      Object.keys(pt).forEach(ym => backPts.push(pt[ym]));
    });
  } catch (e) { return null; }   // 表の版がそろう前（表が無い）
  if (!recs && !backRuns) return null;
  const pack = (pts, keys, stages) => {
    const makers = Object.keys(pts.reduce((o, x) => { o[x.maker] = 1; return o; }, {})).length;
    return { rows: appMethodsSummary_(pts, keys, stages), points: pts.length, makers: makers,
      ready: pts.length >= APP_BACKTEST_MIN_POINTS && makers >= APP_BACKTEST_MIN_MAKERS };
  };
  return { fy: String(fy), records: recs, backRuns: backRuns, live: pack(livePts, APP_METHODS_KEYS.concat(APP_METHODS_STAGES), APP_METHODS_STAGES),
    back: pack(backPts, APP_METHODS_KEYS, []), minPoints: APP_BACKTEST_MIN_POINTS, minMakers: APP_BACKTEST_MIN_MAKERS };
}
