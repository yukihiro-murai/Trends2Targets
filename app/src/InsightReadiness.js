/** InsightReadiness.js — 人の記入が空である理由を、保存済みの記録から読むだけで説明する。計算・保存・表示対象の条件は変えない。 */
const APP_INSIGHT_READINESS_REV = 'INSIGHT_READINESS_V1';
const APP_INSIGHT_READINESS_REASONS = {
  READY: '記入対象の月があります。',
  NO_ACTUALS: 'この計画には、比較用に取り込んだ実績の記録がありません。',
  OLD_POLICY: '以前の基準の採点が残っていますが、今の基準で比較できる採点月はありません。',
  NO_CLOSED_ACTUALS: '取り込んだ実績に、締まりの条件を満たす月がありません。',
  NO_CURRENT_EVAL: '締まった実績と現在の検証条件がそろう採点月がありません。',
  INSIGHTS_MISSING: '採点した月に対応する、原因整理の記録がありません。',
  INSIGHTS_STALE: '保存された原因整理が現在の採点条件と一致しないため、記入対象から外しています。',
  NOT_PREPARED: '記入対象を表示するための記録表が、まだ用意されていません。',
  UNKNOWN: '記入対象の月がない理由を、記録から確認できませんでした。'
};

/**
 * boot は appPlanViewDropStale_ 後、beforeInsights はその直前の boot.eval.insights（省略時は元表から同じ月の条件で数える）。
 * 返すのは既知の理由・件数・現行の検証条件・最後に成功した B-2/B-4 の時刻だけ。人の記入・人名・金額は返さない。
 * sheet=null は表示用メタが無い事実（NOT_PREPARED）であり、未読の行を0件とはしない。正規の見出しだけの表は0件。
 */
function appInsightReadiness_(boot, book, beforeInsights) {
  const counts = {
    actualRows: null, closedActualMonths: null, closedCurrentFyMonths: null,
    evalRows: null, currentPolicyNeutralMonths: null, oldPolicyNeutralRows: null, eligibleMonths: null,
    insightRows: null, legacyVisibleRows: null, displayedRows: null,
    staleTimeRows: null, mismatchedValueRows: null, missingTables: null
  };
  const result = { code: 'UNKNOWN', reason: APP_INSIGHT_READINESS_REASONS.UNKNOWN,
    currentPolicy: APP_EVAL_POLICY_VERSION, counts: counts, lastB2At: null, lastB4At: null };
  const finish = code => { result.code = code; result.reason = APP_INSIGHT_READINESS_REASONS[code]; return result; };
  try {
    if (!boot || !boot.setup || !String(boot.setup.client || '').trim() || !boot.eval || !Array.isArray(boot.eval.insights)) return result;
    if (beforeInsights !== undefined && !Array.isArray(beforeInsights)) return result;
    counts.displayedRows = boot.eval.insights.length;
    if (beforeInsights) counts.legacyVisibleRows = beforeInsights.length;
    const client = appInsightReadinessClient_(boot.setup.client);
    const names = ['ACTUAL_EVAL_MONTHLY', 'EVAL_LOG', 'EVAL_INSIGHTS', 'RUN_LOG'];
    const tables = {}, missing = [];
    names.forEach(name => {
      const table = appInsightReadinessTable_(book, name);
      if (table === null) missing.push(name);
      else tables[name] = table;
    });
    counts.missingTables = missing.length;
    if (tables.ACTUAL_EVAL_MONTHLY) counts.actualRows = tables.ACTUAL_EVAL_MONTHLY.filter(r => appInsightReadinessClient_(r.client) === client).length;
    if (tables.EVAL_LOG) counts.evalRows = tables.EVAL_LOG.length;
    if (tables.EVAL_INSIGHTS) counts.insightRows = tables.EVAL_INSIGHTS.length;
    if (tables.RUN_LOG) {
      result.lastB2At = appInsightReadinessLast_(tables.RUN_LOG, 'updatePhase1EvaluationReport');
      result.lastB4At = appInsightReadinessLast_(tables.RUN_LOG, 'updatePhase1LearningInsights');
    }
    if (missing.length) return finish('NOT_PREPARED');

    // Legacy closedActualMonthsOf_ と同じ: 同じ client/月の全行が締まり条件を満たす必要がある。
    // actual_closed_flag だけを信じず、各行の source_updated_at と月末+5日の条件を確かめる。
    const closed = {};
    tables.ACTUAL_EVAL_MONTHLY.forEach(r => {
      if (appInsightReadinessClient_(r.client) !== client) return;
      const ym = appInsightReadinessYm_(r.target_month);
      const flag = String(r.actual_closed_flag == null ? '' : r.actual_closed_flag).trim().toLowerCase();
      const ms = appEvidenceMs_(r.source_updated_at);
      const day = ms === null ? '' : Utilities.formatDate(new Date(ms), APP_TZ, 'yyyy-MM-dd');
      const ok = flag !== 'open' && flag !== '0' && appActualClosed_(ym, day);
      closed[ym] = (!Object.prototype.hasOwnProperty.call(closed, ym) || closed[ym]) && ok;
    });
    const closedMonths = Object.keys(closed).filter(ym => closed[ym]);
    counts.closedActualMonths = closedMonths.length;
    const fy = Number(boot.setup.fy);
    if (Number.isInteger(fy) && fy >= 1900 && fy <= 9999) counts.closedCurrentFyMonths = closedMonths.filter(ym => {
      const year = Number(ym.slice(0, 4)), month = Number(ym.slice(5));
      return (month >= 4 ? year : year - 1) === fy;
    }).length;

    // Legacy readCurrentEvalMonths_ の client一致・neutral・現policy・締まった実績の条件を保つ。
    const current = {}, eligible = {};
    let oldPolicyNeutralRows = 0;
    tables.EVAL_LOG.forEach(r => {
      if (appInsightReadinessClient_(r.client) !== client || String(r.scenario || '') !== 'neutral') return;
      const ym = appInsightReadinessYm_(r.target_month);
      if (String(r.evaluation_policy_version || '').trim() !== APP_EVAL_POLICY_VERSION) { oldPolicyNeutralRows++; return; }
      current[ym] = true;
      if (closed[ym]) eligible[ym] = true;
    });
    counts.currentPolicyNeutralMonths = Object.keys(current).length;
    counts.oldPolicyNeutralRows = oldPolicyNeutralRows;
    counts.eligibleMonths = Object.keys(eligible).length;

    const candidates = tables.EVAL_INSIGHTS.filter(r => {
      if (!String(r.evaluated_at || '').trim() && !String(r.target_month || '').trim()) return false;
      return !!eligible[appInsightReadinessYm_(r.target_month)];
    });
    if (counts.legacyVisibleRows === null) counts.legacyVisibleRows = candidates.length;
    // DropStale の元表に存在しない月や行を、診断だけで補ってはいけない。
    if (beforeInsights && beforeInsights.length !== candidates.length) return result;
    const candidateRows = {}; candidates.forEach(r => { candidateRows[r.__row] = true; });
    const hasRow = r => r && Number.isInteger(Number(r.row)) && !!candidateRows[Number(r.row)];
    if ((beforeInsights && !beforeInsights.every(hasRow)) || !boot.eval.insights.every(hasRow)) return result;
    if (counts.displayedRows > counts.legacyVisibleRows) return result;

    const scored = {};
    tables.EVAL_LOG.forEach(r => {
      if (String(r.scenario || '').trim() !== 'neutral' || String(r.evaluation_policy_version || '').trim() !== APP_EVAL_POLICY_VERSION) return;
      scored[appInsightReadinessYm_(r.target_month)] = appInsightB4View_(r.pred, r.actual);
    });
    const since = appEvalPolicySince_(tables.EVAL_LOG, tables.RUN_LOG);
    counts.staleTimeRows = 0; counts.mismatchedValueRows = 0;
    candidates.forEach(r => {
      const ym = appInsightReadinessYm_(r.target_month), at = appEvidenceMs_(r.evaluated_at);
      if (appInsightRowScored_(scored, ym, r.pred_p50, r.actual_total, r.evaluated_at, since)) return;
      if (typeof since !== 'number' || at === null || at < since) counts.staleTimeRows++;
      else counts.mismatchedValueRows++;
    });

    if (counts.displayedRows > 0) return finish('READY');
    if (!counts.actualRows) return finish('NO_ACTUALS');
    if (!counts.currentPolicyNeutralMonths && counts.oldPolicyNeutralRows) return finish('OLD_POLICY');
    if (!counts.closedActualMonths) return finish('NO_CLOSED_ACTUALS');
    if (!counts.eligibleMonths) return finish('NO_CURRENT_EVAL');
    if (!counts.legacyVisibleRows) return finish('INSIGHTS_MISSING');
    if (counts.staleTimeRows || counts.mismatchedValueRows) return finish('INSIGHTS_STALE');
    return result;
  } catch (e) {
    // 読めなかった表・値の内容は外へ返さない。未確認を0件や特定の理由へ置き換えない。
    Logger.log('人の記入の準備状態: 記録を確認できませんでした');
    return finish('UNKNOWN');
  }
}

/** 同じ読むだけのブックから各表を一度だけ読む。必須見出しの欠落・重複は不明として止める。 */
function appInsightReadinessTable_(book, name) {
  const sh = book.getSheetByName(name);
  if (!sh) return null;
  const values = sh.getDataRange().getValues();
  const required = APP_ENGINE_SHEETS[name] && APP_ENGINE_SHEETS[name].header;
  if (!required || !Array.isArray(values) || !values.length || !Array.isArray(values[0])) throw new Error('READINESS_HEADER');
  const head = values[0].map(v => String(v == null ? '' : v).trim());
  required.forEach(h => { if (head.filter(v => v === h).length !== 1) throw new Error('READINESS_HEADER'); });
  return values.slice(1).map((row, i) => {
    if (!Array.isArray(row)) throw new Error('READINESS_ROW');
    if (!row.some(v => v !== '' && v !== null && v !== undefined)) return null;
    const out = { __row: i + 2 };
    required.forEach(h => { out[h] = row[head.indexOf(h)]; });
    return out;
  }).filter(Boolean);
}

/** Legacy normalizeClientName_/isSameClient_ と同じ別名だけをそろえる（表示名への正規化はしない）。 */
function appInsightReadinessClient_(value) {
  const text = String(value || '').trim();
  return text === 'ｳﾞｨｱﾄﾘｽ製薬(株)' || text === 'ｳﾞｨｱﾄﾘｽ製薬合同会社' ? 'ｳﾞｨｱﾄﾘｽ製薬' : text;
}

/** 読めない月を「対象なし」と断定しない。普通の月表記とDate以外はUNKNOWNへ戻す。 */
function appInsightReadinessYm_(value) {
  const ym = appYm_(value);
  if (!/^\d{4}\/(0[1-9]|1[0-2])$/.test(ym)) throw new Error('READINESS_MONTH');
  return ym;
}

/** 最後に成功した処理の時刻だけ。読めない時刻や人が書いた文字列を、そのまま返さない。 */
function appInsightReadinessLast_(rows, name) {
  let latest = null;
  rows.forEach(r => {
    if (String(r.function_name || '').trim() !== name || String(r.status || '').trim().toLowerCase() !== 'success') return;
    const ms = appEvidenceMs_(r.run_at);
    if (ms === null) throw new Error('READINESS_TIME');
    if (latest === null || ms > latest) latest = ms;
  });
  return latest === null ? null : new Date(latest).toISOString();
}
