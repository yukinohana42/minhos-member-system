# 秘密情報とローテーション Runbook

## 扱うのは名前と場所だけ

リポジトリには秘密の値を記録しません。次のインベントリを、値なしでシステム責任者が管理します。

| 名前 | 用途 | 保管場所 | アクセス者 | 失効・再発行 |
|---|---|---|---|---|
| Ghost Admin API key | 書込み可能なAdmin鍵を、同期コードのGET用途だけに限定して使用 | Standalone Apps Script Properties等 | システム責任者 | Ghost Custom Integrationで失効・再発行し、監査ログを確認 |
| Stripe restricted key | read-only照合 | Standalone Apps Script Properties等 | システム責任者 | Stripe Dashboardで失効・再発行 |
| Google Script authorization | Sheets/Form/Drive操作 | Google Workspaceの承認 | 組織所有アカウント | 所有者変更・再認可 |
| DNS管理資格情報 | ドメイン・送信認証 | DNS事業者の保護保管 | システム責任者 | 事業者手順 |

実値、2FAコード、OAuth refresh token、サービスアカウントJSON、カード番号はこの表・Git・Sheet・ログ・チャットへ記録しません。

## 初回登録

1. Gate 0/1で所有者と最小権限を確定する。
2. システム責任者本人が各サービスで鍵を作成し、保護された設定へ入力する。
3. Codexへ値を渡さず、鍵名・登録日時・権限・環境（test/live）のみを証跡化する。
4. `npm run check:secrets` を実行し、リポジトリに値がないことを確認する。
5. GET-onlyに実装した同期処理で疎通し、401/403を含む失敗時に停止・通知できることを確認する。Ghost鍵そのものはread-onlyへスコープできないため、Script編集者の制限、失効手順、監査で補完する。

## 定期ローテーション

- 年1回および担当交代時、鍵の利用者、Script所有者、トリガー再認可、バックアップ権限を棚卸しする。
- 新鍵をtestで確認してから、短い切替窓で旧鍵を失効する。切替時刻と結果だけをSyncLog/OpsLogへ残す。
- 失効後に同期が復旧しない場合、旧鍵を安易に再利用せず、権限・Account・環境・Script Propertiesを確認して再発行する。
- test/liveの鍵とAccountを混在させない。`livemode`、Account ID、Product/Price allowlistを同期開始時に検証する。

## 漏えい疑い

1. 影響範囲・発見経路・時刻を記録する（秘密値は記録しない）。
2. 該当鍵を直ちに失効し、関連Session・Webhook・OAuth許可を確認する。
3. 新鍵を最小権限で再発行し、Script Propertiesへ本人操作で登録する。
4. Git履歴、ログ、Sheet、テーマ、CIログ、チャットへの伝播を調査し、必要な削除・アクセス棚卸しを行う。
5. 影響する外部URLや個人データがあれば、リンク停止・通知・法務判断を実施する。
6. 同期を手動で一度実行し、Ghost/Stripe/Sheetの状態、通知抑制、復旧時刻を確認する。

## 受入

AT-28（秘密情報・権限）とSEC-03〜SEC-08を、値を開示しない証跡で合格させます。CIのsecret scanを「鍵が存在しない」証明に過大解釈せず、サービス側の権限・監査ログも責任者が確認します。
