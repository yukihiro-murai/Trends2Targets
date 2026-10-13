/**
 * Setup.js — 初期設定（所有者だけ・何度実行しても同じ結果）。
 * マイドライブに「Trends2Targets_System」フォルダを作り、その中に データ本体・今年度のログ・バックアップ・アーカイブを置く。
 * どれも所有者だけのファイルで、メンバーには共有しない（メンバーはアプリ画面だけを使う）。
 */
function appSetup_(ctx) {
  return appWithLock_(() => {
    const props = appProps_();
    const created = [];
    // 1) フォルダ
    let folder = null;
    const folderId = props.getProperty(APP_PROP.folderId);
    if (folderId) folder = DriveApp.getFolderById(folderId);
    if (!folder) {
      folder = DriveApp.createFolder(APP_FILES.folder);
      props.setProperty(APP_PROP.folderId, folder.getId());
      created.push('フォルダ「' + APP_FILES.folder + '」');
    }
    [[APP_PROP.backupFolderId, APP_FILES.backupFolder], [APP_PROP.archiveFolderId, APP_FILES.archiveFolder]].forEach(p => {
      if (!props.getProperty(p[0])) {
        props.setProperty(p[0], folder.createFolder(p[1]).getId());
        created.push('フォルダ「' + p[1] + '」');
      }
    });
    // 2) 今年度のログ（ここから先は記録できる）。以前の名前のログがあれば先に直す
    appEnsureFyNaming_();
    const logExisted = !!JSON.parse(props.getProperty(APP_PROP.logFiles) || '{}')['FY' + appFy_(new Date())];
    const log = appLogSpreadsheet_(new Date(), 'write');
    if (!logExisted) created.push('ログ「' + APP_FILES.logPrefix + 'FY' + appFy_(new Date()) + '」');
    // 3) データ本体
    let dataNew = false;
    if (!props.getProperty(APP_PROP.dataId)) {
      const ss = SpreadsheetApp.create(APP_FILES.data);
      DriveApp.getFileById(ss.getId()).moveTo(folder);
      props.setProperty(APP_PROP.dataId, ss.getId());
      APP_STORE_CACHE_ = {};
      dataNew = true;
      created.push('データ本体「' + APP_FILES.data + '」');
    }
    // 4) 社内ドメイン（所有者のドメイン）
    if (!props.getProperty(APP_PROP.internalDomain)) props.setProperty(APP_PROP.internalDomain, ctx.user.owner.split('@')[1] || '');
    // 5) 表と _SCHEMA（無い表だけ作る。列が違う表があれば止まる）
    const ss = appDataSpreadsheet_();
    const madeTables = appEnsureTables_(ctx);
    // 6) 所有者をメンバーに
    if (!appReadTable_('MEMBERS').some(m => m.email === ctx.user.owner)) {
      const now = appNowIso_();
      appInsertRows_('MEMBERS', [{ email: ctx.user.owner, display_name: ctx.user.owner.split('@')[0], department: '', is_active: true,
        note: '所有者（アプリを動かす人）', created_at: now, created_by: ctx.actor, updated_at: now, updated_by: ctx.actor, row_version: 1 }]);
      created.push('メンバーに所有者');
    }
    const result = {
      created: created, tables: madeTables, dataNew: dataNew,
      folderUrl: folder.getUrl(), dataUrl: ss.getUrl(), logUrl: log.getUrl()
    };
    appAuditAppend_({ actor: ctx.actor, actorRoles: appRoleSummary_(ctx.roles), action: 'SETUP.INIT', phase: 'END', result: 'OK',
      entityType: 'SYSTEM', detail: { created: created, tables: madeTables }, requestId: ctx.requestId });
    return result;
  });
}

/**
 * 無い表を作り、_SCHEMA に記録する（何度実行しても同じ。列が定義と違う表があれば止まる）。作った表の名前を返す。
 * 版を上げて表を足したときは、初期設定をもう一度実行するか、最初の操作（appAutoEnsureTables_）がこれを呼ぶ。使わなくなった表は隠す。
 * 今ある表に列を足した版（APP_ADDED_COLUMNS）では、先に列を足す移行をする（appMigrateColumns_。止まったら表も作らない）。
 */
function appEnsureTables_(ctx) {
  return appWithLock_(() => {
    const ss = appDataSpreadsheet_();
    // 年度の凍結の記録（YEAR_CLOSURES）は、一度作られた後に無くなっていたら自動では作り直さない。
    // 空で作り直すと「締めた年度」が全部開いてしまうため、止めて復旧を求める（初めての作成・版の移行では _SCHEMA に記録が無いので普通に作る）。
    if (!ss.getSheetByName('YEAR_CLOSURES') && ss.getSheetByName('_SCHEMA') && appYearRegistryWasInitialized_()) {
      throw new Error('年度の凍結の記録の表（YEAR_CLOSURES）が見つかりません。自動では作り直しません。元の記録を戻すか、管理者に連絡してください。');
    }
    appMigrateColumns_(ctx, ss);
    const made = [];
    Object.keys(APP_TABLES).forEach(name => {
      if (!ss.getSheetByName(name)) made.push(name);
      appTableSheet_(name, true);
      appRequireCurrentHead_(name);   // 列を足す前のままの表があれば、版をそろえたことにしない
    });
    appHideRetiredTables_(ss);
    ss.getSheets().forEach(sh => {
      if (!APP_TABLES[sh.getName()] && sh.getLastRow() === 0 && /^(シート|Sheet)\d+$/.test(sh.getName())) ss.deleteSheet(sh);
    });
    const schemaRows = appReadTable_('_SCHEMA');
    const missing = Object.keys(APP_TABLES).filter(n => !schemaRows.some(r => r.table === n));
    appInsertRows_('_SCHEMA', missing.map(n => ({ table: n, schema_version: APP_SCHEMA_VERSION, columns_hash: appColumnsHash_(n),
      migrated_at: appNowIso_(), migrated_by: ctx.actor })));
    appProps_().setProperty(APP_PROP.tablesVersion, String(APP_SCHEMA_VERSION));
    appBumpGen_();
    return made;
  });
}

// ---- 列を足す移行（版 10〜。SCHEMA_PLAN_v10-12_JA.md の 3-10）----
const APP_MIGRATE_BACKUP_FAILED_PROP = 'APP_MIGRATE_BACKUP_FAILED_AT';   // 移行の前のバックアップが取れなかった時刻（操作のたびに複製を試さない）
const APP_MIGRATE_RETRY_MS = 10 * 60 * 1000;

/**
 * 列を足す移行。appEnsureTables_ のロックの中で、無い表を作る前に呼ぶ。返り値は移した表の名前（無ければ空）。
 * 1) 今ある表の 1 行目を全部確かめる。今の列でも列を足す前の列でもない表・足す場所に値がある表が 1 つでもあれば、何も書かずに止める（今までどおり）
 * 2) 列の名前を書き足す表があれば、その日のバックアップを確かめ、無ければ先に取る。取れなければ移行しない（列を足す前の表は、読むだけで使える）
 * 3) 表ごとに、後ろに新しい列の名前を書き（前の列の位置と値は動かさない。前からある行の新しい列は空）、_SCHEMA のその表の行を書き直す
 * 4) 途中で止まっても、次の操作が続きから行う（1 行目がもう新しく _SCHEMA が前の版のままなら、_SCHEMA だけ書く）。何度動かしても同じ結果
 * 締めた年度の行も値は変えない（年度の控えのファイルとは食い違わない）。監査に SCHEMA.MIGRATE（表ごとの前と後の列）、実行ログにも残す
 */
function appMigrateColumns_(ctx, ss) {
  const schemaRows = ss.getSheetByName('_SCHEMA') ? appReadTable_('_SCHEMA') : [];
  const todo = [];
  Object.keys(APP_TABLES).forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    const def = APP_TABLES[name];
    appCheckTableHead_(name, sh, appReadWide_(sh, 1, 1, def.columns.length)[0]);   // どの版の列でもなければ、ここで止まる（まだ何も書いていない）
    const w = APP_STORE_CACHE_.width[name] || 0;
    const stages = appTableStages_(name);
    const s = schemaRows.filter(r => r.table === name)[0];
    if (w) {
      const max = sh.getMaxColumns(), last = sh.getLastRow();
      if (max > w && last >= 2) {
        const extra = sh.getRange(2, w + 1, last - 1, Math.min(def.columns.length, max) - w).getValues();
        if (extra.some(r => r.some(v => v !== '' && v !== null && v !== undefined))) {
          throw new Error('列を足す場所に値があります（' + name + '）。表の列を足す移行を止めました（何も書いていません）。');
        }
      }
      todo.push({ name: name, before: stages.filter(c => c.length === w)[0], head: true, schemaHash: s ? s.columns_hash : '' });
    } else if (s && s.columns_hash !== appColumnsHash_(name) && stages.slice(0, -1).some(c => appSha256Hex_(c.join('|')) === s.columns_hash)) {
      todo.push({ name: name, before: def.columns.slice(), head: false, schemaHash: s.columns_hash });   // 見出しを書いた後に止まった（_SCHEMA だけ）
    }
  });
  if (!todo.length) return [];
  const backup = todo.some(t => t.head) ? appMigrateBackup_(ctx) : null;
  const detail = { version: APP_SCHEMA_VERSION, backup: backup,
    tables: todo.map(t => ({ table: t.name, from: t.before.length, to: APP_TABLES[t.name].columns.length, resume: !t.head })) };
  appAudited_(ctx, 'SCHEMA.MIGRATE', { entityType: 'SCHEMA', entityId: 'v' + APP_SCHEMA_VERSION, detail: detail,
    before: () => ({ tables: todo.map(t => ({ table: t.name, columns: t.before, columnsHash: t.schemaHash })) }),
    after: res => res }, () => {
    const out = { tables: [] };
    todo.forEach(t => {
      const def = APP_TABLES[t.name];
      if (t.head) {
        const sh = ss.getSheetByName(t.name);
        const w = t.before.length;
        if (sh.getMaxColumns() < def.columns.length) sh.insertColumnsAfter(sh.getMaxColumns(), def.columns.length - sh.getMaxColumns());
        sh.getRange(1, w + 1, 1, def.columns.length - w).setNumberFormat('@').setValues([def.columns.slice(w)]);
        delete APP_STORE_CACHE_.sheets[t.name];   // 次に読むときに、新しい見出しで確かめ直す
        delete APP_STORE_CACHE_.width[t.name];
        appStoreForget_(t.name);
      }
      appMigrateSchemaRow_(ctx, t.name);
      out.tables.push({ table: t.name, columns: def.columns.slice(), wroteHead: t.head });
    });
    return out;
  });
  appRunLog_({ requestId: ctx.requestId, kind: 'SCHEMA.MIGRATE', status: 'OK', detail: detail });
  return todo.map(t => t.name);
}

/** 移行の前のバックアップ（その日のものがあれば使う。無ければ取る。取れなければ止める）。返り値 { name, taken } */
function appMigrateBackup_(ctx) {
  const today = appBackupToday_();
  if (today) return { name: today.getName(), taken: false };
  const props = appProps_();
  const failedAt = Number(props.getProperty(APP_MIGRATE_BACKUP_FAILED_PROP) || 0);
  if (failedAt && new Date().getTime() - failedAt < APP_MIGRATE_RETRY_MS) {
    throw new Error('移行の前のバックアップが取れていないので、表の列を足す移行はまだしません（少したってから、もう一度試します）。');
  }
  try {
    // 書きかけの保存は先に書き終える。書き終えられなくても写す（列を足す前の表に書く控えは、移行の後でないと書けないため。Backup.js の appCopyDataBook_）
    const r = appBackup_(ctx, { allowPending: true });
    props.deleteProperty(APP_MIGRATE_BACKUP_FAILED_PROP);
    return { name: r.backup, taken: true };
  } catch (e) {
    props.setProperty(APP_MIGRATE_BACKUP_FAILED_PROP, String(new Date().getTime()));
    throw new Error('移行の前のバックアップが取れないので、表の列を足す移行をしません（列を足す前の表は読むだけで使えます）: ' + String(e && e.message ? e.message : e));
  }
}

/** _SCHEMA のその表の行を、今の版と列のハッシュにする（無ければ足す。同じなら書かない） */
function appMigrateSchemaRow_(ctx, name) {
  const cur = appReadTable_('_SCHEMA').filter(r => r.table === name)[0];
  const patch = { schema_version: APP_SCHEMA_VERSION, columns_hash: appColumnsHash_(name), migrated_at: appNowIso_(), migrated_by: ctx.actor };
  if (!cur) { appInsertRows_('_SCHEMA', [Object.assign({ table: name }, patch)]); return; }
  if (cur.columns_hash === patch.columns_hash && Number(cur.schema_version) === APP_SCHEMA_VERSION) return;
  appUpdateByKey_('_SCHEMA', { table: name }, patch, undefined, ctx.actor);
}

/**
 * 版を上げて表を足したとき、最初の操作（画面を開く・裏の処理を含む）で足りない表を作る。「初期設定」をもう一度実行しなくてよい。
 * 2026-10-02 に版 3 の表（FORECAST_RUNS）が無くて「予測」の画面が開けなかったため。
 * 作った表は実行ログに残す。失敗しても操作は止めずエラーのログに残す（その表を使う操作がそこで止まる。列を足す前の表は読むだけで使える）。
 * 版がそろっていれば、版ごとの一度だけの写しを動かす（appRunBackfills_。済んだものは飛ばす）
 */
function appAutoEnsureTables_(ctx) {
  try {
    if (!appIsSetUp_()) return;
    if (appProps_().getProperty(APP_PROP.tablesVersion) !== String(APP_SCHEMA_VERSION)) {
      const made = appEnsureTables_(ctx);
      if (made.length) appRunLog_({ requestId: ctx.requestId, kind: 'SCHEMA.ENSURE', status: 'OK', detail: { version: APP_SCHEMA_VERSION, made: made } });
    }
  } catch (e) {
    appLogError_('SCHEMA.ENSURE', e, ctx);
    return;
  }
  appRunBackfills_(ctx);
}

// ---- 版ごとの一度だけの写し（版 10: V10.js の APP_V10_BACKFILLS・版 11: V11.js の APP_V11_BACKFILLS。版の順に動かす）----
const APP_BACKFILL_PROP = 'APP_BACKFILLS';   // 済み・失敗の控え: { done: { 名前: { at, v, rows } }, failed: { 名前: { at, error, tries } } }
const APP_BACKFILL_RETRY_MS = 10 * 60 * 1000;

function appBackfillNames_() {
  return APP_V10_BACKFILLS.concat(APP_V11_BACKFILLS);
}

function appBackfillState_() {
  try {
    const s = JSON.parse(appProps_().getProperty(APP_BACKFILL_PROP) || '{}') || {};
    return { done: s.done || {}, failed: s.failed || {} };
  } catch (e) { return { done: {}, failed: {} }; }
}

/** 名前から関数を探す（ほかのファイルの関数は、読み込むときではなく動かすときに探す） */
function appBackfillFn_(name) {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  return g && typeof g[name] === 'function' ? g[name] : null;
}

/**
 * 一度だけの写しを、名前の順に動かす（表の版がそろった後の操作の初め。appAutoEnsureTables_ から）。済んだものは飛ばす。
 * 写しの返り値: { skipped: true } = 中身のない仮のもの（記録せず、次の操作でまた呼ぶ）・{ more: true } = 続きがある（次の操作でまた呼ぶ）・
 * それ以外 = 済み（{ rows } を控える）。投げたらエラーのログに残し、操作は止めず、10 分たってからやり直す。
 * ここではロックを取らずに写しを動かす（写しが自分で appWithLock_ の中で書く。2 つの操作が同時に呼んでも二重にならないよう、キーは中身から決める）。
 * 済み・失敗の控えは、最後にロックの中で読み直してから、この回の分だけを足して書く（ほかの操作が先に書いた「済み」を消さない。済んだ写しの失敗は書かない）
 */
function appRunBackfills_(ctx) {
  const st = appBackfillState_();
  const now = new Date().getTime();
  const todo = appBackfillNames_().filter(n => !st.done[n] && !(st.failed[n] && now - Number(st.failed[n].at || 0) < APP_BACKFILL_RETRY_MS));
  if (!todo.length) return;
  const done = {}, failed = {}, ran = {};
  todo.forEach(name => {
    const t0 = new Date().getTime();
    try {
      const fn = appBackfillFn_(name);
      if (!fn) throw new Error('一度だけの写しの関数がありません: ' + name);
      const res = fn(ctx) || {};
      if (res.skipped) return;
      appRunLog_({ requestId: ctx.requestId, kind: 'SCHEMA.BACKFILL', status: res.more ? 'MORE' : 'OK', durationMs: new Date().getTime() - t0,
        detail: { name: name, result: res } });
      ran[name] = true;
      if (!res.more) done[name] = { at: appNowIso_(), v: APP_SCHEMA_VERSION, rows: Number(res.rows) || 0 };
    } catch (e) {
      const prev = st.failed[name];
      failed[name] = { at: now, error: String(e && e.message ? e.message : e).slice(0, 200), tries: (prev ? Number(prev.tries) || 0 : 0) + 1 };
      appLogError_('SCHEMA.BACKFILL', e, ctx);
    }
  });
  if (!Object.keys(ran).length && !Object.keys(failed).length) return;
  try {
    appWithLock_(() => {
      const cur = appBackfillState_();   // ほかの操作が、この回の間に書いた控え
      Object.keys(done).forEach(n => { if (!cur.done[n]) cur.done[n] = done[n]; });
      Object.keys(ran).forEach(n => { delete cur.failed[n]; });
      Object.keys(failed).forEach(n => { if (!cur.done[n]) cur.failed[n] = failed[n]; });
      Object.keys(cur.done).forEach(n => { delete cur.failed[n]; });
      appProps_().setProperty(APP_BACKFILL_PROP, JSON.stringify(cur));
    });
  } catch (e) { Logger.log('一度だけの写しの控えを残せません: ' + (e && e.message ? e.message : e)); }
}

/** 一度だけの写しの状態（状態の点検）: 済み・まだ・失敗（時刻・理由・回数） */
function appBackfillStatus_() {
  const st = appBackfillState_();
  const names = appBackfillNames_();
  return { done: names.filter(n => st.done[n]), pending: names.filter(n => !st.done[n]),
    failed: Object.keys(st.failed).map(n => ({ name: n, at: new Date(Number(st.failed[n].at) || 0).toISOString(), error: st.failed[n].error, tries: st.failed[n].tries })) };
}

// ---- データ本体の大きさ（7 章の上限: セル 1000 万・年度の控え 8MB）----
const APP_CELL_LIMIT = 10000000;   // スプレッドシート 1 つのセルの上限（全部のシートの 行 × 列）
const APP_CELL_WARN_RATIO = 0.5;   // 状態の要約で要確認にする割合（半分を超えたら、締めた年度の行を移すか表を分けるかを決める）
const APP_YEAR_WARN_RATIO = 0.75;  // 年度の控えの目安が、上限のこれだけを超えたら要確認

/** セルの上限（テストで差し替える） */
function appCellLimit_() { return APP_CELL_LIMIT; }

/**
 * データ本体の大きさ（状態の点検）: cells = 全部のシートの 行 × 列（上限に数える。空の行・隠した表も入る）、usedCells = 値のある行 × 列、
 * ratio = cells ÷ 上限、sheets = 大きいシート 8 つ、years = 年度の控えの大きさの目安（appYearSizeEstimate_）
 */
function appDataSize_(ss) {
  const limit = appCellLimit_();
  const sheets = ss.getSheets().map(sh => { const c = sh.getMaxColumns(); return { name: sh.getName(), cells: sh.getMaxRows() * c, usedCells: sh.getLastRow() * c }; });
  const cells = sheets.reduce((n, s) => n + s.cells, 0);
  return { cells: cells, usedCells: sheets.reduce((n, s) => n + s.usedCells, 0), limit: limit, ratio: Math.round(cells / limit * 1000) / 1000,
    sheets: sheets.sort((a, b) => b.cells - a.cells).slice(0, 8), years: appYearSizeEstimate_() };
}

/**
 * 年度の控えの大きさの目安（年度ごと・計画ごと。上限 8MB）: plan_id の列がある表の、その計画の行の文字を JSON にしたバイト数の合計。
 * 表は状態の点検が読んだものを使う（読み直さない）。メーカーの行と表の見出しの分は入れないので、実際の控えより少し小さい
 */
function appYearSizeEstimate_() {
  const bytes = {};
  Object.keys(APP_TABLES).forEach(name => {
    const col = APP_TABLES[name].columns.indexOf('plan_id');
    if (col < 0) return;
    let rows;
    try { rows = appRawTable_(name); } catch (e) { return; }
    rows.forEach(r => { const id = r[col]; if (id) bytes[id] = (bytes[id] || 0) + appUtf8Bytes_(JSON.stringify(r)) + 1; });
  });
  const by = {};
  appReadTable_('PLANS').forEach(p => {
    const f = String(p.fy);
    const y = by[f] || (by[f] = { fy: Number(f), bytes: 0, plans: [] });
    const b = bytes[p.plan_id] || 0;
    y.bytes += b;
    y.plans.push({ planId: p.plan_id, label: p.client_label, bytes: b });
  });
  return Object.keys(by).sort().map(f => Object.assign(by[f], { ratio: Math.round(by[f].bytes / APP_YEAR_SNAPSHOT_MAX_BYTES * 1000) / 1000 }));
}

/** 状態の点検（表の列・_SCHEMA・監査の鎖・バックアップ・定期処理）。管理画面の「状態」 */
function appHealth_() {
  const out = { setUp: appIsSetUp_(), tables: [], audit: null, backup: null, triggers: [], files: {} };
  if (!out.setUp) return out;
  const props = appProps_();
  const schemaRows = (() => { try { return appReadTable_('_SCHEMA'); } catch (e) { return []; } })();
  const ss = (() => { try { return appDataSpreadsheet_(); } catch (e) { return null; } })();
  Object.keys(APP_TABLES).forEach(name => {
    const t = { name: name, ok: true, rows: 0, note: '', engine: name.indexOf('ENG_') === 0 };
    try {
      if (ss && !ss.getSheetByName(name)) {
        t.ok = false; t.missing = true; t.note = '未作成（「初期設定」をもう一度実行すると作られます）';
      } else {
        t.rows = name === '_SCHEMA' ? schemaRows.length : appReadTable_(name).length;
        const s = schemaRows.filter(r => r.table === name)[0];
        if (APP_STORE_CACHE_.width && APP_STORE_CACHE_.width[name]) { t.ok = false; t.pending = true; t.note = '列を足す移行がまだ（読むだけ。次の操作でもう一度試す）'; }
        else if (!s) { t.ok = false; t.note = '_SCHEMA に記録なし'; }
        else if (s.columns_hash !== appColumnsHash_(name)) { t.ok = false; t.note = '列の定義が _SCHEMA と違う（移行が必要）'; }
      }
    } catch (e) { t.ok = false; t.note = String(e && e.message || e); }
    out.tables.push(t);
  });
  // 列を足す移行がバックアップを待っている間は、版を上げて足す表もまだ作らない（初期設定をやり直しても作られない）。移行の後、次の操作で作る
  if (props.getProperty(APP_PROP.tablesVersion) !== String(APP_SCHEMA_VERSION) && out.tables.some(t => t.pending)) {
    out.tables.forEach(t => { if (t.missing) t.note = '未作成（列を足す移行の後に作る。移行の前のバックアップが取れたら、次の操作で作られます）'; });
  }
  try {
    const now = new Date();
    const ss = appLogSpreadsheet_(now, 'read');
    const sh = ss && ss.getSheetByName('AUDIT_' + Utilities.formatDate(now, APP_TZ, 'yyyy_MM'));
    const v = sh ? appVerifyAuditSheet_(sh) : { rows: 0, ok: true, brokenAt: 0, lastHash: '' };
    v.matchesLatest = !v.lastHash || v.lastHash === String(props.getProperty(APP_PROP.auditLastHash) || '');
    out.audit = v;
  } catch (e) {
    out.audit = { ok: false, note: String(e && e.message || e) };
  }
  try { out.backup = appBackupStatus_(); } catch (e) { out.backup = { note: String(e && e.message || e) }; }
  try { out.triggers = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction()); } catch (e) { out.triggers = []; }
  out.housekeeping = appHousekeepingStatus_();   // 始めたまま止まったか（stalled）と最後に終わった時刻（lastDoneAt）つき
  try { out.journal = appJournalPending_(); } catch (e) { out.journal = null; }
  try { out.jobs = appJobList_().length; } catch (e) { out.jobs = null; }
  try { out.years = appYearStatus_(); } catch (e) { out.years = { error: String(e && e.message || e) }; }   // 年度の一覧（締めの管理。読めなければそのことを出す）
  try { out.size = ss ? appDataSize_(ss) : null; } catch (e) { out.size = { error: String(e && e.message || e) }; }   // セルの数と年度の控えの目安（7 章）
  try { out.backfills = appBackfillStatus_(); } catch (e) { out.backfills = { error: String(e && e.message || e) }; }
  try {
    out.files.folder = DriveApp.getFolderById(props.getProperty(APP_PROP.folderId)).getUrl();
    out.files.data = appDataSpreadsheet_().getUrl();
    const log = appLogSpreadsheet_(new Date(), 'read');
    out.files.log = log ? log.getUrl() : '';
  } catch (e) { out.files.note = String(e && e.message || e); }
  return out;
}
