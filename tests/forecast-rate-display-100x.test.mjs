#!/usr/bin/env node
/*
 * forecast-rate-display-100x.test.mjs — 増減率の画面と計算の食い違いを、今の値のまま固定する。
 * 現状は100倍ずれている。PR2で解析をまとめたら期待値を反転する。
 *
 * 同じセル値を、画面（webParseInputs_ の step = normalizeStepDisplay_）と
 * 予測倍率（readFactorsProduct_ の parseRate_ を、重み 1・信頼度 1 の 1 行で productFactorsMultiplier_ に入れた 1 + step）
 * で読む。本体は直さない。期待値は今動いている値そのもの（直したあとの正しい値ではない）。
 *
 *   ずれている組（1.5・2・0.2%）: 現状は100倍ずれている。PR2で解析をまとめたら期待値を反転する。
 *     1.5 と 2 は、計算が |x| > 1 で百分率、画面が |x| > 2 で比率、と閾値が違う（表示が計算の 100 倍）。
 *     0.2% は 0.5 刻みの丸めで画面が 0% になり、その画面値を保存すると計算は 0 になる（100 倍の閾値とは別）。
 *   一致する組（+10%・10・1.5%・0.5）: 画面の百分率と計算が同じ。PR2 でもこの期待値は反転しない。
 *
 * 新アプリの入力画面も、LegacyEngine.js に包んだ同じ関数を使う（包みが原文と一致することは app/tests/app-engine.test.mjs）。
 * GAS は使わない。シートは Node の中の最小のモック。
 *
 *   node tests/forecast-rate-display-100x.test.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const TEST_NAME = '現状は100倍ずれている。PR2で解析をまとめたら期待値を反転する';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentSrc = await readFile(path.join(root, 'Forecast_Agent.js'), 'utf8');
const webSrc = await readFile(path.join(root, 'Forecast_WebApp.js'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  let depth = 0;
  for (let p = src.indexOf('{', start); p < src.length; p++) {
    if (src[p] === '{') depth++;
    else if (src[p] === '}') { depth--; if (depth === 0) return src.slice(start, p + 1); }
  }
  throw new Error(name + ' not closed');
}

const sheetsDecl = agentSrc.match(/const SHEETS = \{[\s\S]*?\n\};/);
assert.ok(sheetsDecl, 'SHEETS が Forecast_Agent.js にある');
assert.match(webSrc, /const step = \(v\) => normalizeStepDisplay_\(v\);/, '画面の step は normalizeStepDisplay_');
assert.match(agentSrc, /const step = parseRate_\(stepRaw\);/, '予測の step は parseRate_');
assert.match(agentSrc, /const mult = 1 \+ aggStep;/, '製品の予測倍率は 1 + step');

const ctx = vm.createContext({
  TZ: 'Asia/Tokyo',
  Utilities: {
    formatDate: (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'),
  },
});
vm.runInContext([
  sheetsDecl[0],
  extractFunction(agentSrc, 'getDefaultFY_'),
  extractFunction(agentSrc, 'getForecastFYStart_'),
  extractFunction(agentSrc, 'getForecastFYEnd_'),
  extractFunction(agentSrc, 'toDate_'),
  extractFunction(agentSrc, 'parseRate_'),
  extractFunction(agentSrc, 'normalizeStepDisplay_'),
  extractFunction(agentSrc, 'getSourceReliability_'),
  extractFunction(agentSrc, 'readFactorsProduct_'),
  extractFunction(agentSrc, 'readFactorsClient_'),
  extractFunction(agentSrc, 'productFactorsMultiplier_'),
  extractFunction(agentSrc, 'clientFactorsMultiplier_'),
  extractFunction(webSrc, 'webCurrentFy_'),
  extractFunction(webSrc, 'webParseInputs_'),
  `function __book(step, month) {
    const tables = {
      PRODUCT: [['Person', 'ProductName', 'Month', 'Step', 'Reason'], ['鷹野', '製品A', month, step, '理由']],
      CLIENT: [['Person', 'Month', 'Step', 'Reason'], ['鷹野', month, step, '理由']],
      OPINIONS: [['Person', 'Month', 'Step', 'Confidence', 'Note'], ['鷹野', month, step, 1, '補足']],
    };
    return {
      getSheetByName(name) {
        const values = tables[name];
        if (!values) return null;
        return {
          getLastRow: () => values.length,
          getRange(row, col, numRows, numCols) {
            const slice = values.slice(row - 1, row - 1 + numRows).map((r) => {
              const line = r.slice(col - 1, col - 1 + numCols);
              while (line.length < numCols) line.push('');
              return line;
            });
            return { getValues: () => slice, getValue: () => slice[0][0] };
          },
        };
      },
    };
  }`,
].join('\n'), ctx);

/** 画面の「+150%」を、計算と同じ比率（1.5）に戻す。比べるためだけ。 */
function displayAsRate(text) {
  const m = /^([+-]?\d+(?:\.\d+)?)%$/.exec(String(text));
  assert.ok(m, '画面の step は百分率の文字: ' + text);
  return Number(m[1]) / 100;
}

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-12, label + ': ' + actual + ' !== ' + expected);
}

/**
 * 現状の組。display / calc / multiplier は今の画面と今の予測倍率。
 * savedCalc は、画面の step を webSaveInputs と同じく文字にして戻したあとの計算（次回の予測）。
 * flip: true の組は、現状は100倍ずれている。PR2で解析をまとめたら期待値を反転する。
 */
const CASES = [
  { input: 1.5, display: '+150%', calc: 0.015, multiplier: 1.015, savedCalc: 1.5, savedMultiplier: 2.5, flip: true },
  { input: '0.2%', display: '0%', calc: 0.002, multiplier: 1.002, savedCalc: 0, savedMultiplier: 1, flip: true },
  { input: '+10%', display: '+10%', calc: 0.1, multiplier: 1.1, savedCalc: 0.1, savedMultiplier: 1.1, flip: false },
  { input: 10, display: '+10%', calc: 0.1, multiplier: 1.1, savedCalc: 0.1, savedMultiplier: 1.1, flip: false },
  { input: 2, display: '+200%', calc: 0.02, multiplier: 1.02, savedCalc: 2, savedMultiplier: 3, flip: true },
  { input: '1.5%', display: '+1.5%', calc: 0.015, multiplier: 1.015, savedCalc: 0.015, savedMultiplier: 1.015, flip: false },
  { input: 0.5, display: '+50%', calc: 0.5, multiplier: 1.5, savedCalc: 0.5, savedMultiplier: 1.5, flip: false },
];
assert.equal(CASES.length, 7, '入力の組は 7 つ');

const shown = [];
for (const row of CASES) {
  const label = typeof row.input === 'number' ? String(row.input) : JSON.stringify(row.input);
  const note = row.flip ? TEST_NAME : '画面と計算は一致する（PR2 でも反転しない）';
  ctx.__step = row.input;
  const got = vm.runInContext(`(() => {
    const month = new Date(2026, 3, 1);
    const ss = __book(__step, month);
    globalThis.SpreadsheetApp = { getActiveSpreadsheet: () => ss };
    const parsed = webParseInputs_(ss);
    const factors = readFactorsProduct_(2026);
    const weights = new Map([['製品A', 1]]);
    const calc = factors[0].step;
    const multiplier = productFactorsMultiplier_(factors, month, weights);
    const clientMultiplier = clientFactorsMultiplier_(readFactorsClient_(2026), month);
    const saved = __book(String(parsed.product[0].step), month);
    globalThis.SpreadsheetApp = { getActiveSpreadsheet: () => saved };
    const savedFactors = readFactorsProduct_(2026);
    return {
      product: parsed.product[0].step,
      client: parsed.client[0].step,
      opinions: parsed.opinions[0].step,
      calc,
      multiplier,
      clientMultiplier,
      savedCalc: savedFactors[0].step,
      savedMultiplier: productFactorsMultiplier_(savedFactors, month, weights),
    };
  })()`, ctx);

  assert.equal(got.product, row.display, label + ' の画面（webParseInputs_ product.step）。' + note);
  assert.equal(got.client, row.display, label + ' の画面（client）。' + note);
  assert.equal(got.opinions, row.display, label + ' の画面（opinions）。' + note);
  near(got.calc, row.calc, label + ' の計算（parseRate_）。' + note);
  near(got.multiplier, row.multiplier, label + ' の予測倍率（productFactorsMultiplier_）。' + note);
  near(got.clientMultiplier, row.multiplier, label + ' の予測倍率（clientFactorsMultiplier_）。' + note);
  near(got.savedCalc, row.savedCalc, label + ' を画面値のまま保存した次回の計算。' + note);
  near(got.savedMultiplier, row.savedMultiplier, label + ' を画面値のまま保存した次回の予測倍率。' + note);

  const screenRate = displayAsRate(got.product);
  if (row.flip) {
    assert.notEqual(screenRate, got.calc, label + ' は現状、画面と計算が一致しない。' + TEST_NAME);
  } else {
    near(screenRate, got.calc, label + ' は画面の百分率と計算が一致する');
    near(got.savedCalc, got.calc, label + ' は保存しても計算が変わらない');
  }
  shown.push(label + ' → 計算 ' + got.calc + '、画面 ' + got.product + '、予測倍率 ' + got.multiplier);
}

assert.equal(displayAsRate('+150%') / 0.015, 100, '1.5 の画面は計算の 100 倍。' + TEST_NAME);
assert.equal(displayAsRate('+200%') / 0.02, 100, '2 の画面は計算の 100 倍。' + TEST_NAME);
assert.equal(displayAsRate('0%'), 0, '0.2% の画面は 0%。' + TEST_NAME);

console.log(TEST_NAME);
shown.forEach((line) => console.log('  ' + line));
console.log('forecast-rate-display-100x: all tests passed');
