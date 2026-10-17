/**
 * HistoryForecast.js — 月次の過去実績だけを使う、固定した少数の予測候補。
 * 外部サービス・表・現在日時・乱数は読まない。渡された系列より先は参照しない。
 * 月は欠けずに時系列で並べる（実績のない月は呼び出す側で確認済みの 0 を渡す）。
 * このファイル単独では本番の予測を置き換えず、候補の採用も決めない。
 */

/** 有限な数だけを受け付ける。返品等の負値はそのまま読み、入力を変更しない。 */
function appHistorySeries_(series) {
  if (!Array.isArray(series)) throw new Error('過去実績は月順の配列で渡してください。');
  for (let i = 0; i < series.length; i++) {
    if (typeof series[i] !== 'number' || !isFinite(series[i])) {
      throw new Error('過去実績に有限な数でない月があります: ' + i);
    }
  }
  return series.slice();
}

/** 月平均。各値を先に割り、有限な入力の合計の桁あふれを避ける。 */
function appHistoryMean_(values) {
  return values.reduce((sum, value) => sum + value / values.length, 0);
}

/**
 * 最低 24 月から、次の horizon 月の候補を返す。足りなければ {}（0 埋めしない）。
 * 配列の先頭は何月でもよい。直近 12 月の同じ位置が次の 12 月に対応する。
 * 12 月を超える horizon は同じ季節パターンを繰り返し、成長を再度掛けない。
 * 売上予測の出力だけを非負にする。負の実績は候補計算・採点から除外しない。
 */
function appHistoryCandidates_(series, horizon) {
  const values = appHistorySeries_(series);
  const h = horizon === undefined ? 12 : horizon;
  if (typeof h !== 'number' || !isFinite(h) || h < 1 || Math.floor(h) !== h) {
    throw new Error('予測月数は 1 以上の整数で渡してください。');
  }
  if (values.length < 24) return {};
  const recent = values.slice(-12);
  const previous = values.slice(-24, -12);
  const recentMean = appHistoryMean_(recent);
  const previousMean = appHistoryMean_(previous);
  // 0/0 は変化なし。前年 0 からの増減は比の上限・下限を使う。
  const ratio = previousMean === 0
    ? (recentMean === 0 ? 1 : (recentMean > 0 ? 2 : 0.5))
    : recentMean / previousMean;
  const damping = Math.sqrt(Math.max(0.5, Math.min(2, ratio)));
  const out = { LAST_YEAR: [], TWO_YEAR: [], LEVEL: [], DAMPED: [], BLEND: [] };
  for (let i = 0; i < h; i++) {
    const m = i % 12;
    const last = recent[m];
    const two = previous[m] / 2 + last / 2;
    const row = {
      LAST_YEAR: last,
      TWO_YEAR: two,
      LEVEL: recentMean,
      DAMPED: last * damping,
      BLEND: last / 2 + two / 2
    };
    Object.keys(out).forEach(name => {
      if (!isFinite(row[name])) throw new Error('予測値が数の範囲を超えました: ' + name);
      out[name].push(Math.max(0, row[name]));
    });
  }
  return out;
}

/**
 * 渡された履歴の内側だけで候補を比べる。候補を選択・補正する副作用はない。
 * 24 月以上の訓練 → 次の 12 月の検証、起点を 6 月ずつ動かす expanding window。
 * 全 12 月を採点し、0 円の月も分母に数える。12 月揃わない末尾は採点しない。
 * scores: 候補別の月 MAE と年度合計の MAE（検証窓間の平均）。
 * folds: 各起点の月 MAE・年度合計の絶対誤差。起点の訓練に検証月は入れない。
 * 36 月未満は検証できないので scores={} / folds=[]。最新の候補は 24 月から返す。
 */
function appHistorySelect_(series) {
  const values = appHistorySeries_(series);
  const candidates = appHistoryCandidates_(values, 12);
  const totals = {};
  const folds = [];
  for (let origin = 24; origin + 12 <= values.length; origin += 6) {
    const predictions = appHistoryCandidates_(values.slice(0, origin), 12);
    const actual = values.slice(origin, origin + 12);
    const actualAnnual = actual.reduce((sum, value) => sum + value, 0);
    const fold = { origin: origin, validationEnd: origin + 12, actualAnnual: actualAnnual, scores: {} };
    Object.keys(predictions).forEach(name => {
      const predicted = predictions[name];
      const absoluteErrors = predicted.map((value, i) => Math.abs(value - actual[i]));
      const monthlyMae = appHistoryMean_(absoluteErrors);
      const predictedAnnual = predicted.reduce((sum, value) => sum + value, 0);
      const annualAbsoluteError = Math.abs(predictedAnnual - actualAnnual);
      fold.scores[name] = { monthlyMae: monthlyMae, annualAbsoluteError: annualAbsoluteError };
      if (!totals[name]) totals[name] = { monthly: [], annual: [] };
      totals[name].monthly.push(monthlyMae);
      totals[name].annual.push(annualAbsoluteError);
    });
    folds.push(fold);
  }
  const scores = {};
  Object.keys(totals).forEach(name => {
    scores[name] = {
      foldCount: folds.length,
      monthCount: folds.length * 12,
      monthlyMae: appHistoryMean_(totals[name].monthly),
      annualMae: appHistoryMean_(totals[name].annual)
    };
  });
  return { candidates: candidates, scores: scores, folds: folds };
}
