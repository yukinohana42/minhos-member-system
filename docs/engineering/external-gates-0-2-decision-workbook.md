# 外部Gate 0〜2 意思決定ワークブック

## この文書の位置づけ

この文書は、Ghost／Stripe／Google Workspaceのtest環境へ接続する前に、要件書第20章の`DEC-01`〜`DEC-21`、サービス所有者、秘密情報境界を確認するための**未承認ドラフト**です。test接続に必要な決定と、本番公開まで保留できる決定を分け、運営責任者の確認回数を最小化します。回答が確定するまでGate 0〜2の証跡ではなく、`config/release-status.json`も更新しません。本番判定は引き続き`NO_GO`です。

秘密値、2FAコード、カード情報、副担当者等の非公開個人名、実アカウントIDはこの文書、Git、Sheet、ログ、チャットへ記録しません。副担当者の氏名や復旧情報は、運営責任者が管理する制限付きの外部権限表へだけ記録します。公開予定の講師名はDEC-06の候補として扱えます。

## すでに確定しており再確認しない前提

- Ghost(Pro)＋Stripe＋Google Sheets／Forms＋YouTube限定公開＋既存Dropboxを使用する。
- Make、Mux、独自認証、独自決済画面、会員別署名URLはMVPに含めない。
- YouTube／Dropboxへのアップロードと共有リンク作成は運営責任者が行う。
- 契約、KYC、2FA、GhostとStripeの初回接続承認、DNS最終確認、法務最終判断、本番公開、実カード確認は運営責任者が行う。
- Stripeを課金の正本、Ghostを閲覧権限の正本、Sheetsを一方向の運用台帳とする。

## Gate 0 — DEC-01〜21

`承認状態`は全件`未承認`から開始します。推奨案をそのまま採用する場合も、運営責任者の一括承認後にだけ決定扱いとします。

### 実装・test接続に必要な決定

| ID | 決定対象 | 推奨案／回答が必要な値 | 承認状態 |
|---|---|---|---|
| DEC-01 | サイト名・ロゴ・色・文体 | 表示名`みんほす`、既存ロゴ／ブランド色、親しみやすく専門性を保つ文体 | 未承認 |
| DEC-02 | 本番ドメイン | test接続先はGhost既定ドメイン。本番の採用FQDNは`G0-T`前に回答必須。DNS変更はGate 5まで行わない | 未承認 |
| DEC-03 | Tier・価格・税表示 | Tier名`みんほす会員`、月額のみ、JPY・税込表示。月額金額は**回答必須** | 未承認 |
| DEC-04 | 無料募集・trial・coupon | MVPではすべて無効。休会、gift、通常運用のcompedも使わない | 未承認 |
| DEC-05 | Ghost／Form収集項目 | Ghostは氏名欄＋必須メール。Formは登録メールと同意checkboxを必須、所属・肩書き・参加区分は任意。Form未回答でも閲覧可 | 未承認 |
| DEC-06 | レクチャー分類 | 正式な初期開催年／テーマ／講師候補を`G0-T`前に承認。開催年は開催日から`year-*`へ分類し、同義タグを自動統合しない。test fixtureでは別途`テスト年`／`テストテーマ`／`テスト講師`を使用可 | 未承認 |
| DEC-07 | 役割 | MVP開始時は運営責任者がシステム／コンテンツ／会員管理を兼務、閲覧専用担当なし。副担当は制限付き外部権限表で指定 | 未承認 |
| DEC-08 | サポート | 組織所有メール、一次回答2営業日以内。公開メールアドレスは**回答必須** | 未承認 |
| DEC-19 | 問い合わせ方式 | サポートメールへの`mailto:`と案内文。問い合わせFormは作らない | 未承認 |
| DEC-21 | Ghost Portal | 氏名欄、対象Tier／Price、規約notice、必須同意checkbox、サポートメールを有効化 | 未承認 |

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

## test接続開始時に一度だけ受け取る回答

次のブロックを埋めて返信すれば、test接続に適用するDEC、Gate 1、Gate 2、接続準備を一度に確認できます。秘密値、副担当者等の非公開個人名、実アカウントIDは書かないでください。公開予定の講師名は記載できます。

```text
1. test適用の推奨案（DEC-01/03/04/05/06/07/08/19/21）：すべて承認／変更あり（変更点だけ）
2. 月額税込価格：　　　　　　円（Tier名を変える場合：　　　　　　）
3. 公開する組織所有サポートメール：　　　　　　。Portal noticeは「お申し込み前に利用規約とプライバシーポリシーをご確認ください。月額課金は解約するまで自動更新されます。」、公開URLは`/terms/`と`/privacy/`：承認／変更
4. 本番の採用FQDN：
5. 正式な初期開催年候補：　　　　　　、正式な初期テーマ候補：　　　　　　、正式な初期講師候補：　　　　　　。test fixtureでは`テスト年`／`テストテーマ`／`テスト講師`を使用：はい／いいえ
6. 6サービスは組織所有または移管・復旧可能。主担当／副担当／復旧方法／個人別2FA／共有ログインなし／棚卸し責任者を制限付き外部権限表へ記録済み（非秘密の参照名：　　　　）：承認
7. 値なし秘密台帳の保管者と場所を外部記録へ確定。Script Propertiesの秘密は2件だけ、Stripeは`rk_test_...`かつRead-only、その他の認証秘密はサービス側管理。test/live分離、年次／交代時rotation、漏えい疑い時の即時失効を承認：承認
8. 本人がログイン／2FA／OAuthと鍵の作成・直接入力を行い、作成後の組織所有を確認する。Codexがtest専用Sheet／Form／Drive／Standalone Scriptの作成・設定、検証済みbundleのdeploy、`manualSync()`1回と必要時の一時`resumeSync`、backup後のisolated test Ghostへのtheme／routes適用を行うことを承認。`installMinhosTriggers()`と5つの永続trigger、実カード、本番課金、実会員の課金・権限変更は対象外。承認済みGate 3ケースのisolated Ghost test会員／Stripe test objectだけはtest環境内で作成可：承認／未完の準備
```

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

`まだ未定`または`未完`の項目は未決のまま追跡し、該当するGateを完了扱いにしません。8項目が揃っても`G0 Decision`は完了にせず、承認済み`G0-T`とGate 1／2の後にtest専用環境だけで開始します。readinessには`G0-T APPROVED`、`G0 OPEN`、`production NO_GO`を記録します。本番必須DEC未確定中は、架空会員と運営所有のダミー動画／PDF／URLだけを使い、実会員情報、既存講義資産、実YouTube／Dropbox共有URL、外部公開を扱いません。初回は`manualSync()`と必要時の一時`resumeSync`だけを許可します。環境／Account／allowlist／schema、通知、backup／restoreを確認し、trigger前のP1/P2が0になった後だけ、責任者の別承認で`installMinhosTriggers()`と5つの永続triggerを作ります。承認済みGate 3ケースのisolated Ghost test会員／Stripe test objectはtest環境内で作成できますが、同期実装からGhost／Stripeへは書き込みません。実データや実教材を扱う場合は該当DECを先に承認します。

## 承認後にCodexが行うこと

1. 承認内容を値なしの`G0-T`、Gate 1、Gate 2証跡へ転記し、readinessへ`G0 OPEN`／`production NO_GO`を明記してhandoff、progress logを同期する。本番必須DECは未決として残す。
2. `npm run check:config`、`npm run check:secrets`、`npm run check:requirements`、`npm run verify:all`を再実行する。
3. 接続引継ぎ票の4項目を一括確認する。
4. 本人のログイン／2FA／秘密値入力後、test専用Sheet／Form／Drive／Standalone Apps Scriptを設定し、検証済みbundleをdeployする。
5. `installMinhosTriggers()`を実行せず`manualSync()`を1回だけ実行し、必要時の一時`resumeSync`を含めてGhost／StripeのGET-only疎通、環境ID、allowlist、Schema、通知、backupを検証する。
6. test Ghostへthemeと`routes.yaml`を別々に適用し、AT-01〜45を状態別に証跡化する。
