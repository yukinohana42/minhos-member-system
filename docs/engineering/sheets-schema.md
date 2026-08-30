# Google Sheets スキーマ設計

機械可読な列定義と所有境界は [`config/sheets-schema.json`](../../config/sheets-schema.json) が正本です。システム所有タブは固定列を持ちますが、`30_Profile_RAW`だけはGoogle Formsが管理するnative/opaqueタブであり、固定列定義の対象外です。この文書は、実装者・運用者が所有境界と照合ルールを理解するための要約です。

## 正本の分離

| データ | 正本 | Sheetでの扱い |
|---|---|---|
| 会員・Tier・アクセス | Ghost | `10_Members`へミラー。アクセス判定へ逆反映しない |
| Customer、Subscription、Invoice、Refund、Dispute、Price | Stripe | `20_Subscriptions`/`25_BillingSignals`へミラー。会計帳簿ではない |
| Form回答原本 | Google Forms回答Sheet | `30_Profile_RAW`は編集しない |
| 補足属性・運用メモ | Google Sheets | `40_Supplemental`を列所有で編集 |
| コンテンツの対応台帳 | 運営・Ghost/YouTube/Dropbox | `60_ContentRegistry`。会員管理担当へ原則共有しない |

## タブと更新所有者

| タブ | 1行の単位／主キー | 更新 | 注意 |
|---|---|---|---|
| `00_Dashboard` | 指標／`metric_key` | 数式・同期 | 直接入力禁止 |
| `10_Members` | Ghost会員／`ghost_site_id + ghost_member_id` | 同期 | `minhos_member_id`は不変 |
| `20_Subscriptions` | Stripe契約／`subscription_row_key` | 同期 | comped/giftを空IDで保存しない |
| `21_AccessGrants` | 無償付与／`grant_key` | 同期＋承認手動 | 理由・承認者・期限必須 |
| `25_BillingSignals` | Billing信号／`signal_key` | 同期 | 最新/open中心、全履歴ではない |
| `30_Profile_RAW` | Google Forms native回答行／システム主キーなし | Formのみ | header・列数はForm所有。Script／運営者は読取・作成・編集しない |
| `40_Supplemental` | 会員補足／`minhos_member_id` | 照合・運営者列 | override優先のeffective列 |
| `50_Exceptions` | 例外／`exception_key` | 同期＋運営者列 | 同一事象をupsert、復旧時resolved |
| `60_ContentRegistry` | レクチャー／`lecture_id` | コンテンツ担当 | 共有リンクを含むため限定共有 |
| `80_OpsLog` | 操作／`ops_log_id` | 追記のみ | 返金・削除・付与等を記録 |
| `90_SyncLog` | 同期run／`run_id` | 同期 | cursor、完走、件数、版を記録 |
| `99_Config` | 非秘密設定／`config_key` | システム責任者 | API鍵・OAuth tokenを置かない |

### `30_Profile_RAW`の特別境界

- Formを対象Spreadsheetへ接続してGoogle Forms自身に回答タブを作らせ、そのタブを回答受付前に`30_Profile_RAW`へ改名します。
- Formの設問追加・順序変更・言語設定によりnative headerと列数は変わり得るため、Apps Scriptはheaderの固定一致、列数、行番号、timestampを検証キーにしません。
- Google Forms native回答Sheetには永続response ID列がありません。installable `onFormSubmit` eventの`FormResponse.getId()`を処理IDとし、一意照合後に`40_Supplemental.profile_response_id`へ保存します。競合時は同じIDだけをretry queueへ保存します。
- initializerとrepositoryはRAWを作成・読取・更新しません。trigger installerはForm ID、回答先Spreadsheet ID、`30_Profile_RAW`の存在だけを確認し、RAWセルには触れません。
- 設問タイトルは`config/form-blueprint.json`とScript Propertiesの項目名を照合します。RAWの物理headerをシステムschemaへ合わせるために編集してはいけません。

## Dashboard必須指標

`00_Dashboard` は汎用の自由入力欄ではなく、`config/sheets-schema.json` の `requiredMetrics` を同期処理が毎回再生成します。最低限、登録・有料・無料/権利なし会員、`past_due` / `unpaid` / `paused` / `pause_collection`、open Invoice、期間末解約、重複契約、open Dispute、プロフィール未回答/要確認、P1/P2、通常/全件同期時刻・結果、Publisher使用率と800/900警告、staff/pending invitationを別々に表示します。取得を自動化していないstaff値は `99_Config` の非秘密な手動確認値を使い、未設定を0件と誤表示しません。

## 同期不変条件

- GhostとStripeのraw値と派生状態を別列へ保存します。`active`だけを正常判定にしません。
- 全ページ取得成功時だけmark-and-sweepを実行し、未観測行はtombstone化します。途中失敗では不在としません。
- `LockService` とrun leaseで hourly/nightly/manual を排他し、同じ行・例外・通知を増やしません。
- 429は `Retry-After` と指数バックオフ、5xx/timeoutは制限付き再試行、401/403・スキーマ不一致は即停止・通知です。
- 対象Stripe Account、`livemode`、Product/Price allowlistを先に検証し、対象外データを取り込みません。
- SheetからGhost/Stripeへ更新、統合、解約、返金、削除をしません。

## 個人情報・バックアップ

住所、カード情報、KYC、本人確認資料、秘密鍵、Webhook secret、OAuth tokenは保存しません。システム列と共有範囲を保護し、手動正本を含むSheetを権限制限された別Driveへ日次バックアップ（35世代）し、月次フルスナップショットと四半期復元試験を行います。
