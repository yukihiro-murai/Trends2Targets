/**
 * Effects.js — 人と AI の押しの効き係数（段 3。app/DESIGN_triangulation_bayes_JA.md の 4 章。2026-10-15 村井さん承認「全部おすすめどおり」）。
 * 締まった月ごとに、その月が始まる前の最後の予測の記録（FORECAST_METHODS の段）と実績から、
 *   ln（実績 ÷（統計の土台 + 確定スポット）× 補正）= α + βH × 人の押し + βAI × AI の押し + 誤差
 * を当てはめる（人の押し = ln（+人 ÷ +確定スポット）、AI の押し = ln（+AI ÷ +人）。その回に使った効き係数で割り戻した生の押し）。
 *   βH・βAI = 押しがどれだけ当たったか（1 = 押したとおり・0 = 効いていない・0.5 = 半分）。α = 補正の後に残る偏り（見せるだけ。予測には掛けない:
 *   全体の偏りは今までどおり補正を学び直す B-5 が直す。同じ月で 2 回直さないため）。
 * 事前 → 尤度 → 事後（正規分布の共役。乱数は使わない。同じ証拠なら同じ答え）:
 *   事前: α 〜 N(0, 0.05²)・βH・βAI 〜 N(1, 0.5²)（初めは押したとおりに信じる）。誤差の分散は、当てはめの残差から決める（下限 5% の二乗）。
 *   ほかのメーカーの事後に、メーカーどうしの違い（α 0.02²・β 0.2²）を足したものを、そのメーカーの事前にする（階層の縮め）。
 *   古い月ほど軽く（半減期 12 か月）。
 * 次の予測は事後の平均を使い（AppLearning → 旧来の計算が人の倍率を βH 乗・AI の倍率を βAI 乗する）、事後の幅を見通しの幅（P10・P90）に足す。
 * 1 回に動けるのは β ±0.2 まで（証拠の印が今と違う、一番新しい記録から）、β は 0〜2。上限で止めたときは学びの画面に印を出す（所有者が確かめる）。
 * 締まった月の点が 3 つより少なければ事前のまま（β = 1。幅は事前の幅）。記録は EFFECT_COEFS（表の版 14）に予測ごとに 1 行。
 * 止めている見直し案（C-1）は再開しない（この仕組みで置き換える。2026-10-15）。
 */

const APP_EFF_CALC_VERSION = 'E-1';
const APP_EFF_PRIOR_MU = [0, 1, 1];                       // α・βH・βAI
const APP_EFF_PRIOR_SD = [0.05, 0.5, 0.5];
const APP_EFF_BETWEEN_SD = [0.02, 0.2, 0.2];              // メーカーどうしの違い（ほかのメーカーの事後に足して、そのメーカーの事前にする）
const APP_EFF_SIGMA2_PRIOR = 0.01;                        // 誤差の分散の初めの値（10% の二乗）と、その重さ（か月）
const APP_EFF_SIGMA2_PRIOR_N = 3;
const APP_EFF_SIGMA2_MIN = 0.0025;
const APP_EFF_HALFLIFE = 12;
const APP_EFF_STEP = 0.2;
const APP_EFF_BETA_RANGE = [0, 2];
const APP_EFF_MIN_POINTS = 3;

// ---- 小さな行列（3 × 3）----

function appEffInv3_(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!isFinite(det) || Math.abs(det) < 1e-300) throw new Error('行列の逆が出せません');
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
function appEffMulMV_(m, v) { return m.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]); }
function appEffAddM_(a, b) { return a.map((r, i) => r.map((x, j) => x + b[i][j])); }
function appEffDiag_(v) { return [[v[0], 0, 0], [0, v[1], 0], [0, 0, v[2]]]; }

/**
 * 正規分布の共役の事後（誤差の分散 sigma2 は与える）。prior = { mu, cov }、pts = [{ y, xh, xa, w }]。返り値 { mu, cov }
 */
function appEffPosteriorFixed_(prior, pts, sigma2) {
  const P0 = appEffInv3_(prior.cov);
  const XtWX = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], XtWy = [0, 0, 0];
  pts.forEach(p => {
    const x = [1, p.xh, p.xa];
    for (let r = 0; r < 3; r++) { XtWy[r] += p.w * x[r] * p.y; for (let c = 0; c < 3; c++) XtWX[r][c] += p.w * x[r] * x[c]; }
  });
  const P = appEffAddM_(P0, XtWX.map(r => r.map(v => v / sigma2)));
  const cov = appEffInv3_(P);
  const rhs = appEffMulMV_(P0, prior.mu).map((v, k) => v + XtWy[k] / sigma2);
  return { mu: appEffMulMV_(cov, rhs), cov: cov };
}

/**
 * 事後（誤差の分散も決める: 初めの値で 1 回当てはめ → 残差の重み付き平均（初めの値を 3 か月分の重さで混ぜる。下限 5% の二乗）→ もう 1 回）。
 * 返り値 { mu, cov, sigma2, n（重みの合計）}。点が無ければ事前のまま
 */
function appEffPosterior_(prior, pts) {
  if (!pts.length) return { mu: prior.mu.slice(), cov: prior.cov.map(r => r.slice()), sigma2: APP_EFF_SIGMA2_PRIOR, n: 0 };
  const first = appEffPosteriorFixed_(prior, pts, APP_EFF_SIGMA2_PRIOR);
  let sw = 0, sr = 0;
  pts.forEach(p => { const r = p.y - (first.mu[0] + first.mu[1] * p.xh + first.mu[2] * p.xa); sw += p.w; sr += p.w * r * r; });
  const sigma2 = Math.max(APP_EFF_SIGMA2_MIN, (sr + APP_EFF_SIGMA2_PRIOR_N * APP_EFF_SIGMA2_PRIOR) / (sw + APP_EFF_SIGMA2_PRIOR_N));
  return Object.assign(appEffPosteriorFixed_(prior, pts, sigma2), { sigma2: sigma2, n: sw });
}

/** 階層の事後: ほかのメーカーの点で事前から事後（pool）→ メーカーどうしの違いを足して、そのメーカーの事前 → そのメーカーの点で事後 */
function appEffHierarchical_(pts, ownMaker) {
  const base = { mu: APP_EFF_PRIOR_MU.slice(), cov: appEffDiag_(APP_EFF_PRIOR_SD.map(s => s * s)) };
  const others = pts.filter(p => p.maker !== String(ownMaker)), own = pts.filter(p => p.maker === String(ownMaker));
  const pool = appEffPosterior_(base, others);
  const prior = others.length ? { mu: pool.mu, cov: appEffAddM_(pool.cov, appEffDiag_(APP_EFF_BETWEEN_SD.map(s => s * s))) } : base;
  const post = appEffPosterior_(prior, own);
  return { mu: post.mu, cov: post.cov, sigma2: own.length ? post.sigma2 : pool.sigma2, pool: pool, ownN: own.length };
}

// ---- 証拠 ----

/**
 * 効き係数の証拠: 全部の計画（片付けた計画は除く）の、予測の「今」（asOfMs）までに締まった月ごとに、その月が始まる前の最後の回の段と実績。
 * 人と AI の押しは、その回に使った効き係数（EFFECT_COEFS。無ければ 1）で割り戻す（効き係数が 0.05 より小さい回で押しがあれば数えない）。
 * 返り値 [{ maker, plan, ym, y, xh, xa, w, actual, runId }]
 */
function appEffEvidence_(asOfMs) {
  const day = Utilities.formatDate(new Date(asOfMs), APP_TZ, 'yyyy-MM-dd');
  const asOfYm = Utilities.formatDate(new Date(asOfMs), APP_TZ, 'yyyy/MM');
  const out = [];
  appReadTable_('PLANS').filter(p => p.state !== 'ARCHIVED').forEach(p => {
    const lp = appMethodsLivePoints_(p);
    if (!lp.pts.length) return;
    const used = {};
    try { appReadPlanTable_('EFFECT_COEFS', p.plan_id).forEach(r => { used[r.run_id] = r; }); } catch (e) { /* 表の版がそろう前 */ }
    lp.pts.forEach(x => {
      if (!appActualClosed_(x.ym, day)) return;
      const n = k => appMethodsNum_(x.row[k]);
      const ps = n('plus_spot'), ph = n('plus_human'), pa = n('plus_ai'), fin = n('final'), a = x.actual;
      if (!(ps > 0 && ph > 0 && pa > 0 && fin > 0 && a > 0)) return;
      const u = used[x.row.run_id];
      const bh = u ? Number(u.beta_human) : 1, ba = u ? Number(u.beta_ai) : 1;
      const raw = (eff, b) => (Math.abs(eff) < 1e-12 ? 0 : b >= 0.05 ? eff / b : null);
      const xh = raw(Math.log(ph / ps), bh), xa = raw(Math.log(pa / ph), ba);
      if (xh === null || xa === null) return;
      const c = fin / pa;
      const age = Math.max(0, appTriMonths_(x.ym, asOfYm) || 0);
      out.push({ maker: String(p.client_id), plan: p.plan_id, ym: x.ym, y: Math.log(a / (ps * c)), xh: xh, xa: xa, w: Math.pow(0.5, age / APP_EFF_HALFLIFE), actual: a, runId: x.row.run_id });
    });
  });
  return out;
}

/**
 * その計画の予測に使う効き係数（予測の計算の段で、旧来の予測を動かす前に）。失敗したら押したとおり（エラーのログに残す）。返り値:
 * { betaHuman, betaAi（使う値）, varHuman, varAi, covHumanAi（見通しの幅に足す事後の分散）, alpha, alphaSd（補正の後に残る偏り。見せるだけ）,
 *   posterior: { betaHuman, betaAi }（上限・幅の前）, basis（PRIOR・POSTERIOR）, capped（上限か幅で止めた）, points, makers, own, sigma, hash, prev }
 */
function appLearnEffects_(ctx, plan, asOfMs) {
  const priorOut = (extra) => Object.assign({ betaHuman: 1, betaAi: 1, varHuman: APP_EFF_PRIOR_SD[1] * APP_EFF_PRIOR_SD[1], varAi: APP_EFF_PRIOR_SD[2] * APP_EFF_PRIOR_SD[2],
    covHumanAi: 0, alpha: 0, alphaSd: APP_EFF_PRIOR_SD[0], posterior: null, basis: 'PRIOR', capped: false, points: 0, makers: 0, own: 0, sigma: null, hash: '', prev: null }, extra || {});
  try {
    const pts = appEffEvidence_(asOfMs);
    const hash = appSha256Hex_(pts.map(p => [p.plan, p.ym, p.runId, p.actual].join(',')).sort().join('|'));
    const makers = Object.keys(pts.reduce((o, p) => { o[p.maker] = 1; return o; }, {})).length;
    const own = pts.filter(p => p.maker === String(plan.client_id)).length;
    if (pts.length < APP_EFF_MIN_POINTS) return priorOut({ points: pts.length, makers: makers, own: own, hash: hash });
    const h = appEffHierarchical_(pts, plan.client_id);
    let prev = null;
    try {
      appReadPlanTable_('EFFECT_COEFS', plan.plan_id).filter(r => String(r.calc_version) === APP_EFF_CALC_VERSION && r.evidence_hash !== hash)
        .forEach(r => { if (!prev || String(r.recorded_at) > String(prev.recorded_at) || (String(r.recorded_at) === String(prev.recorded_at) && r._row > prev._row)) prev = r; });
    } catch (e) { prev = null; }
    const pv = prev ? [Number(prev.beta_human), Number(prev.beta_ai)] : [1, 1];
    let capped = false;
    const fit = (v, p) => {
      let x = Math.min(p + APP_EFF_STEP, Math.max(p - APP_EFF_STEP, v));
      x = Math.min(APP_EFF_BETA_RANGE[1], Math.max(APP_EFF_BETA_RANGE[0], x));
      if (Math.abs(x - v) > 1e-12) capped = true;
      return x;
    };
    const bh = fit(h.mu[1], pv[0]), ba = fit(h.mu[2], pv[1]);
    return { betaHuman: bh, betaAi: ba, varHuman: h.cov[1][1], varAi: h.cov[2][2], covHumanAi: h.cov[1][2], alpha: h.mu[0], alphaSd: Math.sqrt(h.cov[0][0]),
      posterior: { betaHuman: h.mu[1], betaAi: h.mu[2] }, basis: 'POSTERIOR', capped: capped, points: pts.length, makers: makers, own: own, sigma: Math.sqrt(h.sigma2),
      hash: hash, prev: { betaHuman: pv[0], betaAi: pv[1] } };
  } catch (e) {
    appLogError_('LOG.EFFECT_COEFS', e, ctx);
    return priorOut();
  }
}

/** 旧来の計算に渡す形（AppLearning.effects） */
function appEffForEngine_(e) {
  return e ? { betaHuman: e.betaHuman, betaAi: e.betaAi, varHuman: e.varHuman, varAi: e.varAi, covHumanAi: e.covHumanAi } : null;
}

/** 予測の保存の段で足す EFFECT_COEFS の 1 行（使った効き係数と証拠） */
function appEffOps_(ctx, plan, p) {
  try {
    const e = p.eff;
    if (!e) return [];
    return appLogOps_('EFFECT_COEFS', [{ plan_id: plan.plan_id, coef_id: appStableLogId_(APP_LOG_PREFIX.EFFECT_COEFS, [p.runId]), run_id: p.runId,
      as_of: Utilities.formatDate(new Date(p.asOfMs), APP_TZ, "yyyy-MM-dd'T'HH:mm:ssZ"),
      beta_human: e.betaHuman, beta_ai: e.betaAi, var_human: e.varHuman, var_ai: e.varAi, cov_human_ai: e.covHumanAi, alpha: e.alpha, alpha_sd: e.alphaSd,
      basis: e.basis, capped: !!e.capped, posterior_json: e.posterior || null, evidence_points: e.points, evidence_makers: e.makers, own_points: e.own, sigma: e.sigma,
      evidence_hash: e.hash, calc_version: APP_EFF_CALC_VERSION, recorded_at: appNowIso_() }]);
  } catch (err) {
    appLogError_('LOG.EFFECT_COEFS', err, ctx);
    return [];
  }
}

/**
 * 学びの画面の「効き係数」: 計画ごとに一番新しい記録（plans = appInsightPlans_ の { planId, clientName, fy }）。記録が無ければ null。返り値:
 * { plans: [{ planId, clientName, fy, betaHuman, betaAi, sdHuman, sdAi, alpha, alphaSd, basis, capped, points, own, at }], points, makers（一番多い計画の証拠）}
 */
function appEffectsCard_(plans) {
  const out = [];
  try {
    (plans || []).forEach(p => {
      let last = null;
      appReadPlanTable_('EFFECT_COEFS', p.planId).filter(r => String(r.calc_version) === APP_EFF_CALC_VERSION)
        .forEach(r => { if (!last || String(r.recorded_at) > String(last.recorded_at) || (String(r.recorded_at) === String(last.recorded_at) && r._row > last._row)) last = r; });
      if (!last) return;
      const n = v => appMethodsNum_(typeof v === 'number' ? v : v === '' || v === null || v === undefined ? null : Number(v));
      out.push({ planId: p.planId, clientName: p.clientName, fy: p.fy, betaHuman: n(last.beta_human), betaAi: n(last.beta_ai),
        sdHuman: n(last.var_human) === null ? null : Math.sqrt(Math.max(0, n(last.var_human))), sdAi: n(last.var_ai) === null ? null : Math.sqrt(Math.max(0, n(last.var_ai))),
        alpha: n(last.alpha), alphaSd: n(last.alpha_sd), basis: String(last.basis || ''), capped: last.capped === true || String(last.capped).toUpperCase() === 'TRUE',
        points: n(last.evidence_points) || 0, makers: n(last.evidence_makers) || 0, own: n(last.own_points) || 0, at: String(last.recorded_at || '') });
    });
  } catch (e) { return null; }   // 表の版がそろう前
  if (!out.length) return null;
  return { plans: out, points: Math.max.apply(null, out.map(x => x.points)), makers: Math.max.apply(null, out.map(x => x.makers)) };
}
