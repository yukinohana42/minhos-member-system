# みんほす会員ライブラリ Ghost テーマ

Ghost(Pro) Publisher 向けの MVP カスタムテーマです。要件定義書 `MH-MEMBER-REQ-001 v1.1` のうち、公開お知らせ、会員ライブラリ、Portal 導線、講義一覧、保護本文、レスポンシブ表示を担当します。

## セットアップ

1. Ghost Admin の **Settings > Design & branding > Change theme** へ、`npm run build` で生成した ZIP をアップロードします。`node_modules`、`scripts`、`tests`、秘密情報は ZIP に入りません。
2. テーマZIPとは別に、Ghost Admin の **Settings > Labs > Routes**（Ghostの現行画面でRoutesのdownload/upload欄）から既存の `routes.yaml` をダウンロードして安全な場所へバックアップし、このディレクトリの `routes.yaml` をアップロードします。ZIP内に同梱されていてもルーティングへ自動適用されません。適用後は `/`、`/updates/`、`/lectures/` と代表投稿URLを確認し、異常時は保存した旧ファイルを同じ画面から再アップロードして戻します。
3. Ghost の公開言語を日本語に設定し、必要なページを次のスラッグで作成します。
   - `about`, `membership`, `welcome`, `payment-result`, `faq`, `contact`, `terms`, `privacy`, `legal-commerce`
4. `welcome` ページとレクチャー投稿は、Ghost Admin で **Paid-members only** に設定します。テーマ側でも `visibility=paid` と `access` を検査するため、未認証の本文は返しません。
5. Ghost の Stripe 連携、Tier/Price、Portal、送信ドメインを運営責任者が確定します。料金・サポートメール・法務本文などの未決値はテーマへハードコードしていません。設定と証跡の詳細は [Ghost Admin 初期設定 Runbook](../../docs/runbooks/ghost-admin-setup.md) に従います。

## Ghost Admin 設定チェックリスト（要件書第18章・DEC-21）

次はMVPの設定候補です。実値は運営責任者がDEC-01、03、04、08、19、21の承認記録で確定し、有効契約のない検証環境で試してから本番へ反映します。

| 領域 | MVP設定候補 | 確認・証跡 |
|---|---|---|
| Tier / Price | 有料Tierは1つ、JPY月額を必須とし、年額はDEC-03で採用した場合だけ表示する。無料登録、trial、couponは無効。申込はGhostが発行する対象Tierリンクだけを使う | Tier名、税込表示、月額、年額有無、対象Product/Priceを責任者が確認し、AT-03、07、08をStripe test modeで実施する |
| Portal | 氏名欄、対象Tier/Price、規約notice、同意必須checkbox、組織所有サポートメールを設定する。登録・ログイン・アカウント管理はPortalだけを入口にする | 氏名空欄時の実挙動、magic link/one-time code、Checkout取消・成功復帰、free/失効/有料の導線をAT-02〜08、11〜14で確認する。法務文言は責任者が承認する |
| ヘッダーナビゲーション | MVPは `partials/site-header.hbs` のhard-codedリンクを正本とする。ブランドからトップ、`活動紹介`、`レクチャー`、`会員案内・料金`、`FAQ`、`講義を検索`を表示し、状態別CTAを`ログイン`、`会員になる`、`再入会`、`ライブラリを見る`、`アカウント`で出し分ける | Ghost Adminの **Settings > Site > Navigation** を変更しても本テーマには反映されない。未ログイン、free/失効、有料、モバイルでAT-01、02、04、05、08、14を確認する |
| フッターナビゲーション | MVPは `partials/site-footer.hbs` のhard-codedリンクを正本とし、`お問い合わせ`、`利用規約`、`プライバシー`、`特商法表示`、`運営者情報`を全状態へ表示する | Ghost Admin Navigationを設定根拠にしない。各リンク、公開範囲、法務本文、問い合わせ先を責任者が確認し、AT-01、03、04、05で404と保護URL混入がないことを確認する |
| メール | 組織所有の送信元名、送信元／reply-to／サポートアドレスを使い、送信ドメインを検証する。MVPは認証・請求等のシステムメールを対象とし、Newsletterは無効を候補とする | welcome、magic link/OTP、決済、支払失敗、解約の送受信と返信先をAT-02、06、12、13、19で確認する。件名・preheader・HTML/plain textへ会員本文、動画URL、PDF URLを含めない |

設定前にGhost Export、Members CSV、現行テーマZIP、`routes.yaml`、Portal/Tier/メール設定と、未使用であるGhost Admin Navigationの画面記録を取得します。証跡には環境、実施者、日時、対象Tier/Price IDの末尾だけ、結果、マスク済み画面、対応AT/DECを記録し、DEC-21の5項目（氏名欄、対象Tier/Price、規約notice、必須checkbox、サポートメール）を個別に残します。

異常時は保存したテーマZIPと`routes.yaml`を戻してhard-codedナビゲーションを復元し、Portal、メール設定を事前記録どおりへ戻します。Tier/Priceは既存契約へ影響するため削除・金額変更・本番Stripe切断を行わず、新規申込リンクを止めて運営責任者へ引き継ぎます。本番設定、Stripe接続、送信ドメイン認証はGate承認後の本人操作です。

## ルーティングとコンテンツ登録

`routes.yaml` は `/` を `home.hbs` に割り当て、通常ページは Ghost の `page-<slug>.hbs` 自動選択に任せています。投稿は次の2コレクションへ分離します。

- `/updates/` — `tag:-hash-lecture+visibility:public`。一般公開のお知らせを通常表示します。
- `/lectures/` — `tag:hash-lecture+visibility:paid`。会員向けレクチャーを一覧表示します。

レクチャーには内部分類タグ `#lecture`（スラッグ `hash-lecture`）、`year-YYYY`、`topic-<stable-name>`、`speaker-<stable-name>` を付けます。講師タグは表示名を実際の講師名（例 `山田 太郎`）、スラッグを `speaker-yamada-taro` とし、Ghostの投稿者アカウントを講師名の正本にしません。`#lecture` 投稿本文は、タグ判定・`visibility=paid`・Ghost の `access` がすべて成立した場合だけ出力します。いずれかが欠ける場合は本文を一切出さず、「運営設定エラー」を表示します。`welcome` も `visibility=paid` と `access` の両方を要求します。

MVPでは講師絞り込みをタグアーカイブで提供し、staff userのauthor archiveは `routes.yaml` で無効にします。編集用staffの氏名・bioを講師情報として公開しません。Ghostのメタデータ面はテーマだけで完全に制御できないため、検証サイトでauthor URLが404になることと、HTML／OGP／RSS／sitemapに意図しないstaff情報が出ないことを確認します。

## 会員アクセスと状態表示

本文の権限は `access` を正本にします。これにより、有料会員だけでなく Ghost が解決した complimentary/gift 権利も、実際に閲覧可能な場合は同じ保護本文へ到達できます。講義カードも可能な範囲で投稿単位の `access` を使い、`@member.paid` だけで閲覧可否を推測しません。

`@member.paid` は Stripe の `active` だけを表す値ではありません。Ghost の仕様上、`active`、`trialing`、回収中の `past_due`、設定によっては `unpaid` でも true になり得ます。テーマはこの値で課金権限を再計算せず、UIの説明文にだけ使います。購読状態は `@member.paid` の外側で走査し、`paused`、`past_due`、`unpaid`、`trialing`、期間末解約予約を Portal へ案内します。

Stripe の `pause_collection` は Ghost Theme の公開コンテキストへ露出させません。停止・再開・返金・解約・Dispute の確定は Ghost/Stripe の運営 Runbook と管理画面で行い、テーマは推測で状態を変更しません。

## 抜粋、本文、外部メディア

講義カードと講義ヘッダーは本文由来の自動 `excerpt` を使いません。Ghost Admin で、動画・PDF URLを含まない安全な `custom_excerpt` を入力してください。未入力時は固定の安全な案内へフォールバックします。公開お知らせと静的ページも同じ方針で、管理者が確認した `custom_excerpt` のみを表示します。

動画と PDF の URL は本文内にだけ配置します。Ghost エディターの Embed/HTML/File カードを使い、タイトル、抜粋、feature image の alt、タグ、公開ページ、メール、SNSへ外部 URLを貼らないでください。iframe は JavaScript で `loading="lazy"`、`title`、`allowfullscreen`、厳格な `referrerpolicy` を補完し、CSS は16:9比率を維持します。テーマは外部メディアを会員単位で認証・失効するものではありません。

## 検索、ページネーション、アクセシビリティ

開催年・テーマ・講師のタグは Ghost `get` ヘルパーの server-side filter と、Ghost 6 が許容する最大値 `limit="100"` で取得します。MVPでは各分類を100件以内に保ち、超える前に分類統合またはページ分割を設計します。キーワード検索は Ghost 標準検索（`data-ghost-search`）を起動し、保護本文・字幕全文・PDF本文をテーマ独自の公開検索インデックスへ追加しません。ページネーションは partial の `label` コンテキストで、お知らせ／講義の文言を分離します。

スキップリンク、44px以上の主要操作領域、キーボード操作、フォーカス可視化、モバイルメニューのフォーカストラップ、Escapeで閉じる動作、`prefers-reduced-motion`、画像の代替テキストを実装しています。本文の通常幅は48rem、Ghostの wide/fullカードは必要な場合だけブレークアウトします。

関連レクチャーはSHOULD要件で、MVP既定では無効です。現テーマの候補抽出は `primary_tag` を使うため、検証サイトでタグ順と関連性を受入確認した場合だけ `show_related_lectures` を有効にします。将来はtopic/speakerを明示的に選ぶ関連付けへ拡張します。

## deterministic ZIP と依存

テーマ直下で次を実行すると、`dist/minhos-membership-1.0.0.zip` を生成します。

```powershell
npm ci
npm test
npm run check
npm run build
```

ZIP はファイル順・mtimeを固定し、直下に `package.json`、`routes.yaml`、`index.hbs`、`post.hbs`、`assets/`、その他のテーマテンプレートだけを収めます。`scripts/` 内のビルド検査が ZIP の allowlist、禁止ディレクトリ、必須ファイルをfflateで再展開して自己検査します。GScanはリポジトリ管理下のテーマsourceだけへ実行し、外部由来ZIPは受け付けません。

依存は固定版 `gscan@6.4.2` と、再現可能な ZIP を作るための `fflate@0.8.3`（MIT）の開発依存だけです。どちらも Ghost アップロード ZIP へは含めません。GScanのtransitive `extract-zip`には修正版未公開のsymlink traversal advisoryがあるため、ZIP入力経路を使わず、期限付き例外と緩和策をルートの `config/dependency-audit-policy.json` で監査します。

## 公開前の実地検査（CMS excerpt / meta / OGP / ActivityPub）

静的検査は固定URL・秘密らしき値・本文ガード・`ghost_head` の存在を確認します。公開候補を Ghost(Pro) のステージングへアップロードした後、次を実地確認してください。

1. CMSで `custom_excerpt` を設定した講義と未設定の講義を用意し、カード・講義ヘッダー・お知らせ一覧が本文由来の自動 excerpt に置き換わらないことを確認する。
2. 未ログイン、free/失効、有料、complimentary/gift の各状態で、有料投稿の HTML ソースに本文、動画URL、PDF URLが出ないことを確認する。設定を一時的に `public` にした `#lecture` 投稿は本文ではなく運営設定エラーになることを確認する。
3. ページソースとSNSデバッガーで、CMSの meta title/description、canonical、OGP（`og:title`、`og:description`、画像）が意図した公開値だけになることを確認する。テーマは `ghost_head` を保持し、OGP/metaを手書きしません。
4. 投稿・お知らせの RSS、Ghost 標準検索、通知メール、ActivityPub の公開表現を確認し、会員本文、字幕、外部メディアURL、運営用データが混入していないことを確認する。ActivityPub が有効なサイトでは、公開お知らせだけが配信対象であることを管理画面と実レスポンスで確認する。
5. 320/375/768/1440 CSS px、キーボード、200%文字サイズ、400%ズーム、iOS Safari/Android Chromeで、Portal導線、カード、フォーカス、ページネーション、iframe比率を確認する。

## 既知の境界と承認事項

Ghost Portal/Checkout 本体の DOM、Stripe の課金操作、`pause_collection` の実行、外部メディアのアクセス制御、Google Workspace/Dropbox等との連携はこのテーマの責務外です。外部サービス接続は、別途 Gate 0〜5 の承認と Runbook の証跡を整えてから運営責任者が行います。
