/**
 * Basis.js — 予測の根拠（予測の画面の「根拠」タブ）。
 *
 * 旧来の予測（A-9）が毎回残す記録を、データ本体から読んで並べる（計算はしない。旧来の計算は変えない）:
 *   - 月ごとの P50: 過去の売上だけの予測（客観）と、入力・AI・スポットを入れた最終（混合）。その差
 *   - 入力（製品・クライアント・見解）・AI の話題・Vertex の補正が、月ごとにどちらへ・どれだけ押したか（SUBJECTIVE_IMPACT_HISTORY）
 *   - AI の倍率と点数（AI_IMPACT_HISTORY）・確定しているスポット（FORECAST_SNAPSHOT の deterministic_adj）
 *   - 補正（CALIBRATION_STATE・FORECAST_SNAPSHOT の calibration_applied_json）
 *   - AI 調査の根拠（AI_RESEARCH_STRUCTURED: 話題・向き・点数・確からしさ・根拠の文）・Vertex の説明
 *   - 前回の予測からの変化（月ごとの P50）と、その間にあった操作・変化のわけ（changeCause。appBasisChangeCause_）
 *   - 層ごとの効き（LAYER_EFFECTS。版 10）の月の合計を、最新と前の回で（layers。どの層で変わったか。LayerEffects.js の appBasisLayers_）
 *   - 年度の見込みを本番にした計画（2026-10-09。判断 10・24）は、年度の値を月の合計にそろえ（appBasisAnnualLive_。旧来の年度合計は annual.legacy）、
 *     最終の中心は予測の画面と同じ見せる中心にする（appBasisShown_。月の合計は annual.monthSum）
 * 入力のハッシュが同じなら、組み立てた結果を 6 時間控える（見せる中心は控えの外で毎回のせる: 日付・着地の τ・w で動き、入力のハッシュに入らないため）。
 * 押したものの、人や話題ごとの内訳（名前と信頼度）は予算策定担当以上の人だけに出す（appBasisFor_。学びと同じ決まり）。
 */
const APP_BASIS_SHEETS = ['FORECAST_SNAPSHOT', 'AI_IMPACT_HISTORY', 'SUBJECTIVE_IMPACT_HISTORY', 'AI_RESEARCH_STRUCTURED', 'AI_SCORE_HISTORY',
  'CALIBRATION_STATE', 'VERTEX_FORECAST_LOG'];
const APP_SOURCE_LABELS = { factor_product: '製品の入力', factor_client: 'メーカー全体の入力', opinion: '見解', ai_topic: 'AI の話題', vertex_forecast: 'Vertex の補正' };

/** データ本体の表の形のシートを、見出し → 値の行にする（{ シート名: [行] }）。値だけを使うので表示形式は読まない */
function appEngTableObjects_(planId, names) {
  const sheets = appEngLoadPlanSheets_(planId, names, true);
  const out = {};
  names.forEach(n => {
    const s = sheets[n];
    if (!s || !s.values.length) { out[n] = []; return; }
    const head = s.values[0].map(String);
    out[n] = s.values.slice(1).filter(r => r.some(v => v !== '' && v !== null)).map(r => {
      const o = {};
      head.forEach((h, j) => { if (h) o[h] = r[j]; });
      return o;
    });
  });
  return out;
}

function appYm_(v) {
  if (appIsDate_(v)) return Utilities.formatDate(v, APP_TZ, 'yyyy/MM');
  const m = /^(\d{4})[-/](\d{1,2})/.exec(String(v || ''));
  return m ? m[1] + '/' + ('0' + m[2]).slice(-2) : String(v || '');
}

function appTimeKey_(v) { return appIsDate_(v) ? v.getTime() : new Date(String(v)).getTime() || 0; }

/** 表の中で、一番新しい回（key の列が最大の値）の行だけ */
function appLatestBatch_(rows, key) {
  let max = null;
  rows.forEach(r => { const t = appTimeKey_(r[key]); if (max === null || t > max) max = t; });
  return max === null ? [] : rows.filter(r => appTimeKey_(r[key]) === max);
}

function appNum_(v) { const n = typeof v === 'number' ? v : Number(v); return v === '' || v === null || !isFinite(n) ? null : n; }

/**
 * 見る人に合わせた根拠。月ごとの押したものの、人や話題ごとの内訳（keys: 名前・押し・信頼度）は、その計画のメーカーで予算策定担当以上の人だけに出す
 * （appInsightDetailFor_。メーカーに限った担当は、そのメーカーの計画だけ。2026-10-13）。ほかの人（閲覧・情報提供）には、情報源の種類ごとの押し（種類・名前・押し・数）だけ。
 * 見解の一文（opinion）は入力の見解をまとめたもの（入力の画面に出すもの）なので、これまでどおり出す。前回からの間の操作（between）の操作した人は空にする。
 * 控えは見る人によらず同じものを使うので、写しを直す（控えそのものは変えない）
 */
function appBasisFor_(ctx, basis, plan) {
  if (appInsightDetailFor_(ctx, plan && plan.client_id) === 'full' || !basis) return basis;
  const out = appSerialize_(basis);
  (out.monthly || []).forEach(m => (m.sources || []).forEach(s => { s.keys = []; }));
  (out.between || []).forEach(x => { x.actor = ''; });   // 前回からの間の操作の、操作した人のメールも出さない（2026-10-13。画面は「-」）
  return out;
}

/** 画面: 計画の予測の根拠（ctx = 見る人。appBasisFor_） */
function appForecastBasis_(ctx, planId) {
  const plan = appPlanOf_(planId);
  const inputHash = appPlanInputHash_(plan.plan_id);
  const key = 'BASIS_' + appSha256Hex_([plan.plan_id, inputHash, APP_VERSION].join('|')).slice(0, 32);
  const cached = appJobGetResult_(key);
  if (cached.found) return appBasisFor_(ctx, appBasisShown_(cached.value, plan), plan);
  const t = appEngTableObjects_(plan.plan_id, APP_BASIS_SHEETS);
  // 新アプリで動かした予測（新しい順）と、その月ごとの P50
  const runs = appReadTable_('FORECAST_RUNS').filter(r => r.plan_id === plan.plan_id && r.status === 'DONE')
    .sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)) || b._row - a._row);
  const monthlyOf = runId => {
    const m = {};
    if (runId) appReadTable_('FORECAST_MONTHLY').filter(x => x.run_id === runId).forEach(x => { m[appYm_(x.ym)] = x; });
    return m;
  };
  const latest = runs[0] || null, prev = runs[1] || null;
  const cur = monthlyOf(latest && latest.run_id), before = monthlyOf(prev && prev.run_id);
  const stored = appStoredHeadline_(plan.plan_id);
  const months = (stored ? stored.monthly.map(m => m.month) : Object.keys(cur).sort()).filter(Boolean);

  // 旧来の予測が残した、一番新しい回の記録
  const snap = appLatestBatch_(t.FORECAST_SNAPSHOT, 'run_date').filter(r => String(r.scenario) === 'neutral');
  const ai = appLatestBatch_(t.AI_IMPACT_HISTORY, 'run_at');
  const push = appLatestBatch_(t.SUBJECTIVE_IMPACT_HISTORY, 'run_at');
  const snapBy = {}, aiBy = {}, pushBy = {};
  snap.forEach(r => { snapBy[appYm_(r.target_month)] = r; });
  ai.forEach(r => { aiBy[appYm_(r.target_month)] = r; });
  push.forEach(r => { (pushBy[appYm_(r.target_month)] = pushBy[appYm_(r.target_month)] || []).push(r); });

  const monthly = months.map(ym => {
    const c = cur[ym] || {}, b = before[ym] || {}, s = snapBy[ym] || {}, a = aiBy[ym] || {};
    const sm = stored ? stored.monthly.filter(m => m.month === ym)[0] || {} : {};
    const p50 = appNum_(c.p50) !== null ? appNum_(c.p50) : appNum_(sm.p50);
    const obj = appNum_(c.obj_p50);
    const sources = {};
    (pushBy[ym] || []).forEach(r => {
      const k = String(r.source_type || '');
      const st = appNum_(r.push_step);
      if (st === null) return;
      const o = sources[k] = sources[k] || { type: k, label: APP_SOURCE_LABELS[k] || k, step: 0, n: 0, keys: [] };
      o.step += st; o.n++;
      if (o.keys.length < 5 && r.source_key) o.keys.push(String(r.source_key) + ' ' + (st > 0 ? '+' : '') + Math.round(st * 1000) / 10 + '%' + (appNum_(r.applied_reliability_r) !== null && appNum_(r.applied_reliability_r) !== 1 ? '（信頼度 ' + appNum_(r.applied_reliability_r).toFixed(2) + '）' : ''));
    });
    let opinion = '';
    try { opinion = (JSON.parse(String(s.key_factors_json || '{}')) || {}).opinion || ''; } catch (e) { opinion = ''; }
    return {
      month: ym, p50: p50, objective: obj, diff: p50 !== null && obj !== null ? p50 - obj : null,
      prevP50: appNum_(b.p50), change: p50 !== null && appNum_(b.p50) !== null ? p50 - appNum_(b.p50) : null,
      spot: appNum_(s.deterministic_adj), kAi: appNum_(a.k_ai), aiScore: appNum_(a.ai_total_score), aiDirection: String(a.ai_direction || ''),
      aiNeutralized: String(a.ai_neutralized || '') === '1' || a.ai_neutralized === true, source: String(a.forecast_source || s.forecast_source || ''),
      sources: Object.keys(sources).map(k => sources[k]), opinion: opinion
    };
  });

  // 補正（今の状態と、最後の予測で使ったもの）。今の状態は CONFIG!B2 のメーカーの行（予測に効く行。最後の行ではない。appPlanCalRow_）
  const cal = appPlanCalRow_(plan.plan_id, t.CALIBRATION_STATE);
  let applied = null;
  try { applied = snap.length ? JSON.parse(String(snap[0].calibration_applied_json || 'null')) : null; } catch (e) { applied = null; }
  // AI 調査の根拠（一番新しい日付の行）
  const research = appLatestBatch_(t.AI_RESEARCH_STRUCTURED, 'as_of_date').map(r => ({
    topic: String(r.topic || ''), rowType: String(r.row_type || ''), direction: String(r.direction || ''), impact: appNum_(r.impact_score),
    confidence: appNum_(r.confidence), score: appNum_(r.blended_score), horizon: String(r.time_horizon || ''),
    evidence: String(r.evidence || '').slice(0, 600), reason: String(r.business_relevance_reason || '').slice(0, 300), asOf: appYm_(r.as_of_date)
  }));
  const vertex = t.VERTEX_FORECAST_LOG.slice().sort((a, b) => appTimeKey_(b.run_at) - appTimeKey_(a.run_at))[0] || null;
  // 前回の予測から今回の予測までにあった操作（入力の保存・取り込み・AI 調査・学習など）
  const between = prev && latest ? appReadTable_('PLAN_ACTIONS').filter(x => x.plan_id === plan.plan_id && x.finished_at > prev.finished_at && x.finished_at <= latest.started_at)
    .map(x => ({ action: x.action, label: (APP_PLAN_ACTIONS[x.action] || {}).label || x.action, at: x.finished_at, actor: x.actor_email, changed: appParseJsonList_(x.changed_sheets_json) })) : [];
  const sum = k => monthly.reduce((s, m) => (m[k] === null ? s : (s || 0) + m[k]), null);
  const out = {
    planId: plan.plan_id, latestRunAt: latest ? latest.finished_at : '', prevRunAt: prev ? prev.finished_at : '',
    annual: { p50: latest ? latest.annual_p50 : stored && stored.annual.p50, objective: latest ? latest.objective_p50 : stored && stored.objective.p50,
      prevP50: prev ? prev.annual_p50 : null, spot: sum('spot') },
    monthly: monthly, between: between, inputChanged: between.length > 0,   // 予測の間に計画への操作があったか（無ければ、変化は月の変わり目・計算の版の違い。v0.29.0 より前の予測は乱数の揺れも）
    calibration: cal ? { factor: appNum_(cal.bias_correction_factor), aiWeight: appNum_(cal.ai_weight_override), aiMax: appNum_(cal.ai_max_abs_effect_override),
      monthBias: (() => { try { return JSON.parse(String(cal.residual_month_bias_json || '{}')); } catch (e) { return {}; } })(), updatedAt: String(cal.updated_at || ''),
      quarter: String(cal.last_applied_quarter || '') } : null,
    applied: applied, research: research,
    vertex: vertex ? { at: String(vertex.run_at || ''), confidence: appNum_(vertex.confidence), rationale: String(vertex.rationale_ja || '').slice(0, 1200), status: String(vertex.status || '') } : null
  };
  appBasisAnnualLive_(out, plan);   // 年度の見込みの本番（判断 10・24）: 年度の値を月の合計にそろえる（旧来の年度合計は annual.legacy。見せる中心は控えの後で appBasisShown_）
  Object.assign(out, appBasisChangeCause_(latest, prev, cur, before, between));   // 前回の予測からの変化のわけ（changeCause・changeCauses・changeVersion）
  out.layers = appBasisLayers_(plan.plan_id, latest, prev);   // 層ごとの効きの月の合計（最新と前の回。人の名前は入らない。LayerEffects.js）
  try { appJobPutResult_(key, out); } catch (e) { /* 控えられなくても返す */ }
  return appBasisFor_(ctx, appBasisShown_(out, plan), plan);
}

/**
 * 年度の見込みを本番にした計画（appPlanAlignedLive_。判断 10・24。2026-10-09 村井さん承認）の根拠の年度（控える部分）: 過去の売上だけ
 * （annual.objective）・前回（annual.prevP50）・月ごとの中心の合計（annual.monthSum）を、月ごとの値の 12 か月の合計にする（月ごとの内訳の合計と同じ）。
 * 最終の中心（annual.p50）もいったん月の合計（basis 'monthsum'）にし、控えの後で appBasisShown_ が予測の画面と同じ見せる中心にする。
 * 月の合計どうしで比べる値（過去の売上からの差・前回から）は、画面が monthSum から出す（月ごとの内訳と同じ足し方。見せる中心は締まった月の実績を入れるので、
 * 過去の売上だけ・前回の予測の月の合計とは比べない）。
 * 月が 12 そろわない値は null。旧来の計算の年度合計は annual.legacy = { p50, objective, prevP50 } に残し、annual.live = true。
 * 本番でない・月の中心が 12 そろわなければ何も変えない（今までどおり旧来の計算の年度合計）。out は appForecastBasis_ の返り値（書き換える）
 */
function appBasisAnnualLive_(out, plan) {
  const ms = out.monthly || [];
  const all = k => (ms.length === 12 && ms.every(m => m[k] !== null && m[k] !== undefined) ? ms.reduce((s, m) => s + m[k], 0) : null);
  const p50 = all('p50');
  if (p50 === null || !appPlanAlignedLive_(plan)) return;
  const a = out.annual;
  out.annual = Object.assign({}, a, { p50: p50, objective: all('objective'), prevP50: all('prevP50'), monthSum: p50, basis: 'monthsum', live: true,
    legacy: { p50: a.p50 === undefined ? null : a.p50, objective: a.objective === undefined ? null : a.objective, prevP50: a.prevP50 === undefined ? null : a.prevP50 } });
}

/**
 * 根拠の最終の中心を、予測の画面と同じ見せる中心にする（2026-10-09。控えの外で毎回: 見せる中心は今日の日付・着地の τ・w でも動く）。
 * annual.live（appBasisAnnualLive_）の計画だけ、計画の一覧の控えの見せる年度の値（appPlanShadow_ の annual。予測の画面の shadow.annual と同じもの）から
 * annual.p50 = その中心・annual.basis = 作り方（'monthsum' 締まった月なし・'landing' 年度の途中は着地の推定・'actual' 12 か月の実績の合計）・annual.k を出す。
 * annual.monthSum（月ごとの中心の合計）はそのまま。読めない・本番でなければ月の合計のまま（basis 'monthsum'）。
 * basis = 控えから読んだ値か、組み立てた値（書き換えない。変えるときは写しを返す）
 */
function appBasisShown_(basis, plan) {
  const a = basis && basis.annual;
  if (!a || a.live !== true) return basis;
  const sh = appPlanShadow_(plan.plan_id);
  const s = sh && sh.live ? sh.annual : null;
  if (!s || typeof s.p50 !== 'number' || !isFinite(s.p50)) return basis;
  return Object.assign({}, basis, { annual: Object.assign({}, a, { p50: s.p50, basis: s.basis || 'monthsum', k: typeof s.k === 'number' ? s.k : null,
    monthSum: typeof a.monthSum === 'number' ? a.monthSum : a.p50 }) });
}

/**
 * 前回の予測からの変化のわけ（根拠の「前回の予測からの変化」。2026-10-08）。計算だけ（表は読まない）。
 * latest・prev: FORECAST_RUNS の行（新しい回・その前の回）、cur・before: その回の月ごとの FORECAST_MONTHLY（{ 'yyyy/MM': 行 }）、
 * between: その間の計画への操作（{ action, changed（変わったシート） }）。
 * 返り値: { changeCause, changeCauses（当てはまるわけを下の順に全部）, changeVersion: { engine, app } }。前の回が無ければ ''・[]・null。
 * わけ（この順で、最初に当てはまったものが changeCause）:
 *   1. none     … 年度の P50 と月ごとの P50 が前回とまったく同じ（このときはほかのわけを挙げない）
 *   2. inputs   … 間の操作が、予測の読む表（APP_FORECAST_SEED_SHEETS: 入力・売上・AI 調査・補正など）を変えた。
 *                 予算・記入・実績の取り込みだけの操作は数えない（予測の数字を動かさない）。両方の回の種が中身から作った同じ種なら、
 *                 予測の読んだ表は同じなので数えない
 *   3. calendar … 「今」の月（as_of の年月）が違う（月が変わって締まった月が増えると、予測は変わる。決定 13）
 *   4. version  … 旧来の計算の中身（engine_sha256。無ければ engine_version）が違う
 *   5. jitter   … どちらかの回の種が、中身から作った 64 桁の種でない（v0.29.0 より前: 同じ入力でも実行ごとに乱数が揺れた）。
 *                 月と旧来の計算が同じとき（違えば 3・4 が先に当たる）
 *   6. other    … 1〜5 のどれでもなく、両方とも同じ中身の種（入力・版・地域が同じ）: 版の違いではない（AI の点数の流れを使う設定で、調べ直した直後など）。
 *   7. version  … 1〜6 のどれでもない（両方とも中身から作った種で種が違い、月も旧来の計算も同じ）: 種に入るアプリの版が違うとみるしかない。
 *                 アプリの版は予測の記録に残していないので、changeVersion.app は 'unknown'
 * changeVersion: engine = 'changed' / 'same' / 'unknown'（どちらかの回に記録が無い）、
 *                app = 'changed'（片方だけが中身から作った種 = v0.29.0 の前と後）/ 'unknown'（アプリの版は記録していない）
 */
function appBasisChangeCause_(latest, prev, cur, before, between) {
  if (!latest || !prev) return { changeCause: '', changeCauses: [], changeVersion: null };
  const content = seed => /^[0-9a-f]{64}$/.test(String(seed || ''));
  const same = (a, b) => appNum_(a) !== null && appNum_(b) !== null && Math.abs(appNum_(a) - appNum_(b)) < 1e-6;
  const c = cur || {}, b = before || {};
  const yms = Object.keys(c).concat(Object.keys(b).filter(ym => !Object.prototype.hasOwnProperty.call(c, ym)));
  const none = same(latest.annual_p50, prev.annual_p50) && yms.every(ym => c[ym] && b[ym] && same(c[ym].p50, b[ym].p50));
  const sha1 = String(latest.engine_sha256 || ''), sha0 = String(prev.engine_sha256 || '');
  const v1 = String(latest.engine_version || ''), v0 = String(prev.engine_version || '');
  const engine = sha1 && sha0 ? (sha1 === sha0 ? 'same' : 'changed') : v1 && v0 && v1 !== v0 ? 'changed' : 'unknown';
  const app = content(latest.seed) !== content(prev.seed) ? 'changed' : 'unknown';
  const changeVersion = { engine: engine, app: app };
  if (none) return { changeCause: 'none', changeCauses: ['none'], changeVersion: changeVersion };
  const seedSame = content(latest.seed) && content(prev.seed) && latest.seed === prev.seed;
  const reads = (between || []).some(x => (x.changed || []).some(n => APP_FORECAST_SEED_SHEETS.indexOf(n) >= 0));
  const m1 = latest.as_of ? appYm_(latest.as_of) : '', m0 = prev.as_of ? appYm_(prev.as_of) : '';
  const calendar = !!m1 && !!m0 && m1 !== m0;
  const jitter = (!content(latest.seed) || !content(prev.seed)) && !calendar && engine !== 'changed';
  const causes = [];
  if (reads && !seedSame) causes.push('inputs');
  if (calendar) causes.push('calendar');
  if (engine === 'changed') causes.push('version');
  if (jitter) causes.push('jitter');
  // 種が同じ（入力・版・地域が同じ）なのに数字が違うのは、版の違いではない（AI の点数の流れを使う設定で、調べ直した直後など）
  if (!causes.length && seedSame) causes.push('other');
  if (causes.indexOf('version') < 0 && causes.indexOf('other') < 0 && (app === 'changed' || !causes.length)) causes.push('version');
  return { changeCause: causes[0], changeCauses: causes, changeVersion: changeVersion };
}
