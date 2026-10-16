#!/usr/bin/env node
/*
 * app-ui-accuracy.test.mjs — 外れの測り方と補正の見せ方の画面の言葉（2026-10-13 村井さん承認。UI.html の script を vm で読む）。
 *   2. 偏りの縮め（AI の学び）: 偏りは今の補正を外した予測で測ったと言い、倍率は今の補正の代わりに掛ける値（重ねて掛けない）と言う。
 *      寄せると の外れ幅は、倍率を決めたのと同じ月で測るので良く見えやすいと断る
 *   5. 比べた月が 3 か月より少ないうちは、精度の天気を決めず（霧）「比べた月がまだ N か月」と言い、強気・弱気も言わない
 *      （振り返り・ホーム・AI の学び・分析）。読みのクセはどの画面も合計の比（予測の合計 ÷ 実績の合計 − 1。計画の画面は新しい月ほど重く）
 * モックの上の確かめで、本物の Apps Script・ブラウザの上では動かしていない。
 *
 *   node app/tests/app-ui-accuracy.test.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { uiHtml, OWNER, repoRoot } from './gas-mock.mjs';

/** 画面（UI.html の script）を vm で読み込む（app-ui-texts と同じ読み方。よみの絵は、どの姿か分かる印にする） */
function loadUi() {
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: (t, k) => "<i data-pose=\\"" + String(k) + "\\"></i>" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [{ role: 'ADMIN', scopeType: 'ALL' }] }, setUp: true, allowed: true }));
  const el = () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
  const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, confirm: () => false,
    window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  return ui;
}
const ui = loadUi();
const run = (code, vars) => { Object.assign(ui, vars || {}); return vm.runInContext(code, ui); };
/** HTML の data-tip の中身（&quot; などを戻す） */
const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const tips = (html) => Array.from(String(html).matchAll(/data-tip="([^"]*)"/g)).map((m) => unesc(m[1]));
const text = (html) => unesc(String(html).replace(/<[^>]*>/g, ' '));

// ==== 2. 偏りの縮め: 補正を外した予測の偏り・今の補正の代わりの倍率・寄せると は良く見えやすい ====
{
  const sh = { mu: 0.17, tau: 0.05, tau2: 0.0025, pooled: true, plans: [
    { planId: 'A', clientName: '甲製薬', fy: '2026', n: 3, bias: 0.251, biasNow: 0.001, corrected: 3, se: 0.007, shrunk: 0.2508, factorShadow: 0.8, factorNow: 0.8, mapeNow: 0.0083, mapeShadow: 0.0082 },
    { planId: 'B', clientName: '乙製薬', fy: '2026', n: 3, bias: 0.1, biasNow: 0.1, corrected: 0, se: 0.006, shrunk: 0.1002, factorShadow: 0.909, factorNow: null, mapeNow: 0.1, mapeShadow: 0.0002 }] };
  const html = run(`S.cv.lrShrink = 'chart'; lrShrinkCard(__sh)`, { __sh: sh }) + run(`S.cv.lrShrink = 'table'; lrShrinkCard(__sh)`, { __sh: sh });   // グラフと表で見る
  const all = tips(html).join('\n');
  assert.match(all, /今の補正を外した予測で測ります/, 'カードの説明: 偏りは補正を外した予測で');
  assert.match(all, /甲製薬\n補正を外した予測の偏り \+25\.1% → 全体に寄せた偏り \+25\.1%\n3 か月は、そのとき掛けていた補正を外して測りました（補正を掛けた今の予測の偏りは \+0\.1%）/);
  assert.match(all, /補正を外した予測から学んだ倍率 0\.800（今の補正 0\.800 の代わりに掛ける値。今の補正に重ねて掛けるものではありません）/, '今の補正と並べても「補正を外せ」と読めない');
  assert.match(all, /外れ幅 今 0\.8% → 寄せると 0\.8%（倍率を決めたのと同じ月で測るので、良く見えやすい値です）/);
  assert.match(all, /倍率を決めたのと同じ月で測るので、実際より良く見えやすい値です/, '寄せる の見出しの説明');
  assert.match(all, /補正を外した予測から学んだ倍率 0\.909（今の補正の代わりに掛ける値）/, '今の補正が分からない計画');
  assert.doesNotMatch(all, /乙製薬\n[^\n]*\n\d+ か月は、そのとき掛けていた補正/, '割り戻していない計画は言わない');
  assert.doesNotMatch(html, /undefined|NaN/);
}

// ==== 5. 1〜2 か月だけで精度の天気と強気・弱気を言い切らない。読みのクセはどの画面も合計の比（提案 11） ====
{
  // 下限は旧来の B-5 が補正を学ぶ最低の月数と同じ
  const src = await readFile(path.join(repoRoot, 'Forecast_Agent.js'), 'utf8');
  assert.equal(run('ACC_MIN_MONTHS'), Number(/^const AUTOLEARN_MIN_EVAL_MONTHS = (\d+);/m.exec(src)[1]));
  assert.deepEqual([0, 1, 2, 3, null, undefined].map((n) => run('accFew(__n)', { __n: n })), [false, true, true, false, false, false]);

  // 振り返りの精度の天気: 1 か月だけ（外れ 50%・+100%）は霧にして「比べた月がまだ 1 か月」。強気とは言わない
  const acc = (o) => Object.assign({ months: [], n: 1, leaks: 0, mape: 0.5, bias: 1, coverage: 0, coverageN: 1, trend: null }, o);
  const one = run('fcRvWeather(__a)', { __a: acc() });
  assert.match(one, /aria-label="霧"/);
  assert.ok(tips(one).includes('比べた月がまだ 1 か月（精度の天気と強気・弱気は 3 か月から決めます）'), '霧の決まりの代わり');
  assert.match(text(one), /読みのクセ\s+まだ\s*1 か月/);
  assert.doesNotMatch(text(one), /強気|弱気|台風/);
  assert.ok(tips(one).some((t) => /^比べた月がまだ 1 か月です。強気・弱気は 3 か月から言います（今は \+100\.0%）\n読みのクセ = 予測の中心の合計 ÷ 実績の合計 − 1/.test(t)));
  // 3 か月あれば、今までどおり決める
  const three = run('fcRvWeather(__a)', { __a: acc({ n: 3, mape: 0.12, bias: 0.05, coverageN: 3 }) });
  assert.match(three, /aria-label="晴れのち曇り"/);
  assert.match(text(three), /読みのクセ\s+強気\s*\+5\.0%/);
  // 月の数が分からない（0 か月の形）ときは今までどおり
  assert.match(run('fcRvWeather(__a)', { __a: acc({ n: 0, mape: 0.12 }) }), /aria-label="晴れのち曇り"/);

  // 読みのクセの定義をそろえる: 実績 50・150・100、予測 100・100・100（3 か月）
  //   計画の画面（サーバーの偏り）= Σw(予測 − 実績) ÷ Σw|実績|（新しい月ほど重い）、ホーム = 予測の合計 ÷ 実績の合計 − 1
  const w = [Math.pow(0.5, 2 / 4), Math.pow(0.5, 1 / 4), 1], a3 = [50, 150, 100];
  const planBias = w.reduce((s, x, i) => s + x * (100 - a3[i]), 0) / w.reduce((s, x, i) => s + x * a3[i], 0);
  const oldBias = w.reduce((s, x, i) => s + x * (100 - a3[i]) / a3[i], 0) / w.reduce((s, x) => s + x, 0);
  assert.ok(Math.abs(planBias) < 0.03 && oldBias > 0.15, `計画の画面: 前の月ごとの外れの平均は ${oldBias}（強気）、合計の比は ${planBias}（釣り合い）`);
  assert.match(text(run('fcRvWeather(__a)', { __a: acc({ n: 3, mape: 100 / 300, bias: planBias, coverageN: 3 }) })), /読みのクセ\s+釣り合い/);
  const home = (plans) => run('homeInsightCard(__p)', { __p: plans });
  const h3 = home([{ planId: 'P', clientName: 'A', forecastYtd: 300, actualYtd: 300, actualMonths: 3 }]);
  assert.match(text(h3), /読みのクセ\s+予測と実績は、ほぼ釣り合っています/);
  assert.ok(tips(h3).some((t) => t.includes('（予測の合計 ÷ 実績の合計 − 1）') && t.includes('計画の画面の読みのクセも同じ合計の比です')));
  // ホームも 1〜2 か月では強気・弱気を言わない（前は 2 か月でも「強気」と言った）
  const h2 = home([{ planId: 'P', clientName: 'A', forecastYtd: 300, actualYtd: 200, actualMonths: 2 }]);
  assert.match(text(h2), /読みのクセ\s+比べた月がまだ 2 か月です。強気・弱気は 3 か月から言います/);
  assert.doesNotMatch(text(h2), /強気です|弱気です/);
  assert.match(text(home([{ planId: 'P', clientName: 'A', forecastYtd: 300, actualYtd: 200, actualMonths: 3 }])), /予測は実績より 50\.0% 強気です/);

  // ホームの精度の天気: 比べた月が 3 か月より少ないメーカーは入れない。どれも少なければ霧で「比べた月がまだ N か月」
  const fy = '2026';
  const card = (plans) => run('S.lr.ai = { health: [], pending: [] }; homeLearnCard(__h, __h.plans)', { __h: { fy, plans } });
  const c1 = card([{ planId: 'P1', clientName: '甲', fy, mape: 0.5, mapeMonths: 1 }, { planId: 'P2', clientName: '乙', fy, mape: 0.08, mapeMonths: 2 }]);
  assert.match(c1, /aria-label="霧"/);
  assert.match(c1, /<span class="t2">比べた月がまだ 2 か月<\/span>/);
  assert.ok(tips(c1).some((t) => t.startsWith('霧：比べた月がまだ 2 か月（精度の天気と強気・弱気は 3 か月から決めます）\n比べた月が 3 か月以上のメーカーがまだありません')));
  const c2 = card([{ planId: 'P1', clientName: '甲', fy, mape: 0.5, mapeMonths: 1 }, { planId: 'P2', clientName: '乙', fy, mape: 0.12, mapeMonths: 4 }]);
  assert.match(c2, /aria-label="晴れのち曇り"/, '1 か月の 50% は入れない（入れると雨）');
  assert.match(c2, /<span class="t2">外れ幅 12\.0%<\/span>/);
  assert.ok(tips(c2).some((t) => t.includes('外れ幅の平均 12.0%（1 メーカー。比べた月が 3 か月より少ない 1 メーカーは入れていません）')));
  assert.match(card([{ planId: 'P2', clientName: '乙', fy, mape: 0.12 }]), /aria-label="晴れのち曇り"/, '月の数を返さないサーバーは今までどおり');

  // AI の学びの精度の天気も同じ（ホームの中身から）
  const keepHome = run('B.home');
  try {
    run('B.home = __h', { __h: { fy, plans: [{ planId: 'P1', clientName: '甲', fy, mape: 0.5, mapeMonths: 1 }] } });
    const hero = run('lrAiHero(__d)', { __d: { health: [], timeline: [], pending: [] } });
    assert.match(hero, /<span class="nm">霧<\/span><span class="v">比べた月がまだ 1 か月<\/span>/);
    assert.match(hero, /<div class="bubble">比べた月がまだ 1 か月です。精度の天気は 3 か月から決めます。<\/div>/);
    assert.ok(tips(hero).some((t) => t.startsWith('精度の天気「霧」: 比べた月がまだ 1 か月（精度の天気と強気・弱気は 3 か月から決めます）')));
    // ホームの中身に外れ幅が無く、全計画の推移の直近 3 か月が のべ 2 か月だけ
    run('B.home = __h', { __h: { fy, plans: [] } });
    assert.match(run('lrAiHero(__d)', { __d: { health: [], timeline: [{ ym: '2026/05', n: 2, mape: 0.4, rolling3: 0.4, rolling3N: 2 }], pending: [] } }), /<span class="v">比べた月がまだ 2 か月<\/span>/);
    assert.match(run('lrAiHero(__d)', { __d: { health: [], timeline: [{ ym: '2026/05', n: 3, mape: 0.12, rolling3: 0.12, rolling3N: 3 }], pending: [] } }), /外れ幅は平均 12\.0%、精度の天気は「晴れのち曇り」です。/);
  } finally { run('B.home = __h', { __h: keepHome }); }

  // 分析: 比べた月が少ないメーカーは、天気は霧・向きは「まだ」
  const pl = (id, name, a) => ({ planId: id, clientName: name, fy, accuracy: Object.assign({ leaks: 0, coverage: null, coverageN: 0 }, a) });
  const plans = [pl('P1', '甲製薬', { mape: 0.6, bias: 0.6, n: 1 }), pl('P2', '乙製薬', { mape: 0.12, bias: -0.08, n: 5 })];
  const mape = run(`S.cv['an.mape'] = 'table'; anMapeCard(__p)`, { __p: plans });
  assert.match(mape, /<td data-tip="霧：比べた月がまだ 1 か月（精度の天気と強気・弱気は 3 か月から決めます）"><span class="anwx"><span class="skych"[^>]*><\/span>霧<\/span><\/td><td class="num">1 か月<\/td>/);
  assert.match(mape, /<span class="anwx"><span class="skych"[^>]*><\/span>晴れのち曇り<\/span>/);
  assert.ok(tips(mape).includes('締まった月の、予測の中心と実績の差（向きは問わない）の合計 ÷ 実績の合計'));
  const bias = run(`S.cv['an.bias'] = 'table'; anBiasCard(__p)`, { __p: plans });
  assert.match(bias, /<td class="num">\+60\.0%<\/td><td data-tip="比べた月がまだ 1 か月（強気・弱気は 3 か月から言います）">まだ<\/td>/);
  assert.match(bias, /<td class="num">-8\.0%<\/td><td>弱気<\/td>/);
  assert.ok(tips(bias).some((t) => t.startsWith('プラス = 強気')));
  for (const h of [one, three, h2, h3, c1, c2, mape, bias]) assert.doesNotMatch(h, /undefined|NaN/);
}

console.log('app-ui-accuracy: all tests passed');
