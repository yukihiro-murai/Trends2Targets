/**
 * Ai.js — A-4 AI 調査の、Vertex AI への問い合わせ。
 *
 * 旧来の A-4（runVertexAIResearch）は、4 つの話題ごとに Vertex AI へ 3〜5 回ずつ問い合わせ、全部で 6 分を超えることがある。
 * 旧来の計算は変えられないので、旧来の UrlFetchApp の代わりにこの道具を渡す:
 *   - 受け取った答えは、その回（actionId）の控えとしてキャッシュに置く
 *   - 時間の区切り（APP_AI_CALC_BUDGET_MS）を過ぎたら、新しい問い合わせはせずに止める（旧来の側は失敗として先へ進むが、その結果は使わない）
 *   - 計算用ブックを組み立て直してもう一度動かすと、同じ問い合わせは控えから答える（時刻と乱数は固定なので、問い合わせの中身も同じになる）
 * 問い合わせ先は Vertex AI（aiplatform）と Vertex AI Search（discoveryengine）だけ。
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

/** 旧来の UrlFetchApp.fetch の代わり。fetch(url, options) と、止めたかどうか・回数を返す */
function appAiFetcher_(actionId, deadlineMs) {
  const st = { hits: 0, live: 0, retries: 0, stopped: false };
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
    if (saved.found) { st.hits++; note(url, saved.value.code, saved.value.text); return response(saved.value.code, saved.value.text); }
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
    if (code !== 429 && code < 500) appJobPutResult_(key, { code: code, text: text });
    note(url, code, text);
    return response(code, text);
  };
  return { fetch: fetch, stopped: () => st.stopped, failures: () => log.slice(),
    stats: () => ({ hits: st.hits, live: st.live, retries: st.retries, stopped: st.stopped, failed: log.length }) };
}
