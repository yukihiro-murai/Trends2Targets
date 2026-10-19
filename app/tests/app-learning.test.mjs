/**
 * app-learning.test.mjs — 精度の推移・全計画で縮めた偏りの補正（影）・幅の較正・情報源の信頼度の事前分布（ベータ二項）。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setUpEnv, STATS, J, repoRoot } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const env = setUpEnv();
const H = env.run('(() => { const o = {}; Object.keys(APP_ENGINE_SHEETS).forEach(k => { o[k] = APP_ENGINE_SHEETS[k].header || null; }); return o; })()');
/**
 * 今の検証の版。B-2 は EVAL_LOG の evaluation_policy_version（21 列目）に書き、精度は今の版の行だけで測る（2026-10-07 D4〜D6。
 * 前の版の行は月が始まった後の予測で測っている）。下の記録は今の B-2 が書いた形にする
 */
const POLICY = env.run('APP_EVAL_POLICY_VERSION');
/**
 * 実績の取り込み（B-1）と検証（B-2）の記録。締まった月は、B-1 の日に月末から 5 日たった月だけ（2026-10-07 D5）なので、
 * 精度を測るには B-1 → B-2 の記録が要る（無ければ締まった月は無い）。2026-01-05 の取り込みなら 2025/12 まで締まっている
 */
const status = (client, b1 = new Date(2026, 0, 5, 10)) => ({ values: [H.PROCESS_STATUS, ['step2_status', b1, 'owner', 'success', client, 36, ''],
  ['step5_status', new Date(b1.getTime() + 3600e3), 'owner', 'success', client, 36, '']] });
/** 12 か月の検証の記録: 予測は実績の over 倍。P10〜P90 は ±width。最後の月は締まった後の予測（予測 = 実績） */
function book(client, over, width, hit) {
  const ev = [H.EVAL_LOG];
  for (let i = 0; i < 12; i++) {
    const ym = '2025/' + String(i + 1).padStart(2, '0');
    const act = 1000 + i * 10 * (i % 3 === 0 ? -1 : 1);
    const p50 = i === 11 ? act : act * over;
    for (const [sc, p] of [['nega', p50 * (1 - width)], ['neutral', p50], ['posi', p50 * (1 + width)]]) {
      ev.push(['E' + i + sc, D(2026, 1, 5), client, ym, sc, p, act, Math.abs(p - act) / act, 0, '', '', sc === 'neutral' ? 1 : 0, p - act, Math.abs(p - act), '', '', '', '', '', '', POLICY, 1]);
    }
  }
  const evid = [H.RELIABILITY_EVIDENCE];
  for (const [type, n, h] of [['opinion', 10, Math.round(10 * hit)], ['factor_product', 8, 4], ['ai_topic', 2, 1]]) evid.push([client, type, 'k', '2025Q4', '2025/12', n, h, h / n, D(2026, 1, 5), 'R', 'expected=' + (n / 2).toFixed(4)]);   // 基準が半々の当たり（2026-10-13 から C-1 が基準で当たるはずの数を書く）
  return env.makeBook(client, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    EVAL_LOG: { values: ev, formats: { D: '@' } },
    RELIABILITY_EVIDENCE: { values: evid },
    POOL_PRIOR: { values: [H.POOL_PRIOR] },
    CALIBRATION_STATE: { values: [H.CALIBRATION_STATE, [client, D(2026, 1, 5), 'owner', '', '', '', 0.98, '', '{}', '', '', 1, '']] },
    PROCESS_STATUS: status(client),
  });
}
const ids = {};
for (const [c, over, width, hit] of [['甲製薬', 1.10, 0.05, 0.7], ['乙製薬', 1.04, 0.15, 0.5], ['丙製薬', 0.97, 0.10, 0.6]]) {
  const b = book(c, over, width, hit);
  ids[c] = env.seedPlan(b);
}

// ==== 1. 精度の推移（影）: 締まった後の予測（誤差 0）は除く ====
const a = env.call('apiLearningView(__in)', { __in: { planId: ids['甲製薬'] } });
assert.equal(a.accuracy.n, 11);
assert.equal(a.accuracy.leaks, 1, '予測 = 実績の月は除く');
assert.ok(Math.abs(a.accuracy.mape - 0.10) < 1e-9, '10% 高い予測');
assert.ok(Math.abs(a.accuracy.bias - 0.10) < 1e-9, '偏りは +10%');
assert.equal(a.accuracy.coverage, 0, 'P10〜P90（±5%）に実績は入らない');
assert.ok(a.accuracy.widthScale > 1.5, '幅は今の 2 倍ほど要る: ' + a.accuracy.widthScale);
assert.equal(a.accuracy.months.length, 12);
assert.equal(a.factorNow, 0.98);

// ==== 2. 全計画で縮めた偏りの補正（影）: 3 つの計画の平均へ寄る。過去の月に当てると誤差が減る ====
assert.equal(a.pooled, true);
assert.equal(a.pooledPlans, 3);
assert.ok(a.mu > 0 && a.mu < 0.10, '全体の平均の偏り: ' + a.mu);
assert.ok(a.shadow.shrunk <= 0.10 && a.shadow.shrunk >= a.mu - 1e-9, '自分の偏りと平均の間: ' + a.shadow.shrunk);
assert.ok(a.shadow.factorShadow < 1, '下げる補正');
assert.ok(a.shadow.mapeShadow < a.shadow.mapeNow, '過去の月に当てはめると誤差が減る');
const c = env.call('apiLearningView(__in)', { __in: { planId: ids['丙製薬'] } });
assert.ok(c.accuracy.bias < 0 && c.accuracy.coverage === 1, '低めの予測・幅の中');

// ==== 3. 情報源の信頼度の事前分布（ベータ二項の経験ベイズ） ====
const pv = env.task('poolPreview()');
const op = pv.types.filter((t) => t.type === 'opinion')[0];
assert.equal(op.ok, true);
assert.equal(op.plans, 3);
assert.ok(Math.abs(op.hitRate - 18 / 30) < 1e-9, '当たった割合: 全計画の合計');
assert.ok(op.precision >= 2 && op.precision <= 50, '事前分布の強さ: ' + op.precision);
assert.ok(Math.abs(op.pooledR - 1.2) < 1e-9, '旧来と同じ r の尺度（2 × 当たる割合）');
assert.ok(op.perPlan.every((x) => x.posterior > Math.min(x.hitRate, op.hitRate) - 1e-9 && x.posterior < Math.max(x.hitRate, op.hitRate) + 1e-9), '事後の平均は自分と全体の間');
assert.equal(pv.types.filter((t) => t.type === 'ai_topic')[0].ok, false, '数が少ない情報源は作らない');

// 書く: 各計画の POOL_PRIOR に入る（旧来の C-1 が読む形）
const st = env.runJob('LEARN.POOL', {});
assert.equal(st.status, 'DONE', st.error);
assert.equal(st.result.plans.length, 3);
for (const id of Object.values(ids)) {
  const rows = env.table('ENG_POOL_PRIOR').filter((r) => r.plan_id === id);
  const o = rows.filter((r) => r.pool_scope === 'reliability:opinion')[0];
  assert.ok(o, 'reliability:opinion の行');
  assert.equal(o.param_key, 'reliability_r');
  assert.equal(o.pooled_value, '1.2');
}
const pv2 = env.task('poolPreview()');
assert.equal(pv2.current[ids['乙製薬']]['reliability:opinion'].value, 1.2);
assert.ok(env.audit().some((x) => x.action === 'LEARN.POOL' && x.phase === 'END' && x.result === 'OK'));
// 計画を組み立て直しても同じ（データ本体と計算用ブックが合う）
assert.equal(env.call('apiPlanView(__in)', { __in: { planId: ids['甲製薬'] } }).pendingWrite || null, null);
// ==== 4. 表が大きいときは、計画の行だけを探して読む（結果は全部読んだときと同じ・読むセルは少ない） ====
const load = (id) => env.run(`(() => { APP_STORE_CACHE_ = {}; return JSON.stringify(appEngLoadPlanSheets_('${id}')); })()`);
const reset = () => { for (const k of Object.keys(STATS)) STATS[k] = k === 'bySheet' ? {} : 0; };
reset(); const full = load(ids['乙製薬']); const fullCells = STATS.readCells;
env.run('appPlanReadMinRows_ = () => 0');
reset(); const part = load(ids['乙製薬']); const partCells = STATS.readCells;
assert.equal(part, full, '計画の行だけ読んでも同じ');
assert.ok(partCells < fullCells * 0.7, '読むセルが減る: ' + fullCells + ' → ' + partCells);
assert.equal(env.call('apiLearningView(__in)', { __in: { planId: ids['甲製薬'] } }).accuracy.n, 11, '計画ごとに読んでも同じ結果');
const again = env.runJob('LEARN.POOL', {});
assert.equal(again.status, 'DONE', again.error);
env.run('appPlanReadMinRows_ = () => 3000');

// ==== 5. 締まった月だけで測る（2026-10-07 村井さん承認 D4・D5）。締まっていない月の EVAL_LOG の行は消さずに読み飛ばす ====
{
  const e2 = setUpEnv();
  /** 甲製薬と同じ 12 か月（2025/01〜12。最後の月は予測 = 実績）に、extra の月（途中の実績 10 に予測 1000。誤差がとても大きい）を足した記録 */
  const evalRows = (client, extra) => {
    const ev = [H.EVAL_LOG];
    const add = (i, ym, act, p50) => { for (const [sc, p] of [['nega', p50 * 0.95], ['neutral', p50], ['posi', p50 * 1.05]]) ev.push(['E' + i + sc, D(2026, 2, 3), client, ym, sc, p, act, Math.abs(p - act) / act, 0, '', '', sc === 'neutral' ? 1 : 0, p - act, Math.abs(p - act), '', '', '', '', '', '', POLICY, 1]); };
    for (let i = 0; i < 12; i++) { const act = 1000 + i * 10 * (i % 3 === 0 ? -1 : 1); add(i, '2025/' + String(i + 1).padStart(2, '0'), act, i === 11 ? act : act * 1.1); }
    extra.forEach((ym, j) => add(12 + j, ym, 10, 1000));
    return ev;
  };
  const plan = (client, extra, b1) => e2.seedPlan(e2.makeBook(client, Object.assign({
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', 2025], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    EVAL_LOG: { values: evalRows(client, extra), formats: { D: '@' } },
  }, b1 ? { PROCESS_STATUS: status(client, b1) } : {})));
  const base = plan('基準製薬', [], new Date(2026, 0, 5, 10));                                   // 締まっていない月の行が無い
  const day3 = plan('三日製薬', ['2026/01', '2026/02'], new Date(2026, 1, 3, 10));               // 2/03 の取り込み: 1 月はまだ途中
  const day6 = plan('六日製薬', ['2026/01', '2026/02'], new Date(2026, 1, 6, 10));               // 2/06 の取り込み: 1 月は締まった（2 月は途中）
  const none = plan('記録無し製薬', [], null);                                                   // B-1 → B-2 の記録が無い
  const acc = (id) => J(e2.run(`appAccuracyOf_('${id}')`));
  const strip = (a) => Object.assign({}, a, { cutoffYm: undefined });
  const a0 = acc(base), a3 = acc(day3), a6 = acc(day6), aN = acc(none);
  assert.deepEqual([a0.cutoffYm, a3.cutoffYm, a6.cutoffYm, aN.cutoffYm], ['2026/01', '2026/01', '2026/02', '']);
  assert.deepEqual(strip(a3), strip(a0), '締まっていない月の行があっても、精度は無いときと同じ（読み飛ばす）');
  assert.deepEqual([a0.n, a0.leaks, a0.months.length], [11, 1, 12]);
  assert.deepEqual([a6.n, a6.months.length, a6.months[12].month], [12, 13, '2026/01'], '6 日の取り込みなら 1 月を数える（2 月は数えない）');
  assert.ok(a6.mape > a0.mape + 0.05, '締まった 1 月の大きな外れが入る: ' + a6.mape);
  assert.deepEqual([aN.n, aN.months, aN.mape, aN.coverage, aN.widthScale], [0, [], null, null, null], 'B-1 → B-2 の記録が無ければ締まった月は無い');
  // 境目を渡しても同じ（全計画をまとめて読む学びの画面が使う形）
  assert.deepEqual(J(e2.run(`appAccuracyOf_('${day3}', appEngTableObjects_('${day3}', ['EVAL_LOG']).EVAL_LOG, '2026/01')`)), a3);
  // 検証の画面: 全計画で縮めた偏りの影も、締まった月だけ（day3 の今の誤差は基準と同じ）
  const v3 = e2.call('apiLearningView(__in)', { __in: { planId: day3 } }), v0 = e2.call('apiLearningView(__in)', { __in: { planId: base } });
  assert.equal(v3.accuracy.n, 11);
  assert.ok(Math.abs(v3.shadow.mapeNow - v0.shadow.mapeNow) < 1e-12 && Math.abs(v3.shadow.bias - v0.shadow.bias) < 1e-12, '縮めた偏りの材料も同じ');
  assert.ok(!v3.accuracy.months.some((m) => m.month >= '2026/01'), '画面に締まっていない月を出さない');
  // 行は消さない
  assert.equal(e2.table('ENG_EVAL_LOG').filter((r) => r.plan_id === day3).length, 14 * 3, '締まっていない月の行も残る');
}
// ==== 6. 今の検証の版の行だけで測る（2026-10-07 D4〜D6）。前の版の行は、締まった月の行でも読み飛ばす（消さない） ====
// B-2 は同じ月の行を上書きし、測らなくなった月（その月が始まる前の予測が無い月）の行は消さないので、前の版で
// 一番新しい回（月が始まった後の予測）と比べた行が締まった月に残る。旧来の B-3〜C-1 はその行を使わないので、新アプリも使わない
{
  const e3 = setUpEnv();
  /** 検証の記録: [月, 実績, P50, 版]（P10・P90 は P50 の ±5%） */
  const evalRows = (client, months) => [H.EVAL_LOG].concat(...months.map(([ym, act, p50, ver], i) => [['nega', p50 * 0.95], ['neutral', p50], ['posi', p50 * 1.05]]
    .map(([sc, p]) => ['E' + i + sc, D(2026, 10, 3), client, ym, sc, p, act, Math.abs(p - act) / act, 0, '', '', sc === 'neutral' ? 1 : 0, p - act, Math.abs(p - act), '', '', '', '', '', '', ver, 1])));
  // B-1 は 10/03（9 月はまだ途中。8 月まで締まった）
  const plan = (client, months) => e3.seedPlan(e3.makeBook(client, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    EVAL_LOG: { values: evalRows(client, months), formats: { D: '@' } },
    PROCESS_STATUS: status(client, new Date(2026, 9, 3, 10)),
  }));
  const acc = (id) => J(e3.run(`appAccuracyOf_('${id}')`));
  // 4 月は前の版（v2）の行（月が始まった後の予測 1500 で測った）、7 月は今の版の行
  const probe = plan('版製薬', [['2026/04', 1000, 1500, 'policy-2026H1-v2'], ['2026/07', 1000, 1100, POLICY]]);
  const ap = acc(probe);
  assert.deepEqual([ap.cutoffYm, ap.months.map((m) => m.month), ap.n], ['2026/09', ['2026/07'], 1], '締まった 4 月でも、前の版の行は数えない');
  assert.ok(Math.abs(ap.mape - 0.1) < 1e-12, '7 月の外れ幅だけ: ' + ap.mape);
  // 同じ今の版の 3 か月に、前の版（v2）・版の無い行（v1 より前）・締まっていない 9 月の今の版の行を足した計画は、足す前の計画と同じ精度・縮めた偏り
  const cur = [['2026/05', 1000, 1100, POLICY], ['2026/06', 1200, 1260, POLICY], ['2026/07', 900, 990, POLICY]];
  const clean = plan('今の版製薬', cur);
  const stale = plan('前の版製薬', [['2026/04', 1000, 1500, 'policy-2026H1-v2']].concat(cur, [['2026/08', 1000, 3000, ''], ['2026/09', 100, 1000, POLICY]]));
  const strip = (a) => Object.assign({}, a, { months: a.months.map((m) => Object.assign({}, m, { evaluatedAt: undefined })) });
  assert.deepEqual(strip(acc(stale)), strip(acc(clean)), '前の版・版の無い行・締まっていない月の行があっても、精度は無いときと同じ');
  assert.deepEqual([acc(stale).n, acc(stale).months.map((m) => m.month)], [3, ['2026/05', '2026/06', '2026/07']]);
  const vs = e3.call('apiLearningView(__in)', { __in: { planId: stale } }), vc = e3.call('apiLearningView(__in)', { __in: { planId: clean } });
  assert.deepEqual([vs.accuracy.n, vs.accuracy.months.map((m) => m.month)], [3, ['2026/05', '2026/06', '2026/07']], '検証の画面にも前の版の月を出さない');
  assert.ok(vs.shadow && vc.shadow, '3 か月あるので縮めた偏りを出す');
  for (const k of ['bias', 'se', 'shrunk', 'factorShadow', 'mapeNow', 'mapeShadow']) assert.ok(Math.abs(vs.shadow[k] - vc.shadow[k]) < 1e-12, '縮めた偏りの材料も同じ: ' + k);
  // 行は消さない
  assert.equal(e3.table('ENG_EVAL_LOG').filter((r) => r.plan_id === stale).length, 6 * 3, '前の版の行も残る');
  assert.equal(e3.table('ENG_EVAL_LOG').filter((r) => r.plan_id === stale && r.evaluation_policy_version === 'policy-2026H1-v2').length, 3);
  // 今の検証の版は、旧来の側（Forecast_Agent.js）の EVALUATION_POLICY_VERSION と同じ（1 つの決まりを両方で使う）。
  // 旧来の側の直し（締まりの日数の定数 …CLOSE…DAYS と一緒に版を上げる）がまだ入っていないときは、知らせて飛ばす
  const legacySrc = await readFile(path.join(repoRoot, 'Forecast_Agent.js'), 'utf8');
  const legacyVer = (/\bconst EVALUATION_POLICY_VERSION = '([^']+)'/.exec(legacySrc) || [])[1];
  assert.ok(legacyVer, '旧来の側に EVALUATION_POLICY_VERSION がある');
  if (/\b[A-Z][A-Z0-9_]*CLOSE[A-Z0-9_]*DAYS?\b\s*[:=]\s*\d+/.test(legacySrc)) assert.equal(legacyVer, POLICY, '旧来の EVALUATION_POLICY_VERSION と同じ版');
  else if (legacyVer !== POLICY) console.log(`app-learning: 旧来の側（Forecast_Agent.js）は検証の決まりの直しの前（${legacyVer}）なので、版の照合を飛ばしました`);
}

// ==== 7. 全計画の事前分布（LEARN.POOL）は、締まった月で数えた当たりだけから作る（D4）。数えた日に四半期の最後の月が締まっていない行は読み飛ばす（消さない） ====
{
  const e4 = setUpEnv();
  const ev = (client, key, qEnd, at, n, hit) => [client, 'opinion', key, 'FY2026-Q', qEnd, n, hit, hit / n, at, 'R', 'expected=' + n / 2];
  // 今の版の B-2 は 7/01 に動いた（その後に数えた行だけを使う。8 で確かめる）
  const plan = (client, rows) => e4.seedPlan(e4.makeBook(client, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    EVAL_LOG: { values: [H.EVAL_LOG, H.EVAL_LOG.map((h) => ({ eval_id: 'E1', evaluated_at: new Date('2026-07-01T00:00:00Z'), client, target_month: '2026/05', scenario: 'neutral',
      pred: 1100, actual: 1000, evaluation_policy_version: POLICY, constraint_relevant_flag: 1 })[h] ?? '')], formats: { D: '@' } },
    RELIABILITY_EVIDENCE: { values: [H.RELIABILITY_EVIDENCE].concat(rows.map((r) => ev(client, ...r))) },
    POOL_PRIOR: { values: [H.POOL_PRIOR] },
  }));
  const x = plan('甲製薬', [
    ['a', '2026/06', new Date('2026-07-10T01:00:00Z'), 10, 6],      // 7/10 に数えた 6 月まで: 締まっていた
    ['b', '2026/09', new Date('2026-10-03T01:00:00Z'), 10, 0],      // 10/03 に数えた 9 月まで: 9 月は途中（読み飛ばす）
  ]);
  const y = plan('乙製薬', [
    ['a', D(2026, 6), '2026-07-10T09:00:00+09:00', 10, 8],         // 月が日付・数えた日時が文字でも読む
    ['b', '2026/09', new Date('2026-10-04T15:00:00Z'), 10, 4],      // 日本の暦で 10/05 0:00: 9 月は締まった
    ['c', '2026/09', new Date('2026-10-04T14:59:00Z'), 10, 0],      // 日本の暦で 10/04 23:59: 9 月は途中（読み飛ばす）
    ['d', '2026/06', '', 5, 0],                                    // 数えた日時が読めない（読み飛ばす）
  ]);
  const pv = e4.task('poolPreview()');
  const op = pv.types.find((t) => t.type === 'opinion');
  assert.deepEqual([op.ok, op.plans, op.n, op.hit], [true, 2, 30, 18], '締まった月で数えた行だけ（甲 6/10・乙 12/20）');
  assert.ok(Math.abs(op.pooledR - 1.2) < 1e-9, '2 × 18 / 30: ' + op.pooledR);
  assert.equal(pv.skippedEvidence, 3, '読み飛ばした行の数');
  const st = e4.runJob('LEARN.POOL', {});
  assert.equal(st.status, 'DONE', st.error);
  for (const id of [x, y]) assert.equal(e4.table('ENG_POOL_PRIOR').find((r) => r.plan_id === id && r.pool_scope === 'reliability:opinion').pooled_value, '1.2');
  assert.deepEqual([x, y].map((id) => e4.table('ENG_RELIABILITY_EVIDENCE').filter((r) => r.plan_id === id).length), [2, 4], '読み飛ばした行も残る');
  // 決まりの境目（appEvidenceClosed_）: 9 月は 10/05 に数えた行から
  const closedAt = (qEnd, at) => e4.run(`appEvidenceClosed_({ quarter_end_month: '${qEnd}', computed_at: new Date('${at}') })`);
  assert.deepEqual([closedAt('2026/09', '2026-10-04T14:59:59Z'), closedAt('2026/09', '2026-10-04T15:00:00Z'), closedAt('', '2026-10-06T00:00:00Z'), closedAt('2026/12', '2027-01-05T00:00:00Z')],
    [false, true, false, true]);
}
// ==== 8. 全計画の事前分布は、その計画で今の検証の版の B-2 が初めて動いた後に数えた当たりだけから作る（D6。前の版の C-1 が数えた行は読み飛ばす。消さない） ====
// 初めて動いた時刻は、今の版の EVAL_LOG の行（B-2 が動くたびに書き直す）と、RUN_LOG の今の版の B-2 の記録の、一番古いもの
{
  const e5 = setUpEnv();
  const at = (s) => new Date(s);
  const evRow = (client, key, qEnd, when, n, hit) => [client, 'opinion', key, 'FY2026-Q', qEnd, n, hit, hit / n, when, 'R', 'expected=' + n / 2];
  const evalRow = (client, when, ver) => H.EVAL_LOG.map((h) => ({ eval_id: 'E-' + ver, evaluated_at: when, client, target_month: '2026/09', scenario: 'neutral', pred: 1100, actual: 1000,
    evaluation_policy_version: ver, constraint_relevant_flag: 1 })[h] ?? '');
  const runRow = (client, when, status, summary) => H.RUN_LOG.map((h) => ({ run_id: 'L' + when.getTime(), run_at: when, run_by: 'owner', function_name: 'updatePhase1EvaluationReport',
    client, status, count: 3, model_version: '2.4.0-dev', error_summary: summary })[h] ?? '');
  const v3sum = POLICY + ': scored_months=3; open_months=1; no_pre_month_forecast=0';
  const plan = (client, { evals = [], runs = [], evidence = [] }) => e5.seedPlan(e5.makeBook(client, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    EVAL_LOG: { values: [H.EVAL_LOG].concat(evals.map(([w, v]) => evalRow(client, w, v))), formats: { D: '@' } },
    RUN_LOG: { values: [H.RUN_LOG].concat(runs.map(([w, st, sm]) => runRow(client, w, st, sm))) },
    RELIABILITY_EVIDENCE: { values: [H.RELIABILITY_EVIDENCE].concat(evidence.map((r) => evRow(client, ...r))) },
    POOL_PRIOR: { values: [H.POOL_PRIOR] },
  }));
  // 丙: 今の版の B-2 は 10/06 9:00（EVAL_LOG）。7/10 に前の版の C-1 が数えた行は使わず、10/06 10:00 の行（今の版の C-1）だけ
  const hei = plan('丙製薬', { evals: [[at('2026-10-06T00:00:00Z'), POLICY], [at('2026-10-02T00:00:00Z'), 'policy-2026H1-v2']],
    evidence: [['a', '2026/06', at('2026-07-10T01:00:00Z'), 10, 0], ['b', '2026/09', at('2026-10-06T01:00:00Z'), 10, 6]] });
  // 丁: 今の版の B-2 がまだ動いていない（前の版の行だけ）。締まった月で数えた行でも使わない
  const tei = plan('丁製薬', { evals: [[at('2026-10-02T00:00:00Z'), 'policy-2026H1-v2']], runs: [[at('2026-10-02T00:00:00Z'), 'success', '']],
    evidence: [['a', '2026/09', at('2026-10-06T01:00:00Z'), 10, 0]] });
  // 戊: 今の版の B-2 は 10/06 に初めて動き（RUN_LOG）、11/06 の B-2 が EVAL_LOG を書き直した。10/08 の今の版の C-1 が数えた行は使う
  const bo = plan('戊製薬', { evals: [[at('2026-11-06T00:00:00Z'), POLICY]],
    runs: [[at('2026-09-01T00:00:00Z'), 'success', ''], [at('2026-10-05T00:00:00Z'), 'error', v3sum], [at('2026-10-06T00:00:00Z'), 'success', v3sum], [at('2026-11-06T00:00:00Z'), 'success', v3sum]],
    evidence: [['a', '2026/09', at('2026-10-08T01:00:00Z'), 10, 6]] });
  // 己: 戊と同じだが RUN_LOG の記録が無い（EVAL_LOG の 11/06 だけでは、10/08 の行は前の版と見分けられないので使わない）
  const ki = plan('己製薬', { evals: [[at('2026-11-06T00:00:00Z'), POLICY]], evidence: [['a', '2026/09', at('2026-10-08T01:00:00Z'), 10, 6]] });
  const from = J(e5.run('appEvidencePolicyFrom_(__ids)', { __ids: [hei, tei, bo, ki] }));
  assert.deepEqual([from[hei], from[tei], from[bo], from[ki]], [Date.parse('2026-10-06T00:00:00Z'), null, Date.parse('2026-10-06T00:00:00Z'), Date.parse('2026-11-06T00:00:00Z')],
    '初めて動いた時刻（RUN_LOG の失敗した回・前の版の回は数えない）');
  const pv = e5.task('poolPreview()');
  const op = pv.types.find((t) => t.type === 'opinion');
  assert.deepEqual([op.ok, op.plans, op.n, op.hit, pv.skippedEvidence], [true, 2, 20, 12, 3], '丙の b と戊だけ（丙の a・丁・己は読み飛ばす）');
  assert.deepEqual(op.perPlan.map((x) => x.client).sort(), ['丙製薬', '戊製薬']);
  const st = e5.runJob('LEARN.POOL', {});
  assert.equal(st.status, 'DONE', st.error);
  for (const id of [hei, tei, bo, ki]) assert.equal(e5.table('ENG_POOL_PRIOR').find((r) => r.plan_id === id && r.pool_scope === 'reliability:opinion').pooled_value, '1.2', '書く値も同じ決まりで作る（2 × 12 / 20）');
  assert.deepEqual([hei, tei, bo, ki].map((id) => e5.table('ENG_RELIABILITY_EVIDENCE').filter((r) => r.plan_id === id).length), [2, 1, 1, 1], '読み飛ばした行も残る');
}

// ==== 9. 検証の画面の scoredMonths: 今の決まりで B-2 が測った月の数（締まった月で、今の版の neutral の行がある月。実績 0 円の月も数える）。
// 精度の月（accuracy.months・n）は実績 0 円の月を除くので、画面は scoredMonths で「まだ比べていない」と「比べた月がどれも売上 0 円」を見分ける ====
{
  const e6 = setUpEnv();
  /** 検証の記録: [月, 実績, P50, 版]（P10・P90 は P50 の ±5%） */
  const evalRows = (client, months) => [H.EVAL_LOG].concat(...months.map(([ym, act, p50, ver], i) => [['nega', p50 * 0.95], ['neutral', p50], ['posi', p50 * 1.05]]
    .map(([sc, p]) => ['E' + i + sc, D(2026, 10, 6), client, ym, sc, p, act, act ? Math.abs(p - act) / Math.abs(act) : '', 0, '', '', sc === 'neutral' ? 1 : 0, p - act, Math.abs(p - act),
      '', '', '', '', '', '', ver, 1])));
  // B-1 は 10/06（9 月まで締まった）
  const plan = (client, months) => e6.seedPlan(e6.makeBook(client, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    EVAL_LOG: { values: evalRows(client, months), formats: { D: '@' } },
    PROCESS_STATUS: status(client, new Date(2026, 9, 6, 10)),
  }));
  const V2 = 'policy-2026H1-v2';
  const never = plan('未比較製薬', [['2026/07', 1000, 1100, V2], ['2026/08', 1000, 1100, V2]]);   // 前の版の行だけ（今の版の B-2 はまだ）
  const zero = plan('売上なし製薬', [['2026/07', 0, 100, POLICY], ['2026/08', 0, 100, POLICY], ['2026/09', 0, 0, POLICY], ['2026/10', 0, 100, POLICY]]);   // 10 月は締まっていない
  const mixed = plan('一部製薬', [['2026/06', 1000, 1100, V2], ['2026/07', 0, 100, POLICY], ['2026/08', 1000, 1100, POLICY], ['2026/09', -50, 100, POLICY]]);
  const view = (id) => e6.call('apiLearningView(__in)', { __in: { planId: id } });
  const v0 = view(never), vz = view(zero), vm = view(mixed);
  assert.deepEqual([v0.scoredMonths, v0.accuracy.months.length, v0.accuracy.n], [0, 0, 0], '今の版の B-2 の前: まだ比べていない');
  assert.deepEqual([vz.scoredMonths, vz.accuracy.months.length, vz.accuracy.n], [3, 0, 0], '比べた月はどれも売上 0 円（精度の月は 0 でも scoredMonths は 3。締まっていない 10 月は数えない）');
  assert.deepEqual([vm.scoredMonths, vm.accuracy.months.map((m) => m.month)], [3, ['2026/08', '2026/09']], '前の版の 6 月は数えない・0 円の 7 月は数える（負の月は精度にも入る）');
  assert.ok([v0, vz, vm].every((v) => typeof v.scoredMonths === 'number' && typeof v.accuracy === 'object'), 'scoredMonths は accuracy と同じ高さの数');
  // 学びの scoredMonths と同じ月の決まり（appEvalScoredMonths_）
  assert.deepEqual(J(e6.run(`appEvalScoredMonths_(appEngTableObjects_('${mixed}', ['EVAL_LOG']).EVAL_LOG, '2026/10')`)),
    [['2026/07', 100, 0], ['2026/08', 1100, 1000], ['2026/09', 100, 0]], '月と、B-4 が写す形の数字（負の実績は 0 円）');
  // 前の形の精度の控え（scoredMonths が無い）が残っていても、その計画の分は数え直して返す
  e6.run(`(() => { const v = appAccuracyOf_(__id); delete v.scoredMonths; appJobPutResult_(appAccuracyKey_(__id), v); })()`, { __id: zero });
  for (const k of Object.keys(e6.cache)) if (!k.includes('APP_JOB_RESULT_')) delete e6.cache[k];
  const again = view(zero);
  assert.deepEqual([again.scoredMonths, again.accuracy.n], [3, 0], '前の形の控えは数え直す');
  assert.equal(J(e6.run(`appJobGetResult_(appAccuracyKey_(__id)).value.scoredMonths`, { __id: zero })), 3, '数え直した精度を控え直す');
}

// ==== 影の階層偏り補正プレビュー（読むだけ。候補は mape が減る計画だけ。何も書かない） ====
{
  env.props.OWNER_TASK = JSON.stringify({ action: 'shadowBiasPreview' });
  const out = env.call('apiOwnerTask()');
  const r = out.result;
  assert.equal(r.writes, false, 'プレビューは書かない');
  assert.equal(r.conformalDeferred, true, '幅の較正は別承認');
  assert.equal(r.version, 'SHADOW_BIAS_PREVIEW_V1');
  assert.ok(r.pooled === true && r.planCount >= 3, '全計画を要約する');
  assert.ok(r.candidateCount >= 1, '過去月で改善する計画が候補になる');
  assert.ok(r.candidates.every(c => c.mapeShadow < c.mapeNow), '候補は外れ幅が減るものだけ');
  assert.ok(r.candidates.every(c => c.proposedSetCalibration && c.proposedSetCalibration.set.bias_correction_factor),
    '候補に setCalibration 案がある');
  assert.equal(env.props.OWNER_TASK, JSON.stringify({ action: 'shadowBiasPreview' }), '読むだけなので頼みは残る');
  const calBefore = env.run(`JSON.stringify(appEngTableObjects_('${ids['甲製薬']}', ['CALIBRATION_STATE']).CALIBRATION_STATE)`);
  env.props.OWNER_TASK = JSON.stringify({ action: 'shadowBiasPreview' });
  env.call('apiOwnerTask()');
  const calAfter = env.run(`JSON.stringify(appEngTableObjects_('${ids['甲製薬']}', ['CALIBRATION_STATE']).CALIBRATION_STATE)`);
  assert.equal(calAfter, calBefore, 'プレビューを繰り返しても補正表は変わらない');
}
console.log('app-learning: all tests passed');
