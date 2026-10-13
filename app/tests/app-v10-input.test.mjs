#!/usr/bin/env node
/*
 * app-v10-input.test.mjs — 入力の記録（INPUT_LOG。SCHEMA_PLAN_v10-12_JA.md の 3-1。2026-10-08 村井さん承認「版10はおすすめで」）。
 * 本物の A-1（計画を作る）・A-2（売上の取り込み）・入力の保存（旧来の webSaveInputs）をモックの上で動かして確かめる。
 *   1. 計画を作る: 入力の行があれば、計画の行と同じ控えで ADD（操作は計画を作る・番号は控えの番号）。無ければ何も足さない
 *   2. A-2 でひな形の行が足されたときも ADD で残る（同じ印の 2 行目からは #2…#10）。本体と同じ控えで書く
 *   3. 入力の保存: 変わった行だけ（前と後・担当者・保存した人・時刻・操作の番号）。担当者を入れた行は同じ位置なので「変えた」。
 *      自信は記録にだけ（旧来の表に列も値も入らない）。自信だけ変えたら CONF（入力のハッシュも予測の種も変わらない）。同じ中身の保存では足さない
 *   4. 外した行（REMOVE）と、同じ印の行（#n）。見解・スポットの行に自信は付かない。選べない自信・長すぎる保存の理由は保存しない
 *   5. 控えの書き直しで二重にならない（記録の表に書く途中で止まっても、書き直しで 1 回だけ足す）
 *   6. 見られる人: 予算策定担当以上（そのメーカーの担当を含む）は全部。閲覧の人には行を送らない（種類ごとの件数だけ）。
 *      人のつなぎで本人と分かる閲覧の人には本人の行だけ（担当者の名前・保存した人は送らない）
 *   7. 一度だけの写し（BASELINE）: 今の 4 つの表の行を 1 回だけ。締めた年度の計画は飛ばす。2 回動かしても増えない
 *   8. 画面: 自信の欄（製品・メーカー全体だけ）と、行ごとの変わった跡（カーソル）。保存では画面だけの印を送らない。旧来の番号を出さない
 *   9. 切り詰めた（4 万字を超えた）セルが無い。記録は計算に使わない（計算用ブックに記録の表が無い・予測の種が見る表に無い）
 * 名前と数字はテスト用の架空のもの。本物の Apps Script での確認の代わりではない。
 *
 *   node app/tests/app-v10-input.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setUpEnv, uiHtml, OWNER, MEMBER, OTHER } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const CLIENT = 'テスト製薬';
const env = setUpEnv();
const FY = env.run('appFy_(new Date())');
const YM = FY + '-04';   // A-2 のひな形の月（年度の初め）
const PLANNER_HERE = 'planner.here@bigm2y.com';
const logOf = (planId) => env.call('appInputLogRead_(__p)', { __p: planId });
const json = (v) => (v === '' ? '' : JSON.parse(v));
const view = (planId, email = OWNER) => { env.as(email); try { return env.call('apiPlanView(__in)', { __in: { planId } }); } finally { env.as(OWNER); } };
const lastAction = (planId, action) => env.table('PLAN_ACTIONS').filter((r) => r.plan_id === planId && r.action === action).slice(-1)[0];
const save = (planId, kind, rows, extra) => {
  const st = env.runJob('PLAN.EDIT', { planId, action: 'INPUT.SAVE', args: Object.assign({ kind, rows }, extra || {}), inputHash: view(planId).inputHash });
  return st;
};

// ---- 準備: ZAC の実績（製品 2 つ）と、本物の A-1 で作った計画 ----
const ext = Array.from({ length: 70 }, () => '');
const rec = (client, product, month, amount) => { const r = ext.slice(); r[40] = client; r[45] = 'ベース'; r[49] = product; r[56] = month; r[65] = amount; return r; };
const zacRows = [ext.map((_, i) => 'c' + (i + 1))];
for (let m = 1; m <= 12; m++) {
  zacRows.push(rec(CLIENT, '製品A', D(FY - 1, m, 15), 1000000), rec(CLIENT, '製品B', D(FY - 1, m, 15), 400000), rec('テスト薬品', '製品X', D(FY - 1, m, 15), 300000));
}
const zac = env.makeBook('売上の元', { ['*' + (FY - 1) + '_actual_value']: { cols: 70, values: zacRows } });
env.task('saveSetting(__in)', { __in: { key: 'source.zac_spreadsheet', value: 'https://docs.google.com/spreadsheets/d/' + zac.getId() + '/edit' } });

// ==== 1. 計画を作る ====
let planId;
{
  const st = env.runJob('PLAN.CREATE', { clientName: CLIENT, fy: FY, peopleCsv: '鷹野,佐藤' });
  assert.equal(st.status, 'DONE', st.error);
  planId = st.result.planId;
  assert.equal(logOf(planId).length, 0, 'A-1 の入力の表は見出しだけなので、記録は足さない');
  // 入力の行が入った計画を作ると（A-1 の後にスポットの行がある形）、計画の行と同じ控えで ADD を足す
  env.run(`__baseSetup = appLegacySetupBook_; appLegacySetupBook_ = function (book) {
    const r = __baseSetup.apply(null, arguments);
    book.getSheetByName('DEV_SPOT').getRange(2, 1, 1, 5).setValues([['佐藤', new Date(${FY}, 5, 1), '初めの案件', 300000, 0.5]]);
    return r; };`);
  const st2 = env.runJob('PLAN.CREATE', { clientName: 'テスト薬品', fy: FY, peopleCsv: '佐藤' });
  env.run('appLegacySetupBook_ = __baseSetup;');
  assert.equal(st2.status, 'DONE', st2.error);
  assert.equal(st2.result.written.INPUT_LOG.appended, 1, '計画の作成と同じ控えで書く');
  const l2 = logOf(st2.result.planId);
  assert.deepEqual(l2.map((r) => [r.action, r.kind, r.change, r.row_key, r.person, r.before_json, r.self_conf]),
    [['PLAN.CREATE', 'devspot', 'ADD', 'devspot|佐藤|' + FY + '-06|初めの案件', '佐藤', '', '']]);
  assert.match(l2[0].action_id, /^NEW-/, '操作の番号は計画を作った控えの番号');
  assert.deepEqual(json(l2[0].after_json), { person: '佐藤', ym: FY + '-06', project: '初めの案件', amount: 300000, conf: 0.5 });
  assert.match(l2[0].log_id, /^INL-\d{14}-[0-9A-F]{12}$/);
}

// ==== 2. A-2 のひな形の行 ====
{
  const st = env.runJob('PLAN.RUN', { planId, action: 'IMPORT.SALES' });
  assert.equal(st.status, 'DONE', st.error);
  assert.equal(st.result.written.INPUT_LOG.appended, 24, '取り込みの保存と同じ控えで書く（製品 2・メーカー全体 10・見解 2・スポット 10）');
  const log = logOf(planId);
  const actionId = lastAction(planId, 'IMPORT.SALES').action_id;
  assert.ok(log.every((r) => r.action === 'IMPORT.SALES' && r.action_id === actionId && r.change === 'ADD' && r.actor_email === OWNER && r.before_json === '' && r.saved_at));
  const keys = (kind) => log.filter((r) => r.kind === kind).map((r) => r.row_key);
  assert.deepEqual(keys('product'), ['product||製品A|' + YM, 'product||製品B|' + YM]);
  assert.deepEqual(keys('client'), ['client||' + YM].concat([2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => 'client||' + YM + '#' + n)), '同じ印の 2 行目からは #2');
  assert.deepEqual(keys('opinions'), ['opinions|鷹野|' + YM, 'opinions|佐藤|' + YM]);
  assert.equal(keys('devspot')[9], 'devspot||' + YM + '|#10');
  assert.deepEqual(json(log.find((r) => r.kind === 'client').after_json), { person: '', ym: YM, step: '0%', reason: '' });
}

// ==== 3. 入力の保存: 変わった行だけ・自信は記録にだけ・自信だけ変えたら CONF ====
{
  const n0 = logOf(planId).length;
  const v = view(planId);
  assert.equal(v.inputLog.rows.product.length, v.boot.input.product.length, '画面の入力の行と同じ並び');
  const rows = v.boot.input.product.map((r, i) => Object.assign({}, r, i === 0 ? { person: '鷹野', step: '+5%', reason: '新規', selfConf: '高い' } : { selfConf: '' }));
  const st = save(planId, 'product', rows);
  assert.equal(st.status, 'DONE', st.error);
  assert.deepEqual(st.result.changed, ['PRODUCT']);
  assert.equal(st.result.written.INPUT_LOG.appended, 1, '入力の保存と同じ控えで書く');
  const add = logOf(planId).slice(n0);
  assert.equal(add.length, 1, '変わった行だけ（製品B の行はそのまま）');
  const r = add[0];
  assert.deepEqual([r.action, r.action_id, r.kind, r.change, r.row_key, r.person, r.self_conf, r.actor_email, r.reason, r.signal_id],
    ['INPUT.SAVE', lastAction(planId, 'INPUT.SAVE').action_id, 'product', 'CHANGE', 'product|鷹野|製品A|' + YM, '鷹野', '高い', OWNER, '', ''],
    '担当者を入れた行は同じ位置なので「変えた」。操作の番号は PLAN_ACTIONS と同じ');
  assert.deepEqual(json(r.before_json), { person: '', product: '製品A', ym: YM, step: '0%', reason: '' });
  assert.deepEqual(json(r.after_json), { person: '鷹野', product: '製品A', ym: YM, step: '+5%', reason: '新規' });
  // 旧来の表（PRODUCT）に自信の列も値も入らない
  const eng = env.table('ENG_PRODUCT').filter((x) => x.plan_id === planId);
  assert.deepEqual(env.call('APP_TABLES.ENG_PRODUCT.columns'), ['plan_id', 'seq', 'Person', 'ProductName', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason', '_types']);
  assert.ok(eng.every((x) => !Object.values(x).some((c) => /高い|ふつう|低い/.test(String(c)))), '自信は旧来の表に書かない');
  assert.equal(env.scratch().getSheetByName('PRODUCT').getLastColumn(), 5, '計算用ブックの PRODUCT も 5 列のまま');
  // 自信だけ変える → CONF。入力のハッシュも予測の種が見るハッシュも変わらない（記録は計算に使わない）
  const hash0 = [env.call('appPlanInputHash_(__p)', { __p: planId }), env.call('appForecastInputHash_(__p)', { __p: planId })];
  const v2 = view(planId);
  assert.equal(v2.inputLog.rows.product[0].conf, '高い', '画面には、その行の一番新しい自信');
  const rows2 = v2.boot.input.product.map((x, i) => Object.assign({}, x, { selfConf: i === 0 ? '高い' : 'ふつう' }));
  const st2 = save(planId, 'product', rows2);
  assert.equal(st2.status, 'DONE', st2.error);
  assert.deepEqual(st2.result.changed, [], '入力の表は変わらない');
  const conf = logOf(planId).slice(n0 + 1);
  assert.deepEqual(conf.map((x) => [x.change, x.row_key, x.self_conf, x.before_json === '', !!x.after_json]), [['CONF', 'product||製品B|' + YM, 'ふつう', true, true]]);
  assert.deepEqual([env.call('appPlanInputHash_(__p)', { __p: planId }), env.call('appForecastInputHash_(__p)', { __p: planId })], hash0);
  assert.equal(view(planId).inputLog.rows.product[1].conf, 'ふつう');
  // 同じ中身・同じ自信でもう一度保存しても、記録は増えない
  const n1 = logOf(planId).length;
  assert.equal(save(planId, 'product', rows2).status, 'DONE');
  assert.equal(logOf(planId).length, n1);
}

// ==== 4. 外した行・同じ印の行・自信の付かない種類・止める入力 ====
{
  const n0 = logOf(planId).length;
  const v = view(planId);
  // メーカー全体: 10 行のひな形の 1 行目に担当者を入れ、4 行目から後ろを外す
  const rows = v.boot.input.client.slice(0, 3).map((x, i) => Object.assign({}, x, i === 0 ? { person: '佐藤', step: '-3%', reason: '全体', selfConf: '低い' } : {}));
  const st = save(planId, 'client', rows);
  assert.equal(st.status, 'DONE', st.error);
  const add = logOf(planId).slice(n0);
  assert.deepEqual(add.map((x) => [x.change, x.row_key, x.self_conf]),
    [['ADD', 'client|佐藤|' + YM, '低い']].concat([3, 4, 5, 6, 7, 8, 9, 10].map((n) => ['REMOVE', 'client||' + YM + '#' + n, ''])),
    '同じ印のひな形は上から同じ印どうしで比べる（残った 2 行は同じ中身）。担当者を入れた行は新しい印（同じ位置の前の行の印が残るので ADD）。外した行は REMOVE');
  assert.ok(add.filter((x) => x.change === 'REMOVE').every((x) => x.after_json === '' && json(x.before_json).ym === YM));
  // 見解: 自信は付かない（画面が送っても書かない）
  const n1 = logOf(planId).length;
  const ops = v.boot.input.opinions.map((x) => Object.assign({}, x, x.person === '鷹野' ? { step: '+5%', conf: 0.6, note: '採用が広がる', selfConf: '高い' } : {}));
  assert.equal(save(planId, 'opinions', ops).status, 'DONE');
  const op = logOf(planId).slice(n1);
  assert.deepEqual(op.map((x) => [x.kind, x.change, x.row_key, x.self_conf]), [['opinions', 'CHANGE', 'opinions|鷹野|' + YM, '']]);
  assert.deepEqual(json(op[0].after_json), { person: '鷹野', ym: YM, step: '+5%', conf: 0.6, note: '採用が広がる' });
  // 選べない自信・長すぎる保存の理由は保存しない（何も書かない）
  const n2 = logOf(planId).length;
  const bad = save(planId, 'product', view(planId).boot.input.product.map((x) => Object.assign({}, x, { selfConf: 'とても高い' })));
  assert.equal(bad.status, 'FAILED');
  assert.match(bad.error, /自信は「高い」「ふつう」「低い」から/);
  const long = save(planId, 'product', view(planId).boot.input.product, { reason: 'x'.repeat(201) });
  assert.equal(long.status, 'FAILED');
  assert.match(long.error, /保存の理由は 200 字まで/);
  assert.equal(logOf(planId).length, n2);
  // 保存の理由（任意）は、その保存の行に残る
  const pr = view(planId).boot.input.product.map((x, i) => Object.assign({}, x, i === 1 ? { step: '-5%', reason: '値下げ' } : {}));
  assert.equal(save(planId, 'product', pr, { reason: '会議で決めた' }).status, 'DONE');
  const withReason = logOf(planId).slice(n2);
  assert.deepEqual(withReason.map((x) => [x.change, x.row_key, x.reason, x.self_conf]), [['CHANGE', 'product||製品B|' + YM, '会議で決めた', 'ふつう']],
    '自信を送らない保存は、今の自信のまま（CONF も足さない。空を送ったときだけ外す）');
}

// ==== 5. 控えの書き直しで二重にならない ====
{
  const n0 = logOf(planId).length;
  const sh = env.data().getSheetByName('INPUT_LOG');
  sh.failWrites = true;
  const ds = view(planId).boot.input.devspot.map((x, i) => Object.assign({}, x, i === 0 ? { person: '鷹野', project: '追加の開発', amount: 500000, conf: 0.8 } : {}));
  const st = save(planId, 'devspot', ds);
  sh.failWrites = false;
  assert.equal(st.status, 'FAILED');
  const pending = env.call('appJournalPending_()');
  assert.ok(pending, '控えが残る');
  const body = JSON.parse(env.files[pending.fileId].content);
  const appendOps = body.ops.filter((o) => o.table === 'INPUT_LOG');
  assert.deepEqual(appendOps.map((o) => [o.mode, o.rows.length]), [['append', 2]], '記録の行は控えに入っている（番号も控えを作るときに決めた）');
  assert.equal(logOf(planId).length, n0, '記録の表には、まだ書けていない');
  const rec = env.call(`appWithLock_(() => appJournalRecover_({ actor: '${OWNER}', requestId: 'T' }))`);
  assert.equal(rec.written.INPUT_LOG.appended, 2);
  assert.equal(logOf(planId).length, n0 + 2);
  const again = env.call('appWithLock_(() => appJournalApply_(__o))', { __o: body.ops });
  assert.equal(again.INPUT_LOG.appended, 0, 'もう一度書き直しても増えない');
  assert.equal(logOf(planId).length, n0 + 2);
  const add = logOf(planId).slice(n0);
  assert.deepEqual(add.map((r) => [r.kind, r.change, r.row_key, r.log_id]).sort(), [['devspot', 'ADD', 'devspot|鷹野|' + YM + '|追加の開発', appendOps[0].rows[0].log_id],
    ['devspot', 'REMOVE', 'devspot||' + YM + '|#10', appendOps[0].rows[1].log_id]].sort(), '1 行目に入れた案件は新しい印。同じ印のひな形が 1 つ減る');
  assert.equal(env.table('ENG_DEV_SPOT').filter((x) => x.plan_id === planId && x.Project === '追加の開発').length, 1, '本体も書き直しで 1 回だけ');
}

// ==== 6. 見られる人 ====
{
  const clientId = env.table('PLANS').find((p) => p.plan_id === planId).client_id;
  for (const email of [MEMBER, OTHER, PLANNER_HERE]) env.task(`saveMember({ email: '${email}', displayName: 'T' })`);
  env.task('grantRole(__in)', { __in: { email: PLANNER_HERE, role: 'PLANNER', scopeType: 'CLIENT', clientId } });
  env.call('appWithLock_(() => appInsertRows_("PERSON_LINKS", __r))', { __r: [{ link_id: 'PLK-T1', person_name: '鷹野', email: OTHER, client_id: '', valid_from: '', valid_to: '',
    is_active: true, note: '', created_at: 'now', created_by: OWNER, updated_at: 'now', updated_by: OWNER, row_version: 1 }] });
  const total = logOf(planId).length;
  // 予算策定担当（そのメーカー）・管理者: 全部（保存した人も）
  for (const email of [OWNER, PLANNER_HERE]) {
    const il = view(planId, email).inputLog;
    assert.equal(il.full, true, email);
    assert.equal(il.hidden, 0);
    assert.equal(il.rows.product[0].hist[0].by, OWNER, '保存した人');
    assert.equal(il.rows.product[0].hist[0].after.person, '鷹野');
  }
  // 閲覧の人（つなぎなし）: 行は送らない。種類ごとの件数だけ
  const vm0 = view(planId, MEMBER);
  assert.equal(vm0.can.plan, false);
  assert.equal(vm0.inputLog.full, false);
  assert.ok(Object.values(vm0.inputLog.rows).every((list) => list.every((x) => x === null)), '閲覧の人に記録の行を送らない');
  assert.equal(vm0.inputLog.hidden, total);
  assert.deepEqual(Object.keys(vm0.inputLog.counts).sort(), ['client', 'devspot', 'opinions', 'product']);
  assert.equal(Object.values(vm0.inputLog.counts).reduce((a, b) => a + b, 0), total);
  assert.doesNotMatch(JSON.stringify(vm0.inputLog), /鷹野|佐藤|@|INL-|before|after/, '名前・メール・記録の中身を送らない');
  // 閲覧の人（つなぎで 鷹野 と分かる）: 鷹野 の行だけ。その中でも担当者の名前と保存した人は送らない
  const vo = view(planId, OTHER).inputLog;
  assert.equal(vo.full, false);
  const own = Object.entries(vo.rows).flatMap(([k, list]) => list.map((x, i) => [k, i, x]).filter((t) => t[2]));
  assert.deepEqual(own.map((t) => t[0]).sort(), ['devspot', 'opinions', 'product'], '鷹野 の行だけ');
  assert.equal(vo.rows.product[0].conf, '高い', '本人の行の自信');
  assert.doesNotMatch(JSON.stringify(vo), /鷹野|佐藤|@/, '担当者の名前と保存した人は送らない');
  assert.ok(own.every((t) => t[2].hist.every((h) => h.by === '' && (!h.after || !('person' in h.after)))));
  assert.equal(vo.hidden, total - own.reduce((a, t) => a + t[2].n, 0));
}

// ==== 7. 一度だけの写し（BASELINE） ====
{
  const e2 = setUpEnv();
  const fy = e2.run('appFy_(new Date())');
  const book = (client, y) => {
    const output = [['FY' + y + ' 売上予測（' + client + '）']];
    for (let r = 2; r <= 25; r++) output.push([]);
    output.push(['年度合計（予測）', 900, 1000, 1100]);
    output.push([], []);
    for (let i = 0; i < 12; i++) output.push([D(y, 4 + i, 1), 70, 80, 90, '', '', '', 80, '']);
    return e2.makeBook(client, {
      CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', y], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
      OUTPUT: { values: output },
      PRODUCT: { values: [['Person', 'ProductName', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason'], ['鷹野', '製品A', D(y, 5), 5, '新規'], ['鷹野', '製品A', D(y, 5), 5, '新規'], ['', '', '', '', '']] },
      CLIENT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason'], ['鷹野', D(y, 6), -3, '全体']] },
      OPINIONS: { values: [['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Confidence(0..1)', 'Note']] },
      DEV_SPOT: { values: [['Person', 'Month(yyyy/mm/dd)', 'Project', 'Amount(JPY)', 'Confidence(0..1)'], ['鷹野', D(y, 7), '案件', 100000, 1]] },
    });
  };
  // 写しは止めておき、前の年度を締めてから動かす（締めた年度の計画は飛ばす）
  e2.props.APP_BACKFILLS = JSON.stringify({ done: { appV10BackfillInputLog_: { at: 'x', v: 10, rows: 0 } }, failed: {} });
  const past = e2.seedPlan(book('前の製薬', fy - 1));
  const sub = e2.call('appTestVersionSubmit_(__in)', { __in: { planId: past } });
  e2.call('appTestVersionDecide_(__in)', { __in: { versionId: sub.version.versionId, decision: 'APPROVED', rowVersion: sub.version.rowVersion } });
  const pv = e2.task('yearPreview(__in)', { __in: { fy: fy - 1 } });
  assert.equal(e2.runJob('YEAR.CLOSE', { fy: fy - 1, inputHash: pv.inputHash }).status, 'DONE');
  const cur = e2.seedPlan(book('今の製薬', fy));
  assert.equal(e2.table('INPUT_LOG').length, 0);
  e2.props.APP_BACKFILLS = JSON.stringify({ done: {}, failed: {} });
  e2.call('apiListPlans()');   // 次の操作の初めに動く
  const st = JSON.parse(e2.props.APP_BACKFILLS);
  assert.equal(st.done.appV10BackfillInputLog_.rows, 4, '済んだ（今の計画の 4 行。空の行は数えない）');
  const base = e2.table('INPUT_LOG');
  assert.ok(base.every((r) => r.plan_id === cur && r.change === 'BASELINE' && r.action === 'BASELINE' && r.before_json === '' && r.self_conf === '' && r.actor_email === 'SYSTEM:V10_BACKFILL'),
    '締めた年度の計画は飛ばす（した人は仕組み。写しを動かした操作の人ではない）');
  assert.deepEqual(base.map((r) => r.row_key), ['product|鷹野|製品A|' + fy + '-05', 'product|鷹野|製品A|' + fy + '-05#2', 'client|鷹野|' + fy + '-06', 'devspot|鷹野|' + fy + '-07|案件']);
  assert.ok(base.every((r) => /^INL-[0-9A-F]{24}$/.test(r.log_id)), '番号は計画と印から決まる（2 つの操作が同時に動かしても二重にならない）');
  assert.equal(base[0].log_id, e2.call('appStableLogId_("INL", ["BASELINE", __p, __k])', { __p: cur, __k: base[0].row_key }));
  assert.deepEqual(json(base[2].after_json), { person: '鷹野', ym: fy + '-06', step: -3, reason: '全体' });
  // もう一度動かしても増えない（BASELINE がある計画は飛ばす）
  assert.deepEqual(e2.call(`appV10BackfillInputLog_({ actor: '${OWNER}', requestId: 'T' })`), { rows: 0 });
  assert.equal(e2.table('INPUT_LOG').length, 4);
  e2.call('apiListPlans()');
  assert.equal(e2.table('INPUT_LOG').length, 4, '済んだ写しは動かさない');
  // 画面: 写した行は「記録を始めたときの姿」として、行の跡に出る
  const il = e2.call('apiPlanView(__in)', { __in: { planId: cur } }).inputLog;
  assert.deepEqual(il.rows.product.map((x) => x && x.hist[0].change), ['BASELINE', 'BASELINE']);
}

// ==== 8. 画面 ====
{
  const js = uiHtml.slice(uiHtml.indexOf('<script>') + 8, uiHtml.lastIndexOf('</script>'))
    .replace('<?!= charsJs ?>', 'var YOMI_POSE = new Proxy({}, { get: () => "" }); var CHAR_SVG = new Proxy({}, { get: () => "" });')
    .replace('<?!= bootJson ?>', JSON.stringify({ app: { name: 'T', version: 'x' }, user: { email: OWNER, isOwner: true, isAdmin: true, roles: [] }, setUp: true, allowed: true }));
  const el = () => ({ innerHTML: '', classList: { add() {}, remove() {} }, set outerHTML(v) {} });
  const ui = vm.createContext({ document: { getElementById: el, querySelector: () => null, addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, confirm: () => false,
    window: { addEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    google: { script: { run: new Proxy({}, { get: (t, k) => (k === 'withSuccessHandler' || k === 'withFailureHandler' ? () => ui.google.script.run : () => {}) }) } } });
  vm.runInContext(js, ui);
  // 少ない行の画面で確かめる（製品 2 行・メーカー全体 3 行）
  const p0 = view(planId).boot.input.product.slice(0, 2).map((x) => Object.assign({}, x));
  p0[0].selfConf = '低い';
  assert.equal(save(planId, 'product', p0).status, 'DONE');
  const render = (v, kind) => { ui.__v = v; return vm.runInContext(`S.fc.view = __v; S.fc.draft = {}; S.fc.inputDirty = {}; S.fc.inputKind = '${kind}'; fcInputCard(__v, '${kind}')`, ui); };
  const vo = view(planId);
  const html = render(vo, 'product');
  assert.match(html, /<th data-tip="この行の見立てにどれだけ自信があるか（任意）。記録にだけ残し、予測の計算には使いません">自信<\/th>/);
  assert.match(html, /<option value="低い" selected>低い<\/option>/, '一番新しい自信を選んだ形で出す');
  assert.match(html, /<td><span class="incell"><input class="inp cell" type="text"[^>]*aria-label="理由"><span class="tip"/, '跡の (i) は理由のマスの中（列を足さない。1280px の画面で枠に入れる）');
  const tips = [...html.matchAll(/class="tip"[^>]*data-tip="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(tips.length >= 2 && tips.every((t) => /^変わった跡/.test(t)), tips.join(' | '));
  assert.match(tips[0], /自信を変えた|変えた（入力の保存）・owner/, tips[0]);
  assert.match(tips.join('\n'), /増減率 0% → \+5%/, '変えた項目の前と後');
  assert.doesNotMatch(html.replace(/(data-tip|aria-label)="[^"]*"/g, ''), /変わった跡/, '跡はカーソルで出す（見える文字にしない）');
  assert.doesNotMatch(html, /INPUT\.SAVE|IMPORT\.SALES|PLAN\.CREATE|BASELINE|undefined|NaN/, '旧来・中の番号を出さない');
  // 保存: 画面だけの印（_lk・_conf0）は送らない。自信は変えた行だけ送る（変えていない行は送らない = サーバーは今の自信のまま）
  const sent = JSON.parse(vm.runInContext(`var __sent = null; var __e0 = fcEdit; fcEdit = function (a, args) { __sent = { action: a, args: args }; }; fcInput(0, 'selfConf', '高い'); fcSaveInput(); fcEdit = __e0; JSON.stringify(__sent)`, ui));
  assert.equal(sent.action, 'INPUT.SAVE');
  assert.ok(sent.args.rows.every((r) => !('_lk' in r) && !('_conf0' in r)), '画面だけの印は送らない');
  assert.deepEqual(sent.args.rows.map((r) => ('selfConf' in r ? r.selfConf : '-')), ['高い', '-']);
  // 記録が届かなかった（読めない・移行の前）ときは、自信を送らない（サーバーは今の自信のままにする。空を送って消さない）
  const none = JSON.parse(vm.runInContext(`var __s2 = null; var __e1 = fcEdit; fcEdit = function (a, args) { __s2 = args; }; var __vv = JSON.parse(JSON.stringify(__v)); __vv.inputLog = null; S.fc.view = __vv; S.fc.draft = {}; fcSaveInput(); fcEdit = __e1; JSON.stringify(__s2)`, ui));
  assert.ok(none.rows.every((r) => !('selfConf' in r) && !('_lk' in r)));
  // 見解・スポットには自信の欄が無い（跡はある）
  const ho = render(vo, 'opinions');
  assert.doesNotMatch(ho, />自信</);
  assert.match(ho, /data-tip="変わった跡/);
  // 閲覧の人（つなぎなし）: 自信の欄も跡の列も出さない
  const hv = render(view(planId, MEMBER), 'product');
  assert.doesNotMatch(hv, />自信<|変わった跡|width:56px/);
  // 本人の行だけ届く閲覧の人: 自信は文字で、跡は本人の行だけ（保存した人の名前は無い）
  const hs = render(view(planId, OTHER), 'product');
  assert.match(hs, />自信</);
  const ts = [...hs.matchAll(/class="tip"[^>]*data-tip="([^"]*)"/g)].map((m) => m[1]).filter((t) => /^変わった跡/.test(t));
  assert.equal(ts.length, 1, '鷹野 の行だけ');
  assert.match(ts[0], /自信を変えた/);
  assert.doesNotMatch(ts[0], /・owner/);
}

// ==== 9. 切り詰めたセルが無い・記録は計算に使わない ====
{
  const many = Array.from({ length: 120 }, (_, i) => ({ person: '鷹野', product: '製品' + i, ym: FY + '-08', step: '+1%', reason: '理由'.repeat(10), selfConf: i % 2 ? '高い' : '' }));
  const st = save(planId, 'product', many);
  assert.equal(st.status, 'DONE', st.error);
  assert.equal(env.call('appLogTruncatedCells_("INPUT_LOG")'), 0, '1 行の JSON は小さい（4 万字で切り詰めた行が無い）');
  assert.ok(!env.errors().some((e) => e.where === 'LOG.TRUNCATED'));
  const names = env.scratch().getSheets().map((s) => s.getName());
  assert.ok(!names.includes('INPUT_LOG'), '計算用ブックに記録の表は無い');
  assert.ok(!env.call('APP_FORECAST_SEED_SHEETS').includes('INPUT_LOG') && !env.call('Object.keys(APP_ENGINE_SHEETS)').includes('INPUT_LOG'), '予測の種・旧来の計算は記録を読まない');
}

console.log('app-v10-input: ok');
