# Security policy

## 報告方法

API鍵、個人情報、カード情報、会員向け外部URLを公開Issueへ投稿しないでください。[GitHub Private vulnerability reporting](https://github.com/yukinohana42/minhos-member-system/security/advisories/new) を使い、発見日時、影響する環境、再現の最小情報だけを非公開で共有します。この導線を利用できない場合は、公開Issueへ詳細を書かず、リポジトリ所有者へ非公開連絡手段だけを問い合わせてください。秘密値そのものは送らず、必要な場合は先に失効・再発行します。

## 対応順

1. Ghost Admin API key、Stripe restricted key、Google認可等の漏えい疑いは、対象資格情報を失効してから影響を確認する。
2. YouTube/Dropbox URLまたは権利・個人情報の問題は、外部リンクを先に停止する。
3. 本番/test混在、意図しない課金継続、open Dispute、Ghost会員欠落はP1として当日確認する。
4. 修正後に `npm run verify:all` と `npm run audit:packages` を実行し、再発防止テストとローテーション記録を残す。

## 依存監査の例外

未承認のhigh/critical脆弱性は公開を停止します。修正版が存在しない開発専用依存だけは、到達不能化した実行経路、成果物からの除外、責任者、短い再確認期限を `config/dependency-audit-policy.json` に固定できます。監査スクリプトは対象package、GHSA、依存経路、期限を完全一致で検証し、期限切れまたは脆弱性解消後に残った例外も失敗にします。

詳細は [秘密情報Runbook](docs/runbooks/secrets-and-rotation.md) と [リンク漏えいRunbook](docs/runbooks/incident-link-leak.md) を参照してください。
