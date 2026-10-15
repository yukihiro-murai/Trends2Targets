#!/usr/bin/env node
/**
 * app-v14-effects.test.mjs — 人と AI の押しの効き係数（表の版 14 の EFFECT_COEFS。Effects.js）と、AI の効き（段 3。app/DESIGN_triangulation_bayes_JA.md の 3・4 章）。
 *   1. 当てはめ（計算だけ）: 本当の βH = 0.5・βAI = 1.5 の点から事後が近づく・点が少なければ事前に近い・階層の縮め（ほかのメーカーの事後に寄る）
 *   2. AI の上限: 段 3 より前の既定（CONFIG の 0.05）は新しい既定 0.15 として読む・ほかの値はそのまま（0.30 まで）
 *   3. AI の月ごとの強さ: 話題の時期までは 1、12 か月先で 0.5
 *   4. 旧来の計算: 効き係数を βH 乗・βAI 乗で掛ける（0 なら人と AI の押しが消える）・見通しの幅を広げる（真ん中は変えない）
 *   5. 証拠から効き係数を出す（本番の記録から）: 押しが外れていれば βH が下がる・1 回 ±0.2・同じ証拠なら同じ値・記録の回の効き係数で割り戻す
 * 数字はテスト用の作りもの。モックの上の確かめで、本物の Apps Script の上では動かしていない。
 *
 *   node app/tests/app-v14-effects.test.mjs
 */
import assert from 'node:assert/strict';
import { setUpEnv, OWNER } from './gas-mock.mjs';

const env = setUpEnv();
const J = (x) => JSON.parse(JSON.stringify(x));
const ENG = '(globalThis.__eng = globalThis.__eng || appLegacyEngine_({ SpreadsheetApp, Date, Utilities, PropertiesService, UrlFetchApp: null, HtmlService: null, Session, AppTriangulation: null, AppLearning: null }))';

// 決まった乱れ（再現できる）
let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => { let s = 0; for (let k = 0; k < 12; k++) s += rnd(); return s - 6; };

// ==== 1. 当てはめ ====
{
  const mk = (maker, n, bh, ba, alpha, noise) => Array.from({ length: n }, (_, k) => {
    const xh = (rnd() - 0.5) * 0.3, xa = (rnd() - 0.5) * 0.2;
    return { maker, ym: '2026/01', y: alpha + bh * xh + ba * xa + noise * gauss(), xh, xa, w: 1 };
  });
  const many = mk('A', 400, 0.5, 1.5, 0.02, 0.03);
  const h = J(env.call('appEffHierarchical_(__p, "A")', { __p: many }));
  assert.ok(Math.abs(h.mu[1] - 0.5) < 0.08, 'βH ≒ 0.5: ' + h.mu[1]);
  assert.ok(Math.abs(h.mu[2] - 1.5) < 0.12, 'βAI ≒ 1.5: ' + h.mu[2]);
  assert.ok(Math.abs(h.mu[0] - 0.02) < 0.01, 'α ≒ 0.02: ' + h.mu[0]);
  assert.ok(Math.sqrt(h.cov[1][1]) < 0.1, 'データが多ければ幅は狭い: ' + Math.sqrt(h.cov[1][1]));
  assert.ok(Math.abs(Math.sqrt(h.sigma2) - 0.05) < 1e-9, '誤差の大きさは下限 5%（本当は 3%）: ' + Math.sqrt(h.sigma2));
  // 点が 3 つ: 事前（1）に近く、幅は広い
  const few = J(env.call('appEffHierarchical_(__p, "A")', { __p: many.slice(0, 3) }));
  assert.ok(Math.abs(few.mu[1] - 1) < 0.3 && Math.sqrt(few.cov[1][1]) > 0.3, '点が少なければ事前に近い: ' + few.mu[1]);
  // 階層の縮め: ほかのメーカー（B）に多くの点・自分（A）は点なし → B の事後に寄る（幅はメーカーどうしの違いのぶん広い）
  const other = J(env.call('appEffHierarchical_(__p, "A")', { __p: mk('B', 400, 0.4, 1.2, 0, 0.03) }));
  assert.ok(Math.abs(other.mu[1] - 0.4) < 0.1, 'ほかのメーカーの事後に寄る: ' + other.mu[1]);
  assert.ok(Math.sqrt(other.cov[1][1]) >= 0.2 - 1e-9, '幅はメーカーどうしの違い以上: ' + Math.sqrt(other.cov[1][1]));
  // 行列の逆
  const m = [[4, 1, 0.5], [1, 3, 0.2], [0.5, 0.2, 2]];
  const inv = J(env.call('appEffInv3_(__m)', { __m: m }));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const v = m[i][0] * inv[0][j] + m[i][1] * inv[1][j] + m[i][2] * inv[2][j];
    assert.ok(Math.abs(v - (i === j ? 1 : 0)) < 1e-12);
  }
}

// ==== 2. AI の上限（CONFIG の読み替え） ====
{
  const book = env.makeBook('cfg', { CONFIG: { values: [['項目', '値'], ['AI_MAX_ABS_EFFECT（AI係数上限）', 0.05]] } });
  const read = (v) => {
    book.getSheetByName('CONFIG').getRange(2, 2).setValue(v);
    return env.call(`(() => { const e = appLegacyEngine_(appLegacyServices_(__b, { asOfMs: Date.now(), seed: 'x', actor: '' })); return e.readModelTuningFromConfig_().aiMaxAbsEffect; })()`,
      { __b: book });
  };
  assert.equal(env.run(`${ENG}.AI_MAX_ABS_EFFECT`), 0.15);
  assert.equal(read(0.05), 0.15, '段 3 より前の既定 0.05 は新しい既定 0.15');
  assert.equal(read(0.08), 0.08, 'ほかの値はそのまま');
  assert.equal(read(0.9), 0.3, '0.30 まで');
  assert.equal(read(''), 0.15, '空は既定');
}

// ==== 3. AI の月ごとの強さ ====
{
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, i) => new Date(now.getFullYear(), now.getMonth() + i + 1, 1));
  const w = J(env.run(`${ENG}.aiMonthWeights_(__m, 3)`, { __m: months }));
  assert.deepEqual(w.slice(0, 3), [1, 1, 1], '話題の時期（3 か月）までは全部');
  assert.ok(Math.abs(w[11] - 0.5) < 1e-12 && w[5] < 1 && w[5] > 0.5, '12 か月先で半分: ' + w.join(','));
  const def = J(env.run(`${ENG}.aiMonthWeights_(__m, null)`, { __m: months }));
  assert.deepEqual(def.slice(0, 6), [1, 1, 1, 1, 1, 1], '時期が無ければ 6 か月');
}

// ==== 4. 旧来の計算: 効き係数の掛け方と見通しの幅 ====
{
  const model = { intercept: 1000, slope: 0, seasonalIndex: new Array(12).fill(1) };
  const months = Array.from({ length: 12 }, (_, i) => new Date(2027, 3 + i, 1));
  const sim = (effects) => J(env.run(`(() => { Math.random = (() => { let s = 7; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
    return ${ENG}.forecastMonteCarloMixed_(__m, { residualPct: [0], nSim: 50, months: __mo, factorsClient: [{ ym: __mo[0], step: 0.2, person: 'a' }], opinions: [],
      aiScores: { Market: 50, Competitor: 0, Channel: 0, DX: 0, meta: { horizonMonths: 12 } }, aiWeight: 0.004, aiMaxAbsEffect: 0.15, effects: __e }); })()`,
    { __m: model, __mo: months, __e: effects }));
  const one = sim(null), zero = sim({ betaHuman: 0, betaAi: 0 }), half = sim({ betaHuman: 0.5, betaAi: 0.5 });
  const kAI = one.diagnostics.kAIByMonth[0];
  assert.ok(Math.abs(kAI - 1.15) < 1e-9, 'AI の押しは上限 ±15% まで: ' + kAI);
  assert.ok(zero.diagnostics.kAIByMonth.every((k) => Math.abs(k - 1) < 1e-12), 'βAI = 0 なら AI の押しは消える');
  assert.ok(Math.abs(half.diagnostics.kAIByMonth[0] - Math.sqrt(1.15)) < 1e-9, 'βAI = 0.5 なら平方根');
  assert.ok(Math.abs(zero.diagnostics.kAIRawByMonth[0] - 1.15) < 1e-9, '生の押しは残る（学びに使う）');
  assert.ok(Math.abs(zero.p50[0] - 1000) < 1e-6, '人も AI も 0 なら土台のまま: ' + zero.p50[0]);
  assert.ok(one.p50[0] > half.p50[0] && half.p50[0] > zero.p50[0]);
}

// ---- 準備: 本物の計画（app-v12-methods.test.mjs と同じ作り。年度は前の年度） ----
const D = (y, m, d = 1) => new Date(y, m - 1, d);
const CLIENT = 'テスト製薬';
const FY = env.run('appFy_(new Date())') - 1;
let planId;
{
  const ext = Array.from({ length: 70 }, () => '');
  const rec = (product, month, amount) => { const r = ext.slice(); r[40] = CLIENT; r[45] = 'ベース'; r[49] = product; r[56] = month; r[65] = amount; return r; };
  const sheets = {};
  for (let y = FY - 5; y <= FY + 1; y++) {
    const rows = [ext.map((_, i) => 'c' + (i + 1))];
    for (let m = 1; m <= 12; m++) {
      const dt = D(y, m, 15);
      if (dt < D(FY - 5, 4, 1) || dt > D(FY + 1, 3, 31)) continue;
      rows.push(rec('製品A', dt, Math.round(1000000 + 50000 * Math.sin(m) + 12000 * (y - FY + 5) + m * 2000)));
    }
    sheets['*' + y + '_actual_value'] = { cols: 70, values: rows };
  }
  const zac = env.makeBook('売上の元', sheets);
  env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
  let st = env.runJob('PLAN.CREATE', { clientName: CLIENT, fy: FY, peopleCsv: '鷹野' });
  assert.equal(st.status, 'DONE', st.error);
  planId = st.result.planId;
  for (const action of ['IMPORT.SALES', 'SALES.AGGREGATE']) { st = env.runJob('PLAN.RUN', { planId, action }); assert.equal(st.status, 'DONE', action + ': ' + st.error); }
  const save = (kind, rows) => { const s = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind, rows }, inputHash: env.call('apiPlanView(__in)', { __in: { planId } }).inputHash }); assert.equal(s.status, 'DONE', kind + ': ' + s.error); };
  save('opinions', [{ person: '鷹野', ym: FY + '-06', step: '10', conf: '0.8', note: '' }]);
  save('client', [{ person: '鷹野', ym: FY + '-08', step: '8', reason: '全体' }]);
  save('product', [{ person: '鷹野', product: '製品A', ym: FY + '-10', step: '5', reason: '新規' }]);
}
const AS_OF = new Date(FY, 3, 10, 10).getTime();
function forecast() {
  let id = env.run(`appWithLock_(() => appEnqueueJob_('FORECAST.RUN', { planId: __p, confirms: ['extreme'], asOfMs: __t }, __by, '').id)`, { __p: planId, __t: AS_OF, __by: OWNER });
  for (let i = 0; i < 60; i++) {
    env.fireTriggers('triggerRunJob');
    const st = env.call('apiJobStatus(__in)', { __in: { jobId: id } });
    if (st.status === 'CONTINUED') { id = st.nextJobId; continue; }
    if (st.status === 'QUEUED' || st.status === 'RUNNING') { id = st.jobId; continue; }
    return st;
  }
  throw new Error('続きの処理が終わらない');
}

// ==== 4b. 本番の予測: 証拠が無いので事前（β = 1）・見通しの幅は事前の幅で広がる・記録 ====
let runA;
{
  const st = forecast();
  assert.equal(st.status, 'DONE', st.error);
  runA = env.table('FORECAST_RUNS').filter((r) => r.plan_id === planId).pop();
  const e = env.table('EFFECT_COEFS').filter((r) => r.run_id === runA.run_id);
  assert.equal(e.length, 1);
  assert.deepEqual([e[0].basis, Number(e[0].beta_human), Number(e[0].beta_ai), Number(e[0].var_human), e[0].calc_version], ['PRIOR', 1, 1, 0.25, 'E-1']);
  assert.match(e[0].coef_id, /^EFC-[0-9A-F]{24}$/);
  // 効き係数を渡さないとき（今までの動き）と比べる: 真ん中は同じ・人の押しのある月は幅が広い
  env.run('__realEff = appEffForEngine_; appEffForEngine_ = function () { return null; };');
  assert.equal(forecast().status, 'DONE');
  env.run('appEffForEngine_ = __realEff;');
  const runB = env.table('FORECAST_RUNS').filter((r) => r.plan_id === planId).pop();
  const m = (id) => Object.fromEntries(env.table('FORECAST_MONTHLY').filter((x) => x.run_id === id).map((x) => [x.ym, x]));
  const a = m(runA.run_id), b = m(runB.run_id);
  Object.keys(a).forEach((ym) => assert.ok(Math.abs(Number(a[ym].p50) - Number(b[ym].p50)) < 1e-6, ym + ': 真ん中は同じ'));
  const pushed = Object.keys(a).filter((ym) => Math.abs(Number(a[ym].p90) - Number(b[ym].p90)) > 1);
  assert.ok(pushed.length > 0, '人の押しのある月は幅が広がる');
  pushed.forEach((ym) => assert.ok(Number(a[ym].p90) > Number(b[ym].p90) && Number(a[ym].p10) < Number(b[ym].p10), ym + ': 外へ広げる'));
}

// ==== 5. 証拠から効き係数を出す ====
{
  const CTX = `({ actor: '${OWNER}', requestId: 'TEST', roles: [] })`;
  const plan = env.table('PLANS').find((p) => p.plan_id === planId);
  const pts = (n, f) => Array.from({ length: n }, (_, k) => f(k));
  // 人の押しが外れた（押したのに実績は動かなかった）点: ほかのメーカー 2 社 × 12 か月 + このメーカー 12 か月
  const mk = (maker, k) => { const xh = (k % 3 - 1) * 0.1; return { maker, plan: 'P-' + maker, ym: FY + '/' + String(4 + (k % 9)).padStart(2, '0'), y: 0.2 * xh + 0.01 * ((k % 2) - 0.5), xh, xa: 0, w: 1, actual: 1, runId: 'R' + k }; };
  const ev = [].concat(pts(12, (k) => mk('X', k)), pts(12, (k) => mk('Y', k)), pts(12, (k) => mk(String(plan.client_id), k)));
  env.run('__realEv = appEffEvidence_; appEffEvidence_ = function () { return __ev; };', { __ev: ev });
  const e1 = env.call(`appLearnEffects_(${CTX}, __p, __t)`, { __p: plan, __t: AS_OF });
  assert.equal(e1.basis, 'POSTERIOR');
  assert.ok(e1.posterior.betaHuman < 0.5, '押しが外れていれば βH は下がる: ' + e1.posterior.betaHuman);
  assert.ok(Math.abs(e1.betaHuman - 0.8) < 1e-9 && e1.capped, '1 回で動けるのは ±0.2（1 → 0.8）・止めた印');
  // 記録して同じ証拠でもう一度: 同じ値（何も変えずに予測し直しても数字が揺れない）
  const rec = (e, runId) => env.run(`appWithLock_(() => appJournalApply_(appEffOps_(${CTX}, __p, { eff: __e, runId: __r, asOfMs: __t })))`, { __p: plan, __e: e, __r: runId, __t: AS_OF });
  rec(e1, 'RUN-E1');
  const e1b = env.call(`appLearnEffects_(${CTX}, __p, __t)`, { __p: plan, __t: AS_OF });
  assert.equal(e1b.betaHuman, e1.betaHuman, '同じ証拠なら同じ値');
  rec(e1b, 'RUN-E2');
  // 証拠が増えた: 前の値（0.8）からさらに ±0.2
  env.run('__ev.push(__x);', { __x: mk(String(plan.client_id), 99) });
  const e2 = env.call(`appLearnEffects_(${CTX}, __p, __t)`, { __p: plan, __t: AS_OF });
  assert.ok(Math.abs(e2.betaHuman - 0.6) < 1e-9, '0.8 → 0.6: ' + e2.betaHuman);
  env.run('appEffEvidence_ = __realEv;');
  // 学びの画面の応答
  const card = env.call('appEffectsCard_(__p)', { __p: [{ planId, clientName: CLIENT, fy: FY }] });
  assert.ok(card && card.plans.length === 1);
  assert.equal(card.plans[0].capped, true);
  assert.ok(Math.abs(card.plans[0].betaHuman - 0.8) < 1e-9, '一番新しい記録');
  // 本物の証拠: 記録の回の効き係数で割り戻す（EFFECT_COEFS の回の βH が 0.5 なら、記録の押しを 0.5 で割る）
  const real = env.call('appEffEvidence_(__t)', { __t: new Date(FY + 1, 6, 1).getTime() });
  assert.ok(Array.isArray(real), '実績の無い計画では点 0: ' + real.length);
}

console.log('app-v14-effects: ok');
