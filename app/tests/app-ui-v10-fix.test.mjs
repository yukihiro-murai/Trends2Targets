#!/usr/bin/env node
/*
 * app-ui-v10-fix.test.mjs — 版 10（v0.30.0）の画面の点検の直し（UI.html の script を vm で読む）。
 *   1. 入力の表の幅: 自信の列は 96px・変わった跡の (i) は理由・補足・案件名のマスの中（列を足さない）・製品の列は 1 マス（160px）。
 *      1280px の画面（枠 922px）で、決まった列の合計 + 理由の見出しの幅が枠に入り、理由・補足の列に 128px 以上が残る。
 *      狭い PC の画面（1280px 未満）は理由・補足に 200px を残して横に送る（--inw）
 *   2. 変わった跡: 記録を始めたときの姿（BASELINE）には、した人を書かない（仕組みが書いた行）。ほかの跡は今までどおり
 *   3. 測る専用の計画: 予測と予算のタブに最終予算の数字・採用予測・上乗せ・最終予算の列と線を出さず、題は「月ごとの見通し」。
 *      分析の市場の「まだ調べていないメーカー」に入れない。測る専用の計画だけの年度のホームは「予算を立てる計画はまだありません（測る専用 N）」
 *   4. 小さな言葉と並び: 当たりの「ほか N 件」の説明（そのメーカーの予算策定担当以上・調査には本人の分を言わない）、物差しの表は 152・112 の格子、
 *      人ごとの当たりで同じ名前の行にはメーカーを添える、根拠の層の表の見出しは「前回から（月の合計）」
 * 名前と数字はテスト用の架空のもの。モックの上の確かめで、本物の Apps Script・ブラウザの上では動かしていない。
 *
 *   node app/tests/app-ui-v10-fix.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setUpEnv, uiHtml, OWNER } from './gas-mock.mjs';

function loadUi() {
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: (t, k) => "<i data-pose=\\"" + String(k) + "\\"></i>" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
  const ui = vm.createContext({ document: { getElementById: () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} }), querySelector: () => null, addEventListener() {} },
    setTimeout: () => 0, clearTimeout() {}, confirm: () => false, window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  return (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };
}
const run = loadUi();
const css = uiHtml.slice(uiHtml.indexOf('<style>'), uiHtml.indexOf('</style>'));
const visible = (html) => html.replace(/<[^>]*>/g, ' ');

// ==== 1. 入力の表の幅 ====
{
  const at = '2026-10-08T10:00:00+09:00';
  const base = (after) => ({ conf: '', n: 1, hist: [{ change: 'BASELINE', action: 'BASELINE', at, by: 'SYSTEM:V10_BACKFILL', after }] });
  const rowsOf = {
    product: [{ person: '鷹野', product: '製品A', ym: '2026-04', step: '+5%', reason: '理由あ' }, { person: '佐藤', product: '製品B', ym: '2026-05', step: '-5%', reason: '理由い' }],
    client: [{ person: '鷹野', ym: '2026-04', step: '+5%', reason: '全体の理由' }],
    opinions: [{ person: '鷹野', ym: '2026-04', step: '+5%', conf: 0.5, note: '補足あ' }],
    devspot: [{ person: '鷹野', ym: '2026-06', project: '案件あ', amount: 300000, conf: 0.5 }],
  };
  const log = { rows: { product: [Object.assign(base(rowsOf.product[0]), { conf: '高い' }), base(rowsOf.product[1])], client: [Object.assign(base(rowsOf.client[0]), { conf: 'ふつう' })],
    opinions: [base(rowsOf.opinions[0])], devspot: [base(rowsOf.devspot[0])] }, counts: {} };   // 自信が届いていれば、見る人にも自信の列が出る
  const view = (canPlan) => ({ plan: { planId: 'P1', clientName: 'テスト製薬', fy: 2026 }, inputHash: 'h', can: { plan: canPlan }, recent: [], actions: [],
    boot: { setup: { people: ['鷹野', '佐藤'] }, products: ['製品A', '製品B'], months: ['2026-04', '2026-05', '2026-06'], stepOptions: ['+5%', '-5%'], input: rowsOf }, inputLog: log });
  const draw = (v, kind) => run(`S.fc.planId = 'P1'; S.fc.view = __v; S.fc.draft = {}; S.fc.inputDirty = {}; S.fc.inputKind = '${kind}'; fcInputCard(__v, '${kind}')`, { __v: v });
  const CARD_1280 = 922;   // 1280px の画面の入力のカードの中の幅（点検の測り: 1280 − 左のメニュー 220 − 余白）
  const HIST_AT = { product: '理由', client: '理由', opinions: '補足', devspot: '案件名' };
  for (const canPlan of [true, false]) {
    for (const kind of ['product', 'client', 'opinions', 'devspot']) {
      const html = draw(view(canPlan), kind);
      const what = kind + (canPlan ? '（書く人）' : '（見る人）');
      const table = /<table class="tbl scroll fc-in[^"]*" style="--inw:(\d+)px"><colgroup>([\s\S]*?)<\/colgroup><thead><tr>([\s\S]*?)<\/tr><\/thead>/.exec(html);
      assert.ok(table, what + ': 入力の表');
      assert.doesNotMatch(html, /width:56px/, what + ': 跡の列を足さない');
      const cols = [...table[2].matchAll(/<col(?: style="width:(\d+)px")?>/g)].map((m) => (m[1] ? Number(m[1]) : 0));
      const ths = [...table[3].matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
      assert.equal(cols.length, ths.length, what + ': 列と見出しの数が同じ');
      if (kind === 'product' || kind === 'client') assert.equal(cols[ths.indexOf('自信')], 96, what + ': 自信の列は 96px');
      // 1280px: 決まった列の合計 + 幅の決まっていない列の見出し（14px の字 + 左右の余白 24px）が枠に入る
      const fixed = cols.reduce((n, w) => n + w, 0);
      const autoTh = ths.filter((t, i) => !cols[i]).reduce((n, t) => n + t.length * 14 + 24, 0);
      assert.ok(fixed + autoTh <= CARD_1280, what + ': 1280px で枠に入る（' + fixed + ' + ' + autoTh + '）');
      if (cols.includes(0)) assert.ok(CARD_1280 - fixed >= 128, what + ': 1280px で理由・補足の列に 128px 以上（欄は (i) を除いて 86px 以上）: ' + (CARD_1280 - fixed));
      if (kind === 'product') assert.equal(cols[ths.indexOf('製品')], 160, what + ': 製品の列は 1 マス');
      // 狭い PC の画面: 幅の決まっていない列（理由・補足）に 200px を残す。決まった列だけの表は、決まった列の合計
      const inw = Number(table[1]);
      assert.equal(inw, Math.max(canPlan ? 880 : 720, fixed + (cols.includes(0) ? 200 : 0)), what + ': --inw');
      // 跡の (i) は、理由・補足・案件名のマスの中（その列の見出しは変わらない）
      const col = ths.indexOf(HIST_AT[kind]);
      const cells = [...html.matchAll(/<tr>((?:<td[^>]*>[\s\S]*?<\/td>)+)<\/tr>/g)].map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>(?=<td|$)/g)].map((c) => c[1]));
      assert.ok(cells.length >= 1, what);
      cells.forEach((tds) => {
        assert.match(tds[col], /^<span class="incell">[\s\S]*<span class="tip" tabindex="0" role="img" aria-label="変わった跡/, what + ': (i) は ' + HIST_AT[kind] + ' のマスの中');
        tds.forEach((td, i) => { if (i !== col) assert.doesNotMatch(td, /変わった跡/, what + ': ほかのマスには出さない'); });
      });
      if (!canPlan) assert.match(html, /<span class="incell"><span class="ell">[^<]*<\/span><span class="tip"/, what + ': 見る人は文字（… で切る）と (i)');
    }
  }
  // 跡の無い行（足した行）は (i) と同じ幅の空きで、欄の幅をそろえる
  draw(view(true), 'devspot');
  run(`fcInputAdd('devspot')`);
  const added = run(`fcInputCard(S.fc.view, 'devspot')`);
  assert.match(added, /aria-label="案件名"><span class="tipsp"><\/span><\/span>/, '足した行は空き');
  // 跡がどの行にも無ければ、包みを付けない
  const noLog = Object.assign(view(true), { inputLog: null });
  assert.doesNotMatch(draw(noLog, 'product'), /incell|tipsp/);
  // CSS: 狭い PC の画面の最小の幅・マスの中の並び
  assert.ok(css.includes('@media (min-width:761px) and (max-width:1279px){.tbl.scroll.fc-in{width:max(100%,var(--inw,880px))}}'), '1280px 未満は --inw まで広げて横に送る');
  assert.ok(css.includes('.incell{display:flex;align-items:center;gap:var(--s1);min-width:0}'));
  assert.ok(css.includes('@media (min-width:761px){.incell > .inp.cell{min-width:0}}'), 'PC は欄を縮める（スマホは 1 マスの最小の幅のまま）');
  assert.ok(css.indexOf('.tbl.scroll.edit{width:max(100%,880px)}') < css.indexOf('.tbl.scroll.fc-in{width:max(100%,var(--inw'), '狭い PC の画面の決まりは、書く表の決まりの後ろ');
}

// ==== 2. 変わった跡: BASELINE には、した人を書かない ====
{
  const e = { n: 3, hist: [
    { change: 'CHANGE', action: 'INPUT.SAVE', at: '2026-10-09T09:00:00+09:00', by: 'planner@bigm2y.com', before: { step: '+5%' }, after: { step: '+8%' }, conf: '高い' },
    { change: 'BASELINE', action: 'BASELINE', at: '2026-10-08T10:00:00+09:00', by: 'member@bigm2y.com', after: { step: '+5%' }, conf: '' },
  ] };
  const t = run('fcInLogTip(__e)', { __e: e });
  const lines = t.split('\n');
  assert.equal(lines[0], '変わった跡');
  assert.match(lines[1], /^2026\/10\/09 09:00 変えた（入力の保存）・planner$/, 'ほかの跡は、した人を書く');
  assert.equal(lines[3], '2026/10/08 10:00 記録を始めたときの姿', '記録を始めたときの姿には、した人を書かない（たまたま最初に開いた人の名前を出さない）');
  assert.doesNotMatch(t, /member|SYSTEM/);
  assert.equal(lines[4], 'ほか 1 件');
  // 仕組みの印で書かれた BASELINE でも同じ
  assert.equal(run('fcInLogTip(__e)', { __e: { n: 1, hist: [{ change: 'BASELINE', action: 'BASELINE', at: '2026-10-08T10:00:00+09:00', by: 'SYSTEM:V10_BACKFILL', after: {} }] } }), '変わった跡\n2026/10/08 10:00 記録を始めたときの姿');
}

// ==== 3. 測る専用の計画 ====
const D = (y, m, d = 1) => new Date(y, m - 1, d);
function planBook(client, fy, adopted = 80) {
  const output = [['FY' + fy + ' 売上予測（' + client + '）']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 900, 1000, 1100]);
  output.push([], ['月', 'P10', 'P50', 'P90', '', '', '', '採用予測', '上乗せ']);
  for (let i = 0; i < 12; i++) output.push([D(fy, 4 + i, 1), 70, 80, 90, '', '', '', adopted, '']);
  return { CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '担当A']] }, OUTPUT: { values: output } };
}
const task = (env, t) => { env.props.OWNER_TASK = JSON.stringify(t); return env.call('apiOwnerTask()'); };
{
  const env = setUpEnv();
  const fy = env.run('appFy_(new Date())');
  const planA = env.seedPlan(env.makeBook('A', planBook('テスト製薬', fy, 80)));
  const planB = env.seedPlan(env.makeBook('B', planBook('テスト化学', fy, 80)));
  const planM = env.seedPlan(env.makeBook('M', planBook('テスト薬品', fy, 500)));
  task(env, { action: 'setPlanPurpose', planId: planM, purpose: 'MEASURE' });
  const fc = (id, table) => {
    const d = env.call('apiForecastLatest(__in)', { __in: { planId: id } });
    const v = env.call('apiPlanView(__in)', { __in: { planId: id } });
    v.boot.output.sections[0].monthly = Array.from({ length: 12 }, (_, i) => ({ row: 29 + i, month: fy + '/' + String(i + 1).padStart(2, '0'), p10: 70, p50: 80, p90: 90, adopted: 80, uplift: '', final: 80 }));
    run(`S.fc.plans = __l; S.fc.planId = __id; S.fc.view = __v; S.fc.data = __d; S.fc.budget = {}; S.fc.confirm = null; S.cv.fcMonthly = '${table ? 'table' : 'chart'}'`, { __l: env.call('apiListPlans()').plans, __id: id, __v: v, __d: d });
    return run('fcForecastTab(S.fc.data, S.fc.view)');
  };
  // 測る専用: 最終予算の数字・列・線を出さない。題は「月ごとの見通し」
  for (const table of [false, true]) {
    const m = fc(planM, table);
    assert.doesNotMatch(m, /undefined|NaN/);
    assert.doesNotMatch(m, /<div class="k">最終予算<\/div>/, '最終予算の数字を出さない');
    assert.equal((m.match(/<div class="kpi[ "]/g) || []).length, 3, '下振れ・中心・上振れの 3 つ（同じ 4 つの格子のまま）');
    assert.match(m, /<h2>月ごとの見通し<span class="tip"[^>]*data-tip="[^"]*測る専用の計画なので、予算は立てません。/, '題は「月ごとの見通し」');
    assert.doesNotMatch(m, /月ごとの見通しと予算|月ごとの見通しと最終予算/);
    assert.doesNotMatch(visible(m), /最終予算|採用予測|上乗せ/, '見える文字に予算の言葉を出さない（' + (table ? '表' : 'グラフ') + '）');
    assert.doesNotMatch(m, /fcBudget\(|fcSaveBudget\(\)/);
    assert.match(run('fcRunBtn()'), /fcForecastRun\(\)/, '予測を実行は出す（「予測と予算」の見出しの右。2026-10-13）');
    if (table) {
      assert.match(m, /<colgroup><col style="width:96px"><col><col><col><\/colgroup>/, '月と下振れ・中心・上振れの列だけ');
      assert.match(m, /<tr class="total"><td>年度合計<\/td><td class="num">[^<]*<\/td><td class="num">[^<]*<\/td><td class="num">[^<]*<\/td><\/tr>/);
    } else {
      assert.doesNotMatch(m, /data-tip="[^"]*最終予算[^"]*"/, 'グラフに最終予算の線を出さない');
      assert.match(m, /aria-label="月ごとの見通し"/);
    }
  }
  // 予算を立てる計画は今までどおり
  for (const table of [false, true]) {
    const a = fc(planA, table);
    assert.match(a, /<div class="k">最終予算<\/div>/);
    assert.match(a, /<h2>月ごとの見通しと予算<span class="tip"/);
    if (table) assert.match(a, />採用予測<\/th><th class="num"[^>]*>上乗せ<\/th><th class="num"[^>]*>最終予算<\/th>/);
    else assert.match(a, /aria-label="月ごとの見通しと最終予算"/);
  }
  // 予測がまだ無い測る専用の計画: 「予算の欄」と言わない
  run(`S.fc.planId = __id; S.fc.view = { plan: { planId: __id, measure: true }, can: { plan: true }, boot: { output: null }, actions: [] }`, { __id: planM });
  assert.match(run(`fcForecastTab({ latest: null, stored: null, runs: [] }, S.fc.view)`), /月ごとの見通しがここに出ます。/);

  // 分析 > 市場: 測る専用の計画は「まだ調べていないメーカー」に入れない
  const an = env.call('apiCrossMaker(__in)', { __in: {} });
  assert.ok(an.plans.some((p) => p.planId === planM && p.measure), '分析の計画に測る専用の印');
  an.plans.forEach((p) => { if (p.planId === planA) p.topics = [{ topic: 'market', rowType: 'event', direction: 'up', impact: 10, confidence: 0.6, score: 12, position: '', percentile: null, horizon: '3M', asOf: fy + '/09' }]; });
  const mk = run(`anMarket(__a)`, { __a: an });
  const none = /<p class="note anx" data-tip="まだ調べていないメーカー\n([^"]*)">まだ調べていないメーカー (\d+)<\/p>/.exec(mk);
  assert.ok(none, mk);
  assert.deepEqual([none[1].split('\n'), none[2]], [['テスト化学'], '1'], '測る専用の計画は入れない');
  // 測る専用の計画だけが調べていないときは、案内の行を出さない
  const onlyM = Object.assign({}, an, { plans: an.plans.filter((p) => p.planId !== planB) });
  assert.doesNotMatch(run(`anMarket(__a)`, { __a: onlyM }), /まだ調べていないメーカー/);
}
{
  // 測る専用の計画だけの年度: 「計画はまだありません」と言わない
  const env = setUpEnv();
  const fy = env.run('appFy_(new Date())');
  const planM = env.seedPlan(env.makeBook('M', planBook('テスト薬品', fy, 500)));
  task(env, { action: 'setPlanPurpose', planId: planM, purpose: 'MEASURE' });
  const home = env.call('apiHome()');
  run('B.home = __h; S.view = "home"', { __h: home });
  const says = JSON.parse(run('JSON.stringify(yomiSays(B.home))'));
  const say = says.filter((x) => /計画はまだありません/.test(x.text));
  assert.equal(say.length, 1, says.map((x) => x.text).join(' | '));
  assert.equal(say[0].text, 'FY' + home.fy + ' の予算を立てる計画はまだありません（測る専用 1）。');
  assert.ok(say[0].tip.startsWith('測る専用の計画です。'), '説明はカーソルで');
  assert.equal(say[0].act, null, 'よみの話にリンクのボタンは付けない（行き来は左のメニューから。2026-10-13）');
  const h = run('viewHome()');
  assert.doesNotMatch(h, /計画はまだありません。所有者が/);
  assert.match(h, /予算を立てる計画はまだありません（測る専用 1）/);
  // 計画の無い年度は今までどおり
  const empty = JSON.parse(run('JSON.stringify(yomiSays({ fy: "2099", plans: __p, approvals: [], mine: [], system: null }))', { __p: home.plans }));
  assert.deepEqual(empty.filter((x) => /計画はまだありません/.test(x.text)).map((x) => [x.text, x.tip, x.act]),
    [['FY2099 の計画はまだありません。所有者が計画を作ると、ここに見通しが出ます。', '', null]], 'ほかの年度の測る専用の計画は数えない');
}

// ==== 4. 小さな言葉と並び ====
{
  // 当たりの「ほか N 件」: そのメーカーの予算策定担当以上。調査の当たりには本人の分を言わない
  const tipOf = (html) => /<span class="chip" tabindex="0" data-tip="([^"]*)">ほか \d+ 件<\/span>/.exec(html)[1];
  const hits = run('lrHitCard(__h)', { __h: { people: [{ name: '鷹野', own: false, n: 2, hit: 1, rate: 0.5, makers: 1, quarters: [] }], hidden: 4, quarters: 2 } });
  assert.equal(tipOf(hits), 'ほかの人の当たり 4 件は、そのメーカーの予算策定担当以上の人に出します（本人の分は本人にも）');
  const research = run('lrResearchCard(__r)', { __r: { research: [{ planId: 'P1', clientName: 'テスト製薬', fy: '2026', date: '2026-06-10', n: 1, hit: 1, quarters: [] }], hidden: 2 } });
  assert.equal(tipOf(research), 'ほかの調査の当たり 2 件は、そのメーカーの予算策定担当以上の人に出します', '調査の行には人がいないので、本人の分を言わない');

  // 物差しの表: 152・112 の格子。95% の幅は値の下の行に（カーソルにも）
  const env = setUpEnv();
  const rows = [];
  for (let i = 0; i < 30; i++) { const p = 'P' + (i % 2), a = 1000 + i; rows.push({ plan_id: p, target_ym: 'M' + i, method: 'STAT_ONLY', p50: a * 1.02, p10: a * 0.9, p90: a * 1.1, actual: a, counted: true },
    { plan_id: p, target_ym: 'M' + i, method: 'LAST_YEAR', p50: a * 1.2, actual: a, counted: true }); }
  const bt = { fy: '2026', backtest: Object.assign({ fy: '2026', plans: 2 }, env.call('appBacktestSummary_(__r, __c)', { __r: rows, __c: { P0: 'C0', P1: 'C1' } })) };
  const card = run('anBacktestCard(__d)', { __d: bt });
  assert.match(card, /<table class="tbl anw anbt"><colgroup><col><col style="width:152px"><col style="width:152px"><col style="width:152px"><col style="width:112px"><col style="width:112px"><\/colgroup>/, '152・112 の格子（何か月先の列を足した。2026-10-13）');
  assert.match(card, /<td class="num" data-tip="外れ幅（\d+ 点。実績が 0 円以下の点は除く） \d+\.\d%\n95% の幅 \d+\.\d%〜\d+\.\d%">\d+\.\d% <span class="note">\d+\.\d%〜\d+\.\d%<\/span><\/td>/, '95% の幅は値の下とカーソルに');
  assert.ok(css.includes('.tbl.anbt td.num > .note{display:block}'), '幅は値の下の行（152px の列に入る）');
  assert.doesNotMatch(card, /width:208px/);

  // 人ごとの当たり: 同じ名前の行（別の人として数えた行）にはメーカーを添える。1 つだけの名前には添えない
  const q = (quarter, clientName, push, hit) => ({ quarter, clientName, fy: '2026', push, hit });
  const people = { people: [
    { name: '佐藤', own: false, n: 1, hit: 1, rate: 1, makers: 1, quarters: [q('FY2026-Q1', 'メーカーA', 0.05, 1)] },
    { name: '鷹野', own: false, n: 2, hit: 1, rate: 0.5, makers: 1, quarters: [q('FY2026-Q2', 'メーカーA', 0.05, 1), q('FY2026-Q1', 'メーカーA', -0.05, 0)] },
    { name: '鷹野', own: true, n: 2, hit: 2, rate: 1, makers: 2, quarters: [q('FY2026-Q2', 'メーカーB', 0.03, 1), q('FY2026-Q1', 'メーカーC', 0.03, 1)] },
  ], hidden: 0, quarters: 2 };
  const ph = run('lrHitCard(__h)', { __h: people });
  const names = [...ph.matchAll(/<td class="lr-wr lr-kw" data-tip="[^"]*">([\s\S]*?)<\/td>/g)].map((m) => m[1]);
  assert.deepEqual(names, ['佐藤', '鷹野 <span class="meta">メーカーA</span>', '鷹野 <span class="meta">メーカーB ほか 1</span> <span class="chip">自分</span>'], names.join(' | '));
  assert.doesNotMatch(ph, /undefined|NaN|null/);

  // 根拠の層の表: 見出しは「前回から（月の合計）」（上の一文の年度の中心の変化と食い違って見えないように）
  const lay = (o) => Object.assign({ final: 0, stat: 0, spot: 0, human: 0, ai: 0, calib: 0, other: 0, byType: {}, months: 12, closed: 6, method: 'RATIO' }, o);
  const t = run('fcLayerTable(__l)', { __l: { latest: lay({ final: 1300, stat: 1000, human: 300 }), prev: lay({ final: 1000, stat: 1000 }) } });
  assert.match(t, /<th class="num" data-tip="前回の予測からの変化（月の合計）">前回から（月の合計）<\/th>/);
  assert.match(t, /<colgroup><col><col style="width:160px"><\/colgroup>/, '数の列は 1 マス');
  assert.ok(css.includes('.tbl.fc-layers th.num{padding-left:var(--s1)}'), '見出しの左の余白を詰める');
  assert.ok('前回から（月の合計）'.length * 14 + 4 + 12 <= 160, '1 マス（160px）の列に、見出しが 1 行で入る（14px の字・左 4px・右 12px）');
}

console.log('app-ui-v10-fix: ok');
