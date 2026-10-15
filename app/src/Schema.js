/**
 * Schema.js — 表の定義（スキーマ登録）。表の列はここだけで決め、データ本体の 1 行目と一致しなければ書き込まない。
 * 1 表 = 1 シート、1 行目に英字の列名、2 行目から値だけ（数式・タイトル・説明・色は置かない）。
 * 段階1 はマスタと設定の表。段階2 で計画（PLANS）と、旧来の計算が使う表（ENG_*）を足した。
 * 版 3（段階2-2b）で、新アプリで動かした予測の記録（FORECAST_RUNS / FORECAST_MONTHLY）を足した。types = 数値の列（num）。
 * 版 4（段階2-3）で、予測のほかの保存・実行（入力・予算・検証・四半期レビューなど）の記録（PLAN_ACTIONS）を足した。
 * ENG_* の列は旧来のシートの見出しと同じ（Legacy.js の APP_ENGINE_SHEETS から作る）。値は型ごと文字列にして持つ（raw）。
 * 版 8（2026-10-05）で、旧ブックからの取り込みの記録（IMPORT_BATCHES）を外した（このアプリだけを使う。取り込みの機能も外した）。
 * 版 9（2026-10-05）で、年度の締めの記録（YEAR_CLOSURES）を足した。行は元の計画の行を動かさず、年度 1 行を足すだけ。
 * 版 10（2026-10-08 村井さん承認「版10はおすすめで」。SCHEMA_PLAN_v10-12_JA.md の 3 章）で、記録の表 7 つ（INPUT_LOG・AI_RESEARCH_LOG・
 * LAYER_EFFECTS・HIT_RECORDS・LEARNING_LOG・PERSON_LINKS・BACKTEST）を足し、今ある表の後ろに列を足した（FORECAST_RUNS・PLANS。APP_ADDED_COLUMNS）。
 * 記録の表（appendOnly）は追記だけ: 行は消さず書き換えない（足すのは V10.js の appLogOps_ → 控えの書き方 append）。PERSON_LINKS だけは ROLES と同じく無効の印を変える。
 * 記録は計算に使わない。
 * 版 11（2026-10-09 村井さん承認「推奨する対応を継続」。SCHEMA_PLAN_v10-12_JA.md の 4 章）で、予算の下書き（BUDGET_DRAFTS。追記だけ）を足し、
 * 公式版（PLAN_VERSIONS）の後ろに、出したときの届く見込みと前提の列を足した（APP_ADDED_COLUMNS。出した後は変えない）。中身は BudgetDrafts.js・V11.js・Versions.js
 */
const APP_SCHEMA_VERSION = 12;

/**
 * 版を上げて、今ある表の後ろに足した列（古い順）。データ本体の 1 行目が足す前の列なら、版を上げた後の最初の操作で後ろに列の名前を書き足す
 * （Setup.js の appMigrateColumns_。前の列の位置と値は動かさず、前からある行の新しい列は空）。APP_TABLES の列の終わりと同じ並びにする（app/tests が見張る）
 */
const APP_ADDED_COLUMNS = {
  FORECAST_RUNS: [{ version: 10, columns: ['app_version', 'seed_rule', 'fixes_json'] }],
  PLANS: [{ version: 10, columns: ['purpose'] }],
  PLAN_VERSIONS: [{ version: 11, columns: ['reach_final', 'reach_adopted', 'center', 'sd', 'tau', 'w', 'closed_months', 'prob_mode', 'prob_basis_json'] }]
};

/**
 * 使わなくなった表。データ本体のシートは消さずに隠す（中身はそのまま。バックアップにも残る）。
 * 版を上げた後の最初の操作と、毎日の片付けで隠す（appHideRetiredTables_）
 */
const APP_RETIRED_TABLES = ['IMPORT_BATCHES'];

const APP_TABLES = {
  _SCHEMA: {
    key: ['table'],
    columns: ['table', 'schema_version', 'columns_hash', 'migrated_at', 'migrated_by']
  },
  MEMBERS: {
    key: ['email'],
    columns: ['email', 'display_name', 'department', 'is_active', 'note',
      'created_at', 'created_by', 'updated_at', 'updated_by', 'row_version']
  },
  ROLES: {
    key: ['role_id'],
    columns: ['role_id', 'email', 'role', 'scope_type', 'client_id', 'valid_from', 'valid_to', 'is_active', 'note',
      'created_at', 'created_by', 'updated_at', 'updated_by', 'row_version']
  },
  CLIENTS: {
    key: ['client_id'],
    columns: ['client_id', 'client_name', 'zac_code', 'normalized_name', 'aliases_json', 'is_active', 'note',
      'created_at', 'created_by', 'updated_at', 'updated_by', 'row_version']
  },
  SETTINGS: {
    // 設定は上書きせず、変更のたびに 1 行足す（effective_from が今日以前で最も新しい行が今の値）
    key: ['setting_id'],
    columns: ['setting_id', 'key', 'value', 'scope', 'scope_id', 'effective_from', 'note', 'created_at', 'created_by']
  },
  PLANS: {
    // 計画 = クライアント × 年度。source_book_id は取り込みで作った計画の元（2026-10-05 から使わない。列は残す）
    // purpose（版 10）: 空 = 予算を立てる計画、MEASURE = 測る専用（予算を立てない。過去の売上だけを取り込み、物差しの点を増やす。3-9）
    key: ['plan_id'],
    columns: ['plan_id', 'client_id', 'fy', 'client_label', 'people_csv', 'source_book_id', 'locale', 'time_zone', 'state', 'note',
      'created_at', 'created_by', 'updated_at', 'updated_by', 'row_version', 'purpose']
  },
  ENG_SHEETS: {
    // 計画ごとの旧来のシート 1 枚の情報（形・大きさ・内容のハッシュ）
    key: ['plan_id', 'sheet'], raw: true,
    columns: ['plan_id', 'sheet', 'mode', 'max_rows', 'max_columns', 'last_row', 'last_column', 'fmt_columns', 'content_hash',
      'import_batch_id', 'updated_at', 'updated_by']
  },
  ENG_ROWS: {
    // 表の形でないシートの行と、表の外にあるセル（cells_json = セルごとに「型 1 文字 + 値」）
    key: ['plan_id', 'sheet', 'row_no', 'col_from'], raw: true,
    columns: ['plan_id', 'sheet', 'row_no', 'col_from', 'cells_json']
  },
  ENG_FORMATS: {
    // 列ごとの表示形式の並び（runs_json = [[始まりの行, 終わりの行, 形式], ...]）。シートの自動変換を旧ブックと同じにするため
    key: ['plan_id', 'sheet', 'col'], raw: true,
    columns: ['plan_id', 'sheet', 'col', 'runs_json']
  },
  FORECAST_RUNS: {
    // 新アプリで動かした予測 1 回（追記のみ）。同じ入力（input_hash）・種（seed）・「今」（as_of）なら同じ結果になる
    // 版 10 の列（3-8）: app_version = アプリの版、seed_rule = 種の決め方（INPUT_V1 = 入力の中身と版から。空 = 版 10 より前の回で、seed が
    // 64 文字の 16 進なら INPUT_V1＝v0.29.0、RUN-… なら実行ごとの種＝v0.28.0 まで）、fixes_json = 本番に入れたアプリ側の直し。前からある行は空のまま（書き換えない）
    key: ['run_id'],
    columns: ['run_id', 'plan_id', 'status', 'engine_version', 'engine_sha256', 'seed', 'as_of', 'input_hash',
      'annual_p10', 'annual_p50', 'annual_p90', 'objective_p10', 'objective_p50', 'objective_p90',
      'changed_sheets_json', 'confirms_json', 'started_at', 'finished_at', 'actor_email', 'app_version', 'seed_rule', 'fixes_json'],
    types: { annual_p10: 'num', annual_p50: 'num', annual_p90: 'num', objective_p10: 'num', objective_p50: 'num', objective_p90: 'num' }
  },
  PLAN_ACTIONS: {
    // 計画への保存・実行 1 回（追記のみ。予測の実行は FORECAST_RUNS）。旧来の Web アプリの同じ名前の操作を、データ本体の上で動かした記録
    key: ['action_id'],
    columns: ['action_id', 'plan_id', 'action', 'status', 'engine_version', 'engine_sha256', 'web_sha256', 'seed', 'as_of', 'input_hash',
      'changed_sheets_json', 'result_json', 'started_at', 'finished_at', 'actor_email']
  },
  AUDIT_ANCHORS: {
    // 締まった月の監査の鎖の最後のハッシュ（ログのファイルとは別のファイルに控え、締まった月の書き換え・切り詰めに気づく）
    key: ['month'],
    columns: ['month', 'rows', 'first_prev', 'last_hash', 'anchored_at', 'anchored_by']
  },
  CLIENT_NAMES: {
    // 画面に出すクライアントの名前を、管理者が決めたもの（無ければ ZAC の名前から自動で作る: 半角カナを全角に・株式会社などを除く）。
    // CLIENTS.client_name（ZAC の名前）は売上の取り込みで照合に使うので変えない
    key: ['client_id'],
    columns: ['client_id', 'display_name', 'updated_at', 'updated_by', 'row_version']
  },
  PLAN_VERSIONS: {
    // 公式版: 計画のある時点の予測と予算を確定した版。出したら中身は変えない（状態と判断だけが変わる）。
    // 状態: SUBMITTED（承認待ち）→ APPROVED（公式版。前の公式版は SUPERSEDED）/ REJECTED。出し直すと前の承認待ちは WITHDRAWN
    // 版 11 の列（4-2。出したときに書き、後から変えない。前の版の行は空のまま）: reach_final・reach_adopted = 最終予算・採用予測に届く見込み（0〜1）、
    // center・sd = そのとき使った着地の分布の中心と幅（締まった月が無ければ center は月の真ん中の合計）、tau・w = 今年の水準のぶれと帯の倍率、
    // closed_months = 締まった月の数、prob_mode = SHADOW（試し）・LIVE（本番）、prob_basis_json = 式の版・締まった月の実績の合計・使った予測の回
    // closed_months は数（num）: 前の版の空の行を 0 と読まない（int だと 0 と読める）
    key: ['version_id'],
    columns: ['version_id', 'plan_id', 'version_no', 'state', 'input_hash', 'forecast_run_id', 'annual_p10', 'annual_p50', 'annual_p90',
      'budget_adopted', 'budget_uplift', 'budget_final', 'monthly_json', 'note', 'submitted_at', 'submitted_by', 'decided_at', 'decided_by',
      'decision_note', 'updated_at', 'updated_by', 'row_version',
      'reach_final', 'reach_adopted', 'center', 'sd', 'tau', 'w', 'closed_months', 'prob_mode', 'prob_basis_json'],
    types: { version_no: 'int', annual_p10: 'num', annual_p50: 'num', annual_p90: 'num', budget_adopted: 'num', budget_uplift: 'num', budget_final: 'num',
      reach_final: 'num', reach_adopted: 'num', center: 'num', sd: 'num', tau: 'num', w: 'num', closed_months: 'num' }
  },
  FORECAST_MONTHLY: {
    // 予測 1 回の月ごとの P10/P50/P90（混合と、過去売上のみ）。旧来の OUTPUT の行から取る
    key: ['run_id', 'ym'],
    columns: ['run_id', 'plan_id', 'ym', 'p10', 'p50', 'p90', 'obj_p10', 'obj_p50', 'obj_p90'],
    types: { p10: 'num', p50: 'num', p90: 'num', obj_p10: 'num', obj_p50: 'num', obj_p90: 'num' }
  },
  YEAR_CLOSURES: {
    // 年度の締め 1 回（追記のみ。元の計画の行は動かさない）。年度の控えをアーカイブに置き、検証できた年度だけ CLOSED にする
    key: ['fy'],
    columns: ['fy', 'state', 'file_id', 'snapshot_sha256', 'plan_count', 'row_count', 'bytes', 'closed_at', 'closed_by'],
    types: { plan_count: 'int', row_count: 'int', bytes: 'int' }
  },
  // ---- 版 10 の記録の表（追記だけ。1 列目が plan_id の表は、締めた年度の行を書けず、年度の控えに入る）----
  INPUT_LOG: {
    // 入力の記録（3-1）: 保存のたびに、変わった行だけを前と後で残す。change = ADD・CHANGE・REMOVE・CONF・BASELINE。self_conf は計算に使わない
    key: ['log_id'], appendOnly: true,
    columns: ['plan_id', 'log_id', 'action_id', 'action', 'kind', 'change', 'row_key', 'person', 'before_json', 'after_json',
      'self_conf', 'reason', 'signal_id', 'actor_email', 'saved_at']
  },
  AI_RESEARCH_LOG: {
    // AI 調査の記録（3-2）: A-4 のたびに、その回に書いた行を残す（row_json = 元の 22 列そのまま）。started_by = AUTO か始めた人
    key: ['research_id'], appendOnly: true,
    columns: ['plan_id', 'research_id', 'action_id', 'started_by', 'as_of_date', 'topic', 'row_type', 'direction',
      'impact_score', 'confidence', 'event_score', 'benchmark_score', 'blended_score', 'time_horizon', 'row_json', 'recorded_at'],
    types: { impact_score: 'num', confidence: 'num', event_score: 'num', benchmark_score: 'num', blended_score: 'num' }
  },
  LAYER_EFFECTS: {
    // 層ごとの効き（3-3）: 予測 1 回 × 月。統計の土台 + スポット + 人 + AI + 補正 + 合わない分 = 最後の真ん中（円）。method = LMDI・RATIO
    key: ['effect_id'], appendOnly: true,
    columns: ['plan_id', 'effect_id', 'run_id', 'ym', 'final_p50', 'stat_p50', 'spot_yen', 'human_yen', 'human_by_type_json',
      'ai_yen', 'calib_yen', 'other_yen', 'method', 'source', 'recorded_at'],
    types: { final_p50: 'num', stat_p50: 'num', spot_yen: 'num', human_yen: 'num', ai_yen: 'num', calib_yen: 'num', other_yen: 'num' }
  },
  HIT_RECORDS: {
    // 当たりの記録（3-4）: 人（または AI 調査 1 回）× 締まった四半期で 1 件。hit_id は中身から決まる（同じ中身なら同じ印）。古さの重みは読むときに計算する
    key: ['hit_id'], appendOnly: true,
    columns: ['plan_id', 'hit_id', 'client_id', 'quarter', 'source_kind', 'source_key', 'person_email', 'months_json', 'push',
      'actual_dir', 'hit', 'n_months', 'policy_version', 'calc_version', 'computed_at', 'computed_by'],
    types: { push: 'num', actual_dir: 'int', hit: 'int', n_months: 'int' }
  },
  LEARNING_LOG: {
    // 学びの記録（3-5）: 案・判断・反映・振り返りを 1 件ずつ足す。全計画の学び（τ・w など）は plan_id が空（年度の控えに入らない）
    // evidence_n は数（num）: 分からない根拠の件数は空のまま（int だと 0 と書かれ「根拠 0 件」と読めてしまう）。型は列のハッシュに入らない（_SCHEMA は変わらない）
    key: ['learn_id'], appendOnly: true, globalRows: true,
    columns: ['plan_id', 'learn_id', 'proposal_id', 'event', 'origin', 'target', 'current_value', 'proposed_value', 'evidence_n',
      'ci80_json', 'compare_json', 'decision', 'applied_value', 'review_quarter', 'note', 'actor_email', 'at'],
    types: { evidence_n: 'num' }
  },
  PERSON_LINKS: {
    // 入力の「担当者」の名前とメンバーのメールのつなぎ（3-6）。client_id が空 = 全部のメーカー。外すときは消さずに無効にする（ROLES と同じ）
    key: ['link_id'],
    columns: ['link_id', 'person_name', 'email', 'client_id', 'valid_from', 'valid_to', 'is_active', 'note',
      'created_at', 'created_by', 'updated_at', 'updated_by', 'row_version']
  },
  BACKTEST: {
    // 物差しの結果（3-7）: 過去の区切りに戻って予測し直し、単純な方法と並べた点。counted = 前の 48 か月が本物の売上でそろい、実績が締まった点だけ
    key: ['point_id'], appendOnly: true,
    columns: ['plan_id', 'point_id', 'bt_id', 'cutoff_ym', 'target_ym', 'horizon', 'method', 'p10', 'p50', 'p90', 'actual',
      'real_months', 'counted', 'engine_sha256', 'seed', 'calc_version', 'computed_at', 'computed_by'],
    types: { horizon: 'int', p10: 'num', p50: 'num', p90: 'num', actual: 'num', real_months: 'int', counted: 'bool' }
  },
  // ---- 版 11 の表（追記だけ。1 列目が plan_id: 締めた年度の行は書けず、年度の控えに入る）----
  BUDGET_DRAFTS: {
    // 予算の下書き（4-1）: 予算の保存 1 回で 12 か月分の 12 行。今の下書き = 計画 × 月の一番新しい行。予測し直しても、これで採用予測と上乗せを戻す。
    // basis = CENTER（真ん中のまま）・PROB（確率で選んだ）・MANUAL（手で直した）・BASELINE（版 11 の移行で今の予算を 1 回写した）、
    // prob = 確率で選んだときの値（50・60・70・80）、alloc = 月への割り振り（PAST_SHAPE 過去の平均の形・FORECAST_SHAPE 予測の月の形・MANUAL）、
    // run_id = 下書きを作ったときの予測の回、center = そのときの月の真ん中。prob は数（num）: 空を 0 と書かない
    key: ['draft_id'], appendOnly: true,
    columns: ['plan_id', 'draft_id', 'action_id', 'ym', 'adopted', 'uplift', 'basis', 'prob', 'alloc', 'run_id', 'center', 'actor_email', 'saved_at'],
    types: { adopted: 'num', uplift: 'num', prob: 'num', center: 'num' }
  },
  // ---- 版 12 の表（追記だけ。2026-10-15 村井さん承認。app/DESIGN_triangulation_bayes_JA.md の 2 章）----
  FORECAST_METHODS: {
    // 手法ごとの予測と段（素の回帰との比べ。Methods.js）: 予測 1 回 × 月。手法 = 前年同月・線形回帰・直近を重くした回帰・ロバスト季節・シミュレーション・
    // 三角測量（試し）、段 = 統計の土台 → + 確定スポット → + 人 → + AI → 最終（本番の真ん中）。source = forecast_open・actual_closed（予測の月か、実績に置き換えた月か）
    key: ['method_row_id'], appendOnly: true,
    columns: ['plan_id', 'method_row_id', 'run_id', 'ym', 'source', 'last_year', 'linear', 'recent', 'robust', 'sim', 'tri',
      'stat', 'plus_spot', 'plus_human', 'plus_ai', 'final', 'calc_version', 'recorded_at'],
    types: { last_year: 'num', linear: 'num', recent: 'num', robust: 'num', sim: 'num', tri: 'num',
      stat: 'num', plus_spot: 'num', plus_human: 'num', plus_ai: 'num', final: 'num' }
  }
};

/**
 * 旧来の計算（Forecast_Agent.js）が読み書きするシート。並びは、計算用ブックのシートの並び。
 * table = 1 行目が見出しの表（見出しは Forecast_Agent.js の定義と同じ。app/tests が原文と照合する）→ 表 ENG_シート名 に 1 行 = 1 件で持つ。
 * rows  = 表の形でないシート（CONFIG・OUTPUT・四半期レビューの画面など）→ ENG_ROWS に行ごとに持つ。
 * 計算で読まないシート（GUIDE・ハブ用・未使用・AI の生データとその記録）はデータ本体に持たない（APP_ENGINE_NOT_STORED）。
 */
const APP_ENGINE_SHEETS = {
  CONFIG: { mode: 'rows' },
  SALES_INPUT: { mode: 'table', header: ['client', 'service_type', 'product', 'target_month', 'input_amount', 'status', 'source_updated_at'] },
  SALES_MONTHLY: { mode: 'rows' },
  PRODUCT: { mode: 'table', header: ['Person', 'ProductName', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason'] },
  CLIENT: { mode: 'table', header: ['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Reason'] },
  OPINIONS: { mode: 'table', header: ['Person', 'Month(yyyy/mm/dd)', 'Step(増減率%)', 'Confidence(0..1)', 'Note'] },
  DEV_SPOT: { mode: 'table', header: ['Person', 'Month(yyyy/mm/dd)', 'Project', 'Amount(JPY)', 'Confidence(0..1)'] },
  OUTPUT: { mode: 'rows' },
  ACTUAL_EVAL_MONTHLY: { mode: 'table', header: ['client', 'service_type', 'product', 'target_month', 'eval_actual_amount', 'actual_closed_flag', 'source_updated_at'] },
  AI_RESEARCH: { mode: 'rows' },
  AI_RESEARCH_STRUCTURED: { mode: 'table', header: ['client', 'as_of_date', 'topic', 'row_type', 'direction', 'impact_score', 'confidence', 'evidence', 'time_horizon', 'business_relevance_reason', 'market_size_ref', 'peer_universe', 'peer_basis', 'relative_position_label', 'relative_percentile', 'relative_confidence', 'benchmark_quality', 'relative_reason', 'report_text', 'event_score', 'benchmark_score', 'blended_score'] },
  RUN_LOG: { mode: 'table', header: ['run_id', 'run_at', 'run_by', 'function_name', 'client', 'status', 'count', 'model_version', 'parameters_snapshot_json', 'input_data_hash', 'execution_duration_sec', 'error_summary'] },
  FORECAST_SNAPSHOT: { mode: 'table', header: ['snapshot_id', 'run_date', 'client', 'target_month', 'scenario', 'base_pred', 'subjective_adj', 'ai_adj', 'deterministic_adj', 'final_pred', 'confidence_interval_lower', 'confidence_interval_upper', 'key_factors_json', 'subjective_input_date', 'calibration_applied_json'] },
  EVAL_LOG: { mode: 'table', header: ['eval_id', 'evaluated_at', 'client', 'target_month', 'scenario', 'pred', 'actual', 'ape', 'was_overridden', 'error_category', 'forecast_role', 'is_planning_point_estimate', 'signed_error', 'abs_error', 'bias_direction', 'range_contains_actual', 'quarter_label', 'half_label', 'fy_label', 'model_version', 'evaluation_policy_version', 'constraint_relevant_flag'] },
  EVAL_COMPARE_MONTHLY: { mode: 'table', header: ['target_month', 'forecast_base', 'forecast_spot', 'forecast_total', 'actual_base', 'actual_spot', 'actual_total', 'gap_total', 'forecast_total_p10', 'forecast_total_p50', 'forecast_total_p90', 'signed_error_p50', 'abs_error_p50', 'ape_p50', 'quarter_label', 'half_label', 'fy_label', 'over_flag', 'under_flag', 'range_outside_flag', 'note_for_investigation', 'planning_point_estimate_label', 'range_label'] },
  EVAL_INSIGHTS: { mode: 'table', header: ['evaluated_at', 'client', 'target_month', 'actual_total', 'pred_p50', 'diff', 'error_rate', 'insight', 'next_action', 'diagnostic_type', 'annual_constraint_breach', 'half_constraint_breach', 'overforecast_breach', 'range_breach', 'cause_hypothesis', 'cause_bucket', 'impacted_assumption', 'feedback_target_sheet', 'action_type', 'next_cycle_reflection', 'owner', 'due_date', 'status', 'review_cycle'] },
  PROCESS_STATUS: { mode: 'table', header: ['step_key', 'last_run_date', 'last_run_by', 'status', 'target_client', 'record_count', 'error_summary'] },
  DASHBOARD: { mode: 'table', header: ['metric', 'value', 'note'] },
  AI_SCORE_HISTORY: { mode: 'table', header: ['run_id', 'run_at', 'client', 'topic', 'blended_score', 'quality_score', 'degraded_mode', 'neutralized', 'coverage_event_rows', 'coverage_benchmark_rows', 'latest_as_of_date'] },
  AI_IMPACT_HISTORY: { mode: 'table', header: ['run_id', 'run_at', 'client', 'target_month', 'k_ai', 'ai_total_score', 'ai_direction', 'pred_p50', 'pred_p50_quant_only', 'ai_neutralized', 'disabled_topics_count', 'forecast_source'] },
  SUBJECTIVE_IMPACT_HISTORY: { mode: 'table', header: ['run_id', 'run_at', 'client', 'target_month', 'source_type', 'source_key', 'push_step', 'push_direction', 'applied_reliability_r', 'source_updated_at', 'forecast_source'] },
  CALIBRATION_STATE: { mode: 'table', header: ['client', 'updated_at', 'updated_by', 'ai_weight_override', 'ai_max_abs_effect_override', 'ai_topic_disable_json', 'bias_correction_factor', 'qual_scale_override', 'residual_month_bias_json', 'last_applied_quarter', 'last_applied_review_id', 'auto_update_enabled', 'note'] },
  CALIBRATION_HISTORY: { mode: 'table', header: ['change_id', 'changed_at', 'changed_by', 'client', 'quarter_label', 'review_id', 'factor_name', 'old_value', 'new_value', 'rollback_hint'] },
  QUARTERLY_REVIEW: { mode: 'rows' },
  QUARTERLY_REVIEW_LOG: { mode: 'table', header: ['review_id', 'proposal_id', 'reviewed_at', 'client', 'quarter_label', 'quarter_start_month', 'quarter_end_month', 'phase', 'target_field', 'current_value', 'proposed_value', 'confidence', 'rationale', 'impact_estimate', 'rollback_hint', 'approval_status', 'approval_decided_at', 'approval_decided_by', 'applied', 'applied_at', 'diagnostic_metrics_json'] },
  SOURCE_RELIABILITY: { mode: 'table', header: ['client', 'source_type', 'source_key', 'reliability_r', 'sample_count', 'last_eval_window', 'updated_at', 'updated_by', 'note'] },
  RELIABILITY_EVIDENCE: { mode: 'table', header: ['client', 'source_type', 'source_key', 'quarter_label', 'quarter_end_month', 'n', 'hit', 'hit_rate', 'computed_at', 'run_id', 'note'] },
  POOL_PRIOR: { mode: 'table', header: ['pool_scope', 'param_key', 'pooled_value', 'precision', 'n_clients', 'updated_at', 'updated_by', 'note'] },
  LANDING_FORECAST: { mode: 'table', header: ['client', 'fy', 'target_month', 'as_of_month', 'landing_p10', 'landing_p50', 'landing_p90', 'updated_at', 'source_run_id', 'note'] },
  VERTEX_FORECAST_LOG: { mode: 'table', header: ['run_id', 'run_at', 'client', 'fy', 'target_months_json', 'monthly_adj_json', 'confidence', 'rationale_ja', 'model', 'status', 'duration_sec', 'usage_json', 'note'] }
};
const APP_ENGINE_NOT_STORED = ['GUIDE', 'POOL_REGISTRY', 'POOL_AGGREGATION_LOG', 'DLM_STATE', 'BACKTEST_REPORT', 'AI_RESEARCH_RAW', 'AI_RESEARCH_TASK_LOG'];

// 表の形のシートごとに ENG_ の表を足す（列 = 計画・行番号・旧来の見出し・型の並び）
Object.keys(APP_ENGINE_SHEETS).forEach(name => {
  const d = APP_ENGINE_SHEETS[name];
  if (d.mode !== 'table') return;
  APP_TABLES['ENG_' + name] = { key: ['plan_id', 'seq'], raw: true, engineSheet: name, columns: ['plan_id', 'seq'].concat(d.header, ['_types']) };
});


/** ログのファイルの月別シート（AUDIT_yyyy_MM など） */
const APP_LOG_TABLES = {
  AUDIT: ['audit_id', 'occurred_at', 'actor_email', 'actor_roles', 'action', 'phase', 'result', 'entity_type', 'entity_id',
    'client_id', 'plan_id', 'detail_json', 'before_json', 'after_json', 'reason', 'error', 'request_id', 'app_version',
    'prev_hash', 'row_hash'],
  RUN: ['run_id', 'request_id', 'kind', 'started_at', 'finished_at', 'duration_ms', 'status', 'detail_json', 'error'],
  ERROR: ['error_id', 'occurred_at', 'request_id', 'actor_email', 'where', 'message', 'stack_head']
};

/** 列の型（保存はすべて書式なしテキスト。読むときにここで戻す）。raw の表はすべて文字列のまま */
function appColumnType_(col, def) {
  if (def && def.raw) return 'text';
  if (def && def.types && def.types[col]) return def.types[col];
  if (/_json$/.test(col)) return 'json';
  if (col === 'is_active') return 'bool';
  if (col === 'row_version' || col === 'schema_version') return 'int';
  return 'text';
}

/** 表の列の並びのハッシュ（_SCHEMA に控え、定義と実物のずれを見つける） */
function appColumnsHash_(name) {
  return appSha256Hex_(APP_TABLES[name].columns.join('|'));
}
