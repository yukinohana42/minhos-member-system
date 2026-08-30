## 変更の目的

<!-- Goal、関連要件ID、変更しない範囲を短く記載してください。 -->

## 要件・証跡

- 要件ID:
- 受入テストID:
- 証跡の場所:

## チェックリスト

- [ ] `packages/**` の変更は割り当てと合意がある
- [ ] `npm run verify:all` を実行した（または未実施理由を記載した）
- [ ] `npm run check:secrets` に検出がない
- [ ] API鍵、Webhook secret、OAuth token、カード情報、2FAコードを追加していない
- [ ] Ghost／Stripe／Google Workspace等の本番書込みを実行していない、または承認記録がある
- [ ] Sheetの正本・所有列・tombstone・Form照合ルールを壊していない
- [ ] 外部URL、個人情報、権利・法務、復元・rollbackへの影響を確認した
- [ ] 未決事項と次の安全な操作を `docs/engineering/progress-log.md` に記録した
