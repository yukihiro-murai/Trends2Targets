/**
 * app-v10-append.test.mjs — 版 10 の記録の表に足す道具（SCHEMA_PLAN_v10-12_JA.md の 3-0）。
 * appLogOps_ で作った控えの書き方 append を本体の保存と同じ控えで書く・控えの書き直しで二重にならない・キーの列だけを読む・
 * 締めた年度の計画の行は書けない・行の形を控えを置く前に確かめる・番号の作り方。
 *
 *   node app/tests/app-v10-append.test.mjs
 */
import assert from 'node:assert/strict';
import { setUpEnv, STATS, OWNER } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
function planBook(client, fy) {
  const output = [['FY' + fy + ' 売上予測（' + client + '）']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 900, 1000, 1100]);
  output.push([], []);
  for (let i = 0; i < 12; i++) output.push([D(fy, 4 + i, 1), 70, 80, 90, '', '', '', 80, '']);
  return { CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '担当A']] }, OUTPUT: { values: output } };
}

const env = setUpEnv();
const currentFy = env.run('appFy_(new Date())');
const past = currentFy - 1;
const planA = env.seedPlan(env.makeBook('A', planBook('テスト製薬', past)));        // 締める年度
const planB = env.seedPlan(env.makeBook('B', planBook('テスト薬品', currentFy)));   // 今の年度
{
  const sub = env.call('appTestVersionSubmit_(__in)', { __in: { planId: planA } });
  env.call('appTestVersionDecide_(__in)', { __in: { versionId: sub.version.versionId, decision: 'APPROVED', rowVersion: sub.version.rowVersion } });
  const pv = env.task('yearPreview(__in)', { __in: { fy: past } });
  assert.equal(env.runJob('YEAR.CLOSE', { fy: past, inputHash: pv.inputHash }).status, 'DONE');
}
const CTX = `({ actor: '${OWNER}', requestId: 'TEST', roles: [] })`;
const inl = (i, extra) => Object.assign({ plan_id: planB, log_id: 'INL-T-' + String(i).padStart(4, '0'), action_id: 'PA-1', action: 'INPUT.SAVE', kind: 'product',
  change: 'ADD', row_key: 'product|担当A|製品X|2026-06|' + i, person: '担当A', before_json: '', after_json: { step: 0.05, month: '2026-06' }, actor_email: OWNER, saved_at: '2026-10-08T10:00:00+0900' }, extra || {});
const ops = (table, rows) => env.call('appLogOps_(__t, __r)', { __t: table, __r: rows });
const journal = (label, planId, list) => env.call(`appWithLock_(() => appJournalRun_(${CTX}, __l, __p, __o))`, { __l: label, __p: planId, __o: list });

// ==== 1. 控えの書き方を作る: 形を確かめてそろえる（控えを置く前に止める） ====
{
  assert.deepEqual(ops('INPUT_LOG', []), [], '行が無ければ何も足さない');
  assert.throws(() => ops('PLANS', [{ plan_id: 'x' }]), /追記だけの記録の表ではありません/);
  assert.throws(() => ops('PERSON_LINKS', [{ link_id: 'x' }]), /追記だけの記録の表ではありません/, 'つなぎは無効の印を変える表（ROLES と同じ書き方）');
  assert.throws(() => ops('INPUT_LOG', [inl(1, { typo_col: 1 })]), /表に無い列です（INPUT_LOG）: typo_col/);
  assert.throws(() => ops('INPUT_LOG', [inl(1, { log_id: '' })]), /キーが空/);
  assert.throws(() => ops('INPUT_LOG', [inl(1, { plan_id: '' })]), /plan_id/);
  assert.equal(ops('LEARNING_LOG', [{ plan_id: '', learn_id: 'LRN-1', event: 'APPLY', target: 'tau' }]).length, 1, '学びの記録は全計画の行（plan_id が空）を持てる');
  const ai = ops('AI_RESEARCH_LOG', [{ plan_id: planB, research_id: 'AIR-1', impact_score: '0.5', confidence: '', event_score: 2, row_json: ['a', 1] }])[0].rows[0];
  assert.deepEqual([ai.impact_score, ai.confidence, ai.event_score, ai.row_json], [0.5, null, 2, '["a",1]'], '数の列は数か空に、JSON は文字に');
  assert.throws(() => ops('AI_RESEARCH_LOG', [{ plan_id: planB, research_id: 'AIR-2', impact_score: 'abc' }]), /数の列に数でない値/);
  const bt = ops('BACKTEST', [{ plan_id: planB, point_id: 'BTP-1', counted: 'TRUE', horizon: '3', p50: 10 }])[0].rows[0];
  assert.deepEqual([bt.counted, bt.horizon, bt.p50], [true, 3, 10]);
  const long = ops('INPUT_LOG', [inl(9, { reason: 'x'.repeat(40001) })])[0].rows[0];
  assert.match(long.reason, /^\{"truncated":true/, '4 万字を超えるセルは、ハッシュと先頭だけ');
  assert.ok(env.errors().some((e) => e.where === 'LOG.TRUNCATED'), '切り詰めたことをエラーのログに残す');
  const op = ops('INPUT_LOG', [inl(1)]);
  assert.deepEqual([op.length, op[0].table, op[0].mode, op[0].rows[0].after_json], [1, 'INPUT_LOG', 'append', '{"step":0.05,"month":"2026-06"}']);
}

// ==== 2. 本体の保存と同じ控えで書く。控えの書き直しでも二重にならない ====
{
  const main = { table: 'PLANS', mode: 'patch', key: { plan_id: planB }, patch: { note: '保存 1' }, actor: OWNER };
  const list = [main].concat(ops('INPUT_LOG', [inl(1), inl(2)]), ops('AI_RESEARCH_LOG', [{ plan_id: planB, research_id: 'AIR-1', topic: 't', blended_score: 0.25 }]));
  const w = journal('テストの保存', planB, list);
  assert.deepEqual([w.PLANS.patched, w.INPUT_LOG.appended, w.AI_RESEARCH_LOG.appended], [1, 2, 1]);
  assert.equal(env.table('PLANS').find((p) => p.plan_id === planB).note, '保存 1');
  assert.deepEqual(env.table('INPUT_LOG').map((r) => r.log_id), ['INL-T-0001', 'INL-T-0002']);
  assert.equal(env.call('appReadTable_("AI_RESEARCH_LOG")')[0].blended_score, 0.25, '数の列は数で読める');
  // 同じ控えをもう一度書いても、行は増えない
  const again = env.call('appWithLock_(() => appJournalApply_(__o))', { __o: list });
  assert.deepEqual([again.INPUT_LOG.appended, again.AI_RESEARCH_LOG.appended], [0, 0]);
  assert.equal(env.table('INPUT_LOG').length, 2);
  // 記録の表に書く途中で止まる → 控えが残る → 次の書き込みの前に書き直す（二重にならない）
  const sh = env.data().getSheetByName('INPUT_LOG');
  sh.failWrites = true;
  const list2 = [{ table: 'PLANS', mode: 'patch', key: { plan_id: planB }, patch: { note: '保存 2' }, actor: OWNER }].concat(ops('INPUT_LOG', [inl(2), inl(3)]));
  assert.throws(() => journal('止まる保存', planB, list2), /write failed/);
  assert.ok(env.call('appJournalPending_()'), '控えが残る');
  assert.equal(env.table('PLANS').find((p) => p.plan_id === planB).note, '保存 2', '本体は書いた');
  sh.failWrites = false;
  const rec = env.call(`appWithLock_(() => appJournalRecover_(${CTX}))`);
  assert.equal(rec.written.INPUT_LOG.appended, 1, '足していなかった行だけ足す');
  assert.equal(env.call('appJournalPending_()'), null);
  assert.deepEqual(env.table('INPUT_LOG').map((r) => r.log_id), ['INL-T-0001', 'INL-T-0002', 'INL-T-0003']);
  assert.throws(() => env.call('appWithLock_(() => appAppendLogRows_("INPUT_LOG", [__a, __a]))', { __a: inl(7) }), /同じキーの行が 2 つ/);
  assert.equal(env.call('appReadPlanTable_("INPUT_LOG", __p)', { __p: planB }).length, 3, '1 列目が plan_id なので計画の行だけを読める');
}

// ==== 3. 重なりはキーの列だけを読んで確かめる（表全体は読まない） ====
{
  const many = Array.from({ length: 200 }, (_, i) => inl(100 + i));
  journal('たくさん', planB, ops('INPUT_LOG', many));
  const n = env.table('INPUT_LOG').length;
  const width = env.call('APP_TABLES.INPUT_LOG.columns.length');
  env.run('APP_STORE_CACHE_ = {}');
  for (const k of Object.keys(STATS)) STATS[k] = k === 'bySheet' ? {} : 0;
  env.call('appWithLock_(() => appAppendLogRows_("INPUT_LOG", [__r]))', { __r: inl(999) });
  const read = STATS.bySheet.INPUT_LOG.readCells;
  assert.ok(read <= n + width, `キーの列と見出しだけを読む（${read} セル。表全体は ${(n + 1) * width} セル）`);
  assert.equal(env.table('INPUT_LOG').length, n + 1);
}

// ==== 4. 締めた年度の計画の行は書けない（控えを置く前に止める）。全計画の行は書ける ====
{
  const before = env.table('INPUT_LOG').length;
  assert.throws(() => journal('締めた年度', planA, ops('INPUT_LOG', [inl(500, { plan_id: planA })])), /締め済み/);
  assert.throws(() => journal('今の年度の保存に締めた年度の記録', planB, ops('INPUT_LOG', [inl(501, { plan_id: planA })])), /締め済み/, '控えの中の行の計画も見る');
  assert.throws(() => env.call('appWithLock_(() => appAppendLogRows_("INPUT_LOG", [__r]))', { __r: inl(502, { plan_id: planA }) }), /締め済み/, 'じかに足しても止まる');
  assert.throws(() => env.call('appWithLock_(() => appAppendLogRows_("INPUT_LOG", [__r]))', { __r: inl(503, { plan_id: 'PL-UNKNOWN' }) }), /年度を確かめられません/, '年度の分からない計画は書かない');
  assert.equal(env.table('INPUT_LOG').length, before);
  assert.equal(env.call('appJournalPending_()'), null, '控えも置かない');
  const w = journal('全計画の学び', '', ops('LEARNING_LOG', [{ plan_id: '', learn_id: 'LRN-1', event: 'APPLY', target: 'tau', applied_value: '0.1', actor_email: OWNER, at: 'now' }]));
  assert.equal(w.LEARNING_LOG.appended, 1);
}

// ==== 5. 年度の控えに入る（plan_id の表の、その年度の計画の行だけ。全計画の行・つなぎは入らない） ====
{
  journal('当たり', planB, ops('HIT_RECORDS', [{ plan_id: planB, hit_id: env.call('appStableLogId_("HIT", [__p, "PERSON", "担当A", "FY2026-Q1", "v1"])', { __p: planB }), quarter: 'FY2026-Q1', hit: 1, n_months: 3 }]));
  const s = env.call('appYearSnapshot_(__f)', { __f: currentFy });
  const t = Object.fromEntries(JSON.parse(s.text).tables.map((x) => [x.name, x]));
  assert.equal(t.INPUT_LOG.rows.length, env.table('INPUT_LOG').length);
  assert.equal(t.HIT_RECORDS.rows.length, 1);
  assert.equal(t.LEARNING_LOG.rows.length, 0, '全計画の学びは年度の控えに入らない');
  assert.equal(t.PERSON_LINKS, undefined, 'つなぎは計画の表ではない');
  for (const name of ['AI_RESEARCH_LOG', 'LAYER_EFFECTS', 'BACKTEST']) assert.ok(t[name], name + ' も年度の控えの表');
  assert.equal(env.call('appLogTruncatedCells_("INPUT_LOG")'), 0, '記録の表に切り詰めたセルは無い');
}

// ==== 6. 番号の作り方・版がそろう前は足さない ====
{
  const ids = env.call('Array.from({ length: 500 }, () => appNewLogId_("INL"))');
  assert.ok(ids.every((id) => /^INL-\d{14}-[0-9A-F]{12}$/.test(id)));
  assert.equal(new Set(ids).size, ids.length);
  const a = env.call('appStableLogId_("LEF", ["R-1", "2026-04"])');
  assert.equal(env.call('appStableLogId_("LEF", ["R-1", "2026-04"])'), a, '同じ中身なら同じ番号');
  assert.notEqual(env.call('appStableLogId_("LEF", ["R-1", "2026-05"])'), a);
  assert.match(a, /^LEF-[0-9A-F]{24}$/);
  // 版の印がそろう前（移行がバックアップを待っている間）でも、表があり見出しが今の列の記録の表には足す（2026-10-09: 表ごとに決める。
  // 前は版の印だけを見て足さず、その保存の記録が失われていた）。版 11 の下書きの表は版がそろうまで足さない。表が無ければ足さない
  env.props.APP_TABLES_VERSION = '9';
  assert.equal(ops('INPUT_LOG', [inl(600)]).length, 1, '表があって見出しが今の列なら足す（本体の保存と同じ控えで）');
  assert.equal(env.errors().some((e) => e.where === 'LOG.SKIPPED'), false);
  assert.deepEqual(ops('BUDGET_DRAFTS', [{ plan_id: planB, draft_id: 'BDR-T', action_id: 'PA-1', ym: '2026/04' }]), [], '版 11 の下書きは版がそろうまで足さない');
  assert.ok(env.errors().some((e) => e.where === 'LOG.SKIPPED'));
  const ss = env.data();
  const sh = ss.getSheetByName('BACKTEST');
  ss.deleteSheet(sh);
  env.run('APP_STORE_CACHE_ = {}');
  assert.deepEqual(ops('BACKTEST', [{ plan_id: planB, point_id: 'BTP-T' }]), [], '表が無ければ足さない（本体の保存は止めない）');
  env.props.APP_TABLES_VERSION = String(env.call('APP_SCHEMA_VERSION'));
  assert.equal(ops('BACKTEST', [{ plan_id: planB, point_id: 'BTP-T' }]).length, 1, '版がそろっていれば足す（今までどおり。書くところで表を確かめる）');
}

console.log('app-v10-append: ok');
