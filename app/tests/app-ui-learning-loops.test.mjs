#!/usr/bin/env node
/**
 * app-ui-learning-loops.test.mjs — 学びの画面の作り直し（2026-10-13 村井さん「学びもタブ切り替えにしない」「対象のフィールド幅広すぎる」
 * 「人間に対しての FB … シングルループと分けた方がいい場合には、それぞれのセクションを設けて管理すること」）。
 *   1. 1 カラム: タブは無い。開いたら両方を読む。区切りは「前提と情報の見直し」（ダブルループ・人に返す学び）→「補正と重みの調整」（シングルループ・AI が直す学び）。
 *      読み込み中はその場所によみの「観測中…」。カードの置き場所
 *   2. 次の予測で見直すこと（lrReviewItems）: 数字ごとの問いかけの決まり（出す・出さないの境目）と、気になる順。次の一歩を 1 つ添える
 *   3. 名前の見せ方: 人や話題の名前は、サーバーが人ごとに渡した行（見せてよい計画の分）の説明だけ。種類ごとのまとめでは名前を出さない
 *   4. 表の列は格子（1 マス 160px・2 マス 332px）。残りは最後の空の列。判断の履歴の「対象」は 2 マスで折り返す
 *   5. サーバー: 人の学びの missesWithNotes・AI の学びの unsourced（いちばん新しい AI 調査の出典の無い出来事の数。読むだけ）
 * モックの上の確かめで、本物の Apps Script・ブラウザの上では動かしていない。
 *
 *   node app/tests/app-ui-learning-loops.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setUpEnv, uiHtml, OWNER } from './gas-mock.mjs';

const env = setUpEnv();

function loadUi() {
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: (t, k) => "<i data-pose=\\"" + String(k) + "\\"></i>" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
  const calls = [];
  const runner = {};
  const proxy = new Proxy(runner, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => proxy : (...a) => { calls.push(String(k)); }) });
  const ui = vm.createContext({ document: { getElementById: () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} }), querySelector: () => null, addEventListener() {} },
    setTimeout: () => 0, clearTimeout() {}, confirm: () => false, window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 }, google: { script: { run: proxy } } });
  vm.runInContext(js, ui);
  ui.__calls = calls;
  return ui;
}
const ui = loadUi();
const run = (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };
const keys = (p, a) => run('lrReviewItems(__p, __a).map(function(x){ return x.key; }).join()', { __p: p, __a: a || null });
const item = (p, a, k) => run('lrReviewItems(__p, __a).filter(function(x){ return x.key === __k; })[0]', { __p: p, __a: a || null, __k: k });

// ==== 1. 1 カラム・2 つの区切り・読み込み ====
{
  run('S.lr.people = null; S.lr.ai = null; S.ld = {}; S.view = "learning"');
  ui.__calls.length = 0;
  run('lrEnter()');
  assert.deepEqual([...ui.__calls].sort(), ['apiAiLearning', 'apiPeopleLearning'], '開いたら両方を読む（タブを待たない）');
  const wait = run('viewLearning()');
  assert.doesNotMatch(wait, /role="tablist"|lrTab\(/, 'タブは無い');
  assert.equal(typeof run('typeof lrTab'), 'string');
  assert.equal(run('typeof lrTab'), 'undefined', 'タブの切り替えの関数は無い');
  // 2026-10-16: 学びは人が持ち帰ることだけ。区切りは無く、読み込み中は観測中が 1 つ
  assert.match(wait, /^<h1>学び<\/h1>/);
  assert.doesNotMatch(wait, /id="lr-human"|id="lr-tune"/);
  assert.equal((wait.match(/data-pose="observe"/g) || []).length, 1);

  // 人の学びだけ届いた: 人の区切りは中身、AI の区切りは観測中。見直すことのカードは、AI の分をよみの観測中で待つ
  const people = { detail: 'full', summary: { months: 4, misses: 4, withNotes: 0, missesWithNotes: 0, scoredMonths: 10 }, noPreMonth: 0,
    lessons: [], openActions: [], repeats: [], decisions: [], uplift: [], scoreboard: [],
    causes: [{ direction: 'over', range: false, actionLabel: '前提を更新', n: 4 }] };
  run('S.lr.people = __p; S.ld.lrAi = { loading: true, start: 1 }', { __p: people });
  const half = run('viewLearning()');
  // 2026-10-16: 「次の予測で見直すこと」の文の並びを、4 枚のタイルの「持ち帰ること」に（村井さん「文字で殴らず図で」）
  assert.match(half, /<h2>持ち帰ること/);
  assert.ok(half.indexOf('持ち帰ること') > 0 && half.indexOf('外れの向きと対応') < 0, '持ち帰ることが先頭。外れの向きは分析へ');
  assert.deepEqual([...half.matchAll(/<span class="lr-tile-t">([^<]*)/g)].map((m) => m[1]), ['足りない考え方', '顧客に聞くこと', '予算の考え方', '業界の動向'], '4 枚のタイル');
  assert.match(half, /<span class="lr-tile-t">業界の動向<\/span><span class="chip st off">判断前<\/span>/, 'AI の学びを読み込んでいる間、業界の動向は判断前');

  // 両方届いた: カードの置き場所（人に返す学び → AI が直す学び）
  const ai = { detail: 'full', curves: [], shrinkage: { plans: [] }, timeline: [{ ym: '2026/04', n: 1, mape: 0.1, rolling3: 0.1, coverage: 1, coverageN: 1 }], calibration: [],
    pending: [{ planId: 'P1', clientName: '甲製薬', fy: '2026', reviewId: 'R1', at: '2026-10-03', quarter: 'FY2026-Q2', proposals: [{ proposalId: 'x', target: 'ai_weight_override', current: 0.5, proposed: 0.6 }] }],
    health: [], persistence: { rho: 0.4, ci80: [0.25, 0.55], pairs: 20, plans: 3, sticky: true }, unsourced: { events: 8, unsourced: 4, makers: ['甲製薬'] } };
  run('S.lr.ai = __a; S.ld.lrAi = { at: 1, ms: 1 }', { __a: ai });
  const page = run('viewLearning()');
  assert.doesNotMatch(page, /undefined|NaN|lr-qwait/);
  const at = (s) => page.indexOf(s);
  assert.ok(at('持ち帰ること') < at('承認待ちの見直し案'), '持ち帰ること → 承認待ち');
  assert.ok(at('外れの向きと対応') < 0 && at('外れ幅と幅の当たり') < 0 && at('id="lr-tune"') < 0, '仕組みの統計は学びに出さない');
  const mech = run('anMechanics()');
  assert.match(mech, /外れの向きと対応/);
  assert.match(mech, /外れ幅と幅の当たり/);
  // ホームの学びの進みは、同じ読み込みを使う（形を変えていない）
  assert.equal(run('LR_KEY.ai'), 'lrAi');
}

// ==== 2. 次の予測で見直すこと: 数字ごとの決まり ====
{
  const sb = (type, n, hit, expected, ci80, key) => ({ type, label: type, n, hit, expected, base: expected / n, ci80, postMean: hit / n, key });
  // src: 種類ごとに足して、当たりが基準より 0.5 以上・回数の 5% 以上少ない（6 回以上）
  assert.equal(keys({ scoreboard: [sb('opinion', 10, 4, 6, [0.25, 0.55])] }), 'src-opinion');
  assert.equal(keys({ scoreboard: [sb('opinion', 5, 1, 3, [0.1, 0.5])] }), '', '回数 5 では言わない');
  assert.equal(keys({ scoreboard: [sb('opinion', 40, 23, 24, [0.45, 0.65])] }), '', '差が回数の 5% より小さければ言わない');
  assert.equal(keys({ scoreboard: [sb('opinion', 10, 7, 6, [0.5, 0.85])] }), '', '基準より当たっていれば言わない');
  const soft = item({ scoreboard: [sb('opinion', 10, 4, 6, [0.25, 0.65])] }, null, 'src-opinion');
  assert.equal(soft.say, '「見解」の当たりが、いつも同じ向きと言った場合を下回りがちです。', '80% の幅が基準をまたげば断定しない');
  assert.equal(soft.act, '次は根拠（数字・出来事・出典）を添え、確かめてから入れましょう。');
  assert.match(soft.tip, /見解: 当たり 4 \/ 10 回・いつも同じ向きなら 6 回\nまだ回数が少なく/);
  const hard = item({ scoreboard: [sb('factor_product', 20, 6, 12, [0.2, 0.45])] }, null, 'src-factor_product');
  assert.equal(hard.say, '「製品の入力」の当たりが、いつも同じ向きと言った場合を下回っています。', '80% の幅の上の端も基準より下なら言い切る');
  const aiSrc = item({ scoreboard: [sb('ai_topic', 12, 3, 7, [0.15, 0.5])] }, null, 'src-ai_topic');
  assert.match(aiSrc.act, /AI の見立てをそのまま使わず、社内の情報で確かめて/, 'AI の情報源は社内の情報で確かめる');
  // dir・range
  const c = (direction, n, range) => ({ direction, n, range: !!range, actionLabel: '前提を更新' });
  assert.equal(keys({ causes: [c('over', 7), c('under', 3)] }), 'dir');
  assert.equal(keys({ causes: [c('over', 6), c('under', 4)] }), '', '6 割では言わない');
  assert.equal(keys({ causes: [c('over', 2)] }), '', '2 件では言わない');
  assert.match(item({ causes: [c('under', 4, true)] }, null, 'dir').act, /上げる材料/);
  assert.equal(item({ causes: [c('over', 4)] }, null, 'dir').say, '大きく外れた月の多く（4 / 4 件）は強気の外れ（予測が高すぎた）です。');
  assert.equal(keys({ causes: [c('over', 2, true), c('under', 2, true), c('under', 1)] }), 'range', '向きが分かれても、幅の外が半分以上なら幅の前提');
  // bias（AI の学びの全体に寄せた偏り）
  const sh = (xs) => ({ shrinkage: { plans: xs.map((v, i) => ({ planId: 'P' + i, clientName: 'M' + i, fy: '2026', shrunk: v })) } });
  assert.equal(keys({}, sh([0.12, 0.08, 0.2, -0.01])), 'bias');
  assert.match(item({}, sh([0.12, 0.08, 0.2, -0.01]), 'bias').say, /^4 メーカーのうち 3 メーカーで、予測がいつも高め（強気）に外れています。$/);
  assert.equal(keys({}, sh([0.12, -0.08, 0.2, -0.1])), '', '向きが分かれていれば言わない');
  assert.equal(keys({}, sh([0.12])), '', '1 メーカーでは言わない');
  // pre（月が始まる前の予測が無い月）
  assert.equal(keys({ noPreMonth: 3, summary: { scoredMonths: 10 } }), 'pre');
  assert.equal(keys({ noPreMonth: 1, summary: { scoredMonths: 2 } }), '', '1 か月では言わない');
  assert.equal(keys({ noPreMonth: 2, summary: { scoredMonths: 20 } }), '', '比べた月に比べて少なければ言わない');
  // notes（人の振り返りが無い外れ月）
  assert.equal(keys({ summary: { misses: 6, missesWithNotes: 2 } }), 'notes');
  assert.equal(keys({ summary: { misses: 6, missesWithNotes: 4 } }), '', '書いてある月が多ければ言わない');
  assert.equal(keys({ summary: { misses: 3 }, lessons: [{ miss: true, human: true }, { miss: true }, { miss: true }] }), '', 'missesWithNotes の無いサーバーでは振り返りから数える（2 件では言わない）');
  // cite・stick・rep
  assert.equal(keys({}, { unsourced: { events: 8, unsourced: 3, makers: ['甲'] } }), 'cite');
  assert.equal(keys({}, { unsourced: { events: 8, unsourced: 2, makers: ['甲'] } }), '', '3 割より少なければ言わない');
  assert.equal(keys({}, { unsourced: { events: 3, unsourced: 3, makers: [] } }), '', '出来事が 3 件では言わない');
  assert.equal(keys({}, { persistence: { rho: 0.4, ci80: [0.25, 0.55], pairs: 20, plans: 3, sticky: true } }), 'stick');
  assert.equal(keys({}, { persistence: { rho: 0.1, ci80: [-0.1, 0.3], pairs: 20, plans: 3, sticky: false } }), '');
  assert.equal(keys({ repeats: [{ clientName: '甲', month: '05', fys: ['2025', '2026'], n: 2 }] }), 'rep');
  // 気になる順・どれも次の一歩は 1 つ（。で終わる 1 文）
  const all = run('lrReviewItems(__p, __a)', { __p: { scoreboard: [sb('opinion', 20, 6, 12, [0.2, 0.45])], causes: [c('over', 4)], noPreMonth: 3, summary: { scoredMonths: 10, misses: 4, missesWithNotes: 0 },
    repeats: [{ clientName: '甲', month: '05', fys: ['2025', '2026'] }] }, __a: Object.assign(sh([0.1, 0.2]), { unsourced: { events: 4, unsourced: 4, makers: [] }, persistence: { rho: 0.5, ci80: [0.3, 0.6], pairs: 9, plans: 2, sticky: true } }) });
  assert.deepEqual(Array.from(all, (x) => x.key), ['src-opinion', 'dir', 'bias', 'notes', 'cite', 'stick', 'pre', 'rep']);
  for (const x of all) assert.match(x.act, /^[^。]+。$/, '次の一歩は 1 つ: ' + x.act);
  // カード: 5 件まで（ほかは「ほか n 件」）・件数・文にカーソルで数字
  const card = run('S.lr.more = {}; lrReviewCard(__p, __a)', { __p: { scoreboard: [sb('opinion', 20, 6, 12, [0.2, 0.45])], causes: [c('over', 4)], noPreMonth: 3, summary: { scoredMonths: 10, misses: 4, missesWithNotes: 0 },
    repeats: [{ clientName: '甲', month: '05', fys: ['2025', '2026'] }] }, __a: Object.assign(sh([0.1, 0.2]), { unsourced: { events: 4, unsourced: 4, makers: [] }, persistence: { rho: 0.5, ci80: [0.3, 0.6], pairs: 9, plans: 2, sticky: true } }) });
  assert.equal((card.match(/<li class="lr-q">/g) || []).length, 5);
  assert.match(card, />ほか 3 件<\/button>/);
  assert.doesNotMatch(card, /<span class="meta">\d+ 件<\/span>/, '件数の注記は出さない（2026-10-13）');
  assert.match(card, /<span class="lr-qsay" tabindex="0" data-tip="見解: 当たり 6 \/ 20 回/);
  assert.match(run('".lr-q [data-tip]" && TIP_FOCUS'), /\.lr-q \[data-tip\]/, 'キーボードでも説明が出る');
  // 何も無ければ短い一文。比べた月も無ければカードを出さない
  assert.match(run('lrReviewCard(__p, null)', { __p: { summary: { scoredMonths: 5, misses: 0 } } }), /今のところ、前提の見直しを促す偏りは見つかっていません。/);
  run('S.ld.lrAi = { at: 1, ms: 1 }');
  assert.equal(run('lrReviewCard(__p, null)', { __p: { summary: {} } }), '');
}

// ==== 3. 名前の見せ方 ====
{
  // 予算策定担当以上（人ごとの行。key あり）: 説明にだけ人の名前。文の本体は種類だけ
  const full = item({ scoreboard: [{ type: 'opinion', label: '見解', key: '担当A', n: 10, hit: 3, expected: 6, base: 0.6, ci80: [0.15, 0.5] }] }, null, 'src-opinion');
  assert.doesNotMatch(full.say + full.act, /担当A/);
  assert.match(full.tip, /担当A　3 \/ 10 回（基準なら 6 回）/);
  // 閲覧の人（種類ごとのまとめ。key なし）: 人の名前は出さない
  const sum = item({ scoreboard: [{ type: 'opinion', label: '見解', sources: 2, n: 10, hit: 3, expected: 6, base: 0.6, ci80: [0.15, 0.5] }] }, null, 'src-opinion');
  assert.doesNotMatch(sum.tip, /担当/);
}

// ==== 4. 表の列は格子 ====
{
  const t = run('lrTable([["A", "", LR_C1], ["B", "lr-wr", LR_C2, "", 96]], [["1", "2"]])');
  assert.match(t, /<colgroup><col style="--w:160px;"><col class="lr-wr" style="--w:332px;--wm:96px;"><col class="lr-fill"><\/colgroup>/, 'PC は 1 マス・2 マス、残りは空の列');
  assert.match(t, /<th class="lr-fill" aria-hidden="true"><\/th><\/tr>/);
  assert.match(t, /<td class="lr-wr">2<\/td><td class="lr-fill" aria-hidden="true"><\/td><\/tr>/, '空の列は「-」にしない');
  const ds = [{ planId: 'P1', clientName: '甲製薬', fy: '2026', reviewId: 'R', proposalId: 'x', at: '2026-10-03', target: 'reliability:opinion:担当A', current: 1, proposed: 0.9, status: '', decidedBy: '鷹野' },
    { planId: 'P1', clientName: '甲製薬', fy: '2026', reviewId: 'R', proposalId: 'y', at: '2026-10-03', target: 'bias_correction_factor', current: 0.97, proposed: 0.92, status: '' }];
  run('S.lr.ai = { pending: [] }; S.lr.more = {}');
  const dec = run('lrDecisionCard(__d, true)', { __d: { detail: 'full', decisions: ds } });
  const cols = [...dec.match(/<colgroup>([\s\S]*?)<\/colgroup>/)[1].matchAll(/<col([^>]*)>/g)].map((m) => m[1]);
  assert.deepEqual(cols.map((c) => (/--w:(\d+)px/.exec(c) || [])[1] || (/lr-fill/.test(c) ? 'fill' : 'none')), ['240', '332', '160', '160', 'fill'], 'メーカー（名前が 1 行に入る 240）・対象（2 マス）・案・判断。幅の無い列は無い');
  assert.match(dec, /<th class="lr-wr lr-kw lr-hm">対象<\/th>/, '対象は折り返す');
  assert.match(dec, /<span class="lr-sub meta">FY2026・2026\/10\/03<\/span>/, '年度と作った日はメーカーの下');
  assert.match(dec, /<span class="lr-sub meta">鷹野<\/span>/, '判断した人は判断の札の下');
  assert.equal((dec.match(/<span class="lr-sub meta">鷹野<\/span>/g) || []).length, 1, '判断した人がいない行には出さない');
  assert.match(dec, /3\.0%\u00a0下げ → 8\.0%\u00a0下げ/, '値の途中では折り返さない（→ の後だけ）');
  // 学びのほかの表も、幅の無い列（中身より広がる列）を作らない
  const html = run('S.cv = { lrCause: "table", lrScore: "table", lrCurve: "table", lrShrink: "table", lrTime: "table", lrCal: "table" }; viewLearning()');
  for (const g of html.match(/<colgroup>[\s\S]*?<\/colgroup>/g) || []) {
    const cs = [...g.matchAll(/<col(\s[^>]*)?>/g)].map((m) => m[1]);
    assert.ok(cs.every((x) => /--w:(160|332)px/.test(x) || /lr-fill/.test(x)), '列は 160px か 332px: ' + g);
  }
}

// ==== 5. サーバー（読むだけ） ====
{
  // いちばん新しい調査の日の出来事だけ数える。比べの行・古い日の行は数えない
  const HEAD = env.run('APP_INSIGHT_UNSOURCED_HEAD');
  const r = (date, rowType, ev) => ({ as_of_date: date, row_type: rowType, evidence: ev });
  const plans = [{ planId: 'A', clientName: '甲製薬', fy: '2026' }, { planId: 'B', clientName: '乙製薬', fy: '2026' }, { planId: 'C', clientName: '丙製薬', fy: '2026' }];
  const rows = {
    A: [r('2026-08-01', 'event', HEAD + '、予測には効かせていません。'), r('2026-10-07', 'event', HEAD + '、予測には効かせていません。 需要'), r('2026-10-07', 'event', '需要が伸びている'),
      r('2026-10-07', 'benchmark', HEAD + '、予測には効かせていません。')],
    B: [r('2026-10-01', 'event', '競合が発売'), r('2026-10-01', 'event', '卸の在庫')],
    C: [] };
  const u = env.call('appInsightUnsourced_(__pl, function(){ return __rows; })', { __pl: plans, __rows: rows });
  assert.deepEqual(u, { events: 4, unsourced: 1, makers: ['甲製薬'] });
  // 日時の値（Date）でも、いちばん新しい日で数える
  const d = env.call('appInsightUnsourced_(__pl, function(){ return { A: [{ as_of_date: new Date(2026, 6, 1), row_type: "event", evidence: __h }, { as_of_date: new Date(2026, 9, 7), row_type: "event", evidence: "あり" }] }; })', { __pl: plans, __h: HEAD });
  assert.deepEqual(d, { events: 1, unsourced: 0, makers: [] });
  // 表が読めなくても止めない
  assert.deepEqual(env.call('appInsightUnsourced_(__pl, function(){ throw new Error("x"); })', { __pl: plans }), { events: 0, unsourced: 0, makers: [] });
  // 本物の応答: AI の学びに unsourced・人の学びの summary に missesWithNotes
  const ai = env.call('apiAiLearning()');
  assert.deepEqual(Object.keys(ai.unsourced).sort(), ['events', 'makers', 'unsourced']);
  const pl = env.call('apiPeopleLearning()');
  assert.ok('missesWithNotes' in pl.summary);
}

console.log('app-ui-learning-loops: all tests passed');
