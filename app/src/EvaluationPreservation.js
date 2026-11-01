/** EvaluationPreservation.js — 1計画のB-1/B-2/B-4前後を非公開退避版と照合する。データ・退避版には書かない。 */
const APP_EVAL_PRESERVE_SHEETS = ['ACTUAL_EVAL_MONTHLY', 'EVAL_LOG', 'EVAL_COMPARE_MONTHLY', 'PROCESS_STATUS', 'RUN_LOG', 'CALIBRATION_STATE', 'CALIBRATION_HISTORY', 'EVAL_INSIGHTS'];
const APP_EVAL_PRESERVE_HUMAN = ['cause_hypothesis', 'impacted_assumption', 'action_type', 'next_cycle_reflection', 'owner', 'due_date', 'status'];

function appEvalPreserveAssert_(ok, message) {
  if (!ok) throw new Error('検証データの保全確認を止めました。' + message);
}

/** Driveの共有設定を変更せず、同じ所有者・単一親の非公開native Sheetsだけを読む。 */
function appEvalPreserveFiles_(ctx, dataId, backupId) {
  const ownerEmail = String(ctx && ctx.actor || '').trim().toLowerCase();
  appEvalPreserveAssert_(!!ownerEmail, '所有者を確認できません。');
  const inspect = id => {
    const file = DriveApp.getFileById(id), owner = file.getOwner();
    appEvalPreserveAssert_(!file.isTrashed() && file.getMimeType() === MimeType.GOOGLE_SHEETS, '有効なnative Sheetsではありません。');
    appEvalPreserveAssert_(owner && String(owner.getEmail() || '').trim().toLowerCase() === ownerEmail, '所有者が一致しません。');
    appEvalPreserveAssert_(file.getSharingAccess() === DriveApp.Access.PRIVATE && file.getEditors().length === 0 && file.getViewers().length === 0, '非公開の退避条件を確認できません。');
    const parents = [], it = file.getParents();
    while (it.hasNext()) parents.push(it.next().getId());
    appEvalPreserveAssert_(parents.length === 1, '親フォルダを一意に確認できません。');
    return parents[0];
  };
  appEvalPreserveAssert_(inspect(dataId) === inspect(backupId), 'データ本体と退避版の親フォルダが一致しません。');
}

/** 行の位置を捨てても、重複数と値の型・数式・表示形式は捨てない。 */
function appEvalPreserveTable_(book, name) {
  const sh = book.getSheetByName(name), count = sh.getLastRow(), cols = sh.getLastColumn();
  appEvalPreserveAssert_(count >= 1 && cols === APP_TABLES[name].columns.length, '表の形を確認できません: ' + name);
  const range = sh.getRange(1, 1, count, cols), values = range.getValues(), formulas = range.getFormulas(), formats = range.getNumberFormats();
  appEvalPreserveAssert_(JSON.stringify(values[0]) === JSON.stringify(APP_TABLES[name].columns), '表の見出しが一致しません: ' + name);
  const rows = values.map((v, r) => ({ values: v, cells: v.map((x, c) => [appCellEncode_(x, (formulas[r] || [])[c]), (formats[r] || [])[c] || '']) }));
  return { header: values[0], head: rows[0], rows: rows.slice(1) };
}

function appEvalPreserveBag_(rows) { return rows.map(r => JSON.stringify(r.cells)).sort(); }
function appEvalPreserveSame_(before, after, label) {
  appEvalPreserveAssert_(JSON.stringify(appEvalPreserveBag_(before)) === JSON.stringify(appEvalPreserveBag_(after)), '保護対象の行が変わっています: ' + label);
}
function appEvalPreserveKeys_(table, rows, keys) {
  const out = new Map(), cols = keys.map(k => table.header.indexOf(k));
  appEvalPreserveAssert_(cols.every(c => c >= 0), '表のキーがありません。');
  rows.forEach(r => {
    appEvalPreserveAssert_(cols.every(c => typeof r.values[c] === 'string' && r.values[c] !== ''), '表のキーが空か不正です。');
    const key = JSON.stringify(cols.map(c => r.values[c]));
    appEvalPreserveAssert_(!out.has(key), '表のキーが重複しています。'); out.set(key, r);
  });
  return out;
}
function appEvalPreserveAppend_(before, after, name) {
  const old = appEvalPreserveKeys_(before, before.rows, APP_TABLES[name].key), now = appEvalPreserveKeys_(after, after.rows, APP_TABLES[name].key);
  old.forEach((r, key) => appEvalPreserveAssert_(now.has(key) && JSON.stringify(r.cells) === JSON.stringify(now.get(key).cells), '既存の追記記録が変わっています: ' + name));
}

/** B-4と同じ人の記入の跡。自動の既定値だけの行は再判定を許す。 */
function appEvalPreserveHumanTrace_(table, row) {
  const v = k => String(row.values[table.header.indexOf(k)] || '').trim();
  const action = v('action_type'), status = v('status'), reflection = v('next_cycle_reflection'), assumption = v('impacted_assumption');
  const pair = (action === 'update' && status === 'open') || (action === 'keep' && status === 'monitoring');
  return !!(v('cause_hypothesis') || v('owner') || v('due_date') || (status && !pair) ||
    (action && ['update', 'keep'].indexOf(action) < 0) || (reflection && APP_INSIGHT_MACHINE_REFLECTIONS.indexOf(reflection) < 0) || (assumption && assumption !== 'CONFIG:環境前提'));
}

function appEvalPreserveInsights_(before, after, planId) {
  const pi = before.header.indexOf('plan_id'), oldRows = before.rows.filter(r => r.values[pi] === planId), newRows = after.rows.filter(r => r.values[pi] === planId);
  const old = appEvalPreserveKeys_(before, oldRows, ['seq']), now = appEvalPreserveKeys_(after, newRows, ['seq']);
  let humanRows = 0, humanCells = 0;
  old.forEach((r, key) => {
    appEvalPreserveAssert_(now.has(key), '既存の振り返りの行が失われています。');
    const n = now.get(key), ti = before.header.indexOf('_types');
    // seqだけを残して別メーカー・別月へ記入を移すことも保全とは扱わない。
    ['client', 'target_month'].forEach(field => {
      const c = before.header.indexOf(field), t = APP_ENGINE_SHEETS.EVAL_INSIGHTS.header.indexOf(field);
      appEvalPreserveAssert_(JSON.stringify(r.cells[c]) === JSON.stringify(n.cells[c]) && String(r.values[ti]).charAt(t) === String(n.values[ti]).charAt(t), '既存の振り返りの所属・月が変わっています。');
    });
    if (!appEvalPreserveHumanTrace_(before, r)) return;
    humanRows++;
    APP_EVAL_PRESERVE_HUMAN.forEach(field => {
      const c = before.header.indexOf(field), t = APP_ENGINE_SHEETS.EVAL_INSIGHTS.header.indexOf(field);
      appEvalPreserveAssert_(c >= 0 && t >= 0, '記入列の定義がありません。');
      if (r.values[c] === '' || r.values[c] === null || r.values[c] === undefined) return;
      appEvalPreserveAssert_(JSON.stringify(r.cells[c]) === JSON.stringify(n.cells[c]) && String(r.values[ti]).charAt(t) === String(n.values[ti]).charAt(t), '人の記入が変わっています。');
      humanCells++;
    });
  });
  return { existingInsightRows: oldRows.length, preservedHumanRows: humanRows, preservedHumanCells: humanCells };
}

function appEvalPreserveChanged_(before, after, name, planId) {
  appEvalPreserveAssert_(JSON.stringify(before.head.cells) === JSON.stringify(after.head.cells), '見出しの型・数式・形式が変わっています: ' + name);
  const pi = before.header.indexOf('plan_id'), si = before.header.indexOf('sheet');
  const engine = name.indexOf('ENG_') === 0 && APP_EVAL_PRESERVE_SHEETS.indexOf(name.slice(4)) >= 0;
  const segments = ['ENG_ROWS', 'ENG_FORMATS', 'ENG_SHEETS'].indexOf(name) >= 0;
  const append = name === 'PLAN_ACTIONS' || name === 'HIT_RECORDS';
  const allowed = r => pi >= 0 && r.values[pi] === planId && (engine || append || (segments && si >= 0 && APP_EVAL_PRESERVE_SHEETS.indexOf(r.values[si]) >= 0));
  appEvalPreserveSame_(before.rows.filter(r => !allowed(r)), after.rows.filter(r => !allowed(r)), name);
  if (append) appEvalPreserveAppend_(before, after, name);
  if (name === 'ENG_EVAL_INSIGHTS') return appEvalPreserveInsights_(before, after, planId);
  return null;
}

/** verify=falseは実行前の完全一致、verify=trueは指定した計画の標準検証処理の変更範囲だけを照合する。 */
function appEvaluationPreservation_(ctx, input) {
  const i = input || {};
  appEvalPreserveAssert_(typeof i.planId === 'string' && /^PL-[A-Za-z0-9-]+$/.test(i.planId), '対象計画が不正です。');
  appEvalPreserveAssert_(typeof i.backupId === 'string' && /^[A-Za-z0-9_-]+$/.test(i.backupId), '退避版を指定してください。');
  appEvalPreserveAssert_(i.verify === undefined || typeof i.verify === 'boolean', 'verifyは真偽値で指定してください。');
  return appWithLock_(() => {
    appNativeMetaIdle_(); appRequireOpenPlan_(i.planId);
    const dataId = appProps_().getProperty(APP_PROP.dataId);
    appEvalPreserveAssert_(dataId && i.backupId !== dataId, 'データ本体を退避版には指定できません。');
    appEvalPreserveFiles_(ctx, dataId, i.backupId);
    const data = appDataSpreadsheet_(), backup = SpreadsheetApp.openById(i.backupId);
    const before = appNativeMetaBookProof_(backup), after = appNativeMetaBookProof_(data), names = Object.keys(before.tables).sort();
    // 未作成の任意表は作らず、旧表も含めた退避時の実在集合を正本にする。
    appEvalPreserveAssert_(JSON.stringify(Object.keys(after.tables).sort()) === JSON.stringify(names), '全表の構成が一致しません。');
    appEvalPreserveAssert_(before.locale === after.locale && before.timeZone === after.timeZone, '地域・タイムゾーンが一致しません。');
    const changedTables = names.filter(name => before.tables[name] !== after.tables[name]);
    if (!i.verify) appEvalPreserveAssert_(before.digest === after.digest, '退避版と現在の全表が完全一致しません。');
    const report = {}, insightProof = { existingInsightRows: 0, preservedHumanRows: 0, preservedHumanCells: 0 };
    names.forEach(name => {
      const oldSh = backup.getSheetByName(name), newSh = data.getSheetByName(name);
      report[name] = { beforeSha256: before.tables[name], afterSha256: after.tables[name], beforeRows: Math.max(0, oldSh.getLastRow() - 1), afterRows: Math.max(0, newSh.getLastRow() - 1) };
      if (i.verify && (changedTables.indexOf(name) >= 0 || name === 'ENG_EVAL_INSIGHTS')) {
        // 定義の無い旧表は列を解釈せず、順序を含めて元の全表hashを保持する。
        appEvalPreserveAssert_(Object.prototype.hasOwnProperty.call(APP_TABLES, name), '未知の旧表が変わっています: ' + name);
        const proof = appEvalPreserveChanged_(appEvalPreserveTable_(backup, name), appEvalPreserveTable_(data, name), name, i.planId);
        if (proof) Object.assign(insightProof, proof);
      }
    });
    // 読取中に退避版が外部から変わっていないことも確認する。ファイルやデータへの書込はしない。
    appEvalPreserveAssert_(appNativeMetaBookProof_(backup).digest === before.digest, '照合中に退避版が変わりました。');
    return Object.assign({ preserved: true, verified: !!i.verify, exact: changedTables.length === 0, checkedTables: names.length, changedTables: changedTables,
      backupSha256: before.digest, currentSha256: after.digest, inputHash: appPlanInputHash_(i.planId), tables: report, storeWrites: 0 }, insightProof);
  });
}
