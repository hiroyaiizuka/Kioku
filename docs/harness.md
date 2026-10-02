# Kioku ハーネス

## 自動ゲート

| ゲート | コマンド | 固定する内容 |
| --- | --- | --- |
| metadata | `npm run validate` | ID/name/desktop/version、lock、固定 deps（runtime は ts-fsrs 5.4.2 だけ、MIT・推移依存なし）、文書、LICENSE |
| lint | `npm run lint` | 公式 `eslint-plugin-obsidianmd` recommended、runtime の Node 禁止、JSON/Node script |
| type | `npm run typecheck` | strict、unchecked index、override、unused |
| test | `npm test` | 状態 modal の honesty/lifecycle・起動時 I/O（ノート・`Kioku/`・`data.json`）禁止の変異検査、M1 の parser/除外/ID/重複/採用照合、Editor・`Vault.process` 書き込み経路の mock 検査（実機ではない）、M2 の FSRS 間隔・Kioku 日（DST 含む）・デッキ所属・ID 重複・新規上限・保存の安全策（読めない/無い、`.bak`、schema、末尾修復、不完全行の退避、eventId 重複除去、再生位置）・キー入力の安全・開閉で書かないことの mock 検査（実機ではない）、ts-fsrs の `Date.prototype` 汚染の復元、fixture containment、prepare/update preservation、hash/enablement、ノート不変とデータフォルダ未作成の非UI検査 |
| build/package | `npm run build && npm run package` | 共通 recipe の browser production bundle（ts-fsrs を bundle し MIT 表示を先頭に保持、external は `obsidian` だけ）、現入力から write:false で再生成した期待 bytes/imports と4配布物を比較。dist の自己申告 hash だけでは認定しない |
| all | `npm run check` | 上記を順に実行。実機は起動しない |

CI は `npm ci` と `npm run check` を実行し dist を検査用 artifact にするだけで、公開しない。`npm run hooks:install` は Git worktree 作成後だけ任意で使え、pre-commit が同じ check を必ず実行する。

## 専用 test-vault

1. `npm ci && npm run check`
2. 初回だけ `npm run harness:prepare`。`test-vault/` が存在すれば拒否し、既存 Vault を採用しない。
3. 手動編集後は Obsidian を閉じて `npm run harness:update`。built plugin 4 files 以外を変えない。
4. 起動前に `npm run harness:preflight`。source inputs = 再生成した production bytes/imports = dist = installed bytes、marker、ID/version/build ID、enabled plugin が Kioku だけであることを見る。再生成はメモリ上のみで dist を修復しない。

prepare/update/preflight は filesystem の成功であり、Obsidian UI の成功ではない。`test-vault/Welcome.md` は初回 fixture であり update では触れない。本番 Vault を指定する引数はない。

## Obsidian desktop smoke

**enable/startup より前**にノートの baseline を採る。起動後に snapshot を採り直すと onload による書き込みを見逃すため禁止する。

1. テスト担当が専用 Vault を開く Obsidian を完全に閉じ、必要なら `harness:update` を行う。
2. `KIOKU_CONFIRM_VAULT_CLOSED=1 KIOKU_CDP_URL=http://127.0.0.1:9222 npm run harness:e2e:smoke -- baseline`。script は閉じたことの担当者確認を必須とし、既に CDP targets がある場合は拒否する。`artifacts/e2e-smoke/baselines/<ID>.json` に専用 Vault の内容ファイル一覧と SHA-256 を排他的に保存し、ID を表示する。この段階の status は `CAPTURED` であり、UI の PASS ではない。
3. 表示された ID を `KIOKU_BASELINE_ID` に指定し、同じ build の Obsidian を remote-debugging port 付きで専用 Vault に起動する（初回の Kioku 有効化を含む）。
4. `KIOKU_BASELINE_ID=<ID> KIOKU_CDP_URL=http://127.0.0.1:9222 npm run harness:e2e:smoke`。baseline が無い・identity が異なる場合は FAIL。startup 後かつ UI 操作前、各 open/close 後、Escape 後のファイル一覧/hash が **起動前 baseline** と同じことを必須判定し、追加・削除・rename・bytes 変更のいずれも FAIL にする。同じ各時点で、学習データのフォルダ（プラグインの `data.json` の `dataFolder`、既定 `Kioku`）が**空でも作られていない**ことを判定する（ファイルの snapshot だけでは空フォルダを検出できないため）。baseline 時点で既にフォルダがあった Vault（評価済み）では、フォルダが残っていることを判定し、中のファイルは内容 baseline で比較する。

script は loopback CDP 以外を拒否し、専用 Vault の native page が1つ、ribbon が1つであることを検査する。M2 から ribbon はデッキ選択を開くので、ribbon → デッキ選択（root `.kioku-deck-picker-modal` の version/build ID data attribute が current preflight と一致、読み込み完了、「全デッキ」表示、中央）→ 閉じるを2回、ribbon → デッキ選択 → Escape を1回行う。状態 modal はコマンド `kioku:open-startup` から開き、`.kioku-build-identity` の version/build ID と未実装の明示（AI）と中央表示を検査して閉じる。page error を確認し、`artifacts/e2e-smoke/` に JSON と screenshot（デッキ選択2枚、状態 modal 1枚）を残す。実際の plugin/modal が無ければ FAIL する。

baseline の対象は Markdown・Excalidraw・添付を含む全内容ファイル。Obsidian が変更する `.obsidian/` と harness marker `.kioku-generated` だけを除外する。baseline 自体を再保存・上書きしない。テスト中の手動ノート編集は禁止。CDP の無い別プロセスまで script が閉鎖を証明することはできず、担当者の閉鎖確認が必要。書き込み後に元 bytes へ戻すような一時的 I/O は snapshot だけでは検出できないため、unit mock は Vault/adapter/Editor 経路の read/write を拒否・監視し、レビューの startup-write mutant が落ちることも固定する。

`tests/e2e/note-preservation.test.mjs` は script を CDP **プロトコル模擬**で検査する非UI回帰ケース。模擬 run の PASS/画像は実機証跡ではない。通常の実機 smoke は native Obsidian だけで実行する。

desktop restart は script 自身がアプリを終了/起動しないため、担当が restart 後に **同じ KIOKU_BASELINE_ID** でもう一度 smoke を実行し、2 run の証跡を関連付ける。restart 前に baseline を採り直さない。単独 run の record は restart を `NOT TESTED` と明記する。実機を起動していない開発ワーカーは PASS を報告してはならない。

## M1 実機確認（LEV-275、testing agent が実施）

`npm run check` と mock テストは書き込み経路の契約を固定するだけで、実機成功ではない。M1 の UI/保存経路は専用 Vault の Obsidian desktop で次を確認し、操作前後のノート bytes（または diff）と screenshot を `artifacts/` に残す。本番 Vault は使わない。

1. 状態 modal（M1 時点は ribbon、M2 からはコマンド）が実装済み範囲と未実装を表示し、開閉だけでノートが変わらない（既存 smoke）。
2. 日本語の Q/A（`Q:`/`A:`、`問：`/`答：`、全角コロン、複数行の答え）を含むノートでコマンド「開いているノート・選択範囲から問い・答えの候補を抽出」→ 中央ポップアップに原文と編集欄が出る。選択範囲ありでは重なるブロックだけ。
3. 破棄・閉じる・Escape ではノート bytes が変わらない。採用では対象ブロック最終行末に ` ^kioku-…` が増え、編集した場合だけ直後に `%%kioku-edit:…%%` が増える。それ以外に増えるのは項目11の空行（改行1つ）だけで、原文の文字は変わらない。Reading view で ID と編集記録が見えない。
4. 同名見出しの下に同じ Q/A がある場合、選んだ方だけに ID が付く。
5. 採用直後の Undo で採用前の bytes に戻り、Redo で再び付く（1採用 = 1 Undo）。
6. 同じノートを2ペイン（Source/Live Preview と Reading を含む）で開き、採用が両方に反映され二重に付かない（ペインの左右どちらが Reading でも、書き込みは編集中のペインの editor 経由）。さらに **Reading view だけ**で開いたノートでも採用し、「採用しました」の直後にファイル bytes に ID が入り、Reading view の再表示・Live Preview への切替後・再抽出のいずれでも採用済みのままであること（hidden editor にだけ書かれて失われない）。
7. ポップアップを開いたまま外部（別エディタ等）で対象原文を変更 → 採用は書き込まず理由を Notice 表示する。
8. ファイルメニュー「Kioku：問い・答えの候補を抽出」で閉じたノートから採用 → `Vault.process` 経路で同じ結果になる。Reading view だけで開いているノートも同じ `Vault.process` 経路になる。
9. コードブロック内、`%%` 内、Excalidraw ノート（`# Excalidraw Data` 以降・`## Drawing`）の Q/A が候補に出ず、それらの bytes が変わらない。
10. 再抽出で採用済みが「採用済み」と表示され、採用ボタンが出ない。ID 重複・既存 block ID のブロックは「採用不可」と理由が出て、カードとしては表示されない。
11. 空行なしで続く `Q: a` / `A: b` / `Q: c` / `A: d`、`A:` 直後の `---`、2つ目の `A:` の各ケースで、ポップアップに「空行を1行追加」と出て、採用後はブロック直後に空行が1行だけ入る。箇条書き（`- Q: a` / `- A: b` / `- Q: c`）で次の行も箇条書きなら編集なしの採用では空行は入らず、tight list のまま `^kioku-…` が見えない。同じ箇条書きで編集して採用すると、編集記録の閉じ `%%` の後に空行が1行入る。Reading view で `^kioku-…` が文字として見えず、`---` が見出しにならない。ポップアップの空行の注記は「直後に空行がないため」で始まり、改行コードは Obsidian の扱いに従う旨を含む。
    - 改行コード（ユーザー決定。`docs/architecture.md`「改行コード」）：CRLF / LF 混在ノートを**開いて**採用した場合（Editor 経路）、結果はノート全体が LF（bare `\r` / `\r\n` なし）で、改行コード以外の可視テキストは「原文 + ID・編集記録・空行」と一致する。これは Obsidian 自身の正規化であり、Kioku を無効にした対照でも同じことを確認する。**閉じた**ノートにファイルメニューから採用した場合（`Vault.process` 経路）、挿入した改行は対象ブロックの改行コードに揃い、他の行の改行は変わらない（直後にそのノートを Source で開くと Obsidian が LF に正規化するため、bytes は開く前に採取する）。Reading view だけで開いたノートは `Vault.process` 経路なので閉じたノートと同じ期待値（ブロックの改行コードを保持）。どちらの経路でも Kioku が改行コードの混在を作らない。
12. 編集欄の答えに ```` ``` ```` / `~~~` の行、`$$`、`<!--` を入れて採用すると、書き込まずに理由が表示される。
13. HTML comment・`$$` 数式ブロック内の Q/A が候補に出ない。
14. **Canvas**：対象ノートを開いている Canvas にファイルノードとして埋め込み、ノード内で未保存の編集をした状態で、Reading view だけ / Live Preview の各ビューから採用 → 書き込まずに「Kioku：保存しませんでした。このノートは開いている Canvas（…）に埋め込まれています。…」（「保存しませんでした」は1回だけ）と表示され、ファイル bytes が変わらない。Canvas を閉じると同じ候補を通常どおり採用できる。埋め込んでいない Canvas が開いているだけなら採用できる。
15. **成功表示の正直さ**：すべての採用で、カードがまず「保存を確認しています…」になり、「採用しました」の Notice はファイル bytes に `^kioku-…` が入ったあと（書き込みから約3秒後）にだけ出る。Notice の時点と 5 秒後の bytes の両方に ID がある。確認待ち中にポップアップを閉じる（閉じるボタン / Escape）と「Kioku：保存の確認前に閉じました。もう一度抽出して採用済みか確認してください。」が1回だけ出て、エラーは出ない。再抽出すると、書き込みが残っていれば「採用済み」、消えていれば「未採用」と表示される。プラグイン無効化・終了時の取り消しでは Notice を出さない。
16. **ホバー popover**：ページプレビューのホバーで対象ノートを編集モードにして未保存の文字を入力し、Reading view（split）から採用する。popover の遅れた保存で ID が一度消えても、カードに「別の画面の保存と重なりました。ノートが落ち着くのを待って、もう一度保存します…」と出て、約 2.5 秒の静止後に1回だけ書き直し、最終的に「採用しました」が出る（書き直しが入った場合、採用から成功表示まで約 6〜9 秒）。最終 bytes に `^kioku-…` がちょうど1つあり、popover で入力した文字も残る。再書き込みは原文照合を通る（popover で対象ブロック自体を書き換えた場合は「保存しませんでした：原文が抽出後に変更…」で書かない）。popover で打鍵を続けた場合は「採用を確認できませんでした…」で止まり、成功とは表示しない。

## M2 実機確認（LEV-276、testing agent が実施）

`npm run check`・mock テスト・CDP 模擬・preflight の成功は、デッキ・復習・保存の契約を固定するだけで実機成功ではない。専用 Vault（`test-vault/`）の Obsidian desktop で次を確認し、`artifacts/lev-276/` に baseline、screenshot、操作前後のノートと `Kioku/` の bytes（または diff）、`history-YYYY.jsonl` の行数を残す。本番 Vault は使わない。実機を起動していない開発ワーカーはここを PASS と報告しない。

準備：`#kioku`・`#Kioku/医学`・`#kioku/医学/生理`・frontmatter `tags: [kioku/英語]`・コードブロック内だけに `#kioku` があるノート・2つのデッキタグを持つノート・同じ `^kioku-…` を同内容/異内容で持つ2組のノート・`![[…]]` を問いに含むカード・トリガータグの無いノートに、採用済みカード（M1 で採用、または `^kioku-<10文字>` を手で付与）を用意する。新規上限の確認用に新規カードを 21 枚以上用意する。用意は Obsidian を閉じて行い、そのあと smoke の baseline を採る。

1. 起動直後にノートも `Kioku/` も読み書きされない（smoke の startup 判定、`Kioku/` 未作成）。
2. ribbon → デッキ選択の開閉・Escape で Vault の内容ファイルが変わらず、`Kioku/`（空フォルダを含む）が作られない。デッキ選択 root の identity が preflight と一致（smoke）。
3. トリガータグどおりのデッキと Due/New/Total：既定 `#kioku`、大文字小文字の違い（`#Kioku/医学` は `医学` に合流）、入れ子（子デッキ、親は子を含む）、frontmatter のタグ、コードブロック内のタグは数えない。デッキ外カード件数の注記。ID 重複は同内容なら1枚、異内容なら出題から除外され両パスが注記に出る。トリガータグを2つにすると根（`kioku › …`）が表示される。
4. 2つのデッキに属するカードが、親デッキ・全デッキ・各デッキのどのセッションでも1回だけ出る。デッキ A で評価したあと、デッキ B で Due でも New でもない（デッキ選択の件数で確認）。
5. 評価で `Kioku/history-YYYY.jsonl` に1行増え、`Kioku/state.json` が更新され、`state.json` が既にあった場合はセッション最初の保存で `state.json.bak` が作られる。ノートの bytes は変わらない。
6. Skip（`S`、答えの表示前後）で `Kioku/` とノートの bytes が変わらず、同じセッションでは再出題されず、デッキ選択を開き直すと New/Due に残っている。
7. 途中で閉じる・Escape：評価済みの分だけ履歴にあり、表示中の未評価カードは変化しない。
8. Obsidian を終了 → 再起動で、期日と Due/New/Total が終了前と一致する。`harness:update` 後も `Kioku/` が残る（update は4配布物以外を変えない）。
9. 新規上限：既定 20 枚。デッキ選択に「今日の新規 残り X 枚」、21 枚目以降は「新規の残りは明日以降」。完了画面の「今日だけ あと10枚」で 10 枚追加され、`state.json` の `today.extraNew` が 10 になる。まだ一度も評価していない Vault（`Kioku/` 無し）で押した場合は `Kioku/` が作られず、その後の最初の評価で `extraNew` が保存される。
10. 今日評価したカードが今日の Due に再び出ない（「もう一度」でも次回は翌日以降。日付境界と夏時間は単体テストで固定）。
11. カードのブロックを別ノートへ移動・ノートを改名しても日程が保持される。ブロック削除 → Undo で同じ ID が戻り日程も戻る。原文の編集・`%%kioku-edit%%` の追加後も日程が保持され、次の評価のイベントの `contentHash` が変わる。
12. `state.json` を壊す（JSON として不正にする）と読み取り専用になり、理由が表示され、評価ボタンが無効で `state.json` が上書きされない。`state.json` を消すと履歴から再構築され、最初の評価で書き直される。`state.json` を古い版（評価前の `.bak` など）に戻すと、反映済み位置より後ろの履歴が再生されて追いつく（同じ `eventId` の行を手で複製しても二重に数えない）。
    - 12a. 履歴の最終行を途中で切る（改行も消す）。結果は、その行が `state.json` に**まだ反映されていないか、もう反映されているか**で分かれる（設計どおり）。
        - 12a-1（未反映。追記中のクラッシュの実際の形）：`state.json` の `applied` がその行より前を指している状態で最終行を切る（例：`state.json` を評価前の `.bak` の内容に戻す、または `state.json` と `.bak`（と `.tmp`）を消してから最終行を切る。`state.json` だけを消すと、切った行を含む `.bak` が残っている場合に欠落判定の基準になり 12a-2 になる）。デッキ選択に「記録ファイル …history-YYYY.jsonl の最終行（N 行目）が途中で切れています。読み取り専用にしています。」と確認ボタン「不完全な最終行を退避して続ける」が出る。押したときだけ、その1行が `history-YYYY.jsonl.broken` に追記され（先）、続いて履歴からその行だけが取り除かれ（後）、読み直されて評価できるようになる。押さなければ何も書かれない。
        - 12a-2（反映済み。外部での破損）：`state.json` の `applied` が既にその行を指している状態で最終行を切る（評価直後にそのまま切る）。履歴が「反映済みより短い」と判定され、「記録ファイル … が見つからないか、日程ファイルが反映済みとしている行より短くなっています。…読み取り専用にしています。」が出て、確認ボタンは出ない。何も書かれない。復旧は README「記録が読めないときの復旧」の手順（Obsidian を閉じ、`Kioku/` をコピーしてから、切れた行を `history-YYYY.jsonl.broken` に移すか消し、`state.json`・`state.json.bak`・`state.json.tmp` を消して開き直すと履歴から作り直される。または `.bak` / 記録ファイルをバックアップから戻す）。
        - 途中の行を壊すと、ファイル名と行番号が表示され読み取り専用のまま（ボタンは出ない）。最終行の改行だけを消した場合（行自体は正しい）は、次の評価の前に改行が補われ、行が連結されない。
        - 書き込み経路の観察（Obsidian 1.14.3 実機）：既存の `state.json` への `rename` による上書きは「Destination file already exists!」で失敗するため、保存は毎回「`state.json.tmp` に書いて確認 → `state.json` を削除 → `rename`」の経路を通る。保存後に `state.json.tmp` は残らず、`state.json.bak` はある。
    - 12b. 設定の「学習データのフォルダ」を、データの無いフォルダ名に変えて「変更」を押すと適用されず「古いフォルダ（Kioku）にデータがあります。移動してから変更してください。」が表示され、`data.json` の `dataFolder` が変わらない。Obsidian の外で `Kioku/` を移動してから同じ名前に変えると適用される。
13. キーボード：`Space`/`Enter` で答えを表示、`1`–`4` で評価、`S` でスキップ、`Escape` で閉じる。答え表示後に「普通」にフォーカスがある状態で `Space` を押しても1回だけ評価される。キーの長押し（repeat）、保存中の連打、ボタンのクリックとキーの同時操作で二重評価されない（いずれも履歴の行数で確認）。日本語 IME の変換確定の `Enter` で答えの表示や評価が起きない。
14. 答えを表示する前は、問いの `![[…]]`・`![…](…)`・`<img>` の埋め込み内容や dataview などのコードブロックが描画されず（リンク・文字・素のコード表示）、答えの表示後に描画される。閉じた後に描画由来のエラーが console に出ない。
15. 性能：5,000 ノート / 10,000 カード程度の生成 fixture（専用 Vault 内）で、ribbon からデッキ一覧が表示されるまでの時間を記録する（目安 500 ms 以内、開発機。超えたら `docs/m2-design.md` §3.3 のキャッシュを検討）。
16. 未検証事項の記録：`Kioku/` の `.json`/`.jsonl` がファイル一覧・検索・グラフにどう出るか（「すべての拡張子を検出」設定の有無）、箇条書き項目の `^kioku-…` が `CachedMetadata.blocks` に入るか、`%%` 内の `#tag` を metadataCache が数えるか、を観察して記録する。

