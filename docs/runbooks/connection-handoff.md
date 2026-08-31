# Ghost・Stripe・Google Workspace 接続引継ぎ票

## 目的

外部接続で運営責任者に必要な操作を、契約・本人確認・ログイン・秘密値入力・最終承認だけに限定します。Codexは画面を開く前までのコード、設定名、検査を完成させ、認証後は非秘密設定、デプロイ、read-only疎通、証跡整理を続けます。

この票に秘密値、2FAコード、カード情報を記入しません。Script Propertiesの正本は `packages/apps-script/script-properties.names.json` です。

## 現在の停止位置

- ローカル実装、fixture試験、秘密情報検査、配布物生成、最新`main`のGitHub CI／artifact／保護・security read-backは合格済み。2026-08-31に`G0-T`の作業範囲、推奨設定、項目8、Gate 1／2の方針が承認された。非公開台帳`みんほす_運用権限・復旧台帳`（値なしalias `GDRIVE-MINHOS-OPS-001`）のnative Google Sheetと2タブは作成済みで、connectorとブラウザの双方で非公開をread-backした。現在は責任者による副担当・復旧情報とGate 2 pre-entry境界の非公開入力・確認前で停止している。DEC-06の実講師候補とDEC-07／Gate 1／Gate 2 pre-entry証跡が未完なので、`G0-T` entry、完全なGate 0、productionは未完のまま維持する。秘密値の実設定とruntime verificationはGate 3で行う。
- 最初はStripe test modeと専用の試験Spreadsheet／Form／Driveフォルダを使用する。
- `G0-T`中は架空会員と運営所有のダミー教材だけを使う。初回は`manualSync()`と必要時の一時`resumeSync`だけを許可し、環境／Account／allowlist／schema、通知、backup／restoreを確認して永続trigger導入前のP1/P2が0になった後だけ、`installMinhosTriggers()`が作る5つの永続triggerを別承認する。本番Stripe、実会員データ、既存講義資産、実YouTube／Dropbox共有URL、本番公開はtest mode受入後まで有効化・投入しない。承認済みGate 3ケースのisolated Ghost test会員／Stripe test objectはtest環境内だけで作成でき、同期実装からGhost／Stripeへは書き込まない。
- 会員サイト予定FQDNは`members.minhos-management.jp`、親ドメインは`minhos-management.jp`。本番DNSは変更せずGate 5まで保留する。Tierは`みんほす会員`、月額1,100円（税込）、年額なし。公開予定サポートは`support@minhos-management.jp`だが、mailbox所有・送受信は未検証である。

## 責任者が一度に行う操作

以下は同じ作業枠でまとめます。Codexへ値を送らず、表示中の各サービス画面へ責任者本人が直接入力・承認します。

1. 組織所有アカウントでGhost(Pro)、Stripe、Google Workspaceへログインし、2FAを完了する。
2. GhostでCustom Integrationを1つ作成する。Admin API keyはコピー後、Apps Scriptの `GHOST_ADMIN_API_KEY` へ本人が直接入力する。
3. Stripe test modeでrestricted keyを1つ作成する。Account、Customers、Subscriptions、Invoices、Charges、PaymentIntents、Refunds、Disputes、Products、PricesをReadにし、`STRIPE_RESTRICTED_KEY`へ本人が直接入力する。`sk_...`の通常secret keyは使わない。
4. 組織所有アカウントでtest専用Standalone Apps Script、Spreadsheet、Google Form、権限制限したDriveバックアップフォルダをCodexが作成・設定することを承認し、作成後に本人が所有者と共有範囲を確認する。本人はログイン、2FA、OAuth認可を行う。
5. GoogleのOAuth／clasp認可画面を本人が承認する。ブラウザや端末に表示された認証コードをチャットへ貼らない。
6. GhostとStripeの標準連携、Ghost(Pro)契約、Stripe KYC・銀行口座、ドメイン／DNS、法務表示、本番公開、実カード確認は、ユーザーが明示した本人担当としてそのまま残す。

## Script Propertiesの入力分担

「秘密」は本人がApps Script画面へ直接入力します。「非秘密」は画面から確認後、Codexが設定補助できます。省略可能項目は正本registryのdefaultを使います。

| 種別 | 設定名 | 入力・確認者 | 取得元／扱い |
|---|---|---|---|
| 秘密 | `GHOST_ADMIN_API_KEY` | 責任者 | Ghost Custom Integration。チャット・Git・Sheetへ貼らない |
| 秘密 | `STRIPE_RESTRICTED_KEY` | 責任者 | まず`rk_test_...`。本番切替時は別project／別Sheetを使用 |
| 必須非秘密 | `GHOST_ADMIN_URL`、`GHOST_SITE_ID` | Codex補助＋責任者確認 | HTTPS Admin originと安定したローカルsite ID |
| 必須非秘密 | `STRIPE_ACCOUNT_ID`、`STRIPE_API_VERSION`、`STRIPE_LIVEMODE` | Codex補助＋責任者確認 | testでは`false`。実装が許容するAPI versionへ固定 |
| 必須非秘密 | `STRIPE_PRICE_ALLOWLIST`、`STRIPE_PRODUCT_ALLOWLIST` | Codex補助＋責任者確認 | Ghost連携で作成・選択した対象だけ。複数はcomma区切り |
| 必須非秘密 | `SPREADSHEET_ID`、`OPS_NOTIFICATION_EMAIL`、`BACKUP_FOLDER_ID` | Codex補助＋責任者確認 | 組織所有、最小共有、試験通知先 |
| 条件付き | `GOOGLE_FORM_ID` | Codex補助＋責任者確認 | Form triggerを入れる時だけ必須 |
| 任意 | `GHOST_ACCEPT_VERSION`、保存期間、Form項目名、runtime、watermark、schema/code version | Codex | registry既定値を使用し、変更時だけ責任者確認 |

全25項目とrequired／conditional／optional、default、担当サービスは `packages/apps-script/script-properties.names.json` を参照します。`npm run check:config` が実装で参照する名前との完全一致を検査します。

## Codexが認証後に続けて行う操作

1. `.clasp.json` をGit管理外で作り、対象projectを再確認してから、リポジトリrootで `npm --prefix packages/apps-script run clasp:status` を実行する。
2. ローカル検証済みbundleだけを、リポジトリrootで `npm --prefix packages/apps-script run deploy` としてtest projectへ送る。
3. `initializeMinhosWorkbook()` を明示実行し、固定schemaのシステム所有11タブ、header、保護範囲、環境markerを確認する。この処理はGoogle Forms所有の回答タブを作成・参照・編集しない。
4. Form回答先を同じSpreadsheetへ設定し、Google Forms自身が作成したnative回答タブを回答受付前に`30_Profile_RAW`へ改名する。header・列順・列数はForm所有のまま編集せず、response ID列を追加しない。この時点では試験回答を送信しない。
5. `installMinhosTriggers()`を実行せず、まず`manualSync()`を1回だけ実行する。実行時間上限に達した場合は、コードが作成する一時`resumeSync` triggerだけを許可する。Ghost／StripeはGETだけであること、Account・livemode・allowlistを再確認する。
6. Dashboard、Exceptions、SyncLog、バックアップ、通知を確認し、AT証跡へ記録する。
7. 初回同期、環境／Account／allowlist／schema、通知、backup／restoreを確認し、永続trigger作成前までに検出したP1/P2がゼロになった後だけ、責任者の別承認を得て`installMinhosTriggers()`を実行し、`hourlySync`、`nightlySync`、`dailyBackup`、`monthlyBackup`、`onProfileFormSubmit`の5つを確認する。その後にForm試験回答を送信し、eventの`FormResponse.getId()`を使う一意照合／不一致／重複／再回答を確認する。trigger試験でP1/P2が出た場合は停止し、本番release blockerは別途OPENのまま扱う。
8. GhostテーマZIPを検証サイトへ入れる。続いてGhost Adminから現行 `routes.yaml` をダウンロードしてバックアップし、`packages/ghost-theme/routes.yaml` をテーマZIPとは別にアップロードする。`/`、`/updates/`、`/lectures/` と代表投稿URLを確認し、失敗時は旧routesと旧テーマを戻す。
9. 未ログイン／free／paid、OGP、RSS、検索、メール、ActivityPubを実地確認する。

## 1回の確認で受け取る非秘密情報

接続開始時、Codexが責任者へ確認するのは次の準備完了だけです。IDは秘密ではありませんが、不要な転記を避けるため可能な限り画面から直接確認します。

```text
Ghost(Pro)契約・Stripe本人確認・Google Workspace組織アカウントの準備が完了した。
test mode専用のSpreadsheet／Form／Drive folderを作ってよい。
Ghost Custom IntegrationとStripe restricted test keyを本人が画面へ直接入力できる。
Google OAuth／clasp認可を本人が承認できる。
```

## 即時停止条件

- live/test、Stripe Account、Product/Price、Ghost site、Spreadsheet環境markerのいずれかが一致しない。
- 取得データがAPI schemaを満たさない、全ページ完走できない、同期cursorが破損している。
- 秘密値をチャット・Git・Sheet・ログへ貼る必要が生じる。
- テーマの公開HTML、OGP、RSS、検索、メール、ActivityPubへ外部URLが出る。
- 書込み前snapshot、バックアップ、rollback、責任者が確認できない。

停止後は値を再送せず、設定名、対象ID末尾、時刻、エラー分類だけで原因を切り分けます。

## 接続完了の証跡（値なし）

```text
connection_run_id:
environment: test | production
ghost_site_verified: YES | NO
stripe_account_and_livemode_verified: YES | NO
price_product_allowlist_verified: YES | NO
google_project_owner_verified: YES | NO
spreadsheet_schema_verified: YES | NO
manual_sync_result:
backup_restore_result:
theme_access_matrix_result:
routes_backup_and_apply_result:
open_p1_p2:
operator:
approver:
completed_at:
next_gate:
```
