#!/usr/bin/env node
/**
 * app-ai-partial.test.mjs — A-4 AI 調査の守り: 問い合わせが失敗して話題が欠けたら保存しない（提案 5）。2026-10-13 の点検（村井さん承認）。
 * 時間の区切りで止まっていないのに問い合わせが失敗し、4 つの話題のどれかが欠けたら保存しない（前の結果を残す）。
 * 失敗が無い欠け（答えが読めない）は今までどおり残った話題で書き直す
 * 本物の旧来の A-4 を、決まった形の Vertex AI の答えで動かす（共通の道具は ai-stub.mjs）。モックの上の確かめで、本物の Apps Script・Vertex AI の上では動かしていない。
 *
 *   node app/tests/app-ai-partial.test.mjs
 */
import assert from 'node:assert/strict';
import { setUpEnv } from './gas-mock.mjs';
import { seed, stubVertex, setAi, research, structured, step3a, actions, TOPICS } from './ai-stub.mjs';

const env = setUpEnv();
const FY = env.run('appFy_(new Date())');
stubVertex(env);

// ==== 問い合わせが失敗して話題が欠けたら保存しない（前の結果を残す） ====
{
  const p = seed(env, '欠け製薬', FY);
  assert.equal(research(env, p).status, 'DONE');
  const before = JSON.stringify(structured(env, p));
  assert.deepEqual([...new Set(structured(env, p).map((r) => r.topic))].sort(), TOPICS.slice().sort());
  // DX を形にする問い合わせが 2 回し直しても失敗（Google 側の 503）: 旧来の計算は DX を「中立」にして 3 つの話題で書き直す → 保存しない
  setAi(env, "__ai.fail = { 'struct:DX': 503 };");
  const ng = research(env, p);
  assert.equal(ng.status, 'FAILED');
  assert.match(ng.error, /^（DX）を調べられませんでした。前の結果を残しました。少し待ってから、もう一度調べてください。\n問い合わせの失敗（1 件）:\n.*gemini-test:generateContent → 503 UNAVAILABLE test$/);
  assert.equal(JSON.stringify(structured(env, p)), before, '前の結果（4 つの話題）を残す');
  assert.equal(actions(env, p).length, 1, '実行の記録も足さない');

  // 2 つの話題が欠けた（前の結果が無い計画）: 欠けた話題をふつうの名前で並べる。何も書かない
  const p2 = seed(env, '欠け二製薬', FY);
  setAi(env, "__ai.fail = { 'struct:DX': 503, 'web:Market': 500 };");
  const ng2 = research(env, p2);
  assert.equal(ng2.status, 'FAILED');
  assert.match(ng2.error, /^（市場・DX）を調べられませんでした。前の結果を残しました。/);
  assert.deepEqual(structured(env, p2), [], '何も書かない');

  // 問い合わせの失敗が無い欠け（答えが 2 回とも読めない）は、今までどおり残った話題で書き直す（中立の印は旧来の記録に残る）
  const p3 = seed(env, '読めない製薬', FY);
  setAi(env, "__ai.fail = {}; __ai.broken = { DX: true };");
  const st3 = research(env, p3);
  assert.equal(st3.status, 'DONE', st3.error);
  assert.deepEqual([...new Set(structured(env, p3).map((r) => r.topic))].sort(), ['Channel', 'Competitor', 'Market']);
  assert.match(step3a(env, p3).error_summary, /neutral_topics=\[DX\]/);
  setAi(env, '__ai.broken = {};');
}

console.log('app-ai-partial: all tests passed');
