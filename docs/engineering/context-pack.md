# 実装コンテキストパック

この文書は、各ループで必要な文脈を短く再利用するための正本です。要件書の全文を毎回貼り直さず、変更に関係する要件IDとこの文書の該当節だけをエージェントへ渡します。

## Goal

Ghost(Pro) の会員サイト、Stripe 課金、Google Sheets/Form 運用台帳を、MVP要件の範囲で安全に実装・検証できる状態にする。最初の実装では外部サービスへ本番接続せず、テーマ／同期処理／台帳設計／運用手順をテスト可能な境界で準備する。

## Canonical facts

| 項目 | 正本・方針 |
|---|---|
| 会員アクセス | Ghost。`paid-members only` と Portal が唯一の標準入口 |
| 課金 | Stripe。Customer、Subscription、Invoice、Refund、Dispute を管理 |
| 運用台帳 | Google Sheets。Ghost/Stripeからの一方向ミラー。アクセス制御・課金判断には使わない |
| プロフィール原本 | Google Forms の回答Sheet。照合後の補足は `40_Supplemental` |
| 動画 | YouTube 限定公開。運営プレイリストは非公開、会員へプレイリストを共有しない |
| PDF | 既存Dropboxの共有リンク。期限・版・権利をContentRegistryで管理 |
| 会員主キー | `minhos_member_id`（不変）。Ghost照合は `ghost_site_id + ghost_member_id` |
| 講義主キー | `lecture_id`（移行後も不変） |
| Stripe契約主キー | `stripe:{stripe_account_id}:{livemode}:{stripe_subscription_id}` |
| 無償付与主キー | `ghost:{ghost_site_id}:{ghost_member_id}:{tier_id}:{grant_kind}` |
| 時刻・金額 | 内部は UTC ISO 8601・通貨最小単位整数、表示は Asia/Tokyo・JPY |
| 既知制約 | 有料会員が取得したYouTube/Dropbox URLの再共有はMVPで防止しない |

## Non-goals（MVP外）

- Make/Zapier/n8nなどの有料ノーコード連携。
- Mux等の署名付き動画、会員別PDF URL、DRM、画面録画防止。
- 独自認証、SNSログイン、SSO、独自決済画面。
- Google SheetsからGhost/Stripeへの逆書き込み、全請求履歴の会計帳簿化。
- 実アカウントの契約・KYC・DNS・本番公開・実カード決済。

## Decision gates

ローンチ必須のDEC-01〜DEC-21は要件書第20章にあり、未確定のまま本番公開しません。特に次を先に確定します。

1. サイト名・ドメイン・Tier・価格・税表示。
2. 管理者、編集者、閲覧者、復旧担当と組織所有アカウント。
3. サポートメール、法務文書、個人情報の保存期間、講師許諾。
4. Stripeの再試行と最終 `cancel`、解約・返金・Dispute 方針。
5. YouTube/Dropbox URL再共有リスクの受容とリンク停止責任者。
6. Google Form項目、シート共有範囲、バックアップ先、保持期間。

## Risk boundaries

- 外部書き込み、破壊的操作、費用が発生する操作は責任者の明示承認を要求する。
- 秘密情報は値を扱わず、名前・保管場所・ローテーション手順だけを記録する。
- Ghost/Stripeの状態を単一の `active` だけで判定しない。`past_due`、`unpaid`、`paused`、`pause_collection`、open Invoice、複数契約を分離する。
- APIページング・429・5xx・途中停止時に不在判定しない。全件走査の完走時だけ tombstone 化し、自動削除しない。
- Formの未回答・不一致は課金・アクセスを変更しない。本人確認済みとみなさず、例外へ送る。

## Prompt handoff template

```text
Goal: <今回の成果物と完了条件>
Context: <この文書の該当節、要件ID、正本、既知制約>
Scope: <変更してよいパス>
Constraints: 明示された変更対象外（未割当の packages/** を含む）は変更しない。秘密値なし。外部書込みなし。
Plan: <最大5項目>
Evidence: <実行する検証と保存先>
Stop: 要件矛盾、秘密検出、破壊的操作、承認不足
```

## Context freshness

要件ID、本文、AT、OCなどの規範要件を更新したら、`config/requirements-trace.json`、この文書、`docs/engineering/requirements-traceability.md` の変更を同じループで行い、`npm run check` を通します。実装状態だけを更新する場合は、要件トレースを変えず、`resume-handoff.md`、`progress-log.md`、該当readiness文書を同じループで同期します。日付、APIバージョン、SaaS価格は推測で補完せず、公式資料と確認日を記録します。
