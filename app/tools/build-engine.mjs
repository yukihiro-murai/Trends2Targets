#!/usr/bin/env node
/*
 * build-engine.mjs — 旧来の計算（リポジトリのルートの Forecast_Agent.js）と旧来の Web アプリ（Forecast_WebApp.js）を関数で包み、
 * 新アプリの app/src/LegacyEngine.js を作る。
 *
 *   node app/tools/build-engine.mjs           … 作り直す
 *   node app/tools/build-engine.mjs --check   … 作り直さずに、今のファイルが元と一致するかだけ確かめる（違えば終了コード 1）
 *
 * 中身は 1 文字も変えない（前後に包む行を足すだけ）。包むことで旧来の関数は外（ブラウザ）から呼べなくなり、
 * SpreadsheetApp・Date・Utilities などは呼ぶ側（Engine.js）が差し替えられる。app/tests が元のファイルとの一致を確かめる。
 * Web アプリの画面の読み取り（webGetBootstrap_ など）と保存・実行（webSave* / webRun*）は、新アプリが同じ動きで使う（段階2-3）。
 * そのときの操作の記録と本人の確認は新アプリが行うので、旧来の webAudited_・webActor_ だけを末尾で差し替える（元の行は変えない）。
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legacyPath = path.join(appDir, '..', 'Forecast_Agent.js');
const webPath = path.join(appDir, '..', 'Forecast_WebApp.js');
const outPath = path.join(appDir, 'src', 'LegacyEngine.js');

/** 呼ぶ側が差し替えるもの（包んだ関数の引数から、同じ名前の定数として渡す） */
// AppTriangulation: 三角測量の重み（新アプリがベイズで出したもの。{ weights(clientName) } か null。2026-10-15 段 2。旧来の計算は無ければ初めの重み）
// AppLearning: 人と AI の効き係数（{ effects(clientName) } か null。段 3。無ければ押したとおり）
export const ENGINE_SERVICES = ['SpreadsheetApp', 'Date', 'Utilities', 'PropertiesService', 'UrlFetchApp', 'HtmlService', 'Session', 'AppTriangulation', 'AppLearning'];
/** 新アプリから使う旧来の関数と定数 */
export const ENGINE_EXPORTS = [
  'VERSION', 'BUILD_STAGE', 'SHEETS', 'WEB_UI_CONFIRMS_',
  'runPhase1Forecast', 'updatePhase1EvaluationReport', 'updatePhase1Dashboard', 'updatePhase1LearningInsights',
  'runMonthlyAutoLearn_', 'runQuarterlyReview', 'applyQuarterlyProposals', 'syncSalesFromSalesInput_',
  'readCalibrationState_', 'requireStepSuccess_', 'updateProcessStatus_', 'getForecastFYStart_', 'getForecastFYEnd_',
  // 所有者が承認した補正の値を書き、履歴を足す（Calibration.js。B-5・C-3 と同じ関数で書く）
  'writeCalibrationState_', 'appendCalibrationHistory_', 'quarterLabelFromYm_',
  // 旧来の Web アプリ（Forecast_WebApp.js）
  'webGetBootstrap_', 'webSaveInputs', 'webSaveBudget', 'webSaveEvalInsights', 'webSaveQuarterlyDecisions',
  'webRunAggregate', 'webRunEvalReport', 'webRunDashboard', 'webRunInsights', 'webRunMonthlyLearn', 'webRunQuarterly', 'webApplyQuarterly',
  'webRunImportSales', 'webRunImportActuals', 'webRunAiResearch',
  // 新しい計画を作る（A-1 初期セットアップ setupForecastBook の中身。画面の確認とダイアログは除く）
  'resetWorkbookSheets_', 'clearAllNotesOnSheets_', 'buildGUIDE_', 'buildCONFIG_', 'buildSALES_', 'buildFACTORS_PRODUCT_', 'buildFACTORS_CLIENT_',
  'buildOPINIONS_', 'buildDEV_', 'buildPhase1Sheets_', 'buildOUTPUT_', 'normalizeAllSheetNotes_', 'validateNotesIntegrity_',
  'applyDefaultAlignmentForAllSheets_', 'clearAllTabColors_', 'hideNonUserSheets_', 'saveInitialSetupSettings', 'getClientCandidatesForSetup_',
  // 物差し（Backtest.js。表の版 10 の 3-7・決定 9 (b)）: A-9（runForecastFYCore_）の統計の部分を、同じ順で外から呼ぶ。
  // 未確定の月の補完・傾向と季節の当てはめ・残りの分布・季節加重・混合のシミュレーション（中身は変えない）
  'N_SIM', 'KNOWN_SPOT_OFFSET_RATE', 'KNOWN_SPOT_BG_SUPPRESS_RATE', 'normalizeClientName_', 'readSales48Months_', 'sumAcrossProducts_',
  'readModelTuningFromConfig_', 'createDefaultCalibrationState_', 'applyCalibrationToTuning_', 'getForecastContext_', 'adjustForUnclosedMonths_',
  'fitOpsModelTrendSeason_', 'buildResidualPool_', 'percentile_', 'readDlmEngineMode_', 'computeDlmFyForecast_', 'readDlmPrimarySpotCapBasis_',
  'forecastByResidualQuantiles_', 'fitSpotRecurringModel_', 'forecastMonteCarloMixed_', 'forecastSeasonalWeighted48_', 'readForecastClosedMonthMode_', 'buildHistoryAnnualAnchor_', 'buildHistorySpotTiming_', 'redistributeHistorySpotTiming_',
  // 本番の A-9 の中身そのもの（物差しの「統計だけ」が、人の入力の無い本番と差 0 になることをテストで確かめる。app/tests/app-v10-backtest.test.mjs）
  'runForecastFYCore_', 'buildHistoryMonthlyPlanning_', 'allocateAnnualYen_', 'roundMonthlyPointYen_', 'estimateHistoryMonthlyPoint_', 'historySpotTimingReliability_', 'HISTORY_MONTHLY_POINT_METHOD', 'appHistoryProvisionalForecast_', 'appHistoryProvisionalCompact_',
  // 三角測量（段 2。物差しの統計だけ・手法の記録が、本番の A-9 と同じ土台を作る）
  'TRI_METHODS', 'TRI_PRIOR_WEIGHTS', 'readTriangulationEnabled_', 'readTriangulationWeights_', 'computeTriangulationParts_', 'buildTriangulationBase_',
  // AI の時期と効き係数（段 3）
  'AI_MAX_ABS_EFFECT', 'aiMonthWeights_', 'readLearnedEffects_'
];

/** 旧来の Web アプリの、新アプリが受け持つ関数（元の宣言は変えず、包んだ中で後から差し替える） */
export const WEB_OVERRIDES = [
  '  // ===== 新アプリでの差し替え（操作の記録と本人の確認は新アプリの api_ / appAudited_ が行う） =====',
  '  webAudited_ = function (action, fn) { return fn(); };',
  "  webActor_ = function () { return { email: '', isAdmin: false }; };"
];

export function buildEngine(src, webSrc) {
  const sha = createHash('sha256').update(src, 'utf8').digest('hex');
  const webSha = createHash('sha256').update(webSrc, 'utf8').digest('hex');
  const m = /const VERSION = '([^']+)';/.exec(src);
  if (!m) throw new Error('Forecast_Agent.js に VERSION がありません');
  const header = [
    '/**',
    ' * LegacyEngine.js — 旧来の計算（Forecast_Agent.js）と旧来の Web アプリ（Forecast_WebApp.js）をそのまま関数で包んだもの。自動生成: app/tools/build-engine.mjs（手で編集しない）。',
    ' * 元のファイル: Forecast_Agent.js（VERSION ' + m[1] + '、SHA-256 ' + sha + '）',
    ' *               Forecast_WebApp.js（SHA-256 ' + webSha + '）',
    ' * 包んだ中の旧来の関数は外から呼べない。差し替えるもの（' + ENGINE_SERVICES.join('・') + '）は Engine.js の appLegacyServices_ が渡す。',
    ' */',
    'function appLegacyEngine_(__appSvc) {',
    ...ENGINE_SERVICES.map((n) => '  const ' + n + ' = __appSvc.' + n + ';'),
    '  // ===== Forecast_Agent.js ここから（変更しない） =====',
    ''
  ].join('\n');
  const middle = [
    '',
    '  // ===== Forecast_Agent.js ここまで =====',
    '  // ===== Forecast_WebApp.js ここから（変更しない） =====',
    ''
  ].join('\n');
  const footer = [
    '',
    '  // ===== Forecast_WebApp.js ここまで =====',
    ...WEB_OVERRIDES,
    '  return {',
    ...ENGINE_EXPORTS.map((n) => "    " + n + ": typeof " + n + " === 'undefined' ? undefined : " + n + ','),
    "    SOURCE_SHA256: '" + sha + "',",
    "    WEB_SOURCE_SHA256: '" + webSha + "'",
    '  };',
    '}',
    ''
  ].join('\n');
  return { text: header + src + middle + webSrc + footer, sha, webSha, version: m[1], headerLength: header.length, middleLength: middle.length, footerLength: footer.length };
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const src = await readFile(legacyPath, 'utf8');
  const webSrc = await readFile(webPath, 'utf8');
  const built = buildEngine(src, webSrc);
  const cur = await readFile(outPath, 'utf8').catch(() => null);
  if (process.argv.includes('--check')) {
    if (cur !== built.text) { console.error('LegacyEngine.js が Forecast_Agent.js・Forecast_WebApp.js と一致しません（node app/tools/build-engine.mjs で作り直す）'); process.exit(1); }
    console.log('LegacyEngine.js は Forecast_Agent.js・Forecast_WebApp.js と一致（VERSION ' + built.version + '）');
  } else if (cur !== built.text) {
    await writeFile(outPath, built.text);
    console.log('LegacyEngine.js を作り直しました（VERSION ' + built.version + '、' + built.text.length + ' 文字）');
  } else {
    console.log('LegacyEngine.js は最新です');
  }
}
