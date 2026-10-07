# M2（LEV-276）設計：タグデッキ・復習・日程と履歴

> **状態：設計確定（2026-10-02 利用者決定）・実装済み（実機確認前）。** この文書は LEV-276 の「設計時に確定」項目について利用者が決めた内容と、その実装方針をまとめたもの。実装時に確定・変更した点は末尾の §12 にまとめた。**専用 Vault での実機確認（§9、`docs/harness.md`）はまだで、実機でデッキ・復習・日程・履歴が動くことは確認していない。**
>
> 前提：main の M1（LEV-275、4be240d）。採用済みカードは Q/A ブロック最終行末の ` ^kioku-<[0-9a-z]10文字>`（ランダム ID）で識別し、ポップアップ編集時は直後の `%%kioku-edit:kioku-…` コメントが有効な問い/答えになる（`docs/architecture.md`「保存形式と安定 ID」）。M1 のノート書き込みは採用時だけで、Canvas ガード・ディスク確認（3 秒 settle / 6 秒 deadline）・1回だけの回復（最長 12 秒）を通る。M2 はノートを書かない。
>
> 利用者向けの FSRS の説明は [`docs/fsrs.md`](fsrs.md)。

## 0. 受入条件（LEV-276、原文）

「左 ribbon→中央デッキ選択→問い→回答を表示→評価→次回日程。Skip は評価なしで飛ばす操作と分ける。タグ適用範囲、親子デッキ、全デッキ入口、Due/New/Total、FSRS/SM-2、状態・履歴保存、Q/A編集後の履歴は設計時に確定。未回答の現在ノート/Vault全体を確定要件にしない。再起動後に日程を保持し、複数デッキ所属のカードを二重出題しない。」

「現在ノートだけ復習」「Vault 全体を復習」の入口は M2 では作らない。「全デッキ」はデッキの和集合であり Vault 全体とは別物。

## 1. 決定事項（2026-10-02 利用者決定）

| # | 決定 | 退けた代案（理由は §10） |
| --- | --- | --- |
| Q1 デッキ | プラグイン設定の**トリガータグ**（SR の「Flashcard tags」に相当、複数可、既定 `#kioku`）を持つノートのカードがデッキに入る。子タグは子デッキ、親デッキは子を含む。「全デッキ」はデッキの和集合。タグは大文字小文字を区別しない（Obsidian と同じ）。適用範囲はノート全体。frontmatter のタグも数え、除外領域（コード、コメント等）内のタグは数えない。トリガータグを持たないノートのカードは件数表示だけ。 | 全タグをデッキ化、frontmatter のみ、見出し単位、SR 互換の位置依存規則、親は直付けのみ、フラット一覧 |
| Q2 ID 重複 | 同じ `^kioku-<id>` が複数ノートにあれば1枚のカードとして1回だけ出題。有効な問い/答えが異なる場合は出題から除外し、両方のパスを表示。 | 常に両方除外、先に見つかった方を採用 |
| Q3 アルゴリズム | FSRS（ts-fsrs 5.4.2 を固定）。既定パラメータ、目標保持率 90%、`enable_short_term=false`、fuzz なし。**すべての評価を履歴に保存**し、将来のパラメータ最適化に使えるようにする。評価ボタンは4つ「もう一度 / 難しい / 普通 / 簡単」（キー `1`–`4`）。同日内の再出題なし。 | SM-2 自前実装、両対応、3段階/2段階ボタン、1分/10分の学習ステップ |
| Q4 日付と出題数 | 日付の切り替えはローカル 04:00（設定可）。New は1日 20 枚が既定（設定可、「無制限」も可）。デッキ選択に「今日の新規 残り X 枚」と、上限で出ない分は「残りは明日以降」を表示。完了画面に「今日だけ あと10枚」「今日だけ あと20枚」ボタン。Due は上限なし。各デッキに Due / New / Total を表示。 | 0 時切り替え、UTC、New 上限なし、入口の分割 |
| Q5 Skip と途中終了 | Skip は `S` キー。何も記録せず、このセッションから外す。途中で閉じたら評価済みだけ保存され、再開機能はない。 | Skip をキュー末尾へ、Skip を履歴に記録 |
| Q6 端末 | PC 1台で使う（同じ Vault を複数端末で同期して復習することは想定しない）。 | 端末別の追記ログ |
| Q7 保存先 | Vault 内の見えるフォルダ `Kioku/`（名前は設定で変更可）に、Markdown 以外のファイルで保存：状態 JSON と、年ごとの追記専用の履歴 JSONL。プラグインの `data.json` には設定だけ。安全策：読めないときは書かない、保存前に `.bak`、未知の `schemaVersion` は読み取り専用。履歴から状態を再構築できる。エクスポートは後続。ハーネスの baseline 比較に `Kioku/` フォルダを含める。 | ノート内、プラグインフォルダ、Vault 内 `.md` ログ |
| Q8 編集後の履歴 | Q/A を編集しても日程・履歴を保持し、評価時の内容ハッシュを記録する。リセット UI は後続。 | 自動リセット、M2 でリセット UI |
| Q9 UI | ribbon はデッキ選択を開く。状態 modal（build ID）と抽出はコマンド・file-menu・デッキ選択画面のボタンから。smoke をこれに合わせて更新する。問い/答えは `MarkdownRenderer` で描画し、答えを表示する前は埋め込みを描画しない。 | ribbon は状態 modal のまま、プレーンテキスト表示 |

## 2. 調査で確認した事実（出典）

| 事実 | 出典 |
| --- | --- |
| SR の既定トリガータグは `#flashcards` で、入れ子タグにも一致する。親デッキを選ぶと子デッキを含む。 | [SR Decks](https://www.stephenmwangi.com/obsidian-spaced-repetition/flashcards/decks/), [SR Reviewing](https://stephenmwangi.com/obsidian-spaced-repetition/flashcards/reviewing/) |
| SR はスケジュールをノート内の HTML コメント `<!--SR:!2024-08-16,51,230-->` で保存する。単一ファイルへの保存は「計画中」のまま。開発者向け README では、別の保存先の試作について「it never really worked out」と書かれ、`StorageType` の有効な値は `NOTES` だけ（`FOLDER`・`PLUGIN_DATA` はコメントアウト）。 | [SR Data Storage](https://stephenmwangi.com/obsidian-spaced-repetition/data-storage/), [data-store/README.md](https://github.com/st3v3nmw/obsidian-spaced-repetition/blob/main/src/data/data-store/README.md)（5 行目）, [data-store/base/data-store.ts](https://github.com/st3v3nmw/obsidian-spaced-repetition/blob/main/src/data/data-store/base/data-store.ts) |
| SR 1.15.0（2026-05-24）で FSRS が opt-in として追加された。既定は従来の SM-2-OSR のまま（「バグが潜んでいるかもしれないので既定では有効にしない」）。 | [SR 1.15.0 release](https://github.com/st3v3nmw/obsidian-spaced-repetition/releases/tag/1.15.0), [SR Changelog](https://stephenmwangi.com/obsidian-spaced-repetition/changelog/) |
| SR には1日の新規カード上限の設定がない（要望 #174・#505 が open）。 | [#174](https://github.com/st3v3nmw/obsidian-spaced-repetition/issues/174), [#505](https://github.com/st3v3nmw/obsidian-spaced-repetition/issues/505) |
| Anki では FSRS は opt-in。目標保持率の既定は 90%。「Next day starts at」の既定は 4AM。新規カードの既定は1日 20 枚。 | [Anki Deck Options](https://docs.ankiweb.net/deck-options.html), [Anki Preferences](https://docs.ankiweb.net/preferences.html), [Anki FAQ](https://faqs.ankiweb.net/anki-is-not-showing-me-all-my-cards.html) |
| Obsidian のタグは大文字小文字を区別せず、`/` で入れ子、数字だけのタグは無効。 | [Obsidian Tags](https://obsidian.md/help/tags) |
| `.json` / `.jsonl` は Obsidian の対応形式ではない。Obsidian Sync では「Sync all other types」を ON にしないと同期されない（Q6 により M2 では同期を想定しない）。 | [Accepted file formats](https://obsidian.md/help/file-formats), [Sync settings](https://obsidian.md/help/sync/settings) |
| community plugin のアンインストールはプラグインフォルダ内のファイルを削除する（Q7 で状態・履歴を Vault 側へ置く理由）。 | [Forum #26552](https://forum.obsidian.md/t/help-my-plugins-will-not-delete/26552/2)（フォーラムの証言） |
| ts-fsrs 5.4.2：MIT、runtime 依存なし、FSRS-6。browser 向け minify bundle 21,411 B / gzip 6,768 B、`require(`・`process.` を含まない。`enable_short_term=false` で New の初回間隔は Again 1日 / Hard 2日 / Good 3日 / Easy 8日。経過日数は UTC 暦日差、期日は固定 24 時間の加算。 | `npm view ts-fsrs`、tarball の `dist/index.mjs` / `index.d.ts`、esbuild と Node での実測 |
| 公開 API：`Plugin.loadData/saveData`（`data.json`）、`parseFrontMatterTags`、`CachedMetadata.tags`（位置付き）、`CachedMetadata.blocks`、`Vault.process` / `Vault.append` / `Vault.createFolder`、`DataAdapter`、`Modal.scope`、`MarkdownRenderer`。 | `node_modules/obsidian/obsidian.d.ts`（obsidian 1.8.7） |

【未検証】（実装前に単体テスト/実機で確かめる）：Vault が `.json`/`.jsonl` を `TFile` として索引し `Vault.process`/`Vault.append` で扱えるか（扱えなければ `DataAdapter` を使う）。metadataCache が `%%` 内の `#tag` を数えるか。箇条書き項目の ID が `CachedMetadata.blocks` に入るか。

## 3. デッキ（Q1・Q2）

### 3.1 トリガータグとデッキツリー

- 設定 `triggerTags`（既定 `["kioku"]`）。ノートのタグ `t` は、あるトリガー `g` について `t == g` または `t` が `g/` で始まるとき（大文字小文字を区別しない）デッキに入る。`#kiokux` は一致しない。
- デッキのパスはタグそのもの（`#kioku/医学/生理` → kioku › 医学 › 生理）。トリガーごとに最上位デッキが1つでき、子タグが子デッキになる。表示名は最初に見つかった表記。UI の細部として、トリガータグが**1つだけ**設定されているときは表示からその根を省く（「医学 › 生理」。根のデッキ自体は「全デッキ」と同じ内容になる）。複数設定されているときは根を表示する（「kioku › 医学 › 生理」）。
- 親デッキは子孫のカードを含む（件数はカード ID で重複を除いた数）。最上位に「全デッキ」（全トリガーデッキの和集合）。
- **LEV-321 で変更**：デッキ選択はツリーと「全デッキ」をやめ、ノートに書かれたタグのデッキだけを平らに並べる（§13）。デッキの中身（親は子を含む）は変えていない。
- タグの取得：frontmatter は `parseFrontMatterTags(cache.frontmatter)`、本文は `cache.tags`（位置付き）のうち、位置が M1 の除外領域（コード、`%%`、HTML コメント、`$$`、Excalidraw 描画部）に入らないもの。タグの文法は自前で実装しない。
- 適用範囲はノート全体：そのノートの採用済みカードすべてが、ノートのすべてのデッキタグのデッキに入る。
- トリガータグを持たないノートの採用済みカードは「デッキに属していないカード N 枚（トリガータグ `#kioku` を付けると出題されます）」と件数だけ表示する。

### 3.2 二重出題の防止と ID 重複

- セッションのキューはカード ID の集合で作る。複数デッキ・親子・全デッキのどの入口でも1セッション1回。日程状態は ID ごとに1つなので、デッキ A で評価したカードはデッキ B でも同じ期日になる。
- 同じ ID が複数ノートにある場合（Sync の conflict file、iCloud の「ノート 2.md」、テンプレート・複製）：有効な問い/答え（空白正規化後）が一致すれば1枚として扱い、表示と「ノートを開く」はパス順で最初のノート。異なれば出題から除外し、デッキ選択画面に「内容の異なる同じ ID：パス A / パス B」を表示する。
- **カード ID は大文字小文字を区別する**（M1 parser と同じ。`startsWith('kioku-')`、ID 重複の数え上げ、編集記録の対応付けがすべて区別あり）。タグは区別しない。両者を混同しない。

### 3.3 走査と性能

- デッキ選択を開いたときに走査する（起動時は走査しない）。`getMarkdownFiles()` を、キャッシュにトリガータグがあり、かつ `cache.blocks` に `kioku-` で始まるキーがあるノートに絞り、それだけを `cachedRead` して M1 parser にかける。
- `blocks` に ID が入らないブロックがある場合（【未検証】）は、絞り込みを「トリガータグを持つノート」だけに広げる。
- 性能予算：5,000 ノート / 10,000 カードの生成 fixture で、デッキ選択を開くまで 500 ms 以内（開発機）。実機で計測して `artifacts/` に記録し、超えたら `metadataCache` の `changed` で無効化するキャッシュを入れる。

## 4. スケジューリング（Q3・Q4）

### 4.1 FSRS の設定

- `fsrs({ request_retention: 0.9, enable_short_term: false, enable_fuzz: false })`、その他は ts-fsrs 5.4.2 の既定値。パラメータ最適化は M2 では行わない。
- ts-fsrs は `src/review/scheduler.ts` の内側だけで使い、外へは Kioku の型（§6）だけを出す。
- 評価は4つ：もう一度（Again, `1`）/ 難しい（Hard, `2`）/ 普通（Good, `3`）/ 簡単（Easy, `4`）。各ボタンに次回間隔のプレビュー（ts-fsrs の `repeat()`）を表示する。
- 同日内の再出題はしない（1セッション1回。Again の次回は翌 Kioku 日以降）。
- runtime 依存の追加に伴い、`docs/architecture.md`「runtime dependency なし」の記述、validate の固定 deps、build-info の external 検査（external は `obsidian` のまま）、manifest の説明文、README、配布物への MIT 著作権表示を実装時に更新する。

### 4.2 Kioku 日（日付境界）

- 日付の切り替えはローカル時刻の `dayStartHour`（既定 4）。0:00〜3:59 の評価・表示は前日扱い。
- 期日は時刻ではなく Kioku 日のローカル日付文字列（`dueDay: "2026-10-05"`）で保存し、`dueDay <= today` を Due とする。
- ts-fsrs へ渡す `now` は「その Kioku 日の UTC 正午」（`Date.UTC(y, m, d, 12)`）に正規化する。ts-fsrs の UTC 暦日差が Kioku 日の差と一致し、夏時間の固定 24 時間加算の影響も受けない。`dueDay` は「正規化した now + scheduled_days」の UTC 日付から求める。実時刻は履歴の `at` に記録する。この正規化で既定どおりの間隔になることを単体テストで固定する。

### 4.3 Due / New / Total と新規上限

| 用語 | 定義 |
| --- | --- |
| New | 採用済みで評価が一度も記録されていないカード。 |
| Due | 評価済みで `dueDay <= today` のカード（期日超過を含む）。 |
| Total | デッキに所属する一意カード数（内容の異なる ID 重複で除外したものは含めず別表示）。 |

- `newPerDay`（既定 20、`null` で無制限）は全デッキ共通。今日導入した New の数を状態に保存して数える。
- デッキ選択の上部に「今日の新規 残り X 枚」。各デッキ行の New は実数を出し、上限で今日出ない分があれば「残りは明日以降」と表示する。（LEV-321 で画面から外した。§13）
- **学習中（LEV-322）**：Due のうち、直近の評価（今の期日を決めた評価）が「もう一度」だったカード。デッキ選択の列は「新規 / 学習中 / 復習」で、復習＝Due のうち学習中でないもの。定義と情報源は §13。
- 完了画面で、上限のため出なかった New があれば「今日だけ あと10枚」「今日だけ あと20枚」を表示する。押すと今日の上限だけを増やし（`extraNew` を状態に保存、翌 Kioku 日にリセット）、同じデッキでセッションを続ける。
- Due は上限なし。出題順は Due（期日が古い順）→ New（パス順、ノート内の出現順）。

## 5. 復習の流れ（Q5・Q9）

1. 左 ribbon → 中央「デッキ選択」modal。書かれたタグごとの平らな一覧（新規 / 学習中 / 復習）、注記（デッキ外カード、ID 重複、読み取り専用）。上部は「デッキ」・⋯・× だけで、⋯ のメニューに「問い・答えの候補を抽出」「状態」（version/build ID の状態 modal）「記録の保存先について」（LEV-321。当初の版はツリー・「全デッキ」・今日の新規残り・下部のボタン）。
2. デッキを選ぶ → 同じ modal 内で復習画面。上部は ←（デッキに戻る）・タグと進捗（`#タグ | 現在/全体`）・歯車（共通規約は `docs/ui-design.md`。LEV-321 で変更）。
3. 問いを表示 → 「答えを表示」（Space / Enter）→ 答えと評価ボタン（`1`–`4`）。「スキップ」（`S`、答えの表示前後どちらでも可）は歯車のメニューにも入れた。
4. 評価 → 保存（§7）の完了を確認 → 次のカード。最後に完了画面「評価 N 枚・スキップ M 枚」と新規追加ボタン。
5. Skip：状態・履歴・ノートに何も書かず、このセッションのキューから外す。次のセッションでは再び Due/New として出る。
6. 途中で閉じる（×、Escape）：確認なしで閉じる。評価済みは保存済み、表示中の未評価カードは変化なし。再開機能はなく、次回は Due/New から作り直す。保存中に閉じた場合は保存完了を待ち、失敗時だけ Notice を1回出す。
7. 「ノートを開く」で `[[path#^kioku-…]]` へ移動（modal は閉じる）。

**二重評価の防止（要件）**：Space/Enter はフォーカス中ボタンの click と `Modal.scope` の処理が二重に発火しうるので、キー処理側で既定動作を止めて1経路で処理する。`event.repeat` を無視する。保存中は評価・スキップ入力を無視してボタンを無効化する。IME 変換中（`event.isComposing` または `event.key === 'Process'`）のキーを無視する。ボタンには `aria-label`（キーと次回間隔）を付け、答え表示後のフォーカスは「普通」、Tab 順は表示順。

**描画**：問い/答えは `MarkdownRenderer` で描画し、component は modal の close で unload する（【未検証】の管理は実装時に確認）。答えを表示する前は問い側の埋め込み（`![[…]]`）を描画せずリンク文字として表示する（自ノートの block や見出しの埋め込みで答えが見えるのを防ぐ。重い post-processor の実行も避ける）。答え表示後は通常どおり描画する。

**入口（Q9）**：ribbon → デッキ選択。コマンド：「デッキを選んで復習」「フラッシュカード（状態）」「開いているノート・選択範囲から問い・答えの候補を抽出」。file-menu：既存の「Kioku：問い・答えの候補を抽出」のまま（現在ノートの復習は作らない）。

## 6. データモデル（実装時に確定する型のスケッチ）

```ts
// src/review/types.ts（Obsidian 非依存）
export type CardId = `kioku-${string}`;   // case-sensitive, as in M1
export type Grade = 1 | 2 | 3 | 4;         // again / hard / good / easy
export type CardPhase = 'new' | 'learning' | 'review' | 'relearning';
export type KiokuDay = string;             // local "YYYY-MM-DD" after dayStartHour

export interface CardSchedule {
  readonly phase: CardPhase;
  readonly dueDay: KiokuDay;
  readonly stability: number;
  readonly difficulty: number;
  readonly reps: number;
  readonly lapses: number;
  readonly lastReviewDay: KiokuDay | null;
}

/** One rating, appended to Kioku/history-YYYY.jsonl. Skip is never recorded. */
export interface ReviewEvent {
  readonly v: 1;
  readonly eventId: string;         // `${cardId}:${random 10 chars}`, unique; replay dedupes on it
  readonly cardId: CardId;
  readonly at: number;              // real time, UTC epoch ms
  readonly day: KiokuDay;
  readonly grade: Grade;
  readonly phaseBefore: CardPhase;
  readonly elapsedDays: number;     // Kioku days since the previous rating (0 for first)
  readonly scheduledDays: number;
  readonly stability: number;       // after this rating
  readonly difficulty: number;      // after this rating
  readonly contentHash: string;     // effective Q/A at review time (Q8)
  readonly scheduler: 'ts-fsrs@5.4.2';
}

export interface KiokuStateV1 {      // Kioku/state.json
  readonly schemaVersion: 1;
  readonly cards: Readonly<Record<CardId, CardSchedule>>;
  readonly today: { readonly day: KiokuDay; readonly newIntroduced: number; readonly extraNew: number } | null;
  /** Replay position per history file: lines already reflected in `cards` and the eventId on the last of them. */
  readonly applied: Readonly<Record<string, { readonly lines: number; readonly lastEventId: string }>>;
}

export interface KiokuSettingsV1 {   // .obsidian/plugins/kioku/data.json (settings only)
  readonly schemaVersion: 1;
  readonly triggerTags: readonly string[]; // default ["kioku"]
  readonly dayStartHour: number;           // default 4
  readonly newPerDay: number | null;       // default 20, null = unlimited
  readonly dataFolder: string;             // default "Kioku"
}
```

将来の最適化に必要な入力（カードごとの評価時刻・評価・経過日数の列）は `ReviewEvent` に揃っている。最適化そのもの（例：FSRS optimizer の利用）は後続で、M2 は記録だけを行う。

## 7. 保存（Q6・Q7）

### 7.1 配置

```text
<Vault>/Kioku/                 フォルダ名は設定 dataFolder で変更可
  state.json                   カード状態（schemaVersion 付き）
  state.json.bak               セッション最初の保存直前の state.json のコピー
  history-2026.jsonl           評価イベント（年ごと、1行1件、追記のみ）
<Vault>/.obsidian/plugins/kioku/data.json   設定だけ（saveData）
```

- Markdown ではないので、Obsidian のエディタ・Canvas・ホバー popover が開いて古いバッファで上書きする経路（M1 で実機確認した問題）を通らない。対応形式外なので検索・グラフにも出ない見込み（【未検証】。「すべての拡張子を検出」設定時のファイル一覧表示を含め実機で確認）。
- プラグインのアンインストールで消えない。Vault ごとバックアップされる。
- Q6 により複数端末の同期は想定しない（Obsidian Sync では既定で同期されない）。
- `dataFolder` を変えてもファイルは移動しない（移動は利用者が行う）。変更を適用する前に新旧フォルダを調べ、**新しいフォルダにデータが無く古いフォルダにデータがある場合は変更を適用せず**、「古いフォルダ（…）にデータがあります。移動してから変更してください」と表示する。黙って空の状態から始めることはしない。新しいフォルダに既にデータがある場合（利用者が移動済み）は適用する。

### 7.2 読み書きの規則

- **読み込み**はデッキ選択を開いたとき（`onload` では読まない）。
- **デッキ選択の開閉では何も作らない・書かない**。`Kioku/` フォルダとファイルは最初の評価で初めて作る。
- **履歴が正本、状態はキャッシュ**。評価1件の保存：
  1. 一意の `eventId`（`<cardId>:<ランダム10文字>`）を持つイベントを作り、履歴 JSONL に1行追記する。
  2. 追記を読み戻して、その `eventId` の行が末尾にあることを確認する。**ここまで成功したら「保存済み」**として次のカードへ進む（メモリ上の状態は更新済みなので同じセッションで再出題しない）。
  3. `state.json` を更新する（セッション最初の更新の前に `.bak` を作る）。失敗しても評価は失われていないので進行は止めず、「日程ファイルの更新に失敗しました。次に開いたときに記録から反映します」と1回表示する。
- 1 が失敗または結果不明の場合は進めず理由を表示する。再試行は**同じ `eventId`** で行い、同じイベントが2行になっても再生時に重複除去されるので二重評価にならない。新しい評価として打ち直させない。
- 読み込み時、`state.json` の `applied`（履歴ファイルごとの反映済み行数と最後の `eventId`）より後ろの行を再生して状態を追いつかせる。再生位置は**行数と `eventId` で決め、時刻（`at`）では決めない**（時計の巻き戻しや同じミリ秒の評価で取りこぼさないため）。`applied` の位置の行の `eventId` が一致しない（ファイルが外部で変わった）場合は、全履歴を先頭から再生し直す。
- 書き込み API は Vault API（`createFolder`、`process`、`append`）を優先し、`.json`/`.jsonl` が `TFile` として扱えない場合だけ `DataAdapter` を使う（§2 の【未検証】）。
- 理由文は M1 の `src/cards/reasons.ts` の方式（理由と前置きを分ける）に合わせて M2 用を追加する。

### 7.3 データ消失への安全策

| 経路 | 対策 |
| --- | --- |
| 読めない・壊れた `state.json` を「新規」と誤認して上書き | ファイルが**存在しない**ときだけ新規扱い（存在確認は明示的に行う）。存在するのに読めない/検証に失敗したら**読み取り専用モード**：評価ボタンを無効化し理由を表示、何も書かない。 |
| `state.json` が無いが履歴はある | 履歴を時刻順に再生して状態を再構築する（書き込みは最初の評価時）。 |
| 履歴の最終行だけが途中で切れている（クラッシュ時の典型） | 自動では捨てない。読み取り専用にしたうえで確認ボタン「不完全な最終行を退避して続ける」を出し、押されたときだけその1行を `history-YYYY.jsonl.broken` に追記して履歴から取り除き、続行する（この行の評価は失われるので、その旨を表示する）。解決するまで追記しない（壊れた行に続けて書かないため）。 |
| それ以外の履歴の壊れた行（途中の行、複数行） | 読み取り専用にし、ファイル名と行番号を表示する。自動修復しない。復旧手順（`.broken` への手動退避、`.bak` からの戻し方）は README に書く。 |
| 保存途中の失敗 | 履歴の追記が確認できていれば評価は保存済みで、状態は次回の再生で追いつく。状態は `.bak` からも戻せる。復元手順を README に書く。 |
| 未知の `schemaVersion`（古い Kioku で新しいデータを開く） | 読み取り専用。移行は新しい版だけが行う。 |
| 誤操作でのフォルダ削除・移動 | M2 では防げない。README とデッキ選択の注記に、`Kioku/` に学習履歴があることを明記する。エクスポートは後続。 |

### 7.4 孤立と編集（Q8）

- 走査で ID が見つからないカードの状態・履歴は削除しない（Undo・別ノートへの移動・改名で ID が再出現すれば再接続）。件数には含めない。掃除 UI は後続。
- `^kioku-…` を消して再採用したブロックは新しい ID＝新しいカード（M1 の規則）。
- 原文編集・`%%kioku-edit%%` の追加後も ID が同じなら日程・履歴を保持する。履歴の `contentHash` で後から変更を判別できる。リセット UI は後続。

## 8. モジュール境界

- `src/main.ts`：ribbon・コマンド・file-menu・設定タブの登録、modal とストアの所有、`onunload` で閉じるだけ。
- `src/cards/`（M1、純粋）：parser・regions を読み取り専用で再利用。
- `src/decks/`：`tags.ts`（純粋。トリガー一致、除外領域での絞り込み、入れ子展開）、`index.ts`（純粋。所属、ツリー、ID 重複、件数）、`scan.ts`（Obsidian 依存。デッキ選択を開いたときだけ）。
- `src/review/`：`scheduler.ts`（ts-fsrs ラッパ）、`day.ts`（Kioku 日・正規化）、`queue.ts`（重複除去、新規上限、追加枚数、Skip）。純粋・決定的で、時刻は引数で受け取る。
- `src/store/`：`schema.ts`（純粋。検証・移行・読み取り専用判定・履歴再生）、`review-store.ts`（`Kioku/` の I/O だけ）、`settings.ts`（`data.json`）。
- `src/ui/`：`deck-picker-modal.ts`、`review-modal.ts`、`settings-tab.ts`。既存の `startup-modal.ts`（状態）と `candidate-modal.ts`（抽出）は入口だけ変える。
- runtime は公開 Obsidian API とブラウザ互換コードのみ。

## 9. 実機検証とハーネス（実装時に `docs/harness.md` へ反映）

ハーネスの変更：

- smoke：ribbon がデッキ選択を開くことと、デッキ選択のルートの version/build ID data attribute が preflight と一致することを検査する。状態 modal はコマンドから開いて同じ identity を検査する。
- baseline：現行どおり `.obsidian/` 以外の内容ファイルを比較するので `Kioku/` は対象に入る。M2 では「デッキ選択の開閉で `Kioku/` が作られない」ことと、評価後の差分が `Kioku/` 内の想定ファイルだけであることを明示的に判定する。

実機チェックリスト（`artifacts/lev-276/` に baseline・screenshot・bytes を残す。mock や preflight の成功を実機成功と呼ばない）：

1. 起動直後にノートも `Kioku/` も読み書きされない。
2. ribbon → デッキ選択の開閉・Escape で Vault の内容ファイルが変わらず、`Kioku/` が作られない。identity が preflight と一致。
3. トリガータグ（既定 `#kioku`、大文字小文字の違い、入れ子、frontmatter、コードブロック内のタグは数えない）どおりのデッキと件数（LEV-321 から「新規 / 学習中 / 復習」、§13）。デッキ外カード件数、ID 重複（同内容は1枚、異内容は除外と両パス）。
4. 2つのデッキに属するカードが、親・`#kioku` 行（あれば。LEV-321 以前は「全デッキ」）・各デッキのどのセッションでも1回だけ。デッキ A で評価後、デッキ B で Due でない。
5. 評価で `history-YYYY.jsonl` に1行、`state.json` が更新、初回は `.bak` 作成。ノート bytes は不変。
6. Skip で `Kioku/` とノートの bytes が変わらず、同セッションで再出題されず、開き直すと残っている。
7. 途中で閉じる・Escape：評価済み分だけ保存。
8. `harness:quit` → `harness:launch` の再起動（`docs/harness.md`「M2 実機確認」）で期日と件数（新規 / 学習中 / 復習）が一致。`harness:update` 後も `Kioku/` が残る。
9. 新規上限：21 枚目以降が今日出ず（LEV-321 からは行の `aria-label` と完了画面で示す）、「今日だけ あと10枚」で 10 枚追加される。
10. 今日評価したカードが今日の Due に再び出ない（日付境界そのものは単体テストで固定）。
11. ブロックの別ノートへの移動・改名後も日程が保持され、削除→Undo で戻る。原文編集後も保持。
12. `state.json` を壊すと読み取り専用になり、評価できず上書きされない。`state.json` を消すと履歴から再構築される。`state.json` を古い版に戻すと、反映済み位置より後ろの履歴が再生されて追いつく（重複行があっても二重に数えない）。
12a. 履歴の最終行を途中で切ると読み取り専用になり、確認ボタンを押したときだけその行が `.broken` に移って続行できる。途中の行を壊すと読み取り専用のまま。
12b. `dataFolder` を、データの無いフォルダ名へ変えようとすると適用されず「古いフォルダ（…）にデータがあります…」が表示される。
13. キーボード：Space/Enter、`1`–`4`、`S`、Escape。フォーカス中の Space、長押し、保存中の連打で二重評価されない（履歴の行数で確認）。IME 確定の Enter で評価されない。
14. 答え表示前に問いの埋め込みが描画されない。
15. 性能：生成 fixture でデッキ選択を開くまでの時間を記録する。

## 10. 退けた代案と理由（要約）

- **全タグをデッキ化**：`#todo` 等がデッキになる。トリガータグなら SR 利用者にも馴染みがあり、ノイズがない。
- **見出し単位・SR 互換の位置依存規則**：タグの位置でデッキが変わり、説明とテストが難しい。
- **SM-2**：FSRS の方が同じ記憶率を少ない復習で達成できるとされる（`docs/fsrs.md`）。SR も FSRS を opt-in で追加済み。
- **1分/10分の学習ステップ**：同一セッションの再出題が「二重出題しない」の検証と紛らわしい。
- **ノート内保存**：評価ごとに M1 の確認・回復（3〜12 秒）が必要で復習 UI として成立しない。
- **プラグインフォルダ保存**：アンインストールで消える。
- **Vault 内 `.md` ログ**：エディタ等の古いバッファによる上書き、検索・グラフへの露出。複数端末の同期は Q6 で不要。

## 11. リスク

- runtime 依存の追加と関連文書・検査・ライセンス表記の更新漏れ。
- `.json`/`.jsonl` を Vault API で扱えるか（§2 の【未検証】）。
- 利用者による `Kioku/` の誤削除・移動（エクスポート未実装）。
- Kioku 日の正規化を誤ると間隔が ±1 日ずれる。
- 大規模 Vault の走査時間と `blocks` による絞り込みの漏れ。
- `MarkdownRenderer` の副作用。
- ribbon 変更に伴う smoke 更新漏れで build 識別の検査が効かなくなる。

## 12. 実装時に確定・変更した点（LEV-276 実装）

設計の決定事項（§1）は変えていない。§2・§6・§7 の【未検証】や「実装時に確定」とした点を次のように決めた。実機での確認は §9 のチェックリストで行う。

| 項目 | 実装 | 理由 |
| --- | --- | --- |
| `Kioku/` の I/O | Vault API（`createFolder`/`process`/`append`）ではなく公開 `DataAdapter`（`app.vault.adapter` の `exists`/`read`/`write`/`append`/`mkdir`/`list`）だけを使う。 | 「存在しない」と「読めない」の区別（§7.3）を、起動直後に遅れうる Vault の索引ではなくディスクの `exists` で行うため（索引の遅れで既存ファイルを新規と誤認して上書きする経路を作らない）。`.json`/`.jsonl` が `TFile` になるか（§2【未検証】）に依存せず、経路を1つにして単体テストで固定できる。対象ファイルはエディタで開かれないため、`Vault.process` の利点（エディタのバッファとの整合）は不要。 |
| `ReviewEvent` の項目 | §6 のスケッチに評価後の `phase`・`dueDay`・`reps`・`lapses` を追加（`stability`・`difficulty` は既存）。 | 再生がスケジューラを再実行せずイベントだけで日程を復元でき、ts-fsrs の版が変わっても過去の日程が変わらない。`state.json` が無くても履歴だけで完全に再構築できる。 |
| `today.newIntroduced` | 評価のたびに状態へ加算するのではなく、履歴の再生で `phaseBefore === 'new'` のイベントを日ごとに数える（`state.json` を消しても数え直せる）。`extraNew` は `state.json` だけにあり、全再生でも同じ日なら引き継ぐ。 | 履歴が正本という規則（§7.2）に合わせる。 |
| ts-fsrs の副作用 | ts-fsrs 5.4.2 はモジュール評価時に `Date.prototype` に `scheduler`/`diff`/`format`/`dueFormat` を代入する。`src/review/fsrs-guard.ts` で import 前の状態を記録し、import 直後に元に戻す。 | Obsidian の共有 window と他プラグインを汚さないため（ts-fsrs 自身はそれらを使わない）。単体テストと production bundle の検査で固定。 |
| 同日内の再出題なし | ts-fsrs の期日の UTC 日付が評価日以前なら翌日に切り上げる（`enable_short_term=false` では通常起きない安全策）。 | §4.1 の「同日内の再出題なし」を設定に依存させない。 |
| キー入力 | `Modal.scope.register` ではなく、modal の `containerEl` の capture 段 `keydown` で1経路に処理し `preventDefault`。Space/Enter の `keyup` も抑止し、ボタンの click は描画ごとの token で古いボタンを無視。 | `Scope` で Space をどのキー名で登録すべきかが公開 API の記述からは確定できず、`event.repeat`・`isComposing` を直接見られる DOM の経路の方が単体テストで二重評価の防止を固定できる。`Escape` は従来どおり Modal に任せる（§9 の 13 で実機確認）。 |
| 走査の絞り込み | トリガータグのあるノートは `cache.blocks` に関係なくすべて読む。`kioku-` の block キーだけを持つノートはデッキ外の件数のためだけに読む。 | 箇条書き項目の ID が `cache.blocks` に入るか（§2【未検証】）を確かめるまで、デッキに入るべきカードを取りこぼさない側に倒す（§3.3 の代替案）。性能は §9 の 15 で計測する。 |
| 復習画面のファイル名 | §8 の `review-modal.ts` は `src/ui/review-screen.ts`（同じ modal 内の画面）。 | §5 のとおり復習はデッキ選択と同じ modal 内で行い、別の `Modal` ではないため。 |
| 設定の読み込み | `data.json` は `onload` では読まず、デッキ選択・設定タブで初めて必要になったときに読む。 | 起動時に何も読み書きしない規則（M0 から）を保つ。 |
| `dataFolder` の変更 | 設定タブではテキスト欄に入力して「変更」ボタンで適用（入力のたびには適用しない）。使えない名前（空、`.` で始まる、`..` を含む等）は拒否。 | 1文字ごとに変更ガードが走って誤って拒否・適用しないため。 |
| `obsidianmd/settings-tab/prefer-setting-definitions` | eslint 設定でこの規則だけを無効化。 | 宣言的設定 API は Obsidian 1.13.0 からで、Kioku の `minAppVersion`（1.8.7）の API 型に無い。 |
| 履歴ファイルの欠落 | `state.json` の `applied` が指す履歴ファイルが無い、または反映済み行数より短い場合は全再生せず読み取り専用（§7.2 の全再生は「ファイルはあるが eventId が違う」場合だけ）。 | 欠けた履歴から全再生して `state.json` を書くと、残っていた日程を黙って失うため（独立レビューの指摘）。 |
| 不正なカード ID | `^kioku-` のように本体の無い ID は走査で除外し注記する。記録前にイベントを再生と同じ規則で検証する。 | 再生で拒否される行を追記すると、以後ずっと読み取り専用になるため。 |
| 設定の読み込み失敗 | `data.json` が読めない・`dataFolder` が不正なら既定値に戻さずエラーにする（デッキ選択は開かず、設定タブは保存しない）。 | 既定の `Kioku` で新しい空の履歴を始めると、データが2か所に分かれ §7.1 のガードを迂回するため。 |
| 日付をまたぐ復習 | 評価時の Kioku 日がセッション開始時と違えば評価せずにデッキ選択を読み直す。 | キュー・新規上限・間隔プレビューがセッション開始日のものなので。 |
| 埋め込みの非表示 | `![[…]]` に加えて `![…](…)` もリンク表示にする。 | 答えが見えるのを防ぐ目的（§5）に合わせる。 |
| 「今日だけ追加」の保存 | 最初の評価より前は `state.json` も `Kioku/` も作らず、メモリ上（同じデッキ選択 modal の間）だけに持ち、最初の評価の状態と一緒に保存する。評価せずに閉じると失われる。`state.json` が既にあれば押したときに保存する。 | §7.2「最初の評価で初めて作る」に合わせる（親の判断）。 |
| 書き込みの方式 | 履歴は常に `append`（存在しなければ `append` が作る）。`state.json` は `state.json.tmp` に書いて確認後に `rename` で置き換える（上書き不可の adapter では削除してから `rename`。その隙間の中断は「state.json 無し」として履歴から作り直す）。Obsidian 1.14.3 の実機では上書きの `rename` が「Destination file already exists!」で失敗するので、毎回この削除→`rename` の経路になり、保存後に `.tmp` は残らず `.bak` がある。途中で切れた最終行の確認ボタンは、その行が `state.json` に未反映のとき（追記中のクラッシュ）だけ出る。反映済みの行が切れた場合は「反映済みより短い」として読み取り専用（手順は README）。 | 存在判定の誤りで履歴を置き換えない。`state.json` が書きかけで残らない。 |
| 年ファイルの選択 | 追記先は「評価の年」と「既にある最新の年ファイル」の大きい方。 | 時計を年をまたいで戻しても、追記順と再生順（ファイル名順）が一致する。 |
| 検証の追加 | `CardSchedule` の `dueDay` は `lastReviewDay` より後でなければ不正（ts-fsrs が例外を投げるため）。状態・履歴の先頭の UTF-8 BOM は許容。 | 手で編集されたファイルへの耐性。 |
| 埋め込みの非表示（拡張） | 答えの表示前は `![` をすべて `[` にし、埋め込み HTML（`<img>`・`<iframe>` 等）を文字にし、コードブロックの info string を外す。 | 参照形式の画像・HTML・dataview 等の renderer でも答えが見えないように（親レビュー）。 |
| 索引待ちのノート | `getFileCache` が無いノートは数えず、件数を注記する。 | 黙って少なく数えないため。 |
| 欠落の判定の基準 | `state.json` が無いときは、有効な `state.json.tmp`（無ければ `.bak`）の `applied` で履歴の欠落を判定する（再生の起点には使わない）。 | 削除→rename の間の中断のあとに履歴ファイルが消えていても、黙って空から再生しないため。 |

## 13. LEV-321：デッキ選択と復習画面の再設計（2026-10-07）

本人が調整台（design studio）で決めた見た目に合わせた。FSRS、日程、保存形式、キュー、Due（`isDue`）と New の数え方は変えていない。見た目の規約は `docs/ui-design.md`。

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| 一覧の行 | ノートに**書かれた**トリガー一致のタグのデッキだけを、階層を付けずにタグ名順（小文字化したキーの順）で並べる（`DeckIndex.listed`）。書かれていない中間の親（`#kioku/医学/生理` だけのとき `#医学`）は行にしない。親を書いたノートがあれば、その行は子のカードも含む（Q1 は不変）。`#kioku` だけを書いたノートがあれば `#kioku` 行（全カード）が出る。「全デッキ」の行は出さない。 | 本人の要望「階層はいらない、行の見出しはタグ」。どのカードも、そのノートに書かれたタグの行に必ず入るので、出題できなくなるカードがない（単体テストで固定）。統括の判断（案 B）。 |
| 行の見出し | `#` ＋タグ。トリガータグが1つのときはその根（`kioku/`）を省く（`#医学/生理`）。複数のときは省かない（`#kioku/医学/生理`）。 | 従来の根の省き方と同じ規則。 |
| 3列の件数（LEV-322 で学習中の定義を変更） | 新規＝評価の記録が無いカード（従来の New）。学習中＝期日が来た（`dueDay <= today`）カードのうち、直近の評価が「もう一度」（grade 1）だったもの。復習＝期日が来たカードのうち学習中でないもの。学習中＋復習＝従来の Due なので、列は重ならず、3列の合計はそのデッキで今日出せる枚数（新規の上限の範囲内）。 | 「今日出せるもの」という Due と同じ考え方で、列が重ならないようにした（統括の判断、案 A。学習中の中身は本人の承認、2026-10-07）。 |
| FSRS の phase を使わない理由 | Kioku の FSRS 設定（`enable_short_term=false`、§4.1）では、ts-fsrs 5.4.2 は New をどの評価でも Review に、Review の「もう一度」も Review に移す（実測。LEV-322 の実機でも「もう一度」の行の `phase` は `review`）。phase で数えると学習中は常に 0 になる（LEV-321 の版）。設定は変えない。 | 本人の承認（設定は変えず、定義を直近の評価にする）。 |
| 直近の評価の情報源 | `state.json` のカードの状態（`CardSchedule`）には評価の値が無い（`lapses` は累計で、New への「もう一度」では増えない）。そこで記録ファイル `history-YYYY.jsonl` を使う。デッキ選択を開く明示操作のときに `ReviewStore.load` が既に全部読んでいる（起動時には読まない）ので、追加の読み書きは無い。各カードの最後の行（年のファイル順、行順。同じ `eventId` の重複は1回、`replayHistory` と同じ）の `grade` と `dueDay` を見る（`lastRatings`）。保存形式は変えていない。 | 起動時のノート・`Kioku/` の読み書き禁止と保存形式を守るため。 |
| 直近の評価が得られない場合 | 履歴にそのカードの行が無い（手で作った `state.json` など）、または最後の行の `dueDay` が今の期日と違う（`state.json` が履歴より新しい。履歴が欠けて読み取り専用のときなど）ときは、学習中とせず復習に数える。学習中は「今の期日を決めた評価が『もう一度』だった」と確かめられたカードだけ。 | 古い評価で学習中と誤って数えないため。 |
| 今日の新規の残り（LEV-322） | 通常は画面に出さない。上限のために今日出ない新規カードがあるときだけ、一覧の下に控えめな一文「新規は残り N 枚が明日以降」を出す。N は全デッキで重複を除いた新規の枚数から今日の残り枠を引いた数（同じカードを複数の行で数えない）。行の `aria-label` の「今日の新規は残り X 枚（残りは明日以降）」と `data-kioku-later` は従来どおり。完了画面の表示と「今日だけ あと10枚 / 20枚」も従来どおり。 | 本人の承認（推奨案、2026-10-07）。上部は「デッキ」・⋯・× のまま。 |
| 進捗表示のアイコン（LEV-322） | Lucide の `credit-card`（調整台と同じカード型）。 | 本人の承認。 |
| 保存先の説明 | 画面から外し、⋯ の「記録の保存先について」で Notice（10 秒）に出す。 | 同上。 |
| ⋯ のメニュー | Obsidian の公開 `Menu`。macOS ではユーザー設定（既定）により OS のネイティブメニューで出る。 | Obsidian 標準の部品に合わせる。ネイティブメニューは DOM に無いので、実機の撮影では専用 Vault だけ `nativeMenus` を一時的に `false` にした（`docs/harness.md` には変更なし、証跡に記録）。 |
| 復習画面の上部 | ←（`arrow-left`、デッキに戻る。保存中・保存失敗中は無効）、中央に `#タグ \| 現在/全体` の進捗、右に歯車と Obsidian の ×。「残り N 枚」は出さない。現在＝このセッションで評価・スキップした枚数＋1、全体＝それに今日の残りを足した数（「今日だけ追加」で増える）。 | 本人の決定。 |
| 歯車のメニュー | 「スキップ（S）」「元のノートを開く」「デッキに戻る」。保存中・保存失敗中はすべて無効。 | スキップを下部から移した。 |
| 進捗の「全体」が増える場合 | 「今日だけ追加」のほか、新規の上限があるときに新規カードをスキップすると増える（例：上限 2・新規 4 枚で `1/2` → スキップ → `2/3`）。スキップは新規の枠を使わない（§5・キューの仕様）ので、上限で待っていた次の新規が今日の分に入るため。意図した動作。 | キューの仕様をそのまま表示に反映する。 |

