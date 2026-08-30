# バックアップと復元 Runbook

## 目的と保持

再生成できない手動正本を含む運用Sheetを、権限制限した別Driveフォルダへ日次複製し、35世代保持します。月1回と大きな設定変更前にフルスナップショットを取得し、四半期に一度、別ファイルへ復元できることを確認します。保存期間・削除は法務・税務承認に従います。

## 取得物

### Google Workspace

- `30_Profile_RAW`、`40_Supplemental`、`50_Exceptions`、`60_ContentRegistry`、`80_OpsLog`、`99_Config` を含む運用Sheet。
- Apps Scriptコード、`appsscript.json`、トリガー一覧、Script Propertiesの**名前と設定手順のみ**（値はバックアップしない）。
- Form構造と回答保存先の設定。回答原本の保存期間は承認済み方針に従う。

### Ghost

- コンテンツJSON、会員CSV、テーマZIP、`routes.yaml`、`redirects.yaml`、資産一覧。
- Exportだけで画像等を含む完全復旧を保証しない。解約・終了前は必要に応じてGhost Supportへ完全Exportを依頼する。

### Stripe / 外部メディア

- StripeはDashboard/APIから再照合できる外部正本であり、カード情報は取得・保存しない。
- ContentRegistryのlecture ID、動画ID、PDFパス、版、権利・期限、リンク確認日時を保管する。動画・PDF本体はYouTube/Dropboxの正本に従う。

## 復元手順

1. インシデントID、承認者、復元対象時刻、影響範囲をOpsLogへ記録する。
2. 新しい別ファイル／検証サイトへバックアップを復元し、元ファイルを上書きしない。
3. タブ名、列順、schema version、保護範囲、タイムゾーンを確認する。
4. Ghost/Stripeからミラーを再構築し、手動正本（Supplemental、Exceptions、ContentRegistry、OpsLog）を35日以内のバックアップから復元する。
5. `minhos_member_id`、`lecture_id`、Subscription key、grant keyの対応を照合する。
6. `npm run check` と必要なAT-20〜28、AT-40、AT-42〜43を実施する。
7. 責任者が復元結果・不足範囲・再開時刻を承認してから運用へ戻す。

## 復元できないもの

通常のGhost exportだけでの完全な画像復元、Stripeカード情報、失効済み外部リンクの元権限、法定保存対象の削除済み記録は保証しません。不足範囲をNo-Go／既知制約として記録し、必要なら各サービスの公式復旧窓口へ連絡します。
