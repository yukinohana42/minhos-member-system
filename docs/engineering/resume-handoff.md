# 再開ハンドオフ — 2026-08-30 ローカル・GitHub基盤完成／外部接続直前

## この文書の目的

みんほす会員管理MVPの再開正本です。最新要件は `docs/minhos-membership-requirements-v1.1.md` です。2026-08-30 18:10 JST時点で、ローカル実装、依存再現、全自動検証、オンライン依存監査、複数回の変更禁止再監査、GitHub初回公開、CI、main保護まで完了しています。ローカルコードの未解決P0/P1/P2は0件です。

本番公開は別判定です。Ghost／Stripe／Google Workspaceの実接続、AT-01〜45、DEC-01〜21、法務・権利・保存期間、実機quota・通知・復元の証跡が未完了なので、production release gateは意図どおり`NO_GO`です。

このチェックポイントでは、Ghost／Stripe／Google Workspaceへの接続、`clasp login`／`clasp push`、実決済、本番公開を実施していません。GitHub上のコードと検証基盤は完成しています。

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
| root config／requirements／secrets | PASS: 11 config files、83 mappings、65 operational checks、AT-01〜45 |
| root tests | PASS: 35/35 |
| Ghost theme | PASS: 10/10、Ghost 6 GScan、public URL guard、deterministic ZIP build |
| Apps Script TypeScript／build | PASS |
| Apps Script tests | PASS: 30 files／214 tests |
| `npm run audit:packages` | PASS: 未承認high／critical 0、期限内development-only例外1件 |
| 変更禁止再監査 | PASS: ローカルP0/P1/P2 0件 |
| `npm run release:gate` | 想定どおり`NO_GO`: 外部AT／DEC／証跡未完 |

Ghost ZIP SHA-256は `a2c869ba10a7673a2a9ca3b9b7b52bf8e077f8e3583d5db069a7cf8ebef7844a` です。ローカルbuildとGitHub Actions artifact内の`SHA256SUMS.txt`が一致しました。ZIPは`dist/`配下の生成物でGit管理しません。

## GitHubの現在地

- origin: `https://github.com/yukinohana42/minhos-member-system.git`
- repository: public、default branchは`main`
- 初回実装commit: `8b931750957cf4a28dcf9aef3b8fba2fd4379b67`
- GitHub Actions CI run: `33303205826`、`verify`成功、対象SHA一致
- CI artifact: `minhos-ghost-theme-8b931750957cf4a28dcf9aef3b8fba2fd4379b67`、artifact ID `9729609111`、checksum照合済み
- GitHub CLI認証: 確認済み
- Actions: enabled、`allowed_actions=selected`、完全長SHA pin必須
- allowlist: workflowが使う3 actionと正本JSONが一致
- secret scanning、push protection、Dependabot security updates、vulnerability alerts、private vulnerability reporting: enabled
- main protection: enabled。`verify`必須、strict、adminsにも適用、linear history、force push／branch削除禁止、conversation resolution必須
- repo-local identity: `yukinohana42` とGitHub noreply email
- 現在のGit設定にcommit署名強制はない。要件・保護設定にも署名必須条件はない

初回実装はGit履歴へ保存済みです。以後は`main`から短命branchを作り、CI成功後にPRで線形に反映します。`git clean`、`git reset --hard`、作業ディレクトリ削除を行いません。

## 次の安全な順序

1. 実接続を開始する日程を決め、`docs/runbooks/connection-handoff.md`の4行の準備完了だけを責任者へ一度に確認する。
2. 本人がGhost／Stripe／Googleへログインし、2FA、Custom Integration、restricted test key、Google OAuthを各サービス画面内で完了する。秘密値をチャットへ送らない。
3. Codexは認証後、test専用Apps Script／Spreadsheet／Formへdeployし、scheduled triggerを作らず`manualSync()`を1回実行する。
4. Ghost test siteへthemeとroutesを別々に適用し、状態別表示と公開面漏えいを確認する。
5. test modeのAT証跡とDECを記録し、P1/P2が0の時だけ本番Go/No-Goへ進む。

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

このGoalの停止条件である、ローカルP0/P1/P2 0、`verify:all`と依存監査の合格、初回GitHub push、対象commitのCI成功、main保護とGitHub security設定のread-back、本番接続直前チェックリスト、一括本人操作手順は完了しています。本番Goは別判定です。

## 次回Codexへ送る短い再開プロンプト

> `AGENTS.md`、`docs/engineering/resume-handoff.md`、要件定義書v1.1を順に読み、記録済みcommit／CI／GitHub保護状態をread-onlyで再取得してください。ローカル`verify:all`とsecret scanを再現し、外部接続を始める場合だけ`docs/runbooks/connection-handoff.md`の一括確認へ進んでください。本番SaaSはGateと本人承認を満たすまで変更しないでください。
