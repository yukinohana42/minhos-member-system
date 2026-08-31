# 外部Gate 0〜2 承認記録 — 2026-08-31

## 記録情報

| 項目 | 値 |
|---|---|
| record_id | `G0T-APPROVAL-20260831-01` |
| recorded_at | `2026-08-31T05:57:25Z` |
| actor_role | `responsible-owner` |
| approver_role | `responsible-owner` |
| source | 現在の作業セッションでの明示承認 |
| environment | `test-planning` |
| secret_or_pii_included | `NO` |

この記録は隔離testへ向けた製品判断と作業権限の記録であり、本番release attestationではない。実アカウントID、個人名、メール受信者、秘密値、2FA／復旧コード、外部コンテンツURLは記録しない。

## 判定

| 対象 | 状態 | 理由 |
|---|---|---|
| `G0 Decision` | `OPEN` | 本番必須DEC-09〜18、20と外部受入が未完 |
| `G0-T`の作業範囲 | `APPROVED` | test専用資源、架空データ、ダミー教材、非公開、`manualSync()`1回と必要時の一時`resumeSync`までを承認 |
| `G0-T`への実際のentry | `PENDING_PREREQUISITES` | DEC-06の実講師候補、DEC-07／Gate 1の副担当・復旧記録、Gate 2 pre-entry境界の責任者確認が未完 |
| Gate 1 | `OPEN — REGISTER_CREATED / PRIVATE_COMPLETION_PENDING` | 役割方針と制限付き外部台帳のひな型は作成済み。非公開情報の本人記入・6サービス確認が未完 |
| Gate 2 pre-entry boundary | `OPEN — INVENTORY_CREATED / OWNER_CONFIRMATION_PENDING` | 鍵の種類・最小権限・保管区分・保管者role・test/live分離・rotation／失効方針と値なし台帳は作成済み。責任者確認が未完 |
| Gate 2 runtime verification | `NOT_STARTED — GATE_3` | test project作成と本人による直接入力後、秘密値を読み出さず存在・権限・環境分離を確認する。G0-T entry prerequisiteには含めない |
| Gate 3〜5 | `NOT_STARTED` | Gate 3用test資源、認証、deploy、同期、AT、本番承認は未実施 |
| production | `NO_GO` | 本記録は本番承認を含まない |

## 承認済みのtest向け判断

| ID | 状態 | 承認内容 | 未実施・保留 |
|---|---|---|---|
| DEC-01 | `DECIDED_FOR_TEST` | 表示名`みんほす`、既存ロゴ／ブランド色、親しみやすく専門性を保つ文体 | Ghost上の実表示確認 |
| DEC-02 | `DECIDED_FOR_TEST` | 親ドメイン`minhos-management.jp`、会員サイト予定FQDN`members.minhos-management.jp` | 所有・利用可否・DNSは未検証。DNS変更はGate 5まで行わない |
| DEC-03 | `DECIDED_FOR_TEST` | Tier表示名`みんほす会員`、月額のみ、JPY 1,100円・税込表示、年額なし | 税務最終判断はDEC-18。名称変更時は表示名を変更し、既存ID・契約履歴を再作成しない。価格変更は新Priceを作る |
| DEC-04 | `DECIDED_FOR_TEST` | 無料募集、trial、coupon、休会、gift、通常運用compedをMVPでは無効 | test fixtureで必要な承認済み権利状態だけは隔離環境で確認可 |
| DEC-05 | `DECIDED_FOR_TEST` | Ghostは氏名欄と必須メール。Formは登録メールと同意を必須、所属・肩書き・参加区分は任意。未回答でも閲覧可 | Google Formの実設定・AT-24／41 |
| DEC-06 | `PARTIALLY_DECIDED` | test開催年`2026`、シリーズ`救急外来を乗り越えようシリーズ`、提供済み20タイトル、下記9テーマ分類、test講師`テスト講師` | 実講師の初期候補は未定。`G0-T` entry前に確定が必要 |
| DEC-07 | `PARTIALLY_DECIDED` | MVP開始時は運営責任者が`system-owner`／`content-owner`／`member-ops`を兼務し、最小権限を採用 | 副担当・復旧方法を非公開台帳へ記録するまで未決 |
| DEC-08 | `DECIDED_FOR_TEST` | 公開予定サポート`support@minhos-management.jp`、一次回答2営業日以内 | mailbox所有・送受信は未検証 |
| DEC-19 | `DECIDED_FOR_TEST` | `mailto:`と案内文を使用し、問い合わせFormはMVPで作らない | 実メール到達確認 |
| DEC-21 | `DECIDED_FOR_TEST` | 氏名欄、対象Tier／Price、規約notice、必須同意checkbox、サポートメールを有効化 | Portalへの設定・表示・法務最終確認は未実施 |

Portal notice候補は次とする。

> 月額1,100円（税込）の自動更新プランです。お申し込み前に利用規約とプライバシーポリシーをご確認ください。

noticeからの導線は`/terms/`と`/privacy/`、全ページのfooterには`/legal-commerce/`も置く。法務文面そのものはDEC-15の最終確認前なので未承認とみなす。

### 承認済みのtest分類

- 開催年: `2026`
- シリーズ: `救急外来を乗り越えようシリーズ`
- テーマ候補（9分類）: アレルギー救急、神経救急、感染症・敗血症、循環器救急、呼吸器救急、代謝・内分泌救急、腎救急、消化器・肝胆道救急、アルコール関連
- test講師: `テスト講師`
- タイトル候補（20件）: アナフィラキシー、てんかん重積、尿路感染症/蜂窩織炎、不整脈 頻脈、肺炎、急性冠症候群、アルコール関連、失神、不整脈 徐脈、脳出血、胆道系疾患、脳梗塞、心不全 part1、心不全 part2、喘息、Sepsis/Septic shock、高血糖緊急症、COPD急性増悪、急性腎障害、消化管出血

## Gate 1／2の承認済み方針

- 非公開Sheet名: `みんほす_運用権限・復旧台帳`
- Git／会話で使える値なし参照alias: `GDRIVE-MINHOS-OPS-001`
- aliasは共有範囲を意味しない。Sheet本体は`RESTRICTED`とし、公開リンクを作らない。
- Gate 1タブには6サービスの主担当role、副担当role、組織所有・移管可否、個人別2FA、共有ログイン禁止、復旧方式、最小権限、棚卸し日、値なし証跡参照だけを置く。
- Gate 2タブには資格情報の名称、環境、用途、保管区分、アクセスrole、最小scope、test/live分離、rotation、失効方法だけを置く。秘密値、password、token、2FA／復旧コードは置かない。
- Script Propertiesの秘密は`GHOST_ADMIN_API_KEY`と`STRIPE_RESTRICTED_KEY`の2件だけ。Stripeは`rk_test_...`かつ承認済みリソースのRead-onlyに限定し、`sk_...`と`rk_live_...`をtestで使用しない。
- 値は責任者本人が各サービス／Apps Script画面へ直接入力し、Codex、チャット、Git、Sheet、ログへ渡さない。

## 項目8の作業権限

次を承認済みとする。ただしGate 3へ入る前に上記prerequisiteを完了する。

- Codexによるtest専用Spreadsheet／Form／Drive／Standalone Apps Scriptの作成・設定。
- 検証済みbundleのtest projectへのdeploy。
- `manualSync()`の1回実行と、実行時間上限時にコードが作る一時`resumeSync`。
- backup取得後のisolated test Ghostへのthemeと`routes.yaml`の個別適用。
- 承認済みGate 3ケースに必要なisolated Ghost test会員／Stripe test objectのtest環境内作成。

この承認に含まれないもの:

- `installMinhosTriggers()`と5つの永続trigger。
- live key、本番Stripe、本番DNS、実カード、本番課金、本番公開。
- 実会員の課金・権限・削除・統合・返金・解約。
- 既存講義の実YouTube／Dropbox URLや個人情報の投入。

## 未決のまま維持するもの

- DEC-06の実講師候補とDEC-07／Gate 1の非公開副担当・復旧記録。
- 本番必須DEC-09〜18、20。
- AT-01〜45、外部quota、通知、backup／restore、実機、法務・税務・権利確認。
- `BLK-EXT-01`、`BLK-EXT-02`、`BLK-LEGAL-01`、`BLK-OPS-01`。

`config/release-status.json`はproduction candidate専用なので変更せず、全DEC／AT／blockerを従来どおり本番未完として保持する。

## この時点の外部変更

Gate 1／2の準備として、My Driveの`ChatGPT`フォルダとnative Google Sheet`みんほす_運用権限・復旧台帳`を作成し、同Sheetをフォルダへ移動した。connector read-backで2タブ、`shared=false`、`source_visibility_status=not_shared`を確認し、ログイン済みブラウザでも「非公開」と両タブの描画を確認した。外部ID／URL、アカウント情報、個人名、秘密値はこの記録へ保存しない。

Gate 3用test Spreadsheet／Form／Drive backup folder／Standalone Apps Script、Ghost、Stripe、DNS、YouTube、Dropboxへの作成・設定・deploy・同期・本番変更は実施していない。台帳の作成はGate 1／2完了を意味せず、責任者の非公開入力・確認が完了するまで両Gateは`OPEN`である。
