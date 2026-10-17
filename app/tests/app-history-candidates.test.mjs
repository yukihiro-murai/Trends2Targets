#!/usr/bin/env node
/** 固定した履歴候補と、未来を混ぜない内側の時系列検証。合成実績だけを使う。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../tools/history-candidates.js', import.meta.url), 'utf8'), ctx);
const call = (name, ...args) => JSON.parse(JSON.stringify(ctx[name](...args)));
const candidates = (series, horizon) => call('appHistoryCandidates_', series, horizon);
const select = series => call('appHistorySelect_', series);
const repeat = (pattern, count) => Array.from({ length: count }, () => pattern).flat();
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const names = ['LAST_YEAR', 'TWO_YEAR', 'LEVEL', 'DAMPED', 'BLEND'];

// 定常の季節性。暦月の指定がなくても配列の周期が次の年と合う。
const seasonal = Array.from({ length: 12 }, (_, i) => (i + 1) * 10);
const stable = candidates(repeat(seasonal, 2));
assert.deepEqual(Object.keys(stable), names);
for (const name of ['LAST_YEAR', 'TWO_YEAR', 'DAMPED', 'BLEND']) assert.deepEqual(stable[name], seasonal);
assert.deepEqual(stable.LEVEL, Array(12).fill(65));
const arbitraryStart = Array.from({ length: 30 }, (_, i) => i);
const partialYear = candidates(arbitraryStart, 15);
assert.deepEqual(partialYear.LAST_YEAR, arbitraryStart.slice(18).concat([18, 19, 20]));
assert.deepEqual(partialYear.TWO_YEAR.slice(0, 12), arbitraryStart.slice(12, 24));

// 成長・衰退。減衰した傾向は固定比の範囲で、12 月より先にも重ね掛けしない。
const growing = candidates(Array(12).fill(10).concat(Array(12).fill(20)), 24);
for (const v of growing.LAST_YEAR) assert.equal(v, 20);
for (const v of growing.TWO_YEAR) assert.equal(v, 15);
for (const v of growing.LEVEL) close(v, 20);
for (const v of growing.DAMPED) close(v, 20 * Math.sqrt(2));
for (const v of growing.BLEND) assert.equal(v, 17.5);
const declining = candidates(Array(12).fill(20).concat(Array(12).fill(10)));
for (const v of declining.DAMPED) close(v, 10 * Math.sqrt(0.5));
for (const v of candidates(Array(12).fill(1).concat(Array(12).fill(100))).DAMPED) close(v, 100 * Math.sqrt(2));
for (const v of candidates(Array(12).fill(100).concat(Array(12).fill(1))).DAMPED) close(v, Math.sqrt(0.5));
for (const v of candidates(Array(12).fill(0).concat(Array(12).fill(10))).DAMPED) close(v, 10 * Math.sqrt(2));

// 間欠実績は売上の無い年も含める。0 を欠測として捨てない。
const sparse = [120, ...Array(11).fill(0), ...Array(12).fill(0)];
const intermittent = candidates(sparse);
assert.deepEqual(intermittent.LAST_YEAR, Array(12).fill(0));
assert.deepEqual(intermittent.TWO_YEAR, [60, ...Array(11).fill(0)]);
assert.deepEqual(intermittent.BLEND, [30, ...Array(11).fill(0)]);
for (const prediction of Object.values(candidates(Array(48).fill(0)))) assert.deepEqual(prediction, Array(12).fill(0));

// 負値は履歴に残す。計算後にだけ非負へ丸める（数値文字列や欠測への黙示変換はしない）。
const negative = candidates(Array(12).fill(20).concat(Array(12).fill(-10)));
assert.deepEqual(negative.LAST_YEAR, Array(12).fill(0));
assert.deepEqual(negative.TWO_YEAR, Array(12).fill(5));
assert.deepEqual(negative.LEVEL, Array(12).fill(0));
assert.deepEqual(negative.DAMPED, Array(12).fill(0));
assert.deepEqual(negative.BLEND, Array(12).fill(0));

// 月次誤差と年間合計の誤差を区別。ゼロ月も 12 月として数える。
const validationSeries = Array(24).fill(0).concat([120, ...Array(11).fill(0)]);
const validation = select(validationSeries);
assert.equal(validation.folds.length, 1);
assert.deepEqual(validation.folds[0], {
  origin: 24, validationEnd: 36, actualAnnual: 120,
  scores: Object.fromEntries(names.map(name => [name, { monthlyMae: 10, annualAbsoluteError: 120 }]))
});
for (const score of Object.values(validation.scores)) assert.deepEqual(score, { foldCount: 1, monthCount: 12, monthlyMae: 10, annualMae: 120 });
const constant = select(Array(48).fill(10));
assert.deepEqual(constant.folds.map(fold => fold.origin), [24, 30, 36]);
for (const score of Object.values(constant.scores)) {
  assert.equal(score.monthCount, 36);
  close(score.monthlyMae, 0);
  close(score.annualMae, 0);
}
const zero = select(Array(48).fill(0));
for (const score of Object.values(zero.scores)) assert.deepEqual(score, { foldCount: 3, monthCount: 36, monthlyMae: 0, annualMae: 0 });

// 検証窓より後の未来を書き換えても、すでに終わった窓の採点は変わらない。
const full = Array.from({ length: 60 }, (_, i) => 10 + i % 13);
const changedFuture = full.map((v, i) => i < 48 ? v : 999999);
assert.deepEqual(select(full).folds.slice(0, 3), select(changedFuture).folds.slice(0, 3));
assert.deepEqual(candidates(full.slice(0, 48)), candidates(changedFuture.slice(0, 48)));
assert.notDeepEqual(select(full).folds.slice(3), select(changedFuture).folds.slice(3));

// 入力不変・非乱数。配列が凍結されていても繰り返し同じ結果。
const frozen = Object.freeze(repeat(seasonal, 4));
const before = JSON.stringify(frozen);
assert.deepEqual(select(frozen), select(frozen));
assert.equal(JSON.stringify(frozen), before);

// 足りない履歴を 0 で補わない。短い履歴も入力の誤りは検出する。
for (const length of [0, 1, 12, 23]) {
  assert.deepEqual(candidates(Array(length).fill(10)), {});
  assert.deepEqual(select(Array(length).fill(10)), { candidates: {}, scores: {}, folds: [] });
}
for (const length of [24, 30, 35]) {
  const r = select(Array(length).fill(10));
  assert.equal(Object.keys(r.candidates).length, 5);
  assert.deepEqual(r.scores, {});
  assert.deepEqual(r.folds, []);
}
for (const value of [NaN, Infinity, -Infinity, '10', undefined, null]) {
  assert.throws(() => candidates([value]), /有限な数/);
  assert.throws(() => select([value]), /有限な数/);
}
assert.throws(() => candidates(Array(24)), /有限な数/);
assert.throws(() => candidates('not an array'), /配列/);
for (const h of [0, -1, 1.5, NaN, Infinity, '12', null]) assert.throws(() => candidates(Array(24).fill(10), h), /予測月数/);

console.log('app-history-candidates: all tests passed');
