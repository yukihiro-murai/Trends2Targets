/***************************************
 * Forecast Agent v8 track / multiclient-template（VERSION 2.3.49-dev / BUILD_STAGE output-nav-polish）
 * 単一メーカー（1クライアント）用 / Google Sheets 実装
 *
 * 現行反映:
 * - DLM_ENGINE_MODE（off/shadow/primary）でBASEエンジンを制御
 * - primary時のみDLMをBASEへ反映、off/shadowは従来挙動を維持
 * - 主観入力は月次cap内でそのまま反映（overlay率ターゲット探索は撤去）
 * - AI / SPOT / biasCorrection / TSV経路は従来どおり維持
 * - v1.9: POOL_PRIOR クライアント横断集約（中央集約book + fan-out / 手動）
 * - 学習ループ修正: AI_IMPACT_HISTORY / SUBJECTIVE_IMPACT_HISTORY に forecast_source を追加。
 *   C-1集計は forecast_open の最新run_atのみ採用し、A-9再実行でnが膨張せず、closed月のsurprise=0脱落も防止
 * - kProd全月1.0は throw せず警告（productWeightWarning / RUN_LOG）に変更（履歴なし製品でもA-9完走）
 * - 通年予測モード: FORECAST_CLOSED_MONTH_MODE（actual=実績上書き / forecast=通年予測）。既定 actual で従来挙動
 ***************************************/

const VERSION = '2.4.0-dev';
const BUILD_STAGE = 'bayesian-autolearn-vertex-hybrid';
const MENU_NAME = 'Forecast Agent';
// v2（2026-10-04）: 実績の締まった月の記録（予測 = 実績）は検証に使わない。P10/P90 はクライアントごとに引く
// v3（2026-10-07 村井さん承認 D4〜D6）: 締まった月だけを、その月が始まる前の最後の予測で測る。
//   B-3・B-4・B-5・C-1 は、この版で書いた EVAL_LOG の行だけを使う（前の版の行は消さずに残るが、締まっていない月や後から作った予測で測っているので使わない）
const EVALUATION_POLICY_VERSION = 'policy-2026H1-v3';
// 実績の締まり（D5）: 月末から ACTUAL_CLOSE_LAG_DAYS 日たってから取り込んだ（B-1）月だけが締まった月（月末 + 5 日 <= 取り込んだ日）。
// 新アプリも同じ数を使う（app/tests の検証の決まりのテストで、両方の数がそろっているかを確かめる）
const ACTUAL_CLOSE_LAG_DAYS = 5;
// 締まりと「月が始まる前の予測か」（D6）は日本の暦で数える（新アプリの APP_TZ と同じ）
const EVAL_CALENDAR_TZ = 'Asia/Tokyo';
const PLAN_POINT_ESTIMATE_ROLE = 'P50';
const RANGE_EXPLANATION_ROLE = 'P10-P90';
const ANNUAL_ABS_ERROR_CONSTRAINT = 0.10;
const HALF_WAPE_CONSTRAINT = 0.12;
const HALF_WAPE_FUTURE_TARGET = 0.10;
const OVERFORECAST_RATE_CONSTRAINT = 0.05;

/***************************************
 * 運用コメント（Phase移行基準・実務ルール）
 *
 * [Phase1 -> Phase2 移行の目安]
 * 1) 最低3か月、月次運用が安定して継続されていること
 *    - A-1/A-2/A-9/B-1/B-2/B-3 の実行漏れがなく、PROCESS_STATUSが継続的に success
 * 2) 精度KPIが最低基準を満たすこと
 *    - 全体sMAPE <= 30%（目安）
 *    - 実測がネガ〜ポジ帯に入る割合 >= 70%（目安）
 * 3) データ品質が担保されること
 *    - SALES_INPUT / ACTUAL_EVAL_MONTHLY の欠損・異常値が許容範囲
 * 4) 現場利用が定着していること
 *    - GUIDEに沿った操作で、担当者が自力運用できる
 *
 * [Phase2で優先的に着手する内容]
 * - 重み更新の高度化（クライアント別最適化）
 * - シミュレーション高度化（分位点回帰との比較導入）
 * - モデル監視（ドリフト検知、エラー分類の定例化）
 *
 * [月次運用ルール（推奨順）]
 * 1) A-2 売上データを取り込み
 * 2) （必要時）A-4 AI調査を取り込む→AI結果貼付
 * 3) A-9 予測実行（単一クライアント）
 * 4) B-3 ダッシュボード更新
 * 5) 実績確定後にB-1検証実績取り込み→B-2予測検証レポート更新
 *
 * [運用時の注意]
 * - 本ツールは「確認→修正→再実行」を前提とする（一発確定しない）
 * - OUTPUTは要点表示、詳細根拠はFORECAST_SNAPSHOTで確認
 * - AI結果は補助情報。形式・値域チェックに通らない情報は反映しない
 * - 初期セットアップは全タブ再作成（既存タブ削除）なので本番時は必ず注意喚起
 * - 重大な仕様変更を行った場合は、GUIDEとCHANGELOG（運用記録）を同時更新
 ***************************************/

const SHEETS = {
  GUIDE: 'GUIDE',
  CONFIG: 'CONFIG',
  SALES_MONTHLY: 'SALES_MONTHLY',
  PRODUCT: 'PRODUCT',
  CLIENT: 'CLIENT',
  OPINIONS: 'OPINIONS',
  DEV_SPOT: 'DEV_SPOT',
  OUTPUT: 'OUTPUT',
  SALES_INPUT: 'SALES_INPUT',
  ACTUAL_EVAL_MONTHLY: 'ACTUAL_EVAL_MONTHLY',
  AI_RESEARCH: 'AI_RESEARCH',
  AI_RESEARCH_STRUCTURED: 'AI_RESEARCH_STRUCTURED',
  AI_RESEARCH_TASK_LOG: 'AI_RESEARCH_TASK_LOG',
  RUN_LOG: 'RUN_LOG',
  FORECAST_SNAPSHOT: 'FORECAST_SNAPSHOT',
  EVAL_LOG: 'EVAL_LOG',
  EVAL_COMPARE_MONTHLY: 'EVAL_COMPARE_MONTHLY',
  EVAL_INSIGHTS: 'EVAL_INSIGHTS',
  PROCESS_STATUS: 'PROCESS_STATUS',
  DASHBOARD: 'DASHBOARD',
  AI_SCORE_HISTORY: 'AI_SCORE_HISTORY',
  AI_IMPACT_HISTORY: 'AI_IMPACT_HISTORY',
  SUBJECTIVE_IMPACT_HISTORY: 'SUBJECTIVE_IMPACT_HISTORY',
  CALIBRATION_STATE: 'CALIBRATION_STATE',
  CALIBRATION_HISTORY: 'CALIBRATION_HISTORY',
  QUARTERLY_REVIEW: 'QUARTERLY_REVIEW',
  QUARTERLY_REVIEW_LOG: 'QUARTERLY_REVIEW_LOG',
  DLM_STATE: 'DLM_STATE',
  SOURCE_RELIABILITY: 'SOURCE_RELIABILITY',
  RELIABILITY_EVIDENCE: 'RELIABILITY_EVIDENCE',
  POOL_PRIOR: 'POOL_PRIOR',
  REGISTRY: 'POOL_REGISTRY',
  POOL_AGGREGATION_LOG: 'POOL_AGGREGATION_LOG',
  LANDING_FORECAST: 'LANDING_FORECAST',
  BACKTEST_REPORT: 'BACKTEST_REPORT',
  AI_RESEARCH_RAW: 'AI_RESEARCH_RAW',
  VERTEX_FORECAST_LOG: 'VERTEX_FORECAST_LOG'
};

// 入力セル背景
const COLOR_OBJECTIVE = '#fff2cc'; // 黄色（客観）
const COLOR_SUBJECTIVE = '#cfe2f3'; // 青色（主観）
const COLOR_MIX_LABEL = '#f4cccc'; // 混合ラベル薄赤
const COLOR_OBJ_LABEL = '#cfe2f3'; // 客観ラベル薄青
const COLOR_HEADER = '#eeeeee';
const COLOR_P50_HILITE = '#fff2cc'; // P50強調（薄黄）
const COLOR_SECTION_SOFT = '#e2f0d9'; // セクション見出し薄緑

// OUTPUTの意味色（表＆グラフ）
const COLOR_NEG = '#f4cccc'; // ネガ薄赤
const COLOR_NEU = '#fff2cc'; // 中立薄黄
const COLOR_POS = '#cfe2f3'; // ポジ薄青
const COLOR_REG = '#5f6368'; // 回帰グレー

const TZ = Session.getScriptTimeZone();

// ===== Webアプリ連携用のUIコンテキスト安全化 =====
// コンテナ（スプレッドシートUI）では従来通り alert/OK_CANCEL を使い、
// doGet/google.script.run など getUi() が使えない実行コンテキストでは例外へ変換する。
// Web側が事前確認済みのキーは WEB_UI_CONFIRMS_ に立ててスキップする。
const WEB_UI_CONFIRMS_ = Object.create(null);

function safeSpreadsheetUi_() {
  try { return SpreadsheetApp.getUi(); } catch (e) { return null; }
}

function alertOrThrow_(title, message) {
  const ui = safeSpreadsheetUi_();
  if (ui) { ui.alert(title, message, ui.ButtonSet.OK); return; }
  throw new Error(title + ': ' + message);
}

function forecastConfirmOrAbort_(title, message, key) {
  if (WEB_UI_CONFIRMS_[key]) return;
  const ui = safeSpreadsheetUi_();
  if (ui) {
    const res = ui.alert(title, message, ui.ButtonSet.OK_CANCEL);
    if (res !== ui.Button.OK) throw new Error('ユーザーが中断しました。');
    return;
  }
  const err = new Error(title + '\n' + message);
  err.webConfirm = { key: key, title: title, message: message };
  throw err;
}

// 外部「実績」集計元スプレッドシートはScript Propertiesで管理する。
// vNextのbootstrap完了までは既存運用を止めないため移行用fallbackを使用し、
// runtime property設定後にfallbackを削除する。
const EXTERNAL_SS_ID_PROPERTY = 'FORECAST_SOURCE_SPREADSHEET_ID';
// 実績ソースの既定のスプレッドシート ID は、公開リポジトリに置かないので空にした（2026-10-13）。新アプリは「設定」の値を渡す（app/src/Engine.js）
const LEGACY_EXTERNAL_SS_ID_FALLBACK = '';
const EXTERNAL_SHEET_PREFIX = '*';
const EXTERNAL_SHEET_SUFFIX = '_actual_value';

// 外部シート列（1-index）
const EXT_COL_CLIENT = 41;        // AO
const EXT_COL_CATEGORY = 50;      // AX（製品名）
const EXT_COL_SERVICE_CATEGORY = 46; // AT（サービスカテゴリ）
const EXT_COL_DATE_PRIMARY = 57;  // BE
const EXT_COL_DATE_SECONDARY = 56;// BD（legacy互換のみ。vNextは使用禁止）
const EXT_COL_AMOUNT = 66;        // BN

// Monte Carlo
const N_SIM = 1000;

// スパイク（単発外れ）をならすための上限/下限（比率）
const SPIKE_CLIP_MIN = 0.70;
const SPIKE_CLIP_MAX = 1.40;

// 「季節性を潰さない」ための：同月の分布で許容する広さ（MAD倍率）
const SEASONAL_MAD_K = 3.0;

// 未確定月補完に使う係数のクリップ（極端な補完を避ける）
const TREND_FACTOR_MIN = 0.85;
const TREND_FACTOR_MAX = 1.15;

// シートの共通列幅（見切れ防止）
const COL_WIDTHS = {
  W_PERSON: 120,
  W_PRODUCT: 220,
  W_MONTH: 150,
  W_STEP: 160,
  W_CONF: 170,
  W_TEXT: 360,
  W_MONEY: 150
};

// チャートの高さ相当の“余白行”目安（重なり防止）
const CHART_HEIGHT_ROWS = 22;
var OUTPUT_RANGE_EXPLAIN_ENABLED = true; // OUTPUTに年度≠月次合算の説明を表示
const OUTPUT_RANGE_EXPLAIN_MAIN_TEXT = [
  '【この表の見方】年度合計と「月の合計」は一致しません（正常です）。',
  '・P50（いちばんありそうな数字）= 月を足せば年になります。',
  '・P10 / P90（下振れ・上振れの幅）= 足せません。12か月が同時に最悪／最良になることはまず無く、良い月と悪い月が打ち消し合うため、年間の幅は月を足したものより狭くなります（年度P10は月次合計より高め、年度P90は低めに出るのが正解）。',
  '※注意：薬価改定・大口クライアントの喪失など「全部の月を一気に動かす」出来事は、このP10〜P90の範囲の外です。その種のリスクは別途シナリオで確認してください。'
].join('\n');
const OUTPUT_RANGE_EXPLAIN_OBJECTIVE_TEXT = '※上と同じ理由で、ここでも年度合計と月の合計は一致しません（正常です）。';
const OUTPUT_RANGE_EXPLAIN_PRIMARY_SHORT_TEXT = '※年度合計と月の合計は一致しません（正常です）。詳しい理由は、この下の月次表の下に記載しています。';

// A-9 実行前の影響度チェック閾値
const STEP_WARN_THRESHOLD = 0.30;   // ±30%
const STEP_STRONG_THRESHOLD = 0.50; // ±50%
const STEP_BLOCK_THRESHOLD = 1.00;  // ±100%
const K_TOTAL_WARN_MIN = 0.70;
const K_TOTAL_WARN_MAX = 1.30;
const K_TOTAL_BLOCK_MIN = 0.50;
const K_TOTAL_BLOCK_MAX = 1.50;

// SPOT背景推定（未知のスポット発生を最低限拾う）
const SPOT_BG_SHRINK = 0.35;      // 履歴同月平均の35%を背景SPOTとして採用（過去SPOT感度を抑制）
const SPOT_BG_FLOOR_RATE = 0.15;  // 履歴同月平均の15%は最低保証
const SPOT_BG_CAP_RATE = 0.20;    // 背景SPOTの上限（BASE予測P50比）
const SPOT_SPIKE_MAD_K = 2.5;     // SPOT再発推定のスパイク判定（MAD倍率 / 巨大スパイクをより厳しく除外）
const KNOWN_SPOT_OFFSET_RATE = 0.60;      // 既知スポットが背景と重複する想定率
const KNOWN_SPOT_BG_SUPPRESS_RATE = 0.50; // 既知スポット命中時の背景抑制率
const QUAL_SUBJECTIVE_MONTHLY_CAP = 0.40;  // 月次cap（quantOpsAfterResidual比）
const QUAL_CALIBRATION_ENABLED = 1;        // 1: 有効 / 0: 無効
const AI_WEIGHT_DEFAULT = 0.0008; // AI重み（既定）
const AI_MAX_ABS_EFFECT = 0.05;   // AI係数の絶対上限（±5%）
const AI_TOPIC_SCORE_ABS_CAP = 50; // 各topic final scoreの絶対上限（±50 / 4軸合計±200 / OUTPUT 17-18行の表示レンジと一致）
const AI_MISSING_CONFIDENCE_DEFAULT = 0.5; // confidence/relative_confidence欠落時の補完既定値（0で不採用＝従来挙動）
const AI_TOPICS = ['Market', 'Competitor', 'Channel', 'DX'];
const AI_MAX_AGE_MONTHS = 6;
const AI_EVENT_DECAY_HALF_LIFE_MONTHS = 3;
const AI_MAD_CLIP_K = 3.0;
const AI_TOTAL_NEUTRAL_THRESHOLD = 0.0; // 0=根拠なき総合中立化(dead-zone)なし（既定）。上限は±3%キャップで担保。>0は根拠ある時のみ設定。
const AI_QUALITY_NEUTRAL_THRESHOLD = 0.25;
const AI_QUALITY_PARTIAL_THRESHOLD = 0.50;
const QUARTERLY_APPROVAL_OPTIONS = ['承認', '却下', '保留'];
const QUARTERLY_APPROVAL_PENDING = '保留';
const POOL_MIN_CLIENTS_DEFAULT = 2;
const RELIABILITY_POOL_SOURCE_TYPES = ['factor_product', 'factor_client', 'opinion', 'ai_topic', 'vertex_forecast'];

// ===== 月次ベイズ自動学習（B-5）のハイパーパラメータ =====
const AUTOLEARN_MIN_EVAL_MONTHS = 3;        // 学習に必要な中立評価月数
const AUTOLEARN_EWMA_HALFLIFE_MONTHS = 4;   // 直近月を重く見るEWMA半減期
const AUTOLEARN_GLOBAL_SHRINK_K = 3;        // 全体バイアス事前精度（有効月単位）
const AUTOLEARN_MONTH_SHRINK_K = 2;         // 暦月別バイアス事前精度
const AUTOLEARN_MAX_GLOBAL_DELTA = 0.05;    // 1回の更新で全体係数が動ける最大幅
const AUTOLEARN_MONTH_BIAS_CAP = 0.20;      // 暦月別バイアス保存上限
const AUTOLEARN_GLOBAL_FACTOR_MIN = 0.75;   // 全体補正係数の下限
const AUTOLEARN_GLOBAL_FACTOR_MAX = 1.25;   // 全体補正係数の上限
const AUTOLEARN_FORECAST_BIAS_CAP = 0.25;   // 予測適用時の暦月バイアス上限
const AUTOLEARN_BACKTEST_MIN_MONTHS = 6;    // カウンターファクト検算に必要な評価月数
const VERTEX_ASSIST_WEIGHT_DEFAULT = 0.5;   // Vertexアシスト既定反映率
const VERTEX_ASSIST_MAX_ADJ = 0.30;         // Vertexアシスト1月あたり調整上限

// ===== v8 STEP2: DLM (log-space structural time series) =====
const DLM_SEASONAL_PERIOD = 12;            // 月次季節
const DLM_STATE_DIM = 2 + (DLM_SEASONAL_PERIOD - 1); // level, trend, seasonal(11) = 13
const DLM_Q_GRID = [1e-4, 1e-3, 1e-2, 1e-1]; // q_level/q_trend/q_seasonal の探索格子（obs比）
const DLM_WARMUP_SKIP = 6;                 // 尤度計算で先頭から無視する観測数（拡散初期化のため）
const DLM_DIFFUSE_VAR = 1e3;               // 初期共分散P0の対角（Infinity禁止・有限の大きい値）
const DLM_Z10 = -1.2815515594;             // 標準正規10%点
const DLM_Z90 =  1.2815515594;             // 標準正規90%点
const DLM_BUILD_STAGE = 'v8-step3c3c-1';

// Seasonal Weighted（48M維持）
var SEASONAL_YEAR_WEIGHT_Y1 = (typeof SEASONAL_YEAR_WEIGHT_Y1 !== 'undefined') ? SEASONAL_YEAR_WEIGHT_Y1 : 0.10; // oldest
var SEASONAL_YEAR_WEIGHT_Y2 = (typeof SEASONAL_YEAR_WEIGHT_Y2 !== 'undefined') ? SEASONAL_YEAR_WEIGHT_Y2 : 0.20;
var SEASONAL_YEAR_WEIGHT_Y3 = (typeof SEASONAL_YEAR_WEIGHT_Y3 !== 'undefined') ? SEASONAL_YEAR_WEIGHT_Y3 : 0.30;
var SEASONAL_YEAR_WEIGHT_Y4 = (typeof SEASONAL_YEAR_WEIGHT_Y4 !== 'undefined') ? SEASONAL_YEAR_WEIGHT_Y4 : 0.40; // newest
const SEASONAL_OPEN_MONTH_WEIGHT_MULT = 0.60;
const SEASONAL_WEIGHTED_MAD_K = 2.5;
const SEASONAL_COMPARE_WARN_THRESHOLD = 0.25;
const SEASONAL_WEIGHTED_TOTAL_EXPLAIN_TEXT = 'Seasonal Weighted Total は、直近4年（48ヶ月）の同月実績を新しい年ほど高い重みで平均した参考推計です。未確定月は補完後系列を使い、BASE推計に Expected Spot（背景SPOT + known spot）を加算しています。';
const RESIDUAL_WARMUP_SKIP_MONTHS = 6;
const RESIDUAL_CLIP_MAD_K = 3.0;
const RESIDUAL_SHRINK_TO_MEDIAN = 0.90;
const RANGE_MONTH_TARGET_LOW = 0.25;
const RANGE_MONTH_TARGET_HIGH = 0.40;
const RANGE_MONTH_WARN = 0.45;
const RANGE_ANNUAL_TARGET_LOW = 0.10;
const RANGE_ANNUAL_TARGET_HIGH = 0.20;
const RANGE_ANNUAL_WARN = 0.25;
const SUBJECTIVE_OVERLAY_TARGET_CENTER = 0.08;
const SUBJECTIVE_OVERLAY_TARGET_LOW = 0.05;
const SUBJECTIVE_OVERLAY_TARGET_HIGH = 0.12;

/**
 * HOW TO TEST (dashboard-menu-to-b)
 * 1) VERSION='2.3.42-dev' / BUILD_STAGE は本ブロック名、DLM_BUILD_STAGE 不変。
 * 2) book を開き直す → Forecast Agent メニューの A 群が A-1〜A-9 で終わり、
 *    旧ダッシュボード項目が A 群に無いこと。
 * 3) B 群が 実績取込 / 検証レポート / ダッシュボード更新 / 検証インサイト の順で、
 *    3番目が updatePhase1Dashboard を呼ぶこと。
 * 4) A-1 初期セットアップ → GUIDE 手順表の A 行が A-1〜A-9、B 行が B-1〜B-4 で
 *    B側3番目にダッシュボード更新が入ること。行ズレ・重なりが無いこと。
 * 5) GUIDE 分類表で DASHBOARD が「事後検証用」に並び緑(#d9ead3)表示、OUTPUT は「出力用」のままであること。
 * 6) B-1 → B-2 → B-3 → B-4 を順に実行し、各機能が従来どおり動作すること
 *    （updatePhase1Dashboard は本体・ガード step4_status とも不変）。
 * 7) A-9 の OUTPUT 年度合計・月次 P10/P50/P90 が本変更の前後で不変であること（表記/配置のみ・予測非影響）。
 */

/**
 * HOW TO TEST (nav polish)
 * 1) VERSION='2.3.49-dev' / BUILD_STAGE='output-nav-polish'、DLM_BUILD_STAGE 不変、ファイル先頭コメントも同期。
 * 2) A-9 実行後に「A-10 予算を策定」を押下 → OUTPUT が前面化し、予算ブロック（H24:J40）が画面の中ほどに
 *    収まること（ヘッダ行 24 が画面下端に張り付く／J40 が見切れる状態にならない）。AI coverage 注記（21〜23 行）が
 *    上の文脈として残り、その下に予算ブロック全体が見えること。アクティブセルは範囲左上の H24。
 *    ※ 移動時に一瞬下→上へスクロールするちらつきは決定論的スクロールの仕様（許容）。
 * 3) OUTPUT 不在 / A-9 未実行（タイトル空）のガードは従来どおり動作（注意ダイアログで終了）すること。
 * 4) 「A-9 予測を実行」完了後にブロッキングな完了ダイアログ（B-3 への次手順案内）が出ないこと。
 *    代わりに軽量トースト「予測を更新しました。」のみが出る（次手順の案内文言を含まない）こと。
 * 5) grep で B-3 への次手順案内文言が 0 件であること（A-9 完了ダイアログ撤去の確認）。
 * 6) A-9 の OUTPUT 年度合計・月次 P10/P50/P90（A〜G列）および予算列 H/I/J の値・数式が本変更の前後で不変
 *    であること（表示・ナビ・トーストのみ・予測非影響）。
 */

function writeContiguousRowUpdates_(sh, updates, width) {
  if (!updates || !updates.length) return;
  updates.sort((a, b) => a.rowNo - b.rowNo);
  let blockStart = 0;
  let blockRows = [];
  updates.forEach(u => {
    if (!blockRows.length) {
      blockStart = u.rowNo;
      blockRows = [u.row];
      return;
    }
    if (u.rowNo === blockStart + blockRows.length) {
      blockRows.push(u.row);
      return;
    }
    sh.getRange(blockStart, 1, blockRows.length, width).setValues(blockRows);
    blockStart = u.rowNo;
    blockRows = [u.row];
  });
  if (blockRows.length) sh.getRange(blockStart, 1, blockRows.length, width).setValues(blockRows);
}

// DONE(step-3c-3a): 死にコード整理 + version/build-stage同期（挙動不変）。
// DONE(step-3c-3b): 主観寄与のLMDI厳密加法分解 + 絶対/相対レンジ（CONFIGトグル / 既定OFF）。
// DONE(step-3c-3c-1): raw hit/n を RELIABILITY_EVIDENCE に永続化（予測不変 / 集約の前提）。
// DONE(step-3c-3c): POOL_PRIORのクライアント横断自動更新（adminAggregatePoolPriorAcrossBooks で実装済み / 中央集約book→各bookへfan-out）。


function resetWorkbookSheets_(ss, order) {
  var required = {};
  for (var i = 0; i < order.length; i++) required[order[i]] = true;

  for (var j = 0; j < order.length; j++) {
    if (!ss.getSheetByName(order[j])) ss.insertSheet(order[j]);
  }

  var current = ss.getSheets();
  for (var k = 0; k < current.length; k++) {
    var sh = current[k];
    if (required[sh.getName()]) continue;
    try {
      ss.deleteSheet(sh);
    } catch (e) {
      try { sh.hideSheet(); } catch (ignore) {}
    }
  }

  for (var x = 0; x < order.length; x++) {
    var target = ss.getSheetByName(order[x]);
    if (!target) continue;
    try { target.showSheet(); } catch (e2) {}
    safeMoveSheet_(ss, target, x + 1);
  }
}

function safeMoveSheet_(ss, sh, targetIndex) {
  if (!sh) return;
  try {
    var max = ss.getSheets().length;
    var idx = targetIndex;
    if (idx < 1) idx = 1;
    if (idx > max) idx = max;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(idx);
  } catch (e) {
    // 並び替え失敗時は継続
  }
}


/** 初期設定をCONFIGへ保存 */
function saveInitialSetupSettings(clientName, fyStr, peopleCSV) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = getOrCreateSheet_(ss, SHEETS.CONFIG);
  const targetClient = String(clientName || '').trim();
  const residual = detectResidualClientData_(ss, targetClient);

  const fy = Number(fyStr);
  if (!targetClient) throw new Error('メーカー名を選択してください。');
  if (!fy || !isFinite(fy)) throw new Error('予測年度(FY)が不正です。');

  cfg.getRange('B2').setValue(targetClient);
  cfg.getRange('B3').setValue(fy);
  cfg.getRange('B4').setValue(String(peopleCSV || '').trim());

  // GUIDE更新（更新履歴は保持されます）
  buildGUIDE_();
  ss.setActiveSheet(ss.getSheetByName(SHEETS.GUIDE));
  if (residual.hasResidual) {
    ss.toast(`設定を保存しました。前のデータが残っている可能性があります（${residual.summary}）。必要に応じて A-1 初期セットアップ（全上書き）でクリーン化してください。`, MENU_NAME, 12);
  } else {
    ss.toast('初期設定を保存しました。次は A-2 売上データを取り込む を実行してください。', MENU_NAME, 6);
  }
}

function detectResidualClientData_(ss, targetClient) {
  const target = normalizeClientName_(String(targetClient || '').trim());
  const hits = [];
  const sheetsToCheck = [
    SHEETS.SALES_INPUT,
    SHEETS.SALES_MONTHLY,
    SHEETS.ACTUAL_EVAL_MONTHLY,
    SHEETS.AI_RESEARCH_STRUCTURED,
    SHEETS.FORECAST_SNAPSHOT,
    SHEETS.EVAL_LOG,
    SHEETS.EVAL_INSIGHTS,
    SHEETS.AI_IMPACT_HISTORY,
    SHEETS.SUBJECTIVE_IMPACT_HISTORY,
    SHEETS.LANDING_FORECAST,
    SHEETS.BACKTEST_REPORT
  ];
  sheetsToCheck.forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return;
    const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(v => String(v || '').trim());
    const clientIdx = header.indexOf('client');
    if (clientIdx < 0) return;
    const nRows = Math.min(sh.getLastRow() - 1, 200);
    const vals = sh.getRange(2, clientIdx + 1, nRows, 1).getValues();
    const hasOtherClient = vals.some(r => {
      const c = normalizeClientName_(String(r[0] || '').trim());
      return c && target && !isSameClient_(c, target);
    });
    if (hasOtherClient) hits.push(name);
  });

  const output = ss.getSheetByName(SHEETS.OUTPUT);
  if (output) {
    const title = String(output.getRange(1, 1).getValue() || '').trim();
    const m = title.match(/（([^／/]+)[／/]/);
    const oldClient = m ? normalizeClientName_(m[1]) : '';
    if (oldClient && target && !isSameClient_(oldClient, target)) hits.push(SHEETS.OUTPUT);
  }

  return {
    hasResidual: hits.length > 0,
    sheets: hits,
    summary: hits.slice(0, 5).join(', ') + (hits.length > 5 ? ' ほか' : '')
  };
}

/**
 * デフォルトFY（3月末決算の前後6か月基準）：
 * - 実行日を6か月進めた日付の「年」をFYとして採用
 *   例) 2026/04 実行 → 2026/10 相当 → FY2026
 *   例) 2026/10 実行 → 2027/04 相当 → FY2027
 */
function getDefaultFY_() {
  const now = new Date();
  const shifted = new Date(now.getFullYear(), now.getMonth() + 6, 1);
  return shifted.getFullYear();
}

function getForecastFYStart_(fy) {
  return new Date(Number(fy), 3, 1);
}

function getForecastFYEnd_(fy) {
  // FY終了日は厳密には FY+1/03/31
  return new Date(Number(fy) + 1, 3, 0);
}

/** 外部実績ソースIDをScript Propertiesから取得する。 */
function getExternalSpreadsheetId_() {
  const configured = String(
    PropertiesService.getScriptProperties().getProperty(EXTERNAL_SS_ID_PROPERTY) || ''
  ).trim();
  if (configured) return configured;
  if (LEGACY_EXTERNAL_SS_ID_FALLBACK) {
    Logger.log(`WARN: ${EXTERNAL_SS_ID_PROPERTY} is not configured; using legacy migration fallback.`);
    return LEGACY_EXTERNAL_SS_ID_FALLBACK;
  }
  throw new Error(`管理者設定 ${EXTERNAL_SS_ID_PROPERTY} がありません。Admin Hubで実績ソースを設定してください。`);
}

/** 外部SSからメーカー候補（最新2年のAO列）を取得 */
function getClientCandidatesForSetup_() {
  const ext = SpreadsheetApp.openById(getExternalSpreadsheetId_());
  const sheets = ext.getSheets().map(s => s.getName());

  const yearTabs = [];
  sheets.forEach(name => {
    const m = name.match(/^\*(\d{4})_actual_value$/);
    if (m) yearTabs.push({ name, year: Number(m[1]) });
  });
  yearTabs.sort((a,b)=>b.year-a.year);

  const target = yearTabs.slice(0,2).map(o=>o.name);
  const set = new Set();

  target.forEach(tabName => {
    const sh = ext.getSheetByName(tabName);
    if (!sh) return;

    const maxCols = sh.getMaxColumns();
    if (maxCols < EXT_COL_CLIENT) return;

    const lastRow = sh.getLastRow();
    if (lastRow < 2) return;

    const vals = sh.getRange(2, EXT_COL_CLIENT, lastRow - 1, 1).getValues();
    vals.forEach(r => {
      const v = r[0];
      if (v && String(v).trim()) set.add(normalizeClientName_(String(v).trim()));
    });
  });

  return Array.from(set).sort();
}

function normalizeClientName_(name) {
  const s = String(name || '').trim();
  if (s === 'ｳﾞｨｱﾄﾘｽ製薬(株)' || s === 'ｳﾞｨｱﾄﾘｽ製薬合同会社') return 'ｳﾞｨｱﾄﾘｽ製薬';
  return s;
}

function isSameClient_(a, b) {
  return normalizeClientName_(a) === normalizeClientName_(b);
}


/** ====== 予測コア ====== */
function runForecastFYCore_(fy, clientName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sales = ss.getSheetByName(SHEETS.SALES_MONTHLY);
  if (!sales) throw new Error('SALES_MONTHLYがありません。');

  const salesData = readSales48Months_(sales);
  const tuning = readModelTuningFromConfig_();

  // ========== v1.6 NEW: quarterly review ==========
  let calibration = null;
  let calibrationWarning = '';
  try {
    calibration = readCalibrationState_(clientName);
  } catch (err) {
    calibrationWarning = '⚠ calibration読み込み失敗 / fallbackで実行';
    calibration = createDefaultCalibrationState_(clientName);
  }
  const tuningApplied = applyCalibrationToTuning_(tuning, calibration);
  const runDate = new Date();
  const ctx = getForecastContext_(fy, runDate, salesData.headerMonths || []);

  if (!salesData.isComplete48) {
    const ui = SpreadsheetApp.getUi();
    const res = ui.alert(
      '注意：売上データが48ヶ月揃っていません',
      '48ヶ月（過去4年）揃っていない場合、予測精度が下がる可能性があります。\nこのままシミュレーションを続行しますか？',
      ui.ButtonSet.OK_CANCEL
    );
    if (res !== ui.Button.OK) throw new Error('ユーザーが中断しました。');
  }

  // 予測の土台はBASEのみ（SPOTは別途、背景成分として扱う）
  const aggY_raw = salesData.baseSeries48 && salesData.baseSeries48.length
    ? salesData.baseSeries48.slice()
    : sumAcrossProducts_(salesData.monthlyByProduct);

  const seriesStart = salesData.headerMonths && salesData.headerMonths.length ? salesData.headerMonths[0] : new Date(fy - 4, 3, 1);
  const unclosedAdjusted = adjustForUnclosedMonths_(aggY_raw, seriesStart);
  const aggY_adj = unclosedAdjusted.series.slice();

  toastProgress_(ss, 'STEP2/6: 未確定月補完済み48ヶ月でトレンド＋季節性を推定…', 7);
  const smoothY = aggY_adj.slice();

  // Opsモデル：トレンド＋季節性
  const model = fitOpsModelTrendSeason_(smoothY);

  // 残差%プール（確定月のみ + robust化）
  const residualPct = buildResidualPool_(smoothY, model, seriesStart, ctx.lastClosedMonthStart);

  const residP10 = percentile_(residualPct, 0.10);
  const residP50 = percentile_(residualPct, 0.50);
  const residP90 = percentile_(residualPct, 0.90);

  // 12ヶ月予測対象（FY開始月〜12ヶ月）
  const months = ctx.forecastMonths;
  const closedOffsetsSet = new Set(ctx.closedForecastMonthOffsets || []);
  const sourceByMonth = months.map((_, i) => closedOffsetsSet.has(i) ? 'actual_closed' : 'forecast_open');

  const dlmModeRaw = readDlmEngineMode_();
  let dlmForecast = null;
  if (dlmModeRaw !== 'off') {
    try {
      dlmForecast = computeDlmFyForecast_(
        salesData.baseSeries48, seriesStart, ctx.lastClosedMonthStart, ctx.forecastMonths, tuning
      );
    } catch (e) {
      dlmForecast = { ready: false, reason: String((e && e.message) || e) };
    }
  }
  const dlmReady = !!(dlmForecast && dlmForecast.ready);
  const dlmPrimaryActive = (dlmModeRaw === 'primary') && dlmReady;
  const dlmMode = (dlmModeRaw === 'off')
    ? 'off'
    : ((dlmModeRaw === 'primary') ? (dlmReady ? 'primary' : 'primary_fallback') : 'shadow');
  const spotCapBasis = readDlmPrimarySpotCapBasis_();
  const reliabilityApply = readReliabilityApplyEnabled_();
  const sourceReliabilityMap = readSourceReliability_(clientName);
  const reliabilityMap = reliabilityApply ? sourceReliabilityMap : new Map();
  const nonDefaultReliabilityCount = Array.from(sourceReliabilityMap.values()).filter(v => Math.abs(Number(v || 1) - 1) > 1e-9).length;
  const lmdiEnabled = readLmdiDecompositionEnabled_();

  // 既知SPOT（DEV_SPOT）と背景SPOTを分離
  const devProjectsByMonth = readDevSpotProjects12Months_(fy);
  const knownSpotExpectedByMonth = computeKnownSpotExpectedByMonth_(devProjectsByMonth);
  const devFixedByMonth = knownSpotExpectedByMonth.slice();

  // 背景SPOTの上限を作るため、BASE予測(P50)を先に計算
  const baseOnlyP50 = forecastByResidualQuantiles_(model, new Array(12).fill(0), { p10: residP10, p50: residP50, p90: residP90 }).p50;
  let baseForSpotCap = baseOnlyP50.slice();
  if (spotCapBasis === 'dlm' && dlmPrimaryActive && dlmForecast && dlmForecast.ready) {
    baseForSpotCap = baseOnlyP50.map((ols, i) => {
      const d = dlmForecast.p50[i];
      return (d === null || d === undefined) ? ols : Math.max(0, Number(d));
    });
  }
  const spotBgModel = fitSpotRecurringModel_(
    salesData.spotSeries48 || [],
    seriesStart,
    ctx.lastClosedMonthStart,
    baseForSpotCap,
    tuning
  );

  const knownSpotOffsetRate = isFinite(tuning.knownSpotOffsetRate) ? tuning.knownSpotOffsetRate : KNOWN_SPOT_OFFSET_RATE;
  const spotBackgroundByMonth = spotBgModel.expectedByMonth.map((v, i) => Math.max(0, Number(v || 0) - Number(knownSpotExpectedByMonth[i] || 0) * knownSpotOffsetRate));
  const spotFixedByMonth = devFixedByMonth.map((v, i) => Number(v || 0) + Number(spotBackgroundByMonth[i] || 0));

  // 要因（主観係数）※必要情報が揃った行だけ読む
  const factorsProduct = readFactorsProduct_(fy);
  const factorsClient = readFactorsClient_(fy);
  const opinions = readOpinions_(fy);

  // AI調査スコア（topic別：benchmark/event blend）
  const aiScoreBasis = readAiScoreBasis_();
  const aiScores = readAIResearchScores_(calibration, { basis: aiScoreBasis, clientName, tuning });
  const aiReportText = readAIReportTextForClient_(clientName);

  // 製品構成比：未確定月を避ける（直近の“確定済み12ヶ月”で重み計算）
  const productWeights = computeProductWeightsFromSalesInputClosed12_(fy, clientName, ctx);

  // 線形回帰（参考）予測：季節性込みモデルのトレンド外挿（参考）
  const regTotal = [];
  for (let i = 0; i < 12; i++) {
    const t = 48 + (i + 1);
    const regOps = Math.max(0, (model.intercept + model.slope * t) * model.seasonalIndex[i % 12]);
    // 参考線（Linear）は定量モデル寄せ（背景SPOTのみ）
    regTotal.push(regOps + spotBackgroundByMonth[i]);
  }

  // 「定量のみ」：BASE定量 + 背景SPOT定量（既知案件は含めない）
  const opsQuantOnly = forecastByResidualQuantiles_(model, spotBackgroundByMonth, { p10: residP10, p50: residP50, p90: residP90 });
  let quantOnly = opsQuantOnly;
  if (dlmPrimaryActive) {
    quantOnly = { p10: opsQuantOnly.p10.slice(), p50: opsQuantOnly.p50.slice(), p90: opsQuantOnly.p90.slice() };
    for (let i = 0; i < 12; i++) {
      if (dlmForecast.p50[i] === null || dlmForecast.p50[i] === undefined) continue;
      const bg = Number(spotBackgroundByMonth[i] || 0);
      quantOnly.p10[i] = Math.max(0, Number(dlmForecast.p10[i] || 0)) + bg;
      quantOnly.p50[i] = Math.max(0, Number(dlmForecast.p50[i] || 0)) + bg;
      quantOnly.p90[i] = Math.max(0, Number(dlmForecast.p90[i] || 0)) + bg;
    }
  }
  // objOnly は「客観のみ」表示系列。closedMonthMode='actual' の実績上書きで
  // quantOnly（KPI診断）/ opsQuantOnly（DLM比較の旧Ops参照）を巻き込み変異させないよう、独立配列のコピーにする。
  const objOnly = { p10: quantOnly.p10.slice(), p50: quantOnly.p50.slice(), p90: quantOnly.p90.slice() };

  toastProgress_(ss, `STEP3/6: 残差からレンジの基礎（P10/P50/P90）を作成…`, 5);
  toastProgress_(ss, `STEP4/6: 既知SPOT/背景SPOT + 主観係数を準備…`, 6);

  toastProgress_(ss, `STEP5/6: Monte Carlo ${N_SIM}回（運用・背景SPOT・既知SPOT）…`, 8);

  const mixed = forecastMonteCarloMixed_(model, {
    residualPct,
    factorsProduct,
    factorsClient,
    opinions,
    productWeights,
    aiScores,
    nSim: N_SIM,
    months,
    sourceByMonth,
    aiWeight: tuningApplied.aiWeight,
    aiMaxAbsEffect: tuningApplied.aiMaxAbsEffect,
    tuning: tuningApplied,
    spotBgModel,
    knownSpotProjectsByMonth: devProjectsByMonth,
    knownSpotBgSuppressRate: isFinite(tuning.knownSpotBgSuppressRate) ? tuning.knownSpotBgSuppressRate : KNOWN_SPOT_BG_SUPPRESS_RATE,
    dlmBaseLogByMonth: dlmPrimaryActive ? dlmForecast.logByMonth : null,
    reliabilityApply,
    reliabilityMap,
    lmdiEnabled
  });

  const opinionsSummaryTop = summarizeOpinionsTop_(opinions);
  const opinionsSummaryByMonth = summarizeOpinionsByMonth_(opinions, months);

  const totalActual48 = salesData.baseSeries48.map((v, i) => Number(v || 0) + Number((salesData.spotSeries48 || [])[i] || 0));
  const actualClosedByMonth = months.map((_, i) => {
    const salesIdx = ctx.forecastMonthIndexesInSales[i];
    return (closedOffsetsSet.has(i) && salesIdx >= 0) ? Number(totalActual48[salesIdx] || 0) : '';
  });

  const closedMonthMode = readForecastClosedMonthMode_(); // 'actual' | 'forecast'
  if (closedMonthMode === 'actual') {
    for (let i = 0; i < months.length; i++) {
      if (sourceByMonth[i] !== 'actual_closed') continue;
      const a = Number(actualClosedByMonth[i] || 0);
      objOnly.p10[i] = a; objOnly.p50[i] = a; objOnly.p90[i] = a;
      mixed.p10[i] = a; mixed.p50[i] = a; mixed.p90[i] = a;
      regTotal[i] = a;
    }
  }

  // 学習系補正（全体係数・暦月バイアス・Vertexアシスト）は forecast_open 月だけに掛ける。
  // closed 月は実績で上書き済みであり、実績値を補正係数で変形させない。
  const biasCorrectionFactor = isFinite(calibration && calibration.bias_correction_factor) ? Number(calibration.bias_correction_factor) : 1.0;
  const learnedMonthBias = parseResidualMonthBiasJson_(calibration && calibration.residual_month_bias_json);
  const vertexForecastEnabled = readVertexForecastEnabled_();
  const vertexAssist = vertexForecastEnabled ? readLatestVertexAssist_(clientName, months) : { ready: false };
  const vertexRelR = getSourceReliability_(reliabilityMap, 'vertex_forecast', 'assist');
  const vertexW = vertexAssist.ready
    ? readVertexAssistWeight_(tuningApplied) * vertexRelR * (0.5 + 0.5 * vertexAssist.confidence)
    : 0;
  const monthBiasByMonth = new Array(12).fill(0);
  const kVertexByMonth = new Array(12).fill(1);
  for (let i = 0; i < months.length; i++) {
    if (sourceByMonth[i] !== 'forecast_open') continue;
    const mb = clamp_(Number(learnedMonthBias[String(months[i].getMonth() + 1)] || 0), -AUTOLEARN_FORECAST_BIAS_CAP, AUTOLEARN_FORECAST_BIAS_CAP);
    monthBiasByMonth[i] = mb;
    if (vertexAssist.ready) {
      kVertexByMonth[i] = clamp_(1 + Number(vertexAssist.adj[i] || 0) * vertexW, 0.7, 1.3);
    }
    const k = biasCorrectionFactor * (1 + mb) * kVertexByMonth[i];
    if (Math.abs(k - 1) < 1e-12) continue;
    mixed.p10[i] = Number(mixed.p10[i] || 0) * k;
    mixed.p50[i] = Number(mixed.p50[i] || 0) * k;
    mixed.p90[i] = Number(mixed.p90[i] || 0) * k;
    if (mixed.raw) {
      mixed.raw.p10[i] = Number((mixed.raw.p10 || [])[i] || 0) * k;
      mixed.raw.p50[i] = Number((mixed.raw.p50 || [])[i] || 0) * k;
      mixed.raw.p90[i] = Number((mixed.raw.p90 || [])[i] || 0) * k;
    }
  }

  let productWeightWarning = '';
  if (factorsProduct.length > 0 && mixed.diagnostics && mixed.diagnostics.kProdByMonth && mixed.diagnostics.kProdByMonth.every(k => Math.abs(Number(k || 1) - 1) < 1e-9)) {
    const zeroWeightProducts = Array.from(new Set(
      factorsProduct
        .map(f => String((f && f.product) || '').trim())
        .filter(Boolean)
        .filter(p => !productWeights || !productWeights.has(p) || Math.abs(Number(productWeights.get(p) || 0)) < 1e-12)
    )).sort();
    const shown = zeroWeightProducts.slice(0, 10).join(',');
    const more = zeroWeightProducts.length > 10 ? `,ほか${zeroWeightProducts.length - 10}件` : '';
    const productsText = shown ? `weight=0 product=${shown}${more}` : 'weight=0 product未特定';
    productWeightWarning = `PRODUCT に有効行がありますが、kProd が全月1.0です。製品名キー/構成比を確認してください（${productsText}）。`;
  }

  return {
    runId: Utilities.getUuid(),
    runAt: runDate,
    fy,
    clientName,
    months,
    objOnly,
    quantOnly,
    opsQuantOnly,
    mixed,
    mixedDiagnostics: mixed.diagnostics || null,
    regTotal,
    devFixedByMonth,
    knownSpotExpectedByMonth,
    spotBackgroundByMonth,
    spotFixedByMonth,
    opinionsSummaryTop,
    opinionsSummaryByMonth,
    sourceByMonth,
    actualClosedByMonth,
    closedMonthMode,
    modelInfo: { residP10, residP50, residP90, slope: model.slope, intercept: model.intercept },
    baseSeries48: salesData.baseSeries48 || [],
    adjustedBaseSeries48: aggY_adj,
    seriesStart,
    lastClosedMonthStart: ctx.lastClosedMonthStart,
    opsModel: model,
    aiScores,
    aiReportText,
    calibration,
    calibrationWarning,
    tuningApplied,
    dlmMode,
    dlmForecast,
    dlmModeRaw,
    dlmPrimaryActive,
    reliabilityApply,
    nonDefaultReliabilityCount,
    spotCapBasis,
    productWeightWarning,
    reliabilityInputs: {
      factorsProduct,
      factorsClient,
      opinions,
      aiScores,
      productWeights,
      reliabilityMap,
      vertexPushByMonth: kVertexByMonth.map(k => Number(k || 1) - 1)
    },
    learnedAdjustments: {
      biasCorrectionFactor,
      monthBiasByMonth,
      kVertexByMonth,
      vertexReady: !!vertexAssist.ready,
      vertexWeight: vertexW,
      vertexReliability: vertexRelR,
      vertexConfidence: vertexAssist.ready ? vertexAssist.confidence : 0,
      vertexAssistAt: vertexAssist.at || ''
    },
    aiScoreBasis
  };
}

/** ====== OUTPUT書き込み ====== */
function buildEngineModeText_(result) {
  const m = result && result.dlmMode;
  if (m === 'primary') return '予測エンジン: DLM（対数空間DLM / BASEを計画値に反映済み）';
  if (m === 'primary_fallback') return '⚠ 予測エンジン: DLM primaryを要求しましたが実績不足のため既存Ops（トレンド+季節）にフォールバックしました（計画値は従来式）';
  if (m === 'shadow') return '予測エンジン: 既存Ops（トレンド+季節） / DLMはshadow比較のみ';
  return '予測エンジン: 既存Ops（トレンド+季節）';
}

function buildReliabilityText_(result) {
  const apply = !!(result && result.reliabilityApply);
  const count = Number((result && result.nonDefaultReliabilityCount) || 0);
  const map = (((result || {}).reliabilityInputs || {}).reliabilityMap) || new Map();
  const active = [];
  if (map && typeof map.forEach === 'function') {
    map.forEach((value, source) => {
      const r = Number(value);
      if (!isFinite(r) || Math.abs(r - 1) <= 1e-9) return;
      active.push(`${source}=${r.toFixed(2)}`);
    });
  }
  active.sort();
  let detail = '';
  if (apply && active.length > 0) {
    const shown = active.slice(0, 5);
    if (active.length > 5) shown.push(`ほか ${active.length - 5}件`);
    detail = ` / 適用中=${shown.join(', ')}`;
  } else if (apply) {
    detail = ' / （手入力なし＝全ソース中立1.0 / 予測は信頼度未適用と同じ）';
  }
  return `Source Reliability: ${apply ? 'ON' : 'OFF'} / 非1.0ソース数=${count}${detail} / SPOT上限基準=${(result && result.spotCapBasis) || 'dlm'}`;
}

/**
 * HOW TO TEST (display polish)
 * 1) 当時の VERSION / BUILD_STAGE、DLM_BUILD_STAGE 不変、ファイル先頭コメントも同期。
 * 2) A-9 を実行 → OUTPUT 6行目（注記ブロック）が、警告/エラーの有無にかかわらず常に黒字（既定色）で表示され、
 *    赤字（#b71c1c）にならないこと。productWeightWarning や AI取込エラー（web/rag/structure_error）がある場合も
 *    テキストは表示されるが、行全体は赤くならないこと（AI個別の警告強調は21〜23行に残る）。
 * 3) grep で writeOutputFY_ 内の旧エラー判定識別子が定義・参照とも 0 件（死にコード削除）。
 *    step3aWarn は「AI取込警告サマリー」表示に引き続き使われ残存していること。
 * 4) A-9 実行後に「A-10 予算を策定」を押下 → OUTPUT が前面化し、H24:J40 の予算ブロック全体が
 *    画面内にできるだけ収まる位置にスクロールし、アクティブセルが H24（左上）になること。
 *    OUTPUT 不在 / A-9 未実行（タイトル空）のガードは従来どおり動作すること。
 * 5) A-9 実行後、OUTPUT の K 列（11列目）の幅が 130px になり、潰れた細い列（旧 40px）でないこと。
 *    H/I/J=160px、グラフが L 列（12列目）開始で H/I/J と重ならないことは不変。
 * 6) A-9 の OUTPUT 年度合計・月次 P10/P50/P90（A〜G列）および予算列 H/I/J の値・数式が
 *    本変更の前後で不変であること（表示・ナビゲーションのみ・予測非影響）。
 */
function writeOutputFY_(result) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.OUTPUT);
  if (!sh) throw new Error('OUTPUTがありません。');

  resetOutputSheet_(sh);

  // 幅
  sh.setColumnWidth(1, 240);
  sh.setColumnWidth(2, 170);
  sh.setColumnWidth(3, 170);
  sh.setColumnWidth(4, 170);
  sh.setColumnWidth(5, 200);
  sh.setColumnWidth(6, 190);
  for (let c = 7; c <= 12; c++) sh.setColumnWidth(c, 130);
  // 予算列 H/I/J を読みやすく、K(11) は予算列とグラフ（L列開始）の間の余白として標準幅(130px)を確保（潰れ防止）
  sh.setColumnWidth(8, 160);
  sh.setColumnWidth(9, 160);
  sh.setColumnWidth(10, 160);
  sh.setColumnWidth(11, 130);

  const fy = result.fy;
  const client = result.clientName;

  const start = getForecastFYStart_(fy);
  const end = getForecastFYEnd_(fy);
  const tuningTop = readModelTuningFromConfig_();

  sh.getRange(1, 1).setValue(`FY${fy} 売上予測（${client} / ${fmtYM_(start)} 〜 ${fmtYM_(end)}）`);
  sh.getRange(1, 1, 1, 6).merge();
  sh.getRange(1, 1).setFontSize(16).setFontWeight('bold');
  sh.setFrozenRows(0);
  sh.getRange(1, 1, sh.getMaxRows(), 12).setHorizontalAlignment('left');

  // 予測運用ポリシー（成功KPI/制約を上部で明示）
  sh.getRange(2, 1).setValue('予測運用ポリシー（計画値・制約・診断）').setFontWeight('bold').setBackground('#d9ead3');
  sh.getRange(2, 1, 1, 6).merge();
  sh.getRange(3, 1, 1, 6).setValues([['計画値=P50 / Downside=P10 / Upside=P90 / P10-P90は説明帯（hard gateではない）', '', '', '', '', '']]).merge();
  sh.getRange(4, 1, 1, 6).setValues([[`年間制約: annual_abs_error_rate<=${Math.round(ANNUAL_ABS_ERROR_CONSTRAINT * 100)}%`, `半期制約: half_wape<=${Math.round(HALF_WAPE_CONSTRAINT * 100)}%（目標${Math.round(HALF_WAPE_FUTURE_TARGET * 100)}%）`, `over-forecast rate<=${Math.round(OVERFORECAST_RATE_CONSTRAINT * 100)}%（半期/年間）`, '', '', '']]);
  sh.getRange(4, 1, 1, 6).mergeAcross();
  sh.getRange(5, 1, 1, 6).setValues([['月次/Qは診断指標。actualがP10-P90外の月はB-3(EVAL_INSIGHTS)で追加調査。1 client = 1 book。', '', '', '', '', '']]).merge();
  safeSetNote_(sh, 2, 1, '成功KPI/制約と診断KPIを分離して運用するための説明ブロックです。');
  safeSetNote_(sh, 3, 1, '計画の単一値はP50。P10/P90は説明用レンジです。');
  safeSetNote_(sh, 4, 1, '本ツールは過大予測（forecast>actual）の抑制を優先して監視します。');
  const step3aWarn = readStep3aWarningSummary_();
  const calText = buildOutputCalibrationSummary_(result);
  const engineText = buildEngineModeText_(result);
  const subjectiveCapText = '主観入力は月次上限（cap）内でそのまま反映されます（3c-1でオーバーレイ率の自動調整を撤去）。';
  const reliabilityText = buildReliabilityText_(result);
  const productWeightWarning = String((result && result.productWeightWarning) || '').trim();
  const productWeightWarningText = productWeightWarning ? `製品重み警告: ${productWeightWarning}\n` : '';
  const annualForecastNote = (result.closedMonthMode === 'forecast')
    ? '本予測は通年（12ヶ月）の見通しです。計画の主数値は「混合」セクションの年度合計 Baseline(P50)。期中の着地（実績差し替え）には用いず、経過月の実績は参考（ActualClosed列）として併記し予測値には混ぜていません。MonteCarlo / Linear / Seasonal の併記は比較・参考で、計画値は混合の年度合計 P50 です。\n'
    : '経過月は実績（ActualClosed列）で表示していますが、年度合計(P10/P50/P90)は12ヶ月すべてを予測として算出した通年予測です（経過実績で固定した着地値ではありません）。\n';
  sh.getRange(6, 1, 1, 6).merge();
  sh.getRange(6, 1).setValue(annualForecastNote + engineText + '\n' + subjectiveCapText + '\n' + reliabilityText + '\n' + productWeightWarningText + (step3aWarn ? `AI取込警告サマリー: ${step3aWarn}` : 'AI取込警告サマリー: なし') + '\n' + calText)
    .setFontColor('#000000')
    .setFontSize(10).setWrap(true);
  // KPIブロック（診断）
  const quantP50 = (result.quantOnly || result.objOnly).p50 || new Array(12).fill(0);
  const mixedP50 = result.mixed.p50 || new Array(12).fill(0);
  const mixedRawP50 = (result.mixed.raw && result.mixed.raw.p50) ? result.mixed.raw.p50 : mixedP50;
  const dTop = result.mixedDiagnostics || {};
  const subjectiveCalP50 = dTop.scaledSubjectiveP50ByMonth || new Array(12).fill(0);
  const subjectiveRawP50 = dTop.subjectiveContinuousP50ByMonth || new Array(12).fill(0);
  const knownSpotP50 = dTop.knownSpotP50ByMonth || new Array(12).fill(0);
  const subjectiveExclAICalP50 = dTop.scaledSubjectiveExclAIP50ByMonth || new Array(12).fill(0);
  const aiCalP50 = dTop.scaledAIP50ByMonth || new Array(12).fill(0);
  const kpiCal = computeDisplayedQualKpi_(quantP50, mixedP50, result.sourceByMonth || []);
  const kpiRaw = computeDisplayedQualKpi_(quantP50, mixedRawP50, result.sourceByMonth || []);
  const overlayCalKpi = computeSubjectiveOverlayKpi_(quantP50, subjectiveCalP50, result.sourceByMonth || []);
  const overlayExclAIKpi = computeSubjectiveOverlayKpi_(quantP50, subjectiveExclAICalP50, result.sourceByMonth || []);
  const aiOverlayKpi = computeSubjectiveOverlayKpi_(quantP50, aiCalP50, result.sourceByMonth || []);
  const knownSpotKpi = computeKnownSpotKpi_(quantP50, knownSpotP50, result.sourceByMonth || []);
  const hasOpenMonths = !!kpiCal.hasOpenMonths;
  const subjectiveCap = isFinite(tuningTop.qualSubjectiveMonthlyCap) ? tuningTop.qualSubjectiveMonthlyCap : QUAL_SUBJECTIVE_MONTHLY_CAP;
  const qualWarn = !hasOpenMonths
    ? 'N/A（予測対象月なし）'
    : `参考: 主観オーバーレイ率(AI除く) ${(overlayExclAIKpi.overlayShare * 100).toFixed(1)}% / AI寄与率 ${(aiOverlayKpi.overlayShare * 100).toFixed(1)}%（cap=${(subjectiveCap * 100).toFixed(1)}%）`;

  sh.getRange(7, 1).setValue('予測構成サマリー（診断指標）').setFontWeight('bold').setBackground('#e2f0d9');
  sh.getRange(7, 1, 1, 6).merge();
  const summaryHeaderRow = 8;
  const kpiHdr = ['定量寄与率（予測対象月のみ）', '主観オーバーレイ率（AI除く / calibrated）', 'AI寄与率（calibrated）', 'Known Spot寄与率（予測対象月のみ）', '非定量ネット差分率（参考）', '警告'];
  const kpiVal = [
    hasOpenMonths ? kpiCal.quantShare : 'N/A',
    hasOpenMonths ? overlayExclAIKpi.overlayShare : 'N/A',
    hasOpenMonths ? aiOverlayKpi.overlayShare : 'N/A',
    hasOpenMonths ? knownSpotKpi.knownSpotShare : 'N/A',
    hasOpenMonths ? kpiCal.qualShare : 'N/A',
    qualWarn
  ];
  sh.getRange(summaryHeaderRow, 1, 1, 6).setValues([kpiHdr]).setBackground(COLOR_HEADER).setFontWeight('bold');
  sh.getRange(9, 1, 1, 6).setValues([kpiVal]);
  sh.getRange(9, 6).setWrap(true).setVerticalAlignment('top');
  sh.setRowHeight(9, 40);
  sh.getRange(summaryHeaderRow, 1).setNote('【定量寄与率（予測対象月のみ）】\nforecast_open月だけで算出した、定量土台（quantOnly）の構成比です。\n式: |quantTotal| / (|quantTotal| + |netDelta|)');
  sh.getRange(summaryHeaderRow, 2).setNote('【主観オーバーレイ率（AI除く / capped）】\nPRODUCT/CLIENT/OPINIONS 由来の連続主観差分のみを対象にした参考比率です（AI調査は含みません）。\nKnown Spotも含みません。この率は予測制御には使いません。');
  sh.getRange(summaryHeaderRow, 3).setNote('【AI寄与率（calibrated）】\nAI調査（kAI）由来の寄与のみを、主観オーバーレイと分離して計測した参考比率です。\nAIは自前の上限（AI_MAX_ABS_EFFECT=±5%）で制御され、主観capとは別系統です。');
  sh.getRange(summaryHeaderRow, 4).setNote('【Known Spot寄与率（予測対象月のみ）】\nDEV_SPOT由来の既知案件寄与の比率です。\ncalibration対象外で、主観オーバーレイとは別系統で表示しています。');
  sh.getRange(summaryHeaderRow, 5).setNote('【非定量ネット差分率（参考）】\nmixedとquantOnlyの差分をネットで見た参考値です。\noverlayとknownが相殺/増幅し得るため、他列と単純加算はできません。');
  sh.getRange(summaryHeaderRow, 6).setNote('【警告/参考】\nAI行不足、レンジ過大など運用注意と、主観オーバーレイ率(AI除く)・AI寄与率の参考値を表示します。');
  if (hasOpenMonths) {
    sh.getRange(9, 1, 1, 4).setNumberFormat('0.0%');
    sh.getRange(9, 5).setNumberFormat('¥#,##0');
  }
  const compSubjExclAI = Math.abs(sumArr_(subjectiveExclAICalP50));
  const compAI = Math.abs(sumArr_(aiCalP50));
  const compDen = Math.abs(kpiCal.quantTotal) + compSubjExclAI + compAI + Math.abs(sumArr_(knownSpotP50));
  const compRow = compDen > 0
    ? [Math.abs(kpiCal.quantTotal) / compDen, compSubjExclAI / compDen, compAI / compDen, Math.abs(sumArr_(knownSpotP50)) / compDen, '', '参考（補助）: 定量/主観/AI/KnownSpot 合計100%分解']
    : ['N/A', 'N/A', 'N/A', 'N/A', '', '参考（補助）: 定量/主観/AI/KnownSpot 合計100%分解'];
  sh.getRange(10, 1, 1, 6).setValues([compRow]);
  if (compDen > 0) sh.getRange(10, 1, 1, 4).setNumberFormat('0.0%');
  sh.getRange(10, 1, 1, 6).setBackground('#f3f3f3').setFontColor('#666666');
  sh.getRange(10, 6).setWrap(true).setVerticalAlignment('top');
  sh.setRowHeight(10, 40);
  sh.getRange(10, 6).setNote('【参考（補助）: 定量/主観/AI/KnownSpot 合計100%分解】\n4軸（定量・主観オーバーレイ(AI除く)・AI調査・Known Spot）の寄与を100%に正規化した補助表示です。\n各シェアは絶対額(P50)ベース。意思決定では row 9 のKPIと併読してください。');

  // 数値トレンド Insight
  sh.getRange(11, 1).setValue('過去数年の数値トレンド Insight').setFontWeight('bold');
  sh.getRange(11, 2, 1, 5).merge().setValue(buildHistoricalTrendInsight_(result.baseSeries48 || [], result.opsModel || {})).setWrap(true);

  // AI調査 Insight
  sh.getRange(12, 1).setValue('AI調査 Insight').setFontWeight('bold');
  sh.getRange(12, 2, 1, 5).merge().setValue(buildAIInsight_(result.aiReportText || ''));
  const aiBodyRange = sh.getRange(12, 2, 1, 5);
  try {
    aiBodyRange.setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  } catch (e) {
    aiBodyRange.setWrap(false);
  }
  aiBodyRange.setVerticalAlignment('top');
  sh.setRowHeight(12, 48);

  // AI調査スコア（4軸）縦レイアウト
  const ai4 = result.aiScores || { Market: 0, Competitor: 0, Channel: 0, DX: 0 };
  const aiMeta = (result.aiScores && result.aiScores.meta) ? result.aiScores.meta : { Market: {}, Competitor: {}, Channel: {}, DX: {} };
  sh.getRange(13, 1, 4, 1).setValues([['Market'], ['Competitor'], ['Channel'], ['DX']]);
  sh.getRange(13, 2, 4, 1).setValues([[ai4.Market || 0], [ai4.Competitor || 0], [ai4.Channel || 0], [ai4.DX || 0]]).setNumberFormat('0.0');
  sh.getRange(13, 3, 4, 1).setValues([[shortText_((aiMeta.Market || {}).label, 12)], [shortText_((aiMeta.Competitor || {}).label, 12)], [shortText_((aiMeta.Channel || {}).label, 12)], [shortText_((aiMeta.DX || {}).label, 12)]]);
  sh.getRange(13, 4, 4, 1).setValues([[shortText_((aiMeta.Market || {}).universe, 18)], [shortText_((aiMeta.Competitor || {}).universe, 18)], [shortText_((aiMeta.Channel || {}).universe, 18)], [shortText_((aiMeta.DX || {}).universe, 18)]]);
  sh.getRange(13, 5, 4, 1).setValues([[shortText_((aiMeta.Market || {}).basis, 22)], [shortText_((aiMeta.Competitor || {}).basis, 22)], [shortText_((aiMeta.Channel || {}).basis, 22)], [shortText_((aiMeta.DX || {}).basis, 22)]]);
  sh.getRange(17, 1).setValue('スコア基準（各軸）');
  sh.getRange(17, 2, 1, 4).merge().setValue('各軸 final score: -50〜+50程度（0=中立） / relative percentile: 0〜100（50=同業中位）');
  sh.getRange(18, 1).setValue('スコア基準（4軸合計）');
  sh.getRange(18, 2, 1, 4).merge().setValue('4軸合計: -200〜+200 / final AI score = relative benchmark + latest events のblend');
  sh.getRange(13, 1).setNote('Marketトピックのfinal blended score');
  sh.getRange(14, 1).setNote('Competitorトピックのfinal blended score');
  sh.getRange(15, 1).setNote('Channelトピックのfinal blended score');
  sh.getRange(16, 1).setNote('DXトピックのfinal blended score');
  sh.getRange(17, 1).setNote('各軸の理論レンジ説明');
  sh.getRange(18, 1).setNote('4軸合計レンジ説明');
  const aiScoreBasis = (result && result.aiScoreBasis === 'momentum') ? 'momentum' : 'level';
  sh.getRange(19, 1, 1, 5).merge();
  sh.getRange(19, 1).setValue(`AIスコア基準: ${aiScoreBasis}`).setFontSize(9).setFontColor('#666666');
  const aiAllZero = [ai4.Market, ai4.Competitor, ai4.Channel, ai4.DX].every(v => Math.abs(Number(v || 0)) < 1e-9);
  if (aiAllZero) {
    sh.getRange(20, 1).setValue('⚠ AIスコアが全topicで0.0です（parser warning / 入力形式を確認）').setFontColor('#b71c1c');
  }
  const coverageText = AI_TOPICS.map(topic => {
    const m = aiMeta[topic] || {};
    const latest = m.latestAsOfDate ? Utilities.formatDate(new Date(m.latestAsOfDate), Session.getScriptTimeZone(), 'yyyy-MM-dd') : 'N/A';
    const momentumText = aiScoreBasis === 'momentum' ? ` / mom=${Number(m.momentumScore || 0).toFixed(1)} insuf=${!!m.momentumInsufficient}` : '';
    const confDropText = Number(m.eventDroppedMissingConf || 0) > 0 ? ` / confDrop=${Number(m.eventDroppedMissingConf)}` : '';
    const confDefaultN = Number(m.eventDefaultedMissingConf || 0) + Number(m.benchDefaultedMissingConf || 0);
    const confDefaultText = confDefaultN > 0 ? ` / confDefault=${confDefaultN}` : '';
    return `${topic}: coverage bench=${Number(m.coverageBenchmarkRows || 0)} evt=${Number(m.coverageEventRows || 0)} / mode=${String(m.degradedMode || 'blended')} / quality=${Number(m.qualityScore || 0).toFixed(2)} / neutralized=${!!m.neutralized} / latest=${latest}${momentumText}${confDropText}${confDefaultText}`;
  }).join('\n');
  sh.getRange(21, 1, 1, 6).merge();
  sh.getRange(21, 1).setValue(coverageText).setFontSize(9).setFontColor('#666666').setWrap(true).setVerticalAlignment('top');
  sh.setRowHeight(21, 72);
  // ベンチマーク未取得（RAGに相対位置の根拠が無い）は honest-zero 設計上の通常状態。
  // イベント情報で評価できている event_only は警告にせず、真にデータ皆無（no_data）の時だけ赤で警告する。
  const noDataTopics = AI_TOPICS.filter(topic => String(((aiMeta || {})[topic] || {}).degradedMode || '') === 'no_data');
  const eventOnlyTopics = AI_TOPICS.filter(topic => String(((aiMeta || {})[topic] || {}).degradedMode || '') === 'event_only');
  const benchmarkOnlyTopics = AI_TOPICS.filter(topic => String(((aiMeta || {})[topic] || {}).degradedMode || '') === 'benchmark_only');
  const confDropTopics = AI_TOPICS.filter(topic => Number(((aiMeta || {})[topic] || {}).eventDroppedMissingConf || 0) > 0);
  sh.getRange(22, 1, 1, 11).setBackground('#ffffff').setFontColor('#666666').setFontWeight('normal').clearContent();
  sh.getRange(22, 1, 1, 11).merge();
  sh.getRange(22, 1, 1, 11).setWrap(true).setVerticalAlignment('middle');
  sh.setRowHeight(22, 30);
  if (noDataTopics.length) {
    const confNote = confDropTopics.length ? `（confidence欠落でevent不採用: ${confDropTopics.join(', ')}）` : '';
    sh.getRange(22, 1).setValue(`⚠ AI調査データなし: ${noDataTopics.join(', ')} → A-4を再実行してください${confNote}`).setBackground('#f4cccc').setFontColor('#b71c1c').setFontWeight('bold');
  } else {
    const parts = [];
    if (eventOnlyTopics.length) parts.push(`ベンチマーク未取得・イベント情報で評価: ${eventOnlyTopics.join(', ')}`);
    if (benchmarkOnlyTopics.length) parts.push(`イベント未取得・ベンチマークで評価: ${benchmarkOnlyTopics.join(', ')}`);
    if (confDropTopics.length) parts.push(`confidence欠落で一部event不採用: ${confDropTopics.join(', ')}`);
    const note = parts.length ? `参考（いずれも正常範囲）: ${parts.join(' / ')}` : 'AI調査: 全トピックを正常に評価しました';
    sh.getRange(22, 1).setValue(note).setBackground('#ffffff').setFontColor('#666666').setFontWeight('normal');
  }
  sh.getRange(23, 1, 1, 6).merge();
  const allTopicNeutralized = AI_TOPICS.every(topic => !!(((aiMeta || {})[topic] || {}).neutralized));
  const aiNeutralizedFlag = !!((dTop || {}).aiNeutralized);
  if (allTopicNeutralized || aiNeutralizedFlag) {
    sh.getRange(23, 1).setValue('AIスコアは信頼度不足のため予測への影響を中立化しました（kAI=1.00 / 予測は過去実績ベースのみで算出）')
      .setBackground('#d9ead3').setFontColor('#274e13').setFontWeight('bold').setWrap(true).setVerticalAlignment('top');
  } else {
    sh.getRange(23, 1).setValue('').setBackground('#ffffff').setFontWeight('normal');
  }
  sh.setRowHeight(23, 30);

  let row = 24;

  const seasonalWeightedCore = forecastSeasonalWeighted48_({
    adjustedBaseSeries48: result.adjustedBaseSeries48 || result.baseSeries48 || [],
    seriesStart: result.seriesStart,
    lastClosedMonthStart: result.lastClosedMonthStart,
    spotBackgroundExpectedByMonth: result.spotBackgroundByMonth || new Array(12).fill(0),
    knownSpotExpectedByMonth: result.knownSpotExpectedByMonth || new Array(12).fill(0),
    tuning: tuningTop
  });
  const seasonalCompareWarnThreshold = isFinite(tuningTop.seasonalCompareWarnThreshold) ? tuningTop.seasonalCompareWarnThreshold : SEASONAL_COMPARE_WARN_THRESHOLD;
  const quantTotal = hasOpenMonths ? kpiCal.quantTotal : sumArr_(quantP50);
  const seasonalCompare = quantTotal !== 0 ? Math.abs((seasonalWeightedCore.annualTotal - quantTotal) / quantTotal) : 0;
  if (seasonalCompare >= seasonalCompareWarnThreshold) {
    seasonalWeightedCore.diagnostics.warningText = `⚠ Seasonal totalがQuant totalと${(seasonalCompare * 100).toFixed(1)}%乖離`;
  }
  const d = result.mixedDiagnostics || {};
  const annualMixedCalSim = aggregateAnnualSim_(d.totalCalibratedSimByMonth || []);
  const annualMixedRawSim = aggregateAnnualSim_(d.totalRawSimByMonth || []);
  const annualQuantSim = aggregateAnnualSim_((d.quantOpsSimByMonth || []).map((arr, i) => arr.map((v, s) => Number(v || 0) + Number(((d.bgSpotSimByMonth || [])[i] || [])[s] || 0))));
  const mixedLabelSuffix = (result.closedMonthMode === 'forecast') ? '（本命：この年度合計 P50 を計画値に使用）' : '';
  const objectiveLabelSuffix = (result.closedMonthMode === 'forecast') ? '（参考：定量土台のみ）' : '';

  // ===== セクション1：混合 =====
  row = writeSectionBlock_(sh, row, {
    label: '過去売上（客観）と担当者情報（主観）を混合させたシミュレーション予測' + mixedLabelSuffix,
    labelBg: COLOR_SECTION_SOFT,
    months: result.months,
    series: result.mixed,
    regTotal: result.regTotal,
    chartTitle: `混合：FY${fy} 月次予測レンジ（${client} / P10-P50-P90 + 回帰）`,
    spotFixedByMonth: result.spotFixedByMonth,
    devFixedByMonth: result.devFixedByMonth,
    spotBackgroundByMonth: result.spotBackgroundByMonth,
    seasonalWeighted: seasonalWeightedCore,
    annualSim: annualMixedCalSim,
    budgetColumns: true,
    outputRangeExplainText: OUTPUT_RANGE_EXPLAIN_MAIN_TEXT,
    outputRangeExplainPrimary: true
  });

  row += 2;

  // ===== セクション2：客観のみ =====
  row = writeSectionBlock_(sh, row, {
    label: '過去売上のみ（客観）によるシミュレーション予測' + objectiveLabelSuffix,
    labelBg: COLOR_SECTION_SOFT,
    months: result.months,
    series: result.objOnly,
    regTotal: result.regTotal,
    chartTitle: `客観のみ：FY${fy} 月次予測レンジ（${client} / P10-P50-P90 + 回帰）`,
    spotFixedByMonth: result.spotFixedByMonth,
    devFixedByMonth: result.devFixedByMonth,
    spotBackgroundByMonth: result.spotBackgroundByMonth,
    seasonalWeighted: seasonalWeightedCore,
    annualSim: annualQuantSim,
    outputRangeExplainText: OUTPUT_RANGE_EXPLAIN_OBJECTIVE_TEXT,
    outputRangeExplainPrimary: false
  });

  row += 2;

  // 参考：内訳（P50比較）
  sh.getRange(row, 1).setValue('（参考）内訳とメモ（P50比較）');
  sh.getRange(row, 1).setFontWeight('bold');
  sh.getRange(row, 1, 1, 11).merge();
  row++;

  sh.getRange(row, 1).setValue('※「運用(Ops)」はBASEのトレンド＋季節性から推定。背景SPOT（定量）とknown spot（定性）を分離して扱います。');
  sh.getRange(row, 1, 1, 11).merge();
  sh.getRange(row, 1).setFontColor('#666666').setFontSize(10);
  row++;

  const hdr = ['Month', 'ActualClosed', 'ForecastSource', '運用(Ops)P50（定量）', '運用(Ops)P50（混合）', '背景SPOT（定量）', 'known spot（定性）', 'Total P50（定量）', 'Total P50（混合）', '差分(Mixed-Quant)', 'OPINIONS要約'];
  sh.getRange(row, 1, 1, hdr.length).setValues([hdr]).setBackground(COLOR_HEADER).setFontWeight('bold');
  row++;

  const spotFixed = result.spotFixedByMonth || result.devFixedByMonth;
  const rows = result.months.map((m, i) => {
    const objP50 = (result.quantOnly || result.objOnly).p50[i];
    const mixP50 = result.mixed.p50[i];
    const bgSpot = (result.spotBackgroundByMonth || [])[i] || 0;
    const knownSpot = (result.knownSpotExpectedByMonth || [])[i] || 0;
    const spotVal = bgSpot + knownSpot;
    const opsObj = Math.max(0, objP50 - bgSpot);
    const opsMix = Math.max(0, mixP50 - spotVal);
    return [
      fmtYM_(m),
      result.actualClosedByMonth ? (result.actualClosedByMonth[i] || '') : '',
      result.sourceByMonth ? (result.sourceByMonth[i] || 'forecast_open') : 'forecast_open',
      opsObj,
      opsMix,
      bgSpot,
      knownSpot,
      objP50,
      mixP50,
      mixP50 - objP50,
      result.opinionsSummaryByMonth[i] || ''
    ];
  });

  sh.getRange(row, 1, rows.length, hdr.length).setValues(rows);
  sh.getRange(row, 2, rows.length, 1).setNumberFormat('¥#,##0');
  sh.getRange(row, 4, rows.length, 7).setNumberFormat('¥#,##0');
  sh.getRange(row, 11, rows.length, 1).setWrap(true);
  row += rows.length + 2;

  // ===== セクション3：三角測量（手法比較） =====
  sh.getRange(row, 1).setValue('Triangulation View（手法比較）');
  sh.getRange(row, 1, 1, 8).merge();
  sh.getRange(row, 1).setBackground('#d9e1f2').setFontWeight('bold');
  row++;
  sh.getRange(row, 1).setValue(`※ MonteCarlo: 残差分布を用いた確率予測 / Linear: 線形トレンド外挿 / ${SEASONAL_WEIGHTED_TOTAL_EXPLAIN_TEXT}`);
  sh.getRange(row, 1, 1, 8).merge();
  sh.getRange(row, 1).setFontColor('#666666').setFontSize(10).setWrap(true);
  row++;

  const seasonalWeighted = seasonalWeightedCore;
  const quantP50Tri = (result.quantOnly || result.objOnly).p50;
  const triHdr = ['比較軸', 'MonteCarlo P50', 'Linear', 'Seasonal Weighted Total', 'Mixed Raw P50', 'Mixed Calibrated P50', 'Calibrated-Quant', 'Calibrated-Seasonal'];
  const sumReg = sumArr_(result.regTotal);
  const sumObj = sumArr_(quantP50Tri);
  const sumMixRaw = sumArr_(mixedRawP50);
  const sumMix = sumArr_(result.mixed.p50);
  const sumSea = seasonalWeighted.annualTotal || 0;
  const triAnnual = ['年度合計', sumObj, sumReg, sumSea, sumMixRaw, sumMix, sumMix - sumObj, sumMix - sumSea];
  sh.getRange(row, 1, 1, triHdr.length).setValues([triHdr]).setBackground(COLOR_HEADER).setFontWeight('bold');
  row++;
  sh.getRange(row, 1, 1, triAnnual.length).setValues([triAnnual]);
  sh.getRange(row, 2, 1, triAnnual.length - 1).setNumberFormat('¥#,##0');
  row += 2;

  const triMonthHdr = ['Month', 'MonteCarlo P50', 'Linear', 'Seasonal Weighted Total', 'Mixed Raw P50', 'Mixed Calibrated P50', 'Calibrated-Quant', 'Calibrated-Seasonal'];
  sh.getRange(row, 1, 1, triMonthHdr.length).setValues([triMonthHdr]).setBackground(COLOR_HEADER).setFontWeight('bold');
  row++;
  const triMonthRows = result.months.map((m, i) => [
    fmtYM_(m),
    quantP50Tri[i],
    result.regTotal[i],
    (seasonalWeighted.totalByMonth || [])[i] || 0,
    mixedRawP50[i] || 0,
    result.mixed.p50[i],
    result.mixed.p50[i] - quantP50Tri[i],
    result.mixed.p50[i] - (((seasonalWeighted.totalByMonth || [])[i]) || 0)
  ]);
  sh.getRange(row, 1, triMonthRows.length, triMonthHdr.length).setValues(triMonthRows);
  sh.getRange(row, 2, triMonthRows.length, triMonthHdr.length - 1).setNumberFormat('¥#,##0');
  row += triMonthRows.length + 2;

  // ===== セクション4：入力パラメータの影響可視化 =====
  sh.getRange(row, 1).setValue('入力パラメータの影響（目安）');
  sh.getRange(row, 1, 1, 11).merge();
  sh.getRange(row, 1).setBackground('#e2f0d9').setFontWeight('bold');
  row++;

  const kProd = d.kProdByMonth || new Array(12).fill(1);
  const kClient = d.kClientByMonth || new Array(12).fill(1);
  const kOpinion = d.kOpinionP50ByMonth || new Array(12).fill(1);
  const kAI = d.kAIByMonth || new Array(12).fill(1);
  const opsBase = d.opsBaseByMonth || new Array(12).fill(0);

  const infHdr = ['Month', 'Ops基礎', 'kProd', 'kClient', 'kOpinion(P50)', 'kAI', 'Known Spot Expected', 'Known Spot P50', '背景SPOT(P50)', '混合P50(cal)', '混合P50(raw)', '定量P50'];
  sh.getRange(row, 1, 1, infHdr.length).setValues([infHdr]).setBackground(COLOR_HEADER).setFontWeight('bold');
  row++;
  const infRows = result.months.map((m, i) => [
    fmtYM_(m),
    opsBase[i] || 0,
    kProd[i] || 1,
    kClient[i] || 1,
    kOpinion[i] || 1,
    kAI[i] || 1,
    (result.knownSpotExpectedByMonth || [])[i] || 0,
    (d.knownSpotP50ByMonth || [])[i] || 0,
    (d.bgSpotP50ByMonth || [])[i] || 0,
    result.mixed.p50[i] || 0,
    mixedRawP50[i] || 0,
    (result.quantOnly || result.objOnly).p50[i] || 0
  ]);
  sh.getRange(row, 1, infRows.length, infHdr.length).setValues(infRows);
  sh.getRange(row, 2, infRows.length, 1).setNumberFormat('¥#,##0');
  sh.getRange(row, 3, infRows.length, 4).setNumberFormat('0.000');
  sh.getRange(row, 7, infRows.length, 6).setNumberFormat('¥#,##0');

  row += infRows.length + 2;
  const diag = d.qualCalibration || {};
  sh.getRange(row, 1).setValue('Diagnostics').setFontWeight('bold').setBackground('#fde9d9');
  sh.getRange(row, 1, 1, 6).merge();
  row++;
  const diagHdr = ['rawSubjectiveShare', 'rawTotalQualShare', 'calibratedSubjectiveShare', 'calibratedTotalQualShare', 'qualScale', 'qualCapHit', 'seasonalBaseAnnual', 'seasonalExpectedSpotAnnual', 'seasonalTotalAnnual', 'seasonalCompareWarning', 'qualCompareWarning'];
  const diagRow = [[
    diag.rawSubjectiveShare || 0,
    diag.rawTotalQualShare || 0,
    diag.calibratedSubjectiveShare || 0,
    diag.calibratedTotalQualShare || 0,
    diag.qualScale || 1,
    diag.qualCapHit ? 'YES' : 'NO',
    seasonalWeighted.annualBase || 0,
    seasonalWeighted.annualExpectedSpot || 0,
    seasonalWeighted.annualTotal || 0,
    seasonalWeighted.diagnostics && seasonalWeighted.diagnostics.warningText ? seasonalWeighted.diagnostics.warningText : '',
    diag.warningText || ''
  ]];
  sh.getRange(row, 1, 1, diagHdr.length).setValues([diagHdr]).setBackground(COLOR_HEADER).setFontWeight('bold');
  row++;
  sh.getRange(row, 1, 1, diagHdr.length).setValues(diagRow);
  sh.getRange(row, 1, 1, 5).setNumberFormat('0.0000');
  sh.getRange(row, 7, 1, 3).setNumberFormat('¥#,##0');
  row++;
  const monthRangeRatioAvg = averageMonthRangeRatio_(result.mixed.p10 || [], result.mixed.p50 || [], result.mixed.p90 || []);
  const annualP10 = percentile_(annualMixedCalSim, 0.10);
  const annualP50 = percentile_(annualMixedCalSim, 0.50);
  const annualP90 = percentile_(annualMixedCalSim, 0.90);
  const annualRangeRatio = annualP50 !== 0 ? (annualP90 - annualP10) / Math.abs(annualP50) : 0;
  const rangeWarn = (monthRangeRatioAvg > RANGE_MONTH_WARN || annualRangeRatio > RANGE_ANNUAL_WARN) ? '⚠ range大きめ' : 'OK';
  sh.getRange(row, 1, 1, 4).setValues([['monthly range ratio avg', 'annual range ratio', 'range warning', 'raw annual range ratio']]).setBackground(COLOR_HEADER).setFontWeight('bold');
  row++;
  const rawAnnualP10 = percentile_(annualMixedRawSim, 0.10);
  const rawAnnualP50 = percentile_(annualMixedRawSim, 0.50);
  const rawAnnualP90 = percentile_(annualMixedRawSim, 0.90);
  const rawAnnualRangeRatio = rawAnnualP50 !== 0 ? (rawAnnualP90 - rawAnnualP10) / Math.abs(rawAnnualP50) : 0;
  sh.getRange(row, 1, 1, 4).setValues([[monthRangeRatioAvg, annualRangeRatio, rangeWarn, rawAnnualRangeRatio]]);
  sh.getRange(row, 1, 1, 2).setNumberFormat('0.0%');
  sh.getRange(row, 4).setNumberFormat('0.0%');

  if (result.dlmMode && result.dlmMode !== 'off') {
    row += 2;
    const dlmTitle = (result.dlmMode === 'primary')
      ? '【primary】DLM BASE予測（対数空間DLM / BASEを計画値に反映済み）'
      : (result.dlmMode === 'primary_fallback')
        ? '【primary→fallback】DLM BASE予測（実績不足で未反映 / 計画値は既存Ops）'
        : '【shadow】DLM BASE予測（対数空間DLM / 計画値には未反映）';
    sh.getRange(row, 1).setValue(dlmTitle)
      .setFontWeight('bold').setBackground(result.dlmMode === 'primary' ? '#d9ead3' : '#fff2cc');
    sh.getRange(row, 1, 1, 7).merge();
    row++;

    const dlm = result.dlmForecast || {};
    if (!dlm.ready) {
      const fallbackText = result.dlmMode === 'primary_fallback'
        ? 'primaryを要求しましたが実績不足のため既存Opsで計画しました。'
        : '';
      sh.getRange(row, 1).setValue(`DLM予測は算出できませんでした（理由: ${dlm.reason || 'unknown'}）。 ${fallbackText}adminInitDLMAndBacktest の実績要件を確認してください。`)
        .setFontColor('#b71c1c');
      sh.getRange(row, 1, 1, 7).merge();
      row++;
    } else {
      const mt = dlm.metrics || {};
      sh.getRange(row, 1).setValue(
        `参考バックテスト: sMAPE=${(Number(mt.smape || 0) * 100).toFixed(1)}% / `
        + `WAPE=${(Number(mt.wape || 0) * 100).toFixed(1)}% / coverage=${(Number(mt.coverage || 0) * 100).toFixed(1)}%`
        + `（n=${Number(mt.nPoints || 0)} / 被覆の名目値は80%）`)
        .setFontColor('#666666').setFontSize(10);
      sh.getRange(row, 1, 1, 7).merge();
      row++;

      const hdr = ['Month', 'ForecastSource', 'DLM_BASE P10', 'DLM_BASE P50', 'DLM_BASE P90', '参考:旧Ops_BASE(定量)P50', '差分(DLM-既存)'];
      sh.getRange(row, 1, 1, hdr.length).setValues([hdr]).setBackground(COLOR_HEADER).setFontWeight('bold');
      row++;

      const refQuantP50 = ((result.opsQuantOnly || result.quantOnly || result.objOnly || {}).p50) || [];
      const bg = result.spotBackgroundByMonth || [];
      const dlmRows = result.months.map((m, i) => {
        const opsBaseQuant = Math.max(0, Number(refQuantP50[i] || 0) - Number(bg[i] || 0));
        const d50 = (dlm.p50[i] === null || dlm.p50[i] === undefined) ? '' : Number(dlm.p50[i]);
        const diff = (d50 === '') ? '' : (d50 - opsBaseQuant);
        return [
          fmtYM_(m),
          (result.sourceByMonth ? (result.sourceByMonth[i] || 'forecast_open') : 'forecast_open'),
          (dlm.p10[i] === null || dlm.p10[i] === undefined) ? '' : Number(dlm.p10[i]),
          d50,
          (dlm.p90[i] === null || dlm.p90[i] === undefined) ? '' : Number(dlm.p90[i]),
          opsBaseQuant,
          diff
        ];
      });
      sh.getRange(row, 1, dlmRows.length, hdr.length).setValues(dlmRows);
      sh.getRange(row, 3, dlmRows.length, 5).setNumberFormat('¥#,##0');
      row += dlmRows.length + 1;

      const sumD10 = sumArr_((dlm.p10 || []).filter(v => v !== null && v !== undefined));
      const sumD50 = sumArr_((dlm.p50 || []).filter(v => v !== null && v !== undefined));
      const sumD90 = sumArr_((dlm.p90 || []).filter(v => v !== null && v !== undefined));
      const sumOps = result.months.reduce((a, m, i) => a + Math.max(0, Number((refQuantP50[i] || 0)) - Number((bg[i] || 0))), 0);
      sh.getRange(row, 1, 1, 7).setValues([['年度合計（BASE / shadow比較）', 'ΣP10(参考)', 'ΣP50', 'ΣP90(参考)', '参考:旧Ops_BASE ΣP50', '差分(DLM-既存)', '']]).setBackground(COLOR_HEADER).setFontWeight('bold');
      row++;
      sh.getRange(row, 1, 1, 7).setValues([['DLM BASE 年度', sumD10, sumD50, sumD90, sumOps, sumD50 - sumOps, '']]);
      sh.getRange(row, 2, 1, 5).setNumberFormat('¥#,##0');
      row++;

      const tailNote = (result.dlmMode === 'primary')
        ? '※ primaryモード：上記DLM BASEが計画値（上部P50/P10/P90）に反映されています。主観は月次cap内でそのまま、SPOTは従来どおりこの上に乗算/加算されます。'
        : (result.dlmMode === 'primary_fallback')
          ? '※ primary要求でしたが実績不足のためフォールバック。計画値は既存Opsで算出しています。'
          : '※ shadowモード：上記DLM予測は比較・検証用で、計画値には反映していません。primary化はSTEP 3bで実装済み（CONFIGで切替）。';
      sh.getRange(row, 1).setValue(tailNote)
        .setFontColor('#666666').setFontSize(10);
      sh.getRange(row, 1, 1, 7).merge();
      row++;
    }
  }
  row = writeLmdiDecompositionBlock_(sh, row, result);

  // OUTPUT全体を上下中央寄せに統一する（左右配置は変更しない / request: 上下を真ん中に）。
  // 個別セルの setVerticalAlignment('top') を最後に一括上書きする。チャート・結合セル・horizontal配置には影響しない。
  const outputLastRow = Math.max(1, sh.getLastRow());
  const outputLastCol = Math.max(1, sh.getLastColumn());
  sh.getRange(1, 1, outputLastRow, outputLastCol).setVerticalAlignment('middle');
}

function writeLmdiDecompositionBlock_(sh, row, result) {
  const d = result && result.mixedDiagnostics ? result.mixedDiagnostics : {};
  const lmdi = d.lmdi;
  if (!lmdi) return row;

  const sourceByMonth = result.sourceByMonth || [];
  const openIdx = [];
  for (let i = 0; i < (result.months || []).length; i++) {
    if (sourceByMonth[i] !== 'actual_closed') openIdx.push(i);
  }
  if (!openIdx.length) return row;

  const sumOpen = arr => openIdx.reduce((a, i) => a + Number((arr || [])[i] || 0), 0);
  const quantMeanByMonth = (d.quantOpsSimByMonth || []).map(meanArr_);
  const bgMeanByMonth = (d.bgSpotSimByMonth || []).map(meanArr_);
  const knownMeanByMonth = (d.knownSpotSimByMonth || []).map(meanArr_);
  const lMean = lmdi.meanContribByMonth || {};
  const capMean = lmdi.meanCapAdjByMonth || new Array(12).fill(0);

  const meanItems = [
    { label: '定量土台(Q)', value: sumOpen(quantMeanByMonth) },
    { label: '背景SPOT(B)', value: sumOpen(bgMeanByMonth) },
    { label: 'Known Spot(K)', value: sumOpen(knownMeanByMonth) },
    { label: '主観:PRODUCT(kProd)', value: sumOpen(lMean.kProd || []) },
    { label: '主観:CLIENT(kClient)', value: sumOpen(lMean.kClient || []) },
    { label: '主観:OPINIONS(kOpinion)', value: sumOpen(lMean.kOpinion || []) },
    { label: '主観:AI(kAI)', value: sumOpen(lMean.kAI || []) },
    { label: 'cap調整(cap_adj)', value: sumOpen(capMean) }
  ];
  const meanTotal = meanItems.reduce((a, x) => a + Number(x.value || 0), 0);
  const p50Total = openIdx.reduce((a, i) => a + Number(((result.mixed || {}).p50 || [])[i] || 0), 0);

  row += 2;
  sh.getRange(row, 1).setValue('主観寄与の厳密加法分解（LMDI / 参考診断）').setFontWeight('bold').setBackground('#d9ead3');
  sh.getRange(row, 1, 1, 8).merge();
  row++;
  sh.getRange(row, 1).setValue('Σ(各ソース) + cap調整 = 主観オーバーレイ(S_scaled)。シェアは全sim平均で厳密加法、表示円額はP50_totalに按分。')
    .setFontColor('#666666').setFontSize(10);
  sh.getRange(row, 1, 1, 8).merge();
  row++;

  const shareHdr = ['寄与ソース', 'シェア(%)', '按分額(円/P50基準)', '平均寄与(円)'];
  sh.getRange(row, 1, 1, shareHdr.length).setValues([shareHdr]).setBackground(COLOR_HEADER).setFontWeight('bold');
  row++;
  const shareRows = meanItems.map(x => {
    const share = Math.abs(meanTotal) > 1e-9 ? Number(x.value || 0) / meanTotal : 0;
    return [x.label, share, share * p50Total, Number(x.value || 0)];
  });
  shareRows.push(['合計', Math.abs(meanTotal) > 1e-9 ? 1 : 0, p50Total, meanTotal]);
  sh.getRange(row, 1, shareRows.length, shareHdr.length).setValues(shareRows);
  sh.getRange(row, 2, shareRows.length, 1).setNumberFormat('0.0%');
  sh.getRange(row, 3, shareRows.length, 2).setNumberFormat('¥#,##0');
  sh.getRange(row + shareRows.length - 1, 1, 1, shareHdr.length).setBackground('#f3f3f3').setFontWeight('bold');
  row += shareRows.length + 2;

  sh.getRange(row, 1).setValue('絶対寄与レンジは土台Qの揺れを含む総振れ（その主観要因でいくら金額が動きうるか）。')
    .setFontColor('#666666').setFontSize(10);
  sh.getRange(row, 1, 1, 16).merge();
  row++;
  const absHdr = ['Month',
    'PRODUCT P10', 'PRODUCT P50', 'PRODUCT P90',
    'CLIENT P10', 'CLIENT P50', 'CLIENT P90',
    'OPINIONS P10', 'OPINIONS P50', 'OPINIONS P90',
    'AI P10', 'AI P50', 'AI P90',
    'cap調整 P10', 'cap調整 P50', 'cap調整 P90'
  ];
  sh.getRange(row, 1, 1, absHdr.length).setValues([absHdr]).setBackground(COLOR_HEADER).setFontWeight('bold');
  row++;
  const abs = lmdi.absRangeByMonth || {};
  const absRows = openIdx.map(i => [
    fmtYM_(result.months[i]),
    (((abs.kProd || {}).p10 || [])[i]) || 0, (((abs.kProd || {}).p50 || [])[i]) || 0, (((abs.kProd || {}).p90 || [])[i]) || 0,
    (((abs.kClient || {}).p10 || [])[i]) || 0, (((abs.kClient || {}).p50 || [])[i]) || 0, (((abs.kClient || {}).p90 || [])[i]) || 0,
    (((abs.kOpinion || {}).p10 || [])[i]) || 0, (((abs.kOpinion || {}).p50 || [])[i]) || 0, (((abs.kOpinion || {}).p90 || [])[i]) || 0,
    (((abs.kAI || {}).p10 || [])[i]) || 0, (((abs.kAI || {}).p50 || [])[i]) || 0, (((abs.kAI || {}).p90 || [])[i]) || 0,
    (((abs.capAdj || {}).p10 || [])[i]) || 0, (((abs.capAdj || {}).p50 || [])[i]) || 0, (((abs.capAdj || {}).p90 || [])[i]) || 0
  ]);
  sh.getRange(row, 1, absRows.length, absHdr.length).setValues(absRows);
  sh.getRange(row, 2, absRows.length, absHdr.length - 1).setNumberFormat('¥#,##0');
  row += absRows.length + 2;

  sh.getRange(row, 1).setValue('相対寄与レンジはQを除いた主観そのものの揺れ。sim不変なFACTORS/AIは幅ゼロ、jitterのあるOPINIONSのみ幅が出る。')
    .setFontColor('#666666').setFontSize(10);
  sh.getRange(row, 1, 1, 13).merge();
  row++;
  const relHdr = ['Month',
    'PRODUCT P10', 'PRODUCT P50', 'PRODUCT P90',
    'CLIENT P10', 'CLIENT P50', 'CLIENT P90',
    'OPINIONS P10', 'OPINIONS P50', 'OPINIONS P90',
    'AI P10', 'AI P50', 'AI P90'
  ];
  sh.getRange(row, 1, 1, relHdr.length).setValues([relHdr]).setBackground(COLOR_HEADER).setFontWeight('bold');
  row++;
  const rel = lmdi.relRangeByMonth || {};
  const relRows = openIdx.map(i => [
    fmtYM_(result.months[i]),
    (((rel.kProd || {}).p10 || [])[i]) || 0, (((rel.kProd || {}).p50 || [])[i]) || 0, (((rel.kProd || {}).p90 || [])[i]) || 0,
    (((rel.kClient || {}).p10 || [])[i]) || 0, (((rel.kClient || {}).p50 || [])[i]) || 0, (((rel.kClient || {}).p90 || [])[i]) || 0,
    (((rel.kOpinion || {}).p10 || [])[i]) || 0, (((rel.kOpinion || {}).p50 || [])[i]) || 0, (((rel.kOpinion || {}).p90 || [])[i]) || 0,
    (((rel.kAI || {}).p10 || [])[i]) || 0, (((rel.kAI || {}).p50 || [])[i]) || 0, (((rel.kAI || {}).p90 || [])[i]) || 0
  ]);
  sh.getRange(row, 1, relRows.length, relHdr.length).setValues(relRows);
  sh.getRange(row, 2, relRows.length, relHdr.length - 1).setNumberFormat('0.000');
  row += relRows.length + 1;
  sh.getRange(row, 1).setValue('PRODUCT/CLIENT/AIの幅が0なのは、現行モデルでこれらが月内定数（sim不変）のため。OPINIONSはsim毎に±5%揺らす設計。')
    .setFontColor('#666666').setFontSize(10);
  sh.getRange(row, 1, 1, 13).merge();
  row++;

  const fallbackCount = Number(lmdi.fallbackCount || 0);
  const nSim = Number(lmdi.nSim || 0);
  sh.getRange(row, 1).setValue(`LMDI線形フォールバック発生sim数: ${fallbackCount} / ${nSim}（Πk<=0 等で対数分解不能だった回数。多い場合は極端な主観入力を確認）`)
    .setFontColor('#666666').setFontSize(10);
  sh.getRange(row, 1, 1, 8).merge();
  if (fallbackCount > 0) sh.getRange(row, 1).setBackground('#fce5cd');
  return row + 1;
}

function writeOutputRangeExplanation_(sh, row, colCount, text, isPrimary) {
  if (!OUTPUT_RANGE_EXPLAIN_ENABLED || !text) return;
  const noteRange = sh.getRange(row, 1, 1, colCount);
  noteRange.merge();
  noteRange
    .setValue(text)
    .setWrap(true)
    .setVerticalAlignment('top')
    .setFontColor('#666666')
    .setFontSize(9)
    .setFontWeight('normal')
    .setBackground('#f3f3f3');
  sh.setRowHeight(row, isPrimary ? 112 : 32);
}

/** セクションブロック（表＋グラフ） */
function writeSectionBlock_(sh, startRow, opt) {
  let r = startRow;

  // ラベル
  sh.getRange(r, 1).setValue(opt.label);
  sh.getRange(r, 1, 1, 7).merge();
  sh.getRange(r, 1).setBackground(opt.labelBg).setFontWeight('bold');
  r++;

  // 年度合計（B=Downside / C=Baseline / D=Upside）
  const annualSim = Array.isArray(opt.annualSim) && opt.annualSim.length ? opt.annualSim : null;
  const sumPos = annualSim ? percentile_(annualSim, 0.90) : sumArr_(opt.series.p90);
  const sumNeu = annualSim ? percentile_(annualSim, 0.50) : sumArr_(opt.series.p50);
  const sumNeg = annualSim ? percentile_(annualSim, 0.10) : sumArr_(opt.series.p10);
  const sumReg = sumArr_(opt.regTotal);
  const seasonalTotalByMonth = (opt.seasonalWeighted && opt.seasonalWeighted.totalByMonth) ? opt.seasonalWeighted.totalByMonth : new Array(12).fill(0);
  const sumSeasonal = sumArr_(seasonalTotalByMonth);
  const sumRange = sumPos - sumNeg;

  const annualHdr = ['年度合計（シミュレーション予測）', 'Downside(P10)', 'Baseline(P50)', 'Upside(P90)', 'Linear Regression', 'Seasonal Weighted Total', 'Range(P90-P10)'];
  const annualVal = ['年度合計（予測）', sumNeg, sumNeu, sumPos, sumReg, sumSeasonal, sumRange];

  const annualHeaderRow = r;
  sh.getRange(r, 1, 1, annualHdr.length).setValues([annualHdr]).setBackground(COLOR_HEADER).setFontWeight('bold');
  // BCDだけ意味色に
  sh.getRange(r, 2).setBackground(COLOR_NEG);
  sh.getRange(r, 3).setBackground(COLOR_NEU);
  sh.getRange(r, 4).setBackground(COLOR_POS);
  r++;

  sh.getRange(r, 1, 1, annualVal.length).setValues([annualVal]);
  sh.getRange(r, 2, 1, 6).setNumberFormat('¥#,##0');

  // 意味色（値行）
  sh.getRange(r, 2).setBackground(COLOR_NEG);
  sh.getRange(r, 3).setBackground(COLOR_NEU);
  sh.getRange(r, 4).setBackground(COLOR_POS);
  r++;

  // 年度合計と月次表の間は短い1行注記のみ（primaryの長文はセクション末尾へ移す）。客観は従来の1行注記のまま。
  const betweenExplainText = opt.outputRangeExplainPrimary ? OUTPUT_RANGE_EXPLAIN_PRIMARY_SHORT_TEXT : opt.outputRangeExplainText;
  writeOutputRangeExplanation_(sh, r, annualHdr.length, betweenExplainText, false);
  let sectionExplainRow = 0;

  // 月次表
  r++;
  const hdr = ['Month', 'Downside(P10)', 'Baseline(P50)', 'Upside(P90)', 'Linear Regression', 'Seasonal Weighted Total', 'Range(P90-P10)'];
  sh.getRange(r, 1, 1, hdr.length).setValues([hdr]).setBackground(COLOR_HEADER).setFontWeight('bold');
  const monthTableHeaderRow = r;
  // BCDだけ意味色に
  sh.getRange(r, 2).setBackground(COLOR_NEG);
  sh.getRange(r, 3).setBackground(COLOR_NEU);
  sh.getRange(r, 4).setBackground(COLOR_POS);
  r++;

  const table = opt.months.map((m, i) => {
    const pos = opt.series.p90[i];
    const neu = opt.series.p50[i];
    const neg = opt.series.p10[i];
    const reg = opt.regTotal[i];
    const sea = seasonalTotalByMonth[i] || 0;
    return [fmtYM_(m), neg, neu, pos, reg, sea, (pos - neg)];
  });

  sh.getRange(r, 1, table.length, hdr.length).setValues(table);
  sh.getRange(r, 2, table.length, 6).setNumberFormat('¥#,##0');
  sh.getRange(r, 1, table.length, 1).setNumberFormat('@');

  // 意味色（列全体）
  sh.getRange(r, 2, table.length, 1).setBackground(COLOR_NEG);
  sh.getRange(r, 3, table.length, 1).setBackground(COLOR_NEU);
  sh.getRange(r, 4, table.length, 1).setBackground(COLOR_POS);

  // ===== 予算列（H/I/J）：混合（本命）セクションのみ =====
  // H=Adopted Forecast（採用予測 / 月次P50を初期値・手入力で上書き可）
  // I=Sales Uplift（営業上積み / 手入力・空欄は0扱い）
  // J=Final Budget（=H+I）。年度合計は月次のSUM。
  if (opt.budgetColumns) {
    const budgetHdr = [['Adopted Forecast', 'Sales Uplift', 'Final Budget']];
    const mStart = r;                     // 月次データ先頭行
    const mEnd = r + table.length - 1;    // 月次データ末尾行
    const annualBudgetRow = annualHeaderRow + 1;

    // 予算ブロックの見出し（H列起点）：H{startRow}:J{startRow} に「予算を策定」を結合表示（客観セクションには出さない）。
    const budgetTitleRange = sh.getRange(startRow, 8, 1, 3);
    budgetTitleRange.merge();
    budgetTitleRange.setValue('予算を策定').setBackground(COLOR_SECTION_SOFT).setFontWeight('bold').setHorizontalAlignment('left');
    sh.getRange(startRow, 8).setNote('予算を策定：会社へ打ち上げる予算を確定するブロックです。月次の Adopted Forecast（採用予測）と Sales Uplift（営業上積み）を入力すると、Final Budget（=両者の合計）が自動計算されます。');

    // 年度バンド：ヘッダ＋月次SUM
    sh.getRange(annualHeaderRow, 8, 1, 3).setValues(budgetHdr).setBackground(COLOR_HEADER).setFontWeight('bold');
    sh.getRange(annualBudgetRow, 8, 1, 3).setFormulas([[
      `=SUM(H${mStart}:H${mEnd})`,
      `=SUM(I${mStart}:I${mEnd})`,
      `=SUM(J${mStart}:J${mEnd})`
    ]]);
    sh.getRange(annualBudgetRow, 8, 1, 3).setNumberFormat('¥#,##0').setBackground(COLOR_SECTION_SOFT).setFontWeight('bold');

    // 月次バンド：ヘッダ
    sh.getRange(monthTableHeaderRow, 8, 1, 3).setValues(budgetHdr).setBackground(COLOR_HEADER).setFontWeight('bold');
    // H：月次P50を初期値（数値・手入力で上書き可）
    const hInit = opt.months.map((_, i) => [Number((opt.series.p50 || [])[i] || 0)]);
    sh.getRange(mStart, 8, table.length, 1).setValues(hInit);
    // J：=H+I（月次）
    const jFormulas = opt.months.map((_, i) => [`=H${mStart + i}+I${mStart + i}`]);
    sh.getRange(mStart, 10, table.length, 1).setFormulas(jFormulas);
    // 書式・色（H/I=編集可/黄、J=確定/緑・太字）。I は空欄スタート（手入力）。
    sh.getRange(mStart, 8, table.length, 3).setNumberFormat('¥#,##0');
    sh.getRange(mStart, 8, table.length, 2).setBackground(COLOR_OBJECTIVE);
    sh.getRange(mStart, 10, table.length, 1).setBackground(COLOR_SECTION_SOFT).setFontWeight('bold');

    // NOTE（非技術者向けホバー説明）
    sh.getRange(monthTableHeaderRow, 8).setNote('Adopted Forecast（採用予測）：ディレクター/営業が最終的に予測として採用する金額を月ごとに入力します。初期値は混合シミュレーションの Baseline(P50)。上書きしてください。');
    sh.getRange(monthTableHeaderRow, 9).setNote('Sales Uplift（営業上積み）：採用予測に営業目線で上積みする金額を月ごとに入力します。空欄は0として扱います。');
    sh.getRange(monthTableHeaderRow, 10).setNote('Final Budget（最終予算）＝Adopted Forecast＋Sales Uplift。会社へ予算として打ち上げる最終確定額です（自動計算）。');
    sh.getRange(annualHeaderRow, 8).setNote('年度合計（採用予測）＝月次 Adopted Forecast の合計（SUM）。');
    sh.getRange(annualHeaderRow, 9).setNote('年度合計（営業上積み）＝月次 Sales Uplift の合計（SUM）。');
    sh.getRange(annualHeaderRow, 10).setNote('年度合計（最終予算）＝月次 Final Budget の合計（SUM）。会社へ打ち上げる年間予算額。');

    // 予算ブロック（見出し〜月次 Final Budget）を控えめに囲む：H{startRow}:J{mEnd} の外周のみ（内側罫線なし）。
    sh.getRange(startRow, 8, mEnd - startRow + 1, 3)
      .setBorder(true, true, true, true, false, false, '#6aa84f', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  }

  // P10/P50/P90説明（Note）※最初に登場する年度合計ヘッダに付与
  sh.getRange(annualHeaderRow, 2).setNote('【Downside(P10)】\nシミュレーション分布の10パーセンタイル（下位10%点）です。\n通常想定より弱い条件が重なった場合の下振れ目安で、悲観ケースの確認に使います。');
  sh.getRange(annualHeaderRow, 3).setNote('【Baseline(P50)】\nシミュレーション分布の中央値（50パーセンタイル）です。\n通常運用時の中心シナリオで、まずこの値を基準に計画を立てます。');
  sh.getRange(annualHeaderRow, 4).setNote('【Upside(P90)】\nシミュレーション分布の90パーセンタイル（上位10%点）です。\n好条件が重なった場合の上振れ目安として、機会側の確認に使います。');
  sh.getRange(annualHeaderRow, 5).setNote('【Linear Regression】\n過去売上（ならした推移）へ単純な直線を当てて将来を外挿した参考値です。\nシナリオ分布とは独立した「トレンド比較用」の補助線として使います。');
  sh.getRange(annualHeaderRow, 6).setNote(`【Seasonal Weighted Total】\n${SEASONAL_WEIGHTED_TOTAL_EXPLAIN_TEXT}\n※シミュレーション本体とは別系統の参照推計です。`);
  sh.getRange(annualHeaderRow, 7).setNote('【Range(P90-P10)】\nUpside(P90) - Downside(P10) の幅です。\n値が大きいほど、通常条件から外れたときの振れ幅（不確実性）が大きいことを示します。');
  sh.getRange(monthTableHeaderRow, 2, 1, 6).clearNote();

  // BASE/SPOT分離（SPOTは背景SPOT + DEV固定の合算）
  r += table.length + 2;
  sh.getRange(r, 1).setValue('Scenario Split（BASE / SPOT）').setFontWeight('bold');
  sh.getRange(r, 1, 1, 7).merge();
  sh.getRange(r, 1).setBackground('#e2f0d9');
  r++;

  const spotFixed = opt.spotFixedByMonth || opt.devFixedByMonth || new Array(12).fill(0);
  const splitHdr = [
    'Month',
    'Downside_BASE', 'Downside_SPOT',
    'Baseline_BASE', 'Baseline_SPOT',
    'Upside_BASE', 'Upside_SPOT'
  ];
  const splitHeaderRow = r;
  sh.getRange(r, 1, 1, splitHdr.length).setValues([splitHdr]).setBackground(COLOR_HEADER).setFontWeight('bold');
  r++;

  const splitRows = opt.months.map((m, i) => {
    const spot = Number(spotFixed[i] || 0);
    const neg = Number(opt.series.p10[i] || 0);
    const neu = Number(opt.series.p50[i] || 0);
    const pos = Number(opt.series.p90[i] || 0);
    return [
      fmtYM_(m),
      Math.max(0, neg - spot), spot,
      Math.max(0, neu - spot), spot,
      Math.max(0, pos - spot), spot
    ];
  });
  sh.getRange(r, 1, splitRows.length, splitHdr.length).setValues(splitRows);
  sh.getRange(r, 2, splitRows.length, splitHdr.length - 1).setNumberFormat('¥#,##0');
  sh.getRange(splitHeaderRow, 2).setNote('BASEは「シナリオ値 - SPOT固定（背景SPOT + DEV固定）」を表示しています。');
  sh.getRange(splitHeaderRow, 3).setNote('SPOTは「背景SPOT + DEV_SPOT（既知案件）」の合算表示です。');

  // 「年度≠月次合算」の長文説明は月次の数字の流れを妨げないよう、Scenario Split の下（目立たない位置）へ配置する。
  if (opt.outputRangeExplainPrimary && OUTPUT_RANGE_EXPLAIN_ENABLED && opt.outputRangeExplainText) {
    sectionExplainRow = r + splitRows.length + 2;
    writeOutputRangeExplanation_(sh, sectionExplainRow, annualHdr.length, opt.outputRangeExplainText, true);
  }

  // グラフ系列（凡例順）：Upside → Baseline → Downside → Linear Regression
  const chartMonthRange = sh.getRange(monthTableHeaderRow, 1, table.length + 1, 1);
  const chartUpsideRange = sh.getRange(monthTableHeaderRow, 4, table.length + 1, 1);
  const chartBaselineRange = sh.getRange(monthTableHeaderRow, 3, table.length + 1, 1);
  const chartDownsideRange = sh.getRange(monthTableHeaderRow, 2, table.length + 1, 1);
  const chartLinearRange = sh.getRange(monthTableHeaderRow, 5, table.length + 1, 1);

  const chartRow = startRow + 1;
  const chartCol = 12; // L列開始（H/I/J予算列の右に余白Kを取る）

  const chart = sh.newChart()
    .asLineChart()
    .addRange(chartMonthRange)
    .addRange(chartUpsideRange)
    .addRange(chartBaselineRange)
    .addRange(chartDownsideRange)
    .addRange(chartLinearRange)
    .setNumHeaders(1)
    .setPosition(chartRow, chartCol, 0, 0)
    .setOption('title', opt.chartTitle)
    .setOption('legend', { position: 'right' })
    .setOption('curveType', 'none')
    .setOption('lineWidth', 2)
    .setOption('pointSize', 0)
    .setOption('hAxis', { slantedText: true, slantedTextAngle: 45, showTextEvery: 1 })
    .setOption('vAxis', { format: '¥#,##0' })
    // 色：Upside=青 / Baseline=黄 / Downside=赤 / 回帰=灰
    .setOption('colors', ['#1a73e8', '#fbbc04', '#ea4335', COLOR_REG])
    .setOption('series', { 0:{ lineWidth:3 }, 1:{ lineWidth:4 }, 2:{ lineWidth:3 }, 3:{ lineWidth:3 } })
    .setOption('width', 820)
    .setOption('height', 340)
    .build();

  sh.insertChart(chart);

  // チャートが重ならないよう、次の開始行をチャート分だけ下に送る
  const tableBottom = r + table.length + 2;
  const chartBottom = chartRow + CHART_HEIGHT_ROWS;
  const explainBottom = sectionExplainRow ? (sectionExplainRow + 2) : 0;
  return Math.max(tableBottom, chartBottom, explainBottom);
}

/** ====== シート構築 ====== */
function buildGUIDE_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet_(ss, SHEETS.GUIDE);
  sh.clear({ contentsOnly: true });
  sh.clearFormats();
  sh.setColumnWidth(1, 130);
  sh.setColumnWidth(2, 340);
  sh.setColumnWidth(3, 660);

  const C_A = '#d9e8fb';
  const C_B = '#d9ead3';
  const C_C = '#d9ead3';

  const displayVersion = String(VERSION).replace(/-.*$/, '');
  sh.getRange(1, 1).setValue(`売上予測ツール ガイド（v${displayVersion}）`).setFontSize(16).setFontWeight('bold');
  sh.getRange(2, 1, 1, 3).setValues([['分類', 'Forecast Agentボタンの手順', 'ボタン説明']]).setBackground(COLOR_HEADER).setFontWeight('bold');

  const aRows = [
    ['A-予測', 'A-1 初期セットアップ', '初回のみ。クライアント/FY/担当者を設定。'],
    ['A-予測', 'A-2 売上データを取り込む', '案件一覧を SALES_INPUT へ取り込み。'],
    ['A-予測', 'A-3 予測用に売上データを加工', 'SALES_INPUT のデータを SALES_MONTHLY で48か月横持ち（BASE/SPOT）に集計。'],
    ['A-予測', 'A-4 AI調査を取り込む', '市場/競合/チャネル/DXのAI調査結果を取り込みます。'],
    ['A-予測', 'A-5 製品ごとの動向を入力', 'PRODUCT（全製品）へ入力。'],
    ['A-予測', 'A-6 クライアント動向を入力', 'CLIENT へ入力。'],
    ['A-予測', 'A-7 担当者意見を入力', 'OPINIONS へ入力（担当者全員分）。'],
    ['A-予測', 'A-8 開発/スポット要因を入力', 'DEV_SPOT へ入力。'],
    ['A-予測', 'A-9 予測を実行', 'OUTPUT を更新（実行前に注意ロジックで1件ずつ確認）。'],
    ['A-予測', 'A-10 予算を策定', 'OUTPUT 混合セクションの予算欄（H24〜J40）へ移動。Adopted Forecast / Sales Uplift を入力し Final Budget（=両者の合計）を確定。']
  ];
  sh.getRange(3, 1, aRows.length, 3).setValues(aRows).setBackground(C_A);

  const bRows = [
    ['B-事後検証', 'B-1 検証用に実績データを取り込み', '実績を ACTUAL_EVAL_MONTHLY に取り込み（BASE/SPOT判定つき）。'],
    ['B-事後検証', 'B-2 検証レポートを更新', 'EVAL_LOG と EVAL_COMPARE_MONTHLY を更新。'],
    ['B-事後検証', 'B-3 予測ダッシュボードを更新', 'DASHBOARD を更新（B-2の比較結果からKPIを集計）。'],
    ['B-事後検証', 'B-4 検証インサイトを更新', 'EVAL_INSIGHTS に外れ要因と次アクションを整理。'],
    ['B-事後検証', 'B-5 自動学習（月次補正の更新）', 'EVAL_LOG の誤差から全体補正係数と暦月バイアスをベイズ更新（次回A-9へ自動反映）。']
  ];
  sh.getRange(13, 1, bRows.length, 3).setValues(bRows).setBackground(C_B);

  const cRows = [
    ['C-四半期レビュー', 'C-1 四半期レビューを実行（3か月に1回）', 'AI診断と全体キャリブレーション提案を生成。'],
    ['C-四半期レビュー', 'C-2 承認済み提案を適用', '承認行だけCALIBRATION_STATEへ反映し履歴を更新。'],
    ['C-四半期レビュー', 'C-3 過去の提案履歴を開く', 'QUARTERLY_REVIEW_LOGを表示して履歴を閲覧。']
  ];
  sh.getRange(18, 1, cRows.length, 3).setValues(cRows).setBackground(C_C);

  sh.getRange(22, 1, 1, 3).setValues([['シート分類', 'シート名', 'シート説明']]).setBackground(COLOR_HEADER).setFontWeight('bold');
  const links = [
    ['自動入力用', SHEETS.CONFIG, '設定（クライアント/FY/担当者）'],
    ['自動入力用', SHEETS.SALES_INPUT, '予測入力（月次案件一覧）'],
    ['自動入力用', SHEETS.SALES_MONTHLY, '予測用集計（48ヶ月横持ち / BASE・SPOT）'],
    ['自動入力用', SHEETS.AI_RESEARCH, 'Vertex AI調査サマリー'],
    ['ユーザ入力用', SHEETS.PRODUCT, '製品要因入力'],
    ['ユーザ入力用', SHEETS.CLIENT, 'クライアント要因入力'],
    ['ユーザ入力用', SHEETS.OPINIONS, '担当者意見入力'],
    ['ユーザ入力用', SHEETS.DEV_SPOT, '開発/スポット要因入力'],
    ['出力用', SHEETS.OUTPUT, '予測出力'],
    ['事後検証用', SHEETS.ACTUAL_EVAL_MONTHLY, '検証実績（月次案件一覧）'],
    ['事後検証用', SHEETS.EVAL_COMPARE_MONTHLY, '予測/実績比較（BASE・SPOT）'],
    ['事後検証用', SHEETS.EVAL_LOG, '予測検証ログ'],
    ['事後検証用', SHEETS.DASHBOARD, 'ダッシュボード（KPI集計）'],
    ['事後検証用', SHEETS.EVAL_INSIGHTS, '検証インサイト'],
    ['事後検証用', SHEETS.QUARTERLY_REVIEW, '四半期レビュー（最新）'],
    ['事後検証用', SHEETS.QUARTERLY_REVIEW_LOG, '四半期提案履歴（永続）']
  ];
  setGuideLinkTable_(sh, 23, links);
  applySectionGapRows_(sh, [21]);

  const guideLast = sh.getLastRow();
  const guideCols = Math.max(3, sh.getLastColumn());
  sh.getRange(1, 1, guideLast, guideCols).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sh.getRange(1, 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.OVERFLOW);

  ss.setActiveSheet(sh);
  safeMoveSheet_(ss, sh, 1);
}

function buildCONFIG_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet_(ss, SHEETS.CONFIG);
  sh.clear({ contentsOnly: true });
  sh.clearFormats();

  sh.setColumnWidth(1, 312);
  sh.setColumnWidth(2, 656);

  // 重要情報を上段に配置
  const rows = [
    ['項目', '値'],
    ['[必須] メーカー名（外部集計キー）', ''],
    ['[必須] 予測年度FY（YYYY）', ''],
    ['[必須] 担当者（カンマ区切り）', ''],
    ['[必須] 計画用単一値', PLAN_POINT_ESTIMATE_ROLE],
    ['[任意] P10/P90の説明レンジ', RANGE_EXPLANATION_ROLE],
    ['[任意] 決算期メモ', '3月末'],
    ['[固定] Monte Carlo試行回数', N_SIM],
    ['[固定] 未確定月の扱い', '前月までを確定とみなし、当月以降は同月トレンドで補完して学習（補完後に途中実績より下がらない）'],
    ['[固定] スパイクならし下限比', SPIKE_CLIP_MIN],
    ['[固定] スパイクならし上限比', SPIKE_CLIP_MAX],
    ['[固定] 季節性保護（MAD倍率）', SEASONAL_MAD_K]
  ];

  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  sh.getRange(1, 1, 1, 2).setBackground(COLOR_HEADER).setFontWeight('bold');

  // CONFIG色ルール: 黄色（#fff2cc）はユーザーが値を入力・変更しうる欄のみ。
  // 対象は必須入力B2:B4、環境前提の任意入力。固定値・説明・通常いじらない調整パラメータは黄色にしない。
  sh.getRange('B2:B4').setBackground(COLOR_OBJECTIVE);

  sh.getRange('A2').setNote('外部実績シート（*YYYY_actual_value）のAO列にあるメーカー名と完全一致させます。\n表記ゆれ（全角/半角・(株)有無）があると取り込み対象から外れるため、正式表記を使ってください。');
  sh.getRange('A3').setNote('会計年度のラベルです。\n例：FY2026 = 2026/04/01〜2027/03/31（4月開始・3月決算）。\nこの値をもとに対象12ヶ月を自動計算します。');
  sh.getRange('A4').setNote('シミュレーションに関与する担当者をカンマ区切りで記載します（例: 山田,佐藤）。\nA-7では、ここに列挙した全員分の意見入力が必須です。');
  sh.getRange('A5').setNote('予測に影響あり（高）。計画値はP50で固定します。任意変更不可。');
  sh.getRange('A6').setNote('予測に影響あり（中）。P10/P90は説明帯であり、必須入力ではありません。');
  sh.getRange('A7').setNote('予測に影響なし（低）。メモ用途の任意項目です。');
  sh.getRange('A8').setNote('Monte Carlo試行回数（既定1000）。予測に影響あり（中）。通常は固定運用。');
  sh.getRange('A9').setNote('予測に影響あり（高）。未確定月補完ロジックの説明です。');
  sh.getRange('A10').setNote('予測に影響あり（中）。外れ値のならし下限。固定運用を推奨。');
  sh.getRange('A11').setNote('予測に影響あり（中）。外れ値のならし上限。固定運用を推奨。');
  sh.getRange('A12').setNote('予測に影響あり（中）。季節性保護のMAD倍率。通常は編集不要。');

  const sectionGapRows = 1;
  const envStart = 14;
  sh.getRange(envStart, 1, 1, 2).setValues([['環境前提（任意入力）', '内容（入力必須ではありません）']]).setBackground(COLOR_HEADER).setFontWeight('bold');
  const envRows = [
    ['マクロ｜市場 / 制度前提', ''],
    ['マクロ｜競合前提', ''],
    ['メソ｜クライアント予算 / 体制前提', ''],
    ['メソ｜チャネル / MR / 販促前提', ''],
    ['ミクロ｜製品 / 適応前提', ''],
    ['ミクロ｜Spot / 開発案件前提', ''],
    ['ミクロ｜情報源', ''],
    ['ミクロ｜最終更新日', new Date()]
  ];
  sh.getRange(envStart + 1, 1, envRows.length, 2).setValues(envRows);
  sh.getRange(envStart + 1, 2, envRows.length, 1).setBackground('#fff2cc');
  sh.getRange(envStart + envRows.length, 2).setNumberFormat('yyyy/MM/dd');
  safeSetNote_(sh, envStart, 1, '前提更新はB-3で得た示唆を反映し、最終更新日を必ず更新してください。すべて任意入力です。');
  safeSetNote_(sh, envStart + 1, 1, 'マクロ｜市場 / 制度前提（任意）: 制度改定・薬価・規制変更の時期と内容。予測影響: 高。');
  safeSetNote_(sh, envStart + 2, 1, 'マクロ｜競合前提（任意）: 競合発売時期、シェア変動仮説。予測影響: 中〜高。');
  safeSetNote_(sh, envStart + 3, 1, 'メソ｜クライアント予算 / 体制前提（任意）: 予算確保状況、組織改編、担当増減。予測影響: 高。');
  safeSetNote_(sh, envStart + 4, 1, 'メソ｜チャネル / MR / 販促前提（任意）: 施策開始月、MR配置、販促施策。予測影響: 中〜高。');
  safeSetNote_(sh, envStart + 5, 1, 'ミクロ｜製品 / 適応前提（任意）: 適応追加、供給制約、価格改定。予測影響: 高。');
  safeSetNote_(sh, envStart + 6, 1, 'ミクロ｜Spot / 開発案件前提（任意）: 大型案件時期、失注リスク。予測影響: 高（特にSPOT）。');
  safeSetNote_(sh, envStart + 7, 1, 'ミクロ｜情報源（任意）: 出典URL/社内資料名/会議体を記録。予測影響: 直接なし（説明性に影響）。');
  safeSetNote_(sh, envStart + 8, 1, 'ミクロ｜最終更新日（推奨）: 前提を更新した日。予測影響: 直接なし（監査性に影響）。');

  const policyStart = envStart + 1 + envRows.length + sectionGapRows;
  const policyRows = [
    ['直接目的（事業）', '年間予算の外しすぎ低減、半期見通し精度向上、クライアント別予実管理の底上げ。'],
    ['代理目的 / 指標', 'P50を基準に signed_error・abs_error・WAPE を継続監視し、前提更新へ接続。'],
    ['計画用単一値', 'P50（neutral/baseline）を使用。'],
    ['P10/P90の役割', '説明用レンジ。coverageは診断用途で、成功KPIやhard gateではありません。'],
    ['成功KPI/年間制約', `annual_abs_error_rate <= ${Math.round(ANNUAL_ABS_ERROR_CONSTRAINT * 100)}%`],
    ['成功KPI/半期制約', `half_wape <= ${Math.round(HALF_WAPE_CONSTRAINT * 100)}%（将来目標 ${Math.round(HALF_WAPE_FUTURE_TARGET * 100)}%）`],
    ['バイアス制約', `half/annual over-forecast rate <= ${Math.round(OVERFORECAST_RATE_CONSTRAINT * 100)}%（underも監視し、overを優先管理）`],
    ['診断KPI', '月次APE、Q差分、定量寄与率、主観オーバーレイ率、Known Spot寄与率、range outside count。'],
    ['レンジ逸脱対応', 'actualがP10-P90外の月はB-3で追加調査し、原因仮説・前提更新・入力反映を記録。'],
    ['運用改善アプローチ', '自動最適化器は新設せず、B-2/B-3の評価結果から前提・入力運用を更新する。'],
    ['業務前提', '1 client = 1 book。新クライアントはbookをコピーし、コピー先でA-1を実行。']
  ];
  sh.getRange(policyStart, 1, 1, 2).setValues([['予測運用ポリシー / 成功KPI・制約 / 診断KPI', '定義 / 運用ルール']]).setBackground(COLOR_HEADER).setFontWeight('bold');
  sh.getRange(policyStart + 1, 1, policyRows.length, 2).setValues(policyRows);
  safeSetNote_(sh, policyStart, 1, 'このブロックは「何を最適化し、何を制約し、何を診断するか」を明示します。');
  safeSetNote_(sh, policyStart + 4, 2, 'P10/P90のcoverageは参考診断。primary KPI/hard gate ではありません。');
  safeSetNote_(sh, policyStart + 7, 2, '過大予測（forecast > actual）の抑制を優先管理します。');
  safeSetNote_(sh, policyStart + 9, 2, 'レンジ逸脱月はEVAL_INSIGHTSで原因仮説と次アクションを記録します。');
  policyRows.forEach((r, i) => {
    safeSetNote_(sh, policyStart + 1 + i, 1, `説明: ${r[0]}。\nこの項目は予測運用の参照情報で、通常は編集不要です。`);
  });

  // 管理者が参照しやすいよう上段に配置（読取はラベルキー照合）
  const tuneStart = policyStart + 1 + policyRows.length + sectionGapRows;
  const tuneHdr = [['モデル調整パラメータ', '値（必要時のみ調整）']];
  const tuneRows = [
    ['SPOT_BG_SHRINK（背景SPOT縮小率）', SPOT_BG_SHRINK],
    ['SPOT_BG_FLOOR_RATE（背景SPOT最低保証率）', SPOT_BG_FLOOR_RATE],
    ['SPOT_BG_CAP_RATE（背景SPOT上限/BaseP50比）', SPOT_BG_CAP_RATE],
    ['AI_WEIGHT（AI係数重み）', AI_WEIGHT_DEFAULT],
    ['AI_MAX_ABS_EFFECT（AI係数上限）', AI_MAX_ABS_EFFECT],
    ['AI_MISSING_CONFIDENCE_DEFAULT（AI調査でconfidence欠落時に補完する既定値 0〜1 / 0で欠落行は不採用）', AI_MISSING_CONFIDENCE_DEFAULT],
    ['AI_SCORE_BASIS（level=水準/ momentum=相対位置の変化）', 'level'],
    ['AI_MOMENTUM_LOOKBACK_QUARTERS（モメンタム平滑の四半期数）', 2],
    ['AI_MOMENTUM_MIN_HISTORY（momentum算出に必要な過去run最小数）', 2],
    ['SPOT_SPIKE_MAD_K（SPOTスパイク判定MAD倍率）', SPOT_SPIKE_MAD_K],
    ['KNOWN_SPOT_OFFSET_RATE（known spotの背景相殺率）', KNOWN_SPOT_OFFSET_RATE],
    ['KNOWN_SPOT_BG_SUPPRESS_RATE（known spot命中時の背景抑制）', KNOWN_SPOT_BG_SUPPRESS_RATE],
    ['QUAL_SUBJECTIVE_MONTHLY_CAP（主観の月次上限 / 唯一の制御点）', QUAL_SUBJECTIVE_MONTHLY_CAP],
    ['QUAL_CALIBRATION_ENABLED（1=月次cap適用,0=capなし）', QUAL_CALIBRATION_ENABLED],
    ['SEASONAL_YEAR_WEIGHT_Y1（最古年重み）', SEASONAL_YEAR_WEIGHT_Y1],
    ['SEASONAL_YEAR_WEIGHT_Y2', SEASONAL_YEAR_WEIGHT_Y2],
    ['SEASONAL_YEAR_WEIGHT_Y3', SEASONAL_YEAR_WEIGHT_Y3],
    ['SEASONAL_YEAR_WEIGHT_Y4（最新年重み）', SEASONAL_YEAR_WEIGHT_Y4],
    ['SEASONAL_OPEN_MONTH_WEIGHT_MULT（未確定月信頼度係数）', SEASONAL_OPEN_MONTH_WEIGHT_MULT],
    ['SEASONAL_WEIGHTED_MAD_K（季節推計MAD倍率）', SEASONAL_WEIGHTED_MAD_K],
    ['SEASONAL_COMPARE_WARN_THRESHOLD（Seasonal乖離警告閾値）', SEASONAL_COMPARE_WARN_THRESHOLD],
    ['AI_TOTAL_NEUTRAL_THRESHOLD（AI総合中立化のdead-zone閾値 / 既定0=中立化なし。根拠ある時のみ>0）', AI_TOTAL_NEUTRAL_THRESHOLD],
    ['AI_QUALITY_NEUTRAL_THRESHOLD（品質中立化閾値）', AI_QUALITY_NEUTRAL_THRESHOLD],
    ['AI_QUALITY_PARTIAL_THRESHOLD（品質部分中立化閾値）', AI_QUALITY_PARTIAL_THRESHOLD],
    ['AI_WEIGHT_PROPOSAL_MIN', 0.00005],
    ['AI_WEIGHT_PROPOSAL_MAX', 0.002],
    ['DLM_BACKTEST_MIN_MONTHS（バックテスト最低確定月数）', 24],
    ['DLM_BACKTEST_START_ORIGIN（バックテスト開始原点index）', 18],
    ['DLM_LOG_EPSILON_RATE（対数下限=median比）', 0.01],
    ['DLM_ENGINE_MODE（off/shadow/primary）', 'off'],
    ['DLM_PRIMARY_SPOT_CAP_BASIS（dlm/ols）', 'dlm'],
    ['RELIABILITY_APPLY_ENABLED（0/1）', 1],
    ['RELIABILITY_R_MIN', 0.0],
    ['RELIABILITY_R_MAX', 1.5],
    ['RELIABILITY_SHRINKAGE_K', 4],
    ['RELIABILITY_MIN_SAMPLES', 2],
    ['RELIABILITY_MIN_CHANGE', 0.05],
    ['POOL_MIN_CLIENTS（横断集約の最低クライアント数）', POOL_MIN_CLIENTS_DEFAULT],
    ['LMDI_DECOMPOSITION_ENABLED（主観寄与のLMDI分解表示 0/1）', 0],
    ['FORECAST_CLOSED_MONTH_MODE（actual=実績で上書き表示 / forecast=予測のまま=通年予測）', 'actual'],
    ['VERTEX_PROJECT_ID（Google CloudプロジェクトID）', 'forecast-agent-498907'],
    ['VERTEX_LOCATION（リージョン。grounding は global 推奨）', 'global'],
    ['VERTEX_GEMINI_MODEL（grounding/構造化に使うモデル。例: gemini-3.8-flash）', 'gemini-3.8-flash'],
    ['VERTEX_DATASTORE_ID（Vertex AI Search データストアID。レポート更新時はここを切替）', 'fujikeizai-portfolio-2025'],
    ['VERTEX_SEARCH_LOCATION（データストアのロケーション。global / us / eu）', 'global'],
    ['VERTEX_SERVING_CONFIG（検索サービング構成ID。通常 default_search。アプリにより default_config）', 'default_search'],
    ['AI_RESEARCH_ENABLED（0/1。1でVertex AIリサーチを実行、0でAI調査をスキップ）', 1],
    ['VERTEX_FORECAST_ENABLED（0/1。1でA-4時にVertex予測アシストを実行しA-9へ反映）', 0],
    ['VERTEX_ASSIST_WEIGHT（Vertexアシスト反映率 0〜1。信頼度rとconfidenceで自動調整）', VERTEX_ASSIST_WEIGHT_DEFAULT]
  ];
  sh.getRange(tuneStart, 1, 1, 2).setValues(tuneHdr).setBackground(COLOR_HEADER).setFontWeight('bold');
  sh.getRange(tuneStart + 1, 1, tuneRows.length, 2).setValues(tuneRows);
  sh.getRange(tuneStart + 1, 2, tuneRows.length, 1).setNumberFormat('0.0000');
  // Vertex / RAG 環境設定は「ユーザーが切り替えうる入力欄」のため黄色＋テキスト書式にする（番地非依存・キー照合）
  const vertexEnvKeys = ['VERTEX_PROJECT_ID', 'VERTEX_LOCATION', 'VERTEX_GEMINI_MODEL', 'VERTEX_DATASTORE_ID', 'VERTEX_SEARCH_LOCATION', 'VERTEX_SERVING_CONFIG', 'AI_RESEARCH_ENABLED'];
  const vertexTextKeys = new Set(['VERTEX_PROJECT_ID', 'VERTEX_LOCATION', 'VERTEX_GEMINI_MODEL', 'VERTEX_DATASTORE_ID', 'VERTEX_SEARCH_LOCATION', 'VERTEX_SERVING_CONFIG']);
  tuneRows.forEach((r, i) => {
    const key = configKeyOf_(r[0]);
    if (vertexEnvKeys.indexOf(key) < 0) return;
    const cell = sh.getRange(tuneStart + 1 + i, 2);
    cell.setBackground(COLOR_OBJECTIVE);
    if (vertexTextKeys.has(key)) cell.setNumberFormat('@');
  });
  sh.getRange(tuneStart, 1).setNote('A-9 実行時にこのチューニング値を参照します。\n極端な変更は予測を不安定にするため、変更前に根拠と比較結果（B-2/B-3）を必ず記録してください。');
  tuneRows.forEach((r, i) => {
    safeSetNote_(sh, tuneStart + 1 + i, 1, `詳細: ${r[0]}。\n予測影響あり（中〜高）。通常は必須入力ではなく、検証結果に基づく調整時のみ更新してください。`);
  });

  const proxyRows = [
    ['A/B/C手順の役割', 'A-予測は予測作成、B-事後検証は外れ理由学習、C-四半期レビューは提案の確認と適用。'],
    ['book複製運用', '新しいクライアントの予測はこのbookをDriveでコピーし、コピー先でA-1初期セットアップを実行。'],
    ['織り込める要素', '48ヶ月BASE履歴（未確定補完）/ 主観入力 / AI調査 / DEV_SPOT。'],
    ['SPOTの扱い', '背景SPOT（未知）+ DEV_SPOT（既知）として別枠管理し、KPIでは主観オーバーレイとKnown Spotを分離表示。'],
    ['A-9実行時チェック', '未入力/型不正/影響過大の入力は階層アラートで1件ずつ表示。'],
    ['主なリスク', '入力保守/楽観バイアス、AI情報の鮮度・偏り、外部データ欠損。'],
    ['対応できない範囲', '突発イベントの完全再現、制度変更の即時反映、全案件網羅。'],
    ['予測値の扱い', '予測は意思決定補助であり確定値ではありません。P10/P50/P90レンジで判断。'],
    ['AI調査（自動）', 'AI_RESEARCH_ENABLED=1でVertex AI自動調査を実行し、Web検索と購入レポートRAGの結果をAI_RESEARCH_STRUCTUREDへ記録。'],
    ['AI調査（無効時）', 'AI_RESEARCH_ENABLED=0ではVertex AI調査を実行せず、AI_RESEARCH_STRUCTUREDの既存行だけを参照。'],
    ['四半期運用ルール', 'B-1〜B-3は四半期正式レビュー、月次は軽量監視。'],
    ['内部管理シート', 'RUN_LOG / FORECAST_SNAPSHOT / PROCESS_STATUS は原則非表示運用。']
  ];
  const proxyStart = tuneStart + 1 + tuneRows.length + sectionGapRows;
  sh.getRange(proxyStart, 1, 1, 2).setValues([['背景・運用補足（GUIDE統合）', '内容']]).setBackground(COLOR_HEADER).setFontWeight('bold');
  sh.getRange(proxyStart + 1, 1, proxyRows.length, 2).setValues(proxyRows);
  safeSetNote_(sh, proxyStart, 1, 'GUIDEから移設した運用補足です。本文は要約し、詳細は各Noteで確認します。');
  safeSetNote_(sh, proxyStart + 10, 1, 'AI_RESEARCH_ENABLED=0ではA-4のVertex AI調査を実行せず、A-9はAI_RESEARCH_STRUCTUREDの既存行を参照します。');
  safeSetNote_(sh, proxyStart + 11, 1, '四半期運用にすると負荷は下がりますが、学習反映は月次運用より遅れます。月次軽量監視で遅延を補完します。');

  const flowStart = proxyStart + 1 + proxyRows.length + sectionGapRows;
  const flowRows = [
    ['直接目的', '年間/半期の予実精度改善'],
    ['代理指標/計算', 'BASE + 主観 + AI + SPOT → P10/P50/P90算出 → signed_error / APE / WAPE評価'],
    ['制約/学習ループ', '年間<=10%、半期<=12%、over-forecast<=5% → B-3で前提更新']
  ];
  sh.getRange(flowStart, 1, 1, 2).setValues([['因果経路フローチャート（参照）', '内容']]).setBackground(COLOR_HEADER).setFontWeight('bold');
  sh.getRange(flowStart + 1, 1, flowRows.length, 2).setValues(flowRows);
  safeSetNote_(sh, flowStart, 1, 'GUIDEから移設した因果経路の全体像です。');

  const footerStart = flowStart + 1 + flowRows.length + sectionGapRows;
  const footerRows = [
    ['評価ポリシーversion', EVALUATION_POLICY_VERSION]
  ];
  sh.getRange(footerStart, 1, 1, 2).setValues([['フッタ情報', '値']]).setBackground(COLOR_HEADER).setFontWeight('bold');
  sh.getRange(footerStart + 1, 1, footerRows.length, 2).setValues(footerRows);

  const noteMaxRow = footerStart + footerRows.length;
  const colAValues = sh.getRange(2, 1, noteMaxRow - 1, 1).getValues();
  const colANotes = sh.getRange(2, 1, noteMaxRow - 1, 1).getNotes();
  for (let i = 0; i < colAValues.length; i++) {
    const title = String(colAValues[i][0] || '').trim();
    const curNote = String(colANotes[i][0] || '').trim();
    if (!title || curNote) continue;
    safeSetNote_(sh, i + 2, 1, `${title} の説明です。必要時に値を更新し、更新理由をB列またはEVAL_INSIGHTSに記録してください。`);
  }
  applyValueTypeAlignment_(sh, 1, noteMaxRow, 2);
  applySectionGapRows_(sh, [envStart - 1, policyStart - 1, tuneStart - 1, proxyStart - 1, flowStart - 1, footerStart - 1]);
  const cfgLast = sh.getLastRow();
  const cfgCols = Math.max(2, sh.getLastColumn());
  sh.getRange(1, 1, cfgLast, cfgCols).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
}

function buildSALES_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet_(ss, SHEETS.SALES_MONTHLY);
  sh.clear({ contentsOnly: true });
  sh.clearFormats();

  // 48ヶ月分（B〜AW=48列）
  ensureSheetHasColumns_(sh, 1 + 48);

  sh.setColumnWidth(1, 180);
  for (let c = 2; c <= 49; c++) sh.setColumnWidth(c, 110);

  sh.getRange(1, 1).setValue('Category');
  sh.getRange(1, 1).setBackground(COLOR_HEADER).setFontWeight('bold');

  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);

  sh.getRange(1, 1).setNote('BASE / SPOT のカテゴリ行です。');
  sh.getRange(1, 2).setNote('過去4年（48ヶ月）の月次売上（客観データ）です。');
}

function buildFACTORS_PRODUCT_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet_(ss, SHEETS.PRODUCT);
  sh.clear({ contentsOnly: true });
  sh.clearFormats();

  const header = ['Person', 'ProductName', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason'];
  sh.getRange(1, 1, 1, header.length).setValues([header]).setBackground(COLOR_HEADER).setFontWeight('bold');

  sh.setColumnWidth(1, COL_WIDTHS.W_PERSON);
  sh.setColumnWidth(2, COL_WIDTHS.W_PRODUCT);
  sh.setColumnWidth(3, COL_WIDTHS.W_MONTH);
  sh.setColumnWidth(4, COL_WIDTHS.W_STEP);
  sh.setColumnWidth(5, COL_WIDTHS.W_TEXT);

  sh.getRange(1, 4).setHorizontalAlignment('right');
  sh.getRange('D:D').setNumberFormat('@').setHorizontalAlignment('right');

  sh.getRange(1, 1).setNote('初期設定で入力した表記（CONFIGシートの担当者と同じ表記）を選択してください。');
  sh.getRange(1, 2).setNote('SALES_INPUTから取得した製品一覧に合わせて自動展開されます。');
  sh.getRange(1, 3).setNote('この日付「以降」に影響が出る想定で入力します。');
  sh.getRange(1, 4).setNote('増減率（%）です。例：-30% = 今後30%減りそう。\n入力は 0%/±5%刻みを推奨。');
  sh.getRange(1, 5).setNote('根拠を短く（例：競合参入、契約更改、規制変更）。\nこの列は予測根拠の説明に使われます。');

  sh.setFrozenRows(1);
}

function buildFACTORS_CLIENT_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet_(ss, SHEETS.CLIENT);
  sh.clear({ contentsOnly: true });
  sh.clearFormats();

  const header = ['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason'];
  sh.getRange(1, 1, 1, header.length).setValues([header]).setBackground(COLOR_HEADER).setFontWeight('bold');

  sh.setColumnWidth(1, COL_WIDTHS.W_PERSON);
  sh.setColumnWidth(2, COL_WIDTHS.W_MONTH);
  sh.setColumnWidth(3, COL_WIDTHS.W_STEP);
  sh.setColumnWidth(4, COL_WIDTHS.W_TEXT);

  sh.getRange('C:C').setNumberFormat('@').setHorizontalAlignment('right');

  sh.getRange(1, 1).setNote('初期設定で入力した表記（CONFIGシートの担当者と同じ表記）を選択してください。');
  sh.getRange(1, 2).setNote('この日付「以降」に影響が出る想定で入力します。');
  sh.getRange(1, 3).setNote('増減率（%）です。例：-10% = 予算圧縮で10%減りそう。\n※入力値はそのまま直に固定反映せず、シミュレーション内で扱われます。');
  sh.getRange(1, 4).setNote('根拠を短く（例：予算圧縮、体制変更など）。\n未入力だと判断根拠が追跡しづらくなります。');

  sh.setFrozenRows(1);
}

function buildOPINIONS_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet_(ss, SHEETS.OPINIONS);
  sh.clear({ contentsOnly: true });
  sh.clearFormats();

  const header = ['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Confidence(0..1)', 'Note'];
  sh.getRange(1, 1, 1, header.length).setValues([header]).setBackground(COLOR_HEADER).setFontWeight('bold');

  sh.setColumnWidth(1, COL_WIDTHS.W_PERSON);
  sh.setColumnWidth(2, COL_WIDTHS.W_MONTH);
  sh.setColumnWidth(3, COL_WIDTHS.W_STEP);
  sh.setColumnWidth(4, COL_WIDTHS.W_CONF);
  sh.setColumnWidth(5, COL_WIDTHS.W_TEXT);

  sh.getRange('C:C').setNumberFormat('@').setHorizontalAlignment('right');

  sh.getRange(1, 1).setNote('初期設定で入力した表記（CONFIGシートの担当者と同じ表記）を選択してください。A列はプルダウンです。');
  sh.getRange(1, 2).setNote('この日付「以降」に意見の影響が出る想定で入力します。');
  sh.getRange(1, 3).setNote('増減率（%）です。例：+20% = 今後20%増えそう。\n※意見はそのまま固定反映されず、シミュレーションでランダムに活用されます。');
  sh.getRange(1, 4).setNote('信頼度（0..1）。1に近いほど「この意見を強く信用してよい」として影響が強まります。');
  sh.getRange(1, 5).setNote('所感を短く（例：プロモ減、資材整理、体制変更など）。\nここは必ず入力してください。');

  sh.getRange('D2:D').setDataValidation(SpreadsheetApp.newDataValidation().requireNumberBetween(0, 1).build());
  sh.setFrozenRows(1);
}

function buildDEV_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet_(ss, SHEETS.DEV_SPOT);
  sh.clear({ contentsOnly: true });
  sh.clearFormats();

  const header = ['Person', 'Month(yyyy/mm/dd)', 'Project', 'Amount(JPY)', 'Confidence(0..1)'];
  sh.getRange(1, 1, 1, header.length).setValues([header]).setBackground(COLOR_HEADER).setFontWeight('bold');

  sh.setColumnWidth(1, COL_WIDTHS.W_PERSON);
  sh.setColumnWidth(2, COL_WIDTHS.W_MONTH);
  sh.setColumnWidth(3, 280);
  sh.setColumnWidth(4, COL_WIDTHS.W_MONEY);
  sh.setColumnWidth(5, COL_WIDTHS.W_CONF);

  sh.getRange('D:D').setNumberFormat('¥#,##0');
  sh.getRange(1, 1).setNote('初期設定で入力した表記（CONFIGシートの担当者と同じ表記）を選択してください。');
  sh.getRange(1, 2).setNote('この日付の月に固定売上として加算します（開発案件/スポット要因）。');
  sh.getRange(1, 3).setNote('案件名（またはスポット要因名）を短く。');
  sh.getRange(1, 4).setNote('金額（円）。ここは運用(Ops)のシミュレーションには混ぜず、固定額として加算します。');
  sh.getRange(1, 5).setNote('確度（0..1）。金額×確度で固定加算されます（例：1,000,000円×0.9=900,000円）。');

  sh.getRange('E2:E').setDataValidation(SpreadsheetApp.newDataValidation().requireNumberBetween(0, 1).build());
  sh.setFrozenRows(1);
}

function buildOUTPUT_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet_(ss, SHEETS.OUTPUT);
  // A-1再セットアップ時に旧グラフが残ると、A-9後の再生成位置（L25）と食い違って見えるため先に除去する。
  sh.getCharts().forEach(c => sh.removeChart(c));
  sh.clear({ contentsOnly: true });
  sh.clearFormats();
}

/** ====== テンプレ整形（A-5〜A-8で呼ぶ） ====== */
function ensureFactorsProductTemplate_(sh, products, people, defaultDate) {
  if (!sh) throw new Error('PRODUCTがありません。');

  const last = sh.getLastRow();
  const existing = new Set();
  if (last >= 2) {
    const vals = sh.getRange(2, 2, last - 1, 1).getValues();
    vals.forEach(r => {
      const v = String(r[0] || '').trim();
      if (v) existing.add(v);
    });
  }

  const toAdd = products.filter(p => !existing.has(p));
  if (toAdd.length > 0) {
    const startRow = sh.getLastRow() + 1;
    const rows = toAdd.map(p => ['', p, defaultDate, '0%', '']);
    sh.getRange(startRow, 1, rows.length, 5).setValues(rows);
  }

  const maxRow = Math.max(sh.getLastRow(), 2);
  sh.getRange(2, 1, maxRow - 1, 5).setBackground(COLOR_SUBJECTIVE);

  const dvPerson = SpreadsheetApp.newDataValidation()
    .requireValueInList(people, true)
    .setAllowInvalid(false)
    .build();
  sh.getRange(2, 1, sh.getMaxRows() - 1, 1).setDataValidation(dvPerson);

  sh.getRange('C2:C').setNumberFormat('yyyy/MM/dd');

  const stepList = buildPercentStepList_();
  const dvStep = SpreadsheetApp.newDataValidation()
    .requireValueInList(stepList, true)
    .setAllowInvalid(true)
    .build();
  sh.getRange(2, 4, sh.getMaxRows() - 1, 1).setDataValidation(dvStep);
  sh.getRange('D:D').setNumberFormat('@').setHorizontalAlignment('right');

  sh.setColumnWidth(1, COL_WIDTHS.W_PERSON);
  sh.setColumnWidth(2, COL_WIDTHS.W_PRODUCT);
  sh.setColumnWidth(3, COL_WIDTHS.W_MONTH);
  sh.setColumnWidth(4, COL_WIDTHS.W_STEP);
  sh.setColumnWidth(5, COL_WIDTHS.W_TEXT);
}

function ensureFactorsClientTemplate_(sh, people, defaultDate) {
  if (!sh) throw new Error('CLIENTがありません。');

  if (sh.getLastRow() < 2) {
    const rows = Array.from({ length: 10 }, () => ['', defaultDate, '0%', '']);
    sh.getRange(2, 1, rows.length, 4).setValues(rows);
  }

  const maxRow = Math.max(sh.getLastRow(), 2);
  sh.getRange(2, 1, maxRow - 1, 4).setBackground(COLOR_SUBJECTIVE);

  const dvPerson = SpreadsheetApp.newDataValidation()
    .requireValueInList(people, true)
    .setAllowInvalid(false)
    .build();
  sh.getRange(2, 1, sh.getMaxRows() - 1, 1).setDataValidation(dvPerson);

  const stepList = buildPercentStepList_();
  const dvStep = SpreadsheetApp.newDataValidation()
    .requireValueInList(stepList, true)
    .setAllowInvalid(true)
    .build();
  sh.getRange(2, 3, sh.getMaxRows() - 1, 1).setDataValidation(dvStep);
  sh.getRange('B2:B').setNumberFormat('yyyy/MM/dd');
  sh.getRange('C:C').setNumberFormat('@').setHorizontalAlignment('right');
}

function ensureOpinionsTemplate_(sh, people, defaultDate) {
  if (!sh) throw new Error('OPINIONSがありません。');

  const last = sh.getLastRow();
  const existing = new Set();
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, 1).getValues();
    vals.forEach(r => {
      const v = String(r[0] || '').trim();
      if (v) existing.add(v);
    });
  }

  const missing = people.filter(p => !existing.has(p));
  if (missing.length > 0) {
    const startRow = sh.getLastRow() + 1;
    const rows = missing.map(p => [p, defaultDate, '', '', '']);
    sh.getRange(startRow, 1, rows.length, 5).setValues(rows);
  }

  const maxRow = Math.max(sh.getLastRow(), 2);
  sh.getRange(2, 1, maxRow - 1, 5).setBackground(COLOR_SUBJECTIVE);

  const dvPerson = SpreadsheetApp.newDataValidation()
    .requireValueInList(people, true)
    .setAllowInvalid(false)
    .build();
  sh.getRange(2, 1, sh.getMaxRows() - 1, 1).setDataValidation(dvPerson);

  const stepList = buildPercentStepList_();
  const dvStep = SpreadsheetApp.newDataValidation()
    .requireValueInList(stepList, true)
    .setAllowInvalid(true)
    .build();
  sh.getRange(2, 3, sh.getMaxRows() - 1, 1).setDataValidation(dvStep);
  sh.getRange('B2:B').setNumberFormat('yyyy/MM/dd');
  sh.getRange('C:C').setNumberFormat('@').setHorizontalAlignment('right');

  sh.getRange(2, 4, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireNumberBetween(0, 1).setAllowInvalid(true).build()
  );
}

function ensureDevTemplate_(sh, people, defaultDate) {
  if (!sh) throw new Error('DEV_SPOTがありません。');

  if (sh.getLastRow() < 2) {
    const rows = Array.from({ length: 10 }, () => ['', defaultDate, '', '', 1.0]);
    sh.getRange(2, 1, rows.length, 5).setValues(rows);
  }

  const maxRow = Math.max(sh.getLastRow(), 2);
  sh.getRange(2, 1, maxRow - 1, 5).setBackground(COLOR_SUBJECTIVE);

  const dvPerson = SpreadsheetApp.newDataValidation()
    .requireValueInList(people, true)
    .setAllowInvalid(false)
    .build();
  sh.getRange(2, 1, sh.getMaxRows() - 1, 1).setDataValidation(dvPerson);

  sh.getRange('B2:B').setNumberFormat('yyyy/MM/dd');
  sh.getRange('D:D').setNumberFormat('¥#,##0');

  sh.getRange(2, 5, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireNumberBetween(0, 1).setAllowInvalid(true).build()
  );
}

/** ====== 未確定月補完（同月トレンド＋補完後に下がらない） ====== */
function adjustForUnclosedMonths_(y, seriesStart) {
  const lastClosed = getLastClosedMonthStart_(); // 前月まで確定
  const n = y.length;
  const out = y.slice();

  const closedIdx = [];
  for (let i = 0; i < n; i++) {
    const mStart = addMonths_(seriesStart, i);
    if (mStart <= lastClosed) closedIdx.push(i);
  }

  // 同月トレンド（前年同月比）の中央値を月別に算出（極端値はクリップ）
  const monthFactors = computeMonthTrendFactors_(out, closedIdx);

  for (let i = 0; i < n; i++) {
    const mStart = addMonths_(seriesStart, i);
    if (mStart <= lastClosed) continue; // 確定月はそのまま

    const m = i % 12;
    const current = Number(out[i] || 0);

    let base = current;

    if (i - 12 >= 0) {
      const prev = Number(out[i - 12] || 0);
      if (prev > 0) {
        base = prev * monthFactors[m];
      } else {
        base = estimateMonthAverage_(out, closedIdx, m);
      }
    } else {
      base = estimateMonthAverage_(out, closedIdx, m);
    }

    if (!isFinite(base)) base = current;
    base = Math.max(0, base);

    // ★重要：補完後に途中実績より下がらない
    if (base < current) base = current;

    out[i] = base;
  }

  return { series: out, lastClosedMonthStart: lastClosed, monthTrendFactors: monthFactors };
}

/** 実行日ベース：前月まで確定（当月以降は未確定） */
function getLastClosedMonthStart_() {
  const now = new Date();
  const firstThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonth = new Date(firstThisMonth.getFullYear(), firstThisMonth.getMonth() - 1, 1);
  return prevMonth;
}

function computeMonthTrendFactors_(y, closedIdx) {
  const factors = new Array(12).fill(1);

  for (let m = 0; m < 12; m++) {
    const ratios = [];
    for (let k = 0; k < closedIdx.length; k++) {
      const i = closedIdx[k];
      if (i % 12 !== m) continue;
      if (i - 12 < 0) continue;

      const prev = Number(y[i - 12] || 0);
      const cur = Number(y[i] || 0);
      if (prev > 0 && cur > 0) {
        ratios.push(cur / prev);
      }
    }

    if (ratios.length > 0) {
      let med = percentile_(ratios, 0.50);
      if (!isFinite(med) || med <= 0) med = 1;
      // クリップ
      med = Math.max(TREND_FACTOR_MIN, Math.min(TREND_FACTOR_MAX, med));
      factors[m] = med;
    } else {
      factors[m] = 1;
    }
  }
  return factors;
}

function buildResidualPool_(y, model, seriesStart, lastClosedMonthStart) {
  const tries = [RESIDUAL_WARMUP_SKIP_MONTHS, 3, 0];
  for (let t = 0; t < tries.length; t++) {
    const skip = tries[t];
    const arr = [];
    for (let i = skip; i < y.length; i++) {
      const mStart = addMonths_(seriesStart, i);
      if (mStart > lastClosedMonthStart) continue;
      const fitted = Number((model.fitted || [])[i] || 0);
      if (fitted <= 0) continue;
      arr.push(Number(y[i] || 0) / fitted - 1);
    }
    if (arr.length >= 6) {
      const med = percentile_(arr, 0.50);
      const mad = Math.max(1e-6, percentile_(arr.map(v => Math.abs(v - med)), 0.50));
      const lo = med - RESIDUAL_CLIP_MAD_K * mad;
      const hi = med + RESIDUAL_CLIP_MAD_K * mad;
      return arr.map(v => {
        const clipped = clamp_(v, lo, hi);
        return med + RESIDUAL_SHRINK_TO_MEDIAN * (clipped - med);
      });
    }
  }
  return y.map((val, i) => {
    const fitted = Number((model.fitted || [])[i] || 0);
    return fitted > 0 ? (Number(val || 0) / fitted - 1) : 0;
  });
}

function estimateMonthAverage_(y, closedIdx, monthMod) {
  const arr = [];
  for (let k = 0; k < closedIdx.length; k++) {
    const i = closedIdx[k];
    if (i % 12 !== monthMod) continue;
    const v = Number(y[i] || 0);
    if (isFinite(v) && v > 0) arr.push(v);
  }
  return arr.length ? avg_(arr) : 0;
}

/** ====== 入力異常検出（おかしなデータで止める） ====== */
function validateAllInputsOrThrow_(fy) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // CONFIG
  const cfg = ss.getSheetByName(SHEETS.CONFIG);
  const client = String(cfg.getRange('B2').getValue() || '').trim();
  const fyNum = Number(cfg.getRange('B3').getValue());
  const people = getPeopleListFromConfig_();
  if (!client) throw new Error('CONFIG!B2（メーカー名）が未入力です。');
  if (!isFinite(fyNum) || fyNum <= 2000) throw new Error('CONFIG!B3（予測年度FY）が不正です。');
  if (people.length === 0) throw new Error('CONFIG!B4（担当者）が未入力です。');

  // SALES_MONTHLY（数値かどうか）
  const sales = ss.getSheetByName(SHEETS.SALES_MONTHLY);
  if (!sales) throw new Error('SALES_MONTHLYシートがありません。');

  const lastRow = sales.getLastRow();
  if (lastRow < 2) throw new Error('SALES_MONTHLYに製品行がありません。A-2で取り込み、または手入力してください。');

  const expectedMonths = 48;
  const startCol = 2;
  const endCol = startCol + expectedMonths - 1;
  if (sales.getLastColumn() < endCol) {
    throw new Error('SALES_MONTHLYの月次列が48ヶ月分ありません。A-2 売上データを取り込む を実行してください。');
  }

  const values = sales.getRange(2, 1, lastRow - 1, endCol).getValues();
  for (let r = 0; r < values.length; r++) {
    const pname = String(values[r][0] || '').trim();
    if (!pname) continue;

    for (let c = startCol - 1; c <= endCol - 1; c++) {
      const v = values[r][c];
      if (v === '' || v === null) continue;
      if (typeof v === 'number') {
        if (!isFinite(v)) throw new Error(`SALES_MONTHLY: 数値が不正です（${pname} / col ${c + 1}）`);
      } else {
        const n = toNumberSafe_(v);
        if (!isFinite(n)) throw new Error(`SALES_MONTHLY: 数値に変換できない値があります（${pname} / col ${c + 1} / "${v}"）`);
      }
    }
  }

  // FACTORS / OPINIONS / DEV_SPOT：明らかに変な行があれば停止（未完成行は“無視”＝エラーにはしない）
  validateFactorsSheet_(SHEETS.PRODUCT, { cols: 5, mode: 'product' });
  validateFactorsSheet_(SHEETS.CLIENT, { cols: 4, mode: 'client' });
  validateOpinionsSheet_(people);
  validateDevSheet_();
}

function validateRequiredUserInputsOrThrow_() {
  const people = getPeopleListFromConfig_();
  const missingPeople = findMissingPeopleOpinionsByValidRows_(people);
  if (missingPeople.length > 0) {
    throw new Error(`OPINIONSに担当者意見が不足しています。未入力: ${missingPeople.join(', ')}`);
  }

  const fp = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PRODUCT);
  if (!fp || fp.getLastRow() < 2) throw new Error('PRODUCT の入力行がありません。A-5 を実行してください。');

  const hasReason = fp.getRange(2, 5, fp.getLastRow() - 1, 1).getValues().some(r => String(r[0] || '').trim());
  if (!hasReason) throw new Error('PRODUCT のReasonが未入力です。最低1件入力してください。');
}

/**
 * A-9 実行前の階層アラート（1件ずつ解消させる）
 * 1) Stepの極端値
 * 2) 主観/AI合成係数の過大影響
 */
function runHierarchicalA9AlertsOrThrow_(fy) {
  // 閾値は buildCONFIG_ の「A-9 実行前チェック」表示と同一定数を参照
  const issue =
    findFirstExtremeStepIssue_(fy) ||
    findFirstExtremeDevSpotIssue_(fy) ||
    findFirstExtremeMultiplierIssue_(fy);

  if (!issue) return;

  const title = issue.level === 'high' ? '注意（影響がかなり大きい入力）' : '注意（影響が大きい入力）';
  try {
    forecastConfirmOrAbort_(title, issue.message, 'extreme');
  } catch (e) {
    if (e && e.webConfirm) throw e;
    throw new Error('ユーザーがA-9実行を中断しました（入力内容を見直してください）。');
  }
}

function findFirstExtremeStepIssue_(fy) {
  const factorsProduct = readFactorsProduct_(fy);
  const factorsClient = readFactorsClient_(fy);
  const opinions = readOpinions_(fy);

  const checks = [];
  factorsProduct.forEach(x => checks.push({ src: 'PRODUCT', who: x.person, month: x.month, step: x.step }));
  factorsClient.forEach(x => checks.push({ src: 'CLIENT', who: x.person, month: x.month, step: x.step }));
  opinions.forEach(x => checks.push({ src: 'OPINIONS', who: x.person, month: x.month, step: x.step }));

  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    const abs = Math.abs(Number(c.step || 0));
    if (!isFinite(abs)) continue;

    const ym = c.month ? fmtYM_(c.month) : '-';
    const pct = `${Math.round((c.step || 0) * 100)}%`;
    const detail = `シート: ${c.src} / 担当: ${c.who || '-'} / 月: ${ym} / Step: ${pct}`;

    if (abs >= STEP_BLOCK_THRESHOLD) {
      return {
        level: 'high',
        message: `Stepが極端です（±100%以上）。\n\n${detail}\n\nプロモーション終了などで意図した入力ならOKで続行できます。
修正する場合はキャンセルしてください。`
      };
    }
    if (abs >= STEP_STRONG_THRESHOLD) {
      return {
        level: 'warn',
        message: `Stepが大きく、予測に強く影響する可能性があります（±50%以上）。\n\n${detail}\n\n修正する場合はキャンセル、続行する場合はOKを押してください。`
      };
    }
    if (abs >= STEP_WARN_THRESHOLD) {
      return {
        level: 'warn',
        message: `Stepがやや大きめです（±30%以上）。\n\n${detail}\n\n修正する場合はキャンセル、続行する場合はOKを押してください。`
      };
    }
  }

  return null;
}

function findFirstExtremeDevSpotIssue_(fy) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sales = ss.getSheetByName(SHEETS.SALES_MONTHLY);
  const devFixed = readDevFixed12Months_(fy);
  if (!sales || !devFixed || devFixed.length === 0) return null;

  const salesData = readSales48Months_(sales);
  const base48 = salesData.baseSeries48 || [];
  const baseAvg = base48.length ? (sumArr_(base48) / Math.max(1, base48.length)) : 0;
  if (!isFinite(baseAvg) || baseAvg <= 0) return null;

  const start = getForecastFYStart_(fy);
  for (let i = 0; i < 12; i++) {
    const v = Number(devFixed[i] || 0);
    if (!isFinite(v) || v <= 0) continue;
    const ym = fmtYM_(addMonths_(start, i));
    const ratio = v / baseAvg;
    if (ratio >= 1.2) {
      return {
        level: 'high',
        message: `DEV/SPOT固定が大きい月があります（${ym} / ${Math.round(v).toLocaleString()}円, BASE平均比 ${(ratio * 100).toFixed(1)}%）。\n\n意図した大型案件ならOKで続行できます。
修正する場合はキャンセルしてください。`
      };
    }
    if (ratio >= 0.8) {
      return {
        level: 'warn',
        message: `DEV/SPOT固定がやや大きい月があります（${ym} / ${Math.round(v).toLocaleString()}円, BASE平均比 ${(ratio * 100).toFixed(1)}%）。\n\n意図した入力ならOKで続行できます。
修正する場合はキャンセルしてください。`
      };
    }
  }
  return null;
}

function findFirstExtremeMultiplierIssue_(fy) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sales = ss.getSheetByName(SHEETS.SALES_MONTHLY);
  if (!sales) return null;

  const salesData = readSales48Months_(sales);
  const monthlyByProduct = salesData.monthlyByProduct || [];
  if (monthlyByProduct.length === 0) return null;

  const cfg = ss.getSheetByName(SHEETS.CONFIG);
  const rawClient = String(cfg.getRange('B2').getValue() || '').trim();
  const client = normalizeClientName_(rawClient);
  const ctx = getForecastContext_(fy, new Date(), []);
  const weights = computeProductWeightsFromSalesInputClosed12_(fy, client, ctx);

  const months = [];
  const start = getForecastFYStart_(fy);
  for (let i = 0; i < 12; i++) months.push(addMonths_(start, i));

  const factorsProduct = readFactorsProduct_(fy);
  const factorsClient = readFactorsClient_(fy);
  const opinions = readOpinions_(fy);
  const tuning = readModelTuningFromConfig_();
  const ai = readAIResearchScores_();
  const aiTotal = (ai.Market || 0) + (ai.Competitor || 0) + (ai.Channel || 0) + (ai.DX || 0);
  const aiRaw = aiTotal * (isFinite(tuning.aiWeight) ? tuning.aiWeight : AI_WEIGHT_DEFAULT);
  const aiEff = Math.max(-(isFinite(tuning.aiMaxAbsEffect) ? tuning.aiMaxAbsEffect : AI_MAX_ABS_EFFECT), Math.min((isFinite(tuning.aiMaxAbsEffect) ? tuning.aiMaxAbsEffect : AI_MAX_ABS_EFFECT), aiRaw));
  const kAI = 1 + aiEff;

  for (let i = 0; i < 12; i++) {
    const m = months[i];
    const kProd = productFactorsMultiplier_(factorsProduct, m, weights);
    const kClient = clientFactorsMultiplier_(factorsClient, m);
    const kOpinion = opinionExpectedMultiplier_(opinions, m);
    const kTotal = kProd * kClient * kOpinion * kAI;
    const ym = fmtYM_(m);

    if (kTotal < K_TOTAL_BLOCK_MIN || kTotal > K_TOTAL_BLOCK_MAX) {
      return {
        level: 'high',
        message: `主観/AIの合成係数が極端です（${ym} / kTotal=${kTotal.toFixed(3)}）。\n\n意図した戦略変更ならOKで続行できます。
修正する場合はキャンセルしてください。`
      };
    }
    if (kTotal < K_TOTAL_WARN_MIN || kTotal > K_TOTAL_WARN_MAX) {
      return {
        level: 'warn',
        message: `主観/AIの合成係数が大きめです（${ym} / kTotal=${kTotal.toFixed(3)}）。\n\n修正する場合はキャンセル、続行する場合はOKを押してください。`
      };
    }
  }

  return null;
}

function opinionExpectedMultiplier_(opinions, targetMonth, reliabilityMap) {
  if (!opinions || opinions.length === 0) return 1;

  const people = new Map();
  opinions.forEach(o => {
    if (!o.month || o.month > targetMonth) return;
    const key = o.person || '';
    if (!key) return;
    const prev = people.get(key);
    if (!prev || prev.month < o.month) people.set(key, o);
  });
  if (people.size === 0) return 1;

  let k = 1;
  people.forEach(o => {
    const baseStep = (isFinite(o.step) ? o.step : 0) * getSourceReliability_(reliabilityMap, 'opinion', o.person || '');
    const conf = isFinite(o.confidence) ? o.confidence : 0.7;
    k *= (1 + baseStep * conf);
  });
  return Math.max(0, k);
}

function validateFactorsSheet_(sheetName, opt) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(sheetName);
  if (!sh) return;

  const last = sh.getLastRow();
  if (last < 2) return;

  const vals = sh.getRange(2, 1, last - 1, opt.cols).getValues();

  for (let i = 0; i < vals.length; i++) {
    const rowNum = i + 2;
    const row = vals[i];

    // 行が完全空なら無視
    if (row.every(v => v === '' || v === null)) continue;

    if (opt.mode === 'product') {
      const person = String(row[0] || '').trim();
      const product = String(row[1] || '').trim();
      const monthRaw = row[2];
      const stepRaw = row[3];

      // 未完成なら無視（エラーでは止めない）
      if (!person || !product || !monthRaw || stepRaw === '' || stepRaw === null) continue;

      const dt = toDate_(monthRaw);
      if (!dt) throw new Error(`${sheetName}!C${rowNum} の日付が不正です（yyyy/mm/dd 形式で入力してください）。`);

      const step = parseRate_(stepRaw);
      if (!isFinite(step)) throw new Error(`${sheetName}!D${rowNum} のStepが解釈できません（例：-30% や +10%）。`);

      if (Math.abs(step) > 5) throw new Error(`${sheetName}!D${rowNum} のStepが極端に大きいです（${stepRaw}）。意図した値か確認してください。`);
    }

    if (opt.mode === 'client') {
      const person = String(row[0] || '').trim();
      const monthRaw = row[1];
      const stepRaw = row[2];

      if (!person || !monthRaw || stepRaw === '' || stepRaw === null) continue;

      const dt = toDate_(monthRaw);
      if (!dt) throw new Error(`${sheetName}!B${rowNum} の日付が不正です（yyyy/mm/dd 形式で入力してください）。`);

      const step = parseRate_(stepRaw);
      if (!isFinite(step)) throw new Error(`${sheetName}!C${rowNum} のStepが解釈できません（例：-30% や +10%）。`);

      if (Math.abs(step) > 5) throw new Error(`${sheetName}!C${rowNum} のStepが極端に大きいです（${stepRaw}）。意図した値か確認してください。`);
    }
  }
}

function validateOpinionsSheet_(requiredPeople) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.OPINIONS);
  if (!sh) throw new Error('OPINIONSシートがありません。A-7を実行してください。');

  const last = sh.getLastRow();
  if (last < 2) throw new Error('OPINIONSに入力行がありません。A-7を実行してください。');

  const vals = sh.getRange(2, 1, last - 1, 5).getValues();

  // 有効行：Person + Month + Step + Confidence が揃っている
  const okPeople = new Set();

  for (let i = 0; i < vals.length; i++) {
    const rowNum = i + 2;
    const person = String(vals[i][0] || '').trim();
    const monthRaw = vals[i][1];
    const stepRaw = vals[i][2];
    const confRaw = vals[i][3];

    // 行が完全空なら無視
    if ([person, monthRaw, stepRaw, confRaw, vals[i][4]].every(v => v === '' || v === null)) continue;

    // 途中の未完成行は無視（ただし変な値はエラー）
    if (!person || !monthRaw || stepRaw === '' || stepRaw === null || confRaw === '' || confRaw === null) continue;

    const dt = toDate_(monthRaw);
    if (!dt) throw new Error(`OPINIONS!B${rowNum} の日付が不正です（yyyy/mm/dd 形式で入力してください）。`);

    const step = parseRate_(stepRaw);
    if (!isFinite(step)) throw new Error(`OPINIONS!C${rowNum} のStepが解釈できません（例：-30% や +10%）。`);

    const conf = Number(confRaw);
    if (!isFinite(conf) || conf < 0 || conf > 1) throw new Error(`OPINIONS!D${rowNum} の信頼度が不正です（0..1）。`);

    okPeople.add(person);
  }

  const missing = requiredPeople.filter(p => !okPeople.has(p));
  if (missing.length > 0) {
    throw new Error(`OPINIONSに担当者全員の有効な入力がありません。\n未入力: ${missing.join(', ')}\nA-7で入力してください。`);
  }
}

function validateDevSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.DEV_SPOT);
  if (!sh) return;

  const last = sh.getLastRow();
  if (last < 2) return;

  const vals = sh.getRange(2, 1, last - 1, 5).getValues();
  for (let i = 0; i < vals.length; i++) {
    const rowNum = i + 2;
    const person = String(vals[i][0] || '').trim();
    const monthRaw = vals[i][1];
    const project = String(vals[i][2] || '').trim();
    const amountRaw = vals[i][3];
    const confRaw = vals[i][4];

    // 完全空行は無視
    if ([person, monthRaw, project, amountRaw, confRaw].every(v => v === '' || v === null)) continue;

    // 未完成行は無視（ただし変な値はエラー）
    if (!monthRaw || amountRaw === '' || amountRaw === null || confRaw === '' || confRaw === null) continue;

    const dt = toDate_(monthRaw);
    if (!dt) throw new Error(`DEV_SPOT!B${rowNum} の日付が不正です（yyyy/mm/dd 形式で入力してください）。`);

    const amt = toNumberSafe_(amountRaw);
    if (!isFinite(amt)) throw new Error(`DEV_SPOT!D${rowNum} の金額が数値として不正です（"${amountRaw}"）。`);
    if (amt < 0) throw new Error(`DEV_SPOT!D${rowNum} の金額が負の値です（${amt}）。`);

    const conf = Number(confRaw);
    if (!isFinite(conf) || conf < 0 || conf > 1) throw new Error(`DEV_SPOT!E${rowNum} の確度が不正です（0..1）。`);
  }
}

function toNumberSafe_(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (!s) return NaN;
  const norm = s.replace(/[,\s]/g, '').replace(/¥/g, '').replace(/￥/g, '');
  const n = Number(norm);
  return n;
}

/** ====== 読み取り関数 ====== */
function getPeopleListFromConfig_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = ss.getSheetByName(SHEETS.CONFIG);
  if (!cfg) return [];
  const raw = String(cfg.getRange('B4').getValue() || '').trim();
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

/** CONFIGラベルから「（」または「(」より前のキー部分を切り出す */
function configKeyOf_(label) {
  const s = String(label || '').trim();
  const idx = s.search(/[（(]/);
  return (idx >= 0 ? s.slice(0, idx) : s).trim();
}

/** CONFIG A:B 全体を読み、キー切り出し＋完全一致のマップを返す */
function readConfigLabelMap_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = ss.getSheetByName(SHEETS.CONFIG);
  const map = {};
  if (!cfg) return map;
  try {
    const last = cfg.getLastRow();
    if (last < 1) return map;
    const rows = cfg.getRange(1, 1, last, 2).getValues();
    rows.forEach(r => {
      const key = configKeyOf_(r[0]);
      if (key) map[key] = r[1];
    });
  } catch (err) {
    // CONFIG読取失敗時は空mapとして扱い、呼び出し側で既定値へフォールバックする
  }
  return map;
}

function readVertexConfig_() {
  const labelMap = readConfigLabelMap_();
  const cfg = {
    projectId: String(labelMap.VERTEX_PROJECT_ID || '').trim(),
    location: String(labelMap.VERTEX_LOCATION || '').trim(),
    geminiModel: String(labelMap.VERTEX_GEMINI_MODEL || '').trim(),
    datastoreId: String(labelMap.VERTEX_DATASTORE_ID || '').trim(),
    searchLocation: String(labelMap.VERTEX_SEARCH_LOCATION || '').trim(),
    servingConfig: String(labelMap.VERTEX_SERVING_CONFIG || '').trim() || 'default_search',
    enabled: Number(labelMap.AI_RESEARCH_ENABLED || 0) > 0
  };
  // gemini（web grounding + 構造化）と RAG（Vertex AI Search）の readiness を分離。
  // RAG 未設置でも web-only で A-4 を実行できるよう、入口判定は geminiReady を使う。
  cfg.geminiReady = !!(cfg.projectId && cfg.location && cfg.geminiModel);
  cfg.ragReady = !!(cfg.datastoreId && cfg.searchLocation);
  return cfg;
}

/**
 * HOW TO TEST (config-blank-guard)
 * 1) VERSION='2.3.47-dev' / BUILD_STAGE='config-blank-guard'、DLM_BUILD_STAGE 不変、先頭コメントも同期。
 * 2) 正常セットアップ済み book（CONFIG 全シード）で A-9 → OUTPUT の年度合計・月次 P10/P50/P90 が
 *    本変更の前後で不変（空セルが無く getCfg / readAiMissingConfidenceDefault_ の既定分岐に入らない）。
 * 3) CONFIG チューニング表「QUAL_SUBJECTIVE_MONTHLY_CAP」B列を空にして A-9 →
 *    変更前は cap が 0.01（≒無効）に化けたが、変更後は既定 0.40 が使われ主観オーバーレイが従来どおり効くこと。
 * 4) 同「AI_WEIGHT」B列を空にして A-9 → 変更後は既定 0.0008 が使われ kAI 寄与が 0 に潰れないこと。
 * 5) 同「AI_MISSING_CONFIDENCE_DEFAULT」B列を空にして A-4→A-9 → 変更後は既定 0.5 が使われ、
 *    confidence 欠落の event 行が不採用（confDrop）でなく既定補完（confDefault）扱いになること。
 *    明示的に 0 を入れた場合は従来どおり不採用（confDrop）になること（空と明示0を区別）。
 * 6) grep で coercion 判定用の旧識別子が 0 件（writeOutputFY_ の死にコード削除）。OUTPUT row6 の
 *    表示内容が本削除の前後で不変であること。
 * 7) AI_SCORE_HISTORY / AI_IMPACT_HISTORY のスキーマ・値（正常 book）が不変であること。
 */
function readModelTuningFromConfig_() {
  const out = {
    spotBgShrink: SPOT_BG_SHRINK,
    spotBgFloorRate: SPOT_BG_FLOOR_RATE,
    spotBgCapRate: SPOT_BG_CAP_RATE,
    aiWeight: AI_WEIGHT_DEFAULT,
    aiMaxAbsEffect: AI_MAX_ABS_EFFECT,
    aiMissingConfidenceDefault: AI_MISSING_CONFIDENCE_DEFAULT,
    aiMomentumLookbackQuarters: 2,
    aiMomentumMinHistory: 2,
    spotSpikeMadK: SPOT_SPIKE_MAD_K,
    knownSpotOffsetRate: KNOWN_SPOT_OFFSET_RATE,
    knownSpotBgSuppressRate: KNOWN_SPOT_BG_SUPPRESS_RATE,
    qualSubjectiveMonthlyCap: QUAL_SUBJECTIVE_MONTHLY_CAP,
    qualCalibrationEnabled: QUAL_CALIBRATION_ENABLED,
    seasonalYearWeightY1: SEASONAL_YEAR_WEIGHT_Y1,
    seasonalYearWeightY2: SEASONAL_YEAR_WEIGHT_Y2,
    seasonalYearWeightY3: SEASONAL_YEAR_WEIGHT_Y3,
    seasonalYearWeightY4: SEASONAL_YEAR_WEIGHT_Y4,
    seasonalOpenMonthWeightMult: SEASONAL_OPEN_MONTH_WEIGHT_MULT,
    seasonalWeightedMadK: SEASONAL_WEIGHTED_MAD_K,
    seasonalCompareWarnThreshold: SEASONAL_COMPARE_WARN_THRESHOLD,
    aiTotalNeutralThreshold: AI_TOTAL_NEUTRAL_THRESHOLD,
    aiQualityNeutralThreshold: AI_QUALITY_NEUTRAL_THRESHOLD,
    aiQualityPartialThreshold: AI_QUALITY_PARTIAL_THRESHOLD,
    aiWeightProposalMin: 0.00005,
    aiWeightProposalMax: 0.002,
    dlmBacktestMinMonths: 24,
    dlmBacktestStartOrigin: 18,
    dlmLogEpsilonRate: 0.01,
    reliabilityRMin: 0.0,
    reliabilityRMax: 1.5,
    reliabilityShrinkageK: 4,
    reliabilityMinSamples: 2,
    reliabilityMinChange: 0.05,
    poolMinClients: POOL_MIN_CLIENTS_DEFAULT,
    vertexAssistWeight: VERTEX_ASSIST_WEIGHT_DEFAULT
  };

  const labelMap = readConfigLabelMap_();
  const getCfg = (key, def) => {
    // 空セル('')/null/undefined・キー欠落は「未設定」として既定値へフォールバックする。
    // Number('')===0 が isFinite を通り「0という上書き値」として採用され、各チューニング値が
    // クランプ下限へ化ける罠（calibration-blank-override-fix と同型）を回避する。
    const raw = labelMap[key];
    if (raw === '' || raw === null || raw === undefined) return def;
    const v = Number(raw);
    return isFinite(v) ? v : def;
  };

  out.spotBgShrink = Math.max(0, Math.min(1, getCfg('SPOT_BG_SHRINK', out.spotBgShrink)));
  out.spotBgFloorRate = Math.max(0, Math.min(1, getCfg('SPOT_BG_FLOOR_RATE', out.spotBgFloorRate)));
  out.spotBgCapRate = Math.max(0, Math.min(1, getCfg('SPOT_BG_CAP_RATE', out.spotBgCapRate)));
  out.aiWeight = Math.max(0, Math.min(0.01, getCfg('AI_WEIGHT', out.aiWeight)));
  out.aiMaxAbsEffect = Math.max(0, Math.min(0.05, getCfg('AI_MAX_ABS_EFFECT', out.aiMaxAbsEffect)));
  out.aiMissingConfidenceDefault = Math.max(0, Math.min(1, getCfg('AI_MISSING_CONFIDENCE_DEFAULT', out.aiMissingConfidenceDefault)));
  out.aiMomentumLookbackQuarters = Math.round(Math.max(1, Math.min(8, getCfg('AI_MOMENTUM_LOOKBACK_QUARTERS', out.aiMomentumLookbackQuarters))));
  out.aiMomentumMinHistory = Math.round(Math.max(1, Math.min(12, getCfg('AI_MOMENTUM_MIN_HISTORY', out.aiMomentumMinHistory))));
  out.spotSpikeMadK = Math.max(0.5, Math.min(10, getCfg('SPOT_SPIKE_MAD_K', out.spotSpikeMadK)));
  out.knownSpotOffsetRate = Math.max(0, Math.min(1, getCfg('KNOWN_SPOT_OFFSET_RATE', out.knownSpotOffsetRate)));
  out.knownSpotBgSuppressRate = Math.max(0, Math.min(1, getCfg('KNOWN_SPOT_BG_SUPPRESS_RATE', out.knownSpotBgSuppressRate)));
  out.qualSubjectiveMonthlyCap = Math.max(0.01, Math.min(2, getCfg('QUAL_SUBJECTIVE_MONTHLY_CAP', out.qualSubjectiveMonthlyCap)));
  out.qualCalibrationEnabled = Math.round(Math.max(0, Math.min(1, getCfg('QUAL_CALIBRATION_ENABLED', out.qualCalibrationEnabled))));
  out.seasonalYearWeightY1 = Math.max(0, Math.min(1, getCfg('SEASONAL_YEAR_WEIGHT_Y1', out.seasonalYearWeightY1)));
  out.seasonalYearWeightY2 = Math.max(0, Math.min(1, getCfg('SEASONAL_YEAR_WEIGHT_Y2', out.seasonalYearWeightY2)));
  out.seasonalYearWeightY3 = Math.max(0, Math.min(1, getCfg('SEASONAL_YEAR_WEIGHT_Y3', out.seasonalYearWeightY3)));
  out.seasonalYearWeightY4 = Math.max(0, Math.min(1, getCfg('SEASONAL_YEAR_WEIGHT_Y4', out.seasonalYearWeightY4)));
  out.seasonalOpenMonthWeightMult = Math.max(0.1, Math.min(1, getCfg('SEASONAL_OPEN_MONTH_WEIGHT_MULT', out.seasonalOpenMonthWeightMult)));
  out.seasonalWeightedMadK = Math.max(0.5, Math.min(10, getCfg('SEASONAL_WEIGHTED_MAD_K', out.seasonalWeightedMadK)));
  out.seasonalCompareWarnThreshold = Math.max(0.01, Math.min(1, getCfg('SEASONAL_COMPARE_WARN_THRESHOLD', out.seasonalCompareWarnThreshold)));
  out.aiTotalNeutralThreshold = Math.max(0, Math.min(100, getCfg('AI_TOTAL_NEUTRAL_THRESHOLD', out.aiTotalNeutralThreshold)));
  out.aiQualityNeutralThreshold = Math.max(0, Math.min(1, getCfg('AI_QUALITY_NEUTRAL_THRESHOLD', out.aiQualityNeutralThreshold)));
  out.aiQualityPartialThreshold = Math.max(out.aiQualityNeutralThreshold, Math.min(1, getCfg('AI_QUALITY_PARTIAL_THRESHOLD', out.aiQualityPartialThreshold)));
  out.aiWeightProposalMin = Math.max(0, Math.min(0.01, getCfg('AI_WEIGHT_PROPOSAL_MIN', out.aiWeightProposalMin)));
  out.aiWeightProposalMax = Math.max(out.aiWeightProposalMin, Math.min(0.01, getCfg('AI_WEIGHT_PROPOSAL_MAX', out.aiWeightProposalMax)));
  out.dlmBacktestMinMonths = Math.round(Math.max(12, Math.min(48, getCfg('DLM_BACKTEST_MIN_MONTHS', out.dlmBacktestMinMonths))));
  out.dlmBacktestStartOrigin = Math.round(Math.max(12, Math.min(47, getCfg('DLM_BACKTEST_START_ORIGIN', out.dlmBacktestStartOrigin))));
  out.dlmLogEpsilonRate = Math.max(0.0001, Math.min(0.5, getCfg('DLM_LOG_EPSILON_RATE', out.dlmLogEpsilonRate)));
  out.reliabilityRMin = Math.max(0, Math.min(1, getCfg('RELIABILITY_R_MIN', out.reliabilityRMin)));
  out.reliabilityRMax = Math.max(out.reliabilityRMin, Math.min(3, getCfg('RELIABILITY_R_MAX', out.reliabilityRMax)));
  out.reliabilityShrinkageK = Math.max(0, Math.min(50, getCfg('RELIABILITY_SHRINKAGE_K', out.reliabilityShrinkageK)));
  out.reliabilityMinSamples = Math.round(Math.max(1, Math.min(12, getCfg('RELIABILITY_MIN_SAMPLES', out.reliabilityMinSamples))));
  out.reliabilityMinChange = Math.max(0, Math.min(1, getCfg('RELIABILITY_MIN_CHANGE', out.reliabilityMinChange)));
  out.poolMinClients = Math.round(Math.max(1, Math.min(50, getCfg('POOL_MIN_CLIENTS', out.poolMinClients))));
  out.vertexAssistWeight = Math.max(0, Math.min(1, getCfg('VERTEX_ASSIST_WEIGHT', out.vertexAssistWeight)));
  return out;
}

function readDlmEngineMode_() {
  const labelMap = readConfigLabelMap_();
  const v = String(labelMap.DLM_ENGINE_MODE || '').trim().toLowerCase();
  if (v === 'shadow' || v === 'primary') return v;
  return 'off';
}

function readAiScoreBasis_() {
  const labelMap = readConfigLabelMap_();
  const v = String(labelMap.AI_SCORE_BASIS || '').trim().toLowerCase();
  return v === 'momentum' ? 'momentum' : 'level';
}

function readAiMissingConfidenceDefault_() {
  const labelMap = readConfigLabelMap_();
  // 空セル('')/null/undefined・キー欠落は既定値（0.5）へフォールバック。
  // Number('')===0 が isFinite を通り 0（=confidence欠落の event 行は不採用）に化けるのを防ぐ。
  // 明示的に 0 を入れた場合は従来どおり 0 を採用する（空と明示0を区別）。
  const raw = labelMap.AI_MISSING_CONFIDENCE_DEFAULT;
  if (raw === '' || raw === null || raw === undefined) return AI_MISSING_CONFIDENCE_DEFAULT;
  const v = Number(raw);
  return isFinite(v) ? Math.max(0, Math.min(1, v)) : AI_MISSING_CONFIDENCE_DEFAULT;
}

function readForecastClosedMonthMode_() {
  const labelMap = readConfigLabelMap_();
  const v = String(labelMap.FORECAST_CLOSED_MONTH_MODE || '').trim().toLowerCase();
  return (v === 'forecast') ? 'forecast' : 'actual';
}

function readReliabilityApplyEnabled_() {
  const labelMap = readConfigLabelMap_();
  return Number(labelMap.RELIABILITY_APPLY_ENABLED || 0) > 0;
}

function readLmdiDecompositionEnabled_() {
  const labelMap = readConfigLabelMap_();
  return Number(labelMap.LMDI_DECOMPOSITION_ENABLED || 0) > 0;
}

function readDlmPrimarySpotCapBasis_() {
  const labelMap = readConfigLabelMap_();
  const v = String(labelMap.DLM_PRIMARY_SPOT_CAP_BASIS || '').trim().toLowerCase();
  if (v === 'ols') return 'ols';
  return 'dlm';
}

function readSourceReliability_(client) {
  const map = new Map();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.SOURCE_RELIABILITY);
  if (!sh || sh.getLastRow() < 2) return map;
  const values = sh.getDataRange().getValues();
  const header = values[0] || [];
  const idx = {};
  header.forEach((h, i) => { idx[String(h || '')] = i; });
  const target = String(client || '').trim();
  for (let i = 1; i < values.length; i++) {
    if (target && !isSameClient_(values[i][idx.client], target)) continue;
    const type = String(values[i][idx.source_type] || '').trim();
    const key = String(values[i][idx.source_key] || '').trim();
    if (!type || !key) continue;
    const r = Number(values[i][idx.reliability_r]);
    map.set(`${type}:${key}`, isFinite(r) ? r : 1.0);
  }
  return map;
}

function getSourceReliability_(map, type, key) {
  if (!map || !type || !key) return 1.0;
  const v = map.get(`${type}:${key}`);
  return isFinite(Number(v)) ? Number(v) : 1.0;
}

function writeSourceReliability_(client, sourceType, sourceKey, r, sampleCount, evalWindow, note) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet_(ss, SHEETS.SOURCE_RELIABILITY);
  const headers = ['client','source_type','source_key','reliability_r','sample_count','last_eval_window','updated_at','updated_by','note'];
  ensureSheetHeaders_(sh, headers);
  const values = sh.getDataRange().getValues();
  const idx = {};
  (values[0] || headers).forEach((h, i) => { idx[String(h || '')] = i; });
  const targetClient = String(client || '').trim();
  const targetType = String(sourceType || '').trim();
  const targetKey = String(sourceKey || '').trim();
  const updatedBy = Session.getActiveUser().getEmail() || 'unknown';
  const rVal = isFinite(Number(r)) ? Number(r) : 1.0;
  const row = [targetClient, targetType, targetKey, rVal, sampleCount, evalWindow || '', new Date(), updatedBy, note || ''];
  let rowNo = 0;
  for (let i = 1; i < values.length; i++) {
    if (!isSameClient_(values[i][idx.client], targetClient)) continue;
    if (String(values[i][idx.source_type] || '').trim() !== targetType) continue;
    if (String(values[i][idx.source_key] || '').trim() !== targetKey) continue;
    rowNo = i + 1;
    break;
  }
  if (rowNo) sh.getRange(rowNo, 1, 1, headers.length).setValues([row]);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, headers.length).setValues([row]);
}

function readPoolPrior_(scope) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.POOL_PRIOR);
  if (!sh || sh.getLastRow() < 2) return { value: 1.0, precision: null };
  const values = sh.getDataRange().getValues();
  const header = values[0] || [];
  const idx = {};
  header.forEach((h, i) => { idx[String(h || '')] = i; });
  const target = String(scope || '').trim();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idx.pool_scope] || '').trim() !== target) continue;
    if (String(values[i][idx.param_key] || '').trim() !== 'reliability_r') continue;
    const value = Number(values[i][idx.pooled_value]);
    const precisionRaw = values[i][idx.precision];
    const precision = Number(precisionRaw);
    return {
      value: isFinite(value) ? value : 1.0,
      precision: (precisionRaw === '' || precisionRaw === null || precisionRaw === undefined) ? null : (isFinite(precision) ? precision : null)
    };
  }
  return { value: 1.0, precision: null };
}


function findMissingPeopleOpinionsByValidRows_(requiredPeople) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const op = ss.getSheetByName(SHEETS.OPINIONS);
  if (!op) return requiredPeople;

  const last = op.getLastRow();
  if (last < 2) return requiredPeople;

  const vals = op.getRange(2, 1, last - 1, 5).getValues();

  const ok = new Set();
  vals.forEach(r => {
    const person = String(r[0] || '').trim();
    const monthRaw = r[1];
    const stepRaw = r[2];
    const confRaw = r[3];

    if (!person) return;
    if (!monthRaw) return;
    if (stepRaw === '' || stepRaw === null) return;
    if (confRaw === '' || confRaw === null) return;

    const dt = toDate_(monthRaw);
    const step = parseRate_(stepRaw);
    const conf = Number(confRaw);

    if (dt && isFinite(step) && isFinite(conf) && conf >= 0 && conf <= 1) ok.add(person);
  });

  return requiredPeople.filter(p => !ok.has(p));
}

/** SALES_MONTHLY読み取り（48ヶ月） */
function readSales48Months_(salesSheet) {
  const lastRow = salesSheet.getLastRow();
  const lastCol = salesSheet.getLastColumn();

  const expectedMonths = 48;
  const startCol = 2; // B列〜
  const endCol = startCol + expectedMonths - 1; // 49

  const isComplete48 = (lastCol >= endCol);

  const productRows = Math.max(0, lastRow - 1);
  const data = [];

  if (productRows > 0) {
    const width = Math.min(lastCol, endCol);
    const vals = salesSheet.getRange(2, 1, productRows, width).getValues();
    vals.forEach(row => {
      const name = String(row[0] || '').trim();
      if (!name) return;
      const category = name.toUpperCase();
      // TOTAL行は表示用のため予測入力には含めない（BASE/SPOTのみを使用）
      if (category !== 'BASE' && category !== 'SPOT') return;
      const arr = new Array(expectedMonths).fill(0);
      for (let i = 0; i < expectedMonths; i++) {
        const idx = (startCol - 1) + i;
        const v = row[idx];
        if (typeof v === 'number') arr[i] = Number(v) || 0;
        else {
          const n = toNumberSafe_(v);
          arr[i] = isFinite(n) ? n : 0;
        }
      }
      data.push({ productName: name, monthly: arr });
    });
  }

  return {
    isComplete48,
    monthlyByProduct: data.map(x => x.monthly),
    productNames: data.map(x => x.productName),
    baseSeries48: (data.find(x => String(x.productName || '').toUpperCase() === 'BASE') || { monthly: new Array(expectedMonths).fill(0) }).monthly,
    spotSeries48: (data.find(x => String(x.productName || '').toUpperCase() === 'SPOT') || { monthly: new Array(expectedMonths).fill(0) }).monthly,
    headerMonths: readSalesHeaderMonths_(salesSheet, expectedMonths)
  };
}

function readSalesHeaderMonths_(salesSheet, expectedMonths) {
  const vals = salesSheet.getRange(1, 2, 1, expectedMonths).getValues()[0];
  const out = vals.map(v => toMonthStart_(v));
  if (out.some(v => !v)) throw new Error('SALES_MONTHLYヘッダ月が解釈できません。A-3を再実行してください。');
  return out;
}

function getForecastContext_(fy, runDate, headerMonths) {
  const forecastStart = getForecastFYStart_(fy);
  const forecastEnd = getForecastFYEnd_(fy);
  const currentMonth = new Date(runDate.getFullYear(), runDate.getMonth(), 1);
  const lastClosedMonthStart = addMonths_(currentMonth, -1);

  const forecastMonths = [];
  for (let i = 0; i < 12; i++) forecastMonths.push(addMonths_(forecastStart, i));

  const historyMonthIndexes = [];
  for (let i = 0; i < headerMonths.length; i++) {
    const m = headerMonths[i];
    if (m < forecastStart) historyMonthIndexes.push(i);
  }

  const ymToIndex = new Map();
  for (let i = 0; i < headerMonths.length; i++) ymToIndex.set(fmtYM_(headerMonths[i]), i);

  const forecastMonthIndexesInSales = forecastMonths.map(m => {
    const idx = ymToIndex.get(fmtYM_(m));
    return Number.isInteger(idx) ? idx : -1;
  });

  const closedForecastMonthOffsets = [];
  const openForecastMonthOffsets = [];
  for (let i = 0; i < forecastMonths.length; i++) {
    const salesIdx = forecastMonthIndexesInSales[i];
    if (salesIdx >= 0 && forecastMonths[i] <= lastClosedMonthStart) closedForecastMonthOffsets.push(i);
    else openForecastMonthOffsets.push(i);
  }

  return {
    forecastStart,
    forecastEnd,
    forecastMonths,
    lastClosedMonthStart,
    forecastMonthIndexesInSales,
    historyMonthIndexes,
    closedForecastMonthOffsets,
    openForecastMonthOffsets
  };
}

function dlmZeros_(r, c) {
  const out = [];
  for (let i = 0; i < r; i++) out.push(new Array(c).fill(0));
  return out;
}

function dlmIdentity_(n) {
  const out = dlmZeros_(n, n);
  for (let i = 0; i < n; i++) out[i][i] = 1;
  return out;
}

function dlmTranspose_(A) {
  const r = A.length;
  const c = r ? A[0].length : 0;
  const out = dlmZeros_(c, r);
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) out[j][i] = A[i][j];
  }
  return out;
}

function dlmMatMul_(A, B) {
  const r = A.length;
  const k = r ? A[0].length : 0;
  const c = B.length ? B[0].length : 0;
  const out = dlmZeros_(r, c);
  for (let i = 0; i < r; i++) {
    for (let p = 0; p < k; p++) {
      const av = A[i][p];
      if (!av) continue;
      for (let j = 0; j < c; j++) out[i][j] += av * B[p][j];
    }
  }
  return out;
}

function dlmMatVec_(A, x) {
  const out = new Array(A.length).fill(0);
  for (let i = 0; i < A.length; i++) {
    let sum = 0;
    for (let j = 0; j < x.length; j++) sum += A[i][j] * x[j];
    out[i] = sum;
  }
  return out;
}

function dlmMatAdd_(A, B) {
  const out = dlmZeros_(A.length, A.length ? A[0].length : 0);
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < A[i].length; j++) out[i][j] = A[i][j] + B[i][j];
  }
  return out;
}

function dlmOuter_(u, v) {
  const out = dlmZeros_(u.length, v.length);
  for (let i = 0; i < u.length; i++) {
    for (let j = 0; j < v.length; j++) out[i][j] = u[i] * v[j];
  }
  return out;
}

function dlmDot_(u, v) {
  let sum = 0;
  for (let i = 0; i < u.length; i++) sum += u[i] * v[i];
  return sum;
}

function dlmCloneMat_(A) {
  return A.map(r => r.slice());
}

function dlmBuildTransition_() {
  const T = dlmZeros_(DLM_STATE_DIM, DLM_STATE_DIM);
  T[0][0] = 1;
  T[0][1] = 1;
  T[1][1] = 1;
  for (let c = 2; c < DLM_STATE_DIM; c++) T[2][c] = -1;
  for (let r = 3; r < DLM_STATE_DIM; r++) T[r][r - 1] = 1;
  return T;
}

function dlmBuildObservation_() {
  const H = new Array(DLM_STATE_DIM).fill(0);
  H[0] = 1;
  H[2] = 1;
  return H;
}

function dlmBuildQ_(qLevel, qTrend, qSeasonal) {
  const Q = dlmZeros_(DLM_STATE_DIM, DLM_STATE_DIM);
  Q[0][0] = Math.max(0, Number(qLevel) || 0);
  Q[1][1] = Math.max(0, Number(qTrend) || 0);
  Q[2][2] = Math.max(0, Number(qSeasonal) || 0);
  return Q;
}

function dlmInitState_(logSeries, closedCount) {
  const y = (logSeries || []).filter(v => isFinite(Number(v))).map(Number);
  const recent = y.slice(Math.max(0, y.length - 12));
  let level = median_(recent.length ? recent : y);
  if (!isFinite(level)) level = 0;

  let trend = 0;
  if (closedCount >= 24) {
    const first12 = (logSeries || []).slice(0, 12).filter(v => isFinite(Number(v))).map(Number);
    const last12 = (logSeries || []).slice(Math.max(0, closedCount - 12), closedCount).filter(v => isFinite(Number(v))).map(Number);
    if (first12.length && last12.length) trend = (avg_(last12) - avg_(first12)) / 12;
  }
  if (!isFinite(trend)) trend = 0;

  const seasonal = new Array(DLM_SEASONAL_PERIOD).fill(0);
  for (let m = 0; m < DLM_SEASONAL_PERIOD; m++) {
    const vals = [];
    for (let i = m; i < (logSeries || []).length; i += DLM_SEASONAL_PERIOD) {
      const v = Number(logSeries[i]);
      if (isFinite(v)) vals.push(v - level);
    }
    const med = median_(vals);
    seasonal[m] = isFinite(med) ? med : 0;
  }
  const seasonalMean = avg_(seasonal);
  for (let i = 0; i < seasonal.length; i++) seasonal[i] -= seasonalMean;

  const a = new Array(DLM_STATE_DIM).fill(0);
  a[0] = level;
  a[1] = trend;
  const finalPos = Math.max(0, Number(closedCount || 1) - 1) % DLM_SEASONAL_PERIOD;
  for (let j = 0; j < DLM_SEASONAL_PERIOD - 1; j++) {
    a[2 + j] = seasonal[(finalPos - j + DLM_SEASONAL_PERIOD) % DLM_SEASONAL_PERIOD];
  }

  const P = dlmIdentity_(DLM_STATE_DIM);
  for (let i = 0; i < DLM_STATE_DIM; i++) P[i][i] = DLM_DIFFUSE_VAR;
  return { a, P };
}

function dlmKalmanFilter_(logSeries, T, H, Q, R, a0, P0, opt) {
  let a = (a0 || []).slice();
  let P = dlmCloneMat_(P0 || dlmIdentity_(DLM_STATE_DIM));
  const TT = dlmTranspose_(T);
  const aHistory = [];
  const PHistory = [];
  const innovations = [];
  const y = logSeries || [];

  for (let t = 0; t < y.length; t++) {
    const aPred = dlmMatVec_(T, a);
    const PPred = dlmMatAdd_(dlmMatMul_(dlmMatMul_(T, P), TT), Q);
    const obs = Number(y[t]);

    if (isFinite(obs)) {
      const PH = dlmMatVec_(PPred, H);
      let F = dlmDot_(H, PH) + Number(R || 0);
      if (!isFinite(F) || F <= 0) F = 1e-9;
      const yHat = dlmDot_(H, aPred);
      const v = obs - yHat;

      if (isFinite(v)) {
        const K = PH.map(x => x / F);
        a = aPred.map((x, i) => x + K[i] * v);
        const kk = dlmOuter_(K, K);
        P = dlmZeros_(DLM_STATE_DIM, DLM_STATE_DIM);
        for (let i = 0; i < DLM_STATE_DIM; i++) {
          for (let j = 0; j < DLM_STATE_DIM; j++) P[i][j] = PPred[i][j] - F * kk[i][j];
        }
        innovations.push({ t, v, F });
      } else {
        a = aPred;
        P = PPred;
      }
    } else {
      a = aPred;
      P = PPred;
    }

    aHistory.push(a.slice());
    PHistory.push(dlmCloneMat_(P));
  }

  return { aFinal: a, PFinal: P, innovations, aHistory, PHistory };
}

function dlmConcentratedNLL_(innovations) {
  const used = (innovations || []).filter(x => x && x.t >= DLM_WARMUP_SKIP && isFinite(x.v) && isFinite(x.F) && x.F > 0);
  const nUsed = used.length;
  if (!nUsed) return { sigma2Obs: NaN, nll: Infinity, nUsed: 0 };

  const sigma2Obs = Math.max(1e-9, used.reduce((a, x) => a + (x.v * x.v) / Math.max(x.F, 1e-9), 0) / nUsed);
  const logF = used.reduce((a, x) => a + Math.log(Math.max(x.F, 1e-9)), 0);
  const nll = 0.5 * logF + 0.5 * nUsed * Math.log(sigma2Obs) + 0.5 * nUsed * (1 + Math.log(2 * Math.PI));
  return { sigma2Obs, nll, nUsed };
}

function dlmForecast_(aOrigin, POrigin, T, H, Q, R, sigma2Obs, h) {
  let a = (aOrigin || []).slice();
  let P = dlmCloneMat_(POrigin || dlmIdentity_(DLM_STATE_DIM));
  const TT = dlmTranspose_(T);
  let out = null;
  const s2 = Math.max(1e-9, Number(sigma2Obs) || 1e-9);

  for (let k = 1; k <= h; k++) {
    a = dlmMatVec_(T, a);
    P = dlmMatAdd_(dlmMatMul_(dlmMatMul_(T, P), TT), Q);
    const PH = dlmMatVec_(P, H);
    let varRel = dlmDot_(H, PH) + Number(R || 0);
    if (!isFinite(varRel) || varRel <= 0) varRel = 1e-9;
    const muLog = dlmDot_(H, a);
    const varLog = Math.max(1e-9, varRel * s2);
    const sd = Math.sqrt(varLog);
    out = {
      p50: Math.exp(muLog),
      p10: Math.exp(muLog + DLM_Z10 * sd),
      p90: Math.exp(muLog + DLM_Z90 * sd),
      muLog,
      varLog
    };
  }
  return out || { p50: NaN, p10: NaN, p90: NaN, muLog: NaN, varLog: NaN };
}

function dlmGaussianRandom_() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function dlmFitAndBacktest_(baseSeries48, seriesStart, lastClosedMonthStart, tuning) {
  const cfg = tuning || {};
  const minMonths = Math.round(Math.max(12, Math.min(48, Number(cfg.dlmBacktestMinMonths || 24))));
  const startOriginRaw = Math.round(Math.max(12, Math.min(47, Number(cfg.dlmBacktestStartOrigin || 18))));
  const epsRate = Math.max(0.0001, Math.min(0.5, Number(cfg.dlmLogEpsilonRate || 0.01)));
  const src = Array.isArray(baseSeries48) ? baseSeries48 : [];

  let closedEnd = -1;
  for (let i = 0; i < Math.min(48, src.length); i++) {
    const m = addMonths_(seriesStart, i);
    if (m <= lastClosedMonthStart) closedEnd = i;
  }
  if (closedEnd < 0) return { ready: false, nClosed: 0, minMonths };

  let firstIdx = -1;
  for (let i = 0; i <= closedEnd; i++) {
    const v = Number(src[i]);
    if (isFinite(v) && v > 0) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx < 0) return { ready: false, nClosed: 0, minMonths };

  const raw = [];
  for (let i = firstIdx; i <= closedEnd; i++) {
    const v = Number(src[i]);
    raw.push(isFinite(v) ? Math.max(0, v) : NaN);
  }

  const nClosed = raw.length;
  if (nClosed < minMonths) return { ready: false, nClosed, minMonths };

  const positive = raw.filter(v => isFinite(v) && v > 0);
  const medPositive = median_(positive);
  if (!isFinite(medPositive) || medPositive <= 0) return { ready: false, nClosed: 0, minMonths };
  const eps = Math.max(1e-9, medPositive * epsRate);
  const logSeries = raw.map(v => isFinite(v) ? Math.log(Math.max(v, eps)) : NaN);

  const T = dlmBuildTransition_();
  const H = dlmBuildObservation_();
  const R = 1;
  const init = dlmInitState_(logSeries, nClosed);
  let best = null;

  DLM_Q_GRID.forEach(qLevel => {
    DLM_Q_GRID.forEach(qTrend => {
      DLM_Q_GRID.forEach(qSeasonal => {
        const Q = dlmBuildQ_(qLevel, qTrend, qSeasonal);
        const filter = dlmKalmanFilter_(logSeries, T, H, Q, R, init.a, init.P, {});
        const ll = dlmConcentratedNLL_(filter.innovations);
        if (!isFinite(ll.nll)) return;
        if (!best || ll.nll < best.nll) {
          best = { qLevel, qTrend, qSeasonal, sigma2Obs: ll.sigma2Obs, nll: ll.nll, Q, filter };
        }
      });
    });
  });

  if (!best) throw new Error('DLMハイパラ選択に失敗しました（有効な革新系列がありません）。');

  const originStart = Math.min(startOriginRaw, Math.max(0, nClosed - 2));
  let nPoints = 0;
  let smapeSum = 0;
  let absErrSum = 0;
  let signedErrSum = 0;
  let actualAbsSum = 0;
  let coverageCount = 0;

  for (let o = originStart; o <= nClosed - 2; o++) {
    const aOrigin = best.filter.aHistory[o];
    const POrigin = best.filter.PHistory[o];
    const fc = dlmForecast_(aOrigin, POrigin, T, H, best.Q, R, best.sigma2Obs, 1);
    const actual = Number(raw[o + 1]);
    const pred = Number(fc.p50);
    if (!isFinite(actual) || !isFinite(pred)) continue;
    const absErr = Math.abs(pred - actual);
    const smapeDen = Math.abs(pred) + Math.abs(actual);
    smapeSum += smapeDen > 0 ? (2 * absErr / smapeDen) : 0;
    absErrSum += absErr;
    signedErrSum += pred - actual;
    actualAbsSum += Math.abs(actual);
    if (isFinite(fc.p10) && isFinite(fc.p90) && actual >= fc.p10 && actual <= fc.p90) coverageCount++;
    nPoints++;
  }

  const lastObservedMonth = addMonths_(seriesStart, closedEnd);
  const seasonalByMonth = dlmSeasonalByMonth_(best.filter.aFinal, lastObservedMonth);
  const metrics = {
    smape: nPoints ? smapeSum / nPoints : 0,
    wape: actualAbsSum > 0 ? absErrSum / actualAbsSum : 0,
    biasRate: actualAbsSum > 0 ? signedErrSum / actualAbsSum : 0,
    coverage: nPoints ? coverageCount / nPoints : 0,
    nPoints
  };

  return {
    ready: true,
    nClosed,
    qLevel: best.qLevel,
    qTrend: best.qTrend,
    qSeasonal: best.qSeasonal,
    sigma2Obs: best.sigma2Obs,
    nll: best.nll,
    aFinal: best.filter.aFinal,
    PFinal: best.filter.PFinal,
    levelMu: best.filter.aFinal[0],
    trendBeta: best.filter.aFinal[1],
    seasonalByMonth,
    metrics,
    lastObservedMonth
  };
}

function computeDlmFyForecast_(baseSeries48, seriesStart, lastClosedMonthStart, forecastMonths, tuning) {
  const fit = dlmFitAndBacktest_(baseSeries48, seriesStart, lastClosedMonthStart, tuning);
  if (!fit.ready) {
    return { ready: false, reason: 'insufficient_history', nClosed: fit.nClosed || 0 };
  }

  const T = dlmBuildTransition_();
  const H = dlmBuildObservation_();
  const Q = dlmBuildQ_(fit.qLevel, fit.qTrend, fit.qSeasonal);
  const R = 1;
  const p10 = [];
  const p50 = [];
  const p90 = [];
  const logByMonth = [];

  (forecastMonths || []).forEach(m => {
    const h = monthIndexFromStart_(m, fit.lastObservedMonth);
    if (h < 1) {
      p10.push(null);
      p50.push(null);
      p90.push(null);
      logByMonth.push(null);
      return;
    }
    const fc = dlmForecast_(fit.aFinal, fit.PFinal, T, H, Q, R, fit.sigma2Obs, h);
    p10.push(fc.p10);
    p50.push(fc.p50);
    p90.push(fc.p90);
    const sd = Math.sqrt(Math.max(1e-12, Number(fc.varLog) || 0));
    logByMonth.push({ muLog: Number(fc.muLog), sd });
  });

  return {
    ready: true,
    p10,
    p50,
    p90,
    logByMonth,
    lastObservedMonth: fit.lastObservedMonth,
    metrics: fit.metrics,
    hyper: {
      qLevel: fit.qLevel,
      qTrend: fit.qTrend,
      qSeasonal: fit.qSeasonal,
      sigma2Obs: fit.sigma2Obs,
      nll: fit.nll,
      nClosed: fit.nClosed
    }
  };
}

function dlmSeasonalByMonth_(aFinal, lastObservedMonth) {
  const vals = {};
  let sum11 = 0;
  for (let j = 0; j < DLM_SEASONAL_PERIOD - 1; j++) {
    const m = addMonths_(lastObservedMonth, -j).getMonth() + 1;
    const v = Number(aFinal[2 + j] || 0);
    vals[m] = v;
    sum11 += v;
  }
  const missingMonth = addMonths_(lastObservedMonth, -(DLM_SEASONAL_PERIOD - 1)).getMonth() + 1;
  vals[missingMonth] = -sum11;

  const mean = avg_(Object.keys(vals).map(k => vals[k]));
  const out = {};
  for (let m = 1; m <= DLM_SEASONAL_PERIOD; m++) out[String(m)] = Number(vals[m] || 0) - mean;
  return out;
}


function fitSpotRecurringModel_(spotSeries48, seriesStart, lastClosedMonthStart, baseP50ByMonth, tuning) {
  const src = Array.isArray(spotSeries48) ? spotSeries48 : [];
  const baseRef = Array.isArray(baseP50ByMonth) ? baseP50ByMonth : new Array(12).fill(0);
  const cfg = tuning || {};
  const shrink = isFinite(cfg.spotBgShrink) ? cfg.spotBgShrink : SPOT_BG_SHRINK;
  const floorRate = isFinite(cfg.spotBgFloorRate) ? cfg.spotBgFloorRate : SPOT_BG_FLOOR_RATE;
  const capRate = isFinite(cfg.spotBgCapRate) ? cfg.spotBgCapRate : SPOT_BG_CAP_RATE;
  const madK = isFinite(cfg.spotSpikeMadK) ? cfg.spotSpikeMadK : SPOT_SPIKE_MAD_K;

  const expectedByMonth = new Array(12).fill(0);
  const occurrenceProbByMonth = new Array(12).fill(0.10);
  const severitySamplesByMonth = Array.from({ length: 12 }, () => [0]);

  if (src.length === 0) {
    return { expectedByMonth, occurrenceProbByMonth, severitySamplesByMonth };
  }

  const closedIdx = [];
  for (let i = 0; i < src.length; i++) {
    const mStart = addMonths_(seriesStart, i);
    if (mStart <= lastClosedMonthStart) closedIdx.push(i);
  }

  for (let m = 0; m < 12; m++) {
    const vals = [];
    for (let j = 0; j < closedIdx.length; j++) {
      const idx = closedIdx[j];
      if (idx % 12 !== m) continue;
      const v = Number(src[idx] || 0);
      if (isFinite(v) && v > 0) vals.push(v);
    }

    if (vals.length === 0) {
      expectedByMonth[m] = 0;
      occurrenceProbByMonth[m] = 0.05;
      severitySamplesByMonth[m] = [0];
      continue;
    }

    const med = median_(vals);
    const mad = median_(vals.map(v => Math.abs(v - med))) || 1;
    const spikeThr = med + madK * mad;
    const filtered = vals.filter(v => v <= spikeThr);
    const used = filtered.length ? filtered : vals;

    const monthAvg = avg_(used);
    const bg = Math.max(monthAvg * shrink, monthAvg * floorRate);
    const cap = Math.max(0, Number(baseRef[m] || 0) * capRate);
    expectedByMonth[m] = Math.max(0, Math.min(bg, cap));

    const denomYears = Math.max(1, Math.ceil(Math.max(1, closedIdx.length) / 12));
    const occRaw = used.length / denomYears;
    occurrenceProbByMonth[m] = Math.max(0.05, Math.min(0.95, occRaw));
    severitySamplesByMonth[m] = used.map(v => Math.max(0, Math.min(v, cap))).filter(v => isFinite(v));
    if (!severitySamplesByMonth[m].length) severitySamplesByMonth[m] = [expectedByMonth[m]];
  }

  return { expectedByMonth, occurrenceProbByMonth, severitySamplesByMonth };
}

function readDevSpotProjects12Months_(fy) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.DEV_SPOT);
  const out = Array.from({ length: 12 }, () => []);
  if (!sh || sh.getLastRow() < 2) return out;

  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  const start = getForecastFYStart_(fy);

  vals.forEach(r => {
    const dt = toDate_(r[1]);
    if (!dt) return;
    const idx = monthIndexFromStart_(dt, start);
    if (idx < 0 || idx >= 12) return;

    const amount = toNumberSafe_(r[3]);
    const conf = Number(r[4]);
    if (!isFinite(amount) || amount <= 0) return;
    if (!isFinite(conf) || conf < 0 || conf > 1) return;

    out[idx].push({ amount, confidence: conf });
  });
  return out;
}

function computeKnownSpotExpectedByMonth_(projectsByMonth) {
  return (projectsByMonth || []).map(arr => (arr || []).reduce((a, p) => a + Number(p.amount || 0) * Number(p.confidence || 0), 0));
}

function simulateKnownSpotByMonth_(projects) {
  let total = 0;
  (projects || []).forEach(p => {
    if (Math.random() < Number(p.confidence || 0)) total += Number(p.amount || 0);
  });
  return Math.max(0, total);
}

function sampleSpotBackgroundAmount_(spotModel, monthIdx, suppressRate) {
  const occ = Number((spotModel && spotModel.occurrenceProbByMonth && spotModel.occurrenceProbByMonth[monthIdx]) || 0);
  if (Math.random() > Math.max(0, Math.min(1, occ * (isFinite(suppressRate) ? suppressRate : 1)))) return 0;
  const samples = (spotModel && spotModel.severitySamplesByMonth && spotModel.severitySamplesByMonth[monthIdx]) || [0];
  const picked = Number(samples[Math.floor(Math.random() * samples.length)] || 0);
  return Math.max(0, picked);
}

function computeProductWeightsFromSalesInputClosed12_(fy, client, ctx) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.SALES_INPUT);
  const map = new Map();
  if (!sh || sh.getLastRow() < 2) return map;

  const vals = sh.getDataRange().getValues().slice(1);
  const forecastStart = getForecastFYStart_(fy);
  const closedHistStart = addMonths_(forecastStart, -12);
  const closedHistEnd = ctx.lastClosedMonthStart;

  vals.forEach(r => {
    const c = String(r[0] || '').trim();
    const type = String(r[1] || '').trim();
    const product = String(r[2] || '').trim();
    const ym = toMonthStart_(r[3]);
    const amt = toNumberSafe_(r[4]);
    if (!c || !isSameClient_(c, client)) return;
    if (type !== 'BASE' || !product || !ym || !isFinite(amt)) return;
    if (ym < closedHistStart || ym > closedHistEnd) return;
    map.set(product, (map.get(product) || 0) + amt);
  });

  const total = Array.from(map.values()).reduce((a, b) => a + b, 0);
  if (total <= 0) return new Map();

  const out = new Map();
  map.forEach((v, k) => out.set(k, v / total));
  return out;
}

function sumAcrossProducts_(monthlyByProduct) {
  const n = 48;
  const out = new Array(n).fill(0);
  monthlyByProduct.forEach(arr => {
    for (let i = 0; i < n; i++) out[i] += Number(arr[i] || 0);
  });
  return out;
}

/** DEV固定（12ヶ月）※必要情報が揃った行だけ加算 */
function readDevFixed12Months_(fy) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.DEV_SPOT);
  const out = new Array(12).fill(0);
  if (!sh) return out;

  const last = sh.getLastRow();
  if (last < 2) return out;

  const vals = sh.getRange(2, 1, last - 1, 5).getValues();
  const start = getForecastFYStart_(fy);

  vals.forEach(r => {
    const dt = toDate_(r[1]);
    if (!dt) return;

    const amountRaw = r[3];
    const confRaw = r[4];
    if (amountRaw === '' || amountRaw === null) return;
    if (confRaw === '' || confRaw === null) return;

    const amt = toNumberSafe_(amountRaw);
    if (!isFinite(amt) || amt === 0) return;

    const conf = Number(confRaw);
    if (!isFinite(conf) || conf < 0 || conf > 1) return;

    const idx = monthIndexFromStart_(dt, start);
    if (idx < 0 || idx >= 12) return;

    out[idx] += amt * conf;
  });

  return out;
}

/** PRODUCT ※必要情報が揃った行だけ */
function readFactorsProduct_(fy) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.PRODUCT);
  if (!sh || sh.getLastRow() < 2) return [];

  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  return vals.map(r => {
    const person = String(r[0] || '').trim();
    const product = String(r[1] || '').trim();
    const monthRaw = r[2];
    const stepRaw = r[3];
    const reason = String(r[4] || '').trim();

    // 必須が揃っていない行は無視
    if (!person || !product || !monthRaw || stepRaw === '' || stepRaw === null) return null;

    const dt = toDate_(monthRaw);
    const step = parseRate_(stepRaw);
    if (!dt || !isFinite(step)) return null;

    return { person, product, month: dt, step, reason };
  }).filter(Boolean);
}

/** CLIENT ※必要情報が揃った行だけ */
function readFactorsClient_(fy) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.CLIENT);
  if (!sh || sh.getLastRow() < 2) return [];

  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
  return vals.map(r => {
    const person = String(r[0] || '').trim();
    const monthRaw = r[1];
    const stepRaw = r[2];
    const reason = String(r[3] || '').trim();

    if (!person || !monthRaw || stepRaw === '' || stepRaw === null) return null;

    const dt = toDate_(monthRaw);
    const step = parseRate_(stepRaw);
    if (!dt || !isFinite(step)) return null;

    return { person, month: dt, step, reason };
  }).filter(Boolean);
}

/** OPINIONS ※必要情報が揃った行だけ */
function readOpinions_(fy) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.OPINIONS);
  if (!sh || sh.getLastRow() < 2) return [];

  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  return vals.map(r => {
    const person = String(r[0] || '').trim();
    const monthRaw = r[1];
    const stepRaw = r[2];
    const confRaw = r[3];
    const note = String(r[4] || '').trim();

    if (!person || !monthRaw || stepRaw === '' || stepRaw === null || confRaw === '' || confRaw === null) return null;

    const dt = toDate_(monthRaw);
    const step = parseRate_(stepRaw);
    const conf = Number(confRaw);

    if (!dt || !isFinite(step) || !isFinite(conf) || conf < 0 || conf > 1) return null;

    return { person, month: dt, step, confidence: conf, note };
  }).filter(Boolean);
}

/**
 * AI_RESEARCH_STRUCTURED から topic 別のAIスコアを読み取り、
 * benchmark/event blend の最終スコアを返す。
 */
function readAIResearchScores_(calibration, opt) {
  const result = { Market: 0, Competitor: 0, Channel: 0, DX: 0, meta: { Market: {}, Competitor: {}, Channel: {}, DX: {} } };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.AI_RESEARCH_STRUCTURED);
  if (!sh) return result;

  const last = sh.getLastRow();
  if (last < 2) return result;

  const vals = sh.getDataRange().getValues();
  const header = vals[0];

  const idx = {};
  header.forEach((h, i) => { idx[String(h || '').trim()] = i; });
  const topicIdx = idx.topic;
  if (topicIdx === undefined) return result;
  const rowTypeIdx = idx.row_type;
  const eventScoreIdx = idx.event_score;
  const benchmarkScoreIdx = idx.benchmark_score;
  const directionIdx = idx.direction;
  const impactIdx = idx.impact_score;
  const confIdx = idx.confidence;
  const relPctIdx = idx.relative_percentile;
  const relConfIdx = idx.relative_confidence;
  const qualityIdx = idx.benchmark_quality;
  const labelIdx = idx.relative_position_label;
  const peerUIdx = idx.peer_universe;
  const peerBIdx = idx.peer_basis;
  const asOfIdx = idx.as_of_date;

  const disabledTopics = new Set();
  try {
    const arr = JSON.parse(String((calibration && calibration.ai_topic_disable_json) || '[]'));
    (Array.isArray(arr) ? arr : []).forEach(t => disabledTopics.add(normalizeAiTopic_(t)));
  } catch (err) {
    // JSON不正時は無効化なしで継続
  }
  const missingConfDefault = readAiMissingConfidenceDefault_();
  const blend = { Market: [0.65, 0.35], Competitor: [0.70, 0.30], Channel: [0.65, 0.35], DX: [0.50, 0.50] };
  const eventArr = { Market: [], Competitor: [], Channel: [], DX: [] };
  const benchArr = { Market: [], Competitor: [], Channel: [], DX: [] };
  const latestMeta = { Market: null, Competitor: null, Channel: null, DX: null };
  // event候補（direction/impactあり）だが confidence 欠落で重み0となり不採用にした件数（診断用 / 採点には不使用）
  const eventDroppedMissingConf = { Market: 0, Competitor: 0, Channel: 0, DX: 0 };
  // confidence/relative_confidence 欠落を既定値で補完して採用した件数（診断用）
  const eventDefaultedMissingConf = { Market: 0, Competitor: 0, Channel: 0, DX: 0 };
  const benchDefaultedMissingConf = { Market: 0, Competitor: 0, Channel: 0, DX: 0 };
  const qualityMul = q => (q === 'high' ? 1 : (q === 'medium' ? 0.75 : 0.5));
  const now = new Date();
  for (let i = 1; i < vals.length; i++) {
    const topic = normalizeAiTopic_(vals[i][topicIdx]);
    if (eventArr[topic] === undefined) continue;
    const rowTypeRaw = rowTypeIdx === undefined ? 'event' : normalizeAiCellValue_(vals[i][rowTypeIdx]);
    const rowType = (rowTypeRaw === 'benchmark') ? 'benchmark' : 'event';
    const asOf = toDate_(asOfIdx === undefined ? '' : normalizeAiCellValue_(vals[i][asOfIdx]));
    if (asOf && (!latestMeta[topic] || latestMeta[topic].asOf < asOf)) {
      latestMeta[topic] = {
        asOf,
        label: String(labelIdx === undefined ? '' : vals[i][labelIdx] || ''),
        universe: String(peerUIdx === undefined ? '' : vals[i][peerUIdx] || ''),
        basis: String(peerBIdx === undefined ? '' : vals[i][peerBIdx] || '')
      };
    }

    const eventScoreCell = eventScoreIdx === undefined ? '' : vals[i][eventScoreIdx];
    let eventScore = (eventScoreCell === '' || eventScoreCell === null || eventScoreCell === undefined) ? NaN : Number(eventScoreCell);
    if (!isFinite(eventScore)) {
      const direction = normalizeAiDirection_(directionIdx === undefined ? '' : vals[i][directionIdx]);
      const sign = direction === 'up' ? 1 : (direction === 'down' ? -1 : 0);
      const impact = parseAiNumericScore_(impactIdx === undefined ? '' : vals[i][impactIdx], 'impact_score');
      let conf = parseAiConfidence_(confIdx === undefined ? '' : vals[i][confIdx]);
      if (!isFinite(conf) && (direction || isFinite(impact)) && missingConfDefault > 0) conf = missingConfDefault;
      if (isFinite(impact) && isFinite(conf)) eventScore = sign * (impact / 100) * 50 * conf;
    }
    if (isFinite(eventScore)) eventScore = clamp_(eventScore, -50, 50);

    const benchScoreCell = benchmarkScoreIdx === undefined ? '' : vals[i][benchmarkScoreIdx];
    let benchScore = (benchScoreCell === '' || benchScoreCell === null || benchScoreCell === undefined) ? NaN : Number(benchScoreCell);
    if (!isFinite(benchScore) && relPctIdx !== undefined) {
      const relPct = parseAiPercentile_(relPctIdx === undefined ? '' : vals[i][relPctIdx]);
      let relConf = parseAiConfidence_(relConfIdx === undefined ? '' : vals[i][relConfIdx]);
      if (!isFinite(relConf) && isFinite(relPct) && missingConfDefault > 0) relConf = missingConfDefault;
      const qInfo = coerceBenchmarkQuality_(qualityIdx === undefined ? '' : vals[i][qualityIdx]);
      if (isFinite(relPct) && isFinite(relConf)) benchScore = (relPct - 50) * relConf * qualityMul(qInfo.value);
    }
    if (isFinite(benchScore)) benchScore = clamp_(benchScore, -50, 50);

    if (rowType === 'benchmark') {
      let relConf = parseAiConfidence_(relConfIdx === undefined ? '' : vals[i][relConfIdx]);
      let benchDefaulted = false;
      if (!isFinite(relConf)) {
        const relPctRaw = parseAiPercentile_(relPctIdx === undefined ? '' : vals[i][relPctIdx]);
        if (isFinite(relPctRaw) && missingConfDefault > 0) { relConf = missingConfDefault; benchDefaulted = true; }
      }
      const qInfo = coerceBenchmarkQuality_(qualityIdx === undefined ? '' : vals[i][qualityIdx]);
      const wt = isFinite(relConf) ? Math.max(0, relConf) * qualityMul(qInfo.value) : 0;
      if (isFinite(benchScore) && wt > 0) {
        benchArr[topic].push({ score: benchScore, weight: wt });
        if (benchDefaulted) benchDefaultedMissingConf[topic] = Number(benchDefaultedMissingConf[topic] || 0) + 1;
      }
    } else {
      let conf = parseAiConfidence_(confIdx === undefined ? '' : vals[i][confIdx]);
      let confDefaulted = false;
      const dirRaw = directionIdx === undefined ? '' : normalizeAiDirection_(vals[i][directionIdx]);
      const impactRaw = parseAiNumericScore_(impactIdx === undefined ? '' : vals[i][impactIdx], 'impact_score');
      if (!isFinite(conf) && (dirRaw || isFinite(impactRaw)) && missingConfDefault > 0) { conf = missingConfDefault; confDefaulted = true; }
      const months = asOf ? monthDiffFloor_(asOf, now) : AI_MAX_AGE_MONTHS + 1;
      if (!isFinite(months) || months > AI_MAX_AGE_MONTHS) continue;
      const decay = Math.pow(0.5, Math.max(0, months) / AI_EVENT_DECAY_HALF_LIFE_MONTHS);
      const wt = isFinite(conf) ? Math.max(0, conf) * decay : 0;
      if (isFinite(eventScore) && wt > 0) {
        eventArr[topic].push({ score: eventScore, weight: wt });
        if (confDefaulted) eventDefaultedMissingConf[topic] = Number(eventDefaultedMissingConf[topic] || 0) + 1;
      } else if (!isFinite(conf) && (dirRaw || isFinite(impactRaw))) {
        // confidence 欠落かつ既定補完OFF(=0) → 不採用。実体のある event候補のみ診断計上。
        eventDroppedMissingConf[topic] = Number(eventDroppedMissingConf[topic] || 0) + 1;
      }
    }
  }

  const topicsMissingBenchmark = [];
  const tuningAi = readModelTuningFromConfig_();
  const qualityNeutralThreshold = isFinite(tuningAi.aiQualityNeutralThreshold) ? tuningAi.aiQualityNeutralThreshold : AI_QUALITY_NEUTRAL_THRESHOLD;
  const qualityPartialThreshold = isFinite(tuningAi.aiQualityPartialThreshold) ? tuningAi.aiQualityPartialThreshold : AI_QUALITY_PARTIAL_THRESHOLD;
  AI_TOPICS.forEach(topic => {
    const benchAgg = robustWeightedTopicScore_(benchArr[topic], AI_MAD_CLIP_K);
    const eventAgg = robustWeightedTopicScore_(eventArr[topic], AI_MAD_CLIP_K);
    const bAvg = benchAgg.avg;
    const eAvg = eventAgg.avg;
    const benchCount = benchArr[topic].length;
    const eventCount = eventArr[topic].length;
    const degradedMode = (benchCount === 0 && eventCount >= 1)
      ? 'event_only'
      : ((benchCount >= 1 && eventCount === 0)
        ? 'benchmark_only'
        : ((benchCount === 0 && eventCount === 0) ? 'no_data' : 'blended'));
    let finalScore = 0;
    if (bAvg === null && eAvg !== null) finalScore = eAvg;
    else if (bAvg !== null && eAvg === null) finalScore = bAvg;
    else if (bAvg !== null && eAvg !== null) finalScore = bAvg * blend[topic][0] + eAvg * blend[topic][1];
    const qualityRaw = (benchCount * 2 + eventCount) / 4;
    const qualityScore = clamp_(qualityRaw, 0, 1);
    const degradedMultiplier = 1; // event_only への構造的0.5ペナルティを撤去。信号の弱さは coverage由来の qualityMultiplier で別途反映する。
    let qualityMultiplier = 1;
    let neutralized = false;
    if (qualityScore < qualityNeutralThreshold) {
      qualityMultiplier = 0;
      neutralized = true;
    } else if (qualityScore < qualityPartialThreshold) {
      qualityMultiplier = 0.5;
      neutralized = true;
    }
    const effectiveMultiplier = Math.min(degradedMultiplier, qualityMultiplier);
    finalScore *= effectiveMultiplier;
    const capped = Math.abs(finalScore) > AI_TOPIC_SCORE_ABS_CAP;
    const clampedFinal = capped ? (finalScore > 0 ? AI_TOPIC_SCORE_ABS_CAP : -AI_TOPIC_SCORE_ABS_CAP) : finalScore;
    const scoreOut = Math.round(clampedFinal * 10) / 10;
    result[topic] = disabledTopics.has(topic) ? 0 : scoreOut;
    const latest = latestMeta[topic] || {};
    const noData = (benchCount === 0 && eventCount === 0);
    if (benchCount === 0) topicsMissingBenchmark.push(topic);
    result.meta[topic] = {
      label: latest.label || '',
      universe: latest.universe || '',
      basis: latest.basis || '',
      coverageEventRows: eventCount,
      coverageBenchmarkRows: benchCount,
      eventDroppedMissingConf: Number(eventDroppedMissingConf[topic] || 0),
      eventDefaultedMissingConf: Number(eventDefaultedMissingConf[topic] || 0),
      benchDefaultedMissingConf: Number(benchDefaultedMissingConf[topic] || 0),
      latestAsOfDate: latest.asOf ? Utilities.formatDate(new Date(latest.asOf), Session.getScriptTimeZone(), 'yyyy-MM-dd') : '',
      clamped: !!(benchAgg.clamped || eventAgg.clamped),
      no_data: !!noData,
      capped: !!capped,
      degradedMode,
      qualityScore,
      neutralized,
      effectiveMultiplier,
      disabled: disabledTopics.has(topic)
    };
  });
  result.meta.topicsMissingBenchmark = topicsMissingBenchmark;

  const basis = opt && opt.basis === 'momentum' ? 'momentum' : 'level';
  if (basis !== 'momentum') return result;
  return applyAiMomentumScores_(result, opt || {});
}

function applyAiMomentumScores_(levelResult, opt) {
  const result = levelResult || { Market: 0, Competitor: 0, Channel: 0, DX: 0, meta: { Market: {}, Competitor: {}, Channel: {}, DX: {} } };
  const meta = result.meta || {};
  const tuning = opt && opt.tuning ? opt.tuning : readModelTuningFromConfig_();
  const lookback = Math.round(Math.max(1, Math.min(8, Number(tuning.aiMomentumLookbackQuarters || 2))));
  const minHistory = Math.round(Math.max(1, Math.min(12, Number(tuning.aiMomentumMinHistory || 2))));
  const client = String((opt && opt.clientName) || '').trim();
  const history = readAiScoreHistoryByTopic_(client);

  AI_TOPICS.forEach(topic => {
    const levelScore = Number(result[topic] || 0);
    const rows = history[topic] || [];
    const m = meta[topic] || {};
    if (m.disabled) {
      result[topic] = 0;
      meta[topic] = Object.assign({}, m, {
        aiScoreBasis: 'momentum',
        levelScore,
        momentumScore: 0,
        momentumRaw: 0,
        momentumRecentLevel: levelScore,
        momentumPastLevel: '',
        momentumLookbackQuarters: lookback,
        momentumHistoryCount: rows.length,
        momentumInsufficient: false
      });
      return;
    }
    const insufficient = rows.length < minHistory;
    let momentumRaw = 0;
    let pastScore = '';
    if (!insufficient) {
      const pastIdx = Math.max(0, rows.length - lookback);
      pastScore = Number(rows[pastIdx].score || 0);
      momentumRaw = levelScore - pastScore;
    }
    const momentumScore = insufficient ? 0 : Math.round(clamp_(momentumRaw, -50, 50) * 10) / 10;
    result[topic] = momentumScore;
    meta[topic] = Object.assign({}, m, {
      aiScoreBasis: 'momentum',
      levelScore,
      momentumScore,
      momentumRaw,
      momentumRecentLevel: levelScore,
      momentumPastLevel: pastScore,
      momentumLookbackQuarters: lookback,
      momentumHistoryCount: rows.length,
      momentumInsufficient: insufficient
    });
  });
  result.meta = meta;
  result.meta.aiScoreBasis = 'momentum';
  return result;
}

function readAiScoreHistoryByTopic_(clientName) {
  const out = { Market: [], Competitor: [], Channel: [], DX: [] };
  if (!clientName) return out;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SHEETS.AI_SCORE_HISTORY);
    if (!sh || sh.getLastRow() < 2) return out;
    const vals = sh.getDataRange().getValues();
    const idx = headerIndexMap_(vals[0]);
    if (idx.client === undefined || idx.topic === undefined || idx.blended_score === undefined || idx.run_at === undefined) return out;
    // as_of_date（A-4リサーチのリフレッシュ）単位で dedup。同一スナップショットを複数回A-9しても
    // 履歴点は1つに畳み、lookbackが「A-9実行回数」ではなく「調査リフレッシュ回数」を遡るようにする。
    // 同一as_of内では最新run_at（同点はrowNo大）を採用。as_of欠落の旧行は各行を独立点として温存する。
    const byTopicSnapshot = { Market: new Map(), Competitor: new Map(), Channel: new Map(), DX: new Map() };
    for (let i = 1; i < vals.length; i++) {
      const rowClient = String(vals[i][idx.client] || '').trim();
      if (!rowClient || !isSameClient_(rowClient, clientName)) continue;
      const topic = normalizeAiTopic_(vals[i][idx.topic]);
      if (!topic || byTopicSnapshot[topic] === undefined) continue;
      const score = Number(vals[i][idx.blended_score]);
      if (!isFinite(score)) continue;
      const runAt = toDate_(vals[i][idx.run_at]) || new Date(0);
      const asOf = (idx.latest_as_of_date !== undefined) ? toDate_(vals[i][idx.latest_as_of_date]) : null;
      const snapKey = asOf ? Utilities.formatDate(asOf, TZ, 'yyyy-MM-dd') : `runrow:${i}`;
      const sortAt = asOf ? asOf : runAt;
      const prev = byTopicSnapshot[topic].get(snapKey);
      if (!prev || runAt.getTime() > prev.runAt.getTime() || (runAt.getTime() === prev.runAt.getTime() && i > prev.rowNo)) {
        byTopicSnapshot[topic].set(snapKey, { sortAt, runAt, score, rowNo: i });
      }
    }
    AI_TOPICS.forEach(topic => {
      out[topic] = Array.from(byTopicSnapshot[topic].values())
        .sort((a, b) => {
          const d = a.sortAt.getTime() - b.sortAt.getTime();
          return d !== 0 ? d : a.rowNo - b.rowNo;
        })
        .map(x => ({ runAt: x.runAt, score: x.score, rowNo: x.rowNo }));
    });
  } catch (err) {
    // 履歴読取に失敗した場合は履歴なしとしてmomentumを中立化する
  }
  return out;
}

function readAIReportTextForClient_(clientName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.AI_RESEARCH_STRUCTURED);
  if (sh) {
    const vals = sh.getDataRange().getValues();
    if (vals.length >= 2) {
      const header = vals[0].map(v => String(v || '').trim());
      const reportIdx = header.indexOf('report_text');
      const clientIdx = header.indexOf('client');
      const asOfIdx = header.indexOf('as_of_date');
      if (reportIdx >= 0) {
        const rows = [];
        for (let i = 1; i < vals.length; i++) {
          const report = vals[i][reportIdx];
          const reportText = report === null || report === undefined ? '' : String(report);
          if (!reportText.trim()) continue;
          if (clientIdx >= 0 && clientName) {
            const rowClient = String(vals[i][clientIdx] || '').trim();
            if (rowClient && !isSameClient_(rowClient, clientName)) continue;
          }
          const asOfRaw = asOfIdx >= 0 ? vals[i][asOfIdx] : '';
          const asOfDate = toDate_(asOfRaw) || new Date(0);
          rows.push({ reportText, asOfDate, rowNo: i });
        }
        rows.sort((a, b) => {
          if (b.asOfDate.getTime() !== a.asOfDate.getTime()) return b.asOfDate - a.asOfDate;
          return b.rowNo - a.rowNo;
        });
        if (rows.length) return sanitizeAiReportText_(rows[0].reportText);
      }
    }
  }

  const promptSh = ss.getSheetByName(SHEETS.AI_RESEARCH);
  if (!promptSh) return '';
  const txt = String(promptSh.getRange('D2').getValue() || '');
  return sanitizeAiReportText_(extractReportSection_(txt));
}

function extractReportSection_(txt) {
  if (!txt) return '';
  const pairs = [
    ['###REPORT_START###', '###REPORT_END###'],
    ['===REPORT_START===', '===REPORT_END===']
  ];
  for (let i = 0; i < pairs.length; i++) {
    const start = pairs[i][0];
    const end = pairs[i][1];
    const sIdx = txt.indexOf(start);
    if (sIdx < 0) continue;
    const eIdx = txt.indexOf(end, sIdx + start.length);
    if (eIdx < 0) continue;
    return txt.substring(sIdx + start.length, eIdx).trim();
  }
  return txt;
}

function sanitizeAiReportText_(txt) {
  let s = String(txt || '');
  if (!s) return '';
  const startPatterns = ['【Market】', '【Competitor】', '【Channel】', '【DX】', '**1. Market', '**2. Competitor', '**3. Channel', '**4. DX', '## I.', '## II.'];
  let startIdx = -1;
  startPatterns.forEach(p => {
    const idx = s.indexOf(p);
    if (idx >= 0 && (startIdx < 0 || idx < startIdx)) startIdx = idx;
  });
  if (startIdx > 0) s = s.substring(startIdx);
  const removePhrases = ['お任せください', '私はAIアシスタントとして', '客観的な事実に基づき', '分析しました', '次に、', '深掘りして分析しましょうか', 'これらの分析結果の詳細は、以下のデータテーブルに整理しています。'];
  removePhrases.forEach(p => { s = s.split(p).join(''); });
  s = s.replace(/^.*ですね。/gm, '');
  const lines = s.split(/\r?\n/);
  while (lines.length && /[？?]$/.test(String(lines[lines.length - 1]).trim())) lines.pop();
  s = lines.join('\n');
  s = s.replace(/(^|\n)\s*#{1,3}\s*/g, '$1');
  s = s.replace(/\*\*/g, '');
  s = s.replace(/^[\-\*]\s+/gm, '');
  return s.trim();
}

function normalizeAiDirection_(v) {
  const s = normalizeAiCellValue_(v).toLowerCase();
  if (!s) return '';
  if (/(up|positive|posi|上昇|増)/.test(s)) return 'up';
  if (/(down|negative|nega|低下|減)/.test(s)) return 'down';
  if (/(neutral|中立)/.test(s)) return 'neutral';
  return s;
}

function parseAiNumericScore_(v, fieldName) {
  const s0 = normalizeAiCellValue_(v);
  const n = Number(s0);
  if (isFinite(n)) return n;
  const s = s0.toLowerCase();
  if (!s) return NaN;
  if (fieldName === 'impact_score') {
    if (s === 'high') return 80;
    if (s === 'medium') return 60;
    if (s === 'low') return 40;
  }
  return NaN;
}

function parseAiConfidence_(v) {
  const s0 = normalizeAiCellValue_(v);
  if (!s0) return NaN;
  const n = Number(s0);
  if (isFinite(n)) {
    if (n >= 0 && n <= 1) return n;
    if (n > 1 && n <= 5) return NaN;
    if (n > 5 && n <= 100) return n / 100;
    return NaN;
  }
  const s = s0.toLowerCase();
  if (s === 'high') return 0.90;
  if (s === 'medium') return 0.70;
  if (s === 'low') return 0.50;
  return NaN;
}

function parseAiPercentile_(v) {
  const s0 = normalizeAiCellValue_(v);
  if (!s0) return NaN;
  const n = Number(s0);
  if (isFinite(n)) return n;
  const s = s0.toLowerCase();
  if (/top\s*10|上位\s*10/.test(s)) return 90;
  if (/top\s*20|上位\s*20/.test(s)) return 80;
  if (/top\s*25|上位\s*25/.test(s)) return 75;
  const m = s.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
  if (m) return Number(m[1]);
  return NaN;
}

function inferPercentileFromLabel_(label) {
  const s = String(label || '').trim().toLowerCase();
  if (!s) return NaN;
  if (s === 'top') return 90;
  if (s === 'upper') return 75;
  if (s === 'middle') return 50;
  if (s === 'lower') return 25;
  if (s === 'bottom') return 10;
  return NaN;
}

function coerceBenchmarkQuality_(raw) {
  const s = normalizeAiCellValue_(raw).toLowerCase();
  if (s === 'high' || s === 'medium' || s === 'low') {
    return { value: s, coerced: false };
  }
  // 不正値はmediumに寄せて処理継続
  return { value: 'medium', coerced: true };
}

function normalizeAiCellValue_(v) {
  let s = String(v === null || v === undefined ? '' : v);
  if (!s) return '';
  const fwMap = {
    '　': ' ', '％': '%', '，': ',', '－': '-', '−': '-', '’': "'", '“': '"', '”': '"',
    '「': '', '」': '', '『': '', '』': '', '＃': '#', '／': '/', '：': ':'
  };
  Object.keys(fwMap).forEach(k => { s = s.split(k).join(fwMap[k]); });
  s = s.replace(/[“”"']/g, '');
  s = s.trim();
  if (/^(-|n\/a|na|不明)$/i.test(s)) return '';
  return s;
}

function normalizeAiTopic_(v) {
  const s = normalizeAiCellValue_(v);
  return AI_TOPICS.indexOf(s) >= 0 ? s : '';
}

function robustWeightedTopicScore_(pairs, madK) {
  const out = { avg: null, clamped: false };
  if (!pairs || !pairs.length) return out;
  const clean = pairs.filter(p => isFinite(Number(p.score)) && isFinite(Number(p.weight)) && Number(p.weight) > 0)
    .map(p => ({ score: Number(p.score), weight: Number(p.weight) }));
  if (!clean.length) return out;
  let scores = clean.map(p => p.score);
  if (clean.length >= 3) {
    const med = median_(scores);
    const mad = median_(scores.map(v => Math.abs(v - med)));
    if (isFinite(mad) && mad > 0) {
      const lo = med - madK * mad;
      const hi = med + madK * mad;
      const clipped = clean.map(p => {
        const s = clamp_(p.score, lo, hi);
        if (s !== p.score) out.clamped = true;
        return { score: s, weight: p.weight };
      });
      scores = clipped.map(p => p.score);
      const den = clipped.reduce((a, p) => a + p.weight, 0);
      out.avg = den > 0 ? clipped.reduce((a, p) => a + p.score * p.weight, 0) / den : null;
      return out;
    }
  }
  const den = clean.reduce((a, p) => a + p.weight, 0);
  out.avg = den > 0 ? clean.reduce((a, p) => a + p.score * p.weight, 0) / den : null;
  return out;
}

function monthDiffFloor_(past, now) {
  if (!(past instanceof Date) || !(now instanceof Date)) return NaN;
  const y = now.getFullYear() - past.getFullYear();
  const m = now.getMonth() - past.getMonth();
  return y * 12 + m;
}

function median_(arr) {
  const v = (arr || []).filter(x => isFinite(Number(x))).map(Number).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const mid = Math.floor(v.length / 2);
  if (v.length % 2) return v[mid];
  return (v[mid - 1] + v[mid]) / 2;
}

/** ====== 予測計算（モデル） ====== */
function fitOpsModelTrendSeason_(y) {
  const n = y.length;
  const x = [];
  for (let i = 0; i < n; i++) x.push(i + 1);

  const slope = slope_(y, x);
  const intercept = intercept_(y, x, slope);

  const ma12 = movingAverage_(y, 12);
  const ratios = y.map((v, i) => (ma12[i] > 0 ? v / ma12[i] : 1));

  const seasonal = new Array(12).fill(1);
  for (let m = 0; m < 12; m++) {
    const arr = [];
    for (let i = 0; i < n; i++) {
      if ((i % 12) === m && isFinite(ratios[i]) && ratios[i] > 0) arr.push(ratios[i]);
    }
    seasonal[m] = arr.length ? avg_(arr) : 1;
  }
  for (let m = 0; m < 12; m++) seasonal[m] = Math.max(0.80, Math.min(1.20, seasonal[m]));

  const fitted = y.map((_, i) => Math.max(0, (intercept + slope * (i + 1)) * seasonal[i % 12]));
  return { slope, intercept, seasonalIndex: seasonal, fitted };
}


function forecastSeasonalWeighted48_(opt) {
  const src = (opt && Array.isArray(opt.adjustedBaseSeries48)) ? opt.adjustedBaseSeries48 : new Array(48).fill(0);
  const seriesStart = (opt && opt.seriesStart) ? opt.seriesStart : new Date(new Date().getFullYear() - 4, 3, 1);
  const lastClosedMonthStart = (opt && opt.lastClosedMonthStart) ? opt.lastClosedMonthStart : getLastClosedMonthStart_();
  const spotBg = (opt && Array.isArray(opt.spotBackgroundExpectedByMonth)) ? opt.spotBackgroundExpectedByMonth : new Array(12).fill(0);
  const knownSpot = (opt && Array.isArray(opt.knownSpotExpectedByMonth)) ? opt.knownSpotExpectedByMonth : new Array(12).fill(0);
  const tuning = (opt && opt.tuning) ? opt.tuning : {};
  const yearWeights = [
    isFinite(tuning.seasonalYearWeightY1) ? tuning.seasonalYearWeightY1 : SEASONAL_YEAR_WEIGHT_Y1,
    isFinite(tuning.seasonalYearWeightY2) ? tuning.seasonalYearWeightY2 : SEASONAL_YEAR_WEIGHT_Y2,
    isFinite(tuning.seasonalYearWeightY3) ? tuning.seasonalYearWeightY3 : SEASONAL_YEAR_WEIGHT_Y3,
    isFinite(tuning.seasonalYearWeightY4) ? tuning.seasonalYearWeightY4 : SEASONAL_YEAR_WEIGHT_Y4
  ];
  const openMult = isFinite(tuning.seasonalOpenMonthWeightMult) ? tuning.seasonalOpenMonthWeightMult : SEASONAL_OPEN_MONTH_WEIGHT_MULT;
  const madK = isFinite(tuning.seasonalWeightedMadK) ? tuning.seasonalWeightedMadK : SEASONAL_WEIGHTED_MAD_K;
  const compareWarnThreshold = isFinite(tuning.seasonalCompareWarnThreshold) ? tuning.seasonalCompareWarnThreshold : SEASONAL_COMPARE_WARN_THRESHOLD;

  const baseByMonth = new Array(12).fill(0);
  const monthTrendFactor = computeMonthTrendFactors_(src, src.map((_, i) => i));
  for (let m = 0; m < 12; m++) {
    const vals = [];
    for (let y = 0; y < 4; y++) {
      const idx = y * 12 + m;
      const monthStart = addMonths_(seriesStart, idx);
      const raw = Number(src[idx] || 0);
      if (!isFinite(raw)) continue;
      let w = Number(yearWeights[y] || 0);
      if (monthStart > lastClosedMonthStart) w *= openMult;
      vals.push({ v: raw, w });
    }
    if (!vals.length) continue;
    const med = percentile_(vals.map(x => x.v), 0.50);
    const mad = Math.max(1e-6, percentile_(vals.map(x => Math.abs(x.v - med)), 0.50));
    const lo = med - madK * mad;
    const hi = med + madK * mad;
    let num = 0;
    let den = 0;
    vals.forEach(x => {
      const clipped = Math.max(lo, Math.min(hi, x.v));
      num += clipped * x.w;
      den += x.w;
    });
    const monthBase = den > 0 ? num / den : 0;
    const trendF = Math.max(TREND_FACTOR_MIN, Math.min(TREND_FACTOR_MAX, Number(monthTrendFactor[m] || 1)));
    baseByMonth[m] = Math.max(0, monthBase * trendF);
  }

  const totalByMonth = baseByMonth.map((v, i) => Math.max(0, Number(v || 0) + Number(spotBg[i] || 0) + Number(knownSpot[i] || 0)));
  const annualBase = sumArr_(baseByMonth);
  const annualExpectedSpot = sumArr_(spotBg) + sumArr_(knownSpot);
  const annualTotal = sumArr_(totalByMonth);
  const diagnostics = {
    compareWarnThreshold,
    warningText: ''
  };
  return {
    baseByMonth,
    spotBackgroundExpectedByMonth: spotBg.slice(),
    knownSpotExpectedByMonth: knownSpot.slice(),
    totalByMonth,
    annualBase,
    annualExpectedSpot,
    annualTotal,
    diagnostics
  };
}

function buildHistoricalTrendInsight_(series48, model) {
  const src = Array.isArray(series48) ? series48 : [];
  if (src.length < 24) return '・履歴データが不足しているため、トレンド解釈は参考値です。';

  const recent12 = src.slice(src.length - 12);
  const prev12 = src.slice(src.length - 24, src.length - 12);
  const r = sumArr_(recent12);
  const p = sumArr_(prev12);
  const yoy = p > 0 ? ((r / p) - 1) : 0;

  const topMonths = recent12
    .map((v, i) => ({ m: i, v: Number(v || 0) }))
    .sort((a,b)=>b.v-a.v)
    .slice(0,2)
    .map(x => `${(x.m+1)}月`)
    .join('・');

  const trendWord = (model && model.slope > 0) ? '上向き' : ((model && model.slope < 0) ? '下向き' : '横ばい');
  return `・直近12ヶ月は前年同期間比 ${(yoy*100).toFixed(1)}%
・線形トレンドは${trendWord}
・季節的に売上が大きい月: ${topMonths}
・急変月は要因（案件・失注）の確認を推奨`;
}

function buildAIInsight_(reportText) {
  return String(reportText || '');
}


function forecastByResidualQuantiles_(model, devFixedByMonth, q) {
  const p10 = [], p50 = [], p90 = [];
  const startT = 48;
  for (let i = 0; i < 12; i++) {
    const t = startT + (i + 1);
    const monthIdx = i % 12;
    const base = Math.max(0, (model.intercept + model.slope * t) * model.seasonalIndex[monthIdx]);
    p10.push(base * (1 + q.p10) + devFixedByMonth[i]);
    p50.push(base * (1 + q.p50) + devFixedByMonth[i]);
    p90.push(base * (1 + q.p90) + devFixedByMonth[i]);
  }
  return { p10, p50, p90 };
}

function forecastMonteCarloMixed_(model, opt) {
  const nSim = opt.nSim || 1000;
  const residualPct = opt.residualPct || [0];
  const factorsProduct = opt.factorsProduct || [];
  const factorsClient = opt.factorsClient || [];
  const opinions = opt.opinions || [];
  const productWeights = opt.productWeights || new Map();
  const months = opt.months || [];
  const sourceByMonth = opt.sourceByMonth || new Array(12).fill('forecast_open');
  const spotBgModel = opt.spotBgModel || { expectedByMonth: new Array(12).fill(0), occurrenceProbByMonth: new Array(12).fill(0), severitySamplesByMonth: Array.from({ length: 12 }, () => [0]) };
  const knownSpotProjectsByMonth = opt.knownSpotProjectsByMonth || Array.from({ length: 12 }, () => []);
  const knownSpotBgSuppressRate = isFinite(opt.knownSpotBgSuppressRate) ? opt.knownSpotBgSuppressRate : KNOWN_SPOT_BG_SUPPRESS_RATE;
  const dlmBaseLogByMonth = opt.dlmBaseLogByMonth || null;
  const tuning = opt.tuning || {};
  const lmdiEnabled = !!opt.lmdiEnabled;
  const mk12 = () => Array.from({ length: 12 }, () => []);

  const reliabilityMap = opt.reliabilityApply ? (opt.reliabilityMap || new Map()) : new Map();
  const kProdByMonth = months.map(m => productFactorsMultiplier_(factorsProduct, m, productWeights, reliabilityMap));
  const kClientByMonth = months.map(m => clientFactorsMultiplier_(factorsClient, m, reliabilityMap));

  const aiScores = opt.aiScores || { Market: 0, Competitor: 0, Channel: 0, DX: 0 };
  let aiTotalScore = 0;
  AI_TOPICS.forEach(topic => {
    aiTotalScore += Number(aiScores[topic] || 0) * getSourceReliability_(reliabilityMap, 'ai_topic', topic);
  });
  const aiWeight = isFinite(opt.aiWeight) ? opt.aiWeight : AI_WEIGHT_DEFAULT;
  const aiMaxAbsEffect = isFinite(opt.aiMaxAbsEffect) ? opt.aiMaxAbsEffect : AI_MAX_ABS_EFFECT;
  const aiTotalNeutralThreshold = isFinite(tuning.aiTotalNeutralThreshold) ? tuning.aiTotalNeutralThreshold : AI_TOTAL_NEUTRAL_THRESHOLD;
  const aiRawEffect = aiTotalScore * aiWeight;
  const aiClampedEffect = Math.max(-aiMaxAbsEffect, Math.min(aiMaxAbsEffect, aiRawEffect));
  const aiNeutralizedTotal = Math.abs(aiTotalScore) < aiTotalNeutralThreshold;
  if (aiScores && aiScores.meta) aiScores.meta.neutralizedTotal = aiNeutralizedTotal;
  const kAI = aiNeutralizedTotal ? 1.0 : (1 + aiClampedEffect);

  const startT = 48;
  const totalRawSimByMonth = Array.from({ length: 12 }, () => []);
  const totalCalibratedSimByMonth = Array.from({ length: 12 }, () => []);
  const quantOpsSimByMonth = Array.from({ length: 12 }, () => []);
  const subjectiveContinuousDeltaSimByMonth = Array.from({ length: 12 }, () => []);
  const scaledSubjectiveContinuousDeltaSimByMonth = Array.from({ length: 12 }, () => []);
  const subjectiveExclAIDeltaSimByMonth = Array.from({ length: 12 }, () => []);
  const aiDeltaSimByMonth = Array.from({ length: 12 }, () => []);
  const scaledSubjectiveExclAIDeltaSimByMonth = Array.from({ length: 12 }, () => []);
  const scaledAIDeltaSimByMonth = Array.from({ length: 12 }, () => []);
  const knownSpotSimByMonth = Array.from({ length: 12 }, () => []);
  const bgSpotSimByMonth = Array.from({ length: 12 }, () => []);
  const opinionKByMonth = Array.from({ length: 12 }, () => []);
  const lmdiContribSimByMonth = lmdiEnabled ? { kProd: mk12(), kClient: mk12(), kOpinion: mk12(), kAI: mk12() } : null;
  const lmdiRelContribSimByMonth = lmdiEnabled ? { kProd: mk12(), kClient: mk12(), kOpinion: mk12(), kAI: mk12() } : null;
  const lmdiCapAdjSimByMonth = lmdiEnabled ? mk12() : null;
  let lmdiFallbackCount = 0;

  const opsBaseByMonth = Array.from({ length: 12 }, (_, i) => {
    const lp = dlmBaseLogByMonth ? dlmBaseLogByMonth[i] : null;
    if (lp && isFinite(lp.muLog)) return Math.max(0, Math.exp(lp.muLog));
    const t = startT + (i + 1);
    const mIdx = i % 12;
    return Math.max(0, (model.intercept + model.slope * t) * model.seasonalIndex[mIdx]);
  });

  for (let s = 0; s < nSim; s++) {
    for (let i = 0; i < 12; i++) {
      const t = startT + (i + 1);
      const mIdx = i % 12;

      const lp = dlmBaseLogByMonth ? dlmBaseLogByMonth[i] : null;
      let quantOpsAfterResidual;
      if (lp && isFinite(lp.muLog) && isFinite(lp.sd)) {
        // NOTE(step-3b): primary時のBASEソース。3cでもBASE生成はDLM維持、上乗せの重み化のみ変更予定。
        quantOpsAfterResidual = Math.max(0, Math.exp(lp.muLog + lp.sd * dlmGaussianRandom_()));
      } else {
        const base = Math.max(0, (model.intercept + model.slope * t) * model.seasonalIndex[mIdx]);
        const e = residualPct[Math.floor(Math.random() * residualPct.length)] || 0;
        quantOpsAfterResidual = Math.max(0, base * (1 + e));
      }
      let ops = quantOpsAfterResidual;
      ops *= kProdByMonth[i];
      ops *= kClientByMonth[i];
      const kOpinion = sampleOpinionMultiplier_(opinions, months[i], reliabilityMap);
      ops *= kOpinion;
      ops *= kAI;
      const subjectiveContinuousDelta = quantOpsAfterResidual * ((kProdByMonth[i] * kClientByMonth[i] * kOpinion * kAI) - 1);
      // 3軸分離（表示用・厳密加法）: 主観(AI除く) と AI を分けて記録。両者の和は subjectiveContinuousDelta に一致する。
      const subjectiveExclAIMul = kProdByMonth[i] * kClientByMonth[i] * kOpinion;
      const subjectiveExclAIDelta = quantOpsAfterResidual * (subjectiveExclAIMul - 1);
      const aiDelta = quantOpsAfterResidual * subjectiveExclAIMul * (kAI - 1);
      opinionKByMonth[i].push(kOpinion);

      const knownSpot = simulateKnownSpotByMonth_(knownSpotProjectsByMonth[i]);
      const bgSuppress = knownSpot > 0 ? knownSpotBgSuppressRate : 1;
      const bgSpot = sampleSpotBackgroundAmount_(spotBgModel, i, bgSuppress);
      const quantOpsSim = quantOpsAfterResidual;
      const totalRaw = Math.max(0, ops) + knownSpot + bgSpot;

      quantOpsSimByMonth[i].push(quantOpsSim);
      subjectiveContinuousDeltaSimByMonth[i].push(subjectiveContinuousDelta);
      subjectiveExclAIDeltaSimByMonth[i].push(subjectiveExclAIDelta);
      aiDeltaSimByMonth[i].push(aiDelta);
      knownSpotSimByMonth[i].push(knownSpot);
      bgSpotSimByMonth[i].push(bgSpot);
      totalRawSimByMonth[i].push(totalRaw);
      if (lmdiEnabled) {
        const dec = lmdiDecompose_({
          kProd: kProdByMonth[i],
          kClient: kClientByMonth[i],
          kOpinion,
          kAI
        });
        if (dec.fallback) lmdiFallbackCount++;
        ['kProd', 'kClient', 'kOpinion', 'kAI'].forEach(name => {
          const c = Number(dec.contrib[name] || 0);
          lmdiRelContribSimByMonth[name][i].push(c);
          lmdiContribSimByMonth[name][i].push(quantOpsAfterResidual * c);
        });
      }
    }
  }

  // DONE(step-3c-3a): 死にコード整理 + version/build-stage同期（挙動不変）。
  // DONE(step-3c-3b): 主観寄与のLMDI厳密加法分解 + 絶対/相対レンジ（CONFIGトグル / 既定OFF）。
  // DONE(step-3c-3c): POOL_PRIORのクライアント横断自動更新（adminAggregatePoolPriorAcrossBooks で実装済み / 中央集約book→各bookへfan-out）。
  const calibrated = calibrateSubjectiveContinuousDelta_({
    quantOpsSimByMonth,
    subjectiveContinuousDeltaSimByMonth,
    knownSpotSimByMonth,
    bgSpotSimByMonth,
    sourceByMonth,
    tuning
  });

  const capHit = calibrated.capHit;
  for (let i = 0; i < 12; i++) {
    scaledSubjectiveContinuousDeltaSimByMonth[i] = calibrated.scaledSubjectiveSimByMonth[i].slice();
    totalCalibratedSimByMonth[i] = calibrated.mixedSimByMonth[i].slice();
  }
  // cap適用後の主観(AI除く)/AIデルタ: 合算デルタに掛かったクリップ係数 f を両者へ同率適用し、
  // 和が cap後の合算デルタに一致するようにする（表示専用・予測には影響しない）。
  for (let i = 0; i < 12; i++) {
    const rawArr = subjectiveContinuousDeltaSimByMonth[i] || [];
    const scaledArr = scaledSubjectiveContinuousDeltaSimByMonth[i] || [];
    const subjArr = subjectiveExclAIDeltaSimByMonth[i] || [];
    const aiArr = aiDeltaSimByMonth[i] || [];
    const n = scaledArr.length;
    for (let s = 0; s < n; s++) {
      const raw = Number(rawArr[s] || 0);
      const scaled = Number(scaledArr[s] || 0);
      const f = (Math.abs(raw) > 1e-9) ? (scaled / raw) : 1;
      scaledSubjectiveExclAIDeltaSimByMonth[i].push(Number(subjArr[s] || 0) * f);
      scaledAIDeltaSimByMonth[i].push(Number(aiArr[s] || 0) * f);
    }
  }
  if (lmdiEnabled) {
    for (let i = 0; i < 12; i++) {
      const sRaw = subjectiveContinuousDeltaSimByMonth[i] || [];
      const sScaled = scaledSubjectiveContinuousDeltaSimByMonth[i] || [];
      const n = sScaled.length;
      for (let s = 0; s < n; s++) {
        lmdiCapAdjSimByMonth[i].push(Number(sScaled[s] || 0) - Number(sRaw[s] || 0));
      }
    }
  }

  const rawQ = quantilesFromSimByMonth_(totalRawSimByMonth);
  const calibratedQ = quantilesFromSimByMonth_(totalCalibratedSimByMonth);
  const subjectiveQ = quantilesFromSimByMonth_(subjectiveContinuousDeltaSimByMonth);
  const knownQ = quantilesFromSimByMonth_(knownSpotSimByMonth);
  const bgQ = quantilesFromSimByMonth_(bgSpotSimByMonth);
  const scaledSubjectiveQ = quantilesFromSimByMonth_(scaledSubjectiveContinuousDeltaSimByMonth);
  const scaledSubjectiveExclAIQ = quantilesFromSimByMonth_(scaledSubjectiveExclAIDeltaSimByMonth);
  const scaledAIQ = quantilesFromSimByMonth_(scaledAIDeltaSimByMonth);

  const kOpinionP50ByMonth = opinionKByMonth.map(arr => percentile_(arr, 0.50));
  const kAIByMonth = new Array(12).fill(kAI);
  const quantP50ForKpi = quantOpsSimByMonth.map((arr, i) => percentile_(arr.map((v, s) => Number(v || 0) + Number((bgSpotSimByMonth[i] || [])[s] || 0)), 0.50));
  const qualDiag = buildQualShareDiagnostics_({
    quantP50ByMonth: quantP50ForKpi,
    rawMixedP50ByMonth: rawQ.p50,
    calibratedMixedP50ByMonth: calibratedQ.p50,
    sourceByMonth,
    chosenScale: calibrated.scale,
    achievedQualShare: calibrated.achievedQualShare,
    bandHit: calibrated.bandHit,
    missReason: calibrated.missReason,
    capHit
  });
  const collapseStaticRange = q => ({ p10: (q.p50 || []).slice(), p50: (q.p50 || []).slice(), p90: (q.p50 || []).slice() });
  const relKProdRange = lmdiEnabled ? quantilesTriple_(lmdiRelContribSimByMonth.kProd) : null;
  const relKClientRange = lmdiEnabled ? quantilesTriple_(lmdiRelContribSimByMonth.kClient) : null;
  const relKOpinionRange = lmdiEnabled ? quantilesTriple_(lmdiRelContribSimByMonth.kOpinion) : null;
  const relKAIRange = lmdiEnabled ? quantilesTriple_(lmdiRelContribSimByMonth.kAI) : null;
  const lmdiDiagnostics = lmdiEnabled ? {
    meanContribByMonth: {
      kProd: lmdiContribSimByMonth.kProd.map(meanArr_),
      kClient: lmdiContribSimByMonth.kClient.map(meanArr_),
      kOpinion: lmdiContribSimByMonth.kOpinion.map(meanArr_),
      kAI: lmdiContribSimByMonth.kAI.map(meanArr_)
    },
    meanCapAdjByMonth: lmdiCapAdjSimByMonth.map(meanArr_),
    absRangeByMonth: {
      kProd: quantilesTriple_(lmdiContribSimByMonth.kProd),
      kClient: quantilesTriple_(lmdiContribSimByMonth.kClient),
      kOpinion: quantilesTriple_(lmdiContribSimByMonth.kOpinion),
      kAI: quantilesTriple_(lmdiContribSimByMonth.kAI),
      capAdj: quantilesTriple_(lmdiCapAdjSimByMonth)
    },
    relRangeByMonth: {
      kProd: collapseStaticRange(relKProdRange),
      kClient: collapseStaticRange(relKClientRange),
      kOpinion: relKOpinionRange,
      kAI: collapseStaticRange(relKAIRange)
    },
    fallbackCount: lmdiFallbackCount,
    nSim
  } : null;

  return {
    p10: calibratedQ.p10,
    p50: calibratedQ.p50,
    p90: calibratedQ.p90,
    raw: rawQ,
    calibrated: calibratedQ,
    diagnostics: {
      opsBaseByMonth,
      kProdByMonth,
      kClientByMonth,
      kOpinionP50ByMonth,
      kAIByMonth,
      quantOpsSimByMonth,
      subjectiveContinuousDeltaSimByMonth,
      knownSpotSimByMonth,
      bgSpotSimByMonth,
      totalRawSimByMonth,
      totalCalibratedSimByMonth,
      opinionKByMonth: lmdiEnabled ? opinionKByMonth : null,
      subjectiveContinuousP10ByMonth: subjectiveQ.p10,
      subjectiveContinuousP50ByMonth: subjectiveQ.p50,
      subjectiveContinuousP90ByMonth: subjectiveQ.p90,
      knownSpotP10ByMonth: knownQ.p10,
      knownSpotP50ByMonth: knownQ.p50,
      knownSpotP90ByMonth: knownQ.p90,
      bgSpotP10ByMonth: bgQ.p10,
      bgSpotP50ByMonth: bgQ.p50,
      bgSpotP90ByMonth: bgQ.p90,
      totalRawP10ByMonth: rawQ.p10,
      totalRawP50ByMonth: rawQ.p50,
      totalRawP90ByMonth: rawQ.p90,
      scaledSubjectiveP50ByMonth: scaledSubjectiveQ.p50,
      scaledSubjectiveExclAIP50ByMonth: scaledSubjectiveExclAIQ.p50,
      scaledAIP50ByMonth: scaledAIQ.p50,
      qualCalibration: {
        rawSubjectiveShare: qualDiag.rawSubjectiveShare,
        rawTotalQualShare: qualDiag.rawTotalQualShare,
        calibratedSubjectiveShare: qualDiag.calibratedSubjectiveShare,
        calibratedTotalQualShare: qualDiag.calibratedTotalQualShare,
        qualScale: calibrated.scale,
        qualCapHit: capHit,
        targetReached: calibrated.bandHit,
        achievedQualShare: calibrated.achievedQualShare,
        bandHit: calibrated.bandHit,
        missReason: calibrated.missReason,
        warningText: qualDiag.warningText
      },
      aiTotalScore,
      AI_WEIGHT: aiWeight,
      aiRawEffect,
      aiClampedEffect,
      aiMaxAbsEffect,
      aiNeutralized: aiNeutralizedTotal,
      lmdi: lmdiDiagnostics
    }
  };
}

function quantilesFromSimByMonth_(simByMonth) {
  return {
    p10: simByMonth.map(arr => percentile_(arr, 0.10)),
    p50: simByMonth.map(arr => percentile_(arr, 0.50)),
    p90: simByMonth.map(arr => percentile_(arr, 0.90))
  };
}

function meanArr_(arr) {
  return (arr && arr.length) ? arr.reduce((a, b) => a + (Number(b) || 0), 0) / arr.length : 0;
}

function quantilesTriple_(simByMonth) {
  return {
    p10: (simByMonth || []).map(a => percentile_(a, 0.10)),
    p50: (simByMonth || []).map(a => percentile_(a, 0.50)),
    p90: (simByMonth || []).map(a => percentile_(a, 0.90))
  };
}

/**
 * 主観乗算因子 Πk-1 を LMDI-I で因子別に厳密加法分解する。
 * @param {{kProd:number,kClient:number,kOpinion:number,kAI:number}} kj
 * @return {{contrib:{kProd:number,kClient:number,kOpinion:number,kAI:number}, fallback:boolean}}
 *   contrib の総和は (Πk - 1) に厳密一致（フォールバック時も和は保存する）。
 */
function lmdiDecompose_(kj) {
  const names = ['kProd', 'kClient', 'kOpinion', 'kAI'];
  const ks = names.map(n => Number(kj[n]));
  const prod = ks.reduce((a, v) => a * v, 1);
  const target = prod - 1;
  const zero = { kProd: 0, kClient: 0, kOpinion: 0, kAI: 0 };

  if (Math.abs(target) < 1e-12) return { contrib: zero, fallback: false };

  const anyNonPos = (prod <= 0) || ks.some(v => !(v > 0));
  if (anyNonPos) {
    const lin = {};
    const denom = ks.reduce((a, v) => a + (v - 1), 0);
    if (Math.abs(denom) < 1e-12) {
      names.forEach(n => { lin[n] = target / names.length; });
    } else {
      names.forEach((n, idx) => { lin[n] = (ks[idx] - 1) / denom * target; });
    }
    return { contrib: lin, fallback: true };
  }

  const lmean = (prod - 1) / Math.log(prod);
  const contrib = {};
  names.forEach((n, idx) => { contrib[n] = lmean * Math.log(ks[idx]); });
  return { contrib, fallback: false };
}

// DONE(step-3c-3a): 死にコード整理 + version/build-stage同期（挙動不変）。
// DONE(step-3c-3b): 主観寄与のLMDI厳密加法分解 + 絶対/相対レンジ（CONFIGトグル / 既定OFF）。
// DONE(step-3c-3c): POOL_PRIORのクライアント横断自動更新（adminAggregatePoolPriorAcrossBooks で実装済み / 中央集約book→各bookへfan-out）。
function calibrateSubjectiveContinuousDelta_(opt) {
  const tuning = opt && opt.tuning ? opt.tuning : {};
  const targetCenter = SUBJECTIVE_OVERLAY_TARGET_CENTER;
  const targetLow = SUBJECTIVE_OVERLAY_TARGET_LOW;
  const targetHigh = SUBJECTIVE_OVERLAY_TARGET_HIGH;
  const monthlyCap = isFinite(tuning.qualSubjectiveMonthlyCap) ? tuning.qualSubjectiveMonthlyCap : QUAL_SUBJECTIVE_MONTHLY_CAP;
  const enabled = isFinite(tuning.qualCalibrationEnabled) ? Number(tuning.qualCalibrationEnabled) > 0 : !!QUAL_CALIBRATION_ENABLED;
  const sourceByMonth = opt.sourceByMonth || new Array(12).fill('forecast_open');

  const applied = applySubjectiveCap_({
    monthlyCap,
    capEnabled: enabled,
    quantOpsSimByMonth: opt.quantOpsSimByMonth,
    subjectiveContinuousDeltaSimByMonth: opt.subjectiveContinuousDeltaSimByMonth,
    knownSpotSimByMonth: opt.knownSpotSimByMonth,
    bgSpotSimByMonth: opt.bgSpotSimByMonth,
    sourceByMonth
  });
  return {
    scale: 1,
    monthlyCap,
    targetCenter,
    targetLow,
    targetHigh,
    achievedQualShare: applied.overlayShare,
    bandHit: null,
    missReason: 'band-targeting removed in 3c-1 (cap pass-through)',
    capHit: !!applied.capHit,
    mixedSimByMonth: applied.mixedSimByMonth,
    scaledSubjectiveSimByMonth: applied.scaledSubjectiveSimByMonth
  };
}

/**
 * 主観連続差分を探索スケールなしでそのまま反映し、必要に応じて月次capだけを適用する。
 * capEnabled=false の場合は主観差分を無制限に通す（CONFIGのQUAL_CALIBRATION_ENABLED=0）。
 */
function applySubjectiveCap_(opt) {
  const nMonth = 12;
  const mixedSimByMonth = Array.from({ length: nMonth }, () => []);
  const scaledSubjectiveSimByMonth = Array.from({ length: nMonth }, () => []);
  const monthlyCap = Math.max(0, Number(opt.monthlyCap || 0));
  const capEnabled = !!opt.capEnabled;
  let capHit = false;

  for (let i = 0; i < nMonth; i++) {
    const qArr = (opt.quantOpsSimByMonth || [])[i] || [];
    const subjArr = (opt.subjectiveContinuousDeltaSimByMonth || [])[i] || [];
    const kArr = (opt.knownSpotSimByMonth || [])[i] || [];
    const bgArr = (opt.bgSpotSimByMonth || [])[i] || [];
    const n = qArr.length;
    for (let s = 0; s < n; s++) {
      const rawSubj = Number(subjArr[s] || 0);
      const quantOpsBase = Math.max(0, Number(qArr[s] || 0));
      const limit = quantOpsBase * monthlyCap;
      const scaled = capEnabled ? clamp_(rawSubj, -limit, limit) : rawSubj;
      if (capEnabled && Math.abs(scaled - rawSubj) > 1e-6) capHit = true;
      scaledSubjectiveSimByMonth[i].push(scaled);
      mixedSimByMonth[i].push(Math.max(0, Number(qArr[s] || 0) + Number(bgArr[s] || 0) + Number(kArr[s] || 0) + scaled));
    }
  }

  const quantP50ByMonth = Array.from({ length: nMonth }, (_, i) => {
    const qArr = (opt.quantOpsSimByMonth || [])[i] || [];
    const bgArr = (opt.bgSpotSimByMonth || [])[i] || [];
    const qTotalArr = qArr.map((q, s) => Number(q || 0) + Number(bgArr[s] || 0));
    return percentile_(qTotalArr, 0.50);
  });
  const scaledSubjectiveP50ByMonth = scaledSubjectiveSimByMonth.map(arr => percentile_(arr, 0.50));
  const overlayKpi = computeSubjectiveOverlayKpi_(quantP50ByMonth, scaledSubjectiveP50ByMonth, opt.sourceByMonth || []);
  return { ...overlayKpi, capHit, mixedSimByMonth, scaledSubjectiveSimByMonth };
}

function buildQualShareDiagnostics_(opt) {
  const rawKpi = computeDisplayedQualKpi_(opt.quantP50ByMonth || [], opt.rawMixedP50ByMonth || [], opt.sourceByMonth || []);
  const calKpi = computeDisplayedQualKpi_(opt.quantP50ByMonth || [], opt.calibratedMixedP50ByMonth || [], opt.sourceByMonth || []);
  const rawSubjectiveShare = rawKpi.hasOpenMonths ? rawKpi.qualShare : 0;
  const rawTotalQualShare = rawKpi.hasOpenMonths ? rawKpi.qualShare : 0;
  const calibratedSubjectiveShare = calKpi.hasOpenMonths ? calKpi.qualShare : 0;
  const calibratedTotalQualShare = calKpi.hasOpenMonths ? calKpi.qualShare : 0;
  let warningText = '';
  if (!calKpi.hasOpenMonths) warningText = 'N/A（forecast_open月がありません）';
  if (opt.capHit) warningText = `${warningText} monthly cap hit`;
  if (opt.missReason) warningText = `${warningText} ${opt.missReason}`;
  return {
    rawSubjectiveShare,
    rawTotalQualShare,
    calibratedSubjectiveShare,
    calibratedTotalQualShare,
    targetReached: null,
    chosenScale: opt.chosenScale,
    achievedQualShare: opt.achievedQualShare,
    bandHit: opt.bandHit,
    missReason: opt.missReason,
    warningText: warningText.trim()
  };
}

function computeDisplayedQualKpi_(quantP50ByMonth, mixedP50ByMonth, sourceByMonth) {
  const openIdx = [];
  for (let i = 0; i < sourceByMonth.length; i++) {
    if (sourceByMonth[i] === 'forecast_open') openIdx.push(i);
  }
  if (!openIdx.length) {
    return { quantTotal: 0, mixedTotal: 0, qualDeltaSigned: 0, quantShare: 0, qualShare: 0, hasOpenMonths: false };
  }
  let quantTotal = 0;
  let mixedTotal = 0;
  openIdx.forEach(i => {
    quantTotal += Number(quantP50ByMonth[i] || 0);
    mixedTotal += Number(mixedP50ByMonth[i] || 0);
  });
  const qualDeltaSigned = mixedTotal - quantTotal;
  const denom = Math.abs(quantTotal) + Math.abs(qualDeltaSigned);
  const quantShare = denom > 0 ? Math.abs(quantTotal) / denom : 1;
  const qualShare = denom > 0 ? Math.abs(qualDeltaSigned) / denom : 0;
  return { quantTotal, mixedTotal, qualDeltaSigned, quantShare, qualShare, hasOpenMonths: true };
}

function computeSubjectiveOverlayKpi_(quantP50ByMonth, overlayByMonth, sourceByMonth) {
  const openIdx = [];
  for (let i = 0; i < sourceByMonth.length; i++) if (sourceByMonth[i] === 'forecast_open') openIdx.push(i);
  if (!openIdx.length) return { overlayShare: 0, hasOpenMonths: false };
  let quantTotal = 0;
  let overlayTotal = 0;
  openIdx.forEach(i => {
    quantTotal += Number(quantP50ByMonth[i] || 0);
    overlayTotal += Number(overlayByMonth[i] || 0);
  });
  const denom = Math.abs(quantTotal) + Math.abs(overlayTotal);
  return { overlayShare: denom > 0 ? Math.abs(overlayTotal) / denom : 0, hasOpenMonths: true };
}

function computeKnownSpotKpi_(quantP50ByMonth, knownSpotByMonth, sourceByMonth) {
  const openIdx = [];
  for (let i = 0; i < sourceByMonth.length; i++) if (sourceByMonth[i] === 'forecast_open') openIdx.push(i);
  if (!openIdx.length) return { knownSpotShare: 0, hasOpenMonths: false };
  let quantTotal = 0;
  let knownTotal = 0;
  openIdx.forEach(i => {
    quantTotal += Number(quantP50ByMonth[i] || 0);
    knownTotal += Number(knownSpotByMonth[i] || 0);
  });
  const denom = Math.abs(quantTotal) + Math.abs(knownTotal);
  return { knownSpotShare: denom > 0 ? Math.abs(knownTotal) / denom : 0, hasOpenMonths: true };
}

function aggregateAnnualSim_(simByMonth) {
  if (!simByMonth || !simByMonth.length) return [];
  const n = (simByMonth[0] || []).length || 0;
  const out = [];
  for (let s = 0; s < n; s++) {
    let total = 0;
    for (let i = 0; i < simByMonth.length; i++) total += Number(((simByMonth[i] || [])[s]) || 0);
    out.push(total);
  }
  return out;
}

function averageMonthRangeRatio_(p10, p50, p90) {
  const arr = [];
  for (let i = 0; i < 12; i++) {
    const mid = Number((p50 || [])[i] || 0);
    if (mid === 0) continue;
    const rr = (Number((p90 || [])[i] || 0) - Number((p10 || [])[i] || 0)) / Math.abs(mid);
    arr.push(rr);
  }
  return arr.length ? avg_(arr) : 0;
}

function clamp_(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function shortText_(s, maxLen) {
  const txt = String(s || '');
  if (txt.length <= maxLen) return txt;
  return `${txt.slice(0, maxLen)}…`;
}

function resetOutputSheet_(sh) {
  sh.getCharts().forEach(c => sh.removeChart(c));
  const full = sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns());
  full.getMergedRanges().forEach(r => r.breakApart());
  full.clearNote();
  sh.clear({ contentsOnly: true });
  sh.clearFormats();
  const maxRows = sh.getMaxRows();
  if (maxRows > 0) sh.setRowHeights(1, maxRows, 21);
}

// [dev診断] 手動実行用。メニュー非掲載のため未参照に見えるが削除しないこと。

function applySheetVisualStandards_(sh, profile) {
  if (!sh) return;
  const full = sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns());
  full.setVerticalAlignment('middle').setHorizontalAlignment('left').setFontWeight('normal');
  const wrapped = sh.getDataRange();
  wrapped.setWrap(true).setVerticalAlignment('middle');
  sh.getRange(1, 1, 1, sh.getMaxColumns()).setVerticalAlignment('middle').setFontWeight('bold');
  const nums = (profile && profile.numericCols) ? profile.numericCols : [];
  nums.forEach(c => {
    if (c <= sh.getMaxColumns()) sh.getRange(2, c, Math.max(1, sh.getMaxRows() - 1), 1).setHorizontalAlignment('right');
  });
}

// [dev診断] 手動実行用。メニュー非掲載のため未参照に見えるが削除しないこと。

/** 製品要因：製品別step合算 → 構成比で加重 → 1+加重step */
function productFactorsMultiplier_(factorsProduct, targetMonth, productWeights, reliabilityMap) {
  if (!factorsProduct || factorsProduct.length === 0) return 1;

  const stepByProduct = new Map();
  factorsProduct.forEach(f => {
    if (!f.month || f.month > targetMonth) return;
    const p = f.product;
    if (!p) return;
    const prev = stepByProduct.get(p) || 0;
    const r = getSourceReliability_(reliabilityMap, 'factor_product', f.person || '');
    stepByProduct.set(p, prev + (isFinite(f.step) ? f.step * r : 0));
  });
  if (stepByProduct.size === 0) return 1;

  let aggStep = 0;
  stepByProduct.forEach((step, p) => {
    const w = productWeights.has(p) ? productWeights.get(p) : 0;
    aggStep += w * step;
  });

  const mult = 1 + aggStep;
  return Math.max(0, mult);
}

/** クライアント要因：step合算 → 1+step */
function clientFactorsMultiplier_(factorsClient, targetMonth, reliabilityMap) {
  if (!factorsClient || factorsClient.length === 0) return 1;

  let step = 0;
  factorsClient.forEach(f => {
    if (!f.month || f.month > targetMonth) return;
    step += (isFinite(f.step) ? f.step * getSourceReliability_(reliabilityMap, 'factor_client', f.person || '') : 0);
  });

  const mult = 1 + step;
  return Math.max(0, mult);
}

/** 意見係数：担当者別に最新意見を取り、±5%のランダム揺らしを入れて合成 */
function sampleOpinionMultiplier_(opinions, targetMonth, reliabilityMap) {
  if (!opinions || opinions.length === 0) return 1;

  const people = new Map();
  opinions.forEach(o => {
    if (!o.month || o.month > targetMonth) return;
    const key = o.person || '';
    if (!key) return;
    const prev = people.get(key);
    if (!prev || prev.month < o.month) people.set(key, o);
  });
  if (people.size === 0) return 1;

  let k = 1;
  people.forEach(o => {
    const baseStep = (isFinite(o.step) ? o.step : 0) * getSourceReliability_(reliabilityMap, 'opinion', o.person || '');
    const conf = isFinite(o.confidence) ? o.confidence : 0.7;

    const jitter = (Math.floor(Math.random() * 3) - 1) * 0.05; // -0.05,0,+0.05
    const stepRand = baseStep + jitter;

    k *= (1 + stepRand * conf);
  });

  return k;
}

/** ====== 意見要約 ====== */
function summarizeOpinionsTop_(opinions) {
  if (!opinions || opinions.length === 0) return '';

  const latest = new Map();
  opinions.forEach(o => {
    const prev = latest.get(o.person);
    if (!prev || (prev.month && o.month && prev.month < o.month)) latest.set(o.person, o);
  });

  const parts = [];
  latest.forEach(o => {
    const pct = Math.round(o.step * 100);
    const sign = pct > 0 ? '+' : '';
    const conf = isFinite(o.confidence) ? o.confidence.toFixed(2) : '0.70';
    const memo = o.note ? `：${o.note}` : '';
    parts.push(`${o.person} ${sign}${pct}%(${conf})${memo}`);
  });
  return parts.join(' / ');
}

function summarizeOpinionsByMonth_(opinions, months) {
  const out = [];
  for (let i = 0; i < months.length; i++) {
    const m = months[i];
    const applicable = opinions.filter(o => o.month && o.month <= m && o.note && String(o.note).trim());
    const latest = new Map();
    applicable.forEach(o => {
      const prev = latest.get(o.person);
      if (!prev || prev.month < o.month) latest.set(o.person, o);
    });
    const parts = [];
    latest.forEach(o => {
      const pct = Math.round(o.step * 100);
      const sign = pct > 0 ? '+' : '';
      const conf = isFinite(o.confidence) ? o.confidence.toFixed(2) : '0.70';
      parts.push(`${o.person}:${sign}${pct}%(${conf})`);
    });
    out.push(parts.join(' / '));
  }
  return out;
}

/** ====== ユーティリティ ====== */
function ensureSetupDone_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(SHEETS.CONFIG)) {
    throw new Error('初期セットアップが必要です。Forecast Agent > A-1 初期セットアップ を実行してください。');
  }
}

function ensureSheetHasColumns_(sh, minCols) {
  const cur = sh.getMaxColumns();
  if (cur < minCols) sh.insertColumnsAfter(cur, minCols - cur);
}

function ensureSheetHasRows_(sh, minRows) {
  const cur = sh.getMaxRows();
  if (cur < minRows) sh.insertRowsAfter(cur, minRows - cur);
}

function getOrCreateSheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}


function fmtYM_(d) {
  return Utilities.formatDate(d, TZ, 'yyyy/MM');
}

function addMonths_(d, n) {
  const x = new Date(d.getTime());
  x.setMonth(x.getMonth() + n);
  return x;
}

function monthIndexFromStart_(dt, start) {
  return (dt.getFullYear() - start.getFullYear()) * 12 + (dt.getMonth() - start.getMonth());
}

function toDate_(v) {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v.getTime())) return v;

  // Google Sheetsのシリアル日付に対応
  if (typeof v === 'number' && isFinite(v)) {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const dNum = new Date(ms);
    if (!isNaN(dNum.getTime())) return dNum;
  }

  const s = String(v).trim();
  if (!s) return null;

  const norm = s.replace(/\//g,'-');
  const d = new Date(norm);
  if (!isNaN(d.getTime())) return d;
  return null;
}

/**
 * Stepの解釈（計算用）
 * - "-30%" / "-30％" → -0.30
 * - "-30"  → -0.30（%として扱う）
 * - "-0.3" → -0.30（比率として扱う）
 * - 解釈不能な文字列は NaN を返す（検出用）
 */
function parseRate_(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') {
    if (!isFinite(v)) return 0;
    return (Math.abs(v) > 1) ? (v / 100) : v;
  }
  const s0 = String(v).trim();
  if (!s0) return 0;

  const s = s0.replace(/％/g, '%').replace(/[,\s]/g,'').replace(/¥/g,'').replace(/￥/g,'');
  const m = s.match(/^([+-]?\d+(?:\.\d+)?)\s*%$/);
  if (m) return Number(m[1]) / 100;

  const num = Number(s);
  if (isFinite(num)) {
    return (Math.abs(num) > 1) ? (num / 100) : num;
  }
  return NaN;
}

/** 表示の正規化（onEdit用）：常に "+10%" / "-30%" / "0%" にする */
function normalizeStepDisplay_(v) {
  if (v === null || v === undefined) return null;

  if (typeof v === 'string' && v.trim() === '') return '';

  let numPct = null;

  if (typeof v === 'number') {
    if (!isFinite(v)) return null;
    numPct = (Math.abs(v) > 2) ? v : v * 100;
  } else {
    const s0 = String(v).trim();
    if (!s0) return '';
    const s = s0.replace(/％/g, '%').replace(/[,\s]/g,'').replace(/¥/g,'').replace(/￥/g,'');
    const m = s.match(/^([+-]?\d+(?:\.\d+)?)\s*%$/);
    if (m) {
      numPct = Number(m[1]);
    } else {
      const x = Number(s);
      if (isFinite(x)) {
        numPct = (Math.abs(x) > 2) ? x : x * 100;
      } else {
        return s0;
      }
    }
  }

  if (!isFinite(numPct)) return null;

  const rounded = Math.round(numPct * 2) / 2;

  if (rounded === 0) return '0%';
  const sign = rounded > 0 ? '+' : '';
  const txt = (Math.abs(rounded - Math.round(rounded)) < 1e-9) ? String(Math.round(rounded)) : String(rounded);
  return `${sign}${txt}%`;
}

function buildPercentStepList_() {
  const arr = [];
  for (let p = 100; p >= -100; p -= 5) {
    const sign = p > 0 ? '+' : '';
    arr.push(`${sign}${p}%`);
  }
  return arr;
}

function avg_(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((a,b)=>a+b,0) / arr.length;
}

function sumArr_(arr) {
  return (arr || []).reduce((a,b)=>a + (Number(b) || 0), 0);
}

function percentile_(arr, q) {
  if (!arr || !arr.length) return 0;
  const a = arr.slice().sort((x,y)=>x-y);
  return percentileSorted_(a, q);
}

function percentileSorted_(a, q) {
  const n = a.length;
  if (n === 0) return 0;
  const pos = (n - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if ((a[base + 1] !== undefined)) {
    return a[base] + rest * (a[base + 1] - a[base]);
  } else {
    return a[base];
  }
}

function movingAverage_(arr, window) {
  const n = arr.length;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = arr.slice(start, i + 1);
    out[i] = avg_(slice);
  }
  return out;
}

// regression helpers
function slope_(y, x) {
  const n = y.length;
  const xbar = avg_(x);
  const ybar = avg_(y);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - xbar) * (y[i] - ybar);
    den += (x[i] - xbar) * (x[i] - xbar);
  }
  return den === 0 ? 0 : num / den;
}

function intercept_(y, x, slope) {
  const xbar = avg_(x);
  const ybar = avg_(y);
  return ybar - slope * xbar;
}

/** ====== toast補助（読み取り時間を確保） ====== */
function toastProgress_(ss, message, seconds) {
  ss.toast(message, MENU_NAME, seconds || 5);
  // 読み取れる程度に少し待つ（スピード最優先ではない方針）
  Utilities.sleep(450);
}


/** ====== v1.1 Phase1実装 ====== */
function buildPhase1Sheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  buildSimpleSheet_(ss, SHEETS.SALES_INPUT, ['client','service_type','product','target_month','input_amount','status','source_updated_at']);
  buildSimpleSheet_(ss, SHEETS.ACTUAL_EVAL_MONTHLY, ['client','service_type','product','target_month','eval_actual_amount','actual_closed_flag','source_updated_at']);
  buildAIResearchSummaryView_(ss);
  buildSimpleSheet_(ss, SHEETS.AI_RESEARCH_STRUCTURED, ['client','as_of_date','topic','row_type','direction','impact_score','confidence','evidence','time_horizon','business_relevance_reason','market_size_ref','peer_universe','peer_basis','relative_position_label','relative_percentile','relative_confidence','benchmark_quality','relative_reason','report_text','event_score','benchmark_score','blended_score']);
  buildSimpleSheet_(ss, SHEETS.RUN_LOG, ['run_id','run_at','run_by','function_name','client','status','count','model_version','parameters_snapshot_json','input_data_hash','execution_duration_sec','error_summary']);
  buildSimpleSheet_(ss, SHEETS.FORECAST_SNAPSHOT, ['snapshot_id','run_date','client','target_month','scenario','base_pred','subjective_adj','ai_adj','deterministic_adj','final_pred','confidence_interval_lower','confidence_interval_upper','key_factors_json','subjective_input_date','calibration_applied_json']);
  buildSimpleSheet_(ss, SHEETS.EVAL_LOG, ['eval_id','evaluated_at','client','target_month','scenario','pred','actual','ape','was_overridden','error_category','forecast_role','is_planning_point_estimate','signed_error','abs_error','bias_direction','range_contains_actual','quarter_label','half_label','fy_label','model_version','evaluation_policy_version','constraint_relevant_flag']);
  buildSimpleSheet_(ss, SHEETS.EVAL_COMPARE_MONTHLY, ['target_month','forecast_base','forecast_spot','forecast_total','actual_base','actual_spot','actual_total','gap_total','forecast_total_p10','forecast_total_p50','forecast_total_p90','signed_error_p50','abs_error_p50','ape_p50','quarter_label','half_label','fy_label','over_flag','under_flag','range_outside_flag','note_for_investigation','planning_point_estimate_label','range_label']);
  buildSimpleSheet_(ss, SHEETS.EVAL_INSIGHTS, ['evaluated_at','client','target_month','actual_total','pred_p50','diff','error_rate','insight','next_action','diagnostic_type','annual_constraint_breach','half_constraint_breach','overforecast_breach','range_breach','cause_hypothesis','cause_bucket','impacted_assumption','feedback_target_sheet','action_type','next_cycle_reflection','owner','due_date','status','review_cycle']);
  buildSimpleSheet_(ss, SHEETS.PROCESS_STATUS, ['step_key','last_run_date','last_run_by','status','target_client','record_count','error_summary']);
  buildSimpleSheet_(ss, SHEETS.AI_SCORE_HISTORY, ['run_id','run_at','client','topic','blended_score','quality_score','degraded_mode','neutralized','coverage_event_rows','coverage_benchmark_rows','latest_as_of_date']);
  buildSimpleSheet_(ss, SHEETS.AI_IMPACT_HISTORY, ['run_id','run_at','client','target_month','k_ai','ai_total_score','ai_direction','pred_p50','pred_p50_quant_only','ai_neutralized','disabled_topics_count','forecast_source']);
  buildSimpleSheet_(ss, SHEETS.SUBJECTIVE_IMPACT_HISTORY, ['run_id','run_at','client','target_month','source_type','source_key','push_step','push_direction','applied_reliability_r','source_updated_at','forecast_source']);
  buildSimpleSheet_(ss, SHEETS.CALIBRATION_STATE, ['client','updated_at','updated_by','ai_weight_override','ai_max_abs_effect_override','ai_topic_disable_json','bias_correction_factor','qual_scale_override','residual_month_bias_json','last_applied_quarter','last_applied_review_id','auto_update_enabled','note']);
  buildSimpleSheet_(ss, SHEETS.CALIBRATION_HISTORY, ['change_id','changed_at','changed_by','client','quarter_label','review_id','factor_name','old_value','new_value','rollback_hint']);
  buildSimpleSheet_(ss, SHEETS.QUARTERLY_REVIEW, ['section','key','value']);
  buildSimpleSheet_(ss, SHEETS.QUARTERLY_REVIEW_LOG, ['review_id','proposal_id','reviewed_at','client','quarter_label','quarter_start_month','quarter_end_month','phase','target_field','current_value','proposed_value','confidence','rationale','impact_estimate','rollback_hint','approval_status','approval_decided_at','approval_decided_by','applied','applied_at','diagnostic_metrics_json']);
  buildSimpleSheet_(ss, SHEETS.DASHBOARD, ['metric','value','note']);
  buildSimpleSheet_(ss, SHEETS.SOURCE_RELIABILITY, ['client','source_type','source_key','reliability_r','sample_count','last_eval_window','updated_at','updated_by','note']);
  buildSimpleSheet_(ss, SHEETS.RELIABILITY_EVIDENCE, ['client','source_type','source_key','quarter_label','quarter_end_month','n','hit','hit_rate','computed_at','run_id','note']);
  buildSimpleSheet_(ss, SHEETS.VERTEX_FORECAST_LOG, ['run_id','run_at','client','fy','target_months_json','monthly_adj_json','confidence','rationale_ja','model','status','duration_sec','usage_json','note']);
  initializeProcessStatus_();
}

function buildSimpleSheet_(ss, name, headers) {
  const sh = getOrCreateSheet_(ss, name);
  sh.clear();
  sh.getRange(1,1,1,headers.length).setValues([headers]).setBackground(COLOR_HEADER).setFontWeight('bold');
  sh.setFrozenRows(1);
  applySheetVisualStandards_(sh, { numericCols: [] });
}

function buildAIResearchSummaryView_(ss) {
  const book = ss || SpreadsheetApp.getActiveSpreadsheet();
  let client = '';
  try {
    const cfg = book.getSheetByName(SHEETS.CONFIG);
    if (cfg) client = normalizeClientName_(String(cfg.getRange('B2').getValue() || '').trim());
  } catch (e) {
    client = '';
  }
  writeAIResearchSummaryView_(book, client, '', [], null);
}

function writeAIResearchSummaryView_(ss, client, asOf, structuredRows, aiScores) {
  const sh = getOrCreateSheet_(ss, SHEETS.AI_RESEARCH);
  const rows = (Array.isArray(structuredRows) ? structuredRows : []).filter(r => Array.isArray(r));
  const viewCols = 13;
  const minRows = Math.max(30, 16 + rows.length + AI_TOPICS.length * 2);
  ensureSheetHasColumns_(sh, viewCols);
  ensureSheetHasRows_(sh, minRows);

  const full = sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns());
  full.getMergedRanges().forEach(r => r.breakApart());
  full.clearNote();
  sh.clear({ contentsOnly: true });
  sh.clearFormats();
  sh.setFrozenRows(0);
  sh.setRowHeights(1, sh.getMaxRows(), 21);
  sh.getRange(1, 1, sh.getMaxRows(), viewCols).setVerticalAlignment('top').setHorizontalAlignment('left');

  const title = `AI調査サマリー（${client || '未設定'} / as_of ${asOf || '-'}）`;
  const titleRange = sh.getRange(1, 1, 1, viewCols);
  titleRange.merge();
  titleRange.setValue(title).setFontWeight('bold').setFontSize(16).setBackground(COLOR_HEADER);

  const memoRange = sh.getRange(2, 1, 1, viewCols);
  memoRange.merge();
  memoRange.setValue('このシートは A-4 実行時に自動更新されます。生データは AI_RESEARCH_STRUCTURED（非表示）にあります。')
    .setBackground('#f3f3f3')
    .setFontColor('#666666');

  setAIResearchSummaryColumnWidths_(sh);

  let row = 4;
  if (!rows.length) {
    const guide = sh.getRange(row, 1, 1, viewCols);
    guide.merge();
    guide.setValue('まだ A-4 を実行していません。A-2 売上データを取り込み後、A-4 AI調査を実行するとここに要約が表示されます。')
      .setBackground('#fff2cc')
      .setFontColor('#666666');
    ss.setActiveSheet(sh);
    return;
  }

  const topicSummary = buildAIResearchTopicSummary_(rows, aiScores);
  writeAIResearchSummarySectionHeader_(sh, row, viewCols, '① topic別サマリー（要約文）');
  row++;
  const hasAnyReport = AI_TOPICS.some(topic => !!topicSummary[topic].report);
  if (!hasAnyReport) {
    const noReport = sh.getRange(row, 1, 1, viewCols);
    noReport.merge();
    noReport.setValue('（今回の調査では要約文が取得できませんでした。スコアと根拠を参照してください）')
      .setBackground('#ffffff')
      .setFontColor('#666666');
    row++;
  } else {
    AI_TOPICS.forEach(topic => {
      sh.getRange(row, 1).setValue(topic).setFontWeight('bold').setBackground('#f3f3f3');
      const reportCell = sh.getRange(row, 2, 1, viewCols - 1);
      reportCell.merge();
      reportCell.setValue(topicSummary[topic].report || '').setWrap(true).setVerticalAlignment('top');
      sh.setRowHeight(row, topicSummary[topic].report ? 90 : 36);
      row++;
    });
  }

  row++;
  writeAIResearchSummarySectionHeader_(sh, row, viewCols, '② AIスコア サマリー（4軸）');
  row++;
  const scoreHeaders = ['Topic', 'Final Score', 'event_score', 'benchmark_score', '最新as_of', '備考'];
  sh.getRange(row, 1, 1, scoreHeaders.length).setValues([scoreHeaders]).setBackground(COLOR_HEADER).setFontWeight('bold');
  row++;
  const scoreStart = row;
  const scoreRows = AI_TOPICS.map(topic => {
    const s = topicSummary[topic];
    return [topic, s.finalScore, s.eventScore === null ? '' : s.eventScore, s.benchmarkScore === null ? '' : s.benchmarkScore, s.latestAsOfDate || '', s.note || ''];
  });
  sh.getRange(scoreStart, 1, scoreRows.length, scoreHeaders.length).setValues(scoreRows);
  sh.getRange(scoreStart, 2, scoreRows.length, 3).setNumberFormat('0.0');
  sh.getRange(scoreStart, 2, scoreRows.length, 1).setBackgrounds(scoreRows.map(r => {
    const v = Number(r[1] || 0);
    return [v > 0 ? COLOR_POS : (v < 0 ? COLOR_NEG : COLOR_NEU)];
  }));
  row += scoreRows.length;

  row++;
  writeAIResearchSummarySectionHeader_(sh, row, viewCols, '③ スコア根拠（event / benchmark 明細）');
  row++;
  const detailHeaders = ['Topic', 'row_type', 'direction', 'impact_score', 'confidence', 'event_score', 'relative_position_label', 'relative_percentile', 'relative_confidence', 'benchmark_quality', 'benchmark_score', 'evidence', 'business_relevance_reason / relative_reason'];
  sh.getRange(row, 1, 1, detailHeaders.length).setValues([detailHeaders]).setBackground(COLOR_HEADER).setFontWeight('bold');
  row++;
  if (!rows.length) {
    sh.getRange(row, 1).setValue('（明細なし）');
  } else {
    const detailRows = rows.map(r => buildAIResearchDetailSummaryRow_(r));
    sh.getRange(row, 1, detailRows.length, detailHeaders.length).setValues(detailRows);
    sh.getRange(row, 4, detailRows.length, 1).setNumberFormat('0.0');
    sh.getRange(row, 5, detailRows.length, 1).setNumberFormat('0.00');
    sh.getRange(row, 6, detailRows.length, 1).setNumberFormat('0.0');
    sh.getRange(row, 8, detailRows.length, 1).setNumberFormat('0');
    sh.getRange(row, 9, detailRows.length, 1).setNumberFormat('0.00');
    sh.getRange(row, 11, detailRows.length, 1).setNumberFormat('0.0');
    sh.getRange(row, 12, detailRows.length, 2).setWrap(true).setVerticalAlignment('top');
  }

  // AI_RESEARCH サマリービュー全体を上下中央寄せに統一する（左右配置は変更しない）。
  const aiViewLastRow = Math.max(1, sh.getLastRow());
  const aiViewLastCol = Math.max(1, sh.getLastColumn());
  sh.getRange(1, 1, aiViewLastRow, aiViewLastCol).setVerticalAlignment('middle');
  ss.setActiveSheet(sh);
}

function writeAIResearchSummarySectionHeader_(sh, row, cols, title) {
  const r = sh.getRange(row, 1, 1, cols);
  r.merge();
  r.setValue(title).setBackground(COLOR_SECTION_SOFT).setFontWeight('bold');
}

function setAIResearchSummaryColumnWidths_(sh) {
  const widths = [120, 110, 90, 105, 95, 105, 160, 130, 130, 130, 120, 360, 380];
  widths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
}

function buildAIResearchTopicSummary_(structuredRows, aiScores) {
  const blend = { Market: [0.65, 0.35], Competitor: [0.70, 0.30], Channel: [0.65, 0.35], DX: [0.50, 0.50] };
  const out = {};
  AI_TOPICS.forEach(topic => {
    out[topic] = { report: '', eventScores: [], benchmarkScores: [], latestAsOfDate: '', latestAsOfTime: 0 };
  });

  structuredRows.forEach(r => {
    const topic = normalizeAiTopic_(r[2]);
    if (!topic || !out[topic]) return;
    const rowType = normalizeAiCellValue_(r[3]).toLowerCase() === 'benchmark' ? 'benchmark' : 'event';
    const report = sanitizeAiReportText_(r[18]);
    if (report) {
      const splitReports = splitAIResearchReportTextByTopic_(report);
      const splitTopics = Object.keys(splitReports);
      if (splitTopics.length) {
        splitTopics.forEach(t => {
          if (out[t] && !out[t].report) out[t].report = splitReports[t];
        });
      } else if (!out[topic].report) {
        out[topic].report = report;
      }
    }
    const asOfDate = toDate_(r[1]);
    if (asOfDate && asOfDate.getTime() >= out[topic].latestAsOfTime) {
      out[topic].latestAsOfTime = asOfDate.getTime();
      out[topic].latestAsOfDate = Utilities.formatDate(asOfDate, TZ, 'yyyy-MM-dd');
    } else if (!out[topic].latestAsOfDate && r[1]) {
      out[topic].latestAsOfDate = String(r[1]);
    }
    const score = aiSummaryNumberOrNull_(rowType === 'benchmark' ? r[20] : r[19]);
    if (score !== null) {
      if (rowType === 'benchmark') out[topic].benchmarkScores.push(clamp_(score, -50, 50));
      else out[topic].eventScores.push(clamp_(score, -50, 50));
    }
  });

  AI_TOPICS.forEach(topic => {
    const s = out[topic];
    const eventScore = aiSummaryAverageOrNull_(s.eventScores);
    const benchmarkScore = aiSummaryAverageOrNull_(s.benchmarkScores);
    const meta = aiScores && aiScores.meta && aiScores.meta[topic] ? aiScores.meta[topic] : {};
    let finalScore = aiScores && isFinite(Number(aiScores[topic])) ? Number(aiScores[topic]) : NaN;
    let degradedMode = meta.degradedMode || '';
    if (!isFinite(finalScore)) {
      if (benchmarkScore !== null && eventScore !== null) finalScore = benchmarkScore * blend[topic][0] + eventScore * blend[topic][1];
      else if (benchmarkScore !== null) finalScore = benchmarkScore;
      else if (eventScore !== null) finalScore = eventScore;
      else finalScore = 0;
      degradedMode = degradedMode || ((benchmarkScore === null && eventScore === null) ? 'no_data' : (benchmarkScore === null ? 'event_only' : (eventScore === null ? 'benchmark_only' : 'blended')));
    }
    s.eventScore = eventScore === null ? null : Math.round(eventScore * 10) / 10;
    s.benchmarkScore = benchmarkScore === null ? null : Math.round(benchmarkScore * 10) / 10;
    s.finalScore = Math.round(Number(finalScore || 0) * 10) / 10;
    s.note = [
      `mode=${degradedMode || 'blended'}`,
      `neutralized=${!!meta.neutralized}`,
      `quality=${isFinite(Number(meta.qualityScore)) ? Number(meta.qualityScore).toFixed(2) : ''}`
    ].join('; ');
    if (meta.latestAsOfDate) s.latestAsOfDate = meta.latestAsOfDate;
  });
  return out;
}

function splitAIResearchReportTextByTopic_(reportText) {
  const text = sanitizeAiReportText_(reportText);
  const out = {};
  if (!text) return out;
  const markers = [];
  AI_TOPICS.forEach(topic => {
    const marker = `【${topic}】`;
    const idx = text.indexOf(marker);
    if (idx >= 0) markers.push({ topic, marker, idx });
  });
  markers.sort((a, b) => a.idx - b.idx);
  markers.forEach((m, i) => {
    const start = m.idx + m.marker.length;
    const end = (i + 1 < markers.length) ? markers[i + 1].idx : text.length;
    const body = text.substring(start, end).trim();
    if (body) out[m.topic] = body;
  });
  return out;
}

function buildAIResearchDetailSummaryRow_(r) {
  const rowType = normalizeAiCellValue_(r[3]).toLowerCase() === 'benchmark' ? 'benchmark' : 'event';
  const isBenchmark = rowType === 'benchmark';
  return [
    normalizeAiTopic_(r[2]) || String(r[2] || ''),
    rowType,
    String(r[4] || ''),
    isBenchmark ? '' : aiSummaryNumberOrBlank_(r[5]),
    isBenchmark ? '' : aiSummaryNumberOrBlank_(r[6]),
    isBenchmark ? '' : aiSummaryNumberOrBlank_(r[19]),
    isBenchmark ? String(r[13] || '') : '',
    isBenchmark ? aiSummaryNumberOrBlank_(r[14]) : '',
    isBenchmark ? aiSummaryNumberOrBlank_(r[15]) : '',
    isBenchmark ? String(r[16] || '') : '',
    isBenchmark ? aiSummaryNumberOrBlank_(r[20]) : '',
    String(r[7] || ''),
    isBenchmark ? String(r[17] || '') : String(r[9] || '')
  ];
}

function aiSummaryAverageOrNull_(arr) {
  const vals = (arr || []).filter(v => isFinite(Number(v))).map(Number);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function aiSummaryNumberOrNull_(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function aiSummaryNumberOrBlank_(v) {
  const n = Number(v);
  return isFinite(n) ? n : '';
}

function ensureSheetHeaders_(sh, headers) {
  if (!sh) return;
  const cur = sh.getRange(1, 1, 1, Math.max(headers.length, sh.getLastColumn() || 1)).getValues()[0];
  const needs = headers.some((h, i) => String(cur[i] || '') !== h);
  if (needs) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setBackground(COLOR_HEADER).setFontWeight('bold');
  }
}

function headerIndexMap_(header) {
  const idx = {};
  (header || []).forEach((h, i) => {
    const key = String(h || '').trim();
    if (key) idx[key] = i;
  });
  return idx;
}

function requireHeaderIndex_(idx, sheetName, key) {
  if (idx[key] === undefined) throw new Error(`${sheetName} に ${key} 列がありません。`);
  return idx[key];
}

function hasHeaderIndexes_(idx, keys) {
  return (keys || []).every(key => idx && idx[key] !== undefined);
}

function applySectionGapRows_(sh, rows) {
  if (!sh || !rows || !rows.length) return;
  rows.forEach(r => {
    if (!isFinite(r) || r < 1) return;
    sh.getRange(r, 1, 1, Math.max(2, sh.getLastColumn() || 2)).clearContent().setBackground('#ffffff');
  });
}

function normalizeAllSheetNotes_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  sheets.forEach(sh => clearOrphanNotesOnSheet_(sh));
}

function clearAllNotesOnSheets_(ss, sheetNames) {
  if (!ss || !sheetNames || !sheetNames.length) return;
  const uniq = Array.from(new Set(sheetNames));
  uniq.forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearNote();
  });
}

function clearOrphanNotesOnSheet_(sh) {
  if (!sh) return;
  const range = sh.getDataRange();
  const values = range.getValues();
  const notes = range.getNotes();
  const normalized = notes.map((row, r) => row.map((note, c) => {
    const hasValue = String(values[r][c] !== null ? values[r][c] : '').trim() !== '';
    if (!note) return '';
    return hasValue ? note : '';
  }));
  range.setNotes(normalized);
}

function validateNotesIntegrity_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const problems = [];
  ss.getSheets().forEach(sh => {
    const range = sh.getDataRange();
    const values = range.getValues();
    const notes = range.getNotes();
    for (let r = 0; r < notes.length; r++) {
      for (let c = 0; c < notes[r].length; c++) {
        const note = String(notes[r][c] || '').trim();
        if (!note) continue;
        const value = values[r][c];
        const hasValue = String(value !== null ? value : '').trim() !== '';
        if (hasValue) continue;
        problems.push(`${sh.getName()}!${toA1Notation_(r + 1, c + 1)}`);
        if (problems.length >= 10) break;
      }
      if (problems.length >= 10) break;
    }
  });
  if (problems.length) {
    throw new Error(`NOTE整合性エラー（空セルにNOTE）: ${problems.join(', ')}`);
  }
}

function toA1Notation_(row, col) {
  let n = col;
  let letters = '';
  while (n > 0) {
    const mod = (n - 1) % 26;
    letters = String.fromCharCode(65 + mod) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return `${letters}${row}`;
}

function applyDefaultAlignmentForAllSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  sheets.forEach(sh => {
    const range = sh.getDataRange();
    if (!range) return;
    range.setVerticalAlignment('middle');
    applyValueTypeAlignment_(sh, 1, range.getNumRows(), range.getNumColumns());
  });
}

function applyValueTypeAlignment_(sh, startRow, numRows, numCols) {
  if (!sh || !isFinite(startRow) || !isFinite(numRows) || !isFinite(numCols) || numRows < 1 || numCols < 1) return;
  const range = sh.getRange(startRow, 1, numRows, numCols);
  const values = range.getValues();
  const aligns = values.map(row => row.map(v => {
    if (typeof v === 'number' || Object.prototype.toString.call(v) === '[object Date]') return 'right';
    return 'left';
  }));
  range.setHorizontalAlignments(aligns);
}

function initializeProcessStatus_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PROCESS_STATUS);
  const keys = ['step1_status','step1a_status','step2_status','step3_status','step3a_status','step4_status','step5_status','step6_status','step7_status','learn_status'];
  const rows = keys.map(k => [k,'','', 'not_run','','','']);
  sh.getRange(2,1,rows.length,7).setValues(rows);
}


function refreshManualInputSheets_(fy) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const people = getPeopleListFromConfig_();
  if (!people.length) return;

  const inSh = ss.getSheetByName(SHEETS.SALES_INPUT);
  const vals = inSh.getDataRange().getValues().slice(1);
  const products = Array.from(new Set(vals.map(r => String(r[2] || '').trim()).filter(Boolean))).sort();
  if (!products.length) return;

  const defaultDate = new Date((Number(fy) || getDefaultFY_()), 3, 1);
  ensureFactorsProductTemplate_(ss.getSheetByName(SHEETS.PRODUCT), products, people, defaultDate);
  ensureFactorsClientTemplate_(ss.getSheetByName(SHEETS.CLIENT), people, defaultDate);
  ensureOpinionsTemplate_(ss.getSheetByName(SHEETS.OPINIONS), people, defaultDate);
  ensureDevTemplate_(ss.getSheetByName(SHEETS.DEV_SPOT), people, defaultDate);
}


function writeRowsInChunks_(sh, startRow, startCol, rows, chunkSize) {
  if (!rows || !rows.length) return;
  const size = Math.max(1, Number(chunkSize) || 2000);
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    sh.getRange(startRow + i, startCol, chunk.length, chunk[0].length).setValues(chunk);
  }
}

function classifyServiceType_(serviceCategoryRaw) {
  const serviceCategory = String(serviceCategoryRaw || '').trim().toLowerCase();

  // 優先ルール：ベース/スポットの明示文字列を最優先
  if (serviceCategory.includes('ベース')) return 'BASE';
  if (serviceCategory.includes('スポット')) return 'SPOT';

  // 追加マッピング（部分一致）
  const baseKeywords = ['フラグメント', 'テンプレート', '運用更新', '簡便化', '保守サポート'];
  const spotKeywords = ['開発', 'その他', 'myinsights'];

  if (baseKeywords.some(k => serviceCategory.includes(k.toLowerCase()))) return 'BASE';
  if (spotKeywords.some(k => serviceCategory.includes(k.toLowerCase()))) return 'SPOT';

  return 'OTHER';
}

/**
 * 取得元アダプタ：外部実績ソースから、指定クライアント・指定月レンジの
 * 月次レコードを返す。将来 ZAC WebAPI へ差し替える場合は本関数のみ差し替える。
 * 戻り値: [{ client, serviceType:'BASE'|'SPOT', product, monthStart:Date, amount:Number }]
 *  - serviceType が 'OTHER' のレコードは含めない（classifyServiceType_ の判定に従う）
 *  - monthStart は当該月の1日（new Date(y, m, 1)）
 *  - 並び替えは行わない（呼び出し側の責務）
 * @param {string} client  メーカー名（正規化前でも可。内部で normalizeClientName_ を適用）
 * @param {{startMonth:Date, endMonth:Date}} opt  取得月レンジ（両端含む・月初基準）
 */
function fetchClientMonthlyRecords_(client, opt) {
  const targetClient = normalizeClientName_(String(client || '').trim());
  if (!targetClient) throw new Error('CONFIG!B2 にクライアントを設定してください。');

  const startMonth = opt && opt.startMonth;
  const endMonth = opt && opt.endMonth;
  const ext = SpreadsheetApp.openById(getExternalSpreadsheetId_());
  const sheets = ext.getSheets().filter(s => s.getName().startsWith(EXTERNAL_SHEET_PREFIX) && s.getName().endsWith(EXTERNAL_SHEET_SUFFIX));
  const records = [];

  sheets.forEach(sht => {
    const lastRow = sht.getLastRow();
    if (lastRow < 2) return;
    const readCols = Math.max(EXT_COL_AMOUNT, EXT_COL_DATE_PRIMARY, EXT_COL_DATE_SECONDARY, EXT_COL_SERVICE_CATEGORY, EXT_COL_CATEGORY, EXT_COL_CLIENT);
    const vals = sht.getRange(2, 1, lastRow - 1, readCols).getValues();
    for (let i = 0; i < vals.length; i++) {
      const r = vals[i];
      const rowClient = String(r[EXT_COL_CLIENT - 1] || '').trim();
      if (!isSameClient_(rowClient, targetClient)) continue;

      const serviceCategory = String(r[EXT_COL_SERVICE_CATEGORY - 1] || '').trim();
      const serviceType = classifyServiceType_(serviceCategory);
      if (serviceType === 'OTHER') continue;

      // legacyの並行比較を壊さないため、この旧経路だけは従来挙動を維持する。
      // vNextの公式runはVNext_Engine.jsの厳格bridgeだけを使い、BE欠損時のBD fallbackを拒否する。
      let d = r[EXT_COL_DATE_PRIMARY - 1];
      let dt = toDate_(d);
      if (!dt) {
        d = r[EXT_COL_DATE_SECONDARY - 1];
        dt = toDate_(d);
      }
      if (!dt) continue;
      const ym = new Date(dt.getFullYear(), dt.getMonth(), 1);
      if (ym < startMonth || ym > endMonth) continue;

      const product = String(r[EXT_COL_CATEGORY - 1] || '').trim() || serviceType;
      const amount = Number(r[EXT_COL_AMOUNT - 1] || 0);
      if (!isFinite(amount)) continue;

      records.push({ client: normalizeClientName_(rowClient), serviceType, product, monthStart: ym, amount });
    }
  });

  return records;
}

function importMonthlyFromExternal_(targetSheetName, withStatus) {
  const started = new Date();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(targetSheetName);
  const cfg = ss.getSheetByName(SHEETS.CONFIG);
  const targetClient = normalizeClientName_(String(cfg.getRange('B2').getValue() || '').trim());
  const fy = Number(cfg.getRange('B3').getValue()) || getDefaultFY_();
  if (!targetClient) throw new Error('CONFIG!B2 にクライアントを設定してください。');

  const isSalesInput = targetSheetName === SHEETS.SALES_INPUT;
  const start = isSalesInput ? new Date(fy - 4, 3, 1) : new Date(fy - 3, 3, 1);
  const end = isSalesInput ? new Date(fy, 2, 1) : new Date(fy + 1, 2, 1);
  const rows = [];
  const now = new Date();
  const currMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  toastProgress_(ss, '外部実績を取得中…', 3);
  const records = fetchClientMonthlyRecords_(targetClient, { startMonth: start, endMonth: end });
  records.forEach(record => {
    const ym = record.monthStart;
    const client = normalizeClientName_(record.client);
    if (withStatus) {
      // 締まり（D5・2026-10-07）: 月末から ACTUAL_CLOSE_LAG_DAYS 日たってから取り込んだ月だけ closed（前は取り込んだ日の月より前を全部 closed にしていた）。
      // 印を決めた取り込みの日時を source_updated_at に残す。読む側（B-2〜C-1）はこの日時から締まりを数え直す
      const status = isActualMonthClosed_(ym, now) ? 'closed' : 'open';
      rows.push([client, record.serviceType, record.product, fmtYM_(ym), record.amount, status, now]);
    } else {
      const closed = ym < currMonth ? 1 : 0;
      rows.push([client, record.serviceType, record.product, fmtYM_(ym), record.amount, closed, new Date()]);
    }
  });

  rows.sort((a, b) => (a[0] + a[1] + a[3] + a[2]).localeCompare(b[0] + b[1] + b[3] + b[2]));

  sh.getRange(2, 1, Math.max(1, sh.getMaxRows() - 1), sh.getLastColumn()).clearContent();
  if (rows.length) writeRowsInChunks_(sh, 2, 1, rows, 2000);

  // D列（target_month）をテキスト形式に設定（Sheets自動Date変換を防止）
  if (rows.length) {
    sh.getRange(2, 4, rows.length, 1).setNumberFormat('@');
    sh.getRange(2, 5, rows.length, 1).setNumberFormat('#,##0');
  }

  // 取得データの月範囲をログ
  const ymSet = new Set(rows.map(r => String(r[3] || '')));
  const ymSorted = Array.from(ymSet).sort();
  const expectedMonths = 48;
  const rangeInfo = ymSorted.length
    ? `${ymSorted[0]}〜${ymSorted[ymSorted.length - 1]}（${ymSorted.length}ヶ月 / 想定${expectedMonths}ヶ月）`
    : `データなし（想定${expectedMonths}ヶ月）`;

  const step = (targetSheetName === SHEETS.SALES_INPUT) ? 'step1_status' : 'step2_status';
  updateProcessStatus_(step, 'success', targetClient, rows.length, '');
  logRun_((targetSheetName === SHEETS.SALES_INPUT) ? 'importSalesInputMonthly' : 'importActualEvalMonthly', targetClient, 'success', rows.length, started, rangeInfo);

  return { count: rows.length, range: rangeInfo };
}

/**
 * HOW TO TEST (report-text-compress)
 * 1) VERSION='2.3.41-dev' / BUILD_STAGE='report-text-compress'、DLM_BUILD_STAGE 不変。
 * 2) grep で system instruction に report_text 圧縮ルールが1件、
 *    user content に短文圧縮ルールが1件存在すること。
 * 3) A-4 を再実行 → AI_RESEARCH_STRUCTURED の report_text が各 topic 2〜3文・短文になり、
 *    競合の製品別シェア（武田/協和キリン等の個別製品明細）や出典マーカー [1]/[2] の羅列が消えること。
 * 4) スコア列（event_score / benchmark_score / blended_score）と coverage / quality / neutralized が
 *    本変更で構造的に変わらないこと（live検索の揺れ・要約変化に伴う微差は許容、算出式は不変）。
 * 5) A-4 を再実行しない限り、既存 report_text は前回の長文のまま（本変更はプロンプトのみ＝既存データ非遡及）。
 * 6) A-9 を実行し OUTPUT の年度合計および月次 P10/P50/P90 が本変更の前後で不変であること（予測コア無変更）。
 * 7) AI_RESEARCH サマリービュー（①topic別要約文）が短くなり、横に伸びすぎず読めること。
 */
function runVertexAIResearch() {
  const started = new Date();
  let targetClient = '';
  try {
    ensureSetupDone_();
    requireStepSuccess_('step1_status', '先にA-2 売上データを取り込む を実行してください。');

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const cfgSh = ss.getSheetByName(SHEETS.CONFIG);
    targetClient = normalizeClientName_(String(cfgSh.getRange('B2').getValue() || '').trim());
    if (!targetClient) throw new Error('CONFIG!B2 にクライアントを設定してください。');

    const vertex = readVertexConfig_();
    if (!vertex.enabled) {
      alertOrThrow_('AI調査は無効です', 'CONFIG の AI_RESEARCH_ENABLED を 1 にしてから A-4 を実行してください。');
      return;
    }
    if (!vertex.geminiReady) {
      throw new Error('Vertex の必須設定が未入力です（CONFIG: VERTEX_PROJECT_ID / VERTEX_LOCATION / VERTEX_GEMINI_MODEL）。設定後に A-4 を再実行してください。');
    }

    ensureAIResearchRuntimeSheets_(ss);
    hideNonUserSheets_();
    const runId = Utilities.getUuid();
    const runAt = new Date();
    const asOf = Utilities.formatDate(runAt, TZ, 'yyyy-MM-dd');
    const outRows = [];
    const reportParts = [];
    const neutralTopics = [];
    const stats = {
      webError: 0,
      ragError: 0,
      structureError: 0,
      lowConfidence: 0
    };

    AI_TOPICS.forEach(topic => {
      const webPrompt = buildWebResearchPrompt_(targetClient, topic);
      const webStarted = new Date();
      const web = callVertexGeminiGrounded_(webPrompt, { config: vertex });
      const webDuration = durationSec_(webStarted);
      const webCitations = extractGeminiGroundingCitations_(web.raw);
      const webLow = (!web.ok || !web.text || webCitations.length === 0);
      if (!web.ok) stats.webError++;
      if (webLow) stats.lowConfidence++;
      appendAIResearchRawRow_(ss, SHEETS.AI_RESEARCH_RAW, {
        client: targetClient,
        asOf,
        axis: 'web',
        topic,
        evidence: citationSummary_(webCitations),
        note: {
          run_id: runId,
          prompt: webPrompt,
          ok: web.ok,
          finish_reason: web.finishReason || '',
          duration_sec: webDuration,
          usage: web.usage || {},
          text: web.text || '',
          citations: webCitations,
          error: web.error || ''
        }
      });
      appendAIResearchTaskLog_(ss, {
        runId,
        runAt,
        client: targetClient,
        topic,
        aspect: 'web',
        model: vertex.geminiModel,
        endpoint: web.endpoint || '',
        status: web.ok ? 'success' : 'error',
        durationSec: webDuration,
        usage: web.usage || {},
        lowConfidence: webLow,
        citations: webCitations,
        error: web.error || '',
        note: { tool: web.tool || 'googleSearch', finish_reason: web.finishReason || '' }
      });

      const ragQuery = buildRagQuery_(targetClient, topic);
      const ragStarted = new Date();
      const rag = vertex.ragReady
        ? callVertexSearchRAG_(ragQuery, { config: vertex })
        : { ok: false, skipped: true, endpoint: 'skipped', summary: '', citations: [], documents: [], error: 'rag_not_configured' };
      const ragDuration = durationSec_(ragStarted);
      const ragLow = vertex.ragReady && (!rag.ok || !rag.summary || !rag.citations || rag.citations.length === 0);
      if (vertex.ragReady && !rag.ok) stats.ragError++;
      if (ragLow) stats.lowConfidence++;
      appendAIResearchRawRow_(ss, SHEETS.AI_RESEARCH_RAW, {
        client: targetClient,
        asOf,
        axis: 'rag',
        topic,
        evidence: citationSummary_(rag.citations || []),
        note: {
          run_id: runId,
          query: ragQuery,
          ok: rag.ok,
          duration_sec: ragDuration,
          summary: rag.summary || '',
          citations: rag.citations || [],
          documents: rag.documents || [],
          error: rag.error || ''
        }
      });
      appendAIResearchTaskLog_(ss, {
        runId,
        runAt,
        client: targetClient,
        topic,
        aspect: 'rag',
        model: 'Vertex AI Search',
        endpoint: rag.endpoint || '',
        status: rag.skipped ? 'skipped' : (rag.ok ? 'success' : 'error'),
        durationSec: ragDuration,
        usage: {},
        lowConfidence: ragLow,
        citations: rag.citations || [],
        error: rag.error || '',
        note: { query: ragQuery, documents: (rag.documents || []).length }
      });

      const structureStarted = new Date();
      let structured = { ok: false, error: 'web and rag failed; structure skipped', endpoint: 'skipped', usage: {} };
      let topicRows = [];
      if (web.ok || rag.ok) {
        structured = callVertexGeminiStructured_(
          buildVertexStructureSystemInstruction_(),
          buildVertexStructureUserContent_(targetClient, topic, web, rag),
          { config: vertex }
        );
        if (structured.ok) {
          topicRows = buildVertexStructuredRows_(targetClient, asOf, topic, structured.json);
        }
      }
      const structureDuration = durationSec_(structureStarted);
      const structureLow = (!structured.ok || topicRows.length === 0);
      if (!structured.ok || topicRows.length === 0) {
        stats.structureError++;
        neutralTopics.push(topic);
      }
      if (structureLow) stats.lowConfidence++;
      appendAIResearchTaskLog_(ss, {
        runId,
        runAt,
        client: targetClient,
        topic,
        aspect: 'structure',
        model: vertex.geminiModel,
        endpoint: structured.endpoint || '',
        status: (structured.ok && topicRows.length) ? 'success' : 'error',
        durationSec: structureDuration,
        usage: structured.usage || {},
        lowConfidence: structureLow,
        citations: { web: webCitations, rag: rag.citations || [] },
        error: structured.error || '',
        note: buildVertexBlendLogNote_(topicRows)
      });
      if (topicRows.length) {
        outRows.push.apply(outRows, topicRows);
        const report = sanitizeAiReportText_((structured.json && structured.json.report_text) || '');
        if (report) reportParts.push(`【${topic}】\n${report}`);
      }
    });

    if (!outRows.length) {
      const msg = `Vertex調査に失敗しました。既存のAI_RESEARCH_STRUCTUREDは保持しています。CONFIGとAI_RESEARCH_TASK_LOGを確認してください。`;
      updateProcessStatus_('step3a_status', 'error', targetClient, 0, msg);
      safeLogRun_('runVertexAIResearch', targetClient, 'error', 0, started, msg);
      alertOrThrow_('Vertex調査エラー', msg);
      return;
    }

    const reportText = sanitizeAiReportText_(reportParts.join('\n\n'));
    outRows.forEach((r, i) => { r[18] = (i === 0 ? reportText : ''); });
    const out = ss.getSheetByName(SHEETS.AI_RESEARCH_STRUCTURED);
    out.getRange(2, 1, Math.max(1, out.getMaxRows() - 1), 22).clearContent();
    out.getRange(2, 1, outRows.length, 22).setValues(outRows);

    let summaryAiScores = null;
    try {
      const tuning = readModelTuningFromConfig_();
      summaryAiScores = readAIResearchScores_(null, { basis: readAiScoreBasis_(), clientName: targetClient, tuning });
    } catch (scoreErr) {
      summaryAiScores = null;
    }
    writeAIResearchSummaryView_(ss, targetClient, asOf, outRows, summaryAiScores);

    // Vertex予測アシスト（VERTEX_FORECAST_ENABLED=1 のとき12か月調整率を取得してログ化）
    try {
      const assistRes = runVertexForecastAssist_(targetClient, ss, vertex, null);
      if (assistRes && assistRes.ok) {
        safeLogRun_('runVertexForecastAssist_', targetClient, 'success', 12, started, `conf=${assistRes.confidence}`);
      } else if (assistRes && assistRes.skipped && assistRes.skipped !== 'disabled') {
        safeLogRun_('runVertexForecastAssist_', targetClient, 'warning', 0, started, String(assistRes.skipped || assistRes.error || ''));
      } else if (assistRes && assistRes.error) {
        safeLogRun_('runVertexForecastAssist_', targetClient, 'warning', 0, started, String(assistRes.error));
      }
    } catch (assistErr) {
      safeLogRun_('runVertexForecastAssist_', targetClient, 'warning', 0, started, String(assistErr && assistErr.message || assistErr));
    }

    const warnText = buildVertexWarningSummary_(stats, neutralTopics, outRows.length);
    updateProcessStatus_('step3_status', 'success', targetClient, outRows.length, 'Vertex AI research');
    updateProcessStatus_('step3a_status', 'success', targetClient, outRows.length, warnText);
    safeLogRun_('runVertexAIResearch', targetClient, 'success', outRows.length, started, warnText);
    hideNonUserSheets_();
    ss.setActiveSheet(ss.getSheetByName(SHEETS.AI_RESEARCH));
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    try {
      updateProcessStatus_('step3_status', 'error', targetClient, 0, msg);
      safeLogRun_('runVertexAIResearch', targetClient, 'error', 0, started, msg);
    } catch (logErr) {
      // エラー通知を優先する
    }
    alertOrThrow_('AI調査エラー', msg);
  }
}

function ensureAIResearchRuntimeSheets_(ss) {
  ensureSheetReady_(ss, SHEETS.AI_RESEARCH_STRUCTURED, ['client','as_of_date','topic','row_type','direction','impact_score','confidence','evidence','time_horizon','business_relevance_reason','market_size_ref','peer_universe','peer_basis','relative_position_label','relative_percentile','relative_confidence','benchmark_quality','relative_reason','report_text','event_score','benchmark_score','blended_score']);
  ensureSheetReady_(ss, SHEETS.AI_RESEARCH_TASK_LOG, ['run_id','run_at','run_by','client','topic','aspect','model','endpoint','status','duration_sec','prompt_tokens','candidates_tokens','total_tokens','low_confidence_flag','citations_json','error_summary','note']);
  ensureSheetReady_(ss, SHEETS.AI_RESEARCH_RAW, getAIResearchRawHeaders_());
  ensureSheetReady_(ss, SHEETS.VERTEX_FORECAST_LOG, getVertexForecastLogHeaders_());
  migrateLegacyAIResearchRawSheets_(ss);
}

function getAIResearchRawHeaders_() {
  return ['client','as_of_date','axis','topic','direction','magnitude','uncertainty','relative_position','evidence','frozen_flag','frozen_at','note'];
}

function migrateLegacyAIResearchRawSheets_(ss) {
  // Existing books may still contain the pre-merge raw sheets; move their rows into RAW once.
  // 位置ベースではなくヘッダ名マッチで移送する。axis は旧シート名から確定（WEB→web / EXTERNAL→rag）し、
  // 旧2枚の列順が RAW と異なっても client/as_of_date/topic/evidence/note は同名ヘッダ列へ入り、axis ずれが起きない。
  const legacySources = [
    { name: 'AI_RESEARCH_WEB', axis: 'web' },
    { name: 'AI_RESEARCH_EXTERNAL', axis: 'rag' }
  ];
  const headers = getAIResearchRawHeaders_();
  legacySources.forEach(def => {
    const legacy = ss.getSheetByName(def.name);
    if (!legacy) return;
    try {
      const lastRow = legacy.getLastRow();
      if (lastRow >= 2) {
        const raw = ensureSheetReady_(ss, SHEETS.AI_RESEARCH_RAW, headers);
        const values = legacy.getDataRange().getValues();
        const legacyIdx = headerIndexMap_(values[0] || []);
        const rows = values.slice(1).map(r => headers.map(h => {
          if (h === 'axis') return def.axis; // シート名が axis の正典（旧側にaxis列が無くても空にしない）
          if (legacyIdx[h] !== undefined) {
            const v = r[legacyIdx[h]];
            return (v === undefined || v === null) ? '' : v;
          }
          if (h === 'frozen_flag') return 0;
          return '';
        }));
        if (rows.length) writeRowsInChunks_(raw, raw.getLastRow() + 1, 1, rows, 500);
        legacy.getRange(2, 1, Math.max(1, legacy.getMaxRows() - 1), legacy.getMaxColumns()).clearContent();
      }
      ss.deleteSheet(legacy);
    } catch (e) {
      try { legacy.hideSheet(); } catch (ignore) {}
    }
  });
}

function ensureSheetReady_(ss, name, headers) {
  const sh = getOrCreateSheet_(ss, name);
  ensureSheetHasColumns_(sh, headers.length);
  if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setBackground(COLOR_HEADER).setFontWeight('bold');
    sh.setFrozenRows(1);
    return sh;
  }
  ensureSheetHeaders_(sh, headers);
  return sh;
}

function vertexHost_(location) {
  const loc = String(location || '').trim();
  if (loc === 'global') return 'https://aiplatform.googleapis.com';
  return `https://${encodeURIComponent(loc)}-aiplatform.googleapis.com`;
}

function discoveryEngineHost_(location) {
  const loc = String(location || '').trim().toLowerCase();
  if (!loc || loc === 'global') return 'https://discoveryengine.googleapis.com';
  return `https://${encodeURIComponent(loc)}-discoveryengine.googleapis.com`;
}

function vertexPostJson_(endpoint, payload) {
  try {
    const res = UrlFetchApp.fetch(endpoint, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    const text = res.getContentText() || '';
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch (parseErr) {
      json = { rawText: text };
    }
    return {
      ok: code >= 200 && code < 300,
      code,
      text,
      json,
      error: code >= 200 && code < 300 ? '' : extractApiErrorMessage_(json, text)
    };
  } catch (e) {
    return { ok: false, code: 0, text: '', json: {}, error: String(e && e.message ? e.message : e) };
  }
}

function callVertexGeminiGrounded_(prompt, opt) {
  const cfg = (opt && opt.config) || readVertexConfig_();
  const endpoint = `${vertexHost_(cfg.location)}/v1/projects/${encodeURIComponent(cfg.projectId)}/locations/${encodeURIComponent(cfg.location)}/publishers/google/models/${encodeURIComponent(cfg.geminiModel)}:generateContent`;
  const runWithTool = toolKey => {
    const tool = {};
    tool[toolKey] = {};
    const generationConfig = { temperature: 0.2, maxOutputTokens: 8192 };
    // Gemini 3 Pro can spend most of a request on internal thinking. For this
    // bounded evidence-retrieval task, LOW is enough and prevents a
    // MAX_TOKENS finish before groundingChunks are attached to the response.
    // Older models don't accept thinkingLevel, so only send it to Gemini 3.
    if (/^gemini-3(?:\.|-|$)/i.test(String(cfg.geminiModel || ''))) {
      generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
    }
    const payload = {
      contents: [{ role: 'user', parts: [{ text: String(prompt || '') }] }],
      tools: [tool],
      generationConfig
    };
    const res = vertexPostJson_(endpoint, payload);
    if (!res.ok) {
      return { ok: false, endpoint, tool: toolKey, text: '', usage: {}, finishReason: '', raw: res.json, error: res.error, code: res.code };
    }
    return {
      ok: true,
      endpoint,
      tool: toolKey,
      text: extractGeminiText_(res.json),
      usage: extractGeminiUsage_(res.json),
      finishReason: extractGeminiFinishReason_(res.json),
      raw: res.json,
      error: '',
      code: res.code
    };
  };
  const first = runWithTool('googleSearch');
  if (first.ok || first.code !== 400) return first;
  const retry = runWithTool('googleSearchRetrieval');
  return retry.ok ? retry : first;
}

function callVertexSearchRAG_(query, opt) {
  const cfg = (opt && opt.config) || readVertexConfig_();
  const servingConfig = String(cfg.servingConfig || 'default_search').trim() || 'default_search';
  const endpoint = `${discoveryEngineHost_(cfg.searchLocation)}/v1/projects/${encodeURIComponent(cfg.projectId)}/locations/${encodeURIComponent(cfg.searchLocation)}/collections/default_collection/dataStores/${encodeURIComponent(cfg.datastoreId)}/servingConfigs/${encodeURIComponent(servingConfig)}:search`;
  const payload = {
    query: String(query || ''),
    pageSize: 10,
    contentSearchSpec: {
      summarySpec: {
        summaryResultCount: 5,
        includeCitations: true,
        ignoreAdversarialQuery: true,
        ignoreNonSummarySeekingQuery: false
      }
    }
  };
  const res = vertexPostJson_(endpoint, payload);
  if (!res.ok) {
    return { ok: false, endpoint, summary: '', citations: [], documents: [], raw: res.json, error: res.error };
  }
  return {
    ok: true,
    endpoint,
    summary: extractVertexSearchSummary_(res.json),
    citations: extractVertexSearchCitations_(res.json),
    documents: extractVertexSearchDocuments_(res.json),
    raw: res.json,
    error: ''
  };
}

function callVertexGeminiStructured_(systemInstruction, userContent, opt) {
  const cfg = (opt && opt.config) || readVertexConfig_();
  const endpoint = `${vertexHost_(cfg.location)}/v1/projects/${encodeURIComponent(cfg.projectId)}/locations/${encodeURIComponent(cfg.location)}/publishers/google/models/${encodeURIComponent(cfg.geminiModel)}:generateContent`;
  const attempt = (temperature) => {
    const generationConfig = {
      temperature: temperature,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json'
    };
    if (/^gemini-3(?:\.|-|$)/i.test(String(cfg.geminiModel || ''))) {
      generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
    }
    const payload = {
      systemInstruction: { parts: [{ text: String(systemInstruction || '') }] },
      contents: [{ role: 'user', parts: [{ text: String(userContent || '') }] }],
      generationConfig
    };
    const res = vertexPostJson_(endpoint, payload);
    if (!res.ok) {
      return { ok: false, endpoint, json: null, usage: {}, raw: res.json, error: res.error, httpError: true };
    }
    const txt = extractGeminiText_(res.json);
    try {
      return {
        ok: true,
        endpoint,
        json: parseJsonObjectFromText_(txt),
        usage: extractGeminiUsage_(res.json),
        raw: res.json,
        error: '',
        finishReason: extractGeminiFinishReason_(res.json)
      };
    } catch (e) {
      return {
        ok: false,
        endpoint,
        json: null,
        usage: extractGeminiUsage_(res.json),
        raw: res.json,
        error: `JSON parse failed: ${String(e && e.message ? e.message : e)}`,
        finishReason: extractGeminiFinishReason_(res.json),
        parseError: true
      };
    }
  };
  // 1回目は temperature=0（再現性重視）。パース失敗時の2回目だけ temperature=0.3 にして、
  // 決定的に同じ壊れ方が再生されるのを避ける（最初の完全JSON抽出で取り切れない崩れ方を確率的に回避）。
  // HTTP失敗(parseErrorでない)は再試行しない。2回とも失敗したら呼び出し側の中立化フォールバックに委ねる。
  let r = attempt(0);
  if (!r.ok && r.parseError) {
    r = attempt(0.3);
  }
  return r;
}

function buildWebResearchPrompt_(client, topic) {
  return [
    `Client_Name: ${client}`,
    `Topic: ${topic}`,
    `As_of_Date: ${Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd')}`,
    '',
    'あなたは製薬マーケティング支援会社の外部環境アナリストです。',
    '外部から客観的に観測できる情報のみを調査してください。',
    '対象メーカー（client）の社内実感・取引実績・受託可能性といった内部事情には踏み込まないでください（それらは別途、社内の担当者が入力します）。',
    '',
    '【評価の枠組み】',
    '評価対象は「対象メーカー周辺の、製薬マーケティング支援需要に影響しうる外部環境が、どの程度大きく/活発に動いているか」です。',
    '対象メーカーの企業力そのもののランキングではありません。特定企業の社内予算配分や内製/外注の意思決定には踏み込まないでください。',
    '',
    '【上振れ/下振れの向き（符号）】',
    '次の向きで「上振れ（プラス）」「下振れ（マイナス）」「中立」を判定してください。',
    '- Market: 市場の拡大・活性化はプラス。縮小はマイナス。',
    '- Competitor: 競合各社のマーケ/販促活動が活発化している環境はプラス（支援需要が動く）。活動の停滞はマイナス。',
    '- Channel: 販促・MR・チャネル活動の活発化はプラス。停滞はマイナス。',
    '- DX: DX投資（投資の量・活発さ）の増加はプラス。投資の停滞はマイナス。内製成熟度の高さでは判定しないでください（観測するのは投資量です）。',
    '',
    `現在のTopic「${topic}」について、上記の向きに沿って最新Web情報を調査してください。`,
    '上振れ/下振れ/中立、影響の強さ、根拠URLが分かるように日本語で要約してください。',
    '観測できた範囲で必ず向き（上振れ/下振れ/中立）と影響の強さを述べてください。弱くても実在する動きは拾い、その弱さは「低信頼」と明記して表現してください。環境がほぼ動いていない場合のみ「中立」とし、その場合も理由を述べてください。',
    '影響の強さは中庸に丸めず、明確な動きには大きい強さ、弱い動きには小さい強さと、メリハリをつけて述べてください。根拠があるのに無難な中程度（中位）へ寄せることは避けてください。',
    '推測で数値や向きを創作しないでください（中立もゼロも捏造しない）。根拠が弱い場合は低信頼と明記してください。'
  ].join('\n');
}

function buildRagQuery_(client, topic) {
  // AI調査の新フレーム（外部から観測可能な「支援需要に影響しうる外部環境」）に整合させた検索クエリ。
  // 旧クエリはデータストアに出現しないノイズ語と英語topic素語の連結で、
  // 富士経済の日本語レポートに対し検索が希釈されていた。topic別に日本語の展開語で外部環境を狙う。
  // 出版社名（富士経済等）は単一ソースのコーパスでは弁別力がなく希釈要因のため含めない。
  const t = normalizeAiTopic_(topic) || String(topic || '').trim();
  const topicExpansion = {
    Market: '市場規模 市場動向 需要 成長率 患者数 領域別',
    Competitor: '競合 他社 新製品 上市 シェア マーケティング 販促',
    Channel: 'MR 営業 ディテーリング チャネル 情報提供 販促',
    DX: 'DX デジタル デジタルマーケティング オムニチャネル 投資'
  };
  const expansion = topicExpansion[t] || t;
  return `${client} 医薬品 市場環境 ${expansion}`;
}

function buildVertexStructureSystemInstruction_() {
  return [
    'あなたは製薬マーケティング支援会社の売上予測に使うAI調査結果を構造化するアナリストです。',
    'AI調査は外部から客観的に観測できる情報のみを扱います。対象メーカーの社内実感・取引実績・受託可能性には踏み込まないでください（それらは社内の担当者入力で別途反映されます）。',
    '',
    'relative_percentile は「対象メーカーの企業力ランキング」ではなく、「対象メーカー周辺の、製薬マーケティング支援需要に影響しうる外部環境が、どの程度大きく/活発に動いているか」の相対位置として評価してください。50は同等水準、高いほど支援需要環境が大きく/活発に動いていることを表します。',
    '根拠がある場合の relative_percentile は 50〜60 付近に丸めず、上位（70〜90）/下位（10〜30）にはっきり差をつけてください。無難に中位へ寄せることは避けてください。ただし相対位置を判断する根拠が無い場合は、従来どおり relative_percentile を空（null）にし benchmark を埋めないでください（中庸の値で埋めて分散を作ることは禁止です）。',
    'peer_universe / peer_basis には、この相対評価の母集団と基準（何と比べた相対位置か）を必ず明記してください。',
    '【重要・benchmark行の出力条件】relative_percentile は、購入レポート/RAG等の具体的な根拠で相対位置を判断できたときだけ記入してください。根拠が無いトピックでは relative_percentile・relative_position_label・peer_universe・peer_basis をすべて空（null）にし、benchmark を一切埋めないでください。根拠が無いのに 50 や middle を「とりあえず」入れることは禁止です（50は「材料が無い」ではなく「材料に基づき中位と判断した」を意味します）。',
    '',
    '向き（符号）は次に統一してください（4指標すべて順方向）。',
    '- Market: 市場拡大・活性化が上振れ。',
    '- Competitor: 競合各社のマーケ/販促活動の活発化が上振れ。',
    '- Channel: 販促/MR/チャネル活動の活発化が上振れ。',
    '- DX: DX投資（投資量）の増加が上振れ。内製成熟度では判定しない。',
    '',
    'impact_score は 0〜100 の「影響の大きさ」です（0=影響なし、100=最大）。50は中立ではありません。向きは direction（up/down/neutral）で表し、impact_score には大きさだけを入れてください（例: 弱い=10前後、強い=80前後）。',
    'impact_score は中庸に丸めず（40〜60付近へ寄せず）、根拠の強さに応じてレンジ全体（弱い動き=10〜30、明確な動き=70〜100）を使ってください。topic 間で無難に横並びにせず、強い topic と弱い topic の差がはっきり出るように評価してください。',
    'Web検索結果はevent行、購入レポート/RAG結果はbenchmark行に分けてください。',
    '【重要・event行は必ず向きを評価】web側では、観測できた範囲で direction（up/down/neutral）と impact_score を必ず付けてください。環境がほぼ動いていない場合のみ direction=neutral とし、その場合も impact_score は実態に合わせた小さい値（例 5〜15）を入れ、空欄にしないでください。弱くても実在する動きは捨てずに拾ってください（根拠の弱さは impact_score と confidence の低さで表現します）。',
    'confidence と relative_confidence は、その行を実際に出力するなら必須です。空欄にせず 0〜1 の数値を入れてください（自信がなければ低い値、例 0.3）。',
    '根拠が無いのに数値や向きを創作しないでください。根拠が弱いときは値を低くし、根拠がまったく無いときは benchmark を空にしてください（中立を捏造しない / ゼロを捏造しない、の両方を守ってください）。',
    '【report_text の書き方・厳守】report_text は当該 topic の「最重要ポイントだけ」を 2〜3文・最大120字程度に圧縮した要約にしてください。長文の列挙・転記は禁止です。',
    '- 競合や他社の製品別シェア・個別製品の販促状況などの明細は report_text に列挙しないでください。「競合各社の販促活動が活発化している」のように、外部環境の動きの方向と強さが分かる一言に集約してください（個別の根拠は evidence / relative_reason 側に置く）。',
    '- ソースの文章をそのまま転記・引用しないでください。出典マーカー（[1] / [2] 等）や箇条書きの羅列を report_text に持ち込まないでください。',
    '- 対象メーカー（client）の外部環境がどの向きに・どの程度動いているか、という結論を最優先で1文目に書いてください。',
    'JSONのみを返してください。'
  ].join('\n');
}

function buildVertexStructureUserContent_(client, topic, web, rag) {
  return [
    `client: ${client}`,
    `topic: ${topic}`,
    '',
    '【構造化の前提】',
    'AI調査は外部観測の客観情報のみ。対象メーカーの社内実感・受託可能性には踏み込まない。',
    'relative_percentile は「対象メーカー周辺の支援需要に影響しうる外部環境の動きの大きさ/活発さ」の相対位置（50=同等、高いほど活発）。企業力ランキングではない。',
    'peer_universe / peer_basis に母集団と比較基準を必ず明記する。',
    `向き（符号）: ${topic} は順方向（Market=市場拡大が上振れ / Competitor=競合活動の活発化が上振れ / Channel=販促・MR活動の活発化が上振れ / DX=DX投資量の増加が上振れ・内製成熟度では見ない）。`,
    '',
    '次のJSON schemaで返してください。',
    'impact_score は 0〜100（0=影響なし・100=最大、50は中立ではない）。web の direction/impact_score/confidence は原則必ず記入（動きが無い場合のみ direction=neutral + 小さい impact_score）。',
    'impact_score と relative_percentile は中庸に丸めず（中位へ寄せず）、根拠の強さに応じてレンジ全体を使い、topic 間で差がはっきり出るようにしてください（根拠が無い benchmark は従来どおり空のまま）。',
    'report（benchmark）は根拠があるときだけ記入。根拠が無ければ relative_percentile / relative_position_label / peer_universe / peer_basis を null（空）にし、50 や middle のプレースホルダを入れないこと。',
    'report_text は最重要ポイントだけの 2〜3文・最大120字程度の圧縮要約にすること。競合や他社の製品別明細を列挙せず、出典マーカーやソース文の転記もしないこと（詳細は evidence / relative_reason に置く）。',
    '{"topic":"Market|Competitor|Channel|DX","web":{"direction":"up|down|neutral","impact_score":0,"confidence":0,"evidence":"","time_horizon":"","business_relevance_reason":"","market_size_ref":""},"report":{"relative_percentile":null,"relative_confidence":null,"benchmark_quality":"high|medium|low","peer_universe":"","peer_basis":"","relative_position_label":"","relative_reason":"","evidence":""},"report_text":""}',
    '',
    'Web検索結果:',
    shortText_((web && web.text) || '', 12000),
    '',
    'Web citations:',
    jsonForCell_(extractGeminiGroundingCitations_((web && web.raw) || {}), 8000),
    '',
    '購入レポート/RAG summary:',
    shortText_((rag && rag.summary) || '', 12000),
    '',
    'RAG citations/documents:',
    jsonForCell_({ citations: (rag && rag.citations) || [], documents: (rag && rag.documents) || [] }, 12000)
  ].join('\n');
}

function buildVertexStructuredRows_(client, asOf, topic, obj) {
  const src = obj || {};
  const topicNorm = normalizeAiTopic_(src.topic || topic) || topic;
  const web = src.web || src.event || {};
  const report = src.report || src.benchmark || {};
  const rows = [];

  const direction = normalizeAiDirection_(web.direction || '');
  const impact = clampFinite_(parseAiNumericScore_(web.impact_score, 'impact_score'), 0, 100);
  const confidence = clampFinite_(parseAiConfidence_(web.confidence), 0, 1);
  const sign = direction === 'up' ? 1 : (direction === 'down' ? -1 : 0);
  // impact_score は 0〜100 の影響の大きさ（0=なし,100=最大）。direction が符号。
  const eventScoreRaw = (isFinite(impact) && isFinite(confidence)) ? sign * (impact / 100) * 50 * confidence : NaN;
  const eventScore = isFinite(eventScoreRaw) ? clamp_(eventScoreRaw, -50, 50) : '';
  if (direction || isFinite(impact) || isFinite(confidence) || web.evidence) {
    rows.push([
      client,
      asOf,
      topicNorm,
      'event',
      direction,
      isFinite(impact) ? impact : '',
      isFinite(confidence) ? confidence : '',
      normalizeAiCellValue_(web.evidence || ''),
      normalizeAiCellValue_(web.time_horizon || ''),
      normalizeAiCellValue_(web.business_relevance_reason || ''),
      normalizeAiCellValue_(web.market_size_ref || ''),
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      eventScore,
      '',
      ''
    ]);
  }

  let relPct = clampFinite_(parseAiPercentile_(report.relative_percentile), 0, 100);
  if (!isFinite(relPct)) relPct = clampFinite_(inferPercentileFromLabel_(report.relative_position_label), 0, 100);
  const relConf = clampFinite_(parseAiConfidence_(report.relative_confidence), 0, 1);
  const quality = coerceBenchmarkQuality_(report.benchmark_quality || '').value;
  const qMul = quality === 'high' ? 1 : (quality === 'medium' ? 0.75 : 0.5);
  const benchmarkScoreRaw = (isFinite(relPct) && isFinite(relConf)) ? (relPct - 50) * relConf * qMul : NaN;
  const benchmarkScore = isFinite(benchmarkScoreRaw) ? clamp_(benchmarkScoreRaw, -50, 50) : '';
  if (isFinite(relPct) || isFinite(relConf) || report.peer_universe || report.peer_basis || report.evidence) {
    rows.push([
      client,
      asOf,
      topicNorm,
      'benchmark',
      '',
      '',
      '',
      normalizeAiCellValue_(report.evidence || ''),
      '',
      '',
      normalizeAiCellValue_(report.market_size_ref || ''),
      normalizeAiCellValue_(report.peer_universe || ''),
      normalizeAiCellValue_(report.peer_basis || ''),
      normalizeAiCellValue_(report.relative_position_label || ''),
      isFinite(relPct) ? relPct : '',
      isFinite(relConf) ? relConf : '',
      quality,
      normalizeAiCellValue_(report.relative_reason || ''),
      '',
      '',
      benchmarkScore,
      ''
    ]);
  }
  return rows;
}

function appendAIResearchRawRow_(ss, sheetName, opt) {
  if (!ss.getSheetByName(sheetName)) ensureAIResearchRuntimeSheets_(ss);
  const target = ss.getSheetByName(sheetName);
  if (!target) return;
  target.appendRow([
    opt.client || '',
    opt.asOf || '',
    opt.axis || '',
    opt.topic || '',
    '',
    '',
    '',
    '',
    opt.evidence || '',
    0,
    '',
    jsonForCell_(opt.note || {}, 45000)
  ]);
}

function appendAIResearchTaskLog_(ss, opt) {
  const sh = ss.getSheetByName(SHEETS.AI_RESEARCH_TASK_LOG) || ensureSheetReady_(ss, SHEETS.AI_RESEARCH_TASK_LOG, ['run_id','run_at','run_by','client','topic','aspect','model','endpoint','status','duration_sec','prompt_tokens','candidates_tokens','total_tokens','low_confidence_flag','citations_json','error_summary','note']);
  const usage = opt.usage || {};
  sh.appendRow([
    opt.runId || '',
    opt.runAt || new Date(),
    Session.getActiveUser().getEmail() || 'unknown',
    opt.client || '',
    opt.topic || '',
    opt.aspect || '',
    opt.model || '',
    opt.endpoint || '',
    opt.status || '',
    opt.durationSec || 0,
    Number(usage.promptTokens || 0),
    Number(usage.candidatesTokens || 0),
    Number(usage.totalTokens || 0),
    opt.lowConfidence ? 1 : 0,
    jsonForCell_(opt.citations || [], 20000),
    shortText_(opt.error || '', 500),
    jsonForCell_(opt.note || {}, 20000)
  ]);
}

function extractGeminiText_(json) {
  const cands = (json && json.candidates) || [];
  if (!cands.length) return '';
  const parts = (((cands[0] || {}).content || {}).parts) || [];
  return parts.map(p => String((p && p.text) || '')).filter(Boolean).join('\n').trim();
}

function extractGeminiUsage_(json) {
  const u = (json && json.usageMetadata) || {};
  return {
    promptTokens: Number(u.promptTokenCount || 0),
    candidatesTokens: Number(u.candidatesTokenCount || 0),
    thoughtsTokens: Number(u.thoughtsTokenCount || 0),
    totalTokens: Number(u.totalTokenCount || 0)
  };
}

function extractGeminiFinishReason_(json) {
  const cands = (json && json.candidates) || [];
  return cands.length ? String(cands[0].finishReason || '') : '';
}

function extractGeminiGroundingCitations_(json) {
  const cands = (json && json.candidates) || [];
  const gm = cands.length ? (cands[0].groundingMetadata || {}) : {};
  const chunks = gm.groundingChunks || [];
  const out = [];
  chunks.forEach(ch => {
    const web = ch && ch.web ? ch.web : {};
    const uri = String(web.uri || '').trim();
    const title = String(web.title || '').trim();
    if (uri || title) out.push({ title, uri });
  });
  return dedupeCitations_(out);
}

function extractVertexSearchSummary_(json) {
  const summary = (json && json.summary) || {};
  return String(summary.summaryText || summary.summary || '').trim();
}

function extractVertexSearchCitations_(json) {
  const out = [];
  const summary = (json && json.summary) || {};
  (summary.citations || []).forEach(c => {
    (c.sources || []).forEach(src => {
      out.push({
        title: String(src.title || src.id || '').trim(),
        uri: String(src.uri || src.link || '').trim()
      });
    });
  });
  ((json && json.results) || []).forEach(r => {
    const doc = (r && r.document) || {};
    const ds = doc.derivedStructData || doc.structData || {};
    out.push({
      title: String(ds.title || doc.name || doc.id || '').trim(),
      uri: String(ds.link || ds.uri || '').trim()
    });
  });
  return dedupeCitations_(out);
}

function extractVertexSearchDocuments_(json) {
  return ((json && json.results) || []).slice(0, 10).map(r => {
    const doc = (r && r.document) || {};
    const ds = doc.derivedStructData || doc.structData || {};
    return {
      id: String(doc.id || doc.name || '').trim(),
      title: String(ds.title || '').trim(),
      uri: String(ds.link || ds.uri || '').trim(),
      snippet: shortText_(String(ds.snippets || ds.extractive_answers || ds.extractiveAnswers || ''), 1000)
    };
  });
}

function dedupeCitations_(citations) {
  const seen = {};
  const out = [];
  (citations || []).forEach(c => {
    const title = String(c.title || '').trim();
    const uri = String(c.uri || '').trim();
    if (!title && !uri) return;
    const key = `${uri}|${title}`;
    if (seen[key]) return;
    seen[key] = true;
    out.push({ title, uri });
  });
  return out.slice(0, 20);
}

function citationSummary_(citations) {
  return (citations || []).slice(0, 5).map(c => c.uri || c.title || '').filter(Boolean).join('\n');
}

function parseJsonObjectFromText_(txt) {
  let s = String(txt || '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const first = s.indexOf('{');
  if (first < 0) return JSON.parse(s); // '{' が無ければ従来どおり投げさせる
  // 最初の '{' からブレース深さを数え、最初に深さ0へ戻った位置で打ち切る。
  // これにより「{...}{...}」「{...} 余計な文字」のように後続にゴミが続くケースで、
  // 最初の完全なJSONオブジェクトだけを取り出す（position N で非空白が続く型のパース失敗を救済）。
  // 文字列リテラル内の { } はカウントせず、\ によるエスケープも考慮する。
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = first; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (ch === '\\') { esc = true; }
      else if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  // 深さ0へ戻れた場合は先頭オブジェクトだけを切り出す。
  // 戻れなかった（末尾切れ等）場合は従来フォールバック（最初の'{'〜最後の'}'）で投げさせる。
  if (end >= 0) s = s.slice(first, end + 1);
  else {
    const last = s.lastIndexOf('}');
    if (last > first) s = s.slice(first, last + 1);
  }
  return JSON.parse(s);
}

function extractApiErrorMessage_(json, fallback) {
  if (json && json.error) {
    if (typeof json.error === 'string') return json.error;
    if (json.error.message) return String(json.error.message);
  }
  return shortText_(fallback || '', 1000);
}

function jsonForCell_(obj, maxLen) {
  const limit = Math.max(100, Number(maxLen) || 45000);
  let s = '';
  try {
    s = JSON.stringify(obj === undefined ? null : obj);
  } catch (e) {
    s = JSON.stringify({ error: 'json_stringify_failed', message: String(e && e.message ? e.message : e) });
  }
  if (s.length <= limit) return s;
  return JSON.stringify({ truncated: true, preview: s.slice(0, Math.max(0, limit - 120)) });
}

function clampFinite_(v, lo, hi) {
  const n = Number(v);
  return isFinite(n) ? clamp_(n, lo, hi) : NaN;
}

function durationSec_(startedAt) {
  return Math.round(((new Date()) - startedAt) / 100) / 10;
}

function buildVertexBlendLogNote_(rows) {
  const out = { rows: (rows || []).length, event_score: '', benchmark_score: '' };
  (rows || []).forEach(r => {
    if (r[3] === 'event') out.event_score = r[19];
    if (r[3] === 'benchmark') out.benchmark_score = r[20];
  });
  out.blend = 'event row uses Web result; benchmark row uses Vertex AI Search/RAG result';
  return out;
}

function buildVertexWarningSummary_(stats, neutralTopics, rowCount) {
  return [
    `vertex_rows=${Number(rowCount || 0)}`,
    `web_error=${Number((stats || {}).webError || 0)}`,
    `rag_error=${Number((stats || {}).ragError || 0)}`,
    `structure_error=${Number((stats || {}).structureError || 0)}`,
    `low_confidence=${Number((stats || {}).lowConfidence || 0)}`,
    `neutral_topics=[${(neutralTopics || []).join(',')}]`
  ].join('; ');
}

function countAIResearchStructuredRows_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.AI_RESEARCH_STRUCTURED);
  if (!sh) return 0;
  return Math.max(0, sh.getLastRow() - 1);
}

function runPhase1Forecast() {
  try {
    requireStepSuccess_('step1_status', '先にA-2 売上データを取り込む を実行してください。');
    const started = new Date();
    const parsed = { rows: countAIResearchStructuredRows_(), warning: '' };
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const cfg = ss.getSheetByName(SHEETS.CONFIG);
    const client = normalizeClientName_(String(cfg.getRange('B2').getValue() || '').trim());
    if (!client) throw new Error('CONFIG!B2 にクライアントを設定してください。');
    const fy = Number(cfg.getRange('B3').getValue()) || getDefaultFY_();
    cfg.getRange('B3').setValue(fy);
    validateAllInputsOrThrow_(fy);
    validateRequiredUserInputsOrThrow_();
    runHierarchicalA9AlertsOrThrow_(fy);
    syncSalesFromSalesInput_(fy, client);
    const result = runForecastFYCore_(fy, client);
    const aiAllZero = ['Market','Competitor','Channel','DX'].every(k => Math.abs(Number((result.aiScores || {})[k] || 0)) < 1e-9);
    if (aiAllZero) SpreadsheetApp.getActiveSpreadsheet().toast('⚠ AIスコアが全topicで0.0です。AI_RESEARCH_STRUCTUREDの形式を確認してください。', MENU_NAME, 8);
    writeOutputFY_(result);
    writeDlmShadowLanding_(ss, client, fy, result);
    writeForecastArtifacts_(result, client);
    writeAIHistoriesForRun_(result, result.runId);
    writeSubjectiveImpactHistory_(result, result.runId);
    ss.setActiveSheet(ss.getSheetByName(SHEETS.OUTPUT));
    updateProcessStatus_('step4_status','success',client,result.months.length,'');
    const prodWarn = result.productWeightWarning ? `;prodw=${result.productWeightWarning}` : '';
    logRun_('runPhase1Forecast', client, 'success', result.months.length, started, `ai_rows=${parsed.rows || 0};ai_warn=${parsed.warning || ''}${prodWarn}`);
    // 完了ダイアログ（ポップアップ）は廃止。予測の実行者と事後検証（B-3 等）の実行者は別であり、次手順の案内は
    // 不要なため、ブロッキングな案内ダイアログは出さない。完了の手掛かりとして軽量トーストのみ表示する
    // （次手順の案内文言は含めない）。トースト自体も不要なら次行を削除してよい。
    ss.toast('予測を更新しました。', MENU_NAME, 5);
  } catch (e) {
    updateProcessStatus_('step4_status','error','',0,String(e.message || e));
    if (e && e.webConfirm) throw e;
    alertOrThrow_('予測実行エラー', e.message || e);
  }
}

function writeDlmShadowLanding_(ss, client, fy, result) {
  if (!result || !result.dlmMode || result.dlmMode === 'off') return;
  const dlm = result.dlmForecast;
  if (!dlm || !dlm.ready) return;
  const sh = getOrCreateSheet_(ss, SHEETS.LANDING_FORECAST);
  const headers = ['client','fy','target_month','as_of_month','landing_p10','landing_p50','landing_p90','updated_at','source_run_id','note'];
  ensureSheetHeaders_(sh, headers);
  const values = sh.getDataRange().getValues();
  const idx = headerIndexMap_(values[0] || headers);
  const rowByKey = new Map();
  for (let i = 1; i < values.length; i++) {
    const key = [
      String(values[i][idx.client] || '').trim(),
      String(values[i][idx.fy] || '').trim(),
      ymKey_(values[i][idx.target_month])
    ].join('|');
    if (key !== '||') rowByKey.set(key, i + 1);
  }

  const now = new Date();
  const asOf = fmtYM_(new Date(now.getFullYear(), now.getMonth(), 1));
  const mt = dlm.metrics || {};
  const note = `dlm ${result.dlmMode}; stage=${DLM_BUILD_STAGE}; smape=${(Number(mt.smape || 0) * 100).toFixed(1)}%; coverage=${(Number(mt.coverage || 0) * 100).toFixed(1)}%`;
  const rows = [];
  result.months.forEach((m, i) => {
    if (dlm.p50[i] === null || dlm.p50[i] === undefined) return;
    rows.push([
      client,
      fy,
      fmtYM_(m),
      asOf,
      Number(dlm.p10[i] || 0),
      Number(dlm.p50[i] || 0),
      Number(dlm.p90[i] || 0),
      now,
      (result.runId || ''),
      note
    ]);
  });
  const updatesByRowNo = new Map();
  const appendsByKey = new Map();
  rows.forEach(row => {
    const key = [
      String(row[idx.client] || '').trim(),
      String(row[idx.fy] || '').trim(),
      ymKey_(row[idx.target_month])
    ].join('|');
    const rowNo = rowByKey.get(key);
    if (rowNo) updatesByRowNo.set(rowNo, { rowNo, row });
    else appendsByKey.set(key, row);
  });
  const updates = Array.from(updatesByRowNo.values());
  const appends = Array.from(appendsByKey.values());
  writeContiguousRowUpdates_(sh, updates, headers.length);
  if (appends.length) writeRowsInChunks_(sh, sh.getLastRow() + 1, 1, appends, 500);
}

function writeForecastArtifacts_(result, client) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const snap = ss.getSheetByName(SHEETS.FORECAST_SNAPSHOT);
  const runDate = new Date();
  const sid = Utilities.getUuid();
  const rows=[];
  const scenarios = [
    {name:'nega', arr:result.mixed.p10},
    {name:'neutral', arr:result.mixed.p50},
    {name:'posi', arr:result.mixed.p90}
  ];
  scenarios.forEach(sc=>{
    result.months.forEach((m,i)=>{
      const deterministicAdj = (result.spotFixedByMonth && isFinite(result.spotFixedByMonth[i])) ? result.spotFixedByMonth[i] : (result.devFixedByMonth[i] || 0);
      // forecast_source: actual_closed = 実績の締まった月（予測は実績に置き換え済み）。検証（B-2）はこの行を使わない
      const source = result.sourceByMonth ? (result.sourceByMonth[i] || 'forecast_open') : 'forecast_open';
      rows.push([sid,runDate,client,fmtYM_(m),sc.name,result.mixed.p50[i],0,0,deterministicAdj,sc.arr[i],result.mixed.p10[i],result.mixed.p90[i],JSON.stringify({opinion:result.opinionsSummaryByMonth[i]||'', forecast_source: source}),null,JSON.stringify(buildCalibrationAppliedPayload_(result))]);
    });
  });
  const r0 = snap.getLastRow()+1;
  // target_month(D列)をテキスト書式にしてから書き込む（'yyyy/MM' 文字列が Date に自動変換され、
  // 実績側の文字列キーとの結合が壊れるのを防ぐ）
  snap.getRange(r0, 4, rows.length, 1).setNumberFormat('@');
  snap.getRange(r0,1,rows.length,rows[0].length).setValues(rows);
}

// ===== 検証の決まり（2026-10-07 村井さん承認 D4〜D6） =====
// D5 締まり: 月末 + ACTUAL_CLOSE_LAG_DAYS 日 <= 実績を取り込んだ日（日本の暦）の月だけが締まった月。
// D6 測る予測: その月が始まる前（予測した日 < 月の 1 日。日本の暦）の最後の予測。その回が無い月は測らない。
// D4 締まった月だけ: 検証（B-2）・ダッシュボード（B-3）・インサイト（B-4）・月次の学び（B-5）・四半期の提案（C-1）。
//    B-3〜C-1 は、今の検証の版（EVALUATION_POLICY_VERSION）で B-2 が書いた EVAL_LOG の行のうち、今も締まった月の行だけを使う。

/**
 * セルの日時をミリ秒に（読めなければ NaN）。日付の型・ISO の文字（T つき。時差が無ければその場の時刻）はそのまま。
 * 'yyyy/MM/dd'・'yyyy-MM-dd'（あとに 'HH:mm(:ss)' があってもよい）の文字は日本の時刻として読む
 */
function evalTimeMs_(v) {
  if (v === '' || v === null || v === undefined) return NaN;
  const isDateLike = (v instanceof Date) || Object.prototype.toString.call(v) === '[object Date]' || (typeof v === 'object' && typeof v.getTime === 'function');
  if (isDateLike) { const t = v.getTime(); return isFinite(t) ? t : NaN; }
  const s = String(v).trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}T\d{2}:\d{2}/.test(s)) {
    const t = new Date(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2')).getTime();
    return isFinite(t) ? t : NaN;
  }
  const m = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return NaN;
  // 日本の時刻（UTC より 9 時間進んでいる。夏時間は無い）
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0) - 9, Number(m[5] || 0), Number(m[6] || 0));
}

/** セルの日時の、日本の暦の日（'yyyy-MM-dd'。読めなければ ''） */
function evalJstDay_(v) {
  const t = evalTimeMs_(v);
  return isFinite(t) ? Utilities.formatDate(new Date(t), EVAL_CALENDAR_TZ, 'yyyy-MM-dd') : '';
}

/**
 * その月の実績が締まっているか（D5）: 月末 + ACTUAL_CLOSE_LAG_DAYS 日 <= 取り込んだ日（日本の暦）。
 * 例: 9 月の実績は 10/05 以降に取り込めば締まった月、10/04 までなら締まっていない月。月か取り込んだ日が読めなければ締まっていない
 */
function isActualMonthClosed_(month, importDate) {
  const m = /^(\d{4})\/(\d{2})$/.exec(ymKey_(month));
  const day = evalJstDay_(importDate);
  if (!m || !day) return false;
  // 月末 + N 日 = 翌月の N 日（Date.UTC の月は 0 始まりなので、m[2] がそのまま翌月になる。暦の数え方だけで時差は関係しない）
  const due = new Date(Date.UTC(Number(m[1]), Number(m[2]), ACTUAL_CLOSE_LAG_DAYS)).toISOString().slice(0, 10);
  return due <= day;
}

/** 予測した回が、その月が始まる前か（D6）: 予測した日 < 月の 1 日（日本の暦）。予測した日時が読めなければ前とは言えない */
function isRunBeforeMonth_(runDate, month) {
  const ym = ymKey_(month);
  const day = evalJstDay_(runDate);
  if (!/^\d{4}\/\d{2}$/.test(ym) || !day) return false;
  return day < ym.replace('/', '-') + '-01';
}

/**
 * ACTUAL_EVAL_MONTHLY の行（見出しを除く。B-1 の列の順: client, service_type, product, target_month, eval_actual_amount,
 * actual_closed_flag, source_updated_at）から、実績の締まった月（D5）を返す: { keys: 'client|yyyy/MM' の Set, months: 'yyyy/MM' の Set }。
 * 締まりは各行の取り込んだ日時（source_updated_at）で数え直す。日時は実績と同じ書き込みで B-1 が残すので、実績の値とずれない
 * （PROCESS_STATUS の B-1 の日時は別の書き込みで、取り込みの後に失敗や別の操作があると実績とずれうる）。
 * 印（actual_closed_flag）は取り込んだときの決まりで付いたもの（2026-10-07 より前は取り込んだ日の暦だけで closed にしていた）なので、
 * 印が closed でも数え直して締まっていなければ締まっていない。印が open・0 の行も締まっていない。
 * 月の行が 1 つでも締まっていなければ、その月は締まっていない
 */
function closedActualMonthsOf_(rows) {
  const byKey = new Map();
  const byYm = new Map();
  (rows || []).forEach(r => {
    const ym = ymKey_(r[3]);
    if (!/^\d{4}\/\d{2}$/.test(ym)) return;
    const flag = String(r[5] === null || r[5] === undefined ? '' : r[5]).trim().toLowerCase();
    const ok = flag !== 'open' && flag !== '0' && isActualMonthClosed_(ym, r[6]);
    const key = [normalizeClientName_(r[0]), ym].join('|');
    byKey.set(key, (byKey.has(key) ? byKey.get(key) : true) && ok);
    byYm.set(ym, (byYm.has(ym) ? byYm.get(ym) : true) && ok);
  });
  const pick = m => new Set(Array.from(m.keys()).filter(k => m.get(k)));
  return { keys: pick(byKey), months: pick(byYm) };
}

/** ブックの実績の締まった月（'client|yyyy/MM' の Set）。ACTUAL_EVAL_MONTHLY が無いブックは null（読む側は検証の版だけで判断する） */
function readClosedActualMonths_(ss) {
  const sh = ss.getSheetByName(SHEETS.ACTUAL_EVAL_MONTHLY);
  if (!sh) return null;
  return closedActualMonthsOf_(sh.getLastRow() >= 2 ? sh.getDataRange().getValues().slice(1) : []).keys;
}

/**
 * EVAL_LOG の行が、今の決まりで測った行か（D4〜D6）: 今の検証の版で B-2 が書いた行で、今も実績の締まった月（closedKeys が null なら版だけで判断）。
 * 前の版の行（締まっていない月の途中の売上や、月が始まった後の予測で測った行）は消さずに残っているので、ここで外す
 */
function isEvalLogRowCurrent_(row, idx, closedKeys) {
  if (!row || !idx || idx.evaluation_policy_version === undefined || idx.client === undefined || idx.target_month === undefined) return false;
  if (String(row[idx.evaluation_policy_version] || '').trim() !== EVALUATION_POLICY_VERSION) return false;
  return !closedKeys || closedKeys.has([normalizeClientName_(row[idx.client]), ymKey_(row[idx.target_month])].join('|'));
}

/** クライアントの、今の決まりで測った月（EVAL_LOG の中立の行が isEvalLogRowCurrent_ の月。'yyyy/MM' の Set）。B-3・B-4 が検証の表を読むときに使う */
function readCurrentEvalMonths_(ss, client) {
  const out = new Set();
  const sh = ss.getSheetByName(SHEETS.EVAL_LOG);
  if (!sh || sh.getLastRow() < 2) return out;
  const vals = sh.getDataRange().getValues();
  const idx = headerIndexMap_(vals[0] || []);
  if (idx.scenario === undefined) return out;
  const closed = readClosedActualMonths_(ss);
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    if (!isSameClient_(r[idx.client], client) || String(r[idx.scenario] || '') !== 'neutral') continue;
    if (isEvalLogRowCurrent_(r, idx, closed)) out.add(ymKey_(r[idx.target_month]));
  }
  return out;
}

/**
 * 予測の記録（AI_IMPACT_HISTORY・SUBJECTIVE_IMPACT_HISTORY）の行のうち、月ごとに、その月が始まる前の最後の回（D6）の行だけを返す（C-1 の当たり）。
 * 回は run_id で分ける（無ければ run_at）。予測した日時（run_at）が読めない回・月が始まった後の回は使わない
 */
function keepPreMonthRunRows_(rows, idx) {
  if (!idx || idx.run_at === undefined || idx.target_month === undefined) return [];
  const runKey = r => (idx.run_id !== undefined && String(r[idx.run_id] || '').trim()) ? 'id:' + String(r[idx.run_id]).trim() : 'at:' + evalTimeMs_(r[idx.run_at]);
  const best = new Map();   // ym → { ms, seq, run }
  (rows || []).forEach((r, seq) => {
    const ym = ymKey_(r[idx.target_month]);
    if (!ym || !isRunBeforeMonth_(r[idx.run_at], ym)) return;
    const ms = evalTimeMs_(r[idx.run_at]);
    const prev = best.get(ym);
    if (!prev || ms > prev.ms || (ms === prev.ms && seq > prev.seq)) best.set(ym, { ms: ms, seq: seq, run: runKey(r) });
  });
  return (rows || []).filter(r => {
    const ym = ymKey_(r[idx.target_month]);
    const b = best.get(ym);
    return !!b && isRunBeforeMonth_(r[idx.run_at], ym) && runKey(r) === b.run;
  });
}

/**
 * 検証に使う FORECAST_SNAPSHOT の行を選ぶ（クライアント × 月ごとに、1 回の予測 = snapshot_id の行をまとめて）。
 * その月が始まる前（予測した日 run_date < 月の 1 日。日本の暦）の回だけを使う（D6・2026-10-07）。月が始まった後の回は、
 * その月の途中の売上や実績を見た後の予測なので測らない。
 * 実績の締まった月の記録も使わない（月が始まる前の回には無いはずだが、念のため残す）:
 *   - key_factors_json の forecast_source が actual_closed の行（2026-10-04 から記録）
 *   - それより前の行で forecast_source が無いものは、P50 が実績とまったく同じ回（締まった後に予測し直して、実績に置き換わった回）
 * 使える回のうち、一番新しい回（予測した日時が同じならシートの下の行）の行だけを返す。使える回が無い月は検証しない。
 * snapRows: FORECAST_SNAPSHOT の行（見出しを除く）、actualMap: client|ym → 実績の合計、
 * stats（省略可）: noPreMonth に、予測の回はあるのに月が始まる前の使える回が無い client|ym を入れる
 */
function selectEvalSnapshotRows_(snapRows, actualMap, stats) {
  const groups = new Map();   // client|ym → [{ sid, rows, closed, ms, seq }]（シートの順）
  const late = new Set();     // 月が始まった後の回がある client|ym
  snapRows.forEach(r => {
    const ym = ymKey_(r[3]);
    if (!ym) return;
    const key = [normalizeClientName_(r[2]), ym].join('|');
    if (!isRunBeforeMonth_(r[1], ym)) { late.add(key); return; }
    const sid = String(r[0] || '');
    if (!groups.has(key)) groups.set(key, []);
    const list = groups.get(key);
    let g = list.length && list[list.length - 1].sid === sid ? list[list.length - 1] : null;
    if (!g) { g = { sid: sid, rows: [], closed: false, ms: evalTimeMs_(r[1]), seq: list.length }; list.push(g); }
    g.rows.push(r);
    let source = '';
    try { source = String((JSON.parse(String(r[12] || '{}')) || {}).forecast_source || ''); } catch (e) { source = ''; }
    if (source === 'actual_closed') g.closed = true;
    if (!source && String(r[4] || '') === 'neutral') {
      const act = actualMap ? actualMap.get(key) : undefined;
      const pred = Number(r[9]);
      if (act !== undefined && act !== null && isFinite(pred) && Math.abs(pred - Number(act)) < 1e-6) g.closed = true;
    }
  });
  const out = [];
  const used = new Set();
  groups.forEach((list, key) => {
    let best = null;
    list.forEach(g => { if (!g.closed && (!best || g.ms > best.ms || (g.ms === best.ms && g.seq > best.seq))) best = g; });
    if (!best) return;
    used.add(key);
    best.rows.forEach(r => out.push(r));
  });
  if (stats) stats.noPreMonth = Array.from(late).filter(k => !used.has(k));
  return out;
}

/**
 * 実績確定後の検証ステップ。
 * - B-1の後に実行することで EVAL_LOG が更新される
 * - Phase移行判断に使うKPI（sMAPE等）の元データを蓄積する
 * - 測るのは実績の締まった月（D5）だけで、その月が始まる前の最後の予測で測る（D6）。締まっていない月・月が始まる前の予測が無い月は
 *   EVAL_LOG に書かない（前の版で書いた行は消さずに残る。読む側は検証の版で外す）。数は RUN_LOG に残す（2026-10-07）
 */
function updatePhase1EvaluationReport() {
  requireStepSuccess_('step2_status', '先にB-1 検証用に実績データを取り込み を実行してください。');
  requireStepSuccess_('step4_status', '先にA-9 予測実行を実行してください。');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const actual = ss.getSheetByName(SHEETS.ACTUAL_EVAL_MONTHLY).getDataRange().getValues().slice(1);
  const snapAll = ss.getSheetByName(SHEETS.FORECAST_SNAPSHOT).getDataRange().getValues().slice(1);
  const mapA = new Map();
  actual.forEach(r=>{
    const k = [normalizeClientName_(r[0]), ymKey_(r[3])].join('|');
    mapA.set(k, (mapA.get(k) || 0) + Number(r[4] || 0));
  });
  // 実績の締まった月（D5）。締まっていない月の実績は途中の売上なので測らない（D4）
  const closed = closedActualMonthsOf_(actual).keys;
  // 月ごとに、その月が始まる前の最後の予測だけを使う（D6。締まった月の記録は予測 = 実績なので、検証と学習に入れると誤差 0 になる）
  const selStats = {};
  const snap = selectEvalSnapshotRows_(snapAll, mapA, selStats);
  const p10Map = new Map();
  const p50Map = new Map();
  const p90Map = new Map();
  snap.forEach(r => {
    const ym = ymKey_(r[3]);
    const key = [normalizeClientName_(r[2]), ym].join('|');   // クライアントごとに引く
    const sc = String(r[4] || '');
    const pred = Number(r[9] || 0);
    if (!ym || !isFinite(pred)) return;
    if (sc === 'nega') p10Map.set(key, pred);
    if (sc === 'neutral') p50Map.set(key, pred);
    if (sc === 'posi') p90Map.set(key, pred);
  });

  const evalRows=[];
  const openKeys = new Set();
  snap.forEach(r=>{
    const ymCanon = ymKey_(r[3]);
    const key = [normalizeClientName_(r[2]), ymCanon].join('|');
    const act = mapA.get(key);
    if (act == null) return;
    if (!closed.has(key)) { openKeys.add(key); return; }   // 締まっていない月は測らない
    const pred = Number(r[9]||0);
    const ape = act ? Math.abs(pred-act)/Math.abs(act) : '';
    const signed = pred - act;
    const absErr = Math.abs(signed);
    const scenario = String(r[4] || '');
    const role = scenario === 'neutral' ? 'P50' : (scenario === 'nega' ? 'P10' : (scenario === 'posi' ? 'P90' : ''));
    const rangeContains = (p10Map.has(key) && p90Map.has(key)) ? ((act >= p10Map.get(key) && act <= p90Map.get(key)) ? 1 : 0) : '';
    const isPlanningPoint = (scenario === 'neutral') ? 1 : 0;
    const constraintRelevant = (scenario === 'neutral') ? 1 : 0;
    evalRows.push([
      Utilities.getUuid(), new Date(), r[2], ymCanon, scenario, pred, act, ape, 0, 'model_limitation',
      role,
      isPlanningPoint,
      signed,
      absErr,
      signed > 0 ? 'over' : (signed < 0 ? 'under' : 'exact'),
      rangeContains,
      quarterLabelFromYm_(ymCanon),
      halfLabelFromYm_(ymCanon),
      fyLabelFromYm_(ymCanon),
      VERSION,
      EVALUATION_POLICY_VERSION,
      constraintRelevant
    ]);
  });
  const out = ss.getSheetByName(SHEETS.EVAL_LOG);
  const evalHeaders = ['eval_id','evaluated_at','client','target_month','scenario','pred','actual','ape','was_overridden','error_category','forecast_role','is_planning_point_estimate','signed_error','abs_error','bias_direction','range_contains_actual','quarter_label','half_label','fy_label','model_version','evaluation_policy_version','constraint_relevant_flag'];
  ensureSheetHeaders_(out, evalHeaders);
  // target_month列をテキスト化しておく（'yyyy/MM' 文字列の Date 自動変換を防ぐ）
  const evalTmColIdx = evalHeaders.indexOf('target_month') + 1;
  if (out.getMaxRows() >= 2) out.getRange(2, evalTmColIdx, out.getMaxRows() - 1, 1).setNumberFormat('@');
  const evalValues = out.getDataRange().getValues();
  const evalIdx = headerIndexMap_(evalValues[0] || evalHeaders);
  const evalRowByKey = new Map();
  for (let i = 1; i < evalValues.length; i++) {
    const key = [
      String(evalValues[i][evalIdx.client] || '').trim(),
      ymKey_(evalValues[i][evalIdx.target_month]),
      String(evalValues[i][evalIdx.scenario] || '').trim()
    ].join('|');
    if (key !== '||') evalRowByKey.set(key, i + 1);
  }
  const evalUpdatesByRowNo = new Map();
  const evalAppendsByKey = new Map();
  evalRows.forEach(row => {
    const key = [
      String(row[evalIdx.client] || '').trim(),
      ymKey_(row[evalIdx.target_month]),
      String(row[evalIdx.scenario] || '').trim()
    ].join('|');
    const rowNo = evalRowByKey.get(key);
    if (rowNo) evalUpdatesByRowNo.set(rowNo, { rowNo, row });
    else evalAppendsByKey.set(key, row);
  });
  const evalUpdates = Array.from(evalUpdatesByRowNo.values());
  const evalAppends = Array.from(evalAppendsByKey.values());
  writeContiguousRowUpdates_(out, evalUpdates, evalHeaders.length);
  if (evalAppends.length) writeRowsInChunks_(out, out.getLastRow() + 1, 1, evalAppends, 500);

  const compare = ss.getSheetByName(SHEETS.EVAL_COMPARE_MONTHLY);
  ensureSheetHeaders_(compare, ['target_month','forecast_base','forecast_spot','forecast_total','actual_base','actual_spot','actual_total','gap_total','forecast_total_p10','forecast_total_p50','forecast_total_p90','signed_error_p50','abs_error_p50','ape_p50','quarter_label','half_label','fy_label','over_flag','under_flag','range_outside_flag','note_for_investigation','planning_point_estimate_label','range_label']);
  // 月が始まる前の予測が無い月（予測の回はあるが、どれも月が始まった後）のうち、締まった実績のある月（D6 で測らない月）
  const noPreMonth = (selStats.noPreMonth || []).filter(k => closed.has(k) && mapA.has(k));
  writeEvalCompareMonthly_(compare, actual, snap, { noPreMonthYms: new Set(noPreMonth.map(k => k.split('|')[1])) });

  const scoredMonths = new Set(evalRows.filter(row => row[4] === 'neutral').map(row => [normalizeClientName_(row[2]), row[3]].join('|'))).size;
  updateProcessStatus_('step5_status','success','',evalRows.length,'');
  logRun_('updatePhase1EvaluationReport','', 'success', evalRows.length, new Date(),
    `${EVALUATION_POLICY_VERSION}: scored_months=${scoredMonths}; open_months=${openKeys.size}; no_pre_month_forecast=${noPreMonth.length}`);

  // 評価蓄積→学習の閉ループ：B-2のたびに月次ベイズ補正を自動更新
  const evalClient = String(ss.getSheetByName(SHEETS.CONFIG).getRange('B2').getValue() || '').trim();
  autoLearnAfterEvalReport_(evalClient);

  ss.setActiveSheet(compare || out);
}

/**
 * 検証の表（EVAL_COMPARE_MONTHLY）を書き直す。月ごとに 1 行（実績は取り込んだ値のまま、予測は B-2 が選んだ回）。
 * 誤差・幅の外の印・横の要約は、実績の締まった月（D5）だけで出す（2026-10-07）。締まっていない月の実績の列は消さない
 * （新アプリの着地見込みは自分の締まりの境目で読む）が、誤差の列は空にして、読む側が途中の売上を測らないようにする。
 * opts.noPreMonthYms: 月が始まる前の予測が無いので測らない月（メモの列に書く）
 */
function writeEvalCompareMonthly_(sh, actualRows, snapRows, opts) {
  if (!sh) return;
  const closedYms = closedActualMonthsOf_(actualRows).months;
  const noPreMonthYms = (opts && opts.noPreMonthYms) || new Set();

  const actualMap = new Map();
  actualRows.forEach(r => {
    const ym = ymKey_(r[3]);
    const type = String(r[1] || '').trim().toUpperCase();
    const amt = Number(r[4] || 0);
    if (!ym || !isFinite(amt)) return;
    if (!actualMap.has(ym)) actualMap.set(ym, { BASE: 0, SPOT: 0 });
    if (type === 'BASE' || type === 'SPOT') actualMap.get(ym)[type] += amt;
  });

  const p10Map = new Map();
  const p50Map = new Map();
  const p90Map = new Map();
  snapRows.forEach(r => {
    const ym = ymKey_(r[3]);
    const scenario = String(r[4] || '');
    const pred = Number(r[9] || 0);
    if (!ym || !isFinite(pred)) return;
    if (scenario === 'nega') p10Map.set(ym, pred);
    if (scenario === 'neutral') p50Map.set(ym, pred);
    if (scenario === 'posi') p90Map.set(ym, pred);
  });

  const ratio = getBaseSpotRatioFromSales_();
  const months = Array.from(new Set([...actualMap.keys(), ...p50Map.keys(), ...p10Map.keys(), ...p90Map.keys()])).sort();
  const rows = months.map(ym => {
    const hasP50 = p50Map.has(ym);
    const predTotal = hasP50 ? Number(p50Map.get(ym) || 0) : '';
    const predBase = predTotal * ratio.base;
    const predSpot = predTotal * ratio.spot;
    const act = actualMap.get(ym);
    const hasActual = !!act;
    const isClosed = hasActual && closedYms.has(ym);   // 締まった月だけ誤差を出す（D4）
    const actBase = hasActual ? act.BASE : '';
    const actSpot = hasActual ? act.SPOT : '';
    const actTotal = hasActual ? (act.BASE + act.SPOT) : '';
    const signed = (hasP50 && isClosed) ? (predTotal - actTotal) : '';
    const absErr = (signed === '') ? '' : Math.abs(signed);
    const ape = (signed === '' || !hasActual || actTotal === 0) ? '' : (absErr / Math.abs(actTotal));
    const p10 = p10Map.has(ym) ? Number(p10Map.get(ym) || 0) : '';
    const p90 = p90Map.has(ym) ? Number(p90Map.get(ym) || 0) : '';
    const rangeOutside = (isClosed && p10 !== '' && p90 !== '') ? ((actTotal < p10 || actTotal > p90) ? 1 : 0) : '';
    const note = rangeOutside === 1 ? '要追加調査（P10-P90レンジ逸脱）'
      : (hasActual && !isClosed && hasP50) ? '実績が締まっていない月（検証しない）'
        : (isClosed && !hasP50 && noPreMonthYms.has(ym)) ? '月が始まる前の予測が無い月（検証しない）' : '';
    return [
      ym, predBase, predSpot, predTotal, actBase, actSpot, actTotal, (signed === '' ? '' : -signed),
      p10, hasP50 ? predTotal : '', p90,
      signed, absErr, ape,
      quarterLabelFromYm_(ym), halfLabelFromYm_(ym), fyLabelFromYm_(ym),
      (signed !== '' && signed > 0) ? 1 : 0,
      (signed !== '' && signed < 0) ? 1 : 0,
      rangeOutside, note, PLAN_POINT_ESTIMATE_ROLE, RANGE_EXPLANATION_ROLE
    ];
  });

  sh.getRange(2, 1, Math.max(1, sh.getMaxRows() - 1), 23).clearContent();
  if (rows.length) {
    sh.getRange(2, 1, rows.length, 23).setValues(rows);
    sh.getRange(2, 2, rows.length, 10).setNumberFormat('¥#,##0');
    sh.getRange(2, 14, rows.length, 1).setNumberFormat('0.0%');
  }
  safeSetNote_(sh, 1, 9, 'forecast_total_p10（FORECAST_SNAPSHOT nega）');
  safeSetNote_(sh, 1, 10, 'forecast_total_p50（FORECAST_SNAPSHOT neutral / planning point estimate）');
  safeSetNote_(sh, 1, 11, 'forecast_total_p90（FORECAST_SNAPSHOT posi）');
  safeSetNote_(sh, 1, 12, 'signed_error_p50 = forecast_total_p50 - actual_total（正=過大予測）');
  safeSetNote_(sh, 1, 14, 'ape_p50 = abs_error_p50 / ABS(actual_total)。actual=0はblank。');
  safeSetNote_(sh, 1, 20, 'range_outside_flag = 1 if actual<P10 or actual>P90');
  safeSetNote_(sh, 1, 22, 'planning_point_estimate_label = P50');
  // 横の要約は締まった月だけ（締まっていない月は実績を空とみなして渡す。半期・四半期の見出しは今までどおり全部の行から）
  writeEvaluationSummaryBlocks_(sh, rows.map(r => (closedYms.has(r[0]) ? r : r.map((v, i) => (i === 6 ? '' : v)))));
}

function getBaseSpotRatioFromSales_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SALES_MONTHLY);
  if (!sh || sh.getLastRow() < 2) return { base: 0.5, spot: 0.5 };
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, Math.min(sh.getLastColumn(), 50)).getValues();
  let base = 0;
  let spot = 0;
  vals.forEach(r => {
    const t = String(r[0] || '').trim().toUpperCase();
    let s = 0;
    for (let i = 2; i < r.length; i++) s += Number(r[i] || 0);
    if (t === 'BASE') base += s;
    if (t === 'SPOT') spot += s;
  });
  const total = base + spot;
  if (total <= 0) return { base: 0.5, spot: 0.5 };
  return { base: base / total, spot: spot / total };
}

function computeBucketMetrics_(rows, labelKey, labelVal) {
  const scoped = rows.filter(r => String(r[labelKey] || '') === labelVal && r[9] !== '' && r[6] !== '');
  const actualDen = scoped.reduce((a, r) => a + Math.abs(Number(r[6] || 0)), 0);
  const sumPred = scoped.reduce((a, r) => a + Number(r[9] || 0), 0);
  const sumAct = scoped.reduce((a, r) => a + Number(r[6] || 0), 0);
  const sumAbs = scoped.reduce((a, r) => a + Number(r[12] || 0), 0);
  if (actualDen <= 0) {
    return { actual: '', p50: '', wape: '', bias: '', over: '', under: '', pass: 'N/A' };
  }
  const diff = sumPred - sumAct;
  return {
    actual: sumAct,
    p50: sumPred,
    wape: sumAbs / actualDen,
    bias: diff / actualDen,
    over: Math.max(diff, 0) / actualDen,
    under: Math.max(-diff, 0) / actualDen,
    pass: (sumAbs / actualDen) <= HALF_WAPE_CONSTRAINT ? 'PASS' : 'FAIL'
  };
}

function writeEvaluationSummaryBlocks_(sh, rows) {
  const startCol = 25; // Y
  sh.getRange(1, startCol, Math.max(1, sh.getMaxRows()), 12).clearContent();

  const valid = rows.filter(r => r[9] !== '' && r[6] !== '');
  const den = valid.reduce((a, r) => a + Math.abs(Number(r[6] || 0)), 0);
  const sumPred = valid.reduce((a, r) => a + Number(r[9] || 0), 0);
  const sumAct = valid.reduce((a, r) => a + Number(r[6] || 0), 0);
  const sumAbs = valid.reduce((a, r) => a + Number(r[12] || 0), 0);
  const diff = sumPred - sumAct;
  const annualAbsErrRate = den > 0 ? Math.abs(diff) / den : '';
  const annualOverRate = den > 0 ? Math.max(diff, 0) / den : '';
  const annualUnderRate = den > 0 ? Math.max(-diff, 0) / den : '';
  const annualBias = den > 0 ? diff / den : '';
  const annualPass = annualAbsErrRate === '' ? 'N/A' : (annualAbsErrRate <= ANNUAL_ABS_ERROR_CONSTRAINT ? 'PASS' : 'FAIL');
  const annualOverPass = annualOverRate === '' ? 'N/A' : (annualOverRate <= OVERFORECAST_RATE_CONSTRAINT ? 'PASS' : 'FAIL');

  sh.getRange(1, startCol, 1, 2).setValues([['年間制約サマリー', '値']]).setBackground(COLOR_HEADER).setFontWeight('bold');
  const annualRows = [
    ['annual_actual_total', den > 0 ? sumAct : ''],
    ['annual_p50_total', den > 0 ? sumPred : ''],
    ['annual_abs_error_rate', annualAbsErrRate],
    ['annual_bias_rate', annualBias],
    ['annual_overforecast_rate', annualOverRate],
    ['annual_underforecast_rate', annualUnderRate],
    ['annual_constraint_pass', annualPass],
    ['annual_overforecast_pass', annualOverPass]
  ];
  sh.getRange(2, startCol, annualRows.length, 2).setValues(annualRows);
  sh.getRange(2, startCol + 1, 2, 1).setNumberFormat('¥#,##0');
  sh.getRange(4, startCol + 1, 4, 1).setNumberFormat('0.0%');

  const halfLabels = Array.from(new Set(rows.map(r => r[15]).filter(Boolean))).sort();
  const h1Label = halfLabels.find(v => /-H1$/.test(v)) || 'H1';
  const h2Label = halfLabels.find(v => /-H2$/.test(v)) || 'H2';
  const h1v = computeBucketMetrics_(rows, 15, h1Label);
  const h2v = computeBucketMetrics_(rows, 15, h2Label);
  const halfStart = 11;
  sh.getRange(halfStart, startCol, 1, 8).setValues([['半期制約サマリー', 'actual', 'p50', 'half_wape', 'bias', 'over', 'under', 'pass']]).setBackground(COLOR_HEADER).setFontWeight('bold');
  sh.getRange(halfStart + 1, startCol, 2, 8).setValues([
    [h1Label, h1v.actual, h1v.p50, h1v.wape, h1v.bias, h1v.over, h1v.under, h1v.pass],
    [h2Label, h2v.actual, h2v.p50, h2v.wape, h2v.bias, h2v.over, h2v.under, h2v.pass]
  ]);
  sh.getRange(halfStart + 1, startCol + 1, 2, 2).setNumberFormat('¥#,##0');
  sh.getRange(halfStart + 1, startCol + 3, 2, 4).setNumberFormat('0.0%');

  const qStart = 15;
  sh.getRange(qStart, startCol, 1, 4).setValues([['Q診断サマリー', 'actual', 'p50', 'abs_error_rate']]).setBackground(COLOR_HEADER).setFontWeight('bold');
  const qLabels = ['Q1', 'Q2', 'Q3', 'Q4'];
  const fyBase = (rows.find(r => r[16]) || [])[16] || '';
  const qRows = qLabels.map(q => {
    const label = fyBase ? `${fyBase}-${q}` : q;
    const scoped = rows.filter(r => String(r[14] || '') === label && r[10] !== '' && r[6] !== '');
    const qDen = scoped.reduce((a, r) => a + Math.abs(Number(r[6] || 0)), 0);
    const qPred = scoped.reduce((a, r) => a + Number(r[9] || 0), 0);
    const qAct = scoped.reduce((a, r) => a + Number(r[6] || 0), 0);
    const rate = qDen > 0 ? Math.abs(qPred - qAct) / qDen : '';
    return [label, qDen > 0 ? qAct : '', qDen > 0 ? qPred : '', rate];
  });
  sh.getRange(qStart + 1, startCol, qRows.length, 4).setValues(qRows);
  sh.getRange(qStart + 1, startCol + 1, qRows.length, 2).setNumberFormat('¥#,##0');
  sh.getRange(qStart + 1, startCol + 3, qRows.length, 1).setNumberFormat('0.0%');

  const rangeStart = 21;
  const outsideRows = rows.filter(r => r[19] === 1).map(r => r[0]);
  sh.getRange(rangeStart, startCol, 1, 2).setValues([['レンジ逸脱サマリー', '値']]).setBackground(COLOR_HEADER).setFontWeight('bold');
  sh.getRange(rangeStart + 1, startCol, 3, 2).setValues([
    ['range_outside_count', outsideRows.length],
    ['months_outside_range', outsideRows.join(', ')],
    ['postmortem_required_count', outsideRows.length]
  ]);
  safeSetNote_(sh, 1, startCol, 'annual_abs_error_rate<=10%、annual_overforecast_rate<=5%を制約判定します。');
  safeSetNote_(sh, halfStart, startCol, 'half_wape<=12%、half_overforecast_rate<=5%を監視。Qは診断のみ。');
}

/**
 * 現場閲覧用サマリー更新。
 * - OUTPUTの理解補助（件数・更新時刻・KPI信号）を表示
 * - 詳細分析は FORECAST_SNAPSHOT / EVAL_LOG を参照
 */
function updatePhase1Dashboard() {
  requireStepSuccess_('step4_status', '先にA-9 予測実行を実行してください。');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dash = ss.getSheetByName(SHEETS.DASHBOARD);
  const cmp = ss.getSheetByName(SHEETS.EVAL_COMPARE_MONTHLY).getDataRange().getValues();
  // 今の決まりで測った月（締まった月を、月が始まる前の予測で。D4〜D6）だけ。前の版の B-2 が書いた表のままなら、測った月は無い
  const client = String(ss.getSheetByName(SHEETS.CONFIG).getRange('B2').getValue() || '').trim();
  const evalMonths = readCurrentEvalMonths_(ss, client);
  const rows = cmp.slice(1).filter(r => r[9] !== '' && r[6] !== '' && evalMonths.has(ymKey_(r[0])));
  const den = rows.reduce((a, r) => a + Math.abs(Number(r[6] || 0)), 0);
  const sumPred = rows.reduce((a, r) => a + Number(r[9] || 0), 0);
  const sumAct = rows.reduce((a, r) => a + Number(r[6] || 0), 0);
  const sumAbs = rows.reduce((a, r) => a + Number(r[12] || 0), 0);
  const annualAbs = den > 0 ? Math.abs(sumPred - sumAct) / den : '';
  const annualOver = den > 0 ? Math.max(sumPred - sumAct, 0) / den : '';
  const annualPass = annualAbs === '' ? 'N/A' : (annualAbs <= ANNUAL_ABS_ERROR_CONSTRAINT ? 'PASS' : 'FAIL');
  const annualOverPass = annualOver === '' ? 'N/A' : (annualOver <= OVERFORECAST_RATE_CONSTRAINT ? 'PASS' : 'FAIL');
  const h1Rows = rows.filter(r => /-H1$/.test(String(r[15] || '')));
  const h2Rows = rows.filter(r => /-H2$/.test(String(r[15] || '')));
  const calcHalf = (arr) => {
    const d = arr.reduce((a, r) => a + Math.abs(Number(r[6] || 0)), 0);
    if (d <= 0) return { wape: '', over: '', pass: 'N/A' };
    const a = arr.reduce((x, r) => x + Number(r[6] || 0), 0);
    const p = arr.reduce((x, r) => x + Number(r[9] || 0), 0);
    const ab = arr.reduce((x, r) => x + Number(r[12] || 0), 0);
    const over = Math.max(p - a, 0) / d;
    return { wape: ab / d, over, pass: (ab / d) <= HALF_WAPE_CONSTRAINT ? 'PASS' : 'FAIL' };
  };
  const h1 = calcHalf(h1Rows);
  const h2 = calcHalf(h2Rows);
  const outsideCount = rows.filter(r => r[19] === 1).length;
  const monthlyApeAvg = rows.length ? (rows.reduce((a, r) => a + Number(r[13] || 0), 0) / rows.length) : '';
  dash.clear();
  buildSimpleSheet_(ss, SHEETS.DASHBOARD, ['metric','value','note']);
  const metrics = [
    ['plan_point_estimate', PLAN_POINT_ESTIMATE_ROLE, '計画用単一値'],
    ['range_definition', RANGE_EXPLANATION_ROLE, '説明レンジ定義'],
    ['annual_abs_error_rate_latest', annualAbs, '年間制約 <=10%'],
    ['annual_constraint_pass', annualPass, '年間絶対誤差率判定'],
    ['annual_overforecast_rate_latest', annualOver, '年間over-forecast率 <=5%'],
    ['annual_overforecast_pass', annualOverPass, '年間over-forecast判定'],
    ['half1_wape_latest', h1.wape, '半期WAPE <=12%'],
    ['half2_wape_latest', h2.wape, '半期WAPE <=12%'],
    ['half1_constraint_pass', h1.pass, 'H1制約判定'],
    ['half2_constraint_pass', h2.pass, 'H2制約判定'],
    ['half1_overforecast_rate_latest', h1.over, 'H1 over-forecast<=5%'],
    ['half2_overforecast_rate_latest', h2.over, 'H2 over-forecast<=5%'],
    ['range_outside_count_latest', den > 0 ? outsideCount : '', 'P10-P90逸脱月数'],
    ['monthly_secondary_metric_latest', monthlyApeAvg, '月次APE平均（診断）'],
    ['dashboard_status', (annualPass === 'FAIL' || annualOverPass === 'FAIL' || h1.pass === 'FAIL' || h2.pass === 'FAIL') ? 'constraint_attention' : 'ready', '制約判定サマリー'],
    ['last_updated', new Date(), '更新日時']
  ];
  dash.getRange(2,1,metrics.length,3).setValues(metrics);
  dash.getRange(4,2,10,1).setNumberFormat('0.0%');
  safeSetNote_(dash, 2, 2, 'P50を計画値として採用。');
  safeSetNote_(dash, 3, 2, 'P10-P90は説明帯であり成功KPIではありません。');
  safeSetNote_(dash, 6, 2, 'over-forecastはforecast-actualの正側を計測。');
  updateProcessStatus_('step6_status','success','',metrics.length,'');
  logRun_('updatePhase1Dashboard','', 'success', metrics.length, new Date(), '');
  try { dash.showSheet(); } catch (e) {}
  ss.setActiveSheet(dash);
}

function updatePhase1LearningInsights() {
  requireStepSuccess_('step5_status', '先にB-2 検証レポートを更新してください。');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = ss.getSheetByName(SHEETS.CONFIG);
  const client = String(cfg.getRange('B2').getValue() || '').trim();
  const evalSh = ss.getSheetByName(SHEETS.EVAL_LOG);
  const cmp = ss.getSheetByName(SHEETS.EVAL_COMPARE_MONTHLY);
  const out = ss.getSheetByName(SHEETS.EVAL_INSIGHTS);
  ensureSheetHeaders_(out, ['evaluated_at','client','target_month','actual_total','pred_p50','diff','error_rate','insight','next_action','diagnostic_type','annual_constraint_breach','half_constraint_breach','overforecast_breach','range_breach','cause_hypothesis','cause_bucket','impacted_assumption','feedback_target_sheet','action_type','next_cycle_reflection','owner','due_date','status','review_cycle']);
  // 今の決まりで測った行だけ（D4〜D6）: 今の検証の版で B-2 が書いた、締まった月の行。前の版の行（締まっていない月の途中の売上や、
  // 月が始まった後の予測で測った行）は消さずに残っているが使わない。検証の表も同じ月だけ
  const evalValues = evalSh.getDataRange().getValues();
  const evalIdx = headerIndexMap_(evalValues[0] || []);
  const closed = readClosedActualMonths_(ss);
  const vals = evalValues.slice(1).filter(r => isSameClient_(r[2], client) && isEvalLogRowCurrent_(r, evalIdx, closed));
  const evalMonths = new Set(vals.filter(r => String(r[4] || '') === 'neutral').map(r => ymKey_(r[3])));
  const cmpRows = cmp.getDataRange().getValues().slice(1).filter(r => r[9] !== '' && r[6] !== '' && evalMonths.has(ymKey_(r[0])));
  const den = cmpRows.reduce((a, r) => a + Math.abs(Number(r[6] || 0)), 0);
  const sumPred = cmpRows.reduce((a, r) => a + Number(r[9] || 0), 0);
  const sumAct = cmpRows.reduce((a, r) => a + Number(r[6] || 0), 0);
  const sumAbs = cmpRows.reduce((a, r) => a + Number(r[12] || 0), 0);
  const annualBreach = den > 0 ? (Math.abs(sumPred - sumAct) / den > ANNUAL_ABS_ERROR_CONSTRAINT) : false;
  const annualOverBreach = den > 0 ? (Math.max(sumPred - sumAct, 0) / den > OVERFORECAST_RATE_CONSTRAINT) : false;
  const halfLabels = Array.from(new Set(cmpRows.map(r => String(r[15] || '')).filter(Boolean)));
  const halfBreach = halfLabels.some(label => {
    const scoped = cmpRows.filter(r => String(r[15] || '') === label);
    const d = scoped.reduce((a, r) => a + Math.abs(Number(r[6] || 0)), 0);
    if (d <= 0) return false;
    const wape = scoped.reduce((a, r) => a + Number(r[12] || 0), 0) / d;
    return wape > HALF_WAPE_CONSTRAINT;
  });

  const byMonth = new Map();
  vals.forEach(r => {
    const month = ymKey_(r[3]);
    const scenario = String(r[4] || '');
    const pred = Number(r[5] || 0);
    const actual = Number(r[6] || 0);
    if (!month) return;
    if (!byMonth.has(month)) byMonth.set(month, {actual: 0, p50: 0, hasP50: false});
    const obj = byMonth.get(month);
    obj.actual = Math.max(obj.actual, actual);
    if (scenario === 'neutral') {
      obj.p50 = pred;
      obj.hasP50 = true;
    }
  });

  const rows = [];
  Array.from(byMonth.keys()).sort().forEach(month => {
    const v = byMonth.get(month);
    if (!v.hasP50) return;
    const diff = v.actual - v.p50;
    const rate = (v.actual !== 0) ? (diff / Math.abs(v.actual)) : 0;
    // 検証の表の月は Sheets が日付に変えることがあるので、ymKey_ で 'yyyy/MM' にそろえて探す（2026-10-07 直し。前は日付の月を拾えず、幅の外の印が付かなかった）
    const cmpRow = cmpRows.find(x => ymKey_(x[0]) === month) || [];
    const rangeBreach = Number(cmpRow[19] || 0) === 1;
    const overBreach = Number(cmpRow[17] || 0) === 1 && Math.abs(rate) > OVERFORECAST_RATE_CONSTRAINT;
    const insight = (Math.abs(rate) < 0.1 && !rangeBreach)
      ? '予測精度は概ね良好。継続運用。'
      : (rate > 0
        ? '実績が予測超過。増加要因（スポット案件・大型失注回避等）を追加学習。'
        : '実績が予測未達。失注・延期・単価低下要因を確認。');
    const nextAction = (Math.abs(rate) < 0.1 && !rangeBreach)
      ? '現行手順を継続し、次月も同手順で検証。'
      : '追加調査 / 前提見直し / 入力項目反映 を実施。';
    rows.push([
      new Date(), client, month, v.actual, v.p50, diff, rate, insight, nextAction,
      rangeBreach ? 'range_breach' : 'monthly_diagnostic',
      annualBreach ? 1 : 0,
      halfBreach ? 1 : 0,
      (annualOverBreach || overBreach) ? 1 : 0,
      rangeBreach ? 1 : 0,
      '',
      // over_forecast = 予測 > 実績（EVAL_LOG の bias_direction・EVAL_COMPARE_MONTHLY の over_flag と同じ向き。diff = 実績 − 予測）。
      // cause_bucket は upsertEvalInsightsRows_ が毎回書き直すので、逆向きで書かれた過去の値も次の B-4 で直る
      rangeBreach ? 'range_outside' : (diff < 0 ? 'over_forecast' : 'under_forecast'),
      'CONFIG:環境前提',
      'A-3〜A-8入力シート',
      (rangeBreach || annualBreach || halfBreach || annualOverBreach || overBreach) ? 'update' : 'keep',
      (rangeBreach || annualBreach || halfBreach || annualOverBreach || overBreach) ? '次回サイクルで前提更新を反映' : '現行運用を継続',
      '',
      '',
      (rangeBreach || annualBreach || halfBreach || annualOverBreach || overBreach) ? 'open' : 'monitoring',
      /\/(03|06|09|12)$/.test(month) ? 'quarterly_full' : 'monthly_light'
    ]);
  });

  upsertEvalInsightsRows_(out, rows);
  safeSetNote_(out, 1, 10, 'diagnostic_type: monthly_diagnostic / range_breach 等。');
  safeSetNote_(out, 1, 13, 'overforecast_breach は過大予測制約違反の有無。');
  safeSetNote_(out, 1, 19, 'action_type: add/update/remove/keep の管理。');
  safeSetNote_(out, 1, 24, 'review_cycle: quarterly_full=四半期正式レビュー、monthly_light=月次軽量監視。');
  updateProcessStatus_('step7_status', 'success', client, rows.length, '');
  logRun_('updatePhase1LearningInsights', client, 'success', rows.length, new Date(), '');
  ss.setActiveSheet(out);
}

/**
 * EVAL_INSIGHTS の行に人の記入の跡があるか（新アプリの Insights.js appInsightHasHuman_ と同じ決まりに、画面からは書かない
 * 期日と影響した前提を足したもの）: 原因の仮説・担当・期日のどれかがある、状態が B-4 の入れる組（update と open・keep と monitoring）でない、
 * 対応・次回への反映が B-4 の既定値でない、影響した前提が既定値と違う
 */
function evalInsightHasHumanTrace_(v) {
  const s = i => String(v[i] === null || v[i] === undefined ? '' : v[i]).trim();
  const machineActions = ['update', 'keep'];
  const machineReflections = ['次回サイクルで前提更新を反映', '現行運用を継続'];
  // 状態は、B-4 が入れる組（update と open、keep と monitoring）でなければ人が選んだもの（対応中・済みや、見守りの月に人が選んだ未着手も）
  const machinePair = (s(18) === 'update' && s(22) === 'open') || (s(18) === 'keep' && s(22) === 'monitoring');
  return !!(s(14) || s(20) || s(21) || (s(22) && !machinePair) ||
    (s(18) && machineActions.indexOf(s(18)) < 0) || (s(19) && machineReflections.indexOf(s(19)) < 0) ||
    (s(16) && s(16) !== 'CONFIG:環境前提'));
}

/**
 * EVAL_INSIGHTS を複合キー [client, target_month] で upsert する（月は ymKey_ でそろえる）。
 * - 機械が算出する列は毎回上書き。cause_bucket も機械の列として毎回上書き（画面からは書かない）。
 * - 人が手入力する列（cause_hypothesis/impacted_assumption/action_type/next_cycle_reflection/owner/due_date/status）は、
 *   既存行に人の記入の跡（evalInsightHasHumanTrace_）があるときだけ、値の入っている列を保持する。跡が無い行は今回の判定で書き直す。
 * これにより B-4 再実行でメンバーの原因入力が消えず、既定値だけの行は判定の変化に追いつく（2026-10-07）。
 */
function upsertEvalInsightsRows_(sh, rows) {
  if (!sh) return;
  const width = 24;
  // 人手入力の保持対象列（0-index）
  const HUMAN_COLS = [14, 15, 16, 18, 19, 20, 21, 22];
  // cause_bucket は画面から書かない機械の列。毎回書き直す（向きが逆に書かれていた過去の値も、次の B-4 で直る）
  const CAUSE_BUCKET_COL = 15;
  const keyClientIdx = 1;
  const keyMonthIdx = 2;

  const last = sh.getLastRow();
  const existing = last >= 2 ? sh.getRange(2, 1, last - 1, width).getValues() : [];
  const rowByKey = new Map();
  // 月は両側とも 'yyyy/MM' に揃える（書いた 'yyyy/MM' を Sheets が日付に変えるので、そのままでは鍵が合わず行が増えていた）
  existing.forEach((r, i) => {
    const key = [
      String(r[keyClientIdx] || '').trim(),
      ymKey_(r[keyMonthIdx])
    ].join('|');
    if (key !== '|') rowByKey.set(key, { rowNo: i + 2, values: r });
  });

  const merged = (rows || []).map(row => {
    const key = [
      String(row[keyClientIdx] || '').trim(),
      ymKey_(row[keyMonthIdx])
    ].join('|');
    const prev = rowByKey.get(key);
    // 人の記入の跡がある行だけ、人手入力列の値を保持する。跡が無い行（B-4 が既定値を入れただけの行）は、今回の判定で書き直す
    // （2026-10-07 直し。前は既定値も人の記入として残したので、幅の外の印などが後から付いても対応・状態が古いままだった）
    if (prev && evalInsightHasHumanTrace_(prev.values)) {
      HUMAN_COLS.forEach(c => {
        if (c === CAUSE_BUCKET_COL) return;
        const existedVal = prev.values[c];
        const hasExisting = !(existedVal === '' || existedVal === null || existedVal === undefined);
        if (hasExisting) row[c] = existedVal;
      });
    }
    return { key, row, rowNo: prev ? prev.rowNo : 0 };
  });

  // 既存行（rowNoあり）は in-place 更新、新規行は末尾に追記
  const updates = merged.filter(m => m.rowNo > 0).map(m => ({ rowNo: m.rowNo, row: m.row }));
  const appends = merged.filter(m => m.rowNo === 0).map(m => m.row);

  writeContiguousRowUpdates_(sh, updates, width);
  if (appends.length) writeRowsInChunks_(sh, sh.getLastRow() + 1, 1, appends, 500);
}

function updateProcessStatus_(stepKey, status, targetClient, count, err) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PROCESS_STATUS);
  const vals = sh.getDataRange().getValues();
  for (let i=1;i<vals.length;i++) {
    if (vals[i][0] === stepKey) {
      sh.getRange(i+1,2,1,6).setValues([[new Date(), Session.getActiveUser().getEmail()||'unknown', status, targetClient||'', count||0, err||'']]);
      return;
    }
  }
  sh.appendRow([stepKey,new Date(),Session.getActiveUser().getEmail()||'unknown',status,targetClient||'',count||0,err||'']);
}

function readStep3aWarningSummary_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PROCESS_STATUS);
  if (!sh) return '';
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][0] || '') !== 'step3a_status') continue;
    return String(vals[i][6] || '').trim();
  }
  return '';
}

// [dev診断] 手動実行用。メニュー非掲載のため未参照に見えるが削除しないこと。

function requireStepSuccess_(stepKey, message) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PROCESS_STATUS);
  const vals = sh.getDataRange().getValues();
  const row = vals.find(r=>r[0]===stepKey);
  if (!row || row[3] !== 'success') throw new Error(message);
}

function logRun_(fn, client, status, count, startedAt, err) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.RUN_LOG);
  const end = new Date();
  const sec = Math.round((end - startedAt) / 1000);
  const params = JSON.stringify({N_SIM, SPIKE_CLIP_MIN, SPIKE_CLIP_MAX, TREND_FACTOR_MIN, TREND_FACTOR_MAX, BUILD_STAGE});
  const hash = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, `${fn}|${client}|${end.toISOString()}`));
  sh.appendRow([Utilities.getUuid(), end, Session.getActiveUser().getEmail()||'unknown', fn, client||'', status, count||0, VERSION, params, hash, sec, err||'']);
}

function safeLogRun_(fn, client, status, count, startedAt, err) {
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.RUN_LOG);
    if (sh) logRun_(fn, client, status, count, startedAt, err);
  } catch (logErr) {
    // 管理関数の本処理結果を優先し、ログ失敗では止めない
  }
}


function safeSetNote_(sh, row, col, note) {
  if (!sh || !note) return;
  sh.getRange(row, col).setNote(note);
}

function quarterLabelFromYm_(ym) {
  const dt = parseYM_(ym);
  if (!dt) return '';
  const fy = (dt.getMonth() >= 3) ? dt.getFullYear() : (dt.getFullYear() - 1);
  const q = Math.floor(((dt.getMonth() + 9) % 12) / 3) + 1;
  return `FY${fy}-Q${q}`;
}

function halfLabelFromYm_(ym) {
  const dt = parseYM_(ym);
  if (!dt) return '';
  const fy = (dt.getMonth() >= 3) ? dt.getFullYear() : (dt.getFullYear() - 1);
  const hm = ((dt.getMonth() + 9) % 12) + 1;
  return hm <= 6 ? `FY${fy}-H1` : `FY${fy}-H2`;
}

function fyLabelFromYm_(ym) {
  const dt = parseYM_(ym);
  if (!dt) return '';
  const fy = (dt.getMonth() >= 3) ? dt.getFullYear() : (dt.getFullYear() - 1);
  return `FY${fy}`;
}

function parseYM_(s) {
  const m = String(s||'').match(/^(\d{4})\/(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2])-1, 1);
}

/**
 * Date型・文字列型の両方から「その月の1日」のDateオブジェクトを返す。
 * - Date型: そのまま月初に変換
 * - 文字列 "YYYY/MM": パースして月初に変換
 * - それ以外: null
 */
function toMonthStart_(v) {
  if (!v) return null;

  // Date型の場合（Sheetsが自動変換した場合）。instanceof は realm を跨ぐと偽になるため
  // getTime の存在でも判定する（テスト用 sandbox / 将来の値橋渡し対策）
  const isDateLike = (v instanceof Date) || Object.prototype.toString.call(v) === '[object Date]' || (v && typeof v.getTime === 'function');
  if (isDateLike && isFinite(v.getTime())) {
    return new Date(v.getFullYear(), v.getMonth(), 1);
  }

  // 文字列の場合
  const s = String(v).trim();
  if (!s) return null;

  // "YYYY/MM" 形式
  const m1 = s.match(/^(\d{4})\/(\d{1,2})$/);
  if (m1) return new Date(Number(m1[1]), Number(m1[2]) - 1, 1);

  // "YYYY-MM" 形式
  const m2 = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m2) return new Date(Number(m2[1]), Number(m2[2]) - 1, 1);

  // "YYYY/MM/DD" 形式（日を無視して月初に）
  const m3 = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-]\d{1,2}/);
  if (m3) return new Date(Number(m3[1]), Number(m3[2]) - 1, 1);

  return null;
}

/**
 * シートから読んだ target_month を正規の 'yyyy/MM' キーに揃える。
 * Sheetsが文字列 'yyyy/MM' を書き込み時に自動でDate変換した場合（列書式が自動）でも、
 * 文字列のまま残った場合でも、結合キーが一致するようにする。
 * 認識できない値は trim した文字列をそのまま返す（空判定の破壊を避けるため）。
 */
function ymKey_(v) {
  const ms = toMonthStart_(v);
  return ms ? fmtYM_(ms) : String(v || '').trim();
}


function clearAllTabColors_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.getSheets().forEach(sh => { try { sh.setTabColor(null); } catch (e) {} });
}

function hideNonUserSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const userVisible = new Set([
    SHEETS.GUIDE,
    SHEETS.CONFIG,
    SHEETS.SALES_INPUT,
    SHEETS.SALES_MONTHLY,
    SHEETS.AI_RESEARCH,
    SHEETS.PRODUCT,
    SHEETS.CLIENT,
    SHEETS.OPINIONS,
    SHEETS.DEV_SPOT,
    SHEETS.OUTPUT
  ]);

  ss.getSheets().forEach(sh => {
    const name = sh.getName();
    try {
      if (userVisible.has(name)) sh.showSheet();
      else sh.hideSheet();
    } catch (e) {
      // フィルタビュー中などで失敗しても処理継続
    }
  });
}


function setGuideLinkTable_(guideSheet, startRow, links) {
  const colorByLabel = {
    '自動入力用': '#d9e8fb',
    'ユーザ入力用': '#fff2cc',
    '出力用': '#f4cccc',
    '事後検証用': '#d9ead3'
  };
  links.forEach((item, i) => {
    const row = startRow + i;
    const target = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(item[1]);
    guideSheet.getRange(row, 1).setValue(item[0]);
    if (target) {
      const formula = `=HYPERLINK("#gid=${target.getSheetId()}", "${item[1]}")`;
      guideSheet.getRange(row, 2).setFormula(formula);
    } else {
      guideSheet.getRange(row, 2).setValue(item[1]);
    }
    guideSheet.getRange(row, 3).setValue(item[2]);
    if (colorByLabel[item[0]]) guideSheet.getRange(row, 1, 1, 3).setBackground(colorByLabel[item[0]]);
  });
}

function syncSalesFromSalesInput_(fy, client) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const inSh = ss.getSheetByName(SHEETS.SALES_INPUT);
  const sales = ss.getSheetByName(SHEETS.SALES_MONTHLY);
  if (!inSh || !sales) throw new Error('SALES_INPUT または SALES_MONTHLY がありません。');

  const start = new Date(fy - 4, 3, 1);
  const totalMonths = 48;
  const vals = inSh.getDataRange().getValues().slice(1);
  const map = new Map();
  vals.forEach(r => {
    const c = String(r[0] || '').trim();
    const p = String(r[1] || '').trim();
    const ym = toMonthStart_(r[3]);
    const amt = Number(r[4] || 0);
    if (!c || !p || !ym || !isFinite(amt) || !isSameClient_(c, client)) return;
    if (p !== 'BASE' && p !== 'SPOT') return;
    const idx = monthIndexFromStart_(ym, start);
    if (idx < 0 || idx >= totalMonths) return;
    if (!map.has(p)) map.set(p, new Array(totalMonths).fill(0));
    map.get(p)[idx] += amt;
  });

  buildSALES_();
  const headerMonths = [];
  for (let i = 0; i < totalMonths; i++) headerMonths.push(fmtYM_(addMonths_(start, i)));
  sales.getRange(1, 1).setValue('Category');
  sales.getRange(1, 2, 1, totalMonths).setValues([headerMonths]);

  const names = ['BASE', 'SPOT'];
  const out = names.map(n => [n, ...(map.get(n) || new Array(totalMonths).fill(0))]);
  const totalRow = ['TOTAL', ...new Array(totalMonths).fill(0).map((_, i) => Number((map.get('BASE') || [])[i] || 0) + Number((map.get('SPOT') || [])[i] || 0))];

  sales.getRange(2,1,Math.max(1,sales.getMaxRows()-1),1+totalMonths).clearContent();
  const allRows = [...out, totalRow];
  sales.getRange(2,1,allRows.length,1+totalMonths).setValues(allRows);
  sales.getRange(2,2,allRows.length,totalMonths).setNumberFormat('#,##0');
  sales.getRange(2,2,2,totalMonths).setBackground(COLOR_OBJECTIVE);
  sales.getRange(4,1,1,1+totalMonths).setBackground('#eeeeee').setFontWeight('bold');
}

/**
 * HOW TO TEST (v1.6)
 * 1) A-1 初期セットアップで6新シート作成を確認（QUARTERLY_REVIEWのみ表示、他5枚は非表示）。
 * 2) A-9 を実行し AI_SCORE_HISTORY に4行、AI_IMPACT_HISTORY に12行追記されることを確認。
 * 3) A-9 を複数回実行し、上書きでなく履歴が累積することを確認。
 * 4) FORECAST_SNAPSHOT 末尾に calibration_applied_json が保存されることを確認。
 * 5) OUTPUT上部に「適用中の四半期チューニング」表示（初回はなし）が出ることを確認。
 * 6) 実績3か月未満で C-1 実行時、提案ゼロ・ログ未追記・期間不足ダイアログで正常終了することを確認。
 * 7) 実績3か月以上で C-1 実行時、QUARTERLY_REVIEW 表示と QUARTERLY_REVIEW_LOG 追記（保留/applied=0）を確認。
 * 8) 同一四半期で C-1 再実行時、review_id が新規で履歴追記されることを確認。
 * 9) QUARTERLY_REVIEW Section5 の承認列プルダウン（承認/却下/保留）を確認。
 * 10) 承認列空欄で C-2 実行時、保留扱いで記録されることを確認。
 * 11) 承認行のみ CALIBRATION_STATE に反映され、LOG の applied/applied_at が更新されることを確認。
 * 12) 同じ review_id で C-2 を再実行すると早期終了することを確認。
 * 13) auto_update_enabled=0 で C-2 実行時、CALIBRATION_STATE は不変で LOG だけ更新されることを確認。
 * 14) C-3 で QUARTERLY_REVIEW_LOG が表示され、履歴閲覧トーストが出ることを確認。
 * 15) CALIBRATION_STATE を手動編集して A-9 実行時、手動値が予測に反映されることを確認。
 * 16) ai_topic_disable_json を設定して A-9 実行時、該当topicが0点かつ AI_IMPACT_HISTORY に反映されることを確認。
 * 17) GUIDEのA/B/C行で同一グループは同一背景色（A=青/B=緑/C=緑）で統一されていることを確認。
 * 18) GUIDEの「シート分類」表で同一分類が連続配置され、色分けが分類と一致していることを確認。
 * 19) GUIDEの因果経路フローチャート本文に不要なグレー塗りが無いことを確認。
 * 20) CONFIGで担当者入力はA4/B4のみで、B10に互換用参照（=B4）が作られないことを確認。
 * 21) Gem出力の confidence 列に整数「4」を入れて A-9 実行時、coercion detail の conf15 が計上されることを確認。
 * 22) Gem出力の relative_percentile を空欄＋relative_position_label のみで投入し、label逆引き補完が動くことを確認。
 * 23) Gem出力の benchmark_quality に \"4\" を入れて A-9 実行時、coercion detail の quality が計上されることを確認。
 * 24) Gem event 行のタブ不足TSVで A-9 実行時、coercion detail の colcount が増え、半分未満行のみinvalidになることを確認。
 * 25) AI_RESEARCH!G列に tsv_diagnostics が出力され、各行のタブ数/topic が確認できることを確認。
 * 26) RELIABILITY_APPLY_ENABLED 既定=1。SOURCE_RELIABILITY 空なら、A-9 の OUTPUT が信頼度OFF時と一致（no-op）。
 * 27) A-1 で SUBJECTIVE_IMPACT_HISTORY が新規・非表示で作成され、A-9 で push 行が追記される。
 * 28) SOURCE_RELIABILITY に opinion:担当者=0.5 を手入力＋ENABLED=1 で、その担当者のopinion寄与が約半減。
 * 29) ai_topic:Market=0 を設定すると Market が kAI に寄与しない。
 * 30) DLM=off/shadow で背景SPOTが従来一致、DLM=primary かつ basis=dlm で cap が DLM BASE 比に切替、=ols で従来へ。
 * 31) 実績3か月未満で C-1 が reliability 提案を出さず正常終了。
 * 32) 実績3か月以上で reliability:* 提案が QUARTERLY_REVIEW に出て承認列が効く。
 * 33) C-2 承認で SOURCE_RELIABILITY upsert・CALIBRATION_HISTORY 追記・LOG applied=1、auto_update_enabled=0 で SOURCE_RELIABILITY 不変。
 *
 * HOW TO TEST (v1.8)
 * 1) CONFIG tuneRowsに一時ダミー行を挿入してもA-9のチューニング値が正しい（番地非依存化）。
 * 2) RELIABILITY_APPLY_ENABLED 既定=1。SOURCE_RELIABILITY 空ならA-9結果は信頼度OFF時と一致（no-op）。
 * 3) SOURCE_RELIABILITY に ai_topic:Market=0.5 → OUTPUTに内訳表示、kAI寄与が半減。
 * 4) 3か月分の neutral 実績が揃った状態でC-1 → reliability:* 提案が出る。
 * 5) EVAL_LOG等のヘッダ列順を入替えてもC-1突合が壊れない（idx参照化）。
 * 6) is_planning_point_estimate と constraint_relevant_flag を別変数で定義しても従来と同じ値が入る。
 *
 * HOW TO TEST (v1.8.1)
 * 1) PRODUCT に複数製品の中程度Step（例: 各 +25%、単体は30%未満）を入れ、構成比加重で kProd全体が大きくなる状態で A-9 を実行 → kTotal の警告/ブロックが出ることを確認。
 * 2) 単一製品で ±50% 超 → 従来どおり findFirstExtremeStepIssue_ のStep警告が出ることを確認（回帰なし）。
 * 3) A-1 初期セットアップ実行後、タブ並びが意図順（重複なし）になることを確認。
 * 4) validateOutputLayout_ を手動実行し、aiScoreLabels/aiScoreValues が Market/Competitor/Channel/DX を正しく拾うことを Logger で確認。
 * 5) 既存のB-2出力でサマリー値（年間/半期/Q）が従来と一致することを確認（回帰なし）。
 *
 * HOW TO TEST (step 3c-3c-1)
 * 1) A-1 初期セットアップで RELIABILITY_EVIDENCE が作成され、内部色・非表示になることを確認。
 * 2) 実績3か月（neutral）が揃った状態で C-1 を実行 → RELIABILITY_EVIDENCE に source_type:source_key ごとの行が出る。提案化されない安定ソース（変化<MIN_CHANGE）も n>=1 なら必ず記録されることを確認（QUARTERLY_REVIEW_LOG とは別に全件残る）。
 * 3) 同じ四半期で C-1 を再実行 → 行が重複せず上書きされることを確認（upsert）。
 * 4) C-1 前後で A-9 を実行し、計画値（OUTPUT の P10/P50/P90）が変わらないことを確認。
 * 5) generateReliabilityProposals_ の提案結果がリファクタ前と一致することを確認（回帰なし）。
 * 6) 実績3か月未満で C-1 → 期間不足で正常終了し、RELIABILITY_EVIDENCE に書かれないことを確認。
 *
 * HOW TO TEST (v1.9 cross-book pool)
 * 1) ハブbookで adminSetupPoolHub を実行 → POOL_REGISTRY / POOL_AGGREGATION_LOG / POOL_PRIOR が作成される。
 * 2) REGISTRY に2冊以上の client book の book_id を enabled=1 で登録。各bookは事前にC-1実行済みで RELIABILITY_EVIDENCE に行があること。
 * 3) adminAggregatePoolPriorAcrossBooks を実行 → POOL_AGGREGATION_LOG に per-book 行（ok/除外）と per-scope 行（written/理由/pooled_value）が1 run_id で記録される。
 * 4) ハブbookの POOL_PRIOR に reliability:{source_type} 行が upsert され、pooled_value=clamp(2*Σhit/Σn,R_MIN,R_MAX)、precision=SHRINKAGE_K、n_clients が入ること。
 * 5) 登録した各 client book の POOL_PRIOR にも同値が fan-out されていること（full overwrite）。
 * 6) 判断2：あるsource_typeの寄与クライアントが1冊だけ → そのscopeは written=false / reason=min_clients で POOL_PRIOR に書かれない（空のまま）こと。
 * 7) 判断4：REGISTRY に無効な book_id（権限なし/存在しない）を1行入れて実行 → その行は status=excluded でログに残り、他bookの集約と fan-out は正常完了すること（全体が止まらない）。
 * 8) no-op：POOL_PRIOR が書かれた直後でも、各bookで A-9（予測）の OUTPUT P10/P50/P90 が集約前と変わらないこと（POOL_PRIOR は提案の収縮に効くだけで、予測値そのものは変えない）。
 * 9) C-1への波及：集約後に client book で C-1 を実行すると、generateReliabilityProposals_ の rShrunk が pooled_value 方向へ収縮した提案になること（POOL_PRIOR 反映前後で提案値が変化）。
 * 10) 二重適用耐性：adminAggregatePoolPriorAcrossBooks を続けて2回実行しても POOL_PRIOR は重複行を作らず upsert されること。
 * 11) VERSION='2.3.11-dev' / BUILD_STAGE='v8-a9-toast-fix' であること。
 *
 * HOW TO TEST (annual-forecast-mode)
 * 1) CONFIG の FORECAST_CLOSED_MONTH_MODE 既定が 'actual'。A-9 の OUTPUT 月次で、closed月は実績・open月は予測になる（従来どおり）。
 * 2) FORECAST_CLOSED_MONTH_MODE='forecast' に変更しA-9 → closed月も予測のまま表示され、混合セクションに通年予測の注記＋「本命」ラベルが出る。
 * 3) どちらのモードでも、年度合計(P10/P50/P90)は12ヶ月すべての予測simから算出される（経過実績で固定されない）。
 * 4) actual モードのOUTPUT row6に「年度合計は通年予測（着地ではない）」旨の注記が表示される。
 * 5) モード切替の前後で、quantOnly / mixed の予測計算自体は不変（年度合計の算出式を変えていない）。
 */

/**
 * HOW TO TEST (vertex-only)
 * 1) A-1 後、CONFIG に VERTEX_PROJECT_ID=forecast-agent-498907 / LOCATION=global /
 *    GEMINI_MODEL=gemini-3.8-flash が入り、DATASTORE_ID/SEARCH_LOCATION は空、AI_RESEARCH_ENABLED=1。
 * 2) その状態で A-4 → web-only で Vertex が走り AI_RESEARCH_STRUCTURED が更新される（手動貼付トーストは出ない）。
 *    AI_RESEARCH_TASK_LOG の aspect=web 行は success、aspect=rag 行は status=skipped。
 * 3) VERTEX_GEMINI_MODEL を空にして A-4 → 「Vertex の必須設定が未入力」エラーで止まる（手動へ落ちない）。
 * 4) AI_RESEARCH_ENABLED=0 で A-4 → 「無効」メッセージで何もせず終了。
 * 5) A-9 → 手動 parse を呼ばず、A-4 が書いた AI_RESEARCH_STRUCTURED の行をそのまま使う。
 *    AI_RESEARCH_STRUCTURED が空でも A-9 は完走（AIスコアは中立=0）。
 * 6) DATASTORE_ID/SEARCH_LOCATION を埋めると ragReady=true で RAG も実行される。
 */

/**
 * HOW TO TEST (ai-summary-view)
 * 1) VERSION='2.3.11-dev' / BUILD_STAGE='v8-a9-toast-fix' であること。
 * 2) A-1 初期セットアップ後、AI_RESEARCH が SALES_MONTHLY の右隣に表示され、
 *    AI_RESEARCH_STRUCTURED / TASK_LOG / WEB / EXTERNAL は非表示であること。
 * 3) A-1 直後の AI_RESEARCH は段0タイトル＋「未実行」ガイドのみであること。
 * 4) A-2 → A-4（Vertex成功）後、AI_RESEARCH に ①要約文 ②4軸スコア ③event/benchmark明細 の3段が描画されること。
 * 5) report_text が全topic空でも、②③が描画され、①は「要約文が取得できませんでした」になること（フェイルセーフ）。
 * 6) A-4 を2回実行しても AI_RESEARCH が追記されず再描画（重複しない）であること。
 * 7) ②のFinal Scoreが、同一runのOUTPUT 4軸スコア（readAIResearchScores_）と一致すること。
 * 8) A-4失敗（outRows空）時、AI_RESEARCH は前回内容を保持し、上書きされないこと。
 * 9) A-9（予測）の OUTPUT P10/P50/P90 が本変更の前後で不変であること（予測コア無変更）。
 */

/**
 * HOW TO TEST (objonly-dealias)
 * 1) VERSION='2.3.11-dev' / BUILD_STAGE='v8-a9-toast-fix' であること。
 * 2) off/shadow モードで A-9 を実行し、OUTPUT の P10/P50/P90（混合・客観のみ両セクション）が
 *    本修正の前後で不変であること（actual_closed 月が立たない現行データフローでは挙動中立）。
 * 3) runForecastFYCore_ の objOnly が quantOnly と別オブジェクトであること（配列を共有しない）。
 *    objOnly の配列要素を書き換えても result.quantOnly / result.opsQuantOnly の配列が変化しないこと。
 * 4) DLM shadow セクションの「参考:旧Ops_BASE(定量)P50」列が opsQuantOnly 由来で、
 *    closedMonthMode='actual' 経路から独立していること（巻き込み変異が起きない）。
 * 5) KPIブロック（定量寄与率等）が quantOnly 由来で、objOnly の上書きから独立していること。
 */

/**
 * HOW TO TEST (gem-path-removal)
 * 1) VERSION='2.3.11-dev' / BUILD_STAGE='v8-a9-toast-fix' であること。
 * 2) grep で generateAIResearchTemplate / parseAIResearchPaste_ / showPromptPreviewDialog_ /
 *    buildAiParseWarningText_ / pushInvalidSample_ がコード中に1件も残っていないこと（定義・参照とも0件）。
 * 3) A-4（runVertexAIResearch）が従来どおり動作し、AI_RESEARCH_STRUCTURED と AI_RESEARCH サマリービューが更新されること。
 * 4) A-9（runPhase1Forecast）が完走し、OUTPUT の P10/P50/P90 が本削除の前後で不変であること。
 * 5) readAIReportTextForClient_ / extractReportSection_ / diagnoseLastAIParse_ / countAIResearchStructuredRows_ が残存し、参照が壊れていないこと。
 * 6) buildVertexStructuredRows_ / readAIResearchScores_ が使う parseAi* / normalizeAi* /
 *    coerceBenchmarkQuality_ / inferPercentileFromLabel_ / clampFinite_ が残存していること。
 */

/**
 * HOW TO TEST (a9-toast-fix)
 * 1) VERSION='2.3.11-dev' / BUILD_STAGE='v8-a9-toast-fix' であること。
 * 2) A-9（予測を実行）を実行し、旧モード名トーストが出ないこと。
 * 3) AIスコアが全topic 0.0 のときは「⚠ AIスコアが全topicで0.0です...」トーストが従来どおり出ること（維持確認）。
 * 4) RUN_LOG の最新 runPhase1Forecast 行の error_summary が `ai_rows=...;ai_warn=;...` 形式で、
 *    productWeightWarning がある場合は末尾に `;prodw=...` が付くこと。
 * 5) A-9 の OUTPUT の P10/P50/P90 が本修正の前後で不変であること（予測コア無変更）。
 */

/**
 * HOW TO TEST (snapshot-vestigial-removal)
 * 1) VERSION='2.3.12-dev' / BUILD_STAGE='v8-snapshot-vestigial-removal'、DLM_BUILD_STAGE 不変。
 * 2) A-1 初期セットアップ後、FORECAST_SNAPSHOT のヘッダが15列で、linear_pred/robust_pred/regime_pred/
 *    simulation_pred/w1〜w4 が無いこと。
 * 3) A-9 実行後、FORECAST_SNAPSHOT に15列で書き込まれ、final_pred が J列（index 9）にあること。
 * 4) B-1→B-2 を実行し、EVAL_LOG / EVAL_COMPARE_MONTHLY の値が撤去前と一致すること（final_pred を r[9] で拾えている）。
 * 5) OUTPUT の P10/P50/P90 が撤去前と不変であること。
 * 6) A-1 で別クライアント名に切り替えたとき detectResidualClientData_ の残存検知が従来どおり動くこと（header参照のため不変）。
 */

/**
 * HOW TO TEST (config-simplify)
 * 1) VERSION='2.3.13-dev' / BUILD_STAGE='v8-config-simplify'、DLM_BUILD_STAGE 不変。
 * 2) A-1 初期セットアップ後、CONFIG 上段に「[互換] 担当者（B10）」行が無く、B10 セルが空（数式なし）であること。
 * 3) A-1 で担当者を入力 → B4 に保存され、A-5〜A-8 / A-9 の担当者必須チェックが従来どおり通ること。
 * 4) CONFIG の環境前提・ポリシー・チューニング・補足・フローチャート・フッタの各セクションが
 *    行ズレ/重なり無く描画されること（envStart=14 追従の確認）。
 * 5) チューニング表に QUAL_SUBJECTIVE_MAX_SCALE 行が無いこと。QUAL_SUBJECTIVE_MONTHLY_CAP /
 *    QUAL_CALIBRATION_ENABLED は残存し、A-9 で従来どおり参照されること。
 * 6) OUTPUT の P10/P50/P90 が撤去前と不変であること。
 */

/**
 * HOW TO TEST (config-deadknob-removal)
 * 1) VERSION='2.3.15-dev' / BUILD_STAGE='v8-config-deadknob-removal'、DLM_BUILD_STAGE 不変。
 * 2) A-1 初期セットアップ後、CONFIG チューニング表に
 *    QUAL_SHARE_ALERT_THRESHOLD / QUAL_SHARE_TARGET_CENTER/LOW/HIGH /
 *    QUARTERLY_REVIEW_PERIOD_MONTHS / BIAS_CORRECTION_* / AI_DIRECTION_HIT_* /
 *    AI_EFFECT_MIN_MEANINGFUL / DLM_FORECAST_HORIZON の各行が無いこと（SKIP分を除く）。
 * 3) A-9 実行で OUTPUT の P10/P50/P90 が撤去前と不変（予測コア無変更）。
 * 4) C-1 四半期レビューが従来どおり動作する（quarterlyReviewPeriodMonths 不使用は元から）。
 * 5) DLM=shadow/primary のバックテスト指標が撤去前と一致（dlmForecastHorizon 不使用は元から）。
 * 6) 残すべき調整キー（AI_WEIGHT / QUAL_SUBJECTIVE_MONTHLY_CAP / RELIABILITY_* /
 *    DLM_BACKTEST_MIN_MONTHS 等）が CONFIG に残っていること。
 */

/**
 * HOW TO TEST (rag-config-defaults)
 * 1) VERSION='2.3.16-dev' / BUILD_STAGE='v8-rag-config-defaults'、DLM_BUILD_STAGE 不変。
 * 2) A-1 初期セットアップ後、CONFIG の VERTEX_DATASTORE_ID='fujikeizai-portfolio-2025'、
 *    VERTEX_SEARCH_LOCATION='global'、VERTEX_SERVING_CONFIG='default_search' が既定で入っていること。
 * 3) Vertex/RAG 環境行（PROJECT_ID/LOCATION/GEMINI_MODEL/DATASTORE_ID/SEARCH_LOCATION/SERVING_CONFIG/AI_RESEARCH_ENABLED）の
 *    B列セルが黄色（#fff2cc）。文字列キーのセルはテキスト書式（@）であること。
 * 4) A-2 → A-4 を実行 → AI_RESEARCH_TASK_LOG の aspect=rag 行が status=success（skipped でない）。
 *    RAG側の生ログに応答（summary/citations）が記録される。
 * 5) VERTEX_SEARCH_LOCATION を us/eu に変更すると discoveryEngineHost_ が地域エンドポイントを生成
 *    （global のままなら従来と同一ホスト＝挙動不変）。
 * 6) VERTEX_DATASTORE_ID を空にして A-4 → ragReady=false で RAG は skipped、web-only で継続（フェイルセーフ維持）。
 * 7) A-9 の OUTPUT P10/P50/P90 が本変更の前後で不変（予測コア無変更）。
 */

/**
 * HOW TO TEST (ai-dx-confidence-diagnostics)
 * 1) VERSION='2.3.21-dev' / BUILD_STAGE='ai-dx-confidence-diagnostics'、DLM_BUILD_STAGE 不変。
 * 2) 既存データ（DX eventの confidence が空欄）で A-9 を実行 → OUTPUT の coverage 行に
 *    「DX: ... evt=0 ... / confDrop=1」が表示される。
 * 3) 同 A-9 で degraded 警告（22行目相当）に「confidence欠落でevent不採用: DX ...」の注記が出る。
 * 4) confDrop は confidence が NaN（空欄）の event候補のみ計上。confidence=0 の明示入力は計上しない
 *    （重み0だが欠落ではないため）。
 * 5) 本修正の前後で、混合/客観セクションの年度合計および月次 P10/P50/P90 が不変であること（採点不変）。
 * 6) AI_SCORE_HISTORY / AI_IMPACT_HISTORY の値が本修正の前後で不変であること。
 */

/**
 * HOW TO TEST (output-note-relocate)
 * 1) VERSION='2.3.22-dev' / BUILD_STAGE='output-note-relocate'、DLM_BUILD_STAGE 不変。
 * 2) A-9 実行後、混合セクションの「年度合計（予測）行」と「Month見出し」の間が
 *    短い1行注記（OUTPUT_RANGE_EXPLAIN_PRIMARY_SHORT_TEXT）になっていること。長い4行ブロックがここに無いこと。
 * 3) 長い説明本文（OUTPUT_RANGE_EXPLAIN_MAIN_TEXT）が、混合セクションの Scenario Split の下に
 *    目立たない灰色小フォントで表示されていること。
 * 4) 客観セクションは従来どおり：年度合計と月次の間に短い1行注記のみ、末尾に本文なし。
 * 5) 月次表・Scenario Split・チャート・Triangulation 以降の各表の数値が本修正の前後で不変であること。
 * 6) チャートが表と重ならないこと（戻り値に末尾注記分を加味済み）。次セクション開始位置が崩れないこと。
 * 7) 年度合計および月次 P10/P50/P90 が不変であること（表示位置のみの変更）。
 */

/**
 * HOW TO TEST (ai-score-robustness)
 * 1) VERSION='2.3.23-dev' / BUILD_STAGE='ai-score-robustness'、DLM_BUILD_STAGE 不変。
 * 2) CONFIG チューニング表に AI_MISSING_CONFIDENCE_DEFAULT=0.5 行が出る。
 * 3) 【A: 既存データのまま次のA-9】confidence/relative_confidence だけ空の行
 *    （例: Market event impact有/conf空, benchmark percentile有/relConf空）が不採用にならず、
 *    Market が 0 でなくなる。OUTPUT coverage 行に「Market: ... / confDefault=2」が出て、confDrop は出ない。
 * 4) AI_MISSING_CONFIDENCE_DEFAULT=0 に変更して A-9 → 従来どおり不採用（confDrop表示・該当topicは0）。既定0で従来挙動に戻ることを確認。
 * 5) 【B: A-4再実行で全行】A-4を再実行後、event_score が (impact/100)*50*conf で保存される。
 *    impact=80→大、impact=0.9→ほぼ0（従来は |0.9-50| で過大評価され約44になっていたのが解消）。
 * 6) grep で旧 event_score 算出式が 0件（event_score算出から消えている）こと。
 * 7) AI寄与率（OUTPUT）が AI_MAX_ABS_EFFECT=±3% を超えないこと（キャップ不変）。
 * 8) AI_SCORE_HISTORY / AI_IMPACT_HISTORY のスキーマ（列）は不変。
 * 9) confidence/relative_confidence を明示的に 0 で入れた行は補完されず（欠落=NaNのみ補完）、従来どおり重み0で扱われること。
 */

/**
 * HOW TO TEST (ai-score-degroundless)
 * 0) 既存bookでは CONFIG の「AI総合中立化のdead-zone閾値」セルが旧値10のまま残るため、
 *    値を 0 に手動修正するか、A-1初期セットアップでCONFIGを再生成すること（前提条件）。
 * 1) VERSION='2.3.24-dev' / BUILD_STAGE='ai-score-degroundless'、DLM_BUILD_STAGE 不変。
 * 2) CONFIG チューニング表の AI_TOTAL_NEUTRAL_THRESHOLD 既定が 0、ラベルが「…既定0=中立化なし…」。
 * 3) A-4 再実行 → RAGに相対位置の根拠が無いトピックは、AI_RESEARCH_STRUCTURED の benchmark 行で
 *    relative_percentile が空（または benchmark 行自体が出ない）になる。50/middle のプレースホルダが消える。
 * 4) 同 A-4 後 → 実在する web の動きは event 行に direction/impact 付きで残る。
 *    direction=neutral は本当に動きが無いトピックだけ（その場合 event_score は仕様上 0 のまま＝正直なゼロ）。
 * 5) A-9 → 総合スコアが小さくても kAI が dead-zone で 1.0 に潰されず、±3%キャップ内で反映される。
 *    OUTPUT 行23の「信頼度不足で中立化」バナーは、品質(coverage)由来の中立化時のみ出る（総合dead-zone由来は出ない）。
 * 6) A-9 → event_only トピックが ×0.5 の構造ペナルティを受けない（coverage由来の qualityMultiplier のみ適用）。
 * 7) 構造化 temp=0：同一 web/RAG 入力で A-4 を2回 → AI_RESEARCH_STRUCTURED の event_score/benchmark_score が
 *    ほぼ一致（web grounding 自体は live検索のため完全一致は保証しない）。
 * 8) momentum：同一 as_of の A-4 スナップショットのまま A-9 を複数回 → AI_SCORE_HISTORY 行は増えるが、
 *    momentum の lookback は as_of 単位に畳まれ、A-9回数では momentum が変動しない。
 *    A-4を再実行して as_of が変わると momentum が動く。
 * 9) ±3%キャップ不変：OUTPUT の AI寄与率が ±3% を超えない。
 * 10) honest-zero：web が真に neutral（動きなし）かつ benchmark 根拠なしのトピックは依然 0 になりうる。
 *     これは捏造しない設計どおりの正常動作（強制非ゼロにはしない）。
 * 11) 主観オーバーレイ / SPOT / DLM / 予測コア / AI_SCORE_HISTORY・AI_IMPACT_HISTORY スキーマは不変。
 */

/**
 * HOW TO TEST (calibration-blank-override-fix)
 * 0) 前提：このバグは C-1/C-2 を通していない（CALIBRATION_STATE の ai_weight_override /
 *    ai_max_abs_effect_override が空欄の）全bookで発火していた。空欄が Number('')→0→isFinite=true で
 *    「0という上書き値」として通り、aiWeight=0 / aiMaxAbsEffect=0 に化け、kAI が常に 1.0 に潰れていた。
 * 1) VERSION='2.3.25-dev' / BUILD_STAGE='calibration-blank-override-fix'、DLM_BUILD_STAGE 不変。
 * 2) CALIBRATION_STATE の ai_weight_override / ai_max_abs_effect_override が空（既定）の book で A-9 →
 *    AI_IMPACT_HISTORY の k_ai が 1.0 でなくなり（AIスコアが立っていれば 1±clamp(aiTotal×AI_WEIGHT, ±AI_MAX_ABS_EFFECT)）、
 *    OUTPUT の AI寄与率が 0% でなくなる（上限 ±AI_MAX_ABS_EFFECT=3% 内）。
 * 3) ai_weight_override に明示的に 0 を入れて A-9 → kAI=1.0（意図的にAIを止める運用は従来どおり有効）。
 *    空欄(=未設定) と 0(=明示ゼロ) が区別されることを確認。
 * 4) ai_weight_override に明示的な数値（例 0.001）を入れて A-9 → その値が CONFIG の AI_WEIGHT を上書きして効く。
 * 5) 客観のみ（objOnly / quantOnly）セクションの P10/P50/P90 が不変。SPOT / DLM / 主観（kProd/kClient/kOpinion）も不変。
 * 6) 混合セクションは AI 効果分（±3% 内）だけ変わる。これは本修正が意図した変化であり回帰ではない。
 * 7) grep で旧override finite判定が 0件、blank guard helper が applyCalibrationToTuning_ 内に
 *    1定義＋2呼び出し（計3件）だけ存在すること。
 */

/**
 * HOW TO TEST (rag-query-frame-align)
 * 1) VERSION='2.3.26-dev' / BUILD_STAGE は本ブロック名、DLM_BUILD_STAGE 不変。
 * 2) grep で旧フレームのノイズ語が 0件であること。
 * 3) RAGクエリが topic 別に日本語の展開語（市場規模/競合/MR/DX等）を返し、英語topic素語の連結でないこと。
 * 4) A-4 を再実行 → AI_RESEARCH_TASK_LOG の aspect=rag 行の note.query が新フレーム
 *    （`{client} 医薬品 市場環境 {日本語展開語}`）になっていること。
 * 5) RAGヒット内容（RAG側の summary/citations）が、対象メーカーの売上根拠ではなく
 *    外部の市場・需要環境寄りの内容に寄ること（旧ノイズ語が消える）。
 * 6) A-4 を再実行しない限り、A-9 の OUTPUT P10/P50/P90 は不変であること（本変更は A-4 側のクエリのみ）。
 * 7) A-4 再実行後は benchmark スコアが変わりうる（=意図した改善であり回帰ではない）。
 *    客観のみ（quantOnly / objOnly）の P10/P50/P90 は不変。
 * 8) ragReady=false（DATASTORE_ID/SEARCH_LOCATION 空）の場合は RAG が skipped となり本変更の影響なし
 *    （web-only フェイルセーフ維持）。
 */

/**
 * HOW TO TEST (qual-share-const-removal)
 * 1) VERSION='2.3.27-dev' / BUILD_STAGE='qual-share-const-removal'、DLM_BUILD_STAGE 不変。
 * 2) grep で QUAL_SHARE_ALERT_THRESHOLD / QUAL_SHARE_TARGET_CENTER / QUAL_SHARE_TARGET_LOW /
 *    QUAL_SHARE_TARGET_HIGH の const 定義・コード参照が0件であること（HOW TO TEST コメント中の言及を除く）。
 * 3) QUAL_SUBJECTIVE_MONTHLY_CAP / QUAL_CALIBRATION_ENABLED は残存し、A-9 で従来どおり参照されること
 *    （主観の月次cap・cap有効化トグルは不変）。
 * 4) SUBJECTIVE_OVERLAY_TARGET_CENTER / _LOW / _HIGH は残存すること
 *    （calibrateSubjectiveContinuousDelta_ が参照）。
 * 5) A-9 実行で OUTPUT の年度合計および月次 P10/P50/P90 が削除前と不変
 *    （純粋なデッドコード削除 / 予測コア無変更 / Monte Carlo の乱数揺れのみ許容）。
 * 6) CONFIG チューニング表に QUAL_SHARE 系の行が無いこと（config-deadknob-removal で除去済み・回帰なし）。
 */

/**
 * HOW TO TEST (orphan-fn-removal)
 * 1) VERSION='2.3.28-dev' / BUILD_STAGE='orphan-fn-removal'、DLM_BUILD_STAGE 不変。
 * 2) grep で削除対象2関数が定義・参照とも0件であること。
 * 3) onOpen のメニュー（A-1〜C-3）が従来どおり表示され、欠落・重複がないこと。
 * 4) A-1 初期セットアップ → A-2 → A-3 が従来どおり動作し、SALES_MONTHLY が
 *    BASE/SPOT/TOTAL の3行で48ヶ月生成されること（正規取込経路が無傷）。
 * 5) A-1 の初期設定ダイアログ冒頭に複製手順 notice が残っていること（output-display-tidy で supersede）。
 * 6) A-9 の OUTPUT の年度合計および月次 P10/P50/P90 が削除前と不変であること
 *    （予測コア無変更 / Monte Carlo の乱数揺れのみ許容）。
 * 7) スクリプトエディタの関数一覧から削除対象2関数が消えていること。
 */

/**
 * HOW TO TEST (ai-research-raw-merge)
 * 1) VERSION='2.3.29-dev' / BUILD_STAGE='ai-research-raw-merge'、DLM_BUILD_STAGE 不変。
 * 2) grep で旧raw2枚への SHEETS 参照と旧キー定義が0件であること。
 * 3) SHEETS に RAW キーが1件あり、A-4実行時の生ログ作成先が1枚だけであること。
 * 4) 既存book（旧raw2枚にデータがある状態）で clasp push 後に A-4 を実行 →
 *    旧raw2枚の行が RAW に移送され、旧タブが消えること。
 *    移送後の RAW で axis 列により 'web' 行 / 'rag' 行が区別できること。
 * 5) 続けて A-4 を再実行しても RAW に旧データが二重移送されないこと（冪等）。
 * 6) 新規bookで A-1 → A-2 → A-4 を実行 → RAW が1枚だけ作成され、
 *    web行（axis=web）と rag行（axis=rag）が同一シートに追記されること。
 * 7) A-4 のサマリービュー、構造化結果の内容、および A-9 の OUTPUT の年度合計・月次 P10/P50/P90 が
 *    本変更の前後で不変であること（生ログ格納先のみ変更 / Monte Carlo の乱数揺れのみ許容）。
 * 8) RAW が内部シートとして非表示になること。
 */

/**
 * HOW TO TEST (output-display-tidy)
 * 1) VERSION='2.3.30-dev' / BUILD_STAGE='output-display-tidy'、DLM_BUILD_STAGE 不変。
 * 2) A-1 初期設定ダイアログ冒頭の黄色 notice が表示されないこと。
 *    （orphan-fn-removal の HOW TO TEST 項目5 はこの変更で意図的に撤去・supersede とする）。
 * 3) A-9 後、OUTPUT 6行目（注記ブロック）が、エンジン/cal/製品重み等の実警告(⚠)や AI取込の実エラー
 *    （web_error/rag_error/structure_error が1以上）が無い限り黒字で表示されること。
 *    vertex_rows=...; web_error=0; rag_error=0; structure_error=0 の all-zero サマリーだけでは赤くならない。
 * 4) 実警告がある場合（DLM primary→fallback の ⚠ / productWeightWarning / cal の ⚠ /
 *    web_error|rag_error|structure_error>=1）は従来どおり赤字(#b71c1c)になること。
 * 5) OUTPUT row10「参考（補助）: 定量/主観/AI/KnownSpot 合計100%分解」テキストが E列でなく F列に表示され、
 *    E10 は空であること。NOTE も F10 に付くこと。
 * 6) OUTPUT F9/F10 の長い注記が G列以降へはみ出さず、セル内で折り返されること。
 * 7) OUTPUT 21行目（coverage）が ' | ' 一行ではなく topic ごとの改行表示になり、A〜F 幅に収まって横に伸び
 *    すぎないこと。22行目（degraded / benchmark不足）と23行目（中立化バナー）も折り返し・幅縮小で収まること。
 * 8) A-9 の年度合計および月次 P10/P50/P90 が本変更の前後で不変（表示のみの変更 / 予測コア無変更）。
 */

/**
 * HOW TO TEST (raw-migrate-header-match)
 * 1) VERSION / BUILD_STAGE='raw-migrate-header-match'、DLM_BUILD_STAGE 不変。
 * 2) grep で旧 legacyNames（位置ベース）配列・width=Math.min(...) 行・headers.map((_, i) => ...) が0件、
 *    legacySources / def.axis / legacyIdx lookup が存在すること。
 * 3) 旧 AI_RESEARCH_WEB / AI_RESEARCH_EXTERNAL を持つ既存bookで clasp push → A-4 を実行 →
 *    旧2枚が削除され、行が AI_RESEARCH_RAW へ移送される。移送後の RAW で、旧WEB由来行は axis='web'、
 *    旧EXTERNAL由来行は axis='rag' になっていること（位置ずれが起きない）。
 * 4) 旧シートのヘッダ列順が RAW と違っていても、ヘッダ名一致により client/as_of_date/topic/evidence/note が
 *    正しい列へ入ること（axis はシート名で確定）。
 * 5) 旧シートに axis 列が無い場合でも axis が空にならず、WEB→web / EXTERNAL→rag が入ること。
 *    旧シートに frozen_flag 列が無ければ 0、frozen_at 列が無ければ空で補完されること。
 * 6) A-4 を再実行しても二重移送されないこと（旧シート削除済みのため）＝冪等。
 * 7) 新規bookで A-1 → A-2 → A-4 → RAW が1枚作成され、appendAIResearchRawRow_ 経由の web/rag 行が
 *    正しい axis を持つこと（本変更の影響を受けない）。
 * 8) A-1（全上書き）では旧2枚が移送されず削除される従来挙動が不変であること。
 * 9) A-4 のサマリービュー（AI_RESEARCH）・構造化結果（AI_RESEARCH_STRUCTURED）・A-9 の OUTPUT 年度合計/
 *    月次 P10/P50/P90 が本変更の前後で不変であること（生ログ移送のみ・予測非影響）。
 */

/**
 * HOW TO TEST (dashboard-hide-insights-upsert)
 * 1) VERSION='2.3.38-dev' / BUILD_STAGE='dashboard-hide-insights-upsert'、DLM_BUILD_STAGE 不変。
 * 2) A-1 初期セットアップ後、DASHBOARD タブが非表示になっていること（GUIDE/CONFIG/SALES_INPUT/
 *    SALES_MONTHLY/AI_RESEARCH/PRODUCT/CLIENT/OPINIONS/DEV_SPOT/OUTPUT のみ表示）。
 * 3) A-9 → A-10 を実行すると DASHBOARD が表示され、アクティブシートになること（showSheet→setActiveSheet）。
 * 4) その後 A-4 を実行（hideNonUserSheets_ が走る）すると DASHBOARD が再び非表示になること。
 * 5) B-1 → B-2 → B-3 を実行し EVAL_INSIGHTS に行が生成されること。
 * 6) EVAL_INSIGHTS の任意の行で cause_hypothesis / owner / due_date / status に手入力する。
 * 7) もう一度 B-3 を実行 → 同じ [client, target_month] の行で、手入力した
 *    cause_hypothesis/owner/due_date/status が消えずに保持されること。
 * 8) 一方 actual_total / pred_p50 / diff / error_rate / 各breach flag / insight / next_action は
 *    最新の機械算出値で更新されていること。
 * 9) 手入力していない（空の）人手列には、従来どおり機械の既定値（cause_bucket等）が入ること。
 * 10) A-9 の OUTPUT 年度合計および月次 P10/P50/P90 が本変更の前後で不変であること（予測非影響）。
 */

/**
 * HOW TO TEST (spot-bg-sensitivity-down)
 * 1) VERSION='2.3.39-dev' / BUILD_STAGE='spot-bg-sensitivity-down'、DLM_BUILD_STAGE 不変。
 * 2) grep で SPOT_BG_SHRINK と 0.35 / SPOT_SPIKE_MAD_K と 2.5 の const 行が各1件。旧値(0.50/3.0)が0件。
 * 3) 新規bookで A-1 初期セットアップを実行 → CONFIG チューニング表の
 *    「SPOT_BG_SHRINK（背景SPOT縮小率）」B列が 0.35、「SPOT_SPIKE_MAD_K（SPOTスパイク判定MAD倍率）」B列が
 *    2.5 で生成されること（const 追従の確認）。
 * 4) 新規bookで A-2 → A-3 → A-9 を実行 → OUTPUT 内訳表の「背景SPOT（定量）」列が、
 *    旧既定(0.50/3.0)で出るより各月おおむね約3割小さくなること（年間でも約-30%）。
 * 5) DEV_SPOT に入力した既知SPOT（knownSpot）の月額は本変更で変わらないこと（過去トレンド側のみの調整）。
 * 6) 既存book（CONFIG セルを既に 0.35 / 2.5 へ手修正済み）では、clasp push の前後で A-9 の
 *    背景SPOT・年度合計・月次 P10/P50/P90 が不変であること（const はフォールバックのみで、
 *    既存bookは CONFIG セル値が優先されるため）。
 * 7) SPOT_BG_CAP_RATE / SPOT_BG_FLOOR_RATE は変更されていないこと（grep で 0.20 / 0.15 のまま）。
 */

/**
 * HOW TO TEST (output-budget-columns)
 * 1) VERSION='2.3.43-dev' / BUILD_STAGE は本ブロック名、DLM_BUILD_STAGE 不変。
 * 2) A-9 を実行 → OUTPUT 混合（本命）セクションに H=Adopted Forecast / I=Sales Uplift / J=Final Budget の
 *    3列が、年度合計バンドと月次表バンドの両方に表示される。客観のみセクションには出ないこと。
 * 3) 月次 H に当該月の混合 Baseline(P50) が初期値（数値）として入り、上書きできること（黄背景）。
 * 4) 月次 I は空欄スタート（手入力・黄背景）。J=H+I の数式が入り、I 空欄時は J=H（=P50）が即表示（緑・太字）。
 * 5) I に金額を入力 → 同月の J が H+I に更新され、年度合計 J も連動すること。
 * 6) 年度合計バンドの H/I/J は月次の SUM 数式（=SUM(H..:H..) 等）で、月次編集に追従すること。
 * 7) グラフ（混合・客観の両セクション）が L 列(12)開始へ右移動し、H/I/J(8〜10列)と重ならないこと（K列(11)が余白）。
 * 8) H/I/J ヘッダのホバー(NOTE)に日本語の趣旨説明が出ること。
 * 9) A-9 を再実行すると H/I の手入力は消え、H は再び P50 初期値・I は空欄に戻ること（A-9複数回前提・許容）。
 * 10) A-9 の OUTPUT 年度合計・月次 P10/P50/P90（A〜G列）が本変更の前後で不変であること（表示追加のみ・予測非影響）。
 */

/**
 * HOW TO TEST (budget-entry-polish)
 * 1) VERSION='2.3.44-dev' / BUILD_STAGE='budget-entry-polish'、DLM_BUILD_STAGE 不変、ファイル先頭コメントも同期。
 * 2) book を開き直す → メニュー A 群に「A-10 予算を策定」が A-9 の直下・区切り線の上に1件だけ追加され、
 *    B 群は B-1〜B-4 のまま不変であること。
 * 3) A-9 実行後、OUTPUT 混合（本命）セクションの H24:J24 に「予算を策定」が結合表示されること。
 *    客観のみセクションには出ないこと。
 * 4) 同 A-9 後、H24:J40 が外周のみの控えめな枠線（緑 #6aa84f / SOLID_MEDIUM・内側罫線なし）で囲まれること。
 * 5) 「A-10 予算を策定」押下 → OUTPUT が前面化しアクティブセルが H24 へスクロール移動、トーストが出ること。
 *    OUTPUT 不在時は注意ダイアログで終了すること。
 * 6) A-1 初期セットアップ実行 → OUTPUT に旧グラフが残らないこと（buildOUTPUT_ がチャート除去）。
 *    続けて A-9 → 混合セクションのグラフが L25（startRow+1 / L列）に生成され、A-9 を再実行しても同位置であること。
 * 7) 予算列 H/I/J の初期値（月次 P50）・年度SUM・J=H+I・背景色（H/I=黄, J=緑）・NOTE が
 *    output-budget-columns の挙動どおりで、見出し行（24）と枠線の追加以外は不変であること。
 * 8) A-9 の OUTPUT 年度合計・月次 P10/P50/P90（A〜G列）が本変更の前後で不変であること（表示・ナビ追加のみ・予測非影響）。
 */

/**
 * HOW TO TEST (guide-a10-sync)
 * 1) VERSION='2.3.45-dev' / BUILD_STAGE は本ブロック名、DLM_BUILD_STAGE 不変、ファイル先頭コメントも同期。
 * 2) A-1 初期セットアップ → GUIDE 手順表の A 行が A-1〜A-10 の10行になり、
 *    A-10 行（青 C_A 背景）に「予算を策定」の説明が表示されること。
 * 3) B 行が A-10 の直下から B-1〜B-4、C 行が C-1〜C-3 で、行ズレ・重なり・空行欠落が無いこと。
 * 4) cRows と「シート分類」見出しの間に空行（gap）が1行入り、見出し下のシートリンク表
 *    （CONFIG〜QUARTERLY_REVIEW_LOG）が従来どおり並ぶこと。
 * 5) メニュー A 群（A-1〜A-10）と GUIDE 手順表の A 行が項目・順序とも一致すること。
 * 6) 予測・OUTPUT・予算列・他シートの挙動は不変（本変更は GUIDE シート表示のみ）。
 */

/**
 * HOW TO TEST (A-10 navigation guard)
 * 1) VERSION='2.3.46-dev' / BUILD_STAGE は本ブロック名、DLM_BUILD_STAGE 不変、先頭コメントも同期。
 * 2) A-1 初期セットアップ直後（A-9 未実行）に「A-10 予算を策定」押下 →
 *    未実行を示す注意ダイアログで終了し、空の H24 へ移動しないこと。
 * 3) A-9 実行後に「A-10 予算を策定」押下 → 従来どおり OUTPUT 前面化・H24 アクティブ・トースト表示。
 * 4) OUTPUT シート自体が無い場合は従来どおり「OUTPUT がありません」ダイアログで終了すること。
 * 5) A-9 の OUTPUT・予算列・GUIDE 等その他の挙動は不変（本変更は A-10 ナビのガードのみ）。
 */

// ========== v1.6 NEW: quarterly review ==========
function createDefaultCalibrationState_(client) {
  return {
    client: String(client || ''),
    updated_at: '',
    updated_by: '',
    ai_weight_override: '',
    ai_max_abs_effect_override: '',
    ai_topic_disable_json: '[]',
    bias_correction_factor: 1.0,
    qual_scale_override: '',
    residual_month_bias_json: '',
    last_applied_quarter: '',
    last_applied_review_id: '',
    auto_update_enabled: 1,
    note: ''
  };
}

function getCalibrationStateContext_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.CALIBRATION_STATE);
  if (!sh) throw new Error('CALIBRATION_STATE がありません');
  const values = sh.getDataRange().getValues();
  const header = values[0] || [];
  const idx = {};
  header.forEach((h, i) => { idx[String(h || '')] = i; });
  return { sh, values, header, idx };
}

function readCalibrationState_(client) {
  try {
    const ctx = getCalibrationStateContext_();
    const sh = ctx.sh;
    const rows = ctx.values;
    const idx = ctx.idx;
    const header = ctx.header;
    const target = String(client || '').trim();
    if (!target) return createDefaultCalibrationState_('');
    for (let i = 1; i < rows.length; i++) {
      if (!isSameClient_(rows[i][idx.client], target)) continue;
      return {
        client: target,
        updated_at: rows[i][idx.updated_at] || '',
        updated_by: rows[i][idx.updated_by] || '',
        ai_weight_override: rows[i][idx.ai_weight_override],
        ai_max_abs_effect_override: rows[i][idx.ai_max_abs_effect_override],
        ai_topic_disable_json: rows[i][idx.ai_topic_disable_json] || '[]',
        // 空は既定値。0 などの数は、そのまま読む（以前は Number(x || 1) で 0 を 1 にしていた）。倍率は正の数だけ
        bias_correction_factor: (() => { const v = calibrationNumberOr_(rows[i][idx.bias_correction_factor], 1); return v > 0 ? v : 1; })(),
        // 予約の列（今は予測に効かない。3c-1 で主観の帯の合わせを外したため。calibrateSubjectiveContinuousDelta_ はいつも 1）
        qual_scale_override: rows[i][idx.qual_scale_override],
        residual_month_bias_json: rows[i][idx.residual_month_bias_json] || '',
        last_applied_quarter: rows[i][idx.last_applied_quarter] || '',
        last_applied_review_id: rows[i][idx.last_applied_review_id] || '',
        auto_update_enabled: calibrationNumberOr_(rows[i][idx.auto_update_enabled], 1) === 1 ? 1 : 0,   // 0 で自動学習を止める
        note: rows[i][idx.note] || ''
      };
    }
    // 未登録時はデフォルト行を1回だけ作成して返す（再帰禁止）
    const def = createDefaultCalibrationState_(target);
    const row = header.map(k => (def[k] !== undefined ? def[k] : ''));
    sh.appendRow(row);
    return def;
  } catch (err) {
    throw err;
  }
}

/** CALIBRATION_STATE の数の列: 空（・読めない値）は既定値、0 を含む数はそのまま */
function calibrationNumberOr_(v, def) {
  if (v === '' || v === null || v === undefined) return def;
  const n = Number(v);
  return isFinite(n) ? n : def;
}

function writeCalibrationState_(client, partial) {
  try {
    const ctx = getCalibrationStateContext_();
    const sh = ctx.sh;
    const rows = ctx.values;
    const header = ctx.header;
    const idx = ctx.idx;
    const target = String(client || '').trim();
    const base = readCalibrationState_(target);
    const merged = Object.assign({}, base, partial || {});
    merged.client = target;
    merged.updated_at = new Date();
    merged.updated_by = Session.getActiveUser().getEmail() || 'unknown';
    const out = header.map(k => merged[k] !== undefined ? merged[k] : '');
    let found = -1;
    for (let i = 1; i < rows.length; i++) {
      if (isSameClient_(rows[i][idx.client], target)) {
        found = i + 1;
        break;
      }
    }
    if (found > 0) sh.getRange(found, 1, 1, out.length).setValues([out]);
    else sh.appendRow(out);
    return merged;
  } catch (err) {
    throw err;
  }
}

function applyCalibrationToTuning_(tuning, calibration) {
  const out = Object.assign({}, tuning || {});
  const cal = calibration || {};
  const calOverrideNum_ = (v) => {
    // 空欄(''/null/undefined)は「未設定」として無視する。Number('')===0 で finite になる罠を回避。
    // 明示的に 0 を入れた場合は 0 を返し、意図的なゼロ上書きは従来どおり有効にする。
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  };
  const aiWeightOverride = calOverrideNum_(cal.ai_weight_override);
  if (aiWeightOverride !== null) out.aiWeight = aiWeightOverride;
  const aiMaxAbsEffectOverride = calOverrideNum_(cal.ai_max_abs_effect_override);
  if (aiMaxAbsEffectOverride !== null) out.aiMaxAbsEffect = aiMaxAbsEffectOverride;
  out.disabledTopics = [];
  try {
    const arr = JSON.parse(String(cal.ai_topic_disable_json || '[]'));
    if (Array.isArray(arr)) out.disabledTopics = arr.map(normalizeAiTopic_).filter(Boolean);
  } catch (err) {
    out.disabledTopics = [];
  }
  return out;
}

// ============================================================
// 月次ベイズ自動学習（B-5 / webRunMonthlyLearn）
// EVAL_LOG の中立シナリオ誤差を事前分布+縮小推定で処理し、
// 全体補正係数（bias_correction_factor）と暦月別残差バイアス
// （residual_month_bias_json）を CALIBRATION_STATE へ書き戻す。
// 計算部（autoLearnComputeState_）は sheet 非依存の純粋関数として
// 切り出し、Node 側の単体テスト（tests/forecast-autolearn.test.mjs）
// で不変条件を検証する。
// 2026-10-07 から、誤差は補正を掛ける前の予測で測る（村井さん承認）。
// その予測に掛かっていた補正は attachAppliedCalibration_ が
// FORECAST_SNAPSHOT の calibration_applied_json から読む。
// 2026-10-13 から、偏りは月ごとの誤差の平均ではなく、重みつきの合計の比
// （Σw(予測 − 実績) ÷ Σw|実績|。WAPE と同じ形）で測る（村井さん承認）。
// 実績が 0 に近い月が 1 つあるだけで、偏りが何千 % にもなり、係数が下限へ
// 1 回 0.05 ずつ下がり続けていたため。
// ============================================================

function autoLearnComputeState_(pairs, opts) {
  const o = opts || {};
  const minMonths = isFinite(o.minMonths) ? o.minMonths : AUTOLEARN_MIN_EVAL_MONTHS;
  const halfLife = isFinite(o.halfLife) && o.halfLife > 0 ? o.halfLife : AUTOLEARN_EWMA_HALFLIFE_MONTHS;
  const kG = isFinite(o.kG) ? o.kG : AUTOLEARN_GLOBAL_SHRINK_K;
  const kM = isFinite(o.kM) ? o.kM : AUTOLEARN_MONTH_SHRINK_K;
  const maxDelta = isFinite(o.maxDelta) ? o.maxDelta : AUTOLEARN_MAX_GLOBAL_DELTA;
  const monthCap = isFinite(o.monthCap) ? o.monthCap : AUTOLEARN_MONTH_BIAS_CAP;
  const fMin = isFinite(o.fMin) ? o.fMin : AUTOLEARN_GLOBAL_FACTOR_MIN;
  const fMax = isFinite(o.fMax) ? o.fMax : AUTOLEARN_GLOBAL_FACTOR_MAX;
  const curFactor = isFinite(o.curFactor) ? o.curFactor : 1.0;

  // 補正を掛ける前の予測で学ぶ。EVAL_LOG の pred は、A-9 が k = 全体係数 × (1 + 暦月バイアス) を掛けた後の予測。
  // そのまま測ると、偏りを直せた係数ほど誤差が 0 に近づいて目標が 1 に戻り、係数が 1 回 0.05 ずつ元に戻っていた。
  // そこで、その予測に掛かっていた係数 factorUsed と暦月バイアス monthBiasUsed で割り戻す:
  //   raw = pred / (factorUsed × (1 + monthBiasUsed))
  // 付いていない・読めない組は補正なし（係数 1・暦月バイアス 0）。このとき raw = pred で、結果は今までと同じ。
  // 全体: 偏り = Σw(raw − actual) ÷ Σw|actual|（重みつきの合計の比。2026-10-13）を、今までと同じ縮め方（半減期の重み・
  //   事前の精度 kG・上下限・1 回の幅）に入れる: postBias = 合計の比 × Σw ÷ (Σw + kG)。
  //   実績がどの月も同じなら、月ごとの誤差 (raw − actual) / |actual| の重みつき平均と同じ（今までの値）。
  //   月ごとの誤差の平均では、実績が 0 に近い月（予測 1 億・実績 1 万円なら誤差 9,999 倍）が 1 つあるだけで偏りが何千 % になり、
  //   目標の係数が下限に張りついていた。合計の比なら、その月は金額のとおりに数える。
  // 暦月: A-9 は係数と暦月バイアスを掛け算で重ねるので、暦月バイアスは全体係数を掛けた後に残る誤差を直す分。
  //   raw × 係数 × (1 + mb) = actual から 1 + mb = actual / (raw × 係数) = 1 ÷ (1 + 誤差)（2026-10-13 から近似せずに。全体と同じ）。
  //   そこで暦月ごとに Σw(raw × factorUsed − actual) ÷ Σw|actual|
  //   （= 暦月バイアスだけを割り戻した予測の、合計の比の誤差）を、今までと同じ式（事前の精度 kM）で縮める。
  //   係数は、次に掛ける係数ではなく、その予測に掛かっていた係数で測る。補正の無い組で今までと同じ値にするため。
  //   係数が落ち着けば 2 つは同じになり、全体と暦月で同じ偏りを 2 度直さない。暦月バイアスも自分の値を割り戻すので、自分を打ち消さない。
  // （Vertex アシストの倍率は学ぶ補正ではないので割り戻さない。今までと同じ）
  let corrected = 0;
  const usable = (pairs || [])
    .map(p => {
      const a = Number(p.actual); const pr = Number(p.pred);
      if (!isFinite(a) || a === 0 || !isFinite(pr)) return null;
      const fU = Number(p.factorUsed); const mbU = Number(p.monthBiasUsed);
      const f = isFinite(fU) && fU > 0 ? fU : 1;
      const mb = isFinite(mbU) && mbU > -1 ? mbU : 0;
      if (f !== 1 || mb !== 0) corrected++;
      const raw = pr / (f * (1 + mb));
      return { ym: String(p.ym || ''), d: raw - a, dM: raw * f - a, base: Math.abs(a) };
    })
    .filter(Boolean)
    .sort((a, b) => (a.ym < b.ym ? 1 : -1)); // 新しい月から順に
  if (usable.length < minMonths) {
    return { ready: false, reason: 'insufficient_eval_months', n: usable.length };
  }
  const wByIdx = usable.map((_, i) => Math.pow(0.5, i / halfLife));
  let wSum = 0; let wdSum = 0; let waSum = 0;
  usable.forEach((p, i) => { wSum += wByIdx[i]; wdSum += wByIdx[i] * p.d; waSum += wByIdx[i] * p.base; });
  // 正は過剰予測 → 補正係数は 1 ÷ (1 + 事後平均)（事前平均0・精度kGで縮小）。予測が実績の (1 + 偏り) 倍なら、掛ける係数はその逆数
  // （2026-10-13。前の 1 − 偏り は 1 次の近似で、偏りが大きいほど直し過ぎた: +25% なら 0.80 のところ 0.75）。偏りが小さければ同じ
  const ratioBias = wdSum / Math.max(1e-9, waSum);
  const postBias = ratioBias * wSum / Math.max(1e-9, wSum + kG);
  const targetFactor = clamp_(postBias > -1 + 1e-9 ? 1 / (1 + postBias) : fMax, fMin, fMax);
  const newFactor = clamp_(curFactor + clamp_(targetFactor - curFactor, -maxDelta, maxDelta), fMin, fMax);

  const byMonth = {};
  usable.forEach((p, i) => {
    const dt = parseYM_(p.ym);
    if (!dt) return;
    const key = String(dt.getMonth() + 1);
    if (!byMonth[key]) byMonth[key] = { n: 0, w: 0, wd: 0, wa: 0 };
    byMonth[key].n += 1;
    byMonth[key].w += wByIdx[i];
    byMonth[key].wd += wByIdx[i] * p.dM;
    byMonth[key].wa += wByIdx[i] * p.base;
  });
  const monthBias = {};
  Object.keys(byMonth).forEach(k => {
    const g = byMonth[k];
    // 暦月も全体と同じく、縮めた誤差 e から 1 + mb = 1 ÷ (1 + e)（前は 1 次の近似 mb ≈ −e）
    const e = (g.wd / Math.max(1e-9, g.wa)) * g.w / Math.max(1e-9, g.w + kM);
    const b = clamp_(e > -1 + 1e-9 ? 1 / (1 + e) - 1 : monthCap, -monthCap, monthCap);
    if (Math.abs(b) >= 0.005) monthBias[k] = Number(b.toFixed(4));
  });
  return {
    ready: true,
    n: usable.length,
    postBias: postBias,
    factor: newFactor,
    targetFactor: targetFactor,
    curFactor: curFactor,
    monthBias: monthBias,
    method: 'raw',          // 補正を割り戻した予測で学んだ
    corrected: corrected,   // 補正を割り戻した組の数（0 なら補正の割り戻しはしていない）
    measure: 'ratio'        // 偏りは重みつきの合計の比（2026-10-13）
  };
}

function parseResidualMonthBiasJson_(raw) {
  const out = {};
  try {
    const j = JSON.parse(String(raw || ''));
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      Object.keys(j).forEach(k => {
        const m = Number(k); const v = Number(j[k]);
        if (m >= 1 && m <= 12 && isFinite(v)) out[String(m)] = v;
      });
    }
  } catch (e) { /* 空・壊れたJSONは空で扱う */ }
  return out;
}

function canonicalMonthBiasJson_(obj) {
  const o = obj || {};
  const keys = Object.keys(o).filter(k => isFinite(Number(o[k]))).map(Number).sort((a, b) => a - b);
  const parts = {};
  keys.forEach(m => { parts[String(m)] = Number(o[String(m)]); });
  return JSON.stringify(parts);
}

/**
 * 学び（B-5）と Vertex アシストの「最近の外れ」に使う、月ごとの中立の評価の組 { ym, pred, actual }。
 * 今の決まりで測った行だけ（D4〜D6・2026-10-07）: 今の検証の版で B-2 が書いた、締まった月の行（isEvalLogRowCurrent_）。
 * 前の版の行（締まっていない月の途中の売上や、月が始まった後の予測で測った行）は消さずに残っているが使わない
 */
function collectNeutralEvalPairs_(ss, client) {
  const sh = ss.getSheetByName(SHEETS.EVAL_LOG);
  if (!sh || sh.getLastRow() < 2) return [];
  const vals = sh.getDataRange().getValues();
  const idx = headerIndexMap_(vals[0] || []);
  if (!hasHeaderIndexes_(idx, ['client', 'scenario', 'target_month', 'pred', 'actual'])) return [];
  const closed = readClosedActualMonths_(ss);
  const latest = new Map();
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    if (!isSameClient_(r[idx.client], client)) continue;
    if (String(r[idx.scenario] || '') !== 'neutral') continue;
    if (!isEvalLogRowCurrent_(r, idx, closed)) continue;
    if (idx.constraint_relevant_flag !== undefined && String(r[idx.constraint_relevant_flag] || '') !== '1') continue;
    const ym = ymKey_(r[idx.target_month]);
    if (!ym) continue;
    const rawAt = idx.evaluated_at !== undefined ? r[idx.evaluated_at] : '';
    const at = rawAt instanceof Date ? rawAt.getTime() : new Date(rawAt).getTime();
    const atKey = isFinite(at) ? at : 0;
    const prev = latest.get(ym);
    if (!prev || atKey > prev.at || (atKey === prev.at && i > prev.seq)) {
      latest.set(ym, { seq: i, at: atKey, ym: ym, pred: Number(r[idx.pred] || 0), actual: Number(r[idx.actual] || 0) });
    }
  }
  return Array.from(latest.values()).map(x => ({ ym: x.ym, pred: x.pred, actual: x.actual }));
}

/**
 * B-5 の学習のために、評価の組（collectNeutralEvalPairs_ の結果）へ、その予測に掛かっていた補正を付ける（factorUsed・monthBiasUsed）。
 * EVAL_LOG の pred は、B-2 が selectEvalSnapshotRows_ で選んだ FORECAST_SNAPSHOT の回（その月が始まる前の最後の回。D6）の final_pred。同じ選び方で回を選び直し、
 * その回の calibration_applied_json から全体係数と、その暦月のバイアス（A-9 と同じく ±AUTOLEARN_FORECAST_BIAS_CAP で切る）を読む。
 * 選び直しに使う実績は EVAL_LOG の actual（B-2 が選んだときと同じ値）。
 * 回が無い・final_pred が pred と合わない（B-2 の後に予測し直した）・読めないときは補正なし（係数 1・暦月バイアス 0）のまま（今までと同じ扱い）。
 */
function attachAppliedCalibration_(ss, client, pairs) {
  const out = (pairs || []).map(p => Object.assign({}, p, { factorUsed: 1, monthBiasUsed: 0 }));
  const sh = ss.getSheetByName(SHEETS.FORECAST_SNAPSHOT);
  if (!out.length || !sh || sh.getLastRow() < 2) return out;
  const vals = sh.getDataRange().getValues();
  const calCol = headerIndexMap_(vals[0] || []).calibration_applied_json;
  if (calCol === undefined) return out;
  const rows = vals.slice(1).filter(r => isSameClient_(r[2], client));
  const actualMap = new Map(out.map(p => [[normalizeClientName_(client), p.ym].join('|'), p.actual]));
  const neutralByYm = new Map();
  selectEvalSnapshotRows_(rows, actualMap).forEach(r => {
    if (String(r[4] || '') === 'neutral') neutralByYm.set(ymKey_(r[3]), r);
  });
  out.forEach(p => {
    const r = neutralByYm.get(p.ym);
    if (!r) return;
    const snapPred = Number(r[9]);
    if (!isFinite(snapPred) || Math.abs(snapPred - Number(p.pred)) > Math.max(1e-6, 1e-9 * Math.abs(snapPred))) return;
    let cal = null;
    try { cal = JSON.parse(String(r[calCol] || '')); } catch (e) { cal = null; }
    if (!cal || typeof cal !== 'object') return;
    const f = Number(cal.bias_correction_factor);
    const dt = parseYM_(p.ym);
    const mb = dt ? Number(parseResidualMonthBiasJson_(cal.residual_month_bias_json)[String(dt.getMonth() + 1)] || 0) : 0;
    p.factorUsed = isFinite(f) && f > 0 ? f : 1;
    p.monthBiasUsed = clamp_(isFinite(mb) ? mb : 0, -AUTOLEARN_FORECAST_BIAS_CAP, AUTOLEARN_FORECAST_BIAS_CAP);
  });
  return out;
}

function runMonthlyAutoLearn_(client, opts) {
  const o = opts || {};
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const target = String(client || '').trim();
  if (!target) throw new Error('client が未指定です。');
  const cal = readCalibrationState_(target);
  if (calibrationNumberOr_(cal.auto_update_enabled, 1) !== 1 && !o.force) {
    return { ready: false, skipped: 'auto_update_disabled', client: target };
  }
  // 評価の組に、その予測に掛かっていた補正を付けて、補正の前の予測で学ぶ（B-2 からの自動実行も LEARN.MONTHLY もここを通る）
  const pairs = attachAppliedCalibration_(ss, target, collectNeutralEvalPairs_(ss, target));
  const cur = isFinite(Number(cal.bias_correction_factor)) ? Number(cal.bias_correction_factor) : 1.0;
  const res = autoLearnComputeState_(pairs, { curFactor: cur });
  if (!res.ready) return { ready: false, skipped: res.reason, n: res.n, client: target };

  const newMonthJson = canonicalMonthBiasJson_(res.monthBias);
  const oldMonthJson = canonicalMonthBiasJson_(parseResidualMonthBiasJson_(cal.residual_month_bias_json));
  const qLabel = quarterLabelFromYm_(Utilities.formatDate(new Date(), TZ, 'yyyy/MM'));
  const patch = {
    bias_correction_factor: res.factor,
    residual_month_bias_json: newMonthJson === '{}' ? '' : newMonthJson,
    // raw = 補正を割り戻した予測で学んだ。corrected = そのうち補正が掛かっていた組の数
    note: `auto-learned ${Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm')} (n=${res.n}, raw, corrected=${res.corrected})`
  };
  writeCalibrationState_(target, patch);
  const changed = [];
  if (Math.abs(res.factor - cur) > 1e-9) {
    changed.push('bias_correction_factor');
    appendCalibrationHistory_(target, qLabel, 'AUTO-MONTHLY', 'bias_correction_factor', cur, res.factor, 'CALIBRATION_STATEのbias_correction_factorを手動で旧値へ戻す');
  }
  if (newMonthJson !== oldMonthJson) {
    changed.push('residual_month_bias_json');
    appendCalibrationHistory_(target, qLabel, 'AUTO-MONTHLY', 'residual_month_bias_json', oldMonthJson, patch.residual_month_bias_json, 'CALIBRATION_STATEのresidual_month_bias_jsonを手動で旧値へ戻す');
  }
  return {
    ready: true,
    client: target,
    n: res.n,
    prevFactor: cur,
    factor: res.factor,
    postBias: res.postBias,
    monthBias: res.monthBias,
    method: res.method,
    corrected: res.corrected,
    changed: changed
  };
}


/**
 * B-2 の末尾から自動呼び出し（評価蓄積→学習の閉ループ）。
 * 失敗しても B-2 本体は成功扱いのまま残す。
 */
function autoLearnAfterEvalReport_(client) {
  try {
    const res = runMonthlyAutoLearn_(client, {});
    if (res && res.ready) {
      safeLogRun_('runMonthlyAutoLearn_', client, 'success', res.n, new Date(), `auto:${res.changed.join(',') || 'no-change'}`);
      try { updateProcessStatus_('learn_status', 'success', client, res.n, `auto:${res.changed.join(',') || 'no-change'}`); } catch (e2) { /* ステータス更新失敗は握り潰す */ }
    } else if (res) {
      safeLogRun_('runMonthlyAutoLearn_', client, 'success', res.n || 0, new Date(), `skipped:${res.skipped}`);
      try { updateProcessStatus_('learn_status', 'success', client, res.n || 0, `skipped:${res.skipped}`); } catch (e2) { /* 同上 */ }
    }
    return res;
  } catch (e) {
    safeLogRun_('runMonthlyAutoLearn_', client, 'warning', 0, new Date(), String(e && e.message || e));
    return { ready: false, skipped: 'exception' };
  }
}

// ============================================================
// カウンターファクト学習バックテスト
// 「その時点までの誤差だけで自動学習した場合、補正後の誤差は
//  補正前より小さかったか」を EVAL_LOG 上で walk-forward 検算する。
// 既存予測値を再学習係数でスケールする簡易検算であり、モデル
// 再フィットの完全再現ではない（その旨を結果に明記）。
// ============================================================


// ============================================================
// Vertex AI 予測アシスト（ルールベース定量 + AI のハイブリッド）
// A-4 末尾で Gemini へ 12か月の相対調整率を問い合わせ、
// A-9 で reliability 学習付きの反映率で掛け合わせる。
// ============================================================

function readVertexForecastEnabled_() {
  const labelMap = readConfigLabelMap_();
  return Number(labelMap.VERTEX_FORECAST_ENABLED || 0) > 0;
}

function readVertexAssistWeight_(tuning) {
  const t = tuning || readModelTuningFromConfig_();
  const w = isFinite(t.vertexAssistWeight) ? Number(t.vertexAssistWeight) : VERTEX_ASSIST_WEIGHT_DEFAULT;
  return Math.max(0, Math.min(1, w));
}

function buildVertexForecastAssistContent_(targetClient, months, ctx) {
  const monthsYm = (months || []).map(m => fmtYM_(m));
  const lines = [];
  lines.push(`Client_Name: ${targetClient}`);
  lines.push(`Target_Months: ${monthsYm.join(', ')}`);
  lines.push(`Last12_Actual_Total: ${ctx.last12Ym.map((ym, i) => `${ym}=${Math.round(ctx.last12[i] || 0)}`).join(', ')}`);
  lines.push(`Trend_Slope_Pct_PerMonth: ${ctx.slopePct.toFixed(3)}`);
  lines.push(`Seasonal_Strong_Months: ${ctx.strongMonths.join(', ')}`);
  lines.push(`Seasonal_Weak_Months: ${ctx.weakMonths.join(', ')}`);
  if (ctx.knownSpot.length) lines.push(`Known_Spot_Expected: ${ctx.knownSpot.join(', ')}`);
  if (ctx.opinionLines.length) lines.push(`Subjective_Pushes: ${ctx.opinionLines.join(' | ')}`);
  if (ctx.aiLines.length) lines.push(`AI_Topic_Scores: ${ctx.aiLines.join(', ')}`);
  if (ctx.evalLines.length) lines.push(`Recent_Forecast_Misses: ${ctx.evalLines.join(' | ')}`);
  lines.push('');
  lines.push('上記の文脈から、各対象月の売上予測（ルールベース定量モデル）に掛けるべき相対調整率を推定してください。');
  lines.push('返却JSONのみ: {"monthly_adj":[数値×12], "confidence":0〜1, "rationale_ja":"300字以内"}');
  lines.push('制約: monthly_adj は -0.30〜+0.30、Target_Months と同じ順・同じ数。根拠の弱い月は 0。大型案件の開始/終了・市場イベント等の明示的根拠がある月のみ非ゼロを推奨。確信が持てない場合は全て0とし confidence を下げる。');
  return lines.join('\n');
}

function runVertexForecastAssist_(targetClient, ss, vertex, months) {
  const started = new Date();
  const out = { ok: false, skipped: '', months: [], adj: [], confidence: 0, rationale: '', error: '' };
  try {
    if (!readVertexForecastEnabled_()) { out.skipped = 'disabled'; return out; }
    if (!vertex || !vertex.geminiReady) { out.skipped = 'gemini_not_ready'; return out; }
    const cfgSh = ss.getSheetByName(SHEETS.CONFIG);
    const fy = Number(cfgSh.getRange('B3').getValue() || 0) || getDefaultFY_();
    const sales = ss.getSheetByName(SHEETS.SALES_MONTHLY);
    if (!sales) { out.skipped = 'no_sales_monthly'; return out; }
    const salesData = readSales48Months_(sales);
    const fctx = getForecastContext_(fy, new Date(), salesData.headerMonths || []);
    const targetMonths = (months && months.length === 12) ? months : fctx.forecastMonths;

    const total48 = (salesData.baseSeries48 || []).map((v, i) => Number(v || 0) + Number((salesData.spotSeries48 || [])[i] || 0));
    const last12 = total48.slice(-12);
    const headerYm = (salesData.headerMonths || []).map(d => fmtYM_(d));
    const last12Ym = headerYm.slice(-12);
    const baseSeries = salesData.baseSeries48 || [];
    const model = baseSeries.length >= 24 ? fitOpsModelTrendSeason_(baseSeries.slice()) : null;
    const meanY = meanArr_(last12) || 1;
    const slopePct = model ? (12 * Number(model.slope || 0)) / meanY : 0;
    let strongMonths = []; let weakMonths = [];
    if (model && model.seasonalIndex) {
      const pairs = model.seasonalIndex.map((s, i) => ({ m: i + 1, s: Number(s || 1) })).sort((a, b) => b.s - a.s);
      strongMonths = pairs.slice(0, 3).map(x => `${x.m}月(${x.s.toFixed(2)})`);
      weakMonths = pairs.slice(-3).map(x => `${x.m}月(${x.s.toFixed(2)})`);
    }
    const devProjects = readDevSpotProjects12Months_(fy);
    const knownByMonth = computeKnownSpotExpectedByMonth_(devProjects);
    const knownSpot = targetMonths.map((m, i) => Number(knownByMonth[i] || 0) > 0 ? `${fmtYM_(m)}≈${Math.round(knownByMonth[i])}` : '').filter(Boolean);
    const opinions = readOpinions_(fy);
    const opinionLines = summarizeOpinionsByMonth_(opinions, targetMonths).map((s, i) => s ? `${fmtYM_(targetMonths[i])}:${s}` : '').filter(Boolean);
    const aiScores = readAIResearchScores_(null, { basis: readAiScoreBasis_(), clientName: targetClient, tuning: readModelTuningFromConfig_() }) || {};
    const aiLines = AI_TOPICS.map(t => `${t}=${Number(aiScores[t] || 0).toFixed(3)}`);
    const evalPairs = collectNeutralEvalPairs_(ss, targetClient)
      .sort((a, b) => (a.ym < b.ym ? 1 : -1)).slice(0, 6);
    const evalLines = evalPairs.map(p => `${p.ym}:pred=${Math.round(p.pred)}/act=${Math.round(p.actual)}`);

    const userContent = buildVertexForecastAssistContent_(targetClient, targetMonths, {
      last12, last12Ym, slopePct, strongMonths, weakMonths,
      knownSpot, opinionLines, aiLines, evalLines
    });
    const system = [
      'あなたは製薬マーケティング支援会社の売上予測アシスタントです。',
      '統計モデルへの相対調整率をJSONのみで返してください。説明文・コードブロック・前置きは禁止。'
    ].join('\n');
    const r = callVertexGeminiStructured_(system, userContent, { config: vertex });
    if (!r.ok || !r.json) { out.error = String(r.error || 'no_json'); out.skipped = ''; return out; }
    const adj = Array.isArray(r.json.monthly_adj) ? r.json.monthly_adj.map(v => clamp_(Number(v || 0), -VERTEX_ASSIST_MAX_ADJ, VERTEX_ASSIST_MAX_ADJ)) : null;
    if (!adj || adj.length !== 12 || adj.some(v => !isFinite(v))) { out.error = 'invalid_monthly_adj'; return out; }
    const conf = Math.max(0, Math.min(1, Number(r.json.confidence || 0)));
    const rationale = String(r.json.rationale_ja || '').slice(0, 500);
    const sh = ensureSheetReady_(ss, SHEETS.VERTEX_FORECAST_LOG, getVertexForecastLogHeaders_());
    const runId = Utilities.getUuid();
    sh.appendRow([
      runId, new Date(), targetClient, fy,
      JSON.stringify(targetMonths.map(m => fmtYM_(m))),
      JSON.stringify(adj.map(v => Number(v.toFixed(4)))),
      conf, rationale, vertex.geminiModel, 'ok',
      durationSec_(started), JSON.stringify(r.usage || {}), ''
    ]);
    out.ok = true;
    out.months = targetMonths.map(m => fmtYM_(m));
    out.adj = adj;
    out.confidence = conf;
    out.rationale = rationale;
    out.runId = runId;
    return out;
  } catch (e) {
    out.error = String(e && e.message || e);
    return out;
  }
}

function getVertexForecastLogHeaders_() {
  return ['run_id', 'run_at', 'client', 'fy', 'target_months_json', 'monthly_adj_json', 'confidence', 'rationale_ja', 'model', 'status', 'duration_sec', 'usage_json', 'note'];
}

function readLatestVertexAssist_(client, months) {
  const out = { ready: false, adj: new Array(12).fill(0), confidence: 0, at: '', rationale: '', runId: '' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.VERTEX_FORECAST_LOG);
  if (!sh || sh.getLastRow() < 2) return out;
  const vals = sh.getDataRange().getValues();
  const idx = headerIndexMap_(vals[0] || []);
  if (!hasHeaderIndexes_(idx, ['client', 'status', 'target_months_json', 'monthly_adj_json'])) return out;
  const monthsKey = (months || []).map(m => fmtYM_(m)).join(',');
  for (let i = vals.length - 1; i >= 1; i--) {
    const r = vals[i];
    if (!isSameClient_(r[idx.client], client)) continue;
    if (String(r[idx.status] || '') !== 'ok') continue;
    let arr; try { arr = JSON.parse(String(r[idx.target_months_json] || '')); } catch (e) { continue; }
    if (!Array.isArray(arr) || arr.join(',') !== monthsKey) continue;
    let adj; try { adj = JSON.parse(String(r[idx.monthly_adj_json] || '')); } catch (e) { continue; }
    if (!Array.isArray(adj) || adj.length !== 12 || adj.some(v => !isFinite(Number(v)))) continue;
    for (let j = 0; j < 12; j++) out.adj[j] = clamp_(Number(adj[j] || 0), -VERTEX_ASSIST_MAX_ADJ, VERTEX_ASSIST_MAX_ADJ);
    out.confidence = Math.max(0, Math.min(1, Number(r[idx.confidence] || 0)));
    const rawAt = r[idx.run_at];
    out.at = rawAt instanceof Date ? Utilities.formatDate(rawAt, TZ, 'yyyy-MM-dd') : String(rawAt || '');
    out.rationale = String(r[idx.rationale_ja] || '');
    out.runId = String(r[idx.run_id] || '');
    out.ready = true;
    return out;
  }
  return out;
}

/**
 * FORECAST_SNAPSHOT.calibration_applied_json（その予測に掛かっていた補正）。値は CALIBRATION_STATE から読んだまま書く。
 * 空（'' / null / undefined）だけを既定の書き方にし、0 は 0 のまま残す（2026-10-08 村井さん承認。前は「|| ''」で、
 * 所有者が AI の重みを 0 にした予測も ai_weight_override を空と書き、記録からは「上書きなし」に見えた。AI の効きの上限・
 * 入力の効きの倍率も同じ。偏りの補正は読むときに正の数にしているので、書く値は前と同じ）
 */
function buildCalibrationAppliedPayload_(result) {
  const cal = (result && result.calibration) || createDefaultCalibrationState_('');
  const keep = (v, def) => (v === '' || v === null || v === undefined ? def : v);
  return {
    version: VERSION,
    quarter: keep(cal.last_applied_quarter, ''),
    ai_weight_override: keep(cal.ai_weight_override, ''),
    ai_max_abs_effect_override: keep(cal.ai_max_abs_effect_override, ''),
    ai_topic_disable_json: keep(cal.ai_topic_disable_json, '[]'),
    bias_correction_factor: keep(cal.bias_correction_factor, 1),
    qual_scale_override: keep(cal.qual_scale_override, ''),
    residual_month_bias_json: keep(cal.residual_month_bias_json, '')
  };
}

function buildOutputCalibrationSummary_(result) {
  const cal = (result && result.calibration) || createDefaultCalibrationState_('');
  const q = cal.last_applied_quarter || 'なし（全項目既定値）';
  const lines = [];
  lines.push(`適用中の四半期チューニング: ${q}`);
  if (q === 'なし（全項目既定値）') {
    lines.push('3か月以上の実績確定後に C-1 を実行してください。');
  } else {
    lines.push(`・ai_weight_override: ${cal.ai_weight_override || '既定'}`);
    lines.push(`・ai_topic_disable: ${cal.ai_topic_disable_json || '[]'}`);
    lines.push(`・bias_correction_factor: ${cal.bias_correction_factor || 1.0}`);
    lines.push('次回の四半期レビューは3か月後に C-1 を実行してください。');
  }
  if (result && result.calibrationWarning) lines.push(result.calibrationWarning);
  return lines.join(' / ');
}

function writeAIHistoriesForRun_(result, runId) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const shScore = ss.getSheetByName(SHEETS.AI_SCORE_HISTORY);
    const shImpact = ss.getSheetByName(SHEETS.AI_IMPACT_HISTORY);
    const impactHeaders = ['run_id','run_at','client','target_month','k_ai','ai_total_score','ai_direction','pred_p50','pred_p50_quant_only','ai_neutralized','disabled_topics_count','forecast_source'];
    ensureSheetHeaders_(shImpact, impactHeaders);
    const runAt = result && result.runAt ? result.runAt : new Date();
    const client = String((result && result.clientName) || '');
    const ai = (result && result.aiScores) || {};
    const meta = ai.meta || {};
    const scoreRows = AI_TOPICS.map(topic => {
      const m = meta[topic] || {};
      const scoreForHistory = isFinite(Number(m.levelScore)) ? Number(m.levelScore) : Number(ai[topic] || 0);
      return [runId, runAt, client, topic, scoreForHistory, Number(m.qualityScore || 0), m.degradedMode || '', m.neutralized ? 1 : 0, Number(m.coverageEventRows || 0), Number(m.coverageBenchmarkRows || 0), m.latestAsOfDate || ''];
    });
    if (scoreRows.length) writeRowsInChunks_(shScore, shScore.getLastRow() + 1, 1, scoreRows, 500);

    const kByMonth = (((result || {}).mixed || {}).diagnostics || {}).kAIByMonth || new Array(12).fill(1);
    const aiTotal = ((((result || {}).mixed || {}).diagnostics || {}).aiTotalScore) || 0;
    const aiNeutralized = ((((result || {}).mixed || {}).diagnostics || {}).aiNeutralized) ? 1 : 0;
    const disabledCount = ((result && result.tuningApplied && result.tuningApplied.disabledTopics) || []).length;
    const impactRows = (result.months || []).map((m, i) => {
      const k = Number(kByMonth[i] || 1);
      const dir = k > 1.01 ? 'up' : (k < 0.99 ? 'down' : 'flat');
      const fs = (result.sourceByMonth && result.sourceByMonth[i]) ? result.sourceByMonth[i] : 'forecast_open';
      return [runId, runAt, client, fmtYM_(m), k, aiTotal, dir, Number((result.mixed.p50 || [])[i] || 0), Number(((result.quantOnly || {}).p50 || [])[i] || 0), aiNeutralized, disabledCount, fs];
    });
    if (impactRows.length) writeRowsInChunks_(shImpact, shImpact.getLastRow() + 1, 1, impactRows, 500);
  } catch (err) {
    // 履歴書き込み失敗時も本処理は継続
  }
}

function computeSourcePushByMonth_(factorsProduct, factorsClient, opinions, aiScores, months, productWeights, reliabilityMap, vertexPushByMonth) {
  const rows = [];
  const relMap = reliabilityMap || new Map();
  (months || []).forEach(targetMonth => {
    const ym = fmtYM_(targetMonth);

    const prodByPerson = new Map();
    (factorsProduct || []).forEach(f => {
      if (!f.month || f.month > targetMonth) return;
      const key = f.person || '';
      if (!key || !isFinite(f.step)) return;
      prodByPerson.set(key, Number(prodByPerson.get(key) || 0) + Number(f.step || 0));
    });
    prodByPerson.forEach((step, person) => {
      if (!step) return;
      rows.push({
        target_month: ym,
        source_type: 'factor_product',
        source_key: person,
        push_step: step,
        push_direction: Math.sign(step),
        applied_reliability_r: getSourceReliability_(relMap, 'factor_product', person)
      });
    });

    const clientByPerson = new Map();
    (factorsClient || []).forEach(f => {
      if (!f.month || f.month > targetMonth) return;
      const key = f.person || '';
      if (!key || !isFinite(f.step)) return;
      const prev = clientByPerson.get(key);
      if (!prev || prev.month < f.month) clientByPerson.set(key, f);
    });
    clientByPerson.forEach((f, person) => {
      const step = Number(f.step || 0);
      if (!step) return;
      rows.push({
        target_month: ym,
        source_type: 'factor_client',
        source_key: person,
        push_step: step,
        push_direction: Math.sign(step),
        applied_reliability_r: getSourceReliability_(relMap, 'factor_client', person)
      });
    });

    const opinionByPerson = new Map();
    (opinions || []).forEach(o => {
      if (!o.month || o.month > targetMonth) return;
      const key = o.person || '';
      if (!key || !isFinite(o.step)) return;
      const prev = opinionByPerson.get(key);
      if (!prev || prev.month < o.month) opinionByPerson.set(key, o);
    });
    opinionByPerson.forEach((o, person) => {
      const conf = isFinite(o.confidence) ? Number(o.confidence) : 0.7;
      const step = Number(o.step || 0) * conf;
      if (!step) return;
      rows.push({
        target_month: ym,
        source_type: 'opinion',
        source_key: person,
        push_step: step,
        push_direction: Math.sign(step),
        applied_reliability_r: getSourceReliability_(relMap, 'opinion', person)
      });
    });

    AI_TOPICS.forEach(topic => {
      const step = Number((aiScores || {})[topic] || 0);
      if (!step) return;
      rows.push({
        target_month: ym,
        source_type: 'ai_topic',
        source_key: topic,
        push_step: step,
        push_direction: Math.sign(step),
        applied_reliability_r: getSourceReliability_(relMap, 'ai_topic', topic)
      });
    });
  });

  // Vertexアシスト寄与も同じ信頼度学習の枠組みに乗せる（source_type='vertex_forecast'）
  (vertexPushByMonth || []).forEach((push, i) => {
    const s = Number(push || 0);
    if (!s || !months[i]) return;
    rows.push({
      target_month: fmtYM_(months[i]),
      source_type: 'vertex_forecast',
      source_key: 'assist',
      push_step: s,
      push_direction: Math.sign(s),
      applied_reliability_r: getSourceReliability_(relMap, 'vertex_forecast', 'assist')
    });
  });
  return rows;
}

function writeSubjectiveImpactHistory_(result, runId) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = getOrCreateSheet_(ss, SHEETS.SUBJECTIVE_IMPACT_HISTORY);
    const headers = ['run_id','run_at','client','target_month','source_type','source_key','push_step','push_direction','applied_reliability_r','source_updated_at','forecast_source'];
    ensureSheetHeaders_(sh, headers);
    const inputs = (result && result.reliabilityInputs) || {};
    const impacts = computeSourcePushByMonth_(
      inputs.factorsProduct || [],
      inputs.factorsClient || [],
      inputs.opinions || [],
      inputs.aiScores || {},
      (result && result.months) || [],
      inputs.productWeights || new Map(),
      inputs.reliabilityMap || new Map(),
      inputs.vertexPushByMonth || []
    );
    if (!impacts.length) return;
    const runAt = result && result.runAt ? result.runAt : new Date();
    const client = String((result && result.clientName) || '');
    const fsByYm = new Map();
    ((result && result.months) || []).forEach((m, i) => {
      const ym = fmtYM_(m);
      const fs = (result.sourceByMonth && result.sourceByMonth[i]) ? result.sourceByMonth[i] : 'forecast_open';
      fsByYm.set(ym, fs);
    });
    const rows = impacts.map(x => [
      runId,
      runAt,
      client,
      x.target_month,
      x.source_type,
      x.source_key,
      Number(x.push_step || 0),
      Number(x.push_direction || 0),
      Number(x.applied_reliability_r || 1),
      '',
      fsByYm.has(x.target_month) ? fsByYm.get(x.target_month) : 'forecast_open'
    ]);
    writeRowsInChunks_(sh, sh.getLastRow() + 1, 1, rows, 500);
  } catch (err) {
    // 履歴書き込み失敗時も本処理は継続
  }
}

function runQuarterlyReview() {
  const started = new Date();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const client = String(ss.getSheetByName(SHEETS.CONFIG).getRange('B2').getValue() || '').trim();
    const data = collectQuarterlyReviewData_(client);
    if (!data.ready) {
      writeQuarterlyReviewInsufficient_(data);
      logRun_('runQuarterlyReview', client, 'success', 0, started, 'insufficient_months');
      alertOrThrow_('実績不足', `実績が${data.missingMonths}月分不足しています。3か月分の実績確定後に再実行してください`);
      return;
    }
    const reviewId = Utilities.getUuid();
    try {
      const evidenceStats = computeReliabilityHitStats_(data);
      const qEnd = data.months[data.months.length - 1];
      writeReliabilityEvidence_(data.client, quarterLabelFromYm_(qEnd), qEnd, evidenceStats, reviewId);
    } catch (e) {
      safeLogRun_('writeReliabilityEvidence_', client, 'warning', 0, started, String(e && e.message || e));
    }
    const proposals = generateQuarterlyProposals_(data);
    appendProposalsToLog_(reviewId, data, proposals);
    writeQuarterlyReviewSheet_({ reviewId, data, proposals });
    updateProcessStatus_('quarterly_review_status', 'success', client, proposals.length, '');
    logRun_('runQuarterlyReview', client, 'success', proposals.length, started, '');
    ss.setActiveSheet(ss.getSheetByName(SHEETS.QUARTERLY_REVIEW));
  } catch (err) {
    logRun_('runQuarterlyReview', '', 'error', 0, started, String(err.message || err));
    alertOrThrow_('C-1 エラー', err.message || err);
  }
}

/**
 * C-1 の材料。月は、今の決まりで測った月（締まった月を、月が始まる前の予測で。D4〜D6・2026-10-07）のうち新しい 3 か月。
 * 前の版の EVAL_LOG の行（締まっていない月の途中の売上や、月が始まった後の予測で測った行）は消さずに残っているが使わない。
 * AI と人の押しの当たりも、その月が始まる前の最後の予測の回（AI_IMPACT_HISTORY・SUBJECTIVE_IMPACT_HISTORY）だけで数える（D6）
 */
function collectQuarterlyReviewData_(client) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const evalSh = ss.getSheetByName(SHEETS.EVAL_LOG);
    if (!evalSh || evalSh.getLastRow() < 2) {
      return { ready: false, missingMonths: 3, months: [], client, evalIdx: {}, impactIdx: {}, subjectiveImpactIdx: {} };
    }
    const evalValues = evalSh.getDataRange().getValues();
    const evalIdx = headerIndexMap_(evalValues[0] || []);
    if (!hasHeaderIndexes_(evalIdx, ['client','scenario','target_month','actual','constraint_relevant_flag'])) {
      return { ready: false, missingMonths: 3, months: [], client, evalIdx, impactIdx: {}, subjectiveImpactIdx: {} };
    }
    const evalClientIdx = evalIdx.client;
    const evalScenarioIdx = evalIdx.scenario;
    const evalTargetMonthIdx = evalIdx.target_month;
    const evalConstraintIdx = evalIdx.constraint_relevant_flag;
    const closed = readClosedActualMonths_(ss);
    const evalRows = evalValues.slice(1)
      .filter(r => isSameClient_(r[evalClientIdx], client) && String(r[evalScenarioIdx] || '') === 'neutral' && String(r[evalConstraintIdx] || '') === '1'
        && isEvalLogRowCurrent_(r, evalIdx, closed));
    const months = Array.from(new Set(evalRows.map(r => ymKey_(r[evalTargetMonthIdx])))).sort();
    const last3 = months.slice(-3);
    if (last3.length < 3) {
      return { ready: false, missingMonths: 3 - last3.length, months: last3, client, evalIdx, impactIdx: {}, subjectiveImpactIdx: {} };
    }
    const impactSh = ss.getSheetByName(SHEETS.AI_IMPACT_HISTORY);
    let impactIdx = {};
    let impacts = [];
    if (impactSh && impactSh.getLastRow() >= 1) {
      const impactValues = impactSh.getDataRange().getValues();
      impactIdx = headerIndexMap_(impactValues[0] || []);
      if (hasHeaderIndexes_(impactIdx, ['client','target_month','k_ai','ai_direction','pred_p50_quant_only'])) {
        const impactClientIdx = impactIdx.client;
        const impactTargetMonthIdx = impactIdx.target_month;
        impacts = keepPreMonthRunRows_(impactValues.slice(1)
          .filter(r => isSameClient_(r[impactClientIdx], client) && last3.indexOf(ymKey_(r[impactTargetMonthIdx])) >= 0), impactIdx);
      }
    }
    const subjSh = ss.getSheetByName(SHEETS.SUBJECTIVE_IMPACT_HISTORY);
    let subjectiveImpactIdx = {};
    let subjectiveImpacts = [];
    if (subjSh && subjSh.getLastRow() >= 1) {
      const subjectiveValues = subjSh.getDataRange().getValues();
      subjectiveImpactIdx = headerIndexMap_(subjectiveValues[0] || []);
      if (hasHeaderIndexes_(subjectiveImpactIdx, ['client','target_month','source_type','source_key','push_direction'])) {
        const subjClientIdx = subjectiveImpactIdx.client;
        const subjTargetMonthIdx = subjectiveImpactIdx.target_month;
        subjectiveImpacts = keepPreMonthRunRows_(subjectiveValues.slice(1)
          .filter(r => isSameClient_(r[subjClientIdx], client) && last3.indexOf(ymKey_(r[subjTargetMonthIdx])) >= 0), subjectiveImpactIdx);
      }
    }
    const scoreSh = ss.getSheetByName(SHEETS.AI_SCORE_HISTORY);
    const scores = scoreSh ? scoreSh.getDataRange().getValues().slice(1)
      .filter(r => isSameClient_(r[2], client)) : [];
    return { ready: true, client, months: last3, evalRows, impacts, scores, subjectiveImpacts, evalIdx, impactIdx, subjectiveImpactIdx, calibration: readCalibrationState_(client) };
  } catch (err) {
    throw err;
  }
}

function generateQuarterlyProposals_(data) {
  const proposals = [];
  const cal = data.calibration || createDefaultCalibrationState_(data.client);
  const tuning = readModelTuningFromConfig_();
  const evalIdx = data.evalIdx || {};
  const impactIdx = data.impactIdx || {};
  if (hasHeaderIndexes_(evalIdx, ['target_month','actual']) && hasHeaderIndexes_(impactIdx, ['target_month','k_ai','ai_direction','pred_p50_quant_only'])) {
    const evalTargetMonthIdx = requireHeaderIndex_(evalIdx, SHEETS.EVAL_LOG, 'target_month');
    const evalActualIdx = requireHeaderIndex_(evalIdx, SHEETS.EVAL_LOG, 'actual');
    const impactTargetMonthIdx = requireHeaderIndex_(impactIdx, SHEETS.AI_IMPACT_HISTORY, 'target_month');
    const impactKIdx = requireHeaderIndex_(impactIdx, SHEETS.AI_IMPACT_HISTORY, 'k_ai');
    const impactDirectionIdx = requireHeaderIndex_(impactIdx, SHEETS.AI_IMPACT_HISTORY, 'ai_direction');
    const impactQuantOnlyIdx = requireHeaderIndex_(impactIdx, SHEETS.AI_IMPACT_HISTORY, 'pred_p50_quant_only');
    const evalMap = new Map(data.evalRows.map(r => [ymKey_(r[evalTargetMonthIdx]), Number(r[evalActualIdx] || 0)]));
    let hit = 0; let den = 0;
    data.impacts.forEach(r => {
      const ym = ymKey_(r[impactTargetMonthIdx]);
      const aiDir = String(r[impactDirectionIdx] || 'flat');
      const actual = Number(evalMap.get(ym) || 0);
      const q = Number(r[impactQuantOnlyIdx] || 0);
      const actualDir = actual > q * 1.01 ? 'up' : (actual < q * 0.99 ? 'down' : 'flat');
      if (actualDir === 'flat') return;
      den += 1;
      if (actualDir === aiDir) hit += 1;
    });
    const hitRate = den > 0 ? hit / den : 0;
    const meanAbs = data.impacts.length ? avg_(data.impacts.map(r => Math.abs(Number(r[impactKIdx] || 1) - 1))) : 0;
    const curWeightRaw = cal.ai_weight_override;
    const curWeight = (curWeightRaw === '' || curWeightRaw === null || curWeightRaw === undefined)
      ? tuning.aiWeight
      : (isFinite(Number(curWeightRaw)) ? Number(curWeightRaw) : tuning.aiWeight);
    let proposedWeight = null;
    let conf = '';
    if (hitRate < 0.4 && meanAbs > 0.015) { proposedWeight = curWeight * 0.5; conf = '高'; }
    else if (hitRate >= 0.4 && hitRate < 0.65 && meanAbs > 0.01) { proposedWeight = curWeight * 0.7; conf = '中'; }
    else if (hitRate > 0.65 && meanAbs < 0.005) { proposedWeight = curWeight * 1.5; conf = '中'; }
    if (isFinite(proposedWeight) && proposedWeight >= tuning.aiWeightProposalMin && proposedWeight <= tuning.aiWeightProposalMax) {
      proposals.push(makeProposal_('A', 'ai_weight_override', curWeight, proposedWeight, conf, `AI方向一致率=${(hitRate*100).toFixed(1)}% / mean|kAI-1|=${(meanAbs*100).toFixed(2)}%`, `次期AI寄与を${Math.round((proposedWeight/curWeight)*100)}%へ調整`, 'C-2で却下または手動で元値に戻す', { hitRate, meanAbs }));
    }
  }
  return proposals.concat(generateReliabilityProposals_(data));
}

function computeReliabilityHitStats_(data) {
  if (!data || !data.ready || !data.months || data.months.length < 3) return [];
  if (!data.subjectiveImpacts || !data.subjectiveImpacts.length) return [];
  const evalIdx = data.evalIdx || {};
  const impactIdx = data.impactIdx || {};
  const subjectiveIdx = data.subjectiveImpactIdx || {};
  let evalScenarioIdx, evalTargetMonthIdx, evalActualIdx, impactTargetMonthIdx, impactQuantOnlyIdx, subjTargetMonthIdx, subjTypeIdx, subjKeyIdx, subjPushDirectionIdx;
  let impactRunAtIdx, impactForecastSourceIdx, subjRunAtIdx, subjForecastSourceIdx;
  try {
    evalScenarioIdx = requireHeaderIndex_(evalIdx, SHEETS.EVAL_LOG, 'scenario');
    evalTargetMonthIdx = requireHeaderIndex_(evalIdx, SHEETS.EVAL_LOG, 'target_month');
    evalActualIdx = requireHeaderIndex_(evalIdx, SHEETS.EVAL_LOG, 'actual');
    impactTargetMonthIdx = requireHeaderIndex_(impactIdx, SHEETS.AI_IMPACT_HISTORY, 'target_month');
    impactQuantOnlyIdx = requireHeaderIndex_(impactIdx, SHEETS.AI_IMPACT_HISTORY, 'pred_p50_quant_only');
    impactRunAtIdx = impactIdx.run_at;
    impactForecastSourceIdx = impactIdx.forecast_source;
    subjTargetMonthIdx = requireHeaderIndex_(subjectiveIdx, SHEETS.SUBJECTIVE_IMPACT_HISTORY, 'target_month');
    subjTypeIdx = requireHeaderIndex_(subjectiveIdx, SHEETS.SUBJECTIVE_IMPACT_HISTORY, 'source_type');
    subjKeyIdx = requireHeaderIndex_(subjectiveIdx, SHEETS.SUBJECTIVE_IMPACT_HISTORY, 'source_key');
    subjPushDirectionIdx = requireHeaderIndex_(subjectiveIdx, SHEETS.SUBJECTIVE_IMPACT_HISTORY, 'push_direction');
    subjRunAtIdx = subjectiveIdx.run_at;
    subjForecastSourceIdx = subjectiveIdx.forecast_source;
  } catch (err) {
    return [];
  }
  const runAtMs = v => {
    const d = (v instanceof Date) ? v : new Date(v);
    const t = d.getTime();
    return isFinite(t) ? t : 0;
  };
  const evalActualByMonth = new Map();
  (data.evalRows || []).forEach(r => {
    if (String(r[evalScenarioIdx] || '') !== 'neutral') return;
    evalActualByMonth.set(ymKey_(r[evalTargetMonthIdx]), Number(r[evalActualIdx] || 0));
  });
  const quantByMonth = new Map();
  const latestQuantByMonth = new Map();
  (data.impacts || []).forEach((r, seq) => {
    const forecastSource = impactForecastSourceIdx === undefined ? '' : String(r[impactForecastSourceIdx] || '').trim();
    if (forecastSource !== 'forecast_open') return;
    const ym = ymKey_(r[impactTargetMonthIdx]);
    if (!ym) return;
    const runMs = runAtMs(impactRunAtIdx === undefined ? '' : r[impactRunAtIdx]);
    const prev = latestQuantByMonth.get(ym);
    if (!prev || runMs > prev.runAtMs || (runMs === prev.runAtMs && seq > prev.seq)) {
      latestQuantByMonth.set(ym, { value: Number(r[impactQuantOnlyIdx] || 0), runAtMs: runMs, seq });
    }
  });
  latestQuantByMonth.forEach((x, ym) => {
    quantByMonth.set(ym, x.value);
  });

  const latestSubjectiveByUnit = new Map();
  (data.subjectiveImpacts || []).forEach((r, seq) => {
    const forecastSource = subjForecastSourceIdx === undefined ? '' : String(r[subjForecastSourceIdx] || '').trim();
    if (forecastSource !== 'forecast_open') return;
    const ym = ymKey_(r[subjTargetMonthIdx]);
    const type = String(r[subjTypeIdx] || '').trim();
    const key = String(r[subjKeyIdx] || '').trim();
    if (!ym || !type || !key) return;
    const unitKey = `${ym}|${type}|${key}`;
    const runMs = runAtMs(subjRunAtIdx === undefined ? '' : r[subjRunAtIdx]);
    const prev = latestSubjectiveByUnit.get(unitKey);
    if (!prev || runMs > prev.runAtMs || (runMs === prev.runAtMs && seq > prev.seq)) {
      latestSubjectiveByUnit.set(unitKey, { row: r, runAtMs: runMs, seq });
    }
  });
  const grouped = new Map();
  Array.from(latestSubjectiveByUnit.values()).forEach(x => {
    const r = x.row;
    // 月は 'yyyy/MM' に揃えてから実績・統計だけの予測と突き合わせる（SUBJECTIVE_IMPACT_HISTORY の月は Sheets が日付に変えていることがある）
    const ym = ymKey_(r[subjTargetMonthIdx]);
    const actual = Number(evalActualByMonth.get(ym));
    const quant = Number(quantByMonth.get(ym));
    if (!isFinite(actual) || !isFinite(quant)) return;
    const surpriseDir = Math.sign(actual - quant);
    if (!surpriseDir) return;
    const type = String(r[subjTypeIdx] || '').trim();
    const key = String(r[subjKeyIdx] || '').trim();
    const pushDir = Math.sign(Number(r[subjPushDirectionIdx] || 0));
    if (!type || !key || !pushDir) return;
    const gKey = `${type}:${key}`;
    if (!grouped.has(gKey)) grouped.set(gKey, { source_type: type, source_key: key, n: 0, hit: 0 });
    const g = grouped.get(gKey);
    g.n += 1;
    if (pushDir === surpriseDir) g.hit += 1;
  });
  return Array.from(grouped.values()).map(g => ({
    source_type: g.source_type,
    source_key: g.source_key,
    n: g.n,
    hit: g.hit,
    hit_rate: g.n > 0 ? g.hit / g.n : 0
  }));
}

function generateReliabilityProposals_(data) {
  if (!data || !data.ready || !data.months || data.months.length < 3) return [];
  const tuning = readModelTuningFromConfig_();
  const current = readSourceReliability_(data.client);
  const stats = computeReliabilityHitStats_(data);

  const proposals = [];
  stats.forEach(g => {
    if (g.n < tuning.reliabilityMinSamples) return;
    const h = g.n > 0 ? g.hit / g.n : 0;
    const rHat = clamp_(2 * h, tuning.reliabilityRMin, tuning.reliabilityRMax);
    const pool = readPoolPrior_(`reliability:${g.source_type}`);
    const rPool = isFinite(Number(pool.value)) ? Number(pool.value) : 1.0;
    const k = (pool.precision !== null && isFinite(Number(pool.precision))) ? Number(pool.precision) : tuning.reliabilityShrinkageK;
    const rShrunk = clamp_((g.n * rHat + k * rPool) / Math.max(1e-9, g.n + k), tuning.reliabilityRMin, tuning.reliabilityRMax);
    const rCurrent = getSourceReliability_(current, g.source_type, g.source_key);
    const delta = Math.abs(rShrunk - rCurrent);
    if (delta < tuning.reliabilityMinChange) return;
    const conf = (g.n >= 6 && delta >= 0.20) ? '高' : ((g.n >= 3 && delta >= 0.10) ? '中' : '低');
    proposals.push(makeProposal_(
      'B',
      `reliability:${g.source_type}:${g.source_key}`,
      rCurrent,
      rShrunk,
      conf,
      `的中率=${(h * 100).toFixed(0)}% / n=${g.n}`,
      `次回A-9で ${g.source_type}:${g.source_key} の主観/AI寄与を reliability_r=${rShrunk.toFixed(3)} で重み付け`,
      'C-2で却下、またはSOURCE_RELIABILITYを手動で旧値へ戻す',
      { hitRate: h, n: g.n, rHat, rShrunk, rCurrent }
    ));
  });
  return proposals;
}

function writeReliabilityEvidence_(client, quarterLabel, quarterEndMonth, stats, runId) {
  if (!stats || !stats.length) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet_(ss, SHEETS.RELIABILITY_EVIDENCE);
  const headers = ['client','source_type','source_key','quarter_label','quarter_end_month','n','hit','hit_rate','computed_at','run_id','note'];
  ensureSheetHeaders_(sh, headers);
  const values = sh.getDataRange().getValues();
  const idx = headerIndexMap_(values[0] || headers);
  if (!hasHeaderIndexes_(idx, ['client','source_type','source_key','quarter_label'])) return;
  const rowByKey = new Map();
  for (let i = 1; i < values.length; i++) {
    const key = [
      String(values[i][idx.client] || '').trim(),
      String(values[i][idx.source_type] || '').trim(),
      String(values[i][idx.source_key] || '').trim(),
      String(values[i][idx.quarter_label] || '').trim()
    ].join('|');
    if (key) rowByKey.set(key, i + 1);
  }
  const now = new Date();
  const targetClient = String(client || '').trim();
  const targetQuarter = String(quarterLabel || '').trim();
  const updates = [];
  const appends = [];
  (stats || []).forEach(s => {
    const type = String(s.source_type || '').trim();
    const sourceKey = String(s.source_key || '').trim();
    if (!type || !sourceKey || !targetQuarter) return;
    const row = [
      targetClient,
      type,
      sourceKey,
      targetQuarter,
      quarterEndMonth || '',
      Number(s.n || 0),
      Number(s.hit || 0),
      Number(s.hit_rate || 0),
      now,
      runId || '',
      ''
    ];
    const key = [targetClient, type, sourceKey, targetQuarter].join('|');
    const rowNo = rowByKey.get(key);
    if (rowNo) updates.push({ rowNo, row });
    else appends.push(row);
  });

  updates.sort((a, b) => a.rowNo - b.rowNo);
  let blockStart = 0;
  let blockRows = [];
  updates.forEach(u => {
    if (!blockRows.length) {
      blockStart = u.rowNo;
      blockRows = [u.row];
      return;
    }
    if (u.rowNo === blockStart + blockRows.length) {
      blockRows.push(u.row);
      return;
    }
    sh.getRange(blockStart, 1, blockRows.length, headers.length).setValues(blockRows);
    blockStart = u.rowNo;
    blockRows = [u.row];
  });
  if (blockRows.length) sh.getRange(blockStart, 1, blockRows.length, headers.length).setValues(blockRows);
  if (appends.length) writeRowsInChunks_(sh, sh.getLastRow() + 1, 1, appends, 500);
}

function makeProposal_(phase, field, currentValue, proposedValue, confidence, rationale, impact, rollback, metrics) {
  return {
    proposal_id: `P-${phase}-${Utilities.getUuid().slice(0, 6)}`,
    phase,
    target_field: field,
    current_value: String(currentValue),
    proposed_value: String(proposedValue),
    confidence: confidence || '中',
    rationale: rationale || '',
    impact_estimate: impact || '',
    rollback_hint: rollback || '',
    diagnostic_metrics_json: JSON.stringify(metrics || {})
  };
}

function appendProposalsToLog_(reviewId, data, proposals) {
  if (!proposals || !proposals.length) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.QUARTERLY_REVIEW_LOG);
  const now = new Date();
  const qStart = data.months[0];
  const qEnd = data.months[data.months.length - 1];
  const qLabel = quarterLabelFromYm_(qEnd);
  const rows = proposals.map(p => [reviewId, p.proposal_id, now, data.client, qLabel, qStart, qEnd, p.phase, p.target_field, p.current_value, p.proposed_value, p.confidence, p.rationale, p.impact_estimate, p.rollback_hint, QUARTERLY_APPROVAL_PENDING, '', '', 0, '', p.diagnostic_metrics_json || '{}']);
  writeRowsInChunks_(sh, sh.getLastRow() + 1, 1, rows, 500);
}

function writeQuarterlyReviewInsufficient_(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.QUARTERLY_REVIEW);
  sh.clear();
  sh.getRange(1, 1).setValue(`⚠ 検証期間不足（${(data.months || []).length}か月のみ確定）`).setFontColor('#b71c1c').setFontWeight('bold');
  sh.getRange(2, 1).setValue('実績が3か月分確定後に C-1 を再実行してください。');
}

function writeQuarterlyReviewSheet_(ctx) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.QUARTERLY_REVIEW);
  sh.clear();
  const data = ctx.data;
  const now = new Date();
  const qLabel = quarterLabelFromYm_(data.months[data.months.length - 1]);
  sh.getRange(1, 1).setValue(`【四半期レビュー: ${qLabel}】`).setFontWeight('bold').setBackground('#d9ead3');
  sh.getRange(2, 1).setValue(`検証期間: ${data.months[0]} 〜 ${data.months[data.months.length - 1]}（実績確定済み）`);
  sh.getRange(3, 1).setValue(`実行日時: ${Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm')}`);
  sh.getRange(5, 1).setValue('Section 5 の承認列を入力後、C-2 を実行してください。');
  sh.getRange(7, 1, 1, 9).setValues([['提案ID','対象','現在値','提案値','自信度','根拠','影響見積もり','承認列','ロールバック']]).setBackground(COLOR_HEADER).setFontWeight('bold');
  const rows = (ctx.proposals || []).map(p => [p.proposal_id, p.target_field, p.current_value, p.proposed_value, p.confidence, p.rationale, p.impact_estimate, '', p.rollback_hint]);
  if (rows.length) sh.getRange(8, 1, rows.length, 9).setValues(rows);
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(QUARTERLY_APPROVAL_OPTIONS, true).setAllowInvalid(true).build();
  if (rows.length) sh.getRange(8, 8, rows.length, 1).setDataValidation(rule);
  sh.getRange(8, 10).setValue(ctx.reviewId);
  sh.hideColumns(10);
}

function applyQuarterlyProposals() {
  const started = new Date();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SHEETS.QUARTERLY_REVIEW);
    const reviewId = String(sh.getRange(8, 10).getValue() || '').trim();
    // 反映できる案が無いときの文は、止めている「見直し案を作る」（C-1）へ案内しない（2026-10-08 村井さん承認。新アプリの画面にそのまま出る。
    // 頭の「C-2 エラー: 」は下の catch が付ける。取り下げた案は、新アプリが review_id に「取り下げ:」を付けるので記録に見つからない）
    if (!reviewId) throw new Error('反映できる見直し案がありません（まだ案がありません）。');
    const logSh = ss.getSheetByName(SHEETS.QUARTERLY_REVIEW_LOG);
    const all = logSh.getDataRange().getValues();
    const header = all[0] || [];
    const idx = {}; header.forEach((h,i)=>idx[String(h||'')]=i);
    const logRows = all.slice(1).filter(r => String(r[idx.review_id] || '') === reviewId);
    if (!logRows.length) throw new Error('反映できる見直し案がありません（取り下げた案か、まだ案がありません）。');
    if (logRows.some(r => Number(r[idx.applied] || 0) === 1)) {
      alertOrThrow_('適用済み', 'この見直し案は反映済みです（新しい案はまだありません）。');
      return;
    }
    const reviewVals = sh.getDataRange().getValues();
    const decisionMap = new Map();
    for (let i = 7; i < reviewVals.length; i++) {
      const pid = String(reviewVals[i][0] || '').trim();
      if (!pid) continue;
      const d = String(reviewVals[i][7] || '').trim();
      decisionMap.set(pid, d || QUARTERLY_APPROVAL_PENDING);
    }
    const now = new Date();
    const by = Session.getActiveUser().getEmail() || 'unknown';
    const client = String(logRows[0][idx.client] || '');
    const cal = readCalibrationState_(client);
    const autoUpdate = calibrationNumberOr_(cal.auto_update_enabled, 1) === 1;
    let a=0,d=0,p=0;
    const logData = logSh.getDataRange().getValues();
    for (let r = 1; r < logData.length; r++) {
      if (String(logData[r][idx.review_id] || '') !== reviewId) continue;
      const pid = String(logData[r][idx.proposal_id] || '');
      const decision = decisionMap.has(pid) ? decisionMap.get(pid) : QUARTERLY_APPROVAL_PENDING;
      logData[r][idx.approval_status] = decision;
      logData[r][idx.approval_decided_at] = now;
      logData[r][idx.approval_decided_by] = by;
      if (decision === '承認') {
        a += 1;
        if (autoUpdate) {
          const field = String(logData[r][idx.target_field] || '');
          const val = logData[r][idx.proposed_value];
          if (field.indexOf('reliability:') === 0) {
            const parts = field.split(':');
            const sourceType = parts[1] || '';
            const sourceKey = parts.slice(2).join(':');
            const rNew = Number(val);
            const rOld = getSourceReliability_(readSourceReliability_(client), sourceType, sourceKey);
            writeSourceReliability_(client, sourceType, sourceKey, rNew, '', String(logData[r][idx.quarter_label] || ''), `applied via ${reviewId}`);
            appendCalibrationHistory_(client, logData[r][idx.quarter_label], reviewId, field, rOld, rNew, logData[r][idx.rollback_hint]);
          } else {
            const oldVal = cal[field];
            const patch = {}; patch[field] = val;
            patch.last_applied_review_id = reviewId;
            patch.last_applied_quarter = String(logData[r][idx.quarter_label] || '');
            writeCalibrationState_(client, patch);
            appendCalibrationHistory_(client, logData[r][idx.quarter_label], reviewId, field, oldVal, val, logData[r][idx.rollback_hint]);
          }
          logData[r][idx.applied] = 1;
          logData[r][idx.applied_at] = now;
        }
      } else if (decision === '却下') d += 1;
      else p += 1;
    }
    logSh.getRange(1, 1, logData.length, logData[0].length).setValues(logData);
    updateProcessStatus_('quarterly_review_status', 'success', client, a, '');
    logRun_('applyQuarterlyProposals', client, 'success', a, started, `rejected=${d};hold=${p}`);
    const ui = safeSpreadsheetUi_();
    if (ui) ui.alert(`四半期レビューを適用しました。\n- 承認・適用: ${a} 件\n- 却下: ${d} 件\n- 保留: ${p} 件` + (autoUpdate ? '' : '\nauto_update_enabled=0 のため CALIBRATION_STATE は変更されませんでした'));
    return { applied: a, rejected: d, hold: p, autoUpdate: autoUpdate };
  } catch (err) {
    logRun_('applyQuarterlyProposals', '', 'error', 0, started, String(err.message || err));
    alertOrThrow_('C-2 エラー', err.message || err);
  }
}

function appendCalibrationHistory_(client, quarterLabel, reviewId, factorName, oldValue, newValue, rollbackHint) {
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.CALIBRATION_HISTORY);
    sh.appendRow([Utilities.getUuid(), new Date(), Session.getActiveUser().getEmail() || 'unknown', client, quarterLabel || '', reviewId || '', factorName || '', String(oldValue || ''), String(newValue || ''), rollbackHint || '']);
  } catch (err) {
    // 履歴失敗は処理継続
  }
}


