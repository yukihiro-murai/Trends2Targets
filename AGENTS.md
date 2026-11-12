# AGENTS.md — マルチマシン運用ルール (全AIエージェント共通)

このリポジトリで作業する全ての AI コーディングエージェント (Claude Code / Codex / Grok Build / Hermes Agent / Cursor 等) は、コードに触れる前にまずこのファイルを読むこと。

## マルチマシン Git 同期プロトコル (必須・スキップ禁止)

このリポジトリは Mac mini と MacBook Pro の2台で並行運用されている。
**GitHub (origin) が唯一の正であり、ローカルは常に古い可能性がある。** ローカルの状態だけを見て作業を始めてはならない。

### 作業開始時 — どんな小さな作業でも必ず実行

1. `git branch --show-current` — 今いるブランチが依頼内容と合っているか確認する。
2. `git status` — 未コミット変更・untracked ファイルの有無を確認する。
3. `git fetch origin` → `git status` で ahead/behind を確認し、behind なら `git pull --ff-only`。
4. 別マシンで作られたブランチを引き継ぐ場合は fetch 後に `git switch <branch>`。
5. fast-forward できない (履歴が分岐している)、または未コミット変更とリモート更新が衝突しそうな場合は、**勝手に merge / rebase / stash / checkout せず**、状況を報告してユーザーの指示を待つ。

### 作業終了時・中断時 — 必ず実行

1. 変更を論理単位で commit する。中断時は WIP でも commit する — **push していない作業は、もう一台のマシンからは存在しないのと同じ**。
2. `git pull --ff-only` (push 直前の最終同期)。
3. `git push origin <branch>` (新規ブランチは `git push -u origin <branch>`)。
4. push が拒否されても force push はしない。fetch して状況を報告する。
5. 新アプリ（`app/`）への GAS 反映は、下の「Trends2Targets 固有の決まり」に従い、git push 後に `cd app && clasp -P . status` のあと `clasp -P . push -f` を使う。ルートの旧 GAS へは push しない。`.clasp.json` が無い場合は、GAS エディタへの手動反映が必要なことをユーザーに伝える。

### 禁止事項

- `git push --force` / `--force-with-lease` (ユーザーの明示指示がある場合のみ例外)
- fetch / pull を省略して作業を始めること
- push を完了していないのに「作業完了」と報告すること
- コンフリクトの独断解決 (解決方針を先に報告し、合意してから解決する)

## 共通開発規約

ワークスペースルート (`~/Documents/GAS/`) の `AGENTS.md`・`CLAUDE.md`・`GIT_SYNC_RULES.md` に、GAS 共通のコーディング規約 (V8 / プレーンJS / Logger.log / Script Properties 等) と同期ルールの詳細版がある。読める環境では必ず参照すること。このリポジトリ固有の README・規約ファイルがあればそちらも必ず読むこと。

## Trends2Targets 固有の決まり

このリポジトリで作業するエージェントは、上の同期手順に加えて、次を守る。clasp の手順（このファイルの 24 行、および gas-workspace の `AGENTS.md` 106 行）については、この節を優先する。承認方針（gas-workspace の `AGENTS.md` 155〜158 行）は上書きしない。

### 承認が先の範囲

- 計算・保存・権限・予測の判定・`LegacyEngine.js` の変更は、村井さんの判断が先。公開範囲、oauthScopes、保存先も、明示承認なしに変更しない。

### 公開の許可と手順

- 公開の許可は、新しい作業のたびに Techi 本人へ確認する。許可がある場合の手順は、`app/` で `clasp -P . status` → `clasp -P . push -f` → `clasp -P . deploy -i <公開用デプロイID>`。公開したら版の番号（`@`）を記録し、公開版を読み戻して Git と照合する。
- `clasp push` は HEAD（エディタのコード）を更新するだけで、バージョン固定の Web アプリ公開 URL には反映されない。エディタ HEAD の更新だけで公開済みと報告しない。
- ルートの旧 GAS へは push しない。
- 公開範囲、oauthScopes、保存先、権限の拡大は、明示承認なしに変更しない。

### clasp の push

- 新アプリは `app/` を対象に、`clasp -P . push -f` を使う。これは GAS 側への反映用であり、このファイルの禁止事項および gas-workspace の `AGENTS.md` 118 行にある `git push --force` の禁止とは別物。

### 消さない

- データとファイルは消さず、ゴミ箱にも送らない。古いものはアーカイブへ。削除の判断は村井さん。

### clone と `.clasp.json`

- 公開版の clone は、新規の一時ディレクトリを cwd にして実施する。元の `app/.clasp.json` の rootDir が `src` のままかを確認する。`app/` から clone すると rootDir が書き換わることがある。
- `.clasp.json` はコミットしない。
