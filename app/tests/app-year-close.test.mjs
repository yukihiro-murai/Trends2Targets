/**
 * app-year-close.test.mjs — 年度の締め（元の行を残したまま読み取り専用にする）。
 * 控えの選び方そのものは app-year-snapshot.test.mjs が確かめる。ここでは、締める流れ・凍結の見張り・失敗したときの置き方を確かめる。
 */
import assert from 'node:assert/strict';
import { OWNER, MEMBER, OTHER, OUTSIDER, sha, setUpEnv } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);

/** 年度 fy・クライアント名 client の計画を作る（OUTPUT に公式版に要る数字を入れる） */
function planBook(client, fy) {
  const output = [['FY' + fy + ' 売上予測（' + client + '）']];
  for (let r = 2; r <= 25; r++) output.push([]);
  output.push(['年度合計（予測）', 900, 1000, 1100]);
  output.push([], []);
  for (let i = 0; i < 12; i++) output.push([D(fy, 4 + i, 1), 70, 80, 90, '', '', '', 80, '']);
  return { CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', fy], ['[必須] 担当者（カンマ区切り）', '鷹野']] }, OUTPUT: { values: output } };
}

/** データ本体の全部のシートの中身（行のまま。比べるため） */
const allSheetRows = (env) => JSON.parse(JSON.stringify(env.data().sheets.map((s) => ({ name: s.name, rows: s.rows, fmls: s.fmls }))));

/** 年度 fy の締め（管理者として。プレビュー → YEAR.CLOSE） */
function closeYear(env, fy) {
  const pv = env.task('yearPreview(__in)', { __in: { fy } });
  assert.equal(pv.canClose, true, '締められる年度のはず: ' + JSON.stringify(pv));
  const st = env.runJob('YEAR.CLOSE', { fy: fy, inputHash: pv.inputHash });
  assert.equal(st.status, 'DONE', '締められるはず: ' + JSON.stringify(st));
  return st.result;
}

// ---- 準備: 過去の年度（今の年度 - 1）に計画 2 つ、今の年度に 1 つ。過去の年度の計画には全部公式版 ----
const env = setUpEnv();
const currentFy = env.run('appFy_(new Date())');
const past = currentFy - 1;
const planA = env.seedPlan(env.makeBook('予測A', planBook('テスト製薬', past)));
const planB = env.seedPlan(env.makeBook('予測B', planBook('テスト薬品', past)));
const planC = env.seedPlan(env.makeBook('予測C', planBook('テスト化学', currentFy)));
// 予算策定担当と承認者（クライアント単位の役割も確かめる）
env.task('saveMember(__in)', { __in: { email: MEMBER, displayName: 'M', department: '営業' } });
env.task('grantRole(__in)', { __in: { email: MEMBER, role: 'PLANNER', scopeType: 'ALL' } });
// 年度の全部の計画に公式版（APPROVED）を作る（所有者は自分で出した版を承認できる）
for (const planId of [planA, planB]) {
  const sub = env.call('appTestVersionSubmit_(__in)', { __in: { planId } });
  env.call('appTestVersionDecide_(__in)', { __in: { versionId: sub.version.versionId, decision: 'APPROVED', rowVersion: sub.version.rowVersion } });
}

// ==== 1. 締める前の確認（yearPreview）: 控えは作らない・何も書かない ====
const before0 = allSheetRows(env);
const archiveFolderId = env.props.APP_ARCHIVE_FOLDER_ID;
const filesInArchive0 = Object.values(env.files).filter((f) => f.parent === archiveFolderId).length;
const pv = env.task('yearPreview(__in)', { __in: { fy: past } });
assert.equal(pv.fy, past);
assert.equal(pv.canClose, true);
assert.match(pv.inputHash, /^[a-f0-9]{64}$/);
assert.equal(pv.planCount, 2, 'その年度の計画 2 つだけ');
assert.ok(pv.rowCount > 0 && pv.bytes > 0);
assert.ok(Array.isArray(pv.tables) && pv.tables.length > 0);
assert.equal(Object.values(env.files).filter((f) => f.parent === archiveFolderId).length, filesInArchive0, '確認では控えのファイルを作らない');
assert.equal(env.table('YEAR_CLOSURES').length, 0);
assert.deepEqual(allSheetRows(env), before0, '確認では表を変えない');
// 今の年度・これから・計画のない年度・おかしい入力は締められない
assert.equal(env.task('yearPreview(__in)', { __in: { fy: currentFy } }).canClose, false);
assert.equal(env.task('yearPreview(__in)', { __in: { fy: currentFy + 1 } }).canClose, false);
assert.equal(env.task('yearPreview(__in)', { __in: { fy: past - 20 } }).canClose, false, '計画のない年度');
assert.throws(() => env.task('yearPreview(__in)', { __in: { fy: 'abc' } }), /4 桁の数/, '所有者の操作は年度の形を先に確かめる');
assert.equal(env.call(`appYearPreview_({ actor: '${OWNER}' }, { fy: 'abc' })`).canClose, false, '中の関数も締めない');

// ==== 2. 状態（health の years）: 年度の一覧と状態 ====
let health = env.task('health()');
assert.equal(health.years.currentFy, currentFy);
const yPast = health.years.years.filter((y) => y.fy === past)[0];
assert.equal(yPast.planCount, 2);
assert.equal(yPast.state, 'OPEN');

// ==== 3. 締める: 控えがアーカイブへ、元の表は 1 つも変わらない ====
const before = allSheetRows(env);
const result = closeYear(env, past);
assert.equal(result.fy, past);
assert.equal(result.state, 'CLOSED');
assert.equal(result.already, false);
assert.equal(result.planCount, 2);
const closures = env.table('YEAR_CLOSURES');
assert.equal(closures.length, 1, '年度の締めの記録は 1 行');
assert.equal(String(closures[0].fy), String(past));
assert.equal(closures[0].state, 'CLOSED');
assert.equal(closures[0].snapshot_sha256, result.snapshotSha256);
assert.equal(closures[0].file_id, result.fileId);
// 控えのファイル（アーカイブに置いた。中身は YearSnapshot が作った文字のまま）
const ycFiles = Object.values(env.files).filter((f) => f.parent === archiveFolderId && /Trends2Targets_Year_FY/.test(f.name));
assert.equal(ycFiles.length, 1);
assert.match(ycFiles[0].name, new RegExp('Trends2Targets_Year_FY' + past + ' '));
const snap = env.call('appYearSnapshot_(__fy)', { __fy: past });
assert.equal(ycFiles[0].content, snap.text, '控えはそのままの文字');
assert.equal(sha(snap.text), snap.sha256);
const parsed = JSON.parse(snap.text);
assert.equal(parsed.fy, past);
assert.equal(parsed.tables.length, snap.tables.length);
// 元の表は、YEAR_CLOSURES に 1 行足した以外、1 セルも変わっていない
const after = allSheetRows(env);
for (const s of after) {
  const b = before.find((x) => x.name === s.name);
  if (s.name === 'YEAR_CLOSURES') continue;
  assert.deepEqual(s, b, '元の表はそのまま: ' + s.name);
}
// 2 度目の締めは冪等: 新しい控えを作らない（締め済みなので確認は canClose:false。処理に同じ指紋を渡すと already:true で終わる）
assert.equal(env.task('yearPreview(__in)', { __in: { fy: past } }).canClose, false);
const again = env.runJob('YEAR.CLOSE', { fy: past, inputHash: result.snapshotSha256 }).result;
assert.equal(again.already, true);
assert.equal(Object.values(env.files).filter((f) => f.parent === archiveFolderId && /Trends2Targets_Year_FY/.test(f.name)).length, 1, '同じ年度の控えは 1 つ');

// ==== 4. 凍結した年度は読めるが、書けない ====
health = env.task('health()');
assert.equal(health.years.years.filter((y) => y.fy === past)[0].state, 'CLOSED');
assert.equal(health.years.years.filter((y) => y.fy === currentFy)[0].state, 'OPEN');
let view = env.call('apiPlanView(__in)', { __in: { planId: planA } });
assert.equal(view.plan.frozen, true);
assert.equal(view.can.plan, false);
assert.equal(view.can.approve, false);
assert.equal(view.can.admin, false, '管理者でも凍結した年度には書けない');
assert.ok(view.boot, '凍結した計画の中身は読める');
view = env.call('apiPlanView(__in)', { __in: { planId: planC } });
assert.equal(view.plan.frozen, false);
assert.equal(view.can.admin, true);
let vlist = env.call('apiVersionList(__in)', { __in: { planId: planA } });
assert.equal(vlist.frozen, true);
assert.equal(vlist.can.submit, false);
assert.equal(vlist.can.approve, false);
assert.equal(vlist.official.no, 1, '公式版は読める');
assert.equal(env.call('apiListPlans()').plans.filter((p) => p.planId === planA)[0].frozen, true);
assert.equal(env.call('apiListPlans()').plans.filter((p) => p.planId === planC)[0].frozen, false);

// 計画への保存（5 操作）・実行（10 操作）・予測・版の出す/承認は全部止まる
for (const action of ['INPUT.SAVE', 'BUDGET.SAVE', 'INSIGHT.SAVE', 'REVIEW.DECIDE', 'SETUP.PEOPLE']) {
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.EDIT', payload: { planId: planA, action, args: {} } } }), /締め済み/, '保存 ' + action);
}
for (const action of ['IMPORT.SALES', 'IMPORT.ACTUALS', 'SALES.AGGREGATE', 'AI.RESEARCH', 'EVAL.REPORT', 'EVAL.DASHBOARD', 'EVAL.INSIGHTS', 'LEARN.MONTHLY', 'REVIEW.GENERATE', 'REVIEW.APPLY']) {
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.RUN', payload: { planId: planA, action, args: {} } } }), /締め済み/, '実行 ' + action);
}
assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'FORECAST.RUN', payload: { planId: planA } } }), /締め済み/);
assert.throws(() => env.call('appTestVersionSubmit_(__in)', { __in: { planId: planA } }), /締め済み/);
assert.throws(() => env.call('appTestVersionDecide_(__in)', { __in: { versionId: 'VER-none', decision: 'APPROVED' } }), /版が見つかりません/);
// 凍結した年度に新しい計画は作れない（始めた後の組み立てで止まる）
const createJob = env.runJob('PLAN.CREATE', { clientName: 'テスト新規', fy: past, peopleCsv: '山田' });
assert.equal(createJob.status, 'FAILED');
assert.match(createJob.error, /締め済み/);
assert.ok(!env.table('PLANS').some((p) => p.client_label === 'テスト新規'), '計画は作られない');
// 今の年度の計画は変わらず使える
env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.EDIT', payload: { planId: planC, action: 'SETUP.PEOPLE', args: { people: '山田' }, inputHash: env.run('appTestPlanHash_(__p)', { __p: planC }) } } });
env.fireTriggers('triggerRunJob');

// ==== 5. 内部の処理（CALC/SAVE など、続きの段）も計画の凍結で止まる ====
const inner = env.run('appEnqueueJob_("PLAN.RUN_CALC", __p, __by, "")', { __p: { planId: planA, action: 'EVAL.REPORT', actionId: 'ACT-1' }, __by: OWNER });
env.fireTriggers('triggerRunJob');
const innerJob = env.run('appJobGet_(__id)', { __id: inner.id });
assert.equal(innerJob.status, 'FAILED');
assert.match(innerJob.error, /締め済み/);

// ==== 6. 書きかけの控え（保存の途中で止まったもの）が凍結の計画を触るなら、書き直しも止まる ====
const jnlFile = env.run('DriveApp.getFolderById(__id).createFile("Trends2Targets 書きかけ JNL-test.json", __body, MimeType.PLAIN_TEXT).getId()', {
  __id: env.props.APP_FOLDER_ID,
  __body: JSON.stringify({ id: 'JNL-test', label: 'テストの保存', planId: planA, actor: OWNER, createdAt: '2026-01-01T00:00:00.000Z',
    ops: [{ table: 'ENG_SHEETS', mode: 'patch', key: { plan_id: planA, sheet: 'CONFIG' }, patch: { updated_at: '2026-01-01' }, actor: OWNER }] }),
});
env.run('appProps_().setProperty("APP_WRITE_JOURNAL", __v)', { __v: JSON.stringify({ id: 'JNL-test', fileId: jnlFile, label: 'テストの保存', planId: planA, at: '2026-01-01T00:00:00.000Z' }) });
assert.throws(() => env.run('appWithLock_(() => appJournalRecover_({ requestId: "t" }))'), /締め済み/);
assert.equal(env.run('appProps_().getProperty("APP_WRITE_JOURNAL")') !== null, true, '控えの記録は残る');
assert.equal(env.files[jnlFile].trashed, false, '控えのファイルは残る');
env.run('appProps_().deleteProperty("APP_WRITE_JOURNAL")');   // あとの確認のために片づける（テスト上の置き方）

// ==== 7. プール学習は凍結した計画を飛ばす（ほかの計画は続く。読み取りの材料としては残す） ====
const skipRes = env.run('appPoolApply_(__ctx, __p)', { __ctx: { actor: OWNER, requestId: 't' },
  __p: { rowsFor: [{ scope: 'reliability:t', value: 1, precision: 1, nClients: 1 }], remaining: [planA] } });
assert.equal(JSON.stringify(skipRes.plans), JSON.stringify([{ planId: planA, skipped: true }]), '凍結の計画は書かずに飛ばす');
const openList = env.run('appReadTable_("PLANS").filter(x => x.state !== "ARCHIVED" && !appYearIsFrozen_(x.fy)).map(x => x.plan_id)');
assert.ok(openList.indexOf(planA) < 0 && openList.indexOf(planB) < 0 && openList.indexOf(planC) >= 0, '最初の残りから凍結を除く');

// ==== 8. 締められない条件（控えのファイルも記録も作らない） ====
const filesNow = () => Object.values(env.files).filter((f) => f.parent === archiveFolderId && /Year_FY|年度/.test(f.name)).length;
const noClose = (fy, label) => {
  const n = filesNow();
  env.as(OWNER);
  const p2 = env.task('yearPreview(__in)', { __in: { fy } });
  if (p2.canClose) { const st = env.runJob('YEAR.CLOSE', { fy: fy, inputHash: p2.inputHash }); assert.equal(st.status, 'FAILED', label); }
  assert.equal(filesNow(), n, label + ': 控えを作らない');
  assert.ok(!env.table('YEAR_CLOSURES').some((r) => String(r.fy) === String(fy)), label + ': 記録も作らない');
};
noClose(currentFy, '今年度');
noClose(currentFy + 3, 'これからの年度');
noClose(past - 20, '計画のない年度');
// ほかの処理が動いている間は締められない
env.call('apiStartJob(__in)', { __in: { kind: 'LEARN.POOL', payload: {} } });
const busyPreview = env.task('yearPreview(__in)', { __in: { fy: past } });
assert.equal(busyPreview.canClose, false, 'ほかの処理がある間は締められない');
const queued = env.run('appJobList_().filter(j => j.status === "QUEUED")[0]');
env.run('(function(){ const j = appJobGet_(__id); j.status = "FAILED"; appJobSave_(j); })()', { __id: queued.id });
env.fireTriggers('triggerRunJob');
// 凍結した年度の「もう一度締める」は冪等（記録を増やさない）。壊れた記録は投げるが、凍結のまま
assert.equal(env.task('yearPreview(__in)', { __in: { fy: past } }).canClose, false);
env.run('(function(){ appUpdateByKey_("YEAR_CLOSURES", { fy: __fy }, { file_id: "" }, APP_ROW_UNCHECKED, __by); })()', { __fy: String(past), __by: OWNER });
assert.equal(env.task('health()').years.years.filter((y) => y.fy === past)[0].state, 'ERROR', '壊れた記録は要確認');
assert.equal(env.call('appYearIsFrozen_(' + past + ')'), true, '壊れていても凍結のまま');
const brokenClose = env.runJob('YEAR.CLOSE', { fy: past, inputHash: result.snapshotSha256 });
assert.equal(brokenClose.status, 'FAILED');
assert.match(brokenClose.error, /壊れています/);
env.run('(function(){ appUpdateByKey_("YEAR_CLOSURES", { fy: __fy }, { file_id: __fid }, APP_ROW_UNCHECKED, __by); })()', { __fy: String(past), __fid: result.fileId, __by: OWNER });

// 書きかけの保存・承認待ち・公式版なし・凍結の計画に予定された処理、も締められない（別の環境で 1 年ぶんずつ）
function envWithPastPlan(planName, clientName) {
  const e = setUpEnv();
  const py = e.run('appFy_(new Date())') - 1;
  const pid = e.seedPlan(e.makeBook(planName, planBook(clientName, py)));
  return { e, py, pid };
}
{
  // 承認待ちの版（SUBMITTED）があると締められない
  const x = envWithPastPlan('予測J', 'テスト造船');
  x.e.call('appTestVersionSubmit_(__in)', { __in: { planId: x.pid } });
  const p = x.e.task('yearPreview(__in)', { __in: { fy: x.py } });
  assert.equal(p.canClose, false);
  assert.match(p.reason, /承認待ち/);
  assert.equal(x.e.table('YEAR_CLOSURES').length, 0);
}
{
  // 公式版が 1 つも無い年度は締められない
  const x = envWithPastPlan('予測K', 'テスト航空');
  const p = x.e.task('yearPreview(__in)', { __in: { fy: x.py } });
  assert.equal(p.canClose, false);
  assert.match(p.reason, /公式版/);
}
{
  // 書きかけの保存があると締められない（ほかの計画のものでも。書き終わるのが先）
  const x = envWithPastPlan('予測L', 'テスト倉庫');
  const s = x.e.call('appTestVersionSubmit_(__in)', { __in: { planId: x.pid } });
  x.e.call('appTestVersionDecide_(__in)', { __in: { versionId: s.version.versionId, decision: 'APPROVED', rowVersion: s.version.rowVersion } });
  x.e.run('appProps_().setProperty("APP_WRITE_JOURNAL", __v)', { __v: JSON.stringify({ id: 'JNL-x', fileId: '', label: 'x', planId: '', at: '' }) });
  const p = x.e.task('yearPreview(__in)', { __in: { fy: x.py } });
  assert.equal(p.canClose, false);
  assert.match(p.reason, /途中/);
}

// ==== 9. 確認した後に年度が変わると、締める直前に止まる（控えも記録も作らない） ====
const env2 = setUpEnv();
const cur2 = env2.run('appFy_(new Date())');
const past2 = cur2 - 1;
const p2a = env2.seedPlan(env2.makeBook('予測E', planBook('テスト電機', past2)));
env2.call('appTestVersionSubmit_(__in)', { __in: { planId: p2a } });
const verD = env2.call('apiVersionList(__in)', { __in: { planId: p2a } }).versions[0];
env2.call('appTestVersionDecide_(__in)', { __in: { versionId: verD.versionId, decision: 'APPROVED', rowVersion: verD.rowVersion } });
const pv2 = env2.task('yearPreview(__in)', { __in: { fy: past2 } });
assert.equal(pv2.canClose, true);
const files2 = () => Object.values(env2.files).filter((f) => f.parent === env2.props.APP_ARCHIVE_FOLDER_ID).length;
const n2 = files2();
env2.run('appUpdateByKey_("PLANS", { plan_id: __id }, { note: "確認の後で変わった" }, __rv, __by)', { __id: p2a, __rv: 1, __by: OWNER });
const st2 = env2.runJob('YEAR.CLOSE', { fy: past2, inputHash: pv2.inputHash });
assert.equal(st2.status, 'FAILED', '指紋が変わったので締めない');
assert.match(st2.error, /内容が変わりました|確認/);
assert.equal(files2(), n2, '控えを作る前に止まる');
assert.equal(env2.table('YEAR_CLOSURES').length, 0);
// アーカイブのフォルダが無ければ止まる
const env3 = setUpEnv();
const past3 = env3.run('appFy_(new Date())') - 1;
const p3a = env3.seedPlan(env3.makeBook('予測F', planBook('テスト重工', past3)));
const s3 = env3.call('appTestVersionSubmit_(__in)', { __in: { planId: p3a } });
env3.call('appTestVersionDecide_(__in)', { __in: { versionId: s3.version.versionId, decision: 'APPROVED', rowVersion: s3.version.rowVersion } });
const pv3 = env3.task('yearPreview(__in)', { __in: { fy: past3 } });
env3.run('appProps_().deleteProperty("APP_ARCHIVE_FOLDER_ID")');
const st3 = env3.runJob('YEAR.CLOSE', { fy: past3, inputHash: pv3.inputHash });
assert.equal(st3.status, 'FAILED');
assert.match(st3.error, /アーカイブ/);
assert.equal(env3.table('YEAR_CLOSURES').length, 0);
assert.equal(Object.values(env3.files).filter((f) => /Year_FY|年度/.test(f.name)).length, 0, 'フォルダが無ければ控えを作らない');

// ==== 10. 控えの読み戻しが合わないとき: ファイルは残すが凍結しない ====
const env4 = setUpEnv();
const past4 = env4.run('appFy_(new Date())') - 1;
const p4a = env4.seedPlan(env4.makeBook('予測G', planBook('テスト食品', past4)));
const s4 = env4.call('appTestVersionSubmit_(__in)', { __in: { planId: p4a } });
env4.call('appTestVersionDecide_(__in)', { __in: { versionId: s4.version.versionId, decision: 'APPROVED', rowVersion: s4.version.rowVersion } });
const pv4 = env4.task('yearPreview(__in)', { __in: { fy: past4 } });
// 控えを置いた直後に中身が壊れて読める、という置き方をまねる
const af4 = env4.files[env4.props.APP_ARCHIVE_FOLDER_ID];
const origCreate = af4.createFile;
af4.createFile = (n, c, m) => { const x = origCreate.call(af4, n, c, m); const orig = x.getBlob; x.getBlob = () => ({ getDataAsString: () => String(c) + ' ' }); return x; };
const st4 = env4.runJob('YEAR.CLOSE', { fy: past4, inputHash: pv4.inputHash });
assert.equal(st4.status, 'FAILED');
assert.equal(env4.table('YEAR_CLOSURES').length, 0, '読み戻しが合わなければ凍結しない');
assert.equal(Object.values(env4.files).filter((f) => f.parent === env4.props.APP_ARCHIVE_FOLDER_ID && /Year_FY|年度/.test(f.name)).length, 1, '置いた控えは残す（消さない）');
// アーカイブ以外に置かれた場合も凍結しない
const env5 = setUpEnv();
const past5 = env5.run('appFy_(new Date())') - 1;
const p5a = env5.seedPlan(env5.makeBook('予測H', planBook('テスト水産', past5)));
const s5 = env5.call('appTestVersionSubmit_(__in)', { __in: { planId: p5a } });
env5.call('appTestVersionDecide_(__in)', { __in: { versionId: s5.version.versionId, decision: 'APPROVED', rowVersion: s5.version.rowVersion } });
const pv5 = env5.task('yearPreview(__in)', { __in: { fy: past5 } });
const af5 = env5.files[env5.props.APP_ARCHIVE_FOLDER_ID];
const orig5 = af5.createFile;
af5.createFile = (n, c, m) => { const x = orig5.call(af5, n, c, m); x.parent = 'ROOT'; return x; };   // 置いた場所が違う置き方をまねる
const st5 = env5.runJob('YEAR.CLOSE', { fy: past5, inputHash: pv5.inputHash });
assert.equal(st5.status, 'FAILED');
assert.equal(env5.table('YEAR_CLOSURES').length, 0);
assert.equal(Object.values(env5.files).filter((f) => /Year_FY|年度/.test(f.name)).length, 1, '置いた控えは残す');
// 記録の追記だけ失敗したとき: ファイルと元の行はそのまま、凍結にもしない
const env6 = setUpEnv();
const past6 = env6.run('appFy_(new Date())') - 1;
const p6a = env6.seedPlan(env6.makeBook('予測I', planBook('テスト紡績', past6)));
const s6 = env6.call('appTestVersionSubmit_(__in)', { __in: { planId: p6a } });
env6.call('appTestVersionDecide_(__in)', { __in: { versionId: s6.version.versionId, decision: 'APPROVED', rowVersion: s6.version.rowVersion } });
const pv6 = env6.task('yearPreview(__in)', { __in: { fy: past6 } });
const before6 = allSheetRows(env6);
env6.data().getSheetByName('YEAR_CLOSURES').failWrites = true;
const st6 = env6.runJob('YEAR.CLOSE', { fy: past6, inputHash: pv6.inputHash });
assert.equal(st6.status, 'FAILED');
assert.equal(Object.values(env6.files).filter((f) => /Year_FY|年度/.test(f.name)).length, 1, '置いた控えは残す');
const after6 = allSheetRows(env6);
for (const s of after6) {
  const b = before6.find((x) => x.name === s.name);
  assert.deepEqual(s, b, '追記が失敗しても元の表は変わらない: ' + s.name);
}

// ==== 11. 権限: 管理者以外は確認も締めもできない（データも変わらない） ====
env.task('saveMember(__in)', { __in: { email: 'approver@bigm2y.com', displayName: 'AP', department: '営業' } });
env.task('grantRole(__in)', { __in: { email: 'approver@bigm2y.com', role: 'APPROVER', scopeType: 'ALL' } });
for (const [who, label] of [[MEMBER, '予算策定担当'], ['approver@bigm2y.com', '承認者'], [OUTSIDER, '社外'], ['', '不明']]) {
  env.as(who);
  const n = filesNow();
  assert.throws(() => env.task('yearPreview(__in)', { __in: { fy: past } }), /権限/, label + ' は確認できない');
  assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'YEAR.CLOSE', payload: { fy: past, inputHash: result.snapshotSha256 } } }), /権限/, label + ' は締められない');
  assert.equal(filesNow(), n, label + ' の呼び出しで控えを作らない');
}
// クライアント単位の予算策定担当も同じ（年度は全体のもの）
env.as(OWNER);
env.task('saveMember(__in)', { __in: { email: OTHER, displayName: 'O', department: '営業' } });
env.task('grantRole(__in)', { __in: { email: OTHER, role: 'PLANNER', scopeType: 'CLIENT', clientId: env.table('PLANS').filter((p) => p.plan_id === planC)[0].client_id } });
env.as(OTHER);
assert.throws(() => env.task('yearPreview(__in)', { __in: { fy: past } }), /権限/);
assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'YEAR.CLOSE', payload: { fy: past, inputHash: result.snapshotSha256 } } }), /権限/);
env.as(OWNER);

// ==== 12. 画面からの締めの入力の形（年度・指紋）は、待ち行列に入れる前に確かめる ====
assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'YEAR.CLOSE', payload: { fy: currentFy, inputHash: result.snapshotSha256 } } }), /今年度/);
assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'YEAR.CLOSE', payload: { fy: past - 20, inputHash: 'xyz' } } }), /指紋|確認/);

// ==== 13. 凍結した年度の版の承認・却下も止まる（実際の承認待ちの版で） ====
{
  // 凍結した年度の計画に承認待ちの版がある状態を直接作る（本番では締める前に承認待ちがあると締められないため、ここでは行を足してまねる）
  env.run('appInsertRows_("PLAN_VERSIONS", [{ version_id: "VER-frozen", plan_id: __p, version_no: 2, state: "SUBMITTED", input_hash: "x", forecast_run_id: "", annual_p10: 0, annual_p50: 0, annual_p90: 0, budget_adopted: 0, budget_uplift: 0, budget_final: 0, monthly_json: "[]", note: "", submitted_at: "2026-01-01", submitted_by: __by, decided_at: "", decided_by: "", decision_note: "", updated_at: "2026-01-01", updated_by: __by, row_version: 1 }])',
    { __p: planA, __by: OWNER });
  const vBefore = JSON.stringify(env.table('PLAN_VERSIONS'));
  assert.throws(() => env.call('appTestVersionDecide_(__in)', { __in: { versionId: 'VER-frozen', decision: 'APPROVED', rowVersion: 1 } }), /締め済み/, '凍結した計画の承認待ちの版は承認できない');
  assert.equal(JSON.stringify(env.table('PLAN_VERSIONS')), vBefore, '版の表は変わらない');
}

// ==== 14. 内部の処理の全部（CALC/SAVE・計画の保存の続き）は凍結で止まる ====
// 締める前に待ち行列へ入れた処理（内部の段も）が、凍結した後に動いても書けない
for (const kind of ['PLAN.RUN_CALC', 'PLAN.RUN_SAVE', 'FORECAST.RUN_CALC', 'FORECAST.RUN_SAVE']) {
  const j = env.run('appEnqueueJob_(__k, __p, __by, "")', { __k: kind, __p: { planId: planA, action: 'EVAL.REPORT', actionId: 'ACT-' + kind, runId: 'RUN-x' }, __by: OWNER });
  env.fireTriggers('triggerRunJob');
  const got = env.run('appJobGet_(__id)', { __id: j.id });
  assert.equal(got.status, 'FAILED', kind + ' は凍結の計画では動かない');
  assert.match(got.error, /締め済み/, kind);
}
// 計画の作成の保存の段（PLAN.CREATE_SAVE）も凍結した年度には作れない
{
  env.run('appProps_().setProperty("APP_SCRATCH_OWNER", "TKN-x")');   // 計算用ブックの持ち主の印をまねる（保存の段に進むため）
  const j = env.run('appEnqueueJob_("PLAN.CREATE_SAVE", __p, __by, "")', { __p: { clientName: 'テスト凍結年度', fy: past, peopleCsv: '山田', token: 'TKN-x' }, __by: OWNER });
  env.fireTriggers('triggerRunJob');
  const got = env.run('appJobGet_(__id)', { __id: j.id });
  assert.equal(got.status, 'FAILED');
  assert.match(got.error, /締め済み|年度/);
  assert.ok(!env.table('PLANS').some((p) => p.client_label === 'テスト凍結年度'), '凍結した年度に計画は作られない');
}

// ==== 15. プール学習: 凍結は飛ばし、開いている計画の POOL_PRIOR は実際に書き換わる ====
{
  const engOf = (pid) => JSON.stringify(env.data().sheets.filter((s) => /^ENG_/.test(s.name))
    .map((s) => ({ name: s.name, rows: s.rows.filter((r) => r.indexOf(pid) >= 0) })));
  const frozenBefore = engOf(planA);
  const openBefore = engOf(planC);
  const poolRes = env.run('appPoolApply_(__ctx, __p)', { __ctx: { actor: OWNER, requestId: 't' },
    __p: { rowsFor: [{ scope: 'reliability:t2', value: 0.5, precision: 2, nClients: 1 }], remaining: [planA, planC] } });
  assert.equal(JSON.stringify(poolRes.plans), JSON.stringify([{ planId: planA, skipped: true }, { planId: planC, changed: true }]), '凍結は飛ばし、開いた計画は書く');
  assert.equal(engOf(planA), frozenBefore, '凍結の計画の表は 1 バイトも変わらない');
  assert.notEqual(engOf(planC), openBefore, '開いている計画に学習の書き込みが届く');
  assert.ok(env.table('ENG_SHEETS').some((r) => r.plan_id === planC && String(r.sheet) === 'POOL_PRIOR'), 'POOL_PRIOR の行ができている');
}

// ==== 16. 控えを作っている間に元の表が変わったら、置いた控えは残すが凍結しない（読み戻した元の指紋が違う） ====
{
  const env7 = setUpEnv();
  const past7 = env7.run('appFy_(new Date())') - 1;
  const p7a = env7.seedPlan(env7.makeBook('予測S', planBook('テスト製紙', past7)));
  const s7 = env7.call('appTestVersionSubmit_(__in)', { __in: { planId: p7a } });
  env7.call('appTestVersionDecide_(__in)', { __in: { versionId: s7.version.versionId, decision: 'APPROVED', rowVersion: s7.version.rowVersion } });
  const pv7 = env7.task('yearPreview(__in)', { __in: { fy: past7 } });
  const af7 = env7.files[env7.props.APP_ARCHIVE_FOLDER_ID];
  const orig7 = af7.createFile;
  const before7 = allSheetRows(env7);
  af7.createFile = (n, c, m) => {
    const f = orig7.call(af7, n, c, m);
    env7.run('appStoreForget_(); appUpdateByKey_("PLANS", { plan_id: __id }, { note: "控えの作成の間に変わった" }, 1, __by)', { __id: p7a, __by: OWNER });   // 元の表を直接変える置き方をまねる
    return f;
  };
  const st7 = env7.runJob('YEAR.CLOSE', { fy: past7, inputHash: pv7.inputHash });
  af7.createFile = orig7;
  assert.equal(st7.status, 'FAILED', '読み戻した元の指紋が違えば凍結しない');
  assert.match(st7.error, /変わりました/);
  assert.equal(env7.table('YEAR_CLOSURES').length, 0, '凍結の記録は作らない');
  assert.equal(Object.values(env7.files).filter((f) => /Year_FY|年度/.test(f.name)).length, 1, '置いた控えは残す（消さない）');
  // 元の表が変わったのは置き方のまねだけ（締める処理が元を変えたわけではない）
  const after7 = allSheetRows(env7);
  assert.equal(JSON.stringify(after7.filter((s) => s.name === 'PLANS')) !== JSON.stringify(before7.filter((s) => s.name === 'PLANS')), true);
}

// ==== 17. YEAR_CLOSURES の表が消えていたら、空で作り直さず全部の書き込みを止める（fail-closed） ====
{
  const x = envWithPastPlan('予測T', 'テスト製鋼');
  const sx = x.e.call('appTestVersionSubmit_(__in)', { __in: { planId: x.pid } });
  x.e.call('appTestVersionDecide_(__in)', { __in: { versionId: sx.version.versionId, decision: 'APPROVED', rowVersion: sx.version.rowVersion } });
  const pvx = x.e.task('yearPreview(__in)', { __in: { fy: x.py } });
  assert.equal(x.e.runJob('YEAR.CLOSE', { fy: x.py, inputHash: pvx.inputHash }).status, 'DONE');
  // 表だけが無くなった状態をまねる（記録の行も一緒に消える）
  x.e.data().deleteSheet(x.e.data().getSheetByName('YEAR_CLOSURES'));
  x.e.run('appStoreForget_()');
  assert.equal(x.e.task('yearPreview(__in)', { __in: { fy: x.py } }).canClose, false, '記録の表が読めなければ締められない');
  assert.throws(() => x.e.call('apiStartJob(__in)', { __in: { kind: 'PLAN.EDIT', payload: { planId: x.pid, action: 'SETUP.PEOPLE', args: { people: '山田' } } } }), /YEAR_CLOSURES|凍結|読めません|ありません/, '凍結の判定が読めなければ書き込みを通さない');
  assert.throws(() => x.e.call('appTestVersionSubmit_(__in)', { __in: { planId: x.pid } }), /YEAR_CLOSURES|凍結|読めません|ありません/);
  assert.throws(() => x.e.run('appEnsureTables_({ actor: __by })', { __by: OWNER }), /YEAR_CLOSURES|戻/, '自動では作り直さない');
  assert.equal(!!x.e.data().getSheetByName('YEAR_CLOSURES'), false, '空の表は作り直されない');
  // 書きかけの控えがあるときの書き直しも止まる（凍結の判定が読めないため）。控えと記録は残る
  const jm = x.e.run('DriveApp.getFolderById(__id).createFile("Trends2Targets 書きかけ JNL-m.json", __body, MimeType.PLAIN_TEXT).getId()', {
    __id: x.e.props.APP_FOLDER_ID,
    __body: JSON.stringify({ id: 'JNL-m', label: 'x', planId: x.pid, actor: OWNER, createdAt: '2026-01-01T00:00:00.000Z',
      ops: [{ table: 'ENG_SHEETS', mode: 'patch', key: { plan_id: x.pid, sheet: 'CONFIG' }, patch: { updated_at: '2026-01-01' }, actor: OWNER }] }) });
  x.e.run('appProps_().setProperty("APP_WRITE_JOURNAL", __v)', { __v: JSON.stringify({ id: 'JNL-m', fileId: jm, label: 'x', planId: x.pid, at: '2026-01-01T00:00:00.000Z' }) });
  assert.throws(() => x.e.run('appWithLock_(() => appJournalRecover_({ requestId: "t" }))'), /YEAR_CLOSURES|年度|確かめ|ありません/, '控えの書き直しも止まる');
  assert.equal(x.e.run('appProps_().getProperty("APP_WRITE_JOURNAL")') !== null, true, '控えの記録は残る');
  assert.equal(x.e.files[jm].trashed, false, '控えのファイルは残る');
  x.e.run('appProps_().deleteProperty("APP_WRITE_JOURNAL")');
}
{
  // まだ YEAR_CLOSURES を持たない古い版（_SCHEMA に記録が無い）からの移行は、ふつうに作れる
  const y = setUpEnv();
  y.data().deleteSheet(y.data().getSheetByName('YEAR_CLOSURES'));
  y.run('appReplaceWhole_("_SCHEMA", appReadTable_("_SCHEMA").filter(r => r.table !== "YEAR_CLOSURES"))');
  y.run('appStoreForget_()');
  const made = y.run('appEnsureTables_({ actor: __by })', { __by: OWNER });
  assert.ok(made.indexOf('YEAR_CLOSURES') >= 0, '記録がまだ無い移行では作れる');
}
{
  // YEAR_CLOSURES の見出しが壊れていても、書き込みは止まる（fail-closed）
  const z = envWithPastPlan('予測U', 'テスト製糸');
  z.e.run('(function(){ const sh = appDataSpreadsheet_().getSheetByName("YEAR_CLOSURES"); sh.getRange(1,1,1,2).setValues([["bogus","bogus"]]); appStoreForget_(); })()');
  assert.throws(() => z.e.call('apiStartJob(__in)', { __in: { kind: 'PLAN.EDIT', payload: { planId: z.pid, action: 'SETUP.PEOPLE', args: { people: '山田' } } } }), /列|YEAR_CLOSURES|違/, '見出しが壊れていれば書き込みを通さない');
}

// ==== 18. 控えの表全体の入れ替え・計画の年度の書き換え・正体不明の計画も止まる ====
{
  const engBefore = JSON.stringify(env.data().sheets.filter((s) => /^ENG_|^PLANS$/.test(s.name)).map((s) => ({ name: s.name, rows: s.rows })));
  // 表全体の入れ替えは、控えに凍結の計画の行を入れていなくても（消えるので）止まる
  assert.throws(() => env.run('appJournalApply_([{ table: "ENG_SHEETS", mode: "replace", rows: [] }])'), /締め済み|読み取り専用/, 'ENG_* の全体入れ替えは凍結があれば止まる');
  assert.throws(() => env.run('appJournalApply_([{ table: "PLANS", mode: "replace", rows: [] }])'), /締め済み|読み取り専用/, 'PLANS の全体入れ替えも止まる');
  // 開いている計画を締めた年度へ書き換えることもできない
  assert.throws(() => env.run('appJournalApply_([{ table: "PLANS", mode: "patch", key: { plan_id: __p }, patch: { fy: __fy } }])', { __p: planC, __fy: past }), /締め済み/, '開いた計画を締めた年度へ動かせない');
  // 正体不明の計画を触る控えは止まる（黙って通さない）
  assert.throws(() => env.run('appJournalApply_([{ table: "ENG_SHEETS", mode: "replacePlan", planId: "PL-nothing", sheets: null, rows: [] }])'), /年度を確かめられません|締め済み/, '見つからない計画の控えは止まる');
  assert.equal(JSON.stringify(env.data().sheets.filter((s) => /^ENG_|^PLANS$/.test(s.name)).map((s) => ({ name: s.name, rows: s.rows }))), engBefore, '止まった控えで元の表は変わらない');
  // 控えのファイルに残った古い（凍結前の）書き直しも、凍結した年度の行を消すような全体入れ替えはできない
  const oldJnl = env.run('DriveApp.getFolderById(__id).createFile("Trends2Targets 書きかけ JNL-old.json", __body, MimeType.PLAIN_TEXT).getId()', {
    __id: env.props.APP_FOLDER_ID,
    __body: JSON.stringify({ id: 'JNL-old', label: '古い保存', planId: planA, actor: OWNER, createdAt: '2026-01-01T00:00:00.000Z',
      ops: [{ table: 'ENG_SHEETS', mode: 'replace', rows: env.table('ENG_SHEETS').filter((r) => r.plan_id !== planA).map((r) => { const { _row, ...o } = r; return o; }) }] }),
  });
  env.run('appProps_().setProperty("APP_WRITE_JOURNAL", __v)', { __v: JSON.stringify({ id: 'JNL-old', fileId: oldJnl, label: '古い保存', planId: planA, at: '2026-01-01T00:00:00.000Z' }) });
  assert.throws(() => env.run('appWithLock_(() => appJournalRecover_({ requestId: "t" }))'), /締め済み|読み取り専用/, '凍結の計画の行を消す古い控えの書き直しは止まる');
  assert.equal(env.run('appProps_().getProperty("APP_WRITE_JOURNAL")') !== null, true, '控えの記録は残る');
  assert.equal(env.files[oldJnl].trashed, false, '控えのファイルは残る');
  env.run('appProps_().deleteProperty("APP_WRITE_JOURNAL")');
  // 開いている年度への普通の書き込みは変わらず動く
  env.run('appWithLock_(() => appJournalRun_({ actor: __by, requestId: "t" }, "テストの保存", __p, [{ table: "PLANS", mode: "patch", key: { plan_id: __p }, patch: { note: "open は書ける" } }]))', { __p: planC, __by: OWNER });
  assert.equal(env.table('PLANS').filter((p) => p.plan_id === planC)[0].note, 'open は書ける', '開いている年度は普通に書ける');
}

console.log('app-year-close: all tests passed');
