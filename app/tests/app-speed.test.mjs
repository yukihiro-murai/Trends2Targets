#!/usr/bin/env node
/**
 * app-speed.test.mjs — 読むだけの処理を速くしても、結果は変わらない。
 *   表を読むのは 1 回（見出しと本文を一緒に読み、見出しが違えば今までどおり止める）・計画の行だけを読む・
 *   値だけを使うところは表示形式を読まない・検証の画面の控え・控えと処理の記録をまとめて読む・バックアップの要点を残す。
 *   関数の書き方（ソースの文字）には頼らない。結果は、見本のブックから決まる数字や、テストの中の素直な作り（比べる相手）と比べ、
 *   速さは表ごとに読んだ回数とセルの数で確かめる。
 *
 *   node app/tests/app-speed.test.mjs
 */
import assert from 'node:assert/strict';
import { setUpEnv, STATS, J, sha, fmtDate, OWNER } from './gas-mock.mjs';

const D = (y, m, d = 1) => new Date(y, m - 1, d);
const reset = () => { for (const k of Object.keys(STATS)) STATS[k] = k === 'bySheet' ? {} : 0; };
const reads = (name) => (STATS.bySheet[name] || { reads: 0 }).reads;
const env = setUpEnv();
const H = env.run('(() => { const o = {}; Object.keys(APP_ENGINE_SHEETS).forEach(k => { o[k] = APP_ENGINE_SHEETS[k].header || null; }); return o; })()');
/** 今の検証の版（B-2 が EVAL_LOG に書く。精度は今の版の行だけで測る。2026-10-07 D4〜D6） */
const POLICY = env.run('APP_EVAL_POLICY_VERSION');

/** 計画のブック: OUTPUT（年度合計・月ごと・採用予測と上乗せ・目標）と、検証の記録（予測は実績の over 倍） */
function book(client, base, over) {
  const out = [['FY2026 売上予測（' + client + '）']];
  for (let r = 2; r <= 25; r++) out.push([]);
  out.push(['年度合計（予測）', base * 0.9, base, base * 1.1]);
  out.push([], []);
  for (let i = 0; i < 12; i++) out.push([D(2026, 4 + i), base / 12 * 0.9, base / 12, base / 12 * 1.1, '', '', '', base / 12, i % 2 ? 5 : '']);
  for (let r = 41; r <= 64; r++) out.push([]);
  out.push(['目標', base * 0.8, base * 0.95, base * 1.05]);
  const ev = [H.EVAL_LOG];
  for (let i = 0; i < 6; i++) {
    const ym = '2025/' + String(i + 1).padStart(2, '0');
    const act = 1000 + i * 15;
    const p50 = act * over;
    for (const [sc, p] of [['nega', p50 * 0.9], ['neutral', p50], ['posi', p50 * 1.1]]) {
      ev.push(['E' + i + sc, D(2026, 1, 5), client, ym, sc, p, act, Math.abs(p - act) / act, 0, '', '', sc === 'neutral' ? 1 : 0, p - act, Math.abs(p - act), '', '', '', '', '', '', POLICY, 1]);
    }
  }
  return env.makeBook(client, {
    CONFIG: { values: [['項目', '値'], ['[必須] メーカー名（外部集計キー）', client], ['[必須] 予測年度FY（YYYY）', 2026], ['[必須] 担当者（カンマ区切り）', '鷹野']] },
    OUTPUT: { values: out, formats: { B: '#,##0', C: '#,##0' } },
    EVAL_LOG: { values: ev, formats: { D: '@' } },
    CALIBRATION_STATE: { values: [H.CALIBRATION_STATE, [client, D(2026, 1, 5), 'owner', '', '', '', 0.97, '', '{}', '', '', 1, '']] },
    // 実績の取り込み（B-1）→ 検証（B-2）の記録（2026-01-05）。精度は締まった月（月末から 5 日たってから取り込んだ月。2026-10-07 D5）だけで測るので要る
    PROCESS_STATUS: { values: [H.PROCESS_STATUS, ['step2_status', new Date(2026, 0, 5, 10), 'owner', 'success', client, 18, ''],
      ['step5_status', new Date(2026, 0, 5, 11), 'owner', 'success', client, 18, '']] },
  });
}
const SPECS = [['甲製薬', 1200, 1.08], ['乙製薬', 3600, 0.96], ['丙製薬', 2400, 1.02]];   // メーカー・年度の予測・検証の記録の予測が実績の何倍か
const ids = SPECS.map(([c, b, o]) => env.seedPlan(book(c, b, o)));
const fresh = (code, extra) => env.call(`(() => { APP_STORE_CACHE_ = {}; return ${code}; })()`, extra);
const clearCache = () => { for (const k of Object.keys(env.cache)) delete env.cache[k]; };
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg + ': ' + a + ' と ' + b);

// ---- 比べる相手（データ本体の読み方によらない） ----
const ym = (i) => fmtDate(D(2026, 4 + i), 'Asia/Tokyo', 'yyyy/MM');
/** 見本のブック（book）の OUTPUT から決まる主な結果（appStoredHeadline_ と同じ形） */
function expectHeadline(client, base) {
  const monthly = [];
  for (let i = 0; i < 12; i++) monthly.push({ month: ym(i), p10: base / 12 * 0.9, p50: base / 12, p90: base / 12 * 1.1 });
  return { title: 'FY2026 売上予測（' + client + '）', annual: { p10: base * 0.9, p50: base, p90: base * 1.1 },
    objective: { p10: base * 0.8, p50: base * 0.95, p90: base * 1.05 }, monthly };
}
/** 見本のブックの OUTPUT から決まる予測と予算（appPlanNumbers_ と同じ形。採用予測は月の P50、上乗せは 1 か月おきに 5） */
function expectNumbers(base) {
  const monthly = [];
  for (let i = 0; i < 12; i++) {
    const uplift = i % 2 ? 5 : null;
    monthly.push({ month: ym(i), p10: base / 12 * 0.9, p50: base / 12, p90: base / 12 * 1.1, adopted: base / 12, uplift, final: base / 12 + (uplift || 0) });
  }
  const sum = (k) => monthly.reduce((a, m) => (m[k] === null ? a : (a || 0) + m[k]), null);
  return { annual: { p10: base * 0.9, p50: base, p90: base * 1.1 }, budget: { adopted: sum('adopted'), uplift: sum('uplift'), final: sum('final') }, monthly };
}
/** データ本体の ENG_SHEETS を、表を全部見て計画で絞ったもの（入力のハッシュとシートごとのハッシュ） */
const planSheets = (id) => env.table('ENG_SHEETS').filter((r) => r.plan_id === id);
const expectHash = (id) => sha(planSheets(id).map((r) => r.sheet + ':' + r.content_hash).sort().join('|'));
const expectHashes = (id) => Object.fromEntries(planSheets(id).map((r) => [r.sheet, r.content_hash]));
/** code を動かしたときに読んだ表ごとの回数とセルの数（{ 表: { reads, readCells } }） */
const readsBy = (code, extra) => {
  reset();
  fresh(code, extra);
  return Object.fromEntries(Object.entries(STATS.bySheet).filter(([, b]) => b.reads > 0).map(([n, b]) => [n, { reads: b.reads, readCells: b.readCells }]));
};

// ==== 1. 計画の行だけを読む: 見本のブックから決まる数字と同じ（表が小さいとき・大きいとき）。読むのはその表の、その計画の分だけ ====
for (const minRows of [3000, 0]) {
  env.run(`appPlanReadMinRows_ = () => ${minRows}`);
  SPECS.forEach(([client, base], i) => {
    const id = ids[i];
    assert.deepEqual(fresh('appStoredHeadline_(__id)', { __id: id }), expectHeadline(client, base), `主な結果（${client}・${minRows}）`);
    assert.deepEqual(fresh('appPlanNumbers_(__id)', { __id: id }), expectNumbers(base), `予測と予算（${client}・${minRows}）`);
    assert.equal(fresh('appPlanInputHash_(__id)', { __id: id }), expectHash(id), `入力のハッシュはその計画の行だけから（${client}・${minRows}）`);
    assert.deepEqual(fresh('appStoredHashes_(__id)', { __id: id }), expectHashes(id), `シートごとのハッシュ（${client}・${minRows}）`);
  });
}
assert.deepEqual([expectNumbers(1200).budget.uplift, expectNumbers(1200).monthly[1].final], [30, 105], '比べる相手の作りの確かめ');
{
  const whole = {};
  for (const table of ['ENG_ROWS', 'ENG_SHEETS']) whole[table] = readsBy(`appReadTable_('${table}')`)[table].readCells;
  for (const [fn, table] of [['appStoredHeadline_', 'ENG_ROWS'], ['appPlanNumbers_', 'ENG_ROWS'], ['appPlanInputHash_', 'ENG_SHEETS'], ['appStoredHashes_', 'ENG_SHEETS']]) {
    env.run('appPlanReadMinRows_ = () => 3000');
    let by = readsBy(`${fn}(__id)`, { __id: ids[2] });
    assert.deepEqual(Object.keys(by), [table], `${fn} が読むのは ${table} だけ`);
    assert.equal(by[table].reads, 1, `${fn}: 小さい表は 1 回で読む`);
    env.run('appPlanReadMinRows_ = () => 0');
    by = readsBy(`${fn}(__id)`, { __id: ids[2] });
    assert.deepEqual(Object.keys(by), [table], `${fn} が読むのは ${table} だけ（大きい表）`);
    assert.ok(by[table].readCells < whole[table] / 2, `${fn}: 大きい表は計画の行だけを読む: ${whole[table]} → ${by[table].readCells}`);
  }
  env.run('appPlanReadMinRows_ = () => 3000');
}

// ==== 2. 表を読むのは 1 回（見出しと本文を一緒に）。最後の行も調べ直さない。見出しが違えば今までどおり止める ====
{
  reset();
  const plans = fresh("appReadTable_('PLANS').length");
  assert.equal(plans, 3);
  assert.equal(reads('PLANS'), 1, '見出しと本文を 1 回で読む');
  const sh = env.data().getSheetByName('ENG_ROWS');
  const orig = sh.getLastRow;
  let lastRows = 0;
  sh.getLastRow = () => { lastRows++; return orig(); };
  reset();
  assert.ok(fresh("appReadPlanTable_('ENG_ROWS', __id).length", { __id: ids[0] }) > 0);
  assert.deepEqual([reads('ENG_ROWS'), lastRows], [1, 1], '小さい表: 読むのも最後の行を調べるのも 1 回');
  sh.getLastRow = orig;
  // 書いた後に読み直すときは、見出しを確かめ直さない（本文だけ）
  reset();
  env.run("(() => { APP_STORE_CACHE_ = {}; appReadTable_('PLANS'); appStoreForget_('PLANS'); return appReadTable_('PLANS').length; })()");
  assert.equal(reads('PLANS'), 2);
  // 見出しが定義と違えば止める（全部読む・計画の行だけ読む・書く、のどれでも）
  for (const name of ['PLANS', 'ENG_SHEETS']) {
    const s = env.data().getSheetByName(name);
    const keep = s.rows[0][1];
    s.rows[0][1] = '壊れた見出し';
    const re = new RegExp('表の列が定義と違います（' + name + '）');
    assert.throws(() => fresh(`appReadTable_('${name}')`), re);
    if (name === 'ENG_SHEETS') {
      for (const minRows of [3000, 0]) {
        env.run(`appPlanReadMinRows_ = () => ${minRows}`);
        assert.throws(() => fresh(`appReadPlanTable_('ENG_SHEETS', __id)`, { __id: ids[0] }), re, '計画の行だけ読むときも止める: ' + minRows);
      }
      env.run('appPlanReadMinRows_ = () => 3000');
    }
    assert.throws(() => fresh(`appTableSheet_('${name}', false)`), re, '書く前の確かめも今までどおり');
    s.rows[0][1] = keep;
    assert.ok(fresh(`appReadTable_('${name}').length`) > 0, '直せば読める');
  }
  assert.equal(env.call('apiListPlans()').plans.length, 3, '直した後は画面も読める');
}

// ==== 3. 値だけを使うところは表示形式（ENG_FORMATS）を読まない。値と数式は同じ ====
{
  const full = fresh('appEngLoadPlanSheets_(__id)', { __id: ids[0] });
  const vals = fresh('appEngLoadPlanSheets_(__id, null, true)', { __id: ids[0] });
  assert.deepEqual(Object.keys(vals).sort(), Object.keys(full).sort());
  for (const n of Object.keys(full)) {
    assert.deepEqual([vals[n].values, vals[n].formulas, vals[n].lastRow, vals[n].lastCol, vals[n].maxRows], [full[n].values, full[n].formulas, full[n].lastRow, full[n].lastCol, full[n].maxRows], n + ' の値と数式は同じ');
    assert.equal(vals[n].fmtCols, 0);
  }
  assert.ok(Object.values(full).some((s) => s.formats.some((r) => r.some((f) => f !== ''))), '全部読むときは表示形式もある');
  reset();
  const names = ['EVAL_LOG', 'CALIBRATION_STATE'];
  const t = fresh('appEngTableObjects_(__id, __names)', { __id: ids[0], __names: names });
  assert.equal(reads('ENG_FORMATS'), 0, '表示形式は読まない');
  assert.equal(t.EVAL_LOG.length, 18);
  assert.equal(t.CALIBRATION_STATE[0].bias_correction_factor, 0.97);
  // 比べる相手: 表示形式も読んだシートから、1 行目を見出しにして、空でない行を見出し → 値にしたもの
  const ref = Object.fromEntries(names.map((n) => {
    const head = full[n].values[0].map(String);
    return [n, full[n].values.slice(1).filter((r) => r.some((v) => v !== '' && v !== null)).map((r) => Object.fromEntries(head.map((h, j) => [h, r[j]]).filter(([h]) => h)))];
  }));
  assert.deepEqual(t, ref, '表の形のシートを見出し → 値にしたものは、全部読んだときと同じ');
}

// ==== 4. 検証の画面: 控えを使わずに作った結果と同じ・データ本体が変わらない間は表を読まない・精度の控えはまとめて読む・書いたら新しい中身を出す ====
{
  /** 比べる相手: 控え（CacheService とこの実行の控え）を空にして、精度も計算し直した検証の画面 */
  const plain = (id) => { clearCache(); return env.call('(() => { APP_STORE_CACHE_ = {}; return appLearningViewData_(__id); })()', { __id: id }); };
  /** 比べる相手: 計画ごとに精度をそのまま計算したもの（計画の表の順） */
  const accsRef = () => env.call('(() => { APP_STORE_CACHE_ = {}; const o = {}; __ids.forEach(id => { o[id] = appAccuracyOf_(id); }); return o; })()', { __ids: ids });
  const accsAll = () => env.call('(() => { APP_STORE_CACHE_ = {}; return appAccuracyAll_(__ids); })()', { __ids: ids });
  // 精度をまとめて読む: 控えが無いとき・あるとき・一部だけあるときも、計画ごとに計算したものと同じ。順は計画の表の順（偏りの合計の順）
  clearCache();
  const ref = accsRef();
  for (const label of ['控えなし', '控えあり']) {
    const got = accsAll();
    assert.deepEqual(got, ref, '精度は計画ごとに計算したものと同じ: ' + label);
    assert.deepEqual(Object.keys(got), ids, '計画の表の順: ' + label);
  }
  delete env.cache['APP_JOB_RESULT_' + env.run('appAccuracyKey_(__id)', { __id: ids[1] })];
  assert.deepEqual(Object.keys(accsAll()), ids, '控えが一部だけでも計画の表の順');
  assert.deepEqual(accsAll(), ref);
  // 見本のブックから決まる数字（検証の記録の予測は実績の over 倍。幅は予測の ±10%）
  SPECS.forEach(([client, , over], i) => {
    const a = ref[ids[i]];
    assert.deepEqual([a.n, a.leaks, a.months.length, a.months[0].month, a.coverage], [6, 0, 6, '2025/01', 1], '精度の月: ' + client);
    close(a.mape, Math.abs(over - 1), '誤差の率: ' + client);
    close(a.bias, over - 1, '偏り: ' + client);
  });
  for (const id of ids) {
    const want = plain(id);
    assert.equal(want.factorNow, 0.97);
    assert.equal(want.pooledPlans, 3);
    clearCache();
    assert.deepEqual(env.call('apiLearningView(__in)', { __in: { planId: id } }), want, '控えが無いとき: ' + id);
    assert.deepEqual(env.call('apiLearningView(__in)', { __in: { planId: id } }), want, '控えから: ' + id);
  }
  // 2 回目は表を読まない
  env.call('apiLearningView(__in)', { __in: { planId: ids[1] } });
  reset();
  const again = env.call('apiLearningView(__in)', { __in: { planId: ids[1] } });
  assert.equal(STATS.reads, 0, '控えから返す');
  assert.equal(again.planId, ids[1]);
  // 精度の控え（ACC_）は、計画の数によらず getAll でまとめて読む
  const orig = env.ctx.CacheService.getScriptCache;
  const ops = { get: 0, getAll: 0 };
  env.ctx.CacheService.getScriptCache = () => { const c = orig(); return Object.assign({}, c, { get: (k) => (ops.get++, c.get(k)), getAll: (ks) => (ops.getAll++, c.getAll(ks)) }); };
  env.run(`CacheService.getScriptCache().remove('APP_DATA_GEN')`);   // ほかの人が何か保存した後と同じ（精度の控えは残る）
  ops.get = 0; ops.getAll = 0;
  reset();
  assert.deepEqual(env.call('apiLearningView(__in)', { __in: { planId: ids[1] } }), again);
  assert.ok(ops.get <= 1 && ops.getAll <= 3, '控えは計画の数によらず数回で読む: ' + JSON.stringify(ops));
  assert.equal(reads('ENG_EVAL_LOG'), 0, '精度は控えから（検証の記録は読まない）');
  env.ctx.CacheService.getScriptCache = orig;
  // 保存したら読み直す
  env.call(`apiSaveClient({ clientName: '別の製薬' })`);
  reset();
  env.call('apiLearningView(__in)', { __in: { planId: ids[1] } });
  assert.ok(STATS.reads > 0, '書いた後は読み直す');
  // 検証の記録（EVAL_LOG）を書き換えたら、その計画にもほかの計画にも新しい中身を出す（アプリと同じ保存の道: 計算用ブック → 変わったシートを保存）
  const otherBefore = env.call('apiLearningView(__in)', { __in: { planId: ids[0] } });
  const k = 1.2;
  const saved = env.run(`appWithLock_(() => {
    const ctx = { actor: __actor, requestId: 'TEST' };
    const scratch = appWorkScratch_(appPlanOf_(__id));
    let st = null;
    do { st = appScratchBuildStep_(scratch, __id, ['EVAL_LOG'], st && st.state, new Date().getTime() + 60000); } while (!st.complete);
    const sh = scratch.getSheetByName('EVAL_LOG');
    const vals = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
    vals.forEach(r => { if (r[4] === 'neutral') r[5] = r[6] * __k; });   // 予測（pred）を実績（actual）の k 倍に
    sh.getRange(2, 1, vals.length, vals[0].length).setValues(vals);
    const cap = appCaptureChanged_(scratch, __id, appStoredHashes_(__id), ['EVAL_LOG']);
    appJournalRun_(ctx, 'テストの保存', __id, appChangedOps_(ctx, __id, cap.changed, appId_('TEST')));
    appScratchMarkAfterSave_(scratch, __id, st.state.token, ['EVAL_LOG'], !!st.state.reused, st.state.scope, st.state.problems);
    return cap.changed.length;
  })`, { __id: ids[1], __k: k, __actor: OWNER });
  assert.equal(saved, 1, '検証の記録だけが変わった');
  const after = env.call('apiLearningView(__in)', { __in: { planId: ids[1] } });
  assert.deepEqual(after.accuracy.months.map((m) => m.p50), after.accuracy.months.map((m) => m.actual * k), '書き換えた予測が出る');
  close(after.accuracy.mape, k - 1, '書き換えた後の誤差の率');
  assert.notDeepEqual(after.accuracy, again.accuracy, '前の控えは返さない');
  const otherAfter = env.call('apiLearningView(__in)', { __in: { planId: ids[0] } });
  assert.notEqual(otherAfter.mu, otherBefore.mu, 'ほかの計画の画面も、全体の偏りが新しい中身から');
  assert.deepEqual(after, plain(ids[1]), '書いた後も、控えを使わずに作った結果と同じ: ' + ids[1]);
  assert.deepEqual(otherAfter, plain(ids[0]), '書いた後も、控えを使わずに作った結果と同じ: ' + ids[0]);
  assert.throws(() => env.call('apiLearningView(__in)', { __in: { planId: 'PL-NONE' } }), /計画が見つかりません/, '無い計画は今までどおり止まる（控えない）');
}

// ==== 5. 分けて置いた控えは getAll でまとめて読む。欠けていれば読み直す ====
{
  const orig = env.ctx.CacheService.getScriptCache;
  const ops = { get: 0, getAll: 0 };
  env.ctx.CacheService.getScriptCache = () => { const c = orig(); return Object.assign({}, c, { get: (k) => (ops.get++, c.get(k)), getAll: (ks) => (ops.getAll++, c.getAll(ks)) }); };
  env.run('__calls = 0');
  const big = () => env.call(`(() => { APP_STORE_CACHE_ = {}; return appCachedRead_('BIG', () => { __calls++; return { t: 'あ'.repeat(95000) }; }); })()`);
  assert.equal(big().t.length, 95000);
  ops.get = 0; ops.getAll = 0;
  assert.equal(big().t.length, 95000);
  assert.deepEqual([env.run('__calls'), ops.get, ops.getAll], [1, 1, 2], '4 つに分けた控えを、版の印 1 回と getAll 2 回で読む');
  const k = Object.keys(env.cache).find((x) => /^RC_[0-9a-f]{32}_2$/.test(x) && env.cache[x].startsWith('あ'));
  delete env.cache[k];
  assert.equal(big().t.length, 95000);
  assert.equal(env.run('__calls'), 2, '欠けていれば読み直す');
  // 処理の結果（appJobGetResult_）も同じ
  env.run(`appJobPutResult_('SPEED', { t: 'い'.repeat(70000) })`);
  ops.get = 0; ops.getAll = 0;
  assert.equal(J(env.run(`appJobGetResult_('SPEED')`)).value.t.length, 70000);
  assert.deepEqual([ops.get, ops.getAll], [0, 2]);
  delete env.cache['APP_JOB_RESULT_SPEED_1'];
  assert.deepEqual(J(env.run(`appJobGetResult_('SPEED')`)), { found: false });
  const many = J(env.run(`appJobGetResults_(['SPEED', 'NONE'])`));
  assert.deepEqual(many, { SPEED: { found: false }, NONE: { found: false } });
  env.run(`appJobPutResult_('A1', { a: 1 }); appJobPutResult_('B2', { b: 'う'.repeat(40000) })`);
  ops.get = 0; ops.getAll = 0;
  assert.deepEqual(J(env.run(`appJobGetResults_(['A1', 'B2', 'NONE'])`)), { A1: { found: true, value: { a: 1 } }, B2: { found: true, value: { b: 'う'.repeat(40000) } }, NONE: { found: false } });
  assert.deepEqual([ops.get, ops.getAll], [0, 2]);
  // 分けた数が壊れていても、大きな鍵の一覧を作らない（上限を超える数・整数でない数・最初の 1 つが無い控えは、残りを取らずに null）
  const asked = [];
  env.ctx.CacheService.getScriptCache = () => { const c = orig(); return Object.assign({}, c, { getAll: (ks) => (asked.push(ks.length), c.getAll(ks)) }); };
  Object.assign(env.cache, { HUGE: '5000', HUGE_0: 'x', HALF: '2.5', HALF_0: 'a', HALF_1: 'b', NOFIRST: '3', NOFIRST_1: 'y', NOFIRST_2: 'z', OK: '2', OK_0: 'p', OK_1: 'q' });
  const chunks = (keys) => J(env.run('appCacheChunksAll_(CacheService.getScriptCache(), __keys)', { __keys: keys }));
  assert.deepEqual(chunks(['HUGE', 'HALF', 'NOFIRST', 'OK']), { HUGE: null, HALF: null, NOFIRST: null, OK: 'pq' });
  assert.deepEqual(asked, [8, 1], '残りを取るのは、数が正しく最初の 1 つがある控えだけ');
  const cap = env.run('APP_CACHE_CHUNKS_MAX');
  for (let i = 0; i < cap; i++) env.cache['MAXED_' + i] = String(i % 10);
  env.cache.MAXED = String(cap);
  env.cache.OVER = String(cap + 1);
  env.cache.OVER_0 = 'x';
  asked.length = 0;
  const got = chunks(['MAXED', 'OVER']);
  assert.equal(got.MAXED.length, cap, '上限ちょうどまでは読む');
  assert.equal(got.OVER, null, '上限を超える数は読まない');
  assert.deepEqual(asked, [4, cap - 1]);
  env.ctx.CacheService.getScriptCache = orig;
}

// ==== 6. 処理の記録の一覧は、置き場（所有者の UserProperties）を 1 回で読む（前と同じ一覧） ====
{
  for (let i = 0; i < 3; i++) assert.equal(env.runJob('SYSTEM.RECOVER', {}).status, 'DONE');
  env.call('apiStartJob(__in)', { __in: { kind: 'SYSTEM.RECOVER', payload: {} } });   // 待っている処理も 1 つ
  const before = J(env.run(`appProps_().getKeys().filter(k => k.indexOf(APP_JOB_PREFIX) === 0 && k.indexOf(APP_JOB_RESULT_PREFIX) !== 0)
    .map(k => { try { return JSON.parse(appProps_().getProperty(k)); } catch (e) { return null; } }).filter(Boolean).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))`));
  const orig = env.ctx.PropertiesService.getUserProperties;
  let gets = 0;
  env.ctx.PropertiesService.getUserProperties = () => { const p = orig(); return Object.assign({}, p, { getProperty: (k) => (k.indexOf('APP_JOB_') === 0 && gets++, p.getProperty(k)) }); };
  const now = J(env.run('appJobList_()'));
  env.ctx.PropertiesService.getUserProperties = orig;
  assert.ok(before.length >= 4, '処理の記録がある: ' + before.length);
  assert.deepEqual(now, before);
  assert.equal(gets, 0, '1 つずつは読まない');
  env.fireTriggers('triggerRunJob');
}

// ==== 7. バックアップ: 要点を残し、ホームはドライブを数えずに読む（状態の点検は今までどおり数える）。「有効」は残さず毎回トリガーを見る ====
{
  const drive = env.ctx.DriveApp;
  const origFolder = drive.getFolderById;
  let listed = 0;
  let shown = null;   // 一覧に出すファイルの ID（null なら全部）。作った直後の複製が、一覧にまだ出ない場合をまねる
  drive.getFolderById = (id) => {
    const f = origFolder(id);
    return Object.assign(Object.create(f), { getFilesByType: (m) => {
      listed++;
      const it = f.getFilesByType(m);
      if (!shown) return it;
      const xs = [];
      while (it.hasNext()) { const x = it.next(); if (shown.has(x.getId())) xs.push(x); }
      let i = 0;
      return { hasNext: () => i < xs.length, next: () => xs[i++] };
    } });
  };
  const fast = () => J(env.run('appBackupStatusFast_()'));
  const slow = () => J(env.run('appBackupStatus_()'));
  const stored = () => JSON.parse(env.props.APP_BACKUP_STATUS);
  const dropTrigger = () => env.run("ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'triggerDailyBackup').forEach(t => ScriptApp.deleteTrigger(t))");
  // 要点がまだ無い（この版の前のバックアップだけ）: 今までどおり数え、5 分控える
  clearCache();
  delete env.props.APP_BACKUP_STATUS;
  env.call('apiRunBackup()');
  delete env.props.APP_BACKUP_STATUS;
  listed = 0;
  assert.deepEqual(fast(), slow());
  assert.equal(listed, 2);
  fast();
  assert.equal(listed, 2, '数えた結果は 5 分控える');
  // 控えている間も「有効」は毎回トリガーを見る（数え直さない）
  env.call('apiEnableBackup()');
  assert.deepEqual([fast().enabled, listed], [true, 2], '有効にしたらすぐに有効と出す（控えから）');
  dropTrigger();
  assert.deepEqual([fast().enabled, listed], [false, 2], 'トリガーを消したらすぐに無効と出す（控えから）');
  // バックアップすると要点を残す。ホームは数えない
  clearCache();
  env.call('apiRunBackup()');
  assert.ok(env.props.APP_BACKUP_STATUS, '要点を残す');
  assert.deepEqual(Object.keys(stored()).sort(), ['at', 'count', 'latest', 'latestAt'], '要点に「有効」は残さない');
  listed = 0;
  assert.deepEqual(fast(), slow());
  assert.equal(listed, 1, '要点から返す（数えたのは比べた側だけ）');
  assert.deepEqual([fast().count, fast().enabled, fast().latest.startsWith('Trends2Targets_Data_Backup_')], [2, false, true]);
  listed = 0;
  const home = env.call('apiHome()');
  assert.deepEqual(home.system.backup, slow());
  assert.equal(listed, 1, 'ホームはドライブを数えない');
  // 毎日のバックアップを有効にすると、すぐに有効と出す
  env.call('apiEnableBackup()');
  assert.deepEqual(fast(), slow());
  assert.equal(fast().enabled, true);
  // 毎日のトリガーがあるときにバックアップしても有効と出す。その後でアプリの外でトリガーを消すと、すぐに無効と出す（ドライブは数えない）
  env.call('apiRunBackup()');
  listed = 0;
  assert.equal(fast().enabled, true, 'トリガーがあるときのバックアップの後も有効');
  dropTrigger();
  assert.equal(fast().enabled, false, 'トリガーを消したらすぐに無効');
  assert.equal(env.call('apiHome()').system.backup.enabled, false, 'ホームもすぐに無効');
  assert.equal(listed, 0, '有効かを見るのにドライブは数えない');
  assert.deepEqual(fast(), slow());
  env.call('apiEnableBackup()');
  assert.equal(fast().enabled, true);
  // 古い世代を移せずに止まっても、作った複製と残っている数を残す
  for (let i = 0; i < 12; i++) env.call('apiRunBackup()');
  assert.equal(fast().count, 14);
  const oldest = env.backups().filter((f) => !f.trashed).sort((a, b) => a.created - b.created)[0];
  const move = oldest.moveTo;
  oldest.moveTo = () => { throw new Error('move failed'); };
  assert.throws(() => env.call('apiRunBackup()'), /move failed/);
  assert.deepEqual(fast(), slow());
  assert.equal(fast().count, 15);
  oldest.moveTo = move;
  env.call('apiRunBackup()');
  assert.deepEqual(fast(), slow());
  assert.equal(fast().count, 14);
  // 作った直後の複製が一覧にまだ出なくても、最新はその複製（名前と作った時刻）。数にも足す（一覧に出ていない分、古い世代は次の回に移す）
  shown = new Set(env.backups().filter((f) => !f.trashed).map((f) => f.id));
  env.call('apiRunBackup()');
  const newest = env.backups().filter((f) => !f.trashed).sort((a, b) => b.created - a.created)[0];
  assert.ok(!shown.has(newest.id), '一覧に出ていない複製');
  assert.deepEqual([stored().latest, stored().latestAt, stored().count], [newest.name, newest.created.getTime(), 15], '最新は作った複製');
  shown = null;
  assert.deepEqual(fast(), slow(), '一覧に出るようになった後に数えたものと同じ');
  env.call('apiRunBackup()');
  assert.deepEqual(fast(), slow());
  assert.equal(fast().count, 14, '次の回で 14 世代に戻る');
  // 状態の点検（apiHealth）は今までどおりドライブを数える
  listed = 0;
  const health = env.call('apiHealth()');
  assert.deepEqual(health.backup, slow());
  assert.equal(listed, 2, '状態の点検は数える');
  // 要点が壊れていれば数える
  env.props.APP_BACKUP_STATUS = '{壊れた';
  clearCache();
  assert.deepEqual(fast(), slow());
  // 前の版が控えた失敗（HOME_SYS）は使わずに数える
  delete env.props.APP_BACKUP_STATUS;
  env.cache.HOME_SYS = JSON.stringify({ error: '前の版の失敗' });
  listed = 0;
  assert.deepEqual(fast(), slow());
  assert.equal(listed, 2, '控えた失敗は使わない');
  drive.getFolderById = origFolder;
}

console.log('app-speed: all tests passed');
