#!/usr/bin/env node
/**
 * 疎なSPOT履歴の旧月P50全0を、実Engine→ジョブ保存→APIまで通す回帰試験。
 * 合成ZACの年1回・異なる四半期の売上だけを使い、主観・既知案件等は置かない。
 * 正netの履歴由来点を保ち、返品相殺で休止した会社には最低額を作らない。
 */
import assert from 'node:assert/strict';
import { setUpEnv, OWNER } from './gas-mock.mjs';

const env = setUpEnv();
const FY = 2026;
const AS_OF = new Date('2026-04-06T12:00:00+09:00').getTime();
const ACTIVE = '疎SPOT稼働テスト製薬';
const INACTIVE = '疎SPOT相殺テスト製薬';
const months = Array.from({ length: 12 }, (_, i) => {
  const d = new Date(FY, 3 + i, 1);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
});

// 各年度の発生月は別の四半期。直近の清浄3年度も同月/同四半期の中央値は0。
// 相殺側は最後の年度だけ同じ月に返品を置き、直近12月のnetを0にする。
{
  const blank = Array(70).fill('');
  const sheets = {};
  const events = [[2022, 6, 1200], [2023, 9, 2400], [2024, 12, 3600], [2026, 3, 4800]];
  for (let y = 2022; y <= 2026; y++) {
    const rows = [blank.map((_, i) => 'c' + (i + 1))];
    const add = (client, month, amount) => {
      const row = blank.slice();
      row[40] = client; row[45] = 'スポット'; row[49] = '既存スポット';
      row[56] = new Date(y, month - 1, 15); row[65] = amount;
      rows.push(row);
    };
    for (const [year, month, amount] of events) if (year === y) {
      for (const client of [ACTIVE, INACTIVE]) add(client, month, amount);
      if (year === 2026) add(INACTIVE, month, -amount);
    }
    sheets['*' + y + '_actual_value'] = { cols: 70, values: rows };
  }
  const zac = env.makeBook('合成・疎なSPOT履歴', sheets);
  env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
}

function forecast(clientName) {
  const made = env.runJob('PLAN.CREATE', { clientName, fy: FY, peopleCsv: '', purpose: 'MEASURE' });
  assert.equal(made.status, 'DONE', made.error);
  const planId = made.result.planId;
  for (const action of ['IMPORT.SALES', 'SALES.AGGREGATE']) {
    const st = env.runJob('PLAN.RUN', { planId, action });
    assert.equal(st.status, 'DONE', action + ': ' + st.error);
  }
  const input = env.table('ENG_SALES_INPUT').filter(r => r.plan_id === planId);
  assert.ok(input.length > 0 && input.every(r => r.service_type === 'SPOT'), 'BASEなしの履歴を本物の取込経路へ渡す');
  const view = env.call('apiPlanView(__in)', { __in: { planId } });
  assert.deepEqual(view.boot.setup.people, []);
  for (const kind of ['product', 'client', 'opinions', 'devspot']) assert.deepEqual(view.boot.input[kind], []);
  const inputsBefore = Object.fromEntries(['ENG_SALES_INPUT', 'ENG_PRODUCT', 'ENG_CLIENT', 'ENG_OPINIONS', 'ENG_DEV_SPOT']
    .map(table => [table, env.table(table).filter(r => r.plan_id === planId)]));
  let jobId = env.run("appWithLock_(() => appEnqueueJob_('FORECAST.RUN', {planId:__p,asOfMs:__t}, __by, '').id)",
    { __p: planId, __t: AS_OF, __by: OWNER });
  let result;
  for (let i = 0; i < 60; i++) {
    env.fireTriggers('triggerRunJob');
    const st = env.call('apiJobStatus(__in)', { __in: { jobId } });
    if (st.status === 'CONTINUED') { jobId = st.nextJobId; continue; }
    if (st.status === 'QUEUED' || st.status === 'RUNNING') { jobId = st.jobId; continue; }
    assert.equal(st.status, 'DONE', st.error);
    result = st.result; break;
  }
  assert.ok(result && result.runId, '実Engineの計算と保存を完了する');
  const row = env.table('FORECAST_RUNS').find(r => r.run_id === result.runId);
  const monthly = env.table('FORECAST_MONTHLY').filter(r => r.run_id === result.runId).sort((a, b) => a.ym.localeCompare(b.ym));
  const point = JSON.parse(row.planning_json);
  assert.deepEqual(monthly.map(r => r.ym), months);
  assert.ok(monthly.every(r => Number(r.p50) === 0), '回帰対象の前提: 旧月中央値は全12月0');
  assert.equal(point.version, 'HISTORY_MONTHLY_POINT_V2');
  assert.equal(point.applied, true);
  assert.equal(point.annualRawP50, Number(row.annual_p50), '元年度P50を上書きしない');
  assert.deepEqual(point.months.map(m => m.ym), months);
  assert.ok(point.months.every(m => Number.isSafeInteger(m.point) && m.point >= 0));
  assert.equal(point.months.reduce((s, m) => s + m.point, 0), point.annualTarget);
  const latest = env.call('apiForecastLatest(__in)', { __in: { planId } });
  assert.deepEqual(latest.planning, point, '保存した別の点予測をAPIへ正確に返す');
  assert.ok(latest.monthly.every(m => Number(m.p50) === 0), 'APIの中央値も点予測と混同しない');
  const neutral = env.table('ENG_FORECAST_SNAPSHOT').filter(r => r.plan_id === planId && r.scenario === 'neutral');
  assert.equal(neutral.length, 12);
  for (const snap of neutral) {
    assert.equal(Number(snap.final_pred), 0);
    const expected = point.months.find(m => m.ym === snap.target_month);
    assert.deepEqual(JSON.parse(snap.key_factors_json).monthly_point,
      { ...expected, version: point.version, method: point.method, annualTarget: point.annualTarget });
  }
  assert.deepEqual(Object.fromEntries(Object.keys(inputsBefore).map(table => [table, env.table(table).filter(r => r.plan_id === planId)])), inputsBefore);
  const effects = env.table('LAYER_EFFECTS').filter(r => r.run_id === result.runId);
  assert.equal(effects.length, 12);
  assert.ok(effects.every(r => ['human_yen', 'spot_yen', 'ai_yen'].every(k => Number(r[k]) === 0)));
  return { point, annualRawP50: Number(row.annual_p50) };
}

const active = forecast(ACTIVE);
assert.ok(active.annualRawP50 > 0, '年間中央値が正でも月中央値は全0となる疎な履歴');
assert.equal(active.point.inactive, false);
// MEASUREの主線は暫定Wへ変更。旧V5の四半期位相/900円は専用helper試験で保持する。
assert.equal(active.point.method, 'KK_NEVER_POSITIVE_CALENDAR_ENVELOPE');
assert.equal(active.point.provisional, true);
assert.equal(active.point.validationStatus, 'in_progress');
assert.equal(active.point.months.reduce((s,m)=>s+m.point,0), active.point.annualTarget);
assert.deepEqual(active.point.halfTargets,[0,1].map(h=>active.point.months.slice(h*6,h*6+6).reduce((s,m)=>s+m.point,0)));
assert.ok(active.point.annualTarget>0, '固定floorではなく疎な実績の完成方策を保存する');
assert.ok(active.point.months.some(m => m.point > 0), '旧月中央値が全0でも履歴由来の正額を保存する');

const inactive = forecast(INACTIVE);
assert.equal(inactive.point.inactive, true);
assert.equal(inactive.point.annualTarget, 0, '直近netが返品で0なら架空の最低額を足さない');
assert.ok(inactive.point.months.every(m => m.point === 0));
console.log('app-sparse-spot-zero-point: all tests passed');
