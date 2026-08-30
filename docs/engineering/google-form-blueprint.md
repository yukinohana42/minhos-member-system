# Google Form ブループリント

機械可読定義は [`config/form-blueprint.json`](../../config/form-blueprint.json) が正本です。Formは有料会員向けウェルカムページからのみリンクし、公開ページ・メールへURLを置きません。

## 画面冒頭の説明（案）

「会員向け運営連絡と参加状況の把握に必要な補足情報を収集します。回答は運営上の目的に限定して利用します。氏名と会員アクセスはGhostを正本とし、このフォームの回答で課金・閲覧権限・スタッフ権限を変更しません。訂正・削除・問い合わせ窓口は承認済みのプライバシー案内を確認してください。」

公開前に運営責任者と法務担当がこの文言、利用目的、保存期間、問い合わせ・訂正・削除窓口を確定します。

## フィールド

| ID | 表示名 | 型 | 必須 | 用途／正本 |
|---|---|---|:---:|---|
| `profile_email` | Ghost登録メールアドレス | email | ○ | 候補照合のみ。Ghostを正本とし、trim＋小文字化 |
| `affiliation` | 所属 | 短文 | － | 補足属性。収集目的を表示 |
| `title_or_role` | 肩書き・役割 | 短文 | － | 補足属性。収集目的を表示 |
| `participant_type` | 参加区分 | 選択 | － | 参加者／登壇者／運営／その他（最終名称はDEC-05） |
| `privacy_acknowledgement` | 利用目的と窓口を確認しました | checkbox | ○ | 同意記録 |

住所、カード番号、セキュリティコード、KYC、本人確認資料、医療情報、パスワードは収集禁止です。

## 照合フロー

1. Google Formsは回答をnative回答タブへ自動保存します。回答受付前にそのタブを`30_Profile_RAW`へ改名し、Apps Scriptや運営者はheader・列・セルを作成、固定化、編集しません。
2. installable `onFormSubmit` eventの`FormResponse.getId()`を永続response IDとして読みます。native回答Sheetにはresponse ID列を追加せず、一意照合後は`40_Supplemental.profile_response_id`、競合時はretry queueだけへ保存します。
3. メールはtrimと小文字化だけ行い、Gmailのドットや `+` タグは除去しません。
4. 完全一致の候補を見つけたら、本人確認済みとはみなさず `ghost_member_id` を安定結合キーとして `40_Supplemental` へ投影します。
5. 未一致、複数一致、メール変更、再回答の相反は自動統合・上書きせず `50_Exceptions` へ送ります。
6. overrideがある場合はeffective列で優先します。Form回答でGhostアクセス、Stripe課金、スタッフ権限を変更しません。

## 受入条件（AT-24／AT-41）

- 未ログイン・free会員はウェルカム本文とForm URLを取得できない。
- 有料会員だけがウェルカムからFormへ到達できる。
- 完全一致、未一致、複数一致、再回答をfixtureで再現できる。
- 未回答・Form値がアクセスや課金を変えない。
- Google Workspaceの共有範囲、回答保存先、保持期間、削除窓口が承認済みである。
