#!/usr/bin/env node
/*
 * forecast-calibration-fixes.test.mjs — 旧来の計算の直し（2026-10-04）を Node で確かめる。
 *   1. CALIBRATION_STATE の 0（自動学習を止める・係数）を 1 にしない
 *   2. 検証（B-2）は、実績の締まった月の記録（予測 = 実績）を使わず、締まる前の最後の予測を使う
 *   4. P10/P90 はクライアントごと
 *   node tests/forecast-calibration-fixes.test.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = await readFile(path.join(root, 'Forecast_Agent.js'), 'utf8');
function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  let depth = 0;
  for (let p = src.indexOf('{', start); p < src.length; p++) {
    if (src[p] === '{') depth++;
    else if (src[p] === '}') { depth--; if (depth === 0) return src.slice(start, p + 1); }
  }
  throw new Error(name + ' not closed');
}
// 'yyyy-MM-dd' は検証の決まり（その月が始まる前の回か。2026-10-07 D6）で使う日本の暦の日
const ctx = vm.createContext({ TZ: 'Asia/Tokyo', Utilities: { formatDate: (d, tz, f) => (f === 'yyyy-MM-dd'
  ? new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10) : d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0')) } });
vm.runInContext([...(src.match(/^const EVAL_CALENDAR_TZ = .+;.*$/gm) || []), extractFunction('calibrationNumberOr_'), extractFunction('normalizeClientName_'), extractFunction('toMonthStart_'),
  extractFunction('fmtYM_'), extractFunction('ymKey_'), extractFunction('evalTimeMs_'), extractFunction('evalJstDay_'), extractFunction('isRunBeforeMonth_'),
  extractFunction('selectEvalSnapshotRows_')].join('\n'), ctx);

// ==== 1. 0 は 0 のまま。空は既定値 ====
const num = (v, d) => vm.runInContext(`calibrationNumberOr_(${JSON.stringify(v)}, ${d})`, ctx);
assert.equal(num(0, 1), 0);
assert.equal(num('0', 1), 0);
assert.equal(num('', 1), 1);
assert.equal(num(null, 1), 1);
assert.equal(num('abc', 1), 1);
assert.equal(num(0.95, 1), 0.95);
assert.match(src, /auto_update_enabled: calibrationNumberOr_\(rows\[i\]\[idx\.auto_update_enabled\], 1\) === 1 \? 1 : 0/);
assert.doesNotMatch(src, /Number\(rows\[i\]\[idx\.(auto_update_enabled|bias_correction_factor)\] \|\| 1\)/, '0 を 1 にする書き方が残っていない');

// ==== 2. 締まった月の記録は使わない ====
// 予測した日はどの月も始まる前（2026-10-07 から、月が始まった後の回は測らない。それは tests/forecast-closed-months.test.mjs で確かめる）
const row = (sid, client, ym, sc, pred, src2) => [sid, '2025-03-01', client, ym, sc, pred, 0, 0, 0, pred, 0, 0, JSON.stringify(src2 === undefined ? { opinion: '' } : { opinion: '', forecast_source: src2 }), null, '{}'];
const run = (sid, client, ym, p50, source) => [row(sid, client, ym, 'nega', p50 * 0.9, source), row(sid, client, ym, 'neutral', p50, source), row(sid, client, ym, 'posi', p50 * 1.1, source)];
const actual = new Map([['甲製薬|2025/04', 100], ['乙製薬|2025/04', 200], ['甲製薬|2025/05', 300]]);
ctx.__actual = actual;
const pick = (rows) => { ctx.__rows = rows; return JSON.parse(vm.runInContext('JSON.stringify(selectEvalSnapshotRows_(__rows, __actual))', ctx)); };
// 古い記録（forecast_source なし）: 1 回目 110、締まった後の 2 回目 = 実績 100 → 1 回目を使う
let out = pick([...run('S1', '甲製薬', '2025/04', 110), ...run('S2', '甲製薬', '2025/04', 100)]);
assert.deepEqual(out.map((r) => r[0]), ['S1', 'S1', 'S1']);
// 新しい記録: actual_closed の回は使わない（実績とずれていても）
out = pick([...run('S1', '甲製薬', '2025/05', 280, 'forecast_open'), ...run('S2', '甲製薬', '2025/05', 300.5, 'actual_closed')]);
assert.deepEqual(out.map((r) => r[0]), ['S1', 'S1', 'S1']);
// 締まる前の回が無い月は検証しない
out = pick(run('S9', '甲製薬', '2025/04', 100));
assert.equal(out.length, 0);
// 使える回が 2 つあれば新しい方
out = pick([...run('S1', '甲製薬', '2025/04', 120), ...run('S2', '甲製薬', '2025/04', 110)]);
assert.deepEqual(out.map((r) => r[0]), ['S2', 'S2', 'S2']);
// ==== 4. クライアントごとに分ける（同じ月でも別のクライアントの回を混ぜない） ====
out = pick([...run('A1', '甲製薬', '2025/04', 110), ...run('B1', '乙製薬', '2025/04', 220)]);
assert.deepEqual([...new Set(out.map((r) => r[0]))].sort(), ['A1', 'B1']);
assert.match(src, /const key = \[normalizeClientName_\(r\[2\]\), ym\]\.join\('\|'\);   \/\/ クライアントごとに引く/);
assert.match(src, /p10Map\.has\(key\) && p90Map\.has\(key\)/);
// 新しい予測の記録に forecast_source を残す
assert.match(src, /JSON\.stringify\(\{opinion:result\.opinionsSummaryByMonth\[i\]\|\|'', forecast_source: source, history_model:/);
console.log('forecast-calibration-fixes: all tests passed');
