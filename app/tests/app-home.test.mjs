#!/usr/bin/env node
/**
 * app-home.test.mjs — ホーム（最重要のこと）・読んだ結果の控え（書いたら古くする）・短い保存をその場で動かす。
 *
 *   node app/tests/app-home.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { OWNER, MEMBER, setUpEnv, STATS, makeEnv, J, sources, uiHtml } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const env = setUpEnv();
const output = [['FY2026 売上予測（テスト製薬）']];
for (let r = 2; r <= 25; r++) output.push([]);
output.push(['年度合計（予測）', 900, 1000, 1100]);
const book = env.makeBook('見本', {
  CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', 'テスト製薬'], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
  OUTPUT: { values: output },
  PROCESS_STATUS: { values: [['step_key', 'last_run_date', 'last_run_by', 'status', 'target_client', 'record_count', 'error_summary'],
    ['step1_status', D(2026, 9, 30), 'owner', 'error', 'テスト製薬', 0, '取り込めませんでした']] },
});
const planId = env.seedPlan(book);

// ==== 1. ホーム: 計画の状態・承認待ち・空模様。管理者には仕組みの状態。最初の画面にも入れる ====
{
  const h = env.call('apiHome()');
  assert.equal(h.fy, '2026');
  assert.equal(h.plans.length, 1);
  assert.deepEqual([h.plans[0].planId, h.plans[0].clientName, h.plans[0].p50], [planId, 'テスト製薬', 1000]);
  assert.deepEqual([h.plans[0].p10, h.plans[0].p90], [900, 1100], '年間の P10/P90 も渡す');
  assert.deepEqual([h.plans[0].sky, h.plans[0].skyReason, h.plans[0].landing, h.plans[0].budgetSource], ['mikakunin', 'no_budget', null, ''], '予算も月の予測も無ければ霧');
  assert.deepEqual(h.plans[0].stepErrors, ['step1_status'], '手順のエラーを拾う（よみが「進み」を見るよう頼む）');
  assert.deepEqual([h.approvals, h.mine], [[], []]);
  assert.deepEqual([h.recent, h.fys], [undefined, undefined], '画面で使わない「最近の動き」と年度の一覧は作らない（予測の実行・操作の記録を読まない）');
  assert.deepEqual(h.totals, { plans: 1, budget: null, budgetPlans: 0, actualYtd: null, landing: null, landingPlans: 0, ratio: null, ratioPlans: 0 }, '見せる年度の合計（予算も着地も無い）');
  assert.ok(h.system && 'backup' in h.system && 'journal' in h.system, '管理者には仕組みの状態');
  assert.equal(env.boot().home.plans.length, 1, '最初の画面にホームの中身を入れる');
  env.task(`saveMember({ email: '${MEMBER}', displayName: 'M' })`);
  env.as(MEMBER);
  const hm = env.call('apiHome()');
  assert.equal(hm.system, undefined, '管理者でなければ仕組みの状態は出さない');
  assert.equal(hm.plans.length, 1, '閲覧は社内全員');
  env.as(OWNER);
}

// ==== 2. 読んだ結果の控え: データ本体が変わらない間は表を読まない。書いたらすぐ読み直す ====
{
  env.call('apiListPlans()');
  env.call('apiPortfolio()');
  env.call('apiHome()');
  const r0 = STATS.reads;
  assert.equal(env.call('apiListPlans()').plans.length, 1);
  env.call('apiPortfolio()');
  env.call('apiHome()');
  assert.equal(STATS.reads - r0, 0, '控えから返す（表を読まない）');
  env.task(`saveClient({ clientName: '別の製薬' })`);
  const r1 = STATS.reads;
  env.call('apiListPlans()');
  assert.ok(STATS.reads > r1, '書いた後は読み直す');
  // 版の印が消えても（控えが追い出されても）、古い結果は返さない
  env.run(`CacheService.getScriptCache().remove('APP_DATA_GEN')`);
  const r2 = STATS.reads;
  env.call('apiListPlans()');
  assert.ok(STATS.reads > r2, '印が無ければ読み直す');
}

// ==== 2b. 公開し直した後（アプリの版が変わった）は、データ本体が同じでも前の版の控えを使わない ====
{
  /** 同じデータ本体・同じ控え（CacheService）・同じプロパティのまま、コードだけを差し替えた環境（公開し直しを真似る） */
  const redeploy = (version) => {
    const orig = sources['Config.js'];
    if (version) sources['Config.js'] = orig.replace(/const APP_VERSION = '[^']*';/, `const APP_VERSION = '${version}';`);
    try {
      const next = makeEnv();
      Object.assign(next.props, env.props); Object.assign(next.cache, env.cache);
      Object.assign(next.sheetsById, env.sheetsById); Object.assign(next.files, env.files);
      next.as(OWNER);
      return next;
    } finally { sources['Config.js'] = orig; }
  };
  const ver = env.run('APP_VERSION');
  env.call('apiPortfolio()');
  env.call('apiHome()');
  const same = redeploy('');
  assert.equal(same.run('APP_VERSION'), ver);
  same.call('apiPortfolio()');   // 権限の表は、同じ版なら控えから
  let r0 = STATS.reads;
  same.call('apiPortfolio()');
  same.call('apiHome()');
  assert.equal(STATS.reads - r0, 0, '同じ版なら、別の実行でも控えから返す');
  const next = redeploy(ver + '-next');
  assert.equal(next.run('APP_VERSION'), ver + '-next');
  r0 = STATS.reads;
  next.call('apiPortfolio()');
  assert.ok(STATS.reads > r0, '版が変われば、データ本体が同じでも読み直す（前の版の結果を返さない）');
  r0 = STATS.reads;
  next.call('apiHome()');
  assert.ok(STATS.reads > r0, 'ホームも読み直す');
  r0 = STATS.reads;
  next.call('apiPortfolio()');
  next.call('apiHome()');
  assert.equal(STATS.reads - r0, 0, '新しい版で作った控えは使う');
}

// ==== 3. 短い保存は、トリガーを待たずに頼んだ通信の中で動かす（最近かかった時間から見て収まるとき） ====
{
  const v1 = env.call('apiPlanView(__in)', { __in: { planId } });
  const first = env.runJob('PLAN.EDIT', { planId, action: 'SETUP.PEOPLE', args: { peopleCsv: '鷹野, 佐藤' }, inputHash: v1.inputHash });
  assert.equal(first.status, 'DONE', first.error);
  const v2 = env.call('apiPlanView(__in)', { __in: { planId } });
  assert.notEqual(v2.inputHash, v1.inputHash, '保存の後は画面の中身も新しい（控えを使わない）');
  const started = env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.EDIT', payload: { planId, action: 'SETUP.PEOPLE', args: { peopleCsv: '鷹野' }, inputHash: v2.inputHash } } });
  assert.deepEqual([started.status, started.direct], ['DONE', true], '2 回目からはその場で動く');
  assert.equal(env.triggers.filter((t) => t.handler === 'triggerRunJob').length, 0, '使わなかったトリガーは消す');
  const st = env.call('apiJobStatus(__in)', { __in: { jobId: started.jobId } });
  assert.equal(st.status, 'DONE');
  assert.equal(env.table('PLANS')[0].people_csv, '鷹野');
  // 時間がかかる処理（予測の実行など）は、これまでどおりトリガーで動かす
  const run = env.call('apiStartJob(__in)', { __in: { kind: 'SYSTEM.RECOVER', payload: {} } });
  assert.equal(run.status, 'QUEUED');
  env.fireTriggers('triggerRunJob');
  assert.equal(env.state.lockHeld, false);
}

// ==== 暫定実績（2026-10-06）: 締まった月（境目より前）だけ。行の無い締まった月は 0 円。途中の月・年度の外の月は数えない ====
{
  const env = makeEnv();
  const cmp = { '2026/04': { actual: 120, p50: 100, out: 1 }, '2026/05': { actual: 80, p50: 90, out: 0 }, '2026/07': { actual: 5, p50: 100, out: 1 }, '2027/04': { actual: 999, p50: 1, out: 0 } };
  const r = J(env.run(`appPlanYtd_('2026', ${JSON.stringify(cmp)}, '2026/07')`));
  assert.deepEqual([r.actualYtd, r.actualMonths, r.forecastYtd, r.rangeOut, r.rangeN, r.actual], [200, 3, null, 1, 2, { '2026/04': 120, '2026/05': 80 }], JSON.stringify(r));
  const r2 = J(env.run(`appPlanYtd_('2026', ${JSON.stringify(cmp)}, '2026/06')`));
  assert.deepEqual([r2.actualYtd, r2.actualMonths, r2.forecastYtd], [200, 2, 190], '予測のある締まった月だけなら予実の差を出す');
  const r3 = J(env.run(`appPlanYtd_('2026', ${JSON.stringify(cmp)}, '')`));
  assert.deepEqual([r3.actualYtd, r3.actualMonths, r3.forecastYtd], [null, 0, null], '境目が分からなければ締まった月は数えない');
  // 売上 0 の月（検証の表の実績が空で、予測はある）: 0 円として数え、予実の差も消さない
  const zero = { '2026/04': { actual: 100, p50: 100, out: 0 }, '2026/05': { actual: null, p50: 100, out: null }, '2026/06': { actual: 100, p50: 100, out: 0 } };
  const r4 = J(env.run(`appPlanYtd_('2026', ${JSON.stringify(zero)}, '2026/07')`));
  assert.deepEqual([r4.actualYtd, r4.actualMonths, r4.forecastYtd, r4.rangeOut, r4.rangeN, r4.actual], [200, 3, 300, 0, 2, { '2026/04': 100, '2026/05': 0, '2026/06': 100 }], JSON.stringify(r4));
}

// ==== 年度を選ぶ（今の年度の前後 2 年。2026-10-13 村井さん）: 選んだ年度の中身・計画の無い年度・選べない年度 ====
{
  const E = setUpEnv();
  const t = Number(String(E.run('appFy_(new Date())')));
  const h0 = E.call('apiHome()');
  assert.deepEqual(J(h0.fyOptions), [t - 2, t - 1, t, t + 1, t + 2].map(String), '選べる年度は前後 2 年の 5 つ');
  assert.equal(h0.thisFy, String(t));
  const past = E.call('apiHome(__in)', { __in: { fy: String(t - 2) } });
  assert.equal(past.fy, String(t - 2), '選んだ年度で返す');
  const odd = E.call('apiHome(__in)', { __in: { fy: String(t + 9) } });
  assert.equal(odd.fy, h0.fy, '選べない年度は既定の年度');
  // 画面: 題の横のプルダウン（説明のカーソルなし）・計画の無い過去の年度はよみが「ありません」と言う（「まだ」と言わない）・リンクのボタンを出さない
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [] }, setUp: true, allowed: true }));
  const calls = [];
  const el = () => ({ innerHTML: '', textContent: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
  const runner = { withSuccessHandler() { return runner; }, withFailureHandler() { return runner; }, apiHome(a) { calls.push(a); } };
  const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy(runner, { get: (o, k) => (k in o ? o[k] : () => {}) }) } } });
  vm.runInContext(js, ui);
  ui.__h = JSON.parse(JSON.stringify(past));
  const html = vm.runInContext(`B.home = __h; S.view = 'home'; viewHome()`, ui);
  assert.match(html, new RegExp('<h1>ホーム</h1><select class="inp sm hm-fysel" id="hm_fy" data-near="1" aria-label="見る年度"'), '題のすぐ横に年度のプルダウン');
  assert.equal((html.match(/<option /g) || []).length, 5);
  assert.doesNotMatch(html.slice(0, html.indexOf('</select>')), /data-tip/, '年度に説明のカーソルを付けない');
  assert.match(html, new RegExp('FY' + (t - 2) + ' の計画はありません。'), '過去の年度で計画が無ければ、よみがそう言う');
  assert.doesNotMatch(html, /<button/, 'ホームのよみの話・カードにリンクのボタンを出さない');
  vm.runInContext(`homeSetFy('${t + 1}')`, ui);
  assert.equal(JSON.stringify(calls[calls.length - 1]), JSON.stringify({ fy: String(t + 1) }), '選ぶと、その年度で読み直す');
  assert.equal(vm.runInContext('B.home', ui), null, '読み直す間は前の年度の中身を出さない');
}

console.log('app-home: all tests passed');
