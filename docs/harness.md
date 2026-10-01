# Kioku ハーネス

## 自動ゲート

| ゲート | コマンド | 固定する内容 |
| --- | --- | --- |
| metadata | `npm run validate` | ID/name/desktop/version、lock、固定 deps、文書、LICENSE |
| lint | `npm run lint` | 公式 `eslint-plugin-obsidianmd` recommended、runtime の Node 禁止、JSON/Node script |
| type | `npm run typecheck` | strict、unchecked index、override、unused |
| test | `npm test` | 状態 modal の honesty/lifecycle・起動時ノート I/O 禁止の変異検査、M1 の parser/除外/ID/重複/採用照合、Editor・`Vault.process` 書き込み経路の mock 検査（実機ではない）、fixture containment、prepare/update preservation、hash/enablement、ノート不変の非UI検査 |
| build/package | `npm run build && npm run package` | 共通 recipe の browser production bundle、現入力から write:false で再生成した期待 bytes/imports と4配布物を比較。dist の自己申告 hash だけでは認定しない |
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
4. `KIOKU_BASELINE_ID=<ID> KIOKU_CDP_URL=http://127.0.0.1:9222 npm run harness:e2e:smoke`。baseline が無い・identity が異なる場合は FAIL。startup 後かつ UI 操作前、各 open/close 後、Escape 後のファイル一覧/hash が **起動前 baseline** と同じことを必須判定し、追加・削除・rename・bytes 変更のいずれも FAIL にする。

script は loopback CDP 以外を拒否し、専用 Vault の native page が1つ、ribbon が1つ、build ID/version が current preflight と同じ中央 modal が1つであることを検査する。2回の open/close、Escape、page error を確認し、`artifacts/e2e-smoke/` に JSON と screenshot を残す。実際の plugin/modal が無ければ FAIL する。

baseline の対象は Markdown・Excalidraw・添付を含む全内容ファイル。Obsidian が変更する `.obsidian/` と harness marker `.kioku-generated` だけを除外する。baseline 自体を再保存・上書きしない。テスト中の手動ノート編集は禁止。CDP の無い別プロセスまで script が閉鎖を証明することはできず、担当者の閉鎖確認が必要。書き込み後に元 bytes へ戻すような一時的 I/O は snapshot だけでは検出できないため、unit mock は Vault/adapter/Editor 経路の read/write を拒否・監視し、レビューの startup-write mutant が落ちることも固定する。

`tests/e2e/note-preservation.test.mjs` は script を CDP **プロトコル模擬**で検査する非UI回帰ケース。模擬 run の PASS/画像は実機証跡ではない。通常の実機 smoke は native Obsidian だけで実行する。

desktop restart は script 自身がアプリを終了/起動しないため、担当が restart 後に **同じ KIOKU_BASELINE_ID** でもう一度 smoke を実行し、2 run の証跡を関連付ける。restart 前に baseline を採り直さない。単独 run の record は restart を `NOT TESTED` と明記する。実機を起動していない開発ワーカーは PASS を報告してはならない。

## M1 実機確認（LEV-275、testing agent が実施）

`npm run check` と mock テストは書き込み経路の契約を固定するだけで、実機成功ではない。M1 の UI/保存経路は専用 Vault の Obsidian desktop で次を確認し、操作前後のノート bytes（または diff）と screenshot を `artifacts/` に残す。本番 Vault は使わない。

1. 状態 modal（ribbon）が実装済み範囲とデッキ・復習・AI 未実装を表示し、開閉だけでノートが変わらない（既存 smoke）。
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
