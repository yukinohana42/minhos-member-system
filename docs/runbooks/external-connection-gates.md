# 外部接続ゲート Runbook

この文書はGateごとの実行手順です。状態の一覧は `docs/engineering/external-connection-readiness.md`、責任者が一度に行う認証・入力は [接続引継ぎ票](connection-handoff.md) を正本とします。

## 目的と権限

Ghost、Stripe、Google Workspace、YouTube、Dropbox、DNSの接続を段階的に確認します。Codex／実装担当は手順・設定名・read-only検証を支援し、契約、KYC、2FA、初回鍵入力、DNS本番変更、実カード決済は運営責任者本人が承認・実施します。

## Gate 0 — 意思決定

1. 要件書第20章のDEC-01〜DEC-21から該当項目を一覧化する。
2. Tier、価格、税表示、無料・trial・coupon、Form項目、分類、サポート、法務、保存期間、権利、URL再共有リスクを確定する。
3. `docs/engineering/progress-log.md` に承認者、日時、証跡場所を記録する。
4. 未確定のMUSTまたはローンチ必須DECがあれば No-Go とする。

## Gate 1 — 所有者と権限

- [ ] 組織所有のGhost、Stripe、Google、YouTube、Dropbox、ドメインの所有者・副担当・復旧方法を確定した。
- [ ] 管理者、コンテンツ担当、会員管理担当、閲覧者の最小権限を割り当てた。
- [ ] 共有アカウントを使わず、各管理アカウントに2FAを設定した。
- [ ] 担当交代時に全サービスの権限棚卸しを行う責任者を決めた。

## Gate 2 — 秘密境界

1. [秘密情報とローテーション](secrets-and-rotation.md)のインベントリを値なしで作成する。
2. Ghost Admin API key、Stripe restricted key、Google Script Propertiesの保管先・アクセス者・失効方法を確認する。
3. `.env`、鍵ファイル、サービスアカウントJSONをコミットしない。`npm run check:secrets` を実行する。
4. フロントエンド、Sheet、テーマ、ログ、チャットへ秘密値が流れないことを確認する。

## Gate 3 — test mode / 検証環境

### Ghost

- [ ] 現行 `routes.yaml` をGhost Adminからダウンロードしてバックアップし、検証対象の `packages/ghost-theme/routes.yaml` をテーマZIPとは別にアップロードした。`/`、`/updates/`、`/lectures/` と代表投稿URLを確認し、旧routesへ戻せる。
- [ ] 検証サイトまたはローカルGhostで、Portalの登録・magic link・既存会員分岐を確認した。
- [ ] Tier/Price、`paid-members only`、未ログイン・free・有料のHTMLを確認した。
- [ ] Content API、RSS、OGP、メール、検索面に外部URLが出ないことを確認した。ActivityPubが有効な場合は公開アクティビティと連合先も検査し、無効の場合はその状態を記録した。

### Stripe

- [ ] test modeのAccount、Product/Price allowlist、Customer/Subscriptionを確認した。
- [ ] 正常、拒否、3Dセキュア取消、重複申込、`past_due`、`unpaid`、`incomplete`、open Invoice、Refund、Disputeのfixtureまたはtest modeを確認した。
- [ ] 回収失敗の最終動作が `cancel` であることを確認した。

### Google Workspace

- [ ] Standalone Apps Script、Sheet、Form、バックアップDriveが組織所有である。
- [ ] `config/sheets-schema.json` のシステム所有11タブ、保護範囲、所有者、Form照合を確認した。別途、Google Forms native回答タブを`30_Profile_RAW`へ改名し、header・列数・セルを編集せず、Formの回答先Spreadsheet IDとタブ存在だけを確認した。
- [ ] hourly/nightly/manual、LockService、run lease、通知、日次バックアップをtest dataで確認した。

### YouTube / Dropbox / DNS

- [ ] YouTube動画は限定公開、運営プレイリストは非公開、字幕と権利を確認した。
- [ ] Dropbox PDFの版、共有範囲、期限、失効方法、権利を確認した。
- [ ] DNSはレコード案、TTL、メール認証、rollbackのみ確認し、本番変更はG5まで保留する。

## Gate 4 — 受入

1. 要件書AT-01〜AT-45から対象を選び、端末・状態・期待・実結果・証跡を記録する。
2. `npm run verify:all` を実行する（ネットワーク・実決済なし）。オンラインで `npm run audit:packages` も実行し、期限付き例外がある場合は対象、緩和策、再確認日を証跡へ残す。
3. P1/P2の未解決、認証失敗、対象外Account/Price、漏えい、復元不能があれば No-Go とする。
4. AT-29でURL再共有を実地確認し、AT-30で既知制約を責任者が受容する。

## Gate 5 — 本番承認

- [ ] 承認者、作業時間、監視担当、問い合わせ先、停止条件を記録した。
- [ ] Ghost/Sheet/Git等のExportとバックアップを取得した。
- [ ] ロールバック（外部リンク停止、記事下書き、DNS戻し、鍵失効）の手順と権限が確認済みである。
- [ ] 実カード確認、返金・解約は責任者本人が行い、OpsLogへ記録する。

## 失敗時

認証失敗・スキーマ不一致は即停止、課金継続中のGhost会員欠落・`unpaid`・open Dispute・本番／テスト混入はP1です。秘密漏えいは直ちに [秘密情報とローテーション](secrets-and-rotation.md) へ移り、外部URL漏えいは [リンク漏えい・誤公開](incident-link-leak.md) を実行します。
