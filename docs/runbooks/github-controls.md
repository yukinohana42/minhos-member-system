# GitHub初期公開・保護Runbook

## 目的

`yukinohana42/minhos-member-system` を再現可能な検証基盤として使い、`main` の履歴改変、検証未完了の更新、秘密情報のpushを防ぎます。この手順はコードと文書の公開だけを対象とし、Ghost、Stripe、Google Workspaceへは接続しません。

## Commit identityのprivacy前提

- GitHubアカウントの`Settings > Emails > Keep my email addresses private`を有効にし、GitHub上で生成されるcommitにもnoreply identityを使う。
- repository-localの`user.email`をGitHub noreply addressへ固定する。実メールを設定値、文書、fixtureへ転記しない。
- GitHubの`Block command line pushes that expose my email`は補助として有効にする。ただし最新commitのauthorだけを対象とし、committerや複数commitの完全な検査には使わない。
- `npm run check:commit-identities`は、HEADから到達可能な全commitのauthor／committerを検査する。許可するのはGitHub user／botの`users.noreply.github.com`形式と、GitHub Web操作の`noreply@github.com`だけである。
- `npm run setup:git-hooks`でrepository-localの`core.hooksPath`を`.githooks`へ固定する。追跡済み`pre-push` hookは、commit作成後かつGitHub公開前に同じ検査を実行する。
- CIは`fetch-depth: 0`で履歴を取得する。検査失敗時はメール値や氏名を出力せず、commit SHAとauthor／committerの役割だけを示す。
- GitHubがsquash／rebase／merge時に生成する最終commitは作成前に検査できない。metadata rulesetを利用できない契約では、アカウントのメール非公開設定が一次防止、`main`のpush CIが公開後の二次検知になる。この限界を「サーバー側で完全防止」と表現しない。

## 初回だけの順序

1. `npm ci`、`npm run install:packages`、`npm run setup:git-hooks`、`npm run verify:ci`をローカルで完了する。
2. `npm run release:gate` が、外部受入未完了を理由に `NO_GO` となることを確認する。これはGitHubへのコードpushを止める判定ではなく、本番公開だけを止める判定である。
3. `git status --short`と`npm run check:secrets`で、生成物、資格情報、個人情報がstage対象にないことを確認する。
4. ローカルcommitを作成する。commit後に`npm run check:commit-identities`を実行し、author／committerがnoreplyであることを確認してから初めてpushする。pre-push hookを迂回しない。
5. GitHub Actionsの`verify` jobが成功するまで監視する。
6. 責任者レビュー後、`config/github-actions-permissions.json`、`config/github-actions-selected-actions.json` の順でActions permissions APIへ適用し、read-only APIで両方の実状態を再取得する。selected-actions endpointの前提として、先に `allowed_actions=selected` を設定する。適用は外部writeであり、system-ownerの明示承認が必要である。
7. 制限適用後のGitHub Actionsで `verify` が成功することを再確認する。
8. `config/github-main-protection.json` をGitHub Branch protection APIへ適用する。
9. branch protection、Dependabot alerts、secret scanning、push protectionの実状態をread-only APIで再取得し、非秘密の結果だけを記録する。
10. Private vulnerability reportingが有効で、`SECURITY.md` の非公開報告導線が開けることを確認する。

## Actions permissionsの正本

次の2ファイルはGitHub REST APIへそのまま渡す、repository-level Actions permissionsの正本です。

- `config/github-actions-permissions.json`: Actionsを有効化し、許可方式を `selected` に限定し、完全長commit SHAへのpinを必須にする。
- `config/github-actions-selected-actions.json`: GitHub-owned／verified actionの包括許可をともに無効化し、`.github/workflows/ci.yml` が実際に参照する外部actionだけを、完全長40桁SHA付きで列挙する。

`npm run check:config` はworkflowの全external `uses:` と `patterns_allowed` の集合が双方向に完全一致することを検査します。tag、branch、短縮SHA、未使用の許可、許可されていないworkflow参照は失敗します。actionを更新するときは、供給元と新しいcommit SHAをレビューしたうえでworkflowと許可リストを同じ変更で更新します。ローカルaction (`./...`) はrepository外コードを取得しないため、この外部許可リストの対象外です。

責任者承認後の適用とread-back例:

```powershell
gh api --method PUT -H "X-GitHub-Api-Version: 2026-03-10" repos/yukinohana42/minhos-member-system/actions/permissions --input config/github-actions-permissions.json
gh api --method PUT -H "X-GitHub-Api-Version: 2026-03-10" repos/yukinohana42/minhos-member-system/actions/permissions/selected-actions --input config/github-actions-selected-actions.json
gh api -H "X-GitHub-Api-Version: 2026-03-10" repos/yukinohana42/minhos-member-system/actions/permissions/selected-actions
gh api -H "X-GitHub-Api-Version: 2026-03-10" repos/yukinohana42/minhos-member-system/actions/permissions
```

read-backは秘密値を含めず、両方の正本JSONと意味的に完全一致しなければ停止します。APIの仕様はGitHub公式の [REST API endpoints for GitHub Actions permissions](https://docs.github.com/en/rest/actions/permissions) を確認します。このRunbookは適用権限を与えるものではありません。

## Branch protectionの正本

`config/github-main-protection.json` は次を固定します。

- `verify` status checkを最新`main`に対して必須化し、GitHub Actions app（`app_id: 15368`）だけを提供元として許可する。
- 更新APIのrequestでは`checks`だけを指定し、deprecatedな`contexts`を同時指定しない。GitHubのGET応答が互換表示として`contexts`を返しても、それをそのままPUT payloadへコピーしない。
- 管理者にもルールを適用する。
- force push、branch削除、merge commitによる非線形履歴を禁止する。
- 未解決のreview会話があるPRをmergeしない。
- solo運用のため承認レビュー人数は必須化しない。別の責任者が参加した時点で見直す。

適用と確認の例:

```powershell
gh api --method PUT repos/yukinohana42/minhos-member-system/branches/main/protection --input config/github-main-protection.json
gh api repos/yukinohana42/minhos-member-system/branches/main/protection
gh pr checks <PR番号>
```

## 公開commit identityを修復する一回限りの手順

公開`main`にnoreply形式でないauthor／committer emailを検出した場合は、通常PRへ進まない。違反commitをbaseとして含むPRはfull-history gateに失敗し、履歴からも除去できないためである。次の操作は履歴改変を伴う例外であり、責任者の明示承認を1回取得してから行う。

1. pushを止め、公開branch、tag、PR ref、forkをread-onlyで列挙する。メール値や氏名を証跡へ記録しない。
2. 最後の健全なcommitから修復candidateを作り、必要なtree差分だけを再適用する。candidateの到達可能な全履歴を`npm run check:commit-identities`で検査する。
3. `npm run verify:all`、`npm run audit:packages`、hook mode `100755`、`core.hooksPath=.githooks`、clean worktreeを確認する。実行スクリプトはorigin URLとpush元のliteral candidate SHAを固定し、一時保護JSONが正本から次項の2項目以外に逸脱していないことを実行時にも検査する。
4. GitHubアカウントのメール非公開を有効にし、値を表示しないread-backで`private`を確認する。CLI tokenに`user` scopeがない場合は、ログイン済みのGitHub設定画面で責任者のaction-time承認後に変更・再確認し、メール値を記録しない。
5. remote `main`が監査済みの旧SHAから動いていないことを確認する。新しい未公開SHAにはGitHub Actionsの必須checkがまだ存在せず、force push許可だけでは更新できない。そのため例外時間中だけ`required_status_checks: null`と`allow_force_pushes: true`へ変更する。admins適用、linear history、branch削除禁止、conversation resolution等は維持し、branch protection自体は削除しない。この2項目の一時緩和を承認範囲へ明記する。
6. 旧SHAを明示した`--force-with-lease`でliteral candidate SHAを`main`へ1回だけ送る。保護変更のAPI応答が失敗または不明でも、変更を試みた時点から`finally`相当の処理で正本`config/github-main-protection.json`を必ず再適用し、GET結果を意味的に比較する。
7. remote `main`、正本へ復元したbranch protection、Actions／security設定、到達可能なcommit identitiesをread-backし、新しい`main` SHAで自動起動したpush CIとartifact checksumを確認する。ローカル`main`も同じSHAへ合わせる。新SHAのCIが成功するまで外部接続へ進まない。
8. force push後も旧SHAの直接参照、cache、clone等から完全消去される保証はない。fork 0、影響ref除去を確認し、完全消去が必要ならGitHub SupportまたはPrivacy窓口へ依頼する。旧SHAを通常branchへ再導入しない。

保護復元を確認できない場合は最優先のP1として停止し、他作業へ進まない。履歴修復を本番SaaS接続と同時実行しない。

## 通常変更

1. `main`から短命branchを作る。
2. 小さいローカルcommitを作るたび、`npm run check:commit-identities`を成功させてからpre-push hook経由でpushし、PRを作る。
3. `verify`成功、未解決会話ゼロ、P1/P2ゼロ、GitHubアカウントのメール非公開設定を確認する。
4. squashまたはrebaseで線形にmergeする。
5. 更新後の`main`を取得し、`npm run check:commit-identities`と対象SHAのpush CIが成功することを確認する。GitHubがmerge時に生成したcommitも検査対象から外さない。
6. 本番候補だけは、GitHub Actions run、commit SHA、要件書digest、テーマZIP digestを構造化リリース証跡へ結び付ける。

## 停止条件

- `verify`が失敗、pending、skip、または対象commitと不一致。
- GitHub Actionsが想定外fork、workflow、再実行回数を示す。
- secret scanning/push protectionが資格情報候補を検出する。
- 到達可能なcommitのauthorまたはcommitterがGitHub noreply形式でない。
- Private vulnerability reportingが無効、または脆弱性の報告先が公開Issueしかない。
- branch protectionが取得できない、または正本JSONと異なる。
- Actions permissionsのread-backがいずれかの正本JSONと異なる、またはworkflowとexternal action許可リストが一致しない。
- release evidenceがimmutableなcandidate commit、candidate内容の要件書、candidate由来の成果物digestへ一致しない。

検出時は保護を弱めて通さず、原因を修正した新commitで再検証します。
