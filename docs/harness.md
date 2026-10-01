# Kioku ハーネス

## 自動ゲート

| ゲート | コマンド | 固定する内容 |
| --- | --- | --- |
| metadata | `npm run validate` | ID/name/desktop/version、lock、固定 deps、文書、LICENSE |
| lint | `npm run lint` | 公式 `eslint-plugin-obsidianmd` recommended、runtime の Node 禁止、JSON/Node script |
| type | `npm run typecheck` | strict、unchecked index、override、unused |
| test | `npm test` | modal honesty/lifecycle・ノート I/O 禁止の変異検査、fixture containment、prepare/update preservation、hash/enablement、ノート不変の非UI検査 |
| build/package | `npm run build && npm run package` | 共通 recipe の browser production bundle、現入力から write:false で再生成した期待 bytes/imports と4配布物を比較。dist の自己申告 hash だけでは認定しない |
| all | `npm run check` | 上記を順に実行。実機は起動しない |

CI は `npm ci` と `npm run check` を実行し dist を検査用 artifact にするだけで、公開しない。`npm run hooks:install` は Git worktree 作成後だけ任意で使え、pre-commit が同じ check を必ず実行する。

## 専用 test-vault

1. `npm ci && npm run check`
2. 初回だけ `npm run harness:prepare`。`test-vault/` が存在すれば拒否し、既存 Vault を採用しない。
3. 手動編集後は専用インスタンスを `npm run harness:quit` で止めて `npm run harness:update`。built plugin 4 files 以外を変えない。
4. 起動前に `npm run harness:preflight`。source inputs = 再生成した production bytes/imports = dist = installed bytes、marker、ID/version/build ID、enabled plugin が Kioku だけであることを見る。再生成はメモリ上のみで dist を修復しない。

prepare/update/preflight は filesystem の成功であり、Obsidian UI の成功ではない。`test-vault/Welcome.md` は初回 fixture であり update では触れない。本番 Vault を指定する引数はない。

## 専用 Obsidian インスタンス（利用者の Obsidian は開いたまま）

利用者の通常の Obsidian は終了させない。Electron の single-instance lock は `--user-data-dir` ごとなので、harness はプロジェクト内の専用 profile で2つ目の Obsidian を並行起動する。アプリ名による終了・起動（`osascript quit`、`pkill`/`killall`、`open -a`）は使わない。

- `npm run harness:launch`（macOS のみ。他 platform は推測せず拒否）
  - preflight 後、`.tooling/obsidian-profile/`（git 管理外）を containment/symlink/hard link 検査付きで作り、profile の `obsidian.json` に **test-vault だけ**を `open: true` で登録する（vault ID は test-vault path から決定的に導出、`updateDisabled: true` で profile 内の自動更新を止める）。
  - 利用者の `~/Library/Application Support/obsidian/` から最新 semver の `obsidian-<ver>.asar` を **読み取りだけ**して profile へ copy する（hash 一致なら再利用、他 version の asar は profile から除去）。installer 同梱版（例: 1.6.7）ではなくこの版が起動する。asar が無い、または `manifest.minAppVersion` 未満なら拒否する。
  - `/Applications/Obsidian.app/Contents/MacOS/Obsidian`（`KIOKU_OBSIDIAN_BINARY` で変更可。正規化済み絶対 path の既存実行ファイルだけ）を `--user-data-dir=<profile> --remote-debugging-port=<KIOKU_CDP_PORT, 既定 9222> --remote-debugging-address=127.0.0.1` で detached 直接実行し、出力は `.tooling/obsidian-instance.log`。子プロセスの `HOME` は `.tooling/obsidian-home/` にする（macOS の Obsidian は起動時に `~/.obsidian-cli.sock` を unlink して listen し、終了時に unlink するため、利用者インスタンスの CLI socket を奪わないため）。`ELECTRON_*`/`NODE_OPTIONS` は渡さない。
  - PID・profile・port・startedAt を `.tooling/obsidian-instance.json` に atomic write する。記録済みインスタンスが生存中、記録外でも専用 profile を使うプロセスがある、CDP port が使用中、のいずれかなら起動しない。
  - CDP で test-vault の native page がちょうど1つ（他 Vault の page なし）になり layout ready、title の版が copy した asar と一致するまで待つ。
  - **Restricted mode**: Obsidian は community plugin があり per-vault の選択が localStorage（`enable-plugin-<vaultId>`）に無いと trust dialog（`.mod-trust-folder`）を出す。dialog の有効化 button は `app.plugins.setEnable(true)` を呼んで設定画面を開くだけなので、launch は CDP で同じ `app.plugins.setEnable(true)` を呼び（設定画面は開かない）、dialog を Escape（cancel 経路、閉じるだけ）で閉じる。dialog が無く選択が `false` の場合も同じ呼び出しで解除する。trust dialog 以外の modal があれば click せず失敗する。最後に restricted mode off、loaded/configured plugin が厳密に `kioku`、open modal 0 を確認する。選択は**専用 profile の localStorage だけ**に保存され、利用者 profile には触れない。2回目以降の launch では Obsidian 自身が起動時に Kioku を読み込む（`restrictedMode: already-off`）。
  - 出力 JSON（pid、version、port など）は起動の成功であり UI PASS ではない。
- `npm run harness:quit`: 記録 PID だけを対象に、`ps -ww -o command= -p <pid>` の command line が専用 `--user-data-dir=<profile>` を厳密に含むことを確認してから SIGTERM し、終了を待って報告し state を消す。記録が無い/既に終了済みなら何もせず報告する。PID が別プロセスに再利用されていれば signal せず state だけ消す。SIGTERM 後も終了しなければ state を残して失敗する（SIGKILL・名前指定はしない）。

test-vault を利用者の通常 Obsidian で開かない（利用者 profile は検査しないため、その場合の書き込みは harness が検出できない）。残存リスク: 同じ bundle ID のため Dock に2つ表示され、`obsidian://` URL がどちらに届くかは macOS 次第。

## Obsidian desktop smoke

**enable/startup より前**にノートの baseline を採る。起動後に snapshot を採り直すと onload による書き込みを見逃すため禁止する。

1. 専用インスタンスが動いていれば `npm run harness:quit`。必要なら `harness:update` を行う。利用者の Obsidian は閉じない。
2. `npm run harness:e2e:smoke -- baseline`。記録済み専用インスタンスの生存（PID + command line）、専用 profile を使うプロセス、CDP port（`KIOKU_CDP_URL` の port、`KIOKU_CDP_PORT`、記録 port）の応答を自動検査し、どれかがあれば拒否する。利用者の Obsidian の起動有無は検査も要求もしない（旧 `KIOKU_CONFIRM_VAULT_CLOSED` は廃止）。`artifacts/e2e-smoke/baselines/<ID>.json` に専用 Vault の内容ファイル一覧と SHA-256 を排他的に保存し、ID を表示する。この段階の status は `CAPTURED` であり、UI の PASS ではない。
3. `npm run harness:launch`（初回は上記の restricted mode 解除 = Kioku の初回有効化を含む）。
4. `KIOKU_BASELINE_ID=<ID> npm run harness:e2e:smoke`。baseline が無い・identity が異なる場合は FAIL。開始時に Kioku 以外の `.modal-container`（trust dialog など）が開いていれば UI 操作前に FAIL。startup 後かつ UI 操作前、各 open/close 後、Escape 後のファイル一覧/hash が **起動前 baseline** と同じことを必須判定し、追加・削除・rename・bytes 変更のいずれも FAIL にする。
5. restart pair: `npm run harness:quit && npm run harness:launch` の後、**同じ** `KIOKU_BASELINE_ID` で 4 を再実行する。restart 前に baseline を採り直さない。

script は loopback CDP 以外を拒否し、専用 Vault の native page が1つ、ribbon が1つ、build ID/version が current preflight と同じ中央 modal が1つであることを検査する。2回の open/close、Escape、page error を確認し、`artifacts/e2e-smoke/` に JSON と screenshot を残す。実際の plugin/modal が無ければ FAIL する。

baseline の対象は Markdown・Excalidraw・添付を含む全内容ファイル。Obsidian が変更する `.obsidian/` と harness marker `.kioku-generated` だけを除外する。baseline 自体を再保存・上書きしない。テスト中の手動ノート編集は禁止。停止の証明は専用インスタンス（記録 PID、専用 profile を持つプロセス、CDP port）に限られ、test-vault を通常の Obsidian で開かない運用が前提。書き込み後に元 bytes へ戻すような一時的 I/O は snapshot だけでは検出できないため、unit mock は Vault/adapter/Editor 経路の read/write を拒否・監視し、レビューの startup-write mutant が落ちることも固定する。

`tests/e2e/note-preservation.test.mjs` は script を CDP **プロトコル模擬**で検査する非UI回帰ケース。模擬 run の PASS/画像は実機証跡ではない。通常の実機 smoke は native Obsidian だけで実行する。

smoke script 自身はアプリを終了/起動しない。restart は `harness:quit` → `harness:launch` で行い、**同じ KIOKU_BASELINE_ID** でもう一度 smoke を実行して 2 run の証跡を関連付ける。restart 前に baseline を採り直さない。単独 run の record は restart を `NOT TESTED` と明記する。実機を起動していない開発ワーカーは PASS を報告してはならない。
