/**
 * HitRecords.js — 当たりの記録（HIT_RECORDS。SCHEMA_PLAN_v10-12_JA.md の 3-4。2026-10-08 村井さん承認「版10はおすすめで」）。
 * - 人（入力の「担当者」の名前）・AI 調査 1 回（A-4）× 締まった四半期で 1 件と数える（今の記録は 1 つの判断を月の数だけ数えている）。
 * - 当たり（9 章 7）: 押した向きが、実績が「統計だけの予測」から外れた向きと同じなら当たり。四半期の 3 か月の合計で比べる。
 *   統計だけの予測と押しは、その月が始まる前の最後の予測の回の記録（AI_IMPACT_HISTORY の pred_p50_quant_only・k_ai、
 *   SUBJECTIVE_IMPACT_HISTORY の押し）から読む（旧来の C-1 の当たりと同じ回の選び方。D6）。実績は今の版の B-2 が測った EVAL_LOG の行。
 *   締まった月（月末から 5 日たって取り込んだ月。appLandingCutoff_）だけを使い、締まっていない月が 1 つでも入る四半期は数えない。
 *   FORECAST_SNAPSHOT の base_pred は混合の P50（旧来の計算は人と AI の効きを 0 と書く）なので、統計だけの予測には使わない。
 * - 四半期の印（source_kind QUARTER）: 3 か月が締まった四半期に 1 行（押した人がいなくても数えたことが分かる。年度を締める条件）。
 *   n_months = 実績と予測の回がそろった月の数。3 に足りない四半期は印だけ（months_json に足りない月）で、人と AI の行は作らない。
 *   足りない月の miss: 'forecast' = その月が始まる前の予測の回が無い。'none' = 今の版の B-2 を動かした後なのに測った行が無い
 *   （売上の記録が無い月。旧来の B-2 は実績の無い月を測らない。B-2 をやり直しても変わらない）。'actual' = 今の版の B-2 がまだ測っていない
 *   （移行の写しが、前の版の検証の行しか無い計画から作った印。B-2 の後でなければ、売上が無いのか、まだ測っていないのか分からない）。
 *   整数の列（actual_dir・hit・n_months）は空を持てない（空は 0 と書かれる）ので、印の hit は使わず、actual_dir は n_months が 3 のときだけ読む。
 *   人と AI の行は、向きが決まった四半期（actual_dir が ±1）だけに作るので、hit はいつも 1（当たり）か 0（外れ）。
 * - 書くのは B-2（当たり具合の計算）の保存の中だけ（同じ控えで足す。新しい自動の処理は作らない）。hit_id は計画・種類・情報源・四半期・
 *   数え方の版から決まるので、何度動かしても足さない。移行のときに 1 回、今ある記録から作る（appHitBackfill_）。
 * - 古さの重み（四半期ごとに 0.8 倍）とメーカーをまたいだ 1 人のまとめは、読むときに計算する。記録は計算に使わない。
 * - 見せる範囲（9 章 8）: 予算策定担当以上（そのメーカーの担当を含む）は全部と名前、本人（人のつなぎ）には自分の行、
 *   ほかの人には種類ごとの件数だけ（appLogVisible_）。順位は作らない（名前の順・件数を必ず添える）。
 * - 本人かどうかと 1 人のまとめは、読むときの有効なつなぎで、その四半期の終わりの日に効くメールで決める（appPersonEmailOf_）。
 *   行の person_email は書いたときの控え（そのときのつなぎ）で、見せる判定とまとめには使わない（外したつなぎ・期間の外のつなぎが効かないように）。
 * - 移行の写しの行の computed_by は仕組み（APP_V10_BACKFILL_ACTOR）。写しを動かした操作の人ではない。
 * - 当たりの基準（2026-10-13 村井さん承認）: 統計だけの予測には補正を入れないので、偏りがあると「いつも上」と言うだけで当たる割合が
 *   50% を超える（例: 統計だけの予測が 10% 低め・月のぶれ 10% なら 84%）。そこで当たりは 50% ではなく、押した向きごとの基準
 *   = 「いつも同じ向きと言った場合に当たる割合」（同じ計画の、比べられた月（四半期）のうち実績がその向きに外れた割合。月が少なければ
 *   全計画の割合に寄せる。appHitBaseRates_）と比べる。記録の hit は押した向きと外れた向きが同じかのまま（基準は読むときに計算する。列は足さない）。
 */
const APP_HIT_CALC = 'HIT-V1';                 // 数え方の版（hit_id に入れる。数え方を変えたら上げて足す）
const APP_HIT_CALC_BACKFILL = 'HIT-V1+BACKFILL';   // 移行で作った行の calc_version（hit_id は APP_HIT_CALC で作るので、後の B-2 と重ならない）
const APP_HIT_DECAY = 0.8;                     // 古さの重み（四半期ごと。読むときに掛ける）
const APP_HIT_PERSON_TYPES = ['factor_product', 'factor_client', 'opinion'];   // 人の入力の押し（ai_topic・vertex_forecast は人ではない）
const APP_HIT_KIND = { PERSON: 'PERSON', AI: 'AI_RESEARCH', QUARTER: 'QUARTER' };
const APP_HIT_BACKFILL_PROP = 'APP_V10_HIT_BACKFILL';   // 移行の写しを済ませた計画（{ 計画の ID: 1 }。1 回の目安を過ぎたら続きから）
const APP_HIT_TABLES = ['EVAL_LOG', 'PROCESS_STATUS', 'AI_IMPACT_HISTORY', 'SUBJECTIVE_IMPACT_HISTORY'];
const APP_HIT_BASE_MONTHS = 3;   // 基準を全計画の割合へ寄せる強さ（月の数。1 四半期ぶん。四半期で数える当たりの記録では 1 四半期）

/** 移行の写し 1 回の目安（ミリ秒。写しは誰かの操作の初めに動くので短く。テストで差し替える） */
function appHitBackfillBudgetMs_() { return 20000; }

// ---- 当たりの基準（いつも同じ向きと言った場合に当たる割合） ----

/**
 * 全計画の「実績が統計だけの予測より上に外れた」割合（counts = { 計画の ID: [上, 下] }。比べられた月（四半期）の数。
 * 外れの無かった月は入れない）。比べられた月が 1 つも無ければ 0.5
 */
function appHitBaseShare_(counts) {
  let up = 0, all = 0;
  Object.keys(counts || {}).forEach(id => { const c = counts[id] || [0, 0]; up += Number(c[0] || 0); all += Number(c[0] || 0) + Number(c[1] || 0); });
  return all > 0 ? up / all : 0.5;
}

/**
 * 計画の向きごとの基準（{ up, down }。いつも上・いつも下と言った場合に当たる割合）。c = その計画の [上, 下] の数、
 * share = 全計画の上の割合（appHitBaseShare_）、k = 寄せる強さ（月か四半期の数）。月が少ないほど全計画の割合に寄る:
 * up = (上 + k × share) / (上 + 下 + k)。数も強さも 0 なら半々
 */
function appHitBaseRates_(c, share, k) {
  const up = Number((c || [])[0] || 0), down = Number((c || [])[1] || 0), w = Math.max(0, Number(k) || 0);
  const s = typeof share === 'number' && isFinite(share) ? Math.min(1, Math.max(0, share)) : 0.5;
  const den = up + down + w;
  const pUp = den > 0 ? (up + w * s) / den : 0.5;
  return { up: pUp, down: 1 - pUp };
}

/** 押した向き（符号）の基準。向きが無ければ null */
function appHitBaseOf_(rates, dir) {
  const d = Math.sign(Number(dir) || 0);
  return !rates || !d ? null : d > 0 ? rates.up : rates.down;
}

/**
 * 当たりの記録（HIT_RECORDS）の四半期の印から、計画ごとの [上, 下]（3 か月そろって向きが決まった四半期の数）。
 * rows = appHitAll_ の行（計画・種類・情報源・四半期ごとに一番新しい行）、want = { 計画の ID: true }（省くと全部）
 */
function appHitQuarterCounts_(rows, want) {
  const out = {};
  (rows || []).forEach(r => {
    if (r.source_kind !== APP_HIT_KIND.QUARTER || Number(r.n_months) !== 3 || (want && !want[r.plan_id])) return;
    const d = Math.sign(Number(r.actual_dir) || 0);
    if (!d) return;
    const c = out[r.plan_id] = out[r.plan_id] || [0, 0];
    c[d > 0 ? 0 : 1]++;
  });
  return out;
}

/** 当たりの記録の行（人・AI 調査）に基準を付ける（base = その四半期に押した向きの基準。計画の四半期の印が無ければ全計画の割合）。読むときだけ */
function appHitWithBase_(rows, counts) {
  const share = appHitBaseShare_(counts);
  const rates = {};
  return rows.map(r => {
    const rr = rates[r.plan_id] = rates[r.plan_id] || appHitBaseRates_(counts[r.plan_id], share, APP_HIT_BASE_MONTHS / 3);
    return Object.assign({}, r, { base: appHitBaseOf_(rr, appNum_(r.push)) });
  });
}

// ---- 四半期 ----

/** 'FY2026-Q1' の 3 か月（['2026/04', '2026/05', '2026/06']）。読めなければ空 */
function appHitQuarterMonths_(q) {
  const m = /^FY(\d{4})-Q([1-4])$/.exec(String(q || ''));
  if (!m) return [];
  const fy = Number(m[1]), first = 4 + (Number(m[2]) - 1) * 3;
  return [0, 1, 2].map(i => { const mo = first + i; return (mo > 12 ? fy + 1 : fy) + '/' + ('0' + (mo > 12 ? mo - 12 : mo)).slice(-2); });
}

/** 四半期の終わりの日（'yyyy-MM-dd'。人のつなぎが効く日） */
function appHitQuarterEnd_(q) {
  const last = appHitQuarterMonths_(q)[2];
  if (!last) return '';
  const y = Number(last.slice(0, 4)), mo = Number(last.slice(5, 7));
  return last.replace('/', '-') + '-' + ('0' + new Date(Date.UTC(y, mo, 0)).getUTCDate()).slice(-2);
}

/** 四半期の通し番号（古さの重みを数える） */
function appHitQuarterIndex_(q) {
  const m = /^FY(\d{4})-Q([1-4])$/.exec(String(q || ''));
  return m ? Number(m[1]) * 4 + Number(m[2]) - 1 : null;
}

// ---- 数える ----

/**
 * 計画の A-4（AI 調査）の回: [{ id: PLAN_ACTIONS の action_id, ms: 終わった時刻 }]（古い順）。
 * 予測の回が使った A-4 は、その回より前に終わった最後の A-4（予測は、そのときの AI 調査の行を読む）
 */
function appHitA4Runs_(planId) {
  return appReadTable_('PLAN_ACTIONS').filter(r => r.plan_id === planId && r.action === 'AI.RESEARCH' && r.status === 'DONE')
    .map(r => ({ id: String(r.action_id), ms: appEvidenceMs_(r.finished_at) })).filter(x => x.ms !== null).sort((a, b) => a.ms - b.ms);
}

/**
 * 計画の当たりの行（キー・時刻・人を入れる前の形）。t = { EVAL_LOG, PROCESS_STATUS, AI_IMPACT_HISTORY, SUBJECTIVE_IMPACT_HISTORY }
 * （見出し → 値の行。計算用ブック（B-2 の後）からでも、データ本体（移行）からでもよい）、a4 = appHitA4Runs_、links = 人のつなぎの行。
 * measured = t が今の版の B-2 を動かした直後の計算用ブック（appHitEvalOps_）。そのときは、締まった月に測った行が無ければ
 * 売上の記録が無い月（miss 'none'。採点するものが無い）。データ本体から作る移行の写しは false（miss 'actual'。まだ測っていないかもしれない）。
 * 計画の年度の四半期のうち、3 か月とも締まった四半期だけ（締まっていない月が入る四半期は数えない）
 */
function appHitRowsOf_(plan, t, a4, links, measured) {
  const cutoff = appLandingCutoff_(t.PROCESS_STATUS || []);
  if (!cutoff) return [];
  const quarters = [1, 2, 3, 4].map(q => 'FY' + Number(plan.fy) + '-Q' + q).filter(q => appHitQuarterMonths_(q)[2] < cutoff);
  if (!quarters.length) return [];
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  // 実績: 締まった月の、今の版の B-2 が測った neutral の行（旧来の C-1 の当たりと同じ行）
  const actual = {};
  (t.EVAL_LOG || []).forEach(r => {
    if (String(r.scenario) !== 'neutral' || String(r.constraint_relevant_flag) !== '1' || !appEvalRowCurrent_(r, cutoff)) return;
    const v = appNum_(r.actual);
    if (v !== null) actual[appYm_(r.target_month)] = v;
  });
  // 月 → その月が始まる前の最後の予測の回（統計だけの予測・AI の倍率と向き）
  const pre = {};
  (t.AI_IMPACT_HISTORY || []).forEach((r, i) => {
    if (String(r.forecast_source || '').trim() !== 'forecast_open') return;
    const ym = appYm_(r.target_month), start = appMonthStartMs_(ym), ms = appEvidenceMs_(r.run_at);
    if (start === null || ms === null || ms >= start) return;   // 月が始まった後の回と、時刻の読めない回は使わない
    const p = pre[ym];
    if (!p || ms > p.ms || (ms === p.ms && i > p.i)) {
      pre[ym] = { ms: ms, i: i, run: String(r.run_id || '').trim(), stat: appNum_(r.pred_p50_quant_only), k: appNum_(r.k_ai), dir: appInsightDir_(r.ai_direction) };
    }
  });
  // 人の押し: 月 → 名前 → その回の押し（製品・メーカー全体・見解を足す。同じ種類の行が 2 つあれば後の行）
  const sameRun = (p, r) => { const run = String(r.run_id || '').trim(); return p.run && run ? run === p.run : appEvidenceMs_(r.run_at) === p.ms; };
  const unit = {};
  (t.SUBJECTIVE_IMPACT_HISTORY || []).forEach(r => {
    if (String(r.forecast_source || '').trim() !== 'forecast_open') return;
    const ym = appYm_(r.target_month), type = String(r.source_type || '').trim(), key = String(r.source_key || '').trim();
    const step = appNum_(r.push_step);
    if (APP_HIT_PERSON_TYPES.indexOf(type) < 0 || !key || step === null || !pre[ym] || !sameRun(pre[ym], r)) return;
    unit[ym + '\u0001' + type + '\u0001' + key] = { ym: ym, key: key, step: step };
  });
  const person = {};
  Object.keys(unit).forEach(u => { const x = unit[u]; const m = person[x.ym] = person[x.ym] || {}; m[x.key] = (m[x.key] || 0) + x.step; });
  const a4Of = ms => (a4 || []).filter(x => x.ms <= ms).slice(-1)[0] || null;
  const round = v => Math.round(v * 1e6) / 1e6;
  const mean = xs => xs.reduce((s, x) => s + x.push, 0) / xs.length;
  const out = [];
  const row = (q, kind, key, email, months, push, dir, hit, n) => ({ plan_id: plan.plan_id, client_id: plan.client_id, quarter: q, source_kind: kind,
    source_key: key, person_email: email, months_json: months, push: push, actual_dir: dir, hit: hit, n_months: n });
  quarters.forEach(q => {
    const months = appHitQuarterMonths_(q);
    const ok = months.filter(ym => has(actual, ym) && pre[ym] && pre[ym].stat !== null);
    let dir = null;
    if (ok.length === 3) {
      const diff = months.reduce((s, ym) => s + actual[ym] - pre[ym].stat, 0);
      dir = Math.abs(diff) < 1e-6 ? 0 : Math.sign(diff);
    }
    out.push(row(q, APP_HIT_KIND.QUARTER, '', '', months.map(ym => (ok.indexOf(ym) >= 0 ? { ym: ym, run: pre[ym].run }
      : { ym: ym, run: pre[ym] ? pre[ym].run : '', miss: !pre[ym] || pre[ym].stat === null ? 'forecast' : measured ? 'none' : 'actual' })), null, dir, null, ok.length));
    if (!dir) return;   // 実績が統計だけの予測とちょうど同じ四半期は、どの向きも当たりと言えないので印だけ
    const hitOf = push => (Math.sign(push) === dir ? 1 : 0);
    // 人: 四半期に押した月の押しの平均（1 人を月の数だけ数えない）
    const names = {};
    months.forEach(ym => Object.keys(person[ym] || {}).forEach(n => {
      if (person[ym][n]) (names[n] = names[n] || []).push({ ym: ym, run: pre[ym].run, push: round(person[ym][n]) });
    }));
    Object.keys(names).sort().forEach(n => {
      const push = round(mean(names[n]));
      if (!Math.sign(push)) return;   // 上げと下げが打ち消し合った人は、向きが無いので数えない
      out.push(row(q, APP_HIT_KIND.PERSON, n, appPersonEmailOf_(n, plan.client_id, appHitQuarterEnd_(q), links || []), names[n], push, dir, hitOf(push), names[n].length));
    });
    // AI 調査 1 回: 月の予測の回が使った A-4 ごと。押し = AI の倍率 − 1（上げ・下げの月だけ。旧来の向き ±1% と同じ）
    const runs = {};
    months.forEach(ym => {
      const p = pre[ym];
      if (p.k === null || (p.dir !== 'up' && p.dir !== 'down')) return;
      const a = a4Of(p.ms);
      if (a) (runs[a.id] = runs[a.id] || []).push({ ym: ym, run: p.run, push: round(p.k - 1) });
    });
    Object.keys(runs).sort().forEach(id => {
      const push = round(mean(runs[id]));
      if (!Math.sign(push)) return;
      out.push(row(q, APP_HIT_KIND.AI, id, '', runs[id], push, dir, hitOf(push), runs[id].length));
    });
  });
  return out;
}

/**
 * 当たりの行のキー（計画・種類・情報源・四半期・数え方の版。同じ中身なら同じ印）。
 * 四半期の印は、そろわなかった（n_months が 3 でない）ときは月の数も入れる: 後でそろって数えたときは新しい印を足す
 * （読むときは計画・種類・情報源・四半期ごとに一番新しい行を使う。例: 前の版の検証の行しか無いときに移行の写しが作った印）。
 * 売上の記録が無い月（miss 'none'。今の版の B-2 の後）があれば、その月も入れる: 同じ月の数でも、移行の写しの印（その月が 'actual'）と
 * 重ならずに足す（重なると、まだ測っていない印のまま年度を締められない）。'none' の無い印の番号は前と同じ
 */
function appHitId_(r) {
  const parts = [r.plan_id, r.source_kind, r.source_key, r.quarter, APP_HIT_CALC];
  if (r.source_kind === APP_HIT_KIND.QUARTER && Number(r.n_months) !== 3) {
    parts.push('PARTIAL:' + Number(r.n_months));
    const none = (appHitMonthsOf_(r) || []).filter(m => m && m.miss === 'none').map(m => String(m.ym));
    if (none.length) parts.push('NONE:' + none.join(','));
  }
  return appStableLogId_(APP_LOG_PREFIX.HIT_RECORDS, parts);
}

/** 印の months_json（文字でも配列でもよい）。読めなければ null */
function appHitMonthsOf_(r) {
  let months = r ? r.months_json : null;
  if (typeof months === 'string') { try { months = JSON.parse(months || '[]'); } catch (e) { return null; } }
  return Array.isArray(months) ? months : null;
}

/** 当たりの行を、まだ無いものだけ控えの書き方にする（appLogOps_）。calc = calc_version、by = computed_by（省くと操作の人）。キーと時刻はここで決める */
function appHitOps_(ctx, plan, rows, calc, by) {
  if (!rows.length) return [];
  const have = {};
  appReadPlanTable_('HIT_RECORDS', plan.plan_id).forEach(r => { have[r.hit_id] = true; });
  const now = appNowIso_();
  const fresh = rows.map(r => Object.assign({ hit_id: appHitId_(r) }, r)).filter(r => !have[r.hit_id]).map(r => Object.assign(r, {
    policy_version: APP_EVAL_POLICY_VERSION, calc_version: calc, computed_at: now, computed_by: by || ctx.actor }));
  return appLogOps_('HIT_RECORDS', fresh);
}

/**
 * B-2（当たり具合の計算。EVAL.REPORT）の保存で足す当たりの行（Plan.js の appPlanRunSave_ から。同じ控えで書く）。
 * book = B-2 を動かした後の計算用ブック（検証の表と締まった月は B-2 の後のもの）。数えられなくても B-2 の保存は止めない（エラーのログに残す）
 */
function appHitEvalOps_(ctx, plan, book) {
  if (!appLogReady_('HIT_RECORDS')) return [];
  try {
    const t = {};
    APP_HIT_TABLES.forEach(n => { t[n] = appPlanSheetRows_(book.getSheetByName(n)); });
    return appHitOps_(ctx, plan, appHitRowsOf_(plan, t, appHitA4Runs_(plan.plan_id), appPersonLinks_(), true), APP_HIT_CALC);   // 今の版の B-2 の後（測った行の無い月は売上の記録が無い）
  } catch (e) {
    appLogError_('HIT.RECORD', e, ctx);
    return [];
  }
}

/**
 * 移行の写し（V10.js の appV10BackfillHitRecords_）: 版 10 の時点で締まっている四半期の分を、データ本体の予測の記録から 1 回作る。
 * 締まった月のある計画だけ（PROCESS_STATUS を全計画の分 1 回で読む）。締めた年度の計画は書けないので飛ばす。
 * 計画ごとにロックの中で 1 つの控えで書く。1 回の目安（20 秒）を過ぎたら、済ませた計画をプロパティに残して続きを次の操作に回す
 */
function appHitBackfill_(ctx) {
  const t0 = new Date().getTime();
  const props = appProps_();
  let done = {};
  try { done = JSON.parse(props.getProperty(APP_HIT_BACKFILL_PROP) || '{}') || {}; } catch (e) { done = {}; }
  const plans = appReadTable_('PLANS').filter(p => !done[p.plan_id]).sort((a, b) => String(a.plan_id).localeCompare(String(b.plan_id)));
  const status = plans.length ? appEngAll_('PROCESS_STATUS', plans.map(p => p.plan_id)) : {};
  const a4 = {};
  appReadTable_('PLAN_ACTIONS').forEach(r => {
    if (r.action !== 'AI.RESEARCH' || r.status !== 'DONE') return;
    const ms = appEvidenceMs_(r.finished_at);
    if (ms !== null) (a4[r.plan_id] = a4[r.plan_id] || []).push({ id: String(r.action_id), ms: ms });
  });
  Object.keys(a4).forEach(id => a4[id].sort((a, b) => a.ms - b.ms));
  const links = appPersonLinks_();
  let rows = 0, count = 0;
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    if (count && new Date().getTime() - t0 > appHitBackfillBudgetMs_()) {
      props.setProperty(APP_HIT_BACKFILL_PROP, JSON.stringify(done));
      return { more: true, rows: rows };
    }
    if (!appYearIsFrozen_(p.fy) && appLandingCutoff_(status[p.plan_id] || [])) {
      rows += appWithLock_(() => {
        appJournalRecover_(ctx);
        const plan = appPlanOf_(p.plan_id);
        if (appYearIsFrozen_(plan.fy)) return 0;
        // データ本体の検証の行は前の版の B-2 のものかもしれないので、測った行の無い月は「まだ測っていない」（miss 'actual'）のまま
        const ops = appHitOps_(ctx, plan, appHitRowsOf_(plan, appEngTableObjects_(plan.plan_id, APP_HIT_TABLES), a4[plan.plan_id] || [], links, false), APP_HIT_CALC_BACKFILL,
          APP_V10_BACKFILL_ACTOR);
        if (!ops.length) return 0;
        appJournalRun_(ctx, '当たりの記録の移行（' + plan.plan_id + '）', plan.plan_id, ops);
        return ops[0].rows.length;
      });
      count++;
    }
    done[p.plan_id] = 1;
  }
  try { props.deleteProperty(APP_HIT_BACKFILL_PROP); } catch (e) { /* 済んだ印は APP_BACKFILLS に残る */ }
  return { rows: rows, plans: count };
}

/**
 * 四半期の印（QUARTER）が「数え終えた」印か。3 か月とも、採点した（実績と、その月が始まる前の予測の回がそろった）か、
 * 採点するものが無かった（その月が始まる前の予測の回が無い: miss = 'forecast'。今の版の B-2 の後に売上の記録が無い: miss = 'none'）なら数え終えた。
 * まだ測っていない月（miss = 'actual'。移行の写しが、前の版の検証の行しか無い計画から作った印。例: n_months = 0）が 1 つでもあれば、
 * まだ数え終えていない（今の版の B-2 を動かすと、測れる月は採点し、売上の無い月は 'none' の印を足す）。months_json が読めない印も数え終えていないとみなす。
 * b2Pending = その計画の B-1（実績の取り込み）が最後の B-2 より新しい: 売上の無かった月（'none'）に後から売上が入ったかもしれないので、数え終えていない
 */
function appHitQuarterCounted_(r, b2Pending) {
  if (Number(r && r.n_months) === 3) return true;
  const months = appHitMonthsOf_(r);
  if (!months || months.length !== 3 || !months.every(m => m && typeof m === 'object' && m.miss !== 'actual')) return false;
  return !(b2Pending && months.some(m => m.miss === 'none'));
}

/**
 * 年度を締める前の見張り（V10.js の appYearHitsPending_）: 年度の最後の四半期（1〜3 月）の当たりを数え終えたか（締めた後は書けないため。9 章 10）。
 * 予算を立てる計画（測る専用は外す）のうち、締まった月がある計画（実績を取り込んだ: B-2 の後でも前でも）に、その四半期の数え終えた印
 * （appHitQuarterCounted_。同じ四半期の印がいくつあっても、どれか 1 つ）が要る。B-1 の後に B-2 がまだの計画では、売上の無い月（'none'）の印は数えない。
 * 足りなければ理由の文、そろっていれば ''。記録の表がそろう前は、数えたか確かめられないので締めない
 */
function appHitYearPending_(fy, plans) {
  const need = (plans || []).filter(p => !appPlanIsMeasure_(p));
  if (!need.length) return '';
  if (!appLogReady_()) return '表の版 10 の移行が済むまで、年度を締められません（当たりの記録を確かめられないため）。';
  const q = 'FY' + Number(fy) + '-Q4';
  const names = appClientNameMap_();
  const status = appEngAll_('PROCESS_STATUS', need.map(p => p.plan_id));
  const missing = need.filter(p => {
    const st = status[p.plan_id] || [];
    const pending = !!appLandingPendingCutoff_(st);   // B-1 の後に B-2 がまだ
    if (!appLandingCutoff_(st) && !pending) return false;   // 実績を取り込んでいない計画は数えるものが無い
    return !appReadPlanTable_('HIT_RECORDS', p.plan_id).some(r => r.quarter === q && r.source_kind === APP_HIT_KIND.QUARTER && appHitQuarterCounted_(r, pending));
  }).map(p => names[p.client_id] || p.client_label);
  if (!missing.length) return '';
  return 'FY' + Number(fy) + ' の 1〜3 月の当たりをまだ数えていない計画があります（' + missing.slice(0, 5).join('・') + (missing.length > 5 ? ' ほか ' + (missing.length - 5) + ' 計画' : '') +
    '）。3 月の実績が締まってから（4 月 5 日以降に）実績を取り込み、当たり具合を計算してから締めてください。';
}

// ---- 読む（学びの画面） ----

/**
 * 全部の当たりの記録（データ本体が変わるまで控える）。同じ計画・種類・情報源・四半期の行が 2 つ以上あれば（数え方の版を上げて足した）、
 * 数えた時刻の一番新しい行だけ。a4 = A-4 の番号 → 終わった日（AI 調査 1 回の名前に使う。番号は画面に出さない）
 */
function appHitAll_() {
  return appCachedRead_('HITS\u0001' + APP_VERSION, () => {
    let rows = [];
    try { rows = appReadTable_('HIT_RECORDS'); } catch (e) { return { rows: [], a4: {} }; }
    const by = {};
    rows.forEach(r => {
      const k = [r.plan_id, r.source_kind, r.source_key, r.quarter].join('\u0001');
      if (!by[k] || String(r.computed_at) >= String(by[k].computed_at)) by[k] = r;
    });
    const a4 = {};
    appReadTable_('PLAN_ACTIONS').forEach(r => { if (r.action === 'AI.RESEARCH') a4[r.action_id] = String(r.finished_at || '').slice(0, 10); });
    return { rows: Object.keys(by).map(k => appStripRow_(by[k])), a4: a4 };
  });
}

/** 古さの重み（一番新しい締まった四半期 = 今の四半期の 1 つ前が 1。そこから四半期ごとに 0.8 倍） */
function appHitWeight_(q, curIndex) {
  const i = appHitQuarterIndex_(q);
  return i === null ? 0 : Math.pow(APP_HIT_DECAY, Math.max(0, curIndex - 1 - i));
}

/**
 * 行を見る人ごとに分ける（メーカーごとに appLogViewer_。返り値 { rows（見せる行。full = その行を全部見られる人か）, counts（見せない行の種類ごとの件数） }）。
 * 本人の行 = 人の行で、その四半期の終わりの日に効く有効なつなぎで、名前が見る人のメールにつながる行（行の person_email は使わない）
 */
function appHitVisible_(ctx, rows) {
  const byClient = {};
  rows.forEach(r => { (byClient[r.client_id] = byClient[r.client_id] || []).push(r); });
  const shown = [], counts = {};
  Object.keys(byClient).sort().forEach(c => {
    const v = appLogViewer_(ctx, c);
    const vis = appLogVisible_(v, byClient[c], { personOf: r => (r.source_kind === APP_HIT_KIND.PERSON ? r.source_key : ''),
      dateOf: r => appHitQuarterEnd_(r.quarter), typeOf: r => r.source_kind });
    vis.rows.forEach(r => shown.push(Object.assign({ full: v.full }, r)));
    Object.keys(vis.counts).forEach(k => { counts[k] = (counts[k] || 0) + vis.counts[k]; });
  });
  return { rows: shown, counts: counts };
}

/**
 * 人の学びの「人ごとの当たり」（Api.js の apiPeopleLearning が、見る人によらない控えの外で足す）。返り値:
 *   people: [{ name, own（本人の行だけで見せている）, n（数えた四半期）, hit, rate（古さの重みを掛けた当たる割合。数えた四半期が無ければ null）,
 *             expected（基準で当たるはずの数 = 押した四半期の基準の合計）, base（rate と同じ重みを掛けた基準の割合。無ければ null）,
 *             makers（メーカーの数）, quarters: [{ quarter, clientName, fy, push, hit, base }] }]（名前の順。順位は作らない）
 *   基準 = いつも同じ向きと言った場合に当たる割合（同じ計画の、3 か月そろった四半期のうち実績がその向きに外れた割合。四半期が少なければ
 *   全計画の割合に寄せる。appHitWithBase_）
 *   hidden: 見せない人の行の数、quarters: 数えた四半期の数（計画 × 四半期。見る人によらない）
 * メーカーをまたいだ 1 人は、読むときの有効なつなぎで、その四半期の終わりの日に効くメールでまとめる（行の person_email は書いたときの控えなので使わない。
 * つながらない行は名前でまとめる）。メールは画面に送らない
 */
function appHitPeopleView_(ctx) {
  try { return appCachedRead_('HITPEOPLE\u0001' + appHitViewerKey_(ctx), () => appHitPeopleData_(ctx)); }
  catch (e) { Logger.log('人ごとの当たり: ' + (e && e.message ? e.message : e)); return null; }   // 読めなくても学びの画面は出す
}

/** 見る人ごとの控えの鍵（見せる行は、人・役割・つなぎ（行ごとに四半期の終わりの日に効くもの）で決まる。つなぎを変えるとデータ本体が変わるので appCachedRead_ が読み直す） */
function appHitViewerKey_(ctx) {
  return [String((ctx && ctx.user && ctx.user.email) || ''), String((ctx && ctx.actor) || ''), appRoleSummary_(ctx && ctx.roles), appToday_()].join('\u0001');
}

function appHitPeopleData_(ctx) {
  const all = appHitAll_();
  const plans = {};
  appInsightPlans_().forEach(p => { plans[p.planId] = p; });
  const counts = appHitQuarterCounts_(all.rows, plans);
  const rows = appHitWithBase_(all.rows.filter(r => plans[r.plan_id] && r.source_kind === APP_HIT_KIND.PERSON), counts);
  const vis = appHitVisible_(ctx, rows);
  const links = appPersonLinks_();
  const cur = appHitQuarterIndex_(appInsightQuarter_(Utilities.formatDate(new Date(), APP_TZ, 'yyyy/MM')));
  const groups = {};
  vis.rows.forEach(r => {
    const email = appPersonEmailOf_(r.source_key, r.client_id, appHitQuarterEnd_(r.quarter), links);
    const k = email ? 'e:' + email : 'n:' + r.source_key;
    const g = groups[k] = groups[k] || { names: {}, own: true, rows: [] };
    g.names[r.source_key] = true;
    if (r.full) g.own = false;
    g.rows.push(r);
  });
  const people = Object.keys(groups).map(k => {
    const g = groups[k];
    const scored = g.rows.filter(r => r.hit === 0 || r.hit === 1);
    const w = scored.map(r => appHitWeight_(r.quarter, cur));
    const sw = w.reduce((a, b) => a + b, 0);
    const withBase = scored.every(r => typeof r.base === 'number');
    const makers = {};
    g.rows.forEach(r => { makers[r.client_id] = true; });
    return { name: Object.keys(g.names).sort().join('・'), own: g.own, n: scored.length, hit: scored.filter(r => r.hit === 1).length,
      rate: sw > 0 ? scored.reduce((s, r, i) => s + w[i] * r.hit, 0) / sw : null,
      expected: withBase ? scored.reduce((s, r) => s + r.base, 0) : null,
      base: withBase && sw > 0 ? scored.reduce((s, r, i) => s + w[i] * r.base, 0) / sw : null, makers: Object.keys(makers).length,
      quarters: g.rows.slice().sort((a, b) => String(b.quarter).localeCompare(String(a.quarter)) || String(plans[a.plan_id].clientName).localeCompare(String(plans[b.plan_id].clientName), 'ja'))
        .map(r => ({ quarter: r.quarter, clientName: plans[r.plan_id].clientName, fy: plans[r.plan_id].fy, push: appNum_(r.push), hit: r.hit === 0 || r.hit === 1 ? r.hit : null,
          base: typeof r.base === 'number' ? r.base : null })) };
  }).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const quarters = all.rows.filter(r => plans[r.plan_id] && r.source_kind === APP_HIT_KIND.QUARTER && Number(r.n_months) === 3).length;
  return { people: people, hidden: vis.counts[APP_HIT_KIND.PERSON] || 0, quarters: quarters };
}

/**
 * AI の学びの「調査ごとの当たり」（Api.js の apiAiLearning が足す）。AI 調査 1 回（A-4）ごとの、数えた四半期の当たり。返り値:
 *   research: [{ planId, clientName, fy, date（A-4 の日 'yyyy-MM-dd'）, n, hit, expected（基準で当たるはずの数。人ごとの当たりと同じ）,
 *               quarters: [{ quarter, push, hit, base }] }]（新しい順）
 *   hidden: 見せない行の数（予算策定担当以上でない人には、件数だけ。当たりの記録の見せ方と同じ）
 */
function appHitResearchView_(ctx) {
  try { return appCachedRead_('HITAI\u0001' + appHitViewerKey_(ctx), () => appHitResearchData_(ctx)); } catch (e) { Logger.log('調査ごとの当たり: ' + (e && e.message ? e.message : e)); return null; }
}

function appHitResearchData_(ctx) {
  const all = appHitAll_();
  const plans = {};
  appInsightPlans_().forEach(p => { plans[p.planId] = p; });
  const counts = appHitQuarterCounts_(all.rows, plans);
  const vis = appHitVisible_(ctx, appHitWithBase_(all.rows.filter(r => plans[r.plan_id] && r.source_kind === APP_HIT_KIND.AI), counts));
  const by = {};
  vis.rows.forEach(r => { (by[r.plan_id + '\u0001' + r.source_key] = by[r.plan_id + '\u0001' + r.source_key] || []).push(r); });
  const research = Object.keys(by).map(k => {
    const xs = by[k], p = plans[xs[0].plan_id];
    const scored = xs.filter(r => r.hit === 0 || r.hit === 1);
    return { planId: p.planId, clientName: p.clientName, fy: p.fy, date: all.a4[xs[0].source_key] || '', n: scored.length, hit: scored.filter(r => r.hit === 1).length,
      expected: scored.every(r => typeof r.base === 'number') ? scored.reduce((s, r) => s + r.base, 0) : null,
      quarters: xs.slice().sort((a, b) => String(a.quarter).localeCompare(String(b.quarter))).map(r => ({ quarter: r.quarter, push: appNum_(r.push),
        hit: r.hit === 0 || r.hit === 1 ? r.hit : null, base: typeof r.base === 'number' ? r.base : null })) };
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.clientName).localeCompare(String(b.clientName), 'ja'));
  return { research: research, hidden: vis.counts[APP_HIT_KIND.AI] || 0 };
}
