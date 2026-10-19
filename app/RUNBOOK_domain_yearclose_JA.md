# 社内公開（DOMAIN）と年度締め — 所有者 Mac 手順（安全版）

対象: Trends2Targets（`app/`）。**クラウドエージェントは clasp 認証も本番 Drive も無いため、ここにある実行はすべて所有者の Mac で行う。**
ロールバックと前提を満たせないときは止める。データを消さない・ゴミ箱に送らない。

## A. 社内公開（MYSELF → DOMAIN）

### 前提（すべて満たしてから）
1. この PR が merge され、ローカル `master` が最新
2. `listDirectory` で予算策定担当・承認者の役割が付いている（社内ドメインの人は閲覧・情報提供が自動）
3. `health` が重大な要確認なし
4. 公開 URL を渡す相手が決まっている

### 手順
```bash
cd ~/Documents/GAS/Trends2Targets   # 環境に合わせて
git fetch origin && git checkout master && git pull --ff-only
cd app
clasp -P . status          # GAS 対象が src 配下であること
clasp -P . push -f
clasp -P . deploy -i AKfycbyOjx4LkD0RPzGC4-Lx9eCMVxFJHPSVJHhMjUnq12jmoBEp-4yEKzZhxE-5prwUcd6dig -d "DOMAIN 社内公開"
```

公開版の `webapp.access` が `DOMAIN` であることを Apps Script のデプロイ設定または API で確認する。

### ロールバック
同じ deploy ID で、`app/src/appsscript.json` の `access` を `MYSELF` に戻した版を push → deploy。URL は変わらない。

### 注意
- 裏のトリガーは **最後に push したコード** で動く。push したら同じ内容で deploy まで続ける
- ルートの `.clasp.json` からは push しない（旧アプリ）

## B. 年度締め（実操作・不可逆）

実装済み（v0.24.0）。**元の行は残したまま読み取り専用化**。開き直し・行の移動はない。締めは元に戻せない。

### 前提
1. 締める年度は **今年度より前**（例: 今日が FY2026 中なら FY2025 以前）
2. その年度の **全計画に承認済み公式版**がある
3. 保存の控え・承認待ち・実行中ジョブがない（`yearPreview` が教えてくれる）
4. 直前にバックアップがあること（`runBackup` 推奨）

### 手順（エディタ・OWNER_TASK）
1. バックアップ: `{"action":"runBackup"}`
2. 確認のみ: `{"action":"yearPreview","fy":2025}`  
   - `canClose: true` と `inputHash`（64 桁）を控える  
   - `false` なら理由を直し、締めない
3. 締める: `{"action":"yearClose","fy":2025,"inputHash":"（上の inputHash）"}`  
   - `OWNER_TASK` が `jobStatus` に置き換わる → 数分後にもう一度 `apiOwnerTask` で `DONE` を確認
4. 再確認: `yearPreview` が閉じ済み理由になる／`health`・画面に凍結印

### 止めどころ
- `canClose` が false → **絶対に yearClose しない**
- 指紋がプレビュー後に変わった → もう一度 yearPreview から
- 実データへ触れない環境 → この文書の手順だけ用意し、実行は所有者 Mac に委ねる（本クラウド実行は未実施）
