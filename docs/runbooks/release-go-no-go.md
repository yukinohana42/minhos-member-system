# リリース Go/No-Go Runbook

## Go条件

- [ ] 要件書 v1.1 と実装差分のトレースが更新済みで、MUST要件にATまたは明示的運用確認がある。
- [ ] `npm run verify:all` が成功し、secret scanに検出がない。
- [ ] `config/requirements-trace.json#operationalChecks` の全65件がリリース状態に過不足・重複なく存在する。`production-required`は`PASS`、`mvp-advisory`は証跡付き`PASS`または`DEFERRED`、`future/non-mvp`は`scope-approval`証跡付き`NOT_APPLICABLE`である。
- [ ] オンライン環境で `npm run audit:packages` が成功し、未承認のhigh/critical脆弱性がない。期限付き例外は対象経路が緩和策どおりであること、責任者、再確認日を記録する。監査不能または期限切れならNo-Goとする。
- [ ] Ghost／Stripe／Google WorkspaceのG0〜G4、YouTube／Dropbox／DNSの該当確認が完了している。
- [ ] DEC-01〜DEC-21のローンチ必須事項、料金、法務、権利、保存期間、サポート、URL再共有リスクが承認済みである。
- [ ] P1/P2未解決がなく、既知制約・Stage C移行条件が運営責任者に共有されている。
- [ ] Backup、復元試験、停止順、rollback、監視、問い合わせ先が確認済みである。
- [ ] サービス終了時の責任者が [サービス終了Runbook](service-shutdown.md) を読み、Ghost停止だけではStripe課金が止まらないことを確認した。
- [ ] release ID、immutable candidateの40桁commit SHA、candidate版要件書SHA-256、完全一致するproduction environment ID、reviewedAt、actor、approver、テーマZIP/source manifest/SHA256SUMSのSHA-256が `config/release-status.json.release` に揃い、artifact/checksum/source rootのpathは固定policyと一致している。
- [ ] 現在HEADはcandidateより後のrelease-attestation commitで、candidateはその祖先である。worktreeがcleanで、candidateからHEADまでの変更は `config/release-status.json` と `docs/evidence/records/**` だけであり、前者が実際に変更されている。
- [ ] `release.evidenceIds` が `yukinohana42/minhos-member-system` の `.github/workflows/ci.yml`、job/check `verify`、candidate SHA、`conclusion: success` のGitHub Actions実行とcanonical artifact名を参照している。同一runから取得したZIPと `SHA256SUMS.txt`、read-only APIから作成したマスク済みrun snapshotがすべてdigest一致している。

## No-Go条件

秘密値の検出、対象外Account/Price、本番／test混入、Stripe回収設定未確認、Ghostアクセス不一致、外部URL誤公開、権利・法務未承認、復元不能、未試験MUST、OC契約違反、P1/P2未解決、担当者・承認者不在のいずれかがある場合はNo-Goです。P1/P2の`ACCEPTED`はNo-Goのままで、`RESOLVED`と解消証跡が必要です。

次の証跡もNo-Goです。

- `evidenceIds` が未登録IDを参照する、subject/resultが参照元レコードと一致しない、登録簿に未参照証跡がある。
- `repository-file` が `docs/evidence/records/` に存在しない、または `sourceDigest` と実ファイルSHA-256が一致しない。
- 証跡がcandidate commit、candidate版要件書SHA-256、production environment IDと一致しない。
- `executedAt`または`reviewedAt`が未来、証跡がレビュー後、または設定上限の168時間を超えて古い。
- `CI=true`、ローカル実行結果、別repository/workflow/job/check、失敗・取消済みCIを正規CI証跡の代わりにしている。
- candidateが現在HEADの祖先でない、candidateとHEADが同一、worktreeがdirty、またはattestation差分にallowlist外の製品コード・設定・文書がある。
- ZIPがcandidate追跡済みテーマ入力とbyte一致しない、別run/別commitの古いZIPである、`SHA256SUMS.txt` が欠損・改変・別ZIPを指す、またはCI snapshotの実digest/fieldが登録値と一致しない。

## 判定手順

1. 製品コード、要件書、policy、Runbookを含むrelease内容を完成させる。`config/harness-policy.json.releaseGate.targetEnvironmentId` には責任者承認済みの非秘密な本番環境IDを完全一致で設定する。
2. `npm ci`、`npm run install:packages`、`npm run verify:all`、オンラインの `npm run audit:packages` を実行する。合格後、全release内容をcommitし、cleanなimmutable candidate SHAを確定してpushする。この時点以降、allowlist外のファイルは変更しない。
3. candidate SHA上のcanonical GitHub Actions `verify` を完了させる。`gh api` などread-only APIでrepository、workflow、job/check、run ID/attempt、conclusion、head SHAを確認する。API応答は秘密・不要な識別子を除いたschema 1.0 JSONへ正規化し、後で `docs/evidence/records/ci-run-<runId>.json` に保存する。
4. その同じrunのartifact `minhos-ghost-theme-<candidate SHA>` を一時ディレクトリへdownloadし、含まれるZIPと `SHA256SUMS.txt` を `packages/ghost-theme/dist/` へ配置する。checksumを先に検証し、ZIPをローカルsourceから再buildして置き換えない。
5. candidate版要件書、downloadしたZIP、candidate theme source manifest、実 `SHA256SUMS.txt`、各 `docs/evidence/records/` ファイルのSHA-256を取得する。証跡本文には秘密情報・個人情報・保護URLを残さない。
6. `config/release-status.json` のrelease、AT、DEC、OC、blockerを更新し、各 `evidenceIds` とトップレベル `evidenceRegistry` を対応させる。全証跡の `commitSha` はcandidate SHAに固定する。canonical blockerのID、severity、owner、descriptionは変更しない。
7. CI evidenceへ同じrunのrun ID/attempt/conclusion/head SHA、artifact name/path/digest、source manifest digest、SHA256SUMS path/digest、snapshot path/digestを登録する。reviewedAt、actor、approverを確定する。
8. 変更が `config/release-status.json` と `docs/evidence/records/**` だけであることを確認してrelease-attestation commitを作成する。現在HEADがcandidateより後で、candidateが祖先、worktreeがclean、`git diff --name-only <candidate SHA> HEAD` がこのallowlist内だけであることを再確認する。
9. 本番リリース責任者が `npm run release:gate` を明示実行する。`RELEASE_GATE GO`、全件数、`BLOCKERS 0 UNRESOLVED P1/P2`、終了コード0をすべて確認する。

ゲートは外部接続を行わず、既定の `config/release-status.json` と固定policy/traceだけを読みます。代替statusやfixtureをCLI引数で渡すことはできません。テスト用のGoケースはexport済み純粋評価器へ隔離した入力を渡し、本番CLIの入力境界を変更しません。

## 記録テンプレート

```text
release_id:
scope:
candidate_commit_sha:
release_attestation_head_sha:
requirements_version:
requirements_sha256:
production_environment_id:
ci_run_id_attempt:
ci_artifact_name:
artifact_path:
artifact_sha256:
artifact_source_manifest_sha256:
artifact_checksums_path:
artifact_checksums_sha256:
ci_snapshot_path_sha256:
reviewed_at_utc:
actor:
automated_checks:
manual_acceptance_ids:
operational_check_summary:
open_p1_p2:
external_gate_status:
backup_evidence:
rollback_owner:
approver:
decision: GO | NO-GO
notes:
```

実カード決済、返金、即時解約、本番DNSは運営責任者本人が最終確認し、実値・カード情報を証跡へ保存しません。
