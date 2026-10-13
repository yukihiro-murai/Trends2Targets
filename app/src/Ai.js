/**
 * Ai.js — A-4 AI 調査の、Vertex AI への問い合わせ。
 *
 * 旧来の A-4（runVertexAIResearch）は、4 つの話題ごとに Vertex AI へ 3〜5 回ずつ問い合わせ、全部で 6 分を超えることがある。
 * 旧来の計算は変えられないので、旧来の UrlFetchApp の代わりにこの道具を渡す:
 *   - 受け取った答えは、その回（actionId）の控えとしてキャッシュに置く
 *   - 時間の区切り（APP_AI_CALC_BUDGET_MS）を過ぎたら、新しい問い合わせはせずに止める（旧来の側は失敗として先へ進むが、その結果は使わない）
 *   - 計算用ブックを組み立て直してもう一度動かすと、同じ問い合わせは控えから答える（時刻と乱数は固定なので、問い合わせの中身も同じになる）
 * 問い合わせ先は Vertex AI（aiplatform）と Vertex AI Search（discoveryengine）だけ。
 *
 * 守り（2026-10-13 の点検。村井さん承認）:
 *   - 保存の前の確かめ（appAiCheckBeforeSave_）: 計算用ブックの AI_RESEARCH・AI_RESEARCH_STRUCTURED に数式が 1 つでもあれば保存しない
 *     （旧来の側でも AI の文を文字として書く。二重の守り）。時間の区切りで止まっていないのに問い合わせが失敗し、4 つの話題のどれかが
 *     欠けたときも保存しない（前の結果を残す。自動の調べは失敗として数え、次の晩に試し直す）
 *   - 手で始める A-4 は計画ごとに 1 日 3 回まで（appAiManualCheck_。自動の調べは AutoResearch.js の上限で数える）
 *   - 同じ計画の A-4 が 6 時間以内に失敗・途中で止まったときは、その回（actionId と時刻）を引き継ぎ、控えた答えを使う（appAiRunStart_）。
 *     引き継いだ回では、前に控えた失敗の答え（2xx 以外）は使わずに問い合わせ直す（権限を直した後も前の 403 を返さない）
 */
const APP_AI_CALC_BUDGET_MS = 3 * 60 * 1000;   // 1 回の計算で新しく問い合わせてよい時間（1 回の問い合わせに 1 分ほどかかっても 6 分に収まる）
/** 区切りの時刻（テストで差し替える） */
function appAiDeadline_(startMs) { return startMs + APP_AI_CALC_BUDGET_MS; }
const APP_AI_MAX_ATTEMPTS = 12;               // 組み立て直して動かす回数の上限
/**
 * 一時的な失敗（混み合いの 429・Google 側の 5xx・通信の例外）のとき、待ってから同じ問い合わせをし直す間隔（2 回まで）。
 * 待つと時間の区切りを過ぎるときは、し直さない（今までどおり失敗の答えを返す）。旧来の計算の中の待ち（Utilities.sleep）は止めてあるので、ここで待つ
 */
const APP_AI_RETRY_WAITS_MS = [2000, 6000];
/** 待つ（テストで差し替える） */
function appAiWait_(ms) { Utilities.sleep(ms); }
const APP_AI_ALLOWED_URL = /^https:\/\/([a-z0-9-]+-)?(aiplatform|discoveryengine)\.googleapis\.com\//;

/** 許可を求めるだけ（UrlFetchApp.getRequest は問い合わせない）。エディタから実行すると、足りない許可の画面が出る */
function appAuthorizeAi_(ctx) {
  // 一部の許可だけを出した状態（項目ごとの同意）だと、エディタは足りない許可を自動では求めない。requireScopes で許可の画面を出させる
  ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, ['https://www.googleapis.com/auth/script.external_request', 'https://www.googleapis.com/auth/cloud-platform']);
  UrlFetchApp.getRequest('https://aiplatform.googleapis.com/');
  ScriptApp.getOAuthToken();
  return { ok: true, message: 'A-4 AI 調査の許可があります。' };
}

/**
 * 旧来の UrlFetchApp.fetch の代わり。fetch(url, options) と、止めたかどうか・回数を返す。
 * freshAfterMs（前の回を引き継いだときの、引き継いだ時刻）: それより前に控えた失敗の答え（2xx 以外）は使わずに問い合わせ直す
 */
function appAiFetcher_(actionId, deadlineMs, freshAfterMs) {
  const st = { hits: 0, live: 0, retries: 0, stopped: false };
  const fresh = Number(freshAfterMs || 0);
  const usable = v => !fresh || (v.code >= 200 && v.code < 300) || Number(v.at || 0) >= fresh;
  const log = [];   // 失敗した問い合わせ（先・番号・理由の頭）。旧来の A-4 は理由をデータ本体に移さないシートに書くので、エラーの文に出すため
  const note = (url, code, text) => {
    if (code >= 200 && code < 300) return;
    let msg = String(text || '');
    try { const j = JSON.parse(msg); msg = (j.error && (j.error.status + ' ' + j.error.message)) || msg; } catch (e) { /* 文のまま */ }
    const u = url.split('?')[0].replace(/^https:\/\//, '').split('/');
    const line = u[0] + ' … ' + u[u.length - 1] + ' → ' + code + ' ' + msg.replace(/\s+/g, ' ').slice(0, 160);
    if (log.indexOf(line) < 0) log.push(line);   // 同じ失敗は 1 行
  };
  const response = (code, text) => ({
    getResponseCode: () => code,
    getContentText: () => text,
    getHeaders: () => ({})
  });
  const fetch = (url, options) => {
    url = String(url || '');
    if (!APP_AI_ALLOWED_URL.test(url)) throw new Error('Vertex AI 以外へは問い合わせません: ' + url.split('?')[0].slice(0, 80));
    const body = options && options.payload !== undefined ? String(options.payload) : '';
    const key = 'AIF_' + appSha256Hex_(String(actionId) + '\n' + url + '\n' + body).slice(0, 40);
    const saved = appJobGetResult_(key);
    if (saved.found && usable(saved.value)) { st.hits++; note(url, saved.value.code, saved.value.text); return response(saved.value.code, saved.value.text); }
    if (st.stopped || (st.live > 0 && new Date().getTime() > deadlineMs)) {   // 1 回に 1 つは必ず問い合わせる（必ず先へ進む）
      st.stopped = true;
      throw new Error('時間の区切りのため、続きは次の回に問い合わせます。');
    }
    st.live++;
    let code, text;
    for (let i = 0; ; i++) {
      let err = null;
      try { const res = UrlFetchApp.fetch(url, options); code = res.getResponseCode(); text = res.getContentText() || ''; } catch (e) { err = e; }
      const wait = APP_AI_RETRY_WAITS_MS[i];
      const retry = (err || code === 429 || code >= 500) && wait !== undefined && new Date().getTime() + wait <= deadlineMs;
      if (retry) { st.retries++; appAiWait_(wait); continue; }
      if (err) {
        const line = url.replace(/^https:\/\//, '').split('/')[0] + ' → ' + String(err && err.message ? err.message : err).slice(0, 200);
        if (log.indexOf(line) < 0) log.push(line);   // 同じ失敗は 1 行
        throw err;
      }
      break;
    }
    // 一時的な失敗（混み合い・Google 側のエラー）は控えない（次の回にもう一度問い合わせる）
    if (code !== 429 && code < 500) appJobPutResult_(key, { code: code, text: text, at: new Date().getTime() });
    note(url, code, text);
    return response(code, text);
  };
  return { fetch: fetch, stopped: () => st.stopped, failures: () => log.slice(),
    stats: () => ({ hits: st.hits, live: st.live, retries: st.retries, stopped: st.stopped, failed: log.length }) };
}

// ---- 保存の前の確かめ（数式・欠けた話題） ----

/** 4 つの話題（旧来の AI_TOPICS）と画面の名前 */
const APP_AI_TOPIC_NAMES = { Market: '市場', Competitor: '競合', Channel: '販路', DX: 'DX' };
/** 話題が欠けて保存しなかったときのエラーの文の印（AutoResearch.js が「次の晩に試し直す失敗」として見分ける） */
const APP_AI_TOPICS_MISSING = 'を調べられませんでした。前の結果を残しました。';
/** AI の文を書くシート（旧来の A-4 が毎回書き直す。数式が 1 つでもあれば保存しない） */
const APP_AI_TEXT_SHEETS = ['AI_RESEARCH', 'AI_RESEARCH_STRUCTURED'];

/**
 * A-4 の計算の後・保存の前（Plan.js の appPlanRunCalc_。時間の区切りで止まっていないとき）。保存してはいけなければ止める:
 *   1. 計算用ブックの AI_RESEARCH・AI_RESEARCH_STRUCTURED に数式が 1 つでもある（旧来の側で文字として書くようにした上での二重の守り）
 *   2. 問い合わせの失敗があり、AI_RESEARCH_STRUCTURED に 4 つの話題のどれかが無い（一時的な失敗で欠けた話題を「中立」として
 *      残した話題だけで書き直さない。前の結果を残す）
 * 止めたときは何も書かない（計算用ブックは途中のまま。次の操作で組み立て直す）
 */
function appAiCheckBeforeSave_(scratch, fetcher) {
  const formulas = appAiFormulaCells_(scratch);
  if (formulas.length) {
    Logger.log('A-4 の答えの数式のセル: ' + formulas.slice(0, 20).join(', '));
    throw new Error('AI 調査の答えに、表の数式として動いてしまう文がありました（' + formulas.length + ' か所）。安全のため保存せずに止め、前の結果を残しました。');
  }
  const f = fetcher ? fetcher.failures() : [];
  if (!f.length || fetcher.stopped()) return;
  const missing = appAiMissingTopics_(scratch);
  if (!missing.length) return;
  throw new Error('（' + missing.map(t => APP_AI_TOPIC_NAMES[t]).join('・') + '）' + APP_AI_TOPICS_MISSING + '少し待ってから、もう一度調べてください。\n' +
    '問い合わせの失敗（' + f.length + ' 件）:\n' + f.slice(0, 6).join('\n'));
}

/** AI の文を書くシートの数式のセル（シート名!A1 の一覧） */
function appAiFormulaCells_(scratch) {
  const out = [];
  APP_AI_TEXT_SHEETS.forEach(name => {
    const sh = scratch.getSheetByName(name);
    if (!sh || sh.getLastRow() < 1 || sh.getLastColumn() < 1) return;
    sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getFormulas().forEach((row, r) => row.forEach((x, c) => { if (x) out.push(name + '!' + appA1_(r, c)); }));
  });
  return out;
}

/** AI_RESEARCH_STRUCTURED に 1 行も無い話題（Market・Competitor・Channel・DX の順） */
function appAiMissingTopics_(scratch) {
  const sh = scratch.getSheetByName('AI_RESEARCH_STRUCTURED');
  const have = {};
  if (sh && sh.getLastRow() >= 2 && sh.getLastColumn() >= 1) {
    const vals = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
    const c = vals[0].map(h => String(h).trim()).indexOf('topic');
    if (c >= 0) vals.slice(1).forEach(r => { have[String(r[c]).trim()] = true; });
  }
  return Object.keys(APP_AI_TOPIC_NAMES).filter(t => !have[t]);
}

// ---- 手で始める回数の上限・前の回の引き継ぎ ----

const APP_AI_MANUAL_PROP = 'APP_AI_MANUAL';   // 手で始めた回数（Script Properties。{ date: 日本の日付, counts: { 計画|操作: 回数 } }。その日の分だけ持つ）
const APP_AI_RUN_KEY = 'AIRUN_';              // 計画ごとの、最後に始めた A-4 の回（CacheService。6 時間。{ actionId, asOfMs }）
const APP_AI_RESUME_MS = 6 * 3600 * 1000;     // 引き継げるのは、前の回を始めてから 6 時間まで（控えた答えの保存期間と同じ）

/**
 * 手で始める操作の 1 日の回数の上限（APP_PLAN_ACTIONS の manualPerDay。A-4 は計画ごとに 1 日 3 回）。appStartJob_ のロックの中で呼ぶ。
 * 自動の調べ（opts.auto。AutoResearch.js）は数えない。上限に達していれば断る文を投げる。
 * 数えるものなら、待ち行列に入れた後に呼ぶ関数（1 回足す）を返す。数えないものは null
 */
function appAiManualCheck_(kind, payload, opts) {
  if (kind !== 'PLAN.RUN' || (opts && opts.auto)) return null;
  const action = String(payload && payload.action || '');
  const a = Object.prototype.hasOwnProperty.call(APP_PLAN_ACTIONS, action) ? APP_PLAN_ACTIONS[action] : null;
  const limit = a ? Number(a.manualPerDay || 0) : 0;
  if (!limit) return null;
  const today = appToday_();
  let st = null;
  try { st = JSON.parse(appProps_().getProperty(APP_AI_MANUAL_PROP) || 'null'); } catch (e) { st = null; }
  if (!st || st.date !== today || !st.counts || typeof st.counts !== 'object') st = { date: today, counts: {} };
  const key = String(payload.planId || '') + '|' + action;
  if (Number(st.counts[key] || 0) >= limit) {
    throw new Error('この計画の市場の調査は、今日はもう ' + limit + ' 回始めました。費用がかかるので、手で始めるのは 1 日 ' + limit + ' 回までです。明日またお試しください。');
  }
  return () => {
    st.counts[key] = Number(st.counts[key] || 0) + 1;
    appProps_().setProperty(APP_AI_MANUAL_PROP, JSON.stringify(st));
  };
}

/**
 * A-4 を始めるとき（Plan.js の appPlanRunBuild_ の最初の段）の回の番号（actionId）と時刻（asOfMs）。
 * 同じ計画の前の A-4 を 6 時間以内に始めていて、その回が保存まで終わっていなければ（失敗・途中で止まった）、その回を引き継ぐ:
 * 番号と時刻が同じなので問い合わせの中身も同じになり、控えた答え（6 時間）を使える（同じ問い合わせにもう一度費用をかけない）。
 * 引き継いだときは freshAfterMs = 今（それより前に控えた失敗の答えは使わず、問い合わせ直す）。
 * 引き継がないときは新しい回を始め、控えに置く。控えを読めない・書けないときは新しい回にする（引き継がないだけ）
 */
function appAiRunStart_(planId, nowMs) {
  const key = APP_AI_RUN_KEY + planId;
  let prev = null;
  try { const r = appJobGetResult_(key); prev = r.found ? r.value : null; } catch (e) { prev = null; }
  const age = prev ? nowMs - Number(prev.asOfMs) : NaN;
  if (prev && prev.actionId && age >= 0 && age <= APP_AI_RESUME_MS && !appReadTable_('PLAN_ACTIONS').some(r => r.action_id === String(prev.actionId))) {
    return { actionId: String(prev.actionId), asOfMs: Number(prev.asOfMs), freshAfterMs: nowMs, resumed: true };
  }
  const run = { actionId: appId_('ACT'), asOfMs: nowMs };
  try { appJobPutResult_(key, run); } catch (e) { Logger.log('A-4 の回を控えられません（引き継ぎはしない）: ' + (e && e.message ? e.message : e)); }
  return { actionId: run.actionId, asOfMs: nowMs, freshAfterMs: 0, resumed: false };
}
