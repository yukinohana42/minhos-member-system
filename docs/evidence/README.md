# リリース・受入証跡

このディレクトリはAT-01〜AT-45、DEC-01〜DEC-21、`config/requirements-trace.json#operationalChecks`、blocker解消の証跡テンプレートを管理します。実アカウントID、会員メール、カード情報、API鍵、2FAコード、YouTube/Dropboxの生URL、保護本文はGitへ保存しません。

## 記録原則

- 1回の受入セッションにつき [`acceptance-record-template.md`](acceptance-record-template.md) を複製します。Git管理できるマスク済み記録は `docs/evidence/records/` 配下へ置きます。
- `config/release-status.json` の各AT、DEC、OC、blockerは証跡本文を埋め込まず、`evidenceIds` でトップレベル `evidenceRegistry` を参照します。リリース自体のCI証跡も `release.evidenceIds` から参照します。
- 登録簿の全証跡に `id`、`subjectType`、`subjectId`、`kind`、`result`、`environment`、`environmentId`、`commitSha`、`requirementsSha256`、`executedAt`、`actor`、`approver`、`sourceType`、`sourceRef`、`sourceDigest` を記録します。
- `repository-file` は `docs/evidence/records/` 配下だけを許可します。`sourceDigest` はそのファイルのSHA-256と一致しなければなりません。スクリーンショット等をGit外へ置く場合は個人情報と外部IDをマスクし、安定したURIと保管物のSHA-256を `external-record` として記録します。
- 証跡、リリースレビュー、candidate commit、candidate版要件書、production environment IDは同一リリースへ結び付けます。未来時刻、レビュー後の実施時刻、168時間を超えた古い証跡はNo-Goです。
- 実施していない項目を推定で合格にしません。ATは`PASS`、DECは`DECIDED`、P1/P2 blockerは`RESOLVED`だけがGo候補です。`ACCEPTED`はP1/P2の解消になりません。
- OCはトレースの全65件を記録します。`production-required`は`PASS`、`mvp-advisory`は証跡付き`PASS`または`DEFERRED`、`future/non-mvp`は`scope-approval`証跡付き`NOT_APPLICABLE`だけがGo候補です。

## Candidateとattestation commit

製品コード、設定、要件書、Runbookを確定したcommitをcandidateとします。canonical CIと全証跡の `commitSha` はこのcandidateを指します。CI完了後は、`config/release-status.json` と `docs/evidence/records/**` だけを変更したrelease-attestation commitを作成します。ゲートはcleanな現在HEADについてcandidateが祖先であることを確認し、candidateからHEADまでにこの2経路以外の差分が1件でもあればNo-Goにします。

テーマZIPは現在ディレクトリに存在するだけでは証跡になりません。同じcandidate SHAのcanonical CI artifact `minhos-ghost-theme-<candidate SHA>` からZIPと `SHA256SUMS.txt` を一緒に取得します。ゲートはZIP内の全ファイルをcandidate commitの追跡済みテーマ入力とbyte単位で照合し、checksumファイルの実体が `sha256sum` の厳密な1行（LF終端）でZIPを指すことを確認してから、candidate source manifest SHA-256、ZIP SHA-256、`SHA256SUMS.txt` SHA-256を同時に拘束します。現在sourceからの再buildや、別run・別commitの古いZIPでは代替できません。

source manifestは、candidate treeのテーマ配布対象をpath昇順に並べ、各行を `<ZIP内相対path><NUL><ファイルbyte列のSHA-256><LF>` としたUTF-8 byte列全体のSHA-256です。アルゴリズム識別子はpolicyの `sha256(path-nul-content-sha256-lf)-v1` に固定します。

## GitHub Actions証跡

リリースには次の固定CIを指す成功証跡が必須です。単なる`CI=true`、ローカルログ、任意URLでは代替できません。

```json
{
  "sourceType": "github-actions",
  "repository": "yukinohana42/minhos-member-system",
  "workflow": ".github/workflows/ci.yml",
  "job": "verify",
  "check": "verify",
  "runId": "1234567890",
  "runAttempt": 1,
  "conclusion": "success",
  "headSha": "<candidate 40-character commit SHA>",
  "artifactName": "minhos-ghost-theme-<candidate 40-character commit SHA>",
  "artifactPath": "packages/ghost-theme/dist/minhos-membership-1.0.0.zip",
  "artifactSha256": "<candidate CI artifact SHA-256>",
  "artifactSourceSha256": "<candidate tracked theme source manifest SHA-256>",
  "artifactChecksumsPath": "packages/ghost-theme/dist/SHA256SUMS.txt",
  "artifactChecksumsSha256": "<SHA-256 of canonical SHA256SUMS.txt content>",
  "sourceRef": "https://github.com/yukinohana42/minhos-member-system/actions/runs/1234567890",
  "sourceSnapshotRef": "docs/evidence/records/ci-run-1234567890.json",
  "sourceDigest": "<SHA-256 of the retained, non-secret CI evidence export>"
}
```

`sourceSnapshotRef` のJSONは `schemaVersion: "1.0"` と、上記の `sourceRef`、repository/workflow/job/check、runId/runAttempt/conclusion/headSha、artifactName/path/SHA-256、source manifest SHA-256、SHA256SUMS path/SHA-256を同値で持たせます。ゲートはsnapshotの実ファイルdigestと各fieldを再検証します。snapshotは `gh api` のread-only結果と同一runからdownloadしたartifactを照合して作成し、API応答中のactor ID等は必要最小限だけ残します。

証跡の最終保管先と保存期間はDEC-12確定後に更新します。それまでは `config/release-status.json` の本番識別子と全証跡を空のまま保持し、No-Goとします。
