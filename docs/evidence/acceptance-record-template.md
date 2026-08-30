# みんほす受入記録

## 実施情報

| 項目 | 記録 |
|---|---|
| release_id | |
| candidate commit SHA（40桁） | |
| release-attestation HEAD SHA（40桁、実行時確認） | |
| requirements_version | MH-MEMBER-REQ-001 v1.1 |
| requirements SHA-256 | |
| environment | production |
| production environment ID（非秘密な完全一致値） | |
| canonical CI artifact name | `minhos-ghost-theme-<candidate commit SHA>` |
| artifact path | `packages/ghost-theme/dist/minhos-membership-1.0.0.zip` |
| artifact SHA-256 | |
| candidate theme source manifest SHA-256 | |
| SHA256SUMS path | `packages/ghost-theme/dist/SHA256SUMS.txt` |
| SHA256SUMS SHA-256 | |
| Stripe mode/account末尾のみ | |
| actor / approver | |
| release reviewedAt（UTC） | |
| 開始 / 終了（UTC） | |
| 証跡の保管場所 / 期限 | |

`candidate commit SHA`、candidate版要件書SHA-256、environment IDは `config/release-status.json.release` と全証跡登録で同じ値を使います。artifact path/digest、source manifest digest、SHA256SUMS digestはrelease登録とcanonical CI証跡で一致させ、各canonical pathは `config/harness-policy.json.releaseGate` に固定します。canonical CIもcandidate commit上で実行します。その後は `config/release-status.json` と `docs/evidence/records/**` だけを変更してrelease-attestation commitを作り、cleanな現在HEADからcandidateまでの差分に他経路がないことを確認します。`reviewedAt` と証跡の `executedAt` は未来時刻にせず、証跡はレビュー以前かつ168時間以内に実施します。

## 証跡登録

AT、DEC、OC、blockerの各行には証跡本文ではなく、この登録の `id` だけを `evidenceIds` へ記録します。Git管理する証跡は `docs/evidence/records/` 配下へ保存し、ファイルの実SHA-256を `sourceDigest` に設定します。

```json
{
  "id": "EV-AT-01-YYYYMMDD-01",
  "subjectType": "acceptance-test",
  "subjectId": "AT-01",
  "kind": "manual-test",
  "result": "PASS",
  "environment": "production",
  "environmentId": "<exact production environment ID>",
  "commitSha": "<candidate 40-character commit SHA>",
  "requirementsSha256": "<requirements document SHA-256>",
  "executedAt": "YYYY-MM-DDThh:mm:ssZ",
  "actor": "<non-secret actor ID>",
  "approver": "<non-secret approver ID>",
  "sourceType": "repository-file",
  "sourceRef": "docs/evidence/records/<record-file>",
  "sourceDigest": "<record-file SHA-256>"
}
```

`subjectType` は `release / acceptance-test / decision / operational-check / blocker` のいずれかです。`external-record` を使う場合は安定したURIと保管物のSHA-256を記録します。GitHub Actions証跡ではread-only API結果とartifact照合結果をマスク済みschema 1.0 JSONとして `docs/evidence/records/` に保持し、`sourceSnapshotRef` で参照します。追加必須フィールドは [README](README.md) を参照してください。

## 自動検証

| コマンド | 結果 | 実行日時 | ログ/CI |
|---|---|---|---|
| `npm ci` | NOT_RUN | | |
| `npm run install:packages` | NOT_RUN | | |
| `npm run verify:all` | NOT_RUN | | |
| `npm run audit:packages` | NOT_RUN | | |

## AT記録

各行の状態は `PASS / FAIL / NOT_RUN / BLOCKED_EXTERNAL_GATE / NOT_APPLICABLE` のいずれかにします。`NOT_APPLICABLE` は理由と承認者が必須ですが、本番ゲートではPASSの代わりになりません。

| AT | 状態 | 実測・期待との差 | 証跡 | issue / owner / due |
|---|---|---|---|---|
| AT-01 | NOT_RUN | | | |
| AT-02 | NOT_RUN | | | |
| AT-03 | NOT_RUN | | | |
| AT-04 | NOT_RUN | | | |
| AT-05 | NOT_RUN | | | |
| AT-06 | NOT_RUN | | | |
| AT-07 | NOT_RUN | | | |
| AT-08 | NOT_RUN | | | |
| AT-09 | NOT_RUN | | | |
| AT-10 | NOT_RUN | | | |
| AT-11 | NOT_RUN | | | |
| AT-12 | NOT_RUN | | | |
| AT-13 | NOT_RUN | | | |
| AT-14 | NOT_RUN | | | |
| AT-15 | NOT_RUN | | | |
| AT-16 | NOT_RUN | | | |
| AT-17 | NOT_RUN | | | |
| AT-18 | NOT_RUN | | | |
| AT-19 | NOT_RUN | | | |
| AT-20 | NOT_RUN | | | |
| AT-21 | NOT_RUN | | | |
| AT-22 | NOT_RUN | | | |
| AT-23 | NOT_RUN | | | |
| AT-24 | NOT_RUN | | | |
| AT-25 | NOT_RUN | | | |
| AT-26 | NOT_RUN | | | |
| AT-27 | NOT_RUN | | | |
| AT-28 | NOT_RUN | | | |
| AT-29 | NOT_RUN | | | |
| AT-30 | NOT_RUN | | | |
| AT-31 | NOT_RUN | | | |
| AT-32 | NOT_RUN | | | |
| AT-33 | NOT_RUN | | | |
| AT-34 | NOT_RUN | | | |
| AT-35 | NOT_RUN | | | |
| AT-36 | NOT_RUN | | | |
| AT-37 | NOT_RUN | | | |
| AT-38 | NOT_RUN | | | |
| AT-39 | NOT_RUN | | | |
| AT-40 | NOT_RUN | | | |
| AT-41 | NOT_RUN | | | |
| AT-42 | NOT_RUN | | | |
| AT-43 | NOT_RUN | | | |
| AT-44 | NOT_RUN | | | |
| AT-45 | NOT_RUN | | | |

失敗はP1/P2/P3、再現手順、影響、暫定措置、恒久対応、再試験結果を記録します。

## OC記録

対象集合、owner、分類は `config/requirements-trace.json#operationalChecks` を正本とし、全65件を `config/release-status.json.operationalChecks` へ転記します。

| 分類 | Go候補の状態 | 証跡 |
|---|---|---|
| `production-required` | `PASS` | 構造化証跡必須 |
| `mvp-advisory` | `PASS` または `DEFERRED` | どちらも構造化証跡必須 |
| `future/non-mvp` | `NOT_APPLICABLE` | `kind: scope-approval` の構造化証跡必須 |

## Go / No-Go

- 未解決P1/P2:
- 未確定DEC:
- 未完了OC:
- URL再共有リスク承認（AT-29/30）:
- Backup / rollback:
- 判断: `GO / NO-GO`
- 判断理由:
- actor / approver / reviewedAt:
