#!/usr/bin/env node
/** WAPE は売上 0 の月も分子に含め、負の実績は絶対値を分母に使う。 */
import assert from 'node:assert/strict';
import { setUpEnv } from './gas-mock.mjs';

const env = setUpEnv();
const summarize = (rows, clients = {}) => env.call('appBacktestSummary_(__r, __c)', { __r: rows, __c: clients });
const pt = (plan, month, method, p50, actual) => ({ plan_id: plan, target_ym: month, method, p50, actual, counted: true });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

// 2 社の WAPE と偏りを同じ重さで平均する。月数は売上 0 と返品も含める。
const rows = [];
const actuals = [100, 0, -100];
[['P1', [110, 50, -120], [130, 0, -100]], ['P2', [120, 10, -100], [140, 0, -100]]]
  .forEach(([pid, stat, lastYear]) => actuals.forEach((actual, i) => {
    rows.push(pt(pid, 'M' + i, 'STAT_ONLY', stat[i], actual), pt(pid, 'M' + i, 'LAST_YEAR', lastYear[i], actual));
  }));
const summary = summarize(rows, { P1: 'C1', P2: 'C2' });
const stat = summary.methods.find(m => m.method === 'STAT_ONLY');
assert.deepEqual([stat.n, stat.pctN, stat.makers], [6, 6, 2]);
close(stat.mape, (80 / 200 + 30 / 200) / 2);
close(stat.bias, (40 / 200 + 30 / 200) / 2);
const t = env.call('appBacktestT975_(1)');
const half = t * 0.125;   // 2 社の WAPE 0.4 と 0.15。メーカーの t 分布の幅は維持。
close(stat.mapeLo, stat.mape - half);
close(stat.mapeHi, stat.mape + half);
const compare = summary.compare.find(c => c.method === 'STAT_ONLY');
assert.deepEqual([compare.vs, compare.n, compare.makers, compare.verdict], ['LAST_YEAR', 6, 2, 'wait']);
close(compare.diff, (50 / 200 - 10 / 200) / 2);

// 比較は両方に予測のある同じ点だけ。片方だけの月を増やしても比較差と CI は変わらない。
const unpaired = summarize(rows.concat(pt('P1', 'STAT_ONLY_ONLY', 'STAT_ONLY', 99999, 100)), { P1: 'C1', P2: 'C2' });
assert.deepEqual(unpaired.compare[0], compare);
assert.equal(unpaired.methods[0].n, 7);

// 売上が全 0 のメーカーは比を作れない。点として残し、CI のメーカー数には足さない。
const zeros = [pt('P0', 'M0', 'STAT_ONLY', 100, 0), pt('P0', 'M1', 'STAT_ONLY', 0, 0)];
const onlyZero = summarize(zeros).methods[0];
assert.deepEqual([onlyZero.n, onlyZero.pctN, onlyZero.makers], [2, 2, 1]);
for (const key of ['mape', 'mapeLo', 'mapeHi', 'bias', 'biasLo', 'biasHi']) assert.equal(onlyZero[key], null, key);
const oneNonzeroMaker = summarize(zeros.concat(pt('P1', 'M0', 'STAT_ONLY', 110, 100))).methods[0];
close(oneNonzeroMaker.mape, 0.1);
assert.deepEqual([oneNonzeroMaker.makers, oneNonzeroMaker.mapeLo, oneNonzeroMaker.mapeHi], [2, null, null]);

// LIVE の比較もゼロ月を paired point として数えるが、全 0 の分母は差を言わない。
const liveZero = [];
for (let i = 0; i < 30; i++) {
  const pid = 'P' + (i % 2);
  liveZero.push(pt(pid, 'M' + i, 'LIVE', 100, 0), pt(pid, 'M' + i, 'LAST_YEAR_PACE', 0, 0));
}
const liveCompare = summarize(liveZero).compare.find(c => c.method === 'LIVE');
assert.deepEqual([liveCompare.n, liveCompare.makers, liveCompare.diff, liveCompare.lo, liveCompare.hi, liveCompare.verdict], [30, 0, null, null, null, 'wait']);

// 返品だけの系列も除外しない。符号付き偏りの分母は負にならない。
const negativeOnly = summarize([pt('P1', 'M0', 'STAT_ONLY', -110, -100), pt('P1', 'M1', 'STAT_ONLY', -90, -100)]).methods[0];
assert.equal(negativeOnly.pctN, 2);
close(negativeOnly.mape, 0.1);
close(negativeOnly.bias, 0);

console.log('app-backtest-zero-actuals: all tests passed');
