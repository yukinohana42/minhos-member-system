# 会員ライフサイクル Runbook

## 入会

1. 会員本人がGhost Portalで登録・決済する。
2. StripeのCustomer、Subscription、Account、Price、最新Invoiceと、GhostのTier・有料アクセスを確認する。
3. 次回同期でMembers／Subscriptionsのキーと状態一致を確認する。
4. 有料会員へ重複申込を促さず、Portal／ライブラリへ誘導する。

## 支払失敗

1. Stripeの再試行予定と通知を確認する。
2. `past_due`／`unpaid`中はGhost仕様上アクセスが残ることを説明し、正常課金と同じ表示にしない。
3. Portalの支払方法更新へ案内する。
4. 回収成功または最終 `cancel` 後にStripe、Ghost、Sheetを照合する。`unpaid`、`paused`、`pause_collection` が残ればP1。

## 解約・返金・Dispute

- 期間末解約は `cancel_at_period_end=true` と終了日を確認し、終了日まではアクセスを維持する。
- 解約取消は期間末前に再開し、契約・アクセスを確認する。
- 即時解約、返金、Disputeは本人確認・承認済み方針を確認し、契約継続とアクセス影響を別々に決める。自動判断しない。
- 操作者、理由、日時、before/after、承認者、外部IDを `80_OpsLog` へ追記する。

## 重複契約

自動解約・自動返金をせず、Ghost会員ID、Stripe Customer/Subscription、決済日時を照合し、本人確認後に残す契約と処理を決めます。

## 訂正・削除

メール変更はGhost/Portal起点とし、同じ `ghost_member_id`、`minhos_member_id` へ反映されることを確認します。削除は有効Subscription、法定保存、アクセス停止を先に確認し、ID対応を契約確認前に消しません。Form/Sheetは削除または匿名化を承認済み保存期間に従って行い、Stripe記録は法務・税務方針に従います。
