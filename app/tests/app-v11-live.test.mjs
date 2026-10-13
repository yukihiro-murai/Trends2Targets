#!/usr/bin/env node
/**
 * app-v11-live.test.mjs — 年度の見込み（判断 10）と予算に届く見込み（判断 24）を、決定 4・7 が済んだ計画から本番にする（2026-10-09 村井さん承認）。
 *   1. 計算だけ: 本番か（appLandingLiveOf_: 自動の学びを止めた・所有者が承認した補正・最後の予測がその補正で動いた）と、見せる年度の値（appLandingAnnualShown_）
 *   2. 本物の A-1〜A-3・A-9 をモックで動かす: setCalibration の前は本番でない → setCalibration だけでは本番でない（予測が前の補正のまま）
 *      → A-9 をもう一度動かすと本番。本番で保存した予測の回だけ FORECAST_RUNS.fixes_json に annual_aligned（前の回は書き換えない）
 *   3. 本番の計画: 計画の一覧・ホーム・分析・予測の画面の年度の下振れ・中心・上振れは月の合計にそろえた値。旧来の計算の年度合計は記録に残り
 *      （legacyAnnual・FORECAST_RUNS・OUTPUT の 26 行）、説明に出す。根拠の最終の中心は予測の画面と同じ見せる中心（締まった月なしは月の合計）、
 *      過去の売上だけ・前回・月ごとの中心の合計（monthSum）は月の合計。届く見込みの「（試し）」を外す
 *   4. 補正を書き直すと（係数 1.05・自動の学びを戻す）、予測し直すまで / 旗が 1 の間は本番でない
 *   5. 年度の途中（締まった月がある）本番の計画: 中心と幅 = 着地の推定（同じ分布。2026-10-09。月の合計は monthSum）。ホームの中心と合計の届く見込みも本番。
 *      根拠の最終の中心も着地の推定（月の合計は monthSum。2026-10-09）
 * モックの上の確かめで、本物の Apps Script・ブラウザの上では動かしていない。
 *
 *   node app/tests/app-v11-live.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setUpEnv, makeEnv, uiHtml, OWNER, J } from './gas-mock.mjs';

const near = (a, b, tol, msg) => assert.ok(typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol, `${msg || ''}: ${a} と ${b}`);
const D = (y, m, d = 1) => new Date(y, m - 1, d);
const CLIENT = 'テスト製薬';
const fyYms = (fy) => Array.from({ length: 12 }, (_, i) => { const m = 4 + i; return (m > 12 ? fy + 1 : fy) + '/' + String(m > 12 ? m - 12 : m).padStart(2, '0'); });

// ==== 1. 計算だけ ====
{
  const pure = makeEnv();
  const run = (code, vars) => J(pure.run(code, vars));
  const cal = (o) => Object.assign({ client: 'X', bias_correction_factor: 1, residual_month_bias_json: '', auto_update_enabled: 0, note: 'owner-approved 2026-10-09 10:00: D7' }, o);
  const ap = (o) => JSON.stringify(Object.assign({ version: 'v', quarter: '', ai_weight_override: 0, bias_correction_factor: 1, residual_month_bias_json: '' }, o));
  const live = (c, a) => run('appLandingLiveOf_(__c, __a)', { __c: c, __a: a });
  assert.equal(live(cal(), ap()), true, '所有者の補正・自動の学びを止めた・予測がその補正で動いた');
  assert.equal(live(cal({ auto_update_enabled: 1 }), ap()), false, '自動の学びが動いている');
  assert.equal(live(cal({ auto_update_enabled: '' }), ap()), false, '旗が空は 1（旧来と同じ読み方）');
  assert.equal(live(cal({ auto_update_enabled: '0' }), ap()), true, '旗の文字の 0');
  assert.equal(live(cal({ note: 'auto-learned' }), ap()), false, '自動の学びの値');
  assert.equal(live(cal({ note: '' }), ap()), false);
  assert.equal(live(cal(), ap({ bias_correction_factor: 0.8 })), false, '見せている予測は前の係数 0.8 で動いた');
  assert.equal(live(cal(), ap({ residual_month_bias_json: '{"4":0.05}' })), false, '前の月ごとの補正で動いた');
  assert.equal(live(cal({ residual_month_bias_json: '{}' }), ap({ residual_month_bias_json: '' })), true, '{} と空はどちらも補正なし');
  assert.equal(live(cal({ bias_correction_factor: 1.05, residual_month_bias_json: '{"9":-0.1,"4":0.05}' }),
    ap({ bias_correction_factor: 1.05, residual_month_bias_json: '{"4":0.05,"9":-0.1}' })), true, '並びが違っても同じ値');
  assert.equal(live(cal({ bias_correction_factor: '' }), ap({ bias_correction_factor: 1 })), true, '空の係数は 1');
  assert.equal(live(cal(), ap({ ai_weight_override: '' })), true, 'AI の効きは比べない（係数と月ごとの補正だけ）');
  assert.equal(live(cal(), null), false, '予測の記録が無い');
  assert.equal(live(cal(), '{bad'), false, '読めない記録');
  assert.equal(live(null, ap()), false, '補正の行が無い');
  assert.equal(live(cal(), { bias_correction_factor: 1, residual_month_bias_json: '' }), true, 'オブジェクトでもよい');
  assert.equal(run('appLandingOwnerSet_(__c)', { __c: cal({ note: '  owner-approved x' }) }), true, '前の空白は無視');
  // 補正の行の選び方（Calibration.js と同じ: メーカーの行、無ければ 1 行だけならその行）
  const rows = [{ client: 'A', note: 'x' }, { client: 'B', note: 'y' }];
  assert.equal(run('appLandingCalRow_(__r, "B")', { __r: rows }).note, 'y');
  assert.equal(run('appLandingCalRow_(__r, "C")', { __r: rows }), null, '行が 2 つでメーカーが合わない');
  assert.equal(run('appLandingCalRow_(__r, "C")', { __r: rows.slice(0, 1) }).note, 'x', '1 行だけならその行');
  assert.equal(run('appLandingCalRow_(__r, "")', { __r: [{ client: '', note: '' }] }), null, '空の行は数えない');
  // 最後の予測の補正（run_date が一番新しい回。日時の型でも文字でも）
  assert.equal(run('appLandingLastApplied_(__r)', { __r: [{ run_date: '2026-10-01T10:00:00+0900', calibration_applied_json: 'a' },
    { run_date: '2026-10-09T10:00:00+0900', calibration_applied_json: 'b' }, { run_date: '2026-10-05T10:00:00+0900', calibration_applied_json: 'c' }] }), 'b');
  assert.equal(pure.run(`appLandingLastApplied_([{ run_date: new Date(2026, 9, 9), calibration_applied_json: 'new' }, { run_date: new Date(2026, 9, 1), calibration_applied_json: 'old' }])`), 'new');
  assert.equal(run('appLandingLastApplied_([])'), null);
  // 見せる年度の値: 中心 = 月の P50 の合計。幅は締まった月なしなら試しの幅、年度の途中は着地の推定の幅、12 か月・数え直し中は無し
  const yms = fyYms(2026);
  const months = yms.map((ym, i) => ({ ym, p10: 70 + i, p50: 90 + 2 * i, p90: 120 + 3 * i }));
  const F = months.reduce((s, m) => s + m.p50, 0);
  const al0 = run('appLandingAligned_(2026, __m, 0.15, 1, 1300)', { __m: months });
  const s0 = run('appLandingAnnualShown_(__a, null)', { __a: al0 });
  assert.deepEqual([s0.p10, s0.p50, s0.p90, s0.band, s0.k, s0.done, s0.pending, s0.basis, s0.monthSum, s0.legacy], [al0.p10, F, al0.p90, 'aligned', 0, false, false, 'monthsum', F, null]);
  const acts = Object.fromEntries([95, 100, 105, 90, 110, 100].map((x, i) => [yms[i], x]));
  const sky6 = run('appLandingSky_(__in)', { __in: { fy: 2026, months, actual: acts, cutoffYm: '2026/10', todayYm: '2026/10', budget: 1300 } });
  const al6 = run('appLandingAligned_(2026, __m, 0.15, 1, 1300, { k: 6 })', { __m: months });
  const s6 = run('appLandingAnnualShown_(__a, __s)', { __a: al6, __s: sky6 });
  assert.deepEqual([s6.p10, s6.p50, s6.p90, s6.band, s6.k, s6.basis, s6.monthSum], [sky6.landingP10, sky6.landing, sky6.landingP90, 'landing', 6, 'landing', F],
    '年度の途中: 中心と幅は着地の推定（同じ分布。2026-10-09）。月の合計は monthSum');
  const sp = run('appLandingAnnualShown_(__a, __s)', { __a: run('appLandingAligned_(2026, __m, 0.15, 1, 1300, { k: 0, pending: true })', { __m: months }), __s: sky6 });
  assert.deepEqual([sp.p10, sp.p50, sp.p90, sp.band, sp.pending, sp.basis], [null, F, null, '', true, 'monthsum'], '締まった月を数え直している間は幅なし（中心は月の合計）');
  const acts12 = Object.fromEntries(yms.map((ym, i) => [ym, 100 + i]));
  const sky12 = run('appLandingSky_(__in)', { __in: { fy: 2026, months, actual: acts12, cutoffYm: '2027/04', todayYm: '2027/04', budget: 1300 } });
  const sd = run('appLandingAnnualShown_(__a, __s)', { __a: run('appLandingAligned_(2026, __m, 0.15, 1, 1300, { k: 12 })', { __m: months }), __s: sky12 });
  assert.deepEqual([sd.p10, sd.p50, sd.p90, sd.band, sd.done, sd.basis, sd.monthSum], [null, 1266, null, '', true, 'actual', F], '12 か月を数えた年度は実績の合計で幅なし');
  assert.deepEqual([run('appLandingAnnualShown_(null, null)'), run('appLandingAnnualShown_(__a, null)', { __a: al6 }).band], [null, ''], '着地の推定が無ければ幅なし');
  assert.equal(pure.run('APP_FIX_ANNUAL_ALIGNED'), 'annual_aligned');
}

// ---- 道具（app-calibration.test.mjs と同じ） ----
function task(env, t) { env.props.OWNER_TASK = JSON.stringify(t); return env.call('apiOwnerTask()'); }
function finishJob(env) {
  for (let i = 0; i < 30; i++) {
    env.fireTriggers('triggerRunJob');
    const st = env.call('apiOwnerTask()').result;
    if (['QUEUED', 'RUNNING', 'CONTINUED'].includes(st.status)) continue;
    delete env.props.OWNER_TASK;
    return st;
  }
  throw new Error('処理が終わらない');
}
function setCal(env, t) {
  const full = task(env, Object.assign({ action: 'setCalibration' }, t));
  assert.equal(full.ok, true);
  const st = finishJob(env);
  assert.equal(st.status, 'DONE', st.error);
  return st;
}
function editLegacy(env, planId, sheets, edit, extra) {
  env.run(`appWithLock_(() => {
    const plan = appPlanOf_(__p); const scratch = appWorkScratch_(plan); let st = null;
    do { st = appScratchBuildStep_(scratch, __p, __sheets, st && st.state, Date.now() + 60000); } while (!st.complete);
    (${edit})(scratch);
    const cap = appCaptureChanged_(scratch, __p, appStoredHashes_(__p), __sheets);
    if (cap.changed.length) appJournalRun_({ actor: 'test', requestId: 'T' }, 'テストの準備', __p, appChangedOps_({ actor: 'test' }, __p, cap.changed, 'T'));
  })`, Object.assign({ __p: planId, __sheets: sheets }, extra || {}));
}
/** 画面（UI.html の script）を vm で読み込む */
function loadUi() {
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
  const el = () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
  const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, confirm: () => false,
    window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  return ui;
}
const ui = loadUi();
const R = (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };
const tips = (html) => [...html.matchAll(/data-tip="([^"]*)"/g)].map((m) => m[1]).join('\n');
const noCodes = (text, what) => assert.doesNotMatch(text, /P10|P50|P90|τ|\bw\b|B-\d|C-\d|EVAL_|annual_aligned|owner-approved|undefined|NaN|null/, what + 'に中の記号・undefined を出さない');

// ==== 2〜4. 本物の A-1〜A-3・A-9 で: setCalibration と予測し直しで本番になる ====
const env = setUpEnv();
const currentFy = env.run('appFy_(new Date())');
let planId;
{
  const ext = Array.from({ length: 70 }, () => '');
  const rec = (product, month, amount) => { const r = ext.slice(); r[40] = CLIENT; r[45] = 'ベース'; r[49] = product; r[56] = month; r[65] = amount; return r; };
  const sheets = {};
  for (let y = currentFy - 5; y <= currentFy; y++) {
    const rows = [ext.map((_, i) => 'c' + (i + 1))];
    for (let m = 1; m <= 12; m++) {
      const dt = D(y, m, 15);
      if (dt < D(currentFy - 5, 4, 1) || dt > D(currentFy, 3, 31)) continue;
      rows.push(rec('製品A', dt, Math.round(1000000 + 50000 * Math.sin(m) + 12000 * (y - currentFy + 5) + m * 2000)));
      rows.push(rec('製品B', dt, Math.round(400000 + 20000 * Math.cos(m))));
    }
    sheets['*' + y + '_actual_value'] = { cols: 70, values: rows };
  }
  const zac = env.makeBook('売上の元', sheets);
  env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });
  let st = env.runJob('PLAN.CREATE', { clientName: CLIENT, fy: currentFy, peopleCsv: '鷹野' });
  assert.equal(st.status, 'DONE', st.error);
  planId = st.result.planId;
  for (const action of ['IMPORT.SALES', 'SALES.AGGREGATE']) {
    st = env.runJob('PLAN.RUN', { planId, action });
    assert.equal(st.status, 'DONE', action + ': ' + st.error);
  }
  // 予測に要る入力（見解は担当者全員・製品とメーカー全体は理由つきで 1 件以上。app-calibration.test.mjs と同じ）
  for (const [kind, row] of [['opinions', { person: '鷹野', ym: currentFy + '-04', step: '-5', conf: '0.6', note: '' }],
    ['product', { person: '鷹野', product: '製品A', ym: currentFy + '-04', step: '5', reason: '新規' }], ['client', { person: '鷹野', ym: currentFy + '-04', step: '-3', reason: '全体' }]]) {
    const v = env.call('apiPlanView(__in)', { __in: { planId } });
    st = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind, rows: [row] }, inputHash: v.inputHash });
    assert.equal(st.status, 'DONE', kind + ': ' + st.error);
  }
  // 学んだ補正（月次の自動学習が下げた係数と暦月の補正。自動の学びは動いている）
  const calRow = { client: CLIENT, updated_at: D(currentFy, 10, 1), updated_by: 'auto', ai_weight_override: '', ai_max_abs_effect_override: '', ai_topic_disable_json: '[]',
    bias_correction_factor: 0.8, qual_scale_override: '', residual_month_bias_json: '{"4":0.05,"9":-0.1}', last_applied_quarter: '', last_applied_review_id: '',
    auto_update_enabled: 1, note: 'auto-learned' };
  editLegacy(env, planId, ['CALIBRATION_STATE'], `function (b) {
    const sh = b.getSheetByName('CALIBRATION_STATE');
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    sh.getRange(2, 1, 1, head.length).setValues([head.map(h => __cal[h] === undefined ? '' : __cal[h])]);
  }`, { __cal: calRow });
  // 年度の始めの日（締まった月がまだ無い。実績の取り込みの遅れにもならない）で見る
  env.run(`appToday_ = function () { return '${currentFy}-04-10'; }`);
}
const runForecast = () => { const st = env.runJob('FORECAST.RUN', { planId, confirms: ['extreme'] }); assert.equal(st.status, 'DONE', st.error); return st.result; };
const runsOf = () => env.table('FORECAST_RUNS').filter((r) => r.plan_id === planId);
const fixesOf = (runId) => JSON.parse(runsOf().find((r) => r.run_id === runId).fixes_json || '[]');
const port = () => env.call('apiPortfolio()').plans.find((p) => p.planId === planId);
const isLive = () => env.run('appPlanAlignedLive_(__p)', { __p: planId });
const monthlySum = (runId) => env.table('FORECAST_MONTHLY').filter((m) => m.run_id === runId).reduce((s, m) => s + Number(m.p50), 0);
/** 予測の画面（予測と予算）を、サーバーの応答から描く */
const forecastTab = () => {
  const latest = env.call('apiForecastLatest(__in)', { __in: { planId } });
  const ms = (latest.monthly || []).map((m, i) => ({ row: 29 + i, month: m.ym, p10: Number(m.p10), p50: Number(m.p50), p90: Number(m.p90), adopted: Number(m.p50), uplift: '', final: Number(m.p50) }));
  const sum = (k) => ms.reduce((s, m) => s + m[k], 0);
  const sec = { annual: { p10: latest.latest.annual_p10, p50: latest.latest.annual_p50, p90: latest.latest.annual_p90, adopted: sum('p50'), uplift: 0, final: sum('p50') }, monthly: ms };
  const view = { plan: Object.assign({}, latest.plan, { measure: false }), can: { plan: true, approve: true, admin: true }, inputHash: 'h', actions: [], boot: { output: { sections: [sec] } } };
  return { latest, html: R(`S.fc.planId = __id; S.fc.view = __v; S.fc.data = __d; S.fc.budget = {}; fcForecastTab(__d, __v)`, { __id: planId, __d: latest, __v: view }) };
};

let r1, r2;
{
  // ---- 2a. 自動の学びの補正のまま予測: 本番でない（今までどおり「（試し）」） ----
  r1 = runForecast();
  assert.equal(isLive(), false, '自動の学びの補正のまま');
  assert.deepEqual(fixesOf(r1.runId), [], '本番でない回の fixes_json は空');
  const p = port();
  assert.equal(p.alignedLive, false);
  assert.deepEqual([p.p10, p.p50, p.p90], [r1.headline.annual.p10, r1.headline.annual.p50, r1.headline.annual.p90], '年度は旧来の計算の年度合計のまま');
  assert.deepEqual(p.legacyAnnual, { p10: r1.headline.annual.p10, p50: r1.headline.annual.p50, p90: r1.headline.annual.p90 });
  assert.ok(p.aligned && p.reach, '前提: 試しの数がある（予測がそろい、締まった月が無い）');
  assert.deepEqual([p.aligned.live, p.reach.live, p.aligned.k, p.annualBand], [false, false, 0, '']);
  const t = forecastTab();
  assert.equal(t.latest.shadow.live, false);
  assert.equal(t.latest.shadow.annual, null);
  assert.ok(t.html.includes('月の合計 ' + R(`yenShort(${p.aligned.center})`) + '<span class="nw">（試し）</span>'), '本番でなければ中心の下に試しの中心');
  assert.match(t.html, /この予算に届く見込み [^<]*（試し）<\/span>/, '本番でなければ届く見込みは試し');
  assert.doesNotMatch(tips(t.html), /旧来の計算の年度合計/);
  assert.match(R('homeReachTip(__r)', { __r: env.call('apiHome()').totals.reach }), /この予算に届く見込み（試し）: /, 'ホームも試し');

  // ---- 2b. setCalibration（決定 7: 補正なし・自動の学びを止める）だけでは本番でない（見せている予測は前の補正 0.8 のまま） ----
  setCal(env, { planId, set: { bias_correction_factor: 1, residual_month_bias_json: '{}', auto_update_enabled: 0 }, reason: 'D7 の確かめ' });
  const cs = env.table('ENG_CALIBRATION_STATE').filter((r) => r.plan_id === planId)[0];
  assert.match(cs.note, /^owner-approved /, '前提: 所有者が承認した値');
  assert.equal(isLive(), false, '予測し直すまでは本番でない');
  assert.equal(port().alignedLive, false);
  assert.equal(forecastTab().latest.shadow.live, false);

  // ---- 2c. 予測し直す: 本番。この回だけ fixes_json に annual_aligned（前の回は書き換えない） ----
  r2 = runForecast();
  assert.equal(isLive(), true, 'setCalibration の後に予測し直した');
  assert.equal(env.run('appPlanAlignedLive_(appPlanOf_(__p))', { __p: planId }), true, 'PLANS の行でも');
  assert.equal(env.run('appPlanAlignedLive_("")'), false);
  assert.deepEqual(fixesOf(r2.runId), ['annual_aligned'], '本番で保存した回');
  assert.deepEqual(fixesOf(r1.runId), [], '前の回は書き換えない');
  assert.equal(runsOf().length, 2, '行は足すだけ');
}

// ==== 3. 本番の計画の見せ方: 計画の一覧・ホーム・分析・予測の画面・根拠 ====
{
  const p = port();
  const center = monthlySum(r2.runId);
  assert.equal(p.alignedLive, true);
  near(p.p50, center, 1e-6, '中心 = 月の中心の合計（補正を入れた値）');
  near(p.aligned.center, center, 1e-6);
  assert.deepEqual([p.annualBand, p.p10, p.p90], ['aligned', p.aligned.p10, p.aligned.p90], '締まった月が無い: 試しの幅（着地見込みと同じ式）');
  assert.ok(p.p10 < p.p50 && p.p50 < p.p90);
  assert.deepEqual([p.aligned.live, p.reach.live], [true, true]);
  // 旧来の計算の年度合計は記録に残る（FORECAST_RUNS・OUTPUT の 26 行）
  assert.deepEqual(p.legacyAnnual, { p10: r2.headline.annual.p10, p50: r2.headline.annual.p50, p90: r2.headline.annual.p90 });
  const row = runsOf().find((r) => r.run_id === r2.runId);
  assert.equal(Number(row.annual_p50), r2.headline.annual.p50, 'FORECAST_RUNS の年度合計は旧来の計算の値のまま');
  assert.equal(env.call('appStoredHeadline_(__p)', { __p: planId }).annual.p50, r2.headline.annual.p50, 'OUTPUT の 26 行もそのまま');
  assert.ok(Math.abs(p.p50 - r2.headline.annual.p50) > 1, '前提: 旧来の年度合計と月の合計は違う: ' + p.p50 + ' / ' + r2.headline.annual.p50);
  // ホーム・分析も同じ中心
  const home = env.call('apiHome()');
  const hp = home.plans.find((x) => x.planId === planId);
  assert.deepEqual([hp.p10, hp.p50, hp.p90, hp.alignedLive, hp.annualBand], [p.p10, p.p50, p.p90, true, 'aligned'], 'ホームの中心も本番の値');
  assert.deepEqual(hp.legacyAnnual, p.legacyAnnual);
  assert.equal(home.totals.reach.live, true, '合計の届く見込みも本番（入れた計画がどれも本番）');
  const cross = env.call('apiCrossMaker(__in)', { __in: { fy: String(currentFy) } });
  near(cross.plans.find((x) => x.planId === planId).p50, center, 1e-6, '分析の中心も本番の値');
  near(cross.totals.p50, center, 1e-6, '分析の合計の中心も');
  // 予測の画面: 年度の下振れ・中心・上振れは本番の値。旧来の年度合計は説明に。「（試し）」は出さない
  const t = forecastTab();
  const sh = t.latest.shadow;
  assert.deepEqual([sh.live, sh.annual.p50, sh.annual.p10, sh.annual.p90, sh.annual.band], [true, p.p50, p.p10, p.p90, 'aligned']);
  assert.deepEqual(sh.annual.legacy, p.legacyAnnual);
  const ys = (n) => R(`yenShort(${n})`);
  const yu = (n) => R(`yenU(${n})`);
  const kpis = t.html.slice(t.html.indexOf('class="kpis"'), t.html.indexOf('<div class="k">最終予算</div>'));
  for (const [k, v] of [['下振れ', p.p10], ['中心', p.p50], ['上振れ', p.p90]]) {
    assert.ok(kpis.includes('（年度合計）\n' + yu(v) + '\n'), '数字の箱の正確な金額は本番の値: ' + k);
    assert.ok(kpis.includes('<div class="k">' + k + '</div><div class="v">' + ys(v) + '<span class="u">円</span>'), '年度の数字は本番の値: ' + k);
  }
  assert.ok(!kpis.includes('（年度合計）\n' + yu(r2.headline.annual.p50) + '\n'), '旧来の年度合計は数字の箱に出さない（説明だけ）');
  assert.doesNotMatch(t.html, /（試し）/, '本番の計画は「（試し）」を出さない');
  assert.doesNotMatch(kpis, /hm-sub/, '中心の下の試しの行は出さない');
  const tt = tips(t.html);
  assert.ok(tt.includes('旧来の計算の年度合計 下振れ ' + yu(r2.headline.annual.p10) + '・中心 ' + yu(r2.headline.annual.p50) + '・上振れ ' + yu(r2.headline.annual.p90)), '旧来の年度合計は説明に');
  assert.match(tt, /月ごとの中心を足した値です（補正を入れた値）/);
  assert.match(tt, /80% の幅は、着地見込みと同じ式（締まった月なし・年の水準のぶれ 15%・幅の倍率 1 倍）でつけています/);
  assert.match(t.html, /<span class="meta" data-tip="この予算に届く見込み: [^"]*">この予算に届く見込み [^<（]+<\/span>/, '届く見込みの行から「（試し）」を外す');
  assert.match(tt, /着地見込みと同じ計算です/);
  assert.doesNotMatch(tt, /計算の試しです/);
  noCodes(t.html.replace(/<[^>]*>/g, ' ') + '\n' + tt.replace(/80% の幅/g, ''), '予測と予算（本番）');
  // ホームの年間予算の説明も「（試し）」を外す
  const hr = R('homeReachTip(__r)', { __r: home.totals.reach });
  assert.match(hr, /^\nこの予算に届く見込み: /);
  assert.doesNotMatch(hr, /試し|保存している数字は変わりません/);
  // 根拠: 最終の中心は予測の画面と同じ見せる中心（締まった月なしは月の合計）。過去の売上だけ・前回・月ごとの中心の合計は月の合計（旧来の年度合計は annual.legacy）
  const basis = env.call('apiForecastBasis(__in)', { __in: { planId } });
  assert.equal(basis.annual.live, true);
  assert.deepEqual([basis.annual.p50, basis.annual.basis, basis.annual.k], [sh.annual.p50, 'monthsum', 0], '根拠の最終の中心は予測の画面と同じ（締まった月なし = 月の合計）');
  near(basis.annual.p50, center, 1e-6, '締まった月なしの見せる中心は月の合計');
  near(basis.annual.monthSum, basis.monthly.reduce((s, m) => s + m.p50, 0), 1e-6, '月ごとの中心の合計は月ごとの内訳の合計と同じ');
  near(basis.annual.monthSum, center, 1e-6);
  near(basis.annual.prevP50, monthlySum(r1.runId), 1e-6, '前回の中心も月の合計');
  near(basis.annual.objective, basis.monthly.reduce((s, m) => s + m.objective, 0), 1e-6, '過去の売上だけも月の合計');
  assert.deepEqual([basis.annual.legacy.p50, basis.annual.legacy.prevP50, basis.annual.legacy.objective],
    [r2.headline.annual.p50, r1.headline.annual.p50, r2.headline.objective.p50], '旧来の年度合計は残す');
}

// ==== 4. 補正を書き直すと、予測し直すまで本番でない。自動の学びを戻すと本番でない（その間の回は fixes_json 空） ====
{
  setCal(env, { planId, set: { bias_correction_factor: 1.05 }, reason: '係数を書き直す' });
  assert.equal(isLive(), false, '見せている予測は係数 1 のまま');
  const p = port();
  assert.equal(p.alignedLive, false);
  assert.deepEqual([p.p50, p.annualBand], [p.legacyAnnual.p50, ''], '本番でない間は旧来の年度合計に戻る');
  const r3 = runForecast();
  assert.equal(isLive(), true, '予測し直すと本番');
  assert.deepEqual(fixesOf(r3.runId), ['annual_aligned']);
  near(port().p50, monthlySum(r3.runId), 1e-6);
  setCal(env, { planId, set: { auto_update_enabled: 1 }, reason: '自動の学びを戻す' });
  assert.equal(isLive(), false, '自動の学びが動いている間は本番でない（補正の値は同じでも）');
  const r4 = runForecast();
  assert.equal(isLive(), false);
  assert.deepEqual(fixesOf(r4.runId), [], '本番でない間に保存した回は空');
  assert.deepEqual(runsOf().map((r) => JSON.parse(r.fixes_json || '[]')), [[], ['annual_aligned'], ['annual_aligned'], []], '行ごとの印は保存したときのまま');
  assert.equal(forecastTab().latest.shadow.live, false);
}

// ==== 5. 年度の途中（締まった 6 か月）の本番の計画: 中心は月の合計、幅は着地の推定の幅。ホームの合計の届く見込み ====
{
  const e = makeEnv();
  e.run(`appToday_ = function () { return '2026-10-06'; }`);
  e.as(OWNER);
  e.call('apiSetup()');
  const yms = fyYms(2026);
  const HC = J(e.run('APP_ENGINE_SHEETS.EVAL_COMPARE_MONTHLY.header'));
  const HS = J(e.run('APP_ENGINE_SHEETS.PROCESS_STATUS.header'));
  const HCAL = J(e.run('APP_ENGINE_SHEETS.CALIBRATION_STATE.header'));
  const HSN = J(e.run('APP_ENGINE_SHEETS.FORECAST_SNAPSHOT.header'));
  const mm = yms.map((ym, i) => ({ p10: 70 + i, p50: 90 + 2 * i, p90: 120 + 3 * i }));
  const output = [['FY2026 売上予測']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 1100, 1150, 1200]);
  output.push([], ['月', 'P10', 'P50', 'P90', '', '', '', '採用予測', '上乗せ']);
  yms.forEach((ym, i) => output.push([ym, mm[i].p10, mm[i].p50, mm[i].p90, '', '', '', mm[i].p50, '']));
  const obj = (H, o) => H.map((h) => (o[h] === undefined ? '' : o[h]));
  const cmpRow = (ym, act) => obj(HC, { target_month: ym, actual_total: act });
  const book = (client, { owner, applied }) => e.makeBook(client, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    OUTPUT: { values: output },
    EVAL_COMPARE_MONTHLY: { values: [HC, ...yms.slice(0, 6).map((ym, i) => cmpRow(ym, 95 + i))] },
    PROCESS_STATUS: { values: [HS, ['step2_status', new Date(2026, 9, 5, 10), 'owner', 'success', client, 10, ''], ['step5_status', new Date(2026, 9, 5, 11), 'owner', 'success', '', 6, '']] },
    CALIBRATION_STATE: { values: [HCAL, obj(HCAL, { client, bias_correction_factor: 1, residual_month_bias_json: '', auto_update_enabled: owner ? 0 : 1,
      note: owner ? 'owner-approved 2026-10-01 10:00: D7' : 'auto-learned' })] },
    FORECAST_SNAPSHOT: { values: [HSN, obj(HSN, { snapshot_id: 'S1', run_date: new Date(2026, 9, 2, 9), client, target_month: '2026/04', scenario: 'neutral', final_pred: 90,
      calibration_applied_json: JSON.stringify({ version: 'v', bias_correction_factor: applied, residual_month_bias_json: '' }) })], formats: { D: '@' } },
  });
  const idLive = e.seedPlan(book('本番製薬', { owner: true, applied: 1 }));
  const idOld = e.seedPlan(book('前の補正製薬', { owner: true, applied: 0.8 }));   // 所有者の補正だが、見せている予測は前の係数 0.8
  const idAuto = e.seedPlan(book('自動製薬', { owner: false, applied: 1 }));
  const ps = Object.fromEntries(e.call('apiPortfolio()').plans.map((p) => [p.planId, p]));
  const F = mm.reduce((s, m) => s + m.p50, 0);
  const L = ps[idLive];
  assert.deepEqual([L.alignedLive, L.k, L.annualBand, L.aligned.k], [true, 6, 'landing', 6]);
  near(L.p50, L.landing, 1e-9, '年度の途中の中心は着地の推定（幅と同じ分布。2026-10-09）');
  assert.deepEqual([L.p10, L.p90], [L.landingP10, L.landingP90], '年度の途中の幅は着地の推定の幅');
  assert.deepEqual([L.annualShown.basis, L.annualShown.p50, L.annualShown.monthSum], ['landing', L.p50, F], '月の合計は monthSum に');
  assert.deepEqual(L.legacyAnnual, { p10: 1100, p50: 1150, p90: 1200 }, '旧来の年度合計（予測の記録が無いので OUTPUT の 26 行）');
  assert.deepEqual([ps[idOld].alignedLive, ps[idOld].p50, ps[idAuto].alignedLive, ps[idAuto].p50], [false, 1150, false, 1150], '本番でない計画は旧来の年度合計');
  assert.deepEqual([e.run('appPlanAlignedLive_(__p)', { __p: idLive }), e.run('appPlanAlignedLive_(__p)', { __p: idOld }), e.run('appPlanAlignedLive_(__p)', { __p: idAuto })],
    [true, false, false], '1 つの計画を読む入口も同じ判定');
  const h = e.call('apiHome()');
  assert.equal(h.plans.find((x) => x.planId === idLive).p50, L.p50, 'ホームの中心も本番の値');
  assert.equal(h.totals.reach.live, false, '本番でない計画も入る合計は試しのまま');
  // 予測の画面の説明: 年度の途中の幅は着地の推定の幅
  const lat = e.call('apiForecastLatest(__in)', { __in: { planId: idLive } });
  assert.deepEqual([lat.shadow.live, lat.shadow.annual.band, lat.shadow.annual.k], [true, 'landing', 6]);
  assert.equal(R('fcLiveBandTip(__a, __al)', { __a: lat.shadow.annual, __al: lat.shadow.aligned }), '80% の幅は、着地の推定（締まった 6 か月の実績を入れた見込み）の幅です');
  assert.equal(R('fcLiveBandTip({ band: "", done: true }, null)'), '12 か月の実績がそろったので、幅はありません');
  assert.equal(R('fcLiveBandTip({ band: "", pending: true }, null)'), '実績を取り込んだ後、当たり具合を計算するまで、幅は出しません');
  // 本番の計画だけなら、合計の届く見込みも本番
  const only = e.call('apiHome()').plans.filter((x) => x.planId === idLive);
  const tot = J(e.run('appHomeTotals_(__p, "2026", null)', { __p: only }));
  assert.equal(tot.reach.live, true);
  // 根拠の最終の中心も予測の画面と同じ着地の推定（月の合計は monthSum。過去の売上からの差・前回からは月の合計どうし。2026-10-09）
  const bs = e.call('apiForecastBasis(__in)', { __in: { planId: idLive } });
  assert.deepEqual([bs.annual.live, bs.annual.basis, bs.annual.k], [true, 'landing', 6]);
  near(bs.annual.p50, L.p50, 1e-9, '根拠の最終の中心 = 予測の画面の中心（着地の推定）');
  near(bs.annual.monthSum, F, 1e-9, '月ごとの中心の合計（月ごとの内訳の合計）');
  near(bs.annual.monthSum, bs.monthly.reduce((s, m) => s + m.p50, 0), 1e-9);
  assert.equal(e.call('apiForecastBasis(__in)', { __in: { planId: idAuto } }).annual.live, undefined, '本番でない計画は今までどおり');
}

console.log('app-v11-live: all tests passed');
