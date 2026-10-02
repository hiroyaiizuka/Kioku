# FSRS とは

> Kioku の復習（M2）は FSRS で次回の日程を決めます（2026-10-02 決定、M2 で実装。専用 Vault での実機確認はまだです）。このページは、Kioku が何を使い、なぜそれを選んだかの説明です。設計の詳細は [`m2-design.md`](m2-design.md) にあります。

## ひとことで

FSRS（Free Spaced Repetition Scheduler）は、**「このカードを今どのくらいの確率で思い出せるか」を推定し、その確率が目標（Kioku では 90%）まで下がるころに次の復習を入れる**仕組みです。Anki でも選んで使えるアルゴリズムで、オープンソースで開発されています（[ABC of FSRS](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/ABC-of-FSRS)）。

## たとえ

覚えたことは、水を入れたバケツの小さな穴から少しずつ漏れていくようなものです。

- **思い出せる確率（Retrievability, R）**：今バケツにどれだけ水が残っているか。
- **安定性（Stability, S）**：穴の小ささ。R が 100% から 90% に下がるまでの日数で表します。復習に成功するたびに穴が小さくなり、次の復習までの間隔が伸びます。
- **難しさ（Difficulty, D）**：そのカード自体の覚えにくさ。難しいカードほど、復習しても穴が小さくなりにくくなります。

FSRS は評価（もう一度 / 難しい / 普通 / 簡単）のたびにこの3つを更新し、「水位が 90% まで下がる日」を次回の日程にします（定義の出典：[ABC of FSRS](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/ABC-of-FSRS)）。

## なぜ SM-2 ではなく FSRS か

SM-2 は古くから使われている方式で、Anki の従来方式や Obsidian の Spaced Repetition プラグインの既定方式（SM-2-OSR）の元になっています。Kioku は次の理由で FSRS を選びました。

- **同じ記憶率なら復習が少なくて済む**：FSRS プロジェクトの解説（ABC of FSRS、awesome-fsrs wiki）によるシミュレーションでは、同じ記憶率を保つのに SM-2 より **20〜30% 少ない復習**で済むとされています（[ABC of FSRS](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/ABC-of-FSRS)）。Anki のマニュアルも「どれだけ忘れそうかをより正確に見積もることで、同じ時間でより多くを覚えられる」と説明しています（[Anki Deck Options](https://docs.ankiweb.net/deck-options.html)）。
- **記憶の予測が正確**：約 1 万人の Anki 利用者による約 7.27 億件のデータセット（評価には 9,999 コレクション・約 3.5 億件を使用）のベンチマーク（[srs-benchmark](https://github.com/open-spaced-repetition/srs-benchmark)）で、**利用者ごとにパラメータを最適化した** FSRS-6（recency）は、Anki の SM-2 より予測誤差（log loss）が小さい利用者が **99.6%** でした（[Benchmark of spaced repetition algorithms](https://expertium.github.io/Benchmark.html)）。
  - Kioku の M2 は最適化せず**標準パラメータ**を使います。標準パラメータの FSRS-6 は最適化した FSRS-6 より誤差が大きいものの、Anki の SM-2 よりは小さいと報告されています（log loss：FSRS-6 標準 0.3468、最適化 0.3215、Anki-SM-2 0.490。[srs-benchmark README、2025 年 5 月版 commit 2e1a76a](https://github.com/open-spaced-repetition/srs-benchmark/blob/2e1a76a/README.md)）。
- **復習が遅れても破綻しにくい**：予定より遅れて復習した場合の扱いも SM-2 より良いとされています（[ABC of FSRS](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/ABC-of-FSRS)）。
- **他のツールも採用を進めている**：Anki では FSRS を選んで有効にでき（既定は従来方式）、Obsidian の Spaced Repetition プラグインも 1.15.0（2026-05-24）で FSRS を選択式で追加しました（[SR 1.15.0](https://github.com/st3v3nmw/obsidian-spaced-repetition/releases/tag/1.15.0)）。
- **実装が軽く、ライセンスが明確**：Kioku は FSRS の開発プロジェクト open-spaced-repetition による TypeScript 実装 ts-fsrs 5.4.2（MIT、他の依存なし、FSRS-6）を使います。ブラウザ向けに圧縮して約 21 KB（gzip 約 7 KB）で、Obsidian の中だけで動きます（Kioku 開発時の実測）。

## 注意点

- **比較には限界があります**：SM-2 はもともと「思い出せる確率」を出す方式ではないため、ベンチマークでは後から換算式を付けて比べています。ベンチマークの作者自身が「FSRS と SM-2 を完全に公平に比べる方法はない」と述べています（[Benchmark](https://expertium.github.io/Benchmark.html)）。
- **最初は標準のパラメータです**：FSRS は自分の復習記録に合わせてパラメータを調整（最適化）するとさらに合いやすくなりますが、そのためには自分の復習記録がある程度たまっている必要があります（Anki のマニュアルは、復習数が少ない（数百件未満）とうまく働かないことがあると説明しています。[Anki Deck Options](https://docs.ankiweb.net/deck-options.html)）。Kioku の M2 は標準パラメータで始め、最適化は後の段階で検討します。
- **同じ日に同じカードはもう一度出ません**：Kioku は「もう一度」を押したカードも次回は翌日以降にします（同日内の再出題なし）。初めてのカードの次回は、標準パラメータで「もう一度」1日後・「難しい」2日後・「普通」3日後・「簡単」8日後です（ts-fsrs 5.4.2 で確認）。
- **目標の記憶率は 90%**：Anki の既定と同じです（[Anki Deck Options](https://docs.ankiweb.net/deck-options.html)）。上げると復習が増え、下げると忘れるカードが増えます。M2 では変更できません。
- **日付の切り替えは朝 4 時**：深夜 0 時〜3 時 59 分の復習は前日分として数えます（設定で変更可）。
- **ライブラリの版で日程の計算が変わることがあります**：Kioku は ts-fsrs の版を固定し、版を上げるときは記録に残します。

## Kioku が保存するもの

将来パラメータを最適化できるよう、**評価のたびに1件の記録**を Vault の `Kioku/` フォルダ（名前は設定で変更可）に追記します。ノート本文は書き換えません。

- カード ID（`^kioku-…`）、評価した日時と日付、評価（1〜4）、前回からの日数、次回までの日数、評価後の安定性と難しさ、そのときの問い・答えの内容ハッシュ、使ったアルゴリズムの版。
- 「スキップ」は記録しません。
- 各カードの現在の日程は `Kioku/state.json`、評価の記録は `Kioku/history-<年>.jsonl` に保存します。日程のファイルが消えた場合は記録から作り直せます。壊れて読めない場合は、上書きして記録を失わないよう書き込みを止めて理由を表示します。
- 問い・答えを編集しても、そのカードの記録と日程はそのまま残ります。

詳しい形式と安全策は [`m2-design.md`](m2-design.md) の「保存」を参照してください。
