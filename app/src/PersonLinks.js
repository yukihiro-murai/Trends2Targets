/**
 * PersonLinks.js — 入力の「担当者」の名前とメンバーのメールのつなぎ（PERSON_LINKS。SCHEMA_PLAN_v10-12_JA.md の 3-6。2026-10-08 村井さん承認）。
 * - 所有者だけが apiOwnerTask の linkPerson・unlinkPerson・listPersonLinks で扱う（画面には出さない。サーバーの中で、当たりのまとめと
 *   本人の分の判定に使う: V10.js の appPersonEmailOf_・appLogViewer_）。
 * - つなげるのはメンバーに登録済みの人だけ。client_id が空 = 全部のメーカー。メーカーを決めると、そのメーカーの計画の名前だけ（そちらが先）。
 *   効く期間（valid_from・valid_to）は省けば限りなし（前からの入力の名前もつながる）。同じ名前を同じ範囲・同じ期間に 2 人へはつながない
 *   （どちらか決められない名前は、だれにもつながらないため）。
 * - 外すときは行を消さず無効にする（ROLES と同じ。appUpdateByKey_ で is_active を FALSE。監査に前と後が残る）。
 * - 一覧の案（suggestions）: 入力の担当者の名前と、メンバーの表示名が同じもの（空白・全角半角を除いて比べる）。つなぐのは所有者が決める。
 */
const APP_PERSON_NAME_MAX = 40;
const APP_PERSON_NOTE_MAX = 200;

/** 所有者でなければ止める（管理者の役割があっても、ほかの人は扱えない。setCalibration・τ・w と同じ） */
function appPersonOwnerOnly_(ctx) {
  if (!(ctx && ctx.user && ctx.user.isOwner)) throw new Error('人のつなぎは、所有者だけが扱えます。');
}

/** つなぐ: { personName, email, clientId?, validFrom?, validTo?, note? } */
function appLinkPerson_(ctx, input) {
  appPersonOwnerOnly_(ctx);
  const name = String(input && input.personName || '').trim();
  if (!name) throw new Error('担当者の名前（personName）を入れてください（入力の「担当者」の欄のまま）。');
  if (name.length > APP_PERSON_NAME_MAX) throw new Error('担当者の名前が長すぎます（' + APP_PERSON_NAME_MAX + ' 字まで）。');
  appPlanCheckArgs_([name]);
  const email = appNormalizeEmail_(input && input.email);
  if (!email) throw new Error('メンバーのメール（email）を入れてください。');
  const clientId = String(input && input.clientId || '').trim();
  const validFrom = String(input && input.validFrom || '').trim();
  const validTo = String(input && input.validTo || '').trim();
  [validFrom, validTo].forEach(d => { if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('日付は yyyy-MM-dd で入力してください。'); });
  if (validFrom && validTo && validTo < validFrom) throw new Error('終わりの日が始まりの日より前です。');
  const note = String(input && input.note || '').slice(0, APP_PERSON_NOTE_MAX);
  return appWithLock_(() => {
    if (!appReadTable_('MEMBERS').some(m => m.email === email && m.is_active)) {
      throw new Error('メンバーに登録済みの人だけつなげます（' + email + '）。先に saveMember で登録してください。');
    }
    if (clientId && !appReadTable_('CLIENTS').some(c => c.client_id === clientId)) throw new Error('メーカーが見つかりません（clientId）。');
    const from = d => d || '0000-01-01', to = d => d || '9999-12-31';
    const same = appReadTable_('PERSON_LINKS').filter(l => l.is_active && String(l.person_name || '').trim() === name && String(l.client_id || '') === clientId &&
      from(l.valid_from) <= to(validTo) && from(validFrom) <= to(l.valid_to));
    if (same.some(l => appNormalizeEmail_(l.email) === email)) throw new Error('同じつなぎが、同じ期間にすでにあります。');
    if (same.length) throw new Error('同じ名前（' + name + '）が、同じ範囲と期間に別の人につながっています。先に unlinkPerson で外してください。');
    const now = appNowIso_();
    const row = { link_id: appId_(APP_LOG_PREFIX.PERSON_LINKS), person_name: name, email: email, client_id: clientId, valid_from: validFrom, valid_to: validTo,
      is_active: true, note: note, created_at: now, created_by: ctx.actor, updated_at: now, updated_by: ctx.actor, row_version: 1 };
    appInsertRows_('PERSON_LINKS', [row]);
    return { link: row, audit: { entityId: row.link_id, clientId: clientId } };
  });
}

/** 外す: { linkId, rowVersion }（行は残して無効にする。rowVersion は 2026-10-13 から必須。所有者の操作は省けば今の版を読んで渡す） */
function appUnlinkPerson_(ctx, input) {
  appPersonOwnerOnly_(ctx);
  const id = String(input && input.linkId || '').trim();
  if (!id) throw new Error('外すつなぎの番号（linkId。listPersonLinks の link_id）を入れてください。');
  return appWithLock_(() => {
    const cur = appReadTable_('PERSON_LINKS').filter(l => l.link_id === id)[0];
    if (!cur) throw new Error('つなぎが見つかりません。');
    if (!cur.is_active) throw new Error('このつなぎはすでに外れています。');
    const r = appUpdateByKey_('PERSON_LINKS', { link_id: id }, { is_active: false }, input && input.rowVersion, ctx.actor);
    return { link: r.after, before: r.before, audit: { entityId: id, clientId: cur.client_id } };
  });
}

/**
 * 入力の担当者の名前（{ 名前: { メーカーの ID: true } }）: 計画の担当者（PLANS.people_csv）・入力の 4 つの表の Person・当たりの記録の人
 */
function appPersonInputNames_() {
  const out = {};
  const add = (name, clientId) => { const n = String(name === null || name === undefined ? '' : name).trim(); if (n) (out[n] = out[n] || {})[clientId || ''] = true; };
  const client = {};
  appReadTable_('PLANS').forEach(p => {
    client[p.plan_id] = p.client_id;
    String(p.people_csv || '').split(/[,、，]/).forEach(n => add(n, p.client_id));
  });
  ['ENG_PRODUCT', 'ENG_CLIENT', 'ENG_OPINIONS', 'ENG_DEV_SPOT'].forEach(t => {
    try { appReadTable_(t).forEach(r => { if (client[r.plan_id]) add(r.Person, client[r.plan_id]); }); } catch (e) { /* 読めない表は飛ばす */ }
  });
  try { appReadTable_('HIT_RECORDS').forEach(r => { if (r.source_kind === APP_HIT_KIND.PERSON) add(r.source_key, r.client_id); }); } catch (e) { /* 移行の前 */ }
  return out;
}

/**
 * つなぎの一覧（無効にした行も）と、入力の担当者の名前・案。返り値:
 *   links: [PERSON_LINKS の行]、names: [{ personName, clientIds, linked }]（名前の順。linked = 有効なつなぎがある）、
 *   suggestions: [{ personName, email, displayName, clientIds }]（まだつないでいない名前で、メンバーの表示名が同じもの）
 */
function appListPersonLinks_(ctx) {
  appPersonOwnerOnly_(ctx);
  const links = appReadTable_('PERSON_LINKS').map(appStripRow_);
  const linked = {};
  links.filter(l => l.is_active).forEach(l => { linked[String(l.person_name || '').trim()] = true; });
  const names = appPersonInputNames_();
  const norm = s => String(s || '').normalize('NFKC').replace(/[\s　]+/g, '');
  const members = appReadTable_('MEMBERS').filter(m => m.is_active && norm(m.display_name));
  const list = Object.keys(names).sort((a, b) => a.localeCompare(b, 'ja'));
  const suggestions = [];
  list.filter(n => !linked[n]).forEach(n => members.filter(m => norm(m.display_name) === norm(n)).forEach(m => {
    suggestions.push({ personName: n, email: m.email, displayName: m.display_name, clientIds: Object.keys(names[n]).filter(Boolean).sort() });
  }));
  return { links: links, names: list.map(n => ({ personName: n, clientIds: Object.keys(names[n]).filter(Boolean).sort(), linked: !!linked[n] })), suggestions: suggestions };
}
