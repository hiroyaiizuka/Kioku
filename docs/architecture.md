# Kioku アーキテクチャ

## M0 runtime（M1 でも維持）

`src/main.ts` は plugin lifecycle、ribbon と command の登録、modal の所有だけを行う。`src/ui/startup-modal.ts` は公開 `Modal` API で scoped class の中央 modal を描く。起動、ribbon、状態 modal の表示はノート、Vault、workspace state、ネットワーク、Node/Electron API、他プラグイン API へ触れない（M1 の読み書きは後述の明示操作時だけ）。runtime dependency はなく、`obsidian` は host external である。

同じ `StartupModal` instance を再利用し、unload 時に閉じる。表示ごとに内容を再構築し、close で内容を片付ける。画面には version と build ID を data attribute と文字列で出し、実機 smoke が今の配布物を識別できる。実装済み範囲と未実装（M1 時点ではデッキ・復習・AI）を UI 自身が明示する。

## Build identity と配布物

production esbuild は browser/CJS/ES2021、external は `obsidian` だけ。build ID は `src/`、manifest、package/lock、Node/TS/build script、styles の SHA-256 一覧から導く。`dist/kioku/` は `main.js`、`manifest.json`、`styles.css`、`build-info.json` の4ファイルだけ。build-info は入力、3 plugin file の hash、external import を記録する。自分自身の hash は自己参照になるため持たず、preflight は build-info bytes を dist と installed で比較する。

## Tooling trust boundary

Node は `scripts/` とテストだけ。全 CLI は引数で任意 path を受けず、real project root からの実行を要求する。書き込み先の全 existing path component について project containment、symlink、file hard link、型を確認し、一時ファイルから atomic rename する。これは誤操作/既存 link に対する防御で、同一ユーザーの敵対的 concurrent filesystem mutation まで完全に防ぐものではない。Vault 更新中は Obsidian を閉じる。

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

起動、ribbon、状態ポップアップの表示ではノートを読まず書かない。読み取りは「抽出」コマンド/ボタンの明示操作時だけ、書き込みは「採用」時だけで、「破棄」と閉じるは何も書かない。破棄はこのポップアップの表示から外すだけで、ノートに見送り記録を残さない（再抽出すると再び候補に出る）。

### モジュール構成

- `src/cards/`：Obsidian に依存しない純粋ロジック。`regions`（除外領域）、`parser`（候補抽出・ID/編集記録の読み取り・重複判定）、`card-id`（ID 生成）、`adoption`（照合と挿入文字列の計算）。
- `src/cards/writer.ts`：Editor / `Vault.process` への書き込み。公開 API（`MarkdownView`、`Editor.transaction`、`Vault.process`）のみ。
- `src/ui/startup-modal.ts`：ribbon の状態ポップアップ。実装状況を表示し、抽出ボタンを持つ（開くだけでは I/O しない）。
- `src/ui/candidate-modal.ts`：中央の候補ポップアップ（原文、編集欄、採用/破棄）。
- `src/ui/extract.ts`：アクティブノートと選択範囲を読み、候補ポップアップを開く。
- `src/main.ts`：ribbon/command の登録と lifecycle のみ。

選択範囲がある場合は、文書全体を解析した上で選択範囲と重なるブロックだけを候補にする（選択が fence 内なら除外は維持される）。

### 既知の制約

- `%%`、`$$`、`<!--` は行単位の個数/位置で判定する。インラインコード内の `%%` などで奇数になると、それ以降を保守的に除外し候補が減ることがある（誤って書き込む方向には働かない）。Excalidraw ノートで描画データより前に奇数個の `%%` がある場合も同様で、候補が出ないだけで書き込みは安全側。
- 状態 modal・候補 modal の UI 文言は公式 lint の sentence-case 規則を既定設定のまま守るため、文中では「Q/A」ではなく「問い・答え」と書き、構文例 `Q:` / `A:` は独立した `code` 要素で表示する。
