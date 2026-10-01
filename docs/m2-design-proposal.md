# M2（LEV-276）設計提案：タグデッキ・復習・日程と履歴

> **状態：提案（未決定）。** この文書は LEV-276 の「設計時に確定」とされた項目について、選択肢・トレードオフ・推奨案を並べたものである。**どれも決定ではない。** 決定はユーザーが行い、決定後に `docs/product-plan.md` / `docs/architecture.md` へ「M2 で決めたこと」として転記する。M2 は未実装であり、この文書はデッキ・復習・日程が実装済みであることを意味しない。
>
> 前提：M1（LEV-275、ブランチ `lev-275-m1-explicit-qa` @ bca8240、未マージ）の保存形式。採用済みカードは Q/A ブロック最終行末の ` ^kioku-<[0-9a-z]10文字>`（ランダム ID、内容ハッシュではない）で識別され、ポップアップ編集時は直後の `%%kioku-edit:kioku-…` コメントが有効な問い/答えになる（M1 `docs/architecture.md`「保存形式と安定 ID」）。

## 0. 受入条件（LEV-276、原文）

「左 ribbon→中央デッキ選択→問い→回答を表示→評価→次回日程。Skip は評価なしで飛ばす操作と分ける。タグ適用範囲、親子デッキ、全デッキ入口、Due/New/Total、FSRS/SM-2、状態・履歴保存、Q/A編集後の履歴は設計時に確定。未回答の現在ノート/Vault全体を確定要件にしない。再起動後に日程を保持し、複数デッキ所属のカードを二重出題しない。」

この文書の読み方：

- 「現在ノートだけ復習」「Vault 全体を復習」の入口は**確定要件にしない**（受入条件どおり）。「全デッキ」入口（§2）はデッキの和集合であり Vault 全体とは別物として扱う。
- 各決定は「問い → 選択肢 → 推奨案」の順。評価軸は ①Obsidian 内のデータ安全性、②Obsidian Sync / iCloud での端末間同期・競合、③大きな Vault での性能、④既存 Spaced Repetition（以下 SR）プラグインとの互換、⑤実装コスト、⑥専用 Vault 実機ハーネスでの検証しやすさ。
- 【未検証】と付けたものは公式文書・ソースで確認できていない推定。実装前または実機で確かめる。

## 1. 調査で確認した事実（出典）

| 事実 | 出典 |
| --- | --- |
| SR プラグインの既定デッキタグは `#flashcards`。`#flashcards` は `#flashcards/subdeck/subdeck` のような入れ子にも一致する。 | [SR Decks](https://www.stephenmwangi.com/obsidian-spaced-repetition/flashcards/decks/) |
| SR では「タグはファイル内で次のタグが現れるまで、その後のすべてのカードに適用」され、カード1行目先頭のタグはそのカード専用。複数デッキ所属は同じ行に複数タグを並べる。フォルダをデッキにする設定もある。 | 同上 |
| SR はスケジュールをノート内 HTML コメント `<!--SR:!2024-08-16,51,230-->`（期日, 間隔, ease）で保存し、既定はカード直後の行、設定で同じ行。単一スケジュールファイルは「計画中」。設定は `data.json`。 | [SR Data Storage](https://stephenmwangi.com/obsidian-spaced-repetition/data-storage/) |
| SR のアルゴリズムは SM-2 ベースの「SM-2-OSR」で Hard/Good/Easy の3段階。FSRS は「Planned」。 | [SR Algorithms](https://stephenmwangi.com/obsidian-spaced-repetition/algorithms/) |
| SR の復習画面には Skip（`S` キー）、Reset、Space/Enter で答え表示、`1`–`3` で評価。親デッキを選ぶと子デッキを含む。 | [SR Reviewing](https://stephenmwangi.com/obsidian-spaced-repetition/flashcards/reviewing/) |
| Obsidian のタグは大文字小文字を区別せず、Unicode（日本語・絵文字を含む「一般的な Unicode 文字」）を許し、`/` で入れ子。`tag:inbox` 検索は子タグも含む。 | [Obsidian Tags](https://obsidian.md/help/tags) |
| Obsidian Sync は `.` で始まるファイル/フォルダを同期しない（設定フォルダ `.obsidian` を除く）。追加のファイル種別は「Sync all other types」で同期する。 | [Sync settings](https://obsidian.md/help/sync/settings) |
| Obsidian Sync の競合解決：Markdown は diff-match-patch でマージ、その他のファイルは「last modified wins」、設定ファイル（JSON）は「ローカル JSON のキーをリモートの上に適用」してマージ。1.9.7 以降は「Create conflict file」も選べる。 | [Sync troubleshoot](https://obsidian.md/help/sync/troubleshoot) |
| `Plugin.loadData()/saveData()` はプラグインフォルダの `data.json` を読み書きする。`onExternalSettingsChange()` は Sync や外部プログラムが `data.json` を変えたときに呼ばれる。`PluginManifest.dir` はプラグインフォルダの Vault パス。`getAllTags(cache)` は frontmatter と本文のタグをまとめて返す。`Modal.scope` でキー割り当てできる。 | リポジトリ `node_modules/obsidian/obsidian.d.ts`（obsidian 1.8.7） |
| ts-fsrs 5.4.2：MIT、runtime 依存なし、ESM/CJS/UMD 同梱、`engines.node >=20`（パッケージのビルド/実行要件。Kioku の bundle 内では Node API を使わない）。FSRS-6。`Rating` は Manual=0/Again=1/Hard=2/Good=3/Easy=4、`State` は New/Learning/Review/Relearning。既定 `request_retention=0.9`、`maximum_interval=36500`、`enable_fuzz=false`、`enable_short_term=true`、learning steps `["1m","10m"]`、relearning `["10m"]`。`rollback()`・`forget()` あり。 | `npm view ts-fsrs`（2026-10-02）と tarball の `dist/index.d.ts` / `dist/index.mjs` を直接確認 |
| ts-fsrs を esbuild（`--platform=browser --format=cjs --minify`、`fsrs/createEmptyCard/Rating` のみ使用）で bundle すると約 21.3 KB、gzip 約 6.7 KB。bundle に `require(` と `process.` は含まれない。 | 本調査で scratchpad にて実測（Kioku の build recipe とは別。採用時に本番 recipe で再計測する） |
| ts-fsrs は経過日数を **UTC の暦日差**（`dateDiffInDays` が `getUTCFullYear/Month/Date` を使う）で数え、期日は「復習時刻 + 間隔日数」の時刻付き `Date`。 | ts-fsrs 5.4.2 `dist/index.mjs`（`dateDiffInDays`, `date_scheduler`） |
| Anki の「Next day starts at」は既定 4AM。真夜中前後の学習で2日分が1セッションに出ないため。親デッキを選ぶと子デッキのカードも出る。 | [Anki Preferences](https://docs.ankiweb.net/preferences.html), [Anki Getting Started](https://docs.ankiweb.net/getting-started.html) |

【未検証】Obsidian Sync が `.obsidian/plugins/<id>/data.json` を同期するか（「Installed community plugin list」等の設定との関係）は公式文書に明記が見当たらない。community plugin をアンインストールするとプラグインフォルダ（`data.json` を含む）が削除されるかも未確認。いずれも実機で確かめるまでは「同期されない/消える可能性がある」前提で設計する。metadataCache がコードブロック・`%%` コメント内の `#tag` をタグとして数えるかも未確認（Kioku は M1 の除外領域で自前に再判定できる）。

## 2. 決定 D1：デッキになるタグと適用範囲

### D1-a どのタグをデッキとみなすか

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| A1 全タグ | ノートの全タグ（frontmatter `tags` + 本文 `#tag`）がデッキ候補。**採用済みカードを1枚以上含むデッキだけ**を一覧に出す。 | 設定ゼロ。既存の分類タグ（`#生理学`）がそのままデッキ。カードの無いタグは出ないので `#todo` 等のノイズは限定的。 | カードのあるノートに `#todo` が付けば「todo」デッキが出る。SR とタグの意味が異なる。 |
| A2 接頭辞タグ（既定 `#flashcards`） | 設定した根タグ以下だけがデッキ（`#flashcards/医学/生理` → 医学/生理）。SR と同じ既定値。 | SR と同じ書き方で移行しやすい。ノイズゼロ。 | SR も同じノートを走査する（Kioku の `Q:`/`A:` は SR の `::` / `?` 構文ではないため SR 側はカードを見つけない見込み【未検証】が、空デッキ表示等の相互作用はあり得る）。カードごとに接頭辞を書く手間。 |
| A3 接頭辞タグ（既定 `#kioku`） | A2 と同じ仕組みで根タグを Kioku 専用に。 | SR と干渉しない。ノイズゼロ。 | 既存タグを流用できず、ユーザーがタグを付け直す必要。 |
| A4 A1 + 除外リスト設定 | A1 に「デッキにしないタグ」設定を足す。 | ゼロ設定と制御の両立。 | 設定 UI が M2 に増える。 |

**推奨案：A1（全タグ、カードを含むデッキだけ表示）。** 理由：受入条件の「タグのデッキ」を設定なしで満たし、利用者の既存タグ運用をそのまま使える。ノイズはカードを含むタグに限られる。A4 の除外設定や A2/A3 の接頭辞モードは、使ってみてノイズが問題になった時点で後から追加できる（データ形式に影響しない）。SR との併用を重視するなら A2。

### D1-b タグの適用範囲

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| B1 ノート全体 | ノートのタグ（frontmatter + 本文のどこでも）が、そのノートの全カードに適用。 | 単純・予測しやすい。`metadataCache` の `getAllTags` で高速に絞り込める。実機テストが容易。 | 1ノート内で章ごとに別デッキにしたい場合に表現できない。 |
| B2 frontmatter のみ | `tags` プロパティだけがデッキ。本文 `#tag` は無視。 | 本文中の言及タグ（「#重要」等）がデッキ化しない。Properties UI で管理しやすい。 | 本文タグ派の利用者には直感に反する。 |
| B3 見出しセクション | 見出し行（または直下）のタグが、その見出し配下のカードに適用。frontmatter はノート全体。 | 1ノート複数デッキを自然に表現。 | 見出し階層の規則（子見出しへの継承、同名見出し）を決める必要。実装・テストが増える。 |
| B4 SR 互換（後続カードへ適用 + カード1行目タグはそのカード専用） | SR と同じ規則。 | SR から移行しやすい。 | 規則が位置依存で、タグを動かすとデッキが変わる。カード1行目のタグは `Q:` marker と行頭が競合（`#tag Q: …` は M1 の問い行構文に一致しない）。 |

**推奨案：B1（ノート全体）。** M2 では位置依存の規則を持たず、テストと説明を単純にする。本文タグは M1 の除外領域（コード、`%%`、HTML コメント、`$$`、Excalidraw 描画部）内のものを数えない（metadataCache の挙動が未検証なので Kioku の `regions` で再判定する）。B3 は将来「1ノート複数デッキ」の要望が出たら追加検討。

### D1-c 複数のデッキタグを持つノートのカード

- 複数タグのノートのカードは**すべてのデッキに所属**する（Total には各デッキで数える）。
- **出題は1セッション1回**：セッションのキューはカード ID（`kioku-…`）の集合で作り重複を除く。日程状態はカード ID ごとに1つなので、デッキ A で評価したカードはデッキ B でも同じ期日になり、別セッションでも二重に Due にならない。
- 同じ `^kioku-<id>` が**複数のノート**に現れる場合（ノートの複製など。M1 は同一ノート内の重複だけを検出する）は、どちらを正とするか決められないため両方を「ID 重複」として出題から除外し、デッキ選択画面に件数と理由を表示する（M1 の同一ノート内 ID 重複と同じ方針）。これは決定事項ではなく推奨で、§13 の質問に含める。

## 3. 決定 D2：親子デッキと「全デッキ」入口

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| C1 入れ子タグでツリー、親は子を含む | `#医学/生理` は「医学」の子。親を選ぶと子孫のカードも出題（ID で重複除去）。 | Anki・SR と同じ（§1）。Obsidian の `tag:` 検索とも一致。 | 親の件数は子の単純合計ではなく一意カード数（実装で集合演算が必要）。 |
| C2 ツリー表示だが親は自分のタグのカードだけ | 「医学」は `#医学` 直付けのカードのみ。 | 件数が単純。 | Anki/SR/Obsidian の慣習と異なり驚きが大きい。 |
| C3 フラット一覧 | 入れ子を無視して全タグを並列表示。 | 実装最小。 | 階層タグ利用者に不便。 |

「全デッキ」入口：

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| E1 デッキの和集合 | 何らかのデッキに属するカード全部（ID で重複除去）を1セッションに。 | 受入条件の「全デッキ入口」を最小の定義で満たし、Vault 全体（タグなしカードを含む）とは区別できる。 | タグの無いノートのカードは復習できない。 |
| E2 和集合 + 「タグなし」擬似デッキ | E1 に加えてタグの無いノートのカードを「（タグなし）」として表示。 | 取りこぼしが無い。 | 実質的に Vault 全体入口になり、受入条件で「確定要件にしない」とされた範囲に踏み込む。 |

**推奨案：C1 + E1。** 加えて、タグの無いノートに採用済みカードがある場合はデッキ選択画面に「デッキに属していないカード N 枚（ノートにタグを付けると出題されます）」と表示だけ行う（出題はしない）。

## 4. 決定 D3：Due / New / Total の定義と表示

前提：期日判定は「Kioku の1日」で行う（§5 D4-c の日付境界）。

| 用語 | 推奨定義 |
| --- | --- |
| New | 採用済みで、**評価が一度も記録されていない**カード（ts-fsrs の `State.New`）。 |
| Due | 評価済みで、`due` が「今日の Kioku 日の終わり」より前のカード（＝今日中に期日が来るもの。期日を過ぎたものを含む）。 |
| Total | デッキに所属する一意カード数（New + Due + 期日がまだ先のもの）。ID 重複で除外したカードは含めず別表示。 |

選択肢として決めてほしい点：

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| F1 New 上限なし | セッションに New を全部出す。 | 単純。 | 大量採用直後に New が数百枚出て負担。 |
| F2 1日の New 上限（既定 20） | 1日に出す New 数を上限（設定値。Anki の新規カード上限に相当し、既定 20 は Anki の既定値に合わせた想定【未検証】）。上限は全デッキ共通で「今日出した New 数」を保存して数える。 | 学習負荷を制御。 | 「今日導入した New 数」の保存と日付境界が必要。デッキごと上限にするか決める必要。 |
| F3 New を出さない入口と分ける | 「復習（Due のみ）」と「新規学習」を別ボタンに。 | 利用者が選べる。 | UI が複雑。 |

**推奨案：F2（全デッキ共通、既定 20 枚/日、設定で変更）。** ピッカーの各行は「Due / New / Total」を数字で表示し、New は上限適用前の実数を出したうえで「今日の新規残り X 枚」を全体に1つ表示する。出題順は Due（期日が古い順）→ New（ノート内の出現順、ノートはパス順）を推奨。Due の上限は設けない。

## 5. 決定 D4：スケジューリング

### D4-a アルゴリズム

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| G1 FSRS（ts-fsrs を bundle） | ts-fsrs 5.4.2 を固定バージョンで依存に追加し、esbuild で `main.js` に同梱。fuzz 無効、パラメータ既定値。 | 現代的で Anki 標準の FSRS。保持率（既定 0.9）で間隔を説明できる。MIT、依存なし、実測 約 21 KB min / 6.7 KB gzip、bundle に Node API なし。`rollback`/`forget` が使える。 | **初の runtime 依存**（M0 の「runtime dependency はない」を変える。external は `obsidian` のままだが、validate の固定 deps と build-info の扱いを更新する必要）。将来の FSRS 版数変更で間隔計算が変わる。経過日数が UTC 暦日（§1）なので日付境界との整合が要る。 |
| G2 SM-2（自前実装） | SM-2/SM-2-OSR 相当を `src/review/` に 100 行程度で実装。 | 依存なし。SR と同系統で `<!--SR:` の値（期日, 間隔, ease）へ変換しやすい。決定的で単体テストが簡単。 | 間隔の質は FSRS に劣るとされる。Again の扱い・ease 下限など細部を自分で決めて保守する必要。 |
| G3 抽象化して両対応 | `Scheduler` インターフェースに G1/G2 を実装し設定で切替。 | 移行・比較が可能。 | M2 の範囲を大きく超える。状態形式が2種類になりテストが倍。 |

**推奨案：G1（FSRS / ts-fsrs、`enable_fuzz=false`、既定パラメータ、バージョン固定）。** ただし `src/review/scheduler.ts` の内側だけで ts-fsrs を使い、外部へは Kioku 自身の型（§8）だけを出す。こうすれば後から G2/G3 へ差し替えても保存形式の境界は保てる。依存追加は AGENTS.md・validate の更新を伴うため、ユーザー承認後に行う。fuzz を有効にすると乱数で期日が揺れ、実機・単体テストの期待値が決定的でなくなるため M2 では無効を推奨。

### D4-b 評価ボタン

| 案 | 内容 | 備考 |
| --- | --- | --- |
| H1 4段階 Again/Hard/Good/Easy（もう一度/難しい/普通/簡単） | キー `1`–`4`。各ボタンに次回間隔のプレビュー（ts-fsrs `repeat()` で4通り計算）。 | FSRS/Anki 標準。 |
| H2 3段階 Hard/Good/Easy | SR と同じ。 | FSRS では Again が無いと失念を表現できない。 |
| H3 2段階 Again/Good | 迷いが少ない。 | Hard/Easy の情報が失われる。FSRS は動作する。 |

**推奨案：H1。**

### D4-c 日付境界とタイムゾーン

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| I1 ローカル深夜 0 時 | 端末のローカル時刻で日付を区切る。 | 直感的。 | 0 時前後に学習すると2日分が出る。 |
| I2 ローカル 4 時（設定可） | Anki の既定（§1）。「今日の Kioku 日」は前日 4:00〜当日 4:00 ではなく、当日 4:00〜翌日 4:00。 | 深夜学習に強い。Anki 利用者に馴染む。 | 説明が1行増える。 |
| I3 UTC | 実装が ts-fsrs の内部と一致。 | 日本では 9:00 に日付が変わり不自然。 |

**推奨案：I2（ローカル 4:00、設定で 0〜23 時）。** Due 判定は「`due` < 次の境界時刻」で行う。保存する時刻はすべて UTC の epoch ミリ秒（タイムゾーン変更や端末間差に強い）。ts-fsrs 内部の経過日数は UTC 暦日で数えられるため、日本時間 0:00〜9:00 の評価で経過日数が実感と ±1 日ずれることがある（間隔計算への影響は小さいが、テストでは境界時刻を固定する）。【未検証】ts-fsrs に `review_time` を「Kioku 日の開始に丸めた時刻」で渡す方式でこのずれを消せるかは実装時に単体テストで確認する。

### D4-d 学習ステップ（同日内の再出題）

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| J1 日単位のみ（`enable_short_term=false`） | Again でも次回は最短で翌 Kioku 日。1セッションで同じカードは1回だけ。 | セッションの規則が単純で「二重出題しない」の検証と矛盾しない。 | 忘れたカードを同日に再確認しない（Anki の習慣と違う）。 |
| J2 ts-fsrs 既定ステップ（1分/10分） | Again/Hard 後に数分後に再出題。セッション中に期日が来たら末尾に戻す。 | Anki に近い学習体験。 | 同一セッションで同じカードが再び出るため、「複数デッキによる二重出題」と区別した表示・テストが必要。セッションを閉じた後の Learning カードの扱いが増える。 |

**推奨案：J1（M2 は日単位のみ）。** J2 は M2 後の改善候補とする。

### D4-e Skip

推奨する意味（D4 の一部としてユーザー確認）：

- Skip は**評価を記録せず、日程状態を変えず、履歴にも何も書かない**（ストレージ書き込みゼロ）。そのカードはこのセッションのキューから外れ、同じセッションでは再出題しない。次のセッションでは Due/New のまま再び出る。
- 選択肢：K1 上記（書き込みなし・セッションから除外）／K2 キュー末尾へ回す（セッション内でもう一度出る）／K3 Skip イベントを履歴に記録（日程は変えない）。
- **推奨案：K1。** 「評価と分ける」を最も明確にでき、実機では Skip 前後でストレージ bytes が変わらないことを確認すればよい。K3 は統計が要る段階で追加可能。
- Skip は答えの表示前後どちらでも可能。キーは `S`（SR と同じ）。

## 6. 決定 D5：状態と履歴の保存先

前提：カードの同一性は `^kioku-<id>`（ランダム、ノート内で一意、移動・改名・編集後も同じ）で取る。M1 の M0 方針「起動時にノートを読まず書かない」は維持する。

| 案 | 内容 | データ安全性 | 同期・競合 | 性能・サイズ | SR 互換 | 実装コスト / 検証 |
| --- | --- | --- | --- | --- | --- | --- |
| S1 ノート内（SR 風コメント） | カード直後に `%%kioku-srs:…%%` や `<!--SR:…-->` を書き、評価ごとに更新。履歴もノート内か別。 | 評価のたびにノートを書き換える。M1 と同じ Canvas ガード・ディスク確認・外部編集照合が評価ごとに必要。編集中ノートへの書き込みは Undo 履歴に混ざる。 | Markdown は diff-match-patch マージ（§1）。2端末で同じカードを評価すると両方のコメントが残る/壊れる可能性。 | ノートの変更が増え、ファイル更新日時が学習で変わる。履歴を入れるとノートが肥大。 | `<!--SR:!date,interval,ease-->` 形式なら SR と相互運用の余地（SM-2 前提。FSRS 状態は表現できない）。 | 高（M1 の書き込み機構を毎評価で使う）。実機検証項目が多い。 |
| S2 プラグイン `data.json`（`saveData`） | `{ schemaVersion, settings, cards: {id: state}, history: [...] }` を保存。 | ノートに一切書かない。アンインストールでプラグインフォルダごと消える可能性【未検証】。 | `.obsidian` 配下。Obsidian Sync での同期は未確認【未検証】。同期される場合、JSON マージは「ローカルのキーをリモートに上書き」（§1）なので `cards` を1キーにまとめると他端末の評価が失われうる。iCloud は衝突コピーの可能性【未検証】。 | 評価ごとにファイル全体を書き直す。履歴を数年分入れると MB 単位（目安：1件 約 80 B × 100件/日 × 365 日 ≒ 3 MB/年）。 | なし。 | 低。`loadData/saveData` だけで単体テストのモックも容易。実機では `data.json` bytes で確認できる。 |
| S3 Vault 内の単一ファイル（例 `Kioku/kioku-data.json`） | 見えるフォルダに JSON を置き `Vault.process` で更新。 | アンインストールで消えない。ユーザーのバックアップ対象に自然に入る。ユーザーが誤って編集・削除しうる。 | `.json` は Obsidian の対応形式外（[File formats](https://obsidian.md/help/file-formats)）で、Obsidian Sync では「Sync all other types」が必要と推定【未検証】。「last modified wins」で他端末の評価が失われる。`.kioku/` のような隠しフォルダは Obsidian Sync で同期されない（§1）。 | S2 と同じく全体書き直し。 | なし。 | 中。保存先の作成・ユーザー操作への耐性が必要。 |
| S4 端末別・追記専用ログ + 再計算（イベントソーシング） | 評価イベントを端末ごとのファイル（例 `Kioku/log/<device-id>/2026-10.jsonl`）に追記し、日程状態は全ログを時刻順に再生して導出（キャッシュは `data.json`）。 | 追記のみで既存データを書き換えない。消えても他端末のログから復元可能。 | 端末ごとに別ファイルなので書き込み競合が起きにくい。2端末で同じカードを評価しても両方のイベントが残り、時刻順の再生で決定的に統合できる。拡張子の同期対象は S3 と同じ懸念【未検証】。 | 追記は軽い。起動時でなくデッキ選択時の再生は数万件でも数十 ms 程度の見込み【未検証】。月ごとのファイル分割で肥大を抑える。 | なし。 | 高。device ID、再生規則、ログ破損行の扱い、キャッシュ整合が必要。 |

**推奨案：S2（`data.json`）を M2 の保存先とし、形式は S4 へ移行できるよう「カード状態 + 追記型の履歴イベント」に分ける。** 理由：M2 は PC 主体（`docs/product-plan.md`）で、ノートを一切書き換えないことが最も安全であり、`saveData` は公開 API だけで済み、再起動後の日程保持を最小コストで満たす。S1 は評価のたびに M1 と同等の書き込みリスクを負うため推奨しない。

ただし次の条件付き：**複数端末で同じ Vault を同期して復習する予定がある場合は S4 を推奨**（S2 は同期時に他端末の評価を上書きで失う可能性がある）。§13 の 6 でユーザーに確認する。

S2 採用時の詳細（推奨）：

- 読み込みは**最初にデッキ選択画面を開いたとき**に行う（起動時 `onload` では読まない。M0/M1 の「起動時 I/O なし」方針と、起動時 I/O 禁止の変異テストを維持するため）。
- 評価1件ごとに `saveData` を await し、保存成功を確認してから次のカードへ進む。失敗時はカードを進めず理由を表示する（評価済みと誤表示しない）。
- `onExternalSettingsChange` で外部変更を検知したら、セッション中でなければ再読込し、セッション中なら次の保存前に再読込してカード単位でマージ（`lastReviewedAt` が新しい方を採用）する。
- 履歴が大きくなった場合の扱い（全件保持 / 直近 N 件 / 年ごとに別ファイル `${manifest.dir}/history-2026.jsonl` へ `adapter.append`）は M2 では全件保持を推奨し、サイズは実機で計測する。
- **孤立（orphan）**：スキャンで ID が見つからないカードの状態は削除しない（ブロック削除の Undo、別ノートへの移動、ノート改名で ID が再出現すれば自動的に再接続される。ID が鍵なので移動・改名は状態に影響しない）。デッキ件数には含めない。孤立状態の掃除は M2 では UI を作らず、後続で「孤立データ N 件」の表示と手動削除を検討。
- ユーザーが `^kioku-…` を消して再採用した場合は新しい ID＝新しいカード（M1 の規則どおり）で、古い状態は孤立になる。

## 7. 決定 D6：Q/A 編集後の履歴

編集の経路は2つ：ノート原文を直接編集（ID は残る）／M1 ポップアップや後続機能で `%%kioku-edit%%` を追加・更新。

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| L1 常に保持 | ID が同じなら日程・履歴を保持。 | M1 の「編集しても同一カード」と一致。誤字修正で学習がリセットされない。実装最小。 | 問いの意味を大きく変えても古い間隔のまま。 |
| L2 編集で自動リセット | 有効な問い/答えの内容ハッシュを状態に持ち、変わったら New に戻す（ts-fsrs `forget`）。 | 内容と記憶状態の整合。 | 誤字修正・空白変更でもリセット。Obsidian 外の編集でも勝手にリセットされ予測しにくい。 |
| L3 保持 + 変更を表示 + 手動リセット | 評価時の内容ハッシュを履歴に記録し、前回評価から内容が変わったカードは復習画面に「前回の復習後に編集されています」と表示、「学習をリセット」ボタンで New に戻せる。 | 自動で失わず、意味が変わったときは利用者が選べる。 | UI とテストが少し増える。 |

**推奨案：L1 を既定とし、履歴イベントに有効内容のハッシュを記録しておく（L3 の表示・リセット UI は M2 では作らず、後から追加可能にする）。** リセット UI を M2 に入れたい場合は L3。

## 8. データモデル案（型のスケッチ。決定後に確定）

```ts
// src/review/types.ts（Obsidian 非依存）
export type CardId = `kioku-${string}`;
export type Grade = 'again' | 'hard' | 'good' | 'easy';
export type CardPhase = 'new' | 'learning' | 'review' | 'relearning';

/** Scheduling state per card. Times are UTC epoch milliseconds. */
export interface CardSchedule {
  readonly phase: CardPhase;
  readonly due: number;
  readonly stability: number;
  readonly difficulty: number;
  readonly reps: number;
  readonly lapses: number;
  readonly lastReviewedAt: number | null;
}

/** One rating event (append-only). Skip is never recorded (K1). */
export interface ReviewEvent {
  readonly cardId: CardId;
  readonly at: number;            // UTC epoch ms
  readonly grade: Grade;
  readonly before: CardPhase;
  readonly scheduledDays: number;
  readonly contentHash: string;   // effective Q/A at review time (D6)
  readonly deviceId?: string;     // only if S4 is chosen
}

export interface KiokuDataV1 {
  readonly schemaVersion: 1;
  readonly settings: { readonly dayStartHour: number; readonly newPerDay: number };
  readonly cards: Readonly<Record<CardId, CardSchedule>>;
  readonly history: readonly ReviewEvent[];
  readonly newIntroduced: { readonly day: string; readonly count: number } | null; // F2
}

// src/decks/types.ts
export interface ScannedCard {
  readonly id: CardId;
  readonly path: string;          // note path at scan time (not identity)
  readonly question: string;      // effective (edit record wins)
  readonly answer: string;
  readonly decks: readonly string[]; // normalized lowercase tag paths, e.g. "医学/生理"
}
export interface DeckNode {
  readonly path: string;          // "" = all decks (E1)
  readonly label: string;
  readonly children: readonly DeckNode[];
  readonly counts: { readonly due: number; readonly new: number; readonly total: number };
}
```

タグの正規化：先頭 `#` を除き、Obsidian と同じく大文字小文字を区別しない（小文字化して比較し、表示は最初に見つかった表記）。

## 9. モジュール境界（AGENTS.md と M1 構成に合わせる）

- `src/main.ts`：ribbon とコマンドの登録、modal とストアの所有、`onunload` で閉じるだけ。ribbon は「デッキ選択」を開く（受入条件「左 ribbon→中央デッキ選択」）。M1 の抽出はコマンドと、デッキ選択画面の補助ボタンから開く案を推奨（§13 の 15）。
- `src/cards/`（既存、純粋）：M1 parser を読み取り専用で再利用し、有効な問い/答えと `^kioku-` ID を得る。M2 はノートを書かない。
- `src/decks/`：`tags.ts`（純粋。frontmatter/本文タグの抽出、除外領域での再判定、正規化、入れ子展開）、`index.ts`（純粋。カード→デッキ所属、ツリー、ID 重複検出、件数）、`scan.ts`（Obsidian 依存。`metadataCache.getFileCache` + `getAllTags` で候補ノートを絞り、`vault.cachedRead` で本文を読んで parser に渡す。明示操作時だけ）。
- `src/review/`：`scheduler.ts`（ts-fsrs のラッパ。外へは §8 の型だけ）、`day.ts`（日付境界）、`queue.ts`（セッションキュー、ID 重複除去、New 上限、Skip）。すべて純粋・決定的で、時刻は引数で受け取る。
- `src/store/`：`schema.ts`（純粋。検証・移行・マージ）、`review-store.ts`（`Plugin.loadData/saveData` か選んだ保存先の I/O だけ）。
- `src/ui/deck-picker-modal.ts`、`src/ui/review-modal.ts`：公開 `Modal` API、scoped class、キー割り当ては `Modal.scope`。
- runtime は公開 Obsidian API とブラウザ互換コードのみ。ts-fsrs を採用する場合も bundle に Node API が入らないことを build/package の検査（external import 一覧）で固定する。

性能：デッキ選択を開くたびに、`metadataCache` からタグを持つ Markdown ファイルだけを列挙し、その本文だけを `cachedRead` して M1 parser にかける。数千ノート規模で体感遅延がないかは実機計測【未検証】。必要ならセッション中は結果をメモリに保持し、`metadataCache` の `changed` で無効化する（M2 では「開くたびに再走査」を推奨し、キャッシュは計測結果次第）。

## 10. 復習 UI フロー（D7）

1. 左 ribbon → 中央「デッキ選択」modal。行：デッキ名（ツリー、折りたたみ）・Due・New・Total。先頭に「全デッキ」。Due+New が 0 のデッキは選べるが「今日の出題はありません」を表示。ID 重複・タグなしカードの件数を下部に表示。
2. デッキを選ぶ → 同じ modal 内で復習画面へ（modal を入れ替えない）。上部に「デッキ名・残り枚数」、本文に問い（Markdown として表示するかは下記）。
3. 「答えを表示」（Space / Enter）→ 答えを表示し、評価ボタン「もう一度 / 難しい / 普通 / 簡単」（`1`–`4`、各ボタンに次回間隔）と「スキップ」（`S`）。答え表示前でもスキップ可。
4. 評価 → 保存成功を確認 → 次のカード。最後に「完了：評価 N 枚・スキップ M 枚」を表示。
5. 途中で閉じる（×、Escape）→ 確認ダイアログなしで閉じる。評価済みのカードは保存済み、表示中の未評価カードは何も変わらない（Skip と同じ）。セッションの再開機能は持たず、次回開くと Due/New から再計算される。
6. 「ノートを開く」リンクで元ノートのブロック（`[[path#^kioku-…]]`）へ移動可能（復習 modal は閉じる）。

決めてほしい細部：問い/答えを `MarkdownRenderer` で描画する（リンク・数式・画像が出る）か、プレーンテキストにするか。**推奨：MarkdownRenderer で描画**（ノートと同じ見た目）。ただし描画中のリンク・埋め込みがノートを開く等の副作用を持たないことを実機で確認する。【未検証】`MarkdownRenderer.render` の component 管理（modal close で unload）を実装時に確認する。

## 11. M2 実機検証チェックリスト（草案）

既存ハーネス（`docs/harness.md`）と同じく、専用 Vault・baseline・screenshot・bytes を `artifacts/lev-276/` に残す。mock や preflight の成功を実機成功と呼ばない。

1. 起動直後（ribbon を押す前）に、ノートも `data.json`（または選んだ保存先）も読み書きされない（baseline と bytes 一致）。
2. ribbon → 中央にデッキ選択。期待デッキ（入れ子・全デッキ）と Due/New/Total が fixture の期待値どおり。タグなしカード件数・ID 重複件数の表示。
3. 2つのデッキタグを持つノートのカードが、親デッキ・全デッキ・各デッキのどのセッションでも**1回だけ**出る。デッキ A で評価後、デッキ B を開くとそのカードは Due でない。
4. 問い → 答え表示 → 評価で、保存先に1件の状態更新と1件の履歴が増え、ノート bytes は変わらない。
5. Skip では保存先・ノートの bytes が一切変わらず、同セッションで再出題されず、閉じて開き直すと Due/New に残っている。
6. 途中で閉じる・Escape：評価済み分だけ保存され、表示中カードは変化なし。エラーなし。
7. Obsidian を終了 → 再起動 → デッキ選択で前回評価したカードの期日が保持され、Due/New/Total が再起動前と一致。
8. 日付境界：システム時刻を変えられない場合は単体テストで固定し、実機では「今日評価したカードが今日の Due に再び出ない」ことを確認。
9. カードのブロックを別ノートへ移動・ノート改名後も日程が保持される。ブロック削除で件数から消え、Undo で戻すと日程が復活する（孤立状態の再接続）。
10. 原文の問い/答えを編集後も日程・履歴が保持される（L1 の場合）。L3 の場合は表示とリセット。
11. ノートを複製して同じ ID が2ファイルに出ると、両方が出題から除外され理由が表示される。
12. 保存失敗の模擬は実機で再現困難なため単体テストで固定し、実機では扱わないことを記録に明記する。
13. キーボード（Space/Enter、1–4、S、Escape）がすべて動く。IME 変換中のキー入力で誤評価しないかは M4 の範囲だが、気づいた点は記録する。

## 12. リスク

- **runtime 依存の追加（G1）**：M0 の「runtime dependency なし」、validate の固定 deps、build-info の external 検査、ライセンス表記（MIT の著作権表示を配布物に残す）の更新が必要。
- **`data.json` の消失・上書き（S2）**：アンインストール時の削除【未検証】、Sync での JSON キー単位マージによる他端末評価の消失【未検証】。バックアップ/エクスポートの導線が M2 にはない。
- **タグ判定のずれ**：metadataCache と Kioku の除外領域判定が異なると、デッキ件数が直感と違う。Kioku 側で再判定して一貫させる。
- **UTC 暦日とローカル日付境界のずれ**（§5 D4-c）：境界付近で間隔が ±1 日。単体テストで固定。
- **大規模 Vault の走査時間**：開くたびの再走査が遅い場合はキャッシュが必要【未検証】。
- **複製ノートの ID 重複**：M1 は同一ノート内しか検出しない。M2 で Vault 横断の検出が必要。
- **SR との併用**：A2（`#flashcards`）を選ぶと SR も同じノートを走査する。相互作用は実機で確認。
- **MarkdownRenderer の副作用**：埋め込み・リンク・プラグイン描画が modal 内で動く。

## 13. ユーザーに決めてほしいこと

1. **デッキになるタグ**：A1 全タグ（カードを含むものだけ表示）／A2 `#flashcards` 以下（SR 互換）／A3 `#kioku` 以下／A4 全タグ + 除外設定。**推奨：A1。**
2. **タグの適用範囲**：B1 ノート全体／B2 frontmatter のみ／B3 見出しセクション／B4 SR 互換（後続カードへ）。**推奨：B1（除外領域内のタグは数えない）。**
3. **複製などで同じ `^kioku-` ID が複数ノートにある場合**：両方除外して理由表示／先に見つかった方を採用。**推奨：両方除外して表示。**
4. **親子デッキと全デッキ**：C1 親は子を含む + E1 全デッキ＝デッキの和集合（タグなしカードは件数表示のみ）／C2・C3／E2 タグなし擬似デッキ。**推奨：C1 + E1。**
5. **New の上限**：F1 なし／F2 1日 20 枚（全デッキ共通・設定可）／F3 入口を分ける。**推奨：F2。** Due/New/Total の定義は §4 の案でよいか。
6. **複数端末で同じ Vault を同期して復習するか**（保存先の判断に直結）。**推奨：M2 は PC 1台前提で S2。複数端末なら S4。**
7. **状態・履歴の保存先**：S1 ノート内／S2 `data.json`／S3 Vault 内単一ファイル／S4 端末別追記ログ。**推奨：S2（形式は S4 へ移行可能に分ける）。**
8. **アルゴリズム**：G1 FSRS（ts-fsrs 5.4.2 を bundle、fuzz 無効、初の runtime 依存）／G2 SM-2 自前／G3 両対応。**推奨：G1。**
9. **評価ボタン**：H1 4段階（もう一度/難しい/普通/簡単、キー 1–4）／H2 3段階（SR 同様）／H3 2段階。**推奨：H1。**
10. **日付境界**：I1 ローカル 0 時／I2 ローカル 4 時（設定可）／I3 UTC。**推奨：I2。**
11. **同日内の再出題**：J1 日単位のみ（1セッション1回）／J2 1分・10分の学習ステップ。**推奨：J1。**
12. **Skip の意味**：K1 書き込みなし・このセッションから外す／K2 キュー末尾へ／K3 Skip を履歴に記録。**推奨：K1（キー `S`）。**
13. **Q/A 編集後の履歴**：L1 常に保持（内容ハッシュは記録）／L2 自動リセット／L3 保持 + 変更表示 + 手動リセット。**推奨：L1（L3 は後続）。**
14. **途中で閉じたとき**：確認なしで閉じ、評価済みのみ保存・再開機能なし、でよいか。**推奨：はい。**
15. **ribbon の役割と M1 抽出の入口**：ribbon をデッキ選択にし、抽出はコマンド + デッキ選択画面のボタンへ移す。**推奨：はい。**
16. **問い/答えの表示**：MarkdownRenderer で描画／プレーンテキスト。**推奨：MarkdownRenderer。**
