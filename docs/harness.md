# Kioku ハーネス

## 自動ゲート

| ゲート | コマンド | 固定する内容 |
| --- | --- | --- |
| metadata | `npm run validate` | ID/name/desktop/version、lock、固定 deps（runtime は ts-fsrs 5.4.2 だけ、MIT・推移依存なし）、文書、LICENSE |
| lint | `npm run lint` | 公式 `eslint-plugin-obsidianmd` recommended、runtime の Node 禁止、JSON/Node script |
| type | `npm run typecheck` | strict、unchecked index、override、unused |
| test | `npm test` | 状態 modal の honesty/lifecycle・起動時 I/O（ノート・`Kioku/`・`data.json`）禁止の変異検査、M1 の parser/除外/ID/重複/採用照合、Editor・`Vault.process` 書き込み経路の mock 検査（実機ではない）、M2 の FSRS 間隔・Kioku 日（DST 含む）・デッキ所属・ID 重複・新規上限・保存の安全策（読めない/無い、`.bak`、schema、末尾修復、不完全行の退避、eventId 重複除去、再生位置）・キー入力の安全・開閉で書かないことの mock 検査（実機ではない）、ts-fsrs の `Date.prototype` 汚染の復元、fixture containment、prepare/update preservation、hash/enablement、ノート不変とデータフォルダ未作成の非UI検査 |
| build/package | `npm run build && npm run package` | 共通 recipe の browser production bundle（ts-fsrs を bundle し MIT 表示を先頭に保持、external は `obsidian` だけ）、現入力から write:false で再生成した期待 bytes/imports と4配布物を比較。dist の自己申告 hash だけでは認定しない |
| all | `npm run check` | 上記（`check:steps`）を順に実行。実機は起動しない。`KIOKU_HEAVY_QUEUE=1` のときだけ Mac 全体の順番待ちの中で実行 |

検証コマンドの終了コードをパイプで隠さない（`| grep`・`| tail` で絞るときは `set -o pipefail`、全出力はファイルに残す）。失敗した実行の後の commit は gate を通ったことにならない。`scripts/check.mjs`、`.githooks/pre-commit`、`scripts/heavy-queue/cli.mjs` が失敗（signal による終了を含む）を 0 以外の終了コードで呼び出し元へ返すことは、単体テストで固定している。

CI は `npm ci` と `npm run check` を実行し dist を検査用 artifact にするだけで、公開しない。`npm run hooks:install` は Git worktree 作成後だけ任意で使え、pre-commit が同じ check を必ず実行する。

## 専用 test-vault

1. `npm ci && npm run check`
2. 初回だけ `npm run harness:prepare`。`test-vault/` が存在すれば拒否し、既存 Vault を採用しない。
3. 手動編集後は専用インスタンスを `npm run harness:quit` で止めて `npm run harness:update`。built plugin 4 files 以外を変えない。
4. 起動前に `npm run harness:preflight`。source inputs = 再生成した production bytes/imports = dist = installed bytes、marker、ID/version/build ID、enabled plugin が Kioku だけであることを見る。再生成はメモリ上のみで dist を修復しない。

prepare/update/preflight は filesystem の成功であり、Obsidian UI の成功ではない。`test-vault/Welcome.md` は初回 fixture であり update では触れない。本番 Vault を指定する引数はない。

## 専用 Obsidian インスタンス（利用者の Obsidian は開いたまま）

利用者の通常の Obsidian は終了させない。Electron の single-instance lock は `--user-data-dir` ごとなので、harness はプロジェクト内の専用 profile で2つ目の Obsidian を並行起動する。harness とエージェントは、アプリ名による終了・起動（`osascript quit`、`pkill`/`killall`、`open -a`/`open -n -a`）を一切実行しない。

- `npm run harness:launch`（macOS のみ。他 platform は推測せず拒否）
  - preflight 後、`.tooling/obsidian-profile/`（git 管理外）を containment/symlink/hard link 検査付きで作り、profile の `obsidian.json` に **test-vault だけ**を `open: true` で登録する（vault ID は test-vault path から決定的に導出、`updateDisabled: true` で profile 内の自動更新を止める）。
  - 利用者の `~/Library/Application Support/obsidian/` から最新 semver の `obsidian-<ver>.asar` を **読み取りだけ**して profile へ copy する（hash 一致なら再利用、他 version の asar は profile から除去）。installer 同梱版（例: 1.6.7）ではなくこの版が起動する。asar が無い、または `manifest.minAppVersion` 未満なら拒否する。
  - `/Applications/Obsidian.app/Contents/MacOS/Obsidian`（`KIOKU_OBSIDIAN_BINARY` で変更可。正規化済み絶対 path の既存実行ファイルだけ）を `--user-data-dir=<profile> --remote-debugging-port=<KIOKU_CDP_PORT, 既定 9222> --remote-debugging-address=127.0.0.1` で detached 直接実行し、出力は `.tooling/obsidian-instance.log`。環境変数は `HOME` を含めそのまま引き継ぎ、`ELECTRON_*`/`NODE_OPTIONS` だけ渡さない。
  - 以前は子プロセスの `HOME` を `.tooling/obsidian-home/` にしていたが、実機で login keychain が見つからず Electron safeStorage（"Obsidian Safe Storage"）が `SecKeychainAddGenericPassword` → `makeLoginAuthUI` → `AuthorizationCopyRights` に入り、SecurityAgent の認証ダイアログでメインスレッドが止まった（CDP page が出ず 90 秒で launch timeout、SIGTERM も 20 秒以内に処理されなかった。`artifacts/lev-279/e5f67e6-partial/RECORD.md` Step 3。git 管理外のローカル証跡）。そのため HOME の上書きはやめた。過去の版が残した `.tooling/obsidian-home/` は不要で、専用インスタンス停止中に `rm -rf .tooling/obsidian-home` で手動削除してよい（プロジェクト内の .tooling だけ。harness は自動削除しない）。
  - **CLI socket**: インストール済み 1.14.3 の `main.js` は `var W=process.platform==="darwin"` と `T=oe?…:F.join(!W&&process.env.XDG_RUNTIME_DIR||ge.homedir(),".obsidian-cli.sock")` で socket path を決め、`if(!oe)try{m.unlinkSync(T)}catch(t){}…Qe.listen(T)` で起動時に置き換え、`will-quit` で `m.unlinkSync(T)` する。macOS（`W`）では `XDG_RUNTIME_DIR` は無視されるため、HOME を変えずに socket を分ける手段は無い。したがって専用インスタンスは起動中 `~/.obsidian-cli.sock`（`$HOME` 直下）を自分のものにし、`harness:quit` 時に削除する。**既定では、起動前に lstat だけで判定し、この socket が存在すれば launch を拒否する。** 判定は何も作らない前段と、profile 準備後の spawn 直前の2回行う。lstat が ENOENT 以外のエラー（EACCES、ENOTDIR、ELOOP など）なら判定不能として拒否する。`HOME` が空文字なら Node の `os.homedir()` が空を返し Obsidian が cwd 相対に socket を作るため、launch を拒否する（未設定なら passwd の home）。spawn から Obsidian 自身の unlink/listen までの1秒未満の窓で利用者の Obsidian が socket を作る競合は、外から防げない残存リスク。 奪ってよいのは `KIOKU_ALLOW_CLI_SOCKET_TAKEOVER=1` を明示した場合だけで、その場合: 実行中は利用者やエージェントの `obsidian` CLI コマンドが専用 test-vault インスタンスに届く（smoke 中は CLI を使わない。CLI による書き込みは baseline を無効にする）。quit で socket が削除され、利用者の CLI は利用者の Obsidian を再起動するまで使えない（GUI には影響しない想定）。launch 出力の `cliSocket.existedBeforeLaunch`/`takenOver` に記録する。**専用インスタンスの実行中に利用者が自分の Obsidian を起動すると、その Obsidian が socket を作り直し、`harness:quit` 時に専用インスタンスの will-quit の unlink がそれを削除する**（asar からの推定、未検証）。実行中は自分の Obsidian を起動しないか、起動した場合は quit 後に CLI のため再起動が必要になると考える。launch は page ready 後に socket を lstat し、存在すれば `{dev, ino}` を state に記録する。`harness:quit` は SIGTERM 直前と終了後に lstat だけで確認し（触らない）、直前の socket の `{dev, ino}` が記録と異なる（または記録が無いのに socket がある）場合だけ、他者（多くは利用者の Obsidian）が作り直したとみなして警告する。
  - **keychain**: 専用インスタンスは通常起動と同じく利用者の login keychain の "Obsidian Safe Storage" 項目を共有する（既存項目の読み取りを想定するが、読み取りだけであることは未検証）。
  - PID・profile・port・startedAt を `.tooling/obsidian-instance.json` に atomic write する。記録済みインスタンスが生存中、記録外でも専用 profile を使うプロセスがある、CDP port が使用中、のいずれかなら起動しない。
  - CDP で test-vault の native page がちょうど1つ（他 Vault の page なし）になり layout ready、title の版が copy した asar と一致するまで待つ。
  - **Restricted mode**: Obsidian は community plugin があり per-vault の選択が localStorage（`enable-plugin-<vaultId>`）に無いと trust dialog（`.mod-trust-folder`）を出す。dialog の有効化 button は `app.plugins.setEnable(true)` を呼んで設定画面を開くだけなので、launch は CDP で同じ `app.plugins.setEnable(true)` を呼び（設定画面は開かない）、dialog を Escape（cancel 経路、閉じるだけ）で閉じる。dialog が無く選択が `false` の場合も同じ呼び出しで解除する。trust dialog 以外の modal があれば click せず失敗する。最後に restricted mode off、loaded/configured plugin が厳密に `kioku`、open modal 0 を確認する。選択は**専用 profile の localStorage だけ**に保存され、利用者 profile には触れない。2回目以降の launch では Obsidian 自身が起動時に Kioku を読み込む（`restrictedMode: already-off`）。
  - 出力 JSON（pid、version、port など）は起動の成功であり UI PASS ではない。
- `npm run harness:quit`: 記録 PID だけを対象に、`ps -ww -o command= -p <pid>` の command line が専用 `--user-data-dir=<profile>` を厳密に含むことを確認してから SIGTERM し、終了を待って報告し state を消す。記録が無い/既に終了済みなら何もせず報告する。PID が別プロセスに再利用されていれば signal せず state だけ消す。SIGTERM 後の待ち時間は既定 60 秒（`KIOKU_QUIT_TIMEOUT_MS`、1000〜600000）。終了しなければ state を残し、記録 PID 以外には何も signal せず失敗する。自動で SIGKILL・名前指定はしない。システムダイアログでメインスレッドが止まっている可能性があるので画面を確認し、`harness:quit` を再実行する。それでも止まらない場合の SIGKILL は**オーケストレーターまたは利用者の承認を得た後だけ**、検証済みの記録 PID にだけ行う:

  ```sh
  ps -ww -o command= -p <state の pid>   # --user-data-dir=<プロジェクトの絶対パス>/.tooling/obsidian-profile を厳密に含むことを確認
  kill -KILL <その pid>                  # 確認できた場合だけ。その後 npm run harness:quit で state を片付ける
  ```

 記録 PID が消えているのに専用 profile を使う記録外プロセスがある場合（Obsidian 自身の `app.relaunch()` など）は、signal せずに PID と command line を列挙して失敗する。その場合の手動停止は次の手順だけを使う（Dock からの終了やアプリ名指定は利用者のインスタンスに当たり得るので禁止）:

  ```sh
  ps -A -ww -o pid=,command= | grep -F -- '--user-data-dir=<プロジェクトの絶対パス>/.tooling/obsidian-profile'
  kill <上で表示され、command line に専用 --user-data-dir を厳密に含む main プロセスの PID（grep 自身の行と --type= 付き helper は除く）>
  ```

- `harness:launch` は起動者 PID を書いた `.tooling/obsidian-launch.lock` で同時実行を拒否する。Ctrl-C などで残った lock は、記録 PID が終了していれば次回の launch が一意名へ rename してから内容を再確認して回収する（競合 launcher の新しい lock は戻す。戻す前に3つ目の launcher が新しい lock を作っていた場合は、2つ目の lock を `obsidian-launch.lock.stale-*` として残し、その名前を警告に出して再判定する。この3者競合では2つ目の launcher が自分は lock を持っていると思ったまま続行し得るが、後続の記録済みインスタンス・専用 profile プロセス・CDP port の検査で二重起動は通常拒否される。ただし両者がほぼ同時にそれらの検査を通過する完全な競合までは保証しない）。終了時は自分の PID の lock だけを消し、解放に失敗しても launch 結果は隠さず警告だけ出す（lock は stale 回収に任せる）。launch 開始時、owner PID が終了済みの `obsidian-launch.lock.stale-*` だけを削除する。

利用者向けの手動操作の案内: 専用インスタンスの実行中に普段の Obsidian を開くときは、利用者自身が `open -n -a Obsidian` を実行する（ただし上記のとおり、その Obsidian の CLI socket は専用インスタンスの quit で消え得るので、CLI を使うなら quit 後に再起動する。harness とエージェントは実行しない。Dock のクリックは専用インスタンスを前面に出すだけのことがある）。どちらの window かは title の Vault 名で見分ける。CDP port は loopback だけだが、実行中は同じマシンの任意のローカルプロセスが Node 権限で JS を実行できるため、テストしないときは `harness:quit` で止める。

test-vault を利用者の通常 Obsidian で開かない（利用者 profile は検査しないため、その場合の書き込みは harness が検出できない）。残存リスク: 同じ bundle ID のため Dock に2つ表示され、`obsidian://` URL がどちらに届くかは macOS 次第。bundle 単位の macOS 状態（`md.obsidian` の NSUserDefaults、Saved Application State、`~/Library/Logs` など）と `~/.obsidian-cli.sock` は利用者の Obsidian と共有される（上記）。CDP port は起動前に空きを確認するが、page と起動 PID の対応までは証明しない（test-vault を開く page であることは確認する）。trust dialog と Escape の挙動は Obsidian 1.14.3 の app code を読んだ結果で、実機証跡で確認するまでは未検証。`harness:quit` は main PID 終了後、同じ profile を持つ helper が消えるまで（signal せず）待つ。login keychain の "Obsidian Safe Storage"（SecretStorage が使う safeStorage）は利用者のインスタンスと共有される（読み取りだけの想定だが未検証）。launch が timeout したときは、keychain などのシステムダイアログでメインスレッドが止まっている可能性があるので画面を確認する。起動時に `setAsDefaultProtocolClient("obsidian")` が呼ばれるが、同じ bundle なので既定 handler は変わらない想定（未検証）。

## Mac 全体の重いジョブ順番待ち（LEV-305 pilot、opt-in）

`KIOKU_HEAVY_QUEUE=1` のときだけ有効。`1` 以外の値は拒否する。未設定（空や `0` も同じ）なら `npm run check` は `npm run check:steps`（LEV-305 前の check と同じ手順）を実行するだけで、キューのディレクトリにも触れない。

opt-out のときに同じであることを保証するのは、各手順の終了コードと生成物（`dist/`、build-info、package 検査、harness:prepare/update が書く test-vault の plugin ファイル、smoke 記録の項目）である。コンソールに出る文字列は対象外で、`npm run check` には npm が出す見出し（`> kioku@… check` と `> node scripts/check.mjs`）が 1 組増える。`package.json` は build の入力なので、build ID（とそれを含む `main.js`・build-info）は、`package.json` を変える他の変更と同じく変わる。同じ入力なら、変更前のコードとバイト単位で一致する（単体テストと `artifacts/lev-305/opt-out/` の比較記録）。

- 本体は `scripts/heavy-queue/`（`node:*` だけを使う tooling。プラグインの runtime には含めない）。ほかの project も `node <path>/scripts/heavy-queue/cli.mjs run --project <名前> --job check|native -- <command>`、`... status`（読むだけ）で使える。
- 置き場所: `ORCA_HEAVY_QUEUE_DIR`（正規化済み絶対 path）、既定は `~/Library/Caches/orca-heavy-queue/`（macOS 以外は `~/.cache/orca-heavy-queue/`）。mode 0700、本人 uid、group/other 書き込み不可でなければ拒否する。git 管理外で、使っていないときは消してよい。
- **スロットは 1 つ**（check と native で共有）。Mappy の制約「Obsidian 実機は 2 プロジェクト合計で同時に 1 台」は native を 1 スロットに入れれば満たせる。それに加えて、Mappy LEV-251 では高負荷が原因で順序の競合が起き、テストが落ちた。別プロジェクトの check が E2E と同時に走ると、実機の結果そのものが信用できなくなる。スロットが 1 つならロックの取得順の規則が要らず、入れ子は下の再入だけになる。代償として、ある worktree が native を持つ間（launch から quit まで）は、ほかの worktree の check が待つ。
- 包む範囲: `npm run check`（pre-commit、`harness:prepare`/`harness:update` の中の check を含む）は check の間だけ持つ。`harness:launch` は native を取ってから起動し、起動に成功したら所有者を**専用 Obsidian の PID** に引き渡す（launch の CLI が終わっても保持される）。`harness:quit` は先に quit を実行し（キューが壊れていても Obsidian は止める）、その PID が消えていれば解放する。quit が時間切れになり PID が生きていれば保持したまま。`harness:e2e:smoke` は、この worktree が生きた native を持つときだけ動き、所有者を記録 JSON の `heavyQueue` に残す（baseline は対象外）。
- 記録: `owner.json`（project、worktree、pid、コマンド行の SHA-256、実行ファイル名、ps の開始時刻、job、seq、enqueuedAt、startedAt、waitedMs、引き渡し後は launcher）、`tickets/<seq>-<uuid>.json`（待ち行列）、`history.jsonl`（acquired、released、handed-off、recovered-*、overdue、待ち時間と保持時間）。作成は一時ファイルの hard link（排他）か rename で行い、書きかけの記録は見えない。
- 資格情報: コマンド行には API キーなどの資格情報が含まれることがある。そのため、コマンド行そのもの（引数）は記録・status 出力・エラー・ログのどこにも出さない。プロセスの識別は、PID、ps の開始時刻、コマンド行全体の SHA-256、argv[0] の basename（安全な文字だけ。それ以外は `unknown`）で行う。`--api-key=FAKE-SECRET-…` を引数に持つ実プロセスで、キューのファイル、status、拒否メッセージ、待ちの表示のどこにも出ないことをテストで固定している。
- FIFO: seq は短い enqueue ロック（排他作成、保持者の pid と識別情報を記録）の中で割り当てる。`seq.json` が最大値を覚えているので、seq は enqueue の順に厳密に増え、再利用されない。待つ側は、所有者・自分の順番・待ち時間を表示する（所有者が替わったとき、またはその後 60 秒ごと）。
- 回収の条件: 所有者（待ち行列の ticket、enqueue ロックも同じ）を消してよいのは、`ps -p <pid>` の結果、その PID が無いとき、またはコマンド行の digest か開始時刻が記録と違う（PID の使い回し）ときだけ。所有者の回収は先頭の待ち手だけが行う。消す前に一意な名前へ rename し、中身が判定したものと同じことを確かめる。違えば元に戻す。どのプロセスにも signal を送らない（`kill`/`pkill`/`pgrep`、一覧の pattern 検索は使わない。待ち手自身に一致して待ちが終わらなかった Mappy の事故を防ぐ）。30 分を超えた所有者は報告するだけ（`REPORT:` と `overdue`）。時計が戻ったら、保持時間は unknown と表示し、時間を理由にした判定はしない。
- 再入: `run` は子に `ORCA_HEAVY_QUEUE_TOKEN` を渡し、同じ token を持つ要求（commit → pre-commit → check など）は待たずに実行する。native を持つ worktree からの check は入れ子として実行する（自分の実機セッション中の commit で deadlock しない）。同じ worktree からのそれ以外の 2 つ目の要求（check の二重実行、待ち中の二重 enqueue、native の二重取得）は、待たずに理由を示して拒否する。
- 拒否（何も実行しない）: 記録や `seq.json` が読めない・形が違う、tickets に想定外のファイルがある、ディレクトリが symlink・ファイル・他人の所有・共有書き込み可・書き込み不可、ps が判定できない。自動で消して直すことはしない。
- 既知の限界: Obsidian 自身が再起動して PID が変わる（`app.relaunch()`）と、記録の PID が消えたとみなして native が回収される。その後に `harness:quit` を実行すると、記録外の profile プロセスが一覧で表示される（従来どおり）。
- Rollback: 環境変数を外す。ディレクトリは消すだけでよい。

## Obsidian desktop smoke

**enable/startup より前**にノートの baseline を採る。起動後に snapshot を採り直すと onload による書き込みを見逃すため禁止する。

1. 専用インスタンスが動いていれば `npm run harness:quit`。必要なら `harness:update` を行う。利用者の Obsidian は閉じない。
2. `npm run harness:e2e:smoke -- baseline`。記録済み専用インスタンスの生存（PID + command line）、専用 profile を使うプロセス、CDP port（`KIOKU_CDP_URL` の port、`KIOKU_CDP_PORT`、記録 port）の応答を自動検査し、どれかがあれば拒否する。利用者の Obsidian の起動有無は検査も要求もしない（旧 `KIOKU_CONFIRM_VAULT_CLOSED` は廃止）。`artifacts/e2e-smoke/baselines/<ID>.json` に専用 Vault の内容ファイル一覧と SHA-256、学習データのフォルダ（プラグインの `data.json` の `dataFolder`、既定 `Kioku`）の有無を排他的に保存し、ID を表示する。この段階の status は `CAPTURED` であり、UI の PASS ではない。
3. `npm run harness:launch`（初回は上記の restricted mode 解除 = Kioku の初回有効化を含む）。
4. `KIOKU_BASELINE_ID=<ID> npm run harness:e2e:smoke`。baseline が無い・identity が異なる・CDP port が記録 port と異なる場合は FAIL。開始時に Kioku 以外の `.modal-container`（trust dialog など）が開いていれば UI 操作前に FAIL する。Kioku 自身の modal（container 内の modal 要素 `.modal` に `kioku-startup-modal`・`kioku-deck-picker-modal`・`kioku-candidate-modal` のどれかがあるもの。復習画面はデッキ選択 modal の中に描画される）は foreign とみなさない。デッキ選択を開いている間と PASS 直前にも同じ判定をする。startup 後かつ UI 操作前、各 open/close 後、Escape 後のファイル一覧/hash が **起動前 baseline** と同じことを必須判定し、追加・削除・rename・bytes 変更のいずれも FAIL にする。同じ各時点で、学習データのフォルダが**空でも作られていない**ことを判定する（ファイルの snapshot だけでは空フォルダを検出できないため）。baseline 時点で既にフォルダがあった Vault（評価済み）では、フォルダが残っていることを判定し、中のファイルは内容 baseline で比較する。
5. restart pair: `npm run harness:quit && npm run harness:launch` の後、**同じ** `KIOKU_BASELINE_ID` で 4 を再実行する。restart 前に baseline を採り直さない。

script は loopback CDP 以外を拒否し、専用 Vault の native page が1つ、ribbon が1つであることを検査する。M2 から ribbon はデッキ選択を開くので、ribbon → デッキ選択（root `.kioku-deck-picker-modal` の version/build ID data attribute が current preflight と一致、読み込み完了、「全デッキ」表示、中央）→ 閉じるを2回、ribbon → デッキ選択 → Escape を1回行う。状態 modal はコマンド `kioku:open-startup` から開き、`.kioku-build-identity` の version/build ID と未実装の明示（AI）と中央表示を検査して閉じる。page error を確認し、`artifacts/e2e-smoke/` に JSON と screenshot（デッキ選択2枚、状態 modal 1枚）を残す。実際の plugin/modal が無ければ FAIL する。

baseline の対象は Markdown・Excalidraw・添付を含む全内容ファイル。Obsidian が変更する `.obsidian/` と harness marker `.kioku-generated` だけを除外する。baseline 自体を再保存・上書きしない。テスト中の手動ノート編集は禁止。停止の証明は専用インスタンス（記録 PID、専用 profile を持つプロセス、CDP port）に限られ、test-vault を通常の Obsidian で開かない運用が前提。書き込み後に元 bytes へ戻すような一時的 I/O は snapshot だけでは検出できないため、unit mock は Vault/adapter/Editor 経路の read/write を拒否・監視し、レビューの startup-write mutant が落ちることも固定する。

`tests/e2e/note-preservation.test.mjs` は script を CDP **プロトコル模擬**で検査する非UI回帰ケース。模擬 run の PASS/画像は実機証跡ではない。通常の実機 smoke は native Obsidian だけで実行する。

smoke script 自身はアプリを終了/起動しない。restart は `harness:quit` → `harness:launch` で行い、**同じ KIOKU_BASELINE_ID** でもう一度 smoke を実行して 2 run の証跡を関連付ける。restart 前に baseline を採り直さない。単独 run の record は restart を `NOT TESTED` と明記する。実機を起動していない開発ワーカーは PASS を報告してはならない。

## M1 実機確認（LEV-275、testing agent が実施）

`npm run check` と mock テストは書き込み経路の契約を固定するだけで、実機成功ではない。M1 の UI/保存経路は専用 Vault の Obsidian desktop で次を確認し、操作前後のノート bytes（または diff）と screenshot を `artifacts/` に残す。本番 Vault は使わない。

実機は **LEV-279 の専用インスタンスだけ**で行う（上記「専用 Obsidian インスタンス」）。利用者の Obsidian は閉じない・アプリ名で終了しない。

- 起動・終了は `npm run harness:launch` / `npm run harness:quit` だけ。`~/.obsidian-cli.sock` が既にある（利用者の Obsidian が起動中など）と launch は既定で拒否する。`KIOKU_ALLOW_CLI_SOCKET_TAKEOVER=1` は利用者の明示同意がある場合だけ付ける。実行中は `obsidian` CLI が test-vault に届くので、確認中に CLI を使わない。
- 項目1（既存 smoke）は採用などの書き込みより**前に**行う: `harness:quit`（動いていれば）→ `npm run harness:e2e:smoke -- baseline` → `harness:launch` → `KIOKU_BASELINE_ID=<ID> npm run harness:e2e:smoke`。項目2以降の採用は test-vault を正当に書き換えるため、その後に smoke を取り直す場合は `harness:quit` → 新しい baseline → `harness:launch` の順にする（起動中に baseline を採らない）。
- 再起動が要る確認（restart pair、プラグイン再読込後の採用済み表示など）は `harness:quit` → `harness:launch` で行う。Canvas・popover・2ペインなどの操作は専用インスタンスの window（title の Vault 名が test-vault）で行う。

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

準備：`#kioku`・`#Kioku/医学`・`#kioku/医学/生理`・frontmatter `tags: [kioku/英語]`・コードブロック内だけに `#kioku` があるノート・2つのデッキタグを持つノート・同じ `^kioku-…` を同内容/異内容で持つ2組のノート・`![[…]]` を問いに含むカード・トリガータグの無いノートに、採用済みカード（M1 で採用、または `^kioku-<10文字>` を手で付与）を用意する。新規上限の確認用に新規カードを 21 枚以上用意する。用意は専用インスタンスを `npm run harness:quit` で止めて行い、そのあと smoke の baseline を採る。

実機は M1 と同じく **LEV-279 の専用インスタンスだけ**で行う（起動・終了は `harness:launch` / `harness:quit` だけ、利用者の Obsidian は閉じない・アプリ名で終了しない、`KIOKU_ALLOW_CLI_SOCKET_TAKEOVER=1` は利用者の明示同意がある場合だけ、確認中に `obsidian` CLI を使わない）。項目1・2（smoke）は評価などの書き込みより**前に**、`harness:quit`（動いていれば）→ `npm run harness:e2e:smoke -- baseline` → `harness:launch` → `KIOKU_BASELINE_ID=<ID> npm run harness:e2e:smoke` で行う。評価後に smoke を取り直す場合は `harness:quit` → 新しい baseline → `harness:launch` の順にする（`Kioku/` がある Vault では smoke はフォルダが残ることを判定する）。`state.json`・履歴を Obsidian の外で編集する確認（項目12）は、専用インスタンスを `harness:quit` で止めてから行い、`harness:launch` で開き直す。

1. 起動直後にノートも `Kioku/` も読み書きされない（smoke の startup 判定、`Kioku/` 未作成）。
2. ribbon → デッキ選択の開閉・Escape で Vault の内容ファイルが変わらず、`Kioku/`（空フォルダを含む）が作られない。デッキ選択 root の identity が preflight と一致（smoke）。
3. トリガータグどおりのデッキと Due/New/Total：既定 `#kioku`、大文字小文字の違い（`#Kioku/医学` は `医学` に合流）、入れ子（子デッキ、親は子を含む）、frontmatter のタグ、コードブロック内のタグは数えない。デッキ外カード件数の注記。ID 重複は同内容なら1枚、異内容なら出題から除外され両パスが注記に出る。トリガータグを2つにすると根（`kioku › …`）が表示される。
4. 2つのデッキに属するカードが、親デッキ・全デッキ・各デッキのどのセッションでも1回だけ出る。デッキ A で評価したあと、デッキ B で Due でも New でもない（デッキ選択の件数で確認）。
5. 評価で `Kioku/history-YYYY.jsonl` に1行増え、`Kioku/state.json` が更新され、`state.json` が既にあった場合はセッション最初の保存で `state.json.bak` が作られる。ノートの bytes は変わらない。
6. Skip（`S`、答えの表示前後）で `Kioku/` とノートの bytes が変わらず、同じセッションでは再出題されず、デッキ選択を開き直すと New/Due に残っている。
7. 途中で閉じる・Escape：評価済みの分だけ履歴にあり、表示中の未評価カードは変化しない。
8. `harness:quit` → `harness:launch` の再起動で、期日と Due/New/Total が終了前と一致する。`harness:update` 後も `Kioku/` が残る（update は4配布物以外を変えない）。
9. 新規上限：既定 20 枚。デッキ選択に「今日の新規 残り X 枚」、21 枚目以降は「新規の残りは明日以降」。完了画面の「今日だけ あと10枚」で 10 枚追加され、`state.json` の `today.extraNew` が 10 になる。まだ一度も評価していない Vault（`Kioku/` 無し）で押した場合は `Kioku/` が作られず、その後の最初の評価で `extraNew` が保存される。
10. 今日評価したカードが今日の Due に再び出ない（「もう一度」でも次回は翌日以降。日付境界と夏時間は単体テストで固定）。
11. カードのブロックを別ノートへ移動・ノートを改名しても日程が保持される。ブロック削除 → Undo で同じ ID が戻り日程も戻る。原文の編集・`%%kioku-edit%%` の追加後も日程が保持され、次の評価のイベントの `contentHash` が変わる。
12. `state.json` を壊す（JSON として不正にする）と読み取り専用になり、理由が表示され、評価ボタンが無効で `state.json` が上書きされない。`state.json` を消すと履歴から再構築され、最初の評価で書き直される。`state.json` を古い版（評価前の `.bak` など）に戻すと、反映済み位置より後ろの履歴が再生されて追いつく（同じ `eventId` の行を手で複製しても二重に数えない）。
    - 12a. 履歴の最終行を途中で切る（改行も消す）。結果は、その行が `state.json` に**まだ反映されていないか、もう反映されているか**で分かれる（設計どおり）。
        - 12a-1（未反映。追記中のクラッシュの実際の形）：`state.json` の `applied` がその行より前を指している状態で最終行を切る（例：`state.json` を評価前の `.bak` の内容に戻す、または `state.json` と `.bak`（と `.tmp`）を消してから最終行を切る。`state.json` だけを消すと、切った行を含む `.bak` が残っている場合に欠落判定の基準になり 12a-2 になる）。デッキ選択に「記録ファイル …history-YYYY.jsonl の最終行（N 行目）が途中で切れています。読み取り専用にしています。」と確認ボタン「不完全な最終行を退避して続ける」が出る。押したときだけ、その1行が `history-YYYY.jsonl.broken` に追記され（先）、続いて履歴からその行だけが取り除かれ（後）、読み直されて評価できるようになる。押さなければ何も書かれない。
        - 12a-2（反映済み。外部での破損）：`state.json` の `applied` が既にその行を指している状態で最終行を切る（評価直後にそのまま切る）。履歴が「反映済みより短い」と判定され、「記録ファイル … が見つからないか、日程ファイルが反映済みとしている行より短くなっています。…読み取り専用にしています。」が出て、確認ボタンは出ない。何も書かれない。復旧は README「記録が読めないときの復旧」の手順（実機確認では「Obsidian を閉じ」を専用インスタンスの `harness:quit` に読み替える。`Kioku/` をコピーしてから、切れた行を `history-YYYY.jsonl.broken` に移すか消し、`state.json`・`state.json.bak`・`state.json.tmp` を消して開き直すと履歴から作り直される。または `.bak` / 記録ファイルをバックアップから戻す）。
        - 途中の行を壊すと、ファイル名と行番号が表示され読み取り専用のまま（ボタンは出ない）。最終行の改行だけを消した場合（行自体は正しい）は、次の評価の前に改行が補われ、行が連結されない。
        - 書き込み経路の観察（Obsidian 1.14.3 実機）：既存の `state.json` への `rename` による上書きは「Destination file already exists!」で失敗するため、保存は毎回「`state.json.tmp` に書いて確認 → `state.json` を削除 → `rename`」の経路を通る。保存後に `state.json.tmp` は残らず、`state.json.bak` はある。
    - 12b. 設定の「学習データのフォルダ」を、データの無いフォルダ名に変えて「変更」を押すと適用されず「古いフォルダ（Kioku）にデータがあります。移動してから変更してください。」が表示され、`data.json` の `dataFolder` が変わらない。Obsidian の外で `Kioku/` を移動してから同じ名前に変えると適用される。
13. キーボード：`Space`/`Enter` で答えを表示、`1`–`4` で評価、`S` でスキップ、`Escape` で閉じる。答え表示後に「普通」にフォーカスがある状態で `Space` を押しても1回だけ評価される。キーの長押し（repeat）、保存中の連打、ボタンのクリックとキーの同時操作で二重評価されない（いずれも履歴の行数で確認）。日本語 IME の変換確定の `Enter` で答えの表示や評価が起きない。
14. 答えを表示する前は、問いの `![[…]]`・`![…](…)`・`<img>` の埋め込み内容や dataview などのコードブロックが描画されず（リンク・文字・素のコード表示）、答えの表示後に描画される。閉じた後に描画由来のエラーが console に出ない。
15. 性能：5,000 ノート / 10,000 カード程度の生成 fixture（専用 Vault 内）で、ribbon からデッキ一覧が表示されるまでの時間を記録する（目安 500 ms 以内、開発機。超えたら `docs/m2-design.md` §3.3 のキャッシュを検討）。
16. 未検証事項の記録：`Kioku/` の `.json`/`.jsonl` がファイル一覧・検索・グラフにどう出るか（「すべての拡張子を検出」設定の有無）、箇条書き項目の `^kioku-…` が `CachedMetadata.blocks` に入るか、`%%` 内の `#tag` を metadataCache が数えるか、を観察して記録する。

