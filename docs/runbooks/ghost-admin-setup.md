# Ghost Admin 初期設定 Runbook

## 目的と適用範囲

このRunbookは、Ghostの検証サイトでMembership、Portal、Tier、welcome email、送信ドメインを設定し、MVPテーマの導線を確認するための手順です。要件書第18章の成果物、PUB-03/04、AUTH-01/02/04/05、PAY-01/02/09、CNT-01、DEC-03/04/08/21を対象にします。

画面名はGhostの英語UIを前提とします。Ghost(Pro)の契約、Stripeの本人確認・初回接続、本番DNS、本番公開、実カード決済、法務文言の承認は運営責任者本人の作業です。Codexや実装担当は、値をチャットへ受け取らず、入力箇所、read-only確認、マスク済み証跡の整理までを支援します。

本番へ直接設定せず、有効な本番契約がない検証サイトで先に完了してください。DEC-21は現時点で未決定です。以下の「候補」は設定値の決定ではなく、運営責任者の承認後にだけ入力できます。

## 画面経路と設定の正本

| 対象 | 英語UIの経路 | このシステムでの正本 |
|---|---|---|
| Membership既定アクセス | **Settings → Membership → Access** | Ghost設定。投稿ごとのアクセス設定も必ず確認する |
| Portal申込表示 | **Settings → Membership → Signup portal → Customize** | Ghost Portal設定と承認済みDEC-21 |
| Tier / Price | **Settings → Membership → Tiers** | Ghost標準Stripe連携で作成したTier/Priceと承認済みDEC-03/04 |
| Welcome email | **Settings → Membership → Welcome emails** | Ghost設定。本文の承認版は運営責任者が保管する |
| 送信ドメイン | **Ghost(Pro) → Domain** | Ghost(Pro)とDNS。DNS正本はドメイン管理者が管理する |
| サイト内ナビゲーション | **Settings → Site → Navigation** | **本テーマでは使用しない**。ヘッダーとフッターのhard-coded partialが正本 |

画面経路や項目が見つからない、名称が大きく異なる、または保存時に別サービスへの接続や課金変更を要求された場合は推測で進めず停止し、Ghostの現行公式ヘルプと運営責任者へ確認します。

## 作業前の記録と停止条件

### 実施情報

| 項目 | 記録欄 |
|---|---|
| environment（test / production） | |
| Ghost site URL / 非秘密なenvironment ID | |
| theme ZIP SHA-256 | |
| routes.yaml SHA-256 | |
| 実施者 / 承認者 | |
| 開始・終了（UTC保存、JST表示） | |
| 変更ticket / release ID | |
| 証跡の非公開保管先 / 保持期限 | |
| rollback担当 / 連絡先 | |

### 必須バックアップ

1. Ghost Export、Members CSV、現在のテーマZIP、Ghost Adminから取得した現在の`routes.yaml`を、アクセス制限された保管先へ保存する。
2. Portal、Tier、Welcome emails、送信ドメイン、Navigationの変更前画面を取得する。Tier/Priceの値と件数、現在の申込可否も記録する。
3. 検証対象が本番でないこと、Stripe test modeの接続先、対象Tier/Product/Priceを末尾4文字で照合する。
4. 法務文言、Tier名、価格、税込表示、年額有無、サポートメール、送信元名の承認記録を確認する。

次の場合は変更前に停止します。

- environment、Ghost site、Stripe mode/account、Tier/Product/Priceのいずれかを一意に照合できない。
- 有効な本番契約があるTier/Priceの削除、金額変更、Stripe切断が必要になる。
- API鍵、Webhook secret、OAuth token、2FAコード、カード情報を画面記録やGitへ保存する必要がある。
- DEC-03/04/08/21または法務文言の承認がない。
- バックアップ、rollback担当、非公開の証跡保管先がない。

## 1. Membershipの既定アクセス

**前提**: 検証サイト、テーマZIP、`routes.yaml`、公開ページと`#lecture`の代表投稿を準備している。

1. **Settings → Membership → Access** を開く。
2. 既定の投稿アクセスを **Paid-members only** にする。画面に同名の既定投稿アクセス項目がない場合は変更せず停止する。
3. 保存操作を行い、成功表示を確認して再読込する。
4. `welcome`ページと全`#lecture`投稿も、投稿エディターで個別に **Paid-members only** になっていることを確認する。公開案内ページ、お知らせ、タイトル・安全な概要は公開のままとする。

| 確認 | 期待結果 | 対応 |
|---|---|---|
| 未ログイン / free / 有効権利0件で代表講義を開く | 保護本文、YouTube URL、Dropbox URLを取得できない | AT-09、AT-10 |
| 対象Tierのtest契約または承認済み付与で開く | Ghostの`access`判定で本文を取得できる | AT-09 |
| 公開ページと`/updates/` | ログインなしで到達できる | AT-01、AT-03 |

**証跡**: Access画面の変更前後、代表投稿のaccess、各状態のURL・HTTP/画面結果を記録します。保護本文や外部URLを証跡へ転記しません。

**rollback**: 設定を変更前の画面記録どおりへ戻し、保存・再読込後に代表投稿と公開ページを再試験します。公開範囲が不明な間は新規投稿を公開しません。

## 2. Portal申込設定（DEC-21）

**前提**: DEC-03/04/08/21、規約・プライバシー・特商法の表示内容とURL、対象Tier/Priceが承認済みである。

1. **Settings → Membership → Signup portal → Customize** を開く。
2. 次の5項目を一つずつ確認し、承認済み値だけを入力する。

| DEC-21項目 | MVP入力候補 | 保存後の期待結果 | 決定 / 承認記録 |
|---|---|---|---|
| 氏名欄 | signupで氏名欄を表示する | 氏名入力欄が表示される。空欄をPortalが許す場合も申込を止めず、後続P3補完とする | |
| 対象Tier/Price | 承認済みの有料Tier 1つと月額。年額はDEC-03採用時だけ | 申込画面に承認外のTier/Price、free、trial、couponが出ない | |
| 規約notice | 承認済みの規約・プライバシー案内と公開URL | Checkout前に読め、リンクが同一正式ドメインの公開ページへ到達する | |
| 同意必須checkbox | 規約への同意を必須にする | 未同意では次へ進めず、同意後だけ進める | |
| サポートメール | DEC-08で承認した組織所有アドレス | 問い合わせ先として表示され、個人所有アドレスを露出しない | |

3. 保存し、成功表示を確認して画面を再読込する。
4. 未ログインの新規申込、free/失効会員の再入会、有料会員のアカウント導線を別々に確認する。
5. magic linkまたはone-time code、Checkout取消、失敗、成功帰還をStripe test modeで確認する。有料会員が二本目を作る申込へ進まないことを確認する。

**合格対象**: AT-02、AT-03、AT-06、AT-07、AT-08、AT-14。5項目は一括の画面だけでなく、各行に結果、実施者、日時、承認者、証跡参照を残します。

**rollback**: 変更前のPortal設定へ戻します。既存Tier/Priceを削除・編集せず、本番Stripeを切断しません。誤った申込が可能な場合は、新規申込導線を一時停止して運営責任者へ引き継ぎます。

## 3. Tier / Price

**前提**: GhostとStripeの標準連携が検証環境で承認済みで、DEC-03/04のTier名、JPY価格、税込表示、年額有無が決まっている。

1. **Settings → Membership → Tiers** を開く。
2. MVPの申込対象が有料Tier 1つであることを確認する。
3. 承認済みのTier名、説明、特典、JPY月額を入力する。年額はDEC-03で採用した場合だけ追加する。free、trial、couponはDEC-04どおり無効とする。
4. 対象Product/PriceをStripe test modeのallowlistと末尾4文字で照合して保存する。
5. Portalを再度開き、表示価格、税込表示、周期、対象Tierが承認記録と一致することを確認する。

| Test | 期待結果 | 対応 |
|---|---|---|
| 新規test申込 | Customer/Subscription/Ghost会員が一組だけ作られ、通常60秒以内または反映待ち導線で本文へ到達する | AT-06 |
| Checkout失敗・取消 | 権限を付けず、重複契約なしで再試行できる | AT-07 |
| 既存有料会員 | ライブラリまたはPortal accountへ進み、二本目を作らない | AT-08 |
| free/失効会員 | Portalの再入会から新しいtest契約を作り、権限が戻る | AT-14 |

**証跡**: Tier名、周期、表示価格、税込表示、Product/Price ID末尾4文字、Stripe mode、Portal表示、test結果を記録します。カード情報と完全な外部IDは残しません。

**rollback**: 有効契約が紐づくPriceを削除・金額変更しません。料金変更は新しいPriceとして扱い、問題のある新規Priceを申込候補から外します。既存契約の扱いを決めずにStripe接続を切りません。

## 4. Welcome emailとメール公開面

**前提**: DEC-08の送信元名、reply-to、サポートメール、承認済みwelcome文面がある。`/welcome/`はPaid-members onlyである。

1. **Settings → Membership → Welcome emails** を開く。
2. 有料会員向けwelcome emailを有効にし、承認済み日本語文面を入力する。
3. 本文の導線は同一サイトの`/welcome/`だけを候補とし、YouTube URL、Dropbox URL、会員限定本文、API鍵、内部IDを件名、preheader、HTML、plain textへ入れない。
4. MVPではNewsletterを有効化しない。画面にNewsletter配信の選択肢が出る場合は無効のままとし、講義投稿はWeb公開だけにする。
5. 保存・再読込後、test会員でwelcome、magic link/one-time codeを実受信する。HTMLとplain text/MIMEを確認し、表示言語、送信元、reply-to、サポート導線、外部URL非包含を記録する。

**合格対象**: 日本語と認証導線はAT-02/06、講義メールの外部URL非包含はAT-19です。AT-42はContentRegistryの追跡試験であり、このメール設定の証跡には付けません。

**rollback**: welcome emailを変更前の文面・有効状態へ戻します。誤送信のおそれがあれば講義のEmail配信を停止し、既送信メールの削除を期待せず、リンク漏えい時は[リンク漏えい・誤公開Runbook](incident-link-leak.md)へ移ります。

## 5. 送信ドメイン

**前提**: 組織所有ドメイン、DNS変更担当、現在レコード、TTL、rollback案、送信元・reply-toが承認済みである。本番DNS変更はGate 5の本人操作とする。

1. **Ghost(Pro) → Domain** を開く。
2. 検証対象のsending domainを入力し、Ghost(Pro)が画面に示すDNSレコードを値ごとに転記せず、DNS担当へ安全な経路で渡す。
3. DNS担当が対象ゾーンと既存メールレコードを確認して適用する。成功表示が出るまで送信ドメインを「検証済み」と記録しない。
4. welcomeと認証メールを主要受信先で実受信し、From、reply-to、迷惑メール判定、返信先を確認する。

**証跡**: ドメイン、検証状態、実施時刻、DNS担当、受信結果を記録します。DNS検証値、メール本文の個人情報、完全なMessage-IDを公開リポジトリへ保存しません。対応はAT-02、AT-06、AT-19です。

**rollback**: 変更前のDNS記録と送信設定をDNS担当と照合して戻します。既存メール配送へ影響するレコードを推測で削除しません。復旧確認まで本番送信を再開しません。

## 6. テーマ所有のナビゲーションと状態別CTA

MVPのヘッダーとフッターはGhost Admin Navigationを描画しません。次を正本とします。

- ヘッダー: `packages/ghost-theme/partials/site-header.hbs`
- フッター: `packages/ghost-theme/partials/site-footer.hbs`
- 未ログイン / free・失効 / 有料の状態別CTA: 上記header、`home.hbs`、`partials/protected-cta.hbs`、`page-membership.hbs`

**Settings → Site → Navigation** は変更前の記録だけを取得します。この画面のPrimary/Secondary navigationを編集しても本テーマへ反映されません。別テーマへのrollback時に使われる可能性があるため、既存値は削除しません。

| 状態 | 期待する主な導線 |
|---|---|
| 未ログイン | ログイン `#/portal/signin`、会員になる `#/portal/signup` |
| free / 失効 | 再入会 `#/portal/signup`、アカウント `#/portal/account` |
| 有料 | ライブラリ `/lectures/`、アカウント `#/portal/account` |
| 全状態のフッター | お問い合わせ、利用規約、プライバシー、特商法表示、運営者情報 |

1. `/about/`、`/lectures/`、`/membership/`、`/faq/`、`/contact/`、`/terms/`、`/privacy/`、`/legal-commerce/`の各ページを作成し、公開範囲を確認する。`/about/`は活動紹介と運営者情報の双方から到達するため、両方の情報を承認済み本文で満たす。
2. 未ログイン、free/失効、有料の3状態で、デスクトップとモバイルメニューのラベル、順序、リンク先、キーボード操作を確認する。
3. free/失効会員の「再入会」はPortal signupを開き、有料会員のCTAは二重申込でなくライブラリ/Portal accountへ進むことを確認する。
4. フッター5リンクを全状態で開き、404、保護本文、外部メディアURLの混入がないことを確認する。

**合格対象**: AT-01、AT-02、AT-03、AT-04、AT-05、AT-08、AT-14。公開面の外部URL検査はAT-10として別途実施します。

**rollback**: Ghost Admin Navigationではなく、変更前のテーマZIPと`routes.yaml`を同じ検証サイトへ戻します。戻した後に主要URLと3状態のCTAを再試験します。

## 7. スクリーンショットと証跡

実画面は外部接続後に取得します。未取得の欄を画像で埋めたように見せたり、ローカルの静的HTMLをGhost Adminの実画面証跡として扱ったりしません。スクリーンショットがない段階は`NOT_RUN`または`BLOCKED_EXTERNAL_GATE`であり、PASSではありません。

| 画面 | before | after | test結果 | 対応 |
|---|---|---|---|---|
| Membership → Access | [ ] | [ ] | [ ] | AT-09/10 |
| Signup portal → Customize（DEC-21の5項目） | [ ] | [ ] | [ ] | AT-02/03/06/07/08/14、DEC-21 |
| Membership → Tiers / Portal価格表示 | [ ] | [ ] | [ ] | AT-06/07/08/14、DEC-03/04 |
| Membership → Welcome emails / 受信MIME | [ ] | [ ] | [ ] | AT-02/06/19 |
| Ghost(Pro) → Domain / 受信結果 | [ ] | [ ] | [ ] | AT-02/06/19、DEC-08 |
| Site → Navigation（未使用であることの現状記録） | [ ] | 変更なし | [ ] | AT-01/03/04/05 |
| 未ログイン、free/失効、有料、mobile CTA | n/a | [ ] | [ ] | AT-02/04/05/08/14 |

ファイル名は`GHOST-<environment>-<area>-<before|after>-YYYYMMDDThhmmssZ.png`のようにし、アクセス制限された証跡保管先へ置きます。公開Gitへ画像をcommitしません。会員氏名・メール、完全なMember/Customer/Subscription/Product/Price ID、カード・請求情報、API鍵、token、2FA、DNS検証値、不要なブラウザタブや通知をマスクします。対象Tier/Priceは必要な場合も末尾4文字だけを残します。

各画像または外部記録は、[受入証跡テンプレート](../evidence/acceptance-record-template.md)にenvironment、実施者、日時、対象、期待、実結果、対応AT/DEC、保管URI、SHA-256、承認者を記録します。秘密値や保護URLを証跡本文へ転記しません。

## 完了判定

1. 検証サイトで上記7節を実施し、差分とrollbackを運営責任者が承認した。
2. DEC-03/04/08/21が証跡付きで決定され、DEC-21の5項目が個別に確認できる。
3. AT-01〜10、AT-14、AT-19のうち本手順に対応する実測を記録した。未実施項目をPASSにしていない。
4. `npm run verify:all`と公開候補の`npm run audit:packages`が成功した。
5. テーマ、`routes.yaml`、Portal、Tier、メール、DNSのrollback担当と復旧手順が確認済みである。

一つでも満たさなければ本番はNo-Goです。次は[外部接続ゲート](external-connection-gates.md)と[リリースGo/No-Go](release-go-no-go.md)へ結果を引き継ぎます。
