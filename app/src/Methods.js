/**
 * Methods.js — 手法ごとの予測と、素の回帰との比べ（段 1。app/DESIGN_triangulation_bayes_JA.md の 1・2 章。2026-10-15 村井さん承認「全部おすすめどおり」）。
 * 予測を実行するたびに、同じ回・同じ時点の次の値を月ごとに FORECAST_METHODS に残す（追記だけ。記録は計算に使わない。予測の数字・種は変えない）:
 *   手法（統計だけ。人の入力・AI・補正・既知のスポットは入れない）
 *     LAST_YEAR … 前年同月の売上（ベース + スポット。その時点で締まっていた月だけ）。比べの物差し（混ぜない）
 *     LINEAR    … 線形回帰: 旧来の土台の式（直線の傾き × 季節の波。fitOpsModelTrendSeason_）を延ばしたもの + 背景のスポット（旧来の「線形回帰（参考）」と同じ）
 *     RECENT    … 直近を重くした回帰: 同じ直線を、新しい月ほど重く当てたもの（半減期 12 か月）× 同じ季節の波 + 背景のスポット
 *     ROBUST    … ロバスト季節: 年ごとの平均に対する比の中央値の季節指数 × 直近 12 か月の水準（上下 5% で切る）+ 背景のスポット
 *     SIM       … シミュレーション: 旧来の統計の部分だけの混合シミュレーションの真ん中（物差しの STAT_ONLY と同じ計算）
 *     TRI       … 三角測量（試し）: LINEAR・ROBUST・RECENT・SIM を設計書 v7 の初めの重み（0.15・0.40・0.25・0.20）で混ぜたもの。段 2 で予測の土台にする前の記録
 *   段（その回の本番の予測の層ごとの効き LAYER_EFFECTS から）
 *     STAT（統計の土台。旧来の「過去売上のみ」）→ PLUS_SPOT（+ 確定スポット）→ PLUS_HUMAN（+ 人）→ PLUS_AI（+ AI）→ FINAL（+ 補正。本番の真ん中）
 * 比べ（分析の「素の回帰との比べ」。appMethodsCard_）: 締まった月ごとに、その月が始まる前の最後の回の値と実績で、外れ幅・偏りを出し、
 * 線形回帰との差・1 つ前の段との差を、物差しと同じ数え方（メーカーごとに平均してから 95% の幅。appBacktestClusterRatio_）で比べる。
 * 過去の分は物差し（Backtest.js）に同じ手法を足して、年度の初め（4/1）に戻って予測し直したもので見る。
 */

/** 記録の数え方の版（数え方を変えたら上げる。前の版の行はまとめに入れない） */
const APP_METHODS_CALC_VERSION = 'M-1';
/** 直近を重くした回帰の半減期（か月） */
const APP_METHODS_RECENT_HALFLIFE = 12;
/** 三角測量（試し）の重み（設計書 v7 の初めの重み。段 2 でベイズの重みに置き換える） */
const APP_METHODS_TRI_PRIOR = { LINEAR: 0.15, ROBUST: 0.40, RECENT: 0.25, SIM: 0.20 };
/** ロバスト季節の水準を出すときに切る上下の割合 */
const APP_METHODS_WINSOR = [0.05, 0.95];
/** 手法（記録の列の順） */
const APP_METHODS_KEYS = ['LAST_YEAR', 'LINEAR', 'RECENT', 'ROBUST', 'SIM', 'TRI'];
/** 段（記録の列の順） */
const APP_METHODS_STAGES = ['STAT', 'PLUS_SPOT', 'PLUS_HUMAN', 'PLUS_AI', 'FINAL'];
/** 記録の列の名前（手法・段 → FORECAST_METHODS の列） */
const APP_METHODS_COLUMN = { LAST_YEAR: 'last_year', LINEAR: 'linear', RECENT: 'recent', ROBUST: 'robust', SIM: 'sim', TRI: 'tri',
  STAT: 'stat', PLUS_SPOT: 'plus_spot', PLUS_HUMAN: 'plus_human', PLUS_AI: 'plus_ai', FINAL: 'final' };

// ---- 手法の計算（乱数は使わない）----

/** 数（数でなければ null） */
function appMethodsNum_(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/** 重み付きの直線（x = 1..n）。返り値 { slope, intercept }。重みの合計が 0 なら null */
function appMethodsWls_(y, w) {
  let sw = 0, sx = 0, sy = 0;
  y.forEach((v, i) => { sw += w[i]; sx += w[i] * (i + 1); sy += w[i] * v; });
  if (!(sw > 0)) return null;
  const mx = sx / sw, my = sy / sw;
  let sxx = 0, sxy = 0;
  y.forEach((v, i) => { const dx = i + 1 - mx; sxx += w[i] * dx * dx; sxy += w[i] * dx * (v - my); });
  const slope = sxx > 0 ? sxy / sxx : 0;
  return { slope: slope, intercept: my - slope * mx };
}

/** 中央値（空なら null） */
function appMethodsMedian_(xs) {
  const v = xs.slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** 分位点（線形補間。空なら null） */
function appMethodsQuantile_(xs, q) {
  const v = xs.slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

/**
 * ロバスト季節の指数（12）: 年（12 か月ずつ）ごとの平均に対する比の、同じ月どうしの中央値。平均が 1 になるようにそろえる。
 * 比が取れない月は 1
 */
function appMethodsRobustSeason_(y) {
  const years = Math.floor(y.length / 12);
  const idx = [];
  for (let m = 0; m < 12; m++) {
    const rs = [];
    for (let k = 0; k < years; k++) {
      const seg = y.slice(k * 12, k * 12 + 12);
      const mean = seg.reduce((a, b) => a + b, 0) / 12;
      const v = y[k * 12 + m];
      if (mean > 0 && isFinite(v) && v >= 0) rs.push(v / mean);
    }
    const md = appMethodsMedian_(rs);
    idx.push(md === null ? 1 : md);
  }
  const avg = idx.reduce((a, b) => a + b, 0) / 12;
  return avg > 0 ? idx.map(v => v / avg) : idx.map(() => 1);
}

/**
 * 手法ごとの 12 か月（年度の 4 月から）。o = { y（48 か月の土台の売上。旧来の締まっていない月を補った並び）, model（旧来の土台の式
 * { slope, intercept, seasonalIndex }）, spotBg（12 か月の背景のスポット）, sim（12 か月のシミュレーションの真ん中）, lastYear（12 か月の前年同月。分からない月は null）}。
 * 返り値 { LAST_YEAR, LINEAR, RECENT, ROBUST, SIM, TRI }（それぞれ 12 か月。出せない月は null）
 */
function appMethodsCompute_(o) {
  const y = (o.y || []).map(v => Number(v) || 0);
  const n = y.length;
  const S = (o.model && o.model.seasonalIndex) || new Array(12).fill(1);
  const spot = i => Number((o.spotBg || [])[i] || 0);
  const out = {};
  out.LAST_YEAR = Array.from({ length: 12 }, (_, i) => appMethodsNum_((o.lastYear || [])[i]));
  out.SIM = Array.from({ length: 12 }, (_, i) => appMethodsNum_((o.sim || [])[i]));
  const line = (a, b) => Array.from({ length: 12 }, (_, i) => Math.max(0, (a + b * (n + i + 1)) * S[i % 12]) + spot(i));
  out.LINEAR = o.model && n ? line(Number(o.model.intercept) || 0, Number(o.model.slope) || 0) : new Array(12).fill(null);
  const w = y.map((_, i) => Math.pow(0.5, (n - (i + 1)) / APP_METHODS_RECENT_HALFLIFE));
  const r = n ? appMethodsWls_(y, w) : null;
  out.RECENT = r ? line(r.intercept, r.slope) : new Array(12).fill(null);
  if (n >= 12) {
    const R = appMethodsRobustSeason_(y);
    const lo = appMethodsQuantile_(y, APP_METHODS_WINSOR[0]), hi = appMethodsQuantile_(y, APP_METHODS_WINSOR[1]);
    const last = y.slice(n - 12).map(v => Math.min(hi, Math.max(lo, v)));
    const level = last.reduce((a, b) => a + b, 0) / 12;
    out.ROBUST = Array.from({ length: 12 }, (_, i) => Math.max(0, level * R[(n + i) % 12]) + spot(i));
  } else {
    out.ROBUST = new Array(12).fill(null);
  }
  out.TRI = Array.from({ length: 12 }, (_, i) => {
    let s = 0, ws = 0;
    Object.keys(APP_METHODS_TRI_PRIOR).forEach(k => { const v = out[k][i]; if (v !== null) { s += APP_METHODS_TRI_PRIOR[k] * v; ws += APP_METHODS_TRI_PRIOR[k]; } });
    return ws > 0 ? s / ws : null;
  });
  return out;
}

/** 物差しの統計だけの結果（appBacktestStatRun_）から手法を出す。lastYear = 12 か月の前年同月（分からない月は null） */
function appMethodsFromStat_(stat, lastYear) {
  return appMethodsCompute_({ y: stat.y, model: stat.model, spotBg: stat.spotBg, sim: stat.p50, lastYear: lastYear });
}

// ---- 本番の予測の回（予測の計算 FORECAST.RUN_CALC → 保存 FORECAST.RUN_SAVE）----

/**
 * 本番の予測の回の手法（計算の段で、旧来の予測を動かした後の計算用ブックで、統計の部分だけをもう一度動かす）。
 * 売上の表は旧来の予測が作り直したものをそのまま読む（作り直さない。計算用ブックは書き換えない）。乱数の種は予測の種から決める（同じ入力なら同じ数字）。
 * 失敗しても予測は止めない（エラーのログに残し null）。返り値 { v: 手法ごとの 12 か月, ms }
 */
function appMethodsLive_(ctx, plan, book, p, seed) {
  const t0 = new Date().getTime();
  try {
    const fy = Number(plan.fy);
    const stat = appBacktestStatRun_(book, { fy: fy, asOfMs: p.asOfMs, closed: null, skipSync: true,
      seed: appSha256Hex_(['methods-seed-v1', seed].join('|')), uuidSeed: p.runId + '-M', actor: ctx.actor });
    const day = Utilities.formatDate(new Date(p.asOfMs), APP_TZ, 'yyyy-MM-dd');
    const startYm = (fy - 4) + '/04';
    const lastYear = Array.from({ length: 12 }, (_, i) => (appActualClosed_(appBacktestYmAdd_(startYm, 36 + i), day) ? Number(stat.total48[36 + i] || 0) : null));
    return { v: appMethodsFromStat_(stat, lastYear), ms: new Date().getTime() - t0 };
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
  const yms = appLandingFyYms_(Number(plan.fy));
  const days = appBacktestImportDays_(plan.plan_id);
  const actual = appBacktestActuals_(plan.plan_id, yms, days.actuals);
  const recs = appReadPlanTable_('FORECAST_METHODS', plan.plan_id).filter(r => String(r.calc_version) === APP_METHODS_CALC_VERSION);
  if (!recs.length) return { recs: 0, pts: [] };
  const runs = {};
  appReadTable_('FORECAST_RUNS').filter(r => r.plan_id === plan.plan_id && r.status === 'DONE').forEach(r => {
    const at = appLandingTime_('', r.as_of);
    if (at !== null) runs[r.run_id] = { at: at, fin: String(r.finished_at || ''), row: r._row };
  });
  const out = [];
  yms.forEach(ym => {
    const a = actual[ym];
    if (a === null || a === undefined) return;
    const start = appMonthStartMs_(ym);
    const best = recs.filter(r => r.ym === ym && runs[r.run_id] && runs[r.run_id].at < start && r.source !== 'actual_closed')
      .sort((x, y) => runs[y.run_id].at - runs[x.run_id].at || runs[y.run_id].fin.localeCompare(runs[x.run_id].fin) || runs[y.run_id].row - runs[x.run_id].row)[0];
    if (best) out.push({ plan_id: plan.plan_id, ym: ym, row: best, actual: a });
  });
  return { recs: recs.length, pts: out };
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
        const k = r.method === 'STAT_ONLY' ? 'SIM' : r.method;
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
