# Kioku の開発

Node.js は `.nvmrc` の **22.22.3** を使う。tooling の direct dependency は exact stable version で lock する。runtime dependency は M2 から ts-fsrs 5.4.2 の1つだけ（exact pin、`main.js` に bundle、MIT 表示を `main.js` 先頭に保持）。版を上げるときは `scripts/lib/build.mjs` の `runtimeDependencies`、`src/review/scheduler.ts` の `SCHEDULER_ID`、FSRS の単体テスト（間隔）を同時に見直し、記録に残す。

```sh
nvm use
npm ci
npm run check
```

主なコマンド:

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run package
npm run harness:prepare    # 初回、新規専用 Vault のみ
npm run harness:update     # 専用インスタンスを harness:quit で止め、4配布物だけ更新
npm run harness:preflight
npm run harness:e2e:smoke -- baseline # 実機担当、専用インスタンス停止中（自動検査）。出力された ID を保持
npm run harness:launch     # 専用 profile で test-vault だけを並行起動（利用者の Obsidian は開いたまま、macOS のみ）
KIOKU_BASELINE_ID="表示されたUUID" npm run harness:e2e:smoke # 実機担当、専用インスタンス + loopback CDP
npm run harness:quit       # 記録 PID だけを検証して SIGTERM。restart pair は quit → launch → 同じ ID で smoke
open -n -a Obsidian        # 利用者が手動で実行するだけ（harness/エージェントは実行しない）。専用インスタンス実行中に普段の Obsidian を開く
npm run hooks:install      # Git 作成後の任意 hook。check を skip しない
node scripts/heavy-queue/cli.mjs status # 順番待ちの所有者と待ち行列を見るだけ（何も回収しない）
```

生成物は `dist/kioku/`、試用 Vault は `test-vault/`、実行証跡は `artifacts/`、専用 Obsidian の profile/state/log/lock は `.tooling/`。すべて git 管理外。環境変数: `KIOKU_CDP_PORT`（既定 9222）、`KIOKU_OBSIDIAN_BINARY`（正規化済み絶対 path の既存実行ファイル、既定 `/Applications/Obsidian.app/Contents/MacOS/Obsidian`）、`KIOKU_CDP_URL`（smoke 用 loopback URL、port 明示必須、既定は `http://127.0.0.1:<KIOKU_CDP_PORT>`）、`KIOKU_QUIT_TIMEOUT_MS`（harness:quit の SIGTERM 後の待ち、既定 60000）、`KIOKU_HEAVY_QUEUE=1`（Mac 全体の重いジョブ順番待ちを使う opt-in。check と専用インスタンスを 1 スロットで順番に実行する。docs/harness.md 参照。キューの置き場所は `ORCA_HEAVY_QUEUE_DIR`、既定は `~/Library/Caches/orca-heavy-queue/`）、`KIOKU_ALLOW_CLI_SOCKET_TAKEOVER=1`（既存の `~/.obsidian-cli.sock` を専用インスタンスが奪うことへの明示同意。利用者の同意なしに設定しない）。`npm run check` は実機を起動せず、実機成功を主張しない。プライマリーは `main` に置き、チケットごとに独立した Git worktree で作業する。プロジェクト内の `.claude/worktrees/` に作られた worktree は Git 管理外で、primary checkout の lint/test 対象から除外する（build input と validate は `src/` と固定ファイル一覧だけを読むため影響しない）。main への直接 push は行わず、変更は PR でレビューする。

dependency 更新では Node/Obsidian の互換、公式 lint peer、lock、audit を確認する。Obsidian API 型は `manifest.minAppVersion` と同じ。Node security advisory が tooling の local-only test server/型 package にだけある場合も、残る理由と到達可能性をレビューへ記録する。
