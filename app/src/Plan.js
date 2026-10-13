/**
 * Plan.js — 計画の画面（段階2-3）。旧来の Web アプリ（Forecast_WebApp.js）と同じ内容と操作を、データ本体の上で行う。
 *
 * - 見る: データ本体から読むだけのブック（appStoreBook_）を組み立て、旧来の webGetBootstrap_ をそのまま動かす。
 *         計算用ブックを使わないので速い。結果は入力のハッシュごとに 6 時間覚えておく。
 *         人ごとの当たりと外れた月の担当は、予算策定担当以上の人だけに出す（appPlanViewFor_。学びと同じ決まり）。
 *         検証の記入は、予測と実績が今の検証の版の B-2 が測った数字（B-4 が写す形）と違う行と、今の版の B-2 が初めて動く前に書いた行を出さない
 *         （appPlanViewDropStale_。学びの振り返りと同じ決まり）。ただし、その月に出す行があれば、その月の人が書いた一番新しい行は出す
 *         （数字・印は出す行のものにする。2026-10-08 村井さん承認）。
 *         予測の注記は、止めている C-1 への案内を除き、所有者が承認した補正の値をそう書く（appPlanViewNotes_）。
 * - 保存（入力・予算・インサイトの記入・四半期レビューの承認）: 使うシートだけを計算用ブックに組み立て、
 *         旧来の webSave* をそのまま動かし、変わったシートをデータ本体へ戻す（1 つの裏の処理）。
 *         予算の保存は、保存した後の 12 か月を予算の下書き（BUDGET_DRAFTS。版 11）にも同じ控えで足す（決め方・確率・割り振りは下書きにだけ使う。
 *         BudgetDrafts.js）。画面の中身には今の下書き（boot.budgetDraft）を、覚えておく中身の外で足す。
 * - 実行（A-3・B-2〜B-5・C-1・C-3）: 予測の実行と同じく、全部のシートを組み立てて旧来の webRun* を動かし、
 *         計算 → 保存の 2 つの裏の処理で戻す（計算の間にデータ本体が変わっていないことを確かめる）。
 * 記録は PLAN_ACTIONS（1 回 1 行）と監査ログ。旧来の webAudited_（旧来のログ）は使わない（LegacyEngine.js で差し替え）。
 * 外部とつなぐもの（A-2・B-1 の取り込み、A-4 の AI 調査、Vertex のアシスト）と A-1 の設定は、まだここに入れていない。
 * 補正の値の書き込み（CALIBRATION.SET）は所有者だけ（apiOwnerTask の setCalibration。中身は Calibration.js）。
 * 四半期の見直し案を作る（REVIEW.GENERATE・C-1）は、学びの仕組みを直すまで止めている（2026-10-07 村井さん決定 D3。始める前に断る）。
 */

/** 止めている操作の理由（始める前に断る文・画面のボタンの説明） */
const APP_REVIEW_GENERATE_PAUSED = '見直し案を作る操作は、学びの仕組みを直すまで止めています（2026/10/07 所有者の決定）。';
/** 予測の注記（OUTPUT!A6。旧来の A-9 の buildOutputCalibrationSummary_ が「 / 」でつなぐ）の、C-1 を動かすよう案内する文 */
const APP_PLAN_NOTE_C1_HINT = / \/ (?:3か月以上の実績確定後に|次回の四半期レビューは3か月後に) C-1 を実行してください。/g;
/**
 * 同じ注記の四半期チューニングの区切り（旧来の buildOutputCalibrationSummary_ が「 / 」でつなぐ）: 「適用中の四半期チューニング: 」と、
 * 四半期（無ければ「なし（全項目既定値）」）。四半期のときは「・ai_weight_override: …」「・ai_topic_disable: …」「・bias_correction_factor: …」も。
 * 後ろの C-1 への案内と警告（・で始まらない）は含めない
 */
const APP_PLAN_NOTE_TUNING = /適用中の四半期チューニング: (?:(?! \/ |\n).)*(?: \/ ・(?:(?! \/ |\n).)*)*/g;
/** 所有者が承認した値を書いた（setCalibration）ときの、その区切りの書き方（値は appPlanOwnerNote_） */
const APP_PLAN_NOTE_OWNER = '所有者が承認した値';

/** 計画への保存・実行（名前は旧来の Web アプリの操作の記録と同じ） */
const APP_PLAN_ACTIONS = {
  'INPUT.SAVE': { kind: 'edit', minRole: 'PLANNER', fn: 'webSaveInputs', label: '入力の保存',
    sheets: ['CONFIG', 'PRODUCT', 'CLIENT', 'OPINIONS', 'DEV_SPOT'], args: a => [a.kind, a.rows] },
  'BUDGET.SAVE': { kind: 'edit', minRole: 'PLANNER', fn: 'webSaveBudget', label: '予算の保存', sheets: ['OUTPUT'], args: a => [a.rows] },
  'INSIGHT.SAVE': { kind: 'edit', minRole: 'PLANNER', fn: 'webSaveEvalInsights', label: 'インサイトの記入の保存', sheets: ['EVAL_INSIGHTS'], args: a => [a.rows] },
  'REVIEW.DECIDE': { kind: 'edit', minRole: 'APPROVER', fn: 'webSaveQuarterlyDecisions', label: '四半期レビューの承認の保存',
    sheets: ['QUARTERLY_REVIEW'], args: a => [a.rows] },
  // A-1 の担当者（クライアントと年度は計画で決まるので変えない）。旧来の saveInitialSetupSettings と同じく CONFIG!B4 に書く
  'SETUP.PEOPLE': { kind: 'edit', minRole: 'ADMIN', local: 'appPlanSetPeople_', label: '担当者の保存', sheets: ['CONFIG'], args: a => [a.peopleCsv] },
  // 所有者が承認した補正の値を CALIBRATION_STATE に書き、履歴を CALIBRATION_HISTORY に足す。承認待ちの見直し案の取り下げも（Calibration.js）。
  // 所有者だけ（ownerOnly: 管理者の役割があっても、ほかの人は断る）
  'CALIBRATION.SET': { kind: 'edit', minRole: 'ADMIN', ownerOnly: true, local: 'appCalibrationSet_', label: '補正の値の書き込み（所有者）',
    sheets: ['CONFIG', 'CALIBRATION_STATE', 'CALIBRATION_HISTORY', 'QUARTERLY_REVIEW', 'QUARTERLY_REVIEW_LOG'], args: a => [a] },
  // A-2・B-1: 設定の「ZAC の実績のスプレッドシート」から読む（旧来と同じ関数）。取り込みは管理者（設計 6 章）
  // 使うシートだけを組み立てる（全部を組み立てると、外部の読み込みと合わせて 1 回の上限 6 分を超えた。2026-10-03）。
  // シートは旧来の関数から呼ぶ関数をたどって洗い出した（画面の読み取り webGetBootstrap_ と、表示/非表示だけの hideNonUserSheets_ は除く）
  'IMPORT.SALES': { kind: 'run', minRole: 'ADMIN', fn: 'webRunImportSales', label: 'A-2 売上データの取り込み',
    sheets: ['CONFIG', 'SALES_INPUT', 'PROCESS_STATUS', 'RUN_LOG', 'PRODUCT', 'CLIENT', 'OPINIONS', 'DEV_SPOT'] },
  'IMPORT.ACTUALS': { kind: 'run', minRole: 'ADMIN', fn: 'webRunImportActuals', label: 'B-1 検証用の実績の取り込み',
    sheets: ['CONFIG', 'ACTUAL_EVAL_MONTHLY', 'PROCESS_STATUS', 'RUN_LOG'] },
  'SALES.AGGREGATE': { kind: 'run', minRole: 'PLANNER', fn: 'webRunAggregate', label: 'A-3 売上データの加工' },
  // A-4 は Vertex AI に問い合わせる（Ai.js）。読む・書くシートだけを組み立てる（AI_RESEARCH_RAW・TASK_LOG はデータ本体に移さない表なので、その回限り）。
  // 手で始めるのは計画ごとに 1 日 3 回まで（manualPerDay。費用の歯止め。自動の調べは数えない。Ai.js の appAiManualCheck_）
  'AI.RESEARCH': { kind: 'run', minRole: 'PLANNER', fn: 'webRunAiResearch', label: 'A-4 AI 調査', ai: true, manualPerDay: 3,
    sheets: ['CONFIG', 'PROCESS_STATUS', 'RUN_LOG', 'SALES_INPUT', 'SALES_MONTHLY', 'PRODUCT', 'CLIENT', 'OPINIONS', 'DEV_SPOT', 'EVAL_LOG',
      'AI_RESEARCH', 'AI_RESEARCH_STRUCTURED', 'AI_SCORE_HISTORY', 'VERTEX_FORECAST_LOG'] },
  // B-2 は検証の表の 25〜36 列に要約を書く。計算の前に、計算用ブックの表を 36 列まで広げる（widen。Engine.js の APP_ENGINE_MIN_COLUMNS）
  'EVAL.REPORT': { kind: 'run', minRole: 'PLANNER', fn: 'webRunEvalReport', label: 'B-2 検証レポートの更新', widen: ['EVAL_COMPARE_MONTHLY'] },
  'EVAL.DASHBOARD': { kind: 'run', minRole: 'PLANNER', fn: 'webRunDashboard', label: 'B-3 ダッシュボードの更新' },
  'EVAL.INSIGHTS': { kind: 'run', minRole: 'PLANNER', fn: 'webRunInsights', label: 'B-4 学習インサイトの更新' },
  'LEARN.MONTHLY': { kind: 'run', minRole: 'PLANNER', fn: 'webRunMonthlyLearn', label: 'B-5 月次の自動学習' },
  'REVIEW.GENERATE': { kind: 'run', minRole: 'PLANNER', fn: 'webRunQuarterly', label: 'C-1 四半期レビューの提案', paused: APP_REVIEW_GENERATE_PAUSED },
  'REVIEW.APPLY': { kind: 'run', minRole: 'APPROVER', fn: 'webApplyQuarterly', label: 'C-3 承認した提案の適用' }
};

function appPlanAction_(name, kind) {
  const a = APP_PLAN_ACTIONS[String(name || '')];
  if (!a || (kind && a.kind !== kind)) throw new Error('未定義の操作です: ' + name);
  return a;
}

/** 止めている操作なら、その理由（止めていなければ空）。始める前に断る（Jobs.js の appStartJob_） */
function appPlanActionPaused_(name) {
  const a = APP_PLAN_ACTIONS[String(name || '')];
  return a && a.paused ? a.paused : '';
}

// ---- 読むだけのブック ----

/** 列の文字（A, B, …, AA）を 0 始まりの番号に */
function appColIndex_(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

/**
 * 旧来の計算が書く数式（OUTPUT の予算の列だけ: =SUM(H5:H16) と =H5+I5）の値。ほかの数式は空として読む。
 * Sheets と同じく、空のセルは 0 として足す。
 */
function appEvalFormula_(f, value) {
  const num = v => (v === '' || v === null || v === undefined ? 0 : v);
  let m = /^=SUM\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)$/.exec(String(f));
  if (m && m[1] === m[3]) {
    const c = appColIndex_(m[1]);
    let s = 0;
    for (let r = Number(m[2]) - 1; r <= Number(m[4]) - 1; r++) { const v = value(r, c); if (typeof v === 'number') s += v; }
    return s;
  }
  m = /^=([A-Z]+)(\d+)\+([A-Z]+)(\d+)$/.exec(String(f));
  if (m) {
    const a = num(value(Number(m[2]) - 1, appColIndex_(m[1])));
    const b = num(value(Number(m[4]) - 1, appColIndex_(m[3])));
    return typeof a === 'number' && typeof b === 'number' ? a + b : '#VALUE!';
  }
  return '';
}

/** 読むだけのもの: 用意していない操作（書き込みなど）を呼ぶと、何をしようとしたかを示して止める */
function appReadOnly_(obj, what) {
  return new Proxy(obj, {
    get(t, k) {
      if (k in t || typeof k === 'symbol') return t[k];
      return () => { throw new Error('画面の表示では使えない操作です（' + what + '.' + String(k) + '）。'); };
    }
  });
}

/** 組み立てたシート 1 枚を、読むだけの Sheet に見せる */
function appViewSheet_(dec, parent) {
  const value = (r, c) => {
    if (r < 0 || c < 0 || r >= dec.lastRow || c >= dec.lastCol) return '';
    const f = dec.formulas[r][c];
    return f ? appEvalFormula_(f, value) : dec.values[r][c];
  };
  const formula = (r, c) => (r < dec.lastRow && c < dec.lastCol ? dec.formulas[r][c] || '' : '');
  const grid = (r0, c0, nr, nc, fn) => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => fn(r0 + i, c0 + j)));
  const display = v => (v === '' || v === null || v === undefined ? '' : appIsDate_(v) ? Utilities.formatDate(v, APP_TZ, 'yyyy/MM/dd') : String(v));
  let sheet = null;
  const range = (r0, c0, nr, nc) => {
    if (!(nr >= 1)) throw new Error('The number of rows in the range must be at least 1.');
    if (!(nc >= 1)) throw new Error('The number of columns in the range must be at least 1.');
    return appReadOnly_({
      getValue: () => value(r0, c0),
      getValues: () => grid(r0, c0, nr, nc, value),
      getDisplayValue: () => display(value(r0, c0)),
      getDisplayValues: () => grid(r0, c0, nr, nc, (r, c) => display(value(r, c))),
      getFormula: () => formula(r0, c0),
      getFormulas: () => grid(r0, c0, nr, nc, formula),
      getRow: () => r0 + 1, getColumn: () => c0 + 1, getNumRows: () => nr, getNumColumns: () => nc,
      getLastRow: () => r0 + nr, getLastColumn: () => c0 + nc,
      getA1Notation: () => appA1_(r0, c0) + (nr > 1 || nc > 1 ? ':' + appA1_(r0 + nr - 1, c0 + nc - 1) : ''),
      getSheet: () => sheet
    }, 'Range');
  };
  const a1 = text => {
    const m = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(String(text).replace(/\$/g, '').toUpperCase());
    if (!m) throw new Error('読めない範囲です: ' + text);
    const r0 = m[2] ? Number(m[2]) - 1 : 0;
    const c0 = appColIndex_(m[1]);
    if (!m[3]) return range(r0, c0, m[2] ? 1 : dec.maxRows, 1);
    const r1 = m[4] ? Number(m[4]) - 1 : dec.maxRows - 1;
    const c1 = appColIndex_(m[3]);
    return range(Math.min(r0, r1), Math.min(c0, c1), Math.abs(r1 - r0) + 1, Math.abs(c1 - c0) + 1);
  };
  sheet = appReadOnly_({
    getName: () => dec.name, getLastRow: () => dec.lastRow, getLastColumn: () => dec.lastCol,
    getMaxRows: () => dec.maxRows, getMaxColumns: () => dec.maxCols,
    getRange: (a, b, c, d) => (typeof a === 'string' ? a1(a) : range(Number(a) - 1, Number(b) - 1, c === undefined ? 1 : Number(c), d === undefined ? 1 : Number(d))),
    getDataRange: () => range(0, 0, Math.max(1, dec.lastRow), Math.max(1, dec.lastCol)),
    getSheetId: () => 0, isSheetHidden: () => false, getFrozenRows: () => 0, getFrozenColumns: () => 0, getParent: () => parent
  }, 'Sheet');
  return sheet;
}

/**
 * データ本体の計画 1 つ分を、読むだけの Spreadsheet に見せる（旧来の画面の読み取りを、計算用ブックなしで動かす）。
 * シートは使われたときに組み立てる。表示形式は読まない。
 */
function appStoreBook_(plan) {
  const planId = plan.plan_id;
  const meta = {};
  appReadPlanTable_('ENG_SHEETS', planId).forEach(r => { meta[r.sheet] = r; });
  const loaded = {};
  let segs = null;
  let book = null;
  const load = name => {
    if (Object.prototype.hasOwnProperty.call(loaded, name)) return loaded[name];
    const m = meta[name];
    if (!m) return (loaded[name] = null);
    if (!segs) {
      segs = {};
      appReadPlanTable_('ENG_ROWS', planId).forEach(r => { (segs[r.sheet] = segs[r.sheet] || []).push(r); });
    }
    const rows = m.mode === 'table' ? appReadPlanTable_('ENG_' + name, planId) : [];
    const dec = appEngDecodeSheet_(Object.assign({}, m, { fmt_columns: '0' }), rows, segs[name] || [], []);
    return (loaded[name] = appViewSheet_(dec, book));
  };
  book = appReadOnly_({
    getSheetByName: n => load(String(n)),
    getSheets: () => Object.keys(APP_ENGINE_SHEETS).filter(n => meta[n]).map(load),
    getId: () => '', getUrl: () => '', getName: () => String(plan.client_label || ''),
    getSpreadsheetTimeZone: () => plan.time_zone || APP_TZ, getSpreadsheetLocale: () => plan.locale || 'ja_JP',
    toast: () => {}
  }, 'Spreadsheet');
  return book;
}

// ---- 見る ----

/** 計画の画面の中身（旧来の Web アプリの webGetBootstrap_ と同じもの）。入力が同じなら覚えておいたものを返す */
function appPlanView_(ctx, planId) {
  const plan = appPlanOf_(planId);
  const clients = appClientNameMap_();   // 画面に出す名前（半角カナ・株式会社などを除いた、ふつうの表記）
  const roles = ctx.roles || [];
  const frozen = appYearIsFrozen_(plan.fy);
  const pending = appJournalPending_();
  if (pending) {
    // 保存が途中で止まっている間は、表どうしが食い違っていることがあるので組み立てない（続きを書くまで待ってもらう）
    return { plan: { planId: plan.plan_id, clientName: clients[plan.client_id] || plan.client_label, fy: plan.fy, frozen: frozen, measure: appPlanIsMeasure_(plan) },
      pendingWrite: { label: pending.label, at: pending.at }, can: { plan: appHasRole_(roles, 'PLANNER') && !frozen, approve: false, admin: appHasRole_(roles, 'ADMIN') && !frozen },
      actions: [], recent: [], boot: null };
  }
  const inputHash = appPlanInputHash_(plan.plan_id);
  const day = Utilities.formatDate(new Date(), APP_TZ, 'yyyy-MM-dd');   // 旧来の画面は「今日」で変わる（既定の年度など）
  const key = 'VIEW_' + appSha256Hex_([plan.plan_id, inputHash, day, APP_VERSION].join('|')).slice(0, 32);
  const cached = appJobGetResult_(key);
  let view;
  if (cached.found) {
    view = cached.value;
  } else {
    const t0 = new Date().getTime();
    const book = appStoreBook_(plan);
    const call = appLegacyCall_(book, { asOfMs: t0, seed: 'view:' + plan.plan_id, actor: ctx.actor }, 'webGetBootstrap_', []);
    const boot = appSerialize_(call.value);
    delete boot.user; delete boot.bookUrl; delete boot.access;   // 計算用ブックの URL・旧来の管理者の判定は出さない
    appPlanViewDropStale_(boot, book);   // 見る人によらない直しは、覚えておく前に（覚えておいた中身はほかの人にも返す）
    appPlanViewNotes_(boot, book);
    view = { boot: boot, engine: { version: call.version, sourceSha256: call.sourceSha256, webSha256: call.webSha256 },
      builtMs: new Date().getTime() - t0 };
    // 覚えておけなくても画面は出す（次の表示がまた組み立てになるだけ）
    try { appJobPutResult_(key, view); } catch (e) { Logger.log('画面の中身を覚えておけません: ' + (e && e.message ? e.message : e)); }
    if (view.builtMs > 20000) appRunLog_({ requestId: ctx.requestId, kind: 'PLAN.VIEW', status: 'SLOW', durationMs: view.builtMs, detail: { planId: plan.plan_id } });
  }
  const shown = appPlanViewFor_(ctx, view, plan);
  // 操作した人のメールは、その計画のメーカーで予算策定担当以上の人だけ（閲覧の人には空。画面は「-」。2026-10-13）
  const seesActors = appInsightDetailFor_(ctx, plan.client_id) === 'full';
  return Object.assign({
    plan: { planId: plan.plan_id, clientName: clients[plan.client_id] || plan.client_label, fy: plan.fy, frozen: frozen, measure: appPlanIsMeasure_(plan) },
    inputHash: inputHash,
    can: {
      plan: appHasRole_(roles, 'PLANNER', plan.client_id) && !frozen,
      approve: appHasRole_(roles, 'APPROVER', plan.client_id) && !frozen,
      admin: appHasRole_(roles, 'ADMIN') && !frozen
    },
    sourceReady: !!appSettingValue_('source.zac_spreadsheet'),
    // 測る専用の計画で断る操作（予算の保存・A-4）は、止めている操作と同じに出す（PlanPurpose.js）
    actions: Object.keys(APP_PLAN_ACTIONS).map(k => ({ action: k, kind: APP_PLAN_ACTIONS[k].kind, label: APP_PLAN_ACTIONS[k].label,
      minRole: APP_PLAN_ACTIONS[k].minRole, paused: APP_PLAN_ACTIONS[k].paused || appMeasureActionRefusal_(plan, k) })),
    recent: appReadTable_('PLAN_ACTIONS').filter(r => r.plan_id === plan.plan_id).map(appStripRow_)
      .sort((a, b) => (a.finished_at < b.finished_at ? 1 : -1)).slice(0, 10)
      .map(r => ({ action: r.action, label: (APP_PLAN_ACTIONS[r.action] || {}).label || r.action, finishedAt: r.finished_at, actor: seesActors ? r.actor_email : '',
        changed: appParseJsonList_(r.changed_sheets_json) }))
  }, shown, { boot: appPlanViewBudgetDraft_(shown && shown.boot, plan) },
  { inputLog: appInputLogView_(ctx, plan) });   // 入力の記録は見る人ごと（InputLog.js。覚えておく中身には入れない）
}

/**
 * 画面の中身（boot）に、今の予算の下書き（boot.budgetDraft。版 11 の 4-1。BudgetDrafts.js の appBudgetDraftView_）を足した写し。
 * 下書きは予算の保存で変わる（予算の値が同じでも決め方だけ変わることがある）ので、覚えておく中身には入れず、開くたびに読む。読めなければ null（画面はそのまま出す）
 */
function appPlanViewBudgetDraft_(boot, plan) {
  if (!boot) return boot === undefined ? null : boot;
  let draft = null;
  try { draft = appBudgetDraftView_(plan.plan_id); } catch (e) { Logger.log('予算の下書き: ' + (e && e.message ? e.message : e)); }
  return Object.assign({}, boot, { budgetDraft: draft });
}

/**
 * 計画の画面の検証の記入（boot.eval.insights。旧来の webParseEval_ が、今の決まりで測った月の行を出す）から、予測と実績が、その月の
 * 今の版の EVAL_LOG の neutral の行を B-4 が写す形（appInsightB4View_。実績が負なら 0 円）と違う行（前の版の予測の数字のまま・
 * 実績を取り込み直して測り直す前の数字のまま）と、その計画で今の版の B-2 が初めて動く前に書いた行（前の版の B-4 の機械の列のまま）を除く
 * （学びの振り返り appInsightLessons_ と同じ決まり（appInsightRowScored_・appEvalPolicySince_）。次の B-4 が書き直すと出る。行は消さない）。
 * ただし、その月に残す行（使える行）が 1 つでもあれば、その月の人が書いた一番新しい行（appInsightHasHuman_。書いた時刻・行の順で一番新しい）は、
 * 使える行でなくても残す。数字・見立て・印は、その月の一番新しい使える行のものに置き換え、人の欄と行の番号はそのまま（画面はそこに書く）。
 * 2026-10-08 村井さん承認: v0.27.2 より前の B-4 で同じ月の行が 2 つ以上でき、人の記入が最後の行に無いと、B-4 は最後の行だけを書き直すので、
 * 記入がずっと隠れていた（画面は人が書いた行を選んで出す。学びの振り返りも同じ行の記入を出す）。
 * 行の番号（row）は旧来の画面と同じ読むだけのブック（appStoreBook_）のシートの行なので、同じブックの EVAL_INSIGHTS からそのまま引く。
 * 初めの B-2 の時刻も同じブックの EVAL_LOG・RUN_LOG から（旧来の画面と同じ読むだけのブックなので、データ本体を読み直さない）
 */
function appPlanViewDropStale_(boot, book) {
  const ins = boot && boot.eval && boot.eval.insights;
  if (!Array.isArray(ins) || !ins.length) return;
  const sh = book.getSheetByName('EVAL_INSIGHTS');
  const ev = appPlanSheetRows_(book.getSheetByName('EVAL_LOG'));
  if (!sh || !ev.length || ['target_month', 'scenario', 'pred', 'actual', 'evaluation_policy_version'].some(k => !Object.prototype.hasOwnProperty.call(ev[0], k))) return;
  const scored = {};   // 月 → 今の版の B-2 が測った予測と実績を B-4 が写す形（neutral の行。同じ月が 2 行あれば後の行）
  ev.forEach(r => {
    if (String(r.scenario || '').trim() !== 'neutral' || String(r.evaluation_policy_version || '').trim() !== APP_EVAL_POLICY_VERSION) return;
    scored[appYm_(r.target_month)] = appInsightB4View_(r.pred, r.actual);
  });
  const since = appEvalPolicySince_(ev, appPlanSheetRows_(book.getSheetByName('RUN_LOG')));
  // 1 列目 evaluated_at・3 列目 target_month・4 列目 actual_total・5 列目 pred_p50（旧来の webParseEval_ と同じ並び）。
  // 人の欄: 15 列目 cause_hypothesis・19 列目 action_type・20 列目 next_cycle_reflection・21 列目 owner・23 列目 status
  const iv = sh.getDataRange().getValues();
  const newer = (p, t, i) => !p || t > p.t || (t === p.t && i > p.i);
  const info = ins.map(x => {
    const r = iv[Number(x.row) - 1];
    if (!r) return { keep: true, x: x };
    const ym = appYm_(r[2]);
    if (!Object.prototype.hasOwnProperty.call(scored, ym)) return { keep: true, x: x };   // 今の版の行が無い月は、旧来の画面が出さない
    const human = appInsightHasHuman_({ cause_hypothesis: r[14], action_type: r[18], next_cycle_reflection: r[19], owner: r[20], status: r[22] });
    return { ym: ym, keep: appInsightRowScored_(scored, ym, r[4], r[3], r[0], since), human: human, t: appTimeKey_(r[0]), i: Number(x.row), x: x };
  });
  const latest = {};   // 月 → 一番新しい使える行
  const human = {};    // 月 → 人が書いた一番新しい行（使える行でなくても）
  info.forEach(o => {
    if (!o.ym) return;
    if (o.keep && newer(latest[o.ym], o.t, o.i)) latest[o.ym] = o;
    if (o.human && newer(human[o.ym], o.t, o.i)) human[o.ym] = o;
  });
  // 数字・見立て・印（旧来の webParseEval_ が機械の列から作る項目）は使える行から。人の欄（hypothesis・actionType・reflection・owner・status）と行の番号はそのまま
  const MACHINE = ['actual', 'pred', 'errRate', 'insight', 'nextAction', 'annualBreach', 'halfBreach', 'overBreach', 'rangeBreach', 'causeBucket'];
  boot.eval.insights = info.filter(o => o.keep || (o.ym && latest[o.ym] && human[o.ym] === o)).map(o => {
    if (o.keep || !o.ym) return o.x;
    const out = Object.assign({}, o.x);
    MACHINE.forEach(k => { if (Object.prototype.hasOwnProperty.call(latest[o.ym].x, k)) out[k] = latest[o.ym].x[k]; });
    return out;
  });
}

/** 読むだけのブックの表の形のシートを、見出し → 値の行にする（シートが無い・行が無ければ空。同じ見出しが 2 つあれば前の列） */
function appPlanSheetRows_(sh) {
  if (!sh || sh.getLastRow() < 2) return [];
  const v = sh.getDataRange().getValues();
  const head = v[0].map(h => String(h || '').trim());
  return v.slice(1).map(r => {
    const o = {};
    head.forEach((h, i) => { if (h && !Object.prototype.hasOwnProperty.call(o, h)) o[h] = r[i]; });
    return o;
  });
}

/**
 * 予測の注記（OUTPUT!A6 の写し: boot.output.policyLines・engineNote。旧来の A-9 が書く）を、今の決まりに合わせる（見る人によらない。行のほかの文はそのまま）:
 *   - 見直し案を作る操作（REVIEW.GENERATE・C-1）を止めている間は、C-1 を動かすよう案内する文を除く
 *   - 計画の CALIBRATION_STATE の note が 'owner-approved'（setCalibration が書く。Calibration.js）で始まれば、
 *     「適用中の四半期チューニング: …」の区切り（四半期と・の行。APP_PLAN_NOTE_TUNING）を、所有者が承認した値とその値に書き換える
 *     （「なし（全項目既定値）」は既定値ではないため。前の C-3 の四半期が残っていても、その四半期の値ではないため。旧来は AI の効き 0 を「既定」と書く）
 */
function appPlanViewNotes_(boot, book) {
  const o = boot && boot.output;
  if (!o) return;
  const paused = !!appPlanActionPaused_('REVIEW.GENERATE');
  const owner = appPlanOwnerCalibration_(book);
  if (!paused && !owner) return;
  const note = owner ? appPlanOwnerNote_(owner) : '';
  const fix = t => {
    let x = String(t || '');
    if (paused) x = x.replace(APP_PLAN_NOTE_C1_HINT, '');
    if (owner) x = x.replace(APP_PLAN_NOTE_TUNING, () => note);
    return x;
  };
  if (Array.isArray(o.policyLines)) o.policyLines = o.policyLines.map(fix);
  if (o.engineNote) o.engineNote = fix(o.engineNote);
}

/**
 * 計画の補正の値が所有者が承認した値なら、その値（{ bias_correction_factor, residual_month_bias_json, ai_weight_override }。旧来と同じ読み方:
 * appCalibrationNorm_）。CALIBRATION_STATE のメーカーの行（無ければ 1 つだけの行）の note が 'owner-approved' で始まらなければ null
 */
function appPlanOwnerCalibration_(book) {
  const sh = book.getSheetByName('CALIBRATION_STATE');
  if (!sh || sh.getLastRow() < 2) return null;
  const cfg = book.getSheetByName('CONFIG');
  const client = cfg ? String(cfg.getRange('B2').getValue() || '').trim() : '';
  const v = sh.getDataRange().getValues();
  const head = v[0].map(h => String(h || '').trim());
  const ci = head.indexOf('client'), ni = head.indexOf('note');
  if (ni < 0) return null;
  const rows = v.slice(1).filter(r => r.some(x => x !== '' && x !== null));
  const row = rows.filter(r => ci >= 0 && String(r[ci] || '').trim() === client)[0] || (rows.length === 1 ? rows[0] : null);
  if (!row || String(row[ni] || '').trim().indexOf('owner-approved') !== 0) return null;
  const out = {};
  ['bias_correction_factor', 'residual_month_bias_json', 'ai_weight_override'].forEach(k => { const i = head.indexOf(k); out[k] = appCalibrationNorm_(k, i < 0 ? '' : row[i]); });
  return out;
}

/** 所有者が承認した値の書き方（「適用中の補正: 所有者が承認した値（偏りの補正 1.00・月ごとの補正 なし・AI の効き 0%）」。AI の効きが空なら既定 = CONFIG の値） */
function appPlanOwnerNote_(c) {
  const mb = JSON.parse(c.residual_month_bias_json);
  const months = Object.keys(mb).map(k => k + ' 月 ' + Math.abs(mb[k] * 100).toFixed(1) + '% ' + (mb[k] < 0 ? '下げ' : '上げ')).join('、');
  const ai = c.ai_weight_override === '' ? '既定' : (c.ai_weight_override === 0 ? '0' : String(Number((c.ai_weight_override * 100).toPrecision(2)))) + '%';
  return '適用中の補正: ' + APP_PLAN_NOTE_OWNER + '（偏りの補正 ' + c.bias_correction_factor.toFixed(2) + '・月ごとの補正 ' + (months || 'なし') + '・AI の効き ' + ai + '）';
}

/**
 * 見る人に合わせた画面の中身。人ごとの当たりと外れた月の担当は、その計画のメーカーで予算策定担当以上の人だけに出す
 * （appInsightDetailFor_。メーカーに限った担当は、そのメーカーの計画だけ。2026-10-13 まではほかのメーカーの計画でも出していた）。
 * ほかの人（閲覧・情報提供）には:
 *   - 四半期レビューの提案: 信頼度の対象は種類まで（reliability:<種類>）。その根拠（その人や話題の的中率）と、効かせたときの見込み
 *     （旧来の C-1 は、その人や話題の名前を書く）と、信頼度の今と案の値は空。どちらも学びと同じ appInsightTarget_・appInsightRationale_ で決める
 *   - 検証の記入（boot.eval.insights）: 担当は空
 *   - 予測の注記（OUTPUT!A6 の写し: boot.output.policyLines・engineNote）: 信頼度の行（旧来の buildReliabilityText_）のうち、
 *     効かせている人や話題ごとの一覧（「 / 適用中=opinion:<名前>=1.10, …」）だけ除く。ON/OFF・数・SPOT上限基準とほかの行はそのまま
 *   - 操作した人（旧来の実行の記録 boot.runLog[].by・手順の進み boot.steps[].by）: 空（2026-10-13。旧来の計算は変えず、ここで空にする）
 * 入力の行・担当者の一覧は、これまでどおり出す（入力の画面に出すもの）。
 * 覚えておいた中身は見る人によらず同じものを使うので、写しを直す（覚えておいたものは変えない）
 */
function appPlanViewFor_(ctx, view, plan) {
  if (appInsightDetailFor_(ctx, plan && plan.client_id) === 'full' || !view || !view.boot) return view;
  const out = appSerialize_(view);
  const q = out.boot.quarterly;
  ((q && q.proposals) || []).forEach(p => {
    p.rationale = appInsightRationale_({ target_field: p.target, rationale: p.rationale }, true);
    p.impact = appInsightRationale_({ target_field: p.target, rationale: p.impact }, true);
    // 信頼度の今と案の値も出さない（情報源が 1 人だけの種類では、種類ごとの値でもその人の信頼度がわかる。2026-10-07）
    if (String(p.target || '').indexOf('reliability:') === 0) { p.current = ''; p.proposed = ''; }
    p.target = appInsightTarget_(p.target, true).target;
  });
  ((out.boot.eval && out.boot.eval.insights) || []).forEach(r => { r.owner = ''; });
  (out.boot.runLog || []).forEach(r => { r.by = ''; });
  (out.boot.steps || []).forEach(s => { s.by = ''; });
  // 一覧の終わりは「 / SPOT上限基準=」。見つからなければ、その行の終わりまで除く（出さない側）
  const o = out.boot.output;
  const strip = t => String(t || '').replace(/ \/ 適用中=.*?(?= \/ SPOT上限基準=|\n|$)/g, '');
  if (o && Array.isArray(o.policyLines)) o.policyLines = o.policyLines.map(strip);
  if (o && o.engineNote) o.engineNote = strip(o.engineNote);
  return out;
}

/** 表の *_json の列（文字列で持つ）を一覧に戻す。読めなければ空 */
function appParseJsonList_(v) {
  if (Array.isArray(v)) return v;
  try { const x = JSON.parse(String(v || '[]')); return Array.isArray(x) ? x : []; } catch (e) { return []; }
}

// ---- 保存・実行（裏の処理） ----

/**
 * 新アプリの側で行う保存（旧来に同じ関数が無いもの）。返り値の形は appLegacyCall_ と同じ。
 * 補正の値（appCalibrationSet_）は中で旧来の関数を使うので、その版と指紋を返す。opts: { asOfMs, seed, actor }
 */
function appPlanLocalCall_(book, name, args, opts) {
  if (name === 'appCalibrationSet_') return appCalibrationSet_(book, args[0], opts);
  const fns = { appPlanSetPeople_: appPlanSetPeople_ };
  return { value: fns[name].apply(null, [book].concat(args)), version: 'app-' + APP_VERSION, sourceSha256: '', webSha256: '' };
}

/** 担当者（カンマ区切り）を CONFIG!B4 に書く（旧来の saveInitialSetupSettings の担当者の行と同じ） */
function appPlanSetPeople_(book, peopleCsv) {
  const people = String(peopleCsv || '').split(/[,、，]/).map(s => s.trim()).filter(Boolean);
  if (!people.length) throw new Error('担当者を 1 人以上入れてください。');
  appPlanCheckArgs_(people);   // 区切りの後ろの「=…」も止める（全体の先頭だけでは見逃す）
  if (people.some(p => p.length > 40)) throw new Error('担当者の名前が長すぎます。');
  const cfg = book.getSheetByName('CONFIG');
  if (!cfg) throw new Error('CONFIG がありません。');
  const csv = people.join(',');
  cfg.getRange('B4').setValue(csv);
  return { peopleCsv: csv, people: people };
}

/** 旧来の関数の返り値のうち、記録に残す小さいもの（画面の中身そのものは除く） */
function appPlanResultSummary_(value) {
  if (!value || typeof value !== 'object') return value === undefined ? null : value;
  const out = {};
  Object.keys(value).forEach(k => { if (['boot', 'input', 'output', 'quarterly'].indexOf(k) < 0) out[k] = value[k]; });
  const text = JSON.stringify(appSerialize_(out));
  return text.length > 2000 ? { truncated: true, head: text.slice(0, 2000) } : JSON.parse(text);
}

function appPlanActionRow_(ctx, plan, actionName, x) {
  return {
    action_id: x.actionId, plan_id: plan.plan_id, action: actionName, status: 'DONE',
    engine_version: x.engine.version, engine_sha256: x.engine.sourceSha256, web_sha256: x.engine.webSha256,
    seed: x.seed, as_of: Utilities.formatDate(new Date(x.asOfMs), APP_TZ, "yyyy-MM-dd'T'HH:mm:ssZ"), input_hash: x.inputHash,
    changed_sheets_json: x.changed, result_json: x.result, started_at: x.startedAt, finished_at: appNowIso_(), actor_email: ctx.actor
  };
}

/** 1 回の保存（PLAN.EDIT）で、書き始めてよい時間の目安。これを過ぎたら何も書かずに止める（書きかけで止まらないように） */
const APP_EDIT_WRITE_DEADLINE_MS = 4 * 60 * 1000;

/** 保存: 使うシートだけを組み立てて旧来の webSave* を動かし、変わったシートを、控えを置いてからデータ本体へ戻す（1 つの処理・ロックの中） */
function appPlanEdit_(ctx, p) {
  const act = appPlanAction_(p.action, 'edit');
  const plan = appPlanOf_(p.planId);
  // hashChecked: 画面が開いたときの入力のハッシュを渡した保存（下で一致を確かめる）。行の出どころ（fromRow）は、そのときだけ使う。
  // 2026-10-13 からハッシュは必須（無ければ下で止める。始める前にも appStartJob_ が断る）なので、いつも true
  const inLog = { action: p.action, hashChecked: !!p.inputHash };
  const args = appInputLogTake_(appPlanCheckArgs_(appJobArgs_(p)), inLog);   // 自信・行の出どころ・保存の理由は入力の記録にだけ使う（旧来の表に渡さない。InputLog.js）
  // 予算の決め方・確率・割り振り（版 11 の下書きにだけ使う。旧来の webSaveBudget には rows だけを渡す）。だめな値なら何も書かずに止める
  const draftArgs = p.action === 'BUDGET.SAVE' ? appBudgetDraftArgs_(args) : null;
  const t0 = new Date().getTime();
  const actionId = appId_('ACT');
  return appWithLock_(() => {
    appJournalRecover_(ctx);   // 前の保存が途中で止まっていれば、先に書き終える
    const stored = appStoredHashes_(plan.plan_id);
    const inputHash = appPlanInputHash_(plan.plan_id);
    if (!p.inputHash) throw new Error(APP_STALE_MSG);   // 省くと後から保存した方が勝つ（画面は必ず渡す。所有者の操作は今の指紋を読んで渡す）
    if (p.inputHash !== inputHash) {
      throw new Error('画面を開いた後に、ほかの人の操作でデータが変わりました。画面を開き直して、もう一度入力してください。');
    }
    const scratch = appWorkScratch_(plan);
    const token = appId_('SCR');
    const reused = appScratchTryReuse_(scratch, plan.plan_id, act.sheets || null, token);
    const build = reused ? [] : appScratchFromStore_(scratch, plan.plan_id, act.sheets, token);
    const t1 = new Date().getTime();
    const call = act.local ? appPlanLocalCall_(scratch, act.local, act.args(args || {}), { asOfMs: t0, seed: actionId, actor: ctx.actor })
      : appLegacyCall_(scratch, { asOfMs: t0, seed: actionId, actor: ctx.actor }, act.fn, act.args(args || {}));
    const t2 = new Date().getTime();
    const cap = appCaptureChanged_(scratch, plan.plan_id, stored, act.sheets);
    const names = cap.changed.map(e => e.sheetRow.sheet);
    const result = appPlanResultSummary_(call.value);
    if (new Date().getTime() - t0 > APP_EDIT_WRITE_DEADLINE_MS) {
      throw new Error('時間がかかりすぎたので、保存をやめました（何も書いていません）。もう一度保存してください。');
    }
    const ops = appChangedOps_(ctx, plan.plan_id, cap.changed, actionId, inLog);
    if (act.local === 'appPlanSetPeople_' && names.length) {
      ops.push({ table: 'PLANS', mode: 'patch', key: { plan_id: plan.plan_id }, patch: { people_csv: call.value.peopleCsv }, actor: ctx.actor });
    }
    ops.push.apply(ops, appLearnEditOps_(ctx, plan, p.action, actionId, call.value, scratch, args));   // 学びの記録（補正の書き込み・四半期の判断。版 10 の 3-5。LearnLog.js）
    // 予算の下書き 12 行（版 11 の 4-1。保存した後の 12 か月の値。予測し直しても戻す。BudgetDrafts.js）
    const draft = draftArgs ? appBudgetDraftOps_(ctx, plan, actionId, scratch, draftArgs) : null;
    if (draft) ops.push.apply(ops, draft.ops);
    ops.push({ table: 'PLAN_ACTIONS', mode: 'ensure', rows: [appPlanActionRow_(ctx, plan, p.action, { actionId: actionId, engine: call, seed: actionId, asOfMs: t0,
      inputHash: inputHash, changed: names, result: result, startedAt: Utilities.formatDate(new Date(t0), APP_TZ, "yyyy-MM-dd'T'HH:mm:ssZ") })] });
    const written = appJournalRun_(ctx, act.label + '（' + actionId + '）', plan.plan_id, ops);
    appScratchMarkAfterSave_(scratch, plan.plan_id, token, act.sheets || null, !!reused, reused && reused.scope,
      build.filter(x => x.mismatch || x.forcedText || x.formatMismatches).map(x => x.sheet));
    // 入力の記録に足した行の数（自信だけ変えた保存は、表が変わらなくても CONF を足す。画面はそれも「保存しました」と知らせる）
    const inputLogRows = [].concat(written.INPUT_LOG || []).reduce((n, x) => n + (Number(x && x.appended) || 0), 0);
    return { actionId: actionId, planId: plan.plan_id, action: p.action, changed: names, inputLogRows: inputLogRows, written: written, result: result,
      draft: draft ? draft.draft : null,
      build: build.filter(x => x.mismatch || x.forcedText || x.formatMismatches).map(x => x.sheet),
      timing: { buildMs: t1 - t0, runMs: t2 - t1, saveMs: new Date().getTime() - t2 },
      audit: { entityId: plan.plan_id, clientId: plan.client_id } };
  });
}

/**
 * 実行（組み立て・PLAN.RUN）: データ本体から計算用ブックを組み立てる（sheets を決めた操作はそのシートだけ）。
 * 1 回の上限に収まらなければ同じ処理を続けて動かし、組み立て終えたら計算（PLAN.RUN_CALC）へ
 */
function appPlanRunBuild_(ctx, p) {
  const act = appPlanAction_(p.action, 'run');
  const plan = appPlanOf_(p.planId);
  const jobStart = new Date().getTime();
  return appWithLock_(() => {
    if (!p.build) appJournalRecover_(ctx);
    const inputHash = appPlanInputHash_(plan.plan_id);
    if (p.build && inputHash !== p.inputHash) throw new Error('組み立てている間にデータ本体が変わりました。もう一度実行してください。');
    // A-4 の最初の段: 同じ計画の A-4 が 6 時間以内に失敗・途中で止まっていれば、その回（番号と時刻）を引き継いで控えた答えを使う（Ai.js）
    const run = act.ai && !p.actionId ? appAiRunStart_(plan.plan_id, jobStart) : null;
    const actionId = p.actionId || (run ? run.actionId : appId_('ACT'));
    const asOfMs = p.asOfMs || (run ? run.asOfMs : jobStart);
    const step = appScratchBuildStep_(appWorkScratch_(plan), plan.plan_id, act.sheets || null, p.build || null, appBuildDeadline_(jobStart));
    const payload = { planId: plan.plan_id, action: p.action, actionId: actionId, seed: actionId, asOfMs: asOfMs, inputHash: inputHash,
      startedAt: Utilities.formatDate(new Date(asOfMs), APP_TZ, "yyyy-MM-dd'T'HH:mm:ssZ"), build: step.state,
      buildMs: Number(p.buildMs || 0) + (new Date().getTime() - jobStart), aiAttempt: Number(p.aiAttempt || 0) };
    const fresh = Number(p.aiFreshAfter || 0) || (run ? run.freshAfterMs : 0);
    if (fresh) payload.aiFreshAfter = fresh;   // 引き継いだ回: これより前に控えた失敗の答えは使わない（appAiFetcher_）
    return { __next: { kind: step.complete ? 'PLAN.RUN_CALC' : 'PLAN.RUN', payload: payload }, audit: { entityId: plan.plan_id, clientId: plan.client_id } };
  });
}

/** 実行（計算・PLAN.RUN_CALC）: 組み立てた計算用ブックで旧来の webRun* を動かす（データ本体には書かない） */
function appPlanRunCalc_(ctx, p) {
  const act = appPlanAction_(p.action, 'run');
  const plan = appPlanOf_(p.planId);
  const t0 = new Date().getTime();
  return appWithLock_(() => {
    if (!p.build || !appScratchOwnedBy_(p.build.token)) throw new Error('計算用ブックがほかの処理で使われました。もう一度実行してください。');
    if (appPlanInputHash_(plan.plan_id) !== p.inputHash) throw new Error('計算している間にデータ本体が変わりました。もう一度実行してください。');
    const fetcher = act.ai ? appAiFetcher_(p.actionId, appAiDeadline_(t0), p.aiFreshAfter) : null;
    const scratch = appWorkScratch_(plan);
    // 旧来の計算が書く列まで、計算用ブックのシートを広げる（B-2 の検証の表。広げた大きさは保存でデータ本体に残る）
    if (act.widen) appEnsureMinColumns_(scratch, act.widen);
    let call;
    try {
      call = appLegacyCall_(scratch, { asOfMs: p.asOfMs, seed: p.seed, actor: ctx.actor, fetch: fetcher && fetcher.fetch }, act.fn, []);
    } catch (e) {
      if (!fetcher || !fetcher.stopped()) {
        const f = fetcher ? fetcher.failures() : [];
        if (f.length) throw new Error(String(e && e.message ? e.message : e) + '\n問い合わせの失敗（' + f.length + ' 件）:\n' + f.slice(0, 6).join('\n'));
        throw e;
      }
    }
    if (fetcher && fetcher.stopped()) {
      // 時間の区切りで止めた: 計算用ブックは途中のまま。組み立て直して、受け取った答えを使ってもう一度動かす
      const attempt = Number(p.aiAttempt || 0) + 1;
      if (attempt >= APP_AI_MAX_ATTEMPTS) throw new Error('AI 調査が ' + attempt + ' 回に分けても終わりませんでした。時間をおいてもう一度実行してください。');
      return { __next: { kind: 'PLAN.RUN', payload: Object.assign({ planId: plan.plan_id, action: p.action, actionId: p.actionId, asOfMs: p.asOfMs,
        buildMs: p.buildMs, aiAttempt: attempt, aiCalls: fetcher.stats() }, p.aiFreshAfter ? { aiFreshAfter: p.aiFreshAfter } : {}) },
        audit: { entityId: plan.plan_id, clientId: plan.client_id } };
    }
    // A-4: 数式が残った・一時的な失敗で話題が欠けたときは、保存せずに止める（前の結果を残す。Ai.js）
    if (fetcher) appAiCheckBeforeSave_(scratch, fetcher);
    const payload = Object.assign({}, p, { engine: { version: call.version, sourceSha256: call.sourceSha256, webSha256: call.webSha256 },
      result: appPlanResultSummary_(call.value), runMs: new Date().getTime() - t0 }, fetcher ? { aiCalls: fetcher.stats() } : {});
    return { __next: { kind: 'PLAN.RUN_SAVE', payload: payload }, audit: { entityId: plan.plan_id, clientId: plan.client_id } };
  });
}

/** 実行（保存・PLAN.RUN_SAVE）: 書き換わったシートを控えの形にし、計算の間にデータ本体が変わっていないことを確かめてから書く。job = この処理（自動の A-4 か見分ける） */
function appPlanRunSave_(ctx, p, job) {
  const act = appPlanAction_(p.action, 'run');
  const plan = appPlanOf_(p.planId);
  const t0 = new Date().getTime();
  return appWithLock_(() => {
    appJournalRecover_(ctx);   // 書きかけの控えを先に書き終える（途中の表から控えを作らない）
    if (!p.build || !appScratchOwnedBy_(p.build.token)) throw new Error('計算用ブックがほかの処理で使われました。もう一度実行してください。');
    if (appPlanInputHash_(plan.plan_id) !== p.inputHash) throw new Error('計算している間にデータ本体が変わりました。もう一度実行してください。');
    const cap = appCaptureChanged_(appWorkScratch_(plan), plan.plan_id, appStoredHashes_(plan.plan_id), act.sheets);
    const t1 = new Date().getTime();
    const names = cap.changed.map(e => e.sheetRow.sheet);
    const ops = appChangedOps_(ctx, plan.plan_id, cap.changed, p.actionId, { action: p.action });
    if (p.action === 'EVAL.REPORT') ops.push.apply(ops, appHitEvalOps_(ctx, plan, appWorkScratch_(plan)));   // 当たりの記録（締まった四半期。版 10 の 3-4。HitRecords.js）
    ops.push.apply(ops, appLearnRunOps_(ctx, plan, p.action, () => appWorkScratch_(plan)));   // 学びの記録（C-1 の案・C-3 の判断と反映。版 10 の 3-5。LearnLog.js）
    ops.push({ table: 'PLAN_ACTIONS', mode: 'ensure', rows: [appPlanActionRow_(ctx, plan, p.action, Object.assign({}, p, { changed: names }))] });
    appAiResearchLogOps_(ctx, plan, p, cap.changed, job).forEach(op => ops.push(op));   // A-4 の回ごとの記録（AI_RESEARCH_LOG。3-2。AiResearchLog.js）
    const written = appJournalRun_(ctx, act.label + '（' + p.actionId + '）', plan.plan_id, ops);
    appScratchMarkAfterSave_(appWorkScratch_(plan), plan.plan_id, p.build.token, act.sheets || null, !!p.build.reused, p.build.scope, p.build.problems);
    return { actionId: p.actionId, planId: plan.plan_id, action: p.action, changed: names, written: written, result: p.result,
      unknown: cap.unknown, build: (p.build && p.build.problems) || [],
      timing: { buildMs: p.buildMs || 0, runMs: p.runMs || 0, captureMs: t1 - t0, saveMs: new Date().getTime() - t1 },
      audit: { entityId: p.actionId, clientId: plan.client_id } };
  });
}

/**
 * 画面から渡された保存の中身を確かめる。Sheets は「=」（と、「+」「-」の後が式として読めるもの）で始まる文字を数式として動かすので、
 * 計算用ブックで所有者の権限のまま外部を読む数式（IMPORTXML など）が動かないよう、受け付けない。
 * 「+」「-」で始まる文は、すぐ後が英字・括弧・@・記号（+ - " ' {）のもの（「--IMPORTXML(…)」「+"a"&…」「+{…}」も）と、
 * どこかに関数の呼び出し（英字のすぐ後の「(」。「+1+IMPORTXML(…)」）があるものを止める。数・増減率・「- 前年の反動（=見込み）」のような文は通す
 */
function appPlanCheckArgs_(args) {
  const bad = v => typeof v === 'string' && (/^\s*=/.test(v)
    || (/^\s*[+\-]/.test(v) && (/^\s*[+\-]\s*[A-Za-z_$(@+\-"'{]/.test(v) || /[A-Za-z_][A-Za-z0-9_.]*\s*\(/.test(v))));
  const walk = v => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') { Object.keys(v).forEach(k => walk(v[k])); return; }
    if (bad(v)) throw new Error('数式として動いてしまう文字は入力できません（' + String(v).slice(0, 20) + '）。先頭の「=」「+」「-」を消すか、前に別の文字を入れてください。');
  };
  walk(args);
  return args;
}
