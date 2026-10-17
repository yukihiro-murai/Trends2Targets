/**
 * Portfolio.js — 計画（クライアント × 年度）の一覧と、新しい計画を作る。
 *
 * 新しい計画は、計算用ブックの上で旧来の A-1 初期セットアップ（setupForecastBook の中身）と
 * 設定の保存（saveInitialSetupSettings）を動かし、できたシートをデータ本体に計画として保存する。
 * その後は、A-2 売上データの取り込み → A-3 → 予測、と進める。
 */

/** A-1 初期セットアップで作るシート（旧来の setupForecastBook の order と同じ順） */
const APP_SETUP_ORDER = ['GUIDE', 'CONFIG', 'SALES_INPUT', 'SALES_MONTHLY', 'AI_RESEARCH', 'PRODUCT', 'CLIENT', 'OPINIONS', 'DEV_SPOT', 'OUTPUT',
  'DASHBOARD', 'ACTUAL_EVAL_MONTHLY', 'EVAL_COMPARE_MONTHLY', 'EVAL_LOG', 'EVAL_INSIGHTS', 'QUARTERLY_REVIEW', 'QUARTERLY_REVIEW_LOG',
  'AI_RESEARCH_STRUCTURED', 'RUN_LOG', 'FORECAST_SNAPSHOT', 'PROCESS_STATUS', 'AI_SCORE_HISTORY', 'AI_IMPACT_HISTORY',
  'SUBJECTIVE_IMPACT_HISTORY', 'CALIBRATION_STATE', 'CALIBRATION_HISTORY', 'SOURCE_RELIABILITY', 'RELIABILITY_EVIDENCE'];
const APP_CANDIDATES_CACHE_KEY = 'APP_ZAC_CLIENTS';
/** 新しい計画の地域（旧ブックの既定と同じ） */
function appNewPlanTz_() { return { time_zone: APP_TZ, locale: 'ja_JP' }; }

// ---- 新しい計画 ----

/** ZAC の実績に出てくるクライアント（旧来の A-1 の候補と同じ。直近 2 年）。6 時間控える */
function appPlanCandidates_(ctx, input) {
  const cache = CacheService.getScriptCache();
  let names = null;
  if (!(input && input.refresh)) { try { names = JSON.parse(cache.get(APP_CANDIDATES_CACHE_KEY) || 'null'); } catch (e) { names = null; } }
  if (!names) {
    names = appLegacyCall_({}, { asOfMs: new Date().getTime(), seed: 'candidates', actor: ctx.actor }, 'getClientCandidatesForSetup_', []).value || [];
    try { cache.put(APP_CANDIDATES_CACHE_KEY, JSON.stringify(names), 21600); } catch (e) { /* 大きすぎれば控えない */ }
  }
  // 画面には、ふつうの表記を出す（作るときは ZAC の名前を使う。売上の取り込みで照合するため）
  return { candidates: names.map(n => ({ zac: n, display: appClientDisplayName_(n) })), defaultFy: appFy_(new Date()) + (new Date().getMonth() >= 9 ? 1 : 0), existing: appListPlans_().map(p => ({ clientName: p.clientName, fy: p.fy })) };
}

function appPlanCreateCheck_(p) {
  const clientName = String(p && p.clientName || '').trim();
  const fy = Number(p && p.fy);
  const people = String(p && p.peopleCsv || '').split(/[,、，]/).map(s => s.trim()).filter(Boolean);
  const purpose = appPlanPurposeOf_(p && p.purpose);   // 空 = 予算を立てる計画・MEASURE = 測る専用（PlanPurpose.js）
  if (!clientName) throw new Error('メーカーを選んでください。');
  if (clientName.length > 100) throw new Error('メーカーの名前が長すぎます。');
  if (!fy || fy < 2000 || fy > 2100 || Math.floor(fy) !== fy) throw new Error('年度（FY）を 4 桁の数で入れてください。');
  appRequireOpenYear_(fy);   // 締めた年度には、新しい計画を作れない（組み立て・保存の両方で確かめる）
  if (!people.length && purpose !== APP_PLAN_MEASURE) throw new Error('担当者を 1 人以上入れてください。');
  if (people.some(x => x.length > 40)) throw new Error('担当者の名前が長すぎます。');
  appPlanCheckArgs_([clientName].concat(people));
  const normalized = appNormalizeName_(clientName);
  const client = appReadTable_('CLIENTS').filter(c => c.normalized_name === normalized)[0] || null;
  if (client && appReadTable_('PLANS').some(x => x.client_id === client.client_id && String(x.fy) === String(fy) && x.state !== 'ARCHIVED')) {
    throw new Error(appClientDisplayName_(client.client_name) + ' の FY' + fy + ' の計画は、すでにあります。');
  }
  if (purpose === APP_PLAN_MEASURE) appMeasureRequireRoom_(appReadTable_('PLANS'), '');   // 測る専用は 5 計画まで
  return { clientName: clientName, fy: fy, peopleCsv: people.join(','), client: client, normalized: normalized, purpose: purpose };
}

/** 作る（PLAN.CREATE）: 計算用ブックの上で旧来の A-1 初期セットアップと設定の保存を動かす（データ本体には書かない） */
function appPlanCreateBuild_(ctx, p) {
  const t0 = new Date().getTime();
  return appWithLock_(() => {
    appJournalRecover_(ctx);
    const c = appPlanCreateCheck_(p);
    appMeasureRequireOwner_(ctx, c.purpose);
    const scratch = appWorkScratch_(appNewPlanTz_());
    const token = appId_('SCR');
    appScratchReset_(scratch, token);
    const asOfMs = new Date().getTime();
    const engine = appLegacySetupBook_(scratch, { asOfMs: asOfMs, seed: token, actor: ctx.actor }, APP_SETUP_ORDER, c.clientName, c.fy, c.peopleCsv);
    // A-1 が作る検証の表は 26 列。旧来の B-2 が書く 36 列まで広げてから保存する（Engine.js の APP_ENGINE_MIN_COLUMNS）
    appEnsureMinColumns_(scratch);
    const payload = { clientName: c.clientName, fy: c.fy, peopleCsv: c.peopleCsv, purpose: c.purpose, token: token, engine: engine, buildMs: new Date().getTime() - t0 };
    return { __next: { kind: 'PLAN.CREATE_SAVE', payload: payload }, audit: { entityId: c.clientName + ' FY' + c.fy } };
  });
}

/** 保存（PLAN.CREATE_SAVE）: できたシートを、新しい計画としてデータ本体に書く */
function appPlanCreateSave_(ctx, p) {
  const t0 = new Date().getTime();
  return appWithLock_(() => {
    appJournalRecover_(ctx);
    if (!appScratchOwnedBy_(p.token)) throw new Error('計算用ブックがほかの処理で使われました。もう一度作ってください。');
    const c = appPlanCreateCheck_(p);   // 作っている間に、同じ計画がほかで作られていないか（測る専用の数も）
    appMeasureRequireOwner_(ctx, c.purpose);
    const now = appNowIso_();
    const planId = appId_('PL');
    const ops = [];
    let client = c.client;
    if (!client) {
      client = { client_id: appId_('CL'), client_name: c.clientName, zac_code: '', normalized_name: c.normalized, aliases_json: '[]',
        is_active: true, note: '', created_at: now, created_by: ctx.actor, updated_at: now, updated_by: ctx.actor, row_version: 1 };
      ops.push({ table: 'CLIENTS', mode: 'ensure', rows: [client] });
    }
    const cap = appCaptureChanged_(appScratchBook_(), planId, {});
    const missing = Object.keys(APP_ENGINE_SHEETS).filter(n => APP_SETUP_ORDER.indexOf(n) >= 0 && !cap.changed.some(e => e.sheetRow.sheet === n));
    if (missing.length) throw new Error('初期セットアップでできなかったシートがあります: ' + missing.join('、'));
    const batchId = appId_('NEW');
    appChangedOps_(ctx, planId, cap.changed, batchId).forEach(op => ops.push(op));
    ops.push({ table: 'PLANS', mode: 'ensure', rows: [{ plan_id: planId, client_id: client.client_id, fy: String(c.fy), client_label: c.clientName,
      people_csv: c.peopleCsv, source_book_id: '', locale: appNewPlanTz_().locale, time_zone: appNewPlanTz_().time_zone, state: 'ACTIVE', note: '',
      created_at: now, created_by: ctx.actor, updated_at: now, updated_by: ctx.actor, row_version: 1, purpose: c.purpose }] });
    const written = appJournalRun_(ctx, '計画の作成（' + c.clientName + ' FY' + c.fy + '）', planId, ops);
    appScratchMarkSynced_(planId, p.token, null);   // 作った後の A-2 などは組み立て直さずに使える
    return { planId: planId, clientName: appClientDisplayName_(c.clientName), fy: c.fy, purpose: c.purpose, sheets: cap.changed.length, written: written, engine: p.engine,
      timing: { buildMs: p.buildMs, saveMs: new Date().getTime() - t0 }, audit: { entityId: planId, clientId: client.client_id } };
  });
}

// ---- 一覧 ----

/** 計画の一覧（予測の画面の計画を選ぶ欄）。measure = 測る専用の計画（PlanPurpose.js） */
function appListPlans_() {
  const clients = appClientNameMap_();   // 画面に出す名前（半角カナ・株式会社などを除いた、ふつうの表記）
  return appReadTable_('PLANS').map(p => {
    return { planId: p.plan_id, clientName: clients[p.client_id] || p.client_label, fy: p.fy, state: p.state, frozen: appYearIsFrozen_(p.fy), measure: appPlanIsMeasure_(p) };
  });
}


/**
 * 全部の計画の要点（最新の予測・前回からの変化・予算・精度・手順の進み・着地見込みと空模様）。
 * 着地見込みと空模様は Landing.js（締まった月の実績から今年の水準を学ぶ）。今日の日付で変わる（霧の判定・前提の変化の日数）ので、控えは日ごと。
 * 検証の表（EVAL_COMPARE_MONTHLY）の予測（P10/P50/P90）・外れ・幅の外の印は、今の決まり（D4〜D6）で B-2 が書き直した計画だけで使う
 * （appPortfolioScored_）。表には版の印が無く、旧来の B-2 が丸ごと書き直すまでは、前の決まり（月が始まった後の予測）の値のままのため。
 * 書き直していない計画（締めた年度の計画はずっと）は、外れ幅・予実の差・幅の外を出さず、着地の τ・w の学びにも入れない。実績はそのまま使う
 * （暫定実績・着地見込み。実績は B-1 の取り込みのままで、どの回の予測で測るかに関係しない）
 * 着地見込みの τ・w は、所有者が承認して業務の設定に書いた値（無ければ 0.15 と 1。appLandingApproved_）。全計画から学んだ値（appLandingPrior_）は
 * prior.learned として返すだけで、着地には使わない（2026-10-08 判断 29）。
 * 計画ごとに足す項目（2026-10-08。どれも影で、保存している数字は変えない）:
 *   aligned      … 年度の見込みの試し（月の P50 の合計を中心に、着地見込みと同じ式の幅。appLandingAligned_。判断 10）。
 *                  締まった月がある（aligned.k > 0）・締まった月を数え直している間（aligned.pending）は幅を出さない。12 か月を数えた計画は aligned.done
 *   reach        … 予算に届く見込み（今の予算と承認済みの公式版の予算。届く金額 50〜80%。appLandingReach_。判断 24・25）。
 *                  12 か月を数えた計画は reach.done と reach.actual（実績の合計。届いた／届かなかった。届く金額は出さない）。年度を締めても 12 か月に足りなければ見込みのまま
 *   scoredMonths … 今の決まりで B-2 が測った締まった月の数（appPortfolioScored_。実績 0 円の月も数える。数）
 *   measure      … 測る専用の計画（PLANS.purpose。版 10 の 3-9）。着地の τ・w の学びに入れず、ホームと分析の合計にも入れない
 * 年度の見込みの本番（2026-10-09 村井さん承認。判断 10・24 を、決定 4・7 が済んだ計画から本番に）:
 *   alignedLive  … 補正を所有者が承認した値にして予測し直した計画（appPortfolioLive_ = appLandingLiveOf_）で、月の予測がそろっている（aligned がある）。真偽
 *   p10・p50・p90 … alignedLive なら見せる年度の値（annualShown の p10・p50・p90）。そうでなければ今までどおり旧来の計算の年度合計
 *   annualShown  … alignedLive のときの見せる年度の値（appLandingAnnualShown_。2026-10-09）
 *                  { p10, p50, p90, band, k, basis, monthSum, done, pending, legacy }。中心と幅は同じ分布から:
 *                  締まった月なし = 月の P50 の合計と試しの幅（basis 'monthsum'）・年度の途中 = 着地の推定とその幅（basis 'landing'。予算に届く見込みと同じ中心）・
 *                  12 か月を数えた = 実績の合計で幅なし（basis 'actual'）・数え直し中 = 月の P50 の合計で幅なし。monthSum = 月の P50 の合計（いつも）。
 *                  alignedLive でなければ null
 *   annualBand   … alignedLive のときの幅の出どころ（'aligned' / 'landing' / ''。そうでなければ ''）
 *   legacyAnnual … 旧来の計算の年度合計 { p10, p50, p90 }（最新の予測の記録、無ければ OUTPUT の 26 行。いつも。記録は変えない）
 *   aligned.live・reach.live … alignedLive と同じ（画面が「（試し）」を外す）。prevP50 と前提の変化（premise）は、これまでどおり記録の年度合計で比べる
 * 返り値: { plans: [計画の要点], prior: { learned: appLandingPrior_ の返り値, used: appLandingApproved_ の返り値 } }
 */
function appPortfolioData_() {
  const clients = appClientNameMap_();   // 画面に出す名前（半角カナ・株式会社などを除いた、ふつうの表記）
  const today = appToday_();
  const todayYm = appCloseCutoffYm_(today);   // 今日までに締まっているはずの月の境目（月末から 5 日たった月まで。霧の判定）
  const runs = {};
  appReadTable_('FORECAST_RUNS').filter(r => r.status === 'DONE').forEach(r => { (runs[r.plan_id] = runs[r.plan_id] || []).push(r); });
  const outRows = {};
  const clientOf = {};   // CONFIG!B2（計画のメーカーの名前。補正の行を選ぶ。同じ読み込みで）
  appReadTable_('ENG_ROWS').filter(r => (r.sheet === 'OUTPUT' || r.sheet === 'CONFIG') && Number(r.col_from) === 1).forEach(s => {
    const n = Number(s.row_no);
    if (s.sheet === 'CONFIG') {
      if (n === 2) { const x = (JSON.parse(s.cells_json) || [])[1]; clientOf[s.plan_id] = x ? String(appCellDecode_(x.charAt(0) === 'f' ? 'e' : x.charAt(0), x.slice(1))).trim() : ''; }
      return;
    }
    if (n === 1 || n === 26 || (n >= 29 && n <= 40)) { (outRows[s.plan_id] = outRows[s.plan_id] || {})[n] = JSON.parse(s.cells_json); }
  });
  const steps = {};
  appReadTable_('ENG_PROCESS_STATUS').forEach(r => { (steps[r.plan_id] = steps[r.plan_id] || []).push(r); });
  const plans = appReadTable_('PLANS').filter(p => p.state !== 'ARCHIVED');
  // 締まった月の境目（B-1 → B-2 の順に動いた取り込み）と、今の決まりで測った月（EVAL_LOG を全計画の分 1 回で読む）。
  // B-1 の後に B-2 がまだの計画は、最後に成功した B-2 の前の B-1 の境目（消さずに足す記録から。2026-10-09 村井さん承認）
  const hist = appPortfolioStepHist_(plans.filter(p => appLandingPendingCutoff_(steps[p.plan_id] || []) !== '').map(p => p.plan_id));
  const cut = {};
  plans.forEach(p => { cut[p.plan_id] = appLandingCutoff_(steps[p.plan_id] || [], hist[p.plan_id] || []); });
  const live = appPortfolioLive_(plans.map(p => p.plan_id), clientOf);   // 年度の見込みを本番にした計画（判断 10・24。appLandingLiveOf_）
  const scored = appPortfolioScored_(plans.map(p => p.plan_id), cut);
  const ape = {};   // 計画ごとの [{ ym, err, act }]（外れ幅は、締まった月で今の決まりで測った月の分だけを後で合計の比にする）
  const cmp = {};   // 月ごとの実績と P10/P50/P90（検証の表）。暫定実績・着地見込み・予実の差・全計画の学びに使う（読むだけ。計算は変えない）
  const fnum = x => { const n = x === '' || x === null || x === undefined ? null : Number(x); return n !== null && isFinite(n) ? n : null; };
  appReadTable_('ENG_EVAL_COMPARE_MONTHLY').forEach(r => {
    const now = !!(scored[r.plan_id] && scored[r.plan_id].any);   // 今の決まりで B-2 が書き直した計画か
    const v = Number(r.ape_p50);
    const ym = appCellYm_(String(r._types || '').charAt(0), r.target_month);
    // 実績が空でも P50 のある行は残す（actual: null。ZAC に記録の無い月 = 売上 0。締まった月なら 0 円として数える）
    const blank = r.actual_total === '' || r.actual_total === null || r.actual_total === undefined;
    const act = blank ? null : Number(r.actual_total);
    const p50 = fnum(r.forecast_total_p50);
    // 外れは、今の決まりで測った月だけ（精度と同じ月。締まった後の予測 = 予測と実績がまったく同じ月も、精度と同じく除く）
    if (now && scored[r.plan_id].months[ym] && !blank && isFinite(act) && isFinite(v) && r.ape_p50 !== '' && !(p50 !== null && Math.abs(p50 - act) < 1e-6)) {
      // 外れの金額（|中心 − 実績|。中心が読めなければ月の外れ × |実績|）と実績。外れ幅 = 外れの合計 ÷ 実績の合計（精度 appWape_ と同じ）
      (ape[r.plan_id] = ape[r.plan_id] || []).push({ ym: ym, err: p50 !== null ? Math.abs(p50 - act) : Math.abs(v * act), act: Math.abs(act) });
    }
    if (ym && (blank ? p50 !== null : isFinite(act))) {
      // 書き直していない計画は、予測と幅の外の印を使わない（実績だけ）
      (cmp[r.plan_id] = cmp[r.plan_id] || {})[ym] = now ? { actual: act, p10: fnum(r.forecast_total_p10), p50: p50, p90: fnum(r.forecast_total_p90),
        out: String(r.range_outside_flag) === '1' ? 1 : String(r.range_outside_flag) === '0' ? 0 : null } : { actual: act, p10: null, p50: null, p90: null, out: null };
    }
  });
  const ver = appVersionSummary_();
  const num = x => { if (!x) return null; const t = x.charAt(0); if (t !== 'n') return null; const v = Number(x.slice(1)); return isFinite(v) ? v : null; };
  // 全計画の締まった月から学ぶ τ・w（1 回だけ。書き直していない計画は予測が無いので入らない）。承認されるまで着地には使わない（学びの画面に試しで出す）。
  // 測る専用の計画は入れない（版 10 の 3-9）
  const learned = appLandingPrior_(plans.filter(p => !appPlanIsMeasure_(p)).map(p => {
    const c = cmp[p.plan_id] || {};
    return Object.keys(c).filter(ym => cut[p.plan_id] && ym < cut[p.plan_id]).sort()
      .map(ym => ({ f: c[ym].p50, a: c[ym].actual === null ? 0 : c[ym].actual, p10: c[ym].p10, p90: c[ym].p90 }));   // 実績の空の締まった月は 0 円（着地の計算と同じ。全部 0 円の計画 = 雪は appLandingPrior_ が除く）
  }));
  const used = appLandingApproved_();   // 着地に使う τ・w（所有者が承認して書いた値。無ければ 0.15 と 1）
  // 年度を締めたか。年度ごとに 1 回だけ確かめる（YEAR_CLOSURES を計画の数だけ読まない）。確かめられなければ締めていないとして見せる
  // （見せ方だけに使う。書き込みの入口の確かめ appRequireOpenYear_ は別で、そちらは止める）
  const frozenFy = {};
  const frozenOf = fy => {
    const k = String(fy);
    if (!Object.prototype.hasOwnProperty.call(frozenFy, k)) {
      try { frozenFy[k] = appYearIsFrozen_(fy); } catch (e) { Logger.log('年度の締めを確かめられません: ' + k + ' ' + (e && e.message ? e.message : e)); frozenFy[k] = false; }
    }
    return frozenFy[k];
  };
  const rows = plans.map(p => {
    const rs = (runs[p.plan_id] || []).sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)) || b._row - a._row);
    const o = outRows[p.plan_id] || {};
    let adopted = null, uplift = null;
    for (let r = 29; r <= 40; r++) {
      const a = num((o[r] || [])[7]), u = num((o[r] || [])[8]);
      if (a !== null) adopted = (adopted || 0) + a;
      if (u !== null) uplift = (uplift || 0) + u;
    }
    const stored = o[26] ? { p10: num(o[26][1]), p50: num(o[26][2]), p90: num(o[26][3]) } : {};
    const latest = rs[0] || null;
    const prev = rs[1] || null;
    // 旧来の計算の年度合計（最新の予測の記録、無ければ OUTPUT の 26 行）。本番の計画でも記録はこのまま
    const legacy = { p10: latest ? latest.annual_p10 : stored.p10 === undefined ? null : stored.p10,
      p50: latest ? latest.annual_p50 : stored.p50 === undefined ? null : stored.p50,
      p90: latest ? latest.annual_p90 : stored.p90 === undefined ? null : stored.p90 };
    const v = ver[p.plan_id] || {};
    const budget = adopted === null && uplift === null ? null : (adopted || 0) + (uplift || 0);
    // 空模様の予算: 承認済みの公式版の最終予算、無ければ今の予算（採用予測 + 上乗せ。予測し直すと採用予測は P50 に戻る）
    const official = v.officialNo ? appNum_(v.officialFinal) : null;
    const budgetUsed = official !== null ? official : budget;
    const yt = appPlanYtd_(p.fy, cmp[p.plan_id] || {}, cut[p.plan_id]);
    const months = appLandingMonths_(o);
    const frozen = frozenOf(p.fy);   // 年度を締めた計画（画面の印。年度が終わったかは、数えた締まった月が 12 か月かで決める）
    const pendingCut = appLandingPendingCutoff_(steps[p.plan_id] || []);   // 実績を取り込んだ後、まだ当たり具合を計算していない（締まった月を数え直している間）
    const sky = appLandingSky_({ fy: p.fy, months: months, actual: yt.actual, cutoffYm: cut[p.plan_id], todayYm: todayYm, budget: budgetUsed,
      pendingCutoffYm: pendingCut, tau: used.tau, w: used.w, runs: rs.slice(0, 2).map(r => ({ p50: r.annual_p50, ageDays: appLandingAgeDays_(r.finished_at, today) })) });
    const st = steps[p.plan_id] || [];
    const errors = st.filter(s => String(s.status).toLowerCase() === 'error').map(s => s.step_key);
    // 外れ幅は締まった月で、今の決まりで測った月だけ（D4〜D6。精度 appAccuracyOf_ と同じ月。ほかの検証の行は消さずに読み飛ばす。境目が分からなければ数えない）。
    // 外れの合計 ÷ 実績の合計（2026-10-13。実績が 0 に近い月 1 つで値が飛ばない。実績の合計が 0 なら出さない）
    const a = (ape[p.plan_id] || []).filter(x => cut[p.plan_id] && x.ym && x.ym < cut[p.plan_id]);
    const aBase = a.reduce((s, x) => s + x.act, 0);
    // 年度の見込みの試し。締まった月を数え直している間（初めての取り込みの後の計算待ち）・実績の遅れは幅を出さない（sky.wait。
    // 2026-10-09: B-1 の後に B-2 がまだでも、前の B-1 → B-2 の組の境目で数えている間は数え直していない）
    const aligned = appLandingAligned_(p.fy, months, used.tau, used.w, budgetUsed, { k: sky.k, pending: sky.wait !== '' });
    const reach = appLandingReach_(sky, { draft: budget, official: official, officialNo: v.officialNo || null }, used);
    // 本番（判断 10・24）: 補正を所有者が承認した値にして予測し直した計画は、年度の数字を月の合計にそろえた値で見せる（旧来の年度合計は legacyAnnual）
    const shown = live[p.plan_id] ? appLandingAnnualShown_(aligned, sky, legacy) : null;
    if (aligned) aligned.live = !!shown;
    if (reach) reach.live = !!shown;
    return {
      planId: p.plan_id, clientName: clients[p.client_id] || p.client_label, fy: p.fy,
      p10: shown ? shown.p10 : legacy.p10, p50: shown ? shown.p50 : legacy.p50, p90: shown ? shown.p90 : legacy.p90,
      alignedLive: !!shown, annualBand: shown ? shown.band : '', legacyAnnual: legacy, annualShown: shown,
      prevP50: prev ? prev.annual_p50 : null,
      lastRunAt: latest ? latest.finished_at : '', runs: rs.length,
      budget: budget,
      mape: a.length && aBase > 0 ? a.reduce((s, x) => s + x.err, 0) / aBase : null, mapeMonths: a.length,
      stepsDone: st.filter(s => String(s.status).toLowerCase() === 'success').length, stepsTotal: st.length, stepErrors: errors,
      createdAt: p.created_at,
      officialNo: v.officialNo || null, officialFinal: v.officialFinal === undefined ? null : v.officialFinal,
      pendingNo: v.pendingNo || null,
      actualYtd: yt.actualYtd, actualMonths: yt.actualMonths, forecastYtd: yt.forecastYtd, rangeOut: yt.rangeOut, rangeN: yt.rangeN,
      landing: sky.landing, landingSd: sky.landingSd, landingP10: sky.landingP10, landingP90: sky.landingP90, pAbove: sky.pAbove, ratio: sky.ratio,
      sky: sky.sky, skyReason: sky.skyReason, skyDir: sky.skyDir, theta: sky.theta, credibility: sky.credibility, k: sky.k,
      budgetUsed: budgetUsed, budgetSource: official !== null ? 'official' : budget !== null ? 'draft' : '',
      aligned: aligned,
      frozen: !!frozen,
      reach: reach,
      scoredMonths: scored[p.plan_id] ? Object.keys(scored[p.plan_id].months).length : 0,
      measure: appPlanIsMeasure_(p)
    };
  }).sort((x, y) => String(y.fy).localeCompare(String(x.fy)) || String(x.clientName).localeCompare(String(y.clientName), 'ja'));
  return { plans: rows, prior: { learned: learned, used: used } };
}

/**
 * 予測の画面に出す、計画 1 つの試しの数（年度の見込みの試し・予算に届く見込み。計画の一覧の控え appPortfolioAll_ から。表は読み直さない）。
 * 読めないときは null（予測の画面はそのまま出す）。返り値: { planId, aligned, reach, scoredMonths, live, annual } | null。
 * live = 年度の見込みを本番にした計画（計画の一覧の alignedLive）。annual = live のときの見せる年度の値（計画の一覧の annualShown と同じもの:
 * { p10, p50, p90, band, k, basis: 'monthsum' | 'landing' | 'actual', monthSum, done, pending, legacy: 旧来の計算の年度合計 { p10, p50, p90 } }）。live でなければ null
 */
function appPlanShadow_(planId) {
  try {
    const p = appPortfolioAll_().plans.filter(x => x.planId === String(planId || ''))[0];
    if (!p) return null;
    const a = p.aligned || null;
    return { planId: p.planId, aligned: a, reach: p.reach || null, scoredMonths: p.scoredMonths, live: !!p.alignedLive,
      annual: p.alignedLive && p.annualShown ? p.annualShown : null };
  } catch (e) {
    Logger.log('試しの数: ' + (e && e.message ? e.message : e));
    return null;
  }
}

/**
 * 計画ごとの B-1・B-2 の成功の時刻（消さずに足す記録から。appLandingCutoff_ の hist。2026-10-09 村井さん承認）。
 * ids = B-1 の後に B-2 がまだの計画（PROCESS_STATUS は最後の回しか残さないので、その前の B-1 → B-2 の組を探す）。返り値: { 計画の ID: [{ step, t }] }
 *   PLAN_ACTIONS の IMPORT.ACTUALS・EVAL.REPORT（新アプリで動かして保存できた回。as_of = 旧来の計算の「今」= PROCESS_STATUS の時刻）
 *   旧来の RUN_LOG の importActualEvalMonthly・updatePhase1EvaluationReport の success（計画を旧来のブックから写す前の回も入る）
 * 読むのは ids があるときだけ（RUN_LOG は ids の計画の行だけ）
 */
function appPortfolioStepHist_(ids) {
  const out = {};
  if (!ids || !ids.length) return out;
  const want = appInsightSet_(ids);
  const push = (id, step, t) => { if (t !== null && isFinite(t)) (out[id] = out[id] || []).push({ step: step, t: t }); };
  const timeOf = v => (appIsDate_(v) ? v.getTime() : appLandingTime_('', v));
  appReadTable_('PLAN_ACTIONS').forEach(r => {
    if (!want[r.plan_id] || String(r.status) !== 'DONE') return;
    const step = r.action === 'IMPORT.ACTUALS' ? 'b1' : r.action === 'EVAL.REPORT' ? 'b2' : '';
    if (step) push(r.plan_id, step, timeOf(r.as_of));
  });
  let logs = {};
  try { logs = appEngAll_('RUN_LOG', ids, true); } catch (e) { Logger.log('RUN_LOG を読めません: ' + (e && e.message ? e.message : e)); logs = {}; }
  Object.keys(logs).forEach(id => (logs[id] || []).forEach(r => {
    if (String(r.status).toLowerCase() !== 'success') return;
    const fn = String(r.function_name || '');
    const step = fn === 'importActualEvalMonthly' ? 'b1' : fn === 'updatePhase1EvaluationReport' ? 'b2' : '';
    if (step) push(id, step, timeOf(r.run_at));
  }));
  return out;
}

/**
 * 年度の見込みを本番にした計画（{ 計画の ID: true }。判断 10・24。appLandingLiveOf_）。clientOf = { 計画の ID: CONFIG!B2 }。
 * CALIBRATION_STATE は全計画の分を 1 回で読み、補正が所有者の承認した値の計画（appLandingOwnerSet_）だけ FORECAST_SNAPSHOT を読む（その計画の行だけ）。
 * 読めなければ本番にしない（今までどおりの見せ方）
 */
function appPortfolioLive_(ids, clientOf) {
  const out = {};
  if (!ids || !ids.length) return out;
  try {
    const cal = appEngAll_('CALIBRATION_STATE', ids);
    const rowOf = {};
    const cand = ids.filter(id => { rowOf[id] = appLandingCalRow_(cal[id] || [], (clientOf || {})[id]); return appLandingOwnerSet_(rowOf[id]); });
    if (!cand.length) return out;
    const snap = appEngAll_('FORECAST_SNAPSHOT', cand, true);
    cand.forEach(id => { if (appLandingLiveOf_(rowOf[id], appLandingLastApplied_(snap[id] || []))) out[id] = true; });
  } catch (e) {
    Logger.log('年度の見込みの本番を確かめられません: ' + (e && e.message ? e.message : e));
  }
  return out;
}

/**
 * 計画の年度の見込みを本番にするか（判断 10・24。2026-10-09 村井さん承認。ほかの処理からも使う: 公式版の prob_mode など）。
 * plan = PLANS の行（plan_id）か計画の ID。補正が所有者の承認した値（auto_update_enabled = 0・note が owner-approved で始まる）で、
 * 最後の予測（見せている予測）がその値で動いた（係数と月ごとの補正が同じ）とき true。データ本体のその計画の行だけを読む。
 * 月の予測がそろっているかは見ない（計画の一覧の alignedLive は、それも見る）。読めなければ false
 */
function appPlanAlignedLive_(plan) {
  const id = String(typeof plan === 'string' ? plan : (plan && (plan.plan_id || plan.planId)) || '');
  if (!id) return false;
  try {
    const s = appEngLoadPlanSheets_(id, ['CONFIG', 'CALIBRATION_STATE'], true);
    const client = s.CONFIG && s.CONFIG.values[1] ? String(s.CONFIG.values[1][1] === null || s.CONFIG.values[1][1] === undefined ? '' : s.CONFIG.values[1][1]).trim() : '';
    const cal = appLandingCalRow_(s.CALIBRATION_STATE ? appLandingSheetObjects_(s.CALIBRATION_STATE.values) : [], client);
    if (!appLandingOwnerSet_(cal)) return false;
    return appLandingLiveOf_(cal, appLandingLastApplied_(appEngTableObjects_(id, ['FORECAST_SNAPSHOT']).FORECAST_SNAPSHOT));
  } catch (e) {
    Logger.log('年度の見込みの本番を確かめられません: ' + (e && e.message ? e.message : e));
    return false;
  }
}

/**
 * 予測の保存（appForecastRunSave_）で FORECAST_RUNS.fixes_json に書く直しの名前。計算用ブック book（この回の予測を動かした後）で、
 * 計画が本番（appLandingLiveOf_: 補正が所有者の承認した値で、この回の予測がその値で動いた）なら APP_FIX_ANNUAL_ALIGNED を足す。
 * 読めなければ足さない（APP_FORECAST_FIXES のまま）
 */
function appForecastFixesOf_(book) {
  const base = APP_FORECAST_FIXES.slice();
  try {
    const rows = name => { const sh = book.getSheetByName(name); return sh && sh.getLastRow() >= 2 ? appLandingSheetObjects_(sh.getDataRange().getValues()) : []; };
    const cfg = book.getSheetByName('CONFIG');
    const cal = appLandingCalRow_(rows('CALIBRATION_STATE'), cfg ? String(cfg.getRange('B2').getValue() || '').trim() : '');
    if (appLandingOwnerSet_(cal) && appLandingLiveOf_(cal, appLandingLastApplied_(rows('FORECAST_SNAPSHOT')))) base.push(APP_FIX_ANNUAL_ALIGNED);
  } catch (e) {
    Logger.log('予測の直しの印を決められません: ' + (e && e.message ? e.message : e));
  }
  return base;
}

/**
 * 計画ごとの、今の決まりで測った月（D4〜D6）: { 計画の ID: { any, months: { 'yyyy/MM': true } } }。
 * 月 = EVAL_LOG の neutral の行が appEvalRowCurrent_ の月（締まった月で、今の検証の版で B-2 が書いた行。精度・振り返りと同じ）。
 * any = その月が 1 つでもある = 今の決まりで B-2 が検証の表を書き直した計画。EVAL_LOG は全計画の分を 1 回で読む（appEngAll_）。
 * cut = 計画ごとの締まった月の境目（appLandingCutoff_）
 */
function appPortfolioScored_(ids, cut) {
  const rows = appEngAll_('EVAL_LOG', ids);
  const out = {};
  ids.forEach(id => {
    const o = out[id] = { any: false, months: {} };
    (rows[id] || []).forEach(r => {
      if (String(r.scenario) !== 'neutral' || !appEvalRowCurrent_(r, cut[id])) return;
      o.months[appYm_(r.target_month)] = true;
      o.any = true;
    });
  });
  return out;
}

/** セルの型と中身から 'yyyy/MM'（日時は日本の暦で。時刻つきの ISO の文字も時差を見て日本の暦で。読めなければ ''） */
function appCellYm_(t, text) {
  if (text === '' || text === null || text === undefined) return '';
  if (t === 'd') { const d = new Date(text); return isNaN(d.getTime()) ? '' : Utilities.formatDate(d, APP_TZ, 'yyyy/MM'); }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(text))) { const ms = appLandingTime_('', text); return ms === null ? '' : Utilities.formatDate(new Date(ms), APP_TZ, 'yyyy/MM'); }
  const m = /^(\d{4})\D(\d{1,2})/.exec(String(text));
  return m ? m[1] + '/' + ('0' + m[2]).slice(-2) : '';
}

/**
 * 年度の締まった月（cutoffYm より前）の暫定実績（2026-10-06）。締まっていない・途中の月（月末から 5 日たたずに取り込んだ月とその後の月。
 * appLandingCutoff_）は数えない。
 * 実績の行が無い・実績が空の締まった月は 0 円として数える（ZAC に記録が無い月）。actualMonths は締まった月の数。
 * forecastYtd は締まった月の予測（検証の表の P50）の合計（予実の差を見る）。予測の無い締まった月があれば出さない（比べられない）。
 * 今の決まりで B-2 が検証の表を書き直していない計画は、どの月も予測が無い（appPortfolioData_ が渡さない）ので、予実の差も幅の外も出ない。
 * 実績が空でも予測のある月は、0 円と予測で比べる。actual は締まった月ごとの実績（着地見込みの計算に渡す）
 */
function appPlanYtd_(fy, cmpByYm, cutoffYm) {
  const yms = cutoffYm ? appLandingFyYms_(fy).filter(ym => ym < cutoffYm) : [];
  const res = { actualYtd: null, actualMonths: yms.length, forecastYtd: null, rangeOut: 0, rangeN: 0, actual: {} };
  let fcN = 0;
  yms.forEach(ym => {
    const c = cmpByYm[ym];
    const a = c && typeof c.actual === 'number' ? c.actual : 0;
    res.actualYtd = (res.actualYtd || 0) + a;
    if (!c) return;
    res.actual[ym] = a;
    if (c.p50 !== null) { res.forecastYtd = (res.forecastYtd || 0) + c.p50; fcN++; }
    if (c.out !== null) { res.rangeN++; res.rangeOut += c.out; }
  });
  if (fcN !== yms.length) res.forecastYtd = null;
  return res;
}

