/**
 * app-versions.test.mjs — 公式版（確定した予測と予算）と承認。
 */
import assert from 'node:assert/strict';
import { OWNER, setUpEnv } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const env = setUpEnv();
const output = [['FY2026 売上予測（テスト製薬）']];
for (let r = 2; r <= 25; r++) output.push([]);
output.push(['年度合計（予測）', 900, 1000, 1100]);
output.push([], []);
for (let i = 0; i < 12; i++) output.push([D(2026, 4 + i), 70, 80, 90, '', '', '', 80, i === 11 ? 5 : '', '']);
const book = env.makeBook('クライアント別売上予測', {
  CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', 'テスト製薬'], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
  OUTPUT: { values: output },
});
const planId = env.seedPlan(book);
const clientId = env.table('PLANS')[0].client_id;

// 予算策定担当（このクライアント）と承認者を登録する
const PLANNER = 'planner@bigm2y.com', APPROVER = 'approver@bigm2y.com';
for (const [email, role, scope] of [[PLANNER, 'PLANNER', 'CLIENT'], [APPROVER, 'APPROVER', 'ALL']]) {
  env.task('saveMember(__in)', { __in: { email, displayName: email.split('@')[0], department: '営業' } });
  env.task('grantRole(__in)', { __in: { email, role, scopeType: scope, clientId: scope === 'CLIENT' ? clientId : '' } });
}

// ==== 1. 今の数字（年度・月ごと・予算） ====
env.as(PLANNER);
let list = env.call('apiVersionList(__in)', { __in: { planId } });
assert.equal(list.current.annual.p50, 1000);
assert.equal(list.current.budget.adopted, 960);
assert.equal(list.current.budget.uplift, 5);
assert.equal(list.current.budget.final, 965);
assert.equal(list.current.monthly.length, 12);
assert.deepEqual(list.can, { submit: true, approve: false });
assert.equal(list.versions.length, 0);

// ==== 2. 出す → 承認待ち。出した本人は承認できない ====
const sub = env.call('appTestVersionSubmit_(__in)', { __in: { planId, note: '10 月の見直し', inputHash: list.inputHash } });
assert.equal(sub.version.no, 1);
assert.equal(sub.version.state, 'SUBMITTED');
assert.equal(sub.version.budget.final, 965);
assert.throws(() => env.call('appTestVersionDecide_(__in)', { __in: { versionId: sub.version.versionId, decision: 'APPROVED' } }), /権限/, '予算策定担当は承認できない');
assert.throws(() => env.call('appTestVersionSubmit_(__in)', { __in: { planId, note: '=HYPERLINK("x")' } }), /数式として動いてしまう文字/);

// ==== 3. 承認者が承認 → 公式版。却下は理由が要る ====
env.as(APPROVER);
assert.throws(() => env.call('appTestVersionDecide_(__in)', { __in: { versionId: sub.version.versionId, decision: 'REJECTED' } }), /理由/);
const ok = env.call('appTestVersionDecide_(__in)', { __in: { versionId: sub.version.versionId, decision: 'APPROVED', note: '確認しました', rowVersion: sub.version.rowVersion } });
assert.equal(ok.version.state, 'APPROVED');
assert.throws(() => env.call('appTestVersionDecide_(__in)', { __in: { versionId: sub.version.versionId, decision: 'APPROVED' } }), /承認待ちではありません/);

// ==== 4. 次の版: 前の承認待ちは取り下げ、承認すると前の公式版は置き換わる。出した版の数字は変わらない ====
env.as(PLANNER);
const s2 = env.call('appTestVersionSubmit_(__in)', { __in: { planId, note: '2 回目' } });
const s3 = env.call('appTestVersionSubmit_(__in)', { __in: { planId, note: '3 回目' } });
assert.deepEqual(s3.withdrawn, [2]);
env.as(APPROVER);
const ok3 = env.call('appTestVersionDecide_(__in)', { __in: { versionId: s3.version.versionId, decision: 'APPROVED' } });
assert.deepEqual(ok3.superseded, [1]);
list = env.call('apiVersionList(__in)', { __in: { planId } });
assert.deepEqual(list.versions.map((v) => [v.no, v.state]), [[3, 'APPROVED'], [2, 'WITHDRAWN'], [1, 'SUPERSEDED']]);
assert.equal(list.official.no, 3);
assert.equal(list.versions[2].monthly[11].final, 85, '出した版の月の数字が残る');

// ==== 4b. 承認が止められたとき（画面が古い）は、前の公式版をそのまま残す ====
env.as(PLANNER);
const s4 = env.call('appTestVersionSubmit_(__in)', { __in: { planId, note: '4 回目' } });
env.as(APPROVER);
assert.throws(() => env.call('appTestVersionDecide_(__in)', { __in: { versionId: s4.version.versionId, decision: 'APPROVED', rowVersion: 99 } }), /先に更新しました/);
assert.equal(env.call('apiVersionList(__in)', { __in: { planId } }).official.no, 3, '公式版は v3 のまま');
env.call('appTestVersionDecide_(__in)', { __in: { versionId: s4.version.versionId, decision: 'REJECTED', note: '見直し中' } });

// ==== 5. 一覧に公式版が出る。記録に残る ====
const pf = env.call('apiPortfolio()').plans[0];
assert.equal(pf.officialNo, 3);
assert.equal(pf.officialFinal, 965);
assert.ok(env.audit().some((a) => a.action === 'VERSION.DECIDE' && a.phase === 'END' && a.actor_email === APPROVER));

// ==== 6. 社内の人は見られるが、出せない ====
env.as('someone@bigm2y.com');
assert.equal(env.call('apiVersionList(__in)', { __in: { planId } }).can.submit, false);
assert.throws(() => env.call('appTestVersionSubmit_(__in)', { __in: { planId } }), /権限/);
env.as(OWNER);

// ==== 7. 同時保存の衝突の印は必須（2026-10-13。省くと後から書いた方が勝っていた）: 出すには開いたときの指紋、判断には行の版、計画への保存には指紋 ====
{
  env.as(PLANNER);
  const v0 = env.table('PLAN_VERSIONS').length;
  for (const hash of [undefined, null, '']) {
    assert.throws(() => env.call('apiVersionSubmit(__in)', { __in: { planId, note: '印なし', inputHash: hash } }), /画面が古いので、読み直してから/, '指紋の無い公式版は出さない: ' + hash);
  }
  assert.equal(env.table('PLAN_VERSIONS').length, v0, '版を足さない（承認待ちも取り下げない）');
  assert.throws(() => env.call('apiVersionSubmit(__in)', { __in: { planId, inputHash: 'f'.repeat(64) } }), /画面を開いた後に計画が変わりました/, '違う指紋は前と同じく断る');
  const s5 = env.call('apiVersionSubmit(__in)', { __in: { planId, note: '5 回目', inputHash: env.call('apiVersionList(__in)', { __in: { planId } }).inputHash } });
  env.as(APPROVER);
  for (const rv of [undefined, null, '']) {
    assert.throws(() => env.call('apiVersionDecide(__in)', { __in: { versionId: s5.version.versionId, decision: 'APPROVED', rowVersion: rv } }), /画面が古いので、読み直してから/, '行の版の無い判断はしない: ' + rv);
  }
  assert.equal(env.table('PLAN_VERSIONS').find((v) => v.version_id === s5.version.versionId).state, 'SUBMITTED', '承認待ちのまま');
  assert.equal(env.call('apiVersionList(__in)', { __in: { planId } }).official.no, 3, '公式版も置き換えない');
  assert.equal(env.call('apiVersionDecide(__in)', { __in: { versionId: s5.version.versionId, decision: 'REJECTED', note: '印あり', rowVersion: s5.version.rowVersion } }).version.state, 'REJECTED');
  // 計画への保存（PLAN.EDIT）: 始める前に断る（処理を入れない）。待ち行列に直接入った処理も、書く前に断る
  env.as(PLANNER);
  const jobs = () => Object.keys(env.props).filter((k) => /^APP_JOB_(?!RESULT_|STAGE)/.test(k)).length;
  const j0 = jobs();
  const rows0 = JSON.stringify(env.table('ENG_ROWS').filter((r) => r.plan_id === planId));
  for (const hash of [undefined, '', 'abc']) {
    assert.throws(() => env.call('apiStartJob(__in)', { __in: { kind: 'PLAN.EDIT', payload: { planId, action: 'BUDGET.SAVE', args: { rows: [{ row: 29, adopted: 1, uplift: '' }] }, inputHash: hash } } }),
      /画面が古いので、読み直してから/, '指紋の無い保存は始めない: ' + hash);
  }
  assert.equal(jobs(), j0, '処理を入れない');
  env.as(OWNER);
  const id = env.run(`appWithLock_(() => appEnqueueJob_('PLAN.EDIT', __p, '${PLANNER}', '').id)`, { __p: { planId, action: 'BUDGET.SAVE', args: { rows: [{ row: 29, adopted: 1, uplift: '' }] } } });
  env.fireTriggers('triggerRunJob');
  const st = env.call('appJobGet_(__id)', { __id: id });
  assert.deepEqual([st.status, st.error], ['FAILED', '画面が古いので、読み直してからもう一度操作してください。'], '中でも断る');
  assert.equal(JSON.stringify(env.table('ENG_ROWS').filter((r) => r.plan_id === planId)), rows0, '何も書かない');
  // 画面と同じく開いたときの指紋を渡せば保存できる
  const ok = env.runJob('PLAN.EDIT', { planId, action: 'SETUP.PEOPLE', args: { peopleCsv: '鷹野, 佐藤' }, inputHash: env.call('apiPlanView(__in)', { __in: { planId } }).inputHash });
  assert.equal(ok.status, 'DONE', ok.error);
  assert.equal(env.table('PLANS').find((p) => p.plan_id === planId).people_csv, '鷹野,佐藤');
}
console.log('app-versions: all tests passed');
