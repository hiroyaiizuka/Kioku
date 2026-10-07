# Kioku アーキテクチャ

## Runtime の基本（M0 から、M2 で更新）

`src/main.ts` は plugin lifecycle、ribbon・command・file-menu・設定タブの登録、modal の所有だけを行う。起動（`onload`）はノート、Vault、`Kioku/`、プラグインの `data.json`、workspace state、ネットワーク、Node/Electron API、他プラグイン API へ触れない。設定（`data.json`）は最初に必要になったとき（デッキ選択・設定タブ）に読む。M1 のノート読み書きと M2 の走査・保存は、後述の明示操作時だけ。

**ribbon（M2 から）**：左 ribbon「フラッシュカード」はデッキ選択 modal（`src/ui/deck-picker-modal.ts`）を開く。その root（`.kioku-deck-picker-modal`）は version と build ID を data attribute に持ち、実機 smoke が今の配布物を識別できる。状態 modal（`src/ui/startup-modal.ts`、version/build ID と実装状況）はコマンド「フラッシュカード（状態）」とデッキ選択の「状態」ボタンから開く。同じ `StartupModal` instance を再利用し、unload 時に閉じる。実装済み範囲と未実装（M3 部分実装の時点では AI の一部）を UI 自身が明示する。

**runtime dependency（M2 から）**：ts-fsrs 5.4.2（MIT、推移依存なし）だけを exact pin し、`main.js` に bundle する（external は `obsidian` のまま）。ts-fsrs は `src/review/scheduler.ts` の内側だけで使う。ts-fsrs はモジュール評価時に `Date.prototype` へ4つの非推奨 helper を代入するため、`src/review/fsrs-guard.ts` が import 前の descriptor を記録し、import 直後に元へ戻す（Obsidian の共有 window を汚さない。ts-fsrs 自身はそれらを使わない）。

## Build identity と配布物

production esbuild は browser/CJS/ES2021、external は `obsidian` だけ。bundle する依存（ts-fsrs）の MIT 著作権表示と許諾文を `main.js` 先頭のコメントに残す。build ID は `src/`、manifest、package/lock、Node/TS/build script、styles、bundle する依存の `package.json`・`dist/index.mjs`・`LICENSE` の SHA-256 一覧から導く。validate は runtime dependency が `{"ts-fsrs": "5.4.2"}` ちょうどで、lock・インストール済み版・MIT・推移依存なしが一致することを検査し、build-info は `bundledDependencies` を記録する。`dist/kioku/` は `main.js`、`manifest.json`、`styles.css`、`build-info.json` の4ファイルだけ。build-info は入力、3 plugin file の hash、external import を記録する。自分自身の hash は自己参照になるため持たず、preflight は build-info bytes を dist と installed で比較する。

## Tooling trust boundary

Node は `scripts/` とテストだけ。全 CLI は引数で任意 path を受けず、real project root からの実行を要求する。書き込み先の全 existing path component について project containment、symlink、file hard link、型を確認し、一時ファイルから atomic rename する。これは誤操作/既存 link に対する防御で、同一ユーザーの敵対的 concurrent filesystem mutation まで完全に防ぐものではない。Vault 更新中は専用インスタンスを `harness:quit` で止める。プロジェクト外へ触れるのは、利用者の app-support にある `obsidian-*.asar` の読み取り、Obsidian 実行ファイルの専用 profile での起動、専用 `--user-data-dir` を command line に持つことを `ps` で確認した記録 PID への SIGTERM だけで、プロセスを名前で探したり終了したりしない。起動された Obsidian 自身は通常起動と同様に利用者の login keychain 項目と `~/.obsidian-cli.sock`（macOS では HOME 固定）を使う（`docs/harness.md`）。

`harness:prepare` は Vault が少しでも存在すれば拒否する。生成 marker が完全一致する Vault のみ update/preflight できる。update は4配布物だけを atomic update し、Markdown と `.obsidian/community-plugins.json` を含む既存 config を変更しない。preflight は enablement が厳密に `["kioku"]` であることも確認する。

## M1 明示 Q/A（LEV-275）

M1 は「開いているノート（または選択範囲）に人が書いた明示 Q/A を候補として示し、人が採用したものだけを元ノートに印付けする」までを行う。デッキ、復習、日程、AI は扱わない。以下は M1 で決めた設計であり、コードより先に固定する。

### 明示 Q/A の構文

行頭（任意で `- ` / `* ` / `+ ` の list marker を1つ許す）に次の marker がある行を対象にする。半角/全角コロンの両方を受け付け、コロン後の空白は任意。

| 役割 | marker |
| --- | --- |
| 問い | `Q:` `Q：` `Ｑ:` `Ｑ：` `問:` `問：` |
| 答え | `A:` `A：` `Ａ:` `Ａ：` `答:` `答：` |

1. 問い行から1ブロックが始まる。問い行と答え行の間の行は問いの続き、答え行以降の行は答えの続き（複数行の答え、答え内の箇条書きを含む）。
2. ブロックは空行、見出し行（`#`〜`######`）、水平線/setext 下線（`---` `***` `___` `===`）、次の問い行、2つ目の答え行、除外領域の開始、文書末で終わる。
3. 答え行が無い、または問い/答えが空のブロックは候補にしない。インデントされた行頭 marker、引用/callout（`>`）内、表内の Q/A は M1 の対象外。
4. 問い/答えの本文は marker 後の文字列を前後 trim し、続き行は行末だけ trim して `\n` で連結する。ブロック末尾の block ID（` ^id`）は本文に含めない。

判定は行単位の決定的な関数で、正規表現の lookbehind を使わない。CRLF/LF/CR を行区切りとして扱い、offset は元文字列の UTF-16 offset を保つ。

### 除外領域（原文は一切変更しない）

- 文書先頭の frontmatter（1行目 `---` から次の `---` / `...` まで。閉じない場合は frontmatter とみなさない）。
- fenced code block（行頭空白の後の ```` ``` ```` / `~~~` 3文字以上。閉じは同じ文字で開始以上の長さ。閉じなければ文書末まで）。保守的に、インデントされた fence も除外する。
- Obsidian comment（`%%`）。行内で開いて閉じる `%%…%%` はその行だけ影響せず、閉じずに行をまたぐ comment は開始行〜閉じ行を除外する（行内の `%%` 個数の奇偶で判定）。Excalidraw の `%%` 内 `## Drawing` と compressed-json はここで除外される。
- HTML comment（`<!--` 〜 `-->`）。1行で閉じるものはその行に影響せず、閉じない `<!--` から `-->` を含む行までを除外する。
- 数式ブロック（`$$`）。行内の `$$` 個数が奇数の行で開閉し、その間を除外する（`$$x$$` のような1行の数式は影響しない）。
- 先頭の UTF-8 BOM は frontmatter 判定と1行目の問い marker 判定で無視する（offset は BOM を含む元文字列のまま）。
- Excalidraw ノート（frontmatter に `excalidraw-plugin` key がある）は、最初の `# Excalidraw Data` / `# Text Elements` / `# Drawing` / `## Drawing` / `# Embedded files` 見出し行から文書末までを除外する。描画要素のテキストを採用して `^id` を付けると描画データを壊すためである。

除外領域内の Q/A は候補に出ず、採用時の書き込み位置にもならない。Kioku が書く編集記録（後述）も `%%` 内にあるため再抽出されない。

### 保存形式と安定 ID

採用時に限り、元ブロックの**最終行の行末**へ ` ^kioku-<10文字>` を1つ追記する。元の問い/答えの文字列は書き換えず削除もしない。

- Obsidian の block ID 構文なので Reading view では非表示、Live Preview では控えめに表示され、`[[ノート#^kioku-…]]` で参照できる。M2 は metadataCache の block 情報か同じ parser でカードを辿れる。
- ID は `kioku-` + `[0-9a-z]` 10文字。`crypto.getRandomValues` と rejection sampling で生成し（36^10 通り）、同じノート内の既存 `^kioku-` ID と衝突すれば作り直す。内容ハッシュではないため、採用後に問い/答えを編集しても同一カードのまま。
- **空行の挿入（ユーザー決定）**：ブロック（編集記録を足す場合は編集記録）の直後の行が空行でも文書末でもない（次の `Q:`、2つ目の `A:`、`---`、本文、fence など）場合、改行を1つ追加してちょうど1行の空行を作る。block ID は段落末にないと Obsidian の block ID として扱われず Reading view に文字として出るため、また `A: …` の直後の `---` が setext 見出しになるのを防ぐためである。挿入するのは ` ^kioku-<id>`（と編集記録）と改行だけで、原文の文字は変えない。編集の有無で規則は同じ。例外として、ブロックが箇条書き項目の中にある（問い行・答え行・最終行のいずれかが `- ` `* ` `+ ` `1. ` `1) ` の項目。項目に続く lazy continuation 行を含む）うえで次の行も箇条書き項目なら、編集なしの採用では空行を入れない（各項目が独立した block なので ID は有効で、空行は tight list を loose list に変えてしまうため）。編集記録を挿入する場合は編集記録自体が独立した block なので、この例外は使わず、次の行が空行/文書末でなければ必ず空行を入れる。箇条書きの場合、`^kioku-…` が参照するのは最終行を含む項目だけで、`[[ノート#^kioku-…]]` の埋め込みには問い行が含まれない。M2 はカード内容を block 参照ではなく Kioku 自身の parser で読む。候補ポップアップは、空行を追加するブロックにその旨を表示する。
- **改行コード（ユーザー決定）**：閉じたノート（`Vault.process` 経路）では、挿入する改行を対象ブロック最終行の改行（LF/CRLF 混在ノートでもそのブロックのもの）に合わせ、文書末で改行がない場合だけノート最初の改行に合わせる。Source / Live Preview で開いたノート（Editor 経路）では改行コードは Obsidian の編集画面に従う（Reading view だけで開いたノートは `Vault.process` 経路）。Obsidian 1.14.3 は Source/Live Preview で読み込んだノートを LF で扱い、保存時にノート全体を LF にする（Kioku を無効にしても同じ。2026-10-01 実機の対照実験、`artifacts/lev-275/m1-native-gap/RECORD.md`）。Kioku はこれを仕様として受け入れ、Editor 経路では editor が返す本文の改行（実際には LF）で挿入する。保証するのは「Kioku 自身が改行コードの混在を作らない」ことと「改行以外の原文の文字を変えない」ことである。
- 最終行が既に別の block ID（`^foo`）で終わるブロックは、1ブロック1 ID の制約で印を付けられないため「採用不可（既存 block ID）」と表示し書き込まない。

ポップアップで問い/答えを編集して採用した場合も原文は保持し、ID 追記に加えて直後に空行と Obsidian comment の編集記録を挿入する（Reading view では非表示）。編集記録の1行目は `%%kioku-edit:<card-id>` で、`<card-id>` は block ID と同じ `kioku-` 付きの値（例 `kioku-k3j9x2m4pq`）。正規表現では `^%%kioku-edit:(kioku-[A-Za-z0-9-]+)[ \t]*$`、本文は `Q: …` / `A: …`（Kioku の parser で読める形）、閉じは単独行の `%%`。`%%` comment 内の行だけを編集記録として読み、コードブロック内の同じ文字列は無視する。

```text
Q: 光合成とは？
A: 光で糖を作る反応 ^kioku-k3j9x2m4pq

%%kioku-edit:kioku-k3j9x2m4pq
Q: 光合成とは何か？
A: 光エネルギーで CO2 と水から糖を作る反応
%%
```

編集記録の本文は同じ parser で読み戻して完全一致するものだけを許す（空行、行頭 Q/A marker、見出し、fence 行（```` ``` ```` / `~~~`）、`$$`、`<!--` / `-->`、`%%`、`^kioku-` を含む編集は UI で理由を出して拒否）。直後の行が空行でなければ上記の規則で空行を1つ補う。改行コードは上記「改行コード」の規則に従う。挿入は常に1箇所・1回の変更である。

### 再抽出時の重複判定

- 最終行に `^kioku-<id>` があるブロックは **採用済み**。採用ボタンを出さず、編集記録があれば有効な問い/答えとして表示する。原文が後から編集されても ID が残る限り同一カードである。
- 同じ `^kioku-<id>` がノート内に2つ以上ある（ブロックの複製）場合はどちらも **ID 重複** として採用不可にする。
- ID の無い候補の問い/答え（空白正規化後）が、同じノートの採用済みカードの有効内容と一致する場合は **採用済みと同じ内容** と警告する。誤操作でなく意図的な重複もあり得るため、採用自体は可能にする。
- ユーザーが `^kioku-…` を消した場合、そのブロックは新しい候補に戻る（以前の ID とは別カード）。M1 では採用取り消し UI を持たず、取り消しは Undo かユーザーによる ID 削除で行う。

見出し名は位置特定に使わない。候補は抽出時のブロック offset と原文（ID を除くブロック全文）を記録する。

### 書き込み経路

採用ボタンを押した候補1件ごとに、書き込み直前に**その時点の本文から再抽出**して原文照合する。

1. 記録 offset に同じ原文の未採用候補があればそこ。無ければ、同じ原文の未採用候補が本文中にちょうど1つのときだけそこ（上方の外部編集で位置がずれた場合）。0個、または同名見出し配下などで同じ原文が複数あり特定できない場合は書き込まず、Notice とカード内表示で理由を出す。既に採用済み（他のビュー/別操作で ID 付与済み）なら二重採用しない。
2. ノートを**編集中の** MarkdownView（`getMode() === 'source'`、つまり Source / Live Preview）があれば、その `editor.getValue()` で照合し、`editor.transaction` の1変更で挿入する。未保存の編集を含むエディタ内容を正とし、Undo/Redo は1回の採用が1ステップになる。同じファイルの他ビューは Obsidian が同期する。
3. 閉じている、または **Reading view だけ**で開いている場合は `app.vault.process` の callback 内で照合と挿入を行う。照合に失敗したら受け取った文字列をそのまま返し、変更しない。Reading view の MarkdownView も内部に editor を持つが、それは保存される文書ではなく、書き込んでも失われる（2026-10-01 実機で確認した不具合）。Reading view はファイル変更時に Obsidian が再描画する（private API は使わない）。
4. 成功は書き込みを確認してからだけ表示する。Editor 経路は transaction 後もビューが `source` モードで、`getValue()` が計画した結果と完全一致すること、`Vault.process` 経路は callback が計画どおりの内容を返し、`process` の戻り値がそれと一致することを確認する。確認できない・例外が出た場合は「採用しました」を出さず、理由を表示する。
5. **Canvas ガード（書き込み前）**：どちらの経路でも、書き込む前に開いている `canvas` leaf（`workspace.getLeavesOfType('canvas')`）を調べ、その `.canvas` ファイルを `vault.cachedRead` で読んで公開 JSON 形式の `nodes` に `type: 'file'` かつ `file` が対象ノートのパスであるノードがあれば、書き込まずに「Kioku：保存しませんでした。このノートは開いている Canvas（…）に埋め込まれています。Canvas を閉じてから採用してください。」と表示する。Canvas JSON を読めない場合も安全側で拒否する。Canvas のファイルノードは独自の editor を持ち、未保存のバッファを後から保存して我々の書き込みを上書きする（Obsidian 1.14.3 の実機で、Kioku なしの `vault.process` でも再現。`artifacts/lev-275/m1-full-764c855/RECORD.md` C4）。
6. **ディスク確認（書き込み後）**：書き込みが成功しても、すぐには「採用しました」を出さず、カードを「保存を確認しています…」の状態にする（その間は他の採用ボタンも無効）。Editor 経路では公開 API `view.save()` で先に保存を確定させる。その後 250 ms ごとに `vault.read` でファイルを読み、Kioku の parser で `^<card-id>` が採用済みブロックとして存在するかを調べ、書き込みから 3 秒（settle）経過した時点でも存在すれば成功とする。6 秒（deadline）までに確認できなければ「保存後に ID が見つかりません。別の画面の保存で上書きされた可能性があります。」と警告し、カードを未採用に戻す。他候補の offset は確認できた採用でだけずらすため、再採用は通常どおり照合からやり直せ、二重挿入しない。確認待ちはポップアップを閉じる/プラグインを unload すると `AbortController` で取り消し、timer を残さない。書き込み済みで未確認のまま閉じた場合は、黙って消えないよう「保存の確認前に閉じました。もう一度抽出して採用済みか確認してください。」を1回だけ Notice で出す。unload（プラグイン無効化・アプリ終了）では見えないか煩わしいため出さない（`closeSilently`）。
7. **検出できないもの**：公開 API で列挙できるのは workspace の leaf と、最後にフォーカスされた editor 1つ（`workspace.activeEditor`）だけである。ページプレビューのホバー popover、他プラグインの独自ビュー、外部アプリが同じノートを編集中で後から保存するケースは事前に検出できない。実機（`artifacts/lev-275/m1-final-bca8240/RECORD.md` hover）では、popover は Reading split を開いた時点で既に閉じており、未保存バッファの保存だけが遅れて走った。閉じた popover の editor はどの公開 API からも到達できず、`activeEditor` は「最後にフォーカスされた editor」でしかないため、そこへ書くと破棄済み editor への書き込みになり得る。よって (a)「popover の editor 経由で書く」は採らず、(b) の回復を採用した。DOM 走査や private API も使わない。
8. **1回だけの回復（ホバー popover など）**：6. で ID が一度ディスクに現れて消えた（または期限まで現れない）場合、カードに「別の画面の保存と重なりました。ノートが落ち着くのを待って、もう一度保存します…」と表示し、公開イベント `vault.on('modify')` でそのノートの変更が 2.5 秒途切れるまで待つ（Obsidian の保存の遅延が約 2 秒のため、それより長くする。最長 12 秒、`offref` で必ず解除）。その時点で (i) 前回の ID がディスクにあれば書かずにもう一度確認する、(ii) 前回の ID が編集中ビューのバッファにだけある（保存されなかった）なら書き直しても無駄なので失敗、(iii) それ以外は `adoptCandidate` をもう一度通す。(iii) は Canvas ガード・経路選択・**現在の内容での原文照合**をやり直すので、原文が変わっていれば書かず（「保存しませんでした：原文が抽出後に変更…」）、既に採用済みなら二重に挿入しない。再書き込みは 6. と同じ 3 秒ルールで確認し、成功したときだけ「採用しました」を出す。回復は1回だけで、2回目も消えたら「採用を確認できませんでした…」で止める。収束する理由：上書きしたビューは古いバッファを保存し終えた時点で未保存の変更がなくなり、未保存の変更がないビューは外部の変更を読み込み直すので、次の書き込みを上書きしない。限界：ユーザーがそのビューで打鍵を続けている間はノートが落ち着かないか再び上書きされ、正直に失敗を表示する。確認・回復はポップアップを閉じる/unload で取り消す（閉じた場合の Notice は「保存の確認前に閉じました…」の1回だけで、その後に失敗 Notice は出さない）。なお、確認中にユーザー自身が ID を消した場合（例：別ウィンドウの editor で Undo）も他の画面による上書きと区別できないため、回復で1回だけ ID を付け直す。付け直しを望まない場合は、確認が終わってから Undo するか ID を消す。

抽出も同じ規則で読む。アクティブなビューが Reading view のときは選択範囲を使わず、編集中のビューがあればその editor、無ければファイルを読む。

起動と状態ポップアップの表示ではノートを読まず書かない（M2 以降の ribbon はデッキ選択を開き、そこでノートを読み取り専用で走査するが書かない）。M1 の読み取りは「抽出」コマンド/ボタンの明示操作時だけ、書き込みは「採用」時だけで、「破棄」と閉じるは何も書かない。破棄はこのポップアップの表示から外すだけで、ノートに見送り記録を残さない（再抽出すると再び候補に出る）。

### モジュール構成

- `src/cards/`：Obsidian に依存しない純粋ロジック。`regions`（除外領域）、`parser`（候補抽出・ID/編集記録の読み取り・重複判定）、`card-id`（ID 生成）、`adoption`（照合と挿入文字列の計算）。
- `src/cards/writer.ts`：Editor / `Vault.process` への書き込み。公開 API（`MarkdownView`、`Editor.transaction`、`Vault.process`）のみ。
- `src/ui/startup-modal.ts`：状態ポップアップ（M1 時点は ribbon から、M2 からはコマンドとデッキ選択のボタンから）。実装状況を表示し、抽出ボタンを持つ（開くだけでは I/O しない）。
- `src/ui/candidate-modal.ts`：中央の候補ポップアップ（原文、編集欄、採用/破棄）。
- `src/ui/extract.ts`：アクティブノートと選択範囲を読み、候補ポップアップを開く。
- `src/main.ts`：ribbon/command（M2 から設定タブも）の登録と lifecycle のみ。

選択範囲がある場合は、文書全体を解析した上で選択範囲と重なるブロックだけを候補にする（選択が fence 内なら除外は維持される）。

### 既知の制約

- `%%`、`$$`、`<!--` は行単位の個数/位置で判定する。インラインコード内の `%%` などで奇数になると、それ以降を保守的に除外し候補が減ることがある（誤って書き込む方向には働かない）。Excalidraw ノートで描画データより前に奇数個の `%%` がある場合も同様で、候補が出ないだけで書き込みは安全側。
- 状態 modal・候補 modal の UI 文言は公式 lint の sentence-case 規則を既定設定のまま守るため、文中では「Q/A」ではなく「問い・答え」と書き、構文例 `Q:` / `A:` は独立した `code` 要素で表示する。

## M2 タグデッキと復習（LEV-276、実装済み・実機確認前）

2026-10-02 に利用者が決定した設計（`docs/m2-design.md`）に沿って実装した。利用者向けの FSRS の説明は `docs/fsrs.md`。**専用 Vault での実機確認（`docs/harness.md`「M2 実機確認」）はまだで、実機での動作は未確認。**

### 方針

- M2 はノートを書かない。カードは M1 の parser で読み取り専用に走査し、`^kioku-<id>`（大文字小文字を区別）で識別する。走査はデッキ選択を開いたときだけで、起動時は読み書きしない。
- デッキは設定のトリガータグ（既定 `#kioku`）とその子タグ。タグは大文字小文字を区別せず、ノート全体に適用し、frontmatter（`parseFrontMatterTags`）と本文（`CachedMetadata.tags` のうち M1 の除外領域外）から取る。親は子を含む。デッキ選択はノートに書かれたタグのデッキだけを平らに並べ（LEV-321、`DeckIndex.listed`。書かれていない中間の親は並べない）、トリガーが1つのときは見出しから根（`kioku/`）を省く。どのカードも少なくとも1行から出題できる。セッションはカード ID の集合で作り、二重出題しない。同じ ID が複数ノートにあれば、有効な問い/答え（空白正規化後）が同じなら1枚（パス順で最初のノート）、異なれば除外して全パスを表示する。
- 日程は FSRS（ts-fsrs 5.4.2、`request_retention=0.9`、`enable_short_term=false`、fuzz なし）。期日はローカル `dayStartHour`（既定 4 時）区切りの「Kioku 日」の日付文字列で持ち、ts-fsrs にはその日の 12:00 UTC を渡す（UTC 暦日差と固定 24 時間加算が Kioku 日の差と一致し、夏時間の影響を受けない）。期日が評価日以前になる結果は翌日に切り上げる（同日内の再出題なし）。新規カードの New 初回間隔は Again 1 / Hard 2 / Good 3 / Easy 8 日（単体テストで固定）。
- 新規は1日 `newPerDay`（既定 20、`null` で無制限）。今日導入した数（`today.newIntroduced`、履歴の再生でも数える）と「今日だけ あと N 枚」（`today.extraNew`、`state.json` だけに保存、翌 Kioku 日に無効。最初の評価より前はメモリ上だけに持ち、何も作らない）で残りを決める。キューは Due（期日の古い順）→ New（パス順・出現順）で、New は表示のたびに残り枠と照合するので、スキップした New は枠を使わない。

### 保存と安全策

- `<Vault>/<dataFolder>/`（既定 `Kioku`）に `state.json`、`state.json.bak`、`history-YYYY.jsonl`（年は評価の Kioku 日）。プラグインの `data.json` は設定だけ（`saveData`）。I/O は公開 `DataAdapter`（`app.vault.adapter` の `exists`/`read`/`write`/`append`/`mkdir`/`list`）だけで行う。
- デッキ選択の開閉では何も作らない・書かない。フォルダとファイルは最初の評価で初めて作る（例外は既存の記録に対する「退避して続ける」の明示操作だけ。「今日だけ追加」は `state.json` が既にあるときだけ保存する）。
- 履歴が正本で状態はキャッシュ。評価1件：一意の `eventId`（`<cardId>:<ランダム10文字>`）を持つイベントを作る → 追記の直前に履歴ファイル全体を読み直して検証（壊れた行・途中で切れた最終行があれば書かずに読み取り専用、改行なしの正しい最終行なら先頭に `\n` を足す）→ 1行追記（常に `append`。ファイルが無ければ `append` が作るので、存在判定の誤りで履歴を `write` で置き換えることはない。追記先はその評価の年のファイルか、既にあるより新しい年のファイル。時計を年をまたいで戻しても追記順と再生順が一致する）→ 読み戻して末尾がその `eventId` であることを確認できたら「保存済み」→ 状態を再生で更新し `state.json` を書く（このストアで最初の書き込みの前に既存の `state.json` を読み直して検証し `.bak` にコピー。読めなければ書かない。書き込みは `state.json.tmp` に書いて読み戻し確認してから `rename` で置き換える。上書きの `rename` を拒む adapter では先に `state.json` を消してから `rename` する。その隙間で落ちると `state.json` が無い状態になり、次回は履歴から作り直す（失うのはその日の「今日だけ追加」だけ））。`state.json` の失敗は Notice を1回出すだけで進行は止めない。追記の失敗・未確認は理由を表示し、「もう一度保存する」は同じイベント（同じ `eventId`）で再試行する。末尾が既にその `eventId` なら追記しない。
- イベントは評価後の日程（phase・dueDay・stability・difficulty・reps・lapses）も持ち、再生はスケジューラを再実行せずにそれを適用する（ライブラリの版が変わっても過去の日程は変わらない）。
- 読み込み時は `state.json` の `applied`（ファイルごとの反映済み行番号と、その行の `eventId`）より後ろだけを再生する。ファイルはあるが位置の行の `eventId` が一致しない場合は全履歴を空の状態から再生し直す。`applied` が指すファイルが無い・反映済み行数より短い場合は、残りから再生すると日程を黙って失うので読み取り専用にする（追記直前の読み直しでも同じ判定をする。`state.json` が無いときは有効な `state.json.tmp`、無ければ `.bak` の `applied` で同じ判定をする）。どちらでも `eventId` の重複は1回だけ適用する。時刻（`at`）は位置決めに使わない。
- ファイルが**存在しない**ときだけ新規扱い（`exists` で明示的に確認）。存在するのに読めない・検証に失敗・未知の `schemaVersion`、履歴の壊れた行・未知の版の行は読み取り専用（評価ボタン無効、理由とファイル名・行番号を表示、何も書かない）。表示用の件数は読めた範囲から作る。
- 履歴の最終行だけが改行なしで途中で切れている場合は読み取り専用にし、デッキ選択の確認ボタン「不完全な最終行を退避して続ける」を押したときだけ、①その1行を `history-YYYY.jsonl.broken` に追記して読み戻し確認、②履歴からその行だけを取り除いて読み戻し確認、③読み直す。確認後にファイルが変わっていれば何もしない。
- `dataFolder` の変更は、新フォルダにデータが無く旧フォルダにある場合は適用しない（ファイルは移動しない）。
- Q/A を編集しても ID が同じなら日程・履歴を保持し、各イベントに評価時の有効な問い/答えの SHA-256（`contentHash`）を残す。ID が見つからないカードのデータは削除しない。

### 復習 UI

- デッキ選択と復習画面は同じ中央 modal。問いは `MarkdownRenderer` で描画し、答えを表示する前は保守的に、すべての `![` から `!` を外し（wiki・Markdown・参照形式の埋め込み）、`<img>`・`<iframe>` などの埋め込み HTML を文字として表示し、コードブロックの info string（`dataview` など）を外して他の renderer を動かさない（`src/review/conceal.ts`）。描画用の `Component` は画面の切り替えと modal の close で unload する。
- キー入力は modal の `containerEl` の capture 段の `keydown` で1経路だけで処理する（`Space`/`Enter` = 答えを表示、またはフォーカス中の Kioku ボタンの操作、`1`–`4` = 評価、`S` = スキップ）。処理したキーは `preventDefault` するので、フォーカス中のボタンのネイティブな click と二重に動かない。さらに Space/Enter の `keyup` も抑止し、ボタンの click は描画ごとの token で古い画面のボタンを無視する。`event.repeat`、`isComposing`、`key === 'Process'`、修飾キー付きは無視し、保存中は評価・スキップ・表示の入力をすべて無視してボタンを無効化する。`Escape` は Obsidian の Modal に任せる。

### モジュール

- 状態と履歴の先頭の UTF-8 BOM は無視する。メタデータの索引がまだ無いノートは数えず、デッキ選択に「索引中のノート N 件（あとで再読み込み）」と表示する。
- `src/decks/`：`tags.ts`・`index.ts`（純粋。トリガー一致、除外領域での絞り込み、デッキと一覧に並べる行、ID 重複）、`scan.ts`（`metadataCache` と `cachedRead`。トリガータグのあるノートはすべて読む。`kioku-` の block キーだけのノートはデッキ外の件数のために読む）。
- `src/review/`：`types.ts`、`day.ts`、`scheduler.ts`（ts-fsrs ラッパ）、`fsrs-guard.ts`、`queue.ts`、`event.ts`（イベント作成と内容ハッシュ）。純粋・決定的で、時刻は引数。
- 記録するイベントは追記の前に再生と同じ検証を通す（`^kioku-` のように本体の無い ID は走査の段階で除外し、デッキ選択に注記する）。設定（`data.json`）が読めない・学習データのフォルダが不正な場合は既定値に黙って戻さず、デッキ選択を開かず設定タブも保存しない。復習中に Kioku 日が変わったら評価せずにデッキ選択を読み直す。追記の失敗後は「もう一度保存する」か閉じるだけにする。
- `src/store/`：`schema.ts`（純粋。検証・履歴の解析・再生）、`review-store.ts`（`<dataFolder>/` の I/O と安全策、フォルダ変更ガード）、`settings.ts`（`data.json` の解釈と遅延読み込み）、`reasons.ts`（M2 の理由文）。
- `src/ui/`：`deck-picker-modal.ts`、`review-screen.ts`（同じ modal 内の復習画面）、`settings-tab.ts`。`src/main.ts` は登録と lifecycle のみ。

## M3 AI による候補の判定と生成（LEV-277、部分実装・実機未確認）

設計と利用者決定（2026-10-02）は `docs/m3-design.md`。**フェーズ A（ローカル生成、Jev / 判定なし、決定的検査、同意と送信前の表示、生成カードの挿入）を実装した。Clef・ローカル logprobs 判定・OpenAI/カスタム生成は未実装で、実機確認と実測もまだ。** 実装状況と設計から変えた点は `docs/m3-design.md` §16。以下は全体の構成（未実装部分を含む）。

- 流れ：M1 と同じ読み取り規則で本文を確定 → 生成 provider（設定時だけ）が要約（事実と引用）から Q/A 候補を作る → 決定的検査（常に。引用が原文に完全一致しない生成候補は除外）→ 判定 provider（設定時だけ。Jev / Clef / ローカル logprobs）→ M1 の候補ポップアップで人が採用 → 生成カードは引用元のブロックの直後に新しい Q/A ブロックとして挿入。自動採用はしない。
- provider：`DecisionProvider.decide(state, questions)` は Jev の systemone と同じ形（`noul` / `choice` / `score` → value・probabilities・confidence）、`GeneratorProvider.generate(source)` は引用付きの候補を返す。失敗は例外でなく結果型で返す。
- 通信：Obsidian の `requestUrl` だけ（`src/ai/http.ts`）。それ以外の `src/ai/` は注入した HTTP クライアントを使う純粋コード。起動時・設定タブや候補ポップアップを開いただけでは通信しない。外部送信は既定 OFF で、provider ごとの同意と API キーがそろうまで送らない。外部かどうかは接続先（非 loopback）とモデル（Ollama の cloud モデル）で決める。ローカル判定の logprobs はサーバー種別ごとの endpoint で取る（Ollama は OpenAI 互換 chat、llama.cpp は `/completion`、LM Studio は `/v1/responses`）。判定 provider には「判定なし」もある。
- 書き込み：生成カードの挿入計画は純粋関数（`src/cards/insertion.ts`）とし、M1 の書き込み経路（原文照合、Canvas ガード、ディスク確認、1回だけの回復）を共有する。
- 設定：`data.json`（`schemaVersion` は 1 のまま）に任意の `ai` セクションを足し、AI 設定と API キーを持つ（`minAppVersion` 1.8.7 のまま。平文保存のリスクは `docs/m3-design.md` §7.3）。runtime 依存は増やさない。
- モジュール（フェーズ A）：`src/ai/types.ts`・`http.ts`（`requestUrl` と timer を使う唯一のファイル）・`call.ts`（枠・タイムアウト・キャンセル・バックオフ）・`source.ts`（送る本文と引用照合）・`checks.ts`・`classify.ts`・`prompts.ts`・`reasons.ts`・`settings.ts`・`pipeline.ts`（`AiRuntime` は plugin ごとに1つで枠を持つ）・`providers/jev.ts`・`providers/local.ts`。`src/cards/insertion.ts`、`src/ui/ai-settings.ts`。`src/main.ts` は `AiRuntime` を作って渡すだけ（通信しない）。
