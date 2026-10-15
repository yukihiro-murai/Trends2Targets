/**
 * LayerEffects.js — 層ごとの効き（LAYER_EFFECTS。SCHEMA_PLAN_v10-12_JA.md の 3-3。2026-10-08 村井さん承認「版10はおすすめで」）。
 * 予測 1 回 × 月ごとに「統計の土台 → スポット → 人 → AI → 補正 → 最後の値」を円で残す（予測の保存 appForecastRunSave_ と同じ控えで 12 行）。
 * 記録は計算に使わない。予測の数字・OUTPUT・CONFIG・種は変えない（読むだけ）。
 *
 * 分け方は RATIO（記録にある値から割合で分ける）。第一案の LMDI（旧来の CONFIG の LMDI_DECOMPOSITION_ENABLED を 1 にして OUTPUT の末尾の表を読む）は使わない:
 *   - 乱数は使わないので数字は変わらないが、1 にすると OUTPUT の末尾に表が足され、その OUTPUT が保存される（保存している OUTPUT が変わる）
 *   - CONFIG は種が見る表（Forecast.js の APP_FORECAST_SEED_SHEETS）なので、1 を保存すると種が変わる。計算用ブックだけで 1 にして保存の前に戻すと、
 *     旧来の計算の書いた表を保存の前に書き換えることになる
 *   - 分けるのは主観の倍率（製品・メーカー全体・見解・AI の話題）だけで、月ごとは幅（P10〜P90）、足し算できる平均は予測の月の合計だけ。
 *     スポット・補正・Vertex は分けないので、月ごとに足して最後の値になる形にはならない
 * RATIO（月ごと。予測の月 = forecast_open。締まった月で実績に置き換えた月 = actual_closed は層をすべて 0）:
 *   final = FORECAST_MONTHLY の p50、stat = obj_p50（旧来の「過去売上のみ（客観）」。製品・メーカー全体・見解・AI・補正は入れない。
 *           ただし背景のスポットは、確定スポットと重なる分を旧来の計算が差し引いている）
 *   補正: 予測の月だけ、旧来の計算は最後の真ん中に 係数 ×（1 + 月ごとの補正（±25% で止める））× Vertex（1 + 押し）を掛けている。
 *         掛ける前 = final ÷ 倍率。差を 2 つの倍率の対数の割合で、補正（calib）と Vertex（ai に入れる）に分ける
 *   スポット: 確定しているスポット案件の P50（OUTPUT の「入力パラメータの影響（目安）」の表の Known Spot P50）
 *   人: 統計の土台の月の値（同じ表の Ops基礎）×（製品 × メーカー全体 × 見解 − 1）。種類ごとに倍率の対数の割合で分ける（人の名前は入れない）
 *   AI: Ops基礎 × 人の倍率 ×（AI の倍率 − 1）+ Vertex の分。AI の倍率は AI_IMPACT_HISTORY の k_ai
 *   other: final − stat − スポット − 人 − AI − 補正（真ん中の取り方・上限・シミュレーションの揺れで合わない分。足すと必ず final）
 * 層の円は 1 円に丸める（人は種類ごとの合計）。この回の記録の行は、計算の前の行の数（appLayerTail_）より後に足された行で見分ける。
 */

/** 月ごとの補正の上限（旧来の AUTOLEARN_FORECAST_BIAS_CAP と同じ。app/tests が旧来の値と照らす） */
const APP_LAYER_MONTH_BIAS_CAP = 0.25;
/** この回に旧来の計算が足した行を見分ける記録のシート */
const APP_LAYER_TAIL_SHEETS = ['AI_IMPACT_HISTORY', 'SUBJECTIVE_IMPACT_HISTORY', 'FORECAST_SNAPSHOT'];
/** 人の層の種類（旧来の SUBJECTIVE_IMPACT_HISTORY の source_type と同じ名前） */
const APP_LAYER_HUMAN_TYPES = ['factor_product', 'factor_client', 'opinion'];

/** 計算の前: 記録のシートの最後の行（計算用ブック。予測の計算 appForecastRunCalc_ が保存の段へ渡す） */
function appLayerTail_(scratch) {
  const out = {};
  APP_LAYER_TAIL_SHEETS.forEach(n => { const sh = scratch.getSheetByName(n); out[n] = sh ? sh.getLastRow() : 0; });
  return out;
}

/**
 * 予測の保存に足す層ごとの効きの控え（ops）。読めない・分けられないときは足さずにエラーのログに残す（予測の保存は止めない）。
 * headline: 予測の主な結果（appForecastHeadline_）、scratch: この回の計算用ブック、p: 保存の段の中身（runId・layerTail）
 */
function appLayerEffectsOps_(ctx, plan, p, headline, scratch) {
  try {
    const layers = appLayerEffects_(headline, appLayerRecords_(scratch, p.layerTail));
    const now = appNowIso_();
    return appLogOps_('LAYER_EFFECTS', layers.map(x => Object.assign({ plan_id: plan.plan_id,
      effect_id: appStableLogId_(APP_LOG_PREFIX.LAYER_EFFECTS, [p.runId, x.ym]), run_id: p.runId, recorded_at: now }, x)));
  } catch (e) {
    appLogError_('LOG.LAYER_EFFECTS', e, ctx);
    return [];
  }
}

/** 数（数でなければ null） */
function appLayerNum_(v) {
  if (v === '' || v === null || v === undefined || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : null;
}

/** シートの見出し → 値の行（from 行目より後。from が無ければ全部） */
function appLayerRowsAfter_(scratch, name, from) {
  const sh = scratch.getSheetByName(name);
  if (!sh) return [];
  const last = sh.getLastRow(), cols = sh.getLastColumn();
  if (last < 2 || cols < 1) return [];
  const start = Math.max(2, (Number(from) || 0) + 1);
  if (start > last) return [];
  const head = sh.getRange(1, 1, 1, cols).getValues()[0].map(h => String(h).trim());
  return sh.getRange(start, 1, last - start + 1, cols).getValues().map(r => {
    const o = {};
    head.forEach((h, j) => { if (h) o[h] = r[j]; });
    return o;
  });
}

/** 行のうち、最後の行と同じ回（key の列）の行だけ */
function appLayerLastBatch_(rows, key) {
  if (!rows.length) return [];
  const id = String(rows[rows.length - 1][key] || '');
  return id ? rows.filter(r => String(r[key] || '') === id) : [];
}

/**
 * この回の記録を計算用ブックから読む: { influence: { 'yyyy/MM': { opsBase, kProd, kClient, kOpinion, kAi, spot } }, kAi, source, vertex（月ごと）,
 * cal: { factor, monthBias: { 暦月: 割合 } } }。tail = 計算の前の行の数（無ければ、最後の回の行）
 */
function appLayerRecords_(scratch, tail) {
  const t = tail || {};
  const out = { influence: {}, kAi: {}, source: {}, vertex: {}, cal: null };
  // OUTPUT の「入力パラメータの影響（目安）」の表（見出しの行: Month・Ops基礎・kProd・kClient・kOpinion(P50)・kAI・Known Spot Expected・Known Spot P50 …）
  const sh = scratch.getSheetByName('OUTPUT');
  if (sh && sh.getLastRow() > 0 && sh.getLastColumn() > 0) {
    const v = sh.getRange(1, 1, sh.getLastRow(), Math.min(sh.getLastColumn(), 16)).getValues();
    const at = v.findIndex(r => String(r[0]).trim() === 'Month' && String(r[1]).trim() === 'Ops基礎' && String(r[2]).trim() === 'kProd');
    if (at >= 0) {
      const col = {};
      v[at].forEach((h, j) => { col[String(h).trim()] = j; });
      const get = (r, h) => (col[h] === undefined ? null : appLayerNum_(r[col[h]]));
      for (let i = at + 1; i < v.length && i <= at + 12; i++) {
        const ym = appYm_(v[i][0]);
        if (!/^\d{4}\/\d{2}$/.test(ym)) break;
        const known = get(v[i], 'Known Spot P50');
        out.influence[ym] = { opsBase: get(v[i], 'Ops基礎'), kProd: get(v[i], 'kProd'), kClient: get(v[i], 'kClient'), kOpinion: get(v[i], 'kOpinion(P50)'),
          kAi: get(v[i], 'kAI'), spot: known !== null ? known : get(v[i], 'Known Spot Expected'),
          kHumanRaw: get(v[i], 'kHuman(raw)'), kAiRaw: get(v[i], 'kAI(raw)') };   // 効き係数を掛ける前の倍率（旧来の計算 2.7.1 から。前の回は null）
      }
    }
  }
  // AI の倍率と、締まった月か（AI_IMPACT_HISTORY のこの回の 12 行）
  const ai = appLayerLastBatch_(appLayerRowsAfter_(scratch, 'AI_IMPACT_HISTORY', t.AI_IMPACT_HISTORY), 'run_id');
  const runId = ai.length ? String(ai[0].run_id) : '';
  ai.forEach(r => { const ym = appYm_(r.target_month); out.kAi[ym] = appLayerNum_(r.k_ai); if (r.forecast_source) out.source[ym] = String(r.forecast_source); });
  // Vertex の押し（SUBJECTIVE_IMPACT_HISTORY のこの回の vertex_forecast。押し = 倍率 − 1）
  if (runId) {
    appLayerRowsAfter_(scratch, 'SUBJECTIVE_IMPACT_HISTORY', t.SUBJECTIVE_IMPACT_HISTORY)
      .filter(r => String(r.run_id) === runId && String(r.source_type) === 'vertex_forecast').forEach(r => {
        const ym = appYm_(r.target_month), s = appLayerNum_(r.push_step);
        if (s !== null) out.vertex[ym] = (out.vertex[ym] || 0) + s;
      });
  }
  // 補正（FORECAST_SNAPSHOT のこの回の calibration_applied_json = その予測に掛かっていた補正）と、締まった月か（key_factors_json）
  const snap = appLayerLastBatch_(appLayerRowsAfter_(scratch, 'FORECAST_SNAPSHOT', t.FORECAST_SNAPSHOT).filter(r => String(r.scenario) === 'neutral'), 'snapshot_id');
  snap.forEach(r => {
    const ym = appYm_(r.target_month);
    if (!out.source[ym]) { try { const k = JSON.parse(String(r.key_factors_json || '{}')) || {}; if (k.forecast_source) out.source[ym] = String(k.forecast_source); } catch (e) { /* 読めなければ予測の月 */ } }
  });
  if (snap.length) {
    let c = {};
    try { c = JSON.parse(String(snap[0].calibration_applied_json || '{}')) || {}; } catch (e) { c = {}; }
    const f = appLayerNum_(c.bias_correction_factor);
    const mb = {};
    try {
      const j = JSON.parse(String(c.residual_month_bias_json || ''));
      if (j && typeof j === 'object' && !Array.isArray(j)) Object.keys(j).forEach(k => { const m = Number(k), x = Number(j[k]); if (m >= 1 && m <= 12 && isFinite(x)) mb[String(m)] = x; });
    } catch (e) { /* 空・壊れた JSON は月ごとの補正なし（旧来と同じ） */ }
    out.cal = { factor: f !== null && f > 0 ? f : 1, monthBias: mb };
  }
  return out;
}

/** 対数平均の重み L(k) = (k − 1) / ln k（k = 1 なら 1）。x × L(k) × ln k = x ×（k − 1） */
function appLayerLogMean_(k) {
  return Math.abs(k - 1) < 1e-12 ? 1 : (k - 1) / Math.log(k);
}

/**
 * base ×（倍率の積 − 1）を倍率ごとの分に分ける（足すと必ず base ×（積 − 1））。どれも正なら base × L(積) × ln k、
 * 0 以下の倍率があれば（k − 1）の割合で（旧来の lmdiDecompose_ と同じ逃げ方）
 */
function appLayerSplit_(base, ks) {
  const prod = ks.reduce((a, k) => a * k, 1);
  if (ks.every(k => k > 0)) { const w = base * appLayerLogMean_(prod); return ks.map(k => w * Math.log(k)); }
  const total = base * (prod - 1), den = ks.reduce((a, k) => a + (k - 1), 0);
  return ks.map(k => (Math.abs(den) < 1e-12 ? total / ks.length : total * (k - 1) / den));
}

/** 1 円に丸める（-0 にしない） */
function appLayerYen_(v) {
  return Math.round(v) + 0;
}

/**
 * 層ごとの効き（計算だけ。表は読まない）。headline = 予測の主な結果（monthly・objectiveMonthly）、rec = appLayerRecords_ の形。
 * 返り値: 月ごとの { ym, final_p50, stat_p50, spot_yen, human_yen, human_by_type_json, ai_yen, calib_yen, other_yen, method, source }。
 * 最後の真ん中か過去の売上だけの真ん中が無い月は返さない
 */
function appLayerEffects_(headline, rec) {
  const h = headline || {}, r = rec || {};
  const obj = {};
  (h.objectiveMonthly || []).forEach(m => { obj[m.month] = m; });
  const cal = r.cal || { factor: 1, monthBias: {} };
  const out = [];
  (h.monthly || []).forEach(m => {
    const ym = String(m.month || '');
    const F = appLayerNum_(m.p50), S = obj[ym] ? appLayerNum_(obj[ym].p50) : null;
    if (F === null || S === null) return;
    const source = (r.source || {})[ym] === 'actual_closed' ? 'actual_closed' : 'forecast_open';
    const byType = { factor_product: 0, factor_client: 0, opinion: 0 };
    let spot = 0, aiTopic = 0, vertex = 0, calib = 0;
    // 締まった月で実績に置き換えた月（旧来の FORECAST_CLOSED_MONTH_MODE が actual）: 最後の値 = 過去の売上だけ = 実績。層はすべて 0
    if (!(source === 'actual_closed' && Math.abs(F - S) < 0.5)) {
      let pre = F;
      if (source === 'forecast_open') {
        const mm = Number(ym.slice(5));
        const mb = Math.max(-APP_LAYER_MONTH_BIAS_CAP, Math.min(APP_LAYER_MONTH_BIAS_CAP, Number((cal.monthBias || {})[String(mm)] || 0)));
        const kc = (Number(cal.factor) > 0 ? Number(cal.factor) : 1) * (1 + mb);
        const kv = 1 + (appLayerNum_((r.vertex || {})[ym]) || 0);
        const k = kc * kv;
        if (isFinite(k) && k > 0 && Math.abs(k - 1) >= 1e-12) {
          pre = F / k;
          const parts = appLayerSplit_(pre, [kc, kv]);
          calib = parts[0];
          vertex = parts[1];
        }
      }
      const inf = (r.influence || {})[ym];
      if (inf) {
        const q = Math.max(0, appLayerNum_(inf.opsBase) || 0);
        const k1 = v => (appLayerNum_(v) === null ? 1 : appLayerNum_(v));
        const ks = [k1(inf.kProd), k1(inf.kClient), k1(inf.kOpinion)];
        const kAi = appLayerNum_((r.kAi || {})[ym]) !== null ? appLayerNum_(r.kAi[ym]) : k1(inf.kAi);
        const hp = appLayerSplit_(q, ks);
        APP_LAYER_HUMAN_TYPES.forEach((t, j) => { byType[t] = hp[j]; });
        aiTopic = q * ks[0] * ks[1] * ks[2] * (kAi - 1);
        spot = Math.max(0, appLayerNum_(inf.spot) || 0);
      }
    }
    APP_LAYER_HUMAN_TYPES.forEach(t => { byType[t] = appLayerYen_(byType[t]); });
    const spotYen = appLayerYen_(spot);
    const humanYen = APP_LAYER_HUMAN_TYPES.reduce((a, t) => a + byType[t], 0);
    const aiYen = appLayerYen_(aiTopic) + appLayerYen_(vertex);
    const calibYen = appLayerYen_(calib);
    const known = S + spotYen + humanYen + aiYen + calibYen;
    out.push({ ym: ym, final_p50: F, stat_p50: S, spot_yen: spotYen, human_yen: humanYen, human_by_type_json: byType, ai_yen: aiYen,
      calib_yen: calibYen, other_yen: F - known, method: 'RATIO', source: source });
  });
  return out;
}

/**
 * 根拠の画面: 最新の予測と前の予測の、層ごとの効きの月の合計（人の名前は入らない。計画を見られる人に出す）。
 * 返り値: { latest, prev }（それぞれ { final, stat, spot, human, ai, calib, other, byType, months, closed, method } か null）。最新の回の行が無ければ null
 */
function appBasisLayers_(planId, latest, prev) {
  if (!latest) return null;
  let rows;
  try { rows = appReadPlanTable_('LAYER_EFFECTS', planId); } catch (e) { return null; }   // 表の版がそろう前
  const n = v => (typeof v === 'number' && isFinite(v) ? v : 0);
  const sum = runId => {
    const list = runId ? rows.filter(x => x.run_id === runId) : [];
    if (!list.length) return null;
    const o = { final: 0, stat: 0, spot: 0, human: 0, ai: 0, calib: 0, other: 0, byType: {}, months: list.length, closed: 0, method: String(list[0].method || '') };
    list.forEach(x => {
      o.final += n(x.final_p50); o.stat += n(x.stat_p50); o.spot += n(x.spot_yen); o.human += n(x.human_yen); o.ai += n(x.ai_yen);
      o.calib += n(x.calib_yen); o.other += n(x.other_yen);
      if (x.source === 'actual_closed') o.closed++;
      let bt = {};
      try { bt = JSON.parse(String(x.human_by_type_json || '{}')) || {}; } catch (e) { bt = {}; }
      APP_LAYER_HUMAN_TYPES.forEach(t => { o.byType[t] = (o.byType[t] || 0) + n(Number(bt[t])); });
    });
    return o;
  };
  const a = sum(latest.run_id);
  return a ? { latest: a, prev: prev ? sum(prev.run_id) : null } : null;
}
