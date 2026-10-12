#!/usr/bin/env node
/*
 * app-ui-texts.test.mjs — 2026-10-07 の所有者の決定（D1〜D8）の後の、画面の言葉（UI.html の script を vm で読む）。
 *   1. 補正を学び直す: 計画の自動の学びの旗が 0 なら、見直し案を作る（止めている操作）と同じ押せないボタンにし、理由をカーソルで出す。
 *      旗が 1 なら押せる。サーバーが止めた理由があれば、それを先に出す
 *   2. 振り返り: 見直し案を作る操作を止めている間は、案内・人の記入の説明で見直し案が出るとは言わず、更新の説明で止めている操作を言う
 *   3. 根拠の補正: 所有者が承認した値で書いたときは「補正を学び直す」で決まるとは言わない。自動の学びを止めていれば（所有者の書いた跡が無くても）、
 *      補正を学び直す・見直しを反映では変わらないと言う
 *   4. AI の効き: 0 は 0%、小さい値（0.0008）は 0.08%（整数の % で 0% にしない）
 *   5. 学び > 人の学び: 比べた月がまだ無いときは「外れた月はありません」と言わず、当たり具合を計算するよう案内する
 *   6. 分析の案内: 外れ幅・読みのクセは、各計画の「当たり具合を計算」で出ると言う
 *   7. 出した直後と同じ形（どの計画も今の版の検証の行が無く、外れ幅が無い）: ホーム・分析・学びを本物の中身で描き、undefined・NaN を出さない
 *   8. 人の学びのまとめ: 実績と比べた月（summary.scoredMonths）が無い / あるが振り返りの記録が無い / 外れなし / 外れあり。scoredMonths が無いサーバーでも描ける
 *   9. 動かせない人（閲覧・情報提供）には「計算されると出ます」。締め済みの年度の分析は「計算し直しません」
 *  10. 荒れの文は出ている印だけで作り、比べた月が無ければ出し方も言う（学びのまとめ・ホームの学びの進み）
 *  11. 根拠の補正: 出している予測の補正と今の補正が違えば、見える一文は出している予測のこと
 *  12. 振り返り: 人の記入・見直し案があって比べた月が無いときは、精度の天気の場所に 1 行
 *  13. 承認して反映: 自動の学びを止めている間は、判断を記録するだけで補正の値は変わらないと言う（ボタンは押せる）
 *  14. AI の効きの端の値・人の学びの「のべ」・分析の案内の空白・スマホの説明が欄の focusout で消えない
 *  15. 振り返り: 実績と比べた月（apiLearningView の scoredMonths）があるのに外れ幅の月が無い = どの月も売上が 0 円（動かし方は言わない）。
 *      scoredMonths が 0・無いサーバーでは今までどおり
 *  16. 当たり具合を計算した後・外れの原因を整理の前: 振り返りの人の記入の場所に 1 行、人の学びのまとめに残りの月の数（動かせない人には「整理されると」）
 *  17. 承認して反映（自動の学びを止めている間）: 説明の 1 行目は記録だけ、確かめる文は「判断を記録します（3〜6 分ほど）」の後に設定が変わらないこと
 *  18. 締め済みの年度: 分析・振り返りで「まだ」と言わない
 *  19. 所有者が設定した日は 2026/10/07 の形で「所有者が設定」
 *  20. 根拠の補正: 出している予測の補正と今の補正が違えば、月ごとの補正も出している予測が使った分を言う。今の補正が空なら補正なし
 *  21. AI の学び: 比べた月が無いときの荒れの文は、印の短い言い方と出し方だけ（荒れの説明はカーソル）
 *  22. 根拠の補正: 倍率が同じでも月ごとの補正が違えば違うとみなし、見える一文は出している予測のこと（カーソルで出している分 → 今の分）。
 *      月ごとに直しているのに「補正なし」とは言わない。0.0% の月は違いとみなさない。控えに月ごとの欄が無ければ月ごとの補正なし（旧来の計算と同じ）
 *  23. 人の学びのまとめ: 外れの原因を整理で出る月は summary.waitingMonths（締め済みの年度だけなら動かし方を言わない）。無いサーバーでは今までどおり
 *  24. 比べた月がどれも売上 0 円（plans[].scoredMonths・accuracy.scoredMonths）: ホームの外れ幅・精度の天気、分析の案内、AI の学びで
 *      「まだ」・動かし方の代わりに振り返りと同じ言い方。まだ比べていないメーカーがあれば、その出し方だけ添える
 *  25. ホームの着地の推定の 80% の幅: 下の端は 0 円で止める
 *  26. 学び > AI の学び「着地の幅の学び」: 今の値（承認した値・決まった値）と学んだ値（試し）を分けて出す。使っているかは値ごとに、
 *      設定に書いたか（tauSet・wSet）と見せる丸め（0.1%・0.01 倍）で決める。承認した日は値ごとにカーソルで。学んだ値が無くても今の値は出す
 *  27. 予測と予算: 見出しの説明は「年度合計（下振れ・中心・上振れ）」。年度の見込みの試しの説明は「この計画の年度合計」・幅は締まった月が無いときだけ・
 *      金額は円まで。届く見込みの説明は「着地の推定」と円までの金額。12 か月を数えた（reach.done・12 か月）ら届いたかどうかを言う（締め済みでも 12 か月に足りなければ見込み）
 *  28. 比べた月がどれも売上 0 円: 精度の天気の説明の 1 行目は「霧：外れ幅を % で出せる月がまだない」（ホーム・AI の学び）
 *  29. 根拠「前回の予測からの変化」: 理由は basis の changeCause から（日付は言わない）
 *  30. 空模様の理由「当たり具合の計算待ち」（skyReason eval_pending）と、その出し方（動かせる人・動かせない人）
 * モックの上の確かめで、本物の Apps Script・ブラウザの上では動かしていない。
 *
 *   node app/tests/app-ui-texts.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setUpEnv, uiHtml, OWNER } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const env = setUpEnv();
const PAUSED = env.run('APP_REVIEW_GENERATE_PAUSED');
const POLICY = env.run('APP_EVAL_POLICY_VERSION');

/**
 * 画面（UI.html の script）を vm で読み込む。よみの絵は、どの姿か分かる印にする。
 * listen: 渡すと document の addEventListener を種類ごとに控え、getElementById は同じ id に同じ要素を返す（説明の箱を確かめる）
 */
function loadUi(listen) {
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: (t, k) => "<i data-pose=\\"" + String(k) + "\\"></i>" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
  const els = {};
  const el = (id) => (listen ? (els[id] = els[id] || fakeEl()) : { innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
  const on = listen ? (type, fn) => { (listen[type] = listen[type] || []).push(fn); } : () => {};
  const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, addEventListener: on }, setTimeout: () => 0, clearTimeout() {}, confirm: () => false,
    window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  return ui;
}
/**
 * 要素の代わり（属性・クラス・親子だけ）。tag: 'span' など、cls: クラスの並び、attrs: 属性、kids: 子。
 * closest / querySelector は、この画面が使う形（[data-tip]・.act[data-tip]・button,a,select,input,textarea）だけ読む
 */
function fakeEl(tag = 'div', cls = [], attrs = {}, kids = []) {
  const on = new Set();
  const e = { tag, cls, attrs: Object.assign({}, attrs), kids, parent: null, disabled: !!attrs.disabled, textContent: '', style: {}, offsetWidth: 120, offsetHeight: 24,
    classList: { add: (c) => on.add(c), remove: (c) => on.delete(c), contains: (c) => on.has(c) },
    getAttribute: (k) => (k in e.attrs ? e.attrs[k] : null), setAttribute: (k, v) => { e.attrs[k] = String(v); }, removeAttribute: (k) => { delete e.attrs[k]; },
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 40, height: 20, bottom: 30 }),
    contains: (x) => { for (let n = x; n; n = n.parent) if (n === e) return true; return false; },
    matches: (sel) => sel.split(',').some((one) => { const m = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[\w-]+\])*)$/.exec(one.trim()); if (!m) return false;
      return (!m[1] || m[1] === e.tag) && (m[2].match(/[\w-]+/g) || []).every((c) => e.cls.includes(c)) && (m[3].match(/[\w-]+/g) || []).every((a) => a in e.attrs); }),
    closest: (sel) => { for (let n = e; n; n = n.parent) if (n.matches(sel)) return n; return null; },
    querySelector: (sel) => { for (const k of e.kids) { if (k.matches(sel)) return k; const x = k.querySelector(sel); if (x) return x; } return null; } };
  kids.forEach((k) => { k.parent = e; });
  return e;
}
const ui = loadUi();
const run = (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };
/** 役割を変えて描く（閲覧・情報提供だけの人など）。終わったら管理者に戻す */
const VIEWER_ROLES = [{ role: 'VIEWER', scopeType: 'ALL' }, { role: 'CONTRIBUTOR', scopeType: 'ALL' }];
const asRoles = (roles, fn) => { const keep = run('B.user.roles'); run('B.user.roles = __r', { __r: roles }); try { return fn(); } finally { run('B.user.roles = __r', { __r: keep }); } };
/** 計画の画面の中身（振り返り・根拠に使うところだけ）。paused: 見直し案を作るを止めているか。learning: 旧来の画面の学びの中身。can: 計画を動かせるか。frozen: 締め済みの年度 */
const planView = ({ paused = true, learning = { autoUpdate: true, biasFactor: 1, note: '' }, insights = [], proposals = [], can = true, frozen = false } = {}) => ({
  plan: { planId: 'P1', clientName: 'テスト製薬', fy: 2026, frozen }, inputHash: 'h', sourceReady: true, can: { plan: can, approve: can, admin: can }, recent: [],
  actions: ['IMPORT.ACTUALS', 'EVAL.REPORT', 'EVAL.INSIGHTS', 'LEARN.MONTHLY', 'REVIEW.GENERATE', 'REVIEW.APPLY']
    .map((a) => ({ action: a, kind: 'run', label: a, minRole: 'PLANNER', paused: a === 'REVIEW.GENERATE' && paused ? PAUSED : '' })),
  boot: { eval: { insights }, quarterly: { proposals }, learning }
});
/** 振り返りのタブ（当たり具合は読み終わった・月はまだ無い） */
const review = (v) => run(`S.fc.planId = 'P1'; S.fc.view = __v; S.fc.data = { plan: __v.plan, latest: null, runs: [], stored: null }; S.fc.learn = { planId: 'P1', accuracy: { months: [] } }; S.fc.ins = {};
  fcReviewTab(S.fc.data, S.fc.view)`, { __v: v });
const tipOf = (html, h2) => (new RegExp('<h2>' + h2 + '<span class="tip"[^>]*data-tip="([^"]*)"').exec(html) || [])[1];
const OWNER_NOTE = 'owner-approved 2026-10-07 09:30: 自動の学びを止める';

// ==== 1. 補正を学び直す: 旗が 0 なら押せないボタン（見直し案を作ると同じ形・同じ幅のボタン） ====
{
  const off = review(planView({ learning: { autoUpdate: false, biasFactor: 1, note: OWNER_NOTE } }));
  assert.doesNotMatch(off, /fcRun\('LEARN\.MONTHLY'\)/);
  assert.match(off, /<span class="act" data-tip="実績から補正を学び直す\n自動の学びを止めています（2026\/10\/07 所有者が設定）。今は動かしても補正は変わりません。"><button class="btn btn-ghost" disabled aria-disabled="true">補正を学び直す<\/button><\/span>/);
  assert.doesNotMatch(off, /所有者の決定）。今は動かしても/, '日付の後ろは「所有者が設定」（setCalibration が動いた日）');
  assert.match(off, /<span class="act" data-tip="AI の見直し案を作る\n[^"]*"><button class="btn btn-ghost" disabled aria-disabled="true">見直し案を作る<\/button><\/span>/, '見直し案を作ると同じ形');
  assert.match(off, /fcRun\('EVAL\.REPORT'\)/, 'ほかの実行は押せる');
  // 所有者が書いたのでなければ、日付と「所有者が設定」は言わない
  const off2 = review(planView({ learning: { autoUpdate: false, biasFactor: 1, note: 'auto-learned' } }));
  assert.match(off2, /data-tip="実績から補正を学び直す\n自動の学びを止めています。今は動かしても補正は変わりません。"><button class="btn btn-ghost" disabled/);
  // 旗が 1・学びの中身が無い（古い控え）なら、今までどおり押せる
  for (const learning of [{ autoUpdate: true, biasFactor: 0.9, note: OWNER_NOTE }, undefined]) {
    const on = review(planView({ learning }));
    assert.match(on, /<span class="act" data-tip="実績から補正を学び直す（次の予測に効く）\n実績から補正の係数を学び直します（次の予測に反映）。"><button class="btn btn-ghost" onclick="fcRun\('LEARN\.MONTHLY'\)">補正を学び直す<\/button>/);
  }
  // サーバーが止めた理由があれば、それを出す（旗より先）
  const v = planView({ learning: { autoUpdate: false, note: OWNER_NOTE } });
  v.actions.filter((a) => a.action === 'LEARN.MONTHLY')[0].paused = 'B-5 は止めています。';
  assert.equal(run(`S.fc.view = __v; fcPaused('LEARN.MONTHLY')`, { __v: v }), '補正を学び直す は止めています。', '中の番号はふつうの言葉に');
  // ほかの操作は旗では止めない
  assert.equal(run(`fcPaused('EVAL.REPORT') + fcPaused('REVIEW.APPLY')`), '');
}

// ==== 2. 振り返り: 見直し案を作るを止めている間の言葉 ====
{
  const insights = [{ row: 5, month: '2026/04', insight: '外れ', nextAction: '', hypothesis: '', actionType: 'update', reflection: '', owner: '', status: 'open' }];
  // 止めている（旗は 1）: 案内は見直し案が出るとは言わない・更新の説明で、止めているのは見直し案を作るだけと言う
  const p = review(planView());
  assert.match(p, /まだ振り返りの記録がありません。月の実績が締まったら、下の「振り返りの更新」を左から順に実行してください。当たり具合・外れの原因がここに出ます。/);
  assert.doesNotMatch(p, /AI の見直し案がここに出ます/);
  assert.equal(tipOf(p, '振り返りの更新'), '左から順に実行します。「見直し案を作る」は、今は止めています');
  // 旗も 0: 止めている 2 つを並べる
  assert.equal(tipOf(review(planView({ learning: { autoUpdate: false, note: OWNER_NOTE } })), '振り返りの更新'), '左から順に実行します。「補正を学び直す」と「見直し案を作る」は、今は止めています');
  // 止めていない: 今までどおり
  const u = review(planView({ paused: false }));
  assert.match(u, /当たり具合・外れの原因・AI の見直し案がここに出ます。/);
  assert.equal(tipOf(u, '振り返りの更新'), '左から順に実行します');
  // 人の記入の説明・保存の説明
  const n = review(planView({ insights }));
  assert.match(tipOf(n, '人の記入'), /^外れた月の原因の仮説・対応・担当を書きます。次の予測の材料になります。/);
  assert.match(n, /data-tip="原因の仮説・対応・担当・状態を保存します。次の予測の材料になります"/);
  assert.doesNotMatch(n, /見直し案の材料/);
  const n2 = review(planView({ paused: false, insights }));
  assert.match(tipOf(n2, '人の記入'), /次の予測と AI の見直し案の材料になります。/);
  assert.match(n2, /data-tip="原因の仮説・対応・担当・状態を保存します。次の予測と AI の見直し案の材料になります"/);
  // 承認待ちの見直し案は、止めている間も承認して反映できる（ボタンを消さない）
  const props = [{ row: 8, pid: 'P1', target: 'ai_weight_override', current: '0.0008', proposed: '0.0004', conf: '中', rationale: '', impact: '', decision: '', rollback: '' }];
  const a = review(planView({ proposals: props }));
  assert.match(a, /onclick="fcRvGo\(\)">承認して反映<\/button>/);
  // ホームの学びの進み: 承認待ちの見直し案は「四半期ごとに作る」とは言わない
  assert.doesNotMatch(uiHtml, /四半期ごとに作る見直し案/);
}

// ==== 3. 根拠の補正: 所有者が承認した値・自動の学びを止めている ====
{
  const basis = (learning, cal) => {
    const v = planView({ learning });
    return tipOf(run(`S.fc.view = __v; S.fc.basis = __b; fcBasisTab(S.fc.data, __v)`, { __v: v, __b: { planId: 'P1', annual: {}, monthly: [], research: [], applied: null, calibration: cal } }), '補正');
  };
  const cal = { factor: 1, aiWeight: 0, aiMax: null, monthBias: {}, updatedAt: '2026-10-07T09:30:00+09:00', quarter: '' };
  const OFF = '\n自動の学びを止めているので、「補正を学び直す」と「見直しを反映」では変わりません';
  assert.equal(basis({ autoUpdate: false, biasFactor: 1, note: OWNER_NOTE }, cal), '所有者が承認した値（2026/10/07）で決めた、予測の直し方です' + OFF);
  assert.equal(basis({ autoUpdate: true, biasFactor: 1, note: OWNER_NOTE }, cal), '所有者が承認した値（2026/10/07）で決めた、予測の直し方です');
  assert.equal(basis({ autoUpdate: true, biasFactor: 0.9, note: 'auto-learned' }, cal), '「補正を学び直す」と「見直しを反映」で決まる、予測の直し方です');
  assert.equal(basis(undefined, cal), '「補正を学び直す」と「見直しを反映」で決まる、予測の直し方です', '学びの中身が無くても描ける');
  // 旗が 0 なら、所有者の書いた跡が無くても「補正を学び直す」と「見直しを反映」で決まるとは言わない（どちらでも値は変わらない）
  for (const note of ['', 'auto-learned']) {
    const t = basis({ autoUpdate: false, biasFactor: 0.9, note }, cal);
    assert.equal(t, '今の値のまま使う、予測の直し方です' + OFF);
    assert.doesNotMatch(t, /で決まる/);
  }
}

// ==== 4. AI の効き: 0 は 0%、小さい値は 2 けた ====
{
  const q = (x) => run('qrValue("ai_weight_override", __x)', { __x: x });
  assert.deepEqual([0, '0', 0.0008, '0.0004', 0.002, 0.0015, 0.01, 0.5, 1, '', null].map(q), ['0%', '0%', '0.08%', '0.04%', '0.2%', '0.15%', '1%', '50%', '100%', '既定', '既定']);
  assert.equal(q('abc'), 'abc', '数でない値はそのまま');
  // 見直し案の表: 0.0008 → 0.0004 が「0% → 0%」にならない
  const props = [{ row: 8, pid: 'P1', target: 'ai_weight_override', current: '0.0008', proposed: '0.0004', conf: '中', rationale: '', impact: '', decision: '', rollback: '' }];
  assert.match(run(`S.fc.view = __v; fcRvProposals({ title: '', period: '', reviewId: 'R-1', applied: false, logRecent: [], proposals: __p })`, { __v: planView(), __p: props }),
    /AI の効き<\/td><td class="num"[^>]*>0\.08%<\/td><td class="num"[^>]*>0\.04%<\/td>/);
  // 根拠の補正の説明
  const tipLines = (w) => (/<p class="fc-say" data-tip="([^"]*)"/.exec(run(`S.fc.basis = __b; fcBasisTab(S.fc.data, S.fc.view)`,
    { __b: { planId: 'P1', annual: {}, monthly: [], research: [], applied: null, calibration: { factor: 1, aiWeight: w, aiMax: 0.05, monthBias: {}, updatedAt: '', quarter: '' } } })) || [])[1];
  assert.match(tipLines(0.0004), /AI の効き 0\.04%・上限 ±5%/);
  assert.match(tipLines(0), /AI の効き 0%・上限 ±5%/);
  assert.match(tipLines(null), /AI の効き 既定・上限 ±5%/);
}

// ==== 5. 学び > 人の学び: 比べた月がまだ無い ====
const hero = (d) => run('lrPeopleHero(__d)', { __d: d });
const pose = (h) => (/data-pose="([^"]*)"/.exec(h) || [])[1];
const heroSay = (h) => (/<span data-tip="[^"]*">([^<]*)<\/span>/.exec(h) || [])[1];
const NONE_SAY = 'まだ実績と比べた月がありません。各計画の振り返りで「当たり具合を計算」と「外れの原因を整理」を動かすと、大きく外れた月がここに出ます。';
{
  const none = hero({ summary: { months: 0, misses: 0, withNotes: 0 }, openActions: [], repeats: [], noPreMonth: 3 });
  assert.equal(heroSay(none), NONE_SAY);
  assert.doesNotMatch(none, /大きく外れた月はありません|予報どおり/);
  assert.equal(pose(none), 'explain');
  assert.match(none, /data-tip="[^"]*締まった月（月末から 5 日たってから実績を取り込んだ月）を、その月が始まる前の最後の予測と比べます\n締まった月のうち のべ 3 か月は、その月が始まる前の予測が無いので比べていません"/);
  assert.equal(pose(hero({})), 'explain', 'まとめが無いときも、まだ比べていない');
  // 比べた月があって、外れが無いときだけ「外れた月はありません」
  const calm = hero({ summary: { months: 4, misses: 0, withNotes: 0 }, openActions: [], repeats: [], noPreMonth: 0 });
  assert.match(calm, /大きく外れた月はありません。予報どおりの空模様が続いています。/);
  assert.equal(pose(calm), 'done');
  assert.doesNotMatch(calm, /締まった月のうち/);
  const miss = hero({ summary: { months: 4, misses: 2, withNotes: 1 }, openActions: [{}], repeats: [] });
  assert.match(miss, /大きく外れた月を 2 件観測しました。人の振り返りは 1 件、残っている対応は 1 件です。/);
  assert.equal(pose(miss), 'discover');
}

// ==== 6. 分析の案内: 外れ幅・読みのクセは、当たり具合を計算で出る ====
{
  const plan = { planId: 'P1', clientName: 'テスト製薬', fy: '2026', budget: 1000, officialFinal: null, budgetUsed: null, landing: 1050, landingP10: 950, landingP90: 1150, landingSd: 78, ratio: 1.05, pAbove: 0.7,
    sky: 'harenochi', skyReason: 'ratio', accuracy: { mape: null, bias: null, n: 0, coverage: null, coverageN: 0 }, revisions: [{ at: '2026-09-01', p50: 1000 }, { at: '2026-10-01', p50: 1050 }], topics: [] };
  const guideOf = (plans) => (/<div class="guide">[\s\S]*?<div class="bubble">([\s\S]*?)<\/div><\/div><\/div>/.exec(run(`S.an.data = __d; S.an.tab = 'overview'; viewAnalysis()`,
    { __d: { fy: '2026', fys: ['2026'], totals: { budget: 1000, budgetPlans: 1, landing: 1050, ratioLanding: 1.05 }, plans } })) || [])[1];
  assert.equal(guideOf([plan]), 'まだ数字がそろっていないため、外れ幅・読みのクセは出していません。各計画の振り返りで「当たり具合を計算」を動かすと、ここに出てきます。');
  const noRev = Object.assign({}, plan, { revisions: [] });
  assert.equal(guideOf([noRev]), 'まだ数字がそろっていないため、外れ幅・読みのクセ・予測の見直しの流れは出していません。予測を動かし、実績を取り込むと、ここに出てきます。'
    + '外れ幅・読みのクセは、各計画の振り返りで「当たり具合を計算」を動かすと出ます。');
  const empty = { planId: 'P2', clientName: '別の製薬', fy: '2026', sky: 'mikakunin', skyReason: 'no_forecast', accuracy: null, revisions: [] };
  assert.equal(guideOf([empty]), 'まだ着地の推定や、予測と実績の比べがないため、グラフは出していません。予測を動かし、実績を取り込むと、ここに出てきます。'
    + '外れ幅・読みのクセは、各計画の振り返りで「当たり具合を計算」を動かすと出ます。');
  const withAcc = Object.assign({}, plan, { accuracy: { mape: 0.12, bias: 0.04, n: 5, coverage: 0.8, coverageN: 5 } });
  assert.equal(guideOf([withAcc]), undefined, 'そろっていれば案内は出さない');
}

// ==== 7. 出した直後と同じ形: 古い版の検証の行だけがある計画（外れ幅は無い）で、ホーム・分析・学びを描く ====
{
  const H = env.run('(() => { const o = {}; Object.keys(APP_ENGINE_SHEETS).forEach(k => { o[k] = APP_ENGINE_SHEETS[k].header || null; }); return o; })()');
  const row = (sheet, o) => H[sheet].map((h) => (o[h] === undefined ? '' : o[h]));
  const output = [['FY2026 売上予測（テスト製薬）']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 900, 1000, 1100], [], []);
  for (let i = 0; i < 12; i++) { const m = 4 + i; output.push([(m > 12 ? 2027 : 2026) + '/' + String(m > 12 ? m - 12 : m).padStart(2, '0'), 90, 100, 110, '', '', '', 100, 10]); }
  const OLD = 'policy-2026H1-v2';
  assert.notEqual(OLD, POLICY);
  const evalRows = [['2026/04', 1250], ['2026/05', 900], ['2026/06', 1000]].flatMap(([ym, act], i) => ['nega', 'neutral', 'posi']
    .map((sc, j) => row('EVAL_LOG', { eval_id: 'E' + i + sc, evaluated_at: D(2026, 9, 1), client: 'テスト製薬', target_month: ym, scenario: sc, pred: 900 + 100 * j, actual: act,
      evaluation_policy_version: OLD, constraint_relevant_flag: 1 })));
  const planId = env.seedPlan(env.makeBook('テスト', {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', 'テスト製薬'], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    OUTPUT: { values: output },
    PROCESS_STATUS: { values: [H.PROCESS_STATUS, ['step2_status', new Date(2026, 9, 6, 10), 'owner', 'success', 'テスト製薬', 10, ''],
      ['step5_status', new Date(2026, 9, 6, 11), 'owner', 'success', 'テスト製薬', 10, '']] },
    EVAL_LOG: { values: [H.EVAL_LOG].concat(evalRows), formats: { D: '@' } },
    EVAL_INSIGHTS: { values: [H.EVAL_INSIGHTS, row('EVAL_INSIGHTS', { client: 'テスト製薬', evaluated_at: D(2026, 6, 10), target_month: D(2026, 4), actual_total: 1250, pred_p50: 1000,
      cause_bucket: 'over_forecast', action_type: 'update', status: 'open', range_breach: 0 })] },
    QUARTERLY_REVIEW_LOG: { values: [H.QUARTERLY_REVIEW_LOG, row('QUARTERLY_REVIEW_LOG', { review_id: 'R1', proposal_id: 'P-A-1', reviewed_at: D(2026, 7, 10), quarter_label: 'FY2026-Q1', phase: 'A',
      target_field: 'ai_weight_override', current_value: '0.0008', proposed_value: '0.0004', confidence: '中', rationale: 'x', approval_status: '取り下げ', approval_decided_at: D(2026, 10, 7),
      approval_decided_by: OWNER, applied: 0 })] },
    CALIBRATION_HISTORY: { values: [H.CALIBRATION_HISTORY, row('CALIBRATION_HISTORY', { change_id: 'H-1', changed_at: D(2026, 10, 7), changed_by: OWNER, client: 'テスト製薬', quarter_label: 'FY2026-Q3',
      source_review_id: 'OWNER-APPROVED', factor_name: 'bias_correction_factor', old_value: '0.8', new_value: '1', rollback_hint: '戻す' })] }
  }));
  const home = env.call('apiHome()');
  const an = env.call('apiCrossMaker(__in)', { __in: {} });
  const people = env.call('apiPeopleLearning()');
  const ai = env.call('apiAiLearning()');
  // 本物の中身が、出した直後と同じ形になっている（古い版の行は数えない・外れ幅は無い・判断の履歴はある）
  const hp = home.plans.filter((p) => p.planId === planId)[0];
  assert.ok(hp && hp.mape === null, 'ホームの外れ幅は無い: ' + JSON.stringify(hp && hp.mape));
  const ap = an.plans.filter((p) => p.planId === planId)[0];
  assert.ok(ap && !(ap.accuracy && typeof ap.accuracy.mape === 'number'), '分析の外れ幅は無い');
  assert.equal(people.summary.months, 0);
  assert.ok((people.decisions || []).length >= 1, '判断の履歴はある（人の学びは案内 1 枚にならない）');
  const clean = (html, what) => { assert.ok(!/undefined|NaN/.test(html), what + 'に undefined や NaN を出さない'); return html; };
  // ホーム: 外れ幅は「-」、説明で当たり具合を計算を案内する。精度の天気は霧
  const h = clean(run(`S.view = 'home'; B.home = __h; S.lr.ai = __ai; viewHome()`, { __h: home, __ai: ai }), 'ホーム');
  assert.match(h, /<div class="kpi" data-tip="[^"]*まだ実績と比べたメーカーがありません。各計画の振り返りで「当たり具合を計算」を動かすと出ます"><div class="k">外れ幅<\/div><div class="v">-<\/div><\/div>/);
  assert.match(h, /data-tip="霧：比べられる実績がまだない\n各計画の振り返りで「当たり具合を計算」を動かすと出ます\n[^"]*"><span class="skych"[^>]*aria-label="霧"[\s\S]*精度の天気[\s\S]*霧[\s\S]*比べる実績はまだです/);
  // 分析: 外れ幅・読みのクセのカードは出さず、案内に当たり具合を計算を出す
  const a = clean(run(`S.view = 'analysis'; S.an.data = __a; S.an.tab = 'overview'; viewAnalysis()`, { __a: an }), '分析');
  assert.match(a, /外れ幅・読みのクセ[^<]*は出していません。[^<]*各計画の振り返りで「当たり具合を計算」を動かすと/);
  assert.doesNotMatch(a, /<h2>外れ幅<span|<h2>読みのクセ<span/);
  // 学び: 人の学びは「まだ比べた月がありません」、AI の学びも外れ幅が無いことを言う
  const lp = clean(run(`S.view = 'learning'; S.lr.tab = 'people'; S.lr.people = __p; viewLearning()`, { __p: people }), '人の学び');
  assert.match(lp, /まだ実績と比べた月がありません。/);
  assert.doesNotMatch(lp, /今の決まり/, '中の言葉（今の決まり）は出さない');
  assert.doesNotMatch(lp, /大きく外れた月はありません/);
  const la = clean(run(`S.lr.tab = 'ai'; S.lr.ai = __ai; viewLearning()`, { __ai: ai }), 'AI の学び');
  assert.match(la, /<div class="bubble">まだ実績と比べた月がありません。各計画の振り返りで「当たり具合を計算」を動かすと、外れ幅がここに出ます。<\/div>/);
  assert.match(la, /<span class="nm">霧<\/span><span class="v">比べる実績なし<\/span>/);
  assert.match(lp, /締まった月のうち のべ 3 か月は、その月が始まる前の予測が無いので比べていません/, '月が始まる前の予測が無い月の数（本物の中身）');
}

// ==== 8. 人の学びのまとめ: 実績と比べた月（scoredMonths）と、振り返りの記録（months） ====
{
  const h = (summary, more) => hero(Object.assign({ openActions: [], repeats: [], noPreMonth: 0, summary }, more || {}));
  // 比べた月が無い（scoredMonths = 0）: 当たり具合を計算から
  const n0 = h({ months: 0, misses: 0, withNotes: 0, scoredMonths: 0 });
  assert.equal(heroSay(n0), NONE_SAY);
  assert.equal(pose(n0), 'explain');
  // 比べた月はあるが、振り返りの記録が無い: 外れの原因を整理を案内する（「外れた月はありません」とは言わない）
  const n1 = h({ months: 0, misses: 0, withNotes: 0, scoredMonths: 5 });
  assert.equal(heroSay(n1), '実績と比べた月が のべ 5 か月あります。各計画の振り返りで「外れの原因を整理」を動かすと、大きく外れた月がここに出ます。');
  assert.equal(pose(n1), 'explain');
  assert.doesNotMatch(n1, /大きく外れた月はありません|予報どおり/);
  [n0, n1].forEach((x) => assert.doesNotMatch(heroSay(x), /今の決まり/, '中の言葉（今の決まり）は見える文に出さない'));
  // 振り返りの記録があれば、scoredMonths が同じ数でも無くても今までどおり（外れなし・外れあり。多いときは 16 で確かめる）
  for (const scoredMonths of [4, undefined]) {
    const calm = h({ months: 4, misses: 0, withNotes: 0, scoredMonths });
    assert.equal(heroSay(calm), '大きく外れた月はありません。予報どおりの空模様が続いています。');
    assert.equal(pose(calm), 'done');
    const miss = h({ months: 4, misses: 2, withNotes: 1, scoredMonths }, { openActions: [{}] });
    assert.equal(heroSay(miss), '大きく外れた月を 2 件観測しました。人の振り返りは 1 件、残っている対応は 1 件です。');
    assert.equal(pose(miss), 'discover');
  }
  // scoredMonths を返さない（前の）サーバー: 振り返りの記録が無ければ、今までどおり当たり具合を計算から
  assert.equal(heroSay(h({ months: 0, misses: 0, withNotes: 0 })), NONE_SAY);
  assert.equal(heroSay(h(undefined)), NONE_SAY, 'まとめが無くても描ける');
  // 何も無いときの案内 1 枚も、外れの原因を整理を言う（大きく外れた月の振り返りは、そこで出る）
  assert.match(run('lrPeopleView({ summary: { months: 0 } })'),
    /<div class="bubble">実績が締まって、各計画の振り返りで「当たり具合を計算」と「外れの原因を整理」を動かすと、大きく外れた月の振り返りと、読みの当たりがここに並びます。<\/div>/);
}

// ==== 9. 動かせない人（閲覧・情報提供）には「計算されると出ます」。締め済みの年度の分析は「計算し直しません」 ====
const AN_PLAN = { planId: 'P1', clientName: 'テスト製薬', fy: '2026', budget: 1000, officialFinal: null, budgetUsed: null, landing: 1050, landingP10: 950, landingP90: 1150, landingSd: 78, ratio: 1.05, pAbove: 0.7,
  sky: 'harenochi', skyReason: 'ratio', accuracy: { mape: null, bias: null, n: 0, coverage: null, coverageN: 0 }, revisions: [{ at: '2026-09-01', p50: 1000 }, { at: '2026-10-01', p50: 1050 }], topics: [] };
const anGuide = (plans, fy = '2026') => (/<div class="guide">[\s\S]*?<div class="bubble">([\s\S]*?)<\/div><\/div><\/div>/.exec(run(`S.an.data = __d; S.an.fy = __d.fy; S.an.tab = 'overview'; viewAnalysis()`,
  { __d: { fy, fys: [fy], totals: { budget: 1000, budgetPlans: 1, landing: 1050, ratioLanding: 1.05 }, plans } })) || [])[1];
{
  const home = { fy: '2026', plans: [{ planId: 'P1', clientName: 'テスト製薬', fy: '2026', mape: null }] };
  asRoles(VIEWER_ROLES, () => {
    assert.equal(run('runWhen()'), '当たり具合が計算されると');
    // 人の学び・AI の学び
    assert.equal(heroSay(hero({ summary: { months: 0, scoredMonths: 0 } })), 'まだ実績と比べた月がありません。当たり具合が計算され、外れの原因が整理されると、大きく外れた月がここに出ます。');
    assert.equal(heroSay(hero({ summary: { months: 0, scoredMonths: 2 } })), '実績と比べた月が のべ 2 か月あります。外れの原因が整理されると、大きく外れた月がここに出ます。');
    assert.match(run('lrPeopleView({})'), /<div class="bubble">実績が締まって、当たり具合が計算され、外れの原因が整理されると、大きく外れた月の振り返りと、読みの当たりがここに並びます。<\/div>/);
    assert.match(run('lrAiView({})'), /<div class="bubble">実績が締まって、当たり具合が計算されると、AI が何を学んだか（重み・偏り・外れ幅・補正）がここに出ます。<\/div>/);
    assert.match(run('lrAiHero({ health: [], timeline: [] })'), /<div class="bubble">まだ実績と比べた月がありません。当たり具合が計算されると、外れ幅がここに出ます。/);
    // ホーム: 外れ幅の箱・精度の天気の説明
    assert.match(run('homeKpis(__h, __h.plans)', { __h: home }), /data-tip="[^"]*\nまだ実績と比べたメーカーがありません。当たり具合が計算されると出ます"><div class="k">外れ幅<\/div>/);
    assert.match(run('S.lr.ai = { health: [], pending: [] }; homeLearnCard(__h, __h.plans)', { __h: home }), /data-tip="霧：比べられる実績がまだない\n当たり具合が計算されると出ます\n精度の推移は/);
    // 分析
    assert.equal(anGuide([AN_PLAN]), 'まだ数字がそろっていないため、外れ幅・読みのクセは出していません。当たり具合が計算されると、ここに出てきます。');
    // 見える文・説明のどこにも「当たり具合を計算」を動かすようには言わない
    for (const html of [hero({ summary: { months: 0 } }), run('lrAiView({})'), run('homeKpis(__h, __h.plans)', { __h: home })]) assert.doesNotMatch(html, /「当たり具合を計算」を動かす/);
  });
  // メーカー単位の予算策定担当は動かせる（どこかの計画で動かせれば、動かし方を言う）
  asRoles(VIEWER_ROLES.concat([{ role: 'PLANNER', scopeType: 'CLIENT', clientId: 'C1' }]), () => assert.equal(run('runWhen()'), '各計画の振り返りで「当たり具合を計算」を動かすと'));
  assert.equal(run('runWhen(["EVAL.INSIGHTS"])'), '各計画の振り返りで「外れの原因を整理」を動かすと');
  // 締め済みの年度（計画の一覧の frozen）: 当たり具合は計算し直さないと言い、動かし方は言わない
  const fy25 = Object.assign({}, AN_PLAN, { fy: '2025' });
  run(`S.an.plans = [{ planId: 'P1', fy: 2025, frozen: true }, { planId: 'P9', fy: 2026, frozen: false }]`);
  assert.equal(anGuide([fy25], '2025'), '外れ幅・読みのクセはありません（FY2025 は締め済みのため、当たり具合は計算し直しません）。', '締め済みの年度は「まだ」と言わない');
  assert.equal(anGuide([AN_PLAN]), 'まだ数字がそろっていないため、外れ幅・読みのクセは出していません。各計画の振り返りで「当たり具合を計算」を動かすと、ここに出てきます。', '締めていない年度はそのまま');
  // 分析の中身に frozen があれば、それを使う（グラフが何も描けないときは、予測を動かすようにも言わない）
  run('S.an.plans = null');
  const empty = { planId: 'P2', clientName: '別の製薬', fy: '2025', sky: 'mikakunin', skyReason: 'no_forecast', accuracy: null, revisions: [], frozen: true };
  assert.equal(anGuide([empty], '2025'), '着地の推定や、予測と実績の比べはありません（FY2025 は締め済みのため、予測や当たり具合は計算し直しません）。');
  assert.equal(anGuide([fy25], '2025'), 'まだ数字がそろっていないため、外れ幅・読みのクセは出していません。各計画の振り返りで「当たり具合を計算」を動かすと、ここに出てきます。', '分からなければ締めていないとみなす');
  // 計画の一覧は、前の年度を開いたときだけ 1 回読む（今の年度・frozen のある中身では読まない）
  const keepHome = run('B.home');
  const loads = (r) => run(`B.home = { fy: '2026', plans: [] }; S.an.plans = null; delete S.ld.anPlans; anLoadPlans(__r); var __l = !!S.ld.anPlans; delete S.ld.anPlans; __l`, { __r: r });
  assert.deepEqual([loads({ fy: '2025', plans: [fy25] }), loads({ fy: '2026', plans: [AN_PLAN] }), loads({ fy: '2027', plans: [] }), loads({ fy: '2025', plans: [empty] })], [true, false, false, false]);
  run('B.home = __k', { __k: keepHome });
}

// ==== 10. 荒れの文は、出ている印だけで作る。比べた月が無ければ出し方も言う ====
{
  const fy = run('lrFy()');
  const clamp = { planId: 'P1', clientName: 'テスト製薬', fy, key: 'factor_clamp', label: '', value: 0.75 };
  const cov = { planId: 'P2', clientName: '別の製薬', fy, key: 'coverage_low', label: '', value: { coverage: 0.5, n: 6 } };
  const old = Object.assign({}, cov, { planId: 'P3', fy: String(Number(fy) - 1) });
  const heroAi = (health, timeline) => run('lrAiHero(__d)', { __d: { health, timeline: timeline || [], pending: [] } });
  const say = (health, timeline) => (/<div class="bubble">(?:<span data-tip="[^"]*">)?([^<]*)/.exec(heroAi(health, timeline)) || [])[1];
  const sayTip = (health, timeline) => (/<div class="bubble"><span data-tip="([^"]*)">/.exec(heroAi(health, timeline)) || [])[1];
  const NOT_YET = 'まだ実績と比べた月がありません。各計画の振り返りで「当たり具合を計算」を動かすと、外れ幅がここに出ます。';
  // 補正が限度に張りついただけ（比べた月は無い）: 見える文は印の短い言い方と出し方だけ（見通しの幅の外れも、荒れの説明も言わない）。説明はカーソルで
  assert.equal(say([clamp]), '補正が限度に張りついています（1 メーカー）。' + NOT_YET);
  assert.doesNotMatch(say([clamp]), /見通しの幅|荒れています|状態です/);
  assert.equal(sayTip([clamp]), '補正が限度に張りついていて、外れを補正で追いきれていない状態です。');
  assert.equal(say([cov, old]), '見通しの幅が狭すぎます（1 メーカー）。' + NOT_YET, '前の年度の印は数えない');
  assert.equal(sayTip([cov, old]), '実績が見通しの幅から外れることが多く、幅が狭すぎる状態です。');
  assert.equal(say([clamp, cov]), '補正が限度に張りついたり、幅が狭すぎたりしています（2 メーカー）。' + NOT_YET);
  assert.equal(sayTip([clamp, cov]), '補正が限度に張りついたり、実績が見通しの幅から外れたりしていて、予測がぶれやすい状態です。');
  // 比べた月があれば、今までどおりの荒れの文（出し方は言わない・カーソルの説明は付けない）
  const tl = [{ ym: '2026/05', n: 2, mape: 0.12, rolling3: 0.12 }];
  assert.equal(say([clamp], tl), '予測の当たり方が荒れています（1 メーカー）。補正が限度に張りついていて、外れを補正で追いきれていない状態です。');
  assert.equal(sayTip([clamp], tl), undefined);
  // 荒れの印が無ければ、今までどおり出し方だけ
  assert.equal(say([]), NOT_YET);
  assert.equal(sayTip([]), undefined);
  asRoles(VIEWER_ROLES, () => assert.equal(say([clamp]), '補正が限度に張りついています（1 メーカー）。まだ実績と比べた月がありません。当たり具合が計算されると、外れ幅がここに出ます。'));
  // ホームの学びの進み: 印が 1 種類ならその名前、比べた月が無ければ説明で出し方を言う
  const home = { fy, plans: [{ planId: 'P1', clientName: 'テスト製薬', fy, mape: null }] };
  const card = (health) => run('S.lr.ai = { health: __hl, pending: [] }; homeLearnCard(__h, __h.plans)', { __hl: health, __h: home });
  assert.match(card([clamp]), /<span class="t1">台風<\/span><span class="t2">補正が限度（1 メーカー）<\/span>/);
  assert.match(card([clamp]), /data-tip="台風：[^"\n]*\nまだ実績と比べたメーカーがありません。各計画の振り返りで「当たり具合を計算」を動かすと出ます\n荒れている印: 補正が上限か下限に張りついたメーカー 1\n/);
  assert.match(card([cov]), /<span class="t2">幅が狭すぎる（1 メーカー）<\/span>/);
  assert.match(card([clamp, cov]), /<span class="t2">荒れています（2 メーカー）<\/span>/);
  assert.match(card([]), /<span class="t2">比べる実績はまだです<\/span>/);
}

// ==== 11. 根拠の補正: 出している予測の補正と今の補正が違うとき（所有者が戻した直後など） ====
{
  const cal = (applied, factor) => {
    const html = run(`S.fc.view = __v; S.fc.basis = __b; fcBasisTab(S.fc.data, __v)`, { __v: planView(), __b: { planId: 'P1', annual: {}, monthly: [], research: [], applied,
      calibration: { factor, aiWeight: null, aiMax: null, monthBias: {}, updatedAt: '', quarter: '' } } });
    const m = /<h2>補正<span[\s\S]*?<p class="fc-say" data-tip="([^"]*)">([^<]*)<\/p>/.exec(html);
    return { tip: m[1], say: m[2] };
  };
  const reset = cal({ bias_correction_factor: 0.97 }, 1);
  assert.equal(reset.say, '最新の予測は 3.0% 下げています（次の予測から補正なし）');
  assert.match(reset.tip, /最新の予測は 3\.0% 下げて計算しました\n今の補正: 補正なし（次の予測から効きます）/);
  assert.doesNotMatch(reset.say, /かけていません/, '見える一文は、出している予測と食い違わない');
  assert.equal(cal({ bias_correction_factor: '1' }, 0.98).say, '最新の予測は、補正なしです（次の予測から 2.0% 下げ）');
  assert.equal(cal({ bias_correction_factor: '0.97' }, 1.05).say, '最新の予測は 3.0% 下げています（次の予測から 5.0% 上げ）');
  // 同じなら今までどおり（今の補正の一文だけ）
  const same = cal({ bias_correction_factor: 0.97 }, 0.97);
  assert.equal(same.say, 'これまでの外れ方から 3.0% 下げています');
  assert.doesNotMatch(same.tip, /次の予測から効きます/);
  assert.equal(cal(null, 1).say, 'これまでの外れ方による補正は、かけていません');
}

// ==== 12. 振り返り: 人の記入・見直し案があって、比べた月がまだ無い ====
{
  const insights = [{ row: 5, month: '2026/04', insight: '外れ', nextAction: '', hypothesis: '', actionType: 'update', reflection: '', owner: '', status: 'open' }];
  const props = [{ row: 8, pid: 'P1', target: 'ai_weight_override', current: '0.0008', proposed: '0.0004', conf: '中', rationale: '', impact: '', decision: '', rollback: '' }];
  const NOTE = (s) => '<div class="card"><div class="card-head"><h2>精度の天気</h2></div><p class="note">まだ実績と比べた月がありません。' + s + '</p></div>';
  const a = review(planView({ insights }));
  assert.ok(a.includes(NOTE('「当たり具合を計算」で出ます。')), a.slice(0, 300));
  assert.ok(a.indexOf(NOTE('')) < 0 && a.indexOf('<h2>精度の天気</h2>') < a.indexOf('<h2>人の記入'), '人の記入より先（精度の天気の場所）');
  assert.doesNotMatch(a, /まだ振り返りの記録がありません/, '案内 1 枚とは重ねない');
  assert.ok(review(planView({ proposals: props, can: false })).includes(NOTE('当たり具合が計算されると出ます。')), '動かせない人');
  const fz = review(planView({ insights, can: false, frozen: true }));
  assert.ok(fz.includes('<p class="note">実績と比べた月はありません（締め済みの年度は、当たり具合を計算し直しません）。</p>'), '締め済みの年度は「まだ」と言わない');
  assert.doesNotMatch(fz, /まだ実績と比べた月/);
  // 何も無いときは案内 1 枚だけ（1 行は出さない）。締め済みなら案内も「計算されると」とは言わない
  assert.doesNotMatch(review(planView()), /<h2>精度の天気<\/h2>/);
  const f = review(planView({ can: false, frozen: true }));
  assert.match(f, /<div class="bubble">振り返りの記録はありません（締め済みの年度は、当たり具合を計算し直しません）。<\/div>/);
  assert.doesNotMatch(f, /計算されると|まだ振り返りの記録/);
  // 比べた月があれば 1 行は出さない（精度の天気のカード）
  const withAcc = run(`S.fc.learn = { planId: 'P1', accuracy: { months: [{ month: '2026/04', p10: 1, p50: 2, p90: 3, actual: 2, err: 0, inside: true }], mape: 0.05, n: 1, coverage: 1, coverageN: 1 } }; fcReviewTab(S.fc.data, S.fc.view)`);
  assert.doesNotMatch(withAcc, /まだ実績と比べた月がありません/);
  assert.match(withAcc, /精度の天気[\s\S]*精度の推移/);
}

// ==== 13・17. 承認して反映: 自動の学びを止めている間は、判断を記録するだけ（ボタンは押せる・名前はそのまま） ====
{
  const props = [{ row: 8, pid: 'P1', target: 'ai_weight_override', current: '0.0008', proposed: '0.0004', conf: '中', rationale: '', impact: '', decision: '', rollback: '' }];
  const KEEP = '設定（補正・信頼度・AI の効き）は変わりません';
  const OFFN = '自動の学びを止めている間は、判断を記録するだけで、' + KEEP;
  const BTN = '判断を保存してから、承認した案を設定に反映します（3〜6 分ほど）。判断を選んでいない案は承認になります';
  const BTN_OFF = '判断を記録します（3〜6 分ほど）。判断を選んでいない案は承認になります\n自動の学びを止めている間は、' + KEEP;
  for (const note of ['', OWNER_NOTE]) {
    const off = review(planView({ proposals: props, learning: { autoUpdate: false, biasFactor: 1, note } }));
    assert.ok(off.includes('data-tip="' + BTN_OFF + '"><button class="btn" onclick="fcRvGo()">承認して反映</button>'), '押せるまま、説明の 1 行目から記録だけと言う');
    assert.doesNotMatch(off, /承認した案を設定に反映します/, '旗が 0 の間は、設定に反映するとは言わない');
    assert.ok(off.includes('<span class="chip warn" data-tip="' + OFFN + '">未反映</span>'));
  }
  const on = review(planView({ proposals: props }));
  assert.ok(on.includes('data-tip="' + BTN + '"><button class="btn" onclick="fcRvGo()">承認して反映</button>'));
  assert.ok(on.includes('<span class="chip warn" data-tip="承認者が判断して反映すると、次の予測から効きます">未反映</span>'));
  // 確かめる文: 何を記録するか → かかる時間 → 設定が変わらないこと（「…は反映しません」は言わない）。確かめのボタンの名前は、押したボタンと同じ
  const asked = (v, dec) => Array.from(run(`var __m = null, __ask = ask; ask = function(m, ok){ __m = [m, ok]; }; S.fc.view = __v; S.fc.dec = __dec; fcRvGo(); ask = __ask; S.fc.dec = {}; __m`, { __v: v, __dec: dec || {} }));
  const OFF_END = '\n自動の学びを止めている間は、' + KEEP + '。';
  const offV = (more) => planView({ proposals: more || props, learning: { autoUpdate: false, note: OWNER_NOTE } });
  assert.deepEqual(asked(offV()), ['承認 1 件の判断を記録します（3〜6 分ほど）。' + OFF_END, '承認して反映']);
  assert.deepEqual(asked(planView({ proposals: props, learning: { autoUpdate: false, note: '' } }), { 8: '保留' }), ['保留 1 件の判断を記録します（3〜6 分ほど）。' + OFF_END, '承認して反映']);
  const two = props.concat([Object.assign({}, props[0], { row: 9 })]);
  const t2 = asked(offV(two), { 9: '却下' });
  assert.equal(t2[0], '承認 1 件・却下 1 件の判断を記録します（3〜6 分ほど）。' + OFF_END);
  assert.doesNotMatch(t2[0], /反映しません|反映します/);
  assert.deepEqual(asked(planView({ proposals: props })), ['1 件を承認して反映します。\n判断を保存してから反映します（3〜6 分ほど）。反映した補正は、次の予測から効きます。', '承認して反映']);
  assert.equal(asked(planView({ proposals: two }), { 9: '保留' })[0], '1 件を承認して反映します。保留 1 件は反映しません。\n判断を保存してから反映します（3〜6 分ほど）。反映した補正は、次の予測から効きます。', '旗が 1 なら今までどおり');
}

// ==== 14. 小さな直し: AI の効きの端の値・分析の案内の空白・スマホの説明 ====
{
  const p = (x) => run('aiPct(__x)', { __x: x });
  assert.deepEqual([-0.001, -1, NaN, '', '  ', null, undefined, 'abc', Infinity].map(p), Array(9).fill('-'), '空・数でない・マイナスは -');
  assert.deepEqual([1e-9, 1e-7, 0.0000099].map(p), ['0.001% 未満', '0.001% 未満', '0.001% 未満']);
  assert.deepEqual([0, '0', 0.00001, 0.0000123, 0.0008, '0.0004', 0.01, 1].map(p), ['0%', '0%', '0.001%', '0.0012%', '0.08%', '0.04%', '1%', '100%']);
  for (let e = -15; e <= 0; e++) assert.doesNotMatch(p(Math.pow(10, e)), /\de/i, '指数の書き方にしない: 1e' + e);
  assert.equal(run('qrValue("ai_weight_override", -0.01)'), '-');
  assert.equal(run('qrValue("ai_weight_override", "")'), '既定', '空は今までどおり既定');
  // 分析の案内: 「は出していません」の前に半角の空白を入れない
  assert.doesNotMatch(uiHtml, / は出していません/);
  // スマホ: 欄を選んだまま押せないボタンに触れたとき、欄の focusout で説明を消さない（消すのは説明の元とその中から外れたときだけ）
  const L = {};
  const t = loadUi(L);
  const box = vm.runInContext("$('tipbox')", t);
  const fire = (type, e) => (L[type] || []).forEach((fn) => fn(e));
  const on = () => box.classList.contains('on');
  const input = fakeEl('input'), btn = fakeEl('button', ['btn'], { disabled: 'disabled' });
  const act = fakeEl('span', ['act'], { 'data-tip': '保存するものがありません' }, [btn]);
  fakeEl('div', [], {}, [input, act]);
  fire('focusin', { target: input });
  assert.equal(on(), false);
  fire('pointerdown', { pointerType: 'touch', target: btn });
  assert.equal(on(), true);
  assert.equal(box.textContent, '保存するものがありません');
  fire('focusout', { target: input });
  assert.equal(on(), true, '欄の focusout では消さない');
  fire('focusout', { target: btn });
  assert.equal(on(), false, '説明の元の中から外れたら消す');
  // キーボード: 説明の印を選ぶと出て、そこから外れると消える
  const icon = fakeEl('span', ['tip'], { 'data-tip': '説明' });
  fire('focusin', { target: icon });
  assert.equal(on(), true);
  fire('focusout', { target: icon });
  assert.equal(on(), false);
}

// ==== 15. 振り返り: 比べた月（scoredMonths）があるのに外れ幅の月が無い = どの月も売上が 0 円 ====
/** 振り返りのタブ（当たり具合の中身を渡す） */
const reviewL = (v, learn) => run(`S.fc.planId = 'P1'; S.fc.view = __v; S.fc.data = { plan: __v.plan, latest: null, runs: [], stored: null }; S.fc.learn = __l; S.fc.ins = {};
  fcReviewTab(S.fc.data, S.fc.view)`, { __v: v, __l: Object.assign({ planId: 'P1', accuracy: { months: [] } }, learn) });
const ACC1 = { months: [{ month: '2026/04', p10: 1, p50: 2, p90: 3, actual: 2, err: 0, inside: true }], mape: 0.05, n: 1, coverage: 1, coverageN: 1 };
const INS1 = [{ row: 5, month: '2026/04', insight: '外れ', nextAction: '', hypothesis: '', actionType: 'update', reflection: '', owner: '', status: 'open' }];
{
  const ZERO = '<div class="card"><div class="card-head"><h2>精度の天気</h2></div><p class="note">比べた 2 か月は、どれも売上が 0 円のため、外れ幅を % で出せません。</p></div>';
  // 人の記入・見直し案が無くても、案内 1 枚（「まだ振り返りの記録がありません」）ではなく、精度の天気の場所に 1 行
  const z = reviewL(planView(), { scoredMonths: 2 });
  assert.ok(z.includes(ZERO), z.slice(0, 400));
  assert.doesNotMatch(z, /まだ振り返りの記録|まだ実績と比べた月/);
  assert.doesNotMatch(z.slice(0, z.indexOf('<h2>振り返りの更新')), /で出ます|を動かすと|計算されると/, '動かし方は言わない');
  assert.ok(reviewL(planView({ insights: INS1 }), { scoredMonths: 2 }).includes(ZERO), '人の記入があっても同じ 1 行');
  for (const o of [{ can: false }, { can: false, frozen: true }]) assert.ok(reviewL(planView(o), { scoredMonths: 2 }).includes(ZERO), '動かせない人・締め済みの年度も同じ: ' + JSON.stringify(o));
  // scoredMonths = 0・無い: 今までどおり（まだ比べた月が無い）
  for (const scoredMonths of [0, undefined]) {
    assert.match(reviewL(planView(), { scoredMonths }), /<div class="bubble">まだ振り返りの記録がありません。月の実績が締まったら、/);
    assert.ok(reviewL(planView({ insights: INS1 }), { scoredMonths }).includes('<p class="note">まだ実績と比べた月がありません。「当たり具合を計算」で出ます。</p>'));
    assert.ok(reviewL(planView({ insights: INS1, can: false }), { scoredMonths }).includes('<p class="note">まだ実績と比べた月がありません。当たり具合が計算されると出ます。</p>'));
    assert.ok(reviewL(planView({ insights: INS1, can: false, frozen: true }), { scoredMonths }).includes('<p class="note">実績と比べた月はありません（締め済みの年度は、当たり具合を計算し直しません）。</p>'));
  }
  // 外れ幅の月があれば、scoredMonths があっても精度の天気のカード
  const w = reviewL(planView({ insights: INS1 }), { accuracy: ACC1, scoredMonths: 3 });
  assert.match(w, /精度の天気<span[\s\S]*精度の推移/);
  assert.doesNotMatch(w, /売上が 0 円/);
}

// ==== 16. 当たり具合を計算した後・外れの原因を整理の前 ====
{
  // (a) 振り返り: 当たり具合は出ていて人の記入が無い → 人の記入の場所に 1 行（精度の推移の後）
  const LINE = (t) => '<div class="card"><div class="card-head"><h2>人の記入</h2></div><p class="note">' + t + '</p></div>';
  const a = reviewL(planView(), { accuracy: ACC1, scoredMonths: 1 });
  assert.ok(a.includes(LINE('外れた月の記入は「外れの原因を整理」で出ます。')), a.slice(0, 300));
  assert.ok(a.indexOf('<h2>精度の推移') < a.indexOf('<h2>人の記入</h2>') && a.indexOf('<h2>人の記入</h2>') < a.indexOf('<h2>振り返りの更新'), '精度の推移と更新の間');
  assert.ok(reviewL(planView({ can: false }), { accuracy: ACC1 }).includes(LINE('外れた月の記入は、外れの原因が整理されると出ます。')), '動かせない人');
  assert.doesNotMatch(reviewL(planView({ can: false, frozen: true }), { accuracy: ACC1 }), /<h2>人の記入/, '締め済みの年度は言わない');
  const ins = reviewL(planView({ insights: INS1 }), { accuracy: ACC1 });
  assert.doesNotMatch(ins, /外れた月の記入は/, '人の記入があれば、その表');
  assert.match(ins, /<h2>人の記入<span/);
  assert.doesNotMatch(reviewL(planView(), {}), /外れた月の記入は/, '当たり具合が無ければ言わない');
  const pv = planView();
  pv.actions.filter((x) => x.action === 'EVAL.INSIGHTS')[0].paused = '止めています。';
  assert.doesNotMatch(reviewL(pv, { accuracy: ACC1 }), /外れた月の記入は/, '外れの原因を整理を止めている間は言わない');
  // (b) 人の学びのまとめ: 振り返りの記録より比べた月が多い → 残りの月の数と出し方を添える
  const h = (summary, more) => hero(Object.assign({ openActions: [], repeats: [], noPreMonth: 0, summary }, more || {}));
  const REST = 'ほかに のべ 3 か月は、各計画の振り返りで「外れの原因を整理」を動かすと出ます。';
  assert.equal(heroSay(h({ months: 4, misses: 2, withNotes: 1, scoredMonths: 7 }, { openActions: [{}] })), '大きく外れた月を 2 件観測しました。人の振り返りは 1 件、残っている対応は 1 件です。' + REST);
  assert.equal(heroSay(h({ months: 4, misses: 0, withNotes: 0, scoredMonths: 7 })), '大きく外れた月はありません。予報どおりの空模様が続いています。' + REST);
  asRoles(VIEWER_ROLES, () => assert.equal(heroSay(h({ months: 4, misses: 0, withNotes: 0, scoredMonths: 7 })), '大きく外れた月はありません。予報どおりの空模様が続いています。ほかに のべ 3 か月は、外れの原因が整理されると出ます。'));
  for (const scoredMonths of [4, 2, undefined]) assert.doesNotMatch(heroSay(h({ months: 4, misses: 0, withNotes: 0, scoredMonths })), /ほかに/, '多くなければ添えない: ' + scoredMonths);
  assert.doesNotMatch(heroSay(h({ months: 0, misses: 0, withNotes: 0, scoredMonths: 5 })), /ほかに/, '振り返りの記録が無いときは 8 の文だけ');
}

// ==== 19. 所有者が設定した日 ====
{
  assert.equal(run('fcOwnerSet(__l)', { __l: { note: OWNER_NOTE } }), '2026/10/07');
  assert.equal(run('fcOwnerSet(__l)', { __l: { note: 'auto-learned' } }), '');
  assert.equal(run('fcOwnerSet(null)'), '');
  assert.equal(run(`S.fc.view = __v; fcPaused('LEARN.MONTHLY')`, { __v: planView({ learning: { autoUpdate: false, note: OWNER_NOTE } }) }), '自動の学びを止めています（2026/10/07 所有者が設定）。今は動かしても補正は変わりません。');
}

// ==== 20. 根拠の補正: 出している予測が使った月ごとの補正・今の補正が空 ====
{
  const cal = (applied, factor, monthBias) => {
    const html = run(`S.fc.view = __v; S.fc.basis = __b; fcBasisTab(S.fc.data, __v)`, { __v: planView(), __b: { planId: 'P1', annual: {}, monthly: [], research: [], applied,
      calibration: { factor, aiWeight: null, aiMax: null, monthBias: monthBias || {}, updatedAt: '', quarter: '' } } });
    const m = /<h2>補正<span[\s\S]*?<p class="fc-say" data-tip="([^"]*)">([^<]*)<\/p>/.exec(html);
    return { tip: m[1].split('\n'), say: m[2] };
  };
  // 所有者が戻した直後: 出している予測は 3.0% 下げ・3 月と 4 月も直した。今は補正なし・月ごとの補正なし
  const r = cal({ bias_correction_factor: 0.97, residual_month_bias_json: '{"4":0.05,"3":-0.2}' }, 1, {});
  assert.equal(r.say, '最新の予測は 3.0% 下げています（次の予測から補正なし）');
  assert.deepEqual(r.tip.slice(0, 5), ['最新の予測は 3.0% 下げて計算しました', '最新の予測は月ごとにも直しています: 3 月 20.0% 下げ・4 月 5.0% 上げ', '今の補正: 補正なし（次の予測から効きます）',
    '今の月ごとの補正: なし（次の予測から効きます）', '補正は、実績がまだの月だけに効きます']);
  assert.ok(!r.tip.some((x) => /^月ごとにも直しています/.test(x)), '今の月ごとの補正を、出している予測のことのように言わない');
  // 月ごとの補正が同じなら、今の分は添えない
  const same = cal({ bias_correction_factor: 0.97, residual_month_bias_json: '{"3":-0.2}' }, 1, { 3: -0.2 });
  assert.ok(same.tip.includes('最新の予測は月ごとにも直しています: 3 月 20.0% 下げ'));
  assert.ok(!same.tip.some((x) => /^今の月ごとの補正/.test(x)));
  // 出している予測は月ごとの補正なし・今はある: 今の分だけ（次の予測から）
  const now = cal({ bias_correction_factor: 0.97, residual_month_bias_json: '' }, 1, { 5: 0.1 });
  assert.ok(!now.tip.some((x) => /^最新の予測は月ごとにも/.test(x)));
  assert.ok(now.tip.includes('今の月ごとの補正: 5 月 10.0% 上げ（次の予測から効きます）'));
  // 控えの JSON が壊れていても描ける（月ごとの補正なしとみなす）
  assert.ok(!cal({ bias_correction_factor: 0.97, residual_month_bias_json: '{x' }, 1, {}).tip.some((x) => /月ごと/.test(x)));
  // 今の補正が空（CALIBRATION_STATE の値が空 = 補正なし）: 「100% 下げ」などにせず、補正なしとして比べる
  const empty = cal({ bias_correction_factor: 0.97, residual_month_bias_json: '' }, null, {});
  assert.equal(empty.say, '最新の予測は 3.0% 下げています（次の予測から補正なし）');
  assert.ok(empty.tip.includes('今の補正: 補正なし（次の予測から効きます）'));
  assert.ok(!empty.tip.some((x) => /今の補正: -/.test(x)));
  assert.equal(cal(null, null, {}).say, 'これまでの外れ方による補正は、かけていません');
  assert.equal(cal({ bias_correction_factor: 1 }, null, {}).say, 'これまでの外れ方による補正は、かけていません', '空と 1 は同じ（違うとは言わない）');
  // 倍率が同じでも、月ごとの補正が違えば違うとみなす（出している予測のことを言う。くわしくは 22）
  const keep = cal({ bias_correction_factor: 0.97, residual_month_bias_json: '{"3":-0.1}' }, 0.97, { 3: -0.2 });
  assert.equal(keep.say, '最新の予測は 3.0% 下げ、3 月を 10.0% 下げています（次の予測から 3 月を 20.0% 下げ）');
  assert.deepEqual(keep.tip.slice(0, 3), ['最新の予測は 3.0% 下げて計算しました', '最新の予測は月ごとにも直しています: 3 月 10.0% 下げ', '今の月ごとの補正: 3 月 20.0% 下げ（次の予測から効きます）']);
  // 倍率も月ごとの補正も同じなら、今までどおり今の月ごとの補正
  const same2 = cal({ bias_correction_factor: 0.97, residual_month_bias_json: '{"3":-0.2}' }, 0.97, { 3: -0.2 });
  assert.equal(same2.say, 'これまでの外れ方から 3.0% 下げています');
  assert.equal(same2.tip[0], '月ごとにも直しています: 3 月 20.0% 下げ');
}

// ==== 21. AI の学び（比べた月が無いときの荒れの文）とホームの学びの進み ====
{
  const fy = run('lrFy()');
  const clamp = { planId: 'P1', clientName: 'テスト製薬', fy, key: 'factor_clamp', label: '', value: 0.75 };
  const html = run('lrAiHero(__d)', { __d: { health: [clamp], timeline: [], pending: [{ proposals: [{}] }] } });
  const bubble = /<div class="bubble">([\s\S]*?)<div class="lr-tags/.exec(html)[1];
  assert.equal(bubble, '<span data-tip="補正が限度に張りついていて、外れを補正で追いきれていない状態です。">補正が限度に張りついています（1 メーカー）。'
    + 'まだ実績と比べた月がありません。各計画の振り返りで「当たり具合を計算」を動かすと、外れ幅がここに出ます。承認を待っている見直し案が 1 件あります。</span>');
  // ホームの学びの進み: 見える文はもとから短い印の名前だけ（長い説明はカーソル）
  const home = { fy, plans: [{ planId: 'P1', clientName: 'テスト製薬', fy, mape: null }] };
  const card = run('S.lr.ai = { health: __hl, pending: [] }; homeLearnCard(__h, __h.plans)', { __hl: [clamp], __h: home });
  assert.doesNotMatch(card.replace(/data-tip="[^"]*"/g, ''), /追いきれて|状態です/);
}

// ==== 22. 根拠の補正: 倍率は同じで、月ごとの補正だけが違う（出している予測が使った分を言う） ====
{
  const cal = (applied, factor, monthBias) => {
    const html = run(`S.fc.view = __v; S.fc.basis = __b; fcBasisTab(S.fc.data, __v)`, { __v: planView(), __b: { planId: 'P1', annual: {}, monthly: [], research: [], applied,
      calibration: { factor, aiWeight: null, aiMax: null, monthBias: monthBias || {}, updatedAt: '', quarter: '' } } });
    const m = /<h2>補正<span[\s\S]*?<p class="fc-say" data-tip="([^"]*)">([^<]*)<\/p>/.exec(html);
    return { tip: m[1].split('\n'), say: m[2] };
  };
  const END = '補正は、実績がまだの月だけに効きます';
  // (a) 出している予測は 3 月を下げた・今は補正なし（月ごとの補正を戻した直後）: 見える一文は出している予測のこと、カーソルで出している分 → 今の分
  const a = cal({ bias_correction_factor: 1, residual_month_bias_json: '{"3":-0.2}' }, 1, {});
  assert.equal(a.say, '最新の予測は 3 月を 20.0% 下げています（次の予測から補正なし）');
  assert.deepEqual(a.tip.slice(0, 3), ['最新の予測は月ごとに直しています: 3 月 20.0% 下げ', '今の月ごとの補正: なし（次の予測から効きます）', END]);
  assert.doesNotMatch(a.say, /かけていません/);
  // (b) 出している予測は 20% 上げだけ・今は 3 月も下げる: 今の月ごとの補正を、出している予測のことのように言わない
  const b = cal({ bias_correction_factor: 1.2, residual_month_bias_json: '' }, 1.2, { 3: -0.2 });
  assert.equal(b.say, '最新の予測は 20.0% 上げ、月ごとの補正なしです（次の予測から 3 月を 20.0% 下げ）');
  assert.deepEqual(b.tip.slice(0, 3), ['最新の予測は 20.0% 上げて計算しました', '今の月ごとの補正: 3 月 20.0% 下げ（次の予測から効きます）', END]);
  assert.ok(!b.tip.some((x) => /^月ごとにも直しています/.test(x)));
  // 倍率が同じなら「今の補正」（倍率）の行は出さない（違うものだけ並べる）
  [a, b].forEach((x) => assert.ok(!x.tip.some((l) => /^今の補正:/.test(l))));
  // (c) 出している予測は 20% 上げ・3 月を下げた。今は 3 月の補正なし
  assert.equal(cal({ bias_correction_factor: 1.2, residual_month_bias_json: '{"3":-0.2}' }, 1.2, {}).say, '最新の予測は 20.0% 上げ、3 月を 20.0% 下げています（次の予測から月ごとの補正なし）');
  // (d) 出している予測は補正なし・今は 3 月を下げる
  const d = cal({ bias_correction_factor: 1, residual_month_bias_json: '' }, 1, { 3: -0.2 });
  assert.equal(d.say, '最新の予測は、補正なしです（次の予測から 3 月を 20.0% 下げ）');
  assert.deepEqual(d.tip.slice(0, 2), ['最新の予測は、外れ方の補正なしで計算しました', '今の月ごとの補正: 3 月 20.0% 下げ（次の予測から効きます）']);
  // (e) 月が 2 つまではそのまま、3 つ以上は数だけ（内訳はカーソル）
  assert.equal(cal({ bias_correction_factor: 1, residual_month_bias_json: '{"4":0.05,"3":-0.2}' }, 1, { 3: -0.2 }).say, '最新の予測は 3 月を 20.0% 下げ・4 月を 5.0% 上げています（次の予測から 3 月を 20.0% 下げ）');
  const many = cal({ bias_correction_factor: 1, residual_month_bias_json: '{"1":0.1,"2":0.1,"3":-0.1}' }, 1, {});
  assert.equal(many.say, '最新の予測は 3 か月分を月ごとに直しています（次の予測から補正なし）');
  assert.equal(many.tip[0], '最新の予測は月ごとに直しています: 1 月 10.0% 上げ・2 月 10.0% 上げ・3 月 10.0% 下げ');
  // (f) 0.0% の月は効かないので違いとみなさない。控えに月ごとの欄が無ければ、旧来の計算（parseResidualMonthBiasJson_）と同じく月ごとの補正なし
  assert.equal(cal({ bias_correction_factor: 1, residual_month_bias_json: '{"3":0}' }, 1, {}).say, 'これまでの外れ方による補正は、かけていません');
  const noKey = cal({ bias_correction_factor: 1.2 }, 1.2, { 3: -0.2 });
  assert.equal(noKey.say, '最新の予測は 20.0% 上げ、月ごとの補正なしです（次の予測から 3 月を 20.0% 下げ）');
  assert.ok(!noKey.tip.some((x) => /^月ごとにも直しています/.test(x)));
  assert.equal(cal({ bias_correction_factor: 0.97 }, 0.97, {}).say, 'これまでの外れ方から 3.0% 下げています', '欄が無く、今も月ごとの補正なしなら同じ');
  // (g) 倍率が違う: 倍率の言い方のまま。倍率の無い側に月ごとの補正があれば「補正なし」とは言わない
  const g = cal({ bias_correction_factor: 1, residual_month_bias_json: '{"3":-0.2}' }, 0.98, { 3: -0.2 });
  assert.equal(g.say, '最新の予測は 3 月を 20.0% 下げています（次の予測から 2.0% 下げ）');
  assert.deepEqual(g.tip.slice(0, 3), ['最新の予測は月ごとに直しています: 3 月 20.0% 下げ', '今の補正: 2.0% 下げ（次の予測から効きます）', END]);
  assert.equal(cal({ bias_correction_factor: 0.97, residual_month_bias_json: '' }, 1, { 5: 0.1 }).say, '最新の予測は 3.0% 下げています（次の予測から 5 月を 10.0% 上げ）');
  // (h) 同じで、倍率は無く月ごとだけ直している: 「補正は、かけていません」と言わない
  const h = cal({ bias_correction_factor: 1, residual_month_bias_json: '{"3":-0.2}' }, 1, { 3: -0.2 });
  assert.equal(h.say, 'これまでの外れ方から、3 月を 20.0% 下げています');
  assert.equal(h.tip[0], '月ごとに直しています: 3 月 20.0% 下げ');
  assert.equal(cal(null, 1, { 3: -0.2 }).say, 'これまでの外れ方から、3 月を 20.0% 下げています', '予測の控えが無くても同じ');
}

// ==== 23. 人の学びのまとめ: 外れの原因を整理で出る月（summary.waitingMonths。締め済みの年度の計画は入らない） ====
{
  const h = (summary, more) => hero(Object.assign({ openActions: [], repeats: [], noPreMonth: 0, summary }, more || {}));
  const heroTip = (x) => (/<span data-tip="([^"]*)">/.exec(x) || [])[1];
  const CALM = '大きく外れた月はありません。予報どおりの空模様が続いています。';
  // 振り返りの記録はある・残りの月はどれも締め済みの年度: 動かし方は言わない（説明に 1 行）
  const done = h({ months: 4, misses: 0, withNotes: 0, scoredMonths: 7, waitingMonths: 0 });
  assert.equal(heroSay(done), CALM);
  assert.match(heroTip(done), /\n締め済みの年度の月は、外れの原因を整理しません/);
  // 一部だけ整理で出る: その数だけ言う（動かせない人には「整理されると」）
  assert.equal(heroSay(h({ months: 4, misses: 0, withNotes: 0, scoredMonths: 7, waitingMonths: 1 })), CALM + 'ほかに のべ 1 か月は、各計画の振り返りで「外れの原因を整理」を動かすと出ます。');
  asRoles(VIEWER_ROLES, () => assert.equal(heroSay(h({ months: 4, misses: 0, withNotes: 0, scoredMonths: 7, waitingMonths: 2 })), CALM + 'ほかに のべ 2 か月は、外れの原因が整理されると出ます。'));
  // 比べた月はある・振り返りの記録は無い・整理できる月も無い（締め済みの年度だけ）: 動かし方は言わない
  const fz = h({ months: 0, misses: 0, withNotes: 0, scoredMonths: 5, waitingMonths: 0 });
  assert.equal(heroSay(fz), '実績と比べた月が のべ 5 か月あります（締め済みの年度は、外れの原因を整理しません）。');
  assert.doesNotMatch(fz, /を動かすと|整理されると|大きく外れた月はありません/);
  assert.equal(pose(fz), 'explain');
  asRoles(VIEWER_ROLES, () => assert.doesNotMatch(heroSay(h({ months: 0, scoredMonths: 5, waitingMonths: 0 })), /されると|を動かすと/));
  // 整理できる月があれば今までどおり（比べた月の数と動かし方）
  assert.equal(heroSay(h({ months: 0, misses: 0, withNotes: 0, scoredMonths: 5, waitingMonths: 2 })), '実績と比べた月が のべ 5 か月あります。各計画の振り返りで「外れの原因を整理」を動かすと、大きく外れた月がここに出ます。');
  // waitingMonths を返さないサーバー: 今までどおり（16 の残りの月の数）。締め済みの 1 行も出さない
  const prev = h({ months: 4, misses: 0, withNotes: 0, scoredMonths: 7 });
  assert.equal(heroSay(prev), CALM + 'ほかに のべ 3 か月は、各計画の振り返りで「外れの原因を整理」を動かすと出ます。');
  assert.doesNotMatch(heroTip(prev), /締め済み/);
  // まだ比べた月が無ければ、waitingMonths に関わらず当たり具合を計算から
  assert.equal(heroSay(h({ months: 0, misses: 0, withNotes: 0, scoredMonths: 0, waitingMonths: 0 })), NONE_SAY);
}

// ==== 24. 比べた月がどれも売上 0 円（plans[].scoredMonths があって外れ幅が無い）: ホーム・分析・学び ====
{
  const fy = '2026';
  const ZERO2 = '比べた 2 か月は、どれも売上が 0 円のため、外れ幅を % で出せません。';
  const zp = { planId: 'P1', clientName: 'テスト製薬', fy, mape: null, scoredMonths: 2 };
  const np = { planId: 'P2', clientName: '別の製薬', fy, mape: null, scoredMonths: 0 };
  const kpiTip = (plans) => (/<div class="kpi" data-tip="([^"]*)"><div class="k">外れ幅<\/div>/.exec(run('homeKpis(__h, __h.plans)', { __h: { fy, plans } })) || [])[1];
  // ホームの外れ幅の箱: 「まだ」とも動かし方とも言わない。まだ比べていないメーカーがあれば、その出し方だけ
  assert.ok(kpiTip([zp]).endsWith('\n' + ZERO2), kpiTip([zp]));
  assert.doesNotMatch(kpiTip([zp]), /まだ実績と比べた|当たり具合を計算/);
  assert.ok(kpiTip([zp, np]).endsWith('\n' + ZERO2 + 'ほかのメーカーは、各計画の振り返りで「当たり具合を計算」を動かすと出ます'));
  assert.ok(kpiTip([zp, Object.assign({}, zp, { planId: 'P3', scoredMonths: 3 })]).endsWith('\n比べた のべ 5 か月は、どれも売上が 0 円のため、外れ幅を % で出せません。'), '2 メーカー以上は「のべ」');
  asRoles(VIEWER_ROLES, () => assert.ok(kpiTip([zp, np]).endsWith('ほかのメーカーは、当たり具合が計算されると出ます')));
  // 比べた月の数が無い・外れ幅のあるメーカーがある: 今までどおり
  assert.ok(kpiTip([Object.assign({}, zp, { scoredMonths: undefined })]).endsWith('\nまだ実績と比べたメーカーがありません。各計画の振り返りで「当たり具合を計算」を動かすと出ます'));
  assert.match(kpiTip([zp, Object.assign({}, np, { mape: 0.1, scoredMonths: 3 })]), /（1 メーカー）$/);
  // ホームの精度の天気: 説明と見える短い言い方
  const card = (plans, health) => run('S.lr.ai = { health: __hl, pending: [] }; homeLearnCard(__h, __h.plans)', { __hl: health || [], __h: { fy, plans } });
  const c1 = card([zp]);
  assert.match(c1, new RegExp('data-tip="霧：外れ幅を % で出せる月がまだない\\n' + ZERO2 + '\\n精度の推移は'), '霧の決まりは「比べられる実績がまだない」と言わない（28）');
  assert.doesNotMatch(c1, /比べられる実績がまだない/);
  assert.match(c1, /<span class="t2">売上 0 円の月だけ<\/span>/);
  assert.doesNotMatch(c1, /当たり具合を計算|比べる実績はまだです/);
  assert.match(card([zp, np]), new RegExp('data-tip="霧：外れ幅を % で出せる月がまだない\\n' + ZERO2 + 'ほかのメーカーは、各計画の振り返りで「当たり具合を計算」を動かすと出ます\\n'));
  const clamp = { planId: 'P1', clientName: 'テスト製薬', fy, key: 'factor_clamp', label: '', value: 0.75 };
  const c2 = card([zp], [clamp]);
  assert.match(c2, new RegExp('data-tip="台風：[^"\\n]*\\n' + ZERO2 + '\\n荒れている印'));
  assert.match(c2, /<span class="t2">補正が限度（1 メーカー）<\/span>/);
  assert.match(card([Object.assign({}, zp, { scoredMonths: undefined })]), /<span class="t2">比べる実績はまだです<\/span>/, '比べた月の数が無いサーバーは今までどおり');

  // 分析の案内: 精度（accuracy）の月が無く、比べた月の数がある計画（accuracy.scoredMonths か plans[].scoredMonths）
  const acc0 = { mape: null, bias: null, n: 0, leaks: 0, coverage: null, coverageN: 0 };
  const az = Object.assign({}, AN_PLAN, { accuracy: Object.assign({}, acc0, { scoredMonths: 2 }) });
  assert.equal(anGuide([az]), '外れ幅・読みのクセは出していません。' + ZERO2);
  assert.equal(anGuide([Object.assign({}, AN_PLAN, { accuracy: acc0, scoredMonths: 2 })]), '外れ幅・読みのクセは出していません。' + ZERO2, '計画の一覧の scoredMonths でもよい');
  const an2 = Object.assign({}, AN_PLAN, { planId: 'P2', clientName: '別の製薬' });
  assert.equal(anGuide([az, an2]), 'まだ数字がそろっていないため、外れ幅・読みのクセは出していません。' + ZERO2 + 'ほかのメーカーは、各計画の振り返りで「当たり具合を計算」を動かすと出ます。');
  asRoles(VIEWER_ROLES, () => {
    assert.equal(anGuide([az]), '外れ幅・読みのクセは出していません。' + ZERO2);
    assert.equal(anGuide([az, an2]), 'まだ数字がそろっていないため、外れ幅・読みのクセは出していません。' + ZERO2 + 'ほかのメーカーは、当たり具合が計算されると出ます。');
  });
  // 締め済みの年度: 締め済みのことと、売上 0 円のこと（動かし方は言わない）
  assert.equal(anGuide([Object.assign({}, az, { fy: '2025', frozen: true })], '2025'), '外れ幅・読みのクセはありません（FY2025 は締め済みのため、当たり具合は計算し直しません）。' + ZERO2);
  // 締まった後の予測の月だけ・精度が無い・比べた月の数が無い: 今までどおり（売上 0 円とは言わない）
  const AS_BEFORE = 'まだ数字がそろっていないため、外れ幅・読みのクセは出していません。各計画の振り返りで「当たり具合を計算」を動かすと、ここに出てきます。';
  assert.equal(anGuide([Object.assign({}, AN_PLAN, { accuracy: Object.assign({}, acc0, { leaks: 2, scoredMonths: 2 }) })]), AS_BEFORE);
  assert.equal(anGuide([Object.assign({}, AN_PLAN, { accuracy: null, scoredMonths: 2 })]), AS_BEFORE);
  assert.equal(anGuide([AN_PLAN]), AS_BEFORE);
  // 外れ幅のグラフから除いたメーカーの理由
  const withAcc = Object.assign({}, AN_PLAN, { planId: 'P9', clientName: '当たる製薬', accuracy: { mape: 0.12, bias: 0.04, n: 5, leaks: 0, coverage: 0.8, coverageN: 5 } });
  const mc = run('anMapeCard(__p)', { __p: [withAcc, az, an2] });
  assert.match(mc, /data-tip="数字がそろわないため除いたメーカー\nテスト製薬（比べた月は、どれも売上が 0 円）\n別の製薬（まだ実績と比べられる月がありません）"/);

  // 学び > AI の学び: 今の年度のメーカー（ホームの中身）の比べた月がどれも売上 0 円
  const keepHome = run('B.home');
  const ai = (plans, d) => { run('B.home = __h', { __h: { fy, plans } }); return run('lrAiHero(__d)', { __d: Object.assign({ health: [], timeline: [], pending: [] }, d || {}) }); };
  const bubbleOf = (x) => /<div class="bubble">([\s\S]*?)(?:<div class="lr-tags[\s\S]*?)?<\/div><div class="lr-wx"/.exec(x)[1];   // 気になる点の札は除く
  try {
    const h1 = ai([zp]);
    assert.equal(bubbleOf(h1), ZERO2);
    assert.match(h1, /<span class="v">売上 0 円の月だけ<\/span>/);
    assert.match(h1, new RegExp('data-tip="精度の天気「霧」: 外れ幅を % で出せる月がまだない\\n' + ZERO2 + '\\n荒れている'));
    assert.doesNotMatch(h1, /比べられる実績がまだない/);
    assert.equal(pose(h1), 'explain');
    assert.equal(bubbleOf(ai([zp, np])), ZERO2 + 'ほかのメーカーは、各計画の振り返りで「当たり具合を計算」を動かすと、外れ幅がここに出ます。');
    assert.equal(bubbleOf(ai([zp], { health: [clamp] })), '<span data-tip="補正が限度に張りついていて、外れを補正で追いきれていない状態です。">補正が限度に張りついています（1 メーカー）。' + ZERO2 + '</span>');
    // 全計画の推移に外れ幅があれば、今までどおりそれを出す
    assert.match(bubbleOf(ai([zp], { timeline: [{ ym: '2026/05', n: 2, mape: 0.12, rolling3: 0.12 }] })), /^外れ幅は平均 12\.0%/);
    // 比べた月の数が無いサーバー: 今までどおり
    assert.equal(bubbleOf(ai([Object.assign({}, zp, { scoredMonths: undefined })])), 'まだ実績と比べた月がありません。各計画の振り返りで「当たり具合を計算」を動かすと、外れ幅がここに出ます。');
    // AI の学びが空のときの案内 1 枚も同じ
    run('B.home = __h', { __h: { fy, plans: [zp] } });
    assert.match(run('lrAiView({})'), new RegExp('<div class="bubble">' + ZERO2 + '</div>'));
    run('B.home = __h', { __h: { fy, plans: [zp, np] } });
    assert.match(run('lrAiView({})'), new RegExp('<div class="bubble">' + ZERO2 + 'ほかのメーカーは、各計画の振り返りで「当たり具合を計算」を動かすと、AI が何を学んだか（重み・偏り・外れ幅・補正）がここに出ます。</div>'));
  } finally { run('B.home = __k', { __k: keepHome }); }
}

// ==== 25. ホームの着地の推定: 80% の幅の下の端は 0 円で止める（「-0」・マイナスを出さない。分析の合計と同じ） ====
{
  const rt = (plans) => run('homeRangeTip(homeRange(__p), __p.length)', { __p: plans });
  assert.match(rt([{ landing: 0.3, landingSd: 1 }]), /^80% の幅: 0〜2 円/);
  assert.match(rt([{ landing: 100, landingSd: 1000 }, { landing: 50, landingSd: 10 }]), /^80% の幅: 0〜1,432 円/);
  assert.match(rt([{ landing: 1000, landingSd: 10 }]), /^80% の幅: 987〜1,013 円/, '0 より上は今までどおり');
  assert.equal(run('homeRange(__p).lo', { __p: [{ landing: 0, landingSd: 0 }] }), 0);
  assert.ok(!Object.is(run('homeRange(__p).lo', { __p: [{ landing: 0.2, landingSd: 1 }] }), -0));
  // ホームの着地の推定の箱の説明にも、マイナスの下の端を出さない
  const home = { fy: '2026', plans: [{ planId: 'P1', clientName: 'テスト製薬', fy: '2026', landing: 0.3, landingSd: 1, mape: null }] };
  const k = run('homeKpis(__h, __h.plans)', { __h: home });
  assert.doesNotMatch(k, /80% の幅: -/);
  assert.match(k, /80% の幅: 0〜/);
}

// ==== 26. 学び > AI の学び「着地の幅の学び」: 今の値と学んだ値（試し）を分ける。使っているかは値ごと・見せる丸めで ====
{
  const card = (learned, used) => run('lrLandingCard(__x)', { __x: { learned, used } });
  const notes = (h) => [...h.matchAll(/<p class="note">([^<]*)<\/p>/g)].map((m) => m[1]);
  const cardTip = (h) => (/<h2>着地の幅の学び<span class="tip"[^>]*data-tip="([^"]*)"/.exec(h) || [])[1];
  const L = (o) => Object.assign({ tau: 0.2466, w: 1.4237, tauLearned: true, wLearned: true, planCount: 4, monthCount: 24 }, o);
  const U = (o) => Object.assign({ tau: 0.15, w: 1, tauSet: false, wSet: false, tauFrom: '', wFrom: '' }, o);
  // (a) まだ承認していない: 今の値は決まった値、学んだ値は「承認すると使います」
  const a = card(L(), U());
  assert.deepEqual(notes(a), ['今の値: 年の水準のぶれ 15%・幅の倍率 1 倍（決まった値）', '全計画から学んだ値（試し）: 年の水準のぶれ 24.7%・幅の倍率 1.42 倍（承認すると使います）']);
  assert.match(cardTip(a), /\n今使っている値: 年の水準のぶれ 15%・幅の倍率 1 倍（決まった値）\n/);
  // (b) 所有者が見せた丸めの値（24.7%・1.42 倍）を書いた: 生の値（0.2466・1.4237）と違っても「承認して使っています」
  const b = card(L(), U({ tau: 0.247, w: 1.42, tauSet: true, wSet: true, tauFrom: '2026-10-08', wFrom: '2026-10-08' }));
  assert.deepEqual(notes(b), ['今の値: 年の水準のぶれ 24.7%・幅の倍率 1.42 倍（承認した値）', '全計画から学んだ値（試し）: 年の水準のぶれ 24.7%・幅の倍率 1.42 倍（承認して使っています）']);
  assert.match(cardTip(b), /\n今使っている値: 年の水準のぶれ 24\.7%・幅の倍率 1\.42 倍（所有者が承認 2026\/10\/08 から）\n/);
  // (c) landing.tau だけ書いた: 値ごとに言う（決まった値の幅の倍率を「使っています」と言わない）。承認した日も値ごと
  const c = card(L(), U({ tau: 0.247, tauSet: true, tauFrom: '2026-10-08' }));
  assert.deepEqual(notes(c), ['今の値: 年の水準のぶれ 24.7%（承認した値）・幅の倍率 1 倍（決まった値）',
    '全計画から学んだ値（試し）: 年の水準のぶれ 24.7%（承認して使っています）・幅の倍率 1.42 倍（承認すると使います）']);
  assert.match(cardTip(c), /\n今使っている値: 年の水準のぶれ 24\.7%（所有者が承認 2026\/10\/08 から）・幅の倍率 1 倍（決まった値）\n/);
  // 決まった値と同じ値（1 倍）を学んだ: 承認しても変わらないので「今の値と同じ」
  assert.equal(notes(card(L({ tauLearned: false, w: 1 }), U()))[1], '全計画から学んだ値（試し）: 幅の倍率 1 倍（今の値と同じ）');
  // 違う日に書いた: 日は値ごと
  assert.match(cardTip(card(L(), U({ tau: 0.247, w: 1.42, tauSet: true, wSet: true, tauFrom: '2026-10-08', wFrom: '2026-10-09' }))),
    /今使っている値: 年の水準のぶれ 24\.7%（所有者が承認 2026\/10\/08 から）・幅の倍率 1\.42 倍（所有者が承認 2026\/10\/09 から）/);
  // (d) 書いた値が見せる丸めで違う: 「承認すると使います」。丸めの境（24.74% は 24.7%・24.76% は 24.8%）
  assert.equal(notes(card(L({ wLearned: false }), U({ tau: 0.2, tauSet: true, tauFrom: '2026-10-08' })))[1], '全計画から学んだ値（試し）: 年の水準のぶれ 24.7%（承認すると使います）');
  assert.match(notes(card(L({ wLearned: false }), U({ tau: 0.2474, tauSet: true })))[1], /24\.7%（承認して使っています）$/);
  assert.match(notes(card(L({ wLearned: false }), U({ tau: 0.2476, tauSet: true })))[1], /24\.7%（承認すると使います）$/);
  assert.match(notes(card(L({ tauLearned: false }), U({ w: 1.4249, wSet: true })))[1], /1\.42 倍（承認して使っています）$/);
  // (e) 承認した値はあるが、学べた値が無い: 今の値は出す
  const e = card(L({ tauLearned: false, wLearned: false, planCount: 1, monthCount: 3 }), U({ tau: 0.2, tauSet: true, tauFrom: '2026-10-08' }));
  assert.deepEqual(notes(e), ['今の値: 年の水準のぶれ 20%（承認した値）・幅の倍率 1 倍（決まった値）', '全計画から学んだ値（試し）: まだありません']);
  assert.match(cardTip(e), /今は 1 計画・3 か月/);
  // 学べた値も承認した値も無ければ、カードごと出さない
  assert.equal(card(L({ tauLearned: false, wLearned: false }), U()), '');
  [a, b, c, e].forEach((h) => assert.doesNotMatch(h.replace(/<[^>]*>/g, ' ') + cardTip(h), /τ|\bw\b|tau|undefined|NaN|null/, '中の記号を出さない'));
}

// ==== 27. 予測と予算: 年度合計の説明・年度の見込みの試し・予算に届く見込み・締まった年度 ====
{
  const yms = Array.from({ length: 12 }, (_, i) => { const m = 4 + i; return (m > 12 ? 2027 : 2026) + '/' + String(m > 12 ? m - 12 : m).padStart(2, '0'); });
  const sec = { annual: { p10: 105e6, p50: 115e6, p90: 125e6, adopted: 120e6, uplift: 0, final: 120e6 },
    monthly: yms.map((ym, i) => ({ row: 29 + i, month: ym, p10: 8e6, p50: 1e7, p90: 1.2e7, adopted: 1e7, uplift: '', final: 1e7 })) };
  const latest = { annual_p10: 105e6, annual_p50: 115e6, annual_p90: 125e6, objective_p10: 1e8, objective_p50: 1.1e8, objective_p90: 1.2e8, finished_at: '2026-10-08T10:00:00+09:00', actor_email: OWNER };
  // 届く金額は、0.1 億の丸めでは同じに見える値（1.2 億前後）
  const AMT = [[50, 121234567], [60, 120456789], [70, 119678901], [80, 118765432]];
  const reach = (o) => Object.assign({ center: 121234567, sd: 3e6, p10: 117e6, p90: 125e6, k: 6, actualYtd: 60123456, tau: 0.15, w: 1, tauSet: false, wSet: false,
    amounts: AMT.map(([pct, amount]) => ({ pct, amount })), draft: { budget: 120e6, p: 0.6, pct: 60 }, official: { budget: 118e6, p: 0.7, pct: 70, versionNo: 2 } }, o);
  const aligned = (o) => Object.assign({ center: 120e6, sd: 1e7, p10: 107e6, p90: 133e6, budget: 120e6, pAbove: 0.5, tau: 0.15, w: 1 }, o);
  const tab = (sh, frozen) => {
    const d = { plan: { planId: 'P1', clientName: 'テスト製薬', fy: 2026, frozen: !!frozen }, latest, runs: [], stored: null, shadow: Object.assign({ planId: 'P1' }, sh) };
    const v = { plan: d.plan, can: { plan: true, approve: true, admin: true }, inputHash: 'h', actions: [], boot: { output: { sections: [sec] } } };
    return run(`S.fc.planId = 'P1'; S.fc.view = __v; S.fc.data = __d; S.fc.budget = {}; S.fc.confirm = null; fcForecastTab(__d, __v)`, { __d: d, __v: v });
  };
  const midTip = (h) => (/<div class="kpi main" data-tip="([^"]*)"><div class="k">中心<\/div>/.exec(h) || [])[1].split('\n');
  const meta = (h) => { const m = /<span class="meta" data-tip="([^"]*)">(この予算に[^<]*)<\/span>/.exec(h); return m ? { tip: m[1].split('\n'), say: m[2] } : null; };
  // (a) 見出しの説明: 年度合計の 3 つ（下振れ・中心・上振れ）が月の合計ではない
  const base = tab({ aligned: aligned(), reach: reach() });
  assert.match(tipOf(base, '月ごとの見通しと予算'), /。年度合計（下振れ・中心・上振れ）は月の合計ではなく、年度で計算した値です$/);
  assert.doesNotMatch(uiHtml, /年度合計の下振れ〜上振れは/);
  // (b) 年度の見込みの試し: 「この計画の年度合計」・金額は円まで。aligned.k が無い（前のサーバー）・0 なら幅も
  for (const al of [aligned(), aligned({ k: 0 })]) {
    const t = midTip(tab({ aligned: al, reach: reach() }));
    assert.equal(t[2], 'この計画の年度合計（下振れ・中心・上振れ）は、年度の売上を何度も試して出した値です（月の合計とずれることがあり、幅も狭めに出ます）');
    assert.equal(t[3], '月の合計でそろえると 中心 120,000,000 円・80% の幅 107,000,000 円〜133,000,000 円（試し）');
    assert.match(t[4], /^月ごとの中心を足し、着地見込みと同じ式（締まった月なし・年の水準のぶれ 15%・幅の倍率 1 倍）で幅をつけた試しの値です。/);
  }
  assert.doesNotMatch(midTip(base).join('\n'), /今の年度の|億/);
  // 年度の途中（k > 0。サーバーは幅を null にする）: 幅は着地の推定で見ると言う（その幅は円まで）
  const mid = midTip(tab({ aligned: aligned({ k: 6, p10: null, p90: null }), reach: reach() }));
  assert.equal(mid[3], '月の合計でそろえると 中心 120,000,000 円（試し）');
  assert.equal(mid[4], '月ごとの中心を足した試しの値です。年度の途中の幅は、着地の推定（締まった 6 か月の実績を入れた見込み）の幅で見ます: 80% の幅 117,000,000 円〜125,000,000 円。保存している数字は変わりません');
  assert.equal(midTip(tab({ aligned: aligned({ k: 6 }), reach: reach() }))[3], '月の合計でそろえると 中心 120,000,000 円（試し）', '幅が来ても、締まった月があれば出さない');
  assert.match(midTip(tab({ aligned: aligned({ k: 2, p10: null, p90: null }), reach: null }))[4], /（締まった 2 か月の実績を入れた見込み）の幅で見ます。保存している/, '届く見込みが無ければ幅の金額は添えない');
  assert.match(midTip(tab({ aligned: aligned({ k: 12, done: true, p10: null, p90: null }), reach: reach({ k: 12 }) }))[4], /^月ごとの中心を足した試しの値です。12 か月の実績がそろったので、幅はありません。/);
  // (c) 届く見込みの説明: 中心ではなく「着地の推定」・金額は円まで（50・60・70% の金額が同じに見えない）
  const r = meta(base);
  assert.equal(r.say, 'この予算に届く見込み 約 60%（試し）');
  assert.ok(r.tip.includes('届く見込みが 50% の金額 121,234,567 円・60% の金額 120,456,789 円・70% の金額 119,678,901 円・80% の金額 118,765,432 円'), r.tip.join('\n'));
  assert.ok(r.tip.includes('前提: 着地の推定 121,234,567 円・80% の幅 117,000,000 円〜125,000,000 円・年の水準のぶれ 15%・幅の倍率 1 倍（締まった 6 か月の実績を入れています）'));
  assert.doesNotMatch(r.tip.join('\n'), /億|前提: 中心/);
  // (d) 年度が締まった（reach.done）: 届いたかどうかと実績の合計。届く金額・前提・（試し）は言わない
  const done = meta(tab({ aligned: aligned({ k: 12, done: true, p10: null, p90: null }), reach: reach({ done: true, actual: 121e6, k: 12 }) }));
  assert.equal(done.say, 'この予算に届きました（実績の合計 1.2億円）');
  assert.deepEqual(done.tip, ['今の最終予算 120,000,000 円 に届きました', '実績の合計 121,000,000 円（締まった 12 か月）', '承認済みの公式版（v2）の最終予算 118,000,000 円 には届きました']);
  const miss = meta(tab({ reach: reach({ done: true, actual: 119e6, k: 12 }) }));
  assert.equal(miss.say, 'この予算に届きませんでした（実績の合計 1.2億円）');
  assert.deepEqual(miss.tip.slice(0, 3), ['今の最終予算 120,000,000 円 に届きませんでした', '実績の合計 119,000,000 円（締まった 12 か月）', '承認済みの公式版（v2）の最終予算 118,000,000 円 には届きました']);
  [done, miss].forEach((x) => assert.doesNotMatch(x.say + x.tip.join('\n'), /届く見込み|% の金額|前提|試し/));
  // done が無いサーバー: 12 か月の実績がそろった・締め済みの年度なら同じ（実績の合計は締まった月の合計）
  assert.equal(meta(tab({ reach: reach({ k: 12, actualYtd: 125e6 }) })).say, 'この予算に届きました（実績の合計 1.3億円）');
  // 締め済みの年度でも、12 か月を数えるまでは届く見込みのまま（一部の実績で届いた・届かなかったと言い切らない。2026-10-08 点検）
  assert.equal(meta(tab({ reach: reach() }, true)).say, 'この予算に届く見込み 約 60%（試し）', '締め済みの年度でも 12 か月に足りなければ見込み');
  assert.equal(meta(tab({ reach: reach({ done: false }) }, true)).say, 'この予算に届く見込み 約 60%（試し）', '締め済みの年度で done が false');
  // 締まっていない: 今までどおり見込み（done が false なら 12 か月でも）
  assert.equal(meta(tab({ reach: reach({ done: false, k: 12 }) })).say, 'この予算に届く見込み 約 60%（試し）');
  assert.equal(meta(tab({ reach: reach({ k: 11 }) })).say, 'この予算に届く見込み 約 60%（試し）');
  // 入力中の予算は、保存すると比べ直す
  assert.ok(run('fcReachDoneTip(__r, 1)', { __r: reach({ done: true, actual: 121e6, k: 12 }) }).endsWith('\n入力中の予算は、保存すると比べ直します'));
}

// ==== 28. 比べた月がどれも売上 0 円: 精度の天気の霧の決まり（ホーム・AI の学びの画面での形は 24） ====
{
  assert.equal(run(`accRuleZ('mikakunin', true)`), '外れ幅を % で出せる月がまだない');
  assert.equal(run(`accRuleZ('mikakunin', false)`), '比べられる実績がまだない', '売上 0 円でなければ今までどおり');
  assert.equal(run(`accRuleZ('taifuu', true)`), run(`accRule('taifuu')`), '霧のほかは今までどおり');
  // 外れ幅のあるメーカーがあれば、売上 0 円のメーカーがあっても霧にならない（決まりも今までどおり）
  const fy = '2026', home = { fy, plans: [{ planId: 'P1', clientName: 'テスト製薬', fy, mape: null, scoredMonths: 2 }, { planId: 'P2', clientName: '別の製薬', fy, mape: 0.12, scoredMonths: 3 }] };
  assert.match(run('S.lr.ai = { health: [], pending: [] }; homeLearnCard(__h, __h.plans)', { __h: home }), /data-tip="晴れのち曇り：外れ幅が 10〜15%\n外れ幅の平均 12\.0%（1 メーカー）/);
}

// ==== 29. 根拠「前回の予測からの変化」: 理由は changeCause から（日付は言わない） ====
{
  const basis = (o) => run(`S.fc.planId = 'P1'; S.fc.view = __v; S.fc.basis = __b; fcBasisTab(S.fc.data, __v)`, { __v: planView(), __b: Object.assign({ planId: 'P1', annual: { p50: 1000, prevP50: 900 },
    monthly: [], research: [], applied: null, calibration: null, latestRunAt: '2026-10-08T10:00:00+09:00', prevRunAt: '2026-10-01T10:00:00+09:00', inputChanged: false, between: [] }, o) });
  const H = '前回の予測からの変化', OPS = [{ at: '2026-10-05T10:00:00+09:00', action: 'PLAN.EDIT', actor: OWNER, changed: ['PRODUCT'] }];
  assert.equal(tipOf(basis({ changeCause: 'jitter' }), H), '前の予測は、同じ入力でも実行ごとに少し揺れていました（今の版から、同じ入力なら同じ数字になります）');
  assert.equal(tipOf(basis({ changeCause: 'calendar' }), H), '月が変わったため（締まった月の扱いが変わります）');
  assert.equal(tipOf(basis({ changeCause: 'version' }), H), '計算の版が変わったため');
  // inputs: 操作の一覧（説明なし）。none: 同じ入力（説明なし）
  const inp = basis({ changeCause: 'inputs', inputChanged: true, between: OPS });
  assert.ok(inp.includes('<h2>' + H + '</h2>'));
  assert.match(inp, /<table class="tbl fc-ops">/);
  assert.ok(basis({ changeCause: 'none', annual: { p50: 1000, prevP50: 1000 } }).includes('<h2>' + H + '</h2>'));
  // changeCause が無い・知らない値: 操作が無ければ、日付を言わない一文。操作があれば説明なし（今までどおり）
  const NEUTRAL = 'この間に計画への操作はありません。変化は、月が変わったことや計算の版の違いなどによるものです';
  assert.equal(tipOf(basis({}), H), NEUTRAL);
  assert.equal(tipOf(basis({ changeCause: 'unknown-x' }), H), NEUTRAL);
  // other: 種が同じ（入力・版が同じ）なのに数字が違う。版の違いとは言わない
  assert.equal(tipOf(basis({ changeCause: 'other' }), H), '予測が読む入力と計算の版は同じです（AI の点数の流れを使う設定では、調べ直した直後に数字が変わることがあります）');
  assert.ok(basis({ inputChanged: true, between: OPS }).includes('<h2>' + H + '</h2>'));
  assert.doesNotMatch(uiHtml, /2026\/10\/08 より前の予測/);
}

// ==== 30. 空模様の理由「当たり具合の計算待ち」（skyReason eval_pending） ====
{
  const P = { planId: 'P1', clientName: 'テスト製薬', fy: '2026', sky: 'mikakunin', skyReason: 'eval_pending', landing: null };
  const HOW = '各計画の振り返りで「当たり具合を計算」を動かすと出ます', HOW_V = '当たり具合が計算されると出ます';
  assert.equal(run('skyReasonText(__p)', { __p: P }), '当たり具合の計算待ち');
  assert.match(run(`skyRule('mikakunin')`), /・当たり具合の計算待ち）$/);
  const kpiTip = (h, k) => (new RegExp('<div class="kpi" data-tip="([^"]*)"><div class="k">' + k + '</div>').exec(h) || [])[1];
  const check = (how) => {
    // メーカーの表の空模様・着地の推定のセル
    assert.match(run('skyCell(__p)', { __p: P }), new RegExp('<span class="skycell" data-tip="霧：[^"\\n]*\\n当たり具合の計算待ち\\n' + how + '">'));
    assert.equal(run('mkLanding(__p)', { __p: P }), '<td class="num" data-tip="着地を推定できません（当たり具合の計算待ち）\n' + how + '">-</td>');
    // ホームのよみのセリフ（見える文は短く、出し方は説明に）
    const says = Array.from(run('yomiSays(__h)', { __h: { fy: '2026', plans: [P, Object.assign({}, P, { planId: 'P2', clientName: '別の製薬', skyReason: 'no_budget' })] } }));
    const fog = says.filter((x) => /は霧で/.test(x.text))[0];
    assert.equal(fog.text, '2 メーカーは霧で、着地を推定できません（予算なし 1・当たり具合の計算待ち 1）。');
    assert.ok(fog.tip.endsWith('\n当たり具合の計算待ちは、' + how), fog.tip);
    // 分析: メーカーの札の説明・霧の数
    assert.deepEqual(run('anPlanTip(__p)', { __p: P }).split('\n').slice(0, 3), ['テスト製薬', '霧：当たり具合の計算待ち', how]);
    assert.ok(kpiTip(run('anTotals({ totals: {} }, __ps)', { __ps: [P] }), '霧の数').endsWith('\nテスト製薬（当たり具合の計算待ち）\n当たり具合の計算待ちは、' + how));
  };
  check(HOW);
  asRoles(VIEWER_ROLES, () => check(HOW_V));
  // ほかの理由には出し方を添えない
  const nb = Object.assign({}, P, { skyReason: 'no_budget' });
  assert.equal(run('skyHow(__p)', { __p: nb }), '');
  assert.doesNotMatch(run('skyCell(__p)', { __p: nb }) + run('mkLanding(__p)', { __p: nb }), /を動かすと|計算されると/);
  const one = Array.from(run('yomiSays(__h)', { __h: { fy: '2026', plans: [nb] } })).filter((x) => /は霧で/.test(x.text))[0];
  assert.equal(one.tip, '霧：' + run(`skyRule('mikakunin')`));
}

// ==== エラーの文: 計算用の表の名前は画面の名前に、プログラムの例外と通信の切れは中身を見せず、分かる文に（2026-10-13） ====
{
  const ui = loadUi();
  ui.console = { error() {} };
  const run = (code, extra) => { Object.assign(ui, extra || {}); return vm.runInContext(code, ui); };
  assert.equal(run('plainMsg(__s)', { __s: 'SALES_MONTHLYの月次列が48ヶ月分ありません' }), '「月ごとの売上」の月次列が48ヶ月分ありません');
  assert.equal(run('plainMsg(__s)', { __s: 'CONFIG!B2 にクライアントを設定してください' }), '「計画の設定」 にクライアントを設定してください');
  assert.equal(run('plainMsg(__s)', { __s: 'AI_RESEARCH_STRUCTURED の見出しが違います' }), '「市場の調査（話題ごと）」 の見出しが違います');
  assert.equal(run('plainMsg(__s)', { __s: 'IMPORT.SALES・VERTEX_PROJECT_ID・MY_TABLE はそのまま' }), 'IMPORT.SALES・VERTEX_PROJECT_ID・MY_TABLE はそのまま', '知らない名前は変えない');
  assert.equal(run('plainMsg(__s)', { __s: 'A-2 売上データの取り込みで止まりました' }), '売上を取り込むで止まりました', '旧来の番号は今までどおり');
  assert.match(run('errText(__s)', { __s: "TypeError: Cannot read properties of undefined (reading 'p50')" }), /^思いがけないエラーで止まりました/);
  assert.match(run('errText(__s)', { __s: 'NetworkError: Connection failure due to HTTP 503' }), /^通信が途中で切れました/);
  assert.equal(run('errText(__s)', { __s: 'ほかの処理が終わるまでお待ちください' }), 'ほかの処理が終わるまでお待ちください', 'サーバーの日本語の文はそのまま');
  assert.doesNotMatch(JSON.stringify(run('FC_ACTION_FULL')), /ZAC/, '操作の名前（閲覧の人にも出る）に裏側の名前を出さない');
  // 幅に収まった割合の注意は、サーバー（appInsightHealth_）と同じ決まり: 4 か月以上・80% の確かさの幅が 80% を含まないときだけ
  assert.deepEqual([run('covOff(2, 3)'), run('covOff(0, 3)'), run('covOff(1, 4)'), run('covOff(3, 4)'), run('covOff(12, 12)'), run('covOff(8, 10)')], ['', '', 'low', '', 'high', '']);
  const homeCov = (n, out) => { const c = run('homeInsightCard(__p)', { __p: [{ planId: 'P', clientName: 'A', rangeN: n, rangeOut: out }] }); return (c.match(/幅に収まった割合[\s\S]{0,400}/) || [''])[0]; };
  assert.doesNotMatch(homeCov(3, 1), /狭すぎるよう|広すぎるよう/, '3 か月で 2 か月収まった（67%）だけでは注意にしない（前は 3 か月だと必ず注意だった）');
  assert.match(homeCov(6, 4), /狭すぎるよう/, '6 か月で 2 か月しか収まらなければ注意');
  assert.equal(run('accRough(__a)', { __a: { coverage: 0.25, coverageN: 4 } }), true, '学びの「荒れている」も同じ決まり');
  // 雪（予算があるのに売上が 0 の月）は、着地と予算の比では決めないので「予算を 10% 以上下回る」とは言わない
  const says = (plans) => Array.from(run('yomiSays(__h)', { __h: { fy: '2026', plans } })).map((x) => x.text).join('\n');
  const snowSay = says([{ planId: 'S', clientName: '雪の製薬', fy: '2026', sky: 'sekka', budget: 600, landing: 572 }]);
  assert.match(snowSay, /1 メーカーは、予算があるのに売上が 0 の月があります（雪）/);
  assert.doesNotMatch(snowSay, /10% 以上下回る/);
  assert.match(says([{ planId: 'K', clientName: '曇りの製薬', fy: '2026', sky: 'kumori', budget: 600, landing: 500 }]), /1 メーカーが、予算を 10% 以上下回る見込みです（曇り）/);
  // 元に戻せない承認（公式版の承認・却下、見直し案の承認して反映）は、確かめる画面で「やめる」を先に選んでおく
  run(`globalThis.__asks = []; ask = function(m, l, f, d){ __asks.push([l, !!d]); };
    S.fc.ver = { planId: 'P', pending: { no: 3, versionId: 'V', rowVersion: 1 } }; verDecide('APPROVED');`);
  assert.equal(JSON.stringify(run('__asks')), JSON.stringify([['承認する', true]]));
  assert.match(uiHtml, /ask\(msg, '承認して反映', function\(\)\{[^\n]*\}, true\);/, '承認して反映も「やめる」が先');
}

console.log('app-ui-texts: all tests passed');
