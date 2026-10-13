/**
 * Notifications.js — 毎日の処理（バックアップと手入れ。triggerDailyBackup → appDailyMaintenance_）で
 * 異常があった日にだけ、管理者へメールを送る。正常な日は送らない。
 * 手で動かす入口（apiRunBackup・apiRunHousekeeping・apiVerifyAudit）は呼ばない（知らせは定期の処理だけ）。
 *
 * - 送る先は「所有者」と、ROLES 表でいま効いている全体の管理者だけ（呼び出し側から宛先を受け取らない）。
 *   社外のメール・クライアント単位の管理者・期限の切れた・無効な付与は除く。決められなければ空（fail-closed）。
 * - メールには、顧客名・ID・金額・エラーの文を入れない（異常の種類だけ）。実行ログにも宛先と本文は残さない。
 * - 同じ日に同じ知らせを何度も送らないよう、「日付 + 宛先 + 種類」の指紋（SHA-256）を所有者の UserProperties に控える。
 * - 送信の失敗（その日の枠・許可・一時的なエラー）は例外にせず FAILED を返す（知らせの失敗で毎日の処理を潰さない）。
 * - 注意: メールの送信と控えの記録は別の操作なので、Google 側の障害の途中では
 *   「送れたのに控えられなかった」（翌回もう一度届く）・「控えたのに届いていない」ことが起こりうる。
 *   そのときは FAILED を返して実行ログに残す（届いたかどうかは保証しない）。
 */
const APP_MAINTENANCE_NOTICES_PROP = 'APP_MAINTENANCE_NOTICES';
/** 知らせる異常の種類（この一覧以外のコードは送らない） */
const APP_MAINTENANCE_CODE_LABELS = {
  BACKUP: 'バックアップ',
  HOUSEKEEPING: '毎日の手入れ',
  AUDIT: '監査の鎖の確認',
  OPEN_STARTS: '途中で止まった操作',
  JOURNAL: '保存の控え',
  ERRORS: 'エラーの記録'
};

/** ドメイン部として正しいか（ラベルを . でつなぐ ASCII のホスト名。空ラベル・区切り文字・空白は不可） */
const APP_MAIL_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
/** メールアドレス 1 件として正しいか（複数宛先・空白・不等号・改行をはさむ文字列は使わない） */
function appMailAddressOk_(email, domain) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || e.length > 254 || /[\s,;"'<>\\@]/.test(e.slice(0, e.lastIndexOf('@'))) || e.split('@').length !== 2) return false;
  const local = e.split('@')[0], dom = e.split('@')[1];
  return !!local && !!domain && APP_MAIL_DOMAIN_RE.test(domain) && dom === domain;
}

/**
 * 知らせを受け取る人（小文字・重複なし）。所有者（ctx.user.owner。無ければ実効ユーザー）と、
 * いま効いている全体の管理者の付与（ROLES: is_active かつ role=ADMIN かつ scope_type=ALL で今日が期間内）。
 * 社外のメールは除く（社内ドメインの設定か、所有者のドメインで判定）。所有者が分からなければ空（fail-closed）。
 * 役割の表が読めないときは所有者だけに送る。
 */
function appMaintenanceRecipients_(ctx) {
  let owner = String((ctx && ctx.user && ctx.user.owner) || '').trim().toLowerCase();
  if (!owner) {
    try { owner = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { owner = ''; }
  }
  if (!owner || owner.split('@').length !== 2 || !owner.split('@')[0]) return [];
  const domain = String(appProps_().getProperty(APP_PROP.internalDomain) || owner.split('@')[1] || '').trim().toLowerCase();
  if (!domain) return [];
  const isInternal = e => appMailAddressOk_(e, domain);
  if (!isInternal(owner)) return [];   // 所有者が正しい社内のアドレスでなければ、ほかの人にも送らない（fail-closed）
  const out = [owner];
  let rows = null;
  try { rows = appIsSetUp_() ? appReadTable_('ROLES') : []; } catch (e) { rows = null; }
  if (rows === null) return out;   // 表が読めなくても所有者には届ける
  const today = appToday_();
  rows.forEach(r => {
    const email = String(r.email || '').trim().toLowerCase();
    if (r.is_active !== true || r.role !== 'ADMIN' || r.scope_type !== 'ALL') return;
    if ((r.valid_from && r.valid_from > today) || (r.valid_to && today > r.valid_to)) return;
    if (!isInternal(email) || out.indexOf(email) >= 0) return;
    out.push(email);
  });
  return out;
}

/**
 * メールの許可を確かめる（所有者が Apps Script エディタで 1 回だけ実行する）。
 * 公開のあと、権限を足した版では最初の定期実行の前に、Google の許可の画面でメールを送る権限を認めてもらう。
 * メールは送らない・送信件数も読まない（許可があることを確かめるだけ）。所有者以外は実行できない。
 */
function appAuthorizeMaintenance_() {
  const user = appCurrentUser_();
  if (!user.isOwner) throw new Error('この操作をする権限がありません。');
  ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, ['https://www.googleapis.com/auth/script.send_mail']);
  return { ok: true, message: '異常の通知の許可があります。' };
}

/**
 * 異常の種類（codes: APP_MAINTENANCE_CODE_LABELS のキー）を、管理者 1 人ずつへ別々に送る（宛先を互いに見せない）。
 * 返り値 { status: 'SENT'|'SKIPPED'|'FAILED', sent, recipients, failed, reason }。宛先と本文は返り値・記録に入れない。
 * 例外は投げない（宛先の解決・控えの読み書き・ロック・送信のどれで失敗しても FAILED を返す）。
 * ロックの中で「宛先の解決 → 同じ日の控え → 控えの容量と送信枠 → 送信（送れた分だけ即座に印を書く）」を行う。
 * 実行ログはロックの外で書く（残すのは種類と結果だけ。宛先・本文は残さない）。
 */
function appNotifyMaintenance_(ctx, codes) {
  const list = [];
  (codes || []).forEach(c => { if (Object.prototype.hasOwnProperty.call(APP_MAINTENANCE_CODE_LABELS, c) && list.indexOf(c) < 0) list.push(c); });
  if (!list.length) return { status: 'SKIPPED', reason: 'none', sent: 0 };
  let res;
  try {
    res = appWithLock_(() => {
      // 宛先はロックの中で解決する（読みと送信の間に付与が変わると、外した人に届くことがある）
      const recipients = appMaintenanceRecipients_(ctx);
      if (!recipients.length) return { status: 'FAILED', reason: 'no-recipients', sent: 0 };
      const day = appToday_();
      const body = '毎日の処理で、確認してほしいことがあります。\n\n'
        + list.map(c => '・' + APP_MAINTENANCE_CODE_LABELS[c]).join('\n')
        + '\n\nアプリを開き、「記録と状態」で中身を確かめてください。\n（このメールは自動で送られています）';
      // 同じ日の控えを読む。控えの読み込み自体の失敗は外側の FAILED に任せる（読めずにリセットして再送しない）。
      // JSON が壊れているときだけ新しい控えとして始める（読めない印は残さない）
      const raw = appProps_().getProperty(APP_MAINTENANCE_NOTICES_PROP);
      let box = { day: day, sent: [] };
      try {
        const p = JSON.parse(raw || 'null');
        if (p && p.day === day && Array.isArray(p.sent)) box = { day: day, sent: p.sent.filter(x => typeof x === 'string') };
      } catch (e) { box = { day: day, sent: [] }; }
      const want = recipients.map(r => ({ to: r, fp: appSha256Hex_(day + '\u0001' + r + '\u0001' + list.slice().sort().join(',')) }));
      const pending = want.filter(w => box.sent.indexOf(w.fp) < 0);
      if (!pending.length) return { status: 'SKIPPED', reason: 'already-sent', sent: 0 };
      // 控え（1 つの値は約 9KB）は送る前に入る量を確かめる。入りきらないときは誰にも送らず、古い印は捨てない
      const projected = { day: day, sent: box.sent.concat(pending.map(w => w.fp)) };
      if (appUtf8Bytes_(JSON.stringify(projected)) >= 8000) return { status: 'FAILED', reason: 'capacity', sent: 0 };
      // その日の送信枠が全員分に足りなければ、誰にも送らない（枠が読めない・数でなければ送らない）
      let quota = null;
      try { quota = MailApp.getRemainingDailyQuota(); } catch (e) { quota = null; }
      if (!Number.isFinite(quota) || quota < pending.length) return { status: 'FAILED', reason: 'quota', sent: 0 };
      let sent = 0, failed = 0;
      for (const w of pending) {
        try { MailApp.sendEmail(w.to, APP_NAME + ' 要対応', body); }
        catch (e) { failed++; Logger.log('管理への知らせを送れませんでした'); continue; }   // エラーの文（宛先を含むことがある）は残さない
        sent++;
        // 送れた分はすぐ印にする（このあと止まっても、次の実行で同じ人にもう一度送らない）
        box.sent.push(w.fp);
        try { appProps_().setProperty(APP_MAINTENANCE_NOTICES_PROP, JSON.stringify(box)); }
        catch (e) { Logger.log('管理への知らせの印を控えられませんでした'); return { status: 'FAILED', reason: 'persist', sent: sent, recipients: recipients.length, failed: failed }; }
      }
      return { status: failed ? 'FAILED' : 'SENT', reason: failed ? 'send' : '', sent: sent, recipients: recipients.length, failed: failed };
    });
  } catch (e) {
    Logger.log('管理への知らせに失敗しました');
    res = { status: 'FAILED', reason: 'exception', sent: 0 };
  }
  // 実行ログはロックの外で（残すのは種類と結果だけ。宛先・本文は残さない）。ログが書けなくても知らせの結果は返す
  try {
    appRunLog_({ requestId: (ctx && ctx.requestId) || '', kind: 'MAINTENANCE.NOTIFY', status: res.status,
      detail: { codes: list, sent: res.sent, recipients: res.recipients || 0, reason: res.reason || '' } });
  } catch (e) { Logger.log('知らせの実行ログを残せませんでした'); }
  return res;
}
