#!/usr/bin/env node
/**
 * app-bulk.test.mjs — 全部の計画をまとめて動かす（所有者の runForecastAll・runBacktestAll・bulkStatus。Bulk.js）。
 *   1. 予測: 年度の計画を 1 つずつ順に。失敗した計画（入力が足りない）・確認が要る計画（影響が大きい入力）も記録して次へ進む（確認は勝手にしない）
 *   2. "backtest":true なら、予測が全部終わってから物差しを同じように回す
 *   3. 途中ではもう一度始めない・片付けた計画は入れない
 * 数字はテスト用の作りもの。モックの上の確かめで、本物の Apps Script の上では動かしていない。
 *
 *   node app/tests/app-bulk.test.mjs
 */
import assert from 'node:assert/strict';
import { setUpEnv } from './gas-mock.mjs';

const env = setUpEnv();
const D = (y, m, d = 1) => new Date(y, m - 1, d);
const FY = env.run('appFy_(new Date())');

// ---- 準備: 3 社（売上の元は 1 つのスプレッドシート） ----
const NAMES = ['甲製薬', '乙製薬', '丙製薬'];
{
  const ext = Array.from({ length: 70 }, () => '');
  const sheets = {};
  for (let y = FY - 5; y <= FY + 1; y++) {
    const rows = [ext.map((_, i) => 'c' + (i + 1))];
    for (let m = 1; m <= 12; m++) {
      const dt = D(y, m, 15);
      if (dt < D(FY - 5, 4, 1) || dt > D(FY + 1, 3, 31)) continue;
      NAMES.forEach((n, k) => { const r = ext.slice(); r[40] = n; r[45] = 'ベース'; r[49] = '製品A'; r[56] = dt; r[65] = Math.round((1 + k) * 1000000 + 30000 * Math.sin(m) + 9000 * (y - FY + 5)); rows.push(r); });
    }
    sheets['*' + y + '_actual_value'] = { cols: 70, values: rows };
  }
  const zac = env.makeBook('売上の元', sheets);
  env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
}
const ids = {};
for (const n of NAMES) {
  let st = env.runJob('PLAN.CREATE', { clientName: n, fy: FY, peopleCsv: '鷹野' });
  assert.equal(st.status, 'DONE', st.error);
  ids[n] = st.result.planId;
  for (const action of ['IMPORT.SALES', 'SALES.AGGREGATE']) { st = env.runJob('PLAN.RUN', { planId: ids[n], action }); assert.equal(st.status, 'DONE', n + ' ' + action + ': ' + st.error); }
}
const save = (n, kind, rows) => { const s = env.runJob('PLAN.EDIT', { planId: ids[n], action: 'INPUT.SAVE', args: { kind, rows }, inputHash: env.call('apiPlanView(__in)', { __in: { planId: ids[n] } }).inputHash }); assert.equal(s.status, 'DONE', kind + ': ' + s.error); };
// 甲: ふつう。乙: 影響が大きい入力（確認が要る）。丙: 見解が無い（予測が失敗する）
save('甲製薬', 'opinions', [{ person: '鷹野', ym: FY + '-06', step: '3', conf: '0.8', note: '' }]);
save('甲製薬', 'product', [{ person: '鷹野', product: '製品A', ym: FY + '-10', step: '2', reason: '新規' }]);
save('乙製薬', 'opinions', [{ person: '鷹野', ym: FY + '-06', step: '3', conf: '0.8', note: '' }]);
save('乙製薬', 'product', [{ person: '鷹野', product: '製品A', ym: FY + '-10', step: '90', reason: '大型' }]);
save('丙製薬', 'product', [{ person: '鷹野', product: '製品A', ym: FY + '-10', step: '2', reason: '新規' }]);

const owner = (task) => { env.props.OWNER_TASK = JSON.stringify(task); return env.call('apiOwnerTask()'); };
const status = () => owner({ action: 'bulkStatus' }).result;

// ==== 1・2. 予測を全部、続けて物差し ====
{
  assert.equal(status().active, false);
  const runs0 = env.table('FORECAST_RUNS').length, bt0 = env.table('BACKTEST').length;
  const r = owner({ action: 'runForecastAll', backtest: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.result.mode, r.result.plans, r.result.then], ['FORECAST', 3, 'BACKTEST']);
  assert.match(r.hint, /裏の処理を始めました/);
  assert.doesNotMatch(r.hint, /裏の処理はありません/);
  assert.throws(() => owner({ action: 'runForecastAll' }), /まとめて動かしている途中です/);
  for (let i = 0; i < 60 && status().active; i++) env.fireTriggers('triggerRunJob');
  const s = status();
  assert.equal(s.active, false, JSON.stringify(s).slice(0, 600));
  const byName = (xs) => Object.fromEntries(xs.map((x) => [x.name, x]));
  const f = byName(s.forecastDone);
  assert.deepEqual(Object.keys(f).sort(), NAMES.slice().sort(), '予測は 3 社とも試した');
  assert.equal(f['甲製薬'].status, 'DONE');
  assert.equal(f['乙製薬'].status, 'CONFIRM', '確認が要る計画は確かめずに飛ばす: ' + JSON.stringify(f['乙製薬']));
  assert.equal(f['丙製薬'].status, 'FAILED', '失敗した計画も記録して次へ: ' + JSON.stringify(f['丙製薬']));
  assert.match(f['丙製薬'].error, /未入力/);
  assert.equal(env.table('FORECAST_RUNS').length, runs0 + 1, '予測の記録は甲の 1 回だけ');
  assert.deepEqual(s.forecastCounts, { DONE: 1, CONFIRM: 1, FAILED: 1 });
  // 物差しは 3 社とも（入力に関係しない）
  assert.equal(s.mode, 'BACKTEST');
  assert.deepEqual(s.done.map((d) => d.name).sort(), NAMES.slice().sort());
  assert.ok(s.done.every((d) => d.status === 'DONE'), JSON.stringify(s.done));
  assert.equal(env.table('BACKTEST').length, bt0 + 132 * 3);
}

// ==== 3. 片付けた計画は入れない・年度の確かめ ====
{
  assert.deepEqual(env.call('appBulkQueue_(__y)', { __y: FY }).length, 3);
  assert.deepEqual(env.call('appBulkQueue_(__y)', { __y: FY + 1 }), []);
  assert.throws(() => owner({ action: 'runForecastAll', fy: 'abcd' }), /fy（年度）は 4 桁の数/);
  assert.throws(() => owner({ action: 'runForecastAll', backtest: 'yes' }), /backtest は true か false/);
}

console.log('app-bulk: ok');
