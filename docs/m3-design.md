# M3（LEV-277）設計：AI による候補の判定と生成

> **状態：設計案・実装前。** この文書は LEV-277 について 2026-10-02 に利用者が決めたこと（§1）と、それに沿った設計案をまとめたもの。§2 の「利用者に確認したいこと」は未決定で、決まるまで実装しない。**M3 のコードはまだ無く、AI による候補作成・判定は使えない。** 「瞬時」という表現は §11 の実測が終わるまで使わない。
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
- Gemini（§1 S4）。
- Obsidian のタスクを Claude/Codex などのエージェントへ振り分ける仕組み（利用者の広い構想）。provider の抽象は後で再利用できる程度に汎用にするが、ルーティングは作らない。
- Vault 全体の一括生成、PDF/OCR、画像、Cloze、双方向カード、モバイル。
- 永続的な見送り記録（M1 と同じく「破棄」はポップアップから外すだけ）。

## 1. 決定事項（2026-10-02 利用者決定：決定ボードとチャット）

| # | 決定 | 設計への反映 |
| --- | --- | --- |
| S1 | **外部送信は既定 OFF**。ローカル優先（Ollama など）を案内する。 | 外部に送る provider は、API キーの設定と provider ごとの明示的な同意の両方がそろうまで使わない（§7）。 |
| S2 | **AI 未設定のときは決定的な検査だけ**を行う（引用が原文に完全一致するか、答えが引用に含まれるか、重複、長さ・1枚1知識の簡易判定）。AI による Q/A 生成は AI provider を設定したときだけ。UI は理由と設定方法を説明する。 | 決定的検査は常に走る（§6.1）。AI 未設定では生成ボタンの代わりに「AI が未設定のため…」と設定への案内を出す（§8）。 |
| S3 | provider として **Clef（Cloudflare Workers AI、利用者自身のアカウント）と Jev（TypeSafe AI）の両方**を入れる。 | §5.3・§5.4。 |
| S4 | **Gemini は使わない**。 | provider 一覧に入れない。 |
| S5 | プラグイン内の WebGPU/ONNX 推論（Laya Multilingual を含む）は **別 PoC：LEV-299**。M3 には含めない。 | §13。 |
| 範囲 | M3 はフラッシュカード候補の**判定と生成だけ**。エージェントへのルーティングは範囲外。 | §0.2。 |
| 構成 | **provider 方式の Decision Engine**（判定モデルを差し替え可能）。**既定の AI 判定 provider は Jev**。 | 「AI を有効にしたとき Jev があらかじめ選ばれている」と解釈する。Jev は API キーを設定し外部送信に同意した後だけ使う（S1 と両立）。何も設定していなければ決定的検査だけ。 |
| 生成 | Jev/Clef は判定するだけで文章を書けないため、要約 → Q/A には**別の Generator provider** が必要。 | ローカルの OpenAI 互換サーバー（Ollama ≥0.12.11 / LM Studio の GGUF / llama.cpp）か、同意のうえで OpenAI/カスタム。推奨の既定は §2 Q1 で確認する。 |

## 2. 利用者に確認したいこと（未決定）

推奨は設計者の案。決まるまで該当部分は実装しない。

| # | 確認したいこと | 推奨 | 理由 |
| --- | --- | --- | --- |
| Q1 | **既定の Generator provider** | **ローカルの OpenAI 互換（Ollama）を既定**にし、モデル名は固定せず、§11 の実測で日本語の品質と遅延が良かった 1〜2 個を README で推奨する。外部の OpenAI/カスタムは同意した場合だけの選択肢。 | S1（ローカル優先）と一致し、追加費用がない。Ollama は logprobs（v0.12.11+）にも対応するので、同じサーバーでローカル判定もできる。ただし PC の性能で遅延が大きく変わるため、「瞬時」は実測後に判断する。 |
| Q2 | **生成カードをノートのどこに保存するか** | **(A) 引用元のブロック（段落・箇条書き）の直後**に、M1 と同じ形の `Q:`/`A:` ブロック＋ `^kioku-<id>` と、引用の記録 `%%kioku-src:<card-id> … %%` を挿入する。代案 (B) ノート末尾の `## Kioku` 見出しの下にまとめる、(C) 別ノートに保存。 | (A) は根拠の近くにカードがあり、原文の移動・編集と一緒に動き、採用時の原文照合も局所的にできる。(B) は本文を乱さないが、見出しを足して構造を変え、引用元から離れる。(C) は元メモ内に保存する M1 の方針（製品計画）と合わない。 |
| Q3 | **「瞬時」の目標値** | 2,000 字程度の日本語1ページで、**最初の候補の表示まで p50 ≤ 3 秒、全候補（判定込み）p95 ≤ 10 秒**を目標とし、満たした provider の組だけを「瞬時」と報告する。 | 受入条件が実測を求めている。数値の合意がないと「瞬時」と言えるかを判断できない。 |
| Q4 | **Jev の日本語精度が実測で基準に届かない場合** | 既定の判定 provider を Jev のままにし、設定画面と README に実測値と「日本語では精度が下がる」注記を出す。基準（§11.3）を大きく下回る場合は、既定を Clef またはローカル判定へ変えることを利用者に再確認する。 | Jev は主に英語で学習され CJK の精度は低いと公式が述べている。既定は利用者決定なので、変更は実測を見てから利用者が決める。 |
| Q5 | **API キーの保存先** | M3 は**プラグインの `data.json` に保存**し、§7.3 のリスクを設定画面と README に明記する。Obsidian の秘密情報保存 API【未検証】が `minAppVersion` を上げずに使えると確認できたら、そちらへ移すかを再確認する。 | 公開 API だけで確実に動く方法が `data.json`。秘密情報 API は対応版・挙動を未確認で、`minAppVersion`（1.8.7）を上げる判断が要る。 |
| Q6 | **AI が「根拠が弱い」と判定した候補の見せ方** | 削除せず、一覧の末尾に折りたたんで「AI が根拠が弱いと判定（N 件）」と表示し、開けば採用もできる。 | 判定は確率で、日本語では誤りもある。AI 判定で黙って捨てない。決定的な引用不一致（§6.1）だけは捨てる。 |
| Q7 | **1回で送る量の上限と費用の表示** | 1回はノート1つ（選択範囲があればそこだけ）、本文 8,000 字を超えたら範囲の選択を求める。外部 provider では送信前に「送信先・文字数・概算費用」を表示する。 | 遅延と費用を予測可能にし、意図しない大量送信を防ぐ。上限値は実測で調整する。 |

## 3. 調査で確認した事実（出典）

2026-10-02 時点。実装前に再確認し、変わっていれば本書を更新する。

### 3.1 Jev（TypeSafe AI）

| 事実 | 出典 |
| --- | --- |
| 一般の新規登録が 2026-09-27/28 に再開。新規ユーザーへの $5 クレジットは停止中で、無料枠はない。 | [AI Front Page](https://aifront-page.com/typesafe-ai-reopens-jev-sign-ups-free-credit-suspended/) |
| API キーは `console.typesafe.ai/keys` で発行。OpenRouter（`typesafe/jev-1.13`）と Vercel AI Gateway からも使える。 | [Quickstart](https://docs.typesafe.ai/introduction/quickstart.md), [OpenRouter](https://openrouter.ai/docs/guides/community/jev) |
| 料金：入力 $0.042 / 100 万トークン、出力は無料。 | [Models](https://docs.typesafe.ai/models.md) |
| `POST https://api.typesafe.ai/v1/systemone`、Bearer 認証。本文 `{ model: "jev-latest", state, questions: { <key>: { type, instructions, criteria? } } }`。 | [API](https://docs.typesafe.ai/api.md) |
| 型：`noul`（0〜1 の値）、`choice`（選択肢 ≤255、確率と confidence）、`score`（2〜10 段階）。 | [API](https://docs.typesafe.ai/api.md) |
| エラー：401（認証）、422（不正なリクエスト）、429（レート制限。バックオフする）、529（過負荷）。 | [API](https://docs.typesafe.ai/api.md) |
| 上限：1リクエスト 64k トークン（state と最も長い question の合計は ≤32k）、40 リクエスト/秒。 | [API](https://docs.typesafe.ai/api.md) |
| 主に英語で学習され、CJK の精度は低い（要検証と明記）。 | [Models](https://docs.typesafe.ai/models.md) |
| 利用者データで学習しない。DPA あり。ゼロデータ保持（ZDR）は営業経由。 | [Legal](https://docs.typesafe.ai/legal.md) |

【未検証】クレジット不足時の HTTP status と本文、応答の正確な JSON 形（`value` / `probabilities` / `confidence` の位置）、`criteria` の効き方、日本語の state・instructions での精度。いずれも §11 の実測と単体テストの fixture 作成時に確かめる。

### 3.2 Clef（Cloudflare）

| 事実 | 出典 |
| --- | --- |
| `Cloudflare/clef`（27B）と `clef-flash`（9B）、Apache-2.0。typed decision（bool / choice / score を logits で返す）。 | [Hugging Face](https://huggingface.co/Cloudflare/clef), [Cloudflare blog](https://blog.cloudflare.com/clef-decision-models/) |
| Workers AI で `@cf/cloudflare/clef` / `@cf/cloudflare/clef-flash` として提供（2026-10-01）。 | [Changelog](https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/) |
| Workers AI はアカウントごとに 1 日 10,000 Neurons まで無料。 | [Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| ローカル実行は現実的でない（サイズ）。日本語の性能は不明。 | [Hugging Face](https://huggingface.co/Cloudflare/clef) |

【未検証】Workers AI REST での入力・出力スキーマ、1 判定あたりの Neurons 消費、日本語での精度、エラー status。

### 3.3 ローカルの OpenAI 互換サーバーで logprobs による判定

| 事実 | 出典 |
| --- | --- |
| Ollama v0.12.11 から logprobs に対応（`top_logprobs` ≤20）。 | [Ollama v0.12.11](https://newreleases.io/project/github/ollama/ollama/release/v0.12.11) |
| llama.cpp server は `n_probs` で上位トークンの確率を返す。 | [llama.cpp server README](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md) |
| LM Studio は `/v1/responses` で `top_logprobs` を返す（MLX runtime では非対応）。 | [LM Studio blog](https://lmstudio.ai/blog/openresponses) |

判定の作法（上記の仕様から導いた設計）：選択肢を 1 トークンの ASCII ラベル（`A` / `B`、`1`〜`5`）にし、`max_tokens: 1`、`temperature: 0` で上位の logprobs を取り、選択肢のトークンだけで確率を正規化する。

【未検証】日本語モデルのトークナイザで ASCII ラベルが 1 トークンになるか（モデルごとに確認）、各サーバーの JSON schema 出力（`response_format` / `format`）の対応。

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
- **要約の段階**：Generator にはまず本文から「1つの事実＋それを支える原文の引用」の列（要約）を作らせ、各事実から問い・答えを作らせる。M3 では 1 回の呼び出しで JSON（§5.2 の `GeneratedCandidate[]`）として返させ、2 回に分けた方が品質が良いと §11 で分かれば分ける。
- **枚数**：プロンプトでも検査でも枚数を固定しない。「根拠のある事実がなければ 0 件でよい」と明示し、上限は誤動作の歯止めとして 1 ページ 20 件だけ置く（超えた分は捨てて件数を表示）。
- **送る本文の作り方**：M1 の `classifyLines` が除外するのは行単位の領域だけで、1行の中で閉じる `%%…%%`・`<!--…-->`・`$$…$$` は普通の行として残る。外部に送らないと約束するため、送る前に除外領域の行（`kind !== null`）を取り除き、残りの行からも行内の `%%…%%` と `<!--…-->` を取り除く（インラインコードは学習内容になり得るので残す）。取り除いた位置は元の offset への対応表で管理する。
- 明示 Q/A（M1）は AI の有無にかかわらず従来どおり出し、決定的検査の重複・長さの注意を付ける。明示 Q/A には AI 判定を既定では走らせない（人が書いたものなので。後続で選択可能にする余地は残す）。

## 5. Provider

### 5.1 インターフェース（実装時に確定する型のスケッチ）

`src/ai/` は Obsidian に依存しない純粋な型とロジック、通信は注入する `HttpClient` を通す（§12）。

```ts
// src/ai/types.ts
export type DecisionType = 'noul' | 'choice' | 'score';

export interface DecisionQuestion {
  readonly type: DecisionType;
  readonly instructions: string;
  readonly criteria?: string;
  readonly options?: readonly string[]; // choice only (≤255)
  readonly levels?: number;             // score only (2–10)
}

/** Shaped like Jev systemone; other providers normalize into it. */
export interface DecisionResult {
  readonly value: number | string;      // noul: 0–1, choice: option, score: level
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
  readonly external: boolean;           // true unless the endpoint host is loopback
  readonly endpointHost: string;        // shown in consent and run header
}

export interface DecisionProvider extends ProviderInfo {
  decide(state: string, questions: Readonly<Record<string, DecisionQuestion>>,
    signal: AbortSignal): Promise<ProviderOutcome<Readonly<Record<string, DecisionResult>>>>;
}

export interface GenerationInput {
  readonly noteName: string;
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
- `external` は provider の種類でなく**接続先**で決める。`local` でも接続先が `localhost` / `127.0.0.1` / `::1` 以外（LAN の別 PC など）なら外部扱いで同意が要る。

### 5.2 provider 一覧

| id | 役割 | 外部送信 | 既定 | 備考 |
| --- | --- | --- | --- | --- |
| `deterministic` | 検査（判定の前段） | なし | 常に有効 | §6.1。provider と同じ結果型で理由を返すが、確率は持たない。 |
| `jev` | 判定 | あり | **AI を有効にしたときの既定の判定 provider** | API キー＋同意後だけ。§5.3。 |
| `clef` | 判定 | あり（Cloudflare） | — | 利用者自身の Cloudflare アカウント ID と API トークン。§5.4。 |
| `local` | 判定（logprobs）＋生成 | なし（loopback のとき） | Q1 で確認（推奨：生成の既定） | Ollama / llama.cpp / LM Studio。§5.5。 |
| `openai` | 生成 | あり | — | 同意後だけ。§5.6。 |
| `custom` | 生成（OpenAI 互換） | 接続先しだい | — | 任意の base URL。§5.6。 |

判定と生成は別々に選ぶ（例：判定 Jev ＋ 生成ローカル、判定ローカル ＋ 生成ローカル）。生成が未設定なら AI 生成は行わず、判定だけ設定されていても明示 Q/A には既定で判定を走らせない（§4）。

### 5.3 Jev

- `POST https://api.typesafe.ai/v1/systemone`、`Authorization: Bearer <key>`、`model: "jev-latest"`（設定で変更可）。
- 候補 1 件につき 1 リクエスト。`state` は「引用＋前後の文脈（§4 で除外領域と行内コメントを取り除いた本文から最大 1,500 字）＋候補の問い・答え」、`questions` は §6.2 の 3〜4 問。小さい state で並列に送るので、上限（64k / 32k トークン、40 req/s）に余裕があり、途中経過を候補ごとに表示できる。同時実行は 4 件まで。
- 費用は入力トークンだけ（出力無料）。1 候補 ≈ 1,000 トークンとして 1 ページ 10 候補で約 1 万トークン ≈ $0.0004【未検証：日本語のトークン数】。
- 401 → 認証失敗（キーの発行場所 `console.typesafe.ai/keys` を案内）、422 → 不正なリクエスト（再試行しない。サイズ超過なら範囲を狭める案内）、429・529 → バックオフ（§10）。
- OpenRouter / Vercel AI Gateway 経由は M3 では作らない（経路を1つにして検証範囲を絞る）。必要になれば同じ `DecisionProvider` で追加できる。

### 5.4 Clef

- Workers AI の REST（アカウント ID と API トークン）で `@cf/cloudflare/clef-flash`（既定、速さ優先）または `@cf/cloudflare/clef` を呼ぶ。入出力スキーマは【未検証】のため、実装前に公式ドキュメントで確定し、bool → `noul`、choice → `choice`、score → `score` に正規化する。
- 無料枠（1 日 10,000 Neurons）を超えた場合の status を `quota` に対応付ける（【未検証】）。

### 5.5 ローカル OpenAI 互換（Ollama / llama.cpp / LM Studio）

- 設定：base URL（既定 `http://localhost:11434/v1`）、サーバー種別（Ollama / llama.cpp / LM Studio）、生成モデル名、判定モデル名（同じでも可）。
- **生成**：chat completions に JSON schema 付きの出力を要求し（サーバーごとの方式は【未検証】。使えなければ JSON をプロンプトで指示して検証で弾く）、`temperature` は低め（0.2）。
- **判定**：§3.3 の作法。`noul` は「A=はい / B=いいえ」の 2 択で `P(A)` を値に、`score` は `1`〜`5` のラベルで期待値を値、最大確率を confidence にする。選択肢トークンが上位 logprobs に1つも無い場合は `invalid-response`（未判定）。
- 接続テストで (1) モデル一覧に指定モデルがあるか、(2) 1 トークンの判定で logprobs が返るか、を確かめる。logprobs が返らない（古い Ollama、LM Studio の MLX runtime など）場合は「このサーバーでは判定に使えません（生成には使えます）」と表示する。

### 5.6 OpenAI / カスタム（生成）

- OpenAI 互換の chat completions。API キー、モデル名、カスタムは base URL。外部（非 loopback）なら同意が要る。
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
| `quality` | `score`（5 段階） | 学習カードとしての有用さ（M3 では表示順の参考だけに使う）。 |

分類（しきい値は §11 で決める。初期値）：

- **推奨**：決定的検査に要確認がなく、`supported ≥ 0.8`、`answerable ≥ 0.7`、`one_fact ≥ 0.7`。
- **要確認**：推奨にも根拠が弱いにも当たらないもの。理由（どの検査・どの判定が低いか、confidence が 0.6 未満なら「AI の確信度が低い」）を候補に表示する。
- **根拠が弱い**：`supported < 0.3`（要確認より優先）。Q6 の推奨どおり折りたたんで表示（削除しない）。
- **未判定**：判定が失敗・タイムアウト・キャンセル。決定的検査の結果だけで表示する。

**自動採用はしない**（推奨でも人が「採用」を押す）。表示順は 推奨 → 要確認 → 未判定 → 根拠が弱い、同じ分類内は原文の出現順。

## 7. 外部送信と同意（S1）

### 7.1 規則

- 既定は AI 無効（`ai.enabled = false`）。有効にすると判定 provider に Jev が選ばれた状態になるが、API キーと同意がそろうまで Jev には送らない。
- 同意は provider ごと（`jev` / `clef` / `openai` / `custom`、非 loopback の `local`）に、設定タブで送信先ホストとプライバシー文（§7.2）を表示したうえでトグルを ON にしてもらう。base URL や provider を変えたら同意を取り直す。
- 毎回の実行時、候補ポップアップの上部に「送信先：api.typesafe.ai（判定）／ローカル localhost:11434（生成）・本文 N 字・概算 $X」を表示し、外部送信がある実行は「送信して作る」ボタンを押すまで送らない（Q7）。
- 送るのは除外領域を除いた本文（または選択範囲）、生成した候補、判定用の引用と文脈だけ。ファイルパス、Vault 名、他のノート、`Kioku/` の学習記録は送らない（ノート名はプロンプトの文脈として送るかを §11 で比較し、送る場合はプライバシー文に書く）。

### 7.2 プライバシー文（UI 文言の案）

> AI で候補を作ると、このノートの本文（コードブロック・`%%` コメント・HTML コメント・数式ブロック・frontmatter を除く）が、選んだ AI サービスに送られます。
> - 送信先：〈ホスト名〉（〈provider 名〉）。ローカル（このパソコン内）のサーバーを選んだ場合は外部に送られません。
> - 送信先での扱いは各サービスの規約に従います（例：TypeSafe AI は利用者データで学習しないと公表しています）。
> - 費用は利用者のアカウントに請求されます。キャンセルしても、送信済みの分は請求されることがあります。
> - API キーはこの Vault の `.obsidian/plugins/kioku/data.json` に暗号化せずに保存されます。（Q5 で `data.json` に決まった場合の文言）

### 7.3 API キーの保存（Q5 の推奨案：`data.json`。未決定）

- 保存先はプラグインの `data.json` の `ai.providers.<id>` 内（学習記録の `Kioku/` とは別）。
- **リスク**：平文。Obsidian Sync の設定同期・Git 管理・クラウド同期・バックアップで Vault と一緒に複製され得る。他のプラグインから読める。→ 設定画面と README に明記し、利用上限を設定した専用キーの利用を勧める。
- キーはログ・Notice・エラー文・`artifacts/`・評価結果に出さない（エラー詳細は status とサービス名だけ。応答本文をそのまま表示しない）。入力欄は password 型、保存済みは末尾 4 文字だけ表示。「キーを削除」ボタンを置く。
- 単体テストで「どの失敗経路の理由文にもキーの文字列が含まれない」ことを固定する。

## 8. UI

- **入口**：既存の抽出コマンド・ボタン・ファイルメニューのまま。候補ポップアップに「AI で候補を作る」ボタンを足す（押したときだけ通信）。AI 未設定のときはボタンの代わりに「AI が未設定のため、ノートに書いた問い・答えだけを表示しています。設定 → Kioku → AI で、ローカルの AI（Ollama など）か外部サービスを設定できます。」と「設定を開く」。
- **進行表示**：「生成中…（N 秒）」→ 候補が届いたら決定的検査の結果ですぐ表示し、判定は候補ごとに届いた順に更新する。「キャンセル」ボタンは常に押せる。
- **候補カード**：問い・答えの編集欄（M1 と同じ）、引用（原文の該当箇所を強調、クリックでノートの該当位置へ）、分類バッジ（推奨 / 要確認 / 未判定 / 根拠が弱い）、理由の一覧、生成・判定 provider 名。明示 Q/A と生成候補は見出しで分ける。
- **採用**：生成候補の「採用」は §9 の挿入を行う。挿入位置（「引用元の段落の直後」）と、追加する行（Q/A、`^kioku-…`、引用の記録、空行）を採用前にカードに表示する。
- **設定タブ（AI セクション）**：AI を使う（既定 OFF）、判定 provider（既定 Jev）、生成 provider（Q1）、provider ごとのキー・接続先・モデル・同意トグル、接続テスト、タイムアウト（既定 判定 20 秒 / 生成 60 秒）、プライバシー文。UI 文言は公式 lint の sentence-case 規則を守る（`docs/architecture.md`「既知の制約」）。
- 状態 modal の実装状況表示は、M3 実装時に「AI：設定時のみ、候補は人が採用」へ更新する（それまでは「AI は未実装」のまま）。

## 9. 採用：生成カードの挿入（Q2 の推奨 (A) を前提にした案）

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

`requestUrl`（Obsidian 公開 API）には中断の手段とタイムアウト指定がない【未検証：最新版の型で再確認】。そのためキャンセルとタイムアウトは「待つのをやめて結果を捨てる」で実装し、送信済みのリクエストはサーバー側で処理され得る（外部では課金され得る）ことをプライバシー文に書く（§7.2）。`requestUrl` は `throw: false` で status を受け取り、理由を出し分ける。

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

### 11.3 報告の基準

- 測る組み合わせ：判定 {なし, Jev, Clef-flash, Clef, ローカル} × 生成 {ローカル（候補モデル 2〜3 個）, OpenAI（同意時）}。測定した PC の構成（CPU/GPU/メモリ）を記録する。
- Q3 の目標値を満たした組み合わせだけを「瞬時」と呼ぶ。満たさない場合は数値（「約 N 秒」）で書く。
- 品質の目安（初期案）：推奨候補の precision ≥ 0.8、推奨に残った根拠なし候補 ≤ 5%、引用一致率 ≥ 0.9。Jev がこれを日本語で満たさない場合は Q4 に従って利用者に報告する。
- 実行は tooling の Node script（`scripts/` 配下、配布物に入らない）で行い、キーは環境変数から読み、結果（キーを含まない）を `artifacts/lev-277/eval/` に残す。runtime と同じ `src/ai/` の純粋ロジックを使い、通信だけ Node の HTTP に差し替える。

## 12. モジュール境界（AGENTS.md に従う）

- runtime は公開 Obsidian API とブラウザ互換コードだけ。通信は Obsidian の `requestUrl` だけを使う（CORS の影響を受けず `http://localhost` にも届くため。`fetch` や Node/Electron の HTTP は使わない）。`requestUrl` を包む `HttpClient` は `src/ai/http.ts` に置き、それ以外の `src/ai/` は `HttpClient` を引数で受け取る純粋なコードにする（単体テストでは偽の `HttpClient`）。
- `src/main.ts` は登録と lifecycle だけ（変更は不要か、コマンド追加程度）。
- 提案する構成：
  - `src/ai/types.ts`、`src/ai/checks.ts`（決定的検査）、`src/ai/classify.ts`（分類としきい値）、`src/ai/prompts.ts`（生成・判定のプロンプト）、`src/ai/pipeline.ts`（生成 → 検査 → 判定、並列数・キャンセル・部分結果）、`src/ai/consent.ts`（外部判定・同意判定）。
  - `src/ai/providers/jev.ts`、`clef.ts`、`openai-compatible.ts`（local / openai / custom の共通、logprobs 判定を含む）、`index.ts`（設定から factory）。
  - `src/cards/insertion.ts`（純粋な挿入計画。§9、Q2 の推奨案 (A) の場合）。書き込みは既存の `src/cards/writer.ts` を拡張。
  - `src/store/settings.ts`：`schemaVersion` は 1 のまま、任意の `ai` セクションを足す（無ければ AI 無効の既定値）。現在の `parseSettings` は未知のキーを無視して読むので、M2 版の Kioku に戻しても既存設定と復習は動く。ただし M2 版が設定を保存すると `ai` セクション（API キーを含む）が消えるため、その旨を §15 に記す。
  - `src/ui/candidate-modal.ts`（生成候補・分類・進行表示・キャンセル）、`src/ui/settings-tab.ts`（AI セクション）、理由文は `src/ai/reasons.ts`（M1 の `reasons.ts` の方式）。
- 起動時にネットワーク・`data.json` に触れない規則（M0 から）を保ち、単体テストの起動時 I/O 禁止の変異検査に「`requestUrl` を呼ばない」を加える。
- runtime 依存は増やさない（JSON schema の検証も自前の小さな検証関数で行う）。

## 13. LEV-299（別 PoC、M3 には含めない）

プラグイン内の WebGPU/ONNX 推論（[Laya Multilingual](https://huggingface.co/convaiinnovations/laya-multilingual) など）で、外部サーバーなしに判定・生成できるかを LEV-299 で別に試す。結果が良ければ、§5.1 の `DecisionProvider` / `GeneratorProvider` を実装する provider として追加する（M3 のインターフェースはそれを妨げない形にしておく）。モデルの配布サイズ、`main.js` 以外のファイルの扱い、メモリ、日本語の品質は LEV-299 で評価する。

## 14. 実機確認チェックリスト（案。実装時に `docs/harness.md` へ反映）

実機は LEV-279 の専用インスタンス（`harness:launch` / `harness:quit`）だけ。本番 Vault は使わない。mock・CDP 模擬・preflight・評価 script の成功を実機成功と呼ばない。`artifacts/lev-277/` に baseline、screenshot、操作前後のノート bytes、通信の記録（送信先と文字数。キーと本文は残さない）を残す。

1. 起動直後と設定タブ・候補ポップアップを開いただけでは、ネットワーク通信もノート・`data.json` の書き込みも起きない（smoke と通信の記録）。
2. AI 無効（既定）：抽出で明示 Q/A と決定的検査の注意だけが出て、AI 未設定の案内と「設定を開く」が表示される。通信なし。
3. AI を有効にすると判定 provider が Jev になっているが、キー未入力・同意なしでは「AI で候補を作る」で通信せず、理由が表示される。
4. ローカル（Ollama）を生成に設定：日本語ノートから候補が出て、引用が原文に強調表示され、引用が原文に無い候補は除外件数として表示される。固定枚数にならない（根拠の少ないノートでは 0〜1 件）。
5. ローカル判定（logprobs）・Jev・Clef（同意後）それぞれで分類バッジと理由が出る。Jev の同意前後で送信先表示が正しい。
6. 生成候補の採用（Q2 が推奨 (A) に決まった場合）：引用元のブロックの直後に Q/A・`^kioku-…`・`%%kioku-src%%` が挿入され、原文の文字は変わらない。Reading view で ID と引用記録が見えない。M2 のデッキに New として入る。Undo で1回で戻る。
7. 採用前に引用元を外部で変更・複製すると、書かずに理由が表示される。Canvas ガード、ディスク確認、回復は M1 と同じに動く。
8. 誤った API キー（401）、ローカルサーバー停止（接続失敗）、タイムアウト（短く設定）、生成中・判定中のキャンセル、ポップアップを閉じる、それぞれで理由が表示され、届いた結果は残り、ノートは変わらない。Notice・console・`artifacts/` にキーが出ない。
9. 429 の再現が難しい場合は単体テストで固定したことを記録し、実機では NOT TESTED と明記する。
10. 設定の移行：M2 の `data.json`（schemaVersion 1）から起動して設定タブを開くと、既存設定が保たれ、AI が無効の状態で表示される。
11. 遅延：§11 の目標をこの PC で満たすかを、実機の候補ポップアップで（評価 script とは別に）数回計測して記録する。

## 15. リスク

- **日本語の判定精度**：Jev は CJK で精度が低いと公表、Clef は日本語の性能が不明。§11 で測る前に品質を約束しない。
- **ローカル生成の遅延と品質**：PC の性能・モデル次第で「瞬時」にならない可能性が高い。数値で報告する。
- **引用の完全一致が厳しすぎる**：生成モデルが空白や記号を変えると除外が増える。正規化の範囲は §11 の引用一致率で調整する（範囲を広げすぎると根拠のない候補が通る）。
- **API キーの平文保存**：§7.3。
- **古い版での設定保存**：M3 から M2 版の Kioku に戻して設定を保存すると、`data.json` の `ai` セクション（キーと同意）が消える。再設定が必要になる旨を README に書く。
- **キャンセルしても送信済み**：`requestUrl` は中断できない【未検証】。課金・処理はサーバー側で続き得る。
- **外部サービスの仕様・料金の変化**：Jev は登録再開直後でクレジット施策も変わっている。Clef の Workers AI 提供は 2026-10-01 開始。実装前に §3 を再確認する。
- **生成カードの挿入による本文の変化**：Q2 の決定によっては利用者のメモの読みやすさを損なう。
- **プロンプトインジェクション**：ノート本文（他人から貰ったメモなど）に指示文があっても、出力は JSON 検証と引用の完全一致で縛り、採用は人が行う。AI の出力でノートを書き換える経路は採用ボタンだけ。
- **範囲の膨張**：エージェントへのルーティング等は範囲外（§0.2）。
