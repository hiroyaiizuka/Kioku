# M2（LEV-276）設計提案：タグデッキ・復習・日程と履歴

> **状態：提案（未決定）。** この文書は LEV-276 の「設計時に確定」とされた項目について、選択肢・トレードオフ・推奨案を並べたものである。**どれも決定ではない。** 決定はユーザーが行い、決定後に `docs/product-plan.md` / `docs/architecture.md` / `docs/harness.md` へ「M2 で決めたこと」として転記する。M2 は未実装であり、この文書はデッキ・復習・日程が実装済みであることを意味しない。
>
> 前提：main にマージ済みの M1（LEV-275、4be240d）。採用済みカードは Q/A ブロック最終行末の ` ^kioku-<[0-9a-z]10文字>`（ランダム ID、内容ハッシュではない）で識別され、ポップアップ編集時は直後の `%%kioku-edit:kioku-…` コメントが有効な問い/答えになる（`docs/architecture.md`「保存形式と安定 ID」）。ノートへの書き込みは採用時だけで、Canvas ガード、ディスク確認（250 ms ごとの読み直し、3 秒 settle / 6 秒 deadline）、1回だけの回復（ノートの変更が 2.5 秒途切れるまで待ち、最長 12 秒）を通り、利用者向けの理由文は `src/cards/reasons.ts` に集約されている（`docs/architecture.md`「書き込み経路」6–8）。

## 0. 受入条件（LEV-276、原文）

「左 ribbon→中央デッキ選択→問い→回答を表示→評価→次回日程。Skip は評価なしで飛ばす操作と分ける。タグ適用範囲、親子デッキ、全デッキ入口、Due/New/Total、FSRS/SM-2、状態・履歴保存、Q/A編集後の履歴は設計時に確定。未回答の現在ノート/Vault全体を確定要件にしない。再起動後に日程を保持し、複数デッキ所属のカードを二重出題しない。」

この文書の読み方：

- 「現在ノートだけ復習」「Vault 全体を復習」の入口は**確定要件にしない**（受入条件どおり）。「全デッキ」入口（§3）はデッキの和集合であり Vault 全体とは別物として扱う。
- 各決定は「問い → 選択肢 → 推奨案」の順。評価軸は ①Obsidian 内のデータ安全性、②Obsidian Sync / iCloud での端末間同期・競合、③大きな Vault での性能、④既存 Spaced Repetition（以下 SR）プラグインとの互換、⑤実装コスト、⑥専用 Vault 実機ハーネスでの検証しやすさ。
- 【未検証】と付けたものは公式文書・ソース・実測で確認できていない推定。実装前または実機で確かめる。

## 1. 調査で確認した事実（出典）

| 事実 | 出典 |
| --- | --- |
| SR の既定デッキタグは `#flashcards` で、`#flashcards/subdeck/subdeck` のような入れ子にも一致する。タグは「ファイル内で次のタグが現れるまで、その後のすべてのカードに適用」され、カード1行目先頭のタグはそのカード専用。フォルダをデッキにする設定もある。 | [SR Decks](https://www.stephenmwangi.com/obsidian-spaced-repetition/flashcards/decks/) |
| SR はスケジュールをノート内 HTML コメント `<!--SR:!2024-08-16,51,230-->`（期日, 間隔, ease）で保存し、既定はカード直後の行。単一スケジュールファイルは「計画中」。設定は `data.json`。 | [SR Data Storage](https://stephenmwangi.com/obsidian-spaced-repetition/data-storage/) |
| SR のアルゴリズムは SM-2 ベースの「SM-2-OSR」で Hard/Good/Easy の3段階。FSRS は「Planned」。復習画面には Skip（`S`）、Space/Enter で答え表示、`1`–`3` で評価。親デッキを選ぶと子デッキを含む。 | [SR Algorithms](https://stephenmwangi.com/obsidian-spaced-repetition/algorithms/), [SR Reviewing](https://stephenmwangi.com/obsidian-spaced-repetition/flashcards/reviewing/) |
| Anki では FSRS は **opt-in**（デッキオプション下部の FSRS 節で有効化。既定は従来の SM-2 系）。「Next day starts at」の既定は 4AM。新規カードの既定は 1日 20 枚。親デッキを選ぶと子デッキのカードも出る。 | [Anki Deck Options](https://docs.ankiweb.net/deck-options.html), [Anki Preferences](https://docs.ankiweb.net/preferences.html), [Anki Getting Started](https://docs.ankiweb.net/getting-started.html), 20 枚：[LeanAnki](https://leananki.com/best-settings/) |
| Obsidian のタグは大文字小文字を区別せず、一般的な Unicode（日本語を含む）を許し、`/` で入れ子。数字だけのタグ（`#1984`）は無効。`tag:inbox` 検索は子タグも含む。 | [Obsidian Tags](https://obsidian.md/help/tags) |
| Obsidian Sync は `.` で始まるファイル/フォルダを同期しない（`.obsidian` を除く）。対応形式外のファイル（Vault 内の `.json` / `.jsonl` を含む）は「Sync all other types」を ON にしないと同期されない（既定 OFF）。 | [Sync settings](https://obsidian.md/help/sync/settings), [Accepted file formats](https://obsidian.md/help/file-formats) |
| community plugin のフォルダ（`data.json` を含む）は、Sync の「Installed community plugin list」を ON にした場合だけ同期される（既定 OFF）。 | [Obsidian Forum: Sync – Plugins, settings](https://forum.obsidian.md/t/obsidian-sync-plugins-settings-etc/85504), [Forum: How to start syncing plugin settings](https://forum.obsidian.md/t/how-to-start-syncing-plugin-settings-without-messing-them-up/114447)（フォーラムの証言。公式文書の明記はない） |
| Sync の競合解決：Markdown は diff-match-patch でマージ、その他のファイルは「last modified wins」、設定 JSON は「ローカル JSON のキーをリモートの上に適用」してマージ。1.9.7 以降は「Create conflict file」も選べる。 | [Sync troubleshoot](https://obsidian.md/help/sync/troubleshoot) |
| community plugin のアンインストールはプラグインフォルダ内のファイル（`data.json` を含む）を削除する。 | [Forum: My plugins will not delete #2](https://forum.obsidian.md/t/help-my-plugins-will-not-delete/26552/2), [Forum: Sync deletes all community plugin settings](https://forum.obsidian.md/t/obsidian-sync-deletes-all-community-plugin-settings-on-first-sync/48488)（フォーラムの証言） |
| `Plugin.loadData()/saveData()` はプラグインフォルダの `data.json` を読み書きする。`onExternalSettingsChange()` は Sync や外部プログラムが `data.json` を変えたときに呼ばれる。`PluginManifest.dir` はプラグインフォルダの Vault パス。`getAllTags(cache)`、`parseFrontMatterTags(frontmatter)`、`CachedMetadata.tags`（位置付き `TagCache[]`）、`CachedMetadata.blocks`（block ID → `BlockCache`）、`DataAdapter.append`、`Modal.scope` がある。 | `node_modules/obsidian/obsidian.d.ts`（obsidian 1.8.7） |
| ts-fsrs 5.4.2：MIT、runtime 依存なし、ESM/CJS/UMD 同梱、FSRS-6。`Rating` は Again=1/Hard=2/Good=3/Easy=4（Manual=0）。既定 `request_retention=0.9`、`maximum_interval=36500`、`enable_fuzz=false`、`enable_short_term=true`、learning steps `["1m","10m"]`。`rollback()`・`forget()` あり。browser 向け minify bundle は 21,411 B / gzip 6,768 B（import 範囲で多少変わる）で、`require(`・`process.` を含まない。 | `npm view ts-fsrs`（2026-10-02）、tarball の `dist/index.d.ts` / `dist/index.mjs`、esbuild での実測 |
| `enable_short_term=false` のとき New カードの初回間隔は Again 1日 / Hard 2日 / Good 3日 / Easy 8日（既定パラメータ）。 | ts-fsrs 5.4.2 を Node で実行して確認 |
| ts-fsrs は経過日数を **UTC の暦日差**（`dateDiffInDays`）で数え、期日は `date_scheduler` が「復習時刻 + 間隔 × 固定 24 時間」で計算する（夏時間の日は現地時刻が 1 時間ずれる）。 | ts-fsrs 5.4.2 `dist/index.mjs` |

【未検証】`loadData()` が壊れた JSON で例外を投げるか `null` を返すか。metadataCache が `%%` コメント内の `#tag` をタグとして数えるか。`CachedMetadata.blocks` のキーが大文字小文字を保つか。いずれも実装前に単体テスト/実機で確認する。

## 2. 決定 D1：デッキの作り方（タグ）

### D1-a どのタグをデッキとみなすか

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| A1 全タグ | ノートの全タグがデッキ候補。**採用済みカードを1枚以上含むデッキだけ**を一覧に出す。 | 設定ゼロ。既存の分類タグがそのままデッキ。カードの無いタグは出ない。 | カードのあるノートに `#todo` があれば「todo」デッキが出る。 |
| A2 接頭辞 `#flashcards` | 根タグ以下だけがデッキ（`#flashcards/医学/生理` → 医学/生理）。SR と同じ既定。 | SR からの移行が楽。ノイズゼロ。 | SR も同じノートを走査する（Kioku の `Q:`/`A:` は SR の `::`/`?` 構文ではないので SR はカードを見つけない見込み【未検証】）。 |
| A3 接頭辞 `#kioku` | Kioku 専用の根タグ。 | SR と干渉しない。 | 既存タグを流用できない。 |
| A4 A1 + 除外設定 | 「デッキにしないタグ」を設定。 | ゼロ設定と制御の両立。 | 設定 UI が増える。 |

**推奨案：A1。** A2〜A4 は後から設定として追加でき、保存形式に影響しない。SR との併用を重視するなら A2。

### D1-b タグの読み取り方と適用範囲

タグの文法は**自前で再実装しない**。frontmatter は `parseFrontMatterTags(cache.frontmatter)`、本文は `cache.tags`（位置付き）を使い、本文タグのうち位置が M1 の除外領域（コード、`%%`、HTML コメント、`$$`、Excalidraw 描画部）に入るものだけを `src/cards/regions` で落とす。これで数字だけのタグなど Obsidian が無効とするものは自然に除外される。

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| B1 ノート全体 | frontmatter + 本文（除外領域外）のタグが、そのノートの全カードに適用。 | 単純・予測しやすい。metadataCache だけで判定でき、実機テストも容易。 | 1ノート内で章ごとに別デッキにできない。 |
| B2 frontmatter のみ | `tags` プロパティだけ。 | 本文中の言及タグがデッキ化しない。 | 本文タグ派には直感に反する。 |
| B3 見出しセクション | 見出し配下のカードにだけ適用。 | 1ノート複数デッキ。 | 見出し階層の規則が必要で実装・テストが増える。 |
| B4 SR 互換 | 後続カードへ適用、カード1行目のタグはそのカード専用。 | SR から移行しやすい。 | 位置依存。`#tag Q: …` は M1 の問い行構文に一致しない。 |

**推奨案：B1。**

### D1-c 複数デッキのカード（提案）

- 複数タグのノートのカードはすべてのデッキに所属する案とする（各デッキの Total に数える）。
- 出題は1セッション1回とする案：キューはカード ID の集合で作り重複を除く。日程状態はカード ID ごとに1つなので、デッキ A で評価したカードはデッキ B でも同じ期日になる。

### D1-d 同じ `^kioku-<id>` が複数ノートにある場合

発生源：Obsidian Sync の conflict file、iCloud の「ノート 2.md」、テンプレートやノートの複製（M1 は同一ノート内の重複しか検出しない）。

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| X1 両方除外 | どちらも出題しない。理由と両パスを表示。 | 安全側。 | 同期の衝突コピーができるたびにカードが消えたように見える。 |
| X2 同じ ID = 同じカード、1回だけ出題。**有効な問い/答えが異なる場合だけ除外**し両パスを表示 | 内容が同じなら日程を共有して1回出題（表示・「ノートを開く」は先にソートされたパス）。 | 衝突コピーや複製で学習が止まらない。内容が違う本当の衝突だけ利用者に知らせる。 | 内容比較（空白正規化）が要る。 |
| X3 先に見つかった方を採用 | パス順で1つを採用。 | 単純。 | 別内容でも黙って片方が選ばれる。 |

**推奨案：X2。** ID は M1 が小文字で生成するが、比較は小文字に正規化して行う（手で大文字に書き換えられた場合の取り違え防止）。

## 3. 決定 D2：親子デッキと「全デッキ」入口

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| C1 親は子を含む | `#医学/生理` は「医学」の子。親を選ぶと子孫も出題（ID で重複除去）。 | Anki・SR・Obsidian の `tag:` 検索と同じ。 | 親の件数は一意カード数（集合演算）。 |
| C2 親は直付けのみ | 「医学」は `#医学` 直付けのカードだけ。 | 件数が単純。 | 慣習と異なる。 |
| C3 フラット | 入れ子を無視。 | 実装最小。 | 階層タグ利用者に不便。 |

全デッキ入口：E1 デッキの和集合（タグなしカードは件数表示のみ）／E2 タグなし擬似デッキも出題（実質 Vault 全体になり、受入条件で確定要件にしないとされた範囲に入る）。

**推奨案：C1 + E1。** タグの無いノートのカードは「デッキに属していないカード N 枚（ノートにタグを付けると出題されます）」と表示だけ行う。

## 4. 決定 D3：Due / New / Total と出題数

| 用語 | 推奨定義 |
| --- | --- |
| New | 採用済みで評価が一度も記録されていないカード。 |
| Due | 評価済みで、期日（Kioku 日、§5 D4-c）が今日以前のカード。 |
| Total | デッキに所属する一意カード数。内容の異なる ID 重複で除外したカードは別表示。 |

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| F1 New 上限なし | New を全部出す。 | 単純。 | 大量採用直後に負担。 |
| F2 1日の New 上限（全デッキ共通、既定 20、設定可）、Due は上限なし | Anki の既定値 20 と同じ。 | 学習負荷を制御。 | 「今日導入した New 数」の保存が必要。 |
| F3 入口を分ける | 「復習」と「新規学習」を別ボタン。 | 利用者が選べる。 | UI が複雑。 |

**推奨案：F2。** ピッカーの各行に Due / New / Total を出し、全体に「今日の新規残り X 枚」を1つ表示する。出題順は Due（期日が古い順）→ New（パス順、ノート内の出現順）。

## 5. 決定 D4：スケジューリング

### D4-a アルゴリズム

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| G1 FSRS（ts-fsrs 5.4.2 を固定で bundle） | fuzz 無効、既定パラメータ。 | Anki でも opt-in で提供される現行アルゴリズム。保持率で間隔を説明できる。MIT・依存なし・約 21 KB・Node API なし。 | **初の runtime 依存**：AGENTS.md / `docs/architecture.md` の「runtime dependency なし」、validate の固定 deps、build-info の検査、manifest の説明文・README の更新と、配布物への MIT 著作権表示が必要。版を上げると間隔計算が変わる。 |
| G2 SM-2（自前実装） | SM-2/SM-2-OSR 相当を 100 行程度で。 | 依存なし。SR の `<!--SR:` と同系統。決定的。 | 間隔の質は FSRS に劣るとされる。細部の仕様と保守を自分で持つ。 |
| G3 両対応 | `Scheduler` 抽象に G1/G2。 | 比較・移行可能。 | M2 の範囲を超える。 |

**推奨案：G1。** ts-fsrs は `src/review/scheduler.ts` の内側だけで使い、外へは Kioku の型（§8）だけを出す。fuzz は乱数で期日が揺れて検証が決定的でなくなるため無効。依存追加はユーザー承認後。

### D4-b 評価ボタン

H1 4段階（もう一度/難しい/普通/簡単、キー `1`–`4`、各ボタンに次回間隔のプレビュー）／H2 3段階（SR と同じ。失念を表現できない）／H3 2段階。**推奨案：H1。**

### D4-c 日付境界・タイムゾーン・夏時間

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| I1 ローカル 0 時 | 暦日どおり。 | 直感的。 | 0 時前後の学習で2日分が出る。 |
| I2 ローカル 4 時（設定可） | **0:00〜3:59 の評価・表示は前日扱い**。Anki の既定と同じ。 | 深夜学習に強い。 | 説明が1行増える。 |
| I3 UTC | ts-fsrs 内部と一致。 | 日本では 9:00 に日付が変わり不自然。 |

**推奨案：I2。** 期日の保存と判定は次のとおりにする案：

- 期日は時刻ではなく **Kioku 日のローカル日付文字列**（`dueDay: "2026-10-05"`）で保存し、`dueDay <= today` を Due とする。夏時間で `date_scheduler` の固定 24 時間がずれても日付は変わらない。
- ts-fsrs へ渡す `now` は実時刻ではなく「その Kioku 日の UTC 正午」（`Date.UTC(y, m, d, 12)`）に正規化する。こうすると ts-fsrs の UTC 暦日差が Kioku 日の差と一致し、0:00〜9:00（日本時間）のずれと夏時間の影響を受けない。`dueDay` は「正規化した now + scheduled_days」の UTC 日付から求める。実時刻は履歴の `at` に別途記録する。【未検証】この正規化で間隔が既定どおりになることは単体テストで固定する。

### D4-d 同日内の再出題

J1 日単位のみ（`enable_short_term=false`。1セッション1回、Again は翌日＝1日）／J2 ts-fsrs 既定の 1分/10分ステップ（同一セッションで再出題があり、「二重出題しない」の検証と区別が要る）。**推奨案：J1。**

### D4-e Skip

K1 書き込みなし・このセッションのキューから外す（次のセッションでは再び出る）／K2 キュー末尾へ回す／K3 Skip を履歴に記録（日程は変えない）。**推奨案：K1（キー `S`、答えの表示前後どちらでも可）。** 実機では Skip 前後で状態・履歴ファイルの bytes が変わらないことで確認できる。

## 6. 決定 D5：状態と履歴の保存先

カードの同一性は `^kioku-<id>`（ノート移動・改名・原文編集後も同じ）。

| 案 | 内容 | データ安全性 | 同期・競合 | 性能・サイズ | SR 互換 | コスト / 検証 |
| --- | --- | --- | --- | --- | --- | --- |
| S1 ノート内 | カード直後に `%%kioku-srs:…%%` や `<!--SR:…-->` を書き、評価ごとに更新。 | 評価のたびにノートを書き換え、M1 と同じ Canvas ガード・原文照合・**ディスク確認（3 秒 settle、最長 6 秒）と回復（最長 12 秒）**が毎回必要。1枚評価するごとに 3〜12 秒待つことになり、**復習 UI としては成立しない**。確認を省けば M1 で実機確認済みの上書き消失（Canvas・ホバー popover・他ビュー）をそのまま抱える。 | Markdown は diff-match-patch マージで、2端末で同じカードを評価するとコメントが重複/破損しうる。 | ノートの更新日時が学習で変わる。履歴を入れると肥大。 | `<!--SR:` 形式なら SR と相互運用の余地（SM-2 前提）。 | 高。 |
| S2 プラグインフォルダ | `data.json`（設定のみ、`saveData`）、`state.json`（カード状態）、`history-YYYY.jsonl`（評価の追記、`DataAdapter.append`）を `PluginManifest.dir` に置く。 | ノートに一切書かない。**アンインストール/再インストールで消える**（§1）。壊れた読込を「新規」と誤認して上書きする経路がある（§6.1 で対策）。 | 既定では同期されない＝**端末ごとに別の日程になるが失われない**。「Installed community plugin list」を ON にした場合だけ同期され、`data.json` はキー単位マージ、他ファイルは last modified wins【`state.json` の扱いは未検証】で他端末の評価が失われうる。`onExternalSettingsChange` は検知できても、マージで既に失われたキーは取り戻せない。 | 状態は全体書き直し（数千枚で数百 KB 程度）。履歴は追記のみ。目安 1件 約 80 B × 100 件/日 × 365 日 ≒ 3 MB/年を年ごとのファイルに分割。 | なし。 | 低〜中。公開 API のみで単体テストも容易。 |
| S3 Vault 内の単一ファイル | 例 `Kioku/kioku-data.json`。 | アンインストールで消えない。誤編集・削除されうる。 | `.json` は既定で同期されない（「Sync all other types」OFF）。ON でも last modified wins で他端末の評価が失われる。`.kioku/` 等の隠しフォルダは同期されない。 | 全体書き直し。 | なし。 | 中。 |
| S4 端末別の追記ログ（Markdown） | 例 `Kioku/log/<device-id>/2026-10.md` に評価イベントを1行ずつ追記し、状態は全ログを時刻順に再生して導出（キャッシュはプラグインフォルダ）。 | 追記のみ。プラグインを消しても残る。 | `.md` なので**既定で同期され**、端末ごとに別ファイルなので diff-merge でも衝突しにくい。2端末の評価は時刻順の再生で決定的に統合。 | 追記は軽い。再生コストは計測が必要【未検証】。月ごとに分割。 | なし。 | 高（device ID、再生規則、破損行）。**検索・グラフ・クイックスイッチャーに出る**（Obsidian の「除外するファイル」設定で隠せるが利用者の操作が要る）。 |

S2〜S4 はノートを書かないので、M1 の書き込み機構（Canvas ガード、ディスク確認、回復）は不要。

**推奨案：複数端末で同期して復習する予定がなければ S2、あるなら S4。** S2 の場合も履歴は追記型イベントとして状態と分けておき、後で S4 へ移せる形にする。

### 6.1 S2 のデータ消失経路と対策（推奨）

| 経路 | 対策 |
| --- | --- |
| 読み込み失敗（JSON 破損、`loadData` の `null`/例外）を「データなし＝新規」と誤認し、最初の評価の保存で全体を上書き | ファイルが**存在しない**（`adapter.exists` で確認）ときだけ新規扱い。存在するのに読めない/検証に失敗したら**読み取り専用モード**にし、評価ボタンを無効化して理由を表示する。**読めないものの上に書かない。** |
| 保存途中のクラッシュ・不正な書き込み | 各セッションの最初の保存前に現在の `state.json` を `state.json.bak` に複製する。書き込み後に読み戻して検証する。【未検証】`DataAdapter.write` の原子性は保証されないため、`.bak` からの復元手順を文書化する。 |
| 古い Kioku が新しい `schemaVersion` を読んで上書き（ダウングレード、別端末の旧版） | 未知の `schemaVersion` は読み取り専用。移行は新しい版だけが行う。 |
| アンインストール/再インストールで削除 | M2 では防げないことを README とデッキ選択画面の注記に明記する。エクスポート（Vault 内への書き出し）は後続の課題として起票する。 |
| Sync の JSON マージ・last modified wins | 「Installed community plugin list」ON の利用者には S4 を案内する（§14 C6）。 |

その他（推奨）：

- 読み込みは**デッキ選択画面を開いたとき**に行い、`onload` では読まない（M0/M1 の起動時 I/O なし方針と変異テストを維持）。
- **デッキ選択を開く・閉じるだけではファイルを作らない**。`state.json`・履歴・`data.json` は最初の評価で初めて作る。
- 評価1件ごとに保存を await し、成功を確認してから次のカードへ進む。失敗時は進めず理由を表示する。理由文は M1 の `reasons.ts` の方式（理由と前置きを分ける）に合わせて M2 用を追加する。
- 孤立状態（スキャンで ID が見つからない）は削除しない。ID が再出現（Undo、別ノートへの移動）すれば再接続される。掃除 UI は後続。
- `^kioku-…` を消して再採用したブロックは新しい ID＝新しいカードで、古い状態は孤立になる（M1 の規則どおり）。

## 7. 決定 D6：Q/A 編集後の履歴

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| L1 常に保持 | ID が同じなら日程・履歴を保持。履歴イベントに有効な問い/答えの内容ハッシュを記録。 | M1 の「編集しても同一カード」と一致。誤字修正で学習が消えない。 | 意味を大きく変えても古い間隔のまま。 |
| L2 自動リセット | ハッシュが変わったら New に戻す。 | 内容と記憶の整合。 | 空白変更でもリセット。予測しにくい。 |
| L3 保持 + 表示 + 手動リセット | 前回評価後に変わったカードに注記と「学習をリセット」。 | 利用者が選べる。 | UI・テストが増える。 |

**推奨案：L1（L3 の UI は後続）。**

## 8. データモデル案（型のスケッチ。決定後に確定）

```ts
// src/review/types.ts（Obsidian 非依存）
export type CardId = `kioku-${string}`;          // lowercase-normalized
export type Grade = 'again' | 'hard' | 'good' | 'easy';
export type CardPhase = 'new' | 'learning' | 'review' | 'relearning';
export type KiokuDay = string;                     // local "YYYY-MM-DD" after the day-start hour

export interface CardSchedule {
  readonly phase: CardPhase;
  readonly dueDay: KiokuDay;
  readonly stability: number;
  readonly difficulty: number;
  readonly reps: number;
  readonly lapses: number;
  readonly lastReviewDay: KiokuDay | null;
}

/** One rating event (append-only). Skip is never recorded (K1). */
export interface ReviewEvent {
  readonly cardId: CardId;
  readonly at: number;            // real time, UTC epoch ms
  readonly day: KiokuDay;
  readonly grade: Grade;
  readonly scheduledDays: number;
  readonly contentHash: string;   // effective Q/A at review time (D6)
  readonly deviceId?: string;     // S4 only
}

export interface KiokuStateV1 {     // state.json (settings live in data.json)
  readonly schemaVersion: 1;
  readonly cards: Readonly<Record<CardId, CardSchedule>>;
  readonly newIntroduced: { readonly day: KiokuDay; readonly count: number } | null; // F2
}

export interface KiokuSettingsV1 {  // data.json
  readonly schemaVersion: 1;
  readonly dayStartHour: number;    // I2, default 4
  readonly newPerDay: number;       // F2, default 20
}

// src/decks/types.ts
export interface ScannedCard {
  readonly id: CardId;
  readonly paths: readonly string[];   // >1 when the same ID is in several notes (D1-d)
  readonly question: string;           // effective (edit record wins)
  readonly answer: string;
  readonly decks: readonly string[];   // lowercase tag paths, e.g. "医学/生理"
}
export interface DeckNode {
  readonly path: string;               // "" = all decks (E1)
  readonly label: string;              // first-seen casing
  readonly children: readonly DeckNode[];
  readonly counts: { readonly due: number; readonly new: number; readonly total: number };
}
```

## 9. モジュール境界と性能

- `src/main.ts`：ribbon・コマンド・file-menu の登録、modal とストアの所有、`onunload` で閉じるだけ。
- `src/cards/`（M1、純粋）：parser・regions を読み取り専用で再利用。M2 はノートを書かない。
- `src/decks/`：`tags.ts`（純粋。`TagCache` の位置を除外領域で絞り、正規化・入れ子展開）、`index.ts`（純粋。所属、ツリー、ID 重複、件数）、`scan.ts`（Obsidian 依存。明示操作時だけ）。
- `src/review/`：`scheduler.ts`（ts-fsrs ラッパ）、`day.ts`（Kioku 日・正規化）、`queue.ts`（重複除去、New 上限、Skip）。純粋・決定的で時刻は引数。
- `src/store/`：`schema.ts`（純粋。検証・移行・読み取り専用判定）、`review-store.ts`（プラグインフォルダの I/O だけ）。
- `src/ui/deck-picker-modal.ts`、`src/ui/review-modal.ts`：公開 `Modal` API、scoped class、`Modal.scope`。
- runtime は公開 Obsidian API とブラウザ互換コードのみ。ts-fsrs を入れても external import は `obsidian` だけであることを build/package 検査で固定する。

性能（推奨）：`getMarkdownFiles()` を `metadataCache.getFileCache(file)?.blocks` に `kioku-` で始まるキーがあるノートだけに絞り、それだけを `cachedRead` して M1 parser にかける（タグはキャッシュから）。【未検証】箇条書き項目や編集記録付きブロックの ID が `blocks` に必ず入るかは実機で確かめ、漏れるなら絞り込みを「タグを持つノート」に広げる。**性能予算案**：5,000 ノート / 10,000 カードの生成 fixture でデッキ選択を開くまで 500 ms 以内（開発機）。実機で計測して `artifacts/` に記録し、超えたら `metadataCache` の `changed` で無効化するキャッシュを入れる。

## 10. 復習 UI フローとキーボード（D7）

1. 左 ribbon → 中央「デッキ選択」modal。行：デッキ（ツリー）・Due・New・Total。先頭に「全デッキ」。ID 重複・タグなしカード・読み取り専用モードの注記を下部に。
2. デッキを選ぶ → 同じ modal 内で復習画面。上部に「デッキ名・残り枚数」。
3. 「答えを表示」（Space / Enter）→ 評価ボタン「もう一度 / 難しい / 普通 / 簡単」（`1`–`4`、次回間隔つき）と「スキップ」（`S`）。
4. 評価 → 保存確認 → 次のカード。最後に「完了：評価 N 枚・スキップ M 枚」。
5. 途中で閉じる（×、Escape）→ 確認なしで閉じる。評価済みだけ保存済み、表示中の未評価カードは変化なし、再開機能なし。保存中に閉じた場合は保存の完了を待ってから結果を Notice で1回出す（M1 の確認待ち close と同じ考え方）。
6. 「ノートを開く」で `[[path#^kioku-…]]` へ移動（modal は閉じる）。

**二重評価を起こさない要件（推奨）**：

- Space/Enter はフォーカス中のボタンの click と `Modal.scope` のキー処理が二重に発火しうるため、キー処理側で既定動作を止め、1つの経路だけで処理する。
- キーリピート（`event.repeat`）は無視する。
- 保存中（評価を押してから保存確認まで）はすべての評価・スキップ入力を無視し、ボタンを無効化する。
- IME 変換中（`event.isComposing` または `event.key === 'Process'`）のキーは無視する。
- ボタンには読み上げ可能なラベル（`aria-label` にキーと次回間隔）を付け、答え表示後のフォーカスは「普通」に置き、Tab 順は表示順と一致させる。

問い/答えの表示（推奨：`MarkdownRenderer` で描画）の注意：問いに `![[…]]` 埋め込みがあると**答えまで表示してしまう**（例：自ノートの block や見出しの埋め込み）ことがあり、Dataview・Excalidraw などの重い post-processor が動く。回答前の面では埋め込みを描画しない（リンク文字として表示する）案を推奨し、実機で確認する。【未検証】`MarkdownRenderer.render` の component を modal close で unload する管理。

## 11. ribbon の役割とスモークテストへの影響（D8）

現行の M0/M1 smoke（`docs/harness.md`）は「ribbon で開く中央 modal の build ID/version が preflight と一致」を検査し、M1 の実機項目 1 は「状態 modal（ribbon）」を前提にしている。ribbon をデッキ選択に変えるとこれらが壊れる。

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| R1 ribbon → デッキ選択 | 状態（version/build ID）と抽出は、コマンド「フラッシュカード（状態）」、既存の file-menu「Kioku：問い・答えの候補を抽出」、デッキ選択画面のボタン（状態・抽出）から開く。デッキ選択 modal のルートにも version/build ID の data attribute を付け、smoke の identity 検査をこちらへ移す。 | 受入条件「左 ribbon→中央デッキ選択」どおり。 | smoke script と `docs/harness.md` の更新が M2 の作業に入る。 |
| R2 ribbon → 状態 modal（復習ボタン付き） | 現行のまま、状態 modal にデッキ選択への入口を足す。 | smoke 変更が少ない。 | 受入条件から1クリック増え、逸脱。 |

**推奨案：R1。** smoke の「開閉だけでファイルが変わらない」を保つため、デッキ選択の開閉ではノートもプラグインフォルダも書かない（§6.1）。現行 baseline は `.obsidian/` を対象外にしているので、M2 の smoke ではプラグインフォルダのファイル一覧・bytes を明示的に比較する項目を足す。file-menu は抽出のまま（現在ノートの復習は確定要件にしない）。

## 12. M2 実機検証チェックリスト（草案）

専用 Vault・baseline・screenshot・bytes を `artifacts/lev-276/` に残す。mock や preflight の成功を実機成功と呼ばない。

1. 起動直後（ribbon を押す前）にノートもプラグインフォルダも読み書きされない。
2. ribbon → デッキ選択の開閉・Escape でノート・プラグインフォルダの bytes とファイル一覧が変わらない（状態ファイルが作られない）。build ID/version が preflight と一致。
3. デッキ（入れ子・全デッキ）と Due/New/Total が fixture の期待値どおり。タグなし件数、ID 重複（同内容は1枚、異内容は除外と両パス）。
4. 2つのデッキタグを持つカードが、親・全デッキ・各デッキのどのセッションでも1回だけ。デッキ A で評価後、デッキ B で Due でない。
5. 評価で状態1件更新・履歴1件追記、ノート bytes 不変。
6. Skip では状態・履歴・ノートの bytes が一切変わらず、同セッションで再出題されず、開き直すと残っている。
7. 途中で閉じる・Escape：評価済み分だけ保存、表示中カードは変化なし。
8. Obsidian を終了 → 再起動で期日と Due/New/Total が再起動前と一致。`harness:update` 後も状態ファイルが残る。
9. 今日評価したカードが今日の Due に再び出ない（日付境界そのものは単体テストで固定）。
10. ブロックの別ノートへの移動・ノート改名後も日程が保持され、ブロック削除→Undo で日程が戻る。
11. 原文の問い/答えを編集後も日程・履歴が保持される。
12. `state.json` を壊した状態で開くと読み取り専用になり、評価できず、ファイルが上書きされない。
13. キーボード：Space/Enter、`1`–`4`、`S`、Escape。ボタンにフォーカスがある状態の Space、キー長押し、保存中の連打で二重評価されない（履歴の件数で確認）。IME 変換確定の Enter で評価されない。
14. 性能：生成 fixture でデッキ選択を開くまでの時間を記録する。

## 13. リスク

- runtime 依存の追加（G1）と、それに伴う文書・検査・ライセンス表記の更新漏れ。
- S2 のアンインストール時の消失と、Sync（ON の場合）での上書き。
- タグ判定が metadataCache と除外領域でずれると件数が直感と違う。
- Kioku 日の正規化を誤ると間隔が ±1 日ずれる。
- 大規模 Vault の走査時間。`blocks` による絞り込みの漏れ。
- `MarkdownRenderer` で答えが見える・重い描画が走る。
- ribbon 変更に伴う smoke の更新漏れで、build 識別の検査が効かなくなる。

## 14. ユーザーに決めてほしいこと

**A. デッキ**

1. **A1 デッキの作り方**：ノートの全タグ（frontmatter を含む。コード・コメント内は除く）をデッキにし、入れ子の親は子を含み、「全デッキ」はデッキの和集合、タグのないカードは件数表示のみ。**推奨：この案。**（代案：`#flashcards` 以下だけ／frontmatter のみ／見出し単位）
2. **A2 同じ ID が複数ノートにある場合**：同じカードとして1回だけ出題し、内容が異なるときだけ除外して両パスを表示。**推奨：この案。**（代案：常に両方除外）

**B. 復習**

3. **B3 アルゴリズム**：FSRS（ts-fsrs 5.4.2、初の runtime 依存）、4段階ボタン（キー 1–4）、同日内の再出題なし。**推奨：この案。**（代案：SM-2 自前・3段階・1分/10分ステップ）
4. **B4 日付と出題数**：日付の切り替えは 4:00（設定可）、New は全デッキ共通で 1日 20 枚、Due は上限なし、ピッカーに Due/New/Total を表示。**推奨：この案。**
5. **B5 Skip と途中終了**：Skip は `S`、何も保存せずこのセッションから外す。途中で閉じたら評価済みだけ保存、再開機能なし。**推奨：この案。**

**C. データ**

6. **C6 複数端末で同じ Vault を同期して復習する予定があるか**：なし → プラグインフォルダ（ノートは書かない）。あり → 端末別の追記ログ（Vault 内 Markdown）。**推奨：予定がなければ前者。**
7. **C7 データ消失対策を M2 に入れるか**：読めないときは書かない（読み取り専用）、保存前の `.bak`、未知の schemaVersion は読み取り専用。エクスポートは後続。**推奨：入れる。**
8. **C8 Q/A 編集後**：日程・履歴を保持し、内容ハッシュを記録（リセット UI は後続）。**推奨：この案。**

**D. UI**

9. **D9 ribbon と表示**：ribbon はデッキ選択を開く。状態（build ID）と抽出はコマンド・file-menu・デッキ選択画面のボタンから。smoke を更新する。問い/答えは Markdown で描画（回答前は埋め込みを描画しない）。**推奨：この案。**
