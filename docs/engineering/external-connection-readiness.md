# 外部接続準備チェックリスト

この文書は Ghost、Stripe、Google Workspace、YouTube、Dropbox、DNS の接続前チェックです。チェックが空欄の状態で実アカウント接続・本番変更・実カード決済を行いません。値そのものではなく、確認者・確認日・証跡の場所だけを記録します。

## 共通ゲート

| Gate | 完了条件 | 証跡 |
|---|---|---|
| G0 Decision | DEC-01〜DEC-21の該当項目、MVP境界、既知制約の受容が確定 | 承認記録 |
| G1 Ownership | サービス所有者、復旧担当、管理者・編集者・閲覧者が確定。共有アカウントなし | 権限表 |
| G2 Secret boundary | 鍵の種類、最小権限、保管場所、ローテーション、失効手順が確定。値はGitへ置かない | secrets inventory（値なし） |
| G3 Test mode | test mode／ローカル／検証サイトで正常・失敗・復旧シナリオを実施 | テスト記録 |
| G4 Acceptance | 該当AT、ログ、通知、バックアップ、ロールバックが合格 | AT証跡 |
| G5 Production approval | 本番作業の承認者、時間帯、監視、停止・復旧手順が確定 | Go/No-Go記録 |

## Ghost

- [ ] Publisherプラン、サイト名、ブランド、ドメイン、送信ドメインを確定した。
- [ ] Portalの氏名欄、対象Tier/Price、規約notice、同意checkbox、サポートメールを確定した。
- [ ] Custom Integrationを責任者本人が作成し、Admin API keyの値をCodexへ渡さず安全なScript Propertiesへ登録できる。
- [ ] `ghost_site_id`、Tier ID、Price ID、APIバージョンを非秘密設定へ記録した。
- [ ] `paid-members only`、公開抜粋、Content API、OGP、RSS、メール、検索面から外部URLが漏れないことをtest modeで確認した。ActivityPubが有効なら公開アクティビティと連合先も確認し、無効ならその状態を記録した。
- [ ] 会員削除前にStripe Subscriptionを確認するRunbookと権限境界を確認した。
- [ ] 本番テーマ変更前にJSON、会員CSV、テーマZIP、routes/redirects、資産一覧をExportする。

## Stripe

- [ ] KYC、組織所有アカウント、2FA、復旧手段、担当交代を確定した。
- [ ] restricted keyをread-only用途に最小化し、値はScript Properties等へ責任者本人が登録する。
- [ ] Account ID、`livemode`、対象Product/Price allowlistを `99_Config` の非秘密項目として確定した。
- [ ] retry設定の最終動作を `cancel` とし、`past_due`／`unpaid` の閲覧仕様を責任者が受容した。
- [ ] `active` でも open Invoice があるケース、Refund／Dispute、複数Subscription、`incomplete`／`paused` をtest modeで確認した。
- [ ] 実カード決済、返金、即時解約、Dispute対応はG5後の責任者操作に限定した。

## Google Workspace

- [ ] 組織所有のStandalone Apps Script、Spreadsheet、Form、バックアップDriveを作成する担当を確定した。
- [ ] `initializeMinhosWorkbook()`で固定schemaのシステム所有11タブを作成し、保護範囲を確認した。Google Forms自身が作成したnative回答タブを回答受付前に`30_Profile_RAW`へ改名し、可変header・列数を固定schemaへ合わせる編集やresponse ID列追加をしていない。`80_OpsLog`は追記のみとした。
- [ ] Script Propertiesへ鍵の値を置く場合、Sheet編集者が取得できない所有・権限構成を確認した。
- [ ] hourly／nightly／manual のトリガー、LockService、run lease、通知先、タイムゾーン（Asia/Tokyo）を確認した。
- [ ] 日次35世代バックアップ、月次フルスナップショット、四半期復元試験を設計した。
- [ ] Formは有料welcomeからのみ到達し、回答で権限・課金が変わらないことを確認した。

## コード・依存・終了手順

- [ ] `npm run verify:all` が成功し、Ghost公開URL検査、Apps Script型検査・fixture・build、secret scanが合格した。
- [ ] オンラインで `npm run audit:packages` が成功し、未承認のhigh/critical脆弱性がないことを証跡化した。期限付き例外は `config/dependency-audit-policy.json` の対象・緩和策・再確認日を個別承認する。
- [ ] GitHub Actionsの`verify`が対象commitで成功し、main保護、secret scanning、push protection、Dependabot security updatesが有効である。
- [ ] [サービス終了Runbook](../runbooks/service-shutdown.md) の担当者と停止順を確認し、Ghost停止だけではStripe課金が止まらないことを理解した。

## YouTube / Dropbox / DNS

- [ ] 動画の権利、限定公開、非公開運営プレイリスト、字幕、説明欄の個人情報を確認した。
- [ ] PDFの権利、版、共有権限、期限、リンク停止責任者を確認した。
- [ ] 外部URLの再共有はMVPで防止しないことをAT-29/30で実地確認し、責任者が受容した。
- [ ] DNSの登録者、Ghostレコード、送信ドメイン認証、TTL、rollbackを確認した。

## 禁止事項

- Chat、Git、Sheet、テーマ、ログへ秘密値を貼り付けない。
- Sheetをアクセス制御や請求の正本にしない。
- 本番Stripe接続後に、テスト目的で切断・再接続しない。
- 外部リンク停止前にGhost本文だけを書き換えて済ませない。漏えい・権利問題は外部URLを先に停止する。

実際の認証・秘密値入力を一度にまとめる手順は [接続引継ぎ票](../runbooks/connection-handoff.md) を正本とし、この文書は各Gateの状態表として使用します。
