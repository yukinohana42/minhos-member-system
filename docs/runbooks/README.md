# Runbook 索引

この索引は、MVPの運用・接続・復旧を非技術者が同じ判断で実行するための入口です。すべてのRunbookで、操作者、実行日時（UTC保存／JST表示）、対象ID、判断、証跡、承認者、戻し方を記録します。

## 接続・リリース

- [外部接続ゲート](external-connection-gates.md): Ghost、Stripe、Google Workspace、YouTube、Dropbox、DNSの準備・test mode・本番承認。
- [Ghost Admin 初期設定](ghost-admin-setup.md): Portal、Tier、welcome email、送信ドメイン、テーマ所有ナビゲーションの設定・証跡・rollback。
- [接続引継ぎ票](connection-handoff.md): 責任者が一度だけ行う認証・秘密値入力と、Codexが続けて行う設定・検証の境界。
- [リリース Go/No-Go](release-go-no-go.md): AT証跡、P1/P2、DEC項目、バックアップ、ロールバック。
- [GitHub初期公開・保護](github-controls.md): CI成功後のmain保護、secret scanning、通常PR運用。
- [秘密情報とローテーション](secrets-and-rotation.md): 値を記録せず、最小権限・失効・再発行を行う。

## 定常運用

- [同期運用](sync-operations.md): hourly/nightly/manual、cursor、再試行、例外、tombstone、通知。
- [コンテンツ公開](content-publish.md): YouTube、Dropbox、Ghost記事、字幕・権利・外部URL漏えい確認。
- [会員ライフサイクル](member-lifecycle.md): 入会、支払失敗、解約、返金、重複、情報訂正・削除。
- [サービス終了](service-shutdown.md): 新規申込停止、Stripe契約処理、Ghost反映、会員通知、最終Exportの順序。

## 復旧・障害

- [バックアップと復元](backup-and-restore.md): Sheet/Ghost export、世代管理、四半期復元試験。
- [リンク漏えい・誤公開](incident-link-leak.md): 外部リンクを先に停止し、影響と再発防止を記録する。

## 共通禁止事項

- カード情報、API鍵、Webhook secret、OAuth token、2FAコードをGit、Sheet、ログ、チャットへ貼らない。
- SheetをGhostアクセスやStripe課金の判断に使わない。
- 本番Stripe接続後にテスト目的で切断・再接続しない。
- 外部サービスの状態が未確認のまま「成功」や「復旧済み」と報告しない。
