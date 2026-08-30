# みんほす Ghost / Stripe → Google Sheets 同期MVP

スタンドアロン Google Apps Script で、Ghost Admin API と Stripe read-only API から Google Sheets の運用台帳へ一方向同期し、Google Formのinstallable `onFormSubmit` eventを安全に照合するTypeScript実装です。SheetからGhost/Stripeへの書戻し、Webhook受信、自動解約・返金・統合・削除は実装していません。

このディレクトリの実装とテストは実アカウントへ接続せず、fixtureだけで検証できます。本番接続は要件承認とアカウント準備後に、システム責任者が秘密値を Apps Script の Script Properties へ本人入力してから行います。

## 実装範囲

- Ghost会員、Tier、投影Subscription、comped/giftの取得と変換
- Stripe Account境界、Customer、`status=all` Subscription、Product/Price allowlist、latest/open Invoice、Refund、Disputeの取得と変換
- Ghost pagination metadataの完全性検査、Stripe Subscriptionの単一item制約とPrice/Product allowlist検査、Billing signalの当該run対象契約へのscope照合
- `ghost_site_id + ghost_member_id`、Stripe Account/livemode/Subscription ID、grant種別を含む複合主キーによる冪等upsert
- Ghostアクセス、Stripe課金、運用例外を混ぜない3軸状態
- 全ページ完走時だけのmark-and-sweep（行削除ではなくtombstone）
- 完走した夜間走査で未観測open InvoiceをID再取得し、`paid`/`void`だけを解決、`open`/`uncollectible`等はraw statusを更新して要対応のまま残す処理
- 429の`Retry-After`、指数バックオフ、5xx/timeout再試行、401/403・schema mismatch即時停止
- grid拡張をclearより先に行い、書込み失敗時に旧内容を復元するSheet安全書込み
- ページ単位のSheet書込み（Refund／Disputeと未観測Invoice再取得は10件chunk・item単位partial commit）、環境namespace＋config fingerprint付きcursor、不正/設定不一致cursorのlock内隔離・消去、実行時間接近時の再開トリガー
- `LockService`と期限付きrun leaseによるhourly/nightly/manual/resume排他、N+1処理中の定期renewとSheet書込み直前のrun-id fencing
- 例外キーupsert、reopen/resolve、非緊急不一致の連続2回猶予、初回・状態変化・復旧だけの通知
- 通知差分を1件ずつnamespaced Script Propertyへ置くoutbox（最大50件/メール、安定通知ID、Mail失敗retry、送信済み→Sheet ackの二段階commit）
- 永続Form response ID、trim+lowercase完全一致、unverified Supplemental、未一致/複数一致/再回答例外、Formと同期の例外台帳更新を共有Script Lockで直列化
- `40_Supplemental`全行のminhos/ghost pairを`10_Members`へ双方向照合し、nonblank Form response IDの型・trim・全体一意性をreadと全書込み入口でfail-closed検査
- `profile_status`をSupplementalの回答有無・`verification_status`から`not_submitted`/`review_required`/`matched`の3値だけに導出
- 日次/月次別retention、最低世代、1回削除上限、read-only環境marker事前検査とsync leaseを備えたSpreadsheetバックアップ
- 正本schemaに完全一致する同期ログ、必須25指標Dashboard、800/900登録会員警告

## 構成

```text
src/domain/      Apps Scriptに依存しない純粋関数・型・変換・照合
src/adapters/    UrlFetchApp、SpreadsheetApp、LockService、DriveApp等
src/sync/        ページ単位の同期・再開・照合オーケストレーション
src/index.ts     Apps Scriptから呼ぶグローバル関数の入口
test/fixtures/   Ghost/Stripeの匿名fixture
test/            主要不変条件のunit tests
dist/            build生成物（Git管理外）
```

秘密値をdomain層、fixture、Sheet schema、同期ログ、Dashboardへ渡さない設計です。APIエラーは資格情報らしい文字列をredactして最大1,000文字に制限します。

## ローカル検証

Node.js 22以上を使います。

```powershell
cd packages/apps-script
npm ci
npm run verify
npm audit
```

`npm run verify` はTypeScript型検査、Vitest、Apps Script用IIFE bundleの順に実行します。生成物は `dist/Code.js` と `dist/appsscript.json` です。

デプロイ補助は公式 `@google/clasp` 3.4.0（Apache-2.0、Node.js 20以上）をdevDependencyへ固定しています。`npm run clasp:status` はローカル/remote差分確認、`npm run deploy` は必ず`verify`合格後に`clasp push`を実行します。両者は`.clasp.json`とGoogle認証を必要とする外部接続コマンドであり、接続Gate承認前には実行しません。この実装作業ではlogin/pushを実行していません。

## Script Properties

名称一覧は `script-properties.names.json` にもあります。値を `.env`、Git、Sheet、README、チャット、ログへ貼らないでください。

| 名称 | 秘密 | 内容・初期値 |
|---|:---:|---|
| `GHOST_ADMIN_API_KEY` | はい | Ghost Custom Integrationの`id:secret`。Apps Script UIで本人入力 |
| `STRIPE_RESTRICTED_KEY` | はい | `rk_live_...`または`rk_test_...`。Apps Script UIで本人入力 |
| `SPREADSHEET_ID` | いいえ | 運用Spreadsheet ID |
| `GHOST_ADMIN_URL` | いいえ | Integration画面のHTTPS Admin domain。末尾slash不要 |
| `GHOST_SITE_ID` | いいえ | サイトを不変に識別する内部ID。`:`は禁止 |
| `GHOST_ACCEPT_VERSION` | いいえ | 固定値。初期値`v5.0` |
| `STRIPE_ACCOUNT_ID` | いいえ | 期待する`acct_...` |
| `STRIPE_API_VERSION` | いいえ | 必須固定値`2025-02-24.acacia` |
| `STRIPE_LIVEMODE` | いいえ | 本番`true`、試験`false` |
| `STRIPE_PRICE_ALLOWLIST` | いいえ | 対象Price IDのcomma区切り |
| `STRIPE_PRODUCT_ALLOWLIST` | いいえ | 対象Product IDのcomma区切り |
| `OPS_NOTIFICATION_EMAIL` | いいえ | 組織所有の運営通知先 |
| `BACKUP_FOLDER_ID` | いいえ | 権限制限した別Driveフォルダ |
| `BACKUP_RETENTION_DAYS` | いいえ | 省略時35 |
| `BACKUP_MONTHLY_RETENTION_DAYS` | いいえ | 月次コピー。省略時730 |
| `GOOGLE_FORM_ID` | いいえ | profile FormのID。trigger install時に必要 |
| `PROFILE_EMAIL_ITEM_TITLE` | いいえ | 省略時`Ghost登録メールアドレス` |
| `PROFILE_AFFILIATION_ITEM_TITLE` | いいえ | 省略時`所属` |
| `PROFILE_TITLE_OR_ROLE_ITEM_TITLE` | いいえ | 省略時`肩書き・役割` |
| `PROFILE_PARTICIPANT_TYPE_ITEM_TITLE` | いいえ | 省略時`参加区分` |
| `PROFILE_PRIVACY_ACK_ITEM_TITLE` | いいえ | 省略時`利用目的と窓口を確認しました` |
| `MAX_RUNTIME_MS` | いいえ | 省略時270000。30000〜300000の整数だけ許可し、15秒の終了reserve前にcursor保存 |
| `BILLING_WATERMARK_OVERLAP_SECONDS` | いいえ | 省略時172800（48時間重複） |
| `SCHEMA_VERSION` | いいえ | 省略時1 |
| `CODE_VERSION` | いいえ | SyncLogへ記録するリリース版 |

Stripe keyはAccount、Customers、Subscriptions、Invoices、Charges、PaymentIntents、Refunds、Disputes、Products、PricesをReadにしたrestricted keyだけを使用します。`sk_...`は設定検証で拒否します。Ghost Custom Integration keyは権限をGET限定にできないため、HTTP adapter自体が`GET`以外を受け付けません。

`99_Config`には秘密を置きません。`GHOST_STAFF_COUNT_MANUAL`と`GHOST_PENDING_INVITATION_COUNT_MANUAL`を非負整数で手動設定するとDashboardへ反映します。未設定・不正値は`0`ではなく`not_configured`です。初期化処理はsystem-owned notice/環境marker行だけをin-place更新し、operator行と`updated_by`を全件rewriteしません。

通知outboxとForm retry queueは、Apps Scriptの1 property valueあたり9KB制限へ依存しないよう1 itemを1 propertyへ分割します。各JSON valueはUTF-8で8KB以下、queue全体は1,000件かつvalue合計200KB以下に制限し、超過時は黙って捨てず`*_CAPACITY_EXCEEDED:P1`相当で停止します。通知outboxはメール・氏名・回答本文を保存せず、安定通知ID、例外キー、種別、severity、時刻、delivery stateだけを保存します。

## 初回デプロイ（アカウント接続フェーズで実施）

1. 組織所有Googleアカウントでスタンドアロン Apps Script projectを作る。
2. `npm ci && npm run verify` を通す。
3. `.clasp.json.example`を参考に、Git管理外の`.clasp.json`へproject IDを設定する。Gate承認後だけ本人が`npx clasp login`し、`npm run clasp:status`を確認して`npm run deploy`する。
4. Script Propertiesへ上表を設定する。秘密値はシステム責任者が本人入力する。
5. `initializeMinhosWorkbook()` を一度実行し、read-only環境marker事前検査後に固定schemaのシステム所有11タブとheaderを作る。Google Form所有の`30_Profile_RAW`はこの11タブに含めず、作成・参照・編集しない。marker不一致時は初期化を含めSheetへ書かない。
6. test環境（`STRIPE_LIVEMODE=false`、test restricted key、test allowlist）で `manualSync()` を実行する。
7. `90_SyncLog`、`50_Exceptions`、複合主キー、件数、API環境境界を確認する。
8. `dailyBackup()` を実行し、別フォルダに復元用コピーができることを確認する。
9. 回答受付前にForm回答先を同じ運用Spreadsheetへ接続し、Google Formsが新規作成した回答タブを`30_Profile_RAW`へ改名する。項目タイトル・順序・回答タブを目視確認し、Apps Scriptや運営者はRAWセル・header・式を編集しない。Form native sheetには永続response ID列がないため、`response.getId()`の正本コピーはevent処理が`40_Supplemental.profile_response_id`へ保存する。
10. システム責任者の承認後、`installMinhosTriggers()`でhourly/nightly/daily/monthly/Form triggerを差分作成する。

Sheet-bound scriptやSheetメニューは作りません。Sheet編集者とScript編集者を分け、手動同期は承認済みのスタンドアロンprojectからだけ実行します。

## 実行関数

| 関数 | 用途 |
|---|---|
| `hourlySync()` | Ghost全会員、Stripe全status Subscription、latest Invoiceを同期。欠落tombstoneはしない |
| `nightlySync()` | 上記にopen Invoice、Refund、Dispute、追跡中signal、全件mark-and-sweepを追加 |
| `manualSync()` | 権限を持つシステム責任者向けの完全走査 |
| `resumeSync()` | 保存cursorから再開。通常は一時triggerが呼ぶ |
| `dailyBackup()` | Spreadsheet全体を別フォルダへコピーし、同種dailyの35日超をゴミ箱へ移動 |
| `monthlyBackup()` | 月次フルコピー |
| `initializeMinhosWorkbook()` | 固定schemaのシステム所有11タブ・headerを作る。Form所有のRAWには触れず、秘密値は書かない |
| `onProfileFormSubmit(e)` | Form永続response IDを使って一意照合。RAW・課金・閲覧権限を変更しない |
| `retryProfileFormSubmissions(e)` | sync/別Form処理との競合時に、永続queueのresponse IDをFormから再取得して再処理する一時trigger入口 |
| `installMinhosTriggers()` | 欠落triggerを先に作り、作成成功後に同一handler重複だけを整理 |

## Google Form所有境界

`30_Profile_RAW`はGoogle Formだけが作成・所有し、本コードはinitialize/read/writeしません。Form native回答タブには永続response IDが出力されないため、RAWへID列を自動追記せず、installable eventの`response.getId()`を`40_Supplemental.profile_response_id`へ保存します。Ghostメールとの照合はtrim+lowercaseだけの完全一致です。一意一致でも`verification_status=unverified`です。未一致、複数一致、新しいresponse IDによる再回答は`50_Exceptions`へ記録し、既存Supplementalを上書きしません。同一eventの再送はno-opです。

Form sourceのIDは`GOOGLE_FORM_ID`と完全一致を必須にします。同期とForm処理は同じglobal run leaseとScript Lockを使うため、Members snapshotとExceptions更新の途中へ別処理が割り込みません。競合時はメールや回答値をScript Propertiesへ保存せず、`formId / responseId / queuedAt`だけを環境namespace付きitem propertyへ永続化し、one-shot retry triggerがFormから回答を再取得します。Form結果からGhostアクセスやStripe課金を変更する経路はありません。

`40_Supplemental`追加時、外部値はすべて数式インジェクション対策を通して`setValues`し、`effective_affiliation / effective_title_or_role / effective_participant_type`だけを専用の`setFormulaR1C1`経路で `=IF(RC[-3]<>"",RC[-3],RC[-6])` として設定します。つまり運営overrideが非空ならoverride、それ以外は対応Form値です。検証状態は別列で保持し、effective値を課金・アクセス判定には使いません。RAWはvalues/formulasとも変更しません。

`40_Supplemental`の既存行は、trim済みのnonblank `minhos_member_id / ghost_member_id`が同一のMembers行へ両方向に一致し、nonblank `profile_response_id`が文字列・trim済み・全行一意でなければreadもwriteも停止します。過去移行由来の`profile_response_id=""`は、既に存在する同一`minhos_member_id`行を読む・そのまま保つ場合だけ明示的に許可します。新規blank行の作成、nonblankからblankへの消去、空白だけの値、非文字列は許可しません。

`10_Members.profile_status`はGhost payloadから推測しません。該当Supplemental回答なしは`not_submitted`、回答ありかつ未検証は`review_required`、運営検証済みは`matched`として同期し、`unknown`等の値は書きません。

## API仕様の固定と自己監査

- Ghost Membersは`include=tiers,subscriptions`とpage/limitで全ページを取得します。公式仕様では`subscription.customer`は`{id,name,email}`で、comped/gift synthetic subscriptionは`id`と`customer.id`が空文字です。本実装はその形をfixtureで固定しています。[Ghost Members Admin API](https://docs.ghost.org/admin-api/members/overview)
- Ghost JWTはリクエストごとにHS256で生成し、`aud=/admin/`、`exp-iat=240秒`、固定`Accept-Version`を送ります。[Ghost Admin API authentication](https://docs.ghost.org/admin-api)
- Stripe Subscription listは省略時にcanceledを返さないため、必ず`status=all`を送ります。listはlimit 100、`has_more`と最後のobject IDを`starting_after`へ渡して完走します。[List subscriptions](https://docs.stripe.com/api/subscriptions/list), [Pagination](https://docs.stripe.com/api/pagination)
- MVPはStripe Subscriptionを単一itemに限定し、複数itemは全itemがallowlist内でもrunを停止します。単一itemのPrice/Productがallowlist外でも停止し、黙ってskipしません。latest/open Invoice、Refund、Disputeも、同じrunで観測した対象Subscriptionへ照合できたものだけ主台帳へ入れます。照合不能Refund/Disputeは`50_Exceptions`へ`UNMATCHED_BILLING_SIGNAL`として永続隔離し、自動紐付けしません。
- open Invoiceは`status=open`、limit 100、同じcursor方式で全ページを取得します。前回要対応なのに今回のopen listで未観測のInvoiceはIDでretrieveし、`paid`/`void`だけ解決します。`open`/`uncollectible`とその他の非確定状態はraw statusを更新し要対応を維持します。[List invoices](https://docs.stripe.com/api/invoices/list)
- Refundは`pending`/`requires_action`に加え、成功した全額（または安全に部分と断定できない）Refundも運営判断まで要対応です。`failed`/`canceled`は終端状態として`25_BillingSignals`に監査可能な行を残します。運営が対応不要と判断した例外は`ignored`として明示記録します。
- full Refund判定はexpanded Chargeの`amount_refunded`を優先し、同一Chargeの複数partialが累積でCharge総額へ達した場合も要対応にします。追跡中Refund/Disputeは`signal_key`安定順のitem cursorを各成功書込み後に保存し、runtimeをまたいでもN+1から再開します。`ignored/resolved`の運営判断済み例外は再取得対象から外します。
- Disputeは初回完走まで`created[gte]`を付けず全履歴をpage cursorで走査し、古いopen Disputeを90日既定値で落としません。完走marker後だけ重複期間付きwatermarkへ切り替えます。
- 本MVPはStripe APIを`2025-02-24.acacia`へ固定します。AcaciaのCharge/PaymentIntent→InvoiceとInvoice→Subscription、Subscription top-level periodを前提に、Refund/Disputeを安全に照合します。[Acacia release](https://docs.stripe.com/changelog/acacia)
- Basil `2025-03-31`以降ではInvoiceのsubscriptionが`parent.subscription_details.subscription`へ、Subscription期間がitemへ移動し、Charge/PaymentIntentのinvoice pointerも削除されます。pure mapperは前二者の新旧形をfixtureで扱いますが、API client全体のBasil移行はInvoice Paymentsを含む別の互換性変更として実施し、設定値だけを先に変更してはいけません。[Invoice parent change](https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects), [period change](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end), [Invoice Payments change](https://docs.stripe.com/changelog/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices)

## fixture受入対応

- AT-20/21/22/31/39: Ghost/Stripe変換、メール変更に強いID、comped/gift複合キー、冪等キー
- AT-25/40: 完走時のみmark-and-sweep、tombstone、手動列保持
- AT-26: 例外upsert、連続2回猶予、初回・変化・復旧通知、抑制
- AT-33/35: `past_due/unpaid/paused/pause_collection`とopen/latest Invoiceを別状態で保持
- AT-36: partial/full・pending/succeeded/failed/canceled Refund、open/resolved Dispute、null・未照合隔離経路
- AT-37: Account、livemode、Product/Price allowlist、restricted key環境、固定API版
- AT-38: lease純粋判定とApps Script `LockService` adapter
- AT-24/34: Form永続ID、一意/未一致/複数/再回答、profile 3状態、Ghost有料だが有効契約/付与なし
- AT-44: Dashboard必須25指標、staff/pendingの`not_configured`表現

実API疎通、Apps Script quota、1,000会員の実測、Google権限分離、trigger所有者、メール到達、バックアップ復元は接続フェーズの手動受入項目です。fixture合格を本番接続済みとは扱いません。

2026-08-30の変更禁止再監査では、ローカルコードのP0/P1/P2は0件です。successor marker保存失敗時のfail-safe、cursorのowner-fenced CASとhash-only quarantine、全identity preflight、Subscriptions／AccessGrants／SupplementalのMembers照合、Stripe pageの書込み前検証、通知の因果順序、Ghost投影tombstone、Sheet置換後の再開可能なtombstone件数commitまで回帰試験で固定しています。これらはfixture上のコード完了を示すもので、実Apps Scriptのtrigger、quota、権限、メール到達、外部API疎通を合格扱いにはしません。

## 公開前No-Go

次はfixture実装だけでは合格にできず、未完了の間は本番公開しません。

- Ghost/Stripe/Googleの実資格情報によるtest環境疎通、Account/livemode/allowlist/Sheet markerの目視確認
- 1,000会員相当のApps Script実機quota・実行時間試験（共有lookup cacheの1,000件unit testは済み）
- 初回Refund/Dispute list page内のN+1照合と、reconcile時の未観測open Invoice再取得は、10件chunk・item-level cursor・成功後upsert／cursor保存の部分commitで再開可能。100件fixtureの複数回完走試験済み（ただしApps Script実機quota試験は別途必要）
- notification/Form retryのitem propertyは9KB/value回避済み。通知outboxはproperty単位でtolerant parseし、破損したitemまたはlegacy aggregateの不正要素を、元のproperty名・値を保存しないbounded hash-only metadataへ隔離する。quarantine書込み（およびlegacy valid itemのper-item移行）が完了するまでsourceを削除せず、書込み失敗時はfail-closedで正常itemの配送も開始しない。同一hashの再試行は冪等で、quarantine後は不正sourceを削除して正常な兄弟itemを既存のpending→mail→sent→Sheet ack順序で配送する。SyncServiceとForm処理は同じScriptLock内でこのrepairを実行する。回帰試験済みのため、このコード残件は完了（実Apps Script quota・メール到達試験は別途No-Go）
- Google Formの項目名、回答先、共有範囲、installable trigger所有者、unverified回答の承認手順確定
- Form triggerはevent type/source ID/trigger UIDと回答先Spreadsheet ID、native RAW tab、environment marker、identity既存行をtrigger変更前にfail-closed検査する。retry queueはdue順のbounded batchでhead-of-lineを回避し、response ID point lookup、bounded hash-only quarantine、非busy失敗後の再試行を実装済み。one-shot triggerは環境namespaceごとのsuccessor UID markerだけをfuture triggerとして扱い、callback開始時に次UIDを作成・永続化するため、先行runと後続runが重なっても実行中triggerをsuccessorと誤認しない。overlap/runtime-kill相当fixtureを含む回帰試験済み（実Apps Script trigger/quota試験は別途No-Go）
- 実Apps Scriptでsuccessor triggerの作成・実行・再認可、同時実行、quota到達、runtime終了後の再開を確認する。コードはmarker保存失敗時も作成済みtriggerとqueueを残すfail-safe、owner-fenced cursor、3 Sheet境界のwrite-ahead tombstone commitまで回帰試験済み
- Google Forms native回答タブには`response.getId()`列がないため、RAWとSupplementalのresponse ID対応はinstallable eventを正本とする。実環境で回答タブ名`30_Profile_RAW`、再送、queue retry、Form削除時の扱いを手動受入する
- Apps Script APIでは既存time triggerの詳細scheduleを完全比較できないため、既存handlerの時刻設定を目視確認。自動処理は欠落作成と重複整理まで
- `last_payment_failure_at`の権威あるtimestamp取得方式。存在が保証されない`last_payment_error.created`は使用せず空欄にしている
- staff/pending invitationの手動確認値、バックアップ復元試験、通知到達、trigger再認可日の記録
- `clasp login`、`clasp status`、`clasp push`。Gate承認と本人操作前には実施しない

コード上の残存制約として、Apps Script/Sheetsには複数タブをまとめる原子的transactionがありません。本実装は実行試行ごとのlease owner tokenをSheet書込み直前に更新し、ownerを失った旧実行を無書込みで停止します。各タブ書込みは失敗時にそのタブの旧内容を復元し、途中停止後は同じcursor/run IDで冪等再実行します。本番相当の競合・quota試験は上記No-Goが閉じるまで未完了です。
