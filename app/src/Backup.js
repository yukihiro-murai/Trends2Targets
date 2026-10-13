/**
 * Backup.js — データ本体のバックアップ。毎日 3 時ごろ「バックアップ」フォルダへ複製し、新しい 14 世代を残す。
 * それより古い世代は「アーカイブ」フォルダへ移す（消さない・ゴミ箱にも送らない。2026-10-05 村井さん承認）。
 * アーカイブのフォルダが決まっていない・開けないときは、複製を作る前に止める（作ってから移せないと、残すはずのものを失う）。
 * スタンドアロンのアプリなので、データ本体を複製してもスクリプトは複製されない。
 * 写しは保存と同じロックの中で取り、書きかけの保存があれば先に書き終える（書き終えられなければ写さない。appCopyDataBook_。2026-10-13）。
 * バックアップした後に、フォルダの要点（世代の数・最新の名前と時刻）を所有者の UserProperties に残す（置き場は Store.js の appProps_）。
 * ホームはドライブを数えずにこれを読む（appBackupStatusFast_）。毎日のバックアップが有効かは残さず、毎回トリガーを見る。
 * 状態の点検（apiHealth）は今までどおりドライブを数える。
 * 毎日のバックアップのトリガーは、所有者が画面を開いたとき（確かめるのは 1 日 1 回）に、無ければ作る（2026-10-07 村井さん承認。appEnsureBackupTrigger_）。
 * 止めるとき: Script Properties の BACKUP_AUTO_ENABLE を 'false' にする（自動では作らない。あるトリガーはそのまま）。
 */
const APP_BACKUP_STATUS_PROP = 'APP_BACKUP_STATUS';
const APP_BACKUP_STATUS_TTL_SEC = 300;   // 要点がまだ無いとき、ドライブを数えた結果を控える時間（今までのホームと同じ 5 分）
const APP_BACKUP_AUTO_CHECKED_PROP = 'APP_BACKUP_AUTO_CHECKED';   // トリガーを確かめた日（日本時間）と結果（1 日 1 回だけ確かめる）
const APP_BACKUP_AUTO_SWITCH = 'BACKUP_AUTO_ENABLE';              // 'false' で、トリガーを自動では作らない

function appBackupFiles_() {
  const folderId = appProps_().getProperty(APP_PROP.backupFolderId);
  if (!folderId) return [];
  const it = DriveApp.getFolderById(folderId).getFilesByType(MimeType.GOOGLE_SHEETS);
  const files = [];
  while (it.hasNext()) {
    const f = it.next();
    // フォルダの一覧にはゴミ箱へ移したファイルも出るので除く
    // 改名の前の名前（APP_FILES_LEGACY）で作った世代も数えて、古いものから順にアーカイブへ移す
    const n = f.getName();
    if (!f.isTrashed() && [APP_FILES.backupPrefix].concat(APP_FILES_LEGACY.backupPrefixes).some(p => n.indexOf(p) === 0)) files.push(f);
  }
  return files.sort((a, b) => b.getDateCreated().getTime() - a.getDateCreated().getTime());
}

/**
 * データ本体の写しを、保存と同じロック（appWithLock_）の中で作る（保存の途中を写さない）。返り値 { copy, recovered, pending }。
 * 書きかけの保存の控え（Journal.js）があれば、写す前に控えのとおりに書き終える（保存の前と同じ appJournalRecover_。何度書いても同じ結果）。
 * 書き終えられないとき（控えが読めない・締めた年度の計画など）は写さずに止める: 写しには書きかけの印（APP_WRITE_JOURNAL）が無いので、
 * 戻すと表どうしが食い違ったまま気づけない。前の世代はそのまま残り、次の機会（翌日・手で取り直す）にもう一度試す。
 * opts.allowPending: 書き終えられなくても写す（表の列を足す移行の前の写しだけ。移行は見出しに列を足すだけで書きかけの行には触らず、
 * 控えは移行の後に書き終える。ここで止めると、列を足す前の表に書く控えが書けないまま、移行も始められなくなる）。そのときは pending に控えの要点を返す
 */
function appCopyDataBook_(ctx, name, folder, opts) {
  const dataId = appProps_().getProperty(APP_PROP.dataId);
  if (!dataId) throw new Error('初期設定がまだです。');
  return appWithLock_(() => {
    let recovered = null, pending = null;
    if (appJournalPending_()) {
      try {
        recovered = appJournalRecover_(ctx);
      } catch (e) {
        const p = appJournalPending_() || {};
        if (!(opts && opts.allowPending)) {
          throw new Error('データ本体の保存が途中で止まっていて（' + (p.label || '保存') + '）、続きを書けません。書きかけのまま写すと、戻したときに表どうしが食い違うので、写しを取りませんでした: ' +
            String(e && e.message ? e.message : e));
        }
        pending = { id: p.id || '', label: p.label || '', planId: p.planId || '', at: p.at || '' };
      }
    }
    SpreadsheetApp.flush();
    return { copy: DriveApp.getFileById(dataId).makeCopy(name, folder), recovered: recovered, pending: pending };
  });
}

/** バックアップ（毎日のトリガー・所有者の runBackup・表の列を足す移行の前）。写しはロックの中で取る（appCopyDataBook_）。opts は appCopyDataBook_ と同じ */
function appBackup_(ctx, opts) {
  const props = appProps_();
  const dataId = props.getProperty(APP_PROP.dataId);
  const folderId = props.getProperty(APP_PROP.backupFolderId);
  if (!dataId || !folderId) throw new Error('初期設定がまだです。');
  const archiveId = props.getProperty(APP_PROP.archiveFolderId);
  if (!archiveId) throw new Error('アーカイブのフォルダがまだありません。管理者が「初期設定」を実行してください。');
  // 複製を作る前にアーカイブのフォルダを確かめる（無ければここで止まり、複製も古い世代の移動もしない）
  const archive = DriveApp.getFolderById(archiveId);
  const started = new Date();
  const name = APP_FILES.backupPrefix + Utilities.formatDate(started, APP_TZ, 'yyyy-MM-dd HHmm');
  const made = appCopyDataBook_(ctx, name, DriveApp.getFolderById(folderId), opts);
  const copy = made.copy;
  // 古い世代をアーカイブへ移すのはロックの外（ドライブの移動だけで、データ本体には触らない）
  const files = appBackupFiles_();
  const old = files.slice(APP_BACKUP_KEEP);
  let moved = 0;
  try {
    old.forEach(f => { f.moveTo(archive); moved++; });   // 移せなければ例外。ゴミ箱への代替はしない（「消さない」の約束）
  } finally {
    // 途中で止まっても、作った複製と残っている数を残す。最新は作った複製（作った直後の一覧にはまだ出ないことがあるので、出ていなければ数に足す）
    const listed = files.some(f => f.getId() === copy.getId());
    appBackupRecordStatus_(files.length - moved + (listed ? 0 : 1), copy);
  }
  const res = { backup: copy.getName(), archived: old.map(f => f.getName()), keep: APP_BACKUP_KEEP };
  if (made.recovered) res.recovered = { journalId: made.recovered.id, label: made.recovered.label };   // 写す前に書き終えた保存
  if (made.pending) res.journalPending = made.pending;   // 書きかけのまま写した（移行の前の写しだけ）
  appRunLog_({ requestId: ctx.requestId, kind: 'BACKUP', startedAt: Utilities.formatDate(started, APP_TZ, "yyyy-MM-dd'T'HH:mm:ssZ"),
    durationMs: new Date().getTime() - started.getTime(), status: 'OK', detail: res });
  return res;
}

/**
 * 今日（日本時間）のバックアップ（無ければ null）。名前の日付（appBackup_ が付ける）か、作った日で見る。
 * 表の列を足す移行（Setup.js の appMigrateColumns_）の前に確かめる（ドライブを数える）
 */
function appBackupToday_() {
  const today = appToday_();
  return appBackupFiles_().filter(f => f.getName().indexOf(APP_FILES.backupPrefix + today) === 0 ||
    Utilities.formatDate(f.getDateCreated(), APP_TZ, 'yyyy-MM-dd') === today)[0] || null;
}

/** 毎日のバックアップのトリガーがあるか */
function appBackupEnabled_() {
  return ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'triggerDailyBackup');
}

/**
 * バックアップのフォルダの要点を UserProperties に残す（count = 残っている世代の数、latest = 一番新しいファイル）。失敗してもバックアップは止めない。
 * 毎日のバックアップが有効かは残さない（アプリの外でトリガーを消すと古くなるので、読むときに見る）
 */
function appBackupRecordStatus_(count, latest) {
  try {
    appProps_().setProperty(APP_BACKUP_STATUS_PROP, JSON.stringify({ count: count, latest: latest ? latest.getName() : '',
      latestAt: latest ? latest.getDateCreated().getTime() : 0, at: appNowIso_() }));
  } catch (e) { Logger.log('バックアップの要点を残せません: ' + (e && e.message ? e.message : e)); }
}

/** バックアップの状態（ドライブを数える。状態の点検で使う） */
function appBackupStatus_() {
  const files = appBackupFiles_();
  const enabled = appBackupEnabled_();
  const latestAt = files.length ? files[0].getDateCreated().getTime() : 0;
  return { enabled: enabled, count: files.length, latest: files.length ? files[0].getName() : '',
    ageHours: latestAt ? Math.round((new Date().getTime() - latestAt) / 36e5) : null, keep: APP_BACKUP_KEEP };
}

/**
 * バックアップの状態（appBackupStatus_ と同じ形）を、バックアップしたときに残した要点から返す（ドライブを数えない。ホームで使う）。
 * 要点がまだ無い（この版になってからバックアップしていない）ときだけ、今までどおりドライブを数え、5 分控える。
 * 「有効」はどちらでも毎回トリガーを見る（getProjectTriggers の 1 回。アプリの外でトリガーを消しても、すぐに「無効」と出す）
 */
function appBackupStatusFast_() {
  let s = null;
  try { s = JSON.parse(appProps_().getProperty(APP_BACKUP_STATUS_PROP) || 'null'); } catch (e) { s = null; }
  if (s && typeof s === 'object') {
    const latestAt = Number(s.latestAt) || 0;
    return { enabled: appBackupEnabled_(), count: Number(s.count) || 0, latest: String(s.latest || ''),
      ageHours: latestAt ? Math.round((new Date().getTime() - latestAt) / 36e5) : null, keep: APP_BACKUP_KEEP };
  }
  const cache = CacheService.getScriptCache();
  let hit = null;
  try { hit = JSON.parse(cache.get('HOME_SYS') || 'null'); } catch (e) { /* 控えが読めなければ数える */ }
  if (hit && typeof hit === 'object' && !hit.error) return Object.assign(hit, { enabled: appBackupEnabled_() });   // 前の版が控えた失敗は使わない
  const st = appBackupStatus_();
  try { cache.put('HOME_SYS', JSON.stringify(st), APP_BACKUP_STATUS_TTL_SEC); } catch (e) { /* 控えは速くするためだけ */ }
  return st;
}

/** 毎日のバックアップを有効にする（すでにあれば何もしない） */
function appEnableBackup_() {
  const already = appBackupEnabled_();
  if (!already) ScriptApp.newTrigger('triggerDailyBackup').timeBased().everyDays(1).atHour(APP_BACKUP_HOUR).create();
  return { enabled: true, already: already };
}

/** 止めるスイッチ: Script Properties の BACKUP_AUTO_ENABLE が 'false'（か '0'）なら、トリガーを自動では作らない。無ければ作る */
function appBackupAutoEnabled_() {
  const v = String(appProps_().getProperty(APP_BACKUP_AUTO_SWITCH) || '').trim().toLowerCase();
  return v !== 'false' && v !== '0';
}

/** トリガーを確かめた控え: { date, installed, reason } */
function appBackupAutoChecked_() {
  try { return JSON.parse(appProps_().getProperty(APP_BACKUP_AUTO_CHECKED_PROP) || 'null'); } catch (e) { return null; }
}

/**
 * 毎日のバックアップのトリガー（triggerDailyBackup、3 時ごろ）が無ければ作る（2026-10-07 村井さん承認。管理の画面の「毎日自動にする」は v0.27.0 で外した）。
 * 所有者が画面を開いたときに呼ぶ。確かめるのは 1 日 1 回だけ（日付を控える）。トリガーがあれば何もしない（ロックも取らない。あるトリガーには触らない）。
 * 作るのはロックの中で、控えとトリガーを確かめ直してから（2 つのタブが同時に開いても二重に作らない）。作り方は appEnableBackup_ と同じ。
 * 止めるスイッチ（BACKUP_AUTO_ENABLE）が切ってあるときと、トリガーの上限（20）に裏の処理の分の余裕が無いときは作らない（自動の AI 調査と同じ）。
 * 作った・作れなかったときは実行ログ（RUN、種類 BACKUP.ENSURE）に残す。バックアップそのものはここでは取らない（画面を開くのが遅くなる。3 時ごろのトリガーが取る）
 */
function appEnsureBackupTrigger_(ctx) {
  if (!appIsSetUp_()) return { checked: false, reason: 'NOT_SET_UP' };
  if (!appBackupAutoEnabled_()) return { checked: false, reason: 'DISABLED' };
  const props = appProps_();
  const today = appToday_();
  const doneToday = c => !!c && c.date === today;
  const mark = (installed, reason) => {
    props.setProperty(APP_BACKUP_AUTO_CHECKED_PROP, JSON.stringify({ date: today, installed: !!installed, reason: reason || '' }));
  };
  const prev = appBackupAutoChecked_();
  if (doneToday(prev)) return { checked: false, reason: 'CHECKED_TODAY', installed: !!prev.installed };
  if (appBackupEnabled_()) { mark(true, ''); return { checked: true, installed: true, created: false }; }
  return appWithLock_(() => {
    const cur = appBackupAutoChecked_();   // ロックを待つ間に、ほかの実行が確かめたかもしれない
    if (doneToday(cur)) return { checked: false, reason: 'CHECKED_TODAY', installed: !!cur.installed };
    mark(false, 'CHECKING');   // 先に控える（途中で止まっても、その日のうちは開くたびにやり直さない）
    let triggers = 0;
    try {
      const all = ScriptApp.getProjectTriggers();
      triggers = all.length;
      if (all.some(t => t.getHandlerFunction() === 'triggerDailyBackup')) { mark(true, ''); return { checked: true, installed: true, created: false }; }
      if (triggers + 1 + APP_AUTO_RESEARCH_TRIGGER_SPARE > APP_TRIGGER_LIMIT) {
        mark(false, 'TRIGGER_LIMIT');
        appRunLog_({ requestId: ctx && ctx.requestId, kind: 'BACKUP.ENSURE', status: 'SKIPPED', detail: { reason: 'TRIGGER_LIMIT', triggers: triggers } });
        return { checked: true, installed: false, created: false, reason: 'TRIGGER_LIMIT' };
      }
      appEnableBackup_();
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      mark(false, 'FAILED');   // 次の日に確かめ直す
      appRunLog_({ requestId: ctx && ctx.requestId, kind: 'BACKUP.ENSURE', status: 'FAILED', detail: { reason: 'FAILED', triggers: triggers }, error: msg });
      return { checked: true, installed: false, created: false, reason: 'FAILED', error: msg };
    }
    mark(true, '');
    appRunLog_({ requestId: ctx && ctx.requestId, kind: 'BACKUP.ENSURE', status: 'CREATED', detail: { hour: APP_BACKUP_HOUR, by: ctx && ctx.actor } });
    return { checked: true, installed: true, created: true };
  });
}

/** 画面を開いたとき（doGet）: 所有者なら、毎日のバックアップのトリガーを確かめる（1 日 1 回だけ。失敗しても画面は開く） */
function appBackupOnOpen_(ctx) {
  if (!ctx || !ctx.user || !ctx.user.isOwner) return;
  try { appEnsureBackupTrigger_(ctx); } catch (e) { Logger.log('毎日のバックアップのトリガー: ' + (e && e.message ? e.message : e)); }
}

/**
 * ホームに出す、自動で作る仕組みの状態（トリガーが無いときだけ。画面が文を選ぶ）: { off（止めるスイッチ）, checkedOn, checkedToday, reason }
 * checkedToday: 今日（日本時間）はもう確かめた。その日のうちは所有者が開いても確かめ直さないので、自動で作るのは次の日以降になる
 */
function appBackupAutoStatus_() {
  const c = appBackupAutoChecked_();
  const on = c && c.date ? String(c.date) : '';
  return { off: !appBackupAutoEnabled_(), checkedOn: on, checkedToday: !!on && on === appToday_(), reason: c && c.reason ? String(c.reason) : '' };
}
