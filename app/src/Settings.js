/**
 * Settings.js — 業務の数値の設定表。コードには既定値と範囲だけを持ち、変えた値は SETTINGS に 1 行ずつ足す（上書きしない）。
 * 今の値 = effective_from が今日以前の行のうち最も新しいもの。無ければ既定値。
 * 既定値は旧来の仕組みの値（Forecast_Agent.js の定数・空模様の判定）と同じにしてある。
 */
const APP_SETTING_DEFS = {
  // 売上・検証用実績の取り込み（A-2・B-1）の元（ZAC の実績のスプレッドシート）。
  // 2026-10-04: 使っていなかった設定（検証の上限・空模様の判定・操作の記録）を外した。数・整数・する/しないの型は、足すときのために残す。
  // 書けるのは所有者だけ（owner。2026-10-13）: 取り込みは所有者の権限でこのブックを読むので、所有者でない管理者が「所有者が開ける任意のブック」に
  // 向けられないようにする。スプレッドシートを指す設定（type: 'sheet'）は、どれも owner にする（app/tests が確かめる）
  'source.zac_spreadsheet': { label: 'ZAC の実績のスプレッドシート', type: 'sheet', def: '', unit: 'スプレッドシートの URL（売上・実績の取り込みの元）', owner: true },
  // 着地見込みの年の水準のぶれ（τ）と幅の倍率（w）。2026-10-08 村井さん承認の判断 29・11: 全計画から学んだ値（学びの画面に「試し」で出す）は、
  // 所有者が承認してここに書くまで使わない（書いていなければ 0.15 と 1）。書けるのは所有者だけ（owner）。
  // 範囲は Landing.js の APP_LANDING（TAU_MIN〜TAU_MAX・1〜W_MAX）と同じ数を書く（ファイルの読み込みの順に頼らない。app/tests が照合する）
  'landing.tau': { label: '着地見込みの年の水準のぶれ', type: 'number', min: 0.05, max: 0.35, def: 0.15, unit: '割合（0.15 = 15%）', owner: true },
  'landing.w': { label: '着地見込みの幅の倍率', type: 'number', min: 1, max: 3, def: 1, unit: '倍（1 = 月の見通しの幅のまま）', owner: true }
};

/** URL か ID からスプレッドシートの ID を取り出す（取り出せなければ空） */
function appParseBookId_(input) {
  const s = String(input || '').trim();
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/.exec(s);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : '';
}

/** 文字列や数値を設定の型に直し、範囲を確かめる。だめなら例外 */
function appParseSettingValue_(key, raw) {
  const d = APP_SETTING_DEFS[key];
  if (!d) throw new Error('未定義の設定です: ' + key);
  if (d.type === 'sheet') {
    // URL か ID。開けるスプレッドシートであることを確かめ、ID で持つ
    const id = appParseBookId_(raw);
    if (!id) throw new Error(d.label + ' は、スプレッドシートの URL で入力してください。');
    let file;
    try { file = DriveApp.getFileById(id); } catch (e) { throw new Error(d.label + ' を開けません（URL と共有を確かめてください）。'); }
    if (file.getMimeType() !== MimeType.GOOGLE_SHEETS || file.isTrashed()) throw new Error(d.label + ' は、スプレッドシートを指定してください。');
    return id;
  }
  if (d.type === 'bool') {
    if (raw === true || raw === 'true' || raw === 'TRUE' || raw === 1 || raw === '1') return true;
    if (raw === false || raw === 'false' || raw === 'FALSE' || raw === 0 || raw === '0') return false;
    throw new Error(d.label + ' は「する / しない」で指定してください。');
  }
  const n = Number(String(raw).trim());
  if (String(raw).trim() === '' || !isFinite(n)) throw new Error(d.label + ' は数値で入力してください。');
  if (d.type === 'int' && Math.floor(n) !== n) throw new Error(d.label + ' は整数で入力してください。');
  if (n < d.min || n > d.max) throw new Error(d.label + ' は ' + d.min + '〜' + d.max + ' の範囲で入力してください。');
  return n;
}

/** すべての設定の今の値（未設定なら既定値）と、その履歴の件数 */
function appSettingsCurrent_() {
  const rows = appIsSetUp_() ? appReadTable_('SETTINGS') : [];
  const today = appToday_();
  return Object.keys(APP_SETTING_DEFS).map(key => {
    const d = APP_SETTING_DEFS[key];
    // 効き始める日の順。同じ日なら後から足した行（シートの下の行）を新しいとする
    const hist = rows.filter(r => r.key === key && (r.scope || 'GLOBAL') === 'GLOBAL')
      .sort((a, b) => (a.effective_from < b.effective_from ? -1 : a.effective_from > b.effective_from ? 1 : a._row - b._row));
    const live = hist.filter(r => r.effective_from <= today).pop();
    let value = d.def;
    let fromLive = false;
    // スプレッドシートの指定は、保存のときに確かめた ID をそのまま使う（読むたびに Drive を開かない）。
    // 壊れた行は既定値に戻し、isDefault も true にする（承認済みと誤認しない。appLandingApproved_）
    try {
      if (live) {
        value = d.type === 'sheet' ? String(live.value) : appParseSettingValue_(key, live.value);
        fromLive = true;
      }
    } catch (e) { value = d.def; fromLive = false; }
    return {
      key: key, label: d.label, type: d.type, unit: d.unit, min: d.min === undefined ? null : d.min, max: d.max === undefined ? null : d.max,
      def: d.def, value: value, isDefault: !fromLive, effectiveFrom: fromLive ? live.effective_from : '',
      updatedAt: fromLive ? live.created_at : '', updatedBy: fromLive ? live.created_by : '',
      scheduled: hist.filter(r => r.effective_from > today).map(r => ({ value: r.value, effectiveFrom: r.effective_from }))
    };
  });
}

function appSettingValue_(key) {
  const s = appSettingsCurrent_().filter(x => x.key === key)[0];
  if (!s) throw new Error('未定義の設定です: ' + key);
  return s.value;
}

/**
 * 着地見込み（と、その分布を使う年度の見込みの試し・予算に届く見込み）に使う τ・w（2026-10-08 村井さん承認の判断 29・11）。
 * 業務の設定 landing.tau・landing.w（所有者が承認した値を apiOwnerTask の saveSetting で書く）の今の値。
 * 書いていなければ決まった値 0.15（APP_LANDING.TAU0）と 1。全計画から学んだ値（appLandingPrior_）は、ここでは使わない。
 * 返り値: { tau, w, tauSet, wSet（設定に書いた値か）, tauFrom, wFrom（その値が効き始めた日。書いていなければ ''） }
 */
function appLandingApproved_() {
  const s = {};
  appSettingsCurrent_().forEach(x => { s[x.key] = x; });
  const t = s['landing.tau'], w = s['landing.w'];
  const ok = (x, lo, hi) => x && !x.isDefault && typeof x.value === 'number' && isFinite(x.value) && x.value >= lo && x.value <= hi;
  const tauSet = ok(t, APP_LANDING.TAU_MIN, APP_LANDING.TAU_MAX), wSet = ok(w, 1, APP_LANDING.W_MAX);
  return { tau: tauSet ? t.value : APP_LANDING.TAU0, w: wSet ? w.value : 1, tauSet: tauSet, wSet: wSet,
    tauFrom: tauSet ? String(t.effectiveFrom || '') : '', wFrom: wSet ? String(w.effectiveFrom || '') : '' };
}

/** 設定を変える（新しい行を足す）。effectiveFrom 省略時は今日から */
function appSaveSetting_(ctx, input) {
  const key = String(input && input.key || '');
  const def = APP_SETTING_DEFS[key];
  // 所有者だけの設定（ZAC の実績のスプレッドシート・着地見込みの τ・w = 学んだ値の承認）。管理者の役割があっても、ほかの人は書けない（setCalibration と同じ）
  if (def && def.owner && !(ctx && ctx.user && ctx.user.isOwner)) throw new Error(def.label + ' は、所有者だけが変えられます。');
  const value = appParseSettingValue_(key, input && input.value);
  const eff = String(input && input.effectiveFrom || '').trim() || appToday_();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eff)) throw new Error('効き始める日は yyyy-MM-dd で入力してください。');
  const before = appSettingsCurrent_().filter(x => x.key === key)[0];
  const row = {
    setting_id: appId_('ST'), key: key, value: String(value), scope: 'GLOBAL', scope_id: '', effective_from: eff,
    note: String(input && input.note || '').slice(0, 500), created_at: appNowIso_(), created_by: ctx.actor
  };
  // τ・w の承認は学びの記録にも残す（版 10 の 3-5。LearnLog.js）。そのときは設定の行と同じ控えで書く
  const log = appLearnSettingOps_(ctx, key, before, value, eff, row.note);
  appWithLock_(() => (log.length ? appJournalRun_(ctx, '設定の保存（' + key + '）', '', [{ table: 'SETTINGS', mode: 'ensure', rows: [row] }].concat(log))
    : appInsertRows_('SETTINGS', [row])));
  return { saved: row, before: before, audit: { entityId: key } };
}
