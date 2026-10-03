# M3（LEV-277）設計：AI による候補の判定と生成

> **状態：設計確定（2026-10-02）・部分実装（フェーズ A）・実機未確認。** この文書は LEV-277 について 2026-10-02 に利用者が決めたこと（§1、§2）と、それに沿った設計をまとめたもの。§2.1 は設計判断として決めた項目、§2.2 は外部の生成 API について利用者が決めたこと（条件付きの項目と【要確認】を含む）。**実装したのは §16 の範囲だけ（ローカルの OpenAI 互換サーバーでの生成、Jev か判定なしの判定、決定的検査、同意と送信前の表示、生成カードの挿入）。Clef・ローカル logprobs 判定・OpenAI/カスタム生成・§11 の実測・§14 の実機確認はまだ。** 単体テスト（偽の HTTP クライアント）以外では動作を確認しておらず、実在の AI サービスにも接続していない。「瞬時」という表現は §11 の実測が終わるまで使わない。
>
> 前提：main の M1（LEV-275）と M2（LEV-276、実装済み・実機確認前）。M1 の候補ポップアップ（`src/ui/candidate-modal.ts`）、採用時だけの書き込み、原文照合・Canvas ガード・ディスク確認（3 秒 settle / 6 秒 deadline）・1回だけの回復（`docs/architecture.md`「書き込み経路」）をそのまま土台にする。採用されたカードは M1 と同じ `^kioku-<id>` 付きの Q/A ブロックになり、M2 のデッキ・復習にそのまま入る。

## 0. 受入条件（LEV-277、原文）

「Jev は typed decision で候補を評価し、別の生成モデルで要約から Q/A を生成。1ページから数枚、1枚1知識、原文から答えられる問いと引用。固定枚数のために根拠のない候補を作らない。API未設定・失敗・タイムアウト・キャンセルと外部送信の案内。モデル認証、品質、日本語の遅延を実測してから瞬時と報告する。」

利用者の目的：学習メモからフラッシュカードを「瞬時に」作ること。

### 0.1 目標

- 開いているノート（または選択範囲）1ページから、**原文の引用で根拠を示せる**カード候補を数枚作る。1枚1知識、問いは引用だけで答えられること。
- 候補は必ず人が確認して採用する（自動採用しない）。採用は M1 の書き込み経路の安全策を通る。
- 判定（Decision）と生成（Generator）を provider として差し替えられるようにする。AI 未設定でも決定的な検査だけで動く。
- 外部送信は既定 OFF。送る場合は送信先と内容を事前に示し、provider ごとの同意を得てから送る。
- 認証・品質・日本語での遅延を実測し、数値で報告する。

### 0.2 非目標（M3 ではやらない）

- 固定枚数の生成（「必ず 5 枚」など）。根拠が無ければ 0 枚でよい。
- 自動採用、AI 判定による候補の自動削除（決定的な引用不一致の除外だけは行う。§6）。
- プラグイン内での WebGPU/ONNX 推論（Laya Multilingual を含む）。**LEV-299 の別 PoC**（§1 S5）。
- Gemini 専用の provider（§1 S4 を 2026-10-02 に改定：有料キーの場合だけ、汎用の OpenAI 互換〈`custom`〉生成の選択肢として案内する。§2.2 G2）。
- Obsidian のタスクを Claude/Codex などのエージェントへ振り分ける仕組み（利用者の広い構想）。provider の抽象は後で再利用できる程度に汎用にするが、ルーティングは作らない。
- Vault 全体の一括生成、PDF/OCR、画像、Cloze、双方向カード、モバイル。
- 永続的な見送り記録（M1 と同じく「破棄」はポップアップから外すだけ）。

## 1. 決定事項（2026-10-02 利用者決定：決定ボードとチャット）

| # | 決定 | 設計への反映 |
| --- | --- | --- |
| S1 | **外部送信は既定 OFF**。ローカル優先（Ollama など）を案内する。 | 外部に送る provider は、API キーの設定と provider ごとの明示的な同意の両方がそろうまで使わない（§7）。 |
| S2 | **AI 未設定のときは決定的な検査だけ**を行う（引用が原文に完全一致するか、答えが引用に含まれるか、重複、長さ・1枚1知識の簡易判定）。AI による Q/A 生成は AI provider を設定したときだけ。UI は理由と設定方法を説明する。 | 決定的検査は常に走る（§6.1）。AI 未設定では生成ボタンの代わりに「AI が未設定のため…」と設定への案内を出す（§8）。 |
| S3 | provider として **Clef（Cloudflare Workers AI、利用者自身のアカウント）と Jev（TypeSafe AI）の両方**を入れる。 | §5.3・§5.4。 |
| S4 | **Gemini は使わない**。**2026-10-02 に改定：有料キーの場合だけ案内**（§2.2 G2）。 | 専用の provider は作らない。有料キーを使う場合だけ、`custom`（OpenAI 互換）生成の選択肢として案内する。 |
| S5 | プラグイン内の WebGPU/ONNX 推論（Laya Multilingual を含む）は **別 PoC：LEV-299**。M3 には含めない。 | §13。 |
| 範囲 | M3 はフラッシュカード候補の**判定と生成だけ**。エージェントへのルーティングは範囲外。 | §0.2。 |
| 構成 | **provider 方式の Decision Engine**（判定モデルを差し替え可能）。**既定の AI 判定 provider は Jev**。 | 「AI を有効にしたとき Jev があらかじめ選ばれている」と解釈する。Jev は API キーを設定し外部送信に同意した後だけ使う（S1 と両立）。何も設定していなければ決定的検査だけ。 |
| 生成 | Jev/Clef は判定するだけで文章を書けないため、要約 → Q/A には**別の Generator provider** が必要。 | ローカルの OpenAI 互換サーバー（Ollama〈判定にも使う場合は ≥0.12.11〉 / LM Studio の GGUF / llama.cpp）か、同意のうえで OpenAI/カスタム。既定は §2 Q1（ローカルの Ollama）。 |

## 2. 決定事項（2026-10-02 利用者が決定：決定ボード第4回）

設計案で「利用者に確認したいこと」としていた Q1〜Q8 について、利用者がすべて推奨案を選んだ。

| # | 項目 | 決定 | 理由（設計案での根拠） |
| --- | --- | --- | --- |
| Q1 | 既定の Generator provider | **ローカルの Ollama（OpenAI 互換）**。モデル名は固定せず、§11 の実測で日本語の品質と遅延が良かったものを README で推奨する。外部の OpenAI/カスタムは同意した場合だけ。 | S1（ローカル優先）と一致し、追加費用がない。Ollama は判定（logprobs、v0.12.11+）にも使える。 |
| Q2 | 生成カードの保存位置 | **引用元のブロック（段落・箇条書き項目）の直後**に、`Q:`/`A:` ブロック＋ `^kioku-<id>` と引用記録 `%%kioku-src:<card-id> … %%` を挿入する（§9）。箇条書き・表・引用・callout の中なら、その全体の直後（Markdown の構造を壊さないため。§9 の 5）。 | 根拠の近くにカードがあり、原文と一緒に動き、採用時の照合が局所的にできる。 |
| Q3 | 「瞬時」の目標値 | 日本語 2,000 字程度の1ページで、**最初の候補まで p50 ≤ 3 秒、全候補（判定込み）p95 ≤ 10 秒**。満たした provider の組み合わせだけを「瞬時」と呼ぶ。 | 受入条件が実測を求めている。 |
| Q4 | Jev の日本語精度が基準未満の場合 | 日本語の精度が目標に届かなくても **Jev を既定の判定 provider のまま**にし、設定画面と README に実測値と「日本語では精度が下がる」注記を出す。大きく下回る場合は利用者に改めて相談する。 | 既定は利用者の決定。変更は実測を見て利用者が決める。 |
| Q5 | API キーの保存先 | **プラグインの `data.json`**。`minAppVersion` は 1.8.7 のまま。リスク（§7.3）を設定画面と README に出す。 | 対応範囲を狭めない。SecretStorage（1.11.4 以上、§3.4）は採らない。 |
| Q6 | Ollama の cloud モデル | **外部送信の同意があるときだけ使え**、「外部」と表示する（§5.1、§7）。 | S1（既定 OFF・同意後のみ）と整合し、選択肢も奪わない。 |
| Q7 | ノート名（タイトル）を送るか | **送らない**（本文だけ）。送る設定も作らない。 | タイトルは個人的な情報を含み得る。 |
| Q8 | 判定 provider が未設定のまま生成だけ設定されている場合 | **生成を進め**、候補を「未判定（Jev 未設定）」と表示する。判定 provider に「判定なし（決定的検査だけ）」も用意する（§5.2）。 | Ollama だけ設定した利用者が何も作れない状態を避ける。 |

### 2.1 設計で決めたこと（エンジニアリング判断）

設計判断として決めた項目（利用者への確認は不要と判断）。値と理由を固定し、§11 の実測で必要なら見直す。

| # | 決めたこと | 理由 |
| --- | --- | --- |
| E1 | **AI が「根拠が弱い」と判定した候補**は削除せず、一覧の末尾に折りたたんで「AI が根拠が弱いと判定（N 件）」と表示し、開けば採用もできる。 | 判定は確率で、日本語では誤りもある。AI 判定で黙って捨てない。捨てるのは決定的な引用不一致（§6.1）だけ。 |
| E2 | **1回の送信量**は、ノート1つ（選択範囲があればそこだけ）で本文 8,000 字まで（初期値。§11 の実測で調整）。超えたら範囲の選択を求める。外部に送るたびに、送信前に「送信先・文字数・概算費用」を表示し、「送信して作る」を押すまで送らない（S1 の同意の流れの一部）。 | 遅延と費用を予測可能にし、意図しない大量送信を防ぐ。 |

### 2.2 外部の生成 API（2026-10-02 利用者が決定：決定ボード第5回とチャットでの再確認）

それまで「次の確認」としていた N1（無料・速い・賢い外部の生成 API を検討したい、という利用者のメモ）と N2（Gemini を比較候補へ戻す）について、利用者が次のように決めた。既定の生成 provider はローカルの Ollama のまま（Q1）。外部の生成 API はすべて外部送信の同意（S1）と送信前の表示（E2）を通る。Jev は判定専用で、生成には不要（Q8）。

| # | 決定 | 設計への反映 |
| --- | --- | --- |
| G1 | **外部の生成 API の推奨**：Groq の無料プランを**条件付きで**第一の推奨にする。条件は、個人の利用者が自分の Groq API キー（BYOK）を Obsidian から使うことが Groq の規約上認められると確認できること。確認できるまでは、注意点を示したうえで条件付きの候補として出し、GPT-6 Luna（OpenAI）と Cloudflare Workers AI も候補として出す。確認できなければ Groq は推奨から外す。 | Groq・Cloudflare Workers AI は `custom`（OpenAI 互換）の、GPT-6 Luna は `openai` の設定例として案内する（専用 provider は作らない。§5.6）。Groq には Zero Data Retention（ZDR）の設定方法も案内する。確認の手順は §11.4、根拠は §3.5。 |
| G2 | **Gemini**：**有料の API キーで使う場合だけ**選択肢として案内する。案内と UI には「無料枠では送信内容が Google の製品改善に使われる」と書く。Kioku は無料キーと有料キーを区別できないので、そのことも案内に書く。S4 を 2026-10-02 に改定：有料キーの場合だけ案内。 | 専用の Gemini provider は作らず、`custom`（OpenAI 互換。Gemini 側では beta）生成から使う（§5.6）。 |

## 3. 調査で確認した事実（出典）

2026-10-02 時点。実装前に再確認し、変わっていれば本書を更新する。

### 3.1 Jev（TypeSafe AI）

| 事実 | 出典 |
| --- | --- |
| 一般の新規登録が 2026-09-27/28 に再開。新規ユーザーへの $5 クレジットは停止中で、無料枠はない。 | [AI Front Page](https://aifront-page.com/typesafe-ai-reopens-jev-sign-ups-free-credit-suspended/) |
| API キーは `console.typesafe.ai/keys` で発行。OpenRouter からも使える（`typesafe/jev-1.13`、別名 `~typesafe/jev-latest`）。 | [Quickstart](https://docs.typesafe.ai/introduction/quickstart.md), [OpenRouter](https://openrouter.ai/docs/guides/community/jev) |
| 料金：入力 $0.042 / 100 万トークン、出力は無料。 | [Models](https://docs.typesafe.ai/models.md) |
| `POST https://api.typesafe.ai/v1/systemone`、Bearer 認証。本文 `{ model: "jev-latest", state, questions: { <key>: { type, instructions, criteria? } } }`。 | [API](https://docs.typesafe.ai/api.md) |
| 型：`noul`（0〜1 の値）、`choice`（必須の `criteria` に選択肢の map、≤255）、`score`（必須の `criteria` に 2〜10 段階の rubric 配列）。 | [API](https://docs.typesafe.ai/api.md) |
| 応答：`{ model, answers: { <key>: … }, usage }`。`noul` は `{ "noul": 0.95 }`、`choice` は `choice` / `probabilities` / `confidence`、`score` は `score` / `legend` / `probabilities` / `confidence`。 | [API](https://docs.typesafe.ai/api.md) |
| エラー：401（認証）、422（不正なリクエスト）、429（レート制限。バックオフする）、529（過負荷）。 | [API](https://docs.typesafe.ai/api.md) |
| 上限：コンテキスト 64k トークン、40 リクエスト/秒、100K トークン/秒。 | [Models](https://docs.typesafe.ai/models.md) |
| 主に英語で学習され、CJK の精度は低い（要検証と明記）。 | [Models](https://docs.typesafe.ai/models.md) |
| 利用者データで学習しない。DPA あり。ゼロデータ保持（ZDR）は営業経由。 | [Legal](https://docs.typesafe.ai/legal.md) |

【未検証】「state と最も長い question の合計は ≤32k トークン」という制約（調査メモにあったが api.md / models.md には見当たらない）、クレジット不足時の HTTP status と本文、`criteria` の効き方、日本語の state・instructions での精度。いずれも §11 の実測と単体テストの fixture 作成時に確かめる。

### 3.2 Clef（Cloudflare）

| 事実 | 出典 |
| --- | --- |
| `Cloudflare/clef`（27B）と `clef-flash`（9B）、Apache-2.0。typed decision（bool / choice / score を logits で返す）。 | [Hugging Face](https://huggingface.co/Cloudflare/clef), [Cloudflare blog](https://blog.cloudflare.com/clef-decision-models/) |
| Workers AI で `@cf/cloudflare/clef` / `@cf/cloudflare/clef-flash` として提供（2026-10-01）。1リクエストに typed question 最大 64 個、コンテキスト 64K。clef-flash の中央値は 38.8 ms（「Jev より 13 倍速い」と記載）。 | [Changelog](https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/) |
| Workers AI はアカウントごとに 1 日 10,000 Neurons まで無料。clef-flash は入力 100 万トークンあたり 8,182 Neurons（$0.090）、clef は 21,818 Neurons（$0.240）。無料枠は入力換算で約 122 万トークン/日（clef-flash）、約 46 万トークン/日（clef）。 | [Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| ローカル実行は現実的でない（サイズ）。日本語の性能は不明。 | [Hugging Face](https://huggingface.co/Cloudflare/clef) |

【未検証】Workers AI REST での入力・出力スキーマ、日本語のトークン数（1 判定あたりの実際の Neurons）、日本語での精度、エラー status。

### 3.3 ローカルサーバーで logprobs による判定

| 事実 | 出典 |
| --- | --- |
| Ollama は v0.12.11 から OpenAI 互換の chat completions で logprobs に対応。`top_logprobs` は最大 20。 | [Ollama v0.12.11](https://github.com/ollama/ollama/releases/tag/v0.12.11), [ollama/ollama#18590](https://github.com/ollama/ollama/issues/18590) |
| llama.cpp server は独自の `/completion` で `n_probs` を指定すると上位トークンの確率を返す。 | [llama.cpp server README](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md) |
| LM Studio は `/v1/responses` で logprobs を返す（0.3.39、`include: ["message.output_text.logprobs"]` と `top_logprobs`）。 | [LM Studio blog](https://lmstudio.ai/blog/openresponses) |

「OpenAI 互換」でも logprobs の取り方はサーバーごとに違う。そのためローカル判定は**サーバー種別ごとに別の endpoint** を使う（§5.5）。

判定の作法（上記の仕様から導いた設計）：選択肢を 1 トークンの ASCII ラベル（`A` / `B`、`1`〜`5`）にし、`max_tokens: 1`、`temperature: 0` で上位の logprobs を取り、選択肢のトークンだけで確率を正規化する。

【未検証】LM Studio の MLX runtime で logprobs が返らないこと（調査メモにあったが上記の blog には記載がない）、llama.cpp の OpenAI 互換 endpoint で logprobs が返るか、日本語モデルのトークナイザで ASCII ラベルが 1 トークンになるか（モデルごとに確認）、各サーバーの JSON schema 出力（`response_format` / `format`）の対応。

### 3.4 Ollama の cloud モデルと Obsidian の SecretStorage

| 事実 | 出典 |
| --- | --- |
| Ollama の cloud モデルは、ローカルのアプリや CLI から `<model>:cloud` の名前で呼び出すと、ダウンロードせずに Ollama のサーバー上で実行される（`localhost:11434` 経由でも外部で処理される）。 | [Ollama Cloud](https://docs.ollama.com/cloud)。【要検証】接尾辞の正確な規則（`:cloud` だけか、`-cloud`〈例 `gpt-oss:20b-cloud`〉も含むか）と、`/api/show` で cloud モデルを判別できるか。 |
| Obsidian の SecretStorage（`app.secretStorage.getSecret` / `setSecret`）。秘密情報を Vault に結び付けたローカルストレージに保存し、Vault のファイルには書かない。1.11.4 から使える。 | Obsidian Developer Docs「Store secrets」（API と保存先）。対応版 1.11.4 は第三者の解説記事による（公式の記載で再確認する）。 |

### 3.5 外部の生成 API（G1・G2 の根拠）

親（orchestrator）と利用者が一次情報のページで確かめた事実（2026-10-02）。

| 事実 | 出典 |
| --- | --- |
| Groq Services Agreement（最終更新 2026-06-22）：冒頭に「Cloud Services and the AI Model Services under this Agreement are not for consumer use.」。§3.1 は顧客のアプリケーションへ組み込んで End User に提供することを認める。§4.2 は、顧客が許可しない限り Groq は Inputs/Outputs を学習に使わない。§5.1 は上限内で料金なしのサービスがあり得るとする。【要確認】この規約が (a) API を組み込む開発者と (b) 個人の利用者が Obsidian で自分の無料キーを使う BYOK のどちらに当てはまるかは不明。 | [Groq Services Agreement](https://console.groq.com/docs/legal/services-agreement) |
| Groq の推論の入力・出力は既定では保持しない。トラブル対応・不正調査のため一時的に記録されることがあり、最長 30 日保持。Zero Data Retention は顧客が Data Controls で有効にする必要がある。使用量のメタデータ（入力・出力を含まない）は収集する。このページ自体は学習に触れておらず（学習は Agreement §4.2）、無料・有料の区別もない。 | [Groq Your Data](https://console.groq.com/docs/your-data) |
| Groq の無料プランの上限：組織単位で 30 RPM / 1,000 RPD / 8,000 TPM / 200,000 TPD。 | [Groq Rate Limits](https://console.groq.com/docs/rate-limits) |
| Groq は gpt-oss-120b / gpt-oss-20b / qwen3.8-27b で厳密な JSON schema 出力に対応。 | [Groq Structured Outputs](https://console.groq.com/docs/structured-outputs) |
| GPT-6 Luna（`gpt-6-luna`、2026-09-22 発表）：100 万トークンあたり入力 $0.10 / 出力 $0.50（キャッシュ入力 $0.01）。Structured Outputs 対応。API に無料枠はない。API のデータは既定では学習に使われない。 | [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Your data](https://developers.openai.com/api/docs/guides/your-data) |
| Cloudflare Workers AI：1 日 10,000 Neurons まで無料。gpt-oss-120b と qwen3.8-27b が使える。入力を保存せず学習にも使わない。これらのモデルは公式の JSON Mode の一覧に無いので、構造化出力は Kioku 側で検証する必要がある。 | [Data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/), [JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/) |
| Gemini API：無料枠は「Used to improve our products: Yes」、有料は「No」。OpenAI 互換の endpoint は beta。 | [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai) |

【要確認】個人の利用者が自分のキー（BYOK）を使うことが各社の規約上どう扱われるかは、**どの provider についても確かめていない**。README で特定の provider を推奨する前に確かめる（§11.4、§14）。【未検証】Cloudflare Workers AI の OpenAI 互換 endpoint の URL と、gpt-oss-120b / qwen3.8-27b をその経路で呼べるか。

### 3.6 Obsidian の `requestUrl`

`RequestUrlParam`（obsidian 1.8.7 の `obsidian.d.ts`）は `url` / `method` / `contentType` / `body` / `headers` / `throw` だけを持ち、中断（AbortSignal）とタイムアウトの指定がない。

## 4. 処理の流れ

```text
入力（開いているノート / 選択範囲）
  └─ M1 と同じ読み取り規則・除外領域で本文を確定（frontmatter・コード・%%・HTML コメント・$$ は送らない。Excalidraw ノートは AI 生成の対象外、§9）
       ├─ 明示 Q/A（M1 parser）──────────────┐
       └─ AI 生成（Generator 設定時だけ）       │
            1. 送信前の確認（外部なら送信先・文字数・概算費用、同意済みか）
            2. Generator：本文 → 要約（原子的な事実と引用）→ Q/A 候補
                                              │
  決定的検査（常に。§6.1）◀────────────────────┘
       └─ 引用の完全一致に失敗した生成候補は除外（件数だけ表示）
  判定（Decision provider 設定時だけ。§6.2）
       └─ Jev / Clef / ローカル logprobs。失敗した候補は「未判定」
  候補ポップアップ（M1 を拡張。§8）：引用・理由・判定を見て、編集・採用・破棄
  採用（M1 の書き込み経路＋生成カード用の挿入。§9）
```

- 起動時・設定タブを開いただけ・候補ポップアップを開いただけでは、ネットワークに触れない。通信するのは「AI で候補を作る」ボタン（とポップアップ内の「再判定」）と、設定タブの「接続テスト」ボタンを押したときだけ。
- ノートの読み取りは M1 と同じ（編集中ビューがあれば editor、無ければファイル。Reading view の選択範囲は使わない）。書き込みは採用時だけ。
- **要約の段階**：Generator にはまず本文から「1つの事実＋それを支える原文の引用」の列（要約）を作らせ、各事実から問い・答えを作らせる。M3 では 1 回の呼び出しで JSON（§5.1 の `GeneratedCandidate[]`）として返させ、2 回に分けた方が品質が良いと §11 で分かれば分ける。
- **枚数**：プロンプトでも検査でも枚数を固定しない。「根拠のある事実がなければ 0 件でよい」と明示し、上限は誤動作の歯止めとして 1 ページ 20 件だけ置く（超えた分は捨てて件数を表示）。
- **送る本文の作り方**：M1 の `classifyLines` が除外するのは行単位の領域だけで、1行の中で閉じる `%%…%%`・`<!--…-->`・`$$…$$` は普通の行として残る。外部に送らないと約束するため、送る前に除外領域の行（`kind !== null`）を取り除き、残りの行からも行内の `%%…%%` と `<!--…-->` を取り除く（インラインコードは学習内容になり得るので残す）。取り除いた位置は元の offset への対応表で管理する。
- **送らないもの**：ノート名（タイトル）は送らない（Q7。送る設定も作らない）。ファイルパス・Vault 名も送らない（§7.1）。
- 明示 Q/A（M1）は AI の有無にかかわらず従来どおり出し、決定的検査の重複・長さの注意を付ける。明示 Q/A には AI 判定を既定では走らせない（人が書いたものなので。後続で選択可能にする余地は残す）。

## 5. Provider

### 5.1 インターフェース（実装時に確定する型のスケッチ）

`src/ai/` は Obsidian に依存しない純粋な型とロジック、通信は注入する `HttpClient` を通す（§12）。

```ts
// src/ai/types.ts
export type DecisionType = 'noul' | 'choice' | 'score';

/** Mirrors Jev systemone question types (§3.1). */
export type DecisionQuestion =
  | { readonly type: 'noul'; readonly instructions: string }
  | { readonly type: 'choice'; readonly instructions: string;
      readonly criteria: Readonly<Record<string, string>> }  // option key → description, ≤255
  | { readonly type: 'score'; readonly instructions: string;
      readonly criteria: readonly string[] };                // rubric, 2–10 levels, lowest first

/** Shaped like Jev systemone; other providers normalize into it. */
export interface DecisionResult {
  readonly value: number | string;      // noul: 0–1, choice: option, score: weighted 0-based level (continuous, e.g. 1.05)
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;          // 0–1
}

export type ProviderFailure =
  | { readonly kind: 'unconfigured' | 'consent-required' }
  | { readonly kind: 'auth' | 'quota' | 'rate-limited' | 'overloaded' | 'invalid-request'
      | 'invalid-response' | 'network' | 'timeout' | 'cancelled' | 'server'; readonly detail: string };

export type ProviderOutcome<T> = { readonly ok: true; readonly value: T; readonly ms: number }
  | { readonly ok: false; readonly failure: ProviderFailure; readonly ms: number };

export interface ProviderInfo {
  readonly id: 'deterministic' | 'jev' | 'clef' | 'local' | 'openai' | 'custom';
  readonly label: string;
  readonly external: boolean;           // non-loopback endpoint, or a cloud model (§5.1 note)
  readonly endpointHost: string;        // shown in consent and run header
}

export interface DecisionProvider extends ProviderInfo {
  decide(state: string, questions: Readonly<Record<string, DecisionQuestion>>,
    signal: AbortSignal): Promise<ProviderOutcome<Readonly<Record<string, DecisionResult>>>>;
}

export interface GenerationInput {
  readonly source: string;              // excluded regions already removed
  readonly language: 'ja' | 'auto';
  readonly maxCandidates: number;       // safety cap only (20), never a target
}

export interface GeneratedCandidate {
  readonly fact: string;                // the one fact (the "summary" line)
  readonly question: string;
  readonly answer: string;
  readonly quote: string;               // must match the source exactly (§6.1)
}

export interface GeneratorProvider extends ProviderInfo {
  generate(input: GenerationInput, signal: AbortSignal): Promise<ProviderOutcome<readonly GeneratedCandidate[]>>;
}
```

- 例外は provider の外へ投げず、すべて `ProviderOutcome` に変換する（UI が理由を出し分けるため）。
- provider は設定から作る factory で生成し、未設定・未同意なら `unconfigured` / `consent-required` を返すだけで通信しない。
- `external` は provider の種類でなく**接続先とモデル**で決める。次のどれかに当たれば外部扱いで同意が要る（cloud モデルは Q6 の決定どおり、同意があるときだけ使える）。
  - 接続先が `localhost` / `127.0.0.1` / `::1` 以外（LAN の別 PC など）。
  - Ollama の cloud モデル：モデル名が `:cloud` / `-cloud` で終わる。名前で判別できない場合に備え、接続テストで Ollama の `/api/show` から cloud モデルかを判別できるか試す【要検証】。判別できない・確かめられないモデルは、名前の規則だけで判断し、プライバシー文で注意する。
  - LM Studio / llama.cpp が外部へ中継しているかは Kioku からは分からない。設定画面とプライバシー文で「ローカルのサーバーが別のサービスへ中継する設定なら外部に送られる」と注意する。
- **Jev の型との対応**：Kioku の `DecisionQuestion` は Jev の question をそのまま写す。応答は次のように `DecisionResult` へ正規化する。`noul`：`value = noul`、`probabilities = { yes: noul, no: 1 - noul }`、`confidence = max(noul, 1 - noul)`（Jev は noul に confidence を返さないため Kioku 側で導く）。`choice`：`value = choice`、`probabilities`・`confidence` はそのまま。`score`：Jev の `score` は 0 始まりの段階を確率で重み付けした連続値（例 `1.05`。`legend`・`probabilities` のキーは `"0"`, `"1"`, …）なので、`value = score`（0 ≤ score ≤ 段階数 − 1 の有限値なら小数も受け付ける）、`probabilities`・`confidence` はそのまま。表示上の品質（§6.2 の 1〜5）は `score + 1`。`quality` の答えが壊れていても判定全体は失敗にせず、品質だけ無しとして扱う（表示順の参考にすぎないため）。Clef とローカル判定も同じ形に正規化する。

### 5.2 provider 一覧

| id | 役割 | 外部送信 | 既定 | 備考 |
| --- | --- | --- | --- | --- |
| `deterministic` | 検査（判定の前段） | なし | 常に有効 | §6.1。provider と同じ結果型で理由を返すが、確率は持たない。 |
| `none` | 判定なし（決定的検査だけ） | なし | — | provider ではなく判定 provider の設定値（`ProviderInfo.id` には含めない）。選ぶと AI 判定をせず、候補は決定的検査だけで「未判定」と表示する（Q8）。 |
| `jev` | 判定 | あり | **AI を有効にしたときの既定の判定 provider** | API キー＋同意後だけ。§5.3。 |
| `clef` | 判定 | あり（Cloudflare） | — | 利用者自身の Cloudflare アカウント ID と API トークン。§5.4。 |
| `local` | 判定（logprobs）＋生成 | なし（loopback かつ cloud モデルでないとき） | 生成の既定（Q1） | Ollama / llama.cpp / LM Studio。§5.5。 |
| `openai` | 生成 | あり | — | 同意後だけ。§5.6。 |
| `custom` | 生成（OpenAI 互換） | 接続先しだい | — | 任意の base URL。§5.6。 |

判定と生成は別々に選ぶ（例：判定 Jev ＋ 生成ローカル、判定ローカル ＋ 生成ローカル、判定なし ＋ 生成ローカル）。判定 provider が Jev のまま未設定・未同意で、生成だけ使える場合は、Q8 の決定どおり生成を進めて候補を「未判定（Jev 未設定）」と表示する。生成が未設定なら AI 生成は行わず、判定だけ設定されていても明示 Q/A には既定で判定を走らせない（§4）。

### 5.3 Jev

- `POST https://api.typesafe.ai/v1/systemone`、`Authorization: Bearer <key>`、`model: "jev-latest"`（設定で変更可）。
- 候補 1 件につき 1 リクエスト。`state` は「引用＋前後の文脈（§4 で除外領域と行内コメントを取り除いた本文から最大 1,500 字）＋候補の問い・答え」、`questions` は §6.2 の 4 問（`quality` は `criteria` に §6.2 の rubric を入れる）。小さい state で並列に送るので、上限（コンテキスト 64k トークン、40 req/s）に余裕があり、途中経過を候補ごとに表示できる。同時実行は 4 件まで。
- 費用は入力トークンだけ（出力無料）。1 候補 ≈ 1,000 トークンとして 1 ページ 10 候補で約 1 万トークン ≈ $0.0004【未検証：日本語のトークン数】。
- 401 → 認証失敗（キーの発行場所 `console.typesafe.ai/keys` を案内）、422 → 不正なリクエスト（再試行しない。サイズ超過なら範囲を狭める案内）、429・529 → バックオフ（§10）。
- OpenRouter 経由は M3 では作らない（経路を1つにして検証範囲を絞る）。必要になれば同じ `DecisionProvider` で追加できる。

### 5.4 Clef

- Workers AI の REST（アカウント ID と API トークン）で `@cf/cloudflare/clef-flash`（既定、速さ優先）または `@cf/cloudflare/clef` を呼ぶ。入出力スキーマは【未検証】のため、実装前に公式ドキュメントで確定し、bool → `noul`、choice → `choice`、score → `score` に正規化する。
- 無料枠（1 日 10,000 Neurons）を超えた場合の status を `quota` に対応付ける（【未検証】）。

### 5.5 ローカルサーバー（Ollama / llama.cpp / LM Studio）

- 設定：サーバー種別（Ollama / llama.cpp / LM Studio）、base URL（サーバーのホストとポートまで。既定は種別ごとに Ollama `http://localhost:11434`、llama.cpp `http://localhost:8080`、LM Studio `http://localhost:1234`。下記の endpoint のパスは base URL の後ろに付ける）、生成モデル名、判定モデル名（同じでも可）。
- **生成**：chat completions に JSON schema 付きの出力を要求し（サーバーごとの方式は【未検証】。使えなければ JSON をプロンプトで指示して検証で弾く）、`temperature` は低め（0.2）。
- **判定の endpoint はサーバー種別ごと**（§3.3）。
  - Ollama：OpenAI 互換の `/v1/chat/completions` に `logprobs: true`、`top_logprobs`（≤20）、`max_tokens: 1`、`temperature: 0`。
  - llama.cpp：独自の `/completion` に `n_probs`、`n_predict: 1`、`temperature: 0`（プロンプトはチャットテンプレートを適用した文字列で送る）。
  - LM Studio：`/v1/responses` に `include: ["message.output_text.logprobs"]`、`top_logprobs`、出力 1 トークン（`max_output_tokens: 1` を想定。LM Studio が受け付けるかは【未検証】）。
- **判定**：§3.3 の作法。`noul` は「A=はい / B=いいえ」の 2 択で `P(A)` を値に、`score` は `1`〜`5` のラベルの確率を 0 始まりの段階に読み替え、Jev と同じく確率で重み付けした連続値（期待値）を値にする。確率をそのまま probabilities（キーは `"0"`〜`"4"`）、最大確率を confidence にする。選択肢トークンが上位 logprobs に1つも無い場合は `invalid-response`（未判定）。
- 接続テストで (1) モデル一覧に指定モデルがあるか、(2) 1 トークンの判定で logprobs が返るか、を確かめる。logprobs が返らない（v0.12.11 より古い Ollama、LM Studio の一部 runtime【未検証】など）場合は「このサーバーでは判定に使えません（生成には使えます）」と表示する。

### 5.6 OpenAI / カスタム（生成）

- OpenAI 互換の chat completions。API キー、モデル名、カスタムは base URL。外部（非 loopback、または cloud モデル）なら同意が要る。
- **設定例（G1・G2）**：専用 provider は作らず、設定画面で次の例と注意を示す。いずれも外部送信の同意と送信前の表示が要る。
  - Groq（`custom`）：無料プランの上限（§3.5）と、規約上の BYOK の扱いが【要確認】であることを表示する（確認できるまでは「条件付きの候補」）。Zero Data Retention を Groq の Data Controls で有効にする方法を案内する。JSON schema 出力は対応モデル（gpt-oss-120b / gpt-oss-20b / qwen3.8-27b）で使う。
  - GPT-6 Luna（`openai`）：無料枠がなく従量課金であること。
  - Cloudflare Workers AI（`custom`）：無料枠（1 日 10,000 Neurons）。JSON Mode の対象外のモデルは出力を Kioku 側で検証する（§6.1 の検証はどの provider でも行う）。
  - Gemini（`custom`、OpenAI 互換 endpoint は beta）：**有料キーの場合だけ**。「無料枠では送信内容が Google の製品改善に使われます。Kioku は無料キーと有料キーを区別できません。有料のキーで使ってください。」と表示する。
- 判定に使う logprobs 経路は M3 では `local` だけに実装する（外部 LLM の logprobs 判定は Jev/Clef と役割が重なるため）。

## 6. 検査と判定

### 6.1 決定的検査（常に。S2）

すべて純粋関数（`src/ai/checks.ts`）。比較用の正規化は NFC、改行・連続空白を 1 つの空白に、前後 trim（全角/半角や句読点は変えない）。

| 検査 | 対象 | 結果 |
| --- | --- | --- |
| 引用の完全一致 | 生成候補 | 正規化した引用が、送った本文（§4 のとおり除外領域と行内コメントを除いた部分）に現れる。現れなければ**除外**し、「原文に見つからない引用のため除外 N 件」とだけ表示する（根拠のない候補を出さない）。一致箇所は元の offset に戻して確かめ、取り除いた部分の境界をまたぐ一致は不一致とする。M3 では引用は1つのブロック内に限り、空行をまたぐ引用は不一致とする。照合の対象は `kind === null` の行だけなので、Kioku 自身の `%%kioku-src%%` 記録（§9）は数えない。一致したブロックの開始 offset と原文を候補に記録する（§9 の挿入位置の特定に使う）。同じ引用が複数のブロックにある場合は最初のものを記録し、「同じ文が複数箇所にあります」と注記する（カードは最初の箇所の直後に挿入される）。 |
| 答えが引用に含まれる | 生成候補 | 正規化した答えが引用の部分文字列なら合格。そうでなければ「答えが引用にそのまま含まれていません」の**要確認**（言い換えの答えはあり得るので除外しない。判定 provider がある場合は §6.2 の `supported` で補う）。 |
| 重複 | 全候補 | 同じノートの採用済みカード・他の候補と、正規化した問い（と答え）が一致すれば「重複」。採用済みと一致する生成候補は既定で非表示（件数表示）、候補同士は先の1件を残す。 |
| 長さ | 全候補 | 問い 120 字・答え 200 字・引用 300 字を超えたら要確認（初期値。§11 で調整）。問い・答えが空なら除外。 |
| 1枚1知識の簡易判定 | 全候補 | 答えが 3 行以上の箇条書き、「、」「・」で 4 項目以上の列挙、問いに「〜と〜」「それぞれ」「すべて」を含む、などで「複数の知識を含む可能性」の要確認。 |
| 構文 | 生成候補 | M1 の編集記録と同じ禁止（空行、行頭 Q/A marker、見出し、fence、`$$`、`<!--`、`%%`、`^kioku-`）。違反は M1 の理由文で要確認（そのままでは採用不可、編集で直せば採用可）。 |

### 6.2 判定（Decision provider 設定時だけ）

候補 1 件ごとに、次の typed question を送る（文言は日本語と英語の両方を §11 で比較し、良い方を採る）。

| key | 型 | 内容 |
| --- | --- | --- |
| `supported` | `noul` | 答えは引用だけから正しく導けるか。 |
| `answerable` | `noul` | 問いは、引用を読んだ学習者が一意に答えられる明確な問いか。 |
| `one_fact` | `noul` | カードが1つの知識だけを問うているか。 |
| `quality` | `score`（5 段階） | 学習カードとしての有用さ（M3 では表示順の参考だけに使う）。`criteria` は下の rubric。 |

`quality` の rubric（`criteria`、低い順。日本語と英語の訳を §11 で比較する）：

1. 学習カードとして役に立たない（引用と関係がない、自明すぎる、意味が通らない）。
2. 問いか答えが曖昧で、大きな手直しが必要。
3. 使えるが、問いの言い回しか答えの範囲に手直しが要る。
4. そのまま使える。ページの中での重要度は中程度。
5. そのまま使え、ページの要点を問う重要なカード。

分類（しきい値は §11 で決める。初期値）：

- **推奨**：決定的検査に要確認がなく、`supported ≥ 0.8`、`answerable ≥ 0.7`、`one_fact ≥ 0.7`。
- **要確認**：推奨にも根拠が弱いにも当たらないもの。理由（どの検査・どの判定が低いか、confidence が 0.6 未満なら「AI の確信度が低い」）を候補に表示する。
- **根拠が弱い**：`supported < 0.3`（要確認より優先）。E1 のとおり折りたたんで表示（削除しない）。
- **未判定**：判定なし（`none`）、判定 provider が未設定・未同意（「未判定（Jev 未設定）」など。Q8）、判定の失敗・タイムアウト・キャンセル。決定的検査の結果だけで表示する。

**自動採用はしない**（推奨でも人が「採用」を押す）。表示順は 推奨 → 要確認 → 未判定 → 根拠が弱い、同じ分類内は原文の出現順。

## 7. 外部送信と同意（S1）

### 7.1 規則

- 既定は AI 無効（`ai.enabled = false`）。有効にすると判定 provider に Jev が選ばれた状態になるが、API キーと同意がそろうまで Jev には送らない。判定 provider には「判定なし（決定的検査だけ）」も選べる（§5.2）。
- 同意は provider ごと（`jev` / `clef` / `openai` / `custom`、非 loopback または cloud モデルの `local`）に、設定タブで送信先ホストとプライバシー文（§7.2）を表示したうえでトグルを ON にしてもらう。base URL・provider・モデル（cloud モデルかどうかが変わる）を変えたら同意を取り直す。
- 毎回の実行時、候補ポップアップの上部に「送信先：api.typesafe.ai（判定）／ローカル localhost:11434（生成）・本文 N 字・概算 $X」を表示し、外部送信がある実行は「送信して作る」ボタンを押すまで送らない（E2）。cloud モデルは「外部」と表示する。
- 送るのは除外領域を除いた本文（または選択範囲）、生成した候補、判定用の引用と文脈だけ。ノート名（タイトル）、ファイルパス、Vault 名、他のノート、`Kioku/` の学習記録は送らない。ノート名を送る設定は作らない（Q7）。

### 7.2 プライバシー文（UI 文言の案）

> AI で候補を作ると、このノートの本文（コードブロック・`%%` コメント・HTML コメント・数式ブロック・frontmatter を除く）が、選んだ AI サービスに送られます。
> - 送信先：〈ホスト名〉（〈provider 名〉）。このパソコン内のサーバーで実行するモデルを選んだ場合は外部に送られません。ただし、Ollama の cloud モデル（名前が `cloud` で終わるもの）や、ローカルのサーバーが別のサービスへ中継する設定の場合は、外部に送られます。
> - 送信先での扱いは各サービスの規約に従います（例：TypeSafe AI は利用者データで学習しないと公表しています）。
> - 費用は利用者のアカウントに請求されます。キャンセルしても、送信済みの分は請求されることがあります。
> - API キーはこの Vault の `.obsidian/plugins/kioku/data.json` に暗号化せずに保存されます。

### 7.3 API キーの保存（Q5：`data.json`）

- 保存先はプラグインの `data.json` の `ai.providers.<id>` 内（学習記録の `Kioku/` とは別）。
- **リスク**：平文。Obsidian Sync の設定同期・Git 管理・クラウド同期・バックアップで Vault と一緒に複製され得る。他のプラグインから読める。→ 設定画面と README に明記し、利用上限を設定した専用キーの利用を勧める。
- キーはログ・Notice・エラー文・`artifacts/`・評価結果に出さない（エラー詳細は status とサービス名だけ。応答本文をそのまま表示しない）。入力欄は password 型、保存済みは末尾 4 文字だけ表示。「キーを削除」ボタンを置く。
- 単体テストで「どの失敗経路の理由文にもキーの文字列が含まれない」ことを固定する。
- SecretStorage（`app.secretStorage`、1.11.4 以上）は M3 では使わない（Q5）。将来 `minAppVersion` を上げるときの移行先の候補として残す。

## 8. UI

- **入口**：既存の抽出コマンド・ボタン・ファイルメニューのまま。候補ポップアップに「AI で候補を作る」ボタンを足す（押したときだけ通信）。AI 未設定のときはボタンの代わりに「AI が未設定のため、ノートに書いた問い・答えだけを表示しています。設定 → Kioku → AI で、ローカルの AI（Ollama など）か外部サービスを設定できます。」と「設定を開く」。
- **進行表示**：「生成中…（N 秒）」→ 候補が届いたら決定的検査の結果ですぐ表示し、判定は候補ごとに届いた順に更新する。「キャンセル」ボタンは常に押せる。
- **候補カード**：問い・答えの編集欄（M1 と同じ）、引用（原文の該当箇所を強調、クリックでノートの該当位置へ）、分類バッジ（推奨 / 要確認 / 未判定 / 根拠が弱い）、理由の一覧、生成・判定 provider 名。明示 Q/A と生成候補は見出しで分ける。
- **採用**：生成候補の「採用」は §9 の挿入を行う。挿入位置（引用元のブロックの直後。リスト・表・引用・callout の場合はその全体の直後、§9）と、追加する行（Q/A、`^kioku-…`、引用の記録、空行）を採用前にカードに表示する。
- **設定タブ（AI セクション）**：AI を使う（既定 OFF）、判定 provider（既定 Jev。「判定なし」も選べる）、生成 provider（既定 ローカルの Ollama。Q1）、provider ごとのキー・接続先・モデル・同意トグル、接続テスト、タイムアウト（既定 判定 20 秒 / 生成 60 秒）、プライバシー文。UI 文言は公式 lint の sentence-case 規則を守る（`docs/architecture.md`「既知の制約」）。
- 状態 modal の実装状況表示は、M3 実装時に「AI：設定時のみ、候補は人が採用」へ更新する（それまでは「AI は未実装」のまま）。

## 9. 採用：生成カードの挿入（Q2）

M1 は「ノートに既にあるブロックの末尾に ID を足す」だけだったが、生成カードはノートにまだ無いので**新しいブロックを挿入**する。安全策は M1 をそのまま使う。

挿入する形（例）：

```text
光合成は、光エネルギーを使って二酸化炭素と水から糖を作る反応である。葉緑体で行われる。

Q: 光合成が行われる細胞小器官は？
A: 葉緑体 ^kioku-k3j9x2m4pq

%%kioku-src:kioku-k3j9x2m4pq
葉緑体で行われる。
%%
```

1. 採用を押した時点の本文（M1 と同じく編集中ビューの editor、無ければ `Vault.process` の callback 内）で、§6.1 で記録したブロックを M1 と同じ規則で探す：記録した offset に同じ原文のブロックがあればその直後、無ければ同じ原文のブロックが `kind === null` の範囲に**ちょうど1つ**のときだけその直後。0 個（外部で変更）・複数（特定できない）なら書かずに理由を表示する（M1 の `sourceChanged` / `ambiguous`）。同じ引用元から作った2枚目以降の採用でも、`%%kioku-src%%` 内の引用の写しは照合対象外なので曖昧にならない。採用で挿入した分だけ、同じポップアップの他候補の記録 offset をずらす（M1 と同じ）。
2. 挿入するのは「空行 ＋ Q/A ブロック（最終行末に ` ^kioku-<id>`）＋ 空行 ＋ `%%kioku-src:<card-id>` 〜 `%%` ＋（次の行が空行でなければ）空行」だけで、原文の文字は変えない。改行コードは M1 の規則に従う。ID は M1 の `generateCardId`。引用記録には、原文から取り出したそのままの引用（正規化前）を書く。引用記録の本文には M1 の編集記録と同じ禁止（空行、行頭 Q/A marker、見出し、fence 行、`$$`、`<!--` / `-->`、`%%`、`^kioku-`）を適用する。特に `%%` を含むと行ごとの `%%` の奇偶が崩れ、後続の Q/A が除外領域に入る・逆に露出するため、そうした引用の候補は「引用を記録できないため採用できません」と理由を付けて表示し、採用不可とする（問い・答えの編集では直せないため）。編集した場合も同じ形（生成カードには `%%kioku-edit%%` は付けず、編集後の内容で Q/A を書く）。
3. 引用の記録は `%%` 内なので M1/M2 の parser は Q/A として読まず、Reading view にも出ない。`%%kioku-src:` の行は M1 の編集記録と同じく `%%` comment 内だけで読む。将来、原文の変更で引用が見つからなくなったカードを知らせるのに使える（M3 では書くだけ）。
4. Canvas ガード、ディスク確認（3 秒 / 6 秒）、1回だけの回復（静止 2.5 秒、最長 12 秒）は M1 と同じ。回復の再書き込みでも 1. の引用照合からやり直す。
5. Excalidraw ノートでは AI 生成を行わない（描画データと本文の境界に挿入すると壊す危険があるため。明示 Q/A は M1 どおり）。引用元が箇条書き項目・表・引用（`>`）・callout の中にある場合は、そのリスト・表・引用ブロック全体の直後に挿入する。
6. ID の重複検査（`existingCardIds`、`src/cards/parser.ts`）を `%%kioku-src:<id>` も数えるように広げ、カードを消したあとに残った引用記録の ID を再利用しない。
7. 純粋な計画関数 `planInsertion(text, recorded, card, cardId)` を `src/cards/` に置き、M1 の `planAdoption` と同様に単体テストで固定する。書き込みは `src/cards/writer.ts` の既存の経路（transaction / `Vault.process`）を共有する。

## 10. エラー処理

| 状況 | 振る舞い・表示 |
| --- | --- |
| AI 未設定（無効、provider 未選択、キー未入力） | 通信しない。明示 Q/A と決定的検査だけ。§8 の案内と「設定を開く」。 |
| 同意していない | 通信しない。「〈provider〉への外部送信に同意していません。設定で送信先とプライバシーを確認してから有効にしてください。」 |
| 認証失敗（401、Clef の認証エラー） | 再試行しない。「API キーが無効か期限切れです（〈provider〉）。」とキー発行場所の案内。キーの文字列は出さない。 |
| クレジット・無料枠不足 | 再試行しない。「利用枠が不足しています（〈provider〉）。」（status の対応は【未検証】） |
| 429 / 529 | `Retry-After` があれば従い、無ければ指数バックオフ（0.5 → 1 → 2 秒＋ジッター）で最大 3 回。合計がタイムアウトを超えるなら打ち切る。最終的に失敗した候補は「未判定」。 |
| 422・不正な応答（JSON が壊れている、選択肢が無い） | 再試行しない。生成なら「AI の応答を読み取れませんでした」で生成候補 0 件、判定なら該当候補を「未判定」。 |
| ネットワーク失敗（接続できない） | ローカルなら「〈URL〉に接続できません。Ollama などのサーバーが起動しているか確認してください。」、外部なら「〈ホスト〉に接続できません。」 |
| タイムアウト（判定 20 秒 / 生成 60 秒、設定可） | その呼び出しを打ち切り、届いた結果は残す。「時間内に応答がありませんでした（〈provider〉、N 秒）。」 |
| キャンセル | 未完了の呼び出しの結果を捨て、届いた候補と判定は残す（未判定は「未判定（キャンセル）」）。ポップアップを閉じる・プラグインの unload も同じ。 |
| 部分的な結果 | 候補ごとに独立して表示する。生成が失敗しても明示 Q/A は使える。判定の一部失敗は該当候補だけ未判定。 |

`requestUrl`（Obsidian 公開 API）には中断の手段とタイムアウト指定がない（§3.6）。そのためキャンセルとタイムアウトは「待つのをやめて結果を捨てる」で実装し、送信済みのリクエストはサーバー側で処理され得る（外部では課金され得る）ことをプライバシー文に書く（§7.2）。`requestUrl` は `throw: false` で status を受け取り、理由を出し分ける。

**取り残されたリクエストを積み上げない**：同時実行数（provider ごとに 4）の枠は、待つのをやめた時点ではなく、実際の `requestUrl` の Promise が解決・失敗した時点で返す。キャンセル直後に「再判定」や再実行をしても、取り残されたリクエストが枠を使っている間は新しいリクエストを送らず待つので、実際に飛んでいる数が上限を超えない。取り残されたリクエストの応答は、実行ごとの世代番号で古いものと判断して捨てる。

**応答しないサーバーで枠が埋まる場合**：枠は Promise が解決・失敗するまで返らないので、ローカルサーバーが固まると新しい実行が始められない。そのとき候補ポップアップには「前の要求の完了を待っています」と表示し、キャンセル（とポップアップを閉じる）は常に押せるようにする。`requestUrl`（Electron の下の通信）に下位のタイムアウトがあり、いずれ Promise が失敗して枠が返るかは【未検証】で、実装前に確かめる。単体テストでは、解決しない偽の `HttpClient` で枠を埋め、新しい実行が送られずに待ち表示になり、キャンセルが効くことを固定する。

## 11. 実測計画（「瞬時」と言う前に）

### 11.1 評価セット

- 日本語の学習ページ 20〜50 件（1 件 500〜4,000 字）。分野（医学・理科・社会・語学）、形式（段落、箇条書き、表、英語混じり、数式・コード混じり）を混ぜる。英語の対照ページを 5 件入れて Jev の言語差を測る。
- 本番 Vault は使わない。利用者が提供または承認したテキストだけを `test-vault/` 外のプロジェクト内の評価用フォルダ（コミットしない。`artifacts/lev-277/eval/`）に置く。個人情報・患者情報を含めない。**外部 provider への送信は評価セットについても利用者の同意を得てから行う**。
- 正解：各ページについて人が「カードにすべき事実と引用」を注釈する（2 人以上が望ましい。1 人なら注釈の基準を文書化）。

### 11.2 指標（provider の組み合わせごと）

| 指標 | 定義 |
| --- | --- |
| 採用候補の precision | 「推奨」に分類された候補のうち、人が「そのまま、または軽い編集で採用する」と判定した割合。 |
| 根拠なし候補の率 | 人の判定で「引用から答えられない」候補の割合（決定的検査で除外したもの・判定後に残ったもの、それぞれ）。 |
| 引用一致率 | 生成候補のうち、§6.1 の完全一致に合格した割合（生成モデルの品質の指標）。 |
| 判定の一致 | `supported` / `one_fact` と人の判定との一致（AUC、しきい値ごとの precision/recall）。しきい値（§6.2）はここから決める。 |
| 遅延 | p50 / p95：最初の候補の表示まで、全候補の判定完了まで、provider 呼び出し単体。日本語と英語の対照を分けて記録。 |
| 費用 | 1 ページあたりの入力トークン（実測）と費用（Jev、OpenAI、Clef の Neurons）。 |
| 認証 | 正しいキー・誤ったキー・未入力・同意なしの各経路で、期待どおりの表示になり、キーが記録に出ないこと。 |
| 外部の生成 API の比較 | §2.2 G1・G2 の候補（Groq、GPT-6 Luna、Cloudflare Workers AI、有料キーの Gemini）を、速度・日本語品質・費用・無料枠の上限（Groq は §3.5 の上限内で 1 ページを処理できるか）で比較する。送信は同意のうえで行い、料金は測定時に公式情報で確かめ直す。 |

### 11.3 報告の基準

- 測る組み合わせ：判定 {なし, Jev, Clef-flash, Clef, ローカル（サーバー種別ごと）} × 生成 {ローカル（候補モデル 2〜3 個）, 外部の生成 API（同意時。§2.2 の候補）}。測定した PC の構成（CPU/GPU/メモリ）を記録する。
- Q3 の目標値を満たした組み合わせだけを「瞬時」と呼ぶ。満たさない場合は数値（「約 N 秒」）で書く。
- 品質の目安（初期案）：推奨候補の precision ≥ 0.8、推奨に残った根拠なし候補 ≤ 5%、引用一致率 ≥ 0.9。Jev がこれを日本語で満たさない場合は Q4 に従って利用者に報告する。Q4 の「大きく下回る」（利用者に改めて相談する）しきい値は、ここで数値を決めず、最初の実測の結果から設定し、適用する前に利用者へ報告する。
- 実行は tooling の Node script（`scripts/` 配下、配布物に入らない）で行い、キーは環境変数から読み、結果（キーを含まない）を `artifacts/lev-277/eval/` に残す。runtime と同じ `src/ai/` の純粋ロジックを使い、通信だけ Node の HTTP に差し替える。

### 11.4 外部の生成 API を README で推奨する前の確認

- **Groq の個人 BYOK**：個人の利用者が自分の（無料の）Groq API キーを Obsidian から使うことが Groq の規約上認められるかを、Groq への問い合わせか明示的な記載で確かめる（§3.5 の Services Agreement は「not for consumer use」とし、当てはまり方が不明）。確認できるまで README では Groq を第一の推奨と書かず、「条件付きの候補」と注意を示す。確認できなければ推奨から外す（G1）。結果と根拠（問い合わせの回答や記載の URL）を `artifacts/lev-277/` に残す。
- **他の provider の BYOK**：GPT-6 Luna（OpenAI）、Cloudflare Workers AI、Gemini についても、個人の利用者が自分のキーを使う場合の扱いを確かめてから README で推奨する【要確認】。
- **Groq の ZDR**：Zero Data Retention の有効化手順（Data Controls）を案内できる形で確かめ、README と設定画面の案内に載せる。
- **Gemini**：案内文に無料枠の扱い（製品改善に使われる）と、Kioku が無料キーと有料キーを区別できないことが入っていることを確かめる。

## 12. モジュール境界（AGENTS.md に従う）

- runtime は公開 Obsidian API とブラウザ互換コードだけ。通信は Obsidian の `requestUrl` だけを使う（CORS の影響を受けず `http://localhost` にも届くため。`fetch` や Node/Electron の HTTP は使わない）。`requestUrl` を包む `HttpClient` は `src/ai/http.ts` に置き、それ以外の `src/ai/` は `HttpClient` を引数で受け取る純粋なコードにする（単体テストでは偽の `HttpClient`）。
- `src/main.ts` は登録と lifecycle だけ（変更は不要か、コマンド追加程度）。
- 提案する構成：
  - `src/ai/types.ts`、`src/ai/checks.ts`（決定的検査）、`src/ai/classify.ts`（分類としきい値）、`src/ai/prompts.ts`（生成・判定のプロンプト）、`src/ai/pipeline.ts`（生成 → 検査 → 判定、並列数・キャンセル・部分結果）、`src/ai/consent.ts`（外部判定〈接続先と cloud モデル〉・同意判定）。
  - `src/ai/providers/jev.ts`、`clef.ts`、`openai-compatible.ts`（local / openai / custom の生成の共通）、`local-judge.ts`（サーバー種別ごとの logprobs 判定。Ollama・llama.cpp・LM Studio）、`index.ts`（設定から factory）。
  - `src/cards/insertion.ts`（純粋な挿入計画。§9、Q2）。書き込みは既存の `src/cards/writer.ts` を拡張。
  - `src/store/settings.ts`：`schemaVersion` は 1 のまま、任意の `ai` セクションを足す（無ければ AI 無効の既定値）。現在の `parseSettings` は未知のキーを無視して読むので、M2 版の Kioku に戻しても既存設定と復習は動く。ただし M2 版が設定を保存すると `ai` セクション（API キーを含む）が消えるため、その旨を §15 に記す。現在の `parseSettings` と `SettingsStore.update` は既知の項目だけを残して未知のキーを捨てるので、M3 の実装では `ai` セクションを解釈・保持するよう両方を拡張し、M3 版自身の保存（トリガータグの変更など）で `ai` が消えないことを単体テストで固定する。
  - `src/ui/candidate-modal.ts`（生成候補・分類・進行表示・キャンセル）、`src/ui/settings-tab.ts`（AI セクション）、理由文は `src/ai/reasons.ts`（M1 の `reasons.ts` の方式）。
- 起動時にネットワーク・`data.json` に触れない規則（M0 から）を保ち、単体テストの起動時 I/O 禁止の変異検査に「`requestUrl` を呼ばない」を加える。
- runtime 依存は増やさない（JSON schema の検証も自前の小さな検証関数で行う）。

## 13. LEV-299（別 PoC、M3 には含めない）

プラグイン内の WebGPU/ONNX 推論（[Laya Multilingual](https://huggingface.co/convaiinnovations/laya-multilingual) など）で、外部サーバーなしに判定・生成できるかを LEV-299 で別に試す。結果が良ければ、§5.1 の `DecisionProvider` / `GeneratorProvider` を実装する provider として追加する（M3 のインターフェースはそれを妨げない形にしておく）。モデルの配布サイズ、`main.js` 以外のファイルの扱い、メモリ、日本語の品質は LEV-299 で評価する。

## 14. 実機確認チェックリスト（案。実装時に `docs/harness.md` へ反映）

実機は LEV-279 の専用インスタンス（`harness:launch` / `harness:quit`）だけ。本番 Vault は使わない。mock・CDP 模擬・preflight・評価 script の成功を実機成功と呼ばない。`artifacts/lev-277/` に baseline、screenshot、操作前後のノート bytes、通信の記録（送信先と文字数。キーと本文は残さない）を残す。

1. 起動直後と設定タブ・候補ポップアップを開いただけでは、ネットワーク通信もノート・`data.json` の書き込みも起きない（smoke と通信の記録）。
2. AI 無効（既定）：抽出で明示 Q/A と決定的検査の注意だけが出て、AI 未設定の案内と「設定を開く」が表示される。通信なし。
3. AI を有効にすると判定 provider が Jev になっているが、キー未入力・同意なしでは Jev に通信しない。生成が未設定なら「AI で候補を作る」で通信せず理由が表示される。生成（ローカル）だけ設定してあれば、Q8 の決定どおり生成は進み、候補が「未判定（Jev 未設定）」になる。判定 provider に「判定なし」を選んでも生成できる。
4. ローカル（Ollama）を生成に設定：日本語ノートから候補が出て、引用が原文に強調表示され、引用が原文に無い候補は除外件数として表示される。固定枚数にならない（根拠の少ないノートでは 0〜1 件）。
5. ローカル判定（logprobs。Ollama・llama.cpp・LM Studio のうち用意できたサーバー種別ごと）・Jev・Clef（同意後）それぞれで分類バッジと理由が出る。Jev の同意前後で送信先表示が正しい。
6. 生成候補の採用（Q2）：引用元のブロックの直後に Q/A・`^kioku-…`・`%%kioku-src%%` が挿入され、原文の文字は変わらない。Reading view で ID と引用記録が見えない。M2 のデッキに New として入る。Undo で1回で戻る。
7. 採用前に引用元を外部で変更・複製すると、書かずに理由が表示される。Canvas ガード、ディスク確認、回復は M1 と同じに動く。
8. 誤った API キー（401）、ローカルサーバー停止（接続失敗）、タイムアウト（短く設定）、生成中・判定中のキャンセル、ポップアップを閉じる、それぞれで理由が表示され、届いた結果は残り、ノートは変わらない。Notice・console・`artifacts/` にキーが出ない。
9. 429 の再現が難しい場合は単体テストで固定したことを記録し、実機では NOT TESTED と明記する。
10. 設定の移行：M2 の `data.json`（schemaVersion 1）から起動して設定タブを開くと、既存設定が保たれ、AI が無効の状態で表示される。
11. **cloud モデル**：Ollama で `:cloud` / `-cloud` のモデルを選ぶと、`localhost` でも「外部」と表示され、同意がなければ送らない（Q6）。同意後は送信前の表示に外部送信先が出る。ローカルのサーバーが中継し得る旨の注意が設定画面とプライバシー文にある。
12. **応答しないサーバー**：ローカルサーバーを応答しない状態にして実行し、キャンセル後にもう一度実行すると「前の要求の完了を待っています」と表示され、キャンセルとポップアップを閉じる操作が効く。取り残されたリクエストが最終的に失敗して枠が返るか（下位のタイムアウトの有無）を記録する。
13. **外部の生成 API の案内**：設定画面に Groq（条件付きの候補と注意、ZDR の案内）、GPT-6 Luna、Cloudflare Workers AI、有料キーの場合だけの Gemini（無料枠は製品改善に使われる旨と、無料・有料を区別できない旨）の案内が出る。各社の BYOK の扱いが【要確認】のまま README で推奨していないこと（§11.4）。
14. 遅延：§11 の目標をこの PC で満たすかを、実機の候補ポップアップで（評価 script とは別に）数回計測して記録する。

## 15. リスク

- **日本語の判定精度**：Jev は CJK で精度が低いと公表、Clef は日本語の性能が不明。§11 で測る前に品質を約束しない。
- **ローカル生成の遅延と品質**：PC の性能・モデル次第で「瞬時」にならない可能性が高い。数値で報告する。
- **引用の完全一致が厳しすぎる**：生成モデルが空白や記号を変えると除外が増える。正規化の範囲は §11 の引用一致率で調整する（範囲を広げすぎると根拠のない候補が通る）。
- **API キーの平文保存**：§7.3。
- **古い版での設定保存**：M3 から M2 版の Kioku に戻して設定を保存すると、`data.json` の `ai` セクション（キーと同意）が消える。再設定が必要になる旨を README に書く。
- **キャンセルしても送信済み**：`requestUrl` は中断できない（§3.6）。課金・処理はサーバー側で続き得る。
- **ローカルのつもりの外部送信**：Ollama の cloud モデルや、外部へ中継するローカルサーバー。名前の規則と `/api/show`【要検証】で判別できる範囲だけ外部扱いにでき、中継は検出できないので、表示で注意する（§5.1、§7.2）。
- **外部サービスの仕様・料金の変化**：Jev は登録再開直後でクレジット施策も変わっている。Clef の Workers AI 提供は 2026-10-01 開始。実装前に §3 を再確認する。
- **生成カードの挿入による本文の変化**：Q2 の決定（引用元の直後に挿入）で、採用が多いとメモの読みやすさを損なう。
- **プロンプトインジェクション**：ノート本文（他人から貰ったメモなど）に指示文があっても、出力は JSON 検証と引用の完全一致で縛り、採用は人が行う。AI の出力でノートを書き換える経路は採用ボタンだけ。
- **外部の生成 API の規約**：Groq の規約が個人の BYOK に当てはまるかが不明（§3.5）。他社も個人の BYOK の扱いは未確認。Gemini の無料キーを使われると送信内容が製品改善に使われ得るが、Kioku は区別できない。
- **範囲の膨張**：エージェントへのルーティング等は範囲外（§0.2）。

## 16. 実装状況（フェーズ A、2026-10-02）

LEV-277 は複数の PR に分けて実装する。この節はフェーズ A（最初の PR）で実装したこと・設計から変えたこと・残りを記録する。**実機（§14）と実測（§11）はどちらも未実施。** 単体テストは偽の `HttpClient` / `Clock` だけを使い、実在の AI サービス・Ollama には接続していない。

### 16.1 実装したこと

| 範囲 | 実装 | 主なファイル |
| --- | --- | --- |
| §5.1 provider 抽象 | `DecisionProvider` / `GeneratorProvider`、結果型（例外を外に出さない）、`HttpClient`（`requestUrl` を `throw: false` で包む）と `Clock` の注入。 | `src/ai/types.ts`、`src/ai/http.ts` |
| §10 通信の制御 | 同時実行枠は実際の `requestUrl` が解決・失敗するまで返さない。タイムアウト・キャンセルは「待つのをやめる」。429 / 529（と 503）は `Retry-After` か 0.5 → 1 → 2 秒＋ジッターで最大 3 回、タイムアウトを超えるなら打ち切り。枠が埋まっていれば「前の要求の完了を待っています」。 | `src/ai/call.ts` |
| §4 送る本文 | M1 の除外領域を行ごとに除き、残りの行から行内の `%%…%%`・`<!--…-->` を除く。元の offset への対応表を持つ。ノート名・パス・Vault 名は送らない。8,000 字超は範囲の選択を求める。Excalidraw ノートは対象外。 | `src/ai/source.ts` |
| §6.1 決定的検査 | 引用の完全一致（NFC・空白の正規化、除外部分の境界と空行をまたぐ一致は不一致、元の offset に戻して確認）、答えが引用に含まれるか、重複（採用済みと同じなら非表示、候補同士・明示 Q/A と同じなら先を残す）、長さ、1枚1知識の簡易判定、構文。上限 20 件（目標ではない）。0 件も正常な結果。明示 Q/A にも長さ・1枚1知識の注意を出す。 | `src/ai/checks.ts` |
| §5.5 生成 | ローカルの OpenAI 互換 `/v1/chat/completions`（Ollama・llama.cpp・LM Studio の接続先の既定値）。`response_format` に JSON schema を付け（各サーバーの対応は【未検証】）、応答は Kioku が検証する。cloud モデル（`:cloud` / `-cloud`）と非 loopback の接続先は外部扱いで同意が要る（Q6）。 | `src/ai/providers/local.ts`、`src/ai/prompts.ts` |
| §5.3 判定 | Jev systemone（4 問、`quality` は §6.2 の rubric）。`noul` の confidence は Kioku 側で導く。判定なし（`none`）。Jev が未設定・未同意なら生成を進め「未判定（Jev 未設定）」「未判定（Jev への送信に未同意）」（Q8）。 | `src/ai/providers/jev.ts` |
| §6.2 分類 | 推奨 / 要確認 / 未判定 / 根拠が弱い（初期しきい値）。応答が不完全なら推奨にせず未判定。 | `src/ai/classify.ts` |
| §7 同意 | 同意は provider ごとに「送信先・サーバー・モデル」の指紋で保存し、変えたら取り直し。外部が含まれる実行は、送信先・本文の文字数・概算費用を表示し「送信して作る」を押すまで送らない（E2）。押した時点で設定と本文を読み直し、変わっていれば表示を更新してもう一度押してもらう。 | `src/ai/settings.ts`、`src/ai/pipeline.ts`、`src/ui/candidate-modal.ts` |
| §7.3 キー | `data.json` の `ai.providers.jev.apiKey`（平文。設定画面とプライバシー文にリスクを表示）。入力欄は password、保存済みは末尾 4 文字だけ（12 文字未満なら何も出さない）。理由文は status とサービス名だけ（応答本文・ヘッダーは出さない）。 | `src/ui/ai-settings.ts`、`src/ai/reasons.ts` |
| §8 UI | 候補ポップアップの「AI の候補」欄：未設定の案内、送信前の表示、「生成中…（N 秒）」、判定の途中経過、キャンセル（常に押せる）、分類バッジと理由、引用、挿入される行の事前表示、根拠が弱い候補は末尾に折りたたみ（E1）。設定タブの AI セクション。状態ポップアップの実装状況。 | `src/ui/candidate-modal.ts`、`src/ui/ai-settings.ts`、`src/ui/startup-modal.ts` |
| §9 挿入 | `planInsertion`：引用元ブロック（箇条書きは空行をまたいで全体、表・`>` 引用・callout は全体）の直後に、空行・Q/A＋`^kioku-<id>`・空行・`%%kioku-src:<id>`〜`%%`（＋次が空行でなければ空行）。原文の文字は変えない。M1 と同じ書き込み経路（Canvas ガード、原文照合、editor transaction / `Vault.process`、ディスク確認、1回の回復）を共有。`existingCardIds` は `%%kioku-src:` も数える。 | `src/cards/insertion.ts`、`src/cards/writer.ts` |
| §12 設定 | `data.json` の任意の `ai` セクションを `parseSettings` が解釈し、`SettingsStore.update`（トリガータグの変更など）でも保持。`ai` の無い M2 の `data.json` は AI 無効として読む。 | `src/store/settings.ts` |
| §12 起動時 | 起動時に `requestUrl` を呼ばないことを変異検査で固定。 | `tests/ui/startup.test.mjs` |

### 16.2 設計から変えた・決めたこと

- **生成の同時実行は接続先ごとに 1 件**（判定は provider ごとに 4 件のまま）。1 回の実行で生成の呼び出しは 1 回なので、応答しないサーバーに取り残された要求が 1 件あれば次の実行は待ち表示になる（§10 の「前の要求の完了を待っています」）。
- **「設定を開く」ボタンは作らない**：特定のプラグイン設定タブを開く公開 API が無いため（AGENTS.md：公開 API だけ）。案内文で「設定 → Kioku → AI」と場所を示す。
- **表の直後に続く文の行**は GFM では表の一部として扱われるので、空行までを1つのブロックとし、その後に挿入する。
- **選択範囲で抽出した後にノートが変わった**場合は、選択範囲を特定できないので AI 実行を断り、再抽出を求める（ノート全体の場合は読み直した本文で送信前の表示を作り直す）。
- **Jev の概算費用**は 1 候補 ≈ 2,000 トークンとして「1 件 $0.00008、最大 20 件で $0.0017」と表示する（日本語のトークン数は【未検証】）。
- 生成候補の重複判定は「正規化した問いと答えの両方」が一致したとき。
- **挿入先のブロック**：ATX 見出しと区切り線は単独のブロックとし、直前のブロックを終える（別の節の編集で採用が「原文が変更されています」にならず、カードは次の見出しの前に入る）。文の直下の `===` / `---`（setext 見出し）はその行と同じブロック。
- **cloud モデルの名前の規則**（`:cloud` / `-cloud`）はサーバーの種類によらず適用する（別のサーバーが Ollama へ中継し得るので、外部寄りに倒す）。接続先 `0.0.0.0` も外部扱い（すべてのアドレスで待ち受ける指定で、このパソコンだと Kioku が確かめられないため）。
- **接続先の URL** はホストとポートまで。`/v1` などのパスは設定画面で理由を示して受け付けない（Kioku が endpoint のパスを付けるので `/v1/v1/…` になるため）。`data.json` にパス付きの値があれば既定値として読む。
- **応答しない要求の枠**：`requestUrl` は取り消せないので、解決も失敗もしない要求は plugin を再読み込みする（無効化→有効化、または Obsidian の再起動）まで枠を持ち続ける。その間は生成・判定とも「前の要求の完了を待っています」と表示し、キャンセルは押せる。枠が空いて実際に送った時点で表示は「生成中…（N 秒）」に戻り、秒数とタイムアウト（再試行の予算を含む）はその送信時刻から数える（待った時間は数えない）。
- **Jev の score**：公式の例（`"score": 1.05`、`legend`・`probabilities` のキーは `"0"`, `"1"`, …）のとおり、0 始まりの段階を確率で重み付けした連続値として受け付ける（§5.1）。`quality` の答えが壊れていても、判定全体は失敗にしない。
- **Ollama では思考を止める**（`reasoning_effort: "none"`）。docs.ollama.com/api/openai-compatibility によれば、真偽値で思考を切り替えるモデルでは `think: false` に対応付けられる。ほかのモデルでの挙動は確かめていない。実測は gemma4:26b だけ。実測は 2026-10-03、Ollama 0.34.2・gemma4:26b・合成ノート（約 520 字）で、プロンプト・JSON schema・temperature 0.2 は Kioku と同じ（記録は `artifacts/lev-277/timeout-investigation/RESULTS.md`。`artifacts/` はコミットしない手元の記録）。
  - 既定（思考あり）：最初の本文まで 125〜158 秒、全体で 180〜307 秒。Kioku と同じ要求そのままでは 300 秒を超えた。
  - 思考を止めた場合、製品と同じ OpenAI 互換の経路（`reasoning_effort: "none"`）で有効だった計測は 45.5 秒（R6、load 83、再読み込みを含む）、66.6 秒（R9、load 267）、95.6 秒（R10、load 260）。R7（31.6 秒）は出力の上限で JSON が切れた無効な結果。負荷が低いときの読み込み済みの計測はしていない。
  - 31〜48 秒（load 8〜66）は Ollama 独自の API（`/api/chat`、`think: false`）での計測（R1・R2・R4・R5）で、製品の経路ではない。いずれの計測でも、候補 6〜9 件はすべて引用が一致した。
  - **既定の 60 秒以内に安定して終わることは確かめられていない**（負荷が高いと超える）。タイムアウトとモデルの扱いは利用者が決める。
  - 出力の上限（`max_tokens`）は付けない。JSON が途中で切れて候補 0 件になるため。
  - コンテキスト長（262144 と 8192）と JSON schema の有無は、速度に差がなかった。
  - llama.cpp・LM Studio には対応する指定を確かめていないので付けない。
  - サーバーがこの指定を拒んだ HTTP 400（応答本文が reasoning の指定についてのもの。本文は表示しない）の場合だけ、予算の残りで指定なしにもう一度だけ送る。残りが無いときと、キャンセルされたときは送らない。ほかの理由の 400 は送り直さない（外部のモデルに本文を二度送らないため）。時間切れの表示は、2 回目の要求でも設定したタイムアウトの秒数にする。
- **実行ボタンの二重押し**：押した時点で（送信内容の確認より前に）ボタンを無効にし、送信は1回だけ。

### 16.3 未実装（後続の PR）

- Clef（§5.4）、ローカルの logprobs 判定（§5.5。Ollama / llama.cpp / LM Studio の endpoint ごと）。
- `openai` / `custom` の生成（§5.6）と、G1・G2 の外部の生成 API の案内（Groq・GPT-6 Luna・Cloudflare Workers AI・有料キーの Gemini）。いまは接続先を非 loopback にしたローカル生成が外部扱いになるだけで、API キーは送らない。
- 設定タブの「接続テスト」、ポップアップの「再判定」、引用のクリックでノートの該当位置へ移動。
- `/api/show` による cloud モデルの判別（【要検証】のまま。名前の規則だけ）。
- `requestUrl` の下位タイムアウトの有無（§10【未検証】。無ければ上記のとおり再読み込みまで枠が残る）。
- §11 の実測（品質・遅延・費用）と README での推奨モデル、§14 の実機確認と `docs/harness.md` への反映。

### 16.4 実装済み（Phase A とその後の PR）

- §5.1 provider 抽象、§10 通信制御、§4 送る本文、§6.1 決定的検査、§5.5 ローカル生成、§5.3 Jev 判定構造、§6.2 分類、§7 同意フロー、§7.3 API キー保存、§8 UI（候補ポップアップ、設定タブ）、§9 生成カード挿入、§12 設定の読み書き。
- 設定タブの Jev モデル名とタイムアウト（生成・判定）の設定欄。バックエンドは `data.json` の `ai.providers.jev.model` / `ai.timeouts.generateSeconds` / `ai.timeouts.judgeSeconds` を読み書きする。

### 16.5 実機確認で見ること（フェーズ A 固有）

- 引用元の段落の最終行に既存の block ID（`^abc`）がある場合、引用にそれが含まれると `%%kioku-src%%` の中に `^abc` が写る。`%%` コメント内の block ID を Obsidian が block として索引しないか（元の段落へのリンクが変わらないか）を確かめる（コードの挙動は変えていない）。
- §14 のチェックリスト全体。
