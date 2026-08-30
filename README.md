# みんほす会員管理・コンテンツ配信システム

Ghost(Pro) を会員サイト兼CMS、Stripe を課金の正本、Google Sheets を運用ミラーとして使う MVP の実装リポジトリです。要件の正本は [`docs/minhos-membership-requirements-v1.1.md`](docs/minhos-membership-requirements-v1.1.md) です。

## 現在地

MVPのローカル実装、変更禁止再監査、GitHub Actions、main保護まで完了しています。Ghost、Stripe、Google Workspace、YouTube、Dropbox、DNSへの実接続や本番変更はまだ実行していません。責任者が第20章の決定事項、外部URL再共有リスク、回収設定、法務・権利、保存期間を確定してからtest mode接続へ進みます。

## 設計の要点

- Ghost がログイン・閲覧権限・記事の正本、Stripe が契約・請求・返金・Dispute の正本です。
- Google Sheets は Ghost/Stripe の一方向ミラーであり、アクセス権限や課金状態を逆反映しません。
- `minhos_member_id`、`lecture_id`、`subscription_row_key`、`grant_key` を外部IDから独立した境界として維持します。
- 非会員へ外部URLを含むHTML、OGP、メール、検索データを返しません。ただし、有料会員が取得したYouTube/Dropbox URLの再共有はMVPで防止しない既知制約です。
- APIキー、Webhook secret、OAuth token、カード情報、2FAコード、個人情報の不要な複製をGitへ置きません。

## ディレクトリ

| パス | 役割 |
|---|---|
| `packages/` | アプリ・テーマ等の実装（別担当の変更範囲。ハーネスでは触らない） |
| `config/` | 要件トレース、Sheets/Form、外部接続、ハーネスポリシーの非秘密設定 |
| `scripts/` | Node.js組み込み機能だけで動く検証・進捗ハーネス |
| `docs/engineering/` | コンテキスト、ループ、設計・トレース、接続準備 |
| `docs/runbooks/` | 日常運用、接続ゲート、秘密情報、同期、バックアップ、リリース手順 |
| `.github/` | CI、PRテンプレート、Issueテンプレート |

## ローカル検証

Node.js 22.22.3（`.nvmrc`）を使います。ルートのハーネスはNode.js組み込みモジュールだけで動きますが、実装パッケージ（Ghostテーマのgscan、Apps ScriptのTypeScript/Vitest/esbuild等）は各パッケージのlockfileで固定した開発依存を使います。依存を追加・更新する場合は目的、ライセンス、脆弱性確認を差分へ記録してください。

```powershell
npm ci
npm run install:packages
npm run check
npm test
```

個別実行:

```powershell
npm run check:secrets
npm run check:requirements
npm run check:config
npm run check:packages
npm run verify:all
npm run audit:packages
npm run release:gate  # 本番状態は未受入の間、意図どおりNO_GO
npm run progress -- --status "次の検証" --note "確認内容" --next "次の一手"
```

`npm run check` は高速なルートハーネス検査、`npm run verify`（`verify:all`の別名）はルートハーネスと両パッケージを含む完全検証です。これらはSaaSログインや実決済を実行しません（依存の初回取得だけは `npm run install:packages` がレジストリへアクセスします）。`npm run verify:all` は設定・秘密情報・要件、Ghost互換性・公開URL漏えい・テーマtest・決定的ZIP build、Apps Scriptの型・test・buildをまとめて検査します。`npm run audit:packages` はレジストリへ接続し、未承認のhigh/critical脆弱性、期限切れまたは不要になった例外を失敗にする公開前/CIゲートです。外部サービスの疎通は、承認済みの検証環境で [`docs/runbooks/external-connection-gates.md`](docs/runbooks/external-connection-gates.md) に従って手動実施します。

## 開発ループ

Goal → Context → Plan → Implement → Verify → Review → Checkpoint の短いループを使います。テンプレートと停止条件は [`AGENTS.md`](AGENTS.md)、詳細は [`docs/engineering/loop-engineering.md`](docs/engineering/loop-engineering.md) を参照してください。進捗の一行記録は [`docs/engineering/progress-log.md`](docs/engineering/progress-log.md) に残します。

## 重要な設計資料

- [次回再開ハンドオフ](docs/engineering/resume-handoff.md)
- [コンテキストパック](docs/engineering/context-pack.md)
- [要件トレーサビリティ](docs/engineering/requirements-traceability.md)
- [Codex使用量最適化](docs/engineering/codex-usage-budget.md)
- [Sheetsスキーマ](docs/engineering/sheets-schema.md)
- [Google Formブループリント](docs/engineering/google-form-blueprint.md)
- [外部接続準備チェックリスト](docs/engineering/external-connection-readiness.md)
- [Ghost Admin初期設定Runbook](docs/runbooks/ghost-admin-setup.md)
- [責任者向け1ページ接続引継ぎ票](docs/runbooks/connection-handoff.md)
- [GitHub初期公開・保護Runbook](docs/runbooks/github-controls.md)
- [Runbook索引](docs/runbooks/README.md)
- [レクチャー投稿テンプレート](docs/templates/lecture-post-template.md)
- [受入証跡テンプレート](docs/evidence/acceptance-record-template.md)

## 外部接続の境界

Ghost／Stripe／Google Workspace の接続は、準備文書の必須項目が埋まり、秘密情報の保管場所と最小権限が責任者により確認されるまで保留します。Ghost Custom Integration と Stripe restricted key の初回作成・入力は責任者本人が行い、Codex は入力箇所、設定名、read-only疎通と検証ログを支援します。

## 受入とリリース

要件書の AT-01〜AT-45 を対象に、MUST要件に証跡を紐づけます。ローカルで確認できない第三者SaaSの受入は「未実施」と記録し、運用で対応済みとは扱いません。P1/P2未解決、またはDEC-01〜DEC-21のローンチ必須項目未確定のまま本番公開しません。
