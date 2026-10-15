/**
 * Bulk.js — 全部の計画をまとめて動かす（所有者の runForecastAll・runBacktestAll。2026-10-15 村井さん「全部の計画で予測を実行して」「物差しを計画ごとに動かし直して」）。
 * 裏の処理は同時に 1 つなので、1 つの計画の処理（予測 = 組み立て → 計算 → 保存、物差し = 組み立て → 計算と保存）が終わるたびに、次の計画の処理を始める
 * （Jobs.js の appRunJob_ の終わりから appBulkAfterJob_）。失敗した計画・予測の前の確認（影響が大きい入力）が要る計画も、記録して次へ進む
 * （確認は勝手にしない。画面から確かめて実行する）。予測の後に物差しも頼まれていれば、予測が全部終わってから物差しを同じように回す。
 * 状態は所有者の UserProperties の APP_BULK_STATE（appProps_）に 1 つだけ持つ: { active, mode（FORECAST・BACKTEST）, then, fy, queue, current, done, forecastDone, ... }。
 * 計算・保存先・権限は、1 計画ずつ動かすときと同じ（同じ処理を同じ入口の決まりで始める）。
 */

const APP_BULK_PROP = 'APP_BULK_STATE';
/** 処理の種類 → まとめて動かす単位の処理（最初の段） */
const APP_BULK_ROOT = { 'FORECAST.RUN': 'FORECAST.RUN', 'FORECAST.RUN_CALC': 'FORECAST.RUN', 'FORECAST.RUN_SAVE': 'FORECAST.RUN',
  'MEASURE.BACKTEST': 'MEASURE.BACKTEST', 'MEASURE.BACKTEST_CALC': 'MEASURE.BACKTEST' };
const APP_BULK_KIND = { FORECAST: 'FORECAST.RUN', BACKTEST: 'MEASURE.BACKTEST' };
/** 動いている印のまま、今の計画の処理がこれより長く止まっていれば、新しく始めてよい（止まった鎖） */
const APP_BULK_STALE_MS = 60 * 60 * 1000;

function appBulkState_() {
  try {
    const st = JSON.parse(appProps_().getProperty(APP_BULK_PROP) || '{}');
    return st && typeof st === 'object' ? st : {};
  } catch (e) {
    return {};
  }
}
function appBulkSave_(st) { appProps_().setProperty(APP_BULK_PROP, JSON.stringify(st)); }

/**
 * まとめて動かす計画の ID の並び: 年度 fy（省くと今の年度）の、片付けていない・売上を取り込んだ・年度を締めていない計画（メーカーの名前の順。測る専用の計画も入れる）
 */
function appBulkQueue_(fy) {
  const y = fy === undefined || fy === null || fy === '' ? appFy_(new Date()) : Number(fy);
  return appReadTable_('PLANS').filter(p => String(p.fy) === String(y) && p.state !== 'ARCHIVED')
    .filter(p => { try { appRequireOpenPlan_(p.plan_id); return !!appBacktestImportDays_(p.plan_id).sales; } catch (e) { return false; } })
    .sort((a, b) => String(a.client_label || '').localeCompare(String(b.client_label || '')) || String(a.plan_id).localeCompare(String(b.plan_id)))
    .map(p => p.plan_id);
}

/** 計画の名前（PLANS の client_label。記録を読みやすく） */
function appBulkName_(planId) {
  const p = appReadTable_('PLANS').filter(x => x.plan_id === planId)[0];
  return p ? String(p.client_label || '') : '';
}

/** 今の計画の処理を始める（所有者が始めたときは画面と同じ入口 appStartJob_、続きはその場で待ち行列に入れる。移行待ちなら断る） */
function appBulkStartPlan_(ctx, st, planId) {
  const kind = APP_BULK_KIND[st.mode];
  const now = new Date().toISOString();
  if (ctx) {
    const r = appStartJob_(ctx, { kind: kind, payload: { planId: planId } });
    st.current = { planId: planId, jobId: r.jobId, startedAt: now };
    return;
  }
  const refused = appV10WaitRefusal_(kind, { planId: planId });   // 表の版の移行がバックアップを待っている間は、予測を始めない（画面と同じ）
  if (refused) throw new Error(refused);
  const j = appWithLock_(() => appEnqueueJob_(kind, { planId: planId }, st.requestedBy, ''));   // 前の計画の続きにしない（最初の段をたどって今の計画の処理かを確かめるため）
  st.current = { planId: planId, jobId: j.id, startedAt: now };
}

/** 済んだ計画の記録を 1 件足す */
function appBulkNote_(st, planId, status, error) {
  st.done = (st.done || []).concat([{ planId: planId, name: appBulkName_(planId), at: new Date().toISOString(), status: status, error: String(error || '').slice(0, 160) }]);
}

/**
 * 次の計画を始める（残りが無ければ、予測の後の物差しへ・終わり）。始められなかった計画は FAILED として記録して、その次へ進む（鎖を止めない）。
 * 状態は呼んだ側が保存する
 */
function appBulkAdvance_(st) {
  for (let guard = 0; guard < 500; guard++) {
    if (!(st.queue || []).length && st.then === 'BACKTEST') {
      st.forecastDone = st.done;
      st.done = [];
      st.mode = 'BACKTEST';
      st.then = '';
      st.queue = appBulkQueue_(st.fy);
    }
    if (!(st.queue || []).length) {
      st.active = false;
      st.current = null;
      st.finishedAt = new Date().toISOString();
      return;
    }
    const next = st.queue.shift();
    try {
      appBulkStartPlan_(null, st, next);
      return;
    } catch (e) {
      appBulkNote_(st, next, 'FAILED', '始められませんでした: ' + String(e && e.message ? e.message : e));
    }
  }
}

/** 処理の最初の段の ID（続きの段は parentId をたどる） */
function appBulkRootId_(job) {
  let cur = job;
  for (let k = 0; k < 20 && cur && cur.parentId; k++) cur = appJobGet_(cur.parentId) || null;
  return cur ? cur.id : '';
}

/**
 * 始める（所有者の操作）。mode = FORECAST・BACKTEST、then = 予測の後に物差しも回すか。
 * まとめて動かしている途中なら断る。ただし今の計画の処理が終わっている（失敗・時間切れで次へ進めなかった）か、1 時間より長く止まっていれば、
 * 止まった鎖として新しく始める
 */
function appBulkStart_(ctx, mode, fy, then) {
  const cur = appBulkState_();
  if (cur.active && cur.current && !appBulkStuck_(cur)) {
    throw new Error('全部の計画をまとめて動かしている途中です（' + (cur.mode === 'FORECAST' ? '予測' : '物差し') + '・残り ' + (cur.queue || []).length + ' 計画）。終わってから始めてください。');
  }
  const y = fy === undefined || fy === null || fy === '' ? appFy_(new Date()) : Number(fy);
  const q = appBulkQueue_(y);
  if (!q.length) throw new Error('動かせる計画がありません（片付けていない・売上を取り込んだ・年度を締めていない計画）。');
  const st = { active: true, mode: mode, then: then && mode === 'FORECAST' ? 'BACKTEST' : '', fy: y, queue: q.slice(1), done: [], forecastDone: null,
    requestedBy: ctx.actor, startedAt: new Date().toISOString(), finishedAt: '' };
  appBulkStartPlan_(ctx, st, q[0]);
  appBulkSave_(st);
  return { mode: mode, fy: y, plans: q.length, first: { planId: q[0], name: appBulkName_(q[0]), jobId: st.current.jobId }, then: st.then,
    hint: '1 計画ずつ順に動かします。様子は {"action":"bulkStatus"} で分かります' };
}

/**
 * 止まった鎖か: 今の計画の処理（続きの段の最後）が、もう動いていない（DONE・FAILED で次へ進んだ記録が無い）か、1 時間より長くたっている。
 * 待ち行列で 15 分たって失敗にされた処理（appExpireQueuedJobs_）は、終わりのフックを通らないので、ここで見つける
 */
function appBulkStuck_(st) {
  if (!st.active || !st.current) return false;
  if (new Date().getTime() - Date.parse(st.current.startedAt || 0) >= APP_BULK_STALE_MS) return true;
  let j = appJobGet_(st.current.jobId);
  for (let k = 0; k < 20 && j && j.nextJobId; k++) j = appJobGet_(j.nextJobId);
  return !!j && (j.status === 'DONE' || j.status === 'FAILED');
}

/**
 * 裏の処理が終わったとき（続きの段が無いとき）: まとめて動かしている今の計画の処理なら、結果を記録して次の計画を始める。
 * 今の計画の処理かは、続きの段をたどった最初の段の ID で確かめる（同じ計画を手で動かした処理と取り違えない）。
 * job = 終わった処理の記録（payload は画面に要る項目だけ）、status = DONE・FAILED
 */
function appBulkAfterJob_(job, status) {
  if (!job || job.nextJobId) return null;
  const st = appBulkState_();
  if (!st.active || !st.current) return null;
  if (APP_BULK_ROOT[job.kind] !== APP_BULK_KIND[st.mode] || appBulkRootId_(job) !== st.current.jobId) return null;
  let needConfirm = null;
  if (status === 'DONE') { try { const r = appJobGetResult_(job.id); needConfirm = r.found && r.value && r.value.needConfirm ? r.value.needConfirm : null; } catch (e) { needConfirm = null; } }
  appBulkNote_(st, st.current.planId, status === 'FAILED' ? 'FAILED' : needConfirm ? 'CONFIRM' : 'DONE', job.error || (needConfirm && needConfirm.message) || '');
  try {
    appBulkAdvance_(st);
  } finally {
    appBulkSave_(st);   // 次を始められなくても、記録と状態は必ず残す
  }
  appRunLog_({ requestId: job.id, kind: 'BULK.NEXT', status: 'OK', detail: { mode: st.mode, active: st.active, done: st.done.length, remaining: (st.queue || []).length,
    next: st.current ? st.current.planId : '' } });
  return st;
}

/** 様子（所有者の bulkStatus）: 動いているか・今の計画・残り・済んだ計画と結果（予測の後に物差しを回したときは、予測の結果も） */
function appBulkStatus_() {
  const st = appBulkState_();
  if (!st.mode) return { active: false, note: 'まだ一度も、まとめて動かしていません。' };
  const count = xs => (xs || []).reduce((o, x) => { o[x.status] = (o[x.status] || 0) + 1; return o; }, {});
  return { active: !!st.active, mode: st.mode, fy: st.fy, current: st.current ? Object.assign({ name: appBulkName_(st.current.planId) }, st.current) : null,
    remaining: (st.queue || []).length, then: st.then || '', done: st.done || [], counts: count(st.done), forecastDone: st.forecastDone || null,
    forecastCounts: st.forecastDone ? count(st.forecastDone) : null, startedAt: st.startedAt, finishedAt: st.finishedAt || '' };
}
