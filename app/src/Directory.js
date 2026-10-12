/**
 * Directory.js — メンバー（社員名簿とメールの対応）・役割の付与・クライアントのマスタ。
 * 役割は消さずに無効化する（is_active=FALSE・valid_to）。どの変更も監査に変更前後が残る（Api.js から呼ぶ）。
 */
function appNormalizeEmail_(v) {
  return String(v || '').trim().toLowerCase();
}

function appRequireInternalEmail_(ctx, email) {
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('メールアドレスの形式が正しくありません。');
  if (!ctx.user.domain || email.slice(-(ctx.user.domain.length + 1)) !== '@' + ctx.user.domain) {
    throw new Error('社内（@' + ctx.user.domain + '）のメールアドレスだけ登録できます。');
  }
}

function appListDirectory_(ctx) {
  const members = appReadTable_('MEMBERS').map(appStripRow_);
  const roles = appReadTable_('ROLES').map(appStripRow_);
  const ov = appClientNameOverrides_();
  const clients = appReadTable_('CLIENTS').map(appStripRow_).map(c => Object.assign(c, { display_name: ov[c.client_id] ? ov[c.client_id].display_name : appClientDisplayName_(c.client_name),
    display_auto: !ov[c.client_id], display_row_version: ov[c.client_id] ? ov[c.client_id].row_version : '' }));
  return { members: members, roles: roles, clients: clients, owner: ctx.user.owner, grantable: APP_GRANTABLE_ROLES, roleLabels: APP_ROLE_LABELS };
}

/** メンバーを足す・直す。既存なら rowVersion で楽観ロック */
function appSaveMember_(ctx, input) {
  const email = appNormalizeEmail_(input && input.email);
  appRequireInternalEmail_(ctx, email);
  const name = String(input && input.displayName || '').trim();
  if (!name) throw new Error('名前を入力してください。');
  const patch = { display_name: name.slice(0, 100), department: String(input && input.department || '').trim().slice(0, 100),
    is_active: input && input.isActive === false ? false : true, note: String(input && input.note || '').slice(0, 500) };
  return appWithLock_(() => {
    const cur = appReadTable_('MEMBERS').filter(r => r.email === email)[0];
    if (cur) {
      const r = appUpdateByKey_('MEMBERS', { email: email }, patch, input && input.rowVersion, ctx.actor);
      return { member: r.after, before: r.before, created: false, audit: { entityId: email } };
    }
    const now = appNowIso_();
    const row = Object.assign({ email: email, created_at: now, created_by: ctx.actor, updated_at: now, updated_by: ctx.actor, row_version: 1 }, patch);
    appInsertRows_('MEMBERS', [row]);
    return { member: row, before: null, created: true, audit: { entityId: email } };
  });
}

/** 役割を付ける。メンバーに登録済みの人だけ。PLANNER はクライアント単位にできる */
function appGrantRole_(ctx, input) {
  const email = appNormalizeEmail_(input && input.email);
  const role = String(input && input.role || '');
  const scopeType = String(input && input.scopeType || 'ALL') === 'CLIENT' ? 'CLIENT' : 'ALL';
  const clientId = scopeType === 'CLIENT' ? String(input && input.clientId || '') : '';
  if (APP_GRANTABLE_ROLES.indexOf(role) < 0) throw new Error('付与できる役割は ' + APP_GRANTABLE_ROLES.map(r => APP_ROLE_LABELS[r]).join('・') + ' です。');
  if (scopeType === 'CLIENT' && role !== 'PLANNER') throw new Error('メーカー単位にできるのは予算策定担当だけです。');
  const validFrom = String(input && input.validFrom || '').trim() || appToday_();
  const validTo = String(input && input.validTo || '').trim();
  [validFrom, validTo].forEach(d => { if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('日付は yyyy-MM-dd で入力してください。'); });
  if (validTo && validTo < validFrom) throw new Error('終わりの日が始まりの日より前です。');
  return appWithLock_(() => {
    const member = appReadTable_('MEMBERS').filter(r => r.email === email && r.is_active)[0];
    if (!member) throw new Error('先にメンバーとして登録してください（' + email + '）。');
    if (scopeType === 'CLIENT' && !appReadTable_('CLIENTS').some(c => c.client_id === clientId && c.is_active)) {
      throw new Error('メーカーを選んでください。');
    }
    // 同じ役割でも期間が重ならなければ付けられる（期限が切れた付与の後に付け直すなど）
    const end = d => d || '9999-12-31';
    const dup = appReadTable_('ROLES').some(r => r.is_active && r.email === email && r.role === role && r.scope_type === scopeType &&
      r.client_id === clientId && (r.valid_from || '0000-01-01') <= end(validTo) && validFrom <= end(r.valid_to));
    if (dup) throw new Error('同じ役割が同じ期間にすでに付いています。');
    const now = appNowIso_();
    const row = { role_id: appId_('RL'), email: email, role: role, scope_type: scopeType, client_id: clientId, valid_from: validFrom,
      valid_to: validTo, is_active: true, note: String(input && input.note || '').slice(0, 500),
      created_at: now, created_by: ctx.actor, updated_at: now, updated_by: ctx.actor, row_version: 1 };
    appInsertRows_('ROLES', [row]);
    return { role: row, audit: { entityId: row.role_id, clientId: clientId } };
  });
}

/** 役割を外す（行は残して無効にする） */
function appRevokeRole_(ctx, input) {
  const roleId = String(input && input.roleId || '');
  return appWithLock_(() => {
    const cur = appReadTable_('ROLES').filter(r => r.role_id === roleId)[0];
    if (!cur) throw new Error('役割が見つかりません。');
    if (!cur.is_active) throw new Error('この役割はすでに外れています。');
    if (cur.email === ctx.user.owner && cur.role === 'ADMIN') throw new Error('所有者は管理者のままです（外せません）。');
    const r = appUpdateByKey_('ROLES', { role_id: roleId }, { is_active: false, valid_to: appToday_() }, input && input.rowVersion, ctx.actor);
    return { role: r.after, before: r.before, audit: { entityId: roleId, clientId: cur.client_id } };
  });
}

/** 表記ゆれを吸収した比較用の名前（全角英数→半角、会社の種類の語・空白・記号を除く、小文字） */
function appNormalizeName_(s) {
  return String(s || '').normalize('NFKC')
    .replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)/g, '')   // NFKC で ㈱・（株） は (株) になる
    .replace(/[\s・.,、。()「」'"’”\-‐－]/g, '')
    .toLowerCase();
}

// ---- 画面に出すクライアントの名前 ----

/**
 * ZAC の名前から、ふつうに使う表記を作る: 半角カナ・全角英数を直す（NFKC）、株式会社・（株）・合同会社などを除く、空白をそろえる。
 * 例: ｻﾝﾌﾟﾙﾌｧｰﾏ(株) → サンプルファーマ。合わないものは管理者が「クライアント」の画面で決める（CLIENT_NAMES）
 */
function appClientDisplayName_(raw) {
  return String(raw || '').normalize('NFKC')
    .replace(/株式会社|有限会社|合同会社|合資会社|合名会社|\((株|有|同|資|名)\)/g, ' ')
    .replace(/[\s\u3000]+/g, ' ').trim() || String(raw || '').trim();
}

/** 管理者が決めた名前（{ client_id: 行 }）。表がまだ無ければ空 */
function appClientNameOverrides_() {
  const out = {};
  try { appReadTable_('CLIENT_NAMES').forEach(r => { if (r.display_name) out[r.client_id] = r; }); } catch (e) { if (!/表がありません/.test(String(e && e.message))) throw e; }
  return out;
}

/** { client_id: 画面に出す名前 } */
function appClientNameMap_() {
  const ov = appClientNameOverrides_();
  const out = {};
  appReadTable_('CLIENTS').forEach(c => { out[c.client_id] = ov[c.client_id] ? ov[c.client_id].display_name : appClientDisplayName_(c.client_name); });
  return out;
}

/** 画面に出す名前を決める（空にすると自動の名前に戻す） */
function appSaveClientName_(ctx, input) {
  const id = String(input && input.clientId || '');
  const name = String(input && input.displayName || '').normalize('NFKC').replace(/[\s\u3000]+/g, ' ').trim().slice(0, 100);
  appPlanCheckArgs_([name]);
  return appWithLock_(() => {
    const client = appReadTable_('CLIENTS').filter(c => c.client_id === id)[0];
    if (!client) throw new Error('メーカーが見つかりません。');
    const auto = appClientDisplayName_(client.client_name);
    let cur = null;   // 自動に戻した行（名前が空）も、同じ行を使う
    try { cur = appReadTable_('CLIENT_NAMES').filter(r => r.client_id === id)[0] || null; } catch (e) { if (!/表がありません/.test(String(e && e.message))) throw e; }
    const now = appNowIso_();
    const value = name === auto ? '' : name;   // 自動の名前と同じなら、決めた名前は持たない
    if (cur) appUpdateByKey_('CLIENT_NAMES', { client_id: id }, { display_name: value }, input && input.rowVersion, ctx.actor);
    else if (value) appInsertRows_('CLIENT_NAMES', [{ client_id: id, display_name: value, updated_at: now, updated_by: ctx.actor, row_version: 1 }]);
    return { clientId: id, displayName: value || auto, auto: !value, before: { displayName: cur && cur.display_name ? cur.display_name : auto }, audit: { entityId: id, clientId: id } };
  });
}

/** クライアントを足す・直す */
function appSaveClient_(ctx, input) {
  const name = String(input && input.clientName || '').trim();
  if (!name) throw new Error('メーカー名を入力してください。');
  const normalized = appNormalizeName_(name);
  const patch = { client_name: name.slice(0, 100), zac_code: String(input && input.zacCode || '').trim().slice(0, 50),
    normalized_name: normalized, is_active: input && input.isActive === false ? false : true,
    note: String(input && input.note || '').slice(0, 500) };
  return appWithLock_(() => {
    const all = appReadTable_('CLIENTS');
    const id = String(input && input.clientId || '');
    if (all.some(c => c.client_id !== id && c.normalized_name === normalized)) throw new Error('同じ名前のメーカーがすでにあります。');
    if (id) {
      const r = appUpdateByKey_('CLIENTS', { client_id: id }, patch, input && input.rowVersion, ctx.actor);
      return { client: r.after, before: r.before, created: false, audit: { entityId: id, clientId: id } };
    }
    const now = appNowIso_();
    const row = Object.assign({ client_id: appId_('CL'), aliases_json: '[]', created_at: now, created_by: ctx.actor,
      updated_at: now, updated_by: ctx.actor, row_version: 1 }, patch);
    appInsertRows_('CLIENTS', [row]);
    return { client: row, before: null, created: true, audit: { entityId: row.client_id, clientId: row.client_id } };
  });
}
