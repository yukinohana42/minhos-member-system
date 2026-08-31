# 外部Gate 0〜2 意思決定ワークブック

## この文書の位置づけ

この文書は、Ghost／Stripe／Google Workspaceのtest環境へ接続する前に、要件書第20章の`DEC-01`〜`DEC-21`、サービス所有者、秘密情報境界を確認するワークブックです。2026-08-31にtest向け推奨案と項目8の作業範囲が承認されました。test接続に必要な決定と、本番公開まで保留できる決定を分け、運営責任者の確認回数を最小化します。正式な値なし記録は`docs/evidence/records/external-gates-0-2-approval-20260831.md`です。`config/release-status.json`はproduction candidate専用のため更新せず、本番判定は引き続き`NO_GO`です。

秘密値、2FAコード、カード情報、副担当者等の非公開個人名、実アカウントIDはこの文書、Git、Sheet、ログ、チャットへ記録しません。副担当者の氏名や復旧情報は、運営責任者が管理する制限付きの外部権限表へだけ記録します。公開予定の講師名はDEC-06の候補として扱えます。

## すでに確定しており再確認しない前提

- Ghost(Pro)＋Stripe＋Google Sheets／Forms＋YouTube限定公開＋既存Dropboxを使用する。
- Make、Mux、独自認証、独自決済画面、会員別署名URLはMVPに含めない。
- YouTube／Dropboxへのアップロードと共有リンク作成は運営責任者が行う。
- 契約、KYC、2FA、GhostとStripeの初回接続承認、DNS最終確認、法務最終判断、本番公開、実カード確認は運営責任者が行う。
- Stripeを課金の正本、Ghostを閲覧権限の正本、Sheetsを一方向の運用台帳とする。

## 2026-08-31 承認後の状態

- `G0 Decision`: `OPEN`
- `G0-T`の作業範囲: `APPROVED`
- `G0-T` entry: `PENDING_PREREQUISITES`
- Gate 1: `OPEN — REGISTER_CREATED / PRIVATE_COMPLETION_PENDING`
- Gate 2 pre-entry boundary: `OPEN — INVENTORY_CREATED / OWNER_CONFIRMATION_PENDING`
- Gate 2 runtime verification: `NOT_STARTED — GATE_3`
- production: `NO_GO`

DEC-01／02／03／04／05／08／19／21はtest向け判断として確定しました。DEC-06はtest分類まで、DEC-07は主担当role方針までの部分確定です。実講師候補と、非公開の副担当・復旧記録が揃うまで`G0-T`へentryしません。

## Gate 0 — DEC-01〜21

`承認状態`は本番releaseの状態ではなく、このworkbook上のtest向け判断を示します。実設定・実測が未完の項目を合格扱いにはしません。

### 実装・test接続に必要な決定

| ID | 決定対象 | 推奨案／回答が必要な値 | 承認状態 |
|---|---|---|---|
| DEC-01 | サイト名・ロゴ・色・文体 | 表示名`みんほす`、既存ロゴ／ブランド色、親しみやすく専門性を保つ文体 | test確定 |
| DEC-02 | 本番ドメイン | 親ドメイン`minhos-management.jp`、会員サイト予定FQDN`members.minhos-management.jp`。testはGhost既定ドメインを使用し、DNS変更はGate 5まで行わない | test確定・DNS未検証 |
| DEC-03 | Tier・価格・税表示 | Tier名`みんほす会員`、月額のみ、JPY 1,100円・税込表示、年額なし。改名時は表示名だけを変更し、既存ID／契約履歴を再作成しない。価格改定は新Priceを作る | test確定・税務はDEC-18 |
| DEC-04 | 無料募集・trial・coupon | MVPではすべて無効。休会、gift、通常運用のcompedも使わない | test確定 |
| DEC-05 | Ghost／Form収集項目 | Ghostは氏名欄＋必須メール。Formは登録メールと同意checkboxを必須、所属・肩書き・参加区分は任意。Form未回答でも閲覧可 | test確定 |
| DEC-06 | レクチャー分類 | test年`2026`、シリーズ`救急外来を乗り越えようシリーズ`、承認済み9テーマ分類・20タイトル、test講師`テスト講師`。実講師候補は未定 | 部分確定・実講師待ち |
| DEC-07 | 役割 | MVP開始時は運営責任者がシステム／コンテンツ／会員管理を兼務、閲覧専用担当なし。副担当は制限付き外部権限表で指定 | 方針確定・非公開記録待ち |
| DEC-08 | サポート | 公開予定`support@minhos-management.jp`、一次回答2営業日以内 | test確定・送受信未検証 |
| DEC-19 | 問い合わせ方式 | サポートメールへの`mailto:`と案内文。問い合わせFormは作らない | test確定 |
| DEC-21 | Ghost Portal | 氏名欄、対象Tier／Price、規約notice、必須同意checkbox、サポートメールを有効化。noticeは「月額1,100円（税込）の自動更新プランです。お申し込み前に利用規約とプライバシーポリシーをご確認ください。」 | test確定・実設定未実施 |

### 本番公開までに必要な決定

| ID | 決定対象 | 推奨案／回答が必要な値 | 承認状態 |
|---|---|---|---|
| DEC-09 | 外部URL再共有 | 閲覧者が取得したYouTube／Dropbox URLの再共有をMVPでは防止できない制約を受容。漏えい時は外部リンクを先に停止 | 未承認 |
| DEC-10 | Stripe支払回収 | testで再試行期間を実測・記録し、全再試行失敗後は必ず`cancel`。具体的な期間・回数はStripe画面で選べる値を確認して最終決定 | 未承認 |
| DEC-11 | 解約・返金・Dispute | 解約は期間末。返金は重複決済、運営側の重大な提供不能、法令上必要な場合を個別確認し、それ以外は原則なし。Disputeはシステム責任者がStripe上で個別対応し、Sheetから課金・権限を変更しない | 未承認 |
| DEC-12 | 保存期間 | 日次backup 35日、月次snapshot 730日は現行の技術候補であり未承認。Ghost、Form原本、Sheets、backup／snapshot、全ログの保持期間を法務・税務確認後に決定 | 未承認 |
| DEC-13 | Dropboxリンク | 既存プランの期限／password可否を確認。MVPは会員別URLを発行せず、運営責任者が差替え・失効。プラン名と希望期限は**回答必須** | 未承認 |
| DEC-14 | 字幕 | 新規動画は日本語字幕または内容同等のテキスト代替を公開前に用意。既存アーカイブは利用頻度順に改善し、期限は**回答必須** | 未承認 |
| DEC-15 | 法務・講師許諾 | 利用規約、プライバシー、特商法表示は本番前に責任者または専門家が最終確認。動画・資料はコンテンツ単位で会員配布許諾を確認 | 未承認 |
| DEC-16 | 障害・復旧 | test前はGate 1として主担当、副担当、復旧方法を確定。本番前に緊急連絡手段と障害通知手順を最終承認 | 未承認 |
| DEC-17 | 既存会員・過去資料 | 重複を自動統合せず要確認へ送る。既存会員数、動画／PDF数、公開優先順位は**回答必須** | 未承認 |
| DEC-18 | 税・領収書・決済手段 | JPY・税込表示、領収書メール、MVPの決済手段、Stripe Tax不使用を候補とする。testでCheckoutに出る手段と領収書設定／配送を実測し、税・Stripe Taxは専門家確認後に確定 | 未承認 |
| DEC-20 | 第三者送信・Cookie | YouTube埋め込み時は対応確認後`youtube-nocookie.com`を使用し、生成HTMLを検証。YouTube／Dropbox／Stripe／Ghostへの第三者送信の文書記載と同意表示は法務最終確認 | 未承認 |

## Gate 1 — 所有者と最小権限

| 対象 | MVPの主担当 | 副担当・復旧 | 日常権限 |
|---|---|---|---|
| Ghost | system-owner | 制限付き外部権限表で指定 | content-ownerはEditor相当だけ |
| Stripe | system-owner | 制限付き外部権限表で指定 | 原則なし |
| Google／Apps Script | system-ownerがStandalone Script、Sheet、Form、backup Driveを所有・編集し、testの手動同期を実行 | 組織アカウントの復旧担当 | 追加のmember-opsはSheetの許可列だけ。Script編集、秘密情報、手動同期は禁止 |
| YouTube／Dropbox | content-owner | リンク停止・復旧担当 | content-ownerだけ |
| DNS | system-owner | 制限付き外部権限表で指定 | 原則なし |
| Codex | 所有権・資格情報なし | なし | 非秘密設定、test deploy、GET-only検証、証跡整理だけ |

MVPでは運営責任者が`system-owner`、`content-owner`、`member-ops`を兼務します。6サービスすべてで組織所有、または組織へ移管・復旧できる状態、個人別アカウント、2FA、共有ログインなしを必須とします。制限付き外部権限表には、主担当、副担当、復旧方法、個人別2FA、共有ログインなし、年次／担当交代時の棚卸し責任者、非秘密の証跡参照を記録します。副担当と復旧方法が確定するまでGate 1は完了にしません。

承認済みの非公開Sheet名は`みんほす_運用権限・復旧台帳`、Git／会話で使用する値なしaliasは`GDRIVE-MINHOS-OPS-001`です。native Google Sheetの2タブは作成済みで、connectorとブラウザの双方で非公開をread-backしました。Sheet自体を公開する意味ではありません。責任者が副担当と復旧情報を非公開で直接記入し、6サービスを確認するまでGate 1は`OPEN`です。

## Gate 2 — 秘密情報境界

Script Propertiesへ置く秘密値は次の2つだけです。Google OAuth／Script authorization、DNS資格情報、2FA／復旧コード、YouTube／Dropboxログインも秘密ですが、各サービス側で管理し、Script Propertiesや実装へ取り込みません。

| 設定名 | 環境・権限 | 入力者 | 失効 |
|---|---|---|---|
| `GHOST_ADMIN_API_KEY` | test対象site専用。鍵自体はread-only化できないため、GET-onlyコード、Script編集者1名、監査で補完 | 運営責任者がApps Script画面へ直接入力 | Ghost Custom Integrationで即時失効・再発行 |
| `STRIPE_RESTRICTED_KEY` | test専用`rk_test_...`。接続引継ぎ票に記載した10リソース群をReadだけ。`sk_...`と`rk_live_...`は禁止 | 運営責任者がApps Script画面へ直接入力 | Stripe Dashboardで即時失効・再発行 |

- test/liveの鍵、Stripe Account、Apps Script project、Sheetを分離する。
- サービス側で管理する認証秘密もScript Properties、Codex、チャット、Git、Sheet、ログへ取り込まない。
- Script編集者はsystem-ownerだけとし、Sheet編集者がScript Propertiesを取得できない構成にする。
- 鍵は年1回、担当交代時、漏えい疑い時にローテーションする。値はCodex、チャット、Git、Sheet、ログへ渡さない。

Gate 2は二段階で扱います。`pre-entry boundary`は、値なし台帳の保管者・保管区分・各credentialの種類・最小scope・test/live分離・rotation／失効方法を責任者が確認すれば完了できます。秘密値の実設定は要求しません。`runtime verification`はGate 3でtest projectを作成し、本人が秘密値を直接入力した後、Codexが値を読み出さず存在・権限・環境分離だけをread-backします。現在はpre-entryの責任者確認待ちなのでGate 2は`OPEN`です。

## G0-T entry前に残る確認

2026-08-31に当初の8項目は回答・承認済みであり、再回答は不要です。Portal noticeの正本は次の文言です。

> 月額1,100円（税込）の自動更新プランです。お申し込み前に利用規約とプライバシーポリシーをご確認ください。

残る作業は次の3点だけです。

1. 公開可能な実講師の初期候補を確定する。
2. 責任者が`GDRIVE-MINHOS-OPS-001`のGate 1タブへ6サービスの副担当・復旧情報を非公開で直接入力し、各行を確認する。
3. 責任者が同SheetのGate 2値なしタブで、保管者・保管区分・最小scope・test/live分離・rotation／失効方法を確認する。秘密値は入力しない。実設定のruntime verificationはGate 3で行う。

試験通知先は公開サポートメールと同じである必要はありません。個人アドレスをチャットへ転記せず、認証済み画面で運営責任者が直接確認・入力します。

## 本番前にまとめて受け取る回答

次はtest接続を止めず、未決のままproduction blockerとして追跡します。本番Go/No-Goの前に一度だけ回答を受け取ります。

```text
1. 本番必須DEC-09/10/11/12/13/14/15/16/17/18/20の推奨案：すべて承認／変更あり（変更点だけ）
2. 既存会員数：　　、過去動画：　　、過去PDF：　　、公開優先順位：
3. Dropboxプラン名：　　　　　　、共有リンク期限：なし／　日、password：使用／不使用／非対応
4. 既存字幕の改善期限：
5. Ghost／Form／Sheetsの退会後保持期間：
6. Stripeの再試行期間／回数：test実測後の推奨値を承認／変更
7. 法務・税務・講師許諾の最終確認：済
```

`まだ未定`または`未完`の項目は未決のまま追跡し、該当するGateを完了扱いにしません。上記3点が揃っても`G0 Decision`は完了にせず、承認済み`G0-T`とGate 1／Gate 2 pre-entry boundaryの後にtest専用環境だけで開始します。readinessには`G0-T APPROVED`、`G0 OPEN`、`production NO_GO`を記録します。本番必須DEC未確定中は、架空会員と運営所有のダミー動画／PDF／URLだけを使い、実会員情報、既存講義資産、実YouTube／Dropbox共有URL、外部公開を扱いません。初回は`manualSync()`と必要時の一時`resumeSync`だけを許可します。環境／Account／allowlist／schema、通知、backup／restoreを確認し、永続trigger導入前のP1/P2が0になった後だけ、責任者の別承認で`installMinhosTriggers()`と5つの永続triggerを作ります。承認済みGate 3ケースのisolated Ghost test会員／Stripe test objectはtest環境内で作成できますが、同期実装からGhost／Stripeへは書き込みません。実データや実教材を扱う場合は該当DECを先に承認します。

## 承認後にCodexが行うこと

1. 承認内容を値なしの`G0-T`、Gate 1、Gate 2証跡へ転記し、readinessへ`G0 OPEN`／`production NO_GO`を明記してhandoff、progress logを同期する。本番必須DECは未決として残す。
2. `npm run check:config`、`npm run check:secrets`、`npm run check:requirements`、`npm run verify:all`を再実行する。
3. 接続引継ぎ票の4項目を一括確認する。
4. 本人のログイン／2FA／秘密値入力後、test専用Sheet／Form／Drive／Standalone Apps Scriptを設定し、検証済みbundleをdeployする。
5. `installMinhosTriggers()`を実行せず`manualSync()`を1回だけ実行し、必要時の一時`resumeSync`を含めてGhost／StripeのGET-only疎通、環境ID、allowlist、Schema、通知、backupを検証する。
6. test Ghostへthemeと`routes.yaml`を別々に適用し、AT-01〜45を状態別に証跡化する。
