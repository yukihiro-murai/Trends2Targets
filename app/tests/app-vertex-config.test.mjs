#!/usr/bin/env node
/**
 * app-vertex-config.test.mjs — A-4 AI 調査の守り: AI 調査の問い合わせ先を全計画まとめて替える（提案 25）。2026-10-13 の点検（村井さん承認）。
 * 所有者の vertexConfigPreview・setVertexConfig（OwnerTask.js・Ai.js）: 計画ごとの今の値を見る・全計画の CONFIG の Vertex の行を
 * まとめて書き換える（締めた年度は名指しなら断る・省けば飛ばす・形の違う値は止める・同じ頼みは書かない・監査に前と後の値）。
 * 書いた後の A-4 は新しい問い合わせ先に問い合わせる
 * 本物の旧来の A-4 を、決まった形の Vertex AI の答えで動かす（共通の道具は ai-stub.mjs）。モックの上の確かめで、本物の Apps Script・Vertex AI の上では動かしていない。
 *
 *   node app/tests/app-vertex-config.test.mjs
 */
import assert from 'node:assert/strict';
import { setUpEnv, OWNER } from './gas-mock.mjs';
import { seed, stubVertex, setAi, research } from './ai-stub.mjs';

// ==== 所有者が全計画の問い合わせ先（Vertex のモデル名・リージョン・プロジェクト）をまとめて替える ====
{
  const e = setUpEnv();
  stubVertex(e);
  const fy = e.run('appFy_(new Date())');
  const pA = seed(e, '甲製薬', fy);
  const pB = seed(e, '乙製薬', fy + 1);
  const pC = seed(e, '丙製薬', fy - 1);
  e.run(`appWithLock_(() => appInsertRows_('YEAR_CLOSURES', [{ fy: __fy, state: 'CLOSED', file_id: 'FILE-TEST', snapshot_sha256: __h,
    plan_count: 1, row_count: 1, bytes: 1, closed_at: appNowIso_(), closed_by: '${OWNER}' }]))`, { __fy: String(fy - 1), __h: 'a'.repeat(64) });
  const task = (t) => { e.props.OWNER_TASK = JSON.stringify(t); return e.call('apiOwnerTask()'); };
  const vertexOf = (p) => e.call(`appVertexConfigOf_(appEngLoadPlanSheets_(__p, ['CONFIG'], true).CONFIG).values`, { __p: p });
  const hashOf = (p) => e.call('appPlanInputHash_(__p)', { __p: p });
  const START = { project: 'test-project', location: 'asia-northeast1', model: 'gemini-test' };

  // 見る（書かない・頼みは残す）
  const pv = task({ action: 'vertexConfigPreview' });
  assert.equal(pv.ok, true);
  assert.deepEqual(pv.result.plans.map((x) => [x.planId, x.frozen, x.model, x.location, x.project]),
    [[pA, false, 'gemini-test', 'asia-northeast1', 'test-project'], [pB, false, 'gemini-test', 'asia-northeast1', 'test-project'], [pC, true, 'gemini-test', 'asia-northeast1', 'test-project']].sort());
  assert.deepEqual(pv.result.summary.model, { 'gemini-test': 2 }, '値ごとの数は年度を締めていない計画だけ');
  assert.deepEqual([pv.result.openPlans, pv.result.frozenPlans], [2, 1]);
  assert.ok(e.props.OWNER_TASK, '読むだけの操作は頼みを残す');

  // 形の違う値・項目は、何もせずに止める
  const hA = hashOf(pA);
  for (const [t, re] of [
    [{ action: 'setVertexConfig' }, /モデル名（model）を入れてください/],
    [{ action: 'setVertexConfig', model: 'Gemini Pro!' }, /model（モデル名）は英小文字・数字/],
    [{ action: 'setVertexConfig', model: 'gemini-9.9-pro', location: 'asia/../x' }, /location（リージョン）は/],
    [{ action: 'setVertexConfig', model: 'gemini-9.9-pro', project: 'A' }, /project（Google Cloud のプロジェクト ID）は/],
    [{ action: 'setVertexConfig', model: 'gemini-9.9-pro', planIds: pA }, /planIds は計画の ID/],
    [{ action: 'setVertexConfig', model: 'gemini-9.9-pro', reason: 'x' }, /使えない項目があります: reason/],
  ]) assert.throws(() => task(t), re);
  // 締めた年度の計画を名指ししたら、何も書かずに断る
  assert.throws(() => task({ action: 'setVertexConfig', model: 'gemini-9.9-pro', planIds: [pA, pC] }), /年度を締めた計画には書けません（何も書いていません）: /);
  assert.deepEqual(vertexOf(pA), START);
  assert.equal(hashOf(pA), hA, '何も書いていない');

  // 全計画（締めていない年度）のモデルとリージョンを替える
  const audits = e.audit().length;
  const set = task({ action: 'setVertexConfig', model: 'gemini-9.9-pro', location: 'global' });
  assert.equal(set.ok, true);
  assert.deepEqual(set.result.changed.map((x) => x.planId).sort(), [pA, pB].sort());
  assert.deepEqual(set.result.changed[0].before, START);
  assert.deepEqual(set.result.changed[0].after, { project: 'test-project', location: 'global', model: 'gemini-9.9-pro' });
  assert.deepEqual([set.result.unchanged, set.result.skipped, set.result.remaining], [[], [], []]);
  assert.deepEqual(vertexOf(pA), { project: 'test-project', location: 'global', model: 'gemini-9.9-pro' });
  assert.deepEqual(vertexOf(pB), { project: 'test-project', location: 'global', model: 'gemini-9.9-pro' });
  assert.deepEqual(vertexOf(pC), START, '締めた年度の計画は替えない');
  assert.notEqual(hashOf(pA), hA, 'データ本体の CONFIG が変わった（開いていた画面の保存は断られ、計算用ブックは組み立て直す）');
  assert.equal(e.props.OWNER_TASK, undefined, '書く操作は頼みを消す');
  const au = e.audit().slice(audits).filter((a) => a.action === 'VERTEX.SET');
  assert.deepEqual(au.map((a) => [a.phase, a.result, a.actor_email]), [['START', '', OWNER], ['END', 'OK', OWNER]]);
  assert.match(au[1].reason, /OWNER_TASK/);
  const after = JSON.parse(au[1].after_json);
  assert.deepEqual(after.changed.map((x) => [x.before.model, x.after.model]), [['gemini-test', 'gemini-9.9-pro'], ['gemini-test', 'gemini-9.9-pro']], '監査に前と後の値');
  // 同じ頼みをもう一度: 変わる値が無いので書かない
  const hA2 = hashOf(pA);
  const again = task({ action: 'setVertexConfig', model: 'gemini-9.9-pro', location: 'global' });
  assert.deepEqual([again.result.changed, again.result.unchanged.sort()], [[], [pA, pB].sort()]);
  assert.equal(hashOf(pA), hA2);
  // 名指しした計画のプロジェクトだけ替える
  const one = task({ action: 'setVertexConfig', model: 'gemini-9.9-pro', project: 'other-project-1', planIds: [pB] });
  assert.deepEqual(one.result.changed.map((x) => [x.planId, x.after.project]), [[pB, 'other-project-1']]);
  assert.equal(vertexOf(pA).project, 'test-project');
  // 次の A-4 は新しい問い合わせ先に問い合わせる（データ本体の CONFIG から組み立て直す）
  setAi(e, '__calls.length = 0;');
  const st = research(e, pA);
  assert.equal(st.status, 'DONE', st.error);
  const urls = e.run('__calls').map((c) => c.url);
  assert.ok(urls.length && urls.every((u) => u.startsWith('https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google/models/gemini-9.9-pro:generateContent')), urls[0]);
  // 所有者でなければ動かせない（エディタの入口は所有者だけ）
  e.as('member@bigm2y.com');
  e.props.OWNER_TASK = JSON.stringify({ action: 'setVertexConfig', model: 'gemini-1.0-x' });
  assert.throws(() => e.call('apiOwnerTask()'), /権限がありません/);
  e.as(OWNER);
  assert.equal(vertexOf(pA).model, 'gemini-9.9-pro');
  assert.equal(e.state.lockHeld, false);
}

console.log('app-vertex-config: all tests passed');
