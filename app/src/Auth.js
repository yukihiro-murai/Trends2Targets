/**
 * Auth.js — 本人確認と役割。アプリは所有者（デプロイした人）の権限で動くので、誰が何をできるかはここで決める。
 * - 所有者は常に管理者（2026-10-01 決定: アプリを動かしデータを持つのは村井さんのアカウント）
 * - 社内ドメインの人は、閲覧（VIEWER）と情報提供（CONTRIBUTOR）を自動で持つ
 * - 予算策定担当（PLANNER）・承認者（APPROVER）・管理者（ADMIN）は ROLES 表で付与する。PLANNER はクライアント単位にできる
 * メールが取れない人・社内ドメイン外の人には何も許さない（fail-closed）。
 */
function appCurrentUser_() {
  let email = '';
  let owner = '';
  try { email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { email = ''; }
  try { owner = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { owner = ''; }
  const domain = String(appProps_().getProperty(APP_PROP.internalDomain) || (owner.split('@')[1] || '')).toLowerCase();
  return {
    email: email,
    owner: owner,
    domain: domain,
    isOwner: !!email && email === owner,
    isInternal: !!email && !!domain && email.slice(-(domain.length + 1)) === '@' + domain
  };
}

/** その人が今持っている役割（{role, scope_type, client_id, source}） */
function appRolesOf_(user) {
  const out = [];
  if (!user || !user.email) return out;
  if (user.isOwner) out.push({ role: 'ADMIN', scope_type: 'ALL', client_id: '', source: 'OWNER' });
  if (user.isOwner || user.isInternal) {
    out.push({ role: 'VIEWER', scope_type: 'ALL', client_id: '', source: 'DOMAIN' });
    out.push({ role: 'CONTRIBUTOR', scope_type: 'ALL', client_id: '', source: 'DOMAIN' });
  }
  if (!user.isOwner && !user.isInternal) return out;  // 社内ドメイン外には付与があっても与えない
  let rows = [];
  try { rows = appIsSetUp_() ? appCachedRead_('ROLES\u0001' + Math.floor(new Date().getTime() / 600000), () => appReadTable_('ROLES')) : []; } catch (e) { rows = []; }
  // 読めなければ付与なし（最小の権限）。表は控えから（画面から変えれば控えはすぐ古くなる。表を手で直したときも 10 分で読み直す）
  const today = appToday_();
  // is_active は Notifications と同じく === true（真偽以外の真値では付与しない）
  rows.filter(r => r.is_active === true && r.email === user.email && APP_ROLES.indexOf(r.role) >= 0 &&
      (!r.valid_from || r.valid_from <= today) && (!r.valid_to || today <= r.valid_to))
    .forEach(r => out.push({ role: r.role, scope_type: r.scope_type === 'CLIENT' ? 'CLIENT' : 'ALL', client_id: r.client_id || '', source: r.role_id }));
  return out;
}

/**
 * minRole 以上の役割を持つか。clientId を渡すと、そのクライアントに限った役割も数える。
 * クライアント単位の役割は、clientId を指定しない（全体の）操作には効かない。
 */
function appHasRole_(roles, minRole, clientId) {
  const need = APP_ROLES.indexOf(minRole);
  if (need < 0) throw new Error('未定義の役割: ' + minRole);
  return (roles || []).some(r => {
    if (APP_ROLES.indexOf(r.role) < need) return false;
    if (r.scope_type === 'CLIENT') return !!clientId && r.client_id === clientId;
    return true;
  });
}

function appRoleSummary_(roles) {
  return (roles || []).map(r => r.role + (r.scope_type === 'CLIENT' ? ':' + r.client_id : '')).join(',');
}
