/**
 * AutoResearch.js — 市場の動き（A-4 AI 調査）を、計画ごとに週 1 回、自動で集める（2026-10-06 村井さん承認「週1回自動」）。
 *
 * - 毎日 4 時半ごろ（4:15〜4:45）の時間主導のトリガー（triggerAutoResearch。所有者として動く）が、計画を 1 つ選んで A-4 を裏の処理（PLAN.RUN）で始める。
 *   3 時台の毎日のバックアップと手入れ（triggerDailyBackup）はスクリプトのロックを使うので、時間を分ける。
 *   始めてよいのは 4 時から 7 時より前まで。毎日のバックアップのトリガーがあるときは、その日の手入れが終わるまで始めない。
 *   選ぶのは、進行中（ACTIVE）・今年度か来年度・年度を締めていない計画のうち、最後に A-4 が終わってから 7 日を過ぎた（一度も無い）もので、いちばん古いもの。
 *   測る専用の計画（PLANS.purpose = MEASURE。版 10 の 3-9）は、費用のため選ばない（手で動かす A-4 も断る。PlanPurpose.js）。
 *   ほかの処理が動いている・待っているときは何もしない（裏の処理は 1 つずつ。Jobs.js）。
 * - 自動で始めた A-4 が終わったら（成功でも失敗でも）、7 時より前なら次に古い計画を始める（Jobs.js の appRunJob_ から appAutoResearchAfterJob_）。
 * - 始め方は画面から始めるのと同じ（appStartJob_）。頼んだ人の役割と年度の締めは appRunJob_ が段ごとに確かめ直し、段ごとに監査ログに残る。
 *   自動で始めた印は処理の中身（画面から渡せる項目だけ残る）ではなく、この状態の控え（始めた処理の ID）に置く（画面から偽れない）。
 * - トリガーは、毎日の手入れ（appDailyMaintenance_）と、所有者が画面を開いたとき（確かめるのは 1 日 1 回）に、無ければ作る。
 *   時刻を変えたときは、控えの版（APP_AUTO_RESEARCH_SCHEDULE）を上げる。前の版のトリガー（1 時ごろ）は 1 回だけ消して作り直す。
 * - 止めるとき: Script Properties の AUTO_RESEARCH_ENABLED を 'false' にする（トリガーは残っても何もしない。既定は動かす）。
 * 1 回ごとに実行ログ（RUN、種類 AUTO.RESEARCH）に残す。状態は Script Properties（APP_AUTO_RESEARCH、約 8000 バイトより小さく）に置く。
 * 予測の計算・保存のしかた・権限は変えない（A-4 は画面から始めたときと同じ処理で動く）。
 */
const APP_AUTO_RESEARCH_HANDLER = 'triggerAutoResearch';
const APP_AUTO_RESEARCH_HOUR = 4;               // 毎日 4 時台に動かす（3 時台のバックアップと手入れの後。1 回の実行は 6 分までなので 4 時すぎには終わっている）
const APP_AUTO_RESEARCH_MINUTE = 30;            // 4 時半ごろ（トリガーは前後 15 分のどこかで動く: 4:15〜4:45）
const APP_AUTO_RESEARCH_END_HOUR = 7;           // 始めてよいのは 7 時より前まで（続けて次の計画を始めるときも）
const APP_AUTO_RESEARCH_SCHEDULE = 2;           // トリガーの時刻の版（1 = 1 時ごろ、2 = 4 時半ごろ）。時刻を変えたら上げる
const APP_AUTO_RESEARCH_MAINTENANCE_GRACE_MS = 5 * 60 * 1000;   // 毎日の手入れが終わってから、これだけあけて始める（手入れの後の知らせと記録もロックを使う）
const APP_AUTO_RESEARCH_STALE_DAYS = 7;         // 最後の A-4 からこれだけたったら集め直す
const APP_AUTO_RESEARCH_RETRY_DAYS = 3;         // 自動で試して失敗した・準備ができていなかった・権限が足りなかった計画は、これだけあけてから試す
const APP_AUTO_RESEARCH_MAX_PER_NIGHT = 12;     // 1 晩に始める計画の上限（Vertex AI の費用の歯止め）
const APP_AUTO_RESEARCH_READY_CHECKS = 20;      // 1 回に準備を確かめる計画の数（準備ができていない計画が続いても、この数までは次を探す）
const APP_AUTO_RESEARCH_HISTORY = 30;           // 自動で始めた A-4 の結果を残す数（新しい順）
const APP_AUTO_RESEARCH_FAILS = ['FAILED', 'STALLED', 'START_FAILED'];
const APP_AUTO_RESEARCH_MAX_BYTES = 7900;       // 状態の大きさ（UTF-8 のバイト数）。1 つの値の上限は約 9KB
const APP_AUTO_RESEARCH_REASON_CHARS = 40;      // 試した計画ごとに控える失敗の理由の長さ
const APP_AUTO_RESEARCH_ERROR_CHARS = 120;      // 最後の結果に控えるエラーの長さ
const APP_AUTO_RESEARCH_PROP = 'APP_AUTO_RESEARCH';              // 状態（APP_JOB_ で始めない。処理の一覧に混ざる）
const APP_AUTO_RESEARCH_CHECKED_PROP = 'APP_AUTO_RESEARCH_CHECKED';   // トリガーを確かめた日と時刻の版（1 日 1 回だけ確かめる）
const APP_AUTO_RESEARCH_SWITCH = 'AUTO_RESEARCH_ENABLED';         // 'false' で止める
const APP_TRIGGER_LIMIT = 20;                   // トリガーは 1 人 1 プロジェクト 20 個まで
const APP_AUTO_RESEARCH_TRIGGER_SPARE = 3;      // 裏の処理（1 回だけのトリガー）のために空けておく数

/** 状態と理由の画面の名前（状態と一緒に返す。画面が自分で表を持たなくてよい） */
const APP_AUTO_RESEARCH_LABELS = {
  // 1 回ごとの結果・計画を試した結果
  STARTED: '始めた', DONE: '終わった', FAILED: '失敗した', SKIPPED: '見送った', STALLED: '途中で止まった',
  START_FAILED: '始められなかった', NOT_READY: '準備ができていない', DENIED: '権限が足りない',
  // 見送った理由
  DISABLED: '止めてある（AUTO_RESEARCH_ENABLED）', BUSY: 'ほかの処理が動いていた', NO_STALE_PLAN: '集め直す計画が無い',
  BEFORE_HOURS: APP_AUTO_RESEARCH_HOUR + ' 時より前（毎日の手入れの時間）', AFTER_HOURS: APP_AUTO_RESEARCH_END_HOUR + ' 時を過ぎた',
  NIGHT_LIMIT: '1 晩の上限（' + APP_AUTO_RESEARCH_MAX_PER_NIGHT + ' 計画）', MAINTENANCE_PENDING: '今日の毎日の手入れがまだ終わっていない',
  // 準備ができていない理由
  NO_SETUP: '計画の設定（CONFIG）が無い', AI_DISABLED: 'AI 調査が無効（AI_RESEARCH_ENABLED）', VERTEX_CONFIG: 'Vertex AI の設定が足りない',
  NO_SALES_DATA: '売上の取り込み（A-2）が済んでいない',
  // トリガー
  TRIGGER_LIMIT: 'トリガーの数に余裕が無い', CHECKING: '確かめる途中で止まった', NOT_SET_UP: '初期設定がまだ', CHECKED_TODAY: '今日はもう確かめた',
  // 始めたきっかけ
  TICK: '毎日の回', CHAIN: '続き', JOB: '裏の処理'
};

/** 「今」（テストで差し替える） */
function appAutoResearchNow_() { return new Date(); }

function appAutoResearchIso_(d) {
  return Utilities.formatDate(d, APP_TZ, "yyyy-MM-dd'T'HH:mm:ssZ");
}

/** 状態・理由の画面の名前（無い印はそのまま。失敗の文もそのまま） */
function appAutoResearchLabel_(code) {
  const c = String(code || '');
  return c ? (APP_AUTO_RESEARCH_LABELS[c] || c) : '';
}

/** 止めるスイッチ: Script Properties の AUTO_RESEARCH_ENABLED が 'false'（か '0'）なら動かさない。無ければ動かす */
function appAutoResearchEnabled_() {
  const v = String(appProps_().getProperty(APP_AUTO_RESEARCH_SWITCH) || '').trim().toLowerCase();
  return v !== 'false' && v !== '0';
}

/**
 * 失敗の文の要点を max 字まで。A-4 の失敗は、旧来の決まった文の後に「問い合わせの失敗（n 件）:」と 1 件 1 行が続くので、
 * その最初の行の「→」の後（例: 403 PERMISSION_DENIED …）を取る。無ければ最後の行（長ければ後ろを残す）
 */
function appAutoResearchGist_(msg, max) {
  const s = String(msg || '');
  if (!s.trim()) return '';
  const lines = t => t.split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const i = s.indexOf('問い合わせの失敗');
  const failures = i >= 0 ? lines(s.slice(i)).slice(1) : [];
  const all = lines(s);
  let g = failures[0] || all[all.length - 1] || '';
  const j = g.lastIndexOf('→');
  if (j >= 0) g = g.slice(j + 1).trim();
  if (g.length <= max) return g;
  return failures.length || j >= 0 ? g.slice(0, max - 1) + '…' : '…' + g.slice(-(max - 1));
}

// ---- 状態の控え ----

function appAutoResearchState_() {
  try {
    const st = JSON.parse(appProps_().getProperty(APP_AUTO_RESEARCH_PROP) || '{}');
    return st && typeof st === 'object' ? st : {};
  } catch (e) {
    return {};
  }
}

/**
 * 状態を約 8000 バイトより小さくした JSON にする。ふだんは古いものを忘れるだけ（試した結果は 30 日・失敗の時刻は 7 日・結果は 30 件）。
 * それでも大きいときは、試した結果の理由の文 → 古い試した結果 → 結果の一覧（古い順）→ 失敗の時刻（古い順）の順に減らす
 */
function appAutoResearchFit_(st, nowMs) {
  st.history = (st.history || []).slice(-APP_AUTO_RESEARCH_HISTORY);
  st.fails = (st.fails || []).filter(t => nowMs - Number(t) <= 7 * 864e5);   // 失敗の時刻（7 日の数。結果の一覧の件数とは別に持つ）
  const tried = st.tried || {};
  Object.keys(tried).forEach(k => { if (!(nowMs - new Date(tried[k].at).getTime() <= 30 * 864e5)) delete tried[k]; });   // 30 日より前の試しは忘れる
  st.tried = tried;
  const big = () => appUtf8Bytes_(JSON.stringify(st)) > APP_AUTO_RESEARCH_MAX_BYTES;
  if (big()) Object.keys(tried).forEach(k => { delete tried[k].reason; });
  const oldest = Object.keys(tried).sort((a, b) => (tried[a].at < tried[b].at ? -1 : tried[a].at > tried[b].at ? 1 : 0));
  while (big() && oldest.length) delete tried[oldest.shift()];
  while (big() && st.history.length) st.history.shift();
  while (big() && st.fails.length) st.fails.shift();
  if (big() && st.lastResult) st.lastResult.error = '';
  return JSON.stringify(st);
}

/** 状態を読み・変えて・書く（ロックの中。fn の返り値を返す） */
function appAutoResearchUpdate_(fn) {
  return appWithLock_(() => {
    const st = appAutoResearchState_();
    const out = fn(st);
    appProps_().setProperty(APP_AUTO_RESEARCH_PROP, appAutoResearchFit_(st, appAutoResearchNow_().getTime()));
    return out;
  });
}

/** 状態を変える。書けなくても（Script Properties の失敗・ロックの待ちなど）止めない: ログに残して undefined を返す */
function appAutoResearchTryUpdate_(fn, what) {
  try {
    return appAutoResearchUpdate_(fn);
  } catch (e) {
    Logger.log('自動の AI 調査の状態を控えられません（' + what + '）: ' + (e && e.message ? e.message : e));
    return undefined;
  }
}

/** 計画を試した結果を控える（toHistory が false なら、結果の一覧には入れない）。理由は短い印か、失敗の文の要点（40 字まで） */
function appAutoResearchNote_(st, planId, status, nowMs, reason, toHistory) {
  const at = appAutoResearchIso_(new Date(nowMs));
  const t = { at: at, status: status };
  const r = appAutoResearchGist_(reason, APP_AUTO_RESEARCH_REASON_CHARS);
  if (r) t.reason = r;
  (st.tried = st.tried || {})[planId] = t;
  if (toHistory !== false) (st.history = st.history || []).push({ at: at, planId: planId, status: status });
  if (APP_AUTO_RESEARCH_FAILS.indexOf(status) >= 0) (st.fails = st.fails || []).push(nowMs);
}

// ---- 対象の計画 ----

/**
 * 自動で集める対象の計画: 進行中・測る専用でない・今年度（fy）か来年度・年度を締めていない。
 * 最後に A-4 が終わった時刻（PLAN_ACTIONS の DONE。画面から動かしたものも数える。無ければ 0）の古い順
 */
function appAutoResearchPlans_(fy) {
  const last = {};
  appReadTable_('PLAN_ACTIONS').forEach(r => {
    if (r.action !== 'AI.RESEARCH' || r.status !== 'DONE') return;
    const t = new Date(r.finished_at).getTime();
    if (isFinite(t) && t > (last[r.plan_id] || 0)) last[r.plan_id] = t;
  });
  const names = appClientNameMap_();
  return appReadTable_('PLANS')
    .filter(p => p.state === 'ACTIVE' && !appPlanIsMeasure_(p) && (Number(p.fy) === fy || Number(p.fy) === fy + 1) && !appAutoResearchFrozen_(p.fy))
    .map(p => ({ planId: p.plan_id, clientId: p.client_id, clientName: names[p.client_id] || p.client_label, fy: String(p.fy), lastAt: last[p.plan_id] || 0 }))
    .sort((a, b) => a.lastAt - b.lastAt || (a.planId < b.planId ? -1 : a.planId > b.planId ? 1 : 0));
}

/** 年度を締めたか（確かめられなければ締めたとみなす: 自動では書かない） */
function appAutoResearchFrozen_(fy) {
  try { return appYearIsFrozen_(fy); } catch (e) { return true; }
}

/** 最後の A-4 から 7 日を過ぎた（一度も無い）計画 */
function appAutoResearchStale_(plans, nowMs) {
  return plans.filter(p => !p.lastAt || nowMs - p.lastAt >= APP_AUTO_RESEARCH_STALE_DAYS * 864e5);
}

/**
 * A-4 を始められるか。旧来の A-4 が最初に確かめることと同じものを、データ本体から読むだけで確かめる:
 * CONFIG の AI_RESEARCH_ENABLED が 1 以上・VERTEX_PROJECT_ID / VERTEX_LOCATION / VERTEX_GEMINI_MODEL が入っている・A-2 売上の取り込みが成功している。
 * 読めないときは始める（処理そのものが理由つきで止まる）
 */
function appAutoResearchReady_(planId) {
  try {
    const book = appStoreBook_(appPlanOf_(planId));
    const sh = book.getSheetByName('CONFIG');
    if (!sh) return { ok: false, reason: 'NO_SETUP' };
    const cfg = {};
    if (sh.getLastRow() >= 1) {
      sh.getRange(1, 1, sh.getLastRow(), 2).getValues().forEach(r => {
        const s = String(r[0] || '').trim();
        const i = s.search(/[（(]/);   // 旧来の configKeyOf_ と同じ: 「（」「(」より前がキー
        const k = (i >= 0 ? s.slice(0, i) : s).trim();
        if (k) cfg[k] = r[1];
      });
    }
    if (!(Number(cfg.AI_RESEARCH_ENABLED || 0) > 0)) return { ok: false, reason: 'AI_DISABLED' };
    if (!['VERTEX_PROJECT_ID', 'VERTEX_LOCATION', 'VERTEX_GEMINI_MODEL'].every(k => String(cfg[k] || '').trim())) return { ok: false, reason: 'VERTEX_CONFIG' };
    const ps = book.getSheetByName('PROCESS_STATUS');
    const step1 = (ps ? ps.getDataRange().getValues() : []).filter(r => r[0] === 'step1_status')[0];
    if (!step1 || step1[3] !== 'success') return { ok: false, reason: 'NO_SALES_DATA' };
    return { ok: true };
  } catch (e) {
    return { ok: true, note: 'CHECK_FAILED' };
  }
}

/** 動いている・待っている裏の処理（止まったものと、始まらずに 15 分たったものは数えない。appStartJob_ と同じ） */
function appAutoResearchBusy_() {
  const now = new Date().getTime();
  return appJobList_().filter(j => (j.status === 'QUEUED' && now - new Date(j.createdAt).getTime() <= APP_JOB_QUEUE_EXPIRE_MS) ||
    (j.status === 'RUNNING' && !appJobIsStale_(j)))[0] || null;
}

/**
 * 今日の毎日の手入れ（triggerDailyBackup。3 時台）がまだ終わっていないか。毎日のバックアップのトリガーが無ければ待たない。
 * 終わりは、手入れが最後に残す控え（APP_HOUSEKEEPING の始めた時刻 at と、かかった時間 durationMs）で見る。終わってから 5 分は待つ
 */
function appAutoResearchMaintenancePending_(now) {
  if (!appBackupEnabled_()) return false;
  const last = appHousekeepingLast_();
  const at = last && last.at ? new Date(last.at).getTime() : NaN;
  if (!isFinite(at)) return true;
  if (Utilities.formatDate(new Date(at), APP_TZ, 'yyyy-MM-dd') !== Utilities.formatDate(now, APP_TZ, 'yyyy-MM-dd')) return true;
  return now.getTime() < at + (Number(last.durationMs) || 0) + APP_AUTO_RESEARCH_MAINTENANCE_GRACE_MS;
}

// ---- 始める ----

/** 毎日 4 時半ごろ（triggerAutoResearch）: 計画を 1 つ選んで A-4 を始める */
function appAutoResearchTick_(ctx) {
  return appAutoResearchNext_(ctx, 'TICK');
}

/**
 * 次の計画を 1 つ選んで A-4 を始める（毎日のトリガー TICK と、自動で始めた A-4 が終わった後の続き CHAIN の共通）。
 * 始められない理由（止めてある・4 時より前か 7 時を過ぎた・手入れが終わっていない・ほかの処理が動いている・対象が無い）は例外にせず返す。毎回、実行ログに残す。
 * 状態が書けなくても止めない（ログに残して続ける）
 */
function appAutoResearchNext_(ctx, via) {
  const t0 = new Date().getTime();
  appStoreForget_();   // 同じ実行の中で書いた表も読み直す（続きのときは、終わった A-4 の記録を数える）
  const now = appAutoResearchNow_();
  const nowMs = now.getTime();
  const nowIso = appAutoResearchIso_(now);
  const night = Utilities.formatDate(now, APP_TZ, 'yyyy-MM-dd');
  const hour = Number(Utilities.formatDate(now, APP_TZ, 'HH'));
  const extra = {};
  const finish = (status, reason, more, error) => {
    const res = Object.assign({ via: via, status: status, reason: reason || '' }, extra, more || {});
    appAutoResearchTryUpdate_(st => {
      if (via === 'TICK') st.lastTickAt = nowIso;
      st.lastTick = { at: nowIso, via: via, status: status, reason: reason || '', planId: res.planId || '' };
    }, 'LAST_TICK');
    appRunLog_({ requestId: ctx.requestId, kind: 'AUTO.RESEARCH', status: status, durationMs: new Date().getTime() - t0, detail: res, error: error || '' });
    return res;
  };
  if (!appAutoResearchEnabled_()) return finish('SKIPPED', 'DISABLED');
  // 始めてよいのは 4 時から 7 時より前まで（3 時台のバックアップと手入れとは、ロックを取り合わないように時間を分ける）
  if (hour < APP_AUTO_RESEARCH_HOUR) return finish('SKIPPED', 'BEFORE_HOURS');
  if (hour >= APP_AUTO_RESEARCH_END_HOUR) return finish('SKIPPED', 'AFTER_HOURS');
  if (appAutoResearchMaintenancePending_(now)) return finish('SKIPPED', 'MAINTENANCE_PENDING');
  const st = appAutoResearchState_();
  const count = st.night && st.night.date === night ? Number(st.night.count || 0) : 0;
  if (count >= APP_AUTO_RESEARCH_MAX_PER_NIGHT) return finish('SKIPPED', 'NIGHT_LIMIT', { count: count });
  const busy = appAutoResearchBusy_();
  if (busy) return finish('SKIPPED', 'BUSY', { busyKind: busy.kind });
  const plans = appAutoResearchPlans_(appFy_(now));
  if (st.chain) {
    // 前に自動で始めた A-4 が、終わりの知らせなしに止まっていた（1 回の上限で打ち切られた・状態を書けなかったなど）。
    // 始めた後に A-4 の記録があれば終わっていた（知らせだけが届かなかった）。無ければ止まったとして控える
    const c = st.chain;
    const p = plans.filter(x => x.planId === c.planId)[0];
    const result = p && p.lastAt >= new Date(c.startedAt).getTime() ? 'DONE' : 'STALLED';
    appAutoResearchTryUpdate_(s => { if (s.chain && s.chain.jobId === c.jobId) { s.chain = null; appAutoResearchNote_(s, c.planId, result, nowMs); } }, 'STALLED');
    if (result === 'STALLED') extra.stalled = c.planId;
  }
  const tried = appAutoResearchState_().tried || {};
  const due = appAutoResearchStale_(plans, nowMs).filter(p => {
    const t = tried[p.planId];
    return !(t && nowMs - new Date(t.at).getTime() < APP_AUTO_RESEARCH_RETRY_DAYS * 864e5);
  });
  if (!due.length) return finish('SKIPPED', 'NO_STALE_PLAN');
  // 古い順に、始められる計画を探す。準備ができていない・権限が足りない計画は控えて（3 日あける）次へ（準備を確かめるのは 20 計画まで）
  let pick = null;
  const notReady = [];
  const denied = [];
  let checks = 0;
  for (let i = 0; i < due.length && !pick && checks < APP_AUTO_RESEARCH_READY_CHECKS; i++) {
    const p = due[i];
    // 画面から始めるときと同じ役割を確かめる（裏の実行でも appRunJob_ がもう一度確かめる）
    if (!appHasRole_(ctx.roles, appJobMinRole_(appJobSpec_('PLAN.RUN'), { planId: p.planId, action: 'AI.RESEARCH' }), p.clientId)) { denied.push(p.planId); continue; }
    checks++;
    const r = appAutoResearchReady_(p.planId);
    if (r.ok) pick = p; else notReady.push({ planId: p.planId, reason: r.reason });
  }
  if (notReady.length) extra.notReady = notReady;
  if (denied.length) extra.denied = denied;
  if (notReady.length || denied.length) {
    appAutoResearchTryUpdate_(s => {
      notReady.forEach(n => appAutoResearchNote_(s, n.planId, 'NOT_READY', nowMs, n.reason, false));
      denied.forEach(id => appAutoResearchNote_(s, id, 'DENIED', nowMs, '', false));
    }, 'NOT_READY');
  }
  if (!pick) return notReady.length ? finish('SKIPPED', 'NOT_READY') : finish('SKIPPED', 'DENIED', { planId: denied[0] });
  let started;
  try {
    started = appStartJob_(ctx, { kind: 'PLAN.RUN', payload: { planId: pick.planId, action: 'AI.RESEARCH' } }, { auto: true });   // 手で始める回数には数えない
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    appAutoResearchTryUpdate_(s => appAutoResearchNote_(s, pick.planId, 'START_FAILED', nowMs, msg), 'START_FAILED');
    return finish('FAILED', 'START_FAILED', { planId: pick.planId }, msg);
  }
  appAutoResearchTryUpdate_(s => {
    s.chain = { jobId: started.jobId, planId: pick.planId, requestedBy: ctx.actor, startedAt: nowIso };
    s.lastStartedPlan = { planId: pick.planId, clientName: pick.clientName, fy: pick.fy, jobId: started.jobId, at: nowIso, via: via };
    s.night = { date: night, count: count + 1 };
    appAutoResearchNote_(s, pick.planId, 'STARTED', nowMs, '', false);
  }, 'STARTED');
  return finish('STARTED', '', { planId: pick.planId, fy: pick.fy, jobId: started.jobId,
    lastAt: pick.lastAt ? appAutoResearchIso_(new Date(pick.lastAt)) : '' });
}

/** 続きの処理をたどった、最初の処理の ID */
function appAutoResearchRootOf_(job) {
  let cur = job;
  for (let hop = 0; hop < 100 && cur && cur.parentId; hop++) cur = appJobGet_(cur.parentId);
  return cur ? cur.id : '';
}

/**
 * 裏の処理が続きなしで終わったとき（Jobs.js の appRunJob_ から。DONE か FAILED）。
 * 自動で始めた A-4 なら結果を控え、7 時より前なら次に古い計画を始める（頼んだ人は同じ）。
 * 普通の処理の結果には関係しない（呼ぶ側で例外を握りつぶす）。自動の A-4 でなければ、状態を 1 回読むだけで戻る。
 * 結果を書けなかったときは、印（chain）だけでも外して戻る（続きは始めない。次の日の回から続ける）
 */
function appAutoResearchAfterJob_(job, status) {
  if (!job || job.nextJobId) return null;
  const chain = appAutoResearchState_().chain;
  if (!chain || job.requestedBy !== chain.requestedBy) return null;
  const p = job.payload || {};
  if (p.action !== 'AI.RESEARCH' || p.planId !== chain.planId || appAutoResearchRootOf_(job) !== chain.jobId) return null;
  const now = appAutoResearchNow_();
  const result = status === 'DONE' ? 'DONE' : 'FAILED';
  const error = result === 'FAILED' ? String(job.error || '') : '';
  const mine = appAutoResearchTryUpdate_(st => {
    if (!st.chain || st.chain.jobId !== chain.jobId) return false;   // ほかの実行が先に控えた
    st.chain = null;
    appAutoResearchNote_(st, chain.planId, result, now.getTime(), error);
    const sp = st.lastStartedPlan && st.lastStartedPlan.planId === chain.planId ? st.lastStartedPlan : {};
    st.lastResult = { at: appAutoResearchIso_(now), planId: chain.planId, clientName: sp.clientName || '', fy: sp.fy || '', status: result,
      jobId: chain.jobId, error: appAutoResearchGist_(error, APP_AUTO_RESEARCH_ERROR_CHARS) };
    return true;
  }, 'FINISHED');
  if (mine === undefined) {
    appAutoResearchTryUpdate_(st => { if (st.chain && st.chain.jobId === chain.jobId) st.chain = null; }, 'CHAIN_CLEAR');
    return null;
  }
  if (!mine) return null;
  appRunLog_({ requestId: job.id, kind: 'AUTO.RESEARCH', status: result, detail: { via: 'JOB', event: 'FINISHED', planId: chain.planId, jobId: chain.jobId, lastJobId: job.id },
    error: error });
  return appAutoResearchNext_(appJobContext_(job), 'CHAIN');
}

// ---- トリガー ----

/** トリガーを確かめた控え: { date, installed, reason, schedule } */
function appAutoResearchChecked_() {
  try { return JSON.parse(appProps_().getProperty(APP_AUTO_RESEARCH_CHECKED_PROP) || 'null'); } catch (e) { return null; }
}

/**
 * 毎日のトリガー（triggerAutoResearch、4 時半ごろ）が無ければ作る（何度呼んでも 1 つ）。確かめるのは 1 日 1 回だけ（日付を控える）。
 * 毎日の手入れと、所有者が画面を開いたときに呼ぶ。止めるスイッチが切ってあるときと、トリガーの上限（20）に余裕が無いときは作らない。
 * 控えの時刻の版が今と違う（前の版の 1 時ごろのトリガー）ときは、その日のうちでも、あるトリガーを全部消して作り直す（1 回だけ）。
 * 作る・消すのはロックの中で（同じ日に 2 つの実行が同時に確かめても二重に作らない）。今の版のトリガーが 1 つあるだけの日はロックを取らない
 */
function appEnsureAutoResearchTrigger_(ctx) {
  if (!appIsSetUp_()) return { checked: false, reason: 'NOT_SET_UP' };
  const props = appProps_();
  const today = appToday_();
  // 今日もう確かめた（今の版で。途中で止まった日も、その日のうちはやり直さない）
  const doneToday = c => !!c && c.date === today && (c.schedule === APP_AUTO_RESEARCH_SCHEDULE || c.reason === 'CHECKING');
  const mark = (installed, reason, schedule) => {
    props.setProperty(APP_AUTO_RESEARCH_CHECKED_PROP, JSON.stringify({ date: today, installed: !!installed, reason: reason || '', schedule: schedule }));
  };
  const mineOf = all => all.filter(t => t.getHandlerFunction() === APP_AUTO_RESEARCH_HANDLER);
  const prev = appAutoResearchChecked_();
  if (doneToday(prev)) return { checked: false, reason: 'CHECKED_TODAY', installed: !!prev.installed };
  if (prev && prev.schedule === APP_AUTO_RESEARCH_SCHEDULE && mineOf(ScriptApp.getProjectTriggers()).length === 1) {
    mark(true, '', APP_AUTO_RESEARCH_SCHEDULE);
    return { checked: true, installed: true, created: false };
  }
  return appWithLock_(() => {
    const cur = appAutoResearchChecked_();   // ロックを待つ間に、ほかの実行が確かめたかもしれない
    if (doneToday(cur)) return { checked: false, reason: 'CHECKED_TODAY', installed: !!cur.installed };
    const migrate = !(cur && cur.schedule === APP_AUTO_RESEARCH_SCHEDULE);
    mark(cur && cur.installed, 'CHECKING', cur ? cur.schedule : undefined);   // 先に控える（途中で失敗しても、その日のうちは開くたびにやり直さない）
    const all = ScriptApp.getProjectTriggers();
    const mine = mineOf(all);
    const drop = migrate ? mine : mine.slice(1);   // 前の版の時刻のトリガーは全部、今の版なら二重にできていた分を消す
    drop.forEach(t => ScriptApp.deleteTrigger(t));
    const replaced = migrate ? drop.length : 0;
    if (!migrate && mine.length) { mark(true, '', APP_AUTO_RESEARCH_SCHEDULE); return { checked: true, installed: true, created: false, removed: drop.length }; }
    if (!appAutoResearchEnabled_()) {
      mark(false, 'DISABLED', APP_AUTO_RESEARCH_SCHEDULE);
      return { checked: true, installed: false, created: false, reason: 'DISABLED', removed: drop.length };
    }
    if (all.length - drop.length + 1 + APP_AUTO_RESEARCH_TRIGGER_SPARE > APP_TRIGGER_LIMIT) {
      mark(false, 'TRIGGER_LIMIT', APP_AUTO_RESEARCH_SCHEDULE);
      appRunLog_({ requestId: ctx && ctx.requestId, kind: 'AUTO.RESEARCH.TRIGGER', status: 'SKIPPED', detail: { reason: 'TRIGGER_LIMIT', triggers: all.length - drop.length, replaced: replaced } });
      return { checked: true, installed: false, created: false, reason: 'TRIGGER_LIMIT', removed: drop.length };
    }
    ScriptApp.newTrigger(APP_AUTO_RESEARCH_HANDLER).timeBased().everyDays(1).atHour(APP_AUTO_RESEARCH_HOUR).nearMinute(APP_AUTO_RESEARCH_MINUTE).create();
    mark(true, '', APP_AUTO_RESEARCH_SCHEDULE);
    appRunLog_({ requestId: ctx && ctx.requestId, kind: 'AUTO.RESEARCH.TRIGGER', status: 'CREATED',
      detail: { hour: APP_AUTO_RESEARCH_HOUR, minute: APP_AUTO_RESEARCH_MINUTE, schedule: APP_AUTO_RESEARCH_SCHEDULE, replaced: replaced, by: ctx && ctx.actor } });
    return { checked: true, installed: true, created: true, replaced: replaced };
  });
}

/** 画面を開いたとき（doGet）: 所有者なら、トリガーを確かめる（1 日 1 回だけ。失敗しても画面は開く） */
function appAutoResearchOnOpen_(ctx) {
  if (!ctx || !ctx.user || !ctx.user.isOwner) return;
  try { appEnsureAutoResearchTrigger_(ctx); } catch (e) { Logger.log('自動の AI 調査のトリガー: ' + (e && e.message ? e.message : e)); }
}

// ---- 状態（ホームの仕組みの状態） ----

/**
 * 自動の AI 調査の状態: { enabled, schedule, trigger, lastTickAt, lastTick, lastStartedPlan, lastResult, running, failures7d, stalePlans }
 * stalePlans = 最後の A-4 から 7 日を過ぎた対象の計画（古い順）と、自動で最後に試した結果（準備ができていない理由など）。
 * 状態と理由の印には、画面の名前（statusLabel・reasonLabel・viaLabel）を添える
 */
function appAutoResearchStatus_() {
  const st = appAutoResearchState_();
  const now = appAutoResearchNow_();
  const nowMs = now.getTime();
  const fy = appFy_(now);
  const L = appAutoResearchLabel_;
  let plans = null;
  try { plans = appCachedRead_('AUTO_RESEARCH\u0001' + fy, () => appAutoResearchPlans_(fy)); } catch (e) { plans = null; }
  const tried = st.tried || {};
  const trig = appAutoResearchChecked_();
  const chain = st.chain && nowMs - new Date(st.chain.startedAt).getTime() < 2 * 3600 * 1000 ? st.chain : null;   // 2 時間より前のものは止まったとみなす
  const lastTick = st.lastTick ? Object.assign({}, st.lastTick, { statusLabel: L(st.lastTick.status), reasonLabel: L(st.lastTick.reason), viaLabel: L(st.lastTick.via) }) : null;
  const lastResult = st.lastResult ? Object.assign({}, st.lastResult, { statusLabel: L(st.lastResult.status) }) : null;
  const lastStartedPlan = st.lastStartedPlan ? Object.assign({}, st.lastStartedPlan, { viaLabel: L(st.lastStartedPlan.via) }) : null;
  return {
    enabled: appAutoResearchEnabled_(),
    schedule: { hour: APP_AUTO_RESEARCH_HOUR, minute: APP_AUTO_RESEARCH_MINUTE, endHour: APP_AUTO_RESEARCH_END_HOUR,
      label: '毎日 ' + APP_AUTO_RESEARCH_HOUR + ':' + ('0' + APP_AUTO_RESEARCH_MINUTE).slice(-2) + ' ごろ（毎日の手入れの後）から ' + APP_AUTO_RESEARCH_END_HOUR + ' 時まで' },
    trigger: trig ? { installed: !!trig.installed, checkedOn: trig.date || '', reason: trig.reason || '', reasonLabel: L(trig.reason),
      current: trig.schedule === APP_AUTO_RESEARCH_SCHEDULE } : null,
    lastTickAt: st.lastTickAt || '',
    lastTick: lastTick,
    lastStartedPlan: lastStartedPlan,
    lastResult: lastResult,
    running: chain ? { planId: chain.planId, jobId: chain.jobId, startedAt: chain.startedAt } : null,
    failures7d: (st.fails || []).filter(t => nowMs - Number(t) <= 7 * 864e5).length,
    stalePlans: plans === null ? null : appAutoResearchStale_(plans, nowMs).map(p => ({ planId: p.planId, clientName: p.clientName, fy: p.fy,
      lastAt: p.lastAt ? appAutoResearchIso_(new Date(p.lastAt)) : '',
      lastTry: tried[p.planId] ? { at: tried[p.planId].at, status: tried[p.planId].status, statusLabel: L(tried[p.planId].status),
        reason: tried[p.planId].reason || '', reasonLabel: L(tried[p.planId].reason) } : null }))
  };
}
