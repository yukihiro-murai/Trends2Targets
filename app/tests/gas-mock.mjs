/*
 * gas-mock.mjs — app/tests で使う GAS のモック（SpreadsheetApp・DriveApp・PropertiesService など）。
 * データ本体とログのスプレッドシートは「すべて書式なしテキストで書く」約束を見張る（strict）。
 * それ以外（旧ブック・計算用ブック）は、文字列の自動変換（'yyyy/MM' → 日付、数字だけ → 数値、'=' → 数式）を真似する。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const srcDir = process.env.APP_SRC_DIR || path.join(appDir, 'src');   // 速さの比べ（bench）で前の版を読むときだけ差し替える
/** スプレッドシートを読んだ・書いた回数とセルの数（速さの比べに使う） */
export const STATS = { reads: 0, readCells: 0, writes: 0, writeCells: 0, bySheet: {} };
const stat = (sh, k, n) => { const c = k === 'reads' ? 'readCells' : 'writeCells'; STATS[k]++; STATS[c] += n; const b = STATS.bySheet[sh.name] = STATS.bySheet[sh.name] || { reads: 0, readCells: 0, writes: 0, writeCells: 0 }; b[k]++; b[c] += n; };
export const repoRoot = path.resolve(appDir, '..');
export const srcNames = (await readdir(srcDir)).sort();
export const jsFiles = srcNames.filter((n) => n.endsWith('.js'));
export const sources = Object.fromEntries(await Promise.all(jsFiles.map(async (n) => [n, await readFile(path.join(srcDir, n), 'utf8')])));
export const uiHtml = await readFile(path.join(srcDir, 'UI.html'), 'utf8');

export const OWNER = 'owner@bigm2y.com';
export const MEMBER = 'member@bigm2y.com';
export const OTHER = 'other@bigm2y.com';
export const OUTSIDER = 'someone@gmail.com';
export const SHEETS_MIME = 'application/vnd.google-apps.spreadsheet';

export const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const J = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
export const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';

/** Utilities.formatDate の代わり（Asia/Tokyo 固定。使う書式だけ） */
export function fmtDate(d, tz, fmt) {
  assert.equal(tz, 'Asia/Tokyo');
  const t = new Date(d.getTime() + 9 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  const map = { yyyy: String(t.getUTCFullYear()), MM: p(t.getUTCMonth() + 1), dd: p(t.getUTCDate()), HH: p(t.getUTCHours()),
    mm: p(t.getUTCMinutes()), ss: p(t.getUTCSeconds()), Z: '+0900' };
  let out = '';
  for (let i = 0; i < fmt.length;) {
    if (fmt[i] === "'") { const j = fmt.indexOf("'", i + 1); out += fmt.slice(i + 1, j); i = j + 1; continue; }
    const tok = ['yyyy', 'MM', 'dd', 'HH', 'mm', 'ss', 'Z'].find((k) => fmt.startsWith(k, i));
    if (tok) { out += map[tok]; i += tok.length; } else { out += fmt[i++]; }
  }
  return out;
}
export const jstDay = (offsetDays) => fmtDate(new Date(Date.now() + offsetDays * 86400e3), 'Asia/Tokyo', 'yyyy-MM-dd');
/** 年度（4月始まり・始まりの年で呼ぶ。旧来の計算と vNext と同じ） */
export const FY = (() => { const d = new Date(); return 'FY' + (d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1); })();
export const MONTH = fmtDate(new Date(), 'Asia/Tokyo', 'yyyy_MM');

const colOf = (letters) => [...letters].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
function parseA1(a1, maxRows) {
  const whole = /^([A-Z]+):([A-Z]+)$/.exec(a1);   // 'D:D' は列全体
  if (whole && maxRows) return [1, colOf(whole[1]), maxRows, colOf(whole[2]) - colOf(whole[1]) + 1];
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+)?)?$/.exec(a1);
  if (!m) throw new Error('A1 形式が読めない: ' + a1);
  const r = Number(m[2]); const c = colOf(m[1]);
  if (!m[3]) return [r, c, 1, 1];
  const r2 = m[4] ? Number(m[4]) : maxRows;   // 'C2:C' は最後の行まで
  if (!r2) throw new Error('A1 形式が読めない: ' + a1);
  return [r, c, r2 - r + 1, colOf(m[3]) - c + 1];
}
const empty = (v) => v === '' || v === null || v === undefined;
const serialOf = (d) => (d.getTime() - new Date(1899, 11, 30).getTime()) / 86400000;

let SHEET_SEQ = 0;
/**
 * シートのモック。strict（データ本体・ログ）は文字列だけ・書式なしテキストだけを受け付ける。
 * strict でないシートは、書式が '@' でないセルに書いた文字列を本物のように変換する。
 */
/** 見た目だけの操作（色・幅・入力規則・枠線・表示/非表示など）は何もしない（計算の結果に関係しない）。値と表示形式は本物のとおりに扱う */
const LOOKS = /^(set(Background|FontColor|FontWeight|FontSize|FontStyle|FontFamily|HorizontalAlignment|VerticalAlignment|Wrap|WrapStrategy|Border|DataValidation|Note|ColumnWidth|ColumnWidths|RowHeight|RowHeights|TabColor|FrozenColumns|Backgrounds|FontColors|FontWeights|HorizontalAlignments|Notes|TextStyle|ConditionalFormatRules)|merge|mergeAcross|mergeVertically|breakApart|showColumns|hideColumns|showRows|hideRows|autoResizeColumns|autoResizeColumn|protect|activate|clearDataValidations|clearNote|clearConditionalFormatRules|createFilter|setDataValidations|clearFormats|setFrozenRows|setFrozenColumns|setFontLine|setTextRotation|setDescription|setWarningOnly)$/;
function looks(obj) {
  const p = new Proxy(obj, { get(t, k) {
    if (k in t || typeof k === 'symbol') return t[k];
    if (LOOKS.test(String(k))) return () => p;
    if (k === 'getFilter' || k === 'getDataValidation') return () => null;
    if (k === 'getMergedRanges') return () => [];
    if (k === 'getCharts' || k === 'getConditionalFormatRules' || k === 'getProtections' || k === 'getDataValidations' || k === 'getNamedRanges' || k === 'getBandings') return () => [];
    // グラフも見た目だけ（作る・置く・外すは何もしない）
    if (k === 'newChart') { const b = new Proxy({}, { get: (x, kk) => (kk === 'build' ? () => ({}) : () => b) }); return () => b; }
    if (k === 'insertChart' || k === 'removeChart' || k === 'updateChart') return () => p;
    if (k === 'isSheetHidden') return () => !!t.__hidden;
    if (k === 'hideSheet') return () => { t.__hidden = true; return p; };
    if (k === 'showSheet') return () => { t.__hidden = false; return p; };
    if (k === 'getFrozenRows' || k === 'getFrozenColumns') return () => 0;
    return undefined;
  } });
  return p;
}
export function makeSheet(name, { strict = false, rows: maxR = 1000, cols: maxC = 26 } = {}) {
  const rows = [];
  const fmls = [];
  const fmts = [];
  let maxRows = maxR;
  let maxCols = maxC;
  const sheetId = ++SHEET_SEQ;
  const at = (arr, r, c, d) => (arr[r] && arr[r][c] !== undefined ? arr[r][c] : d);
  const put = (arr, r, c, v) => { (arr[r] = arr[r] || [])[c] = v; };
  // 表示形式（2026-10-02 に本物で確かめた振る舞いに合わせる）:
  //   形式を付けていないセル（undefined）… 日付なら空、それ以外は「自動」（0.###############）と返す
  //   「自動」を明示したセル（General）… 何が入っていても 0.############### と返す
  //   clearFormat … 「自動」を明示したのと同じになる（形式を付けていないセルには戻らない）
  //   空の形式は設定できない（setNumberFormat('') は止まる）
  const AUTO = '0.###############';
  const storedFmt = (r, c) => at(fmts, r, c, undefined);
  const fmtAt = (r, c) => {   // 本物の getNumberFormats が返す形式
    const f = storedFmt(r, c);
    if (f === undefined) return isDate(at(rows, r, c, '')) ? '' : AUTO;
    return f === 'General' ? AUTO : f;
  };
  const normFmt = (f) => { if (f === '') throw new Error('Invalid number format pattern: (empty)'); return f; };
  const evalFormula = (f) => {
    // 縦の SUM（=SUM(H29:H40)）だけを足し算に開く（旧来の OUTPUT の予算の数式）
    f = f.replace(/SUM\(([A-Z]+)(\d+):\1(\d+)\)/g, (_, col, a, b) => '(' + Array.from({ length: +b - +a + 1 }, (x, i) => col + (+a + i)).join('+') + ')');
    const expr = f.slice(1).replace(/[A-Z]+\d+/g, (a1) => { const [r, c] = parseA1(a1); const v = at(rows, r - 1, c - 1, ''); return typeof v === 'number' ? String(v) : '0'; });
    if (!/^[\d+\-*/().\s]+$/.test(expr)) return '#ERROR!';
    return Function('return (' + expr + ')')();
  };
  function writeCell(r, c, v) {
    if (sh.strict) {
      assert.equal(typeof v, 'string', 'データ本体とログには文字列だけを書く');
      assert.equal(storedFmt(r, c), '@', 'データ本体とログは書式なしテキストにしてから書く');
      put(rows, r, c, v);
      return;
    }
    const fmt = storedFmt(r, c);
    put(fmls, r, c, '');
    if (typeof v === 'string') {
      let m;
      if (fmt === '@') { put(rows, r, c, v); return; }
      if (v.startsWith('=')) { put(fmls, r, c, v); put(rows, r, c, evalFormula(v)); return; }
      if ((m = /^(\d{4})[/-](\d{1,2})(?:[/-](\d{1,2}))?$/.exec(v))) { put(rows, r, c, new Date(+m[1], +m[2] - 1, m[3] ? +m[3] : 1)); return; }
      if (/^-?\d+(\.\d+)?$/.test(v)) { put(rows, r, c, Number(v)); return; }
      if (v === 'TRUE' || v === 'FALSE') { put(rows, r, c, v === 'TRUE'); return; }
      put(rows, r, c, v);
      return;
    }
    // 書式なしテキストのセルに日付を書くと通し番号の文字列になる、と厳しめに仮定する（本物で違っても直し方は同じ）
    if (isDate(v) && fmt === '@') { put(rows, r, c, String(serialOf(v))); return; }
    put(rows, r, c, v === null || v === undefined ? '' : v);
  }
  const lastIndex = (pred) => { let last = 0; for (let r = 0; r < rows.length || r < fmls.length; r++) last = Math.max(last, pred(r)); return last; };
  const sh = {
    rows, fmls, fmts, name, strict, failWrites: false,
    getName: () => sh.name,
    setName: (n) => { sh.name = n; return sh; },
    getSheetId: () => sheetId,
    getMaxRows: () => maxRows,
    getMaxColumns: () => maxCols,
    getLastRow: () => lastIndex((r) => {
      const row = rows[r] || []; const fr = fmls[r] || [];
      return row.some((v) => !empty(v)) || fr.some(Boolean) ? r + 1 : 0;
    }),
    getLastColumn: () => {
      let last = 0;
      for (let r = 0; r < rows.length; r++) (rows[r] || []).forEach((v, c) => { if (!empty(v)) last = Math.max(last, c + 1); });
      for (let r = 0; r < fmls.length; r++) (fmls[r] || []).forEach((f, c) => { if (f) last = Math.max(last, c + 1); });
      return last;
    },
    insertRowsAfter: (after, n) => { [rows, fmls, fmts].forEach((a) => { if (a.length > after) a.splice(after, 0, ...Array.from({ length: n }, () => [])); }); maxRows += n; },
    insertColumnsAfter: (after, n) => { [rows, fmls, fmts].forEach((a) => a.forEach((row) => { if (row && row.length > after) row.splice(after, 0, ...Array(n).fill(undefined)); })); maxCols += n; },
    deleteRows: (start, n) => { assert.ok(start + n - 1 <= maxRows); [rows, fmls, fmts].forEach((a) => a.splice(start - 1, n)); maxRows -= n; },
    deleteColumns: (start, n) => { assert.ok(start + n - 1 <= maxCols); [rows, fmls, fmts].forEach((a) => a.forEach((row) => row && row.splice(start - 1, n))); maxCols -= n; },
    setFrozenRows: () => {},
    getDataRange: () => sh.getRange(1, 1, Math.max(1, sh.getLastRow()), Math.max(1, sh.getLastColumn())),
    appendRow: (vals) => { sh.getRange(sh.getLastRow() + 1, 1, 1, vals.length).setValues([vals]); return sh; },
    clear: () => { rows.length = 0; fmls.length = 0; fmts.length = 0; return sh; },   // シート全体を消すと、形式を付けていない状態に戻る
    /** 別のスプレッドシートへ写す（本物と同じく「（名前）のコピー」という名前で足す） */
    copyTo(dest) {
      const c = dest.insertSheet(sh.name + ' のコピー', { rows: maxRows, cols: maxCols, strict: dest.strict });
      rows.forEach((r, i) => { if (r) c.rows[i] = r.slice(); });
      fmls.forEach((r, i) => { if (r) c.fmls[i] = r.slice(); });
      fmts.forEach((r, i) => { if (r) c.fmts[i] = r.slice(); });
      return c;
    },
    /** テスト用: 変換なしでそのまま中身を置く（旧ブックの今の状態を作る） */
    load({ values = [], formats = {}, cellFormats = {}, formulas = {} } = {}) {
      values.forEach((row, r) => row.forEach((v, c) => put(rows, r, c, v)));
      Object.entries(formats).forEach(([key, f]) => {
        const c = /^\d+$/.test(key) ? Number(key) - 1 : colOf(key) - 1;
        for (let r = 0; r < maxRows; r++) put(fmts, r, c, f);
      });
      Object.entries(cellFormats).forEach(([a1, f]) => { const [r, c] = parseA1(a1); put(fmts, r - 1, c - 1, f === null ? undefined : f); });   // null = 形式を付けていないセル
      Object.entries(formulas).forEach(([a1, f]) => { const [r, c] = parseA1(a1); put(fmls, r - 1, c - 1, f); put(rows, r - 1, c - 1, evalFormula(f)); });
      return sh;
    },
    getRange(a, b, c, d) {
      let r, col, nr, nc;
      if (typeof a === 'string') [r, col, nr, nc] = parseA1(a, maxRows); else [r, col, nr, nc] = [a, b, c === undefined ? 1 : c, d === undefined ? 1 : d];
      if (r < 1 || col < 1 || nr < 1 || nc < 1 || r + nr - 1 > maxRows || col + nc - 1 > maxCols) {
        throw new Error('The coordinates of the range are outside the dimensions of the sheet. ' + sh.name + ' ' + [r, col, nr, nc].join(','));
      }
      const each = (fn) => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) fn(r - 1 + i, col - 1 + j, i, j); };
      const grid = (fn) => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => fn(r - 1 + i, col - 1 + j)));
      let range = {
        getValues: () => { stat(sh, 'reads', nr * nc); return grid((y, x) => at(rows, y, x, '')); },
        getValue: () => at(rows, r - 1, col - 1, ''),
        getNumRows: () => nr, getNumColumns: () => nc, getRow: () => r, getColumn: () => col, getLastRow: () => r + nr - 1, getLastColumn: () => col + nc - 1,
        createTextFinder: (text) => {
          const tf = { entire: false, kase: false, matchEntireCell: (b) => { tf.entire = b; return tf; }, matchCase: (b) => { tf.kase = b; return tf; },
            findAll: () => { const out = []; each((y, x) => { const v = String(at(rows, y, x, '')); const t = String(text);
              const hit = tf.entire ? (tf.kase ? v === t : v.toLowerCase() === t.toLowerCase()) : (tf.kase ? v.indexOf(t) >= 0 : v.toLowerCase().indexOf(t.toLowerCase()) >= 0);
              if (hit && v !== '') out.push({ getRow: () => y + 1, getColumn: () => x + 1 }); }); stat(sh, 'reads', 0); return out; } };
          return tf;
        },
        getNotes: () => grid(() => ''),
        getNote: () => '',
        getFormulas: () => grid((y, x) => at(fmls, y, x, '') || ''),
        getNumberFormats: () => grid((y, x) => fmtAt(y, x)),
        setNumberFormat: (f) => { if (sh.strict) assert.equal(f, '@', 'データ本体とログは書式なしテキスト'); each((y, x) => put(fmts, y, x, normFmt(f))); return range; },
        setNumberFormats: (fs) => { assert.equal(fs.length, nr); each((y, x, i, j) => put(fmts, y, x, normFmt(fs[i][j]))); return range; },
        clearFormat: () => { each((y, x) => put(fmts, y, x, 'General')); return range; },
        /** 形式だけを写す（PASTE_FORMAT）。形式を付けていないセルから写すと、付けていない状態になる */
        copyTo(dest, type) {
          assert.equal(type, 'PASTE_FORMAT', 'モックは形式だけの写しに対応');
          const f = storedFmt(r - 1, col - 1);
          dest.__each((y, x) => { if (f === undefined) { if (dest.__sheet.fmts[y]) dest.__sheet.fmts[y][x] = undefined; } else put(dest.__sheet.fmts, y, x, f); });
          return range;
        },
        __each: (fn) => each((y, x) => fn(y, x)),
        __sheet: sh,
        clearContent: () => { each((y, x) => { put(rows, y, x, ''); put(fmls, y, x, ''); }); return range; },
        setValues(vals) {
          if (sh.failWrites) throw new Error('write failed');
          if (vals.length !== nr || vals.some((v) => v.length !== nc)) throw new Error('The number of rows or columns in the data does not match the range.');
          stat(sh, 'writes', nr * nc);
          each((y, x, i, j) => writeCell(y, x, vals[i][j]));
          return range;
        },
        setValue(v) { if (sh.failWrites) throw new Error('write failed'); each((y, x) => writeCell(y, x, v)); return range; },
        setFormula(f) { assert.ok(!sh.strict); each((y, x) => { put(fmls, y, x, f); put(rows, y, x, evalFormula(f)); }); return range; },
        setFormulas(fs) {
          assert.ok(!sh.strict);
          if (fs.length !== nr || fs.some((row) => row.length !== nc)) throw new Error('The number of rows or columns in the data does not match the range.');
          each((y, x, i, j) => { put(fmls, y, x, fs[i][j]); put(rows, y, x, evalFormula(fs[i][j])); });
          return range;
        },
      };
      range = looks(range);   // 値・形式の操作の続き（.setNumberFormat(..).setHorizontalAlignment(..)）でも見た目の操作を受ける
      return range;
    },
  };
  return looks(sh);
}

export function makeSpreadsheet(id, name, { strict = false } = {}) {
  const sheets = [makeSheet('シート1', { strict })];
  let locale = 'ja_JP';
  let tz = 'Asia/Tokyo';
  const ss = {
    id, name, sheets, strict,
    getId: () => id, getName: () => name, getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id,
    getSheetByName: (n) => sheets.find((s) => s.name === n) || null,
    getSheets: () => sheets.slice(),
    insertSheet(n, opts) { assert.ok(!sheets.some((s) => s.name === n), 'シート名の重複'); const s = makeSheet(n, Object.assign({ strict }, opts)); sheets.push(s); return s; },
    deleteSheet(s) { if (sheets.length === 1) throw new Error('最後のシートは消せない'); sheets.splice(sheets.indexOf(s), 1); },
    getSpreadsheetLocale: () => locale, setSpreadsheetLocale: (l) => { locale = l; },
    getSpreadsheetTimeZone: () => tz, setSpreadsheetTimeZone: (t) => { tz = t; },
    // 裏の処理（トリガー）には画面がないので、本物ではトーストが止められる。表示の切り替えも厳しめに止める
    toast: () => { throw new Error('Cannot call SpreadsheetApp.showNotification() from this context.'); },
    setActiveSheet: () => { throw new Error('Cannot call setActiveSheet from this context (mock).'); },
    moveActiveSheet: () => { throw new Error('Cannot call moveActiveSheet from this context (mock).'); },
  };
  return ss;
}

export function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  let depth = 0;
  for (let p = src.indexOf('{', start); p < src.length; p++) {
    if (src[p] === '{') depth++;
    else if (src[p] === '}' && --depth === 0) return src.slice(start, p + 1);
  }
  throw new Error(`${name} not closed`);
}

/** 新アプリのコードを GAS のモックの上で読み込む */
/**
 * テストだけで使う関数（アプリには無い）。vm の中で、アプリのコードの後に読む。
 * appEngCompare_: 2 つのシートの読み取り（appSheetSnapshot_ / appEngDecodeSheet_ の形）が同じか。違うセルの A1 を返す
 * appTestSeedPlan_: 見本のブックの CONFIG（B2 クライアント・B3 年度・B4 担当者）とシートから、計画 1 つ分をデータ本体に書く
 * appTestPlanHash_: 計画の今の指紋（画面を開いたときの inputHash と同じ）
 * appTestVersionSubmit_ / appTestVersionDecide_: 画面と同じく、開いたときの指紋（inputHash）・行の版（rowVersion）を添えて公式版を出す・判断する
 *   （画面は必ず渡す。2026-10-13 から必須。省いたときを確かめるテストは apiVersionSubmit / apiVersionDecide を直接呼ぶ）
 */
const TEST_SUPPORT = `
function appEngCompare_(snap, dec) {
  const bad = [];
  ['maxRows', 'maxCols', 'lastRow', 'lastCol', 'fmtCols'].forEach(k => { if (snap[k] !== dec[k]) bad.push(k); });
  for (let r = 0; r < snap.lastRow; r++) {
    for (let c = 0; c < snap.lastCol; c++) {
      const f = (snap.formulas[r] && snap.formulas[r][c]) || '';
      if (f ? f !== dec.formulas[r][c] : !appCellSame_(snap.values[r][c], dec.values[r][c])) bad.push(appA1_(r, c));
    }
  }
  for (let r = 0; r < snap.maxRows; r++) {
    for (let c = 0; c < snap.fmtCols; c++) {
      if (String((snap.formats[r] || [])[c] || '') !== dec.formats[r][c]) { bad.push('format ' + appA1_(r, c)); break; }
    }
  }
  return bad;
}
function appTestPlanHash_(planId) {
  APP_STORE_CACHE_ = {};
  return appPlanInputHash_(planId);
}
function appTestVersionSubmit_(input) {
  const i = Object.assign({}, input || {});
  if (i.inputHash === undefined && i.planId) { try { i.inputHash = appTestPlanHash_(i.planId); } catch (e) { /* 計画が無い: 入口が断る */ } }
  return apiVersionSubmit(i);
}
function appTestVersionDecide_(input) {
  const i = Object.assign({}, input || {});
  if (i.rowVersion === undefined) {
    APP_STORE_CACHE_ = {};
    const v = appVersionTable_().filter(x => x.version_id === String(i.versionId || ''))[0];
    if (v) i.rowVersion = v.row_version;
  }
  return apiVersionDecide(i);
}
function appTestSeedPlan_(book) {
  const ctx = { actor: Session.getActiveUser().getEmail() || 'test', requestId: 'TEST' };
  return appWithLock_(() => {
    const config = book.getSheetByName('CONFIG');
    const clientName = String(config.getRange('B2').getValue()).trim();
    const fy = Number(config.getRange('B3').getValue());
    const people = String(config.getRange('B4').getValue() || '');
    const now = appNowIso_();
    const planId = appId_('PL');
    const ops = [];
    const normalized = appNormalizeName_(clientName);
    let client = appReadTable_('CLIENTS').filter(c => c.normalized_name === normalized)[0];
    if (!client) {
      client = { client_id: appId_('CL'), client_name: clientName, zac_code: '', normalized_name: normalized, aliases_json: '[]', is_active: true, note: '',
        created_at: now, created_by: ctx.actor, updated_at: now, updated_by: ctx.actor, row_version: 1 };
      ops.push({ table: 'CLIENTS', mode: 'ensure', rows: [client] });
    }
    const encoded = Object.keys(APP_ENGINE_SHEETS).filter(n => book.getSheetByName(n)).map(n => {
      const reg = APP_ENGINE_SHEETS[n];
      return appEngEncodeSheet_(planId, appSheetSnapshot_(book.getSheetByName(n), reg.header ? reg.header.length : 0));
    });
    Object.keys(APP_ENGINE_SHEETS).filter(n => APP_ENGINE_SHEETS[n].mode === 'table').forEach(name => {
      const enc = encoded.filter(e => e.sheetRow.sheet === name)[0];
      ops.push(appOpReplacePlan_('ENG_' + name, planId, null, enc && enc.sheetRow.mode === 'table' ? enc.tableRows : []));
    });
    ops.push(appOpReplacePlan_('ENG_ROWS', planId, null, [].concat.apply([], encoded.map(e => e.rowSegs))));
    ops.push(appOpReplacePlan_('ENG_FORMATS', planId, null, [].concat.apply([], encoded.map(e => e.formatRows))));
    ops.push(appOpReplacePlan_('ENG_SHEETS', planId, null, encoded.map(e => Object.assign({}, e.sheetRow, { updated_at: now, updated_by: ctx.actor }))));
    ops.push({ table: 'PLANS', mode: 'ensure', rows: [{ plan_id: planId, client_id: client.client_id, fy: String(fy), client_label: clientName, people_csv: people,
      source_book_id: '', locale: book.getSpreadsheetLocale(), time_zone: book.getSpreadsheetTimeZone(), state: 'ACTIVE', note: '',
      created_at: now, created_by: ctx.actor, updated_at: now, updated_by: ctx.actor, row_version: 1 }] });
    appJournalRun_(ctx, 'テストの計画', planId, ops);
    return planId;
  });
}
`;

export function makeEnv({ owner = OWNER, active = owner, order = 'name' } = {}) {
  const state = { active, owner, locks: 0, lockHeld: false, uuid: 0, clock: Date.now() - 1e9, seq: 0,
    mail: [],          // 送ったメール { to, subject, body }（実際には何も送らない）
    mailQuota: undefined,   // その日の残りの送信枠（undefined なら十分ある）
    mailFail: undefined,   // true か関数（宛先ごとに失敗させる）で送信を失敗させる
    scopeRequests: [] };   // ScriptApp.requireScopes の呼び出しの記録（本物の許可はしない）
  const props = {};
  const cache = {};
  const files = {};
  const sheetsById = {};
  const triggers = [];
  const logs = [];
  const newId = (p) => p + '-' + String(++state.seq).padStart(24, '0');
  const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  const strictName = (n) => /^Trends2Targets_(Data|Logs_)/.test(n);
  function newSpreadsheet(name) {
    const ss = makeSpreadsheet(newId('SS'), name, { strict: strictName(name) });
    sheetsById[ss.id] = ss;
    return ss;
  }
  function makeFolder(name, parent) {
    const f = { kind: 'folder', id: newId('FOLDER'), name, parent, trashed: false };
    Object.assign(f, {
      getId: () => f.id, getName: () => f.name, getUrl: () => 'https://drive.google.com/drive/folders/' + f.id,
      createFolder: (n) => makeFolder(n, f.id),
      getFoldersByName: (n) => iter(Object.values(files).filter((x) => x.kind === 'folder' && x.parent === f.id && x.name === n)),
      // 文字のファイル（保存の控え）。本物と同じく、中身は getBlob().getDataAsString() で読む
      createFile: (n, content, mime) => {
        const x = makeFile(newId('FILE'), n, f.id);
        x.mime = mime || 'text/plain';
        x.content = String(content);
        x.getBlob = () => ({ getDataAsString: () => x.content });
        return x;
      },
      // 本物と同じく、ゴミ箱のファイルも一覧に出す
      getFilesByType: (mime) => iter(Object.values(files).filter((x) => x.kind === 'file' && x.parent === f.id && x.mime === mime)),
      getFilesByName: (n) => iter(Object.values(files).filter((x) => x.kind === 'file' && x.parent === f.id && x.name === n)),
    });
    files[f.id] = f;
    return f;
  }
  function makeFile(id, name, parent) {
    const f = { kind: 'file', id, name, mime: SHEETS_MIME, parent, trashed: false, created: new Date(state.clock += 60000) };
    Object.assign(f, {
      getId: () => f.id, getName: () => f.name, getUrl: () => 'https://docs.google.com/spreadsheets/d/' + f.id + '/edit', setName: (n) => { f.name = n; return f; }, getDateCreated: () => f.created, isTrashed: () => f.trashed, getMimeType: () => f.mime,
      getLastUpdated: () => f.updated || f.created,
      setTrashed: (b) => { f.trashed = !!b; return f; },
      moveTo: (folder) => { f.parent = folder.getId(); return f; },
      getParents: () => iter(f.parent && files[f.parent] ? [files[f.parent]] : []),
      makeCopy: (n, folder) => {
        const src = sheetsById[id];
        const copy = newSpreadsheet(n);
        copy.sheets.splice(0, copy.sheets.length, ...src.sheets.map((s) => {
          const c = makeSheet(s.name, { strict: s.strict, rows: s.getMaxRows(), cols: s.getMaxColumns() });
          s.rows.forEach((r, i) => { c.rows[i] = (r || []).slice(); });
          s.fmts.forEach((r, i) => { c.fmts[i] = (r || []).slice(); });
          return c;
        }));
        return makeFile(copy.id, n, folder.getId());
      },
    });
    files[id] = f;
    return f;
  }
  const env = {
    Logger: { log: (m) => logs.push(String(m)) },
    Session: { getActiveUser: () => ({ getEmail: () => state.active }), getEffectiveUser: () => ({ getEmail: () => state.owner }), getScriptTimeZone: () => 'Asia/Tokyo' },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => {
          // 本物の上限: 値 1 つ 9KB、全体 500KB
          assert.ok(String(v).length <= 9 * 1024, 'Script Properties の値は 9KB まで: ' + k);
          props[k] = String(v);
          assert.ok(Object.entries(props).reduce((a, [kk, vv]) => a + kk.length + vv.length, 0) <= 500 * 1024, 'Script Properties は全体で 500KB まで');
        },
        deleteProperty: (k) => { delete props[k]; },
        getKeys: () => Object.keys(props),
        getProperties: () => Object.assign({}, props),   // 本物と同じく写しを返す（書き換えても元は変わらない）
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        put: (k, v, ttl) => { assert.ok(Buffer.byteLength(String(v), 'utf8') <= 100 * 1024, 'CacheService の値は 100KB（バイト）まで'); assert.ok(ttl <= 21600); cache[k] = String(v); },
        get: (k) => (k in cache ? cache[k] : null),
        remove: (k) => { delete cache[k]; },
        getAll: (ks) => Object.fromEntries(ks.filter((k) => k in cache).map((k) => [k, cache[k]])),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock() { if (state.lockHeld) throw new Error('ロックを二重に取ろうとした'); state.lockHeld = true; state.locks++; },
        releaseLock() { state.lockHeld = false; },
      }),
    },
    SpreadsheetApp: {
      CopyPasteType: { PASTE_FORMAT: 'PASTE_FORMAT', PASTE_VALUES: 'PASTE_VALUES', PASTE_NORMAL: 'PASTE_NORMAL' },
      create(name) { const ss = newSpreadsheet(name); makeFile(ss.id, name, 'ROOT'); return ss; },
      openById(id) { if (!sheetsById[id]) throw new Error('not found ' + id); return sheetsById[id]; },
      flush() {},
      // 入力規則・枠線などの見た目の部品（何もしない）
      newDataValidation() { const b = new Proxy({}, { get: (t, k) => (k === 'build' ? () => ({}) : () => b) }); return b; },
      BorderStyle: { SOLID: 'SOLID', SOLID_MEDIUM: 'SOLID_MEDIUM', DOTTED: 'DOTTED', DASHED: 'DASHED' },
      WrapStrategy: { WRAP: 'WRAP', CLIP: 'CLIP', OVERFLOW: 'OVERFLOW' },
    },
    DriveApp: {
      createFolder: (name) => makeFolder(name, 'ROOT'),
      getFolderById: (id) => { if (!files[id] || files[id].kind !== 'folder') throw new Error('no folder ' + id); return files[id]; },
      getFileById: (id) => { if (!files[id] || files[id].kind !== 'file') throw new Error('no file ' + id); return files[id]; },
    },
    MailApp: {
      getRemainingDailyQuota: () => (state.mailQuota === undefined ? 500 : state.mailQuota),
      sendEmail: (to, subject, body) => {
        const fail = typeof state.mailFail === 'function' ? state.mailFail(to) : state.mailFail;
        if (fail) throw new Error('メールを送れません（テストで失敗させています）');
        if (state.mailQuota !== undefined) {
          if (state.mailQuota <= 0) throw new Error('その日の送信枠がありません（テスト）');
          state.mailQuota--;
        }
        state.mail.push({ to: String(to), subject: String(subject), body: String(body) });
      },
    },
    MimeType: { GOOGLE_SHEETS: SHEETS_MIME, PLAIN_TEXT: 'text/plain' },
    ScriptApp: {
      AuthMode: { FULL: 'FULL' },
      requireScopes: (mode, scopes) => { state.scopeRequests.push({ mode, scopes: scopes.slice() }); },
      getProjectTriggers: () => triggers.map((t) => ({ getUniqueId: () => t.uid, getHandlerFunction: () => t.handler })),
      newTrigger(handler) {
        const t = { handler, uid: String(9000000000 + (++state.seq)) };
        const b = { timeBased: () => b, everyDays: (n) => { t.everyDays = n; return b; }, atHour: (h) => { t.atHour = h; return b; },
          after: (ms) => { t.afterMs = ms; return b; }, nearMinute: (m) => { t.nearMinute = m; return b; },
          create: () => { assert.ok(triggers.length < 20, 'トリガーは 1 人 1 プロジェクト 20 個まで'); triggers.push(t); return { getUniqueId: () => t.uid, getHandlerFunction: () => t.handler }; } };
        return b;
      },
      deleteTrigger(t) { const i = triggers.findIndex((x) => x.uid === t.getUniqueId()); if (i >= 0) triggers.splice(i, 1); },
    },
    HtmlService: {
      createTemplateFromFile(name) {
        assert.equal(name, 'UI');
        const t = {
          evaluate() {
            const html = uiHtml.replace(/<\?!=\s*(\w+)\s*\?>/g, (_, k) => { if (!(k in t)) throw new Error('template: ' + k); return String(t[k]); });
            const out = { html, title: '', favicon: '', metas: [] };
            Object.assign(out, {
              setTitle: (x) => { out.title = x; return out; },
              addMetaTag: (n, c) => { out.metas.push([n, c]); return out; },
              // 本物は画像の拡張子で終わらない URL を受け付けない
              setFaviconUrl: (u) => { if (!/\.(png|ico|gif|jpe?g)$/i.test(u)) throw new Error('Invalid argument: url'); out.favicon = u; return out; },
              getContent: () => html,
            });
            return out;
          },
        };
        return t;
      },
    },
    Utilities: {
      getUuid: () => (++state.uuid).toString(16).padStart(8, '0') + '-0000-4000-8000-000000000000',
      sleep: () => {},   // 待たない（待ちの長さを確かめるテストは、待つ関数そのものを差し替える）
      formatDate: fmtDate,
      DigestAlgorithm: { SHA_256: 'sha256', MD5: 'md5', SHA_1: 'sha1' }, Charset: { UTF_8: 'utf8' },
      base64Encode: (b) => Buffer.from(typeof b === 'string' ? b : b.map((x) => x & 255)).toString('base64'),
      base64EncodeWebSafe: (b) => Buffer.from(typeof b === 'string' ? b : b.map((x) => x & 255)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      computeDigest: (alg, s, cs) => {
        // 新アプリは必ず SHA-256 と UTF-8 を指定する。旧来の計算は文字コードを省くことがある（そのときも UTF-8 として扱う）
        assert.ok(['sha256', 'md5', 'sha1'].includes(alg)); assert.ok(cs === 'utf8' || cs === undefined);
        return Array.from(createHash(alg).update(String(s), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b));
      },
    },
  };
  const ctx = vm.createContext(env);
  const names = order === 'reverse' ? [...jsFiles].reverse() : jsFiles;
  for (const n of names) vm.runInContext(sources[n], ctx, { filename: n });
  vm.runInContext(TEST_SUPPORT, ctx, { filename: 'test-support.js' });
  const run = (code, extra) => { Object.assign(ctx, extra || {}); return vm.runInContext(code, ctx); };
  const call = (code, extra) => J(run(code, extra));
  const as = (email) => { state.active = email; };
  const data = () => sheetsById[props.APP_DATA_SPREADSHEET_ID];
  const log = () => sheetsById[JSON.parse(props.APP_LOG_SPREADSHEETS_JSON || '{}')[FY]];
  const objects = (sh) => (sh ? sh.rows.slice(1).filter((r) => r && r.some((v) => !empty(v))).map((r) => Object.fromEntries(sh.rows[0].map((h, j) => [h, r[j] ?? '']))) : []);
  /** 旧ブック（strict でない）を作る。sheets = { 名前: { values, formats, formulas, rows, cols } } */
  const makeBook = (name, sheets) => {
    const ss = makeSpreadsheet(newId('BOOK'), name);
    sheetsById[ss.id] = ss;
    makeFile(ss.id, name, 'ROOT');
    ss.sheets.splice(0, ss.sheets.length);
    Object.entries(sheets).forEach(([n, spec]) => {
      const s = makeSheet(n, { rows: spec.rows || 1000, cols: spec.cols || 26 });
      ss.sheets.push(s);
      s.load(spec);
    });
    return ss;
  };
  /** 1 回だけのトリガーを動かす（本物と同じく、トリガーの中では操作者のメールが空のこともある） */
  const fireTriggers = (handler, { email = '', dropFirst = false } = {}) => {
    const due = triggers.filter((t) => t.handler === handler && t.afterMs !== undefined);
    const prev = state.active;
    state.active = email;
    try {
      return due.map((t) => {
        if (dropFirst) { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); }   // 本物で一覧から先に消えている場合
        return J(run(`${handler}({ triggerUid: '${t.uid}' })`));
      });
    } finally { state.active = prev; }
  };
  /** 処理を始めて、トリガーで動かし、結果を受け取る（続きの処理があればそれも動かす） */
  const runJob = (kind, payload, opts) => {
    // 画面と同じく、計画への保存には開いたときの指紋（inputHash）を添える（画面は必ず渡す。2026-10-13 から必須。省いたときを確かめるテストは apiStartJob を直接呼ぶ）
    if (kind === 'PLAN.EDIT' && payload && payload.inputHash === undefined && payload.planId) payload = Object.assign({}, payload, { inputHash: run('appTestPlanHash_(__pid)', { __pid: payload.planId }) });
    let id = call('apiStartJob(__in)', { __in: { kind, payload } }).jobId;
    for (let i = 0; i < 60; i++) {   // 組み立てが何回かに分かれても最後まで
      fireTriggers('triggerRunJob', opts);
      const st = call('apiJobStatus(__in)', { __in: { jobId: id } });
      if (st.status === 'CONTINUED') { id = st.nextJobId; continue; }
      if (st.status === 'QUEUED' || st.status === 'RUNNING') { id = st.jobId; continue; }   // 終わった段はサーバーがたどる。次の段を待つ
      return st;
    }
    throw new Error('続きの処理が終わらない');
  };
  /** テスト用の計画を、見本のブック（makeBook）の中身で作る（データ本体に直接。計画の ID を返す） */
  const seedPlan = (book) => run('appTestSeedPlan_(__book)', { __book: book });
  /**
   * 所有者の操作（apiOwnerTask。エディタからの実行と同じ経路）を、今の人のまま動かし、結果（result）を返す。
   * expr は 'saveMember({ email: … })' の形（OwnerTask.js の操作の名前と項目。項目は vm の中で読むので、extra で値を差し込める）。
   * 管理の入口（apiSaveMember など）は画面の入口から外した（2026-10-13）ので、テストの管理の操作はこの経路で動かす。失敗は投げる
   */
  const task = (expr, extra) => {
    const m = /^\s*([A-Za-z]+)\(([\s\S]*)\)\s*$/.exec(expr);
    if (!m) throw new Error('task: 形が読めない: ' + expr);
    const input = m[2].trim() ? J(run('(' + m[2] + ')', extra)) : {};
    props.OWNER_TASK = JSON.stringify(Object.assign({ action: m[1] }, input || {}));
    return call('apiOwnerTask()').result;
  };
  /** 画面の初期データ（doGet と同じ判定・同じ中身。開いたときのトリガーの確かめはしない） */
  const boot = () => call("api_('APP.BOOTSTRAP', { minRole: 'VIEWER', audit: false, allowAnonymousView: true }, ctx => appBootstrap_(ctx))");
  return {
    ctx, state, props, cache, files, sheetsById, triggers, logs, run, call, as, data, log, makeBook, fireTriggers, runJob, seedPlan, task, boot,
    table: (name) => objects(data().getSheetByName(name)),
    auditSheet: () => log().getSheetByName('AUDIT_' + MONTH),
    audit: () => objects(log() && log().getSheetByName('AUDIT_' + MONTH)),
    runLog: () => objects(log() && log().getSheetByName('RUN_' + MONTH)),
    errors: () => objects(log() && log().getSheetByName('ERROR_' + MONTH)),
    backups: () => Object.values(files).filter((f) => f.kind === 'file' && f.parent === props.APP_BACKUP_FOLDER_ID),
    scratch: () => sheetsById[props.APP_SCRATCH_SPREADSHEET_ID],
  };
}

export function setUpEnv(opts) {
  const env = makeEnv(opts);
  env.as(OWNER);
  env.call('apiSetup()');
  return env;
}
