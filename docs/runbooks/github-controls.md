# GitHub初期公開・保護Runbook

## 目的

`yukinohana42/minhos-member-system` を再現可能な検証基盤として使い、`main` の履歴改変、検証未完了の更新、秘密情報のpushを防ぎます。この手順はコードと文書の公開だけを対象とし、Ghost、Stripe、Google Workspaceへは接続しません。

## 初回だけの順序

1. `npm ci`、`npm run install:packages`、`npm run verify:ci` をローカルで完了する。
2. `npm run release:gate` が、外部受入未完了を理由に `NO_GO` となることを確認する。これはGitHubへのコードpushを止める判定ではなく、本番公開だけを止める判定である。
3. `git status --short` と `npm run check:secrets` で、生成物、資格情報、個人情報がstage対象にないことを確認する。
4. 初回commitを `main` へpushし、GitHub Actionsの `verify` jobが成功するまで監視する。
5. 責任者レビュー後、`config/github-actions-permissions.json`、`config/github-actions-selected-actions.json` の順でActions permissions APIへ適用し、read-only APIで両方の実状態を再取得する。selected-actions endpointの前提として、先に `allowed_actions=selected` を設定する。適用は外部writeであり、system-ownerの明示承認が必要である。
6. 制限適用後のGitHub Actionsで `verify` が成功することを再確認する。
7. `config/github-main-protection.json` をGitHub Branch protection APIへ適用する。
8. branch protection、Dependabot alerts、secret scanning、push protectionの実状態をread-only APIで再取得し、非秘密の結果だけを記録する。
9. Private vulnerability reportingが有効で、`SECURITY.md` の非公開報告導線が開けることを確認する。

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

- `verify` status checkを最新`main`に対して必須化する。
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

## 通常変更

1. `main`から短命branchを作る。
2. 小さいcommitで変更し、PRを作る。
3. `verify`成功、未解決会話ゼロ、P1/P2ゼロを確認する。
4. squashまたはrebaseで線形にmergeする。
5. 本番候補だけは、GitHub Actions run、commit SHA、要件書digest、テーマZIP digestを構造化リリース証跡へ結び付ける。

## 停止条件

- `verify`が失敗、pending、skip、または対象commitと不一致。
- GitHub Actionsが想定外fork、workflow、再実行回数を示す。
- secret scanning/push protectionが資格情報候補を検出する。
- Private vulnerability reportingが無効、または脆弱性の報告先が公開Issueしかない。
- branch protectionが取得できない、または正本JSONと異なる。
- Actions permissionsのread-backがいずれかの正本JSONと異なる、またはworkflowとexternal action許可リストが一致しない。
- release evidenceがimmutableなcandidate commit、candidate内容の要件書、candidate由来の成果物digestへ一致しない。

検出時は保護を弱めて通さず、原因を修正した新commitで再検証します。
