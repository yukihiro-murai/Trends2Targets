/**
 * app-ai.test.mjs — A-4 AI 調査を、本物の旧来の計算（runVertexAIResearch）で、新アプリの問い合わせの道具（Ai.js）を通して動かす。
 * Vertex AI の答えはテストの決まった形。時間の区切りで止めて、組み立て直して終えるところまで。
 */
import assert from 'node:assert/strict';
import { setUpEnv } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const env = setUpEnv();
const months = [];
for (let i = 0; i < 48; i++) months.push(D(2022, 4 + i));
const book = env.makeBook('クライアント別売上予測', {
  CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', 'テスト製薬'], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野'],
    ['VERTEX_PROJECT_ID', 'test-project'], ['VERTEX_LOCATION', 'asia-northeast1'], ['VERTEX_GEMINI_MODEL', 'gemini-test'], ['AI_RESEARCH_ENABLED', 1]] },
  PROCESS_STATUS: { values: [['step_key', 'last_run_date', 'last_run_by', 'status', 'target_client', 'record_count', 'error_summary'],
    ['step1_status', D(2026, 9, 1), 'owner', 'success', 'テスト製薬', 10, '']] },
  PRODUCT: { values: [['Person', 'ProductName', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']] },
  CLIENT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']] },
  OPINIONS: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Confidence(0..1)', 'Note']] },
  DEV_SPOT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Project', 'Amount(JPY)', 'Confidence(0..1)']] },
});
const planId = env.seedPlan(book);

env.run(`(() => {
  globalThis.__calls = [];
  ScriptApp.getOAuthToken = () => 'test-token';
  const gemini = (text) => JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/a', title: 'a' } }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
  globalThis.UrlFetchApp = { fetch: (u, o) => {
    __calls.push(u);
    if (o.headers.Authorization !== 'Bearer test-token') throw new Error('token');
    const body = JSON.parse(o.payload);
    const structured = !!(body.generationConfig && body.generationConfig.responseMimeType);
    return { getResponseCode: () => 200, getContentText: () => gemini(structured ? JSON.stringify({ rows: [] }) : '市場は横ばい。') };
  } };
  appAiDeadline_ = () => 0;
})()`);
const st = env.runJob('PLAN.RUN', { planId, action: 'AI.RESEARCH' });
assert.equal(st.status, 'DONE', st.error);
const calls = env.run('__calls');
assert.equal(calls.length, 8, '4 つの話題 × （調べる・形にする）を 1 回ずつ。同じ問い合わせは 2 度しない');
assert.ok(calls.every((u) => /^https:\/\/asia-northeast1-aiplatform\.googleapis\.com\/v1\/projects\/test-project\//.test(u)));
const calcs = env.audit().filter((a) => a.action === 'PLAN.AI.RESEARCH.CALC' && a.phase === 'END');
assert.equal(calcs.length, 8, '区切りごとに組み立て直して、最後の回で終える');
const ps = Object.fromEntries(env.table('ENG_PROCESS_STATUS').filter((r) => r.plan_id === planId).map((r) => [r.step_key, r]));
assert.equal(ps.step3_status.status, 'success');
assert.match(ps.step3a_status.error_summary, /vertex_rows=4; web_error=0/);
assert.equal(env.table('ENG_AI_RESEARCH_STRUCTURED').filter((r) => r.plan_id === planId).length, 4, '話題ごとの点数をデータ本体に残す（次の予測で使う）');
// 権限が無いなど、全部の問い合わせが失敗したら、失敗の理由をエラーの文に出す（旧来は理由をデータ本体に移さないシートに書くため）
env.run(`(() => { globalThis.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 403,
  getContentText: () => JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Permission denied on resource project test-project.' } }) }) }; appAiDeadline_ = () => Date.now() + 60000; })()`);
const ng = env.runJob('PLAN.RUN', { planId, action: 'AI.RESEARCH' });
assert.equal(ng.status, 'FAILED');
assert.match(ng.error, /Vertex調査に失敗しました/);
assert.match(ng.error, /問い合わせの失敗（\d+ 件）/);
assert.match(ng.error, /gemini-test:generateContent → 403 PERMISSION_DENIED Permission denied on resource project/);
// 一時的な失敗（429・5xx・通信の例外）は、待ってから同じ問い合わせをし直す（2 回まで・区切りを過ぎない範囲）。話題を欠かさずに終える
env.run(`(() => {
  globalThis.__calls = []; globalThis.__waits = []; globalThis.__seen = {};
  const gemini = (text) => JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/a', title: 'a' } }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
  globalThis.UrlFetchApp = { fetch: (u, o) => {
    __calls.push(u);
    const key = u + '|' + o.payload, n = (__seen[key] = (__seen[key] || 0) + 1);
    if (n === 1) return { getResponseCode: () => 429, getContentText: () => JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'busy' } }) };
    if (n === 2 && /generateContent/.test(u) && JSON.parse(o.payload).generationConfig && JSON.parse(o.payload).generationConfig.responseMimeType) throw new Error('Address unavailable');
    const structured = !!(JSON.parse(o.payload).generationConfig && JSON.parse(o.payload).generationConfig.responseMimeType);
    return { getResponseCode: () => 200, getContentText: () => gemini(structured ? JSON.stringify({ rows: [] }) : '市場は横ばい。（し直し）') };
  } };
  appAiWait_ = (ms) => { __waits.push(ms); };
  appAiDeadline_ = (t0) => t0 + 600000;
})()`);
const rt = env.runJob('PLAN.RUN', { planId, action: 'AI.RESEARCH' });
assert.equal(rt.status, 'DONE', rt.error);
const waits = env.run('__waits');
assert.ok(waits.length >= 8 && waits.every((w) => w === 2000 || w === 6000), '429 のたびに 2 秒、続けて失敗したら 6 秒待ってし直す: ' + JSON.stringify(waits));
assert.ok(waits.includes(6000), '通信の例外も一時的な失敗として、もう一度待ってし直す');
assert.equal(env.table('ENG_AI_RESEARCH_STRUCTURED').filter((r) => r.plan_id === planId).length, 4, 'し直して、4 つの話題を欠かさずに残す');
const lastCalc = env.audit().filter((a) => a.action === 'PLAN.AI.RESEARCH.CALC' && a.phase === 'END').pop();
assert.ok(JSON.parse(lastCalc.after_json).aiCalls.retries > 0, 'し直した回数を実行の記録に残す');
// 待つと区切りを過ぎるときは、し直さない（今までどおり失敗の答えを返して先へ進む）
env.run(`(() => { globalThis.__waits = []; globalThis.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 503, getContentText: () => 'unavailable' }) };
  appAiDeadline_ = (t0) => t0 + 1000; })()`);
const late = env.runJob('PLAN.RUN', { planId, action: 'AI.RESEARCH' });
assert.equal(late.status, 'FAILED');
assert.equal(env.run('__waits.length'), 0, '区切りまで 2 秒も無ければ待たない');
console.log('app-ai: all tests passed');
