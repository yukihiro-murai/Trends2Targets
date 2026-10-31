/**
 * NativeMetadataRepair.js — 保存行を変更せず、確認済み計画の復元用メタだけを保全して修復する。
 * 所有者の preview → 指紋照合 → 非公開バックアップ照合 → Journal → 全表読戻し。予測は再計算しない。
 */
const APP_NATIVE_META_SHEETS = ['OUTPUT', 'EVAL_COMPARE_MONTHLY', 'PROCESS_STATUS'];
const APP_NATIVE_META_FIELDS = ['last_row', 'last_column', 'max_rows', 'max_columns', 'content_hash', 'updated_at', 'updated_by'];

function appNativeMetaAssert_(ok, message) {
  if (!ok) throw new Error('保存メタの修復を止めました。' + message);
}

function appNativeMetaTaskCheck_(t, apply) {
  appNativeMetaAssert_(Array.isArray(t.planIds) && t.planIds.length > 0 && t.planIds.length <= 100, '対象計画を1〜100件で指定してください。');
  appNativeMetaAssert_(t.planIds.every(id => typeof id === 'string' && /^PL-[A-Za-z0-9-]+$/.test(id)) && new Set(t.planIds).size === t.planIds.length, '対象計画の指定が不正です。');
  if (apply) {
    appNativeMetaAssert_(/^[a-f0-9]{64}$/.test(String(t.previewSha256 || '')), '確認した指紋が必要です。');
    appNativeMetaAssert_(/^[A-Za-z0-9_-]+$/.test(String(t.backupId || '')), '修復前のバックアップが必要です。');
  }
}

function appNativeMetaIdle_() {
  appNativeMetaAssert_(!appJournalPending_(), '未完了の保存があります。');
  appNativeMetaAssert_(!appJobList_().some(j => j.status === 'QUEUED' || j.status === 'RUNNING'), '処理が動いています。');
  appNativeMetaAssert_(!appBulkState_().active, 'まとめて動かす処理が有効です。');
}

/** どの入力・形式・寸法から作る補修かを、時刻に依存しない指紋へ固定する */
function appNativeMetaPreviewState_(ctx, input) {
  appNativeMetaTaskCheck_(input, false);
  // 多数計画の照合だけは対象表を一度読む。計画ごとの TextFinder・細切れ読取で実行上限に達するのを避ける。
  // ロック取得後の実行内控えであり、永続キャッシュや別の実行の値は使わない。
  if (input.planIds.length > 1) ['ENG_SHEETS', 'ENG_ROWS', 'ENG_FORMATS', 'ENG_EVAL_COMPARE_MONTHLY', 'ENG_PROCESS_STATUS'].forEach(name => appReadTable_(name));
  const planIds = input.planIds.slice().sort(), ops = [], entries = [], basis = [];
  planIds.forEach(planId => {
    appRequireOpenPlan_(planId);
    APP_NATIVE_META_SHEETS.forEach(sheet => {
      const found = appScreenReadPlan_('ENG_SHEETS', planId).filter(r => r.sheet === sheet);
      appNativeMetaAssert_(found.length === 1, 'シート情報を一意に確認できません。');
      const before = appStripRow_(found[0]);
      const op = appScreenSheetHashOp_(planId, sheet, ctx.actor);
      const stable = {};
      if (op) {
        appNativeMetaAssert_(op.table === 'ENG_SHEETS' && op.mode === 'patch' && Object.keys(op.patch).every(k => APP_NATIVE_META_FIELDS.indexOf(k) >= 0), '許可したメタ以外の変更があります。');
        ops.push(op);
        entries.push({ planId: planId, sheet: sheet, before: before, after: Object.assign({}, before, op.patch) });
        Object.keys(op.patch).filter(k => k !== 'updated_at' && k !== 'updated_by').sort().forEach(k => { stable[k] = op.patch[k]; });
      }
      basis.push([planId, sheet, before, stable]);
    });
  });
  return { planIds: planIds, ops: ops, entries: entries, previewSha256: appSha256Hex_(JSON.stringify(basis)) };
}

function appNativeMetaPreview_(ctx, input) {
  return appWithLock_(() => {
    const p = appNativeMetaPreviewState_(ctx, input);
    return { previewSha256: p.previewSha256, plans: p.planIds.length, checkedSheets: p.planIds.length * APP_NATIVE_META_SHEETS.length,
      changedSheets: p.ops.length, changedPlans: new Set(p.entries.map(x => x.planId)).size, metadataOnly: true };
  });
}

/** 数式は式そのもの、日時・数値・空は型も含め、表示形式と一緒に比較する */
function appNativeMetaMatrixHash_(state) {
  const cells = state.values.map((row, r) => row.map((v, c) => [appCellEncode_(v, (state.formulas[r] || [])[c]), (state.formats[r] || [])[c] || '']));
  return appSha256Hex_(JSON.stringify([state.rows, state.cols, cells]));
}

function appNativeMetaBookProof_(book) {
  const tables = {}, names = [], proof = { tables: tables, locale: book.getSpreadsheetLocale(), timeZone: book.getSpreadsheetTimeZone() };
  book.getSheets().forEach(sh => {
    const rows = sh.getLastRow(), cols = sh.getLastColumn(), range = rows && cols ? sh.getRange(1, 1, rows, cols) : null;
    const state = { rows: rows, cols: cols, values: range ? range.getValues() : [], formulas: range ? range.getFormulas() : [], formats: range ? range.getNumberFormats() : [] };
    const name = sh.getName();
    appNativeMetaAssert_(!Object.prototype.hasOwnProperty.call(tables, name), '表の名前が重複しています。');
    tables[name] = appNativeMetaMatrixHash_(state); names.push(name);
    if (name === 'ENG_SHEETS') proof.meta = state;
  });
  names.sort();
  appNativeMetaAssert_(!!proof.meta, '保存メタの表がありません。');
  proof.digest = appSha256Hex_(JSON.stringify([proof.locale, proof.timeZone, names.map(n => [n, tables[n]])]));
  proof.dataDigest = appSha256Hex_(JSON.stringify([proof.locale, proof.timeZone, names.filter(n => n !== 'ENG_SHEETS').map(n => [n, tables[n]])]));
  return proof;
}

/** 全メタ行のうち、指定したキー・指定した列だけが変わったときの期待値 */
function appNativeMetaExpected_(before, ops) {
  const state = { rows: before.rows, cols: before.cols, values: before.values.map(r => r.slice()), formulas: before.formulas.map(r => r.slice()), formats: before.formats.map(r => r.slice()) };
  const header = state.values[0] || [], pi = header.indexOf('plan_id'), si = header.indexOf('sheet');
  appNativeMetaAssert_(pi >= 0 && si >= 0, '保存メタの見出しが不正です。');
  ops.forEach(op => {
    appNativeMetaAssert_(op.table === 'ENG_SHEETS' && op.mode === 'patch' && APP_NATIVE_META_SHEETS.indexOf(op.key.sheet) >= 0, '許可外の操作があります。');
    const hits = state.values.slice(1).filter(row => String(row[pi]) === String(op.key.plan_id) && row[si] === op.key.sheet);
    appNativeMetaAssert_(hits.length === 1, '更新するメタ行を一意に確認できません。');
    Object.keys(op.patch).forEach(k => {
      const col = header.indexOf(k);
      appNativeMetaAssert_(APP_NATIVE_META_FIELDS.indexOf(k) >= 0 && col >= 0, '許可外のメタ列があります。');
      hits[0][col] = op.patch[k];
    });
  });
  return state;
}

/** 一行ずつ既存の控えへ渡す。通常の patch による更新時刻の上書きを避ける。 */
function appNativeMetaJournalOps_(state, patches) {
  const def = APP_TABLES.ENG_SHEETS, header = state.values[0] || [], seen = new Set();
  appNativeMetaAssert_(JSON.stringify(header) === JSON.stringify(def.columns), '保存メタの見出しが不正です。');
  state.values.slice(1).forEach(row => {
    appNativeMetaAssert_(def.key.every(k => typeof row[header.indexOf(k)] === 'string' && row[header.indexOf(k)] !== ''), '保存メタのキーが空です。');
    const key = def.key.map(k => row[header.indexOf(k)]).join('\u0001');
    appNativeMetaAssert_(!seen.has(key), '保存メタのキーが重複しています。'); seen.add(key);
  });
  return patches.map(op => {
    const row = state.values.findIndex((r, i) => i > 0 && r[header.indexOf('plan_id')] === op.key.plan_id && r[header.indexOf('sheet')] === op.key.sheet);
    appNativeMetaAssert_(row > 0 && state.values[row].every((v, c) => typeof v === 'string' && !state.formulas[row][c] && state.formats[row][c] === '@'), '更新するメタ行が標準の文字列形式ではありません。');
    const current = appScreenReadPlan_('ENG_SHEETS', op.key.plan_id).filter(r => r.sheet === op.key.sheet);
    appNativeMetaAssert_(current.length === 1 && JSON.stringify(appObjectToRow_(def, current[0])) === JSON.stringify(state.values[row]), '保存メタの行をそのまま保全できません。');
    return appOpReplacePlan_('ENG_SHEETS', op.key.plan_id, [op.key.sheet], [Object.assign(appStripRow_(current[0]), op.patch)]);
  });
}

function appNativeMetaApply_(ctx, input) {
  appNativeMetaTaskCheck_(input, true);
  return appWithLock_(() => {
    appNativeMetaIdle_();
    const p = appNativeMetaPreviewState_(ctx, input);
    appNativeMetaAssert_(p.previewSha256 === input.previewSha256, '確認後に保存状態が変わりました。もう一度確認してください。');
    if (!p.ops.length) return { changedSheets: 0, unchanged: true, metadataOnly: true };
    const dataId = appProps_().getProperty(APP_PROP.dataId);
    appNativeMetaAssert_(input.backupId !== dataId, 'データ本体をバックアップとして指定できません。');
    const before = appNativeMetaBookProof_(appDataSpreadsheet_());
    const backup = appNativeMetaBookProof_(SpreadsheetApp.openById(input.backupId));
    appNativeMetaAssert_(before.digest === backup.digest, '退避版と現在の全表が一致しません。新しい退避版を作ってください。');
    const expected = appNativeMetaExpected_(before.meta, p.ops);
    const journalOps = appNativeMetaJournalOps_(before.meta, p.ops);
    const body = { kind: 'NATIVE_METADATA_REPAIR_V1', dataId: dataId, backupId: input.backupId, createdAt: appNowIso_(), actor: ctx.actor,
      previewSha256: p.previewSha256, planIds: p.planIds, beforeDigest: before.digest, dataDigest: before.dataDigest,
      beforeMetaHash: before.tables.ENG_SHEETS, afterMetaHash: appNativeMetaMatrixHash_(expected), entries: p.entries, status: 'PREPARED' };
    const folder = DriveApp.getFolderById(appProps_().getProperty(APP_PROP.folderId));
    const file = folder.createFile('Trends2Targets_MetadataRepair_' + appId_('MR') + '.json', JSON.stringify(body), MimeType.PLAIN_TEXT);
    try {
      appJournalRun_(ctx, '保存メタの保全修復', '', journalOps);
      SpreadsheetApp.flush(); appStoreForget_();
      const after = appNativeMetaBookProof_(appDataSpreadsheet_());
      appNativeMetaAssert_(after.dataDigest === body.dataDigest && after.tables.ENG_SHEETS === body.afterMetaHash, '変更後の全表が期待値と一致しません。控えを保持しました。');
      body.status = 'VERIFIED'; body.afterDigest = after.digest; body.finishedAt = appNowIso_(); file.setContent(JSON.stringify(body));
      return { changedSheets: p.ops.length, changedPlans: new Set(p.entries.map(x => x.planId)).size, checkedTables: Object.keys(after.tables).length,
        preservedTables: Object.keys(after.tables).length - 1, metadataOnly: true, repairFileId: file.getId(), backupId: input.backupId, afterDigest: after.digest };
    } catch (e) {
      Logger.log('保存メタの修復: 検証未完。控え=' + file.getId() + ' / ' + String(e && e.message || e));
      throw e;
    }
  });
}

/** Journal 完了後に控えの更新だけが止まった場合も、全表照合後に確定できる。 */
function appNativeMetaResume_(ctx, input) {
  return appWithLock_(() => {
    appNativeMetaIdle_();
    const saved = appNativeMetaManifest_(input), body = saved.body;
    body.planIds.forEach(appRequireOpenPlan_);
    const current = appNativeMetaBookProof_(appDataSpreadsheet_());
    appNativeMetaAssert_(body.status !== 'ROLLED_BACK' && current.dataDigest === body.dataDigest && current.tables.ENG_SHEETS === body.afterMetaHash, '修復後の全表と一致しません。控えを確定しません。');
    body.status = 'VERIFIED'; body.afterDigest = current.digest; body.finishedAt = appNowIso_(); saved.file.setContent(JSON.stringify(body));
    return { verified: true, metadataOnly: true, changedSheets: body.entries.length, repairFileId: saved.file.getId(), afterDigest: current.digest };
  });
}

function appNativeMetaManifest_(input) {
  appNativeMetaAssert_(/^[A-Za-z0-9_-]+$/.test(String(input.repairFileId || '')), '修復控えを指定してください。');
  const file = DriveApp.getFileById(input.repairFileId), body = JSON.parse(file.getBlob().getDataAsString());
  appNativeMetaAssert_(body.kind === 'NATIVE_METADATA_REPAIR_V1' && ['PREPARED', 'VERIFIED', 'ROLLED_BACK'].indexOf(body.status) >= 0 && body.dataId === appProps_().getProperty(APP_PROP.dataId), '有効な修復控えではありません。');
  appNativeMetaTaskCheck_({ planIds: body.planIds }, false);
  return { file: file, body: body };
}

/** 現在が控えの変更後と完全一致するときだけ、当該メタ列を元へ戻す。全ブックは戻さない */
function appNativeMetaRollback_(ctx, input) {
  appNativeMetaAssert_(/^[A-Za-z0-9_-]+$/.test(String(input.repairFileId || '')), '修復控えを指定してください。');
  return appWithLock_(() => {
    appNativeMetaIdle_();
    const saved = appNativeMetaManifest_(input), file = saved.file, body = saved.body;
    body.planIds.forEach(appRequireOpenPlan_);
    const before = appNativeMetaBookProof_(appDataSpreadsheet_());
    if (before.digest === body.beforeDigest) {
      body.status = 'ROLLED_BACK'; body.rolledBackAt = appNowIso_(); file.setContent(JSON.stringify(body));
      return { changedSheets: 0, metadataOnly: true, restored: true, repairFileId: file.getId() };
    }
    appNativeMetaAssert_(body.status !== 'ROLLED_BACK' && before.tables.ENG_SHEETS === body.afterMetaHash && before.dataDigest === body.dataDigest, '修復後にデータが変わっています。元へ戻しません。');
    const ops = body.entries.map(e => {
      appNativeMetaAssert_(body.planIds.indexOf(e.planId) >= 0 && APP_NATIVE_META_SHEETS.indexOf(e.sheet) >= 0, '控えの対象が不正です。');
      const patch = {}; APP_NATIVE_META_FIELDS.forEach(k => { if (String(e.before[k]) !== String(e.after[k])) patch[k] = e.before[k]; });
      return { table: 'ENG_SHEETS', mode: 'patch', planId: e.planId, key: { plan_id: e.planId, sheet: e.sheet }, patch: patch, actor: ctx.actor };
    });
    const journalOps = appNativeMetaJournalOps_(before.meta, ops);
    appJournalRun_(ctx, '保存メタ修復の巻戻し', '', journalOps); SpreadsheetApp.flush(); appStoreForget_();
    const after = appNativeMetaBookProof_(appDataSpreadsheet_());
    appNativeMetaAssert_(after.digest === body.beforeDigest, '巻戻し後の全表が元の状態と一致しません。控えを保持しました。');
    body.status = 'ROLLED_BACK'; body.rolledBackAt = appNowIso_(); file.setContent(JSON.stringify(body));
    return { changedSheets: ops.length, metadataOnly: true, restored: true, repairFileId: file.getId() };
  });
}
