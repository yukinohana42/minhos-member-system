# 同期運用 Runbook

## 対象と正本

Ghost Admin APIから会員・Tier・投影Subscription、Stripe read-only APIからCustomer・Subscription・最新/open Invoice・Refund・Dispute・Product/Priceを取得し、Google Sheetsへ一方向投影します。Ghostがアクセス、Stripeが課金の正本であり、Sheetから逆反映しません。

## 実行種別

| 種別 | 頻度 | 目的 |
|---|---|---|
| hourly | 1時間ごと | 通常の増分・状態反映 |
| nightly | 毎夜 | 全件走査・照合・tombstone |
| manual | 必要時 | システム責任者の復旧・照合 |

`LockService` とrun leaseで並行実行を排他します。`run_id`、実行バージョン、開始／終了、cursor、各APIのページ／件数、insert/update/unchanged/tombstone、例外、完走を `90_SyncLog` へ記録します。

## 開始前

1. Dashboardの直近成功、P1/P2、認証失敗、24時間超過を確認する。
2. 対象Account ID、`livemode`、Product/Price allowlist、schema versionを確認する。
3. 既にrun leaseがあれば二重実行せず、実行者・時刻・期限を確認する。
4. 本番での解約・返金・削除を同期操作として行わない。

## 取得・再試行

- 全ページをcursorで完走し、途中状態を保存して再開する。
- 429は `Retry-After` と指数バックオフ、5xx／timeoutは制限付き再試行を使う。
- 401/403、スキーマ不一致、対象外Account／Priceは即停止・通知する。
- 生値（Ghost status、Stripe status、Invoice status等）と派生値（billing health、primary ops state）を別列へ保存する。

## upsert と不在

- Members: `ghost_site_id + ghost_member_id`。
- Subscriptions: `stripe:{stripe_account_id}:{livemode}:{stripe_subscription_id}`。
- AccessGrants: `ghost:{ghost_site_id}:{ghost_member_id}:{tier_id}:{grant_kind}`。
- Form回答: installable eventの`FormResponse.getId()`を一意キーとして`40_Supplemental.profile_response_id`へ保存し、照合後は`ghost_member_id`を保持する。Google Forms所有の`30_Profile_RAW`へresponse ID列を追加しない。
- 同じ事象の例外は `exception_key` でupsertし、復旧時resolved、再発時reopenする。
- 全ページ取得成功の完走runだけが未観測行をtombstone化できる。途中失敗runでは不在判定しない。自動削除しない。

## 状態確認

- `active`だけで正常と判断しない。`past_due`、`unpaid`、`paused`、`pause_collection`、open Invoice、期間末解約、複数契約を別々に表示する。
- `incomplete/incomplete_expired`は権利を与えない。Stripe非終端契約にGhost会員がなければP1。
- Ghost有料投影と対象Stripe契約の片側欠落を検知する。
- Formの未回答・不一致は課金・アクセスを変えず、例外へ出す。

## 障害対応

| 症状 | 直後の行動 | 優先度 |
|---|---|---:|
| 認証失敗／スキーマ不一致 | 停止、鍵・API版・通知先を確認 | P1 |
| 3回連続失敗／24時間全件未成功 | 例外を一つに抑制し、担当へ通知 | P1/P2 |
| Stripe契約継続・Ghost会員欠落 | 自動修復せず契約と会員IDを照合 | P1 |
| Sheet欠落・破損 | [バックアップと復元](backup-and-restore.md) | P1 |
| 429/5xx/timeout | cursorから制限付き再開 | P2 |

復旧後は同一runの再実行で行・例外・通知が増殖しないことをAT-21/26/38で確認し、SyncLogへ完走と証跡を残します。
