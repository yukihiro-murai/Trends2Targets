#!/usr/bin/env node
/**
 * app-v10-ai-research-log.test.mjs — AI 調査の記録（AI_RESEARCH_LOG。SCHEMA_PLAN_v10-12_JA.md の 3-2）。
 * 本物の旧来の A-4（runVertexAIResearch）を、決まった形の Vertex AI の答えで動かす（app-ai.test.mjs と同じ作り）。
 *   1. 人が始めた A-4 の 1 回で、その回に書いた行（AI_RESEARCH_STRUCTURED の全部の行）が 1 回分足される。started_by = 始めた人、
 *      action_id = PLAN_ACTIONS の番号、点数は数、22 列はそのまま戻せる
 *   2. 失敗した回（問い合わせが全部失敗）は足さない。AI_RESEARCH_STRUCTURED が変わらない保存（ほかの操作）も足さない
 *   3. 週 1 回の自動の調査（AutoResearch.js のトリガー）が始めた回は AUTO
 *   4. 控えの書き直しで二重にならない（記録の表に書く途中で止まる → 次の書き込みの前に書き直す）
 *   5. 一度だけの写し（BASELINE）: 今の AI_RESEARCH_STRUCTURED を計画ごとに 1 回だけ写す。締めた年度の計画は飛ばす。二度動かしても増えない
 * モックの上の確かめで、本物の Apps Script・Vertex AI の上では動かしていない。
 *
 *   node app/tests/app-v10-ai-research-log.test.mjs
 */
import assert from 'node:assert/strict';
import { setUpEnv as setUpBase, OWNER, J, jstDay } from './gas-mock.mjs';

/** 自動の調査のトリガーを見るので、毎日のバックアップのトリガーは自動では作らない（app-auto-research.test.mjs と同じ） */
const setUpEnv = () => { const e = setUpBase(); e.props.BACKUP_AUTO_ENABLE = 'false'; return e; };
const D = (y, m, d = 1) => new Date(y, m - 1, d);
const p2 = (n) => String(n).padStart(2, '0');
/** 今日から offset 日の、日本時間の hh:mm（ミリ秒） */
const jst = (offset, hh, mm = 0) => new Date(`${jstDay(offset)}T${p2(hh)}:${p2(mm)}:00+09:00`).getTime();

/** Vertex AI の答え（code が 200 でなければ全部失敗）。形にする問い合わせには、話題ごとに出来事と比べの両方を返す */
function stubVertex(env, code = 200) {
  env.run(`(() => {
    ScriptApp.getOAuthToken = () => 'test-token';
    const gemini = (text) => JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/a', title: 'a' } }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
    globalThis.UrlFetchApp = { fetch: (u, o) => {
      if (${code} !== 200) return { getResponseCode: () => ${code}, getContentText: () => JSON.stringify({ error: { code: ${code}, status: 'PERMISSION_DENIED', message: 'denied' } }) };
      const body = JSON.parse(o.payload);
      const structured = !!(body.generationConfig && body.generationConfig.responseMimeType);
      // 根拠の文は問い合わせごとに変える（同じ日に調べ直しても、書く中身が変わる）
      globalThis.__ask = (globalThis.__ask || 0) + 1;
      const answer = { web: { direction: 'up', impact_score: 60, confidence: 0.8, evidence: '需要が伸びている（テスト ' + globalThis.__ask + '）', time_horizon: '6M', business_relevance_reason: '主な製品に効く' },
        report: { relative_percentile: 70, relative_confidence: 0.6, benchmark_quality: 'medium', peer_universe: '同業', peer_basis: '売上', relative_position_label: '上位', relative_reason: '比べて強い', evidence: '比べの根拠' },
        report_text: '市場は伸びている。' };
      return { getResponseCode: () => 200, getContentText: () => gemini(structured ? JSON.stringify(answer) : '市場は伸びている。') };
    } };
    appAiDeadline_ = () => Date.now() + 60000;
  })()`);
}

/** A-4 を動かせる計画の見本（app-auto-research.test.mjs と同じ形。公式版を出せるよう、予測の結果 OUTPUT も置く） */
function seed(env, client, fy) {
  const output = [['FY' + fy + ' 売上予測（' + client + '）']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 900, 1000, 1100]);
  output.push([], []);
  for (let i = 0; i < 12; i++) output.push([D(fy, 4 + i, 1), 70, 80, 90, '', '', '', 80, '']);
  return env.seedPlan(env.makeBook(client, {
    OUTPUT: { values: output },
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '鷹野'],
      ['VERTEX_PROJECT_ID', 'test-project'], ['VERTEX_LOCATION', 'asia-northeast1'], ['VERTEX_GEMINI_MODEL', 'gemini-test'], ['AI_RESEARCH_ENABLED（0/1）', 1]] },
    PROCESS_STATUS: { values: [['step_key', 'last_run_date', 'last_run_by', 'status', 'target_client', 'record_count', 'error_summary'],
      ['step1_status', D(2026, 9, 1), 'owner', 'success', client, 10, '']] },
    PRODUCT: { values: [['Person', 'ProductName', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']] },
    CLIENT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason']] },
    OPINIONS: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Confidence(0..1)', 'Note']] },
    DEV_SPOT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Project', 'Amount(JPY)', 'Confidence(0..1)']] },
  }));
}

const CTX = `({ actor: '${OWNER}', requestId: 'TEST', roles: [] })`;
const HEADER = (env) => [...env.run('APP_ENGINE_SHEETS.AI_RESEARCH_STRUCTURED.header')];
const logOf = (env, planId) => env.table('AI_RESEARCH_LOG').filter((r) => r.plan_id === planId);
const engOf = (env, planId) => env.table('ENG_AI_RESEARCH_STRUCTURED').filter((r) => r.plan_id === planId);
const research = (env, planId) => env.runJob('PLAN.RUN', { planId, action: 'AI.RESEARCH' });
/** データ本体の形の 1 行を、元の値（列 → 値）に戻す */
const decodeEng = (env, row) => env.call(`(() => { const o = {}; APP_ENGINE_SHEETS.AI_RESEARCH_STRUCTURED.header.forEach((h, j) => { o[h] = appCellDecode_(__r._types.charAt(j), __r[h]); }); return o; })()`, { __r: row });

const env = setUpEnv();
const FY = env.run('appFy_(new Date())');
stubVertex(env);
const planId = seed(env, 'テスト製薬', FY);

// ==== 1. 人が始めた A-4: その回に書いた行が 1 回分足される ====
let firstAction;
{
  const st = research(env, planId);
  assert.equal(st.status, 'DONE', st.error);
  const eng = engOf(env, planId);
  const log = logOf(env, planId);
  assert.ok(eng.length >= 4, '前提: A-4 が話題ごとの行を書いた（' + eng.length + ' 行）');
  assert.equal(log.length, eng.length, 'その回に書いた行（書き直した後の全部の行）を足す');
  const act = env.table('PLAN_ACTIONS').filter((r) => r.plan_id === planId && r.action === 'AI.RESEARCH');
  assert.equal(act.length, 1);
  firstAction = act[0].action_id;
  assert.ok(log.every((r) => r.action_id === firstAction), 'action_id は PLAN_ACTIONS の番号');
  assert.ok(log.every((r) => r.started_by === OWNER), '人が始めた回は始めた人のメール');
  assert.ok(log.every((r) => /^AIR-[0-9A-F]{24}$/.test(r.research_id)));
  assert.deepEqual(log.map((r) => r.research_id), eng.map((r) => env.call('appStableLogId_("AIR", [__a, __s])', { __a: firstAction, __s: r.seq })), '番号は操作と行から決まる');
  assert.ok(log.every((r) => r.recorded_at), '書いた時刻');
  // 列: 話題・種類・向き・効く時期は文字、点数は数（読むと数）、調べた日は yyyy-MM-dd
  const typed = env.call('appReadPlanTable_("AI_RESEARCH_LOG", __p)', { __p: planId });
  const ev = typed.find((r) => r.row_type === 'event');
  const bm = typed.find((r) => r.row_type === 'benchmark');
  assert.ok(ev && bm, '出来事と比べの行');
  assert.deepEqual([ev.direction, ev.impact_score, ev.confidence, ev.time_horizon], ['up', 60, 0.8, '6M']);
  assert.equal(typeof ev.event_score, 'number', '点数の列は数で読める');
  assert.equal(ev.benchmark_score, null, '空の点数は空（0 にしない）');
  assert.equal(typeof bm.benchmark_score, 'number');
  assert.ok(typed.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.as_of_date)), '調べた日: ' + typed.map((r) => r.as_of_date).join(','));
  assert.deepEqual([...new Set(typed.map((r) => r.topic))].sort(), ['Channel', 'Competitor', 'DX', 'Market']);
  // 22 列がそのまま戻せる（型も。row_json = 見出しの順に、列ごとに「型 1 文字 + 値」）
  const header = HEADER(env);
  assert.equal(header.length, 22);
  log.forEach((r, i) => {
    const cells = JSON.parse(r.row_json);
    assert.equal(cells.length, 22, '22 列すべて');
    assert.ok(cells.every((c) => /^[esndbf]/.test(c)), '型 1 文字 + 値');
    assert.equal(cells[header.indexOf('evidence')].slice(1), eng[i].evidence, '根拠の文も元のまま');
    assert.deepEqual(env.call('appAiResearchLogCells_(__j)', { __j: r.row_json }), decodeEng(env, eng[i]), (i + 1) + ' 行目: 元の値に戻る');
  });
  assert.equal(env.call('appLogTruncatedCells_("AI_RESEARCH_LOG")'), 0, '切り詰めたセルは無い');
  assert.ok(!env.errors().some((e) => /^LOG\./.test(e.where)), 'エラーのログに記録の失敗が無い: ' + JSON.stringify(env.errors()));
}

// ==== 2. 失敗した回は足さない。AI_RESEARCH_STRUCTURED が変わらない保存も足さない ====
{
  const before = logOf(env, planId).length;
  stubVertex(env, 403);
  const ng = research(env, planId);
  assert.equal(ng.status, 'FAILED', '前提: 問い合わせが全部失敗した');
  assert.equal(logOf(env, planId).length, before, '失敗した回は足さない（旧来の計算は前の行を残す）');
  stubVertex(env);
  // ほかの保存（入力の保存）では足さない
  const st = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: { kind: 'opinions', rows: [{ person: '鷹野', ym: FY + '-06', step: '2', conf: '0.5', note: '' }] },
    inputHash: env.call('apiPlanView(__in)', { __in: { planId } }).inputHash });
  assert.equal(st.status, 'DONE', st.error);
  assert.equal(logOf(env, planId).length, before, 'A-4 でない保存は足さない');
  // 表が変わらない A-4 の保存（変わったシートに AI_RESEARCH_STRUCTURED が無い）・A-4 でない実行（変わったシートにあっても）は足さない
  const enc = { sheetRow: { sheet: 'AI_RESEARCH_STRUCTURED', mode: 'table' }, tableRows: engOf(env, planId) };
  assert.deepEqual(env.call(`appAiResearchLogOps_(${CTX}, { plan_id: __p }, { action: 'AI.RESEARCH', actionId: 'ACT-X' }, [], null)`, { __p: planId }), []);
  assert.deepEqual(env.call(`appAiResearchLogOps_(${CTX}, { plan_id: __p }, { action: 'SALES.AGGREGATE', actionId: 'ACT-X' }, [__e], null)`, { __p: planId, __e: enc }), []);
  assert.equal(env.call(`appAiResearchLogOps_(${CTX}, { plan_id: __p }, { action: 'AI.RESEARCH', actionId: 'ACT-X' }, [__e], null)`, { __p: planId, __e: enc })[0].rows.length,
    enc.tableRows.length, '前提: 変わっていれば足す');
}

// ==== 3. 週 1 回の自動の調査が始めた回は AUTO ====
{
  const env2 = setUpEnv();
  stubVertex(env2);
  const fy2 = env2.run(`appFy_(new Date(${jst(0, 4, 30)}))`);
  const p = seed(env2, '自動製薬', fy2);
  env2.run(`appEnsureAutoResearchTrigger_({ requestId: 'TEST', actor: '${OWNER}' })`);
  env2.run(`appAutoResearchNow_ = () => new Date(${jst(0, 4, 30)})`);
  const uid = env2.triggers.find((t) => t.handler === 'triggerAutoResearch').uid;
  env2.as('');
  const r = env2.call(`triggerAutoResearch({ triggerUid: '${uid}' })`);
  env2.as(OWNER);
  assert.deepEqual([r.status, r.planId], ['STARTED', p], r.reason);
  for (let i = 0; i < 100 && env2.triggers.some((t) => t.handler === 'triggerRunJob'); i++) env2.fireTriggers('triggerRunJob');
  const log = logOf(env2, p);
  assert.ok(log.length >= 4, '自動の回も記録する: ' + log.length);
  assert.ok(log.every((x) => x.started_by === 'AUTO'), '自動で始めた回は AUTO');
  assert.equal(J(env2.run('appAutoResearchState_()')).lastResult.status, 'DONE', '自動の調査の結果は今までどおり');
  // 同じ計画を人が画面から動かした回は、人のメール（自動の調査の控えの印は消えている）
  const st = research(env2, p);
  assert.equal(st.status, 'DONE', st.error);
  const latest = env2.table('PLAN_ACTIONS').filter((x) => x.plan_id === p && x.action === 'AI.RESEARCH').slice(-1)[0].action_id;
  const byHand = logOf(env2, p).filter((x) => x.action_id === latest);
  assert.ok(byHand.length >= 4 && byHand.every((x) => x.started_by === OWNER), '人が始めた回: ' + byHand.length);
  // 自動の控えの印があっても、その処理の続きでなければ人が始めた回
  assert.equal(env2.call(`appAiResearchStartedBy_(${CTX}, __p, { id: 'JOB-OTHER', parentId: '' })`, { __p: p }), OWNER);
  env2.props.APP_AUTO_RESEARCH = JSON.stringify({ chain: { jobId: 'JOB-ROOT', planId: p, requestedBy: OWNER, startedAt: '2026-10-08T04:30:00+0900' } });
  assert.equal(env2.call(`appAiResearchStartedBy_(${CTX}, __p, { id: 'JOB-ROOT', parentId: '' })`, { __p: p }), 'AUTO');
  assert.equal(env2.call(`appAiResearchStartedBy_(${CTX}, 'PL-OTHER', { id: 'JOB-ROOT', parentId: '' })`), OWNER, 'ほかの計画なら人');
}

// ==== 4. 控えの書き直しで二重にならない ====
{
  const sh = env.data().getSheetByName('AI_RESEARCH_LOG');
  const before = logOf(env, planId).length;
  sh.failWrites = true;
  const st = research(env, planId);
  sh.failWrites = false;
  assert.equal(st.status, 'FAILED', '前提: 記録の表に書く途中で止まった');
  assert.ok(env.call('appJournalPending_()'), '控えが残る');
  const rec = env.call(`appWithLock_(() => appJournalRecover_(${CTX}))`);
  const action = env.table('PLAN_ACTIONS').filter((r) => r.plan_id === planId && r.action === 'AI.RESEARCH').slice(-1)[0].action_id;
  const added = logOf(env, planId).filter((r) => r.action_id === action);
  assert.equal(added.length, engOf(env, planId).length, '書き直しで、その回の行を 1 回分');
  assert.equal(rec.written.AI_RESEARCH_LOG.appended, added.length);
  assert.equal(logOf(env, planId).length, before + added.length);
  // 同じ行をもう一度足しても増えない（キーは中身から決まる）
  const again = env.call(`appWithLock_(() => appJournalApply_(appLogOps_('AI_RESEARCH_LOG', __r)))`, { __r: env.call('appReadPlanTable_("AI_RESEARCH_LOG", __p)', { __p: planId }).map((r) => { delete r._row; return r; }) });
  assert.equal(again.AI_RESEARCH_LOG.appended, 0);
  assert.equal(new Set(logOf(env, planId).map((r) => r.research_id)).size, logOf(env, planId).length, '番号は重ならない');
}

// ==== 5. 一度だけの写し（BASELINE） ====
{
  const env3 = setUpEnv();
  stubVertex(env3);
  const fy3 = env3.run('appFy_(new Date())');
  const pOpen = seed(env3, '今年製薬', fy3);
  const pClosed = seed(env3, '締め製薬', fy3 - 1);
  for (const p of [pOpen, pClosed]) assert.equal(research(env3, p).status, 'DONE');
  // 締めた年度（前の年度）: 公式版を出して承認 → 年度を締める
  const sub = env3.call('appTestVersionSubmit_(__in)', { __in: { planId: pClosed } });
  env3.call('appTestVersionDecide_(__in)', { __in: { versionId: sub.version.versionId, decision: 'APPROVED', rowVersion: sub.version.rowVersion } });
  const pv = env3.task('yearPreview(__in)', { __in: { fy: fy3 - 1 } });
  assert.equal(env3.runJob('YEAR.CLOSE', { fy: fy3 - 1, inputHash: pv.inputHash }).status, 'DONE');
  const live = env3.table('AI_RESEARCH_LOG').length;
  // 移行の直後と同じ: 写しはまだ（APP_BACKFILLS を消す）。版 10 の移行の後の最初の操作で動く
  delete env3.props.APP_BACKFILLS;
  env3.call('apiListPlans()');
  const done = JSON.parse(env3.props.APP_BACKFILLS).done.appV10BackfillAiResearchLog_;
  assert.ok(done, '済みとして控える');
  const base = env3.table('AI_RESEARCH_LOG').filter((r) => r.action_id === 'BASELINE');
  assert.equal(base.length, engOf(env3, pOpen).length, '今の AI_RESEARCH_STRUCTURED の 1 回分');
  assert.equal(done.rows, base.length);
  assert.ok(base.every((r) => r.plan_id === pOpen && r.started_by === 'BASELINE'), '締めた年度の計画は写さない');
  assert.equal(env3.table('AI_RESEARCH_LOG').length, live + base.length);
  base.forEach((r) => assert.deepEqual(env3.call('appAiResearchLogCells_(__j)', { __j: r.row_json }),
    decodeEng(env3, engOf(env3, pOpen).find((e) => env3.call('appStableLogId_("AIR", ["BASELINE", __p, __s])', { __p: pOpen, __s: e.seq }) === r.research_id))));
  // 済んだ写しは二度と動かない。じかに動かしても、番号が中身から決まるので増えない
  env3.call('apiListPlans()');
  assert.equal(env3.call(`appAiResearchBackfill_(${CTX})`).rows, 0, 'もう一度動かしても足す行は無い');
  assert.equal(env3.table('AI_RESEARCH_LOG').length, live + base.length);
  // 計画が無いデータ本体では、足す行なしで済み
  const env4 = setUpEnv();
  assert.deepEqual(env4.call(`appV10BackfillAiResearchLog_(${CTX})`), { rows: 0 });
}

console.log('app-v10-ai-research-log: ok');
