/**
 * Api.js — 画面から呼ぶ入口。公開する関数はこのファイルの doGet・api*・trigger* だけ。
 * どれも api_ を通し、本人確認 → 役割の判定 → （書き込みなら）記録つきで実行 → エラーの記録 を必ず行う。
 * 新しい入口を足したら app/tests/app-contract.test.mjs の一覧にも足す（足さないとテストが止める）。
 * 管理の操作（メンバー・役割・メーカー・設定・記録と状態・バックアップ・手入れ・事前分布・計画の候補・年度の確認）は、画面から呼ばないので
 * 入口を置かない（2026-10-13。所有者でない管理者もブラウザから呼べたため）。所有者が apiOwnerTask で、同じ中の関数・同じ操作の名前で動かす（OwnerTask.js）。
 */
function doGet(e) {
  const t = HtmlService.createTemplateFromFile('UI');
  t.charsJs = APP_UI_CHARS_JS;
  // 所有者が開いたときは、毎日のバックアップ（Backup.js）と自動の AI 調査（AutoResearch.js）のトリガーを確かめる（どちらも 1 日 1 回だけ。バックアップを先に）
  t.bootJson = JSON.stringify(api_('APP.OPEN', { minRole: 'VIEWER', audit: false, allowAnonymousView: true }, ctx => { appBackupOnOpen_(ctx); appAutoResearchOnOpen_(ctx); return appBootstrap_(ctx); }))
    .replace(/</g, '\\u003c');
  const out = t.evaluate().setTitle(APP_NAME).addMetaTag('viewport', 'width=device-width, initial-scale=1');
  try { out.setFaviconUrl(APP_FAVICON_URL); } catch (err) { Logger.log('favicon: ' + (err && err.message ? err.message : err)); }
  return out;
}

function apiSetup() {
  return api_('SETUP.INIT', { ownerOnly: true, audit: false }, ctx => appSetup_(ctx));
}

/**
 * 所有者が Apps Script のエディタから 1 回だけ実行する: A-4 AI 調査の許可（外への問い合わせ・Google Cloud）を出す。
 * 裏の処理は所有者の許可で動くので、許可が無いと Vertex AI に問い合わせられない。データは何も変えない（問い合わせもしない）
 */
function apiAuthorizeAi() {
  return api_('SETUP.AUTHORIZE_AI', { ownerOnly: true, audit: false }, ctx => appAuthorizeAi_(ctx));
}

/**
 * 所有者が Apps Script のエディタから管理の操作をする（管理の画面は画面から外す。2026-10-06 村井さん決定）。
 * エディタからは引数を渡せないので、頼む中身はスクリプト プロパティ OWNER_TASK に JSON で置く。結果は OWNER_TASK_RESULT と実行ログ（OwnerTask.js）。
 * 操作ごとに、その操作の役割の判定・操作の名前（MEMBER.SAVE など。前に画面の入口があったものは同じ名前）で監査に残すので、
 * この入口そのものは記録しない（断ったことは記録する）
 */
function apiOwnerTask() {
  return api_('OWNER.TASK', { ownerOnly: true, audit: false }, ctx => appOwnerTask_(ctx));
}

/** 計画の一覧（取り込み・計算の一致の確認の対象） */
function apiListPlans() {
  return api_('PLANS.LIST', { minRole: 'VIEWER', audit: false }, () => appCachedRead_('PLANS', () => ({ plans: appListPlans_() })));
}

/** 全部の計画の要点（閲覧は社内全員） */
function apiPortfolio() {
  return api_('PORTFOLIO.LIST', { minRole: 'VIEWER', audit: false }, () => ({ plans: appPortfolioCached_() }));
}

/**
 * 予測の根拠（月ごとの内訳・入力と AI の押し・補正・AI 調査の根拠・前回からの変化）。閲覧は社内全員。
 * 押したものの人や話題ごとの内訳（名前と信頼度）は、その計画のメーカーで予算策定担当以上の人だけ（ほかの人には情報源の種類ごと。appBasisFor_）
 */
function apiForecastBasis(input) {
  return api_('FORECAST.BASIS', { minRole: 'VIEWER', audit: false }, ctx => appForecastBasis_(ctx, input && input.planId));
}

/** 精度の推移と学習の影（月の誤差・偏り・P10〜P90 に入った割合・全計画で縮めた偏りの補正）。閲覧は社内全員 */
function apiLearningView(input) {
  return api_('LEARNING.VIEW', { minRole: 'VIEWER', audit: false }, () => appLearningView_(input && input.planId));
}

/** 分析: 年度のメーカーを横に並べる（予測と予算・予測の改訂・精度・AI の話題と市場のまとめ）。閲覧は社内全員。読むだけ。中身は「今日」でも変わる（既定の年度）ので、控えの鍵に日付も入れる */
function apiCrossMaker(input) {
  return api_('INSIGHT.CROSS', { minRole: 'VIEWER', audit: false }, () => appCachedRead_('CROSS\u0001' + String(input && input.fy || '') + '\u0001' + appToday_(), () => appCrossMaker_(input && input.fy)));
}

/**
 * 学び: 人の学び（外れた月の振り返り・人と話題ごとの当たり・四半期レビューの判断・予算の上乗せの実績）。閲覧は社内全員。読むだけ。
 * 人ごとの当たりと判断した人の名前は予算策定担当以上だけ（メーカーに限った担当は、そのメーカーの計画の分だけ。ほかの人・ほかの計画は情報源の種類ごとのまとめ）。
 * 見せ方が違う人に同じ控えを返さないよう、控えの鍵に見せ方（appInsightDetail_。メーカーに限った担当はメーカーの組み合わせ）も入れる。
 * hits は当たりの記録の人ごとの当たり（版 10 の 3-4。本人の分は人ごとに違うので、控えの外で見る人に合わせて絞る。HitRecords.js）
 */
function apiPeopleLearning() {
  return api_('INSIGHT.PEOPLE', { minRole: 'VIEWER', audit: false }, ctx => Object.assign(
    appCachedRead_('PEOPLE\u0001' + appInsightDetail_(ctx) + '\u0001' + appToday_(), () => appPeopleLearning_(ctx)), { hits: appHitPeopleView_(ctx) }));
}

/**
 * 学び: AI の学び（信頼度の学び・全計画で縮めた偏り・精度の推移・補正の変化・承認待ちの提案・気になる点）。閲覧は社内全員。読むだけ。
 * 承認待ちの提案と補正の変化の、人や話題の名前と信頼度の提案の根拠は予算策定担当以上だけ（メーカーに限った担当は、そのメーカーの計画の分だけ）。人の学びと同じく、控えの鍵に見せ方も入れる。
 * landing は着地見込みの τ・w（全計画から学んだ試しの値と、承認して使っている値。appLandingPriorView_。計画の一覧の控えから）。
 * research は AI 調査 1 回ごとの当たり（版 10 の 3-4。当たりの記録の見せ方で絞る。HitRecords.js）
 */
function apiAiLearning() {
  return api_('INSIGHT.AI', { minRole: 'VIEWER', audit: false }, ctx => Object.assign(
    appCachedRead_('AILEARN\u0001' + appInsightDetail_(ctx) + '\u0001' + appToday_(), () => appAiLearning_(ctx)), { landing: appLandingPriorView_(),
      research: appHitResearchView_(ctx) }));
}

/**
 * 確率で選ぶ予算の案（版 11。決定 25・27。読むだけ）。input: { planId, prob（50・60・70・80）, alloc（省けば PAST_SHAPE 過去の平均の形・FORECAST_SHAPE） }。
 * 返り値 { prob, annual, months: [{ ym, adopted, closed }], alloc, basisText, ok, mode, … }（BudgetDrafts.js の appBudgetProposal_）。
 * 画面はこの月の値を、ふつうの予算の保存（BUDGET.SAVE）で basis: 'PROB'・prob・alloc を添えて保存する。閲覧は社内全員（着地見込みと予算に届く見込みと同じ）。
 * 中身は「今日」でも変わる（着地見込み）ので、控えの鍵に日付も入れる
 */
function apiBudgetProposal(input) {
  return api_('BUDGET.PROPOSAL', { minRole: 'VIEWER', audit: false }, () => appCachedRead_('BPROP\u0001' + String(input && input.planId || '') + '\u0001' +
    String(input && input.prob) + '\u0001' + String(input && input.alloc || '') + '\u0001' + appToday_(), () => appBudgetProposal_(input)));
}

/** 計画の公式版の一覧と、今の数字 */
function apiVersionList(input) {
  return api_('VERSION.LIST', { minRole: 'VIEWER', audit: false }, ctx => appCachedRead_('VERSIONS\u0001' + ctx.actor + '\u0001' + (input && input.planId), () => appVersionList_(ctx, input)));
}

/** 今の予測と予算を、公式版として出す（予算策定担当。その計画のクライアントの担当でもよい） */
function apiVersionSubmit(input) {
  return api_('VERSION.SUBMIT', { minRole: 'PLANNER', clientId: appJobPlanClient_({ planId: input && input.planId }), entityType: 'PLAN_VERSION',
    detail: { planId: input && input.planId, note: input && input.note }, after: res => ({ versionNo: res.version.no, budgetFinal: res.version.budget.final,
      p50: res.version.annual.p50, withdrawn: res.withdrawn }) }, ctx => appVersionSubmit_(ctx, input));
}

/** 承認待ちの版を承認・却下する（承認者） */
function apiVersionDecide(input) {
  return api_('VERSION.DECIDE', { minRole: 'APPROVER', clientId: appVersionClient_(input), entityType: 'PLAN_VERSION',
    detail: { versionId: input && input.versionId, decision: input && input.decision, note: input && input.note },
    after: res => ({ versionNo: res.version.no, state: res.version.state, superseded: res.superseded, selfApproved: res.selfApproved }) }, ctx => appVersionDecide_(ctx, input));
}

/** ホーム（最重要のことだけ。よみのセリフの材料）。閲覧は社内全員。input.fy で見る年度を選ぶ（今の年度の前後 2 年まで。無ければ既定の年度） */
function apiHome(input) {
  return api_('HOME', { minRole: 'VIEWER', audit: false }, ctx => appHome_(ctx, input && input.fy));
}

/**
 * 計画の最新の予測（閲覧は社内全員）。shadow は年度の見込みの試しと予算に届く見込み（appPlanShadow_。計画の一覧の控えから。
 * 今日の日付でも変わるので、予測の控えとは別に足す。読めなければ null）
 */
function apiForecastLatest(input) {
  return api_('FORECAST.LATEST', { minRole: 'VIEWER', audit: false }, ctx => appForecastLatestFor_(ctx, Object.assign(
    appCachedRead_('LATEST\u0001' + (input && input.planId), () => appForecastLatest_(input && input.planId)), { shadow: appPlanShadow_(input && input.planId) })));
}

/**
 * 計画の画面（入力・予測と予算・検証・四半期レビュー・進み。閲覧は社内全員）。中身は「今日」でも変わる（既定の年度など）ので、控えの鍵に日付も入れる。
 * 人ごとの当たりと外れた月の担当は、その計画のメーカーで予算策定担当以上の人だけ（appPlanViewFor_）。控えの鍵は見る人ごと
 */
function apiPlanView(input) {
  return api_('PLAN.VIEW', { minRole: 'VIEWER', audit: false }, ctx => appCachedRead_('VIEW\u0001' + ctx.actor + '\u0001' + (input && input.planId) + '\u0001' + appToday_(), () => appPlanView_(ctx, input && input.planId)));
}

/** 時間のかかる処理を始める（裏で動かす。種類ごとに権限が違う） */
function apiStartJob(input) {
  return api_('JOB.START', appJobStartOpts_(input), ctx => appStartJobNow_(ctx, input));
}

/** 処理の状態（終わっていれば結果）。頼んだ人と所有者だけ */
function apiJobStatus(input) {
  return api_('JOB.STATUS', { minRole: 'VIEWER', audit: false }, ctx => appJobStatus_(ctx, input && input.jobId));
}

/** 処理を裏で動かす（apiStartJob が作った 1 回だけのトリガーから。待ち行列の処理のトリガーの UID のときだけ。appTriggerUser_） */
function triggerRunJob(e) {
  return api_('JOB.RUN', { minRole: 'ADMIN', audit: false, trigger: { event: e, handler: 'triggerRunJob', alsoAccept: appIsJobTrigger_ } },
    ctx => appRunJobs_(ctx, e));
}

/**
 * 毎日のバックアップ（時間主導のトリガーから）。トリガーは所有者として動く。
 * イベントの triggerUid がこのプロジェクトのバックアップ用トリガーと一致するときだけ受け付け、所有者として扱う（appTriggerUser_。
 * 2026-10-13 から、役割が管理者でも UID の合わない呼び出しは断る。前は管理者がブラウザから呼ぶと、そのたびに管理者への知らせのメールを送れた）。
 */
function triggerDailyBackup(e) {
  return api_('BACKUP.DAILY', { minRole: 'ADMIN', entityType: 'SYSTEM', trigger: { event: e, handler: 'triggerDailyBackup' },
    after: res => res }, ctx => appDailyMaintenance_(ctx));
}

/**
 * 市場の動き（A-4 AI 調査）を、計画ごとに週 1 回ずつ自動で集める（毎日 4 時半ごろ、毎日の手入れの後の時間主導のトリガーから。AutoResearch.js）。
 * 本人確認は triggerDailyBackup と同じ（このプロジェクトの、この入口のトリガーの UID のときだけ受け付け、所有者として扱う。
 * 2026-10-13 から、管理者がブラウザから呼んでも断る。前は 4〜7 時なら費用のかかる AI 調査を始められた）。
 * 始める A-4 は画面から始めるのと同じ処理（頼んだ人の役割と年度の締めは、裏の処理が段ごとに確かめ直す）
 */
function triggerAutoResearch(e) {
  return api_('AUTO.RESEARCH', { minRole: 'ADMIN', entityType: 'SYSTEM', trigger: { event: e, handler: 'triggerAutoResearch' },
    after: res => res }, ctx => appAutoResearchTick_(ctx));
}

/**
 * すべての入口の共通処理。opts:
 *   minRole / clientId … 必要な役割（clientId を渡すとクライアント単位の役割も数える）
 *   ownerOnly          … 所有者だけ（初期設定）
 *   audit              … false なら記録しない（読むだけの入口）。既定は記録する
 *   allowAnonymousView … 役割が足りないときも画面の初期データだけは返す（「権限がありません」を画面で出すため）
 *   trigger            … { event, handler, alsoAccept }。トリガーからの実行だけを受け付ける入口（appTriggerUser_。合わなければ役割があっても断る）
 *   entityType / entityId / detail / reason / before() / after(res) … 監査の項目
 */
function api_(action, opts, fn) {
  opts = opts || {};
  APP_STORE_CACHE_ = {};
  let user = appCurrentUser_();
  let fromTrigger = true;
  if (opts.trigger) {
    const t = appTriggerUser_(user, opts.trigger);
    user = t.user;
    fromTrigger = t.ok;
  }
  const roles = appRolesOf_(user);
  const ctx = { user: user, roles: roles, actor: user.email || '(unknown)', requestId: Utilities.getUuid() };
  if (roles.length) appAutoEnsureTables_(ctx);   // 社内の人の最初の操作で、版を上げて足した表を作る
  const allowed = fromTrigger && (opts.ownerOnly ? user.isOwner : appHasRole_(roles, opts.minRole || 'ADMIN', opts.clientId));
  try {
    if (!allowed) {
      if (opts.allowAnonymousView) return appSerialize_(appDeniedBootstrap_(ctx));
      if (appIsSetUp_()) {
        try {
          appAuditAppend_({ actor: ctx.actor, actorRoles: appRoleSummary_(roles), action: action, phase: 'DENIED', result: 'DENIED',
            entityType: opts.entityType, entityId: opts.entityId, clientId: opts.clientId, detail: opts.detail, requestId: ctx.requestId });
        } catch (e) { Logger.log('api_ DENIED の記録に失敗: ' + (e && e.message ? e.message : e)); }
      }
      throw new Error('この操作をする権限がありません。');
    }
    if (opts.audit === false) return appSerialize_(fn(ctx));
    if (!appIsSetUp_()) throw new Error('初期設定がまだです。所有者が「初期設定」を実行してください。');
    return appSerialize_(appAudited_(ctx, action, opts, () => fn(ctx)));
  } catch (err) {
    appLogError_(action, err, ctx);
    throw new Error(String(err && err.message ? err.message : err));
  }
}

/**
 * trigger* の本人確認。イベントの triggerUid が、このプロジェクトのその入口のトリガー（appIsOwnTrigger_）か、alsoAccept が受け付ける UID
 * （triggerRunJob は待ち行列の処理のトリガー: appIsJobTrigger_。トリガーの一覧から先に消えていても確かめられる）のときだけ受け付ける。
 * 受け付けたら所有者として動かす（トリガーは所有者が作り、所有者として動く。中では操作者のメールが空のこともある）。
 * メールがあって所有者でない人は、UID が合っても断る（ブラウザから呼んだ管理者など。トリガーの中のメールは空か所有者）。
 * 返り値 { ok: 受け付けたか, user: 受け付けたら所有者・断ったら呼んだ人のまま（断ったことの記録に残す） }
 */
function appTriggerUser_(user, trigger) {
  const e = trigger && trigger.event;
  const uid = e && e.triggerUid ? String(e.triggerUid) : '';
  const known = !!uid && (appIsOwnTrigger_(e, trigger.handler) || (!!trigger.alsoAccept && appIsSetUp_() && !!trigger.alsoAccept(uid)));
  if (!known || !user.owner || (user.email && !user.isOwner)) return { ok: false, user: user };
  return { ok: true, user: Object.assign({}, user, { email: user.owner, isOwner: true }) };
}

/** e.triggerUid が、このプロジェクトの handler 用のトリガーのものか */
function appIsOwnTrigger_(e, handler) {
  const uid = e && e.triggerUid ? String(e.triggerUid) : '';
  if (!uid) return false;
  try {
    return ScriptApp.getProjectTriggers().some(t => t.getUniqueId() === uid && t.getHandlerFunction() === handler);
  } catch (err) {
    return false;
  }
}

/** google.script.run で返せる形にする（Date などを文字列にする） */
function appSerialize_(v) {
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

function appBootstrap_(ctx) {
  const isAdmin = appHasRole_(ctx.roles, 'ADMIN');
  return {
    app: { name: APP_NAME, nameJa: APP_NAME_JA, version: APP_VERSION },
    user: { email: ctx.user.email, isOwner: ctx.user.isOwner, isAdmin: isAdmin,
      roles: ctx.roles.map(r => ({ role: r.role, label: APP_ROLE_LABELS[r.role], scopeType: r.scope_type, clientId: r.client_id })) },
    setUp: appIsSetUp_(),
    allowed: true,
    activeJob: (() => { try { return ctx.user.email && appIsSetUp_() ? appActiveJobOf_(ctx.user.email) : null; } catch (e) { return null; } })(),
    // ホームの中身も最初に渡す（開いてすぐ出せる。通信を 1 回減らす）。読めなければ画面が読み直す
    home: (() => { try { return appIsSetUp_() && appHasRole_(ctx.roles, 'VIEWER') ? appHome_(ctx) : null; } catch (e) { Logger.log('ホームの中身: ' + (e && e.message ? e.message : e)); return null; } })()
  };
}

function appDeniedBootstrap_(ctx) {
  return { app: { name: APP_NAME, nameJa: APP_NAME_JA, version: APP_VERSION }, user: { email: ctx.user.email, isOwner: false, isAdmin: false, roles: [] },
    setUp: appIsSetUp_(), allowed: false };
}
