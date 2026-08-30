# 再開ハンドオフ — 2026-08-31 コード／GitHub Goal完了・外部Gate 0開始前

## この文書の目的

みんほす会員管理MVPの再開正本です。最新要件は `docs/minhos-membership-requirements-v1.1.md` です。ローカル実装、依存再現、全自動検証、オンライン依存監査、複数回の変更禁止再監査、GitHub公開、公開履歴のprivacy修復、最新`main`のCI／artifact／保護・security read-backまで完了しています。監査で検出したGitHub生成commitのidentity問題は、違反commitを祖先に含めない履歴へ一回限りで修復し、author／committer双方のfull-history gateを追加しました。メール値や氏名は記録していません。ローカル実装・GitHubゲート内の未解決P0/P1/P2は0件です。外部・法務・運用のrelease blockerは`config/release-status.json`どおりOPENのままです。

本番公開は別判定です。Ghost／Stripe／Google Workspaceの実接続、AT-01〜45、DEC-01〜21、法務・権利・保存期間、実機quota・通知・復元の証跡が未完了なので、production release gateは意図どおり`NO_GO`です。

このチェックポイントでは、Ghost／Stripe／Google Workspaceへの接続、`clasp login`／`clasp push`、実決済、本番公開を実施していません。一回限りの公開`main`修復は完了済みであり、再実行しません。次は`G0-T`のtest適用判断、Gate 1の所有者・復旧担当、Gate 2の秘密情報境界を責任者と確定する段階です。完全なGate 0はOPENのまま、3条件の後にだけ架空データ／ダミー教材のtest専用環境へ接続します。

## ユーザーが担当する操作

- Ghost(Pro)の契約・支払い
- Stripeの本人確認、銀行口座登録、2FA
- GhostとStripeの初回接続承認
- ドメイン契約と最終的なDNS確認
- 利用規約、プライバシーポリシー、特商法表示の最終判断
- 本番公開と実カードによる最終決済確認
- Dropbox所定フォルダへのPDFアップロードと共有リンク作成
- YouTube所定再生リストへの限定公開動画アップロード

MakeとMux署名動画はMVPに含めません。秘密値、2FAコード、カード情報をチャットやGitへ渡しません。

## 完成したローカル成果物

- 要件定義v1.1、83件の要件マッピング、AT-01〜45、5段階UX、65件の運用チェック、release gate
- Ghost 6対応テーマ、会員状態別CTA、講義分類、公開URL漏えいガード、決定的ZIP、Ghost Admin設定Runbook
- Ghost／StripeからGoogle Sheetsへの一方向同期、3軸状態、完全走査、tombstone、cursor、owner-fenced lease、通知outbox
- Google Forms所有のnative／opaqueな`30_Profile_RAW`と、event response IDを保存する`40_Supplemental`の境界
- Sheets／Forms設定資材、秘密情報名称一覧、fixture、自動テスト、CI、運用・復旧・終了Runbook
- `AGENTS.md`、管理者`README.md`、接続引継ぎ票、外部接続準備チェックリスト

## 閉じた主要監査項目

- Form retry successor markerの保存失敗時も、作成済みtriggerとqueueを残してlivenessを維持
- notification outboxのproperty単位repair、bounded hash-only quarantine、因果順序配送
- cursorの全status opaque snapshot、claim時CAS、owner-fenced write／clear／quarantine、strict renew
- malformed cursor／leaseの固定reason＋hash-only隔離、PII・秘密値の非露出
- Git履歴のauthor／committer双方をGitHub noreply形式へ限定するfull-history CI gate
- identity preflight前の永続副作用禁止と、claim後／commit直前のowner fence
- MembersとSubscriptions／AccessGrants／Supplementalのcross-table identity
- Subscription／Invoiceを含むStripe pageの全体検証をSheet書込み前に実施
- Ghost投影のnever-projected／current／historical tombstone、shared missing clock、再出現
- 3 Sheet置換境界のwrite-ahead tombstone commit。post-replace cursor失敗後もresumeし、二重計数せずSyncLogへ反映
- Google Forms native回答タブを固定headerや主キーで変更しないschema／initializer／repository／trigger契約
- Ghostのtheme-owned navigation、運営者情報、free／失効会員の再入会導線

## 最新の実測検証

| 検証 | 結果 |
|---|---|
| `npm ci` | PASS |
| `npm run install:packages` | PASS |
| `npm run verify:all` | PASS |
| root config／requirements／secrets | PASS: 11 config files、61 required artifacts、83 mappings、65 operational checks、AT-01〜45 |
| reachable Git commit identities | PASS: author／committerともGitHub noreply形式 |
| root tests | PASS: 42/42 |
| Ghost theme | PASS: 10/10、Ghost 6 GScan、public URL guard、deterministic ZIP build |
| Apps Script TypeScript／build | PASS |
| Apps Script tests | PASS: 30 files／214 tests |
| `npm run audit:packages` | PASS: 未承認high／critical 0、期限内development-only例外1件 |
| 変更禁止再監査 | PASS: ローカルP0/P1/P2 0件 |
| 最新`main` GitHub CI／artifact | PASS: `CI / verify`、SHA-bound Ghost ZIP、CI記録値とローカルbuildのchecksum一致 |
| GitHub controls | PASS: app-bound `verify`、strict／admins／linear／conversation、force push・削除禁止、Actions selected＋SHA pin、security read-back |
| `npm run release:gate` | 想定どおり`NO_GO`: 外部AT／DEC／証跡未完 |

Ghost ZIP SHA-256は `a2c869ba10a7673a2a9ca3b9b7b52bf8e077f8e3583d5db069a7cf8ebef7844a` です。ローカルbuildとGitHub Actions artifact内の`SHA256SUMS.txt`が一致しました。ZIPは`dist/`配下の生成物でGit管理しません。

## GitHubの現在地

- origin: `https://github.com/yukinohana42/minhos-member-system.git`
- repository: public、default branchは`main`
- 初回実装commit: `8b931750957cf4a28dcf9aef3b8fba2fd4379b67`
- 公開履歴privacy修復checkpoint: `745e8ad2469493c896c782d5765c50d748dccbee`。その後の通常PRでbranch protection payload互換修正を反映済み
- 最新`main`のGitHub Actions `CI / verify`成功、SHA-bound artifactとローカルbuildのchecksum照合済み。現在値は`git rev-parse origin/main`とGitHub Actionsの最新`main` push runを正本とする
- GitHub CLI認証: 確認済み
- Actions: enabled、`allowed_actions=selected`、完全長SHA pin必須
- workflowの3 actionは公式Node.js 24対応v7 release commitへ固定し、許可listと双方向検査する
- CI checkout: full history。author／committer privacy gateを`verify:all`で実行
- allowlist: workflowが使う3 actionと正本JSONが一致
- secret scanning、push protection、Dependabot security updates、vulnerability alerts、private vulnerability reporting: enabled
- main protection: enabled。GitHub Actions app（`app_id: 15368`）由来の`verify`必須、strict、adminsにも適用、linear history、force push／branch削除禁止、conversation resolution必須
- repo-local identity: `yukinohana42` とGitHub noreply email
- 現在のGit設定にcommit署名強制はない。要件・保護設定にも署名必須条件はない
- 一回限りの`main`置換、正本保護復元、新履歴のCI／artifact／remote identity read-backは完了。履歴修復を再実行しない
- 旧commitを指すhead／tag／pull refはないが、旧SHAの直接参照やGitHub cacheからの完全消去は保証しない。通常branchへ再導入せず、完全消去が必要な場合だけGitHub Support／Privacy窓口へ相談する

以後は`main`から短命branchを作り、CI成功後にPRで線形に反映します。`git clean`、`git reset --hard`、作業ディレクトリ削除を行いません。

## 次の安全な順序

1. 接続開始直前にremote `main`、最新CI、保護・Actions・security設定をread-onlyで再取得する。公開履歴修復は完了済みなので再実行しない。
2. `G0-T`として要件書20.1のDEC、test専用資源、架空データ、ダミー教材、非公開、`manualSync()`1回と必要時の一時`resumeSync`だけの境界を責任者が確定する。要件書20.2のDECは本番blockerとして残し、Gate 0を完了扱いにしない。
3. Gate 1のサービス所有者・復旧担当・権限分担と、Gate 2の秘密情報の最小権限・保管・失効境界を確定する。
4. `docs/runbooks/connection-handoff.md`の4行の準備完了だけを責任者へ一度に確認する。
5. 本人がGhost／Stripe／Googleへログインし、2FA、Custom Integration、restricted test key、Google OAuthを各サービス画面内で完了する。秘密値をチャットへ送らない。
6. Codexは認証後、test専用Apps Script／Spreadsheet／Formへdeployし、`installMinhosTriggers()`は実行せず`manualSync()`を1回実行する。時間上限時の一時`resumeSync`だけを許可する。環境／Account／allowlist／schema、通知、backup／restoreを確認し、trigger前のP1/P2が0になった後だけ、5つの永続triggerを別承認する。
7. Ghost test siteへthemeとroutesを別々に適用し、状態別表示と公開面漏えいを確認する。
8. test modeのAT証跡とDECを記録し、Gate 3のtest接続で発生したP1/P2が0の時だけ本番Go/No-Goへ進む。

## 外部接続後まで残るNo-Go

- test Ghostでtheme＋routesを適用し、未ログイン／free／paid／comped／gift、meta／OGP／RSS／検索／メール／ActivityPubを実測する。
- Stripe test modeでAccount、livemode、Product／Price allowlist、支払成功・失敗・回収・解約・返金・Disputeを確認する。
- 組織所有のStandalone Apps Script、専用Spreadsheet／Form／Drive folderで、権限、native RAW、trigger、quota、通知、バックアップ／復元を確認する。
- AT-01〜45の証跡、DEC-01〜21、法務・講師許諾・保存期間・外部URL再共有リスクを責任者が確定する。

これらをローカルfixtureや文書だけでPASSへ変更しません。Ghostテーマ単体はisolated test Ghostへの導入のみ`Conditional Go`、本番は`NO_GO`です。

## 再開時の安全境界

- StripeとGhostを正本、Google Sheetsを一方向の運用ミラーとして維持する。
- Sheet、Form回答、通知、ログ、Gitへ秘密値や保護コンテンツURLを保存しない。
- 既存会員の変更、解約、返金、削除、統合、実決済、本番公開を自動実行しない。
- DropboxとYouTubeへのアップロードはユーザー担当のままにする。
- 外部資格情報を使う前に、対象site／account／livemode／Spreadsheet markerを確認する。

## 完了条件

ローカル実装・GitHubゲート内のP0/P1/P2 0、`verify:all`、依存監査、接続資材、公開履歴privacy修復、最新`main`のCI／artifact／identity／保護・security read-backが完了し、コード／GitHub側Goalの停止条件を満たしています。本番Goは別判定であり、外部Gate 0〜5、AT、DEC、法務／権利、実決済が未完のため`NO_GO`です。

## 次回Codexへ送る短い再開プロンプト

> `AGENTS.md`、`docs/engineering/resume-handoff.md`、要件定義書v1.1を順に読み、コード／GitHub側Goalは完了済み、外部Gate 0はOPEN、productionは`NO_GO`と認識してください。最初にremote `main`、到達履歴のidentity、最新CI、GitHub保護状態をread-onlyで再取得し、公開履歴修復は再実行しないでください。外部接続を始める依頼がある場合だけ`G0-T`のtest判断、Gate 1の所有者、Gate 2の秘密境界を確定し、その後`docs/runbooks/connection-handoff.md`の4行を一括確認してください。`G0-T`中は架空会員・ダミー教材・test専用資源・非公開・初回`manualSync()`と必要時の一時`resumeSync`だけに限定し、trigger前のP1/P2が0になった後だけ5つの永続triggerを別承認してください。本番SaaSはGateと本人承認を満たすまで変更しないでください。
