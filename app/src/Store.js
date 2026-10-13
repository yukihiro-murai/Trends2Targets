/**
 * Store.js — 保存先の差し替え層（スプレッドシート版）。業務のコードはここ以外で SpreadsheetApp を直接触らない。
 * すべてのセルを書式なしテキスト（@）で保存し、読むときに Schema の型へ戻す（日付や数値への自動変換を防ぐ）。
 * 将来ログなどを BigQuery へ移すときは、この層に実装を足す（業務のコードは変えない）。
 */
let APP_STORE_CACHE_ = {};
let APP_LOCK_DEPTH_ = 0;

function appProps_() {
  return PropertiesService.getScriptProperties();
}

function appNowIso_() {
  return Utilities.formatDate(new Date(), APP_TZ, "yyyy-MM-dd'T'HH:mm:ssZ");
}

function appToday_() {
  return Utilities.formatDate(new Date(), APP_TZ, 'yyyy-MM-dd');
}

/**
 * 年度（4月〜翌3月）。始まりの年で呼ぶ: 2026-10 → FY2026（旧来の計算の getForecastFYStart_・vNext の vNextFiscalYearForDate_ と同じ）。
 * 2026-10-01 までは終わりの年で呼んでいた（ログのファイル名。appEnsureFyNaming_ が一度だけ直す）。
 */
function appFy_(d) {
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
}

/** 時刻順に並ぶ ID（例: RL-20261001183000-1A2B3C4D） */
function appId_(prefix) {
  return prefix + '-' + Utilities.formatDate(new Date(), APP_TZ, 'yyyyMMddHHmmss') + '-' +
    Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
}

function appSha256Hex_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2)).join('');
}

/** 長い JSON はハッシュと先頭だけにする（セルの上限 5 万字に対し 4 万字まで） */
function appJson_(v) {
  if (v === undefined || v === null || v === '') return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s.length <= APP_JSON_MAX) return s;
  return JSON.stringify({ truncated: true, length: s.length, sha256: appSha256Hex_(s), head: s.slice(0, 2000) });
}

/** スクリプト全体のロック。入れ子で呼ばれても 1 回だけ取る */
function appWithLock_(fn) {
  if (APP_LOCK_DEPTH_ > 0) {
    APP_LOCK_DEPTH_++;
    try { return fn(); } finally { APP_LOCK_DEPTH_--; }
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(APP_LOCK_WAIT_MS);
  APP_LOCK_DEPTH_ = 1;
  appStoreForget_();   // ロックを取る前に読んだ表は、ほかの実行が書き換えたかもしれない
  appStoreForgetOldHeads_();   // 列を足す前と覚えた表も（ほかの実行が移行したかもしれない）
  try {
    return fn();
  } finally {
    APP_LOCK_DEPTH_ = 0;
    lock.releaseLock();
  }
}

function appIsSetUp_() {
  return !!appProps_().getProperty(APP_PROP.dataId);
}

function appDataSpreadsheet_() {
  if (APP_STORE_CACHE_.data) return APP_STORE_CACHE_.data;
  const id = appProps_().getProperty(APP_PROP.dataId);
  if (!id) throw new Error('データ本体がまだありません。管理者が「初期設定」を実行してください。');
  APP_STORE_CACHE_.data = SpreadsheetApp.openById(id);
  return APP_STORE_CACHE_.data;
}

/**
 * 表のシート。create=true なら無いときに作る。列が定義と違えば止める（fail-closed）。
 * headLater=true なら見出しをまだ読まない（呼んだ側が本文と一緒に読み、appCheckTableHead_ で確かめる。読む回数を 1 回にするため）
 */
function appTableSheet_(name, create, headLater) {
  const def = APP_TABLES[name];
  if (!def) throw new Error('未定義の表: ' + name);
  const sheets = APP_STORE_CACHE_.sheets || (APP_STORE_CACHE_.sheets = {});
  if (sheets[name]) return sheets[name];
  const found = APP_STORE_CACHE_.found || (APP_STORE_CACHE_.found = {});   // 見つけたが、見出しはまだ確かめていないシート
  const ss = appDataSpreadsheet_();
  let sh = found[name] || ss.getSheetByName(name);
  if (!sh) {
    if (!create) throw new Error('表がありません（' + name + '）。管理者が「初期設定」を実行してください。');
    sh = ss.insertSheet(name);
    appFitColumns_(sh, def.columns.length);
    sh.getRange(1, 1, 1, def.columns.length).setNumberFormat('@').setValues([def.columns]);
    sh.setFrozenRows(1);
    sheets[name] = sh;
    return sh;
  }
  if (headLater) { found[name] = sh; return sh; }
  appCheckTableHead_(name, sh, appReadWide_(sh, 1, 1, def.columns.length)[0]);
  return sh;
}

/**
 * 読んだ見出し（1 行目）が定義と同じかを確かめる。違えば止める（fail-closed）。同じなら、この実行の間は確かめ直さない。
 * 列を足す前の見出し（APP_ADDED_COLUMNS の前の版の並び）なら止めずに、読むだけの表として覚える（足した列は空で読む。書くと止まる: appRequireCurrentHead_）。
 * 列を足す移行（appMigrateColumns_）ができない間も、画面が開けるようにするため
 */
function appCheckTableHead_(name, sh, head) {
  const def = APP_TABLES[name];
  const width = APP_STORE_CACHE_.width || (APP_STORE_CACHE_.width = {});
  delete width[name];
  if (head.map(String).join('|') !== def.columns.join('|')) {
    const w = appOldHeadWidth_(name, head);
    if (!w) throw new Error('表の列が定義と違います（' + name + '）。書き込みを止めました。');
    width[name] = w;
  }
  (APP_STORE_CACHE_.sheets || (APP_STORE_CACHE_.sheets = {}))[name] = sh;
}

/** 表の列の移り変わり（古い順。最後が今の列）。APP_ADDED_COLUMNS の版ごとに、後ろの列を外した並び */
function appTableStages_(name) {
  const cols = APP_TABLES[name].columns.slice();
  const added = APP_ADDED_COLUMNS[name] || [];
  const out = [cols];
  let cur = cols;
  for (let i = added.length - 1; i >= 0; i--) {
    cur = cur.slice(0, cur.length - added[i].columns.length);
    out.unshift(cur);
  }
  return out;
}

/** 見出しが列を足す前の並びなら、その列の数（今の並び・どれでもないときは 0）。後ろの空のセルは見ない */
function appOldHeadWidth_(name, head) {
  const h = head.map(v => (v === null || v === undefined ? '' : String(v)));
  while (h.length && h[h.length - 1] === '') h.pop();
  const stages = appTableStages_(name);
  for (let i = 0; i < stages.length - 1; i++) if (stages[i].length && stages[i].join('|') === h.join('|')) return stages[i].length;
  return 0;
}

/** 表を読む列の数（列を足す前の表は、前の版の列の数） */
function appTableWidth_(name) {
  return (APP_STORE_CACHE_.width && APP_STORE_CACHE_.width[name]) || APP_TABLES[name].columns.length;
}

/**
 * 列を足す前の表には書かない（移行が終わるまで読むだけ）。書くのはロックの中だけで、ロックを取ったときに
 * 列を足す前と覚えた表は見出しを確かめ直す（appStoreForgetOldHeads_）ので、ここで見るのは今の見出し
 */
function appRequireCurrentHead_(name) {
  if (APP_STORE_CACHE_.width && APP_STORE_CACHE_.width[name]) {
    throw new Error('表の列を足す移行がまだです（' + name + '）。書き込みを止めました。少し待ってから、もう一度操作してください。');
  }
}

/**
 * 列を足す前と覚えた表を忘れる（次に読むときに見出しから確かめ直す）。ロックを取ったときに呼ぶ:
 * ロックを待つ間にほかの実行が移行したら、前の列の数で読んだまま書くと、足した列の値を空で書き戻してしまうため
 */
function appStoreForgetOldHeads_() {
  const w = APP_STORE_CACHE_.width;
  if (!w) return;
  Object.keys(w).forEach(n => { if (APP_STORE_CACHE_.sheets) delete APP_STORE_CACHE_.sheets[n]; delete w[n]; });
}

/**
 * 行 row から rows 行を n 列ぶん読む。シートの列が n より少ない（列を足す前の表）ときは、ある列だけを読み、足りない列を空にする。
 * ふだんは今までどおり 1 回で読む（シートの列の数は、読めなかったときだけ確かめる）
 */
function appReadWide_(sh, row, rows, n) {
  try { return sh.getRange(row, 1, rows, n).getValues(); }
  catch (e) {
    const m = sh.getMaxColumns();
    if (m >= n || m < 1) throw e;
    return sh.getRange(row, 1, rows, m).getValues().map(r => r.concat(new Array(n - m).fill('')));
  }
}

/** 読んだ行を、今の列の数にそろえる（列を足す前の表は、足した列を空にする） */
function appPadRow_(r, w, n) {
  if (w >= n && r.length === n) return r;
  const out = r.slice(0, w);
  while (out.length < n) out.push('');
  return out;
}

// ---- 読んだ表の控え（この実行の間だけ。書いた表とロックを取ったときは捨てる）----
// 1 回の処理で同じ表を何度も読む（入力のハッシュ・キーの重複の確認・控えの作成など）。スプレッドシートを読むのは 1 回にする

/**
 * 表の 2 行目から最後の行までのセル（文字列）。読み込んだものを控える。
 * 見出しをまだ確かめていない表は、見出しと本文を 1 回で読み、見出しが定義と違えば止める（今までどおり）。
 * known = { sh, last } を渡すと、シートと最後の行を探し直さない（appReadPlanTable_ が先に調べたもの）
 */
function appRawTable_(name, known) {
  const raw = APP_STORE_CACHE_.raw || (APP_STORE_CACHE_.raw = {});
  if (raw[name]) return raw[name];
  const def = APP_TABLES[name];
  const checked = !!(APP_STORE_CACHE_.sheets && APP_STORE_CACHE_.sheets[name]);
  const sh = known ? known.sh : appTableSheet_(name, false, true);
  const last = known ? known.last : sh.getLastRow();
  const n = def.columns.length;
  const text = r => r.map(v => (v === null || v === undefined ? '' : String(v)));
  if (checked) {
    const w = appTableWidth_(name);
    raw[name] = last < 2 ? [] : sh.getRange(2, 1, last - 1, w).getValues().map(r => appPadRow_(text(r), w, n));
    return raw[name];
  }
  const vals = appReadWide_(sh, 1, Math.max(1, last), n);
  appCheckTableHead_(name, sh, vals[0]);
  const w = appTableWidth_(name);
  raw[name] = vals.slice(1).map(r => appPadRow_(text(r), w, n));
  return raw[name];
}

/** 書いた表の控えを捨てる（name を省くと全部） */
function appStoreForget_(name) {
  if (APP_STORE_CACHE_.plan) {
    if (name) Object.keys(APP_STORE_CACHE_.plan).forEach(k => { if (k.split('\u0001')[0] === name) delete APP_STORE_CACHE_.plan[k]; });
    else APP_STORE_CACHE_.plan = {};
  }
  if (!APP_STORE_CACHE_.raw) return;
  if (name) delete APP_STORE_CACHE_.raw[name]; else APP_STORE_CACHE_.raw = {};
}

// ---- 読んだ結果の控え（実行をまたぐ。CacheService に 6 時間）----
// データ本体に書くたびに「版の印」（APP_DATA_GEN）を変える。控えは印ごとに分けるので、書いた後に古い結果を返すことはない。
// 印は書いた「後」に変える（読む側は 印を読む → データを読む の順。書きかけの間に読んだ結果は、古い印の控えになって二度と使われない）。
// 印が控えから消えたときは新しい印を作る（控えがすべて外れるだけで、古い結果は返さない）。
const APP_GEN_KEY = 'APP_DATA_GEN';
const APP_READ_TTL_SEC = 6 * 3600;
const APP_READ_CHUNK = 30000;   // 1 つの値は 100KB（バイト）まで。日本語は 1 文字 3 バイト
const APP_CACHE_CHUNKS_MAX = 1000;   // 分けた数の上限（壊れた数から、大きな鍵の一覧を作らない）

function appNewGen_() { return String(new Date().getTime()) + '-' + Utilities.getUuid().slice(0, 8); }

function appDataGen_() {
  if (APP_STORE_CACHE_.gen) return APP_STORE_CACHE_.gen;
  const cache = CacheService.getScriptCache();
  let g = cache.get(APP_GEN_KEY);
  if (!g) { g = appNewGen_(); cache.put(APP_GEN_KEY, g, APP_READ_TTL_SEC); }
  APP_STORE_CACHE_.gen = g;
  return g;
}

/** データ本体に書いた後に呼ぶ（読んだ結果の控えをすべて古くする） */
function appBumpGen_() {
  delete APP_STORE_CACHE_.gen;
  try { CacheService.getScriptCache().put(APP_GEN_KEY, appNewGen_(), APP_READ_TTL_SEC); } catch (e) { Logger.log('版の印を変えられません: ' + (e && e.message ? e.message : e)); }
}

/**
 * 分けて置いた控え（k = 分けた数、k_0, k_1, … = 中身）をつなげて返す（{ k: 中身 }。無い・欠けていれば null）。
 * いくつの控えでも getAll の 2 回までで取る: 1 回目は数と最初の 1 つ（ほとんどの控えは 1 つに収まる）、2 回目は残りをまとめて。
 * 数が壊れている（整数でない・上限を超える）か、最初の 1 つが無い控えは、残りを取らずに null にする
 */
function appCacheChunksAll_(cache, keys) {
  const first = [];
  keys.forEach(k => { first.push(k, k + '_0'); });
  const got = first.length ? cache.getAll(first) : {};
  const counts = {};
  keys.forEach(k => {
    const n = Number(got[k]);
    counts[k] = typeof got[k + '_0'] === 'string' && Number.isInteger(n) && n >= 1 && n <= APP_CACHE_CHUNKS_MAX ? n : 0;
  });
  const rest = [];
  keys.forEach(k => { for (let i = 1; i < counts[k]; i++) rest.push(k + '_' + i); });
  if (rest.length) Object.assign(got, cache.getAll(rest));
  const out = {};
  keys.forEach(k => {
    const n = counts[k];
    let text = n ? '' : null;
    for (let i = 0; i < n && text !== null; i++) { const part = got[k + '_' + i]; text = typeof part === 'string' ? text + part : null; }
    out[k] = text;
  });
  return out;
}

function appCacheChunks_(cache, k) {
  return appCacheChunksAll_(cache, [k])[k];
}

/**
 * 読むだけの結果を、版の印が同じ間だけ控えから返す。key は結果を決めるもの（人ごとに違う結果なら人も入れる）。
 * 鍵にはアプリの版（APP_VERSION）も入れる（公開し直した後に、前の版のコードで作った結果を返さない。データ本体が変わらなくても）。
 * 控えが読めない・大きすぎるときは、そのまま fn() を返す（控えは速くするためだけのもの）
 */
function appCachedRead_(key, fn) {
  const cache = CacheService.getScriptCache();
  const k = 'RC_' + appSha256Hex_(appDataGen_() + '\u0001' + APP_VERSION + '\u0001' + key).slice(0, 32);
  try {
    const text = appCacheChunks_(cache, k);
    if (text !== null) return JSON.parse(text);
  } catch (e) { /* 控えが壊れていれば読み直す */ }
  const v = fn();
  try {
    const text = JSON.stringify(appSerialize_(v));
    const parts = Math.max(1, Math.ceil(text.length / APP_READ_CHUNK));
    if (parts <= 40) {
      for (let i = 0; i < parts; i++) cache.put(k + '_' + i, text.slice(i * APP_READ_CHUNK, (i + 1) * APP_READ_CHUNK), APP_READ_TTL_SEC);
      cache.put(k, String(parts), APP_READ_TTL_SEC);
    }
  } catch (e) { Logger.log('読んだ結果を控えられません: ' + (e && e.message ? e.message : e)); }
  return v;
}

/** これより行の多い表は、計画の行だけを探して読む（少ない表は全部読んで控える方が速い）。テストで差し替える */
function appPlanReadMinRows_() { return 3000; }

/**
 * 計画 1 つ分の行（plan_id が 1 列目の表）。表が大きいときは、1 列目で計画の ID を探し（TextFinder）、続いている行のかたまりごとに読む。
 * 計画が増えても、読む量はその計画の分だけで済む
 */
function appReadPlanTable_(name, planId) {
  const def = APP_TABLES[name];
  if (def.columns[0] !== 'plan_id') throw new Error('計画ごとに読めない表です: ' + name);
  const mine = o => o.plan_id === planId;
  if (APP_STORE_CACHE_.raw && APP_STORE_CACHE_.raw[name]) return appReadTable_(name).filter(mine);
  const sh = appTableSheet_(name, false, true);
  const last = sh.getLastRow();
  // 少ない表は全部読む（見出しも一緒に読んで確かめる。最後の行は調べ直さない）
  if (last - 1 <= appPlanReadMinRows_()) return appReadTable_(name, { sh: sh, last: last }).filter(mine);
  const cache = APP_STORE_CACHE_.plan || (APP_STORE_CACHE_.plan = {});
  const key = name + '\u0001' + planId;
  if (!cache[key]) {
    appTableSheet_(name, false);   // 大きい表は見出しだけを先に確かめる（確かめ済みなら読まない）
    const rowsNo = sh.getRange(2, 1, last - 1, 1).createTextFinder(String(planId)).matchEntireCell(true).matchCase(true).findAll().map(r => r.getRow()).sort((a, b) => a - b);
    const out = [];
    const w = appTableWidth_(name);
    for (let i = 0; i < rowsNo.length;) {
      let j = i;
      while (j + 1 < rowsNo.length && rowsNo[j + 1] === rowsNo[j] + 1) j++;
      sh.getRange(rowsNo[i], 1, j - i + 1, w).getValues().forEach((r, k) => {
        out.push({ row: rowsNo[i] + k, cells: appPadRow_(r.map(v => (v === null || v === undefined ? '' : String(v))), w, def.columns.length) });
      });
      i = j + 1;
    }
    cache[key] = out;
  }
  return cache[key].map(x => { const o = appRowToObject_(def, x.cells); o._row = x.row; return o; }).filter(o => def.key.some(k => o[k] !== '') && mine(o));
}

/**
 * データ本体の表を整える（毎日の手入れ）: 使っていない空の行を減らす（セルの上限 1000 万と、開く・読む時間のため）、
 * 手で書き換えないよう警告つきで保護する（アプリは書ける）、表の種類でタブの色を分ける。値は変えない
 */
function appOrganizeDataBook_() {
  const ss = appDataSpreadsheet_();
  const out = { trimmedRows: 0, protectedSheets: 0, sheets: 0 };
  const sheetType = (typeof SpreadsheetApp.ProtectionType !== 'undefined') ? SpreadsheetApp.ProtectionType.SHEET : null;
  Object.keys(APP_TABLES).forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    out.sheets++;
    const keep = sh.getLastRow() + 200;
    const max = sh.getMaxRows();
    if (max - keep > 500) { sh.deleteRows(keep + 1, max - keep); out.trimmedRows += max - keep; }
    try {
      if (sheetType && !sh.getProtections(sheetType).length) {
        sh.protect().setDescription('アプリだけが書く表（手で直さない。直すと操作の記録に残らない）').setWarningOnly(true);
        out.protectedSheets++;
      }
      sh.setTabColor(name.indexOf('ENG_') === 0 ? '#94A3B8' : name === '_SCHEMA' ? '#5A6B7E' : '#0F3557');
    } catch (e) { Logger.log('表の保護・色: ' + name + ' ' + (e && e.message ? e.message : e)); }
  });
  out.retired = appHideRetiredTables_(ss);
  appStoreForgetSheets_();
  return out;
}

/** 見つけたシートと確かめた見出しの控えを捨てる（表の 1 行目を書いた後など。読んだ表の控えも捨てる） */
function appStoreForgetSheets_() {
  APP_STORE_CACHE_.sheets = {};
  APP_STORE_CACHE_.found = {};
  APP_STORE_CACHE_.width = {};
  appStoreForget_();
}

/** 使わなくなった表（APP_RETIRED_TABLES）のシートを隠す（消さない）。隠したシートの名前を返す */
function appHideRetiredTables_(ss) {
  const hidden = [];
  APP_RETIRED_TABLES.forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.isSheetHidden() || ss.getSheets().length < 2) return;
    try { sh.setTabColor('#CBD5E1'); sh.hideSheet(); hidden.push(name); } catch (e) { Logger.log('使わない表を隠す: ' + name + ' ' + (e && e.message ? e.message : e)); }
  });
  return hidden;
}

/** シートの列数をちょうど n にする（足りなければ足し、余りは消してセルの上限を節約する） */
function appFitColumns_(sh, n) {
  const max = sh.getMaxColumns();
  if (max < n) sh.insertColumnsAfter(max, n - max);
  else if (max > n) sh.deleteColumns(n + 1, max - n);
}

/** 行を 2 行目から書く（大きいときは分けて書く）。足りない行は足す */
function appWriteBody_(sh, rows, width, offset, bottomUp) {
  if (!rows.length) return;
  offset = offset || 0;
  const need = offset + rows.length + 1;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  const CHUNK = 5000;
  const starts = [];
  for (let i = 0; i < rows.length; i += CHUNK) starts.push(i);
  // 行が増えて下へずれるときは下から書く（途中で止まっても、まだ書いていない上の行は元のまま残り、控えから書き直せる）
  if (bottomUp) starts.reverse();
  starts.forEach(i => {
    const part = rows.slice(i, i + CHUNK);
    sh.getRange(2 + offset + i, 1, part.length, width).setNumberFormat('@').setValues(part);
  });
}

function appRowToObject_(def, r) {
  const o = {};
  def.columns.forEach((c, j) => {
    const v = r[j] === null || r[j] === undefined ? '' : String(r[j]);
    const t = appColumnType_(c, def);
    o[c] = t === 'bool' ? v === 'TRUE' : t === 'int' ? (v === '' ? 0 : Number(v)) : t === 'num' ? (v === '' ? null : Number(v)) : v;
  });
  return o;
}

function appObjectToRow_(def, o) {
  return def.columns.map(c => {
    const v = o[c];
    const t = appColumnType_(c, def);
    if (v === undefined || v === null) return t === 'bool' ? 'FALSE' : t === 'int' ? '0' : '';
    if (t === 'num' && (typeof v !== 'number' || !isFinite(v))) throw new Error('数値の列に数値でない値: ' + c);
    if (t === 'bool') return v ? 'TRUE' : 'FALSE';
    if (t === 'json' && typeof v !== 'string') return appJson_(v);
    return String(v);
  });
}

/** 表の全行（_row = シートの行番号つき）。キーが空の行は飛ばす。known は appRawTable_ と同じ */
function appReadTable_(name, known) {
  const def = APP_TABLES[name];
  return appRawTable_(name, known)
    .map((r, i) => { const o = appRowToObject_(def, r); o._row = i + 2; return o; })
    .filter(o => def.key.some(k => o[k] !== ''));
}

function appInsertRows_(name, objs) {
  const def = APP_TABLES[name];
  if (!objs.length) return [];
  // キーの重複を入れない（同じ秒に作った ID がぶつかった場合なども止める）
  const keyOf = o => def.key.map(k => String(o[k] === undefined || o[k] === null ? '' : o[k])).join('\u0001');
  const seen = {};
  appReadTable_(name).forEach(o => { seen[keyOf(o)] = true; });
  objs.forEach(o => {
    const k = keyOf(o);
    if (def.key.every(c => o[c] === undefined || o[c] === null || o[c] === '')) throw new Error('キーが空の行は足せません（' + name + '）。');
    if (seen[k]) throw new Error('同じキーの行がすでにあります（' + name + '）。');
    seen[k] = true;
  });
  const sh = appTableSheet_(name, false);
  appRequireCurrentHead_(name);
  const rows = objs.map(o => appObjectToRow_(def, o));
  appStoreForget_(name);
  const start = sh.getLastRow() + 1;
  if (start + rows.length - 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), Math.max(1000, rows.length));
  sh.getRange(start, 1, rows.length, def.columns.length).setNumberFormat('@').setValues(rows);
  appBumpGen_();
  return objs;
}

/**
 * 表の中身を入れ替える。keep(row) が true の行は残し、その後ろに objs を足す（計画 1 つ分の入れ替えなどに使う）。
 * 新しい中身を先に書いてから、余った古い行を消す。返り値は { removed, kept, added }
 */
function appReplaceRows_(name, keep, objs) {
  const cur = appReadTable_(name);
  const kept = cur.filter(keep).map(appStripRow_);
  appReplaceWhole_(name, kept.concat(objs));
  return { removed: cur.length - kept.length, kept: kept.length, added: objs.length };
}

/** 表全体を rows にする（2 行目から書き、余った古い行を消す）。何度書いても同じ結果になる（保存の控えの書き直しに使う） */
function appReplaceWhole_(name, rows) {
  const def = APP_TABLES[name];
  const sh = appTableSheet_(name, false);
  appRequireCurrentHead_(name);
  const keyOf = o => def.key.map(k => String(o[k] === undefined || o[k] === null ? '' : o[k])).join('\u0001');
  const seen = {};
  rows.forEach(o => {
    const k = keyOf(o);
    if (seen[k]) throw new Error('同じキーの行があります（' + name + '）。');
    seen[k] = true;
  });
  const next = rows.map(o => appObjectToRow_(def, o));
  const old = appRawTable_(name);
  // 今の中身と同じ行は書かない: 頭から同じ行と（行の数が同じなら）お尻から同じ行を除いた、間だけを書く
  const same = (a, b) => a.length === b.length && a.every((v, j) => v === b[j]);
  let head = 0;
  while (head < next.length && head < old.length && same(next[head], old[head])) head++;
  let tail = 0;
  if (old.length === next.length) while (tail < next.length - head && same(next[next.length - 1 - tail], old[old.length - 1 - tail])) tail++;
  appStoreForget_(name);
  appWriteBody_(sh, next.slice(head, next.length - tail), def.columns.length, head, next.length > old.length);
  if (old.length > next.length) sh.getRange(next.length + 2, 1, old.length - next.length, def.columns.length).clearContent();
  if (next.length - head - tail > 0 || old.length > next.length) appBumpGen_();
  return { rows: rows.length, written: next.length - head - tail };
}

/** キーの無い行だけ足す（何度呼んでも同じ結果になる）。返り値は足した行 */
function appEnsureRows_(name, objs) {
  const def = APP_TABLES[name];
  if (!objs.length) return [];
  const keyOf = o => def.key.map(k => String(o[k] === undefined || o[k] === null ? '' : o[k])).join('\u0001');
  const have = {};
  appReadTable_(name).forEach(o => { have[keyOf(o)] = true; });
  return appInsertRows_(name, objs.filter(o => !have[keyOf(o)]));
}

/**
 * 追記だけの表（版 10 の記録の表）に、キーの無い行だけを後ろに足す。重なりはキーの列だけを読んで確かめる（appEnsureRows_ は表を全部読む）。
 * 何度呼んでも同じ結果（控えの書き直しでも二重にならない）。同じキーの行を 2 つ渡すと止める。ロックの中で呼ぶ（控えの書き方 append から）。
 * plan_id の列がある表は、締めた年度の計画の行を書かない（ops = 同じ控えの書き込み。その中で作る計画の年度も分かる）。返り値は足した行
 */
function appAppendLogRows_(name, objs, ops) {
  const def = APP_TABLES[name];
  if (!def) throw new Error('未定義の表: ' + name);
  if (!objs || !objs.length) return [];
  const keyOf = o => def.key.map(k => String(o[k] === undefined || o[k] === null ? '' : o[k])).join('\u0001');
  const fresh = {};
  objs.forEach(o => {
    if (def.key.some(c => o[c] === undefined || o[c] === null || o[c] === '')) throw new Error('キーが空の行は足せません（' + name + '）。');
    const k = keyOf(o);
    if (fresh[k]) throw new Error('同じキーの行が 2 つあります（' + name + '）。');
    fresh[k] = true;
  });
  if (def.columns.indexOf('plan_id') >= 0) {
    const pids = {};
    objs.forEach(o => { if (o.plan_id !== undefined && o.plan_id !== null && o.plan_id !== '') pids[String(o.plan_id)] = true; });
    Object.keys(pids).forEach(pid => appRequireOpenYear_(appYearPlanFyOf_(pid, ops || [])));
  }
  const sh = appTableSheet_(name, false);
  appRequireCurrentHead_(name);
  const have = appKeySet_(name, sh);
  const add = objs.filter(o => !have[keyOf(o)]);
  if (!add.length) return [];
  const rows = add.map(o => appObjectToRow_(def, o));
  appStoreForget_(name);
  const start = sh.getLastRow() + 1;
  if (start + rows.length - 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), Math.max(1000, rows.length));
  sh.getRange(start, 1, rows.length, def.columns.length).setNumberFormat('@').setValues(rows);
  appBumpGen_();
  return add;
}

/** 表にあるキーの組（{ キー: true }）。キーの列だけを読む（読んだ表の控えがあれば、それを使う） */
function appKeySet_(name, sh) {
  const def = APP_TABLES[name];
  const keyOf = parts => parts.join('\u0001');
  const have = {};
  if (APP_STORE_CACHE_.raw && APP_STORE_CACHE_.raw[name]) {
    appReadTable_(name).forEach(o => { have[keyOf(def.key.map(k => String(o[k] === undefined || o[k] === null ? '' : o[k])))] = true; });
    return have;
  }
  const last = sh.getLastRow();
  if (last < 2) return have;
  const idx = def.key.map(k => def.columns.indexOf(k));
  const lo = Math.min.apply(null, idx), hi = Math.max.apply(null, idx);
  sh.getRange(2, lo + 1, last - 1, hi - lo + 1).getValues().forEach(r => {
    const parts = idx.map(i => { const v = r[i - lo]; return v === null || v === undefined ? '' : String(v); });
    if (parts.some(p => p !== '')) have[keyOf(parts)] = true;
  });
  return have;
}

/** キーの行の列を patch の値にする。すでに同じ値なら書かない（何度呼んでも同じ結果になる）。返り値は書いたかどうか */
function appPatchRow_(name, keyVals, patch, actor) {
  const def = APP_TABLES[name];
  const cur = appReadTable_(name).filter(r => def.key.every(k => r[k] === keyVals[k]))[0];
  if (!cur) throw new Error('対象が見つかりません（' + name + '）。');
  if (Object.keys(patch).every(k => String(cur[k]) === String(patch[k]))) return false;
  appUpdateByKey_(name, keyVals, patch, APP_ROW_UNCHECKED, actor || '');
  return true;
}

/**
 * 計画 1 つ分の行を入れ替える。前の行がそのまま残り、後ろに行が足されただけなら、足された行だけを書く（履歴の表を毎回書き直さない）。
 * 返り値: { appended } か { replaced: true, removed, kept, added }
 */
function appReplaceOrAppend_(name, planId, objs) {
  const def = APP_TABLES[name];
  const key = o => def.columns.map(c => String(o[c] === undefined || o[c] === null ? '' : o[c])).join('\u0001');
  const cur = appReadTable_(name).filter(r => r.plan_id === planId).map(appStripRow_);
  const next = {};
  objs.forEach(o => { next[o.seq] = o; });
  if (cur.every(o => next[o.seq] && key(next[o.seq]) === key(o))) {
    const have = {};
    cur.forEach(o => { have[o.seq] = true; });
    const add = objs.filter(o => !have[o.seq]);
    appInsertRows_(name, add);
    return { appended: add.length };
  }
  return Object.assign({ replaced: true }, appReplaceRows_(name, r => r.plan_id !== planId, objs));
}

function appStripRow_(o) {
  const c = Object.assign({}, o);
  delete c._row;
  return c;
}

/**
 * 行の版を確かめずに書き換える印（appUpdateByKey_ の expectedVersion）。仕組みの中で、同じロックの中で読んだ行を書き直すときだけ渡す
 * （_SCHEMA の版・同じ値なら書かない直し）。画面や所有者の操作から渡る値（JSON）は、同じ形でも別のものなので、この印にはならない
 */
const APP_ROW_UNCHECKED = Object.freeze({ unchecked: true });
/** 今ある行・計画を書き換える操作に、楽観ロックの印（行の版 rowVersion・画面を開いたときの指紋 inputHash）が無いときの文（2026-10-13 から必須） */
const APP_STALE_MSG = '画面が古いので、読み直してからもう一度操作してください。';

/**
 * キーで 1 行を更新する。expectedVersion（読み込んだときの行の版）が要る: 読み込んだ後にほかの人が更新していたら止める（楽観ロック）。
 * 2026-10-13 から必須（省くと後から書いた方が勝っていた）。無ければ APP_STALE_MSG で止める。仕組みの中の書き直しだけ APP_ROW_UNCHECKED を渡す。
 * 返り値は { before, after }（監査の変更前後に使う）
 */
function appUpdateByKey_(name, keyVals, patch, expectedVersion, actor) {
  const def = APP_TABLES[name];
  const cur = appReadTable_(name).filter(r => def.key.every(k => r[k] === keyVals[k]))[0];
  if (!cur) throw new Error('対象が見つかりません（' + name + '）。');
  if (expectedVersion !== APP_ROW_UNCHECKED) {
    if (expectedVersion === undefined || expectedVersion === null || expectedVersion === '') throw new Error(APP_STALE_MSG);
    if (Number(expectedVersion) !== Number(cur.row_version)) throw new Error('ほかの人が先に更新しました。画面を読み直してから、もう一度保存してください。');
  }
  const after = Object.assign(appStripRow_(cur), patch, {
    updated_at: appNowIso_(), updated_by: actor, row_version: Number(cur.row_version || 0) + 1
  });
  const sh = appTableSheet_(name, false);
  appRequireCurrentHead_(name);
  appStoreForget_(name);
  sh.getRange(cur._row, 1, 1, def.columns.length).setNumberFormat('@').setValues([appObjectToRow_(def, after)]);
  appBumpGen_();
  return { before: appStripRow_(cur), after: after };
}
