#!/usr/bin/env node
/**
 * app-ai-unsourced.test.mjs — A-4 AI 調査の守り: 出典の無い主張を数字に効かせない（提案 4）。2026-10-13 の点検（村井さん承認）。
 * 出典（Web の根拠の URL）が 0 件の話題・Web 検索が失敗した話題の出来事（event 行）は、予測に効かせない（向き 横ばい・強さ 0・
 * 確からしさ 0・点数 0。根拠の文の頭に断りと AI の元の見立て）。比べ（benchmark 行）も購入レポートの材料が無ければ効かせない。
 * プロンプトは、出典が無ければ「中立・0」と書ける形。旧来の要約の画面の点数（readAIResearchScores_）で、効きが 0 になることを確かめる
 * 本物の旧来の A-4 を、決まった形の Vertex AI の答えで動かす（共通の道具は ai-stub.mjs）。モックの上の確かめで、本物の Apps Script・Vertex AI の上では動かしていない。
 *
 *   node app/tests/app-ai-unsourced.test.mjs
 */
import assert from 'node:assert/strict';
import { setUpEnv } from './gas-mock.mjs';
import { seed, stubVertex, setAi, research, structured, rowOf, finalScores, step3a, TOPICS } from './ai-stub.mjs';

const env = setUpEnv();
const FY = env.run('appFy_(new Date())');
stubVertex(env);

// ==== 出典の無い主張を数字に効かせない ====
{
  const p = seed(env, '出典製薬', FY);
  // 出典があるとき（比べ）: 出来事が効く。購入レポートの設定が無いので、比べの行は効かせない
  const ok = research(env, p);
  assert.equal(ok.status, 'DONE', ok.error);
  const s1 = finalScores(env, p);
  assert.deepEqual(TOPICS.map((t) => s1[t]), [16, 16, 16, 16], '出典があれば出来事が効く（強さ 80・確からしさ 0.8 → 32、出来事だけなので半分）: ' + JSON.stringify(s1));
  const rows1 = structured(env, p);
  const ev1 = rowOf(rows1, 'Market', 'event');
  assert.deepEqual([ev1.direction, ev1.impact_score, ev1.confidence, ev1.event_score], ['up', 80, 0.8, 32]);
  const bm1 = rowOf(rows1, 'Market', 'benchmark');
  assert.ok(bm1, '比べの行も残す');
  assert.deepEqual([bm1.relative_percentile, bm1.relative_confidence, bm1.benchmark_score, bm1.relative_position_label], ['', 0, 0, ''], '購入レポートの材料が無い比べは効かせない');
  assert.ok(bm1.evidence.startsWith('出典が見つからなかったため、予測には効かせていません（AI の見立て: 相対位置 70）。 比べの根拠'), bm1.evidence);
  assert.doesNotMatch(step3a(env, p).error_summary, /unsourced_topics/, '出典があれば印を書かない');

  // 出典が 0 件の回: 4 つの話題とも出来事を効かせない（前は 4 話題とも 32 で、合計 64 × 0.0008 で AI の効きの上限 +5% に届いた）
  setAi(env, '__ai.cite = false; __calls.length = 0;');
  const st = research(env, p);
  assert.equal(st.status, 'DONE', st.error);
  const s2 = finalScores(env, p);
  assert.deepEqual(TOPICS.map((t) => s2[t]), [0, 0, 0, 0], '出典が無ければ点数は 0: ' + JSON.stringify(s2));
  const rows2 = structured(env, p);
  TOPICS.forEach((t) => {
    const ev = rowOf(rows2, t, 'event');
    assert.deepEqual([ev.direction, ev.impact_score, ev.confidence, ev.event_score], ['neutral', 0, 0, 0], t + ': 向き 横ばい・強さ 0・確からしさ 0・点数 0');
    assert.equal(ev.evidence, '出典が見つからなかったため、予測には効かせていません（AI の見立て: 上向き・強さ 80）。 需要が伸びている', '画面の根拠の欄で、効かせていないことと AI の元の見立てが分かる');
    assert.equal(ev.time_horizon, '6M', 'ほかの列はそのまま');
  });
  assert.match(step3a(env, p).error_summary, /; unsourced_topics=\[Market,Competitor,Channel,DX\]$/, '効かせなかった話題を記録に残す');
  // AI 調査の記録（版 10）にも、効かせなかった形で残る
  const log = env.table('AI_RESEARCH_LOG').filter((r) => r.plan_id === p && r.row_type === 'event').slice(-4);
  assert.ok(log.every((r) => r.direction === 'neutral' && Number(r.event_score) === 0 && Number(r.confidence) === 0), JSON.stringify(log.map((r) => [r.direction, r.event_score])));
  // プロンプト: 出典が無ければ「中立・0」と書ける
  const calls = env.run('__calls');
  const web = calls.find((c) => c.kind === 'web');
  assert.match(web.body, /根拠となるWeb情報（URL）が見つからない場合は、向きは「中立」、影響の強さは 0 とし/);
  assert.doesNotMatch(web.body, /観測できた範囲で必ず向き/, '「必ず向きを述べよ」は外した');
  const struct = calls.find((c) => c.kind === 'struct');
  assert.match(struct.body, /【重要・出典が無いとき】Web検索結果が空、または Web citations が 0 件のときは、web の direction=neutral・impact_score=0・confidence=0/);
  assert.match(struct.body, /Web検索結果が空か Web citations が 0 件なら direction=neutral・impact_score=0・confidence=0/);
  assert.doesNotMatch(struct.body, /event行は必ず向きを評価/);

  // Web 検索が失敗した話題（DX）: 出来事は効かせず、購入レポートの材料がある比べは効かせる。ほかの話題はそのまま。話題は欠けないので保存する
  const q = seed(env, '検索製薬', FY, { rag: true });
  setAi(env, "__ai.cite = true; __ai.fail = { 'web:DX': 503 }; __calls.length = 0;");
  const rq = research(env, q);
  assert.equal(rq.status, 'DONE', rq.error);
  assert.ok(env.run('__calls').some((c) => c.kind === 'rag'), '前提: 購入レポートにも問い合わせた');
  const rowsQ = structured(env, q);
  const dxEv = rowOf(rowsQ, 'DX', 'event');
  assert.deepEqual([dxEv.direction, dxEv.confidence, dxEv.event_score], ['neutral', 0, 0], 'Web 検索が失敗した話題の出来事は効かせない');
  const dxBm = rowOf(rowsQ, 'DX', 'benchmark');
  assert.deepEqual([dxBm.relative_percentile, dxBm.relative_confidence, dxBm.benchmark_score], [70, 0.6, 9], '購入レポートの材料がある比べは効かせる');
  assert.equal(rowOf(rowsQ, 'Market', 'event').event_score, 32, 'ほかの話題の出来事は今までどおり');
  const sQ = finalScores(env, q);
  assert.equal(sQ.DX, 9, 'DX は比べだけで決まる: ' + JSON.stringify(sQ));
  assert.ok(sQ.Market > 9, '出来事と比べの両方が効く話題');
  assert.match(step3a(env, q).error_summary, /web_error=1;.*unsourced_topics=\[DX\]/);
  setAi(env, '__ai.fail = {};');
}

console.log('app-ai-unsourced: all tests passed');
