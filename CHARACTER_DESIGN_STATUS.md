# キャラクターデザイン作業 — 引き継ぎ記録（2026-10-01 更新）

> 2026-10-05: 旧 Web アプリの画面（`Forecast_WebAppUI.html`）と vNext は `archive/vnext-2026-10-05/` へ移した。今の画面は新アプリ（`app/src/UI.html`・`app/src/Assets.js`）。下の記録の中のファイルの場所は当時のもの。

Forecast_Agent 売上予測Webアプリの案内役「よみ」と天気キャラ 8 種の作業記録。2026-09-30 に VM 上の別エージェントから引き継ぎ、2026-10-01 に Claude Code（Mac mini）が v8 で確定させた。

## 依頼の全体像（ユーザー指定・要約）

- 案内役キャラ「よみ」（ひらがな表記）：天気全体を観測し・読み解き・利用者に伝えるキャスター役。天気そのものを表すキャラとは見た目と役割を分ける。「気象観測ロボット」案をユーザーが選択済み。
- 天気キャラ：快晴・晴れのち曇り・曇り・雨・雪・台風・天変地異 ＋ 未確認・霧（データ不足用）。
- 制約：雲をよみ本体・帽子の中心モチーフにしない／カエル不使用／親しみやすくシンプル／小さな表示でも識別可能／フラット・単純図形・テカリ禁止・青系統。
- 計算・保存・権限・予測判定ロジックは変更禁止。本番デプロイはユーザーの最終確認後のみ。キャラクター図鑑への反映が必須。

## 現在の状態（2026-10-01）

| 項目 | 状態 |
|---|---|
| デザイン（9 体） | **v8 で確定**（ユーザー OK 2026-10-01）。正本 `assets/characters/src/cast.py` |
| よみ 5 ポーズ | 作成済み（通常案内・観測中・変化発見・説明中・確認完了）。SVG 正本＋透過 PNG（160/512px） |
| 素材の整理 | `assets/characters/README.md` にファイル名・サイズ・用途。旧 v7 は `assets/characters/archive/v7/` |
| 図鑑登録 | 済み。`shared/character-library/gen.py` にシリーズ「天気予報 (Forecast_Agent)」9 体＋目の部品 2 種（`half` 半目・`swirl` ぐるぐる目）。図鑑 485 体／ERROR は登録前と同じ 29 件（既存キャラ分。追加 9 体の ERROR/WARN は 0） |
| Forecast_Agent への同期 | 済み。`characters.config.json` → `assets/characters/Characters.html`（GAS には上げない。下の「注意」） |
| タブのアイコン（ファビコン） | **本番反映済み（2026-10-01、公開 @29）**。`doGet` → `webSetFavicon_` → `HtmlOutput.setFaviconUrl(FORECAST_FAVICON_URL)`。HEAD と公開版 29 の 21 ファイルがローカルと一致。タブでの見え方は利用者のブラウザで確認（アプリ内ブラウザは社内 SSO で未ログイン） |
| 表示条件・画面への配置 | **本番反映済み（公開 @30、2026-10-01）**（ユーザー「案のとおりで実装して」）。同じ版で段階0（旧 Web アプリを所有者のみ・操作の記録）も反映。当時の画面は `Forecast_WebAppUI.html`。契約テストは `archive/vnext-2026-10-05/tests/forecast-weather.test.mjs`（現行アプリの空模様は `app/src/`・`app/tests/`） |

## v8 デザインの要点

| id | キャラ | v8 での形 |
|---|---|---|
| yomi | よみ | 青いドーム頭＋紺の画面の顔（水色の目）＋頭上に風車型風向風速計（プロペラ＋尾翼、アメダスの形）＋短い手足 |
| kaisei | 快晴 | 太陽（長短交互の光線）＋半目＋ニヤッと口（傲慢顔） |
| harenochi | 晴れのち曇り | 後ろの太陽＝半目＋への字（ムッと睨む）、前の雲＝閉じ目＋ニヤッ（しれっと）。v7 の id `harenchi` から改名 |
| kumori | 曇り | 平たい雲＋大きな半目＋一文字の口 |
| ame | 雨 | 濃い青（#3F74D6）の雲＋「> <」の目＋開いた口（大泣き）＋涙＋しずく形の雨粒 |
| sekka | 雪 | 雲なしの六花（各枝に小枝 2 対）＋淡い六角の芯。図鑑に `yuki`（ゆき）が既にあるため id は `sekka` |
| taifuu | 台風 | 竜巻型。互い違いのレンズ帯でねじれ、上の帯に顔（点目＋〜の口） |
| mousho | 猛暑 | 炎のしずく形の光線 8 本の赤橙の太陽＋汗＋「> <」の目＋舌出し（2026-10-06 追加。予算の 150% 以上の見込み） |
| tenpen | 天変地異 | 燃える尾の岩の彗星＋ぐるぐる目（表情違いでも目は回ったまま）＋火花 |
| mikakunin | 未確認・霧 | 波打つ霧の帯の切れ間から目だけがのぞく（口なし） |

顔はすべて図鑑の共通部品（目2点＋口1本）。図鑑が生成する SVG と `assets/characters/svg/` は一致する（直すときは cast.py と gen.py を両方揃える）。

## 書き出し・検証

```bash
cd assets/characters/src && python3 build.py   # svg/ png/ yomi/ favicon/ review/ と（当時）Forecast_WebApp.js のアイコン区間を作り直す
# 旧 Web アプリ用のファビコン契約テスト（現行ルートには無い）:
#   node archive/legacy-2026-10-04/forecast-favicon.test.mjs
# 現行アプリの模擬テスト全体: npm test
```

PNG 化は Playwright 同梱の chrome-headless-shell（`~/Library/Caches/ms-playwright/`）を直接呼ぶ。ユーザーは HTML/PDF を開けないので、確認には PNG を送る。

## 注意（2026-10-01 に判明）

- **GAS のファイルを増やさない。** 管理ハブの複製は、プロジェクトのファイルが `VNEXT_ADMIN_RUNTIME_FILE_TYPES_`（`VNext_ClientRuntimeProvisioning.js`）の 21 ファイルと完全に一致することを本番でも検査する。新しい `.js` / `.html` を足すと複製が「exactly the 21 clasp-target files」で止まる。タブのアイコンは `Forecast_WebApp.js` の中の自動生成区間に置き、`Characters.html` は `assets/characters/`（GAS 対象外）に出している。画面に組み込むときは既存の HTML に埋め込むか、許可リストの変更とあわせて行う。
- `.claspignore` に `assets/**` を追加した（以前は `!**/*.html` で `assets/characters/chars_v7.html` が GAS 対象に入っていた。本番には上がっていなかった）。
- タブのアイコンは `HtmlOutput.setFaviconUrl` で渡す。ページ内の `<link rel="icon">` は Apps Script に無視される。URL の末尾は `#favicon.png`（拡張子の無い URL・素の data URI は黙って捨てられる。Tanka の 2026-09-30 の記録と同じ）。
- 既存テストのうち 4 件（`vnext-admin-runtime-copy` / `vnext-empty-pilot-upgrade` / `vnext-integration` / `vnext-uat-feedback`）は 3554fdf の時点で古いまま失敗していたが、4008318（別セッション、テストのみ）で現行コードに合わせて直り、2026-10-01 時点で全 11 件 PASS。

## 本番反映（ファビコン）— 2026-10-01 実施済み（公開 @29）

ユーザーの「デプロイして」で実施。
反映先（Apps Script API の projects.get で確認）: Forecast_Agent の `.clasp.json` のプロジェクト（AI_HANDOFF.md の「中央clasp source」、Apps Script 上の名前は「無題のプロジェクト」）＝スプレッドシート「クライアント別売上予測」（`1fNTaJEHoNCBmkto5vvhcVYY5tA1Y4YASDwnqCRgauUk`）のコンテナ バインド スクリプト。
「年度予算策定 管理ハブ」の bound script（Admin Runtime）・社員ポータル・クライアント年度ブックには反映していない（管理ハブ側の更新日時は 2026-09-19 のまま）。
ただしこのプロジェクトは管理ハブの「保守 → 最新版に更新」のコピー元なので、そのメニューを実行すると今回の Webアプリ 2 ファイルの変更も管理ハブ側へ写る（Webアプリ画面だけの変更で、管理ハブの動作には影響しない）。
push 前の照合で、本番 HEAD とローカルの差分は `Forecast_WebApp.js`（アイコン）と `Forecast_WebAppUI.html`（ページ内アイコン 1 行）だけだった。
`clasp push`（21 ファイル）→ 再取得して 21/21 一致 → `clasp deploy -i AKfycbzKsq… -d "クライアント別売上予測 Webアプリ（タブのアイコンをよみに f0595e4）"` で @28 → @29 → 版 29 を取得して 21/21 一致。
**push の直前に `clasp status` が 66 ファイルになっていた。** 別セッションが `.claude/worktrees/<name>/`（リポジトリの中）に作業用ワークツリーを作り、その .js/.html が `!**/*.js` で拾われていた。
`.claspignore` に `.claude/**` を足して 21 ファイル（許可リストと完全一致）に戻してから push した（f0595e4）。push 前は必ず件数と中身（21 件・許可リスト一致）を確かめる。

以降、同じ手順で反映するとき:

1. `clasp status`（21 ファイル）→ `clasp push`（HEAD に反映）。
2. HEAD のデプロイ（`clasp deployments` の `@HEAD`: `AKfycby2pARjKmxoBcOC8-qFjG9QTYieqJ5MtE-yI7-h4BiW`）の `/dev` を開き、外枠の HTML に `link[rel~=icon]` と PNG の base64（`iVBORw0KGgo`）・`#favicon.png` があることを確かめる。
3. 公開デプロイ `AKfycbzKsqTkHbiOS96tG9WHO1rveH8TOOJIchm9EzSeJNPCu2Z5rLEKxWoCzl3JoSWSemogmg`（現行 @28）を `clasp deploy -i <id> -d "<説明>"` で同じ URL のまま版上げし、`/exec` でも同じ確認をする。タブのアイコンは Chrome が覚えているので、変わらなければタブを閉じて開き直す。

## 表示条件（2026-10-01 実装。案のとおり）

`Forecast_WebAppUI.html` の `forecastWeather(ev, upto)` が、検証データ（`webParseEval_` の `compare[]` の `ape` / `signedErr`、`insights[]` の制約超過フラグ `annualBreach` / `halfBreach` / `overBreach` / `rangeBreach`、`hasActuals`）を**読むだけ**で決める。計算・保存・判定ロジックは変えていない。
「最新月」は予測と実績がそろった最後の月。上から順に、当てはまった最初のキャラを出す。数値は `WX_MIN_MONTHS` / `WX_TENPEN_APE` / `WX_TAIFUU_APE`。

| 優先 | キャラ | 条件 |
|---|---|---|
| 1 | 未確認・霧 | 実績が未取込、予測と実績がそろった月が 3 か月未満、または最新月の検証インサイト（B-4）がまだ無い |
| 2 | 天変地異 | 最新月の APE が 150% 以上 |
| 3 | 台風 | 直近 3 か月で誤差の向き（signedErr の符号）が入れ替わり、かつ APE 30% 以上が 2 か月以上 |
| 4 | 雪 | 最新月の `overBreach`（過大予測の超過） |
| 5 | 雨 | 最新月の制約超過が 2 つ以上 |
| 6 | 曇り | 最新月の制約超過が 1 つ |
| 7 | 晴れのち曇り | 超過なしで、APE が 2 か月続けて悪化（3 か月の単調増加。横ばいは数えない） |
| 8 | 快晴 | 超過なし |

注: B-4 の `annualBreach` / `halfBreach` は B-4 実行時点の年間・半期の累計判定で、全月の行に同じ値が入る。`overBreach` / `rangeBreach` は月ごと（`overBreach` は年間の過大超過も含む）。
「B-4 がまだ無い」を霧に含めたのは、案の「データ不足で判定できない」の範囲（超過フラグが無いと判定できないため）。

## 画面への配置（2026-10-01 実装。案のとおり）

| 場所 | キャラ | 実装 |
|---|---|---|
| タブのアイコン | よみ（頭） | `doGet` → `webSetFavicon_`（公開 @29 で反映済み） |
| ホーム「次の一手」 | よみ（通常案内）。前の月から空模様が変わった月は よみ（変化発見）＋「空模様が変わりました：A → B（月）」 | `renderHome` / `wxChange`（旧 `CHAR_ARROW` を置き換え、矢印の口癖「こっちこっち」も外した） |
| 検証画面の上部 | 最新月の天気キャラ＋理由＋制約のチップ（年間・半期・過大・範囲外の OK/超過）＋口癖 | `renderEval` → `wxCardHtml(forecastWeather(B.eval))` |
| データが無いときの空の表示（入力・予測・検証・四半期） | 未確認・霧 | `emptyBox`（旧 `CHAR_GEAR` を置き換え） |
| 処理中 | よみ（観測中）「観測中… 処理しています」を右下に。0.6 秒以上かかる処理だけ | `rpc` → `busyChar` |
| 完了の通知 | よみ（確認完了）を通知の左に。エラーの通知は文字だけ | `showToast` |

絵は `Forecast_WebAppUI.html` の「キャラの絵」自動生成区間（`CHAR_SVG` 9 体・`YOMI_POSE` 5 ポーズ）。`assets/characters/src/build.py` が書き換える（GAS のファイルを増やさないため別ファイルにしない）。
確認用の画面写真（見本データで実際の画面を描画）: `assets/characters/review/placement_impl.png`。

## 参考資料

- `assets/characters/README.md`（素材一覧・サイズ・用途）
- `~/Documents/GAS/shared/character-library/README.md`（図鑑の使い方）
- `DESIGN_bayesian_autolearn_vertex_JA.md`（予測・学習ロジックの設計）／`AI_HANDOFF.md`（Webアプリ全体の引き継ぎ）
