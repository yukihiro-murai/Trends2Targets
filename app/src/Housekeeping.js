/**
 * Housekeeping.js — 毎日の手入れと、監査の鎖の全期間の確かめ。
 *
 * 毎日 3 時ごろのバックアップの後に動かす（triggerDailyBackup）。どれも消さない（古いものはアーカイブのフォルダへ移す）。
 *   ① 古い処理の記録（UserProperties）と、使われていないトリガーを片付ける
 *   ② 監査の鎖を、全部の月で確かめる（月と月のつなぎも）。締まった月の最後のハッシュを、データ本体（AUDIT_ANCHORS）に控える
 *   ③ 開始だけで終わりの記録が無い操作（途中で止まった操作）を数える
 *   ④ 前の年度より古いログのファイルを、アーカイブのフォルダへ移す
 *   ⑤ その月の最初のバックアップを、月次としてアーカイブのフォルダに残す
 *   ⑥ データ本体の表を整える（使っていない空の行を減らす・手で書き換えないよう警告つきで保護・タブの色）
 * 結果は実行ログ（RUN）と、状態の画面に出す控え（APP_HOUSEKEEPING）に残す。
 * 定期の処理（triggerDailyBackup）で異常があった日は、管理者へメールを送る（Notifications.js。正常な日は送らない）。
 */
const APP_HOUSEKEEPING_PROP = 'APP_HOUSEKEEPING';   // 自動の AI 調査（AutoResearch.js）は、この控えの at と durationMs で、その日の手入れが終わったかを見る
const APP_OPEN_START_GRACE_MS = 15 * 60 * 1000;

/** ログのファイルの一覧（年度の古い順）: [{ fy, id }] */
function appLogFileList_() {
  let files = {};
  try { files = JSON.parse(appProps_().getProperty(APP_PROP.logFiles) || '{}') || {}; } catch (e) { files = {}; }
  return Object.keys(files).filter(k => /^FY\d{4}$/.test(k)).sort().map(k => ({ fy: Number(k.slice(2)), id: files[k] }));
}

/** 監査のある月の一覧（古い順）: [{ month: 'yyyy_MM', sheet }] */
function appAuditSheets_(kind) {
  const out = [];
  appLogFileList_().forEach(f => {
    let ss;
    try { ss = appOpenLogFile_(f.id); } catch (e) { out.push({ month: 'FY' + f.fy, error: 'ログのファイルを開けません' }); return; }
    ss.getSheets().map(s => s.getName()).filter(n => new RegExp('^' + (kind || 'AUDIT') + '_\\d{4}_\\d{2}$').test(n)).sort()
      .forEach(n => out.push({ month: n.slice(-7), sheet: ss.getSheetByName(n) }));
  });
  return out.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

/**
 * 監査の鎖を全部の月で確かめる。各月の中のつながりとハッシュ、月の最初の prev_hash が前の月の最後と同じか、
 * 最後の月の最後が控えの最新ハッシュと同じか、締まった月が控え（AUDIT_ANCHORS）と同じか
 */
/**
 * quick = true なら、今月と先月だけを全部の行で確かめ、それより前の控えのある月は、行の数・最初の prev_hash・最後のハッシュだけを見る
 * （毎日の手入れ。全部の行は週に 1 回）。控えの無い月は、いつも全部の行で確かめる
 */
function appVerifyAuditAll_(quick) {
  const anchors = {};
  try { appReadTable_('AUDIT_ANCHORS').forEach(a => { anchors[a.month] = a; }); } catch (e) { /* 表がまだ無い */ }
  const months = [];
  let prevLast = null;
  let ok = true;
  const now = new Date();
  const recent = Utilities.formatDate(new Date(now.getFullYear(), now.getMonth() - 1, 1), APP_TZ, 'yyyy_MM');
  appAuditSheets_('AUDIT').forEach(m => {
    if (m.error) { months.push({ month: m.month, ok: false, note: m.error }); ok = false; return; }
    const v = quick && anchors[m.month] && m.month < recent ? appAuditSheetEnds_(m.sheet) : appVerifyAuditSheet_(m.sheet);
    const r = { month: m.month, rows: v.rows, ok: v.ok, brokenAt: v.brokenAt, lastHash: v.lastHash, firstPrev: v.firstPrev, note: v.ok ? '' : v.brokenAt + ' 行目で鎖が切れている' };
    if (v.ok && v.rows && prevLast !== null && v.firstPrev !== prevLast) { r.ok = false; r.note = '前の月の最後とつながっていない'; }
    const a = anchors[m.month];
    if (a && (String(a.last_hash) !== String(v.lastHash) || Number(a.rows) !== v.rows)) { r.ok = false; r.note = '締めの控え（' + a.rows + ' 行）と違う（書き換え・切り詰めの疑い）'; }
    r.anchored = !!a;
    if (v.rows) prevLast = v.lastHash;
    if (!r.ok) ok = false;
    months.push(r);
  });
  const latest = String(appProps_().getProperty(APP_PROP.auditLastHash) || '');
  const matchesLatest = prevLast === null || prevLast === latest;
  if (!matchesLatest) ok = false;
  return { ok: ok, months: months, matchesLatest: matchesLatest, rows: months.reduce((s, m) => s + (m.rows || 0), 0), checkedAt: appNowIso_(), quick: !!quick };
}

/** 月の監査シートの、行の数・最初の prev_hash・最後のハッシュだけ（全部の行を読まない） */
function appAuditSheetEnds_(sh) {
  const columns = APP_LOG_TABLES.AUDIT;
  const last = sh.getLastRow();
  if (last < 2) return { rows: 0, ok: true, brokenAt: 0, firstPrev: '', lastHash: '' };
  const ip = columns.indexOf('prev_hash'), ih = columns.indexOf('row_hash');
  const first = sh.getRange(2, 1, 1, columns.length).getValues()[0].map(String);
  const end = sh.getRange(last, 1, 1, columns.length).getValues()[0].map(String);
  const ok = appSha256Hex_(end[ip] + '\n' + JSON.stringify(end.slice(0, ip))) === end[ih];
  return { rows: last - 1, ok: ok, brokenAt: ok ? 0 : last, firstPrev: first[ip], lastHash: end[ih] };
}

/** 締まった月（今月より前）で、確かめて正しかった月の最後のハッシュを控える（すでに控えた月はそのまま） */
function appAnchorClosedMonths_(ctx, verify) {
  const cur = Utilities.formatDate(new Date(), APP_TZ, 'yyyy_MM');
  const have = {};
  appReadTable_('AUDIT_ANCHORS').forEach(a => { have[a.month] = true; });
  const rows = verify.months.filter(m => m.ok && m.rows && m.month < cur && !have[m.month])
    .map(m => ({ month: m.month, rows: String(m.rows), first_prev: m.firstPrev, last_hash: m.lastHash, anchored_at: appNowIso_(), anchored_by: ctx.actor }));
  if (rows.length) appInsertRows_('AUDIT_ANCHORS', rows);
  return rows.map(r => r.month);
}

/** 開始だけで終わりの記録が無い操作（今月と先月。始まってから 15 分より前のもの） */
function appOpenStarts_() {
  const now = new Date();
  const cutoff = now.getTime() - APP_OPEN_START_GRACE_MS;
  const cols = APP_LOG_TABLES.AUDIT;
  const ir = cols.indexOf('request_id'), ip = cols.indexOf('phase'), ia = cols.indexOf('action'), it = cols.indexOf('occurred_at'), iu = cols.indexOf('actor_email');
  const starts = {}, ends = {};
  [new Date(now.getFullYear(), now.getMonth() - 1, 1), now].forEach(m => {
    let ss = null;
    try { ss = appLogSpreadsheet_(m, 'read'); } catch (e) { ss = null; }
    const sh = ss && ss.getSheetByName('AUDIT_' + Utilities.formatDate(m, APP_TZ, 'yyyy_MM'));
    if (!sh || sh.getLastRow() < 2) return;
    sh.getRange(2, 1, sh.getLastRow() - 1, cols.length).getValues().forEach(r => {
      const key = String(r[ir]) + '\u0001' + String(r[ia]);
      if (String(r[ip]) === 'START') starts[key] = { requestId: String(r[ir]), action: String(r[ia]), at: String(r[it]), actor: String(r[iu]) };
      if (String(r[ip]) === 'END') ends[key] = true;
    });
  });
  return Object.keys(starts).filter(k => !ends[k] && new Date(starts[k].at).getTime() < cutoff).map(k => starts[k])
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** 前の年度より古いログのファイルを、アーカイブのフォルダへ移す（消さない。移しても読める） */
function appArchiveOldLogs_() {
  const keepFrom = appFy_(new Date()) - 1;
  const archiveId = appProps_().getProperty(APP_PROP.archiveFolderId);
  if (!archiveId) return [];
  const archive = DriveApp.getFolderById(archiveId);
  const moved = [];
  appLogFileList_().filter(f => f.fy < keepFrom).forEach(f => {
    try {
      const file = DriveApp.getFileById(f.id);
      const inArchive = (() => { const it = file.getParents(); while (it.hasNext()) { if (it.next().getId() === archiveId) return true; } return false; })();
      if (!inArchive) { file.moveTo(archive); moved.push('FY' + f.fy); }
    } catch (e) { Logger.log('ログのファイルを移せません: ' + (e && e.message ? e.message : e)); }
  });
  return moved;
}

/** その月の月次のバックアップが無ければ、データ本体の写しをアーカイブのフォルダに作る（消さない） */
function appMonthlyBackup_() {
  const props = appProps_();
  const archiveId = props.getProperty(APP_PROP.archiveFolderId);
  const dataId = props.getProperty(APP_PROP.dataId);
  if (!archiveId || !dataId) return '';
  const ym = Utilities.formatDate(new Date(), APP_TZ, 'yyyy-MM');
  const name = APP_FILES.monthlyBackupPrefix + ym;
  const folder = DriveApp.getFolderById(archiveId);
  // 改名の前の名前（APP_FILES_LEGACY）で今月の写しを作っていれば、それで足りる
  for (const n of [name].concat(APP_FILES_LEGACY.monthlyBackupPrefixes.map(p => p + ym))) {
    const it = folder.getFilesByName(n);
    while (it.hasNext()) { if (!it.next().isTrashed()) return ''; }
  }
  DriveApp.getFileById(dataId).makeCopy(name, folder);
  return name;
}

/** 毎日の手入れ。どの手入れが失敗しても、ほかは続ける。結果を控えて返す */
function appHousekeeping_(ctx) {
  const t0 = new Date().getTime();
  const res = { at: appNowIso_(), steps: {}, problems: [] };
  const step = (name, fn) => {
    try { res.steps[name] = fn(); } catch (e) { res.steps[name] = { error: String(e && e.message ? e.message : e) }; res.problems.push(name + ': ' + res.steps[name].error); }
  };
  step('jobs', () => {
    const before = appJobList_().length;
    appWithLock_(() => { appCleanupJobs_(); appExpireQueuedJobs_(); });
    return { before: before, after: appJobList_().length };
  });
  step('audit', () => {
    const v = appVerifyAuditAll_(new Date().getDay() !== 0);   // 日曜は全部の行で確かめる
    if (!v.ok) res.problems.push('監査の鎖: ' + v.months.filter(m => !m.ok).map(m => m.month + ' ' + m.note).join(' / ') + (v.matchesLatest ? '' : '（最新のハッシュと合わない）'));
    const anchored = v.ok ? appWithLock_(() => appAnchorClosedMonths_(ctx, v)) : [];
    return { ok: v.ok, months: v.months.length, rows: v.rows, anchored: anchored };
  });
  step('openStarts', () => {
    const o = appOpenStarts_();
    if (o.length) res.problems.push('途中で止まった操作 ' + o.length + ' 件');
    return { count: o.length, samples: o.slice(0, 5) };
  });
  step('errors', () => ({ last24h: appRecentLogRows_('ERROR', 24 * 3600 * 1000).length }));
  step('archive', () => ({ moved: appArchiveOldLogs_() }));
  step('dataBook', () => appWithLock_(() => appOrganizeDataBook_()));
  step('monthly', () => ({ created: appMonthlyBackup_() }));
  step('journal', () => ({ pending: appJournalPending_() }));
  res.durationMs = new Date().getTime() - t0;
  res.ok = !res.problems.length;
  const keep = { at: res.at, ok: res.ok, problems: res.problems.slice(0, 10).map(p => String(p).slice(0, 200)),
    audit: res.steps.audit && { ok: res.steps.audit.ok, months: res.steps.audit.months, rows: res.steps.audit.rows, anchored: res.steps.audit.anchored, error: res.steps.audit.error },
    openStarts: res.steps.openStarts && res.steps.openStarts.count, errors: res.steps.errors && res.steps.errors.last24h,
    monthly: res.steps.monthly, archive: res.steps.archive, durationMs: res.durationMs };
  // 1 つの値の上限は約 9KB（バイト数）。超えるときは、問題の文を短くする
  let text = JSON.stringify(keep);
  if (appUtf8Bytes_(text) > 8000) { keep.problems = keep.problems.slice(0, 3).map(p => p.slice(0, 60)); text = JSON.stringify(keep); }
  try { appProps_().setProperty(APP_HOUSEKEEPING_PROP, text); } catch (e) { Logger.log('手入れの結果を控えられません: ' + (e && e.message ? e.message : e)); }
  appRunLog_({ requestId: ctx.requestId, kind: 'HOUSEKEEPING', status: res.ok ? 'OK' : 'PROBLEMS', durationMs: res.durationMs, detail: res });
  return res;
}

/**
 * 毎日の処理: バックアップ → 手入れ → 異常があれば管理者へメール（Notifications.js）。
 * バックアップが失敗しても手入れと知らせは動かし、最後にバックアップの失敗を投げ直す（トリガーの実行は FAILED になる）。
 * 手入れが失敗してもバックアップの結果は返す。手で動かす入口（apiRunBackup・apiRunHousekeeping）からはメールを送らない。
 */
function appDailyMaintenance_(ctx) {
  let backup = null, backupError = null;
  try { backup = appBackup_(ctx); } catch (e) { backupError = e; appLogError_('BACKUP', e, ctx); }
  let housekeeping;
  try { housekeeping = appHousekeeping_(ctx); } catch (e) { housekeeping = { error: String(e && e.message ? e.message : e) }; appLogError_('HOUSEKEEPING', e, ctx); }
  const st = housekeeping.steps || {};
  const codes = [];
  if (backupError) codes.push('BACKUP');
  if (housekeeping.error || housekeeping.ok === false) codes.push('HOUSEKEEPING');
  if (st.audit && (st.audit.error || st.audit.ok === false)) codes.push('AUDIT');
  if (st.openStarts && st.openStarts.count > 0) codes.push('OPEN_STARTS');
  if (st.journal && st.journal.pending) codes.push('JOURNAL');
  if (st.errors && st.errors.last24h > 0) codes.push('ERRORS');
  let notify;
  try { notify = appNotifyMaintenance_(ctx, codes); }
  catch (e) { notify = { status: 'FAILED', reason: 'exception', sent: 0 }; Logger.log('管理への知らせに失敗しました'); }
  // 自動の AI 調査（AutoResearch.js）の毎日のトリガーが無ければ作る。失敗しても毎日の処理は続ける
  let autoResearch;
  try { autoResearch = appEnsureAutoResearchTrigger_(ctx); }
  catch (e) { autoResearch = { error: String(e && e.message ? e.message : e) }; appLogError_('AUTO.RESEARCH.TRIGGER', e, ctx); }
  const res = { backup: backup, housekeeping: { ok: housekeeping.ok, problems: housekeeping.problems, error: housekeeping.error }, notify: notify,
    autoResearch: autoResearch };
  if (backupError) throw backupError;
  return res;
}

function appHousekeepingLast_() {
  try { return JSON.parse(appProps_().getProperty(APP_HOUSEKEEPING_PROP) || 'null'); } catch (e) { return null; }
}

// ---- ログを読む（画面の「操作の記録」）----

/** ある種類のログの、ある月の行（新しい順）。q は人・操作・対象・エラーで絞る。planId で計画を絞る */
function appLogRows_(kind, month, q, planId, limit) {
  const cols = APP_LOG_TABLES[kind];
  if (!cols) throw new Error('ログの種類が不明です: ' + kind);
  const m = /^(\d{4})_(\d{2})$/.exec(String(month || ''));
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, 1) : new Date();
  let ss = null;
  try { ss = appLogSpreadsheet_(d, 'read'); } catch (e) { ss = null; }
  const sh = ss && ss.getSheetByName(kind + '_' + Utilities.formatDate(d, APP_TZ, 'yyyy_MM'));
  if (!sh || sh.getLastRow() < 2) return [];
  const qq = String(q || '').trim().toLowerCase();
  const out = [];
  sh.getRange(2, 1, sh.getLastRow() - 1, cols.length).getValues().forEach(r => {
    const o = {};
    cols.forEach((c, j) => { o[c] = String(r[j]); });
    if (planId && o.plan_id !== planId && o.entity_id !== planId && String(o.detail_json || '').indexOf(planId) < 0) return;
    if (qq && JSON.stringify(o).toLowerCase().indexOf(qq) < 0) return;
    out.push(o);
  });
  const t = kind === 'AUDIT' ? 'occurred_at' : kind === 'RUN' ? 'finished_at' : 'occurred_at';
  out.sort((a, b) => (a[t] < b[t] ? 1 : a[t] > b[t] ? -1 : 0));
  return out.slice(0, limit || 500);
}

/** ここ ms の間のログの行（今月と先月から） */
function appRecentLogRows_(kind, ms) {
  const now = new Date();
  const since = now.getTime() - ms;
  const t = kind === 'RUN' ? 'finished_at' : 'occurred_at';
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return [prev, now].map(d => appLogRows_(kind, Utilities.formatDate(d, APP_TZ, 'yyyy_MM'), '', '', 5000)).reduce((a, b) => a.concat(b), [])
    .filter(o => new Date(o[t]).getTime() >= since);
}

/** 画面: ログの月の一覧と、選んだ月の行 */
function appLogList_(input) {
  const kind = ['AUDIT', 'RUN', 'ERROR'].indexOf(String(input && input.kind)) >= 0 ? String(input.kind) : 'AUDIT';
  const months = appAuditSheets_(kind).filter(m => !m.error).map(m => m.month).reverse();
  const month = String(input && input.month || '') || months[0] || Utilities.formatDate(new Date(), APP_TZ, 'yyyy_MM');
  return { kind: kind, months: months, month: month, rows: appLogRows_(kind, month, input && input.query, input && input.planId, Math.min(2000, Number(input && input.limit) || 1000)) };
}
