#!/usr/bin/env node
/**
 * app-measure-forecast.test.mjs — 測る専用の計画は担当者・主観・既知スポットなしで予測できる。
 * 本物の A-1 → A-2 → A-3 → A-9 を合成 ZAC データと GAS のモックで動かす。
 * 通常計画の必須条件、入力済み値の検証、入力の保存内容は保つ。実 GAS の確認は別。
 */
import assert from 'node:assert/strict';
import { setUpEnv, OWNER } from './gas-mock.mjs';

const env = setUpEnv();
const FY = 2026;
const CLIENTS = ['統計テスト製薬', '通常テスト製薬'];
const INPUTS = ['PRODUCT', 'CLIENT', 'OPINIONS', 'DEV_SPOT'];
const AS_OF = new Date('2026-10-17T12:00:00+09:00').getTime();

// 元データは過去の売上だけ（新製品・担当者意見・既知スポット・AI 調査は置かない）。
{
  const blank = Array(70).fill('');
  const sheets = {};
  for (let y = FY - 4; y <= FY; y++) {
    const rows = [blank.map((_, i) => 'c' + (i + 1))];
    for (let m = 1; m <= 12; m++) {
      if (y === FY - 4 && m < 4) continue;
      for (const client of CLIENTS) {
        const r = blank.slice();
        r[40] = client; r[45] = 'ベース'; r[49] = '既存製品'; r[56] = new Date(y, m - 1, 15);
        r[65] = Math.round(1000000 + (y - FY + 4) * 30000 + 60000 * Math.sin(m));
        rows.push(r);
      }
    }
    sheets['*' + y + '_actual_value'] = { cols: 70, values: rows };
  }
  const zac = env.makeBook('合成の売上', sheets);
  env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
}

function makePlan(clientName, peopleCsv, purpose) {
  const made = env.runJob('PLAN.CREATE', { clientName, fy: FY, peopleCsv, purpose });
  assert.equal(made.status, 'DONE', made.error);
  const planId = made.result.planId;
  for (const action of ['IMPORT.SALES', 'SALES.AGGREGATE']) {
    const st = env.runJob('PLAN.RUN', { planId, action });
    assert.equal(st.status, 'DONE', action + ': ' + st.error);
  }
  return planId;
}
function forecast(planId, extra = {}) {
  // 「今」は外部から渡せないので、固定時点の確認だけ待ち行列へ直接入れる。
  let jobId = env.run(`appWithLock_(() => appEnqueueJob_('FORECAST.RUN', __p, __by, '').id)`,
    { __p: Object.assign({ planId, asOfMs: AS_OF }, extra), __by: OWNER });
  for (let i = 0; i < 60; i++) {
    env.fireTriggers('triggerRunJob');
    const st = env.call('apiJobStatus(__in)', { __in: { jobId } });
    if (st.status === 'CONTINUED') { jobId = st.nextJobId; continue; }
    if (st.status === 'QUEUED' || st.status === 'RUNNING') { jobId = st.jobId; continue; }
    return st;
  }
  throw new Error('予測が終わらない');
}
function save(planId, kind, rows) {
  const st = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind, rows } });
  assert.equal(st.status, 'DONE', kind + ': ' + st.error);
}
const inputSnapshot = (planId) => Object.fromEntries(['ENG_SHEETS', 'ENG_ROWS', 'ENG_FORMATS', ...INPUTS.map((s) => 'ENG_' + s)]
  .map((table) => [table, env.table(table).filter((r) => r.plan_id === planId && (!r.sheet || INPUTS.includes(r.sheet)))]));
const layers = (runId) => env.table('LAYER_EFFECTS').filter((r) => r.run_id === runId);

// 空担当者を許すのは所有者が作る「測る専用」だけ。
assert.match(env.runJob('PLAN.CREATE', { clientName: '拒否テスト', fy: FY, peopleCsv: '' }).error, /担当者を 1 人以上/);
const measure = makePlan(CLIENTS[0], '', 'MEASURE');
assert.equal(env.table('PLANS').find((p) => p.plan_id === measure).people_csv, '');
const view = env.call('apiPlanView(__in)', { __in: { planId: measure } });
assert.deepEqual(view.boot.setup.people, []);
for (const kind of ['product', 'client', 'opinions', 'devspot']) assert.deepEqual(view.boot.input[kind], [], '架空の中立行を作らない: ' + kind);

const before = inputSnapshot(measure);
const first = forecast(measure);
assert.equal(first.status, 'DONE', first.error);
const monthly = env.table('FORECAST_MONTHLY').filter((r) => r.run_id === first.result.runId).sort((a, b) => a.ym.localeCompare(b.ym));
assert.deepEqual(monthly.map((r) => r.ym), Array.from({ length: 12 }, (_, i) => {
  const dt = new Date(FY, 3 + i, 1);
  return dt.getFullYear() + '/' + String(dt.getMonth() + 1).padStart(2, '0');
}));
assert.ok(monthly.every((r) => [r.p10, r.p50, r.p90].every((v) => Number.isFinite(Number(v))) && Number(r.p10) <= Number(r.p50) && Number(r.p50) <= Number(r.p90)), '12 か月の予測と帯');
assert.equal(layers(first.result.runId).length, 12);
assert.ok(layers(first.result.runId).every((r) => ['human_yen', 'spot_yen', 'ai_yen'].every((k) => Number(r[k]) === 0)), '未入力の主観・スポット・AI の寄与は 0');
assert.deepEqual(inputSnapshot(measure), before, '予測で主観表を補完・削除・書換しない');
const repeat = forecast(measure);
assert.equal(repeat.status, 'DONE', repeat.error);
assert.deepEqual(repeat.result.headline, first.result.headline, '同じ空入力なら同じ数字');
assert.deepEqual(inputSnapshot(measure), before);

// 測る専用でも、入力済みの不正な値は通常と同じく止める。
for (const [kind, row, error] of [
  ['opinions', { person: '検証用', ym: '2026-11', step: '5', conf: 2 }, /OPINIONS.*信頼度が不正/],
  ['product', { person: '検証用', product: '既存製品', ym: '2026-11', step: 'bad' }, /PRODUCT.*Stepが解釈できません/],
  ['client', { person: '検証用', ym: '2026-11', step: 'bad' }, /CLIENT.*Stepが解釈できません/],
  ['devspot', { person: '検証用', ym: '2026-11', project: '検証用', amount: -1, conf: 1 }, /DEV_SPOT.*金額が負/]
]) {
  save(measure, kind, [row]);
  const invalidBefore = inputSnapshot(measure);
  const st = forecast(measure);
  assert.equal(st.status, 'FAILED', kind);
  assert.match(st.error, error);
  assert.deepEqual(inputSnapshot(measure), invalidBefore, '拒否しても入力を消さない: ' + kind);
  save(measure, kind, []);
}

// 任意とは入力を捨てる意味ではない。PRODUCT の理由と担当者意見がなくても有効な製品入力は反映する。
save(measure, 'product', [{ person: '検証用', product: '既存製品', ym: '2026-11', step: '10', reason: '' }]);
const enteredBefore = inputSnapshot(measure);
const entered = forecast(measure);
assert.equal(entered.status, 'DONE', entered.error);
assert.ok(layers(entered.result.runId).some((r) => Number(r.human_yen) > 0), '既存の入力を中立化しない');
assert.deepEqual(inputSnapshot(measure), enteredBefore, '有効な入力もそのまま残す');

// 通常計画は今までどおり全担当者の意見と PRODUCT の理由が必要。任意オプションを payload で偽装しても無効。
const normal = makePlan(CLIENTS[1], '担当A', '');
let st = forecast(normal, { allowMissingUserInputs: true });
assert.equal(st.status, 'FAILED');
assert.match(st.error, /OPINIONS/);
save(normal, 'opinions', [{ person: '担当A', ym: '2026-11', step: '0', conf: 0.5 }]);
st = forecast(normal);
assert.equal(st.status, 'FAILED');
assert.match(st.error, /PRODUCT のReasonが未入力/);
save(normal, 'product', [{ person: '担当A', product: '既存製品', ym: '2026-11', step: '0', reason: '合成データの確認' }]);
st = forecast(normal);
assert.equal(st.status, 'DONE', st.error);

console.log('app-measure-forecast: all tests passed');
