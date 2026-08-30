# サービス終了 Runbook

Ghostサイトを停止・解約してもStripeのSubscriptionは自動停止しません。必ず以下の順で実施し、各段階の件数、操作者、承認者、日時、証跡を `80_OpsLog` または終了記録へ残します。

## 事前承認

- [ ] 終了日、新規申込停止日、最終提供日、返金・日割り方針、問い合わせ期限を責任者と法務・税務担当が承認した。
- [ ] Ghost、Stripe、Google Workspace、YouTube、Dropbox、DNSの所有者と作業担当を確定した。
- [ ] 会員への事前通知文を承認し、外部URLや秘密情報を本文へ含めていない。
- [ ] 全対象Subscription、期間末、未払、返金、Dispute、comped/giftの件数を記録した。

## 停止順序

1. Ghostの新規Signup・対象Tier申込を停止し、新しい契約が作られないことを確認する。既存会員の必要なアクセスは終了日まで維持する。
2. 承認済み方針に従い、Stripeで各Subscriptionを期間末解約または即時解約する。返金は別操作として承認者本人が実施し、自動一括処理しない。
3. Stripeで新規・継続予定のSubscriptionが0件になったこと、open Invoice・未払・返金・Disputeの残件を確認する。
4. Ghostへ契約状態が反映され、有効なpaid/comped/gift権限が終了方針と一致することを確認する。Ghost会員を先に削除しない。
5. 会員へ終了、最終閲覧日、資料の扱い、問い合わせ・返金窓口を通知する。通知にはGhost上の案内ページだけを載せ、YouTube/Dropboxの生URLを載せない。
6. GhostコンテンツJSON、会員CSV、テーマZIP、`routes.yaml`、`redirects.yaml`、資産一覧、Stripeの必要な法定記録、Sheet/Form、Apps Scriptコード・設定名、バックアップを最終Exportする。
7. 復元試験とExportの読み取りを確認してから、YouTube/Dropbox共有、Apps Script trigger、鍵、Sheet共有、DNS、Ghost契約を順に停止する。法定保存対象は承認済み期間まで保護する。

## 完了条件

- [ ] Stripeに意図しない継続課金・再試行予定がない。
- [ ] Ghostアクセス、返金・Dispute、会員通知、問い合わせ先が終了方針と一致する。
- [ ] 最終Export、保管期限、削除予定日、復元担当が記録されている。
- [ ] API鍵・OAuth許可・2FA復旧手段・共有権限の失効または継続理由が記録されている。

不一致または課金残存はP1です。GhostやDNSを先に停止せず、Stripeと会員連絡を復旧してから再開します。
