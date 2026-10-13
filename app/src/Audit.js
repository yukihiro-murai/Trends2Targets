/**
 * Audit.js — 操作の記録（監査ログ）・実行ログ・エラーログ。記録先は年度ごとの「Trends2Targets_Logs_FYyyyy」（年度は始まりの年で呼ぶ）。
 * 月ごとのシート AUDIT_yyyy_MM / RUN_yyyy_MM / ERROR_yyyy_MM に追記だけする（上書き・削除しない）。
 * 監査は row_hash = SHA-256(prev_hash + 改行 + 行の内容) の鎖でつなぎ、最新のハッシュを所有者の UserProperties に控える（置き場は Store.js の appProps_）。
 * 書き込み・実行は開始を記録できなければ行わない（fail-closed）。消さない（前の年度より古いログはアーカイブのフォルダへ移す。Housekeeping.js）。
 */
/**
 * その年度のログのファイル。mode='write' なら無いときに作る（年度が替わった最初の記録で自動的に新しいファイルになる）。
 * mode='read' なら無いときは null（読むだけで作らない）。
 */
function appLogSpreadsheet_(now, mode) {
  const props = appProps_();
  appEnsureFyNaming_();
  const fyKey = 'FY' + appFy_(now);
  let files = {};
  try { files = JSON.parse(props.getProperty(APP_PROP.logFiles) || '{}') || {}; } catch (e) { files = {}; }
  if (files[fyKey]) return SpreadsheetApp.openById(files[fyKey]);  // 開けなければ例外（記録できないので処理も止まる）
  if (mode === 'read') return null;
  const folderId = props.getProperty(APP_PROP.folderId);
  if (!folderId) throw new Error('ログの置き場所がまだありません。管理者が「初期設定」を実行してください。');
  const ss = SpreadsheetApp.create(APP_FILES.logPrefix + fyKey);
  DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(folderId));
  files[fyKey] = ss.getId();
  props.setProperty(APP_PROP.logFiles, JSON.stringify(files));
  return ss;
}

/**
 * ログのファイル名を「始まりの年で呼ぶ年度」にそろえる（一度だけ）。
 * 2026-10-01 に作ったログは終わりの年で名付けていた（FY2027 = 2026/04〜2027/03）ので、キーとファイル名を 1 年ずらす。
 * 何も作っていない新しい環境では、印を付けるだけ。ロックの中で印を確かめ直し、二重にずらさない。
 */
function appEnsureFyNaming_() {
  const props = appProps_();
  if (props.getProperty(APP_PROP.fyNaming) === 'start') return;
  appWithLock_(() => {
    if (props.getProperty(APP_PROP.fyNaming) === 'start') return;
    let files = {};
    try { files = JSON.parse(props.getProperty(APP_PROP.logFiles) || '{}') || {}; } catch (e) { files = {}; }
    const next = {};
    Object.keys(files).forEach(k => {
      const m = /^FY(\d{4})$/.exec(k);
      const nk = m ? 'FY' + (Number(m[1]) - 1) : k;
      next[nk] = files[k];
      try { DriveApp.getFileById(files[k]).setName(APP_FILES.logPrefix + nk); } catch (e) {
        Logger.log('ログのファイル名を直せません: ' + (e && e.message ? e.message : e));
      }
    });
    props.setProperty(APP_PROP.logFiles, JSON.stringify(next));
    props.setProperty(APP_PROP.fyNaming, 'start');
  });
}

/** ログのファイルを ID で開く（年度の一覧から全期間を読むとき） */
function appOpenLogFile_(id) {
  return SpreadsheetApp.openById(id);
}

/** その月のログのシート。無ければ作る（新しいファイルに最初からある空のシートは消す）。列が違えば止める */
function appLogSheet_(kind, now) {
  const columns = APP_LOG_TABLES[kind];
  const ss = appLogSpreadsheet_(now, 'write');
  const name = kind + '_' + Utilities.formatDate(now, APP_TZ, 'yyyy_MM');
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, columns.length).setNumberFormat('@').setValues([columns]);
    sh.setFrozenRows(1);
    ss.getSheets().forEach(s => {
      if (s.getName() !== name && s.getLastRow() === 0 && /^(シート|Sheet)\d+$/.test(s.getName())) ss.deleteSheet(s);
    });
    return sh;
  }
  const head = sh.getRange(1, 1, 1, columns.length).getValues()[0].map(String);
  if (head.join('|') !== columns.join('|')) throw new Error('ログの列が想定と違います（' + name + '）。');
  return sh;
}

function appLogWrite_(sh, row) {
  const r = sh.getLastRow() + 1;
  if (r > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 1000);
  sh.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
}

/** 監査に 1 行足し、鎖を伸ばす。書けなければ例外 */
function appAuditAppend_(e) {
  return appWithLock_(() => {
    const now = new Date();
    const sh = appLogSheet_('AUDIT', now);
    const props = appProps_();
    const prev = String(props.getProperty(APP_PROP.auditLastHash) || '');
    const body = [
      Utilities.getUuid(), appNowIso_(), e.actor || '', e.actorRoles || '', e.action || '', e.phase || '', e.result || '',
      e.entityType || '', e.entityId || '', e.clientId || '', e.planId || '',
      appJson_(e.detail), appJson_(e.before), appJson_(e.after), String(e.reason || '').slice(0, 2000),
      String(e.error || '').slice(0, 2000), e.requestId || '', APP_VERSION
    ].map(v => (v === undefined || v === null ? '' : String(v)));  // 書いた値と読み戻した値を同じにする（数値の ID でも鎖が合う）
    const hash = appSha256Hex_(prev + '\n' + JSON.stringify(body));
    appLogWrite_(sh, body.concat([prev, hash]));
    props.setProperty(APP_PROP.auditLastHash, hash);
    return hash;
  });
}

/** 実行ログ（定期処理など）。失敗しても本体は止めない */
function appRunLog_(e) {
  try {
    appWithLock_(() => appLogWrite_(appLogSheet_('RUN', new Date()), [
      e.runId || Utilities.getUuid(), e.requestId || '', e.kind || '', e.startedAt || '', e.finishedAt || appNowIso_(),
      String(e.durationMs || 0), e.status || '', appJson_(e.detail), String(e.error || '').slice(0, 2000)
    ]));
  } catch (err) {
    Logger.log('appRunLog_: ' + (err && err.message ? err.message : err));
  }
}

/** エラーログ。失敗しても本体は止めない */
function appLogError_(where, err, ctx) {
  try {
    if (!appProps_().getProperty(APP_PROP.folderId)) return;
    appWithLock_(() => appLogWrite_(appLogSheet_('ERROR', new Date()), [
      Utilities.getUuid(), appNowIso_(), (ctx && ctx.requestId) || '', (ctx && ctx.actor) || '', where,
      String(err && err.message ? err.message : err).slice(0, 2000), String(err && err.stack ? err.stack : '').slice(0, 1000)
    ]));
  } catch (e) {
    Logger.log('appLogError_: ' + (e && e.message ? e.message : e));
  }
}

/**
 * 記録つきで実行する。開始（変更前の値つき）を書いてから fn を実行し、終了（OK / FAILED と変更後の値）を書く。
 * meta: { entityType, entityId, clientId, planId, detail, reason, before(), after(res) }
 */
function appAudited_(ctx, action, meta, fn) {
  meta = meta || {};
  const base = { actor: ctx.actor, actorRoles: appRoleSummary_(ctx.roles), action: action, requestId: ctx.requestId,
    entityType: meta.entityType, entityId: meta.entityId, clientId: meta.clientId, planId: meta.planId, reason: meta.reason };
  let before = '';
  try { before = meta.before ? meta.before() : ''; } catch (e) { before = { error: String(e && e.message || e) }; }
  appAuditAppend_(Object.assign({}, base, { phase: 'START', detail: meta.detail, before: before }));
  try {
    const res = fn();
    let after = '';
    try { after = meta.after ? meta.after(res) : ''; } catch (e) { after = { error: String(e && e.message || e) }; }
    const ids = (res && res.audit) || {};  // 作った ID などを終了の行に残す
    try {
      // 変更前の値は、開始で取れなかった場合に処理の結果（res.before）から残す
      const endBefore = meta.before ? '' : (res && res.before !== undefined ? res.before : '');
      appAuditAppend_(Object.assign({}, base, { phase: 'END', result: 'OK', before: endBefore, after: after,
        entityId: ids.entityId || base.entityId, clientId: ids.clientId || base.clientId }));
    } catch (e) {
      Logger.log('appAudited_ END の記録に失敗: ' + (e && e.message ? e.message : e));
    }
    return res;
  } catch (err) {
    try { appAuditAppend_(Object.assign({}, base, { phase: 'END', result: 'FAILED', error: String(err && err.message || err) })); }
    catch (e) { Logger.log('appAudited_ FAILED の記録に失敗: ' + (e && e.message ? e.message : e)); }
    throw err;
  } finally {
    appBumpGen_();   // 記録つきの操作は書く操作。読んだ結果の控えを古くする（途中で止まっても）
  }
}

/** ある月の監査シートの鎖を検証する（行の hash と、前の行との つながり） */
function appVerifyAuditSheet_(sh) {
  const columns = APP_LOG_TABLES.AUDIT;
  const last = sh.getLastRow();
  if (last < 2) return { rows: 0, ok: true, brokenAt: 0, firstPrev: '', lastHash: '' };
  const vals = sh.getRange(2, 1, last - 1, columns.length).getValues().map(r => r.map(v => String(v)));
  const ip = columns.indexOf('prev_hash');
  const ih = columns.indexOf('row_hash');
  for (let i = 0; i < vals.length; i++) {
    const r = vals[i];
    if (i > 0 && r[ip] !== vals[i - 1][ih]) return { rows: vals.length, ok: false, brokenAt: i + 2, firstPrev: vals[0][ip], lastHash: '' };
    if (appSha256Hex_(r[ip] + '\n' + JSON.stringify(r.slice(0, ip))) !== r[ih]) return { rows: vals.length, ok: false, brokenAt: i + 2, firstPrev: vals[0][ip], lastHash: '' };
  }
  return { rows: vals.length, ok: true, brokenAt: 0, firstPrev: vals[0][ip], lastHash: vals[vals.length - 1][ih] };
}
