# 外部接続ゲート Runbook

この文書はGateごとの実行手順です。状態の一覧は `docs/engineering/external-connection-readiness.md`、責任者が一度に行う認証・入力は [接続引継ぎ票](connection-handoff.md) を正本とします。

## 目的と権限

Ghost、Stripe、Google Workspace、YouTube、Dropbox、DNSの接続を段階的に確認します。Codex／実装担当は手順・設定名・read-only検証を支援し、契約、KYC、2FA、初回鍵入力、DNS本番変更、実カード決済は運営責任者本人が承認・実施します。

## Gate 0 — 意思決定

1. 要件書第20章のDEC-01〜DEC-21から該当項目を一覧化する。
2. Tier、価格、税表示、無料・trial・coupon、Form項目、分類、サポート、法務、保存期間、権利、URL再共有リスクを確定する。
3. `docs/engineering/progress-log.md` に承認者、日時、証跡場所を記録する。
4. 未確定のMUSTまたはローンチ必須DECがあれば No-Go とする。

### G0-T — 限定test entry（Gate 0完了ではない）

要件書20.1の`DEC-01`〜`DEC-08`、`DEC-19`、`DEC-21`を確定し、Gate 1とGate 2が完了した場合に限り、要件書20.2の本番必須DECを未決のまま隔離testへ進める。`G0-T`は`G0 Decision`の完了、production承認、または未決DECの受容を意味しない。

- test用Ghost site、Stripe test mode、test専用Standalone Apps Script／Spreadsheet／Form／Driveだけを使用し、test/liveを分離する。
- 架空会員、運営所有のダミー動画／PDF／URLだけを使用する。実会員情報、既存講義資産、実YouTube／Dropbox共有URLを扱わず、外部公開しない。扱う場合は関連する本番必須DECを先に確定する。
- `G0-T`の初回承認は`manualSync()`1回と、実行時間上限時にコードが自動作成する一時`resumeSync` triggerだけを許可する。初回同期、環境／Account／allowlist／schema、通知、backup／restoreを確認し、trigger作成前までに検出したP1/P2が0であることを証跡化した後だけ、責任者の別承認で`installMinhosTriggers()`と5つの永続trigger（`hourlySync`、`nightlySync`、`dailyBackup`、`monthlyBackup`、`onProfileFormSubmit`）を作る。trigger試験でP1/P2が出た場合は停止する。
- 本番DNS、実カード、本番課金、実会員の課金・権限変更は行わない。承認済みGate 3ケースに必要なisolated Ghost test会員とStripe test objectだけはtest環境内で作成できる。同期実装からGhost／Stripeへは書き込まない。
- readinessには`G0-T APPROVED`、`G0 OPEN`、`production NO_GO`を同時に記録し、承認者、時刻、値なし証跡参照を残す。

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

Gate 3へ入るには、完全なGate 0、または上記`G0-T`とGate 1／2の完了が必要である。`G0-T`経由では上記の隔離条件をGate 3全体で維持する。

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
