# コンテンツ公開 Runbook

## 公開前

- [ ] `lecture_id`、タイトル、開催日（Ghost `published_at`）、必須の内部タグ `#lecture`、講師・テーマ・年タグ、概要、公開確認者・日付を準備した。
- [ ] 講師タグは表示名を実際の講師名、スラッグを `speaker-<stable-slug>` とし、Ghost投稿者アカウントを講師名として扱っていない。
- [ ] 動画・PDFの権利、患者・家族・会員・施設等の個人情報、機密情報、ファイル名、説明欄を確認した。不備はP1で外部リンクを先に停止する。
- [ ] YouTubeは限定公開、運営プレイリストは非公開、公開プレイリストへ未登録、字幕と説明欄を確認した。
- [ ] Dropboxの所定フォルダ、PDF版、共有権限、期限、失効担当を確認した。

## Ghost登録

1. `60_ContentRegistry`へ動画・PDF・権利・版・期限・確認日を記録する。
2. [`docs/templates/lecture-post-template.md`](../templates/lecture-post-template.md) を使い、概要に外部URLを入れず、本文にだけ個別YouTube URLとDropboxリンクを配置する。
3. `#lecture`、`speaker-*`、`topic-*`、`year-*` が揃っていることを再確認し、公開範囲を `paid-members only`、公開方法をWebサイトのみとする。本文をニュースレターへ配信しない。
4. 未ログイン、free、失効、有料の各状態でプレビューする。非有料HTML、Content API、RSS、OGP、検索面、メールに外部URLがないことを確認する。ActivityPubが有効なら公開アクティビティと連合先からも生URLが出ないことを確認し、無効なら無効状態を証跡化する。
5. 動画・PDFの欠損時も講義名、静的代替案内、再試行、問い合わせ導線が残ることを確認する。
6. 公開後にContentRegistryへGhost post ID、slug、公開日時、実リンク確認日時を追記する。

## 差し替え・停止

PDF差し替えは版番号を上げ、RegistryとGhost本文を同じループで更新します。漏えい・権利問題は [リンク漏えい・誤公開](incident-link-leak.md) の停止順を使い、外部URLを先に無効化します。
