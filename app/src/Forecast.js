/**
 * Forecast.js — 新アプリでの予測の実行（段階2-2b）。
 * 旧来の予測（A-9）を、データ本体から組み立てた計算用ブックで動かし、書き換わったシートだけをデータ本体へ戻す。
 * 結果は FORECAST_RUNS（1 回 1 行）と FORECAST_MONTHLY（月ごと）に残す。「今」= 実行を始めた時刻。
 * 乱数の種は、予測が読む表の中身と計算の版から決める（appForecastSeed_。2026-10-08 村井さん承認 決定 13: 同じ入力なら同じ数字。
 * FORECAST_RUNS.seed に残す）。旧来の計算が作る ID は、実行の ID から作る（回ごとに違う。B-2 が回を分ける）。
 * 1 回の実行の上限（6 分）に収まるよう、3 つの処理に分ける（2026-10-03 から。組み立ては何回かに分かれることがある）。
 *   組み立て（FORECAST.RUN）: データ本体から計算用ブックを組み立てる
 *   計算（FORECAST.RUN_CALC）: 旧来の予測を動かす（データ本体には書かない）
 *   保存（FORECAST.RUN_SAVE）: 書き換わったシートを控えの形にし、計算の間にデータ本体が変わっていないことを確かめてから書く
 * 計算用ブックは処理の印（APP_SCRATCH_OWNER）で、組み立てたままかを確かめる。書くときは保存の控え（Journal.js）を置く。
 * 保存の段で、旧来の予測が真ん中に書き直した予算の欄（OUTPUT の採用予測・上乗せ）を、予算の下書きで書き直してから戻す（版 11。BudgetDrafts.js）。
 */

function appPlanOf_(planId) {
  const plan = appReadTable_('PLANS').filter(x => x.plan_id === String(planId || ''))[0];
  if (!plan) throw new Error('計画が見つかりません。');
  return plan;
}

/** 計画の計算用の表の中身（シートごとのハッシュ）をまとめたハッシュ。計算の間に変わっていないかを確かめる。読むのはその計画の行だけ */
function appPlanInputHash_(planId) {
  const rows = appReadPlanTable_('ENG_SHEETS', planId).map(r => r.sheet + ':' + r.content_hash).sort();
  return appSha256Hex_(rows.join('|'));
}

/**
 * 予測の乱数の種が見る表: 旧来の予測（A-9）が数字を作るために読む表（2026-10-08 村井さん承認 決定 13: 同じ入力なら同じ数字）。
 * 入れないもの:
 *   - 予測が自分で書く表（結果の OUTPUT と、記録の FORECAST_SNAPSHOT・AI_SCORE_HISTORY・AI_IMPACT_HISTORY・SUBJECTIVE_IMPACT_HISTORY・
 *     PROCESS_STATUS・RUN_LOG）。入れると予測のたびに種が変わり、何も変えずにもう一度予測しても数字が揺れる
 *   - SALES_MONTHLY（予測が SALES_INPUT から毎回作り直す。元の SALES_INPUT を入れる）
 *   - 振り返り・見直しの表（EVAL_*・DASHBOARD・QUARTERLY_*・RELIABILITY_EVIDENCE・CALIBRATION_HISTORY・POOL_PRIOR）。予測は読まないので、
 *     その表だけが変わる操作（記入の保存・実績の取り込み B-1 など）では、予測の数字は変わらない。
 *     ただし当たり具合の計算（B-2）は、最後に月次の自動学習（B-5 と同じ）を動かし、補正の CALIBRATION_STATE（種が見る表）を書くことがある。
 *     そのときは B-2 の後の予測の数字が変わる（入力の変化として種も変わる。乱数の揺れではない）
 * VERTEX_FORECAST_LOG は AI のアシストを使う設定のときだけ読む。ここに無い表を予測が読むようになっても、数字は入力どおりに変わる
 * （同じ乱数の並びで計算するだけ）。本物の A-9 が開く表と比べるテスト: app/tests/app-forecast-seed.test.mjs
 * 例外（既定ではない設定）: CONFIG の AI_SCORE_BASIS を momentum にすると、A-9 は自分で書き足す AI_SCORE_HISTORY を読む（種には入れない
 * 記録の表）。そのため市場の調査（A-4）の直後は、何も変えずに 2 回予測しても 1 回目が書いた行を 2 回目が読み、数字が違うことがある（app/README.md）
 */
const APP_FORECAST_SEED_SHEETS = ['CONFIG', 'SALES_INPUT', 'PRODUCT', 'CLIENT', 'OPINIONS', 'DEV_SPOT', 'AI_RESEARCH', 'AI_RESEARCH_STRUCTURED',
  'CALIBRATION_STATE', 'SOURCE_RELIABILITY', 'VERTEX_FORECAST_LOG'];

/** 予測が読む表（APP_FORECAST_SEED_SHEETS）の中身をまとめたハッシュ。予測が自分で書く表は入れない。読むのはその計画の行だけ */
function appForecastInputHash_(planId) {
  const rows = appReadPlanTable_('ENG_SHEETS', planId).filter(r => APP_FORECAST_SEED_SHEETS.indexOf(r.sheet) >= 0)
    .map(r => r.sheet + ':' + r.content_hash).sort();
  return appSha256Hex_(rows.join('|'));
}

/**
 * 予測の乱数の種（64 桁の 16 進。FORECAST_RUNS.seed に残す）: 予測が読む表の中身（appForecastInputHash_）・計画の時差と地域（計算用ブックの日付の読み方）・
 * 旧来の計算の版と中身のハッシュ・アプリの版から決める。同じ入力・同じ版なら、いつ何回動かしても同じ P10/P50/P90 になる。
 * 「今」（as_of）は入れない: 予測は「今」を月の単位でだけ使う（どの月が締まったか。旧来の getForecastContext_）ので、同じ月の中なら
 * 日や時刻が違っても数字は変わらない。種に「今」を入れると、何も変えずに動かし直すたびに数字が揺れる（入れる前の動き）。
 * 月が変わって締まった月が増えれば、数字は入力の変化として変わる（乱数の揺れではない）。
 * engine = { version, sourceSha256 }（appRunLegacyForecast_ が、動かす旧来の計算から渡す）
 */
function appForecastSeed_(plan, forecastInputHash, engine) {
  return appSha256Hex_(['forecast-seed-v1', forecastInputHash, plan.time_zone || '', plan.locale || '',
    engine && engine.version || '', engine && engine.sourceSha256 || '', APP_VERSION].join('|'));
}

/**
 * 予測の版（FORECAST_RUNS の版 10 の列。SCHEMA_PLAN_v10-12_JA.md の 3-8）: 新しい回に、アプリの版（app_version = APP_VERSION）・
 * 種の決め方（seed_rule。INPUT_V1 = 入力の中身と版から決めた種 appForecastSeed_）・
 * 本番に入れたアプリ側の直し（fixes_json。決定 10・12 の直しを本番にしたら、その名前を足す。今は無い）を書く。前からある行は空のまま（書き換えない）。
 * 空の seed_rule は seed で読み分ける: 64 文字の 16 進なら INPUT_V1（v0.29.0・@65）、RUN-… なら実行ごとの種（v0.28.0 まで）。
 * 種に APP_VERSION が入るので、版を上げた後の最初の予測は、同じ入力でも数字が少し動く（版 10 の手元の試しで年間の中心 −0.56%）
 */
const APP_FORECAST_SEED_RULE = 'INPUT_V1';
const APP_FORECAST_FIXES = [];

/**
 * 組み立て（FORECAST.RUN）: データ本体から計算用ブックを組み立てる。1 回の上限に収まらなければ、同じ処理を続けて動かす。
 * 「今」（asOfMs）・実行の ID（runId。旧来の計算が作る ID の種）・入力のハッシュは最初の回に決め、続きの処理に渡す。乱数の種は計算で決める
 */
function appForecastRunBuild_(ctx, p, job) {
  const plan = appPlanOf_(p.planId);
  const jobStart = new Date().getTime();
  return appWithLock_(() => {
    if (!p.build) appJournalRecover_(ctx);   // 前の保存が途中で止まっていれば、先に書き終える
    const inputHash = appPlanInputHash_(plan.plan_id);
    if (p.build && inputHash !== p.inputHash) throw new Error('組み立てている間にデータ本体が変わりました。もう一度実行してください。');
    const runId = p.runId || appId_('RUN');
    const asOfMs = p.asOfMs || jobStart;
    const step = appScratchBuildStep_(appWorkScratch_(plan), plan.plan_id, null, p.build || null, appBuildDeadline_(jobStart));
    const payload = { planId: plan.plan_id, confirms: (p.confirms || []).map(String), runId: runId, asOfMs: asOfMs, inputHash: inputHash,
      startedAt: Utilities.formatDate(new Date(asOfMs), APP_TZ, "yyyy-MM-dd'T'HH:mm:ssZ"), build: step.state,
      buildMs: Number(p.buildMs || 0) + (new Date().getTime() - jobStart) };
    return { __next: { kind: step.complete ? 'FORECAST.RUN_CALC' : 'FORECAST.RUN', payload: payload },
      audit: { entityId: plan.plan_id, clientId: plan.client_id } };
  });
}

/**
 * 計算（FORECAST.RUN_CALC）: 組み立てた計算用ブックで旧来の予測を動かす。確認が要るときは何も保存せずに返す。
 * 乱数の種は、予測が読む表の中身と動かす旧来の計算の版から（appForecastSeed_）。旧来の計算が作る ID は実行の ID から
 */
function appForecastRunCalc_(ctx, p) {
  const plan = appPlanOf_(p.planId);
  const t0 = new Date().getTime();
  return appWithLock_(() => {
    if (!p.build || !appScratchOwnedBy_(p.build.token)) throw new Error('計算用ブックがほかの処理で使われました。もう一度実行してください。');
    if (appPlanInputHash_(plan.plan_id) !== p.inputHash) throw new Error('予測を計算している間にデータ本体が変わりました。もう一度実行してください。');
    const scratch = appWorkScratch_(plan);
    const forecastInputHash = appForecastInputHash_(plan.plan_id);
    const layerTail = appLayerTail_(scratch);   // 計算の前の記録のシートの行の数（この回に足された行を、保存の段で層ごとの効きに使う。LayerEffects.js）
    const run = appRunLegacyForecast_(scratch, { asOfMs: p.asOfMs, seed: eng => appForecastSeed_(plan, forecastInputHash, eng), uuidSeed: p.runId,
      confirms: p.confirms || [], actor: ctx.actor });
    if (!run.ok) return { needConfirm: run.needConfirm, planId: plan.plan_id, audit: { entityId: plan.plan_id, clientId: plan.client_id } };
    const payload = Object.assign({}, p, { seed: run.seed, engine: { version: run.version, sourceSha256: run.sourceSha256 }, headline: appForecastHeadline_(scratch),
      runMs: new Date().getTime() - t0, layerTail: layerTail });
    return { __next: { kind: 'FORECAST.RUN_SAVE', payload: payload }, audit: { entityId: plan.plan_id, clientId: plan.client_id } };
  });
}

/** 保存（FORECAST.RUN_SAVE）: 計算の間にデータ本体が変わっていないことを確かめ、書き換わったシートと予測の記録を、控えを置いてから書く */
function appForecastRunSave_(ctx, p) {
  const plan = appPlanOf_(p.planId);
  const t0 = new Date().getTime();
  return appWithLock_(() => {
    appJournalRecover_(ctx);   // 書きかけの控えを先に書き終える（途中の表から控えを作らない）
    if (!p.build || !appScratchOwnedBy_(p.build.token)) throw new Error('計算用ブックがほかの処理で使われました。もう一度実行してください。');
    if (appPlanInputHash_(plan.plan_id) !== p.inputHash) throw new Error('予測を計算している間にデータ本体が変わりました。もう一度実行してください。');
    const scratch = appWorkScratch_(plan);
    // 予算の下書きを戻す（版 11 の 4-1）: 旧来の予測が採用予測を月の真ん中に・上乗せを空に書き直したので、控えの形にする前に、
    // 計算用ブックの OUTPUT の採用予測と上乗せを、月ごとの一番新しい下書きで書き直す（下書きが無ければ旧来のとおり。BudgetDrafts.js）。
    // そのためデータ本体に残る OUTPUT の予算の欄は、旧来の計算だけの結果と違う（予測の数字・種は変えない）
    const budget = appBudgetRestoreOnForecast_(ctx, plan, scratch);
    const cap = appCaptureChanged_(scratch, plan.plan_id, appStoredHashes_(plan.plan_id));
    const t1 = new Date().getTime();
    const names = cap.changed.map(e => e.sheetRow.sheet);
    const h = p.headline || { annual: {}, objective: {}, monthly: [], objectiveMonthly: [] };
    const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
    const now = appNowIso_();
    const obj = {};
    (h.objectiveMonthly || []).forEach(m => { obj[m.month] = m; });
    const ops = appChangedOps_(ctx, plan.plan_id, cap.changed, p.runId).concat([
      { table: 'FORECAST_RUNS', mode: 'ensure', rows: [{
        run_id: p.runId, plan_id: plan.plan_id, status: 'DONE', engine_version: p.engine.version, engine_sha256: p.engine.sourceSha256,
        seed: p.seed, as_of: Utilities.formatDate(new Date(p.asOfMs), APP_TZ, "yyyy-MM-dd'T'HH:mm:ssZ"), input_hash: p.inputHash,
        annual_p10: num(h.annual.p10), annual_p50: num(h.annual.p50), annual_p90: num(h.annual.p90),
        objective_p10: num(h.objective.p10), objective_p50: num(h.objective.p50), objective_p90: num(h.objective.p90),
        changed_sheets_json: names, confirms_json: p.confirms, started_at: p.startedAt, finished_at: now, actor_email: ctx.actor,
        app_version: APP_VERSION, seed_rule: APP_FORECAST_SEED_RULE, fixes_json: appForecastFixesOf_(scratch) }] },   // 本番にした回は annual_aligned（Portfolio.js）
      { table: 'FORECAST_MONTHLY', mode: 'ensure', rows: (h.monthly || []).map(m => ({
        run_id: p.runId, plan_id: plan.plan_id, ym: m.month, p10: num(m.p10), p50: num(m.p50), p90: num(m.p90),
        obj_p10: obj[m.month] ? num(obj[m.month].p10) : null, obj_p50: obj[m.month] ? num(obj[m.month].p50) : null, obj_p90: obj[m.month] ? num(obj[m.month].p90) : null })) }
    ], appLayerEffectsOps_(ctx, plan, p, h, scratch), budget.ops);   // 層ごとの効き 12 行（LAYER_EFFECTS。3-3）と、写す前の予算の BASELINE（版 11）を同じ控えで足す
    const written = appJournalRun_(ctx, '予測の保存（' + p.runId + '）', plan.plan_id, ops);
    appScratchMarkSynced_(plan.plan_id, p.build.token, null, p.build.problems);   // 次の予測は組み立て直さずに使える
    return { runId: p.runId, planId: plan.plan_id, changed: names, written: written, headline: h, unknown: cap.unknown,
      budgetRestored: budget.restored,
      build: (p.build && p.build.problems) || [],
      timing: { buildMs: p.buildMs || 0, runMs: p.runMs || 0, captureMs: t1 - t0, saveMs: new Date().getTime() - t1 },
      audit: { entityId: p.runId, clientId: plan.client_id } };
  });
}

/**
 * 計算用ブックの各シートを控えの形にし、データ本体と中身（ハッシュ）が違うものだけを返す。
 * only を渡すと、そのシートだけを見る（一部だけを組み立てた計算用ブックのとき）
 */
function appCaptureChanged_(scratch, planId, stored, only) {
  const changed = [];
  const unknown = [];
  scratch.getSheets().forEach(sh => {
    const name = sh.getName();
    if (only && only.indexOf(name) < 0) return;
    const reg = APP_ENGINE_SHEETS[name];
    if (!reg) { unknown.push(name); return; }
    const enc = appEngEncodeSheet_(planId, appSheetSnapshot_(sh, reg.header ? reg.header.length : 0));
    if (stored[name] !== enc.sheetRow.content_hash) changed.push(enc);
  });
  return { changed: changed, unknown: unknown };
}

/** 計画のシートごとの中身のハッシュ（{ シート名: content_hash }）。読むのはその計画の行だけ */
function appStoredHashes_(planId) {
  const stored = {};
  appReadPlanTable_('ENG_SHEETS', planId).forEach(r => { stored[r.sheet] = r.content_hash; });
  return stored;
}

/**
 * 控えの形にしたシートで、データ本体の計画 planId の行を入れ替える書き方（ops。appJournalRun_ に渡す）。
 * 履歴の表は、前の行がそのままなら足された行だけを書く。
 * 入力の 4 つの表が変わった行（と自信だけ変えた行）は、入力の記録（INPUT_LOG）も同じ控えに足す（InputLog.js。log = { action, reason, conf }）
 */
function appChangedOps_(ctx, planId, changed, batchId, log) {
  const now = appNowIso_();
  const names = changed.map(e => e.sheetRow.sheet);
  const ops = [];
  const inputLog = appInputLogOps_(ctx, planId, changed, batchId, log);   // 前の行は書く前のデータ本体から読む
  changed.forEach(enc => {
    const name = enc.sheetRow.sheet;
    if (APP_ENGINE_SHEETS[name].mode !== 'table') return;
    const rows = enc.sheetRow.mode === 'table' ? enc.tableRows : [];   // 見出しが違えば ENG_ROWS 側に持つ
    ops.push(appOpReplaceOrAppend_('ENG_' + name, planId, rows));
  });
  if (!changed.length) return ops.concat(inputLog);
  const segs = [].concat.apply([], changed.map(e => e.rowSegs));
  const fmts = [].concat.apply([], changed.map(e => e.formatRows));
  ops.push(appOpReplacePlan_('ENG_ROWS', planId, names, segs));
  ops.push(appOpReplacePlan_('ENG_FORMATS', planId, names, fmts));
  inputLog.forEach(op => ops.push(op));
  // シートの大きさとハッシュは最後に書く（途中で止まっても、控えから書き直すまで「入力のハッシュ」は前のまま）
  ops.push(appOpReplacePlan_('ENG_SHEETS', planId, names,
    changed.map(e => Object.assign({}, e.sheetRow, { import_batch_id: batchId, updated_at: now, updated_by: ctx.actor }))));
  return ops;
}

/** データ本体の OUTPUT（計画を作ったとき、または最後の予測）から、主な結果を読む。読むのはその計画の行だけ */
function appStoredHeadline_(planId) {
  const segs = appReadPlanTable_('ENG_ROWS', planId).filter(r => r.sheet === 'OUTPUT');
  const rows = {};
  segs.forEach(s => { if (Number(s.col_from) === 1) rows[Number(s.row_no)] = JSON.parse(s.cells_json); });
  const cell = (r, c) => { const x = (rows[r] || [])[c - 1]; return x ? appCellDecode_(x.charAt(0) === 'f' ? 'e' : x.charAt(0), x.slice(1)) : ''; };
  const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
  if (!rows[26]) return null;
  const month = v => (appIsDate_(v) ? Utilities.formatDate(v, APP_TZ, 'yyyy/MM') : String(v));
  const monthly = [];
  for (let r = 29; r <= 40; r++) monthly.push({ month: month(cell(r, 1)), p10: num(cell(r, 2)), p50: num(cell(r, 3)), p90: num(cell(r, 4)) });
  return { title: String(cell(1, 1) || ''), annual: { p10: num(cell(26, 2)), p50: num(cell(26, 3)), p90: num(cell(26, 4)) },
    objective: { p10: num(cell(65, 2)), p50: num(cell(65, 3)), p90: num(cell(65, 4)) }, monthly: monthly };
}

/**
 * 見る人に合わせた最新の予測（apiForecastLatest。控えは見る人によらず同じものを使うので、写しを直す。控えそのものは変えない）。
 * 操作した人のメール（latest.actor_email・runs[].actor）は、その計画のメーカーで予算策定担当以上の人だけに出す（閲覧の人には空。画面は「-」。2026-10-13）
 */
function appForecastLatestFor_(ctx, out) {
  if (!out || !out.plan) return out;
  if (appInsightDetailFor_(ctx, appPlanOf_(out.plan.planId).client_id) === 'full') return out;
  const o = appSerialize_(out);
  if (o.latest) o.latest.actor_email = '';
  (o.runs || []).forEach(r => { r.actor = ''; });
  return o;
}

/** 画面: 計画の最新の予測（新アプリで動かした記録）と、データ本体の OUTPUT の結果 */
function appForecastLatest_(planId) {
  const plan = appPlanOf_(planId);
  const clients = appClientNameMap_();   // 画面に出す名前（半角カナ・株式会社などを除いた、ふつうの表記）
  const runs = appReadTable_('FORECAST_RUNS').filter(r => r.plan_id === plan.plan_id).map(appStripRow_)
    .sort((a, b) => (a.finished_at < b.finished_at ? 1 : -1));
  const latest = runs[0] || null;
  const monthly = latest ? appReadTable_('FORECAST_MONTHLY').filter(m => m.run_id === latest.run_id).map(appStripRow_) : [];
  return {
    plan: { planId: plan.plan_id, clientName: clients[plan.client_id] || plan.client_label, fy: plan.fy },
    latest: latest, monthly: monthly,
    runs: runs.slice(0, 10).map(r => ({ runId: r.run_id, finishedAt: r.finished_at, actor: r.actor_email, p50: r.annual_p50 })),
    stored: appStoredHeadline_(plan.plan_id)
  };
}
