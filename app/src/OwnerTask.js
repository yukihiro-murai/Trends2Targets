/**
 * OwnerTask.js — 所有者が Apps Script のエディタから管理の操作をする（apiOwnerTask の中身）。
 * 2026-10-06: 画面から管理の画面（設定・メンバーと役割・表示名・記録と状態・年度の締め・計画の作成）を外す（村井さん決定）。
 * エディタから実行する関数は引数を取れないので、頼む中身はスクリプト プロパティ OWNER_TASK に JSON で置く:
 *   {"action":"saveSetting","key":"source.zac_spreadsheet","value":"https://docs.google.com/spreadsheets/d/…/edit"}
 * 結果は OWNER_TASK_RESULT（1 つの値は約 9KB までなので、大きいときは要約）と実行ログ（Logger。長すぎれば途中まで）に残す。
 * うまくいった後の OWNER_TASK: 読むだけの操作は残す（もう一度実行すると読み直す）。書く操作は消す（同じ頼みを 2 度動かさない）。
 * 裏の処理を始めたら {"action":"jobStatus","jobId":"…"} に置き換える（プロパティを触らずに、もう一度実行すると結果を確かめられる）。
 * 実行中に書き換えられた頼みは触らない。失敗したら残す（直してもう一度実行する）。
 *
 * どの操作も、前に画面の入口（Api.js）があったときと同じ中の関数・同じ役割の判定・同じ監査の項目で動かす（2026-10-13 に入口を外し、ここだけにした）。
 * 書く操作は、前の入口と同じ操作の名前（SETTING.SAVE など）で監査に開始と終了が残る（理由の欄に OWNER_TASK と残す）。
 * 時間のかかる処理（計画の作成・担当者の保存・年度の締め・事前分布の書き込み・補正の値の書き込み）は、画面と同じく裏の処理として始め、
 * 記録はその処理が残す。結果は jobStatus で見る。年度の締めは、画面と同じく yearPreview の指紋（inputHash）が要る。
 * 補正の値（setCalibration）は、所有者が承認した値を計画の旧来の CALIBRATION_STATE に書く（2026-10-07 村井さん決定。Calibration.js）。
 * AI 調査の問い合わせ先（setVertexConfig）は、全計画の CONFIG の Vertex の行をまとめて書き換える（2026-10-13 村井さん承認。Ai.js。計画ごとにロックと保存の控え）。
 * 今ある行・計画を書き換える操作は、楽観ロックの印（行の版 rowVersion・計画の指紋 inputHash）が要る（2026-10-13 から中の関数で必須）。
 * エディタからは所有者が 1 人で動かすので、頼みに無ければ実行したときの今の値を読んで渡す（current。頼みに入れたときは、その値で確かめる）。
 */
// 頼みと結果は Script Properties に置く（所有者がエディタで書いて読む。APP_ で始まらないキー）。アプリの状態は所有者の UserProperties（Store.js の appProps_）
const APP_OWNER_TASK_PROP = 'OWNER_TASK';
const APP_OWNER_RESULT_PROP = 'OWNER_TASK_RESULT';
const APP_OWNER_RESULT_MAX_BYTES = 8000;   // Script Properties の 1 つの値の上限は約 9KB（バイト数）
const APP_OWNER_LOG_CHUNK = 4000;   // 実行ログ 1 回に出す文字数（長い結果は分けて出す）
const APP_OWNER_LOG_MAX_CHUNKS = 60;
const APP_OWNER_REASON = 'OWNER_TASK（エディタから）';
const APP_OWNER_SUMMARY_NOTE = '要約です。全部は実行ログにあります。';
const APP_OWNER_CUT_NOTE = '要約です。長すぎて、実行ログにも途中までしか出せませんでした。listAudit なら limit を小さくするか、month・query で絞ってもう一度実行してください。';
const APP_OWNER_AUDIT_LIMIT = 200;   // listAudit の既定の行数（limit が無いとき。全部を実行ログに出せる大きさにする）
const APP_OWNER_BACKUP_STALE_HOURS = 26;   // 状態の要約: 最新のバックアップがこれより古ければ要確認（画面の「記録と状態」と同じ）

/**
 * 操作の一覧。name・opts・run は操作の名前・権限と監査の項目・中の関数（前に Api.js に入口があった操作は、その入口と同じ）。
 * job は裏の処理の種類（apiStartJob と同じ判定で始める）。args は使える項目（ほかの項目は打ち間違いとして断る）。
 * check は動かす前の確かめ（足りない・形の違う項目なら、何もせずに止める）。current は頼みに無ければ足す今の値（行の版・計画の指紋。appOwnerFillCurrent_）。
 * brief は OWNER_TASK_RESULT に置く短い形（always なら常に。そうでなければ大きいときだけ）。全部は実行ログに出す
 */
const APP_OWNER_ACTIONS = {
  // ---- メンバー・役割・メーカーの表示名（Directory.js） ----
  listDirectory: { name: 'DIRECTORY.LIST', opts: () => ({ minRole: 'ADMIN', audit: false }),
    run: ctx => appCachedRead_('DIRECTORY', () => appListDirectory_(ctx)), brief: r => appOwnerDirectoryBrief_(r), always: true },
  saveMember: { name: 'MEMBER.SAVE', args: ['email', 'displayName', 'department', 'note', 'isActive', 'rowVersion'],
    current: i => ({ rowVersion: appOwnerRowVersion_('MEMBERS', r => r.email === appNormalizeEmail_(i.email)) }),
    opts: i => ({ minRole: 'ADMIN', entityType: 'MEMBER', entityId: i.email, detail: i, after: res => res.member }),
    run: (ctx, i) => appSaveMember_(ctx, i) },
  grantRole: { name: 'ROLE.GRANT', args: ['email', 'role', 'scopeType', 'clientId', 'validFrom', 'validTo', 'note'],
    opts: i => ({ minRole: 'ADMIN', entityType: 'ROLE', detail: i, after: res => res.role }),
    run: (ctx, i) => appGrantRole_(ctx, i) },
  revokeRole: { name: 'ROLE.REVOKE', args: ['roleId', 'rowVersion'], current: i => ({ rowVersion: appOwnerRowVersion_('ROLES', r => r.role_id === String(i.roleId || '')) }),
    opts: i => ({ minRole: 'ADMIN', entityType: 'ROLE', entityId: i.roleId, detail: i, after: res => res.role }),
    run: (ctx, i) => appRevokeRole_(ctx, i) },
  saveClientName: { name: 'CLIENT.NAME', args: ['clientId', 'displayName', 'rowVersion'],
    current: i => ({ rowVersion: appOwnerRowVersion_('CLIENT_NAMES', r => r.client_id === String(i.clientId || '')) }),
    opts: i => ({ minRole: 'ADMIN', entityType: 'CLIENT', entityId: i.clientId, detail: i, after: res => ({ displayName: res.displayName, auto: res.auto }) }),
    run: (ctx, i) => appSaveClientName_(ctx, i) },
  saveClient: { name: 'CLIENT.SAVE', args: ['clientId', 'clientName', 'zacCode', 'isActive', 'note', 'rowVersion'], check: t => appOwnerCheckClient_(t),
    opts: i => ({ minRole: 'ADMIN', entityType: 'CLIENT', entityId: i.clientId, detail: i, after: res => res.client }),
    run: (ctx, i) => appSaveClient_(ctx, i) },
  // ---- 業務の設定（Settings.js） ----
  listSettings: { name: 'SETTINGS.LIST', opts: () => ({ minRole: 'ADMIN', audit: false }), run: () => appOwnerSettingsList_() },
  saveSetting: { name: 'SETTING.SAVE', args: ['key', 'value', 'effectiveFrom', 'note'],
    opts: i => ({ minRole: 'ADMIN', entityType: 'SETTING', entityId: i.key, detail: i, after: res => res.saved }),
    run: (ctx, i) => appSaveSetting_(ctx, i) },
  // ---- 計画の一覧・作成・担当者・測る専用の印（Portfolio.js・裏の処理 PLAN.CREATE / PLAN.EDIT・PlanPurpose.js） ----
  listPlans: { name: 'PLANS.LIST', opts: () => ({ minRole: 'VIEWER', audit: false }), run: () => appCachedRead_('PLANS', () => ({ plans: appListPlans_() })) },
  planCandidates: { name: 'PLAN.CANDIDATES', args: ['refresh'], opts: () => ({ minRole: 'ADMIN', audit: false }),
    run: (ctx, i) => appPlanCandidates_(ctx, i), brief: r => appOwnerCandidatesBrief_(r), always: true },
  // purpose: 省くか "" = 予算を立てる計画・"MEASURE" = 測る専用（5 計画まで。PlanPurpose.js）
  createPlan: { job: 'PLAN.CREATE', args: ['clientName', 'fy', 'peopleCsv', 'purpose'], check: t => { appOwnerCheckFy_(t); appPlanPurposeCheck_(t); },
    payload: i => ({ clientName: i.clientName, fy: Number(i.fy), peopleCsv: i.peopleCsv, purpose: i.purpose }) },
  setPeople: { job: 'PLAN.EDIT', args: ['planId', 'peopleCsv', 'inputHash'], current: i => ({ inputHash: appOwnerPlanHash_(i.planId) }),
    payload: i => ({ planId: i.planId, action: 'SETUP.PEOPLE', args: { peopleCsv: i.peopleCsv }, inputHash: i.inputHash }) },
  // 計画の印（測る専用）を付ける・外す（所有者だけ。監査に前と後の値。PlanPurpose.js）
  setPlanPurpose: { name: 'PLAN.PURPOSE', args: ['planId', 'purpose'], check: t => { appOwnerCheckPlanId_(t); appOwnerCheckPurpose_(t); },
    opts: i => ({ minRole: 'ADMIN', entityType: 'PLAN', entityId: i.planId, detail: i, after: res => res.plan }),
    run: (ctx, i) => appSetPlanPurpose_(ctx, i) },
  // ---- バックアップ・手入れ・監査の鎖・状態・ログ（Backup.js・Housekeeping.js・Setup.js） ----
  enableBackup: { name: 'BACKUP.ENABLE', opts: () => ({ minRole: 'ADMIN', entityType: 'SYSTEM', after: res => res }), run: () => appEnableBackup_() },
  runBackup: { name: 'BACKUP.RUN', opts: () => ({ minRole: 'ADMIN', entityType: 'SYSTEM', after: res => res }), run: ctx => appBackup_(ctx) },
  runHousekeeping: { name: 'HOUSEKEEPING.RUN', opts: () => ({ minRole: 'ADMIN', entityType: 'SYSTEM', after: res => ({ ok: res.ok, problems: res.problems }) }),
    run: ctx => appHousekeeping_(ctx) },
  verifyAudit: { name: 'AUDIT.VERIFY', opts: () => ({ minRole: 'ADMIN', entityType: 'SYSTEM', after: res => ({ ok: res.ok, months: res.months.length, rows: res.rows, anchored: res.anchored }) }),
    run: ctx => { const v = appVerifyAuditAll_(); v.anchored = v.ok ? appWithLock_(() => appAnchorClosedMonths_(ctx, v)) : []; return v; } },
  health: { name: 'HEALTH.CHECK', opts: () => ({ minRole: 'ADMIN', audit: false }), run: () => appHealth_(), brief: r => appOwnerHealthBrief_(r), always: true },
  listAudit: { name: 'AUDIT.LIST', args: ['kind', 'month', 'query', 'planId', 'limit'], opts: () => ({ minRole: 'ADMIN', audit: false }),
    run: (ctx, i) => appOwnerAuditList_(i), brief: r => appOwnerAuditBrief_(r), always: true },
  // ---- 年度の締め（YearClose.js）: 確認して指紋を受け取り、その指紋を渡して締める ----
  yearPreview: { name: 'YEAR.PREVIEW', args: ['fy'], check: t => appOwnerCheckFy_(t), opts: () => ({ minRole: 'ADMIN', audit: false }),
    run: (ctx, i) => appYearPreview_(ctx, { fy: Number(i.fy) }) },
  yearClose: { job: 'YEAR.CLOSE', args: ['fy', 'inputHash'], check: t => appOwnerCheckFy_(t), payload: i => ({ fy: Number(i.fy), inputHash: i.inputHash }) },
  // ---- 全計画の情報源の信頼度の事前分布（Learning.js・裏の処理 LEARN.POOL） ----
  poolPreview: { name: 'POOL.PREVIEW', opts: () => ({ minRole: 'ADMIN', audit: false }), run: () => appPoolPreview_() },
  poolApply: { job: 'LEARN.POOL', payload: () => ({}) },
  // ---- 計画の補正の値（Calibration.js。2026-10-07 村井さん決定 D1〜D3・D7・D8）: 今の値を見て、承認した値を書く・承認待ちの見直し案を取り下げる ----
  calibrationPreview: { name: 'CALIBRATION.PREVIEW', args: ['planId'], check: t => appOwnerCheckPlanId_(t), opts: () => ({ minRole: 'ADMIN', audit: false }),
    run: (ctx, i) => appCalibrationPreview_(i.planId) },
  // 計画への保存（PLAN.EDIT の CALIBRATION.SET。所有者だけ）。項目と値は始める前に確かめる（裏の処理の中でも確かめ直す）
  setCalibration: { job: 'PLAN.EDIT', args: ['planId', 'set', 'withdrawPendingReview', 'reason', 'inputHash'],
    check: t => { appOwnerCheckPlanId_(t); appCalibrationCheck_(t); appOwnerCheckHash_(t); }, current: i => ({ inputHash: appOwnerPlanHash_(i.planId) }),
    payload: i => ({ planId: i.planId, action: 'CALIBRATION.SET', args: { set: i.set || {}, withdrawPendingReview: i.withdrawPendingReview === true, reason: i.reason },
      inputHash: i.inputHash }) },
  // ---- AI 調査の問い合わせ先（Vertex のモデル名・リージョン・プロジェクト。Ai.js。2026-10-13 村井さん承認）: 全計画の今の値を見る・まとめて替える ----
  // 替えるのは、データ本体の各計画の CONFIG の行（VERTEX_GEMINI_MODEL と、頼まれたら VERTEX_LOCATION・VERTEX_PROJECT_ID）。planIds を省くと年度を締めていない全計画。
  // 締めた年度の計画を名指ししたら、何も書かずに断る。監査（VERTEX.SET）の終わりの行に、計画ごとの前と後の値が残る
  vertexConfigPreview: { name: 'VERTEX.PREVIEW', opts: () => ({ minRole: 'ADMIN', audit: false }), run: () => appVertexConfigPreview_() },
  setVertexConfig: { name: 'VERTEX.SET', args: ['model', 'location', 'project', 'planIds'], check: t => appVertexConfigCheck_(t),
    opts: i => ({ minRole: 'ADMIN', entityType: 'SYSTEM', entityId: 'VERTEX_CONFIG', detail: i,
      after: res => ({ want: res.want, changed: res.changed, unchanged: res.unchanged, skipped: res.skipped, remaining: res.remaining }) }),
    run: (ctx, i) => appSetVertexConfig_(ctx, i) },
  // ---- 物差し（Backtest.js・裏の処理 MEASURE.BACKTEST。表の版 10 の 3-7）: 計画の年度の初め（cutoffFy を渡せばその年度。3 年前まで）に戻って予測し直す ----
  runBacktest: { job: 'MEASURE.BACKTEST', args: ['planId', 'cutoffFy'], check: t => { appOwnerCheckPlanId_(t); appOwnerCheckCutoffFy_(t); },
    payload: i => ({ planId: i.planId, fy: i.cutoffFy === undefined ? undefined : Number(i.cutoffFy) }) },
  // ---- 人のつなぎ（PersonLinks.js。版 10 の 3-6）: 入力の担当者の名前とメンバーのメール。所有者だけ。外しても行は残す（ROLES と同じ） ----
  listPersonLinks: { name: 'PERSON_LINKS.LIST', opts: () => ({ minRole: 'ADMIN', audit: false }), run: ctx => appListPersonLinks_(ctx) },
  linkPerson: { name: 'PERSON.LINK', args: ['personName', 'email', 'clientId', 'validFrom', 'validTo', 'note'],
    opts: i => ({ minRole: 'ADMIN', entityType: 'PERSON_LINK', detail: i, after: res => res.link }),
    run: (ctx, i) => appLinkPerson_(ctx, i) },
  unlinkPerson: { name: 'PERSON.UNLINK', args: ['linkId', 'rowVersion'], current: i => ({ rowVersion: appOwnerRowVersion_('PERSON_LINKS', r => r.link_id === String(i.linkId || '').trim()) }),
    opts: i => ({ minRole: 'ADMIN', entityType: 'PERSON_LINK', entityId: i.linkId, detail: i, after: res => res.link }),
    run: (ctx, i) => appUnlinkPerson_(ctx, i) },
  // ---- 裏の処理の状態（jobId を省くと、自分が最後に始めた処理） ----
  jobStatus: { name: 'JOB.STATUS', args: ['jobId'], opts: () => ({ minRole: 'VIEWER', audit: false }),
    run: (ctx, i) => appJobStatus_(ctx, i.jobId || appOwnerLastJobId_(ctx)) }
};

/** apiOwnerTask の中身: OWNER_TASK を読んで 1 つの操作を動かし、結果を OWNER_TASK_RESULT と実行ログに残す */
function appOwnerTask_(ctx) {
  const props = appProps_();
  const raw = props.getProperty(APP_OWNER_TASK_PROP);
  const t0 = new Date().getTime();
  let action = '';
  let out;
  try {
    const task = appOwnerParseTask_(raw);
    action = task.action;
    out = appOwnerRunAction_(ctx, task);
  } catch (err) {
    if (!action) { try { action = String(JSON.parse(raw).action || '').slice(0, 100); } catch (e) { action = ''; } }   // 未定義の操作でも、頼んだ名前を残す
    const msg = String(err && err.message ? err.message : err).slice(0, 2000);
    const rec = { ok: false, action: action, at: appNowIso_(), requestId: ctx.requestId, error: msg };
    appOwnerWriteResult_(rec);
    Logger.log('OWNER_TASK ' + (action || '（不明）') + ': 失敗しました。' + msg);
    appRunLog_({ requestId: ctx.requestId, kind: 'OWNER.TASK', durationMs: new Date().getTime() - t0, status: 'FAILED', detail: { action: action }, error: msg });
    throw err;
  }
  // 頼みを片付けてから結果を書く（結果を書けなくても、同じ頼みを 2 度動かさない）。実行中に書き換えられた頼みは触らない
  const taskState = appOwnerSettleTask_(props, raw, out);
  const full = { ok: true, action: action, auditAction: out.name, at: appNowIso_(), requestId: ctx.requestId, result: out.result,
    hint: appOwnerHint_(out, taskState) };
  const logText = JSON.stringify(full, null, 1);
  const logged = logText.length <= APP_OWNER_LOG_CHUNK * APP_OWNER_LOG_MAX_CHUNKS;   // 実行ログに全部を出せるか
  const rec = appOwnerResultRecord_(full, APP_OWNER_ACTIONS[action], logged);
  appOwnerWriteResult_(rec);
  Logger.log('OWNER_TASK ' + action + ': 終わりました。' + (!rec.summarized ? '同じ結果を OWNER_TASK_RESULT にも置きました。'
    : 'OWNER_TASK_RESULT には要約を置きました。' + (logged ? '全部は下に出します。' : '長すぎるので、下には途中までを出します。')));
  appOwnerLogJson_(logText);
  appRunLog_({ requestId: ctx.requestId, kind: 'OWNER.TASK', durationMs: new Date().getTime() - t0, status: 'OK',
    detail: { action: action, auditAction: out.name, jobId: out.result && out.result.jobId ? out.result.jobId : undefined, summarized: !!rec.summarized, task: taskState } });
  return full;
}

/**
 * うまくいった後の OWNER_TASK: 読むだけなら残す・書いたら消す・裏の処理を始めたら jobStatus に置き換える。
 * 実行中に書き換えられていたら触らない。返り値 'kept' | 'deleted' | 'replaced' | 'changed'
 */
function appOwnerSettleTask_(props, raw, out) {
  if (out.kind === 'read') return 'kept';
  if (props.getProperty(APP_OWNER_TASK_PROP) !== raw) return 'changed';
  const jobId = out.kind === 'job' && out.result ? out.result.jobId : '';
  if (jobId) {
    props.setProperty(APP_OWNER_TASK_PROP, JSON.stringify({ action: 'jobStatus', jobId: jobId }));
    return 'replaced';
  }
  props.deleteProperty(APP_OWNER_TASK_PROP);
  return 'deleted';
}

/** 結果に添える一言: すぐに終わったのか・裏の処理を始めたのか、OWNER_TASK をどうしたか */
function appOwnerHint_(out, taskState) {
  const task = {
    kept: 'OWNER_TASK はそのまま残しています（もう一度実行すると読み直します）。',
    deleted: '同じ操作を 2 度動かさないよう、OWNER_TASK を消しました。',
    replaced: 'OWNER_TASK を {"action":"jobStatus","jobId":"…"} に置き換えたので、プロパティは触らずに apiOwnerTask をもう一度実行すると結果を確かめられます。',
    changed: 'OWNER_TASK は実行中に書き換えられていたので、そのままにしました。'
  }[taskState] || '';
  if (out.kind !== 'job') return 'すぐに終わりました（' + (out.kind === 'read' ? '読むだけ' : '書きました') + '。裏の処理はありません）。' + task;
  const r = out.result || {};
  const st = String(r.status || '');
  const done = st === 'DONE' || st === 'FAILED';   // 短い処理は、始めたその場で動かし終えることがある（appStartJobNow_）
  return (done ? '裏の処理として始め、すぐに終わりました（' + st + '）。'
    : '裏の処理として始めました。まだ終わっていません（1〜2 分かかります）。処理が終わるまで、スクリプト プロパティは編集・保存しないでください。')
    + task + (taskState === 'changed' ? '結果は {"action":"jobStatus","jobId":"' + r.jobId + '"} で確かめられます。' : '');
}

/** OWNER_TASK の JSON を読む。空・読めない・形が違う・未定義の操作・使えない項目なら止める */
function appOwnerParseTask_(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!text) throw new Error('OWNER_TASK が空です。スクリプト プロパティ OWNER_TASK に、頼む操作を JSON で入れてから実行してください（例: {"action":"health"}）。');
  let task;
  try { task = JSON.parse(text); } catch (e) {
    throw new Error('OWNER_TASK の JSON が読めません（' + String(e && e.message ? e.message : e).slice(0, 200) + '）。名前と文字の値を "" で囲み、項目をカンマで区切ってください。');
  }
  if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('OWNER_TASK は {"action":"…"} の形の JSON にしてください。');
  const action = String(task.action || '');
  if (!action || !Object.prototype.hasOwnProperty.call(APP_OWNER_ACTIONS, action)) {
    throw new Error('未定義の操作です: ' + (action || '（action がありません）') + '。使える操作: ' + Object.keys(APP_OWNER_ACTIONS).join(', '));
  }
  const spec = APP_OWNER_ACTIONS[action];
  const allowed = spec.args || [];
  const extra = Object.keys(task).filter(k => k !== 'action' && allowed.indexOf(k) < 0);
  if (extra.length) {
    throw new Error('使えない項目があります: ' + extra.join(', ') + '。' + action + ' で使える項目: ' + (allowed.length ? allowed.join(', ') : '（なし）'));
  }
  if (spec.check) spec.check(task);
  return task;
}

/** 年度（fy）が要る操作: 4 桁の数でなければ、何もせずに止める（裏の処理を入れる前に） */
function appOwnerCheckFy_(t) {
  const fy = String(t.fy === undefined || t.fy === null ? '' : t.fy).trim();
  if (!/^\d{4}$/.test(fy)) throw new Error(t.action + ' には年度（fy）を 4 桁の数で入れてください（例: "fy":2027）。');
}

/** 計画（planId）が要る操作: 無ければ、何もせずに止める（計画が見つからないときは、始める前の判定が止める） */
function appOwnerCheckPlanId_(t) {
  if (typeof t.planId !== 'string' || !t.planId.trim()) throw new Error(t.action + ' には計画の ID（planId。listPlans の planId）を入れてください。');
}

/** setPlanPurpose の印（purpose）は省けない（外すときは ""） */
function appOwnerCheckPurpose_(t) {
  if (t.purpose === undefined) throw new Error(t.action + ' には印（purpose）を入れてください（測る専用は "MEASURE"、外すときは ""）。');
  appPlanPurposeCheck_(t);
}

/** 物差しの区切りの年度（cutoffFy）は省ける（計画の年度）。入れるなら 4 桁の数（計画の年度から 3 年前までかは、裏の処理が確かめる） */
function appOwnerCheckCutoffFy_(t) {
  if (t.cutoffFy !== undefined && !/^\d{4}$/.test(String(t.cutoffFy === null ? '' : t.cutoffFy).trim())) {
    throw new Error(t.action + ' の cutoffFy（区切りの年度）は 4 桁の数で入れてください（例: "cutoffFy":2026。省くと計画の年度）。');
  }
}

/** 指紋（inputHash）は省ける。入れるなら calibrationPreview などで受け取った 64 桁のまま */
function appOwnerCheckHash_(t) {
  if (t.inputHash !== undefined && !/^[a-f0-9]{64}$/.test(String(t.inputHash))) throw new Error('inputHash は calibrationPreview の inputHash（64 桁）をそのまま入れてください（省くと、実行したときの今の指紋で書きます）。');
}

/**
 * saveClient: 中の関数（appSaveClient_）は全部の項目を書くので、既存のメーカーを直すとき（clientId あり）に項目を省くと、
 * ZAC のコード・メモが空に、無効のメーカーが有効に戻る。直すときは全部の項目と rowVersion を求める（listDirectory の clients から写す）
 */
function appOwnerCheckClient_(t) {
  if (t.isActive !== undefined && typeof t.isActive !== 'boolean') throw new Error('isActive は true か false で入れてください（"" で囲まない）。');
  if (!t.clientId) return;
  const missing = ['clientName', 'zacCode', 'isActive', 'note', 'rowVersion'].filter(k => t[k] === undefined || t[k] === null || (k === 'rowVersion' && t[k] === ''));
  if (missing.length) {
    throw new Error('既存のメーカーを直すときは、全部の項目を入れてください（省くと空や有効に戻ります）。足りない項目: ' + missing.join(', ') +
      '。今の値と rowVersion（clientRowVersion）は listDirectory の clients から写してください。');
  }
}

/** 1 つの操作を、入口と同じ判定と記録で動かす。返り値 { name, kind（read・write・job）, result } */
function appOwnerRunAction_(ctx, task) {
  const spec = APP_OWNER_ACTIONS[task.action];
  const input = {};
  (spec.args || []).forEach(k => { if (task[k] !== undefined) input[k] = task[k]; });
  if (spec.current && appIsSetUp_()) appOwnerFillCurrent_(input, spec.current(input));
  if (spec.job) {
    // apiStartJob と同じ: 種類ごとの役割（計画ごとの処理はその計画のクライアントも）を確かめてから、待ち行列に入れる
    const req = { kind: spec.job, payload: spec.payload(input) };
    return { name: 'JOB.START', kind: 'job', result: appOwnerRun_(ctx, 'JOB.START', appJobStartOpts_(req), c => appStartJobNow_(c, req)) };
  }
  const opts = spec.opts(input);
  return { name: spec.name, kind: opts.audit === false ? 'read' : 'write', result: appOwnerRun_(ctx, spec.name, opts, c => spec.run(c, input)) };
}

/** 頼みに無い（空の）印だけを、今の値で足す（今の値が無い = 行が無い・新しく作るときは足さない。中の関数が決める） */
function appOwnerFillCurrent_(input, cur) {
  const empty = v => v === undefined || v === null || v === '';
  Object.keys(cur || {}).forEach(k => { if (empty(input[k]) && !empty(cur[k])) input[k] = cur[k]; });
  return input;
}

/** 表の、条件に合う行の今の版（無ければ undefined。表がまだ無ければ undefined） */
function appOwnerRowVersion_(table, pred) {
  let rows;
  try { rows = appReadTable_(table); } catch (e) { if (/表がありません/.test(String(e && e.message))) return undefined; throw e; }
  const r = rows.filter(pred)[0];
  return r ? r.row_version : undefined;
}

/** 計画の今の指紋（計画が無ければ undefined。始める前の判定が「計画が見つかりません」で止める） */
function appOwnerPlanHash_(planId) {
  const id = String(planId || '');
  return id && appReadTable_('PLANS').some(p => p.plan_id === id) ? appPlanInputHash_(id) : undefined;
}

/**
 * api_ の、本人確認の後と同じ流れ: 役割を確かめ、読むだけならそのまま、書くなら初期設定を確かめて記録つきで実行する
 * （appAudited_: 開始を記録できなければ実行しない・終了に OK / FAILED と変更後の値）。所有者は常に全体の管理者
 */
function appOwnerRun_(ctx, action, opts, fn) {
  if (!appHasRole_(ctx.roles, opts.minRole || 'ADMIN', opts.clientId)) {
    if (appIsSetUp_()) {
      try {
        appAuditAppend_({ actor: ctx.actor, actorRoles: appRoleSummary_(ctx.roles), action: action, phase: 'DENIED', result: 'DENIED', entityType: opts.entityType,
          entityId: opts.entityId, clientId: opts.clientId, detail: opts.detail, reason: APP_OWNER_REASON, requestId: ctx.requestId });
      } catch (e) { Logger.log('OWNER_TASK DENIED の記録に失敗: ' + (e && e.message ? e.message : e)); }
    }
    throw new Error('この操作をする権限がありません。');
  }
  if (opts.audit === false) return appSerialize_(fn(ctx));
  if (!appIsSetUp_()) throw new Error('初期設定がまだです。所有者が「初期設定」を実行してください。');
  return appSerialize_(appAudited_(ctx, action, Object.assign({ reason: APP_OWNER_REASON }, opts), () => fn(ctx)));
}

/**
 * OWNER_TASK_RESULT に置く形。短い形（brief）を使い、それでも大きければ配列と文字を切り詰める。
 * logged は実行ログに全部を出せるか（出せないときは「全部は実行ログ」と書かず、絞り方を書く）
 */
function appOwnerResultRecord_(full, spec, logged) {
  const rec = Object.assign({}, full);
  let summarized = false;
  if (spec && spec.brief && full.result && (spec.always || appUtf8Bytes_(JSON.stringify(full)) > APP_OWNER_RESULT_MAX_BYTES)) {
    try { rec.result = spec.brief(full.result); summarized = true; } catch (e) { rec.result = full.result; }
  }
  const note = logged === false ? APP_OWNER_CUT_NOTE : APP_OWNER_SUMMARY_NOTE;
  const room = APP_OWNER_RESULT_MAX_BYTES - appUtf8Bytes_(JSON.stringify(Object.assign({}, rec, { result: null, summarized: true, note: note }))) - 50;
  const fit = appOwnerFit_(rec.result === undefined ? null : rec.result, room);
  rec.result = fit.value;
  if (summarized || fit.truncated) { rec.summarized = true; rec.note = note; }
  return rec;
}

/** OWNER_TASK_RESULT に書く（9KB を超えないように。書けなければ実行ログにだけ残す） */
function appOwnerWriteResult_(rec) {
  let text = JSON.stringify(rec);
  if (appUtf8Bytes_(text) > APP_OWNER_RESULT_MAX_BYTES) {
    text = JSON.stringify({ ok: rec.ok, action: rec.action, at: rec.at, requestId: rec.requestId, error: rec.error ? String(rec.error).slice(0, 500) : undefined,
      summarized: true, note: rec.note || APP_OWNER_SUMMARY_NOTE });
  }
  try { appProps_().setProperty(APP_OWNER_RESULT_PROP, text); }
  catch (e) { Logger.log('OWNER_TASK_RESULT に書けません: ' + (e && e.message ? e.message : e)); }
}

/** 結果の全部（JSON の文字）を実行ログに出す（1 回に出す長さを区切る。回数の上限を超える分は出さない） */
function appOwnerLogJson_(text) {
  const n = Math.max(1, Math.ceil(text.length / APP_OWNER_LOG_CHUNK));
  const shown = Math.min(n, APP_OWNER_LOG_MAX_CHUNKS);
  for (let i = 0; i < shown; i++) {
    Logger.log((n > 1 ? '結果（' + (i + 1) + '/' + n + '）' : '結果') + ': ' + text.slice(i * APP_OWNER_LOG_CHUNK, (i + 1) * APP_OWNER_LOG_CHUNK));
  }
  if (n > shown) Logger.log('結果が長すぎるので、ここまでにしました（' + shown + '/' + n + '）。listAudit なら limit を小さくするか、month・query で絞ってください。');
}

/**
 * 値を maxBytes（JSON の UTF-8 のバイト数）に収める。配列は先頭だけ・長い文字は切る・項目の多いものは先頭だけ。
 * それでも収まらなければ JSON の先頭だけを文字で返す。{ value, truncated }
 */
function appOwnerFit_(value, maxBytes) {
  const size = v => appUtf8Bytes_(JSON.stringify(v === undefined ? null : v));
  if (size(value) <= maxBytes) return { value: value, truncated: false };
  const caps = [[50, 400], [20, 200], [10, 120], [5, 80], [3, 60], [1, 40]];
  for (let i = 0; i < caps.length; i++) {
    const v = appOwnerShrink_(value, caps[i][0], caps[i][1], 0);
    if (size(v) <= maxBytes) return { value: v, truncated: true };
  }
  // 1 文字は UTF-8 で 3 バイトまで（JSON.stringify の結果を UTF-16 の単位で切るので、サロゲートの片方も 3 バイト以内）。文字の値にすると " と \ が増えるので余裕をみる
  const head = JSON.stringify(value).slice(0, Math.max(0, Math.floor((maxBytes - 100) / 3 / 2)));
  return { value: { head: head }, truncated: true };
}

function appOwnerShrink_(v, maxItems, maxChars, depth) {
  if (typeof v === 'string') return v.length > maxChars ? v.slice(0, maxChars) + '…' : v;
  if (!v || typeof v !== 'object') return v;
  if (depth > 6) return Array.isArray(v) ? '（' + v.length + ' 件）' : '（省略）';
  if (Array.isArray(v)) {
    const out = v.slice(0, maxItems).map(x => appOwnerShrink_(x, maxItems, maxChars, depth + 1));
    if (v.length > maxItems) out.push('…ほか ' + (v.length - maxItems) + ' 件');
    return out;
  }
  const keys = Object.keys(v);
  const keep = Math.max(maxItems * 2, 8);
  const out = {};
  keys.slice(0, keep).forEach(k => { out[k] = appOwnerShrink_(v[k], maxItems, maxChars, depth + 1); });
  if (keys.length > keep) out['…'] = 'ほか ' + (keys.length - keep) + ' 項目';
  return out;
}

// ---- 操作ごとの中身・短い形 ----

/** 業務の設定の一覧（スプレッドシートの設定は名前と URL も） */
function appOwnerSettingsList_() {
  return appCachedRead_('SETTINGS', () => ({ settings: appSettingsCurrent_().map(x => {
    if (x.type !== 'sheet' || !x.value) return x;
    let name = '';
    try { name = DriveApp.getFileById(x.value).getName(); } catch (e) { name = '（開けません）'; }
    return Object.assign({}, x, { display: name, url: 'https://docs.google.com/spreadsheets/d/' + x.value + '/edit' });
  }) }));
}

/** 自分が最後に始めた処理（続きの段ではなく、始めた処理）の ID */
function appOwnerLastJobId_(ctx) {
  const mine = appJobList_().filter(j => j.requestedBy === ctx.actor && !j.parentId);
  if (!mine.length) throw new Error('確かめる処理がありません（jobId を指定してください）。');
  return mine[mine.length - 1].id;
}

/** メンバー・役割・メーカーの短い形（次の操作にそのまま写せる名前: roleId・rowVersion・clientId） */
function appOwnerDirectoryBrief_(r) {
  const roles = r.roles || [];
  return {
    owner: r.owner,
    grantable: r.grantable,
    members: (r.members || []).map(m => ({ email: m.email, displayName: m.display_name, department: m.department, active: m.is_active, rowVersion: m.row_version })),
    roles: roles.filter(x => x.is_active).map(x => ({ roleId: x.role_id, email: x.email, role: x.role, scopeType: x.scope_type, clientId: x.client_id,
      validFrom: x.valid_from, validTo: x.valid_to, rowVersion: x.row_version })),
    inactiveRoles: roles.filter(x => !x.is_active).length,
    // rowVersion は表示名（CLIENT_NAMES）の行の版。saveClientName に渡す（決めたことがなければ空）。
    // clientRowVersion はメーカー（CLIENTS）の行の版。saveClient の rowVersion に渡す（zacName・zacCode・active・note も写す）
    clients: (r.clients || []).map(c => ({ clientId: c.client_id, zacName: c.client_name, zacCode: c.zac_code, active: c.is_active, note: c.note,
      displayName: c.display_name, auto: c.display_auto, rowVersion: c.display_row_version, clientRowVersion: c.row_version }))
  };
}

/** 計画を作れるメーカーの候補の短い形（createPlan の clientName にそのまま写せる ZAC の名前） */
function appOwnerCandidatesBrief_(r) {
  return { defaultFy: r.defaultFy, existing: r.existing, candidates: (r.candidates || []).map(c => c.zac) };
}

/**
 * 状態の点検の要約（問題のある表だけ・監査の鎖・バックアップ・トリガーの数・手入れ・保存の控え・処理・年度・ファイル）。
 * 画面の「記録と状態」で警告にしていたことを warnings に並べ、1 つでもあれば ok は false
 */
function appOwnerHealthBrief_(h) {
  if (!h || !h.setUp) return { setUp: false };
  const tables = h.tables || [];
  const bad = tables.filter(t => !t.ok);
  const triggers = {};
  (h.triggers || []).forEach(n => { triggers[n] = (triggers[n] || 0) + 1; });
  const hk = h.housekeeping;
  const b = h.backup || {};
  const warnings = [];
  if (bad.length) warnings.push('表に問題があります（' + bad.length + ' つ）');
  if (!(h.audit && h.audit.ok)) warnings.push('監査の鎖に改ざんの疑いがあるか、確かめられません');
  if (h.audit && h.audit.matchesLatest === false) warnings.push('監査の最後の行が消えた疑いがあります');
  if (!b.enabled) warnings.push(b.note ? 'バックアップの状態を読めません' : '毎日のバックアップが有効ではありません');
  else if (b.ageHours > APP_OWNER_BACKUP_STALE_HOURS) warnings.push('バックアップが ' + b.ageHours + ' 時間止まっています');
  if (hk && hk.stalled) warnings.push('毎日の手入れが途中で止まりました（' + String(hk.startedAt || hk.at || '') + ' に始めて、終わりの記録がありません）');
  if (hk && hk.ok === false) warnings.push('毎日の手入れに要確認があります');
  if (h.journal) warnings.push('書きかけの保存があります');
  if (h.years && h.years.error) warnings.push('年度の一覧を読めません');
  const size = h.size || null;
  if (size && size.error) warnings.push('データ本体の大きさを読めません');
  else if (size && size.ratio >= APP_CELL_WARN_RATIO) warnings.push('データ本体のセルが上限の ' + Math.round(size.ratio * 100) + '% です（半分を超えたら、締めた年度の行を移すか表を分けるかを決めます）');
  ((size && size.years) || []).filter(y => y.ratio >= APP_YEAR_WARN_RATIO).forEach(y => warnings.push('FY' + y.fy + ' の年度の控えが上限（8MB）の約 ' + Math.round(y.ratio * 100) + '% です'));
  const bf = h.backfills || null;
  if (bf && (bf.error || (bf.failed || []).length)) warnings.push('一度だけの写しに失敗があります');
  return {
    setUp: true,
    ok: !warnings.length,
    warnings: warnings,
    tables: { count: tables.length, ok: tables.length - bad.length, problems: bad.map(t => ({ name: t.name, note: t.note, missing: !!t.missing })) },
    audit: h.audit ? { ok: h.audit.ok, rows: h.audit.rows, brokenAt: h.audit.brokenAt, matchesLatest: h.audit.matchesLatest, note: h.audit.note } : null,
    backup: h.backup,
    triggers: triggers,
    // errors は 24 時間のエラーの数、openStarts は終わりの記録が無い開始の数（手入れのときの数）
    // state は RUNNING（動いている・stalled なら途中で止まった）か DONE。lastDoneAt は最後に終わった時刻
    housekeeping: hk ? { at: hk.at, state: hk.state, stalled: !!hk.stalled, lastDoneAt: hk.lastDoneAt, ok: hk.ok, problems: hk.problems, errors: hk.errors, openStarts: hk.openStarts } : null,
    journal: h.journal ? { id: h.journal.id, label: h.journal.label, planId: h.journal.planId, at: h.journal.at } : null,
    jobs: h.jobs,
    years: h.years,
    // セルの数（cells は上限 limit に数える全部のシートの 行 × 列）と、年度の控えの大きさの目安（年度ごと。計画ごとは全部の結果に）
    size: size && !size.error ? { cells: size.cells, usedCells: size.usedCells, limit: size.limit, ratio: size.ratio,
      years: (size.years || []).map(y => ({ fy: y.fy, plans: y.plans.length, bytes: y.bytes, ratio: y.ratio })) } : size,
    backfills: bf,
    files: h.files
  };
}

/** ログの一覧（appLogList_）。エディタからは、limit が無ければ新しい 200 行まで（最大 2000 行） */
function appOwnerAuditList_(i) {
  const limit = Math.max(1, Math.min(2000, Math.floor(Number(i.limit)) || APP_OWNER_AUDIT_LIMIT));
  return Object.assign(appLogList_(Object.assign({}, i, { limit: limit })), { limit: limit });
}

/** ログの行の短い形（新しい順。種類ごとに要る列だけ） */
function appOwnerAuditBrief_(r) {
  const pick = {
    AUDIT: o => ({ at: o.occurred_at, actor: o.actor_email, action: o.action, phase: o.phase, result: o.result, entity: o.entity_id, error: o.error }),
    RUN: o => ({ at: o.finished_at, kind: o.kind, status: o.status, ms: o.duration_ms, error: o.error }),
    ERROR: o => ({ at: o.occurred_at, actor: o.actor_email, where: o.where, message: o.message })
  }[r.kind] || (o => o);
  return { kind: r.kind, month: r.month, months: r.months, limit: r.limit, count: (r.rows || []).length, rows: (r.rows || []).map(pick) };
}
