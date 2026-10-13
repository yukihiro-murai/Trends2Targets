#!/usr/bin/env node
/*
 * app-forecast-page.test.mjs — 予測の画面の中身をまとめて読む入口（apiForecastPage。2026-10-13 村井さん「予測など読み込みが遅すぎる」）。
 *   1. 中身は、別々の入口（apiForecastLatest・apiPlanView・apiForecastBasis・apiLearningView・apiVersionList）と同じ
 *   2. 1 回の実行で読むので、表を読む回数が別々に呼ぶより少ない（控えが空のとき）
 *   3. parts で一部だけ読める。1 つの中身で失敗しても、ほかは返す（errors に理由）
 *   4. 権限は別々の入口と同じ（社内の人だけ）
 *   5. 計画に書く処理が終わったら、その計画の画面の中身を作って控えておく（appJobWarm_。画面がすぐ読み直すときに待たない）
 * 名前と数字はテスト用の架空のもの。本物の Apps Script の上での確認の代わりではない。
 *
 *   node app/tests/app-forecast-page.test.mjs
 */
import assert from 'node:assert/strict';
import { setUpEnv, STATS, OWNER, OUTSIDER } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const env = setUpEnv();
const FY = env.run('appFy_(new Date())');
const ext = Array.from({ length: 70 }, () => '');
const rec = (client, product, month, amount) => { const r = ext.slice(); r[40] = client; r[45] = 'ベース'; r[49] = product; r[56] = month; r[65] = amount; return r; };
const zacRows = [ext.map((_, i) => 'c' + (i + 1))];
for (let m = 1; m <= 12; m++) zacRows.push(rec('甲製薬', '製品A', D(FY - 1, m, 15), 1000000));
const zac = env.makeBook('売上の元', { ['*' + (FY - 1) + '_actual_value']: { cols: 70, values: zacRows } });
env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
const st = env.runJob('PLAN.CREATE', { clientName: '甲製薬', fy: FY, peopleCsv: '鷹野' });
assert.equal(st.status, 'DONE', st.error);
const X = st.result.planId;
assert.equal(env.runJob('PLAN.RUN', { planId: X, action: 'IMPORT.SALES' }).status, 'DONE');

const clear = () => { for (const k of Object.keys(env.cache)) delete env.cache[k]; };
const reset = () => { for (const k of Object.keys(STATS)) STATS[k] = k === 'bySheet' ? {} : 0; };
const ONE = { latest: 'apiForecastLatest', view: 'apiPlanView', basis: 'apiForecastBasis', learn: 'apiLearningView', ver: 'apiVersionList' };
env.as(OWNER);

// ==== 1. 中身は別々の入口と同じ ====
{
  const page = env.call('apiForecastPage(__in)', { __in: { planId: X } });
  assert.deepEqual(page.errors, {}, '失敗なし');
  assert.equal(page.planId, X);
  for (const [k, fn] of Object.entries(ONE)) assert.deepEqual(page[k], env.call(fn + '(__in)', { __in: { planId: X } }), k + ' は ' + fn + ' と同じ');
}

// ==== 2. 控えが空のとき、表を読む回数は別々に呼ぶより少ない ====
{
  clear(); reset();
  for (const fn of Object.values(ONE)) env.call(fn + '(__in)', { __in: { planId: X } });
  const apart = STATS.reads;
  clear(); reset();
  env.call('apiForecastPage(__in)', { __in: { planId: X } });
  const together = STATS.reads;
  assert.ok(together < apart * 0.7, '表を読む回数: まとめて ' + together + ' 回・別々に ' + apart + ' 回');
  reset();
  env.call('apiForecastPage(__in)', { __in: { planId: X } });
  assert.ok(STATS.reads <= 4, '控えがあれば、ほとんど読まない: ' + STATS.reads + ' 回');
}

// ==== 3. 一部だけ・失敗した中身があっても、ほかは返す ====
{
  const two = env.call('apiForecastPage(__in)', { __in: { planId: X, parts: ['basis', 'ver'] } });
  assert.deepEqual(Object.keys(two).sort(), ['basis', 'errors', 'planId', 'ver'], '頼んだ中身だけ');
  const none = env.call('apiForecastPage(__in)', { __in: { planId: 'PL-NONE' } });
  assert.deepEqual(Object.keys(none.errors).sort(), ['basis', 'latest', 'learn', 'ver', 'view'], '無い計画は、中身ごとに理由を返す（止まらない）');
  assert.match(none.errors.latest, /計画が見つかりません/);
  env.run(`__basis0 = appForecastBasis_; appForecastBasis_ = function(){ throw new Error('根拠を作れません'); }`);
  const part = env.call('apiForecastPage(__in)', { __in: { planId: X } });
  env.run(`appForecastBasis_ = __basis0`);
  assert.equal(part.errors.basis, '根拠を作れません', '根拠だけ失敗');
  assert.ok(part.latest && part.view && part.learn && part.ver && !('basis' in part), 'ほかの中身は返す');
}

// ==== 4. 権限は別々の入口と同じ ====
{
  env.as(OUTSIDER);
  assert.throws(() => env.call('apiForecastPage(__in)', { __in: { planId: X } }), /権限がありません/);
  env.as(OWNER);
}

// ==== 5. 計画に書く処理が終わったら、その計画の画面の中身を作って控えておく（画面がすぐ読み直すときに待たない） ====
{
  clear();
  const ih = env.call('apiPlanView(__in)', { __in: { planId: X } }).inputHash;
  const st2 = env.runJob('PLAN.EDIT', { planId: X, action: 'INPUT.SAVE', inputHash: ih, args: { kind: 'product', rows: [{ person: '鷹野', product: '製品A', ym: FY + '-05', step: '+5%', reason: '控えの確かめ' }] } });
  assert.equal(st2.status, 'DONE', st2.error);
  reset();
  const after = env.call('apiForecastPage(__in)', { __in: { planId: X } });
  assert.deepEqual(after.errors, {});
  assert.ok(STATS.reads <= 4, '処理の後に読むときは、もう控えがある: ' + STATS.reads + ' 回');
  assert.equal(after.view.boot.input.product.some((r) => r.reason === '控えの確かめ'), true, '控えは保存した後の中身');
}
console.log('app-forecast-page: ok');
