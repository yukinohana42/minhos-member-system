# 要件トレーサビリティ

要件書のMUST/SHOULD/FUTURE IDと受入テストは、`config/requirements-trace.json` を正本として機械的に確認します。`groups` は領域別の概要、`requirementMappings` は各要件IDに対して一つだけ存在する明示的な `acceptanceIds`・`operationalCheckIds`・担当・証跡の対応です。グループの受入テスト集合だけでは要件の対応済みとは扱いません。

## 機械検査

`npm run check:requirements` は次を検査します。

- 要件書第9章と第14.1節から抽出した `PUB-*`、`AUTH-*`、`PAY-*`、`CNT-*`、`PROF-*`、`SYNC-*`、`OPS-*`、`SUP-*`、`SEC-*` の全要件が、`requirementMappings` にちょうど一つだけ存在する。
- 各要件マッピングが直接の受入IDまたは要件固有の運用検査IDで覆われる。65件の運用検査は1要件だけを参照し、MUST 57件は`production-required`、SHOULD 6件は`mvp-advisory`、FUTURE 2件は`future/non-mvp`とする。
- 要件書のAT-01〜AT-45が設定に列挙され、設定外の受入IDがない。
- 要件行とAT行から本文も抽出し、空または意味を持たない短さの本文を拒否する。
- 第7章の5段階が `uxStages` に一つずつ対応し、段階名、受入ID、担当、証跡が明示される。段階固有でない20件は`crossCuttingAcceptanceIds`へ分離し、両者の和集合がAT-01〜AT-45と一致する。
- 人間が監査した要件本文、AT本文、全マッピング、全運用検査、UX、横断AT、不変条件を正規化したsemantic contract SHA-256が、チェッカー内の固定値と一致する。設定ファイル内の自己申告digestは承認根拠にしない。
- 必須成果物は `config/harness-policy.json` の `verification.requiredArtifacts` だけを正本として存在確認する。ここにはリリース状態とリリースゲートも含める。

## Semantic contractの更新手順

要件本文、AT本文、要件とAT/OCの対応、OCの検査内容・責任者・頻度・適用区分・証跡種別、UX分類、不変条件のいずれかを変える場合は、次の順序で更新します。

1. プロダクト責任者と実装責任者が、変更後の意味対応を要件単位でレビューする。文字数を増やしただけのOCや、隣接機能のATへの付替えは承認しない。
2. 次の読み取り専用コマンドで候補digestを算出する。

```powershell
node --input-type=module -e "import { readFile } from 'node:fs/promises'; import { computeRequirementsSemanticContractDigest } from './scripts/check-requirements.mjs'; const [traceText, document] = await Promise.all([readFile('./config/requirements-trace.json', 'utf8'), readFile('./docs/minhos-membership-requirements-v1.1.md', 'utf8')]); console.log(computeRequirementsSemanticContractDigest(JSON.parse(traceText), document));"
```

3. レビュー済みのsemantic差分と同じ変更であることを確認し、`scripts/check-requirements.mjs`の`EXPECTED_SEMANTIC_CONTRACT_SHA256`を候補値へ明示的に更新する。コマンド出力だけでは承認にならない。
4. `npm run check`と`npm test`を実行し、偽AT付替え、無関係なOC長文化、AT本文弱化、不変条件削除のmutation testが引き続き失敗側を検出することを確認する。

固定digestはコード側にだけ置くため、`config/requirements-trace.json`や要件書を単独で書き換えて自己計算値を添えるだけでは検査を通過できません。

## 領域別の概要

| 要件領域 | 主なID | 主な受入 | 証跡 | 担当 |
|---|---|---|---|---|
| 公開案内 | `PUB-*` | AT-01〜05、AT-10 | 画面、URL、HTML検査 | テーマ担当 |
| 認証 | `AUTH-*` | AT-06〜09、AT-14、AT-41 | test mode、アクセス状態 | 実装担当 |
| 課金・契約 | `PAY-*` | AT-06〜08、AT-11〜14、AT-33、AT-35〜37 | Stripe/Ghost記録、OpsLog | システム責任者 |
| コンテンツ | `CNT-*` | AT-09、10、15〜19、41、42、45 | 公開チェック、実機、台帳 | コンテンツ担当 |
| プロフィール | `PROF-*` | AT-23、24、41 | Form fixture、照合、例外 | 会員管理担当 |
| 同期 | `SYNC-*` | AT-20〜28、31〜40 | 自動試験、SyncLog、例外 | 同期担当 |
| 運用 | `OPS-*` | AT-27、28、42〜45 | Runbook、復元、Dashboard | システム責任者 |
| 問い合わせ・法務 | `SUP-*` | AT-03、18、19、45 | 案内、メール、権利確認 | システム責任者 |
| セキュリティ | `SEC-*` | AT-01、04、05、25〜28、37〜40、43、44 | secret scan、権限、復元 | システム責任者 |

## UX 5段階の対応

`uxStages` には、要件書第7章と同じ順序で次の5段階を定義します。各行の詳細な受入ID、担当、証跡は設定を参照します。

| ID | 段階 | 代表的な受入 | 担当 |
|---|---|---|---|
| UX-01 | 認知・検討 | AT-01、AT-03、AT-04、AT-08、AT-10 | テーマ担当 |
| UX-02 | 申込・決済 | AT-06、AT-07、AT-08 | 実装担当 |
| UX-03 | 初回利用・オンボーディング | AT-06、AT-07、AT-09、AT-19、AT-24、AT-41 | 会員管理担当 |
| UX-04 | 継続閲覧・学習 | AT-04、AT-09、AT-15〜19、AT-31、AT-32、AT-41 | コンテンツ担当 |
| UX-05 | 契約管理・支払復旧・離脱・再入会 | AT-11〜14、AT-33〜36 | システム責任者 |

横断受入はAT-02、AT-05、AT-20〜23、AT-25〜30、AT-37〜40、AT-42〜45の20件です。

## リリース状態と本番ゲート

`config/release-status.json` は本番リリース判定専用の状態台帳です。AT-01〜AT-45は `PASS`、DEC-01〜DEC-21は `DECIDED`、P1/P2 blockerは証跡付き `RESOLVED` でなければなりません。P1/P2の単なるリスク受容はGoにしません。初期状態は外部接続・手動受入・決定事項が未完了のため、未確認を合格にせず `NOT_RUN`、`NOT_DECIDED`、`OPEN` のまま保持します。

```powershell
# 本番リリース責任者が明示的に実行する読み取り専用ゲート
npm run release:gate
```

ゲートは外部サービスへ接続せず、ファイルの状態だけを検査します。通常CIワークフローからは呼び出しませんが、どの環境で明示実行してもスキップせず同じ判定を返します。初期状態での実行結果は `RELEASE_GATE NO_GO` かつ終了コード非0です。

## 不変条件

1. Ghostがアクセス、Stripeが課金、Sheetsはミラーであり逆反映しない。
2. 外部URLは有料本文内だけに置く。取得後の再共有防止はMVPの責務外で、AT-29/30で責任者が受容する。
3. API走査が完走しない限り不在判定・tombstone化しない。完走しても自動削除しない。
4. 初回鍵作成・本番変更は責任者が承認し、秘密値はリポジトリに存在しない。

## 受入証跡の保存規則

- GhostのPortal、Tier、メール、送信ドメイン、テーマ所有ナビゲーションは、[Ghost Admin初期設定Runbook](../runbooks/ghost-admin-setup.md)の画面経路、状態別test、マスキング、rollbackに従う。実画面未取得の状態をPASSとしない。
- 自動検査: CIの実行URLまたはローカルコマンドと日時。
- test mode: 外部IDは必要最小限をマスキングして記録し、カード番号等は記録しない。
- 手動試験: 端末、ブラウザ、状態、期待結果、実結果、発見日時、担当者。
- 例外: `exception_key`、severity、first/last detected、通知、resolution、関連run。
- 本番ゲート: DEC項目の承認者、承認日、rollback、復元証跡、P1/P2一覧。

未実施のMUSTは「運用対応済み」とせず、`not-tested` として残します。
