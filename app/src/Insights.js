/**
 * Insights.js — 責任者の 3 つの画面（分析・人の学び・AI の学び）の材料。読むだけ（書かない。旧来の計算・保存・権限は変えない）。
 *
 *   分析（appCrossMaker_）     … 年度のメーカーを横に並べる: 予測と予算・着地の見込み（一覧にあれば）・予測の改訂の道すじ・精度・AI の話題。
 *                                 話題ごとの市場のまとめ（上向き・下向きのメーカーの数と点数の平均）。全体の読み解き（appCrossInsights_: 予算に届く確率・
 *                                 予算との差の内訳・不確かさの寄与・見直しの向きの偏り・読みのクセのそろい方・市場のそろい方。予算を立てる計画だけ）
 *   人の学び（appPeopleLearning_）… 外れた月の振り返り（同じ月の重複を除き、向きは予測と実績から決め直す）・人と話題ごとの当たり
 *                                 （ベータ分布の事後）・四半期レビューの判断の記録・予算の上乗せの実績
 *   AI の学び（appAiLearning_）   … 情報源の種類ごとの信頼度の学び（ベータ分布の四半期ごとの事後）・全計画で縮めた偏り・
 *                                 精度の推移（P10〜P90 に入った割合とその区間）・補正の変化・承認待ちの提案・学びの気になる点
 *
 * 計算用の表（ENG_*）は全計画の分を 1 回ずつ読む（appEngAll_）。計画ごとに組み立て直さない（計画が増えても読む回数は同じ）。
 * 計画ごとの当たりと精度は、入力のハッシュが同じあいだ控える（EVD_・ACC_）。どこかで保存しても、控えが外れるのはその計画の分だけで、
 * 控えの無い計画が少なければ、その計画の行だけを読む（履歴の表を全計画の分は読み直さない）。
 * 人ごとの当たりと判断した人の名前は、予算策定担当以上の人だけに出す（ほかの人には情報源の種類ごとのまとめ。appInsightDetail_）。
 * メーカーに限った予算策定担当には、そのメーカーの計画の分だけ人ごとに出し、ほかの計画の分は閲覧の人と同じにする（2026-10-13。appInsightNamedPlans_）。
 * AI の学びの承認待ちの提案と補正の変化も同じ（ほかの人には、信頼度の対象は種類まで。信頼度の提案の根拠（その人の的中率）は出さない）。
 * 旧来の記録の 2 つの問題を避けて、ここで数え直す（ここでは旧来の計算と記録は変えない）。旧来の側は 2026-10-07 に直したが、
 * 直す前に書かれた記録はそのまま残るので、元の表から数え直すのを続ける:
 *   - SUBJECTIVE_IMPACT_HISTORY の月は日付に変わっていることがあり、直す前の旧来の当たりの数え方（RELIABILITY_EVIDENCE）は
 *     月が合わず空だった（直す前の四半期の分は空のまま）→ 月を appYm_ でそろえ、評価できた月をすべて数える
 *   - 直す前に書かれた EVAL_INSIGHTS の cause_bucket は向きが逆（実績 > 予測を over_forecast と書いた。2026-10-07 からは B-4 が
 *     毎回書き直すが、B-4 を動かし直すまでは逆のまま）→ 使わず、予測 − 実績の符号で決める
 * 振り返り・当たり・精度・縮めた偏り・精度の推移は、締まった月（月末から 5 日たってから取り込んだ月。appLandingCutoff_）だけで数える
 * （2026-10-07 村井さん承認 D4・D5。締まっていない月の EVAL_LOG・EVAL_INSIGHTS の行は消さずに読み飛ばす）。
 * 当たりは、その月が始まる前の最後の予測の回で測る（D6。appSourceEvidence_）。当たる割合は 50% ではなく、基準 = いつも同じ向きと言った場合に
 * 当たる割合（同じ計画の比べられた月で、実績がその向きに外れた割合。月が少なければ全計画の割合に寄せる。appInsightEvidence_）と比べる
 * （2026-10-13 村井さん承認。統計だけの予測には補正が入らないので、偏りがあると、いつも同じ向きと言うだけで 50% を超えて当たる）。
 * 精度・当たりの実績・振り返りは、今の検証の版で B-2 が測った月だけ（appEvalRowCurrent_。旧来の B-3〜C-1 と同じ）。
 * 前の版の EVAL_LOG の行と、その月の EVAL_INSIGHTS の行は、締まった月でも消さずに読み飛ばす（月が始まった後の予測で測ったもの）。
 * 今の版で測った月でも、EVAL_INSIGHTS の行の予測と実績が、その月の今の版の EVAL_LOG の行を B-4 が写す形（実績が負なら 0 円）と違う行と、
 * その計画で今の版の B-2 が初めて動く前に書いた行は、次の B-4 が書き直すまで読み飛ばす（消さない。appInsightRowScored_。
 * B-2 のたびの時刻では決めない: 旧来の B-2 は測るたびに evaluated_at を書き直すので、初めの B-2 の時刻を RUN_LOG から取る）。
 * ただし人の記入（原因・対応・次回への反映・担当・状態）は、その月に使える行が 1 つでもあれば、その月の人が書いた一番新しい行から取る
 * （数字・書いた時刻によらない。2026-10-08 村井さん承認。v0.27.2 より前の B-4 で同じ月の行が 2 つ以上でき、人の記入が最後の行に無いと、
 * B-4 は最後の行だけを書き直すので、記入がずっと隠れていた）。数字・印は使える行から取る。
 */
const APP_INSIGHT_REVISIONS = 12;          // 予測の改訂の道すじ（最近の回数）
const APP_INSIGHT_MISS = 0.1;              // 外れた月: 誤差が 10% 以上か P10〜P90 の外（旧来の B-4 の振り分けと同じ）
const APP_INSIGHT_SAME_YEN = 0.5;          // 振り返りの行の予測・実績が、今の B-2 が測った数字と同じとみなす差（円。これより小さい差）
const APP_INSIGHT_LESSONS = 50;            // 振り返りの最大件数（誤差の大きい順）
const APP_INSIGHT_OPEN_MAX = 100;          // 残っている対応の最大件数
const APP_INSIGHT_DECISIONS = 200;         // 判断の記録の最大件数（新しい順）
const APP_INSIGHT_PRIOR_K = 4;             // 事前分布が無いときの強さ（旧来の RELIABILITY_SHRINKAGE_K と同じ。μ = 0.5 で Beta(2, 2)）
const APP_INSIGHT_Z80 = 1.2815515655446004;   // 標準正規の 90% 点（両側 80% の区間）
const APP_INSIGHT_COVERAGE_TARGET = 0.8;   // P10〜P90 に実績が入る割合の目標
const APP_INSIGHT_COVERAGE_MIN_N = 4;      // 入った割合を気にするのは、これだけの月があるとき
const APP_INSIGHT_FACTOR_MIN = 0.75;       // 旧来の B-5 の偏りの補正の下限
const APP_INSIGHT_FACTOR_MAX = 1.25;       // 同じく上限
const APP_INSIGHT_STATUS = { open: '未着手', in_progress: '対応中', done: '済み', monitoring: '見守り' };
const APP_INSIGHT_ACTION_LABELS = { update: '前提を更新', keep: '継続', add: '追加', remove: '削除' };
const APP_INSIGHT_MACHINE_ACTIONS = ['update', 'keep'];   // 旧来の B-4 が自動で入れる action_type
const APP_INSIGHT_MACHINE_REFLECTIONS = ['次回サイクルで前提更新を反映', '現行運用を継続'];   // 旧来の B-4 が自動で入れる next_cycle_reflection
const APP_INSIGHT_FEW_PLANS = 3;           // 控えの無い計画がこれだけまでなら、その計画の行だけを読む（多ければ表をまとめて 1 回で読む）
const APP_INSIGHT_DETAIL_ROLE = 'PLANNER'; // 人ごとの当たり・判断した人の名前を見せる役割（これ以上。クライアント単位の役割でもよい）
const APP_INSIGHT_DIRECTION = { over: '予測が高すぎた', under: '予測が低すぎた', exact: '予測どおり' };
const APP_INSIGHT_FIELD_LABELS = { ai_weight_override: 'AI の重み', ai_max_abs_effect_override: 'AI の効きの上限', ai_topic_disable_json: '使わない AI の話題',
  bias_correction_factor: '偏りの補正', residual_month_bias_json: '月ごとの偏りの補正', qual_scale_override: '入力の効きの倍率', auto_update_enabled: '自動の学び' };
const APP_INSIGHT_PHASES = { A: 'AI の重み', B: '情報源の信頼度' };
const APP_INSIGHT_HEALTH = {
  shadow_worse: '全計画で縮めた補正を試すと、今より誤差が大きくなる',
  factor_clamp: '偏りの補正が下限か上限（0.75 / 1.25）に張りついている',
  coverage_low: 'P10〜P90 に実績が入る割合が 80% より低い（幅が狭すぎる）',
  coverage_high: 'P10〜P90 に実績が入る割合が 80% より高い（幅が広すぎる）'
};

// ---- 共通: 計算用の表をまとめて読む ----

/**
 * 計算用の表 ENG_<sheet> を 1 回だけ読み、計画ごとの行にする（{ 計画の ID: [見出し → 値] }）。値は型の並び（_types）で元の型に戻す
 * （appEngTableObjects_ と同じ値・同じ並び。数式のセルは空、すべて空の行は除く）。only（計画の ID の一覧）を渡すと、その計画だけ。
 * 見出しが旧来の定義と違い、行ごとに持っている計画（ENG_SHEETS の mode = rows）は、その計画だけ appEngTableObjects_ で読む。
 * perPlan = true なら、only の計画の行だけを読む（appReadPlanTable_。大きい表は計画の行だけを探して読む。控えの無い計画が少ないとき用）
 */
function appEngAll_(sheet, only, perPlan) {
  const reg = APP_ENGINE_SHEETS[sheet];
  if (!reg || reg.mode !== 'table') throw new Error('表の形のシートではありません: ' + sheet);
  if (only && !only.length) return {};
  const want = only ? appInsightSet_(only) : null;
  const each = perPlan && only;
  const mode = {};
  (each ? [].concat.apply([], only.map(id => appReadPlanTable_('ENG_SHEETS', id))) : appReadTable_('ENG_SHEETS'))
    .forEach(r => { if (r.sheet === sheet && (!want || want[r.plan_id])) mode[r.plan_id] = r.mode; });
  const header = reg.header;
  const by = {};
  (each ? [].concat.apply([], Object.keys(mode).filter(id => mode[id] === 'table').map(id => appReadPlanTable_('ENG_' + sheet, id)))
    : appReadTable_('ENG_' + sheet)).forEach(o => {
    if (mode[o.plan_id] !== 'table') return;
    const types = String(o._types || '');
    const x = {};
    let any = false;
    header.forEach((h, j) => {
      const t = types.charAt(j) || (o[h] === '' ? 'e' : 's');
      const v = t === 'f' ? '' : appCellDecode_(t, o[h]);
      x[h] = v;
      if (v !== '' && v !== null) any = true;
    });
    if (any) (by[o.plan_id] = by[o.plan_id] || []).push({ seq: Number(o.seq), row: x });
  });
  const out = {};
  Object.keys(mode).forEach(id => {
    out[id] = mode[id] === 'table' ? (by[id] || []).sort((a, b) => a.seq - b.seq).map(x => x.row) : appEngTableObjects_(id, [sheet])[sheet];
  });
  return out;
}

/**
 * 1 回の呼び出しの中で、同じ表を 2 度読まない。tab(表の名前) = 全計画の分（appEngAll_ の結果）。
 * tab(表の名前, few) = few の計画の分だけ（その計画の行だけを読む。全計画の分をもう読んでいれば、そこから）。few が null なら全計画の分
 */
function appInsightTables_(ids) {
  const all = {};
  const part = {};
  return (sheet, few) => {
    if (all[sheet]) return all[sheet];
    if (!few) return (all[sheet] = appEngAll_(sheet, ids));
    const got = part[sheet] = part[sheet] || {};
    const need = few.filter(id => !Object.prototype.hasOwnProperty.call(got, id));
    if (need.length) { const r = appEngAll_(sheet, need, true); need.forEach(id => { got[id] = r[id] || []; }); }
    const out = {};
    few.forEach(id => { out[id] = got[id]; });
    return out;
  };
}

/** 控えの無い計画（missing）が少なければ、その一覧（その計画の行だけ読む）。全部・多いときは null（表をまとめて 1 回で読む） */
function appInsightFew_(missing, ids) {
  return missing.length && missing.length < ids.length && missing.length <= APP_INSIGHT_FEW_PLANS ? missing : null;
}

/** 全計画の入力のハッシュを、ENG_SHEETS を 1 回で読んで出せるようにする（読めなければ計画ごとに読む） */
function appInsightPreloadHashes_(ids) {
  if (ids.length > 1) { try { appReadTable_('ENG_SHEETS'); } catch (e) { /* 読めなければ計画ごとに読む（その計画は控えない） */ } }
}

/** 計画ごとの控えをまとめて読む（{ 鍵: { found, value } }）。控えが読めなければ、どれも無いものとして計算し直す */
function appInsightCacheGet_(keys) {
  try { return appJobGetResults_(keys); } catch (e) { Logger.log('控えを読めません: ' + (e && e.message ? e.message : e)); return {}; }
}

function appInsightSet_(xs) {
  const o = {};
  xs.forEach(x => { o[x] = true; });
  return o;
}

/** 閉じていない計画（{ planId, clientName, fy }。年度の新しい順・名前順） */
function appInsightPlans_() {
  const names = appClientNameMap_();
  return appReadTable_('PLANS').filter(p => p.state !== 'ARCHIVED')
    .map(p => ({ planId: p.plan_id, clientName: names[p.client_id] || p.client_label, fy: String(p.fy) }))
    .sort((x, y) => y.fy.localeCompare(x.fy) || String(x.clientName).localeCompare(String(y.clientName), 'ja'));
}

/**
 * 計画ごとの締まった月の境目（{ 計画の ID: 'yyyy/MM' か '' }。status = 計画ごとの PROCESS_STATUS の行。appLandingCutoff_）。
 * 計画の一覧と同じく、B-1 の後に B-2 がまだの計画は、消さずに足す記録（appPortfolioStepHist_）から最後に成功した B-2 の前の B-1 の境目で数える
 * （2026-10-13。記録はその計画の分だけ 1 回で読む）
 */
function appInsightCutoffs_(ids, status) {
  const pending = ids.filter(id => appLandingPendingCutoff_(status[id] || []) !== '');
  const hist = pending.length ? appPortfolioStepHist_(pending) : {};
  const out = {};
  ids.forEach(id => { out[id] = appLandingCutoff_(status[id] || [], hist[id] || []); });
  return out;
}

/**
 * 旧来の B-4 が EVAL_INSIGHTS に写す、今の版の neutral の EVAL_LOG の行の数字（{ pred, actual }。数でなければ null）。
 * 予測（pred_p50）はそのまま。実績（actual_total）は 0 円より下なら 0 円（B-4 は月の実績を 0 から Math.max で取るので、返品・値引きで
 * 実績が負の月も 0 円と書く）。振り返りの行と比べる数字（appInsightRowScored_）は、学びと計画の画面の両方でこの形にそろえる
 */
function appInsightB4View_(pred, actual) {
  const a = appNum_(actual);
  return { pred: appNum_(pred), actual: a === null ? null : Math.max(0, a) };
}

/**
 * 外れた月の振り返り（EVAL_INSIGHTS）の行が、今の B-2 が測った数字で B-4 が書いたものか（学びの振り返り appInsightLessons_ と、計画の画面の
 * appPlanViewDropStale_ の決まり）。scored = { 月: { pred, actual } }（その月の今の版の neutral の EVAL_LOG の行を、B-4 が写す形にした数字。
 * appInsightB4View_）。at = 行の evaluated_at、since = その計画で今の版の B-2 が初めて動いた時刻（ミリ秒。appEvalPolicySince_。無ければ null）。
 * 次の 2 つがそろうときだけ真:
 *   - その月が scored にあり、行の予測（pred_p50）と実績（actual_total）が、その pred・actual と同じ（差が APP_INSIGHT_SAME_YEN より小さい。
 *     数は appNum_ で読み、どちらかの側が空なら違う）。旧来の B-4 は月ごとの行をその場で書き直し（人の欄は残す）、今の B-2 の数字を写すので、
 *     数字が違う行は別の測り方で書かれたもの（前の版の、月が始まった後の予測で測った数字や、実績を取り込み直して測り直す前の数字）
 *   - 行を書いた時刻が since 以後（since が無い・時刻が読めない行は違う）。前の版の B-4 が書いた行は、数字がたまたま今の B-2 と同じでも、
 *     機械の列（対応・状態・印・cause_bucket）が前の決まりのまま。since は初めの B-2 の時刻なので、B-4 がその後に書いた行は、
 *     後の B-2 が EVAL_LOG の evaluated_at を書き直しても出したまま（B-2 のたびの時刻では決めない）
 * どちらかが違う行は、次の B-4 が書き直すまで出さない（行は消さない）
 */
function appInsightRowScored_(scored, ym, pred, actual, at, since) {
  const s = scored && Object.prototype.hasOwnProperty.call(scored, ym) ? scored[ym] : null;
  if (!s) return false;
  const t = appEvidenceMs_(at);
  if (typeof since !== 'number' || t === null || t < since) return false;
  const same = (a, b) => { const x = appNum_(a), y = appNum_(b); return x !== null && y !== null && Math.abs(x - y) < APP_INSIGHT_SAME_YEN; };
  return same(pred, s.pred) && same(actual, s.actual);
}

/**
 * 計画ごとの精度（appAccuracyCached_ と同じ控え ACC_ を、getAll でまとめて読む）。控えの無い計画だけ EVAL_LOG から計算する
 * （少なければ、その計画の行だけ読む。保存した計画の分だけ計算し直す）。締まった月の境目は PROCESS_STATUS から（D4）
 */
function appInsightAccuracies_(ids, tab) {
  appInsightPreloadHashes_(ids);
  const keys = {};
  ids.forEach(id => { try { keys[id] = appAccuracyKey_(id); } catch (e) { Logger.log('精度を出せない計画: ' + id + ' ' + (e && e.message ? e.message : e)); } });
  const has = ids.filter(id => Object.prototype.hasOwnProperty.call(keys, id));
  const hits = appInsightCacheGet_(has.map(id => keys[id]));
  const found = id => !!(hits[keys[id]] && hits[keys[id]].found);
  const missing = has.filter(id => !found(id));
  const few = appInsightFew_(missing, ids);
  // 締まった月の境目は計画の一覧と同じ（B-1 の後に B-2 がまだの間は、前の B-1 → B-2 の組の境目。appInsightCutoffs_）
  let cut = {};
  if (missing.length) { try { cut = appInsightCutoffs_(missing, tab('PROCESS_STATUS', few)); } catch (e) { Logger.log('締まった月の境目を読めません: ' + (e && e.message ? e.message : e)); } }
  const accs = {};
  has.forEach(id => {
    if (found(id)) { accs[id] = hits[keys[id]].value; return; }
    try {
      // FORECAST_SNAPSHOT は、月ごとに掛かっていた補正を割り戻すため（全計画で縮めた偏りは補正を外した予測で測る。appEvalAppliedK_）
      const v = appAccuracyOf_(id, tab('EVAL_LOG', few)[id] || [], typeof cut[id] === 'string' ? cut[id] : appLandingCutoff_(tab('PROCESS_STATUS', few)[id] || []),
        tab('FORECAST_SNAPSHOT', few)[id] || []);
      try { appJobPutResult_(keys[id], v); } catch (e) { /* 控えられなくても返す */ }
      accs[id] = v;
    } catch (e) { Logger.log('精度を出せない計画: ' + id + ' ' + (e && e.message ? e.message : e)); }
  });
  return accs;
}

/** 日時を画面に出す形に（日時でなければそのまま） */
function appInsightIso_(v) {
  if (appIsDate_(v)) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, APP_TZ, "yyyy-MM-dd'T'HH:mm:ssZ");
  return v === null || v === undefined ? '' : String(v);
}

/**
 * 信頼度の値（今・案・前・後）。hideKey = true なら信頼度（reliability:…）の値は出さない（2026-10-07 村井さん承認: 情報源が 1 人だけの種類では、
 * 種類ごとの値でもその人の信頼度がわかるため。閲覧・情報提供の人には対象の種類だけを見せる）
 */
function appInsightRelVal_(field, v, hideKey) {
  if (hideKey && String(field || '').indexOf('reliability:') === 0) return '';
  return appInsightVal_(v);
}

/** 旧来が文字列で残した値（'1.1' など）を、数なら数に。長い文字列は切る */
function appInsightVal_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (appIsDate_(v)) return appInsightIso_(v);
  const s = v === null || v === undefined ? '' : String(v).trim();
  return /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(s) ? Number(s) : s.slice(0, 300);
}

function appInsightMean_(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

/** 'yyyy/MM' の四半期（旧来の quarterLabelFromYm_ と同じ表記: FY2026-Q1 = 2026 年 4〜6 月） */
function appInsightQuarter_(ym) {
  const m = /^(\d{4})\/(\d{2})$/.exec(String(ym || ''));
  if (!m) return '';
  const y = Number(m[1]), mo = Number(m[2]);
  return 'FY' + (mo >= 4 ? y : y - 1) + '-Q' + (Math.floor(((mo + 8) % 12) / 3) + 1);
}

/** 'yyyy/MM' の年度（4 月始まり・始まりの年） */
function appInsightFyOfYm_(ym) {
  const y = Number(String(ym).slice(0, 4)), mo = Number(String(ym).slice(5, 7));
  return String(mo >= 4 ? y : y - 1);
}

/** 'yyyy/MM' の k か月前 */
function appInsightPrevYm_(ym, k) {
  const y = Number(String(ym).slice(0, 4)), mo = Number(String(ym).slice(5, 7)) - 1 - k;
  const yy = y + Math.floor(mo / 12), mm = ((mo % 12) + 12) % 12 + 1;
  return yy + '/' + ('0' + mm).slice(-2);
}

/** AI の向きを up / down / neutral に（旧来の normalizeAiDirection_ と同じ見分け方） */
function appInsightDir_(v) {
  const s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  if (!s) return '';
  if (/(up|positive|posi|上昇|増)/.test(s)) return 'up';
  if (/(down|negative|nega|低下|減)/.test(s)) return 'down';
  if (/(neutral|flat|中立)/.test(s)) return 'neutral';
  return s;
}

/** 提案・補正の対象の名前（reliability:<種類>:<人や話題> は「見解「鷹野」の信頼度」のように） */
function appInsightTargetLabel_(field) {
  const f = String(field || '');
  if (f.indexOf('reliability:') === 0) {
    const parts = f.split(':');
    const type = parts[1] || '';
    const key = parts.slice(2).join(':');
    return (APP_SOURCE_LABELS[type] || type) + (key ? '「' + key + '」' : '') + 'の信頼度';
  }
  return APP_INSIGHT_FIELD_LABELS[f] || f;
}

/** 提案・補正の対象と、その名前。hideKey = true なら人や話題を除く（reliability:<種類> と「見解の信頼度」のように） */
function appInsightTarget_(field, hideKey) {
  const f = String(field || '');
  const t = hideKey && f.indexOf('reliability:') === 0 ? 'reliability:' + (f.split(':')[1] || '') : f;
  return { target: t, label: appInsightTargetLabel_(t) };
}

/** 提案の根拠。hideKey = true なら、信頼度の提案の根拠は出さない（旧来の C-1 は、その人や話題の的中率と数を書く） */
function appInsightRationale_(r, hideKey) {
  if (hideKey && String(r.target_field || '').indexOf('reliability:') === 0) return '';
  return String(r.rationale || '').slice(0, 300);
}

/**
 * 横断の画面（人の学び・AI の学び）で、人ごとの当たり・人の名前を見せる範囲（2026-10-13: メーカー単位にそろえる。V10.js の appLogViewer_ と同じ決まり）。
 * 全体の予算策定担当以上なら 'full'（どの計画も人ごと）、メーカーに限った予算策定担当だけなら 'clients:<メーカーの ID をカンマで>'
 * （そのメーカーの計画だけ人ごと。appInsightNamedPlans_）、どちらも無ければ 'summary'（どの計画も情報源の種類ごと）。
 * 前はメーカーに限った担当も、すべてのメーカーで「全部見せる」扱いだった。返り値は控えの鍵にも使う（見せ方が違う人に同じ控えを返さない）
 */
function appInsightDetail_(ctx) {
  const roles = (ctx && ctx.roles) || [];
  if (appHasRole_(roles, APP_INSIGHT_DETAIL_ROLE)) return 'full';
  const need = APP_ROLES.indexOf(APP_INSIGHT_DETAIL_ROLE);
  const ids = roles.filter(r => r.scope_type === 'CLIENT' && r.client_id && APP_ROLES.indexOf(r.role) >= need).map(r => String(r.client_id))
    .filter((v, i, a) => a.indexOf(v) === i).sort();
  return ids.length ? 'clients:' + ids.join(',') : 'summary';
}

/**
 * 計画ごとの画面（予測の画面・予測の根拠）で、人ごとの当たり・人の名前・操作した人を見せるか: その計画のメーカーで予算策定担当以上
 * （そのメーカーに限った担当を含む）なら 'full'、無ければ 'summary'（閲覧の人と同じ）
 */
function appInsightDetailFor_(ctx, clientId) {
  return appHasRole_((ctx && ctx.roles) || [], APP_INSIGHT_DETAIL_ROLE, clientId ? String(clientId) : undefined) ? 'full' : 'summary';
}

/**
 * 横断の画面で人ごとに見せる計画（plans = appInsightPlans_ の形）。返り値 { detail, named: { 計画の ID: true }, namedPlans }。
 * detail は画面に返す見せ方: 'full'（どの計画も人ごと）・'partial'（namedPlans の計画だけ人ごと。ほかの計画は種類ごと）・'summary'（どれも種類ごと）
 */
function appInsightNamedPlans_(ctx, plans) {
  const d = appInsightDetail_(ctx);
  const named = {};
  if (d === 'full') plans.forEach(p => { named[p.planId] = true; });
  else if (d.indexOf('clients:') === 0) {
    const ok = appInsightSet_(d.slice('clients:'.length).split(','));
    const client = {};
    appReadTable_('PLANS').forEach(p => { client[p.plan_id] = String(p.client_id || ''); });
    plans.forEach(p => { if (ok[client[p.planId]]) named[p.planId] = true; });
  }
  const ids = plans.filter(p => named[p.planId]).map(p => p.planId);
  const detail = !ids.length ? 'summary' : ids.length === plans.length ? 'full' : 'partial';
  return { detail: detail, named: named, namedPlans: detail === 'partial' ? ids : undefined };
}

/**
 * 計画ごとの一覧（並びは plans の順）を、計画ごとの見せ方で作る。fn(計画の一覧, 隠すか) は、その計画だけの一覧を返す
 * （補正の変化・承認待ちの提案）。どれも同じ見せ方なら 1 回で作る
 */
function appInsightPerPlan_(plans, named, fn) {
  const mine = plans.filter(p => named[p.planId]);
  if (!mine.length || mine.length === plans.length) return fn(plans, !mine.length);
  return [].concat.apply([], plans.map(p => fn([p], !named[p.planId])));
}

/**
 * 人と話題ごとの当たりを、見る人に合わせて: 人ごとに見せる計画（named）の当たりは人や話題ごと、ほかの計画の当たりは情報源の種類ごと
 * （閲覧の人と同じ）にまとめて、1 つの一覧に並べる。人ごとの行の今の信頼度（appliedR）も、人ごとに見せる計画の分だけから出す
 * （ほかのメーカーの同じ名前の人の信頼度を混ぜない）
 */
function appInsightScoreboardFor_(plans, evidence, poolByPlan, relByPlan, named) {
  const mine = plans.filter(p => named[p.planId]), rest = plans.filter(p => !named[p.planId]);
  if (!rest.length || !mine.length) return appSourceScoreboard_(plans, evidence, poolByPlan, relByPlan, !mine.length);
  const pick = list => { const s = appInsightSet_(list.map(p => p.planId)); return evidence.filter(e => s[e.planId]); };
  const rel = {};
  mine.forEach(p => { if (relByPlan[p.planId]) rel[p.planId] = relByPlan[p.planId]; });
  return appSourceScoreboard_(mine, pick(mine), poolByPlan, rel, false).concat(appSourceScoreboard_(rest, pick(rest), poolByPlan, {}, true))
    .sort((a, b) => b.ci80[0] - a.ci80[0] || b.n - a.n || a.type.localeCompare(b.type) || String(a.key || '').localeCompare(String(b.key || '')));
}

/** 判断の履歴を、見る人に合わせて（人ごとに見せる計画は判断した人と信頼度の対象の名前まで。ほかの計画は種類まで）。新しい順に APP_INSIGHT_DECISIONS 件まで */
function appInsightDecisionsFor_(plans, logs, named) {
  const mine = plans.filter(p => named[p.planId]), rest = plans.filter(p => !named[p.planId]);
  if (!rest.length || !mine.length) return appInsightDecisions_(plans, logs, !mine.length);
  return appInsightDecisions_(mine, logs, false).concat(appInsightDecisions_(rest, logs, true))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')) || String(a.planId).localeCompare(String(b.planId))).slice(0, APP_INSIGHT_DECISIONS);
}

// ---- 共通: ベータ分布と二項の区間 ----
// 80% の区間は、正則化不完全ベータ関数 I_x(a, b)（連分数で計算）を二分法で解いた分位点（正規近似は使わない。n が小さくても正しい）

/** log Γ(x)（Lanczos 近似 g = 7。相対誤差は 1e-15 ほど） */
function appLogGamma_(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - appLogGamma_(1 - x);
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  const z = x - 1;
  let a = c[0];
  for (let i = 1; i < 9; i++) a += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** I_x(a, b) の連分数（Lentz 法） */
function appBetaCf_(x, a, b) {
  const TINY = 1e-300;
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 1000; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return h;
}

/** 正則化不完全ベータ関数 I_x(a, b) = ベータ分布 Beta(a, b) の累積確率（a, b > 0） */
function appBetaInc_(x, a, b) {
  if (!(x > 0)) return 0;
  if (!(x < 1)) return 1;
  const front = Math.exp(appLogGamma_(a + b) - appLogGamma_(a) - appLogGamma_(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? front * appBetaCf_(x, a, b) / a : 1 - front * appBetaCf_(1 - x, b, a) / b;
}

/** Beta(a, b) の p 分位点（I_x(a, b) = p を二分法で。60 回で幅 1e-18） */
function appBetaQuantile_(p, a, b) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (appBetaInc_(mid, a, b) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Beta(a, b) の平均と 80% の区間 */
function appBetaSummary_(a, b) {
  return { alpha: a, beta: b, mean: a / (a + b), ci80: [appBetaQuantile_(0.1, a, b), appBetaQuantile_(0.9, a, b)] };
}

/** 二項の割合 k / n の Wilson の区間（z = 1.2816 で 80%）。n = 0 なら null */
function appWilson_(k, n, z) {
  if (!(n > 0)) return null;
  const p = k / n, z2 = z * z;
  const den = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / den;
  const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** 情報源の種類の事前分布（POOL_PRIOR の pooled_value = 2μ、precision = α + β。無ければ Beta(2, 2)） */
function appInsightPrior_(r) {
  const v = r ? appNum_(r.pooled_value) : null;
  const k = r ? appNum_(r.precision) : null;
  const mu = v === null ? 0.5 : Math.min(0.99, Math.max(0.01, v / 2));
  const precision = k !== null && k > 0 ? k : APP_INSIGHT_PRIOR_K;
  return { mu: mu, precision: precision, alpha0: mu * precision, beta0: (1 - mu) * precision, from: v === null ? 'default' : 'pool' };
}

/** 全計画の POOL_PRIOR から、種類ごとに一番新しい事前分布（{ 種類: appInsightPrior_ }。全部の種類を入れる） */
function appInsightPriors_(poolByPlan) {
  const best = {};
  Object.keys(poolByPlan).forEach(id => poolByPlan[id].forEach((r, i) => {
    const scope = String(r.pool_scope || '').trim();
    if (scope.indexOf('reliability:') !== 0 || String(r.param_key || '').trim() !== 'reliability_r') return;
    const type = scope.slice('reliability:'.length);
    const t = appTimeKey_(r.updated_at);
    if (!best[type] || t > best[type].t) best[type] = { t: t, r: r };
  }));
  const out = {};
  APP_SOURCE_TYPES.concat(Object.keys(best)).forEach(type => { if (!out[type]) out[type] = appInsightPrior_(best[type] ? best[type].r : null); });
  return out;
}

/**
 * 入力と AI の話題が、評価できた月に当たったか（旧来の computeReliabilityHitStats_ と同じ判定。月をそろえ、全部の月で数える）。
 * 当たり = 押した向き（push_direction の符号）が、実績 − 過去の売上だけの予測（AI_IMPACT_HISTORY の pred_p50_quant_only）の符号と同じ。
 * 数えるのは締まった月だけ（appLandingCutoff_ の境目より前。D4）。実績は EVAL_LOG の neutral・constraint_relevant_flag = 1 で、
 * 今の検証の版の行（appEvalRowCurrent_。旧来の C-1 と同じ。前の版の行の実績は、その月が途中のときに書いたままのことがある）。
 * 月ごとに、その月が始まる前（日本の暦の 1 日 0 時より前）の最後の予測の回（forecast_open）だけで測る（2026-10-07 村井さん承認 D6）。
 * 回は AI_IMPACT_HISTORY（予測のたびに 12 か月を書く）で選び、人や話題の押した向きは同じ回（run_id。無ければ run_at）の行だけを使う
 * （その回で押していなければ、その月は数えない）。締まった月で実績の行（版は問わない）があるのに、その月が始まる前の予測が無い月は数えず、
 * noPre（渡したときだけ。{ 計画の ID: [月] }）に入れる（その月が始まる前の予測が無い月）。
 * current（渡したときだけ）には、今の決まりで測った月（neutral の行が appEvalRowCurrent_ の月。旧来の readCurrentEvalMonths_ と同じ）と、
 * その行の数字を旧来の B-4 が写す形にしたもの（同じ月の行が 2 つあれば後の行。appEvalScoredMonths_）を [[月, 予測, 実績]] で入れる
 * （振り返りは、この数字と同じ行だけを使う。appInsightRowScored_）。
 * since（渡したときだけ）には、その計画で今の版の B-2 が初めて動いた時刻（ミリ秒か null。appEvalPolicySince_。RUN_LOG も読む）を入れる
 * （振り返りは、この時刻より後に書いた行だけを使う）。
 * dirs（渡したときだけ）には、計画ごとの比べられた月（実績と、その月が始まる前の予測の回の統計だけの予測がそろった月）の、
 * 実績が上に外れた月・下に外れた月の数 [上, 下] を入れる（押した人がいなくても数える。当たりの基準を作る。appInsightEvidence_）。
 * 返り値: [{ planId, ym, quarter, type, key, hit(0/1), dir（押した向き ±1） }]
 */
function appSourceEvidence_(ids, tab, noPre, current, since, dirs) {
  const subj = tab('SUBJECTIVE_IMPACT_HISTORY');
  const impact = tab('AI_IMPACT_HISTORY');
  const evals = tab('EVAL_LOG');
  const runs = since ? tab('RUN_LOG') : {};
  const cut = appInsightCutoffs_(ids, tab('PROCESS_STATUS'));
  const newer = (p, t, i) => !p || t > p.t || (t === p.t && i > p.i);
  const out = [];
  ids.forEach(id => {
    const actual = {};   // 今の決まりで測った月の実績（当たりを測る）
    const seen = {};     // 締まった月で、実績の行がある月（版は問わない。その月が始まる前の予測が無い月を数える）
    (evals[id] || []).forEach(r => {
      if (String(r.scenario) !== 'neutral') return;
      const ym = appYm_(r.target_month);
      if (String(r.constraint_relevant_flag) !== '1' || !cut[id] || !/^\d{4}\/\d{2}$/.test(ym) || ym >= cut[id]) return;   // 締まっていない月は読み飛ばす
      seen[ym] = true;
      if (appEvalRowCurrent_(r, cut[id])) actual[ym] = Number(r.actual || 0);   // 前の版の行は消さずに読み飛ばす
    });
    const pre = {};   // 月 → その月が始まる前の最後の回 { v: 過去の売上だけの予測, t, i, run }
    (impact[id] || []).forEach((r, i) => {
      if (String(r.forecast_source || '').trim() !== 'forecast_open') return;
      const ym = appYm_(r.target_month);
      const start = appMonthStartMs_(ym);
      const t = appTimeKey_(r.run_at);
      if (start === null || !(t > 0) || t >= start) return;   // 月が始まった後の回と、時刻の読めない回は使わない
      if (newer(pre[ym], t, i)) pre[ym] = { v: Number(r.pred_p50_quant_only || 0), t: t, i: i, run: String(r.run_id || '').trim() };
    });
    const sameRun = (p, r, t) => { const run = String(r.run_id || '').trim(); return p.run && run ? run === p.run : t === p.t; };
    const latest = {};
    (subj[id] || []).forEach((r, i) => {
      if (String(r.forecast_source || '').trim() !== 'forecast_open') return;
      const ym = appYm_(r.target_month);
      const type = String(r.source_type || '').trim();
      const key = String(r.source_key || '').trim();
      if (!ym || !type || !key || !pre[ym]) return;
      const t = appTimeKey_(r.run_at);
      if (!sameRun(pre[ym], r, t)) return;
      const u = ym + '\u0001' + type + '\u0001' + key;
      if (newer(latest[u], t, i)) latest[u] = { ym: ym, type: type, key: key, dir: Math.sign(Number(r.push_direction || 0)), t: t, i: i };
    });
    // 月ごとの外れの向き（実績 − 統計だけの予測の符号。0 = 外れていない月は、どの向きも当たりと言えないので数えない）
    const surpriseOf = ym => (Object.prototype.hasOwnProperty.call(actual, ym) && isFinite(actual[ym]) && pre[ym] && isFinite(pre[ym].v)
      ? Math.sign(actual[ym] - pre[ym].v) : 0);
    Object.keys(latest).forEach(u => {
      const x = latest[u];
      const surprise = surpriseOf(x.ym);
      if (!surprise || !x.dir) return;
      out.push({ planId: id, ym: x.ym, quarter: appInsightQuarter_(x.ym), type: x.type, key: x.key, hit: x.dir === surprise ? 1 : 0, dir: x.dir });
    });
    if (dirs) {
      const c = [0, 0];
      Object.keys(actual).forEach(ym => { const s = surpriseOf(ym); if (s) c[s > 0 ? 0 : 1]++; });
      dirs[id] = c;
    }
    if (noPre) noPre[id] = Object.keys(seen).filter(ym => !pre[ym]).sort();
    if (current) current[id] = appEvalScoredMonths_(evals[id] || [], cut[id]);
    if (since) since[id] = appEvalPolicySince_(evals[id] || [], runs[id] || []);
  });
  return out.sort(appInsightEvidenceOrder_);
}

/** 当たりの行の並び（月 → 計画 → 種類 → 人や話題） */
function appInsightEvidenceOrder_(a, b) {
  return a.ym.localeCompare(b.ym) || a.planId.localeCompare(b.planId) || a.type.localeCompare(b.type) || a.key.localeCompare(b.key);
}

/** 計画の当たりの控えの鍵（入力のハッシュが変われば変わる。精度の控え appAccuracyKey_ と同じ作り） */
function appInsightEvidenceKey_(planId) {
  return 'EVD_' + appSha256Hex_([planId, appPlanInputHash_(planId), APP_VERSION].join('|')).slice(0, 32);
}

/**
 * 全計画の当たり（appSourceEvidence_ と同じ行・同じ並び）に、当たりの基準を付けたもの。計画ごとに、入力のハッシュが同じあいだ控える
 * （6 時間。精度の控え ACC_ と同じ）。どこかで保存すると画面の控え（appCachedRead_）は全部外れるが、この控えは保存した計画の分だけが外れる。
 * 控えの無い計画だけ 5 つの表（SUBJECTIVE_IMPACT_HISTORY・AI_IMPACT_HISTORY・EVAL_LOG・PROCESS_STATUS・RUN_LOG）を読む（少なければ、その計画の行だけ）。
 * 控えは { rows: [[月, 種類, 人や話題, 当たり, 押した向き]], dirs: [上, 下], noPre: [その月が始まる前の予測が無い月],
 * cur: [[今の決まりで測った月, 予測, 実績]], from: 今の版の B-2 が初めて動いた時刻（ミリ秒か null） } で持つ（小さくするため。同じ鍵に前の形の控え
 * （dirs・cur・from が無い・行が 4 つ組・月だけの並び・[月, B-2 が書いた時刻] の 2 つ組）が残っていても、使わずに数え直す。
 * from の無い控えの cur は、実績を B-4 の形（appInsightB4View_）にする前のもの）。
 * 基準（行の base。2026-10-13 村井さん承認）= いつも同じ向きと言った場合に当たる割合: その計画の比べられた月のうち、実績が押した向きに
 * 外れた月の割合を、月が少なければ全計画（ids）の割合へ寄せたもの（appHitBaseRates_。寄せる強さは 3 か月ぶん）。
 * 全計画の割合は ids の計画すべての月から作るので、控えには計画ごとの [上, 下] だけを持ち、基準は毎回ここで付ける。
 * noPre・current・since（渡したときだけ）に、計画ごとの「その月が始まる前の予測が無い月」「今の決まりで測った月」「今の版の B-2 が初めて動いた時刻」
 * を入れる（appSourceEvidence_）。dirs（渡したときだけ）に計画ごとの [上, 下] を入れる
 */
function appInsightEvidence_(ids, tab, noPre, current, since, dirs) {
  appInsightPreloadHashes_(ids);
  const keys = {};
  ids.forEach(id => { try { keys[id] = appInsightEvidenceKey_(id); } catch (e) { /* 鍵を作れない計画は控えない（毎回数える） */ } });
  const hits = appInsightCacheGet_(ids.filter(id => keys[id]).map(id => keys[id]));
  const out = [];
  const counts = {};
  const missing = [];
  const pair = x => Array.isArray(x) && x.length === 2 && x.every(n => typeof n === 'number' && n >= 0);
  ids.forEach(id => {
    const c = keys[id] ? hits[keys[id]] : null;
    const v = c && c.found ? c.value : null;
    if (!v || !Array.isArray(v.rows) || !v.rows.every(x => Array.isArray(x) && x.length === 5) || !pair(v.dirs) || !Array.isArray(v.noPre) ||
      !Array.isArray(v.cur) || !v.cur.every(x => Array.isArray(x) && x.length === 3) ||
      !Object.prototype.hasOwnProperty.call(v, 'from') || !(v.from === null || typeof v.from === 'number')) { missing.push(id); return; }
    v.rows.forEach(x => out.push({ planId: id, ym: x[0], quarter: appInsightQuarter_(x[0]), type: x[1], key: x[2], hit: x[3], dir: x[4] }));
    counts[id] = v.dirs;
    if (noPre) noPre[id] = v.noPre;
    if (current) current[id] = v.cur;
    if (since) since[id] = v.from;
  });
  if (missing.length) {
    const few = appInsightFew_(missing, ids);
    const mine = {};
    const gaps = {};
    const cur = {};
    const from = {};
    const got = {};
    missing.forEach(id => { mine[id] = []; });
    appSourceEvidence_(missing, sheet => tab(sheet, few), gaps, cur, from, got).forEach(e => { mine[e.planId].push([e.ym, e.type, e.key, e.hit, e.dir]); out.push(e); });
    missing.forEach(id => {
      const at = typeof from[id] === 'number' ? from[id] : null;
      counts[id] = got[id] || [0, 0];
      if (noPre) noPre[id] = gaps[id] || [];
      if (current) current[id] = cur[id] || [];
      if (since) since[id] = at;
      if (!keys[id]) return;
      try { appJobPutResult_(keys[id], { rows: mine[id], dirs: counts[id], noPre: gaps[id] || [], cur: cur[id] || [], from: at }); } catch (e) { /* 控えられなくても返す */ }
    });
  }
  if (dirs) ids.forEach(id => { dirs[id] = counts[id] || [0, 0]; });
  const share = appHitBaseShare_(counts);
  const rates = {};
  ids.forEach(id => { rates[id] = appHitBaseRates_(counts[id], share, APP_HIT_BASE_MONTHS); });
  out.forEach(e => { e.base = appHitBaseOf_(rates[e.planId], e.dir); });
  return out.sort(appInsightEvidenceOrder_);
}

/** 計画ごとの月の一覧（{ 計画の ID: [月] }）の月の数の合計 */
function appInsightCountMonths_(byPlan) {
  return Object.keys(byPlan).reduce((s, id) => s + (byPlan[id] || []).length, 0);
}

// ---- 分析（メーカーを横に並べる） ----

/**
 * 年度（省くと今の年度。無ければ一番新しい年度）のメーカーごとの要点。
 * 返り値: { fy, fys, plans: [計画の一覧（appPortfolioCached_）の行の項目すべて + revisions, accuracy, topics], totals, market }
 *   revisions: [{ at, p10, p50, p90, live, p50Shown, basis, monthSum }]（新アプリで動かした予測。古い順に最近の 12 回。p10・p50・p90 は記録の旧来の年度合計のまま。
 *              本番で保存した回（live）は p50Shown = その回の月の P50 の合計（basis 'monthsum'）、ほかは旧来の年度合計（basis 'legacy'）。
 *              monthSum = その回の月の P50 の合計（本番の回がある計画の回だけ。本番の前の回と月の合計どうしで比べるため）: appInsightRevision_）
 *   行の p10・p50・p90 と annualShown は計画の一覧のまま（本番の計画は見せる年度の値。年度の途中は着地の推定）
 *   accuracy:  { n, leaks, mape, bias, coverage, coverageN, widthScale }（Learning.js の精度。締まった月だけ。締まった後の予測の月は除く）
 *   topics:    [{ topic, rowType, direction, impact, confidence, score, position, percentile, horizon, asOf }]（AI 調査の一番新しい回）
 *   totals:    { plans, budget, budgetDraft, p50, landing, landingPlans, actualYtd, budgetPlans, p50Budgeted, landingBudgeted, ratioP50, ratioLanding, measurePlans }
 *              （測る専用の計画（measure。版 10 の 3-9）は合計に入れない。measurePlans = 入れなかった数。行には残す）
 *              （合計。予算は計画ごとの空模様と同じ budgetUsed = 承認済みの公式版の最終予算、無ければ今の予算。budgetDraft = 今の予算（OUTPUT）の合計。
 *               着地の見込みが無い計画は着地の合計に入れない（landingPlans = 入れた計画の数）。比は予算のある計画だけで）
 *   market:    [{ topic, makers, up, down, flat, meanScore }]（話題ごと。メーカーの向きは、その話題の行の点数の平均の符号）
 *   insights:  全体の読み解き（予算との差の内訳・合計の分布・不確かさの寄与・見直しの向き・読みのクセ・市場のそろい方。appCrossInsights_）
 */
function appCrossMaker_(fy) {
  const all = appPortfolioCached_();
  const fys = all.map(p => String(p.fy)).filter((x, i, a) => a.indexOf(x) === i).sort();
  const thisFy = String(appFy_(new Date()));
  const asked = /^\d{4}$/.test(String(fy || '')) ? String(fy) : '';
  const pick = asked || (fys.indexOf(thisFy) >= 0 ? thisFy : (fys.length ? fys[fys.length - 1] : thisFy));
  const plans = all.filter(p => String(p.fy) === pick);
  const ids = plans.map(p => p.planId);
  const want = appInsightSet_(ids);
  const tab = appInsightTables_(ids);
  const runs = {};
  appReadTable_('FORECAST_RUNS').filter(r => r.status === 'DONE' && want[r.plan_id]).forEach(r => { (runs[r.plan_id] = runs[r.plan_id] || []).push(r); });
  const accs = appInsightAccuracies_(ids, tab);
  const research = tab('AI_RESEARCH_STRUCTURED');
  const market = {};
  const recent = {};
  ids.forEach(id => { recent[id] = (runs[id] || []).sort((a, b) => String(a.finished_at).localeCompare(String(b.finished_at)) || a._row - b._row).slice(-APP_INSIGHT_REVISIONS); });
  const runSums = appInsightRunSums_([].concat.apply([], ids.map(id => recent[id])));
  const rows = plans.map(p => {
    const rs = recent[p.planId] || [];
    const a = accs[p.planId] || null;
    const topics = appLatestBatch_(research[p.planId] || [], 'as_of_date').map(r => ({
      topic: String(r.topic || '').trim(), rowType: String(r.row_type || ''), direction: appInsightDir_(r.direction), impact: appNum_(r.impact_score),
      confidence: appNum_(r.confidence), score: appNum_(r.blended_score), position: String(r.relative_position_label || ''),
      percentile: appNum_(r.relative_percentile), horizon: String(r.time_horizon || ''), asOf: appYm_(r.as_of_date)
    })).filter(t => t.topic);
    const byTopic = {};
    topics.forEach(t => {
      const o = byTopic[t.topic] = byTopic[t.topic] || { scores: [], up: 0, down: 0 };
      if (t.score !== null) o.scores.push(t.score);
      if (t.direction === 'up') o.up++;
      if (t.direction === 'down') o.down++;
    });
    Object.keys(byTopic).forEach(k => {
      const o = byTopic[k];
      const score = appInsightMean_(o.scores);
      const dir = Math.sign(score !== null ? score : o.up - o.down);
      const m = market[k] = market[k] || { topic: k, makers: 0, up: 0, down: 0, flat: 0, scores: [] };
      m.makers++;
      if (dir > 0) m.up++; else if (dir < 0) m.down++; else m.flat++;
      if (score !== null) m.scores.push(score);
    });
    return Object.assign({}, p, {
      planId: p.planId, clientName: p.clientName, fy: String(p.fy),
      revisions: rs.map(r => appInsightRevision_(r, runSums)),
      accuracy: a ? { n: a.n, leaks: a.leaks, mape: a.mape, bias: a.bias, coverage: a.coverage, coverageN: a.coverageN, widthScale: a.widthScale } : null,
      topics: topics
    });
  });
  const fin = v => typeof v === 'number' && isFinite(v);
  const sum = (xs, f) => xs.reduce((s, p) => { const v = f(p); return fin(v) ? (s || 0) + v : s; }, null);
  const used = p => (typeof p.budgetUsed === 'number' ? p.budgetUsed : p.budget);   // 空模様と同じ予算
  const counted = appBudgetPlanRows_(rows);   // 測る専用の計画は合計に入れない
  const budgeted = counted.filter(p => fin(used(p)) && used(p) > 0);
  const withP50 = budgeted.filter(p => fin(p.p50)), withLanding = budgeted.filter(p => fin(p.landing));
  const totals = { plans: counted.length, budget: sum(counted, used), budgetDraft: sum(counted, p => p.budget), p50: sum(counted, p => p.p50),
    landing: sum(counted, p => p.landing), landingPlans: counted.filter(p => fin(p.landing)).length, actualYtd: sum(counted, p => p.actualYtd),
    budgetPlans: budgeted.length, p50Budgeted: sum(withP50, p => p.p50), landingBudgeted: sum(withLanding, p => p.landing), measurePlans: rows.length - counted.length };
  const b50 = sum(withP50, used), bLanding = sum(withLanding, used);
  totals.ratioP50 = totals.p50Budgeted !== null && b50 > 0 ? totals.p50Budgeted / b50 : null;
  totals.ratioLanding = totals.landingBudgeted !== null && bLanding > 0 ? totals.landingBudgeted / bLanding : null;
  return {
    fy: pick, fys: fys, plans: rows, totals: totals,
    market: Object.keys(market).map(k => ({ topic: k, makers: market[k].makers, up: market[k].up, down: market[k].down, flat: market[k].flat,
      meanScore: appInsightMean_(market[k].scores) })).sort((x, y) => y.makers - x.makers || x.topic.localeCompare(y.topic)),
    backtest: appBacktestCard_(pick),   // 物差し（Backtest.js。割合と点の数だけ。動かした計画が無ければ null）
    insights: appCrossInsights_(rows)   // 全体の読み解き（予算を立てる計画だけ。2026-10-13）
  };
}

// ---- 分析: 全体の読み解き（2026-10-13 村井さん「専門家レベルの推定・示唆・洞察」）----
const APP_INSIGHT_REV_FLAT = 0.005;   // 見直しの変化がこれより小さければ横ばい（±0.5%）
const APP_INSIGHT_LEAN = 0.03;        // 読みのクセが ±3% 未満ならほぼ釣り合い（画面の読みのクセと同じ）
const APP_INSIGHT_LEAN_MIN_N = 3;     // 読みのクセの向きを数えるのは、比べた月がこれだけある計画（画面の ACC_MIN_MONTHS と同じ）
const APP_INSIGHT_MARKET_FLAT = 5;    // 話題の点数の平均が ±5 未満なら横ばい（画面の AN_FLAT と同じ）

/**
 * 全体の読み解き（appCrossMaker_ の insights）。どれも予算を立てる計画（測る専用は入れない: appBudgetPlanRows_）。読むだけ・人ごとの当たりは使わない。
 * 返り値: {
 *   total:  { plans, budget, landing, gap（着地 − 予算）, sdIndependent（√Σσ²）, sdTogether（Σσ）, pIndependent, pTogether（予算以上になる確率 Φ((L − B) / σ)）, settled（σ がどれも 0）} | null
 *           （予算と着地の推定の両方がある計画だけ。appLandingReachTotal_ と同じ足し方）
 *   gaps:   [{ planId, clientName, budget, landing, gap, sd, share（|gap| ÷ Σ|gap|）}]（|gap| の大きい順）
 *   gapTop: { n（上位の数 = 2）, share（上位 2 社の |gap| ÷ Σ|gap|）, absSum } | null（3 社以上で差があるときだけ）
 *   spread: [{ planId, clientName, sd, share（σᵢ² ÷ Σσ²。独立とみたときの合計の分散への寄与）}]（大きい順。σ > 0 の計画だけ）
 *   spreadTop: { k80（寄与の大きい順に足して 80% に届く数）, effective（1 ÷ Σshare²。実質のメーカーの数）, plans } | null
 *   drift:  { plans（直近 2 回の見直しのある計画の数）, up, down, flat, from, to（その 2 回の合計）, change（to ÷ from − 1）, pValue（上下の数の符号検定。両側）,
 *             items: [{ planId, clientName, change }] } | null（見直しが 2 回以上の計画が無ければ null）
 *   lean:   { plans, over, under, even, meanBias } | null（比べた月が 3 か月以上の計画だけ）
 *   market: { makers, up, down, flat, rho（話題の点数の平均と着地 ÷ 予算の順位相関。4 社以上）, rhoN } | null
 * }
 */
function appCrossInsights_(rows) {
  const fin = v => typeof v === 'number' && isFinite(v);
  const used = p => (fin(p.budgetUsed) ? p.budgetUsed : p.budget);
  const counted = appBudgetPlanRows_(rows || []);
  const both = counted.filter(p => fin(used(p)) && used(p) > 0 && fin(p.landing));
  const sdOf = p => (fin(p.landingSd) && p.landingSd > 0 ? p.landingSd : 0);
  const reach = appLandingReachTotal_(both.map(p => ({ landing: p.landing, sd: p.landingSd, budget: used(p) })));
  const out = { total: null, gaps: [], gapTop: null, spread: [], spreadTop: null, drift: null, lean: null, market: null };
  if (reach) {
    const v = both.reduce((s, p) => s + sdOf(p) * sdOf(p), 0), tog = both.reduce((s, p) => s + sdOf(p), 0);
    out.total = { plans: reach.plans, budget: reach.budget, landing: reach.landing, gap: reach.landing - reach.budget, sdIndependent: Math.sqrt(v), sdTogether: tog,
      pIndependent: reach.independent.p, pTogether: reach.together.p, settled: !(tog > 0) };
    const abs = both.reduce((s, p) => s + Math.abs(p.landing - used(p)), 0);
    out.gaps = both.map(p => ({ planId: p.planId, clientName: p.clientName, budget: used(p), landing: p.landing, gap: p.landing - used(p), sd: sdOf(p),
      share: abs > 0 ? Math.abs(p.landing - used(p)) / abs : null }))
      .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || String(a.clientName).localeCompare(String(b.clientName)));
    if (out.gaps.length >= 3 && abs > 0) out.gapTop = { n: 2, share: (Math.abs(out.gaps[0].gap) + Math.abs(out.gaps[1].gap)) / abs, absSum: abs };
    if (v > 0) {
      out.spread = both.filter(p => sdOf(p) > 0).map(p => ({ planId: p.planId, clientName: p.clientName, sd: sdOf(p), share: sdOf(p) * sdOf(p) / v }))
        .sort((a, b) => b.share - a.share || String(a.clientName).localeCompare(String(b.clientName)));
      let cum = 0, k80 = 0;
      out.spread.forEach(x => { if (cum < 0.8 - 1e-12) { cum += x.share; k80++; } });
      out.spreadTop = { k80: k80, effective: 1 / out.spread.reduce((s, x) => s + x.share * x.share, 0), plans: out.spread.length };
    }
  }
  out.drift = appInsightDrift_(counted);
  const leaned = counted.filter(p => p.accuracy && fin(p.accuracy.bias) && (p.accuracy.n || 0) >= APP_INSIGHT_LEAN_MIN_N);
  if (leaned.length) out.lean = { plans: leaned.length, over: leaned.filter(p => p.accuracy.bias >= APP_INSIGHT_LEAN).length,
    under: leaned.filter(p => p.accuracy.bias <= -APP_INSIGHT_LEAN).length, even: leaned.filter(p => Math.abs(p.accuracy.bias) < APP_INSIGHT_LEAN).length,
    meanBias: appInsightMean_(leaned.map(p => p.accuracy.bias)) };
  out.market = appInsightMarketTilt_(counted, used);
  return out;
}

/**
 * 直近の見直しの向き（予算を立てる計画の、最近の 2 回の予測の年間の中心）。前回の値は今回と同じ作り方の値で比べる（画面の anRevPrev と同じ:
 * 今回が本番の月の合計なら前回の月の合計、旧来の計算なら前回の旧来の年度合計）。上下の数の偏りは符号検定（両側。横ばいは除く）
 */
function appInsightDrift_(plans) {
  const fin = v => typeof v === 'number' && isFinite(v);
  const items = [];
  plans.forEach(p => {
    const rs = (p.revisions || []).filter(r => r && fin(r.p50Shown));
    if (rs.length < 2) return;
    const a = rs[rs.length - 2], b = rs[rs.length - 1];
    const kind = r => (r.live && r.basis === 'monthsum' ? 'monthsum' : 'legacy');
    const prev = kind(a) === kind(b) ? a.p50Shown : kind(b) === 'monthsum' && fin(a.monthSum) ? a.monthSum : kind(b) === 'legacy' && fin(a.p50) ? a.p50 : a.p50Shown;
    if (!(prev > 0)) return;
    items.push({ planId: p.planId, clientName: p.clientName, from: prev, to: b.p50Shown, change: b.p50Shown / prev - 1 });
  });
  if (!items.length) return null;
  const up = items.filter(x => x.change >= APP_INSIGHT_REV_FLAT).length, down = items.filter(x => x.change <= -APP_INSIGHT_REV_FLAT).length;
  const from = items.reduce((s, x) => s + x.from, 0), to = items.reduce((s, x) => s + x.to, 0);
  return { plans: items.length, up: up, down: down, flat: items.length - up - down, from: from, to: to, change: from > 0 ? to / from - 1 : null,
    pValue: appSignTest_(up, down), items: items.map(x => ({ planId: x.planId, clientName: x.clientName, change: x.change })).sort((x, y) => x.change - y.change) };
}

/** 符号検定（両側）: 上 a・下 b のとき、偶然（五分五分）でこれ以上偏る確率。a + b = 0 なら null */
function appSignTest_(a, b) {
  const n = a + b, k = Math.max(a, b);
  if (!n) return null;
  let tail = 0, c = 1;   // c = nCi
  for (let i = 0; i <= n; i++) { if (i >= k) tail += c; c = c * (n - i) / (i + 1); }
  return Math.min(1, 2 * tail / Math.pow(2, n));
}

/** 順位（同じ値は順位の平均） */
function appInsightRanks_(xs) {
  const idx = xs.map((v, i) => i).sort((i, j) => xs[i] - xs[j]);
  const r = new Array(xs.length);
  for (let s = 0; s < idx.length;) {
    let e = s;
    while (e + 1 < idx.length && xs[idx[e + 1]] === xs[idx[s]]) e++;
    for (let k = s; k <= e; k++) r[idx[k]] = (s + e) / 2 + 1;
    s = e + 1;
  }
  return r;
}

/** 順位相関（スピアマン。順位のピアソン相関）。ばらつきが無ければ null */
function appSpearman_(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const a = appInsightRanks_(xs), b = appInsightRanks_(ys), n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) * (a[i] - ma); sbb += (b[i] - mb) * (b[i] - mb); }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

/**
 * 市場の話題の向きのそろい方（メーカーごとに、AI の一番新しい調査の話題の点数をすべて平均。±5 未満は横ばい）と、
 * その平均と着地 ÷ 予算の順位相関（予算と着地の推定がある 4 社以上のとき）
 */
function appInsightMarketTilt_(plans, used) {
  const fin = v => typeof v === 'number' && isFinite(v);
  const scored = plans.map(p => ({ p: p, s: appInsightMean_((p.topics || []).map(t => t.score).filter(fin)) })).filter(x => x.s !== null);
  if (!scored.length) return null;
  const pair = scored.filter(x => fin(x.p.landing) && fin(used(x.p)) && used(x.p) > 0);
  const rho = pair.length >= 4 ? appSpearman_(pair.map(x => x.s), pair.map(x => x.p.landing / used(x.p))) : null;
  return { makers: scored.length, up: scored.filter(x => x.s >= APP_INSIGHT_MARKET_FLAT).length, down: scored.filter(x => x.s <= -APP_INSIGHT_MARKET_FLAT).length,
    flat: scored.filter(x => Math.abs(x.s) < APP_INSIGHT_MARKET_FLAT).length, rho: rho, rhoN: rho === null ? 0 : pair.length };
}

/** 予測の回が本番で保存されたか（FORECAST_RUNS.fixes_json に annual_aligned。年度を月の合計にそろえた回。Landing.js の APP_FIX_ANNUAL_ALIGNED） */
function appInsightRunLive_(r) {
  return appParseJsonList_(r && r.fixes_json).indexOf(APP_FIX_ANNUAL_ALIGNED) >= 0;
}

/**
 * 予測の回の、月の P50 の合計（{ run_id: 合計 }。FORECAST_MONTHLY をその回の分だけ。12 か月とも数のそろう回だけ）。
 * 出すのは、本番で保存した回がある計画の回だけ（本番の回と、その前の回: 見直しの流れの「前回から」を月の合計どうしで比べる。2026-10-09）。
 * runs = FORECAST_RUNS の行。本番の回が無ければ表を読まない
 */
function appInsightRunSums_(runs) {
  const livePlan = {}, want = {};
  (runs || []).forEach(r => { if (appInsightRunLive_(r)) livePlan[r.plan_id] = true; });
  (runs || []).forEach(r => { if (livePlan[r.plan_id]) want[r.run_id] = true; });
  if (!Object.keys(want).length) return {};
  const acc = {};
  appReadTable_('FORECAST_MONTHLY').forEach(m => {
    if (!want[m.run_id]) return;
    const o = acc[m.run_id] = acc[m.run_id] || { sum: 0, n: 0, bad: false };
    const v = appNum_(m.p50);
    if (v === null) o.bad = true; else { o.sum += v; o.n++; }
  });
  const out = {};
  Object.keys(acc).forEach(id => { if (!acc[id].bad && acc[id].n === 12) out[id] = acc[id].sum; });
  return out;
}

/**
 * 予測の見直しの流れの 1 回（分析の revisions。2026-10-09）: { at, p10, p50, p90（旧来の計算の年度合計。記録のまま）, live, p50Shown, basis, monthSum }。
 * live = 本番で保存した回（appInsightRunLive_）。p50Shown = 本番の回は、その回の月の P50 の合計（basis 'monthsum'。締まった月なしの予測の画面の
 * 年度の中心と同じ足し方。年度の途中に予測の画面が出していた中心（着地の推定）ではない。月がそろわなければ旧来の年度合計）、ほかの回は旧来の計算の年度合計（basis 'legacy'）。
 * 名前は前のまま（画面は本番の回の値を「月の合計」と呼ぶ）。monthSum = その回の月の P50 の合計（本番の前の回も。sums に無ければ null）。
 * sums = appInsightRunSums_ の返り値
 */
function appInsightRevision_(r, sums) {
  const live = appInsightRunLive_(r);
  const own = sums && Object.prototype.hasOwnProperty.call(sums, r.run_id) ? sums[r.run_id] : null;
  const sum = live ? own : null;
  return { at: r.finished_at, p10: r.annual_p10, p50: r.annual_p50, p90: r.annual_p90, live: live,
    p50Shown: sum !== null ? sum : r.annual_p50, basis: sum !== null ? 'monthsum' : 'legacy', monthSum: own };
}

// ---- 人の学び ----

/**
 * 人の学び（ctx = 見る人。人ごとの当たりと判断した人の名前は予算策定担当以上だけ。メーカーに限った担当はそのメーカーの計画だけ: appInsightNamedPlans_）。返り値:
 *   detail:      'full'（予算策定担当以上）/ 'partial'（メーカーに限った予算策定担当。namedPlans の計画だけ人ごと、ほかの計画は summary と同じ）/
 *                'summary'（閲覧・情報提供。人の名前を出さない）
 *   namedPlans:  partial のときだけ、人ごとに見せる計画の ID
 *   lessons:     [{ planId, clientName, fy, ym, actual, pred, err, absErr, direction, directionLabel, range, miss, hypothesis, actionType, actionLabel,
 *                   reflection, owner, status, statusLabel, human, duplicates }]（誤差の大きい順に 50 件。err = (予測 − 実績) / |実績|。summary では owner は空）
 *   causes:      [{ direction, directionLabel, range, actionType, actionTypes, actionLabel, n }]（外れた月の、向き × 幅の外か × 対応（画面に出す名前）の数。
 *                   actionTypes = まとめた action_type（自動の update と人が選んだ「前提を更新」は 1 行）。actionType はその最初のもの）
 *   openActions: [lessons と同じ形]（未着手・対応中。古い月から）
 *   repeats:     [{ clientName, month: 'MM', fys: [...], n }]（同じメーカーで、違う年度の同じ月にまた外れた）
 *   summary:     { months, misses, withNotes, missesWithNotes, duplicatesRemoved, scoredMonths, waitingMonths }（missesWithNotes = 大きく外れた月のうち、
 *                   人の記入がある月の数（学びの「次の予測で見直すこと」が、記入の無い外れ月の多さを問いかけに使う）。scoredMonths = 今の決まりで B-2 が測った月の数（計画 × 月。
 *                   当たりと同じ計画で、締まった月の今の版の neutral の EVAL_LOG の行がある月）。B-2 の後で B-4 がまだなら、
 *                   months（出した振り返りの月）が 0 でも 0 ではない。waitingMonths = そのうち、締めていない年度の計画で、出せる振り返りの行が
 *                   まだ無い月の数（「外れの原因を整理」（B-4）待ち。締めた年度の計画は B-4 を動かせないので数えない））
 *   scoreboard:  full:    [{ type, label, key, n, hit, hitRate, expected, base, alpha, beta, postMean, ci80: [下, 上], vsBase, prior: { alpha0, beta0, from }, appliedR,
 *                            plans: [{ planId, clientName, fy, n, hit, expected, appliedR }] }]（人や話題ごと）
 *                summary: [{ type, label, sources, n, hit, hitRate, expected, base, alpha, beta, postMean, ci80, vsBase, prior }]（情報源の種類ごと。
 *                           sources = まとめた人や話題の数。今の信頼度は出さない）
 *                （expected = 基準で当たるはずの数、base = その割合（いつも同じ向きと言った場合に当たる割合。appInsightEvidence_）。
 *                 vsBase = 'above'（80% の区間の下の端が基準より上 = いつも同じ向きと言うよりも当たっている）・'below'（上の端が基準より下）・''。
 *                 どちらも 80% の区間の下の端と基準の差が大きい順。少ない数で上位に出ない）
 *   noPreMonth:  締まった月で実績があるのに、その月が始まる前の予測が無いので当たりを数えなかった月の数（計画 × 月。D6）
 *   decisions:   [{ planId, clientName, fy, reviewId, proposalId, at, quarter, phase, phaseLabel, target, targetLabel, current, proposed,
 *                   confidence, rationale, status, decidedAt, decidedBy, applied, appliedAt }]（四半期レビューの提案と判断。新しい順。
 *                   summary では decidedBy は無く、信頼度の対象は種類まで（reliability:<種類>・「見解の信頼度」）。信頼度の提案の rationale は空）
 *   uplift:      [{ planId, clientName, fy, versionNo, budgetAdopted, budgetUplift, budgetFinal, p50, actual, months, complete, ratio, upliftRealized,
 *                   landing, projectedRatio, projectedUpliftRealized }]（公式版の予算と、その年度の実績。complete = 12 か月の実績がそろった。
 *                   ratio・upliftRealized は年度が終わるまで null。projected* は統計の着地の見込みから（見込みが無ければ null））
 */
function appPeopleLearning_(ctx) {
  const plans = appInsightPlans_();
  const view = appInsightNamedPlans_(ctx, plans);
  const named = view.named;
  const ids = plans.map(p => p.planId);
  const tab = appInsightTables_(ids);
  const noPre = {};
  // 今の決まりで測った月とその数字・今の版の B-2 が初めて動いた時刻（振り返りに出す行。当たりの控えと一緒に持つので、
  // EVAL_LOG・RUN_LOG を全計画の分は読み直さない）
  const current = {};
  const since = {};
  const evidence = appInsightEvidence_(ids, tab, noPre, current, since);
  const l = appInsightLessons_(plans, tab('EVAL_INSIGHTS'), view.detail === 'summary', current, since, appInsightFrozen_(plans));
  // 人ごとに見せない計画の振り返りは、担当（人の名前）を空にする（partial のとき）
  if (view.detail === 'partial') [l.lessons, l.openActions].forEach(list => (list || []).forEach(x => { if (!named[x.planId]) x.owner = ''; }));
  return Object.assign({ detail: view.detail, namedPlans: view.namedPlans }, l, {
    scoreboard: appInsightScoreboardFor_(plans, evidence, tab('POOL_PRIOR'), tab('SOURCE_RELIABILITY'), named),
    noPreMonth: appInsightCountMonths_(noPre),
    decisions: appInsightDecisionsFor_(plans, tab('QUARTERLY_REVIEW_LOG'), named),
    uplift: appInsightUplift_(ids)
  });
}

/**
 * 締めた年度の計画（{ 計画の ID: true }）。年度ごとに 1 回だけ確かめる。締めの記録が読めない年度は締めたものとして扱う
 * （B-4 を動かせるとは言わない。読み取りの画面なので止めない）
 */
function appInsightFrozen_(plans) {
  const byFy = {};
  const out = {};
  plans.forEach(p => {
    const fy = String(p.fy);
    if (!Object.prototype.hasOwnProperty.call(byFy, fy)) {
      try { byFy[fy] = appYearIsFrozen_(fy); } catch (e) { Logger.log('年度の締めを確かめられません: ' + fy + ' ' + (e && e.message ? e.message : e)); byFy[fy] = true; }
    }
    if (byFy[fy]) out[p.planId] = true;
  });
  return out;
}

/**
 * 人が書いた跡があるか（旧来の B-4 は action_type（update / keep）・next_cycle_reflection（決まった 2 つの文）・status を自動で入れるので、
 * それ以外の値を人の記入とみなす）
 */
function appInsightHasHuman_(r) {
  const s = k => String(r[k] === null || r[k] === undefined ? '' : r[k]).trim();
  const action = s('action_type');
  const reflection = s('next_cycle_reflection');
  // 状態は、B-4 が入れる組（update と open、keep と monitoring）でなければ人が選んだもの（2026-10-07。対応中・済みもここに入る）
  const st = s('status'), machinePair = (action === 'update' && st === 'open') || (action === 'keep' && st === 'monitoring');
  return !!(s('cause_hypothesis') || s('owner') || (st && !machinePair) ||
    (action && APP_INSIGHT_MACHINE_ACTIONS.indexOf(action) < 0) || (reflection && APP_INSIGHT_MACHINE_REFLECTIONS.indexOf(reflection) < 0));
}

/**
 * 外れた月の振り返り。B-4 を動かし直すと同じ月の行が増える（月が日付に変わり、旧来の上書きの鍵が合わない）ので、計画 × 月で 1 つにする:
 * 数字（実績・予測・幅の外か）は使える行（下の決まり）の一番新しい行から、人が書いた欄（原因・対応・次回への反映・担当・状態）は、
 * その月の人が書いた一番新しい行から取る（使える行でなくても。数字・書いた時刻によらない。2026-10-08 村井さん承認: 前の B-4 で同じ月の行が
 * 2 つ以上でき、人の記入が最後の行に無いと、B-4 は最後の行だけを書き直すので、記入がずっと隠れていた）。
 * 今の決まりで測った月（months = { 計画の ID: [[月, 予測, 実績]] }。締まった月で、今の検証の版の EVAL_LOG の neutral の行がある月と、
 * その行の数字を B-4 が写す形にしたもの。appSourceEvidence_）の行だけを使う（D4〜D6。旧来の画面（webParseEval_）が検証の記入を出す月と
 * 同じ決まり。途中の実績や、月が始まった後の予測で書かれた行は消さずに読み飛ばす）。その月でも、行の予測と実績がその数字と違う行（前の版の
 * 予測の数字で向きが逆のもの・実績を取り込み直して測り直す前のもの）と、その計画で今の版の B-2 が初めて動いた時刻（since = { 計画の ID: ミリ秒か null }）
 * より前に書いた行（前の版の B-4 が書いた行）は、次の B-4 が書き直すまで読み飛ばす（消さない。appInsightRowScored_。計画の画面の
 * appPlanViewDropStale_ と同じ決まり）。scoredMonths = months の月の数（plans の計画だけ）。
 * waitingMonths = そのうち、frozen（{ 計画の ID: true }。締めた年度の計画）でない計画で、出せる行がまだ無い月の数（B-4 待ち）。
 * duplicates = 1 つにまとめた行の数 − 1（使える行と、使える行でない人の記入の行）。
 * hideNames = true なら担当（人の名前）を出さない
 */
function appInsightLessons_(plans, insights, hideNames, months, since, frozen) {
  const all = [];
  let dup = 0;
  let scoredMonths = 0;
  let waitingMonths = 0;
  const newer = (p, t, i) => !p || t > p.t || (t === p.t && i > p.i);
  plans.forEach(p => {
    const byYm = {};
    const human = {};    // 月 → 人が書いた一番新しい行（使える行でなくても）
    const scored = {};   // 月 → 今の版の B-2 が測った予測と実績（B-4 が写す形）
    ((months || {})[p.planId] || []).forEach(x => { scored[x[0]] = { pred: x[1], actual: x[2] }; });
    scoredMonths += Object.keys(scored).length;
    const from = since && Object.prototype.hasOwnProperty.call(since, p.planId) ? since[p.planId] : null;
    (insights[p.planId] || []).forEach((r, i) => {
      const ym = appYm_(r.target_month);
      const t = appTimeKey_(r.evaluated_at);
      const scoredRow = appInsightRowScored_(scored, ym, r.pred_p50, r.actual_total, r.evaluated_at, from);
      if (appInsightHasHuman_(r) && newer(human[ym], t, i)) human[ym] = { r: r, t: t, i: i, scored: scoredRow };
      // 測っていない月・ほかの測り方の数字の行・今の版の B-2 が初めて動く前に書いた行は、数字と印には使わない
      if (!scoredRow) return;
      const o = byYm[ym] = byYm[ym] || { latest: null, rows: 0 };
      o.rows++;
      if (newer(o.latest, t, i)) o.latest = { r: r, t: t, i: i };
    });
    if (!(frozen && frozen[p.planId])) waitingMonths += Object.keys(scored).filter(ym => !Object.prototype.hasOwnProperty.call(byYm, ym)).length;
    Object.keys(byYm).forEach(ym => {
      const x = byYm[ym];
      const hx = human[ym] || null;
      const rows = x.rows + (hx && !hx.scored ? 1 : 0);   // 人の記入を、使える行でない行から取ったら、その行もまとめた行に数える
      dup += rows - 1;
      const m = x.latest.r;
      const h = hx ? hx.r : m;
      const pred = appNum_(m.pred_p50), act = appNum_(m.actual_total);
      const err = pred !== null && act !== null && act !== 0 ? (pred - act) / Math.abs(act) : null;
      const range = String(m.range_breach) === '1' || m.range_breach === true;
      const direction = pred === null || act === null ? '' : pred > act ? 'over' : pred < act ? 'under' : 'exact';
      const status = String(h.status || '').trim();
      const actionType = String(h.action_type || '').trim();
      all.push({ planId: p.planId, clientName: p.clientName, fy: p.fy, ym: ym, actual: act, pred: pred, err: err, absErr: err === null ? null : Math.abs(err),
        direction: direction, directionLabel: APP_INSIGHT_DIRECTION[direction] || '', range: range,
        miss: (err !== null && Math.abs(err) >= APP_INSIGHT_MISS) || range,
        hypothesis: String(h.cause_hypothesis || ''), actionType: actionType, actionLabel: APP_INSIGHT_ACTION_LABELS[actionType] || actionType,
        reflection: String(h.next_cycle_reflection || ''), owner: hideNames ? '' : String(h.owner || ''), status: status, statusLabel: APP_INSIGHT_STATUS[status] || status,
        human: !!hx, duplicates: rows - 1 });
    });
  });
  const byErr = all.slice().sort((a, b) => (b.absErr === null ? -1 : b.absErr) - (a.absErr === null ? -1 : a.absErr) || a.ym.localeCompare(b.ym));
  const misses = all.filter(x => x.miss);
  const causes = {};   // 画面に出す対応の名前でまとめる（自動の update と、人が選んだ「前提を更新」は同じ行）
  misses.forEach(x => {
    const k = [x.direction, x.range ? 1 : 0, x.actionLabel].join('\u0001');
    const o = causes[k] = causes[k] || { direction: x.direction, directionLabel: x.directionLabel, range: x.range, actionType: x.actionType, actionTypes: [],
      actionLabel: x.actionLabel, n: 0 };
    o.n++;
    if (o.actionTypes.indexOf(x.actionType) < 0) o.actionTypes.push(x.actionType);
  });
  const rep = {};
  misses.forEach(x => {
    const k = x.clientName + '\u0001' + x.ym.slice(5, 7);
    const o = rep[k] = rep[k] || { clientName: x.clientName, month: x.ym.slice(5, 7), fys: [], n: 0 };
    o.n++;
    const f = appInsightFyOfYm_(x.ym);
    if (o.fys.indexOf(f) < 0) o.fys.push(f);
  });
  return {
    lessons: byErr.slice(0, APP_INSIGHT_LESSONS),
    causes: Object.keys(causes).map(k => causes[k]).sort((a, b) => b.n - a.n || a.direction.localeCompare(b.direction) || a.actionLabel.localeCompare(b.actionLabel)),
    openActions: all.filter(x => x.status === 'open' || x.status === 'in_progress')
      .sort((a, b) => a.ym.localeCompare(b.ym) || String(a.clientName).localeCompare(String(b.clientName), 'ja')).slice(0, APP_INSIGHT_OPEN_MAX),
    repeats: Object.keys(rep).map(k => rep[k]).filter(o => o.fys.length >= 2).map(o => Object.assign(o, { fys: o.fys.sort() }))
      .sort((a, b) => b.n - a.n || a.month.localeCompare(b.month)),
    summary: { months: all.length, misses: misses.length, withNotes: all.filter(x => x.human).length, missesWithNotes: misses.filter(x => x.human).length,
      duplicatesRemoved: dup, scoredMonths: scoredMonths, waitingMonths: waitingMonths }
  };
}

/**
 * 人と話題ごとの当たり（全計画・全部の評価できた月）と、ベータ分布の事後。当たりは基準（いつも同じ向きと言った場合に当たる割合。
 * evidence の行の base）と比べる（2026-10-13 村井さん承認）: 事前分布は、その行の基準の割合に全計画の見立て（POOL_PRIOR）の
 * 基準を引いた当たり（μ − 0.5）を足した所を中心にする（appInsightBasePrior_。POOL_PRIOR が無ければ基準の割合を中心に強さ 4）。
 * byType = true なら人や話題を出さず、情報源の種類ごとにまとめる（key・plans・appliedR は無し。sources = まとめた人や話題の数）
 */
function appSourceScoreboard_(plans, evidence, poolByPlan, relByPlan, byType) {
  const info = {};
  plans.forEach(p => { info[p.planId] = p; });
  const priors = appInsightPriors_(poolByPlan);
  const applied = {};   // 種類 + 人 → { 計画: 今の信頼度 r }（旧来の C-3 が書いた SOURCE_RELIABILITY。無ければ旧来は 1.0 を使う）
  Object.keys(relByPlan).forEach(id => relByPlan[id].forEach(r => {
    const v = appNum_(r.reliability_r);
    if (v === null) return;
    const k = String(r.source_type || '').trim() + '\u0001' + String(r.source_key || '').trim();
    (applied[k] = applied[k] || {})[id] = v;   // 同じ人の行が 2 つあれば、後の行
  }));
  const g = {};
  evidence.forEach(e => {
    const k = byType ? e.type : e.type + '\u0001' + e.key;
    const o = g[k] = g[k] || { type: e.type, key: e.key, n: 0, hit: 0, expected: 0, by: {}, keys: {} };
    const b0 = typeof e.base === 'number' ? e.base : 0.5;   // 基準の無い行（呼ぶ側が付けていない）は半々
    o.n++; o.hit += e.hit; o.expected += b0;
    o.keys[e.key] = true;
    const b = o.by[e.planId] = o.by[e.planId] || { n: 0, hit: 0, expected: 0 };
    b.n++; b.hit += e.hit; b.expected += b0;
  });
  return Object.keys(g).map(k => {
    const o = g[k];
    const base = o.expected / o.n;
    const pr = appInsightBasePrior_(priors[o.type] || appInsightPrior_(null), base);
    const post = appBetaSummary_(pr.alpha0 + o.hit, pr.beta0 + o.n - o.hit);
    const row = { type: o.type, label: APP_SOURCE_LABELS[o.type] || o.type, n: o.n, hit: o.hit, hitRate: o.hit / o.n, expected: o.expected, base: base,
      alpha: post.alpha, beta: post.beta, postMean: post.mean, ci80: post.ci80, vsBase: appInsightVsBase_(post.ci80, base),
      prior: { alpha0: pr.alpha0, beta0: pr.beta0, from: pr.from } };
    if (byType) {
      // 今の信頼度（appliedR）は出さない（2026-10-07: 情報源が 1 人だけの種類では、種類ごとの平均がその人の信頼度になる）
      return Object.assign(row, { sources: Object.keys(o.keys).length });
    }
    const ap = applied[k] || {};
    return Object.assign(row, { key: o.key, appliedR: appInsightMean_(Object.keys(ap).map(id => ap[id])),
      plans: Object.keys(o.by).map(id => ({ planId: id, clientName: (info[id] || {}).clientName || '', fy: (info[id] || {}).fy || '', n: o.by[id].n, hit: o.by[id].hit,
        expected: o.by[id].expected, appliedR: ap[id] === undefined ? null : ap[id] })) });
  }).sort((a, b) => (b.ci80[0] - b.base) - (a.ci80[0] - a.base) || b.n - a.n || a.type.localeCompare(b.type) || String(a.key || '').localeCompare(String(b.key || '')));
}

/**
 * 基準に合わせた事前分布（{ alpha0, beta0, mean, from }）。pr = 種類の事前分布（appInsightPrior_。μ は POOL_PRIOR の基準を引いた当たり
 * = 0.5 + 当たる割合 − 基準の割合。旧来の reliability_r = 2μ）、base = 基準の割合。中心 = base + (μ − 0.5)（0.01〜0.99）、強さは pr のまま。
 * POOL_PRIOR が無ければ μ = 0.5 なので、中心は基準の割合（いつも同じ向きと同じだけ当たる、という見立てから始める）
 */
function appInsightBasePrior_(pr, base) {
  const b = typeof base === 'number' && isFinite(base) ? base : 0.5;
  const mean = Math.min(0.99, Math.max(0.01, b + pr.mu - 0.5));
  return { alpha0: mean * pr.precision, beta0: (1 - mean) * pr.precision, mean: mean, precision: pr.precision, from: pr.from };
}

/** 80% の区間と基準: 'above'（下の端が基準より上）・'below'（上の端が基準より下）・''（見分けられない） */
function appInsightVsBase_(ci80, base) {
  if (!ci80 || typeof base !== 'number') return '';
  return ci80[0] > base ? 'above' : ci80[1] < base ? 'below' : '';
}

/** 四半期レビューの提案と、人の判断（QUARTERLY_REVIEW_LOG。新しい順）。hideNames = true なら判断した人を出さず、信頼度の対象は種類まで（根拠も出さない） */
function appInsightDecisions_(plans, logs, hideNames) {
  const out = [];
  plans.forEach(p => (logs[p.planId] || []).forEach((r, i) => {
    const target = appInsightTarget_(r.target_field, hideNames);
    const phase = String(r.phase || '').trim();
    const o = { t: appTimeKey_(r.reviewed_at), i: i, planId: p.planId, clientName: p.clientName, fy: p.fy,
      reviewId: String(r.review_id || ''), proposalId: String(r.proposal_id || ''), at: appInsightIso_(r.reviewed_at), quarter: String(r.quarter_label || ''),
      phase: phase, phaseLabel: APP_INSIGHT_PHASES[phase] || phase, target: target.target, targetLabel: target.label,
      current: appInsightRelVal_(r.target_field, r.current_value, hideNames), proposed: appInsightRelVal_(r.target_field, r.proposed_value, hideNames), confidence: String(r.confidence || ''),
      rationale: appInsightRationale_(r, hideNames), status: String(r.approval_status || ''), decidedAt: appInsightIso_(r.approval_decided_at),
      decidedBy: String(r.approval_decided_by || '').split('@')[0], applied: Number(r.applied || 0) === 1, appliedAt: appInsightIso_(r.applied_at) };
    if (hideNames) delete o.decidedBy;
    out.push(o);
  }));
  return out.sort((a, b) => b.t - a.t || String(a.planId).localeCompare(String(b.planId)) || a.i - b.i).slice(0, APP_INSIGHT_DECISIONS)
    .map(x => { const o = Object.assign({}, x); delete o.t; delete o.i; return o; });
}

/**
 * 公式版（承認された版）の予算と、その年度の実績の合計（計画の一覧の暫定実績 = 締まった月の実績）。
 * 実績で見る割合（ratio・upliftRealized）は年度の 12 か月が締まってから出す（途中の実績を年間の予算と比べると、上乗せが外れたように見える）。
 * 年度の途中は、統計の着地の見込み（計画の一覧の landing）で見た割合を別の名前（projected*）で出す
 */
function appInsightUplift_(ids) {
  const want = appInsightSet_(ids);
  const port = {};
  appPortfolioCached_().forEach(p => { if (want[p.planId]) port[p.planId] = p; });
  return appVersionTable_().filter(v => v.state === 'APPROVED' && port[v.plan_id]).map(v => {
    const p = port[v.plan_id];
    const fin = x => typeof x === 'number' && isFinite(x);
    const actual = fin(p.actualYtd) ? p.actualYtd : null;
    const landing = fin(p.landing) ? p.landing : null;
    const months = Number(p.actualMonths || 0);
    const complete = months >= 12;
    const ratioOf = x => (x !== null && v.budget_final > 0 ? x / v.budget_final : null);
    // 上乗せのうち実際に出た割合（(実績 − 採用した予算) / 上乗せ）
    const upliftOf = x => (x !== null && v.budget_uplift && v.budget_adopted !== null ? (x - v.budget_adopted) / v.budget_uplift : null);
    return { planId: p.planId, clientName: p.clientName, fy: String(p.fy), versionNo: v.version_no,
      budgetAdopted: v.budget_adopted, budgetUplift: v.budget_uplift, budgetFinal: v.budget_final, p50: v.annual_p50,
      actual: actual, months: months, complete: complete,
      ratio: complete ? ratioOf(actual) : null, upliftRealized: complete ? upliftOf(actual) : null,
      landing: landing, projectedRatio: ratioOf(landing), projectedUpliftRealized: upliftOf(landing) };
  }).sort((a, b) => b.fy.localeCompare(a.fy) || String(a.clientName).localeCompare(String(b.clientName), 'ja'));
}

// ---- AI の学び ----

/**
 * AI の学び（ctx = 見る人。信頼度の提案と補正の、人や話題の名前は予算策定担当以上だけ。メーカーに限った担当はそのメーカーの計画だけ: appInsightNamedPlans_）。返り値:
 *   detail:      'full'（予算策定担当以上）/ 'partial'（メーカーに限った予算策定担当。namedPlans の計画だけ名前まで）/ 'summary'（閲覧・情報提供。人や話題の名前を出さない）
 *   namedPlans:  partial のときだけ、名前まで見せる計画の ID
 *   curves:      [{ type, label, base, prior: { alpha0, beta0, mu, precision, from, mean, ci80 }, n, hit, expected,
 *                   quarters: [{ quarter, n, hit, cumN, cumHit, cumExpected, base, alpha, beta, mean, ci80, vsBase }] }]（四半期ごとに積み上げた事後。
 *                   画面がベータ分布の曲線を描く。base = いつも同じ向きと言った場合に当たる割合（曲線の基準の線。quarters はその時点までの分）。
 *                   事前分布は基準に合わせる（appInsightBasePrior_。mu は POOL_PRIOR の基準を引いた当たり））
 *   noPreMonth:  その月が始まる前の予測が無いので当たりを数えなかった、締まった月の数（人の学びと同じ。D6）
 *   shrinkage:   { mu, tau, tau2, pooled, plans: [{ planId, clientName, fy, n, bias（補正を外した予測の偏り）, biasNow（今の予測の偏り）, corrected（補正を割り戻した月の数）,
 *                  se, shrunk, factorShadow（補正を外した予測から学んだ倍率）, factorNow（今の補正）, mapeNow, mapeShadow }] }
 *   timeline:    [{ ym, n, mape, coverage, coverageN, coverageCi80: [下, 上], target, rolling3, rolling3N }]（全計画の締まった月ごと。締まった後の予測の月は除く）
 *   calibration: [{ planId, clientName, fy, factorNow, path: [{ at, factor, factorLabel, old, new, source, sourceLabel, quarter }] }]
 *                  （summary では信頼度の factor は種類まで: reliability:<種類>・「見解の信頼度」）
 *   pending:     [{ planId, clientName, fy, reviewId, at, quarter, proposals: [{ proposalId, phase, phaseLabel, target, targetLabel, current, proposed,
 *                   confidence, rationale, decision }] }]（一番新しい四半期レビューで、まだ適用していないもの（C-3 で適用できるものだけ）。decision = 保存した判断。
 *                   summary では信頼度の target は種類まで、その rationale は空）
 *   health:      [{ planId, clientName, fy, key, label, value }]（気になる点。key = shadow_worse / factor_clamp / coverage_low / coverage_high）
 *   unsourced:   { events, unsourced, makers: [clientName] }（いちばん新しい AI 調査の出来事の行の数と、そのうち出典が見つからず予測に効かせなかった行の数。
 *                  makers = 出典の無い行があったメーカー。数とメーカーの名前だけで、人の名前は無い（見せ方によらず同じ）。appInsightUnsourced_）
 */
function appAiLearning_(ctx) {
  const plans = appInsightPlans_();
  const view = appInsightNamedPlans_(ctx, plans);
  const ids = plans.map(p => p.planId);
  const tab = appInsightTables_(ids);
  const noPre = {};
  const evidence = appInsightEvidence_(ids, tab, noPre);
  const priors = appInsightPriors_(tab('POOL_PRIOR'));
  const curves = Object.keys(priors).map(type => {
    const byQ = {};
    let expected = 0, all = 0;
    evidence.forEach(e => {
      if (e.type !== type || !e.quarter) return;
      const b0 = typeof e.base === 'number' ? e.base : 0.5;
      const q = byQ[e.quarter] = byQ[e.quarter] || { n: 0, hit: 0, expected: 0 };
      q.n++; q.hit += e.hit; q.expected += b0;
      all++; expected += b0;
    });
    // 基準（その種類の押した月の基準の平均）に合わせた事前分布（人と話題ごとの当たりと同じ。appInsightBasePrior_）
    const base = all ? expected / all : 0.5;
    const pr = appInsightBasePrior_(priors[type], base);
    let a = pr.alpha0, b = pr.beta0, n = 0, hit = 0, cumExp = 0;
    const quarters = Object.keys(byQ).sort().map(q => {
      n += byQ[q].n; hit += byQ[q].hit; cumExp += byQ[q].expected;
      a += byQ[q].hit; b += byQ[q].n - byQ[q].hit;
      const s = appBetaSummary_(a, b);
      return { quarter: q, n: byQ[q].n, hit: byQ[q].hit, cumN: n, cumHit: hit, cumExpected: cumExp, base: cumExp / n, alpha: a, beta: b, mean: s.mean, ci80: s.ci80,
        vsBase: appInsightVsBase_(s.ci80, cumExp / n) };
    });
    const p0 = appBetaSummary_(pr.alpha0, pr.beta0);
    return { type: type, label: APP_SOURCE_LABELS[type] || type, base: base, prior: { alpha0: pr.alpha0, beta0: pr.beta0, mu: priors[type].mu, precision: pr.precision,
      from: pr.from, mean: p0.mean, ci80: p0.ci80 }, n: n, hit: hit, expected: expected, quarters: quarters };
  });
  const info = {};
  plans.forEach(p => { info[p.planId] = p; });
  const accs = appInsightAccuracies_(ids, tab);
  const shadow = appBiasShadow_(accs);
  // 今の補正: CONFIG!B2 のメーカーの行（予測に効く行。最後の行ではない。appLandingCalRow_。2026-10-13）
  const state = tab('CALIBRATION_STATE');
  let clients = {};
  try { clients = appPlanClients_(ids); } catch (e) { Logger.log('メーカーの名前を読めません: ' + (e && e.message ? e.message : e)); }
  const factorNow = {};
  ids.forEach(id => { const c = appLandingCalRow_(state[id] || [], clients[id] || ''); factorNow[id] = c ? appNum_(c.bias_correction_factor) : null; });
  // 縮めた偏りは補正を外した予測で測る（bias。biasNow = 今の予測の偏り）。倍率は今の補正の代わりに掛ける値なので、今の補正（factorNow）と並べて見せる
  const shrinkage = { mu: shadow.mu, tau: Math.sqrt(shadow.tau2), tau2: shadow.tau2, pooled: shadow.pooled,
    plans: plans.filter(p => shadow.plans[p.planId]).map(p => {
      const s = shadow.plans[p.planId];
      return { planId: p.planId, clientName: p.clientName, fy: p.fy, n: accs[p.planId].n, bias: s.bias, biasNow: s.biasNow, corrected: s.corrected, se: s.se, shrunk: s.shrunk,
        factorShadow: s.factorShadow, factorNow: factorNow[p.planId] === undefined ? null : factorNow[p.planId], mapeNow: s.mapeNow, mapeShadow: s.mapeShadow };
    }) };
  return {
    detail: view.detail, namedPlans: view.namedPlans, curves: curves, noPreMonth: appInsightCountMonths_(noPre), shrinkage: shrinkage, timeline: appInsightTimeline_(accs),
    persistence: appInsightPersistence_(accs),
    calibration: appInsightPerPlan_(plans, view.named, (ps, hide) => appInsightCalibration_(ps, tab('CALIBRATION_HISTORY'), factorNow, hide)),
    pending: appInsightPerPlan_(plans, view.named, (ps, hide) => appInsightPending_(ps, tab('QUARTERLY_REVIEW_LOG'), hide)),
    health: appInsightHealth_(plans, accs, shadow, factorNow),
    unsourced: appInsightUnsourced_(plans, tab)
  };
}

/** A-4 が出典の無い出来事の行の根拠の文の頭に書く断り（LegacyEngine.js の unsourcedAiEvidence_） */
const APP_INSIGHT_UNSOURCED_HEAD = '出典が見つからなかったため';

/**
 * 出典の無い AI 調査の話題の数（学びの「次の予測で見直すこと」: 多ければ、社内の情報で補うよう問いかける。読むだけ）。
 * 計画ごとに AI_RESEARCH_STRUCTURED のいちばん新しい調査の日の出来事（event）の行を数え、根拠の文が A-4 の断りで始まる行
 * （出典が 0 件か Web 検索が失敗したので、予測に効かせなかった行。2026-10-13 の守り）を出典の無い行とする。表が読めなければ 0 件
 */
function appInsightUnsourced_(plans, tab) {
  const out = { events: 0, unsourced: 0, makers: [] };
  let rows = {};
  try { rows = tab('AI_RESEARCH_STRUCTURED') || {}; } catch (e) { Logger.log('AI 調査の表を読めません: ' + (e && e.message ? e.message : e)); return out; }
  plans.forEach(p => {
    const ev = (rows[p.planId] || []).filter(r => String(r.row_type || '').trim() === 'event');
    if (!ev.length) return;
    const key = r => appInsightIso_(r.as_of_date).slice(0, 10);
    const last = ev.map(key).sort().pop();
    let n = 0;
    ev.filter(r => key(r) === last).forEach(r => {
      out.events++;
      if (String(r.evidence || '').trim().indexOf(APP_INSIGHT_UNSOURCED_HEAD) === 0) { out.unsourced++; n++; }
    });
    if (n && out.makers.indexOf(p.clientName) < 0) out.makers.push(p.clientName);
  });
  return out;
}

/**
 * 月の外れの続きやすさ（提案 2。2026-10-13 村井さん承認「推奨どおり」）。着地の推定（Landing.js）は、今年の水準を除いた後の月の外れを
 * 独立とみなして幅を出すので、月の外れが続きやすいと幅が狭すぎる。それを確かめるため、計画 × 年度ごとに締まった月の log(実績 ÷ 中心) から
 * その年度の平均（今年の水準）を引き、隣り合う月どうしの相関を全計画でまとめる（読むだけ。幅の計算は変えない）。
 * 年度の平均を引くと、月が少ないうちは相関が少し負に出る（12 か月で約 −0.09）ので、80% の幅の下の端が 0.2 を超えたときだけ「続きやすい」とする。
 * 手元の実データ（2026-10-07 の写し・1 メーカー 2 年・22 組）では 0.01（80% の幅 −0.28〜0.29）で、続きやすさは見えていない。
 * 返り値 { rho, ci80: [下, 上], pairs（組の数）, plans（使った計画の数）, sticky（続きやすい）}。組が 8 より少なければ rho は null
 */
const APP_INSIGHT_PERSIST_MIN_PAIRS = 8;
function appInsightPersistence_(accs) {
  const pairs = [], used = {};
  Object.keys(accs).forEach(id => {
    const byFy = {};
    (accs[id].months || []).forEach(m => {
      if (m.leak || !/^\d{4}\/\d{2}$/.test(String(m.month))) return;
      if (!(typeof m.p50 === 'number' && m.p50 > 0 && typeof m.actual === 'number' && m.actual > 0)) return;
      (byFy[appInsightFyOfYm_(m.month)] = byFy[appInsightFyOfYm_(m.month)] || []).push({ ym: String(m.month), r: Math.log(m.actual / m.p50) });
    });
    Object.keys(byFy).forEach(fy => {
      const xs = byFy[fy].sort((a, b) => (a.ym < b.ym ? -1 : 1));
      if (xs.length < 3) return;
      const mean = xs.reduce((s, x) => s + x.r, 0) / xs.length;
      for (let i = 1; i < xs.length; i++) {
        if (appInsightPrevYm_(xs[i].ym, 1) !== xs[i - 1].ym) continue;   // 隣り合う月だけ
        pairs.push([xs[i - 1].r - mean, xs[i].r - mean]); used[id] = true;
      }
    });
  });
  const n = pairs.length, plans = Object.keys(used).length;
  if (n < APP_INSIGHT_PERSIST_MIN_PAIRS) return { rho: null, ci80: null, pairs: n, plans: plans, sticky: false };
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n, my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  pairs.forEach(p => { sxy += (p[0] - mx) * (p[1] - my); sxx += (p[0] - mx) * (p[0] - mx); syy += (p[1] - my) * (p[1] - my); });
  if (!(sxx > 0 && syy > 0)) return { rho: null, ci80: null, pairs: n, plans: plans, sticky: false };
  const rho = Math.max(-0.999, Math.min(0.999, sxy / Math.sqrt(sxx * syy)));
  const z = 0.5 * Math.log((1 + rho) / (1 - rho)), se = 1 / Math.sqrt(Math.max(n - 3, 1));
  const ci80 = [Math.tanh(z - APP_INSIGHT_Z80 * se), Math.tanh(z + APP_INSIGHT_Z80 * se)];
  return { rho: rho, ci80: ci80, pairs: n, plans: plans, sticky: ci80[0] > 0.2 };
}

/**
 * 全計画の月ごとの外れ幅と、P10〜P90 に入った割合（Wilson の 80% の区間）。rolling3 = その月までの 3 か月の外れ幅（全計画の月をまとめて）。
 * 外れ幅は精度と同じ合計の比（|中心 − 実績| の合計 ÷ 実績の合計。appWape_。2026-10-13）。1 つの計画の実績が 0 に近い月でも値が飛ばない
 * （金額の大きいメーカーほど重く数える）。月は accs（appAccuracyOf_）の月 = 締まった月だけ（D4）
 */
function appInsightTimeline_(accs) {
  const by = {};
  Object.keys(accs).forEach(id => (accs[id].months || []).forEach(m => {
    if (m.leak || !/^\d{4}\/\d{2}$/.test(String(m.month))) return;
    const o = by[m.month] = by[m.month] || { pts: [], inside: 0, rangeN: 0 };
    if (typeof m.p50 === 'number' && isFinite(m.p50) && typeof m.actual === 'number' && isFinite(m.actual) && m.actual !== 0) o.pts.push({ p50: m.p50, actual: m.actual });
    if (m.inside === true || m.inside === false) { o.rangeN++; if (m.inside) o.inside++; }
  }));
  return Object.keys(by).sort().map(ym => {
    const o = by[ym];
    const win = [].concat.apply([], [ym, appInsightPrevYm_(ym, 1), appInsightPrevYm_(ym, 2)].map(k => (by[k] ? by[k].pts : [])));
    return { ym: ym, n: o.pts.length, mape: appWape_(o.pts).mape, coverage: o.rangeN ? o.inside / o.rangeN : null, coverageN: o.rangeN,
      coverageCi80: appWilson_(o.inside, o.rangeN, APP_INSIGHT_Z80), target: APP_INSIGHT_COVERAGE_TARGET, rolling3: appWape_(win).mape, rolling3N: win.length };
  });
}

/**
 * 補正の変化（CALIBRATION_HISTORY。月次の自動学習 AUTO-MONTHLY・四半期レビューの適用・所有者が承認した値 OWNER-APPROVED（Calibration.js））。
 * hideKeys = true なら信頼度の対象は種類まで
 */
function appInsightCalibration_(plans, hist, factorNow, hideKeys) {
  return plans.map(p => {
    const rows = (hist[p.planId] || []).map((r, i) => ({ t: appTimeKey_(r.changed_at), i: i, r: r })).sort((a, b) => a.t - b.t || a.i - b.i);
    return { planId: p.planId, clientName: p.clientName, fy: p.fy, factorNow: factorNow[p.planId] === undefined ? null : factorNow[p.planId],
      path: rows.map(x => {
        const r = x.r;
        const rid = String(r.review_id || '').trim();
        const auto = rid === 'AUTO-MONTHLY';
        const f = appInsightTarget_(r.factor_name, hideKeys);
        return { at: appInsightIso_(r.changed_at), factor: f.target, factorLabel: f.label,
          old: appInsightRelVal_(r.factor_name, r.old_value, hideKeys), new: appInsightRelVal_(r.factor_name, r.new_value, hideKeys), source: rid,
          sourceLabel: auto ? '月次の自動学習' : rid === APP_CALIBRATION_REVIEW_ID ? '所有者が承認した値' : '四半期レビュー',
          quarter: String(r.quarter_label || '') };
      }) };
  }).filter(x => x.path.length || x.factorNow !== null);
}

/**
 * 承認待ちの提案: 計画ごとの一番新しい四半期レビュー（QUARTERLY_REVIEW_LOG の review_id）で、まだ C-3 で処理していないもの
 * （どの行も approval_decided_at が空で applied = 0）。保存した判断（承認・却下・保留）は、その計画の QUARTERLY_REVIEW の画面の行から読む。
 * C-3 は画面に置いた review_id のレビューだけを適用する。画面の review_id が一番新しいレビューと違えば（その後の C-1 で提案が無かった・
 * 実績が足りずに画面を消した）、もう適用できないので出さない。hideKeys = true なら信頼度の対象は種類まで（根拠も出さない）
 */
function appInsightPending_(plans, logs, hideKeys) {
  const out = [];
  plans.forEach(p => {
    const byRid = {};
    (logs[p.planId] || []).forEach((r, i) => {
      const rid = String(r.review_id || '').trim();
      if (!rid) return;
      const o = byRid[rid] = byRid[rid] || { rid: rid, t: -Infinity, i: -1, rows: [] };
      const t = appTimeKey_(r.reviewed_at);
      if (t > o.t || (t === o.t && i > o.i)) { o.t = t; o.i = i; }
      o.rows.push(r);
    });
    const latest = Object.keys(byRid).map(k => byRid[k]).sort((a, b) => b.t - a.t || b.i - a.i)[0];
    if (!latest) return;
    if (latest.rows.some(r => Number(r.applied || 0) === 1 || (r.approval_decided_at !== '' && r.approval_decided_at !== null && r.approval_decided_at !== undefined))) return;
    const saved = appInsightReviewDecisions_(p.planId);
    if (saved.reviewId !== latest.rid) return;
    const decided = saved.byPid;
    const r0 = latest.rows[0];
    out.push({ planId: p.planId, clientName: p.clientName, fy: p.fy, reviewId: latest.rid, at: appInsightIso_(r0.reviewed_at), quarter: String(r0.quarter_label || ''),
      proposals: latest.rows.map(r => {
        const target = appInsightTarget_(r.target_field, hideKeys);
        const phase = String(r.phase || '').trim();
        const pid = String(r.proposal_id || '');
        return { proposalId: pid, phase: phase, phaseLabel: APP_INSIGHT_PHASES[phase] || phase, target: target.target, targetLabel: target.label,
          current: appInsightRelVal_(r.target_field, r.current_value, hideKeys), proposed: appInsightRelVal_(r.target_field, r.proposed_value, hideKeys), confidence: String(r.confidence || ''),
          rationale: appInsightRationale_(r, hideKeys), decision: decided[pid] || '' };
      }) });
  });
  return out;
}

/** 計画の QUARTERLY_REVIEW（表の形でないシート）の、提案の行（8 行目から）の保存した判断（8 列目）と review_id（8 行目の 10 列目） */
function appInsightReviewDecisions_(planId) {
  const out = { reviewId: '', byPid: {} };
  appReadPlanTable_('ENG_ROWS', planId).forEach(s => {
    if (s.sheet !== 'QUARTERLY_REVIEW' || Number(s.row_no) < 8) return;
    let cells;
    try { cells = JSON.parse(s.cells_json); } catch (e) { return; }
    const c0 = Number(s.col_from) - 1;
    const at = c => {
      const x = c >= c0 ? cells[c - c0] : undefined;
      if (x === undefined || x === null || x === '') return '';
      const t = String(x).charAt(0);
      return t === 'f' ? '' : String(appCellDecode_(t, String(x).slice(1))).trim();
    };
    if (Number(s.row_no) === 8 && at(9)) out.reviewId = at(9);
    if (at(0)) out.byPid[at(0)] = at(7);
  });
  return out;
}

/** 学びの気になる点（計画ごと） */
function appInsightHealth_(plans, accs, shadow, factorNow) {
  const out = [];
  const push = (p, key, value) => out.push({ planId: p.planId, clientName: p.clientName, fy: p.fy, key: key, label: APP_INSIGHT_HEALTH[key], value: value });
  plans.forEach(p => {
    const s = shadow && shadow.plans ? shadow.plans[p.planId] : null;
    if (s && typeof s.mapeShadow === 'number' && typeof s.mapeNow === 'number' && s.mapeShadow > s.mapeNow + 1e-9) push(p, 'shadow_worse', { now: s.mapeNow, shadow: s.mapeShadow });
    const f = factorNow[p.planId];
    if (typeof f === 'number' && isFinite(f) && (f <= APP_INSIGHT_FACTOR_MIN + 1e-9 || f >= APP_INSIGHT_FACTOR_MAX - 1e-9)) push(p, 'factor_clamp', f);
    const a = accs[p.planId];
    if (a && typeof a.coverage === 'number' && a.coverageN >= APP_INSIGHT_COVERAGE_MIN_N) {
      const w = appWilson_(Math.round(a.coverage * a.coverageN), a.coverageN, APP_INSIGHT_Z80);
      const v = { coverage: a.coverage, n: a.coverageN, ci80: w };
      if (w[1] < APP_INSIGHT_COVERAGE_TARGET) push(p, 'coverage_low', v);
      else if (w[0] > APP_INSIGHT_COVERAGE_TARGET) push(p, 'coverage_high', v);
    }
  });
  return out;
}
