#!/usr/bin/env node
/**
 * app-ai-manual.test.mjs — A-4 AI 調査の守り: 手で始める A-4 の 1 日の上限と、やり直しの控えの使い回し（提案 23）。2026-10-13 の点検（村井さん承認）。
 * 手で始める A-4 は計画ごとに 1 日 3 回まで（自動の調べは数えない）。6 時間以内に失敗した回を引き継いで控えた答えを使う
 * （前に控えた失敗の答えは使わずに問い合わせ直す）。保存まで終わった回・7 時間前の回は引き継がない
 * 本物の旧来の A-4 を、決まった形の Vertex AI の答えで動かす（共通の道具は ai-stub.mjs）。モックの上の確かめで、本物の Apps Script・Vertex AI の上では動かしていない。
 *
 *   node app/tests/app-ai-manual.test.mjs
 */
import assert from 'node:assert/strict';
import { setUpEnv, OWNER } from './gas-mock.mjs';
import { seed, stubVertex, setAi, research, actions, buildActionIds, nextDay } from './ai-stub.mjs';

const env = setUpEnv();
const FY = env.run('appFy_(new Date())');
stubVertex(env);

// ==== 手で始める A-4 は 1 日 3 回まで。失敗した回を引き継いで控えた答えを使う ====
{
  const p = seed(env, '回数製薬', FY);
  // 1 回目: 市場の Web 検索が権限で失敗（403 は控える答え）→ 市場が欠けて保存しない
  setAi(env, "__ai.fail = { 'web:Market': 403 }; __calls.length = 0;");
  const r1 = research(env, p);
  assert.equal(r1.status, 'FAILED');
  assert.match(r1.error, /^（市場）を調べられませんでした/);
  const asked1 = env.run('__calls.length');
  assert.equal(asked1, 7, '前提: 市場は Web だけ、ほかの話題は Web と形にするの 2 つずつ');
  const [a1] = buildActionIds(env, p);
  // 2 回目（6 時間以内・権限を直した）: 前の回を引き継ぎ、控えた答えを使う。前に控えた 403 は使わずに問い合わせ直す
  setAi(env, '__ai.fail = {}; __calls.length = 0;');
  const r2 = research(env, p);
  assert.equal(r2.status, 'DONE', r2.error);
  assert.deepEqual(env.call('__calls').map((c) => c.kind + ':' + c.topic), ['web:Market', 'struct:Market'], '新しく問い合わせるのは前に失敗した市場だけ');
  assert.equal(buildActionIds(env, p)[1], a1, '同じ回の番号を引き継ぐ');
  assert.deepEqual(actions(env, p).map((r) => r.action_id), [a1], '保存した回の番号も同じ');
  // 3 回目: 前の回は保存まで終わったので、新しい回（同じ問い合わせでも控えを使わずに調べ直す）
  setAi(env, '__calls.length = 0;');
  const r3 = research(env, p);
  assert.equal(r3.status, 'DONE', r3.error);
  assert.equal(env.run('__calls.length'), 8, '新しい回は全部を問い合わせる');
  assert.notEqual(buildActionIds(env, p)[2], a1);
  // 4 回目: 始める前に断る（処理を入れない）
  const jobs = () => Object.keys(env.props).filter((k) => /^APP_JOB_(?!RESULT_)/.test(k)).length;
  const j0 = jobs();
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.RUN', payload: { planId: p, action: 'AI.RESEARCH' } } }),
    /この計画の市場の調査は、今日はもう 3 回始めました。費用がかかるので、手で始めるのは 1 日 3 回までです。明日またお試しください。/);
  assert.equal(jobs(), j0, '処理を入れない');
  // ほかの計画は数えない
  const other = seed(env, '別製薬', FY);
  assert.equal(research(env, other).status, 'DONE');
  // 自動の調べ（opts.auto）は数えない・断らない
  const auto = env.call(`appStartJob_(appJobContext_({ requestedBy: '${OWNER}' }), { kind: 'PLAN.RUN', payload: { planId: __p, action: 'AI.RESEARCH' } }, { auto: true })`, { __p: p });
  assert.match(auto.jobId, /^JOB-/);
  for (let i = 0; i < 60 && env.triggers.some((t) => t.handler === 'triggerRunJob'); i++) env.fireTriggers('triggerRunJob');
  assert.equal(JSON.parse(env.props.APP_AI_MANUAL).counts[p + '|AI.RESEARCH'], 3, '自動の回は数に入らない');
  // 次の日は、また 3 回まで
  nextDay(env);
  assert.equal(research(env, p).status, 'DONE');
  assert.equal(JSON.parse(env.props.APP_AI_MANUAL).counts[p + '|AI.RESEARCH'], 1);

  // 引き継げるのは 6 時間まで・保存まで終わった回は引き継がない
  const start = (prev) => {
    env.call(`appJobPutResult_('AIRUN_' + __p, __v)`, { __p: p, __v: prev });
    return env.call(`appAiRunStart_(__p, ${Date.now()})`, { __p: p });
  };
  const now = Date.now();
  const recent = start({ actionId: 'ACT-RECENT', asOfMs: now - 3600e3 });
  assert.deepEqual([recent.resumed, recent.actionId, recent.asOfMs], [true, 'ACT-RECENT', now - 3600e3], '1 時間前に始めた回は引き継ぐ（時刻も同じ = 問い合わせの中身も同じ）');
  assert.ok(recent.freshAfterMs >= now, '引き継いだ回は、前に控えた失敗の答えを使わない');
  const old = start({ actionId: 'ACT-OLD', asOfMs: now - 7 * 3600e3 });
  assert.deepEqual([old.resumed, old.actionId === 'ACT-OLD', old.freshAfterMs], [false, false, 0], '7 時間前の回は引き継がない（控えた答えも残っていない）');
  assert.equal(env.call(`appJobGetResult_('AIRUN_' + __p).value.actionId`, { __p: p }), old.actionId, '新しい回を控える');
  const done = start({ actionId: actions(env, p)[0].action_id, asOfMs: now - 600e3 });
  assert.equal(done.resumed, false, '保存まで終わった回は引き継がない（調べ直しのたびに同じ答えにしない）');
  // 前に控えた失敗の答え（2xx 以外）: 引き継いだ回では使わない。引き継いだ後に控えた答えは使う
  const fresh = env.call(`(() => {
    const url = 'https://asia-northeast1-aiplatform.googleapis.com/v1/x:generateContent';
    const key = 'AIF_' + appSha256Hex_('ACT-F' + '\\n' + url + '\\n' + '{}').slice(0, 40);
    appJobPutResult_(key, { code: 403, text: 'old', at: ${now} - 1000 });
    let asked = 0;
    const real = UrlFetchApp;
    UrlFetchApp = { fetch: () => { asked++; return { getResponseCode: () => 403, getContentText: () => 'new' }; } };
    try {
      const plain = appAiFetcher_('ACT-F', Date.now() + 60000).fetch(url, { payload: '{}' }).getContentText();
      const resumed = appAiFetcher_('ACT-F', Date.now() + 60000, ${now}).fetch(url, { payload: '{}' }).getContentText();
      const again = appAiFetcher_('ACT-F', Date.now() + 60000, ${now}).fetch(url, { payload: '{}' }).getContentText();
      return { plain: plain, resumed: resumed, again: again, asked: asked };
    } finally { UrlFetchApp = real; }
  })()`);
  assert.deepEqual(fresh, { plain: 'old', resumed: 'new', again: 'new', asked: 1 }, '引き継がない回は控えのまま・引き継いだ回は 1 度だけ問い合わせ直す');
}

console.log('app-ai-manual: all tests passed');
