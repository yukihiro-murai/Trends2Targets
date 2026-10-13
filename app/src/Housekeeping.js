/**
 * Housekeeping.js — 毎日の手入れと、監査の鎖の全期間の確かめ。
 *
 * 毎日 3 時ごろのバックアップ（triggerDailyBackup）の数分後に、別の実行（裏の処理 SYSTEM.HOUSEKEEPING）で動かす（2026-10-13〜。
 * 前はバックアップと同じ 1 回の実行（6 分）に入れていて、打ち切られると結果も知らせも残らなかった）。どれも消さない（古いものはアーカイブのフォルダへ移す）。
 *   ① 古い処理の記録（UserProperties）と、使われていないトリガーを片付ける
 *   ② 監査の鎖を、全部の月で確かめる（月と月のつなぎも）。全部の行を確かめるのは今月・先月・控えの無い月と、その日の番に当たる月（7 日で一巡）。
 *      締まった月の最後のハッシュを、データ本体（AUDIT_ANCHORS）に控える
 *   ③ 開始だけで終わりの記録が無い操作（途中で止まった操作）を数える
 *   ④ 前の年度より古いログのファイルを、アーカイブのフォルダへ移す
 *   ⑤ その月の最初のバックアップを、月次としてアーカイブのフォルダに残す
 *   ⑥ データ本体の表を整える（使っていない空の行を減らす・手で書き換えないよう警告つきで保護・タブの色）
 * 始めたときに「始めた」の印、終わったら結果を、控え（APP_HOUSEKEEPING）に残す（結果は実行ログ RUN にも）。
 * 定期の処理で異常があった日は、管理者へメールを送る（Notifications.js。正常な日は送らない）。
 */
const APP_HOUSEKEEPING_PROP = 'APP_HOUSEKEEPING';   // 手入れの印と結果（始めたら state: RUNNING、終わったら DONE。自動の AI 調査・ホームが見る）
const APP_HOUSEKEEPING_STALE_MS = 10 * 60 * 1000;   // 始めたままこれだけたったら、途中で止まったとみなす（1 回の実行の上限は 6 分）
const APP_HOUSEKEEPING_DELAY_MS = 2 * 60 * 1000;    // 毎日のバックアップの後、手入れ（裏の処理）を動かすまで（バックアップの実行の後片付けとロックを取り合わない）
const APP_HOUSEKEEPING_MISSED_MS = 30 * 3600 * 1000;   // 最後に手入れを始めてからこれだけたっていたら、裏の処理が動かなかったとみなし、バックアップの実行で続けて動かす
const APP_AUDIT_CYCLE_DAYS = 7;                     // 控えのある前の月も、全部の行をこの日数で一巡して確かめる（1 日に全体の 1/7 ずつ）
const APP_AUDIT_FULL_BUDGET_MS = 3 * 60 * 1000;     // その日の番の月を全部の行で確かめる時間の上限（過ぎたら端だけにして、見送った月を要確認に出す）
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
 * 最後の月の最後が控えの最新ハッシュと同じか、締まった月が控え（AUDIT_ANCHORS）と同じか。
 * quick でなければ（apiVerifyAudit・所有者の verifyAudit）、全部の月を全部の行で確かめる（今までどおり）。
 * quick = true なら（毎日の手入れ）、今月・先月・控えの無い月は全部の行で確かめ、それより前の控えのある月は、行の数・最初の prev_hash・最後のハッシュだけを見る。
 * ただし控えのある月も、その日の番に当たる月（appAuditTurn_）は全部の行で確かめる。どの月も APP_AUDIT_CYCLE_DAYS 日で一巡する
 * （前は日曜にまとめて全部の月を全部の行で確かめていて、月が増えると 1 回の実行の上限 6 分に収まらなくなる）。
 * その日の番の月でも、確かめ始めてから時間の上限（appAuditFullBudgetMs_）を過ぎたら端だけにし、deferred に返す（呼んだ側が要確認に出す）。
 * 返り値に fullMonths（quick のとき、その日の番で全部の行を確かめた控えのある月）・deferred・cycleDays を足す
 */
function appVerifyAuditAll_(quick) {
  const t0 = new Date().getTime();
  const anchors = {};
  try { appReadTable_('AUDIT_ANCHORS').forEach(a => { anchors[a.month] = a; }); } catch (e) { /* 表がまだ無い */ }
  const months = [];
  const fullMonths = [];
  const deferred = [];
  let prevLast = null;
  let ok = true;
  const now = new Date();
  const recent = Utilities.formatDate(new Date(now.getFullYear(), now.getMonth() - 1, 1), APP_TZ, 'yyyy_MM');
  const turn = appAuditTurn_(now);
  appAuditSheets_('AUDIT').forEach(m => {
    if (m.error) { months.push({ month: m.month, ok: false, note: m.error }); ok = false; return; }
    let full = !quick || !anchors[m.month] || m.month >= recent;
    if (!full && appAuditMonthTurn_(m.month) === turn) {
      if (new Date().getTime() - t0 <= appAuditFullBudgetMs_()) { full = true; fullMonths.push(m.month); } else deferred.push(m.month);
    }
    const v = full ? appVerifyAuditSheet_(m.sheet) : appAuditSheetEnds_(m.sheet);
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
  return { ok: ok, months: months, matchesLatest: matchesLatest, rows: months.reduce((s, m) => s + (m.rows || 0), 0), checkedAt: appNowIso_(), quick: !!quick,
    fullMonths: fullMonths, deferred: deferred, cycleDays: APP_AUDIT_CYCLE_DAYS };
}

/** その日（日本時間）の番: 1970-01-01 からの日の数を APP_AUDIT_CYCLE_DAYS で割った余り */
function appAuditTurn_(now) {
  const day = Math.floor((now.getTime() + 9 * 3600 * 1000) / 864e5);
  return ((day % APP_AUDIT_CYCLE_DAYS) + APP_AUDIT_CYCLE_DAYS) % APP_AUDIT_CYCLE_DAYS;
}

/** 月（'yyyy_MM'）の番: 年 × 12 + 月 を APP_AUDIT_CYCLE_DAYS で割った余り（続く月は続く番になるので、どの続く 7 日にも全部の月が 1 回ずつ当たる） */
function appAuditMonthTurn_(month) {
  const n = Number(String(month).slice(0, 4)) * 12 + Number(String(month).slice(5, 7)) - 1;
  return ((n % APP_AUDIT_CYCLE_DAYS) + APP_AUDIT_CYCLE_DAYS) % APP_AUDIT_CYCLE_DAYS;
}

/** その日の番の月を全部の行で確かめる時間の上限（テストで差し替える） */
function appAuditFullBudgetMs_() { return APP_AUDIT_FULL_BUDGET_MS; }

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

/**
 * その月の月次のバックアップが無ければ、データ本体の写しをアーカイブのフォルダに作る（消さない）。
 * 写しは毎日のバックアップと同じく、ロックの中で書きかけの保存を書き終えてから取る（書き終えられなければ取らずに止め、次の日にもう一度試す。Backup.js の appCopyDataBook_）
 */
function appMonthlyBackup_(ctx) {
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
  appCopyDataBook_(ctx, name, folder);
  return name;
}

/**
 * 毎日の手入れ。どの手入れが失敗しても、ほかは続ける。結果を控えて返す。via: 'JOB'（毎日の裏の処理）・'INLINE'（バックアップの実行の中）・'MANUAL'（手で動かす入口）。
 * 始める前に「始めた」の印を控え（appHousekeepingBegin_）、終わったら結果で上書きする（appHousekeepingFinish_）。
 * 1 回の実行の上限（6 分）で打ち切られると「始めた」の印が残るので、ホーム・状態の点検・次の手入れ（要確認と知らせ）で気づける
 */
function appHousekeeping_(ctx, via) {
  const t0 = new Date().getTime();
  const begun = appHousekeepingBegin_(via);
  const res = { at: begun.mark.at, via: begun.mark.via, steps: {}, problems: [] };
  if (begun.stalled) res.problems.push('前回の手入れ（' + begun.stalled + ' に始めた）が途中で止まっていました（終わりの記録がありません）');
  const step = (name, fn) => {
    try { res.steps[name] = fn(); } catch (e) { res.steps[name] = { error: String(e && e.message ? e.message : e) }; res.problems.push(name + ': ' + res.steps[name].error); }
  };
  step('jobs', () => {
    const before = appJobList_().length;
    appWithLock_(() => { appCleanupJobs_(); appExpireQueuedJobs_(); });
    return { before: before, after: appJobList_().length };
  });
  step('audit', () => {
    // 毎日: 今月・先月・控えの無い月は全部の行で、控えのある前の月は端と控えで確かめる。控えのある月も、その日の番に当たる月は全部の行で（7 日で一巡）
    const v = appVerifyAuditAll_(true);
    if (!v.ok) res.problems.push('監査の鎖: ' + v.months.filter(m => !m.ok).map(m => m.month + ' ' + m.note).join(' / ') + (v.matchesLatest ? '' : '（最新のハッシュと合わない）'));
    if (v.deferred.length) res.problems.push('監査の鎖: 時間が足りず、全部の行の確認を ' + v.deferred.length + ' か月見送りました（' + v.deferred.join('・') + '。端と締めの控えは確かめました）');
    const anchored = v.ok ? appWithLock_(() => appAnchorClosedMonths_(ctx, v)) : [];
    return { ok: v.ok, months: v.months.length, rows: v.rows, anchored: anchored, full: v.fullMonths, deferred: v.deferred, cycleDays: v.cycleDays };
  });
  step('openStarts', () => {
    const o = appOpenStarts_();
    if (o.length) res.problems.push('途中で止まった操作 ' + o.length + ' 件');
    return { count: o.length, samples: o.slice(0, 5) };
  });
  step('errors', () => ({ last24h: appRecentLogRows_('ERROR', 24 * 3600 * 1000).length }));
  step('archive', () => ({ moved: appArchiveOldLogs_() }));
  step('dataBook', () => appWithLock_(() => appOrganizeDataBook_()));
  step('monthly', () => ({ created: appMonthlyBackup_(ctx) }));
  step('journal', () => ({ pending: appJournalPending_() }));
  res.durationMs = new Date().getTime() - t0;
  res.ok = !res.problems.length;
  appHousekeepingFinish_(res);
  appRunLog_({ requestId: ctx.requestId, kind: 'HOUSEKEEPING', status: res.ok ? 'OK' : 'PROBLEMS', durationMs: res.durationMs, detail: res });
  return res;
}

/**
 * 手入れを始めた印を控える: { state: 'RUNNING', at（= startedAt）, startedAt, via, lastDoneAt（前に終わった時刻） }。
 * 前の印が「始めたまま 10 分を過ぎた」なら、その時刻を stalled で返す（前回は途中で止まった）。控えられなくても手入れは続ける
 */
function appHousekeepingBegin_(via) {
  const prev = appHousekeepingLast_();
  const at = appNowIso_();
  const mark = { state: 'RUNNING', at: at, startedAt: at, via: String(via || 'MANUAL') };
  const lastDoneAt = appHousekeepingDoneAt_(prev);
  if (lastDoneAt) mark.lastDoneAt = lastDoneAt;
  const stalled = appHousekeepingStalled_(prev, new Date()) ? String(prev.startedAt || prev.at) : '';
  try { appProps_().setProperty(APP_HOUSEKEEPING_PROP, JSON.stringify(mark)); } catch (e) { Logger.log('手入れを始めた印を控えられません: ' + (e && e.message ? e.message : e)); }
  return { mark: mark, stalled: stalled };
}

/** 手入れの結果で印を上書きする: { state: 'DONE', at, startedAt, finishedAt, via, ok, problems, audit, … }（1 つの値の上限は約 9KB） */
function appHousekeepingFinish_(res) {
  const a = res.steps.audit;
  const keep = { state: 'DONE', at: res.at, startedAt: res.at, finishedAt: appNowIso_(), via: res.via, ok: res.ok, problems: res.problems.slice(0, 10).map(p => String(p).slice(0, 200)),
    audit: a && { ok: a.ok, months: a.months, rows: a.rows, anchored: a.anchored, full: a.full, deferred: a.deferred, error: a.error },
    openStarts: res.steps.openStarts && res.steps.openStarts.count, errors: res.steps.errors && res.steps.errors.last24h,
    monthly: res.steps.monthly, archive: res.steps.archive, durationMs: res.durationMs };
  // 超えるときは、問題の文と月の一覧を短くする
  let text = JSON.stringify(keep);
  if (appUtf8Bytes_(text) > 8000) {
    keep.problems = keep.problems.slice(0, 3).map(p => p.slice(0, 60));
    if (keep.audit) { keep.audit.full = (keep.audit.full || []).length; keep.audit.deferred = (keep.audit.deferred || []).length; }
    text = JSON.stringify(keep);
  }
  try { appProps_().setProperty(APP_HOUSEKEEPING_PROP, text); } catch (e) { Logger.log('手入れの結果を控えられません: ' + (e && e.message ? e.message : e)); }
}

/** 手入れの印（無ければ null）。前の版の形（state が無い: 始めた時刻 at と、かかった時間 durationMs の結果）もそのまま返す */
function appHousekeepingLast_() {
  try { return JSON.parse(appProps_().getProperty(APP_HOUSEKEEPING_PROP) || 'null'); } catch (e) { return null; }
}

/** 印の、手入れを始めた時刻（ミリ秒。読めなければ NaN） */
function appHousekeepingStartMs_(hk) {
  return hk && typeof hk === 'object' ? new Date(hk.startedAt || hk.at).getTime() : NaN;
}

/** 最後に手入れが終わった時刻（ISO。無ければ ''）。始めたままの印は、その前に終わった時刻（lastDoneAt）。前の版の形は at + durationMs */
function appHousekeepingDoneAt_(hk) {
  if (!hk || typeof hk !== 'object') return '';
  if (hk.state === 'RUNNING') return String(hk.lastDoneAt || '');
  if (hk.finishedAt) return String(hk.finishedAt);
  const t = new Date(hk.at).getTime();
  return isFinite(t) ? Utilities.formatDate(new Date(t + (Number(hk.durationMs) || 0)), APP_TZ, "yyyy-MM-dd'T'HH:mm:ssZ") : '';
}

/** 始めたまま止まったか（始めて 10 分を過ぎても終わりの記録が無い。1 回の実行の上限は 6 分なので、もう動いていない） */
function appHousekeepingStalled_(hk, now) {
  const start = appHousekeepingStartMs_(hk);
  return !!hk && hk.state === 'RUNNING' && isFinite(start) && now.getTime() - start > APP_HOUSEKEEPING_STALE_MS;
}

/**
 * その日（now の日本時間の日付）の手入れが済んだか（自動の AI 調査が、手入れとロックを取り合わないように待つ。AutoResearch.js）。
 * 済んだ = その日に始めた手入れが終わって graceMs たった。または、その日に始めた手入れが始めたまま止まった（もう動いていないので待たない。
 * 止まったことはホームと状態の点検に出て、次の手入れが要確認として知らせる）。
 * その日の手入れがまだ始まっていない・動いている・終わったばかりなら、済んでいない。前の版の形（始めた時刻 at とかかった時間 durationMs）も読む
 */
function appHousekeepingSettled_(hk, now, graceMs) {
  const start = appHousekeepingStartMs_(hk);
  if (!isFinite(start)) return false;
  if (Utilities.formatDate(new Date(start), APP_TZ, 'yyyy-MM-dd') !== Utilities.formatDate(now, APP_TZ, 'yyyy-MM-dd')) return false;
  if (hk.state === 'RUNNING') return appHousekeepingStalled_(hk, now);
  const end = new Date(appHousekeepingDoneAt_(hk)).getTime();
  return isFinite(end) && now.getTime() >= end + (Number(graceMs) || 0);
}

/** ホームと状態の点検に出す手入れの印: 印に stalled（始めたまま止まった）と lastDoneAt（最後に終わった時刻）を足したもの（無ければ null） */
function appHousekeepingStatus_() {
  const hk = appHousekeepingLast_();
  if (!hk || typeof hk !== 'object') return null;
  return Object.assign({}, hk, { stalled: appHousekeepingStalled_(hk, new Date()), lastDoneAt: appHousekeepingDoneAt_(hk) });
}

/** 手入れの結果から、知らせる異常の種類（Notifications.js の APP_MAINTENANCE_CODE_LABELS） */
function appHousekeepingCodes_(hk) {
  const st = (hk && hk.steps) || {};
  const codes = [];
  if (!hk || hk.error || hk.ok === false) codes.push('HOUSEKEEPING');
  if (st.audit && (st.audit.error || st.audit.ok === false)) codes.push('AUDIT');
  if (st.openStarts && st.openStarts.count > 0) codes.push('OPEN_STARTS');
  if (st.journal && st.journal.pending) codes.push('JOURNAL');
  if (st.errors && st.errors.last24h > 0) codes.push('ERRORS');
  return codes;
}

/** 前の手入れが始まらないまま 1 日を過ぎたか（最後に始めてから 30 時間。印が無い新しい環境は false） */
function appHousekeepingMissed_(hk, now) {
  const start = appHousekeepingStartMs_(hk);
  return isFinite(start) && now.getTime() - start > APP_HOUSEKEEPING_MISSED_MS;
}

/**
 * 毎日の手入れを、別の実行（裏の処理 SYSTEM.HOUSEKEEPING。1 回だけ動くトリガーで数分後）として待ち行列に入れる。頼んだ人は所有者。
 * 返り値 { jobId }（入れた・もう入っていた）か { reason }（入れなかった。呼んだ側がこの実行で続けて動かす）:
 *   MISSED … 前の手入れが始まらないまま 1 日を過ぎた（裏の処理が動かなかった。止まりっぱなしにしないよう、この実行で動かす）
 *   TRIGGER_LIMIT … トリガーの上限（20）にもう 1 つの余裕が無い（裏の処理の分として空けてある枠を使う。ほかの裏の処理と同じ）
 *   NO_OWNER・FAILED … 所有者が分からない・入れられなかった
 */
function appScheduleHousekeeping_(ctx) {
  try {
    if (appHousekeepingMissed_(appHousekeepingLast_(), new Date())) return { reason: 'MISSED' };
    const owner = String((ctx && ctx.user && ctx.user.owner) || '').trim().toLowerCase();
    if (!owner) return { reason: 'NO_OWNER' };
    return appWithLock_(() => {
      appExpireQueuedJobs_();   // 始まらずに 15 分たった処理は止まったとみなす（前の日の手入れが残っていても、二重とは数えない）
      const queued = appJobList_().filter(j => j.kind === 'SYSTEM.HOUSEKEEPING' && (j.status === 'QUEUED' || (j.status === 'RUNNING' && !appJobIsStale_(j))))[0];
      if (queued) return { jobId: queued.id, already: true };
      if (ScriptApp.getProjectTriggers().length + 1 > APP_TRIGGER_LIMIT) return { reason: 'TRIGGER_LIMIT' };
      return { jobId: appEnqueueJob_('SYSTEM.HOUSEKEEPING', {}, owner, '', APP_HOUSEKEEPING_DELAY_MS).id };
    });
  } catch (e) {
    appLogError_('HOUSEKEEPING.SCHEDULE', e, ctx);
    return { reason: 'FAILED', error: String(e && e.message ? e.message : e) };
  }
}

/** 毎日の手入れ（裏の処理 SYSTEM.HOUSEKEEPING の中身。Jobs.js）。異常があれば管理者へ知らせる。返り値は短い形（処理の結果に置く） */
function appHousekeepingJob_(ctx) {
  let hk;
  try { hk = appHousekeeping_(ctx, 'JOB'); } catch (e) { hk = { error: String(e && e.message ? e.message : e) }; appLogError_('HOUSEKEEPING', e, ctx); }
  let notify;
  try { notify = appNotifyMaintenance_(ctx, appHousekeepingCodes_(hk)); }
  catch (e) { notify = { status: 'FAILED', reason: 'exception', sent: 0 }; Logger.log('管理への知らせに失敗しました'); }
  return { ok: hk.ok, problems: hk.problems, error: hk.error, durationMs: hk.durationMs, notify: notify };
}

/**
 * 毎日の処理（triggerDailyBackup、3 時ごろ）: バックアップ → 手入れを別の実行として待ち行列に入れる → 異常があれば管理者へメール（Notifications.js）。
 * 手入れ（監査の鎖の確かめ・月次の写しなど）は、バックアップと同じ 1 回の実行（6 分）に入れると打ち切られることがあるので、
 * 裏の処理（SYSTEM.HOUSEKEEPING。数分後に 1 回だけ動くトリガー）で動かし、手入れの異常の知らせもそこで送る。
 * 入れられなかった・前の手入れが始まらないまま 1 日を過ぎたときは、この実行で続けて動かす（止まりっぱなしにしない）。
 * バックアップが失敗しても手入れと知らせは動かし、最後にバックアップの失敗を投げ直す（トリガーの実行は FAILED になる）。
 * 手入れが失敗してもバックアップの結果は返す。手で動かす入口（apiRunBackup・apiRunHousekeeping）からはメールを送らない。
 */
function appDailyMaintenance_(ctx) {
  let backup = null, backupError = null;
  try { backup = appBackup_(ctx); } catch (e) { backupError = e; appLogError_('BACKUP', e, ctx); }
  const codes = backupError ? ['BACKUP'] : [];
  const plan = appScheduleHousekeeping_(ctx);
  let housekeeping;
  if (plan.jobId) {
    housekeeping = { scheduled: true, jobId: plan.jobId, already: !!plan.already };
  } else {
    let hk;
    try { hk = appHousekeeping_(ctx, 'INLINE'); } catch (e) { hk = { error: String(e && e.message ? e.message : e) }; appLogError_('HOUSEKEEPING', e, ctx); }
    appHousekeepingCodes_(hk).forEach(c => codes.push(c));
    housekeeping = { inline: true, reason: plan.reason, ok: hk.ok, problems: hk.problems, error: hk.error };
  }
  let notify;
  try { notify = appNotifyMaintenance_(ctx, codes); }
  catch (e) { notify = { status: 'FAILED', reason: 'exception', sent: 0 }; Logger.log('管理への知らせに失敗しました'); }
  // 自動の AI 調査（AutoResearch.js）の毎日のトリガーが無ければ作る。失敗しても毎日の処理は続ける
  let autoResearch;
  try { autoResearch = appEnsureAutoResearchTrigger_(ctx); }
  catch (e) { autoResearch = { error: String(e && e.message ? e.message : e) }; appLogError_('AUTO.RESEARCH.TRIGGER', e, ctx); }
  const res = { backup: backup, housekeeping: housekeeping, notify: notify, autoResearch: autoResearch };
  if (backupError) throw backupError;
  return res;
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
