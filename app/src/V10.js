/**
 * V10.js — 表の版 10 の共通の道具（SCHEMA_PLAN_v10-12_JA.md の 3 章。2026-10-08 村井さん承認「版10はおすすめで」）。
 * - 記録の表（Schema.js の appendOnly）へ足すのは、appLogOps_ で作る控えの書き方 append だけ。本体の保存と同じ控え（appJournalRun_）に入れて一緒に書く。
 *   行は消さず書き換えない（直すときは新しい行を足す）。記録は計算に使わない。新しい自動の処理とメールは足さない（今ある操作の中で書く）。
 * - 見せる範囲はサーバーの応答で絞る（appLogViewer_・appLogVisible_）。人の名前は予算策定担当以上だけ（2026-10-07）。
 * - 一度だけの写し（APP_V10_BACKFILLS）: 表の版がそろった後の操作の初めに、名前の順に動かす（Setup.js の appRunBackfills_）。
 *   中身は、それぞれの記録を作るときに書く（今は仮のもの。{ skipped: true } を返すと、記録せずに次の操作でまた呼ぶ）。
 */

/** 記録の番号の頭（appNewLogId_・appStableLogId_ に渡す） */
const APP_LOG_PREFIX = { INPUT_LOG: 'INL', AI_RESEARCH_LOG: 'AIR', LAYER_EFFECTS: 'LEF', HIT_RECORDS: 'HIT', LEARNING_LOG: 'LRN',
  PERSON_LINKS: 'PLK', BACKTEST: 'BTP', FORECAST_METHODS: 'FMR', METHOD_WEIGHTS: 'MWT' };

/** 測る専用の計画（PLANS.purpose。3-9）と、その数の上限（9 章 9: まず 5 計画） */
const APP_PLAN_MEASURE = 'MEASURE';
const APP_MEASURE_PLAN_MAX = 5;

/** 版 10 の一度だけの写し（名前だけ。関数は動かすときに探す）。それぞれの中身は、その記録を作るときに書く */
const APP_V10_BACKFILLS = ['appV10BackfillInputLog_', 'appV10BackfillAiResearchLog_', 'appV10BackfillHitRecords_'];
/** 一度だけの写しの行の「した人」（入力の記録の actor_email・当たりの記録の computed_by）。写しを動かした操作の人ではない（画面には人として出さない） */
const APP_V10_BACKFILL_ACTOR = 'SYSTEM:V10_BACKFILL';
/** 記録の「した人」が仕組み（人ではない）か（画面に名前として出さない） */
function appLogSystemActor_(v) {
  return String(v || '').indexOf('SYSTEM:') === 0;
}

/**
 * 表の版の移行（列を足す。版 10・11）が済むまで始めない処理の、断る文（始めてよければ ''）。予測の実行・計画を作る・担当者の保存は、
 * 列を足す前の表（版 10 の FORECAST_RUNS・PLANS）に書くので、移行がバックアップを待っている間は、長い計算をする前に断る（Jobs.js の appStartJob_ から）。
 * 版 11 で列を足す公式版（PLAN_VERSIONS）は短い保存なので、書くところ（appRequireCurrentHead_）で止まる
 */
function appV10WaitRefusal_(kind, payload) {
  const action = String((payload && payload.action) || '');
  const what = kind === 'FORECAST.RUN' ? '予測の実行' : kind === 'PLAN.CREATE' ? '計画の作成' : kind === 'PLAN.EDIT' && action === 'SETUP.PEOPLE' ? '担当者の保存' : '';
  if (!what || appLogReady_()) return '';
  return '表の版 ' + APP_SCHEMA_VERSION + ' の移行（列を足す）がまだ済んでいないので、' + what + 'は始めません。移行の前のバックアップが取れると、次の操作で移行します。少したってから、もう一度操作してください。';
}

// ---- 記録を足す ----

/**
 * 記録の表に行を足す控えの書き方（ops の配列。本体の ops に concat して appJournalRun_ に渡す）。行が無ければ [] を返す。
 * 行はここで確かめて形をそろえる（表に無い列・空のキー・plan_id の無い行は止める。数の列は数か空にし、数でなければ止める。
 * 4 万字を超えるセルはハッシュと先頭だけにしてエラーのログに残す。同じキーの行が 2 つあれば止める）。止めるのは控えを置く前なので、本体も書かない
 * （呼んだ側が投げたままにすれば保存は失敗し、何も書かない。一度だけの写しは、その計画を飛ばす）。
 * キーは控えを作るときに決める（appNewLogId_・appStableLogId_）。書くときに作らない（控えの書き直しで同じ行になるように）。
 * その表をまだ書けない（appLogReady_(table): 表が無い・列を足す前の見出し・版 11 の下書きの表で移行がまだ）ときは、記録を足さずに [] を返す
 * （本体の保存は止めない。エラーのログに残す）
 */
function appLogOps_(table, rows) {
  const def = APP_TABLES[table];
  if (!def || !def.appendOnly) throw new Error('追記だけの記録の表ではありません: ' + table);
  const list = (rows || []).filter(r => r);
  if (!list.length) return [];
  const out = list.map(r => appLogRow_(table, def, r));
  appLogRequireUnique_(table, out);
  if (!appLogReady_(table)) {
    appLogError_('LOG.SKIPPED', new Error('表の版がそろう前なので、記録を足しませんでした（' + table + '・' + out.length + ' 行）。'), null);
    return [];
  }
  return [{ table: table, mode: 'append', rows: out }];
}

/**
 * 足す行の中に同じキーの行が 2 つ無いかを、控えを置く前に確かめる（あれば止める）。書くときに appAppendLogRows_ が止めると、
 * 書きかけの控えが残り、控えを書き直すたびに同じところで止まって、ほかの計画の保存まで止めるため（Journal.js の appJournalRequireAppends_ からも呼ぶ）
 */
function appLogRequireUnique_(table, rows) {
  const def = APP_TABLES[table];
  if (!def) throw new Error('未定義の表: ' + table);
  const seen = {};
  (rows || []).forEach(o => {
    const k = def.key.map(c => String(o[c] === undefined || o[c] === null ? '' : o[c])).join('\u0001');
    if (seen[k]) throw new Error('同じキーの行が 2 つあるので、記録を足せません（' + table + ' の ' + def.key.join('・') + ': ' + k.replace(/\u0001/g, ' / ') + '）。何も書いていません。');
    seen[k] = true;
  });
}

/**
 * 記録の表を書けるか。table を省くと、表の版がそろったか（印 APP_PROP.tablesVersion。appEnsureTables_ が付ける）だけを見る
 * （一度だけの写し・予測の実行を断るか・年度を締めるか など、版がそろってから動くもの）。
 * table を渡すと、その表ごとに決める（2026-10-09。前は版の印だけを見ていたので、版 11 の移行がバックアップを待っている間、もうある版 10 の
 * 記録の表（入力の記録の自信など）にも足さず、その保存の記録が失われていた）:
 *   版がそろっていれば書ける。そろう前は、表があり、見出しが今の列（列を足す前の見出しでない）なら書ける。
 *   ただし版がそろうまで待つ表（APP_LOG_WAIT_TABLES。版 11 の予算の下書き）は書かない（一度だけの写しと、予測し直したときの戻しが版 11 の後の決まりで動くため）
 */
function appLogReady_(table) {
  if (appProps_().getProperty(APP_PROP.tablesVersion) === String(APP_SCHEMA_VERSION)) return true;
  if (!table || APP_LOG_WAIT_TABLES.indexOf(table) >= 0) return false;
  try {
    appTableSheet_(table, false);   // 無い・どの版の列でもなければ投げる
    return !(APP_STORE_CACHE_.width && APP_STORE_CACHE_.width[table]);   // 列を足す前の見出し（移行がまだ）は書かない
  } catch (e) {
    return false;
  }
}

/** 記録の 1 行を確かめ、控えに置く形にする（列の型に合わせる） */
function appLogRow_(table, def, r) {
  const extra = Object.keys(r).filter(k => def.columns.indexOf(k) < 0);
  if (extra.length) throw new Error('表に無い列です（' + table + '）: ' + extra.join(', '));
  const empty = v => v === undefined || v === null || v === '';
  if (def.key.some(k => empty(r[k]))) throw new Error('キーが空の行は足せません（' + table + '）。');
  if (def.columns[0] === 'plan_id' && !def.globalRows && empty(r.plan_id)) throw new Error('計画（plan_id）が空の行は足せません（' + table + '）。');
  const o = {};
  Object.keys(r).forEach(c => {
    let v = r[c];
    if (v === undefined) return;
    const t = appColumnType_(c, def);
    if (t === 'num' || t === 'int') {
      if (v === null || v === '') v = null;
      else {
        const n = typeof v === 'number' ? v : Number(v);
        if (typeof v === 'boolean' || !isFinite(n)) throw new Error('数の列に数でない値があります（' + table + ' の ' + c + '）。');
        v = t === 'int' ? Math.round(n) : n;
      }
    } else if (t === 'bool') v = v === true || v === 'TRUE' || v === 1 || v === '1';
    else if (t === 'json') v = v === null || typeof v === 'string' ? v : JSON.stringify(v);
    else if (v !== null) v = String(v);
    if (typeof v === 'string' && v.length > APP_JSON_MAX) {
      appLogError_('LOG.TRUNCATED', new Error('記録のセルが長すぎるので、ハッシュと先頭だけにしました（' + table + ' の ' + c + '・' + v.length + ' 字）。'), null);
      v = appJson_(v);
    }
    o[c] = v;
  });
  return o;
}

/** 記録の番号（時刻順。例: INL-20261008153000-1A2B3C4D5E6F）。控えを作るときに決める */
function appNewLogId_(prefix) {
  return String(prefix) + '-' + Utilities.formatDate(new Date(), APP_TZ, 'yyyyMMddHHmmss') + '-' +
    Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase();
}

/** 中身から決まる記録の番号（同じ中身なら同じ番号。例: 予測の回と月）。2 回動かしても二重に足さないための印 */
function appStableLogId_(prefix, parts) {
  return String(prefix) + '-' + appSha256Hex_((parts || []).map(p => (p === undefined || p === null ? '' : String(p))).join('\u0001')).slice(0, 24).toUpperCase();
}

/** 表の中の、切り詰めた（ハッシュと先頭だけにした）セルの数（テストで、記録が 4 万字に収まっていることを確かめる） */
function appLogTruncatedCells_(table) {
  let n = 0;
  appRawTable_(table).forEach(r => r.forEach(v => { if (String(v).indexOf('{"truncated":true') === 0) n++; }));
  return n;
}

// ---- 見せる範囲（3-1・3-4: 入力の記録と当たりの記録。2026-10-08 承認）----

/**
 * 記録を見る人: full = 予算策定担当以上（そのメーカー単位の担当を含む。clientId で数える）は全部の行と名前。
 * ほかの人（閲覧・情報提供）は、つなぎ（PERSON_LINKS）で本人と分かる自分の行だけ。ほかの行は種類ごとの件数だけ（名前は送らない）。
 * 本人の行かは、行ごとにその行の日に効く有効なつなぎで決める（appLogVisible_。今日のつなぎで前の行を決めない: 外したつなぎ・期間の外のつなぎは効かない）。
 * links = 決めるのに使うつなぎの行（full の人とメールの無い人は空。行は送らない）
 */
function appLogViewer_(ctx, clientId) {
  const email = String((ctx && ctx.user && ctx.user.email) || '').trim().toLowerCase();
  const full = appHasRole_(ctx && ctx.roles, 'PLANNER', clientId || undefined);
  return { full: full, email: email, clientId: String(clientId || ''), links: full || !email ? [] : appPersonLinks_() };
}

/** 行の日（'yyyy-MM-dd'。日時の文字の頭 10 字。読めなければ ''） */
function appLogDay_(v) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v === null || v === undefined ? '' : v).trim());
  return m ? m[1] : '';
}

/**
 * 記録の行を、見る人に合わせて分ける。返り値 { rows: 送る行, counts: 送らない行の種類ごとの件数, hidden: 送らない行の数 }。
 * opts: personOf(r) = 行の担当者の名前（入力の記録は r.person・当たりの記録は人の行の r.source_key）、
 * dateOf(r) = 行の日（入力の記録は保存した日・当たりの記録は四半期の終わりの日。読めない行は本人の行にしない。dateOf を省くと今日）、
 * typeOf(r) = 件数を数える種類（例: r.kind・r.source_kind）。
 * 本人の行 = その日に効く有効なつなぎで、名前がこの人のメールにつながる行（appPersonEmailOf_。そのメーカーのつなぎが先）。
 * 行に残したメール（当たりの記録の person_email）は書いたときの控えなので、見せるかどうかには使わない。送る行の中の名前は、そのまま（本人の名前だけ）
 */
function appLogVisible_(viewer, rows, opts) {
  const o = opts || {};
  const list = rows || [];
  if (viewer && viewer.full) return { rows: list.slice(), counts: {}, hidden: 0 };
  const email = viewer && viewer.email ? String(viewer.email).trim().toLowerCase() : '';
  const links = (viewer && viewer.links) || [];
  const clientId = viewer && viewer.clientId ? String(viewer.clientId) : '';
  const today = appToday_();
  const memo = {};
  const own = r => {
    if (!email) return false;
    const p = o.personOf ? String(o.personOf(r) || '').trim() : '';
    if (!p) return false;
    const day = o.dateOf ? appLogDay_(o.dateOf(r)) : today;
    if (!day) return false;
    const k = p + '\u0001' + day;
    if (!Object.prototype.hasOwnProperty.call(memo, k)) memo[k] = appPersonEmailOf_(p, clientId, day, links) === email;
    return memo[k];
  };
  const out = [], counts = {};
  list.forEach(r => {
    if (own(r)) { out.push(r); return; }
    const k = o.typeOf ? String(o.typeOf(r) || '') : '';
    counts[k] = (counts[k] || 0) + 1;
  });
  return { rows: out, counts: counts, hidden: list.length - out.length };
}

/** 人のつなぎの行（読めなければ空。つなぎが無いときは、本人の行も無いことにする） */
function appPersonLinks_() {
  try { return appReadTable_('PERSON_LINKS'); } catch (e) { return []; }
}

/** つなぎがその日に効くか（有効・期間の中） */
function appPersonLinkLive_(l, ymd) {
  return !!l.is_active && (!l.valid_from || l.valid_from <= ymd) && (!l.valid_to || ymd <= l.valid_to);
}

/**
 * 担当者の名前（入力の「担当者」の欄のまま）がつながるメンバーのメール。無い・決められないときは ''。
 * そのメーカーのつなぎを先に見て、無ければ全部のメーカーのつなぎ（client_id が空）を見る。同じ名前が 2 人につながるときは決めない
 */
function appPersonEmailOf_(name, clientId, ymd, links) {
  const day = ymd || appToday_();
  const n = String(name || '').trim();
  if (!n) return '';
  const live = (links || appPersonLinks_()).filter(l => String(l.person_name || '').trim() === n && appPersonLinkLive_(l, day));
  const own = clientId ? live.filter(l => l.client_id === clientId) : [];
  const pick = own.length ? own : live.filter(l => !l.client_id);
  const emails = pick.map(l => String(l.email || '').trim().toLowerCase()).filter((v, i, a) => v && a.indexOf(v) === i);
  return emails.length === 1 ? emails[0] : '';
}

// ---- 測る専用の計画（3-9）と年度を締める条件 ----

/** 測る専用の計画か（PLANS.purpose が MEASURE） */
function appPlanIsMeasure_(plan) {
  return String((plan && plan.purpose) || '') === APP_PLAN_MEASURE;
}

/** 年度を締めるとき、公式版が要る計画（測る専用の計画は外す。YearClose.js の appYearCheck_ から） */
function appYearPlansNeedingVersion_(plans) {
  return (plans || []).filter(p => !appPlanIsMeasure_(p));
}

/**
 * 年度を締める前に、年度の最後の四半期（1〜3 月）の当たりを数え終えたか（9 章 10。締めた年度の行は書けないため）。
 * 数え終えていなければ理由の文、済んでいれば ''。中身は HitRecords.js（appHitYearPending_）
 */
function appYearHitsPending_(fy, plans) {
  return appHitYearPending_(fy, plans);
}

// ---- 一度だけの写し（版 10 の移行の後に 1 回。Setup.js の appRunBackfills_ が呼ぶ）----
// 返り値: { rows: 足した行の数 }（済み）・{ more: true, rows }（続きがある。次の操作でまた呼ぶ）・{ skipped: true }（仮のもの。記録しない）。
// 自分で appWithLock_ の中で appJournalRun_ を使って書く。キーは中身から決める（appStableLogId_）。1 回は数十秒までに収める。

/** 入力の記録の BASELINE（3-1: 今の 4 つの入力の表の行を 1 回だけ写す。InputLog.js） */
function appV10BackfillInputLog_(ctx) {
  return appInputLogBackfill_(ctx);
}

/** AI 調査の記録の BASELINE（3-2: 今の AI_RESEARCH_STRUCTURED の 1 回分。中身は AiResearchLog.js） */
function appV10BackfillAiResearchLog_(ctx) {
  return appAiResearchBackfill_(ctx);
}

/** 当たりの記録（3-4: 版 10 の時点で締まっている四半期の分。calc_version に BACKFILL を添える）。中身は HitRecords.js（appHitBackfill_） */
function appV10BackfillHitRecords_(ctx) {
  return appHitBackfill_(ctx);
}
